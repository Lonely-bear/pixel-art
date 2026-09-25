import { z } from 'zod';
import { blendInto } from '../blend.js';
import { PixelBuffer } from '../buffer.js';
import { colorToHex, packColor, parseColor } from '../color.js';
import {
  defaultLayerName,
  findLayerIndex,
  getLayer,
  resolveFrame,
  resolveLayer,
  type AnimationTag,
  type Layer,
} from '../document.js';
import { makeId } from '../ids.js';
import { quantizeBuffer } from '../palette.js';
import { buildHueRamp } from '../ramp.js';
import {
  blendSchema,
  colorSchema,
  defineCommand,
  ditherPatternSchema,
  frameIdOf,
  frameRefSchema,
  layerIdOf,
  layerRefSchema,
  resolveColor,
} from './types.js';

/* ------------------------------------------------------------------ *
 * Layers
 * ------------------------------------------------------------------ */

export const addLayerCommand = defineCommand({
  name: 'add_layer',
  description:
    'Create a new empty layer. Returns its generated ID. `index` is the paint position counting from the bottom; omit it to add on top.',
  params: z.object({
    name: z.string().optional(),
    index: z.number().int().optional().describe('Insert position, bottom-first. Omit for the top.'),
  }),
  apply(ctx, p) {
    const layer: Layer = {
      id: makeId('lay'),
      name: p.name || defaultLayerName(ctx.sprite.layers.length),
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: 'normal',
    };
    const at =
      p.index === undefined
        ? ctx.sprite.layers.length
        : Math.max(0, Math.min(ctx.sprite.layers.length, p.index));
    ctx.sprite.layers.splice(at, 0, layer);
    return { layerId: layer.id, index: at, name: layer.name };
  },
});

export const removeLayerCommand = defineCommand({
  name: 'remove_layer',
  description: 'Delete a layer and every cel it owns across all frames. Refuses to remove the last remaining layer.',
  params: z.object({ layer: layerRefSchema }),
  apply(ctx, p) {
    if (ctx.sprite.layers.length <= 1) {
      throw new Error('Cannot remove the last remaining layer');
    }
    const layer = resolveLayer(ctx.sprite, p.layer);
    const index = findLayerIndex(ctx.sprite, layer.id);
    ctx.sprite.layers.splice(index, 1);
    for (const frame of ctx.sprite.frames) frame.cels.delete(layer.id);
    return { removed: layer.id, name: layer.name, index };
  },
});

export const updateLayerCommand = defineCommand({
  name: 'update_layer',
  description: 'Change a layer\'s name, visibility, lock, opacity or blend mode. Only the fields you pass are touched.',
  params: z.object({
    layer: layerRefSchema,
    name: z.string().optional(),
    visible: z.boolean().optional(),
    locked: z.boolean().optional(),
    opacity: z.number().min(0).max(1).optional(),
    blendMode: blendSchema.optional(),
  }),
  apply(ctx, p) {
    const layer = resolveLayer(ctx.sprite, p.layer);
    if (p.name !== undefined) layer.name = p.name;
    if (p.visible !== undefined) layer.visible = p.visible;
    if (p.locked !== undefined) layer.locked = p.locked;
    if (p.opacity !== undefined) layer.opacity = p.opacity;
    if (p.blendMode !== undefined) layer.blendMode = p.blendMode;
    return { layerId: layer.id };
  },
});

export const reorderLayerCommand = defineCommand({
  name: 'reorder_layer',
  description: 'Move a layer to a new paint position, counting from the bottom.',
  params: z.object({
    layer: layerRefSchema,
    index: z.number().int().describe('Target position, bottom-first.'),
  }),
  apply(ctx, p) {
    const layer = resolveLayer(ctx.sprite, p.layer);
    const from = findLayerIndex(ctx.sprite, layer.id);
    ctx.sprite.layers.splice(from, 1);
    const to = Math.max(0, Math.min(ctx.sprite.layers.length, p.index));
    ctx.sprite.layers.splice(to, 0, layer);
    return { layerId: layer.id, from, to };
  },
});

export const duplicateLayerCommand = defineCommand({
  name: 'duplicate_layer',
  description: 'Copy a layer and all of its cels, inserting the copy directly above the original.',
  params: z.object({
    layer: layerRefSchema,
    name: z.string().optional(),
  }),
  apply(ctx, p) {
    const source = resolveLayer(ctx.sprite, p.layer);
    const index = findLayerIndex(ctx.sprite, source.id);
    const copy: Layer = {
      ...source,
      id: makeId('lay'),
      name: p.name ?? `${source.name} copy`,
    };
    ctx.sprite.layers.splice(index + 1, 0, copy);
    for (const frame of ctx.sprite.frames) {
      const buf = frame.cels.get(source.id);
      if (buf) frame.cels.set(copy.id, buf.clone());
    }
    return { layerId: copy.id, name: copy.name, index: index + 1 };
  },
});

export const mergeLayerDownCommand = defineCommand({
  name: 'merge_layer_down',
  description:
    'Flatten a layer onto the one below it, honouring the upper layer\'s opacity and blend mode, then delete the upper layer.',
  params: z.object({ layer: layerRefSchema }),
  apply(ctx, p) {
    const upper = resolveLayer(ctx.sprite, p.layer);
    const index = findLayerIndex(ctx.sprite, upper.id);
    if (index <= 0) throw new Error('Cannot merge the bottom layer down');
    const lower = ctx.sprite.layers[index - 1];

    for (const frame of ctx.sprite.frames) {
      const top = frame.cels.get(upper.id);
      if (!top) continue;
      // The lower cel may share pixels with the previous editor state; Draft.cel()
      // clones it before the merge so a failed transaction can roll the pixels back.
      const below = ctx.draft.cel(lower.id, frame.id) ?? new PixelBuffer(ctx.sprite.width, ctx.sprite.height);
      const src = top.data;
      const dst = below.data;
      for (let i = 0; i < src.length; i += 4) {
        if (src[i + 3] === 0) continue;
        blendInto(dst, i, { r: src[i], g: src[i + 1], b: src[i + 2], a: src[i + 3] }, {
          blend: upper.blendMode,
          opacity: upper.opacity,
        });
      }
      frame.cels.delete(upper.id);
    }
    ctx.sprite.layers.splice(index, 1);
    return { merged: upper.id, into: lower.id };
  },
});

/* ------------------------------------------------------------------ *
 * Frames
 * ------------------------------------------------------------------ */

export const addFrameCommand = defineCommand({
  name: 'add_frame',
  description:
    'Append (or insert) a frame. Pass `duplicateOf` to seed the new frame with copies of another frame\'s cels — the usual way to build an animation.',
  params: z.object({
    index: z.number().int().optional().describe('Insert position. Omit to append at the end.'),
    durationMs: z.number().int().min(1).optional().describe('Frame duration in milliseconds. Defaults to 100.'),
    duplicateOf: frameRefSchema.optional().describe('Frame to copy cels from.'),
  }),
  apply(ctx, p) {
    const cels = new Map<string, PixelBuffer>();
    let durationMs = p.durationMs ?? 100;
    if (p.duplicateOf !== undefined) {
      const source = resolveFrame(ctx.sprite, p.duplicateOf);
      durationMs = p.durationMs ?? source.durationMs;
      for (const [layerId, buf] of source.cels) cels.set(layerId, buf.clone());
    }
    const frame = { id: makeId('frm'), durationMs, cels };
    const at =
      p.index === undefined
        ? ctx.sprite.frames.length
        : Math.max(0, Math.min(ctx.sprite.frames.length, p.index));
    ctx.sprite.frames.splice(at, 0, frame);
    return { frameId: frame.id, index: at, durationMs };
  },
});

export const removeFrameCommand = defineCommand({
  name: 'remove_frame',
  description: 'Delete a frame. Refuses to remove the last remaining frame.',
  params: z.object({ frame: frameRefSchema }),
  apply(ctx, p) {
    if (ctx.sprite.frames.length <= 1) throw new Error('Cannot remove the last remaining frame');
    const frame = resolveFrame(ctx.sprite, p.frame);
    const index = ctx.sprite.frames.indexOf(frame);
    ctx.sprite.frames.splice(index, 1);
    return { removed: frame.id, index };
  },
});

export const duplicateFrameCommand = defineCommand({
  name: 'duplicate_frame',
  description: 'Copy a frame `count` times, inserting the copies directly after the original.',
  params: z.object({
    frame: frameRefSchema,
    count: z.number().int().min(1).optional().describe('How many copies. Defaults to 1.'),
  }),
  apply(ctx, p) {
    const source = resolveFrame(ctx.sprite, p.frame);
    const index = ctx.sprite.frames.indexOf(source);
    const count = p.count ?? 1;
    const created: string[] = [];
    for (let i = 0; i < count; i++) {
      const cels = new Map<string, PixelBuffer>();
      for (const [layerId, buf] of source.cels) cels.set(layerId, buf.clone());
      const frame = { id: makeId('frm'), durationMs: source.durationMs, cels };
      ctx.sprite.frames.splice(index + 1 + i, 0, frame);
      created.push(frame.id);
    }
    return { frameIds: created, count };
  },
});

export const updateFrameCommand = defineCommand({
  name: 'update_frame',
  description: 'Change a frame\'s duration in milliseconds.',
  params: z.object({
    frame: frameRefSchema,
    durationMs: z.number().int().min(1),
  }),
  apply(ctx, p) {
    const frame = resolveFrame(ctx.sprite, p.frame);
    const previous = frame.durationMs;
    frame.durationMs = p.durationMs;
    return { frameId: frame.id, previous, durationMs: p.durationMs };
  },
});

export const reorderFrameCommand = defineCommand({
  name: 'reorder_frame',
  description: 'Move a frame to a new index.',
  params: z.object({
    frame: frameRefSchema,
    index: z.number().int(),
  }),
  apply(ctx, p) {
    const frame = resolveFrame(ctx.sprite, p.frame);
    const from = ctx.sprite.frames.indexOf(frame);
    ctx.sprite.frames.splice(from, 1);
    const to = Math.max(0, Math.min(ctx.sprite.frames.length, p.index));
    ctx.sprite.frames.splice(to, 0, frame);
    return { frameId: frame.id, from, to };
  },
});

/* ------------------------------------------------------------------ *
 * Palette
 * ------------------------------------------------------------------ */

export const setPaletteCommand = defineCommand({
  name: 'set_palette',
  description: 'Replace the entire palette. Does not repaint existing pixels unless you also call `quantize_to_palette`.',
  params: z.object({
    colors: z.array(colorSchema).min(1),
    name: z.string().optional(),
  }),
  apply(ctx, p) {
    const palette = ctx.draft.palette();
    palette.colors = p.colors.map((c) => parseColor(c));
    if (p.name !== undefined) palette.name = p.name;
    return { paletteId: palette.id, size: palette.colors.length };
  },
});

export const setPaletteColorCommand = defineCommand({
  name: 'set_palette_color',
  description: 'Change a single palette entry by index.',
  params: z.object({
    index: z.number().int().min(0),
    color: colorSchema,
  }),
  apply(ctx, p) {
    const palette = ctx.draft.palette();
    if (p.index >= palette.colors.length) {
      throw new Error(`Palette index ${p.index} is out of range (size ${palette.colors.length})`);
    }
    palette.colors[p.index] = parseColor(p.color);
    return { index: p.index, color: palette.colors[p.index] };
  },
});

export const addPaletteColorCommand = defineCommand({
  name: 'add_palette_color',
  description: 'Append a colour to the palette. Returns its index.',
  params: z.object({ color: colorSchema }),
  apply(ctx, p) {
    const palette = ctx.draft.palette();
    palette.colors.push(parseColor(p.color));
    return { index: palette.colors.length - 1, size: palette.colors.length };
  },
});

export const addPaletteRampCommand = defineCommand({
  name: 'add_palette_ramp',
  description:
    'Generate a hue-shifted colour ramp between two anchors and add it to the palette (or replace the palette with it). `hueShift` pulls the dark end toward blue and the light end toward amber by that many degrees; `shadowHue`/`highlightHue` set absolute endpoint hues instead. `saturationBoost` adds richness in the middle. This is the fastest way to build a coherent 3-8 step ramp for a material without hand-picking every colour.',
  params: z.object({
    from: colorSchema.describe('Dark anchor colour.'),
    to: colorSchema.describe('Light anchor colour.'),
    steps: z.number().int().min(2).max(32).optional().describe('Number of ramp colours. Defaults to 5.'),
    hueShift: z
      .number()
      .min(0)
      .max(90)
      .optional()
      .describe('Degrees to pull shadows toward blue and highlights toward amber. Defaults to 20. Pass 0 to keep the anchor hues.'),
    shadowHue: z
      .number()
      .min(0)
      .max(360)
      .optional()
      .describe('Absolute hue (0-360) for the dark end, overriding `hueShift` there.'),
    highlightHue: z
      .number()
      .min(0)
      .max(360)
      .optional()
      .describe('Absolute hue (0-360) for the light end, overriding `hueShift` there.'),
    saturationBoost: z
      .number()
      .min(-0.5)
      .max(0.5)
      .optional()
      .describe('Extra saturation at the middle of the ramp. Defaults to 0.'),
    mode: z
      .enum(['append', 'replace'])
      .optional()
      .describe('`append` (default) adds the ramp to the existing palette; `replace` swaps the whole palette for it.'),
    dedupe: z.boolean().optional().describe('Skip colours already present in the palette. Defaults to true.'),
    name: z.string().optional().describe('Optional palette name, applied with either mode.'),
  }),
  apply(ctx, p) {
    const palette = ctx.draft.palette();
    const from = resolveColor(ctx.sprite, p.from);
    const to = resolveColor(ctx.sprite, p.to);
    const ramp = buildHueRamp(from, to, p.steps ?? 5, {
      hueShift: p.hueShift ?? 20,
      shadowHue: p.shadowHue,
      highlightHue: p.highlightHue,
      saturationBoost: p.saturationBoost,
    });
    const mode = p.mode ?? 'append';
    const existing = new Set(palette.colors.map((color) => packColor(color)));
    let added = 0;
    let skipped = 0;
    if (mode === 'replace') {
      palette.colors = ramp.colors.slice();
      added = ramp.colors.length;
    } else {
      for (const color of ramp.colors) {
        const key = packColor(color);
        if (p.dedupe !== false && existing.has(key)) {
          skipped++;
          continue;
        }
        palette.colors.push(color);
        existing.add(key);
        added++;
      }
    }
    if (p.name !== undefined) palette.name = p.name;
    return {
      mode,
      from: colorToHex(from),
      to: colorToHex(to),
      requested: p.steps ?? 5,
      added,
      skipped,
      size: palette.colors.length,
      colors: ramp.hex,
      hue: ramp.hue,
    };
  },
});

export const removePaletteColorCommand = defineCommand({
  name: 'remove_palette_color',
  description: 'Remove a palette entry by index. Refuses to empty the palette.',
  params: z.object({ index: z.number().int().min(0) }),
  apply(ctx, p) {
    const palette = ctx.draft.palette();
    if (palette.colors.length <= 1) throw new Error('Cannot empty the palette');
    if (p.index >= palette.colors.length) {
      throw new Error(`Palette index ${p.index} is out of range (size ${palette.colors.length})`);
    }
    const [removed] = palette.colors.splice(p.index, 1);
    return { index: p.index, removed };
  },
});

export const quantizeToPaletteCommand = defineCommand({
  name: 'quantize_to_palette',
  description:
    'Snap existing pixels onto the palette, optionally with dithering. This is how you pull AI-generated colour back onto an artist\'s ramp. Scope it with `layer` and/or `frame`; omitting both affects every cel in the sprite.',
  params: z.object({
    layer: layerRefSchema.optional(),
    frame: frameRefSchema.optional(),
    dither: z
      .union([z.literal('none'), z.literal('floyd'), ditherPatternSchema])
      .optional()
      .describe('`none` for a straight nearest-colour snap, a pattern name for ordered dithering, or `floyd`.'),
    strength: z.number().optional().describe('Ordered-dither strength in colour units. Defaults to 48.'),
    alphaThreshold: z.number().min(0).max(255).optional(),
  }),
  apply(ctx, p) {
    const palette = ctx.draft.palette();
    const opts = {
      dither: p.dither as never,
      strength: p.strength,
      alphaThreshold: p.alphaThreshold,
    };

    let targets = ctx.draft.allCels();
    if (p.layer !== undefined) {
      const layerId = layerIdOf(ctx.sprite, p.layer);
      targets = targets.filter((t) => t.layerId === layerId);
    }
    if (p.frame !== undefined) {
      const frameId = frameIdOf(ctx.sprite, p.frame);
      targets = targets.filter((t) => t.frameId === frameId);
    }

    let touched = 0;
    for (const { buffer } of targets) {
      const quantized = quantizeBuffer(buffer, palette, opts);
      buffer.data.set(quantized.data);
      touched++;
    }
    return { cels: touched, dither: p.dither ?? 'none', paletteSize: palette.colors.length };
  },
});

/* ------------------------------------------------------------------ *
 * Animation tags
 * ------------------------------------------------------------------ */

export function resolveTag(sprite: { tags: AnimationTag[] }, ref: string | number): AnimationTag {
  if (typeof ref === 'number') {
    const tag = sprite.tags[ref];
    if (!tag) throw new Error(`Tag index out of range: ${ref}`);
    return tag;
  }
  const byId = sprite.tags.find((t) => t.id === ref);
  if (byId) return byId;
  const byName = sprite.tags.find((t) => t.name === ref);
  if (byName) return byName;
  throw new Error(`Unknown tag: ${ref}`);
}

const tagRefSchema = z
  .union([z.string(), z.number().int()])
  .describe('Tag ID, tag name, or 0-based index.');

export const addTagCommand = defineCommand({
  name: 'add_tag',
  description:
    'Name a frame range as an animation (e.g. "walk", "idle"). Tags are what engines read when they import the spritesheet.',
  params: z.object({
    name: z.string(),
    from: z.number().int().min(0).describe('First frame index, inclusive.'),
    to: z.number().int().min(0).describe('Last frame index, inclusive.'),
    direction: z.enum(['forward', 'reverse', 'pingpong']).optional(),
    repeat: z.number().int().min(0).optional().describe('0 means loop forever.'),
  }),
  apply(ctx, p) {
    const maxIndex = ctx.sprite.frames.length - 1;
    if (p.from > maxIndex || p.to > maxIndex) {
      throw new Error(`Tag range ${p.from}-${p.to} exceeds frame count (${ctx.sprite.frames.length})`);
    }
    const from = Math.min(p.from, p.to);
    const to = Math.max(p.from, p.to);
    const tag: AnimationTag = {
      id: makeId('tag'),
      name: p.name,
      from,
      to,
      direction: p.direction ?? 'forward',
      repeat: p.repeat ?? 0,
    };
    ctx.sprite.tags.push(tag);
    return { tagId: tag.id, name: tag.name, from, to };
  },
});

export const removeTagCommand = defineCommand({
  name: 'remove_tag',
  description: 'Delete an animation tag.',
  params: z.object({ tag: tagRefSchema }),
  apply(ctx, p) {
    const tag = resolveTag(ctx.sprite, p.tag);
    const index = ctx.sprite.tags.indexOf(tag);
    ctx.sprite.tags.splice(index, 1);
    return { removed: tag.id, name: tag.name };
  },
});

export const updateTagCommand = defineCommand({
  name: 'update_tag',
  description: 'Change an animation tag\'s name, range, direction or repeat count.',
  params: z.object({
    tag: tagRefSchema,
    name: z.string().optional(),
    from: z.number().int().min(0).optional(),
    to: z.number().int().min(0).optional(),
    direction: z.enum(['forward', 'reverse', 'pingpong']).optional(),
    repeat: z.number().int().min(0).optional(),
  }),
  apply(ctx, p) {
    const tag = resolveTag(ctx.sprite, p.tag);
    const maxIndex = ctx.sprite.frames.length - 1;
    if (p.name !== undefined) tag.name = p.name;
    if (p.from !== undefined) tag.from = Math.min(p.from, maxIndex);
    if (p.to !== undefined) tag.to = Math.min(p.to, maxIndex);
    if (tag.from > tag.to) [tag.from, tag.to] = [tag.to, tag.from];
    if (p.direction !== undefined) tag.direction = p.direction;
    if (p.repeat !== undefined) tag.repeat = p.repeat;
    return { tagId: tag.id };
  },
});

/* ------------------------------------------------------------------ *
 * Sprite-level
 * ------------------------------------------------------------------ */

export const renameSpriteCommand = defineCommand({
  name: 'rename_sprite',
  description: 'Set the sprite name.',
  params: z.object({ name: z.string() }),
  apply(ctx, p) {
    const previous = ctx.sprite.name;
    ctx.sprite.name = p.name;
    return { previous, name: p.name };
  },
});

export const getLayerCommand = defineCommand({
  name: 'get_layer',
  description: 'Read one layer\'s properties. Read-only.',
  readOnly: true,
  params: z.object({ layer: layerRefSchema }),
  apply(ctx, p) {
    const layer = getLayer(ctx.sprite, layerIdOf(ctx.sprite, p.layer));
    return { ...layer };
  },
});
