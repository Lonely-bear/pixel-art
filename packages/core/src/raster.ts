import { blendInto, type BlendOptions } from './blend.js';
import { PixelBuffer } from './buffer.js';
import { parseColor } from './color.js';
import { ditherMask, type DitherPattern } from './dither.js';
import { clipRect, expandRect, fullRect, normalizeRect, rectContains } from './geometry.js';
import type { Color, ColorInput, Point, Rect } from './types.js';

/**
 * Drawing primitives.
 *
 * Two rules apply to every function here, and they exist because AI agents get
 * coordinates slightly wrong constantly:
 *
 *  1. **Nothing throws on out-of-bounds.** Geometry is clipped and the caller gets a
 *     count of what was actually painted.
 *  2. **`null` means erase.** A colour with `alpha: 0` is a no-op under normal blending,
 *     so erasing must be spelled explicitly rather than inferred.
 */

export type PaintColor = Color | null;

export interface DrawOptions extends BlendOptions {
  /** Treat `null` colours as erase rather than as a no-op. Defaults to true. */
  allowErase?: boolean;
  /**
   * Paint only where this mask is non-zero. One byte per pixel, row-major, the same
   * dimensions as the target buffer.
   *
   * This is what keeps a shadow or a highlight inside the silhouette: without it an
   * ellipse meant to darken a blob also paints the transparent corners of its bounding
   * box, and the only way to avoid that is to hand-place every pixel. See
   * `maskFromBuffer` and `frameMask`.
   */
  mask?: Uint8Array | null;
}

export interface PixelSpec {
  x: number;
  y: number;
  color: ColorInput | null;
}

export interface MaskOptions {
  /** Pixels with alpha at or above this count as opaque. Defaults to 1. */
  alphaThreshold?: number;
}

/** A full-canvas mask with every pixel allowed. */
export function emptyMask(width: number, height: number): Uint8Array {
  return new Uint8Array(Math.max(0, width * height));
}

/** A full-canvas mask with every pixel allowed. */
export function fullMask(width: number, height: number): Uint8Array {
  const mask = new Uint8Array(Math.max(0, width * height));
  mask.fill(1);
  return mask;
}

/**
 * Build a paint mask from a buffer's alpha channel.
 *
 * The mask is one byte per pixel rather than a bit, because the extra 3 bytes buy
 * branch-free indexing and these are small buffers.
 */
export function maskFromBuffer(buf: PixelBuffer, opts: MaskOptions = {}): Uint8Array {
  const threshold = Math.max(1, opts.alphaThreshold ?? 1);
  const mask = new Uint8Array(buf.width * buf.height);
  for (let p = 0; p < mask.length; p++) {
    mask[p] = buf.data[p * 4 + 3] >= threshold ? 1 : 0;
  }
  return mask;
}

/** Intersect two masks. Used to compose a clip with an explicit region. */
export function maskAnd(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.min(a.length, b.length));
  for (let i = 0; i < out.length; i++) out[i] = a[i] && b[i] ? 1 : 0;
  return out;
}

/** Write one pixel. Returns whether the pixel was inside the surface and unmasked. */
export function putPixel(
  buf: PixelBuffer,
  x: number,
  y: number,
  color: PaintColor,
  opts: DrawOptions = {},
): boolean {
  if (x < 0 || y < 0 || x >= buf.width || y >= buf.height) return false;
  // The mask is checked before anything is written, so a masked pixel costs nothing and
  // reports "not painted" exactly like an out-of-bounds one.
  if (opts.mask && opts.mask[y * buf.width + x] === 0) return false;
  const i = buf.index(x, y);
  if (color === null) {
    const d = buf.data;
    d[i] = 0;
    d[i + 1] = 0;
    d[i + 2] = 0;
    d[i + 3] = 0;
    return true;
  }
  blendInto(buf.data, i, color, opts);
  return true;
}

export function drawPixels(
  buf: PixelBuffer,
  pixels: readonly PixelSpec[],
  opts: DrawOptions = {},
): number {
  let painted = 0;
  for (const p of pixels) {
    const color = p.color === null ? null : parseColor(p.color);
    if (putPixel(buf, Math.round(p.x), Math.round(p.y), color, opts)) painted++;
  }
  return painted;
}

export function drawLine(
  buf: PixelBuffer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: ColorInput | null,
  opts: DrawOptions = {},
): number {
  const c = color === null ? null : parseColor(color);
  let x = Math.round(x0);
  let y = Math.round(y0);
  const ex = Math.round(x1);
  const ey = Math.round(y1);
  const dx = Math.abs(ex - x);
  const sx = x < ex ? 1 : -1;
  const dy = -Math.abs(ey - y);
  const sy = y < ey ? 1 : -1;
  let err = dx + dy;
  let painted = 0;
  // The step count is bounded by the Manhattan distance, so this cannot spin forever
  // even if a caller passes absurd coordinates.
  const limit = dx - dy + 2;
  for (let step = 0; step < limit; step++) {
    if (putPixel(buf, x, y, c, opts)) painted++;
    if (x === ex && y === ey) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return painted;
}

export function drawRect(
  buf: PixelBuffer,
  rect: Rect,
  color: ColorInput | null,
  opts: DrawOptions & { fill?: boolean } = {},
): number {
  const c = color === null ? null : parseColor(color);
  const r = clipRect(rect, buf.width, buf.height);
  if (r.w === 0 || r.h === 0) return 0;
  let painted = 0;
  if (opts.fill) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (putPixel(buf, x, y, c, opts)) painted++;
      }
    }
    return painted;
  }
  const x1 = r.x + r.w - 1;
  const y1 = r.y + r.h - 1;
  for (let x = r.x; x <= x1; x++) {
    if (putPixel(buf, x, r.y, c, opts)) painted++;
    if (y1 !== r.y && putPixel(buf, x, y1, c, opts)) painted++;
  }
  for (let y = r.y + 1; y < y1; y++) {
    if (putPixel(buf, r.x, y, c, opts)) painted++;
    if (x1 !== r.x && putPixel(buf, x1, y, c, opts)) painted++;
  }
  return painted;
}

/** Inclusive pixel bounds of a rect, clamped to the surface. */
function bounds(rect: Rect, width: number, height: number) {
  const n = normalizeRect(rect);
  const x0 = Math.max(0, Math.min(width - 1, n.x));
  const y0 = Math.max(0, Math.min(height - 1, n.y));
  const x1 = Math.max(0, Math.min(width - 1, n.x + n.w - 1));
  const y1 = Math.max(0, Math.min(height - 1, n.y + n.h - 1));
  return { x0, y0, x1, y1 };
}

export function drawEllipse(
  buf: PixelBuffer,
  rect: Rect,
  color: ColorInput | null,
  opts: DrawOptions & { fill?: boolean } = {},
): number {
  const c = color === null ? null : parseColor(color);
  const { x0, y0, x1, y1 } = bounds(rect, buf.width, buf.height);
  if (x1 < x0 || y1 < y0) return 0;
  let painted = 0;

  if (opts.fill) {
    const cx = (x0 + x1 + 1) / 2;
    const cy = (y0 + y1 + 1) / 2;
    const rx = (x1 - x0 + 1) / 2;
    const ry = (y1 - y0 + 1) / 2;
    for (let y = y0; y <= y1; y++) {
      const ny = (y + 0.5 - cy) / ry;
      const ny2 = ny * ny;
      for (let x = x0; x <= x1; x++) {
        const nx = (x + 0.5 - cx) / rx;
        if (nx * nx + ny2 <= 1) {
          if (putPixel(buf, x, y, c, opts)) painted++;
        }
      }
    }
    return painted;
  }

  // Zingl's integer midpoint ellipse: correct for both odd and even diameters.
  let a = Math.abs(x1 - x0);
  let b = Math.abs(y1 - y0);
  let b1 = b & 1;
  let dx = 4 * (1 - a) * b * b;
  let dy = 4 * (b1 + 1) * a * a;
  let err = dx + dy + b1 * a * a;
  let e2 = 0;

  let lx = x0;
  let rx = x1;
  let by = y0;
  let ty = y1;

  if (lx > rx) {
    lx = rx;
    rx += a;
  }
  if (by > ty) by = ty;
  by += (b + 1) >> 1;
  ty = by - b1;
  a *= 8 * a;
  b1 = 8 * b * b;

  do {
    if (putPixel(buf, rx, by, c, opts)) painted++;
    if (putPixel(buf, lx, by, c, opts)) painted++;
    if (putPixel(buf, lx, ty, c, opts)) painted++;
    if (putPixel(buf, rx, ty, c, opts)) painted++;
    e2 = 2 * err;
    if (e2 <= dy) {
      by++;
      ty--;
      dy += a;
      err += dy;
    }
    if (e2 >= dx || 2 * err > dy) {
      lx++;
      rx--;
      dx += b1;
      err += dx;
    }
  } while (lx <= rx);

  while (by - ty < b) {
    if (putPixel(buf, lx - 1, by, c, opts)) painted++;
    if (putPixel(buf, rx + 1, by++, c, opts)) painted++;
    if (putPixel(buf, lx - 1, ty, c, opts)) painted++;
    if (putPixel(buf, rx + 1, ty--, c, opts)) painted++;
  }
  return painted;
}

export function drawPolygon(
  buf: PixelBuffer,
  points: readonly Point[],
  color: ColorInput | null,
  opts: DrawOptions & { fill?: boolean } = {},
): number {
  if (points.length === 0) return 0;
  const c = color === null ? null : parseColor(color);
  let painted = 0;

  if (points.length < 3) {
    for (let i = 0; i + 1 < points.length; i++) {
      painted += drawLine(buf, points[i].x, points[i].y, points[i + 1].x, points[i + 1].y, c, opts);
    }
    return painted;
  }

  if (opts.fill) {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const yStart = Math.max(0, Math.floor(minY));
    const yEnd = Math.min(buf.height - 1, Math.ceil(maxY));
    const xs: number[] = [];
    for (let y = yStart; y <= yEnd; y++) {
      const yc = y + 0.5;
      xs.length = 0;
      for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        const ay = a.y + 0.5;
        const by = b.y + 0.5;
        // Half-open crossing rule keeps shared vertices from being counted twice.
        if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) {
          xs.push(a.x + 0.5 + ((yc - ay) / (by - ay)) * (b.x - a.x));
        }
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const from = Math.ceil(xs[i] - 0.5);
        const to = Math.floor(xs[i + 1] - 0.5);
        for (let x = Math.max(0, from); x <= Math.min(buf.width - 1, to); x++) {
          if (putPixel(buf, x, y, c, opts)) painted++;
        }
      }
    }
    return painted;
  }

  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    painted += drawLine(buf, a.x, a.y, b.x, b.y, c, opts);
  }
  return painted;
}

function pixelMatches(
  data: Uint8ClampedArray,
  i: number,
  target: Color,
  tolerance: number,
): boolean {
  if (tolerance <= 0) {
    return (
      data[i] === target.r &&
      data[i + 1] === target.g &&
      data[i + 2] === target.b &&
      data[i + 3] === target.a
    );
  }
  return (
    Math.abs(data[i] - target.r) <= tolerance &&
    Math.abs(data[i + 1] - target.g) <= tolerance &&
    Math.abs(data[i + 2] - target.b) <= tolerance &&
    Math.abs(data[i + 3] - target.a) <= tolerance
  );
}

export interface FloodFillOptions extends DrawOptions {
  /** 0-255 per-channel tolerance. Defaults to 0 (exact match). */
  tolerance?: number;
  /**
   * `true` (default) fills the connected region containing the seed.
   * `false` replaces every matching pixel inside `rect` regardless of connectivity.
   */
  contiguous?: boolean;
  rect?: Rect;
}

export function floodFill(
  buf: PixelBuffer,
  x: number,
  y: number,
  color: ColorInput | null,
  opts: FloodFillOptions = {},
): number {
  const seedX = Math.round(x);
  const seedY = Math.round(y);
  const region = clipRect(opts.rect ?? fullRect(buf.width, buf.height), buf.width, buf.height);
  if (!rectContains(region, seedX, seedY)) return 0;

  const c = color === null ? null : parseColor(color);
  const target = buf.getColor(seedX, seedY);
  const tolerance = opts.tolerance ?? 0;
  const data = buf.data;
  let painted = 0;

  if (opts.contiguous === false) {
    for (let py = region.y; py < region.y + region.h; py++) {
      for (let px = region.x; px < region.x + region.w; px++) {
        const i = buf.index(px, py);
        if (pixelMatches(data, i, target, tolerance)) {
          if (putPixel(buf, px, py, c, opts)) painted++;
        }
      }
    }
    return painted;
  }

  // Explicit visited mask rather than relying on "the colour changed" — with a
  // tolerance the new colour can still match the target, which would loop forever.
  // Pixels are marked on *push*, so each one is enqueued at most once and the stack
  // never needs to be larger than the pixel count.
  const visited = new Uint8Array(buf.width * buf.height);
  const stack = new Int32Array(buf.width * buf.height);
  let top = 0;
  const seed = seedY * buf.width + seedX;
  visited[seed] = 1;
  stack[top++] = seed;

  while (top > 0) {
    const p = stack[--top];
    const i = p * 4;
    if (!pixelMatches(data, i, target, tolerance)) continue;
    const px = p % buf.width;
    const py = (p / buf.width) | 0;
    if (putPixel(buf, px, py, c, opts)) painted++;
    if (px > region.x) push(p - 1);
    if (px < region.x + region.w - 1) push(p + 1);
    if (py > region.y) push(p - buf.width);
    if (py < region.y + region.h - 1) push(p + buf.width);
  }
  return painted;

  function push(q: number): void {
    if (visited[q]) return;
    visited[q] = 1;
    stack[top++] = q;
  }
}

export interface DitherFillOptions extends DrawOptions {
  pattern: DitherPattern;
  /** Coverage 0-1. Defaults to 0.5. */
  level?: number;
  rect?: Rect;
}

/**
 * Fill a rect with a named dither pattern. This is the workhorse for shading — it is
 * far cheaper and far more reliable for a model to ask for `bayer4` at 50% coverage
 * than to emit several hundred correctly-placed pixels.
 */
export function ditherFill(
  buf: PixelBuffer,
  rect: Rect,
  color: ColorInput | null,
  opts: DitherFillOptions,
): number {
  const c = color === null ? null : parseColor(color);
  const r = clipRect(rect, buf.width, buf.height);
  const level = opts.level ?? 0.5;
  let painted = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      if (!ditherMask(opts.pattern, x, y, level)) continue;
      if (putPixel(buf, x, y, c, opts)) painted++;
    }
  }
  return painted;
}

export interface OutlineOptions extends DrawOptions {
  /** `outside` grows the silhouette, `inside` eats into it. Defaults to `outside`. */
  mode?: 'outside' | 'inside' | 'both';
  /** Include diagonal neighbours. Defaults to false (4-connected). */
  diagonal?: boolean;
  rect?: Rect;
  /**
   * Trace this full-canvas mask instead of the buffer's own pixels.
   *
   * This is how `outline` contours a whole sprite rather than a single cel: pass the
   * mask of the composited frame and the outline is written into whichever cel you
   * asked for, so a contour can live on its own layer.
   */
  source?: Uint8Array | null;
}

/**
 * Trace the silhouette of whatever is already drawn.
 *
 * Outlining is a foundational pixel art technique and an extremely common thing to want
 * after generating a shape, so it is a primitive rather than something the caller has to
 * compute from a mask.
 */
export function outline(
  buf: PixelBuffer,
  color: ColorInput | null,
  opts: OutlineOptions = {},
): number {
  const c = color === null ? null : parseColor(color);
  const region = clipRect(opts.rect ?? fullRect(buf.width, buf.height), buf.width, buf.height);
  if (region.w === 0 || region.h === 0) return 0;
  const r = expandRect(region, 1, buf.width, buf.height);
  const diagonal = opts.diagonal ?? false;
  const mode = opts.mode ?? 'outside';

  const mask = new Uint8Array(r.w * r.h);
  if (opts.source) {
    const source = opts.source;
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        mask[y * r.w + x] = source[(r.y + y) * buf.width + (r.x + x)] ? 1 : 0;
      }
    }
  } else {
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        mask[y * r.w + x] = buf.data[buf.index(r.x + x, r.y + y) + 3] > 0 ? 1 : 0;
      }
    }
  }
  const opaqueAt = (x: number, y: number) =>
    x < 0 || y < 0 || x >= r.w || y >= r.h ? 0 : mask[y * r.w + x];

  const offsets: [number, number][] = diagonal
    ? [
        [-1, -1], [0, -1], [1, -1],
        [-1, 0], [1, 0],
        [-1, 1], [0, 1], [1, 1],
      ]
    : [
        [0, -1], [-1, 0], [1, 0], [0, 1],
      ];

  const writes: number[] = [];
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const self = opaqueAt(x, y);
      let neighbourOpaque = false;
      let neighbourEmpty = false;
      for (const [ox, oy] of offsets) {
        if (opaqueAt(x + ox, y + oy)) neighbourOpaque = true;
        else neighbourEmpty = true;
      }
      const isOutsideEdge = self === 0 && neighbourOpaque;
      const isInsideEdge = self === 1 && neighbourEmpty;
      if (
        (mode === 'outside' && isOutsideEdge) ||
        (mode === 'inside' && isInsideEdge) ||
        (mode === 'both' && (isOutsideEdge || isInsideEdge))
      ) {
        writes.push(r.x + x, r.y + y);
      }
    }
  }

  let painted = 0;
  for (let i = 0; i < writes.length; i += 2) {
    if (putPixel(buf, writes[i], writes[i + 1], c, opts)) painted++;
  }
  return painted;
}

export interface ReplaceColorOptions extends DrawOptions {
  rect?: Rect;
  tolerance?: number;
}

/** Swap one colour for another (or erase it, with `to: null`). */
export function replaceColor(
  buf: PixelBuffer,
  from: ColorInput,
  to: ColorInput | null,
  opts: ReplaceColorOptions = {},
): number {
  const source = parseColor(from);
  const c = to === null ? null : parseColor(to);
  const r = clipRect(opts.rect ?? fullRect(buf.width, buf.height), buf.width, buf.height);
  const tolerance = opts.tolerance ?? 0;
  let painted = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      if (!pixelMatches(buf.data, buf.index(x, y), source, tolerance)) continue;
      if (putPixel(buf, x, y, c, opts)) painted++;
    }
  }
  return painted;
}

export function clearRegion(buf: PixelBuffer, rect?: Rect): number {
  const r = clipRect(rect ?? fullRect(buf.width, buf.height), buf.width, buf.height);
  buf.clear(r);
  return r.w * r.h;
}

/** Read a sub-rect as a new buffer (out-of-bounds areas come back transparent). */
export function extractRegion(buf: PixelBuffer, rect: Rect): PixelBuffer {
  const n = normalizeRect(rect);
  const out = new PixelBuffer(Math.max(1, n.w), Math.max(1, n.h));
  out.blitRegion(buf, n, 0, 0);
  return out;
}

/** Count non-transparent pixels inside a rect. */
export function countOpaque(buf: PixelBuffer, rect?: Rect): number {
  const r = clipRect(rect ?? fullRect(buf.width, buf.height), buf.width, buf.height);
  let n = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      if (buf.data[buf.index(x, y) + 3] !== 0) n++;
    }
  }
  return n;
}
