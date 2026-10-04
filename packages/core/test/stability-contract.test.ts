import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as core from '../src/index.js';
import * as entry from '../../../scripts/npm-index.js';

/**
 * `docs/STABILITY.md` is a promise. This file checks it.
 *
 * ## Why the declaration lives in the prose
 *
 * `docs/ASSET-CONTRACT.md` set the precedent: a specification whose tables a test parses cannot
 * drift from the code, and a specification whose promises live only in sentences can. A contract
 * nobody executes is a contract nobody updates, and the failure it produces is not a build break
 * here — it is a consumer's build break, on someone else's machine, months later.
 *
 * The declaration is a fenced ```json stable-surface``` block rather than front matter, for two
 * reasons. `packages/core` ships exactly four runtime dependencies and none parses YAML, while
 * `JSON.parse` is in the language and needs no dependency at all; and a *named* fence makes
 * "find the declaration" one deterministic search, where front matter is "everything above the
 * first blank line" — a shape a prose edit moves without anyone noticing.
 *
 * ## Both directions, because one direction is not a guard
 *
 * A declared name that is not exported is a promise the build has already broken. An exported
 * name that is not declared is worse in the long run: it is how a surface quietly grows from
 * nine names to three hundred, and every one of those steps passes a check that only looked for
 * removals. `AGENTS.md` is blunt about this — a measurement that cannot fire in a direction is
 * not a measurement. Both are asserted here, and the deletion case is asserted as its own case,
 * because a contract whose absence is silence can be removed by accident and nothing will say so.
 *
 * ## Where this file is, and why
 *
 * `packages/core/test`, for the reason `npm-surface.test.ts` gives: the published entry lives in
 * `scripts/npm-index.ts`, no package tsconfig includes it, and core is the only test directory
 * this lane may write to. Both guards read the same declaration and both must agree, so the
 * duplication between them is asserted rather than hoped for — a list that two files hold and one
 * test compares is a list that cannot quietly disagree with itself.
 *
 * ## What this file cannot check
 *
 * It checks that a name exists, not that its signature is unchanged. `npm-consumer-types.test.ts`
 * covers the published types and `npm-surface.test.ts` covers each entry point's behaviour.
 */

const DOC_PATH = new URL('../../../docs/STABILITY.md', import.meta.url);
const BARREL_PATH = new URL('../src/index.ts', import.meta.url);
const SURFACE_TEST_PATH = new URL('./npm-surface.test.ts', import.meta.url);

/** The four surfaces that must be declared unstable, by id. See STABILITY.md S3. */
const REQUIRED_UNSTABLE = [
  'core-barrel',
  'mcp-tool-list',
  'mcp-tool-parameters',
  'cli-flag-surface',
] as const;

interface Declaration {
  apiVersion: string;
  pixelFormatVersion: number;
  stable: string[];
  internal: string[];
  notStable: string[];
}

/**
 * Every `json stable-surface` fence in the document.
 *
 * Returns an array rather than the first match on purpose: a second block is ambiguous, and
 * "ambiguous" is exactly the state where a reader trusts the wrong list.
 */
function declarationBlocks(markdown: string): string[] {
  const fence = /^```json stable-surface[^\S\r\n]*\r?\n([\s\S]*?)^```[^\S\r\n]*$/gm;
  return [...markdown.matchAll(fence)].map((match) => match[1]!);
}

/** The block, parsed, with the shape checked. Throws a named error rather than returning null. */
function readDeclaration(): Declaration {
  const blocks = declarationBlocks(readFileSync(DOC_PATH, 'utf8'));
  if (blocks.length !== 1) {
    throw new Error(
      `docs/STABILITY.md must contain exactly one \`\`\`json stable-surface\`\`\` block; found ${blocks.length}. ` +
        'The declaration is the contract — deleting it is a breaking change, not a cleanup.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(blocks[0]!);
  } catch (error) {
    throw new Error(`docs/STABILITY.md's declaration block is not valid JSON: ${(error as Error).message}`);
  }
  const declaration = parsed as Partial<Declaration>;
  for (const key of ['apiVersion', 'pixelFormatVersion', 'stable', 'internal', 'notStable'] as const) {
    if (declaration[key] === undefined) {
      throw new Error(`docs/STABILITY.md's declaration block is missing "${key}".`);
    }
  }
  return declaration as Declaration;
}

/** `['a', 'b']` out of a `const NAME = [ ... ];` block, or `null` if the block is not there. */
function arrayLiteral(file: string, name: string): string[] | null {
  const match = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(file);
  if (!match) return null;
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((quoted) => quoted[1]!);
}

const declaration = readDeclaration();
const exported = Object.keys(entry).sort();

describe('docs/STABILITY.md and the published entry agree', { timeout: 30_000 }, () => {
  it('declares only names the entry point actually exports', () => {
    // Direction one: a promise the build has already broken. A name in `stable` with no export
    // behind it is a consumer's compile error waiting to happen, and it is invisible to every
    // other test in this repository.
    const missing = [...declaration.stable, ...declaration.internal]
      .filter((name) => !exported.includes(name))
      .sort();
    expect(missing, 'declared in docs/STABILITY.md but not exported by scripts/npm-index.ts').toEqual([]);
  });

  it('declares every name the entry point exports', () => {
    // Direction two, and the one that grows. An undeclared export is how a nine-name contract
    // becomes a three-hundred-name one, one additive change at a time, with every step green.
    const declared = new Set([...declaration.stable, ...declaration.internal]);
    const undeclared = exported.filter((name) => !declared.has(name));
    expect(undeclared, 'exported but in neither `stable` nor `internal`').toEqual([]);
  });

  it('keeps `stable` and `internal` disjoint, and both non-empty', () => {
    // A name in both tiers is stable and not stable at once, which is the one state a reader
    // cannot resolve by reading.
    expect(declaration.internal.filter((name) => declaration.stable.includes(name))).toEqual([]);
    expect(declaration.stable.length).toBeGreaterThan(0);
    expect(declaration.internal.length).toBeGreaterThan(0);
  });

  it("pins API_VERSION from the doc's declaration", () => {
    // The policy in STABILITY.md S2.2 in executable form: the integer moves for a rename or a
    // removal, and not for an addition.
    expect(declaration.apiVersion).toBe(entry.API_VERSION);
  });

  it("pins PIXEL_FORMAT_VERSION from the doc's declaration", () => {
    // The same trick applied to the format promise in S5, so the sentence cannot outlive the
    // constant it describes.
    expect(declaration.pixelFormatVersion).toBe(core.PIXEL_FORMAT_VERSION);
  });

  it('declares the four surfaces that are not stable', () => {
    // The negative half is also a list, so it can be checked for being non-empty. A contract
    // that names nothing unstable says everything is.
    expect(declaration.notStable.length).toBeGreaterThan(0);
    for (const id of REQUIRED_UNSTABLE) {
      expect(declaration.notStable, `${id} must be declared not stable`).toContain(id);
    }
    // And none of the ids may collide with a name in a stable tier, which would be a category
    // error rather than a small mistake.
    const names = new Set([...declaration.stable, ...declaration.internal]);
    expect(declaration.notStable.filter((id) => names.has(id))).toEqual([]);
  });

  it('agrees with the independent list in npm-surface.test.ts', () => {
    // Two files hold this list, because `scripts/npm-index.ts` is outside every tsconfig and the
    // doc has to be readable without running anything. Two declarations is a hazard; comparing
    // them is cheaper than merging them across a boundary this lane may not move.
    const source = readFileSync(SURFACE_TEST_PATH, 'utf8');
    expect(arrayLiteral(source, 'STABLE')?.sort(), 'npm-surface.test.ts STABLE').toEqual([...declaration.stable].sort());
    expect(arrayLiteral(source, 'INTERNAL')?.sort(), 'npm-surface.test.ts INTERNAL').toEqual(
      [...declaration.internal].sort(),
    );
  });

  it('is still a small fraction of the internal barrel', () => {
    // The boundary STABILITY.md S2.1 rests on: a stable set widened into "whatever the barrel
    // exports" is a contract that has stopped being one, and it would satisfy every other
    // assertion in this file. `stability-contract.test.ts` reads this as the whole engine; if the
    // engine ever shrinks to a dozen names this is the assertion that should be re-examined, and
    // the failure message is where the next lane will notice.
    const barrel = Object.keys(core).length;
    expect(declaration.stable.length * 5).toBeLessThan(barrel);
  });

  it("states the barrel's size the way the barrel actually is", () => {
    // S2.1 and S3.1 justify the whole tier boundary with two numbers — 32 modules, 517 names,
    // nine stable — and a number in prose rots silently. Checking the sentence's figures against
    // the file and the runtime is cheap, and the day someone curates the barrel into a
    // hand-written entry point this fails and points at the sentence that has become a lie.
    const markdown = readFileSync(DOC_PATH, 'utf8');
    const modules = (readFileSync(BARREL_PATH, 'utf8').match(/^export \* from /gm) ?? []).length;
    const names = Object.keys(core).length;
    expect(markdown, 'S3.1 quotes a module count').toContain(`${modules} \`export * from\` lines`);
    expect(markdown, 'S2.1 and S3.1 quote the barrel name count').toContain(`${names}\nnames`);
  });
});
