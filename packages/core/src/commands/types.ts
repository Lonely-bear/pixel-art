import { z } from 'zod';
import { PixelBuffer } from '../buffer.js';
import { parseColor } from '../color.js';
import type { Sprite } from '../document.js';
import { findLayerIndex, resolveFrame, resolveLayer } from '../document.js';
import type { Draft } from '../draft.js';
import { DITHER_PATTERNS } from '../dither.js';
import { nearestColor } from '../palette.js';
import { maskFromBuffer, type ShapeSpec } from '../raster.js';
import { frameMask } from '../render.js';
import type { Color, ColorInput, FrameId, LayerId } from '../types.js';

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

export function defineCommand<S extends z.ZodObject<z.ZodRawShape>>(spec: {
  name: string;
  description: string;
  params: S;
  readOnly?: boolean;
  apply(ctx: CommandContext, params: z.infer<S>): CommandSummary | void;
}): Command<z.infer<S>> {
  // Strict at the top level, so a mistyped parameter is an error instead of a
  // silent fallback to the default. Agents guess parameter names - a `count`
  // that quietly does nothing while `steps` was wanted is a data-loss-shaped
  // bug, not a cosmetic one.
  return { ...spec, params: spec.params.strict() } as unknown as Command<z.infer<S>>;
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

export const pointSchema = z
  .object({ x: z.number().int(), y: z.number().int() })
  .strict();

export const rectSchema = z
  .object({
    x: z.number().int().describe('Left edge in pixels, 0-based.'),
    y: z.number().int().describe('Top edge in pixels, 0-based. Y grows downward.'),
    w: z.number().int().describe('Width in pixels.'),
    h: z.number().int().describe('Height in pixels.'),
  })
  .strict();

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

export const clipRefSchema = z
  .union([
    z.enum(['none', 'cel', 'composite']),
    z.object({ layer: layerRefSchema }).strict(),
    z.object({ layers: z.array(layerRefSchema).min(1) }).strict(),
  ])
  .describe(
    'Restrict painting to existing pixels. `cel` = only where this layer already has ' +
      'pixels; `composite` = only where the rest of the frame does; `{layer}` = only where ' +
      'that named layer has pixels; `{layers:[...]}` = where any of those layers do. Use ' +
      '`composite` to keep a shadow, highlight or dither band inside the sprite silhouette, ' +
      'and `{layer}` to confine shading to something you already blocked in (hair, cape, ' +
      'robe) instead of the whole body.',
  );

export const clipSchema = clipRefSchema.optional();

export type ClipRef = z.infer<typeof clipRefSchema>;

export const shapeSchema = z
  .union([
    z.object({ rect: rectSchema }).strict(),
    z.object({ ellipse: rectSchema }).strict(),
    z.object({ polygon: z.array(pointSchema).min(3) }).strict(),
  ])
  .describe(
    'A region: `{rect}`, `{ellipse}` or `{polygon}`. Use `ellipse` or `polygon` for a ' +
      'dithered band that follows a curve instead of a box.',
  );

export type ShapeRef = z.infer<typeof shapeSchema>;

/** Turn the wire form of a shape into the rasteriser's `ShapeSpec`. */
export function toShapeSpec(shape: ShapeRef): ShapeSpec {
  if ('rect' in shape) return { kind: 'rect', rect: shape.rect };
  if ('ellipse' in shape) return { kind: 'ellipse', rect: shape.ellipse };
  return { kind: 'polygon', points: shape.polygon };
}

/**
 * Optional stipple parameters, spread into any paint command.
 *
 * Dithering is handled inside `putPixel`, so adding these two keys is all a command needs
 * to gain dithered fills for every shape it can draw.
 */
export const ditherOptionsShape = {
  pattern: ditherPatternSchema
    .optional()
    .describe('Stipple the paint with this pattern instead of laying it down solid.'),
  level: z.number().min(0).max(1).optional().describe('Coverage for `pattern`, 0-1. Defaults to 0.5.'),
};

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
 * Resolve a colour parameter against the sprite's palette.
 *
 * This is where palette-index shorthand becomes concrete: an integer in range, or a
 * `"pal:9"` string, resolves to that palette slot. Everything else falls through to
 * the ordinary hex/name/RGB parsing. Commands call this *before* handing a colour to
 * the rasteriser, because the rasteriser has no sprite and therefore no palette.
 */
export function resolveColor(sprite: Sprite, input: ColorInput): Color;
export function resolveColor(sprite: Sprite, input: ColorInput | null): Color | null;
export function resolveColor(sprite: Sprite, input: ColorInput | null): Color | null {
  if (input === null) return null;
  const color = parseColor(input, sprite.palette);
  if (!sprite.paletteLocked) return color;
  // Palette lock snaps RGB to the nearest swatch but keeps the requested alpha, so
  // semi-transparent paint (a translucent cape, a soft glow) still works.
  const snapped = nearestColor(sprite.palette, color);
  return { r: snapped.r, g: snapped.g, b: snapped.b, a: color.a };
}

/**
 * Build the mask for a `clip` option, or `undefined` when nothing should be clipped.
 *
 * `composite` deliberately *excludes the layer being painted into*. The usual workflow is
 * a silhouette on the bottom layer and shading on a layer above it; if the target layer
 * counted towards its own silhouette the clip would be a no-op the moment anything had
 * been drawn, and the shading would bleed out of the sprite exactly as it does today.
 * Painting into the same layer you are clipping against is what `clip: 'cel'` is for.
 */
export function clipMask(
  ctx: CommandContext,
  clip: ClipRef | undefined,
  layerRef: LayerRef,
  frameRef: FrameRef,
): Uint8Array | undefined {
  if (!clip || clip === 'none') return undefined;
  const layerId = layerIdOf(ctx.sprite, layerRef);
  const frameId = frameIdOf(ctx.sprite, frameRef);
  if (clip === 'cel') {
    const cel = ctx.draft.cel(layerId, frameId, false);
    // An empty cel has no pixels to clip against, so nothing may be painted.
    return cel ? maskFromBuffer(cel) : new Uint8Array(ctx.sprite.width * ctx.sprite.height);
  }
  if (typeof clip === 'object') {
    // Union of the named layers' own pixels on this frame.
    const refs = 'layers' in clip ? clip.layers : [clip.layer];
    const mask = new Uint8Array(ctx.sprite.width * ctx.sprite.height);
    for (const ref of refs) {
      const cel = ctx.draft.cel(layerIdOf(ctx.sprite, ref), frameId, false);
      if (!cel) continue;
      const source = maskFromBuffer(cel);
      for (let i = 0; i < mask.length; i++) if (source[i]) mask[i] = 1;
    }
    return mask;
  }
  return frameMask(ctx.sprite, frameId, { excludeLayerId: layerId });
}

/**
 * A warning to attach to a draw summary when the clip target sits *above* the layer
 * being painted into.
 *
 * This is the single most common way to lose work with `clip`: a named-layer clip is
 * usually a silhouette you want to stay inside, and the natural reading of "shade the
 * hair, clipped to the hair" is to paint on a shared `shade` layer. If that layer is
 * below `hair` in the stack, every pixel it paints is immediately covered by the hair
 * itself — the command reports `painted: 200` and the canvas looks unchanged. Painting
 * the same pixels on the clip layer (or a layer above it) is what the caller meant, so
 * say so instead of leaving them to debug an invisible edit.
 */
export function clipWarning(
  ctx: CommandContext,
  clip: ClipRef | undefined,
  layerRef: LayerRef,
): CommandSummary {
  if (!clip || typeof clip !== 'object') return {};
  const paintIndex = findLayerIndex(ctx.sprite, layerIdOf(ctx.sprite, layerRef));
  const refs = 'layers' in clip ? clip.layers : [clip.layer];
  const occluded = refs.every(
    (ref) => findLayerIndex(ctx.sprite, layerIdOf(ctx.sprite, ref)) > paintIndex,
  );
  if (!occluded) return {};
  return {
    warning:
      'The clip layer(s) render above the layer being painted, so these pixels are hidden behind them. Paint on the clip layer itself, or on a layer above it.',
  };
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
