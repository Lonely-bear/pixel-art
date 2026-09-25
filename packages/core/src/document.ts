import { PixelBuffer } from './buffer.js';
import { makeId } from './ids.js';
import { parseColor } from './color.js';
import { createDefaultPalette, nearestColor, type Palette } from './palette.js';
import type {
  BlendMode,
  ColorInput,
  FrameId,
  LayerId,
  SpriteId,
  TagDirection,
  TagId,
  TilemapId,
  TilesetId,
} from './types.js';

export interface Layer {
  id: LayerId;
  name: string;
  visible: boolean;
  locked: boolean;
  /** 0-1. */
  opacity: number;
  blendMode: BlendMode;
}

export interface Frame {
  id: FrameId;
  /** How long this frame is shown, in milliseconds. */
  durationMs: number;
  /**
   * Sparse map of layer -> pixels. A missing entry means "this layer contributes
   * nothing on this frame", which is not the same as an all-transparent buffer but
   * composites identically.
   */
  cels: Map<LayerId, PixelBuffer>;
}

export interface AnimationTag {
  id: TagId;
  name: string;
  /** Inclusive frame indices. */
  from: number;
  to: number;
  direction: TagDirection;
  /** 0 means loop forever. */
  repeat: number;
}

/** JSON-safe value stored in Tiled tile/object custom properties. */
export type MapPropertyValue = string | number | boolean;

export interface Tileset {
  id: TilesetId;
  name: string;
  tileWidth: number;
  tileHeight: number;
  columns: number;
  image: PixelBuffer;
  /** Gameplay metadata keyed by decimal tile index, e.g. walkable or moveSpeed. */
  tileProperties?: Record<string, Record<string, MapPropertyValue>>;
}

export interface TilemapLayer {
  id: TilemapId;
  name: string;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  /** Row-major tile indices, `-1` for an empty cell. */
  data: Int32Array;
}

/**
 * A Tiled-compatible object record, stored independently from visual tile cells.
 *
 * Pixel coordinates keep the object useful for bridges, spawn points, triggers and
 * interactive props even when it is not backed by one tile. `tile` is optional and
 * supplies the tile-object gid on export.
 */
export interface MapObject {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  tile?: number;
  rotation: number;
  visible: boolean;
  properties: Record<string, MapPropertyValue>;
}

export interface Sprite {
  id: SpriteId;
  name: string;
  width: number;
  height: number;
  /** Paint order: index 0 is the bottom-most layer. */
  layers: Layer[];
  frames: Frame[];
  tags: AnimationTag[];
  palette: Palette;
  /**
   * When true, every colour written through a command is snapped to the nearest
   * palette swatch (alpha is preserved). Keeps an agent from drifting off the palette.
   */
  paletteLocked?: boolean;
  tileset?: Tileset;
  tilemaps?: TilemapLayer[];
  /** Non-cell map entities exported as a Tiled object group. */
  mapObjects?: MapObject[];
}

export interface CreateSpriteOptions {
  width: number;
  height: number;
  name?: string;
  palette?: Palette;
  /** Layer names, bottom first. Defaults to a single `"Layer 1"`. */
  layers?: string[];
  /** Number of frames to create. Defaults to 1. */
  frames?: number;
  frameDurationMs?: number;
  /** Fill every frame's bottom layer with this colour. `null`/omitted leaves it transparent. */
  background?: ColorInput | null;
  /** Snap every painted colour to the nearest palette swatch. Defaults to false. */
  paletteLocked?: boolean;
}

export function defaultLayerName(index: number): string {
  return `Layer ${index + 1}`;
}

export function createSprite(opts: CreateSpriteOptions): Sprite {
  const width = Math.max(1, Math.floor(opts.width));
  const height = Math.max(1, Math.floor(opts.height));
  const frameCount = Math.max(1, Math.floor(opts.frames ?? 1));
  const durationMs = Math.max(1, Math.floor(opts.frameDurationMs ?? 100));

  const layerNames = opts.layers?.length ? opts.layers : [defaultLayerName(0)];
  const palette = opts.palette ?? createDefaultPalette();
  const paletteLocked = opts.paletteLocked ?? false;
  const background = opts.background == null
    ? null
    : parseColor(opts.background, palette);
  const lockedBackground = background && paletteLocked
    ? (() => {
        const nearest = nearestColor(palette, background);
        return { ...nearest, a: background.a };
      })()
    : background;
  const layers: Layer[] = layerNames.map((name, i) => ({
    id: makeId('lay'),
    name: name || defaultLayerName(i),
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
  }));

  const frames: Frame[] = [];
  for (let i = 0; i < frameCount; i++) {
    const cels = new Map<LayerId, PixelBuffer>();
    if (lockedBackground != null) {
      const buf = new PixelBuffer(width, height);
      buf.fill(lockedBackground);
      cels.set(layers[0].id, buf);
    }
    frames.push({ id: makeId('frm'), durationMs, cels });
  }

  return {
    id: makeId('spr'),
    name: opts.name ?? 'Untitled',
    width,
    height,
    layers,
    frames,
    tags: [],
    palette,
    paletteLocked,
  };
}

export function findLayerIndex(sprite: Sprite, layerId: LayerId): number {
  return sprite.layers.findIndex((l) => l.id === layerId);
}

export function findFrameIndex(sprite: Sprite, frameId: FrameId): number {
  return sprite.frames.findIndex((f) => f.id === frameId);
}

export function getLayer(sprite: Sprite, layerId: LayerId): Layer {
  const layer = sprite.layers.find((l) => l.id === layerId);
  if (!layer) throw new Error(`Unknown layer: ${layerId}`);
  return layer;
}

export function getFrame(sprite: Sprite, frameId: FrameId): Frame {
  const frame = sprite.frames.find((f) => f.id === frameId);
  if (!frame) throw new Error(`Unknown frame: ${frameId}`);
  return frame;
}

export function getCel(
  sprite: Sprite,
  layerId: LayerId,
  frameId: FrameId,
): PixelBuffer | undefined {
  return getFrame(sprite, frameId).cels.get(layerId);
}

/** Resolve a frame reference that may be an index or an ID. */
export function resolveFrame(sprite: Sprite, ref: number | string): Frame {
  if (typeof ref === 'number') {
    const frame = sprite.frames[ref];
    if (!frame) throw new Error(`Frame index out of range: ${ref}`);
    return frame;
  }
  return getFrame(sprite, ref);
}

/** Resolve a layer reference that may be a name, an ID, or an index. */
export function resolveLayer(sprite: Sprite, ref: string | number): Layer {
  if (typeof ref === 'number') {
    const layer = sprite.layers[ref];
    if (!layer) throw new Error(`Layer index out of range: ${ref}`);
    return layer;
  }
  const byId = sprite.layers.find((l) => l.id === ref);
  if (byId) return byId;
  const byName = sprite.layers.find((l) => l.name === ref);
  if (byName) return byName;
  throw new Error(`Unknown layer: ${ref}`);
}

export function spriteDurationMs(sprite: Sprite): number {
  return sprite.frames.reduce((sum, f) => sum + f.durationMs, 0);
}

/**
 * Shallow structural clone used for undo snapshots.
 *
 * Layers, frames, tags and the palette array get fresh containers and fresh *objects*,
 * so a command can mutate them directly. Pixel buffers are shared by reference — those
 * are the only things a command must copy-on-write (see `Draft`).
 *
 * Cost per undo entry is therefore O(frames x layers) pointers, not O(image bytes).
 */
export function cloneSpriteStructure(sprite: Sprite): Sprite {
  return {
    ...sprite,
    layers: sprite.layers.map((l) => ({ ...l })),
    frames: sprite.frames.map((f) => ({ ...f, cels: new Map(f.cels) })),
    tags: sprite.tags.map((t) => ({ ...t })),
    palette: { ...sprite.palette, colors: sprite.palette.colors.slice() },
    tilemaps: sprite.tilemaps?.map((t) => ({ ...t, data: t.data })),
    tileset: sprite.tileset
      ? {
          ...sprite.tileset,
          image: sprite.tileset.image,
          ...(sprite.tileset.tileProperties
            ? { tileProperties: { ...sprite.tileset.tileProperties } }
            : {}),
        }
      : undefined,
    mapObjects: sprite.mapObjects?.map((object) => ({
      ...object,
      properties: { ...object.properties },
    })),
  };
}

/** Deep clone including pixel data. Use for snapshots that outlive the editor state. */
export function cloneSpriteDeep(sprite: Sprite): Sprite {
  const clone = cloneSpriteStructure(sprite);
  clone.frames = sprite.frames.map((f) => ({
    ...f,
    cels: new Map([...f.cels].map(([layerId, buf]) => [layerId, buf.clone()])),
  }));
  if (sprite.tileset) clone.tileset = { ...sprite.tileset, image: sprite.tileset.image.clone() };
  if (sprite.tilemaps) clone.tilemaps = sprite.tilemaps.map((t) => ({ ...t, data: t.data.slice() }));
  return clone;
}

/** All layers that actually contribute pixels on a frame, bottom first. */
export function frameLayersWithCels(sprite: Sprite, frameId: FrameId): Layer[] {
  const frame = getFrame(sprite, frameId);
  return sprite.layers.filter((l) => frame.cels.has(l.id));
}
