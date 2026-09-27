/**
 * Running the corpus, and the report it produces.
 *
 * This is the part that decides whether the corpus is a **guard** or a **report**, and the
 * difference is entirely in `CorpusRun.failures`: a corpus that prints a table of numbers and
 * fails nothing is documentation, and a table of numbers is the failure mode this task most
 * risks. Every declared expectation is compared, every mismatch is a failure, and the generated
 * markdown is a committed baseline that the test compares against — so a score that moves is a
 * diff in a file a reviewer reads, not a log line scrolled past.
 *
 * ## What each case is compared against, and why that is not circular
 *
 * The expectations in `cases.json` are derived by hand from `docs/EVALUATION.md` §4.1 and §3.3
 * and the declared geometry of the case — `N` from a rectangle's area, `perimeter` from
 * `2(w + h)`, `compactnessQ` from `min(1000, rhu(4 * 355 * 1000 * N, 113 * P * P))`,
 * `scoreQ` from the band table and the adjustment list. They are *not* copied out of the
 * pipeline's output. §6.1 is explicit that labelling a corpus with the thing it calibrates
 * measures self-consistency rather than validity, and a corpus whose expected values were read
 * off the implementation is that, whatever else it is.
 *
 * Where a quantity cannot be derived from the specification and the geometry — the number of
 * 4-connected components in a rasterised outline, say — it is **recorded** in the report and
 * **not** asserted, and the corpus says so rather than leaving a reader to guess which columns
 * are ground truth and which are a transcript.
 *
 * ## The report is a baseline, and the distribution is the point
 *
 * Two artefacts come out of one run, and the second is the more valuable one:
 *
 *   1. The per-case table — a regression guard. A mismatch fails.
 *   2. The **distribution** of `compactnessQ` across every subject in the corpus, with the gate
 *      marked and the one real human-relevant measurement in this repository placed in it. That
 *      is what a gate move has to be based on: `docs/EVALUATION.md` §6.2's standing rule is that
 *      "a new threshold is a hypothesis until it has been run against a designed contrast", and
 *      two tasks have now declined to move the `compactnessQ` gate because a distribution of one
 *      sample is not evidence. **This file moves no gate.** It produces the numbers and names
 *      them; T-022 and T-026 own the decision, and a threshold is a product decision.
 */

import { aggregatorIssues, evaluate, motionApplicability, requiresReadableSubject, type ExcludedReason, type QualityReport } from '../../packages/core/src/quality/index.js';
import { createQualityContext } from '../../packages/core/src/quality/context.js';
import { measureSilhouette, type SilhouetteFrame } from '../../packages/core/src/quality/silhouette.js';
import {
  QUALITY_DIMENSIONS,
  type QualityContext,
  type QualityDimensionId,
} from '../../packages/core/src/quality/types.js';
import { buildSolidMask, connectedComponents, countConvexStaircaseCorners, edgePixelCount } from '../../packages/core/src/quality/measure.js';
import { measureValue } from '../../packages/core/src/quality/value.js';
import type { Sprite } from '../../packages/core/src/index.js';
import {
  DECLARED_QUANTITIES,
  DERIVED_POLICY,
  SPEC_GATES,
  type CorpusCase,
  type CorpusScores,
  type CorpusSpec,
  type ExcludedReason as CorpusExcludedReason,
  type MeasuredQuantity,
} from './format.js';
import { buildCorpus } from './build.js';

/* ------------------------------------------------------------------ *
 * Preconditions
 * ------------------------------------------------------------------ */

/**
 * The aggregator's applicability predicates, by dimension id.
 *
 * Called directly rather than read out of `report.excluded`, because `evaluate` records
 * `'not-implemented'` for every dimension that has no analyzer and `'no-motion-content'` for
 * `motion` is unreachable until T-017 lands. The predicates are the aggregator's exported
 * functions, they are what `evaluate` consults, and they are the contract; which of them has
 * fired today is a fact about the build, and the report shows both so the difference is visible
 * instead of inferred.
 */
const PRECONDITIONS: Readonly<Record<string, (context: QualityContext) => CorpusExcludedReason | null>> = {
  silhouette: requiresReadableSubject as (context: QualityContext) => CorpusExcludedReason | null,
  motion: motionApplicability as (context: QualityContext) => CorpusExcludedReason | null,
};

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

/** One frame's measurement, in the shape the report prints and the distribution aggregates. */
export interface FrameReading {
  readonly index: number;
  readonly N: number;
  readonly components: number;
  readonly largest: number;
  readonly shareQ: number;
  readonly strayPixels: number;
  readonly perimeter: number;
  readonly subjectPerimeter: number;
  readonly edgePixels: number;
  readonly compactnessQ: number;
  /** The subject's largest inscribed square, in pixels. Absolute, so it is a second question. */
  readonly thicknessPx: number;
  readonly thicknessQ: number;
  /** `min(compactnessQ, thicknessQ)` — the number `thin-profile` bands on. */
  readonly profileQ: number;
  readonly holeCount: number;
  readonly holeArea: number;
  readonly borderTouch: number;
  readonly spanQ: number;
  readonly convexCorners: number;
  readonly partialAlpha: number;
  readonly scoreQ: number;
  /** A tight bounding box, or `null` on an empty frame. */
  readonly bounds: { x: number; y: number; w: number; h: number } | null;
  /** The transparent margin on the tightest side, in pixels. Derived from `bounds`, not re-measured. */
  readonly margin: number | null;
  /**
   * §3.3's `convexCorner` as `value` measures it — a pixel on a convex 45-degree staircase —
   * beside the spec-literal count `frame.convexCorners`, which is 0 on every shape in this
   * repository. Both numbers are printed on every row so the two definitions of one §3.3 name
   * are visible side by side in a committed file rather than argued about in prose.
   */
  readonly stairCorners: number;
}

/**
 * The `value` quantities, worst frame, in the shape the report prints them.
 *
 * `worstSpanQ` is the quantity §4.2 *specified* as the form term and this build does not score.
 * It is here so the reason stays legible: it reads high on the artwork that is correct, which is
 * the level-set bias measured rather than asserted, and a baseline that printed only the score
 * would hide the evidence for the score.
 *
 * `worstCurvedQ` and `worstReachQ` are §4.2's two gates, recorded on the same row, because they
 * are the two numbers that say the form term is **inert** wherever there is no silhouette to read:
 * `curvedQ` counts `edgePixel`s near the plane, and a full-bleed subject has none. They are
 * printed rather than summarised in prose so the finding is re-measured on every run instead of
 * being a paragraph in a comment somebody trusts.
 */
export interface ValueReading {
  readonly index: number;
  readonly scoreQ: number;
  readonly toneQ: number;
  /**
   * `null` when the subject has no outline for §4.2's curvature gate to read. It was a `number` and
   * it was 1000 on all ten full-bleed artworks, which is the finding T-099 is about: a perfect
   * score for a measurement nobody took, printed on a row in a committed file where it read as
   * evidence.
   */
  readonly formQ: number | null;
  readonly distinct: number;
  readonly range: number;
  readonly regions: number;
  readonly planes: number;
  readonly terminators: number;
  readonly worstCrossesQ: number | null;
  readonly worstBendQ: number | null;
  readonly worstSpanQ: number | null;
  /** §4.2's curvature gate, `curvedQ >= 250`. The maximum over every plane, 0..77 on all ten scenes. */
  readonly maxCurvedQ: number | null;
  /** §4.2's reach gate, `reachQ >= 500`. The maximum over every plane. */
  readonly maxReachQ: number | null;
  /**
   * How many planes were not judged, split by which gate closed.
   *
   * The one-line form of the T-099 finding: a full-bleed scene reads `145 curvature` here, which
   * says "of 145 tone boundaries, every one was exempt and here is why" without a reader having to
   * compare `curvedQ max` against the gate themselves. `0/0` is a frame where every plane was
   * judged, which is the only combination that means the term had a real opinion.
   */
  readonly gated: string;
  readonly Dmax: number;
  readonly keyLight: number | null;
  readonly hueOnlyQ: number;
  /**
   * `shadowShareQ` and `highlightShareQ`: the shares the two tone-extreme codes are about.
   *
   * §4.2's `shadow-crushed` fires at 30/100 of the solid pixels and its `highlight-blown` at
   * 10/100, and a report that prints `keyLight` and `hueOnlyQ` but not the shares cannot show a
   * reader how close a subject is to either threshold. Two columns, because both codes exist.
   */
  readonly shadowShareQ: number;
  readonly highlightShareQ: number;
}

/** How a case ended. The three are not gradations: `awaiting-rating` is not a pass. */
export type RowStatus = 'pass' | 'fail' | 'awaiting-rating';

export interface CorpusRow {
  readonly id: string;
  readonly label: string;
  readonly tier: CorpusCase['tier'];
  readonly status: RowStatus;
  /** Why it failed, one entry per mismatch, each naming the expectation and what it got. */
  readonly failures: readonly string[];
  /** Every issue code the report carries, from the present dimensions and the aggregator. */
  readonly actualCodes: readonly string[];
  readonly expectedCodes: readonly string[] | null;
  readonly absent: readonly string[];
  readonly actualVerdict: QualityReport['verdict'] | null;
  readonly expectedVerdict: QualityReport['verdict'] | null;
  readonly blocking: readonly string[];
  /** Dimension -> per-mille score, for the dimensions that were present. */
  readonly scores: Readonly<Partial<Record<QualityDimensionId, number>>>;
  /** The aggregator's own `excluded` map, verbatim. */
  readonly excluded: Readonly<Record<string, ExcludedReason>>;
  /**
   * Every measured dimension's own `unmeasured` entries, flattened to `dimension.subScore`.
   *
   * Carried through rather than recomputed, because the whole value of it is that it comes from
   * the analyzer that did (or did not) measure: a report that re-derived "this looks unmeasured"
   * from the numbers would be re-deriving the bug it exists to catch.
   */
  readonly unmeasured: Readonly<Record<string, ExcludedReason>>;
  /** The applicability predicates, called directly. */
  readonly preconditions: Readonly<Record<string, CorpusExcludedReason | null>>;
  readonly frames: readonly FrameReading[];
  /**
   * The worst frame's `value` reading, or `null` where nothing opaque was measured. Recorded even
   * when `value` is applicable and quiet, because §4.2's form term is the claim the corpus exists
   * to check and a reader has to be able to see `bendQ` and the unscored `spanQ` to check it.
   */
  readonly value: ValueReading | null;
  /** The worst frame's score, the mean, and whether the analyzer took the minimum. */
  readonly worstScoreQ: number | null;
  /** `compactnessQ` of the frame that decided `worstScoreQ`, for the contrast-pair report. */
  readonly worstFrameCompactnessQ: number | null;
  /** `thicknessQ` of the same frame. The scale-aware reading, beside the shape one. */
  readonly worstFrameThicknessQ: number | null;
  /** `profileQ` of the same frame: the worse of the two, which is what the gate bands on. */
  readonly worstFrameProfileQ: number | null;
  readonly meanScoreQ: number | null;
  readonly tookMin: boolean | null;
  readonly connectivity: { four: number; eight: number } | null;
  /**
   * The §6.2 contrast-pair groups, one name per group. A list, and never `null`: a case with no
   * pair belongs to none, and `[]` says that without a second null check at every reader. See
   * `SyntheticCase.pair` for why a case can be in more than one.
   */
  readonly pair: readonly string[];
  /** Objective attributes a rater is never left guessing. Never the machine's opinion. */
  readonly attributes: { readonly width: number; readonly height: number; readonly frames: number; readonly palette: number; readonly tags: number };
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

export interface CorpusRun {
  readonly spec: CorpusSpec;
  readonly scores: CorpusScores;
  readonly rows: readonly CorpusRow[];
  /** One entry per mismatch across every case. Empty means the corpus is holding. */
  readonly failures: readonly { readonly id: string; readonly reason: string }[];
  readonly markdown: string;
}

/** Build every case, evaluate it, compare it, and render the report. */
export function runCorpus(spec: CorpusSpec, scores: CorpusScores): CorpusRun {
  const built = buildCorpus(spec);
  const rows = built.map(({ entry, sprite }) => evaluateCase(entry, sprite));
  const failures = rows.flatMap((row) => row.failures.map((reason) => ({ id: row.id, reason })));
  return { spec, scores, rows, failures, markdown: renderMarkdown(spec, scores, rows) };
}

function evaluateCase(entry: CorpusCase, sprite: Sprite | null): CorpusRow {
  // The objective attributes come first and are the only thing a human-tier case reports. The
  // analyzer's own numbers are withheld there on purpose: T-025 correlates the machine's score
  // against a human's, and a rater who has seen the score is anchored to it, which would make
  // the correlation a measurement of anchoring.
  if (entry.tier === 'human') {
    return {
      id: entry.id,
      label: entry.label,
      tier: 'human',
      status: 'awaiting-rating',
      failures: [],
      actualCodes: [],
      expectedCodes: null,
      absent: [],
      actualVerdict: null,
      expectedVerdict: null,
      blocking: [],
      scores: {},
      excluded: {},
      unmeasured: {},
      preconditions: {},
      frames: [],
      value: null,
      worstScoreQ: null,
      worstFrameCompactnessQ: null,
      worstFrameThicknessQ: null,
      worstFrameProfileQ: null,
      meanScoreQ: null,
      tookMin: null,
      connectivity: null,
      pair: [],
      attributes: attributesOf(sprite),
    };
  }

  if (sprite === null) throw new Error(`corpus: ${entry.id} is not a real case and produced no document`);
  const context = createQualityContext(sprite);
  const report = evaluate(context);
  const measurements = measureSilhouette(context);
  const readings = measurements.map((frame) => readingOf(context, frame));
  const valueFrames = measureValue(context);
  const valueMeasured = valueFrames.filter((frame) => frame.measured);
  let worstValue = valueMeasured[0] ?? null;
  for (const frame of valueMeasured) {
    if (worstValue === null || frame.scoreQ < worstValue.scoreQ) worstValue = frame;
  }
  const value: ValueReading | null =
    worstValue === null
      ? null
      : {
          index: worstValue.index,
          scoreQ: worstValue.scoreQ,
          toneQ: worstValue.toneQ,
          formQ: worstValue.formQ,
          distinct: worstValue.distinct,
          range: worstValue.range,
          regions: worstValue.regions,
          planes: worstValue.planes,
          terminators: worstValue.terminators.length,
          worstCrossesQ: worstValue.worst === null ? null : worstValue.worst.crossesQ,
          worstBendQ: worstValue.worst === null ? null : worstValue.worst.bendQ,
          worstSpanQ: worstValue.worst === null ? null : worstValue.worst.spanQ,
          // **Maxima over every plane, not the worst plane's readings.** The two gate columns exist
          // to keep the T-099 finding re-measured on every run, and the finding is *about* the rows
          // where no plane was judged — so reading them off the worst plane prints `-` on exactly
          // the rows that need the evidence. A maximum answers the question the column is for: how
          // close did the most favourable plane come to being judged?
          maxCurvedQ: maxOf(worstValue.terminators.map((term) => term.curvedQ)),
          maxReachQ: maxOf(worstValue.terminators.map((term) => term.reachQ)),
          gated: `${worstValue.gateCounts.curvature} curvature, ${worstValue.gateCounts.reach} reach`,
          Dmax: worstValue.Dmax,
          keyLight: worstValue.keyLight,
          hueOnlyQ: worstValue.hueOnlyQ,
          shadowShareQ: worstValue.shadowShareQ,
          highlightShareQ: worstValue.highlightShareQ,
        };
  const frameScores = measurements.filter((frame) => frame.measured).map((frame) => frame.scoreQ);

  const preconditions: Record<string, CorpusExcludedReason | null> = {};
  for (const [id, predicate] of Object.entries(PRECONDITIONS)) preconditions[id] = predicate(context);

  const actualCodes = reportCodes(report, context);
  const failures: string[] = [];
  const expect = entry.expect;

  // The frame the analyzer's verdict is decided on, resolved rather than recomputed: the
  // measurement record is already in hand and re-deriving "which frame is worst" here would be a
  // second implementation of the rule `silhouetteAnalyzer` applies.
  let worstFrame: SilhouetteFrame | null = null;
  for (const frame of measurements) {
    if (!frame.measured) continue;
    if (worstFrame === null || frame.scoreQ < worstFrame.scoreQ) worstFrame = frame;
  }

  if (expect.codes !== undefined && !sameCodes(expect.codes, actualCodes)) {
    failures.push(
      `expect.codes [${expect.codes.join(', ') || 'none'}] but the report carries [${actualCodes.join(', ') || 'none'}]`,
    );
  }
  for (const code of expect.absent ?? []) {
    if (actualCodes.includes(code)) failures.push(`expect.absent includes "${code}" but the report carries it`);
  }
  if (expect.verdict !== undefined && report.verdict !== expect.verdict) {
    failures.push(`expect.verdict ${expect.verdict} but the report says ${report.verdict}`);
  }
  if (expect.noBlocking === true && report.blocking.length > 0) {
    failures.push(`expect.noBlocking but the blocking list is [${report.blocking.map((issue) => issue.code).join(', ')}]`);
  }
  for (const [id, reason] of Object.entries(expect.preconditions ?? {})) {
    const got = preconditions[id];
    if (got !== reason) {
      failures.push(`expect.preconditions.${id} ${JSON.stringify(reason)} but ${id} reports ${JSON.stringify(got)}`);
    }
  }
  for (const [quantity, expected] of Object.entries(expect.measure ?? {})) {
    const got = measurements.map((frame) => frame[quantity as MeasuredQuantity] as number);
    if (!sameInts(expected as readonly number[], got)) {
      failures.push(`expect.measure.${quantity} [${(expected as readonly number[]).join(', ')}] but measured [${got.join(', ')}]`);
    }
  }
  const connectivity = connectivityOf(context);
  if (expect.connectivity !== undefined) {
    if (connectivity === null) {
      failures.push('expect.connectivity on a frame with no solid pixels');
    } else {
      if (connectivity.four !== expect.connectivity.four) {
        failures.push(`expect.connectivity.four ${expect.connectivity.four} but measured ${connectivity.four}`);
      }
      if (connectivity.eight !== expect.connectivity.eight) {
        failures.push(`expect.connectivity.eight ${expect.connectivity.eight} but measured ${connectivity.eight}`);
      }
    }
  }

  return {
    id: entry.id,
    label: entry.label,
    tier: entry.tier,
    status: failures.length === 0 ? 'pass' : 'fail',
    failures,
    actualCodes,
    expectedCodes: expect.codes === undefined ? null : [...expect.codes],
    absent: [...(expect.absent ?? [])],
    actualVerdict: report.verdict,
    expectedVerdict: expect.verdict ?? null,
    blocking: report.blocking.map((issue) => issue.code),
    scores: Object.fromEntries(
      QUALITY_DIMENSIONS.flatMap((id) => {
        const dimension = report.dimensions[id];
        return dimension === undefined ? [] : [[id, dimension.scoreQ] as const];
      }),
    ),
    excluded: { ...report.excluded },
    // Keyed `dimension.subScore` rather than flattened to the sub-score alone, so the row says
    // *which* dimension is half blind and not merely that something is.
    unmeasured: Object.fromEntries(
      Object.entries(report.dimensions).flatMap(([id, dimension]) =>
        dimension === undefined
          ? []
          : Object.entries(dimension.unmeasured).map(([name, reason]) => [`${id}.${name}`, reason]),
      ),
    ),
    preconditions,
    frames: readings,
    value,
    worstScoreQ: frameScores.length === 0 ? null : Math.min(...frameScores),
    worstFrameCompactnessQ: worstFrame === null ? null : worstFrame.compactnessQ,
    worstFrameThicknessQ: worstFrame === null ? null : worstFrame.thicknessQ,
    worstFrameProfileQ: worstFrame === null ? null : worstFrame.profileQ,
    meanScoreQ: frameScores.length === 0 ? null : Math.floor(frameScores.reduce((a, b) => a + b, 0) / frameScores.length),
    tookMin: frameScores.length < 2 ? null : report.dimensions.silhouette?.scoreQ === Math.min(...frameScores),
    connectivity,
    // A case with no pair groups is `[]` rather than `null`, so the grouping loop below has one
    // shape to handle and the row's own `pair` field is a faithful record of the data.
    pair: entry.tier === 'synthetic' ? [...(entry.pair ?? [])] : [],
    attributes: attributesOf(sprite),
  };
}

/** Objective attributes. Nothing here is an opinion about the artwork. */
function attributesOf(sprite: Sprite | null): CorpusRow['attributes'] {
  if (sprite === null) return { width: 0, height: 0, frames: 0, palette: 0, tags: 0 };
  return {
    width: sprite.width,
    height: sprite.height,
    frames: sprite.frames.length,
    palette: sprite.palette.colors.length,
    tags: sprite.tags.length,
  };
}

/** Every code the report carries: the present dimensions' issues plus the aggregator's own. */
function reportCodes(report: QualityReport, context: QualityContext): string[] {
  const codes = new Set<string>();
  for (const id of QUALITY_DIMENSIONS) {
    for (const issue of report.dimensions[id]?.issues ?? []) codes.add(issue.code);
  }
  for (const issue of aggregatorIssues(context)) codes.add(issue.code);
  return [...codes].sort();
}

/**
 * One frame, in the report's shape.
 *
 * Measured with `measureSilhouette` **even when `evaluate` excluded the dimension**, because the
 * distribution is the point and a full-bleed scene's `N` and `perimeter` are exactly the numbers
 * T-012 needed and did not have. The exclusion is recorded separately, on the row, and never
 * inferred from the absence of a measurement.
 */
function readingOf(context: QualityContext, frame: SilhouetteFrame): FrameReading {
  const { width, height } = context;
  const { mask } = buildSolidMask(context.composite[frame.index], width, height);
  const bounds = frame.bounds;
  return {
    index: frame.index,
    N: frame.N,
    components: frame.components,
    largest: frame.largest,
    shareQ: frame.shareQ,
    strayPixels: frame.strayPixels,
    perimeter: frame.perimeter,
    // The subject's own boundary length, beside the whole mask's. The two are equal exactly
    // when the sprite is one component, so the pair is the drift guard on the measurement T-022
    // changed: a case with strays is the only place they can disagree, and `perimeter >
    // subjectPerimeter` there is the whole defect-2 story in one column.
    subjectPerimeter: frame.subjectPerimeter,
    // §3.3's `edgePixels`, recorded beside `perimeter` on every row so the two never have to be
    // remembered as different quantities. They are close on a rectangle and diverge on anything
    // with a staircase, which is the whole reason §3.3 gives them a subsection each.
    edgePixels: edgePixelCount(mask, width, height),
    compactnessQ: frame.compactnessQ,
    thicknessPx: frame.thicknessPx,
    thicknessQ: frame.thicknessQ,
    profileQ: frame.profileQ,
    holeCount: frame.holeCount,
    holeArea: frame.holeArea,
    borderTouch: frame.borderTouch,
    spanQ: frame.spanQ,
    convexCorners: frame.convexCorners,
    stairCorners: countConvexStaircaseCorners(mask, width, height),
    partialAlpha: frame.partialAlpha,
    scoreQ: frame.scoreQ,
    bounds,
    // Derived from the shared `bounds` rather than by re-implementing the aggregator's private
    // `edgeGap`: §3.3 says no dimension may define a second version of a named quantity, and a
    // test harness is not a dimension but is still a place two answers can diverge.
    margin:
      bounds === null
        ? null
        : Math.min(bounds.x, bounds.y, width - bounds.x - bounds.w, height - bounds.y - bounds.h),
  };
}

/** Both connectivity counts on frame 0, or `null` when nothing is solid. */
function connectivityOf(context: QualityContext): { four: number; eight: number } | null {
  const { mask, solid } = buildSolidMask(context.composite[0], context.width, context.height);
  if (solid === 0) return null;
  return {
    four: connectedComponents(mask, context.width, context.height, 4).length,
    eight: connectedComponents(mask, context.width, context.height, 8).length,
  };
}

function sameCodes(expected: readonly string[], actual: readonly string[]): boolean {
  return sameStrings([...expected].sort(), [...actual].sort());
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameInts(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/* ------------------------------------------------------------------ *
 * The distribution
 * ------------------------------------------------------------------ */

/** One subject's `compactnessQ`, with where it came from, for the calibration histogram. */
export interface CompactnessSample {
  readonly id: string;
  readonly tier: CorpusCase['tier'];
  readonly frame: number;
  readonly compactnessQ: number;
  /** True when `evaluate` reported this dimension as excluded, so the score was never delivered. */
  readonly excluded: boolean;
  readonly detail: string;
}

/**
 * One subject's scale-aware reading, the second of the pair.
 *
 * A separate sample type rather than two numbers on {@link CompactnessSample}, because the two
 * are answers to different questions and a report that ranked them in one column would be
 * inviting the reader to do exactly the thing this task exists to stop: read a shape descriptor
 * as a legibility measure. `thicknessQ` has no `evaluate` verdict to appeal to, and it has its
 * own gate, its own distribution and its own price table.
 */
export interface ThicknessSample {
  readonly id: string;
  readonly tier: CorpusCase['tier'];
  readonly frame: number;
  readonly thicknessPx: number;
  readonly thicknessQ: number;
  /** `min(compactnessQ, thicknessQ)`, i.e. which of the two gates actually bit. */
  readonly profileQ: number;
  readonly excluded: boolean;
}

/** One measured gate's distribution: where the samples are and what each candidate would do. */
export interface GateDistribution {
  readonly samples: readonly {
    readonly id: string;
    readonly tier?: CorpusCase['tier'];
    readonly frame?: number;
    readonly value: number;
    /** The absolute pixel count behind `value`, when the gate is a ratio of two lengths. */
    readonly px?: number;
    /** `min(compactnessQ, thicknessQ)`, i.e. which of the two gates actually bit. */
    readonly profileQ?: number;
  }[];
  readonly gate: number;
  readonly below: number;
  readonly atOrAbove: number;
  readonly histogram: readonly { readonly from: number; readonly to: number; readonly count: number }[];
  readonly sensitivity: readonly { readonly gate: number; readonly penalised: number }[];
  /**
   * How much room the corpus's own **negative controls** have above this gate.
   *
   * Added because the whole reason a new gate is dangerous is that a control firing is the one
   * failure nobody can argue with, and the number that matters for choosing it is not "how many
   * subjects fall below" but "how close does the cleanest clean work come". A gate with three
   * per-mille of headroom on a declared-clean figure is a gate waiting for the next corpus
   * member, and that has to be visible before the gate is chosen rather than after.
   */
  readonly controlHeadroom: readonly { readonly id: string; readonly value: number }[];
}

export interface CorpusDistribution {
  readonly samples: readonly CompactnessSample[];
  readonly gate: number;
  readonly below: number;
  readonly atOrAbove: number;
  /** The two measured samples either side of the reference value, exclusive of the reference. */
  readonly neighbours: readonly [CompactnessSample, CompactnessSample] | null;
  /** How many samples are strictly below the reference value. */
  readonly belowReference: number;
  /**
   * What each candidate gate would do, in both directions.
   *
   * This is the table a gate move is actually argued from. Lowering the gate *releases* the
   * samples that were being penalised and nothing else, so the price of admitting the one real
   * character sprite is exactly the count here, and a decision made without it is a decision made
   * on one asset.
   */
  readonly sensitivity: readonly {
    readonly gate: number;
    readonly penalised: number;
    readonly released: readonly CompactnessSample[];
    readonly newlyPenalised: readonly CompactnessSample[];
  }[];
  /** The value this corpus exists to place: the one real human-relevant measurement in the repo. */
  readonly reference: { readonly id: string; readonly value: number };
  /** The second reading, over the same subjects, with its own gate. */
  readonly thickness: GateDistribution;
  /**
   * How much room the corpus's negative controls have above the **compactness** gate. The
   * comparable column for the thickness gate is on {@link GateDistribution}, because the two
   * gates are two different numbers and one of them being comfortable says nothing about the
   * other.
   */
  readonly compactnessControlHeadroom: readonly { readonly id: string; readonly value: number }[];

  /** Histogram buckets, 100 per-mille wide, ascending. */
  readonly histogram: readonly { readonly from: number; readonly to: number; readonly count: number }[];
  /** Per-dimension score distribution, over the present dimensions. */
  readonly scores: readonly {
    readonly dimension: QualityDimensionId;
    readonly values: readonly number[];
    readonly median: number;
    readonly min: number;
    readonly max: number;
  }[];
  /**
   * §6.2's contrast pairs, with the size of the gap.
   *
   * `valueQ` and `valueGap` are the *sixth* gap, and the one that makes a `value` pair legible:
   * the other five are all `silhouette` columns, so a pair that differs only in tone — the
   * straight band against the form-following contour, the blown highlight against the same form
   * with headroom left — printed five zeros and read as "the measurement cannot tell them apart".
   * It can. The `silhouette` columns are still there because a pair that separates on `value` and
   * on nothing else is the *most* interesting kind, and dropping them would hide it.
   */
  readonly pairs: readonly {
    readonly group: string;
    readonly members: readonly {
      readonly id: string;
      /** The score the *report* delivered: `null` when the dimension was excluded. */
      readonly scoreQ: number | null;
      /** The score the measurement produced anyway, exclusion or not. */
      readonly rawScoreQ: number | null;
      readonly compactnessQ: number | null;
      readonly thicknessQ: number | null;
      readonly profileQ: number | null;
      /** The worst frame's `value` score, or `null` where nothing opaque was measured. */
      readonly valueQ: number | null;
      readonly note: string;
    }[];
    /** Gap on the delivered score, or `null` when fewer than two members were measured. */
    readonly gap: number | null;
    /** Gap on the raw measurement, which exists even for an excluded dimension. */
    readonly rawGap: number | null;
    /**
     * The same gap on `compactnessQ`, which is usually far larger than the score gap. A dimension
     * can separate two shapes by 600 per-mille of its own measurement and by 100 of score,
     * because the penalty is a step function.
     */
    readonly compactnessGap: number | null;
    /** The same gap on the scale-aware reading, which is the one that separates scales. */
    readonly thicknessGap: number | null;
    /** The gap on whichever of the two readings is worse for each member. */
    readonly profileGap: number | null;
    /** The gap on `value`, for the pairs whose whole subject is tone. */
    readonly valueGap: number | null;
  }[];
}

const BUCKETS = 10;

/** Aggregate the run into the calibration data a gate move would be based on. */
export function distribute(run: CorpusRun): CorpusDistribution {
  const samples: CompactnessSample[] = [];
  for (const row of run.rows) {
    if (row.tier === 'human') continue;
    const detail = row.excluded.silhouette !== undefined ? `excluded: ${row.excluded.silhouette}` : 'measured';
    for (const frame of row.frames) {
      if (frame.N === 0) continue;
      samples.push({
        id: row.id,
        tier: row.tier,
        frame: frame.index,
        compactnessQ: frame.compactnessQ,
        excluded: row.excluded.silhouette !== undefined,
        detail,
      });
    }
  }
  samples.sort((a, b) => a.compactnessQ - b.compactnessQ || (a.id < b.id ? -1 : 1));

  // The one measurement the whole calibration argument turns on: the only real character sprite
  // in this repository, which the current gate penalises. Named here rather than discovered, so
  // that deleting the asset fails loudly instead of quietly moving the reference.
  const referenceId = 'artwork/verify/lantern-keeper.pixel';
  const referenceSample = samples.find((sample) => sample.id === referenceId);
  const reference = referenceSample
    ? { id: referenceId, value: referenceSample.compactnessQ }
    : { id: referenceId, value: -1 };

  let neighbours: readonly [CompactnessSample, CompactnessSample] | null = null;
  let belowReference = 0;
  let lower: CompactnessSample | null = null;
  let upper: CompactnessSample | null = null;
  for (const sample of samples) {
    if (sample.compactnessQ < reference.value) belowReference++;
    // Exclusive of the reference itself: the question is what the gate would have to sit between,
    // and "the reference is between the reference and its neighbour" answers nothing.
    if (sample.id === reference.id) continue;
    if (sample.compactnessQ < reference.value && (lower === null || sample.compactnessQ > lower.compactnessQ)) {
      lower = sample;
    }
    if (sample.compactnessQ > reference.value && (upper === null || sample.compactnessQ < upper.compactnessQ)) {
      upper = sample;
    }
  }
  if (lower !== null && upper !== null) neighbours = [lower, upper];

  // Candidate gates, in ascending order. Derived from the distribution rather than invented, so
  // every entry is a value somebody would actually propose: the gate as it stands, the reference
  // and its two neighbours, and two round numbers below the range.
  const candidates = [...new Set([200, 250, neighbours?.[0].compactnessQ ?? 260, reference.value, neighbours?.[1].compactnessQ ?? 275, SPEC_GATES.compactnessQ])]
    .filter((gate) => gate >= 0)
    .sort((a, b) => a - b);
  const sensitivity = candidates.map((gate) => ({
    gate,
    penalised: samples.filter((s) => s.compactnessQ < gate).length,
    // Lowering the gate can only release, never add.
    released: samples.filter((s) => s.compactnessQ >= gate && s.compactnessQ < SPEC_GATES.compactnessQ),
    // Raising it can only add.
    newlyPenalised: samples.filter((s) => s.compactnessQ >= SPEC_GATES.compactnessQ && s.compactnessQ < gate),
  }));

  const histogram = histogramOf(samples.map((s) => s.compactnessQ));
  // The same headroom column the second gate gets, so the two are comparable at a glance. §4.1's
  // own gate has three per-mille of room on `sweep/rect-30x4`, which is the number a gate
  // decision wants next to the count of subjects it penalises.
  const compactnessControls = gateDistribution(
    samples.map((s) => ({ id: s.id, value: s.compactnessQ })),
    SPEC_GATES.compactnessQ,
    candidates,
    run,
    samples.map((s) => ({ id: s.id, value: s.compactnessQ })),
  ).controlHeadroom;

  // The second reading, over the same subjects. `thicknessPx` rides along because the absolute
  // and the relative answers to "is this thick enough" disagree, and only one of them is a gate.
  const thicknessSamples: ThicknessSample[] = [];
  for (const row of run.rows) {
    if (row.tier === 'human') continue;
    for (const frame of row.frames) {
      if (frame.N === 0) continue;
      thicknessSamples.push({
        id: row.id,
        tier: row.tier,
        frame: frame.index,
        thicknessPx: frame.thicknessPx,
        thicknessQ: frame.thicknessQ,
        profileQ: frame.profileQ,
        excluded: row.excluded.silhouette !== undefined,
      });
    }
  }
  const thickness: GateDistribution = gateDistribution(
    thicknessSamples.map((s) => ({
      id: s.id,
      tier: s.tier,
      frame: s.frame,
      value: s.thicknessQ,
      px: s.thicknessPx,
      profileQ: s.profileQ,
    })),
    DERIVED_POLICY.thicknessQ,
    [200, 250, DERIVED_POLICY.thicknessQ, 300, 400].filter((gate, i, all) => all.indexOf(gate) === i),
    run,
    thicknessSamples.map((s) => ({ id: s.id, value: s.thicknessQ })),
  );

  const scores: CorpusDistribution['scores'] = QUALITY_DIMENSIONS.map((dimension) => {
    const values = run.rows
      .flatMap((row) => (row.scores[dimension] === undefined ? [] : [row.scores[dimension] as number]))
      .sort((a, b) => a - b);
    const median = values.length === 0 ? -1 : values[Math.floor((values.length - 1) / 2)];
    return {
      dimension,
      values,
      median,
      min: values.length === 0 ? -1 : values[0],
      max: values.length === 0 ? -1 : values[values.length - 1],
    };
  });

  // A case may belong to more than one group, so the grouping is a join and not a partition: a
  // 3px band is the reference for "the same drawing on two canvases" and for "the same drawing at
  // two resolutions", and a one-valued `pair` field had to drop one of them — which is how the
  // report came to print `not separable` for a pair whose measured answer is 0.
  const groups = new Map<string, CorpusRow[]>();
  for (const row of run.rows) {
    for (const group of row.pair) {
      const members = groups.get(group) ?? [];
      members.push(row);
      groups.set(group, members);
    }
  }
  const pairs = [...groups.entries()].map(([group, members]) => {
    const readings = members.map((row) => ({
      id: row.id,
      scoreQ: row.scores.silhouette ?? null,
      rawScoreQ: row.worstScoreQ,
      compactnessQ: row.worstFrameCompactnessQ,
      thicknessQ: row.worstFrameThicknessQ,
      profileQ: row.worstFrameProfileQ,
      valueQ: row.value?.scoreQ ?? null,
      note: row.excluded.silhouette ?? 'measured',
    }));
    const spread = (pick: (m: (typeof readings)[number]) => number | null): number | null => {
      const numbers = readings.map(pick).filter((n): n is number => n !== null);
      return numbers.length < 2 ? null : Math.max(...numbers) - Math.min(...numbers);
    };
    return {
      group,
      members: readings,
      // A group where nothing was measured has no gap, and `null` says so. A group where both
      // sides were measured but landed equal has a gap of 0, and 0 is the finding: §6.2 calls a
      // pair that separates by 0.02 "passing the test and still wrong", and 0 is worse.
      gap: spread((m) => m.scoreQ),
      // The raw gap is the one that survives an exclusion, and for the margin pair it is the
      // only one that exists — the whole point there is that the report deliberately refuses to
      // deliver a number while the measurement has one.
      rawGap: spread((m) => m.rawScoreQ),
      compactnessGap: spread((m) => m.compactnessQ),
      thicknessGap: spread((m) => m.thicknessQ),
      profileGap: spread((m) => m.profileQ),
      valueGap: spread((m) => m.valueQ),
    };
  });

  return {
    samples,
    gate: SPEC_GATES.compactnessQ,
    below: samples.filter((s) => s.compactnessQ < SPEC_GATES.compactnessQ).length,
    atOrAbove: samples.filter((s) => s.compactnessQ >= SPEC_GATES.compactnessQ).length,
    neighbours,
    belowReference,
    reference,
    thickness,
    compactnessControlHeadroom: compactnessControls,
    sensitivity,
    histogram,
    scores,
    pairs,
  };
}

/** Histogram buckets 100 per-mille wide, with a value of exactly 1000 folded into the last. */
function histogramOf(values: readonly number[]): { from: number; to: number; count: number }[] {
  const histogram: { from: number; to: number; count: number }[] = [];
  for (let b = 0; b < BUCKETS; b++) {
    const from = b * 100;
    const to = from + 100;
    histogram.push({ from, to, count: values.filter((v) => v >= from && v < to).length });
  }
  // A value of exactly 1000 has no bucket, because the loop's last bucket is exclusive at 1000
  // and the sweep's most compact subject lands there. Folded in rather than dropped, because a
  // distribution that silently loses its most compact subject is worse than one that is explicit.
  const overflow = values.filter((v) => v === 1000).length;
  if (overflow > 0) histogram[histogram.length - 1].count += overflow;
  return histogram;
}

/**
 * One gate's distribution, its histogram, its candidate prices, and how much room the corpus's
 * own negative controls have above it.
 *
 * Shared by the two gates on purpose: the compactness distribution was hand-rolled inline while
 * it was the only one, which is exactly how two halves of one table drift apart. The
 * control-headroom column is the number a gate decision should start from, so it is computed
 * once and printed once — a gate with three per-mille of room on a declared-clean figure is a
 * gate waiting for the next corpus member, and that has to be visible *before* the gate is
 * chosen rather than inferred afterwards.
 */
function gateDistribution(
  samples: readonly {
    id: string;
    value: number;
    px?: number;
    profileQ?: number;
    tier?: CorpusCase['tier'];
    frame?: number;
  }[],
  gate: number,
  candidates: readonly number[],
  run: CorpusRun,
  controlValues: readonly { id: string; value: number }[],
): GateDistribution {
  const controls = new Set(
    run.spec.cases
      .filter(
        (entry) =>
          entry.tier === 'synthetic' && entry.defects.some((defect) => defect.kind === 'clean-control'),
      )
      .map((entry) => entry.id),
  );
  return {
    samples: [...samples].sort(
      (a, b) =>
        a.value - b.value || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || (a.px ?? 0) - (b.px ?? 0),
    ),

    gate,
    below: samples.filter((s) => s.value < gate).length,
    atOrAbove: samples.filter((s) => s.value >= gate).length,
    histogram: histogramOf(samples.map((s) => s.value)),
    sensitivity: [...candidates]
      .sort((a, b) => a - b)
      .map((candidate) => ({ gate: candidate, penalised: samples.filter((s) => s.value < candidate).length })),
    controlHeadroom: controlValues
      .filter((entry) => controls.has(entry.id))
      .map((entry) => ({ id: entry.id, value: entry.value }))
      .sort((a, b) => a.value - b.value),
  };
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const PAD = '|';

/**
 * One gate's headroom line: the tightest declared-clean subject and the margin above the gate.
 *
 * The **full** list is deliberately not printed here. Nineteen near-identical rows would bury the
 * one number a reader needs, and the full list is already in the sample table above; what is not
 * derivable from it by eye is the margin, because "326" says nothing until you know the gate is
 * 300.
 */
function headroomRow(
  name: string,
  gate: number,
  below: number,
  headroom: readonly { id: string; value: number }[],
): readonly string[] {
  const tightest = headroom[0];
  return [
    `${name} ${gate}`,
    String(below),
    tightest === undefined ? 'none' : `${tightest.id} at ${tightest.value}`,
    tightest === undefined ? '-' : `${tightest.value - gate} per-mille above the gate`,
  ];
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => (row[i] ?? '').length)));
  const line = (cells: readonly string[]): string =>
    `${PAD} ${cells.map((cell, i) => (cell ?? '').padEnd(widths[i])).join(` ${PAD} `)} ${PAD}`;
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)];
}

function listOrNone(values: readonly string[]): string {
  return values.length === 0 ? '-' : values.join(', ');
}

/** The largest reading, or `null` when there is nothing to take one of. */
function maxOf(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}

/** The generated report. Compared against `baseline.md` by the test; never edited by hand. */
export function renderMarkdown(spec: CorpusSpec, scores: CorpusScores, rows: readonly CorpusRow[]): string {
  const run: CorpusRun = { spec, scores, rows, failures: [], markdown: '' };
  const distribution = distribute(run);
  const out: string[] = [];

  out.push('# Calibration corpus — generated report');
  out.push('');
  out.push('> Generated by `benchmarks/corpus/report.ts` and compared against itself by');
  out.push('> `packages/core/test/quality-corpus.test.ts`. **Do not edit by hand.** A score that moves');
  out.push('> is a diff in this file, reviewed like any other change; to accept a move, run the test');
  out.push('> with `UPDATE_CORPUS=1`.');
  out.push('');
  out.push(`Corpus version ${spec.version}. ${spec.description}`);
  out.push('');

  const byTier = (tier: CorpusCase['tier']): CorpusRow[] => rows.filter((row) => row.tier === tier);
  out.push(
    `**${byTier('synthetic').length} synthetic** (ground truth by construction) · ` +
      `**${byTier('real').length} real** (unlabelled) · ` +
      `**${byTier('human').length} human** (awaiting a rater). ` +
      `Algorithmic labels cannot calibrate an algorithm — ` +
      '`docs/EVALUATION.md` §6.1 — so the synthetic tier detects and regression-guards, and only ' +
      'the human tier speaks to the aesthetic axis.',
  );
  out.push('');

  /* --- the table --- */
  out.push('## 1 · Cases');
  out.push('');
  out.push(
    ...table(
      ['case', 'tier', 'expected codes', 'actual codes', 'exp verdict', 'act verdict', 'scoreQ', 'status'],
      rows.map((row) => [
        row.id,
        row.tier,
        row.expectedCodes === null ? 'not asserted' : listOrNone(row.expectedCodes),
        row.tier === 'human' ? 'withheld from raters' : listOrNone(row.actualCodes),
        row.expectedVerdict ?? '-',
        row.actualVerdict ?? '-',
        row.tier === 'human' ? '-' : row.scores.silhouette === undefined ? 'excluded' : String(row.scores.silhouette),
        row.status,
      ]),
    ),
  );
  out.push('');

  const failing = rows.filter((row) => row.status === 'fail');
  if (failing.length > 0) {
    out.push('### Mismatches');
    out.push('');
    for (const row of failing) {
      out.push(`- \`${row.id}\``);
      for (const reason of row.failures) out.push(`  - ${reason}`);
    }
    out.push('');
  }

  /* --- measurements --- */
  out.push('## 2 · Measurements, per frame');
  out.push('');
  out.push(
    'Every §3.3 quantity, recorded whether or not the case asserts it. An expectation is only' +
      ' written where the value is derivable from the specification and the declared geometry;' +
      ' everything else is a transcript, and the two are not confused.',
  );
  out.push('');
  const measurementRows: string[][] = [];
  for (const row of rows) {
    if (row.tier === 'human') continue;
    for (const frame of row.frames) {
      measurementRows.push([
        row.id,
        String(frame.index),
        `${row.attributes.width}x${row.attributes.height}`,
        String(frame.N),
        String(frame.components),
        String(frame.shareQ),
        String(frame.perimeter),
        String(frame.subjectPerimeter),
        String(frame.edgePixels),
        String(frame.compactnessQ),
        String(frame.thicknessPx),
        String(frame.thicknessQ),
        String(frame.profileQ),
        String(frame.holeCount),
        String(frame.borderTouch),
        String(frame.spanQ),
        String(frame.margin ?? '-'),
        String(frame.convexCorners),
        String(frame.stairCorners),
        String(frame.scoreQ),
      ]);

    }
  }
  out.push(
    ...table(
      [
        'case',
        'f',
        'canvas',
        'N',
        'comps',
        'shareQ',
        'perim',
        'subjPerim',
        'edgePx',
        'compactQ',
        'thkPx',
        'thkQ',
        'profQ',
        'holes',
        'edges',
        'spanQ',
        'margin',
        'cCorners',
        'stairCorn',
        'scoreQ',
      ],

      measurementRows,
    ),
  );
  out.push(
    '',
    '`cCorners` is §3.3\'s `convexCorner` implemented as its table clause reads, which counts',
    '**concave** corners and reads 0 on every convex shape in the corpus — including all twelve',
    'committed assets in `artwork/`. `stairCorn` is the corrected predicate §4.2\'s curvature gate',
    'actually needs: a pixel on a convex 45-degree staircase. Both are on every row because the',
    'repository currently carries one §3.3 name with two definitions, and the next revision of',
    '§3.3 has to retire one of them against a number rather than an argument.',
  );
  out.push('');

  /* --- value --- */
  out.push('## 2b · `value`, and the form term it exists for', '');
  out.push(
    'Worst frame, per case. `spanQ` is §4.2\'s **specified** form term — the spread of `dist`',
    'along a plane boundary — and this build records it and does not score it. It reads high on',
    'artwork that is correct, for a geometric reason rather than a matter of taste: a translated',
    'contour necessarily runs from the silhouette\'s own edge out to its deepest reach, so its',
    'spread is as large as the body is deep, while a true inset has a spread near zero. That is',
    'the level-set bias, and the column is here so the evidence for the score stays in a committed',
    'file rather than in an argument. `crossesQ` is what this build scores: 0 is a plane that',
    'follows the form, 1000 is a plane that slices it.',
    '',
    '`curvedQ` and `reachQ` are §4.2\'s two gates, on the same row. `curvedQ` is the **maximum of two',
    'references**, and the second one is why the gate is not inert on a full-bleed document. The first',
    'counts `edgePixel`s within Chebyshev 3 of the plane on the subject\'s own outline, which on a',
    'full-bleed subject is the canvas frame: it read 0..77 on all ten committed scenes against a gate',
    'of 250, so every plane on every one of them was exempt and a straight shadow band across a',
    'curved mountain was excused. The second, `regionCurvedQ`, reads the curvature off the tone',
    'regions\' own boundaries, which is the only curvature available on a subject that has no outline,',
    'and it takes the larger of the two so that nothing with a readable outline changes. The ten scenes',
    'now read 667..880.',
    '',
    '**Opening the gate is not the same as measuring the form term, and the column keeps them apart.**',
    'Three of the ten have a plane that clears both gates, so their `formQ` is a number — and it is',
    '1000, with `crossesQ` 0, which is "examined and found correctly shaded" rather than "nobody',
    'looked". The other seven have every plane gated, mostly on `reach`, which is a statement about',
    '`reachQ` and not about the curvature reference, and their `formQ` stays `unmeasured`. A row',
    'reading `unmeasured` here has been *measured* as unmeasurable, which is the distinction the',
    '`unmeasured sub-scores` column below exists to keep legible.',
    '',
    '`keyLight` is the other column to read with the artwork in hand: §4.2 samples two ninths of',
    '`bounds` and subtracts the means, which is a statement about a lit subject. In a landscape',
    'those corners are different materials, and the check fires on three of the ten scenes.',
    '',
    '`shadowQ` and `highlightQ` are the shares §4.2\'s two tone-extreme codes are about — 30/100 of',
    'the solid pixels at or below Lq 12, and 10/100 at or above Lq 243 — so a reader can see how far',
    'a subject is from either threshold rather than only whether it crossed it.',
  );
  out.push('');
  const valueRows: string[][] = [];
  for (const row of rows) {
    if (row.tier === 'human' || row.value === null) continue;
    const v = row.value;
    valueRows.push([
      row.id,
      String(v.index),
      String(v.scoreQ),
      String(v.toneQ),
      String(v.formQ === null ? 'unmeasured' : v.formQ),
      String(v.distinct),
      String(v.range),
      String(v.planes),
      String(v.terminators),
      v.worstCrossesQ === null ? '-' : String(v.worstCrossesQ),
      v.worstBendQ === null ? '-' : String(v.worstBendQ),
      v.maxCurvedQ === null ? '-' : String(v.maxCurvedQ),
      v.maxReachQ === null ? '-' : String(v.maxReachQ),
      v.gated,
      v.worstSpanQ === null ? '-' : String(v.worstSpanQ),
      String(v.Dmax),
      v.keyLight === null ? 'not measurable' : String(v.keyLight),
      v.hueOnlyQ === -1 ? 'not measurable' : String(v.hueOnlyQ),
      String(v.shadowShareQ),
      String(v.highlightShareQ),
    ]);
  }
  out.push(
    ...table(
      [
        'case',
        'f',
        'value',
        'toneQ',
        'formQ',
        'buckets',
        'range',
        'planes',
        'bounds',
        'crossesQ',
        'bendQ',
        'curvedQ max',
        'reachQ max',
        'gated',
        'spanQ unscored',
        'Dmax',
        'keyLight',
        'hueOnlyQ',
        'shadowQ',
        'highlightQ',
      ],
      valueRows,
    ),
  );
  out.push('');

  /* --- applicability --- */
  out.push('## 3 · Applicability');
  out.push('');
  out.push(
    '`evaluate` records `not-implemented` for every dimension that has no analyzer, so the ' +
      "aggregator's own predicates are called directly as well. The middle two columns are what the " +
      'precondition says; the right-hand one is only the reasons that are *not* `not-implemented`, ' +
      'because those five are the same on every row and would bury the two that are not.',
  );
  out.push('');
  out.push(
    ...table(
      [
        'case',
        'requiresReadableSubject',
        'motionApplicability',
        'exclusions with a reason',
        'unmeasured sub-scores',
        'blocking',
      ],
      rows
        .filter((row) => row.tier !== 'human')
        .map((row) => [
          row.id,
          row.preconditions.silhouette === null || row.preconditions.silhouette === undefined
            ? 'applicable'
            : String(row.preconditions.silhouette),
          row.preconditions.motion === null || row.preconditions.motion === undefined
            ? 'applicable'
            : String(row.preconditions.motion),
          listOrNone(
            Object.entries(row.excluded)
              .filter(([, reason]) => reason !== 'not-implemented')
              .map(([id, reason]) => `${id}=${reason}`),
          ),
          // A dimension that is present and *partly* blind is the case neither `excluded` nor a
          // score can express, so it gets its own column rather than being inferred from a number.
          listOrNone(Object.entries(row.unmeasured).map(([name, reason]) => `${name}=${reason}`)),
          listOrNone(row.blocking),
        ]),
    ),
  );
  out.push('');
  out.push(
    'The `unmeasured sub-scores` column is the one T-099 added. `value` applies to a full-bleed ' +
      'scene and its tone half is measured there, so it is not in `excluded` — but §4.2\'s form ' +
      'half has no outline to read and used to report `formQ` 1000 on every one of them. A row ' +
      'reading `value` is present, `excluded` empty, `formQ` 1000 was a perfect score for a ' +
      'measurement nobody took.',
    '',
    '**T-100 moved some of these rows, and the direction is the point.** The curvature gate stopped ' +
      'being inert on full-bleed documents, so three of the ten scenes now report a measured ' +
      '`formQ` of 1000 and an empty `unmeasured` map: judged, and correctly shaded. Seven still ' +
      'report `no-subject`, because every plane in them is gated on `reach` rather than on ' +
      'curvature. The seven are the remaining coverage gap and they are a `reachQ` question; the ' +
      'curvature half of the gate is now answered everywhere. A reader comparing this table against ' +
      'an older baseline should expect `value` to move **up** on the rows that changed, because ' +
      '`formQ` stopped being a free 1000 and became a measurement, and it measured clean.',
  );
  out.push('');

  /* --- the distribution --- */
  out.push('## 4 · `compactnessQ` across every subject');
  out.push('');
  out.push(
    `The gate is **${distribution.gate}** (§4.1's \`compactnessQ < 300\`). ` +
      `**${distribution.below}** measured subject frames fall below it and ` +
      `**${distribution.atOrAbove}** reach it. No gate is moved by this file.`,
  );
  out.push('');
  out.push(
    ...table(
      ['compactnessQ', 'samples'],
      [
        ...distribution.histogram.map((bucket) => [
          bucket.to === 1000 ? `900..1000` : `${bucket.from}..${bucket.to - 1}`,
          String(bucket.count),
        ]),
      ],
    ),
  );
  out.push('');
  out.push(
    `### Where \`${distribution.reference.id}\` lands`,
    '',
    `The only real character sprite in this repository, and the measurement the whole calibration ` +
      `argument turns on. It measures **compactnessQ ${distribution.reference.value}** against a ` +
      `gate of ${distribution.gate}.`,
    '',
    `- **${distribution.belowReference}** of **${distribution.samples.length}** measured subject ` +
      `frames score below it.`,
    distribution.neighbours === null
      ? '- It is outside the measured range, so the corpus does not yet bracket it.'
      : `- The nearest samples either side are \`${distribution.neighbours[0].id}\` at ` +
        `**${distribution.neighbours[0].compactnessQ}** and \`${distribution.neighbours[1].id}\` at ` +
        `**${distribution.neighbours[1].compactnessQ}**, so the gate would have to fall between ` +
        `${distribution.neighbours[0].compactnessQ} and ${distribution.neighbours[1].compactnessQ} ` +
        'to admit it without admitting its neighbour as well.',
    '',
    '### What each candidate gate would do',
    '',
    'Lowering the gate can only *release* subjects, never penalise new ones, so the price of ' +
      'admitting this sprite is exactly the `released` column. Raising it does the reverse. ' +
      '**This file moves no gate**; it produces the numbers a move would be argued from.',
  );
  out.push('');
  out.push(
    ...table(
      ['gate', 'penalised', 'released by lowering here', 'newly penalised by raising here'],
      distribution.sensitivity.map((entry) => [
        entry.gate === distribution.gate ? `**${entry.gate}** (today)` : String(entry.gate),
        String(entry.penalised),
        entry.released.length === 0 ? '-' : entry.released.map((s) => `${s.id} (${s.compactnessQ})`).join(', '),
        entry.newlyPenalised.length === 0 ? '-' : entry.newlyPenalised.map((s) => `${s.id} (${s.compactnessQ})`).join(', '),
      ]),
    ),
  );
  out.push('');

  out.push('### Every sample, ascending');
  out.push('');
  out.push(
    ...table(
      ['compactnessQ', 'case', 'tier', 'frame', 'verdict of `evaluate`'],
      distribution.samples.map((sample) => [
        String(sample.compactnessQ),
        sample.id,
        sample.tier,
        String(sample.frame),
        sample.detail,
      ]),
    ),
  );
  out.push('');

  /* --- the second reading --- */
  out.push('## 4b · `thicknessQ` — the scale-aware reading, and its own gate');
  out.push('');
  out.push(
    '`compactnessQ` is a **shape** descriptor and is scale-invariant on purpose: a 32×32 square ' +
      'and a 1024×1024 square are the same drawing and score the same, and a measurement that ' +
      'separated them would be measuring the canvas. What it cannot see is the sprite\'s own ' +
      'size, which is what §3.3\'s `Dmax` paragraph is about — "a 3px-wide blade and a 30px-wide ' +
      'cloak do not have the same room to put a curved terminator in" — and which §4.1 never ' +
      'applied. So the two are reported as **two numbers** rather than merged: merging a shape ' +
      'descriptor with a scale reading produces a number whose meaning depends on which of the ' +
      'two the reader had in mind.',
  );
  out.push('');
  out.push(
    `\`thicknessQ = min(1000, rhu(1000 * thicknessPx, min(W, H)))\`, where \`thicknessPx\` is the ` +
      'subject\'s largest inscribed axis-aligned square. **The gate is ' +
      `**${distribution.thickness.gate}**, and it is T-022's own number** — §4.1 has no ` +
      'thickness row at all. It is transcribed from §3.7\'s `span < 0.25` ("a subject must ' +
      'occupy a quarter of the room") rather than picked, and ' +
      `**${distribution.thickness.below}** measured subject frames fall below it while ` +
      `**${distribution.thickness.atOrAbove}** reach it. No gate is moved by this file.`,
  );
  out.push('');
  out.push(
    ...table(
      ['thicknessQ', 'samples'],
      distribution.thickness.histogram.map((bucket) => [
        bucket.to === 1000 ? `900..1000` : `${bucket.from}..${bucket.to - 1}`,
        String(bucket.count),
      ]),
    ),
  );
  out.push('');
  out.push(
    '### How much room the declared-clean subjects have above each gate',
    '',
    'A control firing is the one corpus failure nobody can argue with, and the number that decides ' +
      'a gate is not "how many subjects fall below" but "how close does the cleanest clean work ' +
      'come". The sweep members and the `bleed` cases are `clean-control` members too, so this ' +
      'column is every subject the corpus declares free of injected defects, closest first — ' +
      'and the margin is the distance from the gate to the tightest of them. A gate with three ' +
      'per-mille of margin on a declared-clean subject is a gate waiting for the next corpus ' +
      'member. Both gates are shown so neither is chosen on a count the other one is comfortable ' +
      'with.',
  );
  out.push('');
  out.push(
    ...table(
      ['gate', 'subjects below', 'tightest declared-clean subject', 'margin'],
      [
        headroomRow('compactnessQ', distribution.gate, distribution.below, distribution.compactnessControlHeadroom),
        headroomRow('thicknessQ', distribution.thickness.gate, distribution.thickness.below, distribution.thickness.controlHeadroom),
      ],
    ),
  );
  out.push('');
  out.push(
    '### What each candidate thickness gate would do',
    '',
    'Derived from the distribution rather than invented, the same way §4\'s candidates are. ' +
      '`DERIVED_POLICY.thicknessQ` in `format.ts` holds the adopted number and the reason.',
  );
  out.push('');
  out.push(
    ...table(
      ['thicknessQ gate', 'penalised'],
      distribution.thickness.sensitivity.map((entry) => [
        entry.gate === distribution.thickness.gate ? `**${entry.gate}** (adopted)` : String(entry.gate),
        String(entry.penalised),
      ]),
    ),
  );
  out.push('');
  out.push(
    '### Every sample, ascending — with the absolute count beside the ratio',
    '',
    '`thicknessPx` is the same measurement in **pixels** and the two answer different questions: ' +
      'a 28×3 band on 32² and a 896×96 band on 1024² are the same drawing at two resolutions, ' +
      'both read 94, and a 3px and a 96px knife are a 32× difference in this column. They are not ' +
      'separated, and the corpus says so rather than hiding it — any ratio of two lengths in the ' +
      'same sprite is invariant under uniform magnification, and separating them would need a ' +
      'target resolution, which a document does not carry.',
  );
  out.push('');
  out.push(
    ...table(
      ['thicknessQ', 'thicknessPx', 'profileQ', 'case', 'tier', 'frame'],
      distribution.thickness.samples.map((sample) => [
        String(sample.value),
        String(sample.px),
        String(sample.profileQ),
        sample.id,
        sample.tier ?? '-',
        String(sample.frame ?? '-'),
      ]),
    ),
  );
  out.push('');

  /* --- per-dimension --- */
  out.push('## 5 · Per-dimension score distribution');
  out.push('');
  out.push(
    ...table(
      ['dimension', 'n', 'min', 'median', 'max', 'values'],
      distribution.scores
        .filter((entry) => entry.values.length > 0)
        .map((entry) => [
          entry.dimension,
          String(entry.values.length),
          String(entry.min),
          String(entry.median),
          String(entry.max),
          entry.values.join(' '),
        ]),
    ),
  );
  out.push('');
  out.push(
    'Dimensions with no analyzer are absent from every report and so are absent from this table; ' +
      'that is the `not-implemented` bookkeeping working, not a gap in the corpus.',
  );
  out.push('');

  /* --- contrast pairs --- */
  out.push('## 6 · Contrast pairs (§6.2)');
  out.push('');
  out.push(
    'A matched pair differing in exactly one property is the only mechanism in this project that ' +
      'catches a measurement which is confidently, correlatively and completely wrong. The size of ' +
      'the gap is the thing worth reviewing: §6.2 calls a pair that separates by 0.02 "passing the ' +
      'test and still wrong". **Six** gaps per pair, because they say different things: the ' +
      '**scoreQ** gap is what a report delivers, the **raw** gap is what the measurement produced ' +
      'even where the aggregator refused to deliver it, **compactnessQ** is the shape reading, ' +
      '**thicknessQ** the scale-aware one, **profileQ** the worse of the two, and **valueQ** the ' +
      "second dimension's own. The last is why a `value` pair is legible at all: without it the " +
      'straight band and the form-following contour differ by 385 per-mille and the table says ' +
      'five zeros, which reads as a measurement that cannot tell them apart.',
  );
  out.push('');
  out.push(
    ...table(
      ['group', 'members', 'scoreQ gap', 'raw gap', 'compactnessQ gap', 'thicknessQ gap', 'profileQ gap', 'valueQ gap'],
      distribution.pairs.map((pair) => [
        pair.group,
        pair.members
          .map(
            (m) =>
              `${m.id} [${m.note}, scoreQ ${m.scoreQ ?? '-'}, raw ${m.rawScoreQ ?? '-'}, cq ${m.compactnessQ ?? '-'}, tq ${m.thicknessQ ?? '-'}, vq ${m.valueQ ?? '-'}]`,
          )
          .join(' · '),
        pair.gap === null ? 'excluded' : String(pair.gap),
        pair.rawGap === null ? 'not separable' : String(pair.rawGap),
        pair.compactnessGap === null ? 'not separable' : String(pair.compactnessGap),
        pair.thicknessGap === null ? 'not separable' : String(pair.thicknessGap),
        pair.profileGap === null ? 'not separable' : String(pair.profileGap),
        pair.valueGap === null ? 'not separable' : String(pair.valueGap),
      ]),
    ),
  );
  out.push('');

  /* --- the human tier --- */
  out.push('## 7 · Human-rated tier');
  out.push('');
  const human = rows.filter((row) => row.tier === 'human');
  const rated = human.filter((row) => scores.ratings[row.id] !== undefined);
  out.push(
    `**${rated.length} of ${human.length}** human-tier cases have ratings in \`scores.json\`. ` +
      'The analyzer\'s own scores are deliberately withheld from this section: T-025 correlates the ' +
      "machine against the human, and a rater who has seen the machine's number is anchored to it.",
  );
  out.push('');
  out.push(
    ...table(
      ['case', 'canvas', 'frames', 'palette', 'ratings'],
      human.map((row) => [
        row.id,
        `${row.attributes.width}x${row.attributes.height}`,
        String(row.attributes.frames),
        String(row.attributes.palette),
        String((scores.ratings[row.id]?.raters.length ?? 0)),
      ]),
    ),
  );
  out.push('');

  /* --- declared quantities --- */
  out.push('## 8 · Thresholds: transcribed, and derived');
  out.push('');
  out.push(
    '`SPEC_GATES` in `format.ts` is a **transcription** of `docs/EVALUATION.md`, and a ' +
      'transcription is checkable where an import is not. `DERIVED_POLICY` is the other kind: ' +
      'numbers T-022 derived, kept in a record named for their owner because a gate that was ' +
      'picked rather than quoted is a gate somebody has to be accountable for. **This file moves ' +
      'neither**; the second block has no line in §4.1 at all.',
  );
  out.push('');
  out.push(
    ...table(
      ['number', 'value', 'where it comes from'],
      [
        ...Object.entries(SPEC_GATES).map(
          ([name, value]) => [`SPEC_GATES.${name}`, String(value), 'transcribed from docs/EVALUATION.md'] as const,
        ),
        ...(
          [
            ['thicknessQ', DERIVED_POLICY.thicknessQ],
            ['profileDeep', DERIVED_POLICY.profileDeep],
            ['holeNick', DERIVED_POLICY.holeNick],
          ] as const
        ).map(
          ([name, value]) =>
            [`DERIVED_POLICY.${name}`, String(value), DERIVED_POLICY.rationale[name]] as const,
        ),
      ],
    ),
  );
  out.push('');

  out.push('## 9 · §3.3 quantities: implemented, and still in conflict');
  out.push('');
  out.push(
    ...table(
      ['name', 'status', 'adopted here', 'needed by'],
      DECLARED_QUANTITIES.map((entry) => [
        entry.name,
        entry.status,
        entry.adopted ?? '-',
        entry.neededBy.join(', '),
      ]),
    ),
  );
  out.push('');
  for (const entry of DECLARED_QUANTITIES) {
    if (entry.status !== 'unimplemented' && !entry.discriminator) continue;
    out.push(`### \`${entry.name}\``, '');
    out.push(`§3.3 says: ${entry.specText}`, '');
    if (entry.adopted) out.push(`This repository uses: ${entry.adopted}`, '');
    if (entry.discriminator) {
      out.push(`**Discriminating case.** ${entry.discriminator}`, '');
      if (entry.discriminatorValues) {
        out.push(
          ...table(
            ['reading', 'value'],
            entry.discriminatorValues.map(([label, value]) => [label, String(value)]),
          ),
        );
        out.push('');
      }
    }
  }

  return `${out.join('\n')}\n`;
}
