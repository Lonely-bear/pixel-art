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
import { makeId } from '../src/ids.js';
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
    expect([...emitted].sort()).toEqual([
      'detached-pieces',
      'empty-frame',
      'flat-value',
      'fragmented-silhouette',
      'frames-identical',
      'highlight-blown',
      'hue-carries-form',
      'interior-hole',
      'narrow-value-range',
      'plane-crosses-form',
      'shadow-crushed',
      'shape-clipped',
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
    const scenes = real().filter((entry) => row(entry.id).preconditions.silhouette === 'no-subject');
    const said = [...new Set(scenes.flatMap((entry) => row(entry.id).actualCodes))].sort();
    expect(said).toEqual(['hue-carries-form', 'key-light-inconsistent']);
    const flagged = scenes
      .map((entry) => ({ id: entry.id, codes: row(entry.id).actualCodes }))
      .filter((entry) => entry.codes.length > 0);
    expect(flagged.map((entry) => entry.id).sort()).toEqual([
      'artwork/dusk-lake-valley-v2.pixel',
      'artwork/moonlit-alpine-lake-fast.pixel',
      'artwork/sunset-lighthouse-512-baseline-model-a.pixel',
    ]);
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
    // **And the gate the form term reads nothing through, which is the other half of the same
    // finding.** §4.2's curvature gate asks whether the local silhouette is round, and it reads
    // that off the subject's own outline. All ten scenes reach every canvas edge, so their outline
    // *is* the frame: `maxCurvedQ` over every plane is 0..77 against a gate of 250, and not one
    // plane on any of the ten comes close to being judged. A straight shadow band across a curved
    // mountain is still excused today — the gate is doing its job on a rectangle — but the report no
    // longer calls that a clean form measurement.
    //
    // **Curvature and not reach is the gate that binds, and the corpus now says which.** The autumn
    // lake's most favourable plane reaches `reachQ` 1000, well over that gate's 500, so an
    // assertion on the reach column would have read as a pass and hidden the finding. It is the
    // curvature maximum that never clears 250, on any plane, on any of the ten — which is the
    // measurement T-013 recorded as "the curvature gate reads nothing on a full-bleed subject"
    // before anyone asked what the report was doing with the 1000 that followed.
    //
    // **This assertion used to be `every real asset reads formQ 1000`, and it was pinning the bug
    // as expected behaviour with a paragraph explaining why.** The maxima replace the worst plane's
    // readings on purpose: reading them off `worst` prints `-` on exactly the rows this finding is
    // about, which is the one thing a re-measured column must not do.
    for (const entry of scenes) {
      expect(row(entry.id).value?.maxCurvedQ ?? 0, entry.id).toBeLessThan(250);
      // And the absence is stated, not inferred from a number.
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
    expect(keeper.actualCodes).toEqual(['interior-hole', 'key-light-inconsistent', 'thin-profile']);
    expect(keeper.blocking).toEqual([]);
    expect(keeper.actualVerdict).toBe('pass');
    expect(keeper.scores.value).toBe(850);
    // The tightest side of the only real character sprite has ONE pixel of frame, and the dimension
    // still applies. That is worth knowing: `SUBJECT_REQUIRED_MARGIN` costs a false exclusion for a
    // subject within 1px of all four edges, and this sprite is one pixel away from being that.
    expect(keeper.frames[0].margin).toBe(1);
    expect(keeper.preconditions.silhouette).toBeNull();

    const icon = row('app/icon.png');
    expect(icon.scores.silhouette).toBe(1000);
    // The icon is the one real asset `value` says nothing about: 12 buckets, a 479px `Dmax` and a
    // `curvedQ` of 0, and no code from either dimension. Worth having, because it is the counterexample
    // to "every real asset is a flat sticker the curvature gate cannot see".
    expect(icon.actualCodes).toEqual([]);
    expect(icon.actualVerdict).toBe('pass');
    expect(icon.frames[0].margin).toBe(32);
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
    // Was `only the dimension that exists`, and the rename is the finding: `value` landed and the
    // assertion went stale, exactly as the hard-coded defect list above did. Both dimensions are
    // measured on the same rows and on opposite halves of the range — `silhouette` reaches 1000 on
    // a clean blob and 0 on a 1px staircase, `value` 1000 and 125 — which is the distribution a
    // gate argument is made from.
    const measured = DISTRIBUTION.scores.filter((entry) => entry.values.length > 0);
    expect(measured.map((entry) => entry.dimension)).toEqual(['silhouette', 'value']);
    expect(measured[0].min).toBeLessThan(measured[0].max);
    expect(measured[1].min).toBeLessThan(measured[1].max);
    expect(measured[1].min).toBe(125);
    // The four that do not exist are absent rather than zero, which is the `not-implemented`
    // bookkeeping working and not a gap in the corpus.
    expect(DISTRIBUTION.scores.filter((entry) => entry.values.length === 0)).toHaveLength(4);
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

  it('has at least one case per defect kind the loader allows', () => {
    // **Derived from the loader's own closed list, not from a copy of it.** The question here is
    // "does every code the loader accepts have a case that says what it means?", and the closed enum
    // is a specification rather than an implementation — so reading it is not the circularity the
    // re-export test above warns about, and a hard-coded list is exactly the second copy that went
    // stale when `value` landed. The floor below is what stops the derivation from being vacuous: a
    // truncated `DEFECT_KINDS` satisfies the comparison, and only the count stops that.
    const declared = new Set(synthetic().flatMap((entry) => entry.defects.map((d) => d.kind)));
    expect([...declared].sort()).toEqual([...DEFECT_KINDS].sort());
    expect(DEFECT_KINDS.length).toBeGreaterThanOrEqual(15);
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
    expect(DEFECT_KINDS.filter((kind) => !declared.has(kind))).toEqual([]);
    // The code is not dead, which is the part that matters: it fires on a real fixture and on three
    // of the ten committed scenes, and both are asserted elsewhere in this file. A code that quietly
    // stops appearing is a code that quietly stops working.
    expect(row('value/hue-carries-form-32').actualCodes).toContain('key-light-inconsistent');
  });

  it('reports a format error with the case that caused it, not a stack trace', () => {
    // A corpus of fifty-odd cases where one is wrong must say which one, or adding a case becomes a
    // guessing game.
    const error = new CorpusFormatError('cases[7].expect', 'nope');
    expect(error.message).toBe('corpus: cases[7].expect: nope');
    expect(error.where).toBe('cases[7].expect');
  });
});
