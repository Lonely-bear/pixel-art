/**
 * Cookbook 3 — trace an SVG onto the pixel grid.
 *
 * Run it:
 *
 * ```bash
 * node --experimental-strip-types cookbook/03-trace-svg.ts
 * ```
 *
 * The road from vector to pixel, in one call. A PNG import cannot recover geometry;
 * a traced outline lands on the grid exactly, which is why the shape stays editable
 * and the pixel count stays honest.
 *
 * Two things this example is careful about, because both are how tracing goes wrong
 * in practice:
 *
 *   - **`scale` is SVG user units per pixel**, not pixels per SVG unit. A 64-unit
 *     icon traced into a 16px canvas is `scale: 4`. Getting it backwards lands the
 *     artwork at a quarter of the size it was drawn at, which looks like a bug in the
 *     tracer and is a bug in the number.
 *   - **Refusals are named.** An SVG that needs flattening — a `transform`, an
 *     inherited `fill`, a gradient — is refused with a machine-readable reason rather
 *     than approximated. The last file this example writes is that refusal, read out
 *     of the error, so the failure mode is part of the example rather than something
 *     a reader discovers in production.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { exportAssets, traceSvg, type Sprite } from 'dotloom-mcp';

/** Where the files land. Set `DOTLOOM_COOKBOOK_OUT` to build somewhere else. */
const OUT = process.env['DOTLOOM_COOKBOOK_OUT'] ?? 'generated';

/**
 * The source vector.
 *
 * A 64x64 user-space icon: a leaf body with a vein, in two shapes with their own
 * fills. Written inline rather than read from disk because this repository's core has
 * no filesystem — `svg` is **text**, and a real build script does the
 * `await readFile('assets/logo.svg', 'utf8')` itself.
 *
 * Note what is absent: no `transform`, no `<g>` with an inherited `fill`, no
 * `fill: url(#gradient)`, no stroke-only shape. All four are refusals, not
 * approximations — see `refusal()` at the bottom for what one looks like.
 */
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <path d="M 32 6 C 52 20 52 44 32 58 C 12 44 12 20 32 6 Z" fill="#5d275d"/>
  <polygon points="31,10 33,10 33,54 31,54" fill="#9bbc0f"/>
  <polygon points="18,22 24,17 29,21 23,26" fill="#ffcd75"/>
</svg>`;

/** A 16px icon. `scale: 4` is the whole trick: 64 user units across 16 pixels. */
export function buildLeaf(): Sprite {
  return traceSvg({
    svg: SVG,
    width: 16,
    height: 16,
    name: 'leaf',
    palette: ['#1a1c2c', '#5d275d', '#9bbc0f', '#ffcd75'],
    layers: ['traced'],
    // 64 user units / 16 pixels = 4 user units per pixel.
    scale: 4,
    // Coverage is hard-edged by design: a traced outline is a pixel edge, not a ramp
    // of half-transparent alphas. `antialias` exists if a staircase is too coarse —
    // it is deliberately *not* run here, because this class of art wants hard pixels.
  });
}

/**
 * The refusal, read out of the error.
 *
 * `traceSvg` runs a real command, and the command bus re-wraps every failure, so the
 * error a caller catches has code `command_failed` and the reason that actually says
 * something about the SVG nested one level down. Branching on
 * `error.details.details.reason` is branching on the reason the document refused,
 * which is the only one of the three that is about the input.
 */
export function refusal(): string {
  const unsupported = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <g transform="translate(2 2)"><rect x="0" y="0" width="12" height="12" fill="#5d275d"/></g>
</svg>`;
  try {
    traceSvg({ svg: unsupported, width: 16, height: 16, name: 'transformed', scale: 1 });
    return 'no refusal: the tracer accepted a transform, which it is documented not to do';
  } catch (error) {
    const wrapped = error as { code?: string; details?: { code?: string; details?: { reason?: string } } };
    return [
      `code: ${wrapped.code ?? 'unknown'}`,
      `details.code: ${wrapped.details?.code ?? 'unknown'}`,
      `reason: ${wrapped.details?.details?.reason ?? 'unknown'}`,
    ].join('\n');
  }
}

/** Render the traced icon and the refusal note, without touching the filesystem. */
export function build(): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  // One PNG, plus the frame table, plus the editable archive: the same three-file
  // bundle a hand-made sprite gets, because from here on nothing knows it was a
  // trace.
  for (const file of exportAssets(buildLeaf(), { frames: true, sheet: true, source: true })) {
    out[file.path] = file.bytes;
  }
  out['refusal.txt'] = new TextEncoder().encode(`${refusal()}\n`);
  return out;
}

/** Write the traced icon and the refusal note under `OUT`. */
async function main(): Promise<void> {
  const files = build();
  for (const [name, bytes] of Object.entries(files)) {
    const path = join(OUT, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    console.log(`  ${name.padEnd(20)} ${String(bytes.length).padStart(6)} B`);
  }
  console.log(`\n${refusal()}`);
}

await main();

export default build;
