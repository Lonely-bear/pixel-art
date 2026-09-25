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

describe('presence checks: catching a piece that has been sanded flat', () => {
  // Regression guard. A defect-only report scored this "perfect" while the image had
  // lost its form: the defect metrics cannot see absence, only presence of faults.
  const fill = async (color: string) => {
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 0, w: 64, h: 64 }, color, fill: true },
    });
  };
  const makeDoc = async (width: number, height: number) => {
    await client.callTool({ name: 'create_document', arguments: { width, height, layers: ['base'] } });
  };

  it('passes a piece with real tonal range and depth', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 64, height: 64, layers: ['base'] } });
    await client.callTool({
      name: 'banded_gradient',
      arguments: { rect: { x: 0, y: 0, w: 64, h: 64 }, from: '#08080f', to: '#fff0cc', direction: 'vertical', steps: 24 },
    });
    // A treeline, so the planes genuinely differ.
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 44, w: 64, h: 20 }, color: '#101018', fill: true },
    });

    const body = payload((await client.callTool({ name: 'quality_report', arguments: {} })) as ToolResult);
    const presence = body.presence as {
      valueRange: number; darkShare: number; flatShare: number; planeSeparation: number;
    };
    expect(presence.valueRange).toBeGreaterThan(90);
    expect(presence.darkShare).toBeLessThan(0.75);
    expect(presence.planeSeparation).toBeGreaterThanOrEqual(6);
    expect(presence.flatShare).toBeLessThan(0.45);
    const codes = warningCodes((await client.callTool({ name: 'quality_report', arguments: {} })) as ToolResult);
    expect(codes).not.toContain('narrow_value_range');
    expect(codes).not.toContain('value_collapse_dark');
    expect(codes).not.toContain('flat_depth_planes');
    expect(codes).not.toContain('dead_flat_region');
  });

  it('flags a defect-perfect but dead-flat piece', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 64, height: 64, layers: ['base'] } });
    await fill('#2b3560');

    const result = (await client.callTool({ name: 'quality_report', arguments: {} })) as ToolResult;
    const body = payload(result);
    const presence = body.presence as { valueRange: number; flatShare: number; planeSeparation: number };

    // The point of the test: every defect is clean, and it is still a bad image.
    const noise = body.noise as { isolatedRatio: number; outlierRatio: number };
    expect(noise.isolatedRatio).toBe(0);
    expect(noise.outlierRatio).toBe(0);
    expect(noise.outliers).toBe(0);
    expect(presence.valueRange).toBe(0);
    expect(presence.flatShare).toBe(1);
    expect(presence.planeSeparation).toBe(0);

    const codes = warningCodes(result);
    expect(codes).toContain('narrow_value_range');
    expect(codes).toContain('dead_flat_region');
    // The plane check is suppressed here on purpose: a single-valued piece has no
    // tonal range to judge depth by, and `narrow_value_range` already says so.
    expect(codes).not.toContain('flat_depth_planes');
  });

  it('does not report flat planes on a narrow-band piece, only on a collapsed one', async () => {
    // Both are single-valued, so both trip `dead_flat_region`. Only the second should
    // also trip the plane check: a deliberately narrow palette is a choice, a collapse
    // is a defect, and the difference is the value range.
    await makeDoc(64, 64);
    await fill('#2b3560');
    const narrow = payload((await client.callTool({ name: 'quality_report', arguments: {} })) as ToolResult);
    expect((narrow.presence as { valueRange: number }).valueRange).toBe(0);
    expect((narrow.presence as { planeSeparation: number }).planeSeparation).toBe(0);

    await client.callTool({ name: 'create_document', arguments: { width: 64, height: 64, layers: ['base'] } });
    await client.callTool({
      name: 'banded_gradient',
      arguments: { rect: { x: 0, y: 0, w: 64, h: 32 }, from: '#f0e8d0', to: '#203050', direction: 'vertical', steps: 20 },
    });
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 32, w: 64, h: 32 }, color: '#203050', fill: true },
    });
    const wide = payload((await client.callTool({ name: 'quality_report', arguments: {} })) as ToolResult);
    // Full tonal range, but the sky and the ground share one value.
    expect((wide.presence as { valueRange: number }).valueRange).toBeGreaterThan(90);
    expect((wide.presence as { planeSeparation: number }).planeSeparation).toBeLessThan(6);
    expect(warningCodes((await client.callTool({ name: 'quality_report', arguments: {} })) as ToolResult))
      .toContain('flat_depth_planes');
  });

  it('separates a concentrated light source from an evenly bright one', async () => {
    // A scene with a real sun: the bright area is one tight cluster.
    await makeDoc(64, 64);
    await client.callTool({
      name: 'banded_gradient',
      arguments: { rect: { x: 0, y: 0, w: 64, h: 64 }, from: '#2a2040', to: '#b08050', direction: 'vertical', steps: 12 },
    });
    await client.callTool({
      name: 'draw_ellipse',
      arguments: { rect: { x: 28, y: 20, w: 8, h: 8 }, color: '#fff4d0', fill: true },
    });
    const lit = payload((await client.callTool({ name: 'quality_report', arguments: {} })) as ToolResult);
    const litPresence = lit.presence as { hasLightSource: boolean; lightConcentration: number };
    expect(litPresence.hasLightSource).toBe(true);
    expect(litPresence.lightConcentration).toBeGreaterThan(0.3);
    expect(warningCodes((await client.callTool({ name: 'quality_report', arguments: {} })) as ToolResult))
      .not.toContain('no_light_source');

    // Same tonal range, but the highlights are spread across the whole frame.
    await makeDoc(64, 64);
    await client.callTool({
      name: 'banded_gradient',
      arguments: { rect: { x: 0, y: 0, w: 64, h: 64 }, from: '#2b3550', to: '#6a7a96', direction: 'vertical', steps: 10 },
    });
    // An evenly stippled light: bright everywhere, concentrated nowhere. A gradient
    // would not do this, because its bright end is itself one contiguous block.
    await client.callTool({
      name: 'dither_fill',
      arguments: { rect: { x: 0, y: 0, w: 64, h: 64 }, color: '#fff4d0', pattern: 'checker', level: 0.5 },
    });
    const ambient = payload((await client.callTool({ name: 'quality_report', arguments: {} })) as ToolResult);
    const ambientPresence = ambient.presence as { hasLightSource: boolean; valueRange: number; lightConcentration: number };
    expect(ambientPresence.valueRange).toBeGreaterThan(90);
    expect(ambientPresence.lightConcentration).toBeLessThan(0.3);
    expect(ambientPresence.hasLightSource).toBe(false);
    // No textureRects here: declaring the stipple would exclude those pixels from
    // the light check entirely, which is the behaviour the next test covers.
    expect(warningCodes((await client.callTool({ name: 'quality_report', arguments: {} })) as ToolResult))
      .toContain('no_light_source');
  });

  it('excludes declared texture from the light-source check', async () => {
    // A sunset lake: scattered highlights on the water, one solid sun above it. The
    // glitter is a texture, so it must not stop the sun from reading as a source.
    await makeDoc(64, 64);
    await client.callTool({
      name: 'banded_gradient',
      arguments: { rect: { x: 0, y: 0, w: 64, h: 40 }, from: '#2a2040', to: '#a06848', direction: 'vertical', steps: 12 },
    });
    await client.callTool({
      name: 'draw_ellipse',
      arguments: { rect: { x: 28, y: 10, w: 8, h: 8 }, color: '#ffe4a8', fill: true },
    });
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 40, w: 64, h: 24 }, color: '#30264a', fill: true },
    });
    await client.callTool({
      name: 'scatter',
      arguments: { rect: { x: 0, y: 40, w: 64, h: 24 }, count: 260, color: '#ffc27a', radius: 1, cluster: 0 },
    });

    const water = { x: 0, y: 40, w: 64, h: 24 };
    const undeclared = payload((await client.callTool({ name: 'quality_report', arguments: {} })) as ToolResult);
    // The glitter is scattered enough to swamp the sun's concentration.
    expect((undeclared.presence as { hasLightSource: boolean }).hasLightSource).toBe(false);

    const declared = payload((await client.callTool({
      name: 'quality_report',
      arguments: { textureRects: [water] },
    })) as ToolResult);
    const after = declared.presence as { hasLightSource: boolean; lightConcentration: number };
    expect(after.hasLightSource).toBe(true);
    expect(after.lightConcentration).toBeGreaterThan(0.3);
  });

  it('flags a value collapse that keeps internal variety', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 64, height: 64, layers: ['base'] } });
    // Everything is dark but not uniform: no defect, no form.
    await client.callTool({
      name: 'banded_gradient',
      arguments: { rect: { x: 0, y: 0, w: 64, h: 64 }, from: '#101018', to: '#1c2438', direction: 'vertical', steps: 8 },
    });

    const result = (await client.callTool({ name: 'quality_report', arguments: {} })) as ToolResult;
    const presence = payload(result).presence as { darkShare: number };
    expect(presence.darkShare).toBeGreaterThan(0.75);
    expect(warningCodes(result)).toContain('value_collapse_dark');
  });

  it('keeps deliberate texture out of the high-frequency noise warning', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 64, height: 64, layers: ['base'] } });
    await fill('#203040');
    // A genuine speckle field over the lower half.
    await client.callTool({
      name: 'scatter',
      arguments: { rect: { x: 0, y: 32, w: 64, h: 32 }, count: 60, color: '#ffffff', radius: 1, cluster: 0.4 },
    });

    const noisy = (await client.callTool({ name: 'quality_report', arguments: {} })) as ToolResult;
    expect((payload(noisy).noise as { outlierRatio: number }).outlierRatio).toBeGreaterThan(0.01);
    expect(warningCodes(noisy)).toContain('high_frequency_noise');

    // Declaring that region as texture moves its outliers out of the warning.
    const declared = (await client.callTool({
      name: 'quality_report',
      arguments: { textureRects: [{ x: 0, y: 32, w: 64, h: 32 }] },
    })) as ToolResult;
    const noise = payload(declared).noise as { outliers: number; texturedOutliers: number; outlierRatio: number };
    expect(noise.outliers).toBe(0);
    expect(noise.texturedOutliers).toBeGreaterThan(0);
    expect(warningCodes(declared)).not.toContain('high_frequency_noise');
  });

  it('reports the defect score under a name that is not mistaken for quality', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 16, height: 16, layers: ['base'] } });
    await fill('#406080');
    const body = payload((await client.callTool({ name: 'quality_report', arguments: {} })) as ToolResult);
    expect(typeof body.defectScore).toBe('number');
    // The old alias still resolves, so existing callers keep working.
    expect(body.softnessScore).toBe(body.defectScore);
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
