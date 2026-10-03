import { z } from 'zod';
import { CommandError } from '../bus.js';
import { putPixel, type DrawOptions } from '../raster.js';
import { SvgUnsupportedError, traceSvg, type SvgTraceOptions } from '../svgtrace.js';
import {
  blendOptionsShape,
  celOf,
  clipMask,
  clipSchema,
  clipWarning,
  defineCommand,
  ditherOptionsShape,
  frameRefSchema,
  layerRefSchema,
  nullableColorSchema,
  pointSchema,
  rectSchema,
  resolveColor,
} from './types.js';
import type { PixelBuffer } from '../buffer.js';
import type { Color, Point } from '../types.js';

/**
 * SVG trace import.
 *
 * `trace_svg` is the road from a vector outline to a cel: it reads a flat filled SVG,
 * scan-converts it onto the pixel grid and paints each shape with its own colour. It is a
 * separate command from `import_image` because the asset here is *vector* — a PNG import
 * cannot recover the geometry, and a traced outline lands on the grid exactly instead of
 * being resampled.
 */

const MAX_SVG_LENGTH = 4 * 1024 * 1024;

export const traceSvgCommand = defineCommand({
  name: 'trace_svg',
  description:
    'Trace filled SVG outlines into this cel as pixels. Give it the SVG source; it flattens `path`/`rect`/`circle`/`ellipse`/`polygon`/`polyline` geometry onto the pixel grid (holes included) and paints each shape with its own `fill`, honouring `paletteLocked`. `scale` is SVG units per pixel and `offset` is where SVG (0,0) lands. Coverage is hard-edged: no antialiasing, run `antialias` afterwards if you want it. Transforms and paint servers are refused rather than approximated. Undoable as one step.',
  guide:
    '## Coordinate mapping\n\n' +
    'One SVG user unit is `scale` pixels, and SVG (0,0) lands on pixel `offset`. A 512-unit\n' +
    'wide icon drawn into a 32px cel is `scale: 16`. `tolerance` (default 0.1) is the\n' +
    'flatness error of curve flattening, in pixels: lower it for a large traced shape.\n\n' +
    '## What is traced\n\n' +
    '`path` (every command in the SVG grammar, arcs included), `rect` with `rx`/`ry`,\n' +
    '`circle`, `ellipse`, `polygon`, `polyline`. Fill colour comes from `fill` or a\n' +
    '`fill:` declaration in `style`; an absent `fill` is black, as in SVG. A hole is a\n' +
    'reversed inner subpath and comes out hollow under both fill rules.\n\n' +
    '## What is not\n\n' +
    'Refused outright, because tracing untransformed geometry would put the artwork in\n' +
    'the wrong place without saying so: any element with a `transform`, any `<g>` with an\n' +
    'inherited `fill`, and `fill: url(#gradient)`. Flatten an export first, or pass\n' +
    '`color` to paint the whole trace in one colour.\n\n' +
    'Skipped and named in the summary rather than painted: `line`, `image`, `text`, `use`,\n' +
    '`fill: none` (stroke-only geometry), and malformed attributes. Strokes are never\n' +
    'traced - an SVG outline that is stroke-only produces nothing.\n\n' +
    '## Colour\n\n' +
    'Each shape resolves its own `fill` through the document palette, so a `paletteLocked`\n' +
    'document snaps every traced colour to the nearest swatch. Pass `color` to flatten the\n' +
    'whole trace to one colour, and `replace: true` to clear the traced area first.\n\n' +
    'The result is hard-edged by design: a traced outline is a pixel edge, not a ramp of\n' +
    'intermediate alphas. Run `antialias` on the layer afterwards if the staircase is too\n' +
    'coarse.',
  params: z.object({
    layer: layerRefSchema,
    frame: frameRefSchema,
    svg: z
      .string()
      .min(1)
      .max(MAX_SVG_LENGTH)
      .describe('The SVG source, as text. Inline the markup rather than passing a file path; core has no filesystem.'),
    color: nullableColorSchema
      .optional()
      .describe('Paint every traced shape in this colour instead of each shape\'s own `fill`. Defaults to the SVG\'s own fills.'),
    scale: z
      .number()
      .positive()
      .optional()
      .describe('SVG user units per pixel. 16 means a 512-unit-wide icon lands 32px wide. Defaults to 1.'),
    offset: pointSchema.optional().describe('Pixel position that SVG (0,0) maps to. Defaults to (0,0).'),
    tolerance: z
      .number()
      .positive()
      .optional()
      .describe('Curve-flattening error in pixels. Defaults to 0.1; lower it for a shape much larger than the cel.'),
    rect: rectSchema.optional().describe('Trace only the part of the geometry inside this rect.'),
    replace: z.boolean().optional().describe('Clear the traced pixels before painting them. Defaults to false.'),
    clip: clipSchema,
    ...ditherOptionsShape,
    ...blendOptionsShape,
  }),
  apply(ctx, p) {
    const buf = celOf(ctx, p.layer, p.frame);
    const opts: SvgTraceOptions = {
      scale: p.scale,
      offset: p.offset as Point | undefined,
      tolerance: p.tolerance,
    };
    let traced;
    try {
      traced = traceSvg(p.svg, buf.width, buf.height, opts);
    } catch (error) {
      // Everything traceSvg raises is about the caller's arguments: an unsupported
      // construct, malformed path data, an unparseable colour, a bad scale. They are all
      // `invalid_params`, so an agent can tell "the document refused" from "the SVG is
      // wrong" — which is the whole point of the code on the envelope.
      const reason = error instanceof SvgUnsupportedError ? 'svg_unsupported' : 'svg_malformed';
      throw new CommandError((error as Error).message, 'invalid_params', { reason });
    }

    if (traced.shapes.length === 0) {
      throw new CommandError(
        `No traceable filled geometry in this SVG. Skipped: ${traced.skipped.join('; ') || '(nothing found)'}`,
        'invalid_params',
        { reason: 'svg_empty', skipped: traced.skipped },
      );
    }

    // The clip and the region limit compose into one mask: paint only where both allow.
    let mask = clipMask(ctx, p.clip, p.layer, p.frame);
    if (p.rect) mask = combineMasks(mask, rectMask(p.rect, buf.width, buf.height));

    const override = p.color === undefined ? undefined : resolveColor(ctx.sprite, p.color);
    const drawOpts: DrawOptions = {
      blend: p.blend,
      opacity: p.opacity,
      pattern: p.pattern as never,
      level: p.level,
      mask: mask ?? null,
    };

    let painted = 0;
    let replaced = 0;
    for (let i = 0; i < traced.masks.length; i++) {
      const shapeMask = traced.masks[i];
      // The erase runs over the shape intersected with the clip and the region limit, so
      // `replace` clears exactly what it is about to paint — and no more, even with no
      // clip at all. A replace gated on `mask` being present would silently do nothing
      // on an unclipped call, which is the common case.
      if (p.replace) {
        replaced += paintMask(buf, andMasks(shapeMask, mask), null, drawOpts);
      }
      const color = override ?? resolveColor(ctx.sprite, traced.shapes[i].color);
      painted += paintMask(buf, shapeMask, color, drawOpts);
    }

    return {
      painted,
      replaced,
      shapes: traced.shapes.length,
      bounds: traced.bounds,
      skipped: traced.skipped,
      ...(p.replace && !mask
        ? {
            warning:
              'replace: true cleared the traced pixels on this layer. The layer is not composited with the layers below it, so anything under the trace that was not itself traced is now transparent.',
          }
        : {}),
      ...clipWarning(ctx, p.clip, p.layer),
    };
  },
});

/** Paint every set pixel of `mask`, through `putPixel` so dither and blending compose. */
function paintMask(
  buf: PixelBuffer,
  mask: Uint8Array,
  color: Color | null,
  opts: DrawOptions,
): number {
  let painted = 0;
  for (let y = 0; y < buf.height; y++) {
    const row = y * buf.width;
    for (let x = 0; x < buf.width; x++) {
      if (mask[row + x] && putPixel(buf, x, y, color, opts)) painted++;
    }
  }
  return painted;
}

function rectMask(rect: { x: number; y: number; w: number; h: number }, width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(width, rect.x + rect.w);
  const y1 = Math.min(height, rect.y + rect.h);
  for (let y = y0; y < y1; y++) mask.fill(1, y * width + x0, y * width + x1);
  return mask;
}

/** Intersect two optional masks; `undefined` means "everywhere allowed". */
function combineMasks(a: Uint8Array | undefined, b: Uint8Array): Uint8Array {
  return a ? andMasks(a, b) : b;
}

/** Intersect two masks of the same canvas. */
function andMasks(a: Uint8Array, b: Uint8Array | undefined): Uint8Array {
  if (!b) return a;
  const out = new Uint8Array(Math.min(a.length, b.length));
  for (let i = 0; i < out.length; i++) out[i] = a[i] && b[i] ? 1 : 0;
  return out;
}