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
- Outline colour should be a dark, desaturated version of the neighbouring fill,
  not black.

## 5. Shading and texture

- \`dither_fill\` with \`pattern: "bayer4"\` or \`"checker"\` is the classic way to make
  a third shade out of two colours, or to blend a gradient on a small canvas.
  Keep dithered areas small - a 1px checker over a large area turns to noise.
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

- \`get_preview\` renders the composited frame (or all frames) as a PNG you can
  actually see. Use it constantly - after the silhouette, after shading, after
  outlining. Never chain twenty edits blind.
- \`get_pixels\` returns a small region as text when you need exact coordinates.
- \`measure_region\` tells you where the opaque pixels actually are, which is how
  you centre a sprite without guessing.
- If a pass makes things worse, \`undo\` it. Undo is cheap; guessing is not.

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
  'look at get_preview, then shade with a hue-shifted ramp, then outline selectively. ' +
  'Read pixel://skill for the full guide before drawing anything non-trivial.';
