import { buildSolidMask, silhouetteAnalyzer } from './silhouette.js';
import { valueAnalyzer } from './value.js';
import { paletteAnalyzer } from './palette.js';
import { noiseAnalyzer } from './noise.js';
import { outlineAnalyzer, outlineApplicability } from './outline.js';
import { motionAnalyzer } from './motion.js';
import { edgeGapOf, SUBJECT_REQUIRED_MARGIN } from './measure.js';
import {
  assertReportInvariants,
  DEFAULT_QUALITY_WEIGHTS,
  isBlocking,
  QUALITY_ASSET_CLASSES,
  QUALITY_DIMENSIONS,
  QUALITY_WEIGHT_PROFILES,
  SCENE_AREA_THRESHOLD,
  unitScore,
  verdictFor,
  type ExcludedReason,
  type QualityAnalyzer,
  type QualityAssetClass,
  type QualityAssetClassRecord,
  type QualityCel,
  type QualityContext,
  type QualityDimension,
  type QualityDimensionId,
  type QualityIssue,
  type QualityReport,
  type QualityWeights,
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
 *
 * It lives in `measure.ts` beside {@link edgeGapOf} and is re-exported here, because §4.2's
 * curvature gate asks the same question and `value.ts` cannot import from a module that imports
 * it. A second copy of this number would be a second thing to keep right, and the whole argument
 * above is about what happens when one place and another disagree by a pixel.
 */
export { SUBJECT_REQUIRED_MARGIN } from './measure.js';

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
   * one home; the scan that follows is four integer comparisons per solid pixel, and it now
   * lives in `measure.ts` as {@link edgeGapOf} because §4.2's curvature gate asks the same
   * question of a single frame and a second copy of this loop is a second thing to keep right.
   */
  readonly edgeGap: number;
}

/** One solid mask and one edge-gap pass per frame, in playback order. */
function frameInk(context: QualityContext, index: number): FrameInk {
  const { width, height } = context;
  const { mask, solid } = buildSolidMask(context.composite[index], width, height);
  return { solid, edgeGap: edgeGapOf(mask, width, height) };
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
 * contour of the frame, not of anything — and `palette` and `noise` do not, which is
 * the whole reason applicability is per dimension.
 *
 * `value` registers **no** precondition and is the interesting case, so the reason it
 * shares is not that it is excluded. A full-bleed scene is built out of value planes and
 * `value` measures its tone half there. What it cannot do is judge §4.2's form term, whose
 * curvature gate reads local curvature off an outline the document does not have — so the
 * dimension stays present, contributes what it measured, and declares
 * `unmeasured: { form: 'no-subject' }` itself. See `value.ts` and §4.2.
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
 * It shipped ahead of the analyzer it guards, and `motionAnalyzer` is now registered against it
 * unchanged, so this function is the precondition `evaluate` consults before the analyzer runs.
 */
export function motionApplicability(context: QualityContext): ExcludedReason | null {
  // `< 2` rather than `=== 1` so the empty case lands here too: `evaluate` rejects a
  // context with no frames outright, and a caller reaching this function directly gets a
  // defensible answer rather than a fall-through.
  if (context.frameIds.length < 2) return 'single-frame';
  if (compositesAreIdentical(context.composite)) return 'no-motion-content';
  return null;
}

/**
 * `outline`'s precondition: §3.3's `no-subject` first, then §4.5's `no-outline`.
 *
 * The composition lives here rather than being written out at the registration, because it is
 * needed in two more places — `benchmarks/corpus/report.ts`'s `PRECONDITIONS` table and the
 * outline dimension's own tests — and three copies of a precedence rule are three chances to
 * disagree. If the registration ever drops the composition, the corpus table stops agreeing
 * with the pipeline and every full-bleed row goes red, which is the check worth having.
 */
export function outlinePrecondition(context: QualityContext): ExcludedReason | null {
  // Order is load-bearing. A full-bleed document has no shape to read a contour AROUND, and
  // `no-subject` is a stronger and different claim than `no-outline` — grading a scene's framing
  // as a stylistic decision is exactly the T-099 mistake this repository has already made once.
  return requiresReadableSubject(context) ?? outlineApplicability(context);
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
 * **Four entries, and the aggregator is written for the partial case rather than the finished
 * one.** The registry is partial until T-016 and T-017 land: the denominator is the sum of the
 * weights of whatever is *present*, so with only `silhouette` registered the total is that
 * dimension's score over a denominator of 300, and the other five appear in `excluded` as
 * `'not-implemented'`. Writing the aggregation against the finished six and testing it against
 * four would have meant the only paths that ever run in this repository were never executed.
 * **The order of the array is `QUALITY_DIMENSIONS` order, which is `DEFAULT_QUALITY_WEIGHTS`
 * order** (silhouette 300, value 260, palette 140, noise 120, outline 100, motion 80), and it
 * has to be: `evaluate` iterates `QUALITY_DIMENSIONS` and looks each id up here, so the array
 * is a lookup rather than a sequence — but a reader scanning it for "how much is this worth"
 * should get §5.1's answer without opening `types.ts`.
 *
 * **Of the five, two abstain.** `value`, `palette` and `noise` register with no `applies` at all,
 * and that is a finding rather than an omission — each of them asks a question a full-bleed
 * landscape answers perfectly well, and §3.6's `excluded` map exists so the question ("is there a
 * shape to read?") does not get answered for them by a predicate written for a different
 * dimension. `outline` is the other side of the same coin: it registers *with*
 * {@link requiresReadableSubject}, which §3.3's `no-subject` member already named it for. See the
 * per-registration comments below for the argument in each case.
 *
 * The sixth dimension is `motion`, registered last, with {@link motionApplicability} — the only
 * precondition in this file that guards against a *perfect* measurement rather than a wrong one.
 *
 * **`value` registers with no `applies` at all**, and that is a decision rather than an omission.
 * {@link requiresReadableSubject} is the one precondition in this file and it exists because a
 * full-bleed scene has no subject to read a *shape* out of — its alpha boundary is the frame, so
 * `borderTouch` is 4 and the measurement reads as a defect. `value` asks a different question and
 * a full-bleed scene answers it perfectly well: a landscape *is* built from value planes, a
 * horizon is a plane, and a mountain lit from the upper left has a terminator that either follows
 * its ridge or cuts across it. The reason §4.2 lists no precondition is therefore load-bearing
 * and not an oversight, and the ten full-bleed scenes in `artwork/` are the evidence: they are
 * exactly the documents this dimension has something to say about.
 */
export const DEFAULT_DIMENSIONS: readonly QualityDimensionRegistration[] = [
  { id: 'silhouette', analyze: silhouetteAnalyzer, applies: requiresReadableSubject },
  { id: 'value', analyze: valueAnalyzer },
  // `palette` registers with no `applies`, and the reason is §3.6's rather than §4.1's: a full-bleed
  // landscape is exactly the document where an off-palette colour is most likely, because it was
  // made of thousands of individual marks and each of them could have picked an arbitrary hex.
  // Abstaining there would exempt the ten committed scenes — the ones with the most colours in them
  // — from the only dimension that counts colours.
  //
  // **This registration moves `artwork/verify/lantern-keeper.pixel` from 849 to 824, and the direction
  // is the finding.** Registering `noise` moved the same row *away* from its one real advisory
  // (823 -> 849) because `noise` read 970 and had nothing to say about a character's profile;
  // `palette` reads 700 and does have something to say (19 colours against a `compact` budget of 16,
  // and 8 hue families), so the mean moves *toward* the advisory by 25 per-mille:
  //
  //     (300*800 + 260*850 + 120*970 + 140*700) / 820 = 675400 / 820 = 823.7 -> 824
  //
  // Both signs are the same mechanism — a weight-140 or weight-120 dimension outvoting the
  // weight-300 one that owns the defect — and neither is repaired here, because §5.3's floors
  // (`FLOOR_FAIL.silhouette` is 400 against a score of 800) do not catch either. §7 records it.
  { id: 'palette', analyze: paletteAnalyzer },
  // `noise` registers with no `applies`, for §4.2's reason and not §4.1's: a full-bleed landscape has
  // no subject to read a shape out of, but it is exactly the document where a snapping fill or a
  // leaked pixel is most likely, because it is made of thousands of individual marks.
  { id: 'noise', analyze: noiseAnalyzer },
  // `outline` registers with BOTH preconditions, and the order is load-bearing. `requiresReadableSubject`
  // first: a full-bleed document has no shape to read a contour AROUND, and `no-subject` is a stronger and
  // different claim than `no-outline` — grading a scene's framing as a stylistic decision is the T-099
  // mistake. `outlineApplicability` second: §4.5's "no outline is a legitimate style, scored neutral, not
  // bad" is now TRUE rather than aspirational, because a document that declares no contour is EXCLUDED
  // with a reason instead of scored 700 with a code.
  { id: 'outline', analyze: outlineAnalyzer, applies: outlinePrecondition },
  // REGISTERED, carrying a known limitation that is recorded rather than hidden. The owner chose to
  // ship this dimension rather than hold it for an open research question, so two negative controls
  // now carry the advisories this predicate produces on a two-tone subject. Both severities are
  // below §5.3's 0.50 blocking line, so neither refuses a document — the cost is two warnings on
  // declared-clean work, which is a weaker harm than a fifth dimension that does not exist.
  //
  // The four cases that read this way, measured 2026-10-03:
  //   control/clean-figure-20  [outline-gap, outline-inconsistent-weight]  share 327  scoreQ 350
  //   control/clean-union-16   [outline-gap, outline-inconsistent-weight]  share 416  scoreQ 500
  //   connectivity/background-diagonal-leak-9  [outline-gap]  share 294
  //   value/level-set-32       [outline-gap]  share 862
  //
  // Both controls are TWO-TONE SUBJECTS WITH NO DRAWN CONTOUR (`inkColours` is 1 on both): the outer
  // edge of a dark half of the body satisfies the local-contrast predicate by 48 `Lq`, so the dark
  // half IS the contour as far as `ink` is concerned. `encloses` cannot save it — that gate
  // separated a cast shadow from a contour because the shadow sat on one side of a LIGHTER body,
  // and here the dark pixels ARE the subject, so there is nothing to be on one side of.
  // 
  // No threshold separates them, measured: `control/outline-ring-32` (a real closed 1px contour)
  // reads `outlineShare 1000` and the controls read 327 and 416 — the same side of every band
  // edge — and the spread that fires is 2 on both controls against 0 on the ring, so a
  // discriminator there would have to run the WRONG WAY. §4.5 records a per-tone boundary-share
  // candidate that does separate, by 97 per-mille with nothing in the corpus designed to sit in
  // between: that is a guess, and it would rescue exactly two rows while adding a new §3.3
  // quantity that four of six measured subjects do not need. Not shipped.
  // 
  // The corpus is ARMED, not blind: 76 cases now declare `expect.preconditions.outline` and
  // `baseline.md` carries the column, so the next person to register this meets those 6 failures
  // immediately instead of discovering them by eye.
  //
  // `motion` is the last of the six, and it is the only one whose exclusion the aggregator had to own
  // from the start: `motionApplicability` was written and exported before the analyzer existed,
  // because a motion analyzer asked to score an identical sequence would hand back its BEST band —
  // churn 0, seam 0, `seamRatio` 0/max(1,0) — for a sprite that does not move. So the precondition is
  // `motionApplicability` unchanged, and it runs before the analyzer rather than inside it.
  { id: 'motion', analyze: motionAnalyzer, applies: motionApplicability },
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
 * §5.2 per-asset-class weight profiles
 * ------------------------------------------------------------------ */

/**
 * Which profile's weights a document is scored under, when the caller does not say.
 *
 * Two rules, in this order, and the order is the decision.
 *
 *   1. **Motion-bearing → `animation`.** §7 item 8 names the walk cycle as the case the single
 *      table cannot serve, and the aggregator can *tell* that case apart from a still icon of
 *      identical canvas size: a 32² four-frame walk and a 32² single-frame icon are the same
 *      area and are not the same animal, which is why §4.3's area-only split is not enough on
 *      its own. So the derived rule asks `motionApplicability`, which is already the one
 *      predicate that answers "is there motion here, honestly" — including the identical-frame
 *      case, which must *not* promote a hold to an animation.
 *   2. **Otherwise area > {@link SCENE_AREA_THRESHOLD} → `scene`.** A 256² landscape has no
 *      subject to read a silhouette out of, and is carried by value planes and colour
 *      discipline instead.
 *
 * **`animation` is checked first and that is the arguable choice.** An animated 256² background
 * is classified `animation` rather than `scene`. The reason is that the two questions are not
 * peers: motion applicability is a fact about *this evaluation*, while area is a property of
 * the canvas, and a weight profile that changed because a caller passed `frames: [0]` instead
 * of the whole loop would be a total that moves when nothing about the artwork changed. A still
 * 256² canvas has no motion to weigh, so it falls through to rule 2 and is scored as a scene.
 *
 * **Two rules, three classes, and nothing else.** §7 item 8 names four asset kinds. `icon` and
 * `tile` are both still subjects on a small canvas and both resolve to `sprite`, so no fourth
 * table is invented for a distinction nothing here can measure — a new class is a new set of
 * numbers with zero evidence behind it, and §6.2 has never been run once to justify even the
 * two that exist.
 *
 * Deterministic and cheap: two predicates the aggregator already runs for applicability, plus
 * one integer multiply. No clock, no randomness, nothing whose order can reach output.
 */
export function deriveAssetClass(context: QualityContext): QualityAssetClass {
  if (motionApplicability(context) === null) return 'animation';
  if (context.width * context.height > SCENE_AREA_THRESHOLD) return 'scene';
  return 'sprite';
}

/**
 * The class to score under, and whether anybody said so.
 *
 * **Both derived and overridable, and the override wins — that is the decision.** A derived
 * class is convenient and needs no concept at the call site, but it is silently wrong in one
 * case that is not hypothetical: a caller measuring one frame of a walk cycle (`frames: [0]`)
 * gets a still sequence, so the honest derived answer is `sprite`, while the caller knows the
 * asset is an animation. An explicit class is honest and puts a burden on every caller — which
 * is why it is optional, and why `source` is recorded on the report so "the caller was right"
 * and "the aggregator was right" are both checkable after the fact.
 *
 * An unknown class is rejected rather than rounded: `defineCommand`'s zod enum handles the
 * command boundary, and this function is the same check for the programmatic callers.
 */
export function resolveAssetClass(
  context: QualityContext,
  explicit?: QualityAssetClass | undefined,
): QualityAssetClassRecord {
  if (explicit !== undefined) {
    if (!QUALITY_ASSET_CLASSES.includes(explicit)) {
      throw new Error(
        `Unknown asset class '${explicit}'. Known classes: ${QUALITY_ASSET_CLASSES.join(', ')}.`,
      );
    }
    return { cls: explicit, source: 'explicit' };
  }
  return { cls: deriveAssetClass(context), source: 'derived' };
}

/**
 * The weights for one class. `sprite` is §5.1's table, so "nothing specified" reproduces every
 * number this pipeline produced before profiles existed.
 */
export function weightsFor(cls: QualityAssetClass): QualityWeights {
  return QUALITY_WEIGHT_PROFILES[cls].weights;
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
  options: { readonly assetClass?: QualityAssetClass | undefined } = {},
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

  const assetClass = resolveAssetClass(context, options.assetClass);
  const totalQ = weightedTotalQ(measured, weightsFor(assetClass.cls));
  const blocking = collectBlocking(measured, aggregatorIssues(context));
  const report: QualityReport = {
    dimensions: measured,
    excluded,
    score: unitScore(totalQ),
    // Which profile produced the total above, so a reader can tell a re-weighting from a change
    // in the artwork. See `QualityReport.assetClass` and `deriveAssetClass`.
    assetClass,
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
 * `weights` defaults to `DEFAULT_QUALITY_WEIGHTS` and that default **is** the `sprite`
 * profile, so every pre-profile caller — including `weightedTotalQ(report.dimensions)` in the
 * gate, and every test in this package that calls it with one argument — gets byte-identical
 * arithmetic. The parameter is there so the aggregator can pass the profile it actually used;
 * a caller that re-derives the total from a report should pass `weightsFor(report.assetClass.cls)`,
 * and the gate in `commands/quality.ts` does.
 *
 * `STATIC_QUALITY_WEIGHTS` is not a second code path: it is a *description* of the still case,
 * where `motion`'s weight is 0 because the active sum already omits a dimension that has no
 * key. Reading the weights from a table chosen by frame count would mean two sources of truth
 * for one denominator, and they would agree only until a dimension gained a second reason to be
 * excluded.
 *
 * **An empty active set totals 0, which is `fail`.** A target with no measurable dimension
 * — a full-bleed scene, whose `silhouette` and `outline` are both excluded — has no
 * evidence of quality at all, and 0 says "nothing was measured" in the only way a required
 * number can. The alternative, 1000, is the fake-perfect score: it would tell an agent that
 * a scene nobody could measure is perfect, which is the same confidently-wrong failure this
 * file was written to stop, pointing the other way. It fails *closed*, which is what
 * `isBelow` already does with a malformed score, and the reason travels in `excluded`, so a
 * reader sees "0.00, nothing measured" rather than "0.00, bad art". Whether a gate should
 * refuse such a document is T-024's call, not this file's.
 */
export function weightedTotalQ(
  dimensions: QualityReport['dimensions'],
  weights: QualityWeights = DEFAULT_QUALITY_WEIGHTS,
): number {
  let sum = 0;
  let denominator = 0;
  for (const id of QUALITY_DIMENSIONS) {
    const dimension = dimensions[id];
    if (dimension === undefined) continue;
    const weight = weights[id];
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
export * from './projections.js';
export * from './silhouette.js';
export * from './types.js';
export * from './value.js';
export * from './palette.js';
export * from './noise.js';
export * from './outline.js';
export * from './motion.js';
