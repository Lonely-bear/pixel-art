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
import {
  animationSequence,
  buildSpritesheet,
  compositeFrame,
  compositeWithOnion,
  describeCommands,
  encodeGIF,
  encodePNG,
  extractRegion,
  frameRefSchema,
  isAseprite,
  layerRefSchema,
  parseColor,
  PixelBuffer,
  resolveFrame,
  resolveLayer,
  scaleAtlas,
  scaleNearest,
  spriteFromAseprite,
  spriteFromPng,
  toAsepriteJson,
  toTiledJson,
  type Command,
  type Sprite,
} from '@pixel/core';
import { toJSONSchema, z } from 'zod';
import { ScriptRuntime } from '@pixel/script';
import { BUILTIN_PALETTES, type DocumentStore, type PixelDocument } from './session.js';
import { PIXEL_ART_SKILL } from './skill.js';

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

/** Shared options for a single-frame preview returned in a mutation response. */
const previewOptionsObjectSchema = z
  .object({
    frame: frameRefSchema.optional().describe('Frame id or 0-based index. Defaults to frame 0.'),
    rect: previewRectSchema.optional(),
    layers: previewLayersSchema,
    scale: previewScaleSchema,
    background: previewBackgroundSchema,
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
  'get_pixels',
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
  { name: 'get_pixels', description: 'Exact pixel colours in a small region.' },
  { name: 'quality_report', description: 'Objective softness/noise report and fix warnings.' },
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
  let cached = requiredArgsCache.get(command.name);
  if (!cached) {
    const base = command.params as unknown as z.ZodObject<z.ZodRawShape>;
    cached = new Set<string>((toJSONSchema(base) as { required?: string[] }).required ?? []);
    requiredArgsCache.set(command.name, cached);
  }
  return cached;
}

/**
 * Fill in the arguments an agent should not have to spell out: the bottom layer
 * and frame 0. Only applied where the command actually requires them, so
 * commands that treat `layer`/`frame` as an optional filter keep their meaning.
 */
function fillDefaults(sprite: Sprite, command: Command, params: Record<string, unknown>): void {
  const required = requiredArgsOf(command);
  if (required.has('layer') && params.layer === undefined && sprite.layers[0]) {
    params.layer = sprite.layers[0].id;
  }
  if (required.has('frame') && params.frame === undefined && sprite.frames.length > 0) {
    params.frame = 0;
  }
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
  rect?: { x: number; y: number; w: number; h: number };
  layers?: Array<string | number>;
  scale?: number;
  background?: string | null;
  frames?: 'one' | 'all';
  onion?: PreviewOnionOptions;
}

/** Even a valid 32x request can ask a 4096px canvas for a four-gigapixel image. */
const MAX_PREVIEW_OUTPUT_PIXELS = 16_777_216;

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
    const strip = new PixelBuffer(
      sprite.frames.length * sprite.width + (sprite.frames.length - 1) * gap,
      sprite.height,
    );
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
  const outputWidth = buffer.width * factor;
  const outputHeight = buffer.height * factor;
  if (outputWidth * outputHeight > MAX_PREVIEW_OUTPUT_PIXELS) {
    throw new Error(
      `Preview would be ${outputWidth}x${outputHeight} (${outputWidth * outputHeight} pixels), above the ${MAX_PREVIEW_OUTPUT_PIXELS}-pixel safety limit. Reduce scale or crop with rect.`,
    );
  }
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
    tilemaps: sprite.tilemaps?.map((t) => ({ id: t.id, name: t.name, width: t.width, height: t.height })) ?? [],
  };
}

interface QualityAnalysisOptions {
  rect?: { x: number; y: number; w: number; h: number };
  noiseThreshold?: number;
  alphaThreshold?: number;
}

/**
 * Objective heuristic report for the perceptual problems agents cannot see in a
 * thumbnail: isolated dither speckles, high-frequency outliers, clipped highlights
 * and an over-saturated edge field. It is intentionally a report, not a mutation;
 * `despeckle` and `antialias` are the matching fix commands.
 */
function analyzeQuality(sprite: Sprite, frameRef: number | string | undefined, options: QualityAnalysisOptions = {}): Record<string, unknown> {
  const frame = resolveFrame(sprite, frameRef ?? 0);
  const full = compositeFrame(sprite, frame.id);
  const buffer = options.rect ? extractRegion(full, options.rect) : full;
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
  let overexposed = 0;
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
        if (distance(c, avg) > noiseThreshold) outliers++;
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
  const softnessScore = Math.max(
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
  if (isolatedRatio > 0.005) {
    warnings.push({
      code: 'isolated_pixels',
      severity: 'warning',
      message: `${isolated} isolated solid pixels (${(isolatedRatio * 100).toFixed(2)}%). Run \`despeckle\` under a clip or rect to remove single-pixel noise.`,
    });
  }
  if (outlierRatio > 0.01) {
    warnings.push({
      code: 'high_frequency_noise',
      severity: 'warning',
      message: `${(outlierRatio * 100).toFixed(2)}% of solid pixels are colour outliers against their neighbourhood. Prefer cluster dither (\`cluster2\`/\`cluster4\`) or \`despeckle\`.`,
    });
  }
  if (meanEdge > 16) {
    warnings.push({
      code: 'high_edge_contrast',
      severity: 'warning',
      message: `Mean adjacent luminance delta is ${meanEdge.toFixed(1)}; the edge field is harsh. Run \`antialias\` on the silhouette or internal colour steps.`,
    });
  }
  if (overexposedRatio > 0.02) {
    warnings.push({
      code: 'clipped_highlights',
      severity: 'warning',
      message: `${(overexposedRatio * 100).toFixed(2)}% of solid pixels are near-white. Reduce glow/bloom coverage; a soft pixel piece keeps a value ceiling, not a white-out.`,
    });
  }
  if (paletteColors.length > 0 && paletteUsed < paletteColors.length) {
    const unused = paletteColors.length - paletteUsed;
    if (unused > Math.max(2, paletteColors.length * 0.1)) {
      warnings.push({
        code: 'unused_palette_slots',
        severity: 'info',
        message: `${unused} of ${paletteColors.length} palette colours are unused. Tighten the palette or use the idle slots deliberately.`,
      });
    }
  }
  if (sprite.paletteLocked && outsidePaletteRatio > 0.1) {
    warnings.push({
      code: 'outside_palette_pixels',
      severity: 'warning',
      message: `${(outsidePaletteRatio * 100).toFixed(1)}% of solid pixels are not exact palette swatches, usually from translucent blends. Use opaque cluster dither if palette purity matters.`,
    });
  }

  return {
    frame: sprite.frames.findIndex((f) => f.id === frame.id),
    frameId: frame.id,
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
      locked: sprite.paletteLocked ?? false,
      outsideRatio: outsidePaletteRatio,
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
      threshold: noiseThreshold,
    },
    overexposedRatio,
    softnessScore,
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
  return { name: command.name, description: command.description, params, required };
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
        'Full structure of a document: size, layers (bottom first) with their visibility/opacity/blend mode, frames with durations and which layers have pixels on them, animation tags, palette size, and the current version. Call this before editing so you know the layer names and frame indices.',
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
        onion: z
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
          .describe('Onion skin: draw the neighbouring frames behind this one as faded ghosts.'),
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
      title: 'Measure softness and noise quality',
      description:
        'Read-only heuristic report over an objective raster: isolated-pixel ratio, colour-outlier ratio, mean edge contrast, near-white highlight ratio, palette usage and a rough 0-100 softness score, plus actionable warnings. Use it before finalising a detailed canvas, then fix the flagged layers with `despeckle` and `antialias`. Pass `rect` to inspect only the region you just drew.',
      inputSchema: z.object({
        document: documentRef,
        frame: frameRefSchema.optional().describe('Frame id or 0-based index. Defaults to frame 0.'),
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
      }),
      annotations: { readOnlyHint: true },
    },
    (args) => {
      try {
        const doc = store.require(args.document as string | undefined);
        return ok({
          ok: true,
          document: store.summary(doc),
          ...analyzeQuality(doc.editor.sprite, args.frame as number | string | undefined, {
            rect: args.rect as { x: number; y: number; w: number; h: number } | undefined,
            noiseThreshold: args.noiseThreshold as number | undefined,
            alphaThreshold: args.alphaThreshold as number | undefined,
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
        'Run several commands in one round trip. Far cheaper than one call per edit when you are generating a sprite or all the frames of an animation. Each op is `{command, params}` - or put the params inline: `{command: "draw_rect", layer: "base", rect: {...}, color: "#f00", fill: true}`. Set `defaultLayer`/`defaultFrame` once instead of repeating them in every op. Use `list_commands` to see every available command and its parameters. Returns a per-op result, so a failure tells you exactly which op and why. Pass `preview: true` to get the rendered result in the same response; add `previewOptions: {scale: 4, rect, layers, frame}` to choose the exact view without a second `get_preview` call.',
      inputSchema: z.object({
        document: documentRef,
        expectedVersion: versionRef,
        atomic: z
          .boolean()
          .optional()
          .describe('If true, undo every op that succeeded when one fails, so the document is unchanged. Defaults to false.'),
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
        preview: z
          .boolean()
          .optional()
          .describe('Include a rendered PNG of the result in this response. Defaults to false.'),
        previewOptions: previewOptionsObjectSchema
          .optional()
          .describe('Configure the inline preview. Requires `preview: true`; use `{scale: 4}` for a normal iteration preview or add frame/rect/layers/background when inspecting a detail.'),
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
      let applied = 0;
      let failed = 0;
      let stoppedAt: number | null = null;

      for (let i = 0; i < rawOps.length; i++) {
        let op: { command: string; params: Record<string, unknown>; label?: string };
        try {
          op = normalizeOp(rawOps[i] ?? {});
        } catch (error) {
          failed++;
          results.push({ index: i, ok: false, error: briefError(error) });
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

      // A skipped tail is the one thing an agent cannot infer from the results, so say
      // it out loud: ops after `stoppedAt` never ran.
      const skipped = stoppedAt === null ? 0 : rawOps.length - stoppedAt - 1;

      if (applied > 0) store.touch(doc);

      if (atomic && failed > 0) {
        for (let i = 0; i < applied; i++) doc.editor.undo();
        return ok({
          ok: false,
          rolledBack: true,
          applied: 0,
          failed,
          skipped,
          version: doc.editor.version,
          failures,
        });
      }

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
        'Write the composited sprite to a PNG file. One frame by default; pass `frames: "all"` to write one file per frame (`name_0.png`, `name_1.png`, ...). Use `scale` to write a larger preview.',
      inputSchema: z.object({
        document: documentRef,
        out: z.string().optional().describe('Destination PNG path.'),
        path: z.string().optional().describe('Alias for `out`, for callers who expect a source-style path argument.'),
        frame: frameRefSchema.optional().describe('Frame id or 0-based index. Defaults to frame 0.'),
        frames: z.enum(['one', 'all']).optional().describe('"one" (default) or "all" for one file per frame.'),
        scale: z.number().int().min(1).max(32).optional().describe('Integer upscale factor. Defaults to 1 (pixel-exact).'),
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
        if (args.frames === 'all' && sprite.frames.length > 1) {
          const dot = out.lastIndexOf('.');
          const base = dot > 0 ? out.slice(0, dot) : out;
          const ext = dot > 0 ? out.slice(dot) : '';
          sprite.frames.forEach((frame, index) => {
            let buffer = compositeFrame(sprite, frame.id, { background });
            if (scale > 1) buffer = scaleNearest(buffer, scale);
            const path = `${base}_${index}${ext}`;
            writeFile(path, encodePNG(buffer));
            written.push(path);
          });
        } else {
          const frame = resolveFrame(sprite, (args.frame as number | string | undefined) ?? 0);
          let buffer = compositeFrame(sprite, frame.id, { background });
          if (scale > 1) buffer = scaleNearest(buffer, scale);
          writeFile(out, encodePNG(buffer));
          written.push(out);
        }

        return ok({
          ok: true,
          files: written,
          absolute: written.map(absPath),
          width: sprite.width * scale,
          height: sprite.height * scale,
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
        'Write the tilemaps as a Tiled 1.10 `.tmj` map, ready to open in the Tiled level editor or to load from a game engine. One tile layer is written per tilemap, in order, and the tileset is referenced by `image` - so the tileset PNG has to sit next to the map under that name. Empty cells are exported as `0` and tile `n` becomes `n + firstgid`, which is how Tiled numbers tiles.',
      inputSchema: z.object({
        document: documentRef,
        out: z.string().optional().describe('Destination .tmj path.'),
        path: z.string().optional().describe('Alias for `out`, for callers who expect a source-style path argument.'),
        image: z.string().optional().describe('Tileset image path the map references. Defaults to "tileset.png".'),
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

        const image = (args.image as string | undefined) ?? 'tileset.png';
        const firstgid = (args.firstgid as number | undefined) ?? 1;
        const map = toTiledJson(sprite.tileset, tilemaps, { image, firstgid });
        writeFile(out, Buffer.from(`${JSON.stringify(map, null, 2)}\n`, 'utf8'));

        return ok({
          ok: true,
          path: out,
          absolute: absPath(out),
          image,
          firstgid,
          width: map.width,
          height: map.height,
          tileWidth: map.tilewidth,
          tileHeight: map.tileheight,
          layers: map.layers.map((layer) => layer.name),
          tiles: map.tilesets[0]?.tilecount ?? 0,
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
        'The catalogue of drawing, structure, palette and transform commands, including commands that are not individually exposed as tools. Everything in `commands` can be run through `apply_ops`. By default each command is one line: its name, description and parameter types; pass `verbose: true` for the full JSON Schemas. `sessionTools` lists the hand-registered tools (undo/redo/history, perception, export) that are called directly instead of through `apply_ops`.',
      inputSchema: z.object({
        filter: z.string().optional().describe('Only return commands whose name or description contains this text.'),
        verbose: z
          .boolean()
          .optional()
          .describe('Return the full JSON Schema for every command instead of the compact one-line form.'),
      }),
      annotations: { readOnlyHint: true },
    },
    (args) => {
      const filter = (args.filter as string | undefined)?.toLowerCase();
      let catalog = describeCommands(store.registry.list());
      let sessionTools = SESSION_TOOLS;
      if (filter) {
        catalog = catalog.filter(
          (c) => c.name.toLowerCase().includes(filter) || c.description.toLowerCase().includes(filter),
        );
        sessionTools = sessionTools.filter(
          (t) => t.name.toLowerCase().includes(filter) || t.description.toLowerCase().includes(filter),
        );
      }
      const hint =
        'Run anything in `commands` through apply_ops, e.g. {"ops": [{"command": "dither_fill", "params": {...}}]}. `sessionTools` are called directly as tools (e.g. `undo`, `get_preview`), not via apply_ops. Pass verbose: true for the full JSON Schemas.';
      if (args.verbose === true) {
        return ok({ ok: true, count: catalog.length, commands: catalog, sessionTools, hint });
      }
      return ok({
        ok: true,
        count: catalog.length,
        commands: catalog.map(compactCommand),
        sessionTools,
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
        'Run JavaScript against the current document in a hardened sandbox. `exec(command, params)` / `tryExec(...)` drive the same command bus as the tools; `document()`, `layers()`, `frames()`, `tags()`, `palette()`, `getPixel(x, y)` and `sample(x, y)` read state; `log(...)` collects output; returning a value yields JSON. The whole script collapses into one undo step. For the fast draw→look loop, pass `preview: true` and optionally `previewOptions: {scale: 4, frame, rect, layers, background}` so the PNG arrives in this same response. There is no filesystem, network, `require` or `process` access, and it is killed after the timeout.',
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
          .describe('Execution budget in milliseconds. Defaults to 2000.'),
        preview: z
          .boolean()
          .optional()
          .describe('Return a PNG of the document after the script runs in this same response.'),
        previewOptions: previewOptionsObjectSchema
          .optional()
          .describe('Configure the inline preview. Requires `preview: true`; `{scale: 4}` is the normal fast iteration view.'),
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
      const expectedVersion = args.expectedVersion as number | undefined;
      if (expectedVersion !== undefined && expectedVersion !== doc.editor.version) {
        return fail(
          `Version conflict: expected version ${expectedVersion} but the document is at ${doc.editor.version}`,
          { code: 'version_conflict', expected: expectedVersion, actual: doc.editor.version },
        );
      }

      const timeoutMs = args.timeoutMs as number | undefined;
      const runtime = timeoutMs ? new ScriptRuntime({ timeoutMs }) : scriptRuntime;
      const before = doc.editor.version;
      const outcome = runtime.run(args.source as string, doc.editor);
      if (doc.editor.version !== before) store.touch(doc);

      if (!outcome.ok) {
        return fail(outcome.error ?? 'The script failed.', {
          logs: outcome.logs,
          version: doc.editor.version,
          document: store.summary(doc),
        });
      }

      const blocks: ContentBlock[] = [];
      let preview: Record<string, unknown> | undefined;
      let previewError: string | undefined;
      const inlinePreview = inlinePreviewOptions(args.preview, previewOptions);
      if (inlinePreview) {
        try {
          const rendered = previewPayload(doc.editor.sprite, inlinePreview);
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
          version: doc.editor.version,
          document: store.summary(doc),
          ...(preview ? { preview } : {}),
          ...(previewError ? { previewError, editCommitted: doc.editor.version !== before } : {}),
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
        return fail(outcome.error ?? 'The plugin failed to load.', { logs: outcome.logs });
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
      store.touch(doc);
      return ok({
        ok: true,
        command: command.name,
        version: doc.editor.version,
        summary: result.summary,
      });
    },
  );
}
