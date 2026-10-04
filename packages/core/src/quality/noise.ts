import { colorDistance } from '../color.js';
import { buildSolidMask, distField, ditherMask, lqBucketOf, rhu } from './measure.js';
import type {
  ExcludedReason,
  QualityAnalyzer,
  QualityCel,
  QualityContext,
  QualityDimension,
  QualityIssue,
} from './types.js';

/**
 * §4.4's issue trigger, as per-mille: `> 8/1000` for all four noise ratios.
 */
const ISSUE_TRIGGER_Q = 8;

/**
 * §4.4's band table for the four ratios, **ascending bound, best sub-score first**.
 *
 * **The table was written in descending-bound order and read in that order, which inverted it.**
 * A ratio of 0 matched the `<= 50/1000` row and returned the *worst* sub-score, so every clean
 * negative control in the corpus scored `noise` **200 of 1000** with all four measures reading
 * exactly zero. It was wrong by a band as well: §4.4's specified top row is `<= 2/1000 -> 1000`
 * and its `> 50/1000` row is 200, and the committed table had neither.
 *
 * **The first thing to check on any band table in this repository is the direction it is read in.**
 * A descending list of `(bound, score)` pairs walked with a `for` loop returns the *first* match,
 * and on a zero ratio the first match is always the loosest bound unless the list is ordered the
 * other way round. That is the whole defect, and it is invisible in review because every row of
 * the table is individually plausible.
 *
 * **On a thin sprite (`Dmax == 2`) the BOUNDS double and the sub-scores do not.** A 2px-wide
 * feature cannot avoid having 1px-scale artefacts, so the same count is a smaller share of the
 * same sprite; §4.4 halves nothing, it moves the edges and leaves the scale alone.
 */
const BANDS: readonly (readonly [number, number])[] = [
  [2, 1000],
  [8, 900],
  [20, 750],
  [50, 500],
];

/** The `> 50/1000` row of the same table: the floor for anything past the last bound. */
const RATIO_FLOOR_Q = 200;

/** §4.4's weights: `isolated` 300, `diagOnly` 200, `colourOrphans` 300, `spurs` 200. */
const WEIGHTS = { isolated: 300, diag: 200, orphans: 300, spurs: 200 } as const;

/** §4.4's near-duplicate test: `>= 8` solid pixels each, Chebyshev colour distance `<= 8`. */
const NEAR_DUPLICATE_MIN_PIXELS = 8;
const NEAR_DUPLICATE_DISTANCE = 8;

/**
 * §4.4's flat near-duplicate penalty, and why it is flat rather than banded.
 *
 * Two ramp entries three steps apart are a mistake whether there are two of them or twenty: it is a
 * *decision* error rather than a frequency one, so the count cannot be what decides the size of it.
 */
const NEAR_DUPLICATE_PENALTY = 100;

/** Everything `noise` measures on one frame — a record, for `silhouette`'s reason. */
export interface NoiseFrame {
  readonly index: number;
  /** False when the frame holds nothing opaque. Such a frame scores 1000 and says so. */
  readonly measured: boolean;
  /** §3.3's `N` on this frame. */
  readonly N: number;
  /** §3.3's `Dmax`, which selects the thin-sprite relaxation and the line-sprite exclusion. */
  readonly Dmax: number;
  /** `Dmax <= 1`: a line drawing, where the three neighbour measures have nothing to measure. */
  readonly lineSprite: boolean;
  /** `Dmax == 2`: a thin sprite, where the band BOUNDS double. */
  readonly thinSprite: boolean;
  readonly isolated: number;
  readonly diagOnly: number;
  readonly spurs: number;
  readonly colourOrphans: number;
  readonly nearDuplicatePairs: number;
  /** §3.3's `ditherShare`, per-mille over the solid mask. */
  readonly ditherShare: number;
  /** How many components §3.3's `ditherMask` classified as dither regions. */
  readonly ditherRegions: number;
  /** The four banded sub-scores, per-mille. `null` where the sub-score does not apply. */
  readonly isolatedQ: number | null;
  readonly diagQ: number | null;
  readonly orphanQ: number | null;
  readonly spurQ: number | null;
  readonly scoreQ: number;
  readonly issues: readonly QualityIssue[];
}

/** §4.4's band lookup, read in ascending-bound order, with the thin-sprite bound doubling. */
function bandFor(ratio: number, thin: boolean): number {
  for (const [bound, score] of BANDS) {
    if (ratio <= (thin ? bound * 2 : bound)) return score;
  }
  return RATIO_FLOOR_Q;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

/** The three neighbour measures, all of which §4.4 excludes dithered pixels from. */
interface NeighbourCounts {
  readonly n4: Int32Array;
  readonly n8: Int32Array;
}

/** One pass for the neighbour counts. `ditherMask` is computed by the caller and passed in. */
function neighbourCounts(
  solidMask: Uint8Array,
  width: number,
  height: number,
): NeighbourCounts {
  const size = width * height;
  const n4 = new Int32Array(size);
  const n8 = new Int32Array(size);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (solidMask[p] !== 1) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          // **A neighbour is not the pixel.** This skip was missing, and §3.3 is explicit that
          // `n4(p)` / `n8(p)` count *neighbours* of `p`. The consequences were not cosmetic:
          //
          //   - every solid pixel counted itself, so `n8` was `>= 1` everywhere and **`isolated`
          //     (`n8 == 0`) was unsatisfiable** — a constant 0, and `isolated-pixels` a code that
          //     could never be emitted;
          //   - **`diagOnly` (`n4 == 0`) was unsatisfiable** for the same reason, so `diagonal-seam`
          //     could never be emitted either;
          //   - `spurs` (`n8 == 1`) therefore meant "this pixel and nothing beside it" — i.e. it had
          //     silently become `isolated`, while a real 1px antenna reads `n8 == 2` and was invisible.
          //
          // Across all 67 corpus cases the three measures read 0 and not one of the three codes had
          // ever been reported once. **A measurement that cannot fail is not a measurement**, which is
          // the same sentence `ditherMask` needed two fixes ago and the band table needed one.
          // §4.4's worked example settles it independently: "one wrong-coloured pixel inside a solid
          // block (`n8 == 8`)" — eight, not nine.
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (solidMask[ny * width + nx] !== 1) continue;
          if (dx === 0 || dy === 0) n4[p]++;
          n8[p]++;
        }
      }
    }
  }
  return { n4, n8 };
}

/**
 * §4.4's `colourOrphan(p)`: nothing around `p` agrees with it, **and** nothing around it is even on
 * the same side of the lightness ramp.
 *
 * ```
 * colourOrphan(p) = #{ q solid : 1 <= Chebyshev(p, q) <= 2, LqBucket(q) == LqBucket(p) } == 0
 *                 && LqBucket(p) not in [ min, max ] over the same set of q
 * ```
 *
 * ## The question, and the two questions that were measured and refuted before this one
 *
 * §4.4's first version asked whether `p` has a same-bucket **4-neighbour**, and its own worked
 * example listed the cases that answer "no" — a material edge, an outline's inner edge, a smooth
 * shading plane. **Two of those three rows are false as written**, and the measurement is in
 * `dev/EVALUATION.md` §7:
 *
 *   - **A 1px outline drawn as a staircase.** Every corner pixel of the contour has no same-bucket
 *     4-neighbour; the rest of the contour reaches it diagonally. `control/outline-ring-32` — a
 *     declared negative control, and the case that exists to catch exactly this — reads **31/1000**,
 *     which is past §4.4's `> 8/1000` trigger. The dimension fires on the repository's own clean
 *     work, which §3.5 says is worse than missing a defect.
 *   - **A gradient.** In a ramp a pixel's 4-neighbours are the buckets either side of it, so "no
 *     same-bucket 4-neighbour" is the normal state of a picture rather than a defect. The ten
 *     committed scenes read 9..153.
 *
 * Two replacements were measured across all 65 cases and both are recorded here because a refuted
 * approach is the thing a future revision most needs and can least re-derive:
 *
 *   - **Refuted — treat a +/-1 bucket as agreement.** It does what it says on gradients (the
 *     512² scene drops 153 -> 27, the 256² one 89 -> 25) and changes `control/outline-ring-32` not at
 *     all, because a dark contour against a light interior is 13 buckets away, not one. It cannot be
 *     both a gradient test and an outline test, and the outline is the one it fails.
 *   - **Refuted — compare the pixel against the [min, max] range spanned by its 4-neighbours.** At
 *     radius 1 this reads 0 on `control/outline-ring-32`, but it **breaks the gap §4.4 is proud of**:
 *     the 2px specular highlight in `artwork/verify/lantern-keeper.pixel` is an island whose pixels
 *     sit entirely outside their surroundings' range, so a correct 2px highlight starts scoring as
 *     a stray colour. Protecting a deliberate highlight is the whole reason `despeckle` ships
 *     `minClusterSize`.
 *
 * Radius 2 is what makes the range clause safe, and the reason is mechanical rather than tuned: at
 * Chebyshev 2 the rest of a 1px contour is always reachable, and a 2px island always contains its own
 * partner. Measured, **every declared `clean-control` in the corpus reads 0** — including all six of
 * the `control/*` negative controls — and the ten real artworks read **0..10** against a trigger of
 * 8. §3.3 asks for a measurement with one home, so this lives here and nowhere else; §4.4's table
 * is the specification of what it is for, and this is the predicate that answers it.
 *
 * ## What it still misses, and the miss is not free
 *
 * A stray pixel inside a feature narrower than 4px is exempted, because at radius 2 the feature's
 * other side is in the neighbourhood. `isolated`, `diagOnly` and `spurs` still see those as *shape*
 * problems, so the case is not invisible — but a wrong colour down the middle of a 3px antenna reads
 * clean. Recorded rather than tuned away: there is no threshold here that fixes it without also
 * re-admitting the 1px outline.
 */
function noAgreementWithinTwo(
  cel: QualityCel,
  solidMask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  own: number,
): boolean {
  // Sentinels, NOT `own`. Seeding `hi` with `own` makes `own > hi` unsatisfiable, which silently
  // halves the test: a stray pixel *brighter* than its surroundings is the common case, and seeding
  // this way exempts exactly that half. The first version of this function did, and the corpus
  // caught it — `defect/stray-colour-16` read zero orphans with two of them drawn in.
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let dy = -2; dy <= 2; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= height) continue;
    for (let dx = -2; dx <= 2; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      if (nx < 0 || nx >= width) continue;
      const q = ny * width + nx;
      if (solidMask[q] !== 1) continue;
      const bucket = lqBucketOf(cel, q);
      if (bucket === own) return false;
      if (bucket < lo) lo = bucket;
      if (bucket > hi) hi = bucket;
    }
  }
  // Nothing in the neighbourhood shares this pixel's bucket, and nothing around it is even on the
  // same side of the ramp it sits on. A pixel alone in the world has no span at all, and `lo > hi`
  // makes both comparisons false, so it is NOT counted: `isolated` is the measure for that, and one
  // pixel cannot be both unattached and undescribed.
  if (lo > hi) return false;
  return own < lo || own > hi;
}

/** §4.4's `nearDuplicatePairs`: distinct colours, `>= 8` solid pixels each, within distance 8. */
function countNearDuplicatePairs(cel: QualityCel, solidMask: Uint8Array, width: number, height: number): number {
  const counts = new Map<number, number>();
  const colourOf = new Map<number, { r: number; g: number; b: number; a: number }>();
  for (let p = 0; p < width * height; p++) {
    if (solidMask[p] !== 1) continue;
    const r = cel.data[p * 4];
    const g = cel.data[p * 4 + 1];
    const b = cel.data[p * 4 + 2];
    const a = cel.data[p * 4 + 3];
    const key = (r << 24) | (g << 16) | (b << 8) | a;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!colourOf.has(key)) colourOf.set(key, { r, g, b, a });
  }
  const frequent = [...counts.entries()].filter(([, n]) => n >= NEAR_DUPLICATE_MIN_PIXELS);
  let pairs = 0;
  for (let i = 0; i < frequent.length; i++) {
    for (let j = i + 1; j < frequent.length; j++) {
      const a = colourOf.get(frequent[i][0])!;
      const b = colourOf.get(frequent[j][0])!;
      if (colorDistance(a, b) <= NEAR_DUPLICATE_DISTANCE) pairs++;
    }
  }
  return pairs;
}

function measureFrame(context: QualityContext, index: number): NoiseFrame {
  const { width, height } = context;
  const cel = context.composite[index];
  const { mask: solidMask, solid: N } = buildSolidMask(cel, width, height);
  const { Dmax } = distField(solidMask, width, height);
  const lineSprite = Dmax <= 1;
  const thinSprite = Dmax === 2;

  if (N === 0) {
    return {
      index,
      measured: false,
      N: 0,
      Dmax,
      lineSprite,
      thinSprite,
      isolated: 0,
      diagOnly: 0,
      spurs: 0,
      colourOrphans: 0,
      nearDuplicatePairs: 0,
      ditherShare: 0,
      ditherRegions: 0,
      isolatedQ: null,
      diagQ: null,
      orphanQ: null,
      spurQ: null,
      scoreQ: 1000,
      issues: [],
    };
  }

  // **One `ditherMask` per frame, consulted by every measure that excludes it.** Computing it twice
  // would be the kind of duplication §3.3 exists to forbid, and worse it would be two chances to
  // disagree.
  const dither = ditherMask(cel, solidMask, width, height);
  const { n4, n8 } = neighbourCounts(solidMask, width, height);

  let isolated = 0;
  let diagOnly = 0;
  let spurs = 0;
  let colourOrphans = 0;
  for (let p = 0; p < width * height; p++) {
    if (solidMask[p] !== 1) continue;
    if (!lineSprite && dither.mask[p] === 0) {
      if (n8[p] === 0) isolated++;
      if (n4[p] === 0 && n8[p] >= 1) diagOnly++;
      if (n8[p] === 1) spurs++;
    }
    // `colourOrphans` is NOT excluded by dither, and the asymmetry is deliberate. The three shape
    // measures ask "is this pixel attached to anything", and a dithered field is full of pixels whose
    // attachments are 1px alternations — that is what dither IS. This one asks "does this pixel
    // agree with anything in its own bucket", and in a dithered field the two steps alternate, so a
    // dithered pixel agrees with its own step's pixels. Excluding it would exempt exactly the
    // technique the exclusion exists to protect.
    const x = p % width;
    const y = (p - x) / width;
    if (noAgreementWithinTwo(cel, solidMask, width, height, x, y, lqBucketOf(cel, p))) colourOrphans++;
  }

  const nearDuplicatePairs = countNearDuplicatePairs(cel, solidMask, width, height);

  const ratio = (count: number) => rhu(count * 1000, N);
  const isolatedQ = lineSprite ? null : bandFor(ratio(isolated), thinSprite);
  const diagQ = lineSprite ? null : bandFor(ratio(diagOnly), thinSprite);
  const orphanQ = bandFor(ratio(colourOrphans), thinSprite);
  const spurQ = lineSprite ? null : bandFor(ratio(spurs), thinSprite);

  // The three shape sub-scores drop out of the mean on a line sprite: their weight is dropped and
  // the remainder re-normalised, for `STATIC_QUALITY_WEIGHTS`'s reason — a sub-score that is silently
  // absent is indistinguishable from one counted at its best.
  const parts: readonly (readonly [number, number | null])[] = [
    [WEIGHTS.isolated, isolatedQ],
    [WEIGHTS.diag, diagQ],
    [WEIGHTS.orphans, orphanQ],
    [WEIGHTS.spurs, spurQ],
  ];
  // The filter is the whole of the line-sprite handling on the score: a sub-score that does not apply
  // drops its weight and the remainder is re-normalised, rather than the sub-score being invented as
  // a 1000 that would then be indistinguishable from a real clean reading.
  const present = parts.filter((pair): pair is readonly [number, number] => pair[1] !== null);
  const weightSum = present.reduce((sum, [w]) => sum + w, 0);
  const weighted = present.reduce((sum, [w, q]) => sum + w * q, 0);
  const scoreQ = Math.max(
    0,
    rhu(weightSum === 0 ? 1000 : weighted, weightSum) - (nearDuplicatePairs >= 1 ? NEAR_DUPLICATE_PENALTY : 0),
  );

  /* --- the issues --- */
  // **`rect: null` on every speck issue, and that is §4.4's own worked example saying so**: "the issue
  // names no boundary: it cannot, because there is nothing wrong with any of them." A bounding box
  // around scattered specks is the sprite, and a `fix` op aimed at the sprite is not advice.
  const issues: QualityIssue[] = [];
  const trigger = thinSprite ? ISSUE_TRIGGER_Q * 2 : ISSUE_TRIGGER_Q;
  if (isolatedQ !== null && ratio(isolated) > trigger) {
    issues.push({
      code: 'isolated-pixels',
      message: `${isolated} ${plural(isolated, 'pixel')} of ${N} have no solid neighbour at all. A stray pixel is a shape error as much as a colour one: it changes the silhouette, and the silhouette is what the game reads.`,
      rect: null,
      severity: 0.4,
    });
  }
  if (diagQ !== null && ratio(diagOnly) > trigger) {
    issues.push({
      code: 'diagonal-seam',
      message: `${diagOnly} ${plural(diagOnly, 'pixel')} of ${N} touch the body only diagonally. At half scale, with a filter, or on a CRT the contact disappears and the sprite falls in half.`,
      rect: null,
      severity: 0.45,
    });
  }
  if (ratio(colourOrphans) > ISSUE_TRIGGER_Q) {
    issues.push({
      code: 'stray-colour',
      message: `${colourOrphans} ${plural(colourOrphans, 'pixel')} of ${N} agree with nothing within two pixels and sit outside the lightness range of everything around them. That is what separates a stray colour from an edge: on a gradient a pixel's neighbours are the steps either side of it, and on an outline the rest of the contour reaches it diagonally, so both agree with it somehow.`,
      rect: null,
      severity: 0.35,
    });
  }
  if (spurQ !== null && ratio(spurs) > trigger) {
    issues.push({
      code: 'single-pixel-spur',
      message: `${spurs} ${plural(spurs, 'pixel')} of ${N} have exactly one solid 8-neighbour — a one-pixel antenna off an edge, which reads as a drawing accident rather than as a shape.`,
      rect: null,
      severity: 0.3,
    });
  }
  if (nearDuplicatePairs >= 1) {
    issues.push({
      code: 'near-duplicate-colours',
      message: `${nearDuplicatePairs} ${plural(nearDuplicatePairs, 'pair')} of distinct colours each cover at least ${NEAR_DUPLICATE_MIN_PIXELS} pixels and sit within ${NEAR_DUPLICATE_DISTANCE} of each other. Two ramp entries three steps apart are a decision error rather than a frequency one, so the count cannot size it; \`quantize_to_palette\` merges them.`,
      rect: null,
      severity: 0.35,
    });
  }
  // **There is no `dither-dominant` advisory, and its absence is a measurement rather than an
  // omission.** §4.4 specifies one at `ditherShare >= 100/1000`. With `ditherMask` actually working,
  // it fires on `value/level-set-32` — a **declared negative control** — at 427, and on
  // `value/straight-diagonal-32` at 261. Both draw 1–2px concentric contours and one straight 45°
  // cut, and §7 lists "a 1px outline is the target" as a convention this repository scores
  // positively. The reason is that a 1px alternation between two adjacent buckets **is** a dither
  // pattern and **is** a contour line: they are the same set of pixels, so §3.3's rule that no
  // threshold separates two cases that are equivalent on the same pixels applies directly, and the
  // cut cannot be placed anywhere.
  //
  // A second candidate was measured and refuted rather than assumed: adding an "interior" clause —
  // the share of the component whose 8-neighbourhood lies wholly inside it — on the reasoning that a
  // 1px line has no interior and a filled band does. It does not separate them, and it separates
  // them in the wrong order: `value/level-set-32` reads **200** where `artwork/verify/lantern-keeper`
  // reads **141**. The two `value` cases draw their contours **2px apart** (the corpus recipe says so
  // and explains why), so the pair's union set is a band several pixels across and does have an
  // interior. Band thickness is not the discriminator; nothing here is.
  //
  // `ditherShare` therefore stays on {@link NoiseFrame} as a **measurement** and stops being a
  // verdict. It is the number §7.3's four scenes needed and did not have, and an agent reading it
  // learns something true; an advisory claiming to know whether the alternation it found was
  // intentional would not be, and it would have fired on this repository's own clean control.
  return {
    index,
    measured: true,
    N,
    Dmax,
    lineSprite,
    thinSprite,
    isolated,
    diagOnly,
    spurs,
    colourOrphans,
    nearDuplicatePairs,
    ditherShare: dither.share,
    ditherRegions: dither.regions,
    isolatedQ,
    diagQ,
    orphanQ,
    spurQ,
    scoreQ,
    issues,
  };
}

/** `noise` over every frame, in playback order. */
export function measureNoise(context: QualityContext): NoiseFrame[] {
  const out: NoiseFrame[] = [];
  for (let i = 0; i < context.composite.length; i++) out.push(measureFrame(context, i));
  return out;
}

/**
 * `noise` — stray pixels and speckle, the residue of automated drawing.
 *
 * ## Worst frame wins
 *
 * For `silhouette`'s reason, and here it is more obvious than anywhere else: the defect is per-pixel,
 * so one sparkling frame in an eight-frame walk cycle is a sparkle in motion. `QualityDimension` has
 * one `scoreQ` and no way to say "seven of these are fine", and `FLOOR_FAIL.noise` is a floor on a
 * dimension rather than on an average of dimensions.
 *
 * ## No applicability precondition, and that is a decision
 *
 * `silhouette` and `outline` need a subject to read a shape out of, and a full-bleed scene has none:
 * its alpha boundary is the frame. `noise` asks a different question, and a full-bleed landscape
 * answers it perfectly well — the ten scenes in `artwork/` are exactly the documents where a
 * snapping fill, a stray highlight or a leaked pixel is most likely, because they are the ones with
 * thousands of individual marks in them. §4.4 lists no precondition for the same reason §4.2 does,
 * and `ExcludedReason`'s own documentation already records that `noise` is unaffected by a full-bleed
 * subject. **This is also the dimension that has the most to say about the dithered scenes T-102
 * found**, since a dithered tone field is hundreds of small regions and a speck detector is exactly
 * the instrument that would tell a person whether those regions are texture or error.
 *
 * ## What this dimension cannot do, and the row in §4.4 that admits it
 *
 * A two- or three-pixel island of one tone inside another is **not** caught. Its pixels match each
 * other, so `colourOrphans` does not fire, and the region-level test that would catch it would also
 * delete every 2px specular dot in the corpus — and a 2px highlight on a shoulder is correct craft,
 * which is why `despeckle` ships `minClusterSize: 2-4` so a cleanup pass will not remove it. One
 * sharp pixel-level predicate plus a documented gap beats a broad one that quietly sands a piece
 * flat. §7 item 6 states the cost.
 */
export const noiseAnalyzer: QualityAnalyzer = (context: QualityContext): QualityDimension => {
  const frames = measureNoise(context);
  const measured = frames.filter((frame) => frame.measured);

  if (measured.length === 0) {
    return {
      scoreQ: 1000,
      verdict:
        frames.length === 0
          ? 'nothing to measure: the context carries no frames.'
          : `nothing opaque to measure on any of the ${plural(frames.length, 'frame')}; there is no surface to find specks on.`,
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

  // A line sprite is the one case where three of the four sub-scores do not exist, and AD-4 requires
  // the absence to be **said** rather than inferred from a number that happens to read 1000.
  const lineFrames = measured.filter((frame) => frame.lineSprite);
  const unmeasured: Partial<Record<string, ExcludedReason>> = {};
  if (lineFrames.length === measured.length) {
    for (const sub of ['isolated', 'diagOnly', 'spurs'] as const) unmeasured[sub] = 'line-sprite';
  }

  const parts: string[] = [];
  if (worst.lineSprite) {
    parts.push('line sprite, so the neighbour measures do not apply');
  } else {
    parts.push(`${worst.isolated} isolated px`);
    parts.push(`${worst.diagOnly} diagonal-only px`);
    parts.push(`${worst.spurs} single-pixel spurs`);
  }
  parts.push(`${worst.colourOrphans} stray-colour px`);
  if (worst.nearDuplicatePairs >= 1) {
    parts.push(`${worst.nearDuplicatePairs} near-duplicate ${plural(worst.nearDuplicatePairs, 'pair')}`);
  }
  parts.push(`dither ${worst.ditherShare}/1000 of the surface`);

  return {
    scoreQ: worst.scoreQ,
    verdict: prefix + parts.join(', ') + '.',
    issues,
    unmeasured: unmeasured as QualityDimension['unmeasured'],
  };
};
