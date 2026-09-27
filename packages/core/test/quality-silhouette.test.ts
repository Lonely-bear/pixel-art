import { describe, expect, it } from 'vitest';
import { ALPHA_SOLID, createQualityContext } from '../src/quality/context.js';
import {
  borderTouch,
  boundaryPerimeter,
  buildSolidMask,
  compactnessQ,
  connectedComponents,
  countConvexCorners,
  inscribedSquareSide,
  interiorHoles,
  measureSilhouette,
  rhu,
  silhouetteAnalyzer,
  subjectMask,
  thicknessQ,
  type SilhouetteFrame,
} from '../src/quality/silhouette.js';
import { isBlocking, type QualityContext, type QualityIssue } from '../src/quality/types.js';
import { createSprite, type Sprite } from '../src/document.js';
import { PixelBuffer } from '../src/buffer.js';
import { deserializeSprite, serializeSprite } from '../src/serialize.js';
import type { FrameId, Rect } from '../src/types.js';

/**
 * The `silhouette` dimension, measured rather than asserted in prose.
 *
 * §4.1 was specified with a worked example and two throwaway reimplementation scripts and
 * never run. This file is the first time its numbers come out of an implementation that
 * stayed in the repository, so it carries three jobs beyond "the code runs":
 *
 *   1. **Pin the conditions, not the prose.** Every one of the six issue codes has a shape
 *      here that trips it, and each trip is checked against a quantity the test can read
 *      back out of `measureSilhouette`, so a threshold edited in either direction fails
 *      rather than quietly reclassifying artwork.
 *   2. **Pin the two decisions the spec argues for and does not derive.** 4-connectivity
 *      for the subject against 8 for the background, and `focus` as a scope rather than a
 *      crop. Both are one edit away from a scorer that confidently measures nothing, and
 *      both were arrived at by argument, so the arguments belong next to the assertions.
 *   3. **Record the measurement that says §3.3's `convexCorner` is inert.** That is a
 *      claim about the spec, and a claim about a spec does not belong in a comment where
 *      the next revision will not trip over it. It is a test with a number in it.
 */

/** Alpha for each ASCII symbol. `.` paints nothing at all, `#` paints the shape. */
const ALPHA_BY_SYMBOL: Readonly<Record<string, number>> = {
  '.': 0,
  '#': 255,
  /** Exactly `ALPHA_SOLID`, so the threshold's inclusivity is covered. */
  '=': ALPHA_SOLID,
  /** One below `ALPHA_SOLID`: counted as `partialAlpha`, never in `N`. */
  '-': ALPHA_SOLID - 1,
  /** One below fully opaque but still above the threshold. */
  'o': 200,
};

/**
 * A sprite whose frames are painted by a predicate.
 *
 * Every fixture in this file is written as a picture or a rectangle rather than by
 * poking a `PixelBuffer`, because a silhouette test whose input is `data[i*4+3] = 255`
 * in four places cannot be reviewed by anyone — including, on a bad day, the author.
 */
function spriteWhere(
  width: number,
  height: number,
  alphaAt: (x: number, y: number, frame: number) => number,
  frames = 1,
): Sprite {
  const sprite = createSprite({ width, height, frames, name: 'fixture' });
  const layer = sprite.layers[0].id;
  // `createSprite` only allocates a cel when a background is given, and these fixtures
  // paint their own, so the cels are attached here rather than through a `fill`.
  for (let f = 0; f < frames; f++) {
    const cel = new PixelBuffer(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const alpha = alphaAt(x, y, f);
        if (alpha === 0) continue;
        const i = cel.index(x, y);
        cel.data[i] = 40;
        cel.data[i + 1] = 60;
        cel.data[i + 2] = 90;
        cel.data[i + 3] = alpha;
      }
    }
    sprite.frames[f].cels.set(layer, cel);
  }
  return sprite;
}

/** A sprite from a picture. Rows are top-down; every row must be the same width. */
function spriteFromRows(rows: readonly string[], frames = 1): Sprite {
  const height = rows.length;
  const width = rows[0].length;
  for (const row of rows) {
    if (row.length !== width) throw new Error(`row "${row}" is not ${width} wide`);
  }
  return spriteWhere(width, height, (x, y) => {
    const symbol = rows[y][x];
    const alpha = ALPHA_BY_SYMBOL[symbol];
    if (alpha === undefined) throw new Error(`unknown fixture symbol "${symbol}"`);
    return alpha;
  }, frames);
}

/** A solid axis-aligned rectangle. */
function rectSprite(width: number, height: number, r: Rect, frames = 1): Sprite {
  return spriteWhere(
    width,
    height,
    (x, y) => (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h ? 255 : 0),
    frames,
  );
}

/** The analyzer, plus the frame record it aggregated, for the same context. */
function measure(sprite: Sprite, options: { frames?: readonly FrameId[]; focus?: Rect | null } = {}) {
  const context: QualityContext = createQualityContext(sprite, options);
  return { context, frames: measureSilhouette(context), dimension: silhouetteAnalyzer(context) };
}

function codes(issues: readonly QualityIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

function only(issues: readonly QualityIssue[]): QualityIssue {
  expect(issues).toHaveLength(1);
  return issues[0];
}

/** 16×16, a 10×8 block with a 3px margin all round: one mass, nothing touching an edge. */
const CLEAN_BLOB = [
  '................',
  '................',
  '................',
  '...##########...',
  '...##########...',
  '...##########...',
  '...##########...',
  '...##########...',
  '...##########...',
  '...##########...',
  '...##########...',
  '................',
  '................',
  '................',
  '................',
  '................',
];

describe('silhouette — a clean blob', () => {
  it('scores 1000 with no issues, and the quantities are the ones §4.1 would quote', () => {
    const { frames, dimension } = measure(spriteFromRows(CLEAN_BLOB));
    const frame = only2(frames);
    // N 80, largest 80, so share 1000/1000 and the top band with no adjustment.
    expect(frame.N).toBe(80);
    expect(frame.components).toBe(1);
    expect(frame.shareQ).toBe(1000);
    expect(frame.strayCount).toBe(0);
    expect(frame.bounds).toEqual({ x: 3, y: 3, w: 10, h: 8 });
    // 10x8 rectangle: 2*(10+8) = 36 boundary transitions, and 4*pi*80/36^2 = 775.
    expect(frame.perimeter).toBe(36);
    expect(frame.compactnessQ).toBe(776);
    expect(frame.borderTouch).toBe(0);
    expect(frame.holeCount).toBe(0);
    expect(dimension.scoreQ).toBe(1000);
    expect(dimension.issues).toEqual([]);
    expect(isBlocking(dimension.issues[0] ?? { severity: 0 })).toBe(false);
  });

  it('names partial-alpha pixels in the verdict without scoring them', () => {
    // Same blob with a row of 10 pixels at alpha 127: counted, never in N, never an issue.
    const rows = CLEAN_BLOB.slice();
    rows[13] = '----------......';
    const { frames, dimension } = measure(spriteFromRows(rows));
    const frame = only2(frames);
    expect(frame.N).toBe(80);
    expect(frame.partialAlpha).toBe(10);
    expect(dimension.scoreQ).toBe(1000);
    expect(dimension.issues).toEqual([]);
    expect(dimension.verdict).toContain('10 px below ALPHA_SOLID 128');
  });

  it('treats alpha exactly at ALPHA_SOLID as solid, one below as not', () => {
    const at = spriteFromRows(['=', '=']);
    expect(only2(measureSilhouette(createQualityContext(at)))).toMatchObject({ N: 2, components: 1 });
    const below = spriteFromRows(['-', '-']);
    const frame = only2(measureSilhouette(createQualityContext(below)));
    expect(frame.N).toBe(0);
    expect(frame.partialAlpha).toBe(2);
  });
});

/**
 * One shape cut in two by a transparent column, the two halves the same size on purpose:
 * `share` lands exactly on 50/100, which is where `fragmented-silhouette` must *not* fire.
 * A picture would drift every time a row was added; a predicate cannot.
 */
function cutInTwo(): Sprite {
  return spriteWhere(16, 16, (x, y) => {
    const left = x >= 2 && x < 8 && y >= 3 && y < 9; // 6x6 = 36
    const right = x >= 9 && x < 15 && y >= 9 && y < 15; // 6x6 = 36
    return left || right ? 255 : 0;
  });
}

describe('silhouette — detached-pieces', () => {
  it('catches a shape cut in two by a transparent column', () => {
    const { frames, dimension } = measure(cutInTwo());
    const frame = only2(frames);
    expect(frame.N).toBe(72);
    expect(frame.components).toBe(2);
    expect(frame.componentAreas).toEqual([36, 36]);
    expect(frame.strayCount).toBe(1);
    expect(frame.shareQ).toBe(500);
    expect(codes(frame.issues)).toEqual(['detached-pieces']);
    const issue = only(frame.issues);
    expect(issue.severity).toBe(0.45);
    expect(isBlocking(issue)).toBe(false);
    // Band 550, one stray so -75. Nothing else fires, and now that is the interesting half:
    // the subject is one 6x6 square, so its compactnessQ is 785 and not the 393 the whole
    // mask's two perimeters produced. A shape cut in two is a fragmentation defect, priced by
    // `detached-pieces`, and the shape of each half is no longer part of the question.
    expect(dimension.scoreQ).toBe(475);
    expect(frame.subjectPerimeter).toBe(24);
    expect(frame.perimeter).toBe(48);
    expect(frame.compactnessQ).toBe(785);
    expect(frame.thicknessPx).toBe(6);
    expect(frame.thicknessQ).toBe(375);
    expect(frame.borderTouch).toBe(0);
  });

  it('points the issue at the largest stray, in absolute canvas coordinates', () => {
    const { frames } = measure(cutInTwo());
    expect(only2(frames).strayBounds).toEqual({ x: 9, y: 9, w: 6, h: 6 });
    expect(only(frames.flatMap((f) => f.issues)).rect).toEqual({ x: 9, y: 9, w: 6, h: 6 });
  });

  it('escalates from -75 to -150 at two strays, and no longer doubles the bill with thin-profile', () => {
    // Three masses. Two things are worth recording here and neither is obvious from §4.1:
    //
    //   1. `fragmented-silhouette` needs `share < 50/100`, which needs three components,
    //      because two components cap `share` at exactly 500 and the test is strict.
    //   2. **This used to trip `thin-profile` as well, and that was the bug T-021 measured.**
    //      The 7x7 body, the 8x2 tail and the 6x3 speck have three perimeters between them, so
    //      the whole-mask quotient was 239 and the row cost -250 for what the table reads as
    //      -150. On the subject it is a 7x7 square: compactnessQ 785, thicknessQ 438, and the
    //      dimension says one thing — the pieces are detached — instead of saying it twice.
    //
    // The coupling the previous version of this test pinned was real and it was also a defect.
    // It is re-pinned here from the other side: the assertion that fails if somebody puts the
    // whole mask back into `compactnessQ`.
    const { frames, dimension } = measure(
      spriteWhere(20, 16, (x, y) => {
        const body = x >= 2 && x < 9 && y >= 4 && y < 11; // 7x7 = 49
        const tail = x >= 12 && x < 20 && y >= 4 && y < 6; // 8x2 = 16
        const speck = x >= 12 && x < 18 && y >= 9 && y < 12; // 6x3 = 18
        return body || tail || speck ? 255 : 0;
      }),
    );
    const frame = only2(frames);
    expect(frame.N).toBe(83);
    expect(frame.componentAreas).toEqual([49, 18, 16]);
    expect(frame.strayCount).toBe(2);
    expect(frame.shareQ).toBe(590);
    expect(frame.subjectPerimeter).toBe(28);
    expect(frame.compactnessQ).toBe(785);
    expect(frame.thicknessQ).toBe(438);
    // `fragmented-silhouette` needs share < 500 and 590 is not that, so this is the case
    // that proves the comparison is strict.
    expect(codes(frame.issues)).toEqual(['detached-pieces']);
    expect(dimension.scoreQ).toBe(400); // 550 - 150, and nothing else
  });

  it('does not call a dominant mass plus two specks thin, which is the counter-case', () => {
    // Three components again, and `thin-profile` stays silent. Compactness is driven by
    // the perimeter of the *largest* mass, so a big body with two specks beside it is a
    // perfectly good silhouette and must not be charged for being in pieces.
    const { frames, dimension } = measure(
      spriteWhere(20, 16, (x, y) => {
        const body = x >= 2 && x < 16 && y >= 4 && y < 16; // 14x12 = 168
        const a = x >= 17 && x < 20 && y >= 5 && y < 8; // 3x3 = 9
        const b = x >= 17 && x < 20 && y >= 10 && y < 13; // 3x3 = 9
        return body || a || b ? 255 : 0;
      }),
    );
    const frame = only2(frames);
    expect(frame.components).toBe(3);
    expect(frame.componentAreas).toEqual([168, 9, 9]);
    // The 14x12 body alone: 52 of boundary against 168 px, so 781, and the two 3x3 specks add
    // nothing to it. Under the whole-mask reading this was 405, which is the same story as the
    // case above from the other direction: a big body with specks beside it was being charged a
    // compactness penalty for the specks.
    expect(frame.subjectPerimeter).toBe(52);
    expect(frame.compactnessQ).toBe(781);
    expect(frame.thicknessQ).toBe(750);
    expect(codes(frame.issues)).toEqual(['detached-pieces']);
    expect(dimension.scoreQ).toBe(750); // 900 band, -150 for two strays
  });

  it('scores a sprite with three comparable masses at 0, and says why', () => {
    const { frames, dimension } = measure(
      spriteWhere(20, 16, (x, y) => {
        const a = x >= 1 && x < 6 && y >= 3 && y < 8; // 25
        const b = x >= 8 && x < 12 && y >= 3 && y < 8; // 20
        const c = x >= 15 && x < 18 && y >= 3 && y < 8; // 15
        return a || b || c ? 255 : 0;
      }),
    );
    const frame = only2(frames);
    expect(frame.shareQ).toBe(417);
    // Per-frame issues come out in *emission* order, which is the order the conditions are
    // evaluated in; the aggregator sorts by severity before anything is read. Asserted
    // separately below, because which one you read matters.
    //
    // The largest mass is a 5x5 square and it is alone 785, so `thin-profile` is silent and
    // the fragmentation is priced once, by the two codes that name it. The whole-mask reading
    // put this at 259 and charged -400 for what the table reads as -300.
    expect(frame.compactnessQ).toBe(785);
    expect(frame.thicknessQ).toBe(313);
    expect(codes(frame.issues)).toEqual(['detached-pieces', 'fragmented-silhouette']);
    const blocking = frame.issues.filter(isBlocking);
    expect(blocking.map((i) => i.code)).toEqual(['fragmented-silhouette']);
    // Base 250, then -150 -150 = -300, and the result clamps at 0 rather than -50.
    expect(dimension.scoreQ).toBe(0);
    expect(dimension.verdict).toContain('no dominant mass');
    // Severity first, so a reader of the head of the list reads what blocks.
    expect(codes(dimension.issues)).toEqual(['fragmented-silhouette', 'detached-pieces']);
  });

  it('does not fire at exactly 2% stray, because the comparison is strict', () => {
    // 98 px of subject and 2 px of stray: `strayPixels * 100 > 2 * N` is 200 > 200, false.
    // The shape is also 98% of the subject, which is the top band's inclusive edge.
    const { frames, dimension } = measure(
      spriteWhere(20, 16, (x, y) => {
        const body = x >= 2 && x < 16 && y >= 4 && y < 11; // 14x7 = 98
        const speck = x === 17 && y === 5;
        const speck2 = x === 17 && y === 6;
        return body || speck || speck2 ? 255 : 0;
      }),
    );
    const frame = only2(frames);
    expect(frame.N).toBe(100);
    expect(frame.shareQ).toBe(980);
    expect(frame.strayPixels).toBe(2);
    expect(frame.issues).toEqual([]);
    expect(dimension.scoreQ).toBe(1000);
  });

  it('reads 97% as the 900 band, not the 1000 band', () => {
    // One pixel out of a 98 px body, plus a 3 px stray, so both the band and the stray
    // threshold move at once and neither is doing the work alone.
    const { frames, dimension } = measure(
      spriteWhere(20, 16, (x, y) => {
        const body = x >= 2 && x < 16 && y >= 4 && y < 11 && !(x === 2 && y === 4); // 97
        const speck = x >= 17 && x < 20 && y === 5; // 3
        return body || speck ? 255 : 0;
      }),
    );
    const frame = only2(frames);
    expect(frame.shareQ).toBe(970);
    expect(frame.issues.length).toBe(1);
    expect(dimension.scoreQ).toBe(825); // 900 - 75
  });
});

describe('silhouette — interior-hole', () => {
  it('reports a ring, and says plainly that a hollow asset is the known false positive', () => {
    // 10x10 ring: 36 px of wall around a 64 px hole. §4.1's argument is that the sprite is
    // composited over a scene, so a see-through pixel is a hole in the world and not an
    // eye. That argument is applied here deliberately rather than by accident, which is
    // why the message names the alternative instead of only the defect.
    const ring = spriteWhere(16, 16, (x, y) => {
      const on = x >= 3 && x < 13 && y >= 3 && y < 13;
      const inner = x >= 4 && x < 12 && y >= 4 && y < 12;
      return on && !inner ? 255 : 0;
    });
    const { frames, dimension } = measure(ring);
    const frame = only2(frames);
    expect(frame.N).toBe(36);
    expect(frame.holeCount).toBe(1);
    expect(frame.holeAreas).toEqual([64]);
    // A 36 px ring really is thin as well as holed, so both conditions fire. Recorded
    // rather than worked around: a ring is a 1px shape, and `thin-profile` is right. The
    // price is now 700 rather than 800 because the 1px wall has an inscribed square of 1px
    // against a 16px canvas — profileQ 63, under the deep band — and §4.1's -100 becomes -200
    // for a shape this thin without changing which subjects fire.
    expect(codes(frame.issues)).toEqual(['interior-hole', 'thin-profile']);
    const hole = frame.issues[0];
    expect(hole.code).toBe('interior-hole');
    expect(hole.severity).toBe(0.4);
    expect(hole.rect).toEqual({ x: 4, y: 4, w: 8, h: 8 });
    expect(hole.message).toContain('deliberately hollow asset');
    expect(frame.compactnessQ).toBeLessThan(300);
    expect(frame.thicknessPx).toBe(1);
    expect(frame.thicknessQ).toBe(63);
    expect(dimension.scoreQ).toBe(700); // 1000 - 100 - 200
  });

  it('catches a deliberate eye and a deliberate handle, both of which the spec calls defects', () => {
    // A 1px eye punched into a solid body, and a mug handle hanging off the side. Both are
    // things an artist draws on purpose; neither survives a sprite composited over a
    // background, and the spec settles it with a human note rather than a measurement.
    const eye = spriteWhere(16, 16, (x, y) => {
      const body = x >= 2 && x < 14 && y >= 2 && y < 14;
      return body && !(x === 8 && y === 8) ? 255 : 0;
    });
    const eyeFrame = only2(measureSilhouette(createQualityContext(eye)));
    expect(eyeFrame.holeAreas).toEqual([1]);
    expect(codes(eyeFrame.issues)).toContain('interior-hole');
    expect(eyeFrame.issues.find((i) => i.code === 'interior-hole')?.rect).toEqual({
      x: 8,
      y: 8,
      w: 1,
      h: 1,
    });
    // **A 1 px nick is now half the price of a window** (§4.1's own anchors: a nick is a 4, a
    // window is a 2), and this is the discriminating case for it — 1/144 of the subject, so the
    // ratio clause is nowhere near firing and only the `area <= 3` clause can. Before the split
    // this cost the same -100 as a 36 px window, on shapes 288 per-mille apart.
    expect(codes(eyeFrame.issues)).toEqual(['interior-hole']);

    // A handle: a 3x3 loop attached to a body, so its interior is a hole and its outer
    // side is a 1px protrusion. The hole is 1 px, so the `area <= 3` clause fires rather
    // than the ratio.
    const mug = spriteWhere(16, 16, (x, y) => {
      const body = x >= 3 && x < 10 && y >= 4 && y < 12;
      const handleRing =
        x >= 10 && x < 14 && y >= 6 && y < 10 && !(x === 11 && y >= 7 && y < 9);
      return body || handleRing ? 255 : 0;
    });
    const mugFrame = only2(measureSilhouette(createQualityContext(mug)));
    expect(mugFrame.holeAreas).toEqual([2]);
    expect(codes(mugFrame.issues)).toContain('interior-hole');
  });

  it('uses 8-connectivity for the background so a diagonal gap is not a hole', () => {
    // Two blocks joined at a corner, with a one-pixel diagonal leak to the outside. Under
    // 8-connectivity the leak is a route to the border, so there is no hole; under
    // 4-connectivity the pocket at the corner would be reported as one. This is the
    // pairing that makes the answer independent of which side of a diagonal a gap falls.
    const mask = new Uint8Array(9 * 9);
    for (let y = 2; y < 7; y++) for (let x = 2; x < 7; x++) mask[y * 9 + x] = 1;
    // Punch the diagonal that runs from the pocket out past the shape.
    mask[1 * 9 + 7] = 0;
    mask[2 * 9 + 7] = 1;
    mask[3 * 9 + 7] = 0;
    expect(interiorHoles(mask, 9, 9)).toEqual([]);
  });

  it('still reports a pocket that genuinely does not reach the border', () => {
    const mask = new Uint8Array(9 * 9);
    for (let y = 2; y < 7; y++) for (let x = 2; x < 7; x++) mask[y * 9 + x] = 1;
    mask[3 * 9 + 4] = 0; // sealed 1px pocket, fully enclosed on all four sides
    // `seed` is the pocket's first pixel in row-major scan order, and it is carried because
    // `subjectMask` needs a seed and `bounds` cannot supply one — two components can share a
    // bounding box, and the earlier one in the scan is not necessarily the one asked for.
    expect(interiorHoles(mask, 9, 9)).toEqual([
      { area: 1, bounds: { x: 4, y: 3, w: 1, h: 1 }, seed: 3 * 9 + 4 },
    ]);
  });
});

describe('silhouette — shape-clipped', () => {
  it('reports a sprite that fills its whole canvas, at blocking severity', () => {
    const solid = rectSprite(8, 8, { x: 0, y: 0, w: 8, h: 8 });
    const { frames, dimension } = measure(solid);
    const frame = only2(frames);
    expect(frame.N).toBe(64);
    expect(frame.borderTouch).toBe(4);
    expect(codes(frame.issues)).toEqual(['shape-clipped']);
    const issue = only(frame.issues);
    expect(issue.severity).toBe(0.8);
    expect(isBlocking(issue)).toBe(true);
    // Band 1000, -200. Compactness of a 8x8 square is 785 and it reaches 4 sides, but
    // 4 sides is one condition applied once, not twice.
    expect(frame.compactnessQ).toBe(785);
    expect(dimension.scoreQ).toBe(800);
  });

  it('stays silent at two sides, because running off one edge is a composition choice', () => {
    // A 12x12 block in the bottom-right corner: it reaches the right and bottom edges and
    // stops a pixel short of both corners, so it reaches exactly two sides and nothing
    // else fires. The gate is 3 and not 4 for this reason.
    const { frames, dimension } = measure(rectSprite(16, 16, { x: 4, y: 4, w: 12, h: 12 }));
    const frame = only2(frames);
    expect(frame.borderTouch).toBe(2);
    expect(frame.issues).toEqual([]);
    expect(dimension.scoreQ).toBe(1000);
  });
});

describe('silhouette — subject-undersized', () => {
  it('reports a subject occupying a small fraction of a large canvas', () => {
    // 10x10 inside 64x64. Both edges are under a quarter of the canvas, which is the
    // `||` in §3.7's test rather than the `&&` a reader might expect.
    //
    // **And it is now also thin**, which is the one place the two canvas-relative codes
    // overlap: for a square subject the inscribed square IS the short side, so thicknessQ
    // and spanQ are both 156 and the sprite is reported twice for the same fact. Stated rather
    // than engineered away — the alternative is special-casing square subjects out of one of
    // the two gates, which would make a shape's square-ness decide whether a defect is
    // reported. profileQ 156 is above the deep band, so the cost is the ordinary -100.
    const { frames, dimension } = measure(rectSprite(64, 64, { x: 27, y: 27, w: 10, h: 10 }));
    const frame = only2(frames);
    expect(frame.bounds).toEqual({ x: 27, y: 27, w: 10, h: 10 });
    expect(frame.spanQ).toBe(156);
    expect(frame.thicknessQ).toBe(156);
    expect(codes(frame.issues)).toEqual(['thin-profile', 'subject-undersized']);
    for (const issue of frame.issues) {
      expect(issue.severity).toBe(0.3);
      expect(isBlocking(issue)).toBe(false);
    }
    expect(dimension.scoreQ).toBe(800); // 1000 - 100 - 100
  });

  it('stays silent at exactly a quarter of an edge, because the test is a strict `<`', () => {
    // 16x16 subject in a 64x64 canvas: 16*4 === 64, so `16 * 4 < 64` is false.
    const { frames, dimension } = measure(rectSprite(64, 64, { x: 24, y: 24, w: 16, h: 16 }));
    const frame = only2(frames);
    expect(frame.spanQ).toBe(250);
    expect(frame.issues).toEqual([]);
    expect(dimension.scoreQ).toBe(1000);
  });
});

describe('silhouette — thin-profile', () => {
  it('catches a 1px line, which is the case edgePixels could never have caught', () => {
    // A 28x1 line. With the old edge-pixel denominator this is the *most* compact thing
    // imaginable and scored 3900 on a 0..1 scale; with the transition perimeter it is 105,
    // which is what `thin-profile` exists to say. And the scale-aware reading says something
    // the quotient cannot: 1px of inscribed square against a 32px canvas is thicknessQ 31,
    // which is not a shape that has run out of compactness but a shape with no room in it.
    const line = spriteWhere(32, 32, (x, y) => (y === 16 && x >= 2 && x < 30 ? 255 : 0));
    const { frames, dimension } = measure(line);
    const frame = only2(frames);
    expect(frame.N).toBe(28);
    expect(frame.perimeter).toBe(58);
    expect(frame.compactnessQ).toBe(105);
    expect(frame.thicknessPx).toBe(1);
    expect(frame.thicknessQ).toBe(31);
    expect(frame.profileQ).toBe(31);
    expect(codes(frame.issues)).toEqual(['thin-profile', 'subject-undersized']);
    expect(frame.issues[0].severity).toBe(0.3);
    // profileQ 31 is under the deep band, so -200, plus the -100 of `subject-undersized`.
    expect(dimension.scoreQ).toBe(700);
  });

  it('does call a 5px plus thin, which nothing caught before T-022', () => {
    // The 5-pixel plus is the spec's own worked example for the `edgePixels` bug. It has 5 edge
    // pixels and 12 boundary transitions, so the old denominator returns 2513 on a 0..1000
    // scale — the most compact shape imaginable, over twice its own ceiling — and the
    // transition count returns 436, which is what the shape is actually worth.
    //
    // The third number is the finding. Its compactnessQ of 436 is comfortably above §4.1's
    // gate, so before T-022 the shape §4.1 uses to illustrate a thin subject was reported by
    // this dimension as *not* thin. Every limb of a plus sign is one pixel wide, so its
    // inscribed square is 1px against a 16px canvas: thicknessQ 63, profileQ 63, and the deep
    // band. `subject-undersized` fires too, for the 3x3 box in a 16x16 frame.
    const plus = spriteWhere(16, 16, (x, y) => {
      const arm = (x === 8 && y >= 7 && y < 10) || (y === 8 && x >= 7 && x < 10);
      return arm ? 255 : 0;
    });
    const { frames, dimension } = measure(plus);
    const frame = only2(frames);
    expect(frame.N).toBe(5);
    expect(frame.perimeter).toBe(12);
    expect(frame.compactnessQ).toBe(436);
    // The old quantity, for the record: 4 * 355 * 1000 * 5 / (113 * 5 * 5).
    expect(Math.floor((4 * 355 * 1000 * 5) / (113 * 5 * 5))).toBe(2513);
    // And the third quantity, which is a pixel count and so is not a ratio of anything: a plus
    // has no 2x2 block anywhere in it, so the largest inscribed square is 1.
    const plusMask = buildSolidMask(createQualityContext(plus).composite[0], 16, 16).mask;
    expect(inscribedSquareSide(plusMask, 16, 16, { x: 7, y: 7, w: 3, h: 3 })).toBe(1);
    expect(frame.thicknessPx).toBe(1);
    expect(frame.thicknessQ).toBe(63);
    expect(codes(frame.issues)).toEqual(['thin-profile', 'subject-undersized']);
    expect(dimension.scoreQ).toBe(700); // 1000 - 200 - 100
  });

  it('never returns a compactness above 1000, for a disc or anything else', () => {
    // `min(1000, ...)` is documented as belt-and-braces, so this asserts it rather than
    // trusting the isoperimetric inequality to be the only thing holding the line.
    const frame = only2(measureSilhouette(createQualityContext(discSprite(32))));
    // A *digital* disc is not a disc: every step of its outline is a 45° staircase, which
    // adds perimeter, so the real quotient lands well below 1000 even though the shape is
    // the most compact there is. Pinned because `thin-profile` at < 300 has to stay clear
    // of the roundest thing the pipeline will ever be handed.
    expect(frame.N).toBe(discArea(32));
    expect(frame.compactnessQ).toBe(646);
    expect(frame.compactnessQ).toBeLessThanOrEqual(1000);
    expect(frame.compactnessQ).toBeGreaterThan(300);
    // The scale-aware reading on the same shape, and the bias it carries: a maximal inscribed
    // square in a digital disc of radius 15.5 is 22px, not the 31px diameter, so `thicknessQ`
    // reads about a third under the shape's real room. Recorded rather than tuned away — the
    // two columns are printed side by side for exactly this reason, and §4.1's gate on a disc
    // is unaffected either way because the compactness reading is the smaller of the two.
    expect(frame.thicknessPx).toBe(22);
    expect(frame.thicknessQ).toBe(688);
    expect(frame.profileQ).toBe(646);
    expect(frame.issues).toEqual([]);
  });
});


/** Area of the filled disc {@link discSprite} builds, counted rather than assumed. */
function discArea(size: number): number {
  const r = (size - 1) / 2;
  let n = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - r;
      const dy = y - r;
      if (dx * dx + dy * dy <= r * r) n++;
    }
  }
  return n;
}

/** A 32x32 filled circle — the shape §3.3's `convexCorner` claim is about. */
function discSprite(size: number): Sprite {
  const r = (size - 1) / 2;
  return spriteWhere(size, size, (x, y) => {
    const dx = x - r;
    const dy = y - r;
    return dx * dx + dy * dy <= r * r ? 255 : 0;
  });
}

describe('connectivity — the decision, pinned both ways', () => {
  it('8-connectivity keeps a 1px diagonal bridge as one component', () => {
    // The case the finding is about. Under 8-connectivity this is one 4px line; under
    // 4-connectivity it is four 1px components, because each pixel of a diagonal shares
    // only its corners with the next.
    const mask = diagonalMask(4);
    const eight = connectedComponents(mask, 4, 4, 8);
    expect(eight).toHaveLength(1);
    expect(eight[0].area).toBe(4);
    const four = connectedComponents(mask, 4, 4, 4);
    expect(four).toHaveLength(4);
    expect(four.map((c) => c.area)).toEqual([1, 1, 1, 1]);
  });

  it('defaults to 4, so a caller that forgets the argument gets the rule the spec fixes', () => {
    expect(connectedComponents(diagonalMask(4), 4, 4)).toHaveLength(4);
  });

  it('splits two corner-touching blocks under 4 and joins them under 8', () => {
    // This is the subject case, and it is why §4.1 measures the subject with
    // 4-connectivity: at half scale, under a filter, or on a CRT the corner contact
    // disappears and the sprite falls in half, so the two blocks are two shapes in a game.
    const sprite = spriteWhere(16, 16, (x, y) => {
      const a = x >= 2 && x < 7 && y >= 2 && y < 7; // 5x5
      const b = x >= 7 && x < 12 && y >= 7 && y < 12; // 5x5, touching a at (6,6)-(7,7)
      return a || b ? 255 : 0;
    });
    const context = createQualityContext(sprite);
    const mask = buildSolidMask(context.composite[0], 16, 16).mask;
    expect(connectedComponents(mask, 16, 16, 8)).toHaveLength(1);
    expect(connectedComponents(mask, 16, 16, 4)).toHaveLength(2);

    // And the analyzer therefore reports the second block as a detached piece. The
    // alternative — 8-connectivity here — would score this as one perfect mass, which is
    // the failure the spec's connectivity rule was written to prevent.
    const frame = only2(measureSilhouette(context));
    expect(frame.N).toBe(50);
    expect(frame.componentAreas).toEqual([25, 25]);
    expect(codes(frame.issues)).toEqual(['detached-pieces']);
  });

  it('does not fire fragmented-silhouette at exactly one half, because the test is strict', () => {
    // The two-block case above sits exactly on the `share < 50/100` edge, so the only
    // code it may produce is `detached-pieces`. Recorded because a `<=` here would add a
    // blocking issue to every half-and-half sprite.
    const frame = only2(
      measureSilhouette(
        createQualityContext(
          spriteWhere(16, 16, (x, y) => {
            const a = x >= 2 && x < 7 && y >= 2 && y < 7;
            const b = x >= 7 && x < 12 && y >= 7 && y < 12;
            return a || b ? 255 : 0;
          }),
        ),
      ),
    );
    expect(frame.shareQ).toBe(500);
    expect(codes(frame.issues)).toEqual(['detached-pieces']);
  });
});

/** A `w`x`w` mask holding the main diagonal: `w` pixels, 8-connected, 4-disconnected. */
function diagonalMask(w: number): Uint8Array {
  const mask = new Uint8Array(w * w);
  for (let i = 0; i < w; i++) mask[i * w + i] = 1;
  return mask;
}

describe('focus is a scope, not a crop', () => {
  it('changes no measurement at all, for any box', () => {
    // The invariant, and the one a focus-as-crop implementation breaks first. Cropping the
    // mask to the box does not produce a smaller measurement of the sprite, it produces a
    // measurement of a *different shape*: the cut edge reads as silhouette, a piece of the
    // subject can be cropped off into a stray, and a shrunken bounding box reads as an
    // undersized one. Three boxes, chosen to hit all three.
    const sprite = spriteFromRows(CLEAN_BLOB); // 10x8 block at (3,3) in 16x16
    const whole = only2(measureSilhouette(createQualityContext(sprite)));
    const boxes: Rect[] = [
      { x: 3, y: 3, w: 10, h: 8 }, // exactly the subject's own box: the drag a user makes
      { x: 0, y: 0, w: 8, h: 8 }, // clips the subject on two sides
      { x: 4, y: 5, w: 3, h: 3 }, // a small region inside the subject
    ];
    for (const focus of boxes) {
      const focused = only2(
        measureSilhouette(createQualityContext(sprite, { focus })),
      );
      expect(stripVolatile(focused)).toEqual(stripVolatile(whole));
      const dimension = silhouetteAnalyzer(createQualityContext(sprite, { focus }));
      expect(dimension.scoreQ).toBe(1000);
      expect(dimension.issues).toEqual([]);
      // In particular: a cropped mask would fill its box edge to edge and report the user's
      // own selection as a clipped sprite.
      expect(focused.borderTouch).toBe(0);
      // And a shrunken bounding box would read as an undersized subject.
      expect(focused.bounds).toEqual({ x: 3, y: 3, w: 10, h: 8 });
      expect(focused.holeCount).toBe(0);
    }
  });

  it('leaves every measured quantity identical inside and outside a focus box', () => {
    // focus is a reporting filter. If any quantity moved, the numbers would mean two
    // different things depending on who asked, which is what the contract forbids.
    const sprite = cutInTwo();
    const whole = only2(measureSilhouette(createQualityContext(sprite)));
    const focused = only2(
      measureSilhouette(createQualityContext(sprite, { focus: { x: 0, y: 0, w: 5, h: 5 } })),
    );
    expect(stripVolatile(focused)).toEqual(stripVolatile(whole));
  });

  it('reports a defect whose rect intersects the box and suppresses one that does not', () => {
    // The same sprite with the stray in two places: inside the box and outside it. Same
    // score, different advice — which is the entire contract of `focus`.
    const withStray = (strayX: number) =>
      spriteWhere(24, 16, (x, y) => {
        const body = x >= 2 && x < 12 && y >= 4 && y < 12; // 10x8 = 80
        const stray = x >= strayX && x < strayX + 4 && y >= 6 && y < 10; // 4x4 = 16
        return body || stray ? 255 : 0;
      });
    const focus = { x: 0, y: 0, w: 16, h: 16 };
    const inside = measure(withStray(14), { focus });
    const outside = measure(withStray(18), { focus });
    expect(codes(inside.dimension.issues)).toEqual(['detached-pieces']);
    expect(codes(outside.dimension.issues)).toEqual([]);
    // And the score is the same either way, because focus is not a crop.
    expect(inside.dimension.scoreQ).toBe(outside.dimension.scoreQ);
    expect(inside.dimension.scoreQ).toBe(675); // 750 band, -75 for one stray
  });

  it('keeps a defect whose evidence straddles the box edge', () => {
    // "A defect whose evidence is just outside the box is still worth an issue" is
    // intersection, not containment. A stray that starts one pixel outside a 17-wide box
    // and runs into it is still one of the pieces making the shape read wrong.
    const sprite = spriteWhere(24, 16, (x, y) => {
      const body = x >= 2 && x < 12 && y >= 4 && y < 12;
      const stray = x >= 16 && x < 20 && y >= 6 && y < 10;
      return body || stray ? 255 : 0;
    });
    expect(codes(measure(sprite, { focus: { x: 0, y: 0, w: 17, h: 16 } }).dimension.issues)).toEqual([
      'detached-pieces',
    ]);
    expect(codes(measure(sprite, { focus: { x: 0, y: 0, w: 16, h: 16 } }).dimension.issues)).toEqual([]);
  });
});

/** The only fields `focus` is allowed to move are the issues, so compare everything else. */
function stripVolatile(frame: SilhouetteFrame): Omit<SilhouetteFrame, 'issues'> {
  const { issues: _issues, ...rest } = frame;
  return rest;
}

describe('multiple frames', () => {
  it('scores the worst frame, not the mean, and names which one', () => {
    // Frame 0 is a clean blob, frame 1 is the same blob with a chunk missing. The mean
    // would be between the two; §4.2's "worst plane, not the average" argument applies
    // here for the same reason — one frame that reads as a smudge reads as a smudge in
    // motion, and a weighted mean has no way to say so.
    const shape = (x: number, y: number, frame: number): boolean => {
      if (frame === 0) return CLEAN_BLOB[y][x] === '#';
      const left = x >= 2 && x < 8 && y >= 3 && y < 9;
      const right = x >= 9 && x < 15 && y >= 9 && y < 15;
      return left || right;
    };
    const sprite = spriteWhere(16, 16, (x, y, frame) => (shape(x, y, frame) ? 255 : 0), 2);
    const { frames, dimension } = measure(sprite);
    expect(frames).toHaveLength(2);
    expect(frames[0].scoreQ).toBe(1000);
    // Frame 1 is one shape in two, scoring 475. The point of the minimum is that 475 is
    // the number the report has to carry: a viewer sees this sprite in motion, and half of
    // a moving thing that falls in half is a broken thing.
    expect(frames[1].scoreQ).toBe(475);
    expect(dimension.scoreQ).toBe(475);
    expect(dimension.verdict).toContain('worst of 2 frames (frame 1)');
    // A mean would have landed between the two and passed. Assert it is not a mean.
    const mean = Math.floor((frames[0].scoreQ + frames[1].scoreQ) / 2);
    expect(mean).toBe(737);
    expect(dimension.scoreQ).toBeLessThan(mean);
  });

  it('measures only the frames it is handed, in the order it is handed them', () => {
    const sprite = spriteFromRows(CLEAN_BLOB, 3);
    const all = measureSilhouette(createQualityContext(sprite));
    expect(all).toHaveLength(3);
    const second = createQualityContext(sprite, { frames: [sprite.frames[1].id] });
    expect(measureSilhouette(second)).toHaveLength(1);
    expect(only2(measureSilhouette(second))).toMatchObject({ index: 0 });
  });

  it('throws on a frame the document does not have, rather than quietly measuring less', () => {
    const sprite = spriteFromRows(CLEAN_BLOB, 2);
    expect(() => createQualityContext(sprite, { frames: ['frm_nope'] })).toThrow(/Unknown frame/);
  });
});

describe('degenerate inputs', () => {
  it('reports an empty frame as nothing to measure, not as a bad score', () => {
    // `empty-frame` belongs to the aggregator at severity 1.00, and it exists so a blank
    // canvas is caught by one blocking issue rather than by six dimensions each
    // inventing a zero. So this dimension has nothing to fault and says 1000.
    const blank = spriteWhere(8, 8, () => 0);
    const { frames, dimension } = measure(blank);
    expect(only2(frames).measured).toBe(false);
    expect(only2(frames).N).toBe(0);
    expect(dimension.scoreQ).toBe(1000);
    expect(dimension.issues).toEqual([]);
    expect(dimension.verdict).toContain('nothing opaque to measure');
  });

  it('scores the non-empty frames of a partly blank document', () => {
    const sprite = spriteWhere(16, 16, (_x, _y, frame) => (frame === 1 ? 255 : 0), 2);
    const { frames, dimension } = measure(sprite);
    expect(frames[0].measured).toBe(false);
    expect(frames[1].measured).toBe(true);
    expect(dimension.scoreQ).toBe(frames[1].scoreQ);
    expect(dimension.verdict).not.toContain('nothing opaque');
  });

  it('handles a 1x1 sprite, and the shape-clipped reading that comes with it', () => {
    // A 1x1 sprite touches all four sides, so the spec's `borderTouch >= 3` gate fires and
    // the whole canvas is the subject. Pinned as measured behaviour: the alternative is a
    // special case for a shape that cannot exist in a game.
    const { frames, dimension } = measure(spriteWhere(1, 1, () => 255));
    const frame = only2(frames);
    expect(frame.N).toBe(1);
    expect(frame.components).toBe(1);
    expect(frame.shareQ).toBe(1000);
    expect(frame.perimeter).toBe(4);
    expect(frame.borderTouch).toBe(4);
    expect(codes(frame.issues)).toEqual(['shape-clipped']);
    expect(dimension.scoreQ).toBe(800);
  });

  it('survives a context with no frames at all', () => {
    const sprite = spriteFromRows(CLEAN_BLOB);
    const bare: QualityContext = { ...createQualityContext(sprite), frameIds: [], composite: [] };
    const dimension = silhouetteAnalyzer(bare);
    expect(dimension.scoreQ).toBe(1000);
    expect(dimension.issues).toEqual([]);
    expect(dimension.verdict).toContain('no frames');
  });

  it('never returns a non-integer or an out-of-range scoreQ', () => {
    // The unit discipline is a property of the output, so it is checked on the output.
    const fixtures: Sprite[] = [
      spriteFromRows(CLEAN_BLOB),
      cutInTwo(),
      spriteWhere(16, 16, (x, y) => (x >= 2 && x < 14 && y >= 4 && y < 12 ? 255 : 0)),
      spriteWhere(24, 24, (x, y) => (x >= 6 && x < 12 && y >= 6 && y < 12 && !(x === 8 && y === 8) ? 255 : 0)),
      spriteWhere(16, 16, (x, y) => (y === 8 ? 255 : 0)),
      spriteWhere(16, 16, () => 0),
    ];
    for (const sprite of fixtures) {
      for (const frame of measureSilhouette(createQualityContext(sprite))) {
        expect(Number.isInteger(frame.scoreQ)).toBe(true);
        expect(frame.scoreQ).toBeGreaterThanOrEqual(0);
        expect(frame.scoreQ).toBeLessThanOrEqual(1000);
      }
      const { dimension } = measure(sprite);
      expect(Number.isInteger(dimension.scoreQ)).toBe(true);
      for (const issue of dimension.issues) {
        expect(issue.severity).toBeGreaterThanOrEqual(0);
        expect(issue.severity).toBeLessThanOrEqual(1);
        if (issue.rect) {
          expect(issue.rect.w).toBeGreaterThan(0);
          expect(issue.rect.h).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('determinism', () => {
  const sprite = spriteFromRows(CLEAN_BLOB, 3);
  // A document with something to be order-sensitive about, so the assertions below are
  // about traversal order rather than about a sprite with one component.
  const cut = spriteWhere(16, 16, (x, y) => {
    const left = x >= 2 && x < 8 && y >= 3 && y < 9;
    const right = x >= 9 && x < 15 && y >= 9 && y < 15;
    return left || right ? 255 : 0;
  }, 3);

  it('produces identical output for identical input', () => {
    const first = silhouetteAnalyzer(createQualityContext(sprite));
    const second = silhouetteAnalyzer(createQualityContext(sprite));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.scoreQ).toBe(second.scoreQ);
  });

  it('produces identical output across a serialise/deserialise round trip', () => {
    // The regression baseline will be built by reading a `.pixel` off disk, so a score
    // that depended on anything not in the container would be unreproducible in CI.
    const restored = deserializeSprite(serializeSprite(sprite));
    const before = silhouetteAnalyzer(createQualityContext(sprite));
    const after = silhouetteAnalyzer(createQualityContext(restored));
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('is independent of the traversal order a refactor might choose', () => {
    // Components come back in row-major order of their first pixel and the measurement
    // sorts them largest-first with a positional tiebreak, so a refactor cannot change
    // which one is "the subject" by changing how the canvas is walked.
    const { frames } = measure(cut);
    expect(frames).toHaveLength(3);
    for (const frame of frames) {
      expect(frame.componentAreas).toEqual([...frame.componentAreas].sort((a, b) => b - a));
    }
    expect(frames[0].componentAreas).toEqual([36, 36]);
    // The two halves are the same size, so the tiebreak is what picks the subject: the
    // one whose first pixel comes first in the scan. A sort without it would make the
    // choice depend on the sort's stability.
    expect(frames[0].largest).toBe(36);
    expect(frames[0].strayBounds).toEqual({ x: 9, y: 9, w: 6, h: 6 });
  });
});

/** A single frame out of a measurement, with a readable failure if there is not exactly one. */
function only2(frames: readonly SilhouetteFrame[]): SilhouetteFrame {
  expect(frames).toHaveLength(1);
  return frames[0];
}

/**
 * The two readings, and the split between them.
 *
 * T-021 measured two defects in the same quantity. One was that `compactnessQ` ran on the whole
 * mask, so a subject paid for its own strays. The other was that it is scale-invariant, so a
 * knife and a magnified knife are indistinguishable — and §3.3's own `Dmax` paragraph says so
 * in advance, naming the argument that fixes it, which §4.1 never applied.
 *
 * These tests are the answer, in the shape the questions were asked:
 *
 *   - **the subject, not the mask** — the same drawing with and without a stray;
 *   - **the room, not the drawing** — the same drawing on two canvases;
 *   - **and the limit, stated** — the same drawing at two resolutions, which is *not* separated,
 *     because a document carries no display size and inventing one would be worse than the gap.
 */
describe('the subject is measured, not the whole mask', () => {
  /** A 12x12 body, optionally with a 3x3 speck four pixels away. */
  const withSpeck = (speck: boolean): Sprite =>
    spriteWhere(22, 18, (x, y) => {
      const body = x >= 3 && x < 15 && y >= 3 && y < 15;
      const dot = speck && x >= 17 && x < 20 && y >= 6 && y < 9;
      return body || dot ? 255 : 0;
    });

  it('scores the body the same either way, which is the whole of the fix', () => {
    const alone = only2(measureSilhouette(createQualityContext(withSpeck(false))));
    const specked = only2(measureSilhouette(createQualityContext(withSpeck(true))));

    // The measurement the gate reads is **identical**. Before T-022 the speck's own perimeter
    // dragged it to 534, and the only difference between these two sprites was whether the
    // subject was being charged for something beside it.
    expect(alone.N).toBe(144);
    expect(specked.N).toBe(153);
    expect(specked.compactnessQ).toBe(alone.compactnessQ);
    expect(specked.subjectPerimeter).toBe(alone.subjectPerimeter);
    expect(specked.thicknessQ).toBe(alone.thicknessQ);
    expect(specked.profileQ).toBe(alone.profileQ);
    // The whole mask's perimeter, on the other hand, *does* move — which is the drift guard on
    // the change. Equal exactly when the sprite is one component, different exactly when the
    // subject has strays, and never equal to zero by accident.
    expect(alone.subjectPerimeter).toBe(48);
    expect(alone.perimeter).toBe(48);
    expect(specked.subjectPerimeter).toBe(48);
    expect(specked.perimeter).toBe(60);
    // And the *score* differs, by exactly `detached-pieces` and nothing else: -75 of a 900 band.
    expect(alone.scoreQ).toBe(1000);
    expect(specked.scoreQ).toBe(825);
    expect(codes(specked.issues)).toEqual(['detached-pieces']);
  });

  it('isolates the subject, and a component is recoverable from its seed rather than its box', () => {
    // Two components sharing a bounding box is the case that forces `seed` onto the record:
    // a 3x3 block at (2,2) and a 3x3 block at (2,4) both have bounds of 3x4 once you take the
    // union, and the earlier one in scan order is not the one a caller necessarily wants.
    const context = createQualityContext(
      spriteWhere(9, 9, (x, y) => {
        const low = x >= 2 && x < 5 && y >= 2 && y < 5;
        const high = x >= 2 && x < 5 && y >= 4 && y < 7; // overlaps row 4, so one component
        return low || high ? 255 : 0;
      }),
    );
    const { mask } = buildSolidMask(context.composite[0], 9, 9);
    const [only] = connectedComponents(mask, 9, 9, 4);
    expect(only.area).toBe(15);
    expect(only.seed).toBe(2 * 9 + 2);
    // And the isolated subject has the same area and boundary as the mask it came from.
    const isolated = subjectMask(mask, 9, 9, only);
    expect(boundaryPerimeter(isolated, 9, 9)).toBe(boundaryPerimeter(mask, 9, 9));
    expect(connectedComponents(isolated, 9, 9, 4)).toHaveLength(1);
  });
});

describe('thicknessQ: the room, which compactnessQ does not have', () => {
  /** The same 28x3 band, on whatever canvas it is asked for. */
  const band = (size: number): Sprite =>
    spriteWhere(size, size, (x, y) =>
      x >= Math.floor((size - 28) / 2) && x < Math.floor((size - 28) / 2) + 28 &&
      y >= Math.floor((size - 3) / 2) && y < Math.floor((size - 3) / 2) + 3
        ? 255
        : 0,
    );

  it('separates a knife from a horizon, which is the case §4.1 could not tell', () => {
    const small = only2(measureSilhouette(createQualityContext(band(32))));
    const huge = only2(measureSilhouette(createQualityContext(band(1024))));

    // **The shape descriptor is right not to move.** 84 pixels, 62 of boundary, the same
    // drawing: 275 either way, and a gate that separated these two would be a gate about the
    // canvas wearing a shape descriptor's name.
    expect(small.N).toBe(84);
    expect(huge.N).toBe(84);
    expect(small.compactnessQ).toBe(275);
    expect(huge.compactnessQ).toBe(275);
    expect(small.subjectPerimeter).toBe(62);
    expect(huge.subjectPerimeter).toBe(62);
    // The scale-aware reading is the one that sees the difference, and it sees it by 91.
    expect(small.thicknessPx).toBe(3);
    expect(huge.thicknessPx).toBe(3);
    expect(small.thicknessQ).toBe(94);
    expect(huge.thicknessQ).toBe(3);
    expect(small.profileQ).toBe(94);
    expect(huge.profileQ).toBe(3);
    // Both are a 3px band and both are too thin to read, so both fire, and both are below the
    // deep band. The knife is a better sprite than a horizon and the *score* cannot say so:
    // it is a step function and both are deep in the same step. That is a gate question and
    // this is the number that a gate conversation should be argued from.
    expect(codes(small.issues)).toEqual(['thin-profile', 'subject-undersized']);
    expect(codes(huge.issues)).toEqual(['thin-profile', 'subject-undersized']);
    expect(small.scoreQ).toBe(700);
    expect(huge.scoreQ).toBe(700);
  });

  it('does NOT separate the same drawing at two resolutions, and that limit is stated', () => {
    // The knife, magnified 32x, on a canvas magnified 32x. Every measurement is identical and
    // every one of them should be: any ratio of two lengths in one sprite is invariant under
    // uniform magnification. A 3px knife and a 96px knife are different objects to a player,
    // and telling them apart needs a target resolution — which a `.pixel` document does not
    // carry and which this pipeline must not invent.
    const magnified = spriteWhere(1024, 1024, (x, y) =>
      x >= 64 && x < 960 && y >= 464 && y < 560 ? 255 : 0,
    );
    const frame = only2(measureSilhouette(createQualityContext(magnified)));
    expect(frame.thicknessPx).toBe(96);
    expect(frame.compactnessQ).toBe(275);
    // thicknessPx is the one column where they are 32x apart, and it is a pixel count rather
    // than a ratio — which is exactly why it is on the record separately.
    expect(frame.thicknessQ).toBe(94);
    expect(frame.profileQ).toBe(94);
    expect(frame.scoreQ).toBe(700);
  });

  it('reads a punched hole as lost interior room, not as a smaller sprite', () => {
    // The same 20x20 body with and without a hole, which is the measurement noticing something
    // the span cannot: the subject is exactly as big in both, and there is measurably less room
    // inside it once a pixel is taken out. A 1px nick costs 6px of inscribed square; a 6x6
    // window costs 11.
    const body = (hole: readonly [number, number, number] | null): Sprite =>
      spriteWhere(24, 24, (x, y) => {
        const on = x >= 2 && x < 22 && y >= 2 && y < 22;
        if (!on) return 0;
        if (hole === null) return 255;
        const [hx, hy, hw] = hole;
        return x >= hx && x < hx + hw && y >= hy && y < hy + hw ? 0 : 255;
      });
    const solid = only2(measureSilhouette(createQualityContext(body(null))));
    const nick = only2(measureSilhouette(createQualityContext(body([7, 7, 1]))));
    const window = only2(measureSilhouette(createQualityContext(body([7, 7, 6]))));
    // Identical bounds, identical span, identical N except for the hole's own pixels.
    expect(nick.bounds).toEqual(solid.bounds);
    expect(window.bounds).toEqual(solid.bounds);
    expect(nick.spanQ).toBe(solid.spanQ);
    expect(solid.thicknessPx).toBe(20);
    expect(nick.thicknessPx).toBe(14);
    expect(window.thicknessPx).toBe(9);
    // So the hole clause now separates on three quantities instead of one, and the compactness
    // gap of 288 the corpus measured is joined by a thickness gap of 208.
    expect(nick.thicknessQ - window.thicknessQ).toBe(208);
    expect(nick.compactnessQ - window.compactnessQ).toBe(288);
  });

  it('is a pixel count against a canvas, computed with integer division and no epsilon', () => {
    // The unit, the two guards, and the exact boundaries, so a future change to the rounding
    // shows up here rather than as a one-case drift in the baseline.
    expect(thicknessQ(3, 32, 32)).toBe(94); // 3000/32 = 93.75 -> 94
    expect(thicknessQ(3, 32, 32)).toBe(rhu(3000, 32));
    expect(thicknessQ(1, 16, 16)).toBe(63); // 1000/16 = 62.5 -> 63, round half up
    expect(thicknessQ(0, 16, 16)).toBe(0);
    // A non-square canvas divides by its SHORT side, because that is the dimension a subject
    // has to fit across in both directions.
    expect(thicknessQ(16, 64, 24)).toBe(667);
    // Clamped at 1000 so a subject thicker than its canvas cannot exceed the scale, and
    // guarded against a zero-sized canvas rather than dividing by it.
    expect(thicknessQ(64, 16, 16)).toBe(1000);
    expect(thicknessQ(4, 0, 16)).toBe(0);
    for (const px of [0, 1, 2, 3, 7, 16, 31, 64, 1024]) {
      for (const size of [1, 7, 16, 32, 1024, 4096]) {
        const value = thicknessQ(px, size, size);
        expect(Number.isInteger(value), `thicknessQ(${px}, ${size})`).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1000);
      }
    }
  });

  it('inscribes the largest square, which is a max and so ignores a slender limb', () => {
    // The DP is a rolling row over the subject's own bounds, so both halves of that matter are
    // worth pinning: a body with a 1px antenna reads the body, and a 20x20 body with a 6x6
    // window in it reads 14.
    const rect = (w: number, h: number): Uint8Array => {
      const mask = new Uint8Array(32 * 32);
      for (let y = 5; y < 5 + h; y++) for (let x = 5; x < 5 + w; x++) mask[y * 32 + x] = 1;
      return mask;
    };
    const bounds = { x: 5, y: 5, w: 20, h: 20 };
    expect(inscribedSquareSide(rect(20, 20), 32, 32, bounds)).toBe(20);
    expect(inscribedSquareSide(rect(20, 6), 32, 32, { x: 5, y: 5, w: 20, h: 6 })).toBe(6);
    expect(inscribedSquareSide(rect(1, 20), 32, 32, { x: 5, y: 5, w: 1, h: 20 })).toBe(1);
    expect(inscribedSquareSide(new Uint8Array(32 * 32), 32, 32, bounds)).toBe(0);
    // And the blindness, stated: a 20x20 body with a 1px antenna beside it is still 20, because
    // a MAX describes where a shape has room rather than where it is thin. §3.3's argument is
    // about room for a terminator, and a 1px appendage is `noise`'s and `outline`'s business.
    const antenna = rect(20, 20);
    antenna[5 * 32 + 1] = 1;
    expect(inscribedSquareSide(antenna, 32, 32, bounds)).toBe(20);
  });
});

describe('§3.3 convexCorner is a concave-corner counter — measured, not argued', () => {
  it('counts 0 on a disc, which is the claim §4.2 says is "roughly half" of the outline', () => {
    const disc = discSprite(64);
    const context = createQualityContext(disc);
    const mask = buildSolidMask(context.composite[0], 64, 64).mask;
    // The disc's outline is 100% a convex boundary made of 45° staircases, and the
    // predicate finds nothing in it. §3.3's rationale for the definition is false.
    expect(countConvexCorners(mask, 64, 64)).toBe(0);
    const frame = only2(measureSilhouette(context));
    expect(frame.convexCorners).toBe(0);
    // The shape is emphatically convex and emphatically not thin, so nothing else is
    // standing in for the quantity.
    expect(frame.compactnessQ).toBeGreaterThan(300);
    expect(frame.issues).toEqual([]);
  });

  it('counts 0 on a rectangle, where the four corners are not a staircase at all', () => {
    const mask = buildSolidMask(
      createQualityContext(rectSprite(16, 16, { x: 0, y: 0, w: 16, h: 16 })).composite[0],
      16,
      16,
    ).mask;
    expect(countConvexCorners(mask, 16, 16)).toBe(0);
  });

  it('counts 0 on a 3px-wide diagonal band, which is where the formula is most wrong', () => {
    // Every pixel of a band's outer edge has exactly two solid orthogonal neighbours, and
    // the diagonal between them is the next pixel of the band, so it is solid and the
    // clause can never be satisfied on a convex staircase.
    const mask = new Uint8Array(24 * 24);
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 24; x++) {
        const d = y - x;
        if (d >= 0 && d < 3) mask[y * 24 + x] = 1;
      }
    }
    expect(countConvexCorners(mask, 24, 24)).toBe(0);
  });

  it('counts a one-pixel nick in the boundary — so the quantity is concave, not convex', () => {
    const block = (): Uint8Array => {
      const mask = new Uint8Array(9 * 9);
      for (let y = 2; y < 7; y++) for (let x = 2; x < 7; x++) mask[y * 9 + x] = 1;
      return mask;
    };
    expect(countConvexCorners(block(), 9, 9)).toBe(0);
    // Chamfer the top-right corner by one pixel. Still 0: the pixel at (5,2) has two solid
    // orthogonal neighbours, and the diagonal between them — (4,3) — is solid, because it
    // is the next pixel of the staircase. That is the whole finding: a convex boundary is
    // exactly the configuration the formula rejects.
    const nicked = block();
    nicked[2 * 9 + 6] = 0;
    expect(countConvexCorners(nicked, 9, 9)).toBe(0);
    // Now punch a one-pixel nick diagonally outside that corner. The pixel at (5,2) then
    // has exactly two solid orthogonal neighbours, adjacent, with a transparent pixel
    // between their diagonal, and the predicate fires. That configuration is a
    // *concavity* in the outline.
    nicked[3 * 9 + 4] = 0;
    expect(countConvexCorners(nicked, 9, 9)).toBe(1);
  });

  it('means nothing for §4.1, which does not use it, and that is why §4.1 still scores', () => {
    // The scoping question: is the dimension inert because of this predicate? No. §4.1's
    // conditions are share, strayCount, holeRatio, compactnessQ, borderTouch and span, and
    // none of them reads convexCorners. §4.2's curvature gate is where it would bite, and
    // T-013 is the task that has to know.
    const blob = spriteFromRows(CLEAN_BLOB);
    const frame = only2(measureSilhouette(createQualityContext(blob)));
    expect(frame.convexCorners).toBe(0);
    expect(frame.scoreQ).toBe(1000);
  });
});

describe('the shared quantities, tested as quantities', () => {
  it('counts edge transitions, not edge pixels', () => {
    // A 10x8 rectangle: 36 boundary transitions, and 10*2 + 6*2 = 32 edge pixels. The two
    // quantities are close on a rectangle and diverge on anything with a staircase, which
    // is why §3.3 insists they are not interchangeable.
    const mask = new Uint8Array(16 * 16);
    for (let y = 3; y < 11; y++) for (let x = 5; x < 15; x++) mask[y * 16 + x] = 1;
    expect(boundaryPerimeter(mask, 16, 16)).toBe(36);
    let edgePixels = 0;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        if (mask[y * 16 + x] !== 1) continue;
        if (x === 0 || y === 0 || x === 15 || y === 15) {
          edgePixels++;
          continue;
        }
        if (
          mask[y * 16 + x - 1] === 0 ||
          mask[y * 16 + x + 1] === 0 ||
          mask[(y - 1) * 16 + x] === 0 ||
          mask[(y + 1) * 16 + x] === 0
        ) {
          edgePixels++;
        }
      }
    }
    expect(edgePixels).toBe(32);
    expect(boundaryPerimeter(mask, 16, 16)).not.toBe(edgePixels);
  });

  it('counts the four sides once each, whatever the shape', () => {
    const full = new Uint8Array(4 * 4).fill(1);
    expect(borderTouch(full, 4, 4)).toBe(4);
    const none = new Uint8Array(4 * 4);
    none[1 * 4 + 1] = 1;
    none[2 * 4 + 2] = 1;
    expect(borderTouch(none, 4, 4)).toBe(0);
    const two = new Uint8Array(4 * 4);
    two[0 * 4 + 1] = 1; // top edge only
    two[3 * 4 + 1] = 1; // bottom edge only
    expect(borderTouch(two, 4, 4)).toBe(2);
    // A pixel in a corner reaches two sides at once, which is why "how many sides" and
    // "which sides" are not the same question.
    const corner = new Uint8Array(4 * 4);
    corner[0] = 1;
    expect(borderTouch(corner, 4, 4)).toBe(2);
  });

  it('rounds half up and never floats', () => {
    expect(rhu(5, 10)).toBe(1); // 0.5 -> 1, not 0
    expect(rhu(4, 10)).toBe(0);
    expect(rhu(6, 10)).toBe(1);
    expect(rhu(1, 3)).toBe(0);
    expect(rhu(2, 3)).toBe(1);
    // A big product stays exact, which is the property the per-mille discipline buys.
    expect(rhu(1420000 * 16777216, 1)).toBe(1420000 * 16777216);
  });

  it('returns 0 compactness rather than dividing by a zero perimeter', () => {
    expect(compactnessQ(100, 0)).toBe(0);
    expect(compactnessQ(1, 4)).toBeGreaterThan(0);
  });
});
