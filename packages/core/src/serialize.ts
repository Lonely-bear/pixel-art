import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { PixelBuffer } from './buffer.js';
import type { AnimationTag, Layer, MapObject, MapPropertyValue, Sprite, SpriteRig, TilemapLayer } from './document.js';
import { createPalette, type Palette } from './palette.js';
import { decodePNG, encodePNG } from './png.js';

/**
 * The `.pixel` container.
 *
 * A plain zip of JSON plus per-cel PNGs. Chosen over a bespoke binary format on purpose:
 * it is inspectable with any zip tool, diffs sanely in git, survives partial corruption
 * (one bad cel does not take the file with it), and is trivial for a non-JavaScript tool
 * to read. Nothing here is clever, and that is the point.
 *
 * Layout:
 *   manifest.json          structure, palette, tags
 *   cels/<n>_<layerId>.png one PNG per non-empty cel
 *   tileset.png            optional
 *   tilemaps/<id>.json     optional, flat tile-index arrays
 */

export const PIXEL_FORMAT = 'pixel-art/sprite';
export const PIXEL_FORMAT_VERSION = 2;

export interface CelIndexEntry {
  layerId: string;
  frameId: string;
  path: string;
}

export interface SpriteManifest {
  format: string;
  version: number;
  sprite: {
    id: string;
    name: string;
    width: number;
    height: number;
    layers: Layer[];
    frames: { id: string; durationMs: number }[];
    tags: AnimationTag[];
    rig?: SpriteRig;
    palette: Palette;
    paletteLocked?: boolean;
  };
  cels: CelIndexEntry[];
  tileset?: {
    id: string;
    name: string;
    tileWidth: number;
    tileHeight: number;
    columns: number;
    image: string;
    tileProperties?: Record<string, Record<string, MapPropertyValue>>;
  };
  tilemaps?: {
    id: string;
    name: string;
    width: number;
    height: number;
    tileWidth: number;
    tileHeight: number;
    data: string;
  }[];
  mapObjects?: MapObject[];
}

export function serializeSprite(sprite: Sprite): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const cels: CelIndexEntry[] = [];

  sprite.frames.forEach((frame, frameIndex) => {
    for (const [layerId, buffer] of frame.cels) {
      // Empty cels carry no information; a missing entry already means "nothing here".
      if (buffer.isEmpty()) continue;
      const path = `cels/${frameIndex}_${layerId}.png`;
      files[path] = encodePNG(buffer);
      cels.push({ layerId, frameId: frame.id, path });
    }
  });

  const manifest: SpriteManifest = {
    format: PIXEL_FORMAT,
    version: sprite.rig ? PIXEL_FORMAT_VERSION : 1,
    sprite: {
      id: sprite.id,
      name: sprite.name,
      width: sprite.width,
      height: sprite.height,
      layers: sprite.layers,
      frames: sprite.frames.map((f) => ({ id: f.id, durationMs: f.durationMs })),
      tags: sprite.tags,
      ...(sprite.rig ? { rig: sprite.rig } : {}),
      palette: sprite.palette,
      paletteLocked: sprite.paletteLocked,
    },
    cels,
    ...(sprite.mapObjects?.length
      ? {
          mapObjects: sprite.mapObjects.map((object) => ({
            ...object,
            properties: { ...object.properties },
          })),
        }
      : {}),
  };

  if (sprite.tileset) {
    files['tileset.png'] = encodePNG(sprite.tileset.image);
    manifest.tileset = {
      id: sprite.tileset.id,
      name: sprite.tileset.name,
      tileWidth: sprite.tileset.tileWidth,
      tileHeight: sprite.tileset.tileHeight,
      columns: sprite.tileset.columns,
      image: 'tileset.png',
      ...(sprite.tileset.tileProperties
        ? { tileProperties: { ...sprite.tileset.tileProperties } }
        : {}),
    };
  }

  if (sprite.tilemaps?.length) {
    manifest.tilemaps = sprite.tilemaps.map((tilemap) => {
      const path = `tilemaps/${tilemap.id}.json`;
      files[path] = strToU8(JSON.stringify(Array.from(tilemap.data)));
      return {
        id: tilemap.id,
        name: tilemap.name,
        width: tilemap.width,
        height: tilemap.height,
        tileWidth: tilemap.tileWidth,
        tileHeight: tilemap.tileHeight,
        data: path,
      };
    });
  }

  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  return zipSync(files, { level: 6 });
}

export function deserializeSprite(bytes: Uint8Array): Sprite {
  const entries = unzipSync(bytes);
  const manifestBytes = entries['manifest.json'];
  if (!manifestBytes) {
    throw new Error('Not a .pixel file: manifest.json is missing');
  }

  const manifest = JSON.parse(strFromU8(manifestBytes)) as SpriteManifest;
  if (manifest.format !== PIXEL_FORMAT) {
    throw new Error(`Unsupported format: ${manifest.format}`);
  }
  if (!Number.isInteger(manifest.version) || manifest.version < 1) {
    throw new Error(`Unsupported .pixel version: ${manifest.version}`);
  }
  if (manifest.version > PIXEL_FORMAT_VERSION) {
    throw new Error(
      `File was written by a newer version (${manifest.version} > ${PIXEL_FORMAT_VERSION})`,
    );
  }

  const source = manifest.sprite;
  const frames = source.frames.map((f) => ({
    id: f.id,
    durationMs: f.durationMs,
    cels: new Map<string, PixelBuffer>(),
  }));
  const frameIndexById = new Map(source.frames.map((f, i) => [f.id, i]));

  for (const entry of manifest.cels) {
    const index = frameIndexById.get(entry.frameId);
    if (index === undefined) continue;
    const png = entries[entry.path];
    if (!png) continue;
    frames[index].cels.set(entry.layerId, decodePNG(png));
  }

  const sprite: Sprite = {
    id: source.id,
    name: source.name,
    width: source.width,
    height: source.height,
    layers: source.layers,
    frames,
    tags: source.tags ?? [],
    ...(source.rig ? { rig: source.rig } : {}),
    palette: normalizePalette(source.palette),
    paletteLocked: source.paletteLocked ?? false,
    ...(manifest.mapObjects?.length
      ? {
          mapObjects: manifest.mapObjects.map((object) => ({
            ...object,
            rotation: object.rotation ?? 0,
            visible: object.visible ?? true,
            properties: { ...(object.properties ?? {}) },
          })),
        }
      : {}),
  };

  if (manifest.tileset) {
    const png = entries[manifest.tileset.image];
    if (png) {
      sprite.tileset = {
        id: manifest.tileset.id,
        name: manifest.tileset.name,
        tileWidth: manifest.tileset.tileWidth,
        tileHeight: manifest.tileset.tileHeight,
        columns: manifest.tileset.columns,
        image: decodePNG(png),
        ...(manifest.tileset.tileProperties
          ? { tileProperties: { ...manifest.tileset.tileProperties } }
          : {}),
      };
    }
  }

  if (manifest.tilemaps?.length) {
    sprite.tilemaps = manifest.tilemaps
      .map((meta) => {
        const raw = entries[meta.data];
        if (!raw) return null;
        const values = JSON.parse(strFromU8(raw)) as number[];
        if (!Number.isInteger(meta.width) || meta.width <= 0 || !Number.isInteger(meta.height) || meta.height <= 0) {
          throw new Error(`Tilemap "${meta.name}" has invalid dimensions ${meta.width}x${meta.height}.`);
        }
        if (values.length !== meta.width * meta.height) {
          throw new Error(
            `Tilemap "${meta.name}" stores ${values.length} cells; expected ${meta.width * meta.height}.`,
          );
        }
        const tilemap: TilemapLayer = {
          id: meta.id,
          name: meta.name,
          width: meta.width,
          height: meta.height,
          tileWidth: meta.tileWidth,
          tileHeight: meta.tileHeight,
          data: Int32Array.from(values),
        };
        return tilemap;
      })
      .filter((t): t is TilemapLayer => t !== null);
  }

  validateStoredRig(sprite);
  return sprite;
}

function validateStoredRig(sprite: Sprite): void {
  const rig = sprite.rig;
  if (!rig) return;
  if (!sprite.frames.some((frame) => frame.id === rig.restFrameId)) throw new Error(`Rig rest frame not found: ${rig.restFrameId}`);
  const layerIds = new Set(sprite.layers.map((layer) => layer.id));
  const partIds = new Set<string>();
  const partNames = new Set<string>();
  for (const part of rig.parts) {
    if (partIds.has(part.id) || partNames.has(part.name)) throw new Error(`Invalid rig part identity: ${part.name}`);
    partIds.add(part.id);
    partNames.add(part.name);
    for (const layerId of part.layerIds) {
      if (!layerIds.has(layerId)) throw new Error(`Rig part ${part.name} references missing layer ${layerId}.`);
    }
  }
  for (const part of rig.parts) {
    if (part.parentId && !partIds.has(part.parentId)) throw new Error(`Rig part ${part.name} has missing parent ${part.parentId}.`);
  }
  const poseIds = new Set<string>();
  for (const pose of rig.poses) {
    if (poseIds.has(pose.id)) throw new Error(`Duplicate rig pose id: ${pose.id}`);
    poseIds.add(pose.id);
    for (const partId of Object.keys(pose.transforms)) {
      if (!partIds.has(partId)) throw new Error(`Pose ${pose.name} references missing part ${partId}.`);
    }
  }
  for (const tween of rig.tweens) {
    if (!poseIds.has(tween.fromPoseId) || !poseIds.has(tween.toPoseId)) {
      throw new Error(`Tween ${tween.name} references a missing pose.`);
    }
  }
}

function normalizePalette(palette: Palette | undefined): Palette {
  if (!palette || !palette.colors?.length) return createPalette('Untitled', ['#000000']);
  return {
    id: palette.id,
    name: palette.name,
    colors: palette.colors.map((c) => ({
      r: c.r,
      g: c.g,
      b: c.b,
      a: c.a === undefined ? 255 : c.a,
    })),
    ...(palette.roles ? { roles: { ...palette.roles } } : {}),
  };
}
