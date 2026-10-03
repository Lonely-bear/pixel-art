import { describe, expect, it } from 'vitest';
import { createQualityContext } from '../src/quality/context.js';
import { buildSolidMask, distField, edgePixelAt, lqOf, rhu } from '../src/quality/measure.js';
import {
  measureOutline,
  OUTLINE_ABSENT_SHARE_Q,
  outlineAnalyzer,
  outlineApplicability,
} from '../src/quality/outline.js';
import {
  DEFAULT_DIMENSIONS,
  evaluate,
  requiresReadableSubject,
  weightedTotalQ,
} from '../src/quality/index.js';
import {
  DEFAULT_QUALITY_WEIGHTS,
  reportInvariantViolations,
  type QualityContext,
  type QualityDimensionId,
  type QualityIssue,
} from '../src/quality/types.js';
import { createSprite, type Sprite } from '../src/document.js';
import { createPalette } from '../src/palette.js';
import { PixelBuffer } from '../src/buffer.js';

/**
 * The `outline` dimension: §4.5's numbers measured, and the two defects this specification has left.
 *
 * ## The shape of this file
 *
 * Every measure gets **a construction that must trip it and a near-miss on the other side of the same
 * gate**, because one direction is not a threshold and an assertion that passes with and without the
 * implementation proves nothing.
 *
 * ## What is fixed and what is not
 *
 * Two of §4.5's three recorded disproofs are repaired here, and the third is **not** — it is
 * measured, bounded and pinned, and §4.5 carries the numbers. Reading this file as though all three
 * were fixed would be the error `ditherMask` shipped, in a different quantity:
 *
 *   - **`inkGaps` now discriminates.** The predicate asks where the contour *stops* rather than how
 *     each pixel is attached, so a closed 1px staircase contour reads **0** gaps and the same contour
 *     with nicks taken out of it reads **2** for one nick and **4** for two. The old predicate read
 *     22 of 60 on both a perfect contour and a damaged one — identical, so no discrimination at all.
 *     There is a MUST FIRE and a NEAR MISS below, and the near-miss is *exact*, which is the
 *     property the old one lacked; the MUST FIRE's price is that the count is of events rather than
 *     of missing length, and a single nine-row nick still reads 2.
 *   - **Interior shading is no longer read as a deep contour.** `ink` is bounded to the contour band
 *     and to dark regions connected to the subject's boundary, and depth is a same-colour radial run
 *     rather than a distance. Measured on `artwork/verify/lantern-keeper.pixel`: the readings moved
 *     from `maxInkDepth 6, inkColours 6, scoreQ 300` to `maxInkDepth 1, inkColours 2, scoreQ 650`,
 *     and the sprite's only remaining issue is one advisory `outline-gap` at severity 0.25.
 *   - **A uniform contour three or more pixels thick is read as the contour it is.** This was §4.5's
 *     finding 1 and it stood as a disproof: the pixels of a 4px uniform contour and the pixels of a
 *     4px shadow that reaches the boundary are the same pixels, so no tone-and-distance predicate
 *     separates them. **The disproof was true per pixel and incomplete about the set.** A contour
 *     *wraps* the subject and a shadow *occupies one side* of it, and `encloses` asks exactly that:
 *     can the exterior reach the subject's interior without crossing the dark set? Measured on this
 *     file's fixtures, the 4px contour reads `outlineShare 1000` where it used to read `0` and
 *     `outline-missing`, and §4.5's `minInkDepth >= 3` row now **fires on a real construction**.
 *     The price is zero: all nine declared negative controls read byte-identically, and
 *     `lantern-keeper` holds at 650. §4.5 carries the three-column measurement.
 *   - **`inkGaps` discriminates, but it counts *discontinuities*, not missing length.** A closed
 *     staircase contour reads 0, and so does a single nick of **any** size up to nine rows — every
 *     single-nick construction reads exactly 2 events, 33 of 60, under the 50 gate. Two nicks read
 *     4 events, 67 of 60, and the gate trips. That is what the new predicate buys and what it costs,
 *     and both ends of the gate are asserted.
 *
 * **Two numbers in this file are deliberately not the ones a reader would guess**
 *
 *   - `minInkDepth` reads **0** on a uniformly 2px contour, while `maxInkDepth` and every
 *     `quadrantDepth` read 1. The four pixels responsible are exactly the four **corners**, and the
 *     cause is that the run recurrence is 4-connected while a rectilinear corner steps inward
 *     diagonally. `quadrantDepth` is a per-quadrant **max** and `minInkDepth` a per-pixel **min**, so
 *     the two disagree at every corner of every rectilinear subject. Both readings are asserted.
 *   - `inkCount` is 1 of 44 boundary pixels on `isolatedInkPixel(0)`, which is `outlineShare 23` —
 *     far below §4.5's 150 abstention gate, so that subject *is* declined by `outlineApplicability`
 *     while being the near-miss that proves the boundary connection accepts a boundary pixel. It
 *     used to "carry `outline-missing`" here; it now carries nothing at all, which is the point.
 *
 * ## The absent-contour case, and where its gate lives
 *
 * §4.5's `outlineShare < 15/100` case is `ExcludedReason` `'no-outline'`, not a score, and the gate
 * is `outlineApplicability` — the aggregator's, beside `requiresReadableSubject` and
 * `motionApplicability`, because a dimension that declared its own unfitness would be the analyzer
 * deciding whether its own answer counts. `OUTLINE_NEUTRAL_Q` and the `outline-missing` code are
 * both gone; the neutral 700 was a *passing* mark handed out for having said nothing, and §3.5's
 * verdict turns it into a `warn` wherever the total drops.
 *
 * `measureFrame` still computes a `baseQ` below the gate, because the corpus and this file both ask
 * it about frames directly, and there it is §4.5's own "otherwise" row — 550, no Δ rows, no issues.
 * The two tests below that assert `baseQ: 550` with an empty issue list are asserting the honest
 * floor, not a new band.
 *
 * ## The fixtures are drawn, not poked
 *
 * For `quality-silhouette.test.ts`'s reason: a measure whose input is `data[i*4+3] = 255` in six
 * places cannot be reviewed by anyone, including the author on a bad day. Every subject here is a
 * shape drawn as a pixel set, and the outline fixtures are drawn as *a body tone and an ink tone*,
 * because `ink` is a difference between them and a single-tone picture measures nothing at all.
 */

/** `[left, right, y]`, one row of a shape, inclusive. */
type Row = readonly [number, number, number];

/** The body tone. `Lq` 200. */
const BODY = '#c8c8c8';
/** The ink drawn on the contour. `Lq` 16. 184 apart, against §4.5's threshold of 20. */
const INK = '#101010';
/** Three further contour colours for `inkColours`. Each is checked to register as ink. */
const ALT_A = '#701030';
const ALT_B = '#105030';
const ALT_C = '#a08010';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function hexToRgb(hex: string): readonly [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * `demo.ts`'s own 22-row silhouette, centred in the 32x32 canvas with a 5px margin all round so
 * `requiresReadableSubject` accepts it.
 *
 * Borrowed rather than invented so the staircase-contour fixtures sit on the shape the product
 * ships, and so `edgePixels` is a number that can be checked against §3.3 by hand.
 */
const DISC: readonly Row[] = [
  [10, 21, 5], [9, 22, 6], [8, 23, 7], [7, 24, 8], [6, 25, 9], [5, 26, 10], [4, 27, 11],
  [4, 27, 12], [4, 27, 13], [4, 27, 14], [4, 27, 15], [4, 27, 16], [4, 27, 17], [4, 27, 18],
  [5, 26, 19], [6, 25, 20], [7, 24, 21], [8, 23, 22], [9, 22, 23], [10, 21, 24], [11, 20, 25],
];

/** A `size`x`size` solid block with its top-left at `(left, top)`. */
function block(size: number, left: number, top: number): Set<number> {
  const out = new Set<number>();
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) out.add((top + y) * 32 + left + x);
  return out;
}

/** `mask` eroded `times` by the 4-neighbourhood: `mask` minus `times` rings. */
function erode(mask: ReadonlySet<number>, times: number): Set<number> {
  let cur = new Set(mask);
  for (let t = 0; t < times; t++) {
    const next = new Set<number>();
    for (const p of cur) {
      if (cur.has(p - 1) && cur.has(p + 1) && cur.has(p - 32) && cur.has(p + 32)) next.add(p);
    }
    cur = next;
  }
  return cur;
}

/** `mask` minus `erode(mask, rings)`: the outer `rings` pixels. */
function ring(mask: ReadonlySet<number>, rings: number): Set<number> {
  const kept = erode(mask, rings);
  return new Set([...mask].filter((p) => !kept.has(p)));
}

/** The disc's solid pixel set. */
function discSolid(): Set<number> {
  const out = new Set<number>();
  for (const [left, right, y] of DISC) for (let x = left; x <= right; x++) out.add(y * 32 + x);
  return out;
}

type Op = readonly [Row, string];

function bodyOf(pixels: ReadonlySet<number>): Op[] {
  return [...pixels].map((p) => {
    const x = p % 32;
    const y = (p - x) / 32;
    return [[x, x, y], BODY] as const;
  });
}

function inkOf(pixels: ReadonlySet<number>, hex: string): Op[] {
  return [...pixels].map((p) => {
    const x = p % 32;
    const y = (p - x) / 32;
    return [[x, x, y], hex] as const;
  });
}

function spriteOf(ops: readonly Op[], frames = 1): Sprite {
  const palette = [...new Set(ops.map(([, hex]) => hex))];
  const sprite = createSprite({
    width: 32,
    height: 32,
    frames,
    name: 'outline-fixture',
    layers: ['Base'],
    // The fixture's own palette, for `quality-value.test.ts`'s reason: these pictures paint a
    // fixed set of greens/blues that the default 16-entry DawnBringer does not name, and a
    // dimension asserting a defect about the picture rather than about its palette is the only
    // kind worth writing a test about.
    palette: createPalette('outline-fixture', palette),
  });
  const layer = sprite.layers[0].id;
  const map = new Map(palette.map((hex) => [hex, hexToRgb(hex)]));
  for (let f = 0; f < frames; f++) {
    const cel = new PixelBuffer(32, 32);
    for (const [row, hex] of ops) {
      const [r, g, b] = map.get(hex) as readonly [number, number, number];
      for (let x = row[0]; x <= row[1]; x++) {
        const i = cel.index(x, row[2]);
        cel.data[i] = r;
        cel.data[i + 1] = g;
        cel.data[i + 2] = b;
        cel.data[i + 3] = 255;
      }
    }
    sprite.frames[f].cels.set(layer, cel);
  }
  return sprite;
}

function contextOf(sprite: Sprite): QualityContext {
  return createQualityContext(sprite);
}

function codes(issues: readonly QualityIssue[]): readonly string[] {
  return issues.map((issue) => issue.code);
}

/**
 * The registry with `outline` in it, carrying **both** of its preconditions.
 *
 * **`requiresReadableSubject` first, `outlineApplicability` second, and the order is the contract.**
 * A full-bleed document has no subject to read a contour *around*, so its `edgePixels` is the canvas
 * rectangle; that is a different and stronger claim than "it declares no contour", and the reason
 * has to win or a scene gets graded as though its frame were a style choice. `null` is
 * "applicable", so this is a straight `??` chain rather than a list to search.
 *
 * **It was `[...DEFAULT_DIMENSIONS, {outline}]` while the dimension was unregistered, and that line
 * became a duplicate-registration throw the moment it registered** — `indexRegistrations` rejects
 * two registrations for one id, which is the same guard that keeps `evaluate` from silently
 * averaging two answers into one. The literal is now built *around* the shipped registration rather
 * than appended to it: `DEFAULT_DIMENSIONS` is filtered down to the four dimensions that predate
 * §4.5 and the shipped `outline` entry is appended, so this file still asserts the behaviour of the
 * shipped wiring (same analyzer, same two-precondition chain) instead of asserting that the wiring
 * exists, which is `quality-report.test.ts`'s job. If §4.5's registration ever loses a
 * precondition, the test below fails rather than this file quietly passing against a local copy.
 */
const DIMENSIONS_WITH_OUTLINE: typeof DEFAULT_DIMENSIONS = [
  ...DEFAULT_DIMENSIONS.filter((dimension) => dimension.id !== 'outline'),
  {
    id: 'outline' as QualityDimensionId,
    analyze: outlineAnalyzer,
    applies: (context: QualityContext) =>
      requiresReadableSubject(context) ?? outlineApplicability(context),
  },
];

/** A closed 1px ink contour on `size`x`size`. The negative control. */
function rectContour(size: number, rings = 1): Sprite {
  const b = block(size, 16 - Math.floor(size / 2), 16 - Math.floor(size / 2));
  return spriteOf([...bodyOf(b), ...inkOf(ring(b, rings), INK)]);
}

/** The disc with a closed 1px ink contour — a staircase contour, which is the finding case. */
function discContour(rings = 1): Sprite {
  const b = discSolid();
  return spriteOf([...bodyOf(b), ...inkOf(ring(b, 1), INK)]);
}

/** The disc with no contour at all. */
function bareDisc(): Sprite {
  return spriteOf(bodyOf(discSolid()));
}

/**
 * A 16x16 block whose contour is `deep` rings over the top half and `shallow` over the bottom.
 *
 * Each half is eroded **as its own shape**, so the seam at row 16 counts as a boundary for the top
 * half's erosion even though it is interior to the sprite. That is what makes the deepest ink land
 * at §3.3 `dist` 3 rather than 1, and it is what lets a construction reach the depth row at all.
 *
 * **It also paints the seam rows ink right across the full width**, which is not what the fixture's
 * name suggests and is the reason for a measured reading recorded in the `inkDepth` block below: a
 * contour pixel on the left or right silhouette edge has a four-pixel-deep same-colour run running
 * inward along those seam rows, and `maxInkDepth` reads **4** rather than 1 or 2. Kept rather than
 * repaired — it is a real property of a real drawing, and §4.5 records what it does to the row.
 */
function twoWeightContour(deep: number, shallow: number): Sprite {
  const b = block(16, 8, 8);
  const midRow = 16;
  const top = new Set([...b].filter((p) => Math.floor(p / 32) < midRow));
  const bottom = new Set([...b].filter((p) => Math.floor(p / 32) >= midRow));
  const ink = new Set([...ring(top, deep), ...ring(bottom, shallow)]);
  return spriteOf([...bodyOf(b), ...inkOf(ink, INK)]);
}

/**
 * A 4px contour over the whole of a 16x16 block: §4.5's "uniformly heavy but consistent" case.
 *
 * **This is §4.5's finding 1, repaired, and the fixture is the MUST FIRE for it.** A uniform ring
 * three or more rings thick has no local contrast left, so under the local-only reference it read
 * `outlineShare 0` and `outline-missing` — the dimension reporting the heaviest contour in its own
 * vocabulary as *having no outline*. It now reads `outlineShare 1000` and `outline-heavy` at 0.70,
 * on coverage. §4.5 records the repair and its price; the price is that the coverage row, not the
 * depth row, is what catches this fixture, because a rectilinear contour's four corners read depth
 * 0 (finding 5). The staircase twin below is what reaches the depth row.
 */
function heavyUniformContour(): Sprite {
  return rectContour(16, 4);
}

/**
 * The **staircase** twin of {@link heavyUniformContour}: a 4px uniform contour on the 22-row disc.
 *
 * This is the fixture that makes §4.5's `minInkDepth >= 3` row **reachable**, and the reason it is
 * built on the disc rather than on a block is finding 5: a rectilinear contour's four corners have
 * no 4-adjacent neighbour one `dist` step inward, so they read depth 0 and hold `minInkDepth` at 0
 * no matter how thick the contour around them is. A 45-degree staircase has no corners, so every
 * contour pixel on it reads its true depth — measured `minInkDepth 3, maxInkDepth 3` — and the row
 * fires. §4.5 records that the row "is reachable only on a contour of varying weight, where the
 * `quadrantDepth` row fires at the same time"; this fixture is the case where it is not.
 */
function heavyUniformDiscContour(rings = 4): Sprite {
  const b = discSolid();
  return spriteOf([...bodyOf(b), ...inkOf(ring(b, rings), INK)]);
}

/**
 * §4.5's inseparable pair, drawn: a 16x16 block whose **left half** is a dark tone.
 *
 * The `control/clean-blob-16` shape that §4.5 names as the reason the band-excluded reference was
 * rejected — "on a 10x8 block whose left half is a dark tone that dark half genuinely *is* a
 * five-pixel-deep dark band on a quarter of its boundary". Those pixels are the same pixels a 4px
 * uniform contour is made of. The two fixtures are asserted against each other in `outline
 * ink: a thick contour and a one-sided shadow are the same pixels and only the enclosure
 * clause separates them`, and the separation is topological, not tonal.
 */
function oneSidedShadowBlock(): Sprite {
  const b = block(16, 8, 8);
  const ops = [...bodyOf(b)];
  for (const p of b) {
    if (p % 32 >= 16) continue;
    const x = p % 32;
    ops.push([[x, x, (p - x) / 32], INK]);
  }
  return spriteOf(ops);
}

/**
 * A contour that is `deep` rings over one **flank** of the disc and 1 ring everywhere else.
 *
 * **This replaces `twoWeightContour` as the construction for the inconsistent-weight row, and the
 * reason is measured rather than preferred.** `twoWeightContour` erodes each *half* as its own shape,
 * which paints its seam row ink right across the subject's full width — the file's own comment says
 * so, and §4.5's finding 5 repeats it. Under the shipped local-only predicate that artifact sat
 * alongside a partly-undetected seam and the row still fired. Under the repaired predicate the seam
 * is *correctly* detected as a four-pixel-deep dark band (it genuinely is one), so it reaches every
 * quadrant and `quadrantDepth` reads `[4, 4, 4, 4]` — spread 0, row silent.
 *
 * That is not the row going blind: it is the row being handed a fixture whose deepest ink is a
 * full-width seam, which puts the same depth 4 in all four quadrants by construction. Weight that
 * **varies around the loop** has to be drawn varying around the loop. This fixture does, and it has
 * no seam at all: 1 ring everywhere plus 2 more rings on one flank. Measured `quadrantDepth
 * [0, 2, 0, 2]` right-weighted and `[2, 0, 2, 0]` left-weighted, spread 2 both ways, which is also
 * the mirror that says the reading follows the flank and not the drawing's handedness.
 */
function flankWeightedContour(deep: number, flank: 'left' | 'right' = 'right'): Sprite {
  const b = discSolid();
  const onFlank = (p: number): boolean => {
    const x = p % 32;
    return flank === 'right' ? x >= 22 : x <= 9;
  };
  const inkSet = new Set<number>([...ring(b, 1)]);
  for (let r = 2; r <= deep; r++) {
    for (const p of ring(b, r)) if (onFlank(p)) inkSet.add(p);
  }
  return spriteOf([...bodyOf(b), ...inkOf(inkSet, INK)]);
}

/** §4.5's `>= 4` ink colours with the fourth colour holding `>= 5%` of the ink. */
function splitColourContour(): Sprite {
  const b = block(16, 8, 8);
  const r = ring(b, 1);
  const ops = [...bodyOf(b)];
  for (const p of r) {
    const x = p % 32;
    const y = (p - x) / 32;
    // 60 boundary pixels: 16 on the left columns, then bands of 3, 2 and the remainder, so the
    // fourth commonest colour is a real share of the contour rather than a speck.
    const hex = x < 12 ? INK : x < 15 ? ALT_A : x < 17 ? ALT_B : ALT_C;
    ops.push([[x, x, y], hex]);
  }
  return spriteOf(ops);
}

/** Five ink colours whose fourth-commonest is negligible: the share clause's near miss. */
function speckColourContour(): Sprite {
  const b = block(16, 8, 8);
  const r = ring(b, 1);
  const ops = [...bodyOf(b)];
  let specked = 0;
  for (const p of r) {
    const x = p % 32;
    const y = (p - x) / 32;
    if (specked < 2) {
      // Two pixels of a fifth colour, and it has to be a *dark* one: `ink` requires a pixel to be
      // darker than its 5x5 neighbourhood, so a white speck on a `#c8c8c8` body is not ink at all
      // and would quietly reduce the colour count instead of testing the share clause.
      ops.push([[x, x, y], '#081018']);
      specked++;
      continue;
    }
    const hex = x < 13 ? INK : x < 18 ? ALT_A : ALT_B;
    ops.push([[x, x, y], hex]);
  }
  return spriteOf(ops);
}

/** The disc's closed 1px contour with a nick of `rows` taken out of the right flank. */
function nickedDiscContour(rows = 3): Sprite {
  const b = discSolid();
  const y0 = 15 - Math.floor(rows / 2);
  const nick = new Set(
    [...ring(b, 1)].filter((p) => {
      const x = p % 32;
      const y = (p - x) / 32;
      return x >= 25 && y >= y0 && y < y0 + rows;
    }),
  );
  return spriteOf([...bodyOf(b), ...inkOf(new Set([...ring(b, 1)].filter((p) => !nick.has(p))), INK)]);
}

/** The disc's closed 1px contour with a nick at each end of the right flank. */
function twiceNickedDiscContour(): Sprite {
  const b = discSolid();
  const keep = new Set(
    [...ring(b, 1)].filter((p) => {
      const x = p % 32;
      const y = (p - x) / 32;
      if (x < 25) return true;
      // Two three-pixel nicks on the same flank, separated by three intact contour pixels.
      const inNick = (a: number) => y >= a && y < a + 3;
      return !inNick(12) && !inNick(19);
    }),
  );
  return spriteOf([...bodyOf(b), ...inkOf(keep, INK)]);
}

/**
 * A 12x12 body with **one** ink pixel, placed at `dist` `depth` inside it.
 *
 * The single control for §4.5's band-and-connection clauses, because a lone dark pixel is `dark` by
 * §4.5's own definition at any depth: its 5x5 neighbourhood is all `#c8c8c8`, so it is 184 `Lq`
 * below its local mean and no threshold moves it. What decides whether it is *ink* is exactly the two
 * clauses this dimension added, and nothing else about the pixel.
 */
function isolatedInkPixel(depth: number): Sprite {
  const b = block(12, 10, 10);
  const ops = [...bodyOf(b)];
  // The centre column of the top row, walked inward: `depth` 0 is the boundary itself and
  // `dist(15, 10 + d)` on a 12x12 block at (10, 10) is exactly `d` for `d <= 5`.
  ops.push([[15, 15, 10 + depth], INK]);
  return spriteOf(ops);
}

/**
 * A 16x16 block contoured on its **top row and left column only** — an L.
 *
 * The control for the *empty quadrant*: the contour's own bounding box is the whole block, three of
 * its four quadrants carry contour and the fourth carries none, so `quadrantDepth` has to be able to
 * say "nothing here" and the spread has to be computed over the quadrants that hold ink rather than
 * over four numbers where one of them means "nothing here".
 *
 * **This replaces a half-contoured disc as that control, and the reason is measured rather than
 * preferred.** Eroding a half-disc paints its seam row ink right across the full width of the
 * subject, so the disc's widest row is a four-pixel-deep dark band touching both silhouette edges:
 * `topHalfDisc` reads `quadrantDepth [0, 0, 4, 4]`, not `[-1, -1, …]`, and fires
 * `outline-inconsistent-weight`. It is a *real* reading of that drawing and §4.5 carries it, but it
 * is no use as a control for an **absent** quadrant, because no quadrant is absent. An L is.
 */
function lShapedContour(): Sprite {
  const b = block(16, 8, 8);
  const ops = [...bodyOf(b)];
  for (let x = 8; x <= 23; x++) ops.push([[x, x, 8], INK]);
  for (let y = 9; y <= 23; y++) ops.push([[8, 8, y], INK]);
  return spriteOf(ops);
}

/** The disc, contoured over its top half only — the measurement `lShapedContour` replaced. */
function topHalfDisc(): Sprite {
  const b = discSolid();
  const top = new Set([...b].filter((p) => Math.floor(p / 32) < 15));
  return spriteOf([...bodyOf(b), ...inkOf(ring(top, 1), INK)]);
}

/* ------------------------------------------------------------------ *
 * The fixtures themselves are measurements
 * ------------------------------------------------------------------ */

describe('outline fixtures', () => {
  it('separates the body tone from the ink by more than §4.5 threshold of 20', () => {
    // Without this the whole file measures nothing: `ink` is a *difference*, and two tones 20 Lq
    // apart put the predicate exactly on its own boundary.
    const lq = (hex: string): number => {
      const [r, g, b] = hexToRgb(hex);
      return (54 * r + 183 * g + 18 * b) >> 8;
    };
    expect(lq(BODY) - lq(INK)).toBeGreaterThan(20);
    expect(lq(ALT_A)).toBeLessThan(lq(BODY));
    expect(lq(ALT_B)).toBeLessThan(lq(BODY));
    expect(lq(ALT_C)).toBeLessThan(lq(BODY));
  });

  it('a 1px contour on a 16x16 block inks every boundary pixel and nothing else', () => {
    const b = block(16, 8, 8);
    const frame = measureOutline(contextOf(rectContour(16)))[0];
    // §3.3's `edgePixels` for a 16x16 block: 4 sides of 16 minus the 4 double-counted corners.
    expect(frame.edgePixels).toBe(60);
    expect(frame.inkCount).toBe(60);
    expect(ring(b, 1).size).toBe(60);
  });

  it('the isolated-ink fixture puts its pixel at the depth it claims', () => {
    // The control above is only a control if the pixel really is where it says it is, and the
    // distance is read from `measure.ts`'s own field rather than counted by hand.
    for (const depth of [0, 2, 3]) {
      const context = contextOf(isolatedInkPixel(depth));
      const { mask } = buildSolidMask(context.composite[0], 32, 32);
      const { dist } = distField(mask, 32, 32);
      expect(dist[(10 + depth) * 32 + 15]).toBe(depth);
    }
  });
});

/* ------------------------------------------------------------------ *
 * The negative controls
 * ------------------------------------------------------------------ */

describe('outline negative controls', () => {
  for (const size of [10, 12, 16]) {
    it(`a closed 1px contour on a ${size}x${size} block issues nothing at all`, () => {
      // The strictest form of a negative control available: not merely "no outline-* code" but no
      // issue from this dimension whatever its code. §"Proving a measurement works" rule 5 is that
      // a dimension firing on clean work is worse than one that misses a defect, and this is the
      // assertion that makes it checkable rather than aspirational.
      const dimension = outlineAnalyzer(contextOf(rectContour(size)));
      expect(dimension.issues).toEqual([]);
      expect(dimension.scoreQ).toBe(950);
      expect(dimension.verdict).toContain('1000/1000');
    });
  }

  it('a closed 2px contour on a 16x16 block is still clean — depth 1 is not depth 3', () => {
    const dimension = outlineAnalyzer(contextOf(rectContour(16, 2)));
    expect(dimension.issues).toEqual([]);
    expect(dimension.scoreQ).toBe(950);
  });
});

/* ------------------------------------------------------------------ *
 * `outlineShare`: the primary ratio, its units, and its band table
 * ------------------------------------------------------------------ */

describe('outline outlineShare', () => {
  it('MUST FIRE: a body with no contour at all reads share 0 and the DOCUMENT abstains', () => {
    // **The gate moved, and both halves are asserted.** The measurement still reads share 0 — that
    // is §4.5's quantity and it has not moved — but it no longer produces a score and no issue:
    // `outlineApplicability` declines the whole document with `'no-outline'` before the analyzer is
    // called, because a subject that declares no contour has asserted nothing to grade. The 700 is
    // gone and so is `outline-missing`; both are asserted absent rather than merely unmentioned,
    // because a code that quietly stops appearing is a code that quietly stops working.
    const context = contextOf(bareDisc());
    const frame = measureOutline(context)[0];
    expect(frame.outlineShare).toBe(0);
    expect(frame.inkCount).toBe(0);
    // §4.5's band table's own "otherwise" row is what a share of 0 lands on, and the analyzer is
    // never reached for such a document — this reading is only reachable from a multi-frame sheet
    // where another frame declares a contour.
    expect(frame.baseQ).toBe(550);
    expect(codes(frame.issues)).not.toContain('outline-missing');

    expect(outlineApplicability(context)).toBe('no-outline');
    const report = evaluate(context, DIMENSIONS_WITH_OUTLINE);
    expect(report.excluded.outline).toBe('no-outline');
    expect(report.dimensions.outline).toBeUndefined();
    // The abstention is not a soft pass and not a free mark either: `weightedTotalQ` builds its
    // denominator from the dimensions that are *present*, so an excluded dimension's weight leaves
    // the mean entirely. Asserted as the arithmetic rather than as a vibe, because §5.2's denominator
    // is the one place a "harmless" abstention could quietly become a 1000 for a measurement nobody
    // took — the T-099 failure, in a new dimension.
    const denominator = Object.keys(report.dimensions).reduce(
      (sum, id) => sum + DEFAULT_QUALITY_WEIGHTS[id as QualityDimensionId],
      0,
    );
    expect(denominator).toBe(1000 - DEFAULT_QUALITY_WEIGHTS.outline - DEFAULT_QUALITY_WEIGHTS.motion);
    expect(report.score).toBeCloseTo(weightedTotalQ(report.dimensions) / 1000, 10);
  });

  it('NEAR MISS on the other side of the 150 gate: a partly contoured subject is measured', () => {
    // The abstention gate is a boundary and both sides of it are asserted. One direction is not a
    // threshold. The near side is a contour on the top half of the disc and none on the bottom.
    const b = discSolid();
    const top = new Set([...b].filter((p) => Math.floor(p / 32) < 15));
    const context = contextOf(spriteOf([...bodyOf(b), ...inkOf(ring(top, 1), INK)]));
    const frame = measureOutline(context)[0];
    expect(frame.outlineShare).toBeGreaterThanOrEqual(150);
    // One pixel either side of 150 on the same drawing family, and the *only* thing that differs is
    // the predicate's answer. A gate that could not be crossed is not a gate.
    expect(outlineApplicability(context)).toBeNull();
    expect(OUTLINE_ABSENT_SHARE_Q).toBe(150);
    expect(outlineApplicability(contextOf(bareDisc()))).toBe('no-outline');
  });

  it('ratio 0 reaches the otherwise row, 550, and the top band is 950', () => {
    // **The band-table direction, asserted on readings rather than on the table's shape.** §4.5
    // writes the table descending, and this repository has shipped a band table read in its
    // written order, where a ratio of 0 matched the loosest row and returned the *worst* score. The
    // first version of `outline.ts` had the mirror defect — an ascending table read with a
    // `return` on the first match, which scored a perfect 1px contour at **700**. Both ends of the
    // table are asserted so neither can regress silently.
    const bare = measureOutline(contextOf(bareDisc()))[0];
    expect(bare.outlineShare).toBe(0);

    // A ratio inside the abstention gate but above the lowest band: the row the `otherwise` clause
    // exists for. Built by inking every third boundary pixel of a 16x16 block, which is 20 of 60.
    const b = block(16, 8, 8);
    const partial = [...ring(b, 1)].filter((_, i) => i % 3 === 0);
    const low = measureOutline(contextOf(spriteOf([...bodyOf(b), ...inkOf(new Set(partial), INK)])))[0];
    expect(low.outlineShare).toBeGreaterThanOrEqual(150);
    expect(low.outlineShare).toBeLessThan(350);
    expect(low.baseQ).toBe(550);

    const full = measureOutline(contextOf(rectContour(16)))[0];
    expect(full.outlineShare).toBe(1000);
    expect(full.baseQ).toBe(950);
  });

  it('the per-mille thresholds are ten times the specification hundredths', () => {
    // §3.7's rule, on the dimension's primary ratio. §4.5 writes `>= 80/100`; the pipeline is
    // per-mille, so the comparison must be against 800. A contour on half the boundary must read
    // the `>= 35/100` row at 700 — **not** the 950 that comparing against `>= 35` would produce.
    // This is the exact defect `off-palette` shipped with: a threshold written in hundredths and
    // compared against a per-mille ratio fires a tenth as late as specified.
    const b = block(16, 8, 8);
    const r = ring(b, 1);
    const half = new Set([...r].filter((_, i) => i % 2 === 0));
    const frame = measureOutline(contextOf(spriteOf([...bodyOf(b), ...inkOf(half, INK)])))[0];
    expect(frame.outlineShare).toBeGreaterThanOrEqual(350);
    expect(frame.outlineShare).toBeLessThan(600);
    expect(frame.baseQ).toBe(700);
  });
});

/* ------------------------------------------------------------------ *
 * The band and the boundary connection: the two clauses §4.5's `ink` gained
 * ------------------------------------------------------------------ */

describe('outline ink is a band adjacent to the boundary, and connected to it', () => {
  it('MUST FIRE: one ink pixel 3 steps inside a body is NOT ink, because nothing leads to it', () => {
    // A lone dark pixel is 184 `Lq` below its 5x5 neighbourhood, so §4.5's `dark` accepts it
    // wherever it is drawn. What rejects it here is the boundary connection, and that clause is what
    // stops an interior shadow from being counted as contour: without it, this same pixel would be
    // a contour pixel at `dist` 3 and `outlineShare` would be 1000 on a subject with no outline.
    const frame = measureOutline(contextOf(isolatedInkPixel(3)))[0];
    // `edgePixels` is asserted on **both** sides of this gate so the contrast is a contrast of the
    // predicate and not of the denominator: 44 boundary pixels either way, `inkCount` 0 against 1.
    expect(frame.edgePixels).toBe(44);
    expect(frame.inkCount).toBe(0);
    expect(frame.inkTotal).toBe(0);
    expect(frame.outlineShare).toBe(0);
    // No `outline-missing`, and that is the change: a subject whose ink is all interior declares no
    // contour, and a document that declares no contour is declined by `outlineApplicability` rather
    // than reported. Asserted as `toEqual([])` because an *absent* code is a weaker claim than an
    // empty issue list, and this file's whole argument is that an abstention must emit nothing.
    expect(frame.issues).toEqual([]);
    expect(outlineApplicability(contextOf(isolatedInkPixel(3)))).toBe('no-outline');
  });

  it('NEAR MISS on the same gate: the identical pixel on the boundary IS ink', () => {
    // One pixel moved, one predicate flipped, one assertion's sign — which is what makes it a gate
    // and not a constant. The pixel is the same colour and the same size; only its distance from the
    // silhouette's exterior boundary changed.
    //
    // **The abstention is asserted as a document-level exclusion, and that is the whole change.**
    // The original version asserted `codes(issues) === ['outline-missing']` here — i.e. it *required*
    // a defect code on a subject that had made no claim. `inkCount` is 1 over `edgePixels` 44, so
    // `outlineShare` is `rhu(1000, 44) = 23`, far below the gate of 150, and one ink pixel on a
    // 44-pixel boundary genuinely *is* an unoutlined subject. The honest reading of that is an
    // abstention, and the abstention is now `excluded.outline = 'no-outline'` with no score and no
    // code. The gate under test is the ink predicate — the boundary connection — and that is what
    // `inkCount` says: **1 here against 0 in the MUST FIRE above, on the same pixel at a different
    // depth.** The arithmetic is asserted rather than waved at, so the two readings cannot be
    // confused for each other later.
    const context = contextOf(isolatedInkPixel(0));
    const frame = measureOutline(context)[0];
    expect(frame.edgePixels).toBe(44);
    expect(frame.inkCount).toBe(1);
    expect(frame.outlineShare).toBe(23);
    expect(frame.outlineShare).toBeLessThan(150);
    expect(frame.issues).toEqual([]);
    expect(outlineApplicability(context)).toBe('no-outline');
    const report = evaluate(context, DIMENSIONS_WITH_OUTLINE);
    expect(report.excluded.outline).toBe('no-outline');
    expect(report.dimensions.outline).toBeUndefined();
    expect(report.blocking.map((i) => i.code)).not.toContain('outline-missing');
  });

  it('the band is as deep as the heavy row tolerates, and no deeper', () => {
    // `CONTOUR_BAND === HEAVY_DEPTH` is not a coincidence: the depth row says a contour reaching
    // `dist` 3 is *too thick*, which is a claim that such a contour is still a contour, so the band
    // has to be at least that deep or the row cannot be reached at all. A pixel beyond the band is
    // not ink however dark it is — which is the clause that stopped
    // `artwork/verify/lantern-keeper.pixel` reading its cloak as a 6px contour.
    expect(isolatedInkPixel(3).layers).toBeDefined(); // the fixture exists
    const frame = measureOutline(contextOf(isolatedInkPixel(3)))[0];
    expect(frame.inkTotal).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * The enclosure gate — §4.5's inseparable pair, and what separates them
 * ------------------------------------------------------------------ */

describe('outline ink: a thick contour and a one-sided shadow are the same pixels', () => {
  it('MUST FIRE: the gate admits a 4px uniform contour, and only the gate makes that possible', () => {
    // The pair §4.5 calls inseparable, drawn as two fixtures that differ in **shape and nothing
    // else** — same 16x16 body, same `#101010` ink at `Lq` 16 against a `#c8c8c8` body at `Lq` 200,
    // same 20 `Lq` threshold, same 4px of dark reaching the boundary on part of it. The only
    // difference is that one dark band goes all the way round and the other stops halfway.
    //
    // §4.5 measured that these are **the same set of pixels** and concluded that no tone-and-distance
    // predicate separates them. That conclusion is correct **per pixel** and it is the reason the
    // repair is not a predicate at all: the question is not what any individual pixel is but what the
    // dark set *does to the subject*. A contour wraps it; a shadow occupies one side of it.
    //
    // **Three columns, all measured on this file's fixtures**, because "the gate is what makes the
    // difference" is the claim and the other two columns are what it is a difference *from*:
    //
    // ```
    //                        local reference only   body reference, ungated   body ref + enclosure
    //   4px uniform contour       share 0               share 1000               share 1000
    //   one-sided dark half       share 67              share 133               share 67
    //   3px staircase contour     share 367             share 1000               share 1000
    // ```
    //
    // The second column is §4.5's rejected repair and it is why a predicate was not enough: it
    // doubles the shadow's contour as well as fixing the contour. The third column is what ships, and
    // **the shadow's reading in it is identical to the first** — a shadow does not enclose, so the body
    // reference is never consulted on it and the reading is untouched.
    const contour = measureOutline(contextOf(heavyUniformContour()))[0];
    expect(contour.inkCount).toBe(60);
    expect(contour.edgePixels).toBe(60);
    expect(contour.outlineShare).toBe(1000);

    const shadow = measureOutline(contextOf(oneSidedShadowBlock()))[0];
    expect(shadow.outlineShare).toBe(67);
    expect(shadow.inkCount).toBe(4);
    expect(shadow.edgePixels).toBe(60);
    expect(shadow.outlineCoverage).toBe(63);
    // It abstains, and abstaining is the right reading: half a contour is not a contour. And the
    // shadow's ink *is* four pixels deep — `maxInkDepth 4` — so the band and the run measure both
    // admit it; the enclosure clause is the only thing that declines to call it contour. The
    // abstention is now a **document-level** one with no code and no score, rather than a neutral 700
    // carrying `outline-missing` — which was a defect report on a subject that had done nothing wrong.
    expect(shadow.maxInkDepth).toBe(4);
    expect(shadow.issues).toEqual([]);
    expect(outlineApplicability(contextOf(oneSidedShadowBlock()))).toBe('no-outline');
  });

  it('NEAR MISS on the enclosure clause itself: one ring less on the flank is enough to open it', () => {
    // The gate is a gate and not a constant, and this is the other side of it. Take the dark band
    // that encloses and interrupt it by a single row, and the exterior can get in: the subject's
    // interior becomes reachable from outside without crossing the band, `encloses` is false, and the
    // band is not admitted as contour. One row is the whole difference.
    const b = block(16, 8, 8);
    const ops = [...bodyOf(b)];
    for (const p of ring(b, 4)) {
      const x = p % 32;
      const y = (p - x) / 32;
      // One row of the right flank left in body tone: the band runs everywhere else.
      if (x === 23 && y === 16) continue;
      ops.push([[x, x, y], INK]);
    }
    const opened = measureOutline(contextOf(spriteOf(ops)))[0];
    const sealed = measureOutline(contextOf(heavyUniformContour()))[0];

    // `inkCount` is asserted on **both** fixtures so the contrast is a contrast of the gate and not of
    // the denominator: both draw a 4px band on a 16x16 block, so `edgePixels` is 60 in both.
    expect(opened.edgePixels).toBe(sealed.edgePixels);
    expect(sealed.inkCount).toBe(60);
    expect(opened.inkCount).toBeLessThan(sealed.inkCount);
    expect(opened.outlineShare).toBeLessThan(sealed.outlineShare);
  });

  it('the gate is per-component, so a sprite carrying both is judged on each part', () => {
    // A global `encloses` over the union of all body-dark pixels throws the enclosing part away with
    // the non-enclosing one, and §4.5 has a real case where that matters: `artwork/moonlit-alpine-lake.pixel`
    // carries a dark region that wraps a mountain and a dark region that is a lake shore. Asserted
    // here on the construction rather than on the artwork, because a test that can only fail on a
    // committed asset is a test that will silently stop failing when that asset is redrawn.
    //
    // The witness: the disc contoured 4px **and** carrying a detached dark region in its interior. The
    // interior region is boundary-connected to nothing and so contributes no ink under either
    // predicate, which is the existing clause — but it *is* body-dark, and a global enclosure test
    // would be computed over the union including it.
    const b = discSolid();
    const ops = [...bodyOf(b), ...inkOf(ring(b, 4), INK)];
    // A dark blob in the middle of the body, 3 steps from the boundary, not touching the contour.
    ops.push([[15, 16, 15], INK]);
    const both = measureOutline(contextOf(spriteOf(ops)))[0];
    // The blob does not reach the boundary, so the boundary connection still discards it and the
    // contour is still read whole.
    expect(both.inkCount).toBe(60);
    expect(both.outlineShare).toBe(1000);
  });

  it('a contour that does not close does not enclose, which is finding 3 arriving through a second door', () => {
    // §4.5's brief for this task warned that a naive neighbour-count topology is already refuted —
    // it cannot tell a closed contour from a nicked one. `encloses` is not a neighbour count, and the
    // difference is that it asks about **reachability of the exterior**, which a nick genuinely breaks:
    // take three rows out of the right flank and the outside can walk in through the hole.
    //
    // This is not used to count gaps — `inkGaps` still does that, and its readings are unchanged — but
    // it is the reason the gate is safe to apply to a subject whose contour is drawn selectively. §4.5
    // states that selective outlining is recommended craft and must not be punished; a gate that
    // rejects a selectively-outlined subject outright would be punishing it, so the near side has to be
    // asserted: a *closed* staircase contour is admitted, and the nick test above shows what happens
    // when it is not closed.
    const closed = measureOutline(contextOf(discContour()))[0];
    expect(closed.inkCount).toBe(60);
    expect(closed.outlineShare).toBe(1000);

    const nicked = measureOutline(contextOf(nickedDiscContour(3)))[0];
    // A 3px nick out of a 1px contour: `inkGaps` reads 2 events, under its gate, so no issue — and the
    // dimension does not fall over. The nick breaks enclosure, so the body reference is not consulted,
    // and the local reference carries the reading on its own as before.
    expect(nicked.inkCount).toBe(57);
    expect(nicked.inkGaps).toBe(2);
    expect(codes(nicked.issues)).not.toContain('outline-gap');
    expect(nicked.scoreQ).toBe(950);
  });
});

/* ------------------------------------------------------------------ *
 * `inkDepth`: the same-colour radial run
 * ------------------------------------------------------------------ */

describe('outline inkDepth', () => {
  it('MUST FIRE: a 2px contour reads depth 1 at every quadrant and depth 0 at its four corners', () => {
    // The point of this test is that the depth measure **moves**. §4.5's first implementation read
    // `dist` over the whole mask, which on a lit sprite reports the darkest thing inside the
    // silhouette rather than the contour; the run measure reads a 1px contour as 0, a 2px contour as
    // 1, and it does so from the boundary inward rather than from wherever the sprite is darkest.
    //
    // **`minInkDepth` is 0 on a uniformly 2px contour and `maxInkDepth` is 1. The original version of
    // this test asserted `minInkDepth === 1`, which is a wish rather than a reading.** The cause is
    // structural: the run recurrence is 4-connected (`run(p)` reads a 4-adjacent `q` at
    // `dist(q) = dist(p) + 1`), and on a rectilinear block the four corners have *no* 4-adjacent
    // neighbour one `dist` step inward — the step inward from `(8,8)` is the diagonal `(9,9)`. So a
    // corner always reads one pixel shallower than the contour around it. Exactly four contour
    // pixels are affected, and `quadrantDepth` — a per-quadrant **max** — reads 1 in all four
    // quadrants, which is what localises the 0 to the corners rather than to the contour.
    const one = measureOutline(contextOf(rectContour(16, 1)))[0];
    const two = measureOutline(contextOf(rectContour(16, 2)))[0];
    expect(one.maxInkDepth).toBe(0);
    expect(one.minInkDepth).toBe(0);
    expect(two.maxInkDepth).toBe(1);
    expect(two.minInkDepth).toBe(0);
    // The 0 is localised: every quadrant holds a depth-1 contour pixel even though the minimum is 0,
    // so the quadrant spread is 0 and the row that reads it does not fire.
    expect(two.quadrantDepth).toEqual([1, 1, 1, 1]);
    expect(Math.max(...two.quadrantDepth) - Math.min(...two.quadrantDepth)).toBe(0);
    expect(two.scoreQ).toBe(950);
    expect(codes(two.issues)).not.toContain('outline-heavy');
  });

  it('MUST FIRE: a 4px uniform contour now reads as the 4px contour it is, not as no outline', () => {
    // **§4.5's finding 1, repaired.** This assertion used to read `outlineShare 0`,
    // `maxInkDepth -1` and `codes(issues) == ['outline-missing']`, and it was in the file as a
    // NEAR MISS — a test that documented a defect instead of a gate, which is the shape this
    // repository has shipped five times. The defect is gone and the reading is now what the drawing
    // plainly is.
    //
    // The cause of the old reading was the *reference window*, not the band and not the connection:
    // a 3px ring's boundary pixel is its own 5x5 neighbourhood's mean, so it was not `dark` at all.
    // The repair is a second reference measured against the **body** beneath the contour, admitted
    // only where the dark set **encloses** — see `outline ink: a thick contour and a one-sided
    // shadow are the same pixels`. Both clauses are load-bearing and both are asserted here.
    const heavy = measureOutline(contextOf(heavyUniformContour()))[0];
    expect(heavy.outlineShare).toBe(1000);
    expect(heavy.inkCount).toBe(60);
    expect(heavy.edgePixels).toBe(60);
    expect(heavy.maxInkDepth).toBe(3);
    // **`minInkDepth` is 0 and not 3**, and that is finding 5 rather than a new defect: the run
    // recurrence is 4-connected and a rectilinear contour's four corners step inward *diagonally*, so
    // the minimum over a block-shaped contour is a reading of its corners. The staircase twin in the
    // next test is what reaches the depth row. Both readings are asserted so the disagreement
    // between them cannot be discovered later as a surprise.
    expect(heavy.minInkDepth).toBe(0);
    // It is reported heavy, on **coverage**: 124 of the block's 256 pixels are contour, which is
    // 750 per mille against §4.5's 450 limit. A 4px contour covering three quarters of a 16x16
    // sprite is not holding the edge, it is replacing the sprite, and 0.70 is the severity that says so.
    expect(heavy.outlineCoverage).toBe(750);
    expect(codes(heavy.issues)).toContain('outline-heavy');
    expect(heavy.issues.find((i) => i.code === 'outline-heavy')?.severity).toBe(0.7);
    expect(heavy.scoreQ).toBe(750);
  });

  it('NEAR MISS on the same gate: a 2px uniform contour reads as a contour and is not heavy', () => {
    // One ring fewer, on the same block, through the same clause. `outlineShare` is identical at
    // 1000 — the contour is fully inked either way, which is the whole of finding 1's repair — and the
    // only thing that moves is coverage, from 438 to 609 against the 450 limit.
    //
    // **This is what makes the repair a gate and not a constant.** One ring is the difference between
    // a dimension that says "you have a 4px contour" and one that says "you have a 2px contour", and
    // only the first is charged.
    const two = measureOutline(contextOf(rectContour(16, 2)))[0];
    expect(two.outlineShare).toBe(1000);
    expect(two.maxInkDepth).toBe(1);
    expect(two.outlineCoverage).toBe(438);
    expect(two.outlineCoverage).toBeLessThan(450);
    expect(codes(two.issues)).not.toContain('outline-heavy');
    expect(two.scoreQ).toBe(950);

    // And the far side again: a 1px contour, which no repair to `dark` was ever needed for.
    const one = measureOutline(contextOf(rectContour(16, 1)))[0];
    expect(one.outlineShare).toBe(1000);
    expect(one.outlineCoverage).toBe(234);
    expect(codes(one.issues)).toEqual([]);
  });

  it('MUST FIRE: the heavy depth row is reachable — a 4px staircase contour fires it at 0.50', () => {
    // **§4.5's finding 7, repaired: the `minInkDepth >= 3` row was dead code and now is not.**
    // Measured over all 79 corpus cases under the shipped predicate, `outline-heavy` fired on **0**
    // frames, and all 23 frames reaching `minInkDepth >= 3` also read `outlineShare < 150` so the band
    // table never ran. §4.5 recorded that as an arithmetic consequence and declined to move a
    // threshold to reach it.
    //
    // The row is reached by **drawing the case §4.5 said could not be drawn**: a uniformly heavy but
    // consistent contour. It is built on the **disc** rather than on a block, and the reason is
    // finding 5 rather than convenience — a rectilinear contour's four corners have no 4-adjacent
    // neighbour one `dist` step inward, so a block reads `minInkDepth 0` however thick its contour
    // is, and the *next* test asserts exactly that. A 45-degree staircase has no corners, so every
    // contour pixel on it reads its true depth.
    const heavy = measureOutline(contextOf(heavyUniformDiscContour(4)))[0];
    expect(heavy.outlineShare).toBe(1000);
    expect(heavy.minInkDepth).toBe(3);
    expect(heavy.maxInkDepth).toBe(3);
    expect(heavy.quadrantDepth).toEqual([3, 3, 3, 3]);
    const depth = heavy.issues.find((i) => i.code === 'outline-heavy' && i.severity === 0.5);
    expect(depth).toBeDefined();
    // Both heavy rows fire here, and they are two *different* faults reported by two different rows:
    // the depth row (0.50) reads weight in pixels and the coverage row (0.70) reads weight as a
    // proportion. 950 - 150 - 200.
    expect(heavy.issues.filter((i) => i.code === 'outline-heavy')).toHaveLength(2);
    expect(heavy.scoreQ).toBe(600);
  });

  it('NEAR MISS on the depth row: 3px and 2px staircase contours read one ring shallower and do not fire it', () => {
    // The other side of the same gate, one ring at a time. §4.5's bound is `minInkDepth >= 3`, so a
    // 3px contour reads `minInkDepth 2` and must not fire it — a MUST FIRE on its own would not show
    // that the row is a threshold rather than "thickness above one is bad".
    //
    // The staircase is what makes this exact: on the block, **every** ring count reads
    // `minInkDepth 0` at the corners, so the block could not witness either side of this gate at
    // all. That is asserted below, and it is why the row's only construction is drawn on a disc.
    for (const [rings, min] of [
      [1, 0],
      [2, 1],
      [3, 2],
      [4, 3],
    ] as const) {
      const frame = measureOutline(contextOf(heavyUniformDiscContour(rings)))[0];
      expect(frame.minInkDepth, `${rings} rings`).toBe(min);
      expect(frame.maxInkDepth, `${rings} rings`).toBe(min);
      // Share is 1000 at every ring count: the contour is fully inked however thick it is, which is
      // the part of finding 1 that the body reference and the enclosure clause between them repair.
      expect(frame.outlineShare, `${rings} rings`).toBe(1000);
      const fires = frame.issues.some((i) => i.code === 'outline-heavy' && i.severity === 0.5);
      expect(fires, `${rings} rings fires the depth row`).toBe(rings >= 4);
    }

    // And the block-shaped reading that made this row unreachable before: the four corners hold the
    // minimum at 0 on a *uniformly* 4px contour. Finding 5, asserted so it cannot be mistaken for a
    // property of the repair rather than of the 4-connected run recurrence.
    const block = measureOutline(contextOf(heavyUniformContour()))[0];
    expect(block.maxInkDepth).toBe(3);
    expect(block.minInkDepth).toBe(0);
    expect(block.quadrantDepth).toEqual([3, 3, 3, 3]);
    expect(block.issues.some((i) => i.code === 'outline-heavy' && i.severity === 0.5)).toBe(false);
  });

  it('a contour this predicate draws cleanly never reaches the heavy bound', () => {
    // The bound itself, asserted on readings rather than on a hope. The first group is every fixture
    // in this file that is a *clean drawing* — a uniform 1px or 2px contour, the staircase, the
    // nicked one, the unoutlined disc, the isolated pixel at any depth. None exceeds depth 1.
    const clean = [
      rectContour(10), rectContour(12), rectContour(16),
      rectContour(16, 2), discContour(), nickedDiscContour(), bareDisc(),
      isolatedInkPixel(0), isolatedInkPixel(2), isolatedInkPixel(3),
    ].map((sprite) => measureOutline(contextOf(sprite))[0]);
    for (const frame of clean) expect(frame.maxInkDepth).toBeLessThanOrEqual(1);

    // **`twoWeightContour`'s two readings, both asserted, and they are not the same any more.**
    //
    // The original version of this block asserted `not.toContain('outline-heavy')` for both fixtures.
    // That was true under the shipped predicate and it is **false for `(3, 1)` now**, because the
    // seam row the fixture's own comment describes — "painted ink right across the full width" — is a
    // genuine four-pixel dark band, and the repaired predicate correctly counts it as ink. Measured:
    //
    // ```
    //   twoWeightContour(2, 1)  share 1000 cov 391 min 0 max 4 qd [4,4,4,4] scoreQ 950  (no issue)
    //   twoWeightContour(3, 1)  share 1000 cov 469 min 0 max 4 qd [4,4,4,4] scoreQ 750  outline-heavy@0.70
    // ```
    //
    // The 0.70 is the **coverage** row, not the depth row. 196 of the block's 416 pixels are ink,
    // 469 per mille against §4.5's 450 limit, and a contour covering that much of the sprite is not
    // holding the edge. Under the shipped predicate this fixture read `share 1000, cov 297` and
    // nothing fired, because the seam was only partly detected — so this is a row that has become
    // *more* able to see a defect the old predicate missed, and it is recorded as such rather than
    // argued away. `flankWeightedContour` is the construction that witnesses the *depth* row's
    // disagreement case without a seam in the picture.
    const twoWeight = (deep: number, shallow: number) =>
      measureOutline(contextOf(twoWeightContour(deep, shallow)))[0];

    const twoOne = twoWeight(2, 1);
    expect(twoOne.maxInkDepth).toBe(4);
    expect(twoOne.minInkDepth).toBe(0);
    expect(twoOne.outlineCoverage).toBe(391);
    expect(codes(twoOne.issues)).not.toContain('outline-heavy');

    const threeOne = twoWeight(3, 1);
    expect(threeOne.maxInkDepth).toBe(4);
    expect(threeOne.minInkDepth).toBe(0);
    expect(threeOne.outlineCoverage).toBe(469);
    // Depth 0.50 specifically: the row reads `minInkDepth`, and the corners and the seam hold it at
    // 0, so a four-pixel-deep band reports as what it is rather than as a heavy contour.
    expect(threeOne.issues.some((i) => i.code === 'outline-heavy' && i.severity === 0.7)).toBe(true);
    expect(threeOne.issues.some((i) => i.code === 'outline-heavy' && i.severity === 0.5)).toBe(false);
    expect(threeOne.scoreQ).toBe(750);

    // And the sweep, re-pinned. **The first version of this assertion was `toBe(0)` over every
    // fixture, which was §4.5's finding 7 written as a test: it asserted that the heavy depth row
    // could not fire, so it would have gone green on the defect and gone red on the repair.** It is
    // now scoped to the fixtures that genuinely should not reach the bound — a 1px or 2px contour
    // anywhere, on any shape — and the heavy fixtures are asserted on their own readings above.
    const lightContours = [
      rectContour(10), rectContour(12), rectContour(16),
      rectContour(16, 2), discContour(), nickedDiscContour(), bareDisc(),
      isolatedInkPixel(0), isolatedInkPixel(2), isolatedInkPixel(3),
      oneSidedShadowBlock(), flankWeightedContour(2),
    ].map((sprite) => measureOutline(contextOf(sprite))[0]);
    for (const frame of lightContours) {
      expect(codes(frame.issues)).not.toContain('outline-heavy');
    }

    // **The one-sided shadow is in that list on purpose and it is why the depth bound is not asserted
    // over the whole list.** Its deepest ink genuinely *is* four pixels — §4.5's inseparable pair —
    // the band and the run measure both admit it, and only the enclosure clause declines to call it a
    // contour. Asserting `maxInkDepth <= 2` across the list would have been asserting that the
    // picture does not contain what it contains. So the bound is asserted where it belongs, on the
    // fixtures that are actually meant to be light, and the shadow is asserted separately as the one
    // deep reading that is correctly *not* charged.
    for (const sprite of [
      rectContour(10), rectContour(12), rectContour(16), rectContour(16, 2),
      discContour(), nickedDiscContour(), bareDisc(), flankWeightedContour(2),
    ]) {
      expect(measureOutline(contextOf(sprite))[0].maxInkDepth).toBeLessThanOrEqual(2);
    }
    expect(measureOutline(contextOf(oneSidedShadowBlock()))[0].maxInkDepth).toBe(4);
  });

  it('ink is measured on every solid pixel of the band, not only the edge pixels', () => {
    // `inkCount` is "ink pixels *among the edge pixels*", which is a restriction of the **count**.
    // Read as a restriction of the *predicate*, every ink pixel would be an `edgePixel` and the
    // depth reading would be 0 by construction — the defect `ditherMask` shipped with, in a
    // different quantity. The 2px contour is the witness: 112 ink pixels of which 60 are boundary.
    const frame = measureOutline(contextOf(rectContour(16, 2)))[0];
    expect(frame.inkTotal).toBe(112);
    expect(frame.inkCount).toBe(60);
    expect(frame.inkTotal).toBeGreaterThan(frame.inkCount);
  });
});

/* ------------------------------------------------------------------ *
 * `quadrantDepth`
 * ------------------------------------------------------------------ */

describe('outline quadrantDepth', () => {
  it('MUST FIRE: a contour 3 rings deep on one flank and 1 elsewhere reads a spread and reports inconsistency', () => {
    // §4.5's `quadrantDepth` spread `>= 2` row, on a construction with no seam in it. See
    // `flankWeightedContour` for why `twoWeightContour` no longer witnesses this row: its seam row
    // is a genuine four-pixel dark band, the repaired predicate correctly detects it, and a band that
    // crosses the whole subject puts the same depth in all four quadrants.
    const frame = measureOutline(contextOf(flankWeightedContour(3)))[0];
    const present = frame.quadrantDepth.filter((d) => d >= 0);
    const spread = Math.max(...present) - Math.min(...present);
    expect(frame.quadrantDepth).toEqual([0, 2, 0, 2]);
    expect(spread).toBe(2);
    expect(codes(frame.issues)).toContain('outline-inconsistent-weight');
    expect(frame.issues.find((i) => i.code === 'outline-inconsistent-weight')?.severity).toBe(0.45);
    expect(frame.scoreQ).toBe(800);
  });

  it('the reading follows the flank and not the drawing\'s handedness', () => {
    // The mirror of the MUST FIRE, and the assertion that the spread is measuring *where* the weight
    // is rather than merely *how much* of it there is. Two drawings that differ only in which flank
    // carries the deep rings, and two readings that differ only in which quadrants are deep.
    const right = measureOutline(contextOf(flankWeightedContour(3, 'right')))[0];
    const left = measureOutline(contextOf(flankWeightedContour(3, 'left')))[0];
    expect(right.quadrantDepth).toEqual([0, 2, 0, 2]);
    expect(left.quadrantDepth).toEqual([2, 0, 2, 0]);
    expect(right.scoreQ).toBe(left.scoreQ);
    expect(codes(left.issues)).toContain('outline-inconsistent-weight');
  });

  it('NEAR MISS: a 1px contour everywhere reads a spread of 0', () => {
    const frame = measureOutline(contextOf(rectContour(16)))[0];
    expect(new Set(frame.quadrantDepth)).toEqual(new Set([0]));
    expect(codes(frame.issues)).not.toContain('outline-inconsistent-weight');
  });

  it('NEAR MISS: a uniformly deep contour is heavy-but-not-inconsistent in the RECORD, and that is not a finding', () => {
    // §4.5's prose separates the two faults — "an inconsistent outline is worse than none" — and
    // this is the pair that says the difference is weight *across* the sprite rather than weight in
    // absolute terms. The construction is 2 rings all the way round: every quadrant reads 1, the
    // spread is 0, and no inconsistency is reported. Its `maxInkDepth` is 1, which is not the heavy
    // bound, so no row fires and the dimension reports 950.
    //
    // **`minInkDepth` is 0 here, not 1, and the two readings are asserted together rather than one
    // of them being dropped.** `quadrantDepth` is a per-quadrant **max** and `minInkDepth` is a
    // per-pixel **min** over the contour; on a rectilinear subject they disagree at exactly the four
    // corners, where the inward step is diagonal and the 4-connected run recurrence cannot follow
    // it. See the `inkDepth` block for the full argument and for the pixel-level evidence.
    const frame = measureOutline(contextOf(rectContour(16, 2)))[0];
    expect(frame.quadrantDepth.every((d) => d === 1)).toBe(true);
    expect(frame.maxInkDepth).toBe(1);
    expect(frame.minInkDepth).toBe(0);
    expect(Math.max(...frame.quadrantDepth) - Math.min(...frame.quadrantDepth)).toBe(0);
    expect(codes(frame.issues)).not.toContain('outline-inconsistent-weight');
    expect(frame.scoreQ).toBe(950);
  });

  it('a quadrant with no ink at all is -1 and is excluded from the spread', () => {
    // Reading an empty quadrant as `0` would make "1px here" and "nothing here" the same number,
    // which is the distinction §4.5's prose is about. The control is an L-shaped contour on a 16x16
    // block: its bounding box is the whole block, three quadrants carry contour and the bottom-right
    // carries none, so exactly one `-1` must appear and the spread must be computed over the other
    // three. All three read 0, so the spread is 0 and no inconsistency is reported — the whole
    // point, since a spread read as `0 - 0 = 0` over four numbers would be indistinguishable from
    // reading the empty quadrant as `0` and would happen to agree here for the wrong reason.
    const frame = measureOutline(contextOf(lShapedContour()))[0];
    expect(frame.edgePixels).toBe(60);
    expect(frame.inkCount).toBe(31);
    expect(frame.quadrantDepth).toEqual([0, 0, 0, -1]);
    expect(frame.quadrantDepth.filter((d) => d < 0)).toHaveLength(1);
    const present = frame.quadrantDepth.filter((d) => d >= 0);
    expect(present).toHaveLength(3);
    expect(Math.max(...present) - Math.min(...present)).toBeLessThan(2);
    expect(codes(frame.issues)).not.toContain('outline-inconsistent-weight');
  });

  it('the half-contoured disc it replaced reads a 4px seam band in the lower quadrants, not an absent quadrant', () => {
    // **The measurement behind the fixture change above, pinned so it cannot be "fixed" back.** A
    // half-disc contoured on its top half reads `[0, 0, 4, 4]`: eroding the top half treats its
    // seam row as a boundary, so that row is painted ink across the subject's full width, and the
    // disc's widest row is therefore a four-pixel-deep dark band reaching both silhouette edges.
    // The reading is real — that is what the drawing contains — and it reports as one
    // `outline-inconsistent-weight` rather than as a heavy contour, because the row that fires reads
    // `minInkDepth` and the corners hold the minimum at 0. §4.5 carries the numbers.
    const frame = measureOutline(contextOf(topHalfDisc()))[0];
    expect(frame.quadrantDepth).toEqual([0, 0, 4, 4]);
    expect(frame.maxInkDepth).toBe(4);
    expect(frame.minInkDepth).toBe(0);
    expect(codes(frame.issues)).toContain('outline-inconsistent-weight');
    expect(codes(frame.issues)).not.toContain('outline-heavy');
  });
});

/* ------------------------------------------------------------------ *
 * `inkColours`
 * ------------------------------------------------------------------ */

describe('outline inkColours', () => {
  it('MUST FIRE: four ink colours with a dominant fourth read outline-colour-split', () => {
    const frame = measureOutline(contextOf(splitColourContour()))[0];
    expect(frame.inkColours).toBe(4);
    expect(codes(frame.issues)).toContain('outline-colour-split');
    expect(frame.issues.find((i) => i.code === 'outline-colour-split')?.severity).toBe(0.25);
    expect(frame.scoreQ).toBe(950 - 50);
  });

  it('NEAR MISS on the share clause: four ink colours with a negligible fourth do not fire', () => {
    // §4.5's condition is "`>= 4` ink colours **and the 4th colour holds `>= 5%` of ink**", so the
    // count alone is not the test. Two pixels of a fourth colour is a speck on the contour, and
    // treating it as a contour that changes colour is the false positive this clause exists to
    // prevent.
    const frame = measureOutline(contextOf(speckColourContour()))[0];
    expect(frame.inkColours).toBe(4);
    expect(codes(frame.issues)).not.toContain('outline-colour-split');
  });

  it('NEAR MISS on the count clause: two ink colours do not fire', () => {
    const b = block(16, 8, 8);
    const ops = [...bodyOf(b)];
    for (const p of ring(b, 1)) {
      const x = p % 32;
      const y = (p - x) / 32;
      ops.push([[x, x, y], x < 12 ? INK : ALT_A]);
    }
    const frame = measureOutline(contextOf(spriteOf(ops)))[0];
    expect(frame.inkColours).toBe(2);
    expect(codes(frame.issues)).not.toContain('outline-colour-split');
  });

  it('counts the contour, not the shading behind it', () => {
    // §4.5's question is "is it the same colour **all the way round**", and a 2px contour's inner
    // ring is the boundary of the body rather than part of the contour's own edge. A 3px contour with
    // a different tone immediately inside it is one contour that shades, not three contours.
    const b = block(16, 8, 8);
    const ops = [...bodyOf(b), ...inkOf(ring(b, 1), INK)];
    for (const p of ring(erode(b, 1), 1)) {
      const x = p % 32;
      const y = (p - x) / 32;
      ops.push([[x, x, y], ALT_A]);
    }
    const frame = measureOutline(contextOf(spriteOf(ops)))[0];
    expect(frame.inkColours).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * `outlineCoverage`
 * ------------------------------------------------------------------ */

describe('outline outlineCoverage', () => {
  it('MUST FIRE: a 1px contour on a 6x6 body reads coverage 556 and blocks at 0.70', () => {
    // §4.5's `outlineCoverage >= 45/100` row — 450 per-mille — and the only **blocking** severity
    // this dimension has. A contour covering 556 of every 1000 pixels of its subject is not holding
    // the edge, it is replacing the sprite.
    const frame = measureOutline(contextOf(rectContour(6)))[0];
    expect(frame.outlineCoverage).toBeGreaterThanOrEqual(450);
    const heavy = frame.issues.find((i) => i.code === 'outline-heavy') as QualityIssue;
    expect(heavy.severity).toBe(0.7);
    expect(frame.scoreQ).toBe(950 - 200);
  });

  it('NEAR MISS: a 1px contour on a 16x16 body reads coverage 234 and does not block', () => {
    const frame = measureOutline(contextOf(rectContour(16)))[0];
    expect(frame.outlineCoverage).toBe(234);
    expect(frame.issues.filter((i) => i.code === 'outline-heavy')).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * `inkGaps`
 * ------------------------------------------------------------------ */

describe('outline inkGaps', () => {
  it('NEAR MISS: a closed rectilinear contour reads zero gaps', () => {
    const frame = measureOutline(contextOf(rectContour(16)))[0];
    expect(frame.inkGaps).toBe(0);
    expect(codes(frame.issues)).not.toContain('outline-gap');
  });

  it('NEAR MISS: a closed STAIRCASE contour also reads zero gaps, which is the whole point', () => {
    // **This is §4.5's finding 3, repaired.** The old predicate asked whether each ink pixel had an
    // ink 4-neighbour, which counts the 45-degree run of a staircase contour as 22 gaps of 60 — the
    // gate then fired on *every* correctly drawn 1px staircase contour in this repository's style,
    // and on the damaged one with exactly the same number. A measure that cannot tell a closed
    // contour from a nicked one is not measuring the thing its code names.
    //
    // The new predicate asks where the contour *stops*: a boundary pixel with no ink, standing next
    // to ink that is. On a closed contour of any shape that set is empty, so the near-miss is
    // **exact** rather than approximate. Its price — that the count is of *events* rather than of
    // missing length — is asserted on the other side of the gate in the MUST FIRE below.
    const frame = measureOutline(contextOf(discContour()))[0];
    expect(frame.edgePixels).toBe(60);
    expect(frame.inkCount).toBe(60);
    expect(frame.inkGaps).toBe(0);
    expect(codes(frame.issues)).not.toContain('outline-gap');
  });

  it('MUST FIRE: two separate nicks read 4 gaps of 60, the gate trips, and the near side of it is one nick of any size', () => {
    const closed = measureOutline(contextOf(discContour()))[0];
    const nicked = measureOutline(contextOf(nickedDiscContour()))[0];
    const twice = measureOutline(contextOf(twiceNickedDiscContour()))[0];

    // The gate, on the side that fires: two three-pixel nicks are two discontinuities.
    expect(twice.edgePixels).toBe(closed.edgePixels);
    expect(closed.inkGaps).toBe(0);
    expect(twice.inkGaps).toBe(4);
    expect(rhu(twice.inkGaps * 1000, twice.edgePixels)).toBe(67);
    expect(codes(twice.issues)).toContain('outline-gap');
    expect(twice.issues.find((i) => i.code === 'outline-gap')?.severity).toBe(0.25);

    // **The gate, on the side that does not: ONE nick reads 2 events whatever its length.** The
    // original version of this test asserted that a single three-row nick reaches the 50 gate and
    // fires `outline-gap`; measured, it reads `inkGaps 2` over 60 boundary pixels — 33 per mille —
    // and does not fire. Measured over nick lengths of 3, 4, 5, 6 and 9 rows: **2 events every
    // time.** A nine-row nick is a third of the flank and the gate cannot see it.
    //
    // This is the honest shape of the repair rather than a defect in it. The old predicate counted
    // boundary pixels *next to* ink under 4-connectivity, which read 22 of 60 on a perfect staircase
    // contour and the same 22 of 60 on a damaged one — no discrimination at all. The new predicate
    // counts *events*, so a closed contour of any shape reads exactly 0, which is exact rather than
    // approximate, and the price is that the count is a function of how many times the contour stops
    // rather than how much of it is missing. Both ends of the gate are asserted here so neither can
    // drift silently.
    expect(nicked.edgePixels).toBe(closed.edgePixels);
    expect(nicked.inkCount).toBe(57);
    expect(nicked.inkGaps).toBe(2);
    expect(rhu(nicked.inkGaps * 1000, nicked.edgePixels)).toBe(33);
    expect(codes(nicked.issues)).not.toContain('outline-gap');

    // And the sweep the comment claims, so the claim is a measurement rather than a recollection.
    for (const rows of [3, 4, 5, 6, 9]) {
      const frame = measureOutline(contextOf(nickedDiscContour(rows)))[0];
      expect(frame.inkGaps).toBe(2);
      expect(rhu(frame.inkGaps * 1000, frame.edgePixels)).toBe(33);
      expect(codes(frame.issues)).not.toContain('outline-gap');
    }
  });

  it('the severity is advisory, never blocking', () => {
    // §4.5 is explicit that a gap must not punish the recommended technique: selective outlining
    // is good craft, and the craft guide recommends dropping the contour where the light hits. A
    // blocking severity here would fail a document for doing the right thing, which §3.5 names as
    // the failure worse than a miss.
    //
    // **Run on the two-nick fixture, not the one-nick one.** A single nick reads 33 per mille, below
    // the gate, so it produces no issue at all and `for (const issue of [])` would pass vacuously —
    // an assertion that cannot fail, which is the defect this repository has shipped five times.
    // `twiceNickedDiscContour` reads 67 per mille and does produce the `outline-gap` being checked.
    const frame = measureOutline(contextOf(twiceNickedDiscContour()))[0];
    expect(codes(frame.issues)).toContain('outline-gap');
    for (const issue of frame.issues) expect(issue.severity).toBeLessThan(0.5);
  });

  it('outlineCoverage is bounded by outlineShare, which is what makes the sparse-outline row narrow', () => {
    // **Measured, and the first version of this claim was wrong.** It asserted that §4.5's sixth Δ
    // — `outlineShare >= 60/100` **and** `outlineCoverage < 3/100` — was *arithmetically
    // unreachable*, on the reasoning that `edgePixels <= N` implies `outlineCoverage >= outlineShare`.
    // The inequality runs the other way: dividing the same numerator `inkCount` by the **larger**
    // denominator `N` gives the **smaller** ratio, so `outlineShare >= outlineCoverage` always, and
    // the conjunction is perfectly satisfiable. The test caught it, which is the reason it is here.
    //
    // What the relation does say is how *narrow* the row is. `share >= 600` with `coverage < 30`
    // requires `N > 20 * edgePixels`: a subject whose solid area is more than twenty times its
    // boundary. §3.3's own `dist` argument gives the same number from the other side — a disc of
    // radius `r` has `N / edgePixels` about `r / 2`, so the row needs `r > 40` — which makes it a
    // finding about large round subjects at 256px and above, and unreachable on anything the size of
    // a character sprite. §4.5 does not say that, and an agent reading `outline-gap` at 0.35 has no
    // way to know the severity it carries depends on the subject being 80px across.
    for (const size of [10, 12, 16]) {
      const frame = measureOutline(contextOf(rectContour(size)))[0];
      expect(frame.edgePixels).toBeLessThanOrEqual(frame.N);
      expect(frame.outlineShare).toBeGreaterThanOrEqual(frame.outlineCoverage);
      expect(frame.N / frame.edgePixels).toBeLessThan(20);
      // The row's conjunction, evaluated on a reading that satisfies its first half.
      expect(frame.outlineShare >= 600 && frame.outlineCoverage < 30).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * The analyzer
 * ------------------------------------------------------------------ */

describe('outline analyzer', () => {
  it('an unoutlined subject is DECLINED, not scored: no number, no code, no verdict claim', () => {
    // **This test used to assert the opposite, and asserting it was the defect.** §4.5 shipped 700
    // and `outline-missing` here: a defect code on a subject that had made no claim, and a
    // "neutral" mark that is a *passing* mark handed out for having said nothing. §3.5 defines an
    // issue as one thing that is wrong with the artwork, and this artwork is not wrong.
    //
    // All three of its assertions are negative, and that is the whole point: an abstention is
    // defined by what it does **not** produce. `excluded.outline` says why, `dimensions.outline` is
    // absent rather than 0 (a 0 would be silently averaged in by every caller that trusted the
    // field), and no issue carries the code.
    const context = contextOf(bareDisc());
    expect(outlineApplicability(context)).toBe('no-outline');

    const report = evaluate(context, DIMENSIONS_WITH_OUTLINE);
    expect(report.excluded.outline).toBe('no-outline');
    expect(report.dimensions.outline).toBeUndefined();
    expect(report.dimensions.outline?.scoreQ ?? null).toBeNull();
    expect([...report.blocking.map((i) => i.code)]).not.toContain('outline-missing');
    expect(reportInvariantViolations(report)).toEqual([]);

    // And the weight is gone from the denominator rather than counted at its best: a report with
    // `outline` forced in at the neutral 700 scores strictly LOWER than the abstention, which is
    // the whole argument for the exclusion in one comparison.
    const withOutline = weightedTotalQ({
      ...report.dimensions,
      outline: { scoreQ: 700, verdict: 'neutral', issues: [], unmeasured: {} },
    });
    expect(withOutline).toBeLessThan(report.score * 1000);
  });

  it('registers with requiresReadableSubject, so a full-bleed subject is never outlined', () => {
    // §3.3's `no-subject` exists for `silhouette` and `outline`, and this is its second consumer.
    // A full-bleed document's `edgePixels` is the canvas rectangle, so scoring a frame as a
    // contour is the defect T-013 found in §4.2's curvature gate for the same reason.
    //
    // **Two preconditions and their order, both asserted here.** `requiresReadableSubject` fires
    // first on a full-bleed document, so the reason a scene is not outlined is "there is no shape
    // to read a contour around" and *not* "it chose not to". The second is what
    // `outlineApplicability` decides, and the two are different claims about the artwork — one about
    // a readable subject's absence, one about a readable subject's style — so a report that
    // conflated them would be grading a scene's framing as a stylistic decision.
    const ops: Op[] = [];
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) ops.push([[x, x, y], INK]);
    const report = evaluate(contextOf(spriteOf(ops)), DIMENSIONS_WITH_OUTLINE);
    expect(report.excluded.outline).toBe('no-subject');
    expect(report.dimensions.outline).toBeUndefined();

    // And each predicate on its own, so a reader can see the two claims are separable: the
    // full-bleed ink does declare no contour (share 0, below the 150 gate) *and* has no subject, and
    // only the subject reason is reachable, because it is checked first.
    const context = contextOf(spriteOf(ops));
    expect(requiresReadableSubject(context)).toBe('no-subject');
    expect(outlineApplicability(context)).toBe('no-outline');
    expect(DIMENSIONS_WITH_OUTLINE[4].applies(context)).toBe('no-subject');

    // **And the shipped registration agrees with the local one on every input, not just this one.**
    // `DIMENSIONS_WITH_OUTLINE` is built around `DEFAULT_DIMENSIONS` rather than around a private
    // copy of §4.5's entry, so the only way that can drift is if `index.ts` registers the dimension
    // with a different analyzer or a different precondition chain. This is the assertion that
    // catches it, and it is asserted on four subjects rather than the full-bleed one alone, because
    // a precondition that collapsed to just one of the two reasons would still read `no-subject`
    // here.
    const shipped = DEFAULT_DIMENSIONS.find((dimension) => dimension.id === 'outline');
    expect(shipped).toBeDefined();
    expect(shipped!.analyze).toBe(outlineAnalyzer);
    for (const sprite of [bareDisc(), discContour(), rectContour(16), spriteOf(ops)]) {
      const c = contextOf(sprite);
      expect(shipped!.applies!(c)).toBe(DIMENSIONS_WITH_OUTLINE[4].applies(c));
    }
  });

  it('worst frame wins across an animation', () => {
    // §4.5's defect is per-frame, so one broken contour in a walk cycle is a broken contour, and
    // averaging would hide it behind seven good frames.
    const b = block(16, 8, 8);
    const good = [...bodyOf(b), ...inkOf(ring(b, 1), INK)];
    const sprite = spriteOf(bodyOf(b), 2);
    // Frame 0 unoutlined, frame 1 correctly outlined: the worst frame is the first.
    const contoured = spriteOf(good);
    const cel = contoured.frames[0].cels.get(contoured.layers[0].id) as PixelBuffer;
    sprite.frames[1].cels.set(sprite.layers[0].id, cel);

    const frames = measureOutline(contextOf(sprite));
    expect(frames).toHaveLength(2);
    // **550, not the neutral 700.** Frame 0 has no contour and frame 1 has a perfect one, so the
    // *document* declares a contour — `outlineApplicability` is unanimity over inked frames, and one
    // frame above the gate is enough — and the dimension measures. The un-contoured frame then reads
    // §4.5's own "otherwise" band, which is the honest number for a walk cycle that drops its outline
    // on one frame. It used to read 700 with `outline-missing`, which graded the *document* for the
    // frame's absence.
    expect(frames[0].outlineShare).toBe(0);
    expect(frames[0].baseQ).toBe(550);
    expect(frames[0].issues).toEqual([]);
    expect(frames[1].scoreQ).toBe(950);
    expect(outlineApplicability(contextOf(sprite))).toBeNull();
    expect(outlineAnalyzer(contextOf(sprite)).scoreQ).toBe(550);
    expect(outlineAnalyzer(contextOf(sprite)).verdict).toContain('worst of 2 frames');
  });

  it('an empty frame scores 1000 and says there is no contour to find', () => {
    const sprite = createSprite({ width: 32, height: 32, name: 'empty', layers: ['Base'] });
    const dimension = outlineAnalyzer(contextOf(sprite));
    expect(dimension.scoreQ).toBe(1000);
    expect(dimension.issues).toEqual([]);
    expect(dimension.verdict).toContain('no contour');
  });
});

/* ------------------------------------------------------------------ *
 * An independent re-implementation of §4.5's `ink` predicate
 * ------------------------------------------------------------------ */

/**
 * §4.5's `dark(p) = localMean(p) - Lq(p) >= 20`, written out again rather than imported.
 *
 * A test that calls the analyzer's own `referenceMean` proves only that the analyzer agrees with
 * itself, so the predicate the whole dimension rests on is transcribed here from §4.5's own words
 * and the two are compared. This is the one place in this repository where a test-local
 * reimplementation is the point rather than the sin `measure.ts`'s header warns about.
 */
function independentlyDark(cel: PixelBuffer, mask: Uint8Array, x: number, y: number): boolean {
  let sum = 0;
  let count = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= 32 || ny >= 32) continue;
      const q = ny * 32 + nx;
      if (mask[q] !== 1) continue;
      sum += lqOf(cel as never, q);
      count++;
    }
  }
  return Math.floor(sum / count) - lqOf(cel as never, y * 32 + x) >= 20;
}

describe('outline predicate agrees with §4.5 transcribed independently', () => {
  it('the analyzer inks exactly the pixels this file\'s own transcription calls dark', () => {
    // Two implementations, one specification. If they disagree, one of them has drifted, and a
    // drift in the *reference tone* would move every number in the dimension at once.
    for (const sprite of [rectContour(16), rectContour(16, 2), discContour(), bareDisc(), splitColourContour()]) {
      const context = contextOf(sprite);
      const cel = context.composite[0];
      const { mask, solid: N } = buildSolidMask(cel, 32, 32);
      const { dist } = distField(mask, 32, 32);
      const frame = measureOutline(context)[0];
      expect(frame.N).toBe(N);

      // Every ink pixel is `dark`, inside the band, and on the boundary or connected to one.
      const inkEdge = new Set<number>();
      for (let p = 0; p < 32 * 32; p++) {
        if (mask[p] !== 1) continue;
        const x = p % 32;
        const y = (p - x) / 32;
        if (!independentlyDark(cel as PixelBuffer, mask, x, y)) continue;
        // A boundary pixel this file's own transcription calls dark is ink, whatever else is true.
        if (edgePixelAt(mask, 32, 32, x, y)) inkEdge.add(p);
        expect(dist[p]).toBeLessThanOrEqual(4);
      }
      // The set the transcription finds on the boundary is exactly the analyzer's `inkCount` on any
      // subject whose dark boundary is connected — which is every fixture here.
      expect(inkEdge.size).toBe(frame.inkCount);
    }
  });
});
