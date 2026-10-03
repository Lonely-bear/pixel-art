import { buildSolidMask, lqOf, rhu } from './measure.js';
import type {
  QualityAnalyzer,
  QualityContext,
  QualityDimension,
  QualityIssue,
} from './types.js';

/**
 * `motion` — does the animation hold together?
 *
 * ## Why this dimension is cheap to calibrate, and why that is not the same as easy
 *
 * §4.5's defects are taste (`outline-heavy`, `outline-inconsistent-weight` are opinions about how
 * much contour is right), §4.2's are opinions about where light comes from, §4.3's are about
 * convention. **§4.6's defects are objective.** A loop whose seam changes three times more pixels
 * than any internal transition is wrong by arithmetic, not by taste: the same pixel counts on the
 * same frames put the same subject on the same side of the band, and a human who disagrees has to
 * disagree about the picture rather than about the rule. That is why this is the sixth and last
 * dimension rather than the first, and it is the one dimension in this repository whose thresholds
 * can be argued from a corpus without first settling whether the corpus has opinions.
 *
 * ## The exclusion is not here, and that is deliberate
 *
 * §4.6's two reasons — `'single-frame'` and `'no-motion-content'` — are `motionApplicability`'s, in
 * `quality/index.ts`, and the aggregator does not call this analyzer at all when it fires. Measured
 * honestly an identical sequence is a **perfect** animation: churn is 0 everywhere, the seam is 0,
 * and `seamRatio` is `0 / max(1, 0)`. A dimension asked to score it would return its best possible
 * band, `scoreQ: 1000`, for a sprite that does not move. There is no version of this function that
 * can avoid that from the inside, because the information that its input is degenerate is exactly
 * the information its own measurement is blind to. So the branch does not exist here at all, and
 * {@link MotionSequence.measured} is false only for a sequence with no ink anywhere, which cannot
 * reach the analyzer either (two blank frames are byte-identical).
 *
 * ## Units
 *
 * Every ratio is per-mille (§3.7) and every comparison an exact integer test. The one quantity that
 * is *not* per-mille is the seam ratio itself, and §4.6 already gives the integer form that keeps it
 * off floats: `seam * 20 <= K * m`, where `K` is the ratio's hundredths doubled and `m` is the
 * matching median. Nothing in this file divides two integers to decide anything.
 *
 * ## The one guard, and it is the `outline` lesson applied before it was needed
 *
 * `outline` shipped per-frame Δ rows that asked about a contour which might not exist, and had to put
 * a gate in front of them. The same hazard is here and it is sharper: **a frame with no ink has no
 * centroid and no area**, so an unguarded `areaSpread` over a sheet containing a blank frame reads
 * `(max - 0) / mean` — a per-mille 1000 on a document whose real defect is `empty-frame`, which the
 * aggregator already reports at severity 1.00. {@link MotionSequence.inkedFrames} is the guard:
 * zero-area frames are excluded from the area and centroid statistics and from nothing else. Churn
 * keeps them, because a frame going blank *is* a change of that many pixels and the churn reading
 * about it is true.
 *
 * The consequence is stated rather than hidden: on a sheet where fewer than two frames carry ink,
 * the area and centroid rows have nothing to compare and stay silent. That is an absence no
 * `ExcludedReason` names, and the reason it is not named is that the only way to reach it is a
 * document the aggregator has already blocked on `empty-frame`. §4.6's own `unmeasured` vocabulary
 * is a whole-dimension absence and there is nothing dimension-level to abstain from here.
 */

/* ------------------------------------------------------------------ *
 * Thresholds, transcribed from §4.6
 * ------------------------------------------------------------------ */

/**
 * §4.6's seam-ratio band table, stored **ascending bound** with the bound as `K` in `seam * 20 <= K * m`.
 *
 * **Read with a `return` on the first match, which is the opposite of `outline`'s table and the
 * right way round for this one.** The two tables have opposite shapes: `outlineShare` rewards a
 * *high* ratio, so its rows are walked upward and the last match wins; the seam ratio punishes a
 * *high* ratio, so its rows are walked upward and the **first** match wins. Reading either of them
 * in the other's direction is the §4.4 defect this repository has already paid for once — a
 * descending list walked with `for`-and-`return` gives a ratio of 0 the loosest row.
 *
 * **What this table returns at ratio 0, and why that is right.** `seam = 0` clears `0 <= 27 * m` for
 * any non-negative `m`, including `m = 0`, so a loop whose seam changes nothing scores **1000** —
 * the best band. That is not the fake-perfect score §4.6's applicability exists to prevent: the
 * degenerate sequence that would earn a perfect mark dishonestly never reaches this function, and a
 * loop with real internal transitions and a seam that changes nothing has earned it. The direction
 * of this table is pinned by a test that asserts 1000 at ratio 0 and 250 past the last bound.
 */
const SEAM_BANDS: readonly (readonly [number, number])[] = [
  [27, 1000],
  [35, 880],
  [50, 720],
  [80, 500],
];

/** §4.6's `> 4.00` row: `80 * m`, reached by falling off the end of {@link SEAM_BANDS}. */
const SEAM_FLOOR_Q = 250;

/**
 * §4.6's top band, and what a sequence with no ink reports.
 *
 * A named constant rather than `SEAM_BANDS[0][1]` because this is also the score for "there is
 * nothing here", and reading a row of a band table to mean "no measurement happened" is how a
 * perfect mark gets handed out for an absence — the failure §4.6's applicability exists to prevent.
 */
const SEAM_TOP_Q = 1000;

/** §4.6's `loop-seam-pop` trigger: `seam * 20 > 35 * m`, i.e. the ratio is past 1.75. */
const SEAM_POP_K = 35;
/** §4.6's blocking half of the same row: `seam * 20 > 50 * m`, i.e. the ratio is past 2.50. */
const SEAM_POP_BLOCKING_K = 50;

/** §4.6's `silhouette-instability` steps, per-mille of `areaSpread`. */
const AREA_HEAVY_Q = 150;
const AREA_LIGHT_Q = 60;

/** §4.6's `churnMax > 2 * churnMedian`, and `seamStep > 1.5 * maxStep`. */
const CHURN_JITTER_FACTOR = 2;
const SEAM_JUMP_NUM = 3;
const SEAM_JUMP_DEN = 2;

/** §4.6's `seamStep >= 64`, i.e. 1.0px, because the centroid is in 1/64 px fixed point. */
const ONE_PIXEL_Q = 64;

/** §4.6's `timing-outlier` and `timing-mismatch` rows, per-mille of `deltaSpread`. */
const DURATION_OUTLIER_FACTOR = 3;
const DELTA_SPREAD_MISMATCH_Q = 600;

/** §4.6's `loopMs` window, in milliseconds. */
const LOOP_MS_MIN = 80;
const LOOP_MS_MAX = 1200;

/** §4.6's six Δ values, per-mille off the band base. */
const DELTA_AREA_HEAVY = 200;
const DELTA_AREA_LIGHT = 80;
const DELTA_CHURN_JITTER = 150;
const DELTA_SEAM_JUMP = 150;
const DELTA_TIMING_OUTLIER = 100;
const DELTA_LOOP_DURATION = 100;
const DELTA_TIMING_MISMATCH = 100;

/** §4.6's `timing-outlier` row is one Δ however many frames are outliers; recorded, not summed per frame. */
const MAX_TIMING_OUTLIERS = 1;

/* ------------------------------------------------------------------ *
 * The measurement record
 * ------------------------------------------------------------------ */

/**
 * Every integer quantity §4.6's "How it is measured" block names, for one sequence.
 *
 * A record and not a bare score, for `silhouette`'s reason: an agent can act on
 * "`churnMedian` is 34 and the seam is 96" and cannot act on 500.
 */
export interface MotionSequence {
  /** False when no frame in the sequence carries ink. Such a sequence scores 1000 and says so. */
  readonly measured: boolean;
  /** The number of frames the measurement walked, in playback order. */
  readonly frames: number;
  /** How many of those frames carry ink. Zero-area frames are excluded from the area/centroid rows. */
  readonly inkedFrames: number;
  /**
   * §4.6's `churn_i` for every transition, including the seam at index `frames - 1`.
   * `churn(f_i) XOR mask(f_{i+1})`, and the last entry wraps to frame 0.
   */
  readonly churn: readonly number[];
  /** §4.6's `churnMedian`: the lower median of the **internal** transitions `churn_0..churn_{n-2}`. */
  readonly churnMedian: number;
  /** The largest **internal** churn. The seam is excluded on purpose — see {@link SEAM_BANDS}. */
  readonly churnMax: number;
  /** §4.6's `churn_{n-1}`, the loop point. */
  readonly seam: number;
  /** §4.6's `lumDelta_i`, rounded by `rhu`, for every transition including the seam. `0` where the two frames share no ink. */
  readonly lumDelta: readonly number[];
  /** The lower median of the internal `lumDelta`s. */
  readonly lumMedian: number;
  /** §4.6's `lumDelta_{n-1}`. */
  readonly lumSeam: number;
  /** §4.6's `area_i`, one per frame, in playback order. */
  readonly areas: readonly number[];
  /** `areaSpread`, per-mille: `rhu((max - min) * 1000, mean)` over the inked frames. */
  readonly areaSpreadQ: number;
  /** Per-frame `durationMs` in playback order, from `context.sprite.frames`. */
  readonly durations: readonly number[];
  /** §4.6's `loopMs`: the sum of the sequence's durations. */
  readonly loopMs: number;
  /** `deltaSpread`, per-mille, over the internal `lumDelta`s. `0` when they are all equal or all zero. */
  readonly deltaSpreadQ: number;
  /** §4.6's `seamStep`: Chebyshev distance from `centroid(f_{n-1})` to `centroid(f_0)`, in 1/64 px. */
  readonly seamStep: number;
  /** §4.6's `maxStep`: the largest in-loop centroid step, same units. */
  readonly maxStep: number;
  /** True when the primary ratio came from luminance rather than from the silhouette mask. */
  readonly lumPrimary: boolean;
  /** The band base §4.6's table returned, before the Δ adjustments. */
  readonly baseQ: number;
  /** The sum of the Δ adjustments, negative or zero. */
  readonly adjustmentQ: number;
  readonly scoreQ: number;
  readonly issues: readonly QualityIssue[];
}

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

/**
 * §4.6's band lookup, read **ascending with a `return`**.
 *
 * See {@link SEAM_BANDS} for why this is not `outline`'s lookup. `m = 0` is not a special case:
 * `seam * 20 <= K * 0` is `0 <= 0` when the seam is also empty, so a still-and-still sequence reads
 * 1000 here — and never reaches the analyzer, so the number is not delivered.
 */
function bandFor(seam: number, m: number): number {
  for (const [k, score] of SEAM_BANDS) {
    if (seam * 20 <= k * m) return score;
  }
  return SEAM_FLOOR_Q;
}

/** §4.6's "mean" over a set of integers, in the integer form §3.7 requires. `0` on an empty set. */
function meanQ(sum: number, count: number): number {
  return count === 0 ? 0 : rhu(sum, count);
}

/**
 * The **lower** median, so a median of an even-length set is the smaller of the two middle values.
 *
 * The same reading `benchmarks/corpus/report.ts`'s `distribute` uses, and chosen for that reason
 * rather than for any property of its own: two medians in one repository is one too many. Every
 * input here is an integer count, so there is no rounding question and the choice only decides which
 * of two adjacent integers a set of even length reports.
 */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

/* ------------------------------------------------------------------ *
 * The measurement
 * ------------------------------------------------------------------ */

/**
 * `motion` over the whole sequence, in playback order.
 *
 * Exported as the shared measurement for `quality-motion.test.ts` and for the corpus report, for
 * `noise`'s and `palette`'s reason: an assertion about a reading belongs on the analyzer rather than
 * on the markdown this repository regenerates and diffs byte for byte.
 */
export function measureMotion(context: QualityContext): MotionSequence {
  const { width, height, composite } = context;
  const n = composite.length;
  const empty = (measured: boolean, inkedFrames: number): MotionSequence => ({
    measured,
    frames: n,
    inkedFrames,
    churn: [],
    churnMedian: 0,
    churnMax: 0,
    seam: 0,
    lumDelta: [],
    lumMedian: 0,
    lumSeam: 0,
    areas: [],
    areaSpreadQ: 0,
    durations: [],
    loopMs: 0,
    deltaSpreadQ: 0,
    seamStep: 0,
    maxStep: 0,
    lumPrimary: false,
    baseQ: SEAM_TOP_Q,
    adjustmentQ: 0,
    scoreQ: SEAM_TOP_Q,
    issues: [],
  });

  if (n === 0) return empty(false, 0);

  /* --- per-frame masks, areas and centroids --- */
  const masks: Uint8Array[] = [];
  const areas: number[] = [];
  /** Centroid in 1/64 px fixed point, `null` where the frame carries no ink. */
  const centroids: ({ x: number; y: number } | null)[] = [];
  for (let i = 0; i < n; i++) {
    const { mask, solid } = buildSolidMask(composite[i], width, height);
    masks.push(mask);
    areas.push(solid);
    if (solid === 0) {
      centroids.push(null);
      continue;
    }
    let sumX = 0;
    let sumY = 0;
    for (let p = 0; p < mask.length; p++) {
      if (mask[p] !== 1) continue;
      const x = p % width;
      sumX += x;
      sumY += (p - x) / width;
    }
    // §4.6's fixed point: the centroid is carried in 1/64 px so every later step is an integer.
    centroids.push({ x: rhu(sumX * ONE_PIXEL_Q, solid), y: rhu(sumY * ONE_PIXEL_Q, solid) });
  }

  const inkedFrames = centroids.reduce((n2, c) => (c === null ? n2 : n2 + 1), 0);
  if (inkedFrames === 0) return empty(false, 0);

  /* --- `churn_i` and `lumDelta_i`, cyclic so the last entry is the seam --- */
  const churn: number[] = [];
  const lumDelta: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = composite[i];
    const b = composite[(i + 1) % n];
    const ma = masks[i];
    const mb = masks[(i + 1) % n];
    let changed = 0;
    let lumSum = 0;
    let lumCount = 0;
    for (let p = 0; p < ma.length; p++) {
      const solidA = ma[p] === 1;
      const solidB = mb[p] === 1;
      if (solidA !== solidB) {
        changed++;
        continue;
      }
      // §4.6 restricts the luminance reading to pixels solid in **both** frames, so a pixel that
      // merely appeared or vanished is churn and not a tone change. `lumCount === 0` — one frame
      // blank — contributes `0`, and `meanQ` is what says so rather than a division by zero.
      if (solidA) {
        lumSum += Math.abs(lqOf(a, p) - lqOf(b, p));
        lumCount++;
      }
    }
    churn.push(changed);
    lumDelta.push(meanQ(lumSum, lumCount));
  }

  /* --- the medians, and the internal/seam split --- */
  const internalChurn = churn.slice(0, n - 1);
  const internalLum = lumDelta.slice(0, n - 1);
  const churnMedian = median(internalChurn);
  const lumMedian = median(internalLum);
  const churnMax = internalChurn.length === 0 ? 0 : Math.max(...internalChurn);
  const seam = n === 0 ? 0 : churn[n - 1];
  const lumSeam = n === 0 ? 0 : lumDelta[n - 1];

  /* --- `areaSpread`, over the inked frames only (the `outline` guard) --- */
  const inkedAreas = areas.filter((area) => area > 0);
  const areaSpreadQ =
    inkedAreas.length < 2
      ? 0
      : rhu(
          (Math.max(...inkedAreas) - Math.min(...inkedAreas)) * 1000,
          meanQ(inkedAreas.reduce((s, a) => s + a, 0), inkedAreas.length),
        );

  /* --- centroid steps, likewise over the inked frames only --- */
  let seamStep = 0;
  let maxStep = 0;
  const inkedCentroids = centroids.filter((c): c is { x: number; y: number } => c !== null);
  if (inkedCentroids.length >= 2) {
    const chebyshev = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
      Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    seamStep = chebyshev(inkedCentroids[inkedCentroids.length - 1], inkedCentroids[0]);
    for (let i = 1; i < inkedCentroids.length; i++) {
      const step = chebyshev(inkedCentroids[i], inkedCentroids[i - 1]);
      if (step > maxStep) maxStep = step;
    }
  }

  /* --- timing --- */
  const durations = context.frameIds.map(
    (id) => context.sprite.frames.find((frame) => frame.id === id)?.durationMs ?? 0,
  );
  const loopMs = durations.reduce((sum, ms) => sum + ms, 0);
  const medianDuration = median(durations);
  const outlierCount = durations.filter((ms) => ms > DURATION_OUTLIER_FACTOR * medianDuration).length;
  const allDurationsEqual = durations.every((ms) => ms === durations[0]);
  const lumMax = internalLum.length === 0 ? 0 : Math.max(...internalLum);
  const lumMin = internalLum.length === 0 ? 0 : Math.min(...internalLum);
  const deltaSpreadQ = lumMax === 0 ? 0 : rhu((lumMax - lumMin) * 1000, lumMax);

  /* --- which ratio is the primary one --- */
  // §4.6: "the larger of `seamRatio` and `lumSeamRatio`", compared by cross-multiplication so the
  // decision is an integer one. The `max(1, ·)` in each denominator is §4.6's own and is applied
  // to the *other* signal's denominator on both sides, which is what makes the comparison exact.
  const churnDen = Math.max(1, churnMedian);
  const lumDen = Math.max(1, lumMedian);
  const lumPrimary = lumSeam * churnDen > seam * lumDen;
  const baseQ = bandFor(lumPrimary ? lumSeam : seam, lumPrimary ? lumDen : churnDen);
  const seamPop = lumPrimary ? lumSeam * 20 > SEAM_POP_K * lumDen : seam * 20 > SEAM_POP_K * churnDen;
  const seamPopBlocking = lumPrimary
    ? lumSeam * 20 > SEAM_POP_BLOCKING_K * lumDen
    : seam * 20 > SEAM_POP_BLOCKING_K * churnDen;

  /* --- the Δ rows, §4.6's table verbatim --- */
  const issues: QualityIssue[] = [];
  let adjustmentQ = 0;

  if (areaSpreadQ > AREA_HEAVY_Q) {
    adjustmentQ -= DELTA_AREA_HEAVY;
    issues.push({
      code: 'silhouette-instability',
      message: `the silhouette's area moves by ${areaSpreadQ}/1000 across the cycle (${Math.min(...inkedAreas)}..${Math.max(...inkedAreas)} px). A character whose area flickers reads as a strobe, and hitbox math built on a moving silhouette is a bug source.`,
      rect: null,
      severity: 0.6,
    });
  } else if (areaSpreadQ > AREA_LIGHT_Q) {
    adjustmentQ -= DELTA_AREA_LIGHT;
    issues.push({
      code: 'silhouette-instability',
      message: `the silhouette's area moves by ${areaSpreadQ}/1000 across the cycle (${Math.min(...inkedAreas)}..${Math.max(...inkedAreas)} px). It is not enough to read as a strobe yet, but it is enough to see on the third loop.`,
      rect: null,
      severity: 0.3,
    });
  }

  if (internalChurn.length > 0 && churnMax > CHURN_JITTER_FACTOR * churnMedian) {
    adjustmentQ -= DELTA_CHURN_JITTER;
    issues.push({
      code: 'frame-jitter',
      message: `one internal transition changes ${churnMax} pixels against a median of ${churnMedian} — more than twice as much as any other. A frame that jumps rather than moves is the stutter you see once per cycle.`,
      rect: null,
      severity: 0.5,
    });
  }

  // Both halves of §4.6's clause, and the second is what stops a stationary loop from firing:
  // a sprite that does not move has `seamStep == maxStep == 0`, which fails `1.5 * maxStep` and
  // would otherwise pass the 1px test on a frame that never went anywhere.
  if (seamStep * SEAM_JUMP_DEN > maxStep * SEAM_JUMP_NUM && seamStep >= ONE_PIXEL_Q) {
    adjustmentQ -= DELTA_SEAM_JUMP;
    issues.push({
      code: 'loop-seam-jump',
      message: `the loop closes with the body ${(seamStep / ONE_PIXEL_Q).toFixed(2)}px from where it started, against a largest in-loop step of ${(maxStep / ONE_PIXEL_Q).toFixed(2)}px. The return is drawn a step off, and no contact sheet will show it.`,
      rect: null,
      severity: 0.55,
    });
  }

  if (outlierCount > 0) {
    adjustmentQ -= DELTA_TIMING_OUTLIER * Math.min(outlierCount, MAX_TIMING_OUTLIERS);
    issues.push({
      code: 'timing-outlier',
      message: `${outlierCount} of ${plural(durations.length, 'frame')} ${outlierCount === 1 ? 'is' : 'are'} held more than ${DURATION_OUTLIER_FACTOR}x the median ${medianDuration}ms — a dwell the eye reads as a stutter rather than as emphasis.`,
      rect: null,
      severity: 0.35,
    });
  }

  if (loopMs < LOOP_MS_MIN || loopMs > LOOP_MS_MAX) {
    adjustmentQ -= DELTA_LOOP_DURATION;
    issues.push({
      code: 'loop-duration-out-of-range',
      message: `the cycle is ${loopMs}ms, outside the ${LOOP_MS_MIN}..${LOOP_MS_MAX}ms window. Under ${LOOP_MS_MIN}ms the loop reads as a flicker; over ${LOOP_MS_MAX}ms it stops reading as a cycle at all.`,
      rect: null,
      severity: 0.3,
    });
  }

  if (allDurationsEqual && deltaSpreadQ >= DELTA_SPREAD_MISMATCH_Q) {
    adjustmentQ -= DELTA_TIMING_MISMATCH;
    issues.push({
      code: 'timing-mismatch',
      message: `every frame is held for the same ${durations[0]}ms while the amount of change between frames varies by ${deltaSpreadQ}/1000. Uniform timing over uneven motion reads as a slide through stills rather than as a movement.`,
      rect: null,
      severity: 0.45,
    });
  }

  // `loop-seam-pop` is the one §4.6 code with **no Δ row**: the band table has already priced the
  // pop, and this is the code that names it. Severity 0.55 — blocking — only past 2.50.
  if (seamPop) {
    issues.push({
      code: 'loop-seam-pop',
      message:
        seamPopBlocking === false
          ? `the loop seam changes more than 1.75x any internal transition (${seam} px against a median of ${churnMedian}, and ${lumSeam} against ${lumMedian} in tone). It is a hitch rather than a break.`
          : `the loop seam changes more than 2.5x any internal transition (${seam} px against a median of ${churnMedian}, and ${lumSeam} against ${lumMedian} in tone). The cycle pops once per cycle.`,
      rect: null,
      severity: seamPopBlocking ? 0.55 : 0.3,
    });
  }

  const scoreQ = Math.max(0, baseQ + adjustmentQ);

  return {
    measured: true,
    frames: n,
    inkedFrames,
    churn,
    churnMedian,
    churnMax,
    seam,
    lumDelta,
    lumMedian,
    lumSeam,
    areas,
    areaSpreadQ,
    durations,
    loopMs,
    deltaSpreadQ,
    seamStep,
    maxStep,
    lumPrimary,
    baseQ,
    adjustmentQ,
    scoreQ,
    issues: issues.sort(
      (a, b) =>
        b.severity - a.severity ||
        (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
    ),
  };
}

/**
 * `motion` — one score for the whole sequence, because the question *is* the sequence.
 *
 * ## Why there is no per-frame score and no worst-frame rule
 *
 * `silhouette`, `noise`, `outline` and `palette` all take the worst frame, and every one of them
 * explains why: a defect that is per-pixel is still a defect when only one frame has it. §4.6's
 * defects are **not** per-pixel — they are statements about a *relationship* between frames, and
 * `QualityDimension` has one `scoreQ` and no way to say "five of these six transitions are fine".
 * A per-frame `motion` score would also be meaningless: `seamRatio` on frame 3 of a six-frame cycle
 * is a ratio against a median the other five frames supply, so slicing the sequence changes the
 * measurement rather than narrowing it. This is the one dimension with no worst-frame rule, and it
 * is a property of the question rather than an omission.
 *
 * ## There is no abstention here either
 *
 * The analyzer is never reached on a sequence §4.6 excludes, so there is no branch that could hand
 * back a neutral mark or a code for an absence. What it does return for a sequence with no ink
 * anywhere is `measured: false` and 1000 with a verdict that says so — and that sequence cannot
 * reach it, because two blank frames are byte-identical and {@link MotionSequence}'s exclusion would
 * have fired.
 */
export const motionAnalyzer: QualityAnalyzer = (context: QualityContext): QualityDimension => {
  const motion = measureMotion(context);

  if (!motion.measured) {
    return {
      scoreQ: 1000,
      verdict:
        motion.frames === 0
          ? 'nothing to measure: the context carries no frames.'
          : `nothing opaque to measure on any of the ${plural(motion.frames, 'frame')}; there is no movement to follow.`,
      issues: [],
      unmeasured: {},
    };
  }

  const seamSide = motion.lumPrimary ? 'luminance' : 'silhouette';
  const seam = motion.lumPrimary ? motion.lumSeam : motion.seam;
  const medianValue = motion.lumPrimary ? motion.lumMedian : motion.churnMedian;
  const parts = [
    `loop seam changes ${seam} ${seamSide === 'luminance' ? 'Lq units' : 'px'} against a median of ${medianValue}`,
    `seamStep ${(motion.seamStep / ONE_PIXEL_Q).toFixed(2)}px against a largest in-loop step of ${(motion.maxStep / ONE_PIXEL_Q).toFixed(2)}px`,
    `areaSpread ${motion.areaSpreadQ}/1000`,
    `${motion.loopMs}ms over ${plural(motion.frames, 'frame')}`,
  ];
  if (motion.lumPrimary) parts.push('the tone channel carried the pop');

  return {
    scoreQ: motion.scoreQ,
    verdict: `${parts.join(', ')}.`,
    issues: motion.issues,
    unmeasured: {},
  };
};

export default motionAnalyzer;
