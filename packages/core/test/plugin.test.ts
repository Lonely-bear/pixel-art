import { describe, expect, it } from 'vitest';
import { createSprite } from '../src/document.js';
import { Draft } from '../src/draft.js';
import { createEditor } from '../src/index.js';
import { createMutableRegistry, applyCommandToDraft } from '../src/bus.js';
import { allCommands } from '../src/commands/index.js';
import {
  buildParamsSchema,
  createPluginCommand,
  PLUGIN_COMMAND_NAME,
} from '../src/commands/plugin.js';

describe('buildParamsSchema', () => {
  it('turns the declarative spec into a validating, strict schema', () => {
    const schema = buildParamsSchema({
      cx: { type: 'number', required: true },
      points: { type: 'int', default: 5, min: 3, max: 16 },
      color: { type: 'color', required: true },
      layer: { type: 'layer' },
      label: { type: 'string', values: ['a', 'b'] },
    });

    const parsed = schema.parse({ cx: 1.5, color: '#ff0000', label: 'a' }) as Record<string, unknown>;
    expect(parsed.cx).toBe(1.5);
    expect(parsed.points).toBe(5); // default applied
    expect(parsed.layer).toBeUndefined();

    expect(() => schema.parse({ cx: 1, color: '#f00', nope: 1 })).toThrow(); // strict
    expect(() => schema.parse({ color: '#f00' })).toThrow(); // missing required
    expect(() => schema.parse({ cx: 1, color: '#f00', points: 2 })).toThrow(); // below min
    expect(() => schema.parse({ cx: 1, color: '#f00', label: 'c' })).toThrow(); // not in enum
    expect(() => schema.parse({ cx: 1, color: '#f00', points: 4.5 })).toThrow(); // int
  });

  it('rejects an unknown parameter type', () => {
    expect(() => buildParamsSchema({ x: { type: 'nope' as never } })).toThrow(
      /Unknown plugin parameter type/,
    );
  });
});

describe('createPluginCommand', () => {
  it('rejects names that are not lowercase snake case', () => {
    expect(PLUGIN_COMMAND_NAME.test('draw_star')).toBe(true);
    expect(PLUGIN_COMMAND_NAME.test('DrawStar')).toBe(false);
    expect(() => createPluginCommand({ name: 'DrawStar' }, () => {})).toThrow(
      /Invalid plugin command name/,
    );
  });

  it('rejects a non-boolean readOnly declaration', () => {
    expect(() =>
      createPluginCommand({ name: 'bad_read_only', readOnly: 'false' as never }, () => {}),
    ).toThrow(/non-boolean readOnly/);
  });

  it('is indistinguishable from a built-in command to the editor', () => {
    const command = createPluginCommand(
      { name: 'draw_dot', description: 'One pixel', params: { x: { type: 'int', required: true } } },
      (ctx, params) => {
        ctx.draft
          .cel(ctx.sprite.layers[0].id, ctx.sprite.frames[0].id)
          .setColor(params.x as number, 0, { r: 1, g: 2, b: 3, a: 255 });
        return { drew: 1 };
      },
    );

    const editor = createEditor(
      createSprite({ width: 4, height: 4, name: 'Plugin' }),
      createMutableRegistry([...allCommands, command]),
    );
    const summary = editor.execute('draw_dot', { x: 2 });
    expect(summary).toEqual({ drew: 1 });
    expect(
      editor.sprite.frames[0].cels.get(editor.sprite.layers[0].id)?.getColor(2, 0),
    ).toEqual({ r: 1, g: 2, b: 3, a: 255 });
    // Unknown parameters are still rejected by the generated schema.
    expect(() => editor.execute('draw_dot', { x: 2, y: 1 })).toThrow(/Invalid parameters/);
  });
});

describe('applyCommandToDraft', () => {
  it('applies to an existing draft, with the same error codes as the bus', () => {
    const registry = createMutableRegistry(allCommands);
    const editor = createEditor(createSprite({ width: 4, height: 1, name: 'P' }), registry);
    const draft = new Draft(editor.sprite);

    applyCommandToDraft(draft, registry, 'draw_pixels', {
      layer: 0,
      frame: 0,
      pixels: [{ x: 0, y: 0, color: '#ff0000' }],
    });
    expect(
      draft.sprite.frames[0].cels.get(draft.sprite.layers[0].id)?.getColor(0, 0),
    ).toEqual({ r: 255, g: 0, b: 0, a: 255 });

    expect(() => applyCommandToDraft(draft, registry, 'nope', {})).toThrow(/Unknown command/);
    expect(() =>
      applyCommandToDraft(draft, registry, 'draw_pixels', { layer: 0, frame: 0 }),
    ).toThrow(/Invalid parameters/);
    // Draft-level application never touches the editor's own history.
    expect(editor.canUndo()).toBe(false);
  });

  it('folds a plugin expansion into a single undo entry', () => {
    const registry = createMutableRegistry(allCommands);
    const pair = createPluginCommand({ name: 'draw_pair' }, (ctx) => {
      applyCommandToDraft(ctx.draft, registry, 'draw_pixels', {
        layer: 0,
        frame: 0,
        pixels: [{ x: 0, y: 0, color: '#ff0000' }],
      });
      applyCommandToDraft(ctx.draft, registry, 'draw_pixels', {
        layer: 0,
        frame: 0,
        pixels: [{ x: 1, y: 0, color: '#00ff00' }],
      });
      return { drew: 2 };
    });
    registry.register(pair);

    const editor = createEditor(createSprite({ width: 4, height: 1, name: 'P' }), registry);
    expect(editor.execute('draw_pair', {})).toEqual({ drew: 2 });
    const cel = editor.sprite.frames[0].cels.get(editor.sprite.layers[0].id)!;
    expect(cel.getColor(0, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(cel.getColor(1, 0)).toEqual({ r: 0, g: 255, b: 0, a: 255 });

    editor.undo();
    expect(editor.canUndo()).toBe(false);
    expect(editor.sprite.frames[0].cels.get(editor.sprite.layers[0].id)).toBeUndefined();
  });
});

describe('createMutableRegistry', () => {
  it('grows and shrinks at runtime and refuses duplicates', () => {
    const registry = createMutableRegistry(allCommands);
    expect(registry.has('draw_pixels')).toBe(true);

    const command = createPluginCommand({ name: 'noop_plugin' }, () => ({ ok: true }));
    registry.register(command);
    expect(registry.has('noop_plugin')).toBe(true);
    expect(registry.names()).toContain('noop_plugin');

    expect(() => registry.register(command)).toThrow(/Duplicate command name/);
    expect(registry.unregister('noop_plugin')).toBe(true);
    expect(registry.unregister('noop_plugin')).toBe(false);
    expect(registry.has('noop_plugin')).toBe(false);
  });
});
