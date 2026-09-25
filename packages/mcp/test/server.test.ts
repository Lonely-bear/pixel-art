/**
 * End-to-end tests over the real MCP client/server pair.
 *
 * These drive the server exactly as an agent would - list tools, call them,
 * read resources, run prompts - so a regression in the wire format or in a
 * schema shows up here rather than in someone's agent session.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { decodePNG } from '@pixel/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPixelServer, type PixelServer } from '../src/server.js';

interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function payload(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content.find((c) => c.type === 'text')?.text ?? '{}');
}

function firstText(result: ToolResult): string {
  return result.content.find((c) => c.type === 'text')?.text ?? '';
}

function decodedImage(result: ToolResult) {
  const image = result.content.find((content) => content.type === 'image');
  expect(image?.mimeType).toBe('image/png');
  return decodePNG(Buffer.from(image!.data!, 'base64'));
}

/** Read the dimensions straight out of a PNG's IHDR, independent of our encoder. */
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

let client: Client;
let pixel: PixelServer;
let tempDir: string;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'pixel-mcp-'));
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

describe('tool surface', () => {
  it('advertises every command plus the session tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('draw_rect');
    expect(names).toContain('dither_fill');
    expect(names).toContain('add_frame');
    expect(names).toContain('quantize_to_palette');
    expect(names).toContain('apply_ops');
    expect(names).toContain('get_preview');
    expect(names).toContain('quality_report');
    expect(names).toContain('antialias');
    expect(names).toContain('despeckle');
    expect(names).toContain('add_palette_ramp');
    expect(names).toContain('put_pixels');
    expect(names).toContain('banded_gradient');
    expect(names).toContain('noise_fill');
    expect(names).toContain('scatter');
    expect(names).toContain('finalize_document');
    expect(names).toContain('export_sheet');
    expect(names).toContain('read_skill');
    // 57 core commands plus the session/perception/export tools.
    expect(names.length).toBe(83);
  });

  it('exposes command descriptions and their own schemas', async () => {
    const { tools } = await client.listTools();
    const rect = tools.find((t) => t.name === 'draw_rect');
    expect(rect?.description).toBeTruthy();
    const schema = rect?.inputSchema as { properties?: Record<string, unknown> };
    expect(Object.keys(schema.properties ?? {})).toContain('rect');
    expect(Object.keys(schema.properties ?? {})).toContain('color');
    // The targeting arguments every generated tool gains.
    expect(Object.keys(schema.properties ?? {})).toContain('document');
    expect(Object.keys(schema.properties ?? {})).toContain('expectedVersion');
  });

  it('lists commands compactly by default and in full on request', async () => {
    const compact = (await client.callTool({ name: 'list_commands', arguments: {} })) as ToolResult;
    const body = payload(compact);
    expect(body.count).toBe(57);

    const entry = (body.commands as Array<Record<string, unknown>>).find((c) => c.name === 'draw_rect');
    expect(entry?.required).toContain('rect');
    expect((entry?.params as Record<string, string>).rect).toBe('object');
    expect(typeof (entry?.params as Record<string, string>).color).toBe('string');

    // This used to be ~188 kB of JSON Schema, which an agent had to script around.
    // It now also carries the hand-registered session tools (undo/redo/history,
    // perception, export, quality), the bulk/generative commands, and a richer
    // palette-ramp command. Keep the default response comfortably below the
    // previous full-schema scale while leaving room for their parameter hints.
    expect(JSON.stringify(body).length).toBeLessThan(30_000);

    const verbose = (await client.callTool({
      name: 'list_commands',
      arguments: { filter: 'draw_rect', verbose: true },
    })) as ToolResult;
    const full = (payload(verbose).commands as Array<{ params: Record<string, unknown> }>)[0];
    expect(full.params.type).toBe('object');
    expect(full.params.additionalProperties).toBe(false);
  });
});

describe('documents', () => {
  it('creates a document with a built-in palette and named layers', async () => {
    const result = (await client.callTool({
      name: 'create_document',
      arguments: { width: 16, height: 16, name: 'Slime', layers: ['base', 'shade'], palette: 'dawnbringer16' },
    })) as ToolResult;

    expect(result.isError).toBeFalsy();
    const body = payload(result);
    expect(body.ok).toBe(true);
    const doc = body.document as Record<string, unknown>;
    expect(doc.width).toBe(16);
    expect(doc.version).toBe(1);
    expect((body.palette as { size: number }).size).toBe(16);
    expect((body.layers as Array<{ name: string }>).map((l) => l.name)).toEqual(['base', 'shade']);
  });

  it('rejects an unknown palette with the list of valid names', async () => {
    const result = (await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, palette: 'not-a-palette' },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(payload(result).error).toMatch(/Unknown palette/);
    expect(payload(result).error).toMatch(/dawnbringer16/);
  });

  it('reports a clear error when no document is open', async () => {
    const result = (await client.callTool({ name: 'get_document', arguments: {} })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(payload(result).error).toMatch(/No active document/);
  });
});

describe('editing', () => {
  beforeEach(async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 16, height: 16, name: 'Test', layers: ['base'], palette: 'dawnbringer16' },
    });
  });

  it('runs a generated command and reports the new version', async () => {
    const result = (await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 2, y: 2, w: 6, h: 6 }, color: '#d04648', fill: true, layer: 'base' },
    })) as ToolResult;

    expect(result.isError).toBeFalsy();
    const body = payload(result);
    expect(body.ok).toBe(true);
    expect(body.command).toBe('draw_rect');
    expect(body.version).toBe(2);
    expect((body.summary as { painted: number }).painted).toBe(36);
  });

  it('surfaces invalid input as an isError result, not a throw', async () => {
    // The MCP SDK validates arguments against the advertised tool schema before the
    // handler runs, and reports the problem as a tool error result.
    const missing = (await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 0, w: 5, h: 5 } },
    })) as ToolResult;
    expect(missing.isError).toBe(true);
    expect(firstText(missing)).toMatch(/validation error/i);

    // Inside a batch the op params are validated by the command's own zod schema,
    // so a bad value comes back with our structured code.
    const bad = (await client.callTool({
      name: 'apply_ops',
      arguments: { ops: [{ command: 'draw_rect', rect: { x: 0, y: 0, w: 'nope', h: 5 }, color: '#fff' }] },
    })) as ToolResult;
    expect(payload(bad).failed).toBe(1);
    const results = payload(bad).results as { code: string }[];
    expect(results[0].code).toBe('invalid_params');
  });

  it('applies a batch and can roll it back atomically', async () => {
    const ok = (await client.callTool({
      name: 'apply_ops',
      arguments: {
        ops: [
          { command: 'draw_rect', params: { rect: { x: 0, y: 0, w: 4, h: 4 }, color: '#597dce', fill: true } },
          { command: 'outline', params: { color: '#140c1c', mode: 'inside' } },
          { command: 'add_tag', params: { name: 'idle', from: 0, to: 0 } },
        ],
      },
    })) as ToolResult;

    const body = payload(ok);
    expect(body.applied).toBe(3);
    expect(body.failed).toBe(0);
    expect(body.version).toBe(4);

    const before = payload(
      (await client.callTool({ name: 'measure_region', arguments: {} })) as ToolResult,
    ).summary as { opaque: number };

    const rolled = (await client.callTool({
      name: 'apply_ops',
      arguments: {
        atomic: true,
        ops: [
          { command: 'draw_rect', rect: { x: 8, y: 8, w: 2, h: 2 }, color: '#dad45e', fill: true },
          { command: 'this_command_does_not_exist' },
        ],
      },
    })) as ToolResult;

    const rolledBody = payload(rolled);
    expect(rolledBody.ok).toBe(false);
    expect(rolledBody.rolledBack).toBe(true);
    expect(rolledBody.applied).toBe(0);

    // The rollback restored the artwork. The version counter still moves forward,
    // because undo is itself an edit.
    const after = payload(
      (await client.callTool({ name: 'measure_region', arguments: {} })) as ToolResult,
    ).summary as { opaque: number };
    expect(after.opaque).toBe(before.opaque);
  });

  it('rejects a stale expectedVersion', async () => {
    const conflict = (await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 0, w: 1, h: 1 }, color: '#fff', expectedVersion: 99 },
    })) as ToolResult;
    expect(conflict.isError).toBe(true);
    expect(payload(conflict).code).toBe('version_conflict');

    const good = (await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 0, w: 1, h: 1 }, color: '#fff', expectedVersion: 1 },
    })) as ToolResult;
    expect(payload(good).ok).toBe(true);
  });

  it('rejects an unknown op parameter instead of silently ignoring it', async () => {
    const result = (await client.callTool({
      name: 'apply_ops',
      arguments: {
        ops: [{ command: 'draw_rect', rect: { x: 0, y: 0, w: 2, h: 2 }, color: '#fff', fill2: true }],
      },
    })) as ToolResult;
    const body = payload(result);

    // A typo used to fall back to the default and report success - the shape of
    // bug that turns `undo {count: 5}` into a single undo with `ok: true`.
    expect(body.ok).toBe(false);
    expect(body.failed).toBe(1);
    expect((body.failures as Array<{ code: string }>)[0].code).toBe('invalid_params');
  });

  it('rejects an unknown parameter on a hand-registered tool too', async () => {
    // The command tools get strictness from `defineCommand`. The hand-written
    // tools need it from `addTool`, so a mistyped parameter is an error rather
    // than a silent fallback to the default. (`undo` also accepts `count` as an
    // explicit alias for `steps`; `nope` is not a parameter at all.)
    const result = (await client.callTool({
      name: 'undo',
      arguments: { nope: 99 },
    })) as ToolResult;

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/validation error/i);
  });

  it('applies defaultLayer and defaultFrame to every op', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, name: 'Defaults', layers: ['base', 'shade'], frames: 2 },
    });
    const result = (await client.callTool({
      name: 'apply_ops',
      arguments: {
        defaultLayer: 'shade',
        defaultFrame: 1,
        quiet: true,
        ops: [
          { command: 'draw_rect', rect: { x: 0, y: 0, w: 2, h: 2 }, color: '#ff0000', fill: true },
          { command: 'draw_rect', rect: { x: 2, y: 2, w: 2, h: 2 }, color: '#00ff00', fill: true },
        ],
      },
    })) as ToolResult;
    const body = payload(result);
    expect(body.ok).toBe(true);
    expect(body.applied).toBe(2);
    // `quiet` drops the per-op results, which is the point of it.
    expect(body.results).toBeUndefined();

    const measured = (await client.callTool({
      name: 'measure_region',
      arguments: { layer: 'shade', frame: 1 },
    })) as ToolResult;
    expect((payload(measured).summary as { opaque: number }).opaque).toBe(8);
  });

  it('undoes and redoes', async () => {
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 0, w: 8, h: 8 }, color: '#346524', fill: true },
    });
    const undone = (await client.callTool({ name: 'undo', arguments: {} })) as ToolResult;
    expect(payload(undone).undone).toBe(1);

    const measure = (await client.callTool({
      name: 'measure_region',
      arguments: { rect: { x: 0, y: 0, w: 8, h: 8 } },
    })) as ToolResult;
    expect((payload(measure).summary as { opaque: number }).opaque).toBe(0);

    const redone = (await client.callTool({ name: 'redo', arguments: {} })) as ToolResult;
    expect(payload(redone).redone).toBe(1);
  });
});

describe('clip, scope and per-cel motion', () => {
  beforeEach(async () => {
    await client.callTool({
      name: 'create_document',
      arguments: {
        width: 16,
        height: 16,
        name: 'Motion',
        layers: ['base', 'shade'],
        palette: 'dawnbringer16',
      },
    });
  });

  it('keeps a shape inside the silhouette the other layers define', async () => {
    // A small body on `base`, then a much larger shape on `shade` that must be
    // clipped to it. Without `clip` the second call paints all 256 pixels.
    await client.callTool({
      name: 'draw_rect',
      arguments: { layer: 'base', rect: { x: 4, y: 4, w: 8, h: 8 }, color: '#346524', fill: true },
    });

    const clipped = (await client.callTool({
      name: 'draw_rect',
      arguments: {
        layer: 'shade',
        rect: { x: 0, y: 0, w: 16, h: 16 },
        color: '#d04648',
        fill: true,
        clip: 'composite',
      },
    })) as ToolResult;

    expect((payload(clipped).summary as { painted: number }).painted).toBe(64);

    const unclipped = (await client.callTool({
      name: 'draw_rect',
      arguments: {
        layer: 'shade',
        rect: { x: 0, y: 0, w: 16, h: 16 },
        color: '#d04648',
        fill: true,
        clip: 'none',
      },
    })) as ToolResult;
    expect((payload(unclipped).summary as { painted: number }).painted).toBe(256);
  });

  it('traces the composite onto a layer of its own', async () => {
    await client.callTool({
      name: 'draw_rect',
      arguments: { layer: 'base', rect: { x: 4, y: 4, w: 8, h: 8 }, color: '#346524', fill: true },
    });

    const result = (await client.callTool({
      name: 'outline',
      arguments: { layer: 'shade', color: '#000000', scope: 'composite' },
    })) as ToolResult;
    const summary = payload(result).summary as { painted: number; scope: string };
    expect(summary.scope).toBe('composite');
    expect(summary.painted).toBe(32);

    const measured = (await client.callTool({
      name: 'measure_region',
      arguments: { layer: 'base', scope: 'composite' },
    })) as ToolResult;
    const stats = payload(measured).summary as { opaque: number; bounds: unknown };
    expect(stats.opaque).toBe(96);
    expect(stats.bounds).toEqual({ x: 3, y: 3, w: 10, h: 10 });
  });

  it('accepts layer: "*" on translate and squash', async () => {
    await client.callTool({
      name: 'draw_rect',
      arguments: { layer: 'base', rect: { x: 4, y: 4, w: 4, h: 4 }, color: '#346524', fill: true },
    });
    await client.callTool({
      name: 'draw_pixels',
      arguments: { layer: 'shade', pixels: [{ x: 5, y: 5, color: '#d04648' }] },
    });

    // The `*` literal has to survive the tool-schema rewrite, or the whole point of
    // moving every layer together is unreachable from MCP.
    const moved = (await client.callTool({
      name: 'translate',
      arguments: { layer: '*', dx: 1, dy: 1 },
    })) as ToolResult;
    expect(moved.isError).toBeFalsy();
    expect((payload(moved).summary as { cels: number }).cels).toBe(2);

    const measured = (await client.callTool({
      name: 'measure_region',
      arguments: { layer: 'base' },
    })) as ToolResult;
    expect((payload(measured).summary as { bounds: unknown }).bounds).toEqual({
      x: 5,
      y: 5,
      w: 4,
      h: 4,
    });

    const squashed = (await client.callTool({
      name: 'squash',
      arguments: { layer: '*', scaleY: 0.5, pivot: 'bottom' },
    })) as ToolResult;
    expect(squashed.isError).toBeFalsy();
    expect((payload(squashed).summary as { cels: number }).cels).toBe(2);
  });
});

describe('agent-ergonomics additions', () => {
  beforeEach(async () => {
    await client.callTool({
      name: 'create_document',
      arguments: {
        width: 16,
        height: 16,
        name: 'Ergo',
        layers: ['base', 'hair', 'shade'],
        palette: 'dawnbringer16',
      },
    });
  });

  it('clips to a named layer over the wire', async () => {
    await client.callTool({
      name: 'draw_rect',
      arguments: { layer: 'hair', rect: { x: 2, y: 2, w: 4, h: 4 }, color: '#d04648', fill: true },
    });

    const result = (await client.callTool({
      name: 'draw_rect',
      arguments: {
        layer: 'shade',
        rect: { x: 0, y: 0, w: 16, h: 16 },
        color: '#346524',
        fill: true,
        clip: { layer: 'hair' },
      },
    })) as ToolResult;

    expect(result.isError).toBeFalsy();
    expect((payload(result).summary as { painted: number }).painted).toBe(16);
  });

  it('creates a palette-locked document and reports the flag', async () => {
    const created = (await client.callTool({
      name: 'create_document',
      arguments: {
        width: 8,
        height: 8,
        name: 'Locked',
        layers: ['base'],
        palette: ['#000000', '#ffffff'],
        paletteLocked: true,
      },
    })) as ToolResult;

    expect(created.isError).toBeFalsy();
    expect((payload(created) as { paletteLocked: boolean }).paletteLocked).toBe(true);
  });

  it('replaces the pixels a shape covers', async () => {
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 0, w: 8, h: 8 }, color: '#ff0000', fill: true },
    });

    const result = (await client.callTool({
      name: 'dither_fill',
      arguments: {
        rect: { x: 0, y: 0, w: 8, h: 8 },
        color: '#00ff00',
        pattern: 'checker',
        level: 0.5,
        replace: true,
      },
    })) as ToolResult;

    const summary = payload(result).summary as { painted: number; replaced: number };
    expect(summary.replaced).toBe(64);
    expect(summary.painted).toBe(32);
  });

  it('names the offending path in a validation error', async () => {
    const result = (await client.callTool({
      name: 'apply_ops',
      arguments: {
        ops: [
          {
            command: 'draw_pixels',
            pixels: [{ x: 0, y: 0, color: '#ffffff', extra: 1 }],
          },
        ],
      },
    })) as ToolResult;

    const failures = payload(result).failures as Array<{ error: string }>;
    expect(failures[0].error).toMatch(/Unrecognized key/);
  });
});

describe('follow-up ergonomics', () => {
  it('warns when a named clip is occluded by a higher layer', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 16, height: 16, name: 'Occlude', layers: ['base', 'hair', 'shade'] },
    });
    await client.callTool({
      name: 'draw_rect',
      arguments: { layer: 'shade', rect: { x: 2, y: 2, w: 4, h: 4 }, color: '#ffffff', fill: true },
    });

    const result = (await client.callTool({
      name: 'draw_rect',
      arguments: {
        layer: 'base',
        rect: { x: 0, y: 0, w: 16, h: 16 },
        color: '#000000',
        fill: true,
        clip: { layer: 'shade' },
      },
    })) as ToolResult;

    expect((payload(result).summary as { warning?: string }).warning).toMatch(/render above/);
  });

  it('reports counts under unambiguous names, keeping the layer array top-level', async () => {
    const created = (await client.callTool({
      name: 'create_document',
      arguments: { width: 16, height: 16, name: 'Counts', layers: ['base', 'shade'] },
    })) as ToolResult;
    const body = payload(created);
    const doc = body.document as Record<string, unknown>;

    expect(doc.layerCount).toBe(2);
    expect(doc.frameCount).toBe(1);
    expect(doc.tagCount).toBe(0);
    expect(doc.layers).toBeUndefined();
    expect((body.layers as Array<{ name: string }>).map((l) => l.name)).toEqual(['base', 'shade']);
  });

  it('does not steal focus when create_document is called with select:false', async () => {
    const first = (await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, name: 'Focused' },
    })) as ToolResult;
    const firstId = (payload(first).document as { id: string }).id;

    await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, name: 'Scratch', select: false },
    });

    const list = (await client.callTool({ name: 'list_documents', arguments: {} })) as ToolResult;
    expect(payload(list).activeDocument).toBe(firstId);
  });

  it('reports session focus separately from an explicit document read', async () => {
    const first = (await client.callTool({
      name: 'create_document',
      arguments: { width: 4, height: 4, name: 'Focused' },
    })) as ToolResult;
    const firstId = (payload(first).document as { id: string }).id;
    await client.callTool({
      name: 'create_document',
      arguments: { width: 4, height: 4, name: 'Scratch', select: false },
    });

    const explicit = (await client.callTool({
      name: 'get_document',
      arguments: { document: firstId },
    })) as ToolResult;
    const summary = payload(explicit).document as { active: boolean; activeDocumentId: string | null };
    expect(summary.active).toBe(true);
    expect(summary.activeDocumentId).toBe(firstId);
  });

  it('crops get_preview to a rect and upscales it', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 32, height: 32, name: 'Crop', layers: ['base'] },
    });

    const result = (await client.callTool({
      name: 'get_preview',
      arguments: { rect: { x: 0, y: 0, w: 8, h: 8 } },
    })) as ToolResult;
    const body = payload(result);

    expect(body.rect).toEqual({ x: 0, y: 0, w: 8, h: 8 });
    expect(body.imageWidth).toBeGreaterThanOrEqual(64);
    expect(body.imageWidth).toBe(body.imageHeight);
  });

  it('returns the absolute path alongside a written export', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, name: 'Abs', layers: ['base'] },
    });

    const out = join(tempDir, 'abs.png');
    const result = (await client.callTool({
      name: 'export_png',
      arguments: { out },
    })) as ToolResult;

    expect((payload(result).absolute as string[])[0]).toBe(out);
  });

  it('advertises undo, redo and get_history in list_commands sessionTools', async () => {
    const result = (await client.callTool({ name: 'list_commands', arguments: {} })) as ToolResult;
    const names = (payload(result).sessionTools as Array<{ name: string }>).map((t) => t.name);

    expect(names).toContain('undo');
    expect(names).toContain('redo');
    expect(names).toContain('get_history');
    expect(names).toContain('quality_report');
    expect(names).toContain('finalize_document');
  });
});

describe('perception', () => {
  it('returns the composited sprite as a real image block', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, layers: ['base'], palette: 'dawnbringer16' },
    });
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 0, w: 8, h: 8 }, color: '#d04648', fill: true, layer: 'base' },
    });

    const result = (await client.callTool({ name: 'get_preview', arguments: {} })) as ToolResult;
    const image = result.content.find((c) => c.type === 'image');
    expect(image?.mimeType).toBe('image/png');
    expect(image?.data && image.data.length).toBeGreaterThan(50);
    // A PNG signature in the decoded payload proves it is a real image.
    expect(Buffer.from(image!.data!, 'base64').subarray(0, 4).toString('hex')).toBe('89504e47');

    const body = payload(result);
    expect(body.imageWidth).toBe(128); // 8px upscaled 16x to reach the ~256px preview target
    expect(body.upscale).toBe(16);
  });

  it('reads exact pixels for a region', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, layers: ['base'] },
    });
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 1, y: 1, w: 2, h: 2 }, color: '#ff0000', fill: true, layer: 'base' },
    });

    const result = (await client.callTool({
      name: 'get_pixels',
      arguments: { rect: { x: 0, y: 0, w: 4, h: 3 } },
    })) as ToolResult;
    const rows = payload(result).rows as string[];
    expect(rows[0].split(' ')).toEqual(['..', '..', '..', '..']);
    expect(rows[1].split(' ')).toEqual(['..', 'ff0000', 'ff0000', '..']);
    expect(rows[2].split(' ')).toEqual(['..', 'ff0000', 'ff0000', '..']);
  });

  it('refuses an oversized pixel region', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 64, height: 64 } });
    const result = (await client.callTool({
      name: 'get_pixels',
      arguments: { rect: { x: 0, y: 0, w: 64, h: 64 } },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(payload(result).error).toMatch(/exceeds/);
  });
});

describe('quality and softness tools', () => {
  it('reports isolated noise and returns actionable warnings', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, name: 'Quality', layers: ['base'] },
    });
    await client.callTool({
      name: 'draw_rect',
      arguments: { layer: 'base', rect: { x: 0, y: 0, w: 8, h: 8 }, color: '#102040', fill: true },
    });
    await client.callTool({
      name: 'draw_pixels',
      arguments: { layer: 'base', pixels: [{ x: 4, y: 4, color: '#ffffff' }] },
    });

    const result = (await client.callTool({ name: 'quality_report', arguments: { grid: 2 } })) as ToolResult;
    const body = payload(result);
    expect(body.ok).toBe(true);
    expect((body.noise as { outliers: number }).outliers).toBeGreaterThan(0);
    expect(typeof body.softnessScore).toBe('number');
    expect((body.regions as unknown[]).length).toBe(4);
    const warnings = body.warnings as Array<{ code: string }>;
    expect(warnings.map((warning) => warning.code)).toContain('high_frequency_noise');
  });

  it('exposes antialias and despeckle as generated command tools', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, name: 'Soft', layers: ['base'] },
    });
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 2, y: 2, w: 4, h: 1 }, color: '#000000', fill: true },
    });
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 2, y: 3, w: 1, h: 4 }, color: '#000000', fill: true },
    });

    const aa = (await client.callTool({
      name: 'antialias',
      arguments: { mode: 'silhouette', amount: 0.5 },
    })) as ToolResult;
    expect(payload(aa).ok).toBe(true);
    expect((payload(aa).summary as { added: number }).added).toBeGreaterThan(0);

    const clean = (await client.callTool({
      name: 'despeckle',
      arguments: { mode: 'both' },
    })) as ToolResult;
    expect(payload(clean).ok).toBe(true);
  });

  it('generates and appends a hue-shifted palette ramp', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 4, height: 4, name: 'Ramp tool', palette: ['#101018', '#f0f0e0'] },
    });

    const result = (await client.callTool({
      name: 'add_palette_ramp',
      arguments: { from: '#241226', to: '#f2d2a0', steps: 5, hueShift: 30 },
    })) as ToolResult;
    const summary = payload(result).summary as { added: number; size: number; colors: string[] };
    expect(summary.added).toBe(5);
    expect(summary.colors).toHaveLength(5);
    expect(summary.size).toBe(7);

    const palette = (await client.callTool({ name: 'get_palette', arguments: {} })) as ToolResult;
    expect(payload(palette).size).toBe(7);
  });

  it('exposes base64 and deterministic generative primitives over MCP', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, name: 'Generative' },
    });
    const bulk = (await client.callTool({
      name: 'put_pixels',
      arguments: {
        rect: { x: 0, y: 0, w: 2, h: 1 },
        data: '/wAA/wD/AIA=',
      },
    })) as ToolResult;
    expect((payload(bulk).summary as { written: number }).written).toBe(2);

    const gradient = (await client.callTool({
      name: 'banded_gradient',
      arguments: { rect: { x: 0, y: 2, w: 8, h: 4 }, from: '#10182c', to: '#f0c16b', seed: 4 },
    })) as ToolResult;
    expect((payload(gradient).summary as { pixels: number }).pixels).toBe(32);

    const noise = (await client.callTool({
      name: 'noise_fill',
      arguments: { rect: { x: 0, y: 0, w: 4, h: 4 }, from: '#10182c', to: '#83b7b0', octaves: 4, seed: 4 },
    })) as ToolResult;
    expect((payload(noise).summary as { mode: string }).mode).toBe('fbm');

    const scatter = (await client.callTool({
      name: 'scatter',
      arguments: { rect: { x: 4, y: 4, w: 4, h: 4 }, count: 4, colors: ['#fff2c7'], seed: 4 },
    })) as ToolResult;
    expect((payload(scatter).summary as { points: number }).points).toBe(4);
  });
});

describe('resources and prompts', () => {
  it('serves the craft guide and the command catalogue', async () => {
    const skill = await client.readResource({ uri: 'pixel://skill' });
    const skillText = (skill.contents[0] as { text: string }).text;
    expect(skillText).toMatch(/silhouette/i);
    expect(skillText).toMatch(/dither/i);

    const commands = await client.readResource({ uri: 'pixel://commands' });
    const catalog = JSON.parse((commands.contents[0] as { text: string }).text);
    expect(catalog.commands.length).toBeGreaterThanOrEqual(35);
  });

  it('lists documents and serves a preview blob', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 4, height: 4, layers: ['base'] },
    });

    const list = await client.readResource({ uri: 'pixel://documents' });
    const listed = JSON.parse((list.contents[0] as { text: string }).text);
    const id = listed.documents[0].id as string;
    expect(listed.activeDocument).toBe(id);

    const preview = await client.readResource({ uri: `pixel://documents/${id}/preview` });
    const blob = preview.contents[0] as { mimeType: string; blob: string };
    expect(blob.mimeType).toBe('image/png');
    expect(Buffer.from(blob.blob, 'base64').subarray(0, 4).toString('hex')).toBe('89504e47');
  });

  it('serves the drawing prompt with the requested subject', async () => {
    const prompt = await client.getPrompt({
      name: 'draw_sprite',
      arguments: { subject: 'a small green slime', width: '16', height: '16' },
    });
    const text = (prompt.messages[0].content as { text: string }).text;
    expect(text).toMatch(/a small green slime/);
    expect(text).toMatch(/16x16/);
    expect(text).toMatch(/create_document/);
  });
});

describe('export', () => {
  it('writes a PNG and a spritesheet with Aseprite JSON', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, name: 'Gem', layers: ['base'], frames: 2, palette: 'endesga16' },
    });
    await client.callTool({
      name: 'apply_ops',
      arguments: {
        ops: [
          { command: 'draw_rect', rect: { x: 0, y: 0, w: 4, h: 4 }, color: '#2ce8f4', fill: true, frame: 0 },
          { command: 'draw_rect', rect: { x: 4, y: 4, w: 4, h: 4 }, color: '#0484d1', fill: true, frame: 1 },
          { command: 'add_tag', name: 'spin', from: 0, to: 1 },
        ],
      },
    });

    const png = join(tempDir, 'gem.png');
    const exported = (await client.callTool({
      name: 'export_png',
      arguments: { out: png, frames: 'all' },
    })) as ToolResult;
    const files = payload(exported).files as string[];
    expect(files).toHaveLength(2);
    expect(readFileSync(files[0]).subarray(0, 4).toString('hex')).toBe('89504e47');

    const sheet = join(tempDir, 'gem-sheet.png');
    const sheetResult = (await client.callTool({
      name: 'export_sheet',
      arguments: { out: sheet, layout: 'grid', columns: 2, padding: 1 },
    })) as ToolResult;
    const sheetBody = payload(sheetResult);
    expect(sheetBody.frames).toBe(2);
    expect(sheetBody.columns).toBe(2);

    const json = JSON.parse(readFileSync(sheetBody.json as string, 'utf8'));
    expect(json.meta.image).toBe('gem-sheet.png');
    expect(json.frames['Gem 0.png']).toBeTruthy();
    expect(json.meta.frameTags[0].name).toBe('spin');
  });

  it('keeps the spritesheet JSON consistent with the scaled PNG', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, name: 'Scale', layers: ['base'], frames: 2 },
    });
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 0, w: 4, h: 4 }, color: '#ff0000', fill: true },
    });

    const sheet = join(tempDir, 'scaled-sheet.png');
    const result = (await client.callTool({
      name: 'export_sheet',
      arguments: { out: sheet, layout: 'horizontal', scale: 3 },
    })) as ToolResult;
    const body = payload(result);

    // The JSON must describe the PNG that was actually written, or an engine
    // slicing the sheet reads the wrong geometry and grabs a corner of each frame.
    const size = pngSize(sheet);
    expect(body.width).toBe(size.width);
    expect(body.height).toBe(size.height);

    const json = JSON.parse(readFileSync(body.json as string, 'utf8'));
    expect(json.meta.size).toEqual({ w: size.width, h: size.height });
    expect(json.frames['Scale 0.png'].frame).toEqual({ x: 0, y: 0, w: 24, h: 24 });
    expect(json.frames['Scale 1.png'].frame).toEqual({ x: 24, y: 0, w: 24, h: 24 });
  });

  it('round-trips a document through save and open', async () => {    await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, name: 'Round', layers: ['base', 'shade'] },
    });
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 1, y: 1, w: 3, h: 3 }, color: '#ffccaa', fill: true, layer: 'shade' },
    });

    const path = join(tempDir, 'round.pixel');
    const saved = (await client.callTool({ name: 'save_document', arguments: { path } })) as ToolResult;
    expect(payload(saved).ok).toBe(true);

    const opened = (await client.callTool({ name: 'open_document', arguments: { path } })) as ToolResult;
    const openedBody = payload(opened);
    expect(openedBody.ok).toBe(true);
    const openedId = (openedBody.document as { id: string }).id;

    const doc = (await client.callTool({ name: 'get_document', arguments: { document: openedId } })) as ToolResult;
    const detail = payload(doc);
    expect((detail.layers as Array<{ name: string }>).map((l) => l.name)).toEqual(['base', 'shade']);
    expect((detail.palette as { size: number }).size).toBeGreaterThan(0);
  });

  it('saves the source and writes multiple PNG exports in one finalisation call', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, name: 'Fast finish', layers: ['base', 'light'] },
    });
    await client.callTool({
      name: 'draw_rect',
      arguments: { layer: 'base', rect: { x: 0, y: 0, w: 8, h: 8 }, color: '#2255aa', fill: true },
    });
    await client.callTool({
      name: 'draw_rect',
      arguments: { layer: 'light', rect: { x: 2, y: 2, w: 4, h: 4 }, color: '#ffcc66', fill: true },
    });

    const source = join(tempDir, 'fast-finish.pixel');
    const original = join(tempDir, 'fast-finish.png');
    const preview = join(tempDir, 'fast-finish-preview.png');
    const result = (await client.callTool({
      name: 'finalize_document',
      arguments: {
        path: source,
        exports: [
          { path: original, scale: 1 },
          { path: preview, scale: 4 },
        ],
      },
    })) as ToolResult;

    const body = payload(result);
    expect(body.ok).toBe(true);
    expect(body.files).toEqual([source, original, preview]);
    expect(readFileSync(source).subarray(0, 2).toString('hex')).toBe('504b');
    expect(pngSize(original)).toEqual({ width: 8, height: 8 });
    expect(pngSize(preview)).toEqual({ width: 32, height: 32 });
    expect((body.exports as Array<{ width: number; height: number }>).map(({ width, height }) => ({ width, height }))).toEqual([
      { width: 8, height: 8 },
      { width: 32, height: 32 },
    ]);
    expect((body.document as { dirty: boolean }).dirty).toBe(false);
  });
});

describe('iteration ergonomics', () => {
  it('keeps going after a bad op and says how many it skipped', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, name: 'Batch', layers: ['base'] },
    });

    // The middle op names a parameter that does not exist. The old default was to
    // stop there, which silently dropped everything after it - an agent would only
    // notice from the preview, and would have no idea why.
    const result = (await client.callTool({
      name: 'apply_ops',
      arguments: {
        ops: [
          { command: 'draw_rect', rect: { x: 0, y: 0, w: 2, h: 2 }, color: '#ff0000', fill: true },
          { command: 'draw_rect', rect: { x: 2, y: 2, w: 2, h: 2 }, color: '#00ff00', fill: true, fill2: true },
          { command: 'draw_rect', rect: { x: 4, y: 4, w: 2, h: 2 }, color: '#0000ff', fill: true },
        ],
      },
    })) as ToolResult;

    const body = payload(result);
    expect(body.ok).toBe(false);
    expect(body.applied).toBe(2);
    expect(body.failed).toBe(1);
    expect(body.skipped).toBe(0);

    // The last op really did run.
    const measured = (await client.callTool({
      name: 'measure_region',
      arguments: { layer: 'base', frame: 0 },
    })) as ToolResult;
    expect((payload(measured).summary as { opaque: number }).opaque).toBe(8);
  });

  it('reports the skipped tail when stopOnError is set', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, name: 'Halt', layers: ['base'] },
    });

    const result = (await client.callTool({
      name: 'apply_ops',
      arguments: {
        stopOnError: true,
        ops: [
          { command: 'draw_rect', rect: { x: 0, y: 0, w: 2, h: 2 }, color: '#ff0000', fill: true },
          { command: 'nope_not_a_command', rect: { x: 0, y: 0, w: 1, h: 1 }, color: '#fff' },
          { command: 'draw_rect', rect: { x: 4, y: 4, w: 2, h: 2 }, color: '#0000ff', fill: true },
        ],
      },
    })) as ToolResult;

    const body = payload(result);
    expect(body.applied).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.skipped).toBe(1);
  });

  it('truncates a huge validation error instead of dumping it', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, name: 'Noisy', layers: ['base'] },
    });

    // A zod union error for a `draw_pixels` op with the wrong shape runs to several
    // kilobytes of nested alternatives.
    const result = (await client.callTool({
      name: 'apply_ops',
      arguments: {
        ops: [
          {
            command: 'draw_pixels',
            pixels: [
              { x: 0, y: 0, color: '#fff', extra: 1 },
              { x: 1, y: 1, color: '#fff', extra: 2 },
            ],
          },
        ],
      },
    })) as ToolResult;

    const body = payload(result);
    expect(body.failed).toBe(1);
    const failures = body.failures as Array<{ error: string }>;
    expect(failures[0].error.length).toBeLessThanOrEqual(320);
  });

  it('accepts `path` as an alias for `out` on exports', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, name: 'Alias', layers: ['base'] },
    });
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 0, w: 4, h: 4 }, color: '#ff0000', fill: true },
    });

    const target = join(tempDir, 'alias.png');
    const result = (await client.callTool({
      name: 'export_png',
      arguments: { path: target },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(readFileSync(target).subarray(0, 4).toString('hex')).toBe('89504e47');
  });
});

describe('layered and onion previews', () => {
  it('renders only the requested layers', async () => {
    const created = (await client.callTool({
      name: 'create_document',
      arguments: { width: 4, height: 4, layers: ['base', 'ink'] },
    })) as ToolResult;
    const id = (payload(created).document as { id: string }).id;
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 0, w: 4, h: 4 }, color: '#ff0000', fill: true, layer: 'base' },
    });
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 0, w: 4, h: 4 }, color: '#00ff00', fill: true, layer: 'ink' },
    });

    const detail = (await client.callTool({ name: 'get_document', arguments: { document: id } })) as ToolResult;
    const base = (payload(detail).layers as Array<{ id: string }>)[0].id;
    const result = (await client.callTool({
      name: 'get_preview',
      arguments: { layers: [base], scale: 1 },
    })) as ToolResult;

    // Isolating the bottom layer hides the green ink on top of it.
    expect(decodedImage(result).getColor(0, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(payload(result).layers).toEqual([base]);
  });

  it('ghosts neighbouring frames when onion skinning is requested', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 4, height: 4, layers: ['base'], frames: 3 },
    });
    await client.callTool({ name: 'draw_rect', arguments: { rect: { x: 0, y: 0, w: 1, h: 1 }, color: '#ff0000', fill: true, frame: 0 } });
    await client.callTool({ name: 'draw_rect', arguments: { rect: { x: 1, y: 1, w: 1, h: 1 }, color: '#00ff00', fill: true, frame: 1 } });
    await client.callTool({ name: 'draw_rect', arguments: { rect: { x: 2, y: 2, w: 1, h: 1 }, color: '#0000ff', fill: true, frame: 2 } });

    const result = (await client.callTool({
      name: 'get_preview',
      arguments: { frame: 1, onion: { before: 1, after: 1, opacity: 0.5 }, scale: 1 },
    })) as ToolResult;
    const buf = decodedImage(result);

    // The current pose stays crisp while its neighbours show through as ghosts.
    expect(buf.getColor(1, 1)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    const past = buf.getColor(0, 0);
    expect(past.r).toBe(255);
    expect(past.a).toBeGreaterThan(0);
    expect(past.a).toBeLessThan(255);
    const future = buf.getColor(2, 2);
    expect(future.b).toBe(255);
    expect(future.a).toBeGreaterThan(0);
    expect(future.a).toBeLessThan(255);
  });
});

describe('apply_ops preview', () => {
  it('returns the resulting frame as an image when asked', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 8, height: 8, layers: ['base'] } });
    const result = (await client.callTool({
      name: 'apply_ops',
      arguments: {
        ops: [{ command: 'draw_rect', rect: { x: 0, y: 0, w: 8, h: 8 }, color: '#ff0000', fill: true }],
        preview: true,
      },
    })) as ToolResult;

    const image = result.content.find((c) => c.type === 'image');
    expect(image?.mimeType).toBe('image/png');
    expect(Buffer.from(image!.data!, 'base64').subarray(0, 4).toString('hex')).toBe('89504e47');
    const body = payload(result);
    expect(body.ok).toBe(true);
    expect(body.preview).toBeTruthy();
  });

  it('uses previewOptions to return the requested post-batch frame, crop and scale', async () => {
    const created = (await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, layers: ['base'], frames: 2 },
    })) as ToolResult;
    const id = (payload(created).document as { id: string }).id;
    const result = (await client.callTool({
      name: 'apply_ops',
      arguments: {
        document: id,
        ops: [
          { command: 'draw_rect', layer: 'base', frame: 0, rect: { x: 0, y: 0, w: 2, h: 2 }, color: '#ff0000', fill: true },
          { command: 'draw_rect', layer: 'base', frame: 1, rect: { x: 4, y: 4, w: 4, h: 4 }, color: '#00ff00', fill: true },
        ],
        preview: true,
        previewOptions: { frame: 1, rect: { x: 4, y: 4, w: 4, h: 4 }, scale: 2 },
      },
    })) as ToolResult;

    const body = payload(result);
    const image = decodedImage(result);
    expect(body.preview).toMatchObject({ frame: 1, rect: { x: 4, y: 4, w: 4, h: 4 }, scale: 2, imageWidth: 8, imageHeight: 8 });
    expect(image.width).toBe(8);
    expect(image.height).toBe(8);
    expect(image.getColor(0, 0)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
  });

  it('rejects previewOptions without preview before running any op', async () => {
    const created = (await client.callTool({
      name: 'create_document',
      arguments: { width: 4, height: 4, layers: ['base'] },
    })) as ToolResult;
    const id = (payload(created).document as { id: string }).id;
    const result = (await client.callTool({
      name: 'apply_ops',
      arguments: {
        document: id,
        ops: [{ command: 'draw_rect', rect: { x: 0, y: 0, w: 1, h: 1 }, color: '#ff0000', fill: true }],
        previewOptions: { scale: 2 },
      },
    })) as ToolResult;

    expect(result.isError).toBe(true);
    expect(payload(result).error).toContain('requires `preview: true`');
    const measured = (await client.callTool({
      name: 'measure_region',
      arguments: { document: id, layer: 'base', frame: 0 },
    })) as ToolResult;
    expect((payload(measured).summary as { opaque: number }).opaque).toBe(0);
  });

  it('stays text-only by default', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 8, height: 8, layers: ['base'] } });
    const result = (await client.callTool({
      name: 'apply_ops',
      arguments: { ops: [{ command: 'draw_rect', rect: { x: 0, y: 0, w: 2, h: 2 }, color: '#00ff00', fill: true }] },
    })) as ToolResult;
    expect(result.content.some((c) => c.type === 'image')).toBe(false);
  });
});

describe('preview resource query params', () => {
  it('isolates a layer named in the query string', async () => {
    const created = (await client.callTool({
      name: 'create_document',
      arguments: { width: 4, height: 4, layers: ['base', 'ink'] },
    })) as ToolResult;
    const id = (payload(created).document as { id: string }).id;
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 0, w: 4, h: 4 }, color: '#ff0000', fill: true, layer: 'base' },
    });
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 0, w: 4, h: 4 }, color: '#00ff00', fill: true, layer: 'ink' },
    });

    const detail = (await client.callTool({ name: 'get_document', arguments: { document: id } })) as ToolResult;
    const base = (payload(detail).layers as Array<{ id: string }>)[0].id;

    const preview = await client.readResource({
      uri: `pixel://documents/${id}/preview?layers=${base}&scale=1`,
    });
    const buf = decodePNG(Buffer.from((preview.contents[0] as { blob: string }).blob, 'base64'));
    expect(buf.getColor(0, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
  });

  it('ghosts neighbours when onion is set', async () => {
    const created = (await client.callTool({
      name: 'create_document',
      arguments: { width: 4, height: 4, layers: ['base'], frames: 3 },
    })) as ToolResult;
    const id = (payload(created).document as { id: string }).id;
    await client.callTool({ name: 'draw_rect', arguments: { rect: { x: 0, y: 0, w: 1, h: 1 }, color: '#ff0000', fill: true, frame: 0 } });
    await client.callTool({ name: 'draw_rect', arguments: { rect: { x: 1, y: 1, w: 1, h: 1 }, color: '#00ff00', fill: true, frame: 1 } });

    const preview = await client.readResource({ uri: `pixel://documents/${id}/preview?frame=1&onion=1&scale=1` });
    const buf = decodePNG(Buffer.from((preview.contents[0] as { blob: string }).blob, 'base64'));
    expect(buf.getColor(1, 1)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    const ghost = buf.getColor(0, 0);
    expect(ghost.r).toBe(255);
    expect(ghost.a).toBeGreaterThan(0);
    expect(ghost.a).toBeLessThan(255);
  });

  it('crops to a rect named in the query string', async () => {
    const created = (await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, layers: ['base'] },
    })) as ToolResult;
    const id = (payload(created).document as { id: string }).id;

    const preview = await client.readResource({ uri: `pixel://documents/${id}/preview?rect=2,2,4,4&scale=1` });
    const buf = decodePNG(Buffer.from((preview.contents[0] as { blob: string }).blob, 'base64'));
    expect({ width: buf.width, height: buf.height }).toEqual({ width: 4, height: 4 });
  });
});

describe('scripting and plugins', () => {
  async function makeDoc(width = 4, height = 4): Promise<string> {
    const created = (await client.callTool({
      name: 'create_document',
      arguments: { width, height, layers: ['base'] },
    })) as ToolResult;
    return (payload(created).document as { id: string }).id;
  }

  it('runs a script, returns its result and logs, and folds it into one undo step', async () => {
    const id = await makeDoc();
    const run = (await client.callTool({
      name: 'run_script',
      arguments: {
        document: id,
        source: `
          const base = layers()[0].id;
          exec('draw_pixels', { layer: base, frame: 0, pixels: [{ x: 0, y: 0, color: '#ff0000' }] });
          exec('draw_pixels', { layer: base, frame: 0, pixels: [{ x: 1, y: 0, color: '#00ff00' }] });
          log('drew', 2, 'pixels');
          return { width: document().width };
        `,
      },
    })) as ToolResult;

    const body = payload(run);
    expect(body.ok).toBe(true);
    expect(body.result).toEqual({ width: 4 });
    expect(JSON.stringify(body.logs)).toContain('drew');

    // Both edits vanish with a single undo.
    await client.callTool({ name: 'undo', arguments: { document: id } });
    const preview = await client.readResource({ uri: `pixel://documents/${id}/preview?scale=1` });
    const buf = decodePNG(Buffer.from((preview.contents[0] as { blob: string }).blob, 'base64'));
    expect(buf.getColor(0, 0).a).toBe(0);
    expect(buf.getColor(1, 0).a).toBe(0);
  });

  it('returns the edited document as a configured inline preview', async () => {
    const id = await makeDoc();
    const run = (await client.callTool({
      name: 'run_script',
      arguments: {
        document: id,
        source: `
          const base = layers()[0].id;
          exec('draw_rect', { layer: base, frame: 0, rect: { x: 0, y: 0, w: 2, h: 2 }, color: '#ff0000', fill: true });
          return 7;
        `,
        preview: true,
        previewOptions: { scale: 3 },
      },
    })) as ToolResult;

    const body = payload(run);
    const image = decodedImage(run);
    expect(body.result).toBe(7);
    expect(body.preview).toMatchObject({ scale: 3, imageWidth: 12, imageHeight: 12 });
    expect(image.getColor(0, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(image.getColor(9, 9).a).toBe(0);
  });

  it('honours expectedVersion before running a script', async () => {
    const id = await makeDoc();
    const result = (await client.callTool({
      name: 'run_script',
      arguments: {
        document: id,
        expectedVersion: 99,
        source: `exec('draw_rect', { layer: layers()[0].id, frame: 0, rect: { x: 0, y: 0, w: 1, h: 1 }, color: '#ff0000', fill: true });`,
      },
    })) as ToolResult;

    expect(result.isError).toBe(true);
    expect(payload(result).code).toBe('version_conflict');
    const measured = (await client.callTool({
      name: 'measure_region',
      arguments: { document: id, layer: 'base', frame: 0 },
    })) as ToolResult;
    expect((payload(measured).summary as { opaque: number }).opaque).toBe(0);
  });

  it('reports a post-script preview error without hiding the committed edit', async () => {
    const created = (await client.callTool({
      name: 'create_document',
      arguments: { width: 4, height: 4, layers: ['base'], frames: 2 },
    })) as ToolResult;
    const id = (payload(created).document as { id: string }).id;
    const run = (await client.callTool({
      name: 'run_script',
      arguments: {
        document: id,
        source: `exec('remove_frame', { frame: 1 }); return 'removed';`,
        preview: true,
        previewOptions: { frame: 1 },
      },
    })) as ToolResult;

    const body = payload(run);
    expect(body.ok).toBe(false);
    expect(body.editCommitted).toBe(true);
    expect(String(body.previewError)).toMatch(/frame/i);
    expect(run.content.some((content) => content.type === 'image')).toBe(false);
    const detail = (await client.callTool({
      name: 'get_document',
      arguments: { document: id },
    })) as ToolResult;
    expect((payload(detail).document as { frameCount: number }).frameCount).toBe(1);
  });

  it('reports a script failure with its logs', async () => {
    const id = await makeDoc();
    const run = (await client.callTool({
      name: 'run_script',
      arguments: { document: id, source: 'log("before"); throw new Error("boom");' },
    })) as ToolResult;
    expect(run.isError).toBe(true);
    expect(String(payload(run).error)).toContain('boom');
    expect(JSON.stringify(payload(run).logs)).toContain('before');
  });

  it('loads a plugin whose command becomes a real tool', async () => {
    const id = await makeDoc();
    const plugin = `
      defineCommand({
        name: 'test_border',
        description: 'Draw a one-pixel border around the canvas.',
        params: { color: { type: 'color', required: true } },
        run(api, { color }) {
          const doc = api.document();
          api.exec('draw_rect', {
            layer: doc.layers[0].id,
            frame: 0,
            rect: { x: 0, y: 0, w: doc.width, h: doc.height },
            color,
            fill: false,
          });
          return { frames: doc.frames.length };
        },
      });
    `;

    const load = (await client.callTool({
      name: 'load_plugin',
      arguments: { source: plugin, name: 'test' },
    })) as ToolResult;
    expect(payload(load).commands).toEqual(['test_border']);

    // It shows up in the catalogue...
    const listed = (await client.callTool({ name: 'list_commands', arguments: {} })) as ToolResult;
    expect((payload(listed).commands as Array<{ name: string }>).map((c) => c.name)).toContain('test_border');

    // ...as a real tool...
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('test_border');

    // ...and is callable, running against the caller's document.
    const called = (await client.callTool({
      name: 'test_border',
      arguments: { document: id, color: '#ff0000' },
    })) as ToolResult;
    expect(payload(called).ok).toBe(true);

    // Its params are validated like any other command.
    const bad = (await client.callTool({ name: 'test_border', arguments: { document: id } })) as ToolResult;
    expect(bad.isError).toBe(true);

    const plugins = (await client.callTool({ name: 'list_plugins', arguments: {} })) as ToolResult;
    expect(payload(plugins).plugins).toContainEqual({ name: 'test', commands: ['test_border'] });
  });

  it('serves the scripting guide as a resource', async () => {
    const guide = await client.readResource({ uri: 'pixel://script-guide' });
    expect((guide.contents[0] as { text: string }).text).toContain('run_script');
  });
});

describe('third-round ergonomics', () => {
  it('selects a document by name as well as id', async () => {
    const first = (await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, name: 'Byid' },
    })) as ToolResult;
    const firstId = (payload(first).document as { id: string }).id;
    await client.callTool({ name: 'create_document', arguments: { width: 8, height: 8, name: 'Byname' } });

    const result = (await client.callTool({
      name: 'select_document',
      arguments: { document: 'Byid' },
    })) as ToolResult;

    expect(result.isError).toBeFalsy();
    expect((payload(result).document as { id: string }).id).toBe(firstId);
  });

  it('accepts count as an alias for undo/redo steps', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 8, height: 8, name: 'Steps' } });
    for (let i = 0; i < 3; i++) {
      await client.callTool({
        name: 'draw_rect',
        arguments: { layer: 0, rect: { x: i, y: 0, w: 1, h: 1 }, color: '#ff0000', fill: true },
      });
    }

    const undone = (await client.callTool({ name: 'undo', arguments: { count: 3 } })) as ToolResult;
    expect(payload(undone).undone).toBe(3);
    const redone = (await client.callTool({ name: 'redo', arguments: { count: 3 } })) as ToolResult;
    expect(payload(redone).redone).toBe(3);
  });

  it('reports the preview scale under both names', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 32, height: 32, name: 'Scale' } });
    const result = (await client.callTool({ name: 'get_preview', arguments: { scale: 4 } })) as ToolResult;
    const body = payload(result);
    expect(body.scale).toBe(4);
    expect(body.upscale).toBe(4);
  });
});
