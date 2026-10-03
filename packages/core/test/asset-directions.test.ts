import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildSpritesheet,
  renderDirectionSheet,
  sliceAnimations,
  DIRECTION_LABEL_STRIP,
} from '../src/atlas.js';
import { PixelBuffer } from '../src/buffer.js';
import { createSprite, type Sprite } from '../src/document.js';
import { deterministicIdFactory, setIdFactory } from '../src/ids.js';
import { compositeFrame, compositeWithOnion, drawFacingMarker, normalizeFacing } from '../src/render.js';
import {
  assetFacingSchema,
  ASSET_FACINGS,
  buildAssetMeta,
  importExcalidraw,
  importGodot,
  importPhaser,
  importUnity,
  normalizeFacingLabel,
  renderAssetMeta,
  validateAssetMeta,
  type AssetMeta,
  type AssetMetaOptions,
} from '../src/asset/index.js';
import { toGenericAtlasJson } from '../src/atlas.js';

/**
 * Per-frame direction: from a document, through the atlas, into `meta.json`, and out into
 * engine files an importer actually reads.
 *
 * The round trip is the test that matters and the reason this file exists. Per-frame direction
 * that stops at `meta.json` is metadata for humans only, which is the specific way this
 * feature could have been built to look finished and be useless: an 8-direction character
 * sheet where the game still cannot tell which frame looks south. So every importer is
 * asserted to carry it into its own output, and the two the brief named (Godot, Phaser) are
 * asserted by exact string, not by "contains a direction somewhere".
 */

/* ================================================================== *
 * Fixtures
 * ================================================================== */

/**
 * An 8-direction walk cycle: 8 rows of 2 frames, tagged one row each.
 *
 * Built so every facing appears, the tag order is the facing order, and the artwork itself
 * carries no directional information at all — every frame is the same red square. That is
 * deliberate: if a test could pass by *inferring* the facing from the pixels, it would not be
 * testing that the label travels, and inference is exactly what this implementation refuses
 * to do.
 */
function walkCycle(): Sprite {
  const sprite = createSprite({
    width: 8,
    height: 8,
    name: 'hero-walk',
    layers: ['body'],
    frames: 16,
    frameDurationMs: 100,
  });
  const layerId = sprite.layers[0].id;
  // The one pixel that moves per frame is what makes an onion-skin ghost visible at all. With
  // every frame identical — which is what the direction tests want, so that nothing can be
  // inferred from the artwork — a ghost is a no-op and any assertion about ghosts passes for
  // the wrong reason. So the fixture varies by frame position, never by direction: frame 0
  // looks the same whichever facing it is given.
  sprite.frames.forEach((frame, index) => {
    const cel = new PixelBuffer(8, 8);
    cel.setColor(2, 2, { r: 220, g: 60, b: 60, a: 255 });
    cel.setColor(3, 3, { r: 40, g: 40, b: 60, a: 255 });
    cel.setColor(4 + (index % 4), 6, { r: 240, g: 240, b: 240, a: 255 });
    frame.cels.set(layerId, cel);
  });
  ASSET_FACINGS.forEach((facing, row) => {
    sprite.tags.push({
      id: `tag_${facing}`,
      name: `walk_${facing.toLowerCase()}`,
      from: row * 2,
      to: row * 2 + 1,
      direction: 'forward',
      repeat: 0,
    });
  });
  return sprite;
}

/** The facings for {@link walkCycle}, in timeline order: two frames per direction. */
function walkFacings(): (string | null)[] {
  return ASSET_FACINGS.flatMap((facing) => [facing, facing]);
}

function sheetOf(sprite: Sprite, options?: { facings?: readonly (string | null)[] }): AssetMetaOptions {
  return {
    sheet: {
      atlas: buildSpritesheet(sprite, { layout: 'grid', columns: 4, ...options }),
      image: 'hero-walk.png',
    },
  };
}

function metaOf(sprite: Sprite, options: AssetMetaOptions = {}): AssetMeta {
  return buildAssetMeta(sprite, options);
}

/** The emitted bytes of one file in an importer's result, by role. */
function fileWithRole(result: { files: readonly { path: string; contents: string; role: string }[] }, role: string): string {
  const found = result.files.find((file) => file.role === role);
  if (!found) {
    throw new Error(
      `No file with role "${role}" among ${result.files.map((f) => f.role).join(', ')}.`,
    );
  }
  return found.contents;
}

/** Pixel coordinates of every fully-opaque non-background pixel, for a compact image diff. */
function inked(buffer: PixelBuffer): string[] {
  const out: string[] = [];
  for (let y = 0; y < buffer.height; y++) {
    for (let x = 0; x < buffer.width; x++) {
      if (buffer.getColor(x, y).a > 0) out.push(`${x},${y}`);
    }
  }
  return out;
}

/* ================================================================== *
 * Direction-aware preview
 * ================================================================== */

describe('direction-aware preview', () => {
  it('draws a distinct arrow per facing, so S and N are told apart by eye', () => {
    // The discriminator: two facings produce two different images. A preview that drew the
    // same marker for every cell would satisfy "there is an arrow" and answer nothing.
    const sprite = walkCycle();
    const north = renderDirectionSheet(sprite, { facings: walkFacings().map(() => 'N') });
    const south = renderDirectionSheet(sprite, { facings: walkFacings().map(() => 'S') });
    expect([...north.image.data]).not.toEqual([...south.image.data]);

    // Every one of the eight is distinct from every other, which is the actual claim.
    const seen = new Map<string, string>();
    for (const facing of ASSET_FACINGS) {
      const sheet = renderDirectionSheet(sprite, { facings: walkFacings().map(() => facing) });
      const signature = [...sheet.image.data].join(',');
      expect(seen.has(signature)).toBe(false);
      seen.set(signature, facing);
    }
    expect(seen.size).toBe(ASSET_FACINGS.length);
  });

  it('puts the marker in the cell above the artwork and leaves the artwork alone', () => {
    const sprite = walkCycle();
    const sheet = renderDirectionSheet(sprite, { facings: walkFacings(), columns: 4 });

    // Cells carry the label strip, so a cell is taller than the canvas by exactly that much.
    expect(sheet.cellWidth).toBe(sprite.width);
    expect(sheet.cellHeight).toBe(sprite.height + DIRECTION_LABEL_STRIP);
    expect(sheet.columns).toBe(4);
    expect(sheet.rows).toBe(4);

    // Cell 0 is at the origin; the body pixel of frame 0 sits exactly where the sheet's cell
    // says it does, one strip down. If the marker overwrote artwork this would move.
    const cell = sheet.cells[0];
    expect(cell).toMatchObject({ index: 0, x: 0, y: 0, w: 8, h: 8 + DIRECTION_LABEL_STRIP });
    expect(sheet.image.getColor(2, DIRECTION_LABEL_STRIP + 2)).toEqual({ r: 220, g: 60, b: 60, a: 255 });

    // The strip holds the arrow, and the artwork is NOT in it — the marker is drawn into empty
    // space, which is the whole reason the strip exists. Proven against the SAME sheet with
    // the labels removed, which is the only comparison that can tell "the arrow is up here"
    // from "something was always up here".
    const unlabelled = renderDirectionSheet(sprite, { facings: walkFacings().map(() => null), columns: 4 });
    const strip = (image: PixelBuffer): number =>
      Array.from({ length: 5 * DIRECTION_LABEL_STRIP }, (_v, i) =>
        image.getColor(i % 5, Math.floor(i / 5)).a,
      ).filter((a) => a > 0).length;
    const inkedInStrip = strip(sheet.image);
    expect(inkedInStrip).toBeGreaterThan(5);
    expect(strip(unlabelled.image)).toBe(0);
    // And the strip is empty of anything but the marker: every pixel of the labelled strip is
    // either marker ink or transparent, and the unlabelled one is entirely transparent, so no
    // artwork leaked upward into the annotation area.
    expect(strip(sheet.image)).toBeGreaterThan(strip(unlabelled.image));
  });

  it('reports each cell its facing and its animations', () => {
    const sheet = renderDirectionSheet(walkCycle(), { facings: walkFacings(), columns: 4 });
    expect(sheet.cells.map((cell) => cell.facing)).toEqual(walkFacings());
    // Two frames per direction, in ASSET_FACINGS order, so row 3 is SE and row 6 is W. That
    // is the "which way is frame 12 looking" question the whole block exists to answer,
    // answered without counting.
    expect(sheet.cells[6]).toMatchObject({ index: 6, facing: 'SE', animations: ['walk_se'] });
    expect(sheet.cells[12]).toMatchObject({ index: 12, facing: 'W', animations: ['walk_w'] });
    expect(sheet.cells[0]).toMatchObject({ index: 0, facing: 'N', animations: ['walk_n'] });
    expect(sheet.cells[15]).toMatchObject({ index: 15, facing: 'NW', animations: ['walk_nw'] });
  });

  it('draws no marker for a frame with no facing, and keeps the frame', () => {
    const sprite = walkCycle();
    const unlabelled = renderDirectionSheet(sprite, { facings: walkFacings().map(() => null), columns: 4 });
    expect(unlabelled.cells.every((cell) => cell.facing === null)).toBe(true);
    // The strip is empty rather than showing a placeholder, so "nobody labelled this" does not
    // look like "faces somewhere".
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < DIRECTION_LABEL_STRIP; y++) {
        expect(unlabelled.image.getColor(x, y).a).toBe(0);
      }
    }
    // And the artwork survives: the sheet is not blank.
    expect(inked(unlabelled.image).length).toBeGreaterThan(100);

    // An unrecognised label is treated as no label, not as a guess and not as a throw: a
    // preview of a half-authored document should still render.
    const bogus = renderDirectionSheet(sprite, { facings: walkFacings().map(() => 'sideways'), columns: 4 });
    expect(bogus.cells.every((cell) => cell.facing === null)).toBe(true);
  });

  it('keeps cells in timeline order, which is what makes the sheet catch a mislabelled row', () => {
    // Reordering cells by facing would look tidier and would hide the defect the sheet exists
    // to find (a north frame sitting in the middle of the south walk). This pins the order.
    const sheet = renderDirectionSheet(walkCycle(), { facings: walkFacings(), columns: 4 });
    expect(sheet.cells.map((cell) => cell.index)).toEqual([...Array(16).keys()]);
  });

  it('is reachable from the existing composite path through one option', () => {
    // The brief asked for this as an option on the render/atlas path rather than a new
    // command, so the assertion is that the ordinary composite takes it.
    const sprite = walkCycle();
    const plain = compositeFrame(sprite, sprite.frames[0].id);
    const marked = compositeFrame(sprite, sprite.frames[0].id, { facing: 'NE' });
    expect([...marked.data]).not.toEqual([...plain.data]);
    // And that omitting it is byte-identical to before, which is what keeps every other
    // caller of compositeFrame unaffected.
    expect(compositeFrame(sprite, sprite.frames[0].id, { facing: null })).toEqual(plain);
  });

  it('is honoured by the onion-skin path too, which inherits the option', () => {
    // `OnionSkinOptions` extends `CompositeOptions`, so an option that is inherited and then
    // ignored is a caller who asked for a marker and silently got none. Both branches are
    // covered because they are two separate return paths in `compositeWithOnion`.
    const sprite = walkCycle();
    // Frame 8, not frame 0: "before" ghosts are frames before the current one, so on frame 0
    // there are none and the ghosted branch is never entered. An assertion on frame 0 would
    // pass for the wrong reason — which is exactly how the first version of this test did.
    const frameId = sprite.frames[8].id;

    // The no-ghost shortcut really is `compositeFrame`.
    expect(compositeWithOnion(sprite, frameId, { facing: 'SE' })).toEqual(
      compositeFrame(sprite, frameId, { facing: 'SE' }),
    );

    // The ghosted branch: the marker must appear, and the ghosts must be there too. Asserting
    // the ghosts exist is what makes the marker assertion discriminating — if ghosts were
    // invisible the two buffers would differ only by the marker, which would still pass but
    // would not be testing the branch this claims to.
    const ghosted = compositeWithOnion(sprite, frameId, { before: 2, facing: 'SE' });
    const unghosted = compositeWithOnion(sprite, frameId, { before: 2 });
    expect([...ghosted.data]).not.toEqual([...unghosted.data]);
    // Ghosts are present, so this path is the one with the extra return.
    expect([...unghosted.data]).not.toEqual([...compositeFrame(sprite, frameId).data]);
  });

  it('carries the facing on the atlas frame without drawing it onto the sheet', () => {
    const sprite = walkCycle();
    const atlas = buildSpritesheet(sprite, { layout: 'grid', columns: 4, facings: walkFacings() });
    expect(atlas.frames[6].facing).toBe('SE');
    expect(atlas.frames[0].animations).toEqual(['walk_n']);
    // The packed pixels are the artwork and nothing else. An atlas with a 5x5 arrow baked
    // into the character's top-left corner is not a sprite sheet, it is a corrupted one.
    const bare = buildSpritesheet(sprite, { layout: 'grid', columns: 4 });
    expect([...atlas.image.data]).toEqual([...bare.image.data]);
    // Absent rather than `'none'` when the option was not passed at all.
    expect(bare.frames[0].facing).toBeUndefined();
    expect(JSON.stringify(toGenericAtlasJson(sprite, bare))).not.toContain('facing');
  });

  it('normalises labels the way the contract does', () => {
    for (const [input, expected] of [
      ['s', 'S'],
      ['South', 'S'],
      ['south-west', 'SW'],
      ['southWest', 'SW'],
      [' NW ', 'NW'],
      ['none', 'none'],
    ] as const) {
      expect(normalizeFacing(input)).toBe(expected);
      expect(normalizeFacingLabel(input)).toBe(expected);
    }
    // Both reject the same things, and both reject rather than guess.
    for (const input of ['sideways', '', 'up', 'north northeast']) {
      expect(normalizeFacing(input)).toBeNull();
      expect(normalizeFacingLabel(input)).toBeNull();
    }
    // And they agree on the canonical set, which is the thing that has to hold: a preview
    // that drew a different arrow than the contract recorded would be its own bug.
    for (const facing of ASSET_FACINGS) {
      expect(normalizeFacing(facing)).toBe(facing);
      expect(normalizeFacingLabel(facing)).toBe(facing);
      expect(assetFacingSchema.safeParse(normalizeFacing(facing)).success).toBe(true);
    }
  });

  it('clips a marker that does not fit rather than throwing', () => {
    const tiny = new PixelBuffer(3, 3);
    expect(() => drawFacingMarker(tiny, 'N', 0, 0)).not.toThrow();
    expect(() => drawFacingMarker(tiny, 'N', 100, 100)).not.toThrow();
    expect(() => drawFacingMarker(tiny, null, 0, 0)).not.toThrow();
    // Fully outside is a no-op, so an off-canvas annotation cannot corrupt a buffer.
    const buffer = new PixelBuffer(8, 8);
    const before = [...buffer.data];
    drawFacingMarker(buffer, 'N', 100, 100);
    expect([...buffer.data]).toEqual(before);
  });

  it('reports a sheet whose frame count disagrees with the facings without throwing', () => {
    // Fewer labels than frames is a caller mistake, and a preview that throws on a partial
    // list cannot be used to look at a half-authored direction row.
    const sheet = renderDirectionSheet(walkCycle(), { facings: ['N', 'S'], columns: 4 });
    expect(sheet.cells).toHaveLength(16);
    expect(sheet.cells[0].facing).toBe('N');
    expect(sheet.cells[1].facing).toBe('S');
    expect(sheet.cells[2].facing).toBeNull();
  });

  it('carries facings through the animation slices too', () => {
    // `sliceAnimations` already produces per-animation frame lists; the atlas frame's own
    // `facing` and `animations` fields are what a caller needs to read them off.
    const sprite = walkCycle();
    const atlas = buildSpritesheet(sprite, { layout: 'grid', columns: 4, facings: walkFacings() });
    const slices = sliceAnimations(sprite, atlas);
    const sw = slices.find((slice) => slice.name === 'walk_w');
    expect(sw!.frames.map((frame) => atlas.frames[frame.index].facing)).toEqual(['W', 'W']);
    expect(atlas.frames[6].animations).toEqual(['walk_se']);
  });
});

/* ================================================================== *
 * The contract: per-frame direction in meta.json
 * ================================================================== */

describe('meta.json carries per-frame direction', () => {
  it('writes one entry per frame, in timeline order, with its facing and its animations', () => {
    const sprite = walkCycle();
    const built = metaOf(sprite, { directions: walkFacings() });
    expect(built.frames.directions).toHaveLength(16);
    expect(built.frames.directions![0]).toEqual({ index: 0, facing: 'N', animations: ['walk_n'] });
    expect(built.frames.directions![6]).toEqual({ index: 6, facing: 'SE', animations: ['walk_se'] });
    expect(built.frames.directions!.map((entry) => entry.index)).toEqual([...Array(16).keys()]);
    expect(validateAssetMeta(built).ok).toBe(true);
    expect(validateAssetMeta(JSON.parse(renderAssetMeta(sprite, { directions: walkFacings() }))).ok).toBe(true);
  });

  it('canonicalises what the caller wrote', () => {
    const sprite = walkCycle();
    const built = metaOf(sprite, { directions: walkFacings().map((f) => f!.toLowerCase()) });
    expect(built.frames.directions!.map((entry) => entry.facing)).toEqual(walkFacings());
  });

  it('says `none` for a frame with no label rather than leaving a hole', () => {
    // A `null` in the middle of the list must not shift every later entry: an importer
    // indexing by position is exactly what the one-entry-per-frame rule buys.
    const facings = walkFacings();
    facings[7] = null;
    const built = metaOf(walkCycle(), { directions: facings });
    const rows = built.frames.directions!;
    expect(rows).toHaveLength(16);
    expect(rows[7]).toEqual({ index: 7, facing: 'none', animations: ['walk_se'] });
    expect(rows[8]).toEqual({ index: 8, facing: 'S', animations: ['walk_s'] });
  });

  it('omits the block entirely when the caller gave no directions', () => {
    // The backward-compatibility guarantee in one assertion: a document with no direction
    // model produces the file this repository produced before the field existed.
    const sprite = walkCycle();
    const built = metaOf(sprite, sheetOf(sprite));
    expect(built.frames.directions).toBeUndefined();
    expect('directions' in built.frames).toBe(false);
    expect(renderAssetMeta(sprite)).not.toContain('directions');
    expect(renderAssetMeta(sprite)).not.toContain('facing');
  });

  it('refuses a list whose length is not the frame count', () => {
    const sprite = walkCycle();
    expect(() => metaOf(sprite, { directions: ['N', 'S'] })).toThrow(/one entry per frame/);
    expect(() => metaOf(sprite, { directions: [...walkFacings(), 'N'] })).toThrow(/one entry per frame/);
  });

  it('refuses an unrecognised label instead of dropping the facing', () => {
    // The near-miss on the other side of the same gate: a real label is accepted, a bogus
    // one is a hard error. Silently skipping it would be a character facing the wrong way
    // with nothing in the file to say so.
    const sprite = walkCycle();
    expect(() => metaOf(sprite, { directions: walkFacings().map(() => 'sideways') })).toThrow(
      /not one of N, NE, E, SE, S, SW, W, NW or none/,
    );
    const typo = walkFacings();
    typo[3] = 'sotuh';
    expect(() => metaOf(sprite, { directions: typo })).toThrow(/sotuh/);
    // And the neighbour that must NOT throw: the eight real ones plus `none`.
    const ok = walkFacings();
    ok[3] = 'none';
    expect(() => metaOf(sprite, { directions: ok })).not.toThrow();
  });

  it('lists the animations that show a frame, including a repeated pingpong frame once', () => {
    const sprite = createSprite({ width: 4, height: 4, name: 's', frames: 3, frameDurationMs: 100 });
    sprite.tags.push({ id: 'p', name: 'bounce', from: 0, to: 2, direction: 'pingpong', repeat: 0 });
    const built = metaOf(sprite, { directions: ['N', 'E', 'S'] });
    // A pingpong over 0..2 plays [0, 1, 2, 1]; frame 1 appears twice in playback and is listed
    // once, so the two blocks cannot disagree about which frames an animation shows.
    expect(built.frames.directions!.map((entry) => entry.animations)).toEqual([
      ['bounce'],
      ['bounce'],
      ['bounce'],
    ]);
    expect(built.animations!.items[0].frames).toEqual([0, 1, 2, 1]);
  });

  it('omits `animations` for a frame no tag shows', () => {
    const sprite = createSprite({ width: 4, height: 4, name: 's', frames: 3, frameDurationMs: 100 });
    sprite.tags.push({ id: 'a', name: 'walk', from: 0, to: 0, direction: 'forward', repeat: 0 });
    const built = metaOf(sprite, { directions: ['N', 'E', 'S'] });
    expect(built.frames.directions![0]).toEqual({ index: 0, facing: 'N', animations: ['walk'] });
    expect(built.frames.directions![1]).toEqual({ index: 1, facing: 'E' });
    expect(validateAssetMeta(built).ok).toBe(true);
  });

  it('does not move the content hash, because a direction is a declaration not the asset', () => {
    // S4.2's table: `pivot`, `palette.locked` and `license` are declarations about the asset
    // and are outside the digest. A facing is the same kind of thing — the same pixels with a
    // label — and putting it inside the digest would invalidate every importer cache in every
    // project for a change that no engine would notice. This asserts it rather than trusting it.
    const sprite = walkCycle();
    const before = metaOf(sprite).asset.contentHash;
    const after = metaOf(sprite, { directions: walkFacings() }).asset.contentHash;
    expect(after).toBe(before);
    expect(after).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('keeps an existing contract valid: no directions, and a hand-written one', () => {
    // Two directions of "an older file". The generated no-directions contract, and a literal
    // written out by hand with only the fields S7 says are required. Both must validate with
    // zero findings, which is what S3's additive rule promises.
    const sprite = walkCycle();
    expect(validateAssetMeta(metaOf(sprite, sheetOf(sprite))).diagnostics).toEqual([]);

    const full = JSON.parse(renderAssetMeta(sprite, { directions: walkFacings() })) as AssetMeta;
    const handWritten = {
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
      animations: full.animations,
      pivot: full.pivot,
    };
    const result = validateAssetMeta(handWritten);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);

    // And a reader that has never heard of the block reports nothing about it. That is the
    // `unknown-field` advisory S3 mandates, and the test that a new field did not turn a
    // typo into a silent pass either.
    const withBlock = validateAssetMeta(full);
    expect(withBlock.diagnostics).toEqual([]);
  });

  it('rejects a misspelled field inside the block as both findings, like everywhere else', () => {
    // The sharpest consequence of keeping `.strict()`: tolerance for the future must not
    // become tolerance for typos. A `facing` that became `faicng` is caught.
    const parsed = JSON.parse(renderAssetMeta(walkCycle(), { directions: walkFacings() })) as Record<string, any>;
    parsed.frames.directions[0].faicng = 'N';
    delete parsed.frames.directions[0].facing;
    const result = validateAssetMeta(parsed);
    const codes = result.diagnostics.map((d) => d.code).sort();
    // Two findings, one of them an error — the pairing S3 promises: an advisory for the key
    // nobody knows, and an error for the required one it should have been.
    //
    // The error code is `invalid-value` rather than `missing-field`, and that is a
    // pre-existing limitation of `validate.ts` rather than anything about this field:
    // `missingRequiredPaths` collects LEAF paths (`frames.directions[0].facing`) while
    // `shapeCode` tests the zod issue's own path, which for a missing key inside an array
    // element is the element (`frames.directions[0]`), so the lookup misses. The claim this
    // test actually needs — a typo is refused, not silently accepted — holds either way, and
    // changing `validate.ts` is outside this lane's whitelist.
    expect(codes).toEqual(['invalid-value', 'unknown-field']);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.find((d) => d.code === 'unknown-field')!.path).toBe(
      'frames.directions[0].faicng',
    );

    // The same typo at the top level, where the leaf path and the issue path agree, does
    // report `missing-field`. That is the case the existing test pins, and it is why the
    // difference above is worth naming rather than papering over.
    const topLevel = JSON.parse(renderAssetMeta(walkCycle(), { directions: walkFacings() })) as Record<string, any>;
    topLevel.asset.contenHash = topLevel.asset.contentHash;
    delete topLevel.asset.contentHash;
    expect(validateAssetMeta(topLevel).diagnostics.map((d) => d.code).sort()).toEqual([
      'missing-field',
      'unknown-field',
    ]);
  });

  it('rejects a facing outside the closed enum', () => {
    const parsed = JSON.parse(renderAssetMeta(walkCycle(), { directions: walkFacings() })) as Record<string, any>;
    parsed.frames.directions[0].facing = 'sideways';
    expect(validateAssetMeta(parsed).diagnostics.map((d) => d.code)).toContain('invalid-value');
    parsed.frames.directions[0].facing = 'NN';
    expect(validateAssetMeta(parsed).diagnostics.map((d) => d.code)).toContain('invalid-value');
    // The near-miss on the legal side: every member of the enum is accepted.
    for (const facing of [...ASSET_FACINGS, 'none'] as const) {
      const ok = JSON.parse(renderAssetMeta(walkCycle(), { directions: walkFacings() })) as Record<string, any>;
      ok.frames.directions[0].facing = facing;
      expect(validateAssetMeta(ok).ok).toBe(true);
    }
  });
});

/* ================================================================== *
 * The round trip, into real engine output
 * ================================================================== */

describe('per-frame direction survives into engine importers', () => {
  /** One contract, imported four ways. Built once so no importer can see a different file. */
  const sprite = walkCycle();
  const contract = metaOf(sprite, { directions: walkFacings(), ...sheetOf(sprite, { facings: walkFacings() }) });
  const parsed = JSON.parse(renderAssetMeta(sprite, {
    directions: walkFacings(),
    ...sheetOf(sprite, { facings: walkFacings() }),
  }));

  it('reads back what it wrote, before any importer sees it', () => {
    // The pairing that keeps the four importer assertions from being vacuous: if the contract
    // did not carry the direction, none of the importers below could possibly emit it.
    expect(contract.frames.directions![6]).toEqual({ index: 6, facing: 'SE', animations: ['walk_se'] });
    expect(parsed.frames.directions.map((entry: { facing: string }) => entry.facing)).toEqual(walkFacings());
    expect(contract.sheet!.regions).toHaveLength(16);
  });

  it('reaches the Godot bundle as a resource a game can index by frame', () => {
    const result = importGodot(parsed);
    const res = fileWithRole(result, 'godot-directions');

    // Exact strings, because "the file mentions a direction" is not the claim. The facings
    // are a PackedStringArray in timeline order, which is what a `CharacterBody2D` indexes.
    expect(res).toContain('[gd_resource type="Resource"');
    expect(res).toContain(
      'metadata/dotloom_facings = PackedStringArray("N", "N", "NE", "NE", "E", "E", "SE", "SE", "S", "S", "SW", "SW", "W", "W", "NW", "NW")',
    );
    expect(res).toContain('metadata/dotloom_frame_animations = PackedStringArray(');
    expect(res).toContain(
      'metadata/dotloom_frame_animations = PackedStringArray("walk_n", "walk_n", "walk_ne", "walk_ne", "walk_e", "walk_e", "walk_se", "walk_se", "walk_s", "walk_s", "walk_sw", "walk_sw", "walk_w", "walk_w", "walk_nw", "walk_nw")',
    );
    expect(res).toContain(`metadata/dotloom_content_hash = ${JSON.stringify(contract.asset.contentHash)}`);

    // Index 12 in that array is the walk-WEST row, findable without the caller counting from a
    // tag list — which is the whole point of shipping the array in timeline order.
    const facings = /PackedStringArray\(([^)]*)\)/.exec(res.split('\n').find((l) => l.includes('dotloom_facings'))!);
    expect(JSON.parse(`[${facings![1]}]`)[12]).toBe('W');
    expect(JSON.parse(`[${facings![1]}]`)[8]).toBe('S');
    // Named as its own file, because SpriteFrames has nowhere to put it.
    expect(result.files.some((file) => file.path === 'hero-walk.directions.res')).toBe(true);
    // And it is not a warning: nothing was lost, so nothing warns.
    expect(result.warnings.join(' ')).not.toContain('direction');
  });

  it('reaches the Phaser module as readable JavaScript', () => {
    const result = importPhaser(parsed);
    const module_ = fileWithRole(result, 'phaser-module');

    // Module scope: parallel to DURATIONS_MS, `null` where the contract says `none`.
    expect(module_).toContain(
      'export const FRAME_FACINGS = ["N","N","NE","NE","E","E","SE","SE","S","S","SW","SW","W","W","NW","NW"];',
    );
    // Per animation, in playback order — the row a game picks from a velocity.
    expect(module_).toContain('"walk_sw": {');
    expect(module_).toContain('frameFacings: ["SW","SW"]');
    expect(module_).toContain('frameFacings: ["NW","NW"]');
    // And on each entry of createAnimations.frames, so a manual index carries it too.
    expect(module_).toContain('duration: 100, facing: "SW" }');
    expect(result.warnings.join(' ')).not.toContain('direction');
  });

  it('reaches the Unity description, and the C# class that reads it', () => {
    const result = importUnity(parsed);
    const description = JSON.parse(fileWithRole(result, 'unity-description'));
    expect(description.frameFacings).toEqual(walkFacings());
    const clip = description.animations.find((a: { name: string }) => a.name === 'walk_sw');
    expect(clip.facings).toEqual(['SW', 'SW']);
    // The half that actually matters: `JsonUtility` drops keys the class does not declare, so
    // a field emitted but undeclared is a field that does not exist once Unity has read it.
    const script = fileWithRole(result, 'unity-editor-script');
    expect(script).toContain('public string[] frameFacings;');
    expect(script).toContain('public string[] facings;');
  });

  it('reaches the Excalidraw scene as customData', () => {
    const result = importExcalidraw(parsed);
    const scene = JSON.parse(fileWithRole(result, 'excalidraw-scene'));
    expect(scene.elements).toHaveLength(16);
    expect(scene.elements[12].customData.dotloom.facing).toBe('W');
    expect(scene.elements[12].customData.dotloom.animations).toEqual(['walk_w']);
    expect(scene.elements[8].customData.dotloom.facing).toBe('S');
    expect(scene.elements[0].customData.dotloom.facing).toBe('N');
  });

  it('omits every direction from every importer when the contract has none', () => {
    // The near-miss, and the half of the test that makes the other half real. An asset with
    // no direction model must produce output that does not mention directions at all — not a
    // resource full of nulls, which would be a file that claims to know something it does not.
    const plain = JSON.parse(renderAssetMeta(walkCycle(), sheetOf(walkCycle())));
    expect(importGodot(plain).files.some((f) => f.role === 'godot-directions')).toBe(false);
    expect(fileWithRole(importPhaser(plain), 'phaser-module')).not.toContain('FRAME_FACINGS');
    expect(fileWithRole(importPhaser(plain), 'phaser-module')).not.toContain('frameFacings');
    expect(fileWithRole(importPhaser(plain), 'phaser-module')).not.toContain('facing');
    const unity = JSON.parse(fileWithRole(importUnity(plain), 'unity-description'));
    expect(unity.frameFacings).toBeNull();
    expect(unity.animations.every((a: { facings: unknown }) => Array.isArray(a.facings))).toBe(true);
    expect(JSON.parse(fileWithRole(importExcalidraw(plain), 'excalidraw-scene')).elements[0].customData.dotloom.facing).toBeNull();
    // And the atlas JSONs, which are the other export path.
    const bare = buildSpritesheet(walkCycle());
    expect(JSON.stringify(toGenericAtlasJson(walkCycle(), bare))).not.toContain('facing');
  });

  it('makes every importer throw on a contract whose directions block is corrupt', () => {
    // An importer that does not validate is an importer that ships a broken engine file. This
    // reaches the readers through the same `unknown` argument a caller would.
    const broken = JSON.parse(renderAssetMeta(sprite, { directions: walkFacings() })) as Record<string, any>;
    broken.frames.directions[3].facing = 'sideways';
    for (const importer of [importGodot, importPhaser, importUnity, importExcalidraw]) {
      expect(() => importer(broken)).toThrow(/cannot be imported/);
    }
  });
});

/* ================================================================== *
 * Determinism
 * ================================================================== */

describe('direction metadata is deterministic', () => {
  it('writes byte-identical meta.json for the same document twice', () => {
    // Byte comparison, not structural. `meta.json` is written next to an exported sheet and
    // is expected to be byte-identical across machines (S11); a diff in a committed contract
    // means "the run changed" rather than "the art changed", and this is the assertion that
    // says the direction block did not introduce a source of that.
    const run = (idSeed: number): string => {
      setIdFactory(deterministicIdFactory(idSeed));
      try {
        const sprite = walkCycle();
        return renderAssetMeta(sprite, {
          directions: walkFacings(),
          ...sheetOf(sprite, { facings: walkFacings() }),
        });
      } finally {
        setIdFactory(null);
      }
    };
    const a = run(5);
    const b = run(5);
    expect(a.length).toBeGreaterThan(400);
    expect(b).toBe(a);

    // The discriminating half: it is not a constant. A different id seed changes the
    // document's ids, which the digest must ignore, so the bytes must not move either.
    expect(run(6)).toBe(a);
  });

  it('writes byte-identical output for every importer, twice', () => {
    const parsed = JSON.parse(
      renderAssetMeta(walkCycle(), {
        directions: walkFacings(),
        ...sheetOf(walkCycle(), { facings: walkFacings() }),
      }),
    );
    for (const importer of [importGodot, importPhaser, importUnity, importExcalidraw]) {
      const once = importer(parsed);
      const twice = importer(parsed);
      expect(twice.files.map((f) => [f.path, f.contents])).toEqual(once.files.map((f) => [f.path, f.contents]));
      expect(twice.warnings).toEqual(once.warnings);
    }
  });

  it('renders the direction sheet to identical bytes twice', () => {
    const sprite = walkCycle();
    const a = renderDirectionSheet(sprite, { facings: walkFacings(), columns: 4, background: '#202030' });
    const b = renderDirectionSheet(sprite, { facings: walkFacings(), columns: 4, background: '#202030' });
    expect([...b.image.data]).toEqual([...a.image.data]);
    expect(b.cells).toEqual(a.cells);
    // And it is not a blank sheet: a constant would satisfy the equality above.
    expect(new Set(a.image.data).size).toBeGreaterThan(2);
  });

  it('adds no clock, no randomness and no trigonometry to the sources this feature touched', () => {
    // The determinism rule enforced on the source rather than trusted, which is what
    // `test/determinism.test.ts` does for the whole tree. The facing arrows are hand-drawn
    // bitmaps precisely so this list stays as short as it is.
    const files = ['../src/atlas.ts', '../src/render.ts', '../src/asset/schema.ts', '../src/asset/build.ts'];
    const banned = /Math\.(random|atan2|sin|cos|tan|hypot|pow|exp|log)|Date\.now|new Date/;
    for (const relative of files) {
      const path = fileURLToPath(new URL(relative, import.meta.url));
      const text = readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1 ');
      expect(`${path}: ${text.match(banned)}`).toBe(`${path}: null`);
    }
  });
});