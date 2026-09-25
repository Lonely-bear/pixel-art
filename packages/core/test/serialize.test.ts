import { describe, expect, it } from 'vitest';
import { PixelBuffer } from '../src/buffer.js';
import { createSprite, type Sprite } from '../src/document.js';
import { makeId } from '../src/ids.js';
import { createPalette } from '../src/palette.js';
import { deserializeSprite, serializeSprite } from '../src/serialize.js';

function buildSprite(): Sprite {
  const sprite = createSprite({
    width: 4,
    height: 4,
    name: 'Hero',
    palette: createPalette('Hero', ['#000000', '#ff0000', '#00ff00']),
  });

  const baseId = sprite.layers[0].id;
  const topId = makeId('layer');
  sprite.layers.push({
    id: topId,
    name: 'Shading',
    visible: true,
    locked: false,
    opacity: 0.5,
    blendMode: 'multiply',
  });

  const secondFrameId = makeId('frame');
  sprite.frames.push({ id: secondFrameId, durationMs: 150, cels: new Map() });

  const base0 = PixelBuffer.filled(4, 4, { r: 255, g: 0, b: 0, a: 255 });
  base0.setColor(0, 0, { r: 0, g: 0, b: 0, a: 255 });
  sprite.frames[0].cels.set(baseId, base0);
  sprite.frames[1].cels.set(baseId, PixelBuffer.filled(4, 4, { r: 0, g: 255, b: 0, a: 255 }));

  const shade = new PixelBuffer(4, 4);
  shade.setColor(3, 3, { r: 0, g: 0, b: 128, a: 255 });
  sprite.frames[1].cels.set(topId, shade);

  sprite.frames[0].durationMs = 120;
  sprite.tags.push({
    id: makeId('tag'),
    name: 'idle',
    from: 0,
    to: 1,
    direction: 'pingpong',
    repeat: 0,
  });

  return sprite;
}

describe('serialize', () => {
  it('round-trips structure, pixels, palette and tags', () => {
    const sprite = buildSprite();
    const restored = deserializeSprite(serializeSprite(sprite));

    expect(restored.id).toBe(sprite.id);
    expect(restored.name).toBe('Hero');
    expect(restored.width).toBe(4);
    expect(restored.height).toBe(4);

    expect(restored.layers.map((l) => l.name)).toEqual(['Layer 1', 'Shading']);
    expect(restored.layers[1].opacity).toBeCloseTo(0.5);
    expect(restored.layers[1].blendMode).toBe('multiply');

    expect(restored.frames.map((f) => f.durationMs)).toEqual([120, 150]);

    expect(restored.palette.colors.map((c) => c.r)).toEqual([0, 255, 0]);
    expect(restored.tags).toHaveLength(1);
    expect(restored.tags[0]).toMatchObject({
      name: 'idle',
      from: 0,
      to: 1,
      direction: 'pingpong',
      repeat: 0,
    });

    const baseId = restored.layers[0].id;
    const topId = restored.layers[1].id;
    const f0 = restored.frames[0].cels.get(baseId);
    expect(f0?.isEqualTo(sprite.frames[0].cels.get(sprite.layers[0].id)!)).toBe(true);
    expect(restored.frames[1].cels.get(baseId)?.getColor(1, 1).g).toBe(255);
    expect(restored.frames[1].cels.get(topId)?.getColor(3, 3)).toEqual({
      r: 0,
      g: 0,
      b: 128,
      a: 255,
    });
    // The empty cel on frame 0 was skipped, so it comes back absent rather than as garbage.
    expect(restored.frames[0].cels.has(topId)).toBe(false);
  });

  it('round-trips tilesets, tilemaps, tile properties and map objects', () => {
    const sprite = buildSprite();
    sprite.tileset = {
      id: makeId('tileset'),
      name: 'Terrain',
      tileWidth: 2,
      tileHeight: 2,
      columns: 2,
      image: PixelBuffer.filled(4, 2, { r: 30, g: 90, b: 40, a: 255 }),
      tileProperties: {
        '0': { walkable: true, kind: 'grass' },
        '1': { walkable: false, moveSpeed: 0.5 },
      },
    };
    sprite.tilemaps = [{
      id: makeId('tilemap'),
      name: 'Ground',
      width: 2,
      height: 1,
      tileWidth: 2,
      tileHeight: 2,
      data: Int32Array.from([0, 1]),
    }];
    sprite.mapObjects = [{
      id: makeId('obj'),
      name: 'Gate trigger',
      type: 'trigger',
      x: 3,
      y: 1,
      width: 2,
      height: 2,
      rotation: 0,
      visible: true,
      properties: { action: 'open', once: true },
    }];

    const restored = deserializeSprite(serializeSprite(sprite));
    expect(restored.tileset?.tileProperties).toEqual(sprite.tileset?.tileProperties);
    expect(Array.from(restored.tilemaps?.[0].data ?? [])).toEqual([0, 1]);
    expect(restored.mapObjects).toEqual(sprite.mapObjects);
  });

  it('rejects a payload that is not a sprite container', () => {
    expect(() => deserializeSprite(new Uint8Array([1, 2, 3, 4]))).toThrow();
  });
});
