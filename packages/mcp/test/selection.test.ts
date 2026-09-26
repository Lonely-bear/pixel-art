/**
 * Tests for the canvas selection the user draws and the agent reads.
 *
 * The point of the feature is that two clients that never talk to each other - a
 * window drawing a box, and a model asking where it is - agree on one rectangle. So
 * the tests are mostly about the edges of that agreement: a drag that runs backwards,
 * a drag that leaves the canvas, a click that was never a drag, and a layer that was
 * deleted after the box was drawn.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createPixelServer, SERVER_INSTRUCTIONS, type PixelServer } from '../src/server.js';
import type { DocumentStore } from '../src/session.js';

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

let client: Client;
let pixel: PixelServer;
let store: DocumentStore;

function payload(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content.find((c) => c.type === 'text')?.text ?? '{}');
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

beforeEach(async () => {
  pixel = createPixelServer({ initialDocument: null });
  store = pixel.store;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'selection-test', version: '1.0.0' });
  await Promise.all([
    client.connect(clientTransport),
    pixel.server.connect(serverTransport),
  ]);
  await call('create_document', {
    width: 64,
    height: 64,
    layers: ['base', 'shade'],
    palette: ['#101018', '#405070', '#e0d0b0'],
  });
});

describe('get_selection', () => {
  it('answers with a real null when the user has boxed nothing', async () => {
    const body = payload(await call('get_selection'));
    // Not an error and not an empty object: "no box" is an answer the agent can act
    // on, and it means the whole canvas rather than a region nobody chose.
    expect(body.selection).toBeNull();
    expect(body.note).toMatch(/whole canvas/i);
  });

  it('reports the box the window drew, with its layer and frame', async () => {
    const detail = payload(await call('get_document'));
    const layer = (detail.layers as Array<{ id: string; name: string }>)[1];
    const frame = (detail.frames as Array<{ id: string }>)[0];
    store.setSelection(store.require(undefined), {
      rect: { x: 10, y: 8, w: 12, h: 14 },
      layerId: layer.id,
      frameId: frame.id,
    });

    const selection = payload(await call('get_selection')).selection as Record<string, unknown>;
    expect(selection.rect).toEqual({ x: 10, y: 8, w: 12, h: 14 });
    // The whole point: the agent learns *which layer* the box is pointing at rather
    // than assuming the one that happens to be active.
    expect(selection.layer).toMatchObject({ name: 'shade', index: 1 });
    expect(selection.frame).toMatchObject({ index: 0 });
    expect(selection.mode).toBe('hint');
  });

  it('drops a box whose layer has since been deleted, rather than reporting a lie', async () => {
    const doc = store.require(undefined);
    const detail = payload(await call('get_document'));
    const layer = (detail.layers as Array<{ id: string; name: string }>)[1];
    store.setSelection(doc, { rect: { x: 4, y: 4, w: 8, h: 8 }, layerId: layer.id });
    expect(payload(await call('get_selection')).selection).not.toBeNull();

    // A box pointing at a deleted layer is worse than no box: an agent would edit the
    // wrong pixels. `remove_layer` runs through the command bus, which never touches
    // the store, so the read is where it has to be caught.
    const removed = payload(
      await call('apply_ops', { ops: [{ command: 'remove_layer', params: { layer: 'shade' } }] }),
    );
    expect(removed.ok).toBe(true);
    expect(payload(await call('get_selection')).selection).toBeNull();
  });
});

describe('the box the user drags', () => {
  it('normalises a drag that runs backwards', async () => {
    // Dragging up and to the left is the normal way to select, so the rect arrives
    // with negative w/h and has to come out the right way round.
    store.setSelection(store.require(undefined), { rect: { x: 30, y: 30, w: -20, h: -20 } });
    const selection = payload(await call('get_selection')).selection as { rect: unknown };
    expect(selection.rect).toEqual({ x: 10, y: 10, w: 20, h: 20 });
  });

  it('clips a box that runs off the canvas', async () => {
    store.setSelection(store.require(undefined), { rect: { x: 60, y: 60, w: 40, h: 40 } });
    const selection = payload(await call('get_selection')).selection as { rect: unknown };
    expect(selection.rect).toEqual({ x: 60, y: 60, w: 4, h: 4 });
  });

  it('treats a click as clearing the box, and keeps a one-pixel drag', async () => {
    store.setSelection(store.require(undefined), { rect: { x: 4, y: 4, w: 8, h: 8 } });
    // A click covers no pixel and is how people ask to go back to the whole canvas.
    store.setSelection(store.require(undefined), { rect: { x: 4, y: 4, w: 0, h: 0 } });
    expect(payload(await call('get_selection')).selection).toBeNull();

    store.setSelection(store.require(undefined), { rect: { x: 4, y: 4, w: 1, h: 1 } });
    expect(payload(await call('get_selection')).selection).toMatchObject({ rect: { w: 1, h: 1 } });
  });

  it('costs no undo step and does not dirty the document', async () => {
    const doc = store.require(undefined);
    const version = doc.editor.version;
    const before = doc.editor.history().length;

    store.setSelection(doc, { rect: { x: 2, y: 2, w: 8, h: 8 } });

    // Where the subject is, not an edit to the artwork: it must not show up in
    // history, must not bump the version, and must not mark the file unsaved.
    expect(doc.editor.history().length).toBe(before);
    expect(doc.editor.version).toBe(version);
    expect(doc.dirty).toBe(false);
  });

  it('never reaches the .pixel file', async () => {
    const doc = store.require(undefined);
    store.setSelection(doc, { rect: { x: 2, y: 2, w: 8, h: 8 } });
    // Session state, so a reopened file has no box in it.
    expect(new TextDecoder().decode(store.save(doc))).not.toContain('selection');
  });

  it('keeps the mode the user chose when they draw a new box', async () => {
    const doc = store.require(undefined);
    store.setSelection(doc, { rect: { x: 2, y: 2, w: 8, h: 8 }, mode: 'enforce' });
    store.setSelection(doc, { rect: { x: 20, y: 20, w: 8, h: 8 } });
    expect(store.selection(doc)?.mode).toBe('enforce');
  });
});

describe('set_selection', () => {
  it('lets the agent box a region and choose the mode', async () => {
    const result = await call('set_selection', { rect: { x: 4, y: 4, w: 8, h: 8 }, mode: 'enforce' });
    expect(result.isError).toBeFalsy();
    expect(payload(result).selection).toMatchObject({ mode: 'enforce' });
  });

  it('clears on `clear: true` and on a zero-area rect', async () => {
    await call('set_selection', { rect: { x: 4, y: 4, w: 8, h: 8 } });
    expect(payload(await call('set_selection', { clear: true })).selection).toBeNull();

    await call('set_selection', { rect: { x: 4, y: 4, w: 8, h: 8 } });
    await call('set_selection', { rect: { x: 4, y: 4, w: 0, h: 0 } });
    expect(payload(await call('get_selection')).selection).toBeNull();
  });

  it('refuses a box that misses the canvas entirely, and says why', async () => {
    const result = await call('set_selection', { rect: { x: 200, y: 200, w: 8, h: 8 } });
    expect(result.isError).toBe(true);
    expect(payload(result).error).toMatch(/64x64/);
  });

  it('demands a rect or an explicit clear', async () => {
    const result = await call('set_selection', {});
    expect(result.isError).toBe(true);
    expect(payload(result).error).toMatch(/rect/);
  });
});

describe('using the box', () => {
  it('is a rect the drawing commands accept, so an edit can stay inside it', async () => {
    await call('set_selection', { rect: { x: 0, y: 0, w: 16, h: 16 } });
    const box = (payload(await call('get_selection')).selection as { rect: { x: number; y: number; w: number; h: number } }).rect;

    const drawn = payload(
      await call('apply_ops', { ops: [{ command: 'draw_rect', params: { rect: box, color: '#ff0000', fill: true } }] }),
    );
    expect(drawn.ok).toBe(true);

    const read = payload(await call('get_pixels', { rect: box, max: 32 })) as { rows: string[] };
    expect(read.rows[0]).toContain('ff0000');
  });

  it('is documented in the server instructions, so a model knows to look', () => {
    expect(SERVER_INSTRUCTIONS).toContain('get_selection');
    expect(SERVER_INSTRUCTIONS).toMatch(/my selection|boxed/i);
  });
});
