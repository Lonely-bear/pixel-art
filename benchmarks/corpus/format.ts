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
 *
 * ## Which codes are here and which are not, and why
 *
 * Six of `value`'s seven codes have a case that declares them; the seventh,
 * `key-light-inconsistent`, deliberately does not, and the reason is a finding rather than an
 * omission. **§4.2's `keyLight` is a subject-level check being applied to scenes.** It samples
 * two ninths of `bounds` — the top-left and the bottom-right — and subtracts the means, on the
 * assumption that they are two sides of one lit form. In a landscape those corners are
 * *different materials*: measured on this repository's ten committed scenes, the check reads
 * 10, 6 and 10 on three of them, which is inside §4.2's own `0 <= keyLight < 12` clause, so it
 * fires. Two of the ten are the same scene at two settings, so the honest count is "two scenes
 * in three renderings", and the finding is the same either way: a check that reads a lit subject
 * is reporting on a photograph of a valley.
 *
 * The right fix is a §3.3 quantity — "which pixels belong to the same lit form" — and
 * `TASKS.md` records T-012 correctly declining to invent one for `convexCorner` from inside a
 * dimension. So this is recorded rather than fixed, in three places: here, in
 * `DECLARED_QUANTITIES` for the curvature gate that fails the same way, and in the report's own
 * `value` table, which prints `keyLight` on every row so a reader can see which subjects the
 * number is a claim about. What is *not* done is dropping the code, because a code that quietly
 * stops appearing in a test is a code that quietly stops working.
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
  | 'frames-identical'
  | 'plane-crosses-form'
  | 'hue-carries-form'
  | 'flat-value'
  | 'narrow-value-range'
  | 'shadow-crushed'
  | 'highlight-blown'
  | 'stray-colour'
  | 'isolated-pixels'
  | 'single-pixel-spur'
  | 'diagonal-seam'
  | 'near-duplicate-colours'
  // T-014: `palette`'s six codes, all of §4.3's issue table. Each one exists here because the
  // dimension ships with **every** one of them declared in the specification and §3.5's fourth rule
  // refuses a case that declares a defect the report does not carry — so a code with no case is not
  // an omission, it is an unimplemented feature the corpus will not let through.
  | 'off-palette'
  | 'colour-budget-exceeded'
  | 'hue-sprawl'
  | 'muddy-mix'
  | 'grey-colours'
  | 'invented-colours';

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
  | 'subjectPerimeter'
  | 'holeCount'
  | 'holeArea'
  | 'spanQ'
  | 'convexCorners'
  | 'compactnessQ'
  | 'thicknessPx'
  | 'thicknessQ'
  | 'profileQ'
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
   * The §6.2 contrast-pair groups this case belongs to.
   *
   * A matched pair differing in exactly one property is the cheapest regression test this system
   * has and the only one that catches a mis-targeted measurement, so the grouping is data rather
   * than a naming convention: the report can then compute the *size of the gap* between members,
   * which §6.2 says is the thing worth reviewing ("a pair that separates by 0.02 is passing the
   * test and still wrong").
   *
   * **A list, not a single group, because a contrast is a relation and a relation is not a
   * partition.** A 3px band is the reference for two different questions — "the same drawing on
   * two canvases" and "the same drawing at two resolutions" — and it is the *second* of those
   * that the report was printing `not separable` for, because a one-valued field put the band on
   * 32² in one group and could not also put it in the other. The measured answer to a negative
   * pair is a **zero**, and a zero the report cannot print is a pair the corpus does not have.
   */
  readonly pair?: readonly string[];
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

/**
 * The thresholds T-022 **derived**, kept apart from {@link SPEC_GATES} on purpose.
 *
 * `SPEC_GATES` is a transcription of `docs/EVALUATION.md`, and a transcription is checkable
 * where an import is not: if the implementation hard-codes 300 and this file says 300, the
 * two agreeing is evidence, and if the spec moves the number this file is visibly stale.
 * That property only survives while nothing in this file was *invented*, so T-022's own
 * numbers live here with a name that says whose they are.
 *
 * Every member is a **policy proposal with a distribution behind it, not a settled gate**, and
 * the distribution is in `baseline.md`. TASKS.md's standing decision is that a threshold is a
 * product decision; the routing of a fix was "fix the measurement, not the gate", and this is
 * where the numbers that routing forced into the open are recorded so they can be argued about
 * rather than discovered in a diff.
 *
 *   - `thicknessQ` has **no line in §4.1 at all** — it is the gate for a quantity T-022 added.
 *     250 is transcribed from §3.7's `span < 0.25` ("a subject must occupy a quarter of the
 *     room") rather than picked, which is the honest alternative to a number chosen to make the
 *     corpus come out the way it already looked.
 *   - `profileDeep` and `holeNick` are the two band edges T-022 added, both **below** the gate
 *     they grade, so no subject that fired before stops firing.
 */
export const DERIVED_POLICY: Readonly<{
  /** `silhouette`'s scale-aware gate: `thicknessQ < thicknessQ` -> `thin-profile`. */
  thicknessQ: number;
  /** `profileQ < profileDeep` costs twice the existing step. A second band, below the gate. */
  profileDeep: number;
  /** `interior-hole`'s ≤3px clause, when the ratio clause did not fire. */
  holeNick: number;
  /** Why each of the three is where it is, for the report and for a reviewer. */
  readonly rationale: Readonly<Record<'thicknessQ' | 'profileDeep' | 'holeNick', string>>;
}> = {
  thicknessQ: 250,
  profileDeep: 150,
  holeNick: 50,
  rationale: {
    thicknessQ:
      'Transcribed from §3.7\'s `span < 0.25`, the specification\'s one statement about how much of the canvas a subject must occupy to count as present. Not a line of §4.1, and §4.1 has no row for a thickness gate at all.',
    profileDeep:
      'A second step BELOW the existing `compactnessQ < 300`, so the trigger and the set of subjects that fire are unchanged. Grading anything above 150 is impossible without moving the gate, which TASKS.md forbids.',
    holeNick:
      '§4.1 prices both hole clauses at -100. The split comes from §4.1\'s own rating anchors: "4 — one mass, one small nick: a single 1-2 px hole" against "2 — ... several holes". A nick is half a window; the window keeps §4.1\'s -100 exactly.',
  },
};


/* ------------------------------------------------------------------ *
 * §3.3 quantities: what is measured, and what is still in conflict
 * ------------------------------------------------------------------ */

/**
 * The measurement record for a §3.3 name: what the specification says, what this repository
 * does about it, and — where the specification says two incompatible things — the numbers that
 * settle the argument.
 *
 * Written down because §3.3 is self-contradictory about one of them and the next dimension to
 * need it will otherwise have to re-derive the answer from the same argument. This is the shape
 * `countConvexCorners`' doc comment takes, generalised: a claim about a specification belongs
 * next to the data, not in a comment the next revision will not trip over.
 *
 * **`status` is about the code, not about the specification.** `'implemented'` means the pipeline
 * measures this name today; the specification can still be in conflict, and two of the entries
 * here are implemented *and* conflicted, which is the state that is easy to miss and expensive to
 * rediscover. A conflict with no implementation is a task waiting for an owner; a conflict with
 * one is a divergence between a committed number and a committed document, and the next revision
 * of §3.3 has to reconcile it deliberately rather than by whoever reads the diff.
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
   * out so the test is written from the record rather than from the argument a second time. More
   * than one shape where one of them is the shape that *fails* to discriminate, because that is
   * the half of the evidence a reader needs in order to trust the other half.
   */
  readonly discriminator?: string;
  /**
   * The answers, as `[label, value]` pairs, for the shapes named above — every reading on every
   * shape, so a tie is visible as a tie rather than hidden by dropping a row. Measured by the
   * corpus test from small local reference implementations of the *specification's* wordings, and
   * not from the pipeline, which implements one reading and would therefore agree with itself.
   */
  readonly discriminatorValues?: readonly (readonly [string, number])[];
}

/**
 * Every §3.3 name the pipeline touches or defers, and the one place its status is written.
 *
 * The implemented entries are the ones `measure.ts` owns, plus the two §4.1 refinements
 * (`perimeter` as a transition count, holes as background-8/holes-4) which are decisions about
 * *how* a name is counted rather than new names.
 *
 * **Nothing is unimplemented any more, and the two findings that replaced that status are both
 * "implemented, and wrong somewhere".** `dist`/`Dmax` is defined twice incompatibly in §3.3 and
 * this repository measures the prose reading anyway, which leaves §4.2's own worked example
 * written against the other one — a divergence between a committed number and a committed
 * document, recorded with all six measurements that produce it. And §3.3's `convexCorner` is
 * measured as written, reads 0 on every convex shape in the pipeline, and is inert in both
 * directions as §4.2's curvature gate, which is why that gate reads 0 on all ten full-bleed
 * scenes and the form sub-term is 1000 on 12 of the 12 real assets. Both are next to their data
 * rather than in a changelog, which is the whole reason this file exists.
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
    name: 'compactnessQ',
    status: 'implemented',
    adopted:
      'Scale-invariant shape descriptor, and scale-invariant on purpose: measured over the LARGEST 4-connected component (the subject), never the whole mask, so a subject is not charged for the fragments beside it.',
    specText:
      'min(1000, rhu(4 * 355 * 1000 * N, 113 * perimeter * perimeter)). §4.1 does not say whether N and perimeter are the whole mask or the subject; T-021 measured the whole-mask reading and it is the second of the two defects T-022 fixed.',
    neededBy: ['silhouette'],
    discriminator:
      'A 5x5 square, measured alone (785) and beside two other 5x5 squares it does not touch (259). The whole-mask reading scores the fragment; the subject reading does not.',
  },
  {
    name: 'thicknessPx',
    status: 'implemented',
    adopted:
      'Side of the subject\'s largest inscribed axis-aligned square, in pixels. NOT §3.3\'s `Dmax`, which is measured below on the prose reading, and deliberately not a redefinition of it.',
    specText:
      'Not in §3.3. T-022 added it as the scale-aware reading §3.3\'s `Dmax` paragraph argues for — "Dmax doubles as the sprite\'s own scale ... a 3px-wide blade and a 30px-wide cloak do not have the same room to put a curved terminator in" — computed by the one method with no `dist` reading to choose between. `thicknessQ` is this against `min(W, H)`.',
    neededBy: ['silhouette'],
    discriminator:
      'A 28x3 band, drawn twice: centred on 32x32 and centred on 1024x1024. compactnessQ is 275 on both, which is the shape descriptor being right not to move — it is the same drawing — and thicknessQ is 94 against 3, with thicknessPx 3 in both. A maximal square is a per-side count rather than a half-thickness, so on a disc it reads about 30% under the diameter; that bias is stated rather than tuned away.',
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
    status: 'implemented',
    // The prose wins over the table for the same reason the 4-connected subject wins over an
    // 8-connected one: everything else in §3.3 is 4-connected, and a Chebyshev `dist` over an
    // 8-connected neighbourhood would let `value`'s plane-depth normalisation disagree with
    // `noise`'s thin-sprite rule about where a boundary is. The status is `implemented` because
    // T-013 measured it rather than leaving it declared: `distField` in
    // `packages/core/src/quality/measure.ts` is the prose, verbatim, and `value` is its first
    // consumer. T-021 recorded this as an open conflict with no owner; the owner arrived and
    // settled it, which is the only way a record like this should ever change status.
    adopted:
      '4-connected multi-source BFS from every edgePixel, +1 per step (the prose), as `distField` in `quality/measure.ts`. `Dmax` is its max over the solid pixels and is on every `ValueFrame`, so `outline` (T-016) and `noise` (T-015) read the same field rather than re-running the BFS.',
    specText:
      'Table: "the Chebyshev distance to the nearest non-solid pixel or to the canvas edge". Prose: "a multi-source BFS over the solid mask from every edgePixel, 4-connected, with +1 per step".',
    neededBy: ['value', 'outline', 'noise'],
    // **T-022's correction, and the finding.** T-021 shipped a 3x3-minus-a-corner discriminator
    // and two values, calling the second one "the prose". It is not: a BFS *confined to the solid
    // mask* from every `edgePixel` reaches the centre in one step, agreeing with the table. What
    // returns 2 is a BFS over the WHOLE grid from every non-solid pixel — Manhattan distance to
    // the nearest non-solid pixel, a third reading the specification does not state, and one that
    // also fails the table's own "0 on an `edgePixel`" clause, since an edge pixel sits 1 from a
    // non-solid pixel by that measure. So T-021's shape separates the table from an unstated
    // reading and leaves the reading the specification *does* state untested.
    //
    // Both shapes are recorded, because the one that does not discriminate is as load-bearing as
    // the one that does: it is the evidence that a discriminator has to be *checked* against all
    // three readings rather than trusted, and `quality-corpus.test.ts` measures all three on both
    // of them from local reference implementations of the three wordings, in the order §3.3
    // writes them.
    discriminator:
      'Two shapes, and the reason there are two. A 5x5 block is the discriminating one: its centre is 3 from the nearest non-solid pixel in L-infinity, 3 in L1 (the two agree, because the nearest non-solid pixel is axis-aligned from the centre), and **2** through the solid mask from the nearest edge pixel — so it separates the prose from both of the others. The 3x3 block with ONE corner pixel removed, which T-021 shipped, does **not**: the pixel diagonally opposite the removed corner has all four orthogonal neighbours solid, so the only transparent pixels it can see are diagonal, and every reading that gets there in one step gets there in one step. Chebyshev 1, whole-grid 2, prose 1. §3.3 still defines `dist` twice, so the next revision of the spec has to pick one with all six numbers in front of it.',
    discriminatorValues: [
      ['5x5 block — Chebyshev (L-infinity, the table)', 3],
      ['5x5 block — whole-grid BFS from every non-solid pixel (L1, unstated)', 3],
      ['5x5 block — BFS confined to the solid mask from every edgePixel (the prose, adopted)', 2],
      ['3x3 block, one corner removed — Chebyshev (L-infinity, the table)', 1],
      ['3x3 block, one corner removed — whole-grid BFS from every non-solid pixel (L1, unstated)', 2],
      ['3x3 block, one corner removed — BFS confined to the solid mask from every edgePixel (the prose, adopted)', 1],
    ],
    // **§4.2's own worked example is written against the other reading, and this is the number
    // that says so.** §4.2 records `Dmax` 8 for a 32x32 character and normalises `spanQ` by
    // `Dmax + 1 = 9`. This repository's own 32x32 character body — the 25-row silhouette
    // `packages/cli/src/demo.ts` builds its whole tonal stack from, which is the same row table
    // `quality-value.test.ts` shades — measures **Chebyshev 8, whole-grid 11, prose 10** on the
    // three readings. So the example's 8 is the table's answer exactly, and the adopted reading
    // gives 10 for the same pixels. The example is not wrong about the artwork; it is written
    // against the half of §3.3 the implementation does not use, and the next revision has to
    // re-derive it. The corpus prints the adopted `Dmax` beside every `value` row so the two
    // numbers can never be confused again.
  },
  {
    name: 'convexCorner',
    status: 'implemented',
    // **Two definitions of this one name now exist, and which one each caller reads is the
    // load-bearing part of this record.** `silhouette` reports §3.3's clause verbatim
    // (`countConvexCorners`, `SilhouetteFrame.convexCorners`) and it is 0 on every convex shape
    // in the pipeline; §4.2's curvature gate reads the corrected predicate instead
    // (`countConvexStaircaseCorners`, through `value`'s `curvedQ`), which is why the gate fires
    // at all. Retiring either is a §3.3 revision plus an edit to `silhouette.ts`, so both stand
    // and the corpus prints them side by side on every row (`cCorners` and `stairCorn`).
    adopted:
      'Two, and the difference is load-bearing. `silhouette` measures §3.3\'s clause verbatim, which counts concave corners and so reads 0 on every convex shape; §4.2\'s curvature gate reads `countConvexStaircaseCorners`, a pixel on a convex 45-degree staircase, because §4.2\'s prose is about that and not about this.',
    specText:
      'p is solid, exactly 2 of its 4 orthogonal neighbours are solid, those 2 are adjacent, and the diagonal pixel between them is transparent. §4.2 then claims this is "the signature of a 45-degree staircase on a convex boundary".',
    neededBy: ['silhouette', 'value'],
    discriminator:
      'A 32x32 filled disc, a 16x16 square, a 3px-wide diagonal band: all three measure 0 under §3.3\'s clause, and a 45-degree chamfer on a block also measures 0. Only a one-pixel nick cut diagonally outside a corner measures 1. The corrected predicate reads 64, 4 and 46 on the same three shapes.',
    // **The curvature gate WAS inert on every full-bleed scene, and T-100 is what this record was
    // waiting for.** `curvedQ` read 0 on all ten of this repository's committed scenes — and
    // `reachQ`, the other gate in the same product, is under 500 on most of them as well — so
    // `crossesQ` was 0 and the whole form sub-term was 1000 on 12 of the 12 real assets, and every
    // plane in every full-bleed scene was exempt. The cause was one fact: `curvedQ` counted
    // `edgePixel`s within Chebyshev 3 of the tone plane, and a full-bleed subject has no edge pixel
    // except the canvas frame, which is nowhere near a plane in the middle of a landscape. So a
    // straight shadow band across a curved mountain was excused, and both gates that would have
    // caught it were reading a silhouette.
    //
    // **The fix was a new §3.3 quantity rather than a threshold, and it is `regionCurvedQ` below.**
    // That is the shape of the answer the comment above asked for and could not supply from inside
    // a dimension: the curvature has to come from somewhere that is not the subject's outline. The
    // ten scenes now read 667..880 against a gate of 250, three of them have a measured `formQ` of
    // 1000, and `value/straight-band-over-terrain-64` — a straight band across a curved dome, the
    // defect this hole let through — reads `crossesQ` 501 and fires `plane-crosses-form`.
  },
  {
    // **T-100's quantity, and the reason §3.3 needed one at all.** §4.2's curvature gate asks
    // whether the local form is round, and until T-100 it read that off the subject's own outline —
    // which on a full-bleed document is the canvas rectangle, so the gate was closed on every plane
    // in all ten committed scenes and a straight shadow band across a curved mountain was excused.
    // No threshold fixes that, because when the mountain reaches the edges it *is* the frame and the
    // two are the same set of pixels; the only fix is a curvature source that does not come from the
    // silhouette, and the only such source the document has is the shape of its own tone regions.
    name: 'regionCurvedQ',
    status: 'implemented',
    adopted:
      'Per tone region, the density of convex-staircase corners on that region\'s WHOLE boundary: rhu(corners * 1000, boundary + 1). Still measured and still printed, because it is the honest standalone question — "how curved is this tone region" — and because the corpus shows what taking the plane out changes. It is NOT what §4.2\'s gate reads: T-101 added `planeCurvedQ` below, and the gate takes the max of the silhouette reading, this, and that.',
    specText:
      'Not in §3.3. T-100 added it as the curvature reference §4.2\'s gate needs and cannot get from the silhouette, which is the "a new §3.3 quantity rather than a patch" that `convexCorner`\'s record above was waiting for. The predicate is `convexStaircaseCornerAt` with membership taken as `regionId[q] === r` rather than as a mask, so there is one definition of the staircase and two call shapes into it.',
    neededBy: ['value'],
    discriminator:
      'Two shapes that differ in nothing but whether the form turns, which is the whole question the gate asks. A straight-edged box is a stack of horizontal bands, so every band\'s boundary is two straight runs and the density is low: `value/hard-surface-terminator-32` reads 93 against a gate of 250 and keeps its exemption, which is §4.2\'s own clause that "a straight plane across a straight-edged form is correct, not wrong". A dome is nested ellipses, so every crescent\'s boundary is an arc: `value/terrain-following-terminator-64` reads 422 and is judged. On the same two documents the *other* reference reads 65 and 0, which is the measurement that says the new one is what moved.',
    // **The two halves of the discrimination, kept apart because conflating them is T-099's lesson.**
    // The pair `value/terrain-following-terminator-64` / `value/straight-band-over-terrain-64` is one
    // dome and one change — whether the lit face is shaded by crescents concentric with the form or
    // split by a straight band. Both are now JUDGED (neither reads `unmeasured`), and they differ on
    // `bendQ`: 1000 against 0, `crossesQ` 0 against 501, `value` 950 against 725. The gate decided
    // whether to look; `bendQ` and `splitQ` decided what it found. A reference that had made the
    // second case `unmeasured` again would be a regression, and one that had fired on the first would
    // be a false positive on correctly shaded work — which is the more expensive of the two.
    discriminatorValues: [
      ['value/hard-surface-terminator-32 — the box: gate must stay CLOSED (§4.2 spares it)', 93],
      ['value/terrain-following-terminator-64 — the dome, form-following: judged, bendQ 1000', 426],
      ['value/straight-band-over-terrain-64 — the same dome, straight band: judged, bendQ 0', 420],
      ['artwork/autumn-dusk-lake-256.pixel — a real 256x256 landscape', 833],
      ['artwork/sunset-lighthouse-512.pixel — a real 512x512 landscape', 857],
    ],
  },
  {
    // **T-101's quantity, and the one §4.2's gate actually reads.** `regionCurvedQ` above was
    // supposed to be it, and it was close: it made the gate able to judge a full-bleed scene at all
    // (the ten committed scenes went from 0..77 to 667..880), but it let the plane being judged sit
    // in the denominator of its own region's reading. A straight band across a dome then read 260
    // at y=34 and 248 at y=40, against a gate of 250 — caught at one row, excused at the other, for
    // no reason a person could act on. **Whether a defect was reported depended on where it had been
    // drawn, which is not a gate.** The cause is mechanical: the band's own region is a perfect
    // rectangle and reads 0, and the dome region it cuts has corners only along its arc, so the cut
    // contributed boundary pixels and no corners to the very ratio meant to describe the arc.
    name: 'planeCurvedQ',
    status: 'implemented',
    adopted:
      "Per ORDERED region pair: one region's curvature with every boundary pixel of it that has a 4-neighbour in the other region removed, as rhu(cornersLeft * 1000, boundaryLeft + 1). §4.2's `curvedQ` is the max of this, `regionCurvedQ`, and the silhouette reading. **The counters are keyed by the ORDERED pair and that is the whole correctness of the function**: how much of a region's boundary is against one neighbour and how much of that neighbour's boundary is against it are different numbers, and keying one Map per unordered pair double-counts — measured as a density of 7385, an impossibility since a density cannot exceed 1000, caught by the corpus assertion on its first run. A pixel with two neighbours in the SAME region must also be counted once, or the cut exceeds the boundary and the density divides by zero (NaN on artwork/sunset-lighthouse-512.pixel). Transparent and off-canvas neighbours are NOT excluded: a region's edge against the background is the form's own outline, which is the thing being asked about.",
    specText:
      "Not in §3.3. T-101 added it because `regionCurvedQ` left the terminator inside the ratio, and §3.3 records the measurement that reversed that decision. It is per region PAIR and not per terminator, so it is one pass over the canvas rather than one full-boundary rescan per plane — artwork/sunset-lighthouse-512.pixel has 1008 terminators and the per-plane reading of this would be quadratic in the thing being measured.",
    neededBy: ['value'],
    discriminator:
      'The same pair that separated T-100, now separated by position rather than straddling a threshold. A straight-edged box is a stack of horizontal bands, so excluding the band between two of them leaves straight runs on both sides and there is nothing to recover: value/hard-surface-terminator-32 reads 93 before AND after, which is the check that the exclusion did not manufacture confidence where there was none. A dome is nested ellipses: the same band reads 333 at y=34 and 420 at y=40, both clear of 250, where the whole-boundary reading gave 260 and 248. The gap that motivated the task was 12 per-mille ACROSS a threshold; the reading now depends on the form rather than on where the band was drawn.',
    // **Two halves, kept apart because conflating them is T-099's lesson.** The gate decides whether to
    // look; `bendQ` and `splitQ` decide what it found. On the straight-band case `crossesQ` is EXACTLY
    // `splitQ` — `bendQ` is 0 and nothing else damps it — so whether that case is *reported* is a
    // question about §4.2's multiplier, not about this gate. Asserting a code here would assert a
    // different quantity's behaviour, which is how the first version of that test came to demand a
    // report the specification does not promise.
    discriminatorValues: [
      ['value/hard-surface-terminator-32 — the box: unchanged by the exclusion, gate stays CLOSED', 93],
      ['value/terrain-following-terminator-64 — the dome, no band: judged clean, bendQ 1000', 426],
      ['value/straight-band-over-terrain-64 — the same dome, band at y=40: judged, bendQ 0, splitQ 676', 420],
      ['the same band at y=34 — judged, formQ 550, and NO code, because splitQ is 501', 333],
      ['artwork/autumn-dusk-lake-256.pixel — a real 256x256 landscape', 833],
    ],
  },
];

/**
 * `ExcludedReason` duplicated rather than imported, so this file has no runtime dependency.
 *
 * **Deliberately a copy, and the copy has to be kept in step by hand.** It is a copy because
 * `format.ts` is the vocabulary of the *files on disk* — it validates `cases.json` before anything
 * has been built — and importing the pipeline's enum would make a `types.ts` addition arrive here
 * for free, which is exactly the drift this duplication exists to catch. It is a copy because
 * this loader must be able to reject a file naming a reason the build does not have.
 *
 * **It is narrower than the pipeline's enum on purpose, in one direction.** It lists only the
 * members a *corpus case* can legitimately declare. `no-judgeable-plane` and `line-sprite` are
 * §4.2's and §4.4's **sub-score** absences: they appear in a report's `unmeasured` map, which a
 * case records through a measured quantity rather than through `expect.preconditions`, so
 * accepting them as dimension-level reasons would let a case claim a dimension was excluded for a
 * reason that only ever names half of one. `'no-outline'` is in the list because it is
 * dimension-level and is exactly the shape `expect.preconditions.outline` asserts.
 */
export type ExcludedReason =
  | 'single-frame'
  | 'no-motion-content'
  | 'no-subject'
  | 'no-outline'
  | 'not-implemented';

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

/**
 * Every {@link DefectKind}, and the one list a coverage question is asked against.
 *
 * **Exported so the coverage guard can enumerate it rather than repeat it.** A hard-coded list of
 * defect names inside `quality-corpus.test.ts` is a second copy of a closed set, and a second copy
 * of a closed set is what the `value` work made stale: the dimension landed, the codes landed,
 * this list landed, and the test's copy of the names did not. Deriving the *coverage* question
 * from the loader's own list is not the circularity the sibling test in that file warns about —
 * there the list is compared for *identity* against the module's exports, so deriving it would be
 * satisfied by any re-implementation. Here the ground truth is "every code in the closed enum has
 * a case that says what it means", and the closed enum is a specification, not an implementation.
 * `quality-corpus.test.ts` pins a floor on its size, so a truncated list cannot make the
 * derivation vacuous.
 */
export const DEFECT_KINDS: readonly DefectKind[] = [
  'clean-control',
  'detached-pieces',
  'interior-hole',
  'thin-profile',
  'shape-clipped',
  'subject-undersized',
  'fragmented-silhouette',
  'empty-frame',
  'frames-identical',
  // T-013: six of `value`'s seven codes. §4.2's own table has eleven; the one with no case here
  // is `key-light-inconsistent`, and its absence is a recorded finding rather than an omission —
  // see the note on `DefectKind`. The code is not dead: it fires on
  // `value/hue-carries-form-32` and on three of the ten committed scenes. It is a subject-level
  // check with no subject-level case, and adding one would mean asserting that a valley is lit
  // from the wrong side, which is a taste claim this repository has one sample of.
  'plane-crosses-form',
  'hue-carries-form',
  'flat-value',
  'narrow-value-range',
  'shadow-crushed',
  'highlight-blown',
  // T-015: `noise`'s five codes. **`dither-dominant` is deliberately absent**, and the omission is the
  // measurement rather than an oversight — with `ditherMask` working it fires on
  // `value/level-set-32`, a negative control, because a 1px contour line and a 1px stipple are the
  // same set of pixels. `near-duplicate-colours` is here too: it is the flat `-100` penalty, and
  // `defect/near-duplicate-ramp-16` is the case that says it means something.
  //
  // **All five of these members have a case now, and two of those cases carry a second fact about
  // their own fixture.** §3.3 defines `n4(p)` and `n8(p)` as the "number of solid 4- and 8-**neighbours**
  // of `p`" — §4.4's own worked-example row settles it at "one wrong-coloured pixel inside a solid
  // block (`n8 == 8`)", which is eight, not nine — and `noise.ts`'s `neighbourCounts` used to count
  // the pixel itself, which made `isolated` (`n8 == 0`) and `diagOnly` (`n4 == 0`) unsatisfiable and
  // turned `spurs` (`n8 == 1`) into `isolated`. **The count is corrected**, so `isolated-pixels`,
  // `single-pixel-spur` and `diagonal-seam` are carried by `defect/isolated-pixels-18`,
  // `defect/single-pixel-spur-16` and `defect/diagonal-seam-24x20`.
  //
  // Both of those facts are recorded here because `expect.codes` is an exact match and a reader who
  // does not expect them will read the row as a second opinion rather than as the geometry:
  //
  //   - a 1px diagonal seam is **8-connected and 4-disconnected**, so `defect/diagonal-seam-24x20`
  //     fires `single-pixel-spur` as well: the run's two ends read `n8 == 1`. That is a true property
  //     of the drawing, not a defect in it, and it is the same reason
  //     `connectivity/diagonal-bridge-16` cannot be the home for `diagonal-seam` — a bare 1px run is
  //     a line sprite (`Dmax <= 1`), `diagQ` is `null`, and the issue is suppressed before a pixel is
  //     counted. The body beside the run is what keeps `Dmax` at 5.
  //   - `defect/single-pixel-spur-16`'s **canvas size is a design decision, not a framing.** §4.4's
  //     trigger is `spurs / N > 8/1000`, and the same 1px antenna reads `rhu(1000, 146) = 7` on an
  //     18² canvas — inside the trigger, so the count is right and the code does not fire — against
  //     `rhu(1000, 102) = 10` on the 16² canvas the case uses. **A case drawn at the larger size
  //     would have been a green row proving nothing**, which is what §3.2's "acceptance uses the
  //     discriminating case" is about.
  //
  // The members stay in this list rather than being deleted: `DefectKind` and `DEFECT_KINDS` are the
  // closed set of codes §4.4 specifies, so removing one would hide a code rather than cover it.
  'stray-colour',
  'isolated-pixels',
  'single-pixel-spur',
  'diagonal-seam',
  'near-duplicate-colours',
  // T-014: all six of `palette`'s codes, one case each. The interesting one is `muddy-mix`, because
  // **`muddy` is a subset of `off-palette` by §4.3's own definition and the two thresholds are 50 and
  // 20 per-mille**, so a case that fires `muddy-mix` necessarily fires `off-palette` too. That is a
  // fact about the threshold table and not about the fixture, and it is why
  // `defect/muddy-over-skin-32` declares both: a case that declared only `muddy-mix` would be a case
  // whose `expect.codes` disagrees with §4.3.
  'off-palette',
  'colour-budget-exceeded',
  'hue-sprawl',
  'muddy-mix',
  'grey-colours',
  'invented-colours',
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
  'subjectPerimeter',
  'holeCount',
  'holeArea',
  'spanQ',
  'convexCorners',
  'compactnessQ',
  'thicknessPx',
  'thicknessQ',
  'profileQ',
  'scoreQ',
];

/**
 * The dimensions whose applicability a case may declare, and the reasons it may declare for them.
 *
 * **`outline` is in the first list and `'no-outline'` is in the second, and that pairing is the
 * point of the change.** The abstention had no name before, so a corpus case had no way to say
 * "this document declares no contour and nothing is being graded" — which meant a dimension that had
 * nothing to say about most of the corpus had to emit a *defect code* instead, on clean artwork.
 * The loader's closed list is what makes the vocabulary real: a reason nobody can declare is a
 * reason nothing can be held to.
 *
 * `'no-outline'` is listed once, for all dimensions. The loader does not police which reason belongs
 * to which dimension — `expect.preconditions.outline: 'single-frame'` is nonsense and this file
 * does not stop it — because the *runner* compares each declaration against the predicate that
 * actually answers for that id, and a mismatch there is a failing case rather than a silent one. A
 * per-dimension reason table would be one more thing to keep in step with `quality/index.ts`.
 */
const PRECONDITION_IDS: readonly string[] = ['silhouette', 'outline', 'motion'];
const PRECONDITION_REASONS: readonly (ExcludedReason | null)[] = [
  null,
  'single-frame',
  'no-motion-content',
  'no-subject',
  'no-outline',
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
      // A case that declares a defect and also declares that same code absent is saying two
      // contradictory things about one picture, and the runner only reports whichever it happens
      // to check first. `defect/subject-undersized-64` carried exactly that for a whole task: it
      // declared `thin-profile` and listed it under `absent`, and it was caught by a test rather
      // than by the loader, which is the wrong order for a contradiction.
      for (const defect of defects) {
        if (defect.kind === 'clean-control') continue;
        if ((expect.absent ?? []).includes(defect.kind)) {
          fail(where, `declares defect "${defect.kind}" and also expects.absent to carry it; a case cannot require a code to fire and not fire`);
        }
      }
      const recipe = validateRecipe(`${where}.recipe`, entry.recipe);
      if (entry.pair !== undefined) {
        // An array of group names, not one. See `SyntheticCase.pair`: a contrast is a relation,
        // so a case belongs to as many groups as it has contrasts, and a one-valued field made
        // the report print `not separable` for a pair whose measured answer is 0.
        if (!Array.isArray(entry.pair) || entry.pair.length === 0) {
          fail(where, '"pair" must be a non-empty array of group names');
        }
        for (const group of entry.pair) {
          if (typeof group !== 'string' || group.length === 0) {
            fail(where, 'each "pair" entry must be a non-empty string');
          }
          if (!group.includes('/')) {
            fail(`${where}.pair`, `"${group}" should be namespaced "<dimension>/<name>" like the case ids are`);
          }
        }
      }
      return {
        id,
        label,
        tier,
        provenance: 'generated',
        defects,
        recipe,
        expect,
        ...(entry.pair === undefined ? {} : { pair: entry.pair as readonly string[] }),
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
