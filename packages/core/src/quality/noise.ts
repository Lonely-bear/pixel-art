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

/** §3.3's four orthogonal offsets, for the neighbour counts §4.4 needs. */
const ORTHO: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * §4.4's `dither-dominant` advisory, as per-mille. The specification writes the share as a
 * fraction against `10/100`; §3.7 requires every ratio in the pipeline to be integer per-mille, so
 * the conversion happens here and nowhere else.
 */
const DITHER_ADVISORY_Q = 100;

/** §4.4's issue trigger, as per-mille: `> 8/1000` for all four noise ratios. */
const ISSUE_TRIGGER_Q = 8;

/**
 * §4.4's band table for the four ratios, highest bound first.
 *
 * **On a thin sprite (`Dmax == 2`) the BOUNDS double and the sub-scores do not.** A 2px-wide feature
 * cannot avoid having 1px-scale artefacts, so the same count is a smaller share of the same sprite;
 * §4.4 halves nothing, it moves the edges and leaves the scale alone, and that is the whole point of
 * separating the two.
 */
const BANDS: readonly (readonly [number, number])[] = [
  [50, 200],
  [20, 500],
  [8, 750],
  [2, 900],
];

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

/** §4.4's band lookup, read top down, with the thin-sprite bound doubling. */
function bandFor(ratio: number, thin: boolean): number {
  for (const [bound, score] of BANDS) {
    if (ratio <= (thin ? bound * 2 : bound)) return score;
  }
  return 200;
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
    let sameBucket = 0;
    const x = p % width;
    const y = (p - x) / width;
    const own = lqBucketOf(cel, p);
    for (const [dx, dy] of ORTHO) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const q = ny * width + nx;
      if (solidMask[q] !== 1) continue;
      if (lqBucketOf(cel, q) === own) sameBucket++;
    }
    if (sameBucket === 0) colourOrphans++;
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
      message: `${colourOrphans} ${plural(colourOrphans, 'pixel')} of ${N} have no solid 4-neighbour in their own lightness bucket. These match nothing around them, which is what separates a speck from an edge: on a coherent edge every pixel agrees with the half of its neighbourhood on its own side.`,
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
  if (dither.share >= DITHER_ADVISORY_Q) {
    issues.push({
      code: 'dither-dominant',
      message: `${dither.share}/1000 of the surface is one- or two-pixel alternation between adjacent steps. That is dither rather than noise and it costs no point here, but a piece that is mostly alternation breaks the 3–5px seam rule on its own.`,
      rect: null,
      severity: 0.35,
    });
  }

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
 * flat. §7 item 5 states the cost.
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
