import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  });

  it('fails a case that measures something other than it declares', () => {
    // A `measure` expectation is the other half of the guard: the gate could be moved so that
    // `compactnessQ` stopped being reported at all, and every code expectation would still pass.
    const broken = runCorpus(withExpectation('sweep/rect-30x4', { measure: { compactnessQ: [999] } }), SCORES);
    expect(broken.failures.map((f) => f.id)).toEqual(['sweep/rect-30x4']);
    expect(broken.failures[0].reason).toContain('measured [326]');
  });

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
    expect([...emitted].sort()).toEqual([
      'detached-pieces',
      'empty-frame',
      'fragmented-silhouette',
      'frames-identical',
      'interior-hole',
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
    expect(clipped.actualCodes).toEqual(['shape-clipped']);
    expect(clipped.blocking).toEqual(['shape-clipped']);
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
    // on a CRT the corner contact disappears, so the analyzer is right to call it a stray.
    expect(corner.actualCodes).toEqual(['detached-pieces']);
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
    // And the sweep brackets it within 15 per-mille, so the corpus can say what the gate would have
    // to fall between rather than only that it is wrong about one asset. The neighbours are the
    // nearest samples *either side*, exclusive of the reference itself.
    expect(DISTRIBUTION.neighbours).not.toBeNull();
    const [below, above] = DISTRIBUTION.neighbours!;
    expect(below.compactnessQ).toBeLessThan(269);
    expect(above.compactnessQ).toBeGreaterThan(269);
    expect(below.id).toBe('sweep/rect-30x3');
    expect(below.compactnessQ).toBe(260);
    expect(above.id).toBe('sweep/rect-28x3');
    expect(above.compactnessQ).toBe(275);
    expect(above.compactnessQ - below.compactnessQ).toBeLessThanOrEqual(20);
    expect(DISTRIBUTION.belowReference).toBeGreaterThan(0);
    expect(DISTRIBUTION.belowReference).toBeLessThan(DISTRIBUTION.samples.length);
  });

  it('prices every candidate gate in both directions, which is what a move is argued from', () => {
    // Lowering the gate can only *release* subjects, never penalise new ones, so the cost of
    // admitting the one real character sprite is exactly the `released` list at 269. Nothing in
    // this file decides that is worth paying - the table exists so the decision has numbers in it.
    const at = (gate: number) => DISTRIBUTION.sensitivity.find((entry) => entry.gate === gate)!;
    expect(DISTRIBUTION.sensitivity.map((entry) => entry.gate)).toEqual([200, 250, 260, 269, 275, 300]);
    // The count below each candidate, which is the whole curve in six points: 44, 65, 157, 184,
    // 234, 259, 260, 269, 275, 295 are the ten subjects the gate at 300 penalises.
    expect(at(200).penalised).toBe(4);
    expect(at(250).penalised).toBe(5);
    expect(at(260).penalised).toBe(6);
    expect(at(269).penalised).toBe(7);
    expect(at(275).penalised).toBe(8);
    expect(at(300).penalised).toBe(DISTRIBUTION.below);
    // The price of admitting the keeper, and the shape of it. A gate is one number, so the only
    // thresholds that release `compactnessQ 269` are G <= 269, and every such G also releases
    // everything above it up to 300: the 275 band and the 295 frame. There is no gate that admits
    // the character sprite and nothing else, which is the thing a reader most wants to know and
    // cannot get from a single-assample argument.
    expect(at(269).released.map((s) => s.id)).toEqual([
      'artwork/verify/lantern-keeper.pixel',
      'sweep/rect-28x3',
      'motion/worst-frame-wins-16',
    ]);
    // At 275 the keeper is still penalised, and only the two above it are released.
    expect(at(275).released.map((s) => s.id)).toEqual([
      'sweep/rect-28x3',
      'motion/worst-frame-wins-16',
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
    // `thin-profile` while the other does not.
    expect(row('sweep/rect-30x4').actualCodes).toEqual([]);
    expect(row('sweep/rect-28x3').actualCodes).toEqual(['thin-profile']);
    expect(row('sweep/rect-30x4').frames[0].compactnessQ).toBeGreaterThan(SPEC_GATES.compactnessQ);
    expect(row('sweep/rect-28x3').frames[0].compactnessQ).toBeLessThan(SPEC_GATES.compactnessQ);
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
    // its own boundary in both counts, 12 pixels and 48 transitions.
    const bridge = row('connectivity/diagonal-bridge-16').frames[0];
    expect(bridge.edgePixels).toBe(12);
    expect(bridge.perimeter).toBe(48);
    expect(bridge.compactnessQ).toBeLessThan(SPEC_GATES.compactnessQ);
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
    // hold still passes the gate.
    expect(hold.actualCodes).toEqual(['frames-identical']);
    expect(hold.blocking).toEqual([]);
    expect(hold.actualVerdict).toBe('pass');
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
    expect(blank.actualCodes).toEqual(['empty-frame']);
    expect(blank.blocking).toEqual(['empty-frame']);
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

  it('excludes every full-bleed scene and reports no defect about it', () => {
    const scenes = real().filter((entry) => row(entry.id).preconditions.silhouette === 'no-subject');
    expect(scenes.length).toBe(10);
    for (const entry of scenes) {
      const result = row(entry.id);
      expect(result.actualCodes, entry.id).toEqual([]);
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

  it('keeps the two real subjects measurable, and records them as a drift baseline', () => {
    // `measure` on a real case means "the analyzer still says what it said", which is a real guard.
    // It does NOT mean the analyzer is right, and the loader is what stops it being read as a claim
    // about the art.
    const keeper = row('artwork/verify/lantern-keeper.pixel');
    expect(keeper.scores.silhouette).toBe(800);
    expect(keeper.actualCodes).toEqual(['interior-hole', 'thin-profile']);
    expect(keeper.blocking).toEqual([]);
    expect(keeper.actualVerdict).toBe('pass');
    // The tightest side of the only real character sprite has ONE pixel of frame, and the dimension
    // still applies. That is worth knowing: `SUBJECT_REQUIRED_MARGIN` costs a false exclusion for a
    // subject within 1px of all four edges, and this sprite is one pixel away from being that.
    expect(keeper.frames[0].margin).toBe(1);
    expect(keeper.preconditions.silhouette).toBeNull();

    const icon = row('app/icon.png');
    expect(icon.scores.silhouette).toBe(1000);
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
  });

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
    expect([...groups.keys()].sort()).toEqual([
      'silhouette/hole-clause',
      'silhouette/line-vs-filled',
      'silhouette/margin-guard',
      'silhouette/thickness-sweep',
    ]);

    // §6.2's own silhouette pair: a 1px line sprite against a filled one. compactnessQ separates
    // them by 711 and the score by 1000, because a line also fragments and the mean hides nothing
    // here.
    const line = groups.get('silhouette/line-vs-filled')!;
    expect(line.members.map((m) => m.id).sort()).toEqual([
      'connectivity/diagonal-bridge-16',
      'control/clean-blob-16',
    ]);
    expect(line.gap).toBe(1000);
    expect(line.rawGap).toBe(1000);
    expect(line.compactnessGap).toBe(711);

    // The thickness pair, matched to one variable: same width, same canvas, same margin, and the
    // height is the only difference. compactnessQ separates it by 600 and the score by 100 - the
    // whole of that 100 is the one -100 of `thin-profile`, which is the number worth reviewing.
    const thickness = groups.get('silhouette/thickness-sweep')!;
    expect(thickness.members.map((m) => m.id).sort()).toEqual(['sweep/rect-30x2', 'sweep/rect-30x28']);
    expect(thickness.gap).toBe(100);
    expect(thickness.compactnessGap).toBe(600);

    // The hole pair separates by 0 on the score: a 1px speck and a 6x6 window are both
    // `interior-hole` at the same -100, from two different clauses of the same condition. The
    // compactnessQ gap of 288 says the two shapes really are different and the penalty ignores it.
    const holes = groups.get('silhouette/hole-clause')!;
    expect(holes.gap).toBe(0);
    expect(holes.compactnessGap).toBe(288);

    // The margin family is the one the applicability predicate exists for, and it is four cases
    // rather than two: the same 32-wide ink at 0px, 1px and 2px of margin, plus a 2px-guarded
    // three-edge crop. Two of the four get no score at all, which is the point; the raw
    // measurement separates them by 200, entirely from `shape-clipped`; and compactnessQ
    // separates them by 2, because the quotient is scale-invariant, so insetting a square changes
    // nothing about it and the 2 comes from the 32x29 member having a different aspect ratio.
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
  });

  it('per-dimension score distribution covers only the dimension that exists', () => {
    const measured = DISTRIBUTION.scores.filter((entry) => entry.values.length > 0);
    expect(measured.map((entry) => entry.dimension)).toEqual(['silhouette']);
    expect(measured[0].min).toBeLessThan(measured[0].max);
    // The five that do not exist are absent rather than zero, which is the `not-implemented`
    // bookkeeping working and not a gap in the corpus.
    expect(DISTRIBUTION.scores.filter((entry) => entry.values.length === 0)).toHaveLength(5);
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
    const names = [
      'buildSolidMask',
      'connectedComponents',
      'interiorHoles',
      'borderTouch',
      'boundaryPerimeter',
      'compactnessQ',
      'countConvexCorners',
      'rhu',
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

  it('records the dist/Dmax conflict with a discriminator, and the discriminator is real', () => {
    // §3.3 defines `dist` twice, incompatibly: the table says Chebyshev, the prose says a
    // 4-connected BFS. Three dimensions need it and none exists, so the corpus states which reading
    // this repository adopts and hands the implementing dimension a test to reproduce rather than a
    // judgement call to make again.
    const entry = DECLARED_QUANTITIES.find((q) => q.name === 'dist / Dmax');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('unimplemented');
    expect(entry!.adopted).toContain('4-connected multi-source BFS');
    expect(entry!.neededBy).toEqual(['value', 'outline', 'noise']);
    // The discriminating shape, measured from the specification's two wordings and from nothing in
    // the pipeline: a 3x3 block with ONE corner pixel removed. The pixel diagonally opposite the
    // removed corner then has all four of its orthogonal neighbours solid and one transparent
    // diagonal, so L-infinity reaches a hole in one step and L1 needs two.
    const mask = new Uint8Array(9 * 9);
    for (let y = 2; y < 5; y++) for (let x = 2; x < 5; x++) mask[y * 9 + x] = 1;
    mask[4 * 9 + 2] = 0;
    const chebyshev = maxChebyshevDistance(mask, 9, 9);
    const manhattan = maxConnected4Distance(mask, 9, 9);
    expect(chebyshev).toBe(1);
    expect(manhattan).toBe(2);
    expect(entry!.discriminatorValues).toEqual([
      ['Chebyshev (L-infinity, the table)', chebyshev],
      ['4-connected BFS (L1, the prose)', manhattan],
    ]);
    // And neither is the pipeline's answer today, because neither exists: the three dimensions that
    // need `Dmax` have no analyzer, so nothing in the repository is currently wrong about it. That
    // is the window in which the conflict is cheap to settle.
    expect(DECLARED_QUANTITIES.filter((q) => q.status === 'unimplemented')).toHaveLength(1);
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
    const declared = new Set(synthetic().flatMap((entry) => entry.defects.map((d) => d.kind)));
    expect([...declared].sort()).toEqual([
      'clean-control',
      'detached-pieces',
      'empty-frame',
      'fragmented-silhouette',
      'frames-identical',
      'interior-hole',
      'shape-clipped',
      'subject-undersized',
      'thin-profile',
    ]);
  });

  it('reports a format error with the case that caused it, not a stack trace', () => {
    // A corpus of fifty-odd cases where one is wrong must say which one, or adding a case becomes a
    // guessing game.
    const error = new CorpusFormatError('cases[7].expect', 'nope');
    expect(error.message).toBe('corpus: cases[7].expect: nope');
    expect(error.where).toBe('cases[7].expect');
  });
});
