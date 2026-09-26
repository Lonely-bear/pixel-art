/**
 * `pixel demo` — the whole product, in one command.
 *
 * A stranger who has just installed the package has nothing but Node. This command
 * takes no path, no size and no palette: it authors a small sprite through the real
 * command bus and writes a PNG next to the editable `.pixel` source.
 *
 * Two things are deliberate here, and both come from the product being a *game asset
 * pipeline* rather than an image generator. First, the artwork is drawn the way a pixel
 * artist blocks one in — one flat silhouette, a hue-shifted material ramp, tonal planes
 * that follow the form rather than cutting across it, light from a single direction, a
 * consistent 1px contour — because a demo that looks procedural teaches people the wrong
 * thing. Second, every mutation goes through `Editor.execute`, i.e. the same serialisable
 * commands an agent sends over MCP. The saved `.pixel` is therefore a genuine document
 * with a real undo history behind it, which is the proof this is a tool and not a
 * texture generator.
 */

import { resolve } from 'node:path';
import {
  allCommands,
  compositeFrame,
  createEditor,
  createRegistry,
  createSprite,
  encodePNG,
  resolveFrame,
  type Editor,
  type Point,
  type Rect,
  type Sprite,
} from '@pixel/core';
import { intFlag, stringFlag, UsageError } from './args.js';
import { printJson, saveSprite, writeBytes } from './io.js';
import type { CommandContext, CommandSpec } from './commands.js';

/**
 * 32x32 is the size a game asset is actually shipped at. Bigger and the demo starts
 * teaching "art", smaller and the silhouette cannot carry light and shadow.
 */
const CANVAS = 32;

const SPRITE_NAME = 'Crowned Slime';
/** Also the default destination directory, so `pixel demo` needs no arguments. */
const FILE_STEM = 'crowned-slime';

/**
 * Bottom first. Six layers is what the drawing below needs and not one more: a base
 * silhouette, the two shading layers it is lit through, the crown, the face, and a
 * contour traced from all of it.
 */
const LAYERS = ['Base', 'Shade', 'Light', 'Crown', 'Face', 'Outline'] as const;

/**
 * Two neutrals the whole sprite shares, so the palette stays at ten entries.
 *
 * The contour colour doubles as the core shadow tone and the eye pupil. A separate
 * "pure black" would be an eleventh swatch one value away from this one, which is
 * exactly the kind of redundant entry that makes a palette look accidental.
 *
 * The contour is deliberately *achromatic* - the three channels within one step of each
 * other, so it falls under the saturation floor and contributes no hue family of its
 * own. That is the right choice for a game asset on two counts: a neutral line tints
 * with whatever is behind it instead of fighting it, and it keeps the sprite's hue
 * families to the two materials that are actually in the picture.
 */
const OUTLINE = '#1c1c1d';
const PALE = '#fdf3d7';

/**
 * The silhouette, one row at a time: `[leftEdge, rightEdge]` from the top row down.
 *
 * Hand-authored rather than an inscribed ellipse, for two reasons. An ellipse narrows
 * four pixels in a single row at the bottom of a shape this round, and a 1px contour
 * grown out of that step comes out as a four-pixel slab. And the entire tonal stack
 * below is built from insets of *this* table, so every row has to move by one pixel at
 * a time for those insets to stay parallel to the contour.
 *
 * There is deliberately no sacrificial row here: `planeRows` appends one, and the base
 * plane is `planeRows` of this table, so the body's last drawn row is the last row
 * here.
 *
 * Every pair sums to 31, so the sprite is exactly symmetric about x=15.5 — the mirror
 * axis of a 32px canvas — without a single mirror operation.
 */
const BODY_TOP = 5;
const SILHOUETTE: readonly (readonly [number, number])[] = [
  [15, 16],
  [14, 17],
  [13, 18],
  [12, 19],
  [11, 20],
  [10, 21],
  [ 9, 22],
  [ 8, 23],
  [ 7, 24],
  [ 6, 25],
  [ 5, 26],
  [ 5, 26],
  [ 5, 26],
  [ 5, 26],
  [ 5, 26],
  [ 5, 26],
  [ 5, 26],
  [ 5, 26],
  [ 6, 25],
  [ 7, 24],
  [ 8, 23],
  [ 9, 22],
  [10, 21],
  [11, 20],
];

/** One row of a shape: `[left, right, y]`. */
type Row = readonly [number, number, number];

/** The silhouette as rows: the single source every tonal plane is derived from. */
function silhouetteRows(): Row[] {
  return SILHOUETTE.map(([left, right], row) => [left, right, BODY_TOP + row] as Row);
}

/**
 * A copy of `rows` walked `inset` pixels inward on each side and displaced by (`dx`, `dy`)
 * along the light axis, plus one sacrificial row.
 *
 * This is the whole trick behind the shading. Every tonal plane comes from this same row
 * table, so every value boundary is a copy of the silhouette and therefore runs parallel
 * to the contour — which is what makes the body read as one lit volume rather than as a
 * shape with a smear on it. A highlight drawn as an independent ellipse and a shadow
 * drawn as an independent polygon are two unrelated shapes, and the eye reads two shapes.
 *
 * `inset` is zero for every plane except the core shadow, and the reason is geometric
 * rather than stylistic. A translated copy leaves a crescent on the far side whose depth
 * goes to zero exactly where the contour runs parallel to the light axis — the right edge
 * just under the crown, and the lower-left edge — so with no inset the darkest step
 * reaches the silhouette at those two tangent points and the reflected-light bounce
 * vanishes exactly where the rim is most visible. Insetting by one leaves a one-pixel
 * bounce all the way round; the lit planes, being translations of the un-inset table,
 * paint straight over it on the light-facing side, so only the shadow side keeps it.
 *
 * `draw_polygon` samples scanlines at pixel centres and offsets its vertices by the same
 * half pixel, so a polygon's last row is never inside the shape; the sacrificial row
 * compensates.
 */
function offsetRows(rows: readonly Row[], inset: number, dx: number, dy: number): Row[] {
  const out: Row[] = [];
  for (const [left, right, y] of rows) {
    const l = left + inset + dx;
    const r = right - inset + dx;
    const moved = y + dy;
    if (r < l || moved < 0 || moved >= CANVAS) continue;
    out.push([l, r, moved]);
  }
  const last = out[out.length - 1];
  if (last) out.push([last[0], last[1], last[2] + 1]);
  return out;
}

/** Close a row table into the fillable polygon `draw_polygon` wants. */
function rowPolygon(rows: readonly Row[]): Point[] {
  const points: Point[] = rows.map(([left, , y]) => ({ x: left, y }));
  for (let index = rows.length - 1; index >= 0; index--) {
    points.push({ x: rows[index]![1], y: rows[index]![2] });
  }
  return points;
}

/**
 * The tonal stack, painted in order, each plane a translation of the silhouette
 * displaced further along the light axis than the last.
 *
 * A plane painted later covers everything the earlier ones covered, so what survives at
 * any point is a crescent of contour width between consecutive displacements. Reading
 * the result from the lower-right edge inward gives the four parts of a lit volume, in
 * this order:
 *
 *   the un-rewritten base tone  - the reflected-light bounce, on the outermost rim
 *   ramp[0]                     - the core shadow, immediately inside the bounce
 *   ramp[2]                     - the halftone
 *   ramp[3]                     - the lit plane
 *   ramp[4]                     - the lit core, a small lens on the light-facing edge
 *
 * Two properties are load-bearing and both come from using translations rather than
 * insets. A translation *reaches* the silhouette's edge everywhere, so the light-facing
 * upper-left edge is covered by the brightest step — an inset plane never does, which is
 * how the previous version ended up with a dark patch on the shoulder nearest the light.
 * And because the displacements grow along the light axis, a horizontal cut crosses at
 * most two boundaries, so the eye follows one gradient across the body instead of a
 * bullseye.
 *
 * The base tone is ramp[1], not ramp[0], which is what leaves room for the bounce to be
 * lighter than the core shadow instead of the core shadow being the outermost thing.
 */
const PLANES = [
  { inset: 0, dx: 0, dy: 0, layer: 'Base', ramp: 1 },
  { inset: 1, dx: -2, dy: -2, layer: 'Shade', ramp: 0 },
  { inset: 0, dx: -5, dy: -5, layer: 'Light', ramp: 2 },
  { inset: 0, dx: -8, dy: -8, layer: 'Light', ramp: 3 },
  { inset: 0, dx: -11, dy: -11, layer: 'Light', ramp: 4 },
] as const;

/** The displacement that puts the lit core on the light-facing edge. */
const LIT_CORE_SHIFT = 11;

/**
 * Alternate pixels along the lit core's inner boundary, which is the one hard step in the
 * stack worth softening: the brightest tone against the lit plane, on the largest area,
 * and the step between them is the first thing the eye finds on a sphere.
 *
 * Derived from the silhouette exactly as the planes are, so the seam follows the same
 * curve as every other boundary in the sprite. It is a *single* pixel wide. A dither band
 * two or three pixels deep at 32x32 stops reading as a transition and becomes the loudest
 * thing in the image, which is why there is exactly one of these and why every other step
 * in the stack stays hard — the ramp is five steps, so a hard step between two adjacent
 * ones is a small enough jump for the eye to accept on its own.
 */
function litCoreSeam(): Point[] {
  const body = silhouetteRows();
  const points: Point[] = [];
  for (const [left, right, y] of body) {
    const source = body.find((row) => row[2] === y + LIT_CORE_SHIFT);
    if (!source) continue;
    // The plane's row for this y, clipped to the body: the seam is where it stops.
    const litLeft = Math.max(left, source[0] - LIT_CORE_SHIFT);
    const litRight = Math.min(right, source[1] - LIT_CORE_SHIFT);
    if (litRight < litLeft) continue;
    // The boundary is a staircase that steps one pixel per row, so a checkerboard keyed on
    // x + y is constant along it and fires on every row or on none. Alternating on the row
    // is what actually makes the seam: half the step pixels drop back to the lit plane, and
    // the staircase turns into a 50% edge.
    if (y % 2 === 0) points.push({ x: litRight, y });
  }
  return points;
}

/**
 * The eyes, as a 3x3 block with a one-pixel pale catchlight in the top left of each.
 *
 * The catchlight is the only specular in the sprite and it does the work twice: it says
 * "wet surface" instead of "green ball", and it is the one place the two neutral entries
 * are used at all. A separate two-pixel white block on the cheek was tried and removed —  * on a 22px head a near-white square sitting on the mid tone reads as a hole in the
 * sprite, not as a highlight, and no amount of moving it fixed that. The eyes are also
 * kept clear of the terminator: a dark pupil drawn on the darkest step of the ramp is a
 * pupil you cannot see.
 */
const EYE_X = [11, 18] as const;
const EYE_Y = 14;
const EYE_SIZE = 3;

/**
 * Crown, as three points on a band, lit by the same upper-left key as the body.
 *
 * Separate polygons rather than one outline, because a single hand-authored profile
 * always closes its own notches: two points whose facing edges both slope away from the
 * valley meet again a couple of rows up, and the notch that makes a crown read as a
 * crown disappears. Spacing the bases apart is the only way to keep real gaps.
 *
 * The middle point is three pixels taller than the side points, which is the smallest
 * difference that reads as hierarchy at this size — a flat or near-flat top reads as a
 * lumpy mass. The bases and apexes are mirrored about x=15.5, so the crown is centred
 * without a mirror pass.
 */
const CROWN_BAND = { x: 8, y: 10, w: 16, h: 3 };
const CROWN_SHAPE: readonly (readonly Point[])[] = [[
  { x: 8, y: 10 },
  { x: 9, y: 6 },
  { x: 11, y: 6 },
  { x: 11, y: 10 },
], [
  { x: 13, y: 10 },
  { x: 13, y: 6 },
  { x: 15, y: 3 },
  { x: 16, y: 3 },
  { x: 18, y: 6 },
  { x: 18, y: 10 },
], [
  { x: 20, y: 10 },
  { x: 20, y: 6 },
  { x: 22, y: 6 },
  { x: 23, y: 10 },
]];

/**
 * The two notches between the points, in the contour colour.
 *
 * This is the whole reason the points are drawn as separate polygons with a gap between
 * their bases. A through-notch shows whatever is behind the crown, and behind the crown
 * is the top of the head — which, under a key light at the upper left, is the *brightest*
 * part of the sprite. A bright green window inside a gold crown does not read as a
 * jewel, it reads as a mistake, and no amount of care elsewhere on the sprite earns it
 * forgiveness.
 *
 * Filling the notch in the contour colour is the standard answer: a crown's points are
 * separated by shadow, and one pixel of dark there is both the read and the reason. The
 * bases are placed two pixels apart rather than one so each notch is exactly one pixel
 * wide, and the points' inner flanks are vertical for the same reason — a notch that
 * tapers is a notch that varies, and a varying notch shows the head again at the top.
 */
const CROWN_NOTCH: readonly Rect[] = [
  { x: 12, y: 6, w: 1, h: 5 },
  { x: 19, y: 6, w: 1, h: 5 },
];

/**
 * The crown's own value structure: a lit face on the key side, a mid body, and a
 * shadowed underside that thickens away from the key.
 *
 * The body gets its planes from the silhouette table because it is a 24-row blob. The
 * crown is a 16x11 object, and there a translation is half the object's width — drawing
 * a "lit plane" as an offset copy detaches it into a second shape floating beside the
 * first, which is worse than the problem it was meant to solve. At this size the honest
 * construction is explicit, and it has to be *regions* rather than one-pixel lines: the
 * previous version stroked light and dark edges and the result was a flat gold mass with
 * a brown bar, because a one-pixel line next to a flat field is not a value.
 *
 * Hard edges between metal tones are correct — metal has a hard terminator and that is
 * how gold reads as gold. What is not correct is rectangles, and the previous three flat
 * blocks of different yellows were rectangles.
 */
const CROWN_LIT_FACE: readonly Point[] = [
  { x: 8, y: 10 },
  { x: 12, y: 10 },
  { x: 12, y: 11 },
  { x: 8, y: 11 },
];
const CROWN_SHADOW: readonly Point[] = [
  { x: 16, y: 11 },
  { x: 19, y: 10 },
  { x: 23, y: 10 },
  { x: 23, y: 12 },
  { x: 16, y: 12 },
];

/** The left flank and top of each point: the sides the key is on. */
const CROWN_LIT_FLANK: readonly (readonly Point[])[] = [
  [{ x: 8, y: 10 }, { x: 9, y: 6 }, { x: 10, y: 6 }],
  [{ x: 13, y: 10 }, { x: 13, y: 6 }, { x: 15, y: 3 }],
  [{ x: 20, y: 10 }, { x: 20, y: 6 }, { x: 21, y: 6 }],
];

/** The middle point's right flank, which faces away from the key entirely. */
const CROWN_DARK_FLANK: readonly Point[] = [
  { x: 16, y: 3 },
  { x: 18, y: 6 },
  { x: 18, y: 9 },
];

/**
 * The single bright accent, on the band's lit face.
 *
 * Gold reads as metal because of one bright accent *against* a mid tone. Without it the
 * crown is three steps of yellow arranged by arithmetic; with it, it has a highlight.
 */
const CROWN_SPECULAR = { x: 9, y: 10, w: 2, h: 1 };

/**
 * The line where the crown meets the head, in the contour colour.
 *
 * Without it the crown's mid tone sits directly on the head's lit tone and the two
 * materials merge into a single shape. It is the contact shadow, not a form shadow, and
 * it is one pixel for the same reason the crown's shadow regions are one or two: this is
 * a 16x11 object and everything about it is measured in single pixels.
 */
const CROWN_SEAT: readonly Point[] = [
  { x: 9, y: 12 },
  { x: 15, y: 12 },
  { x: 22, y: 12 },
];

export interface DemoResult {
  ok: true;
  command: 'demo';
  sprite: string;
  path: string;
  source: string;
  width: number;
  height: number;
  canvas: { width: number; height: number };
  scale: number;
  palette: number;
  layers: readonly string[];
  frames: number;
  tags: string[];
  /** How many real commands went through the bus, for the JSON summary. */
  commands: number;
  bytes: number;
}

export interface DemoOptions {
  /** Destination directory. Defaults to `crowned-slime` beside the working directory. */
  out?: string;
  /** Nearest-neighbour multiple for the exported PNG. */
  size?: number;
}

/**
 * Run one command on the bus and hand back its summary.
 *
 * A demo that quietly swallowed a failed command would be worse than no demo: the
 * person running it would see a picture and assume the engine produced it. Any
 * failure is fatal and names the command.
 */
function step(
  editor: Editor,
  count: { value: number },
  command: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const result = editor.tryExecute(command, params);
  count.value++;
  if (!result.ok) {
    throw new Error(`demo: ${command} failed (${result.code}): ${result.error}`);
  }
  return result.summary;
}

/**
 * Palette indices of a ramp, read back from the ramp command's own summary.
 *
 * Reading them instead of hard-coding `2..6` is what keeps the demo honest: every colour
 * painted afterwards is provably a swatch of the palette the document ships with,
 * whatever order the ramps happened to be appended in.
 */
function rampIndices(summary: Record<string, unknown>, name: string): number[] {
  const indices = summary.paletteIndices;
  if (!Array.isArray(indices) || indices.length === 0) {
    throw new Error(`demo: add_palette_ramp returned no palette indices for ${name}`);
  }
  return indices as number[];
}

/**
 * Build the sprite and return the finished document.
 *
 * Exported separately from the command so a test can check the document without
 * touching the filesystem.
 */
export function drawDemoSprite(): { sprite: Sprite; commands: number } {
  const sprite = createSprite({
    width: CANVAS,
    height: CANVAS,
    name: SPRITE_NAME,
    layers: [...LAYERS],
  });
  // The default registry is exactly `allCommands`; naming it makes the point that the
  // demo draws with the same catalogue the UI, the CLI and the MCP server share.
  const editor = createEditor(sprite, createRegistry(allCommands));
  const count = { value: 0 };
  const run = (command: string, params: Record<string, unknown>) => step(editor, count, command, params);

  // Palette first, so every later colour can be named as a swatch rather than a hex.
  // The two neutrals are seeded explicitly and the ramps append after them, which is
  // why the contour and the specular are plain indices and the ramps are not.
  // `hueShift` is what separates the two materials: the same parameter warms the
  // slime's highlights toward yellow and cools its core shadow toward blue-green.
  run('set_palette', { name: SPRITE_NAME, colors: [OUTLINE, PALE] });
  const jelly = rampIndices(
    run('add_palette_ramp', {
      from: '#0f5a34',
      to: '#b6ec72',
      steps: 5,
      hueShift: 12,
      role: 'jelly',
    }),
    'jelly',
  );
  const gold = rampIndices(
    run('add_palette_ramp', {
      from: '#8c4a12',
      to: '#ffd35c',
      steps: 3,
      hueShift: 10,
      role: 'gold',
    }),
    'gold',
  );
  const outline = 0;
  const pale = 1;

  /* ---------------------------------------------------------------- planes -- */

  // The tonal stack. What survives at each point is the darkest plane that does not
  // cover it, which is a value ramp falling off away from the upper-left key light
  // across the whole body, with every boundary parallel to the contour.
  // One flat silhouette in the base tone, which is the second-darkest ramp step. The
  // core-shadow band is then painted *into* it, which is what leaves the outer rim one
  // step lighter: that rim is the reflected-light bounce, and it is the only thing
  // stopping the lower right from going dead.
  const body = silhouetteRows();
  for (const plane of PLANES) {
    const rows = offsetRows(body, plane.inset, plane.dx, plane.dy);
    if (rows.length < 2) continue;
    run('draw_polygon', {
      layer: plane.layer,
      frame: 0,
      points: rowPolygon(rows),
      color: `pal:${jelly[plane.ramp]}`,
      fill: true,
      // The base plane is the body itself; everything above is clipped to it, which is
      // what keeps a displaced plane from spilling onto the canvas.
      ...(plane.layer === 'Base' ? {} : { clip: 'composite' }),
    });
  }
  // The one softened step in the stack, drawn straight onto the lit plane.
  const seam = litCoreSeam();
  if (seam.length > 0) {
    run('draw_pixels', {
      layer: 'Light',
      frame: 0,
      pixels: seam.map((point) => ({ ...point, color: `pal:${jelly[3]}` })),
    });
  }

  /* ----------------------------------------------------------------- crown -- */

  // One mid body, a lit face on the key side, a shadowed underside thickening away from
  // it, a light line down each point's key-facing flank, and one bright accent. Same
  // upper-left key as the body, so the two materials agree about where the light is.
  run('draw_rect', { layer: 'Crown', frame: 0, rect: CROWN_BAND, color: `pal:${gold[1]}`, fill: true });
  for (const point of CROWN_SHAPE) {
    run('draw_polygon', { layer: 'Crown', frame: 0, points: point, color: `pal:${gold[1]}`, fill: true });
  }
  run('draw_polygon', { layer: 'Crown', frame: 0, points: CROWN_LIT_FACE, color: `pal:${gold[2]}`, fill: true });
  run('draw_polygon', { layer: 'Crown', frame: 0, points: CROWN_SHADOW, color: `pal:${gold[0]}`, fill: true });
  for (const flank of CROWN_LIT_FLANK) {
    run('draw_polyline', { layer: 'Crown', frame: 0, points: flank, color: `pal:${gold[2]}` });
  }
  run('draw_polyline', { layer: 'Crown', frame: 0, points: CROWN_DARK_FLANK, color: `pal:${gold[0]}` });
  run('draw_rect', { layer: 'Crown', frame: 0, rect: CROWN_SPECULAR, color: `pal:${pale}` });
  run('draw_polyline', { layer: 'Crown', frame: 0, points: CROWN_SEAT, color: `pal:${outline}` });
  // Last, so nothing paints over the notches: they are gaps, and a gap filled with head
  // colour is the defect this whole arrangement exists to prevent.
  for (const notch of CROWN_NOTCH) {
    run('draw_rect', { layer: 'Crown', frame: 0, rect: notch, color: `pal:${outline}` });
  }

  /* ------------------------------------------------------------------ face -- */

  // Three by three is the smallest eye that reads as an eye at a glance. Both catchlights
  // sit top-left, facing the key light, so the face is lit by the same source as the
  // body. The whole face is kept up-left of the terminator: a dark pupil drawn on the
  // core shadow is a pupil you cannot see, which is exactly what happened to the mouth's
  // right-hand end in the previous version. A clear row separates the eyes from the
  // mouth, because touching them turns a face into one dark mass.
  for (const x of EYE_X) {
    run('draw_rect', {
      layer: 'Face',
      frame: 0,
      rect: { x, y: EYE_Y, w: EYE_SIZE, h: EYE_SIZE },
      color: `pal:${outline}`,
    });
  }
  run('draw_pixels', {
    layer: 'Face',
    frame: 0,
    pixels: EYE_X.map((x) => ({ x, y: EYE_Y, color: `pal:${pale}` })),
  });
  run('draw_pixels', {
    layer: 'Face',
    frame: 0,
    pixels: [
      { x: 13, y: 18 },
      { x: 14, y: 18 },
      { x: 15, y: 18 },
      { x: 16, y: 18 },
      { x: 17, y: 18 },
      { x: 18, y: 18 },
    ].map((pixel) => ({ ...pixel, color: `pal:${outline}` })),
  });

  /* --------------------------------------------------------------- outline -- */

  // Traced from the frame rather than from one layer, so the crown and the body get a
  // single continuous contour and the seams between them stay open. `outside` grows the
  // shape, which is why the artwork is inset from the canvas edge.
  run('outline', { layer: 'Outline', frame: 0, color: `pal:${outline}`, scope: 'composite' });

  // Nothing above this line introduced a colour that is not already a swatch, so this
  // pass has nothing to change. It is here as a proof, and as the guard that keeps the
  // demo honest if someone adds a pass later.
  run('quantize_to_palette', { dither: 'none' });

  /* ------------------------------------------------------------- animation -- */

  // A one-pixel hover rather than a non-integer squash: `squash` would resample a
  // 22px silhouette unevenly, and uneven pixel widths are the fastest way to make
  // deliberate pixel art look like a scaled bitmap.
  run('duplicate_frame', { frame: 0, count: 1 });
  run('translate', { layer: '*', frame: 1, dx: 0, dy: -1 });
  run('add_tag', { name: 'idle', from: 0, to: 1, repeat: 0 });
  run('set_frame_durations', {
    updates: [
      { frames: 'all', durationMs: 260 },
      { frames: [1], durationMs: 110 },
    ],
  });

  return { sprite: editor.sprite, commands: count.value };
}

/** Build the sprite and write both the PNG and the editable source next to it. */
export async function runDemo(options: DemoOptions = {}): Promise<DemoResult> {
  const size = options.size ?? 8;
  if (!Number.isInteger(size) || size < 1 || size > 16) {
    throw new UsageError('--size expects an integer from 1 to 16');
  }

  const { sprite, commands } = drawDemoSprite();

  const directory = resolve(options.out ?? FILE_STEM);
  const path = resolve(directory, `${FILE_STEM}.png`);
  const source = resolve(directory, `${FILE_STEM}.pixel`);

  const frame = resolveFrame(sprite, 0);
  const buffer = compositeFrame(sprite, frame.id);
  const bytes = encodePNG(size === 1 ? buffer : buffer.scale(size));

  await writeBytes(path, bytes);
  await saveSprite(source, sprite);

  return {
    ok: true,
    command: 'demo',
    sprite: sprite.name,
    path,
    source,
    width: buffer.width * size,
    height: buffer.height * size,
    canvas: { width: sprite.width, height: sprite.height },
    scale: size,
    palette: sprite.palette.colors.length,
    layers: sprite.layers.map((layer) => layer.name),
    frames: sprite.frames.length,
    tags: sprite.tags.map((tag) => tag.name),
    commands,
    bytes: bytes.length,
  };
}

export const demoCommand: CommandSpec = {
  name: 'demo',
  summary: 'Draw and export a finished sprite with no arguments, no file and no palette',
  usage: 'pixel demo [--out <dir>] [--size <n>]',
  async run(ctx: CommandContext) {
    const result = await runDemo({
      ...(stringFlag(ctx.args.flags, 'out') !== undefined ? { out: stringFlag(ctx.args.flags, 'out')! } : {}),
      ...(intFlag(ctx.args.flags, 'size') !== undefined ? { size: intFlag(ctx.args.flags, 'size')! } : {}),
    });
    // stdout stays exactly one JSON object. The one human line goes to stderr,
    // because "here is the file to open" is the entire point of this command and
    // nobody is going to read a JSON path in a terminal.
    process.stderr.write(`pixel demo -> ${result.path}\n  editable source: ${result.source}\n`);
    printJson(result);
    return 0;
  },
};
