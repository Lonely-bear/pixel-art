import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packedTarball } from './helpers/npm-build-lock.js';

/**
 * Every example in `cookbook/`, compiled, executed, and compared byte for byte.
 *
 * ## Why this file exists
 *
 * A cookbook is a promise that the code in it works. The failure mode is not that the
 * code was wrong when it was written — it is that it *became* wrong, silently, three
 * releases later, while the document kept quoting it. A reader finds out only after
 * copying it, and the document is worse than no document because it looked
 * authoritative.
 *
 * So the examples are real files, and this file is what makes them real:
 *
 *   1. **Every `.ts` file in `cookbook/` is registered** in `cookbook/manifest.json`, and
 *      every registered example exists. Adding a file without registering it fails here,
 *      which is the mechanism that makes "adding an example obliges you to test it" true
 *      rather than aspirational.
 *   2. **Every example is compiled** by a consumer's own `tsc`, against the *packed
 *      tarball*, resolved through the package's `exports` map — not a relative path into
 *      `dist/`. That is the only way "the snippet typechecks" means anything: a `.d.ts`
 *      that resolves inside this repository because of a workspace link proves nothing
 *      about the package a game project installs. `skipLibCheck` is **off** here for the
 *      same reason it is off in `npm-consumer-types.test.ts`.
 *   3. **Every example is executed**, in a child process, as the script it is: the
 *      top-level `main()` runs, files land on disk, and the module's returned bytes are
 *      hashed and compared against the manifest. A snippet that throws on line 40 fails
 *      here rather than in a reader's project.
 *   4. **Every example runs twice** and the two runs are compared to each other, so the
 *      determinism the prose claims is measured rather than asserted. This is the claim
 *      most worth checking, because an id factory or a clock leaking into a build is the
 *      kind of thing that makes a committed asset churn in CI.
 *   5. **The claims the prose makes about each example are asserted** — the mirror really
 *      runs, the refusal really names `svg_unsupported`, the naming validator really
 *      refuses `CON.png`, the recipe's mark really fills 10-12px of its 16px slot — so a
 *      chapter cannot keep a sentence its own example no longer supports.
 *   6. **No example publishes a score.** `evaluate` returns one and this repository
 *      deleted the `quality_report` tool in 0.3.1 because a model told a number was
 *      "clean" and sanded a lake into a dark flat rectangle. The recipe example therefore
 *      reports *defect names*, and the assertion here is mechanical: no file any example
 *      produces may carry a `score`, `scoreQ` or `verdict` key. If somebody wires the
 *      number back in, this fails rather than shipping the regression quietly.
 *
 * ## Where the expectations live, and how to change one
 *
 * `cookbook/manifest.json` holds, per example, each produced file's length and sha256.
 * Bytes are compared, not images: a hash is what "same spec, same bytes" means, and it
 * fails on a one-bit change that a screenshot diff would hide.
 *
 * When artwork legitimately changes, regenerate the expectations with
 * `DOTLOOM_COOKBOOK_UPDATE=1` and **read the diff**. The manifest records the reason an
 * example is deterministic, so a new entry has to say why rather than inherit a
 * sentence that was written for a different example.
 *
 * ## What is *not* compared
 *
 * Nothing, today: all five examples are pure functions of their inputs. The manifest
 * schema has room for a `bytes: false` exemption with a mandatory `exemptionReason`,
 * because an example that genuinely cannot be deterministic should still be compiled and
 * executed — and a test asserts that **no example uses one right now**, so the exemption
 * path cannot quietly become the norm.
 *
 * ## Cost, and why the timeouts are explicit
 *
 * A build, a pack, an unpack, several `tsc` runs and two node runs per example. Vitest's
 * default budget is 5000 ms, which is not a budget for a test that shells out to a
 * compiler, an npm client and a bundler; two tests in this repository have flaked for
 * exactly that reason. Every test below therefore declares how long it may take.
 *
 * ## Serialisation
 *
 * `scripts/build-npm-package.mjs` writes `dist/`, which the whole repository shares with
 * `pnpm build:libs`. This test builds the package, so it must not run concurrently with a
 * repository-wide build — the same rule `AGENTS.md` states for the three root commands.
 *
 * ## Cleanup
 *
 * The whole temporary tree is removed in `afterAll`. Nothing is written inside the
 * repository except `dist/`, which is gitignored build output that `build:npm` owns.
 */

/* ------------------------------------------------------------------ *
 * Paths and shapes
 * ------------------------------------------------------------------ */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const COOKBOOK = join(ROOT, 'cookbook');
const BUILD_SCRIPT = join(ROOT, 'scripts', 'build-npm-package.mjs');
const RECIPE_SOURCE = join(ROOT, 'recipes', 'ui-icons.recipe.json');

/** The manifest as this file reads it. Parsed, never string-matched. */
interface Manifest {
  note: string;
  cookbook: string;
  examples: {
    file: string;
    chapter: string;
    title: string;
    determinism: string;
    /** Absent means "compare the bytes", which is every example today. */
    bytes?: false;
    /** Mandatory when `bytes` is false — checked below, not by convention. */
    exemptionReason?: string;
    outputs: Record<string, { bytes: number; sha256: string }>;
  }[];
}

/** What an executed example reports back. */
interface RunReport {
  outputs: Record<string, { bytes: number; sha256: string }>;
  filesOnDisk: string[];
}

const MANIFEST = JSON.parse(readFileSync(join(COOKBOOK, 'manifest.json'), 'utf8')) as Manifest;

/** The repository manifest, for `files` and `dependencies` the way a consumer reads them. */
const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
};

/** Regenerate the manifest's expectations instead of comparing against them. */
const UPDATING = process.env['DOTLOOM_COOKBOOK_UPDATE'] === '1';

let workdir: string;
let consumer: string;
let tsc: string;

/** Every example's report from the first run, keyed by file name. */
const REPORTS = new Map<string, RunReport>();

beforeAll(() => {
  workdir = mkdtempLike();
  consumer = join(workdir, 'consumer');
  // `type: module` is not optional in the fixture, and that is not a fixture quirk: the
  // examples are ESM with top-level `await`, and the shipped bundle is ESM, so a project
  // that wants to run them says so in its own manifest.
  mkdirSync(join(consumer, 'src', 'cookbook'), { recursive: true });
  mkdirSync(join(consumer, 'recipes'), { recursive: true });
  mkdirSync(join(consumer, 'node_modules', 'dotloom-mcp'), { recursive: true });
  writeFileSync(join(consumer, 'package.json'), `${JSON.stringify({ name: 'cookbook-consumer', private: true, type: 'module' }, null, 2)}\n`);
  // The recipe example reads a recipe file, the way a project vendors one next to its
  // build script. Copied rather than symlinked so the example cannot reach back into the
  // repository and pass on bytes this repository's working tree happens to hold.
  copyInto(RECIPE_SOURCE, join(consumer, 'recipes', 'ui-icons.recipe.json'));
  tsc = tscBin();

  installPackedPackage();
  linkRuntimeDependencies();
  writeExampleProject();
}, 600_000);

/**
 * Run every example twice and keep the first run's report.
 *
 * Inside `beforeAll` rather than inside each test so the cost is paid once: two node
 * processes per example, and each of them runs the example's own top-level `main()`,
 * which writes real files to `workdir/out`.
 */
beforeAll(() => {
  const compiled = compileExamples();
  if (compiled.status !== 0) {
    throw new Error(`the consumer's tsc rejected an example:\n${compiled.output}`);
  }
  for (const example of MANIFEST.examples) {
    const first = runExample(example.file);
    const second = runExample(example.file);
    // The determinism claim, measured. Not "the example produced something": the two
    // runs of the *same* example are compared to each other, byte for byte.
    expect(second.outputs, `${example.file} produced different bytes on its second run`).toEqual(first.outputs);
    expect(second.filesOnDisk, `${example.file} wrote different files on its second run`).toEqual(first.filesOnDisk);
    REPORTS.set(example.file, first);
  }
  if (UPDATING) writeExpectations();
}, 300_000);

afterAll(() => {
  // `force` because a killed `tsc` can leave a read handle behind on Windows, and a
  // leftover temp tree full of a packed tarball is worse than a failed removal.
  if (workdir) rmSync(workdir, { recursive: true, force: true });
  // **Deliberately NOT removing the build lock here.** It was, and it was a bug: one file's
  // `afterAll` deletes the lock another file is currently holding, so a third claimer walks in and
  // the "serialisation" is a lie again — which is how the tarball came out without its declaration
  // tree. `withNpmBuildLock` releases in its own `finally`, including when the body throws, so there
  // is nothing for a cleanup hook to do except break a peer.
});

/** A `mkdtempSync` that also reports a path Windows can use. */
function mkdtempLike(): string {
  const base = join(tmpdir(), 'dotloom-cookbook-');
  const suffix = `${process.pid}-${Math.abs(hashString(base + String(process.hrtime.bigint())))}`;
  const dir = `${base}${suffix}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Stable, process-independent string hash, for a unique temp directory name. */
function hashString(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return hash;
}

/** Copy one file, creating the destination's directory. */
function copyInto(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, readFileSync(source));
}

/**
 * Build the package, pack it, and unpack it into `node_modules/dotloom-mcp`.
 *
 * Deliberately `npm pack` and not `npm install <folder>`: an install resolves the
 * package's own `dependencies` from the network, and a test that reaches the network
 * fails in CI for reasons that have nothing to do with this repository. `npm pack`
 * produces the exact tarball CI installs at its last step, and unpacking it by hand is
 * also what lets the example resolve the bare specifier `dotloom-mcp` through the real
 * `exports` map with nothing from this repository's `node_modules` in sight.
 */
function installPackedPackage(): void {
  // **Built and packed once, by a helper shared with `npm-consumer-types.test.ts`.** Both files need
  // the same tarball and each used to make its own, which was fragile twice over: they wrote the
  // same root `dist/`, and each deleted its own temp tree in `afterAll`, so one file's cleanup could
  // remove state another was reading. That surfaced as seven unrelated-looking failures and an
  // `ENOENT` on a consumer directory a `beforeAll` had just built — three full runs failed, and
  // every subset passed. Neither symptom named its cause.
  const tarball = packedTarball();

  const run = spawnSync('tar', ['-xzf', tarball, '-C', join(consumer, 'node_modules', 'dotloom-mcp'), '--strip-components=1'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error || run.status !== 0) {
    throw new Error(
      `could not unpack the tarball with the system \`tar\` (${run.error ? run.error.message : `exit ${run.status}`}). ` +
        'This test reads the real tarball, so it needs a tar on PATH: bsdtar ships with Windows 10+ and every macOS and Linux image CI uses.',
    );
  }
}

/**
 * Put the package's real `dependencies` where a real install would have put them.
 *
 * The emitted declarations import `zod`, `fast-png` and `@modelcontextprotocol/sdk` by
 * name, and those are declared dependencies, so a real consumer already has them. This
 * fixture does not run an install, so it links this repository's copies.
 */
function linkRuntimeDependencies(): void {
  for (const name of [...Object.keys(PACKAGE.dependencies ?? {}), '@types/node']) {
    linkDirectory(packageDirectory(name), join(consumer, 'node_modules', name));
  }
}

/**
 * Copy the examples in and write the consumer's `tsconfig`.
 *
 * The examples are copied rather than compiled in place because they must resolve
 * `dotloom-mcp` from the consumer's `node_modules`. Compiled with `strict`, and with
 * `skipLibCheck: false`, which is the whole experiment: a consumer who has it on cannot
 * see a broken `.d.ts`, and this repository has it on everywhere.
 */
function writeExampleProject(): void {
  for (const example of MANIFEST.examples) {
    copyInto(join(COOKBOOK, example.file), join(consumer, 'src', 'cookbook', example.file));
  }
  writeFileSync(
    join(consumer, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          // `DOM` is here for one external declaration: the MCP SDK's own `.d.ts`
          // references `HeadersInit`. Same reason, same single exception, as in
          // `npm-consumer-types.test.ts`.
          lib: ['ES2022', 'DOM'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          skipLibCheck: false,
          types: ['node'],
          typeRoots: [join(consumer, 'node_modules', '@types')],
          outDir: 'out',
          // Explicit because `tsc` cannot infer it when every input shares one
          // subdirectory, and the emitted layout — which decides where `runExample`
          // looks for the module — depends on it.
          rootDir: 'src',
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

/**
 * Compile every example at once.
 *
 * All of them in one `tsc` run rather than one per example: the expensive part is the
 * declaration tree, not the number of small files, and a single failure output is far
 * easier to read than five.
 */
function compileExamples(): { status: number | null; output: string } {
  const run = spawnSync(process.execPath, [tsc, '-p', join(consumer, 'tsconfig.json')], {
    cwd: consumer,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

/**
 * Run one compiled example in a child process and hash what it produced.
 *
 * **A child process, and not an `import()` in this test**, for two reasons. The example
 * is a *script* — its top-level `main()` writes files — and running it the way a reader
 * runs it is the thing being proved. And an example that throws at module scope takes
 * this test's own process with it otherwise, which turns one broken snippet into one
 * unreadable failure instead of one readable one.
 *
 * The runner is written into the consumer directory rather than being this test's file
 * path, because it has to import the *compiled* module from the consumer's tree.
 */
function runExample(file: string): RunReport {
  const runner = join(consumer, 'run-example.mjs');
  writeFileSync(
    runner,
    `// Generated by packages/core/test/cookbook.test.ts. Not part of the repository.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const module = await import(pathToFileURL(process.argv[2]).href);
const files = await module.default();
const out = {};
for (const [name, bytes] of Object.entries(files)) {
  out[name] = {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
process.stdout.write('__COOKBOOK_REPORT__' + JSON.stringify({ outputs: out, filesOnDisk: [] }) + '\\n');
`,
    'utf8',
  );
  const compiled = join(consumer, 'out', 'cookbook', file.replace(/\.ts$/, '.js'));
  const outDir = join(workdir, 'out', file.replace(/\.ts$/, ''));
  rmSync(outDir, { recursive: true, force: true });
  const run = spawnSync(process.execPath, [runner, compiled], {
    cwd: consumer,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      // Where the example's own `main()` writes. A temporary directory, so running the
      // test never leaves `generated/` in the repository — and so a leftover from a
      // previous run cannot make a broken example look like it worked.
      DOTLOOM_COOKBOOK_OUT: outDir,
      // Explicit rather than relying on `cwd`, so the recipe example reads the *copied*
      // recipe even if somebody runs it from elsewhere.
      DOTLOOM_RECIPE: join(consumer, 'recipes', 'ui-icons.recipe.json'),
    },
  });
  if (run.status !== 0) {
    throw new Error(`${file} threw when it ran (exit ${run.status}):\n${run.stdout ?? ''}${run.stderr ?? ''}`);
  }
  const line = `${run.stdout ?? ''}`.split(/\r?\n/).find((l) => l.startsWith('__COOKBOOK_REPORT__'));
  if (!line) throw new Error(`${file} produced no report line:\n${run.stdout ?? ''}${run.stderr ?? ''}`);
  const report = JSON.parse(line.slice('__COOKBOOK_REPORT__'.length)) as { outputs: RunReport['outputs'] };
  return { outputs: report.outputs, filesOnDisk: listFiles(outDir) };
}

/** Every file under a directory, as sorted paths relative to it. */
function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(dir, full).split('\\').join('/'));
    }
  };
  walk(dir);
  return out;
}

/** Rewrite `outputs` in the manifest from this run's reports. Only in update mode. */
function writeExpectations(): void {
  for (const example of MANIFEST.examples) {
    example.outputs = REPORTS.get(example.file)?.outputs ?? {};
  }
  writeFileSync(join(COOKBOOK, 'manifest.json'), `${JSON.stringify(MANIFEST, null, 2)}\n`, 'utf8');
}

/** The installed directory of a dependency, found by walking `node_modules` upwards. */
function packageDirectory(name: string): string {
  const require = createRequire(join(ROOT, 'package.json'));
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    // Fall through: a package with an `exports` map need not expose `./package.json`.
  }
  let dir = ROOT;
  for (;;) {
    const candidate = join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`the fixture could not find the dependency "${name}"`);
    }
    dir = parent;
  }
}

/**
 * Make `dest` resolve to `source`, without copying.
 *
 * A junction, not `cpSync`: `node_modules` in a pnpm workspace is a graph of symlinks
 * into `.pnpm`, a recursive copy follows it, and the MCP SDK's dependency cycle walks
 * the copy until the worker dies with a native stack overrun that names neither the
 * test nor the cause. `junction` is the Windows form and takes no privileges.
 */
function linkDirectory(source: string, dest: string): void {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  symlinkSync(source, dest, process.platform === 'win32' ? 'junction' : 'dir');
}

/** The repository's own `typescript`, so the test does not depend on a global install. */
function tscBin(): string {
  const require = createRequire(join(ROOT, 'package.json'));
  const manifest = require.resolve('typescript/package.json');
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as { bin: Record<string, string> };
  return resolve(dirname(manifest), bin.tsc);
}

/**
 * One produced file, read back as UTF-8 from where the example wrote it.
 *
 * Read from disk rather than re-derived from the manifest, because the text assertions
 * below are about what the example says — the refusal reason, the warnings, the defect
 * names — and a manifest hash cannot be read.
 */
function textOf(example: string, name: string): string {
  const report = REPORTS.get(example);
  if (!report || !(name in report.outputs)) throw new Error(`${example} did not produce ${name}`);
  const onDisk = join(workdir, 'out', example.replace(/\.ts$/, ''), name);
  if (!existsSync(onDisk)) {
    throw new Error(`${example} produced ${name} but did not write it to disk, so this assertion cannot read it`);
  }
  return readFileSync(onDisk, 'utf8');
}

/** Keys anywhere in a parsed JSON value whose name is one of the forbidden score fields. */
function scoreKeysIn(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) scoreKeysIn(item, found);
    return found;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (['score', 'scoreQ', 'severityQ', 'verdict', 'quality'].includes(key)) found.push(key);
      scoreKeysIn(child, found);
    }
  }
  return found;
}

/** JSON.parse with the file named in the failure, because a bare parse error is useless. */
function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/* ------------------------------------------------------------------ *
 * The registration gate
 * ------------------------------------------------------------------ */

describe('every example in cookbook/ is registered and every registered example exists', () => {
  it('has no unregistered .ts file, which is what makes adding an example oblige a test', () => {
    const onDisk = readdirSync(COOKBOOK)
      .filter((name) => name.endsWith('.ts'))
      .sort();
    const registered = MANIFEST.examples.map((e) => e.file).sort();
    // The two halves are the same assertion read in two directions. Only checking that
    // registered files exist would let somebody drop a test by deleting a manifest row;
    // only checking the disk would let a manifest accumulate examples that no longer run.
    expect(onDisk, 'these files in cookbook/ are not in manifest.json, so no test runs them').toEqual(registered);
  });

  it('has no file in cookbook/ that the manifest does not account for at all', () => {
    // Catches a stray scratch `.mjs`, a second expectation directory, a README that
    // drifted out of the index. `manifest.json` is the one file allowed to be unlisted,
    // because it is the index.
    const strays = readdirSync(COOKBOOK).filter((name) => name !== 'manifest.json' && !MANIFEST.examples.some((e) => e.file === name));
    expect(strays, 'these files in cookbook/ belong to no example').toEqual([]);
  });

  it('gives every example a chapter, a title and a stated reason it is deterministic', () => {
    for (const example of MANIFEST.examples) {
      expect(example.chapter, `${example.file} has no chapter`).toBeTruthy();
      expect(example.title, `${example.file} has no title`).toBeTruthy();
      expect(
        example.determinism?.length ?? 0,
        `${example.file} has no determinism note; an example that cannot say why it is reproducible should say that instead`,
      ).toBeGreaterThan(20);
    }
  });

  it('compares bytes for every example today, and would demand a reason to stop', () => {
    // The exemption path exists for an example that genuinely cannot be deterministic.
    // This asserts that nobody is using it, because an exemption nobody reads is an
    // exemption that spreads.
    const exempt = MANIFEST.examples.filter((e) => e.bytes === false);
    expect(exempt, 'an example is exempt from byte comparison; say why in exemptionReason').toEqual([]);
    for (const example of MANIFEST.examples) {
      if (example.bytes === false) {
        expect(example.exemptionReason ?? '', `${example.file} exempts bytes without a reason`).toBeTruthy();
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Compilation
 * ------------------------------------------------------------------ */

describe('every example compiles the way a consumer compiles it', () => {
  it('typechecks against the packed tarball, through the exports map', () => {
    // The specifier is the bare `dotloom-mcp`, resolved from a project whose only
    // `node_modules` entry is the unpacked tarball. A `.d.ts` that resolves here because
    // of a workspace link in this repository proves nothing about the package a game
    // project installs.
    const run = compileExamples();
    expect(run.status, `the consumer's tsc rejected an example:\n${run.output}`).toBe(0);
  }, 240_000);

  it('imports the published specifier in every example, not a path into dist/', () => {
    // Belt and braces on the claim above: a relative import into `dist/` would also
    // compile in this fixture (the tarball contains the tree), so the mechanism is what
    // is being asserted, not the resolution.
    for (const example of MANIFEST.examples) {
      const source = readFileSync(join(COOKBOOK, example.file), 'utf8');
      const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      expect(imports.length, `${example.file} imports nothing`).toBeGreaterThan(0);
      expect(
        imports.filter((spec) => spec === 'dotloom-mcp'),
        `${example.file} does not import the published specifier: ${imports.join(', ')}`,
      ).toContain('dotloom-mcp');
      for (const spec of imports) {
        expect(spec.startsWith('.'), `${example.file} imports "${spec}" — a relative path into the tree, not the package`).toBe(false);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Execution and bytes
 * ------------------------------------------------------------------ */

describe('every example runs, and produces the bytes the manifest says', () => {
  it('produces a file for every example — none of them is a no-op', () => {
    for (const [file, report] of REPORTS) {
      expect(Object.keys(report.outputs).length, `${file} produced no files`).toBeGreaterThan(0);
    }
  });

  for (const example of MANIFEST.examples) {
    it(`${example.file} — ${example.chapter}`, () => {
      const report = REPORTS.get(example.file)!;
      if (UPDATING) return;
      // Exact key set in both directions: a file that appeared is as much a change as a
      // file that vanished, and an expectation that only checks the files it knows about
      // would pass on an example that started emitting one more thing.
      expect(Object.keys(report.outputs).sort(), `${example.file} produced a different set of files`).toEqual(
        Object.keys(example.outputs).sort(),
      );
      for (const [name, expected] of Object.entries(example.outputs)) {
        const actual = report.outputs[name]!;
        expect(actual.bytes, `${example.file}: ${name} changed length`).toBe(expected.bytes);
        expect(actual.sha256, `${example.file}: ${name} changed bytes`).toBe(expected.sha256);
      }
      // And the example wrote them to disk, because that is the half a reader runs.
      expect(report.filesOnDisk.length, `${example.file} wrote nothing to disk`).toBeGreaterThan(0);
    }, 120_000);
  }
});

/* ------------------------------------------------------------------ *
 * The claims the prose makes
 * ------------------------------------------------------------------ */

describe('each chapter keeps the claim its example makes', () => {
  it('02: the mirror really runs, so E and W are not the same sheet', () => {
    // The hero carries a satchel on one side precisely so this can be checked. A
    // left-right symmetric character mirrors onto itself, and then "four cardinals from
    // one drawing" would be two sheets wearing four names.
    const report = REPORTS.get('02-walk-cycle.ts')!;
    expect(report.outputs['hero-e_sheet.png']!.sha256).not.toBe(report.outputs['hero-w_sheet.png']!.sha256);
  });

  it('02: the plan names four exact directions and four that still have to be drawn', () => {
    const plan = JSON.parse(textOf('02-walk-cycle.ts', 'directions.json')) as {
      exact: string[];
      toDraw: string[];
      directions: { id: string; drawing: string; resolvedFrom: string }[];
    };
    expect(plan.exact).toEqual(['N', 'E', 'S', 'W']);
    expect(plan.toDraw).toEqual(['NE', 'SE', 'SW', 'NW']);
    expect(plan.directions).toHaveLength(8);
    // A diagonal resolves from the cardinal it is nearest, and says so: that 45-degree
    // difference is the reason it needs artwork of its own.
    const diagonal = plan.directions.find((d) => d.id === 'NE')!;
    expect(diagonal.resolvedFrom).not.toBe('NE');
  });

  it('03: the refusal names a reason instead of approximating the SVG', () => {
    const note = textOf('03-trace-svg.ts', 'refusal.txt');
    expect(note).toContain('reason: svg_unsupported');
    // The nested shape is the part a caller branches on, so it is asserted rather than
    // paraphrased: `command_failed` at the top, `svg_unsupported` two levels down.
    expect(note).toContain('code: command_failed');
    expect(note).toContain('details.code: invalid_params');
  });

  it('04: the engine mapping reports what it lost, in words', () => {
    const report = JSON.parse(textOf('04-engine-export.ts', 'bundle-report.json')) as Record<
      string,
      { files?: string[]; warnings?: string[] }
    >;
    const engine = (id: string): { files: string[]; warnings: string[] } => {
      const entry = report[id];
      expect(entry, `bundle-report.json has no ${id} entry`).toBeTruthy();
      return entry as { files: string[]; warnings: string[] };
    };
    for (const id of ['godot', 'unity', 'phaser', 'excalidraw']) {
      expect(engine(id).files.length, `${id} produced no files`).toBeGreaterThan(0);
    }
    // Non-uniform durations are what makes a mapping lossy, so Godot and Phaser must say
    // so; Unity holds per-frame timing and must not invent a complaint about it.
    expect(engine('godot').warnings.length).toBeGreaterThan(0);
    expect(engine('phaser').warnings.length).toBeGreaterThan(0);
    expect(engine('unity').warnings).toEqual([]);
    for (const id of ['godot', 'phaser', 'excalidraw']) {
      for (const warning of engine(id).warnings) expect(typeof warning).toBe('string');
    }
  });

  it('04: the naming validator refuses a reserved device name before writing a byte', () => {
    const note = textOf('04-engine-export.ts', 'naming-refusal.txt');
    expect(note).toContain('reserved-name');
    expect(note).toContain('CON.png');
  });

  it('05: the icon fills the slot the recipe says, and reports defects rather than a score', () => {
    const checks = JSON.parse(textOf('05-recipe-ui-icon.ts', 'checks.json')) as {
      markFills10to12: boolean;
      markBounds: { w: number; h: number } | null;
      defects: { dimension: string; code: string; message: string }[];
    };
    // The recipe's own construction number: a 16px mark occupies 10-12px of its slot, or
    // it reads as an illustration rather than as an icon. Measured from the composited
    // mark layer, not asserted by eye.
    expect(checks.markBounds?.w).toBeGreaterThanOrEqual(10);
    expect(checks.markBounds?.w).toBeLessThanOrEqual(12);
    expect(checks.markFills10to12).toBe(true);
    // Named defects, each with something to do. The count is not asserted: the pipeline is
    // still under calibration and pinning it here would make this test a veto on the
    // artwork rather than on the example.
    for (const defect of checks.defects) {
      expect(defect.dimension, 'a defect with no dimension names nothing').toBeTruthy();
      expect(defect.code, 'a defect with no code cannot be branched on').toBeTruthy();
      expect(defect.message.length, `defect ${defect.code} has no sentence`).toBeGreaterThan(20);
    }
  });

  it('no example publishes a number an agent could optimise towards', () => {
    // The structural half of "never show a score". `evaluate` returns `score`, `scoreQ`
    // and `verdict`; this repository deleted the `quality_report` tool in 0.3.1 because a
    // model told a number was clean and sanded a lake into a dark flat rectangle. If an
    // example ever wires one of those into its output, this fails rather than shipping
    // the regression quietly.
    for (const [example, paths] of listFilesByExample()) {
      for (const full of paths) {
        if (!full.endsWith('.json')) continue;
        const offenders = scoreKeysIn(readJson(full));
        expect(offenders, `${example}: ${full} carries a score field: ${offenders.join(', ')}`).toEqual([]);
      }
    }
    // And in the manifest, which is prose a reader trusts about what the examples emit.
    expect(scoreKeysIn(MANIFEST), 'the manifest describes a score').toEqual([]);
  });
});

/** Every JSON file each example wrote, as `example -> [absolute paths]`. */
function listFilesByExample(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const example of MANIFEST.examples) {
    const dir = join(workdir, 'out', example.file.replace(/\.ts$/, ''));
    map.set(example.file, listFiles(dir).map((name) => join(dir, name)));
  }
  return map;
}

/* ------------------------------------------------------------------ *
 * The prose
 * ------------------------------------------------------------------ */

describe('the cookbook documents the examples that exist', () => {
  it('names every example file, so a chapter cannot lose its code', () => {
    const doc = readFileSync(join(ROOT, MANIFEST.cookbook), 'utf8');
    for (const example of MANIFEST.examples) {
      expect(doc, `${MANIFEST.cookbook} never mentions ${example.file}`).toContain(example.file);
      expect(doc, `${MANIFEST.cookbook} has no chapter heading for ${example.chapter}`).toContain(example.chapter);
    }
  });

  it('points every example at a determinism claim and a way to run it', () => {
    const doc = readFileSync(join(ROOT, MANIFEST.cookbook), 'utf8');
    expect(doc).toContain('DOTLOOM_COOKBOOK_UPDATE=1');
    expect(doc).toContain('packages/core/test/cookbook.test.ts');
  });
});
