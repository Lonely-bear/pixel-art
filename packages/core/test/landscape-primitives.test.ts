/**
 * Tests for the three primitives added from landscape work.
 *
 * Each exists because drawing that scene by hand cost a hand-rolled helper that the
 * agent had to re-derive every time: a band that follows a crest, a stroked path, and
 * a mirror about an arbitrary line. The tests pin the behaviour those helpers had to
 * get right - the band tracks the curve, the path corner closes, the reflection lands
 * on the far side of the waterline and leaves the source alone.
 */
import { describe, expect, it } from 'vitest';
import { createEditor, createSprite, type Editor } from '../src/index.js';

function makeEditor(width = 16, height = 16, layers = ['base']): Editor {
  return createEditor(createSprite({ width, height, layers }));
}

function celOf(editor: Editor, layer: number | string = 0, frame = 0) {
  const layerId =
    typeof layer === 'string'
      ? editor.sprite.layers.find((l) => l.name === layer)!.id
      : editor.sprite.layers[layer].id;
  const cel = editor.sprite.frames[frame].cels.get(layerId);
  if (!cel) throw new Error('missing cel');
  return cel;
}

function isPainted(editor: Editor, x: number, y: number, layer: number | string = 0): boolean {
  return celOf(editor, layer).getColor(x, y).a > 0;
}

describe('shade_band', () => {
  it('lays a band that tracks a jagged crest rather than a straight line', () => {
    const editor = makeEditor(16, 16);
    // A staircase crest with flat runs, so assertions land away from the vertices
    // where any scanline fill is free to round either way.
    const crest = [
      { x: 0, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 8 }, { x: 6, y: 8 },
      { x: 6, y: 2 }, { x: 9, y: 2 }, { x: 9, y: 8 }, { x: 12, y: 8 },
      { x: 12, y: 2 }, { x: 15, y: 2 },
    ];
    const result = editor.execute('shade_band', {
      layer: 0,
      frame: 0,
      points: crest,
      offset: 0,
      thickness: 2,
      color: '#ff0000',
    }) as { painted: number; top: number; bottom: number };

    expect(result.top).toBe(10);
    expect(result.bottom).toBe(10);
    expect(result.painted).toBeGreaterThan(0);

    // On the first flat run (crest y=2) the band covers exactly rows 2 and 3.
    expect(isPainted(editor, 1, 2)).toBe(true);
    expect(isPainted(editor, 1, 3)).toBe(true);
    expect(isPainted(editor, 1, 4)).toBe(false);
    expect(isPainted(editor, 1, 5)).toBe(false);

    // On the second flat run (crest y=8) the band has moved down with the crest:
    // proof the band tracks the shape rather than sitting at a fixed height.
    expect(isPainted(editor, 4, 8)).toBe(true);
    expect(isPainted(editor, 4, 9)).toBe(true);
    expect(isPainted(editor, 4, 10)).toBe(false);
  });

  it('offsets the band below the crest and honours thickness', () => {
    const editor = makeEditor(8, 16);
    const crest = [{ x: 0, y: 2 }, { x: 7, y: 2 }];
    editor.execute('shade_band', {
      layer: 0, frame: 0, points: crest, offset: 4, thickness: 3, color: '#00ff00',
    });
    // Band occupies rows 6, 7 and 8 - not rows 2-4.
    expect(isPainted(editor, 3, 5)).toBe(false);
    expect(isPainted(editor, 3, 6)).toBe(true);
    expect(isPainted(editor, 3, 8)).toBe(true);
    expect(isPainted(editor, 3, 9)).toBe(false);
  });

  it('accepts explicit top and bottom polylines for a band between two curves', () => {
    const editor = makeEditor(16, 16);
    editor.execute('shade_band', {
      layer: 0,
      frame: 0,
      top: [{ x: 0, y: 4 }, { x: 15, y: 4 }],
      bottom: [{ x: 0, y: 6 }, { x: 15, y: 6 }],
      color: '#0000ff',
    });
    expect(isPainted(editor, 8, 3)).toBe(false);
    expect(isPainted(editor, 8, 4)).toBe(true);
    expect(isPainted(editor, 8, 5)).toBe(true);
    // The bottom edge is exclusive: the band is `bottom - top` rows tall.
    expect(isPainted(editor, 8, 6)).toBe(false);
    expect(isPainted(editor, 8, 7)).toBe(false);
  });

  it('lays a dithered seam when given a pattern and level', () => {
    const editor = makeEditor(16, 4);
    editor.execute('shade_band', {
      layer: 0,
      frame: 0,
      points: [{ x: 0, y: 1 }, { x: 15, y: 1 }],
      thickness: 2,
      color: '#ffffff',
      pattern: 'bayer4',
      level: 0.5,
    });
    const cel = celOf(editor);
    let painted = 0;
    for (let x = 0; x < 16; x++) {
      for (let y = 1; y < 3; y++) if (cel.getColor(x, y).a > 0) painted++;
    }
    // A 50% seam is partial, unlike a solid band.
    expect(painted).toBeGreaterThan(0);
    expect(painted).toBeLessThan(32);
  });

  it('refuses a band with neither a crest nor an explicit top', () => {
    const editor = makeEditor(8, 8);
    expect(() => editor.execute('shade_band', { layer: 0, frame: 0, color: '#fff' })).toThrow(
      /needs `points`.*or `top`/,
    );
    expect(() =>
      editor.execute('shade_band', {
        layer: 0, frame: 0, bottom: [{ x: 0, y: 1 }, { x: 7, y: 1 }], color: '#fff',
      }),
    ).toThrow(/`bottom` needs `top`/);
  });

  it('stays inside the silhouette when clipped to a layer', () => {
    const editor = makeEditor(16, 16, ['shape', 'shade']);
    editor.execute('draw_polygon', {
      layer: 'shape', frame: 0, color: '#ff0000', fill: true,
      points: [{ x: 8, y: 0 }, { x: 15, y: 0 }, { x: 15, y: 15 }, { x: 8, y: 15 }],
    });
    editor.execute('shade_band', {
      layer: 'shade', frame: 0,
      points: [{ x: 0, y: 0 }, { x: 15, y: 0 }],
      thickness: 6,
      color: '#00ff00',
      clip: { layer: 'shape' },
    });
    // The band spans the full width but the shape only covers the right half.
    expect(isPainted(editor, 2, 2, 'shade')).toBe(false);
    expect(isPainted(editor, 12, 2, 'shade')).toBe(true);
  });
});

describe('draw_polyline', () => {
  it('strokes a path through its vertices and runs', () => {
    const editor = makeEditor(16, 16);
    editor.execute('draw_polyline', {
      layer: 0,
      frame: 0,
      color: '#ff0000',
      points: [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }],
    });
    expect(isPainted(editor, 2, 2)).toBe(true);
    expect(isPainted(editor, 4, 2)).toBe(true);
    expect(isPainted(editor, 8, 2)).toBe(true);
    expect(isPainted(editor, 8, 5)).toBe(true);
    expect(isPainted(editor, 8, 8)).toBe(true);
    // Nothing past the ends or off the path.
    expect(isPainted(editor, 1, 2)).toBe(false);
    expect(isPainted(editor, 9, 2)).toBe(false);
    expect(isPainted(editor, 2, 3)).toBe(false);
  });

  it('fills the outer corner of a thick turn with the vertex brush', () => {
    const editor = makeEditor(16, 16);
    editor.execute('draw_polyline', {
      layer: 0, frame: 0, color: '#ff0000', width: 3,
      points: [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }],
    });
    // (9,1) sits outside both stroke bands - the horizontal run reaches x=8 and the
    // vertical run starts at y=2 - so it is only covered by the square brush stamped
    // at the vertex. Without it a wide turn shows a clipped outer corner.
    expect(isPainted(editor, 9, 1)).toBe(true);
    expect(isPainted(editor, 7, 3)).toBe(true);
  });

  it('closes the path only when asked', () => {
    const points = [{ x: 2, y: 2 }, { x: 12, y: 2 }, { x: 7, y: 12 }];
    // (4,7) sits on the closing edge from (7,12) back to (2,2).
    const open = makeEditor(16, 16);
    open.execute('draw_polyline', { layer: 0, frame: 0, color: '#ff0000', points });
    expect(isPainted(open, 6, 2)).toBe(true);
    expect(isPainted(open, 4, 7)).toBe(false);

    const closed = makeEditor(16, 16);
    const result = closed.execute('draw_polyline', {
      layer: 0, frame: 0, color: '#ff0000', close: true, points,
    }) as { closed: boolean; segments: number };
    expect(result.closed).toBe(true);
    expect(result.segments).toBe(3);
    expect(isPainted(closed, 4, 7)).toBe(true);
    // Still a stroke, not a fill: the middle of the triangle stays empty.
    expect(isPainted(closed, 7, 6)).toBe(false);
  });

  it('thickens the stroke and reports the width it used', () => {
    const editor = makeEditor(16, 16);
    const result = editor.execute('draw_polyline', {
      layer: 0, frame: 0, color: '#ff0000', width: 3,
      points: [{ x: 4, y: 8 }, { x: 11, y: 8 }],
    }) as { width: number; painted: number };
    expect(result.width).toBe(3);
    expect(isPainted(editor, 7, 7)).toBe(true);
    expect(isPainted(editor, 7, 8)).toBe(true);
    expect(isPainted(editor, 7, 9)).toBe(true);
    expect(isPainted(editor, 7, 6)).toBe(false);
  });

  it('rejects a single-point path', () => {
    const editor = makeEditor(8, 8);
    expect(() =>
      editor.execute('draw_polyline', { layer: 0, frame: 0, color: '#fff', points: [{ x: 1, y: 1 }] }),
    ).toThrow();
  });
});

describe('mirror', () => {
  it('defaults to the canvas centre and matches flip', () => {
    const editor = makeEditor(8, 8);
    editor.execute('draw_rect', { layer: 0, frame: 0, rect: { x: 1, y: 1, w: 1, h: 1 }, color: '#ff0000', fill: true });
    const result = editor.execute('mirror', { layer: 0, frame: 0, axis: 'horizontal' }) as { about: number };
    expect(result.about).toBeCloseTo(3.5, 5);
    // x=1 mirrors to 2*3.5-1 = 6.
    expect(isPainted(editor, 1, 1)).toBe(false);
    expect(isPainted(editor, 6, 1)).toBe(true);
  });

  it('mirrors about an arbitrary line, which is what a waterline needs', () => {
    const editor = makeEditor(16, 16);
    editor.execute('draw_rect', { layer: 0, frame: 0, rect: { x: 4, y: 2, w: 2, h: 1 }, color: '#ff0000', fill: true });
    const result = editor.execute('mirror', {
      layer: 0, frame: 0, axis: 'vertical', about: 8,
    }) as { about: number };
    expect(result.about).toBe(8);
    // y=2 sits 6 above the line, so it lands 6 below: y=14.
    expect(isPainted(editor, 4, 2)).toBe(false);
    expect(isPainted(editor, 4, 14)).toBe(true);
  });

  it('copies into another layer and leaves the source untouched', () => {
    const editor = makeEditor(16, 16, ['scene', 'reflection']);
    editor.execute('draw_rect', { layer: 'scene', frame: 0, rect: { x: 3, y: 4, w: 2, h: 1 }, color: '#ff0000', fill: true });
    const result = editor.execute('mirror', {
      layer: 'scene', frame: 0, axis: 'vertical', about: 8, copyTo: 'reflection',
    }) as { sourceUntouched: boolean; copiedTo: string };

    expect(result.sourceUntouched).toBe(true);
    // Source still there, reflection written 12 rows lower.
    expect(isPainted(editor, 3, 4, 'scene')).toBe(true);
    expect(isPainted(editor, 3, 12, 'reflection')).toBe(true);
  });

  it('drops artwork that would fall outside the canvas', () => {
    const editor = makeEditor(16, 16);
    editor.execute('draw_rect', { layer: 0, frame: 0, rect: { x: 0, y: 0, w: 4, h: 1 }, color: '#ff0000', fill: true });
    // The line sits above the canvas, so the whole row lands off it.
    editor.execute('mirror', { layer: 0, frame: 0, axis: 'vertical', about: -2 });
    expect(isPainted(editor, 0, 0)).toBe(false);
    expect(isPainted(editor, 3, 0)).toBe(false);
  });

  it('reports zero cels when the scope matches nothing', () => {
    const editor = makeEditor(8, 8);
    editor.execute('clear_all', {});
    const result = editor.execute('mirror', { layer: 0, frame: 0, axis: 'horizontal' }) as { cels: number };
    expect(result.cels).toBe(0);
  });
});
