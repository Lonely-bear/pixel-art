#!/usr/bin/env node
/**
 * `dotloom-mcp` - the stdio MCP server.
 *
 * With no arguments the tool looks for a running desktop app and, if it finds
 * one, forwards to it so the agent and the user's window share one document
 * store and one undo history - edits show up on screen as they are made. If no
 * app is running it falls back to a self-contained editor rather than failing,
 * because headless and CI use have no app and must keep working; the agent is
 * told this happened through the server's `instructions`.
 *
 * Nothing but JSON-RPC may go to stdout, so every log line goes to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runAttachBridge } from './attach.js';
import { discoverHost, hostFilePath, scanHostPorts, waitForHost } from './discovery.js';
import { createPixelServer, SERVER_NAME, SERVER_VERSION } from './server.js';

/** How long to keep looking for an app that is still starting up. */
const HOST_WAIT_MS = 1500;

/** Read `--attach <url>` / `--attach=<url>`; returns null when absent. */
function attachUrl(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--attach') return args[i + 1] ?? '';
    if (arg.startsWith('--attach=')) return arg.slice('--attach='.length);
  }
  return null;
}

const log = (line: string) => process.stderr.write(`${line}\n`);

/**
 * What the agent is told when no app was found.
 *
 * Written for the model, not the human: the failure it prevents is the agent
 * confidently reporting a finished sprite that no window ever displayed.
 */
const OFFLINE_NOTE = [
  '## The desktop app is not running',
  '',
  'This session did not find a running Pixel Art desktop client, so it owns a',
  'private in-memory document store. Consequences worth stating up front:',
  '',
  '- Edits you make are real and undoable, but **no app window will show them**.',
  '  There is no live rendering. Do not describe a sprite as "on screen".',
  '- The user may already have the app open under a different endpoint; say that',
  '  restarting this MCP session after launching the app is what enables live',
  '  rendering, rather than assuming they have.',
  '- Nothing is written to disk until `save_document` or `finalize_document`',
  '  runs, so treat unsaved work as lost if the session ends.',
].join('\n');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--version') || args.includes('-v')) {
    log(`${SERVER_NAME} ${SERVER_VERSION}`);
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    log(
      `${SERVER_NAME} ${SERVER_VERSION} - MCP server for the dotloom-mcp pixel-art editor.\n\n` +
        `Usage: dotloom-mcp [options]\n\n` +
        `Options:\n` +
        `  -h, --help           Show this help.\n` +
        `  -v, --version        Print the version.\n` +
        `      --attach <url>   Forward to a specific app endpoint. Fails if it\n` +
        `                       does not answer, rather than falling back.\n` +
        `      --standalone     Never look for an app; run self-contained.\n` +
        `      --host-wait <ms> How long to wait for an app to appear (default ${HOST_WAIT_MS}).\n` +
        `      --json-status    Report app discovery as JSON and exit.\n\n` +
        `With no options this looks for a running desktop app on the loopback\n` +
        `interface and forwards to it when found, so the agent edits the same\n` +
        `documents the user's window shows. With no app running it runs a\n` +
        `self-contained editor over stdio and tells the agent that live rendering\n` +
        `is unavailable. The endpoint is discovered, never configured, so an app\n` +
        `that moved to another port is still found.\n` +
        `See pixel://skill for the pixel art craft guide.\n`,
    );
    return;
  }

  const waitArg = args.indexOf('--host-wait');
  const waitMs = waitArg >= 0 ? Number(args[waitArg + 1]) : HOST_WAIT_MS;

  if (args.includes('--json-status')) {
    const host = await discoverHost({ log: () => {} });
    log(
      JSON.stringify(
        {
          appRunning: host !== null,
          url: host?.url ?? null,
          port: host?.port ?? null,
          source: host?.source ?? null,
          pid: host?.pid ?? null,
          version: host?.version ?? null,
          hostFile: hostFilePath(),
          openPorts: await scanHostPorts(),
        },
        null,
        2,
      ),
    );
    return;
  }

  const explicit = attachUrl(args);
  let close: () => Promise<void> = async () => {};
  const shutdown = async () => {
    try {
      await close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  if (explicit !== null) {
    // An explicit endpoint is a request, not a hint: never silently degrade it.
    // The raw failure here is a bare `fetch failed`, which tells the user
    // nothing about which of the two likely causes it was.
    let bridge: Awaited<ReturnType<typeof runAttachBridge>>;
    try {
      bridge = await runAttachBridge(explicit);
    } catch (error) {
      throw new Error(
        `--attach ${explicit} did not answer: ${(error as Error).message}\n` +
          `  The app is probably not running, or it is on a different port.\n` +
          `  Run \`${SERVER_NAME} --json-status\` to see where it is listening.`,
      );
    }
    close = bridge.close;
    log(`${SERVER_NAME} ${SERVER_VERSION} bridging stdio -> ${bridge.url}.`);
    return;
  }

  if (!args.includes('--standalone')) {
    const host = await waitForHost(waitMs, { log });
    if (host) {
      const bridge = await runAttachBridge(host.url);
      close = bridge.close;
      log(
        `${SERVER_NAME} ${SERVER_VERSION} attached to the running app at ${bridge.url} ` +
          `(found via ${host.source}${host.pid ? `, pid ${host.pid}` : ''}). Edits render live.`,
      );
      return;
    }
    log(
      `No running Pixel Art app found (looked for ${hostFilePath()} and the default port range). ` +
        `Running self-contained: edits will NOT appear in an app window. Launch the app and ` +
        `restart this MCP session for live rendering.`,
    );
  }

  const { server, store } = createPixelServer({ instructionsNote: OFFLINE_NOTE });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  close = () => server.close();

  log(`${SERVER_NAME} ${SERVER_VERSION} ready on stdio - ${store.list().length} document(s) open.`);
}

main().catch((error: unknown) => {
  process.stderr.write(`dotloom-mcp failed to start: ${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
