import { z } from 'zod';
import { blendInto } from '../blend.js';
import { base64ByteLength, decodeBase64 } from '../binary.js';
import { clipRect, fullRect } from '../geometry.js';
import { frameMask, compositeFrame } from '../render.js';
import {
  antialias,
  clearRegion,
  countOpaque,
  despeckle,
  drawEllipse,
  drawLine,
  drawPolygon,
  drawPixels,
  putPixels,
  drawRect,
  extractRegion,
  fillShape,
  floodFill,
  maskFromBuffer,
  outline,
  replaceColor,
  type DrawOptions,
} from '../raster.js';
import {
  base64DataSchema,
  blendOptionsShape,
  celOf,
  clipMask,
  clipSchema,
  clipWarning,
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
  positiveRectSchema,
  rectSchema,
  resolveColor,
  shapeSchema,
  toShapeSpec,
} from './types.js';
import type { ColorInput } from '../types.js';

/**
 * Drawing commands.
 *
 * Every one of these clips silently and reports how many pixels it actually touched,
 * so an agent that gets a coordinate slightly wrong gets a sensible result plus feedback
 * rather than an exception.
 */

/**
 * Run an erase pass then the paint pass, for `replace: true`.
 *
 * The erase pass reuses the exact same geometry as the paint pass, so only the pixels
 * the shape is about to cover are cleared — never the transparent corners of its
 * bounding box. `pattern`/`level` are dropped for the erase so the whole shape clears
 * rather than just the stippled pixels.
 */
function withReplace(
  replace: boolean | undefined,
  paint: (color: ColorInput | null, opts: DrawOptions) => number,
  color: ColorInput | null,
  opts: DrawOptions,
): { painted: number; replaced: number } {
  let replaced = 0;
  if (replace) replaced = paint(null, { ...opts, pattern: undefined, level: undefined });
  const painted = paint(color, opts);
  return { painted, replaced };
}

export const drawPixelsCommand = defineCommand({
  name: 'draw_pixels',
  description:
    'Write an explicit list of pixels. There is no top-level `color`: every entry in `pixels` carries its own `{x, y, color}`, and `color: null` erases that pixel. Non-integer coordinates are rounded to the nearest pixel and the first three rounded samples are returned in the summary. Coordinates outside the canvas are ignored. Use this for precise, hand-authored detail; prefer the shape and dither commands for anything regular.',
  params: z.object({
    layer: layerRefSchema,
    frame: frameRefSchema,
    pixels: z
      .array(
        // Strict, like the top level: a mistyped per-pixel key has to be an error,
        // not a silently dropped property.
        z
          .object({
            x: z.number().describe('X coordinate; rounded to the nearest pixel when fractional.'),
            y: z.number().describe('Y coordinate; rounded to the nearest pixel when fractional.'),
            color: nullableColorSchema.describe('Colour to write, or null to erase.'),
          })
          .strict(),
      )
      .describe(
        'Sparse pixel list, each `{x, y, color}`. Only the listed pixels are touched. There is no shared top-level colour.',
      ),
    clip: clipSchema,
    ...ditherOptionsShape,
    ...blendOptionsShape,
  }),
  apply(ctx, p) {
    const buf = celOf(ctx, p.layer, p.frame);
    let rounded = 0;
    const roundedSamples: Array<{ index: number; x: number; y: number; value: { x: number; y: number } }> = [];
    const pixels = p.pixels.map((px, index) => {
      const x = Math.round(px.x);
      const y = Math.round(px.y);
      if (x !== px.x || y !== px.y) {
        rounded++;
        if (roundedSamples.length < 3) roundedSamples.push({ index, x: px.x, y: px.y, value: { x, y } });
      }
      return { x, y, color: resolveColor(ctx.sprite, px.color) };
    });
    const painted = drawPixels(buf, pixels, {
      blend: p.blend,
      opacity: p.opacity,
      pattern: p.pattern as never,
      level: p.level,
      mask: clipMask(ctx, p.clip, p.layer, p.frame),
    });
    const clipSummary = clipWarning(ctx, p.clip, p.layer);
    const roundedWarning = rounded > 0
      ? `Rounded ${rounded} non-integer pixel coordinate(s); first samples: ${JSON.stringify(roundedSamples)}`
      : undefined;
    return {
      layer: layerIdOf(ctx.sprite, p.layer),
      frame: frameIdOf(ctx.sprite, p.frame),
      requested: p.pixels.length,
      painted,
      clipped: p.pixels.length - painted,
      rounded,
      roundedSamples,
      ...clipSummary,
      ...(roundedWarning ? { warning: [clipSummary.warning, roundedWarning].filter(Boolean).join('; ') } : {}),
    };
  },
});

export const putPixelsCommand = defineCommand({
  name: 'put_pixels',
  description:
    'Write a rectangular RGBA8888 buffer supplied as base64. This is the compact bulk path for large generated fields: one payload, one command, one undo step, instead of tens of thousands of `{x,y,color}` objects. Data is row-major RGBA bytes; the decoded length must equal `rect.w * rect.h * 4`. Set `clearTransparent: true` when zero-alpha samples should erase rather than be ignored.',
  params: z.object({
    layer: layerRefSchema,
    frame: frameRefSchema,
    rect: positiveRectSchema.describe('Destination rectangle in canvas pixels (1-4096 per side).'),
    data: base64DataSchema.describe('Base64-encoded row-major RGBA8888 bytes.'),
    clearTransparent: z.boolean().optional().describe('Erase destination pixels whose source alpha is zero. Defaults to false.'),
    clip: clipSchema,
    ...blendOptionsShape,
  }),
  apply(ctx, p) {
    if (p.rect.w <= 0 || p.rect.h <= 0) {
      throw new Error(`put_pixels rect must have positive width and height, got ${p.rect.w}x${p.rect.h}`);
    }
    const pixelCount = p.rect.w * p.rect.h;
    if (!Number.isSafeInteger(pixelCount) || pixelCount > 4096 * 4096) {
      throw new Error(`Invalid put_pixels rect: ${p.rect.w}x${p.rect.h} is too large`);
    }
    const expected = pixelCount * 4;
    const decodedLength = base64ByteLength(p.data);
    if (decodedLength !== expected) {
      throw new Error(
        `put_pixels data length mismatch: expected ${expected} RGBA bytes for ${p.rect.w}x${p.rect.h}, decoded ${decodedLength}`,
      );
    }
    const bytes = decodeBase64(p.data);

    const buf = celOf(ctx, p.layer, p.frame);
    const result = putPixels(buf, p.rect, bytes, {
      blend: p.blend,
      opacity: p.opacity,
      mask: clipMask(ctx, p.clip, p.layer, p.frame),
      clearTransparent: p.clearTransparent,
      mapColor: (color) => resolveColor(ctx.sprite, color),
    });
    return {
      layer: layerIdOf(ctx.sprite, p.layer),
      frame: frameIdOf(ctx.sprite, p.frame),
      bytes: bytes.length,
      expectedBytes: expected,
      ...result,
      ...clipWarning(ctx, p.clip, p.layer),
    };
  },
});

export const drawLineCommand = defineCommand({
  name: 'draw_line',
  description:
    'Draw a Bresenham line between two pixels, inclusive of both endpoints. Defaults to 1px wide; set `width` for a thicker stroke (limbs, staffs, poles).',
  params: z.object({
    layer: layerRefSchema,
    frame: frameRefSchema,
    from: pointSchema.describe('Start pixel, inclusive.'),
    to: pointSchema.describe('End pixel, inclusive.'),
    color: nullableColorSchema,
    width: z.number().int().min(1).max(64).optional().describe('Stroke thickness in pixels. Defaults to 1.'),
    clip: clipSchema,
    ...ditherOptionsShape,
    ...blendOptionsShape,
  }),
  apply(ctx, p) {
    const buf = celOf(ctx, p.layer, p.frame);
    const painted = drawLine(buf, p.from.x, p.from.y, p.to.x, p.to.y, resolveColor(ctx.sprite, p.color), {
      width: p.width,
      blend: p.blend,
      opacity: p.opacity,
      pattern: p.pattern as never,
      level: p.level,
      mask: clipMask(ctx, p.clip, p.layer, p.frame),
    });
    return { painted, width: p.width ?? 1, ...clipWarning(ctx, p.clip, p.layer) };
  },
});

export const drawRectCommand = defineCommand({
  name: 'draw_rect',
  description:
    'Draw an axis-aligned rectangle. Set `fill: true` for a solid block, otherwise just the 1px border. `replace: true` erases the pixels this shape covers before drawing, so the result is not layered over what was already there.',
  params: z.object({
    layer: layerRefSchema,
    frame: frameRefSchema,
    rect: rectSchema,
    color: nullableColorSchema,
    fill: z.boolean().optional().describe('Fill the interior. Defaults to false (border only).'),
    replace: z.boolean().optional().describe('Erase the pixels this shape covers before drawing. Defaults to false.'),
    clip: clipSchema,
    ...ditherOptionsShape,
    ...blendOptionsShape,
  }),
  apply(ctx, p) {
    const buf = celOf(ctx, p.layer, p.frame);
    const { painted, replaced } = withReplace(
      p.replace,
      (color, opts) => drawRect(buf, p.rect, color, { ...opts, fill: p.fill }),
      resolveColor(ctx.sprite, p.color),
      {
        blend: p.blend,
        opacity: p.opacity,
        pattern: p.pattern as never,
        level: p.level,
        mask: clipMask(ctx, p.clip, p.layer, p.frame),
      },
    );
    return { painted, replaced, ...clipWarning(ctx, p.clip, p.layer) };
  },
});

export const drawEllipseCommand = defineCommand({
  name: 'draw_ellipse',
  description:
    'Draw an ellipse inscribed in the given rect, correct for both odd and even diameters. It is filled by default; pass `fill: false` for an outline. `replace: true` erases the pixels this shape covers first.',
  params: z.object({
    layer: layerRefSchema,
    frame: frameRefSchema,
    rect: rectSchema.describe('Bounding box the ellipse is inscribed in.'),
    color: nullableColorSchema,
    fill: z.boolean().optional().describe('Fill the ellipse. Defaults to true; pass false for an outline.'),
    replace: z.boolean().optional().describe('Erase the pixels this shape covers before drawing. Defaults to false.'),
    clip: clipSchema,
    ...ditherOptionsShape,
    ...blendOptionsShape,
  }),
  apply(ctx, p) {
    const buf = celOf(ctx, p.layer, p.frame);
    const { painted, replaced } = withReplace(
      p.replace,
      (color, opts) => drawEllipse(buf, p.rect, color, { ...opts, fill: p.fill ?? true }),
      resolveColor(ctx.sprite, p.color),
      {
        blend: p.blend,
        opacity: p.opacity,
        pattern: p.pattern as never,
        level: p.level,
        mask: clipMask(ctx, p.clip, p.layer, p.frame),
      },
    );
    return { painted, replaced, ...clipWarning(ctx, p.clip, p.layer) };
  },
});

export const drawPolygonCommand = defineCommand({
  name: 'draw_polygon',
  description:
    'Draw a closed polygon through the given points. `fill: true` uses an even-odd scanline fill, which handles concave shapes. `replace: true` erases the pixels this shape covers first.',
  params: z.object({
    layer: layerRefSchema,
    frame: frameRefSchema,
    points: z.array(pointSchema).min(2).describe('Vertices in order; the path closes automatically.'),
    color: nullableColorSchema,
    fill: z.boolean().optional(),
    replace: z.boolean().optional().describe('Erase the pixels this shape covers before drawing. Defaults to false.'),
    clip: clipSchema,
    ...ditherOptionsShape,
    ...blendOptionsShape,
  }),
  apply(ctx, p) {
    const buf = celOf(ctx, p.layer, p.frame);
    const { painted, replaced } = withReplace(
      p.replace,
      (color, opts) => drawPolygon(buf, p.points, color, { ...opts, fill: p.fill }),
      resolveColor(ctx.sprite, p.color),
      {
        blend: p.blend,
        opacity: p.opacity,
        pattern: p.pattern as never,
        level: p.level,
        mask: clipMask(ctx, p.clip, p.layer, p.frame),
      },
    );
    return { painted, replaced, ...clipWarning(ctx, p.clip, p.layer) };
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
    const painted = floodFill(buf, p.x, p.y, resolveColor(ctx.sprite, p.color), {
      tolerance: p.tolerance,
      contiguous: p.contiguous,
      rect: p.rect,
      blend: p.blend,
      opacity: p.opacity,
      pattern: p.pattern as never,
      level: p.level,
      mask: clipMask(ctx, p.clip, p.layer, p.frame),
    });
    return { painted, ...clipWarning(ctx, p.clip, p.layer) };
  },
});

export const ditherFillCommand = defineCommand({
  name: 'dither_fill',
  description:
    'Fill a region with a named dither pattern. This is the intended way to shade: pick a pattern such as `bayer4` or `checker` and a coverage level instead of emitting individual pixels. Pass `shape: {ellipse}` or `shape: {polygon}` when the band should follow a curve; a plain `rect` (or nothing, for the whole cel) fills a box. `replace: true` clears the pixels this region covers solid first, then stipples them. Patterns: checker, checker-inv, bayer4, bayer8, dots, sparse, dense, horizontal, vertical, diagonal.',
  params: z.object({
    layer: layerRefSchema,
    frame: frameRefSchema,
    rect: rectSchema.optional().describe('Fill this rect. Omit when using `shape`, or to fill the whole cel.'),
    shape: shapeSchema.optional(),
    color: nullableColorSchema,
    pattern: ditherPatternSchema.describe('Named dither pattern.'),
    level: z.number().min(0).max(1).optional().describe('Coverage 0-1. Defaults to 0.5.'),
    replace: z.boolean().optional().describe('Clear the pixels this region covers before stippling. Defaults to false.'),
    clip: clipSchema,
    ...blendOptionsShape,
  }),
  apply(ctx, p) {
    const buf = celOf(ctx, p.layer, p.frame);
    const shape = p.shape
      ? toShapeSpec(p.shape)
      : ({ kind: 'rect', rect: p.rect ?? fullRect(buf.width, buf.height) } as const);
    const { painted, replaced } = withReplace(
      p.replace,
      (color, opts) => fillShape(buf, shape, color, opts),
      resolveColor(ctx.sprite, p.color),
      {
        pattern: p.pattern as never,
        level: p.level,
        blend: p.blend,
        opacity: p.opacity,
        mask: clipMask(ctx, p.clip, p.layer, p.frame),
      },
    );
    return { painted, replaced, pattern: p.pattern, level: p.level ?? 0.5, kind: shape.kind, ...clipWarning(ctx, p.clip, p.layer) };
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
    alphaThreshold: z
      .number()
      .min(0)
      .max(255)
      .optional()
      .describe(
        'Ignore pixels below this alpha (0-255) when tracing. Raise it to skip faint glows or semi-transparent wisps; the default treats any non-zero pixel as solid.',
      ),
    rect: rectSchema.optional().describe('Limit outlining to this rect.'),
    clip: clipSchema,
    ...blendOptionsShape,
  }),
  apply(ctx, p) {
    const buf = celOf(ctx, p.layer, p.frame);
    const frameId = frameIdOf(ctx.sprite, p.frame);
    const source =
      p.scope === 'composite'
        ? frameMask(ctx.sprite, frameId, {
            excludeLayerId: layerIdOf(ctx.sprite, p.layer),
            alphaThreshold: p.alphaThreshold,
          })
        : p.alphaThreshold === undefined
          ? null
          : maskFromBuffer(buf, { alphaThreshold: p.alphaThreshold });
    const painted = outline(buf, resolveColor(ctx.sprite, p.color), {
      mode: p.mode,
      diagonal: p.diagonal,
      rect: p.rect,
      source,
      blend: p.blend,
      opacity: p.opacity,
      mask: clipMask(ctx, p.clip, p.layer, p.frame),
    });
    return { painted, scope: p.scope ?? 'cel', ...clipWarning(ctx, p.clip, p.layer) };
  },
});

export const antialiasCommand = defineCommand({
  name: 'antialias',
  description:
    'Soften the harsh staircase edges of a cel without blurring flat areas. `mode: "silhouette"` anti-aliases the outline against transparency, `"internal"` softens hard colour steps between solid regions, and `"both"` (default) does both. Use `amount` 0-1 (default 0.5), `passes` 1-4 for a wider transition, and `rect` to keep it local. Honours `paletteLocked`, so generated mid-tones snap back to the palette.',
  params: z.object({
    layer: layerRefSchema,
    frame: frameRefSchema,
    mode: z.enum(['silhouette', 'internal', 'both']).optional().describe('Defaults to `both`.'),
    amount: z.number().min(0).max(1).optional().describe('Blend strength. Defaults to 0.5.'),
    passes: z.number().int().min(1).max(4).optional().describe('Repeated softening passes. Defaults to 1.'),
    threshold: z
      .number()
      .min(0)
      .max(255)
      .optional()
      .describe('Minimum colour distance before an internal edge is softened. Defaults to 32.'),
    alphaThreshold: z
      .number()
      .int()
      .min(1)
      .max(255)
      .optional()
      .describe('Alpha at or above this counts as solid. Defaults to 1.'),
    rect: rectSchema.optional().describe('Limit softening to this rect.'),
  }),
  apply(ctx, p) {
    const buf = celOf(ctx, p.layer, p.frame);
    const result = antialias(buf, {
      mode: p.mode,
      amount: p.amount,
      passes: p.passes,
      threshold: p.threshold,
      alphaThreshold: p.alphaThreshold,
      rect: p.rect,
      snap: (color) => resolveColor(ctx.sprite, color),
    });
    return {
      layer: layerIdOf(ctx.sprite, p.layer),
      frame: frameIdOf(ctx.sprite, p.frame),
      ...result,
    };
  },
});

export const despeckleCommand = defineCommand({
  name: 'despeckle',
  description:
    'Remove the single-pixel noise that makes pixel art look digital/harsh. `mode: "remove-isolated"` erases solid pixels with too few solid neighbours, `"merge-outliers"` recolours a lone pixel whose colour is far from its local neighbourhood, and `"both"` (default) does both. `minClusterSize` protects intentional pointillism or small same-colour clusters. Pair it with `antialias` for a softer result; use `rect` to keep the cleanup local.',
  params: z.object({
    layer: layerRefSchema,
    frame: frameRefSchema,
    mode: z
      .enum(['remove-isolated', 'merge-outliers', 'both'])
      .optional()
      .describe('Defaults to `both`.'),
    minNeighbors: z
      .number()
      .int()
      .min(0)
      .max(8)
      .optional()
      .describe('Remove a solid pixel with fewer than this many solid 8-neighbours. Defaults to 1.'),
    minClusterSize: z
      .number()
      .int()
      .min(1)
      .max(64)
      .optional()
      .describe('Preserve same-colour clusters at least this large. Defaults to 1; use 2–4 to protect pointillism.'),
    threshold: z
      .number()
      .min(0)
      .max(255)
      .optional()
      .describe('Colour distance above which a pixel is an outlier. Defaults to 32.'),
    alphaThreshold: z
      .number()
      .int()
      .min(1)
      .max(255)
      .optional()
      .describe('Alpha at or above this counts as solid. Defaults to 1.'),
    rect: rectSchema.optional().describe('Limit cleanup to this rect.'),
  }),
  apply(ctx, p) {
    const buf = celOf(ctx, p.layer, p.frame);
    const result = despeckle(buf, {
      mode: p.mode,
      minNeighbors: p.minNeighbors,
      minClusterSize: p.minClusterSize,
      threshold: p.threshold,
      alphaThreshold: p.alphaThreshold,
      rect: p.rect,
      snap: (color) => resolveColor(ctx.sprite, color),
    });
    return {
      layer: layerIdOf(ctx.sprite, p.layer),
      frame: frameIdOf(ctx.sprite, p.frame),
      ...result,
    };
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
    const painted = replaceColor(buf, resolveColor(ctx.sprite, p.from), resolveColor(ctx.sprite, p.to), {
      rect: p.rect,
      tolerance: p.tolerance,
      blend: p.blend,
      opacity: p.opacity,
      mask: clipMask(ctx, p.clip, p.layer, p.frame),
    });
    return { painted, ...clipWarning(ctx, p.clip, p.layer) };
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
    if (!mask) return { cleared: clearRegion(buf, p.rect), ...clipWarning(ctx, p.clip, p.layer) };
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
    return { cleared, ...clipWarning(ctx, p.clip, p.layer) };
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
