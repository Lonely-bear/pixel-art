/**
 * `pixel-mcp --attach <url>` - a transparent stdio -> HTTP bridge.
 *
 * The desktop app hosts the full MCP server over Streamable HTTP on loopback
 * (default `http://127.0.0.1:7331/mcp`). Clients that can only speak stdio
 * (Claude Desktop and friends) cannot reach it directly, so this bridge opens a
 * stdio server to the client and forwards every request, notification and
 * response to the running app.
 *
 * The bridge is deliberately dumb: it does not know the pixel art vocabulary.
 * It copies the remote server's advertised capabilities and instructions, then
 * relays unknown methods through `fallbackRequestHandler`. New tools added to
 * the app therefore work through the bridge with no changes here.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Implementation, ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const BRIDGE_INFO: Implementation = { name: 'pixel-mcp-bridge', version: '0.1.0' };

/**
 * Long exports (spritesheets, GIFs) can outlive the SDK's 60s default request
 * timeout, so give relayed requests a generous ceiling. Node clamps timeouts
 * above 2^31-1 to 1ms, so this stays well below that.
 */
const RELAY_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Turn whatever the user typed into a Streamable HTTP endpoint URL. A bare
 * `host:port` is assumed to be `http://host:port/mcp`, matching the app's host.
 */
export function normalizeAttachUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('--attach requires a URL, e.g. --attach http://127.0.0.1:7331/mcp');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(withScheme);
  if (url.pathname === '' || url.pathname === '/') url.pathname = '/mcp';
  return url.toString();
}

export interface AttachBridge {
  /** The local stdio-facing server that speaks to the MCP client. */
  server: Server;
  /** The client connection to the running app. */
  remote: Client;
  /** The normalized endpoint the bridge connected to. */
  url: string;
  /** Close both ends. Safe to call more than once. */
  close(): Promise<void>;
}

export interface AttachOptions {
  /** Diagnostics sink. Defaults to stderr; never stdout, which carries JSON-RPC. */
  log?: (line: string) => void;
}

/**
 * Connect to a running pixel art MCP host and expose it over stdio.
 *
 * Resolves once the stdio transport is connected and the bridge is live. The
 * caller owns the process lifecycle (signals, exit codes).
 */
export async function runAttachBridge(rawUrl: string, options: AttachOptions = {}): Promise<AttachBridge> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const url = normalizeAttachUrl(rawUrl);

  const remote = new Client(BRIDGE_INFO, { capabilities: {} });
  const httpTransport = new StreamableHTTPClientTransport(new URL(url));
  await remote.connect(httpTransport);
  log(`pixel-mcp bridge: connected to ${url}`);

  // Mirror exactly what the app advertises so capability-gated client calls pass.
  const capabilities: ServerCapabilities = remote.getServerCapabilities() ?? {};
  const info: Implementation = remote.getServerVersion() ?? { name: 'pixel-art', version: '0.0.0' };
  const instructions = remote.getInstructions();

  const server = new Server(info, {
    capabilities,
    ...(instructions ? { instructions } : {}),
  });

  // Client -> app: relay every request the bridge has no local handler for.
  // `initialize` and `initialized` are handled locally by the low-level Server.
  server.fallbackRequestHandler = async (request) => {
    return (await remote.request(
      { method: request.method, params: request.params } as Parameters<Client['request']>[0],
      z.any(),
      { timeout: RELAY_TIMEOUT_MS },
    )) as Record<string, unknown>;
  };

  // Client -> app: fire-and-forget notifications (e.g. cancelled, progress acks).
  server.fallbackNotificationHandler = async (notification) => {
    try {
      await remote.notification(notification);
    } catch (error) {
      log(`pixel-mcp bridge: dropping notification ${notification.method}: ${(error as Error).message}`);
    }
  };

  // App -> client: resource/tool/prompt list changes, log messages, etc.
  remote.fallbackNotificationHandler = async (notification) => {
    try {
      await server.notification(notification);
    } catch {
      // The bridge may not advertise the capability a notification needs; ignore.
    }
  };

  const stdio = new StdioServerTransport();
  await server.connect(stdio);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await Promise.allSettled([server.close(), remote.close()]);
  };

  return { server, remote, url, close };
}
