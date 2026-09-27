/**
 * The benchmark corpus format.
 *
 * ## Why a spec and not a folder of PNGs
 *
 * The corpus is ~60 cases, and a folder of PNGs would be a few megabytes of binary diff on
 * every change to the engine, reviewable by nobody and impossible to merge. The engine is
 * byte-reproducible (T-071) and `.pixel` serialisation is byte-reproducible (T-091), so every
 * case can be **materialised deterministically at test time** from a declarative description,
 * and the description is a few thousand lines of diffable text. A binary fixture that could be
 * regenerated is the wrong artefact: it makes a change to a threshold look like a change to a
 * picture.
 *
 * The consequence the format has to live up to: the thing under version control must carry the
 * *intent* (this case exists to make `thin-profile` fire, here is the shape, here is the
 * measurement I expect) rather than the bytes.
 *
 * ## Three tiers, and why the boundary between them is in the type system
 *
 * `docs/EVALUATION.md` §6.1 is unambiguous: "Algorithmic data cannot calibrate an algorithm.
 * If the benchmark corpus were labelled by a model, by a script, or by `evaluate` itself, then
 * measuring the correlation between `evaluate`'s scores and those labels would measure
 * *self-consistency*, not validity." Fitting thresholds to synthetic labels makes the
 * correlation climb toward 1.0 while the scorer gets no better.
 *
 * So the corpus is three tiers, and each answers a different question:
 *
 *   - **`synthetic`** — a subject generated with a *declared* defect. Ground truth by
 *     construction: we put the dither there, so we know which dimension it was meant to
 *     degrade. These are **regression guards with expected values**, not measurements. They
 *     answer "does the analyzer detect the defect it was designed to detect, and does it stay
 *     quiet when the defect is absent". A human rating cannot answer that question at all.
 *   - **`real`** — the repository's own committed artwork. Real and **unlabelled**. These answer
 *     "does the analyzer stay quiet on good work it was not designed around", which is the
 *     question T-012 actually got wrong.
 *   - **`human`** — the tier T-026 fills. Empty on arrival, and the format's job is to make
 *     filling it a matter of writing a file rather than designing a mechanism later.
 *
 * The boundary is structural rather than a comment, in two ways that a loader enforces:
 *
 *   1. A `synthetic` case **must** carry `expect`, and every defect it declares **must** appear
 *      in the codes it expects. A case that declares a defect the analyzer never reports is a
 *      broken case, not a passing one.
 *   2. A `real` case **may not** carry `expect.codes` or `expect.verdict`. Asserting an expected
 *      code list about real artwork is asserting taste, and this repository has exactly one
 *      human-rated asset in it — asserting taste against a sample of one is fitting noise, which
 *      is the mistake two tasks in a row have declined to make. `real` cases may assert
 *      applicability facts and may record measurements as a **drift baseline**, because
 *      "the analyzer still says what it said" is a real guard even though "the analyzer is
 *      right" is not a claim this repository is entitled to make.
 *   3. A `human` case has **no `expect` field on its type at all**, and the loader rejects the
 *      key. The runner's result for such a case is a discriminated `{ status: 'awaiting-rating' }`,
 *      which has no `ok` field to be false. There is no code path in which a human-tier case is
 *      compared against an expectation, because there is nothing to compare it to yet.
 *
 * ## Determinism
 *
 * No `Math.random`, no `Date.now`, no `Math.hypot`, no `Math.pow` on exact squares. Ids come
 * from `deterministicIdFactory` seeded from the case id, so the same corpus produces the same
 * documents and therefore the same `.pixel` bytes — which is what makes "a score moved" mean
 * "the analyzer moved" rather than "the fixture moved".
 */

/* ------------------------------------------------------------------ *
 * Cases
 * ------------------------------------------------------------------ */

/**
 * Who provides the label.
 *
 * `synthetic` is labelled by construction, `real` by nobody, `human` by a person. The three are
 * not "confidence levels": a synthetic label is *certain about the defect and silent about
 * taste*, and a human label is the reverse. Keeping them as separate members is the whole point.
 */
export type CorpusTier = 'synthetic' | 'real' | 'human';

/** Where the pixels come from. Orthogonal to {@link CorpusTier}: a human can rate generated art. */
export type CorpusProvenance = 'generated' | 'repo-artwork' | 'repo-png';

/**
 * The defects a case injects, as a closed set.
 *
 * Closed, and the members are exactly the issue codes `evaluate` can emit from the dimension
 * that exists today plus the aggregator's two — `docs/EVALUATION.md` Appendix A. Adding a
 * dimension adds codes here, and the loader's rule "a declared defect must be an expected code"
 * then means every new code has to be exercised by a case that says it means something.
 *
 * `clean-control` is the one member that is not a defect. It is required on any case that
 * injects nothing, and it is what makes "an analyzer that fires on clean work is worse than one
 * that misses a defect" a checkable property rather than an aspiration: a control case is
 * required to declare `expect.absent`, so a quiet analyzer and a noisy one produce different
 * results.
 */
export type DefectKind =
  | 'clean-control'
  | 'detached-pieces'
  | 'interior-hole'
  | 'thin-profile'
  | 'shape-clipped'
  | 'subject-undersized'
  | 'fragmented-silhouette'
  | 'empty-frame'
  | 'frames-identical';

/** One injected defect and why it is there. The note is the reviewer's context, not the assertion. */
export interface CorpusDefect {
  readonly kind: DefectKind;
  readonly note: string;
}

/**
 * The §3.3 / §4.1 quantities a case pins, by name.
 *
 * Per frame, in playback order, so a two-frame case writes two values. §6.2 is explicit that the
 * protocol must "record the measured numbers, not just the verdict" and that "a pair that
 * separates by 0.02 is passing the test and still wrong, and the size of the gap is the thing
 * worth reviewing" — so the corpus carries numbers, and the names are exactly
 * `SilhouetteFrame`'s fields, which are already the pipeline's declared measurement record.
 *
 * Only quantities whose expected value is derivable from the *specification* and the declared
 * geometry are listed. A quantity nobody can derive is still **recorded** in the generated
 * report; it is simply not asserted, because an expectation copied out of the implementation's
 * own output is the circular evaluation §6.1 is about.
 */
export type MeasuredQuantity =
  | 'N'
  | 'partialAlpha'
  | 'components'
  | 'largest'
  | 'shareQ'
  | 'strayCount'
  | 'strayPixels'
  | 'strayQ'
  | 'borderTouch'
  | 'perimeter'
  | 'holeCount'
  | 'holeArea'
  | 'spanQ'
  | 'convexCorners'
  | 'compactnessQ'
  | 'scoreQ';

/** The two connectivity counts, pinned in both directions by one declaration. */
export interface ConnectivityExpectation {
  /** Components under 4-connectivity — what §3.3 fixes for the subject. */
  readonly four: number;
  /** Components under 8-connectivity — what the background is counted with. */
  readonly eight: number;
}

/** What a case asserts. Only ever present on a `synthetic` or a `real` case; see the file header. */
export interface CorpusExpectation {
  /**
   * Every issue code the report must carry: the present dimensions' issues plus the
   * aggregator's own, deduplicated and sorted. Compared **exactly**, because a subset test
   * would let an analyzer grow a new false positive silently — which is the failure this whole
   * corpus exists to catch.
   */
  readonly codes?: readonly string[];
  /** Codes that must not appear. The load-bearing half of a negative control. */
  readonly absent?: readonly string[];
  /**
   * The report verdict. Asserted on a handful of cases only, and deliberately: the total is a
   * weighted mean over whichever dimensions are registered, so until all six land, asserting a
   * verdict on every case would make every case fail on every dimension landing. The cases
   * where the verdict is the *point* — a clean control, an excluded full-bleed scene, a
   * blocking defect — assert it, and everything else records it.
   */
  readonly verdict?: 'pass' | 'warn' | 'fail';
  /** `true` asserts the report's blocking list is empty. This is the quiet-on-good-work guard. */
  readonly noBlocking?: boolean;
  /**
   * The aggregator's applicability predicates, called directly.
   *
   * Asserted here rather than through `report.excluded` because `motion` has no analyzer yet,
   * so `evaluate` reports `'not-implemented'` for it today and the real reason travels nowhere.
   * The predicates are the aggregator's own exported functions, they are the thing `evaluate`
   * consults, and they are the contract; the `'not-implemented'` bookkeeping is a fact about
   * which dimensions have landed. `null` means "applicable".
   */
  readonly preconditions?: Readonly<Record<string, ExcludedReason | null>>;
  /** §3.3/§4.1 quantities, per frame. */
  readonly measure?: Readonly<Partial<Record<MeasuredQuantity, readonly number[]>>>;
  /** Component counts under both connectivities. See {@link ConnectivityExpectation}. */
  readonly connectivity?: ConnectivityExpectation;
}

/* ------------------------------------------------------------------ *
 * Recipes
 * ------------------------------------------------------------------ */

/** A colour: a hex string, `"pal:N"`, or an RGBA object. Whatever the drawing commands accept. */
export type RecipeColor = string | number | readonly [number, number, number] | Readonly<{ r: number; g: number; b: number; a?: number }>;

/** `[x, y]`. A pair rather than an object, because these lists are long and a reviewer reads the numbers. */
export type Point2 = readonly [number, number];

/** `[x, y, w, h]`. `w`/`h` are counts, per AD-3. */
export type Rect4 = readonly [number, number, number, number];

/** `[left, right, y]` — one row of a silhouette, in the shape `demo.ts` builds its whole sprite from. */
export type Row3 = readonly [number, number, number];

/**
 * One drawing instruction, and the bus command it becomes.
 *
 * The vocabulary is deliberately tiny and every member maps to exactly one command, so a recipe
 * reads as a list of edits an artist would recognise and a reviewer can check against
 * `docs/REFERENCE.md`. The alternative — a generic `{command, params}` escape hatch — is what
 * `scripts/npm-index.ts` and the MCP layer already offer, and it is exactly the escape hatch
 * that lets a corpus drift into using a command the drawing guide would not.
 *
 * `rows` deserves its own member because a silhouette *is* a row table: `demo.ts` derives its
 * entire tonal stack from one `[left, right, y]` list, and a corpus case that draws its subject
 * as a list of filled rows is reviewable in the same way.
 */
export type RecipeOp =
  | { readonly op: 'rect'; readonly layer: string; readonly frame?: number; readonly rect: Rect4; readonly color: RecipeColor; readonly fill?: boolean }
  | { readonly op: 'ellipse'; readonly layer: string; readonly frame?: number; readonly rect: Rect4; readonly color: RecipeColor; readonly fill?: boolean }
  | { readonly op: 'polygon'; readonly layer: string; readonly frame?: number; readonly points: readonly Point2[]; readonly color: RecipeColor }
  | { readonly op: 'polyline'; readonly layer: string; readonly frame?: number; readonly points: readonly Point2[]; readonly color: RecipeColor; readonly width?: number }
  | { readonly op: 'line'; readonly layer: string; readonly frame?: number; readonly from: Point2; readonly to: Point2; readonly color: RecipeColor; readonly width?: number }
  /** One filled `draw_rect` per row, so a row table is exact rather than polygon-sampled. */
  | { readonly op: 'rows'; readonly layer: string; readonly frame?: number; readonly rows: readonly Row3[]; readonly color: RecipeColor }
  | { readonly op: 'pixels'; readonly layer: string; readonly frame?: number; readonly points: readonly Point2[]; readonly color: RecipeColor }
  /**
   * Punch a transparent region. `draw_rect` with a null colour, which is the product's own way
   * of cutting a hole — and cutting a hole is how a corpus injects `interior-hole` without
   * having to draw a shape with a hole in it.
   */
  | { readonly op: 'erase'; readonly layer: string; readonly frame?: number; readonly rect: Rect4 }
  | { readonly op: 'outline'; readonly layer: string; readonly frame?: number; readonly color: RecipeColor; readonly scope?: 'cel' | 'composite'; readonly mode?: 'outside' | 'inside' | 'both' }
  | { readonly op: 'clear'; readonly layer: string; readonly frame?: number }
  /** `duplicate_frame`, so an animation is two lines rather than a frame-by-frame rewrite. */
  | { readonly op: 'duplicateFrame'; readonly frame?: number; readonly count?: number }
  | { readonly op: 'translate'; readonly layer: string; readonly frame: number; readonly dx: number; readonly dy: number }
  | { readonly op: 'tag'; readonly name: string; readonly from: number; readonly to: number; readonly direction?: 'forward' | 'reverse' | 'pingpong'; readonly repeat?: number }
  /** `quantize_to_palette` with `dither: 'none'`: the proof that every colour is a swatch. */
  | { readonly op: 'quantize' };

/** A sprite, described rather than stored. */
export interface Recipe {
  readonly canvas: { readonly w: number; readonly h: number };
  /** Layer names, bottom first, exactly as `createSprite` takes them. */
  readonly layers?: readonly string[];
  readonly frames?: number;
  /** The whole palette, in index order. Replaces rather than extends, so a case is self-contained. */
  readonly palette: readonly RecipeColor[];
  readonly ops: readonly RecipeOp[];
}

/* ------------------------------------------------------------------ *
 * The three case shapes
 * ------------------------------------------------------------------ */

/** A generated subject with a declared defect. Ground truth by construction. */
export interface SyntheticCase {
  readonly id: string;
  readonly label: string;
  readonly tier: 'synthetic';
  readonly provenance: 'generated';
  /** What was injected. `[{ kind: 'clean-control' }]` for a negative control. */
  readonly defects: readonly CorpusDefect[];
  readonly recipe: Recipe;
  readonly expect: CorpusExpectation;
  /**
   * The §6.2 contrast-pair group this case belongs to, if any.
   *
   * A matched pair differing in exactly one property is the cheapest regression test this system
   * has and the only one that catches a mis-targeted measurement, so the grouping is data rather
   * than a naming convention: the report can then compute the *size of the gap* between members,
   * which §6.2 says is the thing worth reviewing ("a pair that separates by 0.02 is passing the
   * test and still wrong").
   */
  readonly pair?: string;
}

/** A committed asset, unlabelled. Asserts applicability and quietness; never taste. */
export interface RealCase {
  readonly id: string;
  readonly label: string;
  readonly tier: 'real';
  readonly provenance: 'repo-artwork' | 'repo-png';
  /** Path from the repository root. */
  readonly source: string;
  /** Applicability facts, a quietness assertion, and optionally a drift baseline of measurements. */
  readonly expect: CorpusExpectation;
}

/**
 * An image awaiting a human label.
 *
 * **There is no `expect` field, and that is the mechanism.** Not "no `expect` in practice" and
 * not "`expect` is ignored for this tier": the property does not exist on the type, the loader
 * rejects the key, and the runner's result for such a case is a different member that has no
 * field to compare. §6.1's circularity is not a rule this corpus follows by convention.
 */
export interface HumanCase {
  readonly id: string;
  readonly label: string;
  readonly tier: 'human';
  readonly provenance: CorpusProvenance;
  /** A generated subject to rate, or a path to a committed asset. Exactly one. */
  readonly recipe?: Recipe;
  readonly source?: string;
  /** What the human is being asked to judge, so a rater is never guessing. */
  readonly prompt: string;
}

export type CorpusCase = SyntheticCase | RealCase | HumanCase;

export interface CorpusSpec {
  /** Bumped when the format changes shape. The generated report prints it. */
  readonly version: number;
  /** One line per case, in report order. */
  readonly description: string;
  readonly cases: readonly CorpusCase[];
}

/* ------------------------------------------------------------------ *
 * The human-rating slot
 * ------------------------------------------------------------------ */

/**
 * One dimension's score from one rater, on §4's 1-5 scale.
 *
 * The keys are §4's six subsections, not the six dimension ids, because a human reads "does the
 * shape read" and not "silhouette". `docs/EVALUATION.md` §4 carries the normative anchors for
 * each value and §4.1 says they are normative: `4` means what §4 says `4` means.
 */
export type HumanScores = Readonly<Record<'silhouette' | 'value' | 'palette' | 'noise' | 'outline' | 'motion', number>>;

/** The three-way judgement §6.3 asks for, and the only number T-025 needs. */
export type HumanOverall = 'usable' | 'needs-work' | 'unusable';

export interface HumanRating {
  /**
   * At least two, rated independently; `consensus` is only filled in once two agree.
   *
   * T-026's protocol: "at least two raters with real pixel-art experience, rating
   * independently… disagreements go to a third round of arbitration". The corpus format carries
   * the number of raters and the agreement, because a file that stored one score per image would
   * make the protocol impossible to audit after the fact.
   */
  readonly raters: readonly {
    readonly rater: string;
    readonly perDimension: HumanScores;
    readonly overall: HumanOverall;
    /** A note the rater attached, e.g. "the hole is a deliberate keyhole". §4.1 settles such cases by note. */
    readonly note?: string;
  }[];
  /** Present only where two raters agreed. Absent means "unresolved", which is a real state. */
  readonly consensus?: { readonly perDimension: HumanScores; readonly overall: HumanOverall };
}

/**
 * The file T-026 fills. Empty on arrival and that is the correct state: an empty
 * `ratings` object is the honest answer to "has a human rated this yet".
 *
 * Keyed by **case id**, so a rating cannot be attached to a picture nobody can find, and a case
 * that is regenerated from its spec is rated by identity rather than by filename.
 */
export interface CorpusScores {
  readonly schema: 'dotloom-corpus-scores/v1';
  /** The `CorpusSpec.version` these ratings were made against. A mismatch invalidates them. */
  readonly corpusVersion: number;
  readonly ratings: Readonly<Record<string, HumanRating>>;
}

/* ------------------------------------------------------------------ *
 * The gates, transcribed from the specification
 * ------------------------------------------------------------------ */

/**
 * The §4 thresholds this corpus measures against, copied out of `docs/EVALUATION.md` §4.1.
 *
 * **Transcribed, not imported, and that is deliberate.** `silhouette.ts` hard-codes `300` in the
 * middle of a band table rather than exporting it, so importing it would make the corpus's gate
 * and the implementation's gate the same value by construction and the drift guard below
 * vacuous. A copy is a check; a reference is not. `quality-corpus.test.ts` proves the two agree by
 * finding the subject that straddles the boundary and checking which side of it `thin-profile`
 * falls on — the discriminating case, not the passing one.
 *
 * Nothing in this file may change these numbers. §6.2's standing rule is that a new threshold is a
 * hypothesis until it has been run against a designed contrast, and the standing decision in this
 * repository is that a threshold is a product decision. T-022 owns moving one; T-021 produces the
 * distribution a move would be based on.
 */
export const SPEC_GATES: Readonly<{ compactnessQ: number; share: number; strayRatio: number; holeArea: number; borderTouch: number; span: number }> = {
  /** §4.1: `compactnessQ < 300` -> `thin-profile`. The gate that penalises the only real character sprite. */
  compactnessQ: 300,
  /** §4.1's band table: the top band starts at `largest * 100 >= 98 * N`. */
  share: 98,
  /** §4.1: `strayRatio > 2/100` -> `detached-pieces`. */
  strayRatio: 2,
  /** §4.1: `holeRatio > 1/100` -> `interior-hole`, and any hole of area <= 3 regardless. */
  holeArea: 1,
  /** §4.1: `borderTouch >= 3` -> `shape-clipped`, blocking. */
  borderTouch: 3,
  /** §3.7: `span < 0.25` -> `subject-undersized`. */
  span: 25,
};

/* ------------------------------------------------------------------ *
 * §3.3 quantities that have no implementation yet
 * ------------------------------------------------------------------ */

/**
 * The measurement record for a §3.3 name that exists in the specification and not in the code.
 *
 * Written down because §3.3 is self-contradictory about one of them and the next dimension to
 * need it will otherwise have to re-derive the answer from the same argument. This is the shape
 * `countConvexCorners`' doc comment takes, generalised: a claim about a specification belongs
 * next to the data, not in a comment the next revision will not trip over.
 */
export interface QuantityDeclaration {
  readonly name: string;
  /** `'implemented'` when the pipeline measures it today. */
  readonly status: 'implemented' | 'unimplemented';
  /** What this repository uses, when it is implemented. */
  readonly adopted?: string;
  /** What §3.3 says, where it says more than one thing. */
  readonly specText: string;
  /** Which consumer needs it, so the unresolved entries have an owner. */
  readonly neededBy: readonly string[];
  /**
   * A shape on which two candidate definitions of this quantity give different answers, spelled
   * out so the test is written from the record rather than from the argument a second time.
   */
  readonly discriminator?: string;
  /**
   * The two answers, as `[label, value]` pairs, for the shape named above. Measured by the
   * corpus test from two small local reference implementations of the *specification's* wording —
   * not from the pipeline, which does not implement either reading.
   */
  readonly discriminatorValues?: readonly (readonly [string, number])[];
}

/**
 * Every §3.3 name the pipeline touches or defers, and the one place its status is written.
 *
 * The implemented entries are the ones `measure.ts` re-exports, plus the two §4.1 refinements
 * (`perimeter` as a transition count, holes as background-8/holes-4) which are decisions about
 * *how* a name is counted rather than new names. The two unimplemented entries are the real
 * findings: `dist`/`Dmax` is defined twice incompatibly, and §3.3's `convexCorner` is measured
 * and measured to be 0 on every convex shape in the pipeline, which makes §4.2's curvature gate
 * inert in both directions.
 */
export const DECLARED_QUANTITIES: readonly QuantityDeclaration[] = [
  {
    name: 'N',
    status: 'implemented',
    specText: 'Solid pixels (alpha >= ALPHA_SOLID).',
    neededBy: ['silhouette', 'value', 'noise', 'outline', 'motion'],
  },
  {
    name: 'components',
    status: 'implemented',
    adopted: '4-connectivity for the subject; 8-connectivity for the background, holes 4-connected.',
    specText: 'Connected components of the solid mask under 4-connectivity.',
    neededBy: ['silhouette', 'noise'],
  },
  {
    name: 'edgePixels',
    status: 'implemented',
    adopted: 'A count of boundary pixels, never a length.',
    specText: 'Count of edgePixel pixels. A count of pixels, not a length.',
    neededBy: ['outline'],
  },
  {
    name: 'perimeter',
    status: 'implemented',
    adopted: 'Count of 4-adjacent (solid, transparent) pairs, with outside-the-canvas transparent.',
    specText: 'Count of 4-adjacent (solid, transparent) pixel pairs. A length.',
    neededBy: ['silhouette', 'value'],
  },
  {
    name: 'holes',
    status: 'implemented',
    adopted: 'Background counted with 8-connectivity, holes with 4-connectivity.',
    specText:
      '4-connected components of the transparent mask that do NOT touch the canvas border; the background is 8-connected so a diagonal leak is not a hole.',
    neededBy: ['silhouette'],
  },
  {
    name: 'dist / Dmax',
    status: 'unimplemented',
    // The prose wins over the table for the same reason the 4-connected subject wins over an
    // 8-connected one: everything else in §3.3 is 4-connected, and a Chebyshev `dist` over an
    // 8-connected neighbourhood would let `value`'s plane-depth normalisation disagree with
    // `noise`'s thin-sprite rule about where a boundary is. Stated here as the adopted reading,
    // not implemented, and the discriminator below is what the implementing dimension has to
    // reproduce.
    adopted: '4-connected multi-source BFS from every edgePixel, +1 per step (the prose).',
    specText:
      'Table: "the Chebyshev distance to the nearest non-solid pixel or to the canvas edge". Prose: "a multi-source BFS over the solid mask from every edgePixel, 4-connected, with +1 per step".',
    neededBy: ['value', 'outline', 'noise'],
    discriminator:
      'A 3x3 solid block with ONE corner pixel removed. The pixel diagonally opposite the removed corner has all four of its orthogonal neighbours solid and one transparent diagonal, so the only transparent pixels it can see are diagonal: L-infinity reaches them in one step and L1 needs two.',
    discriminatorValues: [
      ['Chebyshev (L-infinity, the table)', 1],
      ['4-connected BFS (L1, the prose)', 2],
    ],
  },
  {
    name: 'convexCorner',
    status: 'implemented',
    adopted: 'Measured as §3.3 defines it, which counts concave corners and so reads 0 on every convex shape.',
    specText:
      'p is solid, exactly 2 of its 4 orthogonal neighbours are solid, those 2 are adjacent, and the diagonal pixel between them is transparent. §4.2 then claims this is "the signature of a 45-degree staircase on a convex boundary".',
    neededBy: ['value'],
    discriminator:
      'A 32x32 filled disc, a 16x16 square, a 3px-wide diagonal band: all three measure 0, and a 45-degree chamfer on a block also measures 0. Only a one-pixel nick cut diagonally outside a corner measures 1.',
  },
];

/* ------------------------------------------------------------------ *
 * Loading and validating
 * ------------------------------------------------------------------ */

/** `ExcludedReason` duplicated rather than imported, so this file has no runtime dependency. */
export type ExcludedReason = 'single-frame' | 'no-motion-content' | 'no-subject' | 'not-implemented';

/** Raised by every problem the loader finds, with the JSON pointer that caused it. */
export class CorpusFormatError extends Error {
  constructor(
    readonly where: string,
    readonly problem: string,
  ) {
    super(`corpus: ${where}: ${problem}`);
    this.name = 'CorpusFormatError';
  }
}

const DEFECT_KINDS: readonly DefectKind[] = [
  'clean-control',
  'detached-pieces',
  'interior-hole',
  'thin-profile',
  'shape-clipped',
  'subject-undersized',
  'fragmented-silhouette',
  'empty-frame',
  'frames-identical',
];

const MEASURED_QUANTITIES: readonly MeasuredQuantity[] = [
  'N',
  'partialAlpha',
  'components',
  'largest',
  'shareQ',
  'strayCount',
  'strayPixels',
  'strayQ',
  'borderTouch',
  'perimeter',
  'holeCount',
  'holeArea',
  'spanQ',
  'convexCorners',
  'compactnessQ',
  'scoreQ',
];

const PRECONDITION_IDS: readonly string[] = ['silhouette', 'motion'];
const PRECONDITION_REASONS: readonly (ExcludedReason | null)[] = [
  null,
  'single-frame',
  'no-motion-content',
  'no-subject',
];

const RECIPE_OPS: readonly string[] = [
  'rect',
  'ellipse',
  'polygon',
  'polyline',
  'line',
  'rows',
  'pixels',
  'erase',
  'outline',
  'clear',
  'duplicateFrame',
  'translate',
  'tag',
  'quantize',
];

/** A recipe op is a closed record, so an unknown key is a typo rather than a silent no-op. */
const OP_KEYS: Readonly<Record<string, readonly string[]>> = {
  rect: ['layer', 'frame', 'rect', 'color', 'fill'],
  ellipse: ['layer', 'frame', 'rect', 'color', 'fill'],
  polygon: ['layer', 'frame', 'points', 'color'],
  polyline: ['layer', 'frame', 'points', 'color', 'width'],
  line: ['layer', 'frame', 'from', 'to', 'color', 'width'],
  rows: ['layer', 'frame', 'rows', 'color'],
  pixels: ['layer', 'frame', 'points', 'color'],
  erase: ['layer', 'frame', 'rect'],
  outline: ['layer', 'frame', 'color', 'scope', 'mode'],
  clear: ['layer', 'frame'],
  duplicateFrame: ['frame', 'count'],
  translate: ['layer', 'frame', 'dx', 'dy'],
  tag: ['name', 'from', 'to', 'direction', 'repeat'],
  quantize: [],
};

const EXPECT_KEYS: readonly string[] = [
  'codes',
  'absent',
  'verdict',
  'noBlocking',
  'preconditions',
  'measure',
  'connectivity',
];

const CASE_KEYS: Readonly<Record<string, readonly string[]>> = {
  synthetic: ['id', 'label', 'tier', 'provenance', 'defects', 'recipe', 'expect', 'pair'],
  real: ['id', 'label', 'tier', 'provenance', 'source', 'expect'],
  human: ['id', 'label', 'tier', 'provenance', 'recipe', 'source', 'prompt'],
};

function fail(where: string, problem: string): never {
  throw new CorpusFormatError(where, problem);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reject any key the format does not name.
 *
 * The whole point of a declarative format is that a typo is visible. A corpus that silently
 * ignores `"expectd"` would go green with no expectations at all, which is the failure mode this
 * task most risks: a report that prints a table nobody compares.
 */
function checkKeys(where: string, value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(where, `unknown key "${key}" (allowed: ${allowed.join(', ') || 'none'})`);
  }
}

function requireString(where: string, value: Record<string, unknown>, key: string): string {
  const found = value[key];
  if (typeof found !== 'string' || found.length === 0) fail(where, `"${key}" must be a non-empty string`);
  return found;
}

function requireStringArray(where: string, value: Record<string, unknown>, key: string): string[] {
  const found = value[key];
  if (!Array.isArray(found)) fail(where, `"${key}" must be an array of strings`);
  for (const entry of found) {
    if (typeof entry !== 'string' || entry.length === 0) fail(where, `"${key}" must hold non-empty strings`);
  }
  return found as string[];
}

function requireInt(where: string, value: Record<string, unknown>, key: string): number {
  const found = value[key];
  if (typeof found !== 'number' || !Number.isInteger(found)) fail(where, `"${key}" must be an integer`);
  return found;
}

function requirePoint(where: string, value: unknown): void {
  if (!Array.isArray(value) || value.length !== 2 || value.some((n) => typeof n !== 'number' || !Number.isInteger(n))) {
    fail(where, 'a point must be [x, y] with two integers');
  }
}

function requireRect(where: string, value: unknown): void {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some((n) => typeof n !== 'number' || !Number.isInteger(n))
  ) {
    fail(where, 'a rect must be [x, y, w, h] with four integers');
  }
  const [, , w, h] = value as number[];
  if (w < 1 || h < 1) fail(where, `a rect's w and h are counts and must be >= 1 (got ${w}, ${h})`);
}

function validateRecipe(where: string, value: unknown): Recipe {
  if (!isRecord(value)) fail(where, 'recipe must be an object');
  checkKeys(where, value, ['canvas', 'layers', 'frames', 'palette', 'ops']);
  const canvas = value.canvas;
  if (!isRecord(canvas)) fail(where, 'recipe.canvas must be { w, h }');
  checkKeys(`${where}.canvas`, canvas, ['w', 'h']);
  const w = requireInt(`${where}.canvas`, canvas, 'w');
  const h = requireInt(`${where}.canvas`, canvas, 'h');
  if (w < 1 || h < 1) fail(`${where}.canvas`, `a canvas must be at least 1x1 (got ${w}x${h})`);
  if (value.layers !== undefined && !Array.isArray(value.layers)) fail(where, 'recipe.layers must be an array');
  if (value.frames !== undefined && (typeof value.frames !== 'number' || !Number.isInteger(value.frames) || value.frames < 1)) {
    fail(where, 'recipe.frames must be an integer >= 1');
  }
  if (!Array.isArray(value.palette) || value.palette.length === 0) {
    fail(where, 'recipe.palette must be a non-empty array; colours are named "pal:0" and upwards');
  }
  if (!Array.isArray(value.ops)) fail(where, 'recipe.ops must be an array');
  (value.ops as unknown[]).forEach((raw, index) => {
    const at = `${where}.ops[${index}]`;
    if (!isRecord(raw)) fail(at, 'an op must be an object');
    const op = raw.op;
    if (typeof op !== 'string' || !RECIPE_OPS.includes(op)) {
      fail(at, `unknown op ${JSON.stringify(op)} (available: ${RECIPE_OPS.join(', ')})`);
    }
    checkKeys(at, raw, ['op', ...(OP_KEYS[op] ?? [])]);
    if (op !== 'duplicateFrame' && op !== 'translate' && op !== 'tag' && op !== 'quantize') {
      requireString(at, raw, 'layer');
    }
    if (op === 'rect' || op === 'ellipse' || op === 'erase') requireRect(`${at}.rect`, raw.rect);
    if (op === 'polygon' || op === 'polyline' || op === 'pixels') {
      if (!Array.isArray(raw.points) || raw.points.length === 0) fail(at, `"${op}" needs a non-empty points array`);
      (raw.points as unknown[]).forEach((point) => requirePoint(at, point));
    }
    if (op === 'rows') {
      if (!Array.isArray(raw.rows) || raw.rows.length === 0) fail(at, 'rows needs a non-empty array');
      for (const row of raw.rows as unknown[]) {
        if (!Array.isArray(row) || row.length !== 3 || row.some((n) => typeof n !== 'number' || !Number.isInteger(n))) {
          fail(at, 'a row must be [left, right, y] with three integers');
        }
        if ((row as number[])[1] < (row as number[])[0]) fail(at, `row ${JSON.stringify(row)} has right < left`);
      }
    }
    if (op === 'line') {
      requirePoint(`${at}.from`, raw.from);
      requirePoint(`${at}.to`, raw.to);
    }
  });
  return value as unknown as Recipe;
}

function validateExpectation(where: string, raw: unknown): CorpusExpectation {
  if (!isRecord(raw)) fail(where, 'expect must be an object');
  checkKeys(where, raw, EXPECT_KEYS);
  if (raw.codes !== undefined) requireStringArray(where, raw, 'codes');
  if (raw.absent !== undefined) requireStringArray(where, raw, 'absent');
  if (raw.verdict !== undefined && !['pass', 'warn', 'fail'].includes(raw.verdict as string)) {
    fail(where, `"verdict" must be pass, warn or fail (got ${JSON.stringify(raw.verdict)})`);
  }
  if (raw.noBlocking !== undefined && typeof raw.noBlocking !== 'boolean') {
    fail(where, '"noBlocking" must be a boolean');
  }
  if (raw.preconditions !== undefined) {
    if (!isRecord(raw.preconditions)) fail(where, '"preconditions" must be an object keyed by dimension id');
    for (const [id, reason] of Object.entries(raw.preconditions)) {
      if (!PRECONDITION_IDS.includes(id)) {
        fail(where, `precondition "${id}" is not a dimension whose applicability this repository has implemented (${PRECONDITION_IDS.join(', ')})`);
      }
      if (!PRECONDITION_REASONS.includes(reason as ExcludedReason | null)) {
        fail(`${where}.preconditions.${id}`, `${JSON.stringify(reason)} is not an ExcludedReason or null`);
      }
    }
  }
  if (raw.measure !== undefined) {
    if (!isRecord(raw.measure)) fail(where, '"measure" must be an object keyed by quantity name');
    for (const [name, values] of Object.entries(raw.measure)) {
      if (!MEASURED_QUANTITIES.includes(name as MeasuredQuantity)) {
        fail(where, `"${name}" is not a measured quantity (available: ${MEASURED_QUANTITIES.join(', ')})`);
      }
      if (!Array.isArray(values) || values.length === 0) {
        fail(`${where}.measure.${name}`, 'a measurement is one integer per frame, in playback order');
      }
      for (const value of values) {
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          fail(`${where}.measure.${name}`, `expected integers, got ${JSON.stringify(value)}`);
        }
      }
    }
  }
  if (raw.connectivity !== undefined) {
    if (!isRecord(raw.connectivity)) fail(where, '"connectivity" must be { four, eight }');
    checkKeys(`${where}.connectivity`, raw.connectivity, ['four', 'eight']);
    const four = requireInt(`${where}.connectivity`, raw.connectivity, 'four');
    const eight = requireInt(`${where}.connectivity`, raw.connectivity, 'eight');
    if (four < 1 || eight < 1) fail(`${where}.connectivity`, 'component counts are >= 1 for a non-empty subject');
  }
  return raw as unknown as CorpusExpectation;
}

/**
 * Validate a parsed `cases.json`, throwing on anything the format does not allow.
 *
 * The tier rules are the point of this function, so they are enforced here rather than
 * documented for a reviewer to apply:
 *
 *   1. `synthetic` requires `expect`, requires a non-empty `defects`, and **every declared
 *      defect must appear in the expected codes**. That last rule is what makes the tier a
 *      ground truth rather than a label: a case cannot declare a defect and then not be
 *      expected to report it.
 *   2. A `clean-control` must declare `absent` naming at least one code. A negative control that
 *      says nothing about what must not fire is not a negative control.
 *   3. `real` may not declare `codes` or `verdict`. Those are taste, and this repository has
 *      one human-rated asset in it; asserting taste against that sample is the exact move two
 *      tasks have already declined to make. `measure` is allowed and means "drift baseline".
 *   4. `human` may not declare `expect` at all — the key does not exist on the type and is
 *      rejected here.
 *   5. Every case declares exactly one of `recipe` / `source`, matching its provenance.
 */
export function loadCorpusSpec(raw: unknown): CorpusSpec {
  if (!isRecord(raw)) fail('<root>', 'the corpus spec must be an object');
  checkKeys('<root>', raw, ['version', 'description', 'cases']);
  const version = requireInt('<root>', raw, 'version');
  requireString('<root>', raw, 'description');
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) fail('<root>', '"cases" must be a non-empty array');

  const seen = new Set<string>();
  const cases = (raw.cases as unknown[]).map((entry, index): CorpusCase => {
    const where = `cases[${index}]`;
    if (!isRecord(entry)) fail(where, 'a case must be an object');
    const tier = entry.tier;
    if (tier !== 'synthetic' && tier !== 'real' && tier !== 'human') {
      fail(where, `"tier" must be synthetic, real or human (got ${JSON.stringify(tier)})`);
    }
    const id = requireString(where, entry, 'id');
    if (seen.has(id)) fail(where, `duplicate case id "${id}"`);
    seen.add(id);
    if (!id.includes('/')) {
      fail(where, `"${id}" should be namespaced "<group>/<name>"; the group is what makes the report readable`);
    }
    const label = requireString(where, entry, 'label');
    checkKeys(where, entry, CASE_KEYS[tier]);

    if (tier === 'synthetic') {
      if (entry.provenance !== 'generated') fail(where, 'a synthetic case must be provenance "generated"');
      if (!Array.isArray(entry.defects) || entry.defects.length === 0) {
        fail(where, 'a synthetic case must declare at least one defect, including "clean-control" for one that injects nothing');
      }
      const defects: CorpusDefect[] = entry.defects.map((raw2, i) => {
        const at = `${where}.defects[${i}]`;
        if (!isRecord(raw2)) fail(at, 'a defect must be { kind, note }');
        checkKeys(at, raw2, ['kind', 'note']);
        const kind = requireString(at, raw2, 'kind');
        if (!DEFECT_KINDS.includes(kind as DefectKind)) {
          fail(at, `"${kind}" is not a defect kind (available: ${DEFECT_KINDS.join(', ')})`);
        }
        return { kind: kind as DefectKind, note: requireString(at, raw2, 'note') };
      });
      const expect = validateExpectation(`${where}.expect`, entry.expect);
      const expected = new Set(expect.codes ?? []);
      for (const defect of defects) {
        if (defect.kind === 'clean-control') continue;
        if (!expected.has(defect.kind)) {
          fail(where, `declares defect "${defect.kind}" but expect.codes does not contain it; a case that injects a defect the analyzer is not expected to report is a broken case, not a passing one`);
        }
      }
      if (defects.some((d) => d.kind === 'clean-control') && (expect.absent ?? []).length === 0) {
        fail(where, 'a clean control must declare expect.absent naming at least one code that must NOT fire');
      }
      const recipe = validateRecipe(`${where}.recipe`, entry.recipe);
      if (entry.pair !== undefined && typeof entry.pair !== 'string') {
        fail(where, '"pair" must be a group name shared with the case it is a matched pair against');
      }
      return {
        id,
        label,
        tier,
        provenance: 'generated',
        defects,
        recipe,
        expect,
        ...(entry.pair === undefined ? {} : { pair: entry.pair as string }),
      };
    }

    if (tier === 'real') {
      if (entry.provenance !== 'repo-artwork' && entry.provenance !== 'repo-png') {
        fail(where, 'a real case must be provenance "repo-artwork" or "repo-png"');
      }
      const source = requireString(where, entry, 'source');
      if (entry.recipe !== undefined) fail(where, 'a real case names a committed file; it does not carry a recipe');
      const expect = validateExpectation(`${where}.expect`, entry.expect);
      if (expect.codes !== undefined) {
        fail(where, 'a real case may not declare expect.codes: asserting an expected code list about unrated artwork is asserting taste, and the only human-rated asset in this repository is one sprite');
      }
      if (expect.verdict !== undefined) {
        fail(where, 'a real case may not declare expect.verdict, for the same reason: the gate decision on unrated art is a claim about taste that nothing in this repository can support');
      }
      return { id, label, tier, provenance: entry.provenance, source, expect };
    }

    if (entry.recipe !== undefined && entry.source !== undefined) {
      fail(where, 'a human case declares a recipe or a source, not both');
    }
    if (entry.recipe === undefined && entry.source === undefined) {
      fail(where, 'a human case needs something to rate: a recipe or a source');
    }
    const prompt = requireString(where, entry, 'prompt');
    const recipe = entry.recipe === undefined ? undefined : validateRecipe(`${where}.recipe`, entry.recipe);
    return {
      id,
      label,
      tier,
      provenance: (entry.provenance as CorpusProvenance) ?? (recipe === undefined ? 'repo-artwork' : 'generated'),
      ...(recipe === undefined ? { source: requireString(where, entry, 'source') } : { recipe }),
      prompt,
    };
  });

  return { version, description: requireString('<root>', raw, 'description'), cases };
}

/**
 * Validate `scores.json`, the file T-026 fills.
 *
 * Strict for the same reason the case loader is strict: a rating silently dropped by a
 * misspelled key would leave the corpus reporting coverage it does not have, and coverage is
 * the number T-025's accuracy report is built on.
 */
export function loadCorpusScores(raw: unknown, corpusVersion: number): CorpusScores {
  if (!isRecord(raw)) fail('scores', 'the ratings file must be an object');
  checkKeys('scores', raw, ['schema', 'corpusVersion', 'ratings']);
  const schema = requireString('scores', raw, 'schema');
  if (schema !== 'dotloom-corpus-scores/v1') {
    fail('scores', `unknown schema ${JSON.stringify(schema)}; this build understands dotloom-corpus-scores/v1`);
  }
  const version = requireInt('scores', raw, 'corpusVersion');
  if (version !== corpusVersion) {
    fail('scores', `rated against corpus version ${version}, but the corpus is version ${corpusVersion}; re-rate rather than carry a stale file forward`);
  }
  if (!isRecord(raw.ratings)) fail('scores.ratings', 'ratings must be an object keyed by case id');
  for (const [id, rating] of Object.entries(raw.ratings)) {
    const where = `scores.ratings["${id}"]`;
    if (!isRecord(rating)) fail(where, 'a rating must be an object');
    checkKeys(where, rating, ['raters', 'consensus']);
    if (!Array.isArray(rating.raters) || rating.raters.length < 2) {
      fail(where, 'T-026\'s protocol is two independent raters; a rating with fewer cannot claim a consensus');
    }
    rating.raters.forEach((rater, i) => {
      const at = `${where}.raters[${i}]`;
      if (!isRecord(rater)) fail(at, 'a rater must be { rater, perDimension, overall }');
      checkKeys(at, rater, ['rater', 'perDimension', 'overall', 'note']);
      requireString(at, rater, 'rater');
      if (!['usable', 'needs-work', 'unusable'].includes(rater.overall as string)) {
        fail(at, '"overall" must be usable, needs-work or unusable');
      }
      if (!isRecord(rater.perDimension)) fail(`${at}.perDimension`, 'perDimension must score all six dimensions');
      checkKeys(`${at}.perDimension`, rater.perDimension, [
        'silhouette',
        'value',
        'palette',
        'noise',
        'outline',
        'motion',
      ]);
      for (const [dimension, score] of Object.entries(rater.perDimension)) {
        if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 5) {
          fail(`${at}.perDimension.${dimension}`, `§4's scale is 1..5 and nothing else; got ${JSON.stringify(score)}`);
        }
      }
    });
  }
  return raw as unknown as CorpusScores;
}
