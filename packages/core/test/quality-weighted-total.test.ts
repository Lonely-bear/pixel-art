import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { weightedTotalQ } from '../src/quality/index.js';
import {
  DEFAULT_QUALITY_WEIGHTS,
  QUALITY_DIMENSIONS,
  type QualityDimension,
  type QualityDimensionId,
} from '../src/quality/types.js';

/**
 * §5.2's weighted total, pinned at its one home.
 *
 * This function used to exist twice — once here, once copied into `commands/quality.ts` for
 * `qualityGate`. The two copies were byte-identical, but a copy of a rounding rule is a copy
 * of a *number*, and the `weightedTotalQ` in `AGENTS.md`'s list of measurements that could
 * not fail is one edit away from becoming one that can. These tests pin the arithmetic so a
 * future divergence is a failing test rather than a gate that refuses for a reason nobody can
 * reproduce; the last case in the file pins the *absence* of a second definition.
 */

function dimension(scoreQ: number): QualityDimension {
  return { scoreQ, verdict: `${scoreQ} per mille`, issues: [], unmeasured: {} };
}

function dimensions(scores: Partial<Record<QualityDimensionId, number>>): {
  dimensions: Partial<Record<QualityDimensionId, QualityDimension>>;
} {
  const out: Partial<Record<QualityDimensionId, QualityDimension>> = {};
  for (const [id, scoreQ] of Object.entries(scores) as [QualityDimensionId, number][]) {
    out[id] = dimension(scoreQ);
  }
  return { dimensions: out };
}

describe('weightedTotalQ', () => {
  it('totals 0 when nothing was measured, which is `fail` and not a perfect score', () => {
    // The fail-closed branch. An empty active set has no evidence of quality at all, and 1000
    // here would be the fake-perfect score that tells a reader a scene nobody can measure is
    // perfect. If this ever returns 1000, the exclusion path in `evaluate` has silently changed.
    expect(weightedTotalQ({})).toBe(0);
  });

  it('reads one dimension through unchanged, weight included', () => {
    // A single present dimension is its own denominator, so its scoreQ is the total whatever
    // its weight is. This is the case that fails if the denominator is ever taken from a fixed
    // 1000 instead of from the weights that actually contributed.
    for (const id of QUALITY_DIMENSIONS) {
      expect(weightedTotalQ(dimensions({ [id]: 813 }).dimensions), id).toBe(813);
    }
  });

  it('re-normalises onto the weights that contributed, so a still sprite is not penalised', () => {
    // `motion` (80) is absent for a single-frame document. The five that remain sum to 920, not
    // 1000, and all five score identically here — so the total is 1000 either way, and a
    // denominator of 1000 would give 920 and quietly fail every still sprite in the corpus.
    const still: QualityDimensionId[] = ['silhouette', 'value', 'palette', 'noise', 'outline'];
    const perfect = Object.fromEntries(still.map((id) => [id, 1000]));
    const denominator = still.reduce((sum, id) => sum + DEFAULT_QUALITY_WEIGHTS[id], 0);
    expect(denominator).toBe(920);
    expect(weightedTotalQ(dimensions(perfect).dimensions)).toBe(1000);
  });

  it('weights the dimensions it has, and only those', () => {
    // silhouette 300 @ 1000, outline 100 @ 500 → (300000 + 50000) / 400 = 875.
    const total = weightedTotalQ(dimensions({ silhouette: 1000, outline: 500 }).dimensions);
    expect(total).toBe(875);
  });

  it('rounds half up, and the gate has both sides of that line', () => {
    // One per-mille of difference in the input moves the total by one per-mille of output, so
    // a truncation bug is invisible on any fixture whose ratio happens to land clear of .5.
    // These two differ by exactly one per-mille of `outline` and straddle 798.5:
    //   outline 193 → 319300 / 400 = 798.25 → 798
    //   outline 194 → 319400 / 400 = 798.50 → 799 (half rounds up)
    // Neither is reachable by chance, and 194 below the line would read as 798.
    expect(weightedTotalQ(dimensions({ silhouette: 1000, outline: 193 }).dimensions)).toBe(798);
    expect(weightedTotalQ(dimensions({ silhouette: 1000, outline: 194 }).dimensions)).toBe(799);
  });

  it('never leaves the 0..1000 range, on any subset of dimensions at either extreme', () => {
    // The gate compares this integer against 400 and 600, so a total outside the per-mille
    // range is a gate reading that cannot mean anything. Every subset, every score at both
    // ends: cheap, and it covers the subsets hand-picked fixtures miss.
    for (let mask = 0; mask < 1 << QUALITY_DIMENSIONS.length; mask++) {
      const present = QUALITY_DIMENSIONS.filter((_, i) => (mask & (1 << i)) !== 0);
      for (const scoreQ of [0, 1, 500, 999, 1000]) {
        const scores = Object.fromEntries(present.map((id) => [id, scoreQ]));
        const total = weightedTotalQ(dimensions(scores).dimensions);
        expect(Number.isInteger(total), present.join('+') + ` @${scoreQ}`).toBe(true);
        expect(total, present.join('+') + ` @${scoreQ}`).toBeGreaterThanOrEqual(0);
        expect(total, present.join('+') + ` @${scoreQ}`).toBeLessThanOrEqual(1000);
      }
    }
  });

  it('is the only definition of §5.2 in core — no second copy to drift', () => {
    // The point of the refactor. A copy of the rounding rule is a copy of a number, and a
    // second `function weightedTotalQ` anywhere in `src/` puts that number back at risk no
    // matter what any test asserts. This walks the source rather than the module graph
    // because a local `function` is not an import and would not show up as one.
    // `fileURLToPath`, not `.pathname`: the URL form percent-encodes a non-ASCII path segment,
    // and this repo's own directory is `AI项目`.
    const src = fileURLToPath(new URL('../src/', import.meta.url));
    const homes: string[] = [];
    let total = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const body = readFileSync(path, 'utf8');
        // Strip comments first: prose that names the function on purpose is not a definition.
        const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const definitions = code.match(/(function|const|let)\s+weightedTotalQ\b/g) ?? [];
        if (definitions.length > 0) {
          homes.push(`${path} (${definitions.length})`);
          total += definitions.length;
        }
      }
    };
    walk(src);
    // Exactly one home in the whole package, not merely no two in one file. The path is
    // machine-specific, so match the tail rather than the whole string.
    expect(total).toBe(1);
    expect(homes).toHaveLength(1);
    expect(homes[0]).toMatch(/quality[\\/]index\.ts \(1\)$/);
  });
});
