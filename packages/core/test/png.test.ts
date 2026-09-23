import { describe, expect, it } from 'vitest';
import { PixelBuffer } from '../src/buffer.js';
import { decodePNG, encodePNG, isPNG } from '../src/png.js';

describe('png round-trip', () => {
  it('encodes a signature that isPNG recognises', () => {
    const bytes = encodePNG(new PixelBuffer(2, 2));
    expect(isPNG(bytes)).toBe(true);
    expect(isPNG(new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it('round-trips exact RGBA values', () => {
    const buf = new PixelBuffer(3, 2);
    buf.setColor(0, 0, { r: 255, g: 0, b: 0, a: 255 });
    buf.setColor(1, 0, { r: 0, g: 128, b: 255, a: 128 });
    buf.setColor(2, 1, { r: 1, g: 2, b: 3, a: 4 });

    const decoded = decodePNG(encodePNG(buf));
    expect(decoded.width).toBe(3);
    expect(decoded.height).toBe(2);
    expect(decoded.isEqualTo(buf)).toBe(true);
  });

  it('preserves full transparency', () => {
    const buf = PixelBuffer.filled(4, 4, { r: 0, g: 0, b: 0, a: 0 });
    buf.setColor(2, 2, { r: 10, g: 20, b: 30, a: 255 });
    const decoded = decodePNG(encodePNG(buf));
    expect(decoded.getColor(0, 0).a).toBe(0);
    expect(decoded.getColor(2, 2)).toEqual({ r: 10, g: 20, b: 30, a: 255 });
  });

  it('survives an empty image', () => {
    const decoded = decodePNG(encodePNG(new PixelBuffer(1, 1)));
    expect(decoded.getColor(0, 0).a).toBe(0);
  });
});
