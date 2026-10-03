/**
 * The two opt-in asset outputs on `finalize_document`: `meta.json` and one engine importer's files.
 *
 * These live on the delivery path, which is the only place in this repository where a bug writes
 * somebody's game a file. So every case here is written to fail *without* the wiring, in one of
 * five ways: the engine files are not written, the bytes drift between runs, the quality gate
 * stops being a gate, an uncommittable bundle goes out anyway, or an ordinary export that asked
 * for none of this quietly changes.
 *
 * The last one matters most. `meta.json` and the engine importers were deliberately **not** made
 * automatic, because writing engine files beside every export would surprise everyone already
 * using this and break the byte-identical expectations the existing outputs carry. That decision
 * is only real if a plan without asset outputs behaves exactly as it did before, which is what
 * `describe('an export that asks for no asset output')` exists to hold.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPixelServer, type PixelServer } from '../src/server.js';

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function payload(result: ToolResult): Record<string, any> {
  const text = result.content.find((c) => c.type === 'text')?.text ?? '{}';
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`not JSON: ${text}`);
  }
}

let client: Client;
let pixel: PixelServer;
let tempDir: string;

async function connect(): Promise<void> {
  pixel = createPixelServer({ initialDocument: null });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'asset-output-test', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), pixel.server.connect(serverTransport)]);
}

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  return payload((await client.callTool({ name, arguments: args })) as ToolResult);
}

/**
 * Export-mechanics fixtures, not shipped art.
 *
 * The quality gate still runs — `bypass` does not skip it, it exports a failing asset and says
 * so — so every case below is exercising the gate as well as the export. The one case that needs
 * a real refusal builds its own probe and passes no bypass.
 */
const FIXTURE_BYPASS = {
  bypass: true,
  bypassReason: 'Export-mechanics fixture, not a shipped asset.',
};

beforeEach(async () => {
  await connect();
  tempDir = mkdtempSync(join(tmpdir(), 'pixel-mcp-asset-'));
});

afterEach(async () => {
  await client?.close();
  await pixel?.server.close();
  rmSync(tempDir, { recursive: true, force: true });
});

/**
 * A two-frame sprite with a sheet, which is what an engine importer needs to point a texture at.
 *
 * Drawn through `apply_ops` rather than by naming `draw_rect`: the catalogue is lazy, so a core
 * command is only a tool once something has looked it up, and an export test should not depend
 * on that promotion order.
 */
async function sheetableSprite(name = 'hero-idle'): Promise<void> {
  await call('create_document', { width: 8, height: 8, name, layers: ['base'], frames: 2 });
  await call('apply_ops', {
    ops: [
      { command: 'draw_rect', params: { frame: 0, rect: { x: 0, y: 0, w: 8, h: 8 }, color: '#ff0000', fill: true } },
      { command: 'draw_rect', params: { frame: 1, rect: { x: 0, y: 0, w: 8, h: 8 }, color: '#00ff00', fill: true } },
      { command: 'add_tag', params: { name: 'walk', from: 0, to: 1, direction: 'forward' } },
    ],
  });
}

describe('the engine output', () => {
  it('writes the importer\'s files and a meta.json, and the contract bytes are identical every run', async () => {
    await sheetableSprite();
    const source = join(tempDir, 'hero.pixel');
    const sheet = join(tempDir, 'hero-sheet.png');
    const meta = join(tempDir, 'hero.meta.json');
    const plan = {
      path: source,
      ...FIXTURE_BYPASS,
      outputs: [
        { type: 'sheet', path: sheet, layout: 'grid', columns: 2 },
        { type: 'engine', engine: 'godot', path: meta },
      ],
    };

    const first = await call('finalize_document', plan);
    expect(first.ok, String(first.error)).toBe(true);

    // The files Godot actually opens, in the importer's suggested folder beside the contract.
    const root = join(tempDir, 'hero-idle');
    expect(first.files).toEqual(expect.arrayContaining([meta, join(root, 'hero-idle.tres'), join(root, 'hero-idle.tscn')]));
    const tres = readFileSync(join(root, 'hero-idle.tres'), 'utf8');
    const tscn = readFileSync(join(root, 'hero-idle.tscn'), 'utf8');
    expect(tres).toContain('[gd_resource');
    expect(tres).toContain('SpriteFrames');
    expect(tscn).toContain('AnimatedSprite2D');
    // S9.1: the pivot crosses as a centre-relative offset, and on an 8x8 default pivot that is 0.
    expect(tscn).toContain('offset = Vector2(0, 0)');

    // And the contract that produced them.
    const contract = JSON.parse(readFileSync(meta, 'utf8'));
    expect(contract.format).toBe('dotloom-mcp/asset-meta');
    expect(contract.asset.name).toBe('hero-idle');
    expect(contract.asset.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(contract.frames.size).toEqual({ width: 8, height: 8 });
    // The sheet is described from the packing this plan actually did, and named relative to
    // the contract rather than as an absolute path from the artist's machine (S5.1).
    expect(contract.sheet.image).toBe('hero-sheet.png');
    expect(contract.sheet.regions).toHaveLength(2);

    const firstBytes = readFileSync(meta);
    const second = await call('finalize_document', plan);
    expect(second.ok).toBe(true);
    // Determinism, measured rather than asserted: the same document must not produce a diff on
    // every export, because a committed `meta.json` that churns is one nobody keeps.
    expect(readFileSync(meta).equals(firstBytes)).toBe(true);

    // What the caller is told about the contract and the engine files.
    const asset = (second.assets as Array<Record<string, any>>)[0];
    expect(asset.path).toBe(meta);
    expect(asset.schemaVersion).toBe(1);
    expect(asset.naming.ok).toBe(true);
    expect(asset.engine.engine).toBe('godot');
    expect(asset.engine.root).toBe('hero-idle');
    expect(asset.engine.files).toEqual(expect.arrayContaining(['hero-idle.tres', 'hero-idle.tscn']));
  }, 20_000);

  it('carries per-frame direction into the contract, and leaves the block out entirely when none is given', async () => {
    await sheetableSprite();
    const source = join(tempDir, 'dirs.pixel');
    const sheet = join(tempDir, 'dirs-sheet.png');
    const withDirections = join(tempDir, 'dirs-facing.json');
    const without = join(tempDir, 'dirs-plain.json');

    const base = {
      path: source,
      ...FIXTURE_BYPASS,
      outputs: [{ type: 'sheet', path: sheet, layout: 'grid', columns: 2 }],
    };
    const facing = await call('finalize_document', {
      ...base,
      outputs: [
        ...base.outputs,
        { type: 'meta', path: withDirections, directions: ['S', 'N'] },
        { type: 'meta', path: without },
      ],
    });
    expect(facing.ok, String(facing.error)).toBe(true);

    const directed = JSON.parse(readFileSync(withDirections, 'utf8'));
    expect(directed.frames.directions).toEqual([
      { index: 0, facing: 'S', animations: ['walk'] },
      { index: 1, facing: 'N', animations: ['walk'] },
    ]);
    // The "invisible when absent" property: no block, no nulls, and no `directions` string at
    // all, so an asset with no direction model keeps the exact bytes it had before the field
    // existed and every importer cache key in the wild survives.
    const plain = readFileSync(without, 'utf8');
    expect(plain).not.toContain('directions');
    expect(plain).not.toContain('facing');
    expect(JSON.parse(plain).frames.directions).toBeUndefined();
  }, 20_000);

  it('refuses an unrecognised facing label rather than dropping the frame', async () => {
    await sheetableSprite();
    const result = await call('finalize_document', {
      path: join(tempDir, 'bad-facing.pixel'),
      ...FIXTURE_BYPASS,
      outputs: [{ type: 'meta', path: join(tempDir, 'bad-facing.json'), directions: ['sideways', 'S'] }],
    });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('sideways');
    expect(existsSync(join(tempDir, 'bad-facing.json'))).toBe(false);
  }, 20_000);
});

describe('the asset outputs and the quality gate', () => {
  it('writes nothing at all when the gate refuses, the new outputs included', async () => {
    // No bypass, and a sprite the gate measures and refuses: one flat block of an off-palette
    // colour on an 8x8 canvas is refused on `flat-value` and `off-palette`.
    await call('create_document', { width: 8, height: 8, name: 'Gate probe', layers: ['base'] });
    await call('apply_ops', {
      ops: [{ command: 'draw_rect', params: { rect: { x: 0, y: 0, w: 8, h: 8 }, color: '#2255aa', fill: true } }],
    });

    const source = join(tempDir, 'gated.pixel');
    const meta = join(tempDir, 'gated.json');
    const result = await call('finalize_document', {
      path: source,
      outputs: [{ type: 'engine', engine: 'godot', path: meta }],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('command_failed');
    expect(String(result.error)).toContain('quality gate refused');
    // The point of the case: an export path that reached the contract before the gate would
    // leave a `meta.json` and a Godot resource describing an asset that was refused. Nothing.
    expect(existsSync(source)).toBe(false);
    expect(existsSync(meta)).toBe(false);
    expect(existsSync(join(tempDir, 'gate-probe'))).toBe(false);
  }, 20_000);
});

describe('the naming gate', () => {
  it('refuses a bundle whose paths collide when case is folded, and writes nothing', async () => {
    await sheetableSprite();
    // Two files, two on Linux and one on Windows, with an importer cache keyed on the path that
    // disagrees between a developer's machine and a build server. The contract validator accepts
    // both (its `path-duplicate` is exact-match); the naming validator is the one that sees it.
    const result = await call('finalize_document', {
      path: join(tempDir, 'collide.pixel'),
      ...FIXTURE_BYPASS,
      outputs: [
        {
          type: 'meta',
          path: join(tempDir, 'collide.json'),
          outputs: [
            { role: 'frame', path: 'hero-idle.png' },
            { role: 'gif', path: 'hero-Idle.png' },
          ],
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.gate).toBe('asset-naming');
    expect(String(result.error)).toContain('case-collision');
    expect((result.diagnostics as Array<{ code: string; severity: string }>).some(
      (d) => d.code === 'case-collision' && d.severity === 'error',
    )).toBe(true);
    expect(existsSync(join(tempDir, 'collide.json'))).toBe(false);
    expect(existsSync(join(tempDir, 'collide.pixel'))).toBe(false);
  }, 20_000);

  it('reports a naming warning, writes the bundle anyway, and keeps it in the result', async () => {
    // A style deviation is a project convention, not a broken build. A validator that blocks on
    // camelCase is a validator a project switches off, and then nothing is checked at all.
    await sheetableSprite('HeroIdle');
    const meta = join(tempDir, 'camel.json');
    const result = await call('finalize_document', {
      path: join(tempDir, 'camel.pixel'),
      ...FIXTURE_BYPASS,
      outputs: [
        { type: 'sheet', path: join(tempDir, 'camel-sheet.png'), layout: 'grid', columns: 2 },
        { type: 'meta', path: meta },
      ],
    });

    expect(result.ok, String(result.error)).toBe(true);
    expect(existsSync(meta)).toBe(true);
    const asset = (result.assets as Array<Record<string, any>>)[0];
    expect(asset.naming.ok).toBe(true);
    expect((asset.naming.diagnostics as Array<{ code: string; severity: string }>).map((d) => d.code)).toContain('asset-name-style');
  }, 20_000);
});

describe('the manifest and the incremental path', () => {
  it('hashes the new outputs, lists them, and skips them on the second run', async () => {
    await sheetableSprite();
    const source = join(tempDir, 'manifest.pixel');
    const sheet = join(tempDir, 'manifest-sheet.png');
    const meta = join(tempDir, 'manifest.json');
    const manifestPath = join(tempDir, 'manifest.manifest.json');
    const plan = {
      path: source,
      ...FIXTURE_BYPASS,
      outputs: [
        { type: 'sheet', path: sheet, layout: 'grid', columns: 2 },
        { type: 'engine', engine: 'godot', path: meta },
      ],
      manifest: { path: manifestPath, hashes: true, incremental: true },
    };

    const first = await call('finalize_document', plan);
    expect(first.ok, String(first.error)).toBe(true);

    // Without the new outputs in the manifest, `incremental: true` would skip nothing for them
    // and every run would rewrite every engine file for everyone.
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const paths = (manifest.outputs as Array<{ path: string; sha256: string; type: string }>).map((o) => o.path);
    expect(paths).toEqual(expect.arrayContaining([meta, join(tempDir, 'hero-idle', 'hero-idle.tres'), join(tempDir, 'hero-idle', 'hero-idle.tscn')]));
    expect(manifest.outputs.every((output: { sha256?: string }) => /^[a-f0-9]{64}$/.test(output.sha256))).toBe(true);
    expect((manifest.outputs as Array<{ type: string }>).map((o) => o.type)).toEqual(expect.arrayContaining(['meta', 'engine']));

    const second = await call('finalize_document', plan);
    expect(second.skippedFiles).toEqual(
      expect.arrayContaining([source, meta, join(tempDir, 'hero-idle', 'hero-idle.tres'), join(tempDir, 'hero-idle', 'hero-idle.tscn')]),
    );
    expect((second.manifest as { unchanged: boolean }).unchanged).toBe(true);
  }, 20_000);
});

describe('an export that asks for no asset output', () => {
  it('writes exactly the files it wrote before, with no asset outputs in any list', async () => {
    await sheetableSprite();
    const source = join(tempDir, 'plain.pixel');
    const png = join(tempDir, 'plain.png');
    const sheet = join(tempDir, 'plain-sheet.png');
    const manifestPath = join(tempDir, 'plain.manifest.json');

    const result = await call('finalize_document', {
      path: source,
      ...FIXTURE_BYPASS,
      outputs: [
        { type: 'png', path: png, frame: 0 },
        { type: 'sheet', path: sheet, layout: 'grid', columns: 2 },
      ],
      manifest: { path: manifestPath, hashes: true },
    });
    expect(result.ok, String(result.error)).toBe(true);

    // The file list is the old one, member for member: source, PNG, sheet, sheet JSON, manifest.
    expect(result.files).toEqual([source, png, sheet, join(tempDir, 'plain-sheet.json'), manifestPath]);
    // `exports` is still the image list, with nothing text-shaped leaking into it.
    expect((result.exports as Array<{ path: string }>).map((e) => e.path)).toEqual([png, sheet]);
    // No `assets` key at all, rather than an empty array: the shape a caller writes against
    // must not change for the plans that never asked.
    expect(result.assets).toBeUndefined();
    expect((result.outputs as Array<{ type: string }>).map((o) => o.type)).toEqual(['png', 'sheet', 'json']);
    // And the manifest holds the same three outputs it always did.
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.outputs.map((o: { path: string }) => o.path)).toEqual([png, sheet, join(tempDir, 'plain-sheet.json')]);
    expect(existsSync(join(tempDir, 'plain.meta.json'))).toBe(false);
  }, 20_000);
});