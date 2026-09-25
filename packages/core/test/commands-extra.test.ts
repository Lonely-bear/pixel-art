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
    }) as { painted: number; replaced: number; warning?: string };

    // The erase pass covers exactly the pixels the ellipse paints, and the
    // destructive behaviour is visible without inspecting the cel.
    expect(result.replaced).toBe(result.painted);
    expect(result.warning).toMatch(/replace: true/);
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
    }) as { painted: number; replaced: number; warning?: string; level: number; requestedLevel: number };

    expect(result.replaced).toBe(64);
    expect(result.warning).toMatch(/transparent/);
    expect(result.requestedLevel).toBe(0.5);
    expect(result.level).toBe(0.5);
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

  it('applies palette lock to the initial background as well as later paint', () => {
    const sprite = createSprite({
      width: 4,
      height: 4,
      palette: bw(),
      paletteLocked: true,
      background: '#ff0000',
    });
    const color = sprite.frames[0].cels.get(sprite.layers[0].id)?.getColor(0, 0);
    expect(color).toMatchObject({ r: 0, g: 0, b: 0, a: 255 });
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

describe('cluster dithering', () => {
  it('covers the same fraction as bayer but in 2x2 blocks', () => {
    const editor = createEditor(createSprite({ width: 16, height: 16, name: 'Cluster' }));
    const result = editor.execute('dither_fill', {
      layer: 0,
      frame: F,
      color: '#ffffff',
      pattern: 'cluster2',
      level: 0.5,
    }) as { painted: number };

    expect(result.painted).toBe(128);
    const buf = celOf(editor);
    for (let by = 0; by < 8; by++) {
      for (let bx = 0; bx < 8; bx++) {
        const first = buf.getColor(bx * 2, by * 2).a;
        for (let y = 0; y < 2; y++) {
          for (let x = 0; x < 2; x++) {
            expect(buf.getColor(bx * 2 + x, by * 2 + y).a).toBe(first);
          }
        }
      }
    }
  });

  it('still respects the requested coverage', () => {
    const editor = createEditor(createSprite({ width: 16, height: 16, name: 'Cluster' }));
    const low = editor.execute('dither_fill', {
      layer: 0,
      frame: F,
      color: '#ffffff',
      pattern: 'cluster4',
      level: 0.25,
    }) as { painted: number };
    expect(low.painted).toBe(64);
  });
});

describe('antialias and despeckle', () => {
  it('adds a concave AA pixel without touching the rest of the cel', () => {
    const editor = createEditor(createSprite({ width: 16, height: 16, name: 'AA' }));
    // An L-shaped silhouette: (5,5) is the transparent notch between solid up/left.
    editor.execute('draw_rect', { layer: 0, frame: F, rect: { x: 4, y: 4, w: 4, h: 1 }, color: '#000000', fill: true });
    editor.execute('draw_rect', { layer: 0, frame: F, rect: { x: 4, y: 5, w: 1, h: 4 }, color: '#000000', fill: true });

    const result = editor.execute('antialias', {
      layer: 0,
      frame: F,
      mode: 'silhouette',
      amount: 0.5,
    }) as { added: number; changed: number };

    expect(result.added).toBeGreaterThan(0);
    const buf = celOf(editor);
    expect(buf.getColor(5, 5).a).toBeGreaterThan(0);
    expect(buf.getColor(5, 5).a).toBeLessThan(255);
  });

  it('softens an internal colour step', () => {
    const editor = createEditor(createSprite({ width: 16, height: 16, name: 'AA' }));
    editor.execute('draw_rect', { layer: 0, frame: F, rect: { x: 0, y: 0, w: 16, h: 8 }, color: '#ff0000', fill: true });
    editor.execute('draw_rect', { layer: 0, frame: F, rect: { x: 0, y: 8, w: 16, h: 8 }, color: '#0000ff', fill: true });

    const result = editor.execute('antialias', {
      layer: 0,
      frame: F,
      mode: 'internal',
      amount: 1,
      threshold: 0,
    }) as { softened: number };

    expect(result.softened).toBeGreaterThan(0);
    const boundary = celOf(editor).getColor(8, 7);
    expect(boundary).not.toMatchObject({ r: 255, g: 0, b: 0 });
    expect(boundary).not.toMatchObject({ r: 0, g: 0, b: 255 });
  });

  it('removes a truly isolated pixel and merges a lone outlier', () => {
    const isolated = createEditor(createSprite({ width: 8, height: 8, name: 'Speck' }));
    isolated.execute('draw_pixels', { layer: 0, frame: F, pixels: [{ x: 2, y: 2, color: '#ffffff' }] });
    const removed = isolated.execute('despeckle', { layer: 0, frame: F }) as { removed: number };
    expect(removed.removed).toBe(1);

    const outlier = createEditor(createSprite({ width: 8, height: 8, name: 'Speck' }));
    outlier.execute('draw_rect', { layer: 0, frame: F, rect: { x: 0, y: 0, w: 8, h: 8 }, color: '#800000', fill: true });
    outlier.execute('draw_pixels', { layer: 0, frame: F, pixels: [{ x: 4, y: 4, color: '#ffffff' }] });
    const merged = outlier.execute('despeckle', { layer: 0, frame: F, mode: 'merge-outliers' }) as {
      merged: number;
    };
    expect(merged.merged).toBe(1);
    expect(celOf(outlier).getColor(4, 4)).toMatchObject({ r: 128, g: 0, b: 0, a: 255 });
  });

  it('protects intentional pointillism clusters with minClusterSize', () => {
    const editor = createEditor(createSprite({ width: 8, height: 8, name: 'Pointillism' }));
    editor.execute('draw_rect', { layer: 0, frame: F, rect: { x: 2, y: 2, w: 2, h: 2 }, color: '#ffffff', fill: true });
    const result = editor.execute('despeckle', {
      layer: 0,
      frame: F,
      mode: 'remove-isolated',
      minClusterSize: 2,
    }) as { removed: number };
    expect(result.removed).toBe(0);
    expect(celOf(editor).getColor(2, 2).a).toBe(255);
  });
});

describe('ellipse fill default and pixel rounding', () => {
  it('fills an ellipse unless fill:false is explicit', () => {
    const editor = createEditor(createSprite({ width: 8, height: 8, name: 'Ellipse' }));
    const result = editor.execute('draw_ellipse', {
      layer: 0,
      frame: F,
      rect: { x: 1, y: 1, w: 6, h: 6 },
      color: '#ffffff',
    }) as { painted: number };
    expect(result.painted).toBeGreaterThan(10);

    const outline = createEditor(createSprite({ width: 8, height: 8, name: 'Ellipse' }));
    const outlineResult = outline.execute('draw_ellipse', {
      layer: 0,
      frame: F,
      rect: { x: 1, y: 1, w: 6, h: 6 },
      color: '#ffffff',
      fill: false,
    }) as { painted: number };
    expect(outlineResult.painted).toBeLessThan(result.painted);
  });

  it('rounds fractional pixel coordinates and returns the first samples', () => {
    const editor = createEditor(createSprite({ width: 8, height: 8, name: 'Round' }));
    const result = editor.execute('draw_pixels', {
      layer: 0,
      frame: F,
      pixels: [
        { x: 1.2, y: 2.8, color: '#ffffff' },
        { x: 3.6, y: 4.1, color: '#ffffff' },
      ],
    }) as { rounded: number; roundedSamples: Array<{ x: number; y: number; value: { x: number; y: number } }>; warning?: string };

    expect(result.rounded).toBe(2);
    expect(result.roundedSamples).toHaveLength(2);
    expect(result.roundedSamples[0]).toMatchObject({ x: 1.2, y: 2.8, value: { x: 1, y: 3 } });
    expect(result.warning).toContain('Rounded 2');
    expect(celOf(editor).getColor(1, 3).a).toBe(255);
  });
});
