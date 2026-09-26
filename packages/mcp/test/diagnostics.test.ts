/**
 * Tests for the perception tools and the guidance that goes with them.
 *
 * The common thread is measurement the model cannot do by eye: which palette slots
 * never reach the canvas, whether a dither field is a tone or a visible lattice,
 * how far a batch moved the undo stack, and whether a cropped export really is
 * only the region that was asked for.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPixelServer, type PixelServer } from '../src/server.js';

interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

function payload(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content.find((c) => c.type === 'text')?.text ?? '{}');
}

let client: Client;
let pixel: PixelServer;
let tempDir: string;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'pixel-diag-'));
  // Eager: this suite calls command tools directly. The lazy surface, and the
  // promotion paths that replace it, are covered in tool-surface.test.ts.
  pixel = createPixelServer({ initialDocument: null, commands: 'eager' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([
    client.connect(clientTransport),
    pixel.server.connect(serverTransport),
  ]);
});

afterEach(async () => {
  await client.close();
  await pixel.server.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('histogram', () => {
  it('counts colours, maps them to palette slots and names the unused ones', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: {
        width: 16,
        height: 16,
        name: 'Tally',
        layers: ['base'],
        palette: ['#102040', '#804020', '#c0c0c0'],
      },
    });
    await client.callTool({
      name: 'apply_ops',
      arguments: {
        ops: [
          { command: 'draw_rect', params: { rect: { x: 0, y: 0, w: 8, h: 16 }, color: '#102040', fill: true } },
          { command: 'draw_rect', params: { rect: { x: 8, y: 0, w: 8, h: 16 }, color: '#804020', fill: true } },
        ],
      },
    });

    const result = (await client.callTool({ name: 'histogram', arguments: {} })) as ToolResult;
    const body = payload(result);
    expect(body.ok).toBe(true);
    expect(body.solid).toBe(256);
    expect(body.distinctColors).toBe(2);
    expect(body.unusedPaletteIndices).toEqual([2]);

    const colors = body.colors as Array<{ hex: string; count: number; paletteIndex: number | null }>;
    expect(colors).toHaveLength(2);
    for (const entry of colors) expect(entry.paletteIndex).not.toBeNull();
    expect(colors.find((entry) => entry.hex === '#102040')?.count).toBe(128);
    expect(colors.find((entry) => entry.hex === '#804020')?.count).toBe(128);
  });

  it('tallies a whole canvas in one call, where get_pixels would need many', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 64, height: 64, layers: ['base'] } });
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 0, w: 64, h: 64 }, color: '#204060', fill: true },
    });

    const result = (await client.callTool({ name: 'histogram', arguments: {} })) as ToolResult;
    const body = payload(result);
    expect(body.solid).toBe(4096);
    expect(body.distinctColors).toBe(1);

    // The old route is still capped, which is exactly why this tool exists.
    const capped = (await client.callTool({
      name: 'get_pixels',
      arguments: { rect: { x: 0, y: 0, w: 64, h: 64 } },
    })) as ToolResult;
    expect(String(payload(capped).ok ?? '')).toBe('false');
  });
});

describe('dither advisories', () => {
  it('warns that a large low-coverage dither field reads as a lattice', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 64, height: 64, layers: ['base'] } });
    const result = (await client.callTool({
      name: 'apply_ops',
      arguments: {
        ops: [
          {
            command: 'dither_fill',
            params: { rect: { x: 0, y: 0, w: 64, h: 64 }, color: '#ffffff', pattern: 'cluster2', level: 0.25 },
          },
        ],
      },
    })) as ToolResult;

    const advisories = payload(result).advisories as Array<{ message: string }>;
    expect(advisories.length).toBeGreaterThan(0);
    expect(advisories.some((advisory) => advisory.message.includes('lattice'))).toBe(true);
  });

  it('reports the level a pattern actually resolves to', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 16, height: 16, layers: ['base'] } });
    const result = (await client.callTool({
      name: 'apply_ops',
      arguments: {
        ops: [
          {
            command: 'dither_fill',
            params: { rect: { x: 0, y: 0, w: 8, h: 8 }, color: '#ffffff', pattern: 'cluster2', level: 0.1 },
          },
        ],
      },
    })) as ToolResult;

    const advisories = payload(result).advisories as Array<{ message: string }>;
    expect(advisories.some((advisory) => advisory.message.includes('0.0625'))).toBe(true);
  });

  it('stays quiet about a small seam, which is the correct use', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 64, height: 64, layers: ['base'] } });
    const result = (await client.callTool({
      name: 'apply_ops',
      arguments: {
        ops: [
          {
            command: 'dither_fill',
            params: { rect: { x: 0, y: 30, w: 64, h: 4 }, color: '#ffffff', pattern: 'bayer4', level: 0.5 },
          },
        ],
      },
    })) as ToolResult;

    expect(payload(result).advisories).toBeUndefined();
  });
});

describe('apply_ops undo granularity', () => {
  // Built fresh per call: `apply_ops` fills `layer`/`frame` defaults into the params
  // objects it is handed, so a shared literal would carry one document's layer id
  // into the next test's document.
  const threeOps = () => [
    { command: 'draw_rect', params: { rect: { x: 0, y: 0, w: 4, h: 4 }, color: '#ff0000', fill: true } },
    { command: 'draw_rect', params: { rect: { x: 4, y: 0, w: 4, h: 4 }, color: '#00ff00', fill: true } },
    { command: 'draw_rect', params: { rect: { x: 8, y: 0, w: 4, h: 4 }, color: '#0000ff', fill: true } },
  ];

  it('keeps one history entry per op by default', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 16, height: 16, layers: ['base'] } });
    await client.callTool({ name: 'apply_ops', arguments: { ops: threeOps() } });

    const body = payload((await client.callTool({ name: 'get_history', arguments: {} })) as ToolResult);
    expect(body.total).toBe(3);
  });

  it('collapses the batch into a single history entry on request', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 16, height: 16, layers: ['base'] } });
    await client.callTool({ name: 'apply_ops', arguments: { ops: threeOps(), singleUndoStep: true } });

    const body = payload((await client.callTool({ name: 'get_history', arguments: {} })) as ToolResult);
    expect(body.total).toBe(1);

    // One undo must take the whole batch back, not just its first op.
    await client.callTool({ name: 'undo', arguments: {} });
    const after = payload((await client.callTool({ name: 'histogram', arguments: {} })) as ToolResult);
    expect(after.solid).toBe(0);
  });
});

describe('export_png cropping', () => {
  it('writes only the requested region, at the right size', async () => {
    const path = join(tempDir, 'crop.png');
    await client.callTool({ name: 'create_document', arguments: { width: 64, height: 64, layers: ['base'] } });
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 0, w: 64, h: 64 }, color: '#3060a0', fill: true },
    });

    const result = (await client.callTool({
      name: 'export_png',
      arguments: { out: path, rect: { x: 8, y: 16, w: 20, h: 10 } },
    })) as ToolResult;
    const body = payload(result);
    expect(body.ok).toBe(true);
    expect(body.width).toBe(20);
    expect(body.height).toBe(10);

    const bytes = readFileSync(path);
    expect(bytes.readUInt32BE(16)).toBe(20);
    expect(bytes.readUInt32BE(20)).toBe(10);
  });
});
