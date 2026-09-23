import { describe, expect, it } from 'vitest';
import { PixelBuffer } from '../src/buffer.js';
import { createSprite } from '../src/document.js';
import { buildSpritesheet, scaleAtlas, sliceAnimations, toAsepriteJson } from '../src/atlas.js';

function makeSprite() {
  const sprite = createSprite({ width: 8, height: 8, name: 'Slime' });
  const layerId = sprite.layers[0].id;
  for (let i = 0; i < 4; i++) {
    if (i > 0) sprite.frames.push({ id: `f${i}`, durationMs: 100, cels: new Map() });
    const cel = new PixelBuffer(8, 8);
    cel.fill({ r: 0, g: 0, b: 0, a: 0 });
    cel.setColor(i, 0, { r: 255, g: 0, b: 0, a: 255 });
    sprite.frames[i].cels.set(layerId, cel);
    sprite.frames[i].durationMs = 100;
  }
  sprite.tags.push({ id: 't1', name: 'idle', from: 0, to: 1, direction: 'forward', repeat: 0 });
  sprite.tags.push({ id: 't2', name: 'run', from: 2, to: 3, direction: 'pingpong', repeat: 2 });
  return sprite;
}

describe('buildSpritesheet', () => {
  it('lays frames out horizontally by default', () => {
    const atlas = buildSpritesheet(makeSprite());
    expect(atlas.columns).toBe(4);
    expect(atlas.rows).toBe(1);
    expect(atlas.width).toBe(32);
    expect(atlas.height).toBe(8);
    expect(atlas.frames.map((f) => f.x)).toEqual([0, 8, 16, 24]);
  });

  it('wraps frames into a grid with padding and margin', () => {
    const atlas = buildSpritesheet(makeSprite(), { layout: 'grid', columns: 2, padding: 1, margin: 2 });
    expect(atlas.columns).toBe(2);
    expect(atlas.rows).toBe(2);
    expect(atlas.width).toBe(2 * 2 + 2 * 8 + 1);
    expect(atlas.height).toBe(2 * 2 + 2 * 8 + 1);
    expect(atlas.frames[0]).toMatchObject({ x: 2, y: 2 });
    expect(atlas.frames[1]).toMatchObject({ x: 11, y: 2 });
    expect(atlas.frames[2]).toMatchObject({ x: 2, y: 11 });
  });

  it('blits the composited frame content at the right place', () => {
    const atlas = buildSpritesheet(makeSprite());
    expect(atlas.image.getColor(0, 0).r).toBe(255);
    expect(atlas.image.getColor(1, 0).a).toBe(0);
    expect(atlas.image.getColor(9, 0).r).toBe(255);
  });
});

describe('toAsepriteJson', () => {
  it('emits the shape engines expect', () => {
    const sprite = makeSprite();
    const atlas = buildSpritesheet(sprite);
    const json = toAsepriteJson(sprite, atlas, 'slime.png') as any;

    expect(json.meta.image).toBe('slime.png');
    expect(json.meta.size).toEqual({ w: 32, h: 8 });
    expect(json.meta.format).toBe('RGBA8888');
    expect(Object.keys(json.frames)).toEqual([
      'Slime 0.png',
      'Slime 1.png',
      'Slime 2.png',
      'Slime 3.png',
    ]);
    expect(json.frames['Slime 1.png'].frame).toEqual({ x: 8, y: 0, w: 8, h: 8 });
    expect(json.frames['Slime 1.png'].duration).toBe(100);
    expect(json.meta.frameTags).toEqual([
      { name: 'idle', from: 0, to: 1, direction: 'forward' },
      { name: 'run', from: 2, to: 3, direction: 'pingpong' },
    ]);
    expect(json.meta.layers[0].name).toBe('Layer 1');
    expect(json.meta.layers[0].opacity).toBe(255);
  });
});

describe('sliceAnimations', () => {
  it('groups sheet frames by tag', () => {
    const sprite = makeSprite();
    const atlas = buildSpritesheet(sprite);
    const slices = sliceAnimations(sprite, atlas);
    expect(slices).toHaveLength(2);
    expect(slices[0].frames.map((f) => f.index)).toEqual([0, 1]);
    expect(slices[1].frames.map((f) => f.index)).toEqual([2, 3]);
    expect(slices[1].repeat).toBe(2);
  });
});

describe('scaleAtlas', () => {
  it('grows the image, the sheet size and the frame rects together', () => {
    const sprite = makeSprite();
    const atlas = buildSpritesheet(sprite);
    const scaled = scaleAtlas(atlas, 2);

    expect(scaled.image.width).toBe(atlas.width * 2);
    expect(scaled.image.height).toBe(atlas.height * 2);
    expect(scaled.width).toBe(atlas.width * 2);
    expect(scaled.height).toBe(atlas.height * 2);

    // The whole point: the exported JSON must describe the PNG that was written.
    const json = toAsepriteJson(sprite, scaled, 'sheet.png');
    expect(json.meta.size).toEqual({ w: scaled.image.width, h: scaled.image.height });
    expect(json.frames['Slime 1.png'].frame).toEqual({ x: 16, y: 0, w: 16, h: 16 });
  });

  it('is a no-op at factor 1 and rejects nonsense factors', () => {
    const atlas = buildSpritesheet(makeSprite());
    expect(scaleAtlas(atlas, 1)).toBe(atlas);
    expect(() => scaleAtlas(atlas, 0)).toThrow(RangeError);
    expect(() => scaleAtlas(atlas, 1.5)).toThrow(RangeError);
  });
});
