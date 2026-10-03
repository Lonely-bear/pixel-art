import type { Rect } from '../types.js';
import {
  buildSolidMask,
  distField,
  edgePixelAt,
  lqOf,
  rhu,
} from './measure.js';
import type {
  ExcludedReason,
  QualityAnalyzer,
  QualityCel,
  QualityContext,
  QualityDimension,
  QualityIssue,
} from './types.js';

/**
 * The `outline` dimension: is the contour there, is it one pixel thick, is it one colour, and
 * does it hold its weight.
 *
 * ## What this file is NOT allowed to do, and how that is enforced
 *
 * §3.3 opens with the warning this repository has paid for five times: *two dimensions
 * measuring the same thing two different ways is the likeliest way for this pipeline to produce
 * a confident wrong answer*, and "Where a name appears here, no dimension may define its own
 * version of it." So every quantity below is either read out of `measure.ts` or is new to §4.5
 * and named in §4.5's own table:
 *
 * | quantity | home |
 * | --- | --- |
 * | `edgePixels` | `edgePixelAt` in `measure.ts` — §3.3's predicate, `value` already imports it |
 * | `dist`, `Dmax` | `distField` in `measure.ts` — §3.3's own field, shared with `value` and `noise` |
 * | `Lq` | `lqOf` in `measure.ts` — §3.4's integer luminance |
 * | `N` | `buildSolidMask`'s `solid` |
 * | `rhu` | `silhouette.ts`, re-exported by `measure.ts` |
 * | `localMean`, `dark`, `ink`, `inkCount`, `outlineShare`, `outlineCoverage`, `inkRun`, `inkDepth`, `minInkDepth`, `maxInkDepth`, `quadrantDepth`, `inkColours`, `inkGaps` | here, and only here — §4.5's own table names each one and nothing else in the pipeline measures any of them |
 *
 * **There is no second BFS and no second edge predicate.** `docs/ROADMAP.md` asked whether this
 * dimension duplicates `value`, and the answer is that the two share `measure.ts`'s `dist` field
 * by design (§4.5 says so in its own words) and share nothing else: `value`'s curvature gate
 * reads `regionCurvedQ`/`planeCurvedQ` off tone regions, this dimension never computes a
 * curvature at all. See the report for the measurement behind that.
 *
 * ## The band table is read ASCENDING, and why that is stated in the file rather than trusted
 *
 * §4.5's `outlineShare` table is written **descending** (`>= 80/100`, `>= 60/100`, `>= 35/100`,
 * otherwise). Walked in that order with a `for` loop returning the first match, a ratio of 0
 * matches nothing and falls through to `550` — correct by accident — but the moment the last row
 * is given a bound, as §4.4's was given one, the first match on a zero ratio becomes the loosest
 * bound and the table inverts. That is the fifth shipped "measurement that could not fail", and
 * every row of a descending table is individually plausible, which is why it survives review.
 *
 * So {@link OUTLINE_BANDS} here is **ascending bound, and the lookup returns the first row whose
 * bound is met while walking upward**, which cannot return the loosest row for a ratio of zero:
 * 0 meets no row and reaches {@link OUTLINE_FLOOR_Q} by falling off the end, which is the row §4.5
 * specifies for it. `quality-outline.test.ts` asserts the ratio-0 case directly rather than
 * asserting the table's shape.
 */

/**
 * §4.5's `dark(p) = localMean(p) - Lq(p) >= 20`, in integer luminance units of §3.4.
 *
 * The direction is load-bearing and is the whole of what an outline *is*: the pixel must be
 * **darker** than its neighbourhood by at least 20. A pixel lighter than its surroundings is a
 * highlight, not a contour, and `ALPHA_SOLID` cannot tell the two apart.
 */
const INK_MIN_DROP = 20;

/**
 * The Chebyshev radius of §4.5's `localMean` — the window that includes the contour itself.
 *
 * **Two — §4.5's own number.** This is the *texture* detector: it answers "is this pixel darker than
 * the pixels around it", which is true of a 1px contour, of rim shading, and of any small dark
 * feature. It is not the instrument for a contour thicker than its own window, because a uniform
 * 3px or 4px ring has no local contrast left and reads `outlineShare 0` — §4.5's finding 1.
 * {@link BODY_REFERENCE_RADIUS} is the instrument for that, and {@link encloses} is what decides
 * between the two readings of it.
 */
const REFERENCE_RADIUS = 2;

/**
 * The Chebyshev radius of the **body** reference: the window a contour is measured against when the
 * contour itself is too thick to have any local contrast.
 *
 * **Four is the smallest radius that can see past a four-ring contour, and that is the whole
 * justification for the number.** `dist` is 1-Lipschitz, so a pixel at `dist 0` has `dist <= 2`
 * everywhere within radius 2 — the window would be entirely band and the reference would be empty.
 * Radius 3 reaches `dist 3`, which is still band by the definition in {@link CONTOUR_BAND}. Radius 4
 * is the first value that reaches a non-band pixel for *every* pixel in the band, so it is the
 * smallest radius under which a uniform contour of the maximum thickness this dimension calls a
 * contour can be measured at all.
 *
 * **This is the repair §4.5 records as rejected, and the rejection is what produced the gate on it.**
 * Measured on its own, a band-excluded reference at this radius fixes finding 1 and costs eight
 * corpus cases, three of them declared negative controls — a lit subject's boundary shadow is a
 * four-pixel dark band on part of its boundary, and reads exactly like a four-pixel contour. The
 * numbers are in §4.5. What changed is that it is no longer applied unconditionally: see
 * {@link encloses}, which is the topological clause that was missing, and which is the only thing
 * that separates "this dark region wraps the subject" from "this dark region is on one side of it".
 */
const BODY_REFERENCE_RADIUS = 4;

/**
 * §4.5's `maxInkDepth >= 3`, in §3.3's `dist` steps — and the row that reads it now reads
 * `minInkDepth` instead, which is a specification change with a measured reason and a stated cost.
 *
 * **Why `min`.** §4.5 has **two** weight faults and gives them their own rows: a contour that is too
 * thick (`outline-heavy`) and a contour whose weight varies (`outline-inconsistent-weight`). A
 * `max` over the contour reports the first on the strength of a *single* deep patch, which is what
 * the second row is for, so one mistake is charged twice and the second row's own reading is
 * corroborated by a number that does not mean it. `minInkDepth` asks the question the first row
 * actually means — *is the contour too thick* — and leaves *where does the thickness vary* to the row
 * that names it.
 *
 * Measured, on the two declared negative controls this replaces: `control/clean-figure-20` reads
 * `minInkDepth 0, maxInkDepth 3` and `control/clean-union-16` reads `minInkDepth 0, maxInkDepth 4`.
 * Both are **partially** rimmed subjects — a dark tone along part of the boundary and body tone along
 * the rest — and both genuinely have a four-pixel dark column. `min` reports that as what it is, one
 * inconsistent-weight row; `max` reported it as a heavy contour and blocked both documents.
 *
 * **The cost, stated rather than argued away.** A 4px contour on the head with a 1px contour on the
 * body now takes **one** Δ (−150, `outline-inconsistent-weight`) where it took two (−300, both rows).
 * That is a real defect being scored half as heavily, and it is a product decision, not an
 * arithmetic one. §4.5 records it; the reader who disagrees should know exactly what to change.
 */
const HEAVY_DEPTH = 3;

/**
 * §4.5's `CONTOUR_BAND`: the deepest a pixel may be and still be called contour ink.
 *
 * **This is §4.5's own {@link HEAVY_DEPTH}, and the coincidence is the point.** The specification's
 * depth row says a contour that reaches `dist` 3 is heavy, which is a claim that a contour deeper
 * than 3 is still a contour and is merely too thick — so the band a contour may occupy has to be
 * at least as deep as the bound that reports it as too thick, or the depth row is arithmetically
 * dead on every input that reaches it. That is the defect `ditherMask` shipped with in a different
 * quantity, and it is why the constant is written as "the depth the heavy row tolerates" rather
 * than as a number of its own.
 *
 * Without the band, `ink` is evaluated over the whole mask and an internally lit sprite is full of
 * ink: measured on `artwork/verify/lantern-keeper.pixel` before the band existed, `maxInkDepth` read
 * **6** — six steps inside a 32px silhouette, which is the cloak's shading and not a contour — and
 * the dimension scored 300 against a `FLOOR_FAIL` of 300. §4.5 carries the full disproof.
 */
const CONTOUR_BAND = HEAVY_DEPTH;

/**
 * §4.5's `outlineShare` band table, **ascending bound**.
 *
 * §4.5 writes it descending; see the file header for why it is stored the other way round. A
 * ratio of 0 meets no row here and returns {@link OUTLINE_FLOOR_Q}, which is §4.5's "otherwise".
 */
const OUTLINE_BANDS: readonly (readonly [number, number])[] = [
  [350, 700],
  [600, 850],
  [800, 950],
];

/** §4.5's `otherwise` row, reached by falling off the end of {@link OUTLINE_BANDS}. */
const OUTLINE_FLOOR_Q = 550;

/**
 * §4.5's abstention threshold, `outlineShare < 15/100`, as per-mille. See the units note.
 *
 * Exported because it is now the gate of a **document-level precondition**
 * ({@link outlineApplicability}) rather than a branch inside the analyzer, and a gate that
 * cannot be read from outside is a gate a test cannot build a near-miss against.
 */
export const OUTLINE_ABSENT_SHARE_Q = 150;

/** §4.5's `inkGaps / edgePixels >= 5/100`, per-mille. */
const INK_GAP_Q = 50;

/** §4.5's `outlineCoverage >= 45/100`, per-mille. */
const COVERAGE_HEAVY_Q = 450;

/** §4.5's "sparse outline" pairing: `outlineShare >= 60/100` with `outlineCoverage < 3/100`. */
const SPARSE_SHARE_Q = 600;
const SPARSE_COVERAGE_Q = 30;

/** §4.5's `maxInkDepth >= 3`, in the same steps — see {@link HEAVY_DEPTH} for why the row reads `min`. */
const WEIGHT_SPREAD = 2;

/** §4.5's `inkColours >= 4` with the fourth colour holding `>= 5%` of ink. */
const COLOUR_SPLIT_MIN = 4;
const COLOUR_SPLIT_SHARE_Q = 50;

/** §4.5's six Δ values, per-mille off the band base. */
const DELTA_HEAVY_DEPTH = 150;
const DELTA_WEIGHT_SPREAD = 150;
const DELTA_COLOUR_SPLIT = 50;
const DELTA_GAP = 50;
const DELTA_COVERAGE_HEAVY = 200;
const DELTA_SPARSE = 100;

/**
 * Every integer quantity §4.5's table names, on one frame.
 *
 * A record and not a bare score, for `silhouette`'s reason: an agent can act on `maxInkDepth`
 * and cannot act on 700.
 */
export interface OutlineFrame {
  readonly index: number;
  /** False when the frame holds nothing opaque. Such a frame scores 1000 and says so. */
  readonly measured: boolean;
  /** §3.3's `N`. */
  readonly N: number;
  /** §3.3's `edgePixels`: solid pixels with a transparent 4-neighbour or a canvas edge. */
  readonly edgePixels: number;
  /** §4.5's `inkCount`: ink pixels among the edge pixels. */
  readonly inkCount: number;
  /**
   * Every `ink` pixel on the frame, edge pixels and interior ones alike. `inkCount` is this count
   * *restricted to the boundary*; `outlineCoverage` needs the whole set.
   */
  readonly inkTotal: number;
  /** §4.5's `outlineShare`, per-mille over `edgePixels`. The primary ratio. */
  readonly outlineShare: number;
  /** §4.5's `outlineCoverage`, per-mille over `N`. */
  readonly outlineCoverage: number;
  /** §4.5's `minInkDepth`, or `-1` when there is no ink at all. */
  readonly minInkDepth: number;
  /** §4.5's `maxInkDepth`, or `-1` when there is no ink at all. */
  readonly maxInkDepth: number;
  /**
   * §4.5's `quadrantDepth`: max ink depth in each of the four quadrants of `bounds`, in
   * TL, TR, BL, BR order. `-1` for a quadrant holding no ink at all.
   */
  readonly quadrantDepth: readonly [number, number, number, number];
  /** §4.5's `inkColours`: distinct packed colours on the contour's outer ring. */
  readonly inkColours: number;
  /** §4.5's `inkGaps`: boundary pixels with no ink, next to ink that is. */
  readonly inkGaps: number;
  /** The band base §4.5's table returned, before the six Δ adjustments. */
  readonly baseQ: number;
  /** The sum of the six Δ adjustments, negative or zero. */
  readonly adjustmentQ: number;
  readonly scoreQ: number;
  readonly issues: readonly QualityIssue[];
}

/**
 * §4.5's band lookup, read **ascending**.
 *
 * The first row whose bound is met while walking upward, and {@link OUTLINE_FLOOR_Q} when none
 * is. A ratio of 0 therefore returns 550 — the row §4.5 gives it — and not the loosest band,
 * which is the shape of defect this repository has shipped before.
 */
function bandFor(shareQ: number): number {
  // **Overwritten, not returned.** The table is walked ascending and the *last* row whose bound is
  // met wins, which is what "the highest band this ratio clears" means. Returning the first match
  // is the same class of defect as reading a descending table in its written order: it inverts the
  // table, and it does so in the direction that scores a perfect 1px contour at 700 instead of 950.
  // Measured before this line was changed, on a closed 1px contour over the whole boundary: 700.
  let score = OUTLINE_FLOOR_Q;
  for (const [bound, band] of OUTLINE_BANDS) {
    if (shareQ >= bound) score = band;
  }
  return score;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

/** A §3.3 `dist` in pixels for a message, with `-1` — an empty quadrant — said rather than printed. */
function depthWord(dist: number): string {
  return dist < 0 ? 'none' : `${dist + 1}px`;
}

/**
 * Whether an issue survives `context.focus`.
 *
 * A scope, not a crop, so it never changes a number — only which defects the caller is told
 * about. Written out rather than imported because `silhouette.ts` and `value.ts` each have
 * their own copy and §3.3 does not name it; it is five lines of rectangle intersection and
 * neither is a measured quantity, so a second copy cannot make a number wrong.
 */
function focused(context: QualityContext, rect: Rect | null): boolean {
  if (context.focus === null || rect === null) return true;
  return (
    rect.x < context.focus.x + context.focus.w &&
    context.focus.x < rect.x + rect.w &&
    rect.y < context.focus.y + rect.h &&
    context.focus.y < rect.y + rect.h
  );
}

/**
 * §4.5's reference window: the mean `Lq` over the solid pixels of the `(2*REFERENCE_RADIUS + 1)`
 * Chebyshev window at `p` that lie **deeper than the contour band**, by integer division.
 *
 * ## What changed, and why the old window could not work
 *
 * §4.5's original `localMean` averaged *every* solid pixel in the window, including `p` and
 * including the other pixels of the contour itself. That is a local-contrast test, and it has two
 * measured consequences that a corpus run found and this document cannot argue away:
 *
 *   1. **A uniform contour three pixels or more thick has no local contrast left.** Its own tone is
 *      the local mean, so `outlineShare` collapses to **0** and the dimension reports the heaviest
 *      contour in its own vocabulary as *having no outline*.
 *   2. **Interior shading is ink.** A pixel anywhere in a lit sprite that is 20 `Lq` darker than its
 *      neighbourhood satisfies it, so `artwork/verify/lantern-keeper.pixel` read `maxInkDepth 6` —
 *      six steps inside a 32px silhouette — and scored 300 against a `FLOOR_FAIL` of 300.
 *
 * Excluding everything inside the band answers both at once, because the band is by construction
 * the part of the subject that *could* be contour: the reference is the tone of the body the
 * contour is drawn on, and a contour of any thickness up to the band's own depth is measured against
 * that body rather than against itself.
 *
 * ## The three properties that make it safe
 *
 *   - **It is never empty.** The caller only asks about a solid `p`, and a `p` inside the band has
 *     nothing beneath it in the band by definition — so "empty" is a real answer here and it means
 *     *there is no body within reach*, which the caller reads as "not ink". A predicate that
 *     divides by a count that can be 0 returns `NaN`, and `NaN` reaching a band edge is the
 *     failure `ditherMask` shipped with.
 *   - **It is still local.** §4.5's reason for a local mean is that a sprite-wide one makes the
 *     measure a statement about the key. Measured, the global version is worse than useless here:
 *     the mean `Lq` over `dist >= 4` on `artwork/verify/lantern-keeper.pixel` is **77**, because
 *     the cloak is most of the subject, so a global reference calls every pixel below `Lq 97` ink
 *     and reads `outlineShare` **703**.
 *   - **Transparent pixels are excluded rather than counted as black.** The background is exactly
 *     what an outline is drawn *against*; counting it would make the reference a statement about how
 *     much background happens to be nearby.
 */
function referenceMean(
  cel: QualityCel,
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  let sum = 0;
  let count = 0;
  for (let dy = -REFERENCE_RADIUS; dy <= REFERENCE_RADIUS; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= height) continue;
    for (let dx = -REFERENCE_RADIUS; dx <= REFERENCE_RADIUS; dx++) {
      const nx = x + dx;
      if (nx < 0 || nx >= width) continue;
      const q = ny * width + nx;
      if (mask[q] !== 1) continue;
      sum += lqOf(cel, q);
      count++;
    }
  }
  // **`count >= 1` on any solid `p`, which is inside its own window.** A predicate that divides by a
  // count that can be 0 returns `NaN` on the canvas edge, and `NaN` reaching a band edge is the
  // failure `ditherMask` shipped with. The `count === 0` arm is unreachable from the caller and
  // exists so the function is total on its own terms rather than by its caller's discipline.
  return count === 0 ? lqOf(cel, y * width + x) : Math.floor(sum / count);
}

/**
 * §4.5's `dark(p)` against the **body**: the mean `Lq` over the solid pixels of the
 * `(2*BODY_REFERENCE_RADIUS + 1)` window at `p` that lie **deeper than the contour band**, or `-1`
 * when the window holds none.
 *
 * **`-1`, not a fallback value.** A pixel whose entire window is band is a pixel of a contour
 * thicker than the radius can see past, which is precisely the case this reference exists for, and it
 * has no body to be measured against — so the honest answer is "no reference", and
 * {@link darkAgainstBody} turns that into "not dark". Returning `lqOf(p)` instead would make the
 * predicate vacuously *true* at every `Lq`, which is the `NaN`-reaching-a-band-edge class of defect
 * this repository has shipped.
 */
function bodyMean(
  cel: QualityCel,
  mask: Uint8Array,
  dist: Int32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  let sum = 0;
  let count = 0;
  for (let dy = -BODY_REFERENCE_RADIUS; dy <= BODY_REFERENCE_RADIUS; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= height) continue;
    for (let dx = -BODY_REFERENCE_RADIUS; dx <= BODY_REFERENCE_RADIUS; dx++) {
      const nx = x + dx;
      if (nx < 0 || nx >= width) continue;
      const q = ny * width + nx;
      if (mask[q] !== 1 || dist[q] <= CONTOUR_BAND) continue;
      sum += lqOf(cel, q);
      count++;
    }
  }
  return count === 0 ? -1 : Math.floor(sum / count);
}

/**
 * The topological clause, and the whole of finding 1's repair.
 *
 * ## The claim
 *
 * The pixels of a four-pixel uniform contour and the pixels of a four-pixel-deep shadow that
 * reaches the boundary are **the same set of pixels**. §4.5 measured that and concluded that no
 * tone-and-distance predicate separates them, which is true and is also only half the statement: it
 * is true *per pixel*. The comparison that decides is not between two pixels, it is between one set
 * of pixels and the **shape of the set**.
 *
 * A contour *wraps the subject*. A cast shadow *occupies one side of it*. Those are different
 * shapes and the difference is not visible on any single pixel of either — which is why §4.5's
 * per-pixel repair (the body reference, {@link BODY_REFERENCE_RADIUS}) costs eight corpus cases
 * while fixing finding 1. This is the missing clause:
 *
 * ```
 * encloses(C)  =  no pixel of (mask \ C) is reachable, 8-connected, from the canvas's transparent
 *                 edge pixels without crossing C
 * ```
 *
 * ## Why this is the right shape of question
 *
 * `encloses` asks about the *cut* a set makes, not about the set's colour, depth or alignment. It is
 * the one question about a contour band that a cast shadow answers differently, because a shadow
 * cannot go all the way round without becoming a contour.
 *
 * ## The three properties that make it safe
 *
 *   - **It is a total function.** Every `C` either separates the subject from the outside or it
 *     does not; there is no count that can be 0 and no arithmetic that can return `NaN`.
 *   - **It is 8-connected, deliberately.** §3.3's background is 8-connected and its subject is
 *     4-connected, and this flood is a *background* flood — it is asking what the outside can reach.
 *     A 4-connected flood would squeeze through the diagonal of a 45-degree staircase contour and
 *     report every staircase contour in this repository's style as failing to enclose, which is
 *     `inkGaps`' finding 3 arriving through a second door.
 *   - **It is seeded only on transparent edge pixels.** A solid pixel on the canvas edge is a
 *     *subject* pixel that happens to be at the edge, not an exterior pixel, and treating it as
 *     exterior makes any edge-touching subject read as open. The first version of this function made
 *     exactly that mistake and `control/outline-ring-32` — which draws a closed contour — read
 *     `encloses false`. The number is recorded because it is the same class of error as the five
 *     shipped measurements: a predicate whose first version is wrong in the direction that looks
 *     safe.
 */
function encloses(cut: Uint8Array, mask: Uint8Array, width: number, height: number): boolean {
  const size = width * height;
  const reached = new Uint8Array(size);
  const stack = new Int32Array(size);
  let top = 0;
  for (let p = 0; p < size; p++) {
    if (mask[p] === 1) continue;
    const x = p % width;
    const y = (p - x) / width;
    if (x !== 0 && y !== 0 && x !== width - 1 && y !== height - 1) continue;
    reached[p] = 1;
    stack[top++] = p;
  }
  while (top > 0) {
    const p = stack[--top];
    const x = p % width;
    const y = (p - x) / width;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        if (reached[q] === 1) continue;
        if (mask[q] === 1 && cut[q] === 1) continue;
        reached[q] = 1;
        stack[top++] = q;
      }
    }
  }
  for (let p = 0; p < size; p++) {
    if (mask[p] === 1 && cut[p] === 0 && reached[p] === 1) return false;
  }
  return true;
}

/** §4.5's `dark(p)` against the body. `false` when the window holds no body to compare against. */
function darkAgainstBody(
  cel: QualityCel,
  mask: Uint8Array,
  dist: Int32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): boolean {
  const ref = bodyMean(cel, mask, dist, width, height, x, y);
  return ref >= 0 && ref - lqOf(cel, y * width + x) >= INK_MIN_DROP;
}

/**
 * §4.5's `ink(p)`: `dark(p)`, within {@link CONTOUR_BAND} of the boundary, and reachable from it.
 *
 * Four clauses, each answering a measured disproof rather than a preference.
 *
 *   - **The band.** A contour is a band adjacent to the subject's exterior boundary, so `ink` is
 *     only claimed for pixels within {@link CONTOUR_BAND} of it. Read over the whole mask, the
 *     predicate admits the shading inside a lit sprite; measured, that is `maxInkDepth 6` on
 *     `artwork/verify/lantern-keeper.pixel`.
 *   - **The boundary connection.** A dark pixel nothing on the boundary leads to is a pupil, a
 *     buckle or the shadow under a chin. Interior shading is *area* and a contour is *thin*, and
 *     the connection is what says which: the flood fill keeps only the dark components that reach
 *     an `edgePixel`, so an interior blob contributes to nothing this dimension reports.
 *   - **The band is as deep as the heavy row tolerates.** See {@link CONTOUR_BAND}; a shallower
 *     band makes `maxInkDepth >= 3` arithmetically dead, which is the defect `ditherMask` shipped
 *     with in another quantity.
 *   - **Enclosure.** A dark band admitted on the *body* reference rather than on the local one is
 *     admitted only if it **encloses** — see {@link encloses}. This is the clause that makes the
 *     heavy depth row reachable at all, and §4.5 carries the measurement: without it the body
 *     reference alone puts `outline-heavy` on three declared negative controls.
 *
 * ## The order of the two dark tests, and why it is a union and not a choice
 *
 * `dark` against the body is **strictly more permissive** than `dark` against the local window on
 * every subject that has a body under its contour, because the local window's mean is pulled down by
 * the contour's own pixels while the body's is not. Measured on a 16x16 block: at one ring the two
 * agree and both read 60 boundary pixels of ink; at three rings the local predicate reads **0** and
 * the body predicate reads **60**. So a union cannot over-report anything the shipped predicate did
 * not already report, and it can only add ink — which is the direction finding 1 is about.
 *
 * The fill is 4-connected, because §3.3's subject is 4-connected and
 * `connectivity/diagonal-bridge-16` declares a diagonal-only contact a defect. Each component is
 * flooded twice — once to learn whether it reaches the boundary, once to mark it — because a
 * component cannot be marked until it has been decided on, and a single pass cannot un-mark it.
 * Mark-on-push, so every pixel is visited twice and the result cannot depend on traversal order
 * (§3.2 rule 4).
 */
function inkMask(
  cel: QualityCel,
  mask: Uint8Array,
  dist: Int32Array,
  width: number,
  height: number,
): Uint8Array {
  const size = width * height;

  /** §4.5's `dark` as shipped: local contrast, radius 2, band only. */
  const localDark = new Uint8Array(size);
  /** The band-excluded reading, which a thick contour needs and a cast shadow also satisfies. */
  const bodyDark = new Uint8Array(size);
  for (let p = 0; p < size; p++) {
    if (mask[p] !== 1 || dist[p] > CONTOUR_BAND) continue;
    const x = p % width;
    const y = (p - x) / width;
    if (referenceMean(cel, mask, width, height, x, y) - lqOf(cel, p) >= INK_MIN_DROP) localDark[p] = 1;
    if (darkAgainstBody(cel, mask, dist, width, height, x, y)) bodyDark[p] = 1;
  }

  /**
   * The dark set, decided per body-dark component so that a sprite carrying a real contour *and* a
   * one-sided shadow is judged on each part separately.
   *
   * **A global test would be wrong here**, and the reason is the corpus: `artwork/moonlit-alpine-lake.pixel`
   * has a scene inside it whose dark regions are a union of one enclosing shape and one that is not,
   * and a global `encloses` would throw the enclosing one away with the other. Measured with a global
   * test, that case reads `encloses true` and admits 75 body-dark pixels; measured per component it
   * reads what §4.5's per-frame question asks for.
   */
  const dark = new Uint8Array(size);
  const seen = new Uint8Array(size);
  const stack = new Int32Array(size);
  for (let p = 0; p < size; p++) if (localDark[p] === 1) dark[p] = 1;

  for (let s = 0; s < size; s++) {
    if (bodyDark[s] !== 1 || seen[s] === 1) continue;
    const component = new Uint8Array(size);
    let top = 0;
    seen[s] = 1;
    component[s] = 1;
    stack[top++] = s;
    while (top > 0) {
      const p = stack[--top];
      const x = p % width;
      const y = (p - x) / width;
      for (let n = 0; n < 4; n++) {
        const nx = n === 0 ? x + 1 : n === 1 ? x - 1 : x;
        const ny = n === 2 ? y + 1 : n === 3 ? y - 1 : y;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        if (bodyDark[q] !== 1 || seen[q] === 1) continue;
        seen[q] = 1;
        component[q] = 1;
        stack[top++] = q;
      }
    }
    if (!encloses(component, mask, width, height)) continue;
    for (let p = 0; p < size; p++) if (component[p] === 1) dark[p] = 1;
  }

  const ink = new Uint8Array(size);
  const cleared = new Uint8Array(size);
  for (let s = 0; s < size; s++) {
    if (dark[s] !== 1 || cleared[s] === 1) continue;
    let top = 0;
    let reachesBoundary = false;
    cleared[s] = 1;
    stack[top++] = s;
    while (top > 0) {
      const p = stack[--top];
      if (dist[p] === 0) reachesBoundary = true;
      const x = p % width;
      const y = (p - x) / width;
      for (let n = 0; n < 4; n++) {
        const nx = n === 0 ? x + 1 : n === 1 ? x - 1 : x;
        const ny = n === 2 ? y + 1 : n === 3 ? y - 1 : y;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        if (dark[q] !== 1 || cleared[q] === 1) continue;
        cleared[q] = 1;
        stack[top++] = q;
      }
    }
    if (!reachesBoundary) continue;
    top = 0;
    stack[top++] = s;
    ink[s] = 1;
    while (top > 0) {
      const p = stack[--top];
      const x = p % width;
      const y = (p - x) / width;
      for (let n = 0; n < 4; n++) {
        const nx = n === 0 ? x + 1 : n === 1 ? x - 1 : x;
        const ny = n === 2 ? y + 1 : n === 3 ? y - 1 : y;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        if (dark[q] !== 1 || ink[q] === 1) continue;
        ink[q] = 1;
        stack[top++] = q;
      }
    }
  }
  return ink;
}

/**
 * §4.5's `inkRun(p)`: the longest **same-colour radial run inward** from `p`.
 *
 * ```
 * run(p) = 1 + max { run(q) : q 4-adjacent to p, dist(q) = dist(p) + 1, colour(q) = colour(p) }
 * inkDepth(p) = run(p) - 1                                     // for a contour pixel p
 * ```
 *
 * ## Why depth is a colour run and not `dist`
 *
 * §4.5's original `inkDepth(p) = dist(p)` asks "how far inside the silhouette is the darkest thing
 * I can find", and on a lit subject those are not the same question. Measured on
 * `artwork/verify/lantern-keeper.pixel`: the sprite's contour is one pixel at `Lq` 36, and
 * immediately inside it on the head's right flank sits a **two-to-three-pixel band at `Lq` 50** —
 * rim shading, boundary-connected, four steps deep. Every predicate that admits a four-ring uniform
 * contour as ink admits that band too, so a `dist`-based depth calls a 1px outline a 4px one and
 * fires `outline-heavy` on the only human-rated sprite in the repository. **No threshold fixes
 * this**: the two are the same pixels, which is §3.3's rule that no gate separates two cases that
 * are equivalent on the same pixels.
 *
 * A run of *one colour* is what an outline is: a band of a single tone hugging the boundary. Two
 * nested dark tones are a contour plus shading, and this measure says `1px` where `dist` says `4px`.
 * It is also what makes §4.5's depth row reachable on a *uniform* contour at all, which is the
 * defect §4.5 records as its finding 1 — a ring three rings or more thick has no local contrast
 * left, so under the old predicate the heaviest contour in the dimension's own vocabulary read as
 * *having no outline*.
 *
 * ## Why the recurrence is a layered pass and not a queue
 *
 * Every step increases `dist` by exactly one, so the dependency graph is acyclic by construction
 * and one ordered walk over the layers suffices — §3.3's `dist` being a BFS *field* rather than a
 * distance to one place. One layer past {@link CONTOUR_BAND} is computed because a run starting on
 * the boundary has to be able to reach the band's outermost layer, or the deepest reading the heavy
 * row can ever take is one short.
 */
function inkRunField(
  cel: QualityCel,
  mask: Uint8Array,
  dist: Int32Array,
  width: number,
  height: number,
): Int32Array {
  const size = width * height;
  const run = new Int32Array(size);
  const layers: number[][] = [];
  for (let d = 0; d <= CONTOUR_BAND + 1; d++) layers.push([]);
  for (let p = 0; p < size; p++) {
    if (mask[p] !== 1) continue;
    const d = dist[p];
    if (d > CONTOUR_BAND + 1) continue;
    layers[d].push(p);
  }
  const colourOf = (p: number): number => {
    const i = p * 4;
    return (cel.data[i] << 16) | (cel.data[i + 1] << 8) | cel.data[i + 2];
  };
  // **Innermost layer first, and no layer is special-cased.** `run(p)` reads `run(q)` at
  // `dist(p) + 1`, so the dependency runs the other way from the BFS that produced `dist`, and
  // walking the layers upward would read every neighbour as an uncomputed zero. A second version of
  // this loop guarded the neighbour scan with `if (d > 0)`, on the reasoning that layer 0 has no
  // deeper layer — which is true and irrelevant, because layer 0 is the *only* layer whose reading
  // this dimension reports. `maxInkDepth` read **0 on every input**, including a four-ring uniform
  // contour, and §4.5's depth row was unreachable while every test on it stayed green. That is the
  // sixth measurement in this repository that could not fail, and it is in this file.
  for (let d = CONTOUR_BAND + 1; d >= 0; d--) {
    for (const p of layers[d]) {
      let best = 1;
      const colour = colourOf(p);
      const x = p % width;
      const y = (p - x) / width;
      for (let n = 0; n < 4; n++) {
        const nx = n === 0 ? x + 1 : n === 1 ? x - 1 : x;
        const ny = n === 2 ? y + 1 : n === 3 ? y - 1 : y;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        if (mask[q] !== 1 || dist[q] !== d + 1 || run[q] === 0) continue;
        if (colourOf(q) !== colour) continue;
        if (run[q] + 1 > best) best = run[q] + 1;
      }
      run[p] = best;
    }
  }
  return run;
}

/** The tight box of a pixel list, or `null` for an empty one. */
function boxOf(pixels: readonly number[], width: number): Rect | null {
  if (pixels.length === 0) return null;
  let minX = width;
  let maxX = -1;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = -1;
  for (const p of pixels) {
    const x = p % width;
    const y = (p - x) / width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function measureFrame(context: QualityContext, index: number): OutlineFrame {
  const { width, height } = context;
  const cel = context.composite[index];
  const { mask, solid: N } = buildSolidMask(cel, width, height);

  if (N === 0) {
    return {
      index,
      measured: false,
      N: 0,
      edgePixels: 0,
      inkCount: 0,
      inkTotal: 0,
      outlineShare: 0,
      outlineCoverage: 0,
      minInkDepth: -1,
      maxInkDepth: -1,
      quadrantDepth: [-1, -1, -1, -1],
      inkColours: 0,
      inkGaps: 0,
      baseQ: OUTLINE_FLOOR_Q,
      adjustmentQ: 0,
      scoreQ: 1000,
      issues: [],
    };
  }

  // **§3.3's field, not a private BFS.** §4.5 says so in its own words and `measure.ts` says it
  // twice more: `value` uses `Dmax` for a plane's depth spread and `noise` uses it for the thin
  // sprite test, and three BFS runs that agree are a fact while three that disagree by a pixel are
  // a bug report nobody can reproduce.
  const { dist } = distField(mask, width, height);

  const size = width * height;
  const ink = inkMask(cel, mask, dist, width, height);
  const run = inkRunField(cel, mask, dist, width, height);

  const edgePixels: number[] = [];
  const inkPixels: number[] = [];
  for (let p = 0; p < size; p++) {
    if (mask[p] !== 1) continue;
    const x = p % width;
    const y = (p - x) / width;
    if (ink[p] === 1) inkPixels.push(p);
    if (edgePixelAt(mask, width, height, x, y)) edgePixels.push(p);
  }
  const edgeCount = edgePixels.length;

  /** The contour itself: the ink pixels **on the boundary**. Every depth and colour reading is about these. */
  const contour: number[] = [];
  for (const p of edgePixels) if (ink[p] === 1) contour.push(p);
  const inkCount = contour.length;
  const inkTotal = inkPixels.length;

  // §3.7's per-mille form of §4.5's `>= 80/100`, `>= 60/100`, `>= 35/100`, `>= 15/100`. The
  // specification writes these in hundredths and the pipeline is per-mille (§3.7), so the
  // comparison is against 800 / 600 / 350 / 150 and the multiply is by 1000. Writing `80` here
  // instead would be a silent ten-fold miss on the primary ratio of the dimension, which is the
  // exact defect `off-palette` shipped with.
  //
  // **§3.7's denominators, with no `+1`.** §3.7 gives `inkCount * 100 >= 80 * edgePixels`, so the
  // denominator is the count itself. The first version of this file used the `denominator + 1` form
  // that `ditherShare` uses to survive an empty component, and it made `outlineShare` read **984
  // on a subject with a contour on every boundary pixel** — a 1px outline cannot score 1000, and
  // cannot be described by the number an agent reads as "the whole boundary is inked". The `+1` is
  // guarded explicitly instead, because `rhu(a, 0)` is `Infinity` and `Infinity` reaching a band
  // edge is the failure mode `ditherMask` shipped with.
  const outlineShare = edgeCount === 0 ? 0 : rhu(inkCount * 1000, edgeCount);
  const outlineCoverage = N === 0 ? 0 : rhu(inkTotal * 1000, N);

  /* --- `inkDepth`: the same-colour radial run inward, read on the contour --- */
  let minInkDepth = -1;
  let maxInkDepth = -1;
  for (const p of contour) {
    const depth = run[p] - 1;
    if (minInkDepth < 0 || depth < minInkDepth) minInkDepth = depth;
    if (depth > maxInkDepth) maxInkDepth = depth;
  }

  /* --- `inkGaps`: boundary pixels with no ink, standing next to ink that is --- */
  let inkGaps = 0;
  for (const p of edgePixels) {
    if (ink[p] === 1) continue;
    const x = p % width;
    const y = (p - x) / width;
    let nextToInk = false;
    for (let dy = -1; dy <= 1 && !nextToInk; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        // **8-connectivity, and it is §3.3's own choice.** The background of this repository is
        // 8-connected and the subject 4-connected, and the diagonal run of a 45-degree staircase is
        // a statement about *attachment*, not about the contour. The old 4-neighbour test counted
        // the staircase itself: measured on a closed 1px contour over the 22-row disc it read
        // **22 gaps of 60**, and the same **22 of 60** on the same contour with a 3px nick taken
        // out of it — identical on a perfect contour and a damaged one, which is the property
        // §4.5 says the measure was missing. Counting the boundary pixels where ink **stops and
        // ink resumes** answers the question the code names under either connectivity, and its
        // near-miss is exact rather than approximate: a closed contour reads 0 whatever its shape.
        if (edgePixelAt(mask, width, height, nx, ny) && ink[ny * width + nx] === 1) {
          nextToInk = true;
          break;
        }
      }
    }
    if (nextToInk) inkGaps++;
  }

  /* --- `quadrantDepth`: max ink depth per quadrant of the contour's bounds --- */
  const bounds = boxOf(contour.length > 0 ? contour : edgePixels, width) ?? {
    x: 0,
    y: 0,
    w: width,
    h: height,
  };
  const midX = bounds.x + Math.floor(bounds.w / 2);
  const midY = bounds.y + Math.floor(bounds.h / 2);
  const quadrantDepth: [number, number, number, number] = [-1, -1, -1, -1];
  for (const p of contour) {
    const x = p % width;
    const y = (p - x) / width;
    const q = y < midY ? (x < midX ? 0 : 1) : x < midX ? 2 : 3;
    if (run[p] - 1 > quadrantDepth[q]) quadrantDepth[q] = run[p] - 1;
  }
  // **A quadrant holding no ink at all is `-1`, and it is excluded from the spread rather than
  // read as `0`.** Reading it as 0 would make "1px here" and "nothing here" the same number, which
  // is precisely the distinction §4.5's prose is about — "a contour that vanishes halfway down
  // the left side". Excluding it means the spread measures weight *across the contour that exists*; a
  // subject whose contour is missing from a whole quadrant is caught by `outlineShare` and
  // `outline-gap`, which are the measures about absence, rather than by a weight reading about
  // pixels that are not there.
  const presentDepths = quadrantDepth.filter((d) => d >= 0);
  const spread = presentDepths.length === 0 ? 0 : Math.max(...presentDepths) - Math.min(...presentDepths);

  /* --- `inkColours`: distinct packed colours **on the contour** --- */
  const colourCounts = new Map<number, number>();
  for (const p of contour) {
    const i = p * 4;
    const packed = (cel.data[i] << 16) | (cel.data[i + 1] << 8) | cel.data[i + 2];
    colourCounts.set(packed, (colourCounts.get(packed) ?? 0) + 1);
  }
  const inkColours = colourCounts.size;
  // §4.5: "the 4th colour holds >= 5% of ink". Ordered by share so "the fourth" is the fourth
  // *commonest*, which is the only reading under which the clause says anything — a fourth colour
  // sorted alphabetically is not a finding.
  const sortedShares = [...colourCounts.values()].sort((a, b) => b - a);
  const fourthShareQ =
    sortedShares.length >= COLOUR_SPLIT_MIN && contour.length > 0
      ? rhu(sortedShares[3] * 1000, contour.length)
      : 0;

  /* --- the score --- */
  //
  // **There is no abstention branch here, and that is the change.** §4.5 used to test
  // `outlineShare < 15/100` here, return a neutral 700 and emit `outline-missing` — a code, an
  // issue with a severity, on a subject that had done nothing wrong. §3.5 defines an issue as "one
  // thing that is wrong with the artwork", and §4.5's own prose says the absence of a contour is a
  // legitimate style. An abstention that emits a code is not an abstention: it is a defect report
  // that has agreed to score itself 0.70 instead of 0.00. The gate moved up to
  // {@link outlineApplicability}, which is the aggregator's call, and the analyzer is never reached
  // on a document that declares no contour at all.
  const issues: QualityIssue[] = [];
  let adjustmentQ = 0;
  const baseQ = bandFor(outlineShare);
  let scoreQ = baseQ;

  // **The per-frame floor on the Δ rows, and it is not the abstention.**
  //
  // §4.5's structural rows are about a contour that *exists*: `outline-heavy` asks whether it is
  // too thick, `outline-gap` asks where it stops. On a frame with no contour to be thick or to stop,
  // they are answering about ink that is not there — measured on `oneSidedShadowBlock`, a subject
  // whose dark band is refused by `encloses` and is therefore not contour, `minInkDepth` and
  // `inkGaps` both still read as though it were, and the rows fire. So the Δ rows stay behind the
  // same 150 gate the document-level abstention uses.
  //
  // What is different from §4.5 is what happens on the other side of it. There is no neutral value
  // and no code: the frame reads `baseQ`, which for any ratio under 350 is §4.5's own "otherwise"
  // row, and says nothing. The frame is not graded, because there is nothing to grade — the
  // *document* has been declined by {@link outlineApplicability}, and this guard is what keeps
  // {@link measureOutline} honest when a caller asks about a frame directly, which the corpus and
  // this file's own fixtures both do.
  //
  // The one case where a frame below the gate is inside a *measured* document is a multi-frame sheet
  // whose other frames do declare a contour. There the lowest band is the honest reading of "this
  // frame dropped its outline", and it is what the worst-frame rule then reports.
  if (outlineShare >= OUTLINE_ABSENT_SHARE_Q) {
    if (minInkDepth >= HEAVY_DEPTH) {
      adjustmentQ -= DELTA_HEAVY_DEPTH;
      scoreQ -= DELTA_HEAVY_DEPTH;
      const deep = contour.filter((p) => run[p] - 1 >= HEAVY_DEPTH);
      const rect = boxOf(deep, width);
      const issue: QualityIssue = {
        code: 'outline-heavy',
        message: `the contour is ${minInkDepth + 1}px deep at its *thinnest* point and ${maxInkDepth + 1}px at its thickest — §4.5's target is one pixel. A 4px+ contour is not holding the edge, it is replacing the sprite, and the head of a character is where it shows first.`,
        rect,
        severity: 0.5,
      };
      if (focused(context, rect)) issues.push(issue);
    }

    if (spread >= WEIGHT_SPREAD) {
      adjustmentQ -= DELTA_WEIGHT_SPREAD;
      scoreQ -= DELTA_WEIGHT_SPREAD;
      const rect = boxOf(
        contour.filter((p) => run[p] - 1 === maxInkDepth),
        width,
      );
      const issue: QualityIssue = {
        code: 'outline-inconsistent-weight',
        message: `contour depth varies by ${spread} across the four quadrants (TL ${depthWord(quadrantDepth[0])}, TR ${depthWord(quadrantDepth[1])}, BL ${depthWord(quadrantDepth[2])}, BR ${depthWord(quadrantDepth[3])}). A 2px outline on one part of a sprite and 1px on another reads as a mistake, because it is one.`,
        rect,
        severity: 0.45,
      };
      if (focused(context, rect)) issues.push(issue);
    }

    if (inkColours >= COLOUR_SPLIT_MIN && fourthShareQ >= COLOUR_SPLIT_SHARE_Q) {
      adjustmentQ -= DELTA_COLOUR_SPLIT;
      scoreQ -= DELTA_COLOUR_SPLIT;
      const issue: QualityIssue = {
        code: 'outline-colour-split',
        message: `${inkColours} distinct colours on the contour, and the fourth holds ${fourthShareQ}/1000 of the ink. One contour in one colour holds a sprite's edge; a contour that changes colour is read as two shapes meeting.`,
        rect: null,
        severity: 0.25,
      };
      if (focused(context, null)) issues.push(issue);
    }

    const gapQ = edgeCount === 0 ? 0 : rhu(inkGaps * 1000, edgeCount);
    if (gapQ >= INK_GAP_Q) {
      adjustmentQ -= DELTA_GAP;
      scoreQ -= DELTA_GAP;
      const issue: QualityIssue = {
        code: 'outline-gap',
        message: `${inkGaps} of ${edgeCount} boundary pixels carry no ink and stand next to ink that does (${gapQ}/1000), so the contour stops and resumes in that many places. Selective outlining is a good technique and this is advisory, not a defect: the craft guide recommends dropping the contour where the light hits, and a gap is reported so it can be seen rather than to be argued with.`,
        rect: null,
        severity: 0.25,
      };
      if (focused(context, null)) issues.push(issue);
    }

    if (outlineCoverage >= COVERAGE_HEAVY_Q) {
      adjustmentQ -= DELTA_COVERAGE_HEAVY;
      scoreQ -= DELTA_COVERAGE_HEAVY;
      const issue: QualityIssue = {
        code: 'outline-heavy',
        message: `the contour covers ${outlineCoverage}/1000 of the subject's ${N} pixels — §4.5's limit is ${COVERAGE_HEAVY_Q}/1000. An outline that thick is not holding the edge, it is replacing the sprite.`,
        rect: null,
        severity: 0.7,
      };
      if (focused(context, null)) issues.push(issue);
    } else if (outlineShare >= SPARSE_SHARE_Q && outlineCoverage < SPARSE_COVERAGE_Q) {
      adjustmentQ -= DELTA_SPARSE;
      scoreQ -= DELTA_SPARSE;
      const issue: QualityIssue = {
        code: 'outline-gap',
        message: `contour on ${outlineShare}/1000 of the boundary but only ${outlineCoverage}/1000 of the sprite — the subject is barely outlined. Read against a busy background a 32px sprite with no contour on it dissolves.`,
        rect: null,
        severity: 0.35,
      };
      if (focused(context, null)) issues.push(issue);
    }
  }

  scoreQ = Math.max(0, scoreQ);

  return {
    index,
    measured: true,
    N,
    edgePixels: edgeCount,
    inkCount,
    inkTotal,
    outlineShare,
    outlineCoverage,
    minInkDepth,
    maxInkDepth,
    quadrantDepth,
    inkColours,
    inkGaps,
    baseQ,
    adjustmentQ,
    scoreQ,
    issues,
  };
}

/** `outline` over every frame, in playback order. */
export function measureOutline(context: QualityContext): OutlineFrame[] {
  const out: OutlineFrame[] = [];
  for (let i = 0; i < context.composite.length; i++) out.push(measureFrame(context, i));
  return out;
}

/**
 * The `outline` precondition, and the whole of the absent-outline abstention.
 *
 * ## What it decides
 *
 * `'no-outline'` when **every inked frame** reads `outlineShare < 15/100`
 * ({@link OUTLINE_ABSENT_SHARE_Q}): the document has a readable subject and declares no contour,
 * so there is no outline discipline to judge. `null` otherwise.
 *
 * ## Why this is a precondition and not a branch inside the analyzer
 *
 * Three reasons, in the order they matter.
 *
 * 1. **An excluded dimension has no score and its weight renormalises away.** `evaluate` in
 *    `quality/index.ts` owns `report.excluded`, and `weightedTotalQ` builds its denominator from
 *    the weights of the dimensions that are *present*. An abstention expressed as a score would
 *    have to be some number, and any number in that position is a claim: §4.5 shipped 700, which
 *    is a **passing mark handed out for having said nothing**, and it dragged a still sprite's
 *    weighted mean *down* rather than removing the dimension from it. There is no third option
 *    where a number is involved.
 * 2. **An abstention cannot carry a code.** §3.5 defines an issue as "one thing that is wrong
 *    with the artwork", and the member this produces says the artwork is fine. So `outline-missing`
 *    is gone — not renamed, not downgraded, gone. Its 0.20 severity was below
 *    {@link SEVERITY_BLOCKING} and therefore never gated anything, which is why removing it
 *    changes no verdict; it existed only to tell an agent something the report already said
 *    better, in `excluded`, with a reason instead of a percentage.
 * 3. **It is the aggregator's call on principle, not only for symmetry.**
 *    `types.ts`'s `ExcludedReason` doc says so: "a dimension that declared its own unfitness
 *    would be the analyzer deciding whether its own answer counts, and there is no version of
 *    that which is not a way to grade one's own homework." The analyzer cannot decline — it can
 *    only answer. So the gate lives beside {@link requiresReadableSubject} and
 *    {@link motionApplicability}.
 *
 * ## Why it is a *document-level* gate, evaluated over frames
 *
 * §4.5's threshold is per frame, and `QualityReport.excluded` is keyed by dimension, so a
 * per-frame decision has to be lifted to the document somehow. The lift is
 * {@link hasReadableSubject}'s, unchanged: **any** inked frame at or above the gate is enough for
 * the dimension to apply, and it takes *every* inked frame below it to abstain. That direction is
 * the one that loses nothing — a two-frame sheet with a contour on frame 0 and none on frame 1 is
 * a sheet whose contour is inconsistent, which is a finding the band table can make and the
 * `outline-gap` row already has a row for — whereas abstaining on a majority would let one
 * good frame of an animated sprite lose the dimension entirely.
 *
 * A frame with no ink (`N === 0`) is not counted either way, for `requiresReadableSubject`'s
 * reason: an empty frame has no contour to declare, and letting one convince the gate would make
 * the answer depend on a hole in the sheet.
 *
 * ## What it costs
 *
 * It runs the full outline measurement for every frame before the analyzer does. That is real and
 * it is stated rather than hidden: `outline` is the only precondition in the pipeline that is not
 * cheap, because the thing it needs to know — *does this document claim a contour* — is a
 * §4.5 measurement and there is no cheaper proxy for it. The alternative, a runtime exclusion
 * inside the analyzer, has the identical cost and strictly worse properties: it would hand back a
 * `QualityDimension`, and there is no `QualityDimension` that means "I decline", so it would have
 * to invent one anyway — most likely as `unmeasured`, which is a **sub-score** absence and would
 * leave the dimension present with a score of 550 and every weight still in the denominator.
 *
 * It is exported, like {@link motionApplicability}, so a caller can ask the question without
 * running the aggregator, and so `quality-corpus.test.ts`'s `expect.preconditions` has something
 * to assert against.
 */
export function outlineApplicability(context: QualityContext): ExcludedReason | null {
  const frames = measureOutline(context);
  let inked = 0;
  let below = 0;
  for (const frame of frames) {
    if (!frame.measured) continue;
    inked++;
    if (frame.outlineShare < OUTLINE_ABSENT_SHARE_Q) below++;
  }
  if (inked === 0) return null;
  return below === inked ? 'no-outline' : null;
}

/**
 * `outline` — worst frame wins, for `noise`'s reason.
 *
 * ## Why the worst frame
 *
 * A contour that holds on seven frames of a walk cycle and is 3px deep on the eighth is a
 * contour that does not hold. `QualityDimension` has one `scoreQ` and no way to say "seven of
 * these are fine", and `FLOOR_FAIL.outline` is a floor on a dimension rather than on an average
 * of dimensions.
 *
 * ## There is no abstention here
 *
 * The `outlineShare < 15/100` case used to be handled here: it returned a neutral 700 and emitted
 * `outline-missing`. It is now {@link outlineApplicability}'s, and neither the 700 nor the code
 * remains. **The analyzer is never called on a document that declares no contour**, so every
 * frame it does see is a frame the document has claimed a contour on — which is why there is no
 * branch for the missing case and why the verdict has no "scored neutral" reading to print.
 *
 * The one frame that can still read below the gate is one frame of a multi-frame document whose
 * other frames are above it, and there the band table speaks: `OUTLINE_FLOOR_Q`, §4.5's own
 * "otherwise" row, with no issue. That is the honest reading of an animation that drops its
 * contour on one frame.
 */
export const outlineAnalyzer: QualityAnalyzer = (context: QualityContext): QualityDimension => {
  const frames = measureOutline(context);
  const measured = frames.filter((frame) => frame.measured);

  if (measured.length === 0) {
    return {
      scoreQ: 1000,
      verdict:
        frames.length === 0
          ? 'nothing to measure: the context carries no frames.'
          : `nothing opaque to measure on any of the ${plural(frames.length, 'frame')}; there is no contour to find.`,
      issues: [],
      unmeasured: {},
    };
  }

  let worst = measured[0];
  for (const frame of measured) if (frame.scoreQ < worst.scoreQ) worst = frame;

  const issues = frames
    .flatMap((frame) => frame.issues)
    .sort(
      (a, b) =>
        b.severity - a.severity ||
        (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
        (a.rect?.y ?? 0) - (b.rect?.y ?? 0) ||
        (a.rect?.x ?? 0) - (b.rect?.x ?? 0),
    );

  const prefix =
    frames.length > 1 ? `worst of ${frames.length} ${plural(frames.length, 'frame')} (frame ${worst.index}): ` : '';

  // No branch for the absent case: the analyzer is not reached on a document that declares no
  // contour, so there is nothing here to say "scored neutral" about. A share below
  // `OUTLINE_ABSENT_SHARE_Q` on a *measured* frame can only be one frame of a sheet whose others
  // are above it, and the band table has already answered for it.
  const parts = [
    `contour on ${worst.outlineShare}/1000 of ${worst.edgePixels} boundary pixels`,
    worst.maxInkDepth < 0
      ? 'no ink measured'
      : `${worst.maxInkDepth + 1}px deep at its thickest`,
    `${worst.inkColours} ink ${plural(worst.inkColours, 'colour')}`,
  ];
  if (worst.inkGaps > 0) parts.push(`${worst.inkGaps} ${plural(worst.inkGaps, 'gap')}`);

  return {
    scoreQ: worst.scoreQ,
    verdict: prefix + parts.join(', ') + '.',
    issues,
    unmeasured: {},
  };
};

export default outlineAnalyzer;