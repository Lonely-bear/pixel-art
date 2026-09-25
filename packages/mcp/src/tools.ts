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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ContentBlock, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { SKILL_FINGERPRINT } from './server.js';
import {
  animationSequence,
  buildSpritesheet,
  compositeFrame,
  compositeWithOnion,
  createEditor,
  describeCommands,
  encodeGIF,
  encodePNG,
  extractRegion,
  fillCommandDefaults,
  requiredCommandArgs,
  frameRefSchema,
  isAseprite,
  layerRefSchema,
  parseColor,
  PixelBuffer,
  resolveFrame,
  resolveLayer,
  resolveDitherLevel as resolveCoreDitherLevel,
  ditherLevelResolution as coreDitherLevelResolution,
  blitTilemap,
  renderTilemap,
  resolveTilemap,
  scaleAtlas,
  scaleNearest,
  spriteFromAseprite,
  spriteFromPng,
  tileCount,
  toAsepriteJson,
  toTiledJson,
  type Command,
  type Sprite,
  type TilemapLayer,
} from '@pixel/core';
import { z } from 'zod';
import { ScriptRuntime } from '@pixel/script';
import { BUILTIN_PALETTES, type DocumentStore, type PixelDocument } from './session.js';
import { PIXEL_ART_SKILL } from './skill.js';
import { analyzeLandscape } from './quality-landscape.js';
import { analyzeTilemapQuality } from './quality-tilemap.js';
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

const previewRectSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    w: z.number().int().min(1).max(4096),
    h: z.number().int().min(1).max(4096),
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
      .array(z.object({ x: z.number().int(), y: z.number().int() }).strict())
      .max(4096)
      .optional()
      .describe('Exact tile cells to outline in magenta.'),
    highlightRect: z
      .object({
        x: z.number().int(),
        y: z.number().int(),
        w: z.number().int().min(1),
        h: z.number().int().min(1),
      })
      .strict()
      .optional()
      .describe('Changed tile region to outline in magenta.'),
  })
  .strict();

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
  'preview_tilemap',
  'get_pixels',
  'histogram',
  'quality_report',
  'list_commands',
  'list_documents',
]);

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
  { name: 'preview_tilemap', description: 'Render an unbaked tilemap with optional grid, tile-index and changed-cell overlays.' },
  { name: 'get_pixels', description: 'Exact pixel colours in a small region.' },
  { name: 'histogram', description: 'Per-colour pixel counts and unused palette slots for a region.' },
  { name: 'quality_report', description: 'Objective defect/presence report with internal landscape structure and fix warnings.' },
  { name: 'get_document', description: 'Layers, frames, tags, palette.' },
  { name: 'get_palette', description: 'Palette as hex colours with indices.' },
  { name: 'list_documents', description: 'List open documents.' },
  { name: 'create_document', description: 'Create a blank sprite document.' },
  { name: 'open_document', description: 'Load a `.pixel` document.' },
  { name: 'save_document', description: 'Save to a `.pixel` file.' },
  { name: 'finalize_document', description: 'Save the editable source and export one or more PNGs in one call.' },
  { name: 'import_image', description: 'Import a PNG or Aseprite file.' },
  { name: 'select_document', description: 'Make a document active.' },
  { name: 'close_document', description: 'Drop a document from the session.' },
  { name: 'export_png', description: 'Write the sprite to a PNG.' },
  { name: 'export_sheet', description: 'Spritesheet PNG + Aseprite JSON.' },
  { name: 'export_tiled', description: 'Tilemaps as a Tiled `.tmj` map.' },
  { name: 'export_gif', description: 'Write an animated GIF.' },
  { name: 'apply_ops', description: 'Run a batch of core commands with optional atomic rollback and inline preview.' },
  { name: 'run_script', description: 'Run a sandboxed script.' },
  { name: 'load_plugin', description: 'Load a plugin defining commands.' },
  { name: 'list_plugins', description: 'List loaded plugins.' },
  { name: 'read_skill', description: 'The pixel-art craft guide.' },
  { name: 'list_commands', description: 'This catalogue.' },
];

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

function imageContent(buffer: PixelBuffer): ContentBlock {
  const bytes = encodePNG(buffer);
  return {
    type: 'image',
    data: Buffer.from(bytes).toString('base64'),
    mimeType: 'image/png',
  };
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
    palette: { name: sprite.palette.name, size: sprite.palette.colors.length },
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

interface QualityAnalysisOptions {
  rect?: { x: number; y: number; w: number; h: number };
  noiseThreshold?: number;
  alphaThreshold?: number;
  /** Analyse this tilemap directly instead of a composited pixel frame. */
  tilemap?: TilemapLayer;
  /** Optional base map under an alpha-masked terrain/edge map. */
  underlay?: TilemapLayer;
  replaceEmpty?: number;
  /** Optional square grid for per-region outlier/isolated counts. */
  grid?: number;
  /**
   * Regions filled with deliberate texture - `scatter`, grain, foliage, sparkle.
   * Outliers inside them are counted separately instead of raising noise warnings,
   * because high-frequency detail is the point there, not a defect.
   */
  textureRects?: Array<{ x: number; y: number; w: number; h: number }>;
}

type PixelAt = (x: number, y: number) => { r: number; g: number; b: number; a: number } | null;

function luminanceOf(c: { r: number; g: number; b: number }): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/**
 * Palette slots that never reach the canvas, plus the used pairs that sit closer
 * together than the eye resolves as separate tones.
 *
 * Reporting the *indices* matters: "5 colours are unused" is not actionable, but
 * "remove slots 17 and 18" is.
 */
function analyzePaletteUsage(
  paletteColors: readonly { r: number; g: number; b: number; a: number }[],
  unique: Set<number>,
  crowdedDelta: number,
): { unusedIndices: number[]; crowded: Array<{ a: number; b: number; delta: number }> } {
  const packed = (c: { r: number; g: number; b: number; a: number }): number =>
    ((c.r & 255) << 24) | ((c.g & 255) << 16) | ((c.b & 255) << 8) | (c.a & 255);
  const unusedIndices: number[] = [];
  const present: Array<{ index: number; color: { r: number; g: number; b: number } }> = [];
  paletteColors.forEach((color, index) => {
    if (unique.has(packed(color))) present.push({ index, color });
    else unusedIndices.push(index);
  });
  const crowded: Array<{ a: number; b: number; delta: number }> = [];
  for (let i = 0; i < present.length; i++) {
    for (let j = i + 1; j < present.length; j++) {
      const a = present[i];
      const b = present[j];
      const delta = Math.max(
        Math.abs(a.color.r - b.color.r),
        Math.abs(a.color.g - b.color.g),
        Math.abs(a.color.b - b.color.b),
      );
      if (delta > 0 && delta < crowdedDelta) crowded.push({ a: a.index, b: b.index, delta });
    }
  }
  crowded.sort((left, right) => left.delta - right.delta);
  return { unusedIndices, crowded: crowded.slice(0, 12) };
}

/**
 * Count full-width tonal edges, split by how hard the step is.
 *
 * A dithered seam only perturbs alternate pixels, so its mean delta stays around half
 * the step and is filtered out. But a legitimate 10-band sky gradient also produces
 * nine edges, so counting them all would condemn every well-formed gradient. What
 * actually flattens a composition is a run of *strong* unrelated steps, so the strong
 * count is what the warning keys on and the total is kept as context.
 */
function countHorizontalBands(
  at: PixelAt,
  width: number,
  height: number,
  alphaThreshold: number,
  deltaThreshold: number,
  strongThreshold: number,
): { horizontalBands: number; strongBands: number } {
  let bands = 0;
  let strongBands = 0;
  for (let y = 1; y < height; y++) {
    let sum = 0;
    let count = 0;
    for (let x = 0; x < width; x++) {
      const above = at(x, y - 1);
      const below = at(x, y);
      if (!above || !below || above.a < alphaThreshold || below.a < alphaThreshold) continue;
      sum += Math.abs(luminanceOf(below) - luminanceOf(above));
      count++;
    }
    if (count < width * 0.6) continue;
    const mean = sum / count;
    if (mean < deltaThreshold) continue;
    bands++;
    if (mean >= strongThreshold) strongBands++;
  }
  return { horizontalBands: bands, strongBands };
}

function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / Math.abs(mean);
}

/**
 * Presence checks: does the piece still *have* the things it needs?
 *
 * Every other metric here is a defect detector - it answers "is anything wrong".
 * That is a trap on its own: driving a defect score to zero flattens the piece,
 * because intentional texture (sparkle, grain, foliage) scores identically to noise.
 * A piece can be flawless on every defect metric and still be a dark, flat, lifeless
 * rectangle, so these measure the positive side instead.
 */
function analyzePresence(
  at: PixelAt,
  width: number,
  height: number,
  alphaThreshold: number,
  isTextured?: (x: number, y: number) => boolean,
): {
  valueRange: number;
  darkShare: number;
  lightShare: number;
  brightestShare: number;
  brightClusterShare: number;
  planes: Array<{ y0: number; y1: number; mean: number }>;
  flatestBand: { y0: number; y1: number; share: number; value: number };
} {
  const lum: number[] = [];
  const rowMean: number[] = [];
  for (let y = 0; y < height; y++) {
    let sum = 0;
    let count = 0;
    for (let x = 0; x < width; x++) {
      const c = at(x, y);
      if (!c || c.a < alphaThreshold) continue;
      const l = luminanceOf(c);
      lum.push(l);
      sum += l;
      count++;
    }
    rowMean.push(count > 0 ? sum / count : -1);
  }

  // Value spread: a piece that has collapsed into a narrow band has lost its form
  // even when every defect metric is clean.
  let min = 255;
  let max = 0;
  for (const l of lum) {
    if (l < min) min = l;
    if (l > max) max = l;
  }
  const valueRange = lum.length > 0 ? max - min : 0;

  // Weighting the extremes by how much of the canvas they occupy is what separates
  // "a calm scene that is legitimately dark" from "everything went dark".
  let dark = 0;
  let light = 0;
  for (const l of lum) {
    if (l < 48) dark++;
    if (l > 192) light++;
  }
  const total = Math.max(1, lum.length);
  const darkShare = dark / total;
  const lightShare = light / total;

  // Light source detection. A scene that is genuinely lit has a *concentrated* bright
  // region; a scene that is merely bright has many mid-to-light pixels spread evenly.
  // Declared texture is excluded: sparkle, glitter and specular grain are by
  // definition scattered highlights, so counting them would make every sunset lake
  // look unlit no matter how solid its sun is.
  let brightPixels = 0;
  const brightMask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = at(x, y);
      if (!c || c.a < alphaThreshold || luminanceOf(c) <= 192) continue;
      if (isTextured?.(x, y)) continue;
      brightPixels++;
      brightMask[y * width + x] = 1;
    }
  }
  // Largest 4-connected bright cluster, by flood fill over the mask.
  let brightCluster = 0;
  const seen = new Uint8Array(width * height);
  const stack: number[] = [];
  for (let start = 0; start < brightMask.length; start++) {
    if (brightMask[start] === 0 || seen[start] === 1) continue;
    let size = 0;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const index = stack.pop()!;
      size++;
      const cx = index % width;
      const cy = (index - cx) / width;
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as Array<[number, number]>) {
        const nx = cx + ox;
        const ny = cy + oy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (brightMask[next] === 0 || seen[next] === 1) continue;
        seen[next] = 1;
        stack.push(next);
      }
    }
    if (size > brightCluster) brightCluster = size;
  }

  // Four horizontal planes, so depth can be checked rather than assumed.
  const planes: Array<{ y0: number; y1: number; mean: number }> = [];
  const planeHeight = Math.max(1, Math.floor(height / 4));
  for (let p = 0; p < 4; p++) {
    const y0 = p * planeHeight;
    const y1 = p === 3 ? height : y0 + planeHeight;
    let sum = 0;
    let count = 0;
    for (let y = y0; y < y1; y++) {
      if (rowMean[y] < 0) continue;
      sum += rowMean[y];
      count++;
    }
    planes.push({ y0, y1, mean: count > 0 ? sum / count : -1 });
  }

  // The most common single value: a "dead flat" region is a large share of the
  // frame sitting on one colour, which reads as a hole rather than a surface.
  const histogram = new Uint32Array(256);
  for (const l of lum) histogram[Math.max(0, Math.min(255, Math.round(l)))]++;
  let flatValue = 0;
  let flatCount = 0;
  for (let i = 0; i < 256; i++) {
    if (histogram[i] > flatCount) {
      flatCount = histogram[i];
      flatValue = i;
    }
  }
  return {
    valueRange,
    darkShare,
    lightShare,
    brightestShare: brightPixels / total,
    brightClusterShare: brightCluster / total,
    planes,
    flatestBand: { y0: 0, y1: height, share: flatCount / total, value: flatValue },
  };
}

/**
 * Regularity of the silhouette's skyline.
 *
 * Take the topmost solid pixel per column, find the peaks in that profile, and measure
 * how evenly they are spaced and how uniform their height is. Near-zero variation over
 * five or more peaks is the signature of a hedge, a picket fence or a row of identical
 * props - the procedural-repetition failure that no existing metric catches.
 */
function analyzeSkylineRhythm(
  at: PixelAt,
  width: number,
  height: number,
  alphaThreshold: number,
): { peaks: number; spacingCV: number; heightCV: number; uniform: boolean; measurable: boolean; note: string } {
  const skyline: Array<{ x: number; y: number }> = [];
  let offTopEdge = 0;
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const c = at(x, y);
      if (c && c.a >= alphaThreshold) {
        skyline.push({ x, y });
        if (y > 0) offTopEdge++;
        break;
      }
    }
  }
  const unmeasurable = (note: string) => ({
    peaks: 0, spacingCV: 0, heightCV: 0, uniform: false, measurable: false, note,
  });
  // A canvas that is opaque right down to the top edge has no silhouette at all - a
  // full-bleed background or a landscape whose sky fills the frame. Say so rather than
  // returning `peaks: 0`, which reads like "checked, nothing wrong".
  if (skyline.length >= width * 0.9 && offTopEdge === 0) {
    return unmeasurable('opaque from the top edge: the frame has no silhouette to measure');
  }
  if (skyline.length < 9) return unmeasurable('too few columns contain artwork');

  const peaks: Array<{ x: number; y: number }> = [];
  for (let i = 1; i < skyline.length - 1; i++) {
    const y = skyline[i].y;
    const left = skyline[i - 1].y;
    const right = skyline[i + 1].y;
    // Require a real rise so a flat top edge does not manufacture hundreds of peaks.
    if (y <= left && y <= right && (left - y >= 2 || right - y >= 2)) {
      peaks.push({ x: skyline[i].x, y });
    }
  }
  if (peaks.length < 3) {
    return {
      peaks: peaks.length, spacingCV: 0, heightCV: 0, uniform: false, measurable: true,
      note: `only ${peaks.length} peak(s) in the silhouette - too few to judge repetition`,
    };
  }

  const spacings: number[] = [];
  for (let i = 1; i < peaks.length; i++) spacings.push(peaks[i].x - peaks[i - 1].x);
  const spacingCV = coefficientOfVariation(spacings);
  const heightCV = coefficientOfVariation(peaks.map((peak) => peak.y));
  return {
    peaks: peaks.length,
    spacingCV,
    heightCV,
    uniform: peaks.length >= 5 && spacingCV < 0.18 && heightCV < 0.2,
    measurable: true,
    note: 'spacing and height variation measured across the silhouette peaks',
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
 * Objective heuristic report for the perceptual problems agents cannot see in a
 * thumbnail: isolated dither speckles, high-frequency outliers, clipped highlights
 * and an over-saturated edge field. It is intentionally a report, not a mutation;
 * `despeckle` and `antialias` are the matching fix commands.
 */
function analyzeQuality(sprite: Sprite, frameRef: number | string | undefined, options: QualityAnalysisOptions = {}): Record<string, unknown> {
  if (
    options.tilemap &&
    options.underlay &&
    (options.tilemap.tileWidth !== options.underlay.tileWidth || options.tilemap.tileHeight !== options.underlay.tileHeight)
  ) {
    throw new Error('Tilemap quality underlay must use the same cell size as the active map.');
  }
  if (options.tilemap && sprite.tileset && options.replaceEmpty !== undefined) {
    const available = tileCount(sprite.tileset);
    if (options.replaceEmpty < -1 || options.replaceEmpty >= available) {
      throw new Error(`replaceEmpty ${options.replaceEmpty} is outside the ${available}-tile tileset.`);
    }
  }
  const tilemapAnalysis = options.tilemap && sprite.tileset
    ? analyzeTilemapQuality(options.tilemap, sprite.tileset)
    : null;
  const frame = options.tilemap ? null : resolveFrame(sprite, frameRef ?? 0);
  let buffer: PixelBuffer;
  if (options.tilemap) {
    if (options.rect) {
      // A crop is enough for the report, so avoid allocating a potentially huge
      // standalone map just to throw most of it away.
      buffer = new PixelBuffer(options.rect.w, options.rect.h);
      if (options.underlay) {
        blitTilemap(buffer, sprite.tileset!, options.underlay, {
          offsetX: -options.rect.x,
          offsetY: -options.rect.y,
          blend: 'copy',
        });
      }
      blitTilemap(buffer, sprite.tileset!, options.tilemap, {
        offsetX: -options.rect.x,
        offsetY: -options.rect.y,
        blend: 'over',
        replaceEmpty: options.replaceEmpty ?? null,
      });
    } else {
      const sourceWidth = options.tilemap.width * options.tilemap.tileWidth;
      const sourceHeight = options.tilemap.height * options.tilemap.tileHeight;
      if (sourceWidth * sourceHeight > 16_777_216) {
        throw new Error(
          `Tilemap analysis would render ${sourceWidth}x${sourceHeight} pixels. Pass a smaller pixel-space \`rect\`.`,
        );
      }
      if (options.underlay) {
        buffer = renderTilemap(sprite.tileset!, options.underlay, { blend: 'copy' });
        blitTilemap(buffer, sprite.tileset!, options.tilemap, {
          blend: 'over',
          replaceEmpty: options.replaceEmpty ?? null,
        });
      } else {
        buffer = renderTilemap(sprite.tileset!, options.tilemap, {
          blend: 'over',
          replaceEmpty: options.replaceEmpty ?? null,
        });
      }
    }
  } else {
    const full = compositeFrame(sprite, frame!.id);
    buffer = options.rect ? extractRegion(full, options.rect) : full;
  }
  const tilemapMode = options.tilemap !== undefined;
  const { width, height, data } = buffer;
  const total = width * height;
  const noiseThreshold = Math.max(0, Math.min(255, options.noiseThreshold ?? 40));
  const alphaThreshold = Math.max(1, Math.min(255, Math.floor(options.alphaThreshold ?? 1)));
  const paletteColors = sprite.palette.colors;
  const paletteSet = new Set(paletteColors.map((c) => ((c.r & 255) << 24) | ((c.g & 255) << 16) | ((c.b & 255) << 8) | (c.a & 255)));
  const unique = new Set<number>();
  let opaque = 0;
  let semi = 0;
  let transparent = 0;
  let palettePixels = 0;
  let luminanceSum = 0;
  let luminanceSq = 0;
  let luminanceCount = 0;
  let edgeSum = 0;
  let edgeCount = 0;
  let isolated = 0;
  let outliers = 0;
  let texturedOutliers = 0;
  let overexposed = 0;
  // textureRects arrive in canvas space; the analysis may run on an extracted rect.
  const textureOffsetX = options.rect?.x ?? 0;
  const textureOffsetY = options.rect?.y ?? 0;
  const isTextured = (x: number, y: number): boolean => {
    const tex = options.textureRects;
    if (!tex || tex.length === 0) return false;
    const cx = x + textureOffsetX;
    const cy = y + textureOffsetY;
    for (let i = 0; i < tex.length; i++) {
      const r = tex[i];
      if (cx >= r.x && cy >= r.y && cx < r.x + r.w && cy < r.y + r.h) return true;
    }
    return false;
  };
  const offsets: Array<[number, number]> = [
    [0, -1], [1, -1], [1, 0], [1, 1],
    [0, 1], [-1, 1], [-1, 0], [-1, -1],
  ];
  const at = (x: number, y: number): { r: number; g: number; b: number; a: number } | null => {
    if (x < 0 || y < 0 || x >= width || y >= height) return null;
    const i = (y * width + x) * 4;
    return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
  };
  const packed = (c: { r: number; g: number; b: number; a: number }): number =>
    ((c.r & 255) << 24) | ((c.g & 255) << 16) | ((c.b & 255) << 8) | (c.a & 255);
  const distance = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number =>
    Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = at(x, y)!;
      const key = packed(c);
      const solid = c.a >= alphaThreshold;
      if (!solid) {
        if (c.a === 0) transparent++;
        else semi++;
        continue;
      }
      opaque++;
      unique.add(key);
      if (paletteSet.has(key)) palettePixels++;
      const luminance = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      luminanceSum += luminance;
      luminanceSq += luminance * luminance;
      luminanceCount++;
      if (luminance > 235) overexposed++;

      let neighbours = 0;
      let matching = 0;
      let nr = 0;
      let ng = 0;
      let nb = 0;
      for (const [ox, oy] of offsets) {
        const n = at(x + ox, y + oy);
        if (!n || n.a < alphaThreshold) continue;
        neighbours++;
        nr += n.r;
        ng += n.g;
        nb += n.b;
        if (distance(c, n) <= 8) matching++;
      }
      for (const [ox, oy] of [[1, 0], [0, 1]] as Array<[number, number]>) {
        const n = at(x + ox, y + oy);
        if (!n || n.a < alphaThreshold) continue;
        edgeSum += Math.abs(luminance - (0.2126 * n.r + 0.7152 * n.g + 0.0722 * n.b));
        edgeCount++;
      }
      if (neighbours === 0) {
        isolated++;
      } else if (matching <= 1) {
        const avg = { r: nr / neighbours, g: ng / neighbours, b: nb / neighbours };
        if (distance(c, avg) > noiseThreshold) {
          if (isTextured(x, y)) texturedOutliers++;
          else outliers++;
        }
      }
    }
  }

  const meanLuminance = luminanceCount > 0 ? luminanceSum / luminanceCount : 0;
  const luminanceStd = luminanceCount > 0 ? Math.sqrt(Math.max(0, luminanceSq / luminanceCount - meanLuminance * meanLuminance)) : 0;
  const meanEdge = edgeCount > 0 ? edgeSum / edgeCount : 0;
  const isolatedRatio = opaque > 0 ? isolated / opaque : 0;
  const outlierRatio = opaque > 0 ? outliers / opaque : 0;
  const overexposedRatio = opaque > 0 ? overexposed / opaque : 0;
  const paletteUsed = paletteColors.filter((c) => {
    const key = packed(c);
    return unique.has(key);
  }).length;
  const outsidePaletteRatio = opaque > 0 ? Math.max(0, 1 - palettePixels / opaque) : 0;
  const paletteUsage = analyzePaletteUsage(paletteColors, unique, 6);
  const bands = countHorizontalBands(at, width, height, alphaThreshold, 20, 32);
  const rhythm = analyzeSkylineRhythm(at, width, height, alphaThreshold);
  const landscape = analyzeLandscape(buffer, alphaThreshold);
  const presence = analyzePresence(at, width, height, alphaThreshold, isTextured);
  const planeMeans = presence.planes.map((p) => p.mean).filter((m) => m >= 0);
  // Depth only exists if adjacent planes differ. Equal means mean the scene has
  // stacked into one tonal slab, which no defect metric notices.
  const planeSeparation = planeMeans.length >= 2
    ? Math.min(
        ...planeMeans.slice(1).map((mean, index) => Math.abs(mean - planeMeans[index])),
      )
    : -1;
  // Named `defectScore` rather than "softness": a high score means the measurable
  // defects are absent, which is necessary but not sufficient. A deliberately
  // sanded-flat piece scores 100 here, which is exactly the trap this had become.
  const defectScore = Math.max(
    0,
    Math.min(
      100,
      100 -
        Math.min(30, isolatedRatio * 1200) -
        Math.min(25, outlierRatio * 700) -
        Math.min(25, Math.max(0, meanEdge - 10) * 2.2) -
        Math.min(20, overexposedRatio * 500),
    ),
  );

  const warnings: Array<{ code: string; severity: 'info' | 'warning'; message: string }> = [];
  const rasterSeverity = tilemapMode ? 'info' as const : 'warning' as const;
  const rasterContext = tilemapMode
    ? ' In tilemap mode this is tile texture evidence, not an automatic defect; inspect `structure.tilemap` and the debug preview before changing pixels.'
    : '';
  if (isolatedRatio > 0.005) {
    warnings.push({
      code: 'isolated_pixels',
      severity: rasterSeverity,
      message: `${isolated} isolated solid pixels (${(isolatedRatio * 100).toFixed(2)}%). Run \`despeckle\` under a clip or rect to remove single-pixel noise.${rasterContext}`,
    });
  }
  if (outlierRatio > 0.01) {
    const exempt = options.textureRects?.length ?? 0;
    warnings.push({
      code: 'high_frequency_noise',
      severity: rasterSeverity,
      message:
        `${(outlierRatio * 100).toFixed(2)}% of solid pixels are colour outliers against their neighbourhood` +
        (exempt > 0 ? `, excluding ${exempt} declared texture region(s)` : '') +
        '. If this area is deliberate texture - sparkle, grain, foliage, water ripples or crop rows - pass it as `textureRects` rather than despeckling it; otherwise prefer cluster dither (`cluster2`/`cluster4`) or `despeckle`.' +
        rasterContext,
    });
  }
  if (meanEdge > 16) {
    warnings.push({
      code: 'high_edge_contrast',
      severity: rasterSeverity,
      message: `Mean adjacent luminance delta is ${meanEdge.toFixed(1)}; the edge field is harsh. Run \`antialias\` on the silhouette or internal colour steps.${rasterContext}`,
    });
  }
  if (overexposedRatio > 0.02) {
    warnings.push({
      code: 'clipped_highlights',
      severity: rasterSeverity,
      message: `${(overexposedRatio * 100).toFixed(2)}% of solid pixels are near-white. Reduce glow/bloom coverage; a soft pixel piece keeps a value ceiling, not a white-out.${rasterContext}`,
    });
  }
  if (paletteUsage.unusedIndices.length > 0) {
    const slots = paletteUsage.unusedIndices;
    const preview = slots.slice(0, 12).join(', ');
    warnings.push({
      code: 'unused_palette_slots',
      severity: 'info',
      message: `${slots.length} of ${paletteColors.length} palette slots are unused: indices ${preview}${slots.length > 12 ? ', ...' : ''}. Use them deliberately or drop them; \`palette.unusedIndices\` lists them all.`,
    });
  }
  if (paletteUsage.crowded.length > 0) {
    const worst = paletteUsage.crowded[0];
    warnings.push({
      code: 'palette_crowding',
      severity: 'info',
      message: `${paletteUsage.crowded.length} in-use palette pair(s) sit closer than 6/255 on the max channel and will read as the same tone (closest: slots ${worst.a} and ${worst.b}, delta ${worst.delta}). Widen the ramp or drop one of the pair.`,
    });
  }
  if (tilemapAnalysis) {
    if (!tilemapAnalysis.dataLengthValid) {
      warnings.push({
        code: 'tilemap_data_length_mismatch',
        severity: 'warning',
        message: `Tilemap data has ${tilemapAnalysis.cells} expected cells but stores ${tilemapAnalysis.dataLength} values. Resize or recreate the map before export.`,
      });
    }
    if (tilemapAnalysis.invalid > 0) {
      warnings.push({
        code: 'tilemap_invalid_indices',
        severity: 'warning',
        message: `${tilemapAnalysis.invalid} cell(s) reference tiles outside the ${tilemapAnalysis.tileCount}-tile tileset. ${tilemapAnalysis.invalidExamples.length} coordinates are listed in \`structure.tilemap.invalidExamples\`.`,
      });
    }
    if (!tilemapAnalysis.tileSizeMatchesTileset) {
      warnings.push({
        code: 'tilemap_tile_size_mismatch',
        severity: 'info',
        message: `Tilemap cells are ${tilemapAnalysis.tileWidth}x${tilemapAnalysis.tileHeight}, but the source tiles are a different size. This is valid when scaling is intentional; otherwise alpha-mask and Tiled alignment will be ambiguous.`,
      });
    }
    if (tilemapAnalysis.validFilled === 0) {
      warnings.push({
        code: 'tilemap_empty',
        severity: 'warning',
        message: 'The tilemap has no valid filled cells. Nothing will render or export as terrain.',
      });
    }
    if (
      tilemapAnalysis.dominantVariant &&
      tilemapAnalysis.validFilled >= 32 &&
      tilemapAnalysis.dominantVariant.ratio > 0.78
    ) {
      warnings.push({
        code: 'tilemap_dominant_variant',
        severity: 'info',
        message: `Tile ${tilemapAnalysis.dominantVariant.tile} covers ${(tilemapAnalysis.dominantVariant.ratio * 100).toFixed(1)}% of the map. Use \`stroke_tilemap\` with weighted \`tiles\` and \`avoidRepeats\` when that variant is texture rather than a deliberate road/water field.`,
      });
    }
    if (
      tilemapAnalysis.repetition.sameTileRatio > 0.72 &&
      tilemapAnalysis.variants.length > 1 &&
      tilemapAnalysis.validFilled >= 32
    ) {
      warnings.push({
        code: 'tilemap_repetitive_tiles',
        severity: 'info',
        message: `${(tilemapAnalysis.repetition.sameTileRatio * 100).toFixed(1)}% of tile-to-tile adjacencies repeat the same index. This is expected for fields, water and roads; use weighted variants if the repetition reads as wallpaper.`,
      });
    }
    if (
      tilemapAnalysis.terrain.singletonComponents > 0 &&
      tilemapAnalysis.terrain.singletonComponents / Math.max(1, tilemapAnalysis.terrain.components) > 0.35
    ) {
      warnings.push({
        code: 'tilemap_fragmented_terrain',
        severity: 'info',
        message: `${tilemapAnalysis.terrain.singletonComponents} of ${tilemapAnalysis.terrain.components} non-empty terrain components are single cells. Inspect scale and \`terrain.openEdges\`; a sparse map may be intentional.`,
      });
    }
  }
  if (bands.strongBands > 3) {
    warnings.push({
      code: 'horizontal_banding',
      severity: rasterSeverity,
      message: `${bands.strongBands} strong full-width tonal edges (${bands.horizontalBands} edges in total). Past about three strong ones the composition reads as stacked stripes rather than depth. Break them with a vertical or diagonal element - a light path, a foreground silhouette, a waterfall.${rasterContext}`,
    });
  }
  // Full-bleed landscape diagnostics are separate from defectScore. They report the
  // internal horizon/ridge/waterline candidates and whether a coherent vertical or
  // diagonal guide actually crosses the lower frame; the old alpha skyline rhythm
  // cannot see any of this when the sky is opaque from y=0.
  const landscapeRepeated =
    (landscape.rhythm.lowerBandUniform &&
      landscape.horizontalBoundaries.some((candidate) => candidate.strength >= 10)) ||
    Boolean(
      landscape.waterline &&
      landscape.waterline.strength >= 10 &&
      landscape.waterline.coverage >= 0.65 &&
      landscape.waterline.regularity > 0.84,
    );
  if (landscape.measurable && landscape.scene === 'landscape' && !landscape.guideLines.present && landscapeRepeated) {
    warnings.push({
      code: 'landscape_repeated_bands',
      severity: 'warning',
      message: `Landscape structure is measurable: ${landscape.horizontalBoundaries.length} internal horizontal boundary candidate(s), including waterline ${landscape.waterline ? `near y=${landscape.waterline.y}` : 'not confidently located'}. Their lower-band rhythm is regular, but no vertical/diagonal guiding line was detected. Vary the terrain/water edges or add one coherent path, foreground silhouette, or waterfall.`,
    });
  }
  if (
    landscape.measurable &&
    landscape.scene === 'landscape' &&
    !landscape.guideLines.present &&
    !landscapeRepeated &&
    landscape.horizontalBoundaries.length >= 3 &&
    landscape.horizontalBoundaries.some((candidate) => candidate.strength >= 10)
  ) {
    warnings.push({
      code: 'landscape_missing_guide',
      severity: 'info',
      message: 'Several internal landscape boundaries are measurable, but no confident vertical or diagonal guide was found. Check the whole composition at 100% before accepting the horizontal structure.',
    });
  }
  // Presence checks. These fire on a piece that is *missing* something, which is the
  // failure the defect metrics above structurally cannot see.
  // A strong local maximum is the signature of a light source. If there is no such a
  // peak, a scene that needs one (a sky, a room, a landscape) has lost its key light,
  // which no aggregate - a mean, a standard deviation - can express: a dim image and a
  // dark image have the same average.
  // A light source is a *concentrated* highlight. Compare the largest bright cluster
  // against the total bright area rather than using a fixed threshold, so the check
  // scales with how bright a piece is overall: an evenly-lit sky is bright but not lit.
  const brightestShare = presence.brightestShare;
  const brightClusterShare = presence.brightClusterShare;
  const concentration = brightestShare > 0 ? brightClusterShare / brightestShare : 0;
  const hasLightSource = brightestShare > 0.0008 && concentration > 0.3;
  if (!hasLightSource && presence.valueRange >= 90 && brightestShare > 0.0008) {
    warnings.push({
      code: 'no_light_source',
      severity: 'warning',
      message:
        `Bright pixels cover ${(brightestShare * 100).toFixed(2)}% of the canvas but the largest single bright cluster is only ${(concentration * 100).toFixed(0)}% of them, so the light is spread evenly and the piece reads as ambient rather than lit. A scene needs a concentrated source - a sun, a lamp, a specular edge. If the scattered highlights are deliberate sparkle or water glitter, declare them as \`textureRects\` so they stop counting against the light source.`,
    });
  }
  if (presence.valueRange < 90) {
    warnings.push({
      code: 'narrow_value_range',
      severity: 'warning',
      message: `The whole piece spans only ${presence.valueRange.toFixed(0)}/255 of luminance. Without a wide spread there are no darks, no lights and no room to read form - a clean defect score with a narrow range means the shading was sanded away, not that the piece is correct.`,
    });
  }
  if (presence.darkShare > 0.75) {
    warnings.push({
      code: 'value_collapse_dark',
      severity: 'warning',
      message: `${(presence.darkShare * 100).toFixed(1)}% of solid pixels sit below luminance 48. Deep shadow is legitimate, but past roughly three quarters of the canvas it reads as an underexposed image rather than a dark scene.`,
    });
  }
  // Flag a pair of planes that sit at the same value, but only when the piece as a
  // whole has real tonal range. Without the range guard this fires on scenes that are
  // legitimately narrow-band (a moonlit night, a flat graphic) and buries the collapse
  // warning that actually matters.
  if (planeSeparation >= 0 && planeSeparation < 6 && presence.valueRange >= 90) {
    const pair = planeMeans
      .map((mean, index) => ({ index, delta: index > 0 ? Math.abs(mean - planeMeans[index - 1]) : Infinity }))
      .filter((entry) => entry.delta < 6)
      .map((entry) => `plane ${entry.index - 1} and ${entry.index} (${planeMeans[entry.index - 1].toFixed(0)} vs ${planeMeans[entry.index].toFixed(0)})`)
      .join(', ');
    warnings.push({
      code: 'flat_depth_planes',
      severity: 'warning',
      message: `${pair} sit at nearly the same value, so that depth boundary is not readable (all plane means: ${planeMeans.map((m) => m.toFixed(0)).join(', ')}). Push one plane darker or the other lighter.`,
    });
  }
  if (presence.flatestBand.share > 0.45) {
    warnings.push({
      code: 'dead_flat_region',
      severity: rasterSeverity,
      message: `${(presence.flatestBand.share * 100).toFixed(1)}% of the canvas sits on a single luminance value (about ${presence.flatestBand.value}). A large uniform area reads as a hole in the piece; give it a value gradient or break it with texture.${rasterContext}`,
    });
  }
  if (rhythm.uniform) {
    warnings.push({
      code: 'uniform_rhythm',
      severity: 'warning',
      message: `The silhouette resolves into ${rhythm.peaks} peaks with very even spacing (CV ${rhythm.spacingCV.toFixed(2)}) and height (CV ${rhythm.heightCV.toFixed(2)}), which reads as a hedge or wallpaper. Vary spacing and size, and leave gaps.`,
    });
  }
  if (sprite.paletteLocked && outsidePaletteRatio > 0.1) {
    warnings.push({
      code: 'outside_palette_pixels',
      severity: 'warning',
      message: `${(outsidePaletteRatio * 100).toFixed(1)}% of solid pixels are not exact palette swatches, usually from translucent blends. Use opaque cluster dither if palette purity matters.`,
    });
  }

  const regions: Array<Record<string, unknown>> = [];
  const grid = Math.max(1, Math.floor(options.grid ?? 1));
  if (grid > 1) {
    const cellWidth = Math.ceil(width / grid);
    const cellHeight = Math.ceil(height / grid);
    for (let ry = 0; ry < grid; ry++) {
      for (let rx = 0; rx < grid; rx++) {
        const x0 = rx * cellWidth;
        const y0 = ry * cellHeight;
        const x1 = Math.min(width, x0 + cellWidth);
        const y1 = Math.min(height, y0 + cellHeight);
        let regionOpaque = 0;
        let regionIsolated = 0;
        let regionOutliers = 0;
        let regionEdgeSum = 0;
        let regionEdgeCount = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const c = at(x, y)!;
            if (c.a < alphaThreshold) continue;
            regionOpaque++;
            let neighbours = 0;
            let matching = 0;
            let nr = 0;
            let ng = 0;
            let nb = 0;
            for (const [ox, oy] of offsets) {
              const n = at(x + ox, y + oy);
              if (!n || n.a < alphaThreshold) continue;
              neighbours++;
              nr += n.r;
              ng += n.g;
              nb += n.b;
              if (distance(c, n) <= 8) matching++;
            }
            if (neighbours === 0) {
              regionIsolated++;
            } else if (matching <= 1 && distance(c, { r: nr / neighbours, g: ng / neighbours, b: nb / neighbours }) > noiseThreshold) {
              regionOutliers++;
            }
            for (const [ox, oy] of [[1, 0], [0, 1]] as Array<[number, number]>) {
              const n = at(x + ox, y + oy);
              if (!n || n.a < alphaThreshold) continue;
              const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
              regionEdgeSum += Math.abs(lum - (0.2126 * n.r + 0.7152 * n.g + 0.0722 * n.b));
              regionEdgeCount++;
            }
          }
        }
        regions.push({
          x: x0,
          y: y0,
          w: x1 - x0,
          h: y1 - y0,
          opaque: regionOpaque,
          isolated: regionIsolated,
          outliers: regionOutliers,
          meanAdjacentDelta: regionEdgeCount > 0 ? regionEdgeSum / regionEdgeCount : 0,
        });
      }
    }
  }

  return {
    source: options.tilemap
      ? {
          kind: 'tilemap',
          id: options.tilemap.id,
          name: options.tilemap.name,
          underlay: options.underlay ? { id: options.underlay.id, name: options.underlay.name } : null,
        }
      : { kind: 'frame', frame: frame ? sprite.frames.findIndex((f) => f.id === frame.id) : 0, frameId: frame?.id ?? null },
    frame: frame ? sprite.frames.findIndex((f) => f.id === frame.id) : null,
    frameId: frame?.id ?? null,
    width,
    height,
    rect: options.rect ?? null,
    pixels: total,
    opaque,
    semiTransparent: semi,
    transparent,
    opaqueRatio: total > 0 ? opaque / total : 0,
    uniqueColors: unique.size,
    palette: {
      size: paletteColors.length,
      used: paletteUsed,
      unused: paletteColors.length - paletteUsed,
      unusedIndices: paletteUsage.unusedIndices,
      crowded: paletteUsage.crowded,
      locked: sprite.paletteLocked ?? false,
      outsideRatio: outsidePaletteRatio,
    },
    structure: {
      horizontalBands: bands.horizontalBands,
      strongBands: bands.strongBands,
      rhythm,
      landscape,
      horizon: landscape.horizon,
      ridge: landscape.ridge,
      waterline: landscape.waterline,
      guideLines: landscape.guideLines,
      ...(tilemapAnalysis ? { tilemap: tilemapAnalysis } : {}),
    },
    landscape,
    presence: {
      valueRange: presence.valueRange,
      darkShare: presence.darkShare,
      lightShare: presence.lightShare,
      brightestShare,
      brightClusterShare,
      lightConcentration: concentration,
      hasLightSource,
      flatShare: presence.flatestBand.share,
      planeSeparation,
      planes: presence.planes,
    },
    luminance: {
      mean: meanLuminance,
      std: luminanceStd,
    },
    edges: {
      meanAdjacentDelta: meanEdge,
    },
    noise: {
      isolated,
      isolatedRatio,
      outliers,
      outlierRatio,
      texturedOutliers,
      textureRects: options.textureRects ?? [],
      threshold: noiseThreshold,
    },
    overexposedRatio,
    defectScore,
    defectScoreContext: tilemapMode ? 'tilemap-texture-diagnostic' : 'raster',
    // Kept as a deprecated alias so existing callers do not break on the rename.
    softnessScore: defectScore,
    ...(regions.length > 0 ? { regions } : {}),
    warnings,
  };
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

/**
 * Register a tool. The SDK's `registerTool` generics are driven by the concrete
 * schema type; we pass schemas through dynamically (including ones built with
 * `.extend()` at runtime), so the call is erased here rather than at every site.
 */
function addTool(
  server: McpServer,
  name: string,
  config: { title: string; description: string; inputSchema: z.ZodObject<z.ZodRawShape>; annotations?: ToolAnnotations },
  handler: (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>,
): void {
  // Strict, like the core command schemas. A mistyped parameter has to be an
  // error rather than a silent fallback to the default: `undo {count: 5}` used
  // to quietly undo a single edit and still report success.
  const strict = { ...config, inputSchema: config.inputSchema.strict() };
  (server.registerTool as unknown as (
    n: string,
    c: unknown,
    h: unknown,
  ) => unknown)(name, strict, handler);
}

export function registerTools(server: McpServer, store: DocumentStore): void {
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
        'Create a new blank sprite and make it active (pass `select: false` to keep the current document active). Returns the document id and version. Prefer small canvases (16x16 to 64x64) and 2-4 named layers. Pass `palette` to constrain colours, which is the single biggest quality win for pixel art.',
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
    'open_document',
    {
      title: 'Open a .pixel document',
      description: 'Load a sprite document from a `.pixel` file on disk and make it active.',
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
      title: 'Save and export in one call',
      description:
        'Fast finalisation path: save the editable `.pixel` source and write one or more composited PNGs in a single MCP round trip. Typical agent output is a scale-1 original plus a larger nearest-neighbour preview. Returns every written path, output size, version and a clean document summary.',
      inputSchema: z.object({
        document: documentRef,
        path: z.string().optional().describe('Destination `.pixel` path. Defaults to the document\'s current path.'),
        exports: z
          .array(pngExportSchema)
          .max(8)
          .optional()
          .describe('PNG files to write in order. Each may select a frame, integer scale and background.'),
      }),
      annotations: { destructiveHint: false },
    },
    (args) => {
      const doc = store.require(args.document as string | undefined);
      const path = (args.path as string | undefined) ?? doc.path;
      if (!path) {
        return fail('No path given and this document has never been saved. Pass `path`.');
      }
      const exports = (args.exports as Array<{
        path: string;
        frame?: number | string;
        scale?: number;
        background?: string | null;
      }>) ?? [];

      try {
        // Resolve every export before writing anything, so a bad frame reference
        // cannot leave behind a source file that looks like a complete finalisation.
        const rendered = exports.map((spec) => {
          const frame = resolveFrame(doc.editor.sprite, spec.frame ?? 0);
          const scale = spec.scale ?? 1;
          const background = resolveBackground(spec.background);
          const composited = compositeFrame(doc.editor.sprite, frame.id, { background });
          const image = scale > 1 ? scaleNearest(composited, scale) : composited;
          return {
            path: spec.path,
            bytes: encodePNG(image),
            width: image.width,
            height: image.height,
            frame: doc.editor.sprite.frames.findIndex((item) => item.id === frame.id),
            frameId: frame.id,
            scale,
          };
        });

        const sourceBytes = store.save(doc);
        writeFile(path, sourceBytes);
        doc.path = path;
        for (const output of rendered) writeFile(output.path, output.bytes);

        const files = [path, ...rendered.map((output) => output.path)];
        return ok({
          ok: true,
          path,
          absolute: absPath(path),
          bytes: sourceBytes.byteLength,
          exports: rendered.map((output) => ({
            path: output.path,
            width: output.width,
            height: output.height,
            frame: output.frame,
            frameId: output.frameId,
            scale: output.scale,
            bytes: output.bytes.byteLength,
          })),
          files,
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
    'preview_tilemap',
    {
      title: 'Preview and debug a tilemap',
      description:
        'Render a tilemap directly from its tileset, even when it has not been baked into a pixel layer. This is the immediate visual check after set/fill/stroke/autotile. `debug.grid` overlays tile boundaries, `debug.indices` prints every tile index, `debug.highlightCells` marks exact writes and `debug.highlightRect` marks a changed region. Invalid/out-of-range indices are outlined in red. `underlay` composes a base map first so alpha-masked bank/edge tiles can be judged over real ground. `rect` is in tile coordinates. The response also includes structural evidence such as empty ratio, invalid cells, variant distribution, repeated adjacency and connected terrain.',
      inputSchema: z.object({
        document: documentRef,
        tilemap: z.union([z.string(), z.number().int()]).describe('Tilemap id, name or 0-based index.'),
        underlay: z
          .union([z.string(), z.number().int()])
          .optional()
          .describe('Optional ground/base tilemap rendered first. Alpha-masked edge tiles then blend over it.'),
        rect: z
          .object({
            x: z.number().int(),
            y: z.number().int(),
            w: z.number().int().min(1),
            h: z.number().int().min(1),
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
    'get_palette',
    {
      title: 'Read the palette',
      description: 'Return the document palette as hex colours, with each colour\'s index.',
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
          })),
        });
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  addTool(
    server,
    'quality_report',
    {
      title: 'Measure defect, presence and landscape quality',
      description:
        'Read-only report over an objective raster, in two halves. DEFECT half: isolated-pixel ratio, colour-outlier ratio, mean edge contrast, near-white highlight ratio, palette usage, and `defectScore` on 0-100 where HIGHER MEANS CLEANER - 99 means almost nothing measurable is wrong, which is necessary but not sufficient. PRESENCE half: `presence.valueRange` (healthy above 150, collapsed below 90), `darkShare` (over 75% reads as underexposed), `flatShare` (over 45% is a dead region), `planeSeparation` (below 6 means two depth planes have merged into one value) and `lightConcentration` (near 1 is a real source, below 0.3 is ambient). Driving defectScore to 100 flattens the piece, because intentional texture scores identically to noise - declare it with `textureRects` and re-read the presence half afterwards. Also reports `palette.unusedIndices`, `palette.crowded`, `structure.strongBands`, `structure.rhythm`, and `structure.landscape` (internal horizon/ridge/waterline candidates, regularity and vertical/diagonal guide evidence) for full-bleed scenes. Pass `tilemap` to analyse an unbaked tile grid directly: pixel texture warnings become informational and `structure.tilemap` reports invalid indices, variant distribution, repeated adjacency, runs, open edges and connected terrain without treating water ripples or crop rows as noise. Add `underlay` to measure alpha-masked bank/edge tiles over their base terrain.',
      inputSchema: z.object({
        document: documentRef,
        frame: frameRefSchema.optional().describe('Frame id or 0-based index. Defaults to frame 0. Do not pass with `tilemap`.'),
        tilemap: z
          .union([z.string(), z.number().int()])
          .optional()
          .describe('Tilemap id, name or 0-based index. Analyses this grid directly instead of a composited frame.'),
        underlay: z
          .union([z.string(), z.number().int()])
          .optional()
          .describe('With `tilemap`, composite this base grid first so alpha-masked terrain edges are measured over real ground.'),
        replaceEmpty: z
          .number()
          .int()
          .min(-1)
          .optional()
          .describe('With `tilemap`, render empty cells using this tile before raster analysis.'),
        rect: previewRectSchema.optional(),
        noiseThreshold: z
          .number()
          .min(0)
          .max(255)
          .optional()
          .describe('Colour distance above which a pixel counts as an outlier. Defaults to 40.'),
        alphaThreshold: z
          .number()
          .int()
          .min(1)
          .max(255)
          .optional()
          .describe('Alpha at or above this counts as solid. Defaults to 1.'),
        textureRects: z
          .array(
            z.object({
              x: z.number().int(),
              y: z.number().int(),
              w: z.number().int().min(1),
              h: z.number().int().min(1),
            }),
          )
          .max(32)
          .optional()
          .describe(
            'Regions deliberately filled with texture - `scatter` output, grain, foliage, sparkle, ' +
              'water glitter. Colour outliers inside them are counted as `noise.texturedOutliers` and ' +
              'do not raise the high-frequency warning, and their bright pixels are excluded from the ' +
              'light-source check, because scattered highlights are not a light source. Pass the rects ' +
              'you textured rather than lowering `noiseThreshold`, which would hide real defects ' +
              'everywhere instead.',
          ),
        grid: z
          .number()
          .int()
          .min(1)
          .max(8)
          .optional()
          .describe('Optional grid size for per-region isolated/outlier counts. 1 (default) returns one aggregate report.'),
      }),
      annotations: { readOnlyHint: true },
    },
    (args) => {
      try {
        const doc = store.require(args.document as string | undefined);
        if (args.underlay !== undefined && args.tilemap === undefined) {
          return fail('`underlay` requires `tilemap` in quality_report.');
        }
        if (args.tilemap !== undefined && args.frame !== undefined) {
          return fail('Pass either `tilemap` or `frame` to quality_report, not both.');
        }
        if (args.tilemap !== undefined && !doc.editor.sprite.tileset) {
          return fail('Tilemap quality analysis needs a tileset. Run `create_tileset` first.');
        }
        const tilemap = args.tilemap === undefined
          ? undefined
          : resolveTilemap(doc.editor.sprite, args.tilemap as string | number);
        const underlay = args.underlay === undefined
          ? undefined
          : resolveTilemap(doc.editor.sprite, args.underlay as string | number);
        return ok({
          ok: true,
          document: store.summary(doc),
          ...analyzeQuality(doc.editor.sprite, args.frame as number | string | undefined, {
            rect: args.rect as { x: number; y: number; w: number; h: number } | undefined,
            noiseThreshold: args.noiseThreshold as number | undefined,
            alphaThreshold: args.alphaThreshold as number | undefined,
            grid: args.grid as number | undefined,
            tilemap,
            underlay,
            replaceEmpty: args.replaceEmpty as number | undefined,
            textureRects: args.textureRects as Array<{ x: number; y: number; w: number; h: number }> | undefined,
          }),
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
      description: 'Redo previously undone edits. Pass `steps` to redo more than one.',
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
        'Run several commands in one round trip. Far cheaper than one call per edit when you are generating a sprite or all the frames of an animation. Each op is `{command, params}` - or put the params inline: `{command: "draw_rect", layer: "base", rect: {...}, color: "#f00", fill: true}`. Set `defaultLayer`/`defaultFrame` once instead of repeating them in every op. `atomic: true` restores the exact pre-batch state on any failure. Returns a per-op result, so a failure tells you exactly which op and why. Pass `preview: true` and use `previewOptions: {scale: 4, frame}` for one frame, `{frames: "all", onion}` for a complete animation, or `{tilemap: "Ground", debug: {grid: true, indices: true}}` for an unbaked tile grid.',
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

          // Dither is the one command whose misuse is invisible until the whole piece
          // is judged, so say something at the moment it is issued rather than leaving
          // it to `quality_report` - which can no longer tell a seam from a field.
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
            results.push({ index: i, command: op.command, ok: false, code: result.code, error });
            failures.push({ index: i, command: op.command, code: result.code, error });
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
        'Progressive command discovery. The default response is one compact line per command; use `name` for an exact command, `param` to search parameter names, `filter` for a name/description substring, and `verbose: true` for full JSON Schemas. Every command in `commands` can run through `apply_ops`; `sessionTools` are called directly.',
      inputSchema: z.object({
        name: z.string().min(1).optional().describe('Return only this exact command/session-tool name.'),
        param: z.string().min(1).optional().describe('Only return commands whose schema contains a parameter with this name.'),
        filter: z.string().optional().describe('Only return entries whose name or description contains this text.'),
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

      const hint =
        'Run anything in `commands` through apply_ops, e.g. {"ops": [{"command": "dither_fill", "params": {...}}]}. `sessionTools` are called directly as tools. Use name for an exact lookup, param for parameter-name search, and verbose: true for full JSON Schemas.';
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
          build,
          hint,
        });
      }
      return ok({
        ok: true,
        count: catalog.length,
        totalMatched,
        truncated,
        commands: catalog.map(compactCommand),
        sessionTools,
        // The registry and the guide are both a snapshot of what this process loaded
        // at startup. If either disagrees with a freshly built server, the MCP server
        // is running a stale build and needs restarting - everything here still works,
        // it is just last week's version.
        build,
        hint,
      });
    },
  );

  /* -------------------------------------------- generated command tools */

  for (const command of store.registry.list()) {
    registerCommandTool(server, store, command);
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
        'Run trusted JavaScript against the current document in a constrained `node:vm` context; it is not a security boundary for hostile code. `exec(command, params)` / `tryExec(...)` drive the same command bus as the tools; `draw.*`, `strokeTilemap`, `paintTilemap`, `document()`, `tilemaps()`, `layers()`, `frames()`, `tags()`, `palette()`, `getPixel(x, y)` and `sample(x, y)` provide higher-level editing and state reads. The whole script collapses into one undo step. Set `dryRun: true` to execute and validate against an isolated document snapshot without committing it. Pass `preview: true` and `previewOptions` (including `frames: "all"` and onion skin) to return the edited or dry-run result as a PNG in the same response. Errors include source-relative line/column information when available.',
      inputSchema: z.object({
        document: documentRef,
        expectedVersion: versionRef,
        source: z
          .string()
          .describe('JavaScript source. Return a JSON-serialisable value to get it back in `result`.'),
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
    },
    (args) => {
      let doc: PixelDocument;
      try {
        doc = store.require(args.document as string | undefined);
      } catch (error) {
        return fail((error as Error).message);
      }

      const previewOptions = args.previewOptions as PreviewRenderOptions | undefined;
      if (previewOptions && args.preview !== true) {
        return fail('`previewOptions` requires `preview: true`.');
      }
      if (previewOptions?.frames === 'all' && previewOptions.frame !== undefined) {
        return fail('Pass either `frame` or `frames: "all"`, not both.');
      }
      const expectedVersion = args.expectedVersion as number | undefined;
      if (expectedVersion !== undefined && expectedVersion !== doc.editor.version) {
        return fail(
          `Version conflict: expected version ${expectedVersion} but the document is at ${doc.editor.version}`,
          { code: 'version_conflict', expected: expectedVersion, actual: doc.editor.version },
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
      const outcome = runtime.run(args.source as string, targetEditor);
      const changed = targetEditor.version !== targetVersion;
      if (!dryRun && changed) store.touch(doc);

      if (!outcome.ok) {
        return fail(outcome.error ?? 'The script failed.', {
          code: outcome.code,
          errorInfo: outcome.errorInfo,
          logs: outcome.logs,
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
        'Load a plugin script that calls `defineCommand({ name, description, params, run })`. Every command it defines becomes a real MCP tool, is callable from scripts via `exec`, and appears in `list_commands`. Read the source from `path` or pass it inline as `source`.',
      inputSchema: z.object({
        source: z.string().optional().describe('Plugin source. Provide this or `path`.'),
        path: z.string().optional().describe('Path to a plugin .js file to read.'),
        name: z.string().optional().describe('Plugin name, shown by `list_plugins`. Defaults to the file name.'),
      }),
    },
    (args) => {
      const filePath = args.path as string | undefined;
      let source = args.source as string | undefined;
      const name = (args.name as string | undefined) ?? (filePath ? basename(filePath) : 'plugin');

      if (!source && filePath) {
        try {
          source = readFileSync(filePath, 'utf8');
        } catch (error) {
          return fail(`Could not read plugin file: ${briefError(error)}`);
        }
      }
      if (!source) return fail('load_plugin needs either `source` or `path`.');

      const outcome = scriptRuntime.loadPlugin(source, { name, registry: store.registry });
      if (!outcome.ok) {
        return fail(outcome.error ?? 'The plugin failed to load.', {
          errorInfo: outcome.errorInfo,
          logs: outcome.logs,
        });
      }

      for (const commandName of outcome.commands) {
        const command = store.registry.get(commandName);
        if (command) registerCommandTool(server, store, command);
      }
      loadedPlugins.set(name, outcome.commands);
      if (outcome.commands.length > 0) {
        try {
          server.sendToolListChanged();
        } catch {
          // A client that does not support list-changed notifications is not fatal.
        }
      }

      return ok({
        ok: true,
        name,
        commands: outcome.commands,
        logs: outcome.logs,
        toolCount: store.registry.list().length,
      });
    },
  );

  addTool(
    server,
    'list_plugins',
    {
      title: 'List loaded plugins',
      description: 'List the plugins loaded in this session and the commands each one registered.',
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

function registerCommandTool(server: McpServer, store: DocumentStore, command: Command): void {
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

  addTool(
    server,
    command.name,
    {
      title: command.name.replace(/_/g, ' '),
      description: command.description,
      inputSchema,
      annotations: command.readOnly ? { readOnlyHint: true } : { destructiveHint: false },
    },
    (args) => {
      const { document: documentId, expectedVersion, ...params } = args;
      let doc: PixelDocument;
      try {
        doc = store.require(documentId as string | undefined);
      } catch (error) {
        return fail((error as Error).message);
      }

      const sprite = doc.editor.sprite;
      if (required.has('layer') && params.layer === undefined && !sprite.layers[0]) {
        return fail('This document has no layers.');
      }
      if (required.has('frame') && params.frame === undefined && sprite.frames.length === 0) {
        return fail('This document has no frames.');
      }
      fillDefaults(sprite, command, params);

      const result = doc.editor.tryExecute(command.name, params, {
        expectedVersion: expectedVersion as number | undefined,
      });
      if (!result.ok) {
        return fail(result.error, { code: result.code, command: command.name });
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
