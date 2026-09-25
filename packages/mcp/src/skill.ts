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

## 0. Hard rules

These are the rules that separate a piece that reads as art from one that reads as a
render. Break them and no amount of extra shading recovers the result.

1. **Judge at 100% first.** Pixel art is a 1:1 medium. Always look at a 256x256 canvas
   at \`scale: 1\` before you decide anything. A 2x-4x zoom turns \`cluster2\`'s 2x2 blocks
   into an obvious dot grid and will make you delete dithering that is correct.
   Zoom is for inspecting one detail, never for judging the whole piece.
2. **Dither is for the 3-5px seam between two tones, and nothing else.** A seam under
   about 8px reads as a transition; a low-coverage dither spread over a large area
   reads as a mechanical lattice, not a tone. Most "my gradients look dirty" problems
   are one dithered field that is three times too big.
3. **Never build a glow out of dithered ellipses.** A large light-colour stipple always
   reads as a dot cloud. A glow is the *shape of the gradient*: bulge the surrounding
   bands toward the light source, or use two or three solid concentric steps of
   adjacent palette entries.
4. **Shade only where the pixels are visible.** A layer's visible band runs from its own
   crest down to the crest of the layer above it. A tonal band placed below that line
   is invisible, and invisible shading is a flat-looking sprite.
5. **A perfect circle reads as a balloon.** Foliage, rocks, clouds and crowns need an
   irregular outline: a 7-9 point polygon with radii varied by roughly +/-25%.
6. **Break procedural rhythm deliberately.** Repeated shapes at even spacing and even
   size read as wallpaper or a hedge. Vary spacing by about +/-30% and size by +/-40%,
   and skip some positions outright.
7. **Fewer than about three strong full-width edges, or the piece goes flat.** Horizontal
   stripes are the default failure of environmentals. Many gentle steps are a gradient
   and are fine; a run of *unrelated, strong* steps is the problem. Break them with one
   vertical or diagonal element - a light path, a waterfall, a foreground silhouette.
   \`quality_report\` reports \`structure.strongBands\` for exactly this.
8. **If the preview contradicts your data, trust the data.** When an image looks wrong,
   confirm with \`get_pixels\` or \`quality_report\` before you start "fixing" it. Inline
   previews can be stale.
9. **A clean defect report is not a finished piece.** \`quality_report\` has two halves and
   you must read both. The defect half says what is *wrong*; the presence half
   (\`presence.valueRange\`, \`darkShare\`, \`flatShare\`, \`planeSeparation\`) says whether the
   piece still *has* light, depth and form. Driving \`defectScore\` to 100 sanded a lake
   scene into a dark flat rectangle once already, because sparkle and grain score
   identically to noise. After every cleanup pass, re-read the presence half.

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
- Let the tool build it: \`add_palette_ramp {from, to, steps, hueShift}\` interpolates
  the ramp in HSL, pulling the dark end cool and the light end warm by default. Use
  \`shadowHue\`/\`highlightHue\` for absolute control, \`saturationBoost\` for richer mids,
  and \`mode: "replace"\` to make one material's ramp the whole palette.
- Never use pure black (\`#000000\`) as a shadow or pure white as a highlight. Use
  near-black and near-white; reserve the extremes for outlines if anything.
- Keep the number of materials small: skin, cloth, metal, and one accent is enough
  for a character.
- Lock the palette down. Pass \`paletteLocked: true\` to \`create_document\` and every
  colour a command writes is snapped to the nearest swatch, so a slightly-off hex
  becomes the nearest ramp step instead of inventing a new colour. Alpha is preserved,
  so a translucent cape still works. Note the scope: this snaps what a command *writes
  to a cel*. Compositing a translucent layer over another still blends two swatches, so
  the final flattened image can hold colours that are not in the palette —
  \`quality_report\` reports that as \`palette.outsideRatio\`. For a strictly on-palette
  result, use opaque layers and \`quantize_to_palette\` at the end.

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
- For a curved or diagonal silhouette, run \`antialias\` with \`mode: "silhouette"\` and a
  small \`amount\` (0.3-0.5). It is selective: straight edges stay crisp and only the
  staircase corners gain a blended pixel. Use \`rect\` to keep it local, and let
  \`paletteLocked\` snap the new mid-tones back to the ramp.

## 5. Shading and texture

- \`dither_fill\` with \`pattern: "bayer4"\` or \`"checker"\` is the classic way to make
  a third shade out of two colours, or to blend a gradient on a small canvas.
  \`level\` is the coverage: \`0.5\` is the even checker, \`0.25\` a sparse hint of the new
  shade, \`0.75\` mostly the new shade. \`bayer4\`/\`bayer8\` read as an ordered gradient;
  \`dots\`, \`sparse\` and \`dense\` read as irregular texture. Keep dithered areas small -
  a 1px checker over a large area turns to noise.
- On a large canvas, prefer \`pattern: "cluster2"\` or \`"cluster4"\`: the same coverage
  lands as 2x2/4x4 blocks, which reads as a softer tonal step instead of digital
  stipple. Use the 1px patterns for small transition bands, not whole skies.
- **\`cluster2\` and \`cluster4\` quantise \`level\` to sixteenths.** \`0.08\` and \`0.10\`
  are the same field (both resolve to 0.0625); the nearest 1/16 step is what you get.
  \`bayer4\` quantises to sixteenths too, \`bayer8\` to sixty-fourths. \`level: 1\` is solid.
  \`dither_fill\` echoes the resolved level so you never have to guess.
- **Sizing a transition.** Aim for a 3-5px dithered seam between two tones. Under 3px the
  step is a hard line; past about 8px the seam stops reading as a transition and starts
  reading as texture. If one \`dither_fill\` covers more than roughly 1500 px at a level
  under 0.5, the tool will warn: shrink the rect, switch to \`cluster4\`, or paint the
  step solid and dither only its edge.
- **Gradients.** Do not build one out of a stack of full-width dither rows. Use
  \`banded_gradient\` (one batch command, vertical/horizontal/diagonal/radial,
  \`banded: true\`) for the field, then hand-dither only the seams you want soft. A sky
  is usually 6-10 solid bands plus one 4px seam each. On a \`paletteLocked\` document,
  per-pixel gradient jitter is deliberately disabled and reported: snapping those tiny
  threshold crossings to palette swatches creates a regular CRT-like texture. Use
  \`noise_fill\` or a deliberate \`cluster2\`/\`cluster4\` dither for variation instead.
- **Light sources and glows.** Put the light source on a third. Build its falloff by
  shaping the gradient toward it - raise the band boundaries around it, or use
  \`banded_gradient\` with \`direction: "radial"\`. Do **not** paint a halo as a dithered
  ellipse; that is the single most common way this tool produces a dot cloud. Solid
  concentric steps in adjacent palette entries are clean and read correctly.
- \`dither_fill\` with \`pattern: "sparse"\` reads as texture (dirt, cloth, grain).
- If a pass leaves isolated single pixels, run \`despeckle\` with \`mode: "both"\` under a
  \`rect\`. It removes lone speckles and pulls colour outliers toward their local
  neighbourhood before you finalise. Set \`minClusterSize: 2-4\` when the art intentionally
  uses pointillism or small same-colour clusters.
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
- **Shade inside the visible band.** When layers stack (a far ridge behind a near one,
  hills behind a treeline), the only part of the lower layer you can see is the strip
  between its own top edge and the top edge of the layer above it. Measure that strip
  first - \`measure_region\` per layer, or the crest line of each silhouette - and place
  every tonal band inside it. A shadow band placed below the occluding crest is spent
  work, and the sprite reads flat no matter how many colours you used.
- \`ridge_line\` generates a reproducible terrain contour with ridged fBm. Give it a
  range (\`rect\`, \`x/y/width\`, or \`from/to\`) and tune \`amplitude\`, \`scale\`,
  \`octaves\`, \`lacunarity\`, \`gain\` and \`seed\`. It always uses at least two octaves,
  so the large mass and small rock detail are not a hand-written regular sawtooth. Pass
  a \`color\` to draw it, or omit it and reuse the returned \`points\` with \`shade_band\`.
- \`shade_band\` paints a tonal band that **follows a silhouette**. Give it the crest
  polyline with \`offset\` and \`thickness\` for the common case - a lit band under a
  ridge crest, a shadow band at its base - or \`top\`/\`bottom\` for a band between two
  arbitrary curves. Its bottom edge is exclusive: \`thickness: 2\` starting at the crest
  covers the crest row and the one below it. Solid lays down a tone; a \`pattern\` with
  a \`level\` under 0.5 gives the 3-5px dithered seam that belongs between two tones.
  Pair it with \`clip: {layer}\` to keep it inside the shape. This replaces the usual
  workaround of hand-building an offset ribbon polygon in \`run_script\`.
- For a band the polyline cannot express, \`dither_fill\` still takes
  \`shape: {polygon: [...]}\` together with \`clip: {layer}\`, so a derived polygon works
  too. \`run_script\` is the place to compute those points.
- \`replace: true\` on \`draw_rect\`, \`draw_ellipse\`, \`draw_polygon\` and \`dither_fill\`
  erases the pixels the shape covers before painting them. The command summary returns
  a warning and \`replaced\`: on an independent shading layer, unpainted pixels become
  transparent rather than revealing a preserved base. Use it when redrawing over an
  earlier pass: without it, a second dithered band stacks the stipple and reads twice as
  dark. It only clears the pixels the **new** shape covers, so shrinking a shape leaves
  the old footprint behind - \`clear_region\` the layer when you redesign a large area.
- \`draw_line\` takes a \`width\` (1-64) for thick strokes - staffs, limbs, hair strands.
  The band is perpendicular and roughly centred, but it overshoots each endpoint by up
  to half the width and even widths bias +0.5px, so a tapered limb is better as a
  \`draw_polygon\`.
- \`draw_polyline\` strokes a whole path in one call, stamping a square brush at every
  vertex so a wide turn keeps its outer corner. Use it for shorelines, ridges,
  branches, cracks, reeds and cables instead of one \`draw_line\` per segment; pass
  \`close: true\` to join the last point back to the first.
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
- Set frame durations explicitly (100-150 ms is a normal baseline; a run cycle is faster
  than a walk). Use \`set_frame_durations\` for all/range/tag updates in one command;
  \`update_frame\` remains the single-frame shorthand.
- Tag the sequences you intend to export with \`upsert_tags\` when creating or changing
  several tags, or \`add_tag\` for one. A \`direction\` of \`forward\`, \`reverse\` or
  \`pingpong\` controls playback; pingpong halves the frames needed for an idle loop.
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
- Check the loop: the last frame should lead back into the first. After tags exist, call
  \`preview_animation {tag, onion: {before: 1, after: 1}}\` so reverse/pingpong neighbours
  follow the actual playback order; do not inspect only individual timeline frames.
- For a reusable multi-part character, prefer named layer-bound parts with fixed pivots.
  \`create_rig\` stores the hierarchy; \`save_pose\` stores sparse transforms; \`preview_pose\`
  and \`preview_animation\` are non-destructive checks. Only \`bake_pose\`/\`tween_pose\` writes
  pixels, and they require explicit destination frames. \`set_anchor\`/\`set_hitbox\` keep
  gameplay geometry attached to the same part. Use \`transform_cel\` for a one-off arbitrary
  angle correction without building a rig.

## 8. Iterating

- The fastest draw→look loop is one call: pass \`preview: true\` to \`run_script\` or
  \`apply_ops\`, plus \`previewOptions\` (and optionally \`frame\`, \`frames: "all"\`, \`onion\`,
  \`rect\`, \`layers\`, or \`background\`). The command result and a real PNG come back together,
  so do not spend a second call on \`get_preview\` immediately afterwards.
- **Leave \`scale\` alone for the whole-canvas look.** The default targets roughly 256px
  on the long side, which is a useful overview. Set \`scale: 1\` when a true 1:1 export
  is needed for fine pixel judgement, or crop when you are inspecting one detail.
- Look after the silhouette, after major lighting/material work, and once at the
  end. Two or three visual gates catch nearly all composition problems; a long chain
  of tiny speculative edits is slower and usually less coherent.

- \`get_preview\` renders the composited frame (or all frames) as a PNG you can
  actually see. Use it when no edit was made, or when a mutation did not request
  an inline preview. Never chain twenty edits blind.
- \`get_preview\` defaults to an integer view targeting ~256px on the sprite's longest
  side. Use \`scale: 1\` for a true 1:1 view when judging fine pixel texture. Pass
  \`frame\`/\`layers\` to isolate
  what you are working on. Pass \`scale\` (2-32) **together with** \`rect: {x, y, w, h}\`
  to inspect one detail - a face, a hand, a waterline - at 4x. Never use a bare
  \`scale\` to judge the whole piece: upscaling a large canvas exaggerates every
  2x2 dither block into a visible dot grid, and the usual result is deleting dithering
  that was correct. The same crop can ride along in a mutation's \`previewOptions\`, so
  fixing and inspecting a detail is one call.
- \`get_pixels\` returns a region as hex rows when you need exact coordinates. It is
  capped at 32x32 per call, so use it for sampling, not for reading a whole canvas.
  For "which colours does this actually contain", use \`histogram\`, which returns the
  count per colour in one call.
- When an image and your expectations disagree, believe the data first: \`get_pixels\`
  a suspicious block, or run \`quality_report\`. Inline previews can be stale, and
  "fixing" a rendering artefact just damages the artwork.
- \`measure_region\` tells you where the opaque pixels actually are, which is how
  you centre a sprite without guessing.
- \`get_document\` nests the counts under \`document\` (\`document.layerCount\` /
  \`document.frameCount\` / \`document.tagCount\`, all numbers); the actual \`layers\` /
  \`frames\` arrays are at the **top level**, in bottom-first paint order. Only layers
  with cels on a frame appear in \`frames[].layers\`.
- If a pass makes things worse, \`undo\` it. Undo is cheap; guessing is not. \`undo\` /
  \`redo\` take \`steps\` (alias \`count\`) to move several edits at once. By default an
  \`apply_ops\` batch is **not** one undo step - every op in it is its own history
  entry. Pass \`singleUndoStep: true\` to collapse the whole batch into one entry, the
  way a \`run_script\` script always folds. \`get_history\` lists recent commands with
  their summaries.
- \`apply_ops\` returns an \`advisories\` array when something it just did is legal but
  a known way to go wrong - currently oversized or over-quantised \`dither_fill\` fields,
  with the op index. Read it. These are the mistakes that are invisible in a thumbnail
  and ruinous in a finished piece.
- Working on a scratch document? \`create_document\` accepts \`select: false\` so it does
  not steal focus from the document you are actually drawing. \`select_document\` takes a
  document id **or** its name.
- \`export_png\` returns \`absolute\` as an **array** (one entry per written file), while
  \`save_document\` returns it as a **string**. \`get_preview\` echoes the zoom factor as
  both \`scale\` and \`upscale\`. \`export_png\` also takes \`rect\`, so a 1:1 crop can be
  written straight to disk - the dependable fallback when an inline preview looks wrong
  and you need a file you can open yourself.
- Before finishing, run \`quality_report\`, and read **both** halves of it. The defect
  half returns isolated-pixel ratio, colour outlier ratio, edge contrast, highlight
  clipping, palette usage and a 0-100 \`defectScore\` — **higher is cleaner**, so 99 means
  "almost nothing measurable is wrong", which is not the same as finished. The presence
  half answers whether the piece still *has* light, depth and form, with these rough
  readings: \`valueRange\` above 150 is healthy, below 90 means the shading has collapsed;
  \`darkShare\` under about 40% is normal for a night scene, over 75% reads as
  underexposed; \`flatShare\` under about 20% is fine, over 45% is a dead region;
  \`planeSeparation\` above about 15 means the depth planes are actually told apart, below
  6 means two of them have merged; \`lightConcentration\` near 1 means a real source.
  Those are working thresholds, not laws — trust the warnings over the numbers.
- It also reports \`palette.unusedIndices\` (the exact slot numbers, so you can inspect
  them), \`palette.crowded\` (used pairs too close in distance to read as separate
  tones), \`structure.strongBands\` (full-width tonal edges big enough to flatten a
  composition — a smooth gradient has many gentler steps and is not flagged),
  \`structure.rhythm\` (silhouette peak regularity), and
  \`structure.landscape\` for full-bleed scenes. The landscape half locates internal
  horizon/ridge/waterline candidates, reports each boundary's straightness/regularity,
  and measures whether a bright or coherent vertical/diagonal guiding line crosses the
  lower frame. It is evidence, not a beauty score: read \`landscape.conclusion\` and
  its warnings alongside the presence half. For characters, pass
  \`assetType: "character"\` to suppress irrelevant landscape/band findings and analyse
  silhouette jumps, centroid drift, palette flicker and loop closure across frames.
  Declare eyes, teeth, hair, fabric and weapon highlights as
  \`intentionalDetailRects\`, not as global texture that weakens real defect checks.
- Before removing palette slots, use \`prune_palette {dryRun: true}\`; it scans every
  selected raw cel (including hidden layers), remaps semantic roles, and returns an
  old-to-new index map.
- If a high-frequency region is deliberate texture — sparkle, grain, foliage, water
  glitter — pass it as \`textureRects\`. Outliers inside are counted as
  \`noise.texturedOutliers\` and stop raising the noise warning, **and** their bright
  pixels are excluded from the light-source check, because scattered highlights are not
  a light source. Do **not** lower \`noiseThreshold\` to silence it: that hides real
  defects everywhere, whereas \`textureRects\` is scoped to the region you meant. A
  sunset lake is the case that forces this — its glitter is a texture, and without the
  declaration its sun can never read as a source.
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
- **A halo of dots around a light source.** The most recognisable tell that dither was
  used as a glow. Shape the gradient toward the light instead.
- **A dither field whose visible structure is its own pattern** - a regular dot lattice
  you can trace with your eye. The pattern should disappear into a tone.
- **A straight bright wedge where a sun path should be.** Glints, not a triangle.
- **A tonal band that never shows up**, because a layer above covers it. Check the
  visible extent before placing shading.
- **Evenly spaced identical shapes**, which read as a fence or a hedge.
- **A perfect circle as foliage or a rock**, which reads as a balloon.
- **A big empty dark corner** where a foreground silhouette should carry detail.
- Redrawing everything each frame when \`translate\` or \`squash\` would move it in one operation.

## 12. Environments and landscapes

The rules that separate a scene from a set of stacked stripes.

**Depth and value**

- Separate depth planes by **value first, hue second**. The far plane is lighter and
  cooler, the near plane darker and warmer. If two adjacent planes sit at the same
  value, no amount of hue difference will separate them.
- Give the piece one vertical or diagonal element. A light path down water, a waterfall,
  a road, a foreground tree - one of these is what stops an otherwise horizontal
  composition from reading as bands.

**Water and reflections**

- A reflection is geometry plus optics, not a copied texture. \`mirror {axis:
  "vertical", about: <waterline row>, copyTo: "reflection"}\` is the exact geometric
  baseline. For a lake, add \`compress\` (0-1 non-linear vertical compression) and
  \`wobble\` (maximum seeded horizontal displacement) so detail bends and breaks with
  depth; \`seed\` makes the result reproducible. Add \`attenuate\` when the far end
  should lose brightness as well as geometry. The command reports \`opticsApplied\`
  and leaves the source untouched.
- **Layer order decides whether the reflection is visible at all.** Layers paint
  bottom-first, so whatever is opaque and on top wins. Two workable arrangements:
  - *water is transparent or only a wash*: put \`reflection\` **below** \`lake\` and let
    the water tint it.
  - *water is an opaque slab* (the usual case): put \`reflection\` **above** \`lake\` and
    paint only the reflection area, or it is hidden completely. Use
    \`clip: {layer: "lake"}\` to keep it inside the water region.
- \`flip\` mirrors about the canvas centre only; use \`mirror\` when the axis is not the
  centre. Artwork that would land off the canvas is dropped, not wrapped.
- **Break the reflection with horizontal ripple segments, not with a dithered fade.**
  A dither dissolve turns the reflection into a field of speckle. Instead draw the
  reflection solid, then lay solid, slightly longer horizontal bars of the water colour
  across it, increasing in thickness and spacing with depth.
- Sun glints read as broken light, not a solid wedge. Place short horizontal dashes on
  roughly a 3px row rhythm, with the horizontal spread widening as they come toward
  the viewer. If the dashes merge into a continuous bright triangle, there are too many
  or they are too long.
- The near waterline is a hard edge; soften it with a value step, not a blur.

**Silhouettes and repetition**

- Terrain skylines want **two noise scales**: a large one for the massing and a small
  one (about a quarter the amplitude) for the detail, or the result looks like smooth
  hills rather than rock. Break-jagged is not the goal - the step lengths along a curve
  should change gradually, 2,1,1,2,1,1, never 4,1,4.
- Trees, rocks and shrubs: vary size about +/-40%, vary spacing about +/-30%, and leave
  gaps. A row of identical triangles at even intervals is a hedge.
- Give masses an irregular outline. A tree canopy drawn as \`draw_ellipse\` reads as a
  balloon; 7-9 polygon points with the radius jittered by about +/-25% reads as
  foliage. Add a trunk and a lit side, and keep the highlight small.
- A foreground silhouette anchored in a corner creates the strongest cheap depth cue
  there is - but give it information. A large flat dark wedge is a hole, not a
  foreground.

**Light**

- One light source, on a third, and every shadow agrees with it. Rim-light the lit
  side; keep the shadow side one or two ramp steps down, not black.
- Keep pure white and pure black for a specular core and an outline respectively, and
  use near-white/near-black everywhere else.

## 13. Tilemaps and auto-tiling

A tilemap is a grid of tile indices, separate from the sprite's pixel layers. It is the
right structure for terrain, walls and floors: cheaper to edit, and it exports straight
into a game engine.

- Cut a tileset out of artwork you have already drawn: \`create_tileset { layer, frame,
  tileWidth, tileHeight, columns }\` slices that layer into a grid of tiles. Draw the tile
  sheet once as a normal image, then cut it.
- \`add_tilemap { width, height, tileWidth, tileHeight }\` makes an empty grid; \`-1\` means
  empty. \`set_tile\` writes one cell or a batch of \`tiles\`, \`fill_tilemap\` fills a rect or
  the whole map, \`resize_tilemap\` grows or shifts the grid, \`remove_tilemap\` deletes it.
  Batch writes report every skipped coordinate and reason, plus a \`changedRect\`; do not
  guess those coordinates back out of the grid after a partial write.
- \`stroke_tilemap\` draws a curved tile brush through floating-point tile coordinates.
  Give it weighted \`tiles\` (number or \`{ tile, weight }\`), \`width\`, \`seed\`,
  \`density\`, \`jitter\`, \`smoothing: "catmull-rom"\` and \`avoidRepeats\`. It can apply
  edge/corner transitions in the same call through \`edge: { set, transitions, seed,
  avoidRepeats }\`; \`transitions\` is an arbitrary-order \`[{ mask, tile, weight? }]\` list,
  so a hand-made set no longer has to occupy one sorted block.
- \`autotile\` remains available for a solid placeholder terrain. \`set: 16\` uses the four
  cardinal neighbours; \`set: 47\` uses all eight and counts a diagonal only when both of
  its adjacent cardinals are solid. \`offset\` selects the traditional canonical sheet.
  Pass \`transitions\` instead when masks are sparse, repeated, or stored in your own
  order; each mask may have weighted variants. Missing masks are left unchanged.
- A tilemap mutation can include
  \`bake: { layer, frame?, blend: "over", opacity?, underlay? }\`. The command clears and
  redraws only the cells that actually changed. When \`underlay\` names a ground/base
  tilemap with the same cell size, that base is stamped first and the active terrain is
  alpha-composited over it, so a bank edge does not fade into bare transparency.
- \`paint_tilemap\` bakes any grid into a normal pixel layer. It accepts a tile-space
  \`rect\`, \`clear\`, \`blend: "copy" | "over"\`, \`opacity\` and \`underlay\`; \`copy\` remains the default
  for backward compatibility. \`get_tilemap\` reads exact rows of indices.
- \`preview_tilemap\` is the immediate look/debug tool for an unbaked grid. Use
  \`debug: { grid: true, indices: true, highlightCells, highlightRect }\` to see tile
  boundaries, indices, invalid cells and the mutation's changed area in the same response
  as a PNG. Pass \`underlay\` to render a ground/base tilemap first and judge alpha-masked
  bank/edge tiles over it. Do not bake merely to inspect a tile edit.
- \`quality_report { tilemap, underlay? }\` analyses the grid before baking. It reports invalid
  indices, variant dominance/entropy, same-tile adjacency and runs, connected terrain,
  singleton cells and open edges. Pixel-noise and flat-band findings become informational
  in tilemap mode because water ripples, crop rows and roads are intentional texture.
- Keep gameplay data out of the visual tile choice when the engine needs it:
  \`set_tile_properties\` stores walkability, collision, speed and similar JSON-safe values
  per tile index; \`add_map_object\`/\`update_map_object\` store spawns, triggers, bridges
  and interactive props independently, each with its own properties. Tiled export carries
  both as tile properties and an object-group layer.
- \`export_tiled\` writes a self-contained Tiled \`.tmj\` plus its referenced tileset PNG by
  default, rejecting malformed lengths, mixed tile sizes and out-of-range indices first.
- A tilemap is for things that repeat on a grid. A pixel layer is for everything else.
`;

/** Short, always-included preamble for prompts that do not need the full guide. */
export const SKILL_SUMMARY =
  'Pixel art workflow: block the silhouette in one flat colour on a base layer, ' +
  'return an inline preview from the same run_script/apply_ops call (the default integer scale targets about 256px on the long side), ' +
  'then shade with add_palette_ramp hue-shifted ramps and outline selectively. ' +
  'Judge the whole piece at 100% before zooming; keep dither to 3-5px seams only ' +
  '(cluster levels quantise to sixteenths); place shading inside the layer-visible band; ' +
  'and break up repeated shapes. Run quality_report before finalising and read its ' +
  'presence half as well as its defect half - a clean defectScore with a narrow ' +
  'presence.valueRange means the piece was sanded flat, not finished. For animation, batch ' +
  'durations/tags with set_frame_durations/upsert_tags. For reusable character parts, use ' +
  'a persistent rig plus preview_pose and explicit-frame pose baking; quality_report ' +
  'assetType:character checks silhouette stability across frames. Finish with one ' +
  'finalize_document export plan. Read pixel://skill ' +
  'before drawing anything non-trivial.';

/** URI of the scripting/plugin guide resource. */
export const SCRIPT_GUIDE_URI = 'pixel://script-guide';

/**
 * The scripting guide served as `pixel://script-guide`.
 *
 * The tool list tells an agent *that* `run_script` and `load_plugin` exist; this
 * tells it how to use them well, and exactly what the constrained runtime exposes,
 * so it does not waste a call discovering the API by failure.
 */
export const SCRIPT_GUIDE = `# Scripting and plugins

\`run_script\` executes trusted JavaScript against the current document inside a
restricted \`node:vm\` context. The context limits the exposed API, but it is not a
security boundary for hostile code. It is the extension point for anything the fixed
command set does not cover: procedural patterns, maths-heavy placement, reading many
pixels at once, or looping an edit over every frame.

For a visual iteration, pass \`preview: true\` and leave \`previewOptions\` at its default;
the PNG is returned with the script result, so no follow-up \`get_preview\` call is needed.
The default integer scale targets about 256px on the long side. Judge the whole piece at
100% in a separate 1:1 export when fine decisions matter; pass
\`previewOptions: {rect, scale: 4}\` for a detail, or \`{frames: "all", onion}\` to inspect
an entire animation. Use \`dryRun: true\` to execute and validate against an isolated snapshot
without touching the live document. Use \`expectedVersion\` when another editor may have
changed the document since your last read. Runtime failures include source-relative
\`errorInfo\` when a location is available. \`finalize_document\` saves the source and writes
PNG exports in one call.

## What the scripting context gives you

- \`exec(command, params)\` runs a normal editor command and throws on failure.
  \`tryExec(command, params)\` returns \`{ ok, summary }\` or \`{ ok:false, error, code }\`
  instead of throwing. Use \`exec\` when a failure should abort the script. Required
  \`layer\`/\`frame\` arguments are filled with the bottom layer/frame 0 exactly like
  the MCP command surface when the command permits it; optional filter arguments are
  left alone. The same normalization is shared by generated MCP tools, \`apply_ops\`
  and the script bridge.
- Higher-level aliases keep map scripts readable without bypassing validation or undo:
  \`draw.rect/line/ellipse/polygon/polyline/pixels/putPixels\`, \`draw.tile\`,
  \`draw.tilemap\` (curve terrain), and \`draw.bake\`. The direct aliases
  \`strokeTilemap(params)\` and \`paintTilemap(params)\` are also available. Each one calls
  the matching normal command, so schema errors, defaults and the script's single undo
  step behave exactly as they do for \`exec\`.
- \`putPixels(rect, base64RGBA, options?)\` is the compact bulk path for generated fields:
  it writes a row-major RGBA8888 buffer in one command/undo step. The decoded payload
  must contain exactly \`rect.w * rect.h * 4\` bytes; set \`clearTransparent\` when
  zero-alpha samples should erase. In-process core callers can pass a
  \`Uint8Array\`/\`Uint8ClampedArray\` to the matching \`putPixels\` raster helper.
- Use \`banded_gradient\` for a deterministic directional ramp, \`noise_fill\` with
  \`octaves: 1\` for value noise or 2–6 for fBm, and \`scatter\` for seeded stars, grit,
  foam or foliage. These emit one batch command instead of thousands of pixels.
- \`commands()\` lists every available command as \`{ name, description, readOnly }\`.
  \`command(name)\` returns one command's full JSON Schema, or \`null\`.
- Read state: \`document()\`, \`layers()\`, \`frames()\`, \`tags()\`, \`palette()\`,
  \`tilemaps()\`, \`mapObjects()\`, \`tileProperties(tile)\`, \`getPixel(x, y, layer?, frame?)\`
  and \`sample(x, y, frame?)\` (the composited colour).
  For a layer-specific sample, call \`sample(x, y, { layer, frame })\`; the explicit
  \`sampleComposite(x, y, frame?)\` alias always means the composited frame and is harder
  to misread in a long script. \`getPixel\` is already layer-specific. The MCP
  \`get_pixels\` tool is also composited; use a layer command or \`getPixel\` when the
  distinction matters.
- **An unpainted pixel reads as \`null\`, not a zeroed colour.** Both readers return
  \`null\` for a fully transparent pixel, so \`if (getPixel(x, y))\` is a valid emptiness
  test. Do not test \`a === 0\`; that branch is unreachable by design.
- \`log(...)\` records output; everything logged is returned in the tool result's \`logs\`.
- The script's return value is JSON-serialised into \`result\`. Return a plain object
  or array; functions and class instances are not preserved.

## What it does not allow

- No \`require\`, \`process\`, \`module\`, filesystem or network access.
- No \`eval\` or \`new Function\` - dynamic code generation is disabled at the context
  level, so the usual context-escape tricks do not even start.
- A wall-clock timeout (default 15000 ms over MCP, override with \`timeoutMs\`). An infinite
  loop is killed and reported as \`Script timed out after Nms\`. A script that generates
  a whole 256x256 scene is a few hundred command calls, so raise \`timeoutMs\` rather than
  splitting the work across scripts.
- \`scatter\` and dithered \`dither_fill\` do not silently register a texture region in
  the document. When calling \`quality_report\`, pass the actual sparkle/grain/foliage
  rectangles as \`textureRects\`; only those regions are exempted from noise and
  light-source checks.

## Undo

A committed whole script is **one undo step**. Every \`exec\` inside it folds into a single
history entry, so a script that makes fifty edits is undone with one \`undo\`. A
script that only reads leaves the history untouched. With \`dryRun: true\`, document commands
run on an isolated snapshot and the live document is not changed. Loaded plugins are trusted
code and may still advance their own process-local state; dry-run does not virtualise those
closures.

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
