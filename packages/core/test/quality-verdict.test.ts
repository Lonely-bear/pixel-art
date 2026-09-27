import { describe, expect, it } from 'vitest';
import {
  assertReportInvariants,
  DEFAULT_QUALITY_WEIGHTS,
  type ExcludedReason,
  FLOOR_FAIL,
  FLOOR_WARN,
  isBelow,
  isBlocking,
  type QualityDimension,
  type QualityDimensionId,
  type QualityIssue,
  type QualityReport,
  reportInvariantViolations,
  reportInvariantsHold,
  SCORE_FAIL_THRESHOLD,
  SCORE_PASS_THRESHOLD,
  SEVERITY_BLOCKING,
  STATIC_QUALITY_WEIGHTS,
  type VerdictInput,
  unitScore,
  verdictFor,
} from '../src/quality/types.js';

/**
 * The verdict rule and the report invariants.
 *
 * These were verified once in a throwaway file and then deleted, which left the contract's
 * only gate untested. That is the arrangement that produced the inert `declare const` guard
 * earlier: a check nobody runs is a check that does not exist. The cases here are the spec's
 * own motivating examples, chosen so that each one fails loudly if the rule is edited — the
 * point of a boundary test is that it is one edit away from breaking.
 *
 * Units, since this is where they bite: a dimension score is `scoreQ`, a per-mille integer
 * 0..1000. A report total is `score`, a 0..1 float. Both names are asserted here so that a
 * future edit cannot quietly swap them.
 */

const IDS: readonly QualityDimensionId[] = [
  'silhouette',
  'value',
  'palette',
  'noise',
  'outline',
  'motion',
];

function dim(scoreQ: number, issues: readonly QualityIssue[] = []): QualityDimension {
  return { scoreQ, verdict: `scored ${scoreQ}`, issues, unmeasured: {} };
}

/** Build a `dimensions` record from per-dimension per-mille scores. */
function dims(scores: Partial<Record<QualityDimensionId, number>>): QualityReport['dimensions'] {
  const out: Record<string, QualityDimension> = {};
  for (const [id, scoreQ] of Object.entries(scores)) {
    out[id] = dim(scoreQ as number);
  }
  return out as QualityReport['dimensions'];
}

/** Every dimension at 1000 unless overridden. */
function allPerfect(over: Partial<Record<QualityDimensionId, number>> = {}): QualityReport['dimensions'] {
  return dims(Object.fromEntries(IDS.map((id) => [id, over[id] ?? 1000])));
}

const BLOCKING: QualityIssue = {
  code: 'empty-frame',
  message: 'nothing opaque to measure',
  rect: null,
  severity: 1,
};
const ADVISORY: QualityIssue = {
  code: 'pop-seam',
  message: 'a seam worth looking at',
  rect: null,
  severity: 0.35,
};

function verdictOf(input: VerdictInput): QualityReport['verdict'] {
  return verdictFor(input);
}

describe('verdictFor — the spec 5.3 rule', () => {
  it('fails the headline case: silhouette 0.30 with five perfect dimensions', () => {
    // Spec §5.3: "A total of 0.86 with silhouette: 0.30 is a fail, not a warn." A mean-only
    // rule calls that a pass, which is the whole reason FLOOR_FAIL exists.
    expect(
      verdictOf({
        totalQ: 860,
        dimensions: allPerfect({ silhouette: 300 }),
        blocking: [],
      }),
    ).toBe('fail');
  });

  it('does not let a broken dimension hide behind a high total', () => {
    // Same sprite, every dimension perfect except one style dimension at 299.
    expect(verdictOf({ totalQ: 950, dimensions: allPerfect({ outline: 299 }), blocking: [] })).toBe(
      'fail',
    );
  });

  it('passes an all-good report', () => {
    expect(verdictOf({ totalQ: 900, dimensions: allPerfect(), blocking: [] })).toBe('pass');
    expect(verdictOf({ totalQ: 1000, dimensions: allPerfect(), blocking: [] })).toBe('pass');
  });

  it('treats a score exactly AT its floor as not breaching it, but still at most warn', () => {
    // The boundary case, and the one most likely to be edited by accident. The spec's rule
    // is a strict `<`: 400 is not *below* FLOOR_FAIL 400. It is below FLOOR_WARN 600, so
    // the report warns. Flip the comparison to `<=` and this becomes a fail.
    const atFloor = allPerfect({ silhouette: FLOOR_FAIL.silhouette });
    expect(verdictOf({ totalQ: 900, dimensions: atFloor, blocking: [] })).toBe('warn');
    // One per-mille lower and it does breach.
    expect(verdictOf({ totalQ: 900, dimensions: allPerfect({ silhouette: 399 }), blocking: [] })).toBe(
      'fail',
    );
  });

  it('honours the lower floor for the two style dimensions', () => {
    expect(FLOOR_FAIL.noise).toBe(300);
    expect(FLOOR_FAIL.outline).toBe(300);
    expect(FLOOR_FAIL.silhouette).toBe(400);
    // 300 clears outline's fail floor; 299 does not.
    expect(verdictOf({ totalQ: 900, dimensions: allPerfect({ outline: 300 }), blocking: [] })).toBe(
      'warn',
    );
    expect(verdictOf({ totalQ: 900, dimensions: allPerfect({ outline: 299 }), blocking: [] })).toBe(
      'fail',
    );
  });

  it('applies both total thresholds at their exact boundaries', () => {
    const perfect = allPerfect();
    // Below SCORE_FAIL_THRESHOLD is a fail.
    expect(verdictOf({ totalQ: SCORE_FAIL_THRESHOLD - 1, dimensions: perfect, blocking: [] })).toBe(
      'fail',
    );
    // Exactly at it is not a fail, but is below SCORE_PASS_THRESHOLD, so it warns.
    expect(verdictOf({ totalQ: SCORE_FAIL_THRESHOLD, dimensions: perfect, blocking: [] })).toBe(
      'warn',
    );
    expect(verdictOf({ totalQ: 700, dimensions: perfect, blocking: [] })).toBe('warn');
    // Exactly at SCORE_PASS_THRESHOLD passes.
    expect(verdictOf({ totalQ: SCORE_PASS_THRESHOLD, dimensions: perfect, blocking: [] })).toBe(
      'pass',
    );
    expect(verdictOf({ totalQ: SCORE_PASS_THRESHOLD - 1, dimensions: perfect, blocking: [] })).toBe(
      'warn',
    );
  });

  it('warns on a dimension below FLOOR_WARN even when the total is high', () => {
    expect(FLOOR_WARN).toBe(600);
    expect(verdictOf({ totalQ: 950, dimensions: allPerfect({ value: 599 }), blocking: [] })).toBe(
      'warn',
    );
  });

  it('short-circuits on a blocking issue, whatever the total says', () => {
    expect(verdictOf({ totalQ: 1000, dimensions: allPerfect(), blocking: [BLOCKING] })).toBe('fail');
    // The spec's empty-frame case: nothing to fault, every dimension perfect, still a fail.
    expect(verdictOf({ totalQ: 1000, dimensions: allPerfect(), blocking: [BLOCKING, ADVISORY] })).toBe(
      'fail',
    );
  });

  it('ignores an issue below the blocking severity', () => {
    expect(SEVERITY_BLOCKING).toBe(0.5);
    expect(isBlocking(ADVISORY)).toBe(false);
    expect(isBlocking(BLOCKING)).toBe(true);
    expect(isBlocking({ ...ADVISORY, severity: 0.5 })).toBe(true); // inclusive
    expect(isBlocking({ ...ADVISORY, severity: 0.49 })).toBe(false);
    // An unfiltered list handed to verdictFor must not fail the report on a 0.35 advisory.
    expect(verdictOf({ totalQ: 1000, dimensions: allPerfect(), blocking: [ADVISORY] })).toBe('pass');
  });

  it('never lets an excluded dimension fail a floor it was never measured against', () => {
    // A still sprite: `motion` has no key at all. If absence were treated as a zero, every
    // still sprite would fail its own motion floor and nothing would ever pass.
    const still = allPerfect({ motion: undefined as unknown as number });
    const withoutMotion = Object.fromEntries(
      IDS.filter((id) => id !== 'motion').map((id) => [id, 880]),
    );
    expect(
      verdictOf({ totalQ: 880, dimensions: dims(withoutMotion), blocking: [] }),
    ).toBe('pass');
    expect(Object.keys(still)).toContain('motion'); // sanity: the helper above did fill it
  });

  it('fails closed on a malformed or non-finite score', () => {
    expect(verdictOf({ totalQ: Number.NaN, dimensions: allPerfect(), blocking: [] })).toBe('fail');
    expect(verdictOf({ totalQ: Number.POSITIVE_INFINITY, dimensions: allPerfect(), blocking: [] })).toBe(
      'fail',
    );
    expect(
      verdictOf({ totalQ: 900, dimensions: allPerfect({ value: Number.NaN }), blocking: [] }),
    ).toBe('fail');
    // isBelow treats a non-finite floor as breached too, so a corrupted constant fails closed.
    expect(isBelow(Number.NaN, 400)).toBe(true);
    expect(isBelow(1000, Number.NaN)).toBe(true);
  });

  it('catches a unit mistake: a 0..1 score where scoreQ belongs', () => {
    // The failure mode the rename exists to prevent. A 0.88 handed in as a per-mille score
    // reads as catastrophic, not as a near-perfect result, so it can never pass by accident.
    expect(verdictOf({ totalQ: 900, dimensions: allPerfect({ silhouette: 0.88 }), blocking: [] })).toBe(
      'fail',
    );
  });

  it('compares with an exact integer test and serialises through unitScore', () => {
    expect(isBelow(399, 400)).toBe(true);
    expect(isBelow(400, 400)).toBe(false);
    expect(isBelow(401, 400)).toBe(false);
    expect(unitScore(940)).toBe(0.94);
    expect(unitScore(0)).toBe(0);
    expect(unitScore(1000)).toBe(1);
    expect(Object.is(unitScore(-0), 0)).toBe(true);
  });
});

describe('the still-sprite denominator is 920, not 1000', () => {
  /**
   * The aggregation arithmetic from spec §5.2. It lives in the aggregator (T-018); it is
   * reproduced here because the denominator is a promise the spec makes about the number a
   * user sees — "a 32×32 character that scores 0.88 across the five applicable dimensions
   * reports 0.88, not 0.81" — and that promise is only checkable by doing the arithmetic.
   */
  function aggregate(
    active: Partial<Record<QualityDimensionId, number>>,
    weights: Record<QualityDimensionId, number>,
  ): number {
    let sum = 0;
    let denominator = 0;
    for (const id of IDS) {
      const scoreQ = active[id];
      if (scoreQ === undefined) continue;
      sum += weights[id] * scoreQ;
      denominator += weights[id];
    }
    return Math.floor((sum + denominator / 2) / denominator);
  }

  it('reports 0.88 for a still sprite at 880 across five dimensions', () => {
    const five: Partial<Record<QualityDimensionId, number>> = Object.fromEntries(
      IDS.filter((id) => id !== 'motion').map((id) => [id, 880]),
    );
    const stillTotal = aggregate(five, STATIC_QUALITY_WEIGHTS);
    expect(STATIC_QUALITY_WEIGHTS.motion).toBe(0);
    expect(stillTotal).toBe(880);
    expect(unitScore(stillTotal)).toBe(0.88);
  });

  it('would report 0.81 if the full weight table were the denominator', () => {
    // The mistake the 920 denominator exists to prevent: taking the denominator from the
    // weight table rather than from the dimensions actually measured, so a dropped
    // dimension contributes its weight and a zero score, dragging the total down for
    // something nobody looked at. The spec's own numbers: 0.88, not 0.81.
    const active = Object.fromEntries(IDS.filter((id) => id !== 'motion').map((id) => [id, 880]));
    let sum = 0;
    for (const id of IDS) sum += DEFAULT_QUALITY_WEIGHTS[id] * (active[id] ?? 0);
    const naive = Math.floor((sum + 1000 / 2) / 1000);
    expect(unitScore(naive)).toBe(0.81);
    expect(unitScore(naive)).not.toBe(0.88);
  });
});

function report(over: Partial<QualityReport> = {}): QualityReport {
  return {
    dimensions: allPerfect(),
    excluded: {},
    score: 0.94,
    verdict: 'pass',
    blocking: [],
    ...over,
  };
}

const STILL: ExcludedReason = 'single-frame';

describe('report invariants', () => {
  it('accepts a report where every dimension is measured and nothing is excluded', () => {
    expect(reportInvariantViolations(report())).toEqual([]);
    expect(reportInvariantsHold(report())).toBe(true);
    expect(() => assertReportInvariants(report())).not.toThrow();
  });

  it('accepts a still sprite that excludes motion with a reason', () => {
    const still = report({
      dimensions: dims(
        Object.fromEntries(IDS.filter((id) => id !== 'motion').map((id) => [id, 880])),
      ),
      excluded: { motion: STILL },
      score: 0.88,
    });
    expect(reportInvariantViolations(still)).toEqual([]);
    expect(reportInvariantsHold(still)).toBe(true);
  });

  it('rejects a dimension present in both dimensions and excluded', () => {
    const both = report({ excluded: { motion: STILL } });
    expect(reportInvariantViolations(both).join(' ')).toContain(
      'motion: present in both dimensions and excluded',
    );
    expect(reportInvariantsHold(both)).toBe(false);
  });

  it('rejects a dimension that is neither measured nor excluded', () => {
    // The silent hole: a key dropped from `dimensions` with no reason recorded. A reader
    // cannot tell "scored zero" from "never ran", which is what `excluded` is for.
    const hole = report({
      dimensions: dims(Object.fromEntries(IDS.filter((id) => id !== 'motion').map((id) => [id, 880]))),
      excluded: {},
    });
    expect(reportInvariantViolations(hole).join(' ')).toContain(
      'motion: neither measured nor excluded',
    );
    expect(reportInvariantsHold(hole)).toBe(false);
  });

  it('rejects a pass that carries a blocking issue', () => {
    const bad = report({ blocking: [BLOCKING] });
    expect(reportInvariantViolations(bad).join(' ')).toContain('pass with 1 blocking issue(s)');
    // A pass carrying only an advisory is fine.
    expect(reportInvariantViolations(report({ blocking: [ADVISORY] }))).toEqual([]);
  });

  it('rejects a floor breach that is not reported as a fail', () => {
    const floored = report({ dimensions: allPerfect({ silhouette: 200 }), verdict: 'warn' });
    expect(reportInvariantViolations(floored).join(' ')).toContain('is below FLOOR_FAIL');
    // A genuine fail with the same scores is well-formed.
    expect(reportInvariantsHold(report({ dimensions: allPerfect({ silhouette: 200 }), verdict: 'fail' }))).toBe(
      true,
    );
  });

  it('rejects a malformed scoreQ, including a 0..1 unit mistake', () => {
    expect(
      reportInvariantViolations(report({ dimensions: allPerfect({ silhouette: 0.94 }) })).join(' '),
    ).toContain('scoreQ 0.94 is not an integer in 0..1000');
    expect(
      reportInvariantViolations(report({ dimensions: allPerfect({ value: 1001 }) })).join(' '),
    ).toContain('not an integer in 0..1000');
    expect(
      reportInvariantViolations(report({ dimensions: allPerfect({ noise: Number.NaN }) })).join(' '),
    ).toContain('not an integer in 0..1000');
  });

  it('rejects a report total outside 0..1', () => {
    expect(reportInvariantViolations(report({ score: 1.4 })).join(' ')).toContain('not in 0..1');
    expect(reportInvariantViolations(report({ score: -0.1 })).join(' ')).toContain('not in 0..1');
  });

  it('rejects an issue severity outside 0..1', () => {
    const bad = report({
      dimensions: {
        ...allPerfect(),
        outline: dim(1000, [{ ...ADVISORY, severity: 1.5 }]),
      },
    });
    expect(reportInvariantViolations(bad).join(' ')).toContain('severity 1.5 is not in 0..1');
  });

  it('throws legibly, and lists every problem at once', () => {
    const broken = report({
      excluded: { motion: STILL },
      dimensions: allPerfect({ silhouette: 200 }),
      verdict: 'pass',
      blocking: [BLOCKING],
    });
    let message = '';
    try {
      assertReportInvariants(broken);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('Malformed quality report');
    expect(message).toContain('motion: present in both dimensions and excluded');
    expect(message).toContain('silhouette: scoreQ 200 is below FLOOR_FAIL 400 but verdict is pass');
    expect(message).toContain('pass with 1 blocking issue(s)');
  });
});
