import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PixelBuffer } from '../src/buffer.js';
import { createSprite, type Sprite } from '../src/document.js';
import { decodePNG } from '../src/png.js';
import { deserializeSprite } from '../src/serialize.js';
import { createQualityContext, type QualityContextOptions } from '../src/quality/context.js';
import {
  aggregatorIssues,
  analyzerFor,
  compositesAreIdentical,
  DEFAULT_ANALYZERS,
  DEFAULT_DIMENSIONS,
  evaluate,
  hasReadableSubject,
  motionApplicability,
  requiresReadableSubject,
  SUBJECT_REQUIRED_MARGIN,
  type QualityDimensionRegistration,
} from '../src/quality/index.js';
import { silhouetteAnalyzer } from '../src/quality/silhouette.js';
import { valueAnalyzer } from '../src/quality/value.js';
import { noiseAnalyzer } from '../src/quality/noise.js';
import {
  assertReportInvariants,
  DEFAULT_QUALITY_WEIGHTS,
  FLOOR_FAIL,
  isBlocking,
  QUALITY_DIMENSIONS,
  type QualityAnalyzer,
  type QualityContext,
  type QualityDimensionId,
  type QualityIssue,
  reportInvariantViolations,
  SCORE_FAIL_THRESHOLD,
  SCORE_PASS_THRESHOLD,
  unitScore,
} from '../src/quality/types.js';

/**
 * The aggregator, measured.
 *
 * `silhouette` is the only dimension that exists, so this file is where the pipeline's
 * *shape* gets pinned rather than its numbers: which dimensions apply, what the weighted
 * total is over, what reaches the blocking list, and what the report says when there is
 * nothing to say. Five more dimensions are blocked behind those answers, and a rule that is
 * only ever exercised on one dimension is a rule that has never been tested.
 *
 * Two of the three jobs are the ones a partial implementation gets wrong by construction:
 *
 *   1. **The denominator is the active set.** A still sprite is scored over 920, not 1000,
 *      and the naive version of that arithmetic is *arithmetically valid and wrong*, so it
 *      needs its own assertion rather than a comment: 0.88 must come out as 0.88 and not as
 *      0.81.
 *   2. **The verdict is decided on the integer, not the float that carries it.** A report
 *      whose total lands exactly on a threshold is the only place the two could disagree,
 *      and `verdictFor` failing closed on a 0.55 handed in where 550 belongs is the failure
 *      the `Q` suffix exists to make loud.
 *
 * The third is the reason this file exists at all, and it is measured against the
 * repository's own artwork rather than against a fixture: ten of the twelve committed
 * assets are full-bleed scenes, and a scorer that called them clipped and reported 800 was
 * confidently wrong about good work. A synthetic fixture cannot make that regression
 * visible, so the corpus does.
 */

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/**
 * A sprite whose frames are painted by a predicate.
 *
 * Pictures and rectangles, never `data[i*4+3] = 255` in four places, for the reason
 * `quality-silhouette.test.ts` gives: a fixture nobody can read is one nobody can review.
 */
function spriteWhere(
  width: number,
  height: number,
  alphaAt: (x: number, y: number, frame: number) => number,
  frames = 1,
): Sprite {
  const sprite = createSprite({ width, height, frames, name: 'fixture' });
  const layer = sprite.layers[0].id;
  for (let f = 0; f < frames; f++) {
    const cel = new PixelBuffer(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const alpha = alphaAt(x, y, f);
        if (alpha === 0) continue;
        const i = cel.index(x, y);
        cel.data[i] = 40;
        cel.data[i + 1] = 60;
        cel.data[i + 2] = 90;
        cel.data[i + 3] = alpha;
      }
    }
    sprite.frames[f].cels.set(layer, cel);
  }
  return sprite;
}

/** A frame painted by a per-frame predicate over one opaque rectangle. */
function blockWhere(
  width: number,
  height: number,
  rectAt: (frame: number) => { x: number; y: number; w: number; h: number },
  frames = 1,
): Sprite {
  return spriteWhere(
    width,
    height,
    (x, y, f) => {
      const r = rectAt(f);
      return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h ? 255 : 0;
    },
    frames,
  );
}

/** Fully inked canvas: the full-bleed case, and the only fixture here with no transparent frame. */
function fullBleed(width = 32, height = 32, frames = 1): Sprite {
  return spriteWhere(width, height, () => 255, frames);
}

/** The same ink inset by `margin` pixels on all four sides. */
function insetBy(margin: number, width = 32, height = 32, frames = 1): Sprite {
  return blockWhere(width, height, () => ({ x: margin, y: margin, w: width - margin * 2, h: height - margin * 2 }), frames);
}

/** An analyzer that returns a fixed score, for testing the aggregator with no dimension in it. */
function stub(scoreQ: number, issues: readonly QualityIssue[] = []): QualityAnalyzer {
  // `unmeasured` is written rather than omitted even though nothing here reads it: a stub that
  // leaves it off hands the aggregator `undefined` for a field the contract makes required, and
  // tests are not typechecked, so nothing would say so until a dimension started reading it.
  return () => ({ scoreQ, verdict: `stub at ${scoreQ}`, issues, unmeasured: {} });
}

/** The same, plus the issues a dimension would emit. */
function stubWith(issues: readonly QualityIssue[], scoreQ = 500): QualityAnalyzer {
  return () => ({ scoreQ, verdict: `stub with ${issues.length} issue(s)`, issues, unmeasured: {} });
}

function reg(
  id: QualityDimensionId,
  analyze: QualityAnalyzer,
  applies?: (context: QualityContext) => 'single-frame' | 'no-motion-content' | 'no-subject' | 'not-implemented' | null,
): QualityDimensionRegistration {
  return applies === undefined ? { id, analyze } : { id, analyze, applies };
}

/** Every dimension at `scoreQ`, so a test can move one and watch the total. */
function allAt(scoreQ: number): QualityDimensionRegistration[] {
  return QUALITY_DIMENSIONS.map((id) =>
    id === 'motion' ? reg(id, stub(scoreQ), motionApplicability) : reg(id, stub(scoreQ)),
  );
}

const BLOCKING_ISSUE: QualityIssue = {
  code: 'shape-clipped',
  message: 'blocking',
  rect: { x: 0, y: 0, w: 8, h: 8 },
  severity: 0.8,
};

function codes(issues: readonly QualityIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

function firstContext(sprite: Sprite, options: QualityContextOptions = {}): QualityContext {
  return createQualityContext(sprite, options);
}

/* ------------------------------------------------------------------ *
 * Applicability
 * ------------------------------------------------------------------ */

describe('a full-bleed document has no subject, and silhouette says so', () => {
  it('excludes the dimension with a reason instead of scoring the canvas edge', () => {
    const report = evaluate(firstContext(fullBleed()));
    // The whole point: absence, with a reason, rather than a number about a frame.
    expect(report.dimensions.silhouette).toBeUndefined();
    expect(report.excluded.silhouette).toBe('no-subject');
    expect(reportInvariantViolations(report)).toEqual([]);
  });

  it('does not report the ten scenes\' blocking shape-clipped defect', () => {
    // Before the precondition existed, this document scored 800 with `shape-clipped` at
    // severity 0.80 — blocking — because `borderTouch` is 4 whenever the ink runs to the
    // frame. The issue is not filtered out of the report; the dimension that invented it is
    // never run, which is why the blocking list carries no silhouette code here rather than
    // being merely quiet.
    const report = evaluate(firstContext(fullBleed()));
    // The one blocking code is `flat-value`, and it is `value`'s: the fixture is a single flat
    // colour, which is the defect §4.2 names. `value` is the dimension that is *supposed* to have
    // an opinion about a full-bleed document, so this list is not empty any more and the honest
    // form of the claim is per dimension rather than per list.
    expect(codes(report.blocking)).toEqual(['flat-value']);
    expect(codes(report.blocking)).not.toContain('shape-clipped');
    // And the measurement really would have fired it, so this is not a vacuous assertion.
    const raw = silhouetteAnalyzer(firstContext(fullBleed()));
    expect(codes(raw.issues)).toContain('shape-clipped');
    expect(raw.issues.filter(isBlocking)).toHaveLength(1);
    expect(raw.scoreQ).toBe(800);
  });

  it('absorbs the 1px margin that T-012 measured as worth 200 per-mille', () => {
    // The trap this predicate exists to avoid. Identical ink, one pixel of frame:
    const bleeding = silhouetteAnalyzer(firstContext(fullBleed()));
    const margined = silhouetteAnalyzer(firstContext(insetBy(SUBJECT_REQUIRED_MARGIN)));
    // The knife-edge the raw measurement has, stated as a number so the reason for the
    // margin tolerance is visible rather than folklore.
    expect(bleeding.scoreQ).toBe(800);
    expect(margined.scoreQ).toBe(1000);
    expect(margined.scoreQ - bleeding.scoreQ).toBe(200);
    // The report does not have the knife-edge. Both are "cannot be measured", because both
    // are the same picture with the frame drawn either side of it.
    expect(evaluate(firstContext(fullBleed())).excluded.silhouette).toBe('no-subject');
    expect(evaluate(firstContext(insetBy(1))).excluded.silhouette).toBe('no-subject');
  });

  it('cannot be a per-mille threshold, and the arithmetic says so', () => {
    // The rejected alternative, kept as a test because a future maintainer will try it. A
    // ratio of the canvas reads better than a pixel, and it cannot work: the *same* margin
    // is a different fraction at every canvas size, so one number cannot both absorb a
    // 1px bleed guard and see a real 2px margin.
    //
    //   1px of frame on 16x16     -> 60/256       = 234/1000 transparent
    //   2px of frame on 1024x1024 -> 8176/1048576 =   7/1000 transparent
    //
    // A threshold above 234 absorbs the guard; anything below 7 sees the 2px margin at
    // 1024². There is no value that is both, and the gap does not close at any canvas size.
    const onePixelGuardAt16 = Math.floor(((16 * 16 - 14 * 14) * 1000) / (16 * 16));
    const twoPixelMarginAt1024 = Math.floor(((1024 * 1024 - 1020 * 1020) * 1000) / (1024 * 1024));
    expect(onePixelGuardAt16).toBe(234);
    expect(twoPixelMarginAt1024).toBe(7);
    expect(onePixelGuardAt16).toBeGreaterThan(twoPixelMarginAt1024);
    // The pixel predicate has no such problem: the same one pixel is the same one pixel at
    // 16² and at 1024², which is the entire argument for the unit.
    expect(SUBJECT_REQUIRED_MARGIN).toBe(1);
  });

  it('measures a subject as soon as there is more than a pixel of frame', () => {
    // Two pixels, the smallest margin that is a decision rather than a bleed guard.
    const report = evaluate(firstContext(insetBy(SUBJECT_REQUIRED_MARGIN + 1)));
    expect(report.dimensions.silhouette).toBeDefined();
    expect(report.excluded.silhouette).toBeUndefined();
    expect(reportInvariantViolations(report)).toEqual([]);
  });

  it('treats one pixel of frame on any one side as a bleed guard, not as a margin', () => {
    // The tolerance is one pixel on *each* side, not "some side". A single transparent row
    // is the bleed guard an exporter needs, and it is not a background a subject can read
    // against — so a shape that touches three edges with one pixel of frame at the fourth is
    // the same full-bleed picture with the guard drawn inside it.
    const guarded = spriteWhere(32, 32, (_x, y) => (y === 0 ? 0 : 255));
    expect(hasReadableSubject(firstContext(guarded))).toBe(false);
    expect(evaluate(firstContext(guarded)).excluded.silhouette).toBe('no-subject');

    // Two rows is a margin: somebody chose it, and the ink has an edge you can read.
    const margined = spriteWhere(32, 32, (_x, y) => (y < 2 ? 0 : 255));
    expect(hasReadableSubject(firstContext(margined))).toBe(true);
    expect(evaluate(firstContext(margined)).dimensions.silhouette).toBeDefined();
  });

  it('takes unanimity: one readable frame keeps the dimension applicable', () => {
    // Frame 1 full-bleed, frame 0 a subject. Exclusion must not be a majority vote, or a
    // sheet loses its one readable frame to a background plate.
    const mixed = blockWhere(
      32,
      32,
      (f) => (f === 0 ? { x: 2, y: 2, w: 28, h: 28 } : { x: 0, y: 0, w: 32, h: 32 }),
      2,
    );
    const report = evaluate(firstContext(mixed));
    expect(report.excluded.silhouette).toBeUndefined();
    expect(report.dimensions.silhouette).toBeDefined();
  });

  it('excludes when every frame is full-bleed, blank frames included', () => {
    // A blank frame is not full-bleed, so it cannot be the thing that convinces the
    // aggregator there is a subject — and a sequence that is one scene plus one hole is
    // still one scene.
    const sprite = spriteWhere(32, 32, (_x, _y, f) => (f === 0 ? 0 : 255), 2);
    expect(evaluate(firstContext(sprite)).excluded.silhouette).toBe('no-subject');
  });

  it('leaves an all-empty target to empty-frame, because a blank canvas is not a scene', () => {
    // §5.3's demonstration, which depends on every dimension *running*: a blank canvas
    // scores 1000 everywhere and fails on one blocking issue, rather than being excluded as
    // unmeasurable and reporting a total of nothing.
    const report = evaluate(firstContext(spriteWhere(16, 16, () => 0)));
    expect(report.excluded.silhouette).toBeUndefined();
    expect(report.dimensions.silhouette?.scoreQ).toBe(1000);
    expect(codes(report.blocking)).toEqual(['empty-frame']);
    expect(report.blocking[0].severity).toBe(1);
    expect(report.score).toBe(1);
    expect(report.verdict).toBe('fail');
    expect(reportInvariantViolations(report)).toEqual([]);
  });
});

describe('the precondition is the aggregator\'s to call, and it is one line to reuse', () => {
  it('is the same function for every shape dimension, so outline inherits it free', () => {
    // `requiresReadableSubject` is exported rather than inlined for exactly this reason:
    // T-016 must not write a second full-bleed test, and a second one would drift.
    expect(requiresReadableSubject(firstContext(fullBleed()))).toBe('no-subject');
    expect(requiresReadableSubject(firstContext(insetBy(2)))).toBeNull();
    expect(requiresReadableSubject(firstContext(spriteWhere(16, 16, () => 0)))).toBeNull();
  });

  it('is consulted before the analyzer runs, so a precondition can veto a score', () => {
    let runs = 0;
    const counting: QualityAnalyzer = () => {
      runs++;
      return { scoreQ: 1000, verdict: 'ran', issues: [BLOCKING_ISSUE], unmeasured: {} };
    };
    const report = evaluate(firstContext(fullBleed()), [
      reg('silhouette', counting, () => 'no-subject'),
    ]);
    expect(runs).toBe(0);
    expect(report.excluded.silhouette).toBe('no-subject');
    // The issue the analyzer would have emitted is not in the report, from either channel.
    expect(codes(report.blocking)).toEqual([]);
    expect(reportInvariantViolations(report)).toEqual([]);
  });
});

describe('motion applicability is the aggregator\'s, and stays the contract\'s two reasons', () => {
  it('single-frame for one frame, whatever the document has', () => {
    // A caller who scoped the evaluation to one frame of an animation gets the same honest
    // answer, which is what `frameIds.length` is for rather than `sprite.frames.length`.
    const animated = insetBy(2, 32, 32, 2);
    const context = firstContext(animated, { frames: [animated.frames[0].id] });
    expect(motionApplicability(context)).toBe('single-frame');
    const report = evaluate(context, [reg('motion', stub(1000), motionApplicability)]);
    expect(report.excluded.motion).toBe('single-frame');
    expect(report.dimensions.motion).toBeUndefined();
  });

  it('no-motion-content for identical frames, because an honest measurement would score 1000', () => {
    // The fake-perfect-score trap: churn 0, seam 0, `seamRatio` 0. The analyzer cannot see
    // that its input is degenerate, so the aggregator decides before it is called.
    const held = insetBy(2, 16, 16, 3);
    const context = firstContext(held);
    expect(compositesAreIdentical(context.composite)).toBe(true);
    expect(motionApplicability(context)).toBe('no-motion-content');
    const report = evaluate(context, [reg('motion', stub(1000), motionApplicability)]);
    expect(report.excluded.motion).toBe('no-motion-content');
    expect(report.score).toBe(0);
  });

  it('measures motion when any frame differs, however little', () => {
    const moving = blockWhere(
      16,
      16,
      (f) => (f === 0 ? { x: 2, y: 2, w: 12, h: 12 } : { x: 3, y: 2, w: 12, h: 12 }),
      2,
    );
    const context = firstContext(moving);
    expect(compositesAreIdentical(context.composite)).toBe(false);
    expect(motionApplicability(context)).toBeNull();
    expect(evaluate(context, [reg('motion', stub(1000), motionApplicability)]).dimensions.motion)
      .toBeDefined();
  });

  it('keeps frames-identical as a non-blocking advisory alongside the exclusion', () => {
    // Not redundant: `excluded` says "this cannot be measured", the advisory says "you
    // probably meant to animate this". One without the other loses something real.
    const held = insetBy(2, 16, 16, 4);
    const context = firstContext(held);
    const own = aggregatorIssues(context);
    const advisory = own.find((issue) => issue.code === 'frames-identical');
    expect(advisory).toBeDefined();
    expect(advisory?.severity).toBe(0.35);
    expect(isBlocking(advisory!)).toBe(false);

    const report = evaluate(context, [reg('motion', stub(1000), motionApplicability)]);
    // It is an advisory, so it is not in the blocking list the gate reads. §3.6's report
    // shape has no field for a non-blocking aggregator issue, which is why
    // `aggregatorIssues` is exported rather than swallowed.
    expect(codes(report.blocking)).toEqual([]);
    expect(report.excluded.motion).toBe('no-motion-content');
    expect(report.verdict).not.toBe('pass'); // total 0 over a 920-style active set is a fail
  });

  it('stays silent about frames-identical on a still sprite', () => {
    const own = aggregatorIssues(firstContext(insetBy(2)));
    expect(codes(own)).toEqual([]);
  });
});

describe('a dimension with no analyzer is reported as unmeasured, not as perfect', () => {
  it('accounts for every id exactly once while three of six do not exist', () => {
    // **Was "five of six", then "four of six"**, and each rename is the point rather than a chore:
    // `value` landed with an analyzer and a registration, and then `noise` did, so two of the six
    // ids that §4 specifies now have a measurement and four are still a promise. The invariant
    // underneath is unchanged and is the reason this test exists — no id is in neither map, which
    // is the silent hole a `Record` would have had no way to express.
    const report = evaluate(firstContext(insetBy(2)));
    expect(Object.keys(report.dimensions)).toEqual(['silhouette', 'value', 'noise']);
    expect(report.excluded).toEqual({
      palette: 'not-implemented',
      outline: 'not-implemented',
      motion: 'not-implemented',
    });
    expect(reportInvariantViolations(report)).toEqual([]);
  });

  it('fails closed when nothing at all could be measured', () => {
    // A full-bleed scene with the registry emptied, which is what the pipeline looked like before
    // `value` registered. 0 rather than 1000: the report must not tell an agent that a document
    // nobody could measure is perfect. The reason travels in `excluded`, so the reader sees
    // "0.00, nothing measured" and not "0.00, bad art".
    const report = evaluate(firstContext(fullBleed()), []);
    expect(Object.keys(report.dimensions)).toEqual([]);
    expect(Object.values(report.excluded).every((reason) => reason === 'not-implemented')).toBe(true);
    expect(report.score).toBe(0);
    expect(report.verdict).toBe('fail');
    expect(reportInvariantViolations(report)).toEqual([]);
    // And with the real registry the same document is measured, because `value` registers with no
    // precondition at all: a landscape is built out of value planes, so this dimension has a
    // great deal to say about exactly the documents `silhouette` refuses.
    const measured = evaluate(firstContext(fullBleed()));
    expect(measured.excluded.silhouette).toBe('no-subject');
    // The fixture is one flat colour over the whole canvas, and it is scored as one: `toneQ` at its
    // 150 floor, -200 for `flat-value` and -200 for `narrow-value-range`, clamped at 0. Before
    // T-099 the same document read 175, and the whole difference is the form term — a full-bleed
    // canvas has no outline, so §4.2's curvature gate had no local curvature to read and the term
    // was reporting 1000 for a measurement it never took, donating 500 of the dimension's weight
    // to it.
    expect(measured.dimensions.value?.scoreQ).toBe(0);
    // Which is the point stated as a fact rather than as a number. The reason is `no-subject` and
    // not a new member: the document has no outline, which is the same fact `silhouette` is
    // excluded for one line above, so an agent branches on one vocabulary. `value` is still
    // *present* — the tone half was measured, and §4.2 applies to scenes — and it says in the
    // sentence a human reads which half is missing.
    expect(measured.dimensions.value?.unmeasured).toEqual({ form: 'no-subject' });
    expect(measured.dimensions.value?.verdict).toMatch(/unmeasured/);
  });

  it('never lets an excluded dimension drag the total toward zero', () => {
    // The 0.81 mistake, one dimension at a time: a present dimension at 880 next to five
    // unmeasured ones must still report 880, not 880 * 920/1000.
    const report = evaluate(firstContext(insetBy(2)), [
      reg('silhouette', stub(880)),
    ]);
    expect(report.score).toBe(0.88);
  });
});

/* ------------------------------------------------------------------ *
 * The weighted total
 * ------------------------------------------------------------------ */

describe('the denominator is the active set — 920 for a still, not 1000', () => {
  it('reports 0.88 for a still sprite at 880 across five dimensions', () => {
    const context = firstContext(insetBy(2));
    const report = evaluate(context, allAt(880));
    expect(report.excluded.motion).toBe('single-frame');
    expect(report.score).toBe(0.88);
    expect(report.verdict).toBe('pass');
  });

  it('would report 0.81 on the naive denominator, and that is the mistake being tested', () => {
    // The discriminating half. The aggregator's own test above is only meaningful if the
    // wrong arithmetic is arithmetically valid — taking the denominator from the weight
    // table and counting an excluded dimension as a zero is a perfectly reasonable-looking
    // line of code that penalises a still sprite for a dimension it was never asked about.
    const active = QUALITY_DIMENSIONS.filter((id) => id !== 'motion');
    expect(active.reduce((sum, id) => sum + DEFAULT_QUALITY_WEIGHTS[id], 0)).toBe(920);
    let sum = 0;
    for (const id of QUALITY_DIMENSIONS) {
      sum += DEFAULT_QUALITY_WEIGHTS[id] * (active.includes(id) ? 880 : 0);
    }
    expect(unitScore(Math.floor((sum + 1000 / 2) / 1000))).toBe(0.81);
    expect(evaluate(firstContext(insetBy(2)), allAt(880)).score).not.toBe(0.81);
  });

  it('uses 1000 for an animation, because every dimension contributed', () => {
    const moving = blockWhere(
      16,
      16,
      (f) => (f === 0 ? { x: 2, y: 2, w: 12, h: 12 } : { x: 3, y: 2, w: 12, h: 12 }),
      2,
    );
    const report = evaluate(firstContext(moving), allAt(880));
    expect(report.excluded).toEqual({});
    expect(report.score).toBe(0.88);
  });

  it('never renormalises onto 1000: a high still is not 0.88, it is 0.88', () => {
    // Renormalising would make the total depend on the active set in a way that is hard to
    // diff. Pinned so a future "helpful" rescale is a test failure.
    const report = evaluate(firstContext(insetBy(2)), allAt(1000));
    expect(report.score).toBe(1);
    const partial = evaluate(firstContext(insetBy(2)), [reg('silhouette', stub(1000))]);
    expect(partial.score).toBe(1);
  });
});

describe('the verdict is decided on the integer, not on the float that carries it', () => {
  it('warns on a total exactly at SCORE_FAIL_THRESHOLD, which only the integer can do', () => {
    // `verdictFor` fails closed on a malformed score, so handing it the serialised 0.55
    // where 550 belongs fails the report instead of warning it. This report therefore only
    // reaches 'warn' if the aggregator passed the integer it computed — which is the pairing
    // the file header calls load-bearing.
    const atThreshold = evaluate(firstContext(insetBy(2)), [reg('silhouette', stub(SCORE_FAIL_THRESHOLD))]);
    expect(atThreshold.score).toBe(0.55);
    expect(atThreshold.verdict).toBe('warn');

    const oneBelow = evaluate(firstContext(insetBy(2)), [reg('silhouette', stub(SCORE_FAIL_THRESHOLD - 1))]);
    expect(oneBelow.verdict).toBe('fail');
  });

  it('passes on a total exactly at SCORE_PASS_THRESHOLD', () => {
    const atThreshold = evaluate(firstContext(insetBy(2)), [reg('silhouette', stub(SCORE_PASS_THRESHOLD))]);
    expect(atThreshold.score).toBe(0.8);
    expect(atThreshold.verdict).toBe('pass');
  });

  it('never lets an excluded dimension fail a floor it was never measured against', () => {
    // A still sprite with motion absent: the motion floor is 400, and if absence were
    // treated as a zero every still sprite would fail on it forever.
    const report = evaluate(firstContext(insetBy(2)), allAt(1000));
    expect(report.excluded.motion).toBe('single-frame');
    expect(report.verdict).toBe('pass');
  });
});

/* ------------------------------------------------------------------ *
 * The blocking list
 * ------------------------------------------------------------------ */

describe('the blocking list is assembled from present dimensions and the aggregator', () => {
  it('drops an excluded dimension\'s issues, because they were never produced', () => {
    const report = evaluate(firstContext(fullBleed()), [
      reg('silhouette', stubWith([BLOCKING_ISSUE]), requiresReadableSubject),
    ]);
    expect(report.excluded.silhouette).toBe('no-subject');
    expect(codes(report.blocking)).toEqual([]);
  });

  it('deduplicates by (code, rect), so one defect is one refusal', () => {
    const same = { code: 'low-contrast', message: 'a', rect: { x: 4, y: 4, w: 2, h: 2 }, severity: 0.6 };
    const elsewhere = { ...same, rect: { x: 20, y: 20, w: 2, h: 2 } };
    const report = evaluate(firstContext(insetBy(2)), [
      reg('silhouette', stubWith([same, same]), () => null),
      reg('value', stubWith([same]), () => null),
    ]);
    expect(codes(report.blocking)).toEqual(['low-contrast']);
    // Same code, different place: two distinct defects, so two entries.
    const spread = evaluate(firstContext(insetBy(2)), [
      reg('silhouette', stubWith([same, elsewhere]), () => null),
    ]);
    expect(codes(spread.blocking)).toEqual(['low-contrast', 'low-contrast']);
  });

  it('sorts by severity descending, then code ascending, then position', () => {
    const issue = (code: string, severity: number, x: number): QualityIssue => ({
      code,
      message: code,
      rect: { x, y: 0, w: 1, h: 1 },
      severity,
    });
    const report = evaluate(firstContext(insetBy(2)), [
      reg('silhouette', stubWith([issue('b-low', 0.3, 0), issue('a-high', 0.9, 1), issue('b-high', 0.9, 2)]), () => null),
    ]);
    // Advisories are filtered out entirely; the two 0.9s order by code, and the third key
    // only shows when the first two tie.
    expect(codes(report.blocking)).toEqual(['a-high', 'b-high']);
    const tied = evaluate(firstContext(insetBy(2)), [
      reg('silhouette', stubWith([issue('same', 0.7, 9), issue('same', 0.7, 2)]), () => null),
    ]);
    expect(tied.blocking.map((entry) => entry.rect?.x)).toEqual([2, 9]);
  });

  it('collects the aggregator\'s own blocking issue alongside a dimension\'s', () => {
    const context = firstContext(spriteWhere(16, 16, (_x, _y, f) => (f === 0 ? 0 : 255), 2));
    const report = evaluate(context, [reg('silhouette', stub(1000), requiresReadableSubject)]);
    expect(codes(report.blocking)).toEqual(['empty-frame']);
    expect(report.verdict).toBe('fail');
  });
});

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

describe('the registry is partial on purpose and works that way', () => {
  it('registers silhouette, value and noise today, and DEFAULT_ANALYZERS is a projection of it', () => {
    // **Was "registers silhouette today"**, and the renames are the finding rather than a chore:
    // `value` registered with **no `applies` at all**, which is the decision the whole aggregator
    // exists to make expressible — a full-bleed scene has no silhouette and does have value
    // structure — and `noise` then registered the same way, for the same reason and one step
    // further: a full-bleed landscape is precisely the document where a stray highlight or a leaked
    // pixel is most likely, because it is the one with thousands of individual marks in it. **Two of
    // the three measured dimensions therefore abstain on nothing**, and that is the mechanism behind
    // T-015's finding five in the other direction: a dimension that abstains is offset by a
    // dimension that abstains nowhere. The assertion below is that the projection is a projection
    // and not a second list.
    expect(DEFAULT_DIMENSIONS.map((dimension) => dimension.id)).toEqual(['silhouette', 'value', 'noise']);
    expect(DEFAULT_ANALYZERS).toEqual([silhouetteAnalyzer, valueAnalyzer, noiseAnalyzer]);
    expect(analyzerFor('silhouette')).toBe(silhouetteAnalyzer);
    expect(analyzerFor('value')).toBe(valueAnalyzer);
    expect(analyzerFor('noise')).toBe(noiseAnalyzer);
    // Three dimensions have no analyzer, which is a fact about the build rather than about
    // any document, and is reported as such.
    for (const id of ['palette', 'outline', 'motion'] as const) {
      expect(analyzerFor(id)).toBeUndefined();
    }
  });

  it('rejects two registrations for one dimension rather than averaging them silently', () => {
    expect(() => evaluate(firstContext(insetBy(2)), [reg('value', stub(800)), reg('value', stub(200))]))
      .toThrow(/Duplicate quality dimension: value/);
  });

  it('refuses a context with no frames, which is a caller bug and not a subjectless sprite', () => {
    // The distinction matters: this is the one input where "nothing to measure" would be a
    // silently smaller measurement rather than an honest one.
    const sprite = insetBy(2, 16, 16, 2);
    const context = firstContext(sprite, { frames: [] });
    expect(() => evaluate(context)).toThrow(/no frames/);
  });
});

describe('a report is validated before it leaves the aggregator', () => {
  it('throws on a malformed analyzer result, because at this step it is a bug in the pipeline', () => {
    // The 0..1 unit mistake, from the analyzer side. `assertReportInvariants` is the only
    // thing standing between a bad score and a report that is arithmetically sound and
    // semantically broken, so removing the call is a real regression rather than a tidy-up.
    const unitMistake: QualityAnalyzer = () => ({ scoreQ: 0.94, verdict: 'oops', issues: [], unmeasured: {} });
    expect(() => evaluate(firstContext(insetBy(2)), [reg('silhouette', unitMistake)])).toThrow(
      /Malformed quality report/,
    );
    expect(() => evaluate(firstContext(insetBy(2)), [reg('silhouette', unitMistake)])).toThrow(
      /scoreQ 0\.94 is not an integer in 0..1000/,
    );
  });

  it('does not throw on a floor breach it reported as a fail — the assert is not over-eager', () => {
    // The other half of the guard. A dimension under its floor is bad *artwork*, the verdict
    // is `fail` because of it, and the report is well formed, so it must come back rather
    // than throw. An assert that also rejected honest reports would train a caller to catch
    // the error and carry on, which is the state where a real bug stops being loud.
    const report = evaluate(firstContext(insetBy(2)), [reg('silhouette', stub(FLOOR_FAIL.silhouette - 1))]);
    expect(report.dimensions.silhouette?.scoreQ).toBe(FLOOR_FAIL.silhouette - 1);
    expect(report.verdict).toBe('fail');
    expect(reportInvariantViolations(report)).toEqual([]);
    // The aggregator's throw and the standalone check agree, which is what makes the one in
    // `evaluate` trustworthy: it is the same predicate, not a second opinion.
    expect(() => assertReportInvariants(report)).not.toThrow();
  });

  it('produces a byte-identical report for the same context', () => {
    const context = firstContext(insetBy(2, 24, 24, 2));
    const a = evaluate(context, allAt(880));
    const b = evaluate(context, allAt(880));
    expect(b).toEqual(a);
    // Key order is the contract's, not a hash table's, so a committed report diffs cleanly.
    expect(Object.keys(a.excluded)).toEqual(['motion']);
  });
});

/* ------------------------------------------------------------------ *
 * The corpus this task was written for
 * ------------------------------------------------------------------ */

const ARTWORK_DIR = fileURLToPath(new URL('../../../artwork', import.meta.url));
const ICON_PNG = fileURLToPath(new URL('../../../packages/app/build/icon.png', import.meta.url));

interface CorpusAsset {
  readonly name: string;
  readonly sprite: Sprite;
  readonly context: QualityContext;
  /** Independent of the aggregator: the solid share of the canvas, in per-mille. */
  readonly inkQ: number;
  readonly fullBleed: boolean;
}

function inkPerMille(context: QualityContext): number {
  let worst = 1000;
  for (const cel of context.composite) {
    let solid = 0;
    for (let p = 3; p < cel.data.length; p += 4) {
      if (cel.data[p] >= 128) solid++;
    }
    // The weakest frame decides: a sheet with one scene frame and one half-drawn frame is
    // a sheet with a subject, and the aggregator's unanimity rule agrees.
    const perMille = Math.floor((solid * 1000) / context.width / context.height);
    if (perMille < worst) worst = perMille;
  }
  return worst;
}

function loadCorpus(): CorpusAsset[] {
  const files: { name: string; sprite: Sprite }[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, `${prefix}${entry.name}/`);
      else if (entry.name.endsWith('.pixel')) {
        files.push({ name: `${prefix}${entry.name}`, sprite: deserializeSprite(new Uint8Array(readFileSync(path))) });
      }
    }
  };
  if (!existsSync(ARTWORK_DIR)) {
    throw new Error(
      `Cannot read the artwork corpus at ${ARTWORK_DIR}. This guard measures the pipeline ` +
        'against the repository\'s own committed assets, which is the only corpus that ' +
        'contains real full-bleed scenes; a missing one is a broken checkout, not a reason ' +
        'to pass quietly.',
    );
  }
  walk(ARTWORK_DIR, '');
  if (existsSync(ICON_PNG)) {
    const decoded = decodePNG(new Uint8Array(readFileSync(ICON_PNG)));
    const sprite = createSprite({ width: decoded.width, height: decoded.height, layers: ['base'], name: 'icon' });
    sprite.frames[0].cels.set(sprite.layers[0].id, new PixelBuffer(decoded.width, decoded.height, decoded.data));
    files.push({ name: 'packages/app/build/icon.png', sprite });
  }
  return files.map(({ name, sprite }) => {
    const context = createQualityContext(sprite);
    const inkQ = inkPerMille(context);
    return { name, sprite, context, inkQ, fullBleed: inkQ >= 990 };
  });
}

const CORPUS = loadCorpus();

describe('the repository\'s own artwork, measured through evaluate', () => {
  it('has both kinds of asset, so the assertions below are not vacuous', () => {
    const scenes = CORPUS.filter((asset) => asset.fullBleed);
    const subjects = CORPUS.filter((asset) => !asset.fullBleed);
    expect(CORPUS.length).toBeGreaterThanOrEqual(10);
    expect(scenes.length).toBeGreaterThanOrEqual(5);
    expect(subjects.length).toBeGreaterThanOrEqual(2);
  });

  it('separates a full-bleed scene from a subject on the margin, not on a threshold', () => {
    // The separation the report now rests on, measured independently of the predicate: the
    // weakest scene in the corpus covers 996/1000 of its canvas and the strongest subject
    // covers 938/1000, so a scene and a subject are not close together and no threshold
    // has to be fitted between them. A 1px margin costs 121/1000 of a 32² canvas and
    // 4/1000 of a 1024² one, which is why the predicate is in pixels: what a margin costs
    // as a fraction is a property of the canvas, not of the margin.
    const scenes = CORPUS.filter((asset) => asset.fullBleed);
    const subjects = CORPUS.filter((asset) => !asset.fullBleed);
    const tightestScene = Math.max(...scenes.map((asset) => asset.inkQ));
    const fullestSubject = Math.min(...subjects.map((asset) => asset.inkQ));
    expect(fullestSubject).toBeLessThan(tightestScene);
  });

  it('excludes every full-bleed scene, and reports no defect about it', () => {
    const offenders: string[] = [];
    for (const asset of CORPUS.filter((a) => a.fullBleed)) {
      const report = evaluate(asset.context);
      if (report.excluded.silhouette !== 'no-subject') {
        offenders.push(`${asset.name}: excluded ${String(report.excluded.silhouette)}`);
        continue;
      }
      if (report.dimensions.silhouette !== undefined) {
        offenders.push(`${asset.name}: measured a silhouette anyway`);
        continue;
      }
      // The specific failure this task exists to stop: a blocking `shape-clipped` on a
      // scene that is supposed to run to the edge.
      if (codes(report.blocking).includes('shape-clipped')) {
        offenders.push(`${asset.name}: blocking shape-clipped on a full-bleed scene`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('measures every asset that has a subject, and keeps the advisories visible', () => {
    const offenders: string[] = [];
    for (const asset of CORPUS.filter((a) => !a.fullBleed)) {
      const report = evaluate(asset.context);
      if (report.dimensions.silhouette === undefined) {
        offenders.push(`${asset.name}: excluded ${String(report.excluded.silhouette)}`);
        continue;
      }
      if (reportInvariantViolations(report).length > 0) {
        offenders.push(`${asset.name}: ${reportInvariantViolations(report).join('; ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('still reports the one real character sprite as having a thin profile', () => {
    // Deliberately not fixed here. T-012 measured this sprite at `compactnessQ` 269 against
    // a gate of 300, and the gate is wrong by about 10% on the only real character in the
    // repository — but lowering it to fit one sample is how you fit noise. T-021 recalibrates
    // the gates against a fixed corpus; until then the honest thing is to report the
    // measurement and name the sample size.
    const keeper = CORPUS.find((asset) => asset.name.endsWith('lantern-keeper.pixel'));
    expect(keeper).toBeDefined();
    const report = evaluate(keeper!.context);
    const silhouette = report.dimensions.silhouette;
    expect(silhouette).toBeDefined();
    expect(codes(silhouette!.issues)).toContain('thin-profile');
    // An advisory, not a gate: the sprite is a subject, it reads, and the report says so
    // without pretending the measurement is settled.
    expect(report.blocking).toEqual([]);
    // **The total is 849 over the active set, and it was 823 before `noise` registered — which is the
    // finding, not a repair.** The arithmetic is written out because "the score moved and nothing
    // about the art did" is exactly the kind of diff a reviewer should not have to reconstruct, and
    // because the direction of the move is the whole point:
    //
    //   before: (300*800 + 260*850) / 560                      = 461000 / 560 = 823.2  -> 823
    //   after:  (300*800 + 260*850 + 120*970) / 680             = 577400 / 680 = 849.1  -> 849
    //
    // `noise` registers at weight 120, it registers with **no applicability precondition** (§4.4 lists
    // none, and a still sprite is not a reason to skip a speck detector), and it reads **970** on
    // this sprite — higher than either dimension it joins. 970 is not a free pass and is not derived
    // from the implementation's own output: `colourOrphans` is 2 against `N` 432, which is
    // `rhu(2000, 432) = 5` per-mille, and §4.4's `<= 8/1000` row is the 900 band, so the dimension is
    // rhu(300*1000 + 200*1000 + 300*900 + 200*1000, 1000) = 970. Two stray colours, nothing above
    // the trigger, no code — and `ditherShare` 574, the highest of the ten committed scenes.
    //
    // **The dilution runs upward, and this is not the art improving.** `thin-profile` is severity
    // 0.30, the blocking cut is 0.50, and `report.blocking` is empty three lines above — so the
    // verdict is `pass` either way and the advisory has no veto; all the move did was lift the mean
    // past it. Had `noise` read 800 rather than 970, the same three dimensions would total
    // (300*800 + 260*850 + 120*800) / 680 = 557000 / 680 = 819, so registering `noise` moved the
    // report **30 per-mille away from the one defect this sprite actually has**. A weight-120
    // dimension with nothing to say about a character's profile can outvote the weight-300 dimension
    // that does, because the mean is a mean: this is T-015's finding five with the sign flipped —
    // there an abstention was offset by an unrelated clean reading, and here a clean reading offsets
    // a real advisory. §5.3's floors are the mechanism that was built for this (`FLOOR_FAIL.silhouette`
    // is 400 and `silhouette` is at 800, so it does not catch it either) and the total cannot.
    //
    // **What T-099 fixed on this sprite is still fixed.** It was 850 before that task and 823 after
    // it, and neither number is the one T-099 was about: its first attempt at the fix treated every
    // gated plane as unmeasured, and this sprite dropped 850 to 800 — its five tone boundaries are 4
    // to 7 pixels on a 32-pixel body, all of them gated by `reachQ` as fragments rather than
    // cross-sections, so half the dimension was thrown away and the report fell. That was the
    // distortion, not the fix: this sprite has an outline, the gate read it, and "these are
    // fragments, not a cross-section, so there is nothing here to fail" is an answer. The subject is
    // not full-bleed, so the form term is measured and `unmeasured` is empty — which is the half of
    // T-099 that is about the ten full-bleed scenes and explicitly not about this one, and which
    // `noise`'s arrival does not disturb.
    expect(report.dimensions.silhouette?.scoreQ).toBe(800);
    expect(report.dimensions.value?.scoreQ).toBe(850);
    expect(report.dimensions.value?.unmeasured).toEqual({});
    expect(report.dimensions.noise?.scoreQ).toBe(970);
    expect(report.dimensions.noise?.unmeasured).toEqual({});
    expect(report.score).toBe(0.849);
    expect(report.verdict).toBe('pass');
  });
});
