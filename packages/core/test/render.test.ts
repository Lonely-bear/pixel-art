import { describe, expect, it } from 'vitest';
import { createSprite } from '../src/document.js';
import { compositeFrame, compositeWithOnion } from '../src/render.js';
import { createEditor } from '../src/index.js';

/** Three frames, each with a single opaque pixel at a different x. */
function threeFrames() {
  const sprite = createSprite({ width: 4, height: 1, name: 'Onion', frames: 3 });
  const editor = createEditor(sprite);
  editor.execute('draw_pixels', { layer: 0, frame: 0, pixels: [{ x: 0, y: 0, color: '#ff0000' }] });
  editor.execute('draw_pixels', { layer: 0, frame: 1, pixels: [{ x: 1, y: 0, color: '#00ff00' }] });
  editor.execute('draw_pixels', { layer: 0, frame: 2, pixels: [{ x: 2, y: 0, color: '#0000ff' }] });
  return editor.sprite;
}

describe('compositeWithOnion', () => {
  it('is identical to compositeFrame when no ghosts are requested', () => {
    const sprite = threeFrames();
    const plain = compositeFrame(sprite, sprite.frames[1].id);
    const onion = compositeWithOnion(sprite, sprite.frames[1].id, { before: 0, after: 0 });
    expect(onion.data).toEqual(plain.data);
  });

  it('draws neighbouring frames behind the current one at reduced alpha', () => {
    const sprite = threeFrames();
    const out = compositeWithOnion(sprite, sprite.frames[1].id, { before: 1, after: 1, opacity: 0.5 });

    // The current frame is untouched and fully opaque.
    expect(out.getColor(1, 0)).toEqual({ r: 0, g: 255, b: 0, a: 255 });

    const past = out.getColor(0, 0);
    expect(past.r).toBe(255);
    expect(past.g).toBe(0);
    expect(past.a).toBeGreaterThan(0);
    expect(past.a).toBeLessThan(255);

    const future = out.getColor(2, 0);
    expect(future.b).toBe(255);
    expect(future.a).toBeGreaterThan(0);
    expect(future.a).toBeLessThan(255);

    // Pixels belonging to no ghosted frame stay transparent.
    expect(out.getColor(3, 0).a).toBe(0);
  });

  it('tints earlier and later frames independently', () => {
    const sprite = threeFrames();
    const out = compositeWithOnion(sprite, sprite.frames[1].id, {
      before: 1,
      after: 1,
      opacity: 1,
      beforeTint: '#000000',
      afterTint: '#ffffff',
    });
    expect(out.getColor(0, 0)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(out.getColor(2, 0)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
  });

  it('wraps around the frame list when loop is set', () => {
    const sprite = threeFrames();
    const out = compositeWithOnion(sprite, sprite.frames[0].id, { before: 1, loop: true, opacity: 1 });
    expect(out.getColor(2, 0).b).toBe(255);
  });

  it('respects the layer filter', () => {
    const base = createSprite({ width: 2, height: 1, layers: ['base', 'ink'], frames: 2 });
    const editor = createEditor(base);
    editor.execute('draw_pixels', { layer: 0, frame: 0, pixels: [{ x: 0, y: 0, color: '#ff0000' }] });
    editor.execute('draw_pixels', { layer: 1, frame: 0, pixels: [{ x: 0, y: 0, color: '#00ff00' }] });
    const sprite = editor.sprite;

    const topOnly = compositeWithOnion(sprite, sprite.frames[0].id, {
      before: 0,
      after: 0,
      layers: [sprite.layers[1].id],
    });
    expect(topOnly.getColor(0, 0)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
  });
});
