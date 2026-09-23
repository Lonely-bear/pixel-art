#!/usr/bin/env node
/**
 * `pixel-mcp` - the standalone stdio MCP server.
 *
 * Point any MCP client at this binary and the agent gets the full editor without
 * the desktop app running. Nothing but JSON-RPC may go to stdout, so every log
 * line is written to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createPixelServer, SERVER_NAME, SERVER_VERSION } from './server.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--version') || args.includes('-v')) {
    process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION}\n`);
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    process.stderr.write(
      `${SERVER_NAME} ${SERVER_VERSION} - MCP server for the pixel art editor.\n\n` +
        `Usage: pixel-mcp [options]\n\n` +
        `Options:\n` +
        `  -h, --help     Show this help.\n` +
        `  -v, --version  Print the version.\n\n` +
        `Speaks the Model Context Protocol over stdio. Configure your MCP client to\n` +
        `launch this binary; see pixel://skill for the pixel art craft guide.\n`,
    );
    return;
  }

  const { server, store } = createPixelServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  process.stderr.write(
    `${SERVER_NAME} ${SERVER_VERSION} ready on stdio - ${store.list().length} document(s) open.\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`pixel-mcp failed to start: ${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
