import { z } from 'zod';
import type { Atlas } from '../atlas.js';
import { colorToHex } from '../color.js';
import type { AnimationTag, Sprite } from '../document.js';
import { compositeFrame, normalizeFacing } from '../render.js';
import type { PixelBuffer } from '../buffer.js';
import { AssetDigestWriter } from './hash.js';
import {
  ASSET_DIGEST_VERSION,
  ASSET_META_FORMAT,
  ASSET_META_SCHEMA_VERSION,
  assetMetaSchema,
  unwrapSchema,
  type AssetFacing,
  type AssetMeta,
  type AssetMetaLicense,
  type AssetMetaOutput,
} from './schema.js';

/**
 * The generator: a document in, a `meta.json` byte string out.
 *
 * Nothing here reads a clock, a random source, a locale or the filesystem. The same
 * document produces the same bytes on every machine, which is the property that lets the
 * five importers compare what they were handed against what they expected.
 *
 * ## Field order is the schema's order
 *
 * {@link serializeAssetMeta} does not trust the builder to insert keys in the right order;
 * it walks `Object.keys(schema.shape)` recursively and re-inserts. The zod declaration in
 * `schema.ts` is therefore the single place the contract's serialisation order is written
 * down, and there is no second list that can disagree with it.
 */

/** The sheet to describe, plus the name it will be written under. */
export interface AssetSheetRef {
  /** The packing result from `buildSpritesheet`. */
  readonly atlas: Atlas;
  /** File name for the sheet PNG, relative to the `meta.json` that will point at it. */
  readonly image: string;
}

export interface AssetMetaOptions {
  /** Describe a spritesheet. Omit for an export of individual PNGs. */
  readonly sheet?: AssetSheetRef;
  /** Other files in the bundle. The sheet itself is `sheet.image`, never repeated here. */
  readonly outputs?: readonly AssetMetaOutput[];
  /**
   * Licensing. Not in the document model, so it cannot be derived and is never invented:
   * omit it and the contract says nothing about permission.
   */
  readonly license?: AssetMetaLicense;
  /**
   * Already-composited frames, in document order.
   *
   * The digest hashes composited pixels, which means one composite per frame. An export
   * that has just composited them for the sheet passes them in here rather than paying for
   * them twice.
   */
  readonly composites?: readonly PixelBuffer[];
  /**
   * Which way each frame faces, in timeline order.
   *
   * **A caller option, never derived.** The document model has no field for it, and the one
   * thing this repository will not do is guess: an angle model (or a naming convention like
   * `walk_s` in a tag name) is a decision somebody makes, and a contract that invents `S` for
   * a frame nobody labelled is a character that walks south on its own. `null` in the list is
   * the honest per-frame answer and is written as `facing: "none"` rather than dropped, so the
   * array keeps one entry per frame.
   *
   * Labels are normalised through {@link normalizeFacingLabel}, so `'south'`, `'South'` and
   * `'S'` all arrive as `'S'`. Anything unrecognised **throws**: a silently-dropped facing is
   * a character that faces the wrong way in the game and nobody can tell from the sheet.
   */
  readonly directions?: readonly (string | null)[];
}

/**
 * The frame order a tag plays, expanded.
 *
 * A deliberate re-implementation of `gif.ts`'s private `expandDirection`, which cannot be
 * imported. The duplication is the reason for `test/asset-contract.test.ts`'s cross-check
 * against `animationSequence`: two copies of a playback rule will drift, and a pingpong
 * that emits `[0,1,2,2,1,0]` instead of `[0,1,2,1]` hitches visibly at the turnaround, so
 * the test fails the moment either copy changes alone.
 *
 * `pingpong` omits both end frames on the return leg, for the reason in `gif.ts`: they
 * have already played once this cycle and repeating them is what makes a bounce stutter.
 */
export function expandTagFrames(tag: AnimationTag): number[] {
  const from = Math.min(tag.from, tag.to);
  const to = Math.max(tag.from, tag.to);
  if (tag.direction === 'reverse') {
    const order: number[] = [];
    for (let i = to; i >= from; i--) order.push(i);
    return order;
  }
  const order: number[] = [];
  for (let i = from; i <= to; i++) order.push(i);
  if (tag.direction === 'pingpong') {
    for (let i = to - 1; i > from; i--) order.push(i);
  }
  return order;
}

/**
 * The mean frame rate, `1000 * count / totalMs`, rounded to three decimals.
 *
 * Rounded rather than emitted raw because a float like `8.333333333333334` in a committed
 * file is a diff nobody can explain, and three decimals is finer than any engine that takes
 * a single fps can use. `Math.round` is exact on the double, so the result is the same on
 * every machine — and {@link nominalFps} is exported so the validator recomputes it with
 * this exact function instead of re-deriving the rule.
 */
export function nominalFps(durationsMs: readonly number[]): number {
  if (durationsMs.length === 0) return 0;
  const total = durationsMs.reduce((sum, ms) => sum + ms, 0);
  if (total <= 0) return 0;
  return Math.round((1000 * durationsMs.length * 1000) / total) / 1000;
}

/**
 * The asset's identity, as a digest over the parts of a document that make it *this* asset.
 *
 * What is inside: canvas size, then every frame's duration and composited RGBA in timeline
 * order, then the palette swatches, then the animation tags. What is outside, and why, is
 * S4.2 of `docs/ASSET-CONTRACT.md` — the short version is that every id in a document is
 * clock-plus-entropy, so including one would make the identity of two identical sprites
 * depend on when they were drawn.
 *
 * The preimage is written out byte by byte rather than as a string, and every
 * variable-length field is length-prefixed, so `["ab","c"]` cannot hash like `["a","bc"]`.
 */
export function assetContentHash(sprite: Sprite, composites?: readonly PixelBuffer[]): string {
  const frames = compositeFrames(sprite, composites);
  const writer = new AssetDigestWriter();
  writer.magic(ASSET_META_FORMAT, ASSET_DIGEST_VERSION);
  writer.u32(sprite.width);
  writer.u32(sprite.height);
  writer.u32(sprite.frames.length);
  sprite.frames.forEach((frame, index) => {
    writer.u32(frame.durationMs);
    const pixels = frames[index];
    writer.u32(pixels.width * pixels.height * 4);
    writer.blob(pixels.data);
  });
  writer.u32(sprite.palette.colors.length);
  for (const color of sprite.palette.colors) {
    writer.u8(color.r).u8(color.g).u8(color.b).u8(color.a);
  }
  writer.u32(sprite.tags.length);
  for (const tag of sprite.tags) {
    writer.ascii(tag.name);
    writer.u32(tag.from).u32(tag.to).u8(directionCode(tag.direction)).u32(tag.repeat);
  }
  return writer.hex();
}

/** The digest's one byte per direction. Published in S4.3 so another language can match it. */
function directionCode(direction: AnimationTag['direction']): number {
  if (direction === 'reverse') return 1;
  if (direction === 'pingpong') return 2;
  return 0;
}

/**
 * The frames to hash, and the one place a wrong input is refused.
 *
 * Both the length and the geometry are checked. A caller that hands back the wrong number
 * of composites would otherwise produce a digest over a different number of frames — a
 * plausible-looking value that means nothing, which is the worst kind.
 */
function compositeFrames(sprite: Sprite, composites?: readonly PixelBuffer[]): PixelBuffer[] {
  if (composites === undefined) return sprite.frames.map((frame) => compositeFrame(sprite, frame.id));
  if (composites.length !== sprite.frames.length) {
    throw new RangeError(
      `Asset metadata needs one composited frame per document frame: got ${composites.length} for ${sprite.frames.length} frames.`,
    );
  }
  for (let i = 0; i < composites.length; i++) {
    const buffer = composites[i];
    if (buffer.width !== sprite.width || buffer.height !== sprite.height) {
      throw new RangeError(
        `Composited frame ${i} is ${buffer.width}x${buffer.height}; the document canvas is ${sprite.width}x${sprite.height}.`,
      );
    }
  }
  return [...composites];
}

/**
 * Project a document into the contract.
 *
 * Refuses a document it cannot describe rather than describing it wrongly. A tileset or a
 * tilemap has a different technical contract — cell geometry, tile properties, terrain
 * edges — and emitting a `kind: "sprite"` file for one is the confidently-wrong answer
 * that costs an integrator a day. So it throws, naming what is unmodelled.
 *
 * Every field it cannot read off the document is a caller option, and every one of those
 * is optional: the generator never invents a licence, a pivot nobody chose, or an output
 * that was not written.
 */
export function buildAssetMeta(sprite: Sprite, options: AssetMetaOptions = {}): AssetMeta {
  if (sprite.frames.length === 0) {
    throw new Error('Cannot describe a document with no frames: there is no asset to describe.');
  }
  if (sprite.tileset) {
    throw new Error(
      'schemaVersion 1 models sprite assets only, and this document carries a tileset. A tileset contract (cell geometry, tile properties, terrain edges) is a separate schema, not a sprite with extra fields.',
    );
  }
  if (sprite.tilemaps && sprite.tilemaps.length > 0) {
    throw new Error(
      'schemaVersion 1 models sprite assets only, and this document carries tilemaps. A tilemap contract (grid dimensions, tile indices, object layers) is a separate schema.',
    );
  }
  const frames = compositeFrames(sprite, options.composites);
  const durationsMs = sprite.frames.map((frame, index) => {
    if (!Number.isInteger(frame.durationMs) || frame.durationMs < 1) {
      // The command bus already rejects these, so this is reachable only from a
      // hand-edited `.pixel` file or a hand-built sprite. Rounding it silently would make
      // the contract disagree with the document it claims to describe.
      throw new RangeError(
        `Frame ${index} has durationMs ${frame.durationMs}; the contract stores whole milliseconds and cannot round this without changing the timing.`,
      );
    }
    return frame.durationMs;
  });
  const totalMs = durationsMs.reduce((sum, ms) => sum + ms, 0);
  // Computed here rather than inline in the literal, because the "omit the whole block when
  // the caller said nothing" rule needs the value twice and a second call would be a second
  // place for the two copies to disagree.
  const directions = directionBlock(sprite, options.directions);

  const meta: AssetMeta = {
    format: ASSET_META_FORMAT,
    schemaVersion: ASSET_META_SCHEMA_VERSION,
    kind: 'sprite',
    asset: {
      name: sprite.name,
      contentHash: assetContentHash(sprite, frames),
    },
    frames: {
      count: sprite.frames.length,
      size: { width: sprite.width, height: sprite.height },
      durationsMs,
      totalMs,
      fps: nominalFps(durationsMs),
      // Spread conditionally rather than always written, because an asset with no direction
      // model must serialise to exactly the bytes it did before this field existed — see S10
      // and the note on `directionBlock`.
      ...(directions ? { directions } : {}),
    },
    ...(sprite.tags.length > 0 ? { animations: animationBlock(sprite) } : {}),
    ...(options.sheet ? { sheet: sheetBlock(sprite, options.sheet) } : {}),
    pivot: pivotBlock(sprite),
    palette: paletteBlock(sprite),
    ...(options.license ? { license: options.license } : {}),
    ...(options.outputs && options.outputs.length > 0 ? { outputs: [...options.outputs] } : {}),
  };
  // The builder is the one place a malformed contract of its own making could escape, so
  // it is checked here rather than trusted. `assertReportInvariants` is the precedent: a
  // malformed report is a bug in the aggregator, not a verdict about the artwork.
  assetMetaSchema.parse(meta);
  return meta;
}

/**
 * Canonicalise one facing label, or return `null` when it is not one of the eight.
 *
 * **A re-export of `render.ts`'s `normalizeFacing`, not a second copy of the table.** Two
 * spellings tables that are supposed to agree are the failure mode this repository has paid
 * for repeatedly: the contract records `'SW'` and the preview draws an `'SE'` arrow, and
 * nothing catches it until someone reviews the art. One implementation, two names, because
 * the contract's vocabulary (`AssetFacing`) and the renderer's (`string`) are deliberately
 * not the same type — a preview accepts whatever a caller has, a contract does not.
 *
 * Returns `null` rather than throwing so callers can decide: {@link directionBlock} turns it
 * into a refusal with the offending label named, and a preview renderer turns it into "draw no
 * marker", which is the right answer for a frame nobody has labelled yet.
 *
 * Deliberately does **not** accept arbitrary text: `'sideways'`, `'front'` and `'up'` have no
 * single mapping onto eight compass points, and picking one would be the generator inventing
 * a decision. `none` is accepted, because "this frame has no stated facing" is a value a
 * caller legitimately has.
 */
export const normalizeFacingLabel: (label: string) => AssetFacing | null = normalizeFacing;

/**
 * `frames.directions`, or `undefined` when the caller supplied no facings at all.
 *
 * Absent rather than empty when nothing was supplied, and that is the whole backward-
 * compatibility story in one line: a file written for an asset with no direction model is
 * byte-identical to what this repository produced before the field existed, so every
 * committed contract and every importer cache key in the wild survives this change untouched.
 *
 * The per-frame animation list is **derived**, by inverting `expandTagFrames` for each tag —
 * the same expanded order `animations.items[].frames` publishes, so a pingpong's repeated
 * frame is listed once and the two blocks cannot disagree about which frames an animation
 * shows. Order is `animations.items` order, which is document order, which is the determinism
 * rule of S11.
 */
function directionBlock(
  sprite: Sprite,
  directions: readonly (string | null)[] | undefined,
): NonNullable<AssetMeta['frames']['directions']> | undefined {
  if (directions === undefined) return undefined;
  if (directions.length !== sprite.frames.length) {
    throw new RangeError(
      `Got ${directions.length} facing label(s) for ${sprite.frames.length} frames; the contract writes one entry per frame so an importer can index by position.`,
    );
  }
  const owners: string[][] = sprite.frames.map(() => []);
  sprite.tags.forEach((tag) => {
    // `expandTagFrames` returns the playback order, so a pingpong names its middle frame
    // **twice**. Deduplicated, because `animations` here is the set of animations that show
    // this frame, not a playback trace — a frame listed twice would also be a frame whose
    // entry disagrees with itself.
    for (const index of expandTagFrames(tag)) {
      if (owners[index] && !owners[index].includes(tag.name)) owners[index].push(tag.name);
    }
  });
  return directions.map((label, index) => {
    if (label === null || label === undefined) {
      return { index, facing: 'none', ...(owners[index].length > 0 ? { animations: owners[index] } : {}) };
    }
    const facing = normalizeFacingLabel(label);
    if (facing === null) {
      throw new RangeError(
        `"${label}" is not one of N, NE, E, SE, S, SW, W, NW or none. The generator refuses an unrecognised facing rather than dropping it, because a silently-missing facing is a character that faces the wrong way in the engine with nothing to trace it to.`,
      );
    }
    return { index, facing, ...(owners[index].length > 0 ? { animations: owners[index] } : {}) };
  });
}

function animationBlock(sprite: Sprite): NonNullable<AssetMeta['animations']> {
  const items = sprite.tags.map((tag) => {
    const order = expandTagFrames(tag);
    // A range pointing past the end of the timeline is reachable from a hand-built
    // document and a hand-edited `.pixel` file, and `upsert_tags` rejects it. Refusing
    // here is what keeps a contract from naming a frame the artwork does not have.
    for (const index of order) {
      if (index < 0 || index >= sprite.frames.length) {
        throw new RangeError(
          `Animation "${tag.name}" spans frames ${tag.from}..${tag.to}, outside the ${sprite.frames.length}-frame timeline.`,
        );
      }
    }
    const durations = order.map((index) => sprite.frames[index].durationMs);
    return {
      name: tag.name,
      from: tag.from,
      to: tag.to,
      direction: tag.direction,
      repeat: tag.repeat,
      // `repeat === 0` is the document's "loop forever". Spelled out as a boolean because
      // every engine asks "does this loop" first, and deriving it from a sentinel at the
      // far end of an export chain is how a two-shot attack ends up looping forever.
      loop: tag.repeat === 0,
      frames: order,
      durationMs: durations.reduce((sum, ms) => sum + ms, 0),
      fps: nominalFps(durations),
    };
  });
  return { default: items[0].name, items };
}

function sheetBlock(sprite: Sprite, sheet: AssetSheetRef): NonNullable<AssetMeta['sheet']> {
  const { atlas } = sheet;
  if (atlas.frames.length !== sprite.frames.length) {
    throw new RangeError(
      `The sheet has ${atlas.frames.length} cells but the document has ${sprite.frames.length} frames; a contract that described one would describe the other.`,
    );
  }
  // One integer factor for the whole sheet, derived rather than declared. `scaleAtlas`
  // refuses anything else, so this can only fail on a hand-built atlas — and failing here
  // beats publishing a `scale` that lies about half the cells.
  const scale = atlas.frames[0].w / sprite.width;
  if (!Number.isInteger(scale) || scale < 1) {
    throw new RangeError(
      `Sheet cells are ${atlas.frames[0].w}x${atlas.frames[0].h} for a ${sprite.width}x${sprite.height} canvas, which is not a whole-number upscale.`,
    );
  }
  for (const frame of atlas.frames) {
    if (frame.w !== sprite.width * scale || frame.h !== sprite.height * scale) {
      throw new RangeError(
        `Sheet cell ${frame.index} is ${frame.w}x${frame.h} while cell 0 establishes a ${scale}x scale; a sheet with mixed cell sizes has no contract.`,
      );
    }
  }
  return {
    image: sheet.image,
    columns: atlas.columns,
    rows: atlas.rows,
    scale,
    size: { width: atlas.width, height: atlas.height },
    regions: atlas.frames.map((frame) => ({
      index: frame.index,
      x: frame.x,
      y: frame.y,
      width: frame.w,
      height: frame.h,
    })),
  };
}

/**
 * The pivot, and the one inference this generator makes.
 *
 * A document with a rig that has exactly one part has said, unambiguously, where its
 * pivot is: a rig with one part has nothing to parent and nothing else to hang an anchor
 * off. Two parts means the rig is a skeleton and the sprite's own origin is still
 * undecided, so the documented fallback applies.
 *
 * The fallback is emitted rather than omitted, with `source` saying which it is — see
 * `assetPivotSourceSchema`. The units are canvas pixels, matching `RigPart.pivot`; Godot's
 * centre-relative offset and Unity's normalised pivot are both derivable from it and are
 * worked out in S9 of the contract rather than pre-computed here.
 */
function pivotBlock(sprite: Sprite): AssetMeta['pivot'] {
  const parts = sprite.rig?.parts ?? [];
  if (parts.length === 1) return { x: parts[0].pivot.x, y: parts[0].pivot.y, source: 'rig-part' };
  return { x: sprite.width / 2, y: sprite.height / 2, source: 'default' };
}

function paletteBlock(sprite: Sprite): NonNullable<AssetMeta['palette']> {
  const roles = sprite.palette.roles;
  const sorted: Record<string, string> = {};
  if (roles) {
    // Sorted by numeric index rather than lexicographically, so index 10 follows index 9
    // instead of preceding it and a re-export does not reshuffle the object.
    for (const key of Object.keys(roles).sort((a, b) => Number(a) - Number(b))) {
      sorted[key] = roles[key];
    }
  }
  return {
    name: sprite.palette.name,
    locked: sprite.paletteLocked === true,
    colors: sprite.palette.colors.map((color) => colorToHex(color, color.a !== 255)),
    ...(Object.keys(sorted).length > 0 ? { roles: sorted } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Canonical serialisation
 * ------------------------------------------------------------------ */

/**
 * Re-key an object graph into the order the schema declares.
 *
 * Recursive because the order is only pinned where it was declared: an object's own keys
 * follow its `shape`, an array's items follow its element schema, and a free-form map
 * (`palette.roles`, whose keys are user data) keeps whatever order it already has because
 * the builder sorted it on purpose.
 *
 * Unknown keys are emitted last, sorted, rather than dropped. They cannot occur in a
 * validated contract, but the function is also the thing that makes "canonical" mean
 * *total*, and a serialiser that silently drops a key is a serialiser with a second,
 * undocumented way to lose data.
 */
function orderBySchema(schema: z.ZodType, value: unknown): unknown {
  const unwrapped = unwrapSchema(schema);
  if (unwrapped instanceof z.ZodArray) {
    if (!Array.isArray(value)) return value;
    // `.element` is typed on zod's array *interface*; the runtime object is the class
    // instance `instanceof` above already proved it is.
    const element = unwrapped.element as z.ZodType;
    return value.map((item) => orderBySchema(element, item));
  }
  if (unwrapped instanceof z.ZodObject) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(unwrapped.shape)) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        out[key] = orderBySchema(unwrapped.shape[key], source[key]);
      }
    }
    for (const key of Object.keys(source).sort()) {
      if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = source[key];
    }
    return out;
  }
  return value;
}

/** `ZodOptional` / `ZodNullable` unwrapping lives in `schema.ts`, beside the shape it describes. */

/**
 * The contract as bytes: two-space JSON, one trailing newline, keys in schema order.
 *
 * The trailing newline is not style. A contract file without one shows up as a modified file
 * in every diff, in every editor that appends one on save, and in every CI step that
 * checks for a newline at end of file.
 */
export function serializeAssetMeta(meta: AssetMeta): string {
  return `${JSON.stringify(orderBySchema(assetMetaSchema, meta), null, 2)}\n`;
}

/** Convenience: document in, contract bytes out, via {@link buildAssetMeta}. */
export function renderAssetMeta(sprite: Sprite, options: AssetMetaOptions = {}): string {
  return serializeAssetMeta(buildAssetMeta(sprite, options));
}

/**
 * Whether a reference path can travel inside the bundle.
 *
 * Exported because the rule is worth stating once and applying twice: `sheet.image` and
 * every `outputs[].path` are subject to it, and a contract that holds an absolute path from
 * the artist's machine has stopped being portable in the one way that matters.
 */
export function isBundleRelativePath(path: string): boolean {
  if (path.length === 0) return false;
  if (path.includes('\\')) return false;
  if (path.startsWith('/')) return false;
  // A Windows drive letter (`C:`) or any other single-letter scheme, with or without a
  // backslash, which is the case a naive "does it start with /" check misses entirely.
  if (/^[A-Za-z]:/.test(path)) return false;
  return !path.split('/').includes('..');
}