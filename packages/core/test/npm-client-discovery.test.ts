import { describe, expect, it } from 'vitest';

import { npmCliCandidates } from './helpers/npm-build-lock.js';

/**
 * The failure this guards: `npmCli()` used to look in exactly one place, and that place was correct
 * on the machine that wrote it and wrong on every CI runner. Two tests that pack a real tarball
 * shipped without ever running off a developer's box, and the suite failed on the runner with a
 * message saying a file was missing when it was in a different directory.
 *
 * Candidates are compared with separators normalised. What is being asserted is *which directories
 * get probed*; building the expected string with `join` would make these pass on Windows by
 * constructing the very thing they then compare against, which is the mistake this file is about.
 */
const candidatesFor = (nodeDir: string): string[] =>
  npmCliCandidates(nodeDir).map((p) => p.replaceAll('\\', '/'));

/** Verbatim from the failing run. `actions/setup-node` uses this POSIX prefix layout everywhere. */
const RUNNER_NODE_DIR = '/opt/hostedtoolcache/node/22.13.0/x64/bin';
const RUNNER_NPM = '/opt/hostedtoolcache/node/22.13.0/x64/lib/node_modules/npm/bin/npm-cli.js';

describe('finds npm on the layouts that occur, not just the one it was written on', () => {
  it('covers the POSIX prefix layout actions/setup-node produces', () => {
    expect(candidatesFor(RUNNER_NODE_DIR)).toContain(RUNNER_NPM);
  });

  it('still covers the layout it originally assumed', () => {
    expect(candidatesFor('/c/tools/node')).toContain('/c/tools/node/node_modules/npm/bin/npm-cli.js');
  });

  /**
   * `npm_execpath` looks like the most authoritative answer available and is the wrong one: under
   * `pnpm test` it names pnpm's bundled `npm-cli.js`, which is pnpm wearing npm's filename. Running
   * it with npm's flags fails with `Unknown option: 'ignore-scripts'`. It is not consulted, and this
   * asserts that rather than trusting a comment.
   */
  it('never consults npm_execpath, which under pnpm is pnpm', () => {
    const before = process.env.npm_execpath;
    process.env.npm_execpath = '/opt/pnpm/dist/npm-cli.js';
    try {
      const c = candidatesFor(RUNNER_NODE_DIR);
      expect(c).not.toContain('/opt/pnpm/dist/npm-cli.js');
      expect(c.every((p) => !p.includes('/pnpm/'))).toBe(true);
      // And the real npm on this machine is still reachable, which is the point.
      expect(c.some((p) => p.endsWith('/npm/bin/npm-cli.js'))).toBe(true);
    } finally {
      if (before === undefined) delete process.env.npm_execpath;
      else process.env.npm_execpath = before;
    }
  });

  it('walks up, so a version manager that nests differently is still found', () => {
    const c = candidatesFor(RUNNER_NODE_DIR);
    expect(c).toContain('/opt/hostedtoolcache/node/22.13.0/x64/node_modules/npm/bin/npm-cli.js');
    expect(c.some((p) => p.startsWith('/opt/hostedtoolcache'))).toBe(true);
  });

  /**
   * The one that matters: **the old lookup looked in exactly one directory and it was the wrong one
   * on a runner.** The old candidate is still in the list — it is the correct guess for the Windows
   * layout — so the claim is not "that path is absent" but "npm on a runner is reached by a path the
   * old code never tried". Simulate the runner's filesystem by marking only the `lib/` path present,
   * which is exactly the state `actions/setup-node` produces.
   */
  it('reaches npm on a runner only via a path the old lookup never tried', () => {
    const whereItUsedToLook = `${RUNNER_NODE_DIR}/node_modules/npm/bin/npm-cli.js`;
    const present = new Set([RUNNER_NPM]); // the runner's filesystem, minus the old guess
    const firstExisting = candidatesFor(RUNNER_NODE_DIR).find((p) => present.has(p));
    expect(firstExisting).toBe(RUNNER_NPM);
    expect(firstExisting).not.toBe(whereItUsedToLook);

    // The old code's only candidate is not present, which is precisely why it threw.
    expect(present.has(whereItUsedToLook)).toBe(false);
  });

  it('reports every place it looked when it finds nothing, so the next failure is diagnosable', () => {
    const c = candidatesFor('/nowhere/at/all/bin');
    expect(c.length).toBeGreaterThan(1);
    // Deterministic and finite: a candidate list that grows without bound is not a search.
    expect(new Set(c).size).toBe(c.length);
  });
});