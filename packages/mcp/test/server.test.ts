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
    expect(names).toContain('ridge_line');
    expect(names).toContain('scatter');
    expect(names).toContain('finalize_document');
    expect(names).toContain('preview_animation');
    expect(names).toContain('preview_pose');
    expect(names).toContain('create_sprite_spec');
    expect(names).toContain('create_rig');
    expect(names).toContain('bake_pose');
    expect(names).toContain('transform_cel');
    expect(names).toContain('transform_part');
    expect(names).toContain('replace_colors');
    expect(names).toContain('ensure_palette_role');
    expect(names).toContain('describe_command');
    expect(names).toContain('find_workflow');
    expect(names).toContain('set_frame_durations');
    expect(names).toContain('upsert_tags');
    expect(names).toContain('prune_palette');
    expect(names).toContain('export_sheet');
    expect(names).toContain('read_skill');
    // Generated core commands plus session/perception/export tools; plugins and
    // follow-up tools may add more without changing this baseline.
    expect(names.length).toBeGreaterThanOrEqual(83);
  });

  it('exposes command descriptions and their own schemas', async () => {
    const { tools } = await client.listTools();
    const rect = tools.find((t) => t.name === 'draw_rect');
    expect(rect?.description).toBeTruthy();
    const schema = rect?.inputSchema as { properties?: Record<string, unknown> };
    expect(Object.keys(schema.properties ?? {})).toContain('rect');
    expect(Object.keys(schema.properties ?? {})).toContain('color');
    // `document` and `expectedVersion` are deliberately *not* advertised: they are
    // optional on every tool, so restating them 127 times cost 9.4K tokens to say
    // "operate on the active document". They are still accepted, and the server
    // instructions are where they are documented. tool-surface.test.ts asserts both
    // halves of that contract.
    expect(Object.keys(schema.properties ?? {})).not.toContain('document');
    expect(Object.keys(schema.properties ?? {})).not.toContain('expectedVersion');
    // And a command now says what it costs, and where its manual is.
    expect(rect?.description).toContain('Undoable as one step');
    expect(rect?.outputSchema).toBeTruthy();
  });

  it('lists commands compactly by default and in full on request', async () => {
    const compact = (await client.callTool({ name: 'list_commands', arguments: {} })) as ToolResult;
    const body = payload(compact);
    // Baseline plus the landscape primitives: draw_polyline, ridge_line, mirror and shade_band.
    expect(body.count).toBe(
      (body.commands as unknown[]).length,
    );
    expect((body.commands as Array<{ name: string }>).map((c) => c.name)).toEqual(
      expect.arrayContaining(['draw_polyline', 'mirror', 'shade_band']),
    );

    const entry = (body.commands as Array<Record<string, unknown>>).find((c) => c.name === 'draw_rect');
    expect(entry?.required).toContain('rect');
    expect((entry?.params as Record<string, string>).rect).toBe('object');
    expect(typeof (entry?.params as Record<string, string>).color).toBe('string');

    // This used to be ~188 kB of JSON Schema, which an agent had to script around.
    // It now also carries the hand-registered session tools (undo/redo/history,
    // perception, export, quality), the bulk/generative commands, a richer
    // palette-ramp command and the landscape primitives. The guard is relative, not an
    // absolute byte count: the point is that the compact form stays orders of magnitude
    // below the full-schema response asserted below, so adding commands with good
    // `.describe()` text does not require editing a magic number every time.
    const compactBytes = JSON.stringify(body).length;
    const verboseResponse = await client.callTool({ name: 'list_commands', arguments: { verbose: true } });
    const verboseBytes = JSON.stringify(payload(verboseResponse as ToolResult)).length;
    expect(compactBytes).toBeLessThan(verboseBytes / 2);

    const verbose = (await client.callTool({
      name: 'list_commands',
      arguments: { filter: 'draw_rect', verbose: true },
    })) as ToolResult;
    const full = (payload(verbose).commands as Array<{ params: Record<string, unknown> }>)[0];
    expect(full.params.type).toBe('object');
    expect(full.params.additionalProperties).toBe(false);
  });

  it('supports exact command lookup, parameter search and read-only metadata', async () => {
    const exact = payload((await client.callTool({
      name: 'list_commands',
      arguments: { name: 'draw_rect' },
    })) as ToolResult);
    expect(exact.count).toBe(1);
    expect((exact.commands as Array<{ name: string; readOnly: boolean }>)[0]).toMatchObject({
      name: 'draw_rect',
      readOnly: false,
    });

    const byParam = payload((await client.callTool({
      name: 'list_commands',
      arguments: { param: 'hueShift' },
    })) as ToolResult);
    expect((byParam.commands as Array<{ name: string }>).map((command) => command.name)).toEqual(
      expect.arrayContaining(['add_palette_ramp', 'banded_gradient', 'noise_fill']),
    );

    const readOnly = payload((await client.callTool({
      name: 'list_commands',
      arguments: { name: 'measure_region' },
    })) as ToolResult);
    expect((readOnly.commands as Array<{ readOnly: boolean }>)[0].readOnly).toBe(true);

    const session = payload((await client.callTool({
      name: 'list_commands',
      arguments: { name: 'get_preview' },
    })) as ToolResult);
    expect(session.count).toBe(0);
    expect((session.sessionTools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(['get_preview']);

    const limited = payload((await client.callTool({
      name: 'list_commands',
      arguments: { filter: 'draw', limit: 2 },
    })) as ToolResult);
    expect(limited.count).toBe(2);
    expect(limited.totalMatched).toBeGreaterThan(2);
    expect(limited.truncated).toBe(true);

    const allSessions = payload((await client.callTool({ name: 'list_commands', arguments: {} })) as ToolResult);
    expect((allSessions.sessionTools as Array<{ name: string }>).map((tool) => tool.name)).toContain('apply_ops');
  });

  it('describes one command exactly and finds task-level workflows', async () => {
    const described = payload((await client.callTool({
      name: 'describe_command',
      arguments: { name: 'bake_pose' },
    })) as ToolResult);
    expect((described.command as { name: string; readOnly: boolean }).name).toBe('bake_pose');
    expect((described.command as { readOnly: boolean }).readOnly).toBe(false);

    const workflow = payload((await client.callTool({
      name: 'find_workflow',
      arguments: { goal: 'create a character attack animation and export it' },
    })) as ToolResult);
    expect((workflow.workflows as Array<{ id: string }>)[0].id).toBe('character-animation');
  });

  it('documents the landscape primitives well enough to call without reading the source', async () => {
    const body = payload((await client.callTool({ name: 'list_commands', arguments: {} })) as ToolResult);
    const commands = body.commands as Array<{ name: string; description: string; params: Record<string, string> }>;

    // The three primitives that replaced hand-rolled helpers during landscape work.
    // The `?` suffix is how `list_commands` marks an optional parameter, so `points`
    // being optional is correct here: `shade_band` accepts `points` *or* `top`.
    const shadeBand = commands.find((c) => c.name === 'shade_band');
    expect(shadeBand?.description).toMatch(/follows a silhouette/i);
    expect(shadeBand?.params.points).toBe('object[]?');
    expect(shadeBand?.params.thickness).toBe('integer?');

    const mirror = commands.find((c) => c.name === 'mirror');
    expect(mirror?.description).toMatch(/waterline|arbitrary line|compression|wobble/i);
    // `about` is the whole point: without it this is just `flip`.
    expect(mirror?.params.about).toBe('integer?');
    expect(mirror?.params.compress).toBeDefined();
    expect(mirror?.params.wobble).toBeDefined();
    expect(mirror?.params.attenuate).toBeDefined();
    expect(mirror?.params.seed).toBeDefined();
    expect(mirror?.params.copyTo).toBeDefined();

    const ridge = commands.find((c) => c.name === 'ridge_line');
    expect(ridge?.description).toMatch(/ridged fBm|natural ridge/i);
    expect(ridge?.params.amplitude).toBeDefined();
    expect(ridge?.params.scale).toBeDefined();
    expect(ridge?.params.octaves).toBeDefined();
    expect(ridge?.params.lacunarity).toBeDefined();
    expect(ridge?.params.gain).toBeDefined();
    expect(ridge?.params.seed).toBeDefined();

    const polyline = commands.find((c) => c.name === 'draw_polyline');
    expect(polyline?.params.points).toBe('object[]');
    expect(polyline?.params.close).toBe('boolean?');
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
    const historyBefore = payload(
      (await client.callTool({ name: 'get_history', arguments: {} })) as ToolResult,
    );

    const rolled = (await client.callTool({
      name: 'apply_ops',
      arguments: {
        atomic: true,
        ops: [
          { command: 'clear_all' },
          { command: 'measure_region' },
          { command: 'this_command_does_not_exist' },
        ],
      },
    })) as ToolResult;

    const rolledBody = payload(rolled);
    expect(rolledBody.ok).toBe(false);
    expect(rolledBody.committed).toBe(false);
    expect(rolledBody.rolledBack).toBe(true);
    expect(rolledBody.applied).toBe(0);
    expect(rolledBody.succeededBeforeRollback).toBe(2);
    expect(rolledBody.version).toBe(historyBefore.version);

    const after = payload(
      (await client.callTool({ name: 'measure_region', arguments: {} })) as ToolResult,
    ).summary as { opaque: number };
    expect(after.opaque).toBe(before.opaque);
    const historyAfter = payload(
      (await client.callTool({ name: 'get_history', arguments: {} })) as ToolResult,
    );
    expect(historyAfter.version).toBe(historyBefore.version);
    expect(historyAfter.entries).toEqual(historyBefore.entries);
    expect(historyAfter.total).toBe(historyBefore.total);
  });

  it('does not undo prior history when an atomic single-step batch only had a read-only success', async () => {
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 0, w: 2, h: 2 }, color: '#ff0000', fill: true },
    });
    await client.callTool({ name: 'undo', arguments: {} });
    const before = payload((await client.callTool({ name: 'get_history', arguments: {} })) as ToolResult);
    expect(before.canRedo).toBe(true);

    const rolled = payload((await client.callTool({
      name: 'apply_ops',
      arguments: {
        atomic: true,
        singleUndoStep: true,
        ops: [{ command: 'measure_region' }, { command: 'missing_after_read' }],
      },
    })) as ToolResult);
    expect(rolled.rolledBack).toBe(true);

    const after = payload((await client.callTool({ name: 'get_history', arguments: {} })) as ToolResult);
    expect(after.version).toBe(before.version);
    expect(after.canRedo).toBe(true);
    expect(after.entries).toEqual(before.entries);
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

  it('keeps malformed-op diagnostics in atomic and quiet responses', async () => {
    const result = (await client.callTool({
      name: 'apply_ops',
      arguments: { atomic: true, quiet: true, ops: [{ oops: 'missing command' }] },
    })) as ToolResult;
    const body = payload(result);

    expect(body).toMatchObject({ ok: false, failed: 1, rolledBack: true });
    expect(body.failures).toEqual([
      expect.objectContaining({ index: 0, code: 'invalid_op', error: expect.stringMatching(/needs a "command" string/i) }),
    ]);
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
    expect(typeof body.defectScore).toBe('number');
    expect(body.softnessScore).toBeUndefined();
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

    const ridge = (await client.callTool({
      name: 'ridge_line',
      arguments: { x: 0, y: 4, width: 8, amplitude: 2, scale: 3, octaves: 2, seed: 4, color: '#ffffff' },
    })) as ToolResult;
    const ridgeSummary = payload(ridge).summary as { points: unknown[]; mode: string; painted: number };
    expect(ridgeSummary.mode).toBe('ridged-fbm');
    expect(ridgeSummary.points.length).toBeGreaterThan(2);
    expect(ridgeSummary.painted).toBeGreaterThan(0);

    const invalid = (await client.callTool({
      name: 'put_pixels',
      arguments: { rect: { x: 0, y: 0, w: 1, h: 1 }, data: '!!!!' },
    })) as ToolResult;
    expect(invalid.isError).toBe(true);
    expect(firstText(invalid)).toMatch(/base64|validation/i);
  });

  it('supports character animation diagnostics and intentional detail regions', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 8, height: 8, layers: ['base'], frames: 3 } });
    await client.callTool({ name: 'draw_pixels', arguments: { frame: 0, pixels: [{ x: 0, y: 0, color: '#ff0000' }] } });
    await client.callTool({ name: 'draw_pixels', arguments: { frame: 1, pixels: [{ x: 3, y: 3, color: '#00ff00' }] } });
    await client.callTool({ name: 'draw_pixels', arguments: { frame: 2, pixels: [{ x: 6, y: 6, color: '#0000ff' }] } });

    const raw = payload((await client.callTool({ name: 'quality_report', arguments: {} })) as ToolResult);
    expect((raw.noise as { isolated: number }).isolated).toBe(1);

    const character = payload((await client.callTool({
      name: 'quality_report',
      arguments: {
        assetType: 'character',
        intentionalDetailRects: [{ x: 0, y: 0, w: 1, h: 1, kind: 'eye' }],
      },
    })) as ToolResult);
    expect((character.noise as { isolated: number; intentionalPixels: number }).isolated).toBe(0);
    expect((character.noise as { intentionalPixels: number }).intentionalPixels).toBe(1);
    expect(character.assetType).toBe('character');
    expect(character.assetTypeIsLabel).toBe(false);
    expect((character.animation as { frameCount: number }).frameCount).toBe(3);
    expect((character.animation as { transitions: unknown[] }).transitions).toHaveLength(2);
    expect((character.warnings as Array<{ code: string }>).some((warning) => warning.code.startsWith('landscape_'))).toBe(false);
  });

  it('infers the asset type under auto and labels the non-analysing modes honestly', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 8, height: 8, layers: ['base'] } });
    await client.callTool({ name: 'draw_rect', arguments: { rect: { x: 1, y: 1, w: 4, h: 4 }, color: '#00ff00', fill: true } });

    const singleFrame = payload((await client.callTool({ name: 'quality_report', arguments: { assetType: 'auto' } })) as ToolResult);
    expect(singleFrame.assetType).toBe('raster');
    expect(singleFrame.assetTypeRequested).toBe('auto');
    expect(singleFrame.animation).toBeUndefined();

    const labelled = payload((await client.callTool({ name: 'quality_report', arguments: { assetType: 'prop' } })) as ToolResult);
    expect(labelled.assetType).toBe('prop');
    // A label-only mode must say so instead of implying a different analysis ran.
    expect(labelled.assetTypeIsLabel).toBe(true);
    expect(labelled.animation).toBeUndefined();

    await client.callTool({ name: 'duplicate_frame', arguments: { frame: 0 } });
    const inferred = payload((await client.callTool({ name: 'quality_report', arguments: { assetType: 'auto' } })) as ToolResult);
    expect(inferred.assetType).toBe('character');
    expect((inferred.animation as { frameCount: number }).frameCount).toBe(2);
  });

  it('raises warnings for the cross-frame defects it measures', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 8, height: 8, layers: ['base'], frames: 2 } });
    // Frame 0 sits in the top-left corner, frame 1 in the bottom-right: a large
    // centroid drift and a silhouette jump, plus a canvas-edge touch.
    await client.callTool({ name: 'draw_pixels', arguments: { frame: 0, pixels: [{ x: 0, y: 0, color: '#ff0000' }] } });
    await client.callTool({ name: 'draw_pixels', arguments: { frame: 1, pixels: [{ x: 7, y: 7, color: '#00ff00' }] } });

    const report = payload((await client.callTool({
      name: 'quality_report',
      arguments: { assetType: 'character', maxCentroidDriftWarning: 3 },
    })) as ToolResult);
    const codes = (report.animation as { warnings: Array<{ code: string }> }).warnings.map((warning) => warning.code);
    expect(codes).toContain('character_silhouette_jump');
    expect(codes).toContain('character_centroid_drift');
    expect(codes).toContain('character_canvas_clipping');
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

  it('skips unchanged source and output files during incremental finalisation', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 4, height: 4, layers: ['base'] } });
    await client.callTool({ name: 'draw_rect', arguments: { rect: { x: 0, y: 0, w: 2, h: 2 }, color: '#ff0000', fill: true } });
    const source = join(tempDir, 'incremental.pixel');
    const image = join(tempDir, 'incremental.png');
    const manifest = join(tempDir, 'incremental.json');
    const plan = {
      path: source,
      outputs: [{ type: 'png', path: image }],
      manifest: { path: manifest, hashes: true, incremental: true },
    };

    const first = payload((await client.callTool({ name: 'finalize_document', arguments: plan })) as ToolResult);
    expect(first.ok).toBe(true);
    const second = payload((await client.callTool({ name: 'finalize_document', arguments: plan })) as ToolResult);
    expect(second.skippedFiles).toEqual(expect.arrayContaining([source, image]));
    expect((second.manifest as { unchanged: boolean }).unchanged).toBe(true);
  });

  it('renders a multi-format export plan and manifest in one finalisation call', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 4, height: 4, name: 'Bundle', layers: ['base'], frames: 2 },
    });
    await client.callTool({ name: 'draw_rect', arguments: { frame: 0, rect: { x: 0, y: 0, w: 2, h: 2 }, color: '#ff0000', fill: true } });
    await client.callTool({ name: 'draw_rect', arguments: { frame: 1, rect: { x: 2, y: 2, w: 2, h: 2 }, color: '#0000ff', fill: true } });
    await client.callTool({ name: 'add_tag', arguments: { name: 'blink', from: 0, to: 1, direction: 'pingpong' } });

    const source = join(tempDir, 'bundle.pixel');
    const manifestPath = join(tempDir, 'bundle.manifest.json');
    const result = (await client.callTool({
      name: 'finalize_document',
      arguments: {
        path: source,
        outputs: [
          { type: 'png', path: join(tempDir, 'bundle.png'), frame: 0 },
          { type: 'frames', path: join(tempDir, 'bundle-frame.png') },
          { type: 'sheet', path: join(tempDir, 'bundle-sheet.png'), layout: 'grid', columns: 2, padding: 1 },
          { type: 'gif', path: join(tempDir, 'bundle.gif'), tag: 'blink' },
          { type: 'contact', path: join(tempDir, 'bundle-contact.png'), tag: 'blink', layout: 'strip', scale: 1 },
        ],
        manifest: { path: manifestPath, hashes: true },
      },
    })) as ToolResult;
    const body = payload(result);

    expect(result.isError).toBeFalsy();
    expect(body.files).toEqual(expect.arrayContaining([
      source,
      join(tempDir, 'bundle.png'),
      join(tempDir, 'bundle-frame_0.png'),
      join(tempDir, 'bundle-frame_1.png'),
      join(tempDir, 'bundle-sheet.png'),
      join(tempDir, 'bundle-sheet.json'),
      join(tempDir, 'bundle.gif'),
      join(tempDir, 'bundle-contact.png'),
      manifestPath,
    ]));
    expect((body.outputs as Array<{ type: string }>).map((output) => output.type)).toEqual(
      expect.arrayContaining(['png', 'sheet', 'json', 'gif', 'contact']),
    );

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest).toMatchObject({ format: 'dotloom-mcp/export-manifest', version: 1 });
    expect(manifest.source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.frames).toHaveLength(2);
    expect(manifest.tags[0]).toMatchObject({ name: 'blink', direction: 'pingpong' });
    expect(manifest.outputs.every((output: { sha256?: string }) => /^[a-f0-9]{64}$/.test(output.sha256))).toBe(true);
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

describe('character rig workflow', () => {
  it('creates a declarative rig, previews a pose and bakes it explicitly', async () => {
    const created = (await client.callTool({
      name: 'create_sprite_spec',
      arguments: {
        name: 'Rig character',
        width: 8,
        height: 8,
        layers: ['body', 'arm'],
        frames: 2,
        tags: [{ name: 'idle', from: 0, to: 1, direction: 'pingpong' }],
        paletteRoles: [{ role: 'skin', colors: ['#ff0000', '#00ff00'] }],
        rig: {
          restFrame: 0,
          parts: [
            { name: 'body', pivot: { x: 4, y: 4 }, layers: ['body'] },
            { name: 'arm', pivot: { x: 4, y: 4 }, layers: ['arm'], parent: 'body' },
          ],
        },
      },
    })) as ToolResult;
    expect(payload(created).ok).toBe(true);
    expect((payload(created).rig as { partCount: number }).partCount).toBe(2);
    expect((payload(created).configured as { tags: { created: unknown[] }; paletteRoles: Array<{ role: string }> }).tags.created).toHaveLength(1);
    expect((payload(created).configured as { paletteRoles: Array<{ role: string }> }).paletteRoles[0].role).toBe('skin');

    await client.callTool({ name: 'draw_pixels', arguments: { layer: 'arm', frame: 0, pixels: [{ x: 5, y: 4, color: '#ff0000' }] } });
    const rig = (payload((await client.callTool({ name: 'get_rig', arguments: {} })) as ToolResult).summary as {
      rig: { parts: Array<{ id: string; name: string }> };
    }).rig;
    const arm = rig.parts.find((part) => part.name === 'arm')!;
    await client.callTool({
      name: 'save_pose',
      arguments: { name: 'raised', transforms: { [arm.id]: { rotationDegrees: 90 } } },
    });

    const preview = (await client.callTool({
      name: 'preview_pose',
      arguments: { pose: 'raised', scale: 2 },
    })) as ToolResult;
    expect(preview.isError).toBeFalsy();
    expect(payload(preview).partBounds).toMatchObject({ arm: { x: 4, y: 5, w: 1, h: 1 } });
    expect(decodedImage(preview).width).toBe(16);

    const baked = (await client.callTool({
      name: 'bake_pose',
      arguments: { pose: 'raised', targetFrame: 1 },
    })) as ToolResult;
    expect(baked.isError).toBeFalsy();
    const measured = payload((await client.callTool({
      name: 'measure_region',
      arguments: { layer: 'arm', frame: 1 },
    })) as ToolResult);
    expect((measured.summary as { bounds: unknown }).bounds).toEqual({ x: 4, y: 5, w: 1, h: 1 });
    const quality = payload((await client.callTool({
      name: 'quality_report',
      arguments: { assetType: 'character' },
    })) as ToolResult);
    expect((quality.rig as { partCount: number }).partCount).toBe(2);
    expect((quality.palette as { documentUsage: { used: number } }).documentUsage.used).toBeGreaterThan(0);
  });
});

describe('animation preview', () => {
  it('renders tag-expanded playback order with sequence-aware onion skin', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 4, height: 4, layers: ['base'], frames: 3 },
    });
    await client.callTool({ name: 'draw_rect', arguments: { frame: 0, rect: { x: 0, y: 0, w: 1, h: 1 }, color: '#ff0000', fill: true } });
    await client.callTool({ name: 'draw_rect', arguments: { frame: 1, rect: { x: 1, y: 1, w: 1, h: 1 }, color: '#00ff00', fill: true } });
    await client.callTool({ name: 'draw_rect', arguments: { frame: 2, rect: { x: 2, y: 2, w: 1, h: 1 }, color: '#0000ff', fill: true } });
    await client.callTool({ name: 'add_tag', arguments: { name: 'idle', from: 0, to: 2, direction: 'pingpong' } });

    const result = (await client.callTool({
      name: 'preview_animation',
      arguments: {
        tag: 'idle',
        layout: 'strip',
        padding: 1,
        margin: 0,
        scale: 1,
        onion: { before: 1, after: 1, opacity: 0.5 },
      },
    })) as ToolResult;
    const body = payload(result);
    expect(body).toMatchObject({
      mode: 'animation-preview',
      frameOrder: 'playback',
      tag: 'idle',
      frameCount: 4,
      layout: 'strip',
      imageWidth: 19,
      imageHeight: 4,
    });
    expect((body.sequence as Array<{ index: number }>).map((frame) => frame.index)).toEqual([0, 1, 2, 1]);
    expect(decodedImage(result).getColor(6, 1).a).toBeGreaterThan(0);
  });

  it('returns an animated GIF for clients that support playback', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 4, height: 4, frames: 2 } });
    await client.callTool({ name: 'draw_rect', arguments: { frame: 0, rect: { x: 0, y: 0, w: 1, h: 1 }, color: '#ff0000', fill: true } });
    await client.callTool({ name: 'add_tag', arguments: { name: 'idle', from: 0, to: 1, direction: 'pingpong' } });

    const result = (await client.callTool({
      name: 'preview_animation',
      arguments: { tag: 'idle', format: 'gif', scale: 2 },
    })) as ToolResult;
    const image = result.content.find((content) => content.type === 'image');
    expect(image?.mimeType).toBe('image/gif');
    expect(Buffer.from(image!.data!, 'base64').subarray(0, 6).toString('latin1')).toBe('GIF89a');
    expect(payload(result)).toMatchObject({ format: 'gif', tag: 'idle', frameCount: 2, imageWidth: 8, imageHeight: 8 });
  });

  it('rejects an unknown animation tag instead of falling back to the timeline', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 4, height: 4 } });
    const result = (await client.callTool({
      name: 'preview_animation',
      arguments: { tag: 'missing' },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/Unknown animation tag: missing/);
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

  it('returns every edited frame from the same apply_ops call', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 4, height: 4, layers: ['base'], frames: 3 },
    });
    const result = (await client.callTool({
      name: 'apply_ops',
      arguments: {
        ops: [
          { command: 'draw_rect', frame: 0, rect: { x: 0, y: 0, w: 1, h: 1 }, color: '#ff0000', fill: true },
          { command: 'draw_rect', frame: 1, rect: { x: 1, y: 1, w: 1, h: 1 }, color: '#00ff00', fill: true },
          { command: 'draw_rect', frame: 2, rect: { x: 2, y: 2, w: 1, h: 1 }, color: '#0000ff', fill: true },
        ],
        preview: true,
        previewOptions: { frames: 'all', scale: 1 },
      },
    })) as ToolResult;

    expect(payload(result).preview).toMatchObject({ mode: 'all-frames', frameCount: 3, scale: 1 });
    const image = decodedImage(result);
    expect([image.width, image.height]).toEqual([14, 4]);
    expect(image.getColor(0, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(image.getColor(6, 1)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(image.getColor(12, 2)).toEqual({ r: 0, g: 0, b: 255, a: 255 });
  });

  it('rejects an oversized all-frame strip before allocating it', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 4096, height: 1024, layers: ['base'], frames: 5 },
    });
    const result = (await client.callTool({
      name: 'get_preview',
      arguments: { frames: 'all', scale: 1 },
    })) as ToolResult;

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/safety limit/i);
    expect(result.content.some((content) => content.type === 'image')).toBe(false);
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

  it('returns the committed script version and accepts it as the next expectedVersion', async () => {
    const id = await makeDoc();
    const run = payload((await client.callTool({
      name: 'run_script',
      arguments: {
        document: id,
        source: `exec('draw_pixels', { layer: 0, frame: 0, pixels: [{ x: 0, y: 0, color: '#ff0000' }] }); return 1;`,
      },
    })) as ToolResult);
    const detail = payload((await client.callTool({ name: 'get_document', arguments: { document: id } })) as ToolResult);
    expect(run.version).toBe((detail.document as { version: number }).version);

    const next = (await client.callTool({
      name: 'draw_rect',
      arguments: {
        document: id,
        expectedVersion: run.version,
        rect: { x: 1, y: 1, w: 1, h: 1 },
        color: '#00ff00',
        fill: true,
      },
    })) as ToolResult;
    expect(next.isError).toBeFalsy();
    expect(payload(next).version).toBe((run.version as number) + 1);
  });

  it('uses the same layer/frame defaults as generated tools and exposes sampleComposite', async () => {
    const id = await makeDoc();
    const result = (await client.callTool({
      name: 'run_script',
      arguments: {
        document: id,
        source: `
          exec('draw_rect', { rect: { x: 0, y: 0, w: 1, h: 1 }, color: '#ff0000', fill: true });
          return { composite: sampleComposite(0, 0), layer: getPixel(0, 0) };
        `,
      },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(payload(result).result).toEqual({
      composite: { r: 255, g: 0, b: 0, a: 255 },
      layer: { r: 255, g: 0, b: 0, a: 255 },
    });
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

  it('dry-runs a script and previews all shadow frames without changing the live document', async () => {
    const created = (await client.callTool({
      name: 'create_document',
      arguments: { width: 4, height: 4, layers: ['base'], frames: 2 },
    })) as ToolResult;
    const id = (payload(created).document as { id: string }).id;
    const historyBefore = payload((await client.callTool({ name: 'get_history', arguments: { document: id } })) as ToolResult);

    const run = (await client.callTool({
      name: 'run_script',
      arguments: {
        document: id,
        dryRun: true,
        source: `
          const base = layers()[0].id;
          exec('draw_pixels', { layer: base, frame: 0, pixels: [{ x: 0, y: 0, color: '#ff0000' }] });
          exec('draw_pixels', { layer: base, frame: 1, pixels: [{ x: 1, y: 1, color: '#00ff00' }] });
          return 'shadow';
        `,
        preview: true,
        previewOptions: {
          frames: 'all',
          onion: { before: 1, after: 1, opacity: 0.5 },
          scale: 1,
        },
      },
    })) as ToolResult;

    const body = payload(run);
    expect(body).toMatchObject({
      ok: true,
      result: 'shadow',
      dryRun: true,
      changed: true,
      committed: false,
    });
    expect(body.preview).toMatchObject({ mode: 'all-frames', frameCount: 2 });
    const image = decodedImage(run);
    expect([image.width, image.height]).toEqual([9, 4]);
    expect(image.getColor(0, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });

    const detail = payload((await client.callTool({ name: 'get_document', arguments: { document: id } })) as ToolResult);
    const historyAfter = payload((await client.callTool({ name: 'get_history', arguments: { document: id } })) as ToolResult);
    expect((detail.document as { version: number }).version).toBe(historyBefore.version);
    expect(historyAfter.entries).toEqual(historyBefore.entries);
    const measured = payload((await client.callTool({
      name: 'measure_region',
      arguments: { document: id, layer: 'base', frame: 0 },
    })) as ToolResult);
    expect((measured.summary as { opaque: number }).opaque).toBe(0);
  });

  it('returns source-relative error details for a dry-run failure', async () => {
    const id = await makeDoc();
    const before = payload((await client.callTool({ name: 'get_history', arguments: { document: id } })) as ToolResult);
    const run = (await client.callTool({
      name: 'run_script',
      arguments: {
        document: id,
        dryRun: true,
        source: `const before = true;\nthrow new Error('dry boom');`,
      },
    })) as ToolResult;

    expect(run.isError).toBe(true);
    const body = payload(run);
    expect(body).toMatchObject({ dryRun: true, committed: false, changed: false, version: before.version });
    expect(body.errorInfo).toMatchObject({
      message: 'dry boom',
      phase: 'runtime',
      line: 2,
      sourceName: 'source',
    });

    const after = payload((await client.callTool({ name: 'get_history', arguments: { document: id } })) as ToolResult);
    expect(after.entries).toEqual(before.entries);
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

  it('publishes a build fingerprint so a stale server is detectable', async () => {
    // The server is long-lived and loads dist once, so rebuilding does not reach a
    // running session. Without a fingerprint that failure is silent: every call works,
    // the tool list looks right, and the agent is just on last week's guidance.
    const result = (await client.callTool({ name: 'list_commands', arguments: {} })) as ToolResult;
    const build = payload(result).build as {
      skillHash: string;
      skillLength: number;
      commandCount: number;
    };
    expect(build.skillHash).toMatch(/^[0-9a-f]{8}$/);
    expect(build.skillLength).toBeGreaterThan(20_000);
    expect(build.commandCount).toBe((payload(result).commands as unknown[]).length);

    // The fingerprint must actually track the guide it describes.
    const skill = payload((await client.callTool({ name: 'read_skill', arguments: {} })) as ToolResult)
      .skill as string;
    expect(skill.length).toBe(build.skillLength);
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
