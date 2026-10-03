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
// Extended additively by T-1xx: the 8-direction angle model and walk generator
// (`getDirectionModel`, `buildWalkAnimation`), the asset contract and engine importers
// (`exportEngineAssets`), and SVG trace import (`traceSvg`). Four new names, no removal and
// no signature change, which is why `API_VERSION` below stays at `'1'` — `docs/API.md` calls
// an added export an additive change, and this array is the check that the addition is only
// an addition.
const STABLE = [
  'API_VERSION',
  'VERSION',
  'buildAnimation',
  'buildSprite',
  'buildWalkAnimation',
  'exportAssets',
  'exportEngineAssets',
  'getDirectionModel',
  'traceSvg',
];
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

/* ------------------------------------------------------------------ *
 * The four that arrived with 8-direction, the contract and SVG import
 * ------------------------------------------------------------------ */

/** A rig, a rest pose and one gait: the spec `buildWalkAnimation` is documented with. */
function walkRigSpec(seed: number) {
  return {
    seed,
    width: 32,
    height: 32,
    name: 'hero',
    layers: ['body', 'legL', 'legR'],
    direction: 'S' as const,
    walk: { frames: 6, stride: 3 },
    ops: [
      {
        command: 'create_rig',
        params: {
          parts: [
            { name: 'body', pivot: { x: 16, y: 10 } },
            { name: 'legL', pivot: { x: 14, y: 20 }, parent: 'body' },
            { name: 'legR', pivot: { x: 18, y: 20 }, parent: 'body' },
          ],
        },
      },
      { command: 'draw_rect', params: { layer: 'body', rect: { x: 12, y: 8, w: 8, h: 12 }, color: '#8bac0f' } },
      { command: 'draw_rect', params: { layer: 'legL', rect: { x: 13, y: 20, w: 2, h: 8 }, color: '#0f380f' } },
      { command: 'draw_rect', params: { layer: 'legR', rect: { x: 17, y: 20, w: 2, h: 8 }, color: '#0f380f' } },
    ],
  };
}

/** A tagged four-frame animation, for the engine bundle. */
function heroAnim(seed: number) {
  return entry.buildAnimation({
    seed,
    width: 16,
    height: 16,
    name: 'hero',
    layers: ['base'],
    frames: 4,
    frameDurationMs: 120,
    tags: [{ name: 'walk', from: 0, to: 3 }],
    ops: [{ command: 'draw_rect', params: { rect: { x: 2, y: 2, w: 8, h: 8 }, color: '#8bac0f' } }],
  });
}

describe('getDirectionModel answers "which three sheets do I have to draw"', () => {
  it('separates the four exact directions from the four diagonals', () => {
    const model = entry.getDirectionModel({ width: 32, height: 32 });
    // The negative half matters: a model that reported eight exact directions would make an
    // eight-direction set look like eight drawings, which is the mistake it exists to prevent.
    expect(model.exact).toEqual(['N', 'E', 'S', 'W']);
    expect(model.approximate).toEqual(['NE', 'SE', 'SW', 'NW']);
    expect(new Set(model.directions.map((d) => d.drawing))).toEqual(new Set(['E', 'NE', 'SE']));
  });

  it('turns about the anchor rather than sliding, on every direction', () => {
    // The claim the anchor exists for: applying the matrix to the pivot leaves it there. An
    // anchor that moved would make a character walk across the canvas when it turned.
    for (const anchor of ['ground', 'facing', 'origin'] as const) {
      const model = entry.getDirectionModel({ width: 32, height: 32 }, anchor);
      for (const direction of model.directions) {
        const m = direction.matrix;
        const mapped = {
          x: m.a * model.pivot.x + m.c * model.pivot.y + m.e,
          y: m.b * model.pivot.x + m.d * model.pivot.y + m.f,
        };
        expect(mapped.x, `${anchor}/${direction.id}`).toBeCloseTo(model.pivot.x, 10);
        expect(mapped.y, `${anchor}/${direction.id}`).toBeCloseTo(model.pivot.y, 10);
      }
    }
  });

  it('has integer coefficients, so two machines agree bit for bit', () => {
    // Not a style preference. `Math.sin` differs in the last ULP between V8, JSC and
    // SpiderMonkey, and a matrix that moves a pixel between engines is not debuggable from a
    // screenshot — so `determinism.test.ts` bans trigonometry from `src` and this asserts the
    // consequence on the published surface.
    for (const direction of entry.getDirectionModel({ width: 31, height: 17 }).directions) {
      for (const coefficient of Object.values(direction.matrix)) {
        expect(Number.isInteger(coefficient), `${direction.id}: ${coefficient}`).toBe(true);
      }
    }
  });

  it('refuses a canvas that would silently become NaN, and an unknown anchor', () => {
    expect(() => entry.getDirectionModel({ width: 0, height: 8 })).toThrow(/width must be a positive integer/);
    expect(() => entry.getDirectionModel({ width: 8, height: -1 })).toThrow(/height must be a positive integer/);
    expect(() => entry.getDirectionModel({ width: 8, height: 8 }, 'nose' as never)).toThrow(
      /anchor must be one of ground, facing, origin/,
    );
  });
});

describe('buildWalkAnimation goes through the bus like the other two', () => {
  it('bakes the frames and the looping tag, after the rig exists', () => {
    const walk = entry.buildWalkAnimation(walkRigSpec(7));
    // 1 rest frame + 6 gait frames, and the tag spans exactly the gait. If the walk op ran
    // *before* `create_rig` the count would be 0, which is why it is appended rather than
    // prepended.
    expect(walk.frames).toHaveLength(7);
    expect(walk.tags).toHaveLength(1);
    expect(walk.tags[0]).toMatchObject({ name: 'walk_s', from: 1, to: 6, direction: 'forward', repeat: 0 });
    expect(walk.rig?.parts.map((part) => part.name)).toEqual(['body', 'legL', 'legR']);
  });

  it('closes the loop without a duplicated end frame', () => {
    // Two halves, because either alone is satisfiable by something wrong.
    //
    // First, the *document* has exactly `1 + frames` frames: one rig rest frame plus the gait.
    // The failure this guards is `frames + 1` gait frames, where the last repeats the first.
    // That reads as a visible hitch and is what §4.6's `motion` dimension scores as a seam.
    const walk = entry.buildWalkAnimation({ ...walkRigSpec(7), walk: { frames: 4 } });
    expect(walk.frames).toHaveLength(5);
    expect(walk.tags[0]).toMatchObject({ from: 1, to: 4 });

    // Second, the *generator* really is periodic, so the loop closes: frame `n` of a walk cycle
    // is the same pose as frame `0`. This is the property the frame count above depends on, and
    // it lives in `core`, so it is asserted there rather than inferred from pixels — a pixel
    // comparison cannot tell "periodic" from "two adjacent frames happen to look alike".
    const rig = walk.rig!;
    const gait = { frames: 4 };
    expect(entry.core.walkCycleFrames(rig, gait)[4 % 4].transforms).toEqual(
      entry.core.walkCycleFrames(rig, gait)[0].transforms,
    );

    // And the frames are genuinely different from each other, so "periodic" is not "constant".
    const painted = (index: number): string =>
      [...walk.frames[index].cels.values()].map((cel) => cel.data.join(',')).join('|');
    expect(new Set([1, 2, 3, 4].map(painted)).size, 'a four-frame gait produced identical frames').toBeGreaterThan(1);
  });

  it('reports a missing rig as an op context, not as a surprise', () => {
    expect(() =>
      entry.buildWalkAnimation({ width: 8, height: 8, ops: [{ command: 'draw_rect', params: { rect: { x: 0, y: 0, w: 4, h: 4 }, color: '#fff' } }] }),
    ).toThrow(/generate_walk_cycle failed/);
  });

  it('rejects an unknown direction rather than defaulting one', () => {
    expect(() => entry.buildWalkAnimation({ ...walkRigSpec(7), direction: 'north' as never })).toThrow(
      /ops\[\d+\] \(generate_walk_cycle\) failed/,
    );
  });

  it('same seed, same bytes — and a different seed, different bytes', () => {
    const a = entry.core.serializeSprite(entry.buildWalkAnimation(walkRigSpec(11)));
    const b = entry.core.serializeSprite(entry.buildWalkAnimation(walkRigSpec(11)));
    const other = entry.core.serializeSprite(entry.buildWalkAnimation(walkRigSpec(12)));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(a).equals(Buffer.from(other))).toBe(false);
  });
});

describe('exportEngineAssets writes a bundle, not a folder', () => {
  it('returns the contract, the engine files and the sheet, as bytes', () => {
    const bundle = entry.exportEngineAssets(heroAnim(3), { engine: 'godot', sheet: true });
    expect(bundle.root).toBe('hero');
    expect(bundle.files.map((file) => [file.path, file.role])).toEqual([
      ['hero_sheet.png', 'sheet'],
      ['meta.json', 'contract'],
      ['hero.tres', 'godot-sprite-frames'],
      ['hero.tscn', 'godot-scene'],
    ]);
    for (const file of bundle.files) {
      expect(file.bytes.length, file.path).toBeGreaterThan(0);
      expect(file.bytes).toBeInstanceOf(Uint8Array);
    }
    // The contract is the identity a caller logs rather than re-deriving.
    expect(bundle.meta.asset.contentHash).toMatch(/^sha256:/);
    expect(bundle.naming.ok).toBe(true);
  });

  it('records the per-frame facings it was given, and refuses one it cannot map', () => {
    const bundle = entry.exportEngineAssets(heroAnim(3), {
      engine: 'godot',
      sheet: true,
      directions: ['S', 'SW', 'W', 'NW'],
    });
    expect(bundle.meta.frames.directions?.map((d) => d.facing)).toEqual(['S', 'SW', 'W', 'NW']);
    // The refusal is the point. A dropped facing is a character that faces the wrong way in the
    // game, and nothing downstream can trace it back.
    expect(() =>
      entry.exportEngineAssets(heroAnim(3), { engine: 'godot', directions: ['sideways', null, null, null] }),
    ).toThrow(/is not one of N, NE, E, SE, S, SW, W, NW or none/);
    expect(() =>
      entry.exportEngineAssets(heroAnim(3), { engine: 'godot', directions: ['S', 'S'] }),
    ).toThrow(/facing label\(s\) for 4 frames/);
  });

  it('omits the contract when asked, and names a bad engine and a bad scale', () => {
    expect(entry.exportEngineAssets(heroAnim(3), { engine: 'phaser', meta: false }).files.map((f) => f.path)).toEqual([
      'hero.phaser.mjs',
    ]);
    // A nested `directory` stays nested, and a hostile segment is still folded to one safe
    // file name — the sanitiser must not relocate a build's output by flattening the path.
    expect(entry.exportEngineAssets(heroAnim(3), { engine: 'phaser', directory: 'assets/hero set' }).root).toBe('assets/hero-set');
    // A traversal cannot survive: `..` is stripped to nothing by the sanitiser and becomes the
    // `sprite` fallback, so the result can only ever be segments joined onto a caller's root.
    expect(entry.exportEngineAssets(heroAnim(3), { engine: 'phaser', directory: '../../escape' }).root).toBe(
      'sprite/sprite/escape',
    );
    expect(() => entry.exportEngineAssets(heroAnim(3), { engine: 'love' as never })).toThrow(
      /Unknown engine "love".*godot, unity, phaser, excalidraw/,
    );
    expect(() => entry.exportEngineAssets(heroAnim(3), { engine: 'godot', scale: 0 })).toThrow(
      /scale must be a positive integer/,
    );
    // Godot takes no options, and says so rather than silently ignoring them.
    expect(() => entry.exportEngineAssets(heroAnim(3), { engine: 'godot', options: { textureKey: 'x' } })).toThrow(
      /Godot importer takes no options/,
    );
  });

  it('is a pure function of the sprite it is handed, like exportAssets', () => {
    const sprite = heroAnim(3);
    const first = entry.exportEngineAssets(sprite, { engine: 'unity', sheet: true });
    const second = entry.exportEngineAssets(sprite, { engine: 'unity', sheet: true });
    expect(first.files.map((f) => f.path)).toEqual(second.files.map((f) => f.path));
    for (let i = 0; i < first.files.length; i++) {
      expect(Buffer.from(first.files[i].bytes).equals(Buffer.from(second.files[i].bytes)), first.files[i].path).toBe(true);
    }
  });

  it('never writes a filesystem path, so the bytes stay the caller`s to place', () => {
    const bundle = entry.exportEngineAssets(heroAnim(3), { engine: 'excalidraw', sheet: true });
    for (const file of bundle.files) {
      expect(file.path, file.path).not.toMatch(/^([A-Za-z]:|[\\/])/);
    }
  });
});

describe('traceSvg is the road from vector to pixel', () => {
  const ICON = '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="16" height="16" fill="#8bac0f"/></svg>';

  it('paints the shape at its own fill, on the grid', () => {
    const sprite = entry.traceSvg({ svg: ICON, width: 16, height: 16, name: 'icon', seed: 1 });
    const cel = sprite.frames[0].cels.get(sprite.layers[0].id)!;
    expect(cel.getColor(4, 4)).toMatchObject({ r: 0x8b, g: 0xac, b: 0x0f, a: 255 });
    // Hard-edged by design: a traced outline is a pixel edge, not a ramp of alphas.
    expect(cel.getColor(0, 0)).toMatchObject({ a: 255 });
  });

  it('honours `scale` in SVG units per pixel, which is the one that gets guessed wrong', () => {
    // A 60-unit bar at `x = 100`, traced into a 32x16 canvas. At `scale: 1` it sits at
    // x=100..159, entirely off the canvas; at `scale: 5` at x=20..31, exactly filling the right
    // half; at `scale: 10` at x=10..16, the middle. Three steps, because a `scale` that was
    // ignored entirely would pass the first alone and one applied as a divisor instead of a
    // factor would pass none of them.
    //
    // Asserted on the **bounding box**, not on one sampled pixel. A single pixel is a
    // landmine: at `scale: 10` the shape is two pixels tall, so a probe reading the vertical
    // middle of the canvas reads *outside* it and concludes the tracer is broken. The box is
    // what "where did this land" actually means.
    const bar = '<svg xmlns="http://www.w3.org/2000/svg"><rect x="100" y="0" width="60" height="16" fill="#8bac0f"/></svg>';
    const box = (scale?: number): string => {
      const sprite = entry.traceSvg({ svg: bar, width: 32, height: 16, name: 'icon', scale });
      const cel = sprite.frames[0].cels.get(sprite.layers[0].id)!;
      let minX = 99;
      let maxX = -1;
      let minY = 99;
      let maxY = -1;
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 32; x++) {
          if (!cel.getColor(x, y).a) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      return maxX < 0 ? 'nothing' : `${minX}..${maxX} x ${minY}..${maxY}`;
    };
    expect(box(1), 'at scale 1 the bar is at x=100..159, entirely off a 32px canvas').toBe('nothing');
    expect(box(5), 'at scale 5 it is at x=20..31 and 4px tall').toBe('20..31 x 0..3');
    expect(box(10), 'at scale 10 it is at x=10..16 and 2px tall').toBe('10..16 x 0..1');
  });

  it('refuses what it cannot place honestly, naming which reason', () => {
    // Transforms are the interesting refusal: tracing untransformed geometry would put the
    // artwork in the wrong place and say nothing.
    for (const [svg, reason] of [
      ['<svg xmlns="http://www.w3.org/2000/svg"><g transform="scale(2)"><rect width="8" height="8" fill="#fff"/></g></svg>', 'svg_unsupported'],
      ['<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8" fill="url(#g)"/></svg>', 'svg_unsupported'],
      ['<svg xmlns="http://www.w3.org/2000/svg"><line x1="0" y1="0" x2="8" y2="8"/></svg>', 'svg_empty'],
      ['<svg xmlns="http://www.w3.org/2000/svg"><text>hi</text></svg>', 'svg_empty'],
    ] as const) {
      let thrown: unknown;
      try {
        entry.traceSvg({ svg, width: 16, height: 16, name: 'icon' });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `${reason}: nothing was thrown`).toBeInstanceOf(entry.core.CommandError);
      const error = thrown as entry.core.CommandError;
      // **The reason is nested, and that is asserted rather than wished away.**
      // `editor.execute` goes through `applyCommandWithSummary`, which re-wraps *every*
      // `apply` failure as `command_failed` and puts the original error — code, `details.reason`
      // and all — in `details`. So the machine-readable code a build script branches on is
      // `error.details.code`, and `error.details.details.reason` names which construct was
      // refused. Written down here because a caller who reads `error.code` and finds
      // `command_failed` will otherwise conclude the tracer refused for an unrelated reason.
      expect(error.code, `${reason}: outer code`).toBe('command_failed');
      expect(error.details, `${reason}: the original error must survive the wrap`).toMatchObject({
        code: 'invalid_params',
        details: { reason },
      });
    }
    // And an SVG with no fillable geometry says so rather than returning an untouched document
    // that the build script will happily ship.
    expect(() => entry.traceSvg({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>hi</text></svg>', width: 8, height: 8 })).toThrow(
      /No traceable filled geometry/,
    );
  });

  it('same SVG, same pixels — twice, and in two calls', () => {
    const a = entry.traceSvg({ svg: ICON, width: 16, height: 16, name: 'icon', seed: 5 });
    const b = entry.traceSvg({ svg: ICON, width: 16, height: 16, name: 'icon', seed: 5 });
    for (const sprite of [a, b]) {
      const file = entry.exportAssets(sprite, { frames: true })[0];
      expect(Buffer.from(file.bytes).equals(Buffer.from(entry.exportAssets(a, { frames: true })[0].bytes))).toBe(true);
      expect(file.path).toBe('icon_0.png');
    }
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
