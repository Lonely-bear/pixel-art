import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packedTarball } from './helpers/npm-build-lock.js';

/**
 * The published package, proved the way a consumer experiences it.
 *
 * ## Why this test exists and what it is not
 *
 * `npm-entry-typecheck.test.ts` proves `scripts/npm-index.ts` *compiles inside this repository*,
 * which is a real and necessary gate and is not the claim that was open. The open claim was:
 * **does a consumer get types?** `scripts/build-npm-package.mjs` had `entryPoints` and no
 * declaration emit, and the root `package.json` had no `types` and no `typings`, so
 * `import { buildSprite } from 'dotloom-mcp'` in a TypeScript project resolved to nothing at
 * all. Every in-repo gate was green while that was true, because the file simply was not on
 * the path a consumer takes.
 *
 * So this test does the consumer's thing: build the package the way `pnpm build:npm` does,
 * pack it with `npm pack`, install the tarball into a temporary project, and run `tsc` over a
 * small TypeScript file that imports from `'dotloom-mcp'`. Nothing from the repository's own
 * `node_modules` is visible to that project, so a `.d.ts` that resolves only because of a
 * workspace link fails here rather than on someone else's machine.
 *
 * ## Why `npm pack` and not `npm install <path>`
 *
 * `npm install <folder>` installs the folder and its dependencies, which reaches the network
 * for `zod`, `fast-png`, `@modelcontextprotocol/sdk` and friends. A test that reaches the
 * network is a test that fails in CI for reasons that have nothing to do with this repository.
 * `npm pack` produces the exact tarball CI already installs at its last step, and the fixture
 * copies it into `node_modules/` by hand — which is also what lets the test assert on the tarball's
 * *contents* (that the declarations are actually in it) rather than on a build directory.
 *
 * The remaining external imports in the emitted declarations (`zod`, `fast-png`,
 * `@modelcontextprotocol/sdk`) are real `dependencies` of the package, so a real consumer
 * already has them. The fixture links this repository's copies in, which stands in for that:
 * what is being tested is the *package's own* specifiers resolving, not npm's resolver.
 *
 * ## Why the wrong-call check is not optional
 *
 * A `.d.ts` that says `buildSprite(spec: any): any` typechecks perfectly. So would one that
 * says `export declare function buildSprite(): void`. "The consumer compiles" is therefore not
 * evidence of anything on its own, and this file proves the types are real by requiring that a
 * **wrong call is rejected with a named diagnostic** — which an `any` can never produce. The
 * two halves are the assertion: the good file compiles, and the bad one fails for the reason
 * it should.
 *
 * ## Why `API_VERSION` is asserted here as well as in `npm-surface.test.ts`
 *
 * Because the *consumer* is the party that pins it. `npm-surface.test.ts` pins the export
 * list from inside the repository, where a new export is one edit away; this pins that the
 * exported declaration carries the same string, so a version bump that reached the source but
 * not the shipped types would fail on a machine that never saw the source.
 *
 * ## Cost
 *
 * A build, a pack and several `tsc` runs. The timeouts below are explicit for that reason —
 * vitest's 5000 ms default is not a budget, and a test that shells out to a compiler and an
 * npm client declares how long that takes.
 *
 * ## Cleanup
 *
 * The whole temporary tree is removed in `afterAll`, and `beforeAll` removes any tree this
 * run's own `mkdtemp` would have reused. Nothing is written inside the repository: `dist/` is
 * gitignored build output that `build:npm` already owns, and `npm pack --pack-destination`
 * writes the tarball outside it.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BUILD_SCRIPT = join(ROOT, 'scripts', 'build-npm-package.mjs');

/** The manifest as a consumer reads it. Parsed, never string-matched, so `exports` can be walked. */
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  types?: string;
  exports?: Record<string, { types?: string; import?: string } | string>;
  files: string[];
  main?: string;
  dependencies?: Record<string, string>;
};

/** Where the tarball, the consumer project and its `node_modules` live. */
let workdir: string;
let tarball: string;
let consumer: string;

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), 'dotloom-consumer-'));
  // The tarball's path is derived *after* `workdir` exists, because `npm pack
  // --pack-destination` writes there and the name alone is not a path. Computed as a bare
  // name first it silently resolves against the repository root and the run reports a missing
  // tarball that is in fact sitting in a temp directory nobody looks in.
  consumer = join(workdir, 'consumer');
  mkdirSync(join(consumer, 'node_modules', 'dotloom-mcp'), { recursive: true });
  mkdirSync(join(consumer, 'src'), { recursive: true });

  // The built package, exactly as CI's last step sees it: `pnpm build:npm` then `npm pack`.
  //
  // **Built and packed once, by a helper shared with `cookbook.test.ts`.** Both files need the same
  // tarball and each used to make its own, which was fragile twice over: they wrote the same root
  // `dist/`, and each deleted its own temp tree in `afterAll`, so one file's cleanup could remove
  // state another was reading. That surfaced as seven unrelated-looking failures and an `ENOENT` on
  // a consumer directory a `beforeAll` had just built — three full runs failed, and every subset
  // passed. Neither symptom named its cause, which is why it took a bisect rather than a guess.
  tarball = packedTarball();
  installTarball();
  linkRuntimeDependencies();
}, 300_000);

afterAll(() => {
  // Removes the pack destination, the extracted package and the consumer project. `force`
  // because a killed `tsc` can leave a read handle behind on Windows, and a leftover temp
  // directory is worse than a failed removal.
  if (workdir) rmSync(workdir, { recursive: true, force: true });
  // **Deliberately NOT removing the build lock here.** It was, and it was a bug: this file's
  // `afterAll` deletes the lock `cookbook.test.ts` is currently holding, so a third claimer walks
  // straight in and the serialisation becomes a lie. `withNpmBuildLock` releases in its own
  // `finally`, including when the body throws, so a cleanup hook has nothing to do here except
  // break a peer.
});

/** The tarball's own name, from `name` and `version`. */
function packName(): string {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string; version: string };
  return `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`;
}

/**
 * Unpack the tarball into `node_modules/dotloom-mcp`, which is what an install does.
 *
 * `tar -xzf` with `--strip-components=1`, because an npm tarball is prefixed with a `package/`
 * directory that `node_modules/<name>` must not contain. Deliberately not `npm install`: see
 * this file's header — an install would resolve the package's own `dependencies` from the
 * network, and a test that reaches the network fails in CI for reasons that have nothing to do
 * with this repository.
 *
 * The system `tar` is used rather than a tar library because the tarball is the input, not the
 * subject: anything that reads it correctly is the same answer. A missing `tar` is reported by
 * name so the failure reads as a missing tool rather than as a corrupt package.
 */
function installTarball(): void {
  const target = join(consumer, 'node_modules', 'dotloom-mcp');
  const run = spawnSync('tar', ['-xzf', tarball, '-C', target, '--strip-components=1'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error || run.status !== 0) {
    throw new Error(
      `could not unpack ${relative(workdir, tarball)} with the system \`tar\` (${
        run.error ? run.error.message : `exit ${run.status}`
      }). This test reads the real tarball, so it needs a tar on PATH: bsdtar ships with ` +
        'Windows 10+ and every macOS and Linux image CI uses.',
    );
  }
}

/**
 * Put the package's real `dependencies` where a real `npm install` would have put them.
 *
 * The emitted declarations import `zod`, `fast-png` and `@modelcontextprotocol/sdk` by name,
 * because those are packages that genuinely ship their own types and genuinely are dependencies
 * of this one. A consumer has them; this fixture does not run an install, so it links this
 * repository's copies. A missing one is reported by name, because "Cannot find module 'zod'"
 * and "Cannot find module '@pixel/core'" are the same shape of error and opposite meanings —
 * the first is correct, the second is the bug this file exists to catch.
 */
function linkRuntimeDependencies(): void {
  for (const name of Object.keys(MANIFEST.dependencies ?? {})) {
    linkDirectory(packageDirectory(name), join(consumer, 'node_modules', name));
  }
}

/**
 * The installed directory of a dependency, found by walking `node_modules` upwards.
 *
 * **`require.resolve` is tried first and is not enough.** A package with an `exports` map —
 * `fast-png` has one — need not expose `./package.json`, and `require.resolve('fast-png/package.json')`
 * then fails for a package that is installed and working. Falling back to the directory walk
 * covers both shapes, and it is the same lookup a resolver does, so the fixture cannot succeed
 * where a real install would not.
 *
 * The search starts at the root and then walks up, because pnpm hoists to the workspace root's
 * `.pnpm` store and links from the root `node_modules`, while a nested dependency of a package
 * would only be findable from deeper down. Failing loudly with the name is deliberate: a
 * silently missing dependency turns into `Cannot find module 'zod'` in a diagnostic about the
 * *package*, which is a much harder thing to read.
 */
function packageDirectory(name: string): string {
  const require = createRequire(join(ROOT, 'package.json'));
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    // Fall through to the directory walk below.
  }
  let dir = ROOT;
  for (;;) {
    const candidate = join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `the fixture could not find the dependency "${name}". The consumer resolves dependencies by ` +
          'name, so it has to be installed somewhere reachable from the repository root.',
      );
    }
    dir = parent;
  }
}

/**
 * Make `dest` resolve to `source`, without copying it.
 *
 * **A junction, not a copy, and the reason is a hard crash.** `node_modules` in a pnpm
 * workspace is a graph of directory symlinks into `.pnpm`, and `cpSync(…, {recursive: true})`
 * follows them. Two of the packages here (`@modelcontextprotocol/sdk` and its own
 * dependencies) sit in a cycle that the copy walks without ever hitting its own visited set
 * under this repository's store layout, and the worker dies with
 * `0xC0000409` — a native stack buffer overrun that vitest reports only as "worker exited
 * unexpectedly", naming neither the test nor the cause. It is also a needless cost: these are
 * read-only inputs to a compiler, and a junction gives `tsc` the same view an install would.
 *
 * `junction` is the Windows form and takes no privileges; POSIX uses `dir`. Both are resolved
 * by `tsc`'s node resolution exactly as a real `node_modules` entry would be, which is the
 * only property this fixture depends on.
 */
function linkDirectory(source: string, dest: string): void {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  symlinkSync(source, dest, process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * The npm client, run as `node <npm-cli.js>` rather than as `npm` on the PATH.
 *
 * Two reasons, and both are about the test failing for reasons that have nothing to do with
 * this repository. `npm` on Windows is a `.cmd` shim, and `spawnSync` cannot execute one
 * without a shell — a shell brings in quoting, which brings in path-with-non-ASCII problems.
 * And a `.cmd` shim's location is per-installation, so a PATH lookup finds a *different* npm
 * than the one whose behaviour this test is reasoning about. `npm-cli.js` sits next to the
 * Node binary that is running the test, so this resolves to the same client every time.
 *
 * The fallback keeps the test running on an installation where npm lives elsewhere, and says
 * so in its own failure message rather than reporting an empty diagnostic.
 */
function npmCli(): string {
  const nextToNode = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(nextToNode)) return nextToNode;
  throw new Error(
    `could not find npm-cli.js next to ${process.execPath} (looked at ${nextToNode}). This test ` +
      'reads a real packed tarball, so it needs the npm client that ships with the Node running it.',
  );
}

/** The repository's own `typescript`, so the test does not depend on a globally installed one. */
function tscBin(): string {
  const require = createRequire(join(ROOT, 'package.json'));
  const manifest = require.resolve('typescript/package.json');
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as { bin: Record<string, string> };
  return resolve(dirname(manifest), bin.tsc);
}

/**
 * Compile one consumer file and return `tsc`'s exit status and combined output.
 *
 * `skipLibCheck` is **off**, and that is the whole experiment. A consumer who has it on cannot
 * see a broken `.d.ts`; the repository has it on everywhere, so shipping a declaration tree that
 * only typechecks under that setting would be invisible from inside. Turning it off here is what
 * turns "the consumer compiles" into a statement about the declarations rather than about the
 * consumer's `tsconfig`.
 */
function compile(files: Record<string, string>, extraArgs: string[] = []): { status: number | null; output: string } {
  const srcDir = join(consumer, 'src');
  rmSync(srcDir, { recursive: true, force: true });
  mkdirSync(srcDir, { recursive: true });
  const names: string[] = [];
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(srcDir, name), source, 'utf8');
    names.push(name);
  }
  writeFileSync(
    join(consumer, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          // `DOM` is here for one external declaration and one reason: the MCP SDK's own
          // `.d.ts` references `HeadersInit`, which is a DOM global, and without `DOM` in
          // `lib` that is `TS2304` *inside a package this repository does not own*. A consumer
          // reaching the `mcp` namespace in Node gets a `fetch`-shaped global from
          // `@types/node`'s `undici-types` in current versions, so this is a fixture gap rather
          // than a package defect — and it is the only DOM-typed thing in the whole emitted
          // tree. Recorded here rather than silenced with a `skipLibCheck`, because silencing it
          // would also hide a genuine declaration problem.
          lib: ['ES2022', 'DOM'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: ['node'],
          typeRoots: [join(consumer, 'node_modules', '@types')],
        },
        files: names.map((name) => join('src', name)),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  // `@types/node` is a devDependency here, and the consumer config asks for it by name, so the
  // fixture links it the same way it links the runtime dependencies. Without it every
  // `node:*` import in the emitted tree is unresolved, which is a *fixture* gap and not a
  // package defect — so it is installed rather than worked around.
  linkDirectory(packageDirectory('@types/node'), join(consumer, 'node_modules', '@types', 'node'));
  const run = spawnSync(process.execPath, [tscBin(), '-p', join(consumer, 'tsconfig.json'), ...extraArgs], {
    cwd: consumer,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

/* ------------------------------------------------------------------ *
 * The consumer file
 * ------------------------------------------------------------------ */

/**
 * The consumer's TypeScript, using every documented export of the stable surface.
 *
 * Written the way a real build script is written — narrow, named locals, no `any`, no casts —
 * because a file full of `as any` would compile against `any` declarations just as happily and
 * would prove nothing. Every line here also carries its expected type at the point of use, so
 * `tsc` checks the inference and not merely the existence of an export.
 */
const GOOD_CONSUMER = `
import {
  API_VERSION,
  VERSION,
  buildAnimation,
  buildSprite,
  buildWalkAnimation,
  exportAssets,
  exportEngineAssets,
  getDirectionModel,
  traceSvg,
  type AnimationSpec,
  type AssetFile,
  type DirectionId,
  type DirectionModel,
  type EngineExportResult,
  type ExportPlan,
  type Sprite,
  type SpriteSpec,
} from 'dotloom-mcp';

// The two version constants are strings, and are not the same string.
const api: string = API_VERSION;
const pkg: string = VERSION;

// \`buildSprite\` returns a \`Sprite\`, and a Sprite's canvas is two numbers.
const slime: Sprite = buildSprite({ seed: 7, width: 16, height: 16, name: 'slime' });
const w: number = slime.width;
const h: number = slime.height;
const layers: string[] = slime.layers.map((layer) => layer.name);

// A spec object is a value, so a build script can keep one in a module and reuse it.
const spec: SpriteSpec = { seed: 1, width: 8, height: 8, name: 'blob' };
const blob: Sprite = buildSprite(spec);
const animated: Sprite = buildAnimation({ ...spec, frames: 2, tags: [{ name: 'walk', from: 0, to: 1 }] } as AnimationSpec);

// \`exportAssets\` returns files, and a file's bytes are a \`Uint8Array\`.
const plan: ExportPlan = { sheet: true, gif: { scale: 4 } };
const files: AssetFile[] = exportAssets(animated, plan);
const firstPath: string = files[0].path;
const firstBytes: Uint8Array = files[0].bytes;
const firstKind: 'frame' | 'sheet' | 'sheet-json' | 'gif' | 'source' = files[0].kind;

// The 8-direction model: ids are the eight compass points, and the model is data.
const model: DirectionModel = getDirectionModel({ width: 32, height: 32 });
const exact: DirectionId[] = model.exact;
const directions: number = model.directions.length;

// A walk cycle is a Sprite like any other, so the same export path serves it.
const walk: Sprite = buildWalkAnimation({
  seed: 7, width: 32, height: 32, name: 'hero',
  layers: ['body', 'legL', 'legR'],
  direction: 'S',
  walk: { frames: 4, stride: 2 },
  ops: [
    { command: 'create_rig', params: { parts: [
      { name: 'body', pivot: { x: 16, y: 10 } },
      { name: 'legL', pivot: { x: 14, y: 20 }, parent: 'body' },
      { name: 'legR', pivot: { x: 18, y: 20 }, parent: 'body' },
    ] } },
    { command: 'draw_rect', params: { layer: 'body', rect: { x: 12, y: 8, w: 8, h: 12 }, color: '#8bac0f' } },
  ],
});
const walkFrames: number = walk.frames.length;

// The engine bundle: a root, files with bytes, and string warnings.
const bundle: EngineExportResult = exportEngineAssets(walk, { engine: 'godot', sheet: true });
const root: string = bundle.root;
const enginePath: string = bundle.files[0].path;
const engineBytes: Uint8Array = bundle.files[0].bytes;
const warnings: string[] = bundle.warnings;
const hash: string = bundle.meta.asset.contentHash;

// SVG trace import: a spec with the SVG on it, and a Sprite out.
const traced: Sprite = traceSvg({
  svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="16" height="16" fill="#8bac0f"/></svg>',
  width: 16, height: 16, name: 'icon', scale: 1,
});
const tracedWidth: number = traced.width;

export {
  api, pkg, w, h, layers, blob, firstPath, firstBytes, firstKind, exact, directions,
  walkFrames, root, enginePath, engineBytes, warnings, hash, tracedWidth, animated,
};
`;

/**
 * A consumer file whose every line is wrong, for the other half of the assertion.
 *
 * Each case is a mistake a real caller makes, and each names the export it is about. The
 * assertion is that `tsc` reports them — so a `.d.ts` full of `any` fails this file, which is
 * exactly what a green "the consumer compiles" cannot tell you.
 */
const BAD_CONSUMER = `
import {
  API_VERSION, buildSprite, buildAnimation, buildWalkAnimation, exportAssets,
  getDirectionModel, exportEngineAssets, traceSvg,
} from 'dotloom-mcp';

// 1. A number where a string is declared.
const version: number = API_VERSION;

// 2. \`width\` is a required number; a string is not a number.
buildSprite({ width: '16', height: 16 });

// 3. \`ops\` entries need a \`command\`, and a number is not a string.
buildSprite({ width: 8, height: 8, ops: [{ command: 42 }] });

// 4. \`direction\` is one of the eight compass points, not a long-form word.
buildWalkAnimation({ width: 8, height: 8, direction: 'north' });

// 5. \`engine\` is one of four ids.
exportEngineAssets(buildSprite({ width: 8, height: 8 }), { engine: 'godotot' });

// 6. \`canvas\` needs both dimensions.
getDirectionModel({ width: 16 });

// 7. \`svg\` is required by an SVG trace spec.
traceSvg({ width: 16, height: 16 });

// 8. \`walk.frames\` is a number of frames.
buildWalkAnimation({ width: 8, height: 8, walk: { frames: 'four' } });

// 9. \`buildAnimation\` has no \`walk\` field — that is \`buildWalkAnimation\`'s, and the two are
// different functions rather than one with an optional section.
buildAnimation({ width: 8, height: 8, walk: { frames: 4 } });

// 10. A plan field that does not exist. Unknown keys are not silently kept.
exportAssets(buildSprite({ width: 8, height: 8 }), { framse: true });

void version;
`;

/* ------------------------------------------------------------------ *
 * The tarball's contents
 * ------------------------------------------------------------------ */

describe('the published tarball carries type declarations', () => {
  it('ships the declarations the manifest points at', () => {
    const manifestPath = join(consumer, 'node_modules', 'dotloom-mcp', 'package.json');
    const shipped = JSON.parse(readFileSync(manifestPath, 'utf8')) as { types?: string };
    expect(shipped.types, 'the packed manifest has no `types` field').toBe(MANIFEST.types);
    expect(shipped.types).toBeTruthy();
    const declared = resolve(consumer, 'node_modules', 'dotloom-mcp', shipped.types!);
    expect(existsSync(declared), `${relative(consumer, declared)} is missing from the tarball`).toBe(true);
  });

  it('ships the whole declaration tree, so the relative specifiers inside it resolve', () => {
    // This is the check that catches the failure mode named in the header: a `.d.ts` that
    // imports `../packages/core/src/index.js` resolves only if that file is *in the tarball*.
    // A consumer's `tsc` reports `Cannot find module '../packages/core/src/index.js'` on a
    // `.d.ts` nobody asked for otherwise, which is worse than shipping none.
    const root = join(consumer, 'node_modules', 'dotloom-mcp', 'dist', 'types');
    for (const required of ['index.d.ts', 'scripts/npm-index.d.ts', 'packages/core/src/index.d.ts']) {
      expect(existsSync(join(root, required)), `${required} is not in the tarball`).toBe(true);
    }
  });

  it('has no `@pixel/*` specifier left in it, because that name resolves nowhere else', () => {
    // The rewrite in `build-npm-package.mjs` is the thing that makes this true. `zod`,
    // `fast-png` and `@modelcontextprotocol/sdk` are allowed and are real dependencies;
    // `@pixel/core` is a workspace package the consumer cannot have.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.d.ts') && /from\s+['"]@pixel\//.test(readFileSync(full, 'utf8'))) {
          offenders.push(relative(consumer, full));
        }
      }
    };
    walk(join(consumer, 'node_modules', 'dotloom-mcp', 'dist', 'types'));
    expect(offenders, 'a @pixel/* specifier survived into the shipped declarations').toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The exports map
 * ------------------------------------------------------------------ */

describe('the manifest declares both tiers, and only them', () => {
  it('points `.` at the bundle and at the declarations beside it', () => {
    // `types` before `import`, because the order is significant: a bundler that reads the
    // conditions in order must meet `types` first, and a map that puts `import` first loses the
    // declarations for exactly the consumers this task is about.
    const root = MANIFEST.exports?.['.'] as { types?: string; import?: string } | undefined;
    expect(root, 'the manifest has no `exports["."]`').toBeTruthy();
    expect(Object.keys(root!)[0], 'the `types` condition must come first in `exports["."]`').toBe('types');
    expect(root!.types).toBe(`./${MANIFEST.types}`);
    expect(root!.import).toBe('./dist/index.js');
  });

  it('names every stable and internal export the entry actually has', () => {
    // Read out of the **shipped** declarations rather than out of `scripts/npm-index.ts`,
    // because that is what a consumer resolves, and the two can disagree: a name the source
    // exports can be missing from the emit if the build is stale, which is precisely the
    // failure this test exists to catch. Parsed rather than hardcoded, so a new export nobody
    // wrote down fails here.
    const declaration = readFileSync(
      join(consumer, 'node_modules', 'dotloom-mcp', 'dist', 'types', 'scripts', 'npm-index.d.ts'),
      'utf8',
    );
    const exported = new Set<string>();
    // Four spellings, because `tsc` emits four: a declaration per value, `export declare const`
    // for a version constant, an interface/type, and `export * as ns from` for a namespace.
    for (const match of declaration.matchAll(
      /^export\s+(?:declare\s+)?(?:function|const|class|interface|type)\s+([A-Za-z_$][\w$]*)/gm,
    )) {
      exported.add(match[1]);
    }
    for (const match of declaration.matchAll(/^export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/gm)) {
      exported.add(match[1]);
    }
    expect(exported.size, 'no exports found in the shipped npm-index.d.ts — the parse is wrong').toBeGreaterThan(5);
    for (const name of DOCUMENTED_NAMES) {
      expect(exported.has(name), `docs/API.md documents ${name}, which the entry does not export`).toBe(true);
    }
  });

  it('resolves every documented name through the map, and rejects what it does not declare', () => {
    // The negative half matters more than the positive one. Without an `exports` map, *any*
    // file in the tarball is importable — `dotloom-mcp/dist/index.js.map`, a future
    // `dist/internal/whatever.js` — so the tier boundary is documented in prose and enforced by
    // nothing. With one, the map is the boundary, and a specifier outside it is a hard error at
    // the consumer's build.
    const deepImport = compile({
      'deep.ts': `import { buildSprite } from 'dotloom-mcp/dist/index.js';\nvoid buildSprite;\n`,
    });
    expect(deepImport.status, 'a specifier outside the exports map resolved:\n' + deepImport.output).not.toBe(0);
    // `TS2307` is what NodeNext resolution reports for a package subpath the `exports` map does
    // not list. Matched on the code rather than on wording, because the message text is a
    // compiler-version detail and the code is not.
    expect(deepImport.output).toMatch(/error TS2307/);

    const mapped = compile({
      'mapped.ts': `
import { API_VERSION, VERSION, buildSprite, buildAnimation, buildWalkAnimation, exportAssets, exportEngineAssets, getDirectionModel, traceSvg, core, mcp, script } from 'dotloom-mcp';
import { core as coreInternal } from 'dotloom-mcp/internal';
void [API_VERSION, VERSION, buildSprite, buildAnimation, buildWalkAnimation, exportAssets, exportEngineAssets, getDirectionModel, traceSvg, core, mcp, script, coreInternal];
`,
    });
    expect(mapped.status, `the documented names did not resolve through the map:\n${mapped.output}`).toBe(0);
  }, 240_000);
});

/**
 * Every name `docs/API.md`'s surface table lists, read out of the document rather than a literal.
 *
 * A hand-copied list is a list that goes stale, and a stale list is a guard that has quietly
 * stopped guarding. `docs/API.md` is the authority on what the surface is, so it is the input.
 */
const DOCUMENTED_NAMES: string[] = (() => {
  const api = readFileSync(join(ROOT, 'docs', 'API.md'), 'utf8');
  // The first table only. `## The surface` runs to the next `---`, which includes the
  // sub-sections below it, and the specifier table lists module paths rather than exports —
  // a row there starts with `dotloom-mcp`, which is not a name the entry can export.
  const section = api.split('## The surface')[1] ?? '';
  const table = section.split(/^###\s/m)[0];
  const names: string[] = [];
  for (const row of table.split(/\r?\n/)) {
    const cell = row.match(/^\|\s*`([A-Za-z_$][\w$]*)/);
    if (cell) names.push(cell[1]);
  }
  return names.sort();
})();

/* ------------------------------------------------------------------ *
 * The consumer's tsc
 * ------------------------------------------------------------------ */

describe('a consumer installing the tarball gets real types', () => {
  it('compiles a build script that uses the whole stable surface', () => {
    const run = compile({ 'consumer.ts': GOOD_CONSUMER });
    expect(run.status, `the consumer's tsc failed:\n${run.output}`).toBe(0);
  }, 180_000);

  it('rejects a wrong call with a real diagnostic, so the types are not `any`', () => {
    const run = compile({ 'wrong.ts': BAD_CONSUMER });
    expect(run.status, `the consumer's tsc accepted a file of deliberate mistakes:\n${run.output}`).not.toBe(0);
    // Exactly the ten mistakes above, so a weakened declaration cannot pass by naming a subset
    // and a *removed* diagnostic cannot pass by the count drifting upward unnoticed. Counted per
    // file rather than overall, because a diagnostic in `wrong.ts` is the only one that proves
    // anything: one from a `.d.ts` would be a package defect, and this assertion is not where
    // that belongs. `skipLibCheck: false` in `compile` is what keeps a declaration error from
    // being silently swallowed here.
    const inWrongFile = run.output
      .split(/\r?\n/)
      .filter((line) => /wrong\.ts\(\d+,\d+\): error TS\d+/.test(line.trim()));
    expect(inWrongFile, `expected ten diagnostics in wrong.ts:\n${run.output}`).toHaveLength(10);
    // And each is a *type* error rather than "I do not know what this is": a missing export
    // would also be ten diagnostics and would prove nothing.
    for (const line of inWrongFile) {
      expect(line, `not a type error: ${line}`).not.toMatch(/TS2305|TS2304|TS2307/);
    }
  }, 180_000);
});

