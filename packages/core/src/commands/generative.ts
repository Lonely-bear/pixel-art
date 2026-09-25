import { z } from 'zod';
import { buildHueRamp } from '../ramp.js';
import { clipRect } from '../geometry.js';
import { drawPixels, putPixels, type PixelSpec } from '../raster.js';
import type { Sprite } from '../document.js';
import type { Color, ColorInput, Rect } from '../types.js';
import {
  blendOptionsShape,
  celOf,
  clipMask,
  clipSchema,
  clipWarning,
  colorSchema,
  defineCommand,
  frameRefSchema,
  frameIdOf,
  layerIdOf,
  layerRefSchema,
  positiveRectSchema,
  resolveColor,
} from './types.js';

const MAX_GENERATED_PIXELS = 4_194_304;
const MAX_GENERATED_WORK = 16_000_000;

function validateGeneratedRect(rect: Rect, commandName: string, workPixels = rect.w * rect.h): void {
  if (rect.w <= 0 || rect.h <= 0) {
    throw new Error(`${commandName} rect must have positive width and height, got ${rect.w}x${rect.h}`);
  }
  if (!Number.isSafeInteger(workPixels) || workPixels > MAX_GENERATED_PIXELS) {
    throw new Error(
      `${commandName} visible work area ${workPixels} exceeds the ${MAX_GENERATED_PIXELS} generated-pixel safety limit`,
    );
  }
}

function validateGeneratedWork(pixels: number, multiplier: number, commandName: string): void {
  const work = pixels * multiplier;
  if (!Number.isSafeInteger(work) || work > MAX_GENERATED_WORK) {
    throw new Error(
      `${commandName} estimated work ${work} exceeds the ${MAX_GENERATED_WORK} operation safety limit; reduce the rect or octaves`,
    );
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

function hash2D(x: number, y: number, seed: number): number {
  let n = Math.imul((x | 0) ^ 0x9e3779b9, 0x85ebca6b);
  n ^= Math.imul((y | 0) ^ 0xc2b2ae35, 0x27d4eb2f);
  // Mix both 32-bit halves so safe integer seeds do not alias after `| 0`.
  const seedLow = seed >>> 0;
  const seedHigh = Math.floor(seed / 0x100000000) >>> 0;
  n ^= Math.imul(seedLow ^ seedHigh, 0x165667b1);
  n ^= Math.imul(seedHigh, 0x9e3779b9);
  n = Math.imul(n ^ (n >>> 15), 0x85ebca6b);
  n ^= n >>> 13;
  return (n >>> 0) / 0x100000000;
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2D(ix, iy, seed);
  const b = hash2D(ix + 1, iy, seed);
  const c = hash2D(ix, iy + 1, seed);
  const d = hash2D(ix + 1, iy + 1, seed);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

function fbm(x: number, y: number, seed: number, octaves: number, lacunarity: number, gain: number): number {
  let value = 0;
  let amplitude = 0.5;
  let total = 0;
  let frequency = 1;
  for (let octave = 0; octave < octaves; octave++) {
    value += valueNoise(x * frequency, y * frequency, seed + octave * 1013) * amplitude;
    total += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return total > 0 ? value / total : 0;
}

function mixColor(a: Color, b: Color, t: number): Color {
  return {
    r: clampByte(a.r + (b.r - a.r) * t),
    g: clampByte(a.g + (b.g - a.g) * t),
    b: clampByte(a.b + (b.b - a.b) * t),
    a: clampByte(a.a + (b.a - a.a) * t),
  };
}

function colorAt(ramp: readonly Color[], value: number, banded: boolean): Color {
  const t = clamp01(value);
  if (banded || ramp.length === 1) return ramp[Math.min(ramp.length - 1, Math.floor(t * ramp.length))];
  const scaled = t * (ramp.length - 1);
  const index = Math.min(ramp.length - 2, Math.floor(scaled));
  return mixColor(ramp[index], ramp[index + 1], scaled - index);
}

function directionValue(x: number, y: number, rect: Rect, direction: 'vertical' | 'horizontal' | 'diagonal' | 'radial'): number {
  const w = Math.max(1, rect.w - 1);
  const h = Math.max(1, rect.h - 1);
  if (direction === 'horizontal') return x / w;
  if (direction === 'diagonal') return (x + y) / (w + h);
  if (direction === 'radial') {
    const cx = (rect.w - 1) / 2;
    const cy = (rect.h - 1) / 2;
    const max = Math.max(1, Math.hypot(cx, cy));
    return Math.hypot(x - cx, y - cy) / max;
  }
  return y / h;
}

function gradientRgba(
  rect: Rect,
  outputRect: Rect,
  ramp: readonly Color[],
  direction: 'vertical' | 'horizontal' | 'diagonal' | 'radial',
  banded: boolean,
  jitter: number,
  seed: number,
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(outputRect.w * outputRect.h * 4);
  for (let y = 0; y < outputRect.h; y++) {
    const localY = outputRect.y + y - rect.y;
    for (let x = 0; x < outputRect.w; x++) {
      const localX = outputRect.x + x - rect.x;
      const jitterValue = (hash2D(localX, localY, seed) - 0.5) * 2 * jitter;
      const t = clamp01(directionValue(localX, localY, rect, direction) + jitterValue);
      const color = colorAt(ramp, t, banded);
      const i = (y * outputRect.w + x) * 4;
      data[i] = color.r;
      data[i + 1] = color.g;
      data[i + 2] = color.b;
      data[i + 3] = color.a;
    }
  }
  return data;
}

function noiseRgba(
  rect: Rect,
  outputRect: Rect,
  ramp: readonly Color[],
  scale: number,
  octaves: number,
  lacunarity: number,
  gain: number,
  contrast: number,
  bias: number,
  banded: boolean,
  seed: number,
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(outputRect.w * outputRect.h * 4);
  for (let y = 0; y < outputRect.h; y++) {
    const localY = outputRect.y + y - rect.y;
    for (let x = 0; x < outputRect.w; x++) {
      const localX = outputRect.x + x - rect.x;
      const value = fbm(localX / scale, localY / scale, seed, octaves, lacunarity, gain);
      const t = clamp01((value - 0.5) * contrast + 0.5 + bias);
      const color = colorAt(ramp, t, banded);
      const i = (y * outputRect.w + x) * 4;
      data[i] = color.r;
      data[i + 1] = color.g;
      data[i + 2] = color.b;
      data[i + 3] = color.a;
    }
  }
  return data;
}

function addDisc(
  pixels: PixelSpec[],
  centerX: number,
  centerY: number,
  radius: number,
  color: Color,
  falloff: number,
  bounds: Rect,
  seen: Set<number>,
): void {
  const r = Math.max(0, Math.round(radius));
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const distance = Math.hypot(dx, dy);
      if (distance > r) continue;
      const x = centerX + dx;
      const y = centerY + dy;
      if (x < bounds.x || y < bounds.y || x >= bounds.x + bounds.w || y >= bounds.y + bounds.h) {
        continue;
      }
      const relativeX = x - bounds.x;
      const relativeY = y - bounds.y;
      const key = relativeY * bounds.w + relativeX;
      if (seen.has(key)) continue;
      const edge = clamp01(1 - (r > 0 ? distance / r : 0) * falloff);
      const alpha = clampByte((color.a / 255) * edge * 255);
      // A fully transparent edge must not reserve the coordinate for a later disc.
      if (alpha > 0) {
        seen.add(key);
        pixels.push({ x, y, color: { ...color, a: alpha } });
      }
    }
  }
}

function scatterPixels(
  rect: Rect,
  colors: readonly Color[],
  count: number,
  radius: number,
  falloff: number,
  cluster: number,
  seed: number,
): PixelSpec[] {
  const pixels: PixelSpec[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < count; i++) {
    const x = rect.x + Math.floor(hash2D(i, seed, 11) * rect.w);
    const y = rect.y + Math.floor(hash2D(i, seed, 29) * rect.h);
    const r = Math.min(
      radius,
      Math.max(0, Math.round(radius * (0.65 + hash2D(i, seed, 47) * 0.35))),
    );
    const color = colors[Math.min(colors.length - 1, Math.floor(hash2D(i, seed, 71) * colors.length))];
    addDisc(pixels, x, y, r, color, falloff, rect, seen);
    if (cluster > 0 && hash2D(i, seed, 101) < cluster) {
      const ox = Math.round((hash2D(i, seed, 109) - 0.5) * radius * 2);
      const oy = Math.round((hash2D(i, seed, 113) - 0.5) * radius * 2);
      addDisc(pixels, x + ox, y + oy, Math.max(0, r - 1), color, falloff, rect, seen);
    }
  }
  return pixels;
}

function rampFrom(
  ctx: { sprite: Sprite },
  from: ColorInput,
  to: ColorInput,
  steps: number,
  hueShift: number | undefined,
  shadowHue: number | undefined,
  highlightHue: number | undefined,
): Color[] {
  return buildHueRamp(
    resolveColor(ctx.sprite, from),
    resolveColor(ctx.sprite, to),
    steps,
    { hueShift, shadowHue, highlightHue },
  ).colors.map((color) => resolveColor(ctx.sprite, color));
}

export const bandedGradientCommand = defineCommand({
  name: 'banded_gradient',
  description:
    'Fill a rect with a deterministic gradient. `banded: true` (default) maps values onto discrete ramp steps; `banded: false` interpolates smoothly. Supports vertical, horizontal, diagonal and radial directions, deterministic per-pixel jitter, and hue-shifted colour ramps. The whole field is emitted as one batch command, not one tool call per pixel.',
  params: z.object({
    layer: layerRefSchema,
    frame: frameRefSchema,
    rect: positiveRectSchema,
    from: colorSchema.describe('Gradient start colour.'),
    to: colorSchema.describe('Gradient end colour.'),
    direction: z.enum(['vertical', 'horizontal', 'diagonal', 'radial']).optional().describe('Defaults to vertical.'),
    steps: z.number().int().min(2).max(32).optional().describe('Ramp steps. Defaults to 8.'),
    banded: z.boolean().optional().describe('Use discrete bands. Defaults to true.'),
    jitter: z.number().min(0).max(1).optional().describe('Deterministic per-pixel hue/value jitter. Defaults to 0.'),
    seed: z.number().int().optional().describe('Deterministic jitter seed. Defaults to 1.'),
    hueShift: z.number().min(0).max(90).optional().describe('Hue shift in degrees for the generated ramp. Defaults to 20.'),
    shadowHue: z.number().min(0).max(360).optional().describe('Absolute dark-end hue, overriding hueShift.'),
    highlightHue: z.number().min(0).max(360).optional().describe('Absolute light-end hue, overriding hueShift.'),
    clip: clipSchema,
    ...blendOptionsShape,
  }),
  apply(ctx, p) {
    const buf = celOf(ctx, p.layer, p.frame);
    const visible = clipRect(p.rect, buf.width, buf.height);
    validateGeneratedRect(p.rect, 'banded_gradient', visible.w * visible.h);
    const ramp = rampFrom(ctx, p.from, p.to, p.steps ?? 8, p.hueShift ?? 20, p.shadowHue, p.highlightHue);
    const summary = {
      layer: layerIdOf(ctx.sprite, p.layer),
      frame: frameIdOf(ctx.sprite, p.frame),
      pixels: p.rect.w * p.rect.h,
      direction: p.direction ?? 'vertical',
      banded: p.banded ?? true,
      ...clipWarning(ctx, p.clip, p.layer),
    };
    if (visible.w === 0 || visible.h === 0) return { ...summary, painted: 0 };

    const rgba = gradientRgba(p.rect, visible, ramp, p.direction ?? 'vertical', p.banded ?? true, p.jitter ?? 0, p.seed ?? 1);
    const result = putPixels(buf, visible, rgba, {
      blend: p.blend,
      opacity: p.opacity,
      mask: clipMask(ctx, p.clip, p.layer, p.frame),
      mapColor: (color) => resolveColor(ctx.sprite, color),
    });
    return { ...summary, painted: result.painted };
  },
});

export const noiseFillCommand = defineCommand({
  name: 'noise_fill',
  description:
    'Fill a rect with deterministic value noise. `octaves: 1` is value noise; values above 1 add fBm octaves with configurable lacunarity and gain. The result is mapped through a generated colour ramp and emitted in one batch command.',
  params: z.object({
    layer: layerRefSchema,
    frame: frameRefSchema,
    rect: positiveRectSchema,
    from: colorSchema.describe('Noise ramp start colour.'),
    to: colorSchema.describe('Noise ramp end colour.'),
    steps: z.number().int().min(2).max(32).optional().describe('Ramp steps. Defaults to 8.'),
    scale: z.number().int().min(1).max(256).optional().describe('Base noise cell size in pixels. Defaults to 32.'),
    octaves: z.number().int().min(1).max(6).optional().describe('1 = noise, 2–6 = fBm. Defaults to 1.'),
    lacunarity: z.number().min(1.2).max(3).optional().describe('Frequency multiplier per octave. Defaults to 2.'),
    gain: z.number().min(0.1).max(0.9).optional().describe('Amplitude multiplier per octave. Defaults to 0.5.'),
    contrast: z.number().min(0.1).max(3).optional().describe('Contrast around the midpoint. Defaults to 1.'),
    bias: z.number().min(-1).max(1).optional().describe('Value bias. Defaults to 0.'),
    banded: z.boolean().optional().describe('Use discrete ramp steps. Defaults to true.'),
    seed: z.number().int().optional().describe('Deterministic noise seed. Defaults to 1.'),
    hueShift: z.number().min(0).max(90).optional().describe('Hue shift in degrees for the generated ramp. Defaults to 20.'),
    shadowHue: z.number().min(0).max(360).optional().describe('Absolute dark-end hue, overriding hueShift.'),
    highlightHue: z.number().min(0).max(360).optional().describe('Absolute light-end hue, overriding hueShift.'),
    clip: clipSchema,
    ...blendOptionsShape,
  }),
  apply(ctx, p) {
    const buf = celOf(ctx, p.layer, p.frame);
    const visible = clipRect(p.rect, buf.width, buf.height);
    const visiblePixels = visible.w * visible.h;
    validateGeneratedRect(p.rect, 'noise_fill', visiblePixels);
    validateGeneratedWork(visiblePixels, p.octaves ?? 1, 'noise_fill');
    const ramp = rampFrom(ctx, p.from, p.to, p.steps ?? 8, p.hueShift ?? 20, p.shadowHue, p.highlightHue);
    const summary = {
      layer: layerIdOf(ctx.sprite, p.layer),
      frame: frameIdOf(ctx.sprite, p.frame),
      pixels: p.rect.w * p.rect.h,
      mode: (p.octaves ?? 1) > 1 ? 'fbm' : 'noise',
      octaves: p.octaves ?? 1,
      ...clipWarning(ctx, p.clip, p.layer),
    };
    if (visible.w === 0 || visible.h === 0) return { ...summary, painted: 0 };

    const rgba = noiseRgba(
      p.rect,
      visible,
      ramp,
      p.scale ?? 32,
      p.octaves ?? 1,
      p.lacunarity ?? 2,
      p.gain ?? 0.5,
      p.contrast ?? 1,
      p.bias ?? 0,
      p.banded ?? true,
      p.seed ?? 1,
    );
    const result = putPixels(buf, visible, rgba, {
      blend: p.blend,
      opacity: p.opacity,
      mask: clipMask(ctx, p.clip, p.layer, p.frame),
      mapColor: (color) => resolveColor(ctx.sprite, color),
    });
    return { ...summary, painted: result.painted };
  },
});

export const scatterCommand = defineCommand({
  name: 'scatter',
  description:
    'Place deterministic seeded dots or small clusters in a rect. This is the built-in primitive for stars, foam, grit, foliage and texture. `cluster` adds nearby satellite points; `falloff` softens disc edges. Use `clip` to keep it inside a silhouette.',
  params: z.object({
    layer: layerRefSchema,
    frame: frameRefSchema,
    rect: positiveRectSchema,
    count: z.number().int().min(1).max(4096).optional().describe('Number of seed points. Defaults to 32.'),
    color: colorSchema.optional().describe('Single point colour. Defaults to white when no `colors` are given; ignored when `colors` is present.'),
    colors: z.array(colorSchema).min(1).max(32).optional().describe('Palette/ramp colours selected deterministically per point. Takes precedence over `color`.'),
    radius: z.number().int().min(0).max(24).optional().describe('Maximum point radius in pixels. Defaults to 1.'),
    falloff: z.number().min(0).max(1).optional().describe('0 = hard discs, 1 = fades fully at the edge. Defaults to 0.35.'),
    cluster: z.number().min(0).max(1).optional().describe('Probability of a nearby satellite point. Defaults to 0.'),
    seed: z.number().int().optional().describe('Deterministic seed. Defaults to 1.'),
    clip: clipSchema,
    ...blendOptionsShape,
  }),
  apply(ctx, p) {
    const buf = celOf(ctx, p.layer, p.frame);
    const visible = clipRect(p.rect, buf.width, buf.height);
    validateGeneratedRect(p.rect, 'scatter', visible.w * visible.h);
    const count = p.count ?? 32;
    const radius = p.radius ?? 1;
    const estimated = count * Math.pow(radius * 2 + 1, 2) * (1 + (p.cluster ?? 0));
    if (estimated > 2_000_000) {
      throw new Error(`scatter estimate ${Math.round(estimated)} pixels exceeds the 2,000,000 safety limit; reduce count or radius`);
    }
    const sourceColors = p.colors?.length
      ? p.colors
      : [p.color ?? '#ffffff'];
    const colors = sourceColors.map((color) => resolveColor(ctx.sprite, color));
    const summary = {
      layer: layerIdOf(ctx.sprite, p.layer),
      frame: frameIdOf(ctx.sprite, p.frame),
      points: count,
      seed: p.seed ?? 1,
      ...clipWarning(ctx, p.clip, p.layer),
    };
    if (visible.w === 0 || visible.h === 0) return { ...summary, pixels: 0, painted: 0 };

    const pixels = scatterPixels(visible, colors, count, radius, p.falloff ?? 0.35, p.cluster ?? 0, p.seed ?? 1);
    const painted = drawPixels(buf, pixels, {
      blend: p.blend,
      opacity: p.opacity,
      mask: clipMask(ctx, p.clip, p.layer, p.frame),
    });
    return { ...summary, pixels: pixels.length, painted };
  },
});

export const generativeCommands = [bandedGradientCommand, noiseFillCommand, scatterCommand];
