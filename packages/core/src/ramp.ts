import { clamp8, colorToHex, parseColor } from './color.js';
import type { Color, ColorInput } from './types.js';

/**
 * Hue-shifted colour ramps.
 *
 * Pixel-art ramps read better when they move in hue as well as value: shadows drift
 * toward blue/violet and highlights toward yellow/orange. Doing that by hand is
 * fiddly, so this module turns two anchors into a complete ramp.
 *
 * The anchor hues are preserved by default (`hueShift: 0`). Passing a `hueShift`
 * nudges the dark end toward a cool target and the light end toward a warm target
 * without forcing either anchor onto an arbitrary absolute hue; passing
 * `shadowHue`/`highlightHue` takes full control.
 */

export interface HueRampOptions {
  /** How far, in degrees, to pull the dark anchor toward blue and the light anchor toward amber. Defaults to 0. */
  hueShift?: number;
  /** Absolute hue (0-360) for the dark end. Overrides `hueShift` for that end. */
  shadowHue?: number;
  /** Absolute hue (0-360) for the light end. Overrides `hueShift` for that end. */
  highlightHue?: number;
  /** Extra saturation at the middle of the ramp, -0.5 to 0.5. Defaults to 0. */
  saturationBoost?: number;
  /** Alpha for every generated colour. Defaults to 255. */
  alpha?: number;
}

export interface HueRampResult {
  colors: Color[];
  hex: string[];
  hue: { from: number; to: number };
}

/** Cool target for shadows: periwinkle-blue rather than a muddy desaturation. */
const SHADOW_TARGET_HUE = 235;
/** Warm target for highlights: amber rather than pure yellow. */
const HIGHLIGHT_TARGET_HUE = 55;

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
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: (h / 6) * 360, s, l };
}

function hslToRgb(h: number, s: number, l: number): Color {
  const hue = (((h % 360) + 360) % 360) / 360;
  if (s === 0) {
    const v = clamp8(l * 255);
    return { r: v, g: v, b: v, a: 255 };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return {
    r: clamp8(channel(hue + 1 / 3) * 255),
    g: clamp8(channel(hue) * 255),
    b: clamp8(channel(hue - 1 / 3) * 255),
    a: 255,
  };
}

function normalizeHue(h: number): number {
  return ((h % 360) + 360) % 360;
}

/** Move `current` toward `target` by at most `maxDelta` degrees along the short path. */
function hueTowards(current: number, target: number, maxDelta: number): number {
  const diff = ((target - current + 540) % 360) - 180;
  if (maxDelta <= 0 || diff === 0) return normalizeHue(current);
  return normalizeHue(current + Math.sign(diff) * Math.min(Math.abs(diff), maxDelta));
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function buildHueRamp(
  from: ColorInput,
  to: ColorInput,
  steps: number,
  options: HueRampOptions = {},
): HueRampResult {
  const start = parseColor(from);
  const end = parseColor(to);
  const count = Math.max(2, Math.min(64, Math.floor(steps)));
  const startHsl = rgbToHsl(start);
  const endHsl = rgbToHsl(end);
  const shift = options.hueShift ?? 0;
  const h0 =
    options.shadowHue !== undefined
      ? normalizeHue(options.shadowHue)
      : hueTowards(startHsl.h, SHADOW_TARGET_HUE, shift);
  const h1 =
    options.highlightHue !== undefined
      ? normalizeHue(options.highlightHue)
      : hueTowards(endHsl.h, HIGHLIGHT_TARGET_HUE, shift);
  // Take the short way around the wheel, so a red-to-blue ramp does not detour
  // through green.
  const deltaHue = ((h1 - h0 + 540) % 360) - 180;
  const saturationBoost = options.saturationBoost ?? 0;
  const alpha = options.alpha ?? 255;

  const colors: Color[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    const hue = normalizeHue(h0 + deltaHue * t);
    const saturation = clamp01(startHsl.s + (endHsl.s - startHsl.s) * t + Math.sin(Math.PI * t) * saturationBoost);
    const lightness = clamp01(startHsl.l + (endHsl.l - startHsl.l) * t);
    const rgb = hslToRgb(hue, saturation, lightness);
    colors.push({ ...rgb, a: alpha });
  }

  return {
    colors,
    hex: colors.map((color) => colorToHex(color)),
    hue: { from: h0, to: h1 },
  };
}
