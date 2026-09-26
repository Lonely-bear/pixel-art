import { buildSolidMask, silhouetteAnalyzer } from './silhouette.js';
import {
  assertReportInvariants,
  DEFAULT_QUALITY_WEIGHTS,
  isBlocking,
  QUALITY_DIMENSIONS,
  unitScore,
  verdictFor,
  type ExcludedReason,
  type QualityAnalyzer,
  type QualityCel,
  type QualityContext,
  type QualityDimension,
  type QualityDimensionId,
  type QualityIssue,
  type QualityReport,
} from './types.js';

/**
 * The quality aggregator: applicability, the weighted total, and the verdict.
 *
 * Six dimensions each produce a per-mille score, and this turns them into one
 * `QualityReport`. There is exactly one division in the whole pipeline and it is here.
 *
 * ## Why applicability lives in this file
 *
 * The first committed implementation of `silhouette` was run against this repository's own
 * artwork, and it was confidently wrong on ten of twelve files: **every full-bleed
 * environment scored 800 with a blocking `shape-clipped` issue**, because for a scene whose
 * ink runs to the frame the alpha boundary *is* the canvas edge, there is no shape to
 * measure and the measurement read as a defect. The twelfth file, the only real character
 * sprite, was told it had a thin profile.
 *
 * A scorer that reports a confident wrong number about good work is worse than no scorer,
 * so the fix is not a threshold. It is that **a dimension declares its own precondition**,
 * and a dimension that cannot measure this document contributes no number at all:
 *
 *   - A full-bleed scene has no silhouette and no outline, and does have value structure
 *     and a palette — which is why applicability is decided per dimension and *not* by
 *     labelling the document as a "character" or a "background". A document-level class is
 *     the wrong abstraction; it would have to know what every dimension is for.
 *   - The mechanism is the one `motion` already had for a still sprite: the key is
 *     **absent** from `dimensions` and the reason is recorded in the required `excluded`
 *     map. Never a sentinel score, and never `0` — `0` is silently averaged in by every
 *     caller that trusted the field, while a missing key cannot be.
 *
 * So this file owns three things and nothing else: which dimensions apply, what the
 * weighted number is, and what the verdict is. The measurements belong to the analyzers.
 *
 * ## The formula, and the pairing that is load-bearing
 *
 * ```
 * denominator = sum of the weights of the ACTIVE dimensions   // 1000 animated, 920 still
 * totalQ     = Math.floor((sum(w_i * scoreQ_i) + denominator / 2) / denominator)
 * score      = unitScore(totalQ)                             // the only float in the pipeline
 * ```
 *
 * The denominator is the sum of what actually contributed, so a still sprite is scored as
 * a still sprite: five dimensions at 880 report 0.88, not 0.81. The remaining weights are
 * deliberately *not* renormalised onto 1000, because renormalising at runtime makes the
 * total depend on the active set in a way that is hard to diff and hard to explain in a CI
 * log.
 *
 * **The verdict is computed from the same `totalQ` that was serialised, and that pairing
 * is deliberate rather than incidental.** `reportInvariantViolations` explicitly does not
 * re-derive the integer from the float, and `verdictFor` takes `totalQ` rather than
 * `score`, so nothing downstream can quietly ask the aggregator to make its float agree
 * with its own integer. A validator that re-derived the integer by multiplying the wire
 * value by 1000 would reintroduce exactly the float arithmetic the per-mille discipline
 * exists to prevent, and would then cry wolf on a legitimately rounded value. So this file
 * holds the integer, hands the same integer to both consumers, and the float exists only
 * on the way out through `unitScore`.
 *
 * ## Why the aggregator throws on a malformed report
 *
 * {@link assertReportInvariants} is called before returning, and it throws. At this step a
 * malformed report is a bug in *this file* — a weight that does not sum, an id in both maps,
 * a hand-rolled verdict — and not bad artwork, which is what `QualityReport.verdict` is
 * for. A quality gate that refused to finalise a sprite because its own report was
 * internally inconsistent would be indistinguishable from the product saying the art was
 * bad. The command boundary (T-019) wraps the throw in a `CommandError` with a code.
 */

/* ------------------------------------------------------------------ *
 * Applicability
 * ------------------------------------------------------------------ */

/**
 * How close the ink may get to a canvas edge before the document stops having a subject.
 *
 * **One pixel, and the unit is a pixel on purpose.** This is the one number in the file
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
 */
export const SUBJECT_REQUIRED_MARGIN = 1;

/** Per-frame ink facts the aggregator needs, and the only reason it reads a mask itself. */
interface FrameInk {
  /** `N` in §3.3: the solid pixel count on this frame. */
  readonly solid: number;
  /**
   * The largest distance from the ink to any of the four canvas edges, in pixels.
   *
   * A *distance*, not a bounding box, on purpose: `silhouette` has a private
   * `solidBounds`, §3.3 says no dimension may define a second version of a named quantity,
   * and this file is not a dimension. It is also not that quantity — the question here is
   * "how much transparent frame is there at all", not "where is the ink", and answering it
   * without a rectangle is what keeps the two from drifting into the same function.
   *
   * {@link FrameInk.solid} comes from `buildSolidMask` so that `ALPHA_SOLID` has exactly
   * one home; the scan that follows is four integer comparisons per solid pixel.
   */
  readonly edgeGap: number;
}

/** One solid mask and one edge-gap pass per frame, in playback order. */
function frameInk(context: QualityContext, index: number): FrameInk {
  const { width, height } = context;
  const { mask, solid } = buildSolidMask(context.composite[index], width, height);
  if (solid === 0) {
    // A sentinel, and only ever read behind a `solid > 0` test: with no ink there is no
    // distance to a canvas edge, and reporting it as maximally distant keeps the "all four
    // margins are one pixel" arithmetic below from having to know that case exists.
    return { solid, edgeGap: width + height };
  }
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
  return {
    solid,
    edgeGap: Math.max(minX, minY, width - 1 - maxX, height - 1 - maxY),
  };
}

/** The ink facts for the whole evaluated sequence, in playback order. */
function frameInks(context: QualityContext): FrameInk[] {
  const out: FrameInk[] = [];
  for (let i = 0; i < context.composite.length; i++) out.push(frameInk(context, i));
  return out;
}

/**
 * Whether any inked frame leaves transparent frame somewhere, i.e. has a subject.
 *
 * **Unanimity in the other direction is the rule:** one frame with a subject is enough for
 * the dimension to apply, and it takes *every* inked frame being full-bleed to exclude it.
 * `silhouette` scores the worst measured frame, so once any frame has a shape, the shape is
 * the document's business — and excluding on a majority would let a two-frame sheet lose
 * its one readable frame to an empty one.
 *
 * A frame with no ink is not full-bleed and cannot make a document full-bleed: there is
 * nothing running off the edge, and an all-empty target is `empty-frame`'s to report (see
 * {@link requiresReadableSubject}), not an applicability question.
 */
export function hasReadableSubject(context: QualityContext): boolean {
  return frameInks(context).some((ink) => ink.solid > 0 && ink.edgeGap > SUBJECT_REQUIRED_MARGIN);
}

/**
 * The `silhouette` precondition: a full-bleed document has no subject to read.
 *
 * Two branches, and the order is the point. An **empty** target returns `null` — the
 * dimension applies, runs, and finds nothing, which is the case §5.3's demonstration is
 * built on: every dimension reports 1000, `empty-frame` blocks at severity 1.00, and a
 * blank canvas fails for being *no* artwork rather than for scoring badly. Excluding the
 * dimensions instead would leave nothing to compute a total from and would report the
 * emptiness as a form problem, which it is not.
 *
 * A **full-bleed** target returns `'no-subject'`. `outline` registers the same
 * precondition when it lands (T-016) — a 1px contour traced around a frame edge is a
 * contour of the frame, not of anything — and `value`, `palette` and `noise` do not, which
 * is the whole reason applicability is per dimension.
 */
export function requiresReadableSubject(context: QualityContext): ExcludedReason | null {
  const inks = frameInks(context);
  const inked = inks.filter((ink) => ink.solid > 0);
  if (inked.length === 0) return null;
  return inked.every((ink) => ink.edgeGap <= SUBJECT_REQUIRED_MARGIN) ? 'no-subject' : null;
}

/**
 * Whether every composite in a sequence is byte-identical to the first, §4.6's detection.
 *
 * Exact equality across the whole `Uint8ClampedArray`, because "the frames are the same
 * image" has no tolerant reading: one alpha byte of difference is a different frame and
 * makes the sequence measurable. Exported because the exclusion and the advisory come from
 * this one test, and because a calibration harness asking "is this an animation?" wants the
 * answer without re-deriving it.
 */
export function compositesAreIdentical(composite: readonly QualityCel[]): boolean {
  if (composite.length < 2) return true;
  const first = composite[0].data;
  const length = first.length;
  for (let i = 1; i < composite.length; i++) {
    const data = composite[i].data;
    if (data.length !== length) return false;
    for (let p = 0; p < length; p++) {
      if (data[p] !== first[p]) return false;
    }
  }
  return true;
}

/**
 * The `motion` precondition, owned here rather than by the analyzer.
 *
 * §4.6's two reasons, unchanged: a one-frame sequence cannot be measured for motion, and
 * neither can a sequence whose composites are all the same image.
 *
 * **The exclusion has to be the aggregator's call, and this is why.** Measured honestly, an
 * identical sequence is a *perfect* animation: churn is 0 on every transition, the seam is
 * 0, and `seamRatio` is `0 / max(1, 0)`. An analyzer asked to score it would return its
 * best possible band — `scoreQ: 1000` — for a sprite that does not move. That is the
 * fake-perfect-score trap, and no analyzer can avoid it from the inside, because the
 * information that the input is degenerate is exactly the information its own measurement
 * is blind to. So the decision is made here, before the analyzer is called, and the
 * aggregator does not run the analyzer at all.
 *
 * It ships ahead of the analyzer it guards: T-017 adds `motionAnalyzer` to
 * {@link DEFAULT_DIMENSIONS} and this function becomes its precondition, unchanged. Until
 * then the dimension has no registration, so `evaluate` records `'not-implemented'` for it
 * — a stronger and more truthful statement than "this sprite has no motion to measure",
 * which would imply there was a measurement to have made.
 */
export function motionApplicability(context: QualityContext): ExcludedReason | null {
  // `< 2` rather than `=== 1` so the empty case lands here too: `evaluate` rejects a
  // context with no frames outright, and a caller reaching this function directly gets a
  // defensible answer rather than a fall-through.
  if (context.frameIds.length < 2) return 'single-frame';
  if (compositesAreIdentical(context.composite)) return 'no-motion-content';
  return null;
}

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

/**
 * One dimension, and the precondition under which it can measure anything.
 *
 * A registration is what a new dimension adds in T-013…T-017: one line here and one file.
 * It is the whole reason applicability is not a table inside `evaluate` — the aggregator
 * has no list of dimension ids in its body, so a dimension that declares itself cannot be
 * half-registered the way a dimension in a hand-maintained table can.
 *
 * `applies` returns the reason the dimension is excluded, or `null` for "measure it". The
 * inverted sense of "applicable" is deliberate: `null` is the normal answer, and a
 * precondition that has to return something to say *yes* is a precondition that is easy to
 * write backwards. A precondition must be pure, deterministic and cheap — it runs before
 * the analyzer and its whole job is to avoid work.
 */
export interface QualityDimensionRegistration {
  readonly id: QualityDimensionId;
  /**
   * The analyzer. Required: a dimension with no analyzer is not a dimension, and the
   * aggregator reports the absence as `'not-implemented'` rather than inventing a
   * registration for it.
   */
  readonly analyze: QualityAnalyzer;
  /** Omitted means "always applicable", which is right for a dimension with no degenerate input. */
  readonly applies?: (context: QualityContext) => ExcludedReason | null;
}

/**
 * Every dimension that has an analyzer today.
 *
 * **One entry, on purpose.** The registry is partial until T-013…T-017 land, and the
 * aggregator is written for the partial case rather than for the finished one: the
 * denominator is the sum of the weights of whatever is *present*, so with only
 * `silhouette` registered the total is that dimension's score over a denominator of 300,
 * and the other five appear in `excluded` as `'not-implemented'`. Writing the aggregation
 * against the finished six and testing it against one would have meant the only code path
 * that ever runs in this repository was never executed.
 *
 * Each new dimension is one line, plus a `guide` in the spec:
 * `palette` (T-014), `noise` (T-015), `outline` (T-016, with
 * {@link requiresReadableSubject}), `motion` (T-017, with {@link motionApplicability}).
 */
export const DEFAULT_DIMENSIONS: readonly QualityDimensionRegistration[] = [
  { id: 'silhouette', analyze: silhouetteAnalyzer, applies: requiresReadableSubject },
];

/**
 * The default analyzers as bare callables, derived rather than listed.
 *
 * For a caller that only wants to run dimensions — a calibration harness diffing one
 * dimension across a corpus, say. It is a projection of {@link DEFAULT_DIMENSIONS} so the
 * two cannot drift, and it is **not** what `evaluate` takes: a bare
 * `(context) => QualityDimension` cannot carry a precondition, and inferring applicability
 * for a list of anonymous callables is how the full-bleed bug comes back.
 */
export const DEFAULT_ANALYZERS: readonly QualityAnalyzer[] = DEFAULT_DIMENSIONS.map(
  (dimension) => dimension.analyze,
);

/** The registered analyzer for one dimension id, or `undefined` when it has none yet. */
export function analyzerFor(
  id: QualityDimensionId,
  dimensions: readonly QualityDimensionRegistration[] = DEFAULT_DIMENSIONS,
): QualityAnalyzer | undefined {
  return indexRegistrations(dimensions).get(id)?.analyze;
}

/**
 * Index by id, rejecting duplicates.
 *
 * Two registrations for one id is a silent averaging bug rather than a crash if it is
 * allowed through: `evaluate` would measure the dimension once per registration and the
 * report would be a number nobody chose. So this throws, like `createRegistry` does for a
 * duplicate command name — the same failure, in the same place in the product.
 */
function indexRegistrations(
  dimensions: readonly QualityDimensionRegistration[],
): Map<QualityDimensionId, QualityDimensionRegistration> {
  const byId = new Map<QualityDimensionId, QualityDimensionRegistration>();
  for (const dimension of dimensions) {
    if (byId.has(dimension.id)) throw new Error(`Duplicate quality dimension: ${dimension.id}`);
    byId.set(dimension.id, dimension);
  }
  return byId;
}

/* ------------------------------------------------------------------ *
 * The aggregation
 * ------------------------------------------------------------------ */

/**
 * Measure a target and return one report.
 *
 * Order of work, and each step exists for a reason:
 *
 *   1. A context with no frames is a caller bug, not artwork. `createQualityContext` throws
 *      on a frame the document does not have for the same reason, and narrowing an empty
 *      sequence into "nothing to measure, everything is fine" is the one failure the whole
 *      applicability mechanism exists to make impossible.
 *   2. Applicability, per dimension, in {@link QUALITY_DIMENSIONS} order — so the key order
 *      of both `dimensions` and `excluded` is a property of the contract rather than of a
 *      hash table, which is what makes a committed report diffable.
 *   3. The weighted total over the active set.
 *   4. The blocking list, from present dimensions plus the aggregator's own issues.
 *   5. The verdict, from the same integer that is about to be serialised.
 *   6. The invariant check, which throws.
 */
export function evaluate(
  context: QualityContext,
  dimensions: readonly QualityDimensionRegistration[] = DEFAULT_DIMENSIONS,
): QualityReport {
  if (context.frameIds.length === 0) {
    throw new Error('Cannot evaluate a quality context with no frames: there is no target to measure.');
  }
  const byId = indexRegistrations(dimensions);

  const measured: Partial<Record<QualityDimensionId, QualityDimension>> = {};
  const excluded: Partial<Record<QualityDimensionId, ExcludedReason>> = {};
  for (const id of QUALITY_DIMENSIONS) {
    const registration = byId.get(id);
    if (registration === undefined) {
      // No analyzer: no number, and none claimed. This is the branch that keeps the
      // "every id is accounted for exactly once" invariant true while five of the six
      // dimensions do not exist.
      excluded[id] = 'not-implemented';
      continue;
    }
    const reason = registration.applies?.(context) ?? null;
    if (reason !== null) {
      excluded[id] = reason;
      continue;
    }
    measured[id] = registration.analyze(context);
  }

  const totalQ = weightedTotalQ(measured);
  const blocking = collectBlocking(measured, aggregatorIssues(context));
  const report: QualityReport = {
    dimensions: measured,
    excluded,
    score: unitScore(totalQ),
    // The *integer* that produced `score` one line up, never the float. See the file header.
    verdict: verdictFor({ totalQ, dimensions: measured, blocking }),
    blocking,
  };
  assertReportInvariants(report);
  return report;
}

/**
 * §5.2, exactly: the denominator is the sum of the weights that contributed, round-half-up.
 *
 * `DEFAULT_QUALITY_WEIGHTS` is the only table consulted, and `STATIC_QUALITY_WEIGHTS` is
 * not a second code path: it is a *description* of the still case, where `motion`'s weight
 * is 0 because the active sum already omits a dimension that has no key. Reading the
 * weights from a table chosen by frame count would mean two sources of truth for one
 * denominator, and they would agree only until a dimension gained a second reason to be
 * excluded.
 *
 * **An empty active set totals 0, which is `fail`.** A target with no measurable dimension
 * — today, a full-bleed scene, because `value`/`palette`/`noise` do not exist yet — has no
 * evidence of quality at all, and 0 says "nothing was measured" in the only way a required
 * number can. The alternative, 1000, is the fake-perfect score: it would tell an agent that
 * a scene nobody could measure is perfect, which is the same confidently-wrong failure this
 * file was written to stop, pointing the other way. It fails *closed*, which is what
 * `isBelow` already does with a malformed score, and the reason travels in `excluded`, so a
 * reader sees "0.00, nothing measured" rather than "0.00, bad art". Whether a gate should
 * refuse such a document is T-024's call, not this file's.
 */
function weightedTotalQ(dimensions: QualityReport['dimensions']): number {
  let sum = 0;
  let denominator = 0;
  for (const id of QUALITY_DIMENSIONS) {
    const dimension = dimensions[id];
    if (dimension === undefined) continue;
    const weight = DEFAULT_QUALITY_WEIGHTS[id];
    sum += weight * dimension.scoreQ;
    denominator += weight;
  }
  if (denominator === 0) return 0;
  return Math.floor((sum + denominator / 2) / denominator);
}

/**
 * The aggregator's own issues: `empty-frame` and `frames-identical`, §5.4.
 *
 * Both describe the *target* rather than any one dimension's opinion of it, which is why
 * neither belongs to a dimension. Only the blocking ones reach `report.blocking`; this is
 * exported as well so a caller that renders advice can show the advisories too, because
 * `QualityReport` has no field for a non-blocking aggregator issue (§3.6's shape is
 * `dimensions` / `excluded` / `score` / `verdict` / `blocking`, and nothing else). That gap
 * is real and is left visible rather than papered over with a field the contract does not
 * have: `frames-identical` says something the `excluded` reason does not, namely that four
 * copies of frame zero is *probably* a mistake rather than a deliberate hold.
 */
export function aggregatorIssues(context: QualityContext): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const empty: number[] = [];
  const inks = frameInks(context);
  for (let i = 0; i < inks.length; i++) {
    if (inks[i].solid === 0) empty.push(i);
  }
  if (empty.length > 0) {
    issues.push({
      code: 'empty-frame',
      message:
        empty.length === inks.length
          ? `nothing opaque to measure: all ${inks.length} frames are empty, so no dimension can score this document.`
          : `nothing opaque to measure in ${empty.length} of ${inks.length} frames (frame ${empty.join(', ')}); a blank frame exports as a hole in the sheet.`,
      rect: null,
      severity: 1,
    });
  }
  // The advisory that ships with the exclusion, not instead of it (§4.6). Excluded says
  // "this cannot be measured"; this says "you probably meant to animate it". The two are
  // emitted from the same test and it is the advisory that has to be non-blocking, because
  // a deliberate hold is indistinguishable from a bug.
  if (context.frameIds.length >= 2 && compositesAreIdentical(context.composite)) {
    issues.push({
      code: 'frames-identical',
      message: `all ${context.frameIds.length} frames are byte-identical; if you meant to animate this, frame 1 was never drawn, and if you did not, the hold is fine.`,
      rect: null,
      severity: 0.35,
    });
  }
  return issues;
}

/**
 * The blocking list: present dimensions plus the aggregator, deduplicated, ordered.
 *
 * Four rules, all from §5.3 and `VerdictInput`, and all here rather than in a caller so that
 * two of them cannot be spelled two ways:
 *
 *   - **Present dimensions only.** An excluded dimension has no issues because it was never
 *     measured, and this is where the ten full-bleed scenes stop reporting a blocking
 *     `shape-clipped`: the issue is not filtered out, the dimension that invented it is
 *     never run.
 *   - **Deduplicated by `(code, rect)`.** Two dimensions can legitimately name the same
 *     defect in the same place, and a gate that refuses a document should say it once.
 *   - **Severity descending, then code ascending.** Both keys are stated, because an
 *     incidental sort order is a baseline diff (§3.2 rule 4). The rect is the third key,
 *     which the spec leaves unspecified: it makes the order independent of the order the
 *     dimensions happened to be visited in, so the same report serialises the same way
 *     whatever is registered.
 *   - **One filter, {@link isBlocking}, shared with `verdictFor`.** The aggregator that
 *     assembles this list and the verdict that consumes it must never disagree about which
 *     defects are the blocking ones; `verdictFor` re-checks with the same predicate rather
 *     than trusting the list it was handed.
 */
function collectBlocking(
  dimensions: QualityReport['dimensions'],
  own: readonly QualityIssue[],
): QualityIssue[] {
  const seen = new Set<string>();
  const out: QualityIssue[] = [];
  const add = (issue: QualityIssue): void => {
    if (!isBlocking(issue)) return;
    const key = issueKey(issue);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(issue);
  };
  for (const id of QUALITY_DIMENSIONS) {
    const dimension = dimensions[id];
    if (dimension === undefined) continue;
    for (const issue of dimension.issues) add(issue);
  }
  for (const issue of own) add(issue);
  return out.sort(
    (a, b) =>
      b.severity - a.severity ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
      (rectKey(a) < rectKey(b) ? -1 : rectKey(a) > rectKey(b) ? 1 : 0),
  );
}

/** `(code, rect)` as one string, so deduplication is a `Set` rather than a nested search. */
function issueKey(issue: QualityIssue): string {
  return `${issue.code}|${rectKey(issue)}`;
}

/** Rects are objects; their identity says nothing, so the key is the geometry. */
function rectKey(issue: QualityIssue): string {
  const rect = issue.rect;
  return rect === null ? 'global' : `${rect.x},${rect.y},${rect.w},${rect.h}`;
}

export * from './context.js';
export * from './silhouette.js';
export * from './types.js';
