import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { PixelBuffer } from './buffer.js';
import type { AnimationTag, Layer, Sprite, TilemapLayer } from './document.js';
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
export const PIXEL_FORMAT_VERSION = 1;

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
    palette: Palette;
  };
  cels: CelIndexEntry[];
  tileset?: {
    id: string;
    name: string;
    tileWidth: number;
    tileHeight: number;
    columns: number;
    image: string;
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
    version: PIXEL_FORMAT_VERSION,
    sprite: {
      id: sprite.id,
      name: sprite.name,
      width: sprite.width,
      height: sprite.height,
      layers: sprite.layers,
      frames: sprite.frames.map((f) => ({ id: f.id, durationMs: f.durationMs })),
      tags: sprite.tags,
      palette: sprite.palette,
    },
    cels,
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
    palette: normalizePalette(source.palette),
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
      };
    }
  }

  if (manifest.tilemaps?.length) {
    sprite.tilemaps = manifest.tilemaps
      .map((meta) => {
        const raw = entries[meta.data];
        if (!raw) return null;
        const values = JSON.parse(strFromU8(raw)) as number[];
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

  return sprite;
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
  };
}
