import type { BlendMode, Color } from './types.js';

export interface BlendOptions {
  /** Defaults to `normal` (source-over). */
  blend?: BlendMode;
  /** 0-1 multiplier applied to the source alpha. Defaults to 1. */
  opacity?: number;
}

function blendChannel(mode: BlendMode, backdrop: number, source: number): number {
  switch (mode) {
    case 'multiply':
      return (backdrop * source) / 255;
    case 'screen':
      return 255 - ((255 - backdrop) * (255 - source)) / 255;
    case 'overlay':
      return backdrop < 128
        ? (2 * backdrop * source) / 255
        : 255 - (2 * (255 - backdrop) * (255 - source)) / 255;
    case 'add':
      return Math.min(255, backdrop + source);
    default:
      return source;
  }
}

/**
 * Composite `src` into `data` at byte offset `i`, in place.
 *
 * `Uint8ClampedArray` handles the clamping and rounding for us.
 */
export function blendInto(
  data: Uint8ClampedArray,
  i: number,
  src: Color,
  opts: BlendOptions = {},
): void {
  const mode = opts.blend ?? 'normal';
  const opacity = opts.opacity ?? 1;
  const sa = (src.a / 255) * opacity;

  if (sa <= 0) return;

  if (mode === 'replace') {
    data[i] = src.r;
    data[i + 1] = src.g;
    data[i + 2] = src.b;
    data[i + 3] = Math.round(src.a * opacity);
    return;
  }

  const dr = data[i];
  const dg = data[i + 1];
  const db = data[i + 2];
  const da = data[i + 3] / 255;

  // Fast path: opaque source over a transparent backdrop is a plain write.
  if (sa >= 1 && da === 0) {
    data[i] = src.r;
    data[i + 1] = src.g;
    data[i + 2] = src.b;
    data[i + 3] = 255;
    return;
  }

  const outA = sa + da * (1 - sa);
  if (outA <= 0) {
    data[i] = 0;
    data[i + 1] = 0;
    data[i + 2] = 0;
    data[i + 3] = 0;
    return;
  }

  const mix = (cb: number, cs: number) =>
    (blendChannel(mode, cb, cs) * sa + cb * da * (1 - sa)) / outA;

  data[i] = mix(dr, src.r);
  data[i + 1] = mix(dg, src.g);
  data[i + 2] = mix(db, src.b);
  data[i + 3] = outA * 255;
}
