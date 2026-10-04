/**
 * The MCP face of the quality pipeline.
 *
 * `packages/core/src/quality` owns what a score *means* and how it is computed. This
 * module owns the two things only the server can get wrong: **which frames were
 * measured**, and **how the report is worded so a reader cannot mistake it for a
 * target**.
 *
 * ## One implementation, two channels
 *
 * The `evaluate` tool and the `pixel://quality/{doc}` resource both call
 * {@link qualityPayload}. That is not tidiness - it is the only way to guarantee the
 * two channels cannot return different numbers for the same document, and it makes
 * the resource literally the tool's answer rather than a second rendering of it. The
 * same byte string comes back whether it was fetched with a tool call or read from a
 * URI.
 *
 * ## Why the wording here is load-bearing
 *
 * A `quality_report` tool existed once and was deleted in 0.3.1: a model told the
 * number was "clean" sanded a lake into a dark flat rectangle. Any score an agent can
 * see becomes the target instead of the artwork, which is Goodhart's law arriving on
 * schedule. So this module ships the numbers *and* the words that keep them honest:
 *
 *   - {@link HOW_TO_READ} in every single response, not only in the tool description,
 *     because a client can read the resource without ever seeing the tool list;
 *   - one `notes` entry per exclusion, saying what the absence means and that the
 *     artwork is neither credited nor blamed for it;
 *   - the flat {@link QualityIndexEntry} `issues` list, which **names a defect and
 *     its canvas rect**, preferred over any restatement of the total;
 *   - and no letter, grade, percentage, band name or summary sentence anywhere. There
 *     is deliberately no code path in this file that can emit "quality: 82%".
 *
 * The other rule from that failure lives in the *shape* rather than in the prose.
 * {@link QualityReport.excluded} ("this dimension did not apply") and
 * {@link QualityDimension.unmeasured} ("this one was measured, and here is the
 * sub-score it could not measure") are carried through untouched and re-surfaced as
 * two separate lists. Collapsing them is how a dimension that half-measured itself
 * ended up reporting a confident perfect mark for the half nobody looked at - the
 * failure this repository has already paid for once.
 *
 * ## Determinism
 *
 * Every field here is derived from the document: no clock, no randomness, no
 * hash-order iteration. Key order follows {@link QUALITY_DIMENSIONS}, and the issue
 * list is sorted by severity descending then code ascending then rect, matching the
 * aggregator's own rule, so the same document always serialises to the same bytes.
 * That is what makes `pixel://quality/{doc}` diffable and the reason nothing here may
 * ever gain a timestamp.
 */
import {
  aggregatorIssues,
  animationSequence,
  createQualityContext,
  evaluate,
  projectAbsences,
  projectIssues,
  QUALITY_DIMENSIONS,
  QUALITY_WEIGHT_PROFILES,
  rectSchema,
  resolveFrame,
  type ExcludedReason,
  type ProjectedIssue,
  type QualityAssetClass,
  type QualityDimensionId,
  type QualityReport,
  type Rect,
  type Sprite,
} from '@pixel/core';
import { z } from 'zod';

/**
 * The paragraph that ships with every report, whatever channel it came through.
 *
 * Deliberately fixed text rather than something derived from the numbers. It has to
 * say the same thing on a clean report and a disastrous one, because the failure this
 * guards against is an agent that reads the number first and the framing second - or
 * never, if it fetched the resource instead of the tool.
 */
export const HOW_TO_READ =
  'These numbers are diagnostics for finding defects, not a target to raise. ' +
  '`verdict` is the delivery gate and nothing more: `pass` means no blocking defect was found, not that the art is good. ' +
  'Work the `issues` list - each one names a defect and the canvas rect of it - and look at the picture with get_preview. ' +
  'Do not edit in order to move the total; a clean-up pass that sands a piece flat has not improved it, and the dimensions ' +
  'score several arguable conventions (4-connected silhouettes, top-left key light, holes are defects, 1px outlines) that a ' +
  'good artist is entitled to disagree with. See pixel://quality/{doc} for the same report as a resource.';

/** What the tool and the resource agree to pass in. */
export interface QualityTargetOptions {
  /** One frame, by id or 0-based index. Mutually exclusive with `tag`. */
  readonly frame?: number | string;
  /** An animation tag by name, id or index, expanded into playback order. */
  readonly tag?: string | number;
  /**
   * A region to *scope* the report to - it narrows which defects you are told about.
   *
   * Not a crop: every quantity is still measured over the whole canvas, because a
   * mask cut along a straight line acquires a straight edge that reads as a defect.
   * See `QualityContext.focus`.
   */
  readonly rect?: Rect;
  /**
   * Which §5.2 weight profile to score under. Omit to derive it.
   *
   * Derived: a sequence with measurable motion is `animation`, otherwise a canvas over 16384px
   * is `scene` and the rest is `sprite`. State it when you are judging one frame of an
   * animation — that pass is a still sequence and the derived answer is `sprite`, while the
   * asset is not. **Not yet exposed as a tool argument** (see the module note): it is on the
   * payload so the report is self-describing either way.
   */
  readonly assetClass?: QualityAssetClass;
  /** Ceiling on the flat `issues` list. Defaults to 40; blocking issues are never dropped. */
  readonly maxIssues?: number;
  /** Identity of the document, so the payload is self-describing on both channels. */
  readonly document?: { readonly id: string; readonly name: string; readonly version: number };
}

/**
 * One issue, flattened and attributed.
 *
 * **Declared in core** (`projectIssues`), because `packages/core/src/commands/share.ts` projects
 * the same list onto a share card, and two walkers over one report is two answers to "which
 * defects are there". This alias keeps one name for the shape in this module; the *policy* - which
 * fields may travel - stays per surface, and the share card drops `severity` because a file that
 * gets forwarded is the wrong place for a number.
 */
export type QualityIndexEntry = ProjectedIssue;

/** A sub-score a dimension could not measure, flattened out of its `unmeasured` map. */
export interface UnmeasuredSubScore {
  readonly dimension: QualityDimensionId;
  /** The sub-score name, e.g. `form` for §4.2's form term. */
  readonly subScore: string;
  readonly reason: ExcludedReason;
}

/** What each absence means, keyed by the closed {@link ExcludedReason} enum. */
const ABSENCE_NOTES: Record<ExcludedReason, string> = {
  'single-frame':
    'the evaluated sequence is one frame, so there is nothing to measure. The artwork is neither credited nor penalised for it.',
  'no-motion-content':
    'every evaluated frame is byte-identical, so there is nothing to measure. The `frames-identical` issue says whether that was probably a mistake.',
  'no-subject':
    'the ink reaches all four canvas edges, so there is no subject reading against a background and no shape to measure. `value` and `palette`/`noise` still apply to a scene.',
  'no-outline':
    'the artwork declares no contour, so there is no outline to judge, and the dimension is abstained rather than scored. This is a style choice, not a defect: plenty of good sprites have no outline, so no number is claimed for it and its weight leaves the average. The other dimensions still apply.',
  'no-judgeable-plane':
    'no tone-plane boundary met its preconditions, so this sub-score declines to judge. The artwork did nothing wrong.',
  'line-sprite':
    'the subject is a 1px line drawing, so these neighbour measures have nothing to measure. The other sub-scores of this dimension were still scored.',
  'not-implemented':
    'no analyzer for this dimension is registered in this build. That is a fact about the build, not about the artwork, and no number is claimed for it.',
};

const DEFAULT_MAX_ISSUES = 40;
const MAX_ISSUES_CEILING = 500;

/**
 * A defect, as it appears on the flat `issues` list - the one the reader works from.
 *
 * Declared once and used once. The same four fields also appear inside `report`, but
 * that copy is a verbatim passthrough of the aggregator's own record rather than the
 * actionable view, and documenting a shape three times over cost 1.4KB of the surface
 * budget for a document the tool-surface test would not notice.
 *
 * `rect` is absolute canvas coordinates or `null` when the defect is not localisable -
 * a palette-wide discipline problem, say. Absolute rather than relative to
 * `target.focus` because a `fix` op addresses canvas pixels, and an issue that meant
 * "here" relative to a focus rect would send the edit somewhere else entirely.
 *
 * **Loose, not strict**, and that is load-bearing rather than lazy: the SDK validates
 * `structuredContent` against this schema, so a strict shape would *reject* the very
 * response it describes the moment an entry carried the two extra fields the array's
 * description promises. A schema that fails its own output is worse than no schema.
 */
const qualityIssueSchema = z.looseObject({
  code: z.string().describe('Stable code, e.g. `shape-fragmented`. Branch on this, never on `message`.'),
  message: z.string().describe('Human-readable explanation. Read it; do not parse it.'),
  severity: z.number().describe('0..1. At or above 0.5 it blocks delivery.'),
  rect: rectSchema.nullable().describe('Where to fix it, in absolute canvas pixels, or null when it is not localisable.'),
});

/**
 * The tool's declared output.
 *
 * Defaults to the shared result envelope, which is a true statement but a useless one
 * here: the whole design of this payload is that `excluded` and `unmeasured` are two
 * *different claims*, and the envelope names neither of them. A reader holding only the
 * envelope cannot tell what was measured from what was skipped - which is the
 * distinction the whole applicability mechanism exists to carry.
 *
 * Kept lean on purpose, and not by accident. This schema is advertised once per tool in
 * the context of every session's every request; a first draft that typed out every field
 * cost 9.4KB, which is 2.4K tokens a session for prose nobody reads twice. What is
 * declared is the part that changes a decision - which dimensions applied, which did
 * not, why, and what to fix. Everything else is described on the response itself.
 */
export const QUALITY_OUTPUT_SCHEMA = z.looseObject({
  ok: z.literal(true).describe('True on success; a failed call returns isError with `error` and `code`.'),
  kind: z.literal('quality-report').describe('Identifies this shape, so a caller need not read the tool name.'),
  howToRead: z.string().describe('Fixed text: the scores are diagnostics for finding defects, not a target to raise. Always present.'),
  document: z
    .looseObject({})
    .optional()
    .describe('The measured document: `{id, name, version}`.'),
  target: z
    .looseObject({})
    .describe(
      'What was measured: `{source: "all-frames"|"frame"|"tag", tag, frames, frameCount, canvasFrameCount, focus, note?}`. Read `source` before `verdict` - a one-frame report is a statement about that frame only.',
    ),
  report: z
    .looseObject({
      dimensions: z
        .record(
          z.string(),
          z.looseObject({
            scoreQ: z.number().describe('Per-mille 0..1000, higher better. A diagnostic, not a goal.'),
            unmeasured: z
              .record(z.string(), z.string())
              .describe('Sub-scores this dimension could not measure, and why, e.g. {"form":"no-judgeable-plane"}. Non-empty means the score covers only part of the dimension, re-normalised over what it did measure - never silently absent.'),
          }),
        )
        .describe('One entry per dimension that WAS measured, each with a one-sentence `verdict` and its `issues`. A **missing key means the dimension did not apply** - never a zero, which anything that averaged the field would silently swallow.'),
      excluded: z
        .record(z.string(), z.string())
        .describe('Why each absent dimension is absent. These keys are exactly the ids missing from `dimensions`, and no id is in both. `single-frame`/`no-subject`/`no-motion-content` describe the document; `not-implemented` describes this build, not the artwork.'),
      score: z.number().describe('Weighted mean of the measured dimensions, 0..1. Diagnostics only - a higher number is not a better picture, and a target nothing could measure reports 0.00 rather than 1.00.'),
      assetClass: z
        .looseObject({})
        .describe(
          'Which §5.2 weight profile weighted `score`: `{cls: "sprite"|"animation"|"scene", source: "derived"|"explicit"}`, where `explicit` means the caller named the class and `derived` means the aggregator inferred it from the frames and the canvas size. Two totals under different classes are different claims and are not comparable - read this before comparing a number to another one.',
        ),
      verdict: z
        .enum(['pass', 'warn', 'fail'])
        .describe("The delivery gate, not a rating: 'pass' means no blocking defect was found, nothing more. `blocking` lists them."),
    })
    .describe('The report verbatim: `{dimensions, excluded, score, verdict, blocking}`. `dimensions` and `excluded` together account for every dimension id.'),
  issues: z
    .array(qualityIssueSchema)
    .describe(
      'Every defect, deduplicated by (code, rect) and sorted by severity descending, so blocking ones come first and `maxIssues` never drops one. Each entry also carries `dimensions` (which measurements agreed; empty means the aggregator raised it) and `blocking`. Work this list, not the total.',
    ),
  issueCount: z.number().describe('Issues that exist, including any `issuesTruncated` did not show.'),
  issuesTruncated: z.boolean().describe('True when `issues` is shorter than `issueCount`. Only ever truncates advisories.'),
  // The same `{cls, source}` block, and the same warning about comparing two totals
  // weighted differently, is on `report.assetClass` above. Repeating it here cost ~330
  // bytes of every request in every session to say one thing twice, and the copy that
  // survives is the first one, which is the one a reader reaches first.
  assetClass: z
    .looseObject({})
    .describe('Copy of `report.assetClass`, so the class is readable without walking the report.'),
  unmeasured: z
    .array(z.looseObject({}))
    .describe('`{dimension, subScore, reason}` per sub-score a measured dimension could not reach. Distinct from `report.excluded`, which is about whole dimensions: "measured, and here is the part it could not measure" is not "did not apply".'),
  measuredDimensions: z.array(z.string()).describe('Ids carrying a score, in pipeline order. Everything else is in `excludedDimensions`.'),
  excludedDimensions: z.record(z.string(), z.string()).describe('Copy of `report.excluded`, so applicability is readable without walking the report.'),
  notes: z.array(z.string()).describe('Facts about the measurement a reader could otherwise get wrong - what each absence means. Never a summary of quality.'),
});

/**
 * The `unmeasured` maps, flattened, so a partly-measured dimension is legible on its own.
 *
 * The walk is {@link projectAbsences}'s - core's, and the share card's - with the whole-dimension
 * entries filtered off, because this list is specifically about the second claim. `excluded` is
 * published separately on the payload and must not be folded in here: "did not apply" and
 * "measured everything except this" are different, and collapsing them is how a dimension that
 * half-measured itself ended up reporting a confident perfect mark.
 */
function unmeasuredSubScores(report: QualityReport): UnmeasuredSubScore[] {
  return projectAbsences(report)
    .filter((absence) => absence.subScore !== null)
    .map((absence) => ({
      dimension: absence.dimension,
      subScore: absence.subScore as string,
      reason: absence.reason,
    }));
}

/**
 * Everything the reader could otherwise mistake, said out loud.
 *
 * Each entry is a *fact about the measurement*, never a summary of quality - a note
 * that said "the sprite is quite good" would be exactly the verdict this product
 * refuses to publish.
 */
function reportNotes(report: QualityReport): string[] {
  const notes: string[] = [];
  const measured = Object.keys(report.dimensions).length;

  // Which profile weighted the total. Said once, as a fact about the measurement, and said
  // **always** rather than only for the non-default classes: `sprite` is the answer a reader
  // most needs to have confirmed, because it is the one that makes this number comparable with
  // the numbers they have seen before. It is a weight table, not a grade, so it does not read
  // as a target.
  notes.push(
    `\`score\` is a weighted mean over the ${QUALITY_WEIGHT_PROFILES[report.assetClass.cls].cls} ` +
      `profile's weights (${report.assetClass.source}, ${
        report.assetClass.source === 'derived'
          ? 'no asset class was given, so it was derived from the frames and the canvas size'
          : 'the caller named the asset class'
      }). A total is not comparable across profiles, and the weights are chosen numbers under ` +
      'review rather than measured ones - see docs/EVALUATION.md 5.2.',
  );

  if (measured === 0) {
    notes.push(
      'No dimension could measure this target, so `score` is 0.00. That means "nothing was measured", not "bad artwork" - read `excluded` for the reason behind each dimension.',
    );
  }
  // One note per absence, from the shared walk (`projectAbsences`) rather than a second walk over
  // `report.excluded` and a second over `unmeasured`. **Whole dimensions first, then sub-scores**,
  // which is the order this list has always had: the two are different claims and the reader
  // meets "this did not apply" before "this half was not taken".
  const absences = projectAbsences(report);
  for (const { dimension, reason } of absences.filter((absence) => absence.subScore === null)) {
    notes.push(`\`${dimension}\` was not measured: ${ABSENCE_NOTES[reason]}`);
  }
  for (const { dimension, subScore, reason } of absences.filter((absence) => absence.subScore !== null)) {
    notes.push(`\`${dimension}.${subScore}\` was not measured: ${ABSENCE_NOTES[reason]}`);
  }
  const notImplemented = QUALITY_DIMENSIONS.filter((id) => report.excluded[id] === 'not-implemented').length;
  if (notImplemented > 0 && measured > 0) {
    notes.push(
      `This build measures ${measured} of the ${QUALITY_DIMENSIONS.length} dimensions and declines to score the other ${notImplemented}. The total is a weighted mean over what was measured, so it is not comparable with a report from a build that measures more.`,
    );
  }
  return notes;
}

/** Reject a focus rect the canvas cannot honour, with the numbers that would have worked. */
function assertFocusInsideCanvas(sprite: Sprite, focus: Rect): void {
  const inside =
    focus.w >= 1 &&
    focus.h >= 1 &&
    focus.x >= 0 &&
    focus.y >= 0 &&
    focus.x + focus.w <= sprite.width &&
    focus.y + focus.h <= sprite.height;
  if (inside) return;
  throw new Error(
    `Focus rect {x:${focus.x}, y:${focus.y}, w:${focus.w}, h:${focus.h}} does not fit a ${sprite.width}x${sprite.height} canvas. A focus rect scopes which defects you are told about; it does not crop, so it has to be inside the canvas.`,
  );
}

/**
 * Measure a document and return the wire payload, verbatim, for both channels.
 *
 * Three targets, and the difference between them is the difference between "this
 * sprite is good" and "this frame is good": no arguments measures every frame once in
 * document order, `frame` measures one, and `tag` measures a loop in playback order.
 * §7.7 is explicit that a per-frame pass is a statement about that frame, so `target`
 * always says which of the three produced it.
 */
export function qualityPayload(sprite: Sprite, options: QualityTargetOptions = {}): Record<string, unknown> {
  if (options.frame !== undefined && options.tag !== undefined) {
    throw new Error('Pass either `frame` or `tag`, not both: they name different sets of frames.');
  }

  const source: 'all-frames' | 'frame' | 'tag' =
    options.frame !== undefined ? 'frame' : options.tag !== undefined ? 'tag' : 'all-frames';

  if (options.rect !== undefined) assertFocusInsideCanvas(sprite, options.rect);

  // `animationSequence` with no tag *is* "every frame once, in document order", which
  // is also what `createQualityContext` would have built itself. Naming it here rather
  // than letting the two defaults live in different modules keeps `target` a truthful
  // account of what was measured.
  const single = options.frame !== undefined ? resolveFrame(sprite, options.frame) : undefined;
  const sequence = single
    ? {
        name: null as string | null,
        frames: [{ index: sprite.frames.findIndex((frame) => frame.id === single.id), frameId: single.id }],
      }
    : animationSequence(sprite, options.tag);

  const context = createQualityContext(sprite, {
    frames: sequence.frames.map((entry) => entry.frameId),
    focus: options.rect ?? null,
  });
  const report = evaluate(context, undefined, { assetClass: options.assetClass });
  const index = projectIssues(report, aggregatorIssues(context));
  const blockingCount = index.filter((entry) => entry.blocking).length;

  // Never let the cap hide a blocking defect. Severity-descending order puts every
  // blocking issue first, so raising the floor to the blocking count is enough.
  const maxIssues = Math.max(
    blockingCount,
    Math.min(MAX_ISSUES_CEILING, Math.max(1, Math.floor(options.maxIssues ?? DEFAULT_MAX_ISSUES))),
  );
  const shown = index.slice(0, maxIssues);

  return {
    ok: true,
    kind: 'quality-report',
    howToRead: HOW_TO_READ,
    ...(options.document ? { document: options.document } : {}),
    target: {
      source,
      tag: sequence.name,
      frames: sequence.frames.map((entry) => entry.index),
      frameCount: sequence.frames.length,
      canvasFrameCount: sprite.frames.length,
      focus: options.rect ?? null,
      ...(source === 'frame'
        ? { note: 'A report over one frame is a statement about that frame only. Evaluate a `tag` to judge an animation as a whole.' }
        : {}),
    },
    report,
    // Repeated beside `report` so a reader who skims the payload can see which weight profile
    // produced the total without walking into it. It is the same object, not a second answer.
    assetClass: report.assetClass,
    issues: shown,
    issueCount: index.length,
    issuesTruncated: shown.length < index.length,
    unmeasured: unmeasuredSubScores(report),
    measuredDimensions: QUALITY_DIMENSIONS.filter((id) => report.dimensions[id] !== undefined),
    excludedDimensions: report.excluded,
    notes: reportNotes(report),
  };
}