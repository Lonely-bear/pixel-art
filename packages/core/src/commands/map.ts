import { z } from 'zod';
import { makeId } from '../ids.js';
import { tileCount } from '../tilemap.js';
import type { MapObject, MapPropertyValue, Tileset } from '../document.js';
import { defineCommand } from './types.js';

const propertyValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
const propertiesSchema = z
  .record(z.string(), propertyValueSchema)
  .describe('Tiled custom properties. Values may be strings, finite numbers or booleans.');

type Properties = Record<string, MapPropertyValue>;

/** Zod validates the record; this narrows its v4 inferred union for direct command use. */
function propertyRecord(value: unknown): Properties {
  return value as Properties;
}

const objectRefSchema = z
  .union([z.string(), z.number().int()])
  .describe('Map object id or 0-based index.');

function requireTileset(ctx: { sprite: { tileset?: Tileset } }): Tileset {
  const tileset = ctx.sprite.tileset;
  if (!tileset) throw new Error('This document has no tileset. Run `create_tileset` first.');
  return tileset;
}

function findObject(objects: MapObject[], ref: string | number): MapObject {
  const found = typeof ref === 'number' ? objects[ref] : objects.find((object) => object.id === ref);
  if (!found) {
    const known = objects.map((object, index) => `${index}:${object.name} (${object.id})`).join(', ') || 'none';
    throw new Error(`Unknown map object: ${ref}. Known objects: ${known}`);
  }
  return found;
}

function validateTile(ctx: { sprite: { tileset?: Tileset } }, tile: number): void {
  const tileset = requireTileset(ctx);
  const count = tileCount(tileset);
  if (tile < 0 || tile >= count) {
    throw new Error(`Tile ${tile} is outside the ${count}-tile tileset.`);
  }
}

export const setTilePropertiesCommand = defineCommand({
  name: 'set_tile_properties',
  description:
    'Attach gameplay metadata to one tileset tile, for example `{ walkable: false, moveSpeed: 0.6, kind: "water" }`. Properties merge by default; pass `replace: true` to discard existing keys. These are exported as Tiled tile custom properties and remain independent of the visible tile art.',
  params: z.object({
    tile: z.number().int().min(0).describe('Tile index in the document tileset.'),
    properties: propertiesSchema,
    replace: z.boolean().optional().describe('Replace all existing properties instead of merging. Defaults to false.'),
  }),
  apply(ctx, p) {
    const tileset = requireTileset(ctx);
    validateTile(ctx, p.tile);
    const incoming = propertyRecord(p.properties);
    const before: Properties = tileset.tileProperties?.[String(p.tile)] ?? {};
    const next: Properties = p.replace ? { ...incoming } : { ...before, ...incoming };
    tileset.tileProperties = { ...(tileset.tileProperties ?? {}), [String(p.tile)]: next };
    const changedKeys = [...new Set([...Object.keys(before), ...Object.keys(incoming)])].filter(
      (key) => before[key] !== next[key],
    );
    return {
      tile: p.tile,
      changedKeys,
      properties: { ...next },
      tileCount: tileCount(tileset),
    };
  },
});

export const removeTilePropertiesCommand = defineCommand({
  name: 'remove_tile_properties',
  description: 'Remove selected custom properties from a tile, or all properties when `keys` is omitted.',
  params: z.object({
    tile: z.number().int().min(0),
    keys: z.array(z.string().min(1)).max(256).optional(),
  }),
  apply(ctx, p) {
    const tileset = requireTileset(ctx);
    validateTile(ctx, p.tile);
    const key = String(p.tile);
    const current: Properties = { ...(tileset.tileProperties?.[key] ?? {}) };
    const removed = p.keys ?? Object.keys(current);
    for (const property of removed) delete current[property];
    const all = { ...(tileset.tileProperties ?? {}) };
    if (Object.keys(current).length > 0) all[key] = current;
    else delete all[key];
    tileset.tileProperties = all;
    return { tile: p.tile, removed, properties: { ...current } };
  },
});

export const getTilePropertiesCommand = defineCommand({
  name: 'get_tile_properties',
  description: 'Read gameplay custom properties for one tile, or the complete tile-property table when `tile` is omitted.',
  readOnly: true,
  params: z.object({
    tile: z.number().int().min(0).optional(),
  }),
  apply(ctx, p) {
    const tileset = requireTileset(ctx);
    if (p.tile !== undefined) {
      validateTile(ctx, p.tile);
      return {
        tile: p.tile,
        properties: { ...(tileset.tileProperties?.[String(p.tile)] ?? {}) } as Properties,
      };
    }
    return {
      tileCount: tileCount(tileset),
      properties: Object.fromEntries(
        Object.entries(tileset.tileProperties ?? {}).map(([tile, properties]) => [
          tile,
          { ...(properties as Properties) },
        ]),
      ),
    };
  },
});

export const addMapObjectCommand = defineCommand({
  name: 'add_map_object',
  description:
    'Add a non-cell map entity such as a spawn point, trigger, bridge marker or interactive prop. `x`/`y`/`width`/`height` are canvas pixels. `tile` is optional and makes this a Tiled tile object; otherwise the object is a rectangle/point-like record. Custom `properties` can carry IDs, interaction tags and gameplay values.',
  params: z.object({
    name: z.string().min(1).describe('Human-readable object name.'),
    type: z.string().default('object').describe('Tiled class/type, e.g. spawn, trigger or interaction.'),
    x: z.number().int().describe('Left edge in canvas pixels.'),
    y: z.number().int().describe('Top edge in canvas pixels.'),
    width: z.number().int().min(0).optional().describe('Width in canvas pixels. Defaults to the tile width for tile objects, otherwise 0.'),
    height: z.number().int().min(0).optional().describe('Height in canvas pixels. Defaults to the tile height for tile objects, otherwise 0.'),
    tile: z.number().int().min(0).optional().describe('Optional tileset index for a Tiled tile object.'),
    rotation: z.number().finite().default(0).describe('Clockwise rotation in degrees.'),
    visible: z.boolean().default(true),
    properties: propertiesSchema.optional(),
    id: z.string().optional().describe('Stable object id. Defaults to a generated id.'),
  }),
  apply(ctx, p) {
    const tileset = requireTileset(ctx);
    if (p.tile !== undefined) validateTile(ctx, p.tile);
    const objects = (ctx.sprite.mapObjects ??= []);
    if (p.id && objects.some((object) => object.id === p.id)) {
      throw new Error(`Map object id already exists: ${p.id}`);
    }
    const object: MapObject = {
      id: p.id ?? makeId('obj'),
      name: p.name,
      type: p.type,
      x: p.x,
      y: p.y,
      width: p.width ?? (p.tile !== undefined ? tileset.tileWidth : 0),
      height: p.height ?? (p.tile !== undefined ? tileset.tileHeight : 0),
      ...(p.tile !== undefined ? { tile: p.tile } : {}),
      rotation: p.rotation,
      visible: p.visible,
      properties: propertyRecord(p.properties ?? {}),
    };
    objects.push(object);
    return {
      ...object,
      properties: { ...object.properties },
      propertyCount: Object.keys(object.properties).length,
      index: objects.length - 1,
      count: objects.length,
    };
  },
});

export const updateMapObjectCommand = defineCommand({
  name: 'update_map_object',
  description: 'Update fields and/or merge custom properties on an existing map object.',
  params: z.object({
    object: objectRefSchema,
    name: z.string().min(1).optional(),
    type: z.string().optional(),
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    width: z.number().int().min(0).optional(),
    height: z.number().int().min(0).optional(),
    tile: z.number().int().min(0).nullable().optional(),
    rotation: z.number().finite().optional(),
    visible: z.boolean().optional(),
    properties: propertiesSchema.optional(),
  }),
  apply(ctx, p) {
    const object = findObject(ctx.sprite.mapObjects ?? [], p.object);
    if (p.tile != null) validateTile(ctx, p.tile);
    if (p.name !== undefined) object.name = p.name;
    if (p.type !== undefined) object.type = p.type;
    if (p.x !== undefined) object.x = p.x;
    if (p.y !== undefined) object.y = p.y;
    if (p.width !== undefined) object.width = p.width;
    if (p.height !== undefined) object.height = p.height;
    if (p.tile !== undefined) {
      if (p.tile === null) delete object.tile;
      else object.tile = p.tile;
    }
    if (p.rotation !== undefined) object.rotation = p.rotation;
    if (p.visible !== undefined) object.visible = p.visible;
    if (p.properties !== undefined) {
      object.properties = { ...object.properties, ...propertyRecord(p.properties) };
    }
    return { ...object, properties: { ...object.properties } };
  },
});

export const removeMapObjectCommand = defineCommand({
  name: 'remove_map_object',
  description: 'Delete a map object by id or index, including its custom properties. Map objects are gameplay markers, not tiles, so nothing is repainted; `get_map_objects` lists what is there first.',
  params: z.object({ object: objectRefSchema }),
  apply(ctx, p) {
    const objects = ctx.sprite.mapObjects ?? [];
    const object = findObject(objects, p.object);
    const index = objects.indexOf(object);
    objects.splice(index, 1);
    return { removed: object.name, id: object.id, index, remaining: objects.length };
  },
});

export const getMapObjectsCommand = defineCommand({
  name: 'get_map_objects',
  description: 'Read map objects and their gameplay properties, optionally filtered by type or name.',
  readOnly: true,
  params: z.object({
    type: z.string().optional(),
    name: z.string().optional(),
  }),
  apply(ctx, p) {
    const objects = (ctx.sprite.mapObjects ?? []).filter(
      (object) => (p.type === undefined || object.type === p.type) &&
        (p.name === undefined || object.name === p.name),
    );
    return {
      count: objects.length,
      objects: objects.map((object, index) => ({ index, ...object, properties: { ...object.properties } })),
    };
  },
});

export const mapCommands = [
  setTilePropertiesCommand,
  removeTilePropertiesCommand,
  getTilePropertiesCommand,
  addMapObjectCommand,
  updateMapObjectCommand,
  removeMapObjectCommand,
  getMapObjectsCommand,
];
