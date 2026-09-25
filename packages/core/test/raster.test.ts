import { describe, expect, it } from 'vitest';
import { PixelBuffer } from '../src/buffer.js';
import {
  countOpaque,
  drawEllipse,
  drawLine,
  drawPolygon,
  drawRect,
  ditherFill,
  extractRegion,
  floodFill,
  outline,
  putPixel,
  putPixels,
  replaceColor,
} from '../src/raster.js';

const RED = '#ff0000';
const BLUE = '#0000ff';

describe('putPixel', () => {
  it('writes inside and reports out-of-bounds instead of throwing', () => {
    const buf = new PixelBuffer(4, 4);
    expect(putPixel(buf, 1, 1, { r: 255, g: 0, b: 0, a: 255 })).toBe(true);
    expect(putPixel(buf, -1, 1, { r: 255, g: 0, b: 0, a: 255 })).toBe(false);
    expect(putPixel(buf, 4, 0, { r: 255, g: 0, b: 0, a: 255 })).toBe(false);
  });

  it('treats a null colour as erase', () => {
    const buf = PixelBuffer.filled(2, 2, RED);
    putPixel(buf, 0, 0, null);
    expect(buf.getColor(0, 0).a).toBe(0);
  });

  it('does not treat alpha 0 as erase', () => {
    const buf = PixelBuffer.filled(2, 2, RED);
    putPixel(buf, 0, 0, { r: 0, g: 0, b: 0, a: 0 });
    expect(buf.getColor(0, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
  });
});

describe('putPixels', () => {
  it('writes an in-memory RGBA buffer with clipping and optional colour mapping', () => {
    const buf = new PixelBuffer(4, 4);
    const result = putPixels(
      buf,
      { x: 1, y: 1, w: 2, h: 1 },
      new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128]),
      { mapColor: (color) => ({ ...color, b: 32 }) },
    );
    expect(result).toEqual({ requested: 2, written: 2, painted: 2, cleared: 0, clipped: 0, ignoredTransparent: 0 });
    expect(buf.getColor(1, 1)).toEqual({ r: 255, g: 0, b: 32, a: 255 });
    expect(buf.getColor(2, 1)).toEqual({ r: 0, g: 255, b: 32, a: 128 });
  });

  it('can clear transparent samples and validates the byte length', () => {
    const buf = PixelBuffer.filled(2, 1, RED);
    const result = putPixels(buf, { x: 0, y: 0, w: 2, h: 1 }, new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 255, 255]), {
      clearTransparent: true,
    });
    expect(result).toMatchObject({ written: 2, cleared: 1, ignoredTransparent: 0 });
    expect(buf.getColor(0, 0).a).toBe(0);
    expect(buf.getColor(1, 0).a).toBe(255);
    const ignored = putPixels(buf, { x: 0, y: 0, w: 1, h: 1 }, new Uint8ClampedArray([0, 0, 0, 0]));
    expect(ignored).toMatchObject({ clipped: 0, ignoredTransparent: 1 });
    expect(() => putPixels(buf, { x: 0, y: 0, w: 1, h: 1 }, new Uint8ClampedArray([1, 2, 3]))).toThrow(/expected 4 RGBA bytes/);
    expect(() => putPixels(buf, { x: 0.5, y: 0, w: 1, h: 1 }, new Uint8ClampedArray([1, 2, 3, 255]))).toThrow(/safe integer/);
  });
});

describe('drawLine', () => {
  it('includes both endpoints', () => {
    const buf = new PixelBuffer(8, 8);
    drawLine(buf, 0, 0, 3, 0, RED);
    expect(countOpaque(buf)).toBe(4);
    expect(buf.getColor(0, 0).a).toBe(255);
    expect(buf.getColor(3, 0).a).toBe(255);
  });

  it('draws a clean diagonal', () => {
    const buf = new PixelBuffer(4, 4);
    drawLine(buf, 0, 0, 3, 3, RED);
    expect(countOpaque(buf)).toBe(4);
  });

  it('terminates on degenerate input', () => {
    const buf = new PixelBuffer(4, 4);
    expect(drawLine(buf, 2, 2, 2, 2, RED)).toBe(1);
  });
});

describe('drawRect', () => {
  it('draws a border without filling the middle', () => {
    const buf = new PixelBuffer(5, 5);
    drawRect(buf, { x: 0, y: 0, w: 5, h: 5 }, RED);
    expect(buf.getColor(2, 2).a).toBe(0);
    expect(countOpaque(buf)).toBe(16);
  });

  it('fills on request', () => {
    const buf = new PixelBuffer(5, 5);
    drawRect(buf, { x: 1, y: 1, w: 3, h: 3 }, RED, { fill: true });
    expect(countOpaque(buf)).toBe(9);
  });

  it('clips an oversized rect to the canvas', () => {
    const buf = new PixelBuffer(4, 4);
    const painted = drawRect(buf, { x: -2, y: -2, w: 100, h: 100 }, RED, { fill: true });
    expect(painted).toBe(16);
    expect(countOpaque(buf)).toBe(16);
  });
});

describe('drawEllipse', () => {
  it('is horizontally and vertically symmetric', () => {
    const buf = new PixelBuffer(16, 16);
    drawEllipse(buf, { x: 0, y: 0, w: 15, h: 11 }, RED);
    for (let y = 0; y < 11; y++) {
      for (let x = 0; x < 15; x++) {
        expect(buf.getColor(x, y).a).toBe(buf.getColor(14 - x, y).a);
        expect(buf.getColor(x, y).a).toBe(buf.getColor(x, 10 - y).a);
      }
    }
  });

  it('handles an even diameter without dropping the centre line', () => {
    const buf = new PixelBuffer(8, 8);
    drawEllipse(buf, { x: 0, y: 0, w: 8, h: 8 }, RED, { fill: true });
    expect(countOpaque(buf)).toBeGreaterThan(40);
    expect(countOpaque(buf)).toBeLessThan(64);
  });

  it('fills a disc', () => {
    const buf = new PixelBuffer(16, 16);
    drawEllipse(buf, { x: 0, y: 0, w: 16, h: 16 }, RED, { fill: true });
    expect(countOpaque(buf)).toBe(208);
  });
});

describe('drawPolygon', () => {
  it('outlines a triangle', () => {
    const buf = new PixelBuffer(8, 8);
    drawPolygon(buf, [{ x: 0, y: 0 }, { x: 7, y: 0 }, { x: 0, y: 7 }], RED);
    expect(buf.getColor(0, 0).a).toBe(255);
    expect(buf.getColor(7, 0).a).toBe(255);
    expect(countOpaque(buf)).toBeGreaterThan(10);
  });

  it('fills a concave polygon', () => {
    const buf = new PixelBuffer(10, 10);
    // An arrow-like shape; a convex-only filler would get this wrong.
    drawPolygon(
      buf,
      [
        { x: 0, y: 0 },
        { x: 9, y: 0 },
        { x: 9, y: 9 },
        { x: 5, y: 4 },
        { x: 0, y: 9 },
      ],
      RED,
      { fill: true },
    );
    expect(buf.getColor(4, 1).a).toBe(255);
    expect(buf.getColor(4, 8).a).toBe(0);
  });
});

describe('floodFill', () => {
  it('fills a bounded region and stops at the border', () => {
    const buf = new PixelBuffer(8, 8);
    drawRect(buf, { x: 1, y: 1, w: 6, h: 6 }, RED);
    const painted = floodFill(buf, 3, 3, BLUE);
    expect(painted).toBe(16);
    expect(buf.getColor(3, 3).b).toBe(255);
    expect(buf.getColor(0, 0).a).toBe(0);
  });

  it('replaces every match when not contiguous', () => {
    const buf = new PixelBuffer(4, 1);
    buf.setColor(0, 0, { r: 255, g: 0, b: 0, a: 255 });
    buf.setColor(2, 0, { r: 255, g: 0, b: 0, a: 255 });
    const painted = floodFill(buf, 0, 0, BLUE, { contiguous: false });
    expect(painted).toBe(2);
    expect(buf.getColor(2, 0).b).toBe(255);
  });

  it('terminates when the new colour is within tolerance of the target', () => {
    const buf = PixelBuffer.filled(16, 16, '#808080');
    const painted = floodFill(buf, 0, 0, '#818181', { tolerance: 8 });
    expect(painted).toBe(256);
  });

  it('does nothing when seeded outside the rect', () => {
    const buf = PixelBuffer.filled(4, 4, RED);
    expect(floodFill(buf, 0, 0, BLUE, { rect: { x: 2, y: 2, w: 2, h: 2 } })).toBe(0);
  });
});

describe('ditherFill', () => {
  it('covers about half the rect with a checker', () => {
    const buf = new PixelBuffer(16, 16);
    const painted = ditherFill(buf, { x: 0, y: 0, w: 16, h: 16 }, RED, { pattern: 'checker' });
    expect(painted).toBe(128);
  });

  it('respects the coverage level for ordered patterns', () => {
    const buf = new PixelBuffer(16, 16);
    const light = ditherFill(buf, { x: 0, y: 0, w: 16, h: 16 }, RED, {
      pattern: 'bayer4',
      level: 0.25,
    });
    const heavy = ditherFill(buf, { x: 0, y: 0, w: 16, h: 16 }, RED, {
      pattern: 'bayer4',
      level: 0.75,
    });
    // A 4x4 Bayer matrix has one cell per 1/16 of coverage, so the painted counts are
    // exact rather than approximate.
    expect(light).toBe(64);
    expect(heavy).toBe(192);
  });

  it('covers the requested fraction with an 8x8 Bayer matrix', () => {
    const buf = new PixelBuffer(64, 64);
    const painted = ditherFill(buf, { x: 0, y: 0, w: 64, h: 64 }, RED, {
      pattern: 'bayer8',
      level: 0.5,
    });
    expect(painted).toBe(2048);
  });
});

describe('outline', () => {
  it('grows the silhouette when outside', () => {
    const buf = new PixelBuffer(8, 8);
    drawRect(buf, { x: 2, y: 2, w: 4, h: 4 }, RED, { fill: true });
    const before = countOpaque(buf);
    outline(buf, BLUE);
    expect(countOpaque(buf)).toBeGreaterThan(before);
    // 4-connected by default, so the edge neighbour is outlined but the corner is not.
    expect(buf.getColor(2, 1).b).toBe(255);
    expect(buf.getColor(1, 1).a).toBe(0);
  });

  it('eats into the silhouette when inside', () => {
    const buf = new PixelBuffer(8, 8);
    drawRect(buf, { x: 2, y: 2, w: 4, h: 4 }, RED, { fill: true });
    outline(buf, BLUE, { mode: 'inside' });
    expect(buf.getColor(2, 2).b).toBe(255);
    expect(buf.getColor(3, 3).r).toBe(255);
  });

  it('does nothing on an empty cel', () => {
    const buf = new PixelBuffer(4, 4);
    expect(outline(buf, RED)).toBe(0);
  });
});

describe('replaceColor', () => {
  it('swaps an exact colour', () => {
    const buf = new PixelBuffer(4, 4);
    buf.setColor(1, 1, { r: 10, g: 20, b: 30, a: 255 });
    buf.setColor(2, 2, { r: 10, g: 20, b: 31, a: 255 });
    const painted = replaceColor(buf, '#0a141e', BLUE);
    expect(painted).toBe(1);
    expect(buf.getColor(1, 1).b).toBe(255);
    expect(buf.getColor(2, 2).b).toBe(31);
  });

  it('erases when the target is null', () => {
    const buf = PixelBuffer.filled(2, 2, RED);
    replaceColor(buf, RED, null);
    expect(buf.isEmpty()).toBe(true);
  });
});

describe('extractRegion', () => {
  it('pads out-of-bounds areas with transparency', () => {
    const buf = PixelBuffer.filled(4, 4, RED);
    const patch = extractRegion(buf, { x: 2, y: 2, w: 4, h: 4 });
    expect(patch.width).toBe(4);
    expect(patch.getColor(0, 0).r).toBe(255);
    expect(patch.getColor(3, 3).a).toBe(0);
  });
});
