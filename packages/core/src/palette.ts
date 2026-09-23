import { PixelBuffer } from './buffer.js';
import { clamp8, parseColor } from './color.js';
import { ditherThreshold, type DitherPattern } from './dither.js';
import { makeId } from './ids.js';
import type { Color, ColorInput } from './types.js';

/**
 * A palette is a *constraint layer*, not the pixel storage format. Pixels are always
 * RGBA8888; a palette is a named list of colours that commands can snap artwork to.
 *
 * That separation is what makes AI-generated art tractable: the model can emit any RGB
 * it likes and `quantizeBuffer` will pull it back onto the artist's ramp.
 */
export interface Palette {
  id: string;
  name: string;
  colors: Color[];
}

/** DawnBringer 16 — a widely used, well-balanced 16-colour pixel art ramp. */
export const DAWNBRINGER_16: readonly string[] = [
  '#140c1c',
  '#442434',
  '#30346d',
  '#4e4a4e',
  '#854c30',
  '#346524',
  '#d04648',
  '#757161',
  '#597dce',
  '#d27d2c',
  '#8595a1',
  '#6daa2c',
  '#d2aa99',
  '#6dc2ca',
  '#dad45e',
  '#deeed6',
];

export function createPalette(name: string, colors: readonly ColorInput[], id?: string): Palette {
  if (colors.length === 0) throw new Error('A palette needs at least one colour');
  return {
    id: id ?? makeId('pal'),
    name,
    colors: colors.map((c) => parseColor(c)),
  };
}

export function createDefaultPalette(): Palette {
  return createPalette('DawnBringer 16', DAWNBRINGER_16);
}

/**
 * Perceptual-ish distance (the "redmean" approximation). Much better than plain RGB
 * distance for picking which ramp entry a colour belongs to, and far cheaper than Lab.
 */
export function colorDistanceWeighted(a: Color, b: Color): number {
  const rmean = (a.r + b.r) / 2;
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return (
    (((512 + rmean) * dr * dr) >> 8) + 4 * dg * dg + (((767 - rmean) * db * db) >> 8)
  );
}

export function nearestColorIndex(palette: Palette, color: Color): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < palette.colors.length; i++) {
    const d = colorDistanceWeighted(palette.colors[i], color);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best;
}

export function nearestColor(palette: Palette, color: Color): Color {
  return palette.colors[nearestColorIndex(palette, color)];
}

export interface QuantizeOptions {
  /**
   * `none` for a straight nearest-colour snap, a named pattern for ordered dithering,
   * or `floyd` for Floyd-Steinberg error diffusion.
   */
  dither?: 'none' | DitherPattern | 'floyd';
  /** Ordered-dither strength in colour units. Higher is grainier. Defaults to 48. */
  strength?: number;
  /** Pixels with alpha below this become fully transparent. Defaults to 128. */
  alphaThreshold?: number;
}

/**
 * Snap a buffer onto a palette. Returns a new buffer; the input is untouched.
 *
 * Transparent pixels stay transparent — quantisation never invents coverage.
 */
export function quantizeBuffer(
  source: PixelBuffer,
  palette: Palette,
  opts: QuantizeOptions = {},
): PixelBuffer {
  const dither = opts.dither ?? 'none';
  const strength = opts.strength ?? 48;
  const alphaThreshold = opts.alphaThreshold ?? 128;
  const out = new PixelBuffer(source.width, source.height);
  const src = source.data;
  const dst = out.data;

  if (dither === 'floyd') {
    // Work on a float copy so error can be pushed into neighbours without clipping.
    const work = new Float32Array(source.width * source.height * 3);
    for (let p = 0, i = 0; p < work.length; p += 3, i += 4) {
      work[p] = src[i];
      work[p + 1] = src[i + 1];
      work[p + 2] = src[i + 2];
    }
    const push = (x: number, y: number, er: number, eg: number, eb: number, f: number) => {
      if (x < 0 || y < 0 || x >= source.width || y >= source.height) return;
      const p = (y * source.width + x) * 3;
      work[p] += er * f;
      work[p + 1] += eg * f;
      work[p + 2] += eb * f;
    };
    for (let y = 0; y < source.height; y++) {
      for (let x = 0; x < source.width; x++) {
        const si = source.index(x, y);
        const di = out.index(x, y);
        if (src[si + 3] < alphaThreshold) continue;
        const p = (y * source.width + x) * 3;
        const want: Color = {
          r: clamp8(work[p]),
          g: clamp8(work[p + 1]),
          b: clamp8(work[p + 2]),
          a: 255,
        };
        const chosen = palette.colors[nearestColorIndex(palette, want)];
        dst[di] = chosen.r;
        dst[di + 1] = chosen.g;
        dst[di + 2] = chosen.b;
        dst[di + 3] = 255;
        const er = work[p] - chosen.r;
        const eg = work[p + 1] - chosen.g;
        const eb = work[p + 2] - chosen.b;
        push(x + 1, y, er, eg, eb, 7 / 16);
        push(x - 1, y + 1, er, eg, eb, 3 / 16);
        push(x, y + 1, er, eg, eb, 5 / 16);
        push(x + 1, y + 1, er, eg, eb, 1 / 16);
      }
    }
    return out;
  }

  const ordered = dither !== 'none';
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const si = source.index(x, y);
      const di = out.index(x, y);
      if (src[si + 3] < alphaThreshold) continue;
      let want: Color = { r: src[si], g: src[si + 1], b: src[si + 2], a: 255 };
      if (ordered) {
        const offset = (ditherThreshold(dither, x, y) - 0.5) * strength;
        want = {
          r: clamp8(want.r + offset),
          g: clamp8(want.g + offset),
          b: clamp8(want.b + offset),
          a: 255,
        };
      }
      const chosen = palette.colors[nearestColorIndex(palette, want)];
      dst[di] = chosen.r;
      dst[di + 1] = chosen.g;
      dst[di + 2] = chosen.b;
      dst[di + 3] = 255;
    }
  }
  return out;
}

/**
 * Unique colours actually present in a buffer, most frequent first.
 * Useful for "what is this sprite even made of" queries.
 */
export function extractPalette(source: PixelBuffer, limit = 256): Color[] {
  const counts = new Map<number, number>();
  const d = source.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const key = ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key]) => ({
      r: (key >>> 24) & 255,
      g: (key >>> 16) & 255,
      b: (key >>> 8) & 255,
      a: key & 255,
    }));
}
