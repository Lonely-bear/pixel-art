import type { Rect } from '../types.js';
import { ALPHA_SOLID } from './context.js';
import type { QualityAnalyzer, QualityCel, QualityContext, QualityDimension, QualityIssue } from './types.js';

/**
 * The `silhouette` dimension — does the shape read?
 *
 * Scored from the subject's geometry alone: one dominant mass, no holes punched in the
 * wrong places, nothing floating beside it, compact enough to be a form rather than a
 * smear, and presented on the canvas with room to read. It is the heaviest-weighted
 * dimension (300) and the only one that survives every downscale the game will apply,
 * because colour and detail are the first things a downscale throws away.
 *
 * ## What is measured, and on what
 *
 * Everything is measured on the **whole-canvas** solid mask (`alpha >= ALPHA_SOLID`).
 * `context.focus` does not crop it, and that is a decision rather than an omission. §3.3
 * says its quantities are "restricted to `focus` when it is set", but for this dimension a
 * crop is not a smaller measurement, it is a different and wrong one:
 *
 *   - Cropping the mask to a box hands the box's own border to the shape, so
 *     `borderTouch` would report the *focus rectangle* as a clipped sprite. Every box
 *     touches four sides, so every focused evaluation would claim `shape-clipped`.
 *   - A mask cut along a straight line gains a straight edge, and the flood fill then
 *     finds a "hole" against that cut wherever the box boundary runs near the shape.
 *
 * So `focus` decides which defects you are *told about* — an issue is emitted only when
 * its own rect intersects the focus rect — and the numbers are the same either way. A box
 * drawn around a character's head changes which problems are in front of you; it cannot
 * change whether the character is clipped.
 *
 * ## Two connectivity decisions, both of which a future maintainer will get wrong
 *
 * **The subject is 4-connected, the background is 8-connected, and that asymmetry is not
 * a typo.** §3.3 fixes `components` at 4-connectivity and gives the reason: a shape whose
 * parts touch only at a corner falls in half at 0.5× scale, under a filter, or on a CRT,
 * and `diagonal-seam` (§4.4) names the same defect from the noise side. Holes use the
 * mirror image — background 8-connected, holes 4-connected — because that is the pairing
 * for which a one-pixel diagonal gap is a route to the outside rather than a sealed
 * pocket. Any other pairing reports holes that do not exist.
 *
 * 4-connectivity is also why {@link connectedComponents} takes the mode as an argument
 * even though every call site here passes 4. A 1px *contour* traced around a curve is
 * 8-connected and 4-disconnected along every step of its own staircase, so `outline`
 * (T-016) cannot use this quantity and must count contour pixels instead. Putting the two
 * on one code path is how `outline` inherits a 30% penalty for having been drawn.
 *
 * ## Shared quantities
 *
 * The helpers below are §3.3's definitions, exported so that they have one home rather
 * than one per dimension. They live in this file only because the whitelist for this
 * dimension allows no third file; **the second dimension needs `quality/measure.ts` and
 * should extract them there before it starts.** §3.3: "Where a name appears here, no
 * dimension may define its own version of it." `measure.ts` now re-exports every name in
 * this section, so the second consumer has one import path even though the definitions
 * have not moved.
 *
 * ## Two quantities, because "is it a good shape" and "will it read" are two questions
 *
 * `compactnessQ` is the isoperimetric quotient, and it is **scale-invariant on purpose**.
 * A 32×32 square and a 1024×1024 square are the same shape; a 30×1 blade and a 900×30
 * blade are the same shape. Any measurement that separated them would be measuring the
 * canvas, not the drawing, and calling that a *shape* descriptor would be the kind of
 * conflation §3.3's whole table exists to prevent.
 *
 * What the quotient genuinely cannot see is the sprite's own size, and §3.3 already says
 * so: "`Dmax` doubles as the sprite's own scale, and it is why several ratios below are
 * normalised against it rather than against a constant: a 3px-wide blade and a 30px-wide
 * cloak do not have the same room to put a curved terminator in." §4.1 never applied that
 * argument, so `thin-profile` could not tell a knife from a horizon: a 3px band across a
 * 1024² canvas and a 3px band across a 32² canvas differ in the one property that matters
 * and scored alike on everything the quotient reads.
 *
 * So the scale-aware reading is a **second** quantity, {@link thicknessQ}, and the two are
 * reported side by side rather than merged. Merging them is the tempting move and it is
 * the wrong one: a single number that is partly a shape descriptor and partly a scale
 * reading is a number whose meaning depends on which of the two the reader had in mind,
 * which is a worse failure than reporting two.
 */

/** Neighbour offsets, orthogonal only. §3.3's `n4`. */
const ORTHO: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Diagonal offsets, so that `n8` is `n4` plus these. */
const DIAG: readonly (readonly [number, number])[] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * Precomputed rather than spread at the call site: `[...ORTHO, ...DIAG]` inside a flood
 * loop allocates once per pixel, and at 4096² that is 16 million short-lived arrays.
 */
const ORTHO_AND_DIAG: readonly (readonly [number, number])[] = [...ORTHO, ...DIAG];

/**
 * The four adjacent (orthogonal, orthogonal) pairs, each listed **once**.
 *
 * Enumerating "the two solid neighbours" as an ordered pair visits `{N,E}` and `{E,N}`
 * separately and counts every concave corner twice, which is the difference between a
 * corner density and twice a corner density.
 */
const QUADRANTS: readonly (readonly [readonly [number, number], readonly [number, number]])[] = [
  [[0, -1], [1, 0]],
  [[1, 0], [0, 1]],
  [[0, 1], [-1, 0]],
  [[-1, 0], [0, -1]],
];

/** Which neighbours a flood fill may cross. `4` and `8` are the only two there are. */
export type Connectivity = 4 | 8;

/** One flood-filled region: how many pixels, and where they are. */
export interface MaskComponent {
  /** Pixel count. */
  readonly area: number;
  /** Tight bounding box, in absolute canvas coordinates. */
  readonly bounds: Rect;
  /**
   * Canvas index of the region's first pixel in row-major scan order.
   *
   * Carried because "which pixel starts this region" is the ordering {@link connectedComponents}
   * already promises, and because {@link subjectMask} needs a seed to flood from and
   * `bounds` cannot supply one: another component can start earlier inside the same box.
   */
  readonly seed: number;
}

/**
 * The solid mask plus the two counts only the mask builder can see.
 *
 * `partialAlpha` is reported rather than scored: §3.1 says pixels at
 * `1 <= alpha < ALPHA_SOLID` are "named in the verdict text of whichever dimension looked
 * at them", and this is the dimension that looks at them. They are never in `N`, which is
 * what makes a 0.2-alpha glow a design decision rather than a body part.
 */
export interface SolidMask {
  /** One byte per pixel, 1 where `alpha >= ALPHA_SOLID`. */
  readonly mask: Uint8Array;
  /** `N` in §3.3: the solid pixel count. */
  readonly solid: number;
  /** Pixels with `1 <= alpha < ALPHA_SOLID`. Counted, never scored. */
  readonly partialAlpha: number;
}

/**
 * Build the solid mask. Reads `cel.data` and writes nothing through it: the contract's one
 * writable seam is not touched, and the mask it returns is this analyzer's own buffer.
 */
export function buildSolidMask(cel: QualityCel, width: number, height: number): SolidMask {
  const mask = new Uint8Array(width * height);
  const data = cel.data;
  let solid = 0;
  let partialAlpha = 0;
  for (let p = 0; p < mask.length; p++) {
    const alpha = data[p * 4 + 3];
    if (alpha >= ALPHA_SOLID) {
      mask[p] = 1;
      solid++;
    } else if (alpha > 0) {
      partialAlpha++;
    }
  }
  return { mask, solid, partialAlpha };
}

/**
 * Components of `mask`, largest-agnostic, in row-major order of each region's first pixel.
 *
 * The `connectivity` argument is a parameter rather than a constant because the two uses
 * disagree on purpose and the disagreement is the whole point — see the file header. Every
 * call in this dimension passes 4 for the subject; reaching for 8 on the subject makes
 * §4.1's `detached-pieces` untriggerable, and the test suite pins that.
 *
 * Row-major first-pixel order means the ordering is a property of the scan rather than of
 * the allocator, which spec §3.2 rule 4 requires of anything whose order can reach output.
 */
export function connectedComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  connectivity: Connectivity = 4,
): MaskComponent[] {
  return scanComponents(mask, width, height, connectivity === 4 ? ORTHO : ORTHO_AND_DIAG);
}

/**
 * Holes: transparent regions that do not reach the canvas border.
 *
 * The background is flood-filled with **8-connectivity** from the border, so a diagonal
 * chain of transparent pixels is a route to the outside and not a sealed pocket. What is
 * left over is grouped with **4-connectivity**.
 *
 * Expressed as "label all the transparent components, then keep the ones that do not touch
 * an edge" rather than as two nested flood passes. A connected component of a pixel set
 * touches an edge exactly when its bounding box does, so the filter is exact, and the
 * version that seeded a border flood and then re-labelled the remainder needs two visited
 * arrays whose interaction is the kind of thing that is wrong in a way a test reading
 * `interiorHoles` cannot see.
 */
export function interiorHoles(mask: Uint8Array, width: number, height: number): MaskComponent[] {
  const transparent = new Uint8Array(mask.length);
  for (let p = 0; p < mask.length; p++) transparent[p] = mask[p] === 0 ? 1 : 0;
  return scanComponents(transparent, width, height, ORTHO_AND_DIAG).filter(
    (component) =>
      component.bounds.x > 0 &&
      component.bounds.y > 0 &&
      component.bounds.x + component.bounds.w < width &&
      component.bounds.y + component.bounds.h < height,
  );
}

/**
 * How many of the four canvas sides the solid mask reaches, 0..4.
 *
 * A side is reached by a single pixel. `borderTouch >= 3` is `shape-clipped` at blocking
 * severity, so a 1×1 sprite measures 4 and is reported as fully clipped. That is the
 * spec's rule applied literally, and it is why the threshold is 3 and not 4: running off
 * one edge is a composition choice, running off three is a crop.
 */
export function borderTouch(mask: Uint8Array, width: number, height: number): number {
  let left = 0;
  let right = 0;
  let top = 0;
  let bottom = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    if (mask[row] === 1) left = 1;
    if (mask[row + width - 1] === 1) right = 1;
  }
  for (let x = 0; x < width; x++) {
    if (mask[x] === 1) top = 1;
    if (mask[(height - 1) * width + x] === 1) bottom = 1;
  }
  return left + right + top + bottom;
}

/**
 * The boundary length of the pixel set: one per solid/transparent 4-adjacent **pair**.
 *
 * A length, not a count of pixels, and §3.3 explains why at length — an outline covers
 * pixels so it wants a pixel count, a shape's compactness wants the perimeter of the union
 * of unit squares, and with this denominator the isoperimetric quotient is bounded above
 * by 1 by construction. Outside the canvas counts as transparent, because a solid pixel
 * on the canvas edge really does have boundary there and the bound only holds if it is
 * counted.
 */
export function boundaryPerimeter(mask: Uint8Array, width: number, height: number): number {
  let perimeter = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[row + x] !== 1) continue;
      if (x === 0 || mask[row + x - 1] === 0) perimeter++;
      if (x === width - 1 || mask[row + x + 1] === 0) perimeter++;
      if (y === 0 || mask[row - width + x] === 0) perimeter++;
      if (y === height - 1 || mask[row + width + x] === 0) perimeter++;
    }
  }
  return perimeter;
}

/**
 * Round-half-up integer division, `rhu(a, b) = floor((a + b/2) / b)`.
 *
 * The whole pipeline measures ratios in integer form so that no threshold is ever a float
 * comparison; this is its only division. It is not a general `roundedDivide` — the caller
 * owns a positive `b`, and the one place that could divide by zero ({@link compactnessQ},
 * {@link thicknessQ}) guards explicitly.
 */
export function rhu(a: number, b: number): number {
  return Math.floor((a + b / 2) / b);
}

/**
 * The isoperimetric quotient `4πN / P²`, per-mille, with π as 355/113.
 *
 * A disc scores 1000 and a long thin smear scores near 0, which is the property §4.1
 * wants. `min(1000, …)` is the belt-and-braces §3.7 documents rather than a load-bearing
 * clamp.
 *
 * Both products stay exact below 2^53 for any perimeter under about 8.9 million, and a
 * perimeter that large forces the true quotient below 1/1000 — from `N >= P/4` and
 * `P > 8.9e6`, `Q < 3142/P < 0.4` — so the only consumer of this number, the `< 300` test,
 * cannot be decided differently by a last-bit difference even in the case where the
 * arithmetic would stop being exact.
 *
 * ## What `solid` and `perimeter` are measured over
 *
 * **Over the subject — the largest 4-connected component — and not over the whole mask.**
 * This is the second of the two measurement defects T-021 measured against 52 subject
 * frames, and it is the one that was unambiguously a bug rather than a policy question:
 * three separate masses have three perimeters, so a sprite whose *body* is a perfect square
 * was charged `-100` of `thin-profile` for the fragments floating beside it. `defect/three-masses-20`
 * measured 259 on a whole-mask basis where its own body alone is 785, and `silhouette` is the
 * only dimension in the pipeline that could see it, because `detached-pieces` and
 * `fragmented-silhouette` name the strays and this one did not.
 *
 * Masking to the subject is not a subtlety: a 4-connected component has no 4-adjacent pixel
 * outside itself, so the subject's boundary is the same length whether "not in the subject"
 * is read as transparent or as another component, and holes inside the subject still count.
 *
 * The two fragmenting codes are what own fragmentation, and they still do. `detached-pieces`
 * prices the strays, `fragmented-silhouette` fires when no mass dominates, and `compactnessQ`
 * now says only whether the largest mass is a form. Three comparable masses score 250 − 150
 * − 150 = 0, which is the §4.1 "2 — two masses of comparable size" reading, and it is reached
 * without a second code punishing the same fact.
 */
export function compactnessQ(solid: number, perimeter: number): number {
  if (perimeter <= 0) return 0;
  return Math.min(1000, rhu(4 * 355 * 1000 * solid, 113 * perimeter * perimeter));
}

/**
 * The subject alone, as a mask of its own: 1 on the largest 4-connected component, 0
 * everywhere else.
 *
 * The one function here that allocates a second full-canvas buffer, and it allocates it
 * deliberately rather than threading a component label through the perimeter and the
 * inscribed-square pass. A label array costs the same memory and has to stay resident while
 * both passes run, so the flood-then-measure arrangement is strictly cheaper: the flood's
 * own `seen`/`stack` are function-local and gone before `boundaryPerimeter` and
 * {@link inscribedSquareSide} are called. Peak working set is `2 bytes/pixel` held across
 * those two calls and `6` inside the flood, which is the flood's cost either way.
 *
 * `component` is the region to isolate, so the caller chooses which one is the subject and
 * this function has no opinion about it. `component.seed` rather than `component.bounds`,
 * because two components can share a bounding box and the earlier one in scan order is not
 * necessarily the one asked for.
 */
export function subjectMask(
  mask: Uint8Array,
  width: number,
  height: number,
  component: MaskComponent,
): Uint8Array {
  const out = new Uint8Array(mask.length);
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  seen[component.seed] = 1;
  stack[0] = component.seed;
  let depth = 1;
  while (depth > 0) {
    const p = stack[--depth];
    out[p] = 1;
    const x = p % width;
    const y = (p - x) / width;
    for (const [dx, dy] of ORTHO) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const q = ny * width + nx;
      if (mask[q] !== 1 || seen[q] === 1) continue;
      seen[q] = 1;
      stack[depth++] = q;
    }
  }
  return out;
}

/**
 * Side of the largest axis-aligned square of solid pixels, in pixels.
 *
 * ## Why an inscribed square and not `Dmax`
 *
 * §3.3 nominates `Dmax` for exactly this role — "`Dmax` doubles as the sprite's own scale …
 * a 3px-wide blade and a 30px-wide cloak do not have the same room to put a curved terminator
 * in" — and `Dmax` **is not implemented**, because §3.3 defines it twice incompatibly (the
 * table says Chebyshev, the prose says a 4-connected BFS) and `benchmarks/corpus/format.ts`
 * records that as an open conflict with no owner until `value` lands.
 *
 * So this is the same argument answered by the one method that has no reading to choose
 * between. A maximal inscribed square is a pure pixel count: the standard rolling-row
 * recurrence `d = 1 + min(above, left, aboveLeft)`, integer throughout, `O(bounds.w)`
 * memory and one pass, and every rasterisation of it returns the same integer. The
 * distribution it produces is on the record as `thicknessPx` beside every gate, so the day
 * `Dmax` is settled the PO can compare the two columns and swap this function for it without
 * re-deciding the gate.
 *
 * ## What it is and is not sensitive to
 *
 * A **max**, like `Dmax`, so it describes the shape's *deepest* part and is blind to a
 * slender limb: a 20×20 body with a 1px antenna beside it measures 20. That is the right
 * blindness for §3.3's argument, which is about where a shape has room for a terminator, and
 * a thin appendage is `noise`'s and `outline`'s business rather than this dimension's. It is
 * a **max** rather than a *minimum* thickness because a minimum would fire on every drawn
 * outline and every 1px accent, and an analyzer that fires on clean work is worse than one
 * that misses a defect.
 *
 * On a rectangle it is the short side; on a disc it is the largest inscribed square rather
 * than the diameter, so it understates a round shape by about 30%. That is a known,
 * deliberate, and now *visible* bias — `thicknessQ` is reported next to `compactnessQ`, and
 * a disc is the one shape where the two disagree about how roomy it is.
 */
export function inscribedSquareSide(
  solid: Uint8Array,
  width: number,
  height: number,
  bounds: Rect,
): number {
  // `row[0]` is the zero column left of `bounds.x` and is never written, so the recurrence's
  // "left" term is a real 0 on the first column rather than a special case inside the loop.
  const row = new Int32Array(bounds.w + 1);
  let best = 0;
  for (let y = bounds.y; y < bounds.y + bounds.h; y++) {
    let diagonal = 0;
    const base = y * width;
    for (let i = 0; i < bounds.w; i++) {
      const above = row[i + 1];
      row[i + 1] =
        solid[base + bounds.x + i] === 1 ? 1 + Math.min(above, row[i], diagonal) : 0;
      if (row[i + 1] > best) best = row[i + 1];
      diagonal = above;
    }
  }
  return best;
}

/**
 * The subject's thickness as a per-mille of the room it has to be read in, per-mille.
 *
 * `min(1000, rhu(1000 * thicknessPx, min(W, H)))` — the subject's largest inscribed square
 * against the canvas's short side. This is the scale-aware half of the pair §3.3's `Dmax`
 * paragraph argues for, and it is the half that can tell a knife from a horizon: a 3px band
 * on a 32² canvas is 94/1000 and a 3px band on a 1024² canvas is 2/1000, where
 * `compactnessQ` reads 274 for both when the subject is held fixed and the canvas grows.
 *
 * ## The denominator is the canvas, and the honest limit of that choice
 *
 * The canvas is the only length in a `QualityContext` that is not the subject, and it is the
 * only one a document actually carries: **a game asset's on-screen size is not in the
 * document**, so an absolute "is this thick enough" rule would have to invent a display size
 * to work at. The consequence is stated rather than hidden — a 28×3 band on 32² and a 896×96
 * band on 1024² are the *same drawing at two resolutions* and both measure 93, because any
 * ratio of two lengths in the same sprite is invariant under uniform magnification. That pair
 * is not separated, and the corpus says so. Separating it is a decision about a target
 * resolution, which is a product decision this task does not make.
 *
 * ## Where it overlaps `spanQ`, stated plainly
 *
 * For a rectangle the inscribed square *is* the short side, and `spanQ` is also driven by the
 * short side, so for band-like subjects the two numbers nearly coincide — a 28×3 band on 32²
 * reads `thicknessQ` 93 and `spanQ` 93. They are not the same measurement: `spanQ` is the
 * subject's *extent* and fires `subject-undersized`, `thicknessQ` is its *depth* and fires
 * `thin-profile`; they diverge wherever the inscribed square is smaller than the short side
 * (a ring, a C, a comb) and they agree only when the subject really is its own thin axis. A
 * subject that is both small and thin in its frame gets both codes, which is the same
 * judgement from two angles rather than one fact penalised twice — and the report prints both
 * columns so a reader can see the agreement instead of taking it on trust.
 */
export function thicknessQ(thicknessPx: number, width: number, height: number): number {
  const room = Math.min(width, height);
  if (room <= 0) return 0;
  return Math.min(1000, rhu(1000 * thicknessPx, room));
}


/**
 * Count §3.3's `convexCorner` pixels.
 *
 * **Measured here rather than used here, because §3.3's formula does not do what §4.2
 * says it does.** §3.3 defines it as "`p` is solid, exactly 2 of its 4 orthogonal
 * neighbours are solid, those 2 are adjacent, and the diagonal pixel between them is
 * transparent", and §4.2 then claims "`convexCorner` is the signature of a 45° staircase
 * on a convex boundary; a circle's outline is roughly half convex corners". Both halves of
 * that are false for the formula given, and the reason is geometric rather than numerical:
 * on a 45° staircase the diagonal between a pixel's two solid orthogonal neighbours is the
 * *next pixel of the staircase*, which is solid. The clause can therefore only be
 * satisfied where that diagonal is transparent, which is a one-pixel notch cut into the
 * shape — a **concave** corner. Measured 0 on a disc, on a rectangle, on a 5px plus and
 * on a 3px-wide diagonal band; `test/quality-silhouette.test.ts` pins the count so the
 * next revision of §3.3 is written against a number rather than an argument.
 *
 * A working convex-corner predicate is close to the negation: `p` is solid and some
 * quadrant has **both** of its orthogonal pixels transparent. It is not implemented here
 * because §4.2 is another task, and guessing at its correction from inside `silhouette`
 * would put a second definition of a §3.3 quantity in the repository — the one outcome
 * §3.3 exists to prevent.
 */
export function countConvexCorners(mask: Uint8Array, width: number, height: number): number {
  let corners = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] !== 1) continue;
      let solidNeighbours = 0;
      for (const [dx, dy] of ORTHO) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (mask[ny * width + nx] === 1) solidNeighbours++;
      }
      if (solidNeighbours !== 2) continue;
      for (const [a, b] of QUADRANTS) {
        if (!solidAt(mask, width, height, x + a[0], y + a[1])) continue;
        if (!solidAt(mask, width, height, x + b[0], y + b[1])) continue;
        if (!solidAt(mask, width, height, x + a[0] + b[0], y + a[1] + b[1])) corners++;
      }
    }
  }
  return corners;
}

/** Solid test that treats outside the canvas as not solid. */
function solidAt(mask: Uint8Array, width: number, height: number, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  return mask[y * width + x] === 1;
}

/**
 * Label the 4- or 8-connected components of `mask[p] === 1`, one row-major scan, one stack.
 *
 * A single `seen` array marked on push, which is what keeps the stack bounded: a pixel is
 * pushed at most once, so `mask.length` slots is a hard ceiling. Marking on *pop* instead
 * — the other thing that also bounds the stack — lets the same pixel sit in the stack
 * several times and turns the bound into a buffer overflow on a shape with many
 * neighbours.
 */
function scanComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  offsets: readonly (readonly [number, number])[],
): MaskComponent[] {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  const out: MaskComponent[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1 || seen[start] === 1) continue;
    seen[start] = 1;
    stack[0] = start;
    let depth = 1;
    let area = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    while (depth > 0) {
      const p = stack[--depth];
      area++;
      const x = p % width;
      const y = (p - x) / width;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      for (const [dx, dy] of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        if (mask[q] !== 1 || seen[q] === 1) continue;
        seen[q] = 1;
        stack[depth++] = q;
      }
    }
    out.push({ area, bounds: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, seed: start });
  }
  return out;
}

/** Tight bounding box of every solid pixel, or `null` when the mask is empty. */
function solidBounds(mask: Uint8Array, width: number, height: number): Rect | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] !== 1) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Everything one frame produced, including the score and the issues.
 *
 * Exported as a measurement record rather than kept private, because this dimension is
 * the pipeline's calibration instrument (T-021 corpus, T-022 comparison against human
 * scores) and a calibration harness needs the quantities, not only the verdict. A
 * dimension whose internals cannot be read is a dimension that can only be argued about.
 */
export interface SilhouetteFrame {
  /** Index into `context.composite`, so an issue can be traced to a frame. */
  readonly index: number;
  /** False when the frame holds nothing opaque. Such a frame scores 1000 and says so. */
  readonly measured: boolean;
  /** `N` in §3.3. */
  readonly N: number;
  readonly partialAlpha: number;
  /** Components of the solid mask under 4-connectivity. */
  readonly components: number;
  /** Every component's area, descending, ties broken by position. */
  readonly componentAreas: readonly number[];
  /** Bounds of the largest component, or `null` when there is none. */
  readonly bounds: Rect | null;
  readonly largest: number;
  /** `largest / N` in per-mille. The band table's primary ratio. */
  readonly shareQ: number;
  readonly strayCount: number;
  readonly strayPixels: number;
  /** `(N - largest) / N` in per-mille. */
  readonly strayQ: number;
  /** Bounds of the largest stray, which is what `detached-pieces` points at. */
  readonly strayBounds: Rect | null;
  readonly borderTouch: number;
  /**
   * The **whole mask's** boundary length, kept because it is what the report's
   * `edgePixels` comparison and every corpus expectation were written against. It is *not*
   * what `compactnessQ` is computed over any more; see `subjectPerimeter` for that.
   */
  readonly perimeter: number;
  /** The subject's own boundary length — the `perimeter` `compactnessQ` is given. */
  readonly subjectPerimeter: number;
  /**
   * §4.1's gate, on the **subject**. Scale-invariant shape descriptor; see the file header
   * for why that is the intent rather than an oversight.
   */
  readonly compactnessQ: number;
  /**
   * Side of the subject's largest inscribed axis-aligned square, in pixels.
   *
   * Carried in absolute pixels as well as as a ratio, because the absolute reading is a
   * *different* question with a different gate and the two are not interchangeable: the
   * 30×1 blade and the 900×30 blade have the same `thicknessQ` and a 30× difference in this
   * column. Deciding which of them `thin-profile` should read is a gate decision, so both
   * numbers are on the record rather than one of them being chosen here.
   */
  readonly thicknessPx: number;
  /** The scale-aware legibility reading: `thicknessPx` against `min(W, H)`, per-mille. */
  readonly thicknessQ: number;
  /**
   * `min(compactnessQ, thicknessQ)` — the worse of the two readings, and the number
   * `thin-profile` bands on. Two gates rather than one number: §4.1's `compactnessQ < 300`
   * is unchanged, and `thicknessQ < 250` is transcribed from §3.7's `span < 0.25`.
   */
  readonly profileQ: number;
  readonly holeCount: number;
  /** Every hole's area, ascending. */
  readonly holeAreas: readonly number[];
  readonly holeArea: number;
  /** `min(bounds.w / W, bounds.h / H)` in per-mille. */
  readonly spanQ: number;
  /**
   * §3.3's `convexCorners` count. Not used by any condition here; carried because it is
   * the measurement behind the spec-defect report in {@link countConvexCorners}.
   */
  readonly convexCorners: number;
  readonly scoreQ: number;
  readonly issues: readonly QualityIssue[];
}

/** The §4.1 band table, keyed on `share = largest / N`, read top down. */
const BASE_BANDS: readonly (readonly [number, number])[] = [
  [98, 1000],
  [90, 900],
  [75, 750],
  [50, 550],
];

/** §3.5 step 4: an adjustment total outside this band stops being legible. */
const ADJUSTMENT_MIN = -450;
const ADJUSTMENT_MAX = 50;

/**
 * §4.1's `compactnessQ < 300` gate, unchanged.
 *
 * Named rather than inlined so the corpus can transcribe it and so a reader can see that the
 * number T-022 was told not to move has not moved. The measurement *under* it changed — it is
 * now the subject's quotient rather than the whole mask's — which is the distinction that
 * matters: TASKS.md's ruling is "fix the measurement, not the gate", and a gate that now
 * reads a different quantity is not the same gate being left alone.
 */
const COMPACTNESS_GATE = 300;

/**
 * `thicknessQ < 250`, transcribed from §3.7's `span < 0.25`.
 *
 * **A transcription, not an invention, and the only number in this file with no line of
 * §4.1 behind it.** §3.7's `span` gate is the specification's one statement about how much
 * of the canvas a subject must occupy to count as present — a quarter of an edge — and a
 * subject whose inscribed thickness is under a quarter of the room is in the same position.
 * Reusing the spec's own number is the honest alternative to picking one, and it is still a
 * policy number: §4.1 does not have this row, the corpus prints what every candidate would
 * do in both directions, and the gate decision stays with the PO.
 */
const THICKNESS_GATE = 250;

/**
 * `profileQ < 150`: one more step below the existing one, and **nothing above it moves**.
 *
 * The complaint this answers is precise. `sweep/rect-30x2` and `sweep/rect-30x28` are 600
 * per-mille apart on `profileQ` and 100 apart on the score, and §6.2 calls a pair that
 * separates by 0.02 "passing the test and still wrong". A single step across 600 condemns
 * itself — but **grading the range above 150 is impossible without moving the gate**, because
 * a threshold that stops firing above 300 *is* a gate move and TASKS.md forbids one here. So
 * the only step that can be added without touching the gate's firing set is one *below* it,
 * and that is what this is: the trigger is unchanged, the subjects that fire are unchanged,
 * and the worst of them cost twice as much.
 *
 * The consequence is stated rather than buried: the 784-versus-184 pair still separates by
 * 100, and it will keep separating by 100 until the gate moves. That is the gate
 * conversation, not this task's.
 */
const THIN_PROFILE_DEEP = 150;

/**
 * `interior-hole`'s two clauses, priced separately.
 *
 * §4.1 has one row covering both "any hole with area ≤ 3 px" and "`holeRatio > 1/100`", at a
 * flat −100, and the corpus measured what that costs: a 1 px speck and a 6×6 window in the
 * same 20×20 body are the same code at the same −100, from two different clauses, on shapes
 * 288 per-mille apart. The fix is **not a fourth code** — §8.3's compatibility promise makes
 * a new code an API decision and this is a pricing question — it is two rows under the code
 * that already exists.
 *
 * The split is taken from §4.1's own rating anchors rather than invented: "**4** — one mass,
 * one small nick: a single 1–2 px hole" against "**2** — two masses of comparable size … or
 * several holes". A nick is half the cost of a window, and the big window keeps §4.1's
 * −100 exactly, so nothing that was expensive before has become cheap.
 *
 * **Order matters and is the rule**: the ratio clause is tested first, so the small-hole row
 * only prices holes the ratio clause cannot reach. A 3 px hole in a 200 px body has a ratio
 * of 15/1000 and is a window, not a nick, and the two rows must not both apply.
 */
const HOLE_SMALL_MAX_AREA = 3;
const HOLE_NICK_PENALTY = -50;
const HOLE_WINDOW_PENALTY = -100;


/**
 * Measure every frame in the context, in playback order.
 *
 * This is the whole per-frame pass — §3.5's six steps, once per frame — and
 * {@link silhouetteAnalyzer} only combines the results. Splitting it out is what lets a
 * calibration harness see `shareQ` and `compactnessQ` for artwork nobody has rated yet.
 */
export function measureSilhouette(context: QualityContext): SilhouetteFrame[] {
  const out: SilhouetteFrame[] = [];
  for (let i = 0; i < context.composite.length; i++) {
    out.push(measureFrame(context, i));
  }
  return out;
}

/**
 * `silhouette` — the first dimension in the pipeline and the heaviest-weighted one.
 *
 * A plain function, no class and no `this`, per `QualityAnalyzer`. Also a named export,
 * because the aggregator names dimensions and a default-only export would make this the
 * one dimension whose identifier is a convention.
 *
 * ## How frames are combined
 *
 * §4.1 is written per frame and says nothing about a multi-frame document, so the rule
 * here is the minimum: **`scoreQ` is the worst frame's score.** Not the mean, for the same
 * reason §4.2 takes the worst plane rather than the average of them — a mean is allowed to
 * hide one broken frame behind several good ones, and a sprite that reads as a smudge for
 * one frame in eight reads as a smudge in motion. `QualityDimension` has one `scoreQ` and
 * no way to say "four of these frames are fine", and `FLOOR_FAIL.silhouette` is a floor on
 * a dimension rather than on an average of dimensions.
 *
 * Frames with nothing opaque in them are *not* scored: they report 1000 and contribute no
 * issues, and if every frame is empty the dimension is 1000 with a verdict saying so.
 * That is the contract's expectation — `empty-frame` belongs to the aggregator at severity
 * 1.00, and it exists precisely so that a blank canvas is caught by one blocking issue
 * rather than by six dimensions each inventing a zero.
 */
export const silhouetteAnalyzer: QualityAnalyzer = (context: QualityContext): QualityDimension => {
  const frames = measureSilhouette(context);
  const measured = frames.filter((frame) => frame.measured);

  if (measured.length === 0) {
    return {
      scoreQ: 1000,
      verdict:
        frames.length === 0
          ? 'nothing to measure: the context carries no frames.'
          : `nothing opaque to measure on any of the ${plural(frames.length, 'frame')}; there is no shape to judge.`,
      issues: [],
      unmeasured: {},
    };
  }

  // Worst frame wins, ties resolving to the lowest index so the verdict names one frame.
  let worst = measured[0];
  for (const frame of measured) if (frame.scoreQ < worst.scoreQ) worst = frame;

  const issues = frames
    .flatMap((frame) => frame.issues)
    // Severity first, so a reader of the head of the list reads what blocks; then code,
    // then position. Every key is stated because an incidental sort order here is a
    // baseline diff (spec §3.2 rule 4). The sort is stable, so issues that tie on all
    // three stay in frame order, which is playback order.
    .sort(
      (a, b) =>
        b.severity - a.severity ||
        (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
        (a.rect?.y ?? 0) - (b.rect?.y ?? 0) ||
        (a.rect?.x ?? 0) - (b.rect?.x ?? 0),
    );

  const prefix =
    frames.length > 1
      ? `worst of ${frames.length} ${plural(frames.length, 'frame')} (frame ${worst.index}): `
      : '';
  // `silhouette` is a single measurement, so it has no sub-score to declare as unmeasured. The map
  // is still written rather than omitted: the contract makes it required precisely so that "this
  // dimension has no blind spot" and "nobody checked" cannot be the same report.
  return { scoreQ: worst.scoreQ, verdict: prefix + describe(worst, context), issues, unmeasured: {} };
};

/** §3.5's six steps, once per frame. */
function measureFrame(context: QualityContext, index: number): SilhouetteFrame {
  const { width, height } = context;
  const { mask, solid, partialAlpha } = buildSolidMask(context.composite[index], width, height);
  if (solid === 0) {
    return {
      index,
      measured: false,
      N: 0,
      partialAlpha,
      components: 0,
      componentAreas: [],
      bounds: null,
      largest: 0,
      shareQ: 0,
      strayCount: 0,
      strayPixels: 0,
      strayQ: 0,
      strayBounds: null,
      borderTouch: 0,
      perimeter: 0,
      subjectPerimeter: 0,
      compactnessQ: 0,
      thicknessPx: 0,
      thicknessQ: 0,
      profileQ: 0,
      holeCount: 0,
      holeAreas: [],
      holeArea: 0,
      spanQ: 0,
      convexCorners: 0,
      scoreQ: 1000,
      issues: [],
    };
  }

  // 4-connectivity, per §3.3. Sorted largest first, ties by position, so "the subject" is a
  // property of the shape rather than of the scan.
  const components = [...connectedComponents(mask, width, height, 4)].sort(
    (a, b) => b.area - a.area || a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x,
  );
  const subject = components[0];
  const largest = subject.area;
  const strays = components.slice(1);
  const strayPixels = solid - largest;
  const shareQ = rhu(largest * 1000, solid);
  // `solid > 0` returned above, so a tight box exists. Stating it once here rather than
  // guarding at eight use sites: a `Rect | null` threaded through the whole measurement
  // would be eight chances to forget the null and one impossible case to defend against.
  const bounds = solidBounds(mask, width, height)!;
  const touches = borderTouch(mask, width, height);
  const perimeter = boundaryPerimeter(mask, width, height);
  // The subject, alone, and the two readings that are computed over it. `components[0]` is
  // the largest mass *of the whole mask*, so this is the step that stops a subject paying
  // for the fragments beside it: `perimeter` above is the whole mask's and is kept because
  // the report and every corpus expectation were written against it, while everything below
  // is the subject's.
  const subjectOnly = subjectMask(mask, width, height, subject);
  const subjectPerimeter = boundaryPerimeter(subjectOnly, width, height);
  const thicknessPx = inscribedSquareSide(subjectOnly, width, height, subject.bounds);
  const compact = compactnessQ(largest, subjectPerimeter);
  const thin = thicknessQ(thicknessPx, width, height);
  // One number, two gates. The gates are separate because they are separate questions — a
  // shape that is not round, and a shape with no room — and a reader of `profileQ` who wants
  // to know which one bit has to look at the two columns beside it, which the report prints.
  const profileQ = Math.min(compact, thin);
  const holes = [...interiorHoles(mask, width, height)].sort(
    (a, b) => a.area - b.area || a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x,
  );

  const holeArea = holes.reduce((sum, hole) => sum + hole.area, 0);
  // §3.7 spells `span < 0.25` as `bounds.w * 4 < W || bounds.h * 4 < H`, against the whole
  // canvas rather than the focus. `spanQ` is the same ratio in per-mille, kept in the record
  // so the verdict and any later threshold read one number rather than recomputing it.
  const undersized = bounds.w * 4 < width || bounds.h * 4 < height;
  const spanQ = rhu(Math.min(bounds.w * height, bounds.h * width) * 1000, width * height);

  // Step 2: the band.
  let scoreQ = 250;
  for (const [percent, band] of BASE_BANDS) {
    if (largest * 100 >= percent * solid) {
      scoreQ = band;
      break;
    }
  }

  // Step 3: one entry per condition, each applied at most once and emitted on fire.
  const issues: QualityIssue[] = [];
  let adjustment = 0;

  // The two `detached-pieces` rows differ only in penalty, and they are exhaustive and
  // mutually exclusive, so they are one branch. §3.5 keeps severity on the code and puts
  // the difference in the score, which is what this does.
  if (strayPixels * 100 > 2 * solid) {
    adjustment += strays.length >= 2 ? -150 : -75;
    if (focused(context, strays[0].bounds)) {
      issues.push({
        code: 'detached-pieces',
        message:
          strays.length === 1
            ? `1 detached piece (${strays[0].area} px) shares no edge with the main mass; join it to the silhouette or delete it.`
            : `${strays.length} detached pieces (${areasOf(strays.map((s) => s.area))} px) share no edge with the main mass; join them to the silhouette or delete them.`,
        rect: strays[0].bounds,
        severity: 0.45,
      });
    }
  }

  // A hole is a defect even when it is intentional: the sprite is composited over a scene,
  // so a see-through pixel is a hole in the game world, not an eye. §4.1 names the
  // exception — a ring, a handle, a keyhole — as a known false positive that a human
  // rater's note settles, and no measurement can tell one from a mistake.
  //
  // The two clauses of §4.1's single row are priced separately, ratio first, so a window is
  // never mistaken for a nick. See `HOLE_NICK_PENALTY` for why the split is taken from §4.1's
  // rating anchors rather than invented.
  const windowHoles = holeArea * 100 > solid;
  const nickHole = windowHoles ? undefined : holes.find((hole) => hole.area <= HOLE_SMALL_MAX_AREA);
  if (nickHole !== undefined || windowHoles) {
    const byRatio = windowHoles;
    adjustment += byRatio ? HOLE_WINDOW_PENALTY : HOLE_NICK_PENALTY;
    // Point at the ≤3px hole when the *ratio* is what fired and one exists, because that is
    // the specific fix; otherwise at the largest, because the trigger was the total area.
    const target = (byRatio ? holes.find((hole) => hole.area <= HOLE_SMALL_MAX_AREA) : nickHole) ?? holes[holes.length - 1];
    if (focused(context, target.bounds)) {
      issues.push({
        code: 'interior-hole',
        message:
          holes.length === 1
            ? `1 interior hole (${holes[0].area} px) is see-through where the artwork should be solid; paint it, or accept it as a deliberately hollow asset.`
            : `${holes.length} interior holes (${areasOf(holes.map((h) => h.area))} px) are see-through where the artwork should be solid; paint them, or accept this as a deliberately hollow asset.`,
        rect: target.bounds,
        severity: 0.4,
      });
    }
  }

  // §4.1's `compactnessQ < 300` gate, unchanged, plus `thicknessQ < 250` beside it. The
  // message names both readings and both numbers so a reader is never told "too thin" without
  // being told which of the two senses it is in — a single score with two meanings behind it
  // is the failure this split exists to prevent.
  if (compact < COMPACTNESS_GATE || thin < THICKNESS_GATE) {
    const deep = profileQ < THIN_PROFILE_DEEP;
    adjustment += deep ? -200 : -100;
    if (focused(context, bounds)) {
      issues.push({
        code: 'thin-profile',
        message:
          `profile ${profileQ}/1000 (compactness ${compact}/1000, thickness ${thin}/1000 at ` +
          `${thicknessPx}px in a ${width}x${height} canvas): the shape is too thin to read at game ` +
          'scale; thicken it, or give the sprite more pixels.',
        rect: bounds,
        severity: 0.3,
      });
    }
  }

  if (touches >= 3) {
    adjustment -= 200;
    if (focused(context, bounds)) {
      issues.push({
        code: 'shape-clipped',
        message: `the shape reaches ${touches} of the 4 canvas edges, so the sprite is cut off; add margin or shrink the subject.`,
        rect: bounds,
        severity: 0.8,
      });
    }
  }

  if (undersized) {
    adjustment -= 100;
    if (focused(context, bounds)) {
      issues.push({
        code: 'subject-undersized',
        message: `the subject is ${bounds.w}x${bounds.h} inside a ${width}x${height} canvas, under a quarter of an edge; scale it up.`,
        rect: bounds,
        severity: 0.3,
      });
    }
  }

  if (largest * 100 < 50 * solid) {
    adjustment -= 150;
    if (focused(context, bounds)) {
      issues.push({
        code: 'fragmented-silhouette',
        message: `no dominant mass: the largest piece is ${shareQ}/1000 of ${solid} px; merge the pieces into one shape.`,
        rect: bounds,
        severity: 0.7,
      });
    }
  }

  // Steps 4 and 5: clamp the adjustment total so a band stays legible, then clamp the sum.
  const clamped = Math.max(ADJUSTMENT_MIN, Math.min(ADJUSTMENT_MAX, adjustment));
  return {
    index,
    measured: true,
    N: solid,
    partialAlpha,
    components: components.length,
    componentAreas: components.map((c) => c.area),
    bounds,
    largest,
    shareQ,
    strayCount: strays.length,
    strayPixels,
    strayQ: rhu(strayPixels * 1000, solid),
    strayBounds: strays[0]?.bounds ?? null,
    borderTouch: touches,
    perimeter,
    subjectPerimeter,
    compactnessQ: compact,
    thicknessPx,
    thicknessQ: thin,
    profileQ,
    holeCount: holes.length,
    holeAreas: holes.map((h) => h.area),
    holeArea,
    spanQ,
    convexCorners: countConvexCorners(mask, width, height),
    scoreQ: Math.max(0, Math.min(1000, scoreQ + clamped)),
    issues,
  };
}

/**
 * Whether an issue survives `context.focus`.
 *
 * `focus` is a scope, not a crop, so it never changes a number — it only decides which
 * defects the caller is told about. Intersection rather than containment, so a defect
 * whose evidence straddles the box's edge is still reported; that is the clause in the
 * contract ("a defect whose evidence is just outside the box is still worth an issue").
 */
function focused(context: QualityContext, rect: Rect): boolean {
  if (context.focus === null) return true;
  return (
    rect.x < context.focus.x + context.focus.w &&
    context.focus.x < rect.x + rect.w &&
    rect.y < context.focus.y + context.focus.h &&
    context.focus.y < rect.y + rect.h
  );
}

/** `"1 frame"` / `"4 frames"`. */
function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

/** `"9 and 7"`, `"1, 2 and 3"`, capped at four so a noise field cannot produce a paragraph. */
function areasOf(areas: readonly number[]): string {
  const shown = areas.slice(0, 4).map((area) => `${area}`);
  if (areas.length > shown.length) return `${shown.join(', ')} and ${areas.length - shown.length} more`;
  return shown.length === 1
    ? shown[0]
    : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/** The one sentence `QualityDimension.verdict` is allowed. */
function describe(frame: SilhouetteFrame, context: QualityContext): string {
  const parts: string[] = [`one mass at ${frame.shareQ}/1000 of ${frame.N} solid px`];
  if (frame.strayCount > 0) {
    parts.push(
      `${frame.strayCount} detached ${plural(frame.strayCount, 'piece')} (${areasOf(frame.componentAreas.slice(1))} px)`,
    );
  }
  if (frame.holeCount > 0) {
    parts.push(`${frame.holeCount} interior ${plural(frame.holeCount, 'hole')} (${areasOf(frame.holeAreas)} px)`);
  }
  if (frame.borderTouch >= 3) parts.push(`reaching ${frame.borderTouch} canvas edges`);
  // Both readings, always together, because "thin" is two claims and a verdict that said
  // only the number would leave the reader guessing which sense it meant. Cheap, and it is
  // the same string the issue carries.
  if (frame.compactnessQ < COMPACTNESS_GATE || frame.thicknessQ < THICKNESS_GATE) {
    parts.push(
      `thin profile at ${frame.profileQ}/1000 (compactness ${frame.compactnessQ}, thickness ` +
        `${frame.thicknessQ} at ${frame.thicknessPx}px)`,
    );
  }

  const bounds = frame.bounds;
  if (bounds !== null && (bounds.w * 4 < context.width || bounds.h * 4 < context.height)) {
    parts.push(`only ${bounds.w}x${bounds.h} of ${context.width}x${context.height}`);
  }
  if (frame.shareQ < 500) parts.push('no dominant mass');
  if (frame.partialAlpha > 0) {
    parts.push(`${frame.partialAlpha} px below ALPHA_SOLID ${ALPHA_SOLID}, counted but not scored`);
  }
  return `${parts.join(', ')}.`;
}

export default silhouetteAnalyzer;
