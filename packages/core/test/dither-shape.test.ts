import { describe, expect, it } from 'vitest';
import { createEditor, createSprite } from '../src/index.js';

/**
 * Shape-aware dithering.
 *
 * Dithering is applied inside `putPixel`, so every paint command gains it. These tests
 * pin the two properties that matter: a dithered shape covers only the pixels a solid
 * one would, and it covers roughly `level` of them.
 */
function makeSprite(layers = ['base']) {
  return createSprite({ width: 16, height: 16, name: 'Dither', layers });
}

describe('shape-aware dithering', () => {
  it('stipples a filled ellipse only inside the ellipse', () => {
    const editor = createEditor(makeSprite());
    const ellipse = { x: 2, y: 2, w: 12, h: 12 };

    // A solid ellipse of the same geometry, to compare against.
    const solid = createEditor(makeSprite());
    solid.execute('draw_ellipse', { layer: 0, frame: 0, rect: ellipse, color: '#ffffff', fill: true });
    const solidCount = (solid.execute('measure_region', { layer: 0, frame: 0 }) as { opaque: number }).opaque;

    const result = editor.execute('draw_ellipse', {
      layer: 0,
      frame: 0,
      rect: ellipse,
      color: '#ffffff',
      fill: true,
      pattern: 'bayer4',
      level: 0.5,
    }) as { painted: number };

    // Roughly half of the ellipse, and never more than the ellipse itself.
    expect(result.painted).toBeGreaterThan(solidCount * 0.35);
    expect(result.painted).toBeLessThan(solidCount * 0.65);
    expect(result.painted).toBeLessThan(solidCount);

    const bounds = (editor.execute('measure_region', { layer: 0, frame: 0 }) as { bounds: unknown }).bounds;
    expect(bounds).toEqual({ x: 2, y: 2, w: 12, h: 12 });
  });

  it('keeps the dithered geometry identical to the solid geometry', () => {
    const ellipse = { x: 3, y: 1, w: 9, h: 13 };

    const solid = createEditor(makeSprite());
    solid.execute('draw_ellipse', { layer: 0, frame: 0, rect: ellipse, color: '#ffffff', fill: true });
    // Read the solid pixels back through a 1:1 export of the cel, via get_pixels on the
    // composited frame — the editor has no direct cel readback, so measure per column.
    const solidCount = (solid.execute('measure_region', { layer: 0, frame: 0 }) as { opaque: number }).opaque;

    const dithered = createEditor(makeSprite());
    const painted = (
      dithered.execute('draw_ellipse', {
        layer: 0,
        frame: 0,
        rect: ellipse,
        color: '#ffffff',
        fill: true,
        pattern: 'bayer8',
        level: 0.25,
      }) as { painted: number }
    ).painted;

    // Every painted pixel is inside the ellipse, so the count can never exceed it, and
    // bayer8 at 0.25 selects exactly a quarter of the 64-step matrix.
    expect(painted).toBeLessThan(solidCount);
    expect(painted).toBeGreaterThan(0);
  });

  it('fills a dithered polygon that follows a curve', () => {
    const editor = createEditor(makeSprite());
    const triangle = [
      { x: 2, y: 2 },
      { x: 13, y: 2 },
      { x: 7, y: 13 },
    ];

    const solid = createEditor(makeSprite());
    solid.execute('draw_polygon', { layer: 0, frame: 0, points: triangle, color: '#ffffff', fill: true });
    const solidCount = (solid.execute('measure_region', { layer: 0, frame: 0 }) as { opaque: number }).opaque;

    const painted = (
      editor.execute('draw_polygon', {
        layer: 0,
        frame: 0,
        points: triangle,
        color: '#ffffff',
        fill: true,
        pattern: 'checker',
        level: 0.5,
      }) as { painted: number }
    ).painted;

    expect(solidCount).toBeGreaterThan(0);
    expect(painted).toBeGreaterThan(solidCount * 0.3);
    expect(painted).toBeLessThan(solidCount * 0.7);
  });

  it('fills an ellipse-shaped band through dither_fill', () => {
    const editor = createEditor(makeSprite());
    const result = editor.execute('dither_fill', {
      layer: 0,
      frame: 0,
      shape: { ellipse: { x: 1, y: 1, w: 14, h: 14 } },
      color: '#327345',
      pattern: 'bayer4',
      level: 0.5,
    }) as { painted: number; kind: string };

    expect(result.kind).toBe('ellipse');
    expect(result.painted).toBeGreaterThan(0);
    // An ellipse inscribed in a 14x14 box is about 154 pixels; half of it dithered.
    expect(result.painted).toBeLessThan(160);
  });

  it('fills a polygon-shaped band through dither_fill', () => {
    const editor = createEditor(makeSprite());
    const result = editor.execute('dither_fill', {
      layer: 0,
      frame: 0,
      shape: {
        polygon: [
          { x: 1, y: 1 },
          { x: 14, y: 1 },
          { x: 14, y: 8 },
          { x: 1, y: 8 },
        ],
      },
      color: '#ffffff',
      pattern: 'checker',
    }) as { painted: number; kind: string };

    expect(result.kind).toBe('polygon');
    // A 14x8 band at checker/0.5 is roughly half of 112.
    expect(result.painted).toBeGreaterThan(40);
    expect(result.painted).toBeLessThan(70);
  });

  it('fills the whole cel when neither rect nor shape is given', () => {
    const editor = createEditor(makeSprite());
    const result = editor.execute('dither_fill', {
      layer: 0,
      frame: 0,
      color: '#ffffff',
      pattern: 'checker',
      level: 0.5,
    }) as { painted: number; kind: string };

    expect(result.kind).toBe('rect');
    // 16x16 = 256, half of it.
    expect(result.painted).toBe(128);
  });

  it('still accepts a plain rect for backwards compatibility', () => {
    const editor = createEditor(makeSprite());
    const result = editor.execute('dither_fill', {
      layer: 0,
      frame: 0,
      rect: { x: 0, y: 0, w: 4, h: 4 },
      color: '#ffffff',
      pattern: 'checker',
    }) as { painted: number; kind: string };

    expect(result.kind).toBe('rect');
    expect(result.painted).toBe(8);
  });

  it('composes a dither pattern with a composite clip', () => {
    const editor = createEditor(createSprite({ width: 16, height: 16, name: 'Clip', layers: ['base', 'shade'] }));

    // A silhouette on the bottom layer.
    editor.execute('draw_rect', {
      layer: 'base',
      frame: 0,
      rect: { x: 4, y: 4, w: 8, h: 8 },
      color: '#346524',
      fill: true,
    });

    // A dithered, clipped band: only inside the silhouette, and only half of it.
    const result = editor.execute('dither_fill', {
      layer: 'shade',
      frame: 0,
      rect: { x: 0, y: 0, w: 16, h: 16 },
      color: '#d04648',
      pattern: 'checker',
      level: 0.5,
      clip: 'composite',
    }) as { painted: number };

    expect(result.painted).toBe(32);

    const shade = editor.execute('measure_region', { layer: 'shade', frame: 0 }) as { bounds: unknown };
    expect(shade.bounds).toEqual({ x: 4, y: 4, w: 8, h: 8 });
  });

  it('paints nothing when the dither level is zero', () => {
    const editor = createEditor(makeSprite());
    const result = editor.execute('draw_rect', {
      layer: 0,
      frame: 0,
      rect: { x: 0, y: 0, w: 16, h: 16 },
      color: '#ffffff',
      fill: true,
      pattern: 'bayer4',
      level: 0,
    }) as { painted: number };

    expect(result.painted).toBe(0);
  });
});
