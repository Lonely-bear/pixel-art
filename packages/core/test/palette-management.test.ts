import { describe, expect, it } from 'vitest';
import { createEditor, createPalette, createSprite } from '../src/index.js';

function makeEditor() {
  return createEditor(
    createSprite({
      width: 4,
      height: 4,
      layers: ['base', 'hidden detail'],
      frames: 2,
      palette: createPalette('prune', ['#ff0000', '#00ff00', '#0000ff', '#ffffff']),
    }),
  );
}

describe('prune_palette', () => {
  it('dry-runs safely, then removes colours unused across every raw cel', () => {
    const editor = makeEditor();
    editor.execute('draw_pixels', { layer: 'base', frame: 0, pixels: [{ x: 0, y: 0, color: '#ff0000' }] });
    editor.execute('draw_pixels', { layer: 'base', frame: 1, pixels: [{ x: 1, y: 1, color: '#00ff00' }] });
    editor.execute('draw_pixels', { layer: 'hidden detail', frame: 0, pixels: [{ x: 2, y: 2, color: '#0000ff' }] });
    editor.execute('update_layer', { layer: 'hidden detail', visible: false });

    const dry = editor.execute('prune_palette', {});
    expect(dry).toMatchObject({
      dryRun: true,
      inspectedFrames: 2,
      usedColors: 3,
      removed: [{ index: 3, color: '#ffffffff' }],
      removedCount: 1,
      remaining: 3,
      paletteSize: 4,
    });
    expect(editor.sprite.palette.colors).toHaveLength(4);

    const committed = editor.execute('prune_palette', { dryRun: false });
    expect(committed).toMatchObject({ dryRun: false, removedCount: 1, paletteSize: 3 });
    expect(editor.sprite.palette.colors.map((color) => `${color.r},${color.g},${color.b}`)).toEqual([
      '255,0,0',
      '0,255,0',
      '0,0,255',
    ]);
    expect(committed.indexMap).toEqual({ '0': 0, '1': 1, '2': 2, '3': null });
  });

  it('can inspect one tag range and protects explicit keep indices', () => {
    const editor = makeEditor();
    editor.execute('draw_pixels', { layer: 'base', frame: 0, pixels: [{ x: 0, y: 0, color: '#ff0000' }] });
    editor.execute('add_tag', { name: 'intro', from: 0, to: 0 });

    const result = editor.execute('prune_palette', {
      scope: 'tag',
      tag: 'intro',
      keep: [1],
      dryRun: false,
    });
    expect(result.removedCount).toBe(2);
    expect(result.paletteSize).toBe(2);
    expect(editor.sprite.palette.colors).toHaveLength(2);
  });
});
