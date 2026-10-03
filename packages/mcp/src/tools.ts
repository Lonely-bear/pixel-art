/**
 * MCP tool surface.
 *
 * Two layers:
 *
 *  1. **Generated tools** - every command in `@pixel/core` is registered as an
 *     MCP tool with `inputSchema` taken straight from the command's own zod
 *     schema. There is exactly one definition of what a command accepts, so the
 *     model's tool docs and the validator can never drift.
 *  2. **Session tools** - documents, perception (preview/pixels/history) and
 *     export, which are concerns of the server rather than of the document.
 *
 * Every generated tool gets two extra arguments: `document` (which document to
 * edit, defaulting to the active one) and `expectedVersion` (optimistic
 * concurrency, so a stale agent edit fails loudly instead of clobbering work).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ContentBlock, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { SKILL_FINGERPRINT } from './server.js';
import {
  animationSequence,
  assertFinalizable,
  blendInto,
  buildSpritesheet,
  compositeFrame,
  compositeWithOnion,
  createEditor,
  describeCommand,
  describeCommands,
  encodeGIF,
  encodePNG,
  extractRegion,
  fillCommandDefaults,
  findRigPose,
  flattenAlpha,
  findRigTween,
  interpolatePose,
  renderGridView,
  rowsFromCells,
  formatGrid,
  formatGridDiff,
  diffGridRows,
  type GridView,
  requiredCommandArgs,
  frameRefSchema,
  isAseprite,
  layerRefSchema,
  qualityGateBypassNotice,
  rectSchema,
  parseColor,
  PixelBuffer,
  resolveFrame,
  resolveLayer,
  resolveDitherLevel as resolveCoreDitherLevel,
  ditherLevelResolution as coreDitherLevelResolution,
  renderInterpolatedPose,
  renderPose,
  requireRig,
  resolveRigGeometry,
  resolveTilemap,
  scaleAtlas,
  scaleNearest,
  serializeSprite,
  spriteFromAseprite,
  spriteFromPng,
  tileCount,
  toAsepriteJson,
  toTiledJson,
  type Command,
  type Frame,
  type QualityGateDecision,
  type QualityGateRun,
  type RenderedPose,
  type RigPose,
  type Sprite,
} from '@pixel/core';
import { z } from 'zod';
import { ScriptRuntime } from '@pixel/script';
import { BUILTIN_PALETTES, type DocumentStore, type PixelDocument } from './session.js';
import { PIXEL_ART_SKILL } from './skill.js';
import { advertiseSchema, TOOL_RESULT_ENVELOPE } from './surface.js';
import { analyzeTilemapQuality } from './quality-tilemap.js';
import { listRecipeIds, loadRecipe, summarise } from './recipe-catalogue.js';
import { QUALITY_OUTPUT_SCHEMA, qualityPayload } from './quality-report.js';
import { renderTilemapPreview } from './tilemap-preview.js';

/* ------------------------------------------------------------------ helpers */

const documentRef = z
  .string()
  .optional()
  .describe('Document id. Omit to operate on the active document.');
const versionRef = z
  .number()
  .int()
  .optional()
  .describe(
    'Optimistic concurrency guard. The edit is rejected with a `version_conflict` error unless the document is exactly at this version. Pass the `version` returned by your last read or write.',
  );

const spritePointSchema = z
  .object({
    x: z.number().describe('X in pixels, 0-based, origin top-left.'),
    y: z.number().describe('Y in pixels, 0-based, growing downward.'),
  })
  .strict()
  .describe('A point in canvas pixels.');

const previewRectSchema = z
  .object({
    x: z.number().int().describe('Left edge in pixels, 0-based.'),
    y: z.number().int().describe('Top edge in pixels, 0-based, y grows downward.'),
    w: z.number().int().min(1).max(4096).describe('Width in pixels.'),
    h: z.number().int().min(1).max(4096).describe('Height in pixels.'),
  })
  .strict()
  .describe('Crop to this region before upscaling, in canvas pixels. Single-frame previews only.');
const previewLayersSchema = z
  .array(layerRefSchema)
  .optional()
  .describe('Only composite these layers (ids, names or indices).');
const previewScaleSchema = z
  .number()
  .int()
  .min(1)
  .max(32)
  .optional()
  .describe('Integer upscale factor. Defaults to whatever makes the longest side about 256px.');
const previewBackgroundSchema = z
  .string()
  .nullable()
  .optional()
  .describe('Composite over this colour instead of transparency.');

const tilemapDebugSchema = z
  .object({
    grid: z.boolean().optional().describe('Draw one line at every tile boundary.'),
    indices: z.boolean().optional().describe('Print tile indices over the image.'),
    showInvalid: z.boolean().optional().describe('Outline indices outside the tileset. Defaults to true.'),
    highlightCells: z
      .array(
        z
          .object({
            x: z.number().int().describe('Tile column.'),
            y: z.number().int().describe('Tile row.'),
          })
          .strict(),
      )
      .max(4096)
      .optional()
      .describe('Exact tile cells to outline in magenta.'),
    highlightRect: z
      .object({
        x: z.number().int().describe('Left tile column.'),
        y: z.number().int().describe('Top tile row.'),
        w: z.number().int().min(1).describe('Width in tiles.'),
        h: z.number().int().min(1).describe('Height in tiles.'),
      })
      .strict()
      .optional()
      .describe('Changed tile region to outline in magenta.'),
  })
  .strict()
  .describe('Overlays drawn on the rendered map: grid lines, tile indices, invalid outlines and the cells that just changed.');

const previewOnionSchema = z
  .object({
    before: z.number().int().min(0).max(8).optional().describe('How many earlier frames to ghost in.'),
    after: z.number().int().min(0).max(8).optional().describe('How many later frames to ghost in.'),
    opacity: z.number().min(0).max(1).optional().describe('Ghost opacity, 0-1. Defaults to 0.35.'),
    loop: z.boolean().optional().describe('Wrap around, so frame 0 ghosts the last frame. Defaults to false.'),
    beforeTint: z.string().optional().describe('Tint earlier ghosts (e.g. "#ff8080") to show motion direction.'),
    afterTint: z.string().optional().describe('Tint later ghosts (e.g. "#8080ff").'),
  })
  .strict()
  .optional()
  .describe('Onion skin: draw neighbouring frames behind each rendered frame as faded ghosts.');

/** Shared sprite/tilemap preview options returned in a mutation response. */
const previewOptionsObjectSchema = z
  .object({
    frame: frameRefSchema.optional().describe('Frame id or 0-based index. Defaults to frame 0. Do not pass with frames: "all".'),
    frames: z
      .enum(['one', 'all'])
      .optional()
      .describe('"one" (default) renders one frame; "all" renders every frame as a horizontal strip.'),
    onion: previewOnionSchema,
    tilemap: z
      .union([z.string(), z.number().int()])
      .optional()
      .describe('Preview this tilemap directly instead of a composited frame. Useful in apply_ops/run_script after a tile edit.'),
    underlay: z
      .union([z.string(), z.number().int()])
      .optional()
      .describe('With `tilemap`, render this base map first and alpha-composite the active map over it.'),
    rect: previewRectSchema.optional().describe('Canvas pixels normally; tile coordinates when `tilemap` is set.'),
    layers: previewLayersSchema,
    scale: previewScaleSchema,
    background: previewBackgroundSchema,
    replaceEmpty: z.number().int().min(-1).optional().describe('Tilemap preview: render empty cells with this tile.'),
    opacity: z.number().min(0).max(1).optional().describe('Tilemap preview opacity. Defaults to 1.'),
    debug: tilemapDebugSchema.optional(),
  })
  .strict();

const pngExportSchema = z
  .object({
    path: z.string().describe('Destination PNG path.'),
    frame: frameRefSchema.optional().describe('Frame id or 0-based index. Defaults to frame 0.'),
    scale: z.number().int().min(1).max(32).optional().describe('Integer upscale factor. Defaults to 1.'),
    background: previewBackgroundSchema,
  })
  .strict();

const exportOutputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('png'),
    path: z.string(),
    frame: frameRefSchema.optional(),
    scale: z.number().int().min(1).max(32).optional(),
    background: previewBackgroundSchema,
  }).strict(),
  z.object({
    type: z.literal('frames'),
    path: z.string().describe('Filename template; `_0`, `_1`, … are inserted before the extension.'),
    scale: z.number().int().min(1).max(32).optional(),
    background: previewBackgroundSchema,
  }).strict(),
  z.object({
    type: z.literal('sheet'),
    path: z.string(),
    json: z.string().optional(),
    layout: z.enum(['horizontal', 'vertical', 'grid']).optional(),
    columns: z.number().int().min(1).optional(),
    padding: z.number().int().min(0).optional(),
    margin: z.number().int().min(0).optional(),
    scale: z.number().int().min(1).max(32).optional(),
  }).strict(),
  z.object({
    type: z.literal('gif'),
    path: z.string(),
    tag: z.union([z.string(), z.number().int()]).optional(),
    scale: z.number().int().min(1).max(32).optional(),
    background: z.string().optional(),
    loop: z.boolean().optional(),
  }).strict(),
  z.object({
    type: z.literal('pose'),
    path: z.string(),
    pose: z.string().optional(),
    tween: z.string().optional(),
    progress: z.number().min(0).max(1).optional(),
    scale: z.number().int().min(1).max(32).optional(),
    background: previewBackgroundSchema,
  }).strict(),
  z.object({
    type: z.literal('contact'),
    path: z.string(),
    tag: z.union([z.string(), z.number().int()]).optional(),
    frameOrder: z.enum(['timeline', 'playback']).optional(),
    layout: z.enum(['strip', 'grid']).optional(),
    columns: z.number().int().min(1).optional(),
    padding: z.number().int().min(0).optional(),
    margin: z.number().int().min(0).optional(),
    scale: z.number().int().min(1).max(32).optional(),
    background: previewBackgroundSchema,
  }).strict(),
]);

const exportManifestSchema = z
  .object({
    path: z.string().describe('Destination manifest JSON path.'),
    hashes: z.boolean().optional().describe('Include SHA-256 hashes. Defaults to true.'),
    incremental: z.boolean().optional().describe('Compare an existing manifest and skip files whose hashes are unchanged.'),
  })
  .strict();

/**
 * Commands that only read. Core commands declare this themselves via `readOnly`, so
 * the editor keeps them out of the undo history; this set is for the hand-registered
 * MCP tools that have no core command behind them.
 */
const READ_ONLY_TOOLS = new Set([
  'list_layers',
  'get_document',
  'get_palette',
  'get_history',
  'get_preview',
  'preview_pose',
  'preview_animation',
  'preview_tilemap',
  'get_pixels',
  'read_grid',
  'histogram',
  'get_selection',
  'evaluate',
  'list_commands',
  'describe_command',
  'find_workflow',
  'list_documents',
  'list_plugins',
  'read_skill',
  'describe_recipe',
]);

/**
 * Tools that reach outside the in-memory document: the filesystem, or arbitrary code.
 *
 * This is the hint a client uses to decide that a call is not confined to the
 * document it was asked to edit, and `run_script` and `load_plugin` - the only two
 * tools that execute code the server did not write - are the reason this set exists
 * at all rather than being left to the reader of a description string.
 */
const OPEN_WORLD_TOOLS = new Set([
  'run_script',
  'load_plugin',
  'open_document',
  'save_document',
  'finalize_document',
  'import_image',
  'export_png',
  'export_sheet',
  'export_tiled',
  'export_gif',
]);

/**
 * Tools that can destroy work rather than add to it.
 *
 * Most edits here go through the undo history, so "destructive" means *deleting or
 * replacing structure the caller may not be able to reconstruct* - dropping a layer,
 * re-paletting every pixel, closing the only document. It is the flag a client shows a
 * confirmation for, so it is set where a second call cannot reconstruct the first, and
 * left off where `undo` genuinely is the answer.
 */
const DESTRUCTIVE_TOOLS = new Set([
  'close_document',
  'clear_all',
  'crop_canvas',
  'merge_layer_down',
  'prune_palette',
  'quantize_to_palette',
  'remove_anchor',
  'remove_frame',
  'remove_hitbox',
  'remove_layer',
  'remove_map_object',
  'remove_palette_color',
  'remove_part',
  'remove_pose',
  'remove_tag',
  'remove_tile_properties',
  'remove_tilemap',
  'remove_tween',
  'resize_canvas',
  'set_palette',
]);

/**
 * The four MCP risk hints, derived rather than hand-written per tool.
 *
 * 100 of 127 tools previously shipped an empty `annotations` object, which a client
 * reads as "unknown" and treats like "safe". Deriving them from three sets means a
 * new tool is annotated by construction: name it `get_*` and it is read-only and
 * idempotent, name it `export_*` and it is open-world, and anything that deletes says
 * so. An explicit override still wins, for the tool whose behaviour does not fit its
 * name.
 */
function toolAnnotations(name: string, override?: Partial<ToolAnnotations>): ToolAnnotations {
  const readOnly = override?.readOnlyHint ?? READ_ONLY_TOOLS.has(name);
  return {
    readOnlyHint: readOnly,
    destructiveHint: override?.destructiveHint ?? (!readOnly && DESTRUCTIVE_TOOLS.has(name)),
    idempotentHint: override?.idempotentHint ?? readOnly,
    openWorldHint: override?.openWorldHint ?? OPEN_WORLD_TOOLS.has(name),
  };
}

/**
 * The hand-registered session tools, so `list_commands` can advertise them.
 *
 * `list_commands` only knows about the *command registry*; `undo`, `redo` and
 * `get_history` are editor concerns with no core command behind them, and the
 * perception/export tools are server concerns too. Without this list an agent that
 * reads `list_commands` (as the skill tells it to) never discovers that undo exists.
 */
const SESSION_TOOLS: Array<{ name: string; description: string }> = [
  { name: 'undo', description: 'Undo the last edit(s).' },
  { name: 'redo', description: 'Redo undone edit(s).' },
  { name: 'get_history', description: 'Recent commands with labels and summaries.' },
  { name: 'get_preview', description: 'Render the sprite (or a rect) as a PNG to look at.' },
  { name: 'preview_pose', description: 'Render a rig pose or tween progress as a PNG and resolve anchor/hitbox world geometry.' },
  { name: 'preview_animation', description: 'Render a timeline or tag-expanded playback contact sheet with optional onion skin.' },
  { name: 'preview_tilemap', description: 'Render an unbaked tilemap with optional grid, tile-index and changed-cell overlays.' },
  { name: 'get_pixels', description: 'Exact pixel colours in a small region.' },
  { name: 'read_grid', description: 'The artwork as a character grid: silhouette, luminance, palette slot or colour name. The default way to check a drawing.' },
  { name: 'histogram', description: 'Per-colour pixel counts and unused palette slots for a region.' },
  { name: 'get_selection', description: "The rectangle the user boxed in the app, with its layer and frame." },
  { name: 'evaluate', description: 'Measure the artwork with the quality dimensions and return the report. Diagnostics for finding defects, not a score to climb.' },
  { name: 'set_selection', description: 'Box a region on the app canvas, or clear the box.' },
  { name: 'get_document', description: 'Layers, frames, tags, palette.' },
  { name: 'get_palette', description: 'Palette as hex colours with indices.' },
  { name: 'list_documents', description: 'List open documents.' },
  { name: 'create_document', description: 'Create a blank sprite document.' },
  { name: 'create_sprite_spec', description: 'Create sprite structure, animation tags, palette roles and an optional rig from one declarative spec.' },
  { name: 'open_document', description: 'Load a `.pixel` document.' },
  { name: 'save_document', description: 'Save to a `.pixel` file.' },
  { name: 'finalize_document', description: 'Save the editable source and render PNG/frame/sheet/GIF/contact outputs plus an optional manifest.' },
  { name: 'import_image', description: 'Import a PNG or Aseprite file.' },
  { name: 'select_document', description: 'Make a document active.' },
  { name: 'close_document', description: 'Drop a document from the session.' },
  { name: 'export_png', description: 'Write the sprite to a PNG.' },
  { name: 'export_sheet', description: 'Spritesheet PNG + Aseprite JSON.' },
  { name: 'export_tiled', description: 'Tilemaps as a Tiled `.tmj` map.' },
  { name: 'export_gif', description: 'Write an animated GIF.' },
  { name: 'apply_ops', description: 'Run any commands from the catalogue in one round trip, with optional atomic rollback and an inline preview.' },
  { name: 'run_script', description: 'Run trusted JavaScript against the document, collapsing into one undo step, with an optional dry run.' },
  { name: 'load_plugin', description: 'Load a plugin defining commands. Untrusted: it becomes tools with your document\'s authority.' },
  { name: 'list_plugins', description: 'The plugins loaded in this session and the commands each registered.' },
  { name: 'read_skill', description: 'The pixel-art craft guide, served as pixel://skill.' },
  { name: 'list_commands', description: 'The command catalogue. Looking one up by name also promotes it to a direct tool.' },
  { name: 'describe_command', description: 'One exact command schema plus its long-form manual; also promotes it to a direct tool.' },
  { name: 'find_workflow', description: 'Task-level workflows, with their recommended commands promoted to direct tools.' },
  { name: 'describe_recipe', description: 'The art-direction recipe for one class of game asset: sizes, palette, layers, tone, steps, mistakes and read-only checks.' },
];

/**
 * Names a promoted core command is not allowed to take.
 *
 * Derived from {@link SESSION_TOOLS}, so it cannot drift from what is actually
 * registered. This exists because the SDK's `registerTool` **throws** on a duplicate
 * name, and the command catalogue and the session tools do not have disjoint names by
 * construction: `evaluate` is a session tool *and* a core command (the quality
 * pipeline's command boundary). Without this guard, one `describe_command {name:
 * "evaluate"}` would take the whole server down with `Tool evaluate is already
 * registered`.
 *
 * The session tool wins, for two reasons. It is the one that is already advertised, so
 * a client already has its schema and can call it; and the command is still reachable,
 * since every command runs through `apply_ops` whether or not it was ever promoted.
 */
const SESSION_TOOL_NAMES: ReadonlySet<string> = new Set(SESSION_TOOLS.map((tool) => tool.name));

function text(value: string): ContentBlock {
  return { type: 'text', text: value };
}

/**
 * Which arguments each command genuinely requires, cached per command name.
 * Used to decide where the MCP surface may supply an ergonomic default.
 */
const requiredArgsCache = new Map<string, Set<string>>();

function requiredArgsOf(command: Command): Set<string> {
  const existing = requiredArgsCache.get(command.name);
  if (existing) return existing;
  const required = requiredCommandArgs(command);
  requiredArgsCache.set(command.name, required);
  return required;
}

/**
 * Fill in the arguments an agent should not have to spell out: the bottom layer
 * and frame 0. Only applied where the command actually requires them, so
 * commands that treat `layer`/`frame` as an optional filter keep their meaning.
 */
function fillDefaults(sprite: Sprite, command: Command, params: Record<string, unknown>): void {
  Object.assign(params, fillCommandDefaults(sprite, command, params));
}

/**
 * Shorten a validation error so a failed op does not bury the response.
 *
 * A zod union error for a six-pixel `draw_pixels` op runs to about five kilobytes of
 * nested alternatives, and `quiet` cannot shrink it because the message is produced
 * before `quiet` is consulted. The first few hundred characters always name the
 * offending key, which is all an agent needs to fix the call.
 */
function briefError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 300 ? message : `${message.slice(0, 300)}…`;
}

function ok(payload: Record<string, unknown>, extra: ContentBlock[] = []): CallToolResult {
  return {
    content: [...extra, text(JSON.stringify(payload, null, 2))],
    structuredContent: payload,
  };
}

function fail(message: string, details?: Record<string, unknown>): CallToolResult {
  return {
    isError: true,
    content: [text(JSON.stringify({ ok: false, error: message, ...details }, null, 2))],
    structuredContent: { ok: false, error: message, ...details },
  };
}

function binaryImageContent(bytes: Uint8Array, mimeType: string): ContentBlock {
  return {
    type: 'image',
    data: Buffer.from(bytes).toString('base64'),
    mimeType,
  };
}

function imageContent(buffer: PixelBuffer): ContentBlock {
  return binaryImageContent(encodePNG(buffer), 'image/png');
}

/** Integer upscale so a 16x16 sprite is actually legible to a vision model. */
function previewFactor(width: number, height: number, target: number, max: number): number {
  const longest = Math.max(width, height);
  if (longest <= 0) return 1;
  return Math.max(1, Math.min(max, Math.floor(target / longest) || 1));
}

function resolveBackground(value: string | null | undefined) {
  return value == null ? null : parseColor(value);
}

interface PreviewOnionOptions {
  before?: number;
  after?: number;
  opacity?: number;
  loop?: boolean;
  beforeTint?: string;
  afterTint?: string;
}

interface PreviewRenderOptions {
  frame?: number | string;
  tilemap?: string | number;
  underlay?: string | number;
  rect?: { x: number; y: number; w: number; h: number };
  layers?: Array<string | number>;
  scale?: number;
  background?: string | null;
  replaceEmpty?: number;
  opacity?: number;
  debug?: {
    grid?: boolean;
    indices?: boolean;
    showInvalid?: boolean;
    highlightCells?: Array<{ x: number; y: number }>;
    highlightRect?: { x: number; y: number; w: number; h: number };
  };
  frames?: 'one' | 'all';
  onion?: PreviewOnionOptions;
}

/** Even a valid 32x request can ask a 4096px canvas for a four-gigapixel image. */
const MAX_PREVIEW_OUTPUT_PIXELS = 16_777_216;

function assertPreviewOutputSize(width: number, height: number, factor: number): void {
  const outputWidth = width * factor;
  const outputHeight = height * factor;
  if (outputWidth * outputHeight > MAX_PREVIEW_OUTPUT_PIXELS) {
    throw new Error(
      `Preview would be ${outputWidth}x${outputHeight} (${outputWidth * outputHeight} pixels), above the ${MAX_PREVIEW_OUTPUT_PIXELS}-pixel safety limit. Reduce scale or crop with rect.`,
    );
  }
}

/** Join the compact boolean switch, its options object and the legacy frame alias. */
function inlinePreviewOptions(
  enabled: unknown,
  value: unknown,
  legacyFrame?: number | string,
): PreviewRenderOptions | undefined {
  if (enabled !== true) return undefined;
  if (!value || typeof value !== 'object') return { frame: legacyFrame };
  const options = value as PreviewRenderOptions;
  return { ...options, frame: options.frame ?? legacyFrame };
}

/** Shared renderer for get_preview and mutation tools that return an inline preview. */
function previewPayload(
  sprite: Sprite,
  options: PreviewRenderOptions = {},
): { blocks: ContentBlock[]; meta: Record<string, unknown> } {
  if (options.underlay !== undefined && options.tilemap === undefined) {
    throw new Error('`underlay` requires `tilemap` in previewOptions.');
  }
  if (options.tilemap !== undefined) {
    if (options.frame !== undefined) {
      throw new Error('A tilemap preview cannot also name a `frame`.');
    }
    if (options.layers || options.onion || options.frames === 'all') {
      throw new Error('A tilemap preview cannot also use `layers`, `onion` or `frames: "all"`.');
    }
    const tilemap = resolveTilemap(sprite, options.tilemap);
    const underlay = options.underlay === undefined
      ? undefined
      : resolveTilemap(sprite, options.underlay);
    const rendered = renderTilemapPreview(sprite, tilemap, {
      rect: options.rect,
      underlay,
      scale: options.scale,
      background: options.background === undefined ? undefined : resolveBackground(options.background),
      replaceEmpty: options.replaceEmpty,
      opacity: options.opacity,
      debug: options.debug,
    });
    return {
      blocks: [imageContent(rendered.image)],
      meta: { ...rendered.meta, structure: rendered.structure },
    };
  }

  if (options.frames === 'all' && options.frame !== undefined) {
    throw new Error('Pass either `frame` or `frames: "all"`, not both.');
  }

  const background = resolveBackground(options.background);
  const layerIds = options.layers?.map((ref) => resolveLayer(sprite, ref).id);
  const onion = options.onion;
  const renderFrame = (frameId: string): PixelBuffer => {
    const renderOptions = {
      background,
      layers: layerIds,
      before: onion?.before,
      after: onion?.after,
      opacity: onion?.opacity,
      loop: onion?.loop,
      beforeTint: onion?.beforeTint,
      afterTint: onion?.afterTint,
    };
    return onion
      ? compositeWithOnion(sprite, frameId, renderOptions)
      : compositeFrame(sprite, frameId, { background, layers: layerIds });
  };

  let buffer: PixelBuffer;
  let meta: Record<string, unknown>;
  const allFrames = options.frames === 'all' && sprite.frames.length > 1;
  if (allFrames) {
    const gap = 1;
    const stripWidth = sprite.frames.length * sprite.width + (sprite.frames.length - 1) * gap;
    const factor = options.scale ?? previewFactor(stripWidth, sprite.height, 256, 16);
    // Check the logical strip before allocating it. Rendering each frame first can
    // otherwise consume gigabytes before the existing output-size guard runs.
    assertPreviewOutputSize(stripWidth, sprite.height, factor);
    const strip = new PixelBuffer(stripWidth, sprite.height);
    sprite.frames.forEach((frame, index) => strip.blit(renderFrame(frame.id), index * (sprite.width + gap), 0));
    buffer = strip;
    meta = {
      mode: 'all-frames',
      frameCount: sprite.frames.length,
      sheetWidth: strip.width,
      sheetHeight: strip.height,
      layout: 'horizontal strip, 1px gap, frames left to right',
    };
  } else {
    const frame = resolveFrame(sprite, options.frame ?? 0);
    buffer = renderFrame(frame.id);
    meta = {
      mode: 'single-frame',
      frame: sprite.frames.findIndex((f) => f.id === frame.id),
      frameId: frame.id,
      durationMs: frame.durationMs,
    };
  }

  if (options.rect && allFrames) {
    throw new Error('`rect` crops a single frame; drop `frames: "all"` or read one frame at a time.');
  }
  if (options.rect) buffer = extractRegion(buffer, options.rect);

  const factor = options.scale ?? previewFactor(buffer.width, buffer.height, 256, 16);
  assertPreviewOutputSize(buffer.width, buffer.height, factor);
  const shown = factor > 1 ? scaleNearest(buffer, factor) : buffer;
  return {
    blocks: [imageContent(shown)],
    meta: {
      ...meta,
      width: sprite.width,
      height: sprite.height,
      ...(options.rect ? { rect: options.rect } : {}),
      ...(layerIds ? { layers: layerIds } : {}),
      ...(onion ? { onion } : {}),
      upscale: factor,
      scale: factor,
      imageWidth: shown.width,
      imageHeight: shown.height,
    },
  };
}

interface PreviewAnimationOptions {
  tag?: string | number;
  frameOrder?: 'timeline' | 'playback';
  format?: 'png' | 'gif';
  loop?: boolean;
  layout?: 'strip' | 'grid';
  columns?: number;
  padding?: number;
  margin?: number;
  onion?: {
    before?: number;
    after?: number;
    opacity?: number;
    loop?: boolean;
    beforeTint?: string;
    afterTint?: string;
  };
  layers?: Array<string | number>;
  scale?: number;
  background?: string | null;
  includeMetadata?: boolean;
}

function blendAnimationFrame(
  target: PixelBuffer,
  source: PixelBuffer,
  opacity: number,
  tint: ReturnType<typeof parseColor> | null,
): void {
  if (opacity <= 0) return;
  for (let i = 0; i < source.data.length; i += 4) {
    const alpha = source.data[i + 3];
    if (alpha === 0) continue;
    const color = tint
      ? { r: tint.r, g: tint.g, b: tint.b, a: alpha }
      : { r: source.data[i], g: source.data[i + 1], b: source.data[i + 2], a: alpha };
    blendInto(target.data, i, color, { opacity });
  }
}

/** Render an animation in raw timeline or tag-expanded playback order as one contact sheet. */
function animationPreviewPayload(
  sprite: Sprite,
  options: PreviewAnimationOptions = {},
): { blocks: ContentBlock[]; meta: Record<string, unknown>; image?: PixelBuffer } {
  const frameOrder = options.frameOrder ?? (options.tag === undefined ? 'timeline' : 'playback');
  if (frameOrder === 'playback' && options.tag === undefined) {
    throw new Error('Playback preview requires a `tag`; use frameOrder: "timeline" to preview the whole document.');
  }
  const sequence = frameOrder === 'timeline'
    ? animationSequence(sprite)
    : animationSequence(sprite, options.tag);
  if (sequence.frames.length === 0) throw new Error('Animation preview has no frames.');

  if (options.format === 'gif') {
    const scale = Math.max(1, Math.floor(options.scale ?? 1));
    const playbackTag = frameOrder === 'playback' ? options.tag : undefined;
    const bytes = encodeGIF(sprite, {
      tag: playbackTag,
      scale,
      background: options.background,
      loop: options.loop,
    });
    return {
      blocks: [binaryImageContent(bytes, 'image/gif')],
      meta: {
        mode: 'animation-preview',
        format: 'gif',
        frameOrder,
        tag: sequence.name,
        frameCount: sequence.frames.length,
        loops: options.loop ?? sequence.loops,
        durationMs: sequence.durationMs,
        scale,
        imageWidth: sprite.width * scale,
        imageHeight: sprite.height * scale,
        ...(options.includeMetadata === false
          ? {}
          : {
              sequence: sequence.frames.map((frame, position) => ({
                position,
                index: frame.index,
                frameId: frame.frameId,
                durationMs: frame.durationMs,
              })),
            }),
      },
    };
  }

  const count = sequence.frames.length;
  const layout = options.layout ?? 'grid';
  const padding = Math.max(0, Math.floor(options.padding ?? 1));
  const margin = Math.max(0, Math.floor(options.margin ?? 1));
  const columns = layout === 'strip'
    ? count
    : Math.max(1, Math.min(count, options.columns ?? Math.ceil(Math.sqrt(count))));
  const rows = Math.ceil(count / columns);
  const sheetWidth = margin * 2 + columns * sprite.width + Math.max(0, columns - 1) * padding;
  const sheetHeight = margin * 2 + rows * sprite.height + Math.max(0, rows - 1) * padding;
  const factor = options.scale ?? previewFactor(sheetWidth, sheetHeight, 256, 16);
  assertPreviewOutputSize(sheetWidth, sheetHeight, factor);

  const background = resolveBackground(options.background);
  const layerIds = options.layers?.map((ref) => resolveLayer(sprite, ref).id);
  const onion = options.onion;
  const onionOpacity = Math.min(1, Math.max(0, onion?.opacity ?? 0.35));
  const beforeTint = onion?.beforeTint === undefined ? null : parseColor(onion.beforeTint);
  const afterTint = onion?.afterTint === undefined ? null : parseColor(onion.afterTint);
  const sheet = new PixelBuffer(sheetWidth, sheetHeight);

  sequence.frames.forEach((entry, position) => {
    const cell = new PixelBuffer(sprite.width, sprite.height);
    if (background !== undefined && background !== null) cell.fill(background);
    const neighbor = (offset: number): typeof entry | undefined => {
      let index = position + offset;
      if (onion?.loop) index = ((index % count) + count) % count;
      if (index < 0 || index >= count || index === position) return undefined;
      return sequence.frames[index];
    };
    const ghost = (offset: number, tint: ReturnType<typeof parseColor> | null): void => {
      const frame = neighbor(offset);
      if (!frame) return;
      blendAnimationFrame(
        cell,
        compositeFrame(sprite, frame.frameId, { layers: layerIds }),
        onionOpacity,
        tint,
      );
    };
    for (let offset = onion?.before ?? 0; offset >= 1; offset--) ghost(-offset, beforeTint);
    for (let offset = onion?.after ?? 0; offset >= 1; offset--) ghost(offset, afterTint);
    blendAnimationFrame(cell, compositeFrame(sprite, entry.frameId, { layers: layerIds }), 1, null);

    const column = position % columns;
    const row = Math.floor(position / columns);
    sheet.blit(cell, margin + column * (sprite.width + padding), margin + row * (sprite.height + padding));
  });

  const shown = factor > 1 ? scaleNearest(sheet, factor) : sheet;
  const metadata = {
    mode: 'animation-preview',
    format: 'png',
    frameOrder,
    tag: sequence.name,
    layout,
    columns,
    rows,
    frameCount: count,
    loops: sequence.loops,
    durationMs: sequence.durationMs,
    onion: onion ?? null,
    layers: layerIds ?? null,
    scale: factor,
    imageWidth: shown.width,
    imageHeight: shown.height,
    ...(options.includeMetadata === false
      ? {}
      : {
          sequence: sequence.frames.map((frame, position) => ({
            position,
            index: frame.index,
            frameId: frame.frameId,
            durationMs: frame.durationMs,
          })),
        }),
  };
  return { blocks: [imageContent(shown)], meta: metadata, image: shown };
}

/** Best-effort structured description of a sprite for `get_document`. */
function describeSprite(sprite: Sprite): Record<string, unknown> {
  return {
    id: sprite.id,
    name: sprite.name,
    width: sprite.width,
    height: sprite.height,
    durationMs: sprite.frames.reduce((sum, f) => sum + f.durationMs, 0),
    layers: sprite.layers.map((l, index) => ({
      index,
      id: l.id,
      name: l.name,
      visible: l.visible,
      locked: l.locked,
      opacity: l.opacity,
      blendMode: l.blendMode,
    })),
    frames: sprite.frames.map((f, index) => ({
      index,
      id: f.id,
      durationMs: f.durationMs,
      // Paint order, bottom first — not cel insertion order, which is arbitrary.
      layers: sprite.layers.filter((l) => f.cels.has(l.id)).map((l) => l.name),
    })),
    tags: sprite.tags.map((t) => ({
      id: t.id,
      name: t.name,
      from: t.from,
      to: t.to,
      direction: t.direction,
      repeat: t.repeat,
    })),
    palette: {
      name: sprite.palette.name,
      size: sprite.palette.colors.length,
      roles: sprite.palette.roles ?? {},
    },
    rig: sprite.rig
      ? {
          restFrameId: sprite.rig.restFrameId,
          partCount: sprite.rig.parts.length,
          poseCount: sprite.rig.poses.length,
          tweenCount: sprite.rig.tweens.length,
          anchorCount: sprite.rig.anchors.length,
          hitboxCount: sprite.rig.hitboxes.length,
        }
      : null,
    paletteLocked: sprite.paletteLocked ?? false,
    celCount: sprite.frames.reduce((sum, f) => sum + f.cels.size, 0),
    hasTileset: Boolean(sprite.tileset),
    tilePropertyCount: Object.keys(sprite.tileset?.tileProperties ?? {}).length,
    tilemaps: sprite.tilemaps?.map((t) => ({ id: t.id, name: t.name, width: t.width, height: t.height })) ?? [],
    mapObjects: sprite.mapObjects?.map((object) => ({
      id: object.id,
      name: object.name,
      type: object.type,
      x: object.x,
      y: object.y,
      width: object.width,
      height: object.height,
      tile: object.tile ?? null,
      propertyCount: Object.keys(object.properties).length,
    })) ?? [],
  };
}

/**
 * How many distinct coverage levels a pattern can actually produce.
 *
 * The ordered patterns decide per pixel by comparing a threshold matrix against
 * `level`, so the requested value is silently floored to the next available step:
 * `cluster2`/`cluster4`/`bayer4` have 16, `bayer8` has 64, and the binary patterns
 * (checker, dots, sparse, lines) have two. Asking for 0.08 and 0.10 therefore
 * produces the identical field. Report the resolved value rather than making the
 * caller read the rasteriser to discover it.
 */
function ditherLevelResolution(pattern: string): number {
  return coreDitherLevelResolution(pattern as Parameters<typeof coreDitherLevelResolution>[0]);
}

function resolveDitherLevel(pattern: string, level: number): number {
  return resolveCoreDitherLevel(pattern as Parameters<typeof resolveCoreDitherLevel>[0], level);
}

/** Area a dither op will cover, or 0 when it targets the whole cel. */
function ditherRegionArea(params: Record<string, unknown>): number {
  const areaOf = (rect: unknown): number => {
    if (!rect || typeof rect !== 'object') return 0;
    const r = rect as { w?: unknown; h?: unknown };
    const w = typeof r.w === 'number' ? r.w : 0;
    const h = typeof r.h === 'number' ? r.h : 0;
    return w > 0 && h > 0 ? w * h : 0;
  };
  const rect = params.rect as unknown;
  if (rect) return areaOf(rect);
  const shape = params.shape as Record<string, unknown> | undefined;
  if (shape) {
    if (shape.rect) return areaOf(shape.rect);
    if (shape.ellipse) return areaOf(shape.ellipse);
    if (Array.isArray(shape.polygon) && shape.polygon.length >= 3) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const point of shape.polygon as Array<{ x?: unknown; y?: unknown }>) {
        const x = typeof point?.x === 'number' ? point.x : 0;
        const y = typeof point?.y === 'number' ? point.y : 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      const w = maxX - minX + 1;
      const h = maxY - minY + 1;
      return w > 0 && h > 0 ? w * h : 0;
    }
  }
  return 0;
}

/** A dither field bigger than this reads as texture, not as a tone. */
const DITHER_FIELD_AREA_LIMIT = 1500;

/**
 * Advisory checks for one `dither_fill` op, returned as human-readable strings.
 *
 * The failure this catches is the most common way a large canvas turns to mud: one
 * low-coverage stipple spread across a whole region. A 3-5px seam between two tones
 * is correct; the same level across 40x40 pixels is a lattice you can trace.
 */
function ditherAdvisories(params: Record<string, unknown>): string[] {
  const notes: string[] = [];
  const pattern = typeof params.pattern === 'string' ? params.pattern : 'bayer4';
  const requested = typeof params.level === 'number' ? params.level : 0.5;
  const resolved = resolveDitherLevel(pattern, requested);
  if (Math.abs(resolved - requested) > 0.01) {
    notes.push(
      `level ${requested} resolves to ${resolved} for pattern "${pattern}"; it quantises to ${1 / ditherLevelResolution(pattern)}.`,
    );
  }
  const area = ditherRegionArea(params);
  if (area > DITHER_FIELD_AREA_LIMIT && resolved > 0 && resolved < 0.5) {
    notes.push(
      `This dithers ${area}px at level ${resolved}. Past about ${DITHER_FIELD_AREA_LIMIT}px a low-coverage field stops reading as a tone and reads as a visible lattice. Shrink it to a 3-5px seam, raise the level, or use "cluster4".`,
    );
  }
  return notes;
}

/**
 * Condense one JSON Schema property into a short type hint.
 *
 * `list_commands` used to return every full schema - about 188 kB, which an agent
 * had to write a script to read. Almost always all it wants is the shape of the
 * parameters, so the default answer is one short line per command; `verbose: true`
 * still returns the real schemas for anything that needs the detail.
 */
function compactType(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return 'any';
  const node = schema as Record<string, unknown>;
  if (Array.isArray(node.enum)) return node.enum.map((value) => JSON.stringify(value)).join('|');
  if (Array.isArray(node.anyOf)) {
    return [...new Set(node.anyOf.map((option) => compactType(option)))].join('|');
  }
  if (node.type === 'array') return `${compactType(node.items)}[]`;
  if (typeof node.type === 'string') return node.type;
  return 'any';
}

interface CompactCommand {
  name: string;
  description: string;
  readOnly: boolean;
  params: Record<string, string>;
  required: string[];
}

function compactCommand(command: ReturnType<typeof describeCommands>[number]): CompactCommand {
  const schema = command.params as { properties?: Record<string, unknown>; required?: string[] };
  const required = schema.required ?? [];
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    params[key] = `${compactType(value)}${required.includes(key) ? '' : '?'}`;
  }
  return {
    name: command.name,
    description: command.description,
    readOnly: command.readOnly === true,
    params,
    required,
  };
}

/**
 * Command names a piece of prose is actually recommending.
 *
 * Workflow steps are written for a reader, so they name commands in backticks
 * (`stroke_tilemap`) or bare (`Use add_palette_ramp next`). Matching snake_case tokens
 * against the registry is enough to turn "here is a plan" into "here are your tools",
 * and a token that is not a real command is simply dropped.
 */
function commandsMentioned(text: readonly string[], store: DocumentStore): string[] {
  const found = new Set<string>();
  for (const line of text) {
    for (const token of line.match(/[a-z][a-z0-9]*_[a-z0-9_]+/g) ?? []) {
      if (store.registry.get(token)) found.add(token);
    }
  }
  return [...found];
}

/**
 * The nearest name in a namespace, or undefined when nothing is close.
 *
 * A plain edit distance is enough here: the caller only needs to be pointed at the
 * right list, and a wrong-but-near suggestion is still more useful than none because
 * the response also says which namespace it came from.
 */
function closest(name: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const score = editDistance(name, candidate);
    // More than a third of the name's length off is not a near-miss, it is a guess.
    if (score <= Math.max(2, Math.ceil(name.length / 3)) && score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * What to change after a failed op.
 *
 * Three failures account for nearly all of them, and each has one obvious next step:
 * a name that is not in the catalogue, a parameter the command does not have, and a
 * layer/frame that does not exist. Anything else is left to the error text, because a
 * confident wrong suggestion is worse than none.
 */
function commandRemediation(command: string, code: string, error: string): string | undefined {
  if (code === 'unknown_command') {
    return `Search the catalogue with list_commands {filter: "${command}"}, or read its exact schema with describe_command {name: "..."} before using it.`;
  }
  if (code === 'invalid_params') {
    if (/unrecognized key/i.test(error)) {
      return `That parameter name does not exist. Call describe_command {name: "${command}"} for the exact list - a near-miss like this is silently expensive elsewhere.`;
    }
    if (/required|expected .* received undefined/i.test(error)) {
      return `A required parameter is missing. describe_command {name: "${command}"} lists which are required.`;
    }
    return `Check the shape of the params against describe_command {name: "${command}"}.`;
  }
  if (code === 'command_failed' && /unknown (layer|frame|tilemap|tag|part|pose|tile)/i.test(error)) {
    const what = /unknown (\w+)/i.exec(error)?.[1] ?? 'target';
    return `That ${what} does not exist. Call get_document to see the real names, then use the name or a 0-based index rather than inventing one.`;
  }
  if (code === 'command_failed' && /no tileset/i.test(error)) {
    return 'Run create_tileset before any tilemap command.';
  }
  return undefined;
}

function writeFile(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

/**
 * Absolute form of a written path. The tools report the path the caller passed (often
 * relative), but a caller usually needs to open or reference the file, and `resolve`
 * against the server's working directory gives them something they can use directly.
 */
function absPath(path: string): string {
  return resolve(path);
}

/**
 * Expand a leading `~` to the home directory.
 *
 * An agent that has just been told a path is "relative to the working directory" will
 * still write `~/sprites/hero.js`, because that is what a person would write. The other
 * path-taking tools do not do this, but they also do not take a path an agent is
 * expected to retype on every call.
 */
function expandHome(path: string): string {
  if (path !== '~' && !path.startsWith('~/') && !path.startsWith('~\\')) return path;
  const home = homedir();
  return path === '~' ? home : resolve(home, path.slice(2));
}

type ExportOutputSpec = z.infer<typeof exportOutputSchema>;

interface RenderedExportFile {
  path: string;
  bytes: Uint8Array;
  type: string;
  width?: number;
  height?: number;
  details?: Record<string, unknown>;
}

function indexedOutputPath(path: string, index: number): string {
  const dot = path.lastIndexOf('.');
  return dot > 0 ? `${path.slice(0, dot)}_${index}${path.slice(dot)}` : `${path}_${index}`;
}

function renderExportOutputs(sprite: Sprite, outputs: ExportOutputSpec[]): RenderedExportFile[] {
  const files: RenderedExportFile[] = [];
  const addPng = (
    path: string,
    image: PixelBuffer,
    type: string,
    details?: Record<string, unknown>,
  ): void => {
    files.push({ path, bytes: encodePNG(image), type, width: image.width, height: image.height, details });
  };

  for (const output of outputs) {
    if (output.type === 'png') {
      const frame = resolveFrame(sprite, output.frame ?? 0);
      let image = compositeFrame(sprite, frame.id, { background: output.background });
      const scale = output.scale ?? 1;
      if (scale > 1) image = scaleNearest(image, scale);
      addPng(output.path, image, 'png', {
        frame: sprite.frames.findIndex((item) => item.id === frame.id),
        frameId: frame.id,
        scale,
      });
      continue;
    }

    if (output.type === 'frames') {
      const scale = output.scale ?? 1;
      sprite.frames.forEach((frame, index) => {
        let image = compositeFrame(sprite, frame.id, { background: output.background });
        if (scale > 1) image = scaleNearest(image, scale);
        addPng(indexedOutputPath(output.path, index), image, 'png', {
          frame: index,
          frameId: frame.id,
          scale,
          output: 'frames',
        });
      });
      continue;
    }

    if (output.type === 'sheet') {
      const atlas = buildSpritesheet(sprite, {
        layout: output.layout,
        columns: output.columns,
        padding: output.padding,
        margin: output.margin,
      });
      const sheet = scaleAtlas(atlas, output.scale ?? 1);
      const fileName = output.path.split(/[\\/]/).pop() ?? 'sheet.png';
      const jsonPath = output.json ?? output.path.replace(/\.png$/i, '') + '.json';
      addPng(output.path, sheet.image, 'sheet', { columns: sheet.columns, rows: sheet.rows, tags: sheet.tags });
      files.push({
        path: jsonPath,
        bytes: Buffer.from(JSON.stringify(toAsepriteJson(sprite, sheet, fileName), null, 2), 'utf8'),
        type: 'json',
        details: { companion: 'sheet' },
      });
      continue;
    }

    if (output.type === 'gif') {
      const sequence = animationSequence(sprite, output.tag);
      const bytes = encodeGIF(sprite, {
        tag: output.tag,
        scale: output.scale,
        background: output.background,
        loop: output.loop,
      });
      files.push({
        path: output.path,
        bytes,
        type: 'gif',
        width: sprite.width * (output.scale ?? 1),
        height: sprite.height * (output.scale ?? 1),
        details: {
          tag: sequence.name,
          frameCount: sequence.frames.length,
          durationMs: sequence.durationMs,
          loops: sequence.loops,
        },
      });
      continue;
    }

    if (output.type === 'pose') {
      const rig = requireRig(sprite);
      const progress = output.progress ?? 1;
      let rendered: RenderedPose;
      let resolvedPose: RigPose;
      if (output.tween !== undefined) {
        const tween = findRigTween(rig, output.tween);
        const from = findRigPose(rig, tween.fromPoseId);
        const to = findRigPose(rig, tween.toPoseId);
        resolvedPose = { id: '__export_tween__', name: tween.name, transforms: interpolatePose(rig, from, to, progress, tween.easing) };
        rendered = renderInterpolatedPose(sprite, from, to, progress, tween.easing);
      } else {
        if (!output.pose) throw new Error('Pose export requires `pose` or `tween`.');
        const pose = findRigPose(rig, output.pose);
        resolvedPose = pose;
        if (progress < 1) {
          const identity = { id: '__identity__', name: 'identity', transforms: {} };
          resolvedPose = { id: '__export_pose__', name: pose.name, transforms: interpolatePose(rig, identity, pose, progress) };
          rendered = renderInterpolatedPose(sprite, identity, pose, progress);
        } else {
          rendered = renderPose(sprite, pose);
        }
      }
      const scale = output.scale ?? 1;
      let image = output.background == null ? rendered.buffer : flattenAlpha(rendered.buffer, output.background);
      if (scale > 1) image = scaleNearest(image, scale);
      addPng(output.path, image, 'pose', {
        pose: resolvedPose.name,
        tween: output.tween ?? null,
        progress,
        partBounds: rendered.partBounds,
        partBoundsById: rendered.partBoundsById,
        partPixels: rendered.partPixels,
        clippedParts: rendered.clippedParts,
        geometry: resolveRigGeometry(sprite, resolvedPose),
      });
      continue;
    }

    const contact = animationPreviewPayload(sprite, {
      tag: output.tag,
      frameOrder: output.frameOrder,
      layout: output.layout,
      columns: output.columns,
      padding: output.padding,
      margin: output.margin,
      scale: output.scale,
      background: output.background,
      includeMetadata: true,
    });
    addPng(output.path, contact.image!, 'contact', contact.meta);
  }

  if (files.length > 512) {
    throw new Error(`Export plan would write ${files.length} files, above the 512-file safety limit.`);
  }
  return files;
}

interface RawOp {
  command?: unknown;
  name?: unknown;
  params?: unknown;
  args?: unknown;
  label?: unknown;
  [key: string]: unknown;
}

/**
 * Accept `{command, params}`, `{command, args}`, or `{command, ...inline}`.
 *
 * `name` doubles as an alias for `command`, but only when `command` is absent -
 * otherwise a command whose own parameters include `name` (like `add_tag`) would
 * lose it.
 */
const WORKFLOW_CATALOG = [
  {
    id: 'single-sprite',
    title: 'Draw one good sprite',
    keywords: [
      'sprite', 'draw', 'character', 'prop', 'item', 'creature', 'portrait', 'icon', 'one',
      'static', 'single frame', 'first', 'lantern', 'sword', 'tree', 'slime', 'hero',
    ],
    steps: [
      'Scaffold with create_sprite_spec: size, layer names, and palette roles so the ramps have somewhere to bind.',
      'Block the silhouette in ONE flat colour on the base layer, then get_preview before anything else.',
      'Build material ramps with add_palette_ramp - read its guide first, hue interpolates along the wheel.',
      'Shade on the layer above with clip, then outline the composite onto a top layer with outline.',
      'get_preview between passes, and look at the final preview again before calling it done.',
    ],
  },
  {
    id: 'character-animation',
    title: 'Build and review a multi-part character animation',
    keywords: ['character', 'animation', 'frames', 'attack', 'arm', 'weapon', 'loop'],
    steps: [
      'Create one named layer per durable part and duplicate the rest frame while building poses.',
      'Create a rig with stable pivots, save named poses, then use preview_pose before baking.',
      'Use transform_cel or transform_part for local mechanical adjustments; keep art intent explicit.',
      'Batch final timing with set_frame_durations and create/update tags with upsert_tags.',
      'Review preview_animation with the tag and onion skin, then finalize source/PNG/GIF/sheet/contact outputs.',
    ],
  },
  {
    id: 'batch-animation-metadata',
    title: 'Batch frame durations and animation tags',
    keywords: ['duration', 'timing', 'tags', 'idle', 'attack', 'pingpong'],
    steps: [
      'Call set_frame_durations once with all/range/list/tag updates.',
      'Call upsert_tags once for creates and updates; fix reported name/range conflicts before retrying.',
      'Preview the tag in playback order with preview_animation.',
    ],
  },
  {
    id: 'safe-scripting',
    title: 'Safely generate or modify many pixels from a script',
    keywords: ['script', 'dry run', 'transaction', 'error', 'procedural'],
    steps: [
      'Prototype with run_script dryRun:true and preview:true.',
      'Fix errorInfo line/column and command failures, then commit without dryRun.',
      'Use apply_ops atomic:true for declarative command batches that must fully roll back.',
    ],
  },
  {
    id: 'palette-maintenance',
    title: 'Maintain a role-oriented palette',
    keywords: ['palette', 'ramp', 'unused', 'prune', 'role', 'skin', 'leather'],
    steps: [
      'Build coherent ramps with add_palette_ramp role or ensure_palette_role.',
      'Inspect usage with get_palette, then run prune_palette dryRun:true.',
      'Commit pruning only after checking its old-to-new indexMap and keep list.',
    ],
  },
  {
    id: 'global-recolor',
    title: 'Recolour a sprite across frames or layers',
    keywords: ['replace color', 'recolour', 'recolor', 'palette swap', 'all frames'],
    steps: [
      'Use replace_colors for document/frame/range/list targets and an optional layer restriction.',
      'Use single-cel replace_color when clip/mask behaviour is required.',
      'Preview affected frames with preview_animation before committing a broad palette migration.',
    ],
  },
  {
    id: 'asset-delivery',
    title: 'Deliver a production asset bundle',
    keywords: ['export', 'bundle', 'gif', 'sheet', 'manifest', 'engine'],
    steps: [
      'Review the final preview and fix anything it still shows.',
      'Call finalize_document once with typed PNG/frames/sheet/GIF/contact outputs.',
      'Enable manifest hashes and verify every returned absolute path.',
    ],
  },
  {
    id: 'pose-animation',
    title: 'Create, preview and bake character poses',
    keywords: ['rig', 'pose', 'pivot', 'tween', 'anchor', 'hitbox'],
    steps: [
      'Create the rig from stable rest-frame layer bindings and explicit pivots.',
      'Save poses/tweens, add anchors/hitboxes, and inspect preview_pose plus resolved geometry.',
      'Bake only into explicit target frames with overwrite:true, then review preview_animation.',
    ],
  },
  {
    id: 'tilemap-terrain',
    title: 'Paint terrain into a tilemap',
    keywords: [
      'tilemap', 'tileset', 'terrain', 'coastline', 'coast', 'shore', 'cliff', 'cave',
      'road', 'water', 'autotile', 'stroke', 'map', 'tiles', 'level',
    ],
    steps: [
      'Build the tileset first with create_tileset, in the fixed tile order autotile expects.',
      'Fill a region with fill_tilemap, or lay terrain along a path with stroke_tilemap points/tiles and optional edge transitions.',
      'Let autotile pick the transition tiles afterwards; on a re-run omit indices so the previous pass\'s tiles count as terrain.',
      'Preview with preview_tilemap, passing the changedCells/changedRect a mutation returned, and bake with paint_tilemap.',
    ],
  },
] as const;

function normalizeOp(raw: RawOp): { command: string; params: Record<string, unknown>; label?: string } {
  const hasCommand = typeof raw.command === 'string' && raw.command.length > 0;
  const name = hasCommand ? (raw.command as string) : raw.name;
  if (typeof name !== 'string' || !name) {
    throw new Error(`Every op needs a "command" string, got: ${JSON.stringify(raw)}`);
  }
  const label = typeof raw.label === 'string' ? raw.label : undefined;
  const nested = raw.params ?? raw.args;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return { command: name, params: nested as Record<string, unknown>, label };
  }
  const inline: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'command' || key === 'label' || key === 'params' || key === 'args') continue;
    if (key === 'name' && !hasCommand) continue;
    inline[key] = value;
  }
  return { command: name, params: inline, label };
}

/* ---------------------------------------------------------------- register */

/** What a tool declaration carries beyond its schema. */
interface ToolDeclaration {
  title: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  /**
   * Defaults to {@link TOOL_RESULT_ENVELOPE}. A tool only overrides it when its result
   * is worth documenting field by field; `ok()`/`fail()` build every result, so the
   * envelope is a true statement about all of them.
   */
  outputSchema?: z.ZodType;
  /** Partial hints. Anything omitted is derived from the tool's name. */
  annotations?: Partial<ToolAnnotations>;
  /** Free-form declaration metadata, passed straight through to clients. */
  meta?: Record<string, unknown>;
}

/**
 * The entry-point tools, by name, so `describe_command` can describe them too.
 *
 * Without this there is no route to the schema of the 33 advertised tools: they are not
 * in the command registry, so `describe_command` used to answer `unknown_command` for
 * `apply_ops` and `finalize_document` - precisely the two tools whose arguments are
 * worth reading. A tool list is not documentation you can query; this is.
 */
const DECLARED_TOOLS = new Map<
  string,
  { title: string; description: string; params: unknown; annotations: ToolAnnotations }
>();

/**
 * Register a tool. The SDK's `registerTool` generics are driven by the concrete
 * schema type; we pass schemas through dynamically (including ones built with
 * `.extend()` at runtime), so the call is erased here rather than at every site.
 */
function addTool(
  server: McpServer,
  name: string,
  config: ToolDeclaration,
  handler: (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>,
): void {
  // Strict, like the core command schemas. A mistyped parameter has to be an
  // error rather than a silent fallback to the default: `undo {count: 5}` used
  // to quietly undo a single edit and still report success.
  const { outputSchema, annotations, meta, ...rest } = config;
  const strict = { ...rest, inputSchema: config.inputSchema.strict() };
  const resolved = toolAnnotations(name, annotations);
  // Kept as JSON Schema, because that is the dialect `describe_command` answers in.
  DECLARED_TOOLS.set(name, {
    title: config.title,
    description: config.description,
    params: advertiseSchema(z.toJSONSchema(strict.inputSchema, { io: 'input' })),
    annotations: resolved,
  });
  (server.registerTool as unknown as (
    n: string,
    c: unknown,
    h: unknown,
  ) => unknown)(
    name,
    {
      ...strict,
      outputSchema: outputSchema ?? TOOL_RESULT_ENVELOPE,
      annotations: resolved,
      _meta: { kind: 'session', ...meta },
    },
    handler,
  );
}

/**
 * How much of the command catalogue is exposed as first-class tools.
 *
 * `lazy` is the default because the full catalogue costs 55K tokens of tool
 * definitions that sit in the context of every request, and `apply_ops` already runs
 * any of those commands. A command becomes a tool at the moment it is discovered -
 * `describe_command`, a `list_commands` exact lookup, a `find_workflow` hit, or an
 * `apply_ops`/`run_script` that actually issued it - so the promoted set is the set
 * the session is demonstrably working with, not a guess made up front.
 *
 * `eager` keeps the old flat surface. It is what the test suite drives, and it is the
 * escape hatch if the promotion triggers turn out to miss a path.
 */
export type CommandExposure = 'lazy' | 'eager';

export interface RegisterToolsOptions {
  commands?: CommandExposure;
}

export function registerTools(
  server: McpServer,
  store: DocumentStore,
  options: RegisterToolsOptions = {},
): void {
  const exposure: CommandExposure = options.commands ?? 'lazy';
  // One server per session, so a stale entry from a previous `registerTools` in the
  // same process would describe a tool this server does not have.
  DECLARED_TOOLS.clear();

  /* ------------------------------------------------- on-demand command tools */

  /**
   * Commands currently promoted to first-class tools.
   *
   * `list_commands` reports membership so a model can see which entries it can call
   * directly and which it has to route through `apply_ops`, instead of guessing from
   * the fact that a name is absent.
   */
  const promoted = new Set<string>();
  /** Command names a plugin registered, so their tools can be marked untrusted. */
  const pluginCommands = new Set<string>();

  function notifyToolListChanged(): void {
    try {
      server.sendToolListChanged();
    } catch {
      // A client that does not support list-changed notifications is not fatal.
    }
  }

  /** Promote one command, announcing the new tool list. Returns true if it was new. */
  function promote(name: string): boolean {
    if (promoted.has(name)) return false;
    // A session tool already owns this name and is already advertised, so re-registering
    // it would throw rather than shadow it. See SESSION_TOOL_NAMES.
    if (SESSION_TOOL_NAMES.has(name)) return false;
    const command = store.registry.get(name);
    if (!command) return false;
    promoted.add(name);
    registerCommandTool(server, store, command, pluginCommands.has(name) ? 'plugin' : 'core');
    return true;
  }

  /** Promote a batch with a single notification. */
  function promoteAll(names: Iterable<string>): string[] {
    const added: string[] = [];
    for (const name of names) if (promote(name)) added.push(name);
    if (added.length > 0) notifyToolListChanged();
    return added;
  }

  /* ------------------------------------------------------ session / documents */

  addTool(
    server,
    'list_documents',
    {
      title: 'List documents',
      description:
        'List the documents open in this session with their size, layer/frame counts, version and active flag. Start here if you are unsure what is open.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    () =>
      ok({
        ok: true,
        activeDocument: store.activeDocumentId,
        documents: store.list().map((d) => store.summary(d)),
      }),
  );

  addTool(
    server,
    'create_document',
    {
      title: 'Create a document',
      description:
        'Create a new blank sprite and make it active (pass `select: false` to keep the current document active). Returns the document id and version. Any size from 1x1 to 4096x4096 works: small keeps every shape readable, large (512x512 and up) buys room for detail, non-square suits a sprite that is not square. On a large canvas work in `rect` regions rather than per pixel. Use 2-4 named layers, and pass `palette` to constrain colours.',
      inputSchema: z.object({
        width: z.number().int().min(1).max(4096).describe('Canvas width in pixels.'),
        height: z.number().int().min(1).max(4096).describe('Canvas height in pixels.'),
        name: z.string().optional().describe('Sprite name. Used in spritesheet frame names.'),
        layers: z
          .array(z.string())
          .optional()
          .describe('Layer names, bottom first, e.g. ["base", "shade", "outline"]. Defaults to one layer.'),
        frames: z.number().int().min(1).max(1024).optional().describe('Number of frames to create. Defaults to 1.'),
        frameDurationMs: z.number().int().min(1).optional().describe('Duration of each new frame in ms. Defaults to 100.'),
        palette: z
          .union([z.array(z.string()), z.string()])
          .optional()
          .describe(
            `Either an array of hex colours, or the name of a built-in palette: ${Object.keys(BUILTIN_PALETTES).join(', ')}.`,
          ),
        background: z
          .string()
          .nullable()
          .optional()
          .describe('Fill the bottom layer of every frame with this colour. Omit for a transparent background.'),
        paletteLocked: z
          .boolean()
          .optional()
          .describe(
            'Snap every painted colour to the nearest palette swatch (alpha is preserved). Keeps stray colours off the ramp. Defaults to false.',
          ),
        select: z
          .boolean()
          .optional()
          .describe('Make the new document active. Defaults to true; pass false to create a scratch document without stealing focus.'),
      }),
      annotations: { destructiveHint: false },
    },
    (args) => {
      try {
        const doc = store.create({
          width: args.width as number,
          height: args.height as number,
          name: args.name as string | undefined,
          layers: args.layers as string[] | undefined,
          frames: args.frames as number | undefined,
          frameDurationMs: args.frameDurationMs as number | undefined,
          palette: args.palette as string | string[] | undefined,
          background: (args.background as string | null | undefined) ?? null,
          paletteLocked: args.paletteLocked as boolean | undefined,
          select: args.select as boolean | undefined,
        });
        return ok({ ok: true, document: store.summary(doc), ...describeSprite(doc.editor.sprite) });
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  addTool(
    server,
    'create_sprite_spec',
    {
      title: 'Create a declarative sprite scaffold',
      description:
        'Create a document from one structural spec and optionally configure animation tags, semantic palette roles and a persistent character rig - all in a single call, so a character does not cost six round trips of scaffolding. This creates no artwork and makes no art-direction decisions beyond the structure you supply. `create_document` is the smaller version; use this one when the sprite has tags, roles or a rig.',
      inputSchema: z.object({
        width: z.number().int().min(1).max(4096).describe('Canvas width in pixels. 16-64 is the useful range for a game sprite.'),
        height: z.number().int().min(1).max(4096).describe('Canvas height in pixels.'),
        name: z.string().optional().describe('Sprite name. Used in spritesheet frame names and export filenames.'),
        layers: z.array(z.string()).min(1).describe('Layer names, bottom first, e.g. ["base", "shade", "outline"]. Shade on a layer above the base so ramps and outlines have somewhere to go.'),
        frames: z.number().int().min(1).max(1024).optional().describe('Number of frames to create. Defaults to 1.'),
        frameDurationMs: z.number().int().min(1).optional().describe('Duration of each new frame in ms. Defaults to 100.'),
        palette: z.union([z.array(z.string()), z.string()]).optional().describe('Hex colours, or the name of a built-in palette such as "dawnbringer16". Constraining the palette is the single biggest quality win available.'),
        paletteLocked: z.boolean().optional().describe('Snap every painted colour to the nearest palette entry. Keeps a sprite inside its palette at the cost of rejecting deliberate off-palette colour.'),
        tags: z
          .array(
            z.object({
              name: z.string().min(1).describe('Tag name, e.g. "walk" or "attack". This is what an engine reads when importing the sheet.'),
              from: z.number().int().min(0).describe('First frame of the range, 0-based.'),
              to: z.number().int().min(0).describe('Last frame of the range, 0-based and inclusive.'),
              direction: z.enum(['forward', 'reverse', 'pingpong']).optional().describe('Playback direction. Defaults to forward.'),
              repeat: z.number().int().min(0).optional().describe('How many times the range repeats. 0 means loop forever.'),
            }).strict(),
          )
          .max(64)
          .optional()
          .describe('Animation tags, each a named frame range.'),
        paletteRoles: z
          .array(
            z.object({
              role: z.string().min(1).describe('Semantic role, e.g. "skin", "hair", "cloth", "metal". Roles are what shade_band and add_palette_ramp bind to.'),
              colors: z.array(z.string()).min(2).optional().describe('Explicit colours for this role, dark to light. Alternative to from/to/steps.'),
              from: z.string().optional().describe('Dark anchor colour for a generated ramp, e.g. "#5a3b6b".'),
              to: z.string().optional().describe('Light anchor colour for a generated ramp.'),
              steps: z.number().int().min(2).max(32).optional().describe('Number of steps in the generated ramp. Defaults to the ramp builder\'s choice.'),
              hueShift: z.number().min(0).max(90).optional().describe('Degrees to rotate hue across the ramp. Non-zero is what stops a ramp reading as one flat tonal step.'),
            }).strict(),
          )
          .max(32)
          .optional()
          .describe('Named palette roles, each optionally a hue-shifted ramp.'),
        rig: z
          .object({
            restFrame: z.union([z.string(), z.number().int()]).optional().describe('Frame the rig treats as its unposed source of truth. Defaults to frame 0. Poses are rendered from it.'),
            parts: z
              .array(
                z.object({
                  name: z.string().min(1).describe('Part name, e.g. "armL". Poses and transforms address parts by this.'),
                  pivot: spritePointSchema.describe('Rotation pivot in pixels, absolute canvas coordinates. The single most important number on a part.'),
                  layers: z.array(z.union([z.string(), z.number().int()])).min(1).optional().describe('Layers this part owns. Omit to bind every layer.'),
                  parent: z.string().optional().describe('Name of the parent part, for a chain that inherits its transform.'),
                }).strict(),
              )
              .min(1)
              .max(64)
              .describe('The parts, in any order; `parent` is what links them into a chain.'),
          })
          .strict()
          .optional()
          .describe('A persistent character rig, for reusable parts and poseable animation.'),
        select: z.boolean().optional().describe('Make this the active document. Defaults to true; pass false to keep the current one active.'),
      }),
      annotations: { destructiveHint: false },
    },
    (args) => {
      const previousActive = store.activeDocumentId;
      let doc: PixelDocument | undefined;
      try {
        doc = store.create({
          width: args.width as number,
          height: args.height as number,
          name: args.name as string | undefined,
          layers: args.layers as string[],
          frames: args.frames as number | undefined,
          frameDurationMs: args.frameDurationMs as number | undefined,
          palette: args.palette as string | string[] | undefined,
          paletteLocked: args.paletteLocked as boolean | undefined,
          select: args.select as boolean | undefined,
        });
        const tags = args.tags ? doc.editor.execute('upsert_tags', { tags: args.tags }) : null;
        const roles = args.paletteRoles
          ? (args.paletteRoles as Array<Record<string, unknown>>).map((role) => doc!.editor.execute('ensure_palette_role', role))
          : null;
        const rig = args.rig ? doc.editor.execute('create_rig', args.rig) : null;
        if (tags || roles || rig) store.touch(doc);
        return ok({
          ok: true,
          document: store.summary(doc),
          ...describeSprite(doc.editor.sprite),
          configured: { tags, paletteRoles: roles, rig },
        });
      } catch (error) {
        if (doc) store.remove(doc.id);
        if (previousActive && store.get(previousActive)) store.select(previousActive);
        return fail((error as Error).message);
      }
    },
  );

  addTool(
    server,
    'open_document',
    {
      title: 'Open a .pixel document',
      description: 'Load a `.pixel` document from disk and make it the active one. Replaces nothing: the session keeps whatever documents were already open, so a load is safe to get wrong. Prefer `open_document` over `import_image` when the file is a saved document rather than a PNG or Aseprite file.',
      inputSchema: z.object({
        path: z.string().describe('Path to a `.pixel` file.'),
        select: z.boolean().optional().describe('Make the loaded document active. Defaults to true.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    (args) => {
      const path = args.path as string;
      try {
        const doc = store.load(readFileSync(path), { path, select: args.select !== false });
        return ok({ ok: true, document: store.summary(doc) });
      } catch (error) {
        return fail(`Could not open ${path}: ${(error as Error).message}`);
      }
    },
  );

  addTool(
    server,
    'save_document',
    {
      title: 'Save a document',
      description:
        'Serialize a document to a `.pixel` file (a zip container with a JSON manifest and one PNG per cel). Defaults to the path it was opened from; pass `path` to save elsewhere. Use `export_png` or `export_sheet` to produce engine-ready art instead.',
      inputSchema: z.object({
        document: documentRef,
        path: z.string().optional().describe('Destination path. Defaults to the document\'s current path.'),
      }),
      annotations: { destructiveHint: false },
    },
    (args) => {
      const doc = store.require(args.document as string | undefined);
      const path = (args.path as string | undefined) ?? doc.path;
      if (!path) {
        return fail('No path given and this document has never been saved. Pass `path`.');
      }
      try {
        writeFile(path, store.save(doc));
        doc.path = path;
        return ok({ ok: true, path, absolute: absPath(path), document: store.summary(doc) });
      } catch (error) {
        return fail(`Could not save ${path}: ${(error as Error).message}`);
      }
    },
  );

  addTool(
    server,
    'finalize_document',
    {
      title: 'Save and export an asset bundle',
      description:
        'Save the editable `.pixel` source and render a validated multi-format export plan in one call. `outputs` supports PNG, all-frame PNGs, spritesheet+JSON, GIF, rig poses and animation contact sheets; every output is rendered before writing and an optional hashed manifest can drive incremental updates. The quality gate runs first and refuses the whole call on a named blocking defect, writing nothing - fix the artwork, or re-run with `bypass: true` and a `bypassReason`.',
      inputSchema: z.object({
        document: documentRef,
        path: z.string().optional().describe('Destination `.pixel` path. Defaults to the document\'s current path.'),
        outputs: z
          .array(exportOutputSchema)
          .max(32)
          .optional()
          .describe('Typed outputs to render. An all-frame or contact output may expand to several files.'),
        exports: z
          .array(pngExportSchema)
          .max(8)
          .optional()
          .describe('Legacy PNG-only output list. Converted to `{type: "png"}` outputs.'),
        manifest: exportManifestSchema.optional().describe('Write a bundle manifest describing the source and outputs.'),
        bypass: z
          .boolean()
          .optional()
          .describe(
            'Export a failing asset anyway. Does not make it pass: the result carries `bypassed: true`, your reason and a `notice` to quote in the delivery. Requires `bypassReason`.',
          ),
        bypassReason: z
          .string()
          .optional()
          .describe(
            'Why the quality gate is being bypassed, in words a person can read. Required with `bypass: true`, and echoed in the result so the refusal is attributable.',
          ),
      }),
      annotations: { destructiveHint: false },
    },
    (args) => {
      const doc = store.require(args.document as string | undefined);
      const path = (args.path as string | undefined) ?? doc.path;
      if (!path) return fail('No path given and this document has never been saved. Pass `path`.');

      // §5.5's delivery gate, and it runs before anything is rendered or written — a refused
      // asset must leave no half-written bundle behind for the next run to skip as "unchanged".
      // `threshold: 'fail'` is fixed here rather than exposed: §5.5 says `warn` is the
      // total-score channel and that nobody should switch it on without having run §6 on their
      // own assets, and a delivery path is the last place to put that switch.
      //
      // `assertFinalizable` is the core function rather than the `verify` command because this
      // handler holds a `Sprite`, not a `Draft`, and because a refusal needs the decision
      // structured on the wire so a caller can act on it rather than re-measure.
      const bypass = args.bypass === true;
      let gate: QualityGateRun | undefined;
      try {
        gate = assertFinalizable(doc.editor.sprite, {
          threshold: 'fail',
          bypass,
          bypassReason: args.bypassReason as string | undefined,
        });
      } catch (error) {
        // Two codes land here and they mean different things to an agent: `invalid_params` is
        // "your arguments were incomplete" (bypass without a reason) and `command_failed` is
        // "the document refused" — a named defect at a named measured number, not a bad call.
        const code = (error as { code?: string }).code ?? 'command_failed';
        const decision = (error as { details?: QualityGateDecision }).details;
        return fail((error as Error).message, {
          code,
          ...(decision
            ? {
                gate: 'quality',
                measured: decision.measured,
                refusals: decision.refusals,
                notApplicable: decision.notApplicable,
              }
            : {}),
          ...(code === 'invalid_params'
            ? { remediation: 'Pass `bypassReason` — words a person can read — alongside `bypass: true`.' }
            : {
                remediation:
                  'Call `evaluate` for the full report, then `fix` for the repairs it can plan. Re-run this call once the named defects are gone, or pass `bypass: true` with a `bypassReason`.',
              }),
        });
      }

      const legacy = (args.exports as z.infer<typeof pngExportSchema>[] | undefined) ?? [];
      const legacyOutputs: ExportOutputSpec[] = legacy.map((output) => ({ type: 'png', ...output }));
      const outputs: ExportOutputSpec[] = [
        ...legacyOutputs,
        ...((args.outputs as ExportOutputSpec[] | undefined) ?? []),
      ];
      const manifestSpec = args.manifest as z.infer<typeof exportManifestSchema> | undefined;

      try {
        // Render and validate the complete plan before writing anything.
        const sourceBytes = serializeSprite(doc.editor.sprite);
        const rendered = renderExportOutputs(doc.editor.sprite, outputs);
        const manifestPath = manifestSpec?.path;
        const allPaths = [path, ...rendered.map((output) => output.path)];
        if (manifestPath) allPaths.push(manifestPath);
        const normalizedPaths = new Map<string, string>();
        for (const candidate of allPaths) {
          const key = resolve(candidate).toLowerCase();
          const previous = normalizedPaths.get(key);
          if (previous) throw new Error(`Export path collision: ${previous} and ${candidate}.`);
          normalizedPaths.set(key, candidate);
        }

        let manifestBytes: Uint8Array | undefined;
        let sourceUnchanged = false;
        let manifestUnchanged = false;
        const skippedFiles: string[] = [];
        if (manifestSpec) {
          const includeHashes = manifestSpec.hashes !== false;
          if (manifestSpec.incremental && !includeHashes) throw new Error('Incremental export requires manifest hashes.');
          const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
          const sourceHash = hash(sourceBytes);
          const outputHashes = rendered.map((output) => hash(output.bytes));
          let previousManifest: Record<string, any> | undefined;
          if (manifestSpec.incremental && manifestPath && existsSync(manifestPath)) {
            try {
              previousManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, any>;
            } catch (error) {
              throw new Error(`Cannot use incremental export: existing manifest is unreadable (${(error as Error).message}).`);
            }
          }
          if (manifestSpec.incremental && previousManifest) {
            sourceUnchanged = previousManifest.source?.sha256 === sourceHash && existsSync(path);
            const previousOutputs = new Map<string, string>(
              Array.isArray(previousManifest.outputs)
                ? previousManifest.outputs.map((output: { path?: string; sha256?: string }) => [
                    resolve(String(output.path)).toLowerCase(),
                    String(output.sha256),
                  ])
                : [],
            );
            rendered.forEach((output, index) => {
              if (previousOutputs.get(resolve(output.path).toLowerCase()) === outputHashes[index] && existsSync(output.path)) {
                skippedFiles.push(output.path);
              }
            });
            if (sourceUnchanged) skippedFiles.push(path);
          }
          const manifest = {
            format: 'dotloom-mcp/export-manifest',
            version: 1,
            source: {
              path,
              name: doc.editor.sprite.name,
              width: doc.editor.sprite.width,
              height: doc.editor.sprite.height,
              documentVersion: doc.editor.version,
              bytes: sourceBytes.byteLength,
              sha256: includeHashes ? sourceHash : null,
            },
            frames: doc.editor.sprite.frames.map((frame, index) => ({
              index,
              id: frame.id,
              durationMs: frame.durationMs,
            })),
            tags: doc.editor.sprite.tags,
            outputs: rendered.map((output, index) => ({
              type: output.type,
              path: output.path,
              bytes: output.bytes.byteLength,
              width: output.width,
              height: output.height,
              sha256: includeHashes ? outputHashes[index] : null,
              details: output.details,
            })),
          };
          manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
          manifestUnchanged = Boolean(manifestPath && existsSync(manifestPath) && Buffer.from(readFileSync(manifestPath)).equals(Buffer.from(manifestBytes)));
        }

        // Write derived files first and the source last, so a successful response is
        // the completion signal. Session dirty state is cleared only after every write.
        for (const output of rendered) {
          if (!skippedFiles.includes(output.path)) writeFile(output.path, output.bytes);
        }
        if (manifestPath && manifestBytes && !manifestUnchanged) writeFile(manifestPath, manifestBytes);
        if (!sourceUnchanged) writeFile(path, sourceBytes);
        doc.path = path;
        store.markSaved(doc);

        const files = [path, ...rendered.map((output) => output.path)];
        if (manifestPath) files.push(manifestPath);

        // The gate's decision travels with the export, and **nothing else about it does.**
        // `passed`, `measured`, `threshold`, the refusals and the abstentions are facts about a
        // delivery; the weighted total is not published anywhere on this surface, because a number
        // an agent can read on a delivery path becomes the thing it optimises — §3 deleted a
        // `quality_report` tool over exactly that, and the gate is the last place it could come
        // back through.
        //
        // `refusals` is present even when it is empty, because the shape has to be the same on a
        // refusal and on a pass: a reader sees `refusals: []` beside
        // `notApplicable: {silhouette: "no-subject"}` and learns "nothing refused, and this is what
        // was not measured", rather than reading an empty list as "nothing was looked at".
        const decision = gate!.decision;
        const gateView: Record<string, unknown> = {
          threshold: decision.threshold,
          passed: decision.passed,
          // False when no dimension applied, so nothing could be measured and nothing failed.
          // §5.5: a target where nothing applied still exports, and says so here.
          measured: decision.measured,
          refusals: decision.refusals,
          notApplicable: decision.notApplicable,
        };

        return ok({
          ok: true,
          path,
          absolute: absPath(path),
          bytes: sourceBytes.byteLength,
          ...(decision.passed
            ? { qualityGate: gateView }
            : {
                // A bypass does not make the asset pass, so `passed` is still false above and
                // the three loud fields below are what a caller has to carry into its own
                // delivery: a boolean, the reason a person can read, and the sentence to quote.
                qualityGate: gateView,
                bypassed: true,
                bypassReason: args.bypassReason,
                notice: qualityGateBypassNotice(decision, String(args.bypassReason ?? '')),
              }),
          manifest: manifestPath
            ? {
                path: manifestPath,
                absolute: absPath(manifestPath),
                bytes: manifestBytes!.byteLength,
                hashes: manifestSpec!.hashes !== false,
                incremental: manifestSpec!.incremental === true,
                unchanged: manifestUnchanged,
              }
            : null,
          outputs: rendered.map((output) => ({
            type: output.type,
            path: output.path,
            width: output.width,
            height: output.height,
            bytes: output.bytes.byteLength,
            details: output.details,
          })),
          // Preserve the old response key for clients that only understand PNG exports.
          exports: rendered
            .filter((output) => output.type !== 'json')
            .map((output) => ({ path: output.path, width: output.width, height: output.height, bytes: output.bytes.byteLength, ...output.details })),
          files,
          skippedFiles,
          absoluteFiles: files.map(absPath),
          version: doc.editor.version,
          document: store.summary(doc),
        });
      } catch (error) {
        return fail(`Could not finalize ${path}: ${(error as Error).message}`);
      }
    },
  );

  addTool(
    server,
    'import_image',
    {
      title: 'Import an image',
      description:
        'Import a PNG or Aseprite (`.ase`) file from disk as a new sprite document. Handy for bringing reference art or existing assets into the session. A PNG becomes the bottom layer with a palette derived from it unless `derivePalette` is false; an Aseprite file brings its own layers, frames, frame durations and animation tags.',
      inputSchema: z.object({
        path: z.string().describe('Path to a PNG or Aseprite (.ase) file.'),
        name: z.string().optional().describe('Sprite name. Defaults to the file name.'),
        layerName: z.string().optional().describe('Name for the layer the image lands on.'),
        derivePalette: z.boolean().optional().describe('Derive a palette from the image colours. Defaults to true.'),
        paletteLimit: z.number().int().min(1).max(256).optional().describe('Maximum colours in the derived palette. Defaults to 64.'),
        select: z.boolean().optional().describe('Make the imported document active. Defaults to true.'),
      }),
      annotations: { destructiveHint: false },
    },
    (args) => {
      const path = args.path as string;
      try {
        const bytes = readFileSync(path);
        // Aseprite files and PNGs both arrive here; the header tells them apart.
        // An Aseprite file brings its layers, frames, durations and tags with it.
        const sprite = isAseprite(bytes)
          ? spriteFromAseprite(bytes, { name: args.name as string | undefined })
          : spriteFromPng(bytes, {
              name: args.name as string | undefined,
              layerName: args.layerName as string | undefined,
              derivePalette: args.derivePalette !== false,
              paletteLimit: args.paletteLimit as number | undefined,
            });
        const doc = store.add(sprite, { path, select: args.select !== false });
        return ok({ ok: true, document: store.summary(doc) });
      } catch (error) {
        return fail(`Could not import ${path}: ${(error as Error).message}`);
      }
    },
  );

  addTool(
    server,
    'select_document',
    {
      title: 'Select the active document',
      description: 'Make a document the active one, so later calls can omit `document`. Accepts a document id or its name.',
      inputSchema: z.object({ document: z.string().describe('Document id or name to activate.') }),
      annotations: { readOnlyHint: true },
    },
    (args) => {
      try {
        const ref = args.document as string;
        let id = ref;
        if (!store.list().some((doc) => doc.id === ref)) {
          const byName = store.list().find((doc) => doc.name === ref);
          if (!byName) {
            const known = store.list().map((doc) => `${doc.id} (${doc.name})`).join(', ');
            return fail(`Unknown document: ${ref}. Known documents: ${known}`);
          }
          id = byName.id;
        }
        return ok({ ok: true, document: store.summary(store.select(id)) });
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  addTool(
    server,
    'close_document',
    {
      title: 'Close a document',
      description: 'Drop a document from the session. Unsaved changes are lost - save first if you need them.',
      inputSchema: z.object({
        document: z.string().optional().describe('Document id. Omit to close the active document.'),
      }),
      annotations: { destructiveHint: true },
    },
    (args) => {
      const doc = args.document ? store.get(args.document as string) : store.active;
      if (!doc) return fail('No such document.');
      store.remove(doc.id);
      return ok({ ok: true, closed: doc.id, activeDocument: store.activeDocumentId });
    },
  );

  addTool(
    server,
    'get_document',
    {
      title: 'Inspect a document',
      description:
        'Full structure of a document: size, layers (bottom first) with their visibility/opacity/blend mode, frames with durations and which layers have pixels on them, animation tags, palette size, and the current version. Passing an explicit `document` reads it without changing session focus; use `select_document` when you want to make it active.',
      inputSchema: z.object({ document: documentRef }),
      annotations: { readOnlyHint: true },
    },
    (args) => {
      try {
        const doc = store.require(args.document as string | undefined);
        return ok({ ok: true, document: store.summary(doc), ...describeSprite(doc.editor.sprite) });
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  /* ------------------------------------------------------------- perception */

  addTool(
    server,
    'get_preview',
    {
      title: 'Look at the sprite',
      description:
        'Render the composited sprite as a PNG image you can actually see, plus a text summary. This is your eyes when no edit was made. After `run_script` or `apply_ops`, prefer their `preview: true` + `previewOptions` so drawing and looking share one round trip. Returns all frames as a horizontal sheet when `frames` is "all". Pass `layers` to isolate one layer, `rect` to crop-zoom a detail, and `onion` to see neighbouring frames as ghosts.',
      inputSchema: z.object({
        document: documentRef,
        frame: frameRefSchema.optional().describe('Frame id or 0-based index. Defaults to frame 0.'),
        rect: previewRectSchema.optional(),
        frames: z
          .enum(['one', 'all'])
          .optional()
          .describe('"one" (default) renders a single frame; "all" renders every frame as a horizontal strip.'),
        layers: previewLayersSchema,
        onion: previewOnionSchema,
        scale: previewScaleSchema,
        background: previewBackgroundSchema,
      }),
      annotations: { readOnlyHint: true },
    },
    (args) => {
      try {
        const doc = store.require(args.document as string | undefined);
        const rendered = previewPayload(doc.editor.sprite, {
          frame: args.frame as number | string | undefined,
          rect: args.rect as { x: number; y: number; w: number; h: number } | undefined,
          layers: args.layers as Array<string | number> | undefined,
          frames: args.frames as 'one' | 'all' | undefined,
          onion: args.onion as PreviewOnionOptions | undefined,
          scale: args.scale as number | undefined,
          background: args.background as string | null | undefined,
        });
        return ok(
          { ok: true, document: store.summary(doc), ...rendered.meta },
          rendered.blocks,
        );
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  addTool(
    server,
    'preview_pose',
    {
      title: 'Preview a character pose',
      description:
        'Render a saved rig pose, a pose at fractional progress, or a stored tween at progress as a PNG. Returns part bounds, clipped-part evidence, and world-space anchors/hitboxes without modifying the document.',
      inputSchema: z.object({
        document: documentRef,
        pose: z.string().optional().describe('Pose ID/name. Required unless tween is provided.'),
        tween: z.string().optional().describe('Stored tween ID/name. Overrides pose when supplied.'),
        progress: z.number().min(0).max(1).optional().describe('Pose/tween progress. Defaults to 1.'),
        scale: previewScaleSchema,
        background: previewBackgroundSchema,
        includeGeometry: z.boolean().optional().describe('Resolve anchor/hitbox world geometry. Defaults to true.'),
      }),
      annotations: { readOnlyHint: true },
    },
    (args) => {
      try {
        const doc = store.require(args.document as string | undefined);
        const sprite = doc.editor.sprite;
        const rig = requireRig(sprite);
        const progress = (args.progress as number | undefined) ?? 1;
        const poseRef = args.pose as string | undefined;
        const tweenRef = args.tween as string | undefined;
        let pose = poseRef ? findRigPose(rig, poseRef) : undefined;
        let poseForGeometry = pose;
        let rendered: RenderedPose;
        let tweenName: string | null = null;
        let easing = 'linear';

        if (tweenRef !== undefined) {
          const tween = findRigTween(rig, tweenRef);
          const from = findRigPose(rig, tween.fromPoseId);
          const to = findRigPose(rig, tween.toPoseId);
          poseForGeometry = {
            id: '__preview_tween__',
            name: tween.name,
            transforms: interpolatePose(rig, from, to, progress, tween.easing),
          };
          rendered = renderInterpolatedPose(sprite, from, to, progress, tween.easing);
          tweenName = tween.name;
          easing = tween.easing;
        } else {
          if (!pose) throw new Error('preview_pose requires `pose` or `tween`.');
          if (progress < 1) {
            const identity: RigPose = { id: '__identity__', name: 'identity', transforms: {} };
            poseForGeometry = { id: '__preview_pose__', name: pose.name, transforms: interpolatePose(rig, identity, pose, progress) };
            rendered = renderInterpolatedPose(sprite, identity, pose, progress);
          } else {
            rendered = renderPose(sprite, pose);
          }
        }

        const background = args.background as string | null | undefined;
        const visible = background == null ? rendered.buffer : flattenAlpha(rendered.buffer, background);
        const factor = args.scale as number | undefined
          ?? previewFactor(visible.width, visible.height, 256, 16);
        assertPreviewOutputSize(visible.width, visible.height, factor);
        const shown = factor > 1 ? scaleNearest(visible, factor) : visible;
        const geometry = args.includeGeometry === false || !poseForGeometry
          ? null
          : resolveRigGeometry(sprite, poseForGeometry);
        return ok({
          ok: true,
          document: store.summary(doc),
          pose: poseForGeometry?.name ?? null,
          tween: tweenName,
          progress,
          easing,
          partBounds: rendered.partBounds,
          partBoundsById: rendered.partBoundsById,
          partPixels: rendered.partPixels,
          clippedParts: rendered.clippedParts,
          geometry,
          preview: {
            mode: 'pose-preview',
            scale: factor,
            imageWidth: shown.width,
            imageHeight: shown.height,
          },
        }, [imageContent(shown)]);
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  addTool(
    server,
    'preview_animation',
    {
      title: 'Preview a complete animation',
      description:
        'Render an animation as a contact-sheet PNG or animated GIF. With `tag`, the default order follows that tag\'s direction and repeat; `frameOrder: "timeline"` shows raw frame order instead. Supports strip/grid layout, frame metadata, and sequence-aware onion skin for forward/reverse/pingpong playback.',
      inputSchema: z.object({
        document: documentRef,
        tag: z.union([z.string(), z.number().int()]).optional().describe('Animation tag ID, name, or index.'),
        frameOrder: z
          .enum(['timeline', 'playback'])
          .optional()
          .describe('"playback" expands the tag; "timeline" uses raw frame order. Defaults from tag presence.'),
        format: z
          .enum(['png', 'gif'])
          .optional()
          .describe('PNG contact sheet (default) or animated GIF for client playback.'),
        loop: z.boolean().optional().describe('GIF playback loop override. By default the tag repeat controls it.'),
        layout: z.enum(['strip', 'grid']).optional().describe('Contact-sheet layout. Defaults to grid.'),
        columns: z.number().int().min(1).max(256).optional().describe('Grid columns. Defaults to a near-square arrangement.'),
        padding: z.number().int().min(0).max(64).optional().describe('Pixel gap between cells. Defaults to 1.'),
        margin: z.number().int().min(0).max(64).optional().describe('Transparent border. Defaults to 1.'),
        onion: previewOnionSchema.describe(
          'Ghost neighbouring positions in the selected timeline or playback order, following the tag\'s direction rather than raw frame order.',
        ),
        layers: previewLayersSchema,
        scale: previewScaleSchema,
        background: previewBackgroundSchema,
        includeMetadata: z.boolean().optional().describe('Return the expanded frame sequence and durations. Defaults to true.'),
      }),
      annotations: { readOnlyHint: true },
    },
    (args) => {
      try {
        const doc = store.require(args.document as string | undefined);
        const rendered = animationPreviewPayload(doc.editor.sprite, {
          tag: args.tag as string | number | undefined,
          frameOrder: args.frameOrder as 'timeline' | 'playback' | undefined,
          format: args.format as 'png' | 'gif' | undefined,
          loop: args.loop as boolean | undefined,
          layout: args.layout as 'strip' | 'grid' | undefined,
          columns: args.columns as number | undefined,
          padding: args.padding as number | undefined,
          margin: args.margin as number | undefined,
          onion: args.onion as PreviewAnimationOptions['onion'],
          layers: args.layers as Array<string | number> | undefined,
          scale: args.scale as number | undefined,
          background: args.background as string | null | undefined,
          includeMetadata: args.includeMetadata as boolean | undefined,
        });
        return ok({ ok: true, document: store.summary(doc), ...rendered.meta }, rendered.blocks);
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  addTool(
    server,
    'preview_tilemap',
    {
      title: 'Preview and debug a tilemap',
      description:
        'Render a tilemap straight from its tileset, even when nothing has been baked into a pixel layer - the immediate visual check after any set/fill/stroke/autotile. `debug.grid` overlays tile boundaries, `debug.indices` prints every index, `debug.highlightCells`/`highlightRect` mark exactly what a mutation changed, and out-of-range indices are outlined in red. `underlay` composites a base map first so alpha-masked bank tiles read over real ground. The response also carries structural evidence: empty ratio, invalid cells, variant distribution, connected terrain.',
      inputSchema: z.object({
        document: documentRef,
        tilemap: z.union([z.string(), z.number().int()]).describe('Tilemap id, name or 0-based index.'),
        underlay: z
          .union([z.string(), z.number().int()])
          .optional()
          .describe('Optional ground/base tilemap rendered first. Alpha-masked edge tiles then blend over it.'),
        rect: z
          .object({
            x: z.number().int().describe('Left tile column.'),
            y: z.number().int().describe('Top tile row.'),
            w: z.number().int().min(1).describe('Width in tiles.'),
            h: z.number().int().min(1).describe('Height in tiles.'),
          })
          .strict()
          .optional()
          .describe('Crop in tile coordinates. Defaults to the whole tilemap.'),
        scale: previewScaleSchema,
        background: previewBackgroundSchema,
        replaceEmpty: z
          .number()
          .int()
          .min(-1)
          .optional()
          .describe('Render empty cells with this tile index. Defaults to leaving them transparent.'),
        opacity: z.number().min(0).max(1).optional().describe('Terrain opacity. Defaults to 1.'),
        debug: tilemapDebugSchema.optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    (args) => {
      try {
        const doc = store.require(args.document as string | undefined);
        const tilemap = resolveTilemap(doc.editor.sprite, args.tilemap as string | number);
        const underlay = args.underlay === undefined
          ? undefined
          : resolveTilemap(doc.editor.sprite, args.underlay as string | number);
        const rendered = renderTilemapPreview(doc.editor.sprite, tilemap, {
          rect: args.rect as { x: number; y: number; w: number; h: number } | undefined,
          underlay,
          scale: args.scale as number | undefined,
          background:
            args.background === undefined
              ? undefined
              : resolveBackground(args.background as string | null),
          replaceEmpty: args.replaceEmpty as number | undefined,
          opacity: args.opacity as number | undefined,
          debug: args.debug as
            | {
                grid?: boolean;
                indices?: boolean;
                showInvalid?: boolean;
                highlightCells?: Array<{ x: number; y: number }>;
                highlightRect?: { x: number; y: number; w: number; h: number };
              }
            | undefined,
        });
        return ok(
          {
            ok: true,
            document: store.summary(doc),
            ...rendered.meta,
            structure: rendered.structure,
          },
          [imageContent(rendered.image)],
        );
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  addTool(
    server,
    'get_pixels',
    {
      title: 'Read exact pixel colours',
      description:
        'Return a small region of the composited image as hex rows, one string per row, `..` for fully transparent pixels. Use this when you need exact coordinates; use `get_preview` when you need to judge how it looks. Refuses regions larger than `max` x `max` to keep the output readable.',
      inputSchema: z.object({
        document: documentRef,
        frame: frameRefSchema.optional().describe('Frame id or 0-based index. Defaults to frame 0.'),
        rect: z
          .object({
            x: z.number().int(),
            y: z.number().int(),
            w: z.number().int().min(1),
            h: z.number().int().min(1),
          })
          .optional()
          .describe('Region to read, `{x, y, w, h}`. Defaults to the whole canvas.'),
        max: z.number().int().min(1).max(128).optional().describe('Largest region side allowed. Defaults to 32.'),
      }),
      annotations: { readOnlyHint: true },
    },
    (args) => {
      try {
        const doc = store.require(args.document as string | undefined);
        const sprite = doc.editor.sprite;
        const frame = resolveFrame(sprite, (args.frame as number | string | undefined) ?? 0);
        const buffer = compositeFrame(sprite, frame.id);

        const rect = (args.rect as { x: number; y: number; w: number; h: number } | undefined) ?? {
          x: 0,
          y: 0,
          w: sprite.width,
          h: sprite.height,
        };
        const max = (args.max as number | undefined) ?? 32;
        if (rect.w > max || rect.h > max) {
          return fail(
            `Region ${rect.w}x${rect.h} exceeds the ${max}x${max} limit. Use get_preview for a visual, or read a smaller rect.`,
          );
        }

        const rows: string[] = [];
        for (let y = rect.y; y < rect.y + rect.h; y++) {
          const cells: string[] = [];
          for (let x = rect.x; x < rect.x + rect.w; x++) {
            if (!buffer.contains(x, y)) {
              cells.push('--');
              continue;
            }
            const c = buffer.getColor(x, y);
            if (c.a === 0) cells.push('..');
            else {
              const hex = (n: number) => n.toString(16).padStart(2, '0');
              cells.push(c.a === 255 ? `${hex(c.r)}${hex(c.g)}${hex(c.b)}` : `${hex(c.r)}${hex(c.g)}${hex(c.b)}${hex(c.a)}`);
            }
          }
          rows.push(cells.join(' '));
        }
        return ok({
          ok: true,
          frame: sprite.frames.findIndex((f) => f.id === frame.id),
          rect,
          legend: 'row-major, one row per line; `..` = transparent, `--` = outside the canvas',
          rows,
        });
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  /**
   * Previously-read grids, so a repeated `read_grid` can report what changed.
   *
   * Keyed by everything that changes the answer - document, frame, scope, layer, view
   * and region - so a diff is only ever offered against a genuinely comparable read.
   * A caller that crops, re-frames or switches view gets a fresh baseline rather than a
   * misleading diff. Bounded because it is a cache of a convenience, not state: past
   * the limit the oldest entry is simply forgotten and the next call has no baseline.
   */
  /**
   * How many frames `read_grid` will print at once.
   *
   * A bound on the response, not on the document: sixteen 32x32 grids is already more
   * text than is useful in one read, and an animation with more frames is better served
   * by narrowing the region or by the contact sheet `preview_animation` draws.
   */
  const GRID_FRAME_LIMIT = 16;
  /** Ceiling on the `max` argument, matching the schema. */
  const GRID_MAX_LIMIT = 128;
  const GRID_MAX_DEFAULT = 64;

  const gridBaselines = new Map<string, Int32Array>();
  const GRID_BASELINE_LIMIT = 32;

  function readGridBaseline(key: string): Int32Array | undefined {
    return gridBaselines.get(key);
  }

  function rememberGridBaseline(key: string, cells: Int32Array): void {
    // Re-insert so the map's iteration order doubles as a recency list.
    gridBaselines.delete(key);
    gridBaselines.set(key, cells);
    while (gridBaselines.size > GRID_BASELINE_LIMIT) {
      const oldest = gridBaselines.keys().next();
      if (oldest.done) break;
      gridBaselines.delete(oldest.value);
    }
  }

  /**
   * How far a frame's silhouette has moved from the first frame's.
   *
   * Counted on the `mask` grids rather than the caller's chosen view, because for an
   * animation the question is always "did the outline move" and never "did the colours
   * change" - the latter is supposed to change. Reporting it as a number turns "this
   * frame flickers" from something to squint at into something to act on.
   */
  function silhouetteDrift(first: readonly string[], now: readonly string[]): {
    pixels: number;
    worstRow: number | null;
    worstRowPixels: number;
  } {
    let pixels = 0;
    let worstRow: number | null = null;
    let worstRowPixels = 0;
    const shared = Math.min(first.length, now.length);
    for (let i = 0; i < shared; i++) {
      const a = first[i];
      const b = now[i];
      let rowPixels = 0;
      for (let x = 0; x < Math.min(a.length, b.length); x++) {
        if (a[x] !== b[x]) {
          rowPixels++;
          pixels++;
        }
      }
      if (rowPixels > worstRowPixels) {
        worstRowPixels = rowPixels;
        worstRow = i;
      }
    }
    return { pixels, worstRow, worstRowPixels };
  }

  /** The silhouette of a region as `#`/`.` rows, for frame-to-frame comparison. */
  function maskGrid(surface: PixelBuffer, rect: { x: number; y: number; w: number; h: number }, sprite: Sprite): string[] {
    return renderGridView(surface, rect, 'mask', sprite.palette.colors).rows;
  }

  addTool(
    server,
    'read_grid',
    {
      title: 'Read the artwork as a character grid',
      description:
        'Render a region as text, one character per pixel, instead of a picture. This is the default way to check a drawing: it answers "is the silhouette symmetric", "which tone is in row 14", "did that edit land" and "does it still fit the canvas" exactly and in one call, where a preview PNG must be re-read from scratch after every edit. Pick the view: `mask` is the silhouette (`#`/`.`), `value` is a luminance ladder - use it for form and lighting, with one glyph per distinct tone, so a collapsed ramp shows up as collapsed glyphs - `index` is the palette slot, so the next draw can name it as `pal:7`, and `named` is generated colour names like "dark red". Repeating a call with the same arguments also reports which rows changed and what they were before. `allFrames` reads every frame and adds per-frame silhouette drift. Reach for `get_preview` when the question is whether it looks good, and for this one when the question is whether it is right.',
      inputSchema: z.object({
        document: documentRef,
        view: z
          .enum(['mask', 'value', 'index', 'named'])
          .optional()
          .describe(
            'What each character means. `mask` = silhouette, `value` = luminance, `index` = palette slot, `named` = colour name. Defaults to `value`, which is the one that answers "is the form working".',
          ),
        scope: z
          .enum(['composite', 'cel'])
          .optional()
          .describe('`composite` (default) reads the frame as it renders; `cel` reads one layer on its own, to check a silhouette before shading lands on it.'),
        layer: layerRefSchema.optional().describe('Layer for `scope: "cel"`. Defaults to the bottom layer.'),
        frame: frameRefSchema.optional().describe('Frame id or 0-based index. Defaults to frame 0.'),
        allFrames: z
          .boolean()
          .optional()
          .describe('Read every frame, each as its own grid. For an animation this is how silhouette drift between frames becomes readable as text rather than as a flicker you have to squint at.'),
        rect: rectSchema.optional().describe('Region to read, `{x, y, w, h}`. Defaults to the whole canvas. Pass the area you care about - a face, a hand - to keep the answer small; the rulers carry absolute coordinates either way.'),
        max: z
          .number()
          .int()
          .min(8)
          .max(128)
          .optional()
          .describe(`Largest region side allowed. Defaults to ${GRID_MAX_DEFAULT}, ceiling ${GRID_MAX_LIMIT}. Pass a \`rect\` to read just the part you are working on.`),
        diff: z
          .boolean()
          .optional()
          .describe('Compare against the previous identical read and report changed rows. Defaults to true.'),
      }),
      annotations: { readOnlyHint: true },
    },
    (args) => {
      try {
        const doc = store.require(args.document as string | undefined);
        const sprite = doc.editor.sprite;
        const view = ((args.view as GridView | undefined) ?? 'value') as GridView;
        const scope = ((args.scope as string | undefined) ?? 'composite') as 'composite' | 'cel';
        const allFrames = args.allFrames === true;
        const wantDiff = args.diff !== false;
        const max = (args.max as number | undefined) ?? GRID_MAX_DEFAULT;

        const frameRefs: Array<number | string> = allFrames
          ? sprite.frames.map((_, index) => index)
          : [(args.frame as number | string | undefined) ?? 0];
        if (allFrames && frameRefs.length > GRID_FRAME_LIMIT) {
          return fail(
            `This document has ${frameRefs.length} frames and read_grid reads at most ${GRID_FRAME_LIMIT} in one call, because ${GRID_FRAME_LIMIT} grids is already more than is worth reading in one response. Narrow it with \`frame\` and \`rect\`, or render the whole loop with \`preview_animation\`.`,
          );
        }

        const requested = (args.rect as { x: number; y: number; w: number; h: number } | undefined) ?? {
          x: 0,
          y: 0,
          w: sprite.width,
          h: sprite.height,
        };
        if (requested.w > max || requested.h > max) {
          return fail(
            `Region ${requested.w}x${requested.h} exceeds the ${max}x${max} limit. Pass a smaller \`rect\` to read just the part you are working on, or raise \`max\` up to ${GRID_MAX_LIMIT} for a large canvas.`,
          );
        }
        if (
          requested.x < 0 ||
          requested.y < 0 ||
          requested.x + requested.w > sprite.width ||
          requested.y + requested.h > sprite.height
        ) {
          return fail(
            `Region ${requested.w}x${requested.h} at (${requested.x}, ${requested.y}) runs off the ${sprite.width}x${sprite.height} canvas. Clip it to the canvas, or omit \`rect\` to read the whole thing.`,
          );
        }

        // One surface per scope, resolved once and reused across frames. For `cel` this
        // is the layer's own pixels read straight off the frame, so a silhouette can be
        // checked before anything is shaded on top of it. A layer with no cel on a frame
        // contributes nothing, which renders as an empty surface rather than an error.
        const celLayer = scope === 'cel' ? resolveLayer(sprite, (args.layer as string | number | undefined) ?? 0) : null;
        const surfaceFor = (frame: Frame): PixelBuffer =>
          celLayer
            ? frame.cels.get(celLayer.id) ?? PixelBuffer.empty(sprite.width, sprite.height)
            : compositeFrame(sprite, frame.id);

        const blocks: string[] = [];
        const metas: Array<Record<string, unknown>> = [];

        // The first frame read is the baseline for the rest, so `allFrames` reports
        // drift against the pose the animator is holding still rather than against
        // whichever frame happened to be read last.
        let firstMask: string[] | null = null;

        for (const ref of frameRefs) {
          const frame = resolveFrame(sprite, ref);
          const frameIndex = sprite.frames.indexOf(frame);
          const surface = surfaceFor(frame);
          const render = renderGridView(surface, requested, view, sprite.palette.colors);

          // Diffed against the same document, frame, scope, layer, view and region -
          // anything else would be comparing two different questions.
          const key = [
            doc.id,
            frameIndex,
            scope,
            celLayer ? celLayer.id : '-',
            view,
            `${requested.x},${requested.y},${requested.w},${requested.h}`,
          ].join('|');
          const previous = wantDiff ? readGridBaseline(key) : undefined;
          rememberGridBaseline(key, render.cells);

          const meta: Record<string, unknown> = {
            frame: frameIndex,
            rect: render.rect,
            opaque: render.opaque,
            total: render.total,
            partialAlpha: render.partialAlpha,
            unmapped: render.unmapped,
            valueRange: render.valueRange ?? null,
            levels: render.levels ?? null,
            legend: render.legend,
            diff: null,
            driftFromFirst: null,
          };
          if (previous) {
            // Both sides are drawn through *this* read's mapping. Diffing the rendered
            // glyphs would report the whole region as changed whenever the value ladder
            // re-ranks, which is exactly the case where a diff is most needed.
            meta.diff = diffGridRows(
              rowsFromCells(previous, render.rect, render),
              render.rows,
              requested.y,
            );
          }

          if (allFrames) {
            // Drift is measured on the silhouette, always. Comparing `value` grids
            // across frames would count every intentional tone change as drift, when
            // what an animator needs to know is whether the outline moved.
            const mask = maskGrid(surface, requested, sprite);
            meta.driftFromFirst = firstMask ? silhouetteDrift(firstMask, mask) : null;
            if (!firstMask) firstMask = mask;
          }

          blocks.push(
            formatGrid(render, {
              view,
              scope,
              frame: frameIndex,
              layer: celLayer?.name,
              frameCount: sprite.frames.length,
            }),
          );
          metas.push(meta);
        }

        // A diff rides along with the grid rather than replacing it: the caller still
        // needs to see the current state, and the changed rows say which part of it to
        // look at.
        if (wantDiff) {
          metas.forEach((meta, i) => {
            const diff = meta.diff as ReturnType<typeof diffGridRows> | null;
            if (!diff) return;
            blocks[i] += `\n\n${formatGridDiff(diff, 'changed since the previous read_grid')}`;
          });
        }

        return ok(
          { ok: true, view, scope, frameCount: sprite.frames.length, regions: metas },
          [text(blocks.join('\n\n'))],
        );
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  addTool(
    server,
    'histogram',
    {
      title: 'Count the colours actually on the canvas',
      description:
        'Return the pixel count per colour in a region in one call, each matched to its palette slot index. This is the cheap way to answer "which colours does this really contain": `get_pixels` is capped at 32x32 per call, so tallying a large canvas that way needs dozens of round trips. Also reports unused palette slots so the palette can be tightened.',
      inputSchema: z.object({
        document: documentRef,
        frame: frameRefSchema.optional().describe('Frame id or 0-based index. Defaults to frame 0.'),
        rect: z
          .object({ x: z.number().int(), y: z.number().int(), w: z.number().int().min(1), h: z.number().int().min(1) })
          .optional()
          .describe('Region to tally, `{x, y, w, h}`. Defaults to the whole canvas.'),
        alphaThreshold: z.number().int().min(1).max(255).optional().describe('Alpha at or above this counts as solid. Defaults to 1.'),
        limit: z.number().int().min(1).max(512).optional().describe('Maximum colours listed, most frequent first. Defaults to 64.'),
      }),
      annotations: { readOnlyHint: true },
    },
    (args) => {
      try {
        const doc = store.require(args.document as string | undefined);
        const sprite = doc.editor.sprite;
        const frame = resolveFrame(sprite, (args.frame as number | string | undefined) ?? 0);
        const buffer = compositeFrame(sprite, frame.id);
        const rect = (args.rect as { x: number; y: number; w: number; h: number } | undefined) ?? {
          x: 0, y: 0, w: sprite.width, h: sprite.height,
        };
        const alphaThreshold = Math.max(1, Math.min(255, Math.floor((args.alphaThreshold as number | undefined) ?? 1)));
        const limit = Math.max(1, Math.min(512, Math.floor((args.limit as number | undefined) ?? 64)));

        const counts = new Map<number, { count: number; r: number; g: number; b: number; a: number }>();
        let solid = 0;
        let transparent = 0;
        for (let y = rect.y; y < rect.y + rect.h; y++) {
          for (let x = rect.x; x < rect.x + rect.w; x++) {
            if (!buffer.contains(x, y)) continue;
            const c = buffer.getColor(x, y);
            if (c.a < alphaThreshold) {
              if (c.a === 0) transparent++;
              continue;
            }
            solid++;
            const key = ((c.r & 255) << 24) | ((c.g & 255) << 16) | ((c.b & 255) << 8) | (c.a & 255);
            const existing = counts.get(key);
            if (existing) existing.count++;
            else counts.set(key, { count: 1, r: c.r, g: c.g, b: c.b, a: c.a });
          }
        }

        const hex = (n: number): string => n.toString(16).padStart(2, '0');
        const keyOf = (c: { r: number; g: number; b: number; a: number }): number =>
          ((c.r & 255) << 24) | ((c.g & 255) << 16) | ((c.b & 255) << 8) | (c.a & 255);
        const slotOf = new Map<number, number>();
        sprite.palette.colors.forEach((color, index) => slotOf.set(keyOf(color), index));

        const ranked = [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
        const colors = ranked.slice(0, limit).map(([key, entry]) => ({
          hex: entry.a === 255
            ? `#${hex(entry.r)}${hex(entry.g)}${hex(entry.b)}`
            : `#${hex(entry.r)}${hex(entry.g)}${hex(entry.b)}${hex(entry.a)}`,
          count: entry.count,
          ratio: solid > 0 ? entry.count / solid : 0,
          paletteIndex: slotOf.has(key) ? (slotOf.get(key) as number) : null,
        }));
        const unusedPaletteIndices: number[] = [];
        sprite.palette.colors.forEach((color, index) => {
          if (!counts.has(keyOf(color))) unusedPaletteIndices.push(index);
        });

        return ok({
          ok: true,
          frame: sprite.frames.findIndex((f) => f.id === frame.id),
          rect,
          solid,
          transparent,
          distinctColors: counts.size,
          truncated: ranked.length > colors.length,
          colors,
          unusedPaletteIndices,
        });
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  addTool(
    server,
    'evaluate',
    {
      title: 'Measure the artwork with the quality dimensions',
      description:
        'Measure the artwork with the quality dimensions and return one report: a score and a one-line verdict per dimension, plus every defect with the canvas rect to fix. Reach for it on a finished piece for a second opinion, or to get a list of what to fix. The numbers are diagnostics, not a goal - raising the total by sanding the art flat is a failure. It cannot tell what the sprite is, judge intent, or compare asset classes. Name a tag to judge an animation. Also at pixel://quality/{doc}.',
      // `frame` (a scalar) and `rect` here, against the core command's `frames` (an array) and
      // `focus`. Deliberate on both sides, and the reasoning — plus the rule that all three
      // channels return the same report for the same document — is on `targetShape` in
      // `packages/core/src/commands/quality.ts`. Do not "harmonise" one side without that.
      inputSchema: z.object({
        document: documentRef,
        frame: frameRefSchema
          .optional()
          .describe(
            'Judge one frame instead of the whole timeline. A report over one frame is a statement about that frame only; use `tag` to judge an animation as a whole.',
          ),
        tag: z
          .union([z.string(), z.number().int()])
          .optional()
          .describe(
            'Animation tag by name, id or 0-based index. Expanded into playback order, so `motion` can measure the seam from the last frame back to the first.',
          ),
        rect: rectSchema
          .optional()
          .describe(
            'Scope the report to a region `{x, y, w, h}`, so you are only told about defects inside it. Not a crop: every quantity is still measured over the whole canvas, because cutting a mask along a straight line gives it a straight edge that reads as a defect.',
          ),
        maxIssues: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('Ceiling on the flat `issues` list. Defaults to 40. Blocking issues are never dropped; `issuesTruncated` says when advisories were.'),
      }),
      // Not the shared envelope: the whole point of this payload is that
      // `report.excluded` (did not apply) and `report.dimensions.*.unmeasured`
      // (measured, and here is the part it could not reach) are different claims, and
      // the envelope names neither.
      outputSchema: QUALITY_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true },
    },
    (args) => {
      try {
        const doc = store.require(args.document as string | undefined);
        return ok(
          qualityPayload(doc.editor.sprite, {
            frame: args.frame as number | string | undefined,
            tag: args.tag as string | number | undefined,
            rect: args.rect as { x: number; y: number; w: number; h: number } | undefined,
            maxIssues: args.maxIssues as number | undefined,
            document: {
              id: doc.id,
              name: doc.editor.sprite.name,
              version: doc.editor.version,
            },
          }),
        );
      } catch (error) {
        // A bad tag, frame or focus rect is a targeting mistake, not bad artwork, so it
        // is reported as such rather than as a finding about the picture. The messages
        // come from `animationSequence` ("Unknown animation tag") and `resolveFrame`
        // ("Unknown frame" / "Frame index out of range").
        const message = (error as Error).message;
        const badTarget = /unknown animation tag|unknown frame|frame index out of range/i.test(message);
        return fail(message, {
          code: 'invalid_params',
          ...(badTarget
            ? { remediation: 'Call get_document for the real tag names and frame count, then pass a tag name or a 0-based frame index.' }
            : {}),
        });
      }
    },
  );

  addTool(
    server,
    'get_selection',
    {
      title: "Read the region the user boxed in",
      description:
        "Return the rectangle the user has boxed in the app's canvas, with the layer and frame it was drawn on. Call this whenever the user points rather than names - \"my selection\", \"the part I boxed\" - instead of guessing a region. `{selection: null}` is a real answer: work on the whole canvas. `mode` is `hint` (default; you may write just outside when the change needs room) or `enforce` (confine every write to it). Pass the returned `rect` to a drawing command's `rect`.",
      inputSchema: z.object({
        document: documentRef,
      }),
      annotations: { readOnlyHint: true },
    },
    (args) => {
      try {
        const doc = store.require(args.document as string | undefined);
        const selection = store.selection(doc);
        if (!selection) {
          return ok({
            ok: true,
            document: store.summary(doc),
            selection: null,
            note: 'The user has not boxed a region. Treat the whole canvas as the subject unless they name an area.',
          });
        }
        const { sprite } = doc.editor;
        const layer = selection.layerId ? sprite.layers.find((l) => l.id === selection.layerId) : undefined;
        const frame = selection.frameId ? sprite.frames.find((f) => f.id === selection.frameId) : undefined;
        return ok({
          ok: true,
          document: store.summary(doc),
          selection: {
            rect: selection.rect,
            mode: selection.mode,
            // `store.selection` has already dropped a box whose layer or frame is
            // gone, so both of these resolve or the whole box is null.
            layer: layer ? { id: layer.id, name: layer.name, index: sprite.layers.indexOf(layer) } : null,
            frame: frame ? { id: frame.id, index: sprite.frames.indexOf(frame) } : null,
            canvas: { width: sprite.width, height: sprite.height },
          },
        });
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  addTool(
    server,
    'set_selection',
    {
      title: 'Box a region, or clear the box',
      description:
        "Set the same rectangle `get_selection` reads, so you can point the app's canvas at a region yourself - useful for confirming a guess, or for narrowing a box the user drew too loosely. `rect` is `{x, y, w, h}` in canvas pixels, clipped to the canvas; a zero-area rect clears the box, as does `clear: true`. Session state: never written to the `.pixel` file, so this does not dirty the document.",
      inputSchema: z.object({
        document: documentRef,
        rect: z
          .object({ x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int() })
          .optional()
          .describe('Region to box, `{x, y, w, h}`. Negative `w`/`h` is accepted, so a rect read off two corners works either way round.'),
        mode: z
          .enum(['hint', 'enforce'])
          .optional()
          .describe('`hint` leaves you free to write just outside the box; `enforce` asks to be confined to it. Omit to keep the current mode.'),
        clear: z.boolean().optional().describe('Remove the selection. Same as passing a zero-area `rect`.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    (args) => {
      try {
        const doc = store.require(args.document as string | undefined);
        if (args.clear === true || args.rect === undefined) {
          if (args.clear !== true && args.rect === undefined) {
            return fail('Pass a `rect` to box a region, or `clear: true` to remove the box.');
          }
          store.setSelection(doc, null);
          return ok({ ok: true, document: store.summary(doc), selection: null });
        }
        const { sprite } = doc.editor;
        const current = store.selection(doc);
        const selection = store.setSelection(doc, {
          rect: args.rect as { x: number; y: number; w: number; h: number },
          layerId: current?.layerId,
          frameId: current?.frameId,
          mode: args.mode as 'hint' | 'enforce' | undefined,
        });
        if (!selection) {
          return fail(
            `That rect covers no pixel of the ${sprite.width}x${sprite.height} canvas, so there is nothing to select. Pass a rect that overlaps the canvas.`,
          );
        }
        return ok({ ok: true, document: store.summary(doc), selection });
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  addTool(
    server,
    'get_palette',
    {
      title: 'Read the palette',
      description: 'Return the document palette as hex colours with indices and optional semantic roles.',
      inputSchema: z.object({ document: documentRef }),
      annotations: { readOnlyHint: true },
    },
    (args) => {
      try {
        const doc = store.require(args.document as string | undefined);
        const palette = doc.editor.sprite.palette;
        const hex = (n: number) => n.toString(16).padStart(2, '0');
        return ok({
          ok: true,
          name: palette.name,
          size: palette.colors.length,
          colors: palette.colors.map((c, index) => ({
            index,
            hex: c.a === 255 ? `#${hex(c.r)}${hex(c.g)}${hex(c.b)}` : `#${hex(c.r)}${hex(c.g)}${hex(c.b)}${hex(c.a)}`,
            role: palette.roles?.[String(index)] ?? null,
          })),
        });
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  addTool(
    server,
    'get_history',
    {
      title: 'Read the edit history',
      description: 'List recent commands with their labels and summaries. Useful to see what you have already done in this session.',
      inputSchema: z.object({
        document: documentRef,
        limit: z.number().int().min(1).max(200).optional().describe('How many recent entries to return. Defaults to 20.'),
      }),
      annotations: { readOnlyHint: true },
    },
    (args) => {
      try {
        const doc = store.require(args.document as string | undefined);
        const history = doc.editor.history();
        const limit = (args.limit as number | undefined) ?? 20;
        return ok({
          ok: true,
          version: doc.editor.version,
          total: history.length,
          canUndo: doc.editor.canUndo(),
          canRedo: doc.editor.canRedo(),
          entries: history.slice(-limit),
        });
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  /* --------------------------------------------------------------- history */

  addTool(
    server,
    'undo',
    {
      title: 'Undo',
      description:
        'Undo the most recent edit, or several (`steps`). Cheap - use it freely when a pass makes the sprite worse instead of guessing forward.',
      inputSchema: z.object({
        document: documentRef,
        steps: z.number().int().min(1).max(100).optional().describe('How many edits to undo. Defaults to 1.'),
        count: z.number().int().min(1).max(100).optional().describe('Alias for `steps`.'),
      }),
      annotations: { destructiveHint: false },
    },
    (args) => {
      const doc = store.require(args.document as string | undefined);
      const steps = (args.steps as number | undefined) ?? (args.count as number | undefined) ?? 1;
      let done = 0;
      for (let i = 0; i < steps && doc.editor.canUndo(); i++) {
        doc.editor.undo();
        done++;
      }
      if (done) store.touch(doc);
      return ok({ ok: true, undone: done, version: doc.editor.version, canUndo: doc.editor.canUndo(), canRedo: doc.editor.canRedo() });
    },
  );

  addTool(
    server,
    'redo',
    {
      title: 'Redo',
      description:
        'Redo the edits `undo` just reverted, in the same order. Pass `steps` for more than one. Stopped early at the end of the redo stack, and the response says how many actually ran plus `canUndo`/`canRedo` for the next decision.',
      inputSchema: z.object({
        document: documentRef,
        steps: z.number().int().min(1).max(100).optional().describe('How many edits to redo. Defaults to 1.'),
        count: z.number().int().min(1).max(100).optional().describe('Alias for `steps`.'),
      }),
      annotations: { destructiveHint: false },
    },
    (args) => {
      const doc = store.require(args.document as string | undefined);
      const steps = (args.steps as number | undefined) ?? (args.count as number | undefined) ?? 1;
      let done = 0;
      for (let i = 0; i < steps && doc.editor.canRedo(); i++) {
        doc.editor.redo();
        done++;
      }
      if (done) store.touch(doc);
      return ok({ ok: true, redone: done, version: doc.editor.version, canUndo: doc.editor.canUndo(), canRedo: doc.editor.canRedo() });
    },
  );

  /* ----------------------------------------------------------------- batch */

  addTool(
    server,
    'apply_ops',
    {
      title: 'Apply a batch of commands',
      description:
        'Run any commands from the catalogue in one round trip - the cheapest way to build a sprite or every frame of an animation. An op is `{command, params}`, or the params inline: `{command: "draw_rect", layer: "base", rect: {…}, color: "#f00", fill: true}`. Set `defaultLayer`/`defaultFrame` once instead of per op, `layer`/`frame` fall back to the bottom layer and frame 0, and `atomic: true` restores the exact pre-batch state if any op fails. Every op attempted is reported, so a failure names the op and why. Add `preview: true` with `previewOptions: {scale: 4, frame}` for one frame, `{frames: "all", onion}` for an animation, or `{tilemap, debug}` for an unbaked grid. Each command you issue is promoted to a tool you can then call directly; `list_commands` is how you find a command in the first place.',
      inputSchema: z.object({
        document: documentRef,
        expectedVersion: versionRef,
        atomic: z
          .boolean()
          .optional()
          .describe('If true, restore the exact pre-batch document, version and history when any op fails. Defaults to false.'),
        stopOnError: z
          .boolean()
          .optional()
          .describe(
            'Stop at the first failing op and skip the rest. Defaults to false: every op is attempted and every failure is reported, which is what you want while iterating.',
          ),
        defaultLayer: layerRefSchema
          .optional()
          .describe('Layer applied to every op that needs one and does not name it. Defaults to the bottom layer.'),
        defaultFrame: frameRefSchema
          .optional()
          .describe('Frame applied to every op that needs one and does not name it. Defaults to frame 0.'),
        quiet: z
          .boolean()
          .optional()
          .describe('Return only the counts and the failures, without per-op summaries. Use it for long batches where you only care that nothing broke.'),
        singleUndoStep: z
          .boolean()
          .optional()
          .describe('Collapse the whole batch into one undo entry, the way `run_script` already does. Defaults to false, where every op is its own history entry.'),
        preview: z
          .boolean()
          .optional()
          .describe('Include a rendered PNG of the result in this response. Defaults to false.'),
        previewOptions: previewOptionsObjectSchema
          .optional()
          .describe('Configure the inline preview. Requires `preview: true`; use `{frames: "all", onion}` for animation review, `{scale: 4}` for sprite art, or `{tilemap, debug}` for an unbaked map.'),
        previewFrame: frameRefSchema
          .optional()
          .describe('Legacy alias for `previewOptions.frame`. Do not pass both.'),
        ops: z
          .array(z.record(z.string(), z.unknown()))
          .min(1)
          .describe('The commands to run, in order.'),
      }),
      annotations: { destructiveHint: false },
    },
    (args) => {
      let doc: PixelDocument;
      try {
        doc = store.require(args.document as string | undefined);
      } catch (error) {
        return fail((error as Error).message);
      }

      const previewOptions = args.previewOptions as PreviewRenderOptions | undefined;
      const previewFrame = args.previewFrame as number | string | undefined;
      if (previewOptions && args.preview !== true) {
        return fail('`previewOptions` requires `preview: true`.');
      }
      if (previewOptions?.frame !== undefined && previewFrame !== undefined) {
        return fail('Pass either `previewOptions.frame` or the legacy `previewFrame`, not both.');
      }
      if (previewOptions?.frames === 'all' && previewFrame !== undefined) {
        return fail('Pass either the legacy `previewFrame` or `previewOptions.frames: "all"`, not both.');
      }

      const expectedVersion = args.expectedVersion as number | undefined;
      if (expectedVersion !== undefined && expectedVersion !== doc.editor.version) {
        return fail(
          `Version conflict: expected version ${expectedVersion} but the document is at ${doc.editor.version}`,
          { code: 'version_conflict', expected: expectedVersion, actual: doc.editor.version },
        );
      }

      const rawOps = args.ops as RawOp[];
      const atomic = args.atomic === true;
      const stopOnError = args.stopOnError === true;
      const quiet = args.quiet === true;
      const defaults = {
        layer: args.defaultLayer as string | number | undefined,
        frame: args.defaultFrame as string | number | undefined,
      };

      const results: Array<Record<string, unknown>> = [];
      const failures: Array<Record<string, unknown>> = [];
      const advisories: Array<{ index: number; command: string; message: string }> = [];
      /** Commands this batch actually issued, promoted to direct tools at the end. */
      const issued = new Set<string>();
      const beforeVersion = doc.editor.version;
      let applied = 0;
      let failed = 0;
      let stoppedAt: number | null = null;
      const singleStep = args.singleUndoStep === true;

      const runOps = (): void => {
        for (let i = 0; i < rawOps.length; i++) {
          let op: { command: string; params: Record<string, unknown>; label?: string };
          try {
            op = normalizeOp(rawOps[i] ?? {});
          } catch (error) {
            failed++;
            const malformed = { index: i, command: '', code: 'invalid_op', error: briefError(error) };
            const rawCommand = rawOps[i];
            const maybeCommand =
              rawCommand && typeof rawCommand === 'object'
                ? (rawCommand as Record<string, unknown>).command ?? (rawCommand as Record<string, unknown>).name
                : undefined;
            if (typeof maybeCommand === 'string') malformed.command = maybeCommand;
            results.push({ ...malformed, ok: false });
            failures.push(malformed);
            if (stopOnError) {
              stoppedAt = i;
              break;
            }
            continue;
          }

          const command = store.registry.get(op.command);
          if (command) {
            issued.add(op.command);
            // An explicit default beats the implicit one, which beats nothing.
            const required = requiredArgsOf(command);
            if (required.has('layer') && op.params.layer === undefined && defaults.layer !== undefined) {
              op.params.layer = defaults.layer;
            }
            if (required.has('frame') && op.params.frame === undefined && defaults.frame !== undefined) {
              op.params.frame = defaults.frame;
            }
            fillDefaults(doc.editor.sprite, command, op.params);
          }

          // Dither is the one command whose misuse is invisible in a single edit, so
          // say something at the moment it is issued rather than leaving it to be
          // noticed later in a preview of the whole piece.
          if (op.command === 'dither_fill') {
            for (const message of ditherAdvisories(op.params)) {
              advisories.push({ index: i, command: op.command, message });
            }
          }

          const result = doc.editor.tryExecute(op.command, op.params, { label: op.label });
          if (result.ok) {
            applied++;
            results.push({ index: i, command: op.command, ok: true, summary: result.summary });
          } else {
            failed++;
            const error = briefError(result.error);
            // A batch failure is the most likely mistake an agent makes here, so each
            // one carries the specific next step. `describe_command` worked this out
            // from the registry; the advice below is the same for every caller.
            const remediation = commandRemediation(op.command, result.code, error);
            results.push({ index: i, command: op.command, ok: false, code: result.code, error, remediation });
            failures.push({ index: i, command: op.command, code: result.code, error, remediation });
            if (stopOnError) {
              stoppedAt = i;
              break;
            }
          }
        }
      };

      const atomicFailure = Symbol('apply_ops_atomic_failure');
      const runBatch = (): void => {
        runOps();
        if (atomic && failed > 0) throw atomicFailure;
      };

      try {
        if (singleStep) doc.editor.transaction('apply_ops', runBatch);
        else if (atomic) doc.editor.runAtomic(runBatch);
        else runOps();
      } catch (error) {
        if (error !== atomicFailure) throw error;
      }

      // A skipped tail is the one thing an agent cannot infer from the results, so say
      // it out loud: ops after `stoppedAt` never ran.
      const skipped = stoppedAt === null ? 0 : rawOps.length - stoppedAt - 1;

      // Issuing a command is the strongest possible signal that this session works in
      // those terms, so the tools it used become directly callable.
      const promotedTools = promoteAll(issued);

      if (atomic && failed > 0) {
        return ok({
          ok: false,
          committed: false,
          rolledBack: true,
          applied: 0,
          succeededBeforeRollback: applied,
          failed,
          skipped,
          version: beforeVersion,
          document: store.summary(doc),
          failures,
          advisories,
          promotedTools,
        });
      }

      if (applied > 0 && doc.editor.version !== beforeVersion) store.touch(doc);
      const blocks: ContentBlock[] = [];
      let previewMeta: Record<string, unknown> | undefined;
      let previewError: string | undefined;
      const inlinePreview = inlinePreviewOptions(args.preview, previewOptions, previewFrame);
      if (inlinePreview) {
        try {
          const rendered = previewPayload(doc.editor.sprite, inlinePreview);
          blocks.push(...rendered.blocks);
          previewMeta = rendered.meta;
        } catch (error) {
          previewError = briefError(error);
        }
      }

      return ok(
        {
          ok: failed === 0 && previewError === undefined,
          applied,
          failed,
          skipped,
          version: doc.editor.version,
          document: store.summary(doc),
          // The failure list is small and always worth having; the per-op results
          // are the bulky part, so `quiet` drops those instead.
          ...(failed > 0 ? { failures } : {}),
          ...(advisories.length > 0 ? { advisories } : {}),
          ...(quiet ? {} : { results }),
          ...(promotedTools.length > 0 ? { promotedTools } : {}),
          ...(previewMeta ? { preview: previewMeta } : {}),
          ...(previewError
            ? { previewError, editCommitted: applied > 0 }
            : {}),
        },
        blocks,
      );
    },
  );

  /* ---------------------------------------------------------------- export */

  addTool(
    server,
    'export_png',
    {
      title: 'Export a PNG',
      description:
        'Write the composited sprite to a PNG file. One frame by default; pass `frames: "all"` to write one file per frame (`name_0.png`, `name_1.png`, ...). Use `scale` to write a larger preview, and `rect` to crop first - writing a 1:1 crop to disk is the reliable fallback when an inline preview cannot be trusted.',
      inputSchema: z.object({
        document: documentRef,
        out: z.string().optional().describe('Destination PNG path.'),
        path: z.string().optional().describe('Alias for `out`, for callers who expect a source-style path argument.'),
        frame: frameRefSchema.optional().describe('Frame id or 0-based index. Defaults to frame 0.'),
        frames: z.enum(['one', 'all']).optional().describe('"one" (default) or "all" for one file per frame.'),
        scale: z.number().int().min(1).max(32).optional().describe('Integer upscale factor. Defaults to 1 (pixel-exact).'),
        rect: z
          .object({ x: z.number().int(), y: z.number().int(), w: z.number().int().min(1), h: z.number().int().min(1) })
          .optional()
          .describe('Crop to this region before writing, `{x, y, w, h}`. Lets a caller save a detail or a 1:1 crop to disk when the inline preview is not trustworthy.'),
        background: z.string().nullable().optional().describe('Composite over this colour instead of transparency.'),
      }),
      annotations: { destructiveHint: false },
    },
    (args) => {
      try {
        const doc = store.require(args.document as string | undefined);
        const sprite = doc.editor.sprite;
        const background = resolveBackground(args.background as string | null | undefined);
        const scale = (args.scale as number | undefined) ?? 1;
        // `path` is accepted as an alias so a caller does not have to remember that
        // sources use `path` and destinations use `out`.
        const out = (args.out as string | undefined) ?? (args.path as string | undefined);
        if (!out) return fail('`out` (or `path`) is required: where should the PNG be written?');

        const written: string[] = [];
        const crop = args.rect as { x: number; y: number; w: number; h: number } | undefined;
        const render = (frameId: string): PixelBuffer => {
          let buffer = compositeFrame(sprite, frameId, { background });
          if (crop) buffer = extractRegion(buffer, crop);
          if (scale > 1) buffer = scaleNearest(buffer, scale);
          return buffer;
        };
        let outWidth = sprite.width;
        let outHeight = sprite.height;
        if (crop) {
          outWidth = crop.w;
          outHeight = crop.h;
        }
        if (args.frames === 'all' && sprite.frames.length > 1) {
          const dot = out.lastIndexOf('.');
          const base = dot > 0 ? out.slice(0, dot) : out;
          const ext = dot > 0 ? out.slice(dot) : '';
          sprite.frames.forEach((frame, index) => {
            const path = `${base}_${index}${ext}`;
            writeFile(path, encodePNG(render(frame.id)));
            written.push(path);
          });
        } else {
          const frame = resolveFrame(sprite, (args.frame as number | string | undefined) ?? 0);
          writeFile(out, encodePNG(render(frame.id)));
          written.push(out);
        }

        return ok({
          ok: true,
          files: written,
          absolute: written.map(absPath),
          width: outWidth * scale,
          height: outHeight * scale,
          scale,
        });
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  addTool(
    server,
    'export_sheet',
    {
      title: 'Export a spritesheet',
      description:
        'Write a spritesheet PNG plus Aseprite-compatible JSON, which Unity, Godot, Phaser and LÖVE all read. Use `layout: "grid"` with `columns` for a power-of-two sheet. Animation tags are exported as frame tags so the engine gets your loop ranges and directions.',
      inputSchema: z.object({
        document: documentRef,
        out: z.string().optional().describe('Destination PNG path.'),
        path: z.string().optional().describe('Alias for `out`, for callers who expect a source-style path argument.'),
        json: z.string().optional().describe('Destination JSON path. Defaults to the PNG path with a `.json` extension.'),
        layout: z.enum(['horizontal', 'vertical', 'grid']).optional().describe('Sheet layout. Defaults to "horizontal".'),
        columns: z.number().int().min(1).optional().describe('Columns for the "grid" layout.'),
        padding: z.number().int().min(0).optional().describe('Transparent gap between frames, in pixels. Defaults to 0; use 1 to avoid texture bleed.'),
        margin: z.number().int().min(0).optional().describe('Transparent border around the sheet, in pixels. Defaults to 0.'),
        scale: z.number().int().min(1).max(32).optional().describe('Integer upscale factor for the sheet image. Defaults to 1.'),
      }),
      annotations: { destructiveHint: false },
    },
    (args) => {
      try {
        const doc = store.require(args.document as string | undefined);
        const sprite = doc.editor.sprite;
        const out = (args.out as string | undefined) ?? (args.path as string | undefined);
        if (!out) return fail('`out` (or `path`) is required: where should the spritesheet be written?');
        const jsonPath = (args.json as string | undefined) ?? out.replace(/\.png$/i, '') + '.json';

        const atlas = buildSpritesheet(sprite, {
          layout: (args.layout as 'horizontal' | 'vertical' | 'grid' | undefined) ?? 'horizontal',
          columns: args.columns as number | undefined,
          padding: args.padding as number | undefined,
          margin: args.margin as number | undefined,
        });
        const scale = (args.scale as number | undefined) ?? 1;
        // Scale the atlas, not just its image, so the JSON frame rects and
        // `meta.size` match the PNG the engine will actually slice.
        const sheet = scaleAtlas(atlas, scale);

        writeFile(out, encodePNG(sheet.image));

        const fileName = out.split(/[\\/]/).pop() ?? 'sheet.png';
        const json = toAsepriteJson(sprite, sheet, fileName);
        writeFile(jsonPath, Buffer.from(JSON.stringify(json, null, 2), 'utf8'));

        return ok({
          ok: true,
          image: out,
          json: jsonPath,
          imageAbsolute: absPath(out),
          jsonAbsolute: absPath(jsonPath),
          width: sheet.width,
          height: sheet.height,
          columns: atlas.columns,
          rows: atlas.rows,
          frames: atlas.frames.length,
          tags: atlas.tags,
        });
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  addTool(
    server,
    'export_tiled',
    {
      title: 'Export a Tiled map',
      description:
        'Write a self-contained Tiled 1.10 `.tmj` map, ready to open in Tiled or load from a game engine. One tile layer is written per tilemap, in order. By default the referenced tileset PNG is written beside the map as well; pass `writeTileset: false` only when supplying it yourself. Empty cells become `0`, tile `n` becomes `n + firstgid`, and malformed data, mixed tile sizes or out-of-range indices are rejected before any file is written.',
      inputSchema: z.object({
        document: documentRef,
        out: z.string().optional().describe('Destination .tmj path.'),
        path: z.string().optional().describe('Alias for `out`, for callers who expect a source-style path argument.'),
        image: z.string().optional().describe('Tileset image path referenced by the map. Relative paths are resolved beside `out`. Defaults to "tileset.png".'),
        writeTileset: z.boolean().optional().describe('Also write the referenced tileset PNG. Defaults to true.'),
        objectLayer: z.string().min(1).optional().describe('Name for the independent object-group layer. Defaults to "Objects".'),
        firstgid: z.number().int().min(1).optional().describe('First global tile id. Defaults to 1.'),
      }),
      annotations: { destructiveHint: false },
    },
    (args) => {
      try {
        const doc = store.require(args.document as string | undefined);
        const sprite = doc.editor.sprite;
        const out = (args.out as string | undefined) ?? (args.path as string | undefined);
        if (!out) return fail('`out` (or `path`) is required: where should the Tiled map be written?');
        if (!sprite.tileset) return fail('This document has no tileset. Run `create_tileset` first.');
        const tilemaps = sprite.tilemaps ?? [];
        if (tilemaps.length === 0) return fail('This document has no tilemaps. Run `add_tilemap` first.');

        const analyses = tilemaps.map((tilemap) => analyzeTilemapQuality(tilemap, sprite.tileset!));
        const malformed = analyses.find((analysis) => !analysis.dataLengthValid);
        if (malformed) {
          return fail(`Tilemap "${malformed.name}" stores ${malformed.dataLength} values for ${malformed.cells} cells. Fix it before export.`);
        }
        const baseSize = analyses[0];
        const mixedSize = baseSize
          ? analyses.find((analysis) =>
              analysis.tileWidth !== baseSize.tileWidth || analysis.tileHeight !== baseSize.tileHeight,
            )
          : undefined;
        if (mixedSize && baseSize) {
          return fail(
            `Tilemap "${mixedSize.name}" uses ${mixedSize.tileWidth}x${mixedSize.tileHeight} cells; the Tiled map uses ${baseSize.tileWidth}x${baseSize.tileHeight}.`,
          );
        }
        const invalid = analyses.find((analysis) => analysis.invalid > 0);
        if (invalid) {
          const first = invalid.invalidExamples[0];
          return fail(
            `Tilemap "${invalid.name}" has ${invalid.invalid} out-of-range tile cell(s); first at (${first.x}, ${first.y}) = ${first.tile}. Fix or clear them before export.`,
          );
        }

        const image = (args.image as string | undefined) ?? 'tileset.png';
        const firstgid = (args.firstgid as number | undefined) ?? 1;
        const map = toTiledJson(sprite.tileset, tilemaps, {
          image,
          firstgid,
          mapObjects: sprite.mapObjects ?? [],
          objectLayerName: args.objectLayer as string | undefined,
        });
        const tilesetPath = resolve(dirname(out), image);
        const writeTileset = args.writeTileset !== false;
        writeFile(out, Buffer.from(`${JSON.stringify(map, null, 2)}\n`, 'utf8'));
        if (writeTileset) writeFile(tilesetPath, encodePNG(sprite.tileset.image));

        return ok({
          ok: true,
          path: out,
          absolute: absPath(out),
          image,
          tilesetPath: writeTileset ? tilesetPath : null,
          tilesetWritten: writeTileset,
          firstgid,
          width: map.width,
          height: map.height,
          tileWidth: map.tilewidth,
          tileHeight: map.tileheight,
          layers: map.layers.map((layer) => layer.name),
          tiles: map.tilesets[0]?.tilecount ?? 0,
          tileProperties: Object.keys(sprite.tileset.tileProperties ?? {}).length,
          objects: sprite.mapObjects?.length ?? 0,
          document: store.summary(doc),
        });
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  addTool(
    server,
    'export_gif',
    {
      title: 'Export an animated GIF',
      description:
        'Write the animation to an animated GIF. By default every frame is written in order and the GIF loops forever. Pass `tag` to export one named animation instead: the tag\'s direction (`forward`, `reverse`, `pingpong`) and its repeat count decide the frame order, so a `pingpong` idle bounces without you duplicating any frames. `scale` upscales the whole GIF by an integer factor for a preview, and `background` fills transparency for targets that cannot show it.',
      inputSchema: z.object({
        document: documentRef,
        out: z.string().optional().describe('Destination GIF path.'),
        path: z.string().optional().describe('Alias for `out`, for callers who expect a source-style path argument.'),
        tag: z
          .union([z.string(), z.number().int()])
          .optional()
          .describe('Animation tag name, ID or index. Omit to export every frame in order.'),
        scale: z.number().int().min(1).max(32).optional().describe('Integer upscale factor. Defaults to 1.'),
        background: z
          .string()
          .optional()
          .describe('Fill transparent pixels with this colour instead of leaving them transparent.'),
        loop: z.boolean().optional().describe("Force looping on or off, overriding the tag's repeat setting."),
      }),
      annotations: { destructiveHint: false },
    },
    (args) => {
      try {
        const doc = store.require(args.document as string | undefined);
        const sprite = doc.editor.sprite;
        const out = (args.out as string | undefined) ?? (args.path as string | undefined);
        if (!out) return fail('`out` (or `path`) is required: where should the GIF be written?');

        const tag = args.tag as string | number | undefined;
        const scale = (args.scale as number | undefined) ?? 1;
        const bytes = encodeGIF(sprite, {
          tag,
          scale,
          background: (args.background as string | undefined) ?? null,
          loop: args.loop as boolean | undefined,
        });
        writeFile(out, bytes);

        const sequence = animationSequence(sprite, tag);
        return ok({
          ok: true,
          path: out,
          absolute: absPath(out),
          width: sprite.width * scale,
          height: sprite.height * scale,
          frames: sequence.frames.length,
          durationMs: sequence.durationMs,
          tag: sequence.name,
          loops: sequence.loops,
          bytes: bytes.length,
          document: store.summary(doc),
        });
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  /* ------------------------------------------------------------- discovery */

  addTool(
    server,
    'list_commands',
    {
      title: 'List all commands',
      description:
        'The full command catalogue, one compact line per command. This is how you find out what exists: the tool list is deliberately small, and a command becomes a directly callable tool the moment you look it up here by `name`, describe it, or run it. Use `param` to search parameter names, `filter` for a name/description substring, and `verbose: true` for full JSON Schemas. Every command in `commands` runs through `apply_ops` whether or not it is a tool yet; `sessionTools` are always called directly.',
      inputSchema: z.object({
        name: z.string().min(1).optional().describe('Return only this exact command/session-tool name. Looking a command up by name also promotes it to a direct tool.'),
        param: z.string().min(1).optional().describe('Only return commands whose schema contains a parameter with this name.'),
        filter: z.string().optional().describe('Only return entries whose name or description contains this text. Does not promote: browsing is not choosing.'),
        limit: z.number().int().min(1).max(256).optional().describe('Maximum command entries to return after filtering.'),
        verbose: z
          .boolean()
          .optional()
          .describe('Return the full JSON Schema for every command instead of the compact one-line form.'),
      }),
      annotations: { readOnlyHint: true },
    },
    (args) => {
      const exactName = args.name as string | undefined;
      const paramName = (args.param as string | undefined)?.toLowerCase();
      const filter = (args.filter as string | undefined)?.toLowerCase();
      const limit = args.limit as number | undefined;
      const registryCommands = store.registry.list();
      const selectedCommands = exactName
        ? registryCommands.filter((command) => command.name === exactName)
        : registryCommands;
      let catalog = describeCommands(selectedCommands);
      let sessionTools = [...SESSION_TOOLS];

      if (paramName) {
        catalog = catalog.filter((command) => {
          const schema = command.params as { properties?: Record<string, unknown> };
          return Object.keys(schema.properties ?? {}).some((key) => key.toLowerCase() === paramName);
        });
        // Session-tool schemas are not part of the core command registry, so a
        // parameter search cannot truthfully include them.
        sessionTools = [];
      }
      if (filter) {
        catalog = catalog.filter(
          (command) =>
            command.name.toLowerCase().includes(filter) || command.description.toLowerCase().includes(filter),
        );
        sessionTools = sessionTools.filter(
          (tool) => tool.name.toLowerCase().includes(filter) || tool.description.toLowerCase().includes(filter),
        );
      }
      if (exactName) {
        sessionTools = sessionTools.filter((tool) => tool.name === exactName);
      }
      const totalMatched = catalog.length;
      const truncated = limit !== undefined && totalMatched > limit;
      if (limit !== undefined) catalog = catalog.slice(0, limit);

      // An exact lookup is a decision to use this command, so it earns a tool. A
      // `filter` browse is not: promoting on a substring match would pull the whole
      // catalogue into the tool list one "draw" at a time.
      const promotedTools = exactName ? promoteAll([exactName]) : [];

      const hint =
        'Run anything in `commands` through apply_ops. Both op shapes work: {"ops": [{"command": "dither_fill", "params": {...}}]} ' +
        'or the params inline, {"ops": [{"command": "draw_rect", "layer": "base", "rect": {...}, "color": "#f00", "fill": true}]}. ' +
        '`tool: true` means you can also call it directly as a tool; `tool: false` means route it through apply_ops. ' +
        'Looking a command up by `name`, calling describe_command on it, or running it promotes it to a direct tool. ' +
        'describe_command also describes the entry-point tools, so it is the way to read apply_ops or finalize_document\'s full parameter list. ' +
        'Use param for parameter-name search and verbose: true for full JSON Schemas.';
      const build = {
        ...SKILL_FINGERPRINT,
        commandCount: registryCommands.length,
      };
      if (args.verbose === true) {
        return ok({
          ok: true,
          count: catalog.length,
          totalMatched,
          truncated,
          commands: catalog,
          sessionTools,
          promotedTools,
          build,
          hint,
        });
      }
      return ok({
        ok: true,
        count: catalog.length,
        totalMatched,
        truncated,
        commands: catalog.map((command) => ({ ...compactCommand(command), tool: promoted.has(command.name) })),
        sessionTools,
        promotedTools,
        promotedCount: promoted.size,
        // The registry and the guide are both a snapshot of what this process loaded
        // at startup. If either disagrees with a freshly built server, the MCP server
        // is running a stale build and needs restarting - everything here still works,
        // it is just last week's version.
        build,
        hint,
      });
    },
  );

  addTool(
    server,
    'describe_command',
    {
      title: 'Describe one command or tool',
      description:
        'The exact schema and documentation for one command or one of the entry-point tools. Use it for a command you know only by name - it also promotes that command to a tool you can call directly. It is also the only way to read the full parameter list of a tool like `apply_ops` or `finalize_document` without reading the tool list.',
      inputSchema: z.object({
        name: z.string().min(1).describe('A command name from `list_commands`, or a tool name from the tool list.'),
      }),
      annotations: { readOnlyHint: true },
    },
    (args) => {
      const name = args.name as string;
      const command = store.registry.get(name);
      const declared = DECLARED_TOOLS.get(name);

      // A session tool owns its name outright, so `evaluate` describes the tool an
      // agent can actually call rather than the core command that happens to share the
      // word. When both exist, say so and hand over the command's schema too - the
      // command still runs through `apply_ops`, it just never becomes a tool.
      if (declared && SESSION_TOOL_NAMES.has(name)) {
        return ok({
          ok: true,
          kind: 'tool',
          tool: { name, ...declared },
          ...(command ? { sameNamedCommand: describeCommand(command), commandRoutableVia: 'apply_ops' } : {}),
          note: `"${name}" is an entry-point tool, always callable by name.${command ? ` A core command shares the name and is reachable through apply_ops {ops: [{command: "${name}", ...}]}; the tool is the one advertised.` : ''}`,
        });
      }

      if (command) {
        const promotedTools = promoteAll([name]);
        return ok({
          ok: true,
          kind: 'command',
          command: describeCommand(command),
          ...(command.guide ? { guideUri: `pixel://guide/${command.name}` } : {}),
          // Naming it explicitly is the difference between a model that knows it may
          // call `draw_line` next and one that keeps routing everything through
          // apply_ops out of habit.
          promotedTools,
          nowATool: true,
        });
      }

      // A tool, not a command. The old answer here was `unknown_command` with a
      // remediation that told the caller to search the command catalogue for a tool
      // that was never in it.
      if (declared) {
        return ok({
          ok: true,
          kind: 'tool',
          tool: { name, ...declared },
          note: `"${name}" is an entry-point tool, always callable by name. Commands are the rest of the catalogue; use list_commands for those.`,
        });
      }

      // Point at whichever namespace the name actually resembles. Sending a caller
      // to search the command catalogue for a misspelled *tool* is advice that cannot
      // possibly work, and it is the advice this used to give unconditionally.
      const commandNames = store.registry.list().map((c) => c.name);
      const toolNames = [...DECLARED_TOOLS.keys()];
      const toolClosest = closest(name, toolNames);
      const commandClosest = closest(name, commandNames);
      const looksLikeTool = toolClosest !== undefined && (commandClosest === undefined || toolClosest <= commandClosest);
      const didYouMean = looksLikeTool ? toolClosest : commandClosest;
      return fail(`Unknown command or tool: ${name}`, {
        code: 'unknown_command',
        ...(didYouMean !== undefined ? { didYouMean } : {}),
        remediation: looksLikeTool
          ? `"${name}" is not a name in either namespace; the closest tool is "${toolClosest}". The 33 entry-point tools are always in the tool list.`
          : `Search the command catalogue with list_commands {filter: "${name}"}, or read the entry-point tools from the tool list.`,
      });
    },
  );

  addTool(
    server,
    'find_workflow',
    {
      title: 'Find a task workflow',
      description:
        'Search task-level workflows that combine several commands, instead of returning only low-level primitives. Each workflow names the commands it recommends, and the strongest match has those commands promoted to direct tools - so one question like "paint a coastline" is enough to get the right tools into your tool list.',
      inputSchema: z.object({
        goal: z.string().min(1).describe('Natural-language task, e.g. "create an attack animation" or "export engine assets".'),
        limit: z.number().int().min(1).max(8).optional().describe('Maximum workflows to return. Defaults to 3.'),
      }),
      annotations: { readOnlyHint: true },
    },
    (args) => {
      const goal = (args.goal as string).toLowerCase();
      const tokens = goal.split(/[^a-z0-9*]+/).filter(Boolean);
      const scored = WORKFLOW_CATALOG.map((workflow) => {
        const haystack = `${workflow.title} ${workflow.keywords.join(' ')} ${workflow.steps.join(' ')}`.toLowerCase();
        const score = tokens.reduce((total, token) => total + (workflow.keywords.some((keyword) => keyword.includes(token) || token.includes(keyword)) ? 5 : haystack.includes(token) ? 1 : 0), 0);
        return { ...workflow, score };
      }).filter((workflow) => workflow.score > 0 || tokens.length === 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, (args.limit as number | undefined) ?? 3);
      // A workflow is a recommendation to use these commands, so promote them - but
      // only from the best match, or one broad question would sweep the catalogue in.
      const promotedTools = promoteAll(commandsMentioned(scored[0]?.steps ?? [], store));
      return ok({
        ok: true,
        goal: args.goal,
        count: scored.length,
        workflows: scored,
        promotedTools,
        hint: 'Any command named in a step runs through apply_ops; the ones in `promotedTools` are also callable directly as tools.',
      });
    },
  );

  /* -------------------------------------------- generated command tools */

  // In `lazy` mode nothing is registered here on purpose: the catalogue is reachable
  // through `list_commands`/`describe_command`/`apply_ops`, and a command joins the
  // tool list the first time this session actually touches it. See `CommandExposure`.
  if (exposure === 'eager') {
    // The same guard {@link promote} applies, and for the same reason. `evaluate` is a session
    // tool *and* a core command, and `registerTool` **throws** on a duplicate name — so
    // registering the command here takes the whole server down at startup with
    // `Tool evaluate is already registered`, which is exactly what happened the first time eager
    // mode met T-020. The session tool keeps the name (it is the advertised one) and the command
    // stays reachable through `apply_ops`. It is deliberately **not** added to `promoted`, so
    // `list_commands` reports `tool: false` for it rather than claiming a tool that was skipped.
    for (const command of store.registry.list()) {
      if (SESSION_TOOL_NAMES.has(command.name)) continue;
      promoted.add(command.name);
      registerCommandTool(server, store, command, 'core');
    }
  }

  /* ------------------------------------------------------------- scripting */

  // One runtime per server session, so plugins loaded by `load_plugin` stay
  // resident and the commands they define are callable from later scripts. A
  // script never touches the host: every value crosses a JSON bridge.
  const scriptRuntime = new ScriptRuntime();
  const loadedPlugins = new Map<string, string[]>();

  addTool(
    server,
    'run_script',
    {
      title: 'Run a sandboxed script',
      description:
        'Run trusted JavaScript against the current document in a constrained `node:vm` context. It is a convenience, not a security boundary: only run source you have read. Give the program as `source` inline, or as `path` to a .js file - a file is re-read on every call and never cached, so editing it changes the next run with no restart, and `params` (readable as the global of the same name) then makes one file a function of its inputs instead of something you re-send per variation. `exec`/`tryExec` drive the same command bus as the tools; `draw.*`, `document()`, `layers()`, `frames()`, `palette()`, `getPixel`, `sample` cover most editing without spelling out params. The whole script is one undo step, and `dryRun: true` runs it against an isolated snapshot. Add `preview: true` with `previewOptions` for a PNG in the same response. Failures report the error name, a stack in your own line numbers, and the offending source line. See pixel://script-guide.',
      inputSchema: z.object({
        document: documentRef,
        expectedVersion: versionRef,
        source: z
          .string()
          .optional()
          .describe('JavaScript function body, mutually exclusive with `path`. Return a JSON-serialisable value to get it back in `result`.'),
        path: z
          .string()
          .optional()
          .describe(
            'Path to a .js file holding the same function body, mutually exclusive with `source`. Re-read on every call and never cached, so editing the file changes the next run with no restart. Relative paths resolve against the server working directory; `~` expands. The response reports `resolvedPath`.',
          ),
        params: z
          .unknown()
          .optional()
          .describe(
            'Structured input, exposed to the script as the global `params` (an object, `{}` when omitted). With `path` this is what lets a generator be a function of its inputs, so tuning a number never means editing and re-sending the program.',
          ),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(60000)
          .optional()
          .describe(
            'Execution budget in milliseconds. Defaults to 15000. Raise it for a script that generates a large field procedurally; a 256x256 scene can be a few hundred command calls inside one script.',
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe('Execute against an isolated document snapshot for validation and preview only. Never changes the live document, version, history, or dirty state.'),
        preview: z
          .boolean()
          .optional()
          .describe('Return a PNG of the document after the script runs in this same response.'),
        previewOptions: previewOptionsObjectSchema
          .optional()
          .describe('Configure the inline preview. Requires `preview: true`; `{scale: 4}` is the normal sprite view, `{frames: "all", onion}` checks a complete animation, and `{tilemap, debug}` previews an unbaked map.'),
      }),
      // Executes caller-supplied code. `openWorldHint` is the only honest signal here:
      // a client that gates on it should not silently auto-approve this one.
      annotations: { openWorldHint: true },
    },
    (args) => {
      let doc: PixelDocument;
      try {
        doc = store.require(args.document as string | undefined);
      } catch (error) {
        return fail((error as Error).message, {
          code: 'no_document',
          remediation: 'Create one with create_document, or pass the id of an open document as `document`.',
        });
      }

      // `source` and `path` are the same thing by two routes, so accepting both would
      // mean silently picking one. Say which is which instead.
      const inlineSource = args.source as string | undefined;
      const scriptPath = args.path as string | undefined;
      if (inlineSource !== undefined && scriptPath !== undefined) {
        return fail('Pass either `source` or `path`, not both.', {
          code: 'invalid_params',
          remediation:
            '`source` is the program inline; `path` names a .js file holding the same function body. Use one or the other.',
        });
      }
      if (inlineSource === undefined && scriptPath === undefined) {
        return fail('run_script needs either `source` or `path`.', {
          code: 'invalid_params',
          remediation: 'Pass the function body as `source`, or a .js file path as `path`.',
        });
      }

      let resolvedPath: string | undefined;
      let source: string;
      if (scriptPath !== undefined) {
        resolvedPath = absPath(expandHome(scriptPath));
        try {
          source = readFileSync(resolvedPath, 'utf8');
        } catch (error) {
          return fail(`Could not read script file: ${briefError(error)}`, {
            code: 'script_not_readable',
            resolvedPath,
            remediation: `Check that ${resolvedPath} exists and is readable UTF-8 text, or pass the program inline as \`source\`.`,
          });
        }
      } else {
        source = inlineSource as string;
      }

      const previewOptions = args.previewOptions as PreviewRenderOptions | undefined;
      if (previewOptions && args.preview !== true) {
        return fail('`previewOptions` requires `preview: true`.', {
          code: 'preview_conflict',
          remediation: 'Drop `previewOptions`, or set `preview: true` so the options have something to configure.',
        });
      }
      if (previewOptions?.frames === 'all' && previewOptions.frame !== undefined) {
        return fail('Pass either `frame` or `frames: "all"`, not both.', {
          code: 'preview_conflict',
          remediation: 'To render the whole animation use `frames: "all"` on its own; `frame` is for a single frame.',
        });
      }
      const expectedVersion = args.expectedVersion as number | undefined;
      if (expectedVersion !== undefined && expectedVersion !== doc.editor.version) {
        return fail(
          `Version conflict: expected version ${expectedVersion} but the document is at ${doc.editor.version}`,
          {
            code: 'version_conflict',
            expected: expectedVersion,
            actual: doc.editor.version,
            remediation: 'Re-read the document and retry with the version it reports now.',
          },
        );
      }

      const timeoutMs = args.timeoutMs as number | undefined;
      const dryRun = args.dryRun === true;
      // A procedural script that lays down a whole 256x256 scene is a few hundred
      // command calls; the core default of 2s kills it mid-run. Give the MCP path a
      // budget that matches the work agents actually submit.
      const runtime = new ScriptRuntime({ timeoutMs: timeoutMs ?? 15_000 });
      const liveVersion = doc.editor.version;
      const targetEditor = dryRun ? createEditor(doc.editor.snapshot(), doc.editor.registry) : doc.editor;
      const targetVersion = targetEditor.version;
      const outcome = runtime.run(source, targetEditor, {
        params: args.params,
        // Naming the file in the stack beats handing back an offset to do arithmetic
        // with, and it costs nothing when the program came inline.
        sourceName: resolvedPath ?? 'source',
      });
      const changed = targetEditor.version !== targetVersion;
      if (!dryRun && changed) store.touch(doc);
      // A dry run still counts: finding out what a script touches is exactly what a
      // dry run is for, and promoting from it means the follow-up edit has a tool.
      const promotedTools = promoteAll(outcome.commands);

      if (!outcome.ok) {
        return fail(outcome.error ?? 'The script failed.', {
          code: outcome.code,
          // `errorInfo` now carries the remapped stack plus the offending source line,
          // so the fix does not need a second run to locate the bug.
          errorInfo: outcome.errorInfo,
          logs: outcome.logs,
          promotedTools,
          dryRun,
          committed: false,
          changed: false,
          version: liveVersion,
          document: store.summary(doc),
        });
      }

      const blocks: ContentBlock[] = [];
      let preview: Record<string, unknown> | undefined;
      let previewError: string | undefined;
      const inlinePreview = inlinePreviewOptions(args.preview, previewOptions);
      if (inlinePreview) {
        try {
          const rendered = previewPayload(targetEditor.sprite, inlinePreview);
          blocks.push(...rendered.blocks);
          preview = rendered.meta;
        } catch (error) {
          previewError = briefError(error);
        }
      }

      return ok(
        {
          ok: previewError === undefined,
          result: outcome.result,
          logs: outcome.logs,
          dryRun,
          changed,
          committed: !dryRun && changed,
          version: dryRun ? liveVersion : doc.editor.version,
          document: store.summary(doc),
          promotedTools,
          ...(resolvedPath ? { resolvedPath } : {}),
          ...(preview ? { preview } : {}),
          ...(previewError ? { previewError, editCommitted: !dryRun && changed } : {}),
        },
        blocks,
      );
    },
  );

  addTool(
    server,
    'load_plugin',
    {
      title: 'Load a plugin',
      description:
        'Load a plugin script that calls `defineCommand({ name, description, params, run })`. Every command it defines joins the registry: runnable from scripts via `exec`, routable through `apply_ops`, listed by `list_commands`, and registered as a tool. This is code the server did not write, running against your document with the same authority as the built-in commands, so its tools are marked `openWorldHint` and `destructiveHint` in the declaration - read the source before loading it.',
      inputSchema: z.object({
        source: z.string().optional().describe('Plugin source. Provide this or `path`.'),
        path: z.string().optional().describe('Path to a plugin .js file to read.'),
        name: z.string().optional().describe('Plugin name, shown by `list_plugins`. Defaults to the file name.'),
      }),
      // Reads a file and installs code. Both halves are outside the document.
      annotations: { openWorldHint: true },
    },
    (args) => {
      const filePath = args.path as string | undefined;
      let source = args.source as string | undefined;
      const name = (args.name as string | undefined) ?? (filePath ? basename(filePath) : 'plugin');

      if (!source && filePath) {
        try {
          source = readFileSync(filePath, 'utf8');
        } catch (error) {
          return fail(`Could not read plugin file: ${briefError(error)}`, {
            code: 'invalid_params',
            remediation: 'Check the path, or pass the plugin inline as `source`.',
          });
        }
      }
      if (!source) {
        return fail('load_plugin needs either `source` or `path`.', {
          code: 'invalid_params',
          remediation: 'Pass the plugin text as `source`, or a readable file as `path`.',
        });
      }

      const outcome = scriptRuntime.loadPlugin(source, { name, registry: store.registry });
      if (!outcome.ok) {
        return fail(outcome.error ?? 'The plugin failed to load.', {
          code: 'plugin_load_failed',
          errorInfo: outcome.errorInfo,
          logs: outcome.logs,
        });
      }

      // A plugin is an explicit, deliberate act, so its commands are exposed
      // immediately rather than on discovery - the caller asked for this code by name.
      for (const commandName of outcome.commands) pluginCommands.add(commandName);
      const promotedTools = promoteAll(outcome.commands);
      loadedPlugins.set(name, outcome.commands);

      return ok({
        ok: true,
        name,
        commands: outcome.commands,
        logs: outcome.logs,
        promotedTools,
        toolCount: store.registry.list().length,
      });
    },
  );

  addTool(
    server,
    'list_plugins',
    {
      title: 'List loaded plugins',
      description: 'The plugins loaded in this session and the commands each one registered, so you can tell which editing tools came from a plugin rather than from the editor. A plugin\'s commands carry `openWorldHint` in their declaration - treat them as code you have not read.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    () =>
      ok({
        ok: true,
        plugins: [...loadedPlugins.entries()].map(([name, commands]) => ({ name, commands })),
      }),
  );

  /* --------------------------------------------------------------- skills */

  addTool(
    server,
    'read_skill',
    {
      title: 'Read the pixel art craft guide',
      description:
        'How to make pixel art that does not look bad: silhouette-first workflow, hue-shifted ramps, selective outlines, dithering, anti-aliasing and animation. Read this before drawing anything non-trivial - the tool list alone will not give you taste.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    () => ok({ ok: true, skill: PIXEL_ART_SKILL }),
  );

  /* -------------------------------------------------------------- recipes */

  addTool(
    server,
    'describe_recipe',
    {
      title: 'Read an art-direction recipe',
      description:
        'The art-direction brief for one class of game asset - platformer, top-down RPG, dungeon tileset, UI icon, inventory item. Call it with no `id` to list what ships. A recipe is guidance, not a command sequence: it names sizes, palette ramps, layers, tone planes, production order, the mistakes that class keeps making, and read-only checks. It carries no scores, so there is nothing in it to optimise toward.',
      inputSchema: z.object({
        id: z
          .string()
          .optional()
          .describe(
            'Kebab-case recipe id, e.g. "topdown-rpg" or "ui-icons" - the same id as in pixel://recipe/{id}. Omit it to get the catalogue with one-line summaries instead of a whole recipe.',
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    (args) => {
      const id = args.id as string | undefined;

      // No id is a listing rather than an error, because "what recipes are there?" is a
      // question this tool exists to answer and the catalogue is small enough to return
      // whole. It also means the discovery path costs one call, not a failure and a retry.
      if (id === undefined) {
        const ids = listRecipeIds();
        const recipes = ids.map((candidate) => loadRecipe(candidate));
        return ok({
          ok: true,
          count: ids.length,
          ids,
          // A broken file is reported in place rather than dropped: a recipe that exists
          // on disk and cannot be read is a defect an agent has to know about, and a
          // catalogue that silently omits it looks exactly like a catalogue where nobody
          // has written that recipe yet.
          recipes: recipes.map((loaded) => (loaded.ok ? summarise(loaded.recipe) : { id: loaded.id, issues: loaded.issues })),
        });
      }

      const loaded = loadRecipe(id);
      if (!loaded.ok) {
        return fail(
          loaded.issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join(' ').slice(0, 320),
          { code: 'unknown_recipe', id, issues: loaded.issues },
        );
      }
      return ok({ ok: true, id: loaded.recipe.id, source: loaded.source, recipe: loaded.recipe });
    },
  );
}

/**
 * Register one command as an MCP tool, extending its own schema with the
 * document/version targeting arguments.
 *
 * Core commands are deliberately explicit - they *require* a layer and a frame,
 * because silently painting on the wrong layer is worse than a validation error.
 * An agent, though, should not have to spell out `frame: 0` on every call, so
 * where core requires those arguments the MCP schema makes them optional and
 * fills in the obvious default (bottom layer, frame 0). Commands that treat
 * `layer`/`frame` as an optional *filter* keep their original meaning.
 */
/**
 * Commands whose `layer` also accepts `*` for "every layer on this frame".
 *
 * They must keep their original union schema: swapping in a plain `layerRefSchema`
 * would reject `layer: "*"` with a validation error, and moving every layer together
 * is the whole point of these two.
 */
const ALL_LAYERS_COMMANDS = new Set(['translate', 'squash']);

/** Acronyms that must not be title-cased character by character. */
const TITLE_ACRONYMS = new Set(['png', 'gif', 'rgb', 'id', 'url', 'json', 'tmj', 'cel', 'cels']);

/**
 * `draw_polyline` -> `Draw Polyline`.
 *
 * The generated `title` used to be `name.replace(/_/g, ' ')`, which reached clients as
 * a lowercase run-on. Titles are what a UI shows in a tool picker and what several
 * clients route on, so they are worth the three lines.
 */
function humanize(name: string): string {
  return name
    .split('_')
    .filter(Boolean)
    .map((word) => (TITLE_ACRONYMS.has(word) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)))
    .join(' ');
}

/**
 * The result shape every command tool returns, spelled out rather than left to the
 * shared envelope: for a promoted command this schema is often the only declaration
 * the model has, and `command` plus `summary` are the two fields it actually reads.
 */
const COMMAND_OUTPUT_SCHEMA = z.looseObject({
  ok: z.literal(true).describe('Always true; a failed call returns isError with `error` and `code` instead.'),
  command: z.string().describe('The command that ran.'),
  version: z.number().int().describe('Document version after the edit. Send it back as `expectedVersion` on your next write.'),
  // A command summary is whatever that command found worth reporting: an object for
  // most (`{painted: 16}`), a sentence for a few. Both are legal, so both are declared.
  summary: z
    .union([z.string(), z.record(z.string(), z.unknown())])
    .optional()
    .describe('What the command changed, in its own terms: an object of counts, or a sentence.'),
});

function registerCommandTool(
  server: McpServer,
  store: DocumentStore,
  command: Command,
  source: 'core' | 'plugin' = 'core',
): void {
  const base = command.params as unknown as z.ZodObject<z.ZodRawShape>;
  if (typeof base?.extend !== 'function') return;

  const required = requiredArgsOf(command);

  const shape: Record<string, z.ZodType> = { document: documentRef, expectedVersion: versionRef };
  if (required.has('layer')) {
    const original = (base.shape as Record<string, z.ZodType>).layer;
    if (ALL_LAYERS_COMMANDS.has(command.name) && original) {
      shape.layer = original
        .optional()
        .describe('A layer ID, layer name or 0-based index, or `*` for every layer on the frame. Defaults to the bottom layer.');
    } else {
      shape.layer = layerRefSchema
        .optional()
        .describe('Layer ID, layer name, or 0-based index counting from the bottom. Defaults to the bottom layer.');
    }
  }
  if (required.has('frame')) {
    shape.frame = frameRefSchema
      .optional()
      .describe('Frame ID or 0-based frame index. Defaults to frame 0.');
  }

  const inputSchema = base.extend(shape);
  const guideHint = command.guide
    ? ` Full manual: \`describe_command\` or pixel://guide/${command.name}.`
    : '';

  addTool(
    server,
    command.name,
    {
      title: humanize(command.name),
      // Undo is a single editor-level step, so say so: "reversible" is the first
      // question a caller has about a mutating command.
      description: `${command.description} Undoable as one step.${guideHint}`,
      inputSchema,
      outputSchema: COMMAND_OUTPUT_SCHEMA,
      annotations: {
        readOnlyHint: command.readOnly === true,
        // A promoted plugin command is code this server did not write, running with
        // the caller's document. It is neither read-only nor confined, and the client
        // is the only thing standing between it and the user's files.
        ...(source === 'plugin' ? { openWorldHint: true, destructiveHint: true } : {}),
      },
      meta: {
        kind: 'command',
        source,
        ...(command.guide ? { guide: `pixel://guide/${command.name}` } : {}),
      },
    },
    (args) => {
      const { document: documentId, expectedVersion, ...params } = args;
      let doc: PixelDocument;
      try {
        doc = store.require(documentId as string | undefined);
      } catch (error) {
        return fail((error as Error).message, {
          code: 'no_document',
          remediation: 'Create one with create_document, or pass the id of an open document as `document`.',
        });
      }

      const sprite = doc.editor.sprite;
      if (required.has('layer') && params.layer === undefined && !sprite.layers[0]) {
        return fail('This document has no layers.', { code: 'no_layers', command: command.name });
      }
      if (required.has('frame') && params.frame === undefined && sprite.frames.length === 0) {
        return fail('This document has no frames.', { code: 'no_frames', command: command.name });
      }
      fillDefaults(sprite, command, params);

      const result = doc.editor.tryExecute(command.name, params, {
        expectedVersion: expectedVersion as number | undefined,
      });
      if (!result.ok) {
        const error = briefError(result.error);
        return fail(result.error, {
          code: result.code,
          command: command.name,
          remediation:
            result.code === 'version_conflict'
              ? 'Re-read the document and retry with the version it reports now.'
              : commandRemediation(command.name, result.code, error),
        });
      }
      if (!command.readOnly) store.touch(doc);
      return ok({
        ok: true,
        command: command.name,
        version: doc.editor.version,
        summary: result.summary,
      });
    },
  );
}
