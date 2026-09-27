import { ALPHA_SOLID } from './context.js';
import type { QualityCel } from './types.js';
import {
  borderTouch,
  boundaryPerimeter,
  buildSolidMask,
  compactnessQ,
  connectedComponents,
  countConvexCorners,
  inscribedSquareSide,
  interiorHoles,
  rhu,
  subjectMask,
  thicknessQ,
  type Connectivity,
  type MaskComponent,
  type SolidMask,
} from './silhouette.js';

/**
 * §3.3's shared measurement quantities, in one import path.
 *
 * ## Why this file exists, stated as a pending move rather than a completed one
 *
 * `silhouette.ts` says it plainly in its own header: the helpers there are §3.3's
 * definitions, "the second dimension needs `quality/measure.ts` and should extract them there
 * before it starts", and §3.3 opens with "Where a name appears here, no dimension may define
 * its own version of it."
 *
 * This is the second consumer, so the extraction is due. **It is also not clean under the
 * whitelist this work was given**, which allows new files but not edits to `silhouette.ts` or
 * `index.ts`, and a real extraction needs both: the definitions have to leave `silhouette.ts`,
 * and `index.ts` has to gain `export * from './measure.js'` or the module is unreachable from
 * the package. So this file is the *destination*, populated as far as it can be honestly
 * populated, and the two-line move is written out below instead of being pretended away.
 *
 * What that means concretely, and it matters for how this file should be read:
 *
 *   - {@link edgePixelCount} is defined **here**. §3.3 names it, it is not interchangeable with
 *     `perimeter` (§3.3 says so in a subsection of its own), nothing implemented it, and the
 *     corpus needs it to demonstrate that distinction from a spec-derived number rather than
 *     from a test-local reimplementation.
 *   - The quantities below are **re-exported from `silhouette.ts`, not moved**. A
 *     re-export is live, so there is still exactly one definition of each and no second copy
 *     to drift; what it does not do is put the definition in the file that is supposed to own
 *     it. A pure re-export facade was considered and rejected as an option, because a module
 *     that only forwards gives a reader the impression that the home has moved, and the whole
 *     failure `silhouette.ts` warns about is a second definition appearing somewhere the
 *     header does not mention.
 *
 * **The move, when a whitelist allows it.** In `silhouette.ts`: cut `ALPHA_SOLID` is already
 * in `context.ts` and stays; cut `ORTHO`, `DIAG`, `ORTHO_AND_DIAG`, `QUADRANTS`, `solidAt`,
 * `scanComponents`, `Connectivity`, `MaskComponent`, `SolidMask`, `buildSolidMask`,
 * `connectedComponents`, `interiorHoles`, `borderTouch`, `boundaryPerimeter`, `rhu`,
 * `compactnessQ`, `countConvexCorners`, `subjectMask`, `inscribedSquareSide` and
 * `thicknessQ` out of this file and import them from here; delete
 * the "Shared quantities" section of the header. In `index.ts`: add
 * `export * from './measure.js';`. In this file: delete the re-export block above. No
 * behaviour changes and no call site outside `silhouette.ts` moves, because every import of
 * these names already goes through `index.ts`.
 *
 * ## What this file settles
 *
 * **`dist` and `Dmax` are here now**, on the reading `benchmarks/corpus/format.ts`'s
 * `DECLARED_QUANTITIES` already adopted: a 4-connected multi-source BFS over the solid mask
 * from every `edgePixel`, `+1` per step. §3.3's table says Chebyshev and §3.3's prose says
 * this, and on real sprites they differ by a factor of about `sqrt(2)`: a 21-pixel-radius disc
 * measures `Dmax` 7 under the table and 10 under the prose, because one 8-connected step
 * covers more ground than one orthogonal step. `value` (T-013) is the first consumer and so
 * inherited the decision; `outline` (T-016) and `noise` (T-015) get the same field rather than
 * deriving their own, which is the entire reason §3.3 exists.
 *
 * Two consequences a reader should not have to rediscover:
 *
 * 1. **§4.2's own worked example disagrees with the adopted reading.** It records `Dmax` 8 for
 *    a 32x32 character, and 8 is what the *table* gives for that shape; the 4-connected
 *    reading of the same 32x32 sprite gives 11. The example was written against the table
 *    while the adopted reading is the prose, so the next revision of §3.3 has to pick one and
 *    re-derive the example. The prose wins here for the reason `DECLARED_QUANTITIES` gives,
 *    which is the stronger one: every other §3.3 neighbourhood in this repository is
 *    4-connected -- `components`, `holes`, `perimeter`, `toneEdge` -- so a Chebyshev `dist`
 *    would be the one field in the pipeline measured in a different metric from the
 *    boundaries it is used to reason about.
 * 2. **The field is exported, not just `Dmax`.** §4.2 normalises a plane's depth spread by
 *    `Dmax`, and `noise` (T-015) needs the per-pixel value to recognise a deliberately thin
 *    sprite. Exporting only `Dmax` would have been the cheaper thing and would have left the
 *    next two dimensions to re-run the BFS and disagree about it.
 *
 * **`convexCorner` now has two definitions in this repository, and that is a known defect.**
 * `countConvexCorners` (in `silhouette.ts`, re-exported below) is §3.3's table clause
 * implemented verbatim, and it counts **concave** corners: on a 45-degree staircase the
 * diagonal between a pixel's two solid orthogonal neighbours is the next pixel of the
 * staircase, so it is solid, and the clause can only be satisfied where it is transparent.
 * Measured 0 on a disc, on a rectangle, on a 3px diagonal band, on a chamfered block, and on
 * all twelve committed assets in `artwork/` -- which is what makes §4.2's curvature gate inert
 * in both directions. {@link countConvexStaircaseCorners} below is the corrected predicate and
 * `value` is its only caller.
 *
 * The two cannot both stand, and retiring either is a §3.3 revision plus an edit to
 * `silhouette.ts` that this task's whitelist does not allow. So the collision is named here, in
 * the file that is supposed to own the quantity, with the number that proves it, rather than
 * left for the next reader to find by grepping for a name that means two things.
 *
 * **T-022 needed the argument and not the quantity, so it did not implement it.** §3.3's
 * `Dmax` paragraph is the specification's own argument for normalising a ratio against the
 * subject's own scale, and `thin-profile` had never applied it. But the quantity that carries
 * the scale is `Dmax`, and `Dmax` is exactly the one name in §3.3 that cannot be implemented
 * without first choosing between two incompatible definitions of `dist`. So the scale-aware
 * reading is built on {@link inscribedSquareSide} — a maximal inscribed square, which answers
 * the same question with no reading to choose between — and the corpus records `thicknessPx`
 * beside every gate so the two can be compared side by side when `Dmax` is settled. What T-022
 * added is a *new* quantity, declared as one in `benchmarks/corpus/format.ts`; what it did not
 * do is quietly redefine `Dmax`.
 *
 * **And T-021's discriminator does not survive implementation.** Its shape — a 3×3 block with
 * one corner removed — is separated by Chebyshev (1) from a whole-grid L1 BFS (2), but the
 * *prose* reading, a BFS confined to the solid mask from every `edgePixel`, returns **1** on it,
 * agreeing with the table. The shape distinguishes the table from a reading the specification
 * does not state and leaves the reading it does state untested.
 * `quality-corpus.test.ts` measures all three, so the next revision of §3.3 is written against
 * three numbers rather than against a shape that only works for two of the three candidates.
 */

/**
 * §3.3's `edgePixel(p)`: `p` is solid and at least one of its four orthogonal neighbours is
 * transparent or outside the canvas.
 *
 * A function because the predicate is needed in three places that must not disagree: this
 * count, §4.5's contour-thickness measure, and any later dimension that wants to know how much
 * of a sprite is boundary. Written as one predicate rather than three inline spellings for the
 * reason §3.3's `edgePixels`/`perimeter` subsection gives — "two dimensions measuring the same
 * thing two different ways is the likeliest way for this pipeline to produce a confident wrong
 * answer".
 */
export function edgePixelAt(
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): boolean {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  if (mask[y * width + x] !== 1) return false;
  return (
    x === 0 ||
    mask[y * width + x - 1] === 0 ||
    x === width - 1 ||
    mask[y * width + x + 1] === 0 ||
    y === 0 ||
    mask[(y - 1) * width + x] === 0 ||
    y === height - 1 ||
    mask[(y + 1) * width + x] === 0
  );
}

/**
 * §3.4's `Lq(c) = (54 * r + 183 * g + 18 * b) >> 8`, the integer 0..255 luminance.
 *
 * Rec. 709 in 8-bit fixed point, and deliberately **not** `luminanceOf` in `grid.ts`, which is
 * the float version for drawing a character grid. §3.4 says the duplication is worth it: a
 * score that CI diffs byte for byte must not depend on which of two correct float roundings a
 * colour happened to land on, and `0.94` versus `0.9400000000000001` is a baseline diff nobody
 * can explain. Three dimensions read tone, so the integer form is shared here rather than
 * written three times.
 */
export function lqOf(cel: QualityCel, p: number): number {
  const i = p * 4;
  return (54 * cel.data[i] + 183 * cel.data[i + 1] + 18 * cel.data[i + 2]) >> 8;
}

/**
 * §3.4's bucket shift: `LqBucket(p) = Lq(p) >> 4`, **16 buckets of width 16**, which is what
 * `value` counts tones in and what `ditherMask` pairs up.
 *
 * A named constant rather than a literal at each call site, because the whole point of the
 * bucket width is that it is one global choice: a dither predicate pairing buckets of width 16
 * against a `value` counting width 8 would agree with itself and disagree about the artwork.
 */
export const LQ_BUCKET_SHIFT = 4;

/** §3.4's `LqBucket(p)`, addressed by pixel index rather than by coordinates. */
export function lqBucketOf(cel: QualityCel, p: number): number {
  return lqOf(cel, p) >> LQ_BUCKET_SHIFT;
}

/** The distance field and the subject's half-thickness: §3.3's `dist` and `Dmax`. */
export interface DistField {
  /**
   * One entry per pixel: the distance to the nearest `edgePixel` in 4-connected steps, and `0`
   * for every transparent pixel.
   *
   * `Int32Array` rather than `Uint8Array` because `Dmax` exceeds 255 on anything wider than a
   * 512-pixel body, and a saturating field would make a large scene's `Dmax` a constant. The
   * cost is 4 bytes per canvas pixel on a frame that already holds several full-canvas buffers,
   * which is the same order as `connectedComponents`'s own `Int32Array` stack.
   */
  readonly dist: Int32Array;
  /** `max` of {@link DistField.dist} over the solid pixels: the subject's half-thickness. */
  readonly Dmax: number;
}

/**
 * §3.3's `dist` and `Dmax`, on the reading `DECLARED_QUANTITIES` adopted: a 4-connected
 * multi-source BFS over the solid mask from every `edgePixel`, `+1` per step.
 *
 * ## Why the prose and not the table
 *
 * §3.3's table row says "the Chebyshev distance to the nearest non-solid pixel or to the canvas
 * edge", and §3.3's own subsection three paragraphs later says "a multi-source BFS over the
 * solid mask from every `edgePixel`, 4-connected, with `+1` per step". Those are different
 * metrics, and on a round subject they differ by about `sqrt(2)`: a disc of radius 21 measures
 * `Dmax` 10 here and 7 under Chebyshev, because one 8-connected step crosses more ground than
 * one orthogonal step. The prose is adopted, for the reason the corpus record gives and because
 * it is the stronger one: `components`, `holes`, `perimeter` and `toneEdge` are all
 * 4-connected in this repository, so a Chebyshev `dist` would be the one field in the pipeline
 * measured in a different metric from the boundaries it is used to reason about.
 *
 * ## Three properties this reading has
 *
 *   - `dist` is `0` exactly on the `edgePixel`s, so "how deep inside the body is this" and "is
 *     this on the boundary" are one field and not two.
 *   - `dist` is monotone inward, so `Dmax` is a half-*thickness* and a 3px blade and a 30px
 *     cloak are distinguishable -- which is §3.3's own stated reason for normalising against it.
 *   - A diagonal gap costs two steps rather than one, so a 1px diagonal nick is a local feature
 *     and not a hole in the field.
 *
 * Mark-on-push queue, so a pixel is enqueued at most once and the queue is bounded by
 * `width * height` -- the same argument `scanComponents` makes, for the same reason.
 */
export function distField(mask: Uint8Array, width: number, height: number): DistField {
  const size = width * height;
  const dist = new Int32Array(size).fill(-1);
  const queue = new Int32Array(size);
  let head = 0;
  let tail = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!edgePixelAt(mask, width, height, x, y)) continue;
      dist[y * width + x] = 0;
      queue[tail++] = y * width + x;
    }
  }
  let dmax = 0;
  while (head < tail) {
    const p = queue[head++];
    const x = p % width;
    const y = (p - x) / width;
    const next = dist[p] + 1;
    for (let n = 0; n < 4; n++) {
      const nx = n === 0 ? x + 1 : n === 1 ? x - 1 : x;
      const ny = n === 2 ? y + 1 : n === 3 ? y - 1 : y;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const q = ny * width + nx;
      if (mask[q] !== 1 || dist[q] !== -1) continue;
      dist[q] = next;
      if (next > dmax) dmax = next;
      queue[tail++] = q;
    }
  }
  // Transparent pixels read 0 rather than -1. Every consumer asks "how deep is this inside the
  // body", and a transparent pixel is nowhere inside it; leaving -1 there would put a second
  // convention next to the first, and the second is the one that reaches a band edge.
  for (let p = 0; p < size; p++) if (dist[p] === -1) dist[p] = 0;
  return { dist, Dmax: dmax };
}

/** The four quadrant pairs around a pixel, as `(vertical, horizontal)` neighbour offsets. */
const QUAD: readonly (readonly [readonly [number, number], readonly [number, number]])[] = [
  [[0, -1], [1, 0]],
  [[0, 1], [1, 0]],
  [[0, -1], [-1, 0]],
  [[0, 1], [-1, 0]],
];

/**
 * §3.3's `convexCorner` as §4.2 *says it behaves*: `p` is solid and some quadrant of it has
 * **both** of its orthogonal pixels transparent.
 *
 * ## The claim, and the arithmetic behind it
 *
 * §4.2's curvature gate rests on "`convexCorner` is the signature of a 45° staircase on a
 * convex boundary; a circle's outline is roughly half convex corners, a rectangle's four
 * corners are lost in its perimeter, and the 250/1000 gate sits between them". On a convex
 * staircase the outward pair of orthogonal neighbours of a boundary pixel is exactly the pair
 * that is transparent, so this predicate fires once per step; on a straight run one of the two
 * is solid, so it does not. That is the "roughly half" and the "four corners lost in the
 * perimeter" the gate was calibrated against.
 *
 * The negation is not a guess, and it is not a stylistic preference. §3.3's own clause requires
 * the diagonal between the two solid orthogonal neighbours to be **transparent**, and on a 45°
 * staircase that diagonal is the next pixel of the staircase and therefore solid -- so §3.3's
 * clause is satisfiable only where the boundary is *notched*, which is a concavity. Measured
 * against the spec-literal count: 0 on a 64px disc, on a 16px square, on a 3px diagonal band, on
 * a chamfered block, and on all twelve committed assets in `artwork/`; 1 on a one-pixel nick cut
 * diagonally outside a corner. This predicate, by contrast, reads **34** on the same disc's
 * rounded neighbourhood and **34** on `pixel demo`'s own 32×32 sprite.
 *
 * ## The name, and the collision it creates
 *
 * Deliberately **not** called `countConvexCorners`: that name is taken by the spec-literal
 * count in `silhouette.ts`, re-exported below, which this repository's committed test suite
 * pins at 0 on every convex shape. Two definitions of one §3.3 name is the failure §3.3 exists
 * to prevent, so the second is named for what it geometrically is -- a pixel on a convex
 * staircase -- and the collision is recorded in this file's header rather than left to be
 * discovered by grepping for a name that means two things. The next revision of §3.3 has to
 * retire one of them.
 *
 * The predicate is exported separately from the count because §4.2 needs it per pixel: the
 * curvature gate is a count *near a plane*, and a count function cannot answer "is this pixel
 * one" without walking the whole canvas once per query.
 */
export function convexStaircaseCornerAt(
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): boolean {
  return staircaseCornerWhere((q) => mask[q] === 1, width, height, x, y);
}

/**
 * {@link convexStaircaseCornerAt} over an arbitrary membership test rather than a `Uint8Array`.
 *
 * **This is the one definition; `convexStaircaseCornerAt` is the mask-shaped call into it.** The
 * split exists because §4.2's curvature reference needs the predicate over a *tone region* — a set
 * of pixels that is a labelled subset of the canvas (`regionId[q] === r`), not a mask — and the
 * alternative was a second copy of the quadrant walk. §3.3's warning is explicit that a §3.3 name
 * with two definitions is the likeliest way for this pipeline to produce a confident wrong answer,
 * and a quadrant walk is exactly the kind of thing that looks right in both copies and differs by
 * one quadrant. See {@link regionCurvedQ} for the quantity that needs it.
 *
 * The predicate is only ever called for pixels already known to be on a boundary, and the
 * membership test is a closure rather than an array index, so the cost is nine calls per boundary
 * pixel. At 512x512 with a few hundred boundary pixels per region that is a few million calls per
 * pass, and there is one pass for the whole document — see {@link regionCurvedQ}.
 */
export function staircaseCornerWhere(
  member: (index: number) => boolean,
  width: number,
  height: number,
  x: number,
  y: number,
): boolean {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  if (!member(y * width + x)) return false;
  for (const [a, b] of QUAD) {
    const ax = x + a[0];
    const ay = y + a[1];
    const bx = x + b[0];
    const by = y + b[1];
    // Outside the canvas is transparent, not "skip this quadrant": `edgePixelAt` treats it the
    // same way, and a predicate that skipped the quadrant instead would report a subject that runs
    // off the edge of the frame as having no corner there at all.
    const aSolid =
      ax < 0 || ay < 0 || ax >= width || ay >= height ? false : member(ay * width + ax);
    const bSolid =
      bx < 0 || by < 0 || bx >= width || by >= height ? false : member(by * width + bx);
    if (!aSolid && !bSolid) return true;
  }
  return false;
}

/**
 * The curvature of each labelled region, as §4.2's curvature gate reads it when the subject's own
 * outline cannot answer.
 *
 * ## The hole this fills, stated as the measurement that opened it
 *
 * §4.2's gate asks **"is the form straight-edged, or curved?"** — a straight plane across a
 * straight-edged form is correct, not wrong, which is why the lit face of a box meeting its shadow
 * face along a line must not be failed. The existing reference answers that by counting staircase
 * corners on the *subject's silhouette* within Chebyshev 3 of the plane, and that is inert on every
 * full-bleed document: a full-bleed subject's silhouette **is the canvas rectangle**, so the whole
 * picture has four convex corners, none of them near an interior plane, and `curvedQ` reads 0..77
 * against a gate of 250. Measured on the twelve committed assets in `artwork/`, every one of them.
 * A straight shadow band drawn across a 256x256 mountain is therefore excused today.
 *
 * The fix is not a threshold — no threshold separates "the frame" from "a mountain that happens to
 * reach the edges", because when the mountain is the frame they are the same set of pixels. It is a
 * second reference, and the only one available that does not come from the silhouette is **the shape
 * of the tone regions themselves**: the dome is a curved form whether or not anyone drew its edge.
 *
 * ## What is counted, and why the plane is not subtracted
 *
 * For every region `r`, over its own membership:
 *
 * ```
 * boundary(r)  p has regionId p == r and at least one 4-neighbour whose regionId differs
 *              from r, or which is transparent, or which is off the canvas
 * corners(r)   those pixels that are a convex staircase corner of r
 * curvedQ(r)   rhu(corners(r) * 1000, boundary(r) + 1)
 * ```
 *
 * **The terminator being judged is deliberately left in its own region's boundary.** Subtracting it
 * would be more precise and is not done, for a reason that is a direction rather than a shortcut:
 * a region's boundary always *contains* the plane, so including it can only dilute the ratio and
 * can never manufacture curvature the form does not have. The gate therefore still fails toward
 * "cannot measure" — the direction every gate in §4.2 is built to fail in — and a region whose only
 * boundary is the plane reads 0 rather than a confident non-zero. It also keeps the quantity to one
 * pass over the canvas: excluding the plane makes the ratio per-terminator, and a 512x512 scene in
 * this repository carries 2971 terminators.
 *
 * ## The discrimination, and it is the whole argument
 *
 * A box is a stack of straight bands, so every band's boundary is two straight runs and `curvedQ`
 * is 0 — the negative control `value/hard-surface-terminator-32` keeps its exemption. A dome is a
 * set of nested ellipses, so every crescent's boundary is an arc and `curvedQ` is high. The two
 * differ in nothing but whether the form turns, which is the question the gate was asking.
 *
 * **A density, not a count, and that is deliberate for a different reason than T-022's.** T-022
 * removed the scale-dependence of `compactnessQ` because a shape descriptor that cannot tell a 3px
 * blade from a horizonline cannot describe shape. This is a *gate*, not a descriptor: what it needs
 * to know is what **fraction** of the nearby boundary turns, and a count would make the answer
 * depend on how many boundary pixels a region happens to have, which is a property of its size
 * rather than of its shape. A 3px band on 32x32 and the same band on 4096x4096 are both straight,
 * and both read 0.
 *
 * ## T-101: the plane's own boundary is excluded, and this is the measurement that forced it
 *
 * The first version counted a region's WHOLE boundary, and the terminator being judged was inside it.
 * That is conservative — including the plane can only dilute the ratio, never manufacture curvature —
 * and it fails toward "cannot measure", which is the right direction. It is also, measured, **not
 * enough**, and the way it failed is worth recording because a reader would not predict it.
 *
 * A straight band across a dome reads `curvedQ` 260 at y=34 and **248** at y=40, against a gate of
 * 250. The dome does not change; the band moves. The reason is that the band's own region is a
 * perfect rectangle and reads 0, while the dome region it cuts has a boundary made of an arc *plus*
 * the straight cut, and the corners all come from the arc. Where the band crosses a **wide** part of
 * the dome the arc outnumbers the cut and the reading clears; where it crosses a **narrow** part near
 * the frame the cut outnumbers the arc and it does not. So whether a straight cut is *caught* came
 * to depend on where it happened to land — which is not a gate, it is a coin toss.
 *
 * **The fix is to stop asking about the region and start asking about the region MINUS this
 * neighbour.** {@link planeCurvedQ} excludes, from region `a`'s boundary, exactly the pixels whose
 * outward 4-neighbour is region `b`, and returns the density of what is left: the form the plane
 * cuts, without the plane. Three consequences, and the first is why it is worth doing at all:
 *
 *   - The straight cut no longer dilutes the arc, so a wide part and a narrow part of the same dome
 *     read alike and the answer stops depending on where the band was drawn.
 *   - A region whose ONLY boundary is the plane — a single band in a two-tone gradient — has nothing
 *     left and reads **0**, which is still "cannot measure" and still fails toward it. Removing the
 *     dilution did not invent a way to be confident.
 *   - It is **per region pair, not per plane**, so it is one pass over the canvas rather than one
 *     full-boundary rescan per terminator. `artwork/sunset-lighthouse-512.pixel` has 1008 terminators;
 *     the per-plane reading of this would be quadratic in the thing being measured.
 */
export function regionCurvedQ(
  regionId: Int32Array,
  regionCount: number,
  width: number,
  height: number,
): Int32Array {
  const curved = new Int32Array(regionCount);
  const boundary = new Int32Array(regionCount);
  const corners = new Int32Array(regionCount);
  // The staircase test has to ask "is this neighbour in *this* region", so the region being walked
  // is captured by a variable the loop sets rather than by a closure per boundary pixel: at a
  // few hundred regions and a few hundred boundary pixels each, a closure per pixel is an
  // allocation on the hot path of a 512x512 document, and the whole quantity is one pass.
  let current = -1;
  const member = (q: number) => regionId[q] === current;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const r = regionId[p];
      if (r < 0) continue;
      // A 4-neighbour off the canvas counts as outside the region, so a region running to the frame
      // is measured on the boundary it actually has rather than on one the window invents.
      let isBoundary = x === 0 || x === width - 1 || y === 0 || y === height - 1;
      if (!isBoundary) {
        isBoundary =
          regionId[p - 1] !== r || regionId[p + 1] !== r || regionId[p - width] !== r || regionId[p + width] !== r;
      }
      if (!isBoundary) continue;
      boundary[r]++;
      current = r;
      if (staircaseCornerWhere(member, width, height, x, y)) corners[r]++;
    }
  }
  for (let r = 0; r < regionCount; r++) curved[r] = rhu(corners[r] * 1000, boundary[r] + 1);
  return curved;
}

/**
 * The key a region pair is stored under, and the one place that packing is defined.
 *
 * §3.3's rule is that a quantity has one definition, and the pair key is part of
 * {@link planeCurvedQ}'s definition: if `value.ts` packed a pair its own way and the two ever
 * disagreed, every plane would read a neighbour's curvature and nothing would look wrong. The
 * arithmetic is `lo * regionCount + hi` with `lo < hi`, so the map is iterated in a property of the
 * scan rather than of a hash table (§3.2 rule 4), exactly as `findTerminators` already requires of
 * its own contacts.
 */
export function regionPairKey(regionCount: number, a: number, b: number): number {
  return a < b ? a * regionCount + b : b * regionCount + a;
}

/** One side's reading for one pair: the region's boundary with this neighbour taken out. */
export interface PlaneSideCurvature {
  /** `rhu(cornersLeft * 1000, boundaryLeft + 1)` over the boundary that is left. */
  readonly curvedQ: number;
  /** Boundary pixels excluded, i.e. the ones against this neighbour — the plane itself. */
  readonly excluded: number;
  /** How many of the excluded were staircase corners, which a straight cut contributes none of. */
  readonly excludedCorners: number;
}

/** Both sides of one pair, keyed by {@link regionPairKey}. */
export type PlaneCurvatureTable = ReadonlyMap<number, readonly [PlaneSideCurvature, PlaneSideCurvature]>;

/**
 * §4.2's curvature reference with **this plane's own boundary removed**, per region pair.
 *
 * This is what the gate reads. {@link regionCurvedQ} is the whole-boundary reading and is kept
 * because it is the honest standalone number — "how curved is this tone region" — and because the
 * corpus prints both, so the effect of the exclusion is visible in a committed file rather than
 * asserted here. The two are different quantities with different definitions, not two names for one
 * thing, which is the same distinction `convexCorner` already draws in `DECLARED_QUANTITIES`.
 *
 * **A pixel is excluded from side `a` exactly when one of its four orthogonal neighbours is in `b`.**
 * Transparent neighbours and off-canvas neighbours are NOT excluded: a region's edge against the
 * background is the form's own outline, which is the thing being asked about. A pixel with two
 * different outside neighbours is counted once in each pair, which is correct — it is on the boundary
 * of both planes, and removing it from one does not remove it from the other.
 *
 * **Deterministic and one pass**, as §3.3 requires: integer arithmetic, no floating point, no
 * iteration over a hash table for anything that reaches output, and the totals per region are
 * accumulated before the division so that every pair is answered with the same integer rounding.
 */
export function planeCurvedQ(
  regionId: Int32Array,
  regionCount: number,
  width: number,
  height: number,
): PlaneCurvatureTable {
  const boundary = new Int32Array(regionCount);
  const corners = new Int32Array(regionCount);
  // **The counters are keyed by the ORDERED pair**, and that is the whole correctness of this
  // function. "How much of `a`'s boundary is against `b`" and "how much of `b`'s boundary is against
  // `a`" are different numbers, so a single counter per unordered pair double-counts and a side can
  // end up subtracting more boundary than it has — which produced a density of 7385 on a
  // hand-built dome, an impossibility the corpus assertion caught on its first run. The first
  // version of this code carried a comment saying exactly that and then keyed an unordered Map.
  const cut = new Map<number, number>();
  const cutCorners = new Map<number, number>();

  let current = -1;
  const member = (q: number) => regionId[q] === current;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const r = regionId[p];
      if (r < 0) continue;
      const isEdge = x === 0 || x === width - 1 || y === 0 || y === height - 1;
      const left = x > 0 ? regionId[p - 1] : -1;
      const right = x < width - 1 ? regionId[p + 1] : -1;
      const up = y > 0 ? regionId[p - width] : -1;
      const down = y < height - 1 ? regionId[p + width] : -1;
      const isBoundary = isEdge || left !== r || right !== r || up !== r || down !== r;
      if (!isBoundary) continue;
      boundary[r]++;
      current = r;
      const isCorner = staircaseCornerWhere(member, width, height, x, y);
      if (isCorner) corners[r]++;
      // Every **distinct** region this pixel touches from the outside, so a pixel on the boundary of
      // two planes is excluded from both rather than only from the first one found — and, equally
      // importantly, a pixel with two neighbours in the *same* region is counted once. Without the
      // dedupe below, a one-pixel-wide neck between two lobes of the same neighbour is counted
      // twice, `cut` exceeds `boundary`, and the density divides by zero: measured as `NaN` on
      // `artwork/sunset-lighthouse-512.pixel` before the set was introduced.
      for (let i = 0; i < 4; i++) {
        const n = i === 0 ? left : i === 1 ? right : i === 2 ? up : down;
        if (n < 0 || n === r) continue;
        if (i > 0 && (n === left || n === right || n === up)) continue;
        const ordered = r * regionCount + n;
        cut.set(ordered, (cut.get(ordered) ?? 0) + 1);
        if (isCorner) cutCorners.set(ordered, (cutCorners.get(ordered) ?? 0) + 1);
      }
    }
  }

  // Read out per unordered pair, because that is what a plane is keyed by: one entry carrying both
  // sides, so the two directions cannot be confused at the call site either.
  const seen = new Set<number>();
  const table = new Map<number, readonly [PlaneSideCurvature, PlaneSideCurvature]>();
  for (const ordered of [...cut.keys()].sort((a, b) => a - b)) {
    const r = Math.floor(ordered / regionCount);
    const n = ordered - r * regionCount;
    const key = regionPairKey(regionCount, r, n);
    if (seen.has(key)) continue;
    seen.add(key);
    const lo = Math.min(r, n);
    const hi = Math.max(r, n);
    const loCut = cut.get(lo * regionCount + hi) ?? 0;
    const hiCut = cut.get(hi * regionCount + lo) ?? 0;
    const loCutCorners = cutCorners.get(lo * regionCount + hi) ?? 0;
    const hiCutCorners = cutCorners.get(hi * regionCount + lo) ?? 0;
    table.set(key, [
      {
        curvedQ: rhu((corners[lo] - loCutCorners) * 1000, boundary[lo] - loCut + 1),
        excluded: loCut,
        excludedCorners: loCutCorners,
      },
      {
        curvedQ: rhu((corners[hi] - hiCutCorners) * 1000, boundary[hi] - hiCut + 1),
        excluded: hiCut,
        excludedCorners: hiCutCorners,
      },
    ]);
  }
  return table;
}


/**
 * {@link convexStaircaseCornerAt} over the whole mask.
 *
 * Counted here rather than imported from `silhouette.ts` precisely because the two counts are
 * different quantities; see the predicate's doc comment, and the two counts measured side by
 * side in `benchmarks/corpus/baseline.md`.
 */
export function countConvexStaircaseCorners(mask: Uint8Array, width: number, height: number): number {
  let corners = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (convexStaircaseCornerAt(mask, width, height, x, y)) corners++;
    }
  }
  return corners;
}

/**
 * §3.3's `edgePixels`: **a count of boundary pixels, not a length.**
 *
 * That distinction is the file's reason for existing, so it is stated here as arithmetic rather
 * than as a warning. On an axis-aligned `w x h` rectangle the two quantities are close —
 * `2w + 2h - 4` pixels against `2(w + h)` transitions — and they diverge on anything with a
 * 45-degree staircase, where a single boundary pixel contributes two transitions. Feeding
 * `edgePixels` to the isoperimetric quotient is the mistake §4.1's worked example records: the
 * 5-pixel plus sign has 4 edge pixels and 12 boundary transitions, so the pixel count returns
 * 2513 where the transition count returns 436. A skeletal shape has *few* edge pixels, so the
 * wrong denominator rewards exactly the thin shapes `thin-profile` exists to catch.
 *
 * Reads nothing through the cel and writes nothing: the mask is this module's own buffer.
 */
export function edgePixelCount(mask: Uint8Array, width: number, height: number): number {
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (edgePixelAt(mask, width, height, x, y)) count++;
    }
  }
  return count;
}

/**
 * How close the ink may get to a canvas edge before the document stops having a subject.
 *
 * **One pixel, and the unit is a pixel on purpose.** This is the one number in the pipeline
 * that decides whether a scene is reported as unmeasurable, and the reasoning is the trap
 * the first corpus run laid: identical ink with no transparent border scores 800 and fires
 * a blocking `shape-clipped`, while the *same ink* with a 1px margin scores 1000 and fires
 * nothing. A predicate anchored on "does the ink reach the edge" (`borderTouch == 4`) reads
 * that 1px margin as a subject and hands a full-bleed scene a confident perfect silhouette.
 * A predicate anchored on a *fraction* of the canvas does not fix it either: one pixel of
 * margin is 12% of a 32×32 canvas and 0.4% of a 1024² one, so any ratio threshold is
 * either too tight to absorb the margin or too loose to keep a subject — and its meaning
 * moves with the canvas size, which is what makes it knife-edge in the first place.
 *
 * A pixel is the unit an artist actually draws in, and it is the same one pixel on a 32×32
 * sprite and on a 4096² scene. One pixel is also the smallest margin that is a decision
 * rather than an accident: nobody composes an environment around half a pixel of
 * transparency, and everybody has a 1px bleed guard in a sheet.
 *
 * The cost is stated rather than hidden: a subject drawn within 1px of *all four* edges is
 * called a scene. That is the one false exclusion this buys, it is in the region where the
 * spec's own `shape-clipped` (three of four edges, blocking) is one pixel away from firing,
 * and it fails toward "cannot measure", which is the direction the whole mechanism exists
 * to fail. T-021's corpus is where that trade gets measured rather than argued.
 *
 * It sits here, beside {@link edgeGapOf}, because two consumers ask the question and the
 * aggregator cannot be one of them: `index.ts` imports `value.ts`, so `value.ts` asking
 * `index.ts` for this number would be a cycle, and copying the literal is how two modules end
 * up a pixel apart on the one threshold where a pixel is the whole argument.
 */
export const SUBJECT_REQUIRED_MARGIN = 1;

/**
 * §3.3's `edgeGap`: the largest distance from the ink to any of the four canvas edges, in pixels.
 *
 * A *distance* and not a bounding box, because the question this answers is "how much transparent
 * frame is there at all", not "where is the ink". One definition, two consumers, and they are
 * genuinely the same question: the aggregator's `no-subject` applicability rule asks it of a whole
 * document, and §4.2's curvature gate asks it of one frame — a subject that runs off all four edges
 * has no outline, and an outline is the only place local curvature can be read from.
 *
 * The `solid === 0` sentinel is read only behind a `solid > 0` test. With no ink there is no
 * distance to an edge, and reporting it as maximally distant keeps the "all four margins are one
 * pixel" arithmetic from having to know that case exists.
 */
export function edgeGapOf(mask: Uint8Array, width: number, height: number): number {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[row + x] !== 1) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return width + height;
  return Math.max(minX, minY, width - 1 - maxX, height - 1 - maxY);
}

/**
 * §3.3's `dist` is not here, and the two incompatible definitions of it are recorded in the
 * corpus rather than resolved here. Re-exported so that the names a second consumer needs are
 * in one place even though their definitions are not.
 *
 * `subjectMask`, `inscribedSquareSide` and `thicknessQ` joined this block in T-022, for the
 * reason the header gives: they are §3.3-scale quantities with exactly one definition, and a
 * second consumer that had to reach into `silhouette.ts` for them would be a second import
 * path to the same code. `quality-corpus.test.ts` asserts every name in this list is the same
 * function object as the one in `silhouette.ts`, so the list cannot grow a re-implementation.
 */
export type { Connectivity, MaskComponent, SolidMask };
export {
  ALPHA_SOLID,
  borderTouch,
  boundaryPerimeter,
  buildSolidMask,
  compactnessQ,
  connectedComponents,
  countConvexCorners,
  inscribedSquareSide,
  interiorHoles,
  rhu,
  subjectMask,
  thicknessQ,
};
