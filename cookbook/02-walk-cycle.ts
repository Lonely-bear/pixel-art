/**
 * Cookbook 2 — an eight-direction character, and why it is three drawings.
 *
 * Run it:
 *
 * ```bash
 * node --experimental-strip-types cookbook/02-walk-cycle.ts
 * ```
 *
 * The plan first, the pixels second. `getDirectionModel` answers "which three
 * sheets do I actually have to draw, and where does every direction land" before a
 * single pixel exists, and the answer is not "eight": four of the eight compass
 * points are reproduced exactly by a quarter turn and/or a mirror, so an
 * eight-direction character is one drawing for `E`, one mirror for `W`, one
 * quarter turn each for `N` and `S`, and four diagonals that no pixel-exact 45°
 * transform can produce — so those four have to be drawn, and this example says so
 * rather than quietly substituting a cardinal for them.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  buildWalkAnimation,
  exportAssets,
  getDirectionModel,
  type AssetOp,
  type DirectionId,
  type Sprite,
} from 'dotloom-mcp';

/** Where the files land. Set `DOTLOOM_COOKBOOK_OUT` to build somewhere else. */
const OUT = process.env['DOTLOOM_COOKBOOK_OUT'] ?? 'generated';

const CANVAS = { width: 32, height: 32 } as const;

/** The character. Ramp first, then the rig, then the rest pose the gait renders from. */
const PALETTE = ['#1a1c2c', '#5d275d', '#ef7d57', '#ffcd75'] as const;

/**
 * The base drawing, in `E`, as ops.
 *
 * One function because it is used four times: a quarter turn about the ground
 * anchor is what turns this drawing into the other three cardinals, so there is no
 * second set of ops to keep in step with the first.
 *
 * The rig is what makes the gait possible. `create_rig` is a real command, and the
 * parts carry the pivots the walk generator rotates about — a leg with no pivot has
 * no swing, it has a slide.
 */
function heroOps(): AssetOp[] {
  return [
    {
      command: 'create_rig',
      params: {
        parts: [
          { name: 'body', pivot: { x: 16, y: 12 } },
          { name: 'legL', pivot: { x: 14, y: 21 }, parent: 'body' },
          { name: 'legR', pivot: { x: 18, y: 21 }, parent: 'body' },
          { name: 'armL', pivot: { x: 13, y: 13 }, parent: 'body' },
          { name: 'armR', pivot: { x: 19, y: 13 }, parent: 'body' },
        ],
      },
    },
    // The rest pose, drawn once, into the rig's rest frame. Everything the gait
    // bakes afterwards is rendered *from* this frame.
    { command: 'draw_rect', params: { layer: 'body', rect: { x: 13, y: 9, w: 6, h: 9 }, color: '#ef7d57' } },
    { command: 'draw_rect', params: { layer: 'body', rect: { x: 14, y: 6, w: 4, h: 4 }, color: '#ffcd75' } },
    { command: 'draw_rect', params: { layer: 'body', rect: { x: 14, y: 8, w: 1, h: 1 }, color: '#1a1c2c' } },
    { command: 'draw_rect', params: { layer: 'body', rect: { x: 17, y: 8, w: 1, h: 1 }, color: '#1a1c2c' } },
    { command: 'draw_rect', params: { layer: 'legL', rect: { x: 13, y: 18, w: 2, h: 8 }, color: '#5d275d' } },
    { command: 'draw_rect', params: { layer: 'legR', rect: { x: 17, y: 18, w: 2, h: 8 }, color: '#5d275d' } },
    { command: 'draw_rect', params: { layer: 'armL', rect: { x: 12, y: 10, w: 1, h: 7 }, color: '#ffcd75' } },
    { command: 'draw_rect', params: { layer: 'armR', rect: { x: 19, y: 10, w: 1, h: 7 }, color: '#ffcd75' } },
    // A satchel on one side only, on purpose. A left-right symmetric character
    // mirrors onto itself, so `E` and `W` would come out byte-identical and the
    // mirror in the direction model would look like it had done nothing. Asymmetry
    // is what makes the four cardinals four sheets instead of two.
    { command: 'draw_rect', params: { layer: 'body', rect: { x: 10, y: 12, w: 2, h: 4 }, color: '#ffcd75' } },
  ];
}

/**
 * The eight-direction plan, as data the build can act on.
 *
 * Written to disk as `directions.json` because a direction plan is a thing a team
 * argues about and a person has to read. It contains no artwork, so it is also the
 * artifact that says what is still missing: `toDraw` is the list of sheets nobody
 * has drawn yet, which is the honest answer at the end of this build.
 */
export function plan(): Record<string, unknown> {
  const model = getDirectionModel(CANVAS);
  return {
    canvas: CANVAS,
    anchor: model.anchor,
    pivot: model.pivot,
    baseDirection: model.baseDirection,
    // Reproduced exactly by a transform: no artwork of their own is needed.
    exact: model.exact,
    // A diagonal has no pixel-exact 45-degree transform, so these four are drawn.
    toDraw: model.approximate,
    directions: model.directions.map((d) => ({
      id: d.id,
      label: d.label,
      facing: d.facing,
      exact: d.exact,
      // Which drawing this direction reuses, and which cardinal the transform lands
      // on. For a diagonal the two differ by 45 degrees, and that difference is the
      // whole reason the diagonal needs its own sheet.
      drawing: d.drawing,
      resolvedFrom: d.resolvedFrom,
    })),
  };
}

/**
 * One direction's walk cycle.
 *
 * One call is one direction: the walk is baked into real frames, with real
 * durations and a real looping tag, and the tag name is per-direction so a loop
 * over all eight does not overwrite itself. The loop closes — frame `frames` is the
 * same pose as frame 0 — so there is no duplicated end frame and no seam.
 */
export function walkIn(direction: DirectionId): Sprite {
  return buildWalkAnimation({
    seed: 4242,
    ...CANVAS,
    name: `hero-${direction.toLowerCase()}`,
    palette: [...PALETTE],
    // The rig parts are layers here, so each part's pixels survive into the frames
    // the generator bakes. A part that is not a layer has nothing to transform.
    layers: ['body', 'legL', 'legR', 'armL', 'armR'],
    direction,
    walk: {
      frames: 6,
      frameDurationMs: 110,
      stride: 3,
      bob: 1,
      tagName: `walk_${direction.toLowerCase()}`,
    },
    ops: heroOps(),
  });
}

/** The four cardinals, because those four are transforms of one drawing. */
export function build(): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  out['directions.json'] = new TextEncoder().encode(`${JSON.stringify(plan(), null, 2)}\n`);

  for (const direction of getDirectionModel(CANVAS).exact) {
    const sprite = walkIn(direction);
    for (const file of exportAssets(sprite, {
      sheet: { layout: 'grid', columns: sprite.frames.length },
      gif: { scale: 3 },
    })) {
      out[file.path] = file.bytes;
    }
  }
  return out;
}

/** Write the four walk sheets and the direction plan under `OUT`. */
async function main(): Promise<void> {
  const files = build();
  for (const [name, bytes] of Object.entries(files)) {
    const path = join(OUT, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    console.log(`  ${name.padEnd(28)} ${String(bytes.length).padStart(6)} B`);
  }
  const model = getDirectionModel(CANVAS);
  console.log(`exact: ${model.exact.join(', ')}`);
  console.log(`still to draw: ${model.approximate.join(', ')} — no pixel-exact 45-degree transform exists`);
}

await main();

export default build;
