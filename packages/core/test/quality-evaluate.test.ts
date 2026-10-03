import { describe, expect, it } from 'vitest';
import { buildCase, readCorpusSpec } from '../../../benchmarks/corpus/build.js';
import { CommandError } from '../src/bus.js';
import { allCommands, createEditor, defaultRegistry } from '../src/commands/index.js';
import {
  assertFinalizable,
  QUALITY_GATE_THRESHOLDS,
  qualityGate,
  qualityGateForSprite,
  qualityGateRefusalMessage,
  type QualityGateRefusal,
} from '../src/commands/quality.js';
import { createQualityContext } from '../src/quality/context.js';

/**
 * How many refusals `qualityGateRefusalMessage` names before it collapses the rest into a count.
 * Mirrored here rather than imported because it is module-private in the product, and a test that
 * imported it would be asserting the message against the same constant that produced it — which is
 * the "measurement that cannot fail" shape. If the product's number moves, this fails.
 */
const NAMED_REFUSALS = 3;
import { evaluate as aggregateQualityReport } from '../src/quality/index.js';
import {
  FLOOR_FAIL,
  FLOOR_WARN,
  isBelow,
  QUALITY_DIMENSIONS,
  SCORE_FAIL_THRESHOLD,
  SCORE_PASS_THRESHOLD,
  SEVERITY_BLOCKING,
  verdictFor,
  type QualityAnalyzer,
  type QualityDimensionId,
  type QualityReport,
} from '../src/quality/types.js';

/**
 * T-019 and T-024 at the command boundary: `evaluate` reports, `verify` refuses.
 *
 * The pipeline has been reachable from a test since T-012 and from nothing else until this file.
 * That gap is invisible from the inside — every dimension has its own suite, the aggregator has
 * `quality-report.test.ts`, and nothing anywhere proved a *caller* could reach any of it. So the
 * assertions here are about the command surface rather than about the measurements, and every one
 * of them is written on its discriminating side:
 *
 *   1. **Reachable and free.** Registered in `allCommands`, so the CLI and the MCP catalogue get
 *      it with no second list to update, and `readOnly`, so asking a question costs no undo entry
 *      and no version bump. A test that only ran the command would pass even if `readOnly` were
 *      dropped and every `evaluate` silently ate the redo stack.
 *   2. **The target is what it says.** A `tag` resolves to *playback* order — a pingpong loop is
 *      longer than its frame range and is not document order — and `focus` narrows what is
 *      reported without narrowing what is measured. Both are §7.7's complaint: a report describes
 *      the frames it was given, so naming frames has to work, and it has to work without moving
 *      the numbers.
 *   3. **Determinism.** The same document in, byte-identical report out. This is also the
 *      mutation check: two editors over one `Sprite` share pixel buffers by reference, so a write
 *      inside an analyzer would make the second run differ.
 *   4. **The report is not flattened.** Every measured dimension, its verdict sentence, its
 *      issues and its `unmeasured` map survive onto the wire. §3 deleted a `quality_report` tool
 *      that handed out one number, so a command whose output could be reduced to a score without
 *      loss would be that tool again.
 *   5. **The gate.** Refuses on named defects, names the code and the measured number, never
 *      refuses for a dimension that did not apply, refuses loudly through its bypass, and never
 *      publishes a 0..1 score that could become a target.
 *
 * The gate tests live here rather than in a third file because the gate consumes the report and
 * cannot be reasoned about without one, and because the strongest thing they assert is an
 * *equality* between the gate's decision and `verdictFor`'s — which is what makes the gate safe to
 * wire into a delivery path.
 */

const SPEC = readCorpusSpec();

/**
 * A corpus sprite, built from a declared case rather than hand-drawn here.
 *
 * The corpus is the only source in this repository whose scores are not this pipeline's opinion
 * of its own output (§6.1), so a gate test that used synthetic pixels would be testing the
 * fixtures. The cases picked are one per behaviour the gate has to tell apart: a clean sprite that
 * passes, a clipped one that fails on a blocking issue, a full-bleed scene where `silhouette`
 * abstains, and an empty canvas where the only blocking issue is the aggregator's.
 */
function corpus(id: string) {
  const entry = SPEC.cases.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`the corpus has no case "${id}"`);
  const sprite = buildCase(entry);
  if (sprite === null) throw new Error(`the corpus case "${id}" is not buildable`);
  return sprite;
}

function run(sprite: ReturnType<typeof corpus>, name: string, params: unknown = {}) {
  return createEditor(sprite).tryExecute(name, params);
}

/** A report over one sprite, through the aggregator rather than the command. */
function reportOf(sprite: ReturnType<typeof corpus>): QualityReport {
  return aggregateQualityReport(createQualityContext(sprite));
}

interface Summary {
  dimensions: Record<string, Plan>;
  excluded: Record<string, string>;
  score: number;
  verdict: string;
  blocking: Plan[];
}

interface Plan {
  code: string;
  dimension: string;
  scoreQ: number;
  verdict: string;
  issues: Array<{ code: string; severityQ: number; blocking: boolean; rect: unknown }>;
  unmeasured: Record<string, string>;
}

/**
 * Every case the gate has to give an answer about, with the verdict it must agree with.
 *
 * `defect/detached-pieces-22` is here for a specific reason: it is the only one of these whose
 * issues include two at the *same* severity, which is what makes the ordering rule observable.
 * With severity alone deciding the sort, a reversed code comparison would be invisible everywhere
 * else in this file.
 */
const GATE_CASES = [
  'control/clean-figure-20',
  'bleed/two-pixel-margin-32',
  'defect/shape-clipped-32',
  'defect/subject-undersized-64',
  'defect/detached-pieces-22',
  'defect/interior-hole-speck-24',
  'defect/empty-canvas-16',
  'motion/blank-frame-16',
  'motion/frames-identical-16',
  'value/hue-carries-form-32',
  'defect/near-duplicate-ramp-16',
] as const;

/** An analyzer that returns a fixed score, so the gate can be driven to each of its channels. */
function stub(scoreQ: number): QualityAnalyzer {
  return () => ({ scoreQ, verdict: `stub at ${scoreQ}`, issues: [], unmeasured: {} });
}

/** A report whose only failures come from the channels this test is choosing. */
function stubbedReport(
  sprite: ReturnType<typeof corpus>,
  scores: Partial<Record<QualityDimensionId, number>>,
): QualityReport {
  const registrations = QUALITY_DIMENSIONS.filter((id) => scores[id] !== undefined).map((id) => ({
    id,
    analyze: stub(scores[id]!),
  }));
  return aggregateQualityReport(createQualityContext(sprite), registrations);
}

const rectKey = (rect: unknown): string =>
  rect === null || rect === undefined ? 'global' : JSON.stringify(rect);

/* ------------------------------------------------------------------ *
 * Reachability
 * ------------------------------------------------------------------ */

describe('the quality pipeline is on the command bus', () => {
  it('registers evaluate, fix and verify in the one catalogue', () => {
    // `allCommands` is the single source of truth for the CLI and the MCP tool catalogue. A
    // command written but not listed here is a command no client can reach, which is the exact
    // state this file exists to end.
    const names = allCommands.map((command) => command.name);
    expect(names).toContain('evaluate');
    expect(names).toContain('fix');
    expect(names).toContain('verify');
    for (const name of ['evaluate', 'fix', 'verify']) {
      expect(defaultRegistry.get(name), `${name} is not in the default registry`).toBeDefined();
    }
  });

  it('marks all three read-only, because asking a question must not cost a redo stack', () => {
    for (const name of ['evaluate', 'fix', 'verify']) {
      expect(defaultRegistry.get(name)?.readOnly, `${name} is not readOnly`).toBe(true);
    }
  });

  it('leaves the version and the history untouched when it answers', () => {
    const editor = createEditor(corpus('defect/shape-clipped-32'));
    const version = editor.version;
    editor.execute('evaluate');
    editor.execute('fix');
    // `verify` refuses here, and a refused read-only command must not have cost an undo entry
    // either — otherwise probing the gate would discard the user's redo stack.
    editor.tryExecute('verify');
    expect(editor.version).toBe(version);
    expect(editor.state.undoStack).toHaveLength(0);
    expect(editor.state.redoStack).toHaveLength(0);
  });

  it('describes every parameter it advertises', () => {
    // The MCP tool-surface test holds this for the entry-point tools; this is the same rule for
    // the commands, asserted here because these three are how an agent reaches the pipeline and
    // an undescribed parameter is one a model has to guess at.
    for (const name of ['evaluate', 'fix', 'verify']) {
      const command = defaultRegistry.get(name)!;
      const shape = (command.params as unknown as { shape: Record<string, { description?: string }> })
        .shape;
      for (const [key, field] of Object.entries(shape)) {
        expect(field.description, `${name}.${key} has no description`).toBeTruthy();
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Targeting
 * ------------------------------------------------------------------ */

describe('what is measured', () => {
  it('resolves a tag to playback order, not document order', () => {
    const sprite = corpus('motion/frames-identical-16');
    const editor = createEditor(sprite);
    const last = sprite.frames.length - 1;
    editor.execute('add_tag', { name: 'walk', from: 0, to: last, direction: 'pingpong' });

    const summary = editor.execute('evaluate', { tag: 'walk' }) as { frames: string[] };
    // Pingpong returns along the interior frames only, so the list is longer than the tag's range
    // and repeats a frame. Document order would be `frames.length` long with no repeats, and the
    // reverse direction would be `frames.length` long and descending — three different answers
    // from one tag, which is why §4.6 pushes the expansion into `animationSequence`.
    expect(summary.frames.length).toBe(last * 2);
    expect(summary.frames[1]).toBe(summary.frames[3]);
    expect(summary.frames).not.toEqual(sprite.frames.map((frame) => frame.id));
  });

  it('treats a one-frame pass as a statement about that frame', () => {
    // §7.7: a sprite whose frame 0 is strong and frame 5 is broken passes when evaluated on frame
    // 0. That is only useful if naming a frame really narrows the measurement, so this case is
    // the corpus's declared one for it — a clean 8x8 block, then three separate masses.
    const sprite = corpus('motion/worst-frame-wins-16');
    const editor = createEditor(sprite);
    const whole = editor.execute('evaluate') as { dimensions: Record<string, Plan>; frames: string[] };
    const clean = editor.execute('evaluate', { frames: [0] }) as {
      dimensions: Record<string, Plan>;
      frames: string[];
    };
    expect(whole.frames).toHaveLength(sprite.frames.length);
    expect(clean.frames).toEqual([sprite.frames[0].id]);
    // Every dimension carries the worst frame forward, so the sheet's reading is the broken
    // frame's and the one-frame pass is not a copy of it. `silhouette` is the discriminating
    // dimension here: frame 0 is one clean 8x8 block and frame 1 is three separate masses.
    expect(clean.dimensions.silhouette.scoreQ).toBe(1000);
    expect(whole.dimensions.silhouette.scoreQ).toBe(0);
  });

  it('narrows what it reports without narrowing what it measured', () => {
    const editor = createEditor(corpus('defect/interior-hole-speck-24'));
    const wide = editor.execute('evaluate') as { issues: Array<{ code: string }>; dimensions: Record<string, Plan> };
    const narrow = editor.execute('evaluate', {
      focus: { x: 0, y: 0, w: 1, h: 1 },
    }) as { issues: Array<{ code: string }>; dimensions: Record<string, Plan> };

    expect(wide.issues.length).toBeGreaterThan(0);
    // The corner of a 24×24 sprite is not where the subject is, so every issue falls outside the
    // focus and none is reported.
    expect(narrow.issues).toEqual([]);
    // The numbers are identical, because `focus` is a scope and not a crop: clipping the mask to
    // the box would make the box's own edge read as the sprite's edge and `shape-clipped` would
    // fire on the focus rect.
    expect(narrow.dimensions.value.scoreQ).toBe(wide.dimensions.value.scoreQ);
    expect(narrow.dimensions.silhouette.scoreQ).toBe(wide.dimensions.silhouette.scoreQ);
  });

  it('refuses to guess when the frames are named twice', () => {
    const sprite = corpus('motion/frames-identical-16');
    const editor = createEditor(sprite);
    editor.execute('add_tag', { name: 'walk', from: 0, to: 1 });
    const result = editor.tryExecute('evaluate', { tag: 'walk', frames: [0] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('command_failed');
    expect(result.error).toContain('pass one');
  });

  it('treats a mistyped parameter as an error rather than a default', () => {
    // `defineCommand` applies `.strict()`. A `framez` that quietly did nothing while `frames` was
    // meant is a data-loss-shaped bug, and it is deliberately not softened.
    const result = run(corpus('control/clean-figure-20'), 'evaluate', { framez: [0] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('invalid_params');
  });
});

/* ------------------------------------------------------------------ *
 * The report
 * ------------------------------------------------------------------ */

describe('the report is a report, not a number', () => {
  it('carries every measured dimension with its verdict, its issues and its unmeasured map', () => {
    const summary = createEditor(corpus('control/clean-figure-20')).execute('evaluate') as unknown as Summary;
    // The five registered dimensions, in `QUALITY_DIMENSIONS` order — which is
    // `DEFAULT_QUALITY_WEIGHTS` order, so an array a reader scans for "what is this worth"
    // answers the same as §5.1 — and nothing invented for the one that does not exist yet.
    // `palette` joined on its registration, and its *position* is the assertion: a dimension
    // registered out of weight order still measures correctly and still reads as though it
    // mattered less than it does.
    //
    // **`outline` is fifth and it MEASURES on this case, where the assertion used to say it did not
    // exist.** `control/clean-figure-20` is a two-tone figure with no drawn contour, so §4.5's `ink`
    // reads the dark half's outer edge as one: `outlineShare 327` over 52 boundary pixels, and the
    // dimension reports `scoreQ 350` with `outline-gap` at 0.25 and `outline-inconsistent-weight` at
    // 0.45. Both are advisory and `blocking` is empty, so the report still passes the gate — but
    // `verdict` is **`warn`**, not `pass`, because the total `0.845` sits under §5.3's line. That is
    // the whole change and it is asserted on the number rather than waved at.
    expect(Object.keys(summary.dimensions)).toEqual([
      'silhouette',
      'value',
      'palette',
      'noise',
      'outline',
    ]);
    // All six dimensions are implemented, so the one absent key here names a fact about the
    // document — one frame, nothing to read a movement out of — rather than the build.
    expect(summary.excluded).toEqual({
      motion: 'single-frame',
    });
    expect(summary.dimensions.outline.scoreQ).toBe(350);
    expect(summary.verdict).toBe('warn');
    expect(summary.score).toBe(0.845);
    for (const [id, dimension] of Object.entries(summary.dimensions)) {
      expect(dimension.scoreQ, `${id} has no score`).toBeGreaterThanOrEqual(0);
      expect(dimension.scoreQ, `${id} is not a per-mille integer`).toBeLessThanOrEqual(1000);
      expect(Number.isInteger(dimension.scoreQ)).toBe(true);
      expect(typeof dimension.verdict).toBe('string');
      expect(Array.isArray(dimension.issues)).toBe(true);
      // Required, never omitted: a sub-score nobody took is not a zero, and a caller reading
      // `value: 940` without this map would be reading a mark nobody earned.
      expect(dimension.unmeasured).toBeDefined();
    }
  });

  it('reports a dimension that did not apply as absent with a reason, never as a zero', () => {
    const summary = createEditor(corpus('bleed/full-bleed-scene-32')).execute('evaluate') as {
      dimensions: Record<string, Plan>;
      excluded: Record<string, string>;
    };
    // A full-bleed scene's alpha boundary is the canvas edge, so there is no shape to read. The
    // aggregator excludes `silhouette` with `no-subject` and runs the dimensions that do apply —
    // which is the whole reason applicability is per dimension rather than a document label.
    expect(summary.dimensions.silhouette).toBeUndefined();
    expect(summary.excluded.silhouette).toBe('no-subject');
    expect(summary.dimensions.value).toBeDefined();
    expect(summary.dimensions.palette).toBeDefined();
    expect(summary.dimensions.noise).toBeDefined();
  });

  it('agrees with the report about which issues block, and orders them the way it does', () => {
    // `everyIssue` re-implements `collectBlocking`'s dedupe and sort rather than importing it,
    // because that function is private to `quality/index.ts`. This is the guard that stops the
    // copy drifting: the blocking subset of the flat list has to *be* the report's blocking list,
    // in the report's order.
    for (const id of GATE_CASES) {
      const summary = createEditor(corpus(id)).execute('evaluate') as {
        issues: Array<{ code: string; blocking: boolean; rect: unknown }>;
        blocking: Array<{ code: string; rect: unknown }>;
      };
      const mine = summary.issues
        .filter((issue) => issue.blocking)
        .map((issue) => `${issue.code}|${rectKey(issue.rect)}`);
      const theirs = summary.blocking.map((issue) => `${issue.code}|${rectKey(issue.rect)}`);
      expect(mine, `${id} disagrees with itself about what blocks`).toEqual(theirs);
    }
  });

  it('orders issues by severity, then code, then rect, so a report is diffable', () => {
    // Severity alone is not enough to pin the order down, and an incidental sort order is a
    // baseline diff nobody can explain (§3.2 rule 4). The `defect/detached-pieces-22` case in
    // `GATE_CASES` carries two codes at 450, so the code comparison is genuinely exercised here.
    for (const id of GATE_CASES) {
      const summary = createEditor(corpus(id)).execute('evaluate') as {
        issues: Array<{ code: string; severityQ: number; rect: unknown }>;
      };
      const severities = summary.issues.map((issue) => issue.severityQ);
      expect(severities, `${id} is not sorted by severity descending`).toEqual(
        [...severities].sort((a, b) => b - a),
      );
      for (let i = 1; i < summary.issues.length; i++) {
        const previous = summary.issues[i - 1];
        const current = summary.issues[i];
        if (previous.severityQ !== current.severityQ) continue;
        const ordered =
          previous.code < current.code ||
          (previous.code === current.code && rectKey(previous.rect) <= rectKey(current.rect));
        expect(ordered, `${id}: ${previous.code} sorts before ${current.code} at one severity`).toBe(
          true,
        );
      }
    }
  });

  it('is byte-identical for the same document in', () => {
    // Determinism is a structural rule (§3.2), and this is also the mutation check: two editors
    // over one `Sprite` share pixel buffers by reference, so a write inside an analyzer would
    // make the second run differ.
    const sprite = corpus('value/hue-carries-form-32');
    const first = createEditor(sprite).execute('evaluate');
    const second = createEditor(sprite).execute('evaluate');
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('publishes severities in per-mille, so no threshold is ever compared as a float', () => {
    const summary = createEditor(corpus('defect/shape-clipped-32')).execute('evaluate') as {
      issues: Array<{ code: string; severityQ: number }>;
    };
    const clipped = summary.issues.find((issue) => issue.code === 'shape-clipped');
    expect(clipped?.severityQ).toBe(800);
    for (const issue of summary.issues) {
      expect(Number.isInteger(issue.severityQ)).toBe(true);
      expect(issue.severityQ).toBeGreaterThanOrEqual(0);
      expect(issue.severityQ).toBeLessThanOrEqual(1000);
    }
  });
});

/* ------------------------------------------------------------------ *
 * T-024 the gate
 * ------------------------------------------------------------------ */

describe('the gate decides exactly what the verdict decides', () => {
  it('refuses on `fail` if and only if the report is a fail', () => {
    // The contract the gate is safe under: it is not a second opinion, it is the verdict's own
    // definition decomposed into named reasons. If these two ever disagree, a delivery path built
    // on the gate would ship something `evaluate` called broken.
    for (const id of GATE_CASES) {
      const report = reportOf(corpus(id));
      const decision = qualityGate(report, { threshold: 'fail' });
      expect(decision.passed, `${id}: gate said ${decision.passed}, verdict ${report.verdict}`)
        .toBe(report.verdict !== 'fail');
    }
  });

  it('refuses on `warn` if and only if the report is not a pass', () => {
    for (const id of GATE_CASES) {
      const report = reportOf(corpus(id));
      const decision = qualityGate(report, { threshold: 'warn' });
      expect(decision.passed, `${id}: gate said ${decision.passed}, verdict ${report.verdict}`)
        .toBe(report.verdict === 'pass');
    }
  });

  it('reproduces the verdict from its own re-derived total, on every case', () => {
    // `qualityGate` reads §5.2's total from the aggregator's own `weightedTotalQ` rather than
    // re-deriving an integer from the report's float, because a gate has to be able to name a
    // threshold it measured against. There is no second copy to drift any more; this test is
    // what pins that the gate's reading of the total still reproduces the verdict the report
    // carries, which is the property a delivery path is built on.
    for (const id of GATE_CASES) {
      const report = reportOf(corpus(id));
      const decision = qualityGate(report, { threshold: 'warn' });
      const total = decision.refusals.find((refusal) => refusal.kind === 'total');
      const reDerived = total?.measuredQ ?? SCORE_PASS_THRESHOLD;
      expect(
        verdictFor({ totalQ: reDerived, dimensions: report.dimensions, blocking: report.blocking }),
        `${id}: the re-derived total disagrees with the report's verdict`,
      ).toBe(report.verdict);
    }
  });

  it('names the weighted total when no dimension named a defect', () => {
    // The case a weighted-mean gate cannot explain: three dimensions in the high hundreds, every
    // one above its floor, no blocking issue — and the report is still a `fail`, because the
    // total is a `fail` on its own. The gate has to be able to say so.
    const report = stubbedReport(corpus('control/clean-figure-20'), {
      silhouette: 450,
      value: 450,
      noise: 450,
    });
    expect(FLOOR_FAIL.silhouette).toBeLessThanOrEqual(450);
    expect(FLOOR_FAIL.value).toBeLessThanOrEqual(450);
    expect(FLOOR_FAIL.noise).toBeLessThanOrEqual(450);
    expect(report.verdict).toBe('fail');
    expect(report.blocking).toEqual([]);

    const decision = qualityGate(report, { threshold: 'fail' });
    expect(decision.passed).toBe(false);
    expect(decision.refusals.map((refusal) => refusal.kind)).toEqual(['total']);
    expect(decision.refusals[0].code).toBe('weighted-total');
    expect(decision.refusals[0].measuredQ).toBeLessThan(SCORE_FAIL_THRESHOLD);
    expect(decision.refusals[0].thresholdQ).toBe(SCORE_FAIL_THRESHOLD);
  });

  it('refuses a dimension below its floor and names the number', () => {
    const report = stubbedReport(corpus('control/clean-figure-20'), {
      silhouette: FLOOR_FAIL.silhouette,
      value: 1000,
      noise: 1000,
    });
    // `isBelow` is the one comparison in the pipeline, and the floor is exclusive: exactly on it
    // is not below it. One per-mille down is.
    expect(qualityGate(report).passed).toBe(true);

    const oneLower = stubbedReport(corpus('control/clean-figure-20'), {
      silhouette: FLOOR_FAIL.silhouette - 1,
      value: 1000,
      noise: 1000,
    });
    const decision = qualityGate(oneLower);
    expect(decision.passed).toBe(false);
    const floor = decision.refusals.find((refusal) => refusal.kind === 'floor');
    expect(floor?.dimension).toBe('silhouette');
    expect(floor?.measuredQ).toBe(FLOOR_FAIL.silhouette - 1);
    expect(floor?.thresholdQ).toBe(FLOOR_FAIL.silhouette);
  });

  it('refuses a blocking issue at or above the severity floor, inclusively', () => {
    // Hand-built here with an *unfiltered* `blocking` list on purpose. `report.blocking` is the
    // aggregator's job to filter, and `verdictFor` re-checks every entry with `isBlocking` rather
    // than trusting it; so does the gate, and this is the case that would catch it if it stopped —
    // a caller handing over an advisory would otherwise have every 0.35 become a refusal.
    const withIssue = (severity: number): QualityReport => ({
      ...stubbedReport(corpus('control/clean-figure-20'), {
        silhouette: 1000,
        value: 1000,
        noise: 1000,
      }),
      blocking: [{ code: 'shape-clipped', message: 'clipped', rect: null, severity }],
    });
    expect(qualityGate(withIssue(SEVERITY_BLOCKING - 0.01)).passed).toBe(true);
    expect(qualityGate(withIssue(SEVERITY_BLOCKING)).passed).toBe(false);
  });

  it('tolerates the strict threshold being one floor looser on every dimension', () => {
    const oneUnderWarn = FLOOR_WARN - 1;
    const report = stubbedReport(corpus('control/clean-figure-20'), {
      silhouette: oneUnderWarn,
      value: oneUnderWarn,
      noise: oneUnderWarn,
    });
    // One per-mille under the warn floor clears every fail floor — 400, 400 and 300 — so the
    // default threshold has nothing to say, while the strict one names all three.
    expect(qualityGate(report, { threshold: 'fail' }).passed).toBe(true);
    const strict = qualityGate(report, { threshold: 'warn' });
    expect(strict.passed).toBe(false);
    expect(
      strict.refusals.filter((refusal) => refusal.kind === 'floor').map((r) => r.dimension),
    ).toEqual(['silhouette', 'value', 'noise']);
    // `noise`'s floor at `fail` is 300, not 400 — the two style dimensions sit lower on purpose.
    expect(FLOOR_FAIL.noise).toBeLessThan(FLOOR_FAIL.silhouette);
  });
});

describe('failed is not the same as not applicable', () => {
  it('never refuses for a dimension that did not apply', () => {
    const report = reportOf(corpus('bleed/full-bleed-scene-32'));
    expect(report.excluded.silhouette).toBe('no-subject');
    // The strict threshold refuses this scene — `value` reads 400 and the weighted total is
    // 589 — so this is the setting where a leak would show. It refuses for the total, which is
    // §7's recorded open question about an abstention being netted, and never for the abstention.
    const decision = qualityGate(report, { threshold: 'warn' });
    expect(decision.notApplicable.silhouette).toBe('no-subject');
    expect(JSON.stringify(decision.refusals)).not.toContain('no-subject');
    for (const refusal of decision.refusals) {
      expect(refusal.dimension).not.toBe('silhouette');
    }
  });

  it('passes a target where nothing could be measured, even though the report is a fail', () => {
    // An empty active set totals 0, and §5.2 records that as `fail` only because 0 is the only
    // way a *required number* can say "nothing was measured". A gate that refused on it would be
    // refusing on an absence, which is the fake-defect failure this pipeline exists to prevent.
    const report = aggregateQualityReport(createQualityContext(corpus('control/clean-figure-20')), []);
    expect(report.verdict).toBe('fail');
    expect(report.score).toBe(0);
    const decision = qualityGate(report, { threshold: 'warn' });
    expect(decision.measured).toBe(false);
    expect(decision.passed).toBe(true);
    expect(decision.refusals).toEqual([]);
  });

  it('still refuses a real defect on a document that also abstains', () => {
    // The other half of the same rule: declining to invent a failure must not become declining to
    // see one. A `no-subject` abstention and a blocking issue can coexist, and only one of them
    // is a refusal.
    const sprite = corpus('bleed/full-bleed-scene-32');
    const editor = createEditor(sprite);
    editor.execute('clear_all');
    const decision = qualityGate(reportOf(sprite));
    expect(decision.measured).toBe(true);
    expect(decision.passed).toBe(true);

    const cleared = qualityGate(reportOf(editor.sprite));
    expect(cleared.measured).toBe(true);
    expect(cleared.passed).toBe(false);
    expect(cleared.refusals.map((refusal) => refusal.code)).toContain('empty-frame');
  });
});

describe('a refusal an agent can act on', () => {
  it('names the failing code and the measured number, and throws rather than reporting false', () => {
    // Returning `passed: false` would not be a refusal: `apply_ops` reports it as a success and
    // the caller moves on. Throwing is the one thing every client here already knows to surface.
    const result = run(corpus('defect/empty-canvas-16'), 'verify');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('command_failed');
    expect(result.error).toContain('empty-frame');
    expect(result.error).toContain('1000/1000');
    expect(result.error).toContain('500/1000');
  });

  it('names every reason it has room for and counts the rest', () => {
    const decision = qualityGate(reportOf(corpus('motion/blank-frame-16')));
    expect(decision.refusals.length).toBeGreaterThan(1);
    const message = qualityGateRefusalMessage(decision);
    for (const refusal of decision.refusals.slice(0, 3)) {
      expect(message).toContain(refusal.code);
      expect(message).toContain(`${refusal.measuredQ}/1000`);
    }
    expect(message).toContain('bypass: true');
  });

  it('tells two same-code refusals on different frames apart', () => {
    // `motion/worst-frame-wins-16` reports `flat-value` on both of its frames, at the same
    // severity, from different subject rects. A message that printed the code and the number
    // without the region would list one defect twice and read as a bug in the report.
    const decision = qualityGate(reportOf(corpus('motion/worst-frame-wins-16')));
    const flats = decision.refusals.filter((refusal) => refusal.code === 'flat-value');
    expect(flats).toHaveLength(2);
    expect(flats[0].rect).not.toEqual(flats[1].rect);
    const message = qualityGateRefusalMessage(decision);

    // **The invariant, which is narrower than "both rects appear" and is what actually matters.**
    // `NAMED_REFUSALS` is 3, and §4.6 registering `motion` added a blocking `silhouette-instability`
    // to this case, so the fixture now has four refusals and one of the two `flat-value` entries is
    // folded into the "(+N more)" tail. That is the designed behaviour, not a regression: an agent
    // needs the first three named and told how many remain far more than it needs the fourth inlined.
    //
    // So the property asserted is the one that survives: **no two NAMED refusals sharing a code are
    // printed with the same rect**, because that is the bug this test was written to catch — a list
    // that shows one defect twice and reads as a glitch in the report. And when anything was
    // truncated the message must say so, which is the difference between a short message and a lie.
    const namedFlats = message
      .split('; ')
      .map((part) => part.trim())
      .filter((part) => part.startsWith('flat-value'));
    for (let i = 0; i < namedFlats.length; i += 1) {
      for (let j = i + 1; j < namedFlats.length; j += 1) {
        expect(namedFlats[i]).not.toBe(namedFlats[j]);
      }
    }
    const omitted = decision.refusals.length - namedFlats.length;
    if (omitted > 0) {
      // The count is what makes a truncated message honest, so it is asserted rather than assumed:
      // this failed here once because the count was concatenated before the clip and clipped away
      // with it, which meant the message silently named three of seven refusals.
      expect(message).toContain(`+${decision.refusals.length - NAMED_REFUSALS} more`);
    } else {
      for (const refusal of flats) {
        expect(message).toContain(
          `${refusal.rect!.x},${refusal.rect!.y} ${refusal.rect!.w}x${refusal.rect!.h}`,
        );
      }
    }
  });

  it('never puts a 0..1 score in the refusal, because a score becomes a target', () => {
    // The one number this pipeline never puts in front of an agent is `unitScore`. `score: 0.685`
    // is the artifact §3 deleted the `quality_report` tool over, and a refusal that carries one is
    // a to-do list ("get to 0.80") rather than a list of defects.
    const message = qualityGateRefusalMessage(qualityGate(reportOf(corpus('motion/blank-frame-16'))));
    expect(message).not.toMatch(/\b0\.\d{2}\b/);
    expect(message).not.toMatch(/\b1\.0\b/);
  });

  it('does not put a score in a passing result either', () => {
    const summary = createEditor(corpus('control/clean-figure-20')).execute('verify') as Record<
      string,
      unknown
    >;
    expect(summary.passed).toBe(true);
    expect(summary.measured).toBe(true);
    expect(summary.refusals).toEqual([]);
    // Nothing here grades the artwork or says how far from passing anything is.
    expect(summary.score).toBeUndefined();
    expect(summary.quality).toBeUndefined();
    expect(summary.grade).toBeUndefined();
  });

  it('reports the dimensions that abstained alongside the ones that refused', () => {
    const result = run(corpus('defect/empty-canvas-16'), 'verify', {
      bypass: true,
      bypassReason: 'client asked for the source file only',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const summary = result.summary as Record<string, unknown>;
    // An abstention and a defect have to be readable in the same result, or a caller skimming
    // for `passed` cannot tell which of the six dimensions had anything to say.
    expect(summary.notApplicable).toBeDefined();
    expect(summary.dimensions).toBeDefined();
  });
});

describe('the bypass is explicit and loud', () => {
  it('refuses to bypass without a reason a person can read', () => {
    const result = run(corpus('defect/empty-canvas-16'), 'verify', { bypass: true });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // `invalid_params`, not `command_failed`: the arguments were incomplete, and an agent
    // branching on the code has to be told to fix its arguments rather than that the document
    // refused. `applyCommandWithSummary` re-codes anything thrown inside `apply`, so this pairing
    // has to be checked in the schema — `.check()` rather than `.refine()`, because `defineCommand`
    // applies `.strict()` and `.refine()` would take that away.
    expect(result.code).toBe('invalid_params');
    expect(result.error).toContain('bypassReason');
  });

  it('does not make a failing asset pass, and says out loud that it was released anyway', () => {
    const result = run(corpus('defect/empty-canvas-16'), 'verify', {
      bypass: true,
      bypassReason: 'the art director signed off in review',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const summary = result.summary as Record<string, unknown>;
    // `passed` stays false. The bypass is an override, not a re-measurement, and anything reading
    // this result can see the asset is failing.
    expect(summary.passed).toBe(false);
    expect(summary.bypassed).toBe(true);
    expect(summary.bypassReason).toBe('the art director signed off in review');
    // Three fields rather than one because the escape hatch is the thing an agent reaches for
    // silently, and a gate that can be turned off without a trace is not a gate.
    expect(summary.notice).toContain('QUALITY GATE BYPASSED');
    expect(summary.notice).toContain('empty-frame');
    expect(summary.notice).toContain('the art director signed off in review');
  });

  it('says nothing about a bypass on an asset that passed', () => {
    const result = run(corpus('control/clean-figure-20'), 'verify', {
      bypass: true,
      bypassReason: 'belt and braces',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const summary = result.summary as Record<string, unknown>;
    expect(summary.passed).toBe(true);
    expect(summary.bypassed).toBeUndefined();
    expect(summary.notice).toBeUndefined();
  });
});

describe('the gate a delivery path calls', () => {
  it('throws with a code, and hands the decision to whoever catches it', () => {
    let thrown: unknown;
    try {
      assertFinalizable(corpus('defect/empty-canvas-16'));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CommandError);
    expect((thrown as CommandError).code).toBe('command_failed');
    expect((thrown as CommandError).message).toContain('empty-frame');
    // The decision rides along, so a caller that caught the error does not have to re-measure.
    const details = (thrown as CommandError).details as { refusals: QualityGateRefusal[] };
    expect(details.refusals.map((refusal) => refusal.code)).toContain('empty-frame');
  });

  it('returns the report and the decision together on a passing asset', () => {
    const released = assertFinalizable(corpus('control/clean-figure-20'));
    expect(released.decision.passed).toBe(true);
    expect(released.decision.measured).toBe(true);
    // **`pass` became `warn`, and `passed` stayed `true`. That divergence is the assertion.** Both
    // halves are needed by a delivery path and they answer different questions: `passed` is §5.3's
    // blocking cut, and `control/clean-figure-20`'s two outline advisories sit at 0.25 and 0.45, so
    // `decision.refusals` is empty and the document ships. `verdict` is the *total*, and the two
    // numbers are measured rather than narrated:
    //
    //   without `outline`: silhouette 1000, value 700, palette 1000, noise 1000  -> total **0.905**, `pass`
    //   with `outline`:    the same four, plus outline 350 at weight 100          -> total **0.845**, `warn`
    //
    // The honest summary is that registering a dimension can demote a clean control without
    // refusing it, and a delivery path that showed only `passed` would hide that; both numbers are
    // returned so it can show both.
    expect(released.report.verdict).toBe('warn');
    expect(released.report.score).toBe(0.845);
    expect(released.report.dimensions.outline?.scoreQ).toBe(350);
    expect(released.report.blocking).toEqual([]);
    expect(released.decision.refusals).toEqual([]);
    // Both halves, so a delivery path can show the report to whoever asked for a bypass.
    expect(released.target.frames).toHaveLength(corpus('control/clean-figure-20').frames.length);
    expect(released.report.dimensions.silhouette).toBeDefined();
  });

  it('gates the frames it was pointed at, on the same terms `evaluate` uses', () => {
    // A delivery path must not be able to gate a different document from the one an artist
    // reviewed, so the targeting is the same three parameters with the same meaning.
    const sprite = corpus('motion/worst-frame-wins-16');
    const whole = qualityGateForSprite(sprite);
    const single = qualityGateForSprite(sprite, { frames: [0] });
    expect(whole.target.frames).toHaveLength(sprite.frames.length);
    expect(single.target.frames).toEqual([sprite.frames[0].id]);
    // Both fail — frame 0 is a flat 8x8 block, which `flat-value` refuses — but the gate measured
    // what it was pointed at, so the sheet's refusal list names frame 1's `fragmented-silhouette`
    // and the one-frame pass cannot.
    const wholeCodes = whole.decision.refusals.map((refusal) => refusal.code);
    const singleCodes = single.decision.refusals.map((refusal) => refusal.code);
    expect(wholeCodes).toContain('fragmented-silhouette');
    expect(singleCodes).not.toContain('fragmented-silhouette');
    expect(single.decision.refusals.length).toBeLessThan(whole.decision.refusals.length);
    // Each run still agrees with its own report, which is the property the delivery path relies on.
    expect(whole.decision.passed).toBe(whole.report.verdict !== 'fail');
    expect(single.decision.passed).toBe(single.report.verdict !== 'fail');
  });

  it('demands a reason for a bypass here too', () => {
    expect(() => assertFinalizable(corpus('defect/empty-canvas-16'), { bypass: true })).toThrow(
      /bypassReason/,
    );
    const released = assertFinalizable(corpus('defect/empty-canvas-16'), {
      bypass: true,
      bypassReason: 'hotfix, art review on Monday',
    });
    expect(released.decision.passed).toBe(false);
  });
});

describe('the documented threshold', () => {
  it('states both settings, and `fail` is the default', () => {
    expect(Object.keys(QUALITY_GATE_THRESHOLDS).sort()).toEqual(['fail', 'warn']);
    for (const description of Object.values(QUALITY_GATE_THRESHOLDS)) {
      expect(description.length).toBeGreaterThan(40);
    }
    expect(qualityGate(reportOf(corpus('control/clean-figure-20'))).threshold).toBe('fail');
  });

  it('keeps the uncalibrated default off the total-score channel', () => {
    // §2.1's tolerance column: a gate nobody has measured is a gate that blocks good work, and
    // §6.2 has run once on one sprite. `fail` refuses named defects and named floors; the total
    // is the one channel where an abstention is netted against unrelated clean readings, which is
    // §7's recorded open question, so it is the strict setting's job and not the default's.
    const report = stubbedReport(corpus('control/clean-figure-20'), {
      silhouette: 700,
      value: 700,
      noise: 700,
    });
    expect(report.verdict).toBe('warn');
    expect(qualityGate(report, { threshold: 'fail' }).passed).toBe(true);
    expect(qualityGate(report, { threshold: 'warn' }).passed).toBe(false);
    // Every dimension is above `FLOOR_WARN`, so the strict refusal is the total and nothing else.
    for (const id of ['silhouette', 'value', 'noise'] as QualityDimensionId[]) {
      expect(isBelow(700, FLOOR_WARN)).toBe(false);
    }
    expect(qualityGate(report, { threshold: 'warn' }).refusals.map((r) => r.kind)).toEqual(['total']);
  });
});