import { describe, expect, it } from 'vitest';
import { buildCase, readCorpusSpec } from '../../../benchmarks/corpus/build.js';
import { PixelBuffer } from '../src/buffer.js';
import { createSprite, type Sprite } from '../src/document.js';
import { allCommands, createEditor, defaultRegistry } from '../src/commands/index.js';
import {
  dedupeQualityFixOps,
  planQualityFix,
  QUALITY_FIX_ADVICE,
  type QualityFixOp,
  type QualityFixPlan,
} from '../src/commands/quality.js';
import type { QualityIssue } from '../src/quality/types.js';

/**
 * T-023: issues become executable ops, or an honest statement that they cannot.
 *
 * The rule this file exists to hold is the one architectural rule in this repository: every
 * mutation goes through `applyCommand` on the shared bus, because that is what makes undo/redo,
 * replay and the tool surface agree. A `fix` that wrote pixels itself would satisfy every
 * assertion in this file except the one that matters — the one that checks nothing happened until
 * the caller applied the plan. So the tests are built around that:
 *
 *   1. **`fix` does not execute.** No version bump, no undo entry, the same issues afterwards. The
 *      plan is data. Applying it through the bus is what costs exactly one undo step.
 *   2. **`rect: null` says so.** §3.5's `null` means the defect is not localisable, and §8.2 says a
 *      whole-canvas rect where 3x3 is wrong is "a report nobody can act on". So the plan states
 *      the absence in words instead of inventing a box.
 *   3. **Three codes have a repair, and each is measured rather than argued.**
 *      `near-duplicate-colours` -> `quantize_to_palette`, and the test that matters is the
 *      end-to-end one: a sprite whose near-duplicate pair is off-palette actually loses the
 *      issue when the plan is applied. `off-palette` and `muddy-mix` get the same op because
 *      §4.3 counts `muddy` over *off-palette* pixels, so §7.3's mitigation covers it verbatim.
 *      A mapping that is merely *returned* is a mapping that has never been shown to work — and
 *      the fixture decides whether the test proves anything: `quantize_to_palette` changes **0
 *      bytes** on `defect/near-duplicate-ramp-16`, because both swatches are already nearest to
 *      their own pixels, so every end-to-end test here runs on a case where it is not a no-op.
 *   4. **The rest decline.** `despeckle` would answer `isolated-pixels` and would equally answer
 *      "the artist meant that one pixel", and §7.6 documents `noise` as the dimension most likely
 *      to sand a piece flat. Those codes return no op and say what a person has to do. Three of
 *      `palette`'s codes decline for a flatter reason still: every colour they object to is
 *      *already declared*, so there is nothing for a snapping op to move — measured on their own
 *      fixtures, where the op changes nothing and the code survives.
 *   5. **An unknown code is a normal outcome.** §8.3 makes `code` an open string so a minor
 *      version may add one, so the fallback has to decline rather than throw — and the corpus-wide
 *      test keeps a *new* code from shipping without advice.
 */

const SPEC = readCorpusSpec();

function corpus(id: string): Sprite {
  const entry = SPEC.cases.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`the corpus has no case "${id}"`);
  const sprite = buildCase(entry);
  if (sprite === null) throw new Error(`the corpus case "${id}" is not buildable`);
  return sprite;
}

/**
 * A sprite with one near-duplicate pair, one of which is **off-palette**.
 *
 * `defect/near-duplicate-ramp-16` is the corpus's own case for this code, and it puts both halves of
 * the pair on its declared palette — at which point `quantize_to_palette` is provably a no-op,
 * because every pixel is already at distance zero from its own swatch. That is a real limit of the
 * repair and the guidance says so. This fixture is the case the repair actually exists for: the
 * pair is what §7.3 calls a translucent or generated colour that composites into a colour no
 * palette declares, and snapping it is exactly the merge `noise` is reporting.
 */
function offPaletteNearDuplicate(): Sprite {
  const sprite = createSprite({ width: 20, height: 20, frames: 1, name: 'near-duplicate' });
  const layer = sprite.layers[0].id;
  sprite.palette.colors = [
    { r: 0x3a, g: 0x5a, b: 0x7a, a: 255 },
    { r: 0xc8, g: 0xc0, b: 0xb0, a: 255 },
    { r: 0x8a, g: 0x70, b: 0x50, a: 255 },
    { r: 0xf0, g: 0xf0, b: 0xf0, a: 255 },
  ];
  // Four vertical bands inside a 12x12 block, so the subject is one connected mass with a 4px
  // margin on every side and `silhouette` applies rather than abstaining.
  const bands = [
    { r: 0x3a, g: 0x5a, b: 0x7a }, // on palette
    { r: 0x42, g: 0x5a, b: 0x82 }, // 8 per channel from the band beside it, and NOT on palette
    { r: 0xc8, g: 0xc0, b: 0xb0 },
    { r: 0x8a, g: 0x70, b: 0x50 },
  ];
  const cel = new PixelBuffer(20, 20);
  for (let y = 4; y < 16; y++) {
    for (let x = 4; x < 16; x++) {
      const band = bands[Math.floor((x - 4) / 3)]!;
      const i = cel.index(x, y);
      cel.data[i] = band.r;
      cel.data[i + 1] = band.g;
      cel.data[i + 2] = band.b;
      cel.data[i + 3] = 255;
    }
  }
  sprite.frames[0].cels.set(layer, cel);
  return sprite;
}

interface FixSummary {
  frames: string[];
  tag: string | null;
  plans: QualityFixPlan[];
  ops: QualityFixOp[];
  withOps: number;
  manual: number;
}

function fix(sprite: Sprite, params: Record<string, unknown> = {}): FixSummary {
  return createEditor(sprite).execute('fix', params) as unknown as FixSummary;
}

function codesOf(summary: FixSummary): string[] {
  return summary.plans.map((plan) => plan.code);
}

const issue = (over: Partial<QualityIssue> = {}): QualityIssue => ({
  code: 'loop-seam-pop',
  message: 'the loop seam jumps',
  rect: null,
  severity: 0.55,
  ...over,
});

/* ------------------------------------------------------------------ *
 * The plan is data
 * ------------------------------------------------------------------ */

describe('fix returns a plan and executes none of it', () => {
  it('answers without touching the document, the version or the history', () => {
    const editor = createEditor(corpus('defect/near-duplicate-ramp-16'));
    const version = editor.version;
    const summary = editor.execute('fix') as unknown as FixSummary;
    expect(summary.plans.length).toBeGreaterThan(0);
    // The whole point. A `fix` that wrote pixels itself would satisfy every other assertion in
    // this file and still be a second undo history.
    expect(editor.version).toBe(version);
    expect(editor.state.undoStack).toHaveLength(0);
    expect(editor.canUndo()).toBe(false);
  });

  it('leaves the document measuring exactly as it did', () => {
    const editor = createEditor(corpus('defect/near-duplicate-ramp-16'));
    const before = editor.execute('evaluate') as { issues: Array<{ code: string }> };
    editor.execute('fix', { codes: ['near-duplicate-colours'] });
    const after = editor.execute('evaluate') as { issues: Array<{ code: string }> };
    expect(after.issues.map((issue) => issue.code)).toEqual(before.issues.map((issue) => issue.code));
  });

  it('applies as one undo step through the bus, and the ops are runnable commands', () => {
    const editor = createEditor(corpus('defect/near-duplicate-ramp-16'));
    const version = editor.version;
    const summary = editor.execute('fix', {
      codes: ['near-duplicate-colours'],
    }) as unknown as FixSummary;
    expect(summary.ops).toHaveLength(1);
    for (const op of summary.ops) {
      // Not just a name that sounds like a command: it is in the registry, and running it moves
      // the document exactly one version, which is what "through the bus" means.
      expect(defaultRegistry.get(op.command), `${op.command} is not a command`).toBeDefined();
      editor.execute(op.command, op.params);
    }
    expect(editor.version).toBe(version + 1);
    expect(editor.history().map((entry) => entry.command)).toEqual(['quantize_to_palette']);
    expect(editor.canUndo()).toBe(true);
  });

  it('is registered and read-only, like the other two', () => {
    expect(allCommands.map((command) => command.name)).toContain('fix');
    expect(defaultRegistry.get('fix')?.readOnly).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * The one unambiguous repair
 * ------------------------------------------------------------------ */

describe('near-duplicate-colours has one correct repair and it works', () => {
  it('plans quantize_to_palette, and applying it clears the issue', () => {
    const editor = createEditor(offPaletteNearDuplicate());
    const before = editor.execute('evaluate') as { issues: Array<{ code: string }> };
    expect(before.issues.map((entry) => entry.code)).toContain('near-duplicate-colours');

    const summary = editor.execute('fix', { codes: ['near-duplicate-colours'] }) as unknown as FixSummary;
    expect(summary.plans).toHaveLength(1);
    expect(summary.plans[0].fix).toBe('ops');
    expect(summary.plans[0].ops).toEqual([{ command: 'quantize_to_palette', params: {} }]);

    for (const op of summary.ops) editor.execute(op.command, op.params);
    // The end-to-end claim, and the reason the mapping exists at all: the repair has to be shown
    // to remove the thing it repairs. A fixture whose pair was already on-palette would pass this
    // test vacuously, which is why the fixture's second swatch is deliberately off-palette.
    const after = editor.execute('evaluate') as { issues: Array<{ code: string }> };
    expect(after.issues.map((entry) => entry.code)).not.toContain('near-duplicate-colours');
  });

  it('says when the repair cannot help, rather than promising it always works', () => {
    // The honest limit: on a document already snapped to its own palette every pixel is at
    // distance zero from its swatch, so snapping again moves nothing and the pair has to be merged
    // on the palette instead. The guidance has to say that, because the op is still returned.
    const plan = fix(corpus('defect/near-duplicate-ramp-16'), {
      codes: ['near-duplicate-colours'],
    }).plans[0];
    expect(plan.fix).toBe('ops');
    expect(plan.guidance).toContain('no-op');
    expect(plan.guidance).toContain('prune_palette');
  });

  it('deduplicates the whole-document op when two codes imply the same repair', () => {
    const ops = dedupeQualityFixOps([
      { command: 'quantize_to_palette', params: {} },
      { command: 'quantize_to_palette', params: {} },
      { command: 'despeckle', params: { layer: 'base' } },
      { command: 'despeckle', params: { layer: 'base' } },
    ]);
    // Two issues routinely imply one whole-document operation, and running it twice is wasted work
    // in an undo stack. The order is by command then params so two plans diff.
    expect(ops).toEqual([
      { command: 'despeckle', params: { layer: 'base' } },
      { command: 'quantize_to_palette', params: {} },
    ]);
  });

  it('reports how much of the plan is automatic and how much is a person', () => {
    const summary = fix(corpus('defect/near-duplicate-ramp-16'));
    expect(summary.withOps).toBe(1);
    expect(summary.manual).toBe(summary.plans.length - 1);
    expect(summary.ops).toHaveLength(summary.withOps);
  });
});

/* ------------------------------------------------------------------ *
 * `palette`'s undeclared-colour codes
 * ------------------------------------------------------------------ */

describe('the two undeclared-colour codes that get a repair, and that it works', () => {
  it('clears `off-palette` end to end, on the case §7.3 is about', () => {
    // `defect/off-palette-over-skin-32` is 144 of 576 pixels at `#9c9c36` where the declared
    // swatch is `#a0a030` — four per channel, a snapping miss — and it blocks at 550. The
    // fixture matters for the reason this file's header states: `quantize_to_palette` is a no-op
    // on `defect/near-duplicate-ramp-16`, so a test on the obvious fixture would pass vacuously.
    // Here it moves pixels, so the end-to-end claim is real.
    const editor = createEditor(corpus('defect/off-palette-over-skin-32'));
    const before = editor.execute('evaluate') as { issues: Array<{ code: string; blocking: boolean }> };
    expect(before.issues.map((entry) => entry.code)).toEqual(['off-palette']);
    expect(before.issues[0].blocking).toBe(true);

    const summary = editor.execute('fix', { codes: ['off-palette'] }) as unknown as FixSummary;
    expect(summary.plans[0].fix).toBe('ops');
    expect(summary.ops).toEqual([{ command: 'quantize_to_palette', params: {} }]);
    const version = editor.version;
    for (const op of summary.ops) editor.execute(op.command, op.params);

    const after = editor.execute('evaluate') as { issues: Array<{ code: string }> };
    expect(after.issues.map((entry) => entry.code)).toEqual([]);
    // One undo step for the whole repair, which is the reason `fix` returns ops rather than
    // running them.
    expect(editor.history().map((entry) => entry.command)).toEqual(['quantize_to_palette']);
    expect(editor.version).toBe(version + 1);
  });

  it('clears `muddy-mix` end to end, and shares one op with the code that always fires beside it', () => {
    // **§4.3 makes this one automatic in a way worth stating.** `muddy` is counted over
    // **off-palette pixels only**, so a muddy pixel is by definition an undeclared one and §7.3's
    // mitigation covers it verbatim — the same call, for the same reason. It also means
    // `off-palette` always co-fires (its trigger is 20 per-mille over a quantity `muddy-mix`'s is
    // a subset of, and `muddy-mix`'s is 50), so the two plans have to deduplicate to one op
    // rather than queue the same call twice.
    const editor = createEditor(corpus('defect/muddy-over-skin-32'));
    const before = editor.execute('evaluate') as { issues: Array<{ code: string }> };
    expect(before.issues.map((entry) => entry.code).sort()).toEqual(['muddy-mix', 'off-palette']);

    const summary = editor.execute('fix') as unknown as FixSummary;
    expect(summary.ops).toEqual([{ command: 'quantize_to_palette', params: {} }]);
    const muddy = summary.plans.find((plan) => plan.code === 'muddy-mix');
    expect(muddy?.fix, 'a plan saying `manual` while its repair sits in the same result is unusable').toBe('ops');
    // §7.3's caveat is carried into the guidance rather than assumed: a translucent layer is the
    // most likely false positive here, and an agent that does not know that will quantize it away.
    expect(muddy?.guidance).toContain('§7.3');
    expect(muddy?.guidance).toMatch(/translucent/i);

    for (const op of summary.ops) editor.execute(op.command, op.params);
    const after = editor.execute('evaluate') as { issues: Array<{ code: string }> };
    expect(after.issues.map((entry) => entry.code)).toEqual([]);
    // And the dimension itself comes back, not just the codes: 750 -> 1000.
    expect((after as { dimensions: Record<string, { scoreQ: number }> }).dimensions.palette.scoreQ).toBe(1000);
  });
});

/* ------------------------------------------------------------------ *
 * rect: null is a statement, not a gap
 * ------------------------------------------------------------------ */

describe('an unlocalisable issue names no region instead of getting one invented', () => {
  it('keeps the rect null and says so in the guidance', () => {
    const summary = fix(corpus('defect/near-duplicate-ramp-16'), {
      codes: ['near-duplicate-colours'],
    });
    const plan = summary.plans[0];
    // The pair is a fact about the palette, not a place on the canvas. A bounding box here would
    // be the whole sprite, and an op aimed at the whole sprite is not advice.
    expect(plan.rect).toBeNull();
    expect(plan.guidance).toContain('names no region');
  });

  it('says it for the speck codes too, which is where it matters most', () => {
    for (const code of ['isolated-pixels', 'diagonal-seam', 'stray-colour', 'single-pixel-spur']) {
      const advice = QUALITY_FIX_ADVICE[code];
      expect(advice, `${code} has no advice`).toBeDefined();
      expect(advice!.noRegion, `${code} does not explain its absent rect`).toBeTruthy();
      // Every null-rect plan opens with the same sentence, whichever code it is, because the
      // absence is the same fact and an agent should be able to rely on the wording.
      const plan = planQualityFix(issue({ code, rect: null }), 'noise');
      expect(plan.guidance.startsWith(advice!.noRegion!)).toBe(true);
      expect(plan.guidance).toContain('names no region');
    }
  });

  it('points at the region when the analyzer could localise one', () => {
    const rect = { x: 4, y: 6, w: 3, h: 2 };
    const plan = planQualityFix(issue({ code: 'interior-hole', rect, severity: 0.4 }), 'silhouette');
    expect(plan.rect).toEqual(rect);
    // Not a copy of the data — the region is restated in words, because `guidance` is what a
    // person reads and `rect` is what an op would be built from.
    expect(plan.guidance).toContain('3x2 at (4, 6)');
    expect(plan.guidance).not.toContain('names no region');
  });
});

/* ------------------------------------------------------------------ *
 * Everything else declines
 * ------------------------------------------------------------------ */

describe('a code with no safe repair says what a person has to do', () => {
  it('returns no op for a code whose repair would be a guess', () => {
    const summary = fix(corpus('defect/interior-hole-speck-24'), { codes: ['interior-hole'] });
    const plan = summary.plans[0];
    expect(plan.fix).toBe('manual');
    expect(plan.ops).toEqual([]);
    // A hole is a see-through pixel, and whether that is a mistake or a handle is not something
    // any threshold can answer — so the guidance names the decision rather than picking a colour.
    expect(plan.guidance.length).toBeGreaterThan(40);
    expect(plan.guidance.toLowerCase()).toContain('hole');
  });

  it('declines on the speck codes even though despeckle exists', () => {
    for (const code of ['isolated-pixels', 'diagonal-seam', 'stray-colour', 'single-pixel-spur']) {
      const plan = planQualityFix(issue({ code, severity: 0.4 }), 'noise');
      expect(plan.fix, `${code} guessed an op`).toBe('manual');
      expect(plan.ops, `${code} invented an op`).toEqual([]);
      expect(plan.guidance.length).toBeGreaterThan(40);
    }
  });

  it('declines on every code in the pipeline that is not the documented repair', () => {
    // The three codes with a machine repair, and the reason each one earned it separately:
    // `near-duplicate-colours` because the pair has one destination, and `off-palette` and
    // `muddy-mix` because §4.3 counts `muddy` over *off-palette* pixels, so §7.3's documented
    // mitigation for an undeclared colour covers it verbatim. Nothing else has one.
    const automatic = new Set(['near-duplicate-colours', 'off-palette', 'muddy-mix']);
    for (const [code, advice] of Object.entries(QUALITY_FIX_ADVICE)) {
      expect(advice.guidance.length, `${code} has no guidance`).toBeGreaterThan(20);
      // Kebab-case and British spelling in prose-facing codes, per §8.2.
      expect(code, `${code} is not kebab-case`).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(Boolean(advice.ops ?? false), `${code} should not have ops`).toBe(automatic.has(code));
    }
  });

  it('declines on a declared colour it is unhappy about, because nothing can snap it', () => {
    // **`palette` splits its six codes by one question: is the offending colour declared?**
    //
    //   declared   -> `colour-budget-exceeded`, `hue-sprawl`, `grey-colours`. Every colour they
    //                 are counting or averaging is already a palette entry, so `quantize_to_palette`
    //                 has nowhere to move it. Measured, not asserted: on each of the corpus's own
    //                 fixtures that op changes **0 bytes** and the code survives it, which is why
    //                 these three are `manual` rather than handed an op that would do nothing.
    //   undeclared -> `off-palette`, `muddy-mix`, `invented-colours`. §7.3 names one mitigation.
    //                 The first two get it; the third does not, and the next test says why.
    const measured = [
      { id: 'defect/colour-budget-32', code: 'colour-budget-exceeded' },
      { id: 'defect/hue-sprawl-32', code: 'hue-sprawl' },
      { id: 'defect/grey-washed-hues-32', code: 'grey-colours' },
    ];
    for (const { id, code } of measured) {
      const editor = createEditor(corpus(id));
      const before = editor.execute('evaluate') as { issues: Array<{ code: string }> };
      expect(before.issues.map((entry) => entry.code), id).toContain(code);

      const plan = editor.execute('fix', { codes: [code] }) as unknown as FixSummary;
      expect(plan.plans, id).toHaveLength(1);
      expect(plan.plans[0].fix, `${code} guessed an op`).toBe('manual');
      expect(plan.plans[0].ops, `${code} invented an op`).toEqual([]);
      expect(plan.ops, `${code} left an op in the union`).toEqual([]);
      // The claim that decides all three, checked rather than asserted: the op that *would* have
      // been handed out changes nothing here, so the manual answer is the only honest one.
      const bytes = (): string =>
        JSON.stringify(editor.state.sprite.frames.map((frame) => [...frame.cels.values()].map((cel) => [...cel.data])));
      const before_ = bytes();
      editor.execute('quantize_to_palette', {});
      expect(bytes(), `${code}: quantize_to_palette was supposed to be a no-op`).toBe(before_);
      const after = editor.execute('evaluate') as { issues: Array<{ code: string }> };
      expect(after.issues.map((entry) => entry.code), `${code} survived quantize`).toContain(code);
      // And the guidance has to say something a person can act on, not just decline.
      expect(plan.plans[0].guidance.length, code).toBeGreaterThan(80);
    }
  });

  it('declines on `invented-colours` even though snapping it would clear the code', () => {
    // **The one judgement call in this table, and §4.3 makes it for us.**
    //
    // `defect/invented-colour-32` is a single `#ff0080` pixel 87019 away from every swatch. Run
    // `quantize_to_palette` on it and the code goes away — measured below, not asserted. That is
    // exactly why the plan does not hand out the op: §4.3's `maxNearestDistance > 12000` exists
    // *to separate* "one step off a ramp entry, one `quantize_to_palette` call" from "30000 away
    // from every swatch, the fix is a decision". Handing this code the snapping op would make the
    // two identical and delete the reason the quantity was carried. Snapping clears the warning
    // without saying whether it chose the colour you meant, which is the definition of a guess —
    // and the analyzer's own message for this code already says "the fix is a decision rather than
    // a command", so an op here would put two contradictory sentences about one code in one result.
    //
    // `replace_color` is not available either, and structurally so: it needs a `layer`, a `frame`
    // and a `from`/`to` pair, and this issue carries none of them — `rect` is null and the
    // offending colour is not named on the wire.
    const editor = createEditor(corpus('defect/invented-colour-32'));
    const plan = editor.execute('fix', { codes: ['invented-colours'] }) as unknown as FixSummary;
    expect(plan.plans).toHaveLength(1);
    expect(plan.plans[0].fix).toBe('manual');
    expect(plan.plans[0].ops).toEqual([]);
    expect(plan.plans[0].guidance).toContain('decision');
    expect(plan.plans[0].guidance).toMatch(/quantize_to_palette/);
    expect(plan.plans[0].guidance).toMatch(/replace_color/);

    // The measurement that makes declining defensible: the op *would* have worked, and saying so
    // is the difference between a decision and an oversight.
    const before = editor.execute('evaluate') as { issues: Array<{ code: string }> };
    expect(before.issues.map((entry) => entry.code)).toEqual(['invented-colours']);
    editor.execute('quantize_to_palette', {});
    const after = editor.execute('evaluate') as { issues: Array<{ code: string }> };
    expect(after.issues.map((entry) => entry.code)).toEqual([]);
  });

  it('treats a code it has never heard of as a normal outcome, not an error', () => {
    // §8.3: a minor version may add codes additively, and an agent must tolerate one it does not
    // recognise. So the fallback declines and points at the issue message. Throwing here would
    // make every future code a breaking change for `fix`.
    const plan = planQualityFix(issue({ code: 'a-code-from-a-future-minor' }), 'outline');
    expect(plan.fix).toBe('manual');
    expect(plan.ops).toEqual([]);
    expect(plan.guidance).toContain('No automatic repair is registered');
    expect(plan.guidance).toContain('a-code-from-a-future-minor');
    // The unknown code still gets the absent-rect statement, because it carries no rect.
    expect(plan.guidance).toContain('names no region');
  });
});

/* ------------------------------------------------------------------ *
 * Targeting and coverage
 * ------------------------------------------------------------------ */

describe('what fix plans for', () => {
  it('measures exactly what `evaluate` measures', () => {
    const sprite = corpus('motion/frames-identical-16');
    const editor = createEditor(sprite);
    const last = sprite.frames.length - 1;
    editor.execute('add_tag', { name: 'walk', from: 0, to: last, direction: 'pingpong' });
    const evaluated = editor.execute('evaluate', { tag: 'walk' }) as { frames: string[] };
    const planned = editor.execute('fix', { tag: 'walk' }) as unknown as FixSummary;
    // A repair plan for frames nobody measured would be the worst kind of wrong, and three
    // separately spelled targeting shapes are three ways for it to happen.
    expect(planned.frames).toEqual(evaluated.frames);
    expect(planned.tag).toBe('walk');
  });

  it('narrows the plan with `codes`', () => {
    const summary = fix(corpus('defect/near-duplicate-ramp-16'), { codes: ['flat-value'] });
    expect(codesOf(summary)).toEqual(['flat-value']);
    expect(summary.plans[0].code).toBe('flat-value');
  });

  it('returns nothing rather than everything when `codes` matches no issue', () => {
    const summary = fix(corpus('defect/near-duplicate-ramp-16'), { codes: ['not-in-this-report'] });
    expect(summary.plans).toEqual([]);
    expect(summary.ops).toEqual([]);
    expect(summary.withOps).toBe(0);
    expect(summary.manual).toBe(0);
  });

  it('plans nothing against a dimension that did not apply', () => {
    const summary = fix(corpus('bleed/full-bleed-scene-32'));
    // A full-bleed scene has no subject, so `silhouette` is excluded with `no-subject`. A plan
    // that named one of its codes would be inventing a defect the report never found.
    expect(summary.plans.every((plan) => plan.dimension !== 'silhouette')).toBe(true);
  });

  it('attributes a plan to the dimension that emitted the code', () => {
    const summary = fix(corpus('defect/near-duplicate-ramp-16'));
    const byCode = new Map(summary.plans.map((plan) => [plan.code, plan.dimension]));
    expect(byCode.get('near-duplicate-colours')).toBe('noise');
    expect(byCode.get('flat-value')).toBe('value');
    expect(byCode.get('key-light-inconsistent')).toBe('value');
  });

  it('carries severity and blocking on every plan, so a caller can triage', () => {
    const summary = fix(corpus('defect/shape-clipped-32'));
    for (const plan of summary.plans) {
      expect(Number.isInteger(plan.severityQ)).toBe(true);
      expect(plan.severityQ).toBeGreaterThanOrEqual(0);
      expect(plan.severityQ).toBeLessThanOrEqual(1000);
      expect(typeof plan.blocking).toBe('boolean');
    }
    const clipped = summary.plans.find((plan) => plan.code === 'shape-clipped');
    expect(clipped?.blocking).toBe(true);
    expect(clipped?.severityQ).toBe(800);
    // `flat-value` at 550 clears the gate too, and both reach the plan with their numbers intact.
    const flat = summary.plans.find((plan) => plan.code === 'flat-value');
    expect(flat?.blocking).toBe(true);
  });

  it('has advice for every code a report over the whole corpus can produce today', () => {
    // §8.1 item 5: a code with no fix template is a code an agent can only complain about. Driven
    // off a corpus run rather than a hand-written list, so a newly registered dimension that emits
    // a new code fails here instead of shipping a code nothing can act on.
    const missing: string[] = [];
    for (const entry of SPEC.cases) {
      const sprite = buildCase(entry);
      if (sprite === null) continue;
      for (const plan of fix(sprite).plans) {
        if (QUALITY_FIX_ADVICE[plan.code] === undefined) missing.push(plan.code);
      }
    }
    expect([...new Set(missing)].sort()).toEqual([]);
  }, 30_000);
});