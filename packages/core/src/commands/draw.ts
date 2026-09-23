import { z } from 'zod';
import { blendInto } from '../blend.js';
import { clipRect, fullRect } from '../geometry.js';
import { frameMask, compositeFrame } from '../render.js';
import {
  clearRegion,
  countOpaque,
  drawEllipse,
  drawLine,
  drawPolygon,
  drawPixels,
  drawRect,
  extractRegion,
  fillShape,
  floodFill,
  outline,
  replaceColor,
} from '../raster.js';
import {
  blendOptionsShape,
  celOf,
  clipMask,
  clipSchema,
  colorSchema,
  defineCommand,
  ditherOptionsShape,
  ditherPatternSchema,
  frameIdOf,
  frameRefSchema,
  layerIdOf,
  layerRefSchema,
  nullableColorSchema,
  pointSchema,
  rectSchema,
  shapeSchema,
  toShapeSpec,
} from './types.js';

/**
 * Drawing commands.
 *
 * Every one of these clips silently and reports how many pixels it actually touched,
 * so an agent that gets a coordinate slightly wrong gets a sensible result plus feedback
 * rather than an exception.
 */

export const drawPixelsCommand = defineCommand({
  name: 'draw_pixels',
  description:
    'Write an explicit list of pixels. `color: null` erases the pixel. Coordinates outside the canvas are ignored. Use this for precise, hand-authored detail; prefer the shape and dither commands for anything regular.',
  params: z.object({
    layer: layerRefSchema,
    frame: frameRefSchema,
    pixels: z
      .array(
        // Strict, like the top level: a mistyped per-pixel key has to be an error,
        // not a silently dropped property.
        z
          .object({
            x: z.number().int(),
            y: z.number().int(),
            color: nullableColorSchema.describe('Colour to write, or null to erase.'),
          })
          .strict(),
      )
      .describe('Sparse pixel list. Only the listed pixels are touched.'),
    clip: clipSchema,
    ...ditherOptionsShape,
    ...blendOptionsShape,
  }),
  apply(ctx, p) {
    const buf = celOf(ctx, p.layer, p.frame);
    const painted = drawPixels(buf, p.pixels, {
      blend: p.blend,
      opacity: p.opacity,
      pattern: p.pattern as never,
      level: p.level,
      mask: clipMask(ctx, p.clip, p.layer, p.frame),
    });
    return {
      layer: layerIdOf(ctx.sprite, p.layer),
      frame: frameIdOf(ctx.sprite, p.frame),
      requested: p.pixels.length,
      painted,
      clipped: p.pixels.length - painted,
    };
  },
});

export const drawLineCommand = defineCommand({
  name: 'draw_line',
  description:
    'Draw a 1px-wide Bresenham line between two pixels, inclusive of both endpoints.',
  params: z.object({
    layer: layerRefSchema,
    frame: frameRefSchema,
    from: pointSchema.describe('Start pixel, inclusive.'),
    to: pointSchema.describe('End pixel, inclusive.'),
    color: nullableColorSchema,
    clip: clipSchema,
    ...ditherOptionsShape,
    ...blendOptionsShape,
  }),
  apply(ctx, p) {
    const buf = celOf(ctx, p.layer, p.frame);
    const painted = drawLine(buf, p.from.x, p.from.y, p.to.x, p.to.y, p.color, {
      blend: p.blend,
      opacity: p.opacity,
      pattern: p.pattern as never,
      level: p.level,
      mask: clipMask(ctx, p.clip, p.layer, p.frame),
    });
    return { painted };
  },
});

export const drawRectCommand = defineCommand({
  name: 'draw_rect',
  description:
    'Draw an axis-aligned rectangle. Set `fill: true` for a solid block, otherwise just the 1px border.',
  params: z.object({
    layer: layerRefSchema,
    frame: frameRefSchema,
    rect: rectSchema,
    color: nullableColorSchema,
    fill: z.boolean().optional().describe('Fill the interior. Defaults to false (border only).'),
    clip: clipSchema,
    ...ditherOptionsShape,
    ...blendOptionsShape,
  }),
  apply(ctx, p) {
    const buf = celOf(ctx, p.layer, p.frame);
    const painted = drawRect(buf, p.rect, p.color, {
      fill: p.fill,
      blend: p.blend,
      opacity: p.opacity,
      pattern: p.pattern as never,
      level: p.level,
      mask: clipMask(ctx, p.clip, p.layer, p.frame),
    });
    return { painted };
  },
});

export const drawEllipseCommand = defineCommand({
  name: 'draw_ellipse',
  description:
    'Draw an ellipse inscribed in the given rect, correct for both odd and even diameters. Set `fill: true` for a solid disc.',
  params: z.object({
    layer: layerRefSchema,
    frame: frameRefSchema,
    rect: rectSchema.describe('Bounding box the ellipse is inscribed in.'),
    color: nullableColorSchema,
    fill: z.boolean().optional(),
    clip: clipSchema,
    ...ditherOptionsShape,
    ...blendOptionsShape,
  }),
  apply(ctx, p) {
    const buf = celOf(ctx, p.layer, p.frame);
    const painted = drawEllipse(buf, p.rect, p.color, {
      fill: p.fill,
      blend: p.blend,
      opacity: p.opacity,
      pattern: p.pattern as never,
      level: p.level,
      mask: clipMask(ctx, p.clip, p.layer, p.frame),
    });
    return { painted };
  },
});

export const drawPolygonCommand = defineCommand({
  name: 'draw_polygon',
  description:
    'Draw a closed polygon through the given points. `fill: true` uses an even-odd scanline fill, which handles concave shapes.',
  params: z.object({
    layer: layerRefSchema,
    frame: frameRefSchema,
    points: z.array(pointSchema).min(2).describe('Vertices in order; the path closes automatically.'),
    color: nullableColorSchema,
    fill: z.boolean().optional(),
    clip: clipSchema,
    ...ditherOptionsShape,
    ...blendOptionsShape,
  }),
  apply(ctx, p) {
    const buf = celOf(ctx, p.layer, p.frame);
    const painted = drawPolygon(buf, p.points, p.color, {
      fill: p.fill,
      blend: p.blend,
      opacity: p.opacity,
      pattern: p.pattern as never,
      level: p.level,
      mask: clipMask(ctx, p.clip, p.layer, p.frame),
    });
    return { painted };
  },
});

export const fillCommand = defineCommand({
  name: 'fill',
  description:
    'Flood fill from a seed pixel. By default only the connected region is filled; set `contiguous: false` to replace every matching pixel in `rect` instead. `tolerance` is a per-channel 0-255 slack.',
  params: z.object({
    layer: layerRefSchema,
    frame: frameRefSchema,
    x: z.number().int().describe('Seed pixel X.'),
    y: z.number().int().describe('Seed pixel Y.'),
    color: nullableColorSchema,
    tolerance: z.number().min(0).max(255).optional().describe('Per-channel tolerance. Defaults to 0 (exact match).'),
    contiguous: z.boolean().optional().describe('Defaults to true.'),
    rect: rectSchema.optional().describe('Constrain the fill to this rect.'),
    clip: clipSchema,
    ...ditherOptionsShape,
    ...blendOptionsShape,
  }),
  apply(ctx, p) {
    const buf = celOf(ctx, p.layer, p.frame);
    const painted = floodFill(buf, p.x, p.y, p.color, {
      tolerance: p.tolerance,
      contiguous: p.contiguous,
      rect: p.rect,
      blend: p.blend,
      opacity: p.opacity,
      pattern: p.pattern as never,
      level: p.level,
      mask: clipMask(ctx, p.clip, p.layer, p.frame),
    });
    return { painted };
  },
});

export const ditherFillCommand = defineCommand({
  name: 'dither_fill',
  description:
    'Fill a region with a named dither pattern. This is the intended way to shade: pick a pattern such as `bayer4` or `checker` and a coverage level instead of emitting individual pixels. Pass `shape: {ellipse}` or `shape: {polygon}` when the band should follow a curve; a plain `rect` (or nothing, for the whole cel) fills a box. Patterns: checker, checker-inv, bayer4, bayer8, dots, sparse, dense, horizontal, vertical, diagonal.',
  params: z.object({
    layer: layerRefSchema,
    frame: frameRefSchema,
    rect: rectSchema.optional().describe('Fill this rect. Omit when using `shape`, or to fill the whole cel.'),
    shape: shapeSchema.optional(),
    color: nullableColorSchema,
    pattern: ditherPatternSchema.describe('Named dither pattern.'),
    level: z.number().min(0).max(1).optional().describe('Coverage 0-1. Defaults to 0.5.'),
    clip: clipSchema,
    ...blendOptionsShape,
  }),
  apply(ctx, p) {
    const buf = celOf(ctx, p.layer, p.frame);
    const shape = p.shape
      ? toShapeSpec(p.shape)
      : ({ kind: 'rect', rect: p.rect ?? fullRect(buf.width, buf.height) } as const);
    const painted = fillShape(buf, shape, p.color, {
      pattern: p.pattern as never,
      level: p.level,
      blend: p.blend,
      opacity: p.opacity,
      mask: clipMask(ctx, p.clip, p.layer, p.frame),
    });
    return { painted, pattern: p.pattern, level: p.level ?? 0.5, kind: shape.kind };
  },
});

export const outlineCommand = defineCommand({
  name: 'outline',
  description:
    'Trace a silhouette. `scope: "cel"` (default) traces what is already drawn on this layer; `scope: "composite"` traces the whole frame as the other layers define it, so a contour can be drawn onto its own layer. `outside` grows the shape (the usual pixel art outline), `inside` eats into it, `both` does both.',
  params: z.object({
    layer: layerRefSchema,
    frame: frameRefSchema,
    color: nullableColorSchema,
    scope: z
      .enum(['cel', 'composite'])
      .optional()
      .describe('What to trace: this layer (`cel`, default) or the whole frame (`composite`).'),
    mode: z.enum(['outside', 'inside', 'both']).optional().describe('Defaults to `outside`.'),
    diagonal: z.boolean().optional().describe('Use 8-connected neighbours. Defaults to false.'),
    rect: rectSchema.optional().describe('Limit outlining to this rect.'),
    clip: clipSchema,
    ...blendOptionsShape,
  }),
  apply(ctx, p) {
    const buf = celOf(ctx, p.layer, p.frame);
    const frameId = frameIdOf(ctx.sprite, p.frame);
    const source =
      p.scope === 'composite' ? frameMask(ctx.sprite, frameId, { excludeLayerId: layerIdOf(ctx.sprite, p.layer) }) : null;
    const painted = outline(buf, p.color, {
      mode: p.mode,
      diagonal: p.diagonal,
      rect: p.rect,
      source,
      blend: p.blend,
      opacity: p.opacity,
      mask: clipMask(ctx, p.clip, p.layer, p.frame),
    });
    return { painted, scope: p.scope ?? 'cel' };
  },
});

export const replaceColorCommand = defineCommand({
  name: 'replace_color',
  description:
    'Swap one colour for another across a region. Pass `to: null` to erase every matching pixel. Useful for palette swaps and for pulling stray colours back onto the ramp.',
  params: z.object({
    layer: layerRefSchema,
    frame: frameRefSchema,
    from: colorSchema.describe('Colour to find.'),
    to: nullableColorSchema.describe('Replacement colour, or null to erase.'),
    rect: rectSchema.optional(),
    tolerance: z.number().min(0).max(255).optional(),
    clip: clipSchema,
    ...blendOptionsShape,
  }),
  apply(ctx, p) {
    const buf = celOf(ctx, p.layer, p.frame);
    const painted = replaceColor(buf, p.from, p.to, {
      rect: p.rect,
      tolerance: p.tolerance,
      blend: p.blend,
      opacity: p.opacity,
      mask: clipMask(ctx, p.clip, p.layer, p.frame),
    });
    return { painted };
  },
});

export const clearRegionCommand = defineCommand({
  name: 'clear_region',
  description: 'Erase a rect back to full transparency. Omit `rect` to erase the whole cel.',
  params: z.object({
    layer: layerRefSchema,
    frame: frameRefSchema,
    rect: rectSchema.optional().describe('Omit to clear the entire cel.'),
    clip: clipSchema,
  }),
  apply(ctx, p) {
    const buf = celOf(ctx, p.layer, p.frame);
    const mask = clipMask(ctx, p.clip, p.layer, p.frame);
    if (!mask) return { cleared: clearRegion(buf, p.rect) };
    // Erasing is a write like any other, so it respects the clip too.
    let cleared = 0;
    const rect = p.rect ? clipRect(p.rect, buf.width, buf.height) : fullRect(buf.width, buf.height);
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        if (mask[y * buf.width + x] === 0) continue;
        const i = buf.index(x, y);
        if (buf.data[i + 3] === 0 && buf.data[i] === 0 && buf.data[i + 1] === 0 && buf.data[i + 2] === 0) continue;
        buf.data[i] = 0;
        buf.data[i + 1] = 0;
        buf.data[i + 2] = 0;
        buf.data[i + 3] = 0;
        cleared++;
      }
    }
    return { cleared };
  },
});

export const copyRegionCommand = defineCommand({
  name: 'copy_region',
  description:
    'Copy a rect from one cel onto another position (optionally on a different layer or frame). Reads from a snapshot of the source, so overlapping source and destination is safe.',
  params: z.object({
    from: z.object({ layer: layerRefSchema, frame: frameRefSchema, rect: rectSchema }).strict(),
    to: z
      .object({
        layer: layerRefSchema,
        frame: frameRefSchema,
        x: z.number().int().describe('Destination X of the region top-left.'),
        y: z.number().int().describe('Destination Y of the region top-left.'),
      })
      .strict(),
    eraseSource: z.boolean().optional().describe('Clear the source rect afterwards. Defaults to false.'),
    ...blendOptionsShape,
  }),
  apply(ctx, p) {
    const source = celOf(ctx, p.from.layer, p.from.frame, false);
    if (!source) return { copied: 0, reason: 'source cel is empty' };
    const patch = extractRegion(source, p.from.rect);
    const target = celOf(ctx, p.to.layer, p.to.frame);
    for (let y = 0; y < patch.height; y++) {
      for (let x = 0; x < patch.width; x++) {
        const si = patch.index(x, y);
        const a = patch.data[si + 3];
        if (a === 0 && !p.eraseSource) continue;
        const tx = p.to.x + x;
        const ty = p.to.y + y;
        if (tx < 0 || ty < 0 || tx >= target.width || ty >= target.height) continue;
        if (a === 0) continue;
        const di = target.index(tx, ty);
        const r = patch.data[si];
        const g = patch.data[si + 1];
        const b = patch.data[si + 2];
        if (p.blend || p.opacity !== undefined) {
          blendInto(target.data, di, { r, g, b, a }, { blend: p.blend, opacity: p.opacity });
        } else {
          target.data[di] = r;
          target.data[di + 1] = g;
          target.data[di + 2] = b;
          target.data[di + 3] = a;
        }
      }
    }
    if (p.eraseSource) {
      const srcBuf = celOf(ctx, p.from.layer, p.from.frame, false);
      if (srcBuf) clearRegion(srcBuf, p.from.rect);
    }
    return { copied: patch.width * patch.height };
  },
});

export const measureRegionCommand = defineCommand({
  name: 'measure_region',
  description:
    'Read-only statistics: opaque pixel count and the tight bounding box of the artwork. `scope: "cel"` (default) measures this layer; `scope: "composite"` measures the whole frame as it renders. Use this to verify a drawing without fetching the image.',
  readOnly: true,
  params: z.object({
    layer: layerRefSchema,
    frame: frameRefSchema,
    rect: rectSchema.optional(),
    scope: z
      .enum(['cel', 'composite'])
      .optional()
      .describe('Measure this layer (`cel`, default) or the whole frame (`composite`).'),
  }),
  apply(ctx, p) {
    if (p.scope === 'composite') {
      const frameId = frameIdOf(ctx.sprite, p.frame);
      const buf = compositeFrame(ctx.sprite, frameId);
      return {
        opaque: countOpaque(buf, p.rect),
        bounds: buf.opaqueBounds(),
        empty: buf.isEmpty(),
        scope: 'composite',
      };
    }
    const buf = celOf(ctx, p.layer, p.frame, false);
    if (!buf) return { opaque: 0, bounds: null, empty: true, scope: 'cel' };
    return {
      opaque: countOpaque(buf, p.rect),
      bounds: buf.opaqueBounds(),
      empty: buf.isEmpty(),
      scope: 'cel',
    };
  },
});
