import { PixelBuffer } from './buffer.js';
import { compositeFrame, drawFacingMarker, normalizeFacing } from './render.js';
import { parseColor } from './color.js';
import { scaleNearest } from './transform.js';
import type { Sprite } from './document.js';
import type { Color, ColorInput } from './types.js';

/**
 * Spritesheet packing and engine-ready metadata.
 *
 * The Aseprite JSON shape is the de-facto interchange format for game engines, so that
 * is what we emit. Getting this right is what makes the tool useful *after* the art is
 * made, which is most of the value.
 */

export interface AtlasOptions {
  /** `horizontal` = one row, `vertical` = one column, `grid` = wrapped rows. Defaults to `horizontal`. */
  layout?: 'horizontal' | 'vertical' | 'grid';
  /** Columns for `grid` layout. Defaults to a near-square arrangement. */
  columns?: number;
  /** Transparent gap in pixels between frames. Defaults to 0. */
  padding?: number;
  /** Transparent border around the whole sheet. Defaults to 0. */
  margin?: number;
  /**
   * Which way each frame faces, in timeline order.
   *
   * **Carried through to the frame metadata, never drawn onto the sheet.** The exported PNG
   * is the artwork; an arrow baked into it would be a 5x5 grey square in the character's
   * face. The label travels beside the pixels as `AtlasFrame.facing` and reaches the engine
   * through `meta.json`, and `renderDirectionSheet` is where the arrow becomes pixels — as a
   * preview, deliberately not as an export.
   */
  facings?: readonly (string | null)[];
}

export interface AtlasFrame {
  index: number;
  frameId: string;
  /** Position in the sheet. */
  x: number;
  y: number;
  w: number;
  h: number;
  durationMs: number;
  /**
   * Canonical facing label (`'N'` … `'NW'`, or `'none'`), or `null` when the caller supplied
   * none. Absent from the packed image by construction; see `AtlasOptions.facings`.
   */
  facing?: string | null;
  /** Animation names that show this frame, in document order. */
  animations?: readonly string[];
}

export interface Atlas {
  image: PixelBuffer;
  frames: AtlasFrame[];
  width: number;
  height: number;
  columns: number;
  rows: number;
  /** Frame index ranges for each animation tag. */
  tags: { name: string; from: number; to: number; direction: string }[];
}

export function buildSpritesheet(sprite: Sprite, opts: AtlasOptions = {}): Atlas {
  const count = sprite.frames.length;
  const padding = Math.max(0, opts.padding ?? 0);
  const margin = Math.max(0, opts.margin ?? 0);
  const layout = opts.layout ?? 'horizontal';

  let columns: number;
  if (layout === 'horizontal') columns = count;
  else if (layout === 'vertical') columns = 1;
  else columns = Math.max(1, Math.min(count, opts.columns ?? Math.ceil(Math.sqrt(count))));
  const rows = Math.ceil(count / columns);

  const cellW = sprite.width;
  const cellH = sprite.height;
  const sheetW = margin * 2 + columns * cellW + Math.max(0, columns - 1) * padding;
  const sheetH = margin * 2 + rows * cellH + Math.max(0, rows - 1) * padding;

  const image = new PixelBuffer(sheetW, sheetH);
  const frames: AtlasFrame[] = [];

  // One pass over the tags so every frame knows which animations show it, which is what
  // makes `frames.directions[].animations` in `meta.json` derivable rather than guessed.
  const owners: string[][] = sprite.frames.map(() => []);
  for (const tag of sprite.tags) {
    const lo = Math.min(tag.from, tag.to);
    const hi = Math.max(tag.from, tag.to);
    for (let i = lo; i <= hi; i++) {
      if (i >= 0 && i < owners.length && !owners[i].includes(tag.name)) owners[i].push(tag.name);
    }
  }

  sprite.frames.forEach((frame, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const x = margin + col * (cellW + padding);
    const y = margin + row * (cellH + padding);
    const rendered = compositeFrame(sprite, frame.id);
    image.blit(rendered, x, y);
    const label = opts.facings?.[index];
    frames.push({
      index,
      frameId: frame.id,
      x,
      y,
      w: cellW,
      h: cellH,
      durationMs: frame.durationMs,
      ...(opts.facings ? { facing: label === null || label === undefined ? 'none' : normalizeFacing(label) } : {}),
      ...(owners[index].length > 0 ? { animations: owners[index] } : {}),
    });
  });

  return {
    image,
    frames,
    width: sheetW,
    height: sheetH,
    columns,
    rows,
    tags: sprite.tags.map((t) => ({
      name: t.name,
      from: t.from,
      to: t.to,
      direction: t.direction,
    })),
  };
}

/**
 * Scale a packed atlas by an integer factor.
 *
 * Scaling the *atlas* rather than just its image is what keeps the exported JSON
 * honest: frame rects, sheet size and the image all grow together, so an engine
 * slicing the sheet reads the same geometry the PNG actually has.
 */
export function scaleAtlas(atlas: Atlas, factor: number): Atlas {
  if (factor === 1) return atlas;
  if (!Number.isInteger(factor) || factor < 1) {
    throw new RangeError(`scaleAtlas factor must be a positive integer, got ${factor}`);
  }
  return {
    ...atlas,
    image: scaleNearest(atlas.image, factor),
    width: atlas.width * factor,
    height: atlas.height * factor,
    frames: atlas.frames.map((frame) => ({
      ...frame,
      x: frame.x * factor,
      y: frame.y * factor,
      w: frame.w * factor,
      h: frame.h * factor,
    })),
  };
}

/**
 * Aseprite-compatible spritesheet JSON.
 * `imageFileName` is what the engine will look for next to the JSON.
 */
export function toAsepriteJson(
  sprite: Sprite,
  atlas: Atlas,
  imageFileName: string,
): Record<string, unknown> {
  const frames: Record<string, unknown> = {};
  for (const frame of atlas.frames) {
    frames[`${sprite.name} ${frame.index}.png`] = {
      frame: { x: frame.x, y: frame.y, w: frame.w, h: frame.h },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: frame.w, h: frame.h },
      sourceSize: { w: sprite.width, h: sprite.height },
      duration: frame.durationMs,
      // Two extra keys beside Aseprite's own shape. Aseprite's loader ignores keys it does
      // not know, and the alternative — a `meta.json` nobody opens — is worse. Omitted
      // entirely when the atlas carries no facings, so an atlas built without the option is
      // byte-identical to what this emitted before.
      ...(frame.facing ? { facing: frame.facing } : {}),
      ...(frame.animations && frame.animations.length > 0 ? { animations: [...frame.animations] } : {}),
    };
  }

  return {
    frames,
    meta: {
      app: 'pixel-art',
      version: '1.0',
      image: imageFileName,
      format: 'RGBA8888',
      size: { w: atlas.width, h: atlas.height },
      scale: '1',
      frameTags: atlas.tags.map((tag) => ({
        name: tag.name,
        from: tag.from,
        to: tag.to,
        direction: tag.direction,
      })),
      ...(sprite.rig
        ? {
            rig: {
              restFrameId: sprite.rig.restFrameId,
              parts: sprite.rig.parts.map((part) => ({
                id: part.id,
                name: part.name,
                parentId: part.parentId,
                layerIds: part.layerIds,
                pivot: part.pivot,
              })),
              anchors: sprite.rig.anchors,
              hitboxes: sprite.rig.hitboxes,
              poses: sprite.rig.poses,
              tweens: sprite.rig.tweens,
            },
          }
        : {}),
      layers: sprite.layers.map((layer) => ({
        name: layer.name,
        opacity: Math.round(layer.opacity * 255),
        blendMode: layer.blendMode,
      })),
    },
  };
}

/** A compact, engine-agnostic description of the sheet plus its animation ranges. */
export function toGenericAtlasJson(sprite: Sprite, atlas: Atlas): Record<string, unknown> {
  return {
    sprite: sprite.name,
    size: { w: atlas.width, h: atlas.height },
    frameSize: { w: sprite.width, h: sprite.height },
    columns: atlas.columns,
    rows: atlas.rows,
    frames: atlas.frames.map((f) => ({
      index: f.index,
      x: f.x,
      y: f.y,
      durationMs: f.durationMs,
      ...(f.facing ? { facing: f.facing } : {}),
      ...(f.animations && f.animations.length > 0 ? { animations: [...f.animations] } : {}),
    })),
    animations: atlas.tags,
    rig: sprite.rig
      ? {
          restFrameId: sprite.rig.restFrameId,
          parts: sprite.rig.parts,
          poses: sprite.rig.poses,
          tweens: sprite.rig.tweens,
          anchors: sprite.rig.anchors,
          hitboxes: sprite.rig.hitboxes,
        }
      : null,
    palette: sprite.palette.colors.map((c) => ({
      r: c.r,
      g: c.g,
      b: c.b,
      a: c.a,
    })),
  };
}

/** Sheet plus the frame-index ranges for one animation, ready for a texture-atlas loader. */
export interface AnimationSlice {
  name: string;
  direction: string;
  repeat: number;
  frames: { index: number; x: number; y: number; w: number; h: number; durationMs: number }[];
}

export function sliceAnimations(sprite: Sprite, atlas: Atlas): AnimationSlice[] {
  return sprite.tags.map((tag) => ({
    name: tag.name,
    direction: tag.direction,
    repeat: tag.repeat,
    frames: atlas.frames.filter((f) => f.index >= tag.from && f.index <= tag.to),
  }));
}

/** Render a single frame on a solid backdrop — for thumbnails and previews. */
export function renderThumbnail(
  sprite: Sprite,
  frameIndex: number,
  background: ColorInput | null = null,
): PixelBuffer {
  const frame = sprite.frames[frameIndex] ?? sprite.frames[0];
  return compositeFrame(sprite, frame.id, { background });
}

/* ------------------------------------------------------------------ *
 * Direction-aware preview
 * ------------------------------------------------------------------ */

/** One cell of a {@link DirectionSheet}, and the answer to "which way is this frame looking". */
export interface DirectionSheetCell {
  /** Timeline frame this cell holds. */
  readonly index: number;
  /** Canonical label (`'N'`, `'SE'`, `'none'`) or `null` when the caller gave no facing. */
  readonly facing: string | null;
  /** Animation names that show this frame, in document order. */
  readonly animations: readonly string[];
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface DirectionSheet {
  readonly image: PixelBuffer;
  readonly cells: readonly DirectionSheetCell[];
  /** Cell size in pixels; cells are `w` wide and `h + LABEL_STRIP` tall including the marker strip. */
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly columns: number;
  readonly rows: number;
}

/** Pixels of marker strip above each cell. One 5x5 arrow plus a 1px gap, nothing else. */
export const DIRECTION_LABEL_STRIP = 6;

export interface DirectionSheetOptions {
  /** Which way each frame faces, in timeline order. A `null` entry draws no arrow. */
  readonly facings?: readonly (string | null)[];
  /** Backdrop behind every frame. Defaults to null (transparent). */
  readonly background?: ColorInput | null;
  /** Columns. Defaults to a near-square arrangement, same rule `grid` layout uses. */
  readonly columns?: number;
  /** Gap between cells. Defaults to 1. */
  readonly padding?: number;
  /** Border around the whole sheet. Defaults to 0. */
  readonly margin?: number;
  /** Arrow colour. Defaults to a mid grey. */
  readonly markerColor?: ColorInput;
  /**
   * Draw a 1px separator line between cells.
   *
   * On by default. Without it a grid of same-coloured frames reads as one image, and the
   * whole point of a direction sheet is telling cell 4 from cell 5 at a glance.
   */
  readonly separators?: boolean;
}

/**
 * A contact sheet where each frame carries a facing arrow.
 *
 * The answer to "reviewing a walk cycle, which of these is south and which is north". Two
 * things make it work at a glance: the arrow itself, drawn by `drawFacingMarker` in the
 * top-left of every cell, and the cell order, which is the caller's timeline order left
 * alone — reordering cells by facing would be prettier and would quietly hide the very
 * mistake (a north-facing frame sitting in the middle of the south walk) the sheet exists to
 * catch.
 *
 * Deterministic like everything else here: no clock, no random, no trigonometry. Same
 * document and same options give the same bytes.
 *
 * Only 5x5 of every cell is overdrawn with the marker, so this is a **preview**, not an
 * export. The exported sheet comes from `buildSpritesheet`, which this deliberately does not
 * touch — a sprite with a 32px frame keeps its top-left 5x5 intact here and in the PNG that
 * ships.
 */
export function renderDirectionSheet(sprite: Sprite, opts: DirectionSheetOptions = {}): DirectionSheet {
  const count = sprite.frames.length;
  const padding = Math.max(0, opts.padding ?? 1);
  const margin = Math.max(0, opts.margin ?? 0);
  const strip = DIRECTION_LABEL_STRIP;
  const cellW = sprite.width;
  const cellH = sprite.height + strip;
  const columns = Math.max(1, Math.min(count, opts.columns ?? Math.ceil(Math.sqrt(count))));
  const rows = Math.ceil(count / columns);
  const sheetW = margin * 2 + columns * cellW + Math.max(0, columns - 1) * padding;
  const sheetH = margin * 2 + rows * cellH + Math.max(0, rows - 1) * padding;
  const image = new PixelBuffer(sheetW, sheetH);
  const cells: DirectionSheetCell[] = [];
  const separator = opts.separators === false ? null : parseColor('#4a4a68');

  // Animation membership is the same inversion `asset/build.ts` performs, walked once here
  // so a cell can name its animations without re-expanding each tag.
  const owners: string[][] = sprite.frames.map(() => []);
  for (const tag of sprite.tags) {
    const lo = Math.min(tag.from, tag.to);
    const hi = Math.max(tag.from, tag.to);
    const order: number[] = [];
    if (tag.direction === 'reverse') {
      for (let i = hi; i >= lo; i--) order.push(i);
    } else {
      for (let i = lo; i <= hi; i++) order.push(i);
      if (tag.direction === 'pingpong') {
        for (let i = hi - 1; i > lo; i--) order.push(i);
      }
    }
    for (const index of order) {
      if (index >= 0 && index < count && !owners[index].includes(tag.name)) owners[index].push(tag.name);
    }
  }

  sprite.frames.forEach((frame, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = margin + column * (cellW + padding);
    const y = margin + row * (cellH + padding);
    const label = opts.facings?.[index] ?? null;
    const canonical = label === null ? null : normalizeFacing(label);
    image.blit(compositeFrame(sprite, frame.id, { background: opts.background ?? null }), x, y + strip);
    // Drawn after the frame composite and before the separators, so a separator never lands
    // on top of an arrowhead and changes which way it appears to point.
    if (canonical !== null) drawFacingMarker(image, canonical, x, y, opts.markerColor ?? '#808080');
    cells.push({ index, facing: canonical, animations: owners[index], x, y, w: cellW, h: cellH });
  });

  if (separator) drawSeparators(image, margin, columns, rows, cellW, cellH, padding, separator);

  return { image, cells, cellWidth: cellW, cellHeight: cellH, columns, rows };
}

/**
 * 1px rules in the gaps between cells, drawn once for the whole sheet.
 *
 * **After every cell rather than per cell**, because a per-cell outline would draw the top
 * and left edges of cell N over the marker strip and the bottom-right corner of cell N-1,
 * which at a 1px padding means the arrow of one cell bleeds into its neighbour. The gaps are
 * `padding` wide, so a single rule sits in the middle of each.
 */
function drawSeparators(
  image: PixelBuffer,
  margin: number,
  columns: number,
  rows: number,
  cellW: number,
  cellH: number,
  padding: number,
  color: Color,
): void {
  if (padding < 1) return;
  const mid = Math.floor(padding / 2);
  for (let column = 1; column < columns; column++) {
    const x = margin + column * (cellW + padding) + mid;
    for (let y = margin; y < image.height; y++) plot(image, x, y, color);
  }
  for (let row = 1; row < rows; row++) {
    const y = margin + row * (cellH + padding) + mid;
    for (let x = margin; x < image.width; x++) plot(image, x, y, color);
  }
}

function plot(target: PixelBuffer, x: number, y: number, color: Color): void {
  if (!target.contains(x, y)) return;
  const i = target.index(x, y);
  target.data[i] = color.r;
  target.data[i + 1] = color.g;
  target.data[i + 2] = color.b;
  target.data[i + 3] = color.a;
}
