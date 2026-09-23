import { describe, expect, it } from 'vitest';
import { createEditor, createSprite } from '../src/index.js';
import { resolvePivot, scaleAbout, translate } from '../src/transform.js';
import { PixelBuffer } from '../src/buffer.js';

function makeSprite(layers = ['base', 'shade']) {
  return createSprite({ width: 8, height: 8, name: 'Test', layers });
}

const opaque = (editor: ReturnType<typeof createEditor>, layer: string) =>
  editor.execute('measure_region', { layer, frame: 0 }).opaque;

describe('clip', () => {
  it("keeps a shape inside the silhouette the other layers define", () => {
    const editor = createEditor(makeSprite());

    // A 4x4 body on the bottom layer.
    editor.execute('draw_rect', {
      layer: 'base',
      frame: 0,
      rect: { x: 2, y: 2, w: 4, h: 4 },
      color: '#ff0000',
      fill: true,
    });

    // A shadow that would spill over the whole canvas without the clip: the
    // bounding box is 8x8 but only the 16 pixels the body defines may be painted.
    const painted = editor.execute('draw_rect', {
      layer: 'shade',
      frame: 0,
      rect: { x: 0, y: 0, w: 8, h: 8 },
      color: '#0000ff',
      fill: true,
      clip: 'composite',
    });

    expect(painted.painted).toBe(16);
    expect(opaque(editor, 'shade')).toBe(16);
    // The composite is unchanged in size: the shadow landed exactly on the body.
    expect(editor.execute('measure_region', { layer: 'base', frame: 0, scope: 'composite' }).opaque).toBe(16);
  });

  it('clips against the cel itself with clip: "cel"', () => {
    const editor = createEditor(makeSprite());
    editor.execute('draw_rect', {
      layer: 'base',
      frame: 0,
      rect: { x: 2, y: 2, w: 4, h: 4 },
      color: '#ff0000',
      fill: true,
    });

    // Painting the whole canvas with `cel` may only recolour what is already there.
    const painted = editor.execute('draw_rect', {
      layer: 'base',
      frame: 0,
      rect: { x: 0, y: 0, w: 8, h: 8 },
      color: '#00ff00',
      fill: true,
      clip: 'cel',
    });

    expect(painted.painted).toBe(16);
    expect(opaque(editor, 'base')).toBe(16);
    expect(editor.execute('measure_region', { layer: 'base', frame: 0 }).bounds).toEqual({
      x: 2,
      y: 2,
      w: 4,
      h: 4,
    });
  });

  it('paints nothing when clipping against an empty cel', () => {
    const editor = createEditor(makeSprite());
    const painted = editor.execute('draw_rect', {
      layer: 'shade',
      frame: 0,
      rect: { x: 0, y: 0, w: 8, h: 8 },
      color: '#00ff00',
      fill: true,
      clip: 'cel',
    });

    expect(painted.painted).toBe(0);
    expect(opaque(editor, 'shade')).toBe(0);
  });

  it('leaves the default unclipped', () => {
    const editor = createEditor(makeSprite());
    const painted = editor.execute('draw_rect', {
      layer: 'shade',
      frame: 0,
      rect: { x: 0, y: 0, w: 8, h: 8 },
      color: '#00ff00',
      fill: true,
    });
    expect(painted.painted).toBe(64);
  });

  it('applies to erasing too', () => {
    const editor = createEditor(makeSprite());
    editor.execute('draw_rect', {
      layer: 'base',
      frame: 0,
      rect: { x: 2, y: 2, w: 4, h: 4 },
      color: '#ff0000',
      fill: true,
    });

    // Clear everything, but only where the frame has pixels: the body survives
    // outside the clip only if the clip is ignored.
    const cleared = editor.execute('clear_region', {
      layer: 'base',
      frame: 0,
      rect: { x: 3, y: 3, w: 2, h: 2 },
      clip: 'composite',
    });

    // The clip excludes the layer being cleared, so nothing is opaque on `shade`
    // and the mask is empty: a clear clipped to the *composite* sees only the
    // other layers, which are also empty here.
    expect(cleared.cleared).toBe(0);
    expect(opaque(editor, 'base')).toBe(16);
  });
});

describe('scope', () => {
  it('outlines the composite onto a layer of its own', () => {
    const editor = createEditor(makeSprite(['base', 'ink']));
    editor.execute('draw_rect', {
      layer: 'base',
      frame: 0,
      rect: { x: 2, y: 2, w: 4, h: 4 },
      color: '#ff0000',
      fill: true,
    });

    const painted = editor.execute('outline', {
      layer: 'ink',
      frame: 0,
      color: '#000000',
      scope: 'composite',
    });

    // The 4-connected ring around a 4x4 block, which has room on all four sides.
    expect(painted.painted).toBe(16);
    expect(painted.scope).toBe('composite');
    expect(opaque(editor, 'ink')).toBe(16);
  });

  it('still traces the cel by default', () => {
    const editor = createEditor(makeSprite(['base', 'ink']));
    editor.execute('draw_rect', {
      layer: 'base',
      frame: 0,
      rect: { x: 2, y: 2, w: 4, h: 4 },
      color: '#ff0000',
      fill: true,
    });

    // `ink` is empty, so a cel-scoped outline has nothing to trace.
    expect(editor.execute('outline', { layer: 'ink', frame: 0, color: '#000000' }).painted).toBe(0);
    expect(editor.execute('outline', { layer: 'base', frame: 0, color: '#000000' }).painted).toBe(16);
  });

  it('measures the composite', () => {
    const editor = createEditor(makeSprite(['base', 'ink']));
    editor.execute('draw_rect', {
      layer: 'base',
      frame: 0,
      rect: { x: 2, y: 2, w: 4, h: 4 },
      color: '#ff0000',
      fill: true,
    });
    editor.execute('outline', { layer: 'ink', frame: 0, color: '#000000', scope: 'composite' });

    expect(editor.execute('measure_region', { layer: 'base', frame: 0 }).opaque).toBe(16);
    expect(editor.execute('measure_region', { layer: 'base', frame: 0, scope: 'composite' })).toEqual({
      opaque: 32,
      bounds: { x: 1, y: 1, w: 6, h: 6 },
      empty: false,
      scope: 'composite',
    });
  });
});

describe('translate', () => {
  it('shifts a cel and clears the band it vacates', () => {
    const editor = createEditor(makeSprite());
    editor.execute('draw_pixels', {
      layer: 'base',
      frame: 0,
      pixels: [{ x: 1, y: 1, color: '#ff0000' }],
    });

    const result = editor.execute('translate', { layer: 'base', frame: 0, dx: 2, dy: 1 });

    expect(result).toEqual({ cels: 1, dx: 2, dy: 1 });
    expect(editor.execute('measure_region', { layer: 'base', frame: 0 })).toMatchObject({
      opaque: 1,
      bounds: { x: 3, y: 2, w: 1, h: 1 },
    });
  });

  it('moves every layer together with layer: "*"', () => {
    const editor = createEditor(makeSprite());
    editor.execute('draw_pixels', { layer: 'base', frame: 0, pixels: [{ x: 1, y: 1, color: '#ff0000' }] });
    editor.execute('draw_pixels', { layer: 'shade', frame: 0, pixels: [{ x: 2, y: 2, color: '#0000ff' }] });

    const result = editor.execute('translate', { layer: '*', frame: 0, dx: 1, dy: 0 });

    expect(result.cels).toBe(2);
    expect(editor.execute('measure_region', { layer: 'base', frame: 0 }).bounds).toEqual({ x: 2, y: 1, w: 1, h: 1 });
    expect(editor.execute('measure_region', { layer: 'shade', frame: 0 }).bounds).toEqual({ x: 3, y: 2, w: 1, h: 1 });
  });

  it('is a no-op for a frame with no cels', () => {
    const editor = createEditor(makeSprite());
    expect(editor.execute('translate', { layer: '*', frame: 0, dx: 1, dy: 1 })).toEqual({
      cels: 0,
      dx: 1,
      dy: 1,
    });
  });
});

describe('squash', () => {
  it('scales about the bottom edge and keeps the canvas size', () => {
    const editor = createEditor(makeSprite());
    editor.execute('draw_rect', {
      layer: 'base',
      frame: 0,
      rect: { x: 2, y: 2, w: 4, h: 4 },
      color: '#ff0000',
      fill: true,
    });

    const result = editor.execute('squash', { layer: 'base', frame: 0, scaleY: 0.5, pivot: 'bottom' });

    expect(result.cels).toBe(1);
    // Pivot is the bottom row of the 4x4 block, y = 5. Halving the height about
    // it leaves two rows, and the bottom row is still there.
    expect(editor.execute('measure_region', { layer: 'base', frame: 0 })).toMatchObject({
      opaque: 8,
      bounds: { x: 2, y: 4, w: 4, h: 2 },
    });
  });

  it('shares one pivot across layers so the sprite does not shear', () => {
    const editor = createEditor(makeSprite());
    editor.execute('draw_rect', {
      layer: 'base',
      frame: 0,
      rect: { x: 2, y: 2, w: 4, h: 4 },
      color: '#ff0000',
      fill: true,
    });
    editor.execute('draw_pixels', { layer: 'shade', frame: 0, pixels: [{ x: 3, y: 5, color: '#0000ff' }] });

    const result = editor.execute('squash', { layer: '*', frame: 0, scaleY: 0.5, pivot: 'bottom' });

    expect(result.cels).toBe(2);
    // The composite bounds are used for the pivot, so the shade pixel on the
    // bottom row stays on the bottom row.
    expect(editor.execute('measure_region', { layer: 'shade', frame: 0 }).bounds).toEqual({
      x: 3,
      y: 5,
      w: 1,
      h: 1,
    });
  });

  it('reports when there is nothing to pivot around', () => {
    const editor = createEditor(makeSprite());
    // No cels at all on this frame.
    expect(editor.execute('squash', { layer: 'base', frame: 0, scaleY: 0.5, pivot: 'bottom' })).toEqual({
      cels: 0,
      reason: 'no cels on this frame',
    });

    // A cel that exists but is still empty has no bounding box to pivot on.
    editor.execute('draw_pixels', { layer: 'base', frame: 0, pixels: [{ x: 0, y: 0, color: null }] });
    editor.execute('clear_region', { layer: 'base', frame: 0 });
    expect(editor.execute('squash', { layer: 'base', frame: 0, scaleY: 0.5, pivot: 'bottom' })).toEqual({
      cels: 0,
      reason: 'nothing drawn to pivot around',
    });
  });
});

describe('buffer-level motion helpers', () => {
  it('resolvePivot places the nine named anchors', () => {
    const bounds = { x: 2, y: 4, w: 4, h: 2 };
    expect(resolvePivot('top-left', bounds)).toEqual({ x: 2, y: 4 });
    expect(resolvePivot('bottom-right', bounds)).toEqual({ x: 5, y: 5 });
    expect(resolvePivot('center', bounds)).toEqual({ x: 3.5, y: 4.5 });
    expect(resolvePivot('left', bounds)).toEqual({ x: 2, y: 4.5 });
  });

  it('translate moves content without wrapping it around', () => {
    const buf = new PixelBuffer(4, 4);
    buf.setColor(0, 0, { r: 255, g: 0, b: 0, a: 255 });
    const moved = translate(buf, 1, 1);
    expect(moved.getColor(1, 1).a).toBe(255);
    expect(moved.getColor(0, 0).a).toBe(0);
    expect(moved.width).toBe(4);
  });

  it('scaleAbout keeps the pivot fixed and the canvas size', () => {
    const buf = new PixelBuffer(4, 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) buf.setColor(x, y, { r: 255, g: 0, b: 0, a: 255 });
    }
    const squashed = scaleAbout(buf, 1, 0.5, { pivotX: 1.5, pivotY: 3 });
    expect(squashed.width).toBe(4);
    expect(squashed.height).toBe(4);
    expect(squashed.getColor(1, 3).a).toBe(255);
    expect(squashed.getColor(1, 0).a).toBe(0);
  });

  it('rejects non-positive scale factors', () => {
    const buf = new PixelBuffer(2, 2);
    expect(() => scaleAbout(buf, 0, 1, { pivotX: 0, pivotY: 0 })).toThrow(RangeError);
  });
});
