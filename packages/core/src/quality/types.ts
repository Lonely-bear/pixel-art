import type { AnimationTag, Layer } from '../document.js';
import type { Color, FrameId, LayerId, Rect, SpriteId } from '../types.js';

/**
 * The quality-analysis contract.
 *
 * Six dimensions, each produced by one small pure function, combined into a single
 * weighted score. This file is the *only* thing the six analyzers and the aggregator
 * share, which is why it lands first: once it is frozen the dimensions are six
 * independent files that can be written, reviewed and calibrated in parallel.
 *
 * Three rules are structural here rather than left to reviewer discipline, because CI
 * compares analyzer output against committed baselines:
 *
 *   - **Deterministic.** No clock, no randomness, no reliance on hash or float
 *     iteration order. The same document in the same focus rect must produce the same
 *     numbers on every machine, so a baseline diff means the artwork changed rather
 *     than the run.
 *   - **Read-only.** Analyzers are not commands: no undo semantics, no version bump,
 *     no writes. `QualityContext` hands out a *view* of the sprite whose mutating
 *     methods do not exist, so `cel.setColor(...)` inside an analyzer is a compile
 *     error rather than a corrupted document.
 *   - **Per-mille.** Every score in the pipeline is a **per-mille integer, 0..1000**, and
 *     higher is always better, so dimensions can be weighted against one another without
 *     per-dimension fudge factors and every threshold is an exact integer comparison. The
 *     one and only float is {@link QualityReport.score}, the derived 0..1 total that goes
 *     on the wire, via {@link unitScore}. A per-dimension score is `scoreQ`; a report
 *     total is `score`. The names carry the units so the two cannot be confused.
 */

/**
 * The six dimension ids, in the order the pipeline runs them: cheapest and most
 * reliable signal first, so a cheap answer can short-circuit the expensive ones and a
 * reader who only looks at one number looks at the one that matters most.
 *
 * A new id is a new file and a new row in {@link QUALITY_DIMENSIONS} and
 * {@link QualityWeights}. Widening this union without those two is what the
 * compile-time guard at the bottom of this file exists to catch.
 */
export type QualityDimensionId =
  | 'silhouette'
  | 'value'
  | 'palette'
  | 'noise'
  | 'outline'
  | 'motion';

/**
 * Every {@link QualityDimensionId}, in pipeline order, for callers that must not
 * repeat the list (the aggregator, the report renderer, the calibration harness).
 *
 * Typed as a literal tuple rather than the plain `readonly QualityDimensionId[]` so
 * that two things are true at once: it is still assignable to that wider type for any
 * caller, and adding a dimension to the union without adding a row here fails the
 * build in this file instead of producing a report with a silently missing key.
 */
export const QUALITY_DIMENSIONS = [
  'silhouette',
  'value',
  'palette',
  'noise',
  'outline',
  'motion',
] as const satisfies readonly QualityDimensionId[];

/**
 * One thing that is wrong with the artwork, specific enough to act on.
 *
 * An issue is the *unit of advice*: the `fix` command turns these into operations and
 * the gate turns the blocking ones into a refusal, so a vague issue is worse than no
 * issue at all.
 */
export interface QualityIssue {
  /**
   * Stable machine-readable code, e.g. `'low-contrast'`.
   *
   * Stable means stable: these strings are an API for agents that branch on them, so
   * renaming one is a breaking change. Analyzers own their codes, and the same code
   * from two dimensions means the same defect.
   */
  readonly code: string;
  /** Human-readable explanation. Read by a person or a model, never parsed. */
  readonly message: string;
  /**
   * Where to fix it, in absolute canvas coordinates, or `null` when the defect is not
   * localisable (a palette-wide discipline problem, say).
   *
   * Absolute, not relative to `QualityContext.focus`: a `fix` op addresses canvas
   * pixels, so an issue that meant "here" relative to a focus rect would send the edit
   * somewhere else entirely.
   */
  readonly rect: Rect | null;
  /** 0..1. At or above {@link SEVERITY_BLOCKING} the issue blocks delivery. */
  readonly severity: number;
}

/**
 * One dimension's verdict on the artwork.
 *
 * Deliberately carries no dimension id: the id is the key this lands under in
 * {@link QualityReport.dimensions}, so the same shape can describe a sub-score without
 * inventing a second identity field that can disagree with the map it was stored in.
 *
 * Note the field name collides with {@link QualityReport.verdict} and the two are not
 * the same thing: this is free text for a human or an agent, that one is a gate
 * decision. A dimension that fails badly can still sit inside a passing report, and a
 * well-worded dimension can sit inside a failing one.
 */
export interface QualityDimension {
  /**
   * This dimension's score: a **per-mille integer, 0..1000**, higher is better.
   *
   * The `Q` suffix is the unit, and it is load-bearing. The spec measures every ratio in
   * integer form so that no threshold anywhere is evaluated as a float, and aggregation
   * needs a per-mille input for its one round-half-up division. An analyzer therefore ends
   * with the number its band table and adjustments already produced — **940, not 0.94** —
   * and must not divide on the way out.
   *
   * Named `scoreQ` rather than `score` so that it cannot be confused with
   * {@link QualityReport.score}, which is the *other* unit: a 0..1 float, the serialised
   * total. Two fields called `score` meaning two different things across two interfaces is
   * a trap that only pays out once six analyzers have been written against it in parallel;
   * {@link unitScore} is the one conversion between them, in that direction only.
   */
  readonly scoreQ: number;
  /** One sentence: what this dimension thinks of the artwork. */
  readonly verdict: string;
  /** Actionable problems; empty means nothing here needs doing. */
  readonly issues: readonly QualityIssue[];
}

/**
 * Why a dimension is absent from a report.
 *
 * A closed enum, not a string and not free text: an agent has to be able to tell "this
 * sprite has no animation, so motion does not apply" from "the motion analyzer crashed
 * and left a hole" without pattern-matching prose. Both current reasons describe a
 * document that cannot be measured, which is exactly what "not applicable" means.
 */
export type ExcludedReason = 'single-frame' | 'no-motion-content';

/** The whole assessment: the applicable dimensions, one weighted score, one gate decision. */
export interface QualityReport {
  /**
   * The dimensions that were actually measured. A key may be **absent**, which means not
   * applicable — never a sentinel score, and in particular never `0`.
   *
   * Absence has to be safe against a client that forgets to check, because that client is
   * an agent: a missing key cannot be averaged in by accident, whereas a `0.0` would be
   * silently averaged in by every caller that trusted the field. `motion` on a still
   * sprite is the case in practice.
   */
  readonly dimensions: Readonly<Partial<Record<QualityDimensionId, QualityDimension>>>;
  /**
   * Why each absent dimension is absent, keyed by the same ids. May be empty; may never
   * be omitted.
   *
   * Required rather than optional, and that is the entire point of the field. Making
   * `dimensions` partial moves the burden onto this map: a report missing a dimension has
   * to say why, or a reader still cannot tell "scored zero" from "never measured" — which
   * was the objection to a partial record in the first place, and it only goes away when
   * the reason is mandatory rather than best-effort.
   *
   * **The invariant, which the types cannot express: the keys of `excluded` are exactly
   * the keys missing from `dimensions`, and no id is in both.** Every dimension id is
   * therefore accounted for exactly once — measured, or excluded with a reason. The
   * aggregator owns it; {@link assertReportInvariants} checks it.
   */
  readonly excluded: Readonly<Partial<Record<QualityDimensionId, ExcludedReason>>>;
  /**
   * The weighted total, 0..1 — the serialised form of the per-mille integer the
   * aggregation actually computed, via {@link unitScore}. 0..1 and not 0..1000 because
   * this field is the report's public face, and the spec's own notation keeps the
   * per-mille integer for the pipeline's internals.
   */
  readonly score: number;
  /** 'pass' is shippable, 'warn' is shippable with eyes open, 'fail' is not. */
  readonly verdict: 'pass' | 'warn' | 'fail';
  /** Every issue at or above {@link SEVERITY_BLOCKING}. Never empty when verdict is 'fail'. */
  readonly blocking: readonly QualityIssue[];
}

/**
 * Severity at which an issue stops being advice and becomes a gate.
 *
 * The comparison is `>=`, inclusive, and lives here rather than inline in the gate
 * because `evaluate` (which reports) and `verify` (which refuses to finalise) must
 * never disagree about which defects are the blocking ones.
 */
export const SEVERITY_BLOCKING = 0.5;

/**
 * The one severity comparison in the pipeline: an issue blocks at or above
 * {@link SEVERITY_BLOCKING}, inclusively.
 *
 * A named function rather than an inline `>=` because two places have to agree — the
 * aggregator that *assembles* the blocking list and the verdict that *consumes* it — and
 * because {@link verdictFor} re-checks with it instead of trusting the array it was
 * handed. A caller passing an unfiltered list would otherwise fail every report on a
 * 0.35 advisory; a caller filtering too aggressively would let a 0.50 through. Same bug,
 * different clothes.
 */
export function isBlocking(issue: QualityIssue): boolean {
  return issue.severity >= SEVERITY_BLOCKING;
}

/**
 * Per-dimension score below which a report is `fail` on that dimension alone, in
 * per-mille. The weighted mean cannot see this, which is the point.
 *
 * A sprite whose silhouette is 0.40 and whose other five dimensions are all 1.0 averages
 * 0.90. Under a mean-only rule that is a `pass`, and it is not shippable: a weighted mean
 * is allowed to hide one broken dimension behind five good ones, and a broken silhouette
 * means the asset does not work in the game no matter how disciplined the palette is.
 *
 * The two style dimensions sit lower on purpose — a loose `outline` and a slightly speckly
 * `noise` are taste, and a clean-up pass that sands a piece flat has not improved it — but
 * lower, not exempt. They still fail a report on their own.
 *
 * Per-mille integers, like every score in the pipeline, so the comparison is a plain
 * integer test with no epsilon. Compare a dimension's `scoreQ` with {@link isBelow}, never
 * with a hand-rolled `scoreQ < 400`.
 */
export const FLOOR_FAIL: Readonly<Record<QualityDimensionId, number>> = {
  silhouette: 400,
  value: 400,
  palette: 400,
  noise: 300,
  outline: 300,
  motion: 400,
};

/** Per-dimension score below which a report is at best 'warn', in per-mille. Every dimension. */
export const FLOOR_WARN = 600;

/** Weighted total below which a report is 'fail', in per-mille. */
export const SCORE_FAIL_THRESHOLD = 550;

/** Weighted total at or above which a report can be 'pass', in per-mille. */
export const SCORE_PASS_THRESHOLD = 800;

/**
 * The one threshold comparison in the pipeline, for both dimension floors and the
 * total-score thresholds.
 *
 * Every "is this good enough" question in the quality system is `isBelow(x, floor)` and
 * nothing else. Six analyzers and a gate each inventing their own epsilon is how a report
 * ends up failing in the renderer and passing in CI; this is where that gets settled.
 *
 * Both sides are per-mille integers, so the comparison is exact — no division, so two
 * platforms cannot disagree about the last bit of a quotient neither performs.
 *
 * **Fails closed.** A non-finite or malformed score is reported as below every floor, so
 * `NaN` fails the report instead of sailing through every threshold by making each
 * comparison false. That direction also means passing a 0..1 unit score where a per-mille
 * one belongs produces a false `fail` rather than a false `pass` — the unit mistake is
 * loud rather than silent.
 */
export function isBelow(scoreQ: number, floorQ: number): boolean {
  if (!Number.isFinite(scoreQ) || !Number.isFinite(floorQ)) return true;
  return scoreQ < floorQ;
}

/**
 * The one place pass/warn/fail is decided, and the only path to a verdict.
 *
 * Replaces the earlier two-argument `(score, hasBlocking)` form, which is *incapable* of
 * expressing the per-dimension floors — it could not see the dimensions at all — and
 * keeping it beside this one would have left two functions in the file able to disagree
 * about whether a report passes. Precedence is `fail` > `warn` > `pass`, evaluated in that
 * order, so no report is ever ambiguous.
 *
 *   - `fail`  any blocking issue, or any *present* dimension below its `FLOOR_FAIL`, or
 *             the total below `SCORE_FAIL_THRESHOLD`.
 *   - `warn`  the total below `SCORE_PASS_THRESHOLD`, or any *present* dimension below
 *             `FLOOR_WARN`.
 *
 * Two properties are deliberate and should survive a well-meaning refactor. First, a
 * blocking issue short-circuits to `fail` regardless of score, and that is the whole point
 * of the severity scale: `empty-frame` (severity 1.00) fires when there is nothing opaque
 * to measure, every dimension then reports 1000 because there is nothing to fault, and the
 * verdict is still `fail`. A blank canvas is not bad artwork, it is *no* artwork, and a
 * mean cannot express that. Second, the floors apply to present dimensions only — an
 * excluded dimension was never measured, so it cannot fail a floor it was never measured
 * against, which is exactly what a partial `dimensions` record buys.
 *
 * Every comparison goes through {@link isBelow}, so a malformed score fails closed rather
 * than passing by accident.
 */
export function verdictFor(input: VerdictInput): QualityReport['verdict'] {
  if (input.blocking.some(isBlocking)) return 'fail';
  for (const id of QUALITY_DIMENSIONS) {
    const dim = input.dimensions[id];
    if (dim !== undefined && isBelow(dim.scoreQ, FLOOR_FAIL[id])) return 'fail';
  }
  if (isBelow(input.totalQ, SCORE_FAIL_THRESHOLD)) return 'fail';
  for (const id of QUALITY_DIMENSIONS) {
    const dim = input.dimensions[id];
    if (dim !== undefined && isBelow(dim.scoreQ, FLOOR_WARN)) return 'warn';
  }
  if (isBelow(input.totalQ, SCORE_PASS_THRESHOLD)) return 'warn';
  return 'pass';
}

/**
 * The three things a verdict depends on — everything else in a report is downstream of
 * them, and a verdict cannot be derived from anything else.
 *
 * `totalQ` is the per-mille integer the aggregation computed, *not*
 * {@link QualityReport.score}. The caller is expected to hold that integer and serialise
 * it with {@link unitScore}, because the report's float field is a presentation value:
 * the verdict is decided on integers so that no boundary is a float boundary. Pass the
 * report's `score` here by mistake and every total lands far below every threshold, which
 * fails the report loudly rather than quietly — see {@link isBelow}.
 */
export interface VerdictInput {
  /** Weighted total in per-mille, 0..1000. See {@link unitScore} to serialise it. */
  readonly totalQ: number;
  /** The measured dimensions. Absent keys are excluded and take no part in the verdict. */
  readonly dimensions: Readonly<Partial<Record<QualityDimensionId, QualityDimension>>>;
  /**
   * Every issue at or above {@link SEVERITY_BLOCKING}, from every present dimension plus
   * the aggregator's own (`empty-frame`, `frames-identical`).
   *
   * Assembling this list is the aggregator's job, not this function's: deduplicating by
   * `(code, rect)` and sorting by severity descending then code ascending, so the list is
   * stable across runs and diffable in CI. This function re-checks each entry with
   * {@link isBlocking} rather than trusting the filtering, so a caller that passed
   * everything it had still gets the right verdict.
   */
  readonly blocking: readonly QualityIssue[];
}

/**
 * Per-mille integer -> the 0..1 float that goes on the wire. The only float in the whole
 * pipeline.
 *
 * A named function because "the only float is `scoreQ / 1000` at serialisation" is a
 * rule, and a rule with six call sites is a rule with six chances to be applied slightly
 * differently: `0.94` versus `0.9400000000000001` is a baseline diff nobody can explain.
 */
export function unitScore(scoreQ: number): number {
  return clamp01(scoreQ / 1000);
}

/**
 * Clamp to the 0..1 band every serialised score lives in, and the *only* clamping rule in
 * the quality pipeline.
 *
 * Defined once because six analyzers that each clamp slightly differently produce scores
 * that look comparable and are not — and because the report is compared against committed
 * baselines, so the edge cases are load-bearing, not pedantry:
 *
 *   - `NaN` becomes 0, not `NaN`. A score that is not a number is never a good score,
 *     and letting it reach the aggregate would poison the weighted mean silently.
 *   - `Infinity` becomes 1 and `-Infinity` becomes 0: an unbounded ratio really is
 *     "infinitely bad" and clamping it to 0 would hide it.
 *   - `-0` becomes `0`. `Object.is` and `-0.toFixed(3)` disagree with `0`, and that
 *     is exactly the sort of difference a baseline diff should never be explaining.
 *
 * Deliberately does *not* round. Rounding is a presentation decision and belongs in
 * whoever formats the report; rounding here would quantise every score in the pipeline.
 *
 * Its remaining job in a per-mille pipeline is the serialisation boundary: everything
 * above it is an integer, and {@link unitScore} is the one place a score becomes a float.
 */
export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value === 0 ? 0 : value;
}

/**
 * Everything wrong with a report that the types cannot prevent. Empty means the report is
 * well-formed.
 *
 * These are checks on the *whole* report, which is why they are functions and not fields:
 * a partial `dimensions` record and a required `excluded` map can express "this dimension
 * was excluded, and here is why" but they cannot express "these two maps are consistent
 * with each other", and consistency between them is the entire invariant. Written once so
 * the aggregator, the gate and the tests cannot each check a different subset.
 *
 * What is checked:
 *
 *   1. Every dimension id is accounted for exactly once — present in `dimensions`, or in
 *      `excluded` with a reason, never both and never neither. An id in neither is the
 *      silent hole: a dimension that was never measured and never explained.
 *   2. `verdict !== 'pass'` when a blocking issue exists.
 *   3. `verdict === 'fail'` when a present dimension is below its `FLOOR_FAIL`, or when
 *      any score is malformed. A report that trips a floor and is not a `fail` is the
 *      aggregator having hand-rolled a verdict.
 *   4. Every dimension `scoreQ` is an integer in 0..1000, and the report total is in 0..1.
 *
 * What is *not* checked, and why: whether the total is above or below the two total-score
 * thresholds. Those need `totalQ`, and the report deliberately carries only the serialised
 * float — re-deriving the integer from it would reintroduce exactly the float arithmetic
 * the per-mille discipline exists to avoid, and a validator that cries wolf on a
 * legitimately-rounded wire value is worse than no validator. The aggregator passes the
 * same `totalQ` to {@link verdictFor} that it serialised, and the gates in (2) and (3)
 * cover the part of the rule that does not depend on it.
 */
export function reportInvariantViolations(report: QualityReport): string[] {
  const problems: string[] = [];
  for (const id of QUALITY_DIMENSIONS) {
    const measured = report.dimensions[id] !== undefined;
    const excluded = report.excluded[id] !== undefined;
    if (measured && excluded) {
      problems.push(`${id}: present in both dimensions and excluded`);
    } else if (!measured && !excluded) {
      problems.push(`${id}: neither measured nor excluded`);
    }
  }
  for (const id of Object.keys(report.excluded) as QualityDimensionId[]) {
    if (report.dimensions[id] === undefined && report.excluded[id] === undefined) continue;
    if (!QUALITY_DIMENSIONS.includes(id)) problems.push(`${id}: unknown dimension id`);
  }
  const blockingCount = report.blocking.filter(isBlocking).length;
  if (report.verdict === 'pass' && blockingCount > 0) {
    problems.push(`pass with ${blockingCount} blocking issue(s)`);
  }
  for (const id of QUALITY_DIMENSIONS) {
    const dim = report.dimensions[id];
    if (dim === undefined) continue;
    const { scoreQ } = dim;
    if (!Number.isInteger(scoreQ) || scoreQ < 0 || scoreQ > 1000) {
      problems.push(`${id}: scoreQ ${scoreQ} is not an integer in 0..1000`);
    }
    if (report.verdict !== 'fail' && isBelow(scoreQ, FLOOR_FAIL[id])) {
      problems.push(`${id}: scoreQ ${scoreQ} is below FLOOR_FAIL ${FLOOR_FAIL[id]} but verdict is ${report.verdict}`);
    }
    for (const issue of dim.issues) {
      if (!Number.isFinite(issue.severity) || issue.severity < 0 || issue.severity > 1) {
        problems.push(`${id}/${issue.code}: severity ${issue.severity} is not in 0..1`);
      }
    }
  }
  if (!Number.isFinite(report.score) || report.score < 0 || report.score > 1) {
    problems.push(`report score ${report.score} is not in 0..1`);
  }
  return problems;
}

/** True when {@link QualityReport} satisfies every invariant. For tests and cheap assertions. */
export function reportInvariantsHold(report: QualityReport): boolean {
  return reportInvariantViolations(report).length === 0;
}

/**
 * Throw unless the report satisfies every invariant. This is the form the aggregator uses.
 *
 * Throwing is right there and wrong everywhere else: a malformed report at the aggregation
 * step is a bug in the aggregator, not bad artwork, and bad artwork is what
 * `QualityReport.verdict` is for. A gate that refused to finalise a sprite because its
 * *own* report was internally inconsistent would be indistinguishable from the product
 * saying the art was bad.
 *
 * Throws a plain `Error`, not a `CommandError`: this file takes no runtime import at all,
 * and pulling the bus in here to borrow an error class would make every consumer of the
 * quality types load the command machinery. The command boundary (T-019) wraps this in a
 * `CommandError` with a code, which is where AD-3's "failures carry a code" rule applies.
 */
export function assertReportInvariants(report: QualityReport): void {
  const problems = reportInvariantViolations(report);
  if (problems.length === 0) return;
  throw new Error(`Malformed quality report: ${problems.join('; ')}`);
}

/**
 * How much each dimension counts toward {@link QualityReport.score}.
 *
 * **Per-mille integers, 0..1000, summing to 1000.** Integers rather than fractions of 1
 * because they are multiplied by per-mille scores and summed into one round-half-up
 * division: `Σ wᵢ · sᵢ` stays an exact integer below 2^53, where a float would be
 * comparing its last bit against a threshold.
 *
 * Relative, not absolute: the denominator is the sum of the weights that actually
 * contributed, so dropping a dimension to 0 removes it from the mean instead of
 * redistributing its share to the others by accident. That is what makes
 * {@link STATIC_QUALITY_WEIGHTS} safe, and it is why the still-sprite total is a
 * 920-denominator mean that is *not* rescaled back onto 1000.
 *
 * Re-tuning these moves every committed baseline, so it is a product decision and not a
 * code cleanup. `test/quality-weights.test.ts` parses this table back out of
 * `docs/EVALUATION.md` §5.1 and fails the build when the two disagree, because the spec
 * and the code were written in parallel once already and disagreed silently.
 */
export type QualityWeights = Readonly<Record<QualityDimensionId, number>>;

/**
 * Default weighting, per-mille: silhouette 300, value 260, palette 140, noise 120,
 * outline 100, motion 80.
 *
 * The authority for these numbers is the specification's §5.1 table, and the reasoning
 * there is the reasoning here: silhouette is the sprite, value is the only other thing
 * that survives downscaling and engine tinting, palette is a real technical contract but
 * a good sprite on a muddy palette is still a good sprite, noise is cheap to fix and
 * highly visible but a few specks do not make a sprite unrecognisable, outline is a style
 * choice and must not carry more than a tenth without the scorer overruling taste, and
 * motion is real but only for animations.
 */
export const DEFAULT_QUALITY_WEIGHTS: QualityWeights = {
  silhouette: 300,
  value: 260,
  palette: 140,
  noise: 120,
  outline: 100,
  motion: 80,
};

/**
 * The default weights with `motion` removed, for a document with a single frame.
 *
 * A still sprite must not be penalised for motion, and it must not be handed a fake
 * perfect motion score either: `dimensions` is a partial record, so the aggregator simply
 * omits `motion` and records `excluded.motion = 'single-frame'`. The remaining five sum
 * to **920**, and that is the denominator — the weights are deliberately *not* rescaled
 * onto 1000, so a still sprite scoring 0.88 across the five applicable dimensions reports
 * 0.88 rather than 0.81. Renormalising into floats at runtime would make the total depend
 * on the active set in a way that is hard to diff and hard to explain in a CI log.
 */
export const STATIC_QUALITY_WEIGHTS: QualityWeights = {
  ...DEFAULT_QUALITY_WEIGHTS,
  motion: 0,
};

/**
 * The palette as an analyzer sees it.
 *
 * A view rather than `Palette` for one reason: `Palette.colors` is a live array,
 * and `sort()` or `splice()` on it would reorder the artist's palette with no undo
 * entry. The swatch *values* stay plain {@link Color} — a mutated channel there is
 * contained inside the analyzer, which is a bug it cannot escape from.
 */
export interface QualityPalette {
  readonly id: string;
  readonly name: string;
  /** Index order, because palette indices are what the artwork is written in. */
  readonly colors: readonly Color[];
  /** Optional semantic role by decimal index, e.g. `"3": "skin"`. */
  readonly roles?: Readonly<Record<string, string>>;
}

/**
 * One layer's pixels on one frame, with every mutating method removed.
 *
 * This is where the read-only rule is enforced by the compiler rather than by review:
 * `setColor`, `fill`, `clear`, `blit`, `blitRegion`, `scale` and `clone` are simply not
 * in the type, so an analyzer cannot reach them. A live `PixelBuffer` satisfies this
 * interface as-is, which is the point — no copying, no adapter.
 */
export interface QualityCel {
  readonly width: number;
  readonly height: number;
  /**
   * Raw RGBA8888, 4 bytes per pixel, row-major, y-down.
   *
   * Read it, do not write it. TypeScript has no immutable typed array, so this one
   * field is the seam in the contract; an analyzer that needs to write takes its own
   * buffer rather than reaching through here. A byte written here would land in the
   * user's artwork with no undo entry behind it.
   */
  readonly data: Uint8ClampedArray;
  /** Byte offset of a pixel. Cheaper than `getColor` in a scan. */
  index(x: number, y: number): number;
  contains(x: number, y: number): boolean;
  getColor(x: number, y: number): Color;
}

/** One frame: its identity, its timing, and the layers that contribute to it. */
export interface QualityFrame {
  readonly id: FrameId;
  /** How long the frame is shown, in milliseconds. Motion needs this, not just order. */
  readonly durationMs: number;
  /**
   * Sparse layer -> pixels. A missing entry means the layer contributes nothing on this
   * frame, which composites the same as an empty buffer but is cheaper to detect.
   */
  readonly cels: ReadonlyMap<LayerId, QualityCel>;
}

/**
 * A sprite as an analyzer sees it: a structural allowlist, not a copy.
 *
 * A live `Sprite` is assignable to this type field for field, so the aggregator hands
 * the document straight through with no clone and no adapter — an evaluation costs one
 * pass per dimension, not a deep copy per dimension.
 *
 * It is deliberately *not* a `Sprite` in the other direction: a readonly view cannot be
 * passed to `compositeFrame`, `frameMask` or any other core helper typed on the mutable
 * model, because those helpers can write. That asymmetry is the price of enforcing
 * read-only at the type level, and it is why the flattened frames arrive pre-built in
 * {@link QualityContext.composite} instead of being derived by each analyzer.
 *
 * The cost of an allowlist is that a document feature added later is invisible to every
 * analyzer until someone adds it here. That is the intended failure: a new feature
 * that silently reached the quality pipeline would change existing scores, whereas
 * being invisible shows up as "the analyzer does not know about that yet".
 */
export interface QualitySprite {
  readonly id: SpriteId;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** Paint order, index 0 is the bottom-most layer. */
  readonly layers: readonly Readonly<Layer>[];
  readonly frames: readonly QualityFrame[];
  readonly palette: QualityPalette;
  /** Animation loops. Motion needs these to tell a real loop seam from a frame gap. */
  readonly tags: readonly Readonly<AnimationTag>[];
}

/**
 * Everything an analyzer is allowed to look at, and the whole of what it is allowed to
 * look at.
 *
 * The type is the enforcement: an analyzer cannot reach the document, a `Draft`, the
 * bus or the filesystem from here, so "read-only" is a compile error rather than a
 * review comment. Everything an analyzer needs to be deterministic and reproducible is
 * in this object — anything it might want to read that is *not* here does not get to
 * influence a score.
 */
export interface QualityContext {
  /**
   * The document under evaluation, as a view. See {@link QualitySprite}.
   *
   * Carries what the flattened `composite` does not: layer identities and names, frame
   * timing, animation tags. If a score is computed from something in here rather than
   * from `composite`, two dimensions measuring the same thing two different ways is
   * the likeliest way for this pipeline to produce a confident wrong answer.
   */
  readonly sprite: QualitySprite;
  /**
   * Frames to evaluate, in playback order — the order the viewer sees them, not
   * document order. A still sprite is a list of exactly one id, and a tagged loop is
   * the tag's frames in the tag's direction, so motion can measure the seam between the
   * last frame and the first without knowing anything about tags.
   *
   * Every dimension must return a `scoreQ` for every context, including this degenerate
   * one. A dimension with nothing to measure says so in its `verdict`; it does not
   * return 0, which would be indistinguishable from "measured, and it is bad". Note that
   * applicability is the *aggregator's* call, not the analyzer's: it owns `excluded`, and
   * a still sprite's `motion` key is omitted from the report rather than filled in with a
   * placeholder score.
   */
  readonly frameIds: readonly FrameId[];
  /** The sprite's palette, hoisted so the palette dimension does not walk the document. */
  readonly palette: QualityPalette;
  /**
   * The frames to judge, already flattened: index `i` is `frameIds[i]`, composited
   * through layer order, opacity, blend mode and visibility, at `width` x `height`.
   *
   * Every score is measured here, never on a raw cel. `render.compositeFrame` already
   * gets the model right and six dimensions that each flattened the layers their own
   * way would disagree about what the artwork even is — which is worse than any
   * individual scoring error, because the aggregate would then be arithmetically sound
   * and semantically meaningless. A `PixelBuffer` satisfies {@link QualityCel} as-is,
   * so the aggregator builds this with `compositeFrame` and no adapter.
   *
   * Present in the context, and index-aligned with `frameIds`, rather than left for
   * analyzers to derive: a readonly view of the sprite cannot itself be passed to
   * `compositeFrame` (see {@link QualitySprite}), so without this field there is no
   * supported way for an analyzer to see a finished frame.
   */
  readonly composite: readonly QualityCel[];
  /**
   * Canvas size, hoisted for the same reason, and because every dimension needs it on
   * its first line. Denormalised from `sprite` on purpose: these are the fields that
   * must be identical across all six passes, and the caller sets all of them from one
   * sprite so they cannot drift.
   */
  readonly width: number;
  readonly height: number;
  /**
   * The region to judge, or `null` for the whole canvas.
   *
   * This is a scope, not a crop: analyzers measure inside it and report
   * `issue.rect` in absolute canvas coordinates. Nothing is clipped, so a defect whose
   * evidence is just outside the box is still worth an issue.
   */
  readonly focus: Rect | null;
}

/**
 * What each analyzer module exports: a plain function of the context, no class and no
 * `this`.
 *
 * The shape is trivial on purpose — six files that are trivially parallel, trivially
 * testable against a hand-built context, and trivially replaceable when calibration
 * says the scoring is wrong. A class would buy nothing here and would make each
 * analyzer harder to call from a test.
 *
 * Contract: pure, deterministic, no writes, and it must return a `scoreQ` for every
 * context it is handed rather than throwing on a degenerate one. An analyzer that
 * cannot measure something says so in its `verdict` and contributes no issues.
 */
export type QualityAnalyzer = (context: QualityContext) => QualityDimension;

/**
 * Compile-time guard: every dimension id is registered in every place a dimension has to
 * be named — {@link QUALITY_DIMENSIONS}, {@link DEFAULT_QUALITY_WEIGHTS},
 * {@link STATIC_QUALITY_WEIGHTS} and {@link FLOOR_FAIL}.
 *
 * `FLOOR_FAIL` is in this list because a dimension with no floor is the same mistake as a
 * dimension with no weight: it is scored, weighted, and then nothing can stop it dragging a
 * report down, or hide behind five good dimensions — the exact failure the floors exist to
 * prevent. It was added to the union, so it belongs here.
 *
 * Written as a *constrained* alias, not a `declare const`. A `declare const x: T` is a
 * legal declaration for any `T`, so it resolves the check and then raises nothing — the
 * guard is only as strong as its most recent reader's patience. A type argument that does
 * not satisfy `T extends true` is an error at the alias itself, checked whether or not
 * anything consumes the alias, so this one fires.
 *
 * The weight and floor directions look redundant against the `QualityWeights` and
 * `Readonly<Record<QualityDimensionId, number>>` annotations on those objects, and partly
 * are: those annotations are real constraints and they do catch a missing key. They do not
 * catch a *new* key added to the union and to one place but forgotten in another, and they
 * say nothing about which source is at fault. This check covers all four in one place and
 * names the guilty source in the error.
 *
 * The other direction is covered without a guard, and deliberately so:
 * `QUALITY_DIMENSIONS` carries `satisfies readonly QualityDimensionId[]`, so it can never
 * list an id the union does not have, and the other three objects are annotated with a
 * `Record` over the union, so none can be missing one. This alias is the gap those leave: a
 * dimension that is half-registered, which the aggregator would iterate straight past
 * without a word.
 */
type AssertTrue<T extends true> = T;

/** Key set of each source a dimension id has to appear in. */
type DimensionKeySets = {
  QUALITY_DIMENSIONS: (typeof QUALITY_DIMENSIONS)[number];
  DEFAULT_QUALITY_WEIGHTS: keyof typeof DEFAULT_QUALITY_WEIGHTS;
  STATIC_QUALITY_WEIGHTS: keyof typeof STATIC_QUALITY_WEIGHTS;
  FLOOR_FAIL: keyof typeof FLOOR_FAIL;
};

/**
 * One `{ missingFrom }` marker per incomplete source, or `never` when all of them are
 * complete. The tuple brackets keep `extends [never]` a plain non-distributive comparison,
 * so completeness is decided by the test and not by union reduction.
 */
type Unregistered = {
  [Source in keyof DimensionKeySets]: [Exclude<QualityDimensionId, DimensionKeySets[Source]>] extends [never]
    ? never
    : { missingFrom: Source };
}[keyof DimensionKeySets];

type _EveryDimensionIsRegistered = AssertTrue<[Unregistered] extends [never] ? true : Unregistered>;
