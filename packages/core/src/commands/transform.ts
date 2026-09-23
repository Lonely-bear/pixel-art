import { z } from 'zod';
import { PixelBuffer } from '../buffer.js';
import { clearRegion } from '../raster.js';
import { crop, flipHorizontal, flipVertical, resizeCanvas, rotate90, scaleNearest } from '../transform.js';
import {
  defineCommand,
  frameIdOf,
  frameRefSchema,
  layerIdOf,
  layerRefSchema,
  rectSchema,
  type FrameRef,
  type LayerRef,
} from './types.js';
import type { CommandContext } from './types.js';

/**
 * Whole-canvas transforms.
 *
 * These deliberately replace buffers outright rather than mutating them: the draft's
 * snapshot still points at the originals, so undo works and there is no copy-on-write
 * bookkeeping to get wrong when the geometry changes shape.
 */

interface CelTarget {
  frame: { cels: Map<string, PixelBuffer> };
  layerId: string;
  buffer: PixelBuffer;
}

function selectCels(ctx: CommandContext, layerRef?: LayerRef, frameRef?: FrameRef): CelTarget[] {
  const layerId = layerRef === undefined ? null : layerIdOf(ctx.sprite, layerRef);
  const frameId = frameRef === undefined ? null : frameIdOf(ctx.sprite, frameRef);
  const targets: CelTarget[] = [];
  for (const frame of ctx.sprite.frames) {
    if (frameId !== null && frame.id !== frameId) continue;
    for (const [lid, buffer] of frame.cels) {
      if (layerId !== null && lid !== layerId) continue;
      targets.push({ frame, layerId: lid, buffer });
    }
  }
  return targets;
}

const scopeShape = {
  layer: layerRefSchema.optional().describe('Restrict to one layer. Omit for all layers.'),
  frame: frameRefSchema.optional().describe('Restrict to one frame. Omit for all frames.'),
};

export const flipCommand = defineCommand({
  name: 'flip',
  description:
    'Mirror artwork. Applies to every cel by default; scope it with `layer` and/or `frame`. Useful for symmetry — draw one half, then flip.',
  params: z.object({
    axis: z.enum(['horizontal', 'vertical']).describe('`horizontal` mirrors left/right, `vertical` mirrors top/bottom.'),
    ...scopeShape,
  }),
  apply(ctx, p) {
    const targets = selectCels(ctx, p.layer, p.frame);
    const transform = p.axis === 'horizontal' ? flipHorizontal : flipVertical;
    for (const t of targets) t.frame.cels.set(t.layerId, transform(t.buffer));
    return { cels: targets.length, axis: p.axis };
  },
});

export const rotateCommand = defineCommand({
  name: 'rotate',
  description:
    'Rotate artwork by a multiple of 90 degrees clockwise. A quarter turn swaps the canvas width and height.',
  params: z.object({
    turns: z.number().int().describe('Number of clockwise quarter turns. 1, 2, 3; other values wrap.'),
    ...scopeShape,
  }),
  apply(ctx, p) {
    const targets = selectCels(ctx, p.layer, p.frame);
    const turns = ((p.turns % 4) + 4) % 4;
    for (const t of targets) t.frame.cels.set(t.layerId, rotate90(t.buffer, turns));
    if (turns % 2 === 1) {
      const { width, height } = ctx.sprite;
      ctx.sprite.width = height;
      ctx.sprite.height = width;
    }
    return { cels: targets.length, turns };
  },
});

export const resizeCanvasCommand = defineCommand({
  name: 'resize_canvas',
  description:
    'Change the canvas size, keeping pixel scale. Existing artwork is placed at `offsetX, offsetY` (default 0,0 = top-left). Content outside the new bounds is discarded.',
  params: z.object({
    width: z.number().int().min(1),
    height: z.number().int().min(1),
    offsetX: z.number().int().optional().describe('Where to place the old top-left in the new canvas. Defaults to 0.'),
    offsetY: z.number().int().optional(),
  }),
  apply(ctx, p) {
    const previous = { width: ctx.sprite.width, height: ctx.sprite.height };
    const offsetX = p.offsetX ?? 0;
    const offsetY = p.offsetY ?? 0;
    ctx.sprite.width = p.width;
    ctx.sprite.height = p.height;
    for (const frame of ctx.sprite.frames) {
      for (const [layerId, buffer] of frame.cels) {
        frame.cels.set(layerId, resizeCanvas(buffer, p.width, p.height, offsetX, offsetY));
      }
    }
    return { previous, width: p.width, height: p.height };
  },
});

export const cropCanvasCommand = defineCommand({
  name: 'crop_canvas',
  description: 'Trim the canvas to a rect. The rect becomes the new origin, so the content inside it stays put.',
  params: z.object({ rect: rectSchema }),
  apply(ctx, p) {
    const previous = { width: ctx.sprite.width, height: ctx.sprite.height };
    const w = Math.max(1, p.rect.w);
    const h = Math.max(1, p.rect.h);
    ctx.sprite.width = w;
    ctx.sprite.height = h;
    for (const frame of ctx.sprite.frames) {
      for (const [layerId, buffer] of frame.cels) {
        frame.cels.set(layerId, resizeCanvas(buffer, w, h, -p.rect.x, -p.rect.y));
      }
    }
    return { previous, width: w, height: h, rect: p.rect };
  },
});

export const scaleSpriteCommand = defineCommand({
  name: 'scale_sprite',
  description:
    'Multiply the whole sprite by an integer factor using nearest-neighbour sampling. This is the correct way to make a 2x or 4x version for previews and store assets.',
  params: z.object({
    factor: z.number().int().min(1).describe('Integer scale factor, 1-16.'),
  }),
  apply(ctx, p) {
    if (p.factor > 16) throw new Error('Refusing to scale by more than 16x in one step');
    const previous = { width: ctx.sprite.width, height: ctx.sprite.height };
    for (const frame of ctx.sprite.frames) {
      for (const [layerId, buffer] of frame.cels) {
        frame.cels.set(layerId, scaleNearest(buffer, p.factor));
      }
    }
    ctx.sprite.width = previous.width * p.factor;
    ctx.sprite.height = previous.height * p.factor;
    return { previous, factor: p.factor, width: ctx.sprite.width, height: ctx.sprite.height };
  },
});

export const clearAllCommand = defineCommand({
  name: 'clear_all',
  description: 'Erase every cel on every frame back to full transparency. Layer and frame structure is preserved.',
  params: z.object({}),
  apply(ctx) {
    let cleared = 0;
    for (const frame of ctx.sprite.frames) {
      for (const [layerId, buffer] of frame.cels) {
        clearRegion(buffer);
        cleared++;
      }
    }
    return { cels: cleared };
  },
});
