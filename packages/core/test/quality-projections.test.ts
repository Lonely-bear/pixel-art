import { describe, expect, it } from 'vitest';
import { buildCase, readCorpusSpec } from '../../../benchmarks/corpus/build.js';
import { createQualityContext } from '../src/quality/context.js';
import {
  aggregatorIssues,
  evaluate as aggregateQualityReport,
  projectAbsences,
  projectIssues,
  QUALITY_DIMENSIONS,
} from '../src/quality/index.js';
import { assertReportInvariants, SEVERITY_BLOCKING, type QualityReport } from '../src/quality/types.js';
import type { Rect } from '../src/types.js';

/**
 * `quality/projections.ts` - the one walk a report is projected through.
 *
 * This file existed because two surfaces each wrote the same four steps: `indexIssues` in
 * `packages/mcp/src/quality-report.ts` and `judge` in `packages/core/src/commands/share.ts`.
 * They agreed, and nothing held them there. So the walk is core's, once.
 *
 * The claims are written on their **discriminating side**, because a projection test that only
 * walks a clean case proves nothing:
 *
 *   1. **Blocking defects lead.** Severity descending, so a consumer that truncates the list cannot
 *      drop one - asserted against a case that has both a blocking and an advisory issue.
 *   2. **Two dimensions naming one defect is one entry**, carrying both attributions. A
 *      deduplication that kept only the first would lose the fact that two measurements agreed.
 *   3. **The aggregator's own issues are in the list**, unattributed, and `frames-identical` only
 *      exists there - so a projection that skipped them would silently lose a code.
 *   4. **An abstention is not a measurement, and not a clean one.** {@link projectAbsences} returns
 *      a whole-dimension absence and a sub-score absence as *different entries*, and never reports
 *      an absence for a dimension that measured. This is the assertion `AGENTS.md` is most explicit
 *      about, and the one whose failure mode is invisible: a report that silently dropped
 *      `motion`'s `single-frame` would look exactly like a report on an animation.
 *   5. **Nothing here computes a score.** The projection exposes no total, no grade and no
 *      per-dimension mark, and `severity` is a field a surface must choose to copy rather than one
 *      it gets for free - asserted by the walk's own return type.
 */

const SPEC = readCorpusSpec();

function corpus(id: string) {
  const entry = SPEC.cases.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`the corpus has no case "${id}"`);
  const sprite = buildCase(entry);
  if (sprite === null) throw new Error(`the corpus case "${id}" is not buildable`);
  return sprite;
}

function project(id: string): { report: QualityReport; entries: ReturnType<typeof projectIssues> } {
  const context = createQualityContext(corpus(id));
  const report = aggregateQualityReport(context);
  return { report, entries: projectIssues(report, aggregatorIssues(context)) };
}

/** The aggregator's own `(code, rect)` key, spelled independently of core's `rectKey`. */
function keyOf(code: string, rect: Rect | null): string {
  return `${code}|${rect === null ? 'global' : `${rect.x},${rect.y},${rect.w},${rect.h}`}`;
}

describe('one projection, both surfaces', () => {
  it('puts every blocking defect ahead of every advisory, so a cap cannot drop one', () => {
    // The near-miss on the other side of the same gate: an entry list with no blocking issue at
    // all would pass a "first entry is blocking" assertion, so both halves are required.
    const { entries } = project('defect/shape-clipped-32');
    expect(entries.length).toBeGreaterThan(1);
    const firstAdvisory = entries.findIndex((entry) => entry.severity < SEVERITY_BLOCKING);
    expect(entries.some((entry) => entry.blocking), 'the fixture must have a blocking defect').toBe(true);
    if (firstAdvisory !== -1) {
      expect(
        entries.slice(firstAdvisory).some((entry) => entry.blocking),
        'no blocking issue may sit behind an advisory',
      ).toBe(false);
    }
    // And `blocking` agrees with the threshold rather than being a separate opinion.
    for (const entry of entries) expect(entry.blocking).toBe(entry.severity >= SEVERITY_BLOCKING);
  });

  it('collapses two dimensions naming one defect into one entry that keeps both names', () => {
    // Not asserted as "at least one exists" without a reason: the expected entry count is computed
    // from the report itself, so this fails on the *deduplication rule* and not on a fixture.
    const { report, entries } = project('defect/off-palette-over-skin-32');
    assertReportInvariants(report);
    const context = createQualityContext(corpus('defect/off-palette-over-skin-32'));
    const keys = new Set<string>();
    for (const id of QUALITY_DIMENSIONS) {
      for (const issue of report.dimensions[id]?.issues ?? []) keys.add(keyOf(issue.code, issue.rect));
    }
    for (const issue of aggregatorIssues(context)) keys.add(keyOf(issue.code, issue.rect));
    // One entry per `(code, rect)`, no more and no fewer: the same code in two places is two
    // defects and the same code twice in one place is one.
    expect(entries.length).toBe(keys.size);
    expect(entries.map((entry) => keyOf(entry.code, entry.rect)).sort()).toEqual([...keys].sort());

    // The attribution of a merged entry is pipeline order, so it is a property of the pipeline and
    // not of a hash map - and a merge that kept only the first dimension would lose the fact that
    // two measurements agreed.
    for (const entry of entries) {
      expect(entry.dimensions).toEqual(QUALITY_DIMENSIONS.filter((id) => entry.dimensions.includes(id)));
    }
    const byKey = new Map(entries.map((entry) => [keyOf(entry.code, entry.rect), entry]));
    for (const id of QUALITY_DIMENSIONS) {
      for (const issue of report.dimensions[id]?.issues ?? []) {
        expect(byKey.get(keyOf(issue.code, issue.rect))!.dimensions, `${issue.code} keeps ${id}`).toContain(id);
      }
    }
  });

  it("carries the aggregator's own issues, which is the only place `frames-identical` exists", () => {
    // A projection that walked `report.dimensions` and forgot the second argument would lose this
    // code entirely, and `frames-identical` is the one code no dimension owns.
    const context = createQualityContext(corpus('motion/frames-identical-16'));
    const report = aggregateQualityReport(context);
    const own = aggregatorIssues(context);
    expect(own.map((issue) => issue.code)).toContain('frames-identical');
    const entries = projectIssues(report, own);
    const carried = entries.find((entry) => entry.code === 'frames-identical');
    expect(carried, 'the aggregator issue must survive the projection').toBeTruthy();
    // Unattributed: the aggregator describes the target, not one dimension's opinion of it.
    expect(carried!.dimensions).toEqual([]);
    // And it is the *only* difference from omitting it, which is what makes this a real test of
    // the second argument rather than of the fixture.
    expect(projectIssues(report)).not.toContainEqual(expect.objectContaining({ code: 'frames-identical' }));
  });
});

describe('an abstention is not a clean one', () => {
  it('separates "did not apply" from "measured, and this term could not be taken"', () => {
    // `control/full-bleed-scene` is the case with no precedent: `silhouette`/`value` apply,
    // `value.form` abstains, and the two facts must be two entries rather than one.
    const context = createQualityContext(corpus('bleed/full-bleed-scene-32'));
    const report = aggregateQualityReport(context);
    assertReportInvariants(report);
    const absences = projectAbsences(report);
    expect(absences.length).toBeGreaterThan(0);

    const whole = absences.filter((absence) => absence.subScore === null);
    const partial = absences.filter((absence) => absence.subScore !== null);
    expect(whole.length, 'a still sprite cannot measure motion').toBeGreaterThan(0);
    expect(partial.length, 'a full-bleed scene cannot judge its form term').toBeGreaterThan(0);

    // Neither kind is ever reported against a dimension that measured - that is the claim that
    // would turn "nobody looked" into "clean", and it is the one T-099 was written about.
    for (const absence of absences) {
      expect(
        absence.subScore === null ? report.excluded[absence.dimension] : report.dimensions[absence.dimension] !== undefined,
        `${absence.dimension}.${absence.subScore ?? '(whole)'}`,
      ).toBeTruthy();
      expect(absence.reason).toBeTruthy();
    }
    // A whole-dimension entry names a dimension that has no score at all, so there is no way for a
    // consumer to read it as one that scored.
    for (const absence of whole) expect(report.dimensions[absence.dimension]).toBeUndefined();
    // A sub-score entry names a dimension that *did* measure, and its sub-score really is absent
    // from that dimension's own map.
    for (const absence of partial) {
      expect(report.dimensions[absence.dimension]?.unmeasured?.[absence.subScore!]).toBe(absence.reason);
    }
  });

  it('accounts for every dimension exactly once, measured or absent', () => {
    // The near-miss: a walk that emitted each dimension twice, or dropped one, would still produce
    // absences. This is the arithmetic that closes it.
    const { report, entries } = project('control/clean-figure-20');
    assertReportInvariants(report);
    const absences = projectAbsences(report);
    const named = new Set<string>([
      ...QUALITY_DIMENSIONS.filter((id) => report.dimensions[id] !== undefined).map((id) => `m:${id}`),
      ...absences.map((absence) => `a:${absence.dimension}.${absence.subScore ?? ''}`),
    ]);
    expect(named.size).toBe(QUALITY_DIMENSIONS.length + absences.filter((a) => a.subScore !== null).length);
    // And the issues list is entirely about defects: no entry carries a score field of any kind,
    // because a projection that published one would be a score an agent can move toward.
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(['blocking', 'code', 'dimensions', 'message', 'rect', 'severity']);
    }
  });
});