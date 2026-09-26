import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Drift guard: `scripts/npm-index.ts` is still inside `pnpm typecheck`.
 *
 * ## What went wrong
 *
 * `scripts/npm-index.ts` is the published library entry — the one file an npm consumer
 * imports — and no package tsconfig includes it. It was five lines when that was noticed
 * and 617 by the time anyone looked again, and `pnpm typecheck` never once saw any of it.
 * The gap is invisible from inside the repository: every other gate was green, because the
 * file simply was not in any of them.
 *
 * ## Why a test and not just a config
 *
 * A tsconfig is not self-enforcing. Narrow its `include`, delete its line from the root
 * `typecheck` script, or rename the file it names, and the gate is gone with a green build
 * and no diff to review — which is precisely the failure this guard exists to prevent. A
 * test is the only artefact in this repository that runs on every `pnpm test`, so the
 * assertion lives here.
 *
 * ## Why it lives in `packages/core/test`
 *
 * Same accident as `npm-surface.test.ts`, and for the same reason: it is the only test
 * directory this task may write to, and the subject is the package root. The header of
 * that file says the same thing; the two are one guard split across what each tool can see.
 *
 * ## Why the assertions are shaped the way they are
 *
 * Nothing here hardcodes a path to the config. The project file is *parsed out of the root
 * `typecheck` script*, so renaming it, pointing it elsewhere, or dropping it all produce a
 * different program — and a different program that still compiles the entry passes, while
 * one that does not fails. The paths that are pinned are the entry's own, and the failure
 * messages name the config they actually ran, so an editing mistake reads as an editing
 * mistake rather than as a mysterious failure to find a file.
 *
 * ## What the config's own `include` has to carry, and why
 *
 * The entry imports `packages/{core,mcp,script}/src` by relative path, so those files are
 * pulled in transitively and are typechecked as a side effect — which is correct, because
 * that is what esbuild bundles. What a transitive import cannot bring is an *ambient*
 * declaration: the hand-written typings for `gifenc` in core are invisible unless that file
 * is a program root, and without it every `gifenc` import degrades to an untyped `any`.
 * That is why the config roots the `.d.ts` files under each package's `src` and not the
 * sources, whose coverage belongs to the per-package configs. No other file is named in it:
 * a root `tsconfig.json` is discoverable but hijacks an editor's project inference for the
 * whole repository, so a dedicated, explicitly named project referenced from the root
 * `typecheck` script is the narrower choice — and it follows the precedent `packages/app`
 * already sets by running two configs from one `typecheck` script.
 *
 * ## The deliberate error
 *
 * The interesting half is that the gate *fires*. A config can list a file and still check
 * nothing — `noCheck`, a `files` list the compiler ignores, a project that is never built —
 * and the standing rule in this repository is that a gate nobody has seen fail is a gate
 * nobody knows works. So a probe carrying a real type error is written next to the entry,
 * `tsc` is run over the wired project, and the run is required to fail *and* to name the
 * probe. The probe carries no export and is imported by nothing, so it cannot disturb the
 * other tests in this suite; it is untracked, so a run killed mid-write cannot commit it;
 * and it is deleted at the start of every run as well as at the end, so a leftover heals
 * itself instead of failing the build forever.
 */

// `packages/core/test/` -> `packages/core/` -> `packages/` -> repo root. Three levels: a path
// that resolves to the wrong directory has to fail here, not quietly find nothing.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ENTRY = fileURLToPath(new URL('../../../scripts/npm-index.ts', import.meta.url));
const TYPECHECK_SCRIPT = (
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
).scripts.typecheck;

/**
 * The `tsc -p <file>` project the root `typecheck` script runs.
 *
 * The root script is the only thing that makes the coverage real, so it is the thing under
 * test. Reading it rather than assuming a filename is what lets the config be renamed
 * without this guard becoming a lie. Throws rather than returning an empty list: a caller
 * that went on to run `tsc` against nothing would report a confusing second failure, and a
 * guard that cannot find its subject must say so once, clearly.
 */
function wiredProject(): string {
  const projects = [...TYPECHECK_SCRIPT.matchAll(/(?:^|\s)-p\s+(\S+)/g)].map((match) => match[1]);
  if (projects.length !== 1) {
    throw new Error(
      `expected exactly one "tsc -p <file>" in the root typecheck script, found ${projects.length} ` +
        `in: ${TYPECHECK_SCRIPT}`,
    );
  }
  return projects[0];
}

/** The real `tsc`, resolved from the repository's own devDependency rather than from PATH. */
function tscBin(): string {
  const manifest = require.resolve('typescript/package.json', { paths: [ROOT] });
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as { bin: Record<string, string> };
  return resolve(dirname(manifest), bin.tsc);
}

function tsc(args: string[]): { status: number | null; output: string } {
  const run = spawnSync(process.execPath, [tscBin(), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    // The program spans every package's source, so `--listFiles` alone is a few hundred
    // paths. Anything near this ceiling should be a loud failure, not a truncated list that
    // makes a missing file look absent.
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

/**
 * Compare paths the way the platform does, so a slash or drive-letter difference is not a
 * failure. Total, not partial: it is handed every line of a compiler log, most of which are
 * not paths at all, so it must answer `false` for those instead of throwing.
 */
function isSamePath(a: string, b: string): boolean {
  const forward = (path: string) => resolve(path).split('\\').join('/');
  const left = forward(a);
  const right = forward(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Every `tsc` diagnostic that points at a given file, as `file(line,col): error TSxxxx`. */
function diagnosticsIn(output: string, file: string): string[] {
  const needle = file.split(/[/\\]/).join('[/\\\\]');
  return output.split(/\r?\n/).filter((line) => new RegExp(`^${needle}\\(\\d+,\\d+\\): error TS`).test(line.trim()));
}

const PROBE = join(dirname(ENTRY), 'typecheck-probe.ts');

/**
 * The probe: a real type error, and nothing else.
 *
 * No import and no export, so it is invisible to the runtime assertions in
 * `npm-surface.test.ts` and to the "never imports a filesystem module" guard, whichever
 * order the two files happen to run in. The error is on one line and the message is
 * self-describing, because the realistic way to meet this file is to find it after an
 * interrupted run and need to know what it is.
 */
const PROBE_SOURCE = [
  '/* Written by packages/core/test/npm-entry-typecheck.test.ts to prove the gate fires. */',
  'const deliberateTypeError: string = 1;',
  'void deliberateTypeError;',
  '',
].join('\n');

describe('the published library entry is inside `pnpm typecheck`', () => {
  it('is a project the root typecheck script runs, and that project exists', () => {
    const config = resolve(ROOT, wiredProject());
    expect(
      existsSync(config),
      `the root typecheck script names ${relative(ROOT, config)}, which does not exist`,
    ).toBe(true);
  });

  it('is a root file of that project, so the project compiles it', () => {
    const project = wiredProject();
    const shown = tsc(['-p', project, '--showConfig']);
    expect(shown.status, `${project} --showConfig failed:\n${shown.output}`).toBe(0);
    const { files } = JSON.parse(shown.output) as { files: string[] };
    // A root file, not a transitive import: being pulled in by some other module would mean
    // the config could stop listing it and stay green, which is the regression being guarded.
    expect(
      files.filter((file) => isSamePath(resolve(ROOT, file), ENTRY)),
      `${project} does not list scripts/npm-index.ts as a root file. Its roots are: ${files.join(', ')}`,
    ).not.toHaveLength(0);
  });

  it('is in the compiled program, and that program is clean today', () => {
    const project = wiredProject();
    const run = tsc(['-p', project, '--noEmit', '--listFiles']);
    expect(run.status, `${project} does not typecheck clean:\n${run.output}`).toBe(0);
    expect(
      run.output.split(/\r?\n/).some((line) => line.trim().length > 0 && isSamePath(line.trim(), ENTRY)),
      `${project} --listFiles does not contain scripts/npm-index.ts, so nothing compiled it. Files:\n${run.output}`,
    ).toBe(true);
  });

  it('fails that project on a deliberate type error beside the entry', () => {
    const project = wiredProject();
    const probeName = relative(ROOT, PROBE);
    // Cleared before the write as well as after it, so an interrupted run heals on the next
    // one instead of leaving a permanent red build. Untracked, so it is never committed.
    rmSync(PROBE, { force: true });
    try {
      writeFileSync(PROBE, PROBE_SOURCE);
      const broken = tsc(['-p', project, '--noEmit', '--listFiles']);
      const blamed = diagnosticsIn(broken.output, probeName);
      expect(
        blamed,
        `${project} compiled ${probeName} and still exited ${broken.status}, so a type error in it ` +
          `is not reported and the gate is decorative.\n${broken.output}`,
      ).not.toHaveLength(0);
      expect(broken.status, `${project} exited 0 despite ${blamed[0]}`).not.toBe(0);
      // The entry is still in the same program while the probe fails: the probe is an extra
      // root, not a substitute for one. Without this, a config that had dropped the entry
      // and picked up whatever else is in the directory would pass the line above.
      expect(
        broken.output.split(/\r?\n/).some((line) => line.trim().length > 0 && isSamePath(line.trim(), ENTRY)),
        `${project} stopped compiling scripts/npm-index.ts as soon as the probe appeared`,
      ).toBe(true);
    } finally {
      rmSync(PROBE, { force: true });
    }
    // And the gate is green again, so the probe was the only thing wrong.
    const clean = tsc(['-p', project, '--noEmit']);
    expect(clean.status, `${project} did not recover once the probe was removed:\n${clean.output}`).toBe(0);
  });
});
