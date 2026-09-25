import { describe, expect, it } from 'vitest';
import { PixelBuffer } from '../src/buffer.js';
import { createSprite } from '../src/document.js';
import { CommandError, createEditor, createRegistry, describeCommands } from '../src/index.js';
import type { Command } from '../src/commands/types.js';
import { z } from 'zod';

const makeSprite = () => createSprite({ width: 8, height: 8, name: 'Test' });

const redRect = {
  layer: 0,
  frame: 0,
  rect: { x: 0, y: 0, w: 2, h: 2 },
  color: '#ff0000',
  fill: true,
};

describe('command bus', () => {
  it('applies a command and bumps the version', () => {
    const editor = createEditor(makeSprite());
    expect(editor.version).toBe(1);
    const summary = editor.execute('draw_rect', redRect);
    expect(summary.painted).toBe(4);
    expect(editor.version).toBe(2);
    const cel = editor.sprite.frames[0].cels.get(editor.sprite.layers[0].id);
    expect(cel?.getColor(0, 0).r).toBe(255);
  });

  it('restores the previous pixels on undo', () => {
    const editor = createEditor(makeSprite());
    editor.execute('draw_rect', redRect);
    expect(editor.canUndo()).toBe(true);
    editor.undo();
    const cel = editor.sprite.frames[0].cels.get(editor.sprite.layers[0].id);
    expect(cel?.isEmpty() ?? true).toBe(true);
    expect(editor.canUndo()).toBe(false);
    expect(editor.canRedo()).toBe(true);
  });

  it('replays the edit on redo', () => {
    const editor = createEditor(makeSprite());
    editor.execute('draw_rect', redRect);
    editor.undo();
    editor.redo();
    const cel = editor.sprite.frames[0].cels.get(editor.sprite.layers[0].id);
    expect(cel?.getColor(0, 0).r).toBe(255);
  });

  it('bumps the version on undo and redo too', () => {
    const editor = createEditor(makeSprite());
    editor.execute('draw_rect', redRect);
    editor.undo();
    expect(editor.version).toBe(3);
    editor.redo();
    expect(editor.version).toBe(4);
  });

  it('drops the redo stack once a new edit lands', () => {
    const editor = createEditor(makeSprite());
    editor.execute('draw_rect', redRect);
    editor.undo();
    editor.execute('draw_rect', { ...redRect, color: '#0000ff' });
    expect(editor.canRedo()).toBe(false);
  });

  it('does not leak pixel writes across frames', () => {
    const editor = createEditor(makeSprite());
    editor.execute('add_frame', {});
    editor.execute('draw_rect', redRect);

    const layerId = editor.sprite.layers[0].id;
    const frame0 = editor.sprite.frames[0].cels.get(layerId);
    const frame1 = editor.sprite.frames[1].cels.get(layerId);
    expect(frame0?.getColor(0, 0).r).toBe(255);
    expect(frame1?.isEmpty() ?? true).toBe(true);
  });

  it('does not leak pixel writes across layers', () => {
    const editor = createEditor(makeSprite());
    editor.execute('add_layer', { name: 'Ink' });
    editor.execute('draw_rect', { ...redRect, layer: 'Ink' });

    const [bottom, top] = editor.sprite.layers;
    expect(bottom.name).toBe('Layer 1');
    expect(top.name).toBe('Ink');
    expect(editor.sprite.frames[0].cels.get(bottom.id)?.isEmpty() ?? true).toBe(true);
    expect(editor.sprite.frames[0].cels.get(top.id)?.getColor(0, 0).r).toBe(255);
  });

  it('keeps the undo snapshot isolated from later edits', () => {
    const editor = createEditor(makeSprite());
    editor.execute('draw_rect', redRect);
    const celAfter = editor.sprite.frames[0].cels.get(editor.sprite.layers[0].id);
    editor.execute('clear_region', { layer: 0, frame: 0 });
    // The buffer the first edit produced is untouched by the second edit.
    expect(celAfter?.getColor(0, 0).r).toBe(255);
    editor.undo();
    const restored = editor.sprite.frames[0].cels.get(editor.sprite.layers[0].id);
    expect(restored?.getColor(0, 0).r).toBe(255);
  });

  it('reports unknown_command, invalid_params and command_failed distinctly', () => {
    const editor = createEditor(makeSprite());

    const unknown = editor.tryExecute('nope');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe('unknown_command');

    const invalid = editor.tryExecute('draw_rect', { layer: 0, frame: 0 });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.code).toBe('invalid_params');

    const boom: Command = {
      name: 'explode',
      description: 'always throws',
      params: z.object({}),
      apply() {
        throw new Error('kaboom');
      },
    };
    const failing = createEditor(makeSprite(), createRegistry([...registryWith(boom)]));
    const failed = failing.tryExecute('explode', {});
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.code).toBe('command_failed');
      expect(failed.error).toContain('kaboom');
    }
  });

  it('throws a CommandError from execute for a bad command', () => {
    const editor = createEditor(makeSprite());
    expect(() => editor.execute('nope')).toThrow(CommandError);
  });

  it('truncates history to the configured limit', () => {
    const editor = createEditor(makeSprite());
    for (let i = 0; i < 5; i++) editor.execute('draw_rect', redRect, { historyLimit: 3 });
    expect(editor.history().length).toBe(3);
  });

  it('rejects a duplicate command name when building a registry', () => {
    const cmd: Command = {
      name: 'dup',
      description: 'x',
      params: z.object({}),
      apply: () => ({}),
    };
    expect(() => createRegistry([cmd, cmd])).toThrow(/Duplicate command name/);
  });

  it('snapshots without sharing buffers', () => {
    const editor = createEditor(makeSprite());
    editor.execute('draw_rect', redRect);
    const snap = editor.snapshot();
    const cel = snap.frames[0].cels.get(snap.layers[0].id);
    expect(cel).toBeInstanceOf(PixelBuffer);
    expect(cel).not.toBe(editor.sprite.frames[0].cels.get(editor.sprite.layers[0].id));
    expect(cel?.getColor(0, 0).r).toBe(255);
  });

  it('accepts a matching expectedVersion and rejects a stale one', () => {
    const editor = createEditor(makeSprite());
    expect(editor.version).toBe(1);

    editor.execute('draw_rect', redRect, { expectedVersion: 1 });
    expect(editor.version).toBe(2);

    const stale = editor.tryExecute('draw_rect', redRect, { expectedVersion: 1 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.code).toBe('version_conflict');
      expect(stale.error).toMatch(/expected version 1/);
    }
    // The rejected write left the document untouched.
    expect(editor.version).toBe(2);
    expect(editor.history().length).toBe(1);

    // Omitting expectedVersion stays permissive.
    editor.execute('draw_rect', redRect);
    expect(editor.version).toBe(3);
  });

  it('reports an empty cel from read-only commands instead of throwing', () => {
    const editor = createEditor(makeSprite());

    // A cel that has never been painted does not exist yet. Read-only commands
    // must report "nothing here" rather than failing.
    expect(editor.execute('measure_region', { layer: 0, frame: 0 })).toEqual({
      opaque: 0,
      bounds: null,
      empty: true,
      scope: 'cel',
    });

    expect(
      editor.execute('copy_region', {
        from: { layer: 0, frame: 0, rect: { x: 0, y: 0, w: 4, h: 4 } },
        to: { layer: 0, frame: 0, x: 2, y: 2 },
      }),
    ).toEqual({ copied: 0, reason: 'source cel is empty' });

    // And the same calls still work once there is something to measure.
    editor.execute('draw_rect', redRect);
    expect(editor.execute('measure_region', { layer: 0, frame: 0 })).toEqual({
      opaque: 4,
      bounds: { x: 0, y: 0, w: 2, h: 2 },
      empty: false,
      scope: 'cel',
    });
  });

  it('does not let read-only commands clobber the redo stack', () => {
    const editor = createEditor(makeSprite());
    editor.execute('draw_rect', redRect);
    editor.undo();
    expect(editor.canRedo()).toBe(true);

    // Asking a question is not an edit: it must not bump the version, push an undo
    // entry, or throw away the redo stack.
    const version = editor.version;
    expect(editor.execute('measure_region', { layer: 0, frame: 0 }).opaque).toBe(0);
    expect(editor.version).toBe(version);
    expect(editor.canRedo()).toBe(true);

    editor.redo();
    expect(editor.execute('measure_region', { layer: 0, frame: 0 }).opaque).toBe(4);
  });

  it('rejects an unknown parameter instead of silently ignoring it', () => {
    const editor = createEditor(makeSprite());

    // A mistyped parameter used to fall back to its default and report success,
    // which is how an agent asking to `undo {count: 5}` silently undid one edit.
    const result = editor.tryExecute('draw_rect', { ...redRect, fill2: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('invalid_params');
      expect(result.error).toMatch(/unrecognized key/i);
    }

    // And the published schema says so too, so the contract is visible to clients.
    const schema = describeCommands(editor.registry.list()).find((c) => c.name === 'draw_rect');
    expect(schema?.params.additionalProperties).toBe(false);
  });
});

describe('editor.transaction', () => {
  it('collapses every command in the callback into one undo step', () => {
    const editor = createEditor(makeSprite());
    const summary = editor.transaction('script', () => {
      editor.execute('draw_rect', redRect);
      editor.execute('draw_rect', { ...redRect, rect: { x: 4, y: 4, w: 2, h: 2 } });
      editor.execute('draw_rect', { ...redRect, rect: { x: 6, y: 6, w: 2, h: 2 } });
      return 'done';
    });

    expect(summary).toBe('done');
    expect(editor.history()).toHaveLength(1);
    expect(editor.history()[0].command).toBe('transaction');
    expect(editor.history()[0].label).toBe('script');

    editor.undo();
    expect(editor.canUndo()).toBe(false);
    const cel = editor.sprite.frames[0].cels.get(editor.sprite.layers[0].id);
    expect(cel?.getColor(0, 0).a ?? 0).toBe(0);
  });

  it('rolls back and rethrows when the callback throws', () => {
    const editor = createEditor(makeSprite());
    expect(() =>
      editor.transaction('script', () => {
        editor.execute('draw_rect', redRect);
        throw new Error('halfway');
      }),
    ).toThrow('halfway');

    expect(editor.history()).toHaveLength(0);
    expect(editor.canUndo()).toBe(false);
    const cel = editor.sprite.frames[0].cels.get(editor.sprite.layers[0].id);
    expect(cel?.getColor(0, 0).a ?? 0).toBe(0);
  });

  it('leaves history and the redo stack alone when nothing changes', () => {
    const editor = createEditor(makeSprite());
    editor.execute('draw_rect', redRect);
    editor.undo();
    expect(editor.canRedo()).toBe(true);

    editor.transaction('read-only', () => 42);

    expect(editor.history()).toHaveLength(0);
    expect(editor.canRedo()).toBe(true);
  });

  it('runAtomic restores version and redo exactly when work throws', () => {
    const editor = createEditor(makeSprite());
    editor.execute('draw_rect', redRect);
    editor.undo();
    const version = editor.version;
    expect(editor.canRedo()).toBe(true);

    expect(() =>
      editor.runAtomic(() => {
        editor.execute('draw_rect', redRect);
        editor.execute('draw_rect', { ...redRect, rect: { x: 4, y: 4, w: 2, h: 2 } });
        throw new Error('batch failed');
      }),
    ).toThrow('batch failed');

    expect(editor.version).toBe(version);
    expect(editor.history()).toHaveLength(0);
    expect(editor.canRedo()).toBe(true);
    expect(editor.execute('measure_region', { layer: 0, frame: 0 }).opaque).toBe(0);
  });

  it('runAtomic restores existing pixels for multi-cel commands', () => {
    const editor = createEditor(makeSprite());
    editor.execute('draw_rect', redRect);

    expect(() =>
      editor.runAtomic(() => {
        editor.execute('clear_all', {});
        throw new Error('clear then fail');
      }),
    ).toThrow('clear then fail');

    expect(editor.execute('measure_region', { layer: 0, frame: 0 }).opaque).toBe(4);
    expect(editor.history()).toHaveLength(1);
    expect(editor.history()[0].command).toBe('draw_rect');
  });

  it('runAtomic keeps normal per-command history on success', () => {
    const editor = createEditor(makeSprite());
    editor.runAtomic(() => {
      editor.execute('draw_rect', redRect);
      editor.execute('draw_rect', { ...redRect, rect: { x: 4, y: 4, w: 2, h: 2 } });
    });

    expect(editor.history()).toHaveLength(2);
    expect(editor.history().map((entry) => entry.command)).toEqual(['draw_rect', 'draw_rect']);
  });

  it('discards the redo stack once it records a step', () => {
    const editor = createEditor(makeSprite());
    editor.execute('draw_rect', redRect);
    editor.undo();
    expect(editor.canRedo()).toBe(true);

    editor.transaction('script', () => {
      editor.execute('draw_rect', { ...redRect, rect: { x: 4, y: 4, w: 2, h: 2 } });
    });

    expect(editor.canRedo()).toBe(false);
    expect(editor.history()).toHaveLength(1);
  });
});

function registryWith(extra: Command) {
  // Reuse the default registry contents plus the extra command.
  const editor = createEditor(makeSprite());
  return [...editor.registry.list(), extra];
}
