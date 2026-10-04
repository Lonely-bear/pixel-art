#!/usr/bin/env node
/**
 * The Action's `check-command` example: rebuild the same spec and compare bytes
 * with what the build wrote.
 *
 * This is the check that actually earns the word *deterministic*. A CI job that
 * regenerates assets and never looks at them proves nothing; this one fails when
 * the committed bytes are not what the spec produces, so a diff in `assets/` is
 * either a deliberate artwork change or a bug, and never "the run changed".
 *
 * It exits non-zero and names the file. It does not print a score, and neither
 * does anything else in this Action.
 *
 * `DOTLOOM_EXAMPLE_OUT` relocates the directory it compares against, for the
 * same reason `build-assets.mjs` honours it.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSprite, exportAssets } from 'dotloom-mcp';

const OUT = process.env.DOTLOOM_EXAMPLE_OUT || join('assets', 'generated');

const slime = buildSprite({
  seed: 20260927,
  width: 16,
  height: 16,
  name: 'slime',
  layers: ['base', 'shade', 'outline'],
  palette: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f', '#deeed6'],
  ops: [
    { command: 'draw_ellipse', params: { layer: 'base', rect: { x: 2, y: 5, w: 12, h: 9 }, color: '#8bac0f' } },
    { command: 'draw_ellipse', params: { layer: 'shade', rect: { x: 4, y: 9, w: 8, h: 4 }, color: '#306230' } },
    { command: 'draw_rect', params: { layer: 'shade', rect: { x: 5, y: 8, w: 1, h: 2 }, color: '#0f380f' } },
    { command: 'draw_rect', params: { layer: 'shade', rect: { x: 10, y: 8, w: 1, h: 2 }, color: '#0f380f' } },
    { command: 'draw_ellipse', params: { layer: 'outline', rect: { x: 2, y: 5, w: 12, h: 9 }, color: '#0f380f', fill: false } },
  ],
});

const expected = exportAssets(slime, { frames: true, sheet: true, source: true });
let drifted = 0;

for (const file of expected) {
  const path = join(OUT, file.path);
  let committed;
  try {
    committed = await readFile(path);
  } catch {
    console.error(`missing ${file.path} - the build did not write it, or wrote it elsewhere`);
    drifted++;
    continue;
  }
  if (!Buffer.from(file.bytes).equals(committed)) {
    console.error(
      `${file.path} differs from a rebuild of the same spec - the committed bytes are stale, ` +
        'or the spec changed without the asset being regenerated',
    );
    drifted++;
    continue;
  }
  console.log(`  ${file.path.padEnd(22)} byte-identical to a rebuild`);
}

if (drifted > 0) {
  console.error(`${drifted} file(s) are not reproducible from the spec.`);
  process.exit(1);
}
console.log(`all ${expected.length} file(s) are byte-identical to a rebuild of the same spec`);
