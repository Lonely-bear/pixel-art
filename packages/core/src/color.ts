import type { Color, ColorInput } from './types.js';

/**
 * Liberal colour parsing.
 *
 * Being forgiving here matters more than being strict: an AI agent will hand us
 * `#fff`, `0xff0000`, `[255, 0, 0]` and `"red"` in the same session, and every one of
 * those should just work.
 */

const NAMED: Record<string, string> = {
  transparent: '#00000000',
  none: '#00000000',
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#00ff00',
  blue: '#0000ff',
  yellow: '#ffff00',
  cyan: '#00ffff',
  aqua: '#00ffff',
  magenta: '#ff00ff',
  fuchsia: '#ff00ff',
  gray: '#808080',
  grey: '#808080',
  orange: '#ff8000',
  purple: '#8000ff',
  pink: '#ff80c0',
  brown: '#804000',
};

export function clamp8(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 255 ? 255 : Math.round(n);
}

/**
 * Anything that can resolve a palette index to a colour: a `Palette`, or just its
 * colour list. Kept structural so `color.ts` does not have to import `palette.ts`
 * (which imports this file).
 */
export type PaletteLike = { readonly colors: readonly Color[] } | readonly Color[];

function colorsOf(palette: PaletteLike | null | undefined): readonly Color[] | undefined {
  if (!palette) return undefined;
  return Array.isArray(palette) ? (palette as readonly Color[]) : (palette as { colors: readonly Color[] }).colors;
}

/** `"pal:9"`, `"palette:9"`, `"pal 9"` and `"pal#9"` all name palette index 9. */
const PALETTE_REF = /^(?:pal|palette)\s*[:#]?\s*(\d+)$/i;

function parsePaletteRef(input: string): number | null {
  const match = PALETTE_REF.exec(input.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Liberal colour parsing, with optional palette-index shorthand.
 *
 * Without a palette this is the historical behaviour: strings are hex/names and
 * numbers are `0xRRGGBB` / `0xRRGGBBAA`.
 *
 * Given a palette, two extra spellings resolve against it, because in pixel art the
 * artist is almost always thinking in palette slots rather than channel values:
 *
 *  - `"pal:9"` / `"palette:9"` — always an index, in any context.
 *  - an integer `9` — treated as an index *when it is in range*, otherwise it still
 *    means `0x000009`. Out-of-range numbers can never be a valid slot, so this stays
 *    backwards compatible with the documented numeric form.
 */
export function parseColor(input: ColorInput, palette?: PaletteLike | null): Color {
  const colors = colorsOf(palette);

  if (typeof input === 'string') {
    const index = parsePaletteRef(input);
    if (index !== null) {
      if (!colors) {
        throw new Error(`Invalid colour: ${JSON.stringify(input)} (no palette available to resolve an index)`);
      }
      const c = colors[index];
      if (!c) {
        throw new Error(
          `Invalid colour: ${JSON.stringify(input)} (palette index ${index} out of range, size ${colors.length})`,
        );
      }
      return { r: c.r, g: c.g, b: c.b, a: c.a };
    }
    return parseHex(input);
  }

  if (typeof input === 'number') {
    if (colors && Number.isInteger(input) && input >= 0 && input < colors.length) {
      const c = colors[input];
      return { r: c.r, g: c.g, b: c.b, a: c.a };
    }
    const n = input >>> 0;
    if (n > 0xffffff) {
      return { r: (n >>> 24) & 255, g: (n >>> 16) & 255, b: (n >>> 8) & 255, a: n & 255 };
    }
    return { r: (n >>> 16) & 255, g: (n >>> 8) & 255, b: n & 255, a: 255 };
  }

  if (Array.isArray(input)) {
    const [r, g, b, a] = input as readonly number[];
    return { r: clamp8(r), g: clamp8(g), b: clamp8(b), a: a === undefined ? 255 : clamp8(a) };
  }

  const o = input as Color;
  return {
    r: clamp8(o.r),
    g: clamp8(o.g),
    b: clamp8(o.b),
    a: o.a === undefined ? 255 : clamp8(o.a),
  };
}

function parseHex(input: string): Color {
  let s = input.trim().toLowerCase();
  const named = NAMED[s];
  if (named) s = named;
  if (s.startsWith('#')) s = s.slice(1);

  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  else if (s.length === 4) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];

  // Applied after shorthand expansion, so `#f00` reaches 8 digits too.
  if (s.length === 6) s = s + 'ff';

  if (s.length !== 8 || !/^[0-9a-f]{8}$/.test(s)) {
    throw new Error(`Invalid colour: ${JSON.stringify(input)}`);
  }

  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
    a: parseInt(s.slice(6, 8), 16),
  };
}

export function colorToHex(c: Color, withAlpha = false): string {
  const h = (n: number) => clamp8(n).toString(16).padStart(2, '0');
  const base = `#${h(c.r)}${h(c.g)}${h(c.b)}`;
  return withAlpha ? `${base}${h(c.a)}` : base;
}

/** Pack to a 32-bit `0xRRGGBBAA` integer, useful as a map key. */
export function packColor(c: Color): number {
  return (((c.r & 255) << 24) | ((c.g & 255) << 16) | ((c.b & 255) << 8) | (c.a & 255)) >>> 0;
}

export function colorsEqual(a: Color, b: Color): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}

/** Max-channel (Chebyshev) distance, 0-255. */
export function colorDistance(a: Color, b: Color): number {
  return Math.max(
    Math.abs(a.r - b.r),
    Math.abs(a.g - b.g),
    Math.abs(a.b - b.b),
    Math.abs(a.a - b.a),
  );
}

export function isTransparent(c: Color): boolean {
  return c.a === 0;
}
