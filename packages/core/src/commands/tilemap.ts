import { z } from 'zod';
import { PixelBuffer } from '../buffer.js';
import { clipRect, fullRect } from '../geometry.js';
import { makeId } from '../ids.js';
import { extractRegion } from '../raster.js';
import {
  EMPTY_TILE,
  autotile,
  blitTilemap,
  bakeTilemapCells,
  bakeTilemapRect,
  fillTilemapReport,
  mapRect,
  strokeTilemap,
  tileCellsBounds,
  tileCount,
  tileIndexAt,
  tilemapRegionPixels,
  tilemapTerrain,
  setTile,
  type TileBlend,
} from '../tilemap.js';
import {
  celOf,
  defineCommand,
  frameRefSchema,
  layerRefSchema,
  rectSchema,
} from './types.js';
import type { CommandContext, FrameRef, LayerRef } from './types.js';
import type { TilemapLayer, Tileset } from '../document.js';
import type { Point, Rect, TilemapId } from '../types.js';

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

/* ------------------------------------------------------------------ *
 * Tile index validation
 *
 * A tile index that does not exist in the sheet is not a formatting mistake, it is a
 * silent hole: the cell reads back as a valid number and renders as nothing. Every
 * command that accepts indices therefore either refuses the call or reports the cell as
 * skipped, and never quietly writes a number no tile backs.
 * ------------------------------------------------------------------ */

/** How many cells one `set_tile` batch may carry. */
const MAX_TILE_WRITES = 100_000;

function checkTileIndex(tileset: Tileset | undefined, tile: number, what: string): string | null {
  if (!Number.isInteger(tile)) return `${what} must be an integer, got ${tile}`;
  if (tile < -1) return `${what} must be -1 (empty) or a tile index of 0 or more, got ${tile}`;
  if (tileset && tile >= tileCount(tileset)) {
    return `tile ${tile} is past the end of "${tileset.name}", which holds ${tileCount(tileset)} tiles (0-${tileCount(tileset) - 1})`;
  }
  return null;
}

/** Throw on an index no tile backs. Used where there is no per-cell report to attach to. */
function requireTileIndices(tileset: Tileset | undefined, tiles: readonly number[], what: string): void {
  for (let i = 0; i < tiles.length; i++) {
    const problem = checkTileIndex(tileset, tiles[i], `${what}[${i}]`);
    if (problem) throw new Error(problem);
  }
}

/* ------------------------------------------------------------------ *
 * Baking tiles into a pixel layer
 *
 * Editing a tilemap and then stamping the whole thing again is the slow, destructive way
 * to keep pixels in step: it re-lays the entire map on top of whatever else lives on the
 * layer, and it cannot remove a pixel that a since-deleted tile used to own. `bake`
 * re-stamps only the cells a command actually changed, clearing each one's pixels first
 * so a cell that became empty takes its old pixels with it.
 * ------------------------------------------------------------------ */

const bakeShape = {
  frame: frameRefSchema.optional().describe('Frame to bake into. Defaults to frame 0.'),
  offsetX: z.number().int().optional().describe('Pixel offset of the map origin. Defaults to 0.'),
  offsetY: z.number().int().optional().describe('Pixel offset of the map origin. Defaults to 0.'),
  opacity: z.number().min(0).max(1).optional().describe('0-1 multiplier on the active baked tiles. Defaults to 1.'),
  underlay: tilemapRefSchema
    .optional()
    .describe('Ground/base tilemap rendered first with the same cell size, so partial-alpha edges blend over it.'),
  blend: z
    .enum(['copy', 'over'])
    .optional()
    .describe('`over` (default) composites with what is already on the cel, so a soft-edged tile fuses; `copy` overwrites the pixels it lands on.'),
};

/**
 * Where and how to bake changed tiles into a pixel layer.
 *
 * `layer` is the only required part, and the second branch of the schema exists purely to
 * say so: an agent that reaches for `bake: { frame: 0 }` is told which argument is
 * missing instead of being handed a type error about a string it never passed.
 */
export interface BakeParams {
  /** Pixel layer that holds the baked terrain. */
  layer: LayerRef;
  /** Frame to bake into. Defaults to 0. */
  frame?: FrameRef;
  offsetX?: number;
  offsetY?: number;
  opacity?: number;
  underlay?: TilemapRef;
  blend?: TileBlend;
}

const bakeSchema = z.union([
  z
    .object({
      layer: layerRefSchema.describe('Pixel layer that holds the baked terrain.'),
      ...bakeShape,
    })
    .strict()
    .describe(
      'Re-stamp the tiles this command changed into a pixel layer, clearing and redrawing only those cells.',
    ),
  z.object({ ...bakeShape }).strict().refine(() => false, {
    message:
      'bake needs a `layer`. `frame`, `offsetX`, `offsetY`, `opacity`, `underlay` and `blend` say how to bake, not where: pass `bake: { layer: "terrain", frame: 0 }`.',
  }),
]) as unknown as z.ZodType<BakeParams>;

/** The cel, tileset and blend settings a bake needs, resolved once. */
function bakeTarget(ctx: CommandContext, bake: BakeParams) {
  const tileset = ctx.sprite.tileset;
  if (!tileset) {
    throw new Error(
      'This document has no tileset, so there are no tiles to bake into pixels. Run `create_tileset` first.',
    );
  }
  const underlay = bake.underlay === undefined
    ? undefined
    : resolveTilemap(ctx.sprite, bake.underlay);
  return {
    cel: celOf(ctx, bake.layer, bake.frame ?? 0),
    tileset,
    underlay,
    opts: {
      offsetX: bake.offsetX ?? 0,
      offsetY: bake.offsetY ?? 0,
      opacity: bake.opacity ?? 1,
      blend: (bake.blend ?? 'over') as TileBlend,
      underlay,
    },
  };
}

function validateBakeUnderlay(underlay: TilemapLayer | undefined, tilemap: TilemapLayer): void {
  if (underlay && (underlay.tileWidth !== tilemap.tileWidth || underlay.tileHeight !== tilemap.tileHeight)) {
    throw new Error('Tilemap bake underlay must use the same cell size as the active map.');
  }
}

interface BakeSummary {
  baked: number;
  bakeRect: Rect | null;
  clearedPixels: number;
  underlay: string | null;
}

/** No bake asked for, or nothing changed: no cel is created and nothing is counted. */
const NO_BAKE: BakeSummary = { baked: 0, bakeRect: null, clearedPixels: 0, underlay: null };

/** Re-stamp a scattered set of changed cells, one pixel box at a time. */
function bakeCells(
  ctx: CommandContext,
  bake: BakeParams | undefined,
  tilemap: TilemapLayer,
  cells: readonly Point[],
): BakeSummary {
  if (!bake || cells.length === 0) return NO_BAKE;
  const { cel, tileset, underlay, opts } = bakeTarget(ctx, bake);
  validateBakeUnderlay(underlay, tilemap);
  const result = bakeTilemapCells(cel, tileset, tilemap, cells, opts);
  return {
    baked: result.cells,
    bakeRect: tileCellsBounds(cells),
    clearedPixels: result.clearedPixels,
    underlay: underlay?.name ?? null,
  };
}

/** Re-stamp a whole region, which is cheaper than per-cell when the cells are adjacent. */
function bakeArea(
  ctx: CommandContext,
  bake: BakeParams | undefined,
  tilemap: TilemapLayer,
  rect: Rect | null,
): BakeSummary {
  if (!bake || !rect || rect.w <= 0 || rect.h <= 0) return NO_BAKE;
  const { cel, tileset, underlay, opts } = bakeTarget(ctx, bake);
  validateBakeUnderlay(underlay, tilemap);
  const result = bakeTilemapRect(cel, tileset, tilemap, rect, opts);
  return {
    baked: result.cells,
    bakeRect: rect,
    clearedPixels: result.clearedPixels,
    underlay: underlay?.name ?? null,
  };
}

const setTileSchema = z
  .object({
    x: z.number().int().describe('Tile column.'),
    y: z.number().int().describe('Tile row.'),
    tile: z.number().int().describe('Tile index into the tileset, or -1 to clear.'),
  })
  .strict();

/** One entry of a `stroke_tilemap` palette: a tile, optionally weighted. */
const strokeTileSchema = z
  .union([
    z.number().int(),
    z
      .object({
        tile: z.number().int(),
        weight: z.number().positive().optional(),
      })
      .strict(),
  ])
  .describe('A tile to paint, or {tile, weight} to make it more or less common than its siblings.');

/** One entry of a custom transition mapping. */
const transitionSchema = z
  .object({
    mask: z
      .number()
      .int()
      .min(0)
      .max(255)
      .describe('Neighbour mask. Bits: N=1, E=2, S=4, W=8, NE=16, SE=32, SW=64, NW=128.'),
    tile: z.number().int().describe('Tile index to place on a cell with this mask, or -1 to clear it.'),
    weight: z
      .number()
      .positive()
      .optional()
      .describe('Relative weight when several tiles share one mask. Defaults to 1.'),
  })
  .strict()
  .describe('What a mask becomes. Repeat a mask to give one silhouette several variants.');

const strokeEdgeSchema = z
  .object({
    set: z.union([z.literal(16), z.literal(47)]).optional().describe('Transition set. Defaults to 47.'),
    transitions: z
      .array(transitionSchema)
      .min(1)
      .describe('Mask -> tile mapping. Any order, any subset of masks; a mask you leave out keeps its base variant.'),
    offset: z.number().int().min(0).optional().describe('First tile of the fallback set layout. Defaults to 0.'),
    seed: z.number().int().optional().describe('Seed for the transition variant choice. Defaults to the stroke seed.'),
    avoidRepeats: z.boolean().optional().describe('Avoid the left and upper neighbour transition tile. Defaults to true.'),
    unmapped: z
      .enum(['keep', 'offset'])
      .optional()
      .describe('What a mask missing from `transitions` does: `keep` (default) leaves the painted variant, `offset` falls back to the set layout.'),
  })
  .strict()
  .describe(
    'Border handling. The terrain is judged by the variants the stroke laid down, not by the transition indices, so a second stroke over the same map still sees the shape.',
  );

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
    'Write tile indices into a tilemap. Pass a `tiles` list for a batch (up to 100000 cells), or a single `x`/`y`/`tile`. Tile index `-1` clears a cell. Coordinates are tile coordinates, not pixels. ' +
    'Every cell is accounted for: a cell outside the map, or a tile index past the end of the tileset, comes back in `skippedCells` with the reason, rather than being written as a number that renders as nothing. `written` counts the cells that were valid and attempted, `changed` only the ones whose value really moved, and `changedRect` is the bounding box of those. Writing the same cell twice in one batch is counted in `duplicateWrites` and the last write wins. ' +
    'With `bake`, only the cells that changed are cleared and re-stamped into a pixel layer, so the artwork follows the map without a full repaint.',
  params: z.object({
    tilemap: tilemapRefSchema,
    tiles: z.array(setTileSchema).optional().describe('Batch of cells to write, up to 100000 entries.'),
    x: z.number().int().optional().describe('Single-cell form: tile column.'),
    y: z.number().int().optional().describe('Single-cell form: tile row.'),
    tile: z.number().int().optional().describe('Single-cell form: tile index, or -1 to clear.'),
    bake: bakeSchema.optional().describe('Re-stamp the changed cells into this pixel layer.'),
  }),
  apply(ctx, p) {
    const tilemap = writableTilemap(ctx, p.tilemap);
    const tileset = ctx.sprite.tileset;
    const given = [p.x, p.y, p.tile].filter((value) => value !== undefined).length;
    if (given !== 0 && given !== 3) {
      const named = [['x', p.x], ['y', p.y], ['tile', p.tile]]
        .filter(([, value]) => value === undefined)
        .map(([name]) => name)
        .join(', ');
      throw new Error(
        `set_tile takes either a \`tiles\` batch or all three of \`x\`, \`y\` and \`tile\`. Missing: ${named}.`,
      );
    }
    const writes: Array<{ x: number; y: number; tile: number }> = [...(p.tiles ?? [])];
    if (given === 3) writes.push({ x: p.x!, y: p.y!, tile: p.tile! });
    if (writes.length === 0) {
      return {
        requested: 0,
        written: 0,
        changed: 0,
        unchanged: 0,
        skipped: 0,
        skippedCells: [],
        changedRect: null,
        duplicateWrites: 0,
        tilemap: tilemap.name,
        reason: 'pass `tiles`, or all three of `x`, `y` and `tile`',
      };
    }
    if (writes.length > MAX_TILE_WRITES) {
      throw new Error(
        `set_tile got ${writes.length} cells, over the ${MAX_TILE_WRITES} limit for one call. Split the batch.`,
      );
    }

    let written = 0;
    let changed = 0;
    let unchanged = 0;
    let duplicateWrites = 0;
    let minX = tilemap.width;
    let minY = tilemap.height;
    let maxX = -1;
    let maxY = -1;
    const changedCells: Point[] = [];
    const touched = new Set<number>();
    const skippedCells: Array<{
      x: number;
      y: number;
      tile: number;
      code: 'out_of_bounds' | 'tile_out_of_range';
      reason: string;
    }> = [];

    for (const write of writes) {
      // An index that cannot exist is a caller error, not a cell to shrug at: silently
      // writing it leaves a map that reads back fine and renders as a hole.
      if (write.tile < -1) {
        throw new Error(
          `set_tile: tile must be -1 (clear) or a tile index of 0 or more, got ${write.tile} for (${write.x}, ${write.y}).`,
        );
      }
      if (write.x < 0 || write.y < 0 || write.x >= tilemap.width || write.y >= tilemap.height) {
        skippedCells.push({
          x: write.x,
          y: write.y,
          tile: write.tile,
          code: 'out_of_bounds',
          reason: `outside the ${tilemap.width}x${tilemap.height} map`,
        });
        continue;
      }
      const indexProblem = checkTileIndex(tileset, write.tile, 'tile');
      if (indexProblem) {
        skippedCells.push({
          x: write.x,
          y: write.y,
          tile: write.tile,
          code: 'tile_out_of_range',
          reason: indexProblem,
        });
        continue;
      }
      const at = write.y * tilemap.width + write.x;
      // The later write still wins, as it always has; this only makes the overwrite
      // visible instead of leaving the caller to diff the batch by hand.
      if (touched.has(at)) duplicateWrites++;
      touched.add(at);
      const before = tilemap.data[at];
      setTile(tilemap, write.x, write.y, write.tile);
      written++;
      if (before === write.tile) {
        unchanged++;
        continue;
      }
      changed++;
      changedCells.push({ x: write.x, y: write.y });
      if (write.x < minX) minX = write.x;
      if (write.y < minY) minY = write.y;
      if (write.x > maxX) maxX = write.x;
      if (write.y > maxY) maxY = write.y;
    }

    const changedRect = maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    return {
      requested: writes.length,
      written,
      changed,
      unchanged,
      skipped: skippedCells.length,
      skippedCells,
      changedRect,
      duplicateWrites,
      tilemap: tilemap.name,
      ...bakeCells(ctx, p.bake, tilemap, changedCells),
    };
  },
});

export const fillTilemapCommand = defineCommand({
  name: 'fill_tilemap',
  description:
    'Fill a rectangle of a tilemap with one tile index. `-1` clears the region. Omit `rect` to fill the whole map. This is the fast way to lay a solid slab of terrain before auto-tiling the edges. ' +
    '`changed` counts the cells whose value actually moved and `changedRect` is their bounding box, so a fill that re-writes the same tile reports no edit at all. With `bake`, only the changed region is re-stamped into a pixel layer.',
  params: z.object({
    tilemap: tilemapRefSchema,
    tile: z.number().int().describe('Tile index to write, or -1 to clear.'),
    rect: rectSchema.optional().describe('Region in tile coordinates. Defaults to the whole map.'),
    bake: bakeSchema.optional().describe('Re-stamp the changed region into this pixel layer.'),
  }),
  apply(ctx, p) {
    const tilemap = writableTilemap(ctx, p.tilemap);
    const problem = checkTileIndex(ctx.sprite.tileset, p.tile, 'tile');
    if (problem) throw new Error(`fill_tilemap: ${problem}.`);
    const result = fillTilemapReport(tilemap, p.tile, p.rect);
    return {
      filled: result.filled,
      changed: result.changed,
      changedRect: result.changedRect,
      tile: p.tile,
      tilemap: tilemap.name,
      ...bakeArea(ctx, p.bake, tilemap, result.changedRect),
    };
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

/** The mapping parameters a terrain pass accepts, spread into `autotile`. */
const mappingShape = {
  transitions: z
    .array(transitionSchema)
    .optional()
    .describe(
      'Custom mask -> tile mapping. Any order, any subset of masks, and repeat a mask to give one silhouette several weighted variants. Omit it entirely to keep the plain set layout.',
    ),
  seed: z.number().int().optional().describe('Seed for the variant choice. Same seed and map means the same terrain, every time.'),
  avoidRepeats: z
    .boolean()
    .optional()
    .describe('Avoid giving a cell the same variant as the cell to its left or above. Defaults to true.'),
  unmapped: z
    .enum(['offset', 'keep'])
    .optional()
    .describe('What a mask missing from `transitions` does: `offset` (default) falls back to the set layout, `keep` leaves the cell alone.'),
};

export const autotileCommand = defineCommand({
  name: 'autotile',
  description:
    'Rewrite a tilemap so its tiles match the terrain around them. Declare which cells are solid (either by `indices`, or every non-empty cell by default) and this picks the right transition tile for each one, so you never hand-place corners. `set: 47` (default) uses the 47-blob set with diagonal-aware inner corners; `set: 16` uses the simpler 4-neighbour 16-tile set. `offset` is the first tile of this terrain in the tileset, so several terrains can share one sheet. ' +
    'THE TILE ORDER IS FIXED, so the sheet you draw has to match it. Neighbour bits: N=1, E=2, S=4, W=8, NE=16, SE=32, SW=64, NW=128. For `set: 47` a diagonal bit only counts when BOTH of its adjacent cardinals are also solid, which is what reduces 256 combinations to 47. The tile index for a cell is `offset` plus the position of its mask in that canonical list, in ascending mask order - so `offset: 0` means tile 0 is fully isolated, and `offset: 48` puts the same set at tiles 48-94. Use `autotileSheet(47)` in `@pixel/core` if you need the exact mask for each index. ' +
    'A `transitions` mapping replaces that convention for the masks you name, in any order and covering any subset: handy for a hand-picked set, or for one mask with three interchangeable tiles. Masks are canonicalised for `set: 47` and masked to the four cardinals for `set: 16`, so the same list works for either. A mask the mapping does not cover falls back to the set layout, or is left alone with `unmapped: "keep"`. When one mask has several variants, `seed` decides which and `avoidRepeats` (default true) steers each cell away from the variant on its left and above, so a coast is not a row of identical tiles. ' +
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
    ...mappingShape,
    bake: bakeSchema.optional().describe('Re-stamp the changed cells into this pixel layer.'),
  }),
  apply(ctx, p) {
    const tilemap = writableTilemap(ctx, p.tilemap);
    const tileset = ctx.sprite.tileset;
    if (p.transitions && tileset) {
      requireTileIndices(tileset, p.transitions.map((entry) => entry.tile), 'transitions tile');
    }
    const terrain = tilemapTerrain(tilemap, p.indices);
    const result = autotile(tilemap, terrain, {
      set: p.set ?? 47,
      offset: p.offset ?? 0,
      rect: p.rect,
      skipIsolated: p.skipIsolated,
      transitions: p.transitions,
      seed: p.seed,
      avoidRepeats: p.avoidRepeats,
      unmapped: p.unmapped,
    });
    // The changed cells are contiguous in the usual case, so one rect beats a cell loop.
    return { ...result, tilemap: tilemap.name, ...bakeArea(ctx, p.bake, tilemap, result.changedRect) };
  },
});

export const strokeTilemapCommand = defineCommand({
  name: 'stroke_tilemap',
  description:
    'Paint terrain along a path. This is the tool for a coastline, a cliff edge, a cave wall or a road: give it a few points in TILE coordinates (floats allowed, y grows downward) and it lays a brush of the requested width along a curve through them, breaks the interior up with weighted tile variants, and lets an `edge` mapping finish the border with the right transition tile for each neighbour mask. ' +
    'The defaults suit terrain: `width: 1` (a diameter, so it covers the cells the path runs through), `brush: "round"`, `smoothing: "catmull-rom"` (which rounds the corners between your points — pass `smoothing: "linear"` for a polyline), `density: 1`, `jitter: 0.12` and `avoidRepeats: true`. `jitter` is a smooth variation of the brush radius, so the edge wanders instead of being an exact offset of the path; it only moves the boundary, never hollows out the middle. `density` thins the interior by sampling cells deterministically, and `seed` decides every choice, so the same call always paints the same terrain. ' +
    '`tiles` takes a bare index or `{tile, weight}`; three grass tiles with weights 5/3/1 is a meadow, three with equal weights is stripes. Repeat avoidance steers each cell away from the variant on its left and above, which is what stops a stroke from looking rubber-stamped. `replace: false` leaves cells that already hold a tile alone. ' +
    'With `edge`, the cells the stroke touched become border tiles: the terrain is judged by the variants the stroke laid down, never by the transition indices, so a second stroke over the same map still sees the shape. `transitions` is a mask -> tile list in any order, covering any subset of masks, and repeating a mask gives that silhouette several weighted variants; a mask you leave out keeps the variant that was painted. With `bake`, the changed cells are re-stamped into a pixel layer as you go.',
  params: z.object({
    tilemap: tilemapRefSchema,
    points: z
      .array(z.object({ x: z.number(), y: z.number() }).strict())
      .min(2)
      .max(2000)
      .describe('Path in tile coordinates, floats allowed. The first point starts the stroke; at least 2 are needed.'),
    tiles: z.array(strokeTileSchema).min(1).describe('What to paint: tile indices, optionally weighted.'),
    width: z.number().positive().optional().describe('Brush diameter in tiles, measured across the path. Defaults to 1.'),
    brush: z.enum(['round', 'square']).optional().describe('`round` follows the path, `square` is an axis-aligned stamp. Defaults to `round`.'),
    smoothing: z.enum(['linear', 'catmull-rom']).optional().describe('How to get from your points to a curve. Defaults to `catmull-rom`.'),
    density: z.number().min(0).max(1).optional().describe('Fraction of covered cells to paint, 0-1. Defaults to 1.'),
    jitter: z.number().min(0).max(0.5).optional().describe('Smooth perturbation of the brush boundary, 0-0.5. Defaults to 0.12.'),
    seed: z.number().int().optional().describe('Seed for the variant choice, the density sample and the jitter field. Defaults to 0.'),
    avoidRepeats: z.boolean().optional().describe('Avoid the left and upper neighbour variant. Defaults to true.'),
    replace: z.boolean().optional().describe('`false` leaves cells that already hold a tile alone. Defaults to true.'),
    rect: rectSchema.optional().describe('Restrict the stroke to this region, in tile coordinates.'),
    edge: strokeEdgeSchema.optional().describe('Border handling for the cells the stroke touched.'),
    bake: bakeSchema.optional().describe('Re-stamp the changed cells into this pixel layer.'),
  }),
  apply(ctx, p) {
    const tilemap = writableTilemap(ctx, p.tilemap);
    const tileset = ctx.sprite.tileset;
    if (tileset) {
      requireTileIndices(
        tileset,
        p.tiles.map((entry) => (typeof entry === 'number' ? entry : entry.tile)),
        'tiles',
      );
      if (p.edge) {
        requireTileIndices(tileset, p.edge.transitions.map((entry) => entry.tile), 'edge transitions tile');
      }
    }
    const result = strokeTilemap(tilemap, p.points, {
      tiles: p.tiles,
      width: p.width,
      brush: p.brush,
      smoothing: p.smoothing,
      density: p.density,
      jitter: p.jitter,
      seed: p.seed,
      avoidRepeats: p.avoidRepeats,
      replace: p.replace,
      rect: p.rect,
      edge: p.edge,
    });
    return {
      ...result,
      tilemap: tilemap.name,
      // Per cell, not per bounding box: the box of a diagonal stroke is mostly cells it
      // never touched, and re-stamping those turns every stroke into a full repaint.
      ...bakeCells(ctx, p.bake, tilemap, result.cells),
    };
  },
});

export const paintTilemapCommand = defineCommand({
  name: 'paint_tilemap',
  description:
    'Stamp a tilemap into a pixel layer, so the terrain becomes artwork you can export as a PNG. The tilemap itself is unchanged; this is the one-way trip from tiles to pixels. ' +
    '`blend: "over"` composites per pixel, so a tile with a soft or semi-transparent edge fuses with the artwork underneath instead of replacing it; pass `underlay` to rebuild that ground from another tilemap in the same operation. The default `copy` overwrites, which is what a level drawn on an empty cel wants. `clear: true` wipes the destination pixels of the region first, which matters for a re-paint: cells that are empty in the map would otherwise leave the old pixels behind. `rect` limits the work to a region in tile coordinates.',
  params: z.object({
    tilemap: tilemapRefSchema,
    underlay: tilemapRefSchema
      .optional()
      .describe('Optional ground/base tilemap rendered first with the same cell size, so alpha edges blend over it.'),
    layer: layerRefSchema,
    frame: frameRefSchema,
    offsetX: z.number().int().optional().describe('Pixel offset. Defaults to 0.'),
    offsetY: z.number().int().optional().describe('Pixel offset. Defaults to 0.'),
    replaceEmpty: z.number().int().optional().describe('Tile index to stamp where the map is empty. Defaults to skipping them.'),
    rect: rectSchema.optional().describe('Region in tile coordinates to paint. Defaults to the whole map.'),
    blend: z
      .enum(['copy', 'over'])
      .optional()
      .describe('`copy` (default) overwrites the destination; `over` composites source-over, keeping what is underneath a semi-transparent tile.'),
    opacity: z.number().min(0).max(1).optional().describe('0-1 multiplier on the source alpha. Defaults to 1.'),
    clear: z.boolean().optional().describe('Clear the destination pixels of the region before painting. Defaults to false.'),
  }),
  apply(ctx, p) {
    const tilemap = resolveTilemap(ctx.sprite, p.tilemap);
    const underlay = p.underlay === undefined ? undefined : resolveTilemap(ctx.sprite, p.underlay);
    validateBakeUnderlay(underlay, tilemap);
    const tileset = ctx.sprite.tileset;
    if (!tileset) throw new Error('This document has no tileset. Run `create_tileset` first.');
    const buf = celOf(ctx, p.layer, p.frame);
    const area = mapRect(tilemap, p.rect);
    const offsetX = p.offsetX ?? 0;
    const offsetY = p.offsetY ?? 0;
    const drawn = blitTilemap(buf, tileset, tilemap, {
      offsetX,
      offsetY,
      replaceEmpty: p.replaceEmpty ?? null,
      rect: p.rect,
      blend: p.blend,
      opacity: p.opacity,
      clear: p.clear,
      underlay,
    });
    const cleared = p.clear
      ? clipRect(tilemapRegionPixels(tilemap, area, offsetX, offsetY), buf.width, buf.height)
      : null;
    return {
      drawn,
      clearedPixels: cleared ? cleared.w * cleared.h : 0,
      rect: area,
      blend: p.blend ?? 'copy',
      tilemap: tilemap.name,
      underlay: underlay?.name ?? null,
      width: tilemap.width,
      height: tilemap.height,
    };
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
  strokeTilemapCommand,
  paintTilemapCommand,
  getTilemapCommand,
];

export type { TilemapId };
