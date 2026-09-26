#!/usr/bin/env node
/**
 * `dotloom-mcp` - the stdio MCP server.
 *
 * With no arguments the tool prefers a running desktop app: while one is found it
 * forwards to it, so the agent and the user's window share one document store and
 * one undo history - edits show up on screen as they are made. If no app answers at
 * startup it falls back to a self-contained editor rather than failing, because
 * headless and CI use have no app and must keep working, and it keeps watching for
 * an app to appear. When the app comes or goes the link follows it. The agent is
 * told which mode it is in through the server's `instructions` and
 * `get_connection_status`.
 *
 * Nothing but JSON-RPC may go to stdout, so every log line goes to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runAttachBridge } from './attach.js';
import { discoverHost, hostFilePath, scanHostPorts } from './discovery.js';
import { createHostLink } from './link.js';
import { createPixelServer, standaloneNote, SERVER_NAME, SERVER_VERSION } from './server.js';

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
        `      --host-wait <ms> How long to wait for an app at startup (default ${HOST_WAIT_MS}).\n` +
        `      --json-status    Report app discovery as JSON and exit.\n\n` +
        `With no options this prefers a running desktop app: it looks on the loopback\n` +
        `interface and forwards to it when found, so the agent edits the same documents\n` +
        `the user's window shows. If no app answers at startup it runs a self-contained\n` +
        `editor over stdio and keeps watching, reconnecting automatically once the app\n` +
        `appears; when the app goes away it falls back to memory and watches again. The\n` +
        `endpoint is discovered, never configured, so an app that moved to another port\n` +
        `is still found.\n` +
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

  if (args.includes('--standalone')) {
    // An explicit request to run self-contained: never look, never reconnect.
    const { server, store } = createPixelServer({ instructionsNote: standaloneNote() });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    close = () => server.close();
    log(`${SERVER_NAME} ${SERVER_VERSION} ready on stdio - ${store.list().length} document(s) open.`);
    return;
  }

  // Default: prefer a running app, and keep looking if one appears later. The
  // relay stands up the in-memory editor either way, so a missing app degrades
  // instead of failing.
  const link = await createHostLink({ hostWaitMs: waitMs, log });
  const transport = new StdioServerTransport();
  await link.server.connect(transport);
  await link.start();
  close = link.close;
  log(
    link.mode() === 'app'
      ? `${SERVER_NAME} ${SERVER_VERSION} ready on stdio, attached to ${link.url()}.`
      : `${SERVER_NAME} ${SERVER_VERSION} ready on stdio in memory; watching for a desktop app.`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`dotloom-mcp failed to start: ${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
