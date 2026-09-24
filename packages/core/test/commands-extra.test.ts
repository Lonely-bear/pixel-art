import { describe, expect, it } from 'vitest';
import {
  createEditor,
  createPalette,
  createSprite,
  deserializeSprite,
  serializeSprite,
  type PixelBuffer,
} from '../src/index.js';

/**
 * Agent-ergonomics additions to the command surface:
 * named-layer clips, `replace`, palette locking, line width, and readable
 * parameter-validation errors.
 */

function celOf(editor: ReturnType<typeof createEditor>, layerIndex = 0, frameIndex = 0): PixelBuffer {
  const layerId = editor.sprite.layers[layerIndex].id;
  const frame = editor.sprite.frames[frameIndex];
  const cel = frame.cels.get(layerId);
  if (!cel) throw new Error('cel is empty');
  return cel;
}

const F = 0;

describe('named-layer clip', () => {
  function makeEditor() {
    return createEditor(
      createSprite({ width: 16, height: 16, name: 'Clip', layers: ['base', 'hair', 'shade'] }),
    );
  }

  it('clips to a single named layer', () => {
    const editor = makeEditor();
    editor.execute('draw_rect', { layer: 'hair', frame: F, rect: { x: 2, y: 2, w: 4, h: 4 }, color: '#ffffff', fill: true });

    const result = editor.execute('draw_rect', {
      layer: 'shade',
      frame: F,
      rect: { x: 0, y: 0, w: 16, h: 16 },
      color: '#000000',
      fill: true,
      clip: { layer: 'hair' },
    }) as { painted: number };

    expect(result.painted).toBe(16);
  });

  it('clips to the union of several named layers', () => {
    const editor = makeEditor();
    editor.execute('draw_rect', { layer: 'base', frame: F, rect: { x: 0, y: 0, w: 4, h: 4 }, color: '#ffffff', fill: true });
    editor.execute('draw_rect', { layer: 'hair', frame: F, rect: { x: 10, y: 10, w: 4, h: 4 }, color: '#ffffff', fill: true });

    const result = editor.execute('draw_rect', {
      layer: 'shade',
      frame: F,
      rect: { x: 0, y: 0, w: 16, h: 16 },
      color: '#000000',
      fill: true,
      clip: { layers: ['base', 'hair'] },
    }) as { painted: number };

    expect(result.painted).toBe(32);
  });
});

describe('replace', () => {
  it('erases the pixels the shape covers before drawing', () => {
    const editor = createEditor(createSprite({ width: 16, height: 16, name: 'Replace' }));
    editor.execute('draw_rect', { layer: 0, frame: F, rect: { x: 0, y: 0, w: 8, h: 8 }, color: '#ff0000', fill: true });

    const result = editor.execute('draw_ellipse', {
      layer: 0,
      frame: F,
      rect: { x: 0, y: 0, w: 8, h: 8 },
      color: '#0000ff',
      fill: true,
      replace: true,
    }) as { painted: number; replaced: number };

    // The erase pass covers exactly the pixels the ellipse paints.
    expect(result.replaced).toBe(result.painted);
    expect(result.replaced).toBeGreaterThan(0);

    const buf = celOf(editor);
    // The centre is the new colour, and a pixel the ellipse never covers is untouched —
    // `replace` clears the shape's own footprint, not its bounding box.
    expect(buf.getColor(3, 3)).toMatchObject({ r: 0, g: 0, b: 255, a: 255 });
    expect(buf.getColor(0, 0)).toMatchObject({ r: 255, g: 0, b: 0, a: 255 });
  });

  it('clears then stipples for a dithered replace', () => {
    const editor = createEditor(createSprite({ width: 8, height: 8, name: 'Replace' }));
    editor.execute('draw_rect', { layer: 0, frame: F, rect: { x: 0, y: 0, w: 8, h: 8 }, color: '#ff0000', fill: true });

    const result = editor.execute('dither_fill', {
      layer: 0,
      frame: F,
      rect: { x: 0, y: 0, w: 8, h: 8 },
      color: '#00ff00',
      pattern: 'checker',
      level: 0.5,
      replace: true,
    }) as { painted: number; replaced: number };

    expect(result.replaced).toBe(64);
    const buf = celOf(editor);
    // Half the 8x8 box is painted, the other half is now transparent (not red).
    let opaque = 0;
    let red = 0;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const c = buf.getColor(x, y);
        if (c.a > 0) opaque++;
        if (c.r > 200 && c.g < 60) red++;
      }
    }
    expect(opaque).toBe(32);
    expect(red).toBe(0);
  });
});

describe('palette lock', () => {
  const bw = () => createPalette('bw', ['#000000', '#ffffff']);

  it('snaps an off-palette colour to the nearest swatch', () => {
    const editor = createEditor(
      createSprite({ width: 4, height: 4, name: 'Locked', palette: bw(), paletteLocked: true }),
    );
    editor.execute('draw_pixels', { layer: 0, frame: F, pixels: [{ x: 0, y: 0, color: '#ff0000' }] });
    // Red is nearer black than white.
    expect(celOf(editor).getColor(0, 0)).toMatchObject({ r: 0, g: 0, b: 0, a: 255 });
  });

  it('keeps the requested alpha so translucent paint still works', () => {
    const editor = createEditor(
      createSprite({ width: 4, height: 4, name: 'Locked', palette: bw(), paletteLocked: true }),
    );
    editor.execute('draw_pixels', {
      layer: 0,
      frame: F,
      pixels: [{ x: 1, y: 1, color: { r: 255, g: 0, b: 0, a: 128 } }],
    });
    const c = celOf(editor).getColor(1, 1);
    expect(c.a).toBe(128);
    expect(c).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it('round-trips the flag through a .pixel file', () => {
    const sprite = createSprite({ width: 4, height: 4, name: 'Locked', paletteLocked: true });
    expect(deserializeSprite(serializeSprite(sprite)).paletteLocked).toBe(true);
  });
});

describe('line width', () => {
  it('stamps a thicker stroke', () => {
    const editor = createEditor(createSprite({ width: 16, height: 16, name: 'Line' }));
    const result = editor.execute('draw_line', {
      layer: 0,
      frame: F,
      from: { x: 2, y: 2 },
      to: { x: 12, y: 2 },
      color: '#ffffff',
      width: 3,
    }) as { painted: number; width: number };

    expect(result.width).toBe(3);
    // 11 steps, each a 3x3 square; de-duplicated to a 13x3 band.
    expect(result.painted).toBe(39);
    const buf = celOf(editor);
    expect(buf.getColor(2, 1).a).toBe(255);
    expect(buf.getColor(2, 3).a).toBe(255);
    expect(buf.getColor(2, 0).a).toBe(0);
  });

  it('does not double-blend a translucent stroke where it overlaps itself', () => {
    const editor = createEditor(createSprite({ width: 16, height: 16, name: 'Line' }));
    editor.execute('draw_line', {
      layer: 0,
      frame: F,
      from: { x: 2, y: 2 },
      to: { x: 12, y: 2 },
      color: { r: 255, g: 255, b: 255, a: 255 },
      width: 3,
      opacity: 0.5,
    });
    // One 50% write is ~128, not the ~191 a second blend would give.
    const alpha = celOf(editor).getColor(7, 2).a;
    expect(alpha).toBeGreaterThan(120);
    expect(alpha).toBeLessThan(136);
  });
});

describe('readable validation errors', () => {
  it('names the offending path instead of dumping the zod union', () => {
    const editor = createEditor(createSprite({ width: 4, height: 4, name: 'Errors' }));
    expect(() =>
      editor.execute('draw_pixels', { layer: 0, frame: F, pixels: [{ x: 0, y: 0 }] }),
    ).toThrow(/pixels\.0\.color/);
  });

  it('reports an unknown top-level parameter by name', () => {
    const editor = createEditor(createSprite({ width: 4, height: 4, name: 'Errors' }));
    expect(() =>
      editor.execute('draw_pixels', {
        layer: 0,
        frame: F,
        pixels: [{ x: 0, y: 0, color: '#ffffff' }],
        color: '#ff0000',
      }),
    ).toThrow(/Unrecognized key/);
  });
});

describe('clip occlusion warning', () => {
  function makeEditor() {
    return createEditor(
      createSprite({ width: 16, height: 16, name: 'Warn', layers: ['base', 'hair', 'shade'] }),
    );
  }

  it('warns when the clip layer renders above the painted layer', () => {
    const editor = makeEditor();
    editor.execute('draw_rect', {
      layer: 'shade',
      frame: F,
      rect: { x: 2, y: 2, w: 4, h: 4 },
      color: '#ffffff',
      fill: true,
    });

    const result = editor.execute('draw_rect', {
      layer: 'base',
      frame: F,
      rect: { x: 0, y: 0, w: 16, h: 16 },
      color: '#000000',
      fill: true,
      clip: { layer: 'shade' },
    }) as { painted: number; warning?: string };

    expect(result.painted).toBe(16);
    expect(result.warning).toMatch(/render above/);
  });

  it('does not warn when painting on the clip layer or above it', () => {
    const editor = makeEditor();
    editor.execute('draw_rect', {
      layer: 'hair',
      frame: F,
      rect: { x: 2, y: 2, w: 4, h: 4 },
      color: '#ffffff',
      fill: true,
    });

    const onClip = editor.execute('draw_rect', {
      layer: 'hair',
      frame: F,
      rect: { x: 0, y: 0, w: 16, h: 16 },
      color: '#000000',
      fill: true,
      clip: { layer: 'hair' },
    }) as { warning?: string };
    expect(onClip.warning).toBeUndefined();

    const above = editor.execute('draw_rect', {
      layer: 'shade',
      frame: F,
      rect: { x: 0, y: 0, w: 16, h: 16 },
      color: '#000000',
      fill: true,
      clip: { layer: 'hair' },
    }) as { warning?: string };
    expect(above.warning).toBeUndefined();
  });

  it('does not warn for enum clips', () => {
    const editor = makeEditor();
    editor.execute('draw_rect', {
      layer: 'base',
      frame: F,
      rect: { x: 2, y: 2, w: 4, h: 4 },
      color: '#ffffff',
      fill: true,
    });

    const result = editor.execute('draw_rect', {
      layer: 'hair',
      frame: F,
      rect: { x: 0, y: 0, w: 16, h: 16 },
      color: '#000000',
      fill: true,
      clip: 'composite',
    }) as { warning?: string };
    expect(result.warning).toBeUndefined();
  });
});

describe('outline alpha threshold', () => {
  it('skips faint pixels when alphaThreshold is raised', () => {
    const editor = createEditor(createSprite({ width: 16, height: 16, name: 'Glow', layers: ['base', 'outline'] }));
    editor.execute('draw_rect', {
      layer: 'base',
      frame: F,
      rect: { x: 4, y: 4, w: 8, h: 8 },
      color: '#ff0000',
      fill: true,
      opacity: 0.2,
    });

    const byDefault = editor.execute('outline', {
      layer: 'outline',
      frame: F,
      color: '#000000',
      scope: 'composite',
    }) as { painted: number };
    const raised = editor.execute('outline', {
      layer: 'outline',
      frame: F,
      color: '#000000',
      scope: 'composite',
      alphaThreshold: 200,
    }) as { painted: number };

    expect(byDefault.painted).toBeGreaterThan(0);
    expect(raised.painted).toBe(0);
  });
});
