import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPixelServer, type PixelServer } from '../src/server.js';

interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Parse the first text block of a tool result as JSON. */
function payload(result: ToolResult): Record<string, any> {
  return JSON.parse(result.content.find((c) => c.type === 'text')?.text ?? '{}');
}

function firstText(result: ToolResult): string {
  return result.content.find((c) => c.type === 'text')?.text ?? '';
}

let client: Client;
let pixel: PixelServer;
let tempDir: string;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'pixel-mcp-anim-'));
  pixel = createPixelServer({ initialDocument: null });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'animation-test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), pixel.server.connect(serverTransport)]);
});

afterEach(async () => {
  await client.close();
  await pixel.server.close();
  rmSync(tempDir, { recursive: true, force: true });
});

/** Call a generated command tool and return its nested summary. */
async function run(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  const body = payload(result);
  return { ...body, ...(body.summary ?? {}) };
}

/** A 3-frame document with one painted frame per cel, so the GIF has real pixels. */
async function makeAnimation(): Promise<void> {
  await client.callTool({
    name: 'create_document',
    arguments: {
      width: 16,
      height: 16,
      name: 'Bob',
      layers: ['base'],
      frames: 3,
      frameDurationMs: 120,
      palette: 'dawnbringer16',
    },
  });
  for (let frame = 0; frame < 3; frame++) {
    await client.callTool({
      name: 'draw_rect',
      arguments: {
        layer: 'base',
        frame,
        rect: { x: 4, y: 4 + frame, w: 8, h: 8 },
        color: '#63c64d',
        fill: true,
      },
    });
  }
}

function gifSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
}

describe('animated GIF export', () => {
  it('advertises export_gif as a tool', async () => {
    // Same guard as the tilemap suite: M3 once shipped a tool that was claimed in
    // the commit message but never registered, and only a tool list would catch it.
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('export_gif');
  });

  it('writes a GIF89a at the sprite dimensions', async () => {
    await makeAnimation();
    const out = join(tempDir, 'bob.gif');

    const result = await run('export_gif', { out });
    expect(result.ok).toBe(true);
    expect(result.frames).toBe(3);
    expect(result.durationMs).toBe(360);
    expect(result.loops).toBe(true);

    const bytes = readFileSync(out);
    expect(bytes.subarray(0, 6).toString('latin1')).toBe('GIF89a');
    expect(gifSize(bytes)).toEqual({ width: 16, height: 16 });
  });

  it('upscales the whole GIF by an integer factor', async () => {
    await makeAnimation();
    const out = join(tempDir, 'bob-big.gif');

    const result = await run('export_gif', { out, scale: 4 });
    expect(result.width).toBe(64);
    expect(result.height).toBe(64);
    expect(gifSize(readFileSync(out))).toEqual({ width: 64, height: 64 });
  });

  it('expands a pingpong tag without duplicating frames by hand', async () => {
    await makeAnimation();
    await run('add_tag', { name: 'idle', from: 0, to: 2, direction: 'pingpong', repeat: 0 });

    const out = join(tempDir, 'idle.gif');
    const result = await run('export_gif', { out, tag: 'idle' });

    // 0, 1, 2, 1 - the endpoints are not repeated on the return leg.
    expect(result.frames).toBe(4);
    expect(result.tag).toBe('idle');
    expect(result.loops).toBe(true);
    expect(readFileSync(out).subarray(0, 6).toString('latin1')).toBe('GIF89a');
  });

  it('stops looping when the tag repeats a finite number of times', async () => {
    await makeAnimation();
    await run('add_tag', { name: 'blink', from: 0, to: 1, direction: 'forward', repeat: 3 });

    const result = await run('export_gif', { out: join(tempDir, 'blink.gif'), tag: 'blink' });
    expect(result.frames).toBe(6); // two frames, three passes
    expect(result.loops).toBe(false);
  });

  it('rejects an explicitly requested tag that does not exist', async () => {
    await makeAnimation();
    const result = (await client.callTool({
      name: 'export_gif',
      arguments: { out: join(tempDir, 'missing.gif'), tag: 'attack' },
    })) as ToolResult;

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/Unknown animation tag: attack/);
  });

  it('accepts `path` as an alias for `out`', async () => {
    await makeAnimation();
    const out = join(tempDir, 'alias.gif');
    const result = await run('export_gif', { path: out });
    expect(result.path).toBe(out);
    expect(readFileSync(out).subarray(0, 6).toString('latin1')).toBe('GIF89a');
  });

  it('explains that a destination is required', async () => {
    await makeAnimation();
    const result = (await client.callTool({ name: 'export_gif', arguments: {} })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/required/i);
  });
});
