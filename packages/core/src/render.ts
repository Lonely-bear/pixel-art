import { blendInto } from './blend.js';
import { PixelBuffer } from './buffer.js';
import { parseColor } from './color.js';
import { getFrame, type Layer, type Sprite } from './document.js';
import type { ColorInput, FrameId, LayerId } from './types.js';

export interface CompositeOptions {
  /** Restrict to these layers (by ID), bottom-first order still applies. */
  layers?: readonly LayerId[];
  /** Fill the background instead of leaving it transparent. */
  background?: ColorInput | null;
  /** Skip layers that are hidden. Defaults to true. */
  respectVisibility?: boolean;
}

/**
 * Flatten a frame into a single RGBA buffer, honouring layer order, opacity, blend mode
 * and visibility.
 *
 * Rendering is always done from the model, never from the UI, so the same call produces
 * the same bytes in the Electron renderer, in a headless MCP server and in a golden-image
 * test.
 */
export function compositeFrame(
  sprite: Sprite,
  frameId: FrameId,
  opts: CompositeOptions = {},
): PixelBuffer {
  const frame = getFrame(sprite, frameId);
  const out = new PixelBuffer(sprite.width, sprite.height);
  if (opts.background != null) out.fill(opts.background);

  const respectVisibility = opts.respectVisibility ?? true;
  const allow = opts.layers ? new Set(opts.layers) : null;

  for (const layer of sprite.layers) {
    if (respectVisibility && !layer.visible) continue;
    if (allow && !allow.has(layer.id)) continue;
    const cel = frame.cels.get(layer.id);
    if (!cel) continue;
    compositeLayer(out, cel, layer);
  }
  return out;
}

function compositeLayer(target: PixelBuffer, cel: PixelBuffer, layer: Layer): void {
  const opacity = layer.opacity;
  const blend = layer.blendMode;
  if (opacity <= 0) return;
  const src = cel.data;
  const dst = target.data;
  // Fast path: a fully opaque normal layer is a straight overwrite of non-transparent
  // pixels, which avoids the per-pixel blend maths entirely.
  const fast = opacity >= 1 && blend === 'normal';
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    if (a === 0) continue;
    if (fast) {
      dst[i] = src[i];
      dst[i + 1] = src[i + 1];
      dst[i + 2] = src[i + 2];
      dst[i + 3] = a;
      continue;
    }
    blendInto(dst, i, { r: src[i], g: src[i + 1], b: src[i + 2], a }, { blend, opacity });
  }
}

/** Flatten every frame. */
export function compositeAllFrames(
  sprite: Sprite,
  opts: CompositeOptions = {},
): { frameId: FrameId; buffer: PixelBuffer }[] {
  return sprite.frames.map((f) => ({ frameId: f.id, buffer: compositeFrame(sprite, f.id, opts) }));
}

/**
 * Flatten a frame on top of an explicit backdrop colour. Convenient for previews and
 * for formats that cannot carry alpha.
 */
export function compositeOnBackground(
  sprite: Sprite,
  frameId: FrameId,
  background: ColorInput,
  opts: CompositeOptions = {},
): PixelBuffer {
  return compositeFrame(sprite, frameId, { ...opts, background });
}

/** Composite then flatten alpha against a colour, producing a fully opaque buffer. */
export function flattenAlpha(source: PixelBuffer, background: ColorInput): PixelBuffer {
  const bg = parseColor(background);
  const out = new PixelBuffer(source.width, source.height);
  out.fill(bg);
  compositeLayer(out, source, {
    id: '__flat__',
    name: 'flat',
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
  });
  return out;
}
