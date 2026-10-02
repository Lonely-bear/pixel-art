import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSpritesheet, scaleAtlas, type Atlas } from '../src/atlas.js';
import {
  assetContentHash,
  assetMetaFieldPaths,
  ASSET_META_DIAGNOSTIC_CODES,
  ASSET_META_FORMAT,
  ASSET_META_SCHEMA_VERSION,
  assetMetaSchema,
  buildAssetMeta,
  expandTagFrames,
  isBundleRelativePath,
  nominalFps,
  renderAssetMeta,
  serializeAssetMeta,
  sha256Hex,
  utf8Bytes,
  validateAssetMeta,
  type AssetMeta,
  type AssetMetaDiagnosticCode,
  type AssetMetaOptions,
  type AssetMetaOutput,
} from '../src/asset/index.js';
import { PixelBuffer } from '../src/buffer.js';
import { createSprite, type Sprite } from '../src/document.js';
import { animationSequence } from '../src/gif.js';
import { deterministicIdFactory, setIdFactory } from '../src/ids.js';

/**
 * The asset contract, asserted where it can actually be wrong.
 *
 * Every test here is written to fail for a *specific* wrong implementation, and the
 * intent comment says which one. A test that passes for both a correct and an incorrect
 * implementation proves nothing, so the two that could not be made discriminating are not
 * here: "serialising twice gives the same bytes" is true of any pure function, and it is
 * covered instead by `builds two documents that differ only in ids to the same bytes`,
 * which fails for any serialiser that leaks an id.
 */

/** An 8×8 four-frame character: two tags, a non-uniform duration, an off-centre pixel. */
function fixture(layers: string[] = ['body']): Sprite {
  const sprite = createSprite({
    width: 8,
    height: 8,
    name: 'hero',
    layers,
    frames: 4,
    frameDurationMs: 100,
  });
  const layerId = sprite.layers[0].id;
  sprite.frames.forEach((frame, index) => {
    const cel = new PixelBuffer(8, 8);
    cel.setColor(index, 0, { r: 255, g: 0, b: 0, a: 255 });
    cel.setColor(index + 1, 1, { r: 0, g: 255, b: 0, a: 128 });
    frame.cels.set(layerId, cel);
  });
  sprite.frames[2].durationMs = 200;
  sprite.tags.push({ id: 'tag_idle', name: 'idle', from: 0, to: 3, direction: 'forward', repeat: 0 });
  sprite.tags.push({ id: 'tag_hit', name: 'hit', from: 1, to: 2, direction: 'pingpong', repeat: 1 });
  return sprite;
}

/** The same artwork with no tags, so the animation-free paths can be reached. */
function still(): Sprite {
  const sprite = fixture();
  sprite.tags = [];
  return sprite;
}

function sheet(sprite: Sprite, image = 'hero.png', atlas?: Atlas): AssetMetaOptions {
  return { sheet: { atlas: atlas ?? buildSpritesheet(sprite), image } };
}

function meta(sprite: Sprite, options: AssetMetaOptions = {}): AssetMeta {
  return buildAssetMeta(sprite, options);
}

/**
 * Read one generated contract, mutate it, and validate the result.
 *
 * The base document and its options are both parameters because the mutation tests need a
 * contract that *has* the block they are about to break - a test that mutates `d.sheet` on a
 * document with no sheet is testing `undefined`, not the validator.
 */
function corrupt(
  mutate: (draft: Record<string, any>) => void,
  options: AssetMetaOptions = {},
): ReturnType<typeof validateAssetMeta> {
  const parsed = JSON.parse(renderAssetMeta(fixture(), options)) as Record<string, any>;
  mutate(parsed);
  return validateAssetMeta(parsed);
}

function codes(result: ReturnType<typeof validateAssetMeta>): AssetMetaDiagnosticCode[] {
  return [...new Set(result.diagnostics.map((d) => d.code))].sort();
}

/** Every optional block present at once, for the key-order and self-validation checks. */
const EVERYTHING: AssetMetaOptions = {
  sheet: { atlas: buildSpritesheet(fixture()), image: 'hero.png' },
  license: { spdx: 'CC0-1.0' },
  outputs: [{ role: 'source', path: 'hero.pixel' }],
};

/* ================================================================== *
 * The digest: the implementation itself
 * ================================================================== */

describe('sha256', () => {
  // The published FIPS 180-4 vectors. A hand-written SHA-256 has four ways to be subtly
  // wrong — a shifted constant, a rotate in the wrong direction, big-endian words, a
  // padding length — and every one of them produces a plausible-looking 64 hex characters.
  // These two assertions are the only thing standing between this repository and a digest
  // that is wrong in a way no other test in this file could see.
  it('matches the published NIST vectors', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(utf8Bytes('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  // The multi-block path. A 56-byte input is the boundary where SHA-256 needs a second
  // padding block, and an implementation that assumes one block silently mis-pads exactly
  // there — which is where a frame's worth of pixels can land.
  it('pads correctly across the 56-byte block boundary', () => {
    expect(sha256Hex(utf8Bytes('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(sha256Hex(new Uint8Array(55).fill(0x61))).not.toBe(sha256Hex(new Uint8Array(56).fill(0x61)));
  });

  it('encodes UTF-8 the way another language would', () => {
    expect([...utf8Bytes('a€😀')]).toEqual([0x61, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80]);
    // An unpaired surrogate becomes U+FFFD, matching mainstream encoders. Without a stated
    // rule, a name typed with a broken surrogate hashes differently in JS than in Rust.
    expect([...utf8Bytes('\ud800')]).toEqual([0xef, 0xbf, 0xbd]);
  });
});

/* ================================================================== *
 * Identity: what the digest covers, and what it must not
 * ================================================================== */

describe('asset identity', () => {
  it('survives re-export: two documents with different ids produce the same bytes', () => {
    // The document model's ids are clock + entropy. If any of them reached the contract,
    // two people drawing the same sprite on two machines would produce two different
    // `meta.json` files for the same artwork, and every importer cache in every engine
    // would miss on first contact.
    const build = (seed: number): string => {
      setIdFactory(deterministicIdFactory(seed));
      try {
        return renderAssetMeta(fixture());
      } finally {
        setIdFactory(null);
      }
    };
    const a = build(1);
    const b = build(999);
    expect(a).not.toBe('');
    expect(a).toBe(b);
  });

  it('does not change when a layer that contributes nothing is added', () => {
    // "Two documents never serialise to the same bytes unless they genuinely are the same
    // asset" runs both ways: an extra empty layer is a different document and the same
    // asset, so the bytes must match. This fails for a serialiser that emits layer
    // structure, and it is the assertion §4.2 of the contract rests on.
    const thin = renderAssetMeta(fixture(['body']));
    const thick = renderAssetMeta(fixture(['body', 'shadow']));
    expect(thick).toBe(thin);
  });

  it('changes when one pixel in one frame changes', () => {
    const before = meta(fixture()).asset.contentHash;
    const sprite = fixture();
    sprite.frames[1].cels.get(sprite.layers[0].id)!.setColor(7, 7, { r: 1, g: 2, b: 3, a: 255 });
    expect(meta(sprite).asset.contentHash).not.toBe(before);
  });

  it('changes when a duration, a tag or a tag name changes', () => {
    const base = meta(fixture());
    const duration = fixture();
    duration.frames[3].durationMs = 201;
    const added = fixture();
    added.tags.push({ id: 't', name: 'guard', from: 0, to: 1, direction: 'forward', repeat: 0 });
    const renamed = fixture();
    renamed.tags[0].name = 'idle-loop';

    expect(meta(duration).asset.contentHash).not.toBe(base.asset.contentHash);
    expect(meta(added).asset.contentHash).not.toBe(base.asset.contentHash);
    // A tag name is inside the digest because it is what game code calls, so renaming an
    // animation is a code-visible change and must not be a silent one.
    expect(meta(renamed).asset.contentHash).not.toBe(base.asset.contentHash);
  });

  it('ignores the name, which is a lookup key rather than an identity', () => {
    // The other half of the identity question. Renaming an asset must not invalidate every
    // cache entry that points at it, so the name changes the bytes and not the digest.
    const sprite = fixture();
    const before = meta(sprite);
    sprite.name = 'hero-renamed';
    const after = meta(sprite);
    expect(after.asset.contentHash).toBe(before.asset.contentHash);
    expect(serializeAssetMeta(after)).not.toBe(serializeAssetMeta(before));
  });

  it('length-prefixes strings, so ["ab","c"] cannot hash like ["a","bc"]', () => {
    // Two documents whose tag names concatenate identically, with the same tag count and
    // the same geometry in both. Without length prefixes the preimages are byte-identical
    // and the digest silently stops being a function of the asset.
    const ab = still();
    ab.tags.push({ id: 'a', name: 'ab', from: 0, to: 0, direction: 'forward', repeat: 1 });
    ab.tags.push({ id: 'b', name: 'c', from: 1, to: 1, direction: 'forward', repeat: 1 });

    const a = still();
    a.tags.push({ id: 'a', name: 'a', from: 0, to: 0, direction: 'forward', repeat: 1 });
    a.tags.push({ id: 'b', name: 'bc', from: 1, to: 1, direction: 'forward', repeat: 1 });

    expect(assetContentHash(ab)).not.toBe(assetContentHash(a));
  });

  it('refuses composites that do not match the document', () => {
    // A caller handing back the wrong number of frames would otherwise produce a digest
    // over a different number of frames: a plausible value that means nothing.
    const sprite = fixture();
    expect(() => meta(sprite, { composites: [] })).toThrow(/one composited frame per document frame/);
    expect(() =>
      meta(sprite, { composites: [new PixelBuffer(4, 4), new PixelBuffer(4, 4), new PixelBuffer(4, 4), new PixelBuffer(4, 4)] }),
    ).toThrow(/canvas is 8x8/);
  });

  it('refuses a document it cannot describe rather than describing it wrongly', () => {
    const tiles = fixture();
    tiles.tileset = {
      id: 'ts',
      name: 'tiles',
      tileWidth: 8,
      tileHeight: 8,
      columns: 1,
      image: new PixelBuffer(8, 8),
    };
    expect(() => meta(tiles)).toThrow(/models sprite assets only/);
    const map = fixture();
    map.tilemaps = [];
    expect(() => meta(map)).not.toThrow();
    map.tilemaps.push({
      id: 'm',
      name: 'level',
      width: 1,
      height: 1,
      tileWidth: 8,
      tileHeight: 8,
      data: new Int32Array([0]),
    });
    expect(() => meta(map)).toThrow(/models sprite assets only/);
  });

  it('refuses a fractional duration instead of rounding the artwork\'s timing', () => {
    const sprite = fixture();
    sprite.frames[0].durationMs = 33.33;
    expect(() => meta(sprite)).toThrow(/whole milliseconds/);
  });

  it('refuses an empty timeline', () => {
    const sprite = fixture();
    sprite.frames = [];
    expect(() => meta(sprite)).toThrow(/no frames/);
  });
});

/* ================================================================== *
 * Field order and byte-level determinism
 * ================================================================== */

describe('field order', () => {
  // Field order is part of the contract, and the serialiser takes it from the zod shape
  // rather than from the builder's insertion order — so these literals are what pins the
  // schema's declaration order to the bytes on disk.
  const TOP_LEVEL = [
    'format',
    'schemaVersion',
    'kind',
    'asset',
    'frames',
    'animations',
    'sheet',
    'pivot',
    'palette',
    'license',
    'outputs',
  ];

  it('writes the top-level keys in the pinned order', () => {
    const parsed = JSON.parse(renderAssetMeta(fixture(), EVERYTHING));
    expect(Object.keys(parsed)).toEqual(TOP_LEVEL);
  });

  it('re-orders keys that were built out of order, including inside arrays', () => {
    // The serialiser walks the schema rather than trusting the builder's insertion order.
    // The array half of that walk is the half a `typeof schema.unwrap === 'function'`
    // helper silently broke once, because zod's `ZodArray` has an `unwrap()` that returns
    // its *element* schema - the walk would stop at every array and the key order inside
    // array items would come from whatever built them.
    const built = meta(fixture(), EVERYTHING);
    const shuffled = {
      outputs: [{ path: 'hero.pixel', role: 'source' }],
      pivot: built.pivot,
      license: built.license,
      palette: built.palette,
      sheet: built.sheet,
      animations: built.animations,
      frames: built.frames,
      asset: built.asset,
      kind: built.kind,
      schemaVersion: built.schemaVersion,
      format: built.format,
    } as unknown as AssetMeta;
    const text = serializeAssetMeta(shuffled);
    expect(Object.keys(JSON.parse(text))).toEqual(TOP_LEVEL);
    expect(Object.keys(JSON.parse(text).outputs[0])).toEqual(['role', 'path']);
    expect(Object.keys(JSON.parse(text).animations.items[0])).toEqual([
      'name',
      'from',
      'to',
      'direction',
      'repeat',
      'loop',
      'frames',
      'durationMs',
      'fps',
    ]);
    // An unknown key is appended rather than dropped: canonical has to mean total, or the
    // serialiser has a second, undocumented way to lose data.
    const withExtra = { ...built, laterAddition: 1 } as unknown as AssetMeta;
    expect(Object.keys(JSON.parse(serializeAssetMeta(withExtra)))).toEqual([...TOP_LEVEL, 'laterAddition']);
  });

  it('omits every optional block rather than writing an empty one', () => {
    // A present-but-empty `animations` block says the asset has no animations, which is a
    // different and false claim from saying it has none declared.
    const parsed = JSON.parse(renderAssetMeta(still()));
    expect(Object.keys(parsed)).toEqual(TOP_LEVEL.filter((key) => !['animations', 'sheet', 'license', 'outputs'].includes(key)));
  });

  it('writes nested keys in the pinned order', () => {
    const sprite = fixture();
    sprite.palette.roles = { '2': 'skin' };
    const parsed = JSON.parse(renderAssetMeta(sprite, EVERYTHING));
    expect(Object.keys(parsed.frames)).toEqual(['count', 'size', 'durationsMs', 'totalMs', 'fps']);
    expect(Object.keys(parsed.frames.size)).toEqual(['width', 'height']);
    expect(Object.keys(parsed.asset)).toEqual(['name', 'contentHash']);
    expect(Object.keys(parsed.animations)).toEqual(['default', 'items']);
    expect(Object.keys(parsed.animations.items[0])).toEqual([
      'name',
      'from',
      'to',
      'direction',
      'repeat',
      'loop',
      'frames',
      'durationMs',
      'fps',
    ]);
    expect(Object.keys(parsed.sheet)).toEqual(['image', 'columns', 'rows', 'scale', 'size', 'regions']);
    expect(Object.keys(parsed.sheet.regions[0])).toEqual(['index', 'x', 'y', 'width', 'height']);
    expect(Object.keys(parsed.pivot)).toEqual(['x', 'y', 'source']);
    expect(Object.keys(parsed.palette)).toEqual(['name', 'locked', 'colors', 'roles']);
    expect(Object.keys(parsed.license)).toEqual(['spdx']);
    expect(Object.keys(parsed.outputs[0])).toEqual(['role', 'path']);
  });

  it('ends with a newline and two-space indentation', () => {
    const text = renderAssetMeta(still());
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "schemaVersion": 1,');
  });

  it('validates its own output with no errors and no unknown fields', () => {
    // Nothing may be silently dropped on the way to the bytes: a field that is emitted and
    // then refused by the reader is worse than a field that was never written.
    const result = validateAssetMeta(JSON.parse(renderAssetMeta(fixture(), EVERYTHING)));
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.schemaVersion).toBe(ASSET_META_SCHEMA_VERSION);
  });
});

/* ================================================================== *
 * Timing, order and loop
 * ================================================================== */

describe('timing and loop', () => {
  it('agrees with animationSequence on playback order, for every direction', () => {
    // `gif.ts` owns the playback rule and keeps a private copy of it. Two copies of one
    // rule will drift, and a pingpong that emits [0,1,2,2,1,0] hitches visibly at the
    // turnaround. This is what catches either copy changing alone.
    const sprite = still();
    sprite.tags.push({ id: 'f', name: 'forward', from: 0, to: 3, direction: 'forward', repeat: 0 });
    sprite.tags.push({ id: 'r', name: 'reverse', from: 1, to: 3, direction: 'reverse', repeat: 0 });
    sprite.tags.push({ id: 'p', name: 'pingpong', from: 0, to: 3, direction: 'pingpong', repeat: 2 });
    const built = meta(sprite);

    sprite.tags.forEach((tag, index) => {
      const sequence = animationSequence(sprite, tag.id);
      const order = expandTagFrames(tag);
      expect(sequence.frames.length).toBe(order.length * Math.max(1, tag.repeat));
      expect(sequence.frames.slice(0, order.length).map((f) => f.index)).toEqual(order);
      expect(built.animations!.items[index].frames).toEqual(order);
    });
  });

  it('omits both end frames on the return leg of a pingpong', () => {
    const sprite = still();
    sprite.tags.push({ id: 'p', name: 'bounce', from: 0, to: 2, direction: 'pingpong', repeat: 0 });
    expect(meta(sprite).animations!.items[0].frames).toEqual([0, 1, 2, 1]);
  });

  it('states loop as a boolean derived from repeat === 0', () => {
    const sprite = still();
    sprite.tags.push({ id: 'l', name: 'loop', from: 0, to: 1, direction: 'forward', repeat: 0 });
    sprite.tags.push({ id: 'o', name: 'once', from: 0, to: 1, direction: 'forward', repeat: 1 });
    sprite.tags.push({ id: 't', name: 'thrice', from: 0, to: 1, direction: 'forward', repeat: 3 });
    const items = meta(sprite).animations!.items;
    expect(items.map((i) => [i.repeat, i.loop])).toEqual([
      [0, true],
      [1, false],
      [3, false],
    ]);
  });

  it('emits one pass of frames however many passes repeat asks for', () => {
    // `repeat` is a pass count. Emitting the frames repeated would make every engine that
    // also honours `repeat` play the animation n-squared times.
    const sprite = still();
    sprite.tags.push({ id: 't', name: 'thrice', from: 0, to: 1, direction: 'forward', repeat: 3 });
    const animation = meta(sprite).animations!.items[0];
    expect(animation.frames).toEqual([0, 1]);
    expect(animation.durationMs).toBe(200);
  });

  it('times a whole timeline by the documented mean formula', () => {
    const built = meta(fixture());
    expect(built.frames.durationsMs).toEqual([100, 100, 200, 100]);
    expect(built.frames.totalMs).toBe(500);
    expect(built.frames.fps).toBe(8);
    // 1000 * count / total, not count / total: the formula is stated in the spec and the
    // validator recomputes it from this one function, so a change here moves every file.
    expect(nominalFps([100, 100, 200])).toBe(7.5);
    expect(nominalFps([120, 120, 120])).toBe(8.333);
    expect(nominalFps([])).toBe(0);
  });

  it('has no animations block for a still, rather than an empty one', () => {
    const built = meta(still());
    expect(built.animations).toBeUndefined();
    expect('animations' in built).toBe(false);
  });
});

/* ================================================================== *
 * Required versus derived, and the sheet's own geometry
 * ================================================================== */

describe('required versus derived', () => {
  it('accepts a hand-written file carrying only the required fields', () => {
    // If anything derivable were required, a person writing a `meta.json` by hand — or an
    // importer writing one for a placeholder — would have to restate what the PNG already
    // knows, and the contract would drift the first time someone got it wrong.
    const full = JSON.parse(renderAssetMeta(fixture(), EVERYTHING));
    const minimal = {
      format: full.format,
      schemaVersion: full.schemaVersion,
      kind: full.kind,
      asset: full.asset,
      frames: {
        count: full.frames.count,
        size: full.frames.size,
        durationsMs: full.frames.durationsMs,
        totalMs: full.frames.totalMs,
        fps: full.frames.fps,
      },
      pivot: full.pivot,
    };
    expect(validateAssetMeta(minimal).diagnostics).toEqual([]);
  });

  it('refuses a hand-edited derived field instead of trusting it', () => {
    expect(codes(corrupt((d) => { d.frames.totalMs = 999; }))).toEqual(['frame-total-mismatch']);
    expect(codes(corrupt((d) => { d.frames.fps = 60; }))).toEqual(['fps-mismatch']);
    expect(codes(corrupt((d) => { d.frames.durationsMs.pop(); }))).toContain('frame-count-mismatch');
    expect(codes(corrupt((d) => { d.animations.items[0].durationMs = 7; }))).toEqual(['animation-duration-mismatch']);
  });

  it('reports a sheet cell that no longer matches the layout', () => {
    // `sheet.regions` is the answer and `columns`/`rows` is the order it has to be in, and
    // the point of emitting both is that the file can be checked against itself. The check
    // is row-major rather than `x === column * cellW` on purpose: the packer may have left
    // a gap or a border, and a validator that rejects a legitimately padded sheet is worse
    // than no validator at all.
    const options: AssetMetaOptions = { sheet: { atlas: buildSpritesheet(fixture()), image: 'hero.png' } };
    expect(codes(corrupt((d) => { d.sheet.regions[1].x = 0; }, options))).toContain('sheet-region-mismatch');
    expect(codes(corrupt((d) => { d.sheet.regions[1].x = 200; }, options))).toContain('sheet-region-mismatch');
    expect(codes(corrupt((d) => { d.sheet.regions[1].width = 4; }, options))).toEqual(['sheet-region-size-mismatch']);
    expect(codes(corrupt((d) => { d.sheet.size.width = 4; }, options))).toContain('sheet-size-mismatch');
    expect(codes(corrupt((d) => { d.sheet.regions.pop(); }, options))).toContain('sheet-region-count-mismatch');
    expect(codes(corrupt((d) => { d.sheet.regions[1].index = 9; }, options))).toContain('sheet-region-count-mismatch');
  });

  it('describes a grid sheet with padding and margin exactly', () => {
    const sprite = fixture();
    const atlas = buildSpritesheet(sprite, { layout: 'grid', columns: 2, padding: 1, margin: 2 });
    const built = meta(sprite, { sheet: { atlas, image: 'hero.png' } });
    expect(built.sheet).toMatchObject({
      columns: 2,
      rows: 2,
      scale: 1,
      size: { width: 21, height: 21 },
      regions: [
        { index: 0, x: 2, y: 2, width: 8, height: 8 },
        { index: 1, x: 11, y: 2, width: 8, height: 8 },
        { index: 2, x: 2, y: 11, width: 8, height: 8 },
        { index: 3, x: 11, y: 11, width: 8, height: 8 },
      ],
    });
    // A padded and margined sheet is exactly the case a naive `x === column * cellW` check
    // gets wrong, so it has to pass.
    expect(validateAssetMeta(built).ok).toBe(true);
  });

  it('describes an upscaled sheet as scaled, and validates it', () => {
    const sprite = fixture();
    const atlas = scaleAtlas(buildSpritesheet(sprite), 2);
    const built = meta(sprite, { sheet: { atlas, image: 'hero@2x.png' } });
    expect(built.sheet.scale).toBe(2);
    expect(built.sheet.size).toEqual({ width: 64, height: 16 });
    expect(built.sheet.regions[2]).toEqual({ index: 2, x: 32, y: 0, width: 16, height: 16 });
    // The frame size stays the artwork's size; only the sheet is scaled. Conflating them
    // is how an importer ends up drawing a 2x sprite into a 32px cell.
    expect(built.frames.size).toEqual({ width: 8, height: 8 });
    expect(validateAssetMeta(built).ok).toBe(true);
  });

  it('refuses a sheet whose cells are not one whole-number upscale', () => {
    const sprite = fixture();
    const atlas = buildSpritesheet(sprite);
    atlas.frames[0] = { ...atlas.frames[0], w: 7 };
    expect(() => meta(sprite, { sheet: { atlas, image: 'hero.png' } })).toThrow(/whole-number upscale/);
    const short = buildSpritesheet(sprite);
    short.frames.pop();
    expect(() => meta(sprite, { sheet: { atlas: short, image: 'hero.png' } })).toThrow(/cells but the document has/);
  });
});

/* ================================================================== *
 * Pivot, palette, licence, outputs
 * ================================================================== */

describe('pivot', () => {
  it('falls back to the canvas centre and says so', () => {
    expect(meta(still()).pivot).toEqual({ x: 4, y: 4, source: 'default' });
    const odd = createSprite({ width: 7, height: 9, name: 'odd' });
    // A half-integer centre is the normal case for an odd canvas, and rounding it is how a
    // pivot ends up half a pixel from where the contract said it was.
    expect(meta(odd).pivot).toEqual({ x: 3.5, y: 4.5, source: 'default' });
  });

  it('takes the pivot from a rig that has exactly one part', () => {
    const sprite = fixture();
    sprite.rig = {
      restFrameId: sprite.frames[0].id,
      parts: [{ id: 'p', name: 'body', layerIds: [sprite.layers[0].id], pivot: { x: 8, y: 8 } }],
      poses: [],
      tweens: [],
      anchors: [],
      hitboxes: [],
    };
    expect(meta(sprite).pivot).toEqual({ x: 8, y: 8, source: 'rig-part' });
  });

  it('falls back again once the rig is a skeleton', () => {
    // Two parts means the rig has a hierarchy, and the sprite's own origin is undecided
    // again. Guessing "the first part" would be inventing a decision.
    const sprite = fixture();
    sprite.rig = {
      restFrameId: sprite.frames[0].id,
      parts: [
        { id: 'a', name: 'body', layerIds: [sprite.layers[0].id], pivot: { x: 8, y: 8 } },
        { id: 'b', name: 'arm', layerIds: [], pivot: { x: 6, y: 4 }, parentId: 'a' },
      ],
      poses: [],
      tweens: [],
      anchors: [],
      hitboxes: [],
    };
    expect(meta(sprite).pivot.source).toBe('default');
  });

  it('refuses a fallback pivot that is not the centre, and one off the canvas', () => {
    expect(codes(corrupt((d) => { d.pivot.x = 1; }))).toContain('pivot-not-at-default');
    const chosen = corrupt((d) => { d.pivot.source = 'rig-part'; d.pivot.x = 1; d.pivot.y = 1; });
    expect(codes(chosen)).not.toContain('pivot-not-at-default');
    expect(codes(chosen)).toEqual([]);
    expect(codes(corrupt((d) => { d.pivot.source = 'rig-part'; d.pivot.x = 9; d.pivot.y = 9; }))).toContain(
      'pivot-out-of-bounds',
    );
    // The edge is legal: a sprite pivoting on its bottom row is a normal feet pivot.
    expect(codes(corrupt((d) => { d.pivot.source = 'rig-part'; d.pivot.x = 8; d.pivot.y = 8; }))).toEqual([]);
  });
});

describe('palette', () => {
  it('keeps index order and marks a translucent swatch', () => {
    const sprite = fixture();
    // Index order is the contract: the artwork addresses swatches by index, so a sorted
    // palette would be a different asset even though it lists the same colours.
    sprite.palette.colors[0] = { r: 255, g: 0, b: 0, a: 255 };
    sprite.palette.colors[1] = { r: 0, g: 255, b: 0, a: 128 };
    const built = meta(sprite);
    expect(built.palette.colors[0]).toBe('#ff0000');
    expect(built.palette.colors[1]).toBe('#00ff0080');
    expect(built.palette.locked).toBe(false);
    expect(built.palette.roles).toBeUndefined();
    expect(built.palette.name).toBe('DawnBringer 16');
  });

  it('sorts roles numerically, so index 10 does not precede index 9', () => {
    const sprite = fixture();
    sprite.palette.roles = { '10': 'shadow', '2': 'skin', '1': 'hair' };
    const built = meta(sprite);
    expect(Object.keys(built.palette.roles!)).toEqual(['1', '2', '10']);
    expect(renderAssetMeta(sprite)).toContain('"1": "hair"');
  });

  it('refuses a role index that is not in the palette', () => {
    expect(codes(corrupt((d) => { d.palette.roles = { '99': 'sky' }; }))).toContain('palette-index-out-of-range');
    expect(codes(corrupt((d) => { d.palette.roles = { skin: 'skin' }; }))).toContain('palette-role-key-invalid');
    expect(codes(corrupt((d) => { delete d.palette.roles; }))).toEqual([]);
  });
});

describe('licence and outputs', () => {
  it('never invents a licence', () => {
    expect(meta(fixture()).license).toBeUndefined();
    expect(meta(fixture(), { license: { spdx: 'CC0-1.0', attribution: 'artist' } }).license).toEqual({
      spdx: 'CC0-1.0',
      attribution: 'artist',
    });
    expect(codes(corrupt((d) => { d.license = {}; }))).toContain('missing-field');
  });

  it('refuses a path that cannot travel inside the bundle', () => {
    // A contract holding an absolute path has stopped being portable in the one way that
    // matters, and the Windows drive-letter case is the one a naive "starts with /" check
    // misses entirely.
    const outputs: AssetMetaOutput[] = [{ role: 'source', path: '/abs/hero.pixel' }];
    expect(isBundleRelativePath('/abs/hero.png')).toBe(false);
    expect(isBundleRelativePath('C:\\art\\hero.png')).toBe(false);
    expect(isBundleRelativePath('frames/hero 0.png')).toBe(true);
    expect(codes(corrupt((d) => { d.outputs = outputs; }))).toContain('path-absolute');
    expect(codes(corrupt((d) => { d.outputs = [{ role: 'source', path: '../outside.png' }]; }))).toContain(
      'path-escapes-bundle',
    );
    expect(codes(corrupt((d) => { d.outputs = [{ role: 'source', path: 'C:/art/hero.png' }]; }))).toContain(
      'path-absolute',
    );
    expect(
      codes(corrupt((d) => { d.outputs = [{ role: 'source', path: 'a.pixel' }, { role: 'gif', path: 'a.pixel' }]; })),
    ).toContain('path-duplicate');
    expect(corrupt((d) => { d.outputs = [{ role: 'source', path: 'a.pixel' }]; }).ok).toBe(true);
  });

  it('refuses the reserved sheet role, which would duplicate sheet.image', () => {
    const options: AssetMetaOptions = { sheet: { atlas: buildSpritesheet(fixture()), image: 'hero.png' } };
    const result = corrupt((d) => {
      d.outputs = [{ role: 'sheet', path: d.sheet.image }];
    }, options);
    expect(codes(result)).toContain('reserved-output-role');
    expect(codes(corrupt((d) => { d.sheet.image = '/abs/hero.png'; }, options))).toContain('path-absolute');
    expect(codes(corrupt((d) => { d.sheet.image = '../hero.png'; }, options))).toContain('path-escapes-bundle');
  });
});

/* ================================================================== *
 * Reading someone else's file: compatibility and diagnosis
 * ================================================================== */

describe('compatibility policy', () => {
  it('tolerates a field it has never heard of, at the root and nested', () => {
    // A spec that grows must not break every consumer that shipped before it grew, and the
    // only way to guarantee that is to require toleration. This fails for a validator that
    // treats an unknown key as an error — which is the mistake a strict schema invites.
    const result = corrupt((d) => {
      d.quantumEntanglement = { flux: 1 };
      d.frames.predictedMs = 42;
    });
    expect(codes(result)).toEqual(['unknown-field']);
    expect(result.ok).toBe(true);
    expect(result.diagnostics.map((d) => d.path)).toEqual(['frames.predictedMs', 'quantumEntanglement']);
  });

  it('still catches a misspelled required field, as both findings', () => {
    // The sharpest consequence of keeping `.strict()` while calling unknown fields
    // advisory: tolerance for the future must not become tolerance for typos, and the
    // pairing is what guarantees it.
    const result = corrupt((d) => { d.asset.contnetHash = d.asset.contentHash; delete d.asset.contentHash; });
    expect(codes(result).sort()).toEqual(['missing-field', 'unknown-field']);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.find((d) => d.code === 'missing-field')!.path).toBe('asset.contentHash');
  });

  it('reports a newer schemaVersion as advisory and keeps reading the rest', () => {
    const newer = corrupt((d) => {
      d.schemaVersion = 99;
      d.someFutureBlock = true;
    });
    expect(codes(newer).sort()).toEqual(['schema-version-unsupported', 'unknown-field']);
    expect(newer.ok).toBe(true);
    expect(newer.schemaVersion).toBe(99);

    // A version that is not a positive integer is a broken file, not a future one.
    expect(codes(corrupt((d) => { d.schemaVersion = 0; }))).toContain('out-of-range');
    expect(codes(corrupt((d) => { d.schemaVersion = 1.5; }))).toContain('invalid-value');
    expect(codes(corrupt((d) => { delete d.schemaVersion; }))).toContain('missing-field');
  });
});

describe('diagnosis', () => {
  it('refuses a file that is not an object, a bad hash and a bad enum', () => {
    expect(validateAssetMeta('nope').diagnostics).toEqual([
      { code: 'not-json-object', severity: 'error', path: '', message: expect.any(String) },
    ]);
    expect(validateAssetMeta([1, 2]).ok).toBe(false);
    expect(codes(corrupt((d) => { d.asset.contentHash = 'md5:abc'; }))).toContain('content-hash-malformed');
    expect(codes(corrupt((d) => { d.kind = 'tileset'; }))).toContain('invalid-value');
    expect(codes(corrupt((d) => { d.frames.count = '4'; }))).toContain('invalid-type');
    expect(codes(corrupt((d) => { d.frames.count = 4.5; }))).toContain('invalid-value');
    expect(codes(corrupt((d) => { d.format = 'something-else'; }))).toContain('invalid-value');
  });

  it('catches the animation mistakes that break playback in an engine', () => {
    expect(codes(corrupt((d) => { d.animations.items[0].frames = [0, 1, 3, 2]; }))).toContain(
      'animation-order-mismatch',
    );
    expect(codes(corrupt((d) => { d.animations.items[0].frames = [0, 1, 2, 9]; }))).toContain(
      'animation-frame-out-of-bounds',
    );
    // The sentinel rule, stated twice: a file that says `loop` without `repeat` agreeing
    // with it is how a two-shot attack ends up looping forever in the engine.
    const looping = corrupt((d) => {
      d.animations.items[1].repeat = 2;
      d.animations.items[1].loop = true;
    });
    expect(codes(looping)).toContain('animation-loop-mismatch');
    expect(codes(corrupt((d) => { d.animations.items[0].name = 'hit'; }))).toContain(
      'duplicate-animation-name',
    );
    expect(codes(corrupt((d) => { d.animations.default = 'nope'; }))).toContain(
      'unknown-default-animation',
    );
    // A tag naming a frame past the end of the timeline: the document model can be handed
    // one by a hand-built sprite, and a contract must not pass it through.
    const oob = fixture();
    oob.tags[0].to = 9;
    expect(() => meta(oob)).toThrow(/outside the 4-frame timeline/);
  });

  it('sorts findings by path then code, without a locale', () => {
    // The list is part of a byte-identical pipeline. A `localeCompare` sort would make the
    // order depend on the machine's ICU data, which turns a diff into an argument. The two
    // corruptions are kept apart because a shape error makes the whole cross-field pass
    // skip, and mixing them would quietly test nothing.
    const shape = corrupt((d) => {
      d.zeta = 1;
      d.alpha = 1;
      d.frames.totalMs = -1;
    });
    expect(shape.diagnostics.map((d) => `${d.path}|${d.code}`)).toEqual([
      'alpha|unknown-field',
      'frames.totalMs|out-of-range',
      'zeta|unknown-field',
    ]);

    const cross = corrupt((d) => { d.asset.contentHash = 'nope'; d.pivot.x = 1; });
    expect(cross.diagnostics.map((d) => `${d.path}|${d.code}`)).toEqual([
      'asset.contentHash|content-hash-malformed',
      'pivot|pivot-not-at-default',
    ]);
    expect(cross.ok).toBe(false);
  });
});

/* ================================================================== *
 * The specification and the schema cannot drift
 * ================================================================== */

// `packages/core/test/` -> `packages/core/` -> `packages/` -> repo root.
const SPEC_PATH = fileURLToPath(new URL('../../../docs/ASSET-CONTRACT.md', import.meta.url));

function readSpec(): string {
  try {
    return readFileSync(SPEC_PATH, 'utf8');
  } catch (error) {
    throw new Error(
      `Cannot read the asset contract specification at ${SPEC_PATH}. §5 and §8 are the authority ` +
        `for the field table and the diagnostic codes, so this guard fails rather than skipping: a ` +
        `missing spec is a broken checkout, not a reason to pass quietly. Underlying error: ` +
        `${(error as Error).message}`,
    );
  }
}

/**
 * Pull one `| First | Second | ... |` table out of a numbered section.
 *
 * Fails loudly when the table cannot be found, which is the failure mode this guard exists
 * to prevent: a reformatted spec that the parser no longer reads must not be reported as
 * "no drift".
 */
function sectionTable(markdown: string, section: string, header: RegExp): string[] {
  const lines = markdown.split(/\r?\n/);
  const heading = lines.findIndex((line) => new RegExp(`^#{2,4}\\s+${section}\\b`).test(line));
  if (heading < 0) throw new Error(`${SPEC_PATH}: no '## ${section}' heading anywhere in the document.`);
  let at = -1;
  for (let i = heading + 1; i < lines.length; i++) {
    if (header.test(lines[i])) {
      at = i;
      break;
    }
    if (/^#{1,4}\s/.test(lines[i])) break;
  }
  if (at < 0) throw new Error(`${SPEC_PATH}: §${section} has no table header matching ${header}.`);
  const rows: string[] = [];
  for (let i = at + 1; i < lines.length && lines[i].startsWith('|'); i++) {
    if (/^\|\s*---/.test(lines[i])) continue;
    rows.push(lines[i]);
  }
  if (rows.length === 0) throw new Error(`${SPEC_PATH}: §${section}'s table has no rows.`);
  return rows;
}

const tableCell = (row: string, index: number): string =>
  row.split('|').slice(1, -1)[index].trim().replace(/^`|`$/g, '');

describe('the specification is the schema', () => {
  // T-050's specification and its code were written in parallel with nothing binding them
  // together, which is how a document ends up describing a field that does not exist while
  // every test stays green. The spec is therefore *parsed*, not trusted.
  it('documents exactly the fields the schema declares, with the right requiredness', () => {
    const rows = sectionTable(readSpec(), '5\\. Field reference', /^\|\s*Field\s*\|\s*Type\s*\|\s*Required\s*\|/);
    const documented = rows.map((row) => ({
      path: tableCell(row, 0),
      required: tableCell(row, 2) === 'yes',
    }));
    const declared = assetMetaFieldPaths().filter((field) => field.path !== '');
    expect(documented).toEqual(declared);
    expect(documented.length).toBeGreaterThan(40);
  });

  it('documents exactly the diagnostic codes the validator says it can emit', () => {
    // What this proves: a code in the implementation's own list with no row in S8 fails,
    // and a row in S8 with no code fails. What it does *not* prove: that every listed code
    // is reachable — a code could sit in the union and the list with no branch that emits
    // it, and this would stay green. Closing that would need one synthetic file per code,
    // which is what the corruption tests above already do for the twenty they touch; the
    // remaining nine are cross-field checks whose triggering mutation is not obvious from
    // the code alone, and a table-driven fixture for them is worth writing when a second
    // consumer exists rather than now.
    const rows = sectionTable(readSpec(), '8\\. Diagnostic codes', /^\|\s*Code\s*\|\s*Severity\s*\|/);
    const documented = rows.map((row) => tableCell(row, 0));
    const declared = [...ASSET_META_DIAGNOSTIC_CODES];
    expect(documented).toEqual(declared);
    expect(documented.length).toBeGreaterThan(20);
    // The severity column is half the contract too: an advisory that becomes an error
    // breaks forward compatibility, and an error that becomes an advisory lets a typo
    // through, so the column is read back rather than trusted.
    const advisories = rows
      .filter((row) => tableCell(row, 1) === 'advisory')
      .map((row) => tableCell(row, 0));
    // Exactly two, and both are the version-boundary cases S3 talks about. Anything else
    // marked advisory would be a defect hiding behind a lenient word.
    expect(advisories).toEqual(['schema-version-unsupported', 'unknown-field']);
  });

  it('states the format marker and the version the generator writes', () => {
    const spec = readSpec();
    expect(spec).toContain(`\`${ASSET_META_FORMAT}\``);
    expect(spec).toContain(`\`schemaVersion\` is one integer`);
    expect(meta(fixture()).schemaVersion).toBe(ASSET_META_SCHEMA_VERSION);
    expect(assetMetaSchema.safeParse(meta(fixture())).success).toBe(true);
  });
});

/* ================================================================== *
 * The wiring that is deliberately absent
 * ================================================================== */

describe('not wired into the export path yet', () => {
  // The contract is not registered as a command, not re-exported from the package index and
  // not written by `finalize_document`. A later task owns that decision, and it needs to be
  // made once: whether `meta.json` is written next to every export or is one more output the
  // caller opts into. Asserting the absence here means the decision is visible in the
  // diff that makes it, rather than a fact somebody has to remember.
  it('is not in the package entry point yet', () => {
    const index = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
    expect(index).not.toContain("export * from './asset/index.js'");
  });

  it('writes every path it is given as a relative one', () => {
    const built = meta(fixture(), {
      sheet: { atlas: buildSpritesheet(fixture()), image: 'hero.png' },
      outputs: [
        { role: 'source', path: 'hero.pixel' },
        { role: 'frame', path: 'frames/hero 0.png' },
        { role: 'gif', path: 'hero.gif' },
      ],
    });
    expect(validateAssetMeta(built).ok).toBe(true);
    for (const output of built.outputs!) expect(isBundleRelativePath(output.path)).toBe(true);
    expect(isBundleRelativePath(built.sheet!.image)).toBe(true);
  });
});