import { describe, expect, it } from 'vitest';
import {
  allCommands,
  createEditor,
  createMutableRegistry,
  createPalette,
  createSprite,
  type Editor,
} from '@pixel/core';
import { ScriptRuntime } from '../src/sandbox.js';

function makeEditor(): Editor {
  const sprite = createSprite({
    width: 8,
    height: 8,
    layers: ['base'],
    palette: createPalette('test', ['#ff0000', '#00ff00', '#0000ff', '#ffffff']),
  });
  return createEditor(sprite);
}

function pixel(editor: Editor, x: number, y: number, layerIndex = 0, frameIndex = 0) {
  const layer = editor.sprite.layers[layerIndex];
  const frame = editor.sprite.frames[frameIndex];
  return frame.cels.get(layer.id)?.getColor(x, y) ?? null;
}

describe('ScriptRuntime.run', () => {
  it('runs a script, returns its value and captures logs', () => {
    const editor = makeEditor();
    const runtime = new ScriptRuntime();
    const outcome = runtime.run(
      `log('hello', 42); exec('draw_pixels', { layer: 0, frame: 0, pixels: [{ x: 1, y: 1, color: '#ff0000' }] }); return { done: true };`,
      editor,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual({ done: true });
    expect(outcome.logs).toEqual(['hello 42']);
    expect(pixel(editor, 1, 1)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
  });

  it('exposes read-only document queries', () => {
    const editor = makeEditor();
    const runtime = new ScriptRuntime();
    const outcome = runtime.run(
      `const doc = document();
       return { name: doc.name, width: doc.width, height: doc.height, layers: doc.layers.length, frames: frames().length, tags: tags().length, palette: palette().colors.length, layerName: document().layers[0].name };`,
      editor,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual({
      name: editor.sprite.name,
      width: 8,
      height: 8,
      layers: 1,
      frames: 1,
      tags: 0,
      palette: 4,
      layerName: 'base',
    });
  });

  it('resolves palette shorthand through exec and reads it back with getPixel/sample', () => {
    const editor = makeEditor();
    const runtime = new ScriptRuntime();
    const outcome = runtime.run(
      `exec('draw_pixels', { layer: 0, frame: 0, pixels: [{ x: 2, y: 2, color: 'pal:1' }, { x: 3, y: 2, color: 2 }] });
       return { a: getPixel(2, 2, 0, 0), b: sample(3, 2, 0) };`,
      editor,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual({
      a: { r: 0, g: 255, b: 0, a: 255 },
      b: { r: 0, g: 0, b: 255, a: 255 },
    });
  });

  it('reports an unpainted pixel as null, not a zeroed colour', () => {
    // A zeroed `{r:0,g:0,b:0,a:0}` object is truthy, so returning it for empty space
    // would make every `if (getPixel(x, y))` emptiness test in a script wrong.
    const editor = createEditor(
      createSprite({ width: 8, height: 8, layers: ['base'], palette: createPalette('test', ['#ff0000']) }),
    );
    const runtime = new ScriptRuntime();
    const outcome = runtime.run(
      `exec('draw_pixels', { layer: 0, frame: 0, pixels: [{ x: 1, y: 1, color: '#ff0000' }] });
       return {
         emptyPixel: getPixel(5, 5, 'base', 0),
         emptyIsFalsy: !getPixel(5, 5, 'base', 0),
         paintedIsTruthy: !!getPixel(1, 1, 'base', 0),
         emptySample: sample(6, 6, 0),
         emptyLayerSample: sample(6, 6, { layer: 'base' }),
       };`,
      editor,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual({
      emptyPixel: null,
      emptyIsFalsy: true,
      paintedIsTruthy: true,
      emptySample: null,
      emptyLayerSample: null,
    });
  });

  it('fills script command defaults and supports layer-specific sample()', () => {
    const editor = createEditor(
      createSprite({ width: 8, height: 8, layers: ['base', 'top'], palette: createPalette('test', ['#ff0000', '#00ff00']) }),
    );
    const runtime = new ScriptRuntime();
    const outcome = runtime.run(
      `exec('draw_rect', { rect: { x: 0, y: 0, w: 2, h: 2 }, color: '#ff0000', fill: true });
       exec('draw_rect', { layer: 1, rect: { x: 4, y: 4, w: 2, h: 2 }, color: '#00ff00', fill: true });
       return { base: sample(1, 1, { layer: 'base' }), composite: sample(5, 5), defaulted: getPixel(0, 0) };`,
      editor,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual({
      base: { r: 255, g: 0, b: 0, a: 255 },
      composite: { r: 0, g: 255, b: 0, a: 255 },
      defaulted: { r: 255, g: 0, b: 0, a: 255 },
    });
  });

  it('exposes putPixels() for a base64 RGBA batch', () => {
    const editor = makeEditor();
    const runtime = new ScriptRuntime();
    // 1x2 RGBA: red opaque, green half-transparent.
    const data = '/wAA/wD/AIA=';
    const outcome = runtime.run(
      `return putPixels({ x: 1, y: 1, w: 2, h: 1 }, '${data}');`,
      editor,
    );
    expect(outcome.ok, outcome.error).toBe(true);
    expect((outcome.result as { written: number }).written).toBe(2);
    expect(pixel(editor, 1, 1)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(pixel(editor, 2, 1)).toEqual({ r: 0, g: 255, b: 0, a: 128 });
  });

  it('reports a thrown script error without killing the runtime', () => {
    const editor = makeEditor();
    const runtime = new ScriptRuntime();
    const failed = runtime.run(`throw new Error('boom');`, editor);
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('boom');

    const recovered = runtime.run(`return 'still alive';`, editor);
    expect(recovered.ok).toBe(true);
    expect(recovered.result).toBe('still alive');
  });

  it('surfaces command errors with their code', () => {
    const editor = makeEditor();
    const runtime = new ScriptRuntime();
    const outcome = runtime.run(
      `try { exec('no_such_command', {}); return 'no throw'; }
       catch (e) { return { code: e.code, message: e.message }; }`,
      editor,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toMatchObject({ code: 'unknown_command' });
  });

  it('kills a runaway script with a timeout', () => {
    const editor = makeEditor();
    const runtime = new ScriptRuntime({ timeoutMs: 100 });
    const outcome = runtime.run(`while (true) {}`, editor);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('timed out');
  });

  it('is isolated: no process, require, eval or bridge', () => {
    const editor = makeEditor();
    const runtime = new ScriptRuntime();
    const outcome = runtime.run(
      `let evalError = false;
       try { eval('1 + 1'); } catch (e) { evalError = true; }
       let fnError = false;
       try { new Function('return 1'); } catch (e) { fnError = true; }
       return { process: typeof process, require: typeof require, module: typeof module, bridge: typeof __bridge, evalError, fnError };`,
      editor,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual({
      process: 'undefined',
      require: 'undefined',
      module: 'undefined',
      bridge: 'undefined',
      evalError: true,
      fnError: true,
    });
  });

  it('collapses a whole script into one undo step', () => {
    const editor = makeEditor();
    const runtime = new ScriptRuntime();
    const outcome = runtime.run(
      `for (let i = 0; i < 5; i++) {
         exec('draw_pixels', { layer: 0, frame: 0, pixels: [{ x: i, y: 0, color: '#ff0000' }] });
       }
       return 'done';`,
      editor,
    );
    expect(outcome.ok).toBe(true);
    expect(editor.history()).toHaveLength(1);
    expect(editor.history()[0].command).toBe('transaction');

    editor.undo();
    expect(pixel(editor, 0, 0)).toBeNull();
    expect(editor.canUndo()).toBe(false);
  });

  it('does not create an undo step for a read-only script', () => {
    const editor = makeEditor();
    const runtime = new ScriptRuntime();
    const outcome = runtime.run(`return document().width;`, editor);
    expect(outcome.ok).toBe(true);
    expect(editor.history()).toHaveLength(0);
  });

  it('rolls back partial edits when a script throws', () => {
    const editor = makeEditor();
    const runtime = new ScriptRuntime();
    const outcome = runtime.run(
      `exec('draw_pixels', { layer: 0, frame: 0, pixels: [{ x: 4, y: 4, color: '#ff0000' }] });
       throw new Error('halfway');`,
      editor,
    );
    expect(outcome.ok).toBe(false);
    expect(pixel(editor, 4, 4)).toBeNull();
    expect(editor.history()).toHaveLength(0);
  });
});

describe('ScriptRuntime.loadPlugin', () => {
  const pluginSource = `
    defineCommand({
      name: 'draw_border',
      description: 'Draws a rectangular border.',
      params: {
        color: { type: 'color', required: true },
        inset: { type: 'int', default: 0, min: 0 },
      },
      run(api, p) {
        api.exec('draw_rect', {
          layer: 0,
          frame: 0,
          rect: { x: p.inset, y: p.inset, w: 8 - p.inset * 2, h: 8 - p.inset * 2 },
          color: p.color,
          fill: false,
        });
        api.log('drew border with', p.color);
        return { inset: p.inset };
      },
    });
  `;

  it('registers the commands a plugin defines', () => {
    const registry = createMutableRegistry(allCommands);
    const runtime = new ScriptRuntime();
    const outcome = runtime.loadPlugin(pluginSource, { name: 'borders', registry });
    expect(outcome.ok).toBe(true);
    expect(outcome.commands).toEqual(['draw_border']);
    expect(registry.has('draw_border')).toBe(true);
  });

  it('runs a plugin command against the caller draft as one undo step', () => {
    const registry = createMutableRegistry(allCommands);
    const editor = createEditor(
      createSprite({
        width: 8,
        height: 8,
        layers: ['base'],
        palette: createPalette('test', ['#ff0000']),
      }),
      registry,
    );
    const runtime = new ScriptRuntime();
    const loaded = runtime.loadPlugin(pluginSource, { name: 'borders', registry });
    expect(loaded.ok).toBe(true);

    const summary = editor.execute('draw_border', { color: 'pal:0' });
    expect(summary).toEqual({ inset: 0 });
    expect(pixel(editor, 0, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(pixel(editor, 4, 4)?.a ?? 0).toBe(0);
    expect(editor.history()).toHaveLength(1);
  });

  it('validates plugin parameters through the generated schema', () => {
    const registry = createMutableRegistry(allCommands);
    const editor = createEditor(
      createSprite({ width: 8, height: 8, layers: ['base'], palette: createPalette('t', ['#ff0000']) }),
      registry,
    );
    const runtime = new ScriptRuntime();
    runtime.loadPlugin(pluginSource, { name: 'borders', registry });

    const bad = editor.tryExecute('draw_border', {});
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('invalid_params');

    const negative = editor.tryExecute('draw_border', { color: '#ff0000', inset: -3 });
    expect(negative.ok).toBe(false);
  });

  it('rejects a plugin that collides with an existing command', () => {
    const registry = createMutableRegistry(allCommands);
    const runtime = new ScriptRuntime();
    const outcome = runtime.loadPlugin(
      `defineCommand({ name: 'draw_rect', run() { return null; } });`,
      { name: 'collide', registry },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('already exists');
    expect(registry.get('draw_rect')).toBe(allCommands.find((c) => c.name === 'draw_rect'));
  });

  it('reports a plugin load error and registers nothing', () => {
    const registry = createMutableRegistry(allCommands);
    const runtime = new ScriptRuntime();
    const outcome = runtime.loadPlugin(`throw new Error('bad plugin');`, { name: 'bad', registry });
    expect(outcome.ok).toBe(false);
    expect(outcome.commands).toEqual([]);
    expect(outcome.error).toContain('bad plugin');
  });
});
