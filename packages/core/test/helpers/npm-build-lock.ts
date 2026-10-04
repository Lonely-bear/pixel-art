// One shared build-and-pack of the npm bundle, for the two test files that need a real tarball.
//
// ## Why this exists
//
// `npm-consumer-types.test.ts` and `cookbook.test.ts` each need to ask the same question — does a
// consumer get real types? — and the only honest way to ask it is to build the package and pack a
// real tarball. Doing that independently in each file was fragile in two ways at once:
//
//   1. Both wrote the same root `dist/`, so a tarball could be a half-written mixture of the other.
//   2. Each owned its own temp tree and deleted it in `afterAll`, so a cleanup in one file could
//      remove state another was still reading. That one produced `ENOENT` on a consumer directory
//      that a `beforeAll` had just built, which surfaced as seven unrelated-looking assertion
//      failures and did not reproduce in isolation. Three runs failed, three runs of any subset
//      passed.
//
// So the build happens ONCE, here, under a lock, into a path derived from the package name and
// version. Both files call `packedTarball()` and get the same file; each extracts it into its own
// consumer directory. The content is a pure function of the source, so sharing is not a cache that
// can go stale within a run — and the path carries the version, so a version bump cannot collide
// with a stale tarball from a previous one.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const BUILD_SCRIPT = join(ROOT, 'scripts', 'build-npm-package.mjs');
const LOCK = join(ROOT, 'node_modules', '.dotloom-npm-build.lock');

/** A lock older than this belongs to a process that is gone, not to one still building. */
const STALE_MS = 10 * 60 * 1000;

/**
 * A synchronous sleep. `Atomics.wait` is the only one Node offers and it is the right tool: every
 * caller here is synchronous by nature — the build, the pack and each `tsc` are `spawnSync` — so an
 * async wait would mean async hooks in two files, which is a far larger change than this problem
 * deserves. It is permitted on Node's main thread; only browsers forbid it.
 */
const sleep = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * `mkdirSync` is the lock: atomic on every platform this repository ships to, no dependency, and —
 * unlike a lock FILE — impossible to half-create by a process that dies between the check and the
 * claim. It lives under `node_modules/`, which is gitignored, so an abandoned lock cannot be
 * committed, and it is reclaimed on a timer so a killed run cannot wedge every later one.
 */
function withLock(fn) {
  mkdirSync(join(ROOT, 'node_modules'), { recursive: true });
  const deadline = Date.now() + STALE_MS;

  for (;;) {
    try {
      mkdirSync(LOCK);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > STALE_MS) {
          rmSync(LOCK, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // it vanished under us; try again
      }
      if (Date.now() > deadline) {
        throw new Error(
          `waited ${STALE_MS}ms for ${LOCK}, which another test is holding. If no test is running, ` +
            'delete it. If one is, its build has been going for over ten minutes.',
        );
      }
      sleep(250);
    }
  }

  try {
    return fn();
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
}

/**
 * `npm` on Windows is a `.cmd` shim, which `spawnSync` cannot execute without a shell — and a shell
 * brings in quoting, which brings in path-with-non-ASCII problems. So resolve `npm-cli.js` itself,
 * which also pins the tests to the client that ships with the Node running them rather than to
 * whatever a PATH lookup finds.
 *
 * **"Sits next to the Node" was true on the machine that wrote this and false on a CI runner.**
 * `actions/setup-node` puts the binary at `<prefix>/bin/node` and the client at
 * `<prefix>/lib/node_modules/npm/bin/npm-cli.js`, so the first candidate never existed there and the
 * suite failed on the runner with a message about a file that was not missing but in another place.
 * Two tests that pack a real tarball had never once run off this machine.
 *
 * **`npm_execpath` is deliberately NOT a candidate, and that took a run to learn.** It names
 * whatever package manager started the tests. Under `pnpm test` that is pnpm, and pnpm ships its own
 * file at `.../pnpm/dist/npm-cli.js` — pnpm wearing npm's filename. Running it with npm's flags
 * invokes pnpm, which answers `[ERROR] Unknown option: 'ignore-scripts'` and exits 1. It looks like
 * the most authoritative answer available, which is exactly why it is worth writing down.
 *
 * So the candidates are npm's own layouts only: `lib/node_modules` beside the binary's parent is the
 * POSIX prefix that `actions/setup-node` produces, `node_modules` beside the binary is the Windows
 * one, and walking up covers a version manager that nests differently.
 */
export function npmCliCandidates(nodeDir: string): string[] {
  const prefix = dirname(nodeDir);
  return [
    join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ...ancestors(nodeDir).map((dir) => join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')),
  ];
}

function npmCli(): string {
  const candidates = npmCliCandidates(dirname(process.execPath));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    `could not find npm-cli.js. These tests pack a real tarball, so they need the npm client that ` +
      `ships with the Node running them (${process.execPath}). Looked at:\n  ${candidates.join('\n  ')}`,
  );
}

/** `dir` and each of its ancestors, nearest first. */
function ancestors(dir: string): string[] {
  const out: string[] = [];
  for (let d = dir; ; ) {
    const up = dirname(d);
    if (up === d) return out;
    out.push(up);
    d = up;
  }
}

/**
 * Build the package and pack it once per run. Returns the tarball's path.
 *
 * The tarball goes to a directory named for the package and version, so two runs of the same
 * version reuse it and two different versions cannot collide.
 */
export function packedTarball() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
  };
  const file = `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`;
  const destination = join(tmpdir(), `dotloom-packed-${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}`);

  return withLock(() => {
    mkdirSync(destination, { recursive: true });
    const tarball = join(destination, file);

    // Built every time rather than reused: a cached tarball would make a failing build pass by
    // leaving yesterday's bytes on disk, which is the exact failure mode a build test must not have.
    const built = spawnSync(process.execPath, [BUILD_SCRIPT], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (built.status !== 0) {
      throw new Error(`scripts/build-npm-package.mjs failed (${built.status}):\n${built.stdout ?? ''}${built.stderr ?? ''}`);
    }

    const packed = spawnSync(
      process.execPath,
      [npmCli(), 'pack', '--ignore-scripts', '--pack-destination', destination],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (packed.status !== 0) {
      throw new Error(`npm pack failed (${packed.status}):\n${packed.stdout ?? ''}${packed.stderr ?? ''}`);
    }
    if (!existsSync(tarball)) {
      throw new Error(`npm pack reported success but ${tarball} is not there.`);
    }
    return tarball;
  });
}

/** A fresh directory for one file's consumer project, its own and nobody else's. */
export function consumerWorkdir(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

export { withLock as withNpmBuildLock, LOCK as npmBuildLockPath };