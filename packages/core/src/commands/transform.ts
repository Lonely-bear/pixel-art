import { z } from 'zod';
import { PixelBuffer } from '../buffer.js';
import { getFrame } from '../document.js';
import { clearRegion } from '../raster.js';
import { compositeFrame } from '../render.js';
import {
  crop,
  flipHorizontal,
  flipVertical,
  resizeCanvas,
  resolvePivot,
  rotate90,
  scaleAbout,
  scaleNearest,
  translate,
} from '../transform.js';
import {
  defineCommand,
  frameIdOf,
  frameRefSchema,
  layerIdOf,
  layerRefSchema,
  pointSchema,
  rectSchema,
  type FrameRef,
  type LayerRef,
} from './types.js';
import type { CommandContext } from './types.js';
import type { Point } from '../types.js';

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

/** Deterministic, smooth one-dimensional noise used for reflection displacement. */
function reflectionNoise(value: number, seed: number): number {
  const cell = Math.floor(value);
  const fraction = value - cell;
  const smooth = fraction * fraction * (3 - 2 * fraction);
  const sample = (index: number): number => {
    let n = Math.imul((index | 0) ^ seed, 0x9e3779b9);
    n ^= n >>> 16;
    n = Math.imul(n, 0x85ebca6b);
    n ^= n >>> 13;
    return (n >>> 0) / 0x100000000;
  };
  const a = sample(cell);
  const b = sample(cell + 1);
  return a + (b - a) * smooth;
}

function reflectionOffset(
  x: number,
  sourceY: number,
  depth: number,
  amount: number,
  seed: number,
): number {
  if (amount <= 0 || depth <= 0) return 0;
  // Most of the displacement is coherent along rows; a small, block-stable term keeps
  // a reflection from looking like a single perfectly sheared copy.
  const row = reflectionNoise(sourceY * 0.075 + seed * 0.013, seed ^ 0x51ed270b);
  const block = reflectionNoise(Math.floor(x / 8) * 0.19 + sourceY * 0.011, seed ^ 0x1b873593);
  const signed = (row * 0.72 + block * 0.28 - 0.5) * 2;
  return Math.round(signed * amount * depth);
}

export const mirrorCommand = defineCommand({
  name: 'mirror',
  description:
    'Mirror a cel about an arbitrary line instead of the canvas centre. `axis: "horizontal"` mirrors left/right about a vertical line, `"vertical"` mirrors top/bottom about a horizontal one. `about` is the line position in pixels and defaults to the canvas centre; pass the waterline row to build a lake reflection in one call. For a physical-looking reflection, vertical mirrors also accept `compress` (non-linear vertical compression, 0-1), seeded `wobble` (horizontal displacement in pixels that grows with depth), and optional depth `attenuate`. `copyTo` writes the mirrored copy into another layer and leaves the source untouched - which is what a reflection needs - and otherwise merges into it. Omit `copyTo` to mirror in place.',
  params: z.object({
    layer: layerRefSchema.optional().describe('Layer to mirror. Omit for every layer.'),
    frame: frameRefSchema.optional().describe('Frame to mirror. Omit for every frame.'),
    axis: z.enum(['horizontal', 'vertical']).describe('`horizontal` mirrors left/right, `vertical` mirrors top/bottom.'),
    about: z.number().int().optional().describe('Position of the mirror line in pixels. Defaults to the canvas centre on that axis.'),
    compress: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Non-linear vertical compression strength for a vertical reflection. 0 is an exact mirror; 1 is the strongest compression. Ignored for horizontal mirroring.'),
    wobble: z
      .number()
      .min(0)
      .max(64)
      .optional()
      .describe('Maximum seeded horizontal displacement in pixels. It grows with distance from the mirror line, so the reflection is not a copied silhouette.'),
    attenuate: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Optional depth fade for a vertical reflection, 0-1. Alpha is reduced toward the far end; defaults to 0 (no fade).'),
    seed: z.number().int().optional().describe('Seed for reflection compression/wobble. Defaults to 1.'),
    copyTo: layerRefSchema.optional().describe('Write the mirrored copy into this layer and leave the source untouched. Omit to mirror in place.'),
  }),
  apply(ctx, p) {
    const targets = selectCels(ctx, p.layer, p.frame);
    // Resolve and validate the destination before the empty-target fast path. A typo
    // must not look like a successful no-op, and copying a layer onto itself would
    // merge the reflection back into the source instead of preserving it.
    const destId = p.copyTo === undefined ? null : layerIdOf(ctx.sprite, p.copyTo);
    if (destId !== null && targets.some((target) => target.layerId === destId)) {
      throw new Error('mirror copyTo must be different from the source layer');
    }
    const compress = p.compress ?? 0;
    const wobble = p.wobble ?? 0;
    const attenuate = p.attenuate ?? 0;
    const seed = p.seed ?? 1;
    const optics = compress > 0 || wobble > 0 || attenuate > 0;
    if (targets.length === 0) {
      return { cels: 0, axis: p.axis, compress, wobble, attenuate, seed, opticsApplied: false };
    }
    const { width, height } = ctx.sprite;
    const about = p.about ?? (p.axis === 'horizontal' ? (width - 1) / 2 : (height - 1) / 2);

    const mirrorBuffer = (buffer: PixelBuffer): PixelBuffer => {
      const out = PixelBuffer.empty(buffer.width, buffer.height);
      for (let y = 0; y < buffer.height; y++) {
        for (let x = 0; x < buffer.width; x++) {
          const c = buffer.getColor(x, y);
          if (c.a === 0) continue;
          let tx = p.axis === 'horizontal' ? Math.round(2 * about - x) : x;
          let ty = p.axis === 'vertical' ? Math.round(2 * about - y) : y;
          let depth = 0;
          if (p.axis === 'vertical' && optics) {
            // `about` can sit off-centre, so use the distance available on the source
            // side rather than a canvas-wide constant. The exponent keeps the line
            // fixed and compresses distant detail non-linearly without wrapping.
            const above = y <= about;
            const span = Math.max(1, above ? about : buffer.height - 1 - about);
            const distance = Math.abs(y - about);
            depth = Math.min(1, distance / span);
            const warpedDepth = compress > 0 ? Math.pow(depth, 1 + compress) : depth;
            ty = Math.round(above ? about + warpedDepth * span : about - warpedDepth * span);
            tx += reflectionOffset(x, y, depth, wobble, seed);
          }
          // Artwork mirrored past the edge is dropped, not wrapped.
          if (tx < 0 || ty < 0 || tx >= buffer.width || ty >= buffer.height) continue;
          const outputColor = p.axis === 'vertical' && attenuate > 0
            ? { ...c, a: Math.round(c.a * (1 - attenuate * depth)) }
            : c;
          out.setColor(tx, ty, outputColor);
        }
      }
      return out;
    };

    const opticsApplied = p.axis === 'vertical' && optics;
    const opticalWarning =
      optics && p.axis === 'horizontal'
        ? '`compress`, `wobble`, and `attenuate` describe a water reflection and are ignored for a horizontal mirror.'
        : undefined;
    if (destId !== null) {
      for (const t of targets) {
        const mirrored = mirrorBuffer(t.buffer);
        const existing = t.frame.cels.get(destId);
        if (!existing) {
          t.frame.cels.set(destId, mirrored);
          continue;
        }
        // Merge, so several source layers can each contribute to one reflection.
        for (let y = 0; y < mirrored.height; y++) {
          for (let x = 0; x < mirrored.width; x++) {
            const c = mirrored.getColor(x, y);
            if (c.a !== 0) existing.setColor(x, y, c);
          }
        }
      }
      return {
        cels: targets.length,
        axis: p.axis,
        about,
        compress,
        wobble,
        attenuate,
        seed,
        opticsApplied,
        copiedTo: destId,
        sourceUntouched: true,
        ...(opticalWarning ? { warning: opticalWarning } : {}),
      };
    }

    for (const t of targets) t.frame.cels.set(t.layerId, mirrorBuffer(t.buffer));
    return {
      cels: targets.length,
      axis: p.axis,
      about,
      compress,
      wobble,
      attenuate,
      seed,
      opticsApplied,
      ...(opticalWarning ? { warning: opticalWarning } : {}),
    };
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
    return {
      cels: cleared,
      warning: `clear_all erased ${cleared} cel(s) to full transparency; layer and frame structure was preserved.`,
    };
  },
});

/* ------------------------------------------------------------------ *
 * Per-cel motion
 *
 * Animating a bob used to mean clearing and redrawing every layer of every
 * frame: a 1px nudge cost a `copy_region` plus a `clear_region` per cel, and
 * there was no way to squash at all. These two commands are what make the
 * skill's own advice ("move the whole silhouette, do not redraw it") followable.
 * ------------------------------------------------------------------ */

const NAMED_PIVOTS = [
  'center',
  'top',
  'bottom',
  'left',
  'right',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
] as const;

const layerOrAllSchema = z
  .union([layerRefSchema, z.literal('*')])
  .describe('A layer reference, or `*` for every layer that has a cel on this frame.');

/** The cels a per-cel motion command should touch, restricted to one frame. */
function frameCels(ctx: CommandContext, layerRef: LayerRef | '*', frameRef: FrameRef): CelTarget[] {
  const frame = getFrame(ctx.sprite, frameIdOf(ctx.sprite, frameRef));
  const layerIds =
    layerRef === '*' ? [...frame.cels.keys()] : [layerIdOf(ctx.sprite, layerRef as LayerRef)];
  const targets: CelTarget[] = [];
  for (const layerId of layerIds) {
    const buffer = frame.cels.get(layerId);
    if (buffer) targets.push({ frame, layerId, buffer });
  }
  return targets;
}

export const translateCommand = defineCommand({
  name: 'translate',
  description:
    'Shift a cel by whole pixels, clearing the band it vacates. This is how you bob, drift or nudge artwork between frames: one operation instead of a copy plus a clear. Use `layer: "*"` to move every layer of the frame together so the sprite stays registered.',
  params: z.object({
    layer: layerOrAllSchema,
    frame: frameRefSchema,
    dx: z.number().int().describe('Horizontal shift in pixels. Negative moves left.'),
    dy: z.number().int().describe('Vertical shift in pixels. Negative moves up.'),
  }),
  apply(ctx, p) {
    const targets = frameCels(ctx, p.layer, p.frame);
    for (const t of targets) t.frame.cels.set(t.layerId, translate(t.buffer, p.dx, p.dy));
    return { cels: targets.length, dx: p.dx, dy: p.dy };
  },
});

export const squashCommand = defineCommand({
  name: 'squash',
  description:
    'Scale a cel about a pivot with nearest-neighbour sampling, keeping the canvas size so the artwork stays registered to the sprite. Squash and stretch: `scaleY: 0.9, scaleX: 1.08` for the down beat, the reverse for the up beat. The pivot defaults to `bottom`, which is what a bounce or a landing wants.',
  params: z.object({
    layer: layerOrAllSchema,
    frame: frameRefSchema,
    scaleX: z
      .number()
      .positive()
      .max(8)
      .optional()
      .describe('Horizontal factor. 1.08 stretches 8%. Defaults to 1 (unchanged).'),
    scaleY: z
      .number()
      .positive()
      .max(8)
      .optional()
      .describe('Vertical factor. 0.9 squashes 10%. Defaults to 1 (unchanged).'),
    pivot: z
      .union([z.enum(NAMED_PIVOTS), pointSchema])
      .optional()
      .describe(
        'Anchor that stays put: a named edge or corner of the artwork, or an explicit `{x, y}` in canvas pixels. Defaults to `bottom`.',
      ),
  }),
  apply(ctx, p) {
    const scaleX = p.scaleX ?? 1;
    const scaleY = p.scaleY ?? 1;
    const targets = frameCels(ctx, p.layer, p.frame);
    if (targets.length === 0) return { cels: 0, reason: 'no cels on this frame' };

    // With `layer: "*"` every cel must share one pivot, or the layers drift apart
    // and the sprite shears. The composite is the only frame of reference that is
    // the same for all of them.
    const named = typeof p.pivot === 'string' ? p.pivot : null;
    let shared: Point | null = null;
    if (named) {
      const bounds =
        p.layer === '*'
          ? compositeFrame(ctx.sprite, frameIdOf(ctx.sprite, p.frame)).opaqueBounds()
          : targets[0].buffer.opaqueBounds();
      if (!bounds) return { cels: 0, reason: 'nothing drawn to pivot around' };
      shared = resolvePivot(named, bounds);
    }
    const explicit: Point | null = named ? null : ((p.pivot as Point | undefined) ?? null);

    let done = 0;
    for (const t of targets) {
      let pivot: Point | null = explicit;
      if (!pivot) {
        const bounds = t.buffer.opaqueBounds();
        if (!bounds) continue;
        pivot = shared ?? resolvePivot('bottom', bounds);
      }
      t.frame.cels.set(
        t.layerId,
        scaleAbout(t.buffer, scaleX, scaleY, { pivotX: pivot.x, pivotY: pivot.y }),
      );
      done++;
    }
    return { cels: done, scaleX, scaleY, pivot: shared ?? explicit ?? null };
  },
});
