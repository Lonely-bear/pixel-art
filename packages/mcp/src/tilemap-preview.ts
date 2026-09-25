import {
  blendInto,
  blitTilemap,
  clipRect,
  PixelBuffer,
  scaleNearest,
  tileCount,
  type Color,
  type Sprite,
  type TilemapLayer,
} from '@pixel/core';
import { analyzeTilemapQuality, type TilemapQualityAnalysis } from './quality-tilemap.js';

export interface TilemapDebugOptions {
  grid?: boolean;
  indices?: boolean;
  showInvalid?: boolean;
  highlightCells?: Array<{ x: number; y: number }>;
  highlightRect?: { x: number; y: number; w: number; h: number };
}

export interface TilemapPreviewOptions {
  rect?: { x: number; y: number; w: number; h: number };
  underlay?: TilemapLayer;
  scale?: number;
  background?: Color | null;
  replaceEmpty?: number;
  opacity?: number;
  debug?: TilemapDebugOptions;
  maxOutputPixels?: number;
}

export interface TilemapPreviewResult {
  image: PixelBuffer;
  meta: Record<string, unknown>;
  structure: TilemapQualityAnalysis;
}

const DIGITS: Record<string, readonly string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '-': ['000', '000', '111', '000', '000'],
};

const LABEL_COLOR: Color = { r: 255, g: 255, b: 255, a: 235 };
const LABEL_SHADOW: Color = { r: 12, g: 14, b: 20, a: 220 };
const GRID_COLOR: Color = { r: 18, g: 22, b: 30, a: 145 };
const HIGHLIGHT_COLOR: Color = { r: 255, g: 73, b: 210, a: 235 };
const INVALID_COLOR: Color = { r: 255, g: 70, b: 70, a: 235 };

function blendPixel(buffer: PixelBuffer, x: number, y: number, color: Color, opacity = 1): void {
  if (buffer.contains(x, y)) blendInto(buffer.data, buffer.index(x, y), color, { opacity });
}

function textSize(value: string, scale: number): { width: number; height: number } {
  return { width: Math.max(0, value.length * 4 - 1) * scale, height: 5 * scale };
}

function drawText(
  buffer: PixelBuffer,
  value: string,
  centerX: number,
  centerY: number,
  scale: number,
): void {
  const size = textSize(value, scale);
  const left = Math.round(centerX - size.width / 2);
  const top = Math.round(centerY - size.height / 2);
  for (let charIndex = 0; charIndex < value.length; charIndex++) {
    const glyph = DIGITS[value[charIndex]];
    if (!glyph) continue;
    const originX = left + charIndex * 4 * scale;
    for (let row = 0; row < glyph.length; row++) {
      for (let column = 0; column < glyph[row].length; column++) {
        if (glyph[row][column] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const x = originX + column * scale + sx;
            const y = top + row * scale + sy;
            blendPixel(buffer, x + 1, y + 1, LABEL_SHADOW);
            blendPixel(buffer, x, y, LABEL_COLOR);
          }
        }
      }
    }
  }
}

function drawBorder(
  buffer: PixelBuffer,
  left: number,
  top: number,
  width: number,
  height: number,
  color: Color,
): void {
  for (let x = Math.max(0, left); x < Math.min(buffer.width, left + width); x++) {
    blendPixel(buffer, x, top, color);
    blendPixel(buffer, x, top + height - 1, color);
  }
  for (let y = Math.max(0, top); y < Math.min(buffer.height, top + height); y++) {
    blendPixel(buffer, left, y, color);
    blendPixel(buffer, left + width - 1, y, color);
  }
}

function overlayDebug(
  image: PixelBuffer,
  tilemap: TilemapLayer,
  crop: { x: number; y: number; w: number; h: number },
  scale: number,
  debug: TilemapDebugOptions,
  availableTiles: number,
): void {
  const cellWidth = tilemap.tileWidth * scale;
  const cellHeight = tilemap.tileHeight * scale;
  if (debug.grid) {
    for (let x = 0; x <= crop.w; x++) {
      const px = Math.min(image.width - 1, x * cellWidth);
      for (let y = 0; y < image.height; y++) blendPixel(image, px, y, GRID_COLOR);
    }
    for (let y = 0; y <= crop.h; y++) {
      const py = Math.min(image.height - 1, y * cellHeight);
      for (let x = 0; x < image.width; x++) blendPixel(image, x, py, GRID_COLOR);
    }
  }

  if (debug.indices) {
    const fontScale = cellWidth >= 40 && cellHeight >= 30 ? 2 : 1;
    for (let y = 0; y < crop.h; y++) {
      for (let x = 0; x < crop.w; x++) {
        const tile = tilemap.data[(crop.y + y) * tilemap.width + crop.x + x] ?? -1;
        drawText(
          image,
          String(tile),
          x * cellWidth + cellWidth / 2,
          y * cellHeight + cellHeight / 2,
          fontScale,
        );
      }
    }
  }

  if (debug.showInvalid !== false) {
    for (let y = 0; y < crop.h; y++) {
      for (let x = 0; x < crop.w; x++) {
        const tile = tilemap.data[(crop.y + y) * tilemap.width + crop.x + x] ?? -1;
        if (tile >= 0 && tile < availableTiles) continue;
        if (tile === -1) continue;
        drawBorder(
          image,
          x * cellWidth + 1,
          y * cellHeight + 1,
          Math.max(1, cellWidth - 2),
          Math.max(1, cellHeight - 2),
          INVALID_COLOR,
        );
      }
    }
  }

  for (const cell of debug.highlightCells ?? []) {
    if (
      cell.x < crop.x ||
      cell.y < crop.y ||
      cell.x >= crop.x + crop.w ||
      cell.y >= crop.y + crop.h
    ) {
      continue;
    }
    const x = (cell.x - crop.x) * cellWidth;
    const y = (cell.y - crop.y) * cellHeight;
    drawBorder(image, x + 1, y + 1, Math.max(1, cellWidth - 2), Math.max(1, cellHeight - 2), HIGHLIGHT_COLOR);
  }

  if (debug.highlightRect) {
    const rect = clipRect(debug.highlightRect, tilemap.width, tilemap.height);
    const x = (rect.x - crop.x) * cellWidth;
    const y = (rect.y - crop.y) * cellHeight;
    drawBorder(image, x, y, rect.w * cellWidth, rect.h * cellHeight, HIGHLIGHT_COLOR);
  }
}

/** Render a tilemap directly, with an optional index/grid/changed-cell debug overlay. */
export function renderTilemapPreview(
  sprite: Sprite,
  tilemap: TilemapLayer,
  options: TilemapPreviewOptions = {},
): TilemapPreviewResult {
  const tileset = sprite.tileset;
  if (!tileset) throw new Error('This document has no tileset. Run `create_tileset` first.');
  const maxOutputPixels = options.maxOutputPixels ?? 16_777_216;
  if (
    options.underlay &&
    (options.underlay.tileWidth !== tilemap.tileWidth || options.underlay.tileHeight !== tilemap.tileHeight)
  ) {
    throw new Error('Tilemap preview underlay must use the same cell size as the active map.');
  }
  if (options.scale !== undefined && (!Number.isInteger(options.scale) || options.scale < 1)) {
    throw new Error(`Tilemap preview scale must be a positive integer, got ${options.scale}.`);
  }
  if (options.replaceEmpty !== undefined) {
    const available = tileCount(tileset);
    if (options.replaceEmpty < -1 || options.replaceEmpty >= available) {
      throw new Error(`replaceEmpty ${options.replaceEmpty} is outside the ${available}-tile tileset.`);
    }
  }
  const sourceWidth = tilemap.width * tilemap.tileWidth;
  const sourceHeight = tilemap.height * tilemap.tileHeight;
  const requested = options.rect
    ? clipRect(options.rect, tilemap.width, tilemap.height)
    : { x: 0, y: 0, w: tilemap.width, h: tilemap.height };
  if (requested.w <= 0 || requested.h <= 0) {
    throw new Error('The requested tilemap rect is empty after clipping.');
  }
  const cropX = requested.x * tilemap.tileWidth;
  const cropY = requested.y * tilemap.tileHeight;
  const cropWidth = requested.w * tilemap.tileWidth;
  const cropHeight = requested.h * tilemap.tileHeight;
  if (cropWidth * cropHeight > maxOutputPixels) {
    throw new Error(
      `Tilemap crop would be ${cropWidth}x${cropHeight} (${cropWidth * cropHeight} pixels), above the ${maxOutputPixels}-pixel safety limit.`,
    );
  }

  const background = options.background === undefined && options.debug
    ? { r: 25, g: 29, b: 38, a: 255 }
    : options.background;
  const renderOptions = {
    blend: 'over' as const,
    opacity: options.opacity ?? 1,
    replaceEmpty: options.replaceEmpty ?? null,
    offsetX: -cropX,
    offsetY: -cropY,
  };
  const map = PixelBuffer.empty(cropWidth, cropHeight);
  if (options.underlay) {
    blitTilemap(map, tileset, options.underlay, {
      ...renderOptions,
      blend: 'copy',
      opacity: 1,
      replaceEmpty: null,
    });
  }
  blitTilemap(map, tileset, tilemap, renderOptions);
  const rendered = background ? PixelBuffer.filled(cropWidth, cropHeight, background) : map;
  if (background) {
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const source = map.getColor(x, y);
        if (source.a > 0) blendInto(rendered.data, rendered.index(x, y), source, { blend: 'normal' });
      }
    }
  }
  const cropped = rendered;
  const longest = Math.max(cropped.width, cropped.height);
  const factor = options.scale ?? Math.max(1, Math.min(16, Math.floor(256 / longest) || 1));
  const outputWidth = cropped.width * factor;
  const outputHeight = cropped.height * factor;
  if (outputWidth * outputHeight > maxOutputPixels) {
    throw new Error(
      `Preview would be ${outputWidth}x${outputHeight} (${outputWidth * outputHeight} pixels), above the ${maxOutputPixels}-pixel safety limit. Reduce scale or crop with \`rect\`.`,
    );
  }
  const image = factor > 1 ? scaleNearest(cropped, factor) : cropped;
  const structure = analyzeTilemapQuality(tilemap, tileset);
  if (options.debug) {
    overlayDebug(image, tilemap, requested, factor, options.debug, structure.tileCount);
  }

  return {
    image,
    structure,
    meta: {
      mode: 'tilemap',
      tilemap: tilemap.id,
      tilemapName: tilemap.name,
      underlay: options.underlay ? { id: options.underlay.id, name: options.underlay.name } : null,
      sourceWidth,
      sourceHeight,
      rect: requested,
      scale: factor,
      imageWidth: image.width,
      imageHeight: image.height,
      debug: options.debug ?? null,
      structure: {
        emptyRatio: structure.emptyRatio,
        invalid: structure.invalid,
        variants: structure.variants.length,
        dominantVariant: structure.dominantVariant,
        sameTileRatio: structure.repetition.sameTileRatio,
        terrainComponents: structure.terrain.components,
      },
    },
  };
}
