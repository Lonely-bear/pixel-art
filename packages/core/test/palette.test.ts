import { describe, expect, it } from 'vitest';
import { PixelBuffer } from '../src/buffer.js';
import {
  createDefaultPalette,
  createPalette,
  extractPalette,
  nearestColor,
  quantizeBuffer,
} from '../src/palette.js';

const BW = createPalette('BW', ['#000000', '#ffffff']);

describe('quantizeBuffer', () => {
  it('snaps every pixel to the nearest palette colour', () => {
    const buf = new PixelBuffer(2, 1);
    buf.setColor(0, 0, { r: 10, g: 10, b: 10, a: 255 });
    buf.setColor(1, 0, { r: 200, g: 200, b: 200, a: 255 });
    const out = quantizeBuffer(buf, BW, { dither: 'none' });
    expect(out.getColor(0, 0)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(out.getColor(1, 0)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
  });

  it('leaves transparent pixels transparent', () => {
    const buf = new PixelBuffer(2, 1);
    buf.setColor(0, 0, { r: 10, g: 10, b: 10, a: 255 });
    const out = quantizeBuffer(buf, BW, { dither: 'none' });
    expect(out.getColor(1, 0).a).toBe(0);
  });

  it('produces a mix of both colours when dithering a mid grey', () => {
    const buf = PixelBuffer.filled(16, 16, { r: 128, g: 128, b: 128, a: 255 });
    const out = quantizeBuffer(buf, BW, { dither: 'bayer4' });
    let black = 0;
    let white = 0;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        if (out.getColor(x, y).r === 0) black++;
        else white++;
      }
    }
    expect(black).toBeGreaterThan(0);
    expect(white).toBeGreaterThan(0);
  });

  it('does not mutate the source buffer', () => {
    const buf = PixelBuffer.filled(2, 2, { r: 128, g: 128, b: 128, a: 255 });
    quantizeBuffer(buf, BW, { dither: 'none' });
    expect(buf.getColor(0, 0).r).toBe(128);
  });
});

describe('nearestColor', () => {
  it('picks the closer of two candidates', () => {
    const palette = createDefaultPalette();
    expect(nearestColor(palette, { r: 250, g: 250, b: 250, a: 255 }).r).toBeGreaterThan(200);
    expect(nearestColor(palette, { r: 2, g: 2, b: 2, a: 255 }).r).toBeLessThan(50);
  });
});

describe('extractPalette', () => {
  it('orders colours by frequency, ignoring transparency', () => {
    const buf = new PixelBuffer(3, 1);
    buf.setColor(0, 0, { r: 255, g: 0, b: 0, a: 255 });
    buf.setColor(1, 0, { r: 255, g: 0, b: 0, a: 255 });
    buf.setColor(2, 0, { r: 0, g: 0, b: 255, a: 255 });
    const colors = extractPalette(buf);
    expect(colors[0]).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(colors[1]).toEqual({ r: 0, g: 0, b: 255, a: 255 });
    expect(colors).toHaveLength(2);
  });

  it('honours the limit', () => {
    const buf = new PixelBuffer(4, 1);
    buf.setColor(0, 0, { r: 1, g: 0, b: 0, a: 255 });
    buf.setColor(1, 0, { r: 2, g: 0, b: 0, a: 255 });
    buf.setColor(2, 0, { r: 3, g: 0, b: 0, a: 255 });
    buf.setColor(3, 0, { r: 4, g: 0, b: 0, a: 255 });
    expect(extractPalette(buf, 2)).toHaveLength(2);
  });
});
