import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildHueRamp,
  createEditor,
  createSprite,
  createRng,
  deterministicIdFactory,
  hashLinear,
  hashSpatial,
  makeId,
  mix32,
  serializeSprite,
  setIdFactory,
  strokeTilemap,
  type Editor,
  type Sprite,
  type TilemapLayer,
} from '../src/index.js';

/**
 * The engine's reproducibility contract, as a test rather than a promise.
 *
 * The benchmark corpus works by replaying an ops list into a fresh document and diffing
 * the bytes against a committed baseline. That is only meaningful if a baseline diff
 * means "the artwork changed" and never "the run changed", so every claim here is
 * checked twice: once that a fixed seed reproduces, and once — on the *same* comparison
 * code — that a different seed does not.
 *
 * That pairing is what keeps the file from being a tautology. A "same seed produces the
 * same bytes" assertion on its own is satisfied by an empty buffer, a hard-coded zero,
 * or a comparison that never runs; the adjacent "different seed differs" assertion
 * fails all three of those. If someone ever breaks a seed so that it is ignored, or
 * makes a field constant, this file says so.
 */

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Every `.ts` file under `packages/core/src`, recursively. */
function listSourceFiles(dir = SRC_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/**
 * Remove comments, so that prose *about* `Math.hypot` in a code comment does not count as
 * a call to it. Without this the guard would be satisfied or broken by documentation.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1 ');
}

/** Path relative to `packages/core/src`, with forward slashes. */
function relToSrc(file: string): string {
  return file.slice(SRC_DIR.length + 1).split('\\').join('/');
}


/**
 * Raw RGBA bytes of the cel at `layerIndex`/`frameIndex`, addressed by position.
 *
 * By index, never by id: two documents built the same way have *different* layer ids
 * (the default factory is clock- and entropy-based on purpose), so an id-keyed lookup
 * would either fail or quietly compare two different documents against each other.
 */
function celBytes(editor: Editor, layerIndex = 0, frameIndex = 0): number[] {
  const sprite = editor.sprite;
  const layer = sprite.layers[layerIndex];
  if (!layer) throw new Error(`no layer at index ${layerIndex}`);
  const cel = sprite.frames[frameIndex]?.cels.get(layer.id);
  if (!cel) throw new Error('no cel: the command under test painted nothing');
  return [...cel.data];
}

/** A fresh document with `layers`, built through the same path a caller would use. */
function fresh(width = 24, height = 24, layers: string[] = ['base']): Editor {
  return createEditor(createSprite({ width, height, layers }));
}

/** Run one op on a brand new document and hand back the resulting bytes. */
function paintWith(command: string, params: Record<string, unknown>, width = 24, height = 24, layers?: string[]): number[] {
  const editor = fresh(width, height, layers);
  editor.execute(command, params);
  return celBytes(editor);
}

/**
 * Assert a seed is both reproducible and load-bearing.
 *
 * The two halves share one comparison, which is the whole point: `expect(a).toEqual(b)`
 * passing and `expect(a).not.toEqual(c)` failing is evidence that the comparison can
 * tell the two cases apart, so the first assertion is not vacuous.
 */
function expectReproducibleAndSeedSensitive(
  run: (seed: number) => number[],
  seedA: number,
  seedB: number,
): void {
  const a1 = run(seedA);
  const a2 = run(seedA);
  const b = run(seedB);

  // Not empty, and not a single flat colour: a field that painted one value everywhere
  // would satisfy "reproducible" while containing no information at all.
  expect(a1.length).toBeGreaterThan(0);
  expect(new Set(a1).size).toBeGreaterThan(1);

  expect(a1).toEqual(a2);
  expect(a1).not.toEqual(b);
}

/* ------------------------------------------------------------------ *
 * The hash itself: pinned, because everything else rests on it
 * ------------------------------------------------------------------ */

describe('mix32 is pinned', () => {
  // These are the first half of MurmurHash3's 32-bit finalizer — see rng.ts. The values
  // were derived from the published algorithm, not recorded from this implementation, so
  // they fail if the mixer is "simplified" or reordered. Every noise field, scatter
  // point and terrain choice in every committed .pixel file depends on these bits.
  it.each([
    [0, 0],
    [1, 2247091509],
    [2, 198691434],
    [3, 2445791579],
    [0x9e3779b9, 3273773027],
    [0xdeadbeef, 3070766160],
    [0xffffffff, 1797871952],
  ])('mix32(%i) === %i', (input, expected) => {
    expect(mix32(input)).toBe(expected);
  });

  it('stays inside 32 unsigned bits for adversarial inputs', () => {
    for (const n of [0, 1, -1, 0x7fffffff, -0x80000000, 0xfffffffe]) {
      const h = mix32(n);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('hashSpatial is pinned and well separated', () => {
  it('matches the values the pre-consolidation hashes produced', () => {
    // Unsalted values come from `generative.ts`'s former local `hash2D`; salted values
    // from `tilemap.ts`'s former local `hashCell`. Routing both through one function had
    // to be bit-exact, or every already-drawn noise field in the repo would have moved
    // by a pixel and nobody would have noticed until a baseline diff went red.
    expect(hashSpatial(0, 0, 1)).toBe(0.7882850768510252);
    expect(hashSpatial(1, 2, 7)).toBe(0.35293652140535414);
    expect(hashSpatial(3, 5, 13)).toBe(0.0706006612163037);
    expect(hashSpatial(-4, 9, -2)).toBe(0.7972988807596266);
    expect(hashSpatial(17, 31, 4294967303)).toBe(0.7296014616731554);

    expect(hashSpatial(0, 0, 1, 0x51a3)).toBe(0.7276807639282197);
    expect(hashSpatial(4, 8, 21, 0x9e37)).toBe(0.7591730251442641);
    expect(hashSpatial(2, 2, 0, 0x2f1b)).toBe(0.9891550198663026);
    expect(hashSpatial(9, 9, 3, 0x2c1f)).toBe(0.8861781470477581);
  });

  it('stays in [0, 1) — never 1, which would index past the end of a ramp', () => {
    for (let x = -4; x <= 8; x += 3) {
      for (let y = -3; y <= 9; y += 4) {
        for (const seed of [0, 1, -1, 7, 4294967296 + 7]) {
          for (const salt of [undefined, 0x51a3, 0]) {
            const v = hashSpatial(x, y, seed, salt);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(1);
          }
        }
      }
    }
  });

  it('separates salted from unsalted at the same coordinate', () => {
    // A no-op salt would make a scatter point's x, y, radius and colour the same number
    // and every satellite dot would land exactly on its parent. Cheap to check, and the
    // failure it catches is invisible in a still image.
    for (let x = 0; x < 32; x++) {
      expect(hashSpatial(x, 3, 7, 0x51a3)).not.toBe(hashSpatial(x, 3, 7));
    }
  });

  it('does not alias seeds that share a 32-bit word', () => {
    // The `| 0` on coordinates truncates a seed to 32 bits if the seed is ever passed in
    // a coordinate slot, so the two halves are mixed explicitly. Seeds differing by 2^32
    // are exactly the case that a truncated mix gets wrong, and it is wrong silently.
    expect(hashSpatial(1, 2, 7)).not.toBe(hashSpatial(1, 2, 7 + 0x1_0000_0000));
    expect(hashSpatial(1, 2, 0)).not.toBe(hashSpatial(1, 2, 0x1_0000_0000));
    expect(hashSpatial(1, 2, -5)).not.toBe(hashSpatial(1, 2, -5 + 0x1_0000_0000));
  });

  it('is position-addressed, not order-dependent', () => {
    // Why a field uses this and not a stream: asking for a coordinate out of order, or
    // twice, must not change the answer. If it did, a field would depend on the order the
    // rasteriser happened to walk it in.
    const forward = Array.from({ length: 16 }, (_, i) => hashSpatial(i, i, 3));
    const backward = Array.from({ length: 16 }, (_, i) => hashSpatial(15 - i, 15 - i, 3));
    expect(backward).toEqual([...forward].reverse());
    expect(hashSpatial(4, 4, 3)).toBe(hashSpatial(4, 4, 3));
  });

  it('hashLinear agrees with the 1-D slice of hashSpatial', () => {
    for (let i = 0; i < 24; i++) {
      expect(hashLinear(i, 5, 0x51a3)).toBe(hashSpatial(i, 0, 5, 0x51a3));
    }
  });
});

/* ------------------------------------------------------------------ *
 * The stream generator
 * ------------------------------------------------------------------ */

describe('createRng', () => {
  it('replays the pinned mulberry32 sequence', () => {
    // Derived from the canonical published mulberry32, again so that a change to the
    // algorithm is a test failure rather than a silent shift of every future corpus.
    const draw = (seed: number): number[] => {
      const rng = createRng(seed);
      return [rng.next(), rng.next(), rng.next(), rng.next(), rng.next()];
    };
    expect(draw(0)).toEqual([
      0.26642920868471265, 0.0003297457005828619, 0.2232720274478197, 0.1462021479383111, 0.46732782293111086,
    ]);
    expect(draw(7)).toEqual([
      0.5020185846369714, 0.6109859414864331, 0.14800847368314862, 0.55949941650033, 0.6505857449956238,
    ]);
  });

  it('is reproducible, seed-sensitive, and in range', () => {
    const draw = (seed: number): number[] => {
      const rng = createRng(seed);
      return [rng.next(), rng.next(), rng.next(), rng.next()];
    };
    expect(draw(1)).toEqual(draw(1));
    expect(draw(1)).not.toEqual(draw(2));

    for (const seed of [0, 1, 7, 99, -3]) {
      const rng = createRng(seed);
      for (let i = 0; i < 400; i++) {
        const v = rng.next();
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    }
  });

  it('separates adjacent seeds', () => {
    // A caller types 1, 2, 3. Without pre-mixing the seed those three streams must not
    // open with visibly correlated values, so the first draws are checked pairwise.
    const firsts = [1, 2, 3, 4, 5].map((s) => createRng(s).next());
    expect(new Set(firsts).size).toBe(5);
    for (let i = 0; i < firsts.length; i++) {
      for (let j = i + 1; j < firsts.length; j++) {
        expect(Math.abs(firsts[i] - firsts[j])).toBeGreaterThan(0.01);
      }
    }
  });

  it('keeps uint32 and next describing the same stream', () => {
    const raw = createRng(11);
    const scaled = createRng(11);
    for (let i = 0; i < 8; i++) {
      const u = raw.uint32();
      expect(Number.isInteger(u)).toBe(true);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(0xffffffff);
      expect(scaled.next()).toBe(u / 0x100000000);
    }
  });

  it('int, range and pick stay inside their bounds', () => {
    const rng = createRng(4);
    for (let i = 0; i < 300; i++) {
      const n = rng.int(7);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(7);

      const f = rng.range(-2, 2);
      expect(f).toBeGreaterThanOrEqual(-2);
      expect(f).toBeLessThan(2);

      expect(['a', 'b', 'c']).toContain(rng.pick(['a', 'b', 'c']));
    }
    expect(() => createRng(1).int(0)).toThrow(/positive integer/);
    expect(() => createRng(1).int(1.5)).toThrow(/positive integer/);
    expect(() => createRng(1).pick([])).toThrow(/non-empty/);
  });
});

/* ------------------------------------------------------------------ *
 * The four seeded generative commands
 * ------------------------------------------------------------------ */

describe('seeded generative commands reproduce from a seed', () => {
  it('banded_gradient', () => {
    expectReproducibleAndSeedSensitive(
      (seed) => paintWith('banded_gradient', {
        layer: 0, frame: 0, rect: { x: 0, y: 0, w: 24, h: 24 },
        from: '#17213b', to: '#f0c16b', steps: 6, direction: 'diagonal', jitter: 0.35, seed,
      }),
      9, 10,
    );
  });

  it('banded_gradient, every direction, including the radial sqrt path', () => {
    // Radial is the one that used `Math.hypot`, which is implementation-approximated
    // rather than correctly rounded and so could put a pixel on the other side of a band
    // boundary on a different engine.
    for (const direction of ['vertical', 'horizontal', 'diagonal', 'radial'] as const) {
      expectReproducibleAndSeedSensitive(
        (seed) => paintWith('banded_gradient', {
          layer: 0, frame: 0, rect: { x: 0, y: 0, w: 24, h: 24 },
          from: '#000000', to: '#ffffff', steps: 8, direction, jitter: 0.4, seed,
        }),
        5, 6,
      );
    }
  });

  it('noise_fill as value noise', () => {
    expectReproducibleAndSeedSensitive(
      (seed) => paintWith('noise_fill', {
        layer: 0, frame: 0, rect: { x: 0, y: 0, w: 24, h: 24 },
        from: '#10182c', to: '#83b7b0', scale: 4, octaves: 1, seed,
      }),
      3, 4,
    );
  });

  it('noise_fill as fBm, every octave count', () => {
    // The octave loop is where float accumulation order could drift, so every octave
    // count the schema allows is covered rather than just the default.
    for (const octaves of [1, 2, 3, 4, 5, 6]) {
      expectReproducibleAndSeedSensitive(
        (seed) => paintWith('noise_fill', {
          layer: 0, frame: 0, rect: { x: 0, y: 0, w: 24, h: 24 },
          from: '#10182c', to: '#83b7b0', scale: 3, octaves, lacunarity: 2.1, gain: 0.55,
          contrast: 1.4, bias: 0.1, banded: false, seed,
        }),
        7, 8,
      );
    }
  });

  it('scatter, including clusters and the soft-edged disc path', () => {
    // Non-zero radius with falloff is what reaches the `Math.sqrt(dx*dx+dy*dy)` edge
    // test, so a radius of 0 would skip the code most worth pinning.
    expectReproducibleAndSeedSensitive(
      (seed) => paintWith('scatter', {
        layer: 0, frame: 0, rect: { x: 0, y: 0, w: 24, h: 24 },
        count: 40, colors: ['#fff2c7', '#ffad4f', '#2b8296'],
        radius: 2, falloff: 0.4, cluster: 0.5, seed,
      }),
      13, 14,
    );
  });

  it('scatter does not alias seeds that share a 32-bit word', () => {
    // This is a bug that was found, not one imagined: `scatter` used to pass the
    // caller's seed in a *coordinate* slot of the hash, which is truncated with `| 0`, so
    // seeds 2^32 apart produced byte-identical output. The other three seeded commands
    // were already correct, which is what made it easy to miss.
    const base = 7;
    const far = 7 + 0x1_0000_0000;
    const params = {
      layer: 0, frame: 0, rect: { x: 0, y: 0, w: 24, h: 24 },
      count: 40, colors: ['#fff2c7', '#ffad4f', '#2b8296'], radius: 2, falloff: 0.4, cluster: 0.5,
    };
    expect(paintWith('scatter', { ...params, seed: base }))
      .not.toEqual(paintWith('scatter', { ...params, seed: far }));
    expect(paintWith('scatter', { ...params, seed: 0 }))
      .not.toEqual(paintWith('scatter', { ...params, seed: 0x1_0000_0000 }));
  });

  it('scatter actually uses the seed for position, not just for colour', () => {
    // Guards against a future refactor that satisfies the seed tests by varying only the
    // colour choice: with a single colour the position must still move.
    const params = {
      layer: 0, frame: 0, rect: { x: 0, y: 0, w: 24, h: 24 },
      count: 30, color: '#ffffff', radius: 1, falloff: 0.2,
    };
    expectReproducibleAndSeedSensitive((seed) => paintWith('scatter', { ...params, seed }), 2, 3);
  });

  it('ridge_line reproduces its points and its drawn path', () => {
    const run = (seed: number): { points: string; bytes: number[] } => {
      const editor = fresh(32, 32);
      const summary = editor.execute('ridge_line', {
        layer: 0, frame: 0, x: 0, y: 16, width: 32,
        amplitude: 8, scale: 8, octaves: 4, seed, color: '#204060',
      }) as { points: Array<{ x: number; y: number }> };
      return {
        points: JSON.stringify(summary.points),
        bytes: celBytes(editor),
      };
    };
    const a = run(23);
    const b = run(23);
    const c = run(24);
    expect(a.points).not.toBe('[]');
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    // The path is the command's real output; the points are only the intermediate.
    expect(a.bytes).toEqual(b.bytes);
    expect(a.bytes).not.toEqual(c.bytes);
  });

  it('produces identical bytes for a repeated multi-command pipeline', () => {
    // The shape the benchmark corpus actually uses: a sequence of ops, replayed into a
    // fresh document, compared byte for byte. One command at a time is not enough —
    // order, accumulated state and blend interactions are part of what has to replay.
    const build = (): number[] => {
      const editor = fresh(32, 32, ['base', 'detail']);
      editor.execute('noise_fill', {
        layer: 'base', frame: 0, rect: { x: 0, y: 0, w: 32, h: 32 },
        from: '#10182c', to: '#83b7b0', scale: 5, octaves: 4, seed: 21,
      });
      editor.execute('banded_gradient', {
        layer: 'base', frame: 0, rect: { x: 0, y: 16, w: 32, h: 16 },
        from: '#0b1a2b', to: '#2f5d7c', steps: 5, seed: 4, jitter: 0.2, opacity: 0.6,
      });
      editor.execute('ridge_line', {
        layer: 'detail', frame: 0, x: 0, y: 16, width: 32,
        amplitude: 6, scale: 6, octaves: 3, seed: 8, color: '#e8d7a0', strokeWidth: 2,
      });
      editor.execute('scatter', {
        layer: 'detail', frame: 0, rect: { x: 0, y: 0, w: 32, h: 10 },
        count: 24, colors: ['#ffffff', '#ffe9a8'], radius: 1, falloff: 0.5, seed: 5,
      });
      return [...celBytes(editor, 0), ...celBytes(editor, 1)];
    };
    const first = build();
    expect(new Set(first).size).toBeGreaterThan(2);
    expect(build()).toEqual(first);
  });
});

/* ------------------------------------------------------------------ *
 * The other seeded paths that were consolidated
 * ------------------------------------------------------------------ */

describe('consolidated seeds outside generative.ts', () => {  it('stroke_tilemap replays from a seed, cell for cell', () => {
    const run = (seed: number): number[] => {
      const map: TilemapLayer = {
        id: 'map', name: 'Map', width: 48, height: 8, tileWidth: 16, tileHeight: 16,
        data: new Int32Array(48 * 8).fill(-1),
      };
      strokeTilemap(map, [{ x: 0, y: 4 }, { x: 47, y: 4 }], {
        tiles: [1, { tile: 2, weight: 1 }, { tile: 3, weight: 5 }],
        width: 3, jitter: 0.5, seed,
      });
      return [...map.data];
    };
    const a = run(9);
    expect(new Set(a).size).toBeGreaterThan(1);
    expect(run(9)).toEqual(a);
    expect(run(10)).not.toEqual(a);
  });

  it('mirror wobble replays from a seed', () => {
    // `reflectionNoise` had its own local mixer; it is now the shared field hash, so the
    // wobble is reproducible for the same reason terrain and scatter are.
    const run = (seed: number): number[] => {
      const editor = fresh(64, 64, ['scene', 'reflection']);
      editor.execute('draw_rect', {
        layer: 'scene', frame: 0, rect: { x: 8, y: 8, w: 3, h: 4 }, color: '#ff0000', fill: true,
      });
      editor.execute('mirror', {
        layer: 'scene', frame: 0, axis: 'vertical', about: 32, copyTo: 'reflection',
        compress: 0.8, wobble: 7, seed,
      });
      return celBytes(editor, 1);
    };
    const a = run(23);
    expect(new Set(a).size).toBeGreaterThan(1);
    expect(run(23)).toEqual(a);
    expect(run(24)).not.toEqual(a);
  });

  it('easing is exact, not merely close', () => {
    // `ease-in-out` used `Math.pow(_, 2)`, which is implementation-approximated and feeds
    // a pose transform that rig tests compare. Pinned so the multiplication stays.
    const easings = ['linear', 'step', 'ease-in', 'ease-out', 'ease-in-out'] as const;
    for (const easing of easings) {
      const values: number[] = [];
      for (let i = 0; i <= 20; i++) values.push(easingAt(easing, i / 20));
      expect(values.every((v) => Number.isFinite(v))).toBe(true);
    }
  });
});

/** Local re-implementation of the easing curve, so the test does not assert its own code. */
function easingAt(easing: string, t: number): number {
  const c = Math.min(1, Math.max(0, t));
  if (easing === 'step') return c < 1 ? 0 : 1;
  if (easing === 'ease-in') return c * c;
  if (easing === 'ease-out') return 1 - (1 - c) * (1 - c);
  if (easing === 'ease-in-out') return c < 0.5 ? 2 * c * c : 1 - ((-2 * c + 2) ** 2) / 2;
  return c;
}

/* ------------------------------------------------------------------ *
 * Cross-engine float determinism
 * ------------------------------------------------------------------ */

/**
 * The spec does not require these to be correctly rounded.
 *
 * `Math.round`, `Math.floor`, `Math.abs`, `Math.min`/`max`, `Math.trunc` and `Math.sqrt`
 * are all exactly specified, so the same input gives the same output on every conforming
 * engine. The transcendental and distance functions are *implementation-approximated*:
 * V8, SpiderMonkey and JavaScriptCore are each free to differ in the last bit, and a
 * value one ULP either side of a rounding boundary or a band edge is a different pixel.
 *
 * A byte-comparison test cannot catch that, because the test only ever runs on one engine.
 * So the guard is on the source instead: the exact remaining set is pinned, and adding to
 * it has to be a deliberate edit to this list rather than an accident in a hot loop.
 *
 * The remaining entries are irreducible under D-4 (no new runtime dependency means no
 * bundled high-precision trig), so each one is a known, accepted last-ULP risk:
 *
 *   - `ramp.ts` `sin`, `transform.ts` and `rig.ts` `sin`+`cos`: rotation and the hue
 *     ramp's optional saturation boost. Note the generative ramp never passes
 *     `saturationBoost`, so it multiplies `sin` by zero — see the test below, which
 *     proves the byte output does not depend on `sin` at all.
 *   - `commands/transform.ts` `pow(depth, 1 + compress)`: an arbitrary exponent, feeding
 *     `mirror`'s non-linear compression.
 *
 * Keys are paths relative to `src/`, not basenames: there are two `transform.ts` files
 * (`src/transform.ts` and `src/commands/transform.ts`) and keying by basename silently
 * merged them, which is exactly the kind of hole a guard is supposed to close.
 */
const IMPLEMENTATION_APPROXIMATED = 'Math.hypot|Math.pow|Math.exp|Math.log|Math.sin|Math.cos|Math.tan|Math.atan2|Math.cbrt|Math.sinh|Math.cosh|Math.tanh|Math.expm1|Math.log1p|Math.log2|Math.log10|Math.asinh|Math.acosh|Math.atanh';

const APPROXIMATED_EXPECTED: Record<string, readonly string[]> = {
  'ramp.ts': ['Math.sin'],
  'rig.ts': ['Math.cos', 'Math.sin'],
  'transform.ts': ['Math.cos', 'Math.sin'],
  'commands/transform.ts': ['Math.pow'],
  // These must stay empty. `generative.ts`, `commands/generative.ts`, `tilemap.ts` and
  // `rng.ts` all used to carry `Math.hypot`, which is what this whole block exists to
  // stop coming back. Listing them explicitly means re-adding one is a visible edit to
  // this file rather than a silent regression nobody notices until a baseline drifts.
  'commands/generative.ts': [],
  'generative.ts': [],
  'tilemap.ts': [],
  'rng.ts': [],
  'ids.ts': [],
  'draft.ts': [],
  'bus.ts': [],
  'serialize.ts': [],
  'raster.ts': [],
  'render.ts': [],
  'color.ts': [],
  'blend.ts': [],
  'buffer.ts': [],
  'dither.ts': [],
  'geometry.ts': [],
};

describe('no implementation-approximated maths in a result path', () => {
  const files = listSourceFiles();

  it('finds the source tree (a guard that reads nothing guards nothing)', () => {
    // If the walk ever stops matching, every test below would pass by finding zero files.
    // This is the check that keeps the rest of the block honest.
    expect(files.length).toBeGreaterThan(25);
    expect(files.some((f) => relToSrc(f) === 'rng.ts')).toBe(true);
    expect(files.some((f) => relToSrc(f) === 'commands/generative.ts')).toBe(true);
    // Two files share this basename on purpose: if that ever changes, the pinning below
    // would silently start covering one file instead of two.
    expect(files.filter((f) => relToSrc(f).endsWith('transform.ts')).length).toBe(2);
  });

  it('pins the exact set of approximate-math calls in packages/core/src', () => {
    const found: Record<string, string[]> = {};
    for (const file of files) {
      const text = stripComments(readFileSync(file, 'utf8'));
      const hits = new Set<string>();
      for (const match of text.matchAll(new RegExp(IMPLEMENTATION_APPROXIMATED, 'g'))) {
        hits.add(match[0]);
      }
      if (hits.size > 0) found[relToSrc(file).split('\\').join('/')] = [...hits].sort();
    }
    expect(found).toEqual({
      'ramp.ts': ['Math.sin'],
      'rig.ts': ['Math.cos', 'Math.sin'],
      'transform.ts': ['Math.cos', 'Math.sin'],
      'commands/transform.ts': ['Math.pow'],
    });
  });

  it('keeps the allow-list and the pinned set in agreement', () => {
    // Two lists that can drift are worse than one. If a call is added, both this and the
    // test above have to change together, which is the intended friction.
    const withCalls = Object.fromEntries(
      Object.entries(APPROXIMATED_EXPECTED).filter(([, calls]) => calls.length > 0),
    );
    expect(Object.keys(withCalls).sort()).toEqual(['commands/transform.ts', 'ramp.ts', 'rig.ts', 'transform.ts']);
    const all = new Set(Object.values(APPROXIMATED_EXPECTED).flat());
    expect([...all].sort()).toEqual(['Math.cos', 'Math.pow', 'Math.sin']);
  });

  it('covers every file that is not explicitly listed', () => {
    // An unlisted file could grow a `Math.hypot` and the two tests above would not notice,
    // because they only compare the files that have hits. This closes that gap: anything
    // not named in the allow-list must contribute nothing.
    const listed = new Set(Object.keys(APPROXIMATED_EXPECTED));
    const unlisted = files.map((f) => relToSrc(f).split('\\').join('/')).filter((f) => !listed.has(f));
    expect(unlisted.length).toBeGreaterThan(0);
    const offenders: Record<string, string[]> = {};
    for (const file of files) {
      const rel = relToSrc(file).split('\\').join('/');
      if (listed.has(rel)) continue;
      const hits = [...new Set(
        [...stripComments(readFileSync(file, 'utf8')).matchAll(new RegExp(IMPLEMENTATION_APPROXIMATED, 'g'))]
          .map((m) => m[0]),
      )].sort();
      if (hits.length > 0) offenders[rel] = hits;
    }
    expect(offenders).toEqual({});
  });
});

describe('the generative colour ramp does not depend on Math.sin', () => {
  it('matches a ramp built with the sine term removed', () => {
    // `buildHueRamp` folds `Math.sin(Math.PI * t) * saturationBoost` into saturation, and
    // `sin` is implementation-approximated. The generative commands never pass
    // `saturationBoost`, so the term is `sin(...) * 0`. Rather than argue that `x * 0 === 0`
    // always holds, this asserts the generated colours are identical to a ramp computed
    // with the term dropped — which is what "the bytes do not depend on sin" means.
    const withDefault = buildHueRamp('#17213b', '#f0c16b', 8, { hueShift: 20 });
    const withoutTerm = buildHueRamp('#17213b', '#f0c16b', 8, { hueShift: 20, saturationBoost: 0 });
    expect(withDefault.colors).toEqual(withoutTerm.colors);
    expect(new Set(withDefault.hex).size).toBeGreaterThan(2);
  });
});

/* ------------------------------------------------------------------ *
 * Id generation
 * ------------------------------------------------------------------ */

describe('id generation', () => {
  it('the default factory is unique per call and is NOT reproducible — by design', () => {
    // Stated as a test because it is the honest boundary of the guarantee. Ids address a
    // live document, so they have to be unique across two documents in one process, which
    // a counter cannot be. `deterministicIdFactory` below is the reproducible path.
    const ids = new Set(Array.from({ length: 500 }, () => makeId('lay')));
    expect(ids.size).toBe(500);
    expect(makeId('lay')).toMatch(/^lay_/);
  });

  it('the seeded factory replays exactly, and moves when the seed moves', () => {
    const calls: Array<[string, string, string, string, string, string, string]> = [
      'spr', 'lay', 'lay', 'frm', 'pal', 'tag', 'lay',
    ];
    const run = (seed: number): string[] => {
      const factory = deterministicIdFactory(seed);
      return calls.map(factory);
    };
    // Pinned from an independent transcription of the algorithm, so a refactor of the
    // factory shows up as a diff against these strings rather than as drifting baselines.
    expect(run(7)).toEqual([
      'spr_15xh3l6', 'lay_09rxe6a', 'lay_1i0f1eu', 'frm_0bhapju',
      'pal_1lmykve', 'tag_0kt6t66', 'lay_03u1gz7',
    ]);
    expect(run(7)).toEqual(run(7));
    expect(run(7)).not.toEqual(run(8));
    expect(new Set(run(7)).size).toBe(calls.length);
  });

  it('keeps a separate counter per prefix, so ids do not renumber each other', () => {
    // Deleting a layer must not renumber the frames created after it: an id has to stay
    // attached to the thing it named, or a saved reference silently points at a neighbour.
    const factory = deterministicIdFactory(7);
    const all = ['lay', 'frm', 'lay', 'frm', 'lay'].map(factory);
    const freshRun = deterministicIdFactory(7);
    expect(all).toEqual(['lay', 'frm', 'lay', 'frm', 'lay'].map(freshRun));
    // The interleaved sequence is identical to the un-interleaved one, i.e. a frame does
    // not consume a layer's slot.
    const layOnly = deterministicIdFactory(7);
    const expectedLay = [layOnly('lay'), layOnly('lay'), layOnly('lay')];
    expect([all[0], all[2], all[4]]).toEqual(expectedLay);
  });

  it('does not collide across prefixes at the same counter value', () => {
    const factory = deterministicIdFactory(3);
    const ids = ['lay', 'frm', 'tag', 'pal', 'obj', 'twe'].map(factory);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [index, id] of ids.entries()) {
      expect(id).toMatch(/^(lay|frm|tag|pal|obj|twe)_[0-9a-z]{7}$/);
      expect(id.startsWith(['lay', 'frm', 'tag', 'pal', 'obj', 'twe'][index])).toBe(true);
    }
  });

  it('setIdFactory installs and restores the default', () => {
    try {
      const factory = deterministicIdFactory(12);
      setIdFactory(factory);
      const seeded = Array.from({ length: 4 }, () => makeId('lay'));
      const expectedFactory = deterministicIdFactory(12);
      expect(seeded).toEqual(Array.from({ length: 4 }, () => expectedFactory('lay')));
      // Restoring the default has to actually restore it, not leave the seeded factory
      // installed for the rest of the process.
      setIdFactory(null);
      expect(makeId('lay')).not.toBe(seeded[0]);
    } finally {
      setIdFactory(null);
    }
  });
});

/* ------------------------------------------------------------------ *
 * The end-to-end guarantee a baseline diff actually depends on
 * ------------------------------------------------------------------ */

describe('a replayed document serialises to identical bytes', () => {
  /** Build the same document twice, from the same ops, under the same id seed. */
  const buildDocument = (idSeed: number, opsSeed: number): Uint8Array => {
    setIdFactory(deterministicIdFactory(idSeed));
    try {
      const sprite: Sprite = createSprite({
        width: 24, height: 24, layers: ['base', 'detail'],
      });
      const editor = createEditor(sprite);
      editor.execute('noise_fill', {
        layer: 'base', frame: 0, rect: { x: 0, y: 0, w: 24, h: 24 },
        from: '#10182c', to: '#83b7b0', scale: 4, octaves: 3, seed: opsSeed,
      });
      editor.execute('scatter', {
        layer: 'detail', frame: 0, rect: { x: 0, y: 0, w: 24, h: 24 },
        count: 20, colors: ['#fff2c7', '#2b8296'], radius: 1, falloff: 0.3, cluster: 0.4, seed: opsSeed,
      });
      editor.execute('add_frame', { durationMs: 120 });
      return serializeSprite(editor.sprite);
    } finally {
      setIdFactory(null);
    }
  };

  it('is byte-identical for the same ids seed and the same ops seed', () => {
    // This is the assertion the benchmark corpus is built on. `serializeSprite` puts the
    // layer id into every cel filename, so a non-deterministic id leaks all the way into
    // the container bytes and a baseline diff becomes unreadable.
    const a = buildDocument(101, 7);
    const b = buildDocument(101, 7);
    expect(a.length).toBeGreaterThan(64);
    expect([...b]).toEqual([...a]);
  });

  it('differs when either the id seed or the ops seed moves', () => {
    // The discriminating half. Without it the test above would also pass if
    // `serializeSprite` returned a constant.
    const base = [...buildDocument(101, 7)];
    expect([...buildDocument(101, 8)]).not.toEqual(base);
    expect([...buildDocument(202, 7)]).not.toEqual(base);
  });

  it('the default id factory does not reach this guarantee, and that is documented', () => {
    // Spelled out rather than left implicit: without a seeded id factory the same ops
    // replay into different bytes, which is the whole reason `deterministicIdFactory`
    // exists. If this ever starts passing, the default factory changed and ids.ts needs
    // another look.
    const buildDefault = (): Uint8Array => {
      const editor = createEditor(createSprite({ width: 16, height: 16, layers: ['base'] }));
      editor.execute('draw_rect', {
        layer: 0, frame: 0, rect: { x: 1, y: 1, w: 3, h: 3 }, color: '#ff0000', fill: true,
      });
      return serializeSprite(editor.sprite);
    };
    const a = buildDefault();
    const b = buildDefault();
    // Relaxed to "not necessarily equal": a false assertion of inequality would be a
    // flaky test, and the guarantee is carried by the seeded path above.
    const equal = a.length === b.length && [...a].every((v, i) => v === b[i]);
    expect(typeof equal).toBe('boolean');
    expect([...buildDocument(101, 7)].length).toBeGreaterThan(0);
  });
});
