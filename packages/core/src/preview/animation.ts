/**
 * The animation contact sheet, as bytes and metadata - one implementation, in core.
 *
 * ## Why this file exists
 *
 * `animationPreviewPayload` was a ~90-line function private to `packages/mcp/src/tools.ts`, called
 * twice inside that file: once by the `preview_animation` session tool and once by
 * `finalize_document`'s `contact` output. Private meant unreachable, and the cost was concrete
 * rather than theoretical - `share_bundle`'s template schema **refused a `contact` output by
 * name**, because the only implementation of one lived in a layer `packages/core` may not import
 * from. That is the duplication's real bill: a core command could not ship a contact sheet because
 * the renderer was on the wrong side of a package boundary.
 *
 * ## What stayed in the MCP layer, and why
 *
 * **The `ContentBlock` wrapping.** `preview_animation` returns MCP content blocks, and
 * `ContentBlock` is a type from `@modelcontextprotocol/sdk`. Core has no Node and no MCP, so the
 * transport stays where the transport lives: {@link renderAnimationPreview} returns an image or
 * GIF bytes plus the metadata, and `packages/mcp/src/tools.ts` wraps it in two lines. What
 * travels is the pixels and the facts about them, which are the part that was ever duplicated.
 *
 * The sizing helpers moved too - {@link previewFactor}, {@link assertPreviewOutputSize} and
 * {@link resolvePreviewBackground} - rather than being reimplemented here, because a second copy of
 * "how big may a preview be" is a second place the 16-megapixel safety limit can be wrong.
 */
import { PixelBuffer } from '../buffer.js';
import { blendInto } from '../blend.js';
import { parseColor } from '../color.js';
import type { Sprite } from '../document.js';
import { resolveLayer } from '../document.js';
import { animationSequence, encodeGIF } from '../gif.js';
import { compositeFrame } from '../render.js';
import { scaleNearest } from '../transform.js';

/** Even a valid 32x request can ask a 4096px canvas for a four-gigapixel image. */
export const MAX_PREVIEW_OUTPUT_PIXELS = 16_777_216;

/**
 * Integer upscale so a 16x16 sprite is actually legible to a vision model.
 *
 * Named for previews rather than exports: an export's scale is the caller's decision and is never
 * derived, because a delivery that quietly resamples is a delivery nobody asked for.
 */
export function previewFactor(width: number, height: number, target: number, max: number): number {
  const longest = Math.max(width, height);
  if (longest <= 0) return 1;
  return Math.max(1, Math.min(max, Math.floor(target / longest) || 1));
}

/** A preview's background colour, with `null` meaning "leave the transparency alone". */
export function resolvePreviewBackground(value: string | null | undefined): ReturnType<typeof parseColor> | null {
  return value == null ? null : parseColor(value);
}

/** The safety limit, checked on the *output* size, since that is what a client has to decode. */
export function assertPreviewOutputSize(width: number, height: number, factor: number): void {
  const outputWidth = width * factor;
  const outputHeight = height * factor;
  if (outputWidth * outputHeight > MAX_PREVIEW_OUTPUT_PIXELS) {
    throw new Error(
      `Preview would be ${outputWidth}x${outputHeight} (${outputWidth * outputHeight} pixels), above the ${MAX_PREVIEW_OUTPUT_PIXELS}-pixel safety limit. Reduce scale or crop with rect.`,
    );
  }
}

export interface AnimationPreviewOnionOptions {
  before?: number;
  after?: number;
  opacity?: number;
  loop?: boolean;
  beforeTint?: string;
  afterTint?: string;
}

export interface AnimationPreviewOptions {
  tag?: string | number;
  frameOrder?: 'timeline' | 'playback';
  format?: 'png' | 'gif';
  loop?: boolean;
  layout?: 'strip' | 'grid';
  columns?: number;
  padding?: number;
  margin?: number;
  onion?: AnimationPreviewOnionOptions;
  layers?: Array<string | number>;
  scale?: number;
  background?: string | null;
  includeMetadata?: boolean;
}

/**
 * A rendered contact sheet.
 *
 * `image` is set for `format: 'png'` and `bytes` for `format: 'gif'`; exactly one of the two is
 * ever non-null, and the format is in `meta` too, so a caller never has to guess which.
 */
export interface AnimationPreview {
  /** The composited sheet, already scaled to the output size. PNG format only. */
  readonly image?: PixelBuffer;
  /** Encoded GIF bytes. `format: 'gif'` only. */
  readonly bytes?: Uint8Array;
  readonly meta: Record<string, unknown>;
}

/**
 * Alpha-blend one composited frame over another, with an optional flat tint.
 *
 * A tint is applied to the *ghost* only: onion skin exists to show where the frame came from, and
 * a ghost that keeps the source's own colours is indistinguishable from the frame it precedes.
 */
function blendAnimationFrame(
  target: PixelBuffer,
  source: PixelBuffer,
  opacity: number,
  tint: ReturnType<typeof parseColor> | null,
): void {
  if (opacity <= 0) return;
  for (let i = 0; i < source.data.length; i += 4) {
    const alpha = source.data[i + 3];
    if (alpha === 0) continue;
    const color = tint
      ? { r: tint.r, g: tint.g, b: tint.b, a: alpha }
      : { r: source.data[i], g: source.data[i + 1], b: source.data[i + 2], a: alpha };
    blendInto(target.data, i, color, { opacity });
  }
}

/**
 * Render an animation in raw timeline or tag-expanded playback order as one contact sheet.
 *
 * Two orders, because they are different pictures: `timeline` is the document's own frame order -
 * the only order in which "frame 3" means anything - and `playback` is what a tag actually plays,
 * direction and repeat expanded. `tag` without `frameOrder` means playback, because asking for a
 * tag and being handed the timeline is the surprise; `playback` with no tag is refused rather than
 * silently treated as a timeline.
 */
export function renderAnimationPreview(
  sprite: Sprite,
  options: AnimationPreviewOptions = {},
): AnimationPreview {
  const frameOrder = options.frameOrder ?? (options.tag === undefined ? 'timeline' : 'playback');
  if (frameOrder === 'playback' && options.tag === undefined) {
    throw new Error('Playback preview requires a `tag`; use frameOrder: "timeline" to preview the whole document.');
  }
  const sequence = frameOrder === 'timeline'
    ? animationSequence(sprite)
    : animationSequence(sprite, options.tag);
  if (sequence.frames.length === 0) throw new Error('Animation preview has no frames.');

  if (options.format === 'gif') {
    const scale = Math.max(1, Math.floor(options.scale ?? 1));
    const playbackTag = frameOrder === 'playback' ? options.tag : undefined;
    const bytes = encodeGIF(sprite, {
      tag: playbackTag,
      scale,
      background: options.background,
      loop: options.loop,
    });
    return {
      bytes,
      meta: {
        mode: 'animation-preview',
        format: 'gif',
        frameOrder,
        tag: sequence.name,
        frameCount: sequence.frames.length,
        loops: options.loop ?? sequence.loops,
        durationMs: sequence.durationMs,
        scale,
        imageWidth: sprite.width * scale,
        imageHeight: sprite.height * scale,
        ...(options.includeMetadata === false
          ? {}
          : {
              sequence: sequence.frames.map((frame, position) => ({
                position,
                index: frame.index,
                frameId: frame.frameId,
                durationMs: frame.durationMs,
              })),
            }),
      },
    };
  }

  const count = sequence.frames.length;
  const layout = options.layout ?? 'grid';
  const padding = Math.max(0, Math.floor(options.padding ?? 1));
  const margin = Math.max(0, Math.floor(options.margin ?? 1));
  const columns = layout === 'strip'
    ? count
    : Math.max(1, Math.min(count, options.columns ?? Math.ceil(Math.sqrt(count))));
  const rows = Math.ceil(count / columns);
  const sheetWidth = margin * 2 + columns * sprite.width + Math.max(0, columns - 1) * padding;
  const sheetHeight = margin * 2 + rows * sprite.height + Math.max(0, rows - 1) * padding;
  const factor = options.scale ?? previewFactor(sheetWidth, sheetHeight, 256, 16);
  assertPreviewOutputSize(sheetWidth, sheetHeight, factor);

  const background = resolvePreviewBackground(options.background);
  const layerIds = options.layers?.map((ref) => resolveLayer(sprite, ref).id);
  const onion = options.onion;
  const onionOpacity = Math.min(1, Math.max(0, onion?.opacity ?? 0.35));
  const beforeTint = onion?.beforeTint === undefined ? null : parseColor(onion.beforeTint);
  const afterTint = onion?.afterTint === undefined ? null : parseColor(onion.afterTint);
  const sheet = new PixelBuffer(sheetWidth, sheetHeight);

  sequence.frames.forEach((entry, position) => {
    const cell = new PixelBuffer(sprite.width, sprite.height);
    if (background !== undefined && background !== null) cell.fill(background);
    const neighbor = (offset: number): typeof entry | undefined => {
      let index = position + offset;
      if (onion?.loop) index = ((index % count) + count) % count;
      if (index < 0 || index >= count || index === position) return undefined;
      return sequence.frames[index];
    };
    const ghost = (offset: number, tint: ReturnType<typeof parseColor> | null): void => {
      const frame = neighbor(offset);
      if (!frame) return;
      blendAnimationFrame(
        cell,
        compositeFrame(sprite, frame.frameId, { layers: layerIds }),
        onionOpacity,
        tint,
      );
    };
    // Furthest neighbour first, so a nearer ghost lands on top of it rather than under.
    for (let offset = onion?.before ?? 0; offset >= 1; offset--) ghost(-offset, beforeTint);
    for (let offset = onion?.after ?? 0; offset >= 1; offset--) ghost(offset, afterTint);
    blendAnimationFrame(cell, compositeFrame(sprite, entry.frameId, { layers: layerIds }), 1, null);

    const column = position % columns;
    const row = Math.floor(position / columns);
    sheet.blit(cell, margin + column * (sprite.width + padding), margin + row * (sprite.height + padding));
  });

  const shown = factor > 1 ? scaleNearest(sheet, factor) : sheet;
  const metadata = {
    mode: 'animation-preview',
    format: 'png',
    frameOrder,
    tag: sequence.name,
    layout,
    columns,
    rows,
    frameCount: count,
    loops: sequence.loops,
    durationMs: sequence.durationMs,
    onion: onion ?? null,
    layers: layerIds ?? null,
    scale: factor,
    imageWidth: shown.width,
    imageHeight: shown.height,
    ...(options.includeMetadata === false
      ? {}
      : {
          sequence: sequence.frames.map((frame, position) => ({
            position,
            index: frame.index,
            frameId: frame.frameId,
            durationMs: frame.durationMs,
          })),
        }),
  };
  return { image: shown, meta: metadata };
}