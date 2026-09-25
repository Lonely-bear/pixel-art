/**
 * Dither patterns.
 *
 * Dithering is not a nicety in pixel art, it is *the* shading technique. Because it is
 * hard for a language model to compute a correct 50% checkerboard by hand across a
 * region, the tool computes it instead — that is the whole point of exposing these as
 * first-class named patterns.
 */

export type DitherPattern =
  | 'checker'
  | 'checker-inv'
  | 'bayer4'
  | 'bayer8'
  | 'dots'
  | 'sparse'
  | 'dense'
  | 'horizontal'
  | 'vertical'
  | 'diagonal'
  | 'cluster2'
  | 'cluster4';

export const DITHER_PATTERNS: readonly DitherPattern[] = [
  'checker',
  'checker-inv',
  'bayer4',
  'bayer8',
  'dots',
  'sparse',
  'dense',
  'horizontal',
  'vertical',
  'diagonal',
  'cluster2',
  'cluster4',
];

/**
 * Ordered threshold on a coarser grid, so a paint decision covers an NxN block
 * instead of one pixel.
 *
 * Large canvases make 1px Bayer read as digital noise: at 512x512 a 50% bayer8
 * field is 65,536 isolated alternations. Cluster dithering trades some of that
 * gradient resolution for 2x2 or 4x4 blocks, which composited at 100% read as a
 * softer tonal step rather than a stipple.
 */
function clusterThreshold(size: 2 | 4, x: number, y: number): number {
  const bx = Math.floor(x / size) & 3;
  const by = Math.floor(y / size) & 3;
  return BAYER4[by * 4 + bx] / 16;
}

/** Classic 4x4 Bayer threshold matrix, values 0-15, row-major. */
const BAYER4: readonly number[] = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
];

/**
 * 8x8 Bayer built from the 4x4 by the standard recursion
 * `M2n = [[4Mn, 4Mn+2], [4Mn+3, 4Mn+1]]`, so there is no hand-typed 64-entry table to
 * get wrong.
 */
function bayerValue(size: 4 | 8, x: number, y: number): number {
  const bx = x & 3;
  const by = y & 3;
  const base = BAYER4[by * 4 + bx];
  // The 4x4 matrix is the answer for `bayer4`; the recursion only applies at 8x8.
  if (size === 4) return base;
  const qx = (x >> 2) & 1;
  const qy = (y >> 2) & 1;
  return base * 4 + (qy === 0 ? (qx === 0 ? 0 : 2) : qx === 0 ? 3 : 1);
}

/**
 * Ordered-dither threshold in `[0, 1)` for a pixel.
 *
 * A pixel is painted when its threshold is below the requested coverage `level`, so a
 * low threshold means the pixel is painted at low coverage.
 */
export function ditherThreshold(pattern: DitherPattern, x: number, y: number): number {
  switch (pattern) {
    case 'checker':
      return ((x + y) & 1) === 0 ? 0 : 1;
    case 'checker-inv':
      return ((x + y) & 1) === 0 ? 1 : 0;
    case 'bayer4':
      return bayerValue(4, x, y) / 16;
    case 'bayer8':
      return bayerValue(8, x, y) / 64;
    case 'dots':
      return (x & 1) === 0 && (y & 1) === 0 ? 0 : 1;
    case 'sparse':
      return (x & 3) === 0 && (y & 3) === 0 ? 0 : 1;
    case 'dense':
      return (x & 1) === 1 && (y & 1) === 1 ? 1 : 0;
    case 'horizontal':
      return (y & 1) === 0 ? 0 : 1;
    case 'vertical':
      return (x & 1) === 0 ? 0 : 1;
    case 'diagonal':
      return (x + y) % 4 < 2 ? 0 : 1;
    case 'cluster2':
      return clusterThreshold(2, x, y);
    case 'cluster4':
      return clusterThreshold(4, x, y);
    default:
      return 0;
  }
}

/** Should this pixel be painted for the given pattern and coverage level? */
export function ditherMask(
  pattern: DitherPattern,
  x: number,
  y: number,
  level = 0.5,
): boolean {
  return ditherThreshold(pattern, x, y) < level;
}
