import { blendInto } from './blend.js';
import { PixelBuffer } from './buffer.js';
import { clipRect, fullRect } from './geometry.js';
import { hashSpatial } from './rng.js';
import type { MapObject, MapPropertyValue, TilemapLayer, Tileset } from './document.js';
import type { Color, Point, Rect } from './types.js';

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
 * A rect in tile coordinates, normalised and clipped to the map.
 *
 * Shared by every region-taking helper here so a caller passing
 * `{x:5,y:5,w:-3,h:-3}` gets the same rectangle out of a fill, an auto-tile pass and a
 * paint, rather than three different readings of the same numbers.
 */
export function mapRect(tilemap: TilemapLayer, rect?: Rect): Rect {
  if (!rect) return fullRect(tilemap.width, tilemap.height);
  return clipRect(
    {
      x: Math.min(rect.x, rect.x + rect.w),
      y: Math.min(rect.y, rect.y + rect.h),
      w: Math.abs(rect.w),
      h: Math.abs(rect.h),
    },
    tilemap.width,
    tilemap.height,
  );
}

/**
 * Write every cell in a rect (default: the whole map).
 *
 * A rect whose `w` or `h` is negative is normalised first, so `{x:5,y:5,w:-3,h:-3}` means
 * the same as `{x:2,y:2,w:3,h:3}` — the same rule the drawing commands use.
 */
export function fillTilemap(tilemap: TilemapLayer, index: number, rect?: Rect): number {
  return fillTilemapReport(tilemap, index, rect).filled;
}

export interface FillResult {
  /** Cells written, whether or not the value differed. */
  filled: number;
  /** Cells whose stored index actually changed. */
  changed: number;
  /** Bounding box of the cells that changed, or `null` when nothing did. */
  changedRect: Rect | null;
}

/**
 * `fillTilemap` with the two things a command needs to report an edit honestly: how many
 * cells really changed, and where.
 *
 * `fillTilemap` stays the plain counter it always was; this is the same loop with the
 * before/after bookkeeping, so a fill that re-writes identical values reports zero
 * changes instead of a large `filled` that suggests work happened.
 */
export function fillTilemapReport(tilemap: TilemapLayer, index: number, rect?: Rect): FillResult {
  const r = mapRect(tilemap, rect);
  let filled = 0;
  let changed = 0;
  let minX = tilemap.width;
  let minY = tilemap.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = r.y; y < r.y + r.h; y++) {
    const row = y * tilemap.width;
    for (let x = r.x; x < r.x + r.w; x++) {
      const at = row + x;
      if (tilemap.data[at] !== index) {
        tilemap.data[at] = index;
        changed++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      filled++;
    }
  }
  const changedRect = maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  return { filled, changed, changedRect };
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/** How a cell is composited onto the target: hard replace, or true source-over. */
export type TileBlend = 'copy' | 'over';

export interface BlitTilemapOptions {
  /** Pixel offset of the map's top-left corner. */
  offsetX?: number;
  offsetY?: number;
  /** Draw this index instead of skipping empty cells. Defaults to skipping. */
  replaceEmpty?: number | null;
  /**
   * Only cells inside this tile-space rect are considered. Defaults to the whole map.
   *
   * A bake touches a handful of cells out of thousands; without a rect the work is
   * proportional to the whole map even when the change is a single tile.
   */
  rect?: Rect;
  /**
   * `copy` overwrites the destination, which is the historical behaviour and the only
   * one that can erase what is underneath. `over` composites with `blendInto`, so a tile
   * with a soft or semi-transparent edge merges with the artwork below instead of
   * punching a hole in it.
   */
  blend?: TileBlend;
  /** 0-1 multiplier on the source alpha. Defaults to 1. */
  opacity?: number;
  /** Clear the destination pixels of the region before drawing anything into it. */
  clear?: boolean;
  /**
   * Optional base map rendered first with the same cell size and offset.
   *
   * This is what makes an alpha-masked bank/edge tile meaningful: clear the cell, stamp
   * the ground underlay, then composite the active terrain over it.
   */
  underlay?: TilemapLayer;
}

/** Reused so a per-pixel composite does not allocate a colour per pixel. */
const SCRATCH_COLOR: Color = { r: 0, g: 0, b: 0, a: 0 };

/**
 * The pixel area a tile-space rect occupies, before it is clipped to a target.
 *
 * Exposed because a caller that reports "how many pixels did I clear" has to describe
 * the same rectangle the blitter clears, and computing it twice is how the two drift.
 */
export function tilemapRegionPixels(tilemap: TilemapLayer, rect: Rect, offsetX = 0, offsetY = 0): Rect {
  return {
    x: offsetX + rect.x * tilemap.tileWidth,
    y: offsetY + rect.y * tilemap.tileHeight,
    w: rect.w * tilemap.tileWidth,
    h: rect.h * tilemap.tileHeight,
  };
}

/**
 * Stamp one cell, returning whether any of it landed on the target.
 *
 * The count a caller reports comes from the destination geometry rather than from the
 * draw itself: a cell that falls entirely outside the target is not drawn, and a cell
 * whose tileset index is past the end of the sheet is drawn as nothing but still counts,
 * because it was a cell the map asked to paint.
 */
function drawCell(
  target: PixelBuffer,
  tileset: Tileset,
  tilemap: TilemapLayer,
  tx: number,
  ty: number,
  index: number,
  ox: number,
  oy: number,
  over: boolean,
  opacity: number,
): boolean {
  const src = tileRect(tileset, index);
  const dx = ox + tx * tilemap.tileWidth;
  const dy = oy + ty * tilemap.tileHeight;
  const dest = clipRect(
    { x: dx, y: dy, w: tilemap.tileWidth, h: tilemap.tileHeight },
    target.width,
    target.height,
  );
  if (dest.w <= 0 || dest.h <= 0) return false;

  const image = tileset.image;
  const sd = image.data;
  const td = target.data;
  // Clip the source to the sheet and the destination to the target up front, so the
  // inner loop is two pointer walks and no per-pixel bounds test.
  const x0 = Math.max(0, -dx, -src.x);
  const y0 = Math.max(0, -dy, -src.y);
  const x1 = Math.min(tilemap.tileWidth, target.width - dx, image.width - src.x);
  const y1 = Math.min(tilemap.tileHeight, target.height - dy, image.height - src.y);
  for (let y = y0; y < y1; y++) {
    let si = image.index(src.x + x0, src.y + y);
    let di = target.index(dx + x0, dy + y);
    for (let x = x0; x < x1; x++) {
      if (over) {
        SCRATCH_COLOR.r = sd[si];
        SCRATCH_COLOR.g = sd[si + 1];
        SCRATCH_COLOR.b = sd[si + 2];
        SCRATCH_COLOR.a = sd[si + 3];
        blendInto(td, di, SCRATCH_COLOR, { blend: 'normal', opacity });
      } else {
        // A straight write, so a transparent source pixel still erases: that is what
        // makes `copy` able to stamp a hole where the old cel had something.
        td[di] = sd[si];
        td[di + 1] = sd[si + 1];
        td[di + 2] = sd[si + 2];
        td[di + 3] = opacity >= 1 ? sd[si + 3] : Math.round(sd[si + 3] * opacity);
      }
      si += 4;
      di += 4;
    }
  }
  return true;
}

/**
 * Compose a tilemap into a buffer, so a level can be previewed or exported as a PNG.
 *
 * Cells are blitted in row order and empty cells are skipped, which is what makes a
 * tilemap over a transparent canvas read as a level rather than a grid of holes.
 *
 * `blend: 'over'` is the one that changes how a tilemap lands on artwork: it composites
 * per pixel, so a tile with a feathered or semi-transparent edge fuses with the pixels
 * under it rather than replacing them.
 */
export function blitTilemap(
  target: PixelBuffer,
  tileset: Tileset,
  tilemap: TilemapLayer,
  opts: BlitTilemapOptions = {},
): number {
  if (opts.underlay) {
    if (opts.underlay.tileWidth !== tilemap.tileWidth || opts.underlay.tileHeight !== tilemap.tileHeight) {
      throw new Error('Tilemap underlay must use the same cell size as the active map.');
    }
    const { underlay, ...active } = opts;
    blitTilemap(target, tileset, underlay, {
      ...active,
      blend: 'copy',
      opacity: 1,
      replaceEmpty: null,
    });
    return blitTilemap(target, tileset, tilemap, { ...active, clear: false });
  }
  const ox = Math.round(opts.offsetX ?? 0);
  const oy = Math.round(opts.offsetY ?? 0);
  const empty = opts.replaceEmpty ?? null;
  const over = opts.blend === 'over';
  const opacity = opts.opacity === undefined ? 1 : opts.opacity < 0 ? 0 : opts.opacity > 1 ? 1 : opts.opacity;
  const area = mapRect(tilemap, opts.rect);

  if (opts.clear) {
    target.clear(tilemapRegionPixels(tilemap, area, ox, oy));
  }

  let drawn = 0;
  for (let ty = area.y; ty < area.y + area.h; ty++) {
    for (let tx = area.x; tx < area.x + area.w; tx++) {
      let index = tilemap.data[ty * tilemap.width + tx];
      if (index === EMPTY_TILE) {
        if (empty === null) continue;
        index = empty;
      }
      if (drawCell(target, tileset, tilemap, tx, ty, index, ox, oy, over, opacity)) drawn++;
    }
  }
  return drawn;
}

export interface BakeResult {
  /**
   * Map cells re-stamped.
   *
   * Counted per cell, not per drawn tile: a cell that is empty in the map still had its
   * old pixels cleared, and a bake that reported nothing while wiping 64 pixels would be
   * lying about the one thing it was called to do.
   */
  cells: number;
  /** Destination pixels zeroed before drawing. */
  clearedPixels: number;
}

/**
 * Re-stamp a rect of a tilemap, clearing its pixels first.
 *
 * This is the "edit the map, keep the pixels in step" operation: a tile that used to be
 * an opaque rock and is now a hole has to take its old pixels with it, which a plain
 * blit cannot do because the new cell is empty and therefore skipped.
 */
export function bakeTilemapRect(
  target: PixelBuffer,
  tileset: Tileset,
  tilemap: TilemapLayer,
  rect: Rect,
  opts: BlitTilemapOptions = {},
): BakeResult {
  const area = mapRect(tilemap, rect);
  if (area.w <= 0 || area.h <= 0) return { cells: 0, clearedPixels: 0 };
  const pixels = tilemapRegionPixels(tilemap, area, Math.round(opts.offsetX ?? 0), Math.round(opts.offsetY ?? 0));
  const cleared = clipRect(pixels, target.width, target.height);
  const outside = cleared.w <= 0 || cleared.h <= 0;
  blitTilemap(target, tileset, tilemap, { ...opts, rect: area, clear: true });
  return { cells: outside ? 0 : area.w * area.h, clearedPixels: cleared.w * cleared.h };
}

/**
 * Re-stamp a scattered set of cells, clearing each one's pixels first.
 *
 * For a batch of writes spread over a big map this is strictly better than a rect: a
 * hundred scattered edits clear a hundred tiles instead of the whole canvas.
 */
export function bakeTilemapCells(
  target: PixelBuffer,
  tileset: Tileset,
  tilemap: TilemapLayer,
  cells: readonly Point[],
  opts: BlitTilemapOptions = {},
): BakeResult {
  const ox = Math.round(opts.offsetX ?? 0);
  const oy = Math.round(opts.offsetY ?? 0);
  let cellsBaked = 0;
  let clearedPixels = 0;
  for (const cell of cells) {
    if (cell.x < 0 || cell.y < 0 || cell.x >= tilemap.width || cell.y >= tilemap.height) continue;
    const box = clipRect(
      tilemapRegionPixels(tilemap, { x: cell.x, y: cell.y, w: 1, h: 1 }, ox, oy),
      target.width,
      target.height,
    );
    if (box.w <= 0 || box.h <= 0) continue;
    cellsBaked++;
    clearedPixels += box.w * box.h;
    blitTilemap(target, tileset, tilemap, {
      ...opts,
      rect: { x: cell.x, y: cell.y, w: 1, h: 1 },
      clear: true,
    });
  }
  return { cells: cellsBaked, clearedPixels };
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

/**
 * A tile that answers one neighbour mask, with its relative weight.
 *
 * Repeating a `mask` gives the same transition several interchangeable tiles — grass A
 * and grass B for the same silhouette — which is what stops a coastline from looking
 * stamped.
 */
export interface AutotileTransition {
  mask: number;
  tile: number;
  /** Relative weight, > 0. Defaults to 1. */
  weight?: number;
}

interface WeightedTile {
  tile: number;
  weight: number;
}

/** Smoothed value noise in -1..1: neighbours get similar values, so jitter wiggles. */
function smoothField(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hashSpatial(ix, iy, seed, 0x51a3);
  const b = hashSpatial(ix + 1, iy, seed, 0x51a3);
  const c = hashSpatial(ix, iy + 1, seed, 0x51a3);
  const d = hashSpatial(ix + 1, iy + 1, seed, 0x51a3);
  return ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy) * 2 - 1;
}

/**
 * Choose one tile from a weighted list, preferring not to repeat what is in `avoid`.
 *
 * The first roll is a plain weighted pick, so `seed` alone decides the texture. When that
 * pick would sit next to an identical tile and another candidate is available, the second
 * roll picks the replacement: a run of the same tile is the thing that makes a stroke
 * look like a rubber stamp, and a caller who wants the runs back passes
 * `avoidRepeats: false`.
 */
function pickWeighted(
  variants: readonly WeightedTile[],
  x: number,
  y: number,
  seed: number,
  salt: number,
  avoid: Set<number> | null,
): number {
  let total = 0;
  for (const variant of variants) total += variant.weight;
  let acc = 0;
  let chosen = variants[variants.length - 1].tile;
  const roll = hashSpatial(x, y, seed, salt);
  for (const variant of variants) {
    acc += variant.weight;
    if (roll * total < acc) {
      chosen = variant.tile;
      break;
    }
  }
  if (!avoid || avoid.size === 0 || !avoid.has(chosen)) return chosen;
  const count = variants.length;
  const start = Math.min(count - 1, Math.floor(hashSpatial(x, y, seed, salt ^ 0x2f1b) * count));
  for (let i = 0; i < count; i++) {
    const candidate = variants[(start + i) % count].tile;
    if (!avoid.has(candidate)) return candidate;
  }
  return chosen;
}

/**
 * Group transition entries by mask, dropping non-positive weights and merging repeats.
 *
 * Keys go through the same canonicalisation as the lookup, so a caller can write the
 * mask the way the sheet was drawn — including a non-canonical one such as a lone
 * north-east bit — and have it land on the mask the pass actually computes.
 */
function buildTransitionMap(
  transitions: readonly AutotileTransition[] | undefined,
  set: 16 | 47,
): Map<number, WeightedTile[]> {
  const map = new Map<number, WeightedTile[]>();
  if (!transitions) return map;
  for (const entry of transitions) {
    const weight = entry.weight === undefined ? 1 : entry.weight;
    if (!(weight > 0)) continue;
    const key = transitionKey(entry.mask, set);
    const list = map.get(key);
    if (list) list.push({ tile: entry.tile, weight });
    else map.set(key, [{ tile: entry.tile, weight }]);
  }
  return map;
}

/** The mask key a lookup uses: canonical for 47-sets, the low four bits for 16-sets. */
function transitionKey(mask: number, set: 16 | 47): number {
  return set === 16 ? mask & 0b1111 : canonicalBlobMask(mask) & 0xff;
}

/** Marks a cell this pass never resolved, so its pre-pass value is the honest answer. */
const UNRESOLVED = -2;

/**
 * The tiles this cell must not repeat: whatever sits to its left and above.
 *
 * A cell's left and upper neighbours are the only two a row-major scan has already
 * decided, and the only two a viewer reads as "a row of terrain". `read` says what a
 * neighbour is worth: for an auto-tile pass, the tile it resolved to, falling back to
 * the pre-pass value for anything the pass skipped or never reached; for a stroke, the
 * variant the stroke itself laid down there.
 *
 * Only the four cardinal neighbours count: an identical tile diagonally placed is
 * invisible in a flat field.
 */
function avoidNeighbours(
  read: ((at: number) => number) | null,
  width: number,
  x: number,
  y: number,
): Set<number> | null {
  if (!read) return null;
  const avoid = new Set<number>();
  if (x > 0) {
    const left = read(y * width + x - 1);
    if (left !== EMPTY_TILE) avoid.add(left);
  }
  if (y > 0) {
    const up = read((y - 1) * width + x);
    if (up !== EMPTY_TILE) avoid.add(up);
  }
  return avoid.size > 0 ? avoid : null;
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
  /**
   * Custom mask -> tile mapping, in any order and covering any subset of masks.
   *
   * This exists because a generated sheet layout is only one of several conventions:
   * plenty of tilesets put the inner corner on the north-east, or ship a hand-picked set
   * of sixteen. Two or more entries for one mask are variants of the same silhouette and
   * are picked by weight.
   */
  transitions?: readonly AutotileTransition[];
  /** Seed for the variant choice. Same seed and map means same terrain, every time. */
  seed?: number;
  /**
   * Avoid picking the same variant as the cell to the left or above.
   *
   * On by default: two identical tiles side by side is the giveaway that terrain was
   * stamped rather than drawn. Only matters when a mask has more than one variant.
   */
  avoidRepeats?: boolean;
  /**
   * What to do with a mask the mapping does not cover. Defaults to `offset`.
   *
   * `offset` falls back to the normal set layout, which is the sensible default when the
   * mapping only overrides a few masks. `keep` leaves the cell exactly as it is, which is
   * what a stroke wants: the tile it just wrote stays put unless a transition says
   * otherwise.
   */
  unmapped?: 'offset' | 'keep';
}

export interface AutotileResult {
  /** Cells whose index changed. */
  changed: number;
  /** Cells examined. */
  visited: number;
  set: 16 | 47;
  offset: number;
  /**
   * Cells resolved to a tile.
   *
   * With a custom `transitions` mapping this counts the cells an entry answered; with no
   * mapping it counts every visited cell, because the set layout answered all of them.
   */
  matched: number;
  /**
   * Cells whose mask the mapping did not cover.
   *
   * Always 0 without a mapping. With one, a non-zero count is a list of masks the caller
   * forgot: either fall back to the set layout (`unmapped: 'offset'`) or keep the base
   * tile (`unmapped: 'keep'`).
   */
  unmapped: number;
  /** Bounding box of the cells that changed, or `null` when nothing did. */
  changedRect: Rect | null;
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
  const r = mapRect(tilemap, opts.rect);
  const transitions = buildTransitionMap(opts.transitions, set);
  const seed = opts.seed ?? 0;
  const avoidRepeats = opts.avoidRepeats ?? true;
  const keepUnmapped = opts.unmapped === 'keep';

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

  // Repeat avoidance compares against the neighbour's result from this pass, with the
  // pre-pass map as the fallback for anything this pass did not resolve. The pre-pass
  // values still have to be kept: a cell rewritten as a transition tile stops looking
  // like the terrain it was, and the next cell in the scan must not read that as one.
  const tracking = transitions.size > 0 && avoidRepeats;
  const before = tracking ? tilemap.data.slice() : null;
  const chosen = before ? new Int32Array(tilemap.width * tilemap.height).fill(UNRESOLVED) : null;
  const neighbour = chosen && before ? (at: number) => (chosen[at] === UNRESOLVED ? before[at] : chosen[at]) : null;

  let changed = 0;
  let visited = 0;
  let matched = 0;
  let unmapped = 0;
  let minX = tilemap.width;
  let minY = tilemap.height;
  let maxX = -1;
  let maxY = -1;
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

      const variants = transitions.get(transitionKey(mask, set));
      let index: number;
      if (variants) {
        index = pickWeighted(variants, x, y, seed, 0x9e37, avoidNeighbours(neighbour, tilemap.width, x, y));
        matched++;
      } else if (keepUnmapped) {
        unmapped++;
        continue;
      } else {
        index = set === 16 ? autotile16Index(mask, offset) : autotile47Index(mask, offset);
        unmapped++;
      }

      const at = y * tilemap.width + x;
      if (chosen) chosen[at] = index;
      if (tilemap.data[at] !== index) {
        tilemap.data[at] = index;
        changed++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const changedRect = maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  return {
    changed,
    visited,
    set,
    offset,
    matched: transitions.size > 0 ? matched : visited,
    unmapped: transitions.size > 0 ? unmapped : 0,
    changedRect,
  };
}

/* ------------------------------------------------------------------ *
 * Stroking terrain
 *
 * A tilemap is the right tool for a coastline, a cliff edge or a cave wall: a shape whose
 * edge is a curve and whose middle is noisy. Hand-placing those cells is exactly the work
 * an agent does badly, so the stroke walks a path, decides the silhouette from the path
 * and its radius, and lets an auto-tile pass finish the border.
 * ------------------------------------------------------------------ */

/** How a path is turned into a curve before it is rasterised. */
export type StrokeSmoothing = 'linear' | 'catmull-rom';

/** The shape stamped along the path. */
export type StrokeBrush = 'round' | 'square';

export interface StrokeEdgeOptions {
  /** Transition set the masks follow. Defaults to `47`. */
  set?: 16 | 47;
  /** Mask -> tile mapping, in any order, covering any subset of masks. */
  transitions: readonly AutotileTransition[];
  /** First tile of the fallback set layout, used when `unmapped` is `offset`. */
  offset?: number;
  /** Seed for the transition variant choice. Defaults to the stroke's own seed. */
  seed?: number;
  /** Avoid repeating the left and upper neighbour's transition tile. Defaults to true. */
  avoidRepeats?: boolean;
  /**
   * What a mask the mapping does not cover does. Defaults to `keep`.
   *
   * `keep` leaves the cell holding the base variant the stroke painted, which is what
   * makes a partial mapping safe: you describe the corners you have tiles for and the
   * rest stays the terrain you just laid down.
   */
  unmapped?: 'offset' | 'keep';
}

export interface StrokeTilemapOptions {
  /**
   * What to paint.
   *
   * A bare number is a tile with weight 1; `{tile, weight}` makes one tile more common
   * than another, which is how three shades of grass become a meadow instead of stripes.
   */
  tiles: ReadonlyArray<number | { tile: number; weight?: number }>;
  /** Brush diameter in tiles, measured across the path. Defaults to 1. */
  width?: number;
  /** `round` follows the path, `square` is an axis-aligned stamp. Defaults to `round`. */
  brush?: StrokeBrush;
  /** `catmull-rom` rounds the corners between your points. Defaults to `catmull-rom`. */
  smoothing?: StrokeSmoothing;
  /** Fraction of covered cells to paint, 0-1. Defaults to 1. */
  density?: number;
  /**
   * Smooth perturbation of the brush boundary, 0-0.5. Defaults to 0.12.
   *
   * The radius varies with low-frequency noise, so the edge wanders in a continuous
   * curve instead of a perfect offset of the path.
   */
  jitter?: number;
  /** Seed for every random-looking choice here. Same seed, same terrain. */
  seed?: number;
  /** Avoid the left and upper neighbour's variant. Defaults to true. */
  avoidRepeats?: boolean;
  /** `false` leaves cells that already hold a tile alone. Defaults to true. */
  replace?: boolean;
  /** Restrict the stroke to this tile-space rect. Defaults to the whole map. */
  rect?: Rect;
  /** Border handling: after the fill, the cells the stroke owns become transitions. */
  edge?: StrokeEdgeOptions;
}

export interface StrokeResult {
  /** Cells the brush covered inside the map, before `density` or `replace`. */
  covered: number;
  /** Covered cells that were painted. */
  painted: number;
  /** Painted cells whose stored index actually changed. */
  changed: number;
  /** Covered cells dropped by `density`, or by `replace: false` on a filled cell. */
  skipped: number;
  /** Bounding box of the painted cells, in tile coordinates. */
  rect: Rect | null;
  /**
   * The painted cells themselves, in row-major order.
   *
   * Returned because a bake needs exactly this set: the bounding box of a diagonal
   * stroke is mostly cells the stroke never touched, and re-stamping those is wasted
   * work on a big map.
   */
  cells: Point[];
  /** What the border pass did, or `null` when no `edge` was given. */
  edges: { applied: number; unmapped: number } | null;
}

/** Ceiling on cells examined while rasterising, so a huge path fails loudly. */
const MAX_STROKE_WORK = 4_000_000;
/** Ceiling on curve samples generated per path segment. */
const MAX_STROKE_SAMPLES = 64;

function lerpAt(a: number, b: number, ta: number, tb: number, t: number): number {
  const span = tb - ta;
  if (!(span > 1e-6)) return b;
  return a + (b - a) * ((t - ta) / span);
}

/**
 * One point on a centripetal Catmull-Rom spline through four control points.
 *
 * Centripetal (alpha = 0.5) rather than the uniform variant because control points here
 * are as unevenly spaced as the caller likes — a two-point hop between a cliff and a
 * beach — and uniform Catmull-Rom overshoots into a cusp when the spacing jumps, which
 * for a stroke means a spike of tiles off the end of the path.
 */
function catmullRomPoint(p0: Point, p1: Point, p2: Point, p3: Point, u: number): Point {
  const knot = (a: Point, b: Point): number => {
    // sqrt, not Math.hypot: hypot is implementation-approximated in the language spec,
    // so two conforming engines can disagree in the last bit and land a control point a
    // fraction of a cell apart. sqrt is correctly rounded by IEEE-754. Map coordinates
    // are far too small for the intermediate to overflow.
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    return Math.sqrt(Math.max(1e-4, d));
  };
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const t = t1 + (t2 - t1) * u;
  const a1x = lerpAt(p0.x, p1.x, t0, t1, t);
  const a1y = lerpAt(p0.y, p1.y, t0, t1, t);
  const a2x = lerpAt(p1.x, p2.x, t1, t2, t);
  const a2y = lerpAt(p1.y, p2.y, t1, t2, t);
  const a3x = lerpAt(p2.x, p3.x, t2, t3, t);
  const a3y = lerpAt(p2.y, p3.y, t2, t3, t);
  const b1x = lerpAt(a1x, a2x, t0, t2, t);
  const b1y = lerpAt(a1y, a2y, t0, t2, t);
  const b2x = lerpAt(a2x, a3x, t1, t3, t);
  const b2y = lerpAt(a2y, a3y, t1, t3, t);
  return { x: lerpAt(b1x, b2x, t1, t2, t), y: lerpAt(b1y, b2y, t1, t2, t) };
}

/** The path actually rasterised: a curve, or the points as given. */
function strokePath(points: readonly Point[], smoothing: StrokeSmoothing): Point[] {
  if (smoothing === 'linear') return points.map((p) => ({ x: p.x, y: p.y }));
  const out: Point[] = [];
  const count = points.length;
  const at = (i: number): Point => points[Math.max(0, Math.min(count - 1, i))];
  for (let i = 0; i < count - 1; i++) {
    const p1 = at(i);
    const p2 = at(i + 1);
    const ex = p2.x - p1.x;
    const ey = p2.y - p1.y;
    // sqrt, not Math.hypot — see the note in `catmullRomPoint`.
    const length = Math.sqrt(ex * ex + ey * ey);
    const steps = Math.max(1, Math.min(MAX_STROKE_SAMPLES, Math.ceil(length * 2)));
    for (let s = 0; s < steps; s++) {
      out.push(catmullRomPoint(at(i - 1), p1, p2, at(i + 2), s / steps));
    }
  }
  out.push({ x: points[count - 1].x, y: points[count - 1].y });
  return out;
}

/** Bounding box of a set of cells, or `null` for none. */
export function tileCellsBounds(cells: readonly Point[]): Rect | null {
  if (cells.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const cell of cells) {
    if (cell.x < minX) minX = cell.x;
    if (cell.y < minY) minY = cell.y;
    if (cell.x > maxX) maxX = cell.x;
    if (cell.y > maxY) maxY = cell.y;
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Paint a terrain brush along a path, with weighted variants and a border pass.
 *
 * Cell `(x, y)` is treated as the integer tile coordinate itself, so a path point of
 * `(3, 4)` is the centre of cell 3,4 and a width of 1 covers exactly the cells the path
 * runs through. `jitter` is applied as a smooth per-cell variation of the radius, which
 * keeps the boundary continuous — a hash per cell would leave a stippled edge instead.
 *
 * Cells are filled in row-major order, because repeat avoidance looks at the cell to the
 * left and the cell above, and row-major is the only order in which both are already
 * decided.
 */
export function strokeTilemap(
  tilemap: TilemapLayer,
  points: readonly Point[],
  opts: StrokeTilemapOptions,
): StrokeResult {
  if (points.length < 2) throw new Error(`stroke_tilemap needs at least 2 points, got ${points.length}`);
  const variants: WeightedTile[] = [];
  for (const entry of opts.tiles) {
    const tile = typeof entry === 'number' ? entry : entry.tile;
    const weight = typeof entry === 'number' ? 1 : entry.weight ?? 1;
    if (!Number.isFinite(tile)) throw new Error(`stroke_tilemap: tile index must be a finite number, got ${tile}`);
    if (!(weight > 0)) continue;
    variants.push({ tile: Math.trunc(tile), weight });
  }
  if (variants.length === 0) {
    throw new Error('stroke_tilemap: `tiles` needs at least one entry with a weight above 0.');
  }

  const brush = opts.brush ?? 'round';
  const seed = opts.seed ?? 0;
  const width = opts.width ?? 1;
  if (!(width > 0)) throw new Error(`stroke_tilemap: width must be above 0, got ${width}`);
  const density = opts.density === undefined ? 1 : opts.density < 0 ? 0 : opts.density > 1 ? 1 : opts.density;
  const jitter = opts.jitter ?? 0.12;
  const radius = width / 2;
  // The widest the brush can get after jitter, used to bound the scan of each segment.
  const reach = radius * (1 + jitter);
  const area = mapRect(tilemap, opts.rect);

  /* ---- coverage ------------------------------------------------- */
  const path = strokePath(points, opts.smoothing ?? 'catmull-rom');
  const covered = new Set<number>();
  let work = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const ax = path[i].x;
    const ay = path[i].y;
    const bx = path[i + 1].x;
    const by = path[i + 1].y;
    const x0 = Math.max(area.x, Math.floor(Math.min(ax, bx) - reach));
    const x1 = Math.min(area.x + area.w - 1, Math.ceil(Math.max(ax, bx) + reach));
    const y0 = Math.max(area.y, Math.floor(Math.min(ay, by) - reach));
    const y1 = Math.min(area.y + area.h - 1, Math.ceil(Math.max(ay, by) + reach));
    if (x1 < x0 || y1 < y0) continue;
    work += (x1 - x0 + 1) * (y1 - y0 + 1);
    if (work > MAX_STROKE_WORK) {
      throw new Error(
        `stroke_tilemap: the path covers more than ${MAX_STROKE_WORK} cells; fewer points or a smaller width`,
      );
    }
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let y = y0; y <= y1; y++) {
      const row = y * tilemap.width;
      for (let x = x0; x <= x1; x++) {
        const at = row + x;
        if (covered.has(at)) continue;
        let t = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        const ox = x - (ax + dx * t);
        const oy = y - (ay + dy * t);
        // `square` is Chebyshev: the stamp stays axis-aligned, so a diagonal path still
        // leaves a blocky band instead of a staircase of round caps. The round brush uses
        // sqrt rather than Math.hypot, which is implementation-approximated and could put
        // a cell on the other side of `d <= local` on a different engine.
        const d = brush === 'square' ? Math.max(Math.abs(ox), Math.abs(oy)) : Math.sqrt(ox * ox + oy * oy);
        const local = radius * (1 + jitter * smoothField(x, y, seed ^ 0x2f1b));
        if (d <= local) covered.add(at);
      }
    }
  }

  /* ---- fill ----------------------------------------------------- */
  const base = tilemap.data.slice();
  const avoidRepeats = opts.avoidRepeats ?? true;
  const replace = opts.replace ?? true;
  const paintedCells: Point[] = [];
  let painted = 0;
  let changed = 0;
  let skipped = 0;
  for (let y = area.y; y < area.y + area.h; y++) {
    const row = y * tilemap.width;
    for (let x = area.x; x < area.x + area.w; x++) {
      const at = row + x;
      if (!covered.has(at)) continue;
      if (density < 1 && hashSpatial(x, y, seed, 0x2c1f) >= density) {
        skipped++;
        continue;
      }
      if (!replace && tilemap.data[at] !== EMPTY_TILE) {
        skipped++;
        continue;
      }
      // The stroke's own choices are written into `base` as it goes, so the neighbours a
      // cell avoids are the variants this stroke already laid down beside it.
      const tile = pickWeighted(
        variants,
        x,
        y,
        seed,
        0x7d3b,
        avoidRepeats && variants.length > 1 ? avoidNeighbours((at) => base[at], tilemap.width, x, y) : null,
      );
      base[at] = tile;
      if (tilemap.data[at] !== tile) changed++;
      tilemap.data[at] = tile;
      painted++;
      paintedCells.push({ x, y });
    }
  }

  /* ---- border ---------------------------------------------------- */
  let edges: StrokeResult['edges'] = null;
  const edge = opts.edge;
  if (edge && edge.transitions.length > 0 && paintedCells.length > 0) {
    // The terrain is judged from `base` — the variants this stroke laid down, plus
    // whatever terrain was already on the map — so the border does not depend on the
    // transition indices, and a second stroke over the same map still sees the shape.
    const owners = new Set(paintedCells.map((cell) => cell.y * tilemap.width + cell.x));
    const terrain: TerrainTest = (x, y) =>
      x >= 0 && y >= 0 && x < tilemap.width && y < tilemap.height && base[y * tilemap.width + x] !== EMPTY_TILE;
    const result = autotile(tilemap, terrain, {
      set: edge.set ?? 47,
      offset: edge.offset ?? 0,
      transitions: edge.transitions,
      seed: edge.seed ?? seed,
      avoidRepeats: edge.avoidRepeats ?? true,
      unmapped: edge.unmapped ?? 'keep',
      only: (x, y) => owners.has(y * tilemap.width + x),
    });
    edges = { applied: result.matched, unmapped: result.unmapped };
  }

  return {
    covered: covered.size,
    painted,
    changed,
    skipped,
    rect: tileCellsBounds(paintedCells),
    cells: paintedCells,
    edges,
  };
}

/* ------------------------------------------------------------------ *
 * Tiled export
 * ------------------------------------------------------------------ */

export type TiledPropertyType = 'string' | 'int' | 'float' | 'bool';

export interface TiledPropertyJson {
  name: string;
  type: TiledPropertyType;
  value: MapPropertyValue;
}

export interface TiledTileJson {
  /** Tile-local id, before `firstgid` is added. */
  id: number;
  properties: TiledPropertyJson[];
}

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
  tiles?: TiledTileJson[];
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
  objects?: never;
}

export interface TiledObjectJson {
  id: number;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  visible: boolean;
  gid?: number;
  point?: true;
  properties: TiledPropertyJson[];
}

export interface TiledObjectGroupJson {
  id: number;
  name: string;
  type: 'objectgroup';
  draworder: 'topdown';
  x: number;
  y: number;
  opacity: number;
  visible: boolean;
  objects: TiledObjectJson[];
  data?: never;
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
  layers: Array<TiledLayerJson | TiledObjectGroupJson>;
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
  /** Independent gameplay/interactive entities exported as a Tiled object group. */
  mapObjects?: readonly MapObject[];
  /** Object-group layer name. Defaults to `Objects`. */
  objectLayerName?: string;
}

function tiledPropertyType(value: MapPropertyValue): TiledPropertyType {
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  return 'string';
}

function tiledProperties(properties: Record<string, MapPropertyValue>): TiledPropertyJson[] {
  return Object.keys(properties)
    .sort()
    .map((name) => {
      const value = properties[name];
      return { name, type: tiledPropertyType(value), value };
    });
}

function validateTileIndex(tileset: Tileset, tile: number, context: string): void {
  const available = tileCount(tileset);
  if (!Number.isInteger(tile) || tile < -1 || tile >= available) {
    throw new Error(`${context}: tile ${tile} is outside -1..${available - 1}.`);
  }
}

/**
 * Export tilemaps and gameplay metadata as a Tiled `.tmj`-shaped object.
 *
 * Tiled numbers global tile ids from 1 and uses 0 for an empty cell, while this codebase
 * uses `-1`. Tile custom properties are embedded in the JSON tileset; independent map
 * objects become a separate object-group layer. Every index and data length is checked
 * before an export is returned, so a malformed map cannot masquerade as a successful one.
 */
export function toTiledJson(
  tileset: Tileset,
  tilemaps: readonly TilemapLayer[],
  opts: TiledExportOptions = {},
): TiledMapJson {
  const firstgid = opts.firstgid ?? 1;
  if (!Number.isInteger(firstgid) || firstgid < 1) {
    throw new Error(`Tiled firstgid must be a positive integer, got ${firstgid}.`);
  }
  const available = tileCount(tileset);
  const largest = tilemaps.reduce<{ w: number; h: number }>(
    (acc, t) => ({ w: Math.max(acc.w, t.width), h: Math.max(acc.h, t.height) }),
    { w: 0, h: 0 },
  );
  const tileWidth = opts.tileWidth ?? tilemaps[0]?.tileWidth ?? tileset.tileWidth;
  const tileHeight = opts.tileHeight ?? tilemaps[0]?.tileHeight ?? tileset.tileHeight;

  const tileLayers: TiledLayerJson[] = tilemaps.map((tilemap, index) => {
    if (tilemap.data.length !== tilemap.width * tilemap.height) {
      throw new Error(
        `Tilemap "${tilemap.name}" stores ${tilemap.data.length} cells; expected ${tilemap.width * tilemap.height}.`,
      );
    }
    if (tilemap.tileWidth !== tileWidth || tilemap.tileHeight !== tileHeight) {
      throw new Error(
        `Tilemap "${tilemap.name}" uses ${tilemap.tileWidth}x${tilemap.tileHeight} cells; the Tiled map uses ${tileWidth}x${tileHeight}.`,
      );
    }
    const data = new Array<number>(tilemap.width * tilemap.height);
    for (let i = 0; i < data.length; i++) {
      const value = tilemap.data[i];
      validateTileIndex(tileset, value, `Tilemap "${tilemap.name}" cell ${i}`);
      data[i] = value === EMPTY_TILE ? 0 : value + firstgid;
    }
    return {
      id: index + 1,
      name: tilemap.name,
      type: 'tilelayer',
      x: 0,
      y: 0,
      width: tilemap.width,
      height: tilemap.height,
      opacity: 1,
      visible: true,
      data,
    };
  });

  const tileProperties: TiledTileJson[] = [];
  for (const [rawId, properties] of Object.entries(tileset.tileProperties ?? {})) {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id < 0 || id >= available) {
      throw new Error(`Tile property key "${rawId}" is not a valid index in the ${available}-tile tileset.`);
    }
    const converted = tiledProperties(properties);
    if (converted.length > 0) tileProperties.push({ id, properties: converted });
  }
  tileProperties.sort((a, b) => a.id - b.id);

  const mapObjects = opts.mapObjects ?? [];
  const objects: TiledObjectJson[] = mapObjects.map((object, index) => {
    if (object.tile !== undefined) {
      validateTileIndex(tileset, object.tile, `Map object "${object.name}"`);
    }
    return {
      id: index + 1,
      name: object.name,
      type: object.type,
      x: object.x,
      // Tiled anchors tile objects by their bottom-left corner. Our object model uses a
      // top-left pixel rect consistently, so convert only the exported tile-object y.
      y: object.tile !== undefined ? object.y + object.height : object.y,
      width: object.width,
      height: object.height,
      rotation: object.rotation,
      visible: object.visible,
      ...(object.tile !== undefined ? { gid: object.tile + firstgid } : {}),
      ...(object.tile === undefined && object.width === 0 && object.height === 0 ? { point: true as const } : {}),
      properties: tiledProperties(object.properties),
    };
  });
  const objectLayer: TiledObjectGroupJson[] = objects.length > 0
    ? [{
        id: tileLayers.length + 1,
        name: opts.objectLayerName ?? 'Objects',
        type: 'objectgroup',
        draworder: 'topdown',
        x: 0,
        y: 0,
        opacity: 1,
        visible: true,
        objects,
      }]
    : [];

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
    nextlayerid: tileLayers.length + objectLayer.length + 1,
    nextobjectid: objects.length + 1,
    tilesets: [
      {
        firstgid,
        name: tileset.name,
        image: opts.image ?? 'tileset.png',
        imagewidth: tileset.image.width,
        imageheight: tileset.image.height,
        tilewidth: tileset.tileWidth,
        tileheight: tileset.tileHeight,
        tilecount: available,
        columns: tileset.columns,
        margin: 0,
        spacing: 0,
        ...(tileProperties.length > 0 ? { tiles: tileProperties } : {}),
      },
    ],
    layers: [...tileLayers, ...objectLayer],
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
