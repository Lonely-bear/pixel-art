import { z } from 'zod';
import { PixelBuffer } from '../buffer.js';
import type { Sprite } from '../document.js';
import { resolveFrame, resolveLayer } from '../document.js';
import type { Draft } from '../draft.js';
import { DITHER_PATTERNS } from '../dither.js';
import type { FrameId, LayerId } from '../types.js';

/**
 * Command definitions.
 *
 * A command is *pure data in, pure data out*: a zod schema for its parameters and an
 * `apply` that mutates a `Draft`. Nothing here touches the DOM, the filesystem or IPC.
 *
 * This is the single API surface shared by the Electron UI, the CLI and the MCP server.
 * Write a command once and all three clients get it — and because the zod schema is also
 * what generates the MCP tool JSON Schema later, tool descriptions can never drift from
 * behaviour.
 */

export interface CommandContext {
  draft: Draft;
  sprite: Sprite;
}

export type CommandSummary = Record<string, unknown>;

export interface Command<P = any> {
  name: string;
  description: string;
  params: z.ZodType;
  /**
   * A read-only command inspects the document and returns a summary without
   * changing anything. The editor uses this to keep such calls out of the undo
   * history: asking a question should never cost you your redo stack.
   */
  readOnly?: boolean;
  apply(ctx: CommandContext, params: P): CommandSummary | void;
}

export function defineCommand<S extends z.ZodType>(spec: {
  name: string;
  description: string;
  params: S;
  readOnly?: boolean;
  apply(ctx: CommandContext, params: z.infer<S>): CommandSummary | void;
}): Command<z.infer<S>> {
  return spec as unknown as Command<z.infer<S>>;
}

/* ------------------------------------------------------------------ *
 * Shared parameter schemas
 *
 * `.describe()` calls are not decoration: they are the text an AI agent reads when
 * deciding how to call the tool. They are part of the product.
 * ------------------------------------------------------------------ */

export const colorSchema = z.union([
  z.string(),
  z.number(),
  z.tuple([z.number(), z.number(), z.number()]),
  z.tuple([z.number(), z.number(), z.number(), z.number()]),
  z.object({
    r: z.number(),
    g: z.number(),
    b: z.number(),
    a: z.number().optional(),
  }),
]);

export const nullableColorSchema = z.union([colorSchema, z.null()]);

export const blendSchema = z.enum(['normal', 'multiply', 'screen', 'overlay', 'add', 'replace']);

export const ditherPatternSchema = z.enum(
  DITHER_PATTERNS as unknown as [string, ...string[]],
);

export const pointSchema = z.object({ x: z.number().int(), y: z.number().int() });

export const rectSchema = z.object({
  x: z.number().int().describe('Left edge in pixels, 0-based.'),
  y: z.number().int().describe('Top edge in pixels, 0-based. Y grows downward.'),
  w: z.number().int().describe('Width in pixels.'),
  h: z.number().int().describe('Height in pixels.'),
});

export const layerRefSchema = z
  .union([z.string(), z.number().int()])
  .describe('Layer ID, layer name, or 0-based index counting from the bottom.');

export const frameRefSchema = z
  .union([z.string(), z.number().int()])
  .describe('Frame ID or 0-based frame index.');

export const blendOptionsShape = {
  blend: blendSchema.optional().describe('Blend mode against existing pixels. Defaults to `normal`.'),
  opacity: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Source opacity multiplier, 0-1. Defaults to 1.'),
};

export type LayerRef = z.infer<typeof layerRefSchema>;
export type FrameRef = z.infer<typeof frameRefSchema>;

/* ------------------------------------------------------------------ *
 * Resolution helpers
 * ------------------------------------------------------------------ */

export function layerIdOf(sprite: Sprite, ref: LayerRef): LayerId {
  return resolveLayer(sprite, ref).id;
}

export function frameIdOf(sprite: Sprite, ref: FrameRef): FrameId {
  return resolveFrame(sprite, ref).id;
}

/**
 * Resolve a layer/frame reference and return a copy-on-write cel.
 * Creating a missing cel is the default because "draw on a layer that has nothing on
 * this frame yet" is the common case and should never be an error.
 *
 * Pass `create: false` for read-only commands: a missing cel then comes back as
 * `undefined` so the command can report "nothing here" instead of throwing.
 */
export function celOf(
  ctx: CommandContext,
  layerRef: LayerRef,
  frameRef: FrameRef,
  create?: true,
): PixelBuffer;
export function celOf(
  ctx: CommandContext,
  layerRef: LayerRef,
  frameRef: FrameRef,
  create: false,
): PixelBuffer | undefined;
export function celOf(
  ctx: CommandContext,
  layerRef: LayerRef,
  frameRef: FrameRef,
  create = true,
): PixelBuffer | undefined {
  const layerId = layerIdOf(ctx.sprite, layerRef);
  const frameId = frameIdOf(ctx.sprite, frameRef);
  const buf = ctx.draft.cel(layerId, frameId, create);
  if (!buf && create) throw new Error(`No cel for layer ${layerId} on frame ${frameId}`);
  return buf;
}
