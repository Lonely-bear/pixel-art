import { describe, expect, it } from 'vitest';
import { createEditor, createSprite } from '../src/index.js';

function makeEditor() {
  return createEditor(createSprite({ width: 8, height: 8, layers: ['base'], frames: 6 }));
}

describe('set_frame_durations', () => {
  it('updates all, ranged, explicit, and tag-selected frames in one undo step', () => {
    const editor = makeEditor();
    const first = editor.execute('set_frame_durations', {
      updates: [
        { frames: { from: 0, to: 2 }, durationMs: 140 },
        { frames: [3, 4, 5], durationMs: 80 },
      ],
    });
    expect(first.changed).toBe(6);
    expect(editor.sprite.frames.map((frame) => frame.durationMs)).toEqual([140, 140, 140, 80, 80, 80]);
    expect(editor.history()).toHaveLength(1);

    editor.undo();
    expect(editor.sprite.frames.every((frame) => frame.durationMs === 100)).toBe(true);
    expect(editor.canUndo()).toBe(false);

    editor.execute('add_tag', { name: 'attack', from: 3, to: 5 });
    const tagged = editor.execute('set_frame_durations', {
      updates: [{ tag: 'attack', durationMs: 55 }],
    });
    expect(tagged.totalDurationMs).toBe(100 * 3 + 55 * 3);
  });

  it('rejects an invalid range without partially changing durations', () => {
    const editor = makeEditor();
    const result = editor.tryExecute('set_frame_durations', {
      updates: [
        { frames: { from: 0, to: 1 }, durationMs: 50 },
        { frames: { from: 4, to: 9 }, durationMs: 20 },
      ],
    });
    expect(result.ok).toBe(false);
    expect(editor.sprite.frames.every((frame) => frame.durationMs === 100)).toBe(true);
    expect(editor.history()).toHaveLength(0);
  });
});

describe('upsert_tags', () => {
  it('creates and updates multiple tags atomically', () => {
    const editor = makeEditor();
    const result = editor.execute('upsert_tags', {
      tags: [
        { name: 'idle', from: 0, to: 2, direction: 'pingpong' },
        { name: 'attack', from: 3, to: 5, direction: 'forward', repeat: 2 },
      ],
    });
    expect(result).toMatchObject({ created: expect.arrayContaining([expect.objectContaining({ name: 'idle' })]), tagCount: 2 });

    const updated = editor.execute('upsert_tags', {
      tags: [{ tag: 'idle', name: 'breathe', repeat: 3 }],
    });
    expect(updated).toMatchObject({ updated: [expect.objectContaining({ tagId: expect.any(String), name: 'breathe', repeat: 3 })] });
    expect(editor.sprite.tags.find((tag) => tag.name === 'breathe')?.direction).toBe('pingpong');
  });

  it('rejects duplicate final names before creating any tag', () => {
    const editor = makeEditor();
    editor.execute('add_tag', { name: 'idle', from: 0, to: 1 });
    const result = editor.tryExecute('upsert_tags', {
      tags: [
        { name: 'attack', from: 2, to: 3 },
        { name: 'idle', from: 4, to: 5 },
      ],
    });
    expect(result.ok).toBe(false);
    expect(editor.sprite.tags.map((tag) => tag.name)).toEqual(['idle']);
    expect(editor.history()).toHaveLength(1);
  });
});
