import { z } from 'zod';
import { CommandError } from '../bus.js';
import type { Sprite } from '../document.js';
import { animationSequence, findTag } from '../gif.js';
import { createQualityContext } from '../quality/context.js';
import {
  aggregatorIssues,
  evaluate as aggregateQualityReport,
  weightedTotalQ,
  weightsFor,
} from '../quality/index.js';
import {
  DEFAULT_QUALITY_WEIGHTS,
  FLOOR_FAIL,
  FLOOR_WARN,
  isBelow,
  isBlocking,
  QUALITY_ASSET_CLASSES,
  QUALITY_DIMENSIONS,
  SCORE_FAIL_THRESHOLD,
  SCORE_PASS_THRESHOLD,
  SEVERITY_BLOCKING,
  type ExcludedReason,
  type QualityAssetClass,
  type QualityContext,
  type QualityDimensionId,
  type QualityIssue,
  type QualityReport,
} from '../quality/types.js';
import type { FrameId, Rect } from '../types.js';
import {
  defineCommand,
  frameIdOf,
  frameRefSchema,
  rectSchema,
  type CommandSummary,
  type FrameRef,
} from './types.js';

/**
 * The quality pipeline at the command boundary: `evaluate`, `fix` and `verify`.
 *
 * Three commands, and the split between them is the whole design. `evaluate` **reports**,
 * `fix` **plans**, `verify` **refuses**. None of the three edits a pixel, so all three are
 * `readOnly` and none of them touches the bus's undo history — the analyzers are pure
 * functions of the document, and a question must never cost a redo stack.
 *
 * ## Why `fix` returns ops instead of running them
 *
 * The one architectural rule in this repository is that every mutation goes through
 * `applyCommand`, because that is what makes undo/redo, replay and the tool surface agree. A
 * `fix` that wrote pixels itself would satisfy every test in the file and still be a second
 * undo history, so the command returns `{command, params}` pairs as **data** and the caller
 * applies them through the bus. An agent gets to inspect the plan before committing it, one
 * `apply_ops` call covers the whole plan, and the entire repair lands as a single undo step.
 *
 * ## Why `verify` throws rather than returning `passed: false`
 *
 * A command that returns "false" has not refused anything: `apply_ops` would report it as a
 * success and the caller would move on. Refusal has to be an exception, because that is the
 * one thing every client in this repository already knows how to surface. The message is held
 * inside {@link REFUSAL_MESSAGE_BUDGET} because it travels as a tool-error string, and it
 * names the failing code and the measured per-mille number: a refusal an agent cannot act on
 * is indistinguishable from a broken tool.
 *
 * ## What is deliberately *not* here
 *
 * No score for an agent to optimise. `evaluate` publishes `score` because §3.6's report shape
 * makes it part of the contract, but nothing in this file turns it into a target, grades the
 * artwork, or says how far from passing a caller is. The gate refuses on **named defects and
 * named floors**, and a bypass is reported rather than quietly granted.
 */

/* ------------------------------------------------------------------ *
 * Targeting
 * ------------------------------------------------------------------ */

/**
 * The three ways to name what is being measured, shared verbatim by all three commands.
 *
 * Sharing the shape is the point: `evaluate`'s target, `fix`'s target and the gate's target are
 * the same question, and three separately spelled versions of it are three ways for the report
 * to describe a different document from the one that was repaired.
 *
 * `tag` resolves through `animationSequence` rather than by expanding the range here, because
 * `pingpong` and `repeat` mean what they mean to the GIF exporter and a second expansion is a
 * second answer. §7.7 is the reason any of this exists: a report describes the frames it was
 * given, so naming frames is how you stop a strong frame 0 from speaking for a broken frame 5.
 *
 * ## `frames`/`focus` here, `frame`/`rect` on the MCP tool — both kept, deliberately
 *
 * The session tool `evaluate` in `packages/mcp/src/tools.ts` measures with the same
 * `qualityPayload` this module's aggregator is reachable from, and it spells two of the three
 * fields differently: `frame` (singular) rather than `frames`, and `rect` rather than `focus`.
 * That is not drift, and both halves of it were chosen:
 *
 *   - **`frame`, singular.** `frames: [3]` is the command-namespace spelling because the command
 *     bus needs a list that can hold a whole sequence, and a one-element array is a per-frame
 *     pass. The session tool has exactly one such option and its own `tag` for the loop, so it
 *     takes the scalar and the array is not offered at all. It matches its 36 neighbours in that
 *     namespace, every one of which has `frame: frameRefSchema.optional()` — `draw_rect`,
 *     `despeckle`, `quantize_to_palette` and the rest. A session tool that spelled it differently
 *     from its own neighbours would be the thing an agent has to remember.
 *   - **`rect`, not `focus`.** §7.7's word for it in prose is "a region to scope the report to",
 *     and `rect` is what every other region argument on the wire is called. `focus` is the
 *     internal name on `QualityContext`, and a tool argument should not be named after a field of
 *     the object it happens to populate.
 *
 * `pixel://quality/{doc}` is the third channel and takes `?frame=N`, matching the tool, because
 * a URI query cannot carry a JSON object — which is also why that resource tells a caller who
 * wants to scope a report to use the tool instead. The rule underneath all three is the same and
 * is the one that matters: **they select the same frames and the same region, so a report fetched
 * from a URI and a report returned by a tool call are the same bytes.**
 */
const targetShape = {
  tag: z
    .union([z.string(), z.number().int()])
    .optional()
    .describe(
      'Evaluate one animation tag by name, id or 0-based index. Its frames are measured in playback order, direction and repeat included. Use this for an animation: a per-frame pass says something only about that frame.',
    ),
  frames: z
    .array(frameRefSchema)
    .min(1)
    .optional()
    .describe(
      'Evaluate exactly these frames, in this order, each by id or 0-based index. A single element is a per-frame pass and is a statement about that frame alone. Mutually exclusive with `tag`; omit both to measure every frame once in document order.',
    ),
  focus: rectSchema
    .optional()
    .describe(
      'Report only the issues whose region touches this rect. It narrows what you are told, not what is measured — quantities are still taken over the whole canvas, because clipping the mask would make the box\'s own edge read as the sprite\'s edge.',
    ),
};

interface QualityTarget {
  readonly frames: readonly FrameId[];
  readonly tag: string | null;
  readonly focus: Rect | null;
}

/**
 * The §5.2 weight-profile selector, shared verbatim by `evaluate` and `verify`.
 *
 * **`verify` takes it for the same reason `evaluate` does**, and this is the part that is easy
 * to get wrong: the gate re-derives §5.2's total from the report, and if it re-derived the
 * *class* too then a caller who said `assetClass: "animation"` to `evaluate` would be refused
 * against a `sprite` total. One schema object for both is what makes that impossible to spell
 * two ways. `fix` does not take it: it returns a repair plan and computes no total, so a class
 * would be a parameter that changes nothing.
 */
const assetClassShape = {
  assetClass: z
    .enum(QUALITY_ASSET_CLASSES)
    .optional()
    .describe(
      'Which weight profile to score under: `sprite` (a still subject, §5.1\'s table), `animation` (motion is measured and counts for much more), `scene` (a large canvas, where value planes and colour discipline carry the picture). Omit to derive it: a sequence with measurable motion is `animation`, otherwise a canvas over 16384px is `scene` and the rest is `sprite`. The derived answer is right unless you are judging one frame of an animation, which is the case to state here.',
    ),
};

/**
 * Resolve `tag` / `frames` / `focus` into the ordered frame list `createQualityContext` wants.
 *
 * The two ways of naming frames are made mutually exclusive rather than silently combined.
 * `frames` wins would make `tag` a no-op an agent cannot see, and `tag` wins would make the
 * caller's list a lie; a hard error is the only outcome that cannot be misread, and it is the
 * same reason `prune_palette` refuses `frame` without a matching `scope`.
 */
function resolveQualityTarget(
  sprite: Sprite,
  params: { tag?: string | number | undefined; frames?: readonly FrameRef[] | undefined; focus?: Rect | undefined },
): QualityTarget {
  if (params.tag !== undefined && params.frames !== undefined) {
    throw new Error('`tag` and `frames` are two ways to name the same frames; pass one.');
  }
  const focus = params.focus ?? null;
  if (params.tag !== undefined) {
    const sequence = animationSequence(sprite, params.tag);
    return {
      frames: sequence.frames.map((frame) => frame.frameId),
      tag: findTag(sprite, params.tag)?.name ?? null,
      focus,
    };
  }
  if (params.frames !== undefined) {
    return {
      frames: params.frames.map((ref) => frameIdOf(sprite, ref)),
      tag: null,
      focus,
    };
  }
  return {
    frames: animationSequence(sprite).frames.map((frame) => frame.frameId),
    tag: null,
    focus,
  };
}

/** Build the context and run the aggregator. The single path all three commands measure through. */
function runQuality(
  sprite: Sprite,
  target: QualityTarget,
  assetClass?: QualityAssetClass | undefined,
): { report: QualityReport; context: QualityContext } {
  const context = createQualityContext(sprite, { frames: target.frames, focus: target.focus });
  return { report: aggregateQualityReport(context, undefined, { assetClass }), context };
}

/* ------------------------------------------------------------------ *
 * Projection
 * ------------------------------------------------------------------ */

/**
 * One issue on the wire, with its severity in **per-mille**.
 *
 * `QualityIssue.severity` is a 0..1 float and every threshold in the pipeline is a per-mille
 * integer (`SEVERITY_BLOCKING` is `0.5` here and `500` in the rule that consumes it). Putting
 * the float on the wire would hand an agent a second unit to compare against, and §3.7's whole
 * discipline exists so that no threshold is ever evaluated as a float. `Math.round` is exact
 * for every severity the analyzers emit, all of which are two-decimal.
 *
 * ## Why the command publishes `severityQ` and §3.6's report still carries `severity`
 *
 * They are different claims about the same number, and both are kept on purpose:
 *
 *   - **`QualityReport` is frozen and §3.6 is its contract.** `severity: 0..1` is what
 *     `types.ts` declares, §3.5 fixes the blocking cut at `>= 0.5` in the same unit, and the MCP
 *     `evaluate` tool re-renders the report verbatim rather than projecting it. A report is a
 *     *record of what was measured*; its unit is part of the record.
 *   - **A command's numbers are the ones an agent may compare.** Everything a command publishes —
 *     `scoreQ`, `severityQ`, `thresholdQ`, `measuredQ` — is per-mille, because §3.7's rule is
 *     that a threshold comparison happens on an integer with no epsilon. One unit on the side of
 *     the boundary that a caller acts on is worth more than one unit everywhere.
 *
 * So the conversion is exactly one line, here, and §3.7 says in words that `severity` is
 * deliberately absent from its integer table (it is a fixed per-code constant from Appendix A, not
 * a ratio this sprite was measured on, so there is no arithmetic there to transcribe).
 *
 * **One caveat, stated rather than assumed.** `blocking` next to it is `isBlocking(issue)`, which
 * compares the *float* against `SEVERITY_BLOCKING`. For every severity in Appendix A — all
 * two-decimal — `round(severity * 1000) >= 500` and `severity >= 0.5` are the same predicate, so
 * the two fields cannot disagree today. A hypothetical three-decimal severity could make them
 * differ, and `isBlocking` is in the frozen `types.ts`, so the fix is a note in §3.7 rather than
 * an edit here.
 */
function issueView(issue: QualityIssue): Record<string, unknown> {
  return {
    code: issue.code,
    severityQ: Math.round(issue.severity * 1000),
    blocking: isBlocking(issue),
    rect: issue.rect,
    message: issue.message,
  };
}

/**
 * Which dimension emitted a code, or `'aggregator'` for one that describes the target rather
 * than any dimension's opinion of it (§5.4's `empty-frame` and `frames-identical`).
 *
 * A lookup rather than a field on the issue because `QualityIssue` is frozen and deliberately
 * carries no dimension id — the report's map is the identity (§3.6). Two dimensions emitting
 * one code is the same defect by the contract, so last-writer-wins in `QUALITY_DIMENSIONS`
 * order is a defined answer rather than an accident.
 */
function dimensionIndex(report: QualityReport): Map<string, string> {
  const byCode = new Map<string, string>();
  for (const id of QUALITY_DIMENSIONS) {
    for (const issue of report.dimensions[id]?.issues ?? []) byCode.set(issue.code, id);
  }
  return byCode;
}

/** Rects are objects and their identity says nothing, so the sort key is the geometry. */
function rectKeyOf(issue: QualityIssue): string {
  return issue.rect === null ? 'global' : `${issue.rect.x},${issue.rect.y},${issue.rect.w},${issue.rect.h}`;
}

/**
 * Severity descending, then code ascending, then rect — `collectBlocking`'s order, copied.
 *
 * It is copied rather than imported because `collectBlocking` is private to
 * `quality/index.ts`, which is not this change's to edit. The duplication is safe only because
 * the two lists are cross-checked in `quality-evaluate.test.ts`: the blocking subset of what
 * this produces has to be exactly `report.blocking`. An incidental sort order here would
 * otherwise be a baseline diff that nobody could explain (§3.2 rule 4).
 */
function bySeverityThenCodeThenRect(a: QualityIssue, b: QualityIssue): number {
  const bySeverity = b.severity - a.severity;
  if (bySeverity !== 0) return bySeverity;
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  const left = rectKeyOf(a);
  const right = rectKeyOf(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Every issue in the report, deduplicated by `(code, rect)` and ordered.
 *
 * `QualityReport` has no field for the non-blocking aggregator advisories, and §5.4 says so
 * rather than papering over it: `frames-identical` at severity 350 says something the
 * `excluded` reason does not, namely that four copies of frame zero is *probably* a mistake.
 * A command surface is where that gap stops mattering — the advisories are the advice, and a
 * caller that only wanted the gate-relevant subset has `report.blocking`.
 */
function everyIssue(report: QualityReport, context: QualityContext): QualityIssue[] {
  const seen = new Set<string>();
  const out: QualityIssue[] = [];
  const add = (issue: QualityIssue): void => {
    const key = `${issue.code}|${rectKeyOf(issue)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(issue);
  };
  for (const id of QUALITY_DIMENSIONS) {
    for (const issue of report.dimensions[id]?.issues ?? []) add(issue);
  }
  for (const issue of aggregatorIssues(context)) add(issue);
  return out.sort(bySeverityThenCodeThenRect);
}

/**
 * The measured dimensions, in `QUALITY_DIMENSIONS` order, with nothing invented for the rest.
 *
 * A key that is absent from this object is absent from `excluded` too — the two travel together
 * because §3.6's invariant is that every id is accounted for exactly once. `unmeasured` is
 * carried through rather than dropped: a sub-score nobody took is not a zero, and a caller that
 * read `value: 940` without it would be reading a mark nobody earned for half the dimension.
 */
function dimensionViews(report: QualityReport): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const id of QUALITY_DIMENSIONS) {
    const dimension = report.dimensions[id];
    if (dimension === undefined) continue;
    out[id] = {
      scoreQ: dimension.scoreQ,
      verdict: dimension.verdict,
      unmeasured: { ...dimension.unmeasured },
      issues: dimension.issues.map(issueView),
    };
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * T-019 `evaluate`
 * ------------------------------------------------------------------ */

export const evaluateQualityCommand = defineCommand({
  name: 'evaluate',
  description:
    'Measure the sprite with every registered quality dimension and return the report: one entry per measured dimension with its per-mille score, a sentence of verdict, its issues and any sub-scores it could not measure, plus the dimensions that did not apply and why. Pass `tag` to measure an animation in playback order, `frames` for a single frame, or `focus` to narrow which issues are reported. Read-only: nothing is written.',
  guide:
    '## Reading the result\n\n' +
    '`dimensions` holds only the dimensions that **applied**. A key that is missing is not a zero — ' +
    'it is `excluded` with a reason, and the reason is the point: `no-subject` on a full-bleed scene ' +
    'means the ink reaches all four canvas edges so there is no shape to read, and that is a fact ' +
    'about the document rather than a defect. Nothing in this report can be averaged in by a caller ' +
    'that forgets to check, because a missing key cannot be.\n\n' +
    '`scoreQ` is a **per-mille integer, 0..1000**, higher is better. `severityQ` on an issue is ' +
    'per-mille too, and `>= 500` is blocking. Both are integers on purpose: every threshold in the ' +
    'pipeline is an exact integer comparison with no epsilon, so a report that lands on a boundary ' +
    'is decided rather than rounded into it.\n\n' +
    '`verdict` on a dimension is free text and is meant to be read; `verdict` at the top level is the ' +
    'gate decision. They are not the same field and they do not always agree — a dimension can fail ' +
    'badly inside a passing report, and a well-worded dimension can sit inside a failing one.\n\n' +
    '`unmeasured` names the sub-scores a dimension could not take and why. A dimension with one ' +
    'reports the score of the ones it did measure, re-normalised. An empty object means everything ' +
    'was measured.\n\n' +
    '## Determinism\n\n' +
    'The same document in, byte-identical report out. No clock, no ids that vary per run, no hash ' +
    'iteration order — so two reports can be diffed and the diff means the artwork changed. If you ' +
    'need a per-frame statement, pass `frames: [n]`; if you need the loop, pass `tag`.\n\n' +
    '## What to do with it\n\n' +
    'Treat `issues` as a to-do list and fix the highest `severityQ` one, then re-run. Expect the ' +
    'first pass on a new sprite to read low: that is the silhouette pass, not a failure. `fix` turns ' +
    'the issues that have an unambiguous repair into ops; `verify` is the gate that refuses delivery.',
  readOnly: true,
  params: z.object({
    ...targetShape,
    ...assetClassShape,
  }),
  apply(ctx, p) {
    const target = resolveQualityTarget(ctx.sprite, p);
    const { report, context } = runQuality(ctx.sprite, target, p.assetClass);
    const owner = dimensionIndex(report);
    return {
      frames: [...target.frames],
      tag: target.tag,
      focus: target.focus,
      // Which weight profile produced `score`, and whether the caller or the aggregator chose
      // it. A reader who cannot see this cannot explain a number that moved.
      assetClass: { ...report.assetClass },
      dimensions: dimensionViews(report),
      excluded: { ...report.excluded },
      // Every issue, advisories included: `fix` and a reader both need the ones the report has
      // no field for, and `evaluate` is the only place they exist.
      issues: everyIssue(report, context).map((issue) => ({
        ...issueView(issue),
        dimension: owner.get(issue.code) ?? 'aggregator',
      })),
      blocking: report.blocking.map(issueView),
      verdict: report.verdict,
      score: report.score,
    };
  },
});

/* ------------------------------------------------------------------ *
 * T-023 `fix`
 * ------------------------------------------------------------------ */

/** One operation on the command bus. Returned as data; never executed here. */
export interface QualityFixOp {
  readonly command: string;
  readonly params: Record<string, unknown>;
}

/** What a caller can do about one issue, and what a human has to do about it. */
export interface QualityFixPlan {
  readonly code: string;
  readonly dimension: string;
  readonly severityQ: number;
  readonly blocking: boolean;
  /** Absolute canvas coordinates, or `null`. Never invented: see `noRegion`. */
  readonly rect: Rect | null;
  /** `ops` when a repair is unambiguous, `manual` when only a person can decide. */
  readonly fix: 'ops' | 'manual';
  readonly ops: readonly QualityFixOp[];
  /** Always present. What a human has to do, and why no op was invented when there is none. */
  readonly guidance: string;
}

interface CodeAdvice {
  /** One sentence: the decision only a person can make. Present for every code. */
  readonly guidance: string;
  /** Why this code names no region, for the codes whose `rect` is `null`. */
  readonly noRegion?: string;
  /** An unambiguous repair. Present only where one genuinely exists. */
  readonly ops?: readonly QualityFixOp[];
}

/**
 * What a person has to do about each code, and where a repair is unambiguous.
 *
 * **Three codes have one, and each earned it separately.** `near-duplicate-colours` says in its
 * own issue message that `quantize_to_palette` merges the pair: the two swatches have to become
 * one, there is nowhere else for them to go, and the operation is reversible through the same undo
 * stack as everything else. `off-palette` and `muddy-mix` get the same operation because §7.3
 * names it as the documented mitigation for an undeclared colour, with the false-positive caveat
 * repeated in the guidance — §7.3 also says this is the single most likely reason for good work to
 * be blocked. `muddy-mix` is not a separate judgement: §4.3 counts `muddy` over **off-palette
 * pixels only**, so a muddy pixel is by definition an undeclared one and §7.3 covers it verbatim.
 *
 * **Each of those three was measured, not argued.** A mapping that is merely *returned* is a
 * mapping that has never been shown to work, and the fixture matters: `quantize_to_palette`
 * changes 0 bytes on `defect/near-duplicate-ramp-16` because both swatches are already nearest to
 * their own pixels, so an end-to-end test on the obvious fixture would pass vacuously.
 * `test/quality-fix.test.ts` runs each op on a fixture where it is not a no-op and asserts the
 * code is gone afterwards.
 *
 * **The rest decline, and for `palette` the reason is measured too.** A `despeckle` over a cel
 * would answer `isolated-pixels` and would also answer "the artist meant that one pixel", and
 * nothing available can tell those apart — §7.6 documents the dimension as the one most likely to
 * sand a piece flat, and the honest response to that is not a default op. A fill colour for
 * `interior-hole`, a scale factor for `subject-undersized` and a canvas size for `shape-clipped`
 * are the same shape of guess. For `colour-budget-exceeded`, `hue-sprawl` and `grey-colours` the
 * arithmetic is even flatter: every colour they are unhappy about is already a declared swatch, so
 * `quantize_to_palette` changes nothing — 0 bytes on their own corpus fixtures, with the code
 * surviving. What is left needs `replace_color`, and `replace_color` needs a `layer`, a `frame` and
 * a `from`/`to` pair that a `rect: null`, cel-free, document-wide issue does not carry.
 * `invented-colours` is the sharpest of them: §4.3's `maxNearestDistance > 12000` exists
 * *precisely* to separate "one step off a ramp entry, one `quantize_to_palette` call" from
 * "30000 away from every swatch, the fix is a decision", so handing that code the snapping op
 * would delete the distinction the quantity was added to make. So the table says what a human has
 * to do, and `fix` returns no op. A fix command that guesses is worse than one that declines.
 *
 * **§4.5's four codes all decline, and `outline-gap` declines for a stronger reason than the rest.**
 * None of them has an unambiguous repair, and `outline-gap` should not want one: §4.5 reports it at
 * severity 0.25 as an *advisory* precisely because selective outlining is recommended craft, so a
 * command that closed the contour would be undoing the technique the code exists to make visible.
 * `outline-inconsistent-weight` and `outline-colour-split` each reduce to "which side / which colour
 * survives", and `outline-heavy` reduces to erasing opaque pixels, which is the one operation this
 * repository has no command for and no safe default for.
 *
 * **Unknown codes get a default, not a crash.** §8.3 makes `code` an open string: a minor version
 * may add codes, and an agent must tolerate one it does not recognise. The fallback declines and
 * points at the issue message rather than throwing.
 */
export const QUALITY_FIX_ADVICE: Readonly<Record<string, CodeAdvice>> = {
  'near-duplicate-colours': {
    noRegion:
      'The defect is a pair of palette entries rather than a place on the canvas, so the issue names no region and none was invented. `quantize_to_palette` is whole-document by nature, which is the right scope here.',
    guidance:
      '`quantize_to_palette` snaps every pixel onto the nearer swatch, which merges the pair when at least one of the two is off-palette. It is a no-op on a document already snapped to its own palette — both swatches are already nearest to their own pixels — and there the pair has to be merged on the palette itself, by recolouring one of them with `replace_color` and then `prune_palette`. Which of the two survives is a decision, so that part is yours. Re-run `evaluate` afterwards: merging two ramp entries can expose a new pair.',
    ops: [{ command: 'quantize_to_palette', params: {} }],
  },
  'off-palette': {
    noRegion:
      'The defect is the document\'s relationship to its own palette rather than a place on the canvas, so the issue names no region and none was invented.',
    guidance:
      '`quantize_to_palette` snaps every pixel onto a declared swatch, which is §7.3\'s documented mitigation. Read §7.3\'s warning first: a translucent highlight layer composites into a colour that is in no palette by design, so this is the most likely false positive in the pipeline and quantizing it may cost more than it saves. It is also a no-op on a document already snapped to its own palette.',
    ops: [{ command: 'quantize_to_palette', params: {} }],
  },
  'muddy-mix': {
    noRegion:
      'The defect is the document\'s relationship to its own palette rather than a place on the canvas, so the issue names no region and none was invented.',
    guidance:
      '`quantize_to_palette` is the repair, and for the same reason it is `off-palette`\'s: §4.3 counts `muddy` over **off-palette pixels only**, so a muddy pixel is by definition an undeclared one and §7.3 covers it verbatim — it is an average of two ramp entries that never got committed to either. The §7.3 warning is the same: if those pixels are a translucent layer\'s composite, snapping them may cost more than it saves. Note also that `off-palette` fires alongside this one every time (§4.3\'s triggers are 20 and 50 per-mille over a nested quantity), so the two plans share one op.',
    ops: [{ command: 'quantize_to_palette', params: {} }],
  },
  'invented-colours': {
    noRegion:
      'The defect is a colour rather than a place, so the issue names no region and none was invented — and it does not name the colour either, so no `replace_color` can be aimed at it without your finding it first.',
    guidance:
      'This is the one undeclared-colour code with **no** automatic repair, and §4.3 says so itself: `maxNearestDistance > 12000` exists precisely to separate "one step off a ramp entry, one `quantize_to_palette` call" from "30000 away from every swatch, the fix is a decision". The quantity was added to draw that line, so handing this code the snapping op would erase it. `quantize_to_palette` *will* clear the code here — it snaps the offending pixel to whichever swatch happens to be nearest — which is exactly why it is not the answer: it clears the warning without telling you whether it picked the colour you meant. Find the colour (`histogram`, or the issue\'s own number), decide which declared swatch it should have been, and paint it there with `replace_color` or `replace_colors`.',
  },
  'colour-budget-exceeded': {
    noRegion:
      'The defect is a count over the whole document rather than a place on the canvas, so the issue names no region and none was invented.',
    guidance:
      'No op, and the reason is arithmetic rather than caution: every colour counted here is already a declared swatch, so `quantize_to_palette` changes 0 bytes and the code survives it. The repair is to *merge* two of them — which two is a decision about the ramp, and a ramp whose steps are one apart is doing its job. `replace_colors {from, to}` merges one into another document-wide, then `prune_palette` drops the entry nothing uses; picking the pair is yours. If the count is right and the budget is wrong, that is §7 item 8 (budgets are keyed on canvas area, so one table cannot serve an icon and a landscape) and the honest response is to size the canvas to the job.',
  },
  'hue-sprawl': {
    noRegion:
      'The defect is a count over the whole document rather than a place on the canvas, so the issue names no region and none was invented.',
    guidance:
      'No op. As with `colour-budget-exceeded`, every colour involved is already declared — `quantize_to_palette` changes 0 bytes here — so the repair is choosing which two hue families to pull onto one ramp and which swatches should carry them, and that is an art-direction call, not a nearest-colour lookup. `replace_colors {from, to}` does the merge once you have decided it. Read the class sentence in the issue first: it fires *because* the canvas is not scene-class, so if this really is a scene that was painted small, the fix is the canvas rather than the palette.',
  },
  'grey-colours': {
    noRegion:
      'The defect is a mean over the whole document rather than a place on the canvas, so the issue names no region and none was invented.',
    guidance:
      'No op, and here the arithmetic is decisive: `quantize_to_palette` can only move a pixel *towards a declared swatch*, and every swatch is already declared, so it changes 0 bytes and the code survives. Raising saturation means editing or adding swatches — `add_palette_ramp`, or a deliberate step up an existing ramp — and picking which material the washed colour was meant to be is your decision, not a distance function\'s. The issue\'s own `meanSat` number is the target to move, not a thing to optimise towards: it goes up by making a choice, not by repainting everything.',
  },
  'detached-pieces': {
    guidance:
      'Join each detached piece to the main mass with one opaque pixel, or delete it. Which is right depends on what it was meant to be, so nothing is painted for you.',
  },
  'interior-hole': {
    guidance:
      'Paint the hole with the colour the form implies, or accept it: a ring, a handle or a keyhole is a see-through pixel on purpose, and the sprite composites over a scene either way.',
  },
  'thin-profile': {
    guidance:
      'Thicken the form — widen limbs, close gaps, add a pixel to the narrowest run — or give the sprite more pixels in a smaller canvas. The measurement names both compactness and thickness because either can be the cause, and only you know which.',
  },
  'shape-clipped': {
    guidance:
      'Add margin or shrink the subject until it is clear of the canvas edge. Both are real repairs and they are different pictures, so no resize was chosen for you.',
  },
  'subject-undersized': {
    guidance:
      'Scale the subject up, or crop the canvas around it. `scale_sprite` with the factor you want is one call; the factor is an art-direction decision, not a measurement.',
  },
  'fragmented-silhouette': {
    guidance:
      'Merge the pieces into one connected mass. That means moving pixels, and which piece absorbs which is a decision about what the sprite is.',
  },
  'plane-crosses-form': {
    guidance:
      'Redraw the tone plane so its boundary nests around the form instead of cutting across it. Where a hard-surface object genuinely needs a straight split, §4.2\'s curvature gate already exempted it — this one fired because it did not.',
  },
  'hue-carries-form': {
    guidance:
      'Separate the planes in value rather than in hue, so the form survives a downscale and an engine tint. Add a tone step, or move an existing one.',
  },
  'narrow-value-range': {
    guidance:
      'Widen the lightness range: a lit form needs steps far enough apart to read at half scale. Add a highlight and a shadow that are actually lighter and darker than what is there.',
  },
  'flat-value': {
    guidance:
      'One lightness bucket is holding the whole sprite, so tone is not describing the form. Break the mass into at least three value steps across the subject.',
  },
  'key-light-inconsistent': {
    guidance:
      'Pick one light direction and commit to it. This is a consistency check against a top-left key, not a correctness one, and lighting from the right is a legitimate choice.',
  },
  'shadow-crushed': {
    guidance:
      'The shadow side has run out of steps. Lift the darkest values and keep two or three readable steps between the light and the core shadow.',
  },
  'highlight-blown': {
    guidance:
      'The lit side has run out of headroom. Pull the brightest values down and keep the hottest highlight as one or two pixels rather than a region.',
  },
  'isolated-pixels': {
    noRegion:
      'The issue names no region: scattered specks have no boundary, and a bounding box around them would be the sprite, which means an op aimed at the sprite — and that is not advice. Nothing is drawn for you.',
    guidance:
      'Erase the stray pixels by hand, or run `despeckle` on the layer yourself and look at the preview before keeping it. It is a blunt instrument — §7.6 documents this dimension as the one most likely to sand a piece flat — so raise `minClusterSize` to 2–4 if the piece has deliberate texture.',
  },
  'diagonal-seam': {
    noRegion:
      'Diagonal-only contacts are scattered, so the issue names no region and none was invented.',
    guidance:
      'Add one bridging pixel where each piece touches the body only diagonally, or accept it. `despeckle` will not do this at its default `minNeighbors`, because a diagonally-touching pixel counts as a neighbour.',
  },
  'stray-colour': {
    noRegion:
      'The orphan pixels are scattered across the sprite, so the issue names no region.',
    guidance:
      'Repaint each orphan with the colour its neighbourhood implies, or accept it as texture. A pixel-level predicate cannot tell a mistake from a deliberate glint, and §7 records the one case in this repository where the machine was wrong about it.',
  },
  'single-pixel-spur': {
    noRegion:
      'Spurs are one pixel each and there may be many of them, so the issue names no region rather than bounding the whole sprite.',
    guidance:
      'Remove each one-pixel antenna by hand, or run `despeckle` on the layer and check the preview. Same caution as `isolated-pixels`: a 1px detail is indistinguishable from a speck to any threshold.',
  },
  'empty-frame': {
    noRegion:
      'The issue is about the target rather than about a place in it, so it names no region.',
    guidance:
      'There is nothing opaque to measure on this frame. Draw the frame or drop it from the tag — a blank frame exports as a hole in the sheet, whatever it scores.',
  },
  'frames-identical': {
    noRegion:
      'The issue compares whole frames, so it names no region.',
    guidance:
      'Every frame is byte-identical. If you meant to animate this, one of them was never drawn; if you meant a hold, this is fine and the advisory can be ignored.',
  },
  'silhouette-instability': {
    noRegion:
      'The issue compares whole frames, so it names no region: §4.6 measures the spread of solid area across the sequence, and a shape that changes size is not a place on any one canvas.',
    guidance:
      'No op, and this one is arithmetically impossible rather than a judgement call. §4.6 fires at an area spread above 150 per-mille, so the sprite genuinely occupies a different number of pixels on one frame than on the others — repairing it means *removing or adding pixels to a frame*, which is the drawing, not a repair. `silhouette` will name a region on its own issues (a detached piece, a hole), so if the instability is one stray mass appearing on one frame, that is the code to read and the frame to fix. Read `motion`\'s own numbers first: the spread, and which frame is the outlier. An area that grows and shrinks by a little is often a deliberate squash-and-stretch on a walk cycle and is worth keeping; an area that collapses because a frame was drawn with a limb missing is damage. Either way the correction is to redraw that frame, then re-run `evaluate` — note that fixing it can change `worstFrameWins` selection, so the number to trust afterwards is not the one you started with.',
  },
  'loop-seam-pop': {
    guidance:
      'No op. §4.6 compares the last frame back to the first, so the discontinuity is between two frames you already drew and there is no third frame to repair — the loop is either played forward or closed by changing one of the two endpoints. Read the seam pixel count and the loop duration before acting: a loop that pops because the character genuinely travels and returns is doing what a walk cycle does, and a pop on a hold or a breathing loop is damage. If it is damage, redraw the frame where the jump lands so its silhouette matches frame 0, then re-run `evaluate`.',
  },
  'loop-seam-jump': {
    guidance:
      'No op, for the same reason as `loop-seam-pop`, and read that guidance first — this code is the positional form of the same defect. The seam step is measured in pixels, so read how far it is before deciding: a one-pixel return is rounding, a two-pixel return on a 16px sprite is not. `apply_transform {dx}` on the returning frame is the mechanical answer if the offset is genuinely uniform across a loop, but a walk cycle whose stride is uneven needs its own frame redrawn.',
  },
  'frame-jitter': {
    guidance:
      'No op. This fires on an *internal* transition being much larger than the median transition, which is a claim about one frame in the middle of the sequence rather than about the two ends. Read the churn numbers: the offending transition and the median beside it. A single frame that jumps further than every other is usually a frame drawn at the wrong size or with a limb in the wrong position, and the correction is to redraw it. Be aware that a deliberate accent — a fast strike in an otherwise even cycle — looks identical to a mistake here, and §4.6 deliberately does not try to tell those apart.',
  },
  'timing-outlier': {
    guidance:
      'No op, and this is the one §4.6 code with a real op available, which is worth saying plainly. The fix is `set_frame_durations`, and it is mechanical: find the frame held far longer than the median, and decide whether that hold is the beat you wanted. A held frame at a contact point is standard animation practice; a held frame in the middle of an even stride is a typo. Read the durations array before changing anything, because one outlier among four similar frames means something different from one outlier among forty.',
  },
  'timing-mismatch': {
    noRegion:
      'The issue compares frame durations against the motion between frames, so it names no region: there is no place on the canvas where the timing is wrong.',
    guidance:
      'No op. §4.6 fires this when the frames move by uneven amounts but are held for equal time, which means the *timing* is wrong rather than the pixels, and the correction is `set_frame_durations`. Read the two numbers it reports together: the per-mille spread of the movement between frames, and the spread of the durations. Both near zero is fine. Movement uneven with durations uneven is a deliberate hold and this code stays silent by design — that is the near-miss case, not an oversight. Only uniform timing over uneven motion fires, and then the fix is to give the frame that moves least the shortest hold.',
  },
  'loop-duration-out-of-range': {
    noRegion:
      'The issue is about the whole loop\'s duration rather than a place on a canvas, so it names no region.',
    guidance:
      'No op. §4.6 checks the cycle against a window, and the correction is `set_frame_durations` on the frames that make it up. Read the reported loop duration and the window first: a cycle faster than the floor is usually too few frames for the motion rather than durations that are too long, in which case adding a frame fixes it and shortening the others does not. This is an advisory at 0.30 because loop speed is a design decision more often than it is an error.',
  },
  'outline-gap': {
    noRegion:
      'The issue names no region: the contour stops and resumes in several places around the whole silhouette, so the gaps are scattered by construction and bounding them all would be a box around the sprite.',
    guidance:
      '**No op, and here that is the point rather than a shortfall: this code is advisory by design.** §4.5 reports a gap *so it can be seen*, and the same specification says selective outlining is a good technique the craft guide recommends — dropping the contour where the light hits is the intended look, not damage. Painting the contour closed would answer a question nobody asked and would remove the choice that produced the picture. Read the numbers first (N of M boundary pixels, and the per-mille share): if the gaps track a light source they are craft and this advisory can be ignored; if they are scattered they are damage, and closing them means painting a run of ink along the silhouette yourself, which is `outline`/`draw_outline` or a `fill_rect` band, not a single op a command could name for you. The second row of this code (`outlineShare >= 600` with coverage under 30/1000) is different in kind: there the subject is barely outlined at all against a busy background, and that is worth drawing — but where the contour belongs is still your call, not the report\'s.',
  },
  'outline-inconsistent-weight': {
    guidance:
      'No op. The measurement has found contour pixels at the deepest depth and the rect names them, but *which* side should be thinned is a decision about the sprite: bring the thick quadrant down to the thin one and you have to know which is right, and the two are not equally defensible — a heavier head reads as deliberate and a heavier base reads as weight. Erase one pixel of the inner contour ring by hand, or repaint the thick side, then re-run `evaluate`: thinning a contour changes `minInkDepth`, `maxInkDepth` and the four `quadrantDepth` entries at once, so one pass can trade this code for `outline-heavy`.',
  },
  'outline-colour-split': {
    noRegion:
      'The issue is about the whole contour changing colour rather than a place on the canvas, so it names no region and none was invented.',
    guidance:
      'No op. `replace_colors {from, to}` would do the merge once you had decided it, and the decision is the whole content: which of the contour\'s colours survives, and whether the second tone was a lighting step you meant to keep. §4.5\'s trigger is `inkColours >= 4` with the fourth holding at least 5% of the ink, so read the issue\'s own count first — a contour that is dark at the top and dark-but-warmer at the bottom may be one ramp read two ways, and collapsing it would cost you that. Decide the surviving colour, then `replace_colors` followed by `prune_palette` if the loser is declared.',
  },
  'outline-heavy': {
    noRegion:
      'The issue is a count over the whole subject rather than a place on the canvas — §4.5\'s coverage row names no region — so none was invented. (The depth row of this same code does carry a rect around the deepest contour pixels, and the plan will name it.)',
    guidance:
      'No op, and the arithmetic is what says so. Both rows of this code fire on *coverage*: §4.5 measures the contour at `minInkDepth >= 3` or at `outlineCoverage >= 450/1000` of the subject. Thinning a contour means **erasing** opaque pixels, and an erased pixel is a hole — there is no `unpaint` that leaves the body colour behind, because the body colour under a contour pixel is exactly the thing that is not recorded anywhere. So the repair is a judgement about which of the dark pixels is contour and which is interior shading, painted by hand, and `replace_color` needs a `layer`, a `frame` and a `from`/`to` pair this issue does not carry. If the contour is genuinely a second material rather than a border, that is a legitimate picture and §4.5 has no opinion about it.',
  },
};

/**
 * The sentence a `rect: null` issue gets for free.
 *
 * §3.5 says `rect` is `null` "when the problem is document-wide and cannot be usefully
 * localised", and §8.2 says an issue with a whole-canvas rect when 3×3 is wrong is "a report
 * nobody can act on". So the command states the absence instead of papering over it: a caller
 * reading `rect: null` learns that the analyzer declined to localise, which is information, and
 * an invented bounding box would be a lie.
 */
const NO_REGION_DEFAULT =
  'The issue carries no rect: the defect names no region, so nothing narrower than the whole document can be pointed at and no region was invented.';

/**
 * Build the plan for one issue. Pure and exported, so the unknown-code fallback can be tested
 * against an issue no analyzer in this build can produce — §8.3 makes `code` an open string, so
 * that path is the one that matters most and the one a real report never reaches.
 */
export function planQualityFix(issue: QualityIssue, dimension: string): QualityFixPlan {
  const advice = QUALITY_FIX_ADVICE[issue.code];
  const ops = advice?.ops ?? [];
  const region =
    issue.rect === null
      ? (advice?.noRegion ?? NO_REGION_DEFAULT)
      : `The region is ${issue.rect.w}x${issue.rect.h} at (${issue.rect.x}, ${issue.rect.y}); that is the smallest area the defect was localised to.`;
  return {
    code: issue.code,
    dimension,
    severityQ: Math.round(issue.severity * 1000),
    blocking: isBlocking(issue),
    rect: issue.rect,
    fix: ops.length > 0 ? 'ops' : 'manual',
    ops,
    guidance: `${region} ${advice?.guidance ?? `No automatic repair is registered for \`${issue.code}\`; read the issue message and decide by hand, or re-run \`evaluate\` on the region you changed.`}`,
  };
}

/**
 * The plan's ops, deduplicated and ordered, ready to hand straight to `apply_ops`.
 *
 * Deduplicated because two issues routinely imply the same whole-document operation — a
 * `near-duplicate-colours` and an `off-palette` both mean `quantize_to_palette` — and running
 * it twice is wasted work in an undo stack. Ordered by command then serialised params rather
 * than by discovery order, so the same report always yields the same op list and two plans can
 * be diffed.
 */
export function dedupeQualityFixOps(ops: readonly QualityFixOp[]): QualityFixOp[] {
  const seen = new Set<string>();
  const out: QualityFixOp[] = [];
  for (const op of ops) {
    const key = `${op.command} ${JSON.stringify(op.params)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(op);
  }
  return out.sort((a, b) => {
    if (a.command !== b.command) return a.command < b.command ? -1 : 1;
    const left = JSON.stringify(a.params);
    const right = JSON.stringify(b.params);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export const fixQualityCommand = defineCommand({
  name: 'fix',
  description:
    'Turn the quality issues into a repair plan: for each issue, either the ops that fix it or what a person has to decide. Returns the ops as data and never runs them — pass them to `apply_ops` to apply, so the whole repair is one undo step and you can read the plan first. Targeting is the same as `evaluate`.',
  guide:
    '## Read this before applying anything\n\n' +
    '`plans` has one entry per issue. `fix: "ops"` means an unambiguous machine repair exists and ' +
    '`ops` holds it; `fix: "manual"` means it does not, and `guidance` says what a human has to do. ' +
    '**Nothing here has been executed.** Hand `ops` to `apply_ops` when you have read the plan — ' +
    'that is also the only route that keeps undo/redo intact.\n\n' +
    '`rect` is the region the analyzer could localise, or `null`. A `null` is a statement, not a gap: ' +
    'the defect is not about any particular pixel, and no bounding box was invented for it. Where ' +
    'that matters the `guidance` opens by saying so.\n\n' +
    '**Most codes return no ops on purpose.** Only `near-duplicate-colours`, `off-palette` and ' +
    '`muddy-mix` have a single correct machine repair today, and all three are the same call: ' +
    '`quantize_to_palette`, §7.3\'s documented mitigation for an undeclared colour. A `despeckle` ' +
    'over a cel would answer `isolated-pixels` and would equally answer "the artist meant that one ' +
    'pixel", and §7.6 documents that dimension as the one most likely to sand a piece flat. The ' +
    'four `palette` codes about colours that are *already declared* have nothing to snap, so ' +
    '`quantize_to_palette` changes 0 bytes on them and the plan says so. A fix command that ' +
    'guesses is worse than one that declines, so the rest say what a person has to decide.\n\n' +
    '`codes` narrows the plan to the codes you care about, which is what you want after fixing one ' +
    'class of defect and re-measuring. Codes this build does not know are declined with guidance ' +
    'rather than rejected: §8.3 makes `code` an open string so a minor version may add one.\n\n' +
    '`ops` at the top level is the deduplicated union of every plan\'s ops, in a stable order, ready ' +
    'to pass to `apply_ops` as-is. Applying the whole repair as one batch leaves one undo entry.',
  readOnly: true,
  params: z.object({
    ...targetShape,
    codes: z
      .array(z.string())
      .min(1)
      .optional()
      .describe(
        'Plan repairs for only these issue `code` strings, e.g. ["near-duplicate-colours"]. Omit to plan for every issue the report found.',
      ),
  }),
  apply(ctx, p) {
    const target = resolveQualityTarget(ctx.sprite, p);
    const { report, context } = runQuality(ctx.sprite, target);
    const byDimension = dimensionIndex(report);
    const wanted = p.codes === undefined ? null : new Set(p.codes);
    const plans: QualityFixPlan[] = [];
    for (const issue of everyIssue(report, context)) {
      if (wanted !== null && !wanted.has(issue.code)) continue;
      plans.push(planQualityFix(issue, byDimension.get(issue.code) ?? 'aggregator'));
    }
    return {
      frames: [...target.frames],
      tag: target.tag,
      focus: target.focus,
      plans,
      ops: dedupeQualityFixOps(plans.flatMap((plan) => plan.ops)),
      withOps: plans.filter((plan) => plan.fix === 'ops').length,
      manual: plans.filter((plan) => plan.fix === 'manual').length,
    };
  },
});

/* ------------------------------------------------------------------ *
 * T-024 the gate
 * ------------------------------------------------------------------ */

/** Which verdict the gate refuses at. */
export type QualityGateThreshold = 'fail' | 'warn';

/**
 * The gate's two settings, as data, because the threshold has to be a documented number
 * rather than a decision buried in a comparison.
 *
 * `fail` is the default and it is the honest one for an uncalibrated product. §2.1 says a gate
 * nobody has measured is a gate that blocks good work, and §6.2 has run exactly once, on one
 * sprite (§7.10), so nothing here is calibrated. `fail` refuses on things that are *named*: a
 * blocking issue with a fixed severity from Appendix A, or a measured dimension below its
 * `FLOOR_FAIL`. `warn` additionally refuses on the weighted total and on `FLOOR_WARN`, which is
 * a total-score test — the one channel where an abstention is netted against unrelated clean
 * readings, which §7 records as an open question about the aggregator. A team that has run §6 on
 * its own assets can justify that; nobody else should.
 */
export const QUALITY_GATE_THRESHOLDS: Readonly<Record<QualityGateThreshold, string>> = {
  fail: 'Refuse when the report verdict is `fail`: a blocking issue, a measured dimension below its FLOOR_FAIL, or a weighted total below SCORE_FAIL_THRESHOLD.',
  warn: 'Refuse unless the report verdict is `pass`, which additionally refuses a weighted total below SCORE_PASS_THRESHOLD or any measured dimension below FLOOR_WARN.',
};

/** Why the gate said no. One entry per named reason. */
export interface QualityGateRefusal {
  readonly kind: 'issue' | 'floor' | 'total';
  /** The dimension that owns the defect, or `'aggregator'` for one about the target itself. */
  readonly dimension: string;
  /** The issue `code`, the dimension id for a floor, or `'weighted-total'`. */
  readonly code: string;
  /**
   * Where the defect is, in absolute canvas coordinates, or `null` when it names none.
   *
   * Carried because a multi-frame target reports the same code more than once — one entry per
   * frame — and a refusal message that printed the code twice with no location would read as one
   * defect listed twice.
   */
  readonly rect: Rect | null;
  /** The measured value in per-mille: a severity, a dimension score, or the weighted total. */
  readonly measuredQ: number;
  /** The published threshold it failed, in per-mille. */
  readonly thresholdQ: number;
  readonly message: string;
}

/**
 * One gate decision.
 *
 * `measured` is the field that keeps "failed" and "not applicable" apart. A target where no
 * dimension applied at all totals 0, which §5.2 records as `fail` precisely because 0 is the
 * only way a required number can say "nothing was measured" — and a gate that refused on that
 * would be refusing on an *absence*, which is the fake-defect failure this whole pipeline
 * exists to prevent. So the gate declines, and says that it declined.
 */
export interface QualityGateDecision {
  readonly passed: boolean;
  readonly threshold: QualityGateThreshold;
  /** False when no dimension applied, so nothing could be measured and nothing failed. */
  readonly measured: boolean;
  readonly verdict: QualityReport['verdict'];
  readonly refusals: readonly QualityGateRefusal[];
  /** The dimensions that did not apply and why. Carried so an abstention is never read as a defect. */
  readonly notApplicable: Readonly<Partial<Record<QualityDimensionId, ExcludedReason>>>;
}

/**
 * The gate itself: report in, decision out. Pure, so `finalize_document` can call it before it
 * writes anything and so a test can hand it a hand-built report.
 *
 * The contract this is written to is deliberately narrow, and it is worth stating as an
 * equation because it is what makes the gate safe to wire into a delivery path:
 *
 * > `passed === (report.verdict === 'pass')` at `threshold: "warn"`, and
 * > `passed === (report.verdict !== "fail")` at `threshold: "fail"`.
 *
 * The refusal list is therefore not a second opinion on the verdict — it is the verdict's own
 * definition (§5.3) decomposed into the named reasons behind it, so every refusal can say which
 * code and which measured number. There is no channel here that can refuse for a reason the
 * verdict does not already hold, and in particular **no channel that can refuse because a
 * dimension was excluded**: `verdictFor` scores present dimensions only, and this mirrors it.
 *
 * Ordering is the aggregator's (`report.blocking` is already severity-descending, code-ascending),
 * then floors in `QUALITY_DIMENSIONS` order, then the total, so two runs on one document produce
 * the same list.
 */
export function qualityGate(
  report: QualityReport,
  options: { threshold?: QualityGateThreshold } = {},
): QualityGateDecision {
  const threshold = options.threshold ?? 'fail';
  const notApplicable = { ...report.excluded };
  const measured = QUALITY_DIMENSIONS.some((id) => report.dimensions[id] !== undefined);
  if (!measured) {
    return { passed: true, threshold, measured: false, verdict: report.verdict, refusals: [], notApplicable };
  }

  const refusals: QualityGateRefusal[] = [];
  const byDimension = dimensionIndex(report);
  for (const issue of report.blocking) {
    // Re-checked rather than trusted, for the same reason `verdictFor` re-checks: a caller that
    // hands this function an unfiltered list would otherwise have every advisory become a refusal,
    // and the equality `passed === (verdict !== 'fail')` is the property a delivery path is built
    // on. The aggregator does filter, so this costs one comparison and closes the second door.
    if (!isBlocking(issue)) continue;
    refusals.push({
      kind: 'issue',
      dimension: byDimension.get(issue.code) ?? 'aggregator',
      code: issue.code,
      rect: issue.rect ?? null,
      measuredQ: Math.round(issue.severity * 1000),
      thresholdQ: Math.round(SEVERITY_BLOCKING * 1000),
      message: issue.message,
    });
  }

  const totalFloorQ = threshold === 'fail' ? SCORE_FAIL_THRESHOLD : SCORE_PASS_THRESHOLD;
  for (const id of QUALITY_DIMENSIONS) {
    const dimension = report.dimensions[id];
    if (dimension === undefined) continue;
    // One floor per dimension per setting: at `warn` the 600 floor subsumes the 400 one, so a
    // dimension that fails both is refused once, at the threshold that actually applied.
    const floorQ = threshold === 'fail' ? FLOOR_FAIL[id] : FLOOR_WARN;
    if (!isBelow(dimension.scoreQ, floorQ)) continue;
    refusals.push({
      kind: 'floor',
      dimension: id,
      code: id,
      rect: null,
      measuredQ: dimension.scoreQ,
      thresholdQ: floorQ,
      message: dimension.verdict,
    });
  }

  // §5.2's formula, from its one home. The gate needs the *integer*, because
  // `QualityReport` carries only the serialised float and a refusal has to name the number it
  // measured against. §3.6 warns against re-deriving `totalQ` from `score`, and this is not
  // that — multiplying a rounded wire value by 1000 is exactly the float arithmetic the
  // per-mille discipline exists to avoid. Calling the aggregator's own function rather than
  // keeping a copy is what makes the agreement structural instead of a test's job.
  //
  // **The profile is taken from the report, never re-derived here.** The gate and the report
  // must be talking about the same number, and re-deriving the class from a context this
  // function does not hold would be a second place for the two to disagree.
  const totalQ = weightedTotalQ(report.dimensions, weightsFor(report.assetClass.cls));
  if (isBelow(totalQ, totalFloorQ)) {
    refusals.push({
      kind: 'total',
      dimension: 'aggregator',
      code: 'weighted-total',
      rect: null,
      measuredQ: totalQ,
      thresholdQ: totalFloorQ,
      message:
        'the weighted total mixes every dimension that applied, so read `evaluate` for the per-dimension readings before deciding what this is pointing at.',
    });
  }

  return {
    passed: refusals.length === 0,
    threshold,
    measured: true,
    verdict: report.verdict,
    refusals,
    notApplicable,
  };
}

/** How many reasons the refusal message names before it counts the rest. */
const NAMED_REFUSALS = 3;
/** How much of an issue's own prose survives into the refusal message. */
const ISSUE_CLIP = 120;
/**
 * Upper bound on the assembled message, which travels as a tool-error string.
 *
 * 560 rather than something tighter, because the trade here is *named reasons against prose*: at
 * 420 the third named reason was being clipped off a three-reason refusal, and a refusal that says
 * "here are two of your four defects" is a worse answer than one that is a paragraph long. The
 * analyzer's own sentence is what gives way — each reason is clipped to {@link ISSUE_CLIP} and the
 * code and the per-mille number are never clipped.
 */
const REFUSAL_MESSAGE_BUDGET = 560;
/** The tail, budgeted before the body rather than after: an action is never the thing that is cut. */
const REFUSAL_TAIL =
  'Fix the named defects and re-run, or re-run with `bypass: true` and a reason.';

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/** Where a refusal is, in the form the whole command surface uses for a region. */
function whereOf(rect: Rect | null): string {
  return rect === null ? '' : ` (${rect.x},${rect.y} ${rect.w}x${rect.h})`;
}

/** One refusal as a line of prose: the code, the measured number and the threshold it failed. */
function refusalLine(refusal: QualityGateRefusal): string {
  if (refusal.kind === 'issue') {
    // The analyzer's sentence already ends in a full stop; keeping it would read as `.).`.
    const prose = clip(refusal.message.replace(/[.\s]+$/, ''), ISSUE_CLIP);
    return `${refusal.code}${whereOf(refusal.rect)} at ${refusal.measuredQ}/1000 against ${refusal.thresholdQ}/1000 in ${refusal.dimension} (${prose})`;
  }
  if (refusal.kind === 'floor') {
    return `${refusal.dimension} at ${refusal.measuredQ}/1000 against its floor ${refusal.thresholdQ}/1000`;
  }
  return `${refusal.code} at ${refusal.measuredQ}/1000 against ${refusal.thresholdQ}/1000, mixing every dimension that applied`;
}

/**
 * The refusal message, named code and measured number first.
 *
 * A refusal an agent cannot act on is indistinguishable from a broken tool, so the code and the
 * per-mille number lead and the analyzer's own prose is clipped behind them. The count of the
 * rest is kept rather than dropped: "and 2 more" is actionable, a silent truncation is not.
 */
export function qualityGateRefusalMessage(decision: QualityGateDecision): string {
  const prefix = `quality gate refused (threshold \`${decision.threshold}\`): `;
  const named = decision.refusals.slice(0, NAMED_REFUSALS).map(refusalLine);
  const extra = decision.refusals.length - named.length;
  const count = extra > 0 ? ` (+${extra} more)` : '';
  // The body is what gets clipped, never the tail. A refusal whose actionable sentence was cut off
  // to make room for more reasons is a worse refusal than one that named fewer of them.
  //
  // **The count is budgeted BEFORE the body, not concatenated onto it and clipped with it.** It used
  // to be appended first and then clipped as part of the same string, which meant a decision whose
  // named refusals ran long lost the count entirely — and this function's own docstring says the
  // count is kept rather than dropped, because "+4 more" is actionable and a silent truncation is
  // not. §4.6 registering `motion` added a fourth blocking refusal to
  // `motion/worst-frame-wins-16` and exposed it: three long prose refusals fill the budget, and the
  // message silently named three of seven. A stated guarantee the code does not keep is the same
  // defect class as a threshold that fires on the wrong side of its own unit.
  const room = Math.max(
    0,
    REFUSAL_MESSAGE_BUDGET - prefix.length - REFUSAL_TAIL.length - 2 - count.length,
  );
  const body = clip(named.join('; '), room) + count;
  return `${prefix}${body}. ${REFUSAL_TAIL}`;
}

/** The sentence a delivery path embeds when the gate was bypassed. Loud on purpose. */
export function qualityGateBypassNotice(decision: QualityGateDecision, reason: string): string {
  const reasons = decision.refusals
    .slice(0, NAMED_REFUSALS)
    .map(
      (refusal) =>
        `${refusal.code}${whereOf(refusal.rect)} ${refusal.measuredQ}/1000 vs ${refusal.thresholdQ}/1000`,
    );
  const extra = decision.refusals.length - reasons.length;
  return clip(
    `QUALITY GATE BYPASSED: this asset does not meet the quality gate (${reasons.join('; ')}` +
      `${extra > 0 ? ` +${extra} more` : ''}) and was released anyway. Reason given: ${reason}`,
    REFUSAL_MESSAGE_BUDGET,
  );
}

/** A report plus the decision taken on it, for a delivery path that needs both. */
export interface QualityGateRun {
  readonly target: QualityTarget;
  readonly report: QualityReport;
  readonly decision: QualityGateDecision;
}

export interface QualityGateOptions {
  /**
   * The same three ways of naming the target `evaluate` takes, on the same terms: a delivery
   * path gates the same frames it measured. Not repeating them here would mean the gate could
   * be pointed at a different document from the one an artist reviewed.
   */
  readonly tag?: string | number;
  readonly frames?: readonly FrameRef[];
  readonly focus?: Rect;
  readonly threshold?: QualityGateThreshold;
  /**
   * Which §5.2 weight profile to score under. Omit to derive it; see `deriveAssetClass`.
   *
   * Here for the same reason `verify` takes it: the decision contains a total, and a delivery
   * path that scored the report under one profile and gated it under another would be refusing
   * against a number the caller never saw.
   */
  readonly assetClass?: QualityAssetClass;
  /** Release a failing asset anyway. The result says so; it never passes silently. */
  readonly bypass?: boolean;
  /** Required with `bypass`, and required to be a reason a person can read. */
  readonly bypassReason?: string;
}

/**
 * Measure a document and take the gate decision on it.
 *
 * This is the hook `finalize_document` calls *before* it writes anything. It is a function and
 * not the `verify` command because a session tool holds a `Sprite` rather than a `Draft`, and
 * because a delivery path needs the report and the decision together — the decision to decide,
 * the report to put in front of whoever asked for the bypass.
 */
export function qualityGateForSprite(sprite: Sprite, options: QualityGateOptions = {}): QualityGateRun {
  const target = resolveQualityTarget(sprite, options);
  const { report } = runQuality(sprite, target, options.assetClass);
  return { target, report, decision: qualityGate(report, { threshold: options.threshold }) };
}

/**
 * Refuse, loudly, with a code an agent can branch on.
 *
 * Throws `command_failed` because the gate did not reject the *arguments* and did not fail to
 * find anything — the document said no, which is the one of the four codes that means "the
 * operation was rejected". The decision rides along in `details` so a caller that caught the
 * error does not have to re-measure to find out why.
 *
 * `bypass` returns the decision instead of throwing, and it never turns `passed` into `true`:
 * the asset is still failing, and anything reading the result can see that it was released
 * anyway.
 */
export function assertFinalizable(sprite: Sprite, options: QualityGateOptions = {}): QualityGateRun {
  if (options.bypass && (options.bypassReason ?? '').trim().length === 0) {
    throw new CommandError(
      'A quality-gate bypass requires `bypassReason`: the refusal has to be attributable to a person.',
      'invalid_params',
    );
  }
  const run = qualityGateForSprite(sprite, options);
  if (!run.decision.passed && !options.bypass) {
    throw new CommandError(qualityGateRefusalMessage(run.decision), 'command_failed', run.decision);
  }
  return run;
}

/** The gate, as a command: the same decision, reachable without writing a call site. */
export const verifyQualityCommand = defineCommand({
  name: 'verify',
  description:
    'The delivery gate. Measures the document and refuses — as an error naming the failing code and its measured number — when the report verdict is at or below the threshold. `threshold: "fail"` (default) refuses named defects and measured dimensions below their floor; `"warn"` also refuses anything that is not a pass. An excluded dimension never refuses. `bypass: true` with a `bypassReason` releases a failing asset and says so in the result.',
  guide:
    '## What refuses and what does not\n\n' +
    '`threshold: "fail"` (default) refuses on **named defects only**: an issue at or above 500/1000 ' +
    'severity, or a *measured* dimension below its `FLOOR_FAIL`. `threshold: "warn"` additionally ' +
    'refuses a measured dimension below `FLOOR_WARN` and a weighted total below ' +
    '`SCORE_PASS_THRESHOLD` — the total-score channel, which §2.1 says needs a team that has run ' +
    '§6 on its own assets before it is switched on.\n\n' +
    '**An excluded dimension never refuses.** A full-bleed scene has no subject, `silhouette` is ' +
    'excluded with `no-subject`, and that is a fact about the document rather than a defect. A ' +
    'target where *nothing* applied totals 0 — §5.2 records that as `fail` only because 0 is the ' +
    'only way a required number can say "nothing was measured" — and the gate still passes it, ' +
    'because refusing on an absence is the fake-defect failure the whole pipeline exists to ' +
    'prevent. `measured: false` in the result is how it says so.\n\n' +
    '## The bypass\n\n' +
    '`bypass: true` requires `bypassReason` and releases the asset without making it pass. The ' +
    'result carries `bypassed: true`, the reason, and a `notice` string stating that the asset ' +
    'does not meet the gate and was released anyway — put that string in your delivery result. ' +
    'The escape hatch is deliberately loud: an agent will otherwise reach for it silently, and a ' +
    'gate that can be turned off without a trace is not a gate.\n\n' +
    '## Wiring this into a delivery path\n\n' +
    'This command throws, so a caller that treats a failed command as a failed write is correct ' +
    'by construction. If you are building one, prefer `assertFinalizable(sprite, options)` from ' +
    '`@pixel/core`: it measures, refuses with the same message, and returns the report alongside ' +
    'the decision so you can show both to whoever asked for the bypass.\n\n' +
    '## No score to climb\n\n' +
    'The gate refuses on named defects and named floors. It does not report how far from passing ' +
    'anything is, does not grade the artwork, and does not publish a number that could become a ' +
    'target — `docs/EVALUATION.md` §3 deleted a `quality_report` tool for exactly that reason and ' +
    'this command is written so that it cannot become the next one.',
  readOnly: true,
  params: z
    .object({
      ...targetShape,
      ...assetClassShape,
      threshold: z
        .enum(['fail', 'warn'])
        .optional()
        .describe(
          'Which verdict refuses: `fail` (default, named defects and measured dimensions below their floor) or `warn` (also anything that is not a pass, which is a total-score test).',
        ),
      bypass: z
        .boolean()
        .optional()
        .describe(
          'Release a failing asset anyway instead of refusing. Does not make it pass, and the result says it was bypassed. Requires `bypassReason`.',
        ),
      bypassReason: z
        .string()
        .optional()
        .describe(
          'Why the gate is being bypassed, in words a person can read. Required with `bypass: true` and echoed in the result so the refusal is attributable.',
        ),
    })
    // The `bypass`/`bypassReason` pairing is checked in the schema rather than in `apply` for one
    // reason: `applyCommandWithSummary` re-codes anything thrown inside `apply` to
    // `command_failed`, so a pairing violation raised there tells an agent the *document* refused
    // when the truth is that its arguments were incomplete. `.check()` keeps the node a
    // `ZodObject`, which `defineCommand` needs in order to apply `.strict()`; `.refine()` would
    // return a `ZodEffects` and take `.strict()` with it.
    .check((ctx) => {
      if (ctx.value.bypass !== true) return;
      if ((ctx.value.bypassReason ?? '').trim().length > 0) return;
      ctx.issues.push({
        code: 'custom',
        path: ['bypassReason'],
        input: ctx.value.bypassReason,
        message: 'required with `bypass: true`: a gate refusal has to be attributable to a person',
      });
    }),
  apply(ctx, p): CommandSummary {
    const threshold = p.threshold ?? 'fail';
    const bypass = p.bypass === true;
    const target = resolveQualityTarget(ctx.sprite, p);
    const { report } = runQuality(ctx.sprite, target, p.assetClass);
    const decision = qualityGate(report, { threshold });

    const summary: CommandSummary = {
      passed: decision.passed,
      measured: decision.measured,
      threshold: decision.threshold,
      verdict: decision.verdict,
      frames: [...target.frames],
      tag: target.tag,
      focus: target.focus,
      // Which weight profile the refusal's total was measured under, and who chose it.
      assetClass: { ...report.assetClass },
      refusals: decision.refusals,
      // The dimensions that did not apply, in the same result as the ones that refused, so an
      // abstention can never be read as a defect by a caller skimming for the verdict.
      notApplicable: decision.notApplicable,
      dimensions: Object.fromEntries(
        QUALITY_DIMENSIONS.filter((id) => report.dimensions[id] !== undefined).map((id) => [
          id,
          { scoreQ: report.dimensions[id]!.scoreQ, verdict: report.dimensions[id]!.verdict },
        ]),
      ),
    };

    if (!decision.passed && !bypass) {
      throw new CommandError(qualityGateRefusalMessage(decision), 'command_failed', decision);
    }
    if (!decision.passed && bypass) {
      // Loud, and loud in three places: a boolean, the reason, and a sentence to embed in the
      // caller's own delivery result.
      summary.bypassed = true;
      summary.bypassReason = p.bypassReason;
      summary.notice = qualityGateBypassNotice(decision, p.bypassReason!);
    }
    return summary;
  },
});

/** The three commands, in the order a caller reaches for them: measure, plan, gate. */
export const qualityCommands = [
  evaluateQualityCommand,
  fixQualityCommand,
  verifyQualityCommand,
] as const;