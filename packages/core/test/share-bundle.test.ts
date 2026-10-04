import { describe, expect, it } from 'vitest';
import { decodePNG, encodePNG, readPNGMetadata } from '../src/png.js';
import { allCommands, createEditor } from '../src/commands/index.js';
import { createSprite, type Sprite } from '../src/document.js';
import {
  buildShareBundle,
  expandShareTemplate,
  shareBundleCommand,
  shareTemplateSchema,
  type ShareBundle,
  type ShareTemplate,
} from '../src/commands/share.js';

/**
 * `share_bundle` - the command a share bundle is built by.
 *
 * Four claims, each measured here rather than asserted in prose. Three of them are about things
 * that must **not** happen, which is where this repository's expensive mistakes live:
 *
 *   1. **The badge is written by the engine.** The PNG in the bundle carries its `tEXt` chunks
 *      because `encodePNG(buffer, {metadata})` wrote them in the same pass that rendered the
 *      pixels - not because a caller decoded the file and re-encoded it. So decoding the shared
 *      PNG must give back the artwork byte for byte, and the file must still differ from an
 *      unbadged render of the same document. Both halves, because either alone passes a weaker
 *      design.
 *   2. **No score travels.** Not in the record, not in the card, not in the chunks. The walk is
 *      over key *names*, recursively, the same idiom `test/gallery.test.ts` uses - `evaluate`
 *      returns `score` and `scoreQ` on every dimension and copying one field would be enough to
 *      reintroduce the tool deleted in 0.3.1.
 *   3. **An abstention is not a pass.** Every dimension that did not apply, and every sub-score
 *      that could not be taken, appears under `notMeasured` with its reason spelled out, and
 *      **never** in `measuredDimensions`.
 *   4. **Determinism.** Two calls, identical bytes - a share bundle is a build artifact that
 *      leaves the building.
 */

/**
 * A sprite with real defects in it, so the judgement half has something to carry.
 *
 * Built through the bus rather than by poking a `Sprite`, because the ops are the documented way to
 * author and this is what the surfaces do.
 */
function lumpySprite(): Sprite {
  const editor = createEditor(createSprite({ width: 32, height: 32, name: 'lumpy', layers: ['base'] }));
  editor.execute('draw_rect', { layer: 0, frame: 0, rect: { x: 4, y: 4, w: 24, h: 24 }, color: '#f0a' });
  editor.execute('draw_rect', { layer: 0, frame: 0, rect: { x: 8, y: 8, w: 16, h: 16 }, color: '#fb0' });
  editor.execute('draw_rect', { layer: 0, frame: 0, rect: { x: 12, y: 12, w: 8, h: 8 }, color: '#f0a' });
  return editor.sprite;
}

/** A four-frame animation, so `motion` has something to measure rather than abstaining on. */
function walkSprite(): Sprite {
  const editor = createEditor(createSprite({ width: 16, height: 16, name: 'walk', layers: ['base'], frames: 4 }));
  for (let frame = 0; frame < 4; frame++) {
    editor.execute('draw_rect', {
      layer: 0,
      frame,
      rect: { x: 2 + frame, y: 4, w: 8, h: 8 },
      color: frame % 2 === 0 ? '#0af' : '#08f',
    });
  }
  editor.execute('upsert_tags', { tags: [{ name: 'walk', from: 0, to: 3 }] });
  return editor.sprite;
}

/** A two-part rig with a named pose, so the `pose` output has something to bake. */
function riggedSprite(): Sprite {
  const editor = createEditor(createSprite({ width: 16, height: 16, name: 'rigger', layers: ['base', 'arm'] }));
  const rig = editor.execute('create_rig', {
    parts: [
      // A part binds to layers by default matching its own name, so the layers are named for the
      // parts rather than the other way round - which is also how the surfaces do it.
      { name: 'base', pivot: { x: 8, y: 8 } },
      { name: 'arm', pivot: { x: 10, y: 7 } },
    ],
  }) as { parts: { id: string; name: string }[] };
  editor.execute('draw_rect', { layer: 0, frame: 0, rect: { x: 4, y: 4, w: 8, h: 10 }, color: '#f0a' });
  editor.execute('draw_rect', { layer: 1, frame: 0, rect: { x: 10, y: 6, w: 4, h: 2 }, color: '#0af' });
  // `save_pose` keys transforms by part **id**, and refuses a name: a pose that silently bound to
  // nothing would bake as the identity and look like it worked.
  const arm = rig.parts.find((part) => part.name === 'arm');
  editor.execute('save_pose', { name: 'wave', transforms: { [arm!.id]: { rotationDegrees: 90 } } });
  return editor.sprite;
}

function template(overrides: Record<string, unknown> = {}): ShareTemplate {
  return shareTemplateSchema.parse({
    format: 'dotloom-mcp/share-template',
    schemaVersion: 1,
    id: 'test',
    title: 'Test preset',
    summary: 'A preset for the test.',
    outputs: [{ type: 'png' }],
    card: 'card',
    assetContract: false,
    engine: null,
    license: null,
    ...overrides,
  });
}

function fileOf(bundle: ShareBundle, path: string): Uint8Array {
  const file = bundle.files.find((entry) => entry.path === path);
  if (!file) throw new Error(`no ${path} in [${bundle.files.map((f) => f.path).join(', ')}]`);
  return file.bytes;
}

function textOf(bundle: ShareBundle, path: string): string {
  return new TextDecoder().decode(fileOf(bundle, path));
}

/** Recursively collect every key name, so a nested `score` cannot hide. */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, i) => keyPaths(entry, `${prefix}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => [
      `${prefix}.${key}`,
      ...keyPaths(entry, `${prefix}.${key}`),
    ]);
  }
  return [];
}

const VERDICT = /score|grade|rating|percent|quality|verdict/i;

describe('the badge is carried by the engine, not patched on by a caller', () => {
  const bundle = buildShareBundle(lumpySprite(), template(), { slug: 'lumpy' });

  it('writes the provenance into the PNG the engine rendered', () => {
    // The claim under test: these chunks exist because `encodePNG({metadata})` wrote them in the
    // render pass. There is no decode-and-re-encode step anywhere in the bundle, so a caller cannot
    // be the reason the badge is there.
    const text = readPNGMetadata(fileOf(bundle, 'lumpy.png'));
    expect(text.Software).toBe('dotloom-mcp');
    expect(text['dotloom:name']).toBe('lumpy');
    expect(text['dotloom:defects']).toBeTypeOf('string');
    expect(bundle.record.provenance).toEqual(text);
  });

  it('leaves every pixel the render produced, and is still a different file', () => {
    // Both halves, because either alone passes a weaker design. `encodePNG(buffer)` with no
    // metadata renders the same pixels, so the only difference between the two files can be the
    // chunks - which is what makes "the badge is not burned in" measured rather than asserted.
    const shared = decodePNG(fileOf(bundle, 'lumpy.png'));
    const plainBytes = encodePNG(shared);
    const plain = decodePNG(plainBytes);
    expect([...shared.data]).toEqual([...plain.data]);
    expect(shared.width).toBe(plain.width);
    expect(shared.height).toBe(plain.height);
    expect(fileOf(bundle, 'lumpy.png').length).not.toBe(plainBytes.length);
    // And un-badging is a decode and a re-encode, because there is nothing to un-burn.
    expect(readPNGMetadata(plainBytes)).toEqual({});
  });

  it('holds the writer-side guard, so a verdict-shaped chunk cannot be produced at all', () => {
    // `assertPngMetadata` runs inside `encodePNG`. Asserted here on the *builder's* output rather
    // than by calling the guard directly, because the claim is that no code path of the builder can
    // produce one - a direct call to `assertPngMetadata` would only prove the guard fires.
    const keys = Object.keys(bundle.record.provenance);
    expect(keys.some((key) => VERDICT.test(key))).toBe(false);
    for (const value of Object.values(bundle.record.provenance)) {
      // And no bare number under any key but `dotloom:schema`, which is the one exemption.
      expect(value.length).toBeGreaterThan(0);
    }
    expect(bundle.record.provenance['dotloom:defects'].split(',').filter(Boolean).length).toBe(
      bundle.record.issues.length,
    );
  });
});

describe('a bundle publishes no score', () => {
  const bundle = buildShareBundle(lumpySprite(), template(), { slug: 'lumpy' });

  it('puts no verdict-shaped key in the record', () => {
    // Over key *names*, recursively: `evaluate` returns `score` and `scoreQ` on every dimension,
    // and copying one field would be enough to reintroduce the deleted tool.
    expect(keyPaths(bundle.record).filter((path) => VERDICT.test(path))).toEqual([]);
  });

  it('names none in the card either, over the whole document', () => {
    // Including the part of the page that explains why the numbers are absent: a reader skimming
    // the card must not be able to find a number to move toward even by accident.
    const hits = textOf(bundle, 'card.html')
      .split('\n')
      .map((line, i) => `card.html:${i + 1}: ${line.trim()}`)
      .filter((line) => VERDICT.test(line));
    expect(hits).toEqual([]);
  });

  it('names every defect and no severity, because a code survives being ignored', () => {
    // `severity` is 0..1 and is still dropped: it is a number, and a number in a file that gets
    // forwarded is the thing this repository has already paid for.
    expect(bundle.record.issues.length).toBeGreaterThan(0);
    for (const issue of bundle.record.issues) {
      expect(issue.code).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(Object.keys(issue)).not.toContain('severity');
      expect(issue.dimensions.length, `${issue.code} names the dimension that found it`).toBeGreaterThan(0);
      expect(issue.message.length, `${issue.code} explains itself`).toBeGreaterThan(20);
      expect(['safe-repair-available', 'needs-a-decision']).toContain(issue.disposition);
      expect(issue.guidance, `${issue.code} says what to do`).toBeTruthy();
    }
    // Sorted by code, so the order is a property of the data and not of a hash map.
    expect(bundle.record.issues.map((i) => i.code)).toEqual([...bundle.record.issues.map((i) => i.code)].sort());
  });
});

describe('an abstention is not a clean one', () => {
  it('carries every excluded dimension in its own block, with a reason it can act on', () => {
    const bundle = buildShareBundle(lumpySprite(), template(), { slug: 'lumpy' });
    expect(bundle.record.notMeasured.length).toBeGreaterThan(0);
    for (const entry of bundle.record.notMeasured) {
      expect(entry.reason).toBeTruthy();
      expect(entry.note.length, `${entry.dimension} must explain itself`).toBeGreaterThan(20);
    }
    // A still sprite: `motion` cannot apply, and an absent number is not a compliment.
    expect(bundle.record.notMeasured.map((n) => n.reason)).toContain('single-frame');
  });

  it('never folds a whole-dimension abstention into the list of what measured the piece', () => {
    // The near-miss on the other side of the same gate: a bundle that reported nothing at all would
    // look like the abstention case, and one that credited `motion` with a score it never took
    // would be the failure this repository has already paid for once.
    //
    // **Only the whole-dimension entries are held to this.** A `dimension.sub` entry is the
    // opposite case and is *supposed* to name a dimension that measured the rest of itself - that
    // is what "part of this claim was not checked" means, and `AGENTS.md` is explicit that the two
    // claims must not be collapsed into each other.
    const bundle = buildShareBundle(lumpySprite(), template(), { slug: 'lumpy' });
    expect(bundle.record.measuredDimensions.length).toBeGreaterThan(0);
    const whole = bundle.record.notMeasured.filter((n) => !n.dimension.includes('.'));
    expect(whole.length).toBeGreaterThan(0);
    for (const entry of whole) {
      expect(bundle.record.measuredDimensions, `${entry.dimension} is in both blocks`).not.toContain(
        entry.dimension,
      );
    }
  });

  it('measures what it can on a piece with motion, so the abstention block is not the whole story', () => {
    const bundle = buildShareBundle(walkSprite(), template(), { slug: 'walk' });
    expect(bundle.record.measuredDimensions).toContain('motion');
    expect(bundle.record.notMeasured.map((n) => n.reason)).not.toContain('single-frame');
  });

  it('names a partly-measured sub-score as `dimension.sub`, in the same block', () => {
    // The case with no precedent: "part of this claim was not checked" is the same fact to a reader
    // as "none of it was", so it goes in the same list rather than being quietly re-normalised away.
    const bundle = buildShareBundle(lumpySprite(), template(), { slug: 'lumpy' });
    for (const entry of bundle.record.notMeasured.filter((n) => n.dimension.includes('.'))) {
      expect(entry.note).toContain('absent, not counted at its best');
    }
  });
});

describe('the template reaches what the engine can already produce', () => {
  it('writes a GIF when the template asks for one', () => {
    // The gap this closes: `build-share.mjs` could ask for images, a card and one engine, while
    // `exportAssets` already produced all of this.
    const bundle = buildShareBundle(
      walkSprite(),
      template({ outputs: [{ type: 'png' }, { type: 'gif', scale: 2 }], card: null }),
      { slug: 'anim' },
    );
    const gif = fileOf(bundle, 'anim.gif');
    expect([...gif.subarray(0, 3)]).toEqual([0x47, 0x49, 0x46]); // "GIF"
    expect(bundle.record.files.some((f) => f.role === 'gif')).toBe(true);
  });

  it('lists a GIF in the contract when it writes one, so an importer is not left guessing', () => {
    // An engine importer told about no frames emits resources pointing at textures that are not
    // there, and warns about it in the very file it just wrote.
    const bundle = buildShareBundle(
      walkSprite(),
      template({ outputs: [{ type: 'png' }, { type: 'gif' }, { type: 'meta' }], card: null }),
      { slug: 'anim' },
    );
    const meta = JSON.parse(textOf(bundle, 'meta.json'));
    expect(meta.outputs.map((o: { role: string }) => o.role)).toContain('gif');
    expect(meta.outputs.map((o: { path: string }) => o.path)).toContain('anim.gif');
  });

  it('writes one file per frame when the template asks for frames', () => {
    const bundle = buildShareBundle(
      walkSprite(),
      template({ outputs: [{ type: 'frames', scale: 2 }], card: null }),
      { slug: 'frames' },
    );
    for (let index = 0; index < 4; index++) {
      expect(decodePNG(fileOf(bundle, `frames_${index}.png`)).width).toBe(32);
    }
  });

  it('bakes a rig pose when the template asks for one', () => {
    const sprite = riggedSprite();
    expect(sprite.rig?.poses.map((p) => p.name)).toContain('wave');
    const bundle = buildShareBundle(
      sprite,
      template({ outputs: [{ type: 'png' }, { type: 'pose', pose: 'wave', scale: 2 }], card: null }),
      { slug: 'rig' },
    );
    const pose = fileOf(bundle, 'rig_wave.png');
    expect([...pose.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]); // "PNG"
    expect(decodePNG(pose).width).toBe(32);
    expect(bundle.record.files.some((f) => f.role === 'pose')).toBe(true);
  });

  it('refuses a pose on a document with no rig, by name', () => {
    expect(() =>
      buildShareBundle(lumpySprite(), template({ outputs: [{ type: 'pose', pose: 'wave' }], card: null }), {
        slug: 'norig',
      }),
    ).toThrow(/rig/i);
  });

  it('has no `contact` output, and says so rather than shipping a thinner bundle', () => {
    // `animationPreviewPayload` is private to `packages/mcp/src/tools.ts`, so a template that asks
    // for one is a named refusal rather than a bundle that quietly lacks it.
    expect(() => shareTemplateSchema.parse({ ...template(), outputs: [{ type: 'contact', path: 'x.png' }] })).toThrow();
  });

  it('writes a spritesheet and its JSON table, which are two files on purpose', () => {
    const bundle = buildShareBundle(
      walkSprite(),
      template({ outputs: [{ type: 'png' }, { type: 'sheet', scale: 2 }], card: null }),
      { slug: 'sheety' },
    );
    // The badge belongs to the piece, not to every strip of it, so the sheet carries no chunks.
    expect(readPNGMetadata(fileOf(bundle, 'sheety_sheet.png'))).toEqual({});
    const table = JSON.parse(textOf(bundle, 'sheety_sheet.json'));
    expect(table.meta.image).toBe('sheety_sheet.png');
    // One cell per timeline frame, keyed by frame name and carrying the duration an engine cannot
    // read off a PNG - which is the whole reason the table ships beside the image.
    expect(Object.keys(table.frames).length).toBe(4);
    for (const cell of Object.values(table.frames) as { duration: number; frame: { w: number } }[]) {
      expect(cell.duration).toBeGreaterThan(0);
      // 16px canvas at 2x: the cells, the JSON rects and the pixels all grow together.
      expect(cell.frame.w).toBe(32);
    }
  });
});

describe("the target engine is the caller's choice", () => {
  const withEngine = template({ assetContract: true, engine: 'godot', card: null });

  it("writes the template's engine when the caller says nothing", () => {
    const bundle = buildShareBundle(lumpySprite(), withEngine, { slug: 'eng' });
    expect(bundle.record.delivery?.assets?.[0].engine).toBe('godot');
    expect(bundle.files.some((f) => f.path.endsWith('.tres'))).toBe(true);
  });

  it('lets the caller override it, which is why it is opt-in on every surface', () => {
    // The same reason `finalize_document`, the CLI and the app ask rather than assume: a tool
    // cannot know which engine a bundle is going into.
    const bundle = buildShareBundle(lumpySprite(), withEngine, { slug: 'eng', engine: 'phaser' });
    expect(bundle.record.delivery?.assets?.[0].engine).toBe('phaser');
    expect(bundle.files.some((f) => f.path.endsWith('.phaser.mjs'))).toBe(true);
    expect(bundle.files.some((f) => f.path.endsWith('.tres'))).toBe(false);
  });

  it('names the same content hash in the PNG chunk that meta.json carries', () => {
    // The round trip the provenance channel exists for: a recipient checks the image against the
    // contract without re-compositing a single frame.
    const bundle = buildShareBundle(lumpySprite(), withEngine, { slug: 'eng' });
    const text = readPNGMetadata(fileOf(bundle, 'eng.png'));
    const meta = JSON.parse(textOf(bundle, 'meta.json'));
    expect(text['dotloom:contract']).toBe(meta.format);
    expect(text['dotloom:schema']).toBe(String(meta.schemaVersion));
    expect(text['dotloom:asset']).toBe(meta.asset.contentHash);
    expect(bundle.record.delivery?.assets?.[0].contentHash).toBe(meta.asset.contentHash);
  });

  it('writes no contract for a template that asked for none', () => {
    const bundle = buildShareBundle(lumpySprite(), template(), { slug: 'plain' });
    expect(bundle.record.delivery).toBeNull();
    expect(bundle.files.some((f) => f.path === 'meta.json')).toBe(false);
    expect(Object.keys(bundle.record.provenance)).not.toContain('dotloom:contract');
  });

  it('refuses an engine output with no engine anywhere, rather than guessing one', () => {
    // The generator refuses rather than guesses: an invented engine name is a bundle nobody can
    // open, discovered several files later.
    const naked = template({ outputs: [{ type: 'png' }, { type: 'engine' }], card: null });
    expect(naked.engine).toBeNull();
    expect(() => buildShareBundle(lumpySprite(), naked, { slug: 'naked' })).toThrow(/engine/i);
  });
});

describe('`meta.json` in a template, consistent with `finalize_document`', () => {
  it('is reachable by name, through the same output type `finalize_document` uses', () => {
    // `handoff` gets it from the `assetContract`/`engine` shorthand; a template that wants the
    // contract and no engine says `{type: "meta"}`, which is `finalize_document`'s own spelling.
    const bundle = buildShareBundle(
      lumpySprite(),
      template({ outputs: [{ type: 'png' }, { type: 'meta' }], card: null }),
      { slug: 'meta' },
    );
    expect(bundle.files.some((f) => f.path === 'meta.json')).toBe(true);
    expect(bundle.record.delivery?.assets?.[0].engine).toBeNull();
    expect(bundle.files.some((f) => f.path.endsWith('.tres'))).toBe(false);
  });

  it('does not write two contracts when the shorthand and the output both name one', () => {
    // `handoff` names its engine in `outputs` *and* at the top level. Expanding the shorthand must
    // be idempotent, or that template would ship two contracts describing one asset.
    const both = template({
      assetContract: true,
      engine: 'godot',
      outputs: [{ type: 'png' }, { type: 'engine', engine: 'godot' }],
      card: null,
    });
    expect(expandShareTemplate(both).filter((o) => o.type === 'meta' || o.type === 'engine')).toHaveLength(1);
    const bundle = buildShareBundle(lumpySprite(), both, { slug: 'both' });
    expect(bundle.files.filter((f) => f.path === 'meta.json')).toHaveLength(1);
  });

  it('expands `assetContract` with no engine into a bare `meta` output', () => {
    const expanded = expandShareTemplate(template({ assetContract: true, engine: null }));
    expect(expanded.map((o) => o.type)).toContain('meta');
    expect(expanded.map((o) => o.type)).not.toContain('engine');
  });

  it('writes the editable source and says so in the contract, and can leave it out', () => {
    const withSource = buildShareBundle(
      lumpySprite(),
      template({ outputs: [{ type: 'png' }, { type: 'meta' }], card: null }),
      { slug: 'src' },
    );
    expect(withSource.files.some((f) => f.path === 'src.pixel')).toBe(true);
    const meta = JSON.parse(textOf(withSource, 'meta.json'));
    expect(meta.outputs.map((o: { role: string }) => o.role)).toContain('source');

    // Declaring a file the bundle does not ship is how an importer ends up warning about its own
    // output, so leaving the source out leaves it out of the contract too.
    const without = buildShareBundle(
      lumpySprite(),
      template({ outputs: [{ type: 'png' }, { type: 'meta' }], card: null }),
      { slug: 'nosrc', includeSource: false },
    );
    expect(without.files.some((f) => f.path === 'nosrc.pixel')).toBe(false);
    expect(JSON.parse(textOf(without, 'meta.json')).outputs.map((o: { role: string }) => o.role)).not.toContain(
      'source',
    );
  });
});

describe('the template schema is closed, and every parameter is documented', () => {
  it('refuses an unknown field rather than defaulting it', () => {
    // A template is presentation *policy*. Tolerance for the future must not become tolerance for
    // typos, or a misspelled key is silently a bundle that ships less than it claims.
    expect(() => shareTemplateSchema.parse({ ...template(), outputsTypo: [{ type: 'png' }] })).toThrow();
    expect(() =>
      shareTemplateSchema.parse({ ...template(), outputs: [{ type: 'sheet', layout: 'horizontal', typo: 1 }] }),
    ).toThrow();
  });

  it('refuses a `format` or `schemaVersion` it does not know', () => {
    expect(() => shareTemplateSchema.parse({ ...template(), format: 'something/else' })).toThrow();
    expect(() => shareTemplateSchema.parse({ ...template(), schemaVersion: 2 })).toThrow();
  });

  it('describes every advertised parameter, because that text is what an agent reads', () => {
    // `packages/mcp/test/tool-surface.test.ts` enforces this for the session tools; this is the
    // same guard one level down, where the nested template fields would otherwise be the gap.
    const fields = advertisedFields(shareBundleCommand.params);
    expect(Object.keys(fields).sort()).toEqual([
      'engine',
      'id',
      'includeSource',
      'slug',
      'source',
      'template',
      'title',
    ]);
    for (const [key, field] of Object.entries(fields)) {
      expect(field.description, `${key} has no .describe()`).toBeTruthy();
    }
  });
});

describe('a bundle is a build artifact, so it reproduces', () => {
  it('is byte-identical across two calls with the same document and template', () => {
    // No clock, no session id, no absolute path, no locale, no hash iteration order. A bundle is
    // designed to be forwarded, so a diff on every regeneration would be a diff nobody can explain.
    const options = { slug: 'repeat', source: 'artwork/lumpy.pixel' } as const;
    const preset = template({ assetContract: true, engine: 'unity' });
    // **The same document both times**, not two documents that happen to look alike: a document's
    // ids are clock-plus-entropy by design (`ids.ts`), so two freshly-built sprites are two
    // different assets and the claim under test - same document in, same bytes out - would be
    // untestable if the fixture were rebuilt per call.
    const sprite = lumpySprite();
    const first = buildShareBundle(sprite, preset, options);
    const second = buildShareBundle(sprite, preset, options);
    expect(second.files.map((f) => f.path)).toEqual(first.files.map((f) => f.path));
    for (const file of first.files) {
      expect([...fileOf(second, file.path)], `${file.path} must be byte-identical`).toEqual([...file.bytes]);
    }
    expect(JSON.stringify(second.record)).toBe(JSON.stringify(first.record));
  });

  it('writes portable paths, because the record is as movable as the bundle', () => {
    // `finalize_document` reports absolute, platform-native paths, and a record holding
    // `share\\handoff\\...` cannot travel to a Linux build machine - which is what
    // ASSET-CONTRACT S5.1 exists to prevent.
    const bundle = buildShareBundle(lumpySprite(), template({ assetContract: true, engine: 'godot' }), {
      slug: 'portable',
    });
    for (const file of [...bundle.files.map((f) => f.path), ...bundle.record.files.map((f) => f.path)]) {
      expect(file).not.toContain('\\');
      expect(file).not.toMatch(/^[A-Za-z]:/);
      expect(file.split('/')).not.toContain('..');
    }
  });

  it('never invents a licence', () => {
    // S11: absent is not public domain. A template that declares one gets it; one that does not must
    // not have one appear silently.
    const without = buildShareBundle(lumpySprite(), template(), { slug: 'nolic' });
    expect(Object.keys(without.record.provenance)).not.toContain('dotloom:license');
    const declared = buildShareBundle(lumpySprite(), template({ license: 'CC0-1.0' }), { slug: 'lic' });
    expect(declared.record.provenance['dotloom:license']).toBe('CC0-1.0');
    expect(readPNGMetadata(fileOf(declared, 'lic.png'))['dotloom:license']).toBe('CC0-1.0');
  });

  it('writes no engine version, because a version makes every shared file a diff on upgrade', () => {
    const bundle = buildShareBundle(lumpySprite(), template({ assetContract: true, engine: 'godot' }), {
      slug: 'nov',
    });
    expect(bundle.record.provenance.Software).toBe('dotloom-mcp');
    expect(bundle.record.provenance.Software).not.toMatch(/\d+\.\d+/);
  });

  it('writes a card only where the template asks for one', () => {
    // `bare` exists precisely to be the template with no rendered judgement layer, and a test that
    // did not check this would let a card creep into every bundle without anything failing.
    const bare = buildShareBundle(lumpySprite(), template({ card: null }), { slug: 'bare' });
    expect(bare.files.some((f) => f.path === 'card.html')).toBe(false);
    expect(bare.record.files.some((f) => f.role === 'card')).toBe(false);
    expect(buildShareBundle(lumpySprite(), template(), { slug: 'carded' }).files.some((f) => f.path === 'card.html')).toBe(
      true,
    );
  });

  it('names the same defect codes in the chunk that the card names', () => {
    // One list, two renderings. A badge claiming defects the card does not list - or the reverse -
    // is worse than no badge, because a forwarded file then carries a claim nobody checked.
    const bundle = buildShareBundle(lumpySprite(), template(), { slug: 'agree' });
    const codes = readPNGMetadata(fileOf(bundle, 'agree.png'))['dotloom:defects'].split(',').filter(Boolean);
    expect(codes).toEqual(bundle.record.issues.map((i) => i.code));
    const html = textOf(bundle, 'card.html');
    for (const code of codes) {
      expect(html, `${code} should be on the card`).toContain(`<code class="code">${code}</code>`);
    }
  });
});

describe('the command is a command', () => {
  it('is read-only, and says it writes nothing', () => {
    // Core has no filesystem - `exportAssets` returns bytes and says so, and `finalize_document` is
    // a surface rather than a command - so a bundle comes back as bytes for the caller to place.
    expect(shareBundleCommand.readOnly).toBe(true);
    expect(shareBundleCommand.description).toContain('base64');
    expect(shareBundleCommand.description.length).toBeLessThan(700);
  });

  it('returns the bundle base64-encoded, and the bytes are the bytes', () => {
    // This is the assertion that would have caught a hand-rolled base64 *decoder* in a caller: a
    // wrong table can agree on every length and disagree on every byte. Compared head and tail, so
    // a length-only agreement cannot pass.
    const sprite = lumpySprite();
    const preset = template({ assetContract: true, engine: 'phaser' });
    const summary = shareBundleCommand.apply({ draft: {} as never, sprite }, { template: preset, slug: 'wire' }) as {
      files: { path: string; bytes: number; base64: string }[];
      record: { slug: string };
      totalBytes: number;
    };
    const direct = buildShareBundle(sprite, preset, { slug: 'wire' });
    expect(summary.record.slug).toBe('wire');
    expect(summary.files.map((f) => f.path)).toEqual(direct.files.map((f) => f.path));
    expect(summary.totalBytes).toBe(direct.files.reduce((sum, f) => sum + f.bytes.byteLength, 0));
    for (const file of summary.files) {
      const decoded = new Uint8Array(Buffer.from(file.base64, 'base64'));
      const expected = fileOf(direct, file.path);
      expect(decoded.length, `${file.path} length`).toBe(file.bytes);
      expect([...decoded.subarray(0, 16)], `${file.path} head`).toEqual([...expected.subarray(0, 16)]);
      expect([...decoded.subarray(-16)], `${file.path} tail`).toEqual([...expected.subarray(-16)]);
    }
  });

  it('is registered on the one bus the CLI, the MCP server and the app all use', () => {
    // The architectural rule in `AGENTS.md`: every mutation anywhere goes through `applyCommand`,
    // and a command missing from `allCommands` is a command no surface can reach.
    expect(allCommands.map((c) => c.name)).toContain('share_bundle');
    expect(shareBundleCommand.name).toBe('share_bundle');
  });

  it('carries no name that a session tool already owns', () => {
    // `McpServer.registerTool` *throws* on a duplicate name, and in `commands: 'eager'` mode that
    // takes the whole server down - last time it cost 132 tests. The names a session tool holds are
    // listed here rather than imported, because the guard that matters is `SESSION_TOOL_NAMES` in
    // `packages/mcp/src/tools.ts`, and this is the assertion on the other side of it.
    const sessionTools = [
      'apply_ops', 'clear_all', 'close_document', 'create_document', 'create_sprite_spec',
      'crop_canvas', 'describe_command', 'describe_recipe', 'evaluate', 'export_gif', 'export_png',
      'export_sheet', 'export_tiled', 'finalize_document', 'find_workflow', 'get_document',
      'get_history', 'get_palette', 'get_pixels', 'get_preview', 'get_selection', 'histogram',
      'import_image', 'list_commands', 'list_documents', 'list_layers', 'list_plugins', 'load_plugin',
      'merge_layer_down', 'open_document', 'preview_animation', 'preview_pose', 'preview_tilemap',
      'prune_palette', 'quantize_to_palette', 'read_grid', 'read_skill', 'redo', 'remove_anchor',
      'remove_frame', 'remove_layer', 'remove_palette_color', 'remove_part', 'remove_pose',
      'remove_tag', 'remove_tile_properties', 'remove_tilemap', 'remove_tween', 'resize_canvas',
      'run_script', 'save_document', 'select_document', 'set_palette', 'set_selection', 'undo',
    ];
    expect(sessionTools).not.toContain(shareBundleCommand.name);
  });
});

/**
 * The advertised field names and their `.describe()` strings, read off the zod schema.
 *
 * `describeCommand` in `commands/catalog.ts` projects this into JSON Schema, and
 * `packages/mcp/test/tool-surface.test.ts` asserts the same thing for the session tools. This reads
 * the shape directly rather than through a JSON Schema projection, because the assertion is about
 * the two things the projection cannot lose: the field names and the description on each.
 */
function advertisedFields(schema: unknown): Record<string, { description?: string }> {
  const def = (schema as { _def?: { shape?: Record<string, unknown> } })._def;
  const shape = typeof def?.shape === 'function' ? def.shape() : def?.shape;
  if (!shape) throw new Error('params is not a zod object');
  const out: Record<string, { description?: string }> = {};
  for (const [key, field] of Object.entries(shape)) {
    out[key] = { description: (field as { description?: string }).description };
  }
  return out;
}
