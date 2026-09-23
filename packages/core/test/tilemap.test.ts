import { describe, expect, it } from 'vitest';
import { PixelBuffer } from '../src/buffer.js';
import { createEditor, createSprite } from '../src/index.js';
import type { TilemapLayer, Tileset } from '../src/document.js';
import {
  AUTOTILE_16_MASKS,
  AUTOTILE_47_MASKS,
  EMPTY_TILE,
  autotile,
  autotile16Index,
  autotile47Index,
  autotileSheet,
  blitTilemap,
  blob47Mask,
  canonicalBlobMask,
  fillTilemap,
  renderTilemap,
  setTile,
  tile16Mask,
  tileCount,
  tileIndexAt,
  tileRect,
  tileRows,
  tilemapPixelSize,
  tilemapTerrain,
  toTiledJson,
} from '../src/tilemap.js';

/**
 * A tileset whose tile `i` is a solid block with red channel `i + 1`, so a rendered
 * pixel tells you exactly which tile it came from without counting cells.
 */
function makeTileset(columns = 2, rows = 2, tileWidth = 8, tileHeight = 8): Tileset {
  const image = new PixelBuffer(columns * tileWidth, rows * tileHeight);
  for (let i = 0; i < columns * rows; i++) {
    image.fill(
      { r: i + 1, g: 0, b: 0, a: 255 },
      {
        x: (i % columns) * tileWidth,
        y: Math.floor(i / columns) * tileHeight,
        w: tileWidth,
        h: tileHeight,
      },
    );
  }
  return { id: 'tileset', name: 'Test', tileWidth, tileHeight, columns, image };
}

function makeTilemap(width: number, height: number, tileWidth = 8, tileHeight = 8): TilemapLayer {
  return {
    id: 'map',
    name: 'Map',
    width,
    height,
    tileWidth,
    tileHeight,
    data: new Int32Array(width * height).fill(EMPTY_TILE),
  };
}

/** The red channel of one pixel, which identifies the tile it came from. */
function redAt(buffer: PixelBuffer, x: number, y: number): number {
  return buffer.data[buffer.index(x, y)];
}

describe('tileset geometry', () => {
  it('counts rows and tiles from the image size', () => {
    const tileset = makeTileset(4, 3, 8, 8);
    expect(tileRows(tileset)).toBe(3);
    expect(tileCount(tileset)).toBe(12);
  });

  it('maps a tile index to its rect in the sheet', () => {
    const tileset = makeTileset(3, 2, 8, 8);
    expect(tileRect(tileset, 0)).toEqual({ x: 0, y: 0, w: 8, h: 8 });
    expect(tileRect(tileset, 1)).toEqual({ x: 8, y: 0, w: 8, h: 8 });
    expect(tileRect(tileset, 2)).toEqual({ x: 16, y: 0, w: 8, h: 8 });
    expect(tileRect(tileset, 3)).toEqual({ x: 0, y: 8, w: 8, h: 8 });
    expect(tileRect(tileset, 5)).toEqual({ x: 16, y: 8, w: 8, h: 8 });
  });

  it('reports the tilemap size in pixels', () => {
    expect(tilemapPixelSize(makeTilemap(4, 3, 8, 8))).toEqual({ width: 32, height: 24 });
  });
});

describe('tilemap cells', () => {
  it('reads and writes cells, clipping silently outside the map', () => {
    const map = makeTilemap(3, 2);
    expect(tileIndexAt(map, 0, 0)).toBe(EMPTY_TILE);
    expect(setTile(map, 1, 1, 7)).toBe(true);
    expect(tileIndexAt(map, 1, 1)).toBe(7);

    // Out of bounds is a no-op, not a throw.
    expect(setTile(map, -1, 0, 4)).toBe(false);
    expect(setTile(map, 3, 0, 4)).toBe(false);
    expect(setTile(map, 0, 2, 4)).toBe(false);
    expect(tileIndexAt(map, 9, 9)).toBe(EMPTY_TILE);
  });

  it('fills a rect and defaults to the whole map', () => {
    const map = makeTilemap(4, 4);
    expect(fillTilemap(map, 2, { x: 1, y: 1, w: 2, h: 2 })).toBe(4);
    expect(tileIndexAt(map, 1, 1)).toBe(2);
    expect(tileIndexAt(map, 2, 2)).toBe(2);
    expect(tileIndexAt(map, 0, 0)).toBe(EMPTY_TILE);

    expect(fillTilemap(map, 5)).toBe(16);
    expect(tileIndexAt(map, 0, 0)).toBe(5);
  });
});

describe('blitTilemap', () => {
  it('draws each cell at its tile position', () => {
    const tileset = makeTileset(2, 2, 8, 8);
    const map = makeTilemap(3, 2, 8, 8);
    setTile(map, 1, 0, 1);
    setTile(map, 2, 1, 3);

    const target = new PixelBuffer(24, 16);
    expect(blitTilemap(target, tileset, map)).toBe(2);

    // Tile 1 has red 2, at the second cell of the top row.
    expect(redAt(target, 8, 0)).toBe(2);
    expect(redAt(target, 15, 7)).toBe(2);
    // Tile 3 has red 4, bottom-right.
    expect(redAt(target, 16, 8)).toBe(4);
    expect(redAt(target, 23, 15)).toBe(4);
    // Empty cells stay transparent.
    expect(target.data[target.index(0, 0) + 3]).toBe(0);
  });

  it('honours the offset and can replace empty cells', () => {
    const tileset = makeTileset(2, 2, 8, 8);
    const map = makeTilemap(1, 1, 8, 8);
    setTile(map, 0, 0, 1);

    const target = new PixelBuffer(16, 16);
    expect(blitTilemap(target, tileset, map, { offsetX: 4, offsetY: 4 })).toBe(1);
    expect(redAt(target, 4, 4)).toBe(2);

    const filled = new PixelBuffer(8, 8);
    expect(blitTilemap(filled, tileset, makeTilemap(1, 1, 8, 8), { replaceEmpty: 0 })).toBe(1);
    expect(redAt(filled, 0, 0)).toBe(1);
  });

  it('renders a standalone buffer the size of the map', () => {
    const tileset = makeTileset(2, 2, 8, 8);
    const map = makeTilemap(2, 3, 8, 8);
    fillTilemap(map, 1);
    const buffer = renderTilemap(tileset, map);
    expect(buffer.width).toBe(16);
    expect(buffer.height).toBe(24);
    expect(redAt(buffer, 8, 16)).toBe(2);
  });
});

describe('auto-tiling masks', () => {
  it('exposes 16 cardinal masks and 47 canonical blob masks', () => {
    expect(AUTOTILE_16_MASKS).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(AUTOTILE_47_MASKS).toHaveLength(47);
    // Ascending, and every entry is already canonical.
    for (let i = 1; i < AUTOTILE_47_MASKS.length; i++) {
      expect(AUTOTILE_47_MASKS[i]).toBeGreaterThan(AUTOTILE_47_MASKS[i - 1]);
    }
    for (const mask of AUTOTILE_47_MASKS) {
      expect(canonicalBlobMask(mask)).toBe(mask);
    }
  });

  it('drops a diagonal that has no adjacent cardinal', () => {
    // The whole point of 47 vs 256: a lone north-east neighbour is not a corner.
    expect(canonicalBlobMask(16)).toBe(0);
    expect(canonicalBlobMask(16 | 1)).toBe(1); // NE + N keeps N, drops NE (no east)
    expect(canonicalBlobMask(16 | 1 | 2)).toBe(16 | 1 | 2); // NE + N + E is a corner
    expect(canonicalBlobMask(255)).toBe(255);
    expect(canonicalBlobMask(0)).toBe(0);
  });

  it('builds a blob mask from all eight neighbours', () => {
    const map = makeTilemap(3, 3);
    fillTilemap(map, 1);
    const solid = tilemapTerrain(map);

    // The centre sees all eight neighbours.
    expect(blob47Mask(solid, 1, 1)).toBe(255);
    // A corner sees only east, south and south-east.
    expect(blob47Mask(solid, 0, 0)).toBe(2 | 4 | 32);
    // Outside the map counts as empty.
    expect(blob47Mask(solid, -1, -1)).toBe(0);
  });

  it('builds a 16 mask from the four cardinals only', () => {
    const map = makeTilemap(3, 3);
    fillTilemap(map, 1);
    const solid = tilemapTerrain(map);
    expect(tile16Mask(solid, 1, 1)).toBe(15);
    expect(tile16Mask(solid, 0, 0)).toBe(2 | 4);
  });

  it('maps a mask to a tile index with the given offset', () => {
    expect(autotile16Index(0)).toBe(0);
    expect(autotile16Index(15)).toBe(15);
    expect(autotile16Index(0b1011)).toBe(11);
    expect(autotile16Index(15, 32)).toBe(47);

    // A lone diagonal collapses to the isolated tile.
    expect(autotile47Index(16)).toBe(0);
    expect(autotile47Index(0)).toBe(0);
    // All eight neighbours is the last slot.
    expect(autotile47Index(255)).toBe(46);
    expect(autotile47Index(255, 100)).toBe(146);
    // The index always lands inside the 47-tile set.
    for (let mask = 0; mask < 256; mask++) {
      const index = autotile47Index(mask);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(47);
    }
  });

  it('describes a sheet layout that matches the lookup', () => {
    const sheet16 = autotileSheet(16);
    expect(sheet16).toHaveLength(16);
    expect(sheet16[0].mask).toBe(0);
    expect(sheet16[0].index).toBe(0);

    const sheet47 = autotileSheet(47);
    expect(sheet47).toHaveLength(47);
    expect(sheet47[46].mask).toBe(255);
    for (const slot of sheet47) {
      expect(autotile47Index(slot.mask)).toBe(slot.index);
    }
  });
});

describe('autotile', () => {
  it('rewrites the cells of a solid block to their transition tiles', () => {
    const map = makeTilemap(5, 5);
    fillTilemap(map, 0, { x: 1, y: 1, w: 3, h: 3 });

    const result = autotile(map, tilemapTerrain(map), { set: 16, offset: 0 });
    expect(result.set).toBe(16);
    expect(result.changed).toBe(9);

    // The centre is surrounded on all four sides.
    expect(tileIndexAt(map, 2, 2)).toBe(15);
    // The top-left cell of the block has east and south neighbours only.
    expect(tileIndexAt(map, 1, 1)).toBe(2 | 4);
    // Empty cells are untouched.
    expect(tileIndexAt(map, 0, 0)).toBe(EMPTY_TILE);
  });

  it('leaves cells outside the rect alone', () => {
    const map = makeTilemap(4, 4);
    fillTilemap(map, 0);
    autotile(map, tilemapTerrain(map), { set: 16, rect: { x: 0, y: 0, w: 2, h: 2 } });
    // Untouched cells keep the raw tile index 0 rather than a computed one.
    expect(tileIndexAt(map, 3, 3)).toBe(0);
    // The visited corner did get computed: east+south.
    expect(tileIndexAt(map, 0, 0)).toBe(2 | 4);
  });

  it('can restrict which cells are rewritten', () => {
    const map = makeTilemap(3, 3);
    fillTilemap(map, 0);
    const terrain = tilemapTerrain(map);
    // Only the centre is "owned" by this pass, so only it changes.
    const result = autotile(map, terrain, {
      set: 16,
      only: (x, y) => x === 1 && y === 1,
    });
    expect(result.changed).toBe(1);
    expect(tileIndexAt(map, 1, 1)).toBe(15);
    expect(tileIndexAt(map, 0, 0)).toBe(0);
  });

  it('treats only the listed tile indices as terrain', () => {
    const map = makeTilemap(3, 1);
    setTile(map, 0, 0, 1);
    setTile(map, 1, 0, 2);
    setTile(map, 2, 0, 1);
    const terrain = tilemapTerrain(map, [1]);
    expect(terrain(0, 0)).toBe(true);
    expect(terrain(1, 0)).toBe(false);
    // Two solid cells separated by a gap: no cardinals meet.
    const result = autotile(map, terrain, { set: 16 });
    expect(result.changed).toBe(2);
    expect(tileIndexAt(map, 0, 0)).toBe(0);
    expect(tileIndexAt(map, 2, 0)).toBe(0);
  });
});

describe('toTiledJson', () => {
  it('emits a map with the tileset and one layer per tilemap', () => {
    const tileset = makeTileset(2, 2, 8, 8);
    const map = makeTilemap(2, 1, 8, 8);
    setTile(map, 0, 0, 0);
    setTile(map, 1, 0, 3);

    const json = toTiledJson(tileset, [map], { image: 'sheet.png' });

    expect(json.type).toBe('map');
    expect(json.orientation).toBe('orthogonal');
    expect(json.width).toBe(2);
    expect(json.height).toBe(1);
    expect(json.tilewidth).toBe(8);
    expect(json.tileheight).toBe(8);
    expect(json.tilesets).toHaveLength(1);

    const [set] = json.tilesets;
    expect(set.firstgid).toBe(1);
    expect(set.name).toBe('Test');
    expect(set.image).toBe('sheet.png');
    expect(set.imagewidth).toBe(16);
    expect(set.imageheight).toBe(16);
    expect(set.tilecount).toBe(4);
    expect(set.columns).toBe(2);

    expect(json.layers).toHaveLength(1);
    const [layer] = json.layers;
    expect(layer.type).toBe('tilelayer');
    expect(layer.width).toBe(2);
    expect(layer.height).toBe(1);
    // Empty becomes 0; tile n becomes n + firstgid.
    expect(layer.data).toEqual([1, 4]);
  });

  it('turns empty cells into zero and honours firstgid', () => {
    const tileset = makeTileset(2, 2, 8, 8);
    const map = makeTilemap(3, 1, 8, 8);
    setTile(map, 1, 0, 2);

    const json = toTiledJson(tileset, [map], { firstgid: 10 });
    expect(json.tilesets[0].firstgid).toBe(10);
    expect(json.layers[0].data).toEqual([0, 12, 0]);
  });

  it('sizes the map from the largest tilemap', () => {
    const tileset = makeTileset(2, 2, 8, 8);
    const small = makeTilemap(2, 2, 8, 8);
    const big = makeTilemap(5, 3, 8, 8);
    const json = toTiledJson(tileset, [small, big]);
    expect(json.width).toBe(5);
    expect(json.height).toBe(3);
    expect(json.layers.map((layer) => layer.id)).toEqual([1, 2]);
  });
});

describe('tilemap commands', () => {
  /** A 32x32 sprite with a 2x2 grid of 16px tiles drawn on the bottom layer. */
  function spriteWithArt(): ReturnType<typeof createEditor> {
    const editor = createEditor(createSprite({ width: 32, height: 32, name: 'Level' }));
    const colours = ['#ff0000', '#00ff00', '#0000ff', '#ffff00'];
    colours.forEach((color, i) => {
      editor.execute('draw_rect', {
        layer: 0,
        frame: 0,
        rect: { x: (i % 2) * 16, y: Math.floor(i / 2) * 16, w: 16, h: 16 },
        color,
        fill: true,
      });
    });
    return editor;
  }

  it('cuts a tileset out of a layer', () => {
    const editor = spriteWithArt();
    const summary = editor.execute('create_tileset', {
      layer: 0,
      frame: 0,
      tileWidth: 16,
      tileHeight: 16,
      name: 'Terrain',
    });
    expect(summary).toMatchObject({ tiles: 4, columns: 2, rows: 2, width: 32, height: 32 });

    const tileset = editor.sprite.tileset;
    expect(tileset?.name).toBe('Terrain');
    // The second tile is the green one.
    expect(redAt(tileset!.image, 16, 0)).toBe(0);
    expect(tileset!.image.data[tileset!.image.index(16, 0) + 1]).toBe(255);
  });

  it('runs a whole level through the commands', () => {
    const editor = spriteWithArt();
    editor.execute('create_tileset', { layer: 0, frame: 0, tileWidth: 16, tileHeight: 16 });

    const map = editor.execute('add_tilemap', { name: 'Ground', width: 4, height: 3 });
    expect(map).toMatchObject({ name: 'Ground', width: 4, height: 3, index: 0 });

    expect(editor.execute('fill_tilemap', { tilemap: 'Ground', tile: 0 })).toMatchObject({
      filled: 12,
      tile: 0,
    });

    expect(
      editor.execute('set_tile', {
        tilemap: 0,
        tiles: [
          { x: 1, y: 1, tile: 1 },
          { x: 2, y: 1, tile: 2 },
        ],
      }),
    ).toMatchObject({ written: 2, skipped: 0 });

    // A 2x1 terrain of tile 1: the pair sees each other east/west.
    const cleared = makeTilemap(4, 3, 16, 16);
    fillTilemap(cleared, EMPTY_TILE);
    editor.execute('fill_tilemap', { tilemap: 0, tile: EMPTY_TILE });
    editor.execute('set_tile', {
      tilemap: 0,
      tiles: [
        { x: 1, y: 1, tile: 1 },
        { x: 2, y: 1, tile: 1 },
      ],
    });
    expect(editor.execute('autotile', { tilemap: 0, set: 16, indices: [1] })).toMatchObject({
      set: 16,
      changed: 2,
    });

    const read = editor.execute('get_tilemap', { tilemap: 0 });
    expect(read.rows[1][1]).toBe(2); // east neighbour only
    expect(read.rows[1][2]).toBe(8); // west neighbour only

    // Painting the tilemap into a cel writes real pixels. The map is 4x3 tiles of
    // 16px (64x48) but the canvas is only 32x32, so the cell at x=2 falls off the
    // edge and is clipped rather than drawn.
    const painted = editor.execute('paint_tilemap', { tilemap: 0, layer: 0, frame: 0 });
    expect(painted.drawn).toBe(1);
    expect(editor.execute('measure_region', { layer: 0, frame: 0 }).opaque).toBeGreaterThan(0);
  });

  it('reports tilemap stats without fetching the image', () => {
    const editor = spriteWithArt();
    editor.execute('create_tileset', { layer: 0, frame: 0, tileWidth: 16, tileHeight: 16 });
    editor.execute('add_tilemap', { name: 'Ground', width: 3, height: 2 });
    editor.execute('fill_tilemap', { tilemap: 'Ground', tile: 3 });

    const read = editor.execute('get_tilemap', { tilemap: 'Ground' });
    expect(read).toMatchObject({ name: 'Ground', width: 3, height: 2, filled: 6, cells: 6 });
    expect(read.rows).toEqual([
      [3, 3, 3],
      [3, 3, 3],
    ]);
  });

  it('resizes a tilemap and keeps the cells that fit', () => {
    const editor = spriteWithArt();
    editor.execute('create_tileset', { layer: 0, frame: 0, tileWidth: 16, tileHeight: 16 });
    editor.execute('add_tilemap', { width: 2, height: 2 });
    editor.execute('set_tile', { tilemap: 0, x: 1, y: 1, tile: 2 });

    expect(
      editor.execute('resize_tilemap', { tilemap: 0, width: 4, height: 4, offsetX: 1, offsetY: 1 }),
    ).toMatchObject({ kept: 4, width: 4, height: 4 });
    const read = editor.execute('get_tilemap', { tilemap: 0 });
    expect(read.rows[2][2]).toBe(2);
    expect(read.filled).toBe(1);
  });

  it('removes a tilemap', () => {
    const editor = spriteWithArt();
    editor.execute('create_tileset', { layer: 0, frame: 0, tileWidth: 16, tileHeight: 16 });
    editor.execute('add_tilemap', { name: 'Ground', width: 2, height: 2 });
    expect(editor.execute('remove_tilemap', { tilemap: 'Ground' })).toMatchObject({
      removed: 'Ground',
      index: 0,
    });
    expect(editor.sprite.tilemaps).toEqual([]);
  });

  it('undoes a tilemap edit', () => {
    const editor = spriteWithArt();
    editor.execute('create_tileset', { layer: 0, frame: 0, tileWidth: 16, tileHeight: 16 });
    editor.execute('add_tilemap', { width: 2, height: 2 });
    editor.execute('fill_tilemap', { tilemap: 0, tile: 1 });
    expect(editor.execute('get_tilemap', { tilemap: 0 }).filled).toBe(4);

    editor.undo();
    // The undo snapshot shares the Int32Array, so this only passes if the command
    // went through the copy-on-write accessor.
    expect(editor.execute('get_tilemap', { tilemap: 0 }).filled).toBe(0);
  });

  it('refuses to cut a tileset from an empty layer', () => {
    const editor = createEditor(createSprite({ width: 32, height: 32, name: 'Empty' }));
    const result = editor.tryExecute('create_tileset', { layer: 0, frame: 0, tileWidth: 16, tileHeight: 16 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/nothing drawn/i);
  });

  it('reports an unknown tilemap by name', () => {
    const editor = spriteWithArt();
    const result = editor.tryExecute('set_tile', { tilemap: 'Nope', x: 0, y: 0, tile: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown tilemap: Nope/);
  });
});
