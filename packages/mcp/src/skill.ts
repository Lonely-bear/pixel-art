/**
 * The pixel-art craft guide served as `pixel://skill` and injected by prompts.
 *
 * Tools alone produce technically-valid mush. What separates a sprite that reads
 * as a character from one that reads as noise is craft: silhouette first, a
 * deliberate ramp, selective outlines, controlled dithering. That knowledge is
 * not in the API surface, so it ships as a document the model can read.
 */
export const SKILL_URI = 'pixel://skill';

export const PIXEL_ART_SKILL = `# Pixel art craft guide

You are drawing with a tool that gives you exact control over every pixel. That is
both the opportunity and the trap: nothing stops you from producing mud. Work in
passes, and look at the result between passes.

## 1. Plan the canvas before drawing

- Ask for the sprite size the game needs (16x16, 32x32, 48x48...). Do not invent a
  huge canvas "for detail" - small canvases force readable shapes.
- Work on separate layers. A normal stack is: \`base\` (filled shapes) -> \`shade\`
  (light and shadow) -> \`outline\` (contour). Use \`add_layer\` and pass \`layer\` to
  every draw call.
- Lock or hide layers you are not editing so you do not accidentally repaint them.

## 2. Silhouette first, colour last

1. Block the whole subject in a single flat colour on \`base\`. Check the silhouette
   by looking at \`get_preview\`. If it is not recognisable as a solid shape, no
   amount of shading will save it.
2. Only then add shading. Decide where the light comes from (top-left is the
   convention) and stay consistent.
3. Add the outline last.

## 3. Colour

- Prefer a palette. \`create_document\` accepts \`palette: "dawnbringer16"\` or
  \`"endesga16"\`; you can also pass explicit hex values. A constrained palette is
  the single biggest quality win.
- Use a **ramp**: for each material pick 3-4 colours that step in hue as well as in
  value. Shadow steps should shift toward blue/purple, highlights toward
  yellow/orange. A pure brightness ramp looks dull and plastic.
- Never use pure black (\`#000000\`) as a shadow or pure white as a highlight. Use
  near-black and near-white; reserve the extremes for outlines if anything.
- Keep the number of materials small: skin, cloth, metal, and one accent is enough
  for a character.
- Lock the palette down. Pass \`paletteLocked: true\` to \`create_document\` and every
  colour a command writes is snapped to the nearest swatch, so a slightly-off hex
  becomes the nearest ramp step instead of inventing a new colour. Alpha is preserved,
  so a translucent cape still works.

## 4. Outlines

- \`outline\` with \`mode: "outside"\` adds a contour around the opaque silhouette.
- By default \`outline\` traces only the layer you name. Pass \`scope: "composite"\` to
  trace the whole frame as the other layers define it - that is how you get a contour
  onto its own layer without having to draw the silhouette there too.
- Selective outlining reads better than a closed contour: outline the bottom and
  sides in a dark version of the local colour, and drop the outline where the light
  hits. There is no single command for that - draw it deliberately, or run
  \`outline\` and then erase the lit segments with \`clear_region\` or a draw with
  \`color: null\`.
- Faint or semi-transparent pixels count as solid by default, so a soft glow gets
  traced as a hard outline. Pass \`alphaThreshold\` (0-255) to ignore pixels below that
  alpha - e.g. \`alphaThreshold: 200\` to skip a 0.2-opacity halo.
- Outline colour should be a dark, desaturated version of the neighbouring fill,
  not black.

## 5. Shading and texture

- \`dither_fill\` with \`pattern: "bayer4"\` or \`"checker"\` is the classic way to make
  a third shade out of two colours, or to blend a gradient on a small canvas.
  \`level\` is the coverage: \`0.5\` is the even checker, \`0.25\` a sparse hint of the new
  shade, \`0.75\` mostly the new shade. \`bayer4\`/\`bayer8\` read as an ordered gradient;
  \`dots\`, \`sparse\` and \`dense\` read as irregular texture. Keep dithered areas small -
  a 1px checker over a large area turns to noise.
- \`dither_fill\` with \`pattern: "sparse"\` reads as texture (dirt, cloth, grain).
- \`draw_line\` with a translucent colour and \`blend\` is an alternative for
  soft-edged shading, but hard-edged ramps are usually better pixel art.
- Banding is the classic error: two adjacent shades whose boundary is a straight
  line. Break the boundary with single-pixel steps.
- Keep shading inside the sprite. Pass \`clip: "composite"\` to any draw command and it
  will only paint where the *other* layers already have pixels, so a shadow ellipse
  cannot spill into the transparent corners of its bounding box. This is the difference
  between shading a blob and shading a rectangle that happens to contain a blob.
- \`clip: "cel"\` clips against the layer you are drawing into, for when you want to
  repaint or erase existing pixels without touching empty space.
- \`clip\` also takes a layer reference. \`clip: {layer: "hair"}\` confines paint to the
  pixels on that named layer, and \`clip: {layers: ["hair", "cape"]}\` to their union.
  Use it to shade one part - hair, robe, cape - without touching the rest of the body,
  rather than clipping to the whole silhouette and then erasing the spill.
- Watch the layer order: clipping to a layer that renders *above* the one you are
  painting means the paint is hidden behind it. Shading the hair while painting on a
  shared \`shade\` layer *below* \`hair\` produces invisible pixels - paint on the hair
  layer itself (or above it). The tool returns a \`warning\` when it detects this.
- \`replace: true\` on \`draw_rect\`, \`draw_ellipse\`, \`draw_polygon\` and \`dither_fill\`
  erases the pixels the shape covers before painting them. Use it when redrawing over
  an earlier pass: without it, a second dithered band over the first stacks the stipple
  and reads twice as dark. It only clears the pixels the **new** shape covers, so
  shrinking a shape leaves the old footprint behind - \`clear_region\` the layer when you
  redesign a large area.
- \`draw_line\` takes a \`width\` (1-64) for thick strokes - staffs, limbs, hair strands.
  The band is perpendicular and roughly centred, but it overshoots each endpoint by up
  to half the width and even widths bias +0.5px, so a tapered limb is better as a
  \`draw_polygon\`.
- A dithered transition band can follow a curve. \`dither_fill\` takes a \`shape\` -
  \`{ellipse: rect}\` or \`{polygon: [points]}\` - as well as a \`rect\`, so the band between
  two shades can trace the boundary instead of being a box. Omit both to stipple the
  whole cel. Every paint command (\`draw_rect\`, \`draw_ellipse\`, \`draw_polygon\`,
  \`draw_line\`, \`fill\`, \`draw_pixels\`) also takes \`pattern\` and \`level\` directly, so a
  dithered shape is one call and lands on exactly the pixels a solid one would.

## 6. Anti-aliasing

- Use it sparingly, only on curves and only on the outside of a shape.
- Place a mid-tone between the fill and the outline or background, never a
  full-strength blend, and never on a straight horizontal or vertical edge.
- \`draw_pixels\` with an explicit colour is the right tool; do not reach for
  blur-like effects.

## 7. Animation

- Animate by duplicating a frame (\`duplicate_frame\`) and moving one thing. Keep
  the parts that should not move identical between frames.
- 2-4 frames is enough for a walk cycle at small sizes; 6-8 for a full run.
- Set frame durations explicitly with \`update_frame\` (100-150 ms is a normal
  baseline; a run cycle is faster than a walk).
- Tag the sequences you intend to export: \`add_tag\` with \`from\`/\`to\` indices and
  a \`direction\` of \`forward\`, \`reverse\` or \`pingpong\`. \`pingpong\` halves the
  frames you have to draw for a breathing or idle loop.
- For a squash-and-stretch or bounce, move the whole silhouette, not individual
  limbs. \`translate {layer: "*", dx, dy}\` shifts every layer of the frame together and
  clears the band it vacates, so a bob costs one operation instead of a copy plus a
  clear per layer. \`squash {layer: "*", scaleX, scaleY, pivot: "bottom"}\` scales about a
  pivot with nearest-neighbour sampling and keeps the canvas size, so the artwork stays
  registered: \`scaleY: 0.9, scaleX: 1.08\` on the down beat, the reverse on the up beat.
  Pass \`layer: "*"\` so all layers share one pivot - scaling them separately shears the
  sprite. Order matters when you use both: \`squash\` first, then \`translate\`, because
  \`translate\` clears the band it vacates and would wipe out the squashed artwork if it
  ran first. A named pivot is measured against the artwork's bounding box, which
  includes any outline you have drawn - so \`pivot: "bottom"\` sits on the outline's
  bottom row, one pixel below the body.
- Check the loop: the last frame should lead back into the first. Look at the
  sprite sheet, not just the individual frames.

## 8. Iterating

- The fastest draw→look loop is one call: pass \`preview: true\` to \`run_script\` or
  \`apply_ops\`, plus \`previewOptions: {scale: 4}\` (and optionally \`frame\`, \`rect\`,
  \`layers\`, or \`background\`). The command result and a real PNG come back together,
  so do not spend a second call on \`get_preview\` immediately afterwards.
- Look after the silhouette, after major lighting/material work, and once at the
  end. Two or three visual gates catch nearly all composition problems; a long chain
  of tiny speculative edits is slower and usually less coherent.

- \`get_preview\` renders the composited frame (or all frames) as a PNG you can
  actually see. Use it when no edit was made, or when a mutation did not request
  an inline preview. Never chain twenty edits blind.
- By default \`get_preview\` shows the sprite at up to ~256px on its longest side, so a
  large canvas (256x256 or more) comes back at 1:1 and fine detail is hard to judge.
  Pass \`scale: 4\` (up to 32) to zoom in, and \`frame\`/\`layers\` to isolate what you are
  working on. Pass \`rect: {x, y, w, h}\` to crop-zoom a detail - a face, a hand, a staff
  head - at full scale instead of exporting a file. The same crop can ride along
  in a mutation's \`previewOptions\`, so fixing and inspecting a detail is one call.
- \`get_pixels\` returns a small region as text when you need exact coordinates.
- \`measure_region\` tells you where the opaque pixels actually are, which is how
  you centre a sprite without guessing.
- \`get_document\` nests the counts under \`document\` (\`document.layerCount\` /
  \`document.frameCount\` / \`document.tagCount\`, all numbers); the actual \`layers\` /
  \`frames\` arrays are at the **top level**, in bottom-first paint order. Only layers
  with cels on a frame appear in \`frames[].layers\`.
- If a pass makes things worse, \`undo\` it. Undo is cheap; guessing is not. \`undo\` /
  \`redo\` take \`steps\` (alias \`count\`) to move several edits at once. A single
  \`apply_ops\` batch is **not** one undo step - every op in it is its own history entry.
  (A \`run_script\` script, by contrast, folds into one step.) \`get_history\` lists
  recent commands with their summaries.
- Working on a scratch document? \`create_document\` accepts \`select: false\` so it does
  not steal focus from the document you are actually drawing. \`select_document\` takes a
  document id **or** its name.
- \`export_png\` returns \`absolute\` as an **array** (one entry per written file), while
  \`save_document\` returns it as a **string**. \`get_preview\` echoes the zoom factor as
  both \`scale\` and \`upscale\`.
- At the end, \`finalize_document\` saves the \`.pixel\` source and writes one or more
  PNG exports in a single call. A usual static asset is a scale-1 original plus a
  scale-6/8 preview. Keep \`save_document\` plus repeated \`export_png\` calls only when
  independent incremental writes are actually needed.

## 9. Coordinates and conventions

- Origin is the **top-left**, x grows right, y grows **down**, pixels are
  zero-based. \`{x: 0, y: 0}\` is the top-left pixel; the bottom-right of a 16x16
  sprite is \`{x: 15, y: 15}\`.
- Rectangles are \`{x, y, w, h}\` where \`w\`/\`h\` are counts, so a rect at \`x:0\` with
  \`w:16\` spans the full width.
- Layers are referenced by name, id, or index where index 0 is the **bottom**
  layer. Prefer names; they survive reordering.
- Frames are referenced by id or index.
- Drawing outside the canvas is silently clipped, never an error.
- \`draw_ellipse\` is **inscribed in its rect** - the ellipse touches all four sides, so
  \`{x:5, y:8, w:22, h:22}\` is a full circle whose bottom edge is \`y = 29\`. A flat-bottomed
  dome is not an ellipse: either use an ellipse whose bottom equals the baseline, or cut
  the bottom off with \`clear_region\`.
- Shape commands take the colour once, as a \`color\` parameter. \`draw_pixels\` is
  different: it has **no** top-level colour, and every entry in \`pixels\` carries its own
  \`color\` (which may be \`null\` to erase). That is how you draw several colours, or erase
  some pixels and paint others, in one call.

## 10. Working with a game engine

- \`export_sheet\` writes a spritesheet PNG plus Aseprite-compatible JSON that
  Unity, Godot, Phaser and LÖVE all read. Godot and Unity want a power-of-two
  layout: use \`layout: "grid"\` and pick \`columns\` accordingly.
- \`export_png\` writes a single composited frame; use it for icons and previews.
- Set frame durations in the document rather than in the engine so the exported
  JSON carries the timing.
- Leave a 1px transparent margin between frames in a sheet (\`padding: 1\`) or
  engines will bleed neighbouring frames when filtering.
- \`export_gif\` writes an animated GIF. Omit \`tag\` and every frame goes in order;
  pass one and the tag's \`direction\` and \`repeat\` decide the frame order and the
  looping, so a \`pingpong\` idle bounces without you duplicating any frames. Add
  \`scale\` for a larger preview and \`background\` if the target cannot show
  transparency.
- The GIF, the sheet and the per-frame PNGs all read their frame order from the
  same \`animationSequence\` the editor's preview uses, so what plays on the canvas
  is what gets written. If a loop looks wrong on the canvas, it will be wrong in
  the file.
- \`import_image\` opens an Aseprite \`.ase\` file as well as a PNG, and an Aseprite
  file brings its own layers, frames, durations and animation tags with it. That
  is the easiest way to start from art someone already drew.

## 11. Things that look bad

- Pillow shading: a highlight ring inside the silhouette that ignores the light
  direction. Shade in bands, not rings.
- A closed pure-black outline around everything.
- Dithering everywhere instead of in a few transition bands.
- Too many shades of the same colour with no hue shift.
- Jagged curves: pixel art curves should be smooth when viewed at 100%. Step
  lengths on a curve should change gradually, e.g. 2,1,1,2,1,1 - never 4,1,4.
- Redrawing everything each frame when \`translate\` or \`squash\` would move it in one operation.

## 12. Tilemaps and auto-tiling

A tilemap is a grid of tile indices, separate from the sprite's pixel layers. It is the
right structure for terrain, walls and floors: cheaper to edit, and it exports straight
into a game engine.

- Cut a tileset out of artwork you have already drawn: \`create_tileset { layer, frame,
  tileWidth, tileHeight, columns }\` slices that layer into a grid of tiles. Draw the tile
  sheet once as a normal image, then cut it.
- \`add_tilemap { width, height, tileWidth, tileHeight }\` makes an empty grid; \`-1\` means
  empty. \`set_tile\` writes one cell or a batch of \`tiles\`, \`fill_tilemap\` fills a rect or
  the whole map, \`resize_tilemap\` grows or shifts the grid, \`remove_tilemap\` deletes it.
- \`autotile\` is the reason to use a tilemap at all. Lay the terrain down with a single
  placeholder index, then let it choose the transition tiles:
  \`autotile { tilemap, set: 47, offset: 1, indices: [1] }\`.
  - \`set: 16\` uses only the four edge neighbours - 16 tiles, the classic cheap set.
  - \`set: 47\` uses all eight, and counts a diagonal only when both of its adjacent edges
    are also solid. That rule is what makes 47 tiles enough for every possible blob shape,
    and it is what stops corners from looking chipped.
  - \`offset\` is the first tile index of this terrain in the sheet, so one sheet can hold
    several terrains.
  - The tile order is fixed, so your sheet has to match it. The neighbour bits are
    N=1, E=2, S=4, W=8, NE=16, SE=32, SW=64, NW=128, and the tile index for a cell is
    \`offset\` plus the position of its mask in that canonical list, ascending - so with
    \`offset: 0\`, tile 0 is the fully isolated cell and tile 46 the fully enclosed one.
    In other words, draw your sheet in ascending mask order starting at \`offset\`.
  - Re-running \`autotile\` needs care: the pass replaces your placeholder index with
    transition tiles, so the same \`indices\` list no longer describes the terrain and a
    second identical call silently leaves the map wrong. After editing terrain, re-run
    with \`indices\` omitted - then any non-empty cell counts as solid.
  - The pass only rewrites cells that are already terrain, so the empty background stays
    empty. Pass \`only\` to narrow it further, or \`skipIsolated\` to leave single cells alone.
- \`paint_tilemap\` bakes the grid into a normal pixel layer, which is how a tilemap becomes
  a PNG or part of a spritesheet. \`get_tilemap\` reads the cells back as rows of indices
  when you need to inspect or verify a level.
- \`export_tiled\` writes a Tiled \`.tmj\` map with one tile layer per tilemap, ready for a
  level editor.
- A tilemap is for things that repeat on a grid. A pixel layer is for everything else.
`;

/** Short, always-included preamble for prompts that do not need the full guide. */
export const SKILL_SUMMARY =
  'Pixel art workflow: block the silhouette in one flat colour on a base layer, ' +
  'return a 4x inline preview from the same run_script/apply_ops call, then shade with a ' +
  'hue-shifted ramp and outline selectively. Use two or three visual gates, and finish ' +
  'with one finalize_document call. Read pixel://skill before drawing anything non-trivial.';

/** URI of the scripting/plugin guide resource. */
export const SCRIPT_GUIDE_URI = 'pixel://script-guide';

/**
 * The scripting guide served as `pixel://script-guide`.
 *
 * The tool list tells an agent *that* `run_script` and `load_plugin` exist; this
 * tells it how to use them well, and exactly what the sandbox does and does not
 * allow, so it does not waste a call discovering the boundary by failure.
 */
export const SCRIPT_GUIDE = `# Scripting and plugins

\`run_script\` executes JavaScript against the current document inside a hardened
\`node:vm\` sandbox. It is the escape hatch for anything the fixed command set does
not cover: procedural patterns, maths-heavy placement, reading many pixels at once,
or looping an edit over every frame.

For a visual iteration, pass \`preview: true\` and \`previewOptions: {scale: 4}\`; the
PNG is returned with the script result, so no follow-up \`get_preview\` call is needed.
Use \`expectedVersion\` when another editor may have changed the document since your
last read. \`finalize_document\` saves the source and writes PNG exports in one call.

## What the sandbox gives you

- \`exec(command, params)\` runs a normal editor command and throws on failure.
  \`tryExec(command, params)\` returns \`{ ok, summary }\` or \`{ ok:false, error, code }\`
  instead of throwing. Use \`exec\` when a failure should abort the script.
- \`commands()\` lists every available command as \`{ name, description, readOnly }\`.
  \`command(name)\` returns one command's full JSON Schema, or \`null\`.
- Read state: \`document()\`, \`layers()\`, \`frames()\`, \`tags()\`, \`palette()\`,
  \`getPixel(x, y, layer?, frame?)\` and \`sample(x, y, frame?)\` (the composited colour).
- \`log(...)\` records output; everything logged is returned in the tool result's \`logs\`.
- The script's return value is JSON-serialised into \`result\`. Return a plain object
  or array; functions and class instances are not preserved.

## What it does not allow

- No \`require\`, \`process\`, \`module\`, filesystem or network access.
- No \`eval\` or \`new Function\` - dynamic code generation is disabled at the context
  level, so the usual sandbox-escape tricks do not even start.
- A wall-clock timeout (default 2000 ms, override with \`timeoutMs\`). An infinite
  loop is killed and reported as \`Script timed out after Nms\`.

## Undo

A whole script is **one undo step**. Every \`exec\` inside it folds into a single
history entry, so a script that makes fifty edits is undone with one \`undo\`. A
script that only reads leaves the history untouched.

## Example

\`\`\`js
// Stamp a checkerboard of the palette's first colour across the base layer.
const base = layers()[0].id;
const { colors } = palette();
const size = 16;
for (let y = 0; y < size; y += 2) {
  for (let x = 0; x < size; x += 2) {
    exec('draw_pixels', {
      layer: base,
      frame: 0,
      pixels: [{ x, y, color: 'pal:0' }],
    });
  }
}
log('stamped', colors.length, 'colours available');
return { done: true };
\`\`\`

Colours accept the palette shorthand everywhere: the number \`3\` or the string
\`"pal:3"\` resolve against the document palette, so scripts can stay in palette terms.

## Example: read, then edit

\`getPixel\` and \`sample\` return \`{r, g, b, a}\` (or \`null\`), so a script can inspect the
artwork and act on what it finds. This mirrors the bottom layer in place:

\`\`\`js
const base = layers()[0].id;
const doc = document();
const pixels = [];
for (let y = 0; y < doc.height; y++) {
  for (let x = 0; x < doc.width; x++) {
    const c = getPixel(x, y, base);
    if (c && c.a > 0) pixels.push({ x: doc.width - 1 - x, y, color: c });
  }
}
exec('draw_pixels', { layer: base, frame: 0, pixels });
return { mirrored: pixels.length };
\`\`\`

Batch the writes into one \`draw_pixels\`/shape call where you can; a command per pixel
is slow and creates a lot of work for the editor, even though it is still one undo step.

## Plugins

\`load_plugin\` takes a script that calls \`defineCommand\`:

\`\`\`js
defineCommand({
  name: 'frame_border',
  description: 'Draw a one-pixel border around every frame.',
  params: {
    color: { type: 'color', required: true, description: 'Border colour.' },
    inset: { type: 'int', min: 0, default: 0 },
  },
  run(api, { color, inset }) {
    const doc = api.document();
    for (let i = 0; i < doc.frames.length; i++) {
      api.exec('draw_rect', {
        layer: doc.layers[0].id,
        frame: i,
        rect: { x: inset, y: inset, w: doc.width - inset * 2, h: doc.height - inset * 2 },
        color,
        fill: false,
      });
    }
    return { frames: doc.frames.length };
  },
});
\`\`\`

Each \`defineCommand\` becomes a real command: it appears in the MCP tool list (and
\`list_commands\` / \`pixel://commands\`), is callable from other scripts via \`exec\`,
and runs against the caller's draft, so it folds into the same single undo step.
Parameter specs use \`type\`: \`number\`, \`int\`, \`boolean\`, \`string\`, \`color\`, \`layer\`,
\`frame\`, \`rect\`, \`point\` or \`json\`, with optional \`required\`, \`default\`, \`description\`,
\`min\`, \`max\` and \`values\` (an enum for strings). \`list_plugins\` shows what is loaded.
`;
