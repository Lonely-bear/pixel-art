import { tileCount, type TilemapLayer, type Tileset } from '@pixel/core';

/**
 * Tile-grid evidence about a tilemap's structure.
 *
 * These numbers deliberately describe evidence instead of declaring a map broken.
 * A rice paddy, river or road is expected to contain long same-tile runs, and an
 * edge tile is expected to repeat its neighbour. This block answers the separate
 * questions of whether indices are valid, whether terrain is connected, and whether
 * one variant has swallowed a region. `preview_tilemap` returns it alongside the
 * image, and `export_tiled` refuses to write a map whose indices or cell size are
 * malformed.
 */
export interface TilemapQualityAnalysis {
  id: string;
  name: string;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  cells: number;
  dataLength: number;
  dataLengthValid: boolean;
  tileCount: number;
  tileSizeMatchesTileset: boolean;
  empty: number;
  emptyRatio: number;
  validFilled: number;
  invalid: number;
  invalidExamples: Array<{ x: number; y: number; tile: number; reason: string }>;
  variants: Array<{ tile: number; count: number; ratio: number; shareOfFilled: number }>;
  dominantVariant: { tile: number; count: number; ratio: number } | null;
  normalizedEntropy: number;
  repetition: {
    horizontalAdjacencies: number;
    verticalAdjacencies: number;
    sameTileAdjacencies: number;
    sameTileRatio: number;
    horizontalRuns: number;
    verticalRuns: number;
    longestHorizontalRun: number;
    longestVerticalRun: number;
    meanHorizontalRun: number;
    meanVerticalRun: number;
  };
  terrain: {
    components: number;
    largestComponent: number;
    singletonComponents: number;
    largestComponentRatio: number;
    boundaryCells: number;
    boundaryRatio: number;
    openEdges: { north: number; east: number; south: number; west: number };
  };
  exactTileComponents: {
    components: number;
    largestComponent: number;
    singletonComponents: number;
  };
  interpretation: string;
}

interface ComponentStats {
  components: number;
  largestComponent: number;
  singletonComponents: number;
}

function emptyComponentStats(): ComponentStats {
  return { components: 0, largestComponent: 0, singletonComponents: 0 };
}

function analyseComponents(
  width: number,
  height: number,
  solid: Uint8Array,
  sameTile?: Int32Array,
): ComponentStats {
  const seen = new Uint8Array(width * height);
  const stack: number[] = [];
  const result = emptyComponentStats();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x;
      if (!solid[start] || seen[start]) continue;
      seen[start] = 1;
      stack.push(start);
      let size = 0;
      let tile = sameTile ? sameTile[start] : EMPTY_SENTINEL;
      while (stack.length > 0) {
        const at = stack.pop() as number;
        const cx = at % width;
        const cy = Math.floor(at / width);
        size++;
        if (sameTile && sameTile[at] !== tile) continue;
        const neighbours = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ];
        for (const [nx, ny] of neighbours) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (!solid[next] || seen[next]) continue;
          if (sameTile && sameTile[next] !== tile) continue;
          seen[next] = 1;
          stack.push(next);
        }
      }
      result.components++;
      result.largestComponent = Math.max(result.largestComponent, size);
      if (size === 1) result.singletonComponents++;
    }
  }
  return result;
}

const EMPTY_SENTINEL = -0x7fffffff;

function runStats(lengths: number[]): { count: number; longest: number; mean: number } {
  if (lengths.length === 0) return { count: 0, longest: 0, mean: 0 };
  let longest = 0;
  let total = 0;
  for (const length of lengths) {
    longest = Math.max(longest, length);
    total += length;
  }
  return { count: lengths.length, longest, mean: total / lengths.length };
}

function validIndex(index: number, available: number): boolean {
  return index >= 0 && index < available;
}

/** Measure a tilemap's index validity, repetition and terrain connectivity. */
export function analyzeTilemapQuality(
  tilemap: TilemapLayer,
  tileset: Tileset,
): TilemapQualityAnalysis {
  const expectedCells = tilemap.width * tilemap.height;
  const available = tileCount(tileset);
  const counts = new Map<number, number>();
  const solid = new Uint8Array(expectedCells);
  const sameTile = new Int32Array(expectedCells);
  const invalidExamples: TilemapQualityAnalysis['invalidExamples'] = [];
  let empty = 0;
  let invalid = 0;
  let validFilled = 0;

  for (let y = 0; y < tilemap.height; y++) {
    for (let x = 0; x < tilemap.width; x++) {
      const at = y * tilemap.width + x;
      const index = tilemap.data[at] ?? -1;
      if (index === -1) {
        empty++;
        continue;
      }
      if (!validIndex(index, available)) {
        invalid++;
        if (invalidExamples.length < 32) {
          invalidExamples.push({
            x,
            y,
            tile: index,
            reason: index < -1 ? 'below_empty_sentinel' : 'outside_tileset',
          });
        }
        continue;
      }
      validFilled++;
      counts.set(index, (counts.get(index) ?? 0) + 1);
      solid[at] = 1;
      sameTile[at] = index;
    }
  }

  const variants = [...counts.entries()]
    .map(([tile, count]) => ({
      tile,
      count,
      ratio: expectedCells > 0 ? count / expectedCells : 0,
      shareOfFilled: validFilled > 0 ? count / validFilled : 0,
    }))
    .sort((a, b) => b.count - a.count || a.tile - b.tile);
  const dominantVariant = variants[0]
    ? { tile: variants[0].tile, count: variants[0].count, ratio: variants[0].ratio }
    : null;
  const entropy = variants.reduce((sum, variant) => {
    if (variant.shareOfFilled <= 0) return sum;
    return sum - variant.shareOfFilled * Math.log2(variant.shareOfFilled);
  }, 0);
  const normalizedEntropy = variants.length > 1 ? entropy / Math.log2(variants.length) : 0;

  const horizontalRuns: number[] = [];
  const verticalRuns: number[] = [];
  let horizontalAdjacencies = 0;
  let verticalAdjacencies = 0;
  let sameTileAdjacencies = 0;
  for (let y = 0; y < tilemap.height; y++) {
    let run = 0;
    let runTile = EMPTY_SENTINEL;
    for (let x = 0; x <= tilemap.width; x++) {
      const at = y * tilemap.width + x;
      const index = x < tilemap.width && solid[at] ? sameTile[at] : EMPTY_SENTINEL;
      if (x < tilemap.width && validIndex(tileIndexAtUnchecked(tilemap, x, y), available)) {
        if (x + 1 < tilemap.width && validIndex(tileIndexAtUnchecked(tilemap, x + 1, y), available)) {
          horizontalAdjacencies++;
          if (index === tileIndexAtUnchecked(tilemap, x + 1, y)) sameTileAdjacencies++;
        }
      }
      if (index === runTile) {
        run++;
      } else {
        if (run > 0 && runTile !== EMPTY_SENTINEL) horizontalRuns.push(run);
        run = index === EMPTY_SENTINEL ? 0 : 1;
        runTile = index;
      }
    }
  }
  for (let x = 0; x < tilemap.width; x++) {
    let run = 0;
    let runTile = EMPTY_SENTINEL;
    for (let y = 0; y <= tilemap.height; y++) {
      const at = y * tilemap.width + x;
      const index = y < tilemap.height && solid[at] ? sameTile[at] : EMPTY_SENTINEL;
      if (y < tilemap.height && validIndex(tileIndexAtUnchecked(tilemap, x, y), available)) {
        if (y + 1 < tilemap.height && validIndex(tileIndexAtUnchecked(tilemap, x, y + 1), available)) {
          verticalAdjacencies++;
          if (index === tileIndexAtUnchecked(tilemap, x, y + 1)) sameTileAdjacencies++;
        }
      }
      if (index === runTile) {
        run++;
      } else {
        if (run > 0 && runTile !== EMPTY_SENTINEL) verticalRuns.push(run);
        run = index === EMPTY_SENTINEL ? 0 : 1;
        runTile = index;
      }
    }
  }
  const horizontal = runStats(horizontalRuns);
  const vertical = runStats(verticalRuns);
  const totalAdjacencies = horizontalAdjacencies + verticalAdjacencies;

  const terrainComponents = analyseComponents(tilemap.width, tilemap.height, solid);
  const exactComponents = analyseComponents(tilemap.width, tilemap.height, solid, sameTile);
  let boundaryCells = 0;
  const openEdges = { north: 0, east: 0, south: 0, west: 0 };
  for (let y = 0; y < tilemap.height; y++) {
    for (let x = 0; x < tilemap.width; x++) {
      const at = y * tilemap.width + x;
      if (!solid[at]) continue;
      const sides = [
        { dx: 0, dy: -1, edge: 'north' as const },
        { dx: 1, dy: 0, edge: 'east' as const },
        { dx: 0, dy: 1, edge: 'south' as const },
        { dx: -1, dy: 0, edge: 'west' as const },
      ];
      let boundary = false;
      for (const side of sides) {
        const nx = x + side.dx;
        const ny = y + side.dy;
        const outside = nx < 0 || ny < 0 || nx >= tilemap.width || ny >= tilemap.height;
        if (outside || !solid[ny * tilemap.width + nx]) {
          boundary = true;
          openEdges[side.edge]++;
        }
      }
      if (boundary) boundaryCells++;
    }
  }

  return {
    id: tilemap.id,
    name: tilemap.name,
    width: tilemap.width,
    height: tilemap.height,
    tileWidth: tilemap.tileWidth,
    tileHeight: tilemap.tileHeight,
    cells: expectedCells,
    dataLength: tilemap.data.length,
    dataLengthValid: tilemap.data.length === expectedCells,
    tileCount: available,
    tileSizeMatchesTileset:
      tilemap.tileWidth === tileset.tileWidth && tilemap.tileHeight === tileset.tileHeight,
    empty,
    emptyRatio: expectedCells > 0 ? empty / expectedCells : 0,
    validFilled,
    invalid,
    invalidExamples,
    variants,
    dominantVariant,
    normalizedEntropy,
    repetition: {
      horizontalAdjacencies,
      verticalAdjacencies,
      sameTileAdjacencies,
      sameTileRatio: totalAdjacencies > 0 ? sameTileAdjacencies / totalAdjacencies : 0,
      horizontalRuns: horizontal.count,
      verticalRuns: vertical.count,
      longestHorizontalRun: horizontal.longest,
      longestVerticalRun: vertical.longest,
      meanHorizontalRun: horizontal.mean,
      meanVerticalRun: vertical.mean,
    },
    terrain: {
      ...terrainComponents,
      largestComponentRatio: validFilled > 0 ? terrainComponents.largestComponent / validFilled : 0,
      boundaryCells,
      boundaryRatio: validFilled > 0 ? boundaryCells / validFilled : 0,
      openEdges,
    },
    exactTileComponents: exactComponents,
    interpretation:
      'Tile repetition, long runs and horizontal bands are evidence rather than defects: water, fields and roads intentionally use them. Use invalid indices, disconnected terrain, dominant variants and the debug preview to decide what needs changing.',
  };
}

function tileIndexAtUnchecked(tilemap: TilemapLayer, x: number, y: number): number {
  return tilemap.data[y * tilemap.width + x] ?? -1;
}
