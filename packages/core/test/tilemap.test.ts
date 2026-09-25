import { describe, expect, it } from 'vitest';
import { PixelBuffer } from '../src/buffer.js';
import { createEditor, createSprite } from '../src/index.js';
import { describeCommand } from '../src/commands/catalog.js';
import { tilemapCommands } from '../src/commands/tilemap.js';
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
  strokeTilemap,
  tile16Mask,
  tileCellsBounds,
  tileCount,
  tileIndexAt,
  tileRect,
  tileRows,
  tilemapPixelSize,
  tilemapRegionPixels,
  tilemapTerrain,
  toTiledJson,
} from '../src/tilemap.js';
import type { AutotileTransition, StrokeEdgeOptions } from '../src/tilemap.js';

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

/* ------------------------------------------------------------------ *
 * Stroking terrain
 * ------------------------------------------------------------------ */

/** The cells a stroke painted, as a set of "x,y" keys. */
function paintedKeys(map: TilemapLayer): Set<string> {
  const keys = new Set<string>();
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (map.data[y * map.width + x] !== EMPTY_TILE) keys.add(`${x},${y}`);
    }
  }
  return keys;
}

describe('strokeTilemap', () => {
  it('covers the cells a width-1 brush runs through, and more of them as it widens', () => {
    const map = makeTilemap(12, 8);
    const thin = strokeTilemap(map, [{ x: 2, y: 4 }, { x: 9, y: 4 }], { tiles: [1], jitter: 0 });
    // A width of 1 is a diameter, so it covers exactly the row the path runs along.
    expect(thin.covered).toBe(8);
    expect(thin.painted).toBe(8);
    expect(thin.changed).toBe(8);
    expect(thin.skipped).toBe(0);
    expect(thin.rect).toEqual({ x: 2, y: 4, w: 8, h: 1 });
    expect(thin.edges).toBeNull();

    const wide = makeTilemap(12, 8);
    const fat = strokeTilemap(wide, [{ x: 2, y: 4 }, { x: 9, y: 4 }], { tiles: [1], width: 3, jitter: 0 });
    // Three rows along the path, plus a cell of round cap at each end: a brush is a
    // brush, and a stroke that stops exactly on its last point looks cut off.
    expect(fat.covered).toBe(30);
    // Wider is a superset: every cell the thin brush took is still taken.
    for (const key of paintedKeys(map)) expect(paintedKeys(wide).has(key)).toBe(true);
  });

  it('curves between the points while a straight path stays straight', () => {
    const bend = [{ x: 1, y: 1 }, { x: 5, y: 4 }, { x: 9, y: 2 }];

    const curved = makeTilemap(12, 8);
    strokeTilemap(curved, bend, { tiles: [1], jitter: 0 });
    const linear = makeTilemap(12, 8);
    strokeTilemap(linear, bend, { tiles: [1], smoothing: 'linear', jitter: 0 });

    // Both start and finish on the given points, and both go through the apex.
    for (const map of [curved, linear]) {
      expect(tileIndexAt(map, 1, 1)).toBe(1);
      expect(tileIndexAt(map, 5, 4)).toBe(1);
      expect(tileIndexAt(map, 9, 2)).toBe(1);
    }
    // A spline is not a polyline: the round trip through the points covers a different
    // set of cells, which is the whole reason to smooth a coastline.
    expect([...curved.data]).not.toEqual([...linear.data]);

    // Collinear control points must not drift: a spline through a straight line is that
    // line, or the "smoothed" road has kinks in it for no reason.
    const straightCurve = makeTilemap(12, 8);
    strokeTilemap(straightCurve, [{ x: 1, y: 4 }, { x: 5, y: 4 }, { x: 9, y: 4 }], { tiles: [1], jitter: 0 });
    const straightLine = makeTilemap(12, 8);
    strokeTilemap(straightLine, [{ x: 1, y: 4 }, { x: 5, y: 4 }, { x: 9, y: 4 }], { tiles: [1], smoothing: 'linear', jitter: 0 });
    expect([...straightCurve.data]).toEqual([...straightLine.data]);
  });

  it('keeps a square brush axis-aligned where a round one follows the curve', () => {
    const diagonal = [{ x: 0, y: 0 }, { x: 4, y: 4 }];
    const round = makeTilemap(8, 8);
    strokeTilemap(round, diagonal, { tiles: [1], width: 2, jitter: 0 });
    const square = makeTilemap(8, 8);
    strokeTilemap(square, diagonal, { tiles: [1], width: 2, brush: 'square', jitter: 0 });

    // (2,0) is within a square's reach of the path and outside a circle's.
    expect(tileIndexAt(round, 2, 0)).toBe(EMPTY_TILE);
    expect(tileIndexAt(square, 2, 0)).toBe(1);
    expect(tileIndexAt(square, 0, 2)).toBe(1);
    expect(paintedKeys(square).size).toBeGreaterThan(paintedKeys(round).size);
  });

  it('jitter moves the boundary but never hollows out the middle', () => {
    const path = [{ x: 1, y: 5 }, { x: 14, y: 5 }];
    const clean = makeTilemap(16, 11);
    const plain = strokeTilemap(clean, path, { tiles: [1], width: 5, jitter: 0, seed: 5 });
    const wiggly = makeTilemap(16, 11);
    const rough = strokeTilemap(wiggly, path, { tiles: [1], width: 5, jitter: 0.4, seed: 5 });

    expect(rough.covered).not.toBe(plain.covered);
    // A radius of 2.5 shrinks to at worst 1.5, so the band one cell either side of the
    // path — distance 1 — is still solidly inside it. The wobble is a boundary effect.
    for (let x = 1; x <= 14; x++) {
      for (const y of [4, 5, 6]) expect(tileIndexAt(wiggly, x, y)).toBe(1);
    }
    // Same seed, same wobble: the noise is a function of the cell, not of the scan.
    const again = makeTilemap(16, 11);
    strokeTilemap(again, path, { tiles: [1], width: 5, jitter: 0.4, seed: 5 });
    expect([...again.data]).toEqual([...wiggly.data]);
  });

  it('picks weighted variants by seed', () => {
    const options = {
      tiles: [1, { tile: 2, weight: 1 }, { tile: 3, weight: 6 }],
      jitter: 0,
      seed: 9,
      avoidRepeats: false,
    };
    const map = makeTilemap(64, 4);
    const result = strokeTilemap(map, [{ x: 0, y: 1 }, { x: 63, y: 1 }], options);
    expect(result.painted).toBe(64);

    const counts = [0, 0, 0, 0];
    for (let x = 0; x < 64; x++) counts[map.data[1 * 64 + x]]++;
    // Weight 6 against 1 and 1: the common tile has to dominate, or the weights are noise.
    expect(counts[3]).toBeGreaterThan(counts[1] * 2);
    expect(counts[3]).toBeGreaterThan(counts[2] * 2);
    expect(counts.reduce((a, b) => a + b)).toBe(64);

    // Deterministic: the same seed replays the same terrain, cell for cell.
    const replay = makeTilemap(64, 4);
    strokeTilemap(replay, [{ x: 0, y: 1 }, { x: 63, y: 1 }], options);
    expect([...replay.data]).toEqual([...map.data]);

    // A zero-weight variant is never painted.
    const filtered = makeTilemap(8, 2);
    strokeTilemap(filtered, [{ x: 0, y: 0 }, { x: 7, y: 0 }], {
      tiles: [{ tile: 5, weight: 0 }, { tile: 6, weight: 1 }],
      jitter: 0,
    });
    for (let x = 0; x < 8; x++) expect(tileIndexAt(filtered, x, 0)).toBe(6);
  });

  it('avoids the left and upper neighbour variant when asked', () => {
    const map = makeTilemap(32, 4);
    const options = { tiles: [1, 2, 3], jitter: 0, seed: 3, avoidRepeats: true };
    strokeTilemap(map, [{ x: 0, y: 1 }, { x: 31, y: 1 }], options);
    for (let x = 1; x < 32; x++) {
      expect(tileIndexAt(map, x, 1)).not.toBe(tileIndexAt(map, x - 1, 1));
    }

    // Three variants and only two neighbours to avoid, so an alternative always exists.
    // With repeat avoidance off the same seed is free to pair tiles up.
    const repeats = makeTilemap(32, 4);
    strokeTilemap(repeats, [{ x: 0, y: 1 }, { x: 31, y: 1 }], { ...options, avoidRepeats: false });
    let pairs = 0;
    for (let x = 1; x < 32; x++) if (tileIndexAt(repeats, x, 1) === tileIndexAt(repeats, x - 1, 1)) pairs++;
    expect(pairs).toBeGreaterThan(0);
  });

  it('thins the cover with density, and leaves filled cells alone without replace', () => {
    const options = { tiles: [1], jitter: 0, seed: 4, width: 3 };
    const full = makeTilemap(24, 7);
    const dense = strokeTilemap(full, [{ x: 2, y: 3 }, { x: 21, y: 3 }], { ...options, density: 1 });
    expect(dense.painted).toBe(dense.covered);

    const thin = makeTilemap(24, 7);
    const sparse = strokeTilemap(thin, [{ x: 2, y: 3 }, { x: 21, y: 3 }], { ...options, density: 0.4 });
    // Density thins the cover; it never widens it or paints outside the brush.
    expect(sparse.covered).toBe(dense.covered);
    expect(sparse.painted).toBeLessThan(sparse.covered);
    expect(sparse.painted).toBeGreaterThan(sparse.covered * 0.15);
    expect(sparse.skipped).toBe(sparse.covered - sparse.painted);
    for (const key of paintedKeys(thin)) expect(paintedKeys(full).has(key)).toBe(true);

    const replay = makeTilemap(24, 7);
    const again = strokeTilemap(replay, [{ x: 2, y: 3 }, { x: 21, y: 3 }], { ...options, density: 0.4 });
    expect(again.painted).toBe(sparse.painted);
    expect([...replay.data]).toEqual([...thin.data]);

    const none = makeTilemap(24, 7);
    const empty = strokeTilemap(none, [{ x: 2, y: 3 }, { x: 21, y: 3 }], { ...options, density: 0 });
    expect(empty.painted).toBe(0);
    expect(empty.rect).toBeNull();

    // `replace: false` is the mode that adds terrain without repainting it.
    const kept = makeTilemap(24, 7);
    fillTilemap(kept, 9, { x: 10, y: 2, w: 2, h: 3 });
    const result = strokeTilemap(kept, [{ x: 2, y: 3 }, { x: 21, y: 3 }], { ...options, replace: false });
    for (let y = 2; y < 5; y++) {
      for (let x = 10; x < 12; x++) expect(tileIndexAt(kept, x, y)).toBe(9);
    }
    expect(result.painted).toBe(result.covered - result.skipped);
    expect(result.skipped).toBe(6);
  });

  it('applies edge transitions to the cells the stroke owns', () => {
    // An L of terrain: (1,1)..(4,1) then (4,1)..(4,3).
    const points = [{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 4, y: 3 }];
    const mapping: AutotileTransition[] = [
      { mask: 2, tile: 10 },
      { mask: 1 | 4, tile: 11 },
      { mask: 1, tile: 12 },
    ];
    const map = makeTilemap(8, 6);
    const result = strokeTilemap(map, points, {
      tiles: [1, 2],
      jitter: 0,
      seed: 1,
      edge: { set: 16, transitions: mapping },
    });

    // The three masks the mapping names become their transition tile.
    expect(tileIndexAt(map, 1, 1)).toBe(10);
    expect(tileIndexAt(map, 4, 2)).toBe(11);
    expect(tileIndexAt(map, 4, 3)).toBe(12);
    // The masks it does not name keep the variant the stroke painted.
    expect([1, 2]).toContain(tileIndexAt(map, 2, 1));
    expect(result.edges).toEqual({ applied: 3, unmapped: 3 });
    // And nothing outside the stroke was touched.
    expect(tileIndexAt(map, 0, 0)).toBe(EMPTY_TILE);
  });

  it('leaves terrain the stroke does not own alone', () => {
    const map = makeTilemap(10, 4);
    // Existing terrain to the east of the stroke, and one cell north of its first point.
    fillTilemap(map, 7, { x: 5, y: 1, w: 2, h: 1 });
    strokeTilemap(map, [{ x: 1, y: 1 }, { x: 4, y: 1 }], {
      tiles: [1],
      jitter: 0,
      edge: { set: 16, transitions: [{ mask: 2, tile: 10 }, { mask: 2 | 8, tile: 11 }] },
    });
    // The pre-existing pair is terrain, so the end of the stroke reads as a border, but
    // the border pass only owns what the stroke painted.
    expect(tileIndexAt(map, 4, 1)).toBe(11);
    expect(tileIndexAt(map, 5, 1)).toBe(7);
    expect(tileIndexAt(map, 6, 1)).toBe(7);
  });

  it('does not read its own transition indices back as terrain', () => {
    const mapping: AutotileTransition[] = [
      { mask: 2, tile: 10 },
      { mask: 1 | 4, tile: 11 },
      { mask: 1, tile: 12 },
    ];
    const map = makeTilemap(8, 6);
    strokeTilemap(map, [{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 4, y: 3 }], {
      tiles: [1],
      jitter: 0,
      edge: { set: 16, transitions: mapping },
    });
    const before = [...map.data];

    // A second pass with the same mapping, judged on "any non-empty cell", has to be a
    // no-op. If the masks were read from the transition indices instead, a re-run would
    // see a different terrain and quietly scramble the map.
    const second = autotile(map, tilemapTerrain(map), {
      set: 16,
      transitions: mapping,
      unmapped: 'keep',
    });
    expect(second.changed).toBe(0);
    expect([...map.data]).toEqual(before);
  });

  it('rejects a stroke with no points or no usable tile', () => {
    const map = makeTilemap(4, 4);
    expect(() => strokeTilemap(map, [{ x: 0, y: 0 }], { tiles: [1] })).toThrow(/at least 2 points/);
    expect(() => strokeTilemap(map, [{ x: 0, y: 0 }, { x: 1, y: 1 }], { tiles: [] })).toThrow(
      /at least one entry with a weight above 0/,
    );
    expect(() =>
      strokeTilemap(map, [{ x: 0, y: 0 }, { x: 1, y: 1 }], { tiles: [{ tile: 1, weight: 0 }] }),
    ).toThrow(/at least one entry with a weight above 0/);
  });

  it('bounds a cell set for a caller that has to report it', () => {
    expect(tileCellsBounds([])).toBeNull();
    expect(tileCellsBounds([{ x: 3, y: 1 }, { x: 1, y: 5 }])).toEqual({ x: 1, y: 1, w: 3, h: 5 });
  });
});

describe('blitTilemap blending, cropping and clearing', () => {
  /** A one-tile sheet holding a half-transparent blue. */
  function softTileset(): Tileset {
    const image = new PixelBuffer(8, 8);
    image.fill({ r: 0, g: 0, b: 255, a: 128 });
    return { id: 'soft', name: 'Soft', tileWidth: 8, tileHeight: 8, columns: 1, image };
  }

  it('composites source-over so a semi-transparent edge keeps what is under it', () => {
    const map = makeTilemap(1, 1, 8, 8);
    setTile(map, 0, 0, 0);

    const over = new PixelBuffer(8, 8);
    over.fill({ r: 0, g: 255, b: 0, a: 255 });
    expect(blitTilemap(over, softTileset(), map, { blend: 'over' })).toBe(1);
    const fused = over.getColor(4, 4);
    expect(fused.a).toBe(255);
    // Half blue over green: both surviving channels land near half their maximum.
    expect(Math.abs(fused.g - 128)).toBeLessThanOrEqual(2);
    expect(Math.abs(fused.b - 128)).toBeLessThanOrEqual(2);

    // Copy is the historical behaviour: it replaces, alpha and all.
    const copied = new PixelBuffer(8, 8);
    copied.fill({ r: 0, g: 255, b: 0, a: 255 });
    blitTilemap(copied, softTileset(), map);
    expect(copied.getColor(4, 4)).toEqual({ r: 0, g: 0, b: 255, a: 128 });

    // Opacity scales the source before the composite, not after.
    const faded = new PixelBuffer(8, 8);
    faded.fill({ r: 0, g: 255, b: 0, a: 255 });
    blitTilemap(faded, softTileset(), map, { blend: 'over', opacity: 0.5 });
    expect(faded.getColor(4, 4).g).toBeGreaterThan(fused.g);
  });

  it('only touches the cells inside a rect', () => {
    const tileset = makeTileset(2, 2, 8, 8);
    const map = makeTilemap(4, 2, 8, 8);
    fillTilemap(map, 1);

    const cropped = new PixelBuffer(32, 16);
    expect(blitTilemap(cropped, tileset, map, { rect: { x: 1, y: 0, w: 2, h: 1 } })).toBe(2);
    // The first cell was never asked for, so it is still transparent.
    expect(cropped.data[cropped.index(4, 4) + 3]).toBe(0);
    expect(redAt(cropped, 8, 0)).toBe(2);
    expect(redAt(cropped, 23, 7)).toBe(2);
    // Nothing in the second row either.
    expect(cropped.data[cropped.index(8, 12) + 3]).toBe(0);
  });

  it('clears the region first, so an emptied cell takes its old pixels with it', () => {
    const tileset = makeTileset(2, 2, 8, 8);
    const map = makeTilemap(2, 1, 8, 8);
    setTile(map, 0, 0, 1);
    setTile(map, 1, 0, 1);

    const kept = new PixelBuffer(16, 8);
    blitTilemap(kept, tileset, map);
    expect(redAt(kept, 0, 0)).toBe(2);

    // The cell is empty now. Without a clear it is skipped, and the stale pixels stay.
    setTile(map, 0, 0, EMPTY_TILE);
    const uncleared = kept.clone();
    expect(blitTilemap(uncleared, tileset, map)).toBe(1);
    expect(redAt(uncleared, 0, 0)).toBe(2);

    const cleared = kept.clone();
    expect(blitTilemap(cleared, tileset, map, { clear: true })).toBe(1);
    expect(cleared.data[cleared.index(4, 4) + 3]).toBe(0);
    // The cell that still holds a tile was redrawn, not left cleared.
    expect(redAt(cleared, 12, 4)).toBe(2);
  });

  it('describes the pixel area a tile rect covers', () => {
    const map = makeTilemap(4, 4, 8, 16);
    expect(tilemapRegionPixels(map, { x: 1, y: 2, w: 2, h: 1 }, 3, 5)).toEqual({
      x: 11,
      y: 37,
      w: 16,
      h: 16,
    });
  });
});

describe('autotile with a custom transition mapping', () => {
  it('accepts a partial mapping in any order and falls back to the set layout', () => {
    const map = makeTilemap(3, 3);
    fillTilemap(map, 0, { x: 0, y: 0, w: 2, h: 2 });
    const result = autotile(map, tilemapTerrain(map, [0]), {
      set: 16,
      // Deliberately out of ascending order, and only three of the sixteen masks.
      transitions: [
        { mask: 9, tile: 30 },
        { mask: 3, tile: 31 },
        { mask: 6, tile: 32 },
      ],
    });

    // The three mapped masks landed on their tiles.
    expect(tileIndexAt(map, 1, 1)).toBe(30);
    expect(tileIndexAt(map, 0, 1)).toBe(31);
    expect(tileIndexAt(map, 0, 0)).toBe(32);
    // The rest fell back to `offset + mask`, exactly as a pass with no mapping would.
    expect(tileIndexAt(map, 1, 0)).toBe(12);
    expect(result.matched).toBe(3);
    expect(result.unmapped).toBe(1);
    expect(result.visited).toBe(4);
    expect(result.changed).toBe(4);
    expect(result.changedRect).toEqual({ x: 0, y: 0, w: 2, h: 2 });
  });

  it('leaves an unmasked cell alone when the fallback is keep', () => {
    const map = makeTilemap(3, 3);
    fillTilemap(map, 0, { x: 0, y: 0, w: 2, h: 2 });
    const result = autotile(map, tilemapTerrain(map, [0]), {
      set: 16,
      transitions: [{ mask: 6, tile: 32 }],
      unmapped: 'keep',
    });
    expect(tileIndexAt(map, 0, 0)).toBe(32);
    // The unmapped cells still hold the base terrain the caller laid down.
    expect(tileIndexAt(map, 0, 1)).toBe(0);
    expect(result.matched).toBe(1);
    expect(result.unmapped).toBe(3);
    expect(result.changed).toBe(1);
  });

  it('canonicalises masks for a 47-set and masks to four bits for a 16-set', () => {
    // A 2x2 block in the corner: cell (0,1) sees north, east and the north-east
    // diagonal, which is mask 19 raw and mask 3 in the 16-tile set.
    const shape = (map: TilemapLayer) => fillTilemap(map, 0, { x: 0, y: 0, w: 2, h: 2 });

    const blob = makeTilemap(3, 3);
    shape(blob);
    autotile(blob, tilemapTerrain(blob, [0]), { set: 47, transitions: [{ mask: 19, tile: 40 }] });
    expect(tileIndexAt(blob, 0, 1)).toBe(40);

    // A lone diagonal is not a corner, so 16 canonicalises down to 0 and matches a
    // mapping written for the isolated tile.
    const lonely = makeTilemap(3, 3);
    setTile(lonely, 1, 1, 1);
    const lonelyResult = autotile(lonely, tilemapTerrain(lonely), {
      set: 47,
      transitions: [{ mask: 16, tile: 41 }],
    });
    expect(tileIndexAt(lonely, 1, 1)).toBe(41);
    expect(lonelyResult.matched).toBe(1);

    const simple = makeTilemap(3, 3);
    shape(simple);
    autotile(simple, tilemapTerrain(simple, [0]), { set: 16, transitions: [{ mask: 3, tile: 42 }] });
    expect(tileIndexAt(simple, 0, 1)).toBe(42);
  });

  it('picks a weighted variant per mask and avoids the neighbour already chosen', () => {
    const options: { transitions: AutotileTransition[]; seed: number; avoidRepeats: boolean } = {
      transitions: [
        { mask: 10, tile: 20, weight: 3 },
        { mask: 10, tile: 21, weight: 1 },
      ],
      seed: 21,
      avoidRepeats: true,
    };
    const map = makeTilemap(12, 1);
    fillTilemap(map, 0);
    // A filled row: the ten interior cells see east and west, which is mask 10. The two
    // ends see one neighbour each, so the mapping does not claim them.
    const result = autotile(map, tilemapTerrain(map, [0]), { set: 16, ...options });
    expect(result.matched).toBe(10);
    expect(result.unmapped).toBe(2);
    for (let x = 1; x < 12; x++) {
      expect(tileIndexAt(map, x, 0)).not.toBe(tileIndexAt(map, x - 1, 0));
    }
    for (let x = 1; x < 11; x++) expect([20, 21]).toContain(tileIndexAt(map, x, 0));

    const replay = makeTilemap(12, 1);
    fillTilemap(replay, 0);
    autotile(replay, tilemapTerrain(replay, [0]), { set: 16, ...options });
    expect([...replay.data]).toEqual([...map.data]);
  });

  it('reports matched and unmapped against the visited cells, not against the map', () => {
    const map = makeTilemap(4, 4);
    fillTilemap(map, 0, { x: 1, y: 1, w: 2, h: 2 });
    // Without a mapping the set layout answers every cell, so nothing is unmapped.
    const plain = autotile(map, tilemapTerrain(map, [0]), { set: 16 });
    expect(plain.matched).toBe(plain.visited);
    expect(plain.unmapped).toBe(0);
    expect(plain.changedRect).toEqual({ x: 1, y: 1, w: 2, h: 2 });
  });
});

/* ------------------------------------------------------------------ *
 * Command surface
 * ------------------------------------------------------------------ */

/**
 * A 64x64 level: a 4x4 sheet of 8px tiles cut from the `base` layer, an empty
 * `terrain` layer above it to bake into, and an 8x8 tilemap.
 *
 * Tile `i` has a red channel of `i + 1`, so a pixel names the tile it came from, and the
 * sheet holds 16 tiles — which is what makes a tile index of 16 a useful mistake.
 */
function levelEditor(): ReturnType<typeof createEditor> {
  const editor = createEditor(
    createSprite({ width: 64, height: 64, name: 'Level', layers: ['base', 'terrain'] }),
  );
  for (let i = 0; i < 16; i++) {
    editor.execute('draw_rect', {
      layer: 'base',
      frame: 0,
      rect: { x: (i % 4) * 8, y: Math.floor(i / 4) * 8, w: 8, h: 8 },
      color: { r: i + 1, g: 0, b: 0, a: 255 },
      fill: true,
    });
  }
  editor.execute('create_tileset', {
    layer: 'base',
    frame: 0,
    tileWidth: 8,
    tileHeight: 8,
    columns: 4,
    source: { x: 0, y: 0, w: 32, h: 32 },
    name: 'Terrain',
  });
  editor.execute('add_tilemap', { name: 'Ground', width: 8, height: 8 });
  return editor;
}

/** The cel a named layer holds on frame 0, as the document stands right now. */
function celNamed(editor: ReturnType<typeof createEditor>, name: string): PixelBuffer {
  const layer = editor.sprite.layers.find((l) => l.name === name);
  if (!layer) throw new Error(`No layer named ${name}`);
  const cel = editor.sprite.frames[0].cels.get(layer.id);
  if (!cel) throw new Error(`No cel on layer ${name}`);
  return cel;
}

function hasCel(editor: ReturnType<typeof createEditor>, name: string): boolean {
  const layer = editor.sprite.layers.find((l) => l.name === name)!;
  return editor.sprite.frames[0].cels.has(layer.id);
}

describe('set_tile diagnostics', () => {
  it('names every cell it could not write, and why', () => {
    const editor = levelEditor();
    const result = editor.execute('set_tile', {
      tilemap: 'Ground',
      tiles: [
        { x: 0, y: 0, tile: 3 },
        { x: 99, y: 0, tile: 1 },
        { x: 1, y: 0, tile: 16 },
      ],
    });

    expect(result).toMatchObject({ requested: 3, written: 1, changed: 1, skipped: 2, unchanged: 0 });
    expect(result.changedRect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(result.skippedCells).toEqual([
      { x: 99, y: 0, tile: 1, code: 'out_of_bounds', reason: expect.stringMatching(/outside the 8x8 map/) },
      { x: 1, y: 0, tile: 16, code: 'tile_out_of_range', reason: expect.stringMatching(/past the end/) },
    ]);
    // The cell nobody claimed is still empty: a skipped write leaves no trace.
    expect(editor.execute('get_tilemap', { tilemap: 'Ground', rect: { x: 0, y: 0, w: 2, h: 1 } }).rows[0]).toEqual([3, -1]);
  });

  it('insists on all three of x, y and tile', () => {
    const editor = levelEditor();
    const half = editor.tryExecute('set_tile', { tilemap: 'Ground', x: 1, y: 2 });
    expect(half.ok).toBe(false);
    expect(half.error).toMatch(/all three of `x`, `y` and `tile`/);
    expect(half.error).toMatch(/Missing: tile/);

    expect(editor.execute('set_tile', { tilemap: 'Ground', x: 1, y: 2, tile: 2 })).toMatchObject({
      written: 1,
      changed: 1,
    });
  });

  it('refuses a tile index no sheet could hold', () => {
    const editor = levelEditor();
    const tooLow = editor.tryExecute('set_tile', { tilemap: 'Ground', x: 0, y: 0, tile: -2 });
    expect(tooLow.ok).toBe(false);
    expect(tooLow.error).toMatch(/must be -1 \(clear\) or a tile index of 0 or more, got -2/);
    expect(editor.execute('get_tilemap', { tilemap: 'Ground', rect: { x: 0, y: 0, w: 1, h: 1 } }).rows[0][0]).toBe(-1);
  });

  it('separates cells that changed from cells that already held the tile', () => {
    const editor = levelEditor();
    const result = editor.execute('set_tile', {
      tilemap: 'Ground',
      tiles: [
        { x: 0, y: 0, tile: 1 },
        { x: 0, y: 0, tile: 1 },
        { x: 0, y: 0, tile: 2 },
        { x: 5, y: 5, tile: 4 },
      ],
    });
    expect(result).toMatchObject({
      requested: 4,
      written: 4,
      changed: 3,
      unchanged: 1,
      duplicateWrites: 2,
      changedRect: { x: 0, y: 0, w: 6, h: 6 },
    });
    // Last write wins, as it always has.
    expect(editor.execute('get_tilemap', { tilemap: 'Ground', rect: { x: 0, y: 0, w: 1, h: 1 } }).rows[0][0]).toBe(2);
  });

  it('turns away a batch larger than the limit instead of grinding through it', () => {
    const editor = levelEditor();
    const huge = Array.from({ length: 100_001 }, () => ({ x: 0, y: 0, tile: 1 }));
    const tooMany = editor.tryExecute('set_tile', { tilemap: 'Ground', tiles: huge });
    expect(tooMany.ok).toBe(false);
    expect(tooMany.error).toMatch(/100000 limit/);
  });

  it('says what is missing when a call carries no cells at all', () => {
    const editor = levelEditor();
    expect(editor.execute('set_tile', { tilemap: 'Ground' })).toMatchObject({
      requested: 0,
      written: 0,
      changed: 0,
      reason: expect.stringMatching(/pass `tiles`/),
    });
  });
});

describe('baking tiles into a pixel layer', () => {
  it('creates no cel when no bake was asked for', () => {
    const editor = levelEditor();
    expect(hasCel(editor, 'terrain')).toBe(false);
    editor.execute('set_tile', { tilemap: 'Ground', x: 0, y: 0, tile: 1 });
    expect(hasCel(editor, 'terrain')).toBe(false);
    editor.execute('set_tile', { tilemap: 'Ground', x: 0, y: 0, tile: 2, bake: { layer: 'terrain' } });
    expect(hasCel(editor, 'terrain')).toBe(true);
  });

  it('re-stamps only the cells a fill actually changed', () => {
    const editor = levelEditor();
    const first = editor.execute('fill_tilemap', {
      tilemap: 'Ground',
      tile: 2,
      rect: { x: 0, y: 0, w: 2, h: 2 },
      bake: { layer: 'terrain' },
    });
    expect(first).toMatchObject({ filled: 4, changed: 4, baked: 4, clearedPixels: 4 * 64 });
    expect(first.bakeRect).toEqual({ x: 0, y: 0, w: 2, h: 2 });
    expect(celNamed(editor, 'terrain').getColor(0, 0).r).toBe(3);

    // The same fill again changes nothing, so there is nothing to re-bake. A bake that
    // reported 4 here would be claiming work the map never did.
    const again = editor.execute('fill_tilemap', {
      tilemap: 'Ground',
      tile: 2,
      rect: { x: 0, y: 0, w: 2, h: 2 },
      bake: { layer: 'terrain' },
    });
    expect(again).toMatchObject({ filled: 4, changed: 0, baked: 0, clearedPixels: 0, bakeRect: null });
  });

  it('takes the old pixels with it when a cell is cleared', () => {
    const editor = levelEditor();
    editor.execute('set_tile', { tilemap: 'Ground', x: 1, y: 1, tile: 5, bake: { layer: 'terrain' } });
    const cel = celNamed(editor, 'terrain');
    // Tile 5 has a red channel of 6, and only the one cell was painted.
    expect(cel.getColor(8, 8).r).toBe(6);
    expect(cel.getColor(15, 15).r).toBe(6);
    expect(cel.getColor(24, 24).a).toBe(0);

    const cleared = editor.execute('set_tile', {
      tilemap: 'Ground',
      x: 1,
      y: 1,
      tile: -1,
      bake: { layer: 'terrain' },
    });
    expect(cleared).toMatchObject({ changed: 1, baked: 1, clearedPixels: 64 });
    expect(cleared.bakeRect).toEqual({ x: 1, y: 1, w: 1, h: 1 });
    // A plain copy could not do this: the cell is empty now, so nothing is drawn and the
    // old tile would sit there forever.
    expect(celNamed(editor, 'terrain').getColor(9, 9).a).toBe(0);
  });

  it('uses a tilemap underlay in the same changed-cell bake', () => {
    const editor = levelEditor();
    editor.execute('add_tilemap', { name: 'Base', width: 8, height: 8 });
    editor.execute('fill_tilemap', { tilemap: 'Base', tile: 0, rect: { x: 1, y: 1, w: 1, h: 1 } });
    editor.execute('draw_rect', {
      layer: 'terrain',
      frame: 0,
      rect: { x: 8, y: 8, w: 8, h: 8 },
      color: '#0f0',
      fill: true,
    });

    const baked = editor.execute('set_tile', {
      tilemap: 'Ground',
      x: 1,
      y: 1,
      tile: 1,
      bake: { layer: 'terrain', underlay: 'Base', opacity: 0.5 },
    });
    expect(baked).toMatchObject({ changed: 1, baked: 1, underlay: 'Base' });
    const fused = celNamed(editor, 'terrain').getColor(9, 9);
    expect(fused.r).toBeGreaterThan(0);
    expect(fused.g).toBe(0);
  });

  it('follows an auto-tile pass, and leaves the rest of the cel alone', () => {
    const editor = levelEditor();
    editor.execute('fill_tilemap', {
      tilemap: 'Ground',
      tile: 1,
      rect: { x: 1, y: 1, w: 2, h: 2 },
      bake: { layer: 'terrain' },
    });
    expect(celNamed(editor, 'terrain').getColor(8, 8).r).toBe(2);

    const passed = editor.execute('autotile', {
      tilemap: 'Ground',
      set: 16,
      indices: [1],
      bake: { layer: 'terrain' },
    });
    expect(passed).toMatchObject({ visited: 4, changed: 4, baked: 4, matched: 4 });
    expect(passed.bakeRect).toEqual({ x: 1, y: 1, w: 2, h: 2 });
    // Mask 2|4 for the top-left corner of the block, and the pixels followed the map.
    expect(editor.execute('get_tilemap', { tilemap: 'Ground', rect: { x: 1, y: 1, w: 2, h: 2 } }).rows[0][0]).toBe(2 | 4);
    expect(celNamed(editor, 'terrain').getColor(8, 8).r).toBe(7);
  });

  it('bakes a stroke as it lays it down', () => {
    const editor = levelEditor();
    const result = editor.execute('stroke_tilemap', {
      tilemap: 'Ground',
      points: [{ x: 1, y: 4 }, { x: 4, y: 5 }, { x: 6, y: 3 }],
      tiles: [2, { tile: 3, weight: 2 }],
      width: 2,
      seed: 5,
      jitter: 0,
      bake: { layer: 'terrain' },
    });
    expect(result.painted).toBeGreaterThan(4);
    expect(result.baked).toBe(result.painted);
    expect(result.bakeRect).toEqual(result.rect);
    const cel = celNamed(editor, 'terrain');
    // The first painted cell of the stroke is tile 2 or 3, so red 3 or 4 — never the
    // transparent 0 it would be without the bake.
    expect([3, 4]).toContain(cel.getColor(8, 32).r);
  });

  it('honours the offsets, opacity and frame a bake asks for', () => {
    const editor = createEditor(
      createSprite({ width: 64, height: 64, name: 'Level', layers: ['base'], frames: 2 }),
    );
    for (let i = 0; i < 4; i++) {
      editor.execute('draw_rect', {
        layer: 'base',
        frame: 0,
        rect: { x: (i % 2) * 8, y: Math.floor(i / 2) * 8, w: 8, h: 8 },
        color: { r: 200, g: 0, b: 0, a: 255 },
        fill: true,
      });
    }
    editor.execute('create_tileset', {
      layer: 'base',
      frame: 0,
      tileWidth: 8,
      tileHeight: 8,
      columns: 2,
      source: { x: 0, y: 0, w: 16, h: 16 },
    });
    editor.execute('add_tilemap', { width: 8, height: 8 });

    editor.execute('set_tile', {
      tilemap: 0,
      x: 1,
      y: 1,
      tile: 0,
      bake: { layer: 'base', frame: 1, offsetX: 16, offsetY: 16, opacity: 0.5, blend: 'over' },
    });
    const layerId = editor.sprite.layers[0].id;
    const painted = editor.sprite.frames[1].cels.get(layerId)!;
    // Frame 0 was not touched at all; frame 1 holds the tile at the offset, half opaque.
    expect(painted.getColor(24, 24).r).toBe(200);
    expect(painted.getColor(24, 24).a).toBe(128);
  });

  it('says which argument a half-specified bake is missing', () => {
    const editor = levelEditor();
    const bad = editor.tryExecute('fill_tilemap', { tilemap: 'Ground', tile: 1, bake: { frame: 0 } });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/bake needs a `layer`/);
  });

  it('survives being described as an MCP tool', () => {
    // The zod schema *is* the tool contract, and `toJSONSchema` is what builds it. A
    // schema that cannot be described breaks the MCP server at startup rather than in
    // a test, so the guard belongs next to the commands that grew the new shapes.
    const shape = (name: string) => {
      const command = tilemapCommands.find((entry) => entry.name === name);
      expect(command, name).toBeDefined();
      const described = describeCommand(command!);
      return Object.keys((described.params as { properties?: Record<string, unknown> }).properties ?? {});
    };
    for (const name of ['set_tile', 'fill_tilemap', 'autotile', 'stroke_tilemap']) {
      expect(shape(name), name).toContain('bake');
    }
    // `paint_tilemap` is the bake in its own right, so it grows region and blend
    // arguments instead.
    expect(shape('paint_tilemap')).toEqual(
      expect.arrayContaining(['rect', 'blend', 'opacity', 'clear']),
    );
  });

  it('refuses to bake without a tileset', () => {
    const editor = createEditor(createSprite({ width: 32, height: 32, name: 'Bare' }));
    editor.execute('add_tilemap', { width: 2, height: 2 });
    const bad = editor.tryExecute('fill_tilemap', { tilemap: 0, tile: 1, bake: { layer: 0 } });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/no tileset/);
  });
});

describe('stroke_tilemap command', () => {
  it('paints a curve of weighted variants with a border pass', () => {
    const editor = levelEditor();
    const result = editor.execute('stroke_tilemap', {
      tilemap: 'Ground',
      points: [{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 4, y: 3 }],
      tiles: [2, { tile: 3, weight: 2 }],
      jitter: 0,
      seed: 1,
      edge: {
        set: 16,
        transitions: [
          { mask: 1, tile: 9 },
          { mask: 1 | 4, tile: 10 },
          { mask: 2, tile: 11 },
        ],
      },
    });

    expect(result.painted).toBe(6);
    expect(result.changed).toBe(6);
    expect(result.edges).toEqual({ applied: 3, unmapped: 3 });
    const read = editor.execute('get_tilemap', { tilemap: 'Ground' });
    // (1,1) sees east only, (4,2) sees north and south, (4,3) sees north only.
    expect(read.rows[1][1]).toBe(11);
    expect(read.rows[2][4]).toBe(10);
    expect(read.rows[3][4]).toBe(9);
    // The middle of the run is a base variant: its mask is not in the mapping.
    expect([2, 3]).toContain(read.rows[1][3]);
    // Nothing outside the stroke was written.
    expect(read.rows[0][0]).toBe(-1);
    expect(read.filled).toBe(6);
  });

  it('refuses a tile index the sheet cannot hold', () => {
    const editor = levelEditor();
    const bad = editor.tryExecute('stroke_tilemap', {
      tilemap: 'Ground',
      points: [{ x: 1, y: 1 }, { x: 2, y: 2 }],
      tiles: [40],
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/past the end/);
  });

  it('wants at least two points', () => {
    const editor = levelEditor();
    const bad = editor.tryExecute('stroke_tilemap', {
      tilemap: 'Ground',
      points: [{ x: 1, y: 1 }],
      tiles: [1],
    });
    expect(bad.ok).toBe(false);
  });

  it('replays exactly the same terrain for the same seed', () => {
    const params = {
      tilemap: 'Ground',
      points: [{ x: 1, y: 2 }, { x: 5, y: 4 }, { x: 7, y: 1 }],
      tiles: [1, { tile: 2, weight: 2 }, 3],
      width: 2,
      seed: 77,
    };
    const first = levelEditor();
    const second = levelEditor();
    first.execute('stroke_tilemap', params);
    second.execute('stroke_tilemap', params);
    expect(second.execute('get_tilemap', { tilemap: 'Ground' }).rows).toEqual(
      first.execute('get_tilemap', { tilemap: 'Ground' }).rows,
    );
  });
});

describe('paint_tilemap regions and blending', () => {
  it('paints a region, crops the work, and clears what the map no longer covers', () => {
    const editor = levelEditor();
    editor.execute('fill_tilemap', { tilemap: 'Ground', tile: 1 });
    editor.execute('set_tile', { tilemap: 'Ground', x: 3, y: 3, tile: -1 });

    const whole = editor.execute('paint_tilemap', { tilemap: 'Ground', layer: 'terrain', frame: 0 });
    expect(whole).toMatchObject({ drawn: 63, rect: { x: 0, y: 0, w: 8, h: 8 }, clearedPixels: 0, blend: 'copy' });
    const cel = celNamed(editor, 'terrain');
    expect(cel.getColor(20, 20).r).toBe(2);
    // The empty cell contributes nothing and, without a clear, keeps whatever was there.
    expect(whole.drawn).toBe(63);
    expect(cel.getColor(28, 28).a).toBe(0);

    // Repaint the corner that holds the hole with a clear: the stale tile goes.
    const repainted = editor.execute('paint_tilemap', {
      tilemap: 'Ground',
      layer: 'terrain',
      frame: 0,
      rect: { x: 2, y: 2, w: 3, h: 3 },
      clear: true,
    });
    expect(repainted).toMatchObject({ drawn: 8, clearedPixels: 3 * 3 * 64 });
    const after = celNamed(editor, 'terrain');
    expect(after.getColor(28, 28).a).toBe(0);
    expect(after.getColor(20, 20).r).toBe(2);
    // Outside the rect nothing was touched.
    expect(after.getColor(4, 4).r).toBe(2);
  });

  it('rebuilds a ground underlay before compositing alpha terrain', () => {
    const editor = levelEditor();
    editor.execute('add_tilemap', { name: 'Base', width: 8, height: 8 });
    editor.execute('fill_tilemap', { tilemap: 'Base', tile: 0, rect: { x: 0, y: 0, w: 1, h: 1 } });
    editor.execute('fill_tilemap', { tilemap: 'Ground', tile: 1, rect: { x: 0, y: 0, w: 1, h: 1 } });

    const painted = editor.execute('paint_tilemap', {
      tilemap: 'Ground',
      underlay: 'Base',
      layer: 'terrain',
      frame: 0,
      rect: { x: 0, y: 0, w: 1, h: 1 },
      clear: true,
      blend: 'over',
      opacity: 0.5,
    });
    expect(painted).toMatchObject({ underlay: 'Base', blend: 'over', drawn: 1 });
    const fused = celNamed(editor, 'terrain').getColor(4, 4);
    expect(fused.r).toBeGreaterThan(0);
    // The underlay replaced any old green artwork before the active red tile landed.
    expect(fused.g).toBe(0);
    expect(fused.a).toBe(255);
  });

  it('composites over the artwork underneath when asked', () => {
    const editor = levelEditor();
    editor.execute('draw_rect', {
      layer: 'terrain',
      frame: 0,
      rect: { x: 0, y: 0, w: 64, h: 64 },
      color: { r: 0, g: 255, b: 0, a: 255 },
      fill: true,
    });
    editor.execute('fill_tilemap', { tilemap: 'Ground', tile: 1, rect: { x: 0, y: 0, w: 1, h: 1 } });

    // Copy is the default and it overwrites: the green is gone, replaced outright.
    editor.execute('paint_tilemap', { tilemap: 'Ground', layer: 'terrain', frame: 0 });
    expect(celNamed(editor, 'terrain').getColor(4, 4)).toEqual({ r: 2, g: 0, b: 0, a: 255 });

    // A second cell, still green underneath, composited at half strength.
    editor.execute('set_tile', { tilemap: 'Ground', x: 1, y: 0, tile: 1 });
    editor.execute('paint_tilemap', {
      tilemap: 'Ground',
      layer: 'terrain',
      frame: 0,
      rect: { x: 1, y: 0, w: 1, h: 1 },
      blend: 'over',
      opacity: 0.5,
    });
    const fused = celNamed(editor, 'terrain').getColor(12, 4);
    // Half the tile over green: red arrives, and the green under the tile's own zero
    // channels survives instead of being erased.
    expect(fused.r).toBeGreaterThan(0);
    expect(fused.g).toBeGreaterThan(0);
    expect(fused.a).toBe(255);
  });
});
