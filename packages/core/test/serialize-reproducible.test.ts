import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  createEditor,
  createSprite,
  deterministicIdFactory,
  makeId,
  PixelBuffer,
  serializeSprite,
  setIdFactory,
  ZIP_MTIME,
  type Sprite,
} from '../src/index.js';
import { deserializeSprite, PIXEL_FORMAT, type SpriteManifest } from '../src/serialize.js';
import { encodePNG } from '../src/png.js';

/**
 * The `.pixel` container has to be byte-reproducible, and this file is the argument.
 *
 * A `.pixel` file is the *editable source* that `finalize_document` writes next to the
 * rendered PNGs, and `finalize_document` with a `manifest` publishes a SHA-256 of exactly
 * those bytes. So "the source did not change" is only worth anything if the bytes are a
 * function of the document. That is what makes the claim checkable instead of hopeful,
 * and it is what lets the benchmark corpus diff a run against a committed baseline.
 *
 * Two things stood in the way, and both are settled here:
 *
 *   1. The layer id was in the cel filename and the tilemap id in the tilemap filename.
 *      Ids come from `makeId`, which mixes the clock with real entropy, so two runs of
 *      the same ops produced two archives that differed from the first entry name
 *      onwards — 880 bytes against 878, diverging at byte 48. The frame index and the
 *      layer's position in `sprite.layers` are already unique, so the id bought nothing.
 *   2. fflate stamps every zip entry with the current time unless it is told otherwise,
 *      so even a fully deterministic document produced a different archive on every save.
 *      `ZIP_MTIME` pins it.
 *
 * Every claim below is checked twice, on the same comparison code: once that a fixed
 * seed reproduces, and once that a different seed does not. A "same seed, same bytes"
 * assertion on its own is satisfied by an empty buffer, a constant, or a comparison that
 * never runs; the paired "different seed, different bytes" assertion fails all three.
 */

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Every entry name in a `.pixel` archive, in stored order. */
function entryNames(bytes: Uint8Array): string[] {
  return Object.keys(unzipSync(bytes));
}

/** The manifest of a `.pixel` archive, as text, so ids can be compared without parsing. */
function manifestText(bytes: Uint8Array): string {
  return strFromU8(unzipSync(bytes)['manifest.json']);
}

/** Entry names and body lengths — everything in the archive except the manifest itself. */
function pixelEntries(bytes: Uint8Array): Record<string, number> {
  return Object.fromEntries(
    Object.entries(unzipSync(bytes))
      .filter(([name]) => name !== 'manifest.json')
      .map(([name, body]) => [name, body.byteLength]),
  );
}

/**
 * A sprite that touches every part of the container: three layers, two frames, a tag, a
 * tileset with tile properties, a tilemap, a map object, and a rig with a pose, an anchor
 * and a hitbox. Built through the command bus so the document is internally consistent
 * — an id that nothing else points at would not be a fair test of anything.
 */
function buildProbeSprite(): Sprite {
  const editor = createEditor(createSprite({ width: 8, height: 8, layers: ['ink', 'shade', 'spark'] }));

  editor.execute('draw_rect', { layer: 'ink', frame: 0, rect: { x: 0, y: 0, w: 4, h: 4 }, color: '#ff0000', fill: true });
  // Frame 1 gets a middle-layer cel and a top-layer cel. `shade` is deliberately left
  // empty on frame 0, because an empty cel must not earn a path.
  editor.execute('add_frame', { durationMs: 140 });
  editor.execute('draw_rect', { layer: 'shade', frame: 1, rect: { x: 2, y: 2, w: 3, h: 3 }, color: '#0000ff', fill: true });
  editor.execute('draw_pixels', { layer: 'spark', frame: 1, pixels: [{ x: 5, y: 5, color: '#00ff00' }] });
  editor.execute('upsert_tags', { tags: [{ name: 'idle', from: 0, to: 1 }] });

  editor.execute('create_tileset', {
    layer: 'ink', frame: 0, tileWidth: 2, tileHeight: 2, columns: 2, name: 'Terrain',
  });
  editor.execute('set_tile_properties', { tile: 1, properties: { walkable: false, kind: 'water' } });
  editor.execute('add_tilemap', { name: 'Ground', width: 2, height: 2, tileWidth: 2, tileHeight: 2 });
  editor.execute('set_tile', { tilemap: 'Ground', x: 0, y: 0, tile: 1 });
  editor.execute('add_map_object', { name: 'Gate', type: 'trigger', x: 3, y: 1, width: 2, height: 2 });

  editor.execute('create_rig', {
    restFrame: 0,
    parts: [
      { name: 'body', pivot: { x: 4, y: 7 }, layers: ['ink'] },
      { name: 'glint', pivot: { x: 4, y: 7 }, layers: ['spark'] },
    ],
  });
  const rig = editor.execute('get_rig', {}) as { rig: { parts: Array<{ id: string; name: string }> } };
  const glint = rig.rig.parts.find((part) => part.name === 'glint')!;
  editor.execute('save_pose', { name: 'raised', transforms: { [glint.id]: { dx: 1, dy: 0 } } });
  editor.execute('set_anchor', { name: 'origin', part: 'body', point: { x: 0, y: 7 } });
  editor.execute('set_hitbox', { name: 'core', part: 'body', rect: { x: 0, y: 0, w: 4, h: 4 } });

  return editor.sprite;
}

/**
 * Replay a fixed ops list into a fresh document and serialise it.
 *
 * `idSeed` and `opsSeed` are independent on purpose. Holding `opsSeed` and moving
 * `idSeed` gives two documents with *identical pixels and different identity* — the exact
 * situation the old naming turned into four new filenames, and the situation the seeded
 * path has to reproduce byte for byte.
 */
function buildDeterministic(idSeed = 101, opsSeed = 7): Uint8Array {
  setIdFactory(deterministicIdFactory(idSeed));
  try {
    const editor = createEditor(createSprite({ width: 16, height: 16, layers: ['base', 'detail'] }));
    editor.execute('noise_fill', {
      layer: 'base', frame: 0, rect: { x: 0, y: 0, w: 16, h: 16 },
      from: '#101828', to: '#83b7b0', scale: 4, octaves: 3, seed: opsSeed,
    });
    editor.execute('scatter', {
      layer: 'detail', frame: 0, rect: { x: 0, y: 0, w: 16, h: 16 },
      count: 12, colors: ['#fff2c7', '#2b8296'], radius: 1, falloff: 0.3, cluster: 0.4, seed: opsSeed,
    });
    editor.execute('add_frame', { durationMs: 120 });
    editor.execute('draw_rect', {
      layer: 'base', frame: 1, rect: { x: 1, y: 1, w: 2, h: 2 }, color: '#ff00ff', fill: true,
    });
    return serializeSprite(editor.sprite);
  } finally {
    setIdFactory(null);
  }
}

/**
 * A container written the way 0.4.1 wrote them: `cels/<frame>_<layerId>.png` and
 * `tilemaps/<id>.json`, assembled here by hand from a real document, so nothing about
 * the assertion can be satisfied by the writer it is testing.
 */
function legacyContainer(): { bytes: Uint8Array; source: Sprite } {
  const sprite = buildProbeSprite();
  const files: Record<string, Uint8Array> = {};
  const cels: Array<{ layerId: string; frameId: string; path: string }> = [];

  sprite.frames.forEach((frame, frameIndex) => {
    for (const [layerId, buffer] of frame.cels) {
      if (buffer.isEmpty()) continue;
      // The pre-T-091 naming: frame index, then the layer id verbatim.
      const path = `cels/${frameIndex}_${layerId}.png`;
      files[path] = encodePNG(buffer);
      cels.push({ layerId, frameId: frame.id, path });
    }
  });

  if (sprite.tileset) files['tileset.png'] = encodePNG(sprite.tileset.image);

  const tilemaps = sprite.tilemaps?.map((tilemap) => {
    // The pre-T-091 naming: the tilemap id verbatim.
    const data = `tilemaps/${tilemap.id}.json`;
    files[data] = strToU8(JSON.stringify(Array.from(tilemap.data)));
    return {
      id: tilemap.id,
      name: tilemap.name,
      width: tilemap.width,
      height: tilemap.height,
      tileWidth: tilemap.tileWidth,
      tileHeight: tilemap.tileHeight,
      data,
    };
  });

  const manifest: SpriteManifest = {
    format: PIXEL_FORMAT,
    version: 2,
    sprite: {
      id: sprite.id,
      name: sprite.name,
      width: sprite.width,
      height: sprite.height,
      layers: sprite.layers,
      frames: sprite.frames.map((f) => ({ id: f.id, durationMs: f.durationMs })),
      tags: sprite.tags,
      ...(sprite.rig ? { rig: sprite.rig } : {}),
      palette: sprite.palette,
      paletteLocked: sprite.paletteLocked,
    },
    cels,
    ...(sprite.tileset
      ? {
          tileset: {
            id: sprite.tileset.id,
            name: sprite.tileset.name,
            tileWidth: sprite.tileset.tileWidth,
            tileHeight: sprite.tileset.tileHeight,
            columns: sprite.tileset.columns,
            image: 'tileset.png',
            ...(sprite.tileset.tileProperties ? { tileProperties: sprite.tileset.tileProperties } : {}),
          },
        }
      : {}),
    ...(sprite.mapObjects?.length
      ? { mapObjects: sprite.mapObjects.map((object) => ({ ...object, properties: { ...object.properties } })) }
      : {}),
    ...(tilemaps ? { tilemaps } : {}),
  };
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  // `ZIP_MTIME` so the legacy archive is itself stable. 0.4.1 stamped the clock, which is
  // a separate bug and not what this test is about. The document it was built from is
  // returned so the assertions compare against the *same* ids rather than a second
  // `makeId` build, which would differ in every field.
  return { bytes: zipSync(files, { level: 6, mtime: ZIP_MTIME }), source: sprite };
}

/** Run `fn` with `Date.now()` pinned, so a wall-clock dependency cannot hide. */
function withFakeClock<T>(ms: number, fn: () => T): T {
  const realNow = Date.now;
  Date.now = () => ms;
  try {
    return fn();
  } finally {
    Date.now = realNow;
  }
}

/* ------------------------------------------------------------------ *
 * Entry names
 * ------------------------------------------------------------------ */

describe('the .pixel container names its entries by position', () => {
  it('writes cels as <frame>_<layer position> and tilemaps as <index>', () => {
    expect(entryNames(serializeSprite(buildProbeSprite()))).toEqual([
      'cels/0_0.png', // frame 0, the bottom layer
      'cels/1_1.png', // frame 1, the middle layer
      'cels/1_2.png', // frame 1, the top layer
      'tileset.png',
      'tilemaps/0.json',
      'manifest.json',
    ]);
  });

  it('puts no id in any entry name', () => {
    // The assertion the change exists for, stated as a property of the artifact rather
    // than of the code. Every id in the document is checked, including the rig's, because
    // those are exactly the ones that would slip back into a filename unnoticed.
    const sprite = buildProbeSprite();
    const ids = [
      sprite.id,
      ...sprite.layers.map((layer) => layer.id),
      ...sprite.frames.map((frame) => frame.id),
      ...sprite.tags.map((tag) => tag.id),
      ...sprite.tilemaps!.map((tilemap) => tilemap.id),
      ...sprite.mapObjects!.map((object) => object.id),
      sprite.tileset!.id,
      ...sprite.rig!.parts.map((part) => part.id),
      ...sprite.rig!.poses.map((pose) => pose.id),
    ];
    const names = entryNames(serializeSprite(sprite));

    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) {
      expect(ids.filter((candidate) => candidate === id)).toHaveLength(1); // the list is not padded
      expect(names.some((name) => name.includes(id))).toBe(false);
    }
  });

  it('records the path beside the id in the manifest, so the mapping is not lost', () => {
    // Where the id actually lives now. `manifest.cels[].path` has always been what the
    // reader goes through; this is the proof that removing the id from the name moved
    // information rather than deleting it, and that a reader can go number -> layer -> id
    // using nothing but the manifest.
    const manifest = JSON.parse(manifestText(serializeSprite(buildProbeSprite()))) as SpriteManifest;
    const layerOrder = manifest.sprite.layers.map((layer) => layer.id);

    expect(manifest.cels).toHaveLength(3);
    for (const entry of manifest.cels) {
      const parts = /^cels\/(\d+)_(\d+)\.png$/.exec(entry.path);
      expect(parts, `unexpected cel path ${entry.path}`).not.toBeNull();
      const [, frameIndex, layerNumber] = parts!;
      expect(layerOrder[Number(layerNumber)]).toBe(entry.layerId);
      expect(manifest.sprite.frames[Number(frameIndex)].id).toBe(entry.frameId);
    }
    expect(manifest.tilemaps!.map((tilemap) => tilemap.data)).toEqual(['tilemaps/0.json']);
    expect(manifest.tileset!.image).toBe('tileset.png');
  });

  it('numbers layers by their position in sprite.layers', () => {
    // The trade, stated. The number means "the nth layer of the document", which is a
    // property of the document rather than of a clock, so reordering layers renumbers the
    // paths. The manifest is what maps a number back to an id.
    const sprite = buildProbeSprite();
    const before = entryNames(serializeSprite(sprite));
    sprite.layers.reverse();
    const after = entryNames(serializeSprite(sprite));

    expect(before).not.toEqual(after);
    expect(after).toContain('cels/0_2.png'); // `ink` was layer 0, now layer 2
    expect(after).toContain('cels/1_0.png'); // `spark` was layer 2, now layer 0
  });

  it('leaves no path to an empty cel', () => {
    const sprite = buildProbeSprite();
    expect(sprite.frames[0].cels.get(sprite.layers[1].id)?.isEmpty() ?? true).toBe(true);
    expect(entryNames(serializeSprite(sprite))).not.toContain('cels/0_1.png');
  });

  it('keeps a cel whose layer is not in sprite.layers instead of dropping it', () => {
    // Unreachable through the command bus — `remove_layer` purges a layer's cels — but a
    // hand-built `Sprite` can carry one, and losing pixels silently in a serialiser is
    // worse than a path that names no layer. The orphan is numbered after the real layers
    // in id order, so the archive stays a function of the document.
    setIdFactory(deterministicIdFactory(9));
    try {
      const sprite = createSprite({ width: 4, height: 4, layers: ['base'] });
      const baseId = sprite.layers[0].id;
      const orphanId = makeId('layer');
      sprite.frames[0].cels.set(orphanId, PixelBuffer.filled(4, 4, { r: 1, g: 2, b: 3, a: 255 }));

      const bytes = serializeSprite(sprite);
      expect(entryNames(bytes)).toContain('cels/0_1.png');

      const restored = deserializeSprite(bytes);
      const orphan = [...restored.frames[0].cels.entries()].find(([id]) => id !== baseId);
      expect(orphan?.[0]).toBe(orphanId);
      expect(orphan?.[1].getColor(0, 0)).toEqual({ r: 1, g: 2, b: 3, a: 255 });
    } finally {
      setIdFactory(null);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Backward compatibility
 * ------------------------------------------------------------------ */

describe('a container written with the pre-T-091 entry names still loads', () => {
  it('reads hand-built cels/<frame>_<layerId>.png and tilemaps/<id>.json', () => {
    const { bytes, source } = legacyContainer();

    // Guard the guard: the archive under test really does use the old naming, ids and
    // all, so a reader that parsed entry names would have nothing to find.
    const names = entryNames(bytes);
    expect(names.filter((name) => name.startsWith('cels/'))).toHaveLength(3);
    for (const name of names.filter((entry) => entry.startsWith('cels/'))) {
      expect(name).toMatch(/^cels\/\d+_lay_[\da-z]+\.png$/);
    }
    expect(names.filter((name) => name.startsWith('tilemaps/'))).toHaveLength(1);
    expect(names.find((name) => name.startsWith('tilemaps/'))).toMatch(/^tilemaps\/tilemap_[\da-z]+\.json$/);

    const restored = deserializeSprite(bytes);

    expect(restored.id).toBe(source.id);
    expect(restored.name).toBe(source.name);
    expect(restored.width).toBe(8);
    expect(restored.height).toBe(8);
    expect(restored.layers).toEqual(source.layers);
    expect(restored.frames.map((f) => [f.id, f.durationMs])).toEqual(
      source.frames.map((f) => [f.id, f.durationMs]),
    );
    expect(restored.tags).toEqual(source.tags);
    expect(restored.palette.colors).toEqual(source.palette.colors);
    expect(restored.mapObjects).toEqual(source.mapObjects);
    expect(restored.rig?.parts.map((p) => [p.id, p.name])).toEqual(source.rig?.parts.map((p) => [p.id, p.name]));
    expect(restored.rig?.poses.map((p) => p.id)).toEqual(source.rig?.poses.map((p) => p.id));
    expect(restored.rig?.anchors.map((a) => a.id)).toEqual(source.rig?.anchors.map((a) => a.id));
    expect(restored.rig?.hitboxes.map((h) => h.id)).toEqual(source.rig?.hitboxes.map((h) => h.id));

    // Every cel, addressed through its legacy path.
    const [ink, shade, spark] = source.layers;
    expect(restored.frames[0].cels.get(ink.id)?.isEqualTo(source.frames[0].cels.get(ink.id)!)).toBe(true);
    expect(restored.frames[1].cels.get(shade.id)?.isEqualTo(source.frames[1].cels.get(shade.id)!)).toBe(true);
    expect(restored.frames[1].cels.get(spark.id)?.isEqualTo(source.frames[1].cels.get(spark.id)!)).toBe(true);
    // The empty cel stayed absent rather than coming back as a blank buffer.
    expect(restored.frames[0].cels.has(shade.id)).toBe(false);

    // Tileset behind `image: "tileset.png"`, its tile properties, and the tilemap behind
    // its legacy `data: "tilemaps/<id>.json"`.
    expect(restored.tileset?.image.isEqualTo(source.tileset!.image)).toBe(true);
    expect(restored.tileset?.tileProperties).toEqual(source.tileset?.tileProperties);
    expect(restored.tilemaps?.[0].id).toBe(source.tilemaps![0].id);
    expect(Array.from(restored.tilemaps?.[0].data ?? [])).toEqual(Array.from(source.tilemaps![0].data));
  });

  it('re-serialising a legacy document writes the new names and keeps every id', () => {
    // The direction that actually matters to a user with a file on disk: load an old
    // container, save it, and every id survives because it lives in the manifest rather
    // than in a path. Nothing downstream — a rig bound to a layer id, a tag, a tilemap —
    // can be left pointing at a name that no longer exists.
    const restored = deserializeSprite(legacyContainer().bytes);
    const resaved = serializeSprite(restored);
    const names = entryNames(resaved);
    expect(names).toContain('cels/0_0.png');
    expect(names).toContain('tilemaps/0.json');
    // Not one id from the loaded document is left anywhere in a path.
    const ids = [
      restored.id,
      ...restored.layers.map((layer) => layer.id),
      ...restored.frames.map((frame) => frame.id),
      ...restored.tags.map((tag) => tag.id),
      ...restored.tilemaps!.map((tilemap) => tilemap.id),
      ...restored.mapObjects!.map((object) => object.id),
      restored.tileset!.id,
      ...restored.rig!.parts.map((part) => part.id),
      ...restored.rig!.poses.map((pose) => pose.id),
    ];
    for (const id of ids) expect(names.some((name) => name.includes(id))).toBe(false);

    const again = deserializeSprite(resaved);
    expect(again.id).toBe(restored.id);
    expect(again.layers.map((l) => l.id)).toEqual(restored.layers.map((l) => l.id));
    expect(again.frames.map((f) => f.id)).toEqual(restored.frames.map((f) => f.id));
    expect(again.tags).toEqual(restored.tags);
    expect(again.rig?.parts.map((p) => p.id)).toEqual(restored.rig?.parts.map((p) => p.id));
    expect(again.rig?.poses.map((p) => p.id)).toEqual(restored.rig?.poses.map((p) => p.id));
    expect(again.tilemaps?.[0].id).toBe(restored.tilemaps?.[0].id);
    expect(Array.from(again.tilemaps?.[0].data ?? [])).toEqual(Array.from(restored.tilemaps![0].data));
    expect(again.tileset?.image.isEqualTo(restored.tileset!.image)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Byte reproducibility
 * ------------------------------------------------------------------ */

describe('a deterministically built document serialises to identical bytes', () => {
  it('is byte-identical for the same id seed and the same ops seed', () => {
    const a = buildDeterministic();
    const b = buildDeterministic();
    expect(a.length).toBeGreaterThan(64);
    expect([...b]).toEqual([...a]);
  });

  it('differs when the ops seed moves', () => {
    // The discriminating half. Without it the assertion above would also pass if
    // `serializeSprite` returned a constant.
    expect([...buildDeterministic(101, 8)]).not.toEqual([...buildDeterministic(101, 7)]);
  });

  it('is unchanged by the wall clock', () => {
    // fflate stamps zip entries with `Date.now()` unless `mtime` is given, so a document
    // with a fully deterministic manifest still produced a different archive on every
    // save — the old guarantee held only if you saved twice inside the same two-second
    // DOS timestamp tick. Crossing that boundary has to change nothing.
    const first = withFakeClock(1_700_000_000_000, () => buildDeterministic());
    const later = withFakeClock(1_700_000_009_000, () => buildDeterministic());
    expect([...later]).toEqual([...first]);

    // The other direction, so the assertion above is not vacuous: the same helper does
    // move the bytes of an archive that *does* stamp the clock.
    const stampedNow = (): Uint8Array => zipSync({ 'a.txt': strToU8('a') }, { level: 6 });
    expect([...withFakeClock(1_700_000_009_000, stampedNow)]).not.toEqual(
      [...withFakeClock(1_700_000_000_000, stampedNow)],
    );
  });

  it('is unchanged by the id seed, apart from the manifest', () => {
    // Impossible before this change, and the sharpest statement of what was bought. The
    // layer ids and frame ids used to sit in four separate filenames, so the same pixels
    // built under a different id seed produced four different entry names and a wholly
    // different archive. Identity now lives in `manifest.json` alone, so a document's
    // *pixel* and *layout* are a function of the ops, and only the manifest moves.
    const a = buildDeterministic(101, 7);
    const b = buildDeterministic(999, 7);

    expect(manifestText(b)).not.toBe(manifestText(a)); // the ids really did change
    expect(entryNames(b)).toEqual(entryNames(a)); // ... and no path did
    expect(pixelEntries(b)).toEqual(pixelEntries(a));
  });

  it('pins the entry timestamp to a local midnight, not an epoch instant', () => {
    // fflate reads the DOS date back with `getFullYear()`, `getMonth()` and friends, so
    // a *local* date encodes the same words on every machine. An epoch-millis instant
    // would encode that machine's UTC offset and make the bytes depend on the timezone;
    // a `Date.now()`-derived one would depend on the clock. 1980-01-01 is the oldest date
    // the DOS format can hold, and fflate throws on anything earlier, so this constant is
    // load-bearing rather than cosmetic.
    expect(ZIP_MTIME.getFullYear()).toBe(1980);
    expect(ZIP_MTIME.getMonth()).toBe(0);
    expect(ZIP_MTIME.getDate()).toBe(1);
    expect(ZIP_MTIME.getHours()).toBe(0);
    expect(ZIP_MTIME.getMinutes()).toBe(0);
    expect(ZIP_MTIME.getSeconds()).toBe(0);
    expect(() => zipSync({ 'a.txt': strToU8('a') }, { mtime: new Date(1979, 0, 1) })).toThrow();
  });
});

describe('the default id path is documented as not reproducible, and is still not', () => {
  it('cannot promise byte-identical archives, because the ids are in the manifest', () => {
    // Stated plainly rather than left implicit. `makeId` mixes the clock with real
    // entropy, and every id in a document — sprite, layer, frame, tag, tilemap, tileset,
    // map object, rig part, pose — is written into `manifest.json`, which is itself an
    // entry in the archive. Two documents with identical pixels and different identities
    // therefore produce different bytes, and no amount of fixing the container layout
    // changes that. It is not a bug: uniqueness across processes and across documents is
    // the entire point of `makeId`, and the answer to "I need reproducible ids" is
    // `deterministicIdFactory`, not a weaker default. See the note in `ids.ts`.
    const buildWithDefaultIds = (): Uint8Array => {
      const editor = createEditor(createSprite({ width: 8, height: 8, layers: ['base'] }));
      editor.execute('draw_rect', {
        layer: 0, frame: 0, rect: { x: 0, y: 0, w: 4, h: 4 }, color: '#ff0000', fill: true,
      });
      return serializeSprite(editor.sprite);
    };
    const a = buildWithDefaultIds();
    const b = buildWithDefaultIds();

    // Same pixels, same paths. The manifest is the only difference, and the difference
    // is the ids — which is the honest boundary of this guarantee.
    expect(entryNames(a)).toEqual(entryNames(b));
    expect(pixelEntries(a)).toEqual(pixelEntries(b));
    expect(manifestText(a)).not.toBe(manifestText(b));

    // Under a seeded factory the same two builds do agree, which is the guarantee.
    expect([...buildDeterministic()]).toEqual([...buildDeterministic()]);
  });
});
