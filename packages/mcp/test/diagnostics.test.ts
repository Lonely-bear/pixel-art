/**
 * Tests for the composition diagnostics and the guidance that goes with them.
 *
 * These exist because the failures they catch are invisible in a thumbnail: a palette
 * step too close to its neighbour to read, a composition that has collapsed into
 * stripes, a row of identical shapes, and a dither field big enough to read as a
 * lattice. None of them is a bug - the code is doing exactly what it was asked - so
 * the only defence is to measure them and say so.
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

function warningCodes(result: ToolResult): string[] {
  return (payload(result).warnings as Array<{ code: string }>).map((warning) => warning.code);
}

let client: Client;
let pixel: PixelServer;
let tempDir: string;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'pixel-diag-'));
  pixel = createPixelServer({ initialDocument: null });
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

describe('quality_report composition diagnostics', () => {
  it('names the exact unused palette slots instead of only counting them', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: {
        width: 16,
        height: 16,
        layers: ['base'],
        palette: ['#000000', '#ffffff', '#ff0000', '#00ff00'],
      },
    });
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 0, w: 16, h: 16 }, color: '#000000', fill: true },
    });

    const body = payload((await client.callTool({ name: 'quality_report', arguments: {} })) as ToolResult);
    const palette = body.palette as { unusedIndices: number[]; unused: number };
    expect(palette.unused).toBe(3);
    expect(palette.unusedIndices).toEqual([1, 2, 3]);
    expect(warningCodes((await client.callTool({ name: 'quality_report', arguments: {} })) as ToolResult)).toContain(
      'unused_palette_slots',
    );
  });

  it('flags palette steps too close to read as separate tones', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: {
        width: 16,
        height: 16,
        layers: ['base'],
        palette: ['#203040', '#223242', '#405060'],
      },
    });
    await client.callTool({
      name: 'apply_ops',
      arguments: {
        ops: [
          { command: 'draw_rect', params: { rect: { x: 0, y: 0, w: 5, h: 16 }, color: '#203040', fill: true } },
          { command: 'draw_rect', params: { rect: { x: 5, y: 0, w: 5, h: 16 }, color: '#223242', fill: true } },
          { command: 'draw_rect', params: { rect: { x: 10, y: 0, w: 6, h: 16 }, color: '#405060', fill: true } },
        ],
      },
    });

    const result = (await client.callTool({ name: 'quality_report', arguments: {} })) as ToolResult;
    const palette = payload(result).palette as {
      crowded: Array<{ a: number; b: number; delta: number }>;
    };
    // Slots 0 and 1 differ by 2/255 on the max channel: same tone to the eye.
    expect(palette.crowded.some((pair) => pair.a === 0 && pair.b === 1 && pair.delta === 2)).toBe(true);
    expect(warningCodes(result)).toContain('palette_crowding');
  });

  it('counts full-width tonal edges and warns once the piece reads as stripes', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 64, height: 64, layers: ['base'] } });
    // Even ~32-luminance steps between every band, so each boundary is a real
    // full-width tonal edge rather than a marginal one.
    const bands = ['#101020', '#303048', '#505070', '#707090', '#9090b0', '#b0b0d0'];
    for (let index = 0; index < bands.length; index++) {
      await client.callTool({
        name: 'draw_rect',
        arguments: { rect: { x: 0, y: index * 10, w: 64, h: 10 }, color: bands[index], fill: true },
      });
    }

    const result = (await client.callTool({ name: 'quality_report', arguments: {} })) as ToolResult;
    const structure = payload(result).structure as { horizontalBands: number; strongBands: number };
    expect(structure.horizontalBands).toBeGreaterThanOrEqual(5);
    expect(structure.strongBands).toBeGreaterThan(3);
    expect(warningCodes(result)).toContain('horizontal_banding');
  });

  it('does not condemn a legitimate multi-step gradient to banding', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 64, height: 64, layers: ['base'] } });
    await client.callTool({
      name: 'banded_gradient',
      arguments: {
        rect: { x: 0, y: 0, w: 64, h: 64 },
        from: '#101020',
        to: '#e0d0c0',
        direction: 'vertical',
        steps: 32,
      },
    });

    const result = (await client.callTool({ name: 'quality_report', arguments: {} })) as ToolResult;
    const structure = payload(result).structure as { strongBands: number };
    // Many gentle steps are a gradient, not stripes: the strong count is what matters.
    expect(structure.strongBands).toBeLessThanOrEqual(3);
    expect(warningCodes(result)).not.toContain('horizontal_banding');
  });

  it('says so when the frame has no silhouette to measure', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 32, height: 32, layers: ['base'] } });
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 0, w: 32, h: 32 }, color: '#204060', fill: true },
    });

    const result = (await client.callTool({ name: 'quality_report', arguments: {} })) as ToolResult;
    const rhythm = (payload(result).structure as { rhythm: { measurable: boolean; note: string } }).rhythm;
    expect(rhythm.measurable).toBe(false);
    expect(rhythm.note).toContain('no silhouette');
    expect(warningCodes(result)).not.toContain('uniform_rhythm');
  });

  it('flags a row of identical evenly spaced shapes as wallpaper rhythm', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 64, height: 32, layers: ['base'] } });
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 20, w: 64, h: 12 }, color: '#204060', fill: true },
    });
    // Six identical triangles, exactly 10px apart, all the same height.
    for (let x = 4; x < 64; x += 10) {
      await client.callTool({
        name: 'draw_polygon',
        arguments: {
          points: [
            { x, y: 8 },
            { x: x - 4, y: 20 },
            { x: x + 4, y: 20 },
          ],
          color: '#204060',
          fill: true,
        },
      });
    }

    const result = (await client.callTool({ name: 'quality_report', arguments: {} })) as ToolResult;
    const rhythm = (payload(result).structure as { rhythm: { peaks: number; uniform: boolean } }).rhythm;
    expect(rhythm.peaks).toBeGreaterThanOrEqual(5);
    expect(rhythm.uniform).toBe(true);
    expect(warningCodes(result)).toContain('uniform_rhythm');
  });

  it('leaves an irregular skyline alone', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 64, height: 32, layers: ['base'] } });
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 20, w: 64, h: 12 }, color: '#204060', fill: true },
    });
    const jittered = [3, 14, 22, 38, 44, 58];
    const heights = [10, 6, 13, 5, 12, 8];
    jittered.forEach((x, index) => {
      void client.callTool({
        name: 'draw_polygon',
        arguments: {
          points: [
            { x, y: heights[index] },
            { x: x - 4, y: 20 },
            { x: x + 4, y: 20 },
          ],
          color: '#204060',
          fill: true,
        },
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const result = (await client.callTool({ name: 'quality_report', arguments: {} })) as ToolResult;
    const rhythm = (payload(result).structure as { rhythm: { uniform: boolean } }).rhythm;
    expect(rhythm.uniform).toBe(false);
    expect(warningCodes(result)).not.toContain('uniform_rhythm');
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
