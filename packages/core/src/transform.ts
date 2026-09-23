import { PixelBuffer } from './buffer.js';
import { normalizeRect } from './geometry.js';
import type { Rect } from './types.js';

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
