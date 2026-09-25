/**
 * Text views of a pixel surface.
 *
 * ## Why this exists
 *
 * A preview PNG is the right tool for one question - *does this look good?* - and the
 * wrong tool for every other question an agent asks while drawing: is the silhouette
 * symmetric, which tone is in row 14, did that last edit touch the right pixels, does
 * the sprite still fit the canvas. Answering those by looking at a downsampled image
 * costs a round trip, is unreliable at 32x32, and has to be redone from scratch after
 * every edit because the model cannot diff a picture.
 *
 * A character grid answers all of them losslessly and cheaply. A 32x32 `value` view is
 * 32 lines of 32 characters - about 350 tokens, less than the PNG it replaces - and
 * because it is text it is diffable, countable and quotable. The model is better at
 * reading, comparing and editing character grids than at reasoning about a thumbnail,
 * and it is the only representation in which "row 14 is one step lighter than row 13" is
 * a fact rather than an impression.
 *
 * So the split is deliberate: **this is how you verify, the PNG is how you approve.**
 *
 * ## Views
 *
 * Each view answers a different question, and each is one character per pixel so the
 * grid stays rectangular and the rulers line up:
 *
 *  - `mask`  - silhouette. `#` opaque, `.` transparent. Symmetry, holes, proportions.
 *  - `value` - luminance ladder. Form, lighting, and whether shading collapsed.
 *  - `index` - palette slot. Which slot, so the next draw can name it as `pal:7`.
 *  - `named` - generated colour names. Which *material*, without decoding hex.
 *
 * `.` always means transparent and never appears in a ramp, so a cell is either empty
 * or a value - there is no third state to disambiguate.
 */
import { PixelBuffer } from './buffer.js';
import { colorToHex, packColor } from './color.js';
import { clipRect, rectIsEmpty } from './geometry.js';
import type { Color, Rect } from './types.js';

export type GridView = 'mask' | 'index' | 'value' | 'named';

/**
 * Luminance ladder, darkest first.
 *
 * Two constraints shaped it. No whitespace: a model cannot reliably count spaces, and a
 * grid whose dark side is invisible reads as empty rows. And no `.`: that character is
 * reserved for transparent, so every ladder step stays distinguishable from "nothing
 * here". The ladder is then spread across the ramp rather than packed into its first
 * characters, so a five-tone ramp gets five evenly-weighted glyphs instead of five
 * cramped dark ones.
 */
export const VALUE_RAMP = '::-=+*oO#%@';

/** Transparent, in every view. Never a member of {@link VALUE_RAMP}. */
export const EMPTY_CHAR = '.';

/** Opaque but unassignable: an off-palette colour in the `index` view. */
export const UNKNOWN_CHAR = '?';

/** Characters used to number the distinct colours of the `index` and `named` views. */
export const SLOT_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';

/** `cells` value for a transparent pixel. Negative, so it cannot collide with a tone. */
export const TRANSPARENT_CELL = -1;
/** `cells` value for an opaque pixel the view cannot assign a character to. */
export const UNMAPPED_CELL = -2;

/** Rec. 709 relative luminance, 0-255. The same weighting the quality report uses. */
export function luminanceOf(c: { r: number; g: number; b: number }): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

export interface GridLegendEntry {
  /** The character that appears in the grid. */
  char: string;
  /** What it means, ready to print: `"mid blue #4a6fa5"`. */
  label: string;
  /** Palette slot, for the `index` view. */
  index?: number;
  /** Representative colour, for the `index` and `named` views. */
  hex?: string;
  /** Relative luminance 0-255, for the `value` view. */
  luminance?: number;
}

export interface GridRender {
  view: GridView;
  /** The region the rows cover, in absolute canvas pixels. */
  rect: Rect;
  /** One string per row of {@link rect}, row-major, exactly `rect.w` characters long. */
  rows: string[];
  /**
   * A stable numeric identity per cell, row-major, same length as `rect`.
   *
   * This exists because the rendered glyph is not stable. The `value` ladder is ranked
   * over the tones present, so adding one tone re-labels every other one, and a diff
   * taken on `rows` reports a whole region as changed when two pixels were edited. A
   * cell's identity - its luminance, its palette slot, its packed colour - does not move,
   * so this is what a diff compares, and both sides are then drawn through whichever
   * ladder the *current* read resolved.
   *
   * `TRANSPARENT_CELL` for empty, `UNMAPPED_CELL` for opaque-but-unassignable.
   */
  cells: Int32Array;
  /**
   * The character a given cell identity renders as, under *this* read's mapping.
   *
   * Held on the render rather than re-derived from the legend, because the mapping is
   * not invertible from the legend alone: the `value` ladder is ranked over the tones
   * present, so luminance 200 becomes a different glyph depending on which other tones
   * are on the canvas. A diff has to apply the *current* mapping to the previous cells,
   * and this is the only thing that can do that correctly.
   *
   * Not serialised - it is a closure, and {@link cells} is what travels.
   */
  charForCell: (cell: number) => string;
  legend: GridLegendEntry[];
  /** Opaque pixels inside {@link rect}. */
  opaque: number;
  /** `rect.w * rect.h`. */
  total: number;
  /** Opaque pixels whose alpha is not 255 - invisible in `mask`, counted here. */
  partialAlpha: number;
  /** Opaque pixels that no character could describe (off-palette, in `index`). */
  unmapped: number;
  /** Luminance extremes of the opaque pixels, for the `value` view. */
  valueRange?: [number, number];
  /** How many ladder steps the `value` view resolved to. */
  levels?: number;
  /** True when the `named` view had to merge colours to fit {@link SLOT_CHARS}. */
  grouped?: boolean;
}

/* ------------------------------------------------------------------ *
 * Colour description
 * ------------------------------------------------------------------ */

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function rgbToHsl(c: Color): Hsl {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

const HUE_NAMES: ReadonlyArray<readonly [number, string]> = [
  [12, 'red'],
  [40, 'orange'],
  [68, 'yellow'],
  [160, 'green'],
  [200, 'cyan'],
  [256, 'blue'],
  [296, 'purple'],
  [348, 'magenta'],
];

function hueName(h: number): string {
  for (const [limit, name] of HUE_NAMES) if (h < limit) return name;
  return 'red';
}

function toneWord(l: number): string {
  if (l < 0.22) return 'very dark';
  if (l < 0.42) return 'dark';
  if (l < 0.62) return 'mid';
  if (l < 0.82) return 'light';
  return 'pale';
}

/**
 * A name a model can use directly: `"dark red"`, `"pale orange"`, `"black"`.
 *
 * Deliberately not semantic. Nothing here can tell you that `#e0a878` is skin - only
 * the artist or the document's palette roles know that. What it does buy is the
 * difference between reading a name and decoding three hex pairs, which is the whole
 * cost the `named` view exists to remove.
 */
export function describeColor(c: Color): string {
  const { h, s, l } = rgbToHsl(c);
  if (s < 0.15) {
    if (l < 0.15) return 'black';
    if (l < 0.45) return 'dark gray';
    if (l < 0.78) return 'gray';
    return 'white';
  }
  return `${toneWord(l)} ${hueName(h)}`;
}

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

interface Sampled {
  color: Color;
  luminance: number;
}

/**
 * Map distinct luminances onto the ladder by rank rather than by fixed bucket.
 *
 * A pixel-art material is five deliberate steps, and a fixed 0-255 bucketing routinely
 * collapses two of them into one glyph - the grid then claims two tones are the same
 * when the artist built a ramp out of them. Ranking guarantees one glyph per distinct
 * tone whenever the region has fewer tones than the ladder has rungs, and reports how
 * many it resolved so the reader knows which case they are in.
 */
function valueLadder(samples: readonly Sampled[]): {
  charFor: (luminance: number) => string;
  legend: GridLegendEntry[];
  levels: number;
  range: [number, number];
} {
  const distinct = [...new Set(samples.map((s) => Math.round(s.luminance)))].sort((a, b) => a - b);

  // An empty region has no tones to rank, and the ranking below would divide by
  // `distinct.length - 1` = -1. The caller reports "nothing here" separately.
  if (distinct.length === 0) {
    return {
      charFor: () => EMPTY_CHAR,
      legend: [],
      levels: 0,
      range: [0, 0],
    };
  }

  const range: [number, number] = [distinct[0], distinct[distinct.length - 1]];

  if (distinct.length === 1) {
    const only = distinct[0];
    return {
      charFor: () => VALUE_RAMP[0],
      legend: [{ char: VALUE_RAMP[0], label: String(only), luminance: only }],
      levels: 1,
      range,
    };
  }

  if (distinct.length <= VALUE_RAMP.length) {
    const rank = new Map(distinct.map((lum, i) => [lum, i]));
    const spread = (i: number) =>
      VALUE_RAMP[Math.round((i * (VALUE_RAMP.length - 1)) / (distinct.length - 1))];
    return {
      charFor: (lum) => spread(rank.get(Math.round(lum)) ?? 0),
      legend: distinct.map((lum, i) => ({
        char: spread(i),
        label: String(lum),
        luminance: lum,
      })),
      levels: distinct.length,
      range,
    };
  }

  // More distinct tones than the ladder has rungs: fall back to uniform buckets over
  // the observed range and say so, rather than silently merging the two darkest.
  const [min, max] = range;
  const span = Math.max(1, max - min);
  const bucket = (lum: number) =>
    Math.min(VALUE_RAMP.length - 1, Math.floor(((lum - min) / span) * VALUE_RAMP.length));
  const legend: GridLegendEntry[] = [];
  for (let i = 0; i < VALUE_RAMP.length; i++) {
    const lo = min + (i * span) / VALUE_RAMP.length;
    legend.push({
      char: VALUE_RAMP[i],
      label: `${Math.round(lo)}-${Math.round(min + ((i + 1) * span) / VALUE_RAMP.length)}`,
      luminance: Math.round(lo),
    });
  }
  return { charFor: (lum) => VALUE_RAMP[bucket(lum)], legend, levels: VALUE_RAMP.length, range };
}

/** Palette slot lookup, tolerating a composited pixel whose alpha is no longer 255. */
function paletteLookup(colors: readonly Color[]): {
  charFor: (c: Color) => string;
  charForSlot: (cell: number) => string;
  cellOf: (c: Color) => number;
  legend: GridLegendEntry[];
  unmapped: (c: Color) => boolean;
} {
  const byPacked = new Map<number, number>();
  const byRgb = new Map<number, number>();
  colors.forEach((color, index) => {
    const packed = packColor(color);
    if (!byPacked.has(packed)) byPacked.set(packed, index);
    // Only opaque slots stand in for a semi-transparent composite, so an exact opaque
    // match always wins over this looser one.
    if (color.a === 255) {
      const rgb = packColor({ r: color.r, g: color.g, b: color.b, a: 255 });
      if (!byRgb.has(rgb)) byRgb.set(rgb, index);
    }
  });
  const slotOf = (c: Color): number | undefined =>
    byPacked.get(packColor(c)) ??
    (c.a === 255 ? byRgb.get(packColor({ r: c.r, g: c.g, b: c.b, a: 255 })) : undefined);

  return {
    charFor: (c) => {
      const slot = slotOf(c);
      return slot === undefined ? UNKNOWN_CHAR : SLOT_CHARS[slot] ?? UNKNOWN_CHAR;
    },
    // Slot + 1, so a real slot 0 is distinguishable from `UNMAPPED_CELL`.
    cellOf: (c) => (slotOf(c) ?? -1) + 1,
    charForSlot: (cell) => {
      const char = cell > 0 ? SLOT_CHARS[cell - 1] : undefined;
      return char ?? UNKNOWN_CHAR;
    },
    unmapped: (c) => slotOf(c) === undefined,
    legend: colors.map((color, index) => ({
      char: SLOT_CHARS[index] ?? UNKNOWN_CHAR,
      index,
      hex: colorToHex(color),
      label: `#${index} ${colorToHex(color)} ${describeColor(color)}`,
    })),
  };
}

/**
 * Grouping key for the `named` view: 4 bits per channel.
 *
 * Deliberately coarse. A `named` view that listed two colours two steps apart would
 * answer "which material is this" with a list of near-duplicates, so near-identical
 * tones are meant to merge here.
 */
function namedKey(c: Color): number {
  return ((c.r >> 4) << 8) | ((c.g >> 4) << 4) | (c.b >> 4);
}

/**
 * Group opaque pixels by colour and number the groups by luminance.
 *
 * Grouping is on 4-bit channels, so two colours a couple of steps apart merge - which
 * is the point: a `named` view that listed near-identical tones separately would answer
 * "which material" with a list of near-duplicates. Ordering the slots by luminance
 * means the grid's ink density still tracks the `value` view, so the two read together.
 */
function namedGroups(samples: readonly Sampled[]): {
  charFor: (c: Color) => string;
  charForSlot: (cell: number) => string;
  cellOf: (c: Color) => number;
  legend: GridLegendEntry[];
  grouped: boolean;
} {
  const buckets = new Map<number, { count: Map<number, number>; total: number }>();
  for (const { color } of samples) {
    const key = namedKey(color);
    const bucket = buckets.get(key) ?? { count: new Map<number, number>(), total: 0 };
    const packed = packColor(color);
    bucket.count.set(packed, (bucket.count.get(packed) ?? 0) + 1);
    bucket.total++;
    buckets.set(key, bucket);
  }

  // Representative = the most frequent exact colour in the bucket, so the legend names
  // a colour that is genuinely on the canvas rather than an average of two.
  const groups = [...buckets.entries()].map(([key, bucket]) => {
    let best = 0;
    let bestCount = -1;
    for (const [packed, count] of bucket.count) {
      if (count > bestCount) {
        best = packed;
        bestCount = count;
      }
    }
    return {
      key,
      count: bucket.total,
      color: {
        r: (best >>> 24) & 255,
        g: (best >>> 16) & 255,
        b: (best >>> 8) & 255,
        a: 255,
      } as Color,
    };
  });

  groups.sort((a, b) => luminanceOf(a.color) - luminanceOf(b.color));

  let grouped = false;
  let assigned = groups;
  if (groups.length > SLOT_CHARS.length) {
    grouped = true;
    // Collapse the tail into the last slot rather than dropping it: every pixel still
    // gets a character, and the legend reports which slot absorbed the overflow.
    assigned = groups.slice(0, SLOT_CHARS.length);
  }

  const slotByKey = new Map<number, number>();
  const legend: GridLegendEntry[] = [];
  assigned.forEach((group, i) => {
    slotByKey.set(group.key, i);
    legend.push({
      char: SLOT_CHARS[i],
      hex: colorToHex(group.color),
      label: `${colorToHex(group.color)} ${describeColor(group.color)}`,
    });
  });
  if (grouped) {
    const overflow = groups.slice(SLOT_CHARS.length);
    legend[legend.length - 1].label += ` +${overflow.length} closer tone(s)`;
  }

  return {
    charFor: (c) => {
      const slot = slotByKey.get(namedKey(c));
      return slot === undefined ? UNKNOWN_CHAR : SLOT_CHARS[slot];
    },
    cellOf: (c) => (slotByKey.get(namedKey(c)) ?? -1) + 1,
    charForSlot: (cell) => {
      const char = cell > 0 ? SLOT_CHARS[cell - 1] : undefined;
      return char ?? UNKNOWN_CHAR;
    },
    legend,
    grouped,
  };
}

/**
 * Render `rect` of `buffer` as one character per pixel.
 *
 * `rect` is clipped rather than rejected: an agent asking for a region that runs off
 * the canvas gets the part that exists, the same rule every drawing command follows.
 */
export function renderGridView(
  buffer: PixelBuffer,
  rect: Rect,
  view: GridView,
  palette: readonly Color[] = [],
): GridRender {
  const clipped = clipRect(rect, buffer.width, buffer.height);
  const size = clipped.w * clipped.h;
  const result: GridRender = {
    view,
    rect: clipped,
    rows: [],
    cells: new Int32Array(size).fill(TRANSPARENT_CELL),
    // Replaced below by the view's real mapping; a valid default so an early return
    // still produces a renderable object.
    charForCell: (cell) => (cell === TRANSPARENT_CELL ? EMPTY_CHAR : UNKNOWN_CHAR),
    legend: [],
    opaque: 0,
    total: size,
    partialAlpha: 0,
    unmapped: 0,
  };
  if (rectIsEmpty(clipped)) return result;

  // Every view needs the opaque pixels first, and only the `value` and `named` views
  // need their luminances, so this is the single pass that feeds all four.
  const samples: Sampled[] = [];
  const cells: Array<{ offset: number; color: Color; luminance: number }> = [];
  for (let y = clipped.y; y < clipped.y + clipped.h; y++) {
    for (let x = clipped.x; x < clipped.x + clipped.w; x++) {
      if (!buffer.contains(x, y)) continue;
      const color = buffer.getColor(x, y);
      if (color.a === 0) continue;
      if (color.a !== 255) result.partialAlpha++;
      const luminance = luminanceOf(color);
      const offset = (y - clipped.y) * clipped.w + (x - clipped.x);
      cells.push({ offset, color, luminance });
      if (view === 'value' || view === 'named') samples.push({ color, luminance });
    }
  }
  result.opaque = cells.length;

  const grid: string[][] = Array.from(
    { length: clipped.h },
    () => new Array<string>(clipped.w).fill(EMPTY_CHAR),
  );
  const put = (offset: number, char: string) => {
    grid[Math.floor(offset / clipped.w)][offset % clipped.w] = char;
  };

  if (view === 'mask') {
    result.legend = [
      { char: '#', label: 'opaque' },
      { char: EMPTY_CHAR, label: 'transparent' },
    ];
    result.charForCell = (cell) => (cell === TRANSPARENT_CELL ? EMPTY_CHAR : '#');
    for (const cell of cells) {
      result.cells[cell.offset] = 1;
      put(cell.offset, '#');
    }
  } else if (view === 'index') {
    const lookup = paletteLookup(palette);
    result.legend = lookup.legend;
    result.charForCell = (cell) => lookup.charForSlot(cell);
    for (const cell of cells) {
      if (lookup.unmapped(cell.color)) result.unmapped++;
      result.cells[cell.offset] = lookup.cellOf(cell.color);
      put(cell.offset, lookup.charFor(cell.color));
    }
  } else if (view === 'value') {
    const ladder = valueLadder(samples);
    result.legend = ladder.legend;
    result.levels = ladder.levels;
    result.valueRange = ladder.range;
    result.charForCell = (cell) => ladder.charFor(cell);
    for (const cell of cells) {
      // The identity is the rounded luminance, not the glyph: see GridRender.cells.
      result.cells[cell.offset] = Math.round(cell.luminance);
      put(cell.offset, ladder.charFor(cell.luminance));
    }
  } else {
    const groups = namedGroups(samples);
    result.legend = groups.legend;
    result.grouped = groups.grouped;
    result.charForCell = (cell) => groups.charForSlot(cell);
    for (const cell of cells) {
      result.cells[cell.offset] = groups.cellOf(cell.color);
      put(cell.offset, groups.charFor(cell.color));
    }
  }

  result.rows = grid.map((row) => row.join(''));
  return result;
}

/**
 * Re-render stored cell identities through a read's own character mapping.
 *
 * This is what makes a diff on the `value` view honest. The ladder is ranked over the
 * tones present, so adding one tone re-labels every other one; diffing the rendered
 * glyphs would then report the whole region as changed when two pixels were edited.
 * Diffing {@link GridRender.cells} and drawing both sides through the *current* mapping
 * reports the pixels that actually moved.
 */
export function rowsFromCells(cells: Int32Array, rect: Rect, render: GridRender): string[] {
  const rows: string[] = [];
  for (let y = 0; y < rect.h; y++) {
    let row = '';
    for (let x = 0; x < rect.w; x++) {
      const cell = cells[y * rect.w + x];
      row += cell === TRANSPARENT_CELL ? EMPTY_CHAR : render.charForCell(cell);
    }
    rows.push(row);
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * Diffing
 * ------------------------------------------------------------------ */

export interface GridDiffEntry {
  /** Absolute canvas y of the row. */
  y: number;
  was: string;
  now: string;
}

export interface GridDiff {
  changedRows: number;
  changedPixels: number;
  totalRows: number;
  entries: GridDiffEntry[];
  /** Changed rows beyond the ones listed in `entries`. */
  omitted: number;
}

/** How many changed rows a diff carries before it summarises the rest. */
const DIFF_ENTRY_LIMIT = 64;

/**
 * Row-level diff between two grids of the same region.
 *
 * Whole rows rather than individual pixels, deliberately: two strings the model can put
 * side by side is a far better thing to read than forty `x,y: a->b` triples, and
 * string comparison is the one thing a language model is genuinely better at than a
 * human squinting at a highlighted image. `top` maps row 0 back to absolute canvas
 * coordinates so the entry can be acted on without re-deriving the offset.
 */
export function diffGridRows(
  previous: readonly string[],
  current: readonly string[],
  top: number,
): GridDiff {
  const entries: GridDiffEntry[] = [];
  let changedPixels = 0;
  let changedRows = 0;
  const shared = Math.min(previous.length, current.length);

  for (let i = 0; i < shared; i++) {
    const was = previous[i];
    const now = current[i];
    if (was === now) continue;
    changedRows++;
    for (let x = 0; x < Math.min(was.length, now.length); x++) {
      if (was[x] !== now[x]) changedPixels++;
    }
    if (entries.length < DIFF_ENTRY_LIMIT) entries.push({ y: top + i, was, now });
  }
  // A region that grew or shrank is itself a change, even when no shared row differs.
  if (previous.length !== current.length) {
    changedRows += Math.abs(previous.length - current.length);
    if (entries.length < DIFF_ENTRY_LIMIT) {
      entries.push({
        y: top + shared,
        was: previous.length > current.length ? `<${previous.length - current.length} row(s)>` : '',
        now: previous.length < current.length ? `<${current.length - previous.length} row(s)>` : '',
      });
    }
  }

  return {
    changedRows,
    changedPixels,
    totalRows: current.length,
    entries,
    omitted: Math.max(0, changedRows - entries.length),
  };
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

/** Rows a printed diff lists before it counts the rest. */
const DIFF_PRINT_LIMIT = 40;

function gutterWidth(rect: Rect): number {
  return Math.max(2, String(rect.y + Math.max(0, rect.h - 1)).length);
}

export interface GridHeader {
  view: GridView;
  scope: string;
  frame: number;
  layer?: string;
  /** Total frames in the document, printed only when it is more than one. */
  frameCount?: number;
}

/**
 * One legend line, dark to light / low slot to high slot.
 *
 * Printed rather than left as structured data on purpose: the reader of a `value` grid
 * cannot tell what `o` means without it, and a table would cost more tokens than the
 * grid it explains.
 */
export function formatGridLegend(render: GridRender): string {
  if (render.view === 'mask') return 'legend  # opaque   . transparent';
  if (render.view === 'value') {
    const parts = render.legend.map((e) => `${e.char} ${e.luminance}`);
    return `legend (luminance, dark -> light)  ${parts.join('  ')}`;
  }
  if (render.view === 'index') {
    return 'legend (palette slot)  character = slot number, ? = off-palette';
  }
  const used = new Set(render.rows.join('').split(''));
  const parts = render.legend
    .filter((e) => used.has(e.char))
    .map((e) => `${e.char} ${e.label}`);
  return `legend (colour, dark -> light)  ${parts.join('   ') || '(none)'}`;
}

/**
 * Print a grid with absolute rulers.
 *
 * The x ruler is two rows - tens then ones - because a single row of ones digits is
 * ambiguous past column 9, and an agent that misreads a column puts a pixel in the
 * wrong place. The y gutter is padded to a fixed width for the same reason.
 *
 * The region is printed in full, margins and all. Trimming empty columns would save
 * tokens, but the caller's `rect` is what the diff is keyed on, so a grid that moved
 * between calls would stop being comparable to the one it was compared with - and the
 * absolute coordinates are exactly what makes a cell actionable. The caller that wants a
 * small grid passes a `rect`, which it controls.
 */
export function formatGrid(render: GridRender, header: GridHeader): string {
  const { rect } = render;
  if (rectIsEmpty(rect)) return `${rect.w}x${rect.h} region is empty`;
  // A region that holds no artwork prints as a grid of blanks, which is a fact about
  // the drawing rather than an error - "you have not drawn here yet" is the answer. The
  // `opaque 0/N` line above it says so in numbers, so the rows are worth keeping.
  if (render.opaque === 0) {
    return [
      `read_grid  view=${header.view}  frame=${header.frame}` +
        `${header.frameCount && header.frameCount > 1 ? `/${header.frameCount - 1}` : ''}` +
        `  scope=${header.scope}${header.layer ? `  layer=${header.layer}` : ''}` +
        `  rect=${rect.w}x${rect.h} at (${rect.x}, ${rect.y})`,
      `opaque 0/${render.total}  (nothing drawn in this region)`,
    ].join('\n');
  }

  const gutter = gutterWidth(rect);
  // Must match the data rows' own prefix exactly: a padded y label, a space, the bar,
  // then a space. Getting this wrong by one shifts every column in the grid, and a
  // model acting on a shifted coordinate edits the wrong pixel.
  const pad = ' '.repeat(gutter + 3);
  const tens = Array.from({ length: rect.w }, (_, i) => String(Math.floor((rect.x + i) / 10) % 10)).join('');
  const ones = Array.from({ length: rect.w }, (_, i) => String((rect.x + i) % 10)).join('');

  const lines: string[] = [];
  lines.push(
    `read_grid  view=${header.view}  frame=${header.frame}` +
      `${header.frameCount && header.frameCount > 1 ? `/${header.frameCount - 1}` : ''}` +
      `  scope=${header.scope}${header.layer ? `  layer=${header.layer}` : ''}  rect=${rect.w}x${rect.h} at (${rect.x}, ${rect.y})`,
  );
  const facts = [
    `opaque ${render.opaque}/${render.total}`,
    render.partialAlpha ? `partialAlpha ${render.partialAlpha}` : null,
    render.unmapped ? `unmapped ${render.unmapped}` : null,
    render.valueRange
      ? `valueRange ${render.valueRange[0]}-${render.valueRange[1]} (${render.levels} levels)`
      : null,
    render.grouped ? 'grouped=true' : null,
  ].filter(Boolean);
  lines.push(facts.join('  '));
  lines.push(formatGridLegend(render));
  lines.push(`${pad}${tens}`);
  lines.push(`${pad}${ones}`);
  for (let y = 0; y < rect.h; y++) {
    lines.push(`${String(rect.y + y).padStart(gutter)} | ${render.rows[y]}`);
  }
  return lines.join('\n');
}

/** Print a diff as `was` / `now` row pairs, summarising anything past the limit. */
export function formatGridDiff(diff: GridDiff, label: string): string {
  const head =
    `${label}: ${diff.changedRows} of ${diff.totalRows} rows, ` +
    `${diff.changedPixels} pixel(s) changed`;
  if (diff.entries.length === 0) return `${head} (rows differ only in length)`;
  const shown = diff.entries.slice(0, DIFF_PRINT_LIMIT);
  const lines = shown.map(
    (e) => `  y=${e.y}  was "${e.was}"  now "${e.now}"`,
  );
  if (diff.entries.length > shown.length) {
    lines.push(`  (+${diff.entries.length - shown.length} more changed row(s))`);
  }
  return [head, ...lines].join('\n');
}
