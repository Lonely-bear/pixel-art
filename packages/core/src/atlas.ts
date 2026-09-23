import { PixelBuffer } from './buffer.js';
import { compositeFrame } from './render.js';
import { scaleNearest } from './transform.js';
import type { Sprite } from './document.js';
import type { ColorInput } from './types.js';

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

  sprite.frames.forEach((frame, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const x = margin + col * (cellW + padding);
    const y = margin + row * (cellH + padding);
    const rendered = compositeFrame(sprite, frame.id);
    image.blit(rendered, x, y);
    frames.push({
      index,
      frameId: frame.id,
      x,
      y,
      w: cellW,
      h: cellH,
      durationMs: frame.durationMs,
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
    frames: atlas.frames.map((f) => ({ index: f.index, x: f.x, y: f.y, durationMs: f.durationMs })),
    animations: atlas.tags,
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
