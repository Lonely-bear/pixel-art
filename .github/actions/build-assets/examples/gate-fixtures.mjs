#!/usr/bin/env node
/**
 * Two control documents for the quality gate, and the reason this file exists.
 *
 * **A gate nobody has watched both ways is a gate nobody can trust.** This writes
 * one document the gate must refuse and one it must pass, so a change to the
 * pipeline that turns one of them the wrong way is visible rather than assumed.
 * It is the same negative-control discipline `benchmarks/corpus` carries, at the
 * scale of one CI job.
 *
 * - `refused/flat-block.pixel` — one flat tone edge to edge. `value` reports
 *   `flat-value` at 550/1000, above §5.3's 500 cut, so the gate refuses it.
 * - `passed/banded-block.pixel` — three tone planes, and its only findings are
 *   `interior-hole` (400) and `thin-profile` (300), both below the cut. The
 *   verdict is `warn` and the gate passes: **an advisory never fails a build.**
 *
 * Run it with `DOTLOOM_FIXTURE_OUT` pointing anywhere; it writes nothing into the
 * repository unless you point it at one.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSprite, core } from 'dotloom-mcp';

const OUT = process.env.DOTLOOM_FIXTURE_OUT || join('.', 'tmp', 'gate-fixtures');
const PALETTE = ['#0f380f', '#306230', '#8bac0f', '#9bbc0f', '#deeed6'];

const refused = buildSprite({
  seed: 1,
  width: 16,
  height: 16,
  name: 'flat-block',
  palette: PALETTE,
  layers: ['base'],
  ops: [{ command: 'draw_rect', params: { layer: 'base', rect: { x: 0, y: 0, w: 16, h: 16 }, color: '#8bac0f' } }],
});

const passed = buildSprite({
  seed: 11,
  width: 32,
  height: 32,
  name: 'banded-block',
  palette: PALETTE,
  layers: ['base'],
  ops: [
    { command: 'draw_rect', params: { layer: 'base', rect: { x: 4, y: 4, w: 24, h: 24 }, color: '#8bac0f' } },
    { command: 'draw_rect', params: { layer: 'base', rect: { x: 4, y: 16, w: 24, h: 12 }, color: '#306230' } },
    { command: 'draw_rect', params: { layer: 'base', rect: { x: 4, y: 4, w: 24, h: 4 }, color: '#deeed6' } },
  ],
});

for (const [sub, sprite] of [
  ['refused', refused],
  ['passed', passed],
]) {
  const dir = join(OUT, sub);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sprite.name}.pixel`), core.serializeSprite(sprite));
  console.log(`  ${sub}/${sprite.name}.pixel`);
}
