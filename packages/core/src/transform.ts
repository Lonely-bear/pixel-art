import { PixelBuffer } from './buffer.js';
import { normalizeRect } from './geometry.js';
import type { Point, Rect } from './types.js';

/**
 * Buffer-level geometry operations: flip, rotate, crop, resize, scale.
 *
 * These operate on a whole `PixelBuffer` and are applied per-cel by commands, so
 * "flip the sprite" means "flip every cel on every frame" rather than "flip a rendered
 * composite", which would be lossy across layers.
 */

export function flipHorizontal(source: PixelBuffer): PixelBuffer {
  const out = new PixelBuffer(source.width, source.height);
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const si = source.index(x, y);
      const di = out.index(source.width - 1 - x, y);
      out.data[di] = source.data[si];
      out.data[di + 1] = source.data[si + 1];
      out.data[di + 2] = source.data[si + 2];
      out.data[di + 3] = source.data[si + 3];
    }
  }
  return out;
}

export function flipVertical(source: PixelBuffer): PixelBuffer {
  const out = new PixelBuffer(source.width, source.height);
  for (let y = 0; y < source.height; y++) {
    const dy = source.height - 1 - y;
    for (let x = 0; x < source.width; x++) {
      const si = source.index(x, y);
      const di = out.index(x, dy);
      out.data[di] = source.data[si];
      out.data[di + 1] = source.data[si + 1];
      out.data[di + 2] = source.data[si + 2];
      out.data[di + 3] = source.data[si + 3];
    }
  }
  return out;
}

/** Rotate by a multiple of 90 degrees, clockwise. */
export function rotate90(source: PixelBuffer, times = 1): PixelBuffer {
  const turns = ((times % 4) + 4) % 4;
  if (turns === 0) return source.clone();
  if (turns === 2) {
    const out = new PixelBuffer(source.width, source.height);
    for (let y = 0; y < source.height; y++) {
      for (let x = 0; x < source.width; x++) {
        const si = source.index(x, y);
        const di = out.index(source.width - 1 - x, source.height - 1 - y);
        out.data[di] = source.data[si];
        out.data[di + 1] = source.data[si + 1];
        out.data[di + 2] = source.data[si + 2];
        out.data[di + 3] = source.data[si + 3];
      }
    }
    return out;
  }
  // Width and height swap for a quarter turn.
  const out = new PixelBuffer(source.height, source.width);
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const si = source.index(x, y);
      const dx = turns === 1 ? source.height - 1 - y : y;
      const dy = turns === 1 ? x : source.width - 1 - x;
      const di = out.index(dx, dy);
      out.data[di] = source.data[si];
      out.data[di + 1] = source.data[si + 1];
      out.data[di + 2] = source.data[si + 2];
      out.data[di + 3] = source.data[si + 3];
    }
  }
  return out;
}

export interface AffineTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY_TRANSFORM: AffineTransform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function multiplyAffine(parent: AffineTransform, local: AffineTransform): AffineTransform {
  return {
    a: parent.a * local.a + parent.c * local.b,
    b: parent.b * local.a + parent.d * local.b,
    c: parent.a * local.c + parent.c * local.d,
    d: parent.b * local.c + parent.d * local.d,
    e: parent.a * local.e + parent.c * local.f + parent.e,
    f: parent.b * local.e + parent.d * local.f + parent.f,
  };
}

export function affineFromPartTransform(
  transform: { dx?: number; dy?: number; rotationDegrees?: number; scaleX?: number; scaleY?: number } | undefined,
  pivot: { x: number; y: number },
): AffineTransform {
  const dx = transform?.dx ?? 0;
  const dy = transform?.dy ?? 0;
  const rotation = transform?.rotationDegrees ?? 0;
  const scaleX = transform?.scaleX ?? 1;
  const scaleY = transform?.scaleY ?? 1;
  if (![dx, dy, rotation, scaleX, scaleY].every(Number.isFinite) || scaleX <= 0 || scaleY <= 0) {
    throw new Error('Part transforms require finite values and positive scale factors.');
  }
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const a = cos * scaleX;
  const b = sin * scaleX;
  const c = -sin * scaleY;
  const d = cos * scaleY;
  return {
    a,
    b,
    c,
    d,
    e: dx + pivot.x - (a * pivot.x + c * pivot.y),
    f: dy + pivot.y - (b * pivot.x + d * pivot.y),
  };
}

/** Rasterize an affine transform with nearest-neighbour sampling and a fixed output canvas. */
export function transformBufferAffine(
  source: PixelBuffer,
  transform: AffineTransform,
  output: { width?: number; height?: number } = {},
): PixelBuffer {
  const out = PixelBuffer.empty(output.width ?? source.width, output.height ?? source.height);
  const determinant = transform.a * transform.d - transform.b * transform.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    throw new Error('Cannot rasterize a singular or non-finite affine transform.');
  }
  if (![transform.a, transform.b, transform.c, transform.d, transform.e, transform.f].every(Number.isFinite)) {
    throw new Error('Affine transform coefficients must all be finite.');
  }
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const xd = x - transform.e;
      const yd = y - transform.f;
      const rawX = (transform.d * xd - transform.c * yd) / determinant;
      const rawY = (-transform.b * xd + transform.a * yd) / determinant;
      // Range-check the *unrounded* coordinate: Math.round(-0.5) is -0, and `-0 < 0`
      // is false, so a rounded-only check would sample column 0 of an off-canvas
      // mapping. Half a pixel of tolerance is exactly the nearest-neighbour reach.
      if (rawX < -0.5 || rawY < -0.5 || rawX > source.width - 0.5 || rawY > source.height - 0.5) continue;
      const sx = Math.round(rawX);
      const sy = Math.round(rawY);
      if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) continue;
      const si = source.index(sx, sy);
      const alpha = source.data[si + 3];
      if (alpha === 0) continue;
      const di = out.index(x, y);
      out.data[di] = source.data[si];
      out.data[di + 1] = source.data[si + 1];
      out.data[di + 2] = source.data[si + 2];
      out.data[di + 3] = alpha;
    }
  }
  return out;
}

export function transformBufferAbout(
  source: PixelBuffer,
  pivot: { x: number; y: number },
  transform: { dx?: number; dy?: number; rotationDegrees?: number; scaleX?: number; scaleY?: number },
): PixelBuffer {
  return transformBufferAffine(source, affineFromPartTransform(transform, pivot));
}

/** Crop to a rect. Out-of-bounds areas come back transparent. */
export function crop(source: PixelBuffer, rect: Rect): PixelBuffer {
  const n = normalizeRect(rect);
  const out = new PixelBuffer(Math.max(1, n.w), Math.max(1, n.h));
  out.blitRegion(source, n, 0, 0);
  return out;
}

/**
 * Place the existing pixels inside a differently sized surface at `offset`.
 * Used by canvas-resize; content outside the new bounds is dropped.
 */
export function resizeCanvas(source: PixelBuffer, width: number, height: number, offsetX = 0, offsetY = 0): PixelBuffer {
  const out = new PixelBuffer(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)));
  out.blit(source, Math.round(offsetX), Math.round(offsetY));
  return out;
}

/** Nearest-neighbour scale. Integer factors only — anything else is not pixel art. */
export function scaleNearest(source: PixelBuffer, factorX: number, factorY = factorX): PixelBuffer {
  if (!Number.isInteger(factorX) || !Number.isInteger(factorY) || factorX < 1 || factorY < 1) {
    throw new RangeError('scale factors must be positive integers');
  }
  const out = new PixelBuffer(source.width * factorX, source.height * factorY);
  for (let y = 0; y < out.height; y++) {
    const sy = (y / factorY) | 0;
    for (let x = 0; x < out.width; x++) {
      const sx = (x / factorX) | 0;
      const si = source.index(sx, sy);
      const di = out.index(x, y);
      out.data[di] = source.data[si];
      out.data[di + 1] = source.data[si + 1];
      out.data[di + 2] = source.data[si + 2];
      out.data[di + 3] = source.data[si + 3];
    }
  }
  return out;
}

/**
 * Shift the contents by whole pixels, leaving the vacated band transparent.
 *
 * A 1px nudge used to cost a `copy_region` plus a `clear_region` per layer per frame;
 * for a 3-frame bob over 4 layers that is 24 operations to say "move it down one".
 */
export function translate(source: PixelBuffer, dx: number, dy: number): PixelBuffer {
  return resizeCanvas(source, source.width, source.height, dx, dy);
}

export type NamedPivot =
  | 'center'
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

/** Where a named pivot sits inside a bounding box, in pixel coordinates. */
export function resolvePivot(ref: NamedPivot, bounds: Rect): Point {
  const { x, y, w, h } = bounds;
  const cx = x + (w - 1) / 2;
  const cy = y + (h - 1) / 2;
  switch (ref) {
    case 'center':
      return { x: cx, y: cy };
    case 'top':
      return { x: cx, y };
    case 'bottom':
      return { x: cx, y: y + h - 1 };
    case 'left':
      return { x, y: cy };
    case 'right':
      return { x: x + w - 1, y: cy };
    case 'top-left':
      return { x, y };
    case 'top-right':
      return { x: x + w - 1, y };
    case 'bottom-left':
      return { x, y: y + h - 1 };
    case 'bottom-right':
      return { x: x + w - 1, y: y + h - 1 };
  }
}

export interface ScaleAboutOptions {
  /** Anchor that stays put, in source pixel coordinates. */
  pivotX: number;
  pivotY: number;
  /** Output size. Defaults to the source size, so the canvas never grows. */
  width?: number;
  height?: number;
}

/**
 * Scale about a pivot with nearest-neighbour sampling, keeping the output the same size
 * by default.
 *
 * `scaleNearest` only takes integer factors because that is all a *display* zoom needs.
 * Squash and stretch needs fractional factors (0.9 tall, 1.08 wide) applied to artwork
 * that has to stay registered to the same canvas, so this maps backwards from each
 * output pixel and rounds — which is the only sampling rule that keeps a pivot exactly
 * fixed.
 */
export function scaleAbout(
  source: PixelBuffer,
  scaleX: number,
  scaleY: number,
  opts: ScaleAboutOptions,
): PixelBuffer {
  if (!(scaleX > 0) || !(scaleY > 0)) {
    throw new RangeError('scaleAbout factors must be greater than zero');
  }
  const width = Math.max(1, Math.floor(opts.width ?? source.width));
  const height = Math.max(1, Math.floor(opts.height ?? source.height));
  const out = new PixelBuffer(width, height);
  const { pivotX, pivotY } = opts;
  for (let y = 0; y < height; y++) {
    const sy = Math.round(pivotY + (y - pivotY) / scaleY);
    if (sy < 0 || sy >= source.height) continue;
    for (let x = 0; x < width; x++) {
      const sx = Math.round(pivotX + (x - pivotX) / scaleX);
      if (sx < 0 || sx >= source.width) continue;
      const si = source.index(sx, sy);
      const di = out.index(x, y);
      out.data[di] = source.data[si];
      out.data[di + 1] = source.data[si + 1];
      out.data[di + 2] = source.data[si + 2];
      out.data[di + 3] = source.data[si + 3];
    }
  }
  return out;
}
