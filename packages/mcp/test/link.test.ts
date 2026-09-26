/**
 * The host link is the piece that decides whether an agent edits the app or an
 * in-memory store, and it does so more than once: at startup, and again whenever an
 * app appears or disappears. These tests exercise the three states that matter -
 * attached, memory, and attached-late - because "it found the app the first time"
 * was exactly the bug.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { DiscoveredHost } from '../src/discovery.js';
import { CONNECTION_STATUS_TOOL, createHostLink, type HostLink } from '../src/link.js';
import { createPixelServer, type PixelServer } from '../src/server.js';

interface Connectable {
  connect(transport: InMemoryTransport): Promise<void>;
}

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

async function connect(server: Connectable): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'link-test', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function text(result: unknown): string {
  const content = (result as ToolResult).content;
  return content.find((block) => block.type === 'text')?.text ?? '';
}

function json(result: unknown): Record<string, unknown> {
  return JSON.parse(text(result)) as Record<string, unknown>;
}

async function until(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const HOST: DiscoveredHost = {
  url: 'http://127.0.0.1:7331/mcp',
  port: 7331,
  source: 'port-scan',
};

const open: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (open.length > 0) await open.pop()?.close().catch(() => undefined);
});

/** Stand up a stand-in desktop app: a real pixel server behind a client of its own. */
async function fakeApp(): Promise<{ app: PixelServer; client: Client }> {
  const app = createPixelServer({ initialDocument: null });
  const client = await connect(app.server);
  open.push(app.server);
  open.push(client);
  return { app, client };
}

describe('createHostLink', () => {
  it('routes every request to the running app when one is found', async () => {
    const { app, client: appClient } = await fakeApp();
    const link = await createHostLink({
      findHost: async () => HOST,
      connectApp: async () => appClient,
      pollMs: 60_000,
    });
    open.push(link);
    const client = await connect(link.server);
    open.push(client);
    await link.start();

    expect(link.mode()).toBe('app');
    expect(link.url()).toBe(HOST.url);

    await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, name: 'Bridged', layers: ['base'] },
    });

    expect(app.store.list().map((doc) => doc.name)).toContain('Bridged');
    // The fallback store must be untouched: the app is authoritative while attached.
    expect(link.local.store.list().some((doc) => doc.name === 'Bridged')).toBe(false);
  });

  it('advertises the connection tool and reports the app mode', async () => {
    const { client: appClient } = await fakeApp();
    const link = await createHostLink({
      findHost: async () => HOST,
      connectApp: async () => appClient,
      pollMs: 60_000,
    });
    open.push(link);
    const client = await connect(link.server);
    open.push(client);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain(CONNECTION_STATUS_TOOL);

    const status = json(await client.callTool({ name: CONNECTION_STATUS_TOOL, arguments: {} }));
    expect(status.mode).toBe('app');
    expect(status.attached).toBe(true);
    expect(status.livePreview).toBe(true);
    expect(status.url).toBe(HOST.url);
  });

  it('falls back to the in-memory editor when no app answers', async () => {
    const link = await createHostLink({ findHost: async () => null, pollMs: 60_000 });
    open.push(link);
    const client = await connect(link.server);
    open.push(client);
    await link.start();

    expect(link.mode()).toBe('memory');

    const status = json(await client.callTool({ name: CONNECTION_STATUS_TOOL, arguments: {} }));
    expect(status.mode).toBe('memory');
    expect(status.livePreview).toBe(false);

    await client.callTool({
      name: 'create_document',
      arguments: { width: 4, height: 4, name: 'Local', layers: ['base'] },
    });
    expect(link.local.store.list().some((doc) => doc.name === 'Local')).toBe(true);
  });

  it('attaches to an app that appears after the session started', async () => {
    const { app, client: appClient } = await fakeApp();
    let probes = 0;
    const link = await createHostLink({
      findHost: async () => {
        probes += 1;
        return probes >= 2 ? HOST : null;
      },
      connectApp: async () => appClient,
      pollMs: 10,
    });
    open.push(link);
    const client = await connect(link.server);
    open.push(client);
    await link.start();

    expect(link.mode()).toBe('memory');
    await until(() => link.mode() === 'app');
    expect(link.mode()).toBe('app');

    await client.callTool({
      name: 'create_document',
      arguments: { width: 6, height: 6, name: 'Late', layers: ['base'] },
    });
    expect(app.store.list().some((doc) => doc.name === 'Late')).toBe(true);
  });
});
