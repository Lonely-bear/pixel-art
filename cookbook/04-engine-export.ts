/**
 * Cookbook 4 — export for an engine, with the contract beside it.
 *
 * Run it:
 *
 * ```bash
 * node --experimental-strip-types cookbook/04-engine-export.ts
 * ```
 *
 * A game does not read a PNG. It reads a sheet plus a frame table plus a pivot
 * convention, and each engine spells those three things differently — which is why
 * `exportEngineAssets` exists: one contract in, one engine's files out, plus the list
 * of everything the mapping could not carry.
 *
 * Three things this example shows on purpose, because they are the three ways this
 * step goes wrong:
 *
 *   - **`warnings` is a lossiness list, not a score.** It is text: what Godot's
 *     `SpriteFrames` cannot hold. There is no number here to optimise and no verdict
 *     to move artwork towards.
 *   - **A naming error refuses the whole call**, before a single byte is produced,
 *     because a bundle whose files break on a Windows build machine is a broken build
 *     and the mistake is better found here than in CI naming nothing.
 *   - **`directions` is a caller option, never derived.** One label per frame, in
 *     timeline order. An unrecognised label is refused rather than dropped, because a
 *     character that silently faces the wrong way in the game is not traceable from
 *     the sheet.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  buildAnimation,
  exportEngineAssets,
  type AssetEngineId,
  type EngineExportResult,
  type Sprite,
} from 'dotloom-mcp';

/** Where the files land. Set `DOTLOOM_COOKBOOK_OUT` to build somewhere else. */
const OUT = process.env['DOTLOOM_COOKBOOK_OUT'] ?? 'generated';

/** Four frames of a two-frame ping-pong, which is what per-frame timing survives. */
const PALETTE = ['#1a1c2c', '#5d275d', '#ef7d57', '#ffcd75'] as const;

/**
 * The character this chapter ships: an idle, so the sheet has two real durations and
 * the contract has something to say about timing.
 *
 * The two durations are the point. A uniform animation hides every timing loss an
 * importer has, because every lossy mapping so far happens when durations differ.
 */
export function buildHero(): Sprite {
  return buildAnimation({
    seed: 4242,
    width: 24,
    height: 32,
    name: 'hero-idle',
    palette: [...PALETTE],
    layers: ['body', 'legs'],
    frames: 4,
    frameDurationMs: 100,
    tags: [{ name: 'idle', from: 0, to: 3, direction: 'pingpong' }],
    ops: [
      { command: 'draw_rect', params: { layer: 'body', rect: { x: 9, y: 8, w: 6, h: 10 }, color: '#ef7d57' } },
      { command: 'draw_rect', params: { layer: 'body', rect: { x: 10, y: 5, w: 4, h: 4 }, color: '#ffcd75' } },
      { command: 'draw_rect', params: { layer: 'legs', rect: { x: 9, y: 18, w: 2, h: 8 }, color: '#5d275d' } },
      { command: 'draw_rect', params: { layer: 'legs', rect: { x: 13, y: 18, w: 2, h: 8 }, color: '#5d275d' } },
      // The bob: two frames up, two frames down, so the loop reads as breathing and
      // the durations are not all the same number.
      { command: 'set_frame_durations', params: { updates: [
        { frames: [0, 2], durationMs: 110 },
        { frames: [1, 3], durationMs: 90 },
      ] } },
      // A one-pixel lift on the raised frames. `frame` addresses a cel exactly as it
      // does in the CLI; omit it and frame 0 is filled in for you.
      { command: 'draw_rect', params: { frame: 1, layer: 'body', rect: { x: 9, y: 7, w: 6, h: 10 }, color: '#ef7d57' } },
      { command: 'draw_rect', params: { frame: 1, layer: 'body', rect: { x: 10, y: 4, w: 4, h: 4 }, color: '#ffcd75' } },
    ],
  });
}

/** Which engine, and what to ask it for. Four engines, one plan shape. */
const ENGINES: { engine: AssetEngineId; options?: Record<string, unknown> }[] = [
  { engine: 'godot' },
  // Unity's importer takes options; this one is the pixel scale the contract records
  // for the engine, and it is passed straight through.
  { engine: 'unity', options: { pixelsPerUnit: 16 } },
  { engine: 'phaser' },
  { engine: 'excalidraw' },
];

/**
 * One engine's whole bundle, as bytes.
 *
 * `directions` is filled from the timeline: four frames, all facing the same way, and
 * an unrecognised label would be refused. Passing it is the point — a caller who
 * forgets gets a sheet with no facing in it, which is better than a wrong one and
 * worse than a deliberate one.
 */
export function bundleFor(engine: AssetEngineId, options?: Record<string, unknown>): EngineExportResult {
  const sprite = buildHero();
  return exportEngineAssets(sprite, {
    engine,
    sheet: { layout: 'grid', columns: sprite.frames.length },
    directions: sprite.frames.map(() => 'S'),
    options,
  });
}

/**
 * The naming refusal, read out of the error.
 *
 * `CON` is a reserved device name on Windows: a file called `CON.png` builds on the
 * artist's machine and fails on a Windows build agent, which is the worst possible
 * place to find out. The call refuses instead — before a single byte is produced —
 * and the message names the offending path. This is a refusal like the tracer's: a
 * named reason to act on, not a number to improve.
 */
export function namingRefusal(): string {
  try {
    exportEngineAssets(buildHero(), {
      engine: 'godot',
      sheet: true,
      // The stem alone is not enough to trip it: the sheet is written as
      // `CON_sheet.png`, and the validator looks at whole path segments. A reserved
      // name has to be a segment, which is why this goes through `outputs`.
      outputs: [{ role: 'source', path: 'CON.png' }],
    });
    return 'no refusal: a reserved device name was accepted as a file name';
  } catch (error) {
    const wrapped = error as { code?: string; message?: string };
    return [`code: ${wrapped.code ?? 'unknown'}`, wrapped.message ?? ''].join('\n');
  }
}

/** Every engine's bundle, plus a build report, without touching the filesystem. */
export function build(): Record<string, Uint8Array> {
  const sprite = buildHero();
  const out: Record<string, Uint8Array> = {};
  const report: Record<string, unknown> = {};

  for (const { engine, options } of ENGINES) {
    const bundle = bundleFor(engine, options);
    for (const file of bundle.files) {
      // Paths are relative to `bundle.root`; prefixing keeps one flat output tree
      // when four engines write into the same `generated/` folder.
      out[`${bundle.root}/${file.path}`] = file.bytes;
    }
    report[engine] = {
      root: bundle.root,
      files: bundle.files.map((f) => `${f.role}: ${f.path}`),
      // Strings. What this mapping could not carry — a per-frame duration Godot's
      // SpriteFrames has no field for, a pivot convention it spells differently.
      warnings: bundle.warnings,
      // A report with machine-readable diagnostics, not a grade.
      naming: bundle.naming.diagnostics.map((d) => `${d.severity} [${d.code}] ${d.path}: ${d.message}`),
    };
  }
  report['sprite'] = { name: sprite.name, frames: sprite.frames.length };
  out['bundle-report.json'] = new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`);
  out['naming-refusal.txt'] = new TextEncoder().encode(`${namingRefusal()}\n`);
  return out;
}

/** Write the four bundles, the report and the refusal note under `OUT`. */
async function main(): Promise<void> {
  const files = build();
  for (const [name, bytes] of Object.entries(files)) {
    const path = join(OUT, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    console.log(`  ${name.padEnd(46)} ${String(bytes.length).padStart(6)} B`);
  }
  const godot = bundleFor('godot');
  console.log(`\ngodot warnings:\n${godot.warnings.map((w) => `  - ${w}`).join('\n') || '  (none)'}`);
  console.log(`\n${namingRefusal()}`);
}

await main();

export default build;
