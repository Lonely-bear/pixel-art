import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeId, setIdFactory, type Sprite } from '../src/index.js';
import * as entry from '../../../scripts/npm-index.js';

/**
 * The published library surface, pinned and proved reproducible.
 *
 * ## Why this file is in `packages/core/test`
 *
 * `scripts/npm-index.ts` is what an npm consumer actually imports — five lines before this
 * task, now the whole stable API — and no package tsconfig includes it, so nothing in
 * `pnpm typecheck` looks at it either. A test has to live somewhere, and the only test
 * directory this task may write to is this one, so the guard on the published entry sits
 * here. That is an accident of the task, not a design choice, and it is why the
 * surface list below is written out in full rather than derived: a reader who lands in
 * `packages/core/test` deserves to know this file is about the package root.
 *
 * ## What the guard is for
 *
 * The same species of check as `quality-weights.test.ts` and `tool-surface.test.ts`. Those
 * exist because a surface that nobody measures drifts silently; this one exists because a
 * removed or renamed export does not fail a build, it fails a *consumer's* build, possibly
 * on someone else's machine and possibly months later. The repo already believes in
 * measuring the surface rather than trusting it, and the published entry is the surface
 * with the most expensive failure.
 *
 * ## What makes the determinism half non-tautological
 *
 * Every reproducibility claim is checked twice on the same comparison code: once that a
 * fixed seed reproduces byte for byte, and once that a *different* seed does not. A "same
 * seed, same bytes" assertion on its own is satisfied by an empty archive, a hard-coded
 * constant, or a comparison that never runs. The paired negative assertion fails all three.
 * This is the same discipline `determinism.test.ts` and `serialize-reproducible.test.ts`
 * use, and it is the reason those files are trusted.
 */

const ENTRY_PATH = new URL('../../../scripts/npm-index.ts', import.meta.url);

/**
 * The exact public surface, sorted.
 *
 * `STABLE` is the versioned contract; `INTERNAL` is the shipped escape hatch. Both are
 * listed, because the failure modes differ: dropping a stable export is a breaking change
 * that must be a decision, and dropping an internal namespace is still a breaking change
 * for anyone who used it, so neither should happen by accident.
 */
const STABLE = ['API_VERSION', 'VERSION', 'buildAnimation', 'buildSprite', 'exportAssets'];
const INTERNAL = ['core', 'mcp', 'script'];
const PUBLIC_SURFACE = [...STABLE, ...INTERNAL].sort();

/** A 16x16 four-frame walk cycle: an ellipse body on frame 0, a leg on frame 1. */
function walkSpec(seed: number) {
  return {
    seed,
    width: 16,
    height: 16,
    name: 'walk',
    layers: ['base', 'shade'],
    frames: 4,
    frameDurationMs: 120,
    palette: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'],
    ops: [
      { command: 'draw_ellipse', params: { rect: { x: 2, y: 4, w: 12, h: 10 }, color: '#8bac0f' } },
      { command: 'draw_ellipse', params: { frame: 1, rect: { x: 4, y: 5, w: 2, h: 8 }, color: '#0f380f' } },
      { command: 'add_palette_ramp', params: { from: '#0f380f', to: '#9bbc0f', steps: 4, role: 'skin' } },
    ],
    tags: [{ name: 'walk', from: 0, to: 3, direction: 'forward' as const }],
  };
}

/** The same ramp and layers, as a single frame, for the `buildSprite` half of the contract. */
function blobSpec(seed: number) {
  return {
    seed,
    width: 16,
    height: 16,
    name: 'blob',
    layers: ['base', 'shade'],
    palette: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'],
    ops: [
      { command: 'draw_ellipse', params: { rect: { x: 2, y: 4, w: 12, h: 10 }, color: '#8bac0f' } },
      { command: 'add_palette_ramp', params: { from: '#0f380f', to: '#9bbc0f', steps: 4, role: 'skin' } },
    ],
  };
}

/** Every `AssetFile` as `[path, bytes]`, so two runs can be compared without the wrapper. */
function asPairs(sprite: Sprite): Array<[string, Uint8Array]> {
  return entry
    .exportAssets(sprite, {
      frames: true,
      sheet: { layout: 'grid', columns: 4 },
      gif: { scale: 2 },
      source: true,
    })
    .map((file) => [file.path, file.bytes]);
}

/* ------------------------------------------------------------------ *
 * The pinned surface
 * ------------------------------------------------------------------ */

describe('the published library surface', () => {
  it('exports exactly the pinned list — no more, no less', () => {
    expect(Object.keys(entry).sort()).toEqual(PUBLIC_SURFACE);
  });

  it('names the three task-shaped entry points, and they are functions', () => {
    for (const name of ['buildSprite', 'buildAnimation', 'exportAssets'] as const) {
      expect(typeof entry[name], `${name} must be callable`).toBe('function');
    }
  });

  it('keeps the three namespaces working, because the README documents them', () => {
    // Backwards compatibility, checked rather than assumed. The README's library section
    // shows exactly these three calls, so if this fails, a documented example is broken.
    expect(typeof entry.core.createSprite).toBe('function');
    expect(typeof entry.mcp.createPixelServer).toBe('function');
    expect(typeof entry.script.ScriptRuntime).toBe('function');
  });

  it('pins API_VERSION, which is the versioning policy made checkable', () => {
    // Changing this string is a deliberate act: it is the contract in docs/API.md. If a
    // future change is additive (a new export, a new optional plan field) the version
    // stays put; if it renames or removes something, this line has to change with the
    // doc, in the same commit, on purpose.
    expect(entry.API_VERSION).toBe('1');
  });

  it('keeps VERSION, the package version, distinct from the API version', () => {
    expect(entry.VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('never imports a filesystem module, so exportAssets cannot write anything', () => {
    // `exportAssets` promises bytes and no side effects. A promise like that decays through
    // a well-meaning `writeFile` six months from now, and the only thing that catches it is
    // an assertion that nobody thought to add. Comments and doc blocks are stripped first:
    // prose *about* the filesystem must not satisfy, or break, a guard about it.
    const source = readFileSync(ENTRY_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\r\n]*/g, '$1 ');
    expect(source).not.toMatch(/from\s+'node:fs|require\(.node:fs/);
    expect(source).not.toMatch(/\b(writeFile|writeFileSync|mkdir|appendFile)\b/);
  });
});

/* ------------------------------------------------------------------ *
 * It goes through the real command bus
 * ------------------------------------------------------------------ */

describe('buildSprite goes through the command bus', () => {
  it('rejects a command that is not in the catalogue, naming the op', () => {
    expect(() => entry.buildSprite({ width: 8, height: 8, ops: [{ command: 'draw_a_cat' }] })).toThrow(
      /ops\[0\] \(draw_a_cat\) failed: Unknown command/,
    );
  });

  it('reports a mistyped parameter as invalid_params, not as a silent default', () => {
    // The bus's own zod schema, unmodified. If this ever starts passing, someone has
    // softened `.strict()` somewhere, and that is a product decision, not a bug fix.
    let thrown: unknown;
    try {
      entry.buildSprite({
        width: 8,
        height: 8,
        ops: [{ command: 'draw_rect', params: { rect: { x: 0, y: 0, w: 4 }, colour: '#fff' } }],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(entry.core.CommandError);
    expect((thrown as entry.core.CommandError).code).toBe('invalid_params');
    expect((thrown as Error).message).toMatch(/ops\[0\] \(draw_rect\)/);
  });

  it('fills the bottom layer and frame 0 for a command that requires them', () => {
    // No `layer` and no `frame` anywhere in that op. It works because the entry uses core's
    // own `fillCommandDefaults`, the same rule the MCP tool surface and scripts use — a
    // build script and an agent spell their ops the same way.
    const sprite = entry.buildSprite({
      width: 8,
      height: 8,
      palette: ['#000000', '#ffffff'],
      ops: [{ command: 'draw_rect', params: { rect: { x: 0, y: 0, w: 4, h: 4 }, color: '#ffffff', fill: true } }],
    });
    const cel = sprite.frames[0].cels.get(sprite.layers[0].id);
    expect(cel, 'the bottom layer of frame 0 should hold the fill').toBeDefined();
    expect(cel!.getColor(3, 3).r).toBe(255);
  });

  it('rejects a canvas size that would silently become NaN', () => {
    // `createSprite` clamps with `Math.max(1, Math.floor(...))`, which turns a typo into
    // NaN rather than into an error. The entry checks first, on purpose.
    expect(() => entry.buildSprite({ width: 0, height: 8 })).toThrow(/width must be a positive integer/);
    expect(() => entry.buildSprite({ width: 8.5, height: 8 })).toThrow(/width must be a positive integer/);
  });
});

/* ------------------------------------------------------------------ *
 * Reproducibility
 * ------------------------------------------------------------------ */

describe('the entry points are byte-reproducible under a fixed seed', () => {
  it('buildSprite: same seed, same `.pixel` bytes — and a different seed, different bytes', () => {
    const a = entry.core.serializeSprite(entry.buildSprite(blobSpec(1234)));
    const b = entry.core.serializeSprite(entry.buildSprite(blobSpec(1234)));
    const other = entry.core.serializeSprite(entry.buildSprite(blobSpec(9999)));

    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    // The negative half. Ids reach the `.pixel` manifest, so a different seed has to move
    // the bytes; if this ever passes, the seed is being ignored somewhere in the chain.
    expect(Buffer.from(a).equals(Buffer.from(other))).toBe(false);
    expect(a.length).toBeGreaterThan(200);
  });

  it('buildAnimation: same seed, same bytes; different seed, different bytes', () => {
    const a = entry.core.serializeSprite(entry.buildAnimation(walkSpec(7)));
    const b = entry.core.serializeSprite(entry.buildAnimation(walkSpec(7)));
    const other = entry.core.serializeSprite(entry.buildAnimation(walkSpec(8)));

    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(a).equals(Buffer.from(other))).toBe(false);
  });

  it('is reproducible by default, with no seed at all', () => {
    // Omitting `seed` means 0, and 0 is a seed. Reproducibility being opt-in would be a
    // footgun in a build pipeline: the first person who forgets it gets a diff they cannot
    // explain.
    const a = entry.core.serializeSprite(entry.buildSprite({ width: 8, height: 8, name: 'x' }));
    const b = entry.core.serializeSprite(entry.buildSprite({ width: 8, height: 8, name: 'x' }));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('reproduces across two builds in one process, and the id factory does not leak', () => {
    // The factory is installed per call and removed again, so the second build is seeded
    // from scratch and the process ends up in the state a fresh one would be in. A leaked
    // deterministic factory would make two unrelated documents in one process collide ids.
    const first = entry.buildAnimation(walkSpec(42));
    const second = entry.buildAnimation(walkSpec(42));
    expect(first.id).toBe(second.id);

    const marker = 'MARKER-FACTORY';
    setIdFactory((prefix) => `${prefix}-${marker}`);
    expect(makeId('lay')).toBe(`lay-${marker}`);
    entry.buildAnimation(walkSpec(42));
    expect(makeId('lay')).not.toBe(`lay-${marker}`);
    setIdFactory(null);
  });

  it('exportAssets is a pure function of the sprite it is handed', () => {
    const sprite = entry.buildAnimation(walkSpec(555));
    const first = asPairs(sprite);
    const second = asPairs(sprite);
    expect(first.map(([path]) => path)).toEqual(second.map(([path]) => path));
    for (let i = 0; i < first.length; i++) {
      expect(Buffer.from(first[i][1]).equals(Buffer.from(second[i][1])), first[i][0]).toBe(true);
    }
    expect(first.length).toBe(8); // 4 frames + sheet + sheet json + gif + source
  });
});

/* ------------------------------------------------------------------ *
 * The output contract an engine reads
 * ------------------------------------------------------------------ */

describe('exportAssets returns engine-ready files, as bytes', () => {
  it('names and labels every output, and folds a hostile name into one flat segment', () => {
    const files = entry.exportAssets(entry.buildAnimation(walkSpec(3)), {
      frames: true,
      sheet: { layout: 'grid', columns: 4 },
      gif: true,
      source: true,
      // A sprite name is free text and becomes a file name, so the separators and spaces
      // have to go. The dots survive because they are legal in a filename; what matters is
      // that no path separator does, so the result can only ever be one segment joined
      // safely onto whatever root the caller chose.
      name: 'hero/../walk cycle',
    });

    expect(files.map((f) => [f.path, f.kind, f.mediaType])).toEqual([
      ['hero-..-walk-cycle_0.png', 'frame', 'image/png'],
      ['hero-..-walk-cycle_1.png', 'frame', 'image/png'],
      ['hero-..-walk-cycle_2.png', 'frame', 'image/png'],
      ['hero-..-walk-cycle_3.png', 'frame', 'image/png'],
      ['hero-..-walk-cycle_sheet.png', 'sheet', 'image/png'],
      ['hero-..-walk-cycle_sheet.json', 'sheet-json', 'application/json'],
      ['hero-..-walk-cycle.gif', 'gif', 'image/gif'],
      ['hero-..-walk-cycle.pixel', 'source', 'application/zip'],
    ]);
    for (const file of files) {
      expect(file.path).not.toMatch(/[/\\]/);
      expect(file.bytes.length, file.path).toBeGreaterThan(0);
      expect(file.bytes).toBeInstanceOf(Uint8Array);
    }
  });

  it('keeps the sheet JSON describing the same geometry as the sheet PNG', () => {
    // The point of scaling the atlas rather than the image: an engine that slices the sheet
    // reads the geometry the PNG actually has. If the JSON and the image ever disagree,
    // every frame in the game is offset, and nothing else would notice.
    const [sheet, table] = entry.exportAssets(entry.buildAnimation(walkSpec(3)), {
      sheet: { layout: 'grid', columns: 4 },
      scale: 3,
      name: 'walk',
    });
    const meta = JSON.parse(new TextDecoder().decode(table!.bytes)) as {
      frames: Record<string, { frame: { w: number; h: number } }>;
      meta: { size: { w: number; h: number }; frameTags: Array<{ name: string; from: number; to: number }> };
    };
    expect(meta.meta.size).toEqual({ w: 16 * 4 * 3, h: 16 * 3 });
    expect(Object.keys(meta.frames)).toHaveLength(4);
    expect(Object.values(meta.frames)[0].frame).toMatchObject({ w: 48, h: 48 });
    expect(meta.meta.frameTags).toEqual([{ name: 'walk', from: 0, to: 3, direction: 'forward' }]);
    expect(sheet!.path).toBe('walk_sheet.png');
  });

  it('refuses a plan that selects nothing instead of quietly returning an empty array', () => {
    // A build that produces no files and reports success is the worst outcome available,
    // and it is the one a defaulted plan would cause. There is no default plan for that
    // reason.
    expect(() => entry.exportAssets(entry.buildSprite({ width: 8, height: 8 }), {})).toThrow(
      /selected no outputs/,
    );
  });

  it('rejects a scale that is not a positive integer', () => {
    expect(() => entry.exportAssets(entry.buildSprite({ width: 8, height: 8 }), { sheet: true, scale: 0 })).toThrow(
      /scale must be a positive integer/,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Structure
 * ------------------------------------------------------------------ */

describe('buildAnimation builds the structure a recipe needs', () => {
  it('creates the frames, layers and tags the spec asked for', () => {
    const sprite = entry.buildAnimation(walkSpec(11));
    expect(sprite.frames).toHaveLength(4);
    expect(sprite.layers.map((l) => l.name)).toEqual(['base', 'shade']);
    expect(sprite.frames.map((f) => f.durationMs)).toEqual([120, 120, 120, 120]);
    expect(sprite.tags).toHaveLength(1);
    expect(sprite.tags[0]).toMatchObject({ name: 'walk', from: 0, to: 3, direction: 'forward', repeat: 0 });
  });

  it('routes tags through upsert_tags, so a bad range fails the way the CLI fails', () => {
    expect(() => entry.buildAnimation({ ...walkSpec(11), tags: [{ name: 'walk', from: 0, to: 99 }] })).toThrow(
      /upsert_tags failed/,
    );
  });

  it('keeps the palette roles an op created, which is what shading binds to', () => {
    const sprite = entry.buildAnimation(walkSpec(11));
    expect(sprite.palette.roles).toBeDefined();
    expect(Object.values(sprite.palette.roles!)).toContain('skin');
  });
});
