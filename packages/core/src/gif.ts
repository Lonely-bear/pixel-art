import * as gifencModule from 'gifenc';

type GifencApi = typeof import('gifenc');

// `gifenc` publishes a CommonJS bundle whose named exports are registered via a
// runtime helper. Depending on the host loader, those functions are available
// directly on the module namespace or below its CommonJS `default` export.
function resolveGifenc(candidate: unknown): GifencApi {
  const module = candidate as Partial<GifencApi> & { default?: unknown };
  if (typeof module.quantize === 'function') return module as GifencApi;
  if (module.default) return resolveGifenc(module.default);
  throw new Error('The gifenc module did not expose its encoder API.');
}

const { GIFEncoder, applyPalette, quantize } = resolveGifenc(gifencModule);
import { PixelBuffer } from './buffer.js';
import type { AnimationTag, Sprite } from './document.js';
import { compositeFrame } from './render.js';
import { scaleNearest } from './transform.js';
import type { ColorInput, FrameId } from './types.js';

/** One entry in a played-back animation. */
export interface AnimationFrame {
  /** Index into `sprite.frames`. */
  index: number;
  frameId: FrameId;
  durationMs: number;
}

export interface AnimationSequence {
  /** The tag this came from, or `null` when the whole timeline was used. */
  name: string | null;
  frames: AnimationFrame[];
  /** True when the animation should loop forever. */
  loops: boolean;
  /** Total playback time of one pass, in milliseconds. */
  durationMs: number;
}

/** Find an animation tag by ID, name, or index. */
export function findTag(sprite: Sprite, ref: string | number): AnimationTag | undefined {
  if (typeof ref === 'number') return sprite.tags[ref];
  return sprite.tags.find((tag) => tag.id === ref) ?? sprite.tags.find((tag) => tag.name === ref);
}

/**
 * The frame order a tag describes.
 *
 * `pingpong` deliberately omits both end frames on the return leg. Emitting
 * `0,1,2,1` rather than `0,1,2,2,1,0` is what makes a bounce loop smoothly: the
 * endpoints are already played once per cycle, and repeating them makes the
 * animation visibly hitch.
 */
function expandDirection(tag: AnimationTag): number[] {
  const from = Math.min(tag.from, tag.to);
  const to = Math.max(tag.from, tag.to);
  const order: number[] = [];
  if (tag.direction === 'reverse') {
    for (let i = to; i >= from; i--) order.push(i);
    return order;
  }
  for (let i = from; i <= to; i++) order.push(i);
  if (tag.direction === 'pingpong') {
    for (let i = to - 1; i > from; i--) order.push(i);
  }
  return order;
}

/**
 * Flatten a sprite (or one of its tags) into the list of frames to play, in order.
 *
 * This is the reusable half of animation export: the GIF encoder, per-frame PNG
 * export and the spritesheet all want the same answer to "which frames, in what
 * order, for how long", and the direction rules are easy to get subtly wrong, so
 * they live here once instead of in each exporter.
 *
 * A tag with `repeat: 0` means "forever", so the sequence is emitted once and the
 * caller is told to loop. A tag with `repeat: n` is emitted n times and does not
 * loop.
 */
export function animationSequence(sprite: Sprite, tagRef?: string | number): AnimationSequence {
  const tag = tagRef === undefined ? undefined : findTag(sprite, tagRef);

  if (tagRef !== undefined && !tag) {
    throw new Error(`Unknown animation tag: ${tagRef}`);
  }

  if (!tag) {
    const frames = sprite.frames.map((frame, index) => ({
      index,
      frameId: frame.id,
      durationMs: frame.durationMs,
    }));
    return {
      name: null,
      frames,
      loops: true,
      durationMs: frames.reduce((total, frame) => total + frame.durationMs, 0),
    };
  }

  const order = expandDirection(tag);
  const passes = tag.repeat === 0 ? 1 : Math.max(1, Math.floor(tag.repeat));
  const frames: AnimationFrame[] = [];
  for (let pass = 0; pass < passes; pass++) {
    for (const index of order) {
      const frame = sprite.frames[index];
      if (!frame) continue;
      frames.push({ index, frameId: frame.id, durationMs: frame.durationMs });
    }
  }

  return {
    name: tag.name,
    frames,
    loops: tag.repeat === 0,
    durationMs: frames.reduce((total, frame) => total + frame.durationMs, 0),
  };
}

export interface GifOptions {
  /** Tag to play: ID, name, or index. Omit for the whole timeline in order. */
  tag?: string | number;
  /** Integer upscale factor. Defaults to 1. */
  scale?: number;
  /** Fill the background instead of leaving it transparent. */
  background?: ColorInput | null;
  /** Force looping on or off, overriding the tag's own repeat count. */
  loop?: boolean;
  /** Palette size, 2-256. Defaults to 256, with one slot reserved for transparency. */
  maxColors?: number;
  /** Keep transparency. Defaults to true. */
  transparent?: boolean;
}

/**
 * Encode an animated GIF.
 *
 * One palette is built from every frame together rather than per frame: a palette
 * chosen frame by frame makes flat colours shimmer as the animation plays, which is
 * exactly the artefact a pixel-art GIF must not have. GIF only carries one
 * transparent index, so a single slot is reserved for it and every pixel below half
 * alpha is pointed at that slot.
 */
export function encodeGIF(sprite: Sprite, opts: GifOptions = {}): Uint8Array {
  const sequence = animationSequence(sprite, opts.tag);
  if (sequence.frames.length === 0) {
    throw new Error('Nothing to encode: this document has no frames to play.');
  }

  const scale = Math.max(1, Math.floor(opts.scale ?? 1));
  const transparent = opts.transparent ?? true;
  const maxColors = Math.min(256, Math.max(2, Math.floor(opts.maxColors ?? 256)));

  const frames: PixelBuffer[] = sequence.frames.map((entry) => {
    const composited = compositeFrame(sprite, entry.frameId, { background: opts.background ?? null });
    return scale > 1 ? scaleNearest(composited, scale) : composited;
  });

  const width = frames[0].width;
  const height = frames[0].height;

  const combined = new Uint8Array(width * height * 4 * frames.length);
  let offset = 0;
  for (const frame of frames) {
    combined.set(frame.data, offset);
    offset += frame.data.length;
  }

  const palette = quantize(combined, Math.max(2, transparent ? maxColors - 1 : maxColors));
  let transparentIndex = -1;
  if (transparent) {
    transparentIndex = palette.length;
    palette.push([0, 0, 0]);
  }

  const loops = opts.loop ?? sequence.loops;
  const gif = GIFEncoder();
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const index = applyPalette(frame.data, palette);
    if (transparentIndex >= 0) {
      for (let p = 0; p < index.length; p++) {
        if (frame.data[p * 4 + 3] < 128) index[p] = transparentIndex;
      }
    }
    gif.writeFrame(index, width, height, {
      palette,
      delay: sequence.frames[i].durationMs,
      repeat: loops ? 0 : -1,
      transparent: transparentIndex >= 0,
      transparentIndex: transparentIndex >= 0 ? transparentIndex : 0,
      // Restore to background between frames, or a moving sprite smears.
      dispose: 2,
    });
  }
  gif.finish();
  return gif.bytes();
}
