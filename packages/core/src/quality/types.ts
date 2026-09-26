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
 *   - **Normalised.** Every score is 0..1 and higher is always better, so dimensions
 *     can be weighted against one another without per-dimension fudge factors.
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
  /** 0..1, higher is better. Run it through {@link clamp01} on the way out. */
  readonly score: number;
  /** One sentence: what this dimension thinks of the artwork. */
  readonly verdict: string;
  /** Actionable problems; empty means nothing here needs doing. */
  readonly issues: readonly QualityIssue[];
}

/** The whole assessment: six dimensions, one weighted score, one gate decision. */
export interface QualityReport {
  /**
   * One entry per {@link QualityDimensionId}.
   *
   * `Record`, not `Partial<Record<...>>`: a report that is missing a dimension is a
   * report whose score silently omits it, and the caller cannot tell "scored 0" from
   * "never ran". A dimension with nothing to measure is reported as neutral with a
   * `verdict` that says so, not omitted.
   */
  readonly dimensions: Readonly<Record<QualityDimensionId, QualityDimension>>;
  /** Weighted mean of the dimension scores, 0..1. */
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

/** Weighted score at or above which a report is 'pass'. */
export const SCORE_PASS_THRESHOLD = 0.8;

/** Weighted score at or above which a report is 'warn'; below this it is 'fail'. */
export const SCORE_WARN_THRESHOLD = 0.5;

/**
 * The one place pass/warn/fail is decided.
 *
 * A blocking issue short-circuits to 'fail' regardless of score, and that is the whole
 * point of the severity scale: a report can average 0.9 while the silhouette is
 * unreadable, and no amount of good value structure makes that deliverable. Returning
 * 'warn' for a blocking issue instead would leave the gate (T-024) with nothing to
 * enforce, which is the failure mode this function exists to prevent.
 *
 * The thresholds are the *published* contract: they are what 'pass' means to a user,
 * so changing them changes every baseline and every saved verdict, not just behaviour.
 * `score` is clamped rather than trusted, so a bad aggregate fails closed.
 */
export function verdictFor(score: number, hasBlocking: boolean): QualityReport['verdict'] {
  if (hasBlocking) return 'fail';
  const value = clamp01(score);
  if (value >= SCORE_PASS_THRESHOLD) return 'pass';
  if (value >= SCORE_WARN_THRESHOLD) return 'warn';
  return 'fail';
}

/**
 * Clamp to the 0..1 band every score lives in, and the *only* clamping rule in the
 * quality pipeline.
 *
 * Defined once because six analyzers that each clamp slightly differently produce
 * scores that look comparable and are not — and because the report is compared
 * against committed baselines, so the edge cases are load-bearing, not pedantry:
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
 */
export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value === 0 ? 0 : value;
}

/**
 * How much each dimension counts toward {@link QualityReport.score}.
 *
 * Weights are *relative*, not percentages: the aggregator divides by the sum of the
 * weights that actually applied, so dropping a dimension to 0 removes it from the mean
 * instead of redistributing its share to the others by accident. That is what makes
 * {@link STATIC_QUALITY_WEIGHTS} safe.
 *
 * The defaults sum to 1.0 for an animation. Re-tuning them moves every committed
 * baseline, so it is a product decision, not a code cleanup.
 */
export type QualityWeights = Readonly<Record<QualityDimensionId, number>>;

/**
 * Default weighting: silhouette 0.30, value 0.25, noise 0.15, palette 0.12,
 * outline 0.10, motion 0.08.
 *
 * Silhouette outranks everything because it is the one defect a viewer cannot look
 * past — if the shape does not read at a glance nothing else is being looked at. Value
 * structure is second because it carries form when the palette cannot: most "the
 * colours are wrong" complaints are a value problem in disguise. Noise sits above the
 * two craft dimensions because a stray pixel has no artistic reading at 100% zoom,
 * while a loose outline or an over-wide palette usually reads as style. Motion is last
 * because it only exists when frames do, and the still sprite is the common case.
 */
export const DEFAULT_QUALITY_WEIGHTS: QualityWeights = {
  silhouette: 0.3,
  value: 0.25,
  palette: 0.12,
  noise: 0.15,
  outline: 0.1,
  motion: 0.08,
};

/**
 * The default weights with `motion` removed, for a document with a single frame.
 *
 * A still sprite must not be penalised for motion, and it must not be given a fake
 * perfect motion score either: the `dimensions` record requires the key (see
 * {@link QualityReport}), so the motion analyzer reports a neutral score with a
 * `verdict` that says it had nothing to measure, and this weight set keeps that
 * placeholder out of the mean. The remaining five sum to 0.92 and re-normalise to 1.
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
   * Every dimension must return a score for every context, including this degenerate
   * one. A dimension with nothing to measure says so in its `verdict`; it does not
   * return 0, which would be indistinguishable from "measured, and it is bad".
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
 * Contract: pure, deterministic, no writes, and it must return a score for every
 * context it is handed rather than throwing on a degenerate one. An analyzer that
 * cannot measure something says so in its `verdict` and contributes no issues.
 */
export type QualityAnalyzer = (context: QualityContext) => QualityDimension;

/**
 * Compile-time guard: every dimension id is registered in all three places a dimension
 * has to be named — {@link QUALITY_DIMENSIONS}, {@link DEFAULT_QUALITY_WEIGHTS} and
 * {@link STATIC_QUALITY_WEIGHTS}.
 *
 * Written as a *constrained* alias, not a `declare const`. A `declare const x: T` is a
 * legal declaration for any `T`, so it resolves the check and then raises nothing —
 * the guard is only as strong as its most recent reader's patience. A type argument
 * that does not satisfy `T extends true` is an error at the alias itself, which is
 * checked whether or not anything consumes the alias, so this one fires.
 *
 * The weight direction looks redundant against the `QualityWeights` annotation on the
 * two objects above, and partly is: that annotation is a real constraint and it does
 * catch a missing key. It does not catch a *new* key added to `QUALITY_DIMENSIONS` and
 * forgotten in the weights while the union still matches, and it says nothing about
 * which of the three sources is at fault. This check covers all three in one place and
 * names the guilty source in the error.
 *
 * The other two directions are covered without a guard, and deliberately so:
 * `QUALITY_DIMENSIONS` carries `satisfies readonly QualityDimensionId[]`, so it can
 * never list an id the union does not have, and the two weight objects are annotated
 * `QualityWeights`, so neither can be missing one. This alias is the one gap those two
 * leave: a dimension that exists in the union and the weights but never in the list,
 * which the aggregator would iterate straight past without a word.
 */
type AssertTrue<T extends true> = T;

/** Key set of each source a dimension id has to appear in. */
type DimensionKeySets = {
  QUALITY_DIMENSIONS: (typeof QUALITY_DIMENSIONS)[number];
  DEFAULT_QUALITY_WEIGHTS: keyof typeof DEFAULT_QUALITY_WEIGHTS;
  STATIC_QUALITY_WEIGHTS: keyof typeof STATIC_QUALITY_WEIGHTS;
};

/**
 * One `{ missingFrom }` marker per incomplete source, or `never` when all three are
 * complete. The tuple brackets keep `extends [never]` a plain non-distributive
 * comparison, so completeness is decided by the test and not by union reduction.
 */
type Unregistered = {
  [Source in keyof DimensionKeySets]: [Exclude<QualityDimensionId, DimensionKeySets[Source]>] extends [never]
    ? never
    : { missingFrom: Source };
}[keyof DimensionKeySets];

type _EveryDimensionIsRegistered = AssertTrue<[Unregistered] extends [never] ? true : Unregistered>;
