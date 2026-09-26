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
 *   manifest.json              structure, palette, tags, and every id in the file
 *   cels/<frame>_<layer>.png   one PNG per non-empty cel, numbered by position
 *   tileset.png                optional
 *   tilemaps/<n>.json          optional, flat tile-index arrays
 *
 * ## Entry names are positions, never ids
 *
 * An earlier layout put the layer id in the cel filename (`cels/0_layer_1j2k3m.png`) and
 * the tilemap id in the tilemap filename. It bought nothing: a cel map is keyed by layer
 * id and holds at most one cel per layer, so the frame index *and* the layer's position
 * in `sprite.layers` are already unique, and the manifest records which id each path
 * belongs to. It cost the one thing this format needs most — a `.pixel` file is the
 * editable source that `finalize_document` writes next to the rendered PNGs, so "the
 * source did not change" has to be a checkable claim and not a hopeful one. Ids come
 * from `makeId`, which mixes the clock with real entropy (see `ids.ts`), so two runs of
 * the same ops produced two archives that differed from the first entry name onwards.
 *
 * `manifest.cels[].path` is the only place a path is written down, and the reader has
 * always gone through the manifest rather than parsing a name. That is what makes this
 * a non-breaking change in both directions: 0.4.1 files keep loading because their
 * manifest still names `cels/0_layer_1j2k3m.png` and the reader looks up exactly that,
 * and a 0.4.1 reader opens a new file for the same reason. The container version is
 * deliberately *not* bumped — entry names were never part of the format contract, and
 * claiming a new version would suggest they were.
 *
 * ## Reproducibility is a property of the whole archive, not just the names
 *
 * fflate stamps every entry with the current time unless told otherwise, so the default
 * `{level: 6}` wrote a different DOS timestamp into every local header and central
 * directory record on every save — the archive was unstable even with a fully
 * deterministic document. {@link ZIP_MTIME} pins it. It is built from the *local*
 * calendar constructor on purpose: fflate reads the fields back with `getFullYear()`,
 * `getMonth()`, `getHours()` and friends, so a local date round-trips to the same DOS
 * words on every machine, whereas an epoch-millis instant would encode that machine's
 * UTC offset and make the bytes depend on the timezone. 1980-01-01 is the oldest date
 * the DOS format can express; fflate rejects anything earlier.
 */

export const PIXEL_FORMAT = 'pixel-art/sprite';
export const PIXEL_FORMAT_VERSION = 2;

/**
 * The modification time stamped into every zip entry, as a local-midnight `Date`.
 *
 * Exported so a test can assert the constant rather than trust the comment above.
 */
export const ZIP_MTIME = new Date(1980, 0, 1);

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
  const numbered = celNumbers(sprite);

  sprite.frames.forEach((frame, frameIndex) => {
    // Walk the numbered layers rather than `frame.cels`, so the number in the path is
    // total by construction — there is no lookup that can miss and no fallback that
    // could write two cels to one name. It also fixes the `cels[]` order to frame then
    // layer position, which used to depend on the order the cels were painted in.
    for (const [layerId, layerNumber] of numbered) {
      const buffer = frame.cels.get(layerId);
      if (!buffer) continue;
      // Empty cels carry no information; a missing entry already means "nothing here".
      if (buffer.isEmpty()) continue;
      const path = `cels/${frameIndex}_${layerNumber}.png`;
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
    manifest.tilemaps = sprite.tilemaps.map((tilemap, index) => {
      // Same rule as the cels: a position in the path, the id in the manifest.
      const path = `tilemaps/${index}.json`;
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
  return zipSync(files, { level: 6, mtime: ZIP_MTIME });
}

/**
 * The number each cel-owning layer carries in its `cels/<frame>_<number>.png` path.
 *
 * Layers in `sprite.layers` order, so the number reads as "the nth layer of the
 * document" and matches the order of `manifest.sprite.layers`. Then anything left —
 * a cel whose layer id is not in `sprite.layers`, which the command bus cannot produce
 * because `remove_layer` purges a layer's cels, but a hand-built `Sprite` can carry —
 * numbered in id order after the real layers. Silently dropping those pixels would be
 * worse than an unnameable path, and sorting them keeps the archive a pure function of
 * the document either way.
 */
function celNumbers(sprite: Sprite): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const [index, layer] of sprite.layers.entries()) {
    if (!numbers.has(layer.id)) numbers.set(layer.id, index);
  }
  const orphans = new Set<string>();
  for (const frame of sprite.frames) {
    for (const layerId of frame.cels.keys()) {
      if (!numbers.has(layerId)) orphans.add(layerId);
    }
  }
  [...orphans].sort().forEach((layerId, index) => numbers.set(layerId, sprite.layers.length + index));
  return numbers;
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
