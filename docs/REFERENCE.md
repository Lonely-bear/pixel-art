# dotloom-mcp — Technical Reference

> This document preserves the detailed command, MCP, scripting, and architecture notes. For installation and the project overview, return to the [main README](../README.md).

dotloom-mcp is a pixel-art tool built from day one to be operated by **both humans and AI agents**.

The public npm distribution is [`dotloom-mcp`](https://www.npmjs.com/package/dotloom-mcp). The `@pixel/*` workspace packages below are internal implementation packages; they are not separate npm products.

The product is not the Electron window — it is the **headless, addressable pixel document
model** in `packages/core`. The Electron app and the MCP server are both just clients of it.

## Layout

| Package | Role |
| --- | --- |
| `dotloom-mcp` | Published npm package: bundled library, CLI, and standalone MCP server. |
| `packages/core` | Pure TypeScript. Document model, command bus, rasteriser, PNG, serialisation. **No DOM, no Electron, no Node APIs.** |
| `packages/script` | Constrained JavaScript runtime + plugin loader (`node:vm`). **Node only; not an untrusted-code boundary.** |
| `packages/cli` | Headless command line over `core` (M0). |
| `packages/mcp` | MCP server exposing `core` as tools/resources/prompts (M1). |
| `packages/app` | Electron + React + Vite editor, with the MCP server embedded (M2). |

Because `core` has zero platform dependencies it runs in Node, a browser tab, a Web Worker,
an Electron renderer, a test runner, and a headless CI job — from the same source.

## Design decisions locked in

1. **RGBA8888 as the source of truth**, with the palette as a first-class *constraint layer*
   (never as the storage format). Pixels are always `Uint8ClampedArray`, 4 bytes per pixel,
   row-major, `y` grows downward, origin top-left.
2. **Everything is addressable.** Layers, frames, tags and tiles have stable IDs that are
   never reused. No command depends on an implicit "current selection".
3. **One command bus.** Every mutation — from the UI, from the CLI, from MCP — is the same
   serialisable command. Undo/redo, replayable AI sessions and the MCP tool surface all fall
   out of that single decision.
4. **Undo = shallow structural snapshot.** Commands copy-on-write pixel buffers, so an undo
   entry costs O(frames x layers) pointers instead of a full image copy.

## Status

- [x] **M0** core document model, command bus, rasteriser, PNG, `.pixel` serialisation, CLI
- [x] **M1** MCP server (tools + image resources + prompts)
- [x] **M2** Electron UI
- [x] **M3** tilemaps, auto-tiling, Tiled export
- [x] **M4** animation tags, spritesheet / GIF export, Aseprite `.ase` import
- [x] **M5** scripting sandbox, plugins

## Commands

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

## CLI

Every command prints one JSON object to stdout, so the CLI is directly scriptable and
mirrors the MCP tool surface one-for-one.

```bash
node packages/cli/dist/index.js new hero.pixel --width 32 --height 32 --layers Ink,Shade --frames 4
node packages/cli/dist/index.js info hero.pixel
node packages/cli/dist/index.js export hero.pixel --out hero.png --scale 4
node packages/cli/dist/index.js export hero.pixel --out hero.png --all      # one PNG per frame
node packages/cli/dist/index.js sheet hero.pixel --out hero-sheet.png      # Aseprite-style JSON alongside
node packages/cli/dist/index.js tiled hero.pixel --out hero.tmj            # Tiled map + tileset.png
node packages/cli/dist/index.js gif hero.pixel --out hero.gif --tag idle   # animated GIF, tag-driven order
node packages/cli/dist/index.js import hero.png --out hero.pixel           # PNG or .ase -> document
node packages/cli/dist/index.js apply hero.pixel --ops ops.json            # run commands (the AI entry point)
node packages/cli/dist/index.js pipeline hero.pixel --ops ops.json --out preview.png
node packages/cli/dist/index.js script hero.pixel --src script.js          # sandboxed JS, one undo step
node packages/cli/dist/index.js commands --plugin stripe.js                # extra commands from a plugin
node packages/cli/dist/index.js thumb hero.pixel --out thumb.png --max 128
node packages/cli/dist/index.js pixels hero.pixel --rect 0,0,16,16
node packages/cli/dist/index.js commands --json                            # every command + its JSON Schema
```

`apply`/`pipeline` take a JSON list of commands, which is the same payload an agent will
send over MCP:

```json
{ "ops": [
  { "command": "draw_rect", "params": { "layer": "Ink", "frame": 0, "rect": { "x": 2, "y": 2, "w": 12, "h": 12 }, "color": "#3a6ea5", "fill": true } },
  { "command": "outline",   "params": { "layer": "Ink", "color": "#101820", "mode": "inside" } },
  { "command": "dither_fill", "params": { "layer": "Shade", "rect": { "x": 2, "y": 2, "w": 12, "h": 12 }, "color": "#101820", "pattern": "bayer4", "level": 0.25 } }
] }
```

Any colour in a command can be given as a **palette index shorthand** — the number `9` or the
string `"pal:9"` (also `"palette 9"` / `"pal#9"`, case-insensitive) — resolved against the
document's palette. An agent can therefore work in palette terms instead of hard-coding hex:
`{ "command": "draw_rect", "params": { "layer": "Ink", "rect": {...}, "color": "pal:3", "fill": true } }`.
Explicit hex/RGB input is unchanged, and an out-of-range index fails loudly rather than
silently drawing the wrong colour.

## Desktop app

Electron + React + Vite. The renderer never touches `core` directly for mutations — every
edit goes over IPC into the **same command bus** the CLI and MCP use, so there is exactly one
undo history and one source of truth.

```bash
pnpm --filter @pixel/app run dev      # Vite dev server + Electron with HMR
pnpm --filter @pixel/app run build    # tsc + vite build
pnpm --filter @pixel/app run start    # run the built app
```

What it has:

- **Canvas** — pixel-perfect nearest-neighbour zoom (1x–40x), fit-to-window, panning with the
  middle mouse button or space, and a pixel grid past 8x. Strokes are previewed locally with
  `core`'s own rasteriser and committed as a single `draw_pixels` command on release, so one
  stroke is one undo step.
- **Tools** — pencil, eraser, line, rectangle, ellipse, bucket fill, colour replace,
  eyedropper, pan. Brush size 1–8, filled-shape toggle, primary/secondary colours with alpha.
- **Clipping** — any draw can be restricted with `clip`: `"composite"` (the rest of the
  frame), `"cel"` (this layer), or named layers (`{layer: "hair"}`, `{layers: [...]}`), so
  shading, highlights and dither bands stay inside the silhouette — or one part of it —
  instead of filling their bounding box. Clipping to a layer that renders *above* the one
  you paint hides the result, and the tool returns a `warning` when it detects that.
- **Replace** — `draw_rect`, `draw_ellipse`, `draw_polygon` and `dither_fill` take
  `replace: true` to clear the pixels they cover before painting, so a re-drawn or
  re-stippled shape does not stack on the previous pass. It clears only the new shape's
  footprint, so shrinking a shape leaves the old pixels behind. `draw_line` takes a
  `width` (1–64) for thick strokes such as staffs and limbs.
- **Layers** — visibility, locking, opacity, six blend modes, reorder, duplicate, merge down.
- **Frames and tags** — frame strip with per-frame thumbnails and durations, plus animation
  tags for named ranges, and `translate` / `squash` for moving whole layers between frames.
- **Playback** — the canvas plays the selected animation tag in its real order (the same
  `animationSequence` the GIF export uses, so the preview and the file cannot disagree), with
  play/pause, a tag selector and a speed control.
- **Onion skinning** — the neighbouring frames ghost behind the current one, previous at 35%
  and next at 25%, with adjustable before/after counts.
- **Tilemaps** — a panel that shows the tileset as a clickable tile picker and the tilemap as
  a grid you can paint: left-click lays the active tile, right-click erases, dragging paints a
  run. Add or remove a tilemap, run `autotile` with the 16 or 47 set and an offset, bake the
  grid into a pixel layer, and export a Tiled `.tmj`. With no tileset yet, it offers to cut one
  out of the current layer.
- **Palette** — click to set the primary colour, right-click for the secondary, and
  `quantize_to_palette` to snap existing artwork to the palette (with dithering). A document
  can also be created with `paletteLocked: true`, which snaps every painted colour to the
  nearest swatch (alpha preserved).
- **Import / export** — open and save `.pixel`, import a PNG or an Aseprite `.ase` file as a
  new document, export a PNG at 1x–16x, export a spritesheet with Aseprite-compatible JSON,
  export an animated GIF (honouring the tag's direction and repeat), or export a Tiled map.

### The AI-facing part

While the app is running it also hosts the MCP server over HTTP on
**`http://127.0.0.1:7331/mcp`** (override with `PIXEL_MCP_PORT`). The GUI and every agent
session share **one `DocumentStore`**, so:

- an agent calls `draw_rect` → the IPC `changed` broadcast fires → the canvas repaints;
- you paint by hand → the agent's next `get_preview` shows your stroke;
- undo/redo is a single shared history, so a human can undo an agent's mistake.

The server binds to loopback only, and each MCP client gets its own session transport.

## MCP server

`packages/mcp` exposes the same command bus over the Model Context Protocol, so an agent
can drive the editor directly. It runs three ways:

- **stdio** — the standalone server below, for any MCP client, no GUI required.
- **HTTP** — embedded in the Electron app (see above), for attaching to a live session.
- **`--attach <url>`** — a transparent stdio→HTTP bridge, so a client that only speaks stdio
  (Claude Desktop and friends) can drive a *running* app, sharing its document store and undo
  history. It relays every request, notification and capability verbatim.

```bash
pnpm build
node packages/mcp/dist/cli.js          # speaks JSON-RPC on stdin/stdout
node packages/mcp/dist/cli.js --attach http://127.0.0.1:7331/mcp   # bridge stdio -> running app
```

Client configuration (Claude Desktop, or any `mcpServers` JSON):

```json
{
  "mcpServers": {
    "dotloom-mcp": {
      "command": "npx",
      "args": ["-y", "dotloom-mcp"]
    },
    "dotloom-mcp-live": {
      "command": "npx",
      "args": [
        "-y",
        "dotloom-mcp",
        "--attach",
        "http://127.0.0.1:7331/mcp"
      ]
    }
  }
}
```

### OpenCode project configuration

OpenCode V2 can load the published stdio server from a project or global configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "dotloom-mcp": {
        "type": "local",
        "command": ["npx", "-y", "dotloom-mcp"]
      }
    }
  }
}
```

The equivalent CLI command is:

```bash
opencode mcp add dotloom-mcp -- npx -y dotloom-mcp
```

To connect to a running desktop app instead of the standalone server, append
`--attach http://127.0.0.1:7331/mcp` to the command arguments.

### What it exposes

- **A generated tool catalog plus session tools.** Every core command is generated straight from its zod schema, alongside
  hand-written session and perception tools: `create_document`, `create_sprite_spec`, `open_document`,
  `save_document`, `finalize_document`, `import_image` (PNG or Aseprite), `select_document`, `close_document`,
  `list_documents`, `get_document`, `get_preview`, `preview_pose`, `preview_animation`, `preview_tilemap`, `get_pixels`, `quality_report`, `get_palette`, `get_history`,
  `undo`, `redo`, `apply_ops`, `export_png`, `export_sheet`, `export_tiled`, `export_gif`,
  `list_commands`, `read_skill`, and the scripting tools `run_script`, `load_plugin`,
  `list_plugins`. Loading a plugin registers its commands as real tools on the fly.
  `list_commands` returns the runnable command catalogue plus a `sessionTools` list, so
  `undo`/`redo`/`get_history`, `apply_ops`, and the perception/export tools are discoverable
  from one call. Its compact response includes `readOnly`; use exact `name`, parameter-name
  `param`, substring `filter`, and optional `limit` for progressive discovery, then
  `verbose: true` for full schemas. `describe_command {name}` returns one exact live
  schema, while `find_workflow {goal}` searches task-level command sequences. `undo`/`redo`
  take `steps` (alias `count`). `create_document` takes `select: false`
  to build a scratch document without stealing focus, `select_document` accepts an id or a
  name, and `get_preview` takes `rect` to crop-zoom a detail. Document summaries expose
  both `active` and `activeDocumentId`; an explicit `get_document {document}` reads without
  changing the session focus.
- **Static resources and document templates.** `pixel://documents`, `pixel://commands`,
  `pixel://skill` (a pixel-art craft guide), `pixel://script-guide` (the sandbox/plugin API),
  plus document and preview templates — the preview is a real `image/png` blob, so multimodal models
  can *see* the art. The preview template takes the same view options as `get_preview` as
  query parameters: `?frame=N`, `?frames=all`, `?scale=N`, `?layers=a,b`, `?onion=N`
  (plus `?onionBefore`, `?onionAfter`, `?onionOpacity`, `?loop`, `?beforeTint`, `?afterTint`).
- **Task prompts.** `draw_sprite`, `animate_sprite`, `improve_sprite`, and `pixel_art_basics`.

### Ten details that matter for agents

1. **`get_preview` returns an actual PNG image**, not a pixel array. A 32x32 sprite is ~10k
   tokens as JSON and ~200 tokens as an image, and the model can actually look at it. It also
   takes `layers` to isolate one or more layers, `rect` to crop-zoom a detail (a face, a hand),
   and `onion` to ghost the neighbouring frames
   (`before`/`after` counts, `opacity`, `loop`, and separate `beforeTint`/`afterTint`), so an
   agent can inspect a single layer or judge motion without exporting anything.
2. **`apply_ops` batches.** An agent sends a list of commands in one round trip; with
   `atomic: true`, any failure restores the exact pre-batch sprite, version, undo/redo
   stacks and dirty state. It also takes `defaultLayer` / `defaultFrame` so a long batch does
   not repeat itself, and `quiet: true` to drop the per-op summaries. Pass `preview: true`
   and the same call returns the resulting PNG. `previewOptions: {frame, rect, layers, scale,
   background}` chooses one iteration view; `{frames: "all", onion}` returns the complete
   animation with neighbouring-frame ghosts. `run_script` supports the same inline preview.
3. **`expectedVersion` gives optimistic concurrency.** Read a version, pass it back on the
   next write, and a stale edit fails with `version_conflict` instead of clobbering someone
   else's work. Read-only commands never bump the version or eat your redo stack.
4. **`clip` is the constraint that makes drawing tractable.** `clip: "composite"` paints
   only where the *other* layers already have pixels, so a shadow, highlight or dither band
   cannot spill into the transparent corners of its bounding box. `clip: "cel"` clips
   against the layer being painted, and `clip: {layer: "hair"}` / `{layers: [...]}` clip to
   named layers — handy for shading one part of a body. When the clip layer renders
   *above* the layer being painted the paint would be hidden, so the command returns a
   `warning`. Paired with `scope: "composite"` on `outline` and `measure_region`, it removes
   the whole class of "must stay inside the silhouette" bugs; `outline` also takes
   `alphaThreshold` so a faint glow is not traced as a hard contour.
5. **Dithering is a write rule, not a special command.** `dither_fill` takes a `shape`
   (`{rect}`, `{ellipse}` or `{polygon}`) so a transition band can follow a curve instead of
   being a box, and every paint command (`draw_rect`, `draw_ellipse`, `draw_polygon`,
   `draw_line`, `fill`, `draw_pixels`) also accepts `pattern` and `level`. A dithered shape
   lands on exactly the pixels a solid one would, and it composes with `clip`. On large
   canvases prefer `cluster2`/`cluster4`: the same coverage lands as 2×2/4×4 blocks instead
   of digital 1px stipple.
6. **`finalize_document` closes the production loop in one call.** It saves the editable
   `.pixel` source and renders a typed output plan: individual PNGs, all-frame PNGs,
   spritesheet + Aseprite JSON, tag-aware GIF, pose renders, and timeline/playback contact
   sheets. Every output is rendered before any file is written. An optional manifest records
   source version, frame durations, tags, actual output paths/sizes, and SHA-256 hashes;
   `incremental: true` reuses that manifest to skip unchanged source/output files. The legacy
   PNG-only `exports` array remains accepted.
7. **`quality_report` is asset-aware where it matters.** Only `character` changes the
   analysis: it suppresses full-width-band/landscape findings (a figure is not a horizon)
   and defaults to all-frame analysis reporting silhouette overlap, centroid drift, palette
   Jaccard, canvas-edge contact and last-to-first loop closure - each with a real `warning`
   entry, not just a number. A transition counts as a silhouette jump when overlap falls
   below `minSilhouetteIouWarning` (default 0.5), which is scale-invariant: a 64x64
   character moving a limb must not be judged by how much of the whole canvas it touched.
   `assetType: "auto"` infers character from a rig or multiple frames; every other value is
   a **label** for the same single-frame diagnostics, echoed back with `assetTypeIsLabel:
   true` so a caller never mistakes a label for a different analysis.
   `intentionalDetailRects` exempts eyes, teeth, hair, fabric and weapon highlights from
   isolated/outlier/edge/highlight checks only; it deliberately does not suppress the
   light-source probe.
8. **`add_palette_ramp` builds hue-shifted material ramps.** Give it a dark and a light
   anchor plus a step count, and it generates the intermediate colours in HSL, pulling the
   dark end toward blue/violet and the light end toward amber by `hueShift` degrees
   (default 20). `shadowHue`/`highlightHue` set absolute endpoint hues, `saturationBoost`
   adds mid-ramp richness, and `mode: "replace"` can swap the whole palette for a single
   coherent ramp. `ensure_palette_role` appends only missing exact/ramp colours and tags their
   indices as skin/leather/metal/etc.; those roles survive serialization and are remapped by
   pruning. `replace_colors` applies one safe global swap over all/ranged/listed frames with
   optional layer/region limits. `prune_palette` scans the raw cels in a document/frame/tag
   scope (including hidden layers), defaults to dry-run, protects explicit `keep` indices,
   and returns an old-to-new index map before removing genuinely unused slots.
9. **Binary and generative primitives avoid per-pixel JSON overhead.** `put_pixels` writes
   a base64 RGBA8888 rectangle in one command, with the script convenience API
   `putPixels(rect, data, options?)`; the core raster API also exposes
   `putPixels(buffer, rect, rgba, options?)` for an in-memory `Uint8Array`/`Uint8ClampedArray`.
   `banded_gradient`, `noise_fill` (value noise/fBm via `octaves`), `ridge_line`
   (seeded ridged fBm terrain contours) and `scatter` generate deterministic fields in
   one batch command, with palette-aware colours, clipping and safety limits.
10. **Landscape diagnostics do not stop at the alpha skyline.** `quality_report` adds
   `structure.landscape` (also exposed as top-level `landscape`) for full-bleed scenes:
   it locates internal horizon/ridge/waterline candidates, reports boundary regularity,
   and looks for a coherent or bright-path vertical/diagonal guide. It is evidence for
   composition, not a replacement for looking at the image.

### Commands built for animation

- `set_frame_durations { updates: [...] }` applies multiple all/range/list/tag duration
  updates with one validation pass, one undo step, previous/current values, and total duration.
- `upsert_tags { tags: [...] }` creates and updates many tags atomically, validates every frame
  range and rejects duplicate final names before writing anything.
- `preview_animation` returns one contact-sheet PNG in raw timeline or tag-expanded playback
  order. Its onion neighbours follow that selected sequence, so reverse/pingpong previews show
  the motion the tag actually plays rather than adjacent timeline indices.
- `translate { layer: "*", dx, dy }` shifts every layer of one frame together and clears
  the vacated band, so a whole-sprite bob remains registered.
- `squash { layer: "*", scaleX, scaleY, pivot: "bottom" }` scales about a pivot with
  nearest-neighbour sampling, keeping the canvas size so the artwork stays registered.
  `scaleY: 0.9, scaleX: 1.08` is the down beat of a bounce.

### Character rigs, poses and gameplay metadata

- `create_rig` binds named parts to existing layer IDs and a stable rest frame. Pivots and
  optional parent relationships are persistent metadata; a part may own several material
  layers but layers cannot be silently claimed by two parts.
- `save_pose` stores sparse part transforms. `preview_pose` renders a pose or stored tween
  at any progress and resolves world-space anchors/hitboxes. `bake_pose` (with
  `apply_pose`/`draw_pose` compatibility aliases) requires an explicit `targetFrame` and
  refuses to overwrite existing pixels unless requested.
- `tween_pose` samples two poses into consecutive frames, splitting total duration and
  appending missing destination frames. `transform_part` is the destructive single-frame
  counterpart for quick local corrections; `transform_cel` provides fixed-canvas arbitrary
  angle rotation/translation/scale without requiring a rig.
- `set_anchor` / `set_hitbox` and their remove commands store engine-facing local geometry.
  `preview_pose` returns transformed anchor points and hitbox polygons. Aseprite sheet JSON
  and the generic atlas manifest also carry rig parts, poses, tweens, anchors and hitboxes.
- **Rig geometry travels with the artwork.** Pivots, anchors and hitboxes are stored in
  canvas coordinates, so `crop_canvas`, `resize_canvas`, `scale_sprite`, unscoped `flip`
  and unscoped `rotate` all remap them by the same mapping as the pixels and report
  `rigRemapped: true`. A scoped flip/rotate leaves the canvas - and therefore the rig -
  alone. Pose baking refuses to write the rig rest frame, and `transform_part` refuses to
  rasterise into it, because poses render *from* that frame and overwriting it makes every
  later render drift. Baking classifies destination layers: part-owned layers are driven
  by the pose and cleared when it empties them (`clearedPartLayers`), while layers the rig
  does not own are the destination's own and are left alone (`preservedLayers`).
- Rig-bearing `.pixel` files use container format v2. Version-1 files remain readable, and
  rig-free documents continue to write v1 for compatibility.
- `create_sprite_spec` is a declarative structural scaffold: layers, frames, tags, semantic
  palette roles and an optional rig in one call. It creates no artwork or art-direction
  decisions beyond the supplied structure.

### Tilemaps and auto-tiling

A tilemap is a grid of tile indices, kept alongside the pixel layers. It is the right
structure for terrain, walls and floors, and it is what an agent uses to build a level.

- `create_tileset` cuts a tile sheet out of a layer you have already drawn.
- `add_tilemap` / `remove_tilemap` / `resize_tilemap` manage the grids;
  `set_tile` and `fill_tilemap` write cells (`-1` means empty); `get_tilemap` reads them back.
  Batch writes return `changed`, `unchanged`, exact `skippedCells` with reasons, and a
  `changedRect`, so a partial edge write is diagnosable without manually comparing rows.
- `stroke_tilemap` follows a Catmull-Rom or linear path of floating-point tile coordinates
  with a round/square brush. Weighted variants, deterministic density/jitter and
  neighbour-aware `avoidRepeats` stop water, fields and ground from becoming wallpaper.
  Its optional `edge` object applies arbitrary-order 16/47 transition mappings in the same
  command, including multiple weighted tiles for one mask.
- `autotile` still supports the traditional `set: 16|47` plus `offset` sheet convention.
  It also accepts a sparse `transitions: [{ mask, tile, weight? }]` list in any order, so a
  hand-made edge set no longer has to occupy a rigidly sorted block in the tileset.
- Tilemap writes (`set_tile`, `fill_tilemap`, `autotile`, `stroke_tilemap`) can include
  `bake: { layer, frame?, blend: "over", opacity?, underlay? }`. Only actually changed
  cells are cleared and redrawn. `underlay` stamps a ground/base tilemap first, so a
  partially transparent bank/edge tile blends with real terrain rather than transparency
  or an unrelated prop that happened to share the layer.
- `paint_tilemap` bakes any region into a normal pixel layer. `copy` remains the default;
  `blend: "over"`, `opacity` and `clear` support organic edge masks. `preview_tilemap`
  renders an unbaked grid directly and can overlay tile boundaries, numeric indices,
  invalid cells and the exact cells/rect changed by the previous mutation. `underlay`
  composites a ground/base grid first, so partial-alpha bank masks can be judged without
  baking either map.
- `quality_report { tilemap, underlay? }` reports invalid indices, empty and dominant ratios, variant
  entropy, same-tile adjacency/runs, connected terrain, singleton cells and open edges.
  Pixel-noise and flat-band findings become informational in this mode because ripples,
  crop rows and road texture are intentional.
- Gameplay metadata lives beside the visual grid. `set_tile_properties` /
  `remove_tile_properties` / `get_tile_properties` store collision, walkability and
  movement values per tile index. `add_map_object`, `update_map_object`,
  `remove_map_object` and `get_map_objects` keep spawns, triggers, bridges and interactive
  props independent from tile cells, with their own JSON-safe custom properties.
- `export_tiled` writes a Tiled `.tmj` plus the referenced tileset PNG by default and
  rejects malformed data, mixed cell sizes and out-of-range tile indices before writing.
  Tile custom properties become Tiled tile properties and map objects become a separate
  object-group layer.

### Exporting an animation

- `export_gif` writes an animated GIF. Omit `tag` for every frame in timeline order, or pass
  an existing tag and its `direction` (`forward`, `reverse`, `pingpong`) and `repeat` decide
  playback order and looping. An explicitly named tag that does not exist is an error rather
  than a silent whole-timeline fallback. `scale` upscales by an integer factor and
  `background` fills transparency.
- `preview_animation` renders a review-only contact sheet. Use `tag` for expanded playback
  order or `frameOrder: "timeline"` for the raw source order; `layout`, `columns`, `padding`,
  `margin`, `onion`, `layers`, `scale`, and `background` control the view. Set
  `format: "gif"` to return an animated image for clients that support playback.
- `finalize_document.outputs` can deliver a contact sheet beside source, sheet, frames and GIF;
  `manifest: {path, hashes}` produces an engine-facing bundle inventory.
- `export_sheet` writes the raw timeline as a spritesheet PNG plus Aseprite-compatible JSON,
  with animation tags exported as `meta.frameTags`. `export_png` with `frames: "all"`
  writes one file per raw timeline frame. This keeps engine slicing deterministic; use the
  GIF or a tag-aware playback sequence when reviewing direction/repeat behaviour.

## Scripting and plugins

`packages/script` adds a constrained JavaScript layer on top of the same command bus. It is
**Node-only** — `core` stays platform-free — and it is deliberately narrow: a script can only
drive the editor through the commands, never touch the filesystem, the network or `process`.

A script runs inside a restricted `node:vm` context with no `require`, no `process`, no `module`,
no `eval`/`new Function` and no string code generation, under a timeout (2 s in the core runtime;
15 s through MCP unless `timeoutMs` is supplied). Node's
`vm` API is not a security mechanism, so only run trusted scripts and plugins. It is
handed a small **context-native** API — `exec`, `tryExec`, `putPixels`, `commands`, `command`,
`document`, `layers`, `frames`, `tags`, `palette`, `tilemaps`, `mapObjects`,
`tileProperties`, `getPixel`, `sample`, the explicit `sampleComposite`, and `log`. Thin
`draw.rect/line/ellipse/polygon/polyline/
pixels/putPixels/tile/tilemap/bake` aliases plus `strokeTilemap`/`paintTilemap` keep map
scripts readable while still using the same command schemas and one undo step. Its return
value and logs come back as JSON:

```js
const base = layers()[0].id;
exec('draw_rect', { layer: base, frame: 0, rect: { x: 0, y: 0, w: 8, h: 8 }, color: 'pal:3', fill: true });
exec('draw_pixels', { layer: base, frame: 0, pixels: [{ x: 0, y: 0, color: '#101820' }] });
putPixels({ x: 8, y: 0, w: 2, h: 1 }, '/wAA/wD/AIA=');
log('done', commands().length);
return { w: document().width };
```

**A whole script is one undo step.** The runtime wraps every committed call in
`editor.transaction`, so a fifty-command script is a single `Ctrl+Z`, exactly like one brush
stroke. A script that only reads creates no undo entry. MCP `run_script { dryRun: true }`
executes document commands against an isolated snapshot instead, so validation and preview
never change the live sprite, version, history or dirty state. Loaded plugins remain trusted
process-local code; their own closure/global counters are not virtualised by dry-run.
Runtime/command failures include `errorInfo` with a stable phase and, when Node exposes it,
source-relative line/column plus the command name.

A **plugin** is just a script that calls `defineCommand(...)`. The command it declares is
validated by a generated zod schema and registered on the live registry, so it shows up in the
MCP tool list, in `pixel commands` and in every open document at once:

```js
defineCommand({
  name: 'stripe_fill',
  description: 'Fill the canvas with horizontal stripes of two colours.',
  params: {
    a: { type: 'color', required: true },
    b: { type: 'color', required: true },
    step: { type: 'int', min: 1, default: 2 },
  },
  run(api, { a, b, step }) {
    const doc = api.document();
    for (let y = 0; y < doc.height; y += step) {
      api.exec('draw_rect', { layer: doc.layers[0].id, frame: 0,
        rect: { x: 0, y, w: doc.width, h: 1 }, color: y % (step * 2) === 0 ? a : b, fill: true });
    }
  },
});
```

`params` types are `number | int | boolean | string | color | layer | frame | rect | point |
json`, each accepting `required`, `default`, `description`, `min`, `max` and (for strings)
`values`. A plugin command's parameters are strict: it accepts exactly what it declares.

Ways to run them:

- **MCP** — `run_script` (`{ document, source, timeoutMs?, dryRun?, expectedVersion?, preview?, previewOptions? }`), `load_plugin`
  (`{ source? | path?, name? }`, which hot-registers the new tools and emits
  `notifications/tools/list_changed`) and `list_plugins`. `pixel://script-guide` is the API
  reference an agent reads first.
- **CLI** — `pixel script <file.pixel> --src script.js` (or `--code "..."`) with
  `--timeout`, `--dry-run`, `--preview out.png`; and a repeatable `--plugin <file.js>` on
  `script`, `apply`, `pipeline` and `commands`.

## For AI agents

The command catalogue is the contract. `describeCommands(allCommands)` in `@pixel/core`
turns each command's zod schema into JSON Schema, so tool documentation is generated from
the same validation the command actually performs and can never drift:

```bash
node packages/cli/dist/index.js commands --json > tools.json
```

The MCP server uses exactly this — the tools it advertises *are* the commands in
`allCommands`, validated by the same schemas. Plugins extend that same registry at runtime, so
a new command is a new tool with no second, hand-maintained list to fall out of date.

