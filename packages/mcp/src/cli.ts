#!/usr/bin/env node
/**
 * `dotloom-mcp` - the standalone stdio MCP server.
 *
 * Point any MCP client at this binary and the agent gets the full editor without
 * the desktop app running. Nothing but JSON-RPC may go to stdout, so every log
 * line is written to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runAttachBridge } from './attach.js';
import { createPixelServer, SERVER_NAME, SERVER_VERSION } from './server.js';

/** Read `--attach <url>` / `--attach=<url>`; returns null when absent. */
function attachUrl(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--attach') return args[i + 1] ?? '';
    if (arg.startsWith('--attach=')) return arg.slice('--attach='.length);
  }
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--version') || args.includes('-v')) {
    process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION}\n`);
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    process.stderr.write(
      `${SERVER_NAME} ${SERVER_VERSION} - MCP server for the dotloom-mcp pixel-art editor.\n\n` +
        `Usage: dotloom-mcp [options]\n\n` +
        `Options:\n` +
        `  -h, --help         Show this help.\n` +
        `  -v, --version      Print the version.\n` +
        `      --attach <url> Bridge stdio to a running app over Streamable HTTP\n` +
        `                     (default endpoint http://127.0.0.1:7331/mcp).\n\n` +
        `With no options this runs a self-contained editor and speaks the Model\n` +
        `Context Protocol over stdio. With --attach it forwards to a running\n` +
        `desktop app instead, so stdio-only clients can drive the live editor.\n` +
        `See pixel://skill for the pixel art craft guide.\n`,
    );
    return;
  }

  const url = attachUrl(args);
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

  if (url !== null) {
    const bridge = await runAttachBridge(url);
    close = bridge.close;
    process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION} bridging stdio -> ${bridge.url}.\n`);
    return;
  }

  const { server, store } = createPixelServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  close = () => server.close();

  process.stderr.write(
    `${SERVER_NAME} ${SERVER_VERSION} ready on stdio - ${store.list().length} document(s) open.\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`dotloom-mcp failed to start: ${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
