/**
 * The embedded MCP server.
 *
 * The window and the agent share one `DocumentStore`, so anything an agent
 * draws appears on screen immediately and lands in the same undo history the
 * user is already using. That is only possible because the server lives in the
 * main process.
 *
 * Transport is Streamable HTTP on loopback: stdio is already taken by the app's
 * own process, and a local HTTP endpoint lets any number of clients attach,
 * including ones that only speak stdio via `pixel-mcp --attach <url>`.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createPixelServer } from '@pixel/mcp';
import type { McpStatus } from '../shared/types.js';
import { store } from './host.js';

export const DEFAULT_MCP_PORT = 7331;
const SESSION_HEADER = 'mcp-session-id';

interface Session {
  transport: StreamableHTTPServerTransport;
  close: () => Promise<void>;
}

export interface McpHost {
  status(): McpStatus;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    });
  });
}

export async function startMcpHost(port = DEFAULT_MCP_PORT): Promise<McpHost> {
  const sessions = new Map<string, Session>();
  let lastError: string | undefined;

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const sessionId = req.headers[SESSION_HEADER];
      const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;

      if (existing) {
        await existing.transport.handleRequest(req, res, await maybeBody(req));
        return;
      }

      if (req.method === 'POST') {
        // A new client: give it its own server instance, all sharing one store.
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, {
              transport,
              close: async () => {
                sessions.delete(id);
                await transport.close();
              },
            });
          },
        });
        const { server } = createPixelServer({ store, initialDocument: null });
        await server.connect(transport);
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id) sessions.delete(id);
        };
        await transport.handleRequest(req, res, await maybeBody(req));
        return;
      }

      if (req.method === 'DELETE' && typeof sessionId === 'string') {
        const session = sessions.get(sessionId);
        if (session) await session.close();
        res.writeHead(204).end();
        return;
      }

      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or unknown mcp-session-id header' }));
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: lastError }));
      }
    }
  });

  // The transport reads the stream itself for GET (SSE); only POST bodies are
  // pre-parsed here, because that is the case where we need the body to decide
  // whether the request starts a new session.
  async function maybeBody(req: IncomingMessage): Promise<unknown> {
    if (req.method !== 'POST') return undefined;
    return readBody(req).catch(() => undefined);
  }

  let actualPort = port;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      actualPort = await listen(httpServer, port + attempt);
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt === 9) throw error;
    }
  }

  const url = `http://127.0.0.1:${actualPort}/mcp`;

  return {
    status: () => ({
      running: lastError === undefined,
      url: lastError === undefined ? url : undefined,
      port: lastError === undefined ? actualPort : undefined,
      error: lastError,
    }),
    close: async () => {
      for (const session of [...sessions.values()]) await session.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
