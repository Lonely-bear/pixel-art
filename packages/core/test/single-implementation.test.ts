import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The 1.0 stabilisation guards: **exactly one implementation of each of three things**.
 *
 * Three duplications were collapsed onto core, and each was reported by the lane that created it:
 *
 *   1. `renderAssetOutputs` (`packages/mcp/src/tools.ts`) and `renderAssetOutput`
 *      (`packages/core/src/commands/share.ts`) both built a bundle's `meta.json` and ran an
 *      engine importer over it. Now `renderAssetBundle` (`packages/core/src/asset/bundle.ts`).
 *   2. `indexIssues` (`packages/mcp/src/quality-report.ts`) and `projectIssues`/`judge`
 *      (`packages/core/src/commands/share.ts`) both walked a report into a deduplicated issue
 *      list. Now `projectIssues` (`packages/core/src/quality/projections.ts`).
 *   3. `animationPreviewPayload` (`packages/mcp/src/tools.ts`, ~90 lines, private) was the only
 *      contact-sheet renderer, which is why `share_bundle` refused a `contact` output **by name**.
 *      Now `renderAnimationPreview` (`packages/core/src/preview/animation.ts`).
 *
 * ## Why these assertions read source text
 *
 * The alternative - asserting that two surfaces produce the same bytes - is the test that was
 * already implicitly available and did not catch any of the three, because each pair *did* agree
 * at the moment the duplication was found. What these guards assert is the thing that had drifted:
 * **there is only one place that can be wrong.** A behavioural equality test would keep passing if
 * somebody reintroduced the second copy tomorrow and happened to keep it in step; a source guard
 * goes red the moment the copy exists, which is the failure the task is about.
 *
 * That makes them source guards rather than behaviour tests, and it is deliberate: they are the
 * only kind of assertion that can fire on *duplication*, since duplication is a fact about the
 * repository and not about any document. Each one is written so that re-adding the duplicate
 * fails it - verified by doing exactly that, not by asserting it in prose here.
 *
 * Paths resolve from `import.meta.url`, so this runs identically from `packages/core` and from a
 * built tarball's consumer, and nothing here depends on a `dist/` being present.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = resolve(HERE, '..', '..');

const MCP_TOOLS = join(PACKAGES, 'mcp', 'src', 'tools.ts');
const MCP_QUALITY = join(PACKAGES, 'mcp', 'src', 'quality-report.ts');
const SHARE = join(PACKAGES, 'core', 'src', 'commands', 'share.ts');
const CORE_SRC = join(PACKAGES, 'core', 'src');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * A file with its comments removed.
 *
 * The absence checks run against **code**, not prose, because a guard that trips on a sentence
 * explaining what was removed is a guard people delete. A comment may say `validateAssetNaming`;
 * only a call may not.
 */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Every `.ts` file under a directory, recursively. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** Repo-relative with forward slashes, so a Windows run does not fail a path assertion. */
function repoPath(path: string): string {
  return path.slice(PACKAGES.length + 1).split('\\').join('/');
}

/**
 * Where `name` is declared under `packages/core/src`, as `path:line`.
 *
 * Compared on the *file* alone, so a guard that fires says "there are two" and names the second
 * one. Line numbers are carried for the failure message only - they move whenever anything above
 * them does, and a test that breaks on an unrelated edit above it is a test people disable.
 */
function definitionsOf(name: string): string[] {
  const needle = new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, 'm');
  const found: string[] = [];
  for (const file of sources(CORE_SRC)) {
    const text = read(file);
    const at = text.search(needle);
    if (at !== -1) found.push(`${repoPath(file)}:${text.slice(0, at).split('\n').length}`);
  }
  return found;
}

/** The declared files, without the line numbers, for an equality that is about *where*. */
function declaredIn(name: string): string[] {
  return definitionsOf(name).map((entry) => entry.split(':')[0]);
}

/** Every file in the repo that would have to be changed to reintroduce each duplicate. */
describe('the asset contract has one renderer', () => {
  it('declares `renderAssetBundle` exactly once in core', () => {
    expect(declaredIn('renderAssetBundle')).toEqual(['core/src/asset/bundle.ts']);
  });

  it('has `finalize_document` delegate instead of building a contract of its own', () => {
    // `buildAssetMeta` is the step that starts the pipeline. Two callers reaching for it directly
    // means two contracts built by two code paths, which is the duplication this file exists to
    // make impossible - and it is checkable without running anything, because the call is the thing.
    const tools = code(MCP_TOOLS);
    expect(tools, 'packages/mcp/src/tools.ts must not call buildAssetMeta').not.toContain('buildAssetMeta');
    expect(tools).toContain('renderAssetBundle(');
    // The importer table went with it: four engines listed in two places is four ways for the two
    // lists to disagree about which engines exist.
    expect(tools, 'the importer table is core’s now').not.toContain('ENGINE_IMPORTERS');
  });

  it('has `share_bundle` delegate too, and stop duplicating the dimension list while it is here', () => {
    const share = code(SHARE);
    expect(share, 'packages/core/src/commands/share.ts must not call buildAssetMeta').not.toContain('buildAssetMeta');
    expect(share).not.toContain('validateAssetNaming');
    expect(share).toContain('renderAssetBundle(');
    // The dimension set was a hand-copied array of six ids beside the aggregator's own list. A new
    // dimension would have been silently absent from every share card.
    expect(share).toContain('const DIMENSIONS: readonly QualityDimensionId[] = QUALITY_DIMENSIONS;');
  });
});

describe('a report is projected once', () => {
  it('declares `projectIssues` and `projectAbsences` exactly once in core', () => {
    expect(declaredIn('projectIssues')).toEqual(['core/src/quality/projections.ts']);
    expect(declaredIn('projectAbsences')).toEqual(['core/src/quality/projections.ts']);
  });

  it('has the MCP report call it, with no deduplication map of its own', () => {
    const quality = code(MCP_QUALITY);
    expect(quality).toContain('projectIssues(report, aggregatorIssues(context))');
    expect(quality).toContain('projectAbsences(report)');
    // `indexIssues` was the whole duplicate: its own `(code, rect)` map, its own sort, its own
    // `isBlocking` call. None of those may survive here.
    expect(quality, 'indexIssues must be gone').not.toContain('indexIssues');
    expect(quality, 'no second dedup key').not.toContain('rectKey');
    expect(quality, 'no second blocking threshold').not.toContain('isBlocking');
  });

  it('has the share card call it, with no deduplication map of its own either', () => {
    const share = code(SHARE);
    expect(share).toContain('projectIssues(report, aggregatorIssues(context))');
    expect(share).toContain('projectAbsences(report)');
    expect(share, 'no second dedup key').not.toContain('byKey');
    expect(share, 'no second blocking threshold').not.toContain('isBlocking');
  });
});

describe('the contact sheet is rendered once', () => {
  it('declares `renderAnimationPreview` exactly once in core', () => {
    expect(declaredIn('renderAnimationPreview')).toEqual(['core/src/preview/animation.ts']);
  });

  it('leaves the MCP tool a wrapper and no renderer', () => {
    // The payload builder stays in `tools.ts` because it returns MCP `ContentBlock`s, which core
    // cannot name. What must not survive is the *rendering*: the compositor, the onion skin and
    // the sizing helpers, because those are what two renderers would disagree about.
    const tools = code(MCP_TOOLS);
    expect(tools).toContain('renderAnimationPreview(sprite, options)');
    expect(tools, 'no second onion-skin compositor').not.toContain('blendAnimationFrame');
    expect(tools, 'the safety limit is core’s now').not.toContain('MAX_PREVIEW_OUTPUT_PIXELS');
    expect(tools, 'no second sprite-sized sheet').not.toContain('const sheet = new PixelBuffer(');
  });

  it('lets a share template ask for a contact sheet at all', () => {
    // The reason this collapse mattered: a `contact` output was **refused by name** because the
    // only implementation of one was private to the MCP layer. If core ever loses the renderer,
    // this is the sentence that has to go back, and it should not be able to go quietly.
    const share = read(SHARE);
    expect(code(SHARE)).toContain("z.literal('contact')");
    expect(share).toContain('renderAnimationPreview(sprite, {');
    expect(share, 'the old refusal sentence must not come back').not.toContain(
      'is not available here and asking for one is a',
    );
  });
});