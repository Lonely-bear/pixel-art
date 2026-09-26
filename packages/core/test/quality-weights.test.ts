import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUALITY_WEIGHTS,
  FLOOR_FAIL,
  QUALITY_DIMENSIONS,
  type QualityDimensionId,
  STATIC_QUALITY_WEIGHTS,
} from '../src/quality/types.js';

/**
 * Drift guard: the weights in `types.ts` are the weights in the specification.
 *
 * T-010 (the spec) and T-011 (the contract) were written in parallel with nothing binding
 * between them, and they disagreed about the weight table for a whole task cycle — the
 * code said `noise 0.15 / palette 0.12`, the spec said `noise 120 / palette 140` — and
 * nothing noticed. The numbers are duplicated in prose in two files, and prose does not
 * fail a build. This does.
 *
 * The table is therefore *parsed out of the spec* rather than copied into this file: a
 * duplicated literal only relocates the drift, it does not detect it. The corollary is
 * that the parser must fail loudly. A guard that cannot read the table and quietly reports
 * "no drift" is worse than no guard at all, because it converts a broken checkout into a
 * green build and reports the absence of a check as the presence of a pass.
 */

// `packages/core/test/` -> `packages/core/` -> `packages/` -> repo root. Three levels: a
// path that resolves to the wrong directory has to fail here, not quietly find nothing.
const SPEC_PATH = fileURLToPath(new URL('../../../docs/EVALUATION.md', import.meta.url));
const SECTION = '§5.1';

function readSpec(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `Cannot read the scoring specification at ${path}. ${SECTION} is the authority for ` +
        `DEFAULT_QUALITY_WEIGHTS, so this guard fails rather than skipping: a missing spec ` +
        `is a broken checkout, not a reason to pass quietly. Underlying error: ` +
        `${(error as Error).message}`,
    );
  }
}

const SECTION_HEADING = /^#{2,4}\s*5\.1\b/;
const TABLE_HEADER = /^\|\s*Dimension\s*\|\s*Weight\s*\|/i;
const WEIGHT_ROW = /^\|\s*`([a-z][a-z-]*)`\s*\|\s*\*\*(\d+)\*\*\s*\|/;

/**
 * Pull the §5.1 weight table out of the specification.
 *
 * Every failure names the file, the 1-based line, and what was expected there, because the
 * realistic failure is not "the weights changed" but "the table was reformatted and this
 * parser no longer sees it" — and a parser that reports that as a clean run is the whole
 * failure mode this file exists to prevent.
 */
function parseWeightTable(markdown: string, path: string): Record<string, number> {
  const lines = markdown.split(/\r?\n/);
  const at = (i: number) => `${path}:${i + 1}`;

  const heading = lines.findIndex((line) => SECTION_HEADING.test(line));
  if (heading < 0) {
    throw new Error(
      `${path}: no '## 5.1' heading anywhere in the document. Expected the ${SECTION} ` +
        `'Weights' section that this guard reads the table from.`,
    );
  }

  let header = -1;
  for (let i = heading + 1; i < lines.length; i++) {
    if (TABLE_HEADER.test(lines[i])) {
      header = i;
      break;
    }
    if (/^#{1,4}\s/.test(lines[i])) break; // ran into the next section without a table
  }
  if (header < 0) {
    throw new Error(
      `${at(heading)}: ${SECTION} contains no '| Dimension | Weight |' table header row. ` +
        `Expected the weight table to begin within the section.`,
    );
  }

  const weights: Record<string, number> = {};
  for (let i = header + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) break;
    // The `| --- | --- |` rule under the header is part of the table, not a data row.
    if (/^\|[\s:|-]+\|/.test(line)) continue;
    const match = WEIGHT_ROW.exec(line);
    if (!match) {
      throw new Error(
        `${at(i)}: cannot parse a weight row.\n` +
          `  expected: | \`<dimension>\` | **<per-mille integer>** | ... |\n` +
          `  found:    ${line.trim()}`,
      );
    }
    const [, id, value] = match;
    if (id in weights) throw new Error(`${at(i)}: dimension '${id}' is listed twice in ${SECTION}.`);
    weights[id] = Number(value);
  }

  if (Object.keys(weights).length === 0) {
    throw new Error(
      `${at(header)}: the ${SECTION} table has a header but no rows. Expected one row per ` +
        `dimension.`,
    );
  }
  return weights;
}

let cached: Record<string, number> | null = null;

/** Parsed per test, not at module load, so a parse failure is attributed to a test. */
function specWeights(): Record<string, number> {
  if (cached === null) cached = parseWeightTable(readSpec(SPEC_PATH), SPEC_PATH);
  return cached;
}

describe('quality weights track the specification', () => {
  it('lists exactly the dimension ids the code knows about', () => {
    const spec = specWeights();
    const expected = [...QUALITY_DIMENSIONS].sort();
    expect(Object.keys(spec).sort(), `${SECTION} lists a different set of dimensions than types.ts`).toEqual(
      expected,
    );
  });

  it('agrees with DEFAULT_QUALITY_WEIGHTS, value for value', () => {
    const spec = specWeights();
    const drift: string[] = [];
    for (const id of QUALITY_DIMENSIONS) {
      if (spec[id] !== DEFAULT_QUALITY_WEIGHTS[id]) {
        drift.push(`${id}: ${SECTION} says ${spec[id]}, types.ts says ${DEFAULT_QUALITY_WEIGHTS[id]}`);
      }
    }
    expect(
      drift,
      'DEFAULT_QUALITY_WEIGHTS has drifted from the specification. Re-tune the code and the ' +
        'spec in the same commit, or the baselines move without anyone deciding to move them.',
    ).toEqual([]);
  });

  it('uses integers in 0..1000 summing to 1000', () => {
    // Checked on both sides. Checking only the spec would let a commit that re-tunes the
    // table *and* the code together pass while breaking the invariant the denominator
    // depends on — the drift guard and the invariant would then be blind to each other.
    const spec = specWeights();
    for (const id of QUALITY_DIMENSIONS) {
      for (const [where, weight] of [
        ['spec', spec[id]],
        ['types.ts', DEFAULT_QUALITY_WEIGHTS[id]],
      ] as const) {
        expect(
          Number.isInteger(weight) && weight >= 0 && weight <= 1000,
          `${where} weight for ${id} is ${weight}; a weight is a per-mille integer in 0..1000`,
        ).toBe(true);
      }
    }
    const specTotal = QUALITY_DIMENSIONS.reduce((sum, id) => sum + spec[id], 0);
    const codeTotal = QUALITY_DIMENSIONS.reduce((sum, id) => sum + DEFAULT_QUALITY_WEIGHTS[id], 0);
    expect(specTotal, 'the §5.1 table must sum to 1000 so the denominator is a fixed point').toBe(
      1000,
    );
    expect(
      codeTotal,
      'DEFAULT_QUALITY_WEIGHTS must sum to 1000, or the weighted total is not a per-mille value',
    ).toBe(1000);
  });

  it('drops only motion for a still sprite, leaving the 920 denominator', () => {
    const spec = specWeights();
    for (const id of QUALITY_DIMENSIONS) {
      const expected = id === 'motion' ? 0 : spec[id];
      expect(
        STATIC_QUALITY_WEIGHTS[id],
        `STATIC_QUALITY_WEIGHTS.${id} should be ${expected} — the still set differs from the ` +
          `default in motion alone`,
      ).toBe(expected);
    }
    const stillTotal = QUALITY_DIMENSIONS.reduce((sum, id) => sum + STATIC_QUALITY_WEIGHTS[id], 0);
    expect(stillTotal, '§5.2 fixes the still-sprite denominator at 920').toBe(920);
  });
});

describe('the weight-table parser fails loudly', () => {
  it('names the file when the specification is missing', () => {
    const missing = join(dirname(SPEC_PATH), 'NO-SUCH-SPEC.md');
    expect(() => readSpec(missing)).toThrow(/Cannot read the scoring specification/);
    expect(() => readSpec(missing)).toThrow(new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('names the file when there is no §5.1 section', () => {
    expect(() => parseWeightTable('# Something else\n\nno weights here\n', 'spec.md')).toThrow(
      /spec\.md: no '## 5\.1' heading anywhere in the document/,
    );
  });

  it('names the section when §5.1 has no table', () => {
    const markdown = '## 5.1 Weights\n\nJust prose, no table.\n';
    expect(() => parseWeightTable(markdown, 'spec.md')).toThrow(
      /spec\.md:1: §5\.1 contains no '\| Dimension \| Weight \|' table header row/,
    );
  });

  it('names the line and the row when a weight row is unparseable', () => {
    const markdown = [
      '## 5.1 Weights',
      '',
      '| Dimension | Weight | Why |',
      '| --- | --- | --- |',
      '| `silhouette` | **300** | reads at 32px |',
      '| `value` | **260** | survives downscaling |',
      '| silhouette | **300** | the backticks went missing |',
      '',
    ].join('\n');
    let message = '';
    try {
      parseWeightTable(markdown, 'spec.md');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('spec.md:7');
    expect(message).toContain('expected: | `<dimension>` | **<per-mille integer>** |');
    expect(message).toContain('the backticks went missing');
  });

  it('rejects a weight that lost its bold markers', () => {
    const markdown = [
      '## 5.1 Weights',
      '',
      '| Dimension | Weight | Why |',
      '| --- | --- | --- |',
      '| `silhouette` | 300 | the bold went missing |',
      '',
    ].join('\n');
    expect(() => parseWeightTable(markdown, 'spec.md')).toThrow(
      /spec\.md:5: cannot parse a weight row/,
    );
  });

  it('rejects a duplicated dimension row', () => {
    const markdown = [
      '## 5.1 Weights',
      '',
      '| Dimension | Weight | Why |',
      '| --- | --- | --- |',
      '| `silhouette` | **300** | once |',
      '| `silhouette` | **300** | twice |',
      '',
    ].join('\n');
    expect(() => parseWeightTable(markdown, 'spec.md')).toThrow(
      /spec\.md:6: dimension 'silhouette' is listed twice in §5\.1/,
    );
  });
});

describe('per-dimension floors are complete and integral', () => {
  it('has an in-range integer floor for every dimension', () => {
    for (const id of QUALITY_DIMENSIONS) {
      const floor = FLOOR_FAIL[id];
      expect(
        Number.isInteger(floor) && floor >= 0 && floor <= 1000,
        `FLOOR_FAIL.${id} is ${floor}; a floor is a per-mille integer in 0..1000, and a ` +
          `missing decimal point here fails every sprite that scores well`,
      ).toBe(true);
    }
  });

  it('is keyed by exactly the dimension ids', () => {
    const keys = Object.keys(FLOOR_FAIL).sort() as QualityDimensionId[];
    expect(keys).toEqual([...QUALITY_DIMENSIONS].sort());
  });
});
