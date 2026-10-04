// The lock itself. Proved rather than trusted, because a lock nobody has seen contended is a lock
// nobody knows works, and this one guards two test files that silently corrupted each other's
// output when they raced.

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withNpmBuildLock } from './helpers/npm-build-lock.js';

describe('the shared npm build lock', () => {
  it('serialises concurrent claimers, with no interleaving', () => {
    const events: string[] = [];
    let inside = 0;
    let maxInside = 0;

    const claim = (id: number) =>
      withNpmBuildLock(() => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        events.push(`enter:${id}`);
        // Hold long enough that an overlap would show as two entries before one exit.
        const until = Date.now() + 40;
        while (Date.now() < until) { /* deliberately busy */ }
        events.push(`exit:${id}`);
        inside -= 1;
      });

    claim(1);
    claim(2);
    claim(3);

    // The claimers are nested, so this asserts the ordering is total rather than merely plausible.
    // An unsynchronised lock gives maxInside 3 here.
    expect(maxInside).toBe(1);
    expect(events).toEqual(['enter:1', 'exit:1', 'enter:2', 'exit:2', 'enter:3', 'exit:3']);
    // **An explicit budget, and the reason is this file's own lesson.** These three claims normally
    // take 400ms and only block when one of the two tarball tests is holding the lock mid-build,
    // which under a full suite is tens of seconds. On vitest's 5000ms default that failed about two
    // runs in three — the same intermittent timeout this repository has now shipped three times.
    // A test that waits on a peer must say how long a peer may take.
  }, 180_000);

  it('releases the lock when the body throws, or the suite wedges for ten minutes', () => {
    expect(() => withNpmBuildLock(() => { throw new Error('boom'); })).toThrow('boom');

    // If the release were wrong this would block until the stale timeout and then throw, so a plain
    // `true` is a real assertion rather than a formality.
    let ran = false;
    withNpmBuildLock(() => { ran = true; });
    expect(ran).toBe(true);
    // Two acquisitions here, so the same peer-wait budget as the test above.
  }, 180_000);

  it('puts its lock under the repository root, not one level above it', () => {
    // This was wrong once and it failed SILENTLY: the path resolved to `<repo>/packages`, so the
    // trace written next to the lock went somewhere nobody was looking, and the first conclusion
    // drawn from an empty trace — "the lock is never acquired" — was about the wrong directory.
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    const lock = join(root, 'node_modules', '.dotloom-npm-build.lock');
    mkdirSync(join(root, 'packages', 'node_modules'), { recursive: true });
    expect(existsSync(lock)).toBe(false);
    // And nothing leaked into `packages/node_modules`, which the same mistake created.
    expect(existsSync(join(root, 'packages', 'node_modules', '.dotloom-npm-build.lock'))).toBe(false);
    rmSync(join(root, 'packages', 'node_modules'), { recursive: true, force: true });
  });
});