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
import { dirname } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ContentBlock, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import {
  allCommands,
  animationSequence,
  buildSpritesheet,
  compositeFrame,
  defaultRegistry,
  describeCommands,
  encodeGIF,
  encodePNG,
  frameRefSchema,
  isAseprite,
  layerRefSchema,
  parseColor,
  PixelBuffer,
  resolveFrame,
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
  'list_commands',
  'list_documents',
]);

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
      layers: [...f.cels.keys()].map((layerId) => {
        const layer = sprite.layers.find((l) => l.id === layerId);
        return layer ? layer.name : layerId;
      }),
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
    celCount: sprite.frames.reduce((sum, f) => sum + f.cels.size, 0),
    hasTileset: Boolean(sprite.tileset),
    tilemaps: sprite.tilemaps?.map((t) => ({ id: t.id, name: t.name, width: t.width, height: t.height })) ?? [],
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
        'Create a new blank sprite and make it active. Returns the document id and version. Prefer small canvases (16x16 to 64x64) and 2-4 named layers. Pass `palette` to constrain colours, which is the single biggest quality win for pixel art.',
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
        return ok({ ok: true, path, document: store.summary(doc) });
      } catch (error) {
        return fail(`Could not save ${path}: ${(error as Error).message}`);
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
      description: 'Make a document the active one, so later calls can omit `document`.',
      inputSchema: z.object({ document: z.string().describe('Document id to activate.') }),
      annotations: { readOnlyHint: true },
    },
    (args) => {
      try {
        return ok({ ok: true, document: store.summary(store.select(args.document as string)) });
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
        'Render the composited sprite as a PNG image you can actually see, plus a text summary. This is your eyes: call it after blocking in the silhouette, after shading and after outlining. Returns all frames as a horizontal sheet when `frames` is "all".',
      inputSchema: z.object({
        document: documentRef,
        frame: frameRefSchema.optional().describe('Frame id or 0-based index. Defaults to frame 0.'),
        frames: z
          .enum(['one', 'all'])
          .optional()
          .describe('"one" (default) renders a single frame; "all" renders every frame as a horizontal strip.'),
        scale: z
          .number()
          .int()
          .min(1)
          .max(32)
          .optional()
          .describe('Integer upscale factor. Defaults to whatever makes the longest side about 256px.'),
        background: z
          .string()
          .nullable()
          .optional()
          .describe('Composite over this colour (e.g. "#202020") to judge light colours against something other than transparency.'),
      }),
      annotations: { readOnlyHint: true },
    },
    (args) => {
      try {
        const doc = store.require(args.document as string | undefined);
        const sprite = doc.editor.sprite;
        const background = resolveBackground(args.background as string | null | undefined);
        const frames = sprite.frames;

        let buffer: PixelBuffer;
        let meta: Record<string, unknown>;

        if (args.frames === 'all' && frames.length > 1) {
          const rendered = frames.map((frame) => compositeFrame(sprite, frame.id, { background }));
          const gap = 1;
          const strip = new PixelBuffer(
            frames.length * sprite.width + (frames.length - 1) * gap,
            sprite.height,
          );
          rendered.forEach((img, i) => strip.blit(img, i * (sprite.width + gap), 0));
          buffer = strip;
          meta = {
            mode: 'all-frames',
            frameCount: frames.length,
            sheetWidth: strip.width,
            sheetHeight: strip.height,
            layout: 'horizontal strip, 1px gap, frames left to right',
          };
        } else {
          const frame = resolveFrame(sprite, (args.frame as number | string | undefined) ?? 0);
          buffer = compositeFrame(sprite, frame.id, { background });
          meta = {
            mode: 'single-frame',
            frame: sprite.frames.findIndex((f) => f.id === frame.id),
            frameId: frame.id,
            durationMs: frame.durationMs,
          };
        }

        const factor =
          (args.scale as number | undefined) ??
          previewFactor(buffer.width, buffer.height, 256, 16);
        const shown = factor > 1 ? scaleNearest(buffer, factor) : buffer;

        return ok(
          {
            ok: true,
            document: store.summary(doc),
            width: sprite.width,
            height: sprite.height,
            ...meta,
            upscale: factor,
            imageWidth: shown.width,
            imageHeight: shown.height,
          },
          [imageContent(shown)],
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
      }),
      annotations: { destructiveHint: false },
    },
    (args) => {
      const doc = store.require(args.document as string | undefined);
      const steps = (args.steps as number | undefined) ?? 1;
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
      }),
      annotations: { destructiveHint: false },
    },
    (args) => {
      const doc = store.require(args.document as string | undefined);
      const steps = (args.steps as number | undefined) ?? 1;
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
        'Run several commands in one round trip. Far cheaper than one call per edit when you are generating a sprite or all the frames of an animation. Each op is `{command, params}` - or put the params inline: `{command: "draw_rect", layer: "base", rect: {...}, color: "#f00", fill: true}`. Set `defaultLayer`/`defaultFrame` once instead of repeating them in every op. Use `list_commands` to see every available command and its parameters. Returns a per-op result, so a failure tells you exactly which op and why.',
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

        const command = defaultRegistry.get(op.command);
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

      return ok({
        ok: failed === 0,
        applied,
        failed,
        skipped,
        version: doc.editor.version,
        document: store.summary(doc),
        // The failure list is small and always worth having; the per-op results
        // are the bulky part, so `quiet` drops those instead.
        ...(failed > 0 ? { failures } : {}),
        ...(quiet ? {} : { results }),
      });
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
        'The catalogue of drawing, structure, palette and transform commands, including commands that are not individually exposed as tools. Everything listed here can be run through `apply_ops`. By default each command is one line: its name, description and parameter types. Pass `verbose: true` for the full JSON Schemas.',
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
      let catalog = describeCommands(allCommands);
      if (filter) {
        catalog = catalog.filter(
          (c) => c.name.toLowerCase().includes(filter) || c.description.toLowerCase().includes(filter),
        );
      }
      const hint =
        'Run any of these through apply_ops, e.g. {"ops": [{"command": "dither_fill", "params": {...}}]}. Pass verbose: true for the full JSON Schemas.';
      if (args.verbose === true) {
        return ok({ ok: true, count: catalog.length, commands: catalog, hint });
      }
      return ok({
        ok: true,
        count: catalog.length,
        commands: catalog.map(compactCommand),
        hint,
      });
    },
  );

  /* -------------------------------------------- generated command tools */

  for (const command of allCommands) {
    registerCommandTool(server, store, command);
  }

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
