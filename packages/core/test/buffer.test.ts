import { describe, expect, it } from 'vitest';
import { PixelBuffer } from '../src/buffer.js';

describe('PixelBuffer', () => {
  it('starts fully transparent', () => {
    const buf = new PixelBuffer(4, 4);
    expect(buf.data.length).toBe(64);
    expect(buf.isEmpty()).toBe(true);
  });

  it('rejects bad dimensions and mismatched data', () => {
    expect(() => new PixelBuffer(0, 4)).toThrow(RangeError);
    expect(() => new PixelBuffer(4, 2.5)).toThrow(RangeError);
    expect(() => new PixelBuffer(2, 2, new Uint8ClampedArray(4))).toThrow(RangeError);
  });

  it('fills with a colour', () => {
    const buf = PixelBuffer.filled(3, 2, '#ff0000');
    expect(buf.getColor(0, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(buf.getColor(2, 1)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(buf.isEmpty()).toBe(false);
  });

  it('fills only inside a rect', () => {
    const buf = new PixelBuffer(4, 4);
    buf.fill('#00ff00', { x: 1, y: 1, w: 2, h: 2 });
    expect(buf.getColor(0, 0).a).toBe(0);
    expect(buf.getColor(1, 1).a).toBe(255);
    expect(buf.getColor(2, 2).a).toBe(255);
    expect(buf.getColor(3, 3).a).toBe(0);
  });

  it('clips a backwards rect instead of throwing', () => {
    const buf = new PixelBuffer(4, 4);
    buf.fill('#00ff00', { x: 3, y: 3, w: -2, h: -2 });
    expect(buf.getColor(2, 2).a).toBe(255);
    expect(buf.getColor(1, 1).a).toBe(255);
    expect(buf.getColor(0, 0).a).toBe(0);
  });

  it('clears back to transparent', () => {
    const buf = PixelBuffer.filled(2, 2, '#fff');
    buf.clear({ x: 0, y: 0, w: 1, h: 1 });
    expect(buf.getColor(0, 0).a).toBe(0);
    expect(buf.getColor(1, 1).a).toBe(255);
  });

  it('clones independently', () => {
    const buf = PixelBuffer.filled(2, 2, '#fff');
    const copy = buf.clone();
    copy.setColor(0, 0, { r: 0, g: 0, b: 0, a: 255 });
    expect(buf.getColor(0, 0).r).toBe(255);
    expect(buf.isEqualTo(copy)).toBe(false);
  });

  it('scales with nearest neighbour', () => {
    const buf = new PixelBuffer(2, 1);
    buf.setColor(0, 0, { r: 255, g: 0, b: 0, a: 255 });
    buf.setColor(1, 0, { r: 0, g: 0, b: 255, a: 255 });
    const scaled = buf.scale(3);
    expect(scaled.width).toBe(6);
    expect(scaled.getColor(0, 0).r).toBe(255);
    expect(scaled.getColor(2, 0).r).toBe(255);
    expect(scaled.getColor(3, 0).b).toBe(255);
    expect(() => buf.scale(1.5)).toThrow(RangeError);
  });

  it('reports the tight bounds of the artwork', () => {
    const buf = new PixelBuffer(8, 8);
    expect(buf.opaqueBounds()).toBeNull();
    buf.fill('#fff', { x: 2, y: 3, w: 2, h: 4 });
    expect(buf.opaqueBounds()).toEqual({ x: 2, y: 3, w: 2, h: 4 });
  });

  it('blits a sub-region', () => {
    const src = PixelBuffer.filled(4, 4, '#ff0000');
    const dst = new PixelBuffer(4, 4);
    dst.blitRegion(src, { x: 1, y: 1, w: 2, h: 2 }, 0, 0);
    expect(dst.getColor(0, 0).r).toBe(255);
    expect(dst.getColor(2, 2).a).toBe(0);
  });
});
