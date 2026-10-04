/**
 * Cookbook 1 — your first sprite.
 *
 * Run it:
 *
 * ```bash
 * node --experimental-strip-types cookbook/01-first-sprite.ts
 * ```
 *
 * or, from a project that has the package installed, the same file with the bare
 * `dotloom-mcp` specifier (see `docs/COOKBOOK.md` for why this repository's copy
 * resolves through `dist/index.js` instead).
 *
 * What it does: block a silhouette in one flat colour, add the shading the shape
 * asks for, outline it, then render the finished document to files. Every command
 * in `ops` is a real command from the shared catalogue, so this is the same
 * pipeline the GUI and the MCP tool surface run — the only thing that is different
 * here is that nobody has to click.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildSprite, exportAssets, type Sprite } from 'dotloom-mcp';

/** Where the files land. Set `DOTLOOM_COOKBOOK_OUT` to build somewhere else. */
const OUT = process.env['DOTLOOM_COOKBOOK_OUT'] ?? 'generated';

/** The ramp. Five colours is enough to draw a body, a shadow and a contour. */
const PALETTE = ['#0f380f', '#306230', '#8bac0f', '#9bbc0f', '#deeed6'] as const;

/**
 * The whole recipe for the sprite, as data.
 *
 * Kept in its own function and its own object so a test — or a CI step — can build
 * the same document twice and compare bytes. Determinism is not an aspiration
 * here: `buildSprite` installs a seeded id factory for the duration of the call, so
 * the same spec produces the same `.pixel` archive on any machine.
 */
export function buildSlime(): Sprite {
  return buildSprite({
    seed: 20260927,
    width: 16,
    height: 16,
    name: 'slime',
    palette: [...PALETTE],
    // Bottom first, and the order is the order they are judged in: the silhouette
    // goes down first, the shading sits inside it, the contour goes on top.
    layers: ['base', 'shade', 'outline'],
    ops: [
      // The silhouette, flat. One mass, one colour, nothing else — everything after
      // this is judged against whether this shape is right.
      { command: 'draw_ellipse', params: { layer: 'base', rect: { x: 2, y: 5, w: 12, h: 9 }, color: '#8bac0f' } },

      // A contact band inside the silhouette, so the body has a bottom. Light from
      // the top-left, so the shadow is on the bottom-right and follows the contour.
      { command: 'draw_ellipse', params: { layer: 'shade', rect: { x: 4, y: 9, w: 8, h: 4 }, color: '#306230' } },
      { command: 'draw_ellipse', params: { layer: 'shade', rect: { x: 3, y: 8, w: 10, h: 4 }, color: '#9bbc0f', fill: false } },

      // Two eyes, one pixel each. At 16px an eye is one pixel; there is no other size.
      { command: 'draw_rect', params: { layer: 'shade', rect: { x: 5, y: 8, w: 1, h: 2 }, color: '#0f380f' } },
      { command: 'draw_rect', params: { layer: 'shade', rect: { x: 10, y: 8, w: 1, h: 2 }, color: '#0f380f' } },

      // The contour, drawn last, one pixel, in the darkest swatch. A contour is a
      // decision about where the eye stops, so it is drawn after the shading it
      // separates — never before it.
      { command: 'draw_ellipse', params: { layer: 'outline', rect: { x: 2, y: 5, w: 12, h: 9 }, color: '#0f380f', fill: false } },
    ],
  });
}

/**
 * Build the sprite and render it, without touching the filesystem.
 *
 * `exportAssets` returns bytes. Where they go is the build script's business, which
 * is why this function and `main` are separate: the first is what a test can call,
 * the second is what a person runs.
 */
export function build(): Record<string, Uint8Array> {
  const files = exportAssets(buildSlime(), {
    frames: true, // one PNG per frame, `slime_0.png`
    sheet: true, // `slime_sheet.png` plus the Aseprite-JSON frame table beside it
    source: true, // `slime.pixel`, the editable archive
  });
  const out: Record<string, Uint8Array> = {};
  for (const file of files) out[file.path] = file.bytes;
  return out;
}

/** Write the rendered files under `OUT` and print what was produced. */
async function main(): Promise<void> {
  const sprite = buildSlime();
  const files = exportAssets(sprite, { frames: true, sheet: true, source: true });
  for (const file of files) {
    const path = join(OUT, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.bytes);
    console.log(`  ${file.path.padEnd(20)} ${String(file.bytes.length).padStart(6)} B  ${file.mediaType}`);
  }
  console.log(`${sprite.name}: ${sprite.width}x${sprite.height}, ${sprite.layers.length} layers, ${sprite.frames.length} frame`);
}

await main();

export default build;
