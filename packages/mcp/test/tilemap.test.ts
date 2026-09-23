import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPixelServer, type PixelServer } from '../src/server.js';

interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Parse the first text block of a tool result as JSON. */
function payload(result: ToolResult): Record<string, any> {
  return JSON.parse(result.content.find((c) => c.type === 'text')?.text ?? '{}');
}

function firstText(result: ToolResult): string {
  return result.content.find((c) => c.type === 'text')?.text ?? '';
}

let client: Client;
let pixel: PixelServer;
let tempDir: string;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'pixel-mcp-tilemap-'));
  pixel = createPixelServer({ initialDocument: null });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'tilemap-test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), pixel.server.connect(serverTransport)]);
});

afterEach(async () => {
  await client.close();
  await pixel.server.close();
  rmSync(tempDir, { recursive: true, force: true });
});

/** Call a generated command tool and return its nested summary. */
async function run(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  const body = payload(result);
  return { ...body, ...(body.summary ?? {}) };
}

/**
 * A document with a 2x2 sheet of 16px tiles on the `sheet` layer and an empty
 * `level` layer to paint terrain into.
 */
async function makeLevelDocument(): Promise<void> {
  await client.callTool({
    name: 'create_document',
    arguments: { width: 64, height: 64, name: 'Level', layers: ['sheet', 'level'], palette: 'dawnbringer16' },
  });
  const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00'];
  let i = 0;
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) {
      await client.callTool({
        name: 'draw_rect',
        arguments: {
          layer: 'sheet',
          frame: 0,
          rect: { x: x * 16, y: y * 16, w: 16, h: 16 },
          color: colors[i++],
          fill: true,
        },
      });
    }
  }
  await run('create_tileset', {
    layer: 'sheet',
    frame: 0,
    tileWidth: 16,
    tileHeight: 16,
    columns: 2,
    // `source` defaults to the whole cel, so pass it: the sheet is 32x32 on a
    // 64x64 canvas, and the default would cut 2x4 = 8 tiles instead of 2x2 = 4.
    source: { x: 0, y: 0, w: 32, h: 32 },
  });
}

describe('tilemaps and Tiled export', () => {
  it('advertises export_tiled as a tool', async () => {
    // The M3 milestone once claimed this tool shipped when it did not, and nothing
    // caught it because no test listed the tools. This is that guard.
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('export_tiled');
    for (const name of [
      'create_tileset',
      'add_tilemap',
      'remove_tilemap',
      'set_tile',
      'fill_tilemap',
      'resize_tilemap',
      'autotile',
      'paint_tilemap',
      'get_tilemap',
    ]) {
      expect(names).toContain(name);
    }
  });

  it('cuts a tileset out of a layer', async () => {
    await makeLevelDocument();
    const detail = payload(
      (await client.callTool({ name: 'get_document', arguments: {} })) as ToolResult,
    );
    expect(detail.hasTileset).toBe(true);
  });

  it('adds, fills and reads back a tilemap', async () => {
    await makeLevelDocument();

    const added = await run('add_tilemap', { name: 'Ground', width: 4, height: 3, tileWidth: 16, tileHeight: 16 });
    expect(added.width).toBe(4);
    expect(added.height).toBe(3);

    const filled = await run('fill_tilemap', { tilemap: 0, tile: 1, rect: { x: 1, y: 1, w: 2, h: 2 } });
    expect(filled.filled).toBe(4);

    const read = await run('get_tilemap', { tilemap: 0 });
    expect(read.filled).toBe(4);
    expect(read.rows[1][1]).toBe(1);
    expect(read.rows[0][0]).toBe(-1);
  });

  it('writes a batch of tiles and resizes while keeping what fits', async () => {
    await makeLevelDocument();
    await run('add_tilemap', { width: 4, height: 3, tileWidth: 16, tileHeight: 16 });

    const written = await run('set_tile', {
      tilemap: 0,
      tiles: [
        { x: 0, y: 0, tile: 3 },
        { x: 3, y: 2, tile: 2 },
        { x: 9, y: 9, tile: 1 },
      ],
    });
    expect(written.written).toBe(2);
    expect(written.skipped).toBe(1);

    const resized = await run('resize_tilemap', { tilemap: 0, width: 6, height: 4, offsetX: 1, offsetY: 1 });
    expect(resized.width).toBe(6);
    expect(resized.height).toBe(4);

    const read = await run('get_tilemap', { tilemap: 0 });
    expect(read.rows[1][1]).toBe(3);
    expect(read.rows[3][4]).toBe(2);
  });

  it('autotiles terrain and leaves the background empty', async () => {
    await makeLevelDocument();
    await run('add_tilemap', { width: 5, height: 5, tileWidth: 16, tileHeight: 16 });
    await run('fill_tilemap', { tilemap: 0, tile: 1, rect: { x: 1, y: 1, w: 2, h: 2 } });

    const result = await run('autotile', { tilemap: 0, set: 16, indices: [1] });
    expect(result.set).toBe(16);
    expect(result.changed).toBe(4);

    const read = await run('get_tilemap', { tilemap: 0 });
    // Cardinal bits: N=1, E=2, S=4, W=8. With `set: 16` the index is the mask.
    expect(read.rows[1][1]).toBe(2 | 4); // E and S
    expect(read.rows[1][2]).toBe(8 | 4); // W and S
    expect(read.rows[2][1]).toBe(1 | 2); // N and E
    expect(read.rows[2][2]).toBe(1 | 8); // N and W
    // The pass only rewrites cells that are already terrain.
    expect(read.filled).toBe(4);
    expect(read.rows[0][0]).toBe(-1);
  });

  it('removes a tilemap', async () => {
    await makeLevelDocument();
    await run('add_tilemap', { name: 'Scratch', width: 2, height: 2 });
    const removed = await run('remove_tilemap', { tilemap: 0 });
    expect(removed.removed).toBe('Scratch');

    const detail = payload((await client.callTool({ name: 'get_document', arguments: {} })) as ToolResult);
    expect(detail.tilemaps).toEqual([]);
  });

  it('paints a tilemap into a pixel layer', async () => {
    await makeLevelDocument();
    await run('add_tilemap', { width: 4, height: 3, tileWidth: 16, tileHeight: 16 });
    await run('fill_tilemap', { tilemap: 0, tile: 1 });

    const painted = await run('paint_tilemap', { tilemap: 0, layer: 'level', frame: 0 });
    expect(painted.drawn).toBe(12);

    const measured = payload(
      (await client.callTool({
        name: 'measure_region',
        arguments: { layer: 'level', frame: 0 },
      })) as ToolResult,
    );
    expect(measured.summary.opaque).toBe(12 * 16 * 16);
  });

  it('exports a Tiled map whose data matches the tilemap', async () => {
    await makeLevelDocument();
    await run('add_tilemap', { name: 'Ground', width: 4, height: 3, tileWidth: 16, tileHeight: 16 });
    await run('fill_tilemap', { tilemap: 0, tile: 1, rect: { x: 1, y: 1, w: 2, h: 2 } });
    await run('autotile', { tilemap: 0, set: 16, indices: [1] });

    const out = join(tempDir, 'level.tmj');
    const exported = await run('export_tiled', { out });
    expect(exported.ok).toBe(true);
    expect(exported.layers).toEqual(['Ground']);
    expect(exported.tiles).toBe(4);
    expect(exported.width).toBe(4);
    expect(exported.height).toBe(3);

    const map = JSON.parse(readFileSync(out, 'utf8'));
    expect(map.type).toBe('map');
    expect(map.tilewidth).toBe(16);
    expect(map.layers).toHaveLength(1);
    expect(map.layers[0].data).toHaveLength(12);
    // Empty cells become 0; tile `n` becomes `n + firstgid`.
    expect(map.layers[0].data[0]).toBe(0);
    expect(map.layers[0].data[1 * 4 + 1]).toBe(6 + 1);
    expect(map.tilesets[0].tilecount).toBe(4);
    expect(map.tilesets[0].firstgid).toBe(1);
  });

  it('accepts `path` as an alias for `out` on export_tiled', async () => {
    await makeLevelDocument();
    await run('add_tilemap', { width: 2, height: 2, tileWidth: 16, tileHeight: 16 });
    const out = join(tempDir, 'alias.tmj');
    const exported = await run('export_tiled', { path: out });
    expect(exported.path).toBe(out);
    expect(JSON.parse(readFileSync(out, 'utf8')).type).toBe('map');
  });

  it('explains what is missing when there is nothing to export', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 16, height: 16, name: 'Bare', layers: ['base'] },
    });

    const noTileset = (await client.callTool({
      name: 'export_tiled',
      arguments: { out: join(tempDir, 'bare.tmj') },
    })) as ToolResult;
    expect(noTileset.isError).toBe(true);
    expect(firstText(noTileset)).toMatch(/create_tileset/);

    const noTilemap = (await client.callTool({
      name: 'export_tiled',
      arguments: { out: join(tempDir, 'bare.tmj') },
    })) as ToolResult;
    expect(noTilemap.isError).toBe(true);
  });

  it('rejects an unknown tilemap instead of guessing', async () => {
    await makeLevelDocument();
    const result = (await client.callTool({ name: 'get_tilemap', arguments: { tilemap: 7 } })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/tilemap/i);
  });
});
