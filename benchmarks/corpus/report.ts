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
import { buildSolidMask, connectedComponents, edgePixelCount } from '../../packages/core/src/quality/measure.js';
import type { Sprite } from '../../packages/core/src/index.js';
import {
  DECLARED_QUANTITIES,
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
  readonly edgePixels: number;
  readonly compactnessQ: number;
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
  /** The applicability predicates, called directly. */
  readonly preconditions: Readonly<Record<string, CorpusExcludedReason | null>>;
  readonly frames: readonly FrameReading[];
  /** The worst frame's score, the mean, and whether the analyzer took the minimum. */
  readonly worstScoreQ: number | null;
  /** `compactnessQ` of the frame that decided `worstScoreQ`, for the contrast-pair report. */
  readonly worstFrameCompactnessQ: number | null;
  readonly meanScoreQ: number | null;
  readonly tookMin: boolean | null;
  readonly connectivity: { four: number; eight: number } | null;
  /** The §6.2 contrast-pair group, when the case belongs to one. */
  readonly pair: string | null;
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
      preconditions: {},
      frames: [],
      worstScoreQ: null,
      worstFrameCompactnessQ: null,
      meanScoreQ: null,
      tookMin: null,
      connectivity: null,
      pair: null,
      attributes: attributesOf(sprite),
    };
  }

  if (sprite === null) throw new Error(`corpus: ${entry.id} is not a real case and produced no document`);
  const context = createQualityContext(sprite);
  const report = evaluate(context);
  const measurements = measureSilhouette(context);
  const readings = measurements.map((frame) => readingOf(context, frame));
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
    preconditions,
    frames: readings,
    worstScoreQ: frameScores.length === 0 ? null : Math.min(...frameScores),
    worstFrameCompactnessQ: worstFrame === null ? null : worstFrame.compactnessQ,
    meanScoreQ: frameScores.length === 0 ? null : Math.floor(frameScores.reduce((a, b) => a + b, 0) / frameScores.length),
    tookMin: frameScores.length < 2 ? null : report.dimensions.silhouette?.scoreQ === Math.min(...frameScores),
    connectivity,
    pair: entry.tier === 'synthetic' ? (entry.pair ?? null) : null,
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
    // §3.3's `edgePixels`, recorded beside `perimeter` on every row so the two never have to be
    // remembered as different quantities. They are close on a rectangle and diverge on anything
    // with a staircase, which is the whole reason §3.3 gives them a subsection each.
    edgePixels: edgePixelCount(mask, width, height),
    compactnessQ: frame.compactnessQ,
    holeCount: frame.holeCount,
    holeArea: frame.holeArea,
    borderTouch: frame.borderTouch,
    spanQ: frame.spanQ,
    convexCorners: frame.convexCorners,
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
  /** §6.2's contrast pairs, with the size of the gap. */
  readonly pairs: readonly {
    readonly group: string;
    readonly members: readonly {
      readonly id: string;
      /** The score the *report* delivered: `null` when the dimension was excluded. */
      readonly scoreQ: number | null;
      /** The score the measurement produced anyway, exclusion or not. */
      readonly rawScoreQ: number | null;
      readonly compactnessQ: number | null;
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

  const histogram: { from: number; to: number; count: number }[] = [];
  for (let b = 0; b < BUCKETS; b++) {
    const from = b * 100;
    const to = from + 100;
    histogram.push({
      from,
      to: to === 1000 ? 1000 : to,
      count: samples.filter((s) => s.compactnessQ >= from && s.compactnessQ < to).length,
    });
  }
  // A value of exactly 1000 has no bucket, because the loop's last bucket is exclusive at 1000
  // and the sweep's most compact subject lands there. Folded in rather than dropped, because a
  // distribution that silently loses its most compact subject is worse than one that is explicit.
  const overflow = samples.filter((s) => s.compactnessQ === 1000).length;
  if (overflow > 0) histogram[histogram.length - 1].count += overflow;

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

  const groups = new Map<string, CorpusRow[]>();
  for (const row of run.rows) {
    if (row.pair === null) continue;
    const group = groups.get(row.pair) ?? [];
    group.push(row);
    groups.set(row.pair, group);
  }
  const pairs = [...groups.entries()].map(([group, members]) => {
    const readings = members.map((row) => ({
      id: row.id,
      scoreQ: row.scores.silhouette ?? null,
      rawScoreQ: row.worstScoreQ,
      compactnessQ: row.worstFrameCompactnessQ,
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
    sensitivity,
    histogram,
    scores,
    pairs,
  };
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const PAD = '|';

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => (row[i] ?? '').length)));
  const line = (cells: readonly string[]): string =>
    `${PAD} ${cells.map((cell, i) => (cell ?? '').padEnd(widths[i])).join(` ${PAD} `)} ${PAD}`;
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)];
}

function listOrNone(values: readonly string[]): string {
  return values.length === 0 ? '-' : values.join(', ');
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
        String(frame.edgePixels),
        String(frame.compactnessQ),
        String(frame.holeCount),
        String(frame.borderTouch),
        String(frame.spanQ),
        String(frame.margin ?? '-'),
        String(frame.convexCorners),
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
        'edgePx',
        'compactQ',
        'holes',
        'edges',
        'spanQ',
        'margin',
        'cCorners',
        'scoreQ',
      ],
      measurementRows,
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
      ['case', 'requiresReadableSubject', 'motionApplicability', 'exclusions with a reason', 'blocking'],
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
          listOrNone(row.blocking),
        ]),
    ),
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
      'test and still wrong". Three gaps per pair, because they say different things: the ' +
      '**scoreQ** gap is what a report delivers, the **raw** gap is what the measurement produced ' +
      'even where the aggregator refused to deliver it, and the **compactnessQ** gap is the ' +
      "dimension's own measurement, which is usually an order of magnitude larger than the score " +
      'because the penalty is a step function.',
  );
  out.push('');
  out.push(
    ...table(
      ['group', 'members', 'scoreQ gap', 'raw gap', 'compactnessQ gap'],
      distribution.pairs.map((pair) => [
        pair.group,
        pair.members
          .map(
            (m) =>
              `${m.id} [${m.note}, scoreQ ${m.scoreQ ?? '-'}, raw ${m.rawScoreQ ?? '-'}, cq ${m.compactnessQ ?? '-'}]`,
          )
          .join(' · '),
        pair.gap === null ? 'excluded' : String(pair.gap),
        pair.rawGap === null ? 'not separable' : String(pair.rawGap),
        pair.compactnessGap === null ? 'not separable' : String(pair.compactnessGap),
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
  out.push('## 8 · §3.3 quantities: implemented, and still in conflict');
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
