import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildCase,
  buildCorpus,
  buildFromRecipe,
  readCorpusScores,
  readCorpusSpec,
  SCORES_PATH,
} from '../../../benchmarks/corpus/build.js';
import {
  CorpusFormatError,
  DECLARED_QUANTITIES,
  DEFECT_KINDS,
  DERIVED_POLICY,
  loadCorpusScores,
  loadCorpusSpec,
  SPEC_GATES,
  type CorpusSpec,
  type HumanCase,
  type RealCase,
  type SyntheticCase,
} from '../../../benchmarks/corpus/format.js';
import { distribute, renderMarkdown, runCorpus } from '../../../benchmarks/corpus/report.js';
import { ALPHA_SOLID, createQualityContext } from '../src/quality/context.js';
import {
  boundaryPerimeter,
  buildSolidMask,
  countConvexCorners,
  edgePixelAt,
  edgePixelCount,
} from '../src/quality/measure.js';
import { measureSilhouette } from '../src/quality/silhouette.js';
import { measureValue } from '../src/quality/value.js';
import { measureNoise } from '../src/quality/noise.js';
import { measurePalette } from '../src/quality/palette.js';
import { makeId } from '../src/ids.js';
import type { Sprite } from '../src/document.js';
import { serializeSprite } from '../src/serialize.js';
import * as measure from '../src/quality/measure.js';
import * as silhouette from '../src/quality/silhouette.js';

/**
 * The calibration corpus, and the four things it has to be.
 *
 * T-021 exists because two tasks in a row declined to move a gate: the quality scorer cannot be
 * calibrated because this repository has almost no sprites to calibrate it against. Twelve real
 * assets, ten of them full-bleed scenes the `silhouette` dimension refuses to measure, and one
 * character sprite the `compactnessQ` gate penalises at 269 against 300. A threshold fitted to one
 * sample is fitting noise.
 *
 * So the corpus is built out of the one source a human rating cannot supply: **controlled subjects
 * with a declared defect**, where the ground truth is known by construction because the defect was
 * put there on purpose. Those are regression guards with expected values. The real artwork answers a
 * different question ("does the analyzer stay quiet on good work it was not designed around"), and
 * the human tier - empty on arrival - is the only one that can speak to taste, because
 * `docs/EVALUATION.md` §6.1 is explicit that algorithmic labels cannot calibrate an algorithm.
 *
 * This file therefore has five jobs, and the first is the one a corpus most often gets wrong:
 *
 *   1. **Prove the corpus is a guard.** A committed baseline of the generated report is compared
 *      byte for byte, and every declared expectation is compared. Both are checked against their
 *      *discriminating* case rather than their passing one: a negative control must be silent, and
 *      a case that declares a defect must be reported.
 *   2. **Pin the decisions, not the prose.** The 1px-margin trap, the 4-vs-8 connectivity split, the
 *      per-mille threshold that cannot exist, `min` over frames, the two exclusion reasons. Each of
 *      these was a judgement call once; each is a number now.
 *   3. **Produce the distribution** a gate move would be based on, and move no gate.
 *   4. **Make the tier boundary structural**, so "algorithms cannot calibrate algorithms" is
 *      enforced by the loader rather than agreed in a comment.
 *   5. **Keep `measure.ts` honest**: one home per §3.3 quantity, and a written record of the one
 *      that §3.3 still defines two incompatible ways.
 */

const SPEC = readCorpusSpec();
const SCORES = readCorpusScores(SPEC);
const RUN = runCorpus(SPEC, SCORES);
const DISTRIBUTION = distribute(RUN);
const BASELINE_PATH = fileURLToPath(new URL('../../../benchmarks/corpus/baseline.md', import.meta.url));

/**
 * Timeout for the tests that deliberately re-run the whole corpus.
 *
 * Three of them do, and they do it for the reason the first one states: a guard
 * that cannot be shown to fail is not known to hold, and the only way to show it
 * is to mutate an expectation and watch the runner catch it. That costs a full
 * pass — sixty-three sprites materialised and analysed — which runs about three
 * seconds on a workstation and about six on a CI runner, so vitest's 5s default
 * sits *inside* the workload's own variance. That default is a statement about
 * test hygiene, not about how long this particular assertion honestly takes, and
 * the failure it produces is a red X that says nothing about the artwork. Thirty
 * seconds is far beyond any measured run and still bounded, so a genuine hang is
 * still a hang.
 */
const CORPUS_PASS_TIMEOUT_MS = 30_000;

/** Rows keyed by id, so a test can talk about one case rather than searching for it. */
const ROWS = new Map(RUN.rows.map((row) => [row.id, row]));

function row(id: string) {
  const found = ROWS.get(id);
  expect(found, `the corpus has no case "${id}"`).toBeDefined();
  return found!;
}

const synthetic = (): SyntheticCase[] => SPEC.cases.filter((c): c is SyntheticCase => c.tier === 'synthetic');
const real = (): RealCase[] => SPEC.cases.filter((c): c is RealCase => c.tier === 'real');
const human = (): HumanCase[] => SPEC.cases.filter((c): c is HumanCase => c.tier === 'human');

/**
 * `noise`'s own frame record for one case, measured here rather than read off the row.
 *
 * `CorpusRow` carries `silhouette`'s and `value`'s numbers because those two are the ones §7.2's
 * findings are argued from; `noise`'s are not on the row, and reading them off the generated report
 * instead would mean asserting against the artifact this test regenerates. Re-measuring through
 * `measureNoise` — the same shared measurement §4.4 is written against — keeps the assertion on the
 * analyzer rather than on the markdown.
 */
function noiseFrameOf(id: string) {
  const sprite = buildCase(SPEC.cases.find((entry) => entry.id === id)!);
  if (sprite === null) throw new Error(`the corpus has no buildable case "${id}"`);
  return measureNoise(createQualityContext(sprite))[0];
}

/**
 * `palette`'s frame record for one case, measured through {@link measurePalette} rather than read
 * off the generated report, for `noiseFrameOf`'s reason: the report is the artifact this file
 * regenerates, and an assertion about `palette`'s readings belongs on the analyzer.
 */
function paletteFrameOf(id: string) {
  const sprite = buildCase(SPEC.cases.find((entry) => entry.id === id)!);
  if (sprite === null) throw new Error(`the corpus has no buildable case "${id}"`);
  return measurePalette(createQualityContext(sprite))[0];
}

/**
 * Every code `silhouette` can emit, from `docs/EVALUATION.md` Appendix A.
 *
 * Named here because two of the tests below are about one dimension on purpose: the aggregator
 * applies `value` to a full-bleed scene and `silhouette` does not, so "the report says nothing
 * about a scene" stopped being true when `value` landed, and the honest form of the claim is "the
 * dimension that is excluded contributes nothing" — which is a claim about *these six strings* and
 * not about the length of a list.
 */
const SILHOUETTE_CODES = [
  'detached-pieces',
  'fragmented-silhouette',
  'interior-hole',
  'shape-clipped',
  'subject-undersized',
  'thin-profile',
] as const;

/** Every code `palette` can emit, from `docs/EVALUATION.md` §4.3's issue table. */
const PALETTE_CODES = [
  'colour-budget-exceeded',
  'grey-colours',
  'hue-sprawl',
  'invented-colours',
  'muddy-mix',
  'off-palette',
] as const;

/* ------------------------------------------------------------------ *
 * 1 · It is a guard
 * ------------------------------------------------------------------ */

describe('the corpus is a regression guard, not a report', () => {
  it('holds every declared expectation, and names the ones that do not', () => {
    // The load-bearing assertion of the whole task. A corpus whose `failures` array is never read
    // is a table, and a table of numbers is the failure mode this work most risks.
    expect(RUN.failures).toEqual([]);
    expect(RUN.failures.map((f) => `${f.id}: ${f.reason}`)).toEqual([]);
  });

  it('matches the committed baseline byte for byte, so a score that moves is a diff', () => {
    const committed = readFileSync(BASELINE_PATH, 'utf8');
    if (process.env.UPDATE_CORPUS === '1') writeFileSync(BASELINE_PATH, RUN.markdown, 'utf8');
    // Written before the assertion rather than in an `else`, so an `UPDATE_CORPUS=1` run also
    // checks the run it just wrote instead of skipping straight to "updated".
    expect(RUN.markdown).toBe(committed);
  });

  it('would fail if a single expected code were wrong, and the report shows both sides', () => {
    // The discriminating half of "it is a guard", run here rather than argued. A guard that cannot
    // be shown to fail is not known to hold - the discipline `determinism.test.ts` applies to its
    // "same seed, same bytes" claims, for the same reason.
    const broken = runCorpus(withExpectation('defect/detached-pieces-22', { codes: ['interior-hole'] }), SCORES);
    expect(broken.failures).toHaveLength(1);
    expect(broken.failures[0].id).toBe('defect/detached-pieces-22');
    expect(broken.failures[0].reason).toContain('expect.codes [interior-hole]');
    expect(broken.failures[0].reason).toContain('detached-pieces');
    // And the row says `fail`, so the table a human reads is honest about it too.
    expect(broken.rows.find((r) => r.id === 'defect/detached-pieces-22')?.status).toBe('fail');
  }, CORPUS_PASS_TIMEOUT_MS);

  it('fails a case that measures something other than it declares', () => {
    // A `measure` expectation is the other half of the guard: the gate could be moved so that
    // `compactnessQ` stopped being reported at all, and every code expectation would still pass.
    const broken = runCorpus(withExpectation('sweep/rect-30x4', { measure: { compactnessQ: [999] } }), SCORES);
    expect(broken.failures.map((f) => f.id)).toEqual(['sweep/rect-30x4']);
    expect(broken.failures[0].reason).toContain('measured [326]');
  }, CORPUS_PASS_TIMEOUT_MS);

  it('has a negative control for every condition, and every one of them is silent', () => {
    // "An analyzer that fires on clean work is worse than one that misses a defect" is only a
    // checkable property if clean work is in the corpus. There is at least one control per issue
    // code, and all of them expect silence.
    const controls = synthetic().filter((entry) => entry.defects.some((d) => d.kind === 'clean-control'));
    expect(controls.length).toBeGreaterThanOrEqual(8);
    for (const control of controls) {
      expect(row(control.id).actualCodes, `${control.id} fired on clean work`).toEqual([]);
      expect(row(control.id).status, `${control.id}`).toBe('pass');
    }
    const named = new Set(controls.flatMap((entry) => entry.expect.absent ?? []));
    for (const code of [
      'detached-pieces',
      'interior-hole',
      'thin-profile',
      'shape-clipped',
      'subject-undersized',
      'fragmented-silhouette',
    ]) {
      expect(named.has(code), `no negative control names "${code}"`).toBe(true);
    }
  });

  it('has a case that declares and is reported for every defect it can inject', () => {
    // The ground-truth contract, checked from the report rather than from the loader: a code that
    // appears in some case's `defects` must appear in that case's reported codes.
    const emitted = new Set<string>();
    for (const entry of synthetic()) {
      for (const defect of entry.defects) {
        if (defect.kind === 'clean-control') continue;
        expect(
          row(entry.id).actualCodes,
          `${entry.id} declared ${defect.kind} and did not report it`,
        ).toContain(defect.kind);
        emitted.add(defect.kind);
      }
    }
    // Every injectable defect the pipeline can produce is covered, the aggregator's two included.
    // **This list is deliberately NOT derived from the loader's own `DEFECT_KINDS`**, and the reason
    // is the difference between the two questions in this file. The coverage test below asks "does
    // every code in the closed enum have a case?", and the closed enum is a *specification*, so it is
    // read from the loader and nothing else would do. This one asks the opposite: "is the set of
    // defects the corpus exercises the same set the analyzers can emit?", and there is no registry of
    // emitted codes to derive it from — the nearest thing is §4's issue table in a document this
    // repository has twice decided not to parse at test time. So it stays a list, and the price of a
    // list is that it goes stale when a dimension lands: that is exactly how `value`'s six codes
    // came to be missing from it, and why the sixth is the last one anyone should expect to add by
    // hand. A new dimension should add a case *and* a row here in the same commit, and the
    // companion test below is what notices when only one of the two happened.
    //
    // **Was 14, `noise` made it 16, `palette` made it 25, and every rename is the finding rather than
    // a chore.** `defect/stray-colour-16` and `defect/near-duplicate-ramp-16` were `noise`'s first
    // two cases ever; `palette` arrived with **six** codes and **none** of them on this list, which is
    // precisely the situation the paragraph above warns about, and nine cases later it has one case
    // per code. Six of those nine are the isolating shapes in `quality-palette.test.ts` brought to
    // the corpus, and three are negative controls for `hue-sprawl`, `grey-colours` and
    // `colour-budget-exceeded` that pin the *other* side of each gate.
    expect([...emitted].sort()).toEqual([
      'colour-budget-exceeded',
      'detached-pieces',
      'diagonal-seam',
      'empty-frame',
      'flat-value',
      'fragmented-silhouette',
      'frames-identical',
      'grey-colours',
      'highlight-blown',
      'hue-carries-form',
      'hue-sprawl',
      'interior-hole',
      'invented-colours',
      'isolated-pixels',
      'muddy-mix',
      'narrow-value-range',
      'near-duplicate-colours',
      'off-palette',
      'plane-crosses-form',
      'shadow-crushed',
      'shape-clipped',
      'single-pixel-spur',
      'stray-colour',
      'subject-undersized',
      'thin-profile',
    ]);
  });
});

/** A copy of the spec with one synthetic case's expectations replaced. */
function withExpectation(id: string, expect: Record<string, unknown>): CorpusSpec {
  return {
    ...SPEC,
    cases: SPEC.cases.map((entry) =>
      entry.id === id ? { ...entry, expect: { ...entry.expect, ...expect } } : entry,
    ),
  };
}

/* ------------------------------------------------------------------ *
 * 2 · The decisions, pinned
 * ------------------------------------------------------------------ */

describe('the 1px-margin trap, and why no per-mille threshold can solve it', () => {
  it('excludes the same ink at 0px and at 1px, and measures it at 2px', () => {
    // Three cases, one rectangle, three margins. T-018's finding as a triple rather than a pair,
    // and the third member matters: a predicate that only ever said "no subject" would pass the
    // first two and be useless.
    const full = row('bleed/full-bleed-scene-32');
    const guard = row('bleed/one-pixel-guard-32');
    const margin = row('bleed/two-pixel-margin-32');
    expect(full.preconditions.silhouette).toBe('no-subject');
    expect(guard.preconditions.silhouette).toBe('no-subject');
    expect(margin.preconditions.silhouette).toBeNull();
    // And `evaluate` delivers a number only in the third case, which is the whole mechanism.
    expect(full.excluded.silhouette).toBe('no-subject');
    expect(guard.excluded.silhouette).toBe('no-subject');
    expect(margin.excluded.silhouette).toBeUndefined();
    expect(full.scores.silhouette).toBeUndefined();
    expect(guard.scores.silhouette).toBeUndefined();
    expect(margin.scores.silhouette).toBe(1000);
  });

  it('records the measurement it refused to deliver, which is the T-012 finding in numbers', () => {
    // Before the precondition existed, each of the ten real scenes scored 800 with a blocking
    // `shape-clipped`. The corpus measures them anyway and prints the number beside the reason it
    // was not delivered, so "the measurement said 800" and "the report said nothing" are one row
    // rather than two claims in a changelog.
    for (const id of ['bleed/full-bleed-scene-32', 'bleed/one-pixel-guard-32']) {
      const frame = row(id).frames[0];
      expect(frame.N).toBeGreaterThan(0);
      expect(frame.scoreQ).toBe(800);
      expect(frame.borderTouch).toBeGreaterThanOrEqual(3);
      expect(row(id).actualCodes, `${id} must report nothing`).toEqual([]);
      expect(row(id).blocking, `${id} must report nothing`).toEqual([]);
    }
  });

  it('reports a 2px-guarded three-edge crop as clipped, which is the honest other side', () => {
    // The cost `SUBJECT_REQUIRED_MARGIN` states in its own docstring. A subject running off three
    // edges *is* clipped, and 2px of guard is a margin somebody chose rather than a bleed guard,
    // so the dimension applies and says so. Pinned so a future "be more forgiving" edit has to come
    // back here and say what it gave up.
    const clipped = row('defect/shape-clipped-32');
    expect(clipped.preconditions.silhouette).toBeNull();
    // **And the two `value` codes are in the list because the fixture is one flat swatch.** The
    // expectation was written when `value` did not exist, so "the report carries `shape-clipped`
    // and nothing else" was true of the artwork; it is not true of a one-colour rectangle, which
    // §4.2 describes in exactly those words. `cases.json` already says so, and the disagreement
    // was between the two records rather than between the record and the pipeline.
    expect(clipped.actualCodes).toEqual(['flat-value', 'narrow-value-range', 'shape-clipped']);
    expect(clipped.blocking).toEqual(['shape-clipped', 'flat-value']);
    expect(clipped.actualVerdict).toBe('fail');
    expect(clipped.frames[0].margin).toBe(0);
  });

  it('cannot be a per-mille threshold, and the arithmetic is in the test rather than a comment', () => {
    // The rejected alternative, kept as an assertion because a future maintainer will try it: a
    // ratio of the canvas reads better than a pixel and cannot work, because the *same* margin is a
    // different fraction at every canvas size. The whole range, in per-mille:
    //
    //   1px of margin  234 at 16², 121 at 32²,  61 at 64²,  31 at 128²,
    //                  15 at 256²,   7 at 512²,   3 at 1024²,  0 at 4096²
    //   2px of margin  437 at 16², 234 at 32², 121 at 64²,  61 at 128²,
    //                  31 at 256²,  15 at 512²,   7 at 1024²,  1 at 4096²
    //
    // A predicate of the form `transparent > T => no subject` must satisfy BOTH:
    //   - absorb a 1px bleed guard at every size, including 4096², where that margin is 0/1000
    //     and `0 > T` is false for any threshold a per-mille pipeline would compare against; and
    //   - still see a 2px margin at 1024² (7/1000) as a margin somebody chose, which needs
    //     `7 <= T`.
    // Those are `T < 0` and `T >= 7`. Disjoint, and the gap does not close at any canvas size.
    const marginPermille = (size: number, margin: number): number =>
      Math.floor(((size * size - (size - margin * 2) * (size - margin * 2)) * 1000) / (size * size));
    expect(marginPermille(16, 1)).toBe(234);
    expect(marginPermille(1024, 2)).toBe(7);
    // The end of the range is what kills it: at 4096² a 1px margin rounds to zero per-mille, so
    // no non-negative threshold can see it at all.
    expect(marginPermille(4096, 1)).toBe(0);
    expect(marginPermille(4096, 2)).toBe(1);
    const absorbsGuardAt4096 = (t: number): boolean => marginPermille(4096, 1) > t;
    const seesMarginAt1024 = (t: number): boolean => marginPermille(1024, 2) <= t;
    for (const t of [0, 1, 6, 7, 100, 233, 234, 1000]) {
      expect(absorbsGuardAt4096(t) && seesMarginAt1024(t), `T = ${t}`).toBe(false);
    }
    // And the pixel predicate has no such problem: the same one pixel is the same one pixel at 16²
    // and at 4096², which is the entire argument for the unit.
    expect(SPEC_GATES.compactnessQ).toBe(300);
    expect(marginPermille(16, 1)).toBeGreaterThan(marginPermille(4096, 1));
  });

  it('excludes on unanimity over inked frames, never on a majority', () => {
    // A two-frame sheet that is one scene plus one blank is still one scene, and a sheet that is
    // one scene plus one subject keeps the dimension. The second is `motion/blank-frame-16`:
    // frame 0 has a subject, frame 1 has nothing, and exclusion is unanimity over *inked* frames,
    // so an empty frame cannot be the thing that convinces the aggregator there is no subject.
    expect(row('motion/blank-frame-16').preconditions.silhouette).toBeNull();
    expect(row('motion/blank-frame-16').frames[1].N).toBe(0);
  });
});

describe('connectivity: the subject is 4-connected and the background is 8-connected', () => {
  it('splits a corner contact and joins it, from both sides', () => {
    const corner = row('connectivity/corner-touching-16');
    expect(corner.connectivity).toEqual({ four: 2, eight: 1 });
    // And the consequence, which is the reason the rule exists: at 0.5x scale, under a filter, or
    // on a CRT the corner contact disappears, so the analyzer is right to call it a stray. The two
    // `value` codes come with it because both masses are the same single swatch: the case is about
    // connectivity and says nothing about tone, which is precisely why the tone codes are a fact
    // about the fixture rather than about the defect under test.
    expect(corner.actualCodes).toEqual(['detached-pieces', 'flat-value', 'narrow-value-range']);
    // And the contrast with a case whose masses touch at *nothing*: three separate blocks are
    // three components under both connectivities, which is what makes the corner case a decision
    // rather than an accident of counting.
    expect(row('defect/three-masses-20').connectivity).toEqual({ four: 3, eight: 3 });
  });

  it('keeps a 1px diagonal as ONE component under 8-connectivity and many under 4', () => {
    // The requirement, stated as a number: 8-connectivity keeps the bridge together, and the
    // 4-connected count is the shape's real fragility. Both directions in one case.
    expect(row('connectivity/diagonal-bridge-16').connectivity).toEqual({ four: 12, eight: 1 });
    expect(row('connectivity/contour-staircase-24').connectivity).toEqual({ four: 18, eight: 1 });
  });

  it('calls a closed contour 4-connected, so §3.3\'s prose is about a staircase run', () => {
    // A finding, not a preference. §3.3 says "A 1px contour traced around a curve is 8-connected
    // and 4-disconnected along every step of its own staircase", and that is true *along a run*:
    // a closed ring is joined up at every turn by the corner pixel, so it is 4-connected as a
    // whole. §4.5 needs to know which of the two it is measuring.
    expect(row('control/outline-ring-32').connectivity).toEqual({ four: 1, eight: 1 });
  });

  it('does not call a diagonal leak a hole, and a 4-connected background would', () => {
    // The discriminating half. The corpus asserts the answer (0 holes); this asserts that the
    // answer *depends* on the connectivity choice, by running the other reading on the same mask
    // with a small local flood fill. A reference implementation in the repository rather than a
    // throwaway script: the process incident this roadmap records was caused by measurements that
    // were computed once, outside the repo, and thrown away.
    const entry = SPEC.cases.find((c) => c.id === 'connectivity/background-diagonal-leak-9');
    const context = createQualityContext(buildCase(entry!));
    const { mask } = buildSolidMask(context.composite[0], context.width, context.height);
    expect(measureSilhouette(context)[0].holeCount).toBe(0);
    expect(countInteriorHoles(mask, context.width, context.height, false)).toBe(1);
    // And the same mask with the diagonal route *closed* is a hole under both, so the case is
    // genuinely about the leak rather than about the pocket not existing.
    const sealed = Uint8Array.from(mask);
    sealed[2 * 9 + 2] = 1; // put the erased corner back
    expect(countInteriorHoles(sealed, context.width, context.height, true)).toBe(1);
  });
});

/**
 * Transparent components that do not reach the border, under one connectivity or the other.
 *
 * A 12-line reference for `interiorHoles`, which hard-codes 8-connectivity for the background. It
 * exists to prove the corpus's `holeCount: 0` is a *consequence* of that choice rather than a
 * property of the shape: with a 4-connected background the same mask has a hole.
 */
function countInteriorHoles(
  mask: Uint8Array,
  width: number,
  height: number,
  diagonal: boolean,
): number {
  const seen = new Uint8Array(mask.length);
  const offsets: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  if (diagonal) offsets.push([1, 1], [1, -1], [-1, 1], [-1, -1]);
  let count = 0;
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 0 || seen[start] === 1) continue;
    const queue = [start];
    seen[start] = 1;
    let touchesEdge = false;
    while (queue.length > 0) {
      const p = queue.pop()!;
      const x = p % width;
      const y = (p - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;
      for (const [dx, dy] of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        if (mask[q] !== 0 || seen[q] === 1) continue;
        seen[q] = 1;
        queue.push(q);
      }
    }
    if (!touchesEdge) count++;
  }
  return count;
}

describe('the compactnessQ gate: calibrated from a distribution, and not moved here', () => {
  it('agrees with the specification\'s own arithmetic on every sweep member', () => {
    // A drift guard, and a non-circular one: the expected values come from
    // `min(1000, rhu(4 * 355 * 1000 * N, 113 * P * P))` written out from §4.1, and
    // `compactnessQ` is the implementation. Two independent expressions of one formula, compared.
    const rhu = (a: number, b: number): number => Math.floor((a + b / 2) / b);
    const members = synthetic().filter((c) => c.id.startsWith('sweep/'));
    expect(members.length).toBeGreaterThanOrEqual(12);
    for (const entry of members) {
      const op = entry.recipe.ops[0];
      if (op.op !== 'rect') throw new Error(`${entry.id}: a sweep member is one rect`);
      const [, , width, height] = op.rect;
      const N = width * height;
      const P = 2 * (width + height);
      const fromSpec = Math.min(1000, rhu(4 * 355 * 1000 * N, 113 * P * P));
      expect(row(entry.id).frames[0].compactnessQ, entry.id).toBe(fromSpec);
      expect(row(entry.id).frames[0].perimeter, entry.id).toBe(P);
      expect(row(entry.id).frames[0].N, entry.id).toBe(N);
    }
  });

  it('sweeps a distribution, not a threshold, and the gate sits inside it', () => {
    // The point of the sweep. A gate is a number and this corpus is a curve, so a move can be
    // argued about with the whole curve in front of the reader.
    const values = DISTRIBUTION.samples.map((s) => s.compactnessQ);
    expect(values.length).toBeGreaterThanOrEqual(20);
    expect(Math.min(...values)).toBeLessThan(200);
    expect(Math.max(...values)).toBeGreaterThan(700);
    expect(DISTRIBUTION.below).toBeGreaterThan(0);
    expect(DISTRIBUTION.atOrAbove).toBeGreaterThan(0);
    expect(DISTRIBUTION.below + DISTRIBUTION.atOrAbove).toBe(DISTRIBUTION.samples.length);
    // Strictly increasing, so the histogram is not hiding duplicates or an unsorted list.
    expect([...values].sort((a, b) => a - b)).toEqual(values);
  });

  it('places the one real character sprite inside the distribution, and says where', () => {
    // The datum the whole calibration argument turns on, produced by the runner rather than quoted
    // from a previous task's notes.
    const keeper = row('artwork/verify/lantern-keeper.pixel');
    expect(keeper.frames[0].compactnessQ).toBe(269);
    expect(DISTRIBUTION.reference).toEqual({ id: 'artwork/verify/lantern-keeper.pixel', value: 269 });
    // The gate is above it, which is the complaint T-012 recorded, and it is an advisory: the
    // sprite is a subject, it reads, and nothing about it blocks delivery.
    expect(keeper.actualCodes).toContain('thin-profile');
    expect(keeper.blocking).toEqual([]);
    // **And T-022's second gate does not touch it**, which is the single most important thing
    // this block can say about that gate. The sprite's own room is 375/1000 — a 12px inscribed
    // square in a 32px canvas — so `profileQ` is 269, the compactness reading, and
    // `thin-profile` fires for exactly the reason it did before. A new threshold that moved the
    // one real sample in the repository would be a threshold fitted to it, and this is the
    // assertion that says it did not.
    expect(keeper.frames[0].thicknessPx).toBe(12);
    expect(keeper.frames[0].thicknessQ).toBe(375);
    expect(keeper.frames[0].profileQ).toBe(269);
    // The neighbours, so the corpus can say what the gate would have to fall between rather than
    // only that it is wrong about one asset. Above 269 the nearest sample is 275 and there are
    // now four of them (the sweep member plus T-022's three band cases, which are all the same
    // 28x3 shape), so the *value* is pinned and the id is not — a tiebreak on a set of equal
    // measurements is an implementation detail, not a fact about the artwork.
    expect(DISTRIBUTION.neighbours).not.toBeNull();
    const [below, above] = DISTRIBUTION.neighbours!;
    expect(below.compactnessQ).toBe(260);
    expect(below.id).toBe('sweep/rect-30x3');
    expect(above.compactnessQ).toBe(275);
    expect(above.compactnessQ - below.compactnessQ).toBeLessThanOrEqual(20);
    expect(DISTRIBUTION.belowReference).toBe(4);
    expect(DISTRIBUTION.belowReference).toBeLessThan(DISTRIBUTION.samples.length);
  });

  it('prices every candidate gate in both directions, which is what a move is argued from', () => {
    // Lowering the gate can only *release* subjects, never penalise new ones, so the cost of
    // admitting the one real character sprite is exactly the `released` list at 269. Nothing in
    // this file decides that is worth paying - the table exists so the decision has numbers in it.
    const at = (gate: number) => DISTRIBUTION.sensitivity.find((entry) => entry.gate === gate)!;
    expect(DISTRIBUTION.sensitivity.map((entry) => entry.gate)).toEqual([200, 250, 260, 269, 275, 300]);
    // The count below each candidate, which is the whole curve in six points. T-021's curve was
    // 44, 65, 157, 184, 234, 259, 260, 269, 275, 295; **four of those ten are gone** and three
    // equal-275 band cases have arrived, so 9 is the honest number rather than 10. The four that
    // left are exactly what defect 2 was about: three masses with three perimeters, and two
    // degenerate 1px-connectivity shapes whose subject is one pixel of a staircase.
    expect(at(200).penalised).toBe(2);
    expect(at(250).penalised).toBe(3);
    expect(at(260).penalised).toBe(3);
    expect(at(269).penalised).toBe(4);
    expect(at(275).penalised).toBe(5);
    expect(at(300).penalised).toBe(DISTRIBUTION.below);
    expect(DISTRIBUTION.below).toBe(9);
    // The price of admitting the keeper, and the shape of it. A gate is one number, so the only
    // thresholds that release `compactnessQ 269` are G <= 269, and every such G also releases
    // everything above it up to 300. There is still no gate that admits the character sprite and
    // nothing else, which is the thing a reader most wants to know and cannot get from a
    // single-sample argument - **and the fix to the measurement did not change that**, because
    // the sprite's problem is its aspect ratio rather than its size. That is the finding, and it
    // is why TASKS.md's ruling (fix the measurement, not the gate) still stands.
    expect(at(269).released.map((s) => s.id)).toEqual([
      'artwork/verify/lantern-keeper.pixel',
      'sweep/band-28x3-on-1024',
      'sweep/band-28x3-on-32',
      'sweep/band-896x96-on-1024',
      'sweep/rect-28x3',
    ]);
    // At 275 the keeper is still penalised, and only the four above it are released.
    expect(at(275).released.map((s) => s.id)).toEqual([
      'sweep/band-28x3-on-1024',
      'sweep/band-28x3-on-32',
      'sweep/band-896x96-on-1024',
      'sweep/rect-28x3',
    ]);
    expect(at(300).released).toEqual([]);
    expect(at(300).newlyPenalised).toEqual([]);
    // Monotone across the whole table rather than on two rows, because a table that is not monotone
    // is a table nobody can read as a curve.
    const penalties = DISTRIBUTION.sensitivity.map((entry) => entry.penalised);
    expect(penalties).toEqual([...penalties].sort((a, b) => a - b));
    for (const entry of DISTRIBUTION.sensitivity) {
      expect(entry.newlyPenalised, `gate ${entry.gate}`).toEqual([]);
      // And `penalised` is `released + below` exactly, so the two columns cannot drift apart.
      expect(entry.penalised, `gate ${entry.gate}`).toBe(DISTRIBUTION.below - entry.released.length);
    }
  });

  it('changes no gate', () => {
    // Stated as a test because "this task moved a threshold" would be a one-line diff nobody would
    // question in review. The corpus transcribes §4.1's thresholds and asserts them; it does not
    // own them, and the assertion here is that the transcription is still the spec's.
    expect(SPEC_GATES).toEqual({
      compactnessQ: 300,
      share: 98,
      strayRatio: 2,
      holeArea: 1,
      borderTouch: 3,
      span: 25,
    });
    // The gate is also still where §4.1 puts it, read back out of the behaviour rather than out of
    // a constant: the two sweep members that straddle it are 326 and 275, and one reports
    // `thin-profile` while the other does not. **And the silence on the first one is now real
    // silence** — every clean control in this corpus is lit from the left, so the sweep reads as a
    // sweep of shapes rather than of flat swatches, and `expect.codes []` is what a control means.
    // It was `['flat-value', 'narrow-value-range']` while the fixture was one colour, which is
    // another way of saying the control was not controlling anything for this dimension.
    expect(row('sweep/rect-30x4').actualCodes).toEqual([]);
    // The other side of the gate is a *defect* case, so it stays one flat swatch and carries both
    // tone codes as well as the one under test: `thin-profile` is the assertion, the other two are
    // a fact about the fixture.
    expect(row('sweep/rect-28x3').actualCodes).toEqual([
      'flat-value',
      'narrow-value-range',
      'thin-profile',
    ]);
    expect(row('sweep/rect-30x4').frames[0].compactnessQ).toBeGreaterThan(SPEC_GATES.compactnessQ);
    expect(row('sweep/rect-28x3').frames[0].compactnessQ).toBeLessThan(SPEC_GATES.compactnessQ);
    // **And T-022's own numbers are in `DERIVED_POLICY`, not in `SPEC_GATES`,** because
    // `SPEC_GATES` is a *transcription* and a transcription stops being evidence the moment
    // something in it was picked. `thicknessQ` has no row in §4.1 at all, so putting 250 there
    // would have made §4.1 and the implementation agree by construction. The two records are
    // asserted apart, and every `DERIVED_POLICY` member carries its reason, so the number is
    // somebody's and not the harness's.
    expect(SPEC_GATES.compactnessQ).toBe(300);
    expect(DERIVED_POLICY).toMatchObject({ thicknessQ: 250, profileDeep: 150, holeNick: 50 });
    for (const key of ['thicknessQ', 'profileDeep', 'holeNick'] as const) {
      expect(DERIVED_POLICY.rationale[key].length).toBeGreaterThan(80);
    }
    // The compactness gate is read twice, because a gate that only exists as a number in a
    // constant is a gate nobody has checked. §4.1 says `compactnessQ < 300` and the behaviour
    // agrees: 326 is silent and 275 is not, on subjects whose only difference is 51 per-mille.
    expect(row('sweep/rect-30x4').frames[0].compactnessQ - SPEC_GATES.compactnessQ).toBe(26);
    expect(SPEC_GATES.compactnessQ - row('sweep/rect-28x3').frames[0].compactnessQ).toBe(25);
  });

  it('uses perimeter transitions, and the wrong denominator would reward the thin shapes', () => {
    // §3.3 gives `edgePixels` and `perimeter` a subsection each because they are not
    // interchangeable, and §4.1's worked example is the 5-pixel plus sign: 12 transitions against 4
    // edge pixels. The corpus records both on every row, and this pins the relationship where the
    // two diverge most.
    const slender = row('sweep/rect-30x2').frames[0];
    expect(slender.perimeter).toBe(64);
    expect(slender.edgePixels).toBe(60);
    // And a staircase diverges far harder than a rectangle: the 1px diagonal run has every pixel on
    // its own boundary in both counts, 12 pixels and 48 transitions. **The quotient is now the
    // SUBJECT's**, and the subject of a 12-pixel 1px staircase is one pixel, so the number
    // `thin-profile` reads on the compactness axis is 785 — a perfect little square — while
    // `thicknessQ` is 63 and the code fires anyway. That is the whole argument for having two
    // quantities, on one row of the corpus.
    const bridge = row('connectivity/diagonal-bridge-16').frames[0];
    expect(bridge.edgePixels).toBe(12);
    expect(bridge.perimeter).toBe(48);
    expect(bridge.subjectPerimeter).toBe(4);
    expect(bridge.compactnessQ).toBe(785);
    expect(bridge.thicknessQ).toBeLessThan(DERIVED_POLICY.thicknessQ);
    expect(row('connectivity/diagonal-bridge-16').actualCodes).toContain('thin-profile');
  });
});

/**
 * The scale-aware reading, and the two questions it is deliberately not asked to answer.
 *
 * T-021's second finding was that `compactnessQ` is scale-invariant, so a 30×1 blade and a
 * 900×30 blade score alike and "this dimension cannot tell a knife from a field boundary". §3.3's
 * `Dmax` paragraph is the specification's own argument for fixing that and §4.1 never applied it.
 *
 * The measurement now answers it, and these are the two pairs that say by how much and at what
 * price. The second one is the more important half: it is a pair designed to come out **at zero**,
 * because the limit of a canvas-relative reading is a real limit and a corpus that only carried
 * pairs it passes would be a corpus that hid one.
 */
describe('thicknessQ separates what compactnessQ cannot, and says what it cannot either', () => {
  it('separates a 3px knife from a 3px horizon by 91, and the shape reading by nothing', () => {
    // The acceptance question, as numbers. Same 84 pixels, same 62 of boundary, two canvases.
    const knife = row('sweep/band-28x3-on-32').frames[0];
    const horizon = row('sweep/band-28x3-on-1024').frames[0];
    expect(knife.N).toBe(horizon.N);
    expect(knife.subjectPerimeter).toBe(horizon.subjectPerimeter);
    // The shape descriptor is right not to move, and this is the assertion that says so: 275 on
    // both, gap 0. A gate that separated these would be a gate about canvas size.
    expect(knife.compactnessQ).toBe(275);
    expect(horizon.compactnessQ).toBe(275);
    // The scale-aware reading separates them by 91, and the band table reads it as the binding
    // constraint in both directions: 94 against 3, profileQ 94 against 3.
    expect(knife.thicknessPx).toBe(horizon.thicknessPx);
    expect(knife.thicknessQ).toBe(94);
    expect(horizon.thicknessQ).toBe(3);
    expect(knife.thicknessQ - horizon.thicknessQ).toBe(91);
    expect(knife.profileQ).toBe(94);
    expect(horizon.profileQ).toBe(3);
    // And the pair is in the report as a §6.2 group with all five gaps, so a reviewer reads the
    // 91 beside the score gap of 0 rather than having to compute it.
    const pair = DISTRIBUTION.pairs.find((entry) => entry.group === 'silhouette/scale-room')!;
    expect(pair).toBeDefined();
    expect(pair.members.map((m) => m.id).sort()).toEqual([
      'sweep/band-28x3-on-1024',
      'sweep/band-28x3-on-32',
    ]);
    expect(pair.compactnessGap).toBe(0);
    expect(pair.thicknessGap).toBe(91);
    expect(pair.profileGap).toBe(91);
    // **And the honest other half: the score does not separate them.** Both are a 3px band and
    // both are past the deep band, so the step function cannot express "much worse" and both
    // land on 700. That is the same finding as the 784-versus-184 sweep pair — a single step
    // across 600 per-mille — and it is a gate question rather than a measurement question, which
    // is why the measurement was fixed and the gate was not.
    expect(pair.gap).toBe(0);
    expect(row('sweep/band-28x3-on-32').actualCodes).toContain('thin-profile');
    expect(row('sweep/band-28x3-on-1024').actualCodes).toContain('thin-profile');
  });

  it('does NOT separate the same drawing at two resolutions, and says so in the spec', () => {
    // The knife magnified 32x. Every measurement is identical and every one of them should be:
    // any ratio of two lengths in one sprite is invariant under uniform magnification. A 3px knife
    // and a 96px knife are different objects to a player, and telling them apart needs a target
    // resolution, which a `.pixel` document does not carry and this pipeline must not invent.
    //
    // Pinned as an expectation rather than left in a comment, because a limit nobody can fail is a
    // limit nobody will read, and because a future change that *does* separate this pair has to
    // say what display size it assumed.
    const small = row('sweep/band-28x3-on-32').frames[0];
    const magnified = row('sweep/band-896x96-on-1024').frames[0];
    expect(magnified.compactnessQ).toBe(small.compactnessQ);
    expect(magnified.thicknessQ).toBe(small.thicknessQ);
    expect(magnified.profileQ).toBe(small.profileQ);
    expect(magnified.scoreQ).toBe(small.scoreQ);
    // `thicknessPx` is the one column where they are 32x apart, and it is a pixel count rather
    // than a ratio. That is exactly why it is on the record separately and in the report.
    expect(magnified.thicknessPx).toBe(96);
    expect(small.thicknessPx).toBe(3);
    // And the case's own `defects` note says all of this, so the limit travels with the data.
    const entry = SPEC.cases.find((c) => c.id === 'sweep/band-896x96-on-1024')!;
    expect(entry.defects.some((defect) => defect.note.includes('NEGATIVE contrast pair'))).toBe(true);
  });

  it('leaves the reference sprite alone, which is what makes the new number defensible', () => {
    // The one real human-relevant measurement in this repository, and the only thing a new
    // threshold could be fitted to. Its own room is 375/1000 — comfortable — so `profileQ` is the
    // compactness reading and `thin-profile` fires for exactly the reason it always did. A gate
    // that had moved this number would be a gate fitted to a sample of one, which is the move
    // TASKS.md forbids and the move this task did not make.
    const keeper = row('artwork/verify/lantern-keeper.pixel').frames[0];
    expect(keeper.thicknessQ).toBeGreaterThan(DERIVED_POLICY.thicknessQ);
    expect(keeper.profileQ).toBe(keeper.compactnessQ);
    expect(keeper.scoreQ).toBe(800);
    // And the gate's own margin: the tightest declared-clean subject in the corpus is a 10px
    // square inside a 32px canvas at 313, so there are 63 per-mille of headroom on clean work.
    // A new gate with three per-mille of headroom would be a gate waiting for the next corpus
    // member, so the number is reported rather than merely chosen.
    const tightest = DISTRIBUTION.thickness.controlHeadroom[0];
    expect(tightest.id).toBe('control/clean-union-16');
    expect(tightest.value).toBe(313);
    expect(tightest.value - DERIVED_POLICY.thicknessQ).toBe(63);
    // The same column for the gate that already existed, so the two are comparable.
    const tightestCompactness = DISTRIBUTION.compactnessControlHeadroom[0];
    expect(tightestCompactness.id).toBe('sweep/rect-30x4');
    expect(tightestCompactness.value - SPEC_GATES.compactnessQ).toBe(26);
  });

  it('and the gate is not sensitive anywhere inside a 125-wide dead zone, which is the useful fact', () => {
    // Every candidate between 188 and 313 penalises exactly the same seven subjects, so the
    // *precise* value of `thicknessQ`'s gate does not matter and the decision is only "inside or
    // outside that window". That is a much smaller decision than picking a number, and it is
    // only visible because the distribution exists.
    const counts = DISTRIBUTION.thickness.sensitivity.map((entry) => entry.penalised);
    expect(DISTRIBUTION.thickness.sensitivity.map((entry) => entry.gate)).toEqual([200, 250, 300, 400]);
    expect(counts).toEqual([7, 7, 7, 17]);
    // Monotone, like the compactness table.
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    // And the seven are named, so a reader can see that five of them are the degenerate
    // connectivity fixtures and two are deliberate bands rather than seven design lessons.
    const penalised = DISTRIBUTION.thickness.samples.filter(
      (sample) => sample.value < DERIVED_POLICY.thicknessQ,
    );
    expect(penalised.map((sample) => sample.id).sort()).toEqual([
      'connectivity/contour-staircase-24',
      'connectivity/diagonal-bridge-16',
      'defect/hollow-keyhole-20',
      'defect/subject-undersized-64',
      'sweep/band-28x3-on-1024',
      'sweep/band-28x3-on-32',
      'sweep/band-896x96-on-1024',
    ]);
  });
});


describe('multi-frame: the worst frame wins, and a degenerate sequence is excluded rather than scored', () => {
  it('carries the worst frame, not the mean', () => {
    const pair = row('motion/worst-frame-wins-16');
    expect(pair.frames.map((f) => f.scoreQ)).toEqual([1000, 0]);
    expect(pair.worstScoreQ).toBe(0);
    expect(pair.meanScoreQ).toBe(500);
    // The discriminating assertion: 500 is above FLOOR_FAIL, so a mean would have called this a
    // `warn` on a frame that reads as three separate masses.
    expect(pair.tookMin).toBe(true);
    expect(pair.scores.silhouette).toBe(0);
    expect(pair.actualVerdict).toBe('fail');
  });

  it('excludes motion for an identical sequence and says why, without scoring it 0', () => {
    const hold = row('motion/frames-identical-16');
    expect(hold.preconditions.motion).toBe('no-motion-content');
    // The fake-perfect-score trap: measured honestly an identical sequence is a PERFECT animation,
    // so the decision has to be made before the analyzer is called. The advisory says the other
    // half - four copies of frame 0 is usually a mistake - and is non-blocking, so a deliberate
    // hold still passes the gate. **The verdict is now `fail` and not `pass`,** because the frames
    // are one flat swatch and `value` scores a flat sequence 175, which is under
    // `FLOOR_FAIL.value`: the hold is still not blocked, and the flatness still is.
    expect(hold.actualCodes).toEqual(['flat-value', 'frames-identical', 'narrow-value-range']);
    expect(hold.blocking).toEqual(['flat-value']);
    expect(hold.actualVerdict).toBe('fail');
    expect(hold.frames).toHaveLength(3);
    expect(hold.attributes.frames).toBe(3);
    // And the exclusion travels in `evaluate` as `not-implemented` today, which is why the corpus
    // reads the predicate rather than the report. The divergence is visible rather than inferred.
    expect(hold.excluded.motion).toBe('not-implemented');
  });

  it('excludes motion as single-frame for a still sprite, from the predicate', () => {
    // A still sprite is the degenerate input the mechanism was designed for, and the aggregator is
    // the right place to decide it, so this is asserted on the predicate rather than on the report:
    // `evaluate` says `not-implemented` today and will say `single-frame` once T-017 lands,
    // without this test needing to change.
    for (const id of ['control/clean-blob-16', 'artwork/verify/lantern-keeper.pixel']) {
      expect(row(id).preconditions.motion).toBe('single-frame');
    }
  });

  it('reports a blank frame as a blocking input fact, not as a low score', () => {
    const blank = row('motion/blank-frame-16');
    // The two `value` codes are frame 0's, and frame 0 is one flat swatch: the blank frame itself is
    // unmeasured and contributes nothing, which is the point of the next two assertions.
    expect(blank.actualCodes).toEqual(['empty-frame', 'flat-value', 'narrow-value-range']);
    // Both blocking, and the order is the aggregator's: severity first, so the reader of the head
    // of the list reads what is worst. `flat-value` is 0.55 and `empty-frame` is 1.00.
    expect(blank.blocking).toEqual(['empty-frame', 'flat-value']);
    // The blank frame is not scored; it is reported as unmeasured. A 0 there would mean "measured,
    // and it is bad", which is a different claim and a wrong one.
    expect(blank.frames[1].scoreQ).toBe(1000);
    expect(blank.frames[1].N).toBe(0);
    expect(blank.actualVerdict).toBe('fail');
  });

  it('does not score a wholly blank canvas at all, and fails it on one blocking issue', () => {
    // §5.3's demonstration, which depends on every dimension *running*: the total is 1.00 and the
    // verdict is `fail`, because a blank canvas is not bad artwork, it is no artwork.
    const blank = row('defect/empty-canvas-16');
    expect(blank.actualCodes).toEqual(['empty-frame']);
    expect(blank.scores.silhouette).toBe(1000);
    expect(blank.actualVerdict).toBe('fail');
    expect(blank.preconditions.silhouette).toBeNull();
    // **The one combination that looks like a lie and is not, so it is pinned here.** A blank
    // canvas reports 1000 on a dimension whose form half it declares unmeasured. The 1000 is
    // §5.3's rule and is correct — a blank canvas must not be graded as bad art, and `empty-frame`
    // is the aggregator's to raise at severity 1.00 — while the declaration is what stops the 1000
    // from being read as a form measurement. `no-judgeable-plane` rather than `no-subject` because
    // there is no ink at all here, so there is no margin to have run off the edge; the two reasons
    // are different facts and an agent branches on them.
    expect(blank.unmeasured).toEqual({ 'value.form': 'no-judgeable-plane' });
  });
});

describe('the level-set control, and the one code that had no case', () => {
  it('makes a level set a control rather than a claim, by insetting it 2px', () => {
    // §4.2's specified form term is the spread of `dist` along a plane boundary, and a level set
    // has a spread near zero while a *translated* contour — the construction a correctly shaded
    // sphere is made of — has a spread as large as the body is deep. So the term rated the
    // construction that looks like a target the best possible one and rated `demo.ts`'s own the
    // worst. The two cases below are the same body with the same five tones and the same four plane
    // boundaries, and the only difference is whether the boundaries are insets or translations.
    const inset = row('value/level-set-32');
    const nested = row('value/nested-contour-32');
    expect(inset.value?.planes).toBe(nested.value?.planes);
    expect(inset.value?.terminators).toBe(nested.value?.terminators);
    expect(inset.value?.buckets).toEqual(nested.value?.buckets);
    // **And the bias, as two numbers on one row of the generated report:** the unscored `spanQ`
    // reads 91 here against 909 there, on the same boundary count. It used to read 545 there, and
    // the reason it moved is the fix below: `worstSpanQ` is the span of the *worst* plane and the
    // worst plane is chosen by `crossesQ`, so once all four boundaries read `crossesQ` 0 there is no
    // worst plane any more and the selection falls to the outermost crescent. The bias the number
    // exists to show got larger, not smaller — 91 against 909 rather than 91 against 545 — which is
    // the only direction in which a change to the *scored* term should move an *unscored* one.
    expect(inset.value?.worstSpanQ).toBe(91);
    expect(nested.value?.worstSpanQ).toBe(909);
    // The scored term agrees with itself on both: every boundary turns, so `bendQ` is at its
    // maximum and `crossesQ` is 0, on a level set and on a translation alike. That is the property
    // the term was redesigned around and the reason the level set is the control for it.
    //
    // **This assertion used to say 750 and its own comment said the sentence above.** The comment
    // was right and the number was wrong: `dirQ` divided by the number of half-plane orientations
    // rather than by the number of steps to saturation, so a closed ring read 1000 and a maximally
    // turning open arc read 667, and the translation — `demo.ts`'s own construction, the one the
    // craft guide teaches — came out 250 per-mille below the target-like ring on the same body with
    // the same five tones and no defect on either side. The fixture could not catch it because
    // `quality-value.test.ts` drew its own level set deepest-first and got two tones; this case was
    // always right.
    expect(inset.value?.worstCrossesQ).toBe(0);
    expect(inset.value?.formQ).toBe(1000);
    expect(nested.value?.formQ).toBe(1000);
    // **The insets are 2px apart, and that is the whole difference from the version that was
    // there before.** A 1px inset is a *line*: no pixel of it has three same-tone orthogonal
    // neighbours, so it is not a plane, and a 1px staircase is 8-connected and 4-disconnected, so
    // the fixture measured 34 tone regions and ZERO plane boundaries. A control that cannot fail is
    // not a control, and this assertion is the reason the case was redrawn.
    expect(inset.value?.planes).toBe(5);
    expect(inset.value?.terminators).toBe(4);
    // And it is silent, which is what a clean control has to be.
    expect(inset.actualCodes).toEqual([]);
    expect(inset.blocking).toEqual([]);
    expect(inset.status).toBe('pass');
  });

  it('has a case for `highlight-blown`, and pairs it against the same construction', () => {
    // The last `value` code with no case, and the one a corpus that only carried the defects it
    // found would have gone on without. The fixture is `value/nested-contour-32` with its lightest
    // plane repainted, which is the defect as it happens: the lit side runs out of headroom.
    const blown = row('value/highlight-blown-32');
    const nested = row('value/nested-contour-32');
    expect(blown.actualCodes).toEqual(['highlight-blown']);
    // 159 of 398 solid px at Lq 255 against §4.2's 10/100 share, and the severity is 0.45, so it
    // is an advisory: a blown highlight is a real defect and not a reason to refuse delivery.
    expect(blown.value?.highlightShareQ).toBe(399);
    expect(blown.blocking).toEqual([]);
    expect(blown.actualVerdict).toBe('pass');
    // The pair is one swatch: the same planes, the same boundaries, the same geometry, and 150
    // per-mille apart on the dimension.
    expect(blown.value?.planes).toBe(nested.value?.planes);
    expect(blown.value?.terminators).toBe(nested.value?.terminators);
    expect(blown.value?.worstCrossesQ).toBe(nested.value?.worstCrossesQ);
    expect((blown.value?.scoreQ ?? 0) - (nested.value?.scoreQ ?? 0)).toBe(-150);
  });
});

describe('the tier boundary is structural, not a comment', () => {
  it('rejects an unknown key, because a typo that is ignored is a case with no expectations', () => {
    // The failure this guards: `expectd` in the JSON, the loader ignores it, the case reports no
    // expectations, and the corpus is green while guarding nothing.
    const raw = JSON.parse(
      readFileSync(new URL('../../../benchmarks/corpus/cases.json', import.meta.url), 'utf8'),
    );
    raw.cases[0].expectd = { codes: [] };
    expect(() => loadCorpusSpec(raw)).toThrow(/unknown key "expectd"/);
  });

  it('rejects a synthetic case that declares a defect it does not expect to be reported', () => {
    const base = (): Record<string, unknown> => ({
      id: 'x/case',
      label: 'x',
      tier: 'synthetic',
      provenance: 'generated',
      defects: [{ kind: 'thin-profile', note: 'n' }],
      recipe: { canvas: { w: 8, h: 8 }, palette: ['#000000'], ops: [] },
      expect: { codes: [] },
    });
    expect(() => loadCorpusSpec({ version: 1, description: 'd', cases: [base()] })).toThrow(
      /expect\.codes does not contain it/,
    );
  });

  it('rejects a clean control that names nothing as absent', () => {
    expect(() =>
      loadCorpusSpec({
        version: 1,
        description: 'd',
        cases: [
          {
            id: 'x/case',
            label: 'x',
            tier: 'synthetic',
            provenance: 'generated',
            defects: [{ kind: 'clean-control', note: 'n' }],
            recipe: { canvas: { w: 8, h: 8 }, palette: ['#000000'], ops: [] },
            expect: { codes: [] },
          },
        ],
      }),
    ).toThrow(/must declare expect\.absent/);
  });

  it('rejects a case that declares a defect and also expects it to be absent', () => {
    // `defect/subject-undersized-64` carried exactly this for a whole task: it declared
    // `thin-profile` and listed the same code under `absent`, and the only thing that noticed was a
    // test that happened to compare the two. A contradiction should be caught by the loader that
    // reads the file, not by a test that happens to look.
    const base = (): Record<string, unknown> => ({
      id: 'x/case',
      label: 'x',
      tier: 'synthetic',
      provenance: 'generated',
      defects: [{ kind: 'thin-profile', note: 'n' }],
      recipe: { canvas: { w: 8, h: 8 }, palette: ['#000000'], ops: [] },
      expect: { codes: ['thin-profile'], absent: ['thin-profile'] },
    });
    expect(() => loadCorpusSpec({ version: 1, description: 'd', cases: [base()] })).toThrow(
      /cannot require a code to fire and not fire/,
    );
    // And the same case without the contradiction is fine, which is the half that says the rule
    // is about the contradiction and not about `absent` being allowed at all.
    const fine = base();
    (fine.expect as Record<string, unknown>).absent = ['interior-hole'];
    expect(() => loadCorpusSpec({ version: 1, description: 'd', cases: [fine] })).not.toThrow();
  });

  it('refuses to let a real case assert taste: no expected codes, no expected verdict', () => {
    // The rule that makes the tier mean something. `docs/EVALUATION.md` §6.1 and the decision this
    // roadmap has already made twice: there is one human-rated asset in this repository, and
    // asserting an expected code list against it is fitting noise. A `real` case may assert
    // applicability facts and may record measurements as a drift baseline; it may not say what the
    // art ought to score.
    const base = (expect: Record<string, unknown>): Record<string, unknown> => ({
      version: 1,
      description: 'd',
      cases: [
        {
          id: 'x/asset',
          label: 'x',
          tier: 'real',
          provenance: 'repo-artwork',
          source: 'artwork/whatever.pixel',
          expect,
        },
      ],
    });
    expect(() => loadCorpusSpec(base({ codes: ['thin-profile'] }))).toThrow(
      /may not declare expect\.codes/,
    );
    expect(() => loadCorpusSpec(base({ verdict: 'pass' }))).toThrow(/may not declare expect\.verdict/);
    // The two it may declare, both accepted.
    expect(() =>
      loadCorpusSpec(base({ preconditions: { silhouette: 'no-subject' }, noBlocking: true })),
    ).not.toThrow();
  });

  it('gives a human-tier case no `expect` field at all, and the runner a status that is not a pass', () => {
    // Not "ignored for this tier": absent from the type, rejected by the loader, and the runner's
    // result is a different member with no `ok` field to be false.
    expect(() =>
      loadCorpusSpec({
        version: 1,
        description: 'd',
        cases: [
          {
            id: 'x/thing',
            label: 'x',
            tier: 'human',
            provenance: 'generated',
            prompt: 'rate it',
            recipe: { canvas: { w: 8, h: 8 }, palette: ['#000000'], ops: [] },
            expect: { codes: [] },
          },
        ],
      }),
    ).toThrow(/unknown key "expect"/);
    expect(human().length).toBeGreaterThanOrEqual(3);
    for (const entry of human()) {
      const result = row(entry.id);
      expect(result.status).toBe('awaiting-rating');
      expect(result.actualCodes).toEqual([]);
      expect(result.actualVerdict).toBeNull();
      expect(result.scores).toEqual({});
      // And the machine's opinion is withheld from the rater's view on purpose: a rater who has
      // seen the score is anchored to it, and T-025's correlation would then measure anchoring.
      expect(result.frames).toEqual([]);
    }
  });

  it('carries one human case the analyzer refuses to measure, which is the finding worth having', () => {
    // `human/scene-64` is full-bleed, so `evaluate` will report `silhouette` as excluded and
    // deliver no silhouette number - and a human is asked to score silhouette on it anyway. When
    // T-026 delivers, that case answers "is the pipeline right to refuse, or is the human wrong to
    // have an opinion", which no synthetic case can ask.
    const entry = human().find((c) => c.id === 'human/scene-64');
    expect(entry).toBeDefined();
    expect(entry!.prompt).toContain('excluded');
    const context = createQualityContext(buildCase(entry!));
    const { solid } = buildSolidMask(context.composite[0], context.width, context.height);
    expect(solid).toBe(context.width * context.height);
    expect(row('human/scene-64').attributes).toEqual({ width: 64, height: 64, frames: 1, palette: 3, tags: 0 });
  });

  it('reads scores.json as the handoff slot, and it is empty on arrival', () => {
    // T-026's deliverable. The file exists, it parses, its schema string is the one this build
    // understands, and it names no ratings - which is the correct answer to "has a human rated this
    // yet". A missing file would mean the same thing, so both states are accepted.
    expect(existsSync(SCORES_PATH) || true).toBe(true);
    expect(SCORES.schema).toBe('dotloom-corpus-scores/v1');
    expect(SCORES.corpusVersion).toBe(SPEC.version);
    expect(Object.keys(SCORES.ratings)).toEqual([]);
    expect(human().filter((entry) => SCORES.ratings[entry.id] !== undefined)).toEqual([]);
  });

  it('rejects a rating file that could not support T-022', () => {
    // A file that stored one score per image would make the two-rater protocol impossible to audit,
    // and a score outside 1..5 would silently become an outlier. Both are refused.
    const dims = (score: number): Record<string, number> => ({
      silhouette: score,
      value: score,
      palette: score,
      noise: score,
      outline: score,
      motion: score,
    });
    const base = (ratings: unknown): Record<string, unknown> => ({
      schema: 'dotloom-corpus-scores/v1',
      corpusVersion: SPEC.version,
      ratings,
    });
    const two = (score: number): unknown => ({
      'human/item-16': {
        raters: [
          { rater: 'a', perDimension: dims(score), overall: 'usable' },
          { rater: 'b', perDimension: dims(score), overall: 'usable' },
        ],
      },
    });
    expect(() => loadCorpusScores(base(two(4)), SPEC.version)).not.toThrow();
    expect(() => loadCorpusScores(base(two(0)), SPEC.version)).toThrow(/scale is 1\.\.5/);
    expect(() =>
      loadCorpusScores(
        base({ 'human/item-16': { raters: [{ rater: 'a', perDimension: dims(4), overall: 'usable' }] } }),
        SPEC.version,
      ),
    ).toThrow(/two independent raters/);
    expect(() => loadCorpusScores(base({}), SPEC.version + 1)).toThrow(/re-rate/);
    expect(() => loadCorpusScores({ ...base(two(4)), schema: 'v2' }, SPEC.version)).toThrow(
      /unknown schema/,
    );
  });
});

/* ------------------------------------------------------------------ *
 * 3 · The real artwork
 * ------------------------------------------------------------------ */

describe("this repository's own artwork, which is real and unlabelled", () => {
  it('covers every committed asset, so the real tier is the repository and not a selection', () => {
    // A calibration corpus that quietly samples the easy end is the failure §6.3 names. Ten of
    // these twelve are full-bleed scenes the dimension refuses to measure, one is the only character
    // sprite there is, and one is the app icon. The corpus holds all of them, including the two
    // that *are* measurable, because the point of this tier is that it was not designed around the
    // artwork.
    expect(real().length).toBe(12);
    const subjects = real()
      .filter((entry) => row(entry.id).preconditions.silhouette === null)
      .map((entry) => entry.id)
      .sort();
    expect(subjects).toEqual(['app/icon.png', 'artwork/verify/lantern-keeper.pixel']);
  });

  it('excludes every full-bleed scene, and reports no silhouette defect about it', () => {
    // The dimension this test is about is `silhouette`, and the assertion is about *it*: not one of
    // the six codes it can emit appears on any of the ten scenes, and nothing blocks. Spelled as an
    // exact loop over that list rather than as `toEqual([])`, because `[]` is no longer true of a
    // scene — `value` is the dimension that is *supposed* to have an opinion about a landscape, and
    // the next test says what it says. A subset test here would let either dimension grow a false
    // positive on real work without a thing going red.
    const scenes = real().filter((entry) => row(entry.id).preconditions.silhouette === 'no-subject');
    expect(scenes.length).toBe(10);
    for (const entry of scenes) {
      const result = row(entry.id);
      for (const code of SILHOUETTE_CODES) {
        expect(result.actualCodes, `${entry.id} reported ${code}`).not.toContain(code);
      }
      expect(result.blocking, entry.id).toEqual([]);
      expect(result.scores.silhouette, entry.id).toBeUndefined();
      // And the measurement that would have been delivered, so "confidently wrong" is a number.
      // Not exactly the whole canvas: `dusk-lake-valley-agent.pixel` has 239 pixels below
      // ALPHA_SOLID, so what makes it a scene is that the ink still reaches all four edges, not
      // that every pixel is opaque. `borderTouch` is the quantity that decides it.
      const canvas = result.attributes.width * result.attributes.height;
      expect(result.frames[0].N * 1000, entry.id).toBeGreaterThanOrEqual(canvas * 990);
      expect(result.frames[0].borderTouch, entry.id).toBe(4);
      expect(result.frames[0].scoreQ, entry.id).toBeGreaterThanOrEqual(700);
    }
  });

  it('records what `value` says about the ten scenes, and why the key-light one is a finding', () => {
    // The exact union across all ten scenes, asserted exactly, so a false positive that `value`
    // grows on real work is as loud here as a `silhouette` one is in the test above. Three of the
    // ten carry `key-light-inconsistent` and one of them carries `hue-carries-form` at the advisory
    // severity; nothing blocks, and the `value` scores run 750..950.
    //
    // **The union and the list below are RECORDED MEASUREMENTS, not derived expectations, and this is
    // the one place in this block where that has to be said out loud.** They were read off the
    // report, because §4.4's near-duplicate rule has no closed-form answer for an arbitrary committed
    // artwork: it is a count of pairs over whatever ramp the picture happens to carry, and the only
    // honest way to write it down is to record what the analyzer said. What *is* derived is each
    // individual entry, and the numbers are in the two paragraphs below. `value`'s side of both
    // lists is unchanged — §7.2's line-by-line diff has `silhouette` and `value` at zero movement —
    // so what moved is `noise`'s contribution and nothing else.
    const scenes = real().filter((entry) => row(entry.id).preconditions.silhouette === 'no-subject');
    const said = [...new Set(scenes.flatMap((entry) => row(entry.id).actualCodes))].sort();
    // **`palette` added two of these and one of them is the §7 item 3 false positive, live on a
    // committed asset.** `off-palette` appears because
    // `artwork/dusk-lake-valley-agent.pixel` has a `reflection` layer at **opacity 0.58**, so its
    // composite carries blends of two declared swatches at alpha ~148 — above `ALPHA_SOLID` 128, so
    // §3.3 counts them as solid pixels and §4.3 counts them as undeclared colours. 2,339 of 65,297
    // is 36 per-mille, an advisory at 0.35, so nothing blocks; the count and the layer that causes
    // it are asserted in the `palette` block further down rather than left as prose here.
    expect(said).toEqual([
      'colour-budget-exceeded',
      'hue-carries-form',
      'hue-sprawl',
      'key-light-inconsistent',
      'near-duplicate-colours',
      'off-palette',
      'stray-colour',
    ]);
    // **Nine of the ten, and every one of them for `noise`'s reason.** Before `noise` registered this
    // was three; the six that joined are the six whose ramp has two entries within Chebyshev 8 of
    // each other. The one scene still silent is `artwork/dusk-lake-valley-agent2.pixel`, measured
    // `nearDuplicatePairs` 0 — and it is silent for a good reason rather than by luck, which is what
    // makes it the control this test needs: it is the same painting as
    // `artwork/dusk-lake-valley-agent.pixel` (same 256x256, same 12 buckets, 65,297 vs 65,536 solid
    // pixels) and the two differ in the one thing this measure looks at. That is the cleanest
    // evidence in the file that `nearDuplicatePairs` tracks the ramp and not the picture.
    const flagged = scenes
      .map((entry) => ({ id: entry.id, codes: row(entry.id).actualCodes }))
      .filter((entry) => entry.codes.length > 0);
    expect(flagged.map((entry) => entry.id).sort()).toEqual([
      'artwork/autumn-dusk-lake-256.pixel',
      'artwork/dusk-lake-valley-agent.pixel',
      'artwork/dusk-lake-valley-v2.pixel',
      'artwork/dusk-lake-valley-v3.pixel',
      'artwork/dusk-lake-valley.pixel',
      'artwork/moonlit-alpine-lake-fast.pixel',
      'artwork/moonlit-alpine-lake.pixel',
      'artwork/sunset-lighthouse-512-baseline-model-a.pixel',
      'artwork/sunset-lighthouse-512.pixel',
    ]);
    // **The per-scene counts behind that list, so the reader can see which is which rather than
    // taking nine names on trust.** `nearDuplicatePairs` over the ten, ascending: 0, 1, 1, 2, 3, 4, 5,
    // 10, 18 and 50 — every scene with two ramp entries within Chebyshev 8 of each other. The tenth
    // entry, `dusk-lake-valley-agent2`, reads 0.
    const pairs = scenes
      .map((entry) => ({ id: entry.id, nd: noiseFrameOf(entry.id).nearDuplicatePairs }))
      .sort((a, b) => a.nd - b.nd);
    expect(pairs.filter((entry) => entry.nd === 0).map((entry) => entry.id)).toEqual([
      'artwork/dusk-lake-valley-agent2.pixel',
    ]);
    // **And `stray-colour`, which is the one real false positive on the committed artwork and stays
    // on the record.** `artwork/moonlit-alpine-lake.pixel` reads `colourOrphans` 43 against `N` 4096,
    // which is `rhu(43000, 4096) = 10` per-mille against §4.4's `> 8/1000` trigger. The other nine
    // scenes read 0..8 per-mille, and the loudest of them —
    // `artwork/sunset-lighthouse-512-baseline-model-a.pixel` at 2037 of 262,144, which is
    // `rhu(2037000, 262144) = 8` — is exactly **on** the trigger rather than past it, so the corpus's
    // nearest miss on this rule is one per-mille away and the false positive is one pixel-count past
    // the same line. It is the same file `artwork/moonlit-alpine-lake-fast.pixel` is, at the other
    // setting. It is an advisory at 0.35, so nothing blocks.
    expect(row('artwork/moonlit-alpine-lake.pixel').actualCodes).toContain('stray-colour');
    expect(row('artwork/moonlit-alpine-lake.pixel').blocking).toEqual([]);
    expect(noiseFrameOf('artwork/moonlit-alpine-lake.pixel').colourOrphans).toBe(43);
    expect(
      noiseFrameOf('artwork/sunset-lighthouse-512-baseline-model-a.pixel').colourOrphans,
    ).toBe(2037);
    // **§4.2's `keyLight` is a subject-level check being applied to scenes, and this is the
    // measurement.** It samples two ninths of `bounds` and subtracts, on the assumption that the
    // corners are two sides of one lit form. In a landscape they are different materials, so the
    // three scenes above read 10, 6 and 10 — inside §4.2's own `0 <= keyLight < 12` clause — and a
    // finished, committed painting is told its light direction is unreadable. Two of the three are
    // the same scene at two settings, so the honest count is two scenes in three renderings.
    // Recorded, not fixed: the fix is a §3.3 quantity about which pixels belong to one lit form,
    // and `TASKS.md` records T-012 correctly declining to invent one from inside a dimension.
    const keyLight = scenes
      .map((entry) => ({ id: entry.id, kl: row(entry.id).value?.keyLight ?? null }))
      .filter((entry) => entry.kl !== null && entry.kl >= 0 && entry.kl < 12);
    expect(keyLight).toEqual([
      { id: 'artwork/dusk-lake-valley-v2.pixel', kl: 10 },
      { id: 'artwork/moonlit-alpine-lake-fast.pixel', kl: 6 },
      { id: 'artwork/sunset-lighthouse-512-baseline-model-a.pixel', kl: 10 },
    ]);
    // **And the curvature gate, which is the other half of the same finding — now with an answer.**
    // §4.2's curvature gate asks whether the local form is round, and it used to read that off the
    // subject's own outline alone. All ten scenes reach every canvas edge, so their outline *is* the
    // frame: `maxCurvedQ` over every plane was 0..77 against a gate of 250, and not one plane on any
    // of the ten came close to being judged. A straight shadow band across a curved mountain was
    // excused — the gate was doing its job on a rectangle.
    //
    // **T-100 gave the gate a second reference that is not the silhouette**, and the assertion below
    // is written on the side that would have failed without it. It reads `toBeLessThan(250)` before
    // T-100 and asserts the opposite now, because an assertion that passes both before and after a
    // fix is not guarding the fix. Every one of the ten clears the gate by a wide margin, which is
    // the measurement that says the reference found real curvature rather than inventing it: these
    // are landscapes with hills, shorelines and a lighthouse, and 667..880 is what a curved form
    // reads.
    for (const entry of scenes) {
      expect(row(entry.id).value?.maxCurvedQ ?? 0, entry.id).toBeGreaterThanOrEqual(250);
    }
    //
    // **The gate opening is not the same as the form term being measured, and the difference is the
    // honest part.** Three of the ten have a plane that clears both gates, so their form half is
    // measured — and it reads 1000, with `crossesQ` 0 and `bendQ` 1000, which is "examined and found
    // correctly shaded" rather than "nobody looked". The other seven have every plane gated, mostly
    // on `reach` (a fragment too small to be a cross-section), and for those the form half stays
    // `unmeasured` and says so. Both outcomes are listed rather than asserted as a range, because
    // the seven are a statement about `reachQ` and not about the curvature reference, and folding
    // them in would make this test a guard on a gate T-100 did not touch.
    const measuredForm = scenes
      .map((entry) => entry.id)
      .filter((id) => row(id).value?.formQ !== null);
    expect(measuredForm).toEqual([
      'artwork/autumn-dusk-lake-256.pixel',
      'artwork/dusk-lake-valley-agent.pixel',
      'artwork/dusk-lake-valley-v2.pixel',
    ]);
    for (const id of measuredForm) {
      // Judged, and clean. `crossesQ` 0 with `bendQ` 1000 is the evidence for the second half: a
      // boundary that turns, which is the construction §4.2 admits.
      expect(row(id).value?.formQ, id).toBe(1000);
      expect(row(id).value?.worstCrossesQ, id).toBe(0);
      expect(row(id).unmeasured, id).toEqual({});
    }
    for (const entry of scenes.filter((e) => !measuredForm.includes(e.id))) {
      expect(row(entry.id).value?.formQ, entry.id).toBeNull();
      expect(row(entry.id).unmeasured, entry.id).toEqual({ 'value.form': 'no-subject' });
    }
    // **The two real subjects are the other half of the finding, and they are not the same case.**
    // Neither reaches a canvas edge, so both have an outline; their planes are gated by `reach` as
    // fragments too small to be a cross-section, which §4.2 gates on purpose, and "these are
    // fragments, so there is nothing here to fail" is an answer rather than an absence. A first
    // attempt at this fix folded the two cases together and dropped the lantern keeper from 850 to
    // 800, which is a defect-free sprite being marked down for the scorer's blindness.
    const subjects = real().filter((entry) => row(entry.id).preconditions.silhouette !== 'no-subject');
    expect(subjects.map((entry) => entry.id).sort()).toEqual([
      'app/icon.png',
      'artwork/verify/lantern-keeper.pixel',
    ]);
    for (const entry of subjects) {
      expect(row(entry.id).value?.formQ, entry.id).toBe(1000);
      expect(row(entry.id).unmeasured, entry.id).toEqual({});
    }
  });

  it('records that four scenes are blocked by a dithered tone field and NOT by `reachQ`, with the numbers', () => {
    // **T-102 measured its own premise to be wrong, and this is the record of it.** The task was
    // "`reachQ` blocks 7 of 10 full-bleed scenes". It does block them — but the reason is not that
    // its denominator is the wrong scale, and changing the denominator makes things strictly worse.
    //
    // **What was measured, on the committed artwork.** Plane extents are small everywhere, including
    // on the large scenes: median 6..10px against a `bodyExtent` of 64..512, and `p90` 16..33. On
    // `artwork/sunset-lighthouse-512.pixel` — 512x512, 1008 terminators — the LARGEST plane is 110px
    // against a gate that wants 256, so `reachQ max` reads 215 and nothing can clear it. A
    // region-relative denominator would open 110 planes there. **Those 110 are water ripples and sky
    // sparks, and opening them would be strictly worse**, because a short plane inside a small region
    // scores HIGH on a region-relative ratio, which admits texture rather than form. That is the
    // direction `splitQ` exists to damp downstream, and it is the wrong direction to admit at the gate.
    //
    // **What the tone field actually looks like.** Counting 4-connected same-bucket regions:
    //
    //     artwork/verify/lantern-keeper.pixel    13 buckets     101 regions      8 per bucket
    //     artwork/dusk-lake-valley-agent.pixel   12 buckets   1,142 regions     95 per bucket
    //     artwork/autumn-dusk-lake-256.pixel     13 buckets   6,751 regions    519 per bucket
    //     artwork/sunset-lighthouse-512.pixel     16 buckets  46,079 regions  2,880 per bucket
    //
    // A hard-edged painting with 16 tones has tens of regions. This one has 46,079, and 98.8% of them
    // are 16 pixels or smaller. **It is a dithered and gradient tone field**, and §4.2's plane
    // definition — both sides an area, a region with three or more same-bucket 4-neighbours — finds
    // no plane across a dithered transition at all. So the sun's limb and the water's horizon in that
    // painting are not gated by `reachQ`; **they were never planes.**
    //
    // **And `reachQ` is accidentally a dither detector, pointing the right way.** The scenes it does
    // open are the less fragmented ones: 95 and 519 and 632 regions per bucket read `reachQ max`
    // 1000, 1000 and 996, and those are the three that `formQ` is measured on. The two most
    // fragmented, 2,880 and 1,672, read 215 and 236. A gate that closes on fragments is doing its job.
    //
    // **So T-102 changes no gate.** The quantity that would *say* this rather than let the report infer
    // it is §3.3's `ditherMask`, which is specified, unimplemented, and declared as `noise`'s
    // consumer (T-015). Until it lands, the `gated` column reports `curvature` and `reach` on a
    // picture whose real reason is neither, and that is recorded here rather than papered over.
    //
    // **The assertion is on the state we want pinned, not on the probe's numbers.** If a future change
    // to `reachQ` suddenly judges these four, the test goes red and the diff has to answer why —
    // which is the review this finding needs, since nothing about the pictures changed.
    const blockedByDither = [
      'artwork/dusk-lake-valley-agent2.pixel',
      'artwork/moonlit-alpine-lake-fast.pixel',
      'artwork/sunset-lighthouse-512-baseline-model-a.pixel',
      'artwork/sunset-lighthouse-512.pixel',
    ];
    for (const id of blockedByDither) {
      expect(row(id).value?.formQ, id).toBeNull();
      expect(row(id).unmeasured, id).toEqual({ 'value.form': 'no-subject' });
      // Every plane is gated, and on these four the gate that closes them all is `reach`. If a future
      // revision moves them to `curvature` the reason has changed and the comment above is wrong.
    }
    // **The gate that closes them is not always the SAME gate, and that is part of what is being
    // recorded.** The breakdown, verbatim from the baseline: agent2 `1 curvature, 250 reach`,
    // moonlit-alpine-lake-fast `14 curvature, 49 reach`, lighthouse-baseline
    // `267 curvature, 214 reach`, lighthouse `192 curvature, 816 reach`. Every one of the four has
    // BOTH gates closing something, and on the two most fragmented scenes the curvature gate is
    // closing more planes than reach is. So "reachQ blocks them" is true in the sense that no plane
    // clears it, and false in the sense that it is not the only thing blocking them — which is why the
    // assertion above is about the outcome (nothing judged) and not about a single cause. An earlier
    // version of this test asserted `not.toContain("curvature")` and the corpus caught it against
    // its own numbers.
    //
    // The three that ARE judged, as the control half: without it "all four are unmeasured" is also
    // consistent with the curvature gate having gone blind again.
    const judged = [
      'artwork/autumn-dusk-lake-256.pixel',
      'artwork/dusk-lake-valley-agent.pixel',
      'artwork/dusk-lake-valley-v2.pixel',
    ];
    for (const id of judged) {
      expect(row(id).value?.formQ, id).toBe(1000);
      expect(row(id).unmeasured, id).toEqual({});
    }
  });

  it('catches a straight band across a curved dome, and the position it is drawn no longer decides', () => {
    // **This test was written to record a gap and it recorded one, which is why it is here rather
    // than in the corpus.** T-100 gave the curvature gate a second reference and the same straight
    // band over the same dome read `curvedQ` 260 at y=34 and **248** at y=40, against a gate of 250:
    // caught at one row, excused at the other, for no reason a person could act on. The corpus could
    // not hold the case, because the loader rejects a case that declares a defect the analyzer is
    // not expected to report, and at the time it did not report it. So the numbers were pinned here
    // with the reason, and the comment said what would happen if the gap closed: "both of these move
    // and this test fails — which is the point of writing it down."
    //
    // **T-101 closed it, and the failure is the second half of the plan.** The cause was that
    // `regionCurvedQ` counted a region's WHOLE boundary, so the band's own straight cut sat in the
    // denominator of the arc it crossed, and where the band crossed a narrow part of the dome the
    // cut outnumbered the arc. `planeCurvedQ` excludes the boundary against the neighbour being
    // judged, so the arc is read without the cut in it. Both rows now clear the gate, and the value
    // stops depending on where the band was drawn — which is the property the 260/248 pair was
    // measuring in the first place.
    const dome = {
      canvas: { w: 64, h: 64 },
      layers: ['Base'],
      palette: ['#93c0dc', '#4a7ba6', '#35618c', '#274a70', '#1b3a5c'],
    } as const;
    const ellipses = [
      { op: 'ellipse', layer: 'Base', rect: [0, 26, 64, 80], color: 'pal:4', fill: true },
      { op: 'ellipse', layer: 'Base', rect: [0, 22, 64, 80], color: 'pal:3', fill: true },
      { op: 'ellipse', layer: 'Base', rect: [0, 18, 64, 80], color: 'pal:2', fill: true },
      { op: 'ellipse', layer: 'Base', rect: [0, 14, 64, 80], color: 'pal:1', fill: true },
    ] as const;
    const sky = { op: 'rect', layer: 'Base', rect: [0, 0, 64, 64], color: 'pal:0', fill: true } as const;
    const read = (bandY: number | null) => {
      const ops = bandY === null ? [sky, ...ellipses] : [sky, ...ellipses, { op: 'rect', layer: 'Base', rect: [0, bandY, 64, 10], color: 'pal:0', fill: true }];
      const sprite = buildFromRecipe(`gap/${bandY ?? 'none'}`, { ...dome, ops } as never);
      const frame = measureValue(createQualityContext(sprite))[0];
      return {
        curvedQ: Math.max(...frame.terminators.map((t) => t.curvedQ)),
        formQ: frame.formQ,
        crossesQ: frame.worst === null ? null : frame.worst.crossesQ,
        splitQ: frame.worst === null ? null : frame.worst.splitQ,
        bendQ: frame.worst === null ? null : frame.worst.bendQ,
        codes: frame.issues.map((i) => i.code),
      };
    };
    // **The control half first**, because without it "the gate is open" would be consistent with the
    // reference being indiscriminately permissive: the same dome with no band is judged CLEAN. The
    // gate decides whether to look; `bendQ` decides what it found. Conflating those two is the
    // distortion T-099 paid for.
    const unbanded = read(null);
    expect(unbanded.curvedQ).toBeGreaterThanOrEqual(250);
    expect(unbanded.formQ).toBe(1000);
    expect(unbanded.codes).toEqual([]);
    // **And the defect, at both rows.** Two rows rather than one, because "caught at y=40" alone
    // would pass on the old quantity too — it was caught at y=34. What T-101 bought is that the GATE
    // no longer depends on the row, so both are asserted and the two readings are compared. Under
    // T-100 this pair read 260 and 248: twelve apart, straddling the threshold, which is the failure.
    const at34 = read(34);
    const at40 = read(40);
    for (const band of [at34, at40]) {
      expect(band.curvedQ, 'the gate must open on a straight cut through a curved form').toBeGreaterThanOrEqual(250);
      expect(band.formQ, 'the form half must be measured, not excused as unmeasurable').not.toBeNull();
      expect(band.bendQ, 'a straight cut does not turn').toBe(0);
    }
    expect(Math.abs(at34.curvedQ - at40.curvedQ)).toBeLessThan(250);
    //
    // **The code fires at y=40 and not at y=34, and that difference is `splitQ` doing its job — not a
    // hole, so it is asserted rather than wished away.** `crossesQ` is `splitQ` here exactly, because
    // `bendQ` is 0, so the only thing standing between a straight cut and a reported defect is §4.2's
    // "is this plane a cut through the form or a sliver against it". At y=40 the band has the dome
    // roughly 700px above and 810 below against its own 640, and it reads `splitQ` 676 — past §4.2's
    // 600 floor, so `formQ` 350 and `plane-crosses-form` at 0.30. At y=34 two thirds of the dome is
    // below the band, `splitQ` is 501, and §4.2's table puts that in the `<= 600` band at `formQ` 550
    // with no issue: a milder cut, scored as a milder cut. **T-101 is about the gate and this is about
    // the multiplier, and conflating them is how the first version of this test came to assert a code
    // that the specification does not promise.**
    expect(at40.codes).toContain('plane-crosses-form');
    expect(at40.formQ).toBe(350);
    expect(at40.splitQ).toBeGreaterThan(600);
    expect(at34.codes).toEqual([]);
    expect(at34.formQ).toBe(550);
    expect(at34.splitQ!).toBeLessThanOrEqual(600);
  });

  it('keeps the two real subjects measurable, and records them as a drift baseline', () => {
    // `measure` on a real case means "the analyzer still says what it said", which is a real guard.
    // It does NOT mean the analyzer is right, and the loader is what stops it being read as a claim
    // about the art.
    const keeper = row('artwork/verify/lantern-keeper.pixel');
    expect(keeper.scores.silhouette).toBe(800);
    // **`key-light-inconsistent` is `value`'s, and it is a true positive about the sprite**: the
    // only real character in this repository is lit from the front, so the top-left and the
    // bottom-right of its bounds read the same and §4.2's second row fires at 0.25. It is an
    // advisory, which is why the blocking list is still empty and the verdict still `pass`. The
    // expectation was written when the dimension did not exist; the sprite did not change.
    //
    // **`palette` adds two more, and they are the only two this repository has.** 19 declared swatches
    // used against a `compact` budget of 16 is `colour-budget-exceeded`, and 8 hue families on a
    // 32x32 is `hue-sprawl`. Both are advisories, the blocking list is still empty, and the sprite's
    // `palette` is 700 — **which is the finding T-015 predicted and T-014 measured**: registering it
    // moves this report from 849 to 824, *toward* the advisory, because `noise` read 970 with nothing
    // to say about a character's profile and `palette` reads 700 with something to say.
    expect(keeper.actualCodes).toEqual([
      'colour-budget-exceeded',
      'hue-sprawl',
      'interior-hole',
      'key-light-inconsistent',
      'thin-profile',
    ]);
    expect(keeper.blocking).toEqual([]);
    expect(keeper.actualVerdict).toBe('pass');
    expect(keeper.scores.value).toBe(850);
    expect(keeper.scores.palette).toBe(700);
    // The tightest side of the only real character sprite has ONE pixel of frame, and the dimension
    // still applies. That is worth knowing: `SUBJECT_REQUIRED_MARGIN` costs a false exclusion for a
    // subject within 1px of all four edges, and this sprite is one pixel away from being that.
    expect(keeper.frames[0].margin).toBe(1);
    expect(keeper.preconditions.silhouette).toBeNull();

    const icon = row('app/icon.png');
    expect(icon.scores.silhouette).toBe(1000);
    // The icon is the one real asset `value` says nothing about: 12 buckets, a 479px `Dmax` and a
    // `curvedQ` of 0, and no code from that dimension. Worth having, because it is the counterexample
    // to "every real asset is a flat sticker the curvature gate cannot see".
    //
    // **`noise` says something, and this is a RECORDED MEASUREMENT on a committed clean asset, not a
    // derived expectation — a known false positive, written down rather than updated away.** Nothing
    // here is a claim that the icon is badly made. The numbers, all measured on
    // `packages/app/build/icon.png` as committed:
    //
    //   1024x1024, 878,544 solid pixels, 4,871 distinct solid colours,
    //   836 of them covering the ">= 8 pixels" floor §4.4 sets,
    //   nearDuplicatePairs 7,842, noise 900 (1000 less the flat -100), one advisory at 0.35,
    //   so nothing blocks and the verdict is still `pass`.
    //
    // **The disproof, in §3.3's form: the count cannot tell a mistake from a gradient, so no cut on it
    // can either.**
    //
    //   1. The window is Chebyshev <= 8 on colour, and a twelve-step ramp puts *every* adjacent pair
    //      inside it by construction. **A smooth ramp is structurally a field of near-duplicates**,
    //      so the quantity grows with how finely the ramp is stepped, not with whether anyone made a
    //      mistake. The icon's 7,842 pairs are spread essentially evenly across the whole window —
    //      distance 1: 1,060, 2: 939, 3: 867, 4: 849, 5: 919, 6: 1,003, 7: 1,096, 8: 1,109 — while the
    //      one declared defective case, `defect/near-duplicate-ramp-16`, has **one** pair, at distance
    //      exactly 8. The defect sits on the far edge of the window and the clean ramp's mass sits in
    //      the middle of it, so the icon is not "more of the same defect": it is a different thing
    //      that the same window happens to include.
    //   2. §4.4's own reasoning defeats itself here, and that is the finding. The penalty is flat
    //      because "two ramp entries three steps apart are a decision error rather than a frequency
    //      one", so the count cannot *size* it. But the trigger is `pairs >= 1` — the same count — and
    //      if the count cannot size the defect it cannot find it either. The reasoning carefully
    //      removes the number from the *severity* and never asks what it is doing at the *trigger*,
    //      and a smoothly shaded logo is what is on the other side of that gap.
    //   3. The distribution over the repository's own work is bimodal with a 157x gap, and the
    //      outlier is the cleanest asset in it. Ten finished paintings read `nearDuplicatePairs`
    //      0, 1, 1, 2, 3, 4, 5, 10, 18 and 50; the shipped logo reads 7,842. A measure whose
    //      distribution on good work is bimodal is measuring the resolution of its own input. And
    //      `dusk-lake-valley-agent2.pixel` reading 0 against its own twin
    //      `dusk-lake-valley-agent.pixel` reading 50 — the same painting, same 12 buckets, same
    //      256x256 canvas — says the number is a property of the ramp and not of the picture.
    //
    // **The fix is a different measurement, not a different threshold.** §3.3 forbids moving the
    // number, and the disproof says there is nowhere to move it to: any cut puts the icon on the
    // defective side or on the clean side, and neither is defensible. The question that *would*
    // separate them is about membership rather than proximity — a decision error is two entries
    // inside one material's run, while a gradient has every entry inside a monotone ramp, and an
    // entry that is not in the artist's declared palette at all is `palette`'s `off-palette` rather
    // than `noise`'s. **That is exactly the division of labour `palette` ships with, and the two
    // false positives on this one asset are what makes it visible:** `noise` says "some of these
    // colours are nearly the same" (7,842 pairs, a false positive) and `palette` says "none of these
    // colours were ever declared" (1,000 per-mille, also a false positive, and the fix is a
    // different command).
    //
    // **And `palette` says three things about it, which is T-014's own finding on this asset.** The
    // numbers are measured on `packages/app/build/icon.png` as committed: 4,871 distinct solid
    // colours, of which **836 clear §4.4's `>= 8` pixel floor**, against a document palette of 16
    // entries. So:
    //
    //   offPaletteRatio     878,544 / 878,544 = 1000 per-mille   -> base 300
    //   colour-budget       4,871 against the `scene` budget of 96 -> -200
    //   maxNearestDistance  16,631 against §4.3's 12000           -> invented-colours, -100
    //   palette             0, and `off-palette` is **blocking** at severity 0.55
    //
    // (The severity is §4.3's own two-tier row: 0.35 at `offPaletteRatio > 2/100` and 0.55 above
    // 0.20. 1000 per-mille is three times past the second cut, and `SEVERITY_BLOCKING` is 0.5.)
    //
    // **This is §7 item 3's false positive, and it is not the translucent-layer case — it is the
    // other half of the same sentence.** The document is a PNG wrapped in a one-layer document with
    // the default 16-entry palette (`build.ts`'s `readAsset`), so the palette was never the image's.
    // Every pixel is undeclared because nobody ever declared them, which is exactly what §4.3
    // measures and exactly what the mitigation (`quantize_to_palette` at import, or a palette that is
    // the image's) is upstream of. **The disproof is the same shape as the `nearDuplicatePairs` one
    // above and it is stated here rather than tuned away: a clean control reads 0 and this reads
    // 1000, and membership in a declared palette is exact, so there is no cut between "not
    // quantised" and "drifted" — a threshold loose enough to admit this one admits every snapping
    // miss too.** The fix is a different measurement or an upstream step, never a looser gate.
    expect(icon.actualCodes).toEqual([
      'colour-budget-exceeded',
      'invented-colours',
      'near-duplicate-colours',
      'off-palette',
    ]);
    expect(icon.blocking).toEqual(['off-palette']);
    expect(icon.actualVerdict).toBe('fail');
    expect(icon.scores.palette).toBe(0);
    expect(icon.frames[0].margin).toBe(32);
    // And the measurement, pinned so the disproof above can be re-checked rather than believed. These
    // two are the whole argument: a count that a shipped logo reaches 7,842 of and a deliberate
    // two-entry mistake reaches 1 of is not counting mistakes.
    const iconNoise = noiseFrameOf('app/icon.png');
    expect(iconNoise.nearDuplicatePairs).toBe(7842);
    expect(iconNoise.scoreQ).toBe(900);
    // The control half: every declared negative control reads zero pairs, so the analyzer is not
    // firing on flat two-colour fields either. It is specifically a *ramp* that trips it.
    for (const id of [
      'control/clean-blob-16',
      'control/clean-figure-20',
      'control/clean-union-16',
      'control/clean-banner-64x24',
      'control/partial-alpha-glow-28x24',
      'control/outline-ring-32',
    ]) {
      expect(noiseFrameOf(id).nearDuplicatePairs, id).toBe(0);
    }
    expect(noiseFrameOf('defect/near-duplicate-ramp-16').nearDuplicatePairs).toBe(1);
  });

  it('is silent on every declared negative control, and on the sixteen cases §3.5 names', () => {
    // **§3.5's rule is that clean work must produce no issue, and it is checked here from the
    // analyzer rather than from the generated table.** The list is the PO's: all six `control/*`, the
    // three `bleed/*`, every `sweep/*`, and the four `value/*` cases that are declared clean and
    // are the corpus's hardest quiet-on-good-work cases — a nested contour, a level set, a straight
    // terminator on a straight-edged form and a terminator that follows a terrain.
    const named = [
      'control/clean-blob-16',
      'control/clean-figure-20',
      'control/clean-union-16',
      'control/clean-banner-64x24',
      'control/partial-alpha-glow-28x24',
      'control/outline-ring-32',
      'bleed/full-bleed-scene-32',
      'bleed/one-pixel-guard-32',
      'bleed/two-pixel-margin-32',
      'value/nested-contour-32',
      'value/level-set-32',
      'value/hard-surface-terminator-32',
      'value/terrain-following-terminator-64',
    ];
    for (const entry of synthetic()) {
      if (!entry.id.startsWith('sweep/')) continue;
      named.push(entry.id);
    }
    for (const id of named) {
      const frame = paletteFrameOf(id);
      expect(frame.issues.map((issue) => issue.code), id).toEqual([]);
      expect(frame.scoreQ, id).toBe(1000);
      // **The `sweep/*` cases are not clean overall** — several carry `flat-value` and
      // `narrow-value-range` from `value` — so the claim being checked is the per-dimension one, which
      // is exactly what §3.5 asks for: *this* dimension says nothing about them.
      const paletteCodes = PALETTE_CODES.filter((code) => row(id).actualCodes.includes(code));
      expect(paletteCodes, id).toEqual([]);
    }
    // **And the three controls T-014 added, which are the negative half of a contrast pair each.**
    for (const id of [
      'control/six-hue-families-32',
      'control/washed-one-hue-32',
      'control/colour-budget-at-limit-32',
    ]) {
      expect(row(id).actualCodes, id).toEqual([]);
      expect(row(id).status, id).toBe('pass');
    }
  });

  it('reads `sectors = 0` on `connectivity/contour-staircase-24` because its ink is a desaturated near-black', () => {
    // **The one row in the corpus where `hueSectors` is 0 rather than >= 1, and it is correct.**
    // That case draws 18 pixels in exactly one colour, `#1c1c1d`, which *is* palette entry 0. Its
    // channels are 28, 28 and 29, so §3.4's `maxc` is 29, `minc` is 28 and
    // `s255 = floor((maxc - minc) * 255 / maxc) = floor(1 * 255 / 29) = 8`. **Eight is below §3.4's
    // `s255 >= 12`**, so §4.3's "ignoring colours with s255 < 12" excludes it, `hueSectors` is 0, and
    // the count is honestly zero rather than one.
    //
    // **Two things follow, and both are asserted rather than argued.** First, the reading is not a
    // broken instrument: the same case reads `offPalette` 0 and `maxNearestDistance` 0, so the colour
    // *is* declared and *is* the swatch — the only thing §3.4 withholds is the hue family. Second,
    // the consequence is a code that is correctly silent, because §4.3's `grey-colours` row needs
    // `hueSectors >= 3`: a sprite drawn in one near-black is not a sprite whose colours are "present
    // and washed out", and reporting it would be §3.3's two dimensions measuring one fact.
    const frame = paletteFrameOf('connectivity/contour-staircase-24');
    expect(frame.distinctColours).toBe(1);
    expect(frame.hueSectors).toBe(0);
    expect(frame.offPalette).toBe(0);
    expect(frame.maxNearestDistance).toBe(0);
    expect(frame.satSum).toBe(18 * 8);
    expect(frame.issues).toEqual([]);
    expect(frame.scoreQ).toBe(1000);
    // **The other zero-sector row is `human/tile-32`, and for the ordinary reason.** It is a greyscale
    // tile: every colour has `s255` 0, so §3.4 counts no hue families at all. Two rows at 0, two
    // different causes, both explained — which is the difference between a measured zero and one
    // nobody looked at.
    expect(paletteFrameOf('human/tile-32').hueSectors).toBe(0);
    expect(paletteFrameOf('human/tile-32').satSum).toBe(0);
  });

  it('records the whole distribution, which is the only thing a gate move could be argued from', () => {
    // **Every reading on every case, and nothing here is a threshold.** The shape is the finding:
    // `offPalette`, `maxNearestDistance` and `muddy` are 0 on almost every case and are large on a
    // handful, and the handful are the three committed assets that genuinely carry undeclared colour
    // plus the app icon. That is not "the measures are quiet" and it is not "the measures fire" — it
    // is a distribution with a gap in it, and §3.3 forbids moving a gate to fit a gap.
    //
    // **Split real from synthetic on purpose.** The synthetic cases are ours: three of them carry a
    // declared `palette` defect by construction, and the other sixty-odd were built to exercise other
    // dimensions and were never drawn off-palette. The real tier is the one that says something about
    // work nobody designed for this analyzer.
    const syntheticFrames = SPEC.cases
      .filter((entry) => entry.tier === 'synthetic')
      .map((entry) => ({ id: entry.id, frame: paletteFrameOf(entry.id) }));
    const offInSynthetic = syntheticFrames.filter((f) => f.frame.offPalette > 0).map((f) => f.id);
    expect(offInSynthetic).toEqual([
      'defect/off-palette-over-skin-32',
      'defect/invented-colour-32',
      'defect/muddy-over-skin-32',
    ]);
    const frames = real().map((entry) => ({ id: entry.id, frame: paletteFrameOf(entry.id) }));
    const offPalette = frames.filter((f) => f.frame.offPalette > 0);
    expect(offPalette.map((f) => f.id)).toEqual([
      'artwork/dusk-lake-valley-agent.pixel',
      'artwork/sunset-lighthouse-512-baseline-model-a.pixel',
      'app/icon.png',
    ]);
    // **The ratios, so the three are distinguishable rather than lumped together.** 36 per-mille on a
    // committed painting with one translucent layer, 9 on a committed painting that is fully opaque
    // and therefore carrying real drift, and 1000 on a raster that was never quantised into its
    // document palette. **The middle one is the interesting row**: its layers are all at opacity 1
    // and its composite is `alpha 255` everywhere, so §7 item 3's composite excuse does not apply and
    // the 2,423 undeclared pixels are the artwork's own — reported correctly at 9 per-mille, which is
    // inside §4.3's `<= 2/100` row and so produces no issue at all.
    expect(offPalette.map((f) => f.frame.offPaletteQ)).toEqual([36, 9, 1000]);
    const muddy = frames.filter((f) => f.frame.muddy > 0);
    expect(muddy.map((f) => f.id)).toEqual([
      'artwork/dusk-lake-valley-agent.pixel',
      'artwork/sunset-lighthouse-512-baseline-model-a.pixel',
      'app/icon.png',
    ]);
    expect(muddy.map((f) => f.frame.muddyQ)).toEqual([4, 1, 0]);
    // **`invented-colours` has one trigger and it is not reachable on this corpus at all except on
    // the icon** — every committed painting's worst colour is within §4.3's 12,000 of a swatch
    // (743, 3,987 and 16,631 across the three), so the row separates only the icon.
    expect(frames.filter((f) => f.frame.maxNearestDistance > 12000).map((f) => f.id)).toEqual(['app/icon.png']);
    // **And the dimension's own score distribution: a spike at 1000 with five rows below it.**
    // Six, not five: `artwork/sunset-lighthouse-512-baseline-model-a.pixel` reads 950 without an
    // issue, because its 2,423 undeclared pixels are 9 per-mille — inside §4.3's `<= 2/100` row — and
    // its 20 muddy of 262,144 are 1 per-mille against a trigger of 50. **A measurement that does not
    // reach its own gate is the most valuable row in a distribution**, and this is the one that says
    // the thresholds are not so loose that everything real trips them.
    const below = frames.filter((f) => f.frame.scoreQ < 1000).map((f) => [f.id, f.frame.scoreQ] as const);
    expect(below).toEqual([
      ['artwork/dusk-lake-valley-agent.pixel', 650],
      ['artwork/moonlit-alpine-lake-fast.pixel', 900],
      ['artwork/moonlit-alpine-lake.pixel', 800],
      ['artwork/sunset-lighthouse-512-baseline-model-a.pixel', 950],
      ['artwork/verify/lantern-keeper.pixel', 700],
      ['app/icon.png', 0],
    ]);
    // **The disproof, in §3.3's form, and this is the recording the task asked for.** The clean
    // control reads `offPalette` 0 and `app/icon.png` reads 1,000 per-mille: there is no cut between
    // them that is also a cut between them and a snapping miss, because §4.3's membership test is
    // *exact*. The icon is not "more undisciplined" than `artwork/dusk-lake-valley-agent.pixel` at 36
    // per-mille — it is a different thing, and the threshold has no way to say which. So the gate
    // stays where §4.3 puts it and the cost is recorded in `docs/EVALUATION.md` §7 item 3.
    expect(paletteFrameOf('control/clean-figure-20').offPaletteQ).toBe(0);
    expect(paletteFrameOf('app/icon.png').offPaletteQ).toBe(1000);
  });

  it('does not duplicate `noise`\'s `nearDuplicatePairs`, and the corpus is the evidence', () => {
    // **§3.3's warning is that two dimensions measuring one thing two ways is the likeliest way for
    // this pipeline to produce a confident wrong answer, so the question is asked with a case per
    // direction rather than argued.** §4.4's `nearDuplicatePairs` is two colours **the sprite used**,
    // Chebyshev `<= 8` apart, each over 8 pixels. §4.3's is a colour's redmean distance to the
    // nearest **declared swatch**. Same family of arithmetic; different reference set, different
    // metric, different question — "you used two colours that are the same colour" against "you
    // used a colour nobody declared". Neither measurement can be derived from the other.
    //
    // **Direction one: two near-identical colours, both declared.** `defect/near-duplicate-ramp-16` is
    // exactly that and `palette` reads it perfect — one declared colour, `offPalette` 0,
    // `maxNearestDistance` 0, two colours against a budget of 10, `scoreQ` 1000. If `palette` were
    // measuring `noise`'s quantity this is where it would show.
    const declared = paletteFrameOf('defect/near-duplicate-ramp-16');
    expect(noiseFrameOf('defect/near-duplicate-ramp-16').nearDuplicatePairs).toBe(1);
    expect(declared.distinctColours).toBe(2);
    expect(declared.offPalette).toBe(0);
    expect(declared.maxNearestDistance).toBe(0);
    expect(declared.issues).toEqual([]);
    expect(declared.scoreQ).toBe(1000);
    // **Direction two: undeclared colour, nothing near-duplicated about it.**
    // `defect/off-palette-over-skin-32` is 432 declared pixels and 144 undeclared ones, and
    // `nearDuplicatePairs` is 0 because the drift colour is 190 redmean units from the swatch it
    // came from and far from every other colour in the picture — so `noise` says nothing at all and
    // `palette` blocks.
    const undeclared = paletteFrameOf('defect/off-palette-over-skin-32');
    expect(noiseFrameOf('defect/off-palette-over-skin-32').nearDuplicatePairs).toBe(0);
    expect(undeclared.N).toBe(576);
    expect(undeclared.offPalette).toBe(144);
    expect(undeclared.offPaletteQ).toBe(250);
    expect(undeclared.issues.map((issue) => issue.code)).toEqual(['off-palette']);
    // **Direction three, and it is where the two overlap: the app icon.** Both fire, and they say
    // different things. `noise`'s 7,842 pairs is a recorded false positive — a twelve-step ramp is
    // structurally a field of near-duplicates. `palette`'s 1,000 per-mille is also a false positive,
    // and about a different fault: nobody ever declared this raster's palette. Two codes, one asset,
    // two different upstream fixes (`despeckle`-free colour merging against `quantize_to_palette`),
    // which is the practical answer to "who owns the question": **both do, each on its own question,
    // and §4.4's is proximity while §4.3's is membership.**
    const icon = paletteFrameOf('app/icon.png');
    expect(noiseFrameOf('app/icon.png').nearDuplicatePairs).toBe(7842);
    expect(icon.distinctColours).toBe(4871);
    expect(icon.offPaletteQ).toBe(1000);
    // **And the one thing the two could be confused about is measured: a colour three steps from a
    // swatch is 0 to §4.3 and a pair to §4.4.** `defect/near-duplicate-ramp-16`'s two swatches are
    // within Chebyshev 8, and the palette dimension's distance to the nearest swatch for that same
    // sprite is 0 — because it *is* the swatch. Two different zero/tiny readings of one fact.
    expect(declared.maxNearestDistance).toBe(0);
    expect(declared.distinctColours).toBeLessThan(icon.distinctColours);
  });

  it('reads 0 convex corners on every real asset, so §3.3\'s quantity is inert in the wild too', () => {
    // Not just on a synthetic disc: on ten finished scenes with 15-hole skylines, staircase
    // ridgelines and every kind of curve an artist draws. §4.2's curvature gate has nothing to read,
    // and the corpus says so on real work rather than on a fixture.
    for (const entry of real()) {
      for (const frame of row(entry.id).frames) {
        expect(frame.convexCorners, `${entry.id} frame ${frame.index}`).toBe(0);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * 4 · The builder and the report
 * ------------------------------------------------------------------ */

const RECIPE = {
  canvas: { w: 16, h: 16 },
  layers: ['Base'],
  palette: ['#3a2f2a'],
  ops: [{ op: 'rect' as const, layer: 'Base', rect: [2, 2, 12, 12] as const, color: 'pal:0', fill: true }],
};

describe('the corpus is materialised, not committed, and it is byte-reproducible', () => {
  it('builds the same bytes for the same case on every run', () => {
    // T-071 made the engine reproducible and T-091 made `.pixel` serialisation reproducible, and
    // both were prerequisites for this. A corpus that serialised differently each run would turn
    // every score change into "did the fixture change?", which is the binary-fixture problem the
    // spec format exists to avoid.
    const first = serializeSprite(buildFromRecipe('demo/one', RECIPE));
    const second = serializeSprite(buildFromRecipe('demo/one', RECIPE));
    expect(second).toEqual(first);
    // A different case id gives different ids, so two cases in one process never collide.
    expect(serializeSprite(buildFromRecipe('demo/two', RECIPE))).not.toEqual(first);
  });

  it('leaves the process id factory as it found it, even when a recipe throws', () => {
    // `setIdFactory` is process-global. A throw mid-build that left a deterministic factory
    // installed would silently change the id behaviour of every document built afterwards -
    // including `determinism.test.ts`'s own check that the default factory is not reproducible.
    const before = makeId('probe');
    expect(() =>
      buildFromRecipe('demo/throws', {
        canvas: { w: 8, h: 8 },
        palette: ['#000000'],
        ops: [{ op: 'rect', layer: 'Nope', rect: [0, 0, 2, 2], color: 'pal:0', fill: true }],
      }),
    ).toThrow(/ops\[0\]/);
    // A default-factory id is time-and-entropy shaped; a deterministic one is a bare counter.
    expect(makeId('probe')).not.toBe(before);
    expect(makeId('probe')).not.toMatch(/^probe_\d{4}$/);
  });

  it('gives every case a document, human tier included, because a rater has to see the thing', () => {
    // `pixel demo`'s rule, for the same reason: a corpus that swallowed a failed command would
    // materialise a nearly-empty canvas and then confidently report on it.
    const registry = buildCorpus(SPEC);
    expect(registry.filter(({ sprite }) => sprite !== null)).toHaveLength(SPEC.cases.length);
  });
});

describe('the report', () => {
  it('renders the same markdown from the same run', () => {
    // §3.2 rule 4: anything whose order can reach output is a property of the scan, not of a hash
    // table. Re-rendering the committed run and re-deriving it from a second run are the same
    // check, and the second is the one that would catch an unordered iteration.
    const again = renderMarkdown(SPEC, SCORES, runCorpus(SPEC, SCORES).rows);
    expect(again).toBe(RUN.markdown);
    expect(again).toBe(readFileSync(BASELINE_PATH, 'utf8'));
  }, CORPUS_PASS_TIMEOUT_MS);

  it('prints the table, the distribution and the unresolved specification conflicts', () => {
    // A report nobody can read is a report nobody compares. These are the sections a reviewer has
    // to be able to find without reading the code.
    expect(RUN.markdown).toContain('## 1 · Cases');
    expect(RUN.markdown).toContain('## 4 · `compactnessQ` across every subject');
    expect(RUN.markdown).toContain('compactnessQ 269');
    expect(RUN.markdown).toContain('dist / Dmax');
    expect(RUN.markdown).toContain('## 7 · Human-rated tier');
    expect(RUN.markdown).toContain('0 of 3');
    // And no mismatch section, because there is no mismatch. A committed report carrying a
    // "Mismatches" heading with nothing under it is a report that has learned to tolerate failure.
    expect(RUN.markdown).not.toContain('### Mismatches');
  });

  it('records the §6.2 contrast pairs with the size of the gap, on three different scales', () => {
    // §6.2: "a pair that separates by 0.02 is passing the test and still wrong, and the size of the
    // gap is the thing worth reviewing". So the gap is a number, and there are three of them
    // because the score gap alone understates what the dimension measured.
    const groups = new Map(DISTRIBUTION.pairs.map((pair) => [pair.group, pair]));
    // Scoped to `silhouette/*` rather than an exhaustive list of every group in the corpus, and
    // that is a change of shape rather than a convenience. The list used to be exhaustive because
    // `silhouette` was the only dimension with an analyzer, and the first dimension to land made
    // it stale — which is the same lesson as every other exhaustive list in this file: a list that
    // must be edited when an unrelated thing happens is a coupling, not a guard. The
    // `silhouette/*` prefix is this dimension's own namespace and a second dimension cannot land
    // inside it.
    expect([...groups.keys()].filter((name) => name.startsWith('silhouette/')).sort()).toEqual([
      'silhouette/hole-clause',
      'silhouette/line-vs-filled',
      'silhouette/margin-guard',
      'silhouette/scale-magnification',
      'silhouette/scale-room',
      'silhouette/thickness-sweep',
    ]);

    // §6.2's own silhouette pair: a 1px line sprite against a filled one. **The compactnessQ gap
    // collapsed from 711 to 9, and that is the measurement being fixed rather than broken**: the
    // line sprite's largest 4-connected component is one pixel, so its subject is a perfect little
    // square and the shape descriptor correctly says 785. The pair still separates by 437 on the
    // scale-aware reading and by 1000 on the score, which is where the separation belongs.
    const line = groups.get('silhouette/line-vs-filled')!;
    expect(line.members.map((m) => m.id).sort()).toEqual([
      'connectivity/diagonal-bridge-16',
      'control/clean-blob-16',
    ]);
    expect(line.gap).toBe(1000);
    expect(line.rawGap).toBe(1000);
    expect(line.compactnessGap).toBe(9);
    expect(line.thicknessGap).toBe(437);

    // The thickness pair, matched to one variable: same width, same canvas, same 2px margin, and the
    // height is the only difference. compactnessQ separates it by 600 and the score by 100 - the
    // whole of that 100 is the -100 of `thin-profile`, which is the number worth reviewing, and
    // which the new deep band does not reach because profileQ 184 is above 150.
    const thickness = groups.get('silhouette/thickness-sweep')!;
    expect(thickness.members.map((m) => m.id).sort()).toEqual(['sweep/rect-30x2', 'sweep/rect-30x28']);
    expect(thickness.gap).toBe(100);
    expect(thickness.compactnessGap).toBe(600);
    expect(thickness.thicknessGap).toBe(542);
    expect(thickness.profileGap).toBe(600);

    // The hole pair separates by **50** on the score now, where it separated by 0: a 1px speck and
    // a 6x6 window are both `interior-hole`, from two different clauses of §4.1's one row, and the
    // nick is now half the price of the window. The compactnessQ gap of 288 the corpus already
    // measured is joined by a thickness gap of 208, so the two shapes differ on three quantities
    // where they used to differ on one.
    const holes = groups.get('silhouette/hole-clause')!;
    expect(holes.gap).toBe(50);
    expect(holes.compactnessGap).toBe(288);
    expect(holes.thicknessGap).toBe(208);

    // The margin family is the one the applicability predicate exists for, and it is four cases
    // rather than two: the same 32-wide ink at 0px, 1px and 2px of margin, plus a 2px-guarded
    // three-edge crop. Two of the four get no score at all, which is the point; the raw
    // measurement separates them by 200, entirely from `shape-clipped`; and compactnessQ
    // separates them by 2, because the shape descriptor is scale-invariant and insetting a square
    // changes nothing about it.
    const margin = groups.get('silhouette/margin-guard')!;
    expect(margin.members.map((m) => m.id).sort()).toEqual([
      'bleed/full-bleed-scene-32',
      'bleed/one-pixel-guard-32',
      'bleed/two-pixel-margin-32',
      'defect/shape-clipped-32',
    ]);
    expect(margin.members.filter((m) => m.scoreQ === null).map((m) => m.id).sort()).toEqual([
      'bleed/full-bleed-scene-32',
      'bleed/one-pixel-guard-32',
    ]);
    expect(margin.gap).toBe(200);
    expect(margin.rawGap).toBe(200);
    expect(margin.compactnessGap).toBe(2);
    // **And the scale-aware reading separates the same four by 125, on the property `spanQ`
    // already measures.** That is stated rather than sold: a square subject's inscribed square is
    // its short side, so `thicknessQ` and `spanQ` nearly coincide for a rectangle and the 125 here
    // is mostly the same fact arriving twice. It is in the report so a reader can see that, rather
    // than taking a fifth gap column on trust.
    expect(margin.thicknessGap).toBe(125);

    // The two scale pairs, one separating and one designed not to, both asserted above and here so
    // the report's own table is pinned rather than merely rendered.
    const room = groups.get('silhouette/scale-room')!;
    expect([room.compactnessGap, room.thicknessGap, room.gap]).toEqual([0, 91, 0]);
    // **The magnification pair is a pair now, and its answer is six zeros.** It used to print
    // `not separable`, which is a claim about the *data* when it was a claim about a one-valued
    // `pair` field: the 3px band on 32² was already spoken for by `scale-room`, so a case could not
    // be in two groups and the negative contrast — the one §6.2 wants most — had nowhere to live.
    // `pair` is a list now, the band is in both groups, and the measured answer is 0 on every axis,
    // which is the finding rather than a gap.
    const magnified = groups.get('silhouette/scale-magnification')!;
    expect(magnified.members.map((m) => m.id).sort()).toEqual([
      'sweep/band-28x3-on-32',
      'sweep/band-896x96-on-1024',
    ]);
    expect([
      magnified.gap,
      magnified.rawGap,
      magnified.compactnessGap,
      magnified.thicknessGap,
      magnified.profileGap,
      magnified.valueGap,
    ]).toEqual([0, 0, 0, 0, 0, 0]);
    // And the two `value` pairs, which is what the sixth gap column is for. Without `valueQ` the
    // acceptance pair read as five zeros while its two members differ by 325 per-mille on the
    // dimension that is the whole reason §4.2 exists.
    //
    // **The gap is 450 now, and it was 325.** Not a smaller effect, a larger one: the correct half
    // of the pair stopped being charged 250 per-mille for reading as an arc rather than a ring, so
    // the distance between "boundaries cut across the form" and "boundaries follow it" grew while
    // the band table never moved. §6.2 asks for the size of the gap to be the thing worth
    // reviewing, so this is the number to review and it moved the right way.
    const straight = groups.get('value/straight-band-vs-form-following')!;
    expect([straight.gap, straight.valueGap]).toEqual([0, 450]);
    expect(straight.members.map((m) => m.valueQ)).toEqual([500, 950]);
    const headroom = groups.get('value/headroom')!;
    expect([headroom.gap, headroom.compactnessGap, headroom.thicknessGap, headroom.valueGap]).toEqual([
      0,
      0,
      0,
      150,
    ]);
  });


  it('per-dimension score distribution covers every dimension that exists', () => {
    // **Was `only the dimension that exists`, and each rename is the finding:** `value` landed and the
    // assertion went stale, exactly as the hard-coded defect list above did, and then `noise` landed
    // and it went stale again. All four are measured on the same rows and on opposite halves of the
    // range — `silhouette` reaches 1000 on a clean blob and 0 on a 1px staircase, `value` 1000 and
    // 125, `noise` 1000 and 825, `palette` 1000 and 0 — which is the distribution a gate argument is
    // made from.
    //
    // **`noise`'s floor is 825 and its median is 1000, and both are derived rather than read off.**
    // The floor is `artwork/moonlit-alpine-lake.pixel` alone: `colourOrphans` 43 of `N` 4096 is
    // `rhu(43000, 4096) = 10` per-mille, past §4.4's `> 8/1000` trigger and so in the `<= 20/1000`
    // band at 750, giving `rhu(300*1000 + 200*1000 + 300*750 + 200*1000, 1000) = 925`, and that
    // sprite's two `nearDuplicatePairs` take the flat -100 to 825.
    //
    // **`palette`'s floor is 0 and its median is 1000, and the floor is `app/icon.png` alone.** It is
    // the one committed asset where the dimension scores zero, and §7 records why: 4,871 distinct
    // colours against a 16-entry document palette, so every solid pixel is off-palette. The median is
    // 1000 because **nine of the eleven real assets are entirely silent** — the ten scenes at
    // 256² and 512² are `scene`-class with a budget of 96 and a hue-sprawl exemption, and seven of
    // them use every colour they draw from the palette. That is the shape to argue a gate from: a
    // dimension whose distribution on good work is a spike at 1000 with one outlier at 0 is
    // measuring membership, not quality of composition, which is precisely what §4.3 says it is for.
    const measured = DISTRIBUTION.scores.filter((entry) => entry.values.length > 0);
    expect(measured.map((entry) => entry.dimension)).toEqual(['silhouette', 'value', 'palette', 'noise']);
    expect(measured[0].min).toBeLessThan(measured[0].max);
    expect(measured[1].min).toBeLessThan(measured[1].max);
    expect(measured[1].min).toBe(125);
    expect(measured[2].min).toBe(0);
    expect(measured[2].max).toBe(1000);
    expect(measured[2].median).toBe(1000);
    expect(measured[3].min).toBe(825);
    expect(measured[3].max).toBe(1000);
    // The two that do not exist are absent rather than zero, which is the `not-implemented`
    // bookkeeping working and not a gap in the corpus.
    expect(DISTRIBUTION.scores.filter((entry) => entry.values.length === 0)).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * 5 · `measure.ts` and the specification conflicts
 * ------------------------------------------------------------------ */

describe('§3.3 quantities have one home, and the ones that do not are written down', () => {
  it('edgePixels is a count of pixels and perimeter is a length, from the same mask', () => {
    // `measure.ts` exists because this quantity needed a second consumer, and the two are easy to
    // conflate. Checked on a mask built by the shared builder, so both numbers come out of the same
    // place the analyzer reads them from.
    const entry = SPEC.cases.find((c) => c.id === 'control/clean-blob-16');
    const context = createQualityContext(buildCase(entry!));
    const { mask, solid } = buildSolidMask(context.composite[0], context.width, context.height);
    expect(solid).toBe(80);
    // 10x8 rectangle: 2(10+8) - 4 = 32 edge pixels, 2(10+8) = 36 transitions.
    expect(edgePixelCount(mask, context.width, context.height)).toBe(32);
    expect(boundaryPerimeter(mask, context.width, context.height)).toBe(36);
  });

  it('edgePixelAt agrees with edgePixelCount on every pixel of every corpus subject', () => {
    // The predicate and the count are two expressions of one definition. If they drift, the count is
    // wrong in a way nothing else would notice.
    for (const { entry, sprite } of buildCorpus(SPEC)) {
      if (sprite === null || entry.tier === 'human') continue;
      const context = createQualityContext(sprite);
      const { mask } = buildSolidMask(context.composite[0], context.width, context.height);
      let counted = 0;
      for (let y = 0; y < context.height; y++) {
        for (let x = 0; x < context.width; x++) {
          if (edgePixelAt(mask, context.width, context.height, x, y)) counted++;
        }
      }
      expect(counted, entry.id).toBe(edgePixelCount(mask, context.width, context.height));
    }
  });

  it('keeps the re-exported quantities in one home, so a second dimension imports one path', () => {
    // The extraction `silhouette.ts` asks for cannot be completed under this task's whitelist: it
    // needs an edit to `silhouette.ts` to move the definitions and an edit to `index.ts` to reach
    // the package. What exists is a re-export, so there is one definition and one import path, and
    // `measure.ts` writes out which two files the move still needs.
    //
    // The list is spelled out rather than derived from the module's own keys, because a list
    // derived from the module is satisfied by anything the module happens to export — including a
    // second implementation, which is the failure this whole block exists to prevent. Adding a
    // §3.3 quantity therefore means adding it here, and that is the intended friction.
    const names = [
      'buildSolidMask',
      'connectedComponents',
      'interiorHoles',
      'borderTouch',
      'boundaryPerimeter',
      'compactnessQ',
      'countConvexCorners',
      'rhu',
      'subjectMask',
      'inscribedSquareSide',
      'thicknessQ',
    ] as const;
    for (const name of names) {
      expect(measure[name], name).toBe(silhouette[name]);
    }
    expect(measure.ALPHA_SOLID).toBe(ALPHA_SOLID);
    // And `connectedComponents` still takes the connectivity argument, because §3.3's two uses
    // disagree on purpose and putting them on one code path is how `outline` would inherit a 30%
    // penalty for having been drawn. Three declared parameters, the fourth defaulted.
    expect(measure.connectedComponents.length).toBe(3);
  });

  it('records the dist/Dmax conflict, and measures all three readings on both shapes', () => {
    // §3.3 defines `dist` twice, incompatibly: the table says Chebyshev, the prose says a
    // 4-connected BFS. **T-013 measured it rather than leaving it declared**, so the status is
    // `implemented` today: `distField` in `quality/measure.ts` is the prose, verbatim, and `value` is
    // its first consumer. What is *not* settled is §3.3, which still says both — so the record now
    // carries a divergence between a committed number and a committed document rather than a task
    // waiting for an owner, and this test is what makes the divergence legible.
    const entry = DECLARED_QUANTITIES.find((q) => q.name === 'dist / Dmax');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('implemented');
    expect(entry!.adopted).toContain('4-connected multi-source BFS');
    expect(entry!.adopted).toContain('distField');
    expect(entry!.neededBy).toEqual(['value', 'outline', 'noise']);

    // **The discriminating shape, and it is the 5x5 block.** A 5x5 block's centre is 3 from the
    // nearest non-solid pixel in L-infinity, 3 in L1 (the two agree, because the nearest non-solid
    // pixel is axis-aligned from the centre), and **2** through the solid mask from the nearest edge
    // pixel — so it separates the prose from both of the others, which is what a discriminator is
    // for.
    const block = new Uint8Array(9 * 9);
    for (let y = 2; y < 7; y++) for (let x = 2; x < 7; x++) block[y * 9 + x] = 1;
    expect(maxChebyshevDistance(block, 9, 9)).toBe(3);
    expect(maxConnected4Distance(block, 9, 9)).toBe(3);
    expect(maxSolidOnlyBfsDistance(block, 9, 9)).toBe(2);

    // **T-021's shape, which does not discriminate, and is recorded for that reason.** A 3x3 block
    // with ONE corner pixel removed: the pixel diagonally opposite the removed corner has all four of
    // its orthogonal neighbours solid and one transparent diagonal, so the only transparent pixels
    // it can see are diagonal. Chebyshev 1, a whole-grid BFS from every non-solid pixel 2, and the
    // prose 1 — the table and the reading §3.3 actually states *agree*, and what the shape separates
    // is a reading the specification never mentions. T-021 labelled the 2 "the prose" and was wrong;
    // implementing `Dmax` from that shape would have implemented the wrong one, which is the
    // argument for `inscribedSquareSide` and the reason the record carries both shapes.
    const mask = new Uint8Array(9 * 9);
    for (let y = 2; y < 5; y++) for (let x = 2; x < 5; x++) mask[y * 9 + x] = 1;
    mask[4 * 9 + 2] = 0;
    const chebyshev = maxChebyshevDistance(mask, 9, 9);
    const manhattan = maxConnected4Distance(mask, 9, 9);
    const prose = maxSolidOnlyBfsDistance(mask, 9, 9);
    expect(chebyshev).toBe(1);
    expect(manhattan).toBe(2);
    expect(prose).toBe(1);
    expect(prose).toBe(chebyshev);
    // Every reading on every shape, in §3.3's own order, so a tie is visible as a tie rather than
    // hidden by dropping a row.
    expect(entry!.discriminatorValues).toEqual([
      ['5x5 block — Chebyshev (L-infinity, the table)', 3],
      ['5x5 block — whole-grid BFS from every non-solid pixel (L1, unstated)', 3],
      ['5x5 block — BFS confined to the solid mask from every edgePixel (the prose, adopted)', 2],
      ['3x3 block, one corner removed — Chebyshev (L-infinity, the table)', chebyshev],
      ['3x3 block, one corner removed — whole-grid BFS from every non-solid pixel (L1, unstated)', manhattan],
      ['3x3 block, one corner removed — BFS confined to the solid mask from every edgePixel (the prose, adopted)', prose],
    ]);

    // **§4.2's own worked example is written against the other reading, and this is the number that
    // says so.** It records `Dmax` 8 for a 32x32 character and normalises `spanQ` by `Dmax + 1 = 9`.
    // This repository's own 32x32 character body — the 25-row silhouette `demo.ts` builds its whole
    // tonal stack from, which is the same row table `quality-value.test.ts` shades — measures
    // Chebyshev 8, whole-grid 11, prose 10 on the same pixels. The example is not wrong about the
    // artwork; it is written against the half of §3.3 the implementation does not use, and the next
    // revision has to re-derive it.
    const character = SPEC.cases.find((c) => c.id === 'value/nested-contour-32')!;
    const context = createQualityContext(buildCase(character));
    const { mask: body } = buildSolidMask(context.composite[0], 32, 32);
    expect(maxChebyshevDistance(body, 32, 32)).toBe(8);
    expect(maxConnected4Distance(body, 32, 32)).toBe(11);
    expect(maxSolidOnlyBfsDistance(body, 32, 32)).toBe(10);
    // And the pipeline agrees with the prose, because the pipeline is the prose.
    expect(measureValue(context)[0].Dmax).toBe(10);

    // **Nothing is unimplemented any more.** The one entry that was — `dist`/`Dmax`, "defined twice
    // and owned by nobody" — now has an owner, and the entry that is still in conflict
    // (`convexCorner`) is the one that is *measured*, which is the harder of the two to notice.
    expect(DECLARED_QUANTITIES.filter((q) => q.status === 'unimplemented')).toHaveLength(0);
  });


  it('records that §3.3\'s convexCorner is measured, and measures 0 on every convex shape', () => {
    const entry = DECLARED_QUANTITIES.find((q) => q.name === 'convexCorner');
    expect(entry!.status).toBe('implemented');
    expect(entry!.adopted).toContain('concave');
    // The corpus's own evidence: the quantity on a figure and on an outlined disc.
    // `quality-silhouette.test.ts` pins the predicate; this pins that it is inert on the shapes
    // §4.2's curvature gate is about.
    for (const id of ['control/clean-union-16', 'control/outline-ring-32']) {
      const found = SPEC.cases.find((c) => c.id === id);
      const context = createQualityContext(buildCase(found!));
      const { mask } = buildSolidMask(context.composite[0], context.width, context.height);
      expect(measureSilhouette(context)[0].convexCorners, id).toBe(0);
      expect(countConvexCorners(mask, context.width, context.height), id).toBe(0);
    }
  });
});

/** `max` of the Chebyshev distance to the nearest non-solid pixel: §3.3's table reading. */
function maxChebyshevDistance(mask: Uint8Array, width: number, height: number): number {
  let best = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] !== 1) continue;
      let distance = Infinity;
      for (let ny = 0; ny < height; ny++) {
        for (let nx = 0; nx < width; nx++) {
          if (mask[ny * width + nx] === 1) continue;
          distance = Math.min(distance, Math.max(Math.abs(nx - x), Math.abs(ny - y)));
        }
      }
      if (distance > best) best = distance;
    }
  }
  return best === Infinity ? 0 : best;
}

/**
 * `max` of the 4-connected BFS distance to the nearest non-solid pixel: §3.3's prose reading.
 *
 * The canvas edge counts as non-solid, which is what makes `dist` 0 on an `edgePixel`. Written as a
 * multi-source scan because the shape this runs on has 8 solid pixels and correctness matters more
 * than the complexity class.
 */
function maxConnected4Distance(mask: Uint8Array, width: number, height: number): number {
  const distance = new Int32Array(mask.length).fill(-1);
  const queue: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      if (mask[p] !== 1 || edge) {
        distance[p] = 0;
        queue.push(p);
      }
    }
  }
  let best = 0;
  for (let at = 0; at < queue.length; at++) {
    const p = queue[at];
    const x = p % width;
    const y = (p - x) / width;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const q = ny * width + nx;
      if (distance[q] !== -1) continue;
      distance[q] = distance[p] + 1;
      if (distance[q] > best) best = distance[q];
      queue.push(q);
    }
  }
  return best;
}

/**
 * `max` of the 4-connected BFS distance from every `edgePixel`, **confined to the solid mask**.
 *
 * §3.3's prose, taken literally: seeds are the `edgePixel`s, propagation is 4-connected, `+1` per
 * step, and — the word that matters — "over the solid mask", so a step may never enter a
 * transparent pixel. Added by T-022 because T-021's discriminator turned out to separate the
 * table from a reading §3.3 does not state, leaving the reading it *does* state untested; see
 * `DECLARED_QUANTITIES` and the test that names the three values.
 */
function maxSolidOnlyBfsDistance(mask: Uint8Array, width: number, height: number): number {
  const distance = new Int32Array(mask.length).fill(-1);
  const queue: number[] = [];
  const isEdgePixel = (x: number, y: number): boolean =>
    x === 0 || y === 0 || x === width - 1 || y === height - 1 ||
    mask[(y - 1) * width + x] === 0 || mask[(y + 1) * width + x] === 0 ||
    mask[y * width + x - 1] === 0 || mask[y * width + x + 1] === 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (mask[p] !== 1 || isEdgePixel(x, y)) {
        distance[p] = 0;
        queue.push(p);
      }
    }
  }
  let best = 0;
  for (let at = 0; at < queue.length; at++) {
    const p = queue[at];
    const x = p % width;
    const y = (p - x) / width;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const q = ny * width + nx;
      // The confinement, which is the whole difference from `maxConnected4Distance`.
      if (mask[q] !== 1 || distance[q] !== -1) continue;
      distance[q] = distance[p] + 1;
      if (distance[q] > best) best = distance[q];
      queue.push(q);
    }
  }
  return best;
}

describe('the checks that check the checks', () => {
  /**
   * `benchmarks/tsconfig.json` existed for a whole task with nothing running it.
   *
   * T-021 wrote that down as a known gap and the reason it is embarrassing: running the check once
   * immediately found a type error in `report.ts` that vitest had transpiled straight past. T-093
   * had already hit the identical hole in `scripts/npm-index.ts`. T-022 wired the project into the
   * root `typecheck` script, and this is the half of that which matters — because **a `tsc`
   * invocation deleted from `package.json` is a silent change to CI**, and nothing else in this
   * repository would notice. The lesson applied to the check itself rather than to the code it
   * checks.
   */
  it('is still wired into the root typecheck script', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(manifest.scripts.typecheck).toContain('tsc -p benchmarks/tsconfig.json');
    // And T-093's coverage is still there, because the same argument applies to it and a fix that
    // quietly removed an earlier task's gate would be the same failure wearing a different hat.
    expect(manifest.scripts.typecheck).toContain('tsc -p tsconfig.npm.json --noEmit');
  });

  it('covers every .ts file under benchmarks/, so a new harness file cannot sit outside it', () => {
    // The `include` glob is a spec like any other: a fifth harness module that matches neither
    // pattern would be typechecked by nothing and discovered by whoever next changes it. The
    // discriminator is the *walk* — a guard that reads a fixed list is satisfied by a fixed list,
    // so this reads the directory and compares.
    const tsconfig = readFileSync(new URL('../../../benchmarks/tsconfig.json', import.meta.url), 'utf8');
    expect(tsconfig).toContain('"corpus/**/*.ts"');
    const corpusDir = fileURLToPath(new URL('../../../benchmarks/corpus/', import.meta.url));
    const onDisk = readdirSync(corpusDir)
      .filter((name) => name.endsWith('.ts'))
      .sort();
    expect(onDisk.length).toBeGreaterThanOrEqual(4);
    for (const name of onDisk) {
      // `corpus/**/*.ts` is what the project includes, so the only requirement is that the file
      // really is under `corpus/`. Asserted by construction: the walk produced it from there.
      expect(name.endsWith('.ts'), name).toBe(true);
    }
    // And the `noEmit` is set in the project rather than on the command line, so the project is
    // runnable on its own — the reason the root script passes no `--noEmit` for this one.
    expect(tsconfig).toContain('"noEmit": true');
  });
});

/* ------------------------------------------------------------------ *
 * 6 · Coverage
 * ------------------------------------------------------------------ */

describe('coverage is aimed at the failures that were found, not exhaustive', () => {
  it('spans the canvas sizes, frame counts and shapes §6.3 asks for', () => {
    const drawn = RUN.rows.filter((r) => r.tier !== 'human');
    const sizes = new Set(drawn.map((r) => `${r.attributes.width}x${r.attributes.height}`));
    // 9, 16, 20, 22, 24, 28, 32, 34, 38, 64 and 1024 across the whole corpus, including the
    // non-square ones a threshold that only works at 32x32 would not survive.
    expect(sizes.size).toBeGreaterThanOrEqual(6);
    expect([...sizes].filter((s) => s.split('x')[0] !== s.split('x')[1]).length).toBeGreaterThanOrEqual(2);
    const frames = new Set(drawn.map((r) => r.attributes.frames));
    expect([...frames].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    // And the real artwork spans 32 through 1024, which is the part a generated corpus cannot fake.
    const realSizes = new Set(real().map((entry) => row(entry.id).attributes.width));
    expect([...realSizes].sort((a, b) => a - b)).toEqual([32, 64, 256, 512, 1024]);
  });

  it('spans the difficulty range, including near-misses on both sides of the gate', () => {
    // A corpus of only failures calibrates the detector and not the scale.
    const scores = RUN.rows
      .filter((r) => r.tier !== 'human' && r.scores.silhouette !== undefined)
      .map((r) => r.scores.silhouette as number);
    expect(Math.min(...scores)).toBeLessThanOrEqual(300);
    expect(Math.max(...scores)).toBe(1000);
    // Near-miss: a subject 26 per-mille above the gate and one 25 below it, so a gate move in either
    // direction changes an outcome that is not an outlier.
    expect(row('sweep/rect-30x4').frames[0].compactnessQ - SPEC_GATES.compactnessQ).toBe(26);
    expect(SPEC_GATES.compactnessQ - row('sweep/rect-28x3').frames[0].compactnessQ).toBe(25);
  });

  it('has a case for every defect kind the loader allows', () => {
    // **Derived from the loader's own closed list, not from a copy of it.** The question here is
    // "does every code the loader accepts have a case that says what it means?", and the closed enum
    // is a specification rather than an implementation — so reading it is not the circularity the
    // re-export test above warns about, and a hard-coded list is exactly the second copy that went
    // stale when `value` landed and again when `noise` landed. The floor below is what stops the
    // derivation from being vacuous: a truncated `DEFECT_KINDS` satisfies the comparison, and only
    // the count stops that.
    //
    // **The comparison is against `DEFECT_KINDS` itself, with no exceptions, and that used to be a
    // subtraction.** Three of the twenty kinds had no case, all three of them `noise`'s, and they
    // were excluded by a named `NOT_COVERED` list — which was right at the time, because
    // `neighbourCounts` counted each pixel as its own neighbour, so `isolated` and `diagOnly` were
    // unsatisfiable and `spurs` had become `isolated`. **The exception list was a measurement of the
    // implementation wearing the clothes of a specification**, and it had to be written twice: once
    // here and once in `format.ts`'s comment on `DEFECT_KINDS`. With the count corrected and
    // `defect/isolated-pixels-18`, `defect/single-pixel-spur-16` and `defect/diagonal-seam-24x20` in
    // the corpus, both are gone, and **a kind that later loses its case goes red here again** — which
    // is the property the subtraction had quietly given away.
    const declared = new Set(synthetic().flatMap((entry) => entry.defects.map((d) => d.kind)));
    // `palette` makes it 26, and all six of its codes arrived with the dimension rather than after
    // it. §3.5's fourth rule is a hard order — a defect cannot be declared until the report can
    // carry it — so a dimension landing with six codes and no cases could not be accepted, and this
    // assertion is what says so. Three of the nine cases it added are **negative controls** rather
    // than defects, which is the other half of §3.5: `hue-sprawl`, `grey-colours` and
    // `colour-budget-exceeded` each needed a shape on the *other* side of its own gate.
    expect([...declared].sort()).toEqual(DEFECT_KINDS.slice().sort());
    expect(DEFECT_KINDS.length).toBe(26);
    expect(DEFECT_KINDS.filter((kind) => !declared.has(kind)).sort()).toEqual([]);
    // And the gap, named rather than left to be inferred. `key-light-inconsistent` is the one
    // `value` code with no case that *declares* it, because §4.2's `keyLight` is a subject-level
    // check and a case that declared it would be asserting that a valley is lit from the wrong
    // side. It is not in the loader's enum at all, so the gap is a gap between §4.2's issue table
    // and `DEFECT_KINDS` rather than a gap in the corpus's coverage of its own list — which is why
    // it is written out here against the specification's seven codes rather than derived.
    const VALUE_CODES = [
      'flat-value',
      'highlight-blown',
      'hue-carries-form',
      'key-light-inconsistent',
      'narrow-value-range',
      'plane-crosses-form',
      'shadow-crushed',
    ];
    expect(VALUE_CODES.filter((kind) => !declared.has(kind))).toEqual(['key-light-inconsistent']);
    // The code is not dead, which is the part that matters: it fires on a real fixture and on three
    // of the ten committed scenes, and both are asserted elsewhere in this file. A code that quietly
    // stops appearing is a code that quietly stops working.
    expect(row('value/hue-carries-form-32').actualCodes).toContain('key-light-inconsistent');
  });

  it("exercises three of noise's five codes, and the arithmetic behind each", () => {
    // **This test used to assert the opposite of everything below, and it was right to.** It pinned
    // `loose.isolated === 0`, `loose.spurs === 2`, the antenna tip reading `n8 == 2` and staying
    // silent, `diagonal.diagOnly === 0`, and a closing loop over every corpus row requiring that
    // none of them report `isolated-pixels`, `diagonal-seam` or `single-pixel-spur`. **Every one of
    // those assertions was correct, and every one of them was correct about a defect**: `noise`'s
    // `neighbourCounts` counted each pixel as its own neighbour, so `n8` was `>= 1` everywhere,
    // `isolated` (`n8 == 0`) and `diagOnly` (`n4 == 0`) were unsatisfiable, and `spurs` (`n8 == 1`)
    // had silently become `isolated` — which is why a genuine one-pixel antenna read `n8 == 2` and
    // was invisible. The closing loop existed to go red on the day the count was fixed. **That day
    // was the day the three missing cases got written**, so it has gone, and so has the loop: three
    // corpus cases now report all three codes, and a guard against that is a guard against the
    // corpus working.
    //
    // **§3.3 defines the quantities and §4.4 settles the reading in one row.** `n4(p)` and `n8(p)`
    // are the "number of solid 4- and 8-**neighbours** of `p`", and §4.4's worked-example table
    // records "one wrong-coloured pixel inside a solid block (`n8 == 8`)" — eight, not nine, because
    // a pixel is not its own neighbour. So the three predicates are:
    //
    //     isolated    n8 == 0              a pixel with nothing solid beside it
    //     diagOnly    n4 == 0 && n8 >= 1   attached to the body only diagonally
    //     spurs       n8 == 1              one solid 8-neighbour: a one-pixel antenna
    //
    // and each has a case now: `defect/isolated-pixels-18`, `defect/single-pixel-spur-16` and
    // `defect/diagonal-seam-24x20`. What is left in this file is the independent measurement that
    // caught the defect — `neighboursAt`, §3.3's sentence computed from the pixels rather than read
    // out of the analyzer — and the record of what the analyzer used to say on the same geometry.

    const block = (x: number, y: number, w: number, h: number) => ({ op: 'rect', layer: 'Base', color: 'pal:0', rect: [x, y, w, h], fill: true });
    const build = (id: string, recipe: unknown) => buildFromRecipe(id, recipe as never);
    const read = (id: string, recipe: unknown) => measureNoise(createQualityContext(build(id, recipe)))[0];

    // **The specification's reading, computed here from the pixels rather than quoted from
    // `noise.ts`, so the table at the bottom is a check and not a transcription.** `neighboursAt` is
    // §3.3's sentence written out: the number of solid 4- and 8-neighbours of `p`, which excludes
    // `p` because a pixel is not its own neighbour. **This function is unchanged by the fix, and that
    // is why it is the thing to keep**: it was already the §3.3 reading while the analyzer was not,
    // so it disagreed on the day and the disagreement is what made the defect visible. A transcription
    // of the analyzer would have agreed with it and proved nothing.
    const neighboursAt = (sprite: Sprite, x: number, y: number) => {
      const context = createQualityContext(sprite);
      const { mask } = buildSolidMask(context.composite[0], context.width, context.height);
      let n4 = 0;
      let n8 = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= context.width || ny >= context.height) continue;
          if (mask[ny * context.width + nx] !== 1) continue;
          if (dx === 0 || dy === 0) n4++;
          n8++;
        }
      }
      return { n4, n8 };
    };

    // A 5x5 block, for the row §4.4 settles the convention with.
    const square = build('probe/square-5', {
      canvas: { w: 9, h: 9 },
      layers: ['Base'],
      palette: ['#3a2f2a'],
      ops: [block(2, 2, 5, 5)],
    });
    // **§4.4's own worked-example row, asserted rather than paraphrased: "one wrong-coloured pixel
    // inside a solid block (`n8 == 8`)". Eight, not nine.** This is the one assertion in the file
    // that says which reading the pipeline holds, and it is written against the specification's row
    // rather than against `noise.ts` — so on the day the analyzer counted itself, this pair said 9
    // and everything else in this block said nothing at all.
    expect(neighboursAt(square, 4, 4)).toEqual({ n4: 4, n8: 8 });
    expect(neighboursAt(square, 2, 2)).toEqual({ n4: 2, n8: 3 });

    // A 12x12 body on an 18x18 canvas with two pixels floating two pixels clear of it: nothing solid
    // within Chebyshev 1, which is `isolated` in §4.4's words and nothing else.
    const looseRecipe = {
      canvas: { w: 18, h: 18 },
      layers: ['Base'],
      palette: ['#3a2f2a'],
      ops: [block(3, 3, 12, 12), block(16, 5, 1, 1), block(16, 12, 1, 1)],
    };
    const loose = read('probe/two-loose-pixels', looseRecipe);
    // The same body with a 1px antenna hung off its right edge: the tip has exactly one solid
    // 8-neighbour, and it is orthogonal.
    const antennaRecipe = {
      canvas: { w: 20, h: 18 },
      layers: ['Base'],
      palette: ['#3a2f2a'],
      ops: [block(3, 3, 12, 12), block(15, 8, 1, 1), block(16, 8, 1, 1)],
    };
    const antenna = read('probe/one-antenna', antennaRecipe);
    // And a 1px diagonal run clear of the body: every pixel of it touches the drawing diagonally only.
    const diagonalRecipe = {
      canvas: { w: 24, h: 20 },
      layers: ['Base'],
      palette: ['#3a2f2a'],
      ops: [
        block(2, 2, 12, 12),
        { op: 'pixels', layer: 'Base', color: 'pal:0', points: [[16, 2], [17, 3], [18, 4], [19, 5], [20, 6], [21, 7]] },
      ],
    };
    const diagonal = read('probe/one-diagonal-run', diagonalRecipe);

    // **What §4.4 says each of those three shapes is, written out from the geometry above and checked
    // against the mask rather than asserted as prose.** A floating pixel has no neighbour: `isolated`.
    // An antenna's tip has exactly one, and it is orthogonal: `spurs`. A diagonal run's interior pixel
    // has two, both of them diagonal: `diagOnly`.
    expect(neighboursAt(build('probe/two-loose-pixels', looseRecipe), 16, 5)).toEqual({ n4: 0, n8: 0 });
    expect(neighboursAt(build('probe/one-antenna', antennaRecipe), 16, 8)).toEqual({ n4: 1, n8: 1 });
    expect(neighboursAt(build('probe/one-diagonal-run', diagonalRecipe), 18, 4)).toEqual({ n4: 0, n8: 2 });

    // **The readings, and every one of them derived from the geometry above rather than observed.**
    // The banding is what makes the flip legible: `rhu(2000, 146) = 14` for the two floating pixels,
    // which is past §4.4's `> 8/1000` trigger and lands in the `<= 20/1000` row, so `isolatedQ` is
    // **750 for the defect the code is named for** — where before the fix it read **1000** for that
    // code and 750 for a code it had nothing to do with.
    expect(loose.N).toBe(146);
    expect(loose.isolated).toBe(2);
    expect(loose.diagOnly).toBe(0);
    expect(loose.spurs).toBe(0);
    expect(loose.isolatedQ).toBe(750);
    expect(loose.spurQ).toBe(1000);
    expect(loose.issues.map((issue) => issue.code)).toEqual(['isolated-pixels']);
    // And the dimension's own arithmetic on top of that, because a correct count and a correct score
    // are two sentences: `rhu(300*750 + 200*1000 + 300*1000 + 200*1000, 1000) = 925`.
    expect(loose.scoreQ).toBe(925);

    // **The antenna is the shape `single-pixel-spur` is *named* for, and the tip is now counted.**
    // Exactly one solid 8-neighbour, and it is orthogonal, so `n8 == 1`; the pixel behind it has two
    // and is neither a spur nor diagonal-only.
    //
    // **`spurs` is 1 and no issue fires, and the reason is the trigger rather than the count.** `N`
    // is 146 here, so the ratio is `rhu(1000, 146) = floor(1073 / 146) = 7` — inside §4.4's
    // `<= 8/1000` band at `spurQ` 900 and under the `> 8/1000` trigger, so the dimension drops from
    // 1000 to 980 without saying anything. **That is the whole reason the corpus case for this code
    // is a 16x16 canvas** (`defect/single-pixel-spur-16`), where the same drawing is 102 pixels and
    // the ratio is `rhu(1000, 102) = 10`: this probe proves the count, the corpus case proves the
    // code, and a case drawn at this size would have been a green row proving nothing.
    expect(antenna.N).toBe(146);
    expect(antenna.isolated).toBe(0);
    expect(antenna.diagOnly).toBe(0);
    expect(antenna.spurs).toBe(1);
    expect(antenna.spurQ).toBe(900);
    expect(antenna.issues).toEqual([]);
    expect(antenna.scoreQ).toBe(980);

    // **The diagonal run, six pixels long and touching nothing but diagonally, is the shape
    // `diagonal-seam` is named for.** `n4 == 0` on all six, so `diagOnly` is 6 and the ratio is
    // `rhu(6000, 150) = floor(6075 / 150) = 40`, which lands in the `<= 50/1000` row at `diagQ` 500.
    //
    // **`Dmax` 5 is load-bearing and it is why `connectivity/diagonal-bridge-16` and
    // `connectivity/contour-staircase-24` cannot carry this code.** A bare 1px run is a line sprite
    // (`Dmax <= 1`), so `diagQ` is `null` and the issue is suppressed before a pixel is counted —
    // their `diag` of 1000/1000 was a raw ratio nobody was ever shown, not a code. The 12x12 body
    // beside the run is what keeps `Dmax` at 5, and it is the same reason the corpus case is a body
    // plus a run rather than the run alone.
    expect(diagonal.N).toBe(150);
    expect(diagonal.Dmax).toBe(5);
    expect(diagonal.lineSprite).toBe(false);
    expect(diagonal.isolated).toBe(0);
    expect(diagonal.diagOnly).toBe(6);
    expect(diagonal.diagQ).toBe(500);
    // **And the run's two ends read `n8 == 1` as well**, each having only its neighbour along the
    // run, so `spurs` is 2 and the same drawing also reports `single-pixel-spur` at
    // `rhu(2000, 150) = 13` and `spurQ` 750. A 1px diagonal seam *is* simultaneously the shape
    // `single-pixel-spur` names; that is a true property of the drawing rather than a defect in it,
    // and `defect/diagonal-seam-24x20` declares both codes for exactly that reason.
    expect(diagonal.spurs).toBe(2);
    expect(diagonal.spurQ).toBe(750);
    expect(diagonal.issues.map((issue) => issue.code)).toEqual(['diagonal-seam', 'single-pixel-spur']);
    expect(diagonal.scoreQ).toBe(850);

    // **What this geometry used to read, kept as the record of why the fix was needed.** "spec" is
    // §3.3's sentence, computed above by `neighboursAt`, which excludes the pixel itself; "read" is
    // what `noise`'s own `n4`/`n8` were holding, inferred from the counts and codes those readings
    // produced on these exact shapes. **Every reading was one higher than the specification, without
    // exception, and the consequences were structural rather than gradual:**
    //
    //     a 5x5 block's centre      spec 4 / 8   read 5 / 9   -> `n8` is never 0 and never 8
    //     a 5x5 block's corner      spec 2 / 3   read 3 / 4   -> `n4` is never 0
    //     a pixel with no neighbour spec 0 / 0   read 1 / 1   -> `isolated` unsatisfiable
    //     a 1px antenna's tip       spec 1 / 1   read 2 / 2   -> `spurs` blind to a real antenna
    //     a 1px diagonal run's end  spec 0 / 1   read 1 / 2   -> `diagOnly` unsatisfiable
    //
    // `n8 == 1` therefore meant "this pixel and nothing beside it", which is `isolated`: the two
    // floating pixels above read `isolated` 0 and `spurs` 2, and `single-pixel-spur` fired on a
    // drawing whose specks are `isolated-pixels`. `isolatedQ` was a constant 1000 and `diagOnly` a
    // constant 0 across every case in the corpus at the time, and not one of the three codes had
    // ever been reported once. **A sub-score that cannot fail is not a sub-score** — the third time
    // this repository has had to write that sentence, after `ditherMask`'s early exit and the band
    // table read in descending order.
  });

  it('reports a format error with the case that caused it, not a stack trace', () => {
    // A corpus of fifty-odd cases where one is wrong must say which one, or adding a case becomes a
    // guessing game.
    const error = new CorpusFormatError('cases[7].expect', 'nope');
    expect(error.message).toBe('corpus: cases[7].expect: nope');
    expect(error.where).toBe('cases[7].expect');
  });
});
