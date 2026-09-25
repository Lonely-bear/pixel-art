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

  it('does not snap ramp anchors to existing swatches when the palette is locked', () => {
    const editor = createEditor(
      createSprite({
        width: 4,
        height: 4,
        palette: createPalette('locked', ['#000000', '#ffffff']),
        paletteLocked: true,
      }),
    );
    const role = editor.execute('ensure_palette_role', {
      role: 'skin',
      from: '#8b4a2b',
      to: '#f0c090',
      steps: 4,
    });
    // Locked-palette snapping used to collapse this ramp onto #000000/#ffffff and then
    // tag both of those unrelated swatches as "skin".
    expect(role.added.length).toBeGreaterThan(0);
    const roles = editor.sprite.palette.roles ?? {};
    for (const [index, name] of Object.entries(roles)) {
      const color = editor.sprite.palette.colors[Number(index)];
      const isGreyscale = color.r === color.g && color.g === color.b;
      if (isGreyscale) {
        // The only greyscale entries allowed are ones we actually asked for.
        expect(name).toBe('skin');
      }
    }
    const skinIndices = Object.values(roles).filter((name) => name === 'skin');
    expect(skinIndices).toHaveLength(4);
  });

  it('ensures semantic roles and remaps them when palette slots are pruned', () => {
    const editor = makeEditor();
    const role = editor.execute('ensure_palette_role', {
      role: 'skin',
      colors: ['#ff0000', '#00ff00', '#123456'],
    });
    expect(role.indices).toEqual([0, 1, 4]);
    expect(editor.sprite.palette.roles).toMatchObject({ '0': 'skin', '1': 'skin', '4': 'skin' });

    editor.execute('prune_palette', { keep: [0, 1, 4], dryRun: false });
    expect(editor.sprite.palette.roles).toMatchObject({ '0': 'skin', '1': 'skin', '2': 'skin' });
  });

  it('replaces a colour across every frame and restricted layer', () => {
    const editor = makeEditor();
    editor.execute('draw_pixels', { layer: 'base', frame: 0, pixels: [{ x: 0, y: 0, color: '#ff0000' }] });
    editor.execute('draw_pixels', { layer: 'base', frame: 1, pixels: [{ x: 1, y: 1, color: '#ff0000' }] });
    editor.execute('draw_pixels', { layer: 'hidden detail', frame: 1, pixels: [{ x: 2, y: 2, color: '#ff0000' }] });
    const result = editor.execute('replace_colors', { from: '#ff0000', to: '#123456', frames: 'all', layer: 'base' });
    expect(result).toMatchObject({ painted: 2, cels: 2, frameCount: 2 });
    const baseId = editor.sprite.layers.find((layer) => layer.name === 'base')!.id;
    const detailId = editor.sprite.layers.find((layer) => layer.name === 'hidden detail')!.id;
    expect(editor.sprite.frames[0].cels.get(baseId)!.getColor(0, 0)).toEqual({ r: 18, g: 52, b: 86, a: 255 });
    expect(editor.sprite.frames[1].cels.get(detailId)!.getColor(2, 2)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
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
