import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The Action's inputs are pinned against `docs/ACTION.md`.
 *
 * ## Why a test rather than a review
 *
 * A GitHub Action's input list lives in one YAML file, and the only other place a consumer can
 * learn it is the prose. Nothing enforces that the two agree, so the failure mode is ordinary
 * and quiet: someone adds `cache-key`, the Action accepts it, the README does not mention it,
 * and a user discovers the feature by reading `.github/actions/build-assets/action.yml` in a
 * dependency. That is the same class of drift `npm-surface.test.ts` exists to stop on the other
 * side of this repository — a documented surface that the documentation no longer describes.
 *
 * So the assertion is deliberately two-sided:
 *
 *   - every input in `action.yml` appears in `docs/ACTION.md`'s input table, **with the same
 *     default**, and
 *   - every row of that table is a real input with that default.
 *
 * Either direction failing is a drift. A one-way check would pass on the day someone documented
 * an input and then deleted it, which is the more embarrassing of the two.
 *
 * ## What this does *not* test, and why that is the right boundary
 *
 * It does not run the Action. A composite action is YAML interpreted by the GitHub runner: there
 * is no local execution of `action.yml` short of a container, and a test that shells out to
 * `act` or a workflow runner would be testing a third-party binary, not this repository. So the
 * runtime evidence is the commands themselves, run and pasted — see `docs/ACTION.md` and the
 * example workflow — while this test guards the one thing that *can* be checked cheaply and is
 * genuinely load-bearing: the contract between the YAML and the prose.
 *
 * ## The YAML subset
 *
 * Hand-parsed rather than pulled from a YAML library, because `packages/core` has exactly four
 * runtime dependencies and a test that added a fifth — or reached into a transitive one — would
 * be a dependency this project does not have. `action.yml` is a small, flat document and the
 * parser below reads the only part that matters: the `inputs:` block, its keys, and each key's
 * `required` / `default`. It is a parser for *this* file's shape, and `it('parses the shape it
 * expects')` is the assertion that says so — a reformatting that defeats it fails here rather
 * than silently matching nothing.
 */

const ACTION = fileURLToPath(new URL('../../../.github/actions/build-assets/action.yml', import.meta.url));
const DOC = fileURLToPath(new URL('../../../docs/ACTION.md', import.meta.url));

/** One declared input: its default, with `undefined` meaning "no default line". */
interface DeclaredInput {
  readonly name: string;
  readonly required: boolean;
  readonly default: string | undefined;
}

/**
 * Read the `inputs:` block.
 *
 * Indentation-driven and deliberately strict about what it understands: `inputs:` at column 0,
 * input names two spaces in, their properties four. Anything else is a shape this parser does
 * not model, which the shape test below turns into a visible failure instead of a quiet `[]`.
 */
function parseInputs(source: string): DeclaredInput[] {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => /^inputs:\s*$/.test(line));
  if (start < 0) throw new Error('action.yml has no top-level `inputs:` block');

  const inputs: DeclaredInput[] = [];
  let current: { name: string; required: boolean; default: string | undefined } | null = null;

  for (const raw of lines.slice(start + 1)) {
    if (/^\S/.test(raw)) break; // the next top-level key: `runs:` ends the block
    const name = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(raw);
    if (name) {
      current = { name: name[1], required: false, default: undefined };
      inputs.push(current);
      continue;
    }
    if (!current) continue;
    const required = /^ {4}required:\s*(\S+)\s*$/.exec(raw);
    if (required) {
      current.required = required[1] === 'true';
      continue;
    }
    const dflt = /^ {4}default:\s*(.*?)\s*$/.exec(raw);
    if (dflt) {
      // Single-quoted YAML scalars keep their quotes; everything else is taken literally.
      current.default = dflt[1].startsWith("'") && dflt[1].endsWith("'")
        ? dflt[1].slice(1, -1)
        : dflt[1];
    }
  }
  return inputs;
}

/**
 * One row of `docs/ACTION.md`'s input table: `` `name` ``, then the default cell.
 *
 * The default cell is normalised to the same spelling `action.yml` uses, so the comparison is
 * about the *value* and not about how each file happens to write an empty string. `—` and a
 * bare backtick pair both mean "no default", and an empty cell means the documented default is
 * the empty string, which is a real and different thing (`check-command`).
 */
function parseDocTable(source: string): Map<string, string | undefined> {
  const rows = new Map<string, string | undefined>();
  for (const line of source.split(/\r?\n/)) {
    const cells = line.split('|').map((cell) => cell.trim());
    // A table row is `| a | b | c |`; the leading empty cell makes cells[0] === ''.
    if (cells.length < 4 || cells[0] !== '') continue;
    const name = /`([A-Za-z0-9_-]+)`/.exec(cells[1]);
    if (!name) continue;
    const cell = unquote(cells[2]);
    // `*(required)*` and an em dash both document "no default"; an empty cell means the
    // documented default is the empty string, which is a real and different thing.
    if (/^—$/.test(cell) || /^\*\(required\)\*$/.test(cell)) {
      rows.set(name[1], undefined);
      continue;
    }
    rows.set(name[1], cell);
  }
  return rows;
}

/**
 * Strip the two layers of quoting a table cell puts around a value: Markdown
 * backticks and YAML single quotes. Applied repeatedly rather than as a single
 * alternation, because `ACTION.md` writes a YAML default the way `action.yml`
 * spells it — ``` `'off'` ``` — and a one-pass regex leaves the quotes on.
 */
function unquote(cell: string): string {
  let value = cell.trim();
  for (let pass = 0; pass < 3; pass++) {
    const next = value.startsWith('`') && value.endsWith('`') && value.length >= 2
      ? value.slice(1, -1)
      : value.startsWith("'") && value.endsWith("'") && value.length >= 2
        ? value.slice(1, -1)
        : value;
    if (next === value) break;
    value = next;
  }
  return value;
}

const actionSource = readFileSync(ACTION, 'utf8');
const docSource = readFileSync(DOC, 'utf8');
const inputs = parseInputs(actionSource);
const documented = parseDocTable(docSource);

describe('the Action parses as the shape this test expects', () => {
  it('finds an inputs block with the properties it reads', () => {
    // If a reformatting defeats the parser, everything below would compare an empty list
    // against an empty list and pass for the wrong reason. This is the assertion that turns
    // "the parse is broken" into a failure rather than into a vacuous one.
    expect(inputs.length, 'no inputs parsed from action.yml — the parser no longer fits the file').toBeGreaterThan(4);
    expect(inputs.every((input) => input.name.length > 0)).toBe(true);
    // Every input declares a description: it is the text a consumer reads in the Actions UI,
    // and an input with none is the same omission the MCP tool-surface test refuses.
    for (const input of inputs) {
      const block = actionSource.slice(actionSource.indexOf(`  ${input.name}:`));
      expect(block.slice(0, 400), `${input.name} has no description`).toMatch(/\n {4}description:/);
    }
  });

  it('names exactly one required input', () => {
    const required = inputs.filter((input) => input.required).map((input) => input.name);
    expect(required).toEqual(['command']);
  });
});

describe('every Action input is documented in docs/ACTION.md', () => {
  it('lists each input with the same default', () => {
    const missing: string[] = [];
    const wrongDefault: string[] = [];
    for (const input of inputs) {
      if (!documented.has(input.name)) {
        missing.push(input.name);
        continue;
      }
      const docDefault = documented.get(input.name);
      // A required input has no default in either place; anything else must match exactly.
      if (input.required && input.default === undefined) continue;
      if (docDefault !== input.default) {
        wrongDefault.push(
          `${input.name}: action.yml says ${JSON.stringify(input.default)}, ` +
            `ACTION.md says ${JSON.stringify(docDefault)}`,
        );
      }
    }
    expect(missing, `undocumented Action input(s): ${missing.join(', ')}`).toEqual([]);
    expect(wrongDefault, `documented default disagrees with action.yml — ${wrongDefault.join('; ')}`).toEqual([]);
  });

  it('documents no input that does not exist', () => {
    // The other direction. Without it, deleting an input and forgetting the row would leave a
    // documented option that silently does nothing.
    const declared = new Set(inputs.map((input) => input.name));
    const orphans = [...documented.keys()].filter((name) => !declared.has(name));
    expect(orphans, `documented but not declared: ${orphans.join(', ')}`).toEqual([]);
  });
});

describe('what the Action promises about failing a build', () => {
  const doc = docSource;

  it('says an advisory does not fail the build, in the imperative', () => {
    // The one claim in this document that a reader could get backwards from a skim, and the
    // one AGENTS.md cares about: a machine must not be handed a way to fail a build over
    // something a human should judge.
    expect(doc).toMatch(/an advisory never fails a build/i);
  });

  it('says the quality gate is off by default', () => {
    expect(doc).toMatch(/`quality-gate` \| `'off'`/);
    expect(doc).toMatch(/off by default/i);
  });

  it('publishes no aggregate quality score', () => {
    // The deleted `quality_report` tool's lesson, kept as a check rather than as a memory: the
    // Action's log format is free of any field that is one number for the whole artwork.
    const gate = readFileSync(
      fileURLToPath(new URL('../../../.github/actions/build-assets/gate.mjs', import.meta.url)),
      'utf8',
    );
    // `report.score` and `report.verdict` are the two fields that would produce one.
    expect(gate).not.toMatch(/report\.score|\.score\b|weightedTotalQ|weighted-total at/);
    // A `weighted-total` refusal is named but must not print its number.
    expect(gate).toMatch(/kind === 'total'/);
  });

  it('keeps the gate off the clock and off randomness', () => {
    // The determinism claim is only worth making if the code honours it, and the whole reason a
    // byte-comparison check is a good `check-command` is that the engine is reproducible.
    const gate = readFileSync(
      fileURLToPath(new URL('../../../.github/actions/build-assets/gate.mjs', import.meta.url)),
      'utf8',
    );
    expect(gate).not.toMatch(/Math\.random|Date\.now|new Date\(/);
  });
});
