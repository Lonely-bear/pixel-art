#!/usr/bin/env node
/**
 * The example build script the Action's own smoke workflow runs.
 *
 * It is the `tools/build-assets.mjs` from `docs/API.md`, reduced to one sprite
 * and given a `source: true` output, because the `source` export is the only
 * one that writes a `.pixel` archive and therefore the only one the quality gate
 * has something to read. A real project adds its own tilesets and animations
 * here; nothing about the Action changes.
 *
 * Deterministic by construction: a fixed `seed`, no clock, no randomness. Running
 * it twice produces byte-identical files, which is what makes `check-assets.mjs`
 * a meaningful check rather than a coin flip.
 *
 * `DOTLOOM_EXAMPLE_OUT` relocates the output directory, so this script can be
 * run against a scratch directory without writing into the repository.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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

for (const file of exportAssets(slime, { frames: true, sheet: true, source: true })) {
  const path = join(OUT, file.path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, file.bytes);
  console.log(`  ${file.path.padEnd(22)} ${String(file.bytes.length).padStart(6)} B  ${file.mediaType}`);
}
