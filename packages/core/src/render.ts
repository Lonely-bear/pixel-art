import { blendInto } from './blend.js';
import { PixelBuffer } from './buffer.js';
import { parseColor } from './color.js';
import { getFrame, type Layer, type Sprite } from './document.js';
import type { AssetFacing } from './asset/schema.js';
import { maskFromBuffer } from './raster.js';
import type { Color, ColorInput, FrameId, LayerId } from './types.js';

export interface CompositeOptions {
  /** Restrict to these layers (by ID), bottom-first order still applies. */
  layers?: readonly LayerId[];
  /** Fill the background instead of leaving it transparent. */
  background?: ColorInput | null;
  /** Skip layers that are hidden. Defaults to true. */
  respectVisibility?: boolean;
  /**
   * Overlay a marker showing which way this frame faces.
   *
   * An **option on the existing composite path**, not a separate renderer, so every consumer
   * of `compositeFrame` — the spritesheet builder, the GIF writer, the MCP `get_preview`
   * tool, `renderThumbnail` — gets it by passing one field rather than by being rewritten.
   * `null` or absent draws nothing, which keeps every existing call byte-identical.
   */
  facing?: string | null;
  /** Colour for the facing marker. Defaults to a mid grey that reads on most art. */
  facingColor?: ColorInput;
}

/**
 * A facing marker: a 5x5 arrow pointing the way the sprite faces.
 *
 * **Hand-drawn bitmaps, not trigonometry**, and the reason is the determinism rule rather
 * than taste. `Math.atan2`/`Math.sin` are implementation-approximated — a value one ULP
 * either side of a rounding boundary puts the arrowhead on the wrong side of a cell on a
 * different engine — and `test/determinism.test.ts` pins the exact set of files allowed to
 * call them. Eight strings cannot drift that way. `NE` and `SW` share one diagonal glyph
 * because they are the same diagonal with the arrowhead at the other end, which is exactly
 * what they are.
 */
const FACING_ARROWS: Readonly<Record<AssetFacing, readonly string[]>> = {
  N: ['..#..', '.###.', '#.#.#', '..#..', '..#..'],
  NE: ['....#', '...##', '#.###', '##...', '#....'],
  E: ['..#..', '..##.', '#####', '..##.', '..#..'],
  SE: ['#....', '##...', '#.###', '...##', '....#'],
  S: ['..#..', '..#..', '#.#.#', '.###.', '..#..'],
  SW: ['#....', '##...', '###.#', '...##', '....#'],
  W: ['..#..', '.##..', '#####', '.##..', '..#..'],
  NW: ['....#', '...##', '###.#', '##...', '....#'],
  none: ['.....', '.###.', '.###.', '.###.', '.....'],
};

/**
 * Canonical label for each arrow, so callers can pass `'south'` or `'S'`.
 *
 * Typed as {@link AssetFacing} rather than `keyof typeof FACING_ARROWS` so the return type is
 * the contract's closed enum. `AssetFacing` is a *type-only* import of an enum a zod schema
 * produces, so this costs no runtime dependency on `asset/` and no cycle: `asset/schema.ts`
 * imports nothing from `render.ts`.
 */
const FACING_LOOKUP: Readonly<Record<string, AssetFacing>> = {
  n: 'N',
  north: 'N',
  ne: 'NE',
  northeast: 'NE',
  e: 'E',
  east: 'E',
  se: 'SE',
  southeast: 'SE',
  s: 'S',
  south: 'S',
  sw: 'SW',
  southwest: 'SW',
  w: 'W',
  west: 'W',
  nw: 'NW',
  northwest: 'NW',
  none: 'none',
};

/**
 * The canonical label for a facing string, or `null` when it names no known direction.
 *
 * **The one implementation of this rule.** `asset/build.ts` re-exports it as
 * `normalizeFacingLabel` rather than keeping a second copy: two tables that are supposed to
 * agree are exactly the failure this repository keeps paying for, and a test asserting they
 * agree is a test that fails after the damage rather than preventing it.
 */
export function normalizeFacing(facing: string): AssetFacing | null {
  const key = facing.trim().toLowerCase().replace(/[\s_-]/g, '');
  return Object.prototype.hasOwnProperty.call(FACING_LOOKUP, key) ? FACING_LOOKUP[key] : null;
}

/**
 * Draw a facing marker into a buffer, top-left corner of the cell at `x, y`.
 *
 * Clipped rather than throwing on an out-of-bounds origin: a marker on a 2x2 thumbnail is
 * the normal case at small scales, and the alternative is every preview caller guarding.
 * An unknown label draws nothing — a preview must not invent a direction, which is the same
 * rule the contract follows.
 */
export function drawFacingMarker(
  target: PixelBuffer,
  facing: string | null | undefined,
  x = 0,
  y = 0,
  color: ColorInput = '#808080',
): void {
  if (facing == null) return;
  const canonical = normalizeFacing(facing);
  if (canonical === null) return;
  const rows = FACING_ARROWS[canonical];
  const ink = parseColor(color);
  for (let row = 0; row < rows.length; row++) {
    const line = rows[row];
    for (let column = 0; column < line.length; column++) {
      if (line[column] !== '#') continue;
      const px = x + column;
      const py = y + row;
      if (!target.contains(px, py)) continue;
      const i = target.index(px, py);
      target.data[i] = ink.r;
      target.data[i + 1] = ink.g;
      target.data[i + 2] = ink.b;
      target.data[i + 3] = 255;
    }
  }
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
  if (opts.facing != null) drawFacingMarker(out, opts.facing, 0, 0, opts.facingColor ?? '#808080');
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

export interface FrameMaskOptions {
  /**
   * Leave this layer out of the composite.
   *
   * `clip: 'composite'` means "only where the sprite already has pixels", and when the
   * command is painting *into* a layer, that layer's own pixels must not count as the
   * silhouette — otherwise the clip is a no-op and the shape still bleeds outward.
   */
  excludeLayerId?: LayerId;
  /** Alpha at or above this counts as opaque. Defaults to 1. */
  alphaThreshold?: number;
  /** Include hidden layers. Defaults to false. */
  respectVisibility?: boolean;
}

/**
 * The opacity mask of a composited frame, one byte per pixel, 1 where opaque.
 *
 * This is the silhouette that a `clip: 'composite'` paint is allowed to touch: the shape
 * the *other* layers define, so a shadow can be drawn into a new layer without spilling
 * into the transparent corners of its bounding box.
 */
export function frameMask(sprite: Sprite, frameId: FrameId, opts: FrameMaskOptions = {}): Uint8Array {
  const layers = opts.excludeLayerId
    ? sprite.layers.filter((layer) => layer.id !== opts.excludeLayerId).map((layer) => layer.id)
    : undefined;
  const composite = compositeFrame(sprite, frameId, {
    layers,
    respectVisibility: opts.respectVisibility ?? true,
  });
  return maskFromBuffer(composite, { alphaThreshold: opts.alphaThreshold });
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

export interface OnionSkinOptions extends CompositeOptions {
  /** Number of frames *before* the current one to ghost in. Defaults to 0. */
  before?: number;
  /** Number of frames *after* the current one to ghost in. Defaults to 0. */
  after?: number;
  /** Alpha multiplier for the ghosted frames, 0-1. Defaults to 0.35. */
  opacity?: number;
  /** Wrap around the frame list, so frame 0 sees the last frame as "before". Defaults to false. */
  loop?: boolean;
  /** Replace the RGB of earlier frames with this colour, keeping their alpha. */
  beforeTint?: ColorInput;
  /** Replace the RGB of later frames with this colour, keeping their alpha. */
  afterTint?: ColorInput;
}

/**
 * Composite a frame with onion-skin ghosts of its neighbours.
 *
 * The ghosts are drawn *behind* the current frame at reduced alpha, so the artist sees
 * the motion arc without it competing with the pose being drawn. Tints (typically a warm
 * colour for the past and a cool one for the future) turn the ghosts into silhouettes and
 * make the direction of motion readable at a glance.
 *
 * With `before` and `after` both 0 this is exactly `compositeFrame`.
 */
export function compositeWithOnion(
  sprite: Sprite,
  frameId: FrameId,
  opts: OnionSkinOptions = {},
): PixelBuffer {
  const before = Math.max(0, Math.floor(opts.before ?? 0));
  const after = Math.max(0, Math.floor(opts.after ?? 0));
  const opacity = Math.min(1, Math.max(0, opts.opacity ?? 0.35));
  const current = sprite.frames.findIndex((f) => f.id === frameId);
  const out = new PixelBuffer(sprite.width, sprite.height);
  if (opts.background != null) out.fill(opts.background);

  if ((before === 0 && after === 0) || current < 0) {
    // `facing` is honoured here rather than dropped, because `OnionSkinOptions` extends
    // `CompositeOptions` and an option that is inherited and then ignored is a caller who
    // asked for a marker and got none without being told. Same code path, so it cannot
    // diverge from `compositeFrame`'s.
    blendBuffer(out, compositeFrame(sprite, frameId, opts), 1, null);
    if (opts.facing != null) drawFacingMarker(out, opts.facing, 0, 0, opts.facingColor ?? '#808080');
    return out;
  }

  const count = sprite.frames.length;
  const ghost = (offset: number, tint: ColorInput | undefined): void => {
    let index = current + offset;
    if (opts.loop) index = ((index % count) + count) % count;
    if (index < 0 || index >= count || index === current) return;
    const buffer = compositeFrame(sprite, sprite.frames[index].id, {
      layers: opts.layers,
      respectVisibility: opts.respectVisibility,
    });
    blendBuffer(out, buffer, opacity, tint === undefined ? null : parseColor(tint));
  };

  // Farther ghosts first, so the nearest frame ends up on top of the older ones.
  for (let offset = before; offset >= 1; offset--) ghost(-offset, opts.beforeTint);
  for (let offset = after; offset >= 1; offset--) ghost(offset, opts.afterTint);

  blendBuffer(out, compositeFrame(sprite, frameId, {
    layers: opts.layers,
    respectVisibility: opts.respectVisibility,
  }), 1, null);
  if (opts.facing != null) drawFacingMarker(out, opts.facing, 0, 0, opts.facingColor ?? '#808080');
  return out;
}

/** Alpha-composite `source` onto `target`, optionally tinting it and fading it out. */
function blendBuffer(target: PixelBuffer, source: PixelBuffer, opacity: number, tint: Color | null): void {
  if (opacity <= 0) return;
  const dst = target.data;
  const src = source.data;
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    if (a === 0) continue;
    const color: Color = tint ? { r: tint.r, g: tint.g, b: tint.b, a } : { r: src[i], g: src[i + 1], b: src[i + 2], a };
    blendInto(dst, i, color, { opacity });
  }
}
