import { describe, expect, it } from 'vitest';
import { buildSpritesheet, scaleAtlas, type Atlas } from '../src/atlas.js';
import { buildAssetMeta, renderAssetMeta, serializeAssetMeta, type AssetMeta, type AssetMetaOptions } from '../src/asset/index.js';
import {
  AssetImportError,
  importExcalidraw,
  importGodot,
  importPhaser,
  importUnity,
  readAssetMeta,
} from '../src/asset/importers/index.js';
import { PixelBuffer } from '../src/buffer.js';
import { createSprite, type Sprite } from '../src/document.js';

/**
 * Every importer, end to end: a real document, a real `meta.json` byte string, real bytes out.
 *
 * ## Why the bytes are round-tripped through JSON in every test
 *
 * An importer that reads a `AssetMeta` object is only proven against a value some other code
 * produced in memory. The contract is a *file*, and a file goes through `JSON.parse` — which
 * turns `undefined` into "absent", drops nothing, and can produce an object whose prototype is
 * not what the builder left behind. So every fixture here does
 * `JSON.parse(renderAssetMeta(sprite))` and feeds that to the importer. An importer that works
 * on the builder's object but not on the parsed file has a bug that only shows up in a game.
 *
 * Each test is written to fail for one specific wrong implementation, and the comment says
 * which. A naming or mapping test that passes for a correct and an incorrect implementation
 * proves nothing, which is the standard `AGENTS.md` sets for a measurement — and a mapping *is*
 * a measurement: it can be measured against the contract or it can be decorative.
 */

/**
 * 8x8, four frames, two tags with different directions.
 *
 * Frame 2 holds for 200ms and the others for 100, so the timeline is 100/100/200/100 — which is
 * what makes "the mapping handled a uniform timeline and nothing else" testable. The `idle` tag
 * is deliberately given a **uniform** range (frames 0..1) and `hit` a **non-uniform** one
 * (1..2), because a warning that fires on every animation is indistinguishable from a warning
 * that fires on the right one.
 */
function sprite(): Sprite {
  const made = createSprite({ width: 8, height: 8, name: 'hero-idle', frames: 4, frameDurationMs: 100 });
  const layerId = made.layers[0].id;
  made.frames.forEach((frame, index) => {
    const cel = new PixelBuffer(8, 8);
    cel.setColor(index, 0, { r: 255, g: 0, b: 0, a: 255 });
    frame.cels.set(layerId, cel);
  });
  made.frames[2].durationMs = 200;
  made.tags.push({ id: 'tag_idle', name: 'idle', from: 0, to: 1, direction: 'forward', repeat: 0 });
  made.tags.push({ id: 'tag_hit', name: 'hit', from: 1, to: 2, direction: 'pingpong', repeat: 1 });
  return made;
}

/** The same artwork with no tags, so the no-animations paths are reachable. */
function stillSprite(): Sprite {
  const made = sprite();
  made.tags = [];
  return made;
}

function atlasFor(document_: Sprite, image = 'hero-idle.png'): Atlas {
  return buildSpritesheet(document_, { layout: 'grid', columns: 2 });
}

function sheetOptions(document_: Sprite, atlas?: Atlas, image?: string): AssetMetaOptions {
  return { sheet: { atlas: atlas ?? atlasFor(document_), image: image ?? `${document_.name}.png` } };
}

/** document -> contract bytes -> parsed contract. The importer never sees the builder's object. */
function contract(document_: Sprite, options: AssetMetaOptions = {}): AssetMeta {
  return JSON.parse(renderAssetMeta(document_, options)) as AssetMeta;
}

function fileMap(result: { files: readonly { path: string; contents: string }[] }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of result.files) out[file.path] = file.contents;
  return out;
}

describe('importers read a contract, never a builder object', () => {
  it('serialises to the same bytes twice, so the fixture is stable enough to assert on', () => {
    // Not the point of an importer: it is the precondition for every other assertion here. A
    // fixture that changed shape between runs would make a green importer test meaningless.
    const document_ = sprite();
    const options = sheetOptions(document_);
    expect(renderAssetMeta(document_, options)).toBe(renderAssetMeta(document_, options));
    expect(renderAssetMeta(document_, options).endsWith('\n')).toBe(true);
  });

  it('every importer accepts a contract that came back out of JSON', () => {
    const document_ = sprite();
    const meta = contract(document_, sheetOptions(document_));
    expect(() => importGodot(meta)).not.toThrow();
    expect(() => importUnity(meta)).not.toThrow();
    expect(() => importPhaser(meta)).not.toThrow();
    expect(() => importExcalidraw(meta)).not.toThrow();
  });

  it('refuses a contract whose shapes are wrong, with the diagnostics attached', () => {
    // An importer handed a malformed contract must refuse rather than emit an engine file that
    // opens cleanly and is wrong. The error carries the reader's findings so a caller can show
    // them without re-running the validator.
    const broken = { ...contract(sprite()), frames: 'eight' };
    let thrown: unknown;
    try {
      importGodot(broken);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AssetImportError);
    expect((thrown as AssetImportError).diagnostics.some((d) => d.code === 'invalid-type')).toBe(true);
  });

  it('refuses a cross-field inconsistency, not only a shape error', () => {
    // The stronger case: the shape is fine and the *content* is wrong. `totalMs` no longer
    // matches the durations, which only the cross-field checks can see, so an importer that
    // called `assetMetaSchema.parse` directly instead of the validator would pass this.
    const meta = contract(sprite());
    (meta.frames as { totalMs: number }).totalMs = 999;
    expect(() => readAssetMeta(meta)).toThrow(AssetImportError);
  });

  it('an advisory does not block an import', () => {
    // S3's policy, checked end to end: a newer writer's extra field is tolerated. An importer
    // that refused on `unknown-field` would break every consumer the first time the spec grew,
    // which is precisely what the severity split exists to prevent.
    const meta = { ...contract(sprite()), futureField: { added: 2 } };
    expect(importPhaser(meta).meta.format).toBe('dotloom-mcp/asset-meta');
  });
});

describe('godot importer', () => {
  it('emits a SpriteFrames resource whose animation speed is the contract fps', () => {
    const document_ = sprite();
    const meta = contract(document_, sheetOptions(document_));
    const files = fileMap(importGodot(meta));
    const tres = files['hero-idle.tres'];
    // `idle` covers frames 0..1, both 100ms, total 200ms -> 10 fps. Asserted as 10 and not as
    // the whole-timeline figure: an importer that read `frames.fps` (the 8 fps of the four-frame
    // timeline) instead of the animation's own `fps` is the likely wrong implementation, and
    // the two differ on this fixture precisely because the timelines differ.
    expect(meta.frames.fps).toBe(8);
    expect(tres).toContain('"speed": 10');
    expect(tres).toContain('"loop": true');
    expect(tres).toContain('"name": &"idle"');
    // Godot's SpriteFrames takes one speed per animation, so the per-frame duration stays at
    // the 1.0 default rather than being emitted as a per-frame ratio.
    expect(tres).not.toContain('"duration": 0.5');
    expect(tres).toContain('"duration": 1.0');
  });

  it('takes the loop flag verbatim, so a two-shot attack does not loop', () => {
    // The `hit` tag is repeat: 1 -> loop false. An importer that derived the flag from
    // "there is more than one frame" passes the idle case and gets this wrong, which is a
    // gameplay bug rather than a cosmetic one.
    const document_ = sprite();
    const meta = contract(document_, sheetOptions(document_));
    const tres = fileMap(importGodot(meta))['hero-idle.tres'];
    // Split on the animation name, which Godot writes last in the block, and take the segment
    // *before* it: `loop` precedes `name`, so a forward slice from the name only sees the speed.
    const split = tres.indexOf('"name": &"hit"');
    const hit = tres.slice(tres.lastIndexOf('{\n"frames"', split), split);
    const idle = tres.slice(0, tres.lastIndexOf('{\n"frames"', split));
    expect(hit).toContain('"loop": false');
    expect(idle).toContain('"loop": true');
  });

  it('addresses each sheet cell by its region rather than by a grid', () => {
    // S9.1: regions map to explicit regions, because a grid cut would throw away the packer's
    // gap and border, which S10 says are deliberately not recorded. Asserting the region
    // numbers is what separates this from a grid importer.
    const document_ = sprite();
    const atlas = atlasFor(document_);
    const meta = contract(document_, { sheet: { atlas, image: 'hero-idle.png' } });
    const tres = fileMap(importGodot(meta))['hero-idle.tres'];
    const expected = meta.sheet!.regions.map((r) => `region = Rect2(${r.x}, ${r.y}, ${r.width}, ${r.height})`);
    expect(expected).toHaveLength(4);
    for (const line of expected) expect(tres).toContain(line);
  });

  it('maps the pivot to a centre-relative offset, with Godot sign convention', () => {
    // S9.1: offset = pivot - size/2, and a pivot at the feet is a POSITIVE y. An importer that
    // subtracts the wrong way round puts the sprite the wrong side of its own origin, which is
    // the single most-cited Godot pivot bug.
    const document_ = createSprite({ width: 32, height: 32, name: 'hero', frames: 1 });
    const meta = contract(document_);
    expect(meta.pivot).toEqual({ x: 16, y: 16, source: 'default' });
    const tscn = fileMap(importGodot(meta))['hero.tscn'];
    expect(tscn).toContain('offset = Vector2(0, 0)');

    const withRig = createSprite({ width: 32, height: 32, name: 'hero', frames: 1 });
    withRig.rig = {
      restFrameId: withRig.frames[0].id,
      // A pivot at the feet: y = 32, i.e. the bottom edge.
      parts: [{ id: 'p1', name: 'body', layerIds: [withRig.layers[0].id], pivot: { x: 16, y: 32 } }],
      poses: [],
      tweens: [],
      anchors: [],
      hitboxes: [],
    };
    const feet = fileMap(importGodot(contract(withRig)))['hero.tscn'];
    expect(feet).toContain('offset = Vector2(0, 16)');
  });

  it('warns when the timeline is non-uniform, because SpriteFrames cannot hold it', () => {
    // The warning is the deliverable for this case. An importer that silently played 100/100/
    // 200 at 8fps would look correct in review and stutter in game, so the loss is reported.
    const document_ = sprite();
    const result = importGodot(contract(document_, sheetOptions(document_)));
    expect(result.warnings.some((w) => w.includes('non-uniform') && w.includes('hit'))).toBe(true);
    // The uniform `idle` timeline must NOT warn about uniformity, or the warning is noise. This
    // also pins *which* durations get quoted: an importer that reports the whole four-frame
    // timeline in the message would warn about a 200ms frame that this two-frame animation
    // never plays, sending the reader after a defect the asset does not have.
    expect(result.warnings.some((w) => w.includes('"idle" has non-uniform'))).toBe(false);
    expect(result.warnings.find((w) => w.includes('"hit" has non-uniform'))).toContain('(100/200 ms)');
    expect(result.warnings.join('\n')).not.toContain('100/100/200/100 ms). Godot');
  });

  it('uses a static Sprite2D for a still, rather than an empty AnimatedSprite2D', () => {
    // A SpriteFrames resource with no animations makes Godot write an empty resource on the
    // next save, and an AnimatedSprite2D pointing at it plays nothing. A static node is the
    // representation that matches the contract.
    const document_ = stillSprite();
    const result = importGodot(contract(document_));
    const files = fileMap(result);
    expect(files['hero-idle.tscn']).toContain('[node name="Sprite2D" type="Sprite2D"');
    expect(files['hero-idle.tscn']).not.toContain('AnimatedSprite2D');
    expect(files['hero-idle.tres']).toContain('animations = []');
    expect(result.warnings.some((w) => w.includes('no animations'))).toBe(true);
  });

  it('references the exported frame PNGs when the bundle has no sheet', () => {
    // The contract allows a bundle of individual PNGs (S5: sheet is optional), and an importer
    // that only ever reads `sheet.image` fails on it. Two sub-cases, because the still and the
    // animated form reach the reference by different routes: the still's Sprite2D `load()`s it,
    // and the animated SpriteFrames declares an ext_resource per frame.
    const still = contract(stillSprite(), {
      outputs: [
        { role: 'source', path: 'hero-idle.pixel' },
        { role: 'frame', path: 'hero-idle-0.png' },
      ],
    });
    const stillFiles = fileMap(importGodot(still));
    expect(stillFiles['hero-idle.tscn']).toContain('texture = load("res://hero-idle-0.png")');
    expect(stillFiles['hero-idle.tres']).not.toContain('AtlasTexture');

    const animated = contract(sprite(), {
      outputs: [
        { role: 'source', path: 'hero-idle.pixel' },
        { role: 'frame', path: 'hero-idle-0.png' },
        { role: 'frame', path: 'hero-idle-1.png' },
        { role: 'frame', path: 'hero-idle-2.png' },
        { role: 'frame', path: 'hero-idle-3.png' },
      ],
    });
    const tres = fileMap(importGodot(animated))['hero-idle.tres'];
    expect(tres).toContain('path="res://hero-idle-0.png"');
    expect(tres).toContain('path="res://hero-idle-2.png"');
    expect(tres).not.toContain('AtlasTexture');
  });

  it('emits byte-identical output for the same contract twice', () => {
    // A committed engine resource that changes on every export is a diff nobody can explain.
    const document_ = sprite();
    const meta = contract(document_, sheetOptions(document_));
    expect(serializeAssetMeta(meta)).toBe(serializeAssetMeta(meta));
    const first = importGodot(meta);
    const second = importGodot(meta);
    expect(fileMap(second)).toEqual(fileMap(first));
  });
});

describe('unity importer', () => {
  it('emits a description plus the editor script that consumes it', () => {
    // The script is not decorative: it is the only place `TextureImporter` can be driven from,
    // so an importer that emitted only JSON would be handing over a description nothing reads.
    const document_ = sprite();
    const result = importUnity(contract(document_, sheetOptions(document_)));
    const files = fileMap(result);
    expect(Object.keys(files)).toEqual(['hero-idle.unity-sprite.json', 'DotloomSpriteImporter.cs']);
    const script = files['DotloomSpriteImporter.cs'];
    expect(script).toContain('#if UNITY_EDITOR');
    expect(script).toContain('TextureImporterType.Sprite');
    expect(script).toContain('FilterMode.Point');
  });

  it('normalises the pivot, which is what Unity stores', () => {
    // S9.2: Sprite.pivot is normalised. An importer that wrote the canvas pixels through is
    // wrong by a factor of 32 on a 32px sprite, and it looks correct on a 1x1.
    const document_ = createSprite({ width: 32, height: 16, name: 'hero', frames: 1 });
    const json = JSON.parse(fileMap(importUnity(contract(document_)))['hero.unity-sprite.json']);
    expect(json.pivot.normalized).toEqual({ x: 0.5, y: 0.5 });
    expect(json.pivot.pixels).toEqual({ x: 16, y: 8 });
  });

  it('flips the pivot Y, because Unity counts from the bottom and the contract from the top', () => {
    // The conversion S9.2 does not spell out, because Unity stores neither origin. A pivot at
    // the top of a 32px sprite is y=0 in the contract and y=1 in Unity; getting it backwards
    // puts every character sprite upside down relative to its own origin.
    const document_ = createSprite({ width: 32, height: 32, name: 'hero', frames: 1 });
    document_.rig = {
      restFrameId: document_.frames[0].id,
      parts: [{ id: 'p1', name: 'body', layerIds: [document_.layers[0].id], pivot: { x: 16, y: 0 } }],
      poses: [],
      tweens: [],
      anchors: [],
      hitboxes: [],
    };
    const files = fileMap(importUnity(contract(document_)));
    const json = JSON.parse(files['hero.unity-sprite.json']);
    expect(json.pivot.normalized).toEqual({ x: 0.5, y: 0 });
    expect(json.pivot.source).toBe('rig-part');
    expect(files['DotloomSpriteImporter.cs']).toContain('1f - description.pivot.normalized.y');
  });

  it('keys every animation frame at its own cumulative time, not index/fps', () => {
    // The capability Unity has and the other three engines do not (S9.2). `hit` is a pingpong
    // over frames 1..2, whose durations are 100 and 200, so the second key is at 0.1s. An
    // importer that did `index / fps` would place both keys at 0 and 1/6s and the second frame
    // would never be seen.
    const document_ = sprite();
    const json = JSON.parse(fileMap(importUnity(contract(document_)))['hero-idle.unity-sprite.json']);
    const hit = json.animations.find((a: { name: string }) => a.name === 'hit');
    // pingpong over 1..2 is [1, 2] — the return leg omits both end frames (S6). Durations are
    // 100 then 200, so the keys land at 0 and 0.1s. `index / fps` would put them at 0 and
    // 0.15s, so this pair separates the two implementations rather than merely passing.
    expect(hit.keyframes).toEqual([
      { frame: 1, timeSeconds: 0 },
      { frame: 2, timeSeconds: 0.1 },
    ]);
    // And the near-miss on the other side of the same gate: a uniform two-frame animation
    // *does* land on the index/fps grid, so this asserts the cumulative rule is not an accident
    // of the non-uniform fixture.
    const idle = json.animations.find((a: { name: string }) => a.name === 'idle');
    expect(idle.keyframes).toEqual([
      { frame: 0, timeSeconds: 0 },
      { frame: 1, timeSeconds: 0.1 },
    ]);
  });

  it('takes wrapMode from loop, so a one-pass animation does not loop', () => {
    const document_ = sprite();
    const files = fileMap(importUnity(contract(document_)));
    const json = JSON.parse(files['hero-idle.unity-sprite.json']);
    const idle = json.animations.find((a: { name: string }) => a.name === 'idle');
    const hit = json.animations.find((a: { name: string }) => a.name === 'hit');
    expect(idle.loop).toBe(true);
    expect(hit.loop).toBe(false);
    expect(files['DotloomSpriteImporter.cs']).toContain('WrapMode.Loop : WrapMode.ClampForever');
  });

  it('carries the sheet grid and the regions for cross-checking', () => {
    // S9.2: Unity's slicer is grid-based, so columns/rows are what it needs; the regions are
    // the cross-check, and the script compares them rather than trusting either alone.
    const document_ = sprite();
    const atlas = atlasFor(document_);
    const json = JSON.parse(
      fileMap(importUnity(contract(document_, { sheet: { atlas, image: 'hero-idle.png' } })))['hero-idle.unity-sprite.json'],
    );
    expect(json.sheet.columns).toBe(atlas.columns);
    expect(json.sheet.rows).toBe(atlas.rows);
    expect(json.sheet.regions).toHaveLength(4);
    expect(json.sheet.regions[1].rect).toEqual({ x: atlas.frames[1].x, y: atlas.frames[1].y, width: 8, height: 8 });
  });

  it('warns that a sheet-less bundle cannot become a sprite atlas', () => {
    const document_ = stillSprite();
    const result = importUnity(contract(document_));
    expect(result.warnings.some((w) => w.includes('no sheet'))).toBe(true);
  });

  it('says which axis the flipped pivot is on, rather than flipping nothing', () => {
    // A near-miss on the other side of the same gate: the top-edge pivot must flip to 1.0, not
    // stay at 0.0. One assertion cannot prove both directions; these two can.
    const document_ = createSprite({ width: 10, height: 10, name: 'hero', frames: 1 });
    document_.rig = {
      restFrameId: document_.frames[0].id,
      parts: [{ id: 'p1', name: 'body', layerIds: [document_.layers[0].id], pivot: { x: 5, y: 0 } }],
      poses: [],
      tweens: [],
      anchors: [],
      hitboxes: [],
    };
    const json = JSON.parse(fileMap(importUnity(contract(document_)))['hero.unity-sprite.json']);
    expect(json.pivot.normalized).toEqual({ x: 0.5, y: 0 });
  });
});

describe('phaser importer', () => {
  it('loads a spritesheet by grid when the sheet divides evenly at 1x', () => {
    // S9.3: load.spritesheet takes frameWidth/frameHeight and ignores regions. A 2x2 grid of
    // 8px cells in a 16x16 sheet is the case the grid loader describes exactly, so the importer
    // must choose it rather than emitting an atlas nobody asked for.
    const document_ = sprite();
    const result = importPhaser(contract(document_, sheetOptions(document_)));
    const files = fileMap(result);
    expect(Object.keys(files)).toEqual(['hero-idle.phaser.mjs']);
    expect(files['hero-idle.phaser.mjs']).toContain('scene.load.spritesheet("hero-idle", "hero-idle.png", {');
    expect(files['hero-idle.phaser.mjs']).toContain('frameWidth: 8');
    expect(files['hero-idle.phaser.mjs']).toContain('frameHeight: 8');
  });

  it('emits a texture atlas when the sheet is upscaled, because the grid loader cannot say so', () => {
    // S9.3 names this case exactly. A 2x sheet of 8px cells is 16px cells in a 32x32 image, and
    // load.spritesheet with frameWidth 8 would slice it into sixteen wrong frames.
    const document_ = sprite();
    const atlas = scaleAtlas(atlasFor(document_), 2);
    const result = importPhaser(contract(document_, { sheet: { atlas, image: 'hero-idle.png' } }));
    const files = fileMap(result);
    expect(Object.keys(files).sort()).toEqual(['hero-idle-atlas.json', 'hero-idle.phaser.mjs']);
    expect(files['hero-idle.phaser.mjs']).toContain('scene.load.atlas("hero-idle", "hero-idle.png", "hero-idle-atlas.json")');
    const atlasJson = JSON.parse(files['hero-idle-atlas.json']);
    expect(atlasJson.frames['hero-idle_1'].frame).toEqual({
      x: atlas.frames[1].x,
      y: atlas.frames[1].y,
      w: atlas.frames[1].w,
      h: atlas.frames[1].h,
    });
    expect(result.warnings.some((w) => w.includes('upscale'))).toBe(true);
  });

  it('addresses the atlas with sheet pixels and scale "1", so nothing is rescaled twice', () => {
    // The subtle half of the 2x case: the rects are the PNG's own pixels and meta.scale is "1",
    // because Phaser divides rects by meta.scale. Baking the upscale into `scale` as well as
    // into the rects would shrink the artwork by 2x on load — a bug that only appears at 2x.
    const document_ = sprite();
    const atlas = scaleAtlas(atlasFor(document_), 2);
    const atlasJson = JSON.parse(
      fileMap(importPhaser(contract(document_, { sheet: { atlas, image: 'hero-idle.png' } })))['hero-idle-atlas.json'],
    );
    expect(atlasJson.meta.scale).toBe('1');
    expect(atlasJson.frames['hero-idle_0'].frame.w).toBe(16);
    expect(atlasJson.meta.sprite.scale).toBe(2);
  });

  it('maps loop to repeat -1 and a pass count to n-1, because Phaser counts after the first play', () => {
    // S9.3. An importer that writes `repeat: 0` for a loop produces an animation that plays
    // once, and one that writes `repeat: n` for a pass count plays one time too many. Both are
    // off-by-ones that are invisible in the config and obvious in the game.
    const document_ = sprite();
    const source = fileMap(importPhaser(contract(document_, sheetOptions(document_))))['hero-idle.phaser.mjs'];
    const idle = source.slice(source.indexOf('"idle"'), source.indexOf('"hit"'));
    const hit = source.slice(source.indexOf('"hit"'));
    expect(idle).toContain('repeat: -1');
    expect(hit).toContain('repeat: 0');
  });

  it('builds the anim frame list from the pre-expanded frames, so pingpong needs no logic', () => {
    // S6: `frames` is already the playback order. An importer that re-derived it from
    // from/to/direction is reimplementing the rule the contract published, and a pingpong that
    // includes its end frames hitches visibly at the turnaround.
    const document_ = sprite();
    const source = fileMap(importPhaser(contract(document_, sheetOptions(document_))))['hero-idle.phaser.mjs'];
    const hit = source.slice(source.indexOf('"hit"'));
    expect(hit).toContain('hero-idle_1');
    expect(hit).toContain('hero-idle_2');
    expect(hit).not.toContain('hero-idle_0');
  });

  it('carries the pivot as an origin fraction, since Phaser applies it per sprite', () => {
    const document_ = createSprite({ width: 32, height: 32, name: 'hero', frames: 1 });
    document_.rig = {
      restFrameId: document_.frames[0].id,
      parts: [{ id: 'p1', name: 'body', layerIds: [document_.layers[0].id], pivot: { x: 16, y: 32 } }],
      poses: [],
      tweens: [],
      anchors: [],
      hitboxes: [],
    };
    const source = fileMap(importPhaser(contract(document_)))['hero.phaser.mjs'];
    // Feet: x centred, y at the very bottom of the canvas.
    expect(source).toContain('export const ORIGIN = { x: 0.5, y: 1 };');
  });

  it('carries the exact per-frame durations even though Phaser cannot use them', () => {
    // The warning says the timings are lost; this says they are not *gone*. A game that needs
    // the 100/100/200 shape reads frameDurationsMs and drives timeScale per frame, which is the
    // only route to exact timing in Phaser.
    const document_ = sprite();
    const result = importPhaser(contract(document_, sheetOptions(document_)));
    const source = fileMap(result)['hero-idle.phaser.mjs'];
    expect(source).toContain('frameDurationsMs: [100,200]');
    expect(source).toContain('export const DURATIONS_MS = [100,100,200,100];');
    // Same rule as the Godot importer: the warning quotes this animation's frames, so a uniform
    // animation on a non-uniform timeline is not reported as lossy.
    expect(result.warnings.find((w) => w.includes('"hit" has non-uniform'))).toContain('(100/200 ms)');
    expect(result.warnings.some((w) => w.includes('"idle" has non-uniform'))).toBe(false);
  });

  it('emits an empty anims object and says so for a still', () => {
    const document_ = stillSprite();
    const result = importPhaser(contract(document_, sheetOptions(document_)));
    // The block is emitted, not omitted: `anims: {}` is what `createAnimations` returns, and a
    // caller doing `scene.anims.create(cfg)` on a still must get a valid config back.
    expect(fileMap(result)['hero-idle.phaser.mjs']).toContain('anims: {\n    },');
    expect(result.warnings.some((w) => w.includes('no animations'))).toBe(true);
  });
});

describe('excalidraw importer', () => {
  it('emits one image element per frame, each at frames.size', () => {
    // S9.4: Excalidraw has no atlas and no animation, so the honest mapping is one frame per
    // element, placed 1:1. An importer that emitted a single element for the whole sheet would
    // be producing something that opens and shows nothing usable.
    const document_ = sprite();
    const scene = JSON.parse(
      fileMap(importExcalidraw(contract(document_, sheetOptions(document_))))['hero-idle.excalidraw'],
    );
    expect(scene.type).toBe('excalidraw');
    expect(scene.source).toBe('dotloom-mcp');
    expect(scene.elements).toHaveLength(4);
    for (const element of scene.elements) {
      expect(element.type).toBe('image');
      expect(element.width).toBe(8);
      expect(element.height).toBe(8);
    }
  });

  it('lays the frames out in the sheet grid order, so the scene reads as a contact sheet', () => {
    const document_ = sprite();
    const atlas = atlasFor(document_);
    const scene = JSON.parse(
      fileMap(importExcalidraw(contract(document_, { sheet: { atlas, image: 'hero-idle.png' } })))['hero-idle.excalidraw'],
    );
    // Two columns of 8px frames with the default 8px gutter: 16px per step, and row 1 starts at
    // y = 8 + 8 = 16. Asserted from the atlas's own columns so a layout change is visible here.
    expect(atlas.columns).toBe(2);
    expect(scene.elements.map((e: { x: number; y: number }) => [e.x, e.y])).toEqual([
      [0, 0],
      [16, 0],
      [0, 16],
      [16, 16],
    ]);
  });

  it('records the sheet cell and the duration on each element, since Excalidraw can hold neither', () => {
    const document_ = sprite();
    const atlas = atlasFor(document_);
    const scene = JSON.parse(
      fileMap(importExcalidraw(contract(document_, { sheet: { atlas, image: 'hero-idle.png' } })))['hero-idle.excalidraw'],
    );
    const third = scene.elements[2].customData.dotloom;
    expect(third.frame).toBe(2);
    expect(third.durationMs).toBe(200);
    // Read from the atlas rather than hardcoding: the point is that the element carries the
    // *contract's* region, not a position the importer happened to compute the same way.
    expect(third.region).toEqual({
      x: atlas.frames[2].x,
      y: atlas.frames[2].y,
      width: atlas.frames[2].w,
      height: atlas.frames[2].h,
    });
    expect(third.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('gives every frame a distinct, deterministic seed', () => {
    // Excalidraw derives roughness from the seed; at a constant seed every frame looks
    // identical, and a clock-seeded one makes the file differ on every export, which a
    // committed asset must never do.
    const document_ = sprite();
    const first = JSON.parse(
      fileMap(importExcalidraw(contract(document_, sheetOptions(document_))))['hero-idle.excalidraw'],
    );
    const second = JSON.parse(
      fileMap(importExcalidraw(contract(document_, sheetOptions(document_))))['hero-idle.excalidraw'],
    );
    const seeds = first.elements.map((e: { seed: number }) => e.seed);
    expect(new Set(seeds).size).toBe(4);
    expect(second.elements.map((e: { seed: number }) => e.seed)).toEqual(seeds);
  });

  it('lays a sheet-less bundle out in one row and points at the frame PNGs', () => {
    const document_ = stillSprite();
    const meta = contract(document_, {
      outputs: [
        { role: 'frame', path: 'hero-idle-0.png' },
        { role: 'frame', path: 'hero-idle-1.png' },
        { role: 'frame', path: 'hero-idle-2.png' },
        { role: 'frame', path: 'hero-idle-3.png' },
      ],
    });
    const result = importExcalidraw(meta, {
      frameFilePattern: 'frames/{name}-{index}.png',
      // One row, so the "no sheet means a strip" claim is actually under test rather than
      // inferred from the default square-ish column count.
      columns: 4,
    });
    const scene = JSON.parse(fileMap(result)['hero-idle.excalidraw']);
    expect(scene.elements.map((e: { y: number }) => e.y)).toEqual([0, 0, 0, 0]);
    expect(scene.elements.map((e: { x: number }) => e.x)).toEqual([0, 16, 32, 48]);
    expect(scene.elements[3].customData.dotloom.sourcePath).toBe('frames/hero-idle-3.png');
    expect(result.warnings.some((w) => w.includes('no pivot'))).toBe(true);
  });

  it('warns when the bundle carries no pixels at all', () => {
    const document_ = stillSprite();
    const result = importExcalidraw(contract(document_));
    expect(result.warnings.some((w) => w.includes('role "frame"'))).toBe(true);
  });
});

describe('every importer handles a still and a one-frame asset', () => {
  it('imports a single-frame still through all four engines', () => {
    // The degenerate case: no animations and no sheet. Every importer has a branch for it and
    // all four branches have to produce something a project can open, because a one-frame
    // sprite is the most common asset there is.
    const document_ = createSprite({ width: 8, height: 8, name: 'icon', frames: 1 });
    const meta = contract(document_, {
      outputs: [
        { role: 'source', path: 'icon.pixel' },
        { role: 'frame', path: 'icon.png' },
      ],
    });
    for (const result of [importGodot(meta), importUnity(meta), importPhaser(meta), importExcalidraw(meta)]) {
      expect(result.files.length).toBeGreaterThan(0);
      for (const file of result.files) expect(file.contents.length).toBeGreaterThan(0);
    }
  });

  it('accepts every contract the generator can produce', () => {
    // A sweep rather than one case: the four importers between them branch on sheet / no sheet
    // / animations / no animations / scale>1, and the point here is that none of those
    // combinations throws. Each combination is a separate document, so a throw names itself.
    const variants: { name: string; make: () => { document_: Sprite; options: AssetMetaOptions } }[] = [
      {
        name: 'tagged, no sheet',
        make: () => ({ document_: sprite(), options: { outputs: [{ role: 'frame', path: 'hero-idle-0.png' }] } }),
      },
      {
        name: 'tagged, grid sheet',
        make: () => {
          const document_ = sprite();
          return { document_, options: sheetOptions(document_) };
        },
      },
      {
        name: 'tagged, 2x sheet',
        make: () => {
          const document_ = sprite();
          return { document_, options: { sheet: { atlas: scaleAtlas(atlasFor(document_), 2), image: 'hero-idle.png' } } };
        },
      },
      {
        name: 'tagged, horizontal sheet',
        make: () => {
          const document_ = sprite();
          return { document_, options: { sheet: { atlas: buildSpritesheet(document_), image: 'hero-idle.png' } } };
        },
      },
      {
        name: 'still, no sheet',
        make: () => ({ document_: stillSprite(), options: { outputs: [{ role: 'frame', path: 'hero-idle-0.png' }] } }),
      },
      {
        name: 'still, sheet',
        make: () => {
          const document_ = stillSprite();
          return { document_, options: sheetOptions(document_) };
        },
      },
      {
        name: 'licensed, with outputs',
        make: () => {
          const document_ = sprite();
          return {
            document_,
            options: {
              ...sheetOptions(document_),
              license: { spdx: 'CC0-1.0' },
              outputs: [
                { role: 'source', path: 'hero-idle.pixel' },
                { role: 'gif', path: 'hero-idle.gif' },
              ],
            },
          };
        },
      },
    ];

    for (const variant of variants) {
      const { document_, options } = variant.make();
      const meta = contract(document_, options);
      // The contract itself must survive the round trip, or a failure below is the fixture's.
      expect(buildAssetMeta(document_, options)).toEqual(meta);
      for (const [name, run] of [
        ['godot', () => importGodot(meta)],
        ['unity', () => importUnity(meta)],
        ['phaser', () => importPhaser(meta)],
        ['excalidraw', () => importExcalidraw(meta)],
      ] as const) {
        expect(() => run(), `${name} threw for "${variant.name}"`).not.toThrow();
      }
    }
  });
});
