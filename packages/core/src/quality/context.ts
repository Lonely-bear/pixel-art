import type { Sprite } from '../document.js';
import { animationSequence } from '../gif.js';
import { compositeFrame } from '../render.js';
import type { FrameId, Rect } from '../types.js';
import type { QualityCel, QualityContext, QualitySprite } from './types.js';

/**
 * Alpha at or above which a pixel is part of the artwork's shape, and below which it is
 * not scored and never enters `N`.
 *
 * A constant rather than a parameter because `QualityContext` is frozen and has nowhere
 * to put one, and because two dimensions that each chose their own threshold would be
 * measuring two different silhouettes and then averaging the results. The spec pins the
 * value at 128 (§3.1) for a reason the drawing commands do not share: those default to
 * `alphaThreshold: 1` so a 1-alpha pixel is paintable, but a 0.2-alpha glow is a design
 * decision rather than a body part, and letting it into the shape would make `outline`
 * trace a halo as a hard contour.
 *
 * It lives here rather than in `types.ts` because that file is frozen, and here because
 * this is the one module all six dimensions import: the value is part of how to *read*
 * `context.composite`, which is what this module is about.
 */
export const ALPHA_SOLID = 128;

/** What {@link createQualityContext} may be asked to vary. Nothing else reaches an analyzer. */
export interface QualityContextOptions {
  /**
   * The frames to judge, **in playback order**. Omitted means "every frame, once, in
   * document order" — see the default rule on {@link createQualityContext}.
   */
  readonly frames?: readonly FrameId[];
  /**
   * The region to judge, or `null` (the default) for the whole canvas. A scope, not a
   * crop; see the note on `QualityContext.focus`.
   */
  readonly focus?: Rect | null;
}

/**
 * The one `QualityContext` builder, and the only place a `Sprite` becomes something an
 * analyzer may see.
 *
 * Two decisions are made here rather than in each of the six analyzers, because both of
 * them can silently split a score in half if two callers disagree:
 *
 * **1. The frame list is in playback order, and the default is every frame once.** The
 * contract says `frameIds` is "the order the viewer sees them, not document order", so
 * that `motion` can measure the seam between the last frame and the first without
 * knowing that tags exist. The default therefore *never* narrows the measurement: an
 * untargeted `createQualityContext(sprite)` is all frames, once, in document order, so a
 * caller who forgets to pass a target still gets everything measured. Choosing "the first
 * tag" as the default would be worse than useless — a sprite with two tags would be
 * scored against whichever the artist happened to define first, and the other would
 * never be looked at.
 *
 * The direction rules live in `animationSequence` rather than being written a second
 * time here, for the same reason every other quantity in this pipeline has one home: a
 * second implementation of "what order does a pingpong tag play in" is a silent
 * disagreement between this module and the GIF exporter. A caller that *does* want a
 * specific loop passes
 * `animationSequence(sprite, tagRef).frames.map((f) => f.frameId)` as `frames`.
 *
 * **2. Nothing is cropped, ever.** `focus` is a scope, not a mask. No analyzer
 * reimplements the crop because for `silhouette` a crop is not a smaller measurement, it
 * is a *different and wrong* one: clipping the solid mask to a box makes the box's own
 * border look like the sprite's border (`shape-clipped` would fire on the focus rect),
 * and a mask cut along a straight line acquires a straight edge that reads as a hole's
 * wall. So `focus` narrows which defects you are *told about*, and the quantities are
 * still measured over the whole canvas. See `silhouette.ts` for where that lands.
 *
 * A live `Sprite` is assignable to `QualitySprite` field for field, so the sprite is
 * handed through as a view — no clone, no adapter, one pass per dimension rather than a
 * deep copy per dimension. `compositeFrame` returns a `PixelBuffer`, which satisfies
 * `QualityCel` as-is, so the flattened frames need no wrapping either.
 *
 * Throws on a `frames` entry the document does not have. Narrowing the list to whatever
 * happens to exist would turn a caller bug into a silently smaller measurement, which is
 * the one failure this function is built to make impossible.
 */
export function createQualityContext(
  sprite: Sprite,
  options: QualityContextOptions = {},
): QualityContext {
  const frameIds = resolveFrameIds(sprite, options.frames);
  const known = new Set(sprite.frames.map((frame) => frame.id));
  for (const id of frameIds) {
    if (!known.has(id)) throw new Error(`Unknown frame: ${id}`);
  }

  // Index-aligned with `frameIds` on purpose: an analyzer that zipped the two lists
  // itself would have exactly one way to get it wrong, and that way would be invisible.
  const composite: QualityCel[] = frameIds.map((id) => compositeFrame(sprite, id));

  return {
    // Hoisted from the same sprite as `composite` and the size, in one object literal, so
    // no pass can read a width from one document and pixels from another.
    sprite: sprite as QualitySprite,
    frameIds,
    palette: sprite.palette,
    composite,
    width: sprite.width,
    height: sprite.height,
    focus: options.focus ?? null,
  };
}

/**
 * The default frame list: every frame, once, in document order.
 *
 * `animationSequence` with no tag reference is exactly that, and calling it rather than
 * `sprite.frames.map(...)` is what keeps the untargeted case and the targeted case on one
 * code path — a future change to how a sequence is assembled cannot then make the default
 * mean something different from what the exporters mean.
 */
function resolveFrameIds(sprite: Sprite, frames: readonly FrameId[] | undefined): readonly FrameId[] {
  if (frames !== undefined) return frames;
  return animationSequence(sprite).frames.map((frame) => frame.frameId);
}
