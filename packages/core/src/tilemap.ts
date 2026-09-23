import { PixelBuffer } from './buffer.js';
import { clipRect } from './geometry.js';
import type { TilemapLayer, Tileset } from './document.js';
import type { Point, Rect } from './types.js';

/** A tilemap cell with nothing in it. */
export const EMPTY_TILE = -1;

/* ------------------------------------------------------------------ *
 * Tileset geometry
 * ------------------------------------------------------------------ */

/** Number of tile rows the tileset image holds. */
export function tileRows(tileset: Tileset): number {
  return Math.max(0, Math.floor(tileset.image.height / tileset.tileHeight));
}

/** Number of tiles the tileset image holds. */
export function tileCount(tileset: Tileset): number {
  return Math.max(0, tileset.columns) * tileRows(tileset);
}

/**
 * Source rect of a tile inside the tileset image.
 *
 * Out-of-range indices are not an error: the rect is computed anyway and simply falls
 * outside the image, which the blitter then clips. Reporting the position is more useful
 * to a caller than a throw, and it keeps `set_tile` from having to bounds-check twice.
 */
export function tileRect(tileset: Tileset, index: number): Rect {
  const columns = Math.max(1, tileset.columns);
  const col = index % columns;
  const row = Math.floor(index / columns);
  return {
    x: col * tileset.tileWidth,
    y: row * tileset.tileHeight,
    w: tileset.tileWidth,
    h: tileset.tileHeight,
  };
}

/** Pixel size of a tilemap. */
export function tilemapPixelSize(tilemap: TilemapLayer): { width: number; height: number } {
  return { width: tilemap.width * tilemap.tileWidth, height: tilemap.height * tilemap.tileHeight };
}

/* ------------------------------------------------------------------ *
 * Reading and writing cells
 * ------------------------------------------------------------------ */

/** Tile index at a cell, or `EMPTY_TILE` outside the map. */
export function tileIndexAt(tilemap: TilemapLayer, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= tilemap.width || y >= tilemap.height) return EMPTY_TILE;
  return tilemap.data[y * tilemap.width + x];
}

/** Write one cell. Returns false when the cell is outside the map. */
export function setTile(tilemap: TilemapLayer, x: number, y: number, index: number): boolean {
  if (x < 0 || y < 0 || x >= tilemap.width || y >= tilemap.height) return false;
  tilemap.data[y * tilemap.width + x] = index;
  return true;
}

/**
 * Write every cell in a rect (default: the whole map).
 *
 * A rect whose `w` or `h` is negative is normalised first, so `{x:5,y:5,w:-3,h:-3}` means
 * the same as `{x:2,y:2,w:3,h:3}` — the same rule the drawing commands use.
 */
export function fillTilemap(tilemap: TilemapLayer, index: number, rect?: Rect): number {
  const r = rect
    ? clipRect(
        {
          x: Math.min(rect.x, rect.x + rect.w),
          y: Math.min(rect.y, rect.y + rect.h),
          w: Math.abs(rect.w),
          h: Math.abs(rect.h),
        },
        tilemap.width,
        tilemap.height,
      )
    : { x: 0, y: 0, w: tilemap.width, h: tilemap.height };

  let filled = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    const row = y * tilemap.width;
    for (let x = r.x; x < r.x + r.w; x++) {
      tilemap.data[row + x] = index;
      filled++;
    }
  }
  return filled;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

export interface BlitTilemapOptions {
  /** Pixel offset of the map's top-left corner. */
  offsetX?: number;
  offsetY?: number;
  /** Draw this index instead of skipping empty cells. Defaults to skipping. */
  replaceEmpty?: number | null;
}

/**
 * Compose a tilemap into a buffer, so a level can be previewed or exported as a PNG.
 *
 * Cells are blitted in row order and empty cells are skipped, which is what makes a
 * tilemap over a transparent canvas read as a level rather than a grid of holes.
 */
export function blitTilemap(
  target: PixelBuffer,
  tileset: Tileset,
  tilemap: TilemapLayer,
  opts: BlitTilemapOptions = {},
): number {
  const ox = Math.round(opts.offsetX ?? 0);
  const oy = Math.round(opts.offsetY ?? 0);
  const empty = opts.replaceEmpty ?? null;
  let drawn = 0;
  for (let ty = 0; ty < tilemap.height; ty++) {
    for (let tx = 0; tx < tilemap.width; tx++) {
      let index = tilemap.data[ty * tilemap.width + tx];
      if (index === EMPTY_TILE) {
        if (empty === null) continue;
        index = empty;
      }
      const src = tileRect(tileset, index);
      const dx = ox + tx * tilemap.tileWidth;
      const dy = oy + ty * tilemap.tileHeight;
      // `blitRegion` clips silently and reports nothing, so the count is taken from the
      // destination geometry: a cell counts when any part of it lands on the target.
      const dest = clipRect(
        { x: dx, y: dy, w: tilemap.tileWidth, h: tilemap.tileHeight },
        target.width,
        target.height,
      );
      if (dest.w <= 0 || dest.h <= 0) continue;
      target.blitRegion(tileset.image, src, dx, dy);
      drawn++;
    }
  }
  return drawn;
}

/** A tilemap rendered to its own buffer. */
export function renderTilemap(
  tileset: Tileset,
  tilemap: TilemapLayer,
  opts: BlitTilemapOptions = {},
): PixelBuffer {
  const size = tilemapPixelSize(tilemap);
  const buffer = new PixelBuffer(Math.max(1, size.width), Math.max(1, size.height));
  blitTilemap(buffer, tileset, tilemap, opts);
  return buffer;
}

/* ------------------------------------------------------------------ *
 * Auto-tiling
 *
 * The bit order is fixed and documented because the whole feature is a convention:
 * a tileset drawn for one bit order is meaningless under another. `N` is up, `y` grows
 * downward, matching every other coordinate in this codebase.
 * ------------------------------------------------------------------ */

export const AUTOTILE_BITS = {
  N: 1,
  E: 2,
  S: 4,
  W: 8,
  NE: 16,
  SE: 32,
  SW: 64,
  NW: 128,
} as const;

/** `true` when a cell counts as the same terrain. */
export type TerrainTest = (x: number, y: number) => boolean;

/**
 * A terrain test for a tilemap: non-empty cells of the given indices.
 *
 * Omitting `indices` means "any non-empty cell", which is the common case of one terrain
 * covering a level.
 */
export function tilemapTerrain(tilemap: TilemapLayer, indices?: readonly number[]): TerrainTest {
  const allow = indices ? new Set(indices) : null;
  return (x, y) => {
    const index = tileIndexAt(tilemap, x, y);
    if (index === EMPTY_TILE) return false;
    return allow ? allow.has(index) : true;
  };
}

/**
 * 8-bit blob mask for a cell.
 *
 * A diagonal only counts when **both** of its adjacent cardinal neighbours do. That rule
 * is what turns 256 combinations into the canonical 47: without it, a lone diagonal
 * neighbour would need a tile that no blob set contains.
 */
export function blob47Mask(test: TerrainTest, x: number, y: number): number {
  const n = test(x, y - 1);
  const e = test(x + 1, y);
  const s = test(x, y + 1);
  const w = test(x - 1, y);
  let mask = 0;
  if (n) mask |= AUTOTILE_BITS.N;
  if (e) mask |= AUTOTILE_BITS.E;
  if (s) mask |= AUTOTILE_BITS.S;
  if (w) mask |= AUTOTILE_BITS.W;
  if (n && e && test(x + 1, y - 1)) mask |= AUTOTILE_BITS.NE;
  if (s && e && test(x + 1, y + 1)) mask |= AUTOTILE_BITS.SE;
  if (s && w && test(x - 1, y + 1)) mask |= AUTOTILE_BITS.SW;
  if (n && w && test(x - 1, y - 1)) mask |= AUTOTILE_BITS.NW;
  return mask;
}

/** 4-bit mask from the cardinal neighbours only, for a 16-tile transition set. */
export function tile16Mask(test: TerrainTest, x: number, y: number): number {
  let mask = 0;
  if (test(x, y - 1)) mask |= AUTOTILE_BITS.N;
  if (test(x + 1, y)) mask |= AUTOTILE_BITS.E;
  if (test(x, y + 1)) mask |= AUTOTILE_BITS.S;
  if (test(x - 1, y)) mask |= AUTOTILE_BITS.W;
  return mask;
}

/** Drop diagonal bits whose two cardinals are not both set. */
export function canonicalBlobMask(mask: number): number {
  let out = mask & 0b1111;
  if ((mask & AUTOTILE_BITS.NE) && (mask & AUTOTILE_BITS.N) && (mask & AUTOTILE_BITS.E)) out |= AUTOTILE_BITS.NE;
  if ((mask & AUTOTILE_BITS.SE) && (mask & AUTOTILE_BITS.S) && (mask & AUTOTILE_BITS.E)) out |= AUTOTILE_BITS.SE;
  if ((mask & AUTOTILE_BITS.SW) && (mask & AUTOTILE_BITS.S) && (mask & AUTOTILE_BITS.W)) out |= AUTOTILE_BITS.SW;
  if ((mask & AUTOTILE_BITS.NW) && (mask & AUTOTILE_BITS.N) && (mask & AUTOTILE_BITS.W)) out |= AUTOTILE_BITS.NW;
  return out;
}

/**
 * The 16 canonical masks of a 4-neighbour transition set, in ascending order.
 *
 * Ascending numeric order is the convention this codebase uses, and it is the one a
 * generated sheet is laid out in: index 0 is an isolated tile, index 15 is fully
 * surrounded. `N=1, E=2, S=4, W=8`.
 */
export const AUTOTILE_16_MASKS: readonly number[] = Array.from({ length: 16 }, (_, i) => i);

/**
 * The 47 canonical masks of an 8-neighbour blob set, in ascending order.
 *
 * Derived rather than hand-typed: enumerating 0..255 and keeping the masks that are
 * already canonical yields exactly the 47 combinations a blob tileset needs, in a
 * reproducible order that a sheet generator and the lookup table can share.
 */
export const AUTOTILE_47_MASKS: readonly number[] = (() => {
  const masks: number[] = [];
  for (let mask = 0; mask < 256; mask++) {
    if (canonicalBlobMask(mask) === mask) masks.push(mask);
  }
  return masks;
})();

const BLOB_47_LOOKUP: Int32Array = (() => {
  const table = new Int32Array(256);
  for (let mask = 0; mask < 256; mask++) {
    table[mask] = AUTOTILE_47_MASKS.indexOf(canonicalBlobMask(mask));
  }
  return table;
})();

/**
 * Tile index for a 4-neighbour transition set.
 *
 * `offset` is the first tile of the set inside the sheet, so several terrains can share
 * one image by passing `terrainIndex * 16`.
 */
export function autotile16Index(mask: number, offset = 0): number {
  return offset + (mask & 0b1111);
}

/**
 * Tile index for a 47-tile blob set.
 *
 * `offset` is the first tile of the set inside the sheet; a 47-blob terrain occupies
 * 47 consecutive tiles. Non-canonical masks (a diagonal without both cardinals) collapse
 * to their canonical form instead of returning nothing.
 */
export function autotile47Index(mask: number, offset = 0): number {
  return offset + BLOB_47_LOOKUP[canonicalBlobMask(mask) & 0xff];
}

export interface AutotileOptions {
  /** Which set the sheet is laid out for. Defaults to `47`. */
  set?: 16 | 47;
  /** First tile of this terrain inside the sheet. Defaults to 0. */
  offset?: number;
  /** Restrict the pass to this cell rect. Defaults to the whole map. */
  rect?: Rect;
  /**
   * Only rewrite cells that currently pass this test.
   *
   * Defaults to the terrain test itself, which is almost always what you want: an
   * auto-tile pass re-shapes the cells that are already terrain and leaves the empty
   * background alone. Override it to narrow the pass to a region of the terrain.
   */
  only?: TerrainTest;
  /**
   * Skip cells whose mask has no set bits.
   *
   * An isolated cell is still terrain, so this defaults to false: a lone tile gets the
   * isolated tile of the set, which is usually what you want. Set it to true when the
   * caller has its own idea of what an empty cell looks like.
   */
  skipIsolated?: boolean;
}

export interface AutotileResult {
  /** Cells whose index changed. */
  changed: number;
  /** Cells examined. */
  visited: number;
  set: 16 | 47;
  offset: number;
}

/**
 * Recompute the transition tiles of a terrain in place.
 *
 * This is the tilemap equivalent of `outline`: the caller says *where* the terrain is,
 * and the tool works out which of the 16 or 47 transition tiles each cell needs. Doing
 * it by hand is the single most tedious part of building a tileset level, and it is the
 * part an agent is worst at.
 */
export function autotile(
  tilemap: TilemapLayer,
  terrain: TerrainTest,
  opts: AutotileOptions = {},
): AutotileResult {
  const set = opts.set ?? 47;
  const offset = opts.offset ?? 0;
  const r = opts.rect
    ? clipRect(
        {
          x: Math.min(opts.rect.x, opts.rect.x + opts.rect.w),
          y: Math.min(opts.rect.y, opts.rect.y + opts.rect.h),
          w: Math.abs(opts.rect.w),
          h: Math.abs(opts.rect.h),
        },
        tilemap.width,
        tilemap.height,
      )
    : { x: 0, y: 0, w: tilemap.width, h: tilemap.height };

  // Snapshot the terrain before writing. The masks are read from the same array we are
  // about to overwrite, so a cell evaluated after its neighbour was re-indexed would see
  // the neighbour as empty ground and the result would depend on scan order.
  const solid = new Uint8Array(tilemap.width * tilemap.height);
  for (let y = 0; y < tilemap.height; y++) {
    for (let x = 0; x < tilemap.width; x++) {
      if (terrain(x, y)) solid[y * tilemap.width + x] = 1;
    }
  }
  const snapshot: TerrainTest = (x, y) =>
    x >= 0 && y >= 0 && x < tilemap.width && y < tilemap.height && solid[y * tilemap.width + x] === 1;

  let changed = 0;
  let visited = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      // Only cells that belong to the terrain are rewritten. Without this a pass would
      // stamp the set's isolated tile over every empty cell in the rect, turning the
      // map's background into solid ground.
      const owner = opts.only ?? terrain;
      if (!owner(x, y)) continue;
      const mask = set === 16 ? tile16Mask(snapshot, x, y) : blob47Mask(snapshot, x, y);
      if (mask === 0 && opts.skipIsolated) continue;
      visited++;
      const index = set === 16 ? autotile16Index(mask, offset) : autotile47Index(mask, offset);
      const at = y * tilemap.width + x;
      if (tilemap.data[at] !== index) {
        tilemap.data[at] = index;
        changed++;
      }
    }
  }
  return { changed, visited, set, offset };
}

/* ------------------------------------------------------------------ *
 * Tiled export
 * ------------------------------------------------------------------ */

export interface TiledTilesetJson {
  firstgid: number;
  name: string;
  image: string;
  imagewidth: number;
  imageheight: number;
  tilewidth: number;
  tileheight: number;
  tilecount: number;
  columns: number;
  margin: number;
  spacing: number;
}

export interface TiledLayerJson {
  id: number;
  name: string;
  type: 'tilelayer';
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  visible: boolean;
  data: number[];
}

export interface TiledMapJson {
  type: 'map';
  version: string;
  tiledversion: string;
  orientation: 'orthogonal';
  renderorder: 'right-down';
  infinite: false;
  compressionlevel: number;
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  nextlayerid: number;
  nextobjectid: number;
  tilesets: TiledTilesetJson[];
  layers: TiledLayerJson[];
}

export interface TiledExportOptions {
  /** File name to reference in `tilesets[].image`. Defaults to `tileset.png`. */
  image?: string;
  /** Tileset `firstgid`. Defaults to 1, because Tiled reserves 0 for "no tile". */
  firstgid?: number;
  /** Map width/height in tiles. Defaults to the largest tilemap. */
  width?: number;
  height?: number;
  tileWidth?: number;
  tileHeight?: number;
}

/**
 * Export tilemaps as a Tiled `.tmj`-shaped object.
 *
 * Two conventions are worth stating because getting them wrong is silent: Tiled numbers
 * global tile ids from 1 and uses 0 for an empty cell, while this codebase uses `-1`; and
 * Tiled's layer order is bottom-first, the same as `sprite.layers`, so `tilemaps` is
 * emitted in order rather than reversed.
 */
export function toTiledJson(
  tileset: Tileset,
  tilemaps: readonly TilemapLayer[],
  opts: TiledExportOptions = {},
): TiledMapJson {
  const firstgid = opts.firstgid ?? 1;
  const largest = tilemaps.reduce<{ w: number; h: number }>(
    (acc, t) => ({ w: Math.max(acc.w, t.width), h: Math.max(acc.h, t.height) }),
    { w: 0, h: 0 },
  );
  const tileWidth = opts.tileWidth ?? tilemaps[0]?.tileWidth ?? tileset.tileWidth;
  const tileHeight = opts.tileHeight ?? tilemaps[0]?.tileHeight ?? tileset.tileHeight;

  return {
    type: 'map',
    version: '1.10',
    tiledversion: '1.10.2',
    orientation: 'orthogonal',
    renderorder: 'right-down',
    infinite: false,
    compressionlevel: -1,
    width: opts.width ?? largest.w,
    height: opts.height ?? largest.h,
    tilewidth: tileWidth,
    tileheight: tileHeight,
    nextlayerid: tilemaps.length + 1,
    nextobjectid: 1,
    tilesets: [
      {
        firstgid,
        name: tileset.name,
        image: opts.image ?? 'tileset.png',
        imagewidth: tileset.image.width,
        imageheight: tileset.image.height,
        tilewidth: tileset.tileWidth,
        tileheight: tileset.tileHeight,
        tilecount: tileCount(tileset),
        columns: tileset.columns,
        margin: 0,
        spacing: 0,
      },
    ],
    layers: tilemaps.map((tilemap, index) => {
      const data = new Array<number>(tilemap.width * tilemap.height);
      for (let i = 0; i < data.length; i++) {
        const value = tilemap.data[i];
        data[i] = value === EMPTY_TILE ? 0 : value + firstgid;
      }
      return {
        id: index + 1,
        name: tilemap.name,
        type: 'tilelayer' as const,
        x: 0,
        y: 0,
        width: tilemap.width,
        height: tilemap.height,
        opacity: 1,
        visible: true,
        data,
      };
    }),
  };
}

/* ------------------------------------------------------------------ *
 * Sheet layout
 * ------------------------------------------------------------------ */

/** Where a generated auto-tile sheet puts each tile. */
export interface AutotileSheetSlot {
  index: number;
  mask: number;
  /** Cardinal neighbours present. */
  cardinals: Point;
  diagonals: string[];
}

function describeMask(mask: number): AutotileSheetSlot['diagonals'] {
  const names: string[] = [];
  if (mask & AUTOTILE_BITS.NE) names.push('NE');
  if (mask & AUTOTILE_BITS.SE) names.push('SE');
  if (mask & AUTOTILE_BITS.SW) names.push('SW');
  if (mask & AUTOTILE_BITS.NW) names.push('NW');
  return names;
}

/**
 * The layout of an auto-tile sheet, in the order this module's lookup tables expect.
 *
 * Generated so the table and the sheet can never disagree: emit the sheet by walking this
 * list, and the index an `autotile` pass computes will name the right cell.
 */
export function autotileSheet(set: 16 | 47): AutotileSheetSlot[] {
  const masks = set === 16 ? AUTOTILE_16_MASKS : AUTOTILE_47_MASKS;
  return masks.map((mask, index) => ({
    index,
    mask,
    cardinals: {
      x: mask & AUTOTILE_BITS.E ? 1 : 0,
      y: mask & AUTOTILE_BITS.S ? 1 : 0,
    },
    diagonals: describeMask(mask),
  }));
}
