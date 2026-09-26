/**
 * Generate the application icon that electron-builder packages.
 *
 * electron-builder needs a single square PNG (`build/icon.png`, 1024x1024) and
 * derives `icon.ico` for Windows and `icon.icns` for macOS from it. The
 * repository only ships the vector mark (`assets/pixel-mark.svg`), which those
 * two formats cannot be converted from without a native rasteriser, so the mark
 * is redrawn here as pixels instead.
 *
 * Everything is described in the SVG's own 128x128 coordinate space and scaled
 * up, which keeps this file readable side by side with the original. Shapes are
 * rasterised from signed distance fields with a 2x supersample, so the rounded
 * corners and the diagonal gradient come out clean rather than aliased.
 *
 *   node scripts/make-icon.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { encode } from 'fast-png';

const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(here, '..', 'build', 'icon.png');

/** Final edge length. 1024 is the smallest size that yields a crisp .icns. */
const SIZE = 1024;
/** Rendered at 2x and box-filtered down, for antialiasing the rounded corners. */
const SUPERSAMPLE = 2;
const DESIGN = 128; // the viewBox of assets/pixel-mark.svg
const SCALE = (SIZE * SUPERSAMPLE) / DESIGN;

// ---------------------------------------------------------------------------
// Geometry helpers. Distances are in design units; the caller scales.
// ---------------------------------------------------------------------------

/**
 * Signed distance to a rounded rectangle. Negative inside, positive outside,
 * and in the same units as the offsets — which is what makes the `0.5 - d`
 * coverage below a real one-pixel feather instead of a guess.
 */
function sdRoundRect(px, py, x, y, w, h, r) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const halfW = w / 2 - r;
  const halfH = h / 2 - r;
  const qx = Math.abs(px - cx) - halfW;
  const qy = Math.abs(py - cy) - halfH;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

/** Antialiased coverage of the shape, in the 0..1 range. */
function coverage(distance) {
  return Math.min(Math.max(0.5 - distance, 0), 1);
}

const hex = (value) => [
  parseInt(value.slice(1, 3), 16),
  parseInt(value.slice(3, 5), 16),
  parseInt(value.slice(5, 7), 16),
];

// The mark, transcribed from assets/pixel-mark.svg.
const BG_TOP = hex('#17152f');
const BG_BOTTOM = hex('#090b18');
const TILES = [
  { x: 22, y: 22, color: hex('#6868e8') },
  { x: 70, y: 22, color: hex('#f0a44c') },
  { x: 22, y: 70, color: hex('#4dbb8b') },
  { x: 70, y: 70, color: hex('#ec6f86') },
];
/** `stroke="#fff" stroke-opacity=".18" stroke-width="4"`, butt caps. */
const HIGHLIGHTS = [
  { x: 28, y: 26, w: 24, h: 4 },
  { x: 76, y: 26, w: 24, h: 4 },
  { x: 28, y: 74, w: 24, h: 4 },
  { x: 76, y: 74, w: 24, h: 4 },
];
const HIGHLIGHT_COLOR = hex('#ffffff');
const HIGHLIGHT_ALPHA = 0.18;

/** `gradientUnits="userSpaceOnUse" x1="16" y1="8" x2="112" y2="120"`. */
const GRADIENT_FROM = { x: 16, y: 8 };
const GRADIENT_TO = { x: 112, y: 120 };

function gradientAt(px, py) {
  const dx = GRADIENT_TO.x - GRADIENT_FROM.x;
  const dy = GRADIENT_TO.y - GRADIENT_FROM.y;
  const t = Math.min(
    Math.max(((px - GRADIENT_FROM.x) * dx + (py - GRADIENT_FROM.y) * dy) / (dx * dx + dy * dy), 0),
    1,
  );
  return [0, 1, 2].map((i) => BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t);
}

// ---------------------------------------------------------------------------
// Rasterise
// ---------------------------------------------------------------------------

const wide = SIZE * SUPERSAMPLE;
const accum = new Float64Array(wide * wide * 4); // straight alpha, 0..255

/** Composite a source colour over one pixel of the accumulator. */
function over(offset, color, alpha) {
  if (alpha <= 0) return;
  const dstA = accum[offset + 3] / 255;
  const outA = alpha + dstA * (1 - alpha);
  if (outA <= 0) return;
  for (let c = 0; c < 3; c += 1) {
    // Premultiplied blend, then un-premultiply so every layer can be composited
    // the same way regardless of what is already underneath.
    const srcC = color[c];
    const dstC = accum[offset + c];
    accum[offset + c] = (srcC * alpha + dstC * dstA * (1 - alpha)) / outA;
  }
  accum[offset + 3] = outA * 255;
}

for (let py = 0; py < wide; py += 1) {
  const dy = (py + 0.5) / SCALE;
  for (let px = 0; px < wide; px += 1) {
    const dx = (px + 0.5) / SCALE;
    const offset = (py * wide + px) * 4;

    over(offset, gradientAt(dx, dy), coverage(sdRoundRect(dx, dy, 4, 4, 120, 120, 28)));

    for (const tile of TILES) {
      over(offset, tile.color, coverage(sdRoundRect(dx, dy, tile.x, tile.y, 36, 36, 6)));
    }

    for (const bar of HIGHLIGHTS) {
      over(
        offset,
        HIGHLIGHT_COLOR,
        coverage(sdRoundRect(dx, dy, bar.x, bar.y, bar.w, bar.h, 0)) * HIGHLIGHT_ALPHA,
      );
    }
  }
}

// Box-filter the supersampled buffer down to the final size.
const data = new Uint8Array(SIZE * SIZE * 4);
const samples = SUPERSAMPLE * SUPERSAMPLE;
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
      for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
        const offset = ((y * SUPERSAMPLE + sy) * wide + (x * SUPERSAMPLE + sx)) * 4;
        r += accum[offset];
        g += accum[offset + 1];
        b += accum[offset + 2];
        a += accum[offset + 3];
      }
    }
    const out = (y * SIZE + x) * 4;
    data[out] = Math.round(r / samples);
    data[out + 1] = Math.round(g / samples);
    data[out + 2] = Math.round(b / samples);
    data[out + 3] = Math.round(a / samples);
  }
}

await mkdir(path.dirname(outFile), { recursive: true });
await writeFile(outFile, encode({ width: SIZE, height: SIZE, data, channels: 4, depth: 8 }));
console.log(`Wrote ${path.relative(path.join(here, '..'), outFile)} (${SIZE}x${SIZE})`);
