import { describe, expect, it } from 'vitest';
import { createSprite, makeId, PixelBuffer } from '../src/index.js';
import { animationSequence, encodeGIF, findTag } from '../src/gif.js';
import type { AnimationTag, Sprite, TagDirection } from '../src/index.js';

/** A sprite with `frames` frames, one layer, and whatever tags the test needs. */
function makeSprite(frames = 3, tags: Array<Partial<AnimationTag> & { name: string }> = []): Sprite {
  const sprite = createSprite({
    width: 8,
    height: 8,
    name: 'Anim',
    layers: ['base'],
    frames,
    frameDurationMs: 100,
  });
  for (const tag of tags) {
    sprite.tags.push({
      id: makeId('tag'),
      name: tag.name,
      from: tag.from ?? 0,
      to: tag.to ?? frames - 1,
      direction: (tag.direction ?? 'forward') as TagDirection,
      repeat: tag.repeat ?? 0,
    });
  }
  return sprite;
}

/** The logical screen descriptor: width and height as little-endian uint16s. */
function gifSize(bytes: Uint8Array): { width: number; height: number } {
  return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
}

/** Count graphic control extensions, which is one per written frame. */
function gifFrameCount(bytes: Uint8Array): number {
  let count = 0;
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9) count++;
  }
  return count;
}

describe('animationSequence', () => {
  it('walks every frame in order when there is no tag', () => {
    const sequence = animationSequence(makeSprite(4));
    expect(sequence.name).toBeNull();
    expect(sequence.frames.map((f) => f.index)).toEqual([0, 1, 2, 3]);
    expect(sequence.loops).toBe(true);
    expect(sequence.durationMs).toBe(400);
  });

  it('walks a forward tag', () => {
    const sprite = makeSprite(5, [{ name: 'walk', from: 1, to: 3 }]);
    const sequence = animationSequence(sprite, 'walk');
    expect(sequence.name).toBe('walk');
    expect(sequence.frames.map((f) => f.index)).toEqual([1, 2, 3]);
  });

  it('walks a reverse tag backwards', () => {
    const sprite = makeSprite(5, [{ name: 'walk', from: 1, to: 3, direction: 'reverse' }]);
    expect(animationSequence(sprite, 'walk').frames.map((f) => f.index)).toEqual([3, 2, 1]);
  });

  it('walks a pingpong tag without repeating the endpoints', () => {
    const sprite = makeSprite(5, [{ name: 'bounce', from: 0, to: 3, direction: 'pingpong' }]);
    // 0 1 2 3 then back 2 1 - the endpoints are not drawn twice, or the bounce hitches.
    expect(animationSequence(sprite, 'bounce').frames.map((f) => f.index)).toEqual([0, 1, 2, 3, 2, 1]);
  });

  it('treats repeat 0 as forever and loops once through', () => {
    const sprite = makeSprite(3, [{ name: 'idle', repeat: 0 }]);
    const sequence = animationSequence(sprite, 'idle');
    expect(sequence.loops).toBe(true);
    expect(sequence.frames.map((f) => f.index)).toEqual([0, 1, 2]);
  });

  it('emits a finite repeat that many times and stops looping', () => {
    const sprite = makeSprite(2, [{ name: 'blink', repeat: 3 }]);
    const sequence = animationSequence(sprite, 'blink');
    expect(sequence.loops).toBe(false);
    expect(sequence.frames.map((f) => f.index)).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it('carries each frame duration through', () => {
    const sprite = makeSprite(2);
    sprite.frames[0].durationMs = 80;
    sprite.frames[1].durationMs = 220;
    expect(animationSequence(sprite).frames.map((f) => f.durationMs)).toEqual([80, 220]);
    expect(animationSequence(sprite).durationMs).toBe(300);
  });

  it('rejects an explicitly named tag that does not exist', () => {
    const sprite = makeSprite(3, [{ name: 'idle' }]);
    expect(() => animationSequence(sprite, 'attack')).toThrow(/Unknown animation tag: attack/);
    expect(() => encodeGIF(sprite, { tag: 'attack' })).toThrow(/Unknown animation tag: attack/);
  });

  it('finds a tag by index, id and name', () => {
    const sprite = makeSprite(3, [{ name: 'idle' }]);
    expect(findTag(sprite, 0)?.name).toBe('idle');
    expect(findTag(sprite, sprite.tags[0].id)?.name).toBe('idle');
    expect(findTag(sprite, 'idle')?.name).toBe('idle');
    expect(findTag(sprite, 'nope')).toBeUndefined();
  });
});

describe('encodeGIF', () => {
  it('writes a GIF89a with the sprite dimensions', () => {
    const bytes = encodeGIF(makeSprite(2));
    expect(String.fromCharCode(...bytes.slice(0, 6))).toBe('GIF89a');
    expect(gifSize(bytes)).toEqual({ width: 8, height: 8 });
  });

  it('writes one frame per entry in the sequence', () => {
    expect(gifFrameCount(encodeGIF(makeSprite(3)))).toBe(3);
    const pingpong = makeSprite(4, [{ name: 'bounce', from: 0, to: 3, direction: 'pingpong' }]);
    expect(gifFrameCount(encodeGIF(pingpong, { tag: 'bounce' }))).toBe(6);
  });

  it('scales the canvas up by an integer factor', () => {
    const bytes = encodeGIF(makeSprite(1), { scale: 3 });
    expect(gifSize(bytes)).toEqual({ width: 24, height: 24 });
  });

  it('encodes real pixels without throwing', () => {
    const sprite = makeSprite(2);
    const layer = sprite.layers[0];
    // Paint something opaque so the quantiser has actual colours to work with.
    for (const frame of sprite.frames) {
      const buffer = new PixelBuffer(8, 8);
      buffer.fill('#e43b44');
      frame.cels.set(layer.id, buffer);
    }
    const bytes = encodeGIF(sprite, { background: '#203040' });
    expect(bytes.length).toBeGreaterThan(20);
    expect(String.fromCharCode(...bytes.slice(0, 6))).toBe('GIF89a');
  });
});
