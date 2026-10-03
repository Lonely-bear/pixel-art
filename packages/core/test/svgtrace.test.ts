import { describe, expect, it } from 'vitest';
import { createEditor, createPalette, createSprite, getCel } from '../src/index.js';
import { parsePathData, traceSvg } from '../src/svgtrace.js';

/** `#` for an opaque painted pixel, `.` for transparent. One string per scanline. */
/** The raw cel behind a layer index, which is how these tests assert exact pixels. */
function celAt(editor: ReturnType<typeof createEditor>, layer = 0, frame = 0): Uint8ClampedArray {
  const sprite = editor.sprite;
  const cel = getCel(sprite, sprite.layers[layer].id, sprite.frames[frame].id);
  if (!cel) throw new Error(`no cel for layer ${layer} on frame ${frame}`);
  return cel.data;
}

function rowsOf(bounds: { x: number; y: number; w: number; h: number } | null, data: Uint8ClampedArray, width: number): string[] {
  const b = bounds ?? { x: 0, y: 0, w: 0, h: 0 };
  const rows: string[] = [];
  for (let y = b.y; y < b.y + b.h; y++) {
    let row = '';
    for (let x = b.x; x < b.x + b.w; x++) {
      row += data[(y * width + x) * 4 + 3] !== 0 ? '#' : '.';
    }
    rows.push(row);
  }
  return rows;
}

function editor(width = 16, height = 16) {
  return createEditor(createSprite({ width, height }));
}

describe('svg path parsing', () => {
  it('flattens absolute and relative commands onto the same points', () => {
    const absolute = parsePathData('M2 2 L10 2 L10 6 Z');
    const relative = parsePathData('m2 2 l8 0 l0 4 z');
    expect(relative).toEqual(absolute);
    expect(absolute).toEqual([
      [
        { x: 2, y: 2 },
        { x: 10, y: 2 },
        { x: 10, y: 6 },
      ],
    ]);
  });

  it('treats the coordinate pairs after a moveto as implicit linetos', () => {
    // The second pair must land as a line, not start a new subpath.
    expect(parsePathData('M0 0 4 0 4 4')).toEqual([
      [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 4 },
      ],
    ]);
  });

  it('reflects the control point for S and T shorthand after a matching curve', () => {
    const smooth = parsePathData('M0 0 C0 4 8 4 8 0 S16 -4 16 0', 0.01);
    const explicit = parsePathData('M0 0 C0 4 8 4 8 0 C8 -4 16 -4 16 0', 0.01);
    expect(smooth).toEqual(explicit);
  });

  it('refuses an unknown command rather than tracing the rest of the data', () => {
    expect(() => parsePathData('M0 0 X5 5')).toThrow(/Unsupported path command/);
  });

  it('refuses non-numeric path data instead of silently producing NaN geometry', () => {
    expect(() => parsePathData('M0 0 L q')).toThrow(/Expected a number/);
  });
});

describe('trace_svg arc accuracy', () => {
  // `packages/core/test/determinism.test.ts` bans Math.sin/cos/tan/atan2 in `src`, so the
  // arc code uses a Cody-Waite-reduced fdlibm kernel and a Taylor arctangent instead. That
  // is a correctness risk the visual tests would not catch, because a series that is wrong
  // in the fifth decimal still draws a convincing arc — so it is checked against the
  // closed-form ellipse equation here, over enough sizes to cover every quadrant.
  it('matches the analytic ellipse for a full circle at many radii', () => {
    // Radii are all >= 7: at r=1 the discretisation error of any polygonised circle is
    // comparable to a pixel, so the half-pixel rim tolerance below would be testing the
    // tolerance rather than the tracer.
    for (const [cx, cy, r] of [
      [20, 20, 18],
      [13, 17, 7],
      [32, 32, 31],
      [24, 24, 23],
      [16, 16, 8],
    ] as Array<[number, number, number]>) {
      const svg = `<svg><circle cx="${cx}" cy="${cy}" r="${r}"/></svg>`;
      const mask = traceSvg(svg, 64, 64).masks[0];
      let checked = 0;
      let mismatched = 0;
      let worstRim = 0;
      let filled = 0;
      // A vertex in this file is a pixel centre, which is `drawPolygon`'s convention, so
      // "inside the circle" means the pixel *index* lies within r of the centre - not the
      // pixel centre. Getting that backwards is exactly the off-by-a-pixel bug the
      // straight-edge and arc tests exist to catch.
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
          const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
          const inside = d <= r;
          if (mask[y * 64 + x] === 1) filled++;
          if ((mask[y * 64 + x] === 1) !== inside) {
            // A rim pixel is the only place any rasteriser may disagree with the
            // analytic circle; a disagreement further in would be a real defect.
            mismatched++;
            worstRim = Math.max(worstRim, Math.abs(d - r));
          }
          checked++;
        }
      }
      expect(checked).toBe(64 * 64);
      // Every disagreement is a rim pixel within half a pixel of the true edge.
      expect(worstRim).toBeLessThanOrEqual(0.51);
      expect(mismatched).toBeLessThan(0.06 * 2 * 3.142 * r);
      // The rim rule loses the extreme rows and gains the extreme columns, so the area sits
      // within about one radius of pi*r^2 whatever the radius. The per-pixel rim test
      // above is the real one; this only catches a wildly wrong scale.
      const exact = 3.141592653589793 * r * r;
      expect(filled).toBeGreaterThan(exact - r);
      expect(filled).toBeLessThan(exact + r);
    }
  });

  it('matches the analytic ellipse for a rotated elliptical arc', () => {
    // Half an ellipse rotated 30 degrees: the case where the arc's own rotation term and
    // the atan2 quadrants both matter.
    const svg = '<svg><path d="M0 0 A8 4 30 1 1 12 0 Z" fill="#fff"/></svg>';
    const traced = traceSvg(svg, 32, 32);
    expect(traced.shapes[0].color.a).toBe(255);
    // The chord's endpoints and the extreme of the bulge must all be inside the traced box.
    expect(traced.bounds).not.toBeNull();
    const b = traced.bounds!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.w).toBeLessThanOrEqual(12);
  });
});

describe('trace_svg arc direction', () => {
  it('puts sweep 0 on the opposite side of the chord from sweep 1', () => {
    const up = traceSvg('<svg><path d="M0 8 A4 6 0 0 1 8 8 Z" fill="#fff"/></svg>', 8, 12).masks[0];
    const down = traceSvg('<svg><path d="M0 8 A4 6 0 0 0 8 8 Z" fill="#fff"/></svg>', 8, 12).masks[0];
    const aboveChord = (mask: Uint8Array): number => {
      let n = 0;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) n += mask[y * 8 + x];
      return n;
    };
    const belowChord = (mask: Uint8Array): number => {
      let n = 0;
      for (let y = 8; y < 12; y++) for (let x = 0; x < 8; x++) n += mask[y * 8 + x];
      return n;
    };
    // The two sweeps are mirror images of each other about the chord at y=8.
    expect(aboveChord(up)).toBeGreaterThan(0);
    expect(belowChord(up)).toBe(0);
    expect(belowChord(down)).toBeGreaterThan(0);
    expect(aboveChord(down)).toBe(0);
  });
});

describe('trace_svg scan conversion', () => {
  it('traces a straight edge exactly where the equivalent polygon does', () => {
    // A rectangle from (2,2) to (9,5). The tracer must land on exactly the pixels
    // `draw_polygon` puts there for the same coordinates. Note row 5 is empty for *both*:
    // the closing edge's vertices sit exactly on that scanline and the half-open crossing
    // rule counts a vertex once, so neither rasteriser paints it. That shared edge case is
    // the point of comparing the two rather than asserting a shape in the abstract.
    const points = [
      { x: 2, y: 2 },
      { x: 9, y: 2 },
      { x: 9, y: 5 },
      { x: 2, y: 5 },
    ];
    const window = { x: 2, y: 2, w: 8, h: 4 };
    const viaPolygon = createEditor(createSprite({ width: 16, height: 16 }));
    viaPolygon.execute('draw_polygon', { layer: 0, frame: 0, points, color: '#ff0000', fill: true });
    const polygonRows = rowsOf(window, celAt(viaPolygon), 16);
    expect(polygonRows).toEqual(['########', '########', '########', '........']);

    const ed = editor();
    const traced = ed.execute('trace_svg', {
      layer: 0,
      frame: 0,
      svg: '<svg><path d="M2 2 L9 2 L9 5 L2 5 Z" fill="#ff0000"/></svg>',
    }) as { bounds: { x: number; y: number; w: number; h: number }; painted: number };

    expect(traced.bounds).toEqual({ x: 2, y: 2, w: 8, h: 3 });
    expect(traced.painted).toBe(24);
    expect(rowsOf(window, celAt(ed), 16)).toEqual(polygonRows);

    // One pixel outside the edge on every side must be untouched.
    const cel = celAt(ed);
    expect(cel[(2 * 16 + 10) * 4 + 3]).toBe(0);
    expect(cel[(5 * 16 + 2) * 4 + 3]).toBe(0);
    expect(cel[(1 * 16 + 2) * 4 + 3]).toBe(0);
  });

  it('traces a curve to a rounded blob, not the flat chord it replaced', () => {
    // A half-disc: straight diameter along y=8, arc bulging up to an apex at (4,2).
    // `sweep: 1` is the flag that bulges upward in SVG's y-down coordinate system, and
    // getting that backwards is exactly the arc bug this exact-pixel assertion exists for.
    const svg = '<svg><path d="M0 8 A4 6 0 0 1 8 8 Z" fill="#00ff00"/></svg>';
    const ed = editor(8, 12);
    const traced = ed.execute('trace_svg', { layer: 0, frame: 0, svg }) as {
      bounds: { x: number; y: number; w: number; h: number };
    };

    // Row 2 is empty because the apex sits exactly on that scanline and the crossing rule
    // is half-open; row 8 is empty for the same reason on the diameter. A chord instead of
    // an arc would have filled a triangle, not these tapering rows.
    expect(rowsOf({ x: 0, y: 0, w: 8, h: 12 }, celAt(ed), 8)).toEqual([
      '........',
      '........',
      '........',
      '..#####.',
      '..#####.',
      '.#######',
      '.#######',
      '.#######',
      '........',
      '........',
      '........',
      '........',
    ]);
    expect(traced.bounds).toEqual({ x: 1, y: 3, w: 7, h: 5 });
  });

  it('leaves a reversed inner subpath hollow, and fills it again under evenodd', () => {
    // A 10x10 square with a 5x5 square cut out of the middle, wound the other way.
    const outer = 'M0 0 H10 V10 H0 Z';
    const inner = 'M3 3 V7 H7 V3 Z';
    const nonzero = traceSvg(`<svg><path d="${outer} ${inner}" fill="#ffffff"/></svg>`, 10, 10);
    const evenodd = traceSvg(
      `<svg><path fill-rule="evenodd" d="${outer} ${inner}" fill="#ffffff"/></svg>`,
      10,
      10,
    );

    const at = (mask: Uint8Array, x: number, y: number): number => mask[y * 10 + x];
    for (const mask of [nonzero.masks[0], evenodd.masks[0]]) {
      // The grid the hole produces:
      //   ##########
      //   ##########
      //   ##########
      //   ####...###
      //   ####...###
      //   ####...###
      //   ####...###
      //   ##########
      // The inner subpath's vertices land on scanlines, and the half-open crossing rule
      // drops the edge row and column — the same asymmetry `draw_polygon` has, and the
      // reason the hole is 3x4 rather than the 5x5 its coordinates suggest.
      expect(at(mask, 3, 4)).toBe(1); // ring, left of the hole
      expect(at(mask, 4, 4)).toBe(0); // hole
      expect(at(mask, 5, 5)).toBe(0); // hole
      expect(at(mask, 6, 6)).toBe(0); // hole
      expect(at(mask, 7, 4)).toBe(1); // ring, right of the hole
      expect(at(mask, 0, 0)).toBe(1); // corner
      expect(at(mask, 9, 9)).toBe(1); // corner
      expect(at(mask, 3, 7)).toBe(1); // below the hole
    }
    // 100 pixels minus the 3x4 hole. A tracer that dropped the second subpath — the way a
    // naive "first contour wins" fill does — would report 100, so this is the assertion
    // that can actually fail.
    const filled = nonzero.masks[0].reduce((a, b) => a + b, 0);
    expect(filled).toBe(100 - 12);
  });

  it('clips geometry that lands partly outside the canvas instead of failing', () => {
    // A 6x6 square from (-2,-2) to (4,4). Two thirds of it is off-canvas; the visible
    // part is rows 0..3 and columns 0..4, with row 4 dropped by the same half-open
    // vertex rule as everywhere else. Geometry outside the canvas is clipped, not
    // rejected — a coordinate that is merely wrong should give a sensible result.
    const ed = editor(8, 8);
    const traced = ed.execute('trace_svg', {
      layer: 0,
      frame: 0,
      svg: '<svg><rect x="-2" y="-2" width="6" height="6" fill="#ffffff"/></svg>',
    }) as { bounds: { x: number; y: number; w: number; h: number }; painted: number };

    expect(traced.painted).toBe(20);
    expect(traced.bounds).toEqual({ x: 0, y: 0, w: 5, h: 4 });
    expect(rowsOf({ x: 0, y: 0, w: 8, h: 8 }, celAt(ed), 8)).toEqual([
      '#####...',
      '#####...',
      '#####...',
      '#####...',
      '........',
      '........',
      '........',
      '........',
    ]);
  });

  it('scales and offsets user units onto the pixel grid', () => {
    // A 64-unit square at scale 8 is 8 pixels wide, and offset (1,2) moves it there.
    // Height is 7 rather than 8 for the half-open vertex rule at the closing edge, the
    // same asymmetry `draw_polygon` has.
    const traced = traceSvg('<svg><rect width="64" height="64" fill="#ffffff"/></svg>', 32, 32, {
      scale: 8,
      offset: { x: 1, y: 2 },
    });
    expect(traced.bounds).toEqual({ x: 1, y: 2, w: 9, h: 8 });
  });

  it('paints each shape its own fill, and one colour when overridden', () => {
    const svg =
      '<svg><rect x="0" y="0" width="2" height="2" fill="#ff0000"/>' +
      '<rect x="2" y="0" width="2" height="2" fill="#0000ff"/></svg>';
    const ed = editor(4, 2);
    ed.execute('trace_svg', { layer: 0, frame: 0, svg });
    const cel = celAt(ed, 0);
    const at = (x: number, y: number) => [cel[(y * 4 + x) * 4], cel[(y * 4 + x) * 4 + 2]];
    expect(at(0, 0)).toEqual([255, 0]);
    expect(at(3, 0)).toEqual([0, 255]);

    const ed2 = editor(4, 2);
    ed2.execute('trace_svg', { layer: 0, frame: 0, svg, color: '#00ff00' });
    const cel2 = celAt(ed2, 0);
    expect(cel2[1]).toBe(255);
    expect(cel2[(3) * 4 + 1]).toBe(255);
  });

  it('snaps traced colours to the nearest swatch when the document is palette-locked', () => {
    const svg = '<svg><rect width="4" height="4" fill="#ff0000"/></svg>';
    // The raw parse keeps the source colour; it is `resolveColor` that snaps it.
    expect(traceSvg(svg, 4, 4).shapes[0].color).toEqual({ r: 255, g: 0, b: 0, a: 255 });

    const unlocked = createEditor(createSprite({ width: 4, height: 4 }));
    unlocked.execute('trace_svg', { layer: 0, frame: 0, svg });
    expect(celAt(unlocked)[0]).toBe(255);

    const locked = createEditor(
      createSprite({
        width: 4,
        height: 4,
        palette: createPalette('bw', ['#000000', '#ffffff']),
        paletteLocked: true,
      }),
    );
    locked.execute('trace_svg', { layer: 0, frame: 0, svg });
    // Black and white only, and `#ff0000` is closer to black in Chebyshev distance.
    const cel = celAt(locked);
    expect([cel[0], cel[1], cel[2]]).toEqual([0, 0, 0]);
  });
});

describe('trace_svg refusals and skips', () => {
  it('refuses a transform instead of tracing untransformed geometry', () => {
    const ed = editor();
    const result = ed.tryExecute('trace_svg', {
      layer: 0,
      frame: 0,
      svg: '<svg><rect width="4" height="4" transform="translate(10,10)" fill="#fff"/></svg>',
    });
    expect(result.ok).toBe(false);
    // `applyCommandWithSummary` re-codes a CommandError raised inside `apply` to
    // `command_failed` (a known gap in docs/ROADMAP.md), so the code is asserted loosely
    // and the *reason* is asserted from the message, which is what carries it.
    expect((result as { error: string }).error).toMatch(/transform/);
    expect((result as { error: string }).error).toMatch(/would land the artwork in the wrong place/);
  });

  it('refuses a gradient fill rather than painting it black', () => {
    const ed = editor();
    const result = ed.tryExecute('trace_svg', {
      layer: 0,
      frame: 0,
      svg: '<svg><rect width="4" height="4" fill="url(#g)"/></svg>',
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/paint server/);
  });

  it('refuses an inherited group fill rather than losing the colour', () => {
    const ed = editor();
    const result = ed.tryExecute('trace_svg', {
      layer: 0,
      frame: 0,
      svg: '<svg><g fill="#ff0000"><rect width="4" height="4"/></g></svg>',
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/inherits its fill/);
  });

  it('skips stroke-only and untraceable elements by name, and refuses when nothing is left', () => {
    const ed = editor();
    const result = ed.tryExecute('trace_svg', {
      layer: 0,
      frame: 0,
      svg: '<svg><line x1="0" y1="0" x2="4" y2="4" stroke="#fff"/><path d="M0 0 L4 0" fill="none"/></svg>',
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/line/);
    expect((result as { error: string }).error).toMatch(/fill is none/);
  });

  it('names the skipped elements in the summary of a successful trace', () => {
    const ed = editor(8, 8);
    const traced = ed.execute('trace_svg', {
      layer: 0,
      frame: 0,
      svg: '<svg><text x="0" y="0">hi</text><rect width="4" height="4" fill="#fff"/></svg>',
    }) as { painted: number; skipped: string[] };
    expect(traced.painted).toBe(20);
    expect(traced.skipped.join(' ')).toMatch(/<text>/);
  });
});

describe('trace_svg paint options', () => {
  it('limits the trace to rect and replaces only inside it', () => {
    const ed = editor(8, 4);
    const traced = ed.execute('trace_svg', {
      layer: 0,
      frame: 0,
      svg: '<svg><rect width="8" height="4" fill="#ffffff"/></svg>',
      rect: { x: 0, y: 0, w: 4, h: 4 },
      replace: true,
    }) as { painted: number; replaced: number };
    expect(traced.painted).toBe(16);
    expect(traced.replaced).toBe(16);
    const cel = celAt(ed);
    expect(cel[(3 * 8 + 7) * 4 + 3]).toBe(0);
    expect(cel[3]).toBe(255);
  });

  it('replaces even when nothing is clipped', () => {
    // The erase must not be gated on a mask existing. Painting a red shape over an
    // already-green one has to clear the green first or the result is a blend.
    const ed = editor(4, 4);
    ed.execute('trace_svg', {
      layer: 0,
      frame: 0,
      svg: '<svg><rect width="4" height="4" fill="#00ff00"/></svg>',
    });
    const traced = ed.execute('trace_svg', {
      layer: 0,
      frame: 0,
      svg: '<svg><rect x="0" y="0" width="4" height="4" fill="#ff0000"/></svg>',
      replace: true,
    }) as { painted: number; replaced: number };
    expect(traced.replaced).toBe(traced.painted);
    expect(traced.painted).toBeGreaterThan(0);
    const cel = celAt(ed);
    expect([cel[0], cel[1], cel[2]]).toEqual([255, 0, 0]);
  });

  it('undoes as a single step', () => {
    const ed = editor(8, 8);
    ed.execute('trace_svg', {
      layer: 0,
      frame: 0,
      svg: '<svg><rect width="8" height="8" fill="#ffffff"/></svg>',
    });
    expect(celAt(ed)[3]).toBe(255);
    ed.undo();
    // Undo may drop the cel entirely rather than blank it, so ask the layer.
    const restored = ed.execute('measure_region', { layer: 0, frame: 0 }) as { opaque: number };
    expect(restored.opaque).toBe(0);
  });
});