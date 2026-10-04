/**
 * `share_bundle`: turn a document into something a person can actually send to another person,
 * from a **template**, through the one command bus.
 *
 * `scripts/build-share.mjs` was the working reference implementation and reached the engine over
 * stdio through the advertised tool surface. This module is the version that belongs in the
 * product, and it exists for three reasons that are all about where the work belongs:
 *
 *   1. **The badge is written by the engine.** `encodePNG(buffer, {metadata})` stamps the `tEXt`
 *      chunks in the same pass that renders the pixels. The script decoded the file the engine
 *      wrote and re-encoded it with a direct `fast-png` import - three lines of duplication, and a
 *      second place for the provenance vocabulary to drift. Here there is one writer, and it is
 *      the one `assertPngMetadata` guards.
 *   2. **The template schema reaches what the engine can already produce.** GIFs, rig poses and
 *      every importer were one `if` away and unreachable, because the template's output union
 *      only knew `png`, `sheet` and one named engine. The union below is the same set
 *      `finalize_document` already offers.
 *   3. **The command bus.** The CLI, the MCP server and the app reach a share bundle the same
 *      way they reach a `draw_rect`: one serialisable command, one `Draft`, one undo history.
 *
 * ## Three commitments, because a share image leaves the building
 *
 *   - **No score, grade, rating, percentage or verdict travels anywhere.** Not in `share.json`,
 *     not in the card HTML, not in the PNG's text chunks, not even as a word in the prose. A share
 *     bundle is the most dangerous place in this repository to put a number, because it is
 *     *designed* to be looked at and circulated. `AGENTS.md` records what happens when one is: a
 *     model told a lake was clean sanded it into a dark flat rectangle. What travels instead is
 *     the **named** defects - code, dimensions, region, what to do - which is the form that stays
 *     actionable after the reader has thrown the number away. `severity` is dropped even though
 *     it is only 0..1: it is a number, and a number in a file that gets forwarded is the thing
 *     this repository has already paid for.
 *   - **An unmeasured dimension is not a clean one.** Every abstention is carried in its own
 *     block with its reason spelled out, and **never** folded into the list of dimensions that
 *     measured the piece. `ExcludedReason` exists because "nothing wrong here" and "nobody looked"
 *     both arrive as an absent number, and only one of them is a compliment.
 *   - **The badge is carried, never burned.** A `tEXt` chunk changes no pixel, so the asset
 *     underneath is still recoverable by decoding the file. A burned badge destroys pixels the
 *     content hash covers and that every downstream engine resamples, and it is unrecoverable by
 *     anyone who did not watch it happen.
 *
 * ## Determinism, and why this module returns bytes instead of writing them
 *
 * `packages/core` has no filesystem - `exportAssets` returns bytes and says so, and
 * `finalize_document` is the surface that writes. So this returns {@link ShareBundleFile}s with
 * **bundle-relative, forward-slashed paths** and the bytes beside them, and the caller writes.
 * Every path in the record is relative for the reason `ASSET-CONTRACT` S5.1 exists: a record
 * holding `share\\handoff\\...` cannot travel to a Linux build machine, and the rule is that the
 * *record* of a bundle is as portable as the bundle.
 *
 * Same document and template in, byte-identical bundle out: no clock, no session id, no absolute
 * path, no locale-sensitive formatting, no hash iteration order. `share.json` records each PNG's
 * sha256, so a diff shows a real change when the artwork changed and nothing at all when it did
 * not.
 *
 * ## Not here, on purpose
 *
 * **A contact sheet.** Its only implementation, `animationPreviewPayload`, is private to
 * `packages/mcp/src/tools.ts`, so wiring it here would mean moving that function out of a file
 * this change does not own. A template that asks for one is refused by name rather than silently
 * shipped without it.
 *
 * **A version.** `dotloom:license` is written only when a caller supplied one and nothing else is
 * ever inferred - `ASSET-CONTRACT` S11, "absent is not public domain". The engine version is not
 * written either, by S10: it changes on every release, so every shared file would become a diff
 * on upgrade. The badge is the PNG spec's own `Software` keyword with no version attached.
 */
import { z } from 'zod';
import type { PixelBuffer } from '../buffer.js';
import { animationSequence, encodeGIF } from '../gif.js';
import type { Sprite } from '../document.js';
import {
  buildAssetMeta,
  serializeAssetMeta,
  validateAssetNaming,
  importExcalidraw,
  importGodot,
  importPhaser,
  importUnity,
  type AssetMeta,
  type AssetMetaOptions,
  type AssetMetaOutput,
  type AssetNamingDiagnostic,
} from '../asset/index.js';
import { sha256Hex, utf8Bytes } from '../asset/hash.js';
import { buildSpritesheet, scaleAtlas, toAsepriteJson, type Atlas } from '../atlas.js';
import { assertPngMetadata, encodePNG } from '../png.js';
import { compositeFrame, flattenAlpha } from '../render.js';
import { serializeSprite } from '../serialize.js';
import { findRigPose, findRigTween, interpolatePose, renderInterpolatedPose, renderPose, requireRig } from '../rig.js';
import { createQualityContext } from '../quality/context.js';
import { aggregatorIssues, evaluate as aggregateQualityReport } from '../quality/index.js';
import {
  isBlocking,
  QUALITY_DIMENSIONS,
  type ExcludedReason,
  type QualityDimensionId,
  type QualityIssue,
} from '../quality/types.js';
import { scaleNearest } from '../transform.js';
import { planQualityFix, type QualityFixPlan } from './quality.js';
import { defineCommand, type CommandSummary } from './types.js';

/* ------------------------------------------------------------------ *
 * The badge
 * ------------------------------------------------------------------ */

/** The badge, as the PNG spec's own `Software` keyword. No version - see `ASSET-CONTRACT` S10. */
export const SHARE_BADGE = 'dotloom-mcp';

/** Longest edge a rendered piece is scaled to when a template's `png` output does not say. */
const TARGET_LONG_SIDE = 256;

/** The dimension set, in pipeline order, for the card's legend. Mirrors `build-gallery.mjs`. */
const DIMENSIONS: readonly QualityDimensionId[] = ['silhouette', 'value', 'palette', 'noise', 'outline', 'motion'];

/** The four importers, so a template that names an engine reaches the same code `finalize_document` does. */
const ENGINE_IMPORTERS: Record<string, (input: unknown) => { root: string; files: { path: string; contents: string; role: string }[]; warnings: string[] }> = {
  godot: importGodot as never,
  unity: importUnity as never,
  phaser: importPhaser as never,
  excalidraw: importExcalidraw as never,
};

export const SHARE_ENGINES = ['godot', 'unity', 'phaser', 'excalidraw'] as const;
export type ShareEngine = (typeof SHARE_ENGINES)[number];

/* ------------------------------------------------------------------ *
 * The template
 * ------------------------------------------------------------------ */

/**
 * Why a dimension abstained, in words a reader can act on.
 *
 * Copied from `build-gallery.mjs` deliberately - two surfaces saying the same thing in two
 * vocabularies is how they drift apart, and a share bundle that explained an abstention less
 * carefully than the gallery would be a regression travelling outward.
 */
const EXCLUSION_NOTES: Record<ExcludedReason, string> = {
  'no-subject':
    'the ink runs to the frame on every edge, so the alpha boundary *is* the canvas and there is no shape to read. Measured on a different canvas, not on a different drawing.',
  'no-outline':
    'this document declares no drawn contour. That is a legitimate style - a scene is not a sticker - so the dimension abstains rather than scoring it.',
  'single-frame': 'the evaluated sequence is one frame, so there is nothing to measure motion across.',
  'no-motion-content':
    'every frame is byte-identical, so there is no motion to measure. An honest analyser asked to score this would return its best possible reading for a sprite that does not move; abstaining is the only truthful answer.',
  'not-implemented':
    'this build has no analyser for this dimension. That is a claim about the engine, not about the artwork.',
  'no-judgeable-plane': 'no tone-plane boundary met its preconditions, so this term abstains. The artwork did nothing wrong.',
  'line-sprite':
    'the subject is a 1px line drawing, so these neighbour measures have nothing to measure. The rest of this dimension was still measured.',
};

const engineSchema = z.enum(SHARE_ENGINES);

/**
 * The contract fields that are not the document, on a `meta`/`engine` output.
 *
 * Same three fields `finalize_document`'s `assetBundleShape` carries and for the same reasons, so
 * a bundle built here and a bundle built by a `finalize_document` plan describe the same thing.
 * `license` is deliberately absent: the contract supports the block and the document model has no
 * field for it, so it is a caller declaration - here, the template's top-level `license`.
 */
const assetBundleShape = {
  sheet: z
    .string()
    .optional()
    .describe('Spritesheet PNG the contract describes, relative to `meta.json`. Defaults to the `sheet` output in the same template.'),
  outputs: z
    .array(
      z
        .object({
          role: z
            .enum(['source', 'frame', 'sheet-json', 'gif', 'contact-sheet'])
            .describe('What the file is. `sheet` is reserved; the sheet is `sheet.image`.'),
          path: z.string().describe('The file, relative to `meta.json`, forward slashes.'),
        })
        .strict(),
    )
    .optional()
    .describe('The rest of the bundle, relative to `meta.json`.'),
  directions: z
    .array(z.string().nullable())
    .optional()
    .describe(
      'Which way each frame faces, in timeline order: `N`, `NE`, `E`, `SE`, `S`, `SW`, `W`, `NW`, or null. One entry per frame. Omit it and the contract carries no `directions` block at all; an unrecognised label is an error, never a dropped frame.',
    ),
};

const scaleField = z.number().int().min(1).max(32).optional().describe('Integer upscale factor. Defaults to 1 (pixel-exact).');
const backgroundField = z.string().nullable().optional().describe('Composite over this colour instead of transparency.');
const tagField = z.union([z.string(), z.number().int()]).optional().describe('Animation tag name, ID or index. Omit to use every frame in document order.');

/**
 * One file a template asks for.
 *
 * **The same union `finalize_document` offers, minus `contact`.** A template can ask for a GIF, a
 * baked rig pose, one engine's files or the bare contract; what it cannot ask for is a contact
 * sheet, and asking is a named refusal rather than a bundle that quietly ships less than it
 * claims. `meta` and `engine` are the two `finalize_document` asset outputs, spelled the same way
 * so the two cannot describe different bundles.
 *
 * Paths are **not** in here. A template says *what* goes in a bundle; the bundle says where, and a
 * template that could name an absolute path would be a template that decides where someone's build
 * writes.
 */
export const shareOutputSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('png'),
      targetLongSide: z
        .number()
        .int()
        .min(1)
        .max(4096)
        .optional()
        .describe('Upscale the render so its longest edge is about this many pixels. The badge belongs to the piece, so this is the largest a shared preview gets by default.'),
      scale: scaleField,
      background: backgroundField,
    })
    .strict(),
  z
    .object({
      type: z.literal('frames'),
      scale: scaleField,
      background: backgroundField,
    })
    .strict(),
  z
    .object({
      type: z.literal('sheet'),
      layout: z.enum(['horizontal', 'vertical', 'grid']).optional().describe('Sheet layout. Defaults to "horizontal".'),
      columns: z.number().int().min(1).optional().describe('Columns, for the "grid" layout.'),
      padding: z.number().int().min(0).optional().describe('Transparent gap between frames, in pixels. 1 avoids texture bleed.'),
      margin: z.number().int().min(0).optional().describe('Transparent border around the sheet, in pixels.'),
      scale: scaleField,
    })
    .strict(),
  z
    .object({
      type: z.literal('gif'),
      tag: tagField,
      scale: scaleField,
      background: z.string().optional().describe('Fill transparent pixels with this colour instead of leaving them transparent.'),
      loop: z.boolean().optional().describe("Force looping on or off, overriding the tag's repeat setting."),
    })
    .strict(),
  z
    .object({
      type: z.literal('pose'),
      pose: z.string().describe('Pose name or ID to bake. The document must carry a rig.'),
      tween: z.string().optional().describe('Bake this tween instead of a pose, at `progress`.'),
      progress: z.number().min(0).max(1).optional().describe('Where along the tween (or the identity-to-pose blend) to render. Defaults to 1.'),
      scale: scaleField,
      background: backgroundField,
    })
    .strict(),
  z
    .object({
      type: z.literal('meta'),
      ...assetBundleShape,
    })
    .strict(),
  z
    .object({
      type: z.literal('engine'),
      engine: engineSchema.optional().describe('Which engine to write for. Defaults to the template\'s `engine`, and the command\'s `engine` overrides both.'),
      directory: z.string().optional().describe('Folder for the engine files, relative to `meta.json`. Defaults to the importer\'s own suggestion, which is `<asset.name>/`.'),
      ...assetBundleShape,
    })
    .strict(),
]);

export type ShareOutput = z.infer<typeof shareOutputSchema>;

/**
 * A share template: a presentation preset.
 *
 * **A closed field set, on purpose.** A template is presentation *policy*, and a typo in one would
 * otherwise be silently ignored - the failure mode `ASSET-CONTRACT` S3 calls out by name:
 * tolerance for the future must not become tolerance for typos. So `z.strict()` at every level and
 * an unrecognised key is an error rather than a default.
 */
export const shareTemplateSchema = z
  .object({
    format: z.literal('dotloom-mcp/share-template').describe('Always `dotloom-mcp/share-template`. Checked first: it says this is a share template at all, rather than a recipe or an export plan.'),
    schemaVersion: z.literal(1).describe('Template schema revision, currently `1`. A breaking change bumps it.'),
    id: z.string().min(1).describe('Stable identifier, e.g. `card`. Matches the filename it lives in.'),
    title: z.string().min(1).describe('Human title for the preset.'),
    summary: z.string().min(1).describe('One sentence, for a person deciding what to send.'),
    outputs: z.array(shareOutputSchema).min(1).describe('What goes in the bundle. At least one, or the bundle is empty.'),
    card: z.enum(['card']).nullable().describe('`"card"` renders the self-contained HTML judgement layer; `null` ships no HTML.'),
    assetContract: z.boolean().describe('Write `meta.json`. Shorthand for a `meta` output, or for an `engine` output when `engine` is also set.'),
    engine: engineSchema.nullable().describe('The target engine. Shorthand for an `engine` output, and the default an `engine` output without its own `engine`.'),
    license: z.string().nullable().describe('SPDX identifier to declare. Never inferred: absent means "not specified", which is not public domain.'),
  })
  .strict();

export type ShareTemplate = z.infer<typeof shareTemplateSchema>;

/**
 * A template's shorthand fields, expanded into the outputs they stand for.
 *
 * `assetContract` and `engine` are sugar, and expanding them here rather than branching on them
 * at three call sites is what keeps the two spellings from describing different bundles: `handoff`
 * names its engine in `outputs` *and* at the top level, and both paths land on the same output.
 *
 * The expansion is idempotent and additive-only, so an explicit `meta`/`engine` entry in `outputs`
 * and the top-level flags never produce two contracts.
 */
export function expandShareTemplate(template: ShareTemplate): ShareOutput[] {
  const outputs = [...template.outputs];
  const hasAssetOutput = outputs.some((output) => output.type === 'meta' || output.type === 'engine');
  if (template.assetContract && !hasAssetOutput) {
    outputs.push(template.engine ? { type: 'engine', engine: template.engine } : { type: 'meta' });
  }
  return outputs;
}

/* ------------------------------------------------------------------ *
 * Names
 * ------------------------------------------------------------------ */

/** A file-system-safe stem for an asset id. */
export function shareSlugFor(id: string): string {
  return id.replace(/[^\w.-]+/g, '--');
}

/** `autumn-dusk-lake-256` becomes `Autumn Dusk Lake`. Presentation, and derived from data. */
export function shareTitleFromId(id: string): string {
  const last = id.split('/').pop() ?? id;
  return last
    .replace(/-\d+x\d+$/, '')
    .split('-')
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

/* ------------------------------------------------------------------ *
 * Judgement
 * ------------------------------------------------------------------ */

export interface ShareIssue {
  readonly code: string;
  readonly dimensions: string[];
  readonly rect: { x: number; y: number; w: number; h: number } | null;
  readonly blocking: boolean;
  readonly message: string;
  readonly disposition: 'safe-repair-available' | 'needs-a-decision';
  readonly guidance: string | null;
}

export interface ShareNotMeasured {
  readonly dimension: string;
  readonly reason: string;
  readonly note: string;
}

/**
 * The judgement a bundle carries: named defects, and every abstention.
 *
 * **No number is returned from this function at all**, which is the only way to be sure none
 * reaches a file. `evaluate` publishes `score` because the report shape makes it part of that
 * contract; this projects it down to names, and a projection cannot leak a field it does not
 * mention. `severity` is dropped even though it is only 0..1 - it is a number, and a number in a
 * file that gets forwarded is what this repository has already paid for.
 */
function judge(sprite: Sprite): {
  issues: ShareIssue[];
  notMeasured: ShareNotMeasured[];
  measuredDimensions: string[];
  assetClass: string;
} {
  const sequence = animationSequence(sprite);
  const context = createQualityContext(sprite, {
    frames: sequence.frames.map((entry) => entry.frameId),
    focus: null,
  });
  const report = aggregateQualityReport(context, undefined, {});

  // One entry per `(code, rect)`, dimensions collected rather than discarded, sorted the way the
  // aggregator sorts: severity descending, then code, then rect. Blocking defects come first
  // because severity is what puts them there.
  const byKey = new Map<string, { issue: QualityIssue; dimensions: string[] }>();
  const add = (issue: QualityIssue, dimension: string | null): void => {
    const key = `${issue.code}|${issue.rect === null ? 'global' : `${issue.rect.x},${issue.rect.y},${issue.rect.w},${issue.rect.h}`}`;
    const existing = byKey.get(key);
    if (existing) {
      if (dimension !== null && !existing.dimensions.includes(dimension)) existing.dimensions.push(dimension);
      return;
    }
    byKey.set(key, { issue, dimensions: dimension === null ? [] : [dimension] });
  };
  for (const id of DIMENSIONS) {
    for (const issue of report.dimensions[id]?.issues ?? []) add(issue, id);
  }
  // The aggregator's issues describe the target rather than any one dimension's opinion of it.
  for (const issue of aggregatorIssues(context)) add(issue, null);

  const entries = [...byKey.values()].sort((a, b) => {
    const bySeverity = b.issue.severity - a.issue.severity;
    if (bySeverity !== 0) return bySeverity;
    if (a.issue.code !== b.issue.code) return a.issue.code < b.issue.code ? -1 : 1;
    const left = a.issue.rect === null ? '' : `${a.issue.rect.x},${a.issue.rect.y}`;
    const right = b.issue.rect === null ? '' : `${b.issue.rect.x},${b.issue.rect.y}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });

  // Which dimension owns a code, for the repair plan's guidance. Last writer wins in pipeline
  // order, which is a defined answer rather than an accident: two dimensions naming one code is
  // the same defect by the contract.
  const owner = new Map<string, string>();
  for (const id of DIMENSIONS) {
    for (const issue of report.dimensions[id]?.issues ?? []) owner.set(issue.code, id);
  }

  // One plan per code, and the plan is keyed by code because the bundle reports a defect once.
  // The **last** entry for a code wins, matching the order `fix` returns them in.
  const plans = new Map<string, QualityFixPlan>();
  for (const entry of entries) {
    plans.set(entry.issue.code, planQualityFix(entry.issue, owner.get(entry.issue.code) ?? 'aggregator'));
  }

  const seen = new Set<string>();
  const issues: ShareIssue[] = [];
  for (const entry of entries) {
    if (seen.has(entry.issue.code)) continue;
    seen.add(entry.issue.code);
    const plan = plans.get(entry.issue.code);
    issues.push({
      code: entry.issue.code,
      dimensions: [...entry.dimensions].sort(),
      rect: entry.issue.rect,
      blocking: isBlocking(entry.issue),
      message: oneLine(entry.issue.message),
      disposition: plan?.fix === 'ops' ? 'safe-repair-available' : 'needs-a-decision',
      guidance: plan ? oneLine(plan.guidance) : null,
    });
  }
  issues.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  // A *partly* absent dimension is the case with no precedent, and to a reader it is the same fact
  // as a whole-dimension abstention: part of this claim was not checked. So it goes in the same
  // block, never folded into the measured list.
  const notMeasured: ShareNotMeasured[] = [];
  for (const [dimension, reason] of Object.entries(report.excluded)) {
    notMeasured.push({ dimension, reason, note: EXCLUSION_NOTES[reason as ExcludedReason] ?? `reason: ${reason}` });
  }
  for (const id of DIMENSIONS) {
    for (const [sub, reason] of Object.entries(report.dimensions[id]?.unmeasured ?? {})) {
      notMeasured.push({
        dimension: `${id}.${sub}`,
        reason: reason as string,
        note:
          (EXCLUSION_NOTES[reason as ExcludedReason] ?? `reason: ${reason}`) +
          ' The rest of this dimension was measured and is reported normally; this one term is absent, not counted at its best.',
      });
    }
  }
  notMeasured.sort((a, b) => (a.dimension < b.dimension ? -1 : a.dimension > b.dimension ? 1 : 0));

  return {
    issues,
    notMeasured,
    measuredDimensions: DIMENSIONS.filter((id) => report.dimensions[id] !== undefined),
    assetClass: report.assetClass.cls,
  };
}

/* ------------------------------------------------------------------ *
 * The bundle
 * ------------------------------------------------------------------ */

export interface ShareBundleFile {
  /** Relative to the bundle directory, forward slashes on every platform. */
  readonly path: string;
  readonly mediaType: string;
  readonly role: string;
  readonly bytes: Uint8Array;
}

export interface ShareDelivery {
  readonly refused: boolean;
  readonly reason?: string;
  readonly files?: string[];
  readonly assets?: { path: string; contentHash: string; schemaVersion: number; engine: string | null }[];
}

export interface ShareBundleRecord {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly template: string;
  readonly source: string;
  readonly width: number;
  readonly height: number;
  readonly layers: number;
  readonly frames: number;
  readonly image: string;
  readonly imageBytes: number;
  readonly imageSha256: string;
  readonly badge: { carriedAs: string; keyword: string; value: string; burnedIn: boolean };
  readonly provenance: Record<string, string>;
  readonly assetClass: string;
  readonly measuredDimensions: string[];
  readonly notMeasured: ShareNotMeasured[];
  readonly issues: ShareIssue[];
  readonly delivery: ShareDelivery | null;
  /**
   * Every file in the bundle, by role, sorted by path.
   *
   * **Not `readonly` on the array itself**, and that is deliberate: the card is an *output* of the
   * template rather than a precondition for it, so it is rendered from the record and then added to
   * the record's own file list. One sort after both, rather than a sort that has to be undone.
   */
  files: { role: string; path: string }[];
}

export interface ShareBundle {
  readonly record: ShareBundleRecord;
  readonly files: ShareBundleFile[];
}

export interface ShareBundleOptions {
  /** The `.pixel` path this came from, recorded verbatim. A declaration about the file, never hashed. */
  readonly source?: string;
  /** Asset id. Defaults to the slug. */
  readonly id?: string;
  /** Directory stem. Defaults to the slug. */
  readonly slug?: string;
  /** Human title. Derived from the id when absent. */
  readonly title?: string;
  /**
   * The target engine, overriding the template's.
   *
   * **The target engine is the caller's choice**, which is why it is opt-in on all four surfaces
   * and why a tool cannot know it. Naming it in the template makes a bundle reproducible for
   * everybody who shares that piece; overriding it here is what lets a caller send the same artwork
   * to a Phaser project instead. It only affects a template that asks for engine files at all.
   */
  readonly engine?: ShareEngine;
  /** Write `.pixel` into the bundle. On by default, and off for a bundle that is only a preview. */
  readonly includeSource?: boolean;
}

const utf8 = (text: string): Uint8Array => utf8Bytes(text);

function oneLine(text: string): string {
  return String(text).replace(/\s+/g, ' ').trim();
}

function esc(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * The scale a `png` output renders at: the largest whole-number upscale that lands the long edge
 * near `targetLongSide`, clamped to 8x.
 *
 * The clamp is not arbitrary - it is the ceiling every export on this surface uses, and a template
 * that asked for a 64x upscale of a 512px canvas would produce a file no mail client will open.
 */
function scaleFor(sprite: Sprite, target: number | undefined): number {
  const longSide = Math.max(sprite.width, sprite.height);
  return Math.max(1, Math.min(8, Math.floor((target ?? TARGET_LONG_SIDE) / longSide)));
}

/** A pose or tween baked to pixels, the way `finalize_document`'s `pose` output bakes one. */
function bakePose(sprite: Sprite, output: Extract<ShareOutput, { type: 'pose' }>): PixelBuffer {
  const rig = requireRig(sprite);
  const progress = output.progress ?? 1;
  let buffer: PixelBuffer;
  if (output.tween !== undefined) {
    const tween = findRigTween(rig, output.tween);
    const from = findRigPose(rig, tween.fromPoseId);
    const to = findRigPose(rig, tween.toPoseId);
    void interpolatePose(rig, from, to, progress, tween.easing);
    buffer = renderInterpolatedPose(sprite, from, to, progress, tween.easing).buffer;
  } else {
    const pose = findRigPose(rig, output.pose);
    if (progress < 1) {
      const identity = { id: '__identity__', name: 'identity', transforms: {} };
      void interpolatePose(rig, identity, pose, progress);
      buffer = renderInterpolatedPose(sprite, identity, pose, progress).buffer;
    } else {
      buffer = renderPose(sprite, pose).buffer;
    }
  }
  if (output.background != null) buffer = flattenAlpha(buffer, output.background);
  const scale = output.scale ?? 1;
  if (scale > 1) buffer = scaleNearest(buffer, scale);
  return buffer;
}

/**
 * One asset output rendered: `meta.json`, and one engine's files when the output asks for them.
 *
 * `meta` implies the contract; `engine` implies the contract **and** the importer's files, because
 * the importer reads the contract - which is exactly the shape `finalize_document` gives both.
 */
function renderAssetOutput(
  sprite: Sprite,
  request: Extract<ShareOutput, { type: 'meta' | 'engine' }>,
  atlas: Atlas | undefined,
  sheetImage: string | undefined,
  engine: ShareEngine | undefined,
): { files: ShareBundleFile[]; delivery: ShareDelivery; meta: AssetMeta } {
  const metaOptions: AssetMetaOptions = {
    ...(atlas && sheetImage ? { sheet: { atlas, image: sheetImage } } : {}),
    ...(request.outputs ? { outputs: request.outputs as readonly AssetMetaOutput[] } : {}),
    ...(request.directions ? { directions: request.directions } : {}),
  };
  const meta = buildAssetMeta(sprite, metaOptions);

  const naming = validateAssetNaming(meta);
  if (!naming.ok) {
    const errors = naming.diagnostics.filter((diagnostic: AssetNamingDiagnostic) => diagnostic.severity === 'error');
    const codes = [...new Set(errors.map((diagnostic) => diagnostic.code))].join(', ');
    return {
      files: [],
      delivery: {
        refused: true,
        reason: `Asset naming refuses this bundle: ${errors.length} error(s) [${codes}]. First: ${errors[0].path === '' ? 'the contract' : errors[0].path} - ${errors[0].message}`,
      },
      meta,
    };
  }

  const text = serializeAssetMeta(meta);
  const files: ShareBundleFile[] = [
    { path: 'meta.json', mediaType: 'application/json', role: 'asset', bytes: utf8(text) },
  ];
  const paths = ['meta.json'];
  let engineName: string | null = null;

  if (request.type === 'engine') {
    // **The command's `engine` wins over the output's own and over the template's.** That is the
    // point of the override: a template names an engine so a bundle is reproducible for everybody
    // sharing that piece, and a caller sending the same artwork into a Phaser project instead says
    // so at the call rather than forking the template. The fallbacks are only for a caller who said
    // nothing, and they read output-then-template so there is exactly one precedence order.
    const name = engine ?? request.engine;
    if (!name) {
      throw new Error(
        'An `engine` output needs an engine: set `engine` on the output, on the template, or pass `engine` to the command. The target engine is the caller\'s choice and a tool cannot know it.',
      );
    }
    const importer = ENGINE_IMPORTERS[name];
    if (!importer) throw new Error(`Unknown engine "${name}".`);
    engineName = name;
    const result = importer(meta);
    const root = request.directory ?? result.root;
    for (const file of result.files) {
      // Joined segment by segment, so a Windows separator can never reach a bundle path.
      const path = `${root}/${file.path.split('/').join('/')}`;
      files.push({ path, mediaType: 'text/plain', role: 'asset', bytes: utf8(file.contents) });
      paths.push(path);
    }
  }

  return {
    files,
    delivery: {
      refused: false,
      files: paths.sort(),
      assets: [
        {
          path: 'meta.json',
          contentHash: meta.asset.contentHash,
          schemaVersion: meta.schemaVersion,
          engine: engineName,
        },
      ],
    },
    meta,
  };
}

/**
 * Build one share bundle: the files, and the record that describes them.
 *
 * **Pure.** No clock, no randomness, no locale, no filesystem, no session id - so the same document
 * and template produce the same bytes on every machine, which is the only thing that makes a
 * bundle diffable and a committed card trustworthy.
 *
 * ## The provenance round trip
 *
 * The PNG is encoded **once**, with its text chunks attached, and only after the contract exists
 * when one was asked for. That is why the engine writes the badge rather than a caller patching it
 * on afterwards: the hash in `dotloom:asset` is the hash in `meta.json`, so a recipient can check
 * the file against the contract without re-compositing a single frame - and there is no window in
 * which the file on disk disagrees with the record describing it.
 */
export function buildShareBundle(sprite: Sprite, template: ShareTemplate, options: ShareBundleOptions = {}): ShareBundle {
  const outputs = expandShareTemplate(template);
  const slug = options.slug ?? shareSlugFor(options.id ?? sprite.name);
  const id = options.id ?? slug;
  const title = options.title ?? shareTitleFromId(id);
  const files: ShareBundleFile[] = [];
  const recordFiles: { role: string; path: string }[] = [];

  const wanted = (type: ShareOutput['type']): ShareOutput | undefined => outputs.find((output) => output.type === type);

  // ---- the render. Frame 0 unless the template asked for every frame separately.
  const pngOutput = wanted('png');
  const scale = scaleFor(sprite, pngOutput && pngOutput.type === 'png' ? pngOutput.targetLongSide : undefined);
  let render = compositeFrame(sprite, sprite.frames[0].id, {
    background: pngOutput && pngOutput.type === 'png' ? (pngOutput.background ?? undefined) : undefined,
  });
  if (scale > 1) render = scaleNearest(render, scale);
  const imageName = `${slug}.png`;

  const framesOutput = wanted('frames');
  if (framesOutput && framesOutput.type === 'frames') {
    const frameScale = framesOutput.scale ?? 1;
    sprite.frames.forEach((frame, index) => {
      let image = compositeFrame(sprite, frame.id, { background: framesOutput.background ?? undefined });
      if (frameScale > 1) image = scaleNearest(image, frameScale);
      const path = `${slug}_${index}.png`;
      files.push({ path, mediaType: 'image/png', role: 'frame', bytes: encodePNG(image) });
      recordFiles.push({ role: 'frame', path });
    });
  }

  // ---- a sheet or a contact strip, when the template asks for one. Rendered with the atlas the
  // engine already has rather than through `finalize_document`: the quality gate is a *delivery*
  // gate, and a review card that cannot be opened because a defect blocked a handoff is the wrong
  // trade. These files carry no badge - the badge belongs to the piece, not to every strip of it -
  // and nothing reads them back, so there is nothing to declare.
  let atlas: Atlas | undefined;
  const sheetOutput = wanted('sheet');
  if (sheetOutput && sheetOutput.type === 'sheet') {
    atlas = scaleAtlas(
      buildSpritesheet(sprite, {
        layout: sheetOutput.layout,
        columns: sheetOutput.columns,
        padding: sheetOutput.padding,
        margin: sheetOutput.margin,
      }),
      sheetOutput.scale ?? 1,
    );
    const sheetName = `${slug}_sheet.png`;
    files.push({ path: sheetName, mediaType: 'image/png', role: 'sheet', bytes: encodePNG(atlas.image) });
    recordFiles.push({ role: 'sheet', path: sheetName });
    const sheetJson = `${slug}_sheet.json`;
    files.push({
      path: sheetJson,
      mediaType: 'application/json',
      role: 'sheet-json',
      // Two-space JSON with **no** trailing newline, which is what `export_sheet` writes and what
      // every sheet JSON in the wild is byte-compared against.
      bytes: utf8(`${JSON.stringify(toAsepriteJson(sprite, atlas, sheetName), null, 2)}`),
    });
    recordFiles.push({ role: 'sheet-json', path: sheetJson });
  }

  const gifOutput = wanted('gif');
  if (gifOutput && gifOutput.type === 'gif') {
    const path = `${slug}.gif`;
    files.push({
      path,
      mediaType: 'image/gif',
      role: 'gif',
      bytes: encodeGIF(sprite, {
        tag: gifOutput.tag,
        scale: gifOutput.scale,
        background: gifOutput.background ?? null,
        loop: gifOutput.loop,
      }),
    });
    recordFiles.push({ role: 'gif', path });
  }

  const poseOutput = wanted('pose');
  if (poseOutput && poseOutput.type === 'pose') {
    const path = `${slug}_${poseOutput.pose}.png`;
    files.push({ path, mediaType: 'image/png', role: 'pose', bytes: encodePNG(bakePose(sprite, poseOutput)) });
    recordFiles.push({ role: 'pose', path });
  }

  // ---- the judgement. Named defects and every abstention; never a number.
  const judgement = judge(sprite);

  // ---- the optional half: the contract and one engine's files, opt-in exactly as
  // `finalize_document` has always been. A refusal is carried, not thrown: a bundle that says the
  // delivery gate stopped it is more useful than no bundle.
  let delivery: ShareDelivery | null = null;
  let contractHash: string | null = null;
  let contractSchema: number | null = null;
  const assetOutput = outputs.find((output) => output.type === 'meta' || output.type === 'engine');
  if (assetOutput && (assetOutput.type === 'meta' || assetOutput.type === 'engine')) {
    const includeSource = options.includeSource !== false;
    // The contract's own `role` union is wider than the template's - it also allows `sheet`, which
    // is reserved and belongs to `sheet.image` - so the declared list is spelled out by hand rather
    // than widened into a type that could describe a bundle this module cannot build.
    type ShareContractOutput = {
      role: 'source' | 'frame' | 'sheet-json' | 'gif' | 'contact-sheet';
      path: string;
    };
    const declared: ShareContractOutput[] = [
      { role: 'source', path: `${slug}.pixel` },
      { role: 'frame', path: imageName },
      ...(sheetOutput && sheetOutput.type === 'sheet'
        ? ([{ role: 'sheet-json', path: `${slug}_sheet.json` }] as const)
        : []),
      ...(gifOutput && gifOutput.type === 'gif' ? ([{ role: 'gif', path: `${slug}.gif` }] as const) : []),
    ];
    // The bundle's own file list, minus the source when it is not being written. Declared, because
    // an engine importer told about no frames and no sheet emits resources pointing at textures
    // that are not there, and warns about it in the very file it just wrote.
    const request: Extract<ShareOutput, { type: 'meta' | 'engine' }> = {
      ...assetOutput,
      outputs: (assetOutput.outputs ?? declared).filter((entry) => includeSource || entry.role !== 'source'),
      // The sheet is named, not re-rendered: `sheet.regions` comes from the sheet this bundle
      // actually writes, and re-packing here would describe a sheet nobody is shipping.
      ...(assetOutput.sheet ?? (atlas ? `${slug}_sheet.png` : undefined)
        ? { sheet: assetOutput.sheet ?? `${slug}_sheet.png` }
        : {}),
    };
    const rendered = renderAssetOutput(sprite, request, atlas, `${slug}_sheet.png`, options.engine);
    delivery = rendered.delivery;
    files.push(...rendered.files);
    for (const entry of rendered.delivery.files ?? []) recordFiles.push({ role: 'asset', path: entry });
    if (!rendered.delivery.refused) {
      contractHash = rendered.meta.asset.contentHash;
      contractSchema = rendered.meta.schemaVersion;
    }
    if (includeSource) {
      // Serialised once here rather than by a second surface: `serializeSprite` is deterministic
      // (`ZIP_MTIME` is fixed), so the `.pixel` a bundle ships is the document it was built from.
      files.push({ path: `${slug}.pixel`, mediaType: 'application/zip', role: 'source', bytes: serializeSprite(sprite) });
    }
  }

  // ---- provenance. Every value is either true of these bytes or declared by the caller, and
  // `dotloom:license` is written only when a template supplies one - S11: never invent what the
  // document does not know, and absent is not public domain.
  const provenance: Record<string, string> = {
    Software: SHARE_BADGE,
    'dotloom:name': sprite.name || slug,
    'dotloom:defects': judgement.issues.map((issue) => issue.code).join(','),
  };
  if (template.license) provenance['dotloom:license'] = template.license;
  if (contractHash !== null && contractSchema !== null) {
    provenance['dotloom:asset'] = contractHash;
    provenance['dotloom:contract'] = 'dotloom-mcp/asset-meta';
    provenance['dotloom:schema'] = String(contractSchema);
  }
  // **The engine writes the badge**, in the same pass that renders the pixels. `assertPngMetadata`
  // runs inside `encodePNG`, so a verdict-shaped key is refused here rather than in a review - and a
  // text chunk is the last place a number can hide, because it survives being pasted, mailed and
  // re-saved by a person who never opens the file.
  const imageBytes = encodePNG(render, { metadata: provenance });
  files.push({ path: imageName, mediaType: 'image/png', role: 'frame', bytes: imageBytes });
  recordFiles.push({ role: 'frame', path: imageName });

  const record: ShareBundleRecord = {
    id,
    slug,
    title,
    template: template.id,
    source: options.source ?? '',
    width: sprite.width,
    height: sprite.height,
    layers: sprite.layers.length,
    frames: sprite.frames.length,
    image: imageName,
    imageBytes: imageBytes.byteLength,
    imageSha256: sha256Hex(imageBytes),
    badge: { carriedAs: 'png-text-chunk', keyword: 'Software', value: SHARE_BADGE, burnedIn: false },
    provenance: Object.fromEntries(Object.keys(provenance).sort().map((key) => [key, provenance[key]])),
    assetClass: judgement.assetClass,
    measuredDimensions: [...judgement.measuredDimensions].sort(),
    notMeasured: judgement.notMeasured,
    issues: judgement.issues,
    delivery,
    files: recordFiles.sort(byPath),
  };

  if (template.card) {
    files.push({ path: 'card.html', mediaType: 'text/html', role: 'card', bytes: utf8(renderShareCard(record, template)) });
    record.files = [...record.files, { role: 'card', path: 'card.html' }].sort(byPath);
  }

  files.sort((a, b) => byPath(a, b));
  return { record, files };
}

/* ------------------------------------------------------------------ *
 * The card
 * ------------------------------------------------------------------ */

/**
 * The badge as a glyph strip: eight hard-edged cells, alternating, in the ink colour.
 *
 * Generated rather than checked in as an asset so it is byte-reproducible with no file to drift,
 * and hard-edged rather than antialiased because the point of a mark that claims to be made of
 * pixels is that it is made of pixels.
 */
function badgeStrip(): string {
  const ink = '#16181d';
  const out: string[] = [];
  for (let i = 0; i < 8; i++) out.push(`<i style="background:${i % 3 === 2 ? 'transparent' : ink}"></i>`);
  return out.join('');
}

/**
 * One card: the artwork, the badge as a wordmark, every named defect, every abstention.
 *
 * **Self-contained: no CDN, no client-side JavaScript.** A card is meant to be opened by someone
 * with no network and no build step, which is the whole reason it can be mailed. The badge wordmark
 * is drawn here and only here - the *sprite* carries it as a chunk, so every pixel in the PNG is the
 * engine's and decoding that file gives the artwork back unchanged.
 */
export function renderShareCard(record: ShareBundleRecord, template: ShareTemplate): string {
  const notMeasured = record.notMeasured.length
    ? `<div class="notmeasured">
        <h3>Not measured <span class="hint">&mdash; not the same as clean</span></h3>
        <ul>${record.notMeasured
          .map(
            (entry) =>
              `<li><code>${esc(entry.dimension)}</code> <span class="reason">${esc(entry.reason)}</span><p>${esc(entry.note)}</p></li>`,
          )
          .join('\n          ')}</ul>
      </div>`
    : `<div class="notmeasured all"><p>Every dimension measured this piece. That is a statement about the analysers, not a compliment.</p></div>`;

  const defects = record.issues.length
    ? `<ul class="defects">${record.issues
        .map((issue) => {
          const where = issue.rect
            ? `<span class="rect">at ${issue.rect.x},${issue.rect.y} ${issue.rect.w}x${issue.rect.h}</span>`
            : '<span class="rect">whole document</span>';
          return `<li>
            <div class="head"><code class="code">${esc(issue.code)}</code>${issue.dimensions
              .map((dimension) => `<span class="dim">${esc(dimension)}</span>`)
              .join('')}${issue.blocking ? '<span class="blocking">blocks delivery</span>' : ''}</div>
            <div class="where">${where}</div>
            <p class="what">${esc(issue.message)}</p>
            ${issue.guidance ? `<p class="todo">${esc(issue.guidance)}</p>` : ''}
            <p class="disp">${
              issue.disposition === 'safe-repair-available'
                ? 'A safe, unambiguous repair exists for this code and is returned as ops; it is not applied here.'
                : 'No machine repair: this is a decision, not a lookup.'
            }</p>
          </li>`;
        })
        .join('\n        ')}</ul>`
    : `<p class="clean">No dimension named a defect in this piece. That means nothing was found, not that the piece is finished.</p>`;

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>${esc(record.title)} &mdash; ${esc(SHARE_BADGE)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark;
    --ink:#16181d; --muted:#5d6470; --line:#d6dae1; --bg:#fbfbfc; --card:#fff;
    --defect:#8a3324; --abstain:#6b5410; --ok:#2f5d3a; }
  @media (prefers-color-scheme: dark) {
    :root { --ink:#e6e8ec; --muted:#9aa2b1; --line:#2c3038; --bg:#14161a; --card:#1b1e24;
            --defect:#e59283; --abstain:#d8bd6a; --ok:#86c39a; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:2rem 1.25rem 4rem; background:var(--bg); color:var(--ink);
         font:16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width:60rem; margin:0 auto; }
  h1 { font-size:1.8rem; margin:0 0 .3rem; }
  h3 { font-size:.95rem; margin:1.25rem 0 .4rem; text-transform:uppercase; letter-spacing:.06em;
       color:var(--muted); }
  p { margin:.4rem 0; }
  code { font:.86em ui-monospace, SFMono-Regular, Menlo, monospace; }
  .lede { color:var(--muted); max-width:42rem; }
  .badge { display:inline-flex; align-items:center; gap:.5rem; border:1px solid var(--line);
           border-radius:999px; padding:.2rem .7rem; font-size:.8rem; color:var(--muted);
           margin:.6rem 0 1.2rem; }
  /* The glyph strip is the badge as a mark rather than as a sentence: eight hard-edged cells,
     because a badge that resamples is a badge that has been drawn into the art. */
  .badge .strip { display:inline-flex; }
  .badge .strip i { width:6px; height:6px; display:block; }
  .shot { display:flex; justify-content:center; background-color:#fff; background-image:
          linear-gradient(45deg,#dfe3e9 25%,transparent 25%),linear-gradient(-45deg,#dfe3e9 25%,transparent 25%),
          linear-gradient(45deg,transparent 75%,#dfe3e9 75%),linear-gradient(-45deg,transparent 75%,#dfe3e9 75%);
          background-size:16px 16px; background-position:0 0,0 8px,8px -8px,-8px 0;
          border:1px solid var(--line); border-radius:6px; padding:.75rem; }
  .shot img { width:100%; height:auto; image-rendering:pixelated; display:block; }
  .facts { display:flex; flex-wrap:wrap; gap:.4rem .9rem; font-size:.84rem; color:var(--muted); }
  .facts span { border:1px solid var(--line); border-radius:999px; padding:.1rem .6rem; }
  .hint { text-transform:none; letter-spacing:0; font-weight:400; font-size:.8rem; opacity:.8; }
  .dims ul { list-style:none; display:flex; flex-wrap:wrap; gap:.35rem; padding:0; margin:.35rem 0 0; }
  .dims li { font:.8rem ui-monospace, monospace; border:1px solid var(--line); border-radius:4px;
             padding:.1rem .45rem; color:var(--ok); }
  .notmeasured { border-left:3px solid var(--abstain); padding:.1rem 0 .1rem .8rem; margin:1rem 0 0; }
  .notmeasured.all { border-left-style:dashed; opacity:.8; }
  .notmeasured ul { margin:.3rem 0; padding-left:1.1rem; }
  .notmeasured li { margin-bottom:.45rem; font-size:.9rem; }
  .notmeasured .reason { font:.78rem ui-monospace, monospace; color:var(--abstain); }
  .notmeasured p { font-size:.86rem; color:var(--muted); margin:.1rem 0 0; }
  .defects { list-style:none; margin:.3rem 0 0; padding:0; }
  .defects > li { border-top:1px solid var(--line); padding:.6rem 0; }
  .defects > li:first-child { border-top:0; }
  .head { display:flex; flex-wrap:wrap; align-items:baseline; gap:.45rem; }
  .code { font-weight:700; color:var(--defect); font-size:.95rem; }
  .dim { font:.74rem ui-monospace, monospace; border:1px solid var(--line); border-radius:4px;
         padding:0 .4rem; color:var(--muted); }
  .blocking { font-size:.74rem; letter-spacing:.04em; text-transform:uppercase; color:var(--defect);
              border:1px solid currentColor; border-radius:4px; padding:0 .4rem; }
  .where { font:.8rem ui-monospace, monospace; color:var(--muted); margin-top:.1rem; }
  .what { font-size:.92rem; margin-top:.35rem; }
  .todo { font-size:.88rem; color:var(--muted); border-left:2px solid var(--line); padding-left:.7rem; }
  .disp { font-size:.8rem; color:var(--muted); font-style:italic; }
  .clean { font-size:.92rem; color:var(--muted); font-style:italic; }
  footer { color:var(--muted); font-size:.84rem; margin-top:2rem; }
  .refused { border-left:3px solid var(--defect); padding:.1rem 0 .1rem .8rem; color:var(--defect); }
</style>

<main>
  <h1>${esc(record.title)}</h1>
  <p class="lede">${esc(template.summary)}</p>

  <p class="badge" title="carried in the PNG's text chunks, not drawn into the pixels">
    <span class="strip">${badgeStrip()}</span>
    <span>made with ${esc(SHARE_BADGE)}</span>
  </p>

  <div class="shot"><img src="${esc(record.image)}" width="${record.width}" height="${record.height}"
       alt="${esc(record.title)} rendered from ${esc(record.source)} by the engine"></div>

  <p class="facts">
    <span>${record.width}&times;${record.height}</span>
    <span>${record.layers} layer${record.layers === 1 ? '' : 's'}</span>
    <span>${record.frames} frame${record.frames === 1 ? '' : 's'}</span>
    <span>asset class: ${esc(record.assetClass)}</span>
    <span>template: ${esc(template.id)}</span>
  </p>

  <p>Rendered from <code>${esc(record.source)}</code> by <code>export_png</code>. The badge above is
     drawn on this page only: the PNG carries it as a text chunk, so every pixel in
     <code>${esc(record.image)}</code> is the engine's, and decoding that file gives the artwork
     back unchanged.</p>

  <div class="dims"><span class="hint">dimensions that measured this piece</span>
    <ul>${record.measuredDimensions.map((dimension) => `<li>${esc(dimension)}</li>`).join('')}</ul></div>

  ${notMeasured}

  <div class="judgement">
    <h3>Named defects <span class="hint">&mdash; ${record.issues.length} found</span></h3>
    ${defects}
  </div>

  ${
    record.delivery
      ? `<div class="delivery"><h3>Delivery</h3>${
          record.delivery.refused
            ? `<p class="refused">The delivery gate refused this bundle and wrote no contract: ${esc(
                record.delivery.reason ?? '',
              )}</p>`
            : `<p>The asset contract and its engine files are in this bundle. The hash the PNG's text chunk names is the one in <code>meta.json</code>.</p>`
        }</div>`
      : ''
  }

  <footer>
    <p>Built by <code>node scripts/build-share.mjs</code> through the advertised MCP tool surface.
       Reproduce with <code>node scripts/build-share.mjs --verify</code>.</p>
  </footer>
</main>
</html>
`;
}

/* ------------------------------------------------------------------ *
 * The command
 * ------------------------------------------------------------------ */

/** Standard base64, because a command summary is JSON and a bundle is bytes. */
function encodeBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += alphabet[a >> 2];
    out += alphabet[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? alphabet[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? alphabet[c & 63] : '=';
  }
  return out;
}

/**
 * `share_bundle`: build a share bundle from a template and hand back the bytes.
 *
 * **The files come back base64 in `files[].base64`, never written.** `packages/core` has no
 * filesystem - the same rule `exportAssets` follows and the reason `finalize_document` is a
 * surface rather than a command - so the caller decides where a bundle lands and this stays a pure
 * function of `(document, template, options)`.
 */
export const shareBundleCommand = defineCommand({
  name: 'share_bundle',
  description:
    'Build a share bundle from a template: the rendered PNG carrying its provenance as text chunks, an optional spritesheet, GIF, baked pose and `meta.json` with one engine\'s files, a self-contained HTML card naming every defect and every abstention, and a `share.json` record. Read-only and deterministic - the same document and template give byte-identical output, and nothing is written to disk: each file comes back in `files[].base64` for the caller to place. Carries no score, grade or percentage, only named defect codes.',
  guide:
    '## What comes back\n\n' +
    '`files` is the bundle. Every entry has a `path` **relative to the bundle directory**, forward\n' +
    'slashed on every platform, and the bytes in `base64`. Decode and write them yourself; this\n' +
    'command touches no filesystem. `record` is what goes in `share.json` - write it last, so a\n' +
    'file on disk can never disagree with the record describing it.\n\n' +
    '## No number travels\n\n' +
    'Not in `share.json`, not in the card, not in the PNG\'s text chunks. `record.issues` holds a\n' +
    '`code`, the `dimensions` that found it, a `rect`, whether it `blocks` delivery, the `message`,\n' +
    'a `disposition` and the `guidance` from `fix`. `severity` is dropped even though it is only\n' +
    '0..1: it is a number, and a number in a file people forward is what this repository has\n' +
    'already paid for. `record.notMeasured` carries every abstention in its own block - an absent\n' +
    'dimension is *not* a clean one, and `record.measuredDimensions` is exactly what measured.\n\n' +
    '## The badge is a text chunk\n\n' +
    '`record.provenance` is what the PNG carries, written by the engine in the same pass that\n' +
    'renders the pixels. It is metadata, never composited into the artwork, so decoding the shared\n' +
    'file gives the artwork back byte for byte. `Software` carries the made-with badge; there is no\n' +
    'version in it, because a version would make every shared file a diff on upgrade. A licence\n' +
    'appears only if the template declared one - it is never inferred, and absent is not public\n' +
    'domain.\n\n' +
    '## The target engine is yours\n\n' +
    '`engine` here overrides the template\'s, for the same reason it is opt-in everywhere else: a\n' +
    'tool cannot know which engine a bundle is going into. It only matters for a template with an\n' +
    '`engine` output.\n\n' +
    '## Determinism\n\n' +
    'No clock, no session id, no absolute path, no locale. `record.imageSha256` is the sha256 of the\n' +
    'PNG, so a diff shows a real change when the artwork changed and nothing when it did not.\n\n' +
    '## Templates\n\n' +
    'Pass `template` as an object - read a `*.share.json` and hand it over. Its field set is closed:\n' +
    'an unknown key is an error, not a default. `outputs` may name `png`, `frames`, `sheet`, `gif`,\n' +
    '`pose`, `meta` and `engine`; a `contact` sheet is not available here and asking for one is a\n' +
    'named refusal rather than a bundle that ships less than it claims. `assetContract` and the\n' +
    'top-level `engine` are shorthand for the matching outputs, so a template that says both does\n' +
    'not get two contracts.',
  readOnly: true,
  params: z.object({
    template: shareTemplateSchema.describe(
      'The share template: a presentation preset naming what goes in the bundle and whether a card is rendered. Read a `share-templates/*.share.json` and pass it as-is.',
    ),
    source: z
      .string()
      .optional()
      .describe('The `.pixel` path this came from, recorded verbatim in `share.json`. A declaration about the file; never hashed, and omitted when the document has never been saved.'),
    id: z.string().optional().describe('Asset id recorded in `share.json`. Defaults to the slug, which defaults to the document name.'),
    slug: z.string().optional().describe('Directory stem for the bundle. Defaults to a file-system-safe form of the id. Must be portable: it becomes every path in the bundle.'),
    title: z.string().optional().describe('Human title for the card. Derived from the id when omitted.'),
    engine: engineSchema
      .optional()
      .describe('Target engine for the `meta.json`/importer half, overriding the template\'s. Only affects a template with an `engine` output; opt-in because the target engine is the caller\'s choice and a tool cannot know it.'),
    includeSource: z
      .boolean()
      .optional()
      .describe('Write the editable `.pixel` into the bundle. Defaults to true; pass false for a bundle that is only a preview.'),
  }),
  apply(ctx, p): CommandSummary {
    const bundle = buildShareBundle(ctx.sprite, p.template, {
      ...(p.source !== undefined ? { source: p.source } : {}),
      ...(p.id !== undefined ? { id: p.id } : {}),
      ...(p.slug !== undefined ? { slug: p.slug } : {}),
      ...(p.title !== undefined ? { title: p.title } : {}),
      ...(p.engine !== undefined ? { engine: p.engine } : {}),
      ...(p.includeSource !== undefined ? { includeSource: p.includeSource } : {}),
    });
    return {
      template: p.template.id,
      slug: bundle.record.slug,
      record: bundle.record as unknown as CommandSummary,
      files: bundle.files.map((file) => ({
        path: file.path,
        role: file.role,
        mediaType: file.mediaType,
        bytes: file.bytes.byteLength,
        base64: encodeBase64(file.bytes),
      })),
      totalBytes: bundle.files.reduce((sum, file) => sum + file.bytes.byteLength, 0),
    };
  },
});

/** The share commands, in the order a caller reaches for them. */
export const shareCommands = [shareBundleCommand] as const;

/**
 * Re-exported so the engine-written badge can be checked where the bundle is built, without a
 * second `fast-png` import anywhere in the repository.
 */
export { assertPngMetadata };
