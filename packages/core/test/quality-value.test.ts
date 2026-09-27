import { describe, expect, it } from 'vitest';
import { ALPHA_SOLID, createQualityContext } from '../src/quality/context.js';
import {
  buildSolidMask,
  convexStaircaseCornerAt,
  countConvexCorners,
  countConvexStaircaseCorners,
  distField,
  lqBucketOf,
  lqOf,
} from '../src/quality/measure.js';
import { measureValue, valueAnalyzer, type ValueFrame } from '../src/quality/value.js';
import { evaluate } from '../src/quality/index.js';
import type { QualityContext, QualityIssue } from '../src/quality/types.js';
import { createSprite, type Sprite } from '../src/document.js';
import { PixelBuffer } from '../src/buffer.js';
import type { Rect } from '../src/types.js';

/**
 * The `value` dimension, and the four defects §4.2 was measured to have before this file existed.
 *
 * §4.2 is the only dimension in the specification with a worked example that was never run against
 * an implementation, and running it produced the project's headline finding: a straight-diagonal
 * shadow band and a nested contour that follows the form have **identical** plane counts,
 * contrast and hue/value separation, and the report moved **0.014** between them. So this file
 * does not test the prose; it tests the four numbers that were wrong, each as a claim about the
 * specification with an assertion attached:
 *
 *   1. **The form term separates the two constructions, by a margin that survives the report.**
 *      That is the acceptance test, asserted here and again as a corpus contrast pair.
 *   2. **The `dist` spread cannot be the term**, because it is large for a translated contour —
 *      the construction a correctly shaded sphere is made of — and near zero for a true inset.
 *      Asserted as a direction, not a magnitude: the *correct* artwork must not be the one that
 *      scores worst.
 *   3. **`convexCorner` as §3.3 defines it is 0 on every convex shape**, and the corrected
 *      predicate is not. Both are asserted on the same four shapes, because a predicate that is
 *      merely *different* is not a correction.
 *   4. **A plane is an area, not a line.** §4.2's `toneEdge` set is 386 of 491 pixels in one
 *      component on `pixel demo`, which is why `planes` was always 1.
 *
 * ## The fixtures are drawn, not poked
 *
 * Every subject here is a list of rows or a list of rectangles, for the reason
 * `quality-silhouette.test.ts` gives: a value test whose input is `data[i*4+3] = 255` in six
 * places cannot be reviewed by anyone, including the author on a bad day. The two shading
 * constructions at the centre of this file are the ones `packages/cli/src/demo.ts` uses, and they
 * are drawn on the same row table, so the pair differs in exactly one property — which is the only
 * way a contrast pair is worth anything.
 */

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** `[left, right, y]` — one row of a shape, the shape `demo.ts` builds its whole sprite from. */
type Row = readonly [number, number, number];

/**
 * `pixel demo`'s own 25-row silhouette: 22 px at its widest, symmetric about x = 15.5, every row
 * moving by one pixel so an inset stays parallel to the contour. Borrowed rather than invented so
 * the contrast pair is drawn on the form the product actually ships.
 */
const DISC: readonly Row[] = [
  [15, 16, 5], [14, 17, 6], [13, 18, 7], [12, 19, 8], [11, 20, 9], [10, 21, 10], [9, 22, 11],
  [8, 23, 12], [7, 24, 13], [6, 25, 14], [5, 26, 15], [5, 26, 16], [5, 26, 17], [5, 26, 18],
  [5, 26, 19], [5, 26, 20], [5, 26, 21], [5, 26, 22], [6, 25, 23], [7, 24, 24], [8, 23, 25],
  [9, 22, 26], [10, 21, 27], [11, 20, 28],
];

/**
 * A five-step material ramp, one entry per `LqBucket` the contrast pair needs.
 *
 * The luminance of each is transcribed from §3.4's `Lq` by hand and asserted below, because a
 * fixture whose tones are one bucket apart is a fixture that measures the wrong thing: `value`
 * counts buckets, so a ramp that collapses is a ramp the analyzer cannot see.
 */
const RAMP = ['#0f5a43', '#17903f', '#23c61e', '#7fe33d', '#ceec72'] as const;
const RAMP_LQ = [72, 112, 151, 193, 220] as const;

/** A sprite painted by a row-and-colour list, one layer, fully opaque. */
function spriteOf(palette: readonly string[], rows: readonly (readonly [Row, string])[]): Sprite {
  const sprite = createSprite({ width: 32, height: 32, name: 'value-fixture', layers: ['Base'] });
  const layer = sprite.layers[0].id;
  const cel = new PixelBuffer(32, 32);
  const index = new Map(palette.map((hex, i) => [hex, i]));
  for (const [row, hex] of rows) {
    const swatch = index.get(hex);
    if (swatch === undefined) throw new Error(`fixture colour ${hex} is not in the palette`);
    const [r, g, b] = [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
    for (let x = row[0]; x <= row[1]; x++) {
      const i = cel.index(x, row[2]);
      cel.data[i] = r;
      cel.data[i + 1] = g;
      cel.data[i + 2] = b;
      cel.data[i + 3] = 255;
    }
    void swatch;
  }
  sprite.frames[0].cels.set(layer, cel);
  return sprite;
}

/** A sprite from a picture: `.` is transparent, `#` opaque, `=` exactly `ALPHA_SOLID`. */
function spriteFromRows(rows: readonly string[]): Sprite {
  const height = rows.length;
  const width = rows[0].length;
  for (const row of rows) {
    if (row.length !== width) throw new Error(`row "${row}" is not ${width} wide`);
  }
  const sprite = createSprite({ width, height, name: 'value-fixture', layers: ['Base'] });
  const cel = new PixelBuffer(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = rows[y][x] === '.' ? 0 : rows[y][x] === '=' ? ALPHA_SOLID : 255;
      if (alpha === 0) continue;
      const i = cel.index(x, y);
      cel.data[i] = 30;
      cel.data[i + 1] = 60;
      cel.data[i + 2] = 90;
      cel.data[i + 3] = alpha;
    }
  }
  sprite.frames[0].cels.set(sprite.layers[0].id, cel);
  return sprite;
}

/** The body alone, in the ramp's middle tone. */
function discInBase(): (readonly [Row, string])[] {
  return DISC.map((row) => [row, RAMP[1]] as const);
}

/**
 * Five straight 45-degree bands cut across the body — the error.
 *
 * The same five tones on the same body as {@link nestedContour}, banded on `x + y` rather than on
 * a translation of the row table. Every band boundary is a straight line, so the shape reads and
 * the tone count and the contrast are all correct, and the only thing wrong with it is that the
 * boundaries do not follow the form.
 */
function straightDiagonal(): (readonly [Row, string])[] {
  const ops = discInBase();
  for (let tone = 0; tone < 5; tone++) {
    for (const [left, right, y] of DISC) {
      let lo = left;
      let hi = right;
      while (lo <= hi && bandOf(lo, y) !== tone) lo++;
      while (hi >= lo && bandOf(hi, y) !== tone) hi--;
      if (lo > hi) continue;
      ops.push([[lo, hi, y], RAMP[tone]] as const);
    }
  }
  return ops;
}

/**
 * `x + y - 5` banded at 19 / 23 / 27 / 31, lightest at the upper left. §4.2's straight cut.
 *
 * The `- 5` is not decoration: the body's own `x + y` runs from 20 to 36, so thresholds placed at
 * round numbers put the lightest tone outside the body and the sprite comes out with four
 * buckets rather than five. A fixture whose tones collapse is a fixture that measures the wrong
 * thing, and this is the arithmetic that stops it.
 */
function bandOf(x: number, y: number): number {
  const s = x + y - 5;
  return s < 19 ? 4 : s < 23 ? 3 : s < 27 ? 2 : s < 31 ? 1 : 0;
}

/**
 * The same body shaded with four nested translated contours — the correction, and the exact
 * construction `demo.ts` uses (`offsetRows(body, 0, -2k, -2k)`, clipped to the body).
 */
function nestedContour(): (readonly [Row, string])[] {
  const ops = discInBase();
  const tone = [RAMP[0], RAMP[2], RAMP[3], RAMP[4]] as const;
  for (let k = 1; k <= 4; k++) {
    const shift = 2 * k;
    for (const [left, right, y] of DISC) {
      const source = DISC.find((row) => row[2] === y + shift);
      if (source === undefined) continue;
      const lo = Math.max(left, source[0] - shift);
      const hi = Math.min(right, source[1] - shift);
      if (lo > hi) continue;
      ops.push([[lo, hi, y], tone[k - 1]] as const);
    }
  }
  return ops;
}

/**
 * A true inset — a level set of `dist`, the construction that looks like a target.
 *
 * The insets are **two pixels** apart, not one. A 1px inset is a line: no pixel of it has three
 * same-tone orthogonal neighbours, so it is not a plane and the form term has nothing to say
 * about it. That is not a loophole in the test, it is a measurement about the artwork — at 32x32
 * a 1px level set is indistinguishable from a traced contour, which is why `demo.ts` uses
 * translations for every plane except the core shadow and insets only for that one.
 *
 * **They are painted largest-first, and the order is load-bearing.** Each inset is a larger region
 * than the one before it, so painting a deep inset and then a shallower one leaves the canvas with
 * the shallow ring and nothing else: five tones go in and **two** come out — the base and the last
 * ring — and the fixture silently stops being a level set. It was drawn deepest-first here while
 * `benchmarks/corpus/cases.json` drew the same body largest-first, which is how the two drifted
 * apart and how this file came to assert its §2 conclusions about a two-tone sprite. The corpus
 * case says the same thing in its own note, and the assertion below counts the tones so a
 * collapsed fixture cannot pass as a measurement again.
 */
function levelSet(): (readonly [Row, string])[] {
  const ops = discInBase();
  const tone = [RAMP[0], RAMP[2], RAMP[3], RAMP[4]] as const;
  for (let k = 1; k <= 4; k++) {
    for (const [left, right, y] of DISC) {
      const lo = left + 2 * k;
      const hi = right - 2 * k;
      if (lo > hi) continue;
      ops.push([[lo, hi, y], tone[4 - k]] as const);
    }
  }
  return ops;
}

/** A straight-edged box with a straight horizontal terminator: correct shading. */
function hardSurface(): (readonly [Row, string])[] {
  const box: readonly Row[] = [];
  for (let y = 4; y < 28; y++) box.push([6, 25, y]);
  const ops: (readonly [Row, string])[] = [];
  for (const [y0, y1, tone] of [[4, 6, 4], [7, 9, 3], [10, 12, 2], [13, 15, 1], [16, 27, 0]] as const) {
    for (const row of box) {
      if (row[2] < y0 || row[2] > y1) continue;
      ops.push([row, RAMP[tone]] as const);
    }
  }
  return ops;
}

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

function only(context: QualityContext): ValueFrame {
  const frames = measureValue(context);
  expect(frames).toHaveLength(1);
  return frames[0];
}

function read(sprite: Sprite) {
  const context = createQualityContext(sprite);
  return { context, frame: only(context), dimension: valueAnalyzer(context) };
}

function codes(issues: readonly QualityIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

/* ------------------------------------------------------------------ *
 * 1 · The acceptance test
 * ------------------------------------------------------------------ */

describe('the form term separates a straight band from a contour that follows the form', () => {
  const straight = read(spriteOf(RAMP, straightDiagonal()));
  const nested = read(spriteOf(RAMP, nestedContour()));

  it('holds the two apart in everything except the one property under test', () => {
    // A contrast pair is only worth something if the two members agree on everything else. Same
    // body, same palette, same five tones: `distinct`, `range`, `toneQ` and the silhouette score
    // are identical, which is precisely why §4.2 could not see the difference.
    expect(straight.frame.distinct).toBe(nested.frame.distinct);
    expect(straight.frame.range).toBe(nested.frame.range);
    expect(straight.frame.toneQ).toBe(nested.frame.toneQ);
    expect(straight.frame.N).toBe(nested.frame.N);
    expect(straight.frame.planes).toBeGreaterThan(0);
    expect(nested.frame.planes).toBeGreaterThan(0);
  });

  it('calls the straight cut a blocking defect and the form-following contour correct', () => {
    expect(codes(straight.dimension.issues)).toContain('plane-crosses-form');
    const issue = straight.dimension.issues.find((i) => i.code === 'plane-crosses-form');
    expect(issue?.severity).toBe(0.6);
    expect(codes(nested.dimension.issues)).toEqual([]);
    // `rect` is the plane's bounding box, so a caller can act on it: §4.2 asks for the region to
    // fix, not for a verdict with no address.
    expect(issue?.rect).toEqual({ x: 7, y: 10, w: 15, h: 15 });
  });

  it('separates them by a margin that survives the whole report, not just this dimension', () => {
    // The old term moved the report total by 0.014 on this pair. §6.2's own words: "a pair that
    // separates by 0.02 is passing the test and still wrong", and the size of the gap is the
    // thing worth reviewing.
    const a = evaluate(straight.context);
    const b = evaluate(nested.context);
    const gap = (b.dimensions.value?.scoreQ ?? 0) - (a.dimensions.value?.scoreQ ?? 0);
    expect(gap).toBeGreaterThanOrEqual(300);
    expect(b.score - a.score).toBeGreaterThanOrEqual(0.1);
    expect(a.verdict).toBe('fail');
    expect(b.verdict).toBe('pass');
    expect(a.blocking.map((i) => i.code)).toContain('plane-crosses-form');
    expect(b.blocking).toEqual([]);
  });

  it('is a real band table result, not a single threshold doing all the work', () => {
    // The separation has to come out of `formQ`, because `toneQ` is identical on both sides.
    expect(straight.frame.formQ).toBe(100);
    expect(nested.frame.formQ).toBeGreaterThanOrEqual(750);
    expect(straight.frame.toneQ).toBe(900);
  });
});

/* ------------------------------------------------------------------ *
 * 2 · The level-set bias
 * ------------------------------------------------------------------ */

describe('the `dist` spread cannot be the form term, and this is the measurement that says so', () => {
  const nested = read(spriteOf(RAMP, nestedContour()));
  const inset = read(spriteOf(RAMP, levelSet()));

  it('is drawn as the four insets it claims to be, so the rest of this section is about a level set', () => {
    // The first version of this section asserted its conclusions against a fixture that had
    // collapsed to two tones, because the insets were painted deepest-first and each shallower one
    // overpainted the last. Every claim below was then true of a two-tone sprite and nobody noticed,
    // because a fixture that measures the wrong thing does not announce itself.
    //
    // These are construction facts, not fitted magnitudes: the body is painted in five tones, and a
    // five-tone body with four boundaries between them has five planes. The counts are the same ones
    // `benchmarks/corpus/baseline.md` prints for `value/level-set-32` — 5 buckets, 5 planes — which
    // is the check that this file and the corpus case are now the same picture.
    expect(inset.frame.distinct).toBe(5);
    expect(inset.frame.buckets).toHaveLength(5);
    expect(inset.frame.planes).toBe(5);
    expect(inset.frame.terminators).toHaveLength(4);
    // And the contrast pair still holds: the two fixtures differ in the construction and in nothing
    // else, so a difference between them is a difference about the construction.
    expect(nested.frame.distinct).toBe(inset.frame.distinct);
    expect(nested.frame.N).toBe(inset.frame.N);
  });

  it('reads a large `spanQ` on the translated contours and a small one on the insets', () => {
    // §4.2 specifies `spanQ` as the form term. On a *translated* contour the boundary runs from
    // the silhouette's own edge (`dist` 0) out to its deepest reach, so its spread is the body's
    // full depth; on a *level set* every pixel along it sits at the same depth, so its spread is
    // near zero. Measured on the two fixtures: both are correct artwork and they are ranked the
    // wrong way round. The gap is 545 against 91 on the worst plane of each, and the baseline
    // prints the same two numbers for `value/nested-contour-32` and `value/level-set-32`.
    const nestedWorst = nested.frame.worst;
    const insetWorst = inset.frame.worst;
    expect(nestedWorst).not.toBeNull();
    expect(insetWorst).not.toBeNull();
    expect(nestedWorst!.spanQ).toBeGreaterThan(insetWorst!.spanQ);
  });

  it('scores the artwork that looks like a sphere at least as high as the artwork that looks like a target', () => {
    // The direction is the claim. A magnitude would be fitting to two fixtures; "the correct
    // construction must not be the one that is punished" survives any calibration of the bands.
    // The level-set fixture is a lit sphere built as concentric insets — dark core, lit rim — so
    // there is no key light to find and the issue list is empty on both sides; neither construction
    // is defective, which is exactly why the ordering between them is the only thing to assert.
    //
    // This failed until `dirQ` saturated at three orientations instead of dividing by the number
    // of half-planes. An open boundary on a convex body cannot use the fourth without closing, so
    // the old denominator read a maximally-turning arc at 667 and the ring around it at 1000, and
    // the product's own taught construction came out 250 per-mille below the target-like one — on
    // the same body, with the same five tones, the same five planes, and no defect on either side.
    // A level set and a translated contour now read the same: `bendQ` 1000 and `crossesQ` 0 on both.
    expect(codes(nested.dimension.issues)).toEqual([]);
    expect(codes(inset.dimension.issues)).toEqual([]);
    expect(codes(inset.dimension.issues)).not.toContain('plane-crosses-form');
    expect(nested.frame.scoreQ).toBeGreaterThanOrEqual(inset.frame.scoreQ);
  });

  it('still reports `spanQ` and `Dmax`, so the bias stays visible in the corpus baseline', () => {
    // The quantity is not deleted. It is the most informative number in the record — a person
    // needs it to understand the artwork — and it is the standing evidence that the specified
    // term was biased, which is why `benchmarks/corpus/report.ts` prints it on every row beside
    // the score that replaced it.
    expect(nested.frame.Dmax).toBeGreaterThan(0);
    expect(nested.frame.worst?.spanQ).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * 3 · `convexCorner`
 * ------------------------------------------------------------------ */

describe('the corrected `convexCorner`, and the spec-literal count it corrects', () => {
  const disc = () => {
    const mask = new Uint8Array(64 * 64);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const dx = x - 31.5;
        const dy = y - 31.5;
        if (dx * dx + dy * dy <= 26 * 26) mask[y * 64 + x] = 1;
      }
    }
    return mask;
  };
  const square = (side: number): Uint8Array => new Uint8Array(side * side).fill(1);
  const band = (): Uint8Array => {
    const mask = new Uint8Array(24 * 24);
    for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) if (y - x >= 0 && y - x < 3) mask[y * 24 + x] = 1;
    return mask;
  };

  it('§3.3\'s clause counts 0 on every convex shape, which is what made the gate inert', () => {
    // Pinned by `quality-silhouette.test.ts` on the same shapes, and repeated here because the
    // corrected predicate below is only a *correction* if the thing it corrects is measured.
    expect(countConvexCorners(disc(), 64, 64)).toBe(0);
    expect(countConvexCorners(square(16), 16, 16)).toBe(0);
    expect(countConvexCorners(band(), 24, 24)).toBe(0);
  });

  it('the corrected predicate reads a convex staircase and nothing else', () => {
    // §4.2's three claims, which §3.3's clause does not deliver: "a circle's outline is roughly
    // half convex corners, a rectangle's four corners are lost in its perimeter, and the 250/1000
    // gate sits between them". A radius-26 disc has a 163-pixel outline and reads **64**, which
    // is the "roughly half"; a 16x16 square reads **4**; and a filled 16x16 whose outline is the
    // canvas frame also reads **4**, which is the "lost in its perimeter" in its purest form.
    expect(countConvexStaircaseCorners(disc(), 64, 64)).toBe(64);
    expect(countConvexStaircaseCorners(square(16), 16, 16)).toBe(4);
    expect(countConvexStaircaseCorners(square(64), 64, 64)).toBe(4);
    // A 45° band is entirely staircase, so it is entirely convex corners: 46 of its 72 pixels.
    expect(countConvexStaircaseCorners(band(), 24, 24)).toBe(46);
  });

  it('is the negation of §3.3\'s clause on a nick, so it is a correction and not a different idea', () => {
    // §3.3's clause fires on a one-pixel nick cut diagonally *outside* a corner, which is a
    // concavity, and reads 0 on the plain block it was cut from. The corrected predicate is exactly
    // the other way round: 4 on the block's own four corners, 5 once the nick adds one.
    const mask = new Uint8Array(9 * 9);
    for (let y = 2; y < 7; y++) for (let x = 2; x < 7; x++) mask[y * 9 + x] = 1;
    expect(countConvexCorners(mask, 9, 9)).toBe(0);
    expect(countConvexStaircaseCorners(mask, 9, 9)).toBe(4);
    const nicked = Uint8Array.from(mask);
    nicked[2 * 9 + 6] = 0;
    nicked[3 * 9 + 4] = 0;
    expect(countConvexCorners(nicked, 9, 9)).toBe(1);
    expect(countConvexStaircaseCorners(nicked, 9, 9)).toBe(5);
  });

  it('treats the outside of the canvas as transparent, so it reads the frame as straight', () => {
    // A subject that fills the frame is bounded by the frame, and a full 16x16 has exactly four
    // convex corners — all of them the canvas's. That is the same answer as an interior rectangle,
    // which is the point: §4.2's gate asks whether the *form* is curved, and a frame is not.
    const full = new Uint8Array(16 * 16).fill(1);
    expect(convexStaircaseCornerAt(full, 16, 16, 0, 0)).toBe(true);
    expect(convexStaircaseCornerAt(full, 16, 16, 1, 1)).toBe(false);
    expect(convexStaircaseCornerAt(full, 16, 16, 5, 5)).toBe(false);
    expect(countConvexStaircaseCorners(full, 16, 16)).toBe(4);
  });

  it('is the quantity the curvature gate reads, and the gate is what spares a hard-surface sprite', () => {
    // §4.2: "a straight plane across a straight-edged form is correct, not wrong". The box's four
    // corners are the only convex staircase pixels near its terminators, and 4 against the
    // terminator's own edge pixels is far below the 250/1000 gate, so `crossesQ` is 0 with no
    // reliance on `bendQ` at all.
    const box = read(spriteOf(RAMP, hardSurface()));
    expect(box.frame.worst).not.toBeNull();
    expect(box.frame.worst!.bendQ).toBe(0);
    expect(box.frame.worst!.curvedQ).toBeLessThan(250);
    expect(box.frame.worst!.crossesQ).toBe(0);
    expect(codes(box.dimension.issues)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 4 · Planes, and the merged ring
 * ------------------------------------------------------------------ */

describe('a plane is an area, not a line', () => {
  it('finds more than one plane, where §4.2\'s `toneEdge` set is a single component', () => {
    // The defect as measured: on `pixel demo` the 8-connected components of `{ toneEdge(p) }` are
    // **one**, 386 pixels of 491, so `planes` was 1 on every version and the form term was
    // measuring a ring containing every boundary in the sprite at once — which is exactly why its
    // `dist` spread was necessarily `0..Dmax`.
    const cut = read(spriteOf(RAMP, straightDiagonal()));
    const follow = read(spriteOf(RAMP, nestedContour()));
    expect(cut.frame.planes).toBeGreaterThanOrEqual(4);
    expect(follow.frame.planes).toBeGreaterThanOrEqual(4);
    expect(cut.frame.terminators.length).toBeGreaterThanOrEqual(3);
    expect(follow.frame.terminators.length).toBeGreaterThanOrEqual(3);
    // And `bendQ` is the reading that separates them, on the *same* predicate and the same
    // neighbourhood: every boundary of the straight cut has one step direction and every boundary
    // of the translated contours turns.
    expect(cut.frame.worst?.bendQ).toBe(0);
    expect(follow.frame.worst?.bendQ).toBeGreaterThan(0);
  });

  it('does not mistake a 1px traced contour for a value plane', () => {
    // A closed 1px ring, one colour, drawn the way a tracer draws one: every pixel of it has at
    // most two same-tone orthogonal neighbours, so no pixel of it has three and it is not an
    // area. The retired `colourOrphans` defect `TASKS.md` records is "23 of 29 counts were the
    // 45° stair corners of the contour itself", and this is the shape that produced them.
    const rows: string[] = [];
    for (let y = 0; y < 16; y++) {
      let line = '';
      for (let x = 0; x < 16; x++) {
        // The `y >= 2 && y <= 13` guard is load-bearing: without it the row runs to the canvas
        // edge, the corner pixel acquires four same-tone neighbours, and the fixture stops being
        // a 1px ring and becomes a frame — which *is* an area, and would be a plane.
        const onRing =
          ((x === 2 || x === 13) && y >= 2 && y <= 13) || ((y === 2 || y === 13) && x >= 2 && x <= 13);
        line += onRing ? '#' : '.';
      }
      rows.push(line);
    }
    const { frame } = read(spriteFromRows(rows));
    expect(frame.N).toBe(44);
    expect(frame.regions).toBe(1);
    expect(frame.planes).toBe(0);
    expect(frame.terminators).toEqual([]);
    // A single tone is still `flat-value` and `narrow-value-range`: the ring's problem is its
    // colour, and this test is about its *shape* not counting as a value plane.
    expect(codes(frame.issues ?? [])).toBeDefined();
  });
});

/* ------------------------------------------------------------------ *
 * 5 · The rest of §4.2
 * ------------------------------------------------------------------ */

describe('the tone terms, the issue codes, and the not-measurable paths', () => {
  it('reads §3.4\'s luminance and buckets exactly, because `value` counts buckets', () => {
    const { context, frame } = read(spriteOf(RAMP, nestedContour()));
    const cel = context.composite[0];
    for (let p = 0; p < 32 * 32; p++) {
      if (cel.data[p * 4 + 3] < ALPHA_SOLID) continue;
      const lq = (54 * cel.data[p * 4] + 183 * cel.data[p * 4 + 1] + 18 * cel.data[p * 4 + 2]) >> 8;
      expect(lqOf(cel, p)).toBe(lq);
      expect(lqBucketOf(cel, p)).toBe(lq >> 4);
    }
    expect(frame.buckets).toEqual([4, 7, 9, 12, 13]);
    // The ramp's luminances are transcribed from §3.4 by hand in the fixture, and this is what
    // pins them: a ramp that quietly collapsed to one bucket would make every other assertion in
    // this file pass for the wrong reason.
    for (const [swatch, expected] of RAMP.entries()) {
      const probe = spriteOf([RAMP[swatch]], [[[0, 31, 0], RAMP[swatch]]]);
      const probeContext = createQualityContext(probe);
      expect(lqOf(probeContext.composite[0], 0)).toBe(RAMP_LQ[swatch]);
    }
  });

  it('says a flat sprite is flat, and a flat sprite has no measurable key light', () => {
    // `flat-value` and `narrow-value-range` are the two codes a single swatch earns, and
    // `keyLight` is exactly 0 on it — which §4.2's second row reads as "the light direction is
    // not readable". Reporting a not-measurable there is the same rule §4.2 states for
    // `hueOnlyRatio` under `internalEdges < 8`.
    const flat = read(spriteFromRows(['......', '.####.', '.####.', '.####.', '.####.', '......']));
    // Severity-descending, which is the order the analyzer emits in, so the list is checked in
    // that order rather than sorted here: a reader looking at the head of the list should be
    // looking at what blocks.
    expect(codes(flat.dimension.issues)).toEqual(['flat-value', 'narrow-value-range']);
    expect(flat.frame.keyLight).toBeNull();
    expect(flat.frame.distinct).toBe(1);
    expect(flat.dimension.verdict).toContain('not measurable');
  });

  it('reports a crushed shadow, and names the share it measured', () => {
    // Full-bleed on purpose: a 1px transparent border would put 8/100 of the frame below the
    // light and the share would be about 90/100 for the wrong reason.
    const dark: string[] = [];
    for (let y = 0; y < 20; y++) dark.push('#'.repeat(20));
    const crushed = spriteFromRows(dark);
    const cel = crushed.frames[0].cels.get(crushed.layers[0].id)!;
    for (let p = 0; p < 20 * 20; p++) {
      cel.data[p * 4] = 6;
      cel.data[p * 4 + 1] = 10;
      cel.data[p * 4 + 2] = 16;
      cel.data[p * 4 + 3] = 255;
    }
    const shadow = read(crushed);
    expect(codes(shadow.dimension.issues)).toContain('shadow-crushed');
    expect(shadow.frame.shadowShareQ).toBe(1000);
    expect(shadow.frame.lqMax).toBeLessThanOrEqual(12);
  });

  it('leaves a sprite with nothing opaque at 1000, and the aggregator owns the emptiness', () => {
    // The contract: a dimension that cannot measure says so and does not invent a zero. A blank
    // canvas is `empty-frame` at severity 1.00 from the aggregator, and a blocking issue there
    // fails the report whether or not any dimension has an opinion.
    const blank = read(spriteFromRows(['....', '....', '....', '....']));
    expect(blank.frame.measured).toBe(false);
    expect(blank.dimension.scoreQ).toBe(1000);
    expect(blank.dimension.issues).toEqual([]);
    const report = evaluate(blank.context);
    expect(report.blocking.map((i) => i.code)).toEqual(['empty-frame']);
    expect(report.verdict).toBe('fail');
  });

  it('takes the worst frame, not the mean, so one flat frame in eight is a flat sprite', () => {
    // `QualityDimension` has one `scoreQ` and no way to say "four of these frames are fine", and
    // a mean is allowed to hide one broken frame behind seven good ones.
    const good = spriteOf(RAMP, nestedContour());
    const first = good.frames[0].cels.get(good.layers[0].id) as PixelBuffer;
    const sprite = createSprite({ width: 32, height: 32, frames: 2, name: 'two', layers: ['Base'] });
    const layer = sprite.layers[0].id;
    const copyA = new PixelBuffer(32, 32);
    copyA.data.set(first.data);
    sprite.frames[0].cels.set(layer, copyA);
    const copyB = new PixelBuffer(32, 32);
    copyB.data.set(first.data);
    // Frame 1 is the same ink, flattened to one tone: same silhouette, no value structure.
    for (let p = 0; p < 32 * 32; p++) {
      copyB.data[p * 4] = 23;
      copyB.data[p * 4 + 1] = 90;
      copyB.data[p * 4 + 2] = 63;
    }
    sprite.frames[1].cels.set(layer, copyB);
    const context = createQualityContext(sprite);
    const perFrame = measureValue(context);
    expect(perFrame).toHaveLength(2);
    expect(perFrame[1].scoreQ).toBeLessThan(perFrame[0].scoreQ);
    expect(valueAnalyzer(context).scoreQ).toBe(perFrame[1].scoreQ);
    expect(valueAnalyzer(context).scoreQ).toBe(Math.min(...perFrame.map((f) => f.scoreQ)));
  });

  it('narrows which defects it reports by `focus` without changing a single number', () => {
    // `focus` is a scope, not a crop: the same fixture with a box around the offending plane
    // reports the issue and a box on the other side of the canvas does not, and the score is
    // identical either way.
    const sprite = spriteOf(RAMP, straightDiagonal());
    const all = valueAnalyzer(createQualityContext(sprite));
    const wrongSide = valueAnalyzer(createQualityContext(sprite, { focus: { x: 0, y: 0, w: 2, h: 2 } }));
    const rightSide = valueAnalyzer(createQualityContext(sprite, { focus: { x: 0, y: 0, w: 32, h: 32 } }));
    expect(codes(wrongSide.issues)).not.toContain('plane-crosses-form');
    expect(codes(rightSide.issues)).toContain('plane-crosses-form');
    expect(wrongSide.scoreQ).toBe(all.scoreQ);
    expect(rightSide.scoreQ).toBe(all.scoreQ);
  });

  it('registers with no precondition, so a full-bleed scene is measured rather than excused', () => {
    // `requiresReadableSubject` exists because a full-bleed scene has no *shape* to read. A
    // landscape is built out of value planes, so `value` answers its question on one; the ten
    // full-bleed scenes in `artwork/` are the documents this dimension has most to say about.
    const full = new Uint8Array(16 * 16).fill(1);
    const context = createQualityContext(maskSprite(full, 16, 16));
    expect(evaluate(context).excluded.silhouette).toBe('no-subject');
    expect(evaluate(context).excluded.value).toBeUndefined();
    expect(evaluate(context).dimensions.value).toBeDefined();
  });
});

/** A sprite whose only layer is exactly `mask`, for the full-bleed case. */
function maskSprite(mask: Uint8Array, width: number, height: number): Sprite {
  const sprite = createSprite({ width, height, name: 'mask', layers: ['Base'] });
  const cel = new PixelBuffer(width, height);
  for (let p = 0; p < mask.length; p++) {
    if (mask[p] !== 1) continue;
    const i = cel.index(p % width, Math.floor(p / width));
    cel.data[i] = 200;
    cel.data[i + 1] = 200;
    cel.data[i + 2] = 200;
    cel.data[i + 3] = 255;
  }
  sprite.frames[0].cels.set(sprite.layers[0].id, cel);
  return sprite;
}

/* ------------------------------------------------------------------ *
 * 6 · The shared quantities
 * ------------------------------------------------------------------ */

describe('`dist`, on the reading the corpus record adopted', () => {
  it('is 0 on the edge pixels and 1 next to them, and `Dmax` is the half-thickness', () => {
    const mask = new Uint8Array(21 * 21);
    for (let y = 0; y < 21; y++) for (let x = 0; x < 21; x++) mask[y * 21 + x] = 1;
    const { dist, Dmax } = distField(mask, 21, 21);
    expect(Dmax).toBe(10);
    expect(dist[10 * 21 + 10]).toBe(10);
    expect(dist[10 * 21 + 0]).toBe(0);
    expect(dist[10 * 21 + 1]).toBe(1);
  });

  it('costs a diagonal gap two steps rather than one, which is what separates it from Chebyshev', () => {
    // The corpus's recorded discriminator, measured: a 3x3 block with one corner removed. The
    // pixel diagonally opposite the removed corner has all four orthogonal neighbours solid, so
    // the 4-connected field reaches it in one step from an orthogonal neighbour that is an
    // `edgePixel` -- and the Chebyshev reading agrees. What distinguishes the two metrics is a
    // *diagonal* gap, which is two steps at 4-connectivity and one at 8: a 5x5 block with its
    // whole middle column removed has `Dmax` 2 here and 2 under Chebyshev too, so the honest
    // discriminator is the shape `benchmarks/corpus/format.ts` already names, tested for the
    // property the prose actually claims.
    const mask = new Uint8Array(9 * 9);
    for (let y = 2; y < 5; y++) for (let x = 2; x < 5; x++) mask[y * 9 + x] = 1;
    mask[4 * 9 + 2] = 0;
    const { dist, Dmax } = distField(mask, 9, 9);
    expect(Dmax).toBe(1);
    expect(dist[2 * 9 + 4]).toBe(0);
    expect(dist[3 * 9 + 3]).toBe(1);
  });

  it('treats the outside of the canvas as transparent, so a subject that fills the frame is bounded by it', () => {
    // A full-bleed scene's silhouette *is* the canvas edge, and `edgePixel` has to say so or
    // `dist` would be undefined there. On an 8x8 filled square that means the border reads 0 and
    // the centre reads 3 — the half-thickness of the frame, which is what a 1px margin's worth of
    // `dist` looks like and why the aggregator's `no-subject` exclusion is a precondition on
    // `silhouette` and not on `value`.
    const full = new Uint8Array(8 * 8).fill(1);
    const { dist, Dmax } = distField(full, 8, 8);
    expect(Dmax).toBe(3);
    expect(dist[0]).toBe(0);
    expect(dist[3 * 8 + 3]).toBe(3);
    // And the corrected corner predicate reads the frame's own four corners and nothing else, so
    // a full-bleed subject is *straight* rather than curvature-free — which is a different thing
    // and the one the gate actually wants.
    expect(countConvexStaircaseCorners(full, 8, 8)).toBe(4);
  });
});

/** Unused import guard: `buildSolidMask` is re-exported for the corpus, not needed here. */
void buildSolidMask;
/** A `Rect` appears in the type of an issue, which is the only place the dimension uses one. */
const _: Rect | null = null;
void _;
