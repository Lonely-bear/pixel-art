import { describe, expect, it } from 'vitest';
import { PixelBuffer } from '../src/buffer.js';
import {
  EMPTY_CHAR,
  VALUE_RAMP,
  describeColor,
  diffGridRows,
  formatGrid,
  formatGridDiff,
  luminanceOf,
  renderGridView,
  rowsFromCells,
} from '../src/grid.js';
import type { Color, Rect } from '../src/types.js';

const FULL: Rect = { x: 0, y: 0, w: 4, h: 3 };

/** The ruler rows, with the y-gutter padding stripped. */
function rulerOf(out: string, row: number): string {
  return out.split('\n')[row].trim();
}

function dataRows(out: string): string[] {
  return out
    .split('\n')
    .filter((line) => /^\s*\d+ \| /.test(line))
    .map((line) => line.slice(line.indexOf('| ') + 2));
}

function buffer(width: number, height: number, paint: (x: number, y: number) => Color | null): PixelBuffer {
  const buf = PixelBuffer.empty(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = paint(x, y);
      if (c) buf.setColor(x, y, c);
    }
  }
  return buf;
}

const BLACK: Color = { r: 0, g: 0, b: 0, a: 255 };
const WHITE: Color = { r: 255, g: 255, b: 255, a: 255 };
const RED: Color = { r: 255, g: 0, b: 0, a: 255 };

describe('luminanceOf', () => {
  it('weights the channels the way the eye does', () => {
    expect(luminanceOf(WHITE)).toBeCloseTo(255, 5);
    expect(luminanceOf(BLACK)).toBe(0);
    // Green carries most of the perceived brightness, so pure green is far above
    // pure blue at the same nominal intensity.
    expect(luminanceOf({ r: 0, g: 255, b: 0, a: 255 })).toBeGreaterThan(
      luminanceOf({ r: 0, g: 0, b: 255, a: 255 }),
    );
  });
});

describe('describeColor', () => {
  it('names neutrals by lightness rather than by hue', () => {
    expect(describeColor(BLACK)).toBe('black');
    expect(describeColor(WHITE)).toBe('white');
    expect(describeColor({ r: 100, g: 100, b: 100, a: 255 })).toBe('dark gray');
  });

  it('combines a tone word with a hue for chromatic colours', () => {
    expect(describeColor({ r: 90, g: 20, b: 20, a: 255 })).toBe('very dark red');
    expect(describeColor({ r: 255, g: 128, b: 0, a: 255 })).toBe('mid orange');
    expect(describeColor({ r: 20, g: 40, b: 120, a: 255 })).toBe('dark blue');
    expect(describeColor({ r: 20, g: 30, b: 60, a: 255 })).toBe('very dark blue');
    expect(describeColor({ r: 60, g: 90, b: 200, a: 255 })).toBe('mid blue');
  });
});

describe('renderGridView: mask', () => {
  it('draws opaque pixels as # and everything else as the empty character', () => {
    const buf = buffer(4, 3, (x, y) => (x === 1 || x === 2) && y === 1 ? RED : null);
    const render = renderGridView(buf, FULL, 'mask');
    expect(render.rows).toEqual([
      '....',
      '.##.',
      '....',
    ]);
    expect(render.opaque).toBe(2);
    expect(render.total).toBe(12);
  });

  it('counts a semi-transparent pixel as opaque and reports it separately', () => {
    const buf = buffer(2, 1, () => ({ r: 255, g: 0, b: 0, a: 128 }));
    const render = renderGridView(buf, { x: 0, y: 0, w: 2, h: 1 }, 'mask');
    expect(render.rows[0]).toBe('##');
    expect(render.opaque).toBe(2);
    expect(render.partialAlpha).toBe(2);
  });
});

describe('renderGridView: value', () => {
  it('never uses the empty character or whitespace in the ladder', () => {
    // The whole point: a grid whose dark side is blank reads as an empty row, and a
    // model cannot count spaces.
    expect(VALUE_RAMP).not.toContain(' ');
    expect(VALUE_RAMP).not.toContain(EMPTY_CHAR);

    const buf = buffer(3, 1, (x) => [BLACK, { r: 128, g: 128, b: 128, a: 255 }, WHITE][x]);
    const render = renderGridView(buf, { x: 0, y: 0, w: 3, h: 1 }, 'value');
    for (const char of render.rows[0]) {
      expect(char).not.toBe(EMPTY_CHAR);
      expect(char).not.toBe(' ');
    }
  });

  it('gives each distinct tone its own glyph', () => {
    // Five deliberate ramp steps must not collapse into two. Fixed 0-255 bucketing
    // routinely merges them, which would report two tones as one.
    const steps = [0, 40, 80, 160, 240].map((v) => ({ r: v, g: v, b: v, a: 255 }) as Color);
    const buf = buffer(5, 1, (x) => steps[x]);
    const render = renderGridView(buf, { x: 0, y: 0, w: 5, h: 1 }, 'value');
    expect(render.levels).toBe(5);
    expect(new Set(render.rows[0].split('')).size).toBe(5);
    expect(render.valueRange).toEqual([0, 240]);
  });

  it('orders the glyphs so a darker pixel always gets a lower character', () => {
    const buf = buffer(3, 1, (x) => [WHITE, BLACK, { r: 128, g: 128, b: 128, a: 255 }][x]);
    const render = renderGridView(buf, { x: 0, y: 0, w: 3, h: 1 }, 'value');
    const [white, black, mid] = render.rows[0].split('');
    expect(VALUE_RAMP.indexOf(white)).toBeGreaterThan(VALUE_RAMP.indexOf(mid));
    expect(VALUE_RAMP.indexOf(mid)).toBeGreaterThan(VALUE_RAMP.indexOf(black));
  });

  it('spreads a short ramp across the ladder instead of packing it into the dark end', () => {
    const steps = [0, 60, 120].map((v) => ({ r: v, g: v, b: v, a: 255 }) as Color);
    const render = renderGridView(
      buffer(3, 1, (x) => steps[x]),
      { x: 0, y: 0, w: 3, h: 1 },
      'value',
    );
    const positions = render.rows[0].split('').map((c) => VALUE_RAMP.indexOf(c));
    // Three tones over a ten-rung ladder: first and last land on the extremes.
    expect(positions[0]).toBe(0);
    expect(positions[2]).toBe(VALUE_RAMP.length - 1);
    expect(positions[1]).toBeGreaterThan(0);
  });

  it('falls back to uniform buckets and says so when there are more tones than rungs', () => {
    const buf = buffer(VALUE_RAMP.length + 5, 1, (x) => ({
      r: x * 5,
      g: x * 5,
      b: x * 5,
      a: 255,
    }));
    const render = renderGridView(buf, { x: 0, y: 0, w: VALUE_RAMP.length + 5, h: 1 }, 'value');
    expect(render.levels).toBe(VALUE_RAMP.length);
    expect(render.legend).toHaveLength(VALUE_RAMP.length);
  });

  it('handles a single tone without dividing by zero', () => {
    const render = renderGridView(
      buffer(2, 1, () => RED),
      { x: 0, y: 0, w: 2, h: 1 },
      'value',
    );
    expect(render.levels).toBe(1);
    expect(new Set(render.rows[0].split('')).size).toBe(1);
  });

  it('reports an empty region as all-empty rather than inventing tones', () => {
    const render = renderGridView(PixelBuffer.empty(4, 3), FULL, 'value');
    expect(render.rows).toEqual(['....', '....', '....']);
    expect(render.opaque).toBe(0);
    expect(render.levels).toBe(0);
    expect(render.legend).toEqual([]);
  });
});

describe('renderGridView: index', () => {
  it('labels each pixel with its palette slot so a draw can name it', () => {
    const palette: Color[] = [BLACK, RED, WHITE];
    const buf = buffer(3, 1, (x) => [BLACK, RED, WHITE][x]);
    const render = renderGridView(buf, { x: 0, y: 0, w: 3, h: 1 }, 'index', palette);
    expect(render.rows[0]).toBe('012');
    expect(render.legend[1]).toMatchObject({ char: '1', index: 1, hex: '#ff0000' });
  });

  it('marks an off-palette colour as unmapped and counts it', () => {
    const palette: Color[] = [BLACK];
    const buf = buffer(2, 1, (x) => (x === 0 ? BLACK : { r: 1, g: 2, b: 3, a: 255 }));
    const render = renderGridView(buf, { x: 0, y: 0, w: 2, h: 1 }, 'index', palette);
    expect(render.rows[0]).toBe('0?');
    expect(render.unmapped).toBe(1);
  });

  it('spells slots past nine with letters, in slot order', () => {
    const palette: Color[] = Array.from({ length: 12 }, (_, i) => ({
      r: i * 20,
      g: i * 20,
      b: i * 20,
      a: 255,
    }));
    const buf = buffer(12, 1, (x) => palette[x]);
    const render = renderGridView(buf, { x: 0, y: 0, w: 12, h: 1 }, 'index', palette);
    expect(render.rows[0]).toBe('0123456789ab');
  });
});

describe('renderGridView: named', () => {
  it('names each distinct colour and leaves empty cells empty', () => {
    const buf = buffer(3, 1, (x) => (x === 1 ? { r: 90, g: 20, b: 20, a: 255 } : null));
    const render = renderGridView(buf, { x: 0, y: 0, w: 3, h: 1 }, 'named');
    expect(render.rows[0]).toBe(`.${render.legend[0].char}.`);
    expect(render.legend[0].label).toContain('very dark red');
  });

  it('merges near-identical colours so the answer is a material, not a list of near-duplicates', () => {
    // Two reds two steps apart are one material to a reader; listing both would answer
    // "which material is this" with a list that defeats the question.
    const buf = buffer(2, 1, (x) => ({ r: 200 + x, g: 40, b: 40, a: 255 }));
    const render = renderGridView(buf, { x: 0, y: 0, w: 2, h: 1 }, 'named');
    expect(new Set(render.rows[0].split('')).size).toBe(1);
  });

  it('numbers the slots dark to light so the grid still reads as a value grid', () => {
    const buf = buffer(3, 1, (x) => [WHITE, BLACK, RED][x]);
    const render = renderGridView(buf, { x: 0, y: 0, w: 3, h: 1 }, 'named');
    const chars = render.rows[0].split('');
    // Sorted by luminance, so the darkest colour is slot 0.
    expect(chars[1]).toBe(render.legend[0].char);
    expect(luminanceOf({ r: 255, g: 0, b: 0, a: 255 })).toBeGreaterThan(0);
    expect(chars[0]).not.toBe(chars[1]);
  });
});

describe('renderGridView: clipping', () => {
  it('clips a region that runs off the canvas instead of throwing', () => {
    const buf = buffer(4, 4, () => WHITE);
    const render = renderGridView(buf, { x: 2, y: 2, w: 10, h: 10 }, 'mask');
    expect(render.rect).toEqual({ x: 2, y: 2, w: 2, h: 2 });
    expect(render.rows).toEqual(['##', '##']);
  });

  it('normalises a backwards rect', () => {
    const buf = buffer(4, 4, () => WHITE);
    const render = renderGridView(buf, { x: 3, y: 3, w: -2, h: -2 }, 'mask');
    expect(render.rect).toEqual({ x: 1, y: 1, w: 2, h: 2 });
  });

  it('keeps every row exactly as wide as the region', () => {
    const buf = buffer(6, 5, (x, y) => (x + y) % 3 === 0 ? WHITE : null);
    const render = renderGridView(buf, { x: 1, y: 1, w: 3, h: 2 }, 'mask');
    for (const row of render.rows) expect(row).toHaveLength(3);
  });
});

describe('diffGridRows', () => {
  it('reports nothing when the grids match', () => {
    const diff = diffGridRows(['ab', 'cd'], ['ab', 'cd'], 0);
    expect(diff.changedRows).toBe(0);
    expect(diff.changedPixels).toBe(0);
    expect(diff.entries).toEqual([]);
  });

  it('reports absolute row numbers so a cell can be acted on', () => {
    const diff = diffGridRows(['ab', 'cd', 'ef'], ['ab', 'cd', 'eZ'], 10);
    expect(diff.changedRows).toBe(1);
    expect(diff.changedPixels).toBe(1);
    expect(diff.entries).toEqual([{ y: 12, was: 'ef', now: 'eZ' }]);
  });

  it('carries the before and after of a whole row, not per-pixel triples', () => {
    // Two strings side by side is what a model can actually read; forty coordinate
    // triples is not.
    const diff = diffGridRows(['....', '....'], ['..##', '.#.#'], 0);
    expect(diff.entries).toEqual([
      { y: 0, was: '....', now: '..##' },
      { y: 1, was: '....', now: '.#.#' },
    ]);
    expect(diff.changedPixels).toBe(4);
  });

  it('counts a region that grew or shrank as a change', () => {
    const diff = diffGridRows(['ab'], ['ab', 'cd'], 0);
    expect(diff.changedRows).toBe(1);
    expect(diff.entries[0]).toMatchObject({ y: 1, was: '', now: '<1 row(s)>' });
  });
});

describe('formatGrid', () => {
  const render = renderGridView(
    buffer(12, 3, (x, y) => (y === 1 && x >= 2 && x <= 5 ? WHITE : null)),
    { x: 0, y: 0, w: 12, h: 3 },
    'mask',
  );

  it('prints two ruler rows because a single row of ones digits is ambiguous', () => {
    const out = formatGrid(render, { view: 'mask', scope: 'composite', frame: 0 });
    // The gutter is as wide as the widest y label, so the rulers line up with the data.
    expect(rulerOf(out, 3)).toBe('000000000011');
    expect(rulerOf(out, 4)).toBe('012345678901');
  });

  it('labels every row with its absolute y', () => {
    const rows = dataRows(formatGrid(render, { view: 'mask', scope: 'composite', frame: 0 }));
    expect(rows).toEqual(['............', '..####......', '............']);
  });

  it('keeps the rulers aligned with the data columns', () => {
    const out = formatGrid(render, { view: 'mask', scope: 'composite', frame: 0 });
    const lines = out.split('\n');
    const rulerStart = lines.findIndex((l) => /^ *\d+$/.test(l));
    const dataStart = lines.findIndex((l) => /^\s*\d+ \| /.test(l));
    // Column 0 of the ruler is column 0 of every data row, or the whole grid lies and
    // every coordinate in it is off by the gutter width.
    expect(lines[rulerStart].search(/\d/)).toBe(lines[dataStart].indexOf('| ') + 2);
  });

  it('names what the characters mean', () => {
    const out = formatGrid(render, { view: 'mask', scope: 'composite', frame: 0 });
    expect(out).toContain('# opaque');
    expect(out).toContain('opaque 4/36');
  });

  it('states the region and the frame in the header', () => {
    const out = formatGrid(render, { view: 'mask', scope: 'cel', frame: 2, layer: 'base', frameCount: 4 });
    expect(out).toContain('view=mask');
    expect(out).toContain('frame=2/3');
    expect(out).toContain('scope=cel');
    expect(out).toContain('layer=base');
    expect(out).toContain('rect=12x3 at (0, 0)');
  });

  it('says so in numbers when the region holds no artwork', () => {
    const out = formatGrid(
      renderGridView(PixelBuffer.empty(4, 2), { x: 0, y: 0, w: 4, h: 2 }, 'mask'),
      { view: 'mask', scope: 'composite', frame: 0 },
    );
    expect(out).toContain('opaque 0/8');
    expect(out).toContain('nothing drawn in this region');
  });

  it('reports a zero-sized region in one line', () => {
    const out = formatGrid(
      renderGridView(PixelBuffer.empty(4, 2), { x: 2, y: 0, w: 0, h: 2 }, 'mask'),
      { view: 'mask', scope: 'composite', frame: 0 },
    );
    expect(out).toBe('0x2 region is empty');
  });
});

describe('formatGridDiff', () => {
  it('reports only the pixels that moved when the ladder re-ranks', () => {
    // The real failure this guards: the `value` ladder is ranked over the tones
    // present, so introducing a tone re-labels every other glyph. Diffing the glyphs
    // would report the whole region as changed when two pixels were edited.
    const before = PixelBuffer.empty(4, 1);
    before.fill({ r: 200, g: 200, b: 200, a: 255 });
    const after = before.clone();
    after.setColor(0, 0, { r: 0, g: 0, b: 0, a: 255 });
    after.setColor(1, 0, { r: 255, g: 255, b: 255, a: 255 });

    const rect = { x: 0, y: 0, w: 4, h: 1 };
    const first = renderGridView(before, rect, 'value');
    const second = renderGridView(after, rect, 'value');
    // Sanity: the two reads really do disagree on every cell's glyph.
    expect(second.rows[0]).not.toBe(first.rows[0]);

    const diff = diffGridRows(
      rowsFromCells(first.cells, second.rect, second),
      second.rows,
      0,
    );
    expect(diff.changedPixels).toBe(2);
    expect(diff.entries[0].now).toBe(second.rows[0]);
  });

  it('re-renders stored cells through the current mapping, not the old one', () => {
    // Two tones spread across the ladder, then a third is introduced. The unchanged
    // mid-tone moves to a different rung, so the reconstructed "before" has to be drawn
    // with the new mapping - otherwise the diff claims every cell changed.
    const before = PixelBuffer.empty(3, 1);
    before.fill({ r: 100, g: 100, b: 100, a: 255 });
    before.setColor(1, 0, { r: 200, g: 200, b: 200, a: 255 });
    const after = before.clone();
    after.setColor(0, 0, { r: 50, g: 50, b: 50, a: 255 });

    const rect = { x: 0, y: 0, w: 3, h: 1 };
    const first = renderGridView(before, rect, 'value');
    const second = renderGridView(after, rect, 'value');
    expect(first.levels).toBe(2);
    expect(second.levels).toBe(3);

    const beforeRows = rowsFromCells(first.cells, second.rect, second);
    expect(beforeRows[0]).not.toBe(first.rows[0]);
    // Only the pixel that was actually painted.
    expect(diffGridRows(beforeRows, second.rows, 0).changedPixels).toBe(1);
  });

  it('leaves transparent cells transparent when reconstructing', () => {
    const buf = buffer(3, 1, (x) => (x === 1 ? WHITE : null));
    const render = renderGridView(buf, { x: 0, y: 0, w: 3, h: 1 }, 'value');
    expect(rowsFromCells(render.cells, render.rect, render)).toEqual(render.rows);
  });

  it('summarises and shows before/after rows', () => {
    const text = formatGridDiff(
      diffGridRows(['ab'], ['aZ'], 4),
      'changed since the previous read_grid',
    );
    expect(text).toContain('1 of 1 rows, 1 pixel(s) changed');
    expect(text).toContain('y=4  was "ab"  now "aZ"');
  });

  it('stays honest about a diff with no printable rows', () => {
    const text = formatGridDiff(
      { changedRows: 0, changedPixels: 0, totalRows: 2, entries: [], omitted: 0 },
      'changed',
    );
    expect(text).toContain('(rows differ only in length)');
  });
});
