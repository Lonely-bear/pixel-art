import { z } from 'zod';
import { PixelBuffer } from '../buffer.js';
import { clipRect, fullRect } from '../geometry.js';
import { makeId } from '../ids.js';
import { extractRegion } from '../raster.js';
import {
  EMPTY_TILE,
  autotile,
  blitTilemap,
  fillTilemap,
  tileIndexAt,
  tilemapTerrain,
  setTile,
} from '../tilemap.js';
import {
  celOf,
  defineCommand,
  frameRefSchema,
  layerRefSchema,
  rectSchema,
} from './types.js';
import type { CommandContext } from './types.js';
import type { TilemapLayer, Tileset } from '../document.js';
import type { TilemapId } from '../types.js';

/**
 * A tilemap reference: its ID, its name, or its 0-based position.
 *
 * Tilemaps are addressed like layers and frames so an agent never has to look up an ID
 * it was just handed.
 */
export const tilemapRefSchema = z
  .union([z.string(), z.number().int()])
  .describe('Tilemap ID, name, or 0-based index.');

export type TilemapRef = z.infer<typeof tilemapRefSchema>;

export function findTilemap(sprite: { tilemaps?: TilemapLayer[] }, ref: TilemapRef): TilemapLayer | undefined {
  const list = sprite.tilemaps ?? [];
  if (typeof ref === 'number') return list[ref];
  return list.find((t) => t.id === ref) ?? list.find((t) => t.name === ref);
}

export function resolveTilemap(sprite: { tilemaps?: TilemapLayer[] }, ref: TilemapRef): TilemapLayer {
  const found = findTilemap(sprite, ref);
  if (!found) {
    const known = (sprite.tilemaps ?? []).map((t) => t.name).join(', ') || 'none';
    throw new Error(`Unknown tilemap: ${ref}. Known tilemaps: ${known}`);
  }
  return found;
}

/**
 * Get a tilemap whose `data` is safe to mutate.
 *
 * `cloneSpriteStructure` shares the `Int32Array` between the undo snapshot and the draft,
 * so writing through the original array would edit history itself. Copy-on-write hands
 * back a fresh array exactly once per draft.
 */
function writableTilemap(ctx: CommandContext, ref: TilemapRef): TilemapLayer {
  const tilemap = resolveTilemap(ctx.sprite, ref);
  tilemap.data = ctx.draft.tilemapData(tilemap.id) ?? tilemap.data;
  return tilemap;
}

const setTileSchema = z
  .object({
    x: z.number().int().describe('Tile column.'),
    y: z.number().int().describe('Tile row.'),
    tile: z.number().int().describe('Tile index into the tileset, or -1 to clear.'),
  })
  .strict();

export const createTilesetCommand = defineCommand({
  name: 'create_tileset',
  description:
    'Cut a grid of tiles out of an existing layer and make it the document tileset. Point it at artwork you already drew: a sheet of 16x16 terrain pieces laid out on one layer becomes addressable tiles. Replaces any existing tileset. `source` limits the cut to a region of the layer; `columns` defaults to however many tiles fit across. Watch out on a large canvas: the default really is the whole cel, so cutting a 128x128 sheet out of a 1024x1024 canvas gives you 4096 tiles unless you pass `source` (and usually `columns`).',
  params: z.object({
    layer: layerRefSchema,
    frame: frameRefSchema,
    tileWidth: z.number().int().positive().describe('Tile width in pixels.'),
    tileHeight: z.number().int().positive().describe('Tile height in pixels.'),
    columns: z.number().int().positive().optional().describe('Tiles per row. Defaults to as many as fit.'),
    name: z.string().optional().describe('Tileset name. Defaults to `Tileset`.'),
    source: rectSchema.optional().describe('Region of the layer to cut up. Defaults to the whole cel, so pass this when the sheet is smaller than the canvas.'),
  }),
  apply(ctx, p) {
    const buf = celOf(ctx, p.layer, p.frame, false);
    if (!buf) throw new Error('The source layer has nothing drawn on it, so there are no tiles to cut.');
    const source = p.source ? clipRect(p.source, buf.width, buf.height) : fullRect(buf.width, buf.height);
    const columns = p.columns ?? Math.max(1, Math.floor(source.w / p.tileWidth));
    const rows = Math.max(1, Math.floor(source.h / p.tileHeight));

    const image = new PixelBuffer(columns * p.tileWidth, rows * p.tileHeight);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < columns; col++) {
        const patch = extractRegion(buf, {
          x: source.x + col * p.tileWidth,
          y: source.y + row * p.tileHeight,
          w: p.tileWidth,
          h: p.tileHeight,
        });
        image.blit(patch, col * p.tileWidth, row * p.tileHeight);
      }
    }

    const tileset: Tileset = {
      id: makeId('tileset'),
      name: p.name ?? 'Tileset',
      tileWidth: p.tileWidth,
      tileHeight: p.tileHeight,
      columns,
      image,
    };
    ctx.sprite.tileset = tileset;
    return { tiles: columns * rows, columns, rows, width: image.width, height: image.height };
  },
});

export const addTilemapCommand = defineCommand({
  name: 'add_tilemap',
  description:
    'Add an empty tilemap layer. A tilemap is a grid of tile indices, independent of the pixel layers and frames: draw the terrain once, then stamp or auto-tile it. Tile size defaults to the tileset tile size.',
  params: z.object({
    name: z.string().optional().describe('Tilemap name. Defaults to `Tilemap N`.'),
    width: z.number().int().positive().describe('Width in tiles.'),
    height: z.number().int().positive().describe('Height in tiles.'),
    tileWidth: z.number().int().positive().optional().describe('Tile width in pixels. Defaults to the tileset tile width.'),
    tileHeight: z.number().int().positive().optional().describe('Tile height in pixels. Defaults to the tileset tile height.'),
    index: z.number().int().min(0).optional().describe('Where to insert it. Defaults to on top.'),
  }),
  apply(ctx, p) {
    const list = (ctx.sprite.tilemaps ??= []);
    const tileWidth = p.tileWidth ?? ctx.sprite.tileset?.tileWidth ?? 16;
    const tileHeight = p.tileHeight ?? ctx.sprite.tileset?.tileHeight ?? 16;
    const tilemap: TilemapLayer = {
      id: makeId('tilemap'),
      name: p.name ?? `Tilemap ${list.length + 1}`,
      width: p.width,
      height: p.height,
      tileWidth,
      tileHeight,
      data: new Int32Array(p.width * p.height).fill(EMPTY_TILE),
    };
    if (p.index === undefined || p.index >= list.length) list.push(tilemap);
    else list.splice(p.index, 0, tilemap);
    return { id: tilemap.id, name: tilemap.name, width: p.width, height: p.height, index: list.indexOf(tilemap) };
  },
});

export const removeTilemapCommand = defineCommand({
  name: 'remove_tilemap',
  description: 'Delete a tilemap layer.',
  params: z.object({ tilemap: tilemapRefSchema }),
  apply(ctx, p) {
    const list = ctx.sprite.tilemaps ?? [];
    const tilemap = resolveTilemap(ctx.sprite, p.tilemap);
    const index = list.indexOf(tilemap);
    list.splice(index, 1);
    return { removed: tilemap.name, index };
  },
});

export const setTileCommand = defineCommand({
  name: 'set_tile',
  description:
    'Write tile indices into a tilemap. Pass a `tiles` list for a batch, or a single `x`/`y`/`tile`. Tile index `-1` clears a cell. Coordinates are tile coordinates, not pixels.',
  params: z.object({
    tilemap: tilemapRefSchema,
    tiles: z.array(setTileSchema).optional().describe('Batch of cells to write.'),
    x: z.number().int().optional().describe('Single-cell form: tile column.'),
    y: z.number().int().optional().describe('Single-cell form: tile row.'),
    tile: z.number().int().optional().describe('Single-cell form: tile index, or -1 to clear.'),
  }),
  apply(ctx, p) {
    const tilemap = writableTilemap(ctx, p.tilemap);
    const writes: Array<{ x: number; y: number; tile: number }> = [...(p.tiles ?? [])];
    if (p.x !== undefined && p.y !== undefined && p.tile !== undefined) {
      writes.push({ x: p.x, y: p.y, tile: p.tile });
    }
    if (writes.length === 0) {
      return { written: 0, reason: 'pass `tiles`, or all three of `x`, `y` and `tile`' };
    }
    let written = 0;
    let skipped = 0;
    for (const write of writes) {
      if (setTile(tilemap, write.x, write.y, write.tile)) written++;
      else skipped++;
    }
    return { written, skipped, tilemap: tilemap.name };
  },
});

export const fillTilemapCommand = defineCommand({
  name: 'fill_tilemap',
  description:
    'Fill a rectangle of a tilemap with one tile index. `-1` clears the region. Omit `rect` to fill the whole map. This is the fast way to lay a solid slab of terrain before auto-tiling the edges.',
  params: z.object({
    tilemap: tilemapRefSchema,
    tile: z.number().int().describe('Tile index to write, or -1 to clear.'),
    rect: rectSchema.optional().describe('Region in tile coordinates. Defaults to the whole map.'),
  }),
  apply(ctx, p) {
    const tilemap = writableTilemap(ctx, p.tilemap);
    const filled = fillTilemap(tilemap, p.tile, p.rect);
    return { filled, tile: p.tile, tilemap: tilemap.name };
  },
});

export const resizeTilemapCommand = defineCommand({
  name: 'resize_tilemap',
  description:
    'Change a tilemap size, keeping the existing cells at the given offset. Cells that fall outside the new bounds are dropped; new cells start empty.',
  params: z.object({
    tilemap: tilemapRefSchema,
    width: z.number().int().positive().describe('New width in tiles.'),
    height: z.number().int().positive().describe('New height in tiles.'),
    offsetX: z.number().int().optional().describe('Where the old map lands horizontally. Defaults to 0.'),
    offsetY: z.number().int().optional().describe('Where the old map lands vertically. Defaults to 0.'),
  }),
  apply(ctx, p) {
    const tilemap = writableTilemap(ctx, p.tilemap);
    const offsetX = p.offsetX ?? 0;
    const offsetY = p.offsetY ?? 0;
    const data = new Int32Array(p.width * p.height).fill(EMPTY_TILE);
    let kept = 0;
    for (let y = 0; y < tilemap.height; y++) {
      for (let x = 0; x < tilemap.width; x++) {
        const nx = x + offsetX;
        const ny = y + offsetY;
        if (nx < 0 || ny < 0 || nx >= p.width || ny >= p.height) continue;
        data[ny * p.width + nx] = tilemap.data[y * tilemap.width + x];
        kept++;
      }
    }
    tilemap.width = p.width;
    tilemap.height = p.height;
    tilemap.data = data;
    return { kept, width: p.width, height: p.height, offsetX, offsetY };
  },
});

export const autotileCommand = defineCommand({
  name: 'autotile',
  description:
    'Rewrite a tilemap so its tiles match the terrain around them. Declare which cells are solid (either by `indices`, or every non-empty cell by default) and this picks the right transition tile for each one, so you never hand-place corners. `set: 47` (default) uses the 47-blob set with diagonal-aware inner corners; `set: 16` uses the simpler 4-neighbour 16-tile set. `offset` is the first tile of this terrain in the tileset, so several terrains can share one sheet. ' +
    'THE TILE ORDER IS FIXED, so the sheet you draw has to match it. Neighbour bits: N=1, E=2, S=4, W=8, NE=16, SE=32, SW=64, NW=128. For `set: 47` a diagonal bit only counts when BOTH of its adjacent cardinals are also solid, which is what reduces 256 combinations to 47. The tile index for a cell is `offset` plus the position of its mask in that canonical list, in ascending mask order - so `offset: 0` means tile 0 is fully isolated, and `offset: 48` puts the same set at tiles 48-94. Use `autotileSheet(47)` in `@pixel/core` if you need the exact mask for each index. ' +
    'IMPORTANT: this pass REWRITES the cells it touches, replacing the placeholder index with transition tiles. That means a second identical call with the same `indices` will find almost nothing solid any more and will silently leave the map wrong. To re-run after editing terrain, omit `indices` entirely (any non-empty cell counts as terrain) or list every transition index you now expect.',
  params: z.object({
    tilemap: tilemapRefSchema,
    set: z.union([z.literal(16), z.literal(47)]).optional().describe('Transition set. Defaults to 47 (47-blob).'),
    offset: z.number().int().min(0).optional().describe('First tile index of this terrain. Defaults to 0.'),
    indices: z
      .array(z.number().int())
      .optional()
      .describe(
        'Which tile indices count as solid, matched against the cells\' CURRENT values. Defaults to every non-empty cell, which is the safe choice on a re-run: a previous pass replaced your placeholder index with transition tiles, so the same `indices` list no longer describes the terrain.',
      ),
    rect: rectSchema.optional().describe('Only rewrite this region, in tile coordinates.'),
    skipIsolated: z.boolean().optional().describe('Leave cells with no solid neighbours empty. Defaults to false.'),
  }),
  apply(ctx, p) {
    const tilemap = writableTilemap(ctx, p.tilemap);
    const terrain = tilemapTerrain(tilemap, p.indices);
    const result = autotile(tilemap, terrain, {
      set: p.set ?? 47,
      offset: p.offset ?? 0,
      rect: p.rect,
      skipIsolated: p.skipIsolated,
    });
    return { ...result, tilemap: tilemap.name };
  },
});

export const paintTilemapCommand = defineCommand({
  name: 'paint_tilemap',
  description:
    'Stamp a tilemap into a pixel layer, so the terrain becomes artwork you can export as a PNG. The tilemap itself is unchanged; this is the one-way trip from tiles to pixels.',
  params: z.object({
    tilemap: tilemapRefSchema,
    layer: layerRefSchema,
    frame: frameRefSchema,
    offsetX: z.number().int().optional().describe('Pixel offset. Defaults to 0.'),
    offsetY: z.number().int().optional().describe('Pixel offset. Defaults to 0.'),
    replaceEmpty: z.number().int().optional().describe('Tile index to stamp where the map is empty. Defaults to skipping them.'),
  }),
  apply(ctx, p) {
    const tilemap = resolveTilemap(ctx.sprite, p.tilemap);
    const tileset = ctx.sprite.tileset;
    if (!tileset) throw new Error('This document has no tileset. Run `create_tileset` first.');
    const buf = celOf(ctx, p.layer, p.frame);
    const drawn = blitTilemap(buf, tileset, tilemap, {
      offsetX: p.offsetX,
      offsetY: p.offsetY,
      replaceEmpty: p.replaceEmpty ?? null,
    });
    return { drawn, tilemap: tilemap.name, width: tilemap.width, height: tilemap.height };
  },
});

export const getTilemapCommand = defineCommand({
  name: 'get_tilemap',
  description:
    'Read-only view of a tilemap: its size, how many cells are filled, and the tile indices as rows of numbers. Use it to check a terrain layout without rendering an image. `rect` limits the read to a region. `max` defaults to 1024 tiles, so reading a whole 64x64 map (4096 cells) needs `max: 4096` or a `rect`.',
  readOnly: true,
  params: z.object({
    tilemap: tilemapRefSchema,
    rect: rectSchema.optional().describe('Region in tile coordinates. Defaults to the whole map.'),
    max: z.number().int().positive().optional().describe('Largest region to return, in tiles. Defaults to 1024, which is smaller than a 64x64 map - raise it or pass `rect` for a big map.'),
  }),
  apply(ctx, p) {
    const tilemap = resolveTilemap(ctx.sprite, p.tilemap);
    const rect = p.rect
      ? clipRect(p.rect, tilemap.width, tilemap.height)
      : fullRect(tilemap.width, tilemap.height);
    const max = p.max ?? 1024;
    if (rect.w * rect.h > max) {
      throw new Error(`Region is ${rect.w * rect.h} tiles; pass a smaller rect or a larger \`max\` (limit ${max}).`);
    }
    let filled = 0;
    for (let i = 0; i < tilemap.data.length; i++) {
      if (tilemap.data[i] !== EMPTY_TILE) filled++;
    }
    const rows: number[][] = [];
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      const row: number[] = [];
      for (let x = rect.x; x < rect.x + rect.w; x++) row.push(tileIndexAt(tilemap, x, y));
      rows.push(row);
    }
    return {
      id: tilemap.id,
      name: tilemap.name,
      width: tilemap.width,
      height: tilemap.height,
      tileWidth: tilemap.tileWidth,
      tileHeight: tilemap.tileHeight,
      filled,
      cells: tilemap.data.length,
      rect,
      rows,
    };
  },
});

export const tilemapCommands = [
  createTilesetCommand,
  addTilemapCommand,
  removeTilemapCommand,
  setTileCommand,
  fillTilemapCommand,
  resizeTilemapCommand,
  autotileCommand,
  paintTilemapCommand,
  getTilemapCommand,
];

export type { TilemapId };
