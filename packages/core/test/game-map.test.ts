import { describe, expect, it } from 'vitest';
import { createEditor, createSprite, toTiledJson } from '../src/index.js';

function mapEditor() {
  const editor = createEditor(createSprite({ width: 32, height: 32, layers: ['sheet', 'level'] }));
  const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00'];
  let index = 0;
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) {
      editor.execute('draw_rect', {
        layer: 0,
        frame: 0,
        rect: { x: x * 16, y: y * 16, w: 16, h: 16 },
        color: colors[index++],
        fill: true,
      });
    }
  }
  editor.execute('create_tileset', { layer: 0, frame: 0, tileWidth: 16, tileHeight: 16 });
  editor.execute('add_tilemap', { width: 4, height: 3, tileWidth: 16, tileHeight: 16 });
  return editor;
}

describe('tile gameplay properties', () => {
  it('merges, reads and removes JSON-safe custom properties', () => {
    const editor = mapEditor();
    expect(editor.execute('set_tile_properties', {
      tile: 1,
      properties: { walkable: false, moveSpeed: 0.5, kind: 'water' },
    })).toMatchObject({ tile: 1, changedKeys: ['walkable', 'moveSpeed', 'kind'] });

    expect(editor.execute('set_tile_properties', {
      tile: 1,
      properties: { moveSpeed: 0.75, splash: true },
    }).changedKeys).toEqual(['moveSpeed', 'splash']);
    expect(editor.execute('get_tile_properties', { tile: 1 }).properties).toEqual({
      walkable: false,
      moveSpeed: 0.75,
      kind: 'water',
      splash: true,
    });

    expect(editor.execute('remove_tile_properties', { tile: 1, keys: ['moveSpeed', 'splash'] })).toMatchObject({
      removed: ['moveSpeed', 'splash'],
      properties: { walkable: false, kind: 'water' },
    });
    expect(editor.execute('get_tile_properties', { tile: 1 }).properties).toEqual({
      walkable: false,
      kind: 'water',
    });
  });

  it('rejects metadata for a tile outside the sheet', () => {
    const editor = mapEditor();
    const result = editor.tryExecute('set_tile_properties', { tile: 99, properties: { solid: true } });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/outside the 4-tile tileset/);
  });
});

describe('map objects', () => {
  it('adds, updates, filters and removes gameplay objects', () => {
    const editor = mapEditor();
    const added = editor.execute('add_map_object', {
      name: 'North gate',
      type: 'spawn',
      x: 24,
      y: 8,
      tile: 2,
      properties: { team: 'blue', interact: 'open-gate' },
    });
    expect(added).toMatchObject({
      name: 'North gate',
      type: 'spawn',
      x: 24,
      y: 8,
      width: 16,
      height: 16,
      tile: 2,
      visible: true,
      index: 0,
    });

    editor.execute('add_map_object', {
      name: 'Water trigger',
      type: 'trigger',
      x: 0,
      y: 16,
      width: 32,
      height: 16,
      properties: { damage: 2 },
    });
    expect(editor.execute('get_map_objects', { type: 'spawn' })).toMatchObject({
      count: 1,
      objects: [{ name: 'North gate', properties: { team: 'blue', interact: 'open-gate' } }],
    });

    const id = String(added.id);
    expect(editor.execute('update_map_object', {
      object: id,
      x: 32,
      properties: { visited: true },
    })).toMatchObject({ x: 32, properties: { team: 'blue', interact: 'open-gate', visited: true } });

    expect(editor.execute('remove_map_object', { object: id })).toMatchObject({
      removed: 'North gate',
      remaining: 1,
    });
    expect(editor.execute('get_map_objects').count).toBe(1);
  });

  it('exports tile properties and map objects as a Tiled object group', () => {
    const editor = mapEditor();
    editor.execute('set_tile_properties', {
      tile: 0,
      properties: { walkable: true, kind: 'grass', speed: 0.75 },
    });
    editor.execute('add_map_object', {
      name: 'North gate',
      type: 'spawn',
      x: 16,
      y: 8,
      width: 8,
      height: 8,
      tile: 0,
      properties: { team: 'blue', interact: true, priority: 2 },
    });

    const json = toTiledJson(editor.sprite.tileset!, editor.sprite.tilemaps!, {
      mapObjects: editor.sprite.mapObjects,
    });
    expect(json.tilesets[0]?.tiles).toEqual([{
      id: 0,
      properties: [
        { name: 'kind', type: 'string', value: 'grass' },
        { name: 'speed', type: 'float', value: 0.75 },
        { name: 'walkable', type: 'bool', value: true },
      ],
    }]);
    expect(json.nextlayerid).toBe(3);
    expect(json.nextobjectid).toBe(2);
    const layer = json.layers[1];
    expect(layer.type).toBe('objectgroup');
    if (layer.type !== 'objectgroup') throw new Error('Expected object group');
    expect(layer.objects).toEqual([expect.objectContaining({
      id: 1,
      name: 'North gate',
      type: 'spawn',
      y: 16,
      gid: 1,
      properties: expect.arrayContaining([
        { name: 'interact', type: 'bool', value: true },
        { name: 'priority', type: 'int', value: 2 },
        { name: 'team', type: 'string', value: 'blue' },
      ]),
    })]);
  });

  it('undo does not mutate a previous object snapshot through shared properties', () => {
    const editor = mapEditor();
    const added = editor.execute('add_map_object', {
      name: 'Chest',
      type: 'interactable',
      x: 8,
      y: 8,
      properties: { loot: 'gold' },
    });
    editor.execute('update_map_object', {
      object: String(added.id),
      properties: { loot: 'silver' },
    });
    expect(editor.execute('get_map_objects').objects[0].properties.loot).toBe('silver');
    editor.undo();
    expect(editor.execute('get_map_objects').objects[0].properties.loot).toBe('gold');
  });
});
