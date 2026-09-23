/**
 * End-to-end tests over the real MCP client/server pair.
 *
 * These drive the server exactly as an agent would - list tools, call them,
 * read resources, run prompts - so a regression in the wire format or in a
 * schema shows up here rather than in someone's agent session.
 */
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

function payload(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content.find((c) => c.type === 'text')?.text ?? '{}');
}

function firstText(result: ToolResult): string {
  return result.content.find((c) => c.type === 'text')?.text ?? '';
}

let client: Client;
let pixel: PixelServer;
let tempDir: string;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'pixel-mcp-'));
  pixel = createPixelServer({ initialDocument: null });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([
    client.connect(clientTransport),
    pixel.server.connect(serverTransport),
  ]);
});

afterEach(async () => {
  await client.close();
  await pixel.server.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('tool surface', () => {
  it('advertises every command plus the session tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('draw_rect');
    expect(names).toContain('dither_fill');
    expect(names).toContain('add_frame');
    expect(names).toContain('quantize_to_palette');
    expect(names).toContain('apply_ops');
    expect(names).toContain('get_preview');
    expect(names).toContain('export_sheet');
    expect(names).toContain('read_skill');
    // 39 commands plus the session/perception/export tools.
    expect(names.length).toBeGreaterThanOrEqual(55);
  });

  it('exposes command descriptions and their own schemas', async () => {
    const { tools } = await client.listTools();
    const rect = tools.find((t) => t.name === 'draw_rect');
    expect(rect?.description).toBeTruthy();
    const schema = rect?.inputSchema as { properties?: Record<string, unknown> };
    expect(Object.keys(schema.properties ?? {})).toContain('rect');
    expect(Object.keys(schema.properties ?? {})).toContain('color');
    // The targeting arguments every generated tool gains.
    expect(Object.keys(schema.properties ?? {})).toContain('document');
    expect(Object.keys(schema.properties ?? {})).toContain('expectedVersion');
  });
});

describe('documents', () => {
  it('creates a document with a built-in palette and named layers', async () => {
    const result = (await client.callTool({
      name: 'create_document',
      arguments: { width: 16, height: 16, name: 'Slime', layers: ['base', 'shade'], palette: 'dawnbringer16' },
    })) as ToolResult;

    expect(result.isError).toBeFalsy();
    const body = payload(result);
    expect(body.ok).toBe(true);
    const doc = body.document as Record<string, unknown>;
    expect(doc.width).toBe(16);
    expect(doc.version).toBe(1);
    expect((body.palette as { size: number }).size).toBe(16);
    expect((body.layers as Array<{ name: string }>).map((l) => l.name)).toEqual(['base', 'shade']);
  });

  it('rejects an unknown palette with the list of valid names', async () => {
    const result = (await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, palette: 'not-a-palette' },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(payload(result).error).toMatch(/Unknown palette/);
    expect(payload(result).error).toMatch(/dawnbringer16/);
  });

  it('reports a clear error when no document is open', async () => {
    const result = (await client.callTool({ name: 'get_document', arguments: {} })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(payload(result).error).toMatch(/No active document/);
  });
});

describe('editing', () => {
  beforeEach(async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 16, height: 16, name: 'Test', layers: ['base'], palette: 'dawnbringer16' },
    });
  });

  it('runs a generated command and reports the new version', async () => {
    const result = (await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 2, y: 2, w: 6, h: 6 }, color: '#d04648', fill: true, layer: 'base' },
    })) as ToolResult;

    expect(result.isError).toBeFalsy();
    const body = payload(result);
    expect(body.ok).toBe(true);
    expect(body.command).toBe('draw_rect');
    expect(body.version).toBe(2);
    expect((body.summary as { painted: number }).painted).toBe(36);
  });

  it('surfaces invalid input as an isError result, not a throw', async () => {
    // The MCP SDK validates arguments against the advertised tool schema before the
    // handler runs, and reports the problem as a tool error result.
    const missing = (await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 0, w: 5, h: 5 } },
    })) as ToolResult;
    expect(missing.isError).toBe(true);
    expect(firstText(missing)).toMatch(/validation error/i);

    // Inside a batch the op params are validated by the command's own zod schema,
    // so a bad value comes back with our structured code.
    const bad = (await client.callTool({
      name: 'apply_ops',
      arguments: { ops: [{ command: 'draw_rect', rect: { x: 0, y: 0, w: 'nope', h: 5 }, color: '#fff' }] },
    })) as ToolResult;
    expect(payload(bad).failed).toBe(1);
    const results = payload(bad).results as { code: string }[];
    expect(results[0].code).toBe('invalid_params');
  });

  it('applies a batch and can roll it back atomically', async () => {
    const ok = (await client.callTool({
      name: 'apply_ops',
      arguments: {
        ops: [
          { command: 'draw_rect', params: { rect: { x: 0, y: 0, w: 4, h: 4 }, color: '#597dce', fill: true } },
          { command: 'outline', params: { color: '#140c1c', mode: 'inside' } },
          { command: 'add_tag', params: { name: 'idle', from: 0, to: 0 } },
        ],
      },
    })) as ToolResult;

    const body = payload(ok);
    expect(body.applied).toBe(3);
    expect(body.failed).toBe(0);
    expect(body.version).toBe(4);

    const before = payload(
      (await client.callTool({ name: 'measure_region', arguments: {} })) as ToolResult,
    ).summary as { opaque: number };

    const rolled = (await client.callTool({
      name: 'apply_ops',
      arguments: {
        atomic: true,
        ops: [
          { command: 'draw_rect', rect: { x: 8, y: 8, w: 2, h: 2 }, color: '#dad45e', fill: true },
          { command: 'this_command_does_not_exist' },
        ],
      },
    })) as ToolResult;

    const rolledBody = payload(rolled);
    expect(rolledBody.ok).toBe(false);
    expect(rolledBody.rolledBack).toBe(true);
    expect(rolledBody.applied).toBe(0);

    // The rollback restored the artwork. The version counter still moves forward,
    // because undo is itself an edit.
    const after = payload(
      (await client.callTool({ name: 'measure_region', arguments: {} })) as ToolResult,
    ).summary as { opaque: number };
    expect(after.opaque).toBe(before.opaque);
  });

  it('rejects a stale expectedVersion', async () => {
    const conflict = (await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 0, w: 1, h: 1 }, color: '#fff', expectedVersion: 99 },
    })) as ToolResult;
    expect(conflict.isError).toBe(true);
    expect(payload(conflict).code).toBe('version_conflict');

    const good = (await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 0, w: 1, h: 1 }, color: '#fff', expectedVersion: 1 },
    })) as ToolResult;
    expect(payload(good).ok).toBe(true);
  });

  it('undoes and redoes', async () => {
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 0, w: 8, h: 8 }, color: '#346524', fill: true },
    });
    const undone = (await client.callTool({ name: 'undo', arguments: {} })) as ToolResult;
    expect(payload(undone).undone).toBe(1);

    const measure = (await client.callTool({
      name: 'measure_region',
      arguments: { rect: { x: 0, y: 0, w: 8, h: 8 } },
    })) as ToolResult;
    expect((payload(measure).summary as { opaque: number }).opaque).toBe(0);

    const redone = (await client.callTool({ name: 'redo', arguments: {} })) as ToolResult;
    expect(payload(redone).redone).toBe(1);
  });
});

describe('perception', () => {
  it('returns the composited sprite as a real image block', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, layers: ['base'], palette: 'dawnbringer16' },
    });
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 0, y: 0, w: 8, h: 8 }, color: '#d04648', fill: true, layer: 'base' },
    });

    const result = (await client.callTool({ name: 'get_preview', arguments: {} })) as ToolResult;
    const image = result.content.find((c) => c.type === 'image');
    expect(image?.mimeType).toBe('image/png');
    expect(image?.data && image.data.length).toBeGreaterThan(50);
    // A PNG signature in the decoded payload proves it is a real image.
    expect(Buffer.from(image!.data!, 'base64').subarray(0, 4).toString('hex')).toBe('89504e47');

    const body = payload(result);
    expect(body.imageWidth).toBe(128); // 8px upscaled 16x to reach the ~256px preview target
    expect(body.upscale).toBe(16);
  });

  it('reads exact pixels for a region', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, layers: ['base'] },
    });
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 1, y: 1, w: 2, h: 2 }, color: '#ff0000', fill: true, layer: 'base' },
    });

    const result = (await client.callTool({
      name: 'get_pixels',
      arguments: { rect: { x: 0, y: 0, w: 4, h: 3 } },
    })) as ToolResult;
    const rows = payload(result).rows as string[];
    expect(rows[0].split(' ')).toEqual(['..', '..', '..', '..']);
    expect(rows[1].split(' ')).toEqual(['..', 'ff0000', 'ff0000', '..']);
    expect(rows[2].split(' ')).toEqual(['..', 'ff0000', 'ff0000', '..']);
  });

  it('refuses an oversized pixel region', async () => {
    await client.callTool({ name: 'create_document', arguments: { width: 64, height: 64 } });
    const result = (await client.callTool({
      name: 'get_pixels',
      arguments: { rect: { x: 0, y: 0, w: 64, h: 64 } },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(payload(result).error).toMatch(/exceeds/);
  });
});

describe('resources and prompts', () => {
  it('serves the craft guide and the command catalogue', async () => {
    const skill = await client.readResource({ uri: 'pixel://skill' });
    const skillText = (skill.contents[0] as { text: string }).text;
    expect(skillText).toMatch(/silhouette/i);
    expect(skillText).toMatch(/dither/i);

    const commands = await client.readResource({ uri: 'pixel://commands' });
    const catalog = JSON.parse((commands.contents[0] as { text: string }).text);
    expect(catalog.commands.length).toBeGreaterThanOrEqual(35);
  });

  it('lists documents and serves a preview blob', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 4, height: 4, layers: ['base'] },
    });

    const list = await client.readResource({ uri: 'pixel://documents' });
    const listed = JSON.parse((list.contents[0] as { text: string }).text);
    const id = listed.documents[0].id as string;
    expect(listed.activeDocument).toBe(id);

    const preview = await client.readResource({ uri: `pixel://documents/${id}/preview` });
    const blob = preview.contents[0] as { mimeType: string; blob: string };
    expect(blob.mimeType).toBe('image/png');
    expect(Buffer.from(blob.blob, 'base64').subarray(0, 4).toString('hex')).toBe('89504e47');
  });

  it('serves the drawing prompt with the requested subject', async () => {
    const prompt = await client.getPrompt({
      name: 'draw_sprite',
      arguments: { subject: 'a small green slime', width: '16', height: '16' },
    });
    const text = (prompt.messages[0].content as { text: string }).text;
    expect(text).toMatch(/a small green slime/);
    expect(text).toMatch(/16x16/);
    expect(text).toMatch(/create_document/);
  });
});

describe('export', () => {
  it('writes a PNG and a spritesheet with Aseprite JSON', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, name: 'Gem', layers: ['base'], frames: 2, palette: 'endesga16' },
    });
    await client.callTool({
      name: 'apply_ops',
      arguments: {
        ops: [
          { command: 'draw_rect', rect: { x: 0, y: 0, w: 4, h: 4 }, color: '#2ce8f4', fill: true, frame: 0 },
          { command: 'draw_rect', rect: { x: 4, y: 4, w: 4, h: 4 }, color: '#0484d1', fill: true, frame: 1 },
          { command: 'add_tag', name: 'spin', from: 0, to: 1 },
        ],
      },
    });

    const png = join(tempDir, 'gem.png');
    const exported = (await client.callTool({
      name: 'export_png',
      arguments: { out: png, frames: 'all' },
    })) as ToolResult;
    const files = payload(exported).files as string[];
    expect(files).toHaveLength(2);
    expect(readFileSync(files[0]).subarray(0, 4).toString('hex')).toBe('89504e47');

    const sheet = join(tempDir, 'gem-sheet.png');
    const sheetResult = (await client.callTool({
      name: 'export_sheet',
      arguments: { out: sheet, layout: 'grid', columns: 2, padding: 1 },
    })) as ToolResult;
    const sheetBody = payload(sheetResult);
    expect(sheetBody.frames).toBe(2);
    expect(sheetBody.columns).toBe(2);

    const json = JSON.parse(readFileSync(sheetBody.json as string, 'utf8'));
    expect(json.meta.image).toBe('gem-sheet.png');
    expect(json.frames['Gem 0.png']).toBeTruthy();
    expect(json.meta.frameTags[0].name).toBe('spin');
  });

  it('round-trips a document through save and open', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, name: 'Round', layers: ['base', 'shade'] },
    });
    await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 1, y: 1, w: 3, h: 3 }, color: '#ffccaa', fill: true, layer: 'shade' },
    });

    const path = join(tempDir, 'round.pixel');
    const saved = (await client.callTool({ name: 'save_document', arguments: { path } })) as ToolResult;
    expect(payload(saved).ok).toBe(true);

    const opened = (await client.callTool({ name: 'open_document', arguments: { path } })) as ToolResult;
    const openedBody = payload(opened);
    expect(openedBody.ok).toBe(true);
    const openedId = (openedBody.document as { id: string }).id;

    const doc = (await client.callTool({ name: 'get_document', arguments: { document: openedId } })) as ToolResult;
    const detail = payload(doc);
    expect((detail.layers as Array<{ name: string }>).map((l) => l.name)).toEqual(['base', 'shade']);
    expect((detail.palette as { size: number }).size).toBeGreaterThan(0);
  });
});
