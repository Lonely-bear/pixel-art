/**
 * The stdio server that prefers a running desktop app, and keeps looking.
 *
 * The old design made discovery a one-shot decision: `cli.ts` looked for an app for
 * 1.5s at startup and, if none answered, committed to a self-contained stdio server
 * for the rest of its life. That is the wrong shape for the common session. OpenCode
 * (and every other client) starts the MCP process when the client starts, the user
 * opens the editor a moment later, and from then on the agent is drawing into a store
 * nobody is watching - forever, because nothing probes again. A client that owns a
 * long-lived background service makes it worse: the headless connection is reused
 * across restarts.
 *
 * So the decision is deferred instead of made. This module always stands up the
 * in-memory editor, then runs a small relay in front of it:
 *
 *  - **Attached** - every request, notification and result is forwarded to the app's
 *    HTTP MCP endpoint, so the agent edits the same store the window shows.
 *  - **Detached** - the same requests are answered by the in-memory editor, so
 *    headless and CI use keep working.
 *  - **Re-discovery** - while detached the relay re-runs discovery on a timer, so an
 *    app opened *after* the session started is picked up automatically. When the app
 *    goes away again the relay detaches and resumes looking.
 *
 * The relay advertises the in-memory server's capabilities and serves the same tool
 * catalogue, because the embedded app runs the identical `createPixelServer`. That is
 * what makes switching upstream invisible: the tools do not change, only the store
 * behind them does. `get_connection_status` is added on top so the agent can tell the
 * user which store is live without guessing.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Implementation, ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { discoverHost, waitForHost, type DiscoveredHost } from './discovery.js';
import {
  attachedNote,
  createPixelServer,
  offlineNote,
  SERVER_INSTRUCTIONS,
  standaloneNote,
  type PixelServer,
} from './server.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

const LINK_INFO: Implementation = { name: `${SERVER_NAME}-link`, version: SERVER_VERSION };

/**
 * Long exports (spritesheets, GIFs) can outlive the SDK's 60s default request timeout,
 * so relayed requests get the same generous ceiling the `--attach` bridge uses.
 */
const RELAY_TIMEOUT_MS = 10 * 60 * 1000;

/** How often to look for an app that was not there at startup. */
const DEFAULT_POLL_MS = 2000;
/** How long a fresh session waits for a just-starting app before falling back. */
const DEFAULT_HOST_WAIT_MS = 1500;

/** The one tool the relay answers itself; see {@link connectionStatusResult}. */
export const CONNECTION_STATUS_TOOL = 'get_connection_status';

/**
 * Advertised by hand rather than registered, because it must survive the upstream
 * switch: it exists in neither the app's catalogue nor the bare in-memory one.
 */
const CONNECTION_STATUS_DESCRIPTOR = {
  name: CONNECTION_STATUS_TOOL,
  description:
    'Report whether this session is attached to a running desktop app (live preview) or running in memory, and how to change that.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export interface HostLinkOptions {
  /** How long the initial handshake waits for a starting app. */
  hostWaitMs?: number;
  /** How often to re-check while detached. */
  pollMs?: number;
  /** Never look for an app; run the in-memory editor only. */
  standalone?: boolean;
  log?: (line: string) => void;
  /** Override discovery (tests inject a fixed host here). */
  findHost?: () => Promise<DiscoveredHost | null>;
  /** Override how a discovered host becomes a live client (tests inject a pair). */
  connectApp?: (host: DiscoveredHost) => Promise<Client>;
}

export interface HostLink {
  /** The stdio-facing relay. The caller connects the transport. */
  server: Server;
  /** The in-memory fallback editor, exposed for diagnostics and tests. */
  local: PixelServer;
  /** `app` while bridged, `memory` while detached. */
  mode(): 'app' | 'memory';
  /** The endpoint currently bridged to, or null. */
  url(): string | null;
  /** Begin watching for an app when the initial handshake did not find one. */
  start(): Promise<void>;
  close(): Promise<void>;
}

/** Connect to a discovered host over Streamable HTTP. */
async function defaultConnectApp(host: DiscoveredHost): Promise<Client> {
  const client = new Client(LINK_INFO, { capabilities: {} });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(host.url)));
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
  return client;
}

function instructionsFor(host: DiscoveredHost | null): string {
  return `${SERVER_INSTRUCTIONS}\n\n${host ? attachedNote(host.url) : offlineNote()}`;
}

/**
 * Stand up the in-memory editor and the relay in front of it.
 *
 * The initial discovery runs here rather than in `start()` because the instructions
 * handed to the client during `initialize` have to say which mode the session is in -
 * that is the agent's one chance to ask the user about the app before it starts work.
 * The remote client is attached before returning as well, so the very first `tools/list`
 * comes from the app.
 */
export async function createHostLink(options: HostLinkOptions = {}): Promise<HostLink> {
  const log = options.log ?? (() => {});
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  const local = createPixelServer();
  const [localClientTransport, localServerTransport] = InMemoryTransport.createLinkedPair();
  const localClient = new Client(LINK_INFO, { capabilities: {} });
  await Promise.all([
    localClient.connect(localClientTransport),
    local.server.connect(localServerTransport),
  ]);

  const initialHost = options.standalone
    ? null
    : await (options.findHost ?? (() => waitForHost(options.hostWaitMs ?? DEFAULT_HOST_WAIT_MS, { log })))();

  // Mirror the in-memory server's capabilities, so capability-gated client calls pass
  // no matter which side ends up answering. The app advertises the same set.
  const capabilities: ServerCapabilities = localClient.getServerCapabilities() ?? {
    tools: { listChanged: true },
    resources: { listChanged: true },
    prompts: { listChanged: true },
  };

  const server = new Server(LINK_INFO, {
    capabilities,
    instructions: options.standalone ? standaloneNote() : instructionsFor(initialHost),
  });

  let app: { host: DiscoveredHost; client: Client } | null = null;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let closed = false;

  /** Send a server notification to the client, if a transport is attached yet. */
  async function notifyClient(notification: { method: string; params?: unknown }): Promise<void> {
    if (!server.transport) return;
    await server.notification(notification as never).catch(() => undefined);
  }

  /** The upstream tool list may have changed with the upstream; let the client re-read it. */
  async function refreshCatalog(): Promise<void> {
    if (!server.transport) return;
    await server.sendToolListChanged().catch(() => undefined);
  }

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  }

  function startPolling(): void {
    if (closed || options.standalone || pollTimer || app) return;
    pollTimer = setInterval(() => void pollOnce(), pollMs);
    pollTimer.unref();
  }

  async function pollOnce(): Promise<void> {
    if (closed || app || polling) return;
    polling = true;
    try {
      const host = await (options.findHost ?? (() => discoverHost({ log })))();
      if (host && !closed && !app) {
        await attach(host).catch((error: unknown) => {
          log(`found ${host.url} but could not attach: ${(error as Error).message}`);
        });
      }
    } finally {
      polling = false;
    }
  }

  async function attach(host: DiscoveredHost): Promise<void> {
    const connectApp = options.connectApp ?? defaultConnectApp;
    const client = await connectApp(host);
    client.onerror = () => {};
    client.onclose = () => {
      if (app?.client === client) void detach('the app closed the connection');
    };
    client.fallbackNotificationHandler = (notification) => notifyClient(notification as never);
    app = { host, client };
    stopPolling();
    log(
      `${SERVER_NAME} ${SERVER_VERSION} attached to the running app at ${host.url} ` +
        `(found via ${host.source}). Edits render live.`,
    );
    await notifyClient({
      method: 'notifications/message',
      params: { level: 'info', data: `Desktop app connected at ${host.url}. Edits render live.` },
    });
    await refreshCatalog();
  }

  async function detach(reason: string): Promise<void> {
    const current = app;
    if (!current) return;
    app = null;
    await current.client.close().catch(() => undefined);
    log(`${SERVER_NAME} detached from the app (${reason}); running in memory until it returns.`);
    await notifyClient({
      method: 'notifications/message',
      params: { level: 'warning', data: `Lost the desktop app (${reason}); running in memory.` },
    });
    await refreshCatalog();
    startPolling();
  }

  /** Forward one request to the active upstream, detaching if the app stops answering. */
  async function forwardRequest(request: { method: string; params?: unknown }): Promise<unknown> {
    const target = app;
    if (target) {
      try {
        return await target.client.request(
          { method: request.method, params: request.params } as Parameters<Client['request']>[0],
          z.any(),
          { timeout: RELAY_TIMEOUT_MS },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await detach(`request ${request.method} failed: ${message}`);
        throw error;
      }
    }
    return localClient.request(
      { method: request.method, params: request.params } as Parameters<Client['request']>[0],
      z.any(),
      { timeout: RELAY_TIMEOUT_MS },
    );
  }

  /** The relay's own tool: answered locally so it works in either mode. */
  function connectionStatusResult(): { content: Array<{ type: 'text'; text: string }> } {
    const attached = app !== null;
    const status = {
      ok: true,
      attached,
      mode: attached ? 'app' : 'memory',
      livePreview: attached,
      url: app?.host.url ?? null,
      port: app?.host.port ?? null,
      source: app?.host.source ?? null,
      note: attached
        ? 'Edits render live in the desktop app; the GUI and this agent share one document store and undo history.'
        : 'No desktop app is connected. Edits live only in memory until save_document/finalize_document. Ask the user to open the app for live preview; this session reconnects automatically when it appears.',
    };
    return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
  }

  /** Add the connection tool to whatever catalogue the upstream returned. */
  function withConnectionStatus(result: unknown): unknown {
    if (!result || typeof result !== 'object') return result;
    const value = result as { tools?: unknown };
    const tools = Array.isArray(value.tools) ? value.tools : [];
    if (tools.some((tool) => (tool as { name?: string })?.name === CONNECTION_STATUS_TOOL)) {
      return result;
    }
    return { ...value, tools: [...tools, CONNECTION_STATUS_DESCRIPTOR] };
  }

  async function relay(request: { method: string; params?: unknown }): Promise<unknown> {
    const params = request.params as { name?: string } | undefined;
    if (request.method === 'tools/call' && params?.name === CONNECTION_STATUS_TOOL) {
      return connectionStatusResult();
    }
    const result = await forwardRequest(request);
    return request.method === 'tools/list' ? withConnectionStatus(result) : result;
  }

  server.fallbackRequestHandler = (async (request: { method: string; params?: unknown }) =>
    relay(request)) as unknown as typeof server.fallbackRequestHandler;

  server.fallbackNotificationHandler = async (notification) => {
    const target = app;
    if (target) await target.client.notification(notification as never).catch(() => undefined);
    else await localClient.notification(notification as never).catch(() => undefined);
  };

  localClient.fallbackNotificationHandler = (notification) =>
    notifyClient(notification as never);

  if (initialHost) {
    await attach(initialHost).catch((error: unknown) => {
      log(`could not attach to ${initialHost.url}: ${(error as Error).message}`);
    });
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    stopPolling();
    const current = app;
    app = null;
    if (current) await current.client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await localClient.close().catch(() => undefined);
    await local.server.close().catch(() => undefined);
  }

  return {
    server,
    local,
    mode: () => (app ? 'app' : 'memory'),
    url: () => app?.host.url ?? null,
    start: async () => {
      if (!app) startPolling();
    },
    close,
  };
}
