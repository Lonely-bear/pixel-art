/**
 * Finding the desktop app's MCP endpoint.
 *
 * The app hosts a full MCP server on loopback, but it cannot promise a fixed
 * port: `mcp-host.ts` retries `port + attempt` so a second instance (or anything
 * else already on 7331) pushes it to 7332, 7333 and so on. An endpoint baked
 * into an MCP client's config is therefore wrong the moment the app moves, and
 * the failure is quiet - the agent draws into a store nobody is watching.
 *
 * So the app publishes where it actually ended up, and the tool goes looking.
 * Two independent mechanisms, because either one alone has a failure mode:
 *
 *  1. A `host.json` record in a stable, app-name-independent location. Exact,
 *     and it carries the pid and version. It can go stale if the app is killed
 *     without running its exit handler.
 *  2. A TCP sweep of the app's port range. Survives a deleted or stale file,
 *     and needs no shared path convention at all - but an open port only proves
 *     *something* is listening.
 *
 * A candidate from either mechanism is only trusted once a real MCP
 * `initialize` has completed against it, which is what `probeAttach` does. That
 * handshake - not the open port - is the answer to "is the app running?".
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Socket } from 'node:net';
import { probeAttach } from './attach.js';

/** First port the app tries. Keep in step with the app's DEFAULT_MCP_PORT. */
export const DEFAULT_HOST_PORT = 7331;
/** How many ports the app walks through before giving up. */
export const DEFAULT_HOST_PORT_SPAN = 10;

export interface HostRecord {
  url: string;
  port: number;
  pid?: number;
  version?: string;
  startedAt?: number;
}

export interface DiscoveredHost extends HostRecord {
  /** Which mechanism found it. Purely diagnostic, but useful in `--json-status`. */
  source: 'host-file' | 'port-scan';
}

/**
 * Where the app publishes its endpoint.
 *
 * Deliberately not `app.getPath('userData')`: that embeds the app's name (it is
 * `%APPDATA%\@pixel\app` on Windows), so renaming the app would silently break
 * discovery for every installed copy of the tool. Both sides derive this path
 * from the platform instead, which is the only thing they can agree on.
 */
export function hostFilePath(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'dotloom-mcp', 'host.json');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'dotloom-mcp', 'host.json');
  }
  const base =
    process.env.XDG_RUNTIME_DIR ?? process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'dotloom-mcp', 'host.json');
}

/** Called by the app once its HTTP host is listening. */
export async function writeHostFile(record: HostRecord): Promise<string> {
  const file = hostFilePath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return file;
}

/** Called by the app on the way out, so a dead app leaves no record behind. */
export async function removeHostFile(): Promise<void> {
  await rm(hostFilePath(), { force: true });
}

async function readHostFile(): Promise<HostRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(hostFilePath(), 'utf8'));
    if (parsed && typeof parsed === 'object' && typeof (parsed as HostRecord).url === 'string') {
      return parsed as HostRecord;
    }
  } catch {
    // Missing, unreadable or malformed: fall through to the port sweep.
  }
  return null;
}

/**
 * Is anything listening on this loopback port?
 *
 * Only ever a pre-filter. A port can be open and still belong to something
 * else, and on a shared machine another process can hold 7331 after the app
 * exits - which is exactly the case that used to produce a silent no-op.
 */
function probePort(port: number, host = '127.0.0.1', timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

export function endpointUrl(port: number, host = '127.0.0.1'): string {
  return `http://${host}:${port}/mcp`;
}

/** Which of the app's candidate ports currently have a listener. */
export async function scanHostPorts(
  from = DEFAULT_HOST_PORT,
  span = DEFAULT_HOST_PORT_SPAN,
): Promise<number[]> {
  const open: number[] = [];
  for (let port = from; port < from + span; port += 1) {
    if (await probePort(port)) open.push(port);
  }
  return open;
}

export interface DiscoverOptions {
  /** Set false to trust only `host.json` and skip the port sweep. */
  scan?: boolean;
  log?: (line: string) => void;
}

/**
 * Locate a running app, or return null.
 *
 * Both mechanisms are tried in order and every candidate must complete a real
 * MCP handshake before it is accepted, so a stale record or an unrelated
 * service on the same port is rejected rather than silently adopted.
 */
export async function discoverHost(options: DiscoverOptions = {}): Promise<DiscoveredHost | null> {
  const log = options.log ?? (() => {});

  const record = await readHostFile();
  if (record) {
    if (await probeAttach(record.url)) return { ...record, source: 'host-file' };
    log(`ignoring stale host record ${record.url} (${hostFilePath()})`);
  }

  if (options.scan === false) return null;

  for (const port of await scanHostPorts()) {
    const url = endpointUrl(port);
    if (await probeAttach(url)) return { url, port, source: 'port-scan' };
    log(`port ${port} is open but did not answer as an MCP endpoint`);
  }
  return null;
}

/**
 * Poll for the app for a short while.
 *
 * The common failure is a race, not an absent app: the client launches the MCP
 * tool and the user opens the editor a second later. Retrying for a moment
 * catches that without making every startup wait.
 */
export async function waitForHost(
  timeoutMs: number,
  options: DiscoverOptions = {},
): Promise<DiscoveredHost | null> {
  const seen = new Set<string>();
  // The retry loop re-probes the same record and ports several times, so without
  // this a stale `host.json` emits an identical warning on every pass.
  const log = (line: string) => {
    if (seen.has(line)) return;
    seen.add(line);
    (options.log ?? (() => {}))(line);
  };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const host = await discoverHost({ ...options, log });
    if (host) return host;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
