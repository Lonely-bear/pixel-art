import { ALPHA_SOLID } from './context.js';
import {
  borderTouch,
  boundaryPerimeter,
  buildSolidMask,
  compactnessQ,
  connectedComponents,
  countConvexCorners,
  interiorHoles,
  rhu,
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
 *   - The seven quantities below are **re-exported from `silhouette.ts`, not moved**. A
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
 * `compactnessQ` and `countConvexCorners` out of this file and import them from here; delete
 * the "Shared quantities" section of the header. In `index.ts`: add
 * `export * from './measure.js';`. In this file: delete the re-export block above. No
 * behaviour changes and no call site outside `silhouette.ts` moves, because every import of
 * these names already goes through `index.ts`.
 *
 * ## What deliberately is *not* here
 *
 * **`dist` and `Dmax`.** §3.3 defines them twice, incompatibly: the table says "the Chebyshev
 * distance to the nearest non-solid pixel", and the prose three paragraphs below says "a
 * multi-source BFS over the solid mask from every `edgePixel`, 4-connected, with `+1` per
 * step". Those are L-infinity and L1 and they disagree on real sprites. `value` (T-013),
 * `outline` (T-016) and `noise` (T-015) all need the answer, and none of them exists.
 *
 * Implementing one of the two now would put a *second* definition of a named §3.3 quantity in
 * the repository — the exact outcome §3.3 exists to prevent — and picking one would be a
 * guess made from inside a file that has no reason to know which reading the specification
 * author intended. `countConvexCorners` sets the precedent: it is implemented because
 * `silhouette` needs it, and the fact that it is *wrong* is recorded in its own doc comment
 * with the number that proves it, for the next revision of §3.3 to be written against. The
 * `dist` conflict is recorded the same way, in `benchmarks/corpus/format.ts`'s
 * `DECLARED_QUANTITIES`, together with a shape on which the two readings give different
 * answers, so the dimension that implements it inherits a test to write rather than a
 * judgement call to make.
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
 * §3.3's `dist` is not here, and the two incompatible definitions of it are recorded in the
 * corpus rather than resolved here. Re-exported so that the names a second consumer needs are
 * in one place even though their definitions are not.
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
  interiorHoles,
  rhu,
};