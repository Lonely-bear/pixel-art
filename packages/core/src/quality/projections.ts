/**
 * Projections of a {@link QualityReport} onto the flat lists a reader works from.
 *
 * ## Why this file exists
 *
 * Two surfaces needed "every defect, deduplicated by `(code, rect)`, sorted so blocking ones come
 * first", and both wrote it out:
 *
 *   - `packages/mcp/src/quality-report.ts` `indexIssues` - the flat `issues` list on the
 *     `evaluate` tool and the `pixel://quality/{doc}` resource, which carries `severity`.
 *   - `packages/core/src/commands/share.ts` `judge` - the same walk, re-projected down to names so
 *     that nothing numeric can reach a forwarded file.
 *
 * They agreed today and had no reason to keep agreeing: the aggregator's ordering rule lives in
 * `types.ts`, and a second sort written next to a second deduplication key is two more places
 * that can be wrong independently. So the **walk** is here, in core, once; each surface keeps its
 * own **wording** and its own **policy** about which fields may travel (see below).
 *
 * ## Two things this file deliberately does not do
 *
 * 1. **It publishes no score, no total and no per-dimension grade.** Every entry here is a
 *    *named defect* and the geometry of it. `severity` is present because the MCP report's own
 *    contract has always carried it, and it is the one field on this type that a surface must
 *    choose to drop: {@link ProjectedIssue.severity} is `readonly` and easy to omit, and the
 *    share card omits it. A shared helper that quietly published a total would be the deleted
 *    `quality_report` tool arriving again through the back door, so nothing here computes one.
 * 2. **It does not fold an abstention into a measurement.** {@link projectAbsences} returns whole
 *    dimensions and sub-scores as *separate* entries with a `subScore` of `null` for the former,
 *    because "did not apply" and "measured, and this term could not be taken" are different
 *    claims and a reader who cannot tell them apart will read the second as a pass.
 */
import type { Rect } from '../types.js';
import {
  isBlocking,
  QUALITY_DIMENSIONS,
  type ExcludedReason,
  type QualityDimensionId,
  type QualityIssue,
  type QualityReport,
} from './types.js';

/**
 * One issue, flattened and attributed.
 *
 * Deduplicated by `(code, rect)` - the aggregator's own rule, and for the same reason: two
 * dimensions legitimately naming one defect should read as one defect. The dimension names are
 * collected rather than discarded, so the collapse does not lose the information that two
 * measurements agreed.
 */
export interface ProjectedIssue {
  readonly code: string;
  readonly message: string;
  /**
   * 0..1, and at or above {@link isBlocking}'s threshold it blocks delivery.
   *
   * **A number, so it is a surface's decision whether it travels.** The MCP report publishes it
   * because its output schema has always declared it; the share card drops it, because a share
   * bundle is the most forwarded file this repository produces.
   */
  readonly severity: number;
  readonly rect: Rect | null;
  /** Which measured dimensions raised this, in {@link QUALITY_DIMENSIONS} order. Empty when the aggregator raised it. */
  readonly dimensions: readonly QualityDimensionId[];
  /** True at or above the blocking threshold. Always a prefix of this list, because the sort below is severity-descending. */
  readonly blocking: boolean;
}

/** Rects are objects whose identity says nothing, so the dedup key is the geometry. */
export function rectKey(rect: Rect | null): string {
  return rect === null ? 'global' : `${rect.x},${rect.y},${rect.w},${rect.h}`;
}

/**
 * Every issue from every measured dimension, plus the aggregator's own, flattened.
 *
 * @param report The measured report. Its `dimensions` record is walked in {@link QUALITY_DIMENSIONS}
 *   order so the attribution of a deduplicated issue is a property of the pipeline rather than of
 *   a hash map.
 * @param own The aggregator's own issues (`aggregatorIssues(context)`), which describe the target
 *   rather than any one dimension's opinion of it and so carry no dimension attribution.
 *
 * Severity descending first, which is what puts every blocking issue ahead of every advisory -
 * the one property a truncation cap downstream depends on.
 */
export function projectIssues(report: QualityReport, own: readonly QualityIssue[] = []): ProjectedIssue[] {
  const byKey = new Map<string, ProjectedIssue>();
  const add = (issue: QualityIssue, dimension: QualityDimensionId | null): void => {
    const key = `${issue.code}|${rectKey(issue.rect)}`;
    const existing = byKey.get(key);
    if (existing) {
      // Same defect, second opinion. Record the dimension rather than dropping it.
      if (dimension !== null && !existing.dimensions.includes(dimension)) {
        byKey.set(key, {
          ...existing,
          dimensions: QUALITY_DIMENSIONS.filter((id) => id === dimension || existing.dimensions.includes(id)),
        });
      }
      return;
    }
    byKey.set(key, {
      code: issue.code,
      message: issue.message,
      severity: issue.severity,
      rect: issue.rect,
      dimensions: dimension === null ? [] : [dimension],
      blocking: isBlocking(issue),
    });
  };

  for (const id of QUALITY_DIMENSIONS) {
    for (const issue of report.dimensions[id]?.issues ?? []) add(issue, id);
  }
  for (const issue of own) add(issue, null);

  return [...byKey.values()].sort(
    (a, b) =>
      b.severity - a.severity ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
      (rectKey(a.rect) < rectKey(b.rect) ? -1 : rectKey(a.rect) > rectKey(b.rect) ? 1 : 0),
  );
}

/**
 * One absence: a dimension that did not apply, or a sub-score of a dimension that could not be
 * taken.
 *
 * The two are one shape because they are one *fact* to a reader - part of this claim was not
 * checked - and two claims to a machine. `subScore` is `null` for the whole dimension and the
 * sub-score name (`form`, `isolated`, ...) for the second case, so a surface cannot accidentally
 * report a partly-measured dimension as fully measured by dropping a field: the entry simply is
 * not in `report.dimensions[id]`'s `unmeasured` map.
 */
export interface ProjectedAbsence {
  readonly dimension: QualityDimensionId;
  /** The sub-score that could not be taken, or `null` when the whole dimension did not apply. */
  readonly subScore: string | null;
  readonly reason: ExcludedReason;
}

/**
 * Every abstention in a report, in {@link QUALITY_DIMENSIONS} order and by ascending sub-score
 * name within a dimension.
 *
 * Order is fixed here rather than left to each surface so that two surfaces describing the same
 * absences describe them in the same sequence; a surface that wants a different presentation
 * sorts its own copy, which is a presentation decision rather than a second walk over the report.
 *
 * The keys of `report.excluded` are exactly the ids missing from `report.dimensions` (`types.ts`
 * says so and `assertConsistentReport` checks it), so walking the dimension list enumerates every
 * absence without consulting a second structure.
 */
export function projectAbsences(report: QualityReport): ProjectedAbsence[] {
  const out: ProjectedAbsence[] = [];
  for (const id of QUALITY_DIMENSIONS) {
    const reason = report.excluded[id];
    if (reason !== undefined) out.push({ dimension: id, subScore: null, reason });
    const map = report.dimensions[id]?.unmeasured;
    if (!map) continue;
    for (const subScore of Object.keys(map).sort()) {
      out.push({ dimension: id, subScore, reason: map[subScore] });
    }
  }
  return out;
}