# pixel-art

A pixel art tool built from day one to be operated by **both humans and AI agents**.

The product is not the Electron window — it is the **headless, addressable pixel document
model** in `packages/core`. The Electron app and the MCP server are both just clients of it.

## Layout

| Package | Role |
| --- | --- |
| `packages/core` | Pure TypeScript. Document model, command bus, rasteriser, PNG, serialisation. **No DOM, no Electron, no Node APIs.** |
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
- [ ] **M5** scripting sandbox, plugins

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
node packages/cli/dist/index.js tiled hero.pixel --out hero.tmj            # Tiled map from the tilemaps
node packages/cli/dist/index.js gif hero.pixel --out hero.gif --tag idle   # animated GIF, tag-driven order
node packages/cli/dist/index.js import hero.png --out hero.pixel           # PNG or .ase -> document
node packages/cli/dist/index.js apply hero.pixel --ops ops.json            # run commands (the AI entry point)
node packages/cli/dist/index.js pipeline hero.pixel --ops ops.json --out preview.png
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
- **Clipping** — any draw can be restricted with `clip`, so shading, highlights and dither
  bands stay inside the silhouette instead of filling their bounding box.
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
  `quantize_to_palette` to snap existing artwork to the palette (with dithering).
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
can drive the editor directly. It runs two ways:

- **stdio** — the standalone server below, for any MCP client, no GUI required.
- **HTTP** — embedded in the Electron app (see above), for attaching to a live session.

```bash
pnpm build
node packages/mcp/dist/cli.js          # speaks JSON-RPC on stdin/stdout
```

Client configuration (Claude Desktop, or any `mcpServers` JSON):

```json
{
  "mcpServers": {
    "pixel-art": {
      "command": "node",
      "args": ["G:/AI项目/pixel-art/packages/mcp/dist/cli.js"]
    }
  }
}
```

### What it exposes

- **71 tools.** Every core command (50) is generated straight from its zod schema, plus
  hand-written session and perception tools: `create_document`, `open_document`,
  `save_document`, `import_image` (PNG or Aseprite), `select_document`, `close_document`,
  `list_documents`, `get_document`, `get_preview`, `get_pixels`, `get_palette`, `get_history`,
  `undo`, `redo`, `apply_ops`, `export_png`, `export_sheet`, `export_tiled`, `export_gif`,
  `list_commands`, `read_skill`.
- **5 resources** (3 static + 2 templates). `pixel://documents`, `pixel://commands`,
  `pixel://skill` (a pixel-art craft guide), plus the templates `pixel://documents/{id}` and
  `pixel://documents/{id}/preview` — the latter a real `image/png` blob, so multimodal models
  can *see* the art.
- **4 prompts.** `draw_sprite`, `animate_sprite`, `improve_sprite`, `pixel_art_basics`.

### Five details that matter for agents

1. **`get_preview` returns an actual PNG image**, not a pixel array. A 32x32 sprite is ~10k
   tokens as JSON and ~200 tokens as an image, and the model can actually look at it.
2. **`apply_ops` batches.** An agent sends a list of commands in one round trip; with
   `atomic: true` a failure rolls the whole batch back. It also takes `defaultLayer` /
   `defaultFrame` so a long batch does not repeat itself, and `quiet: true` to drop the
   per-op summaries.
3. **`expectedVersion` gives optimistic concurrency.** Read a version, pass it back on the
   next write, and a stale edit fails with `version_conflict` instead of clobbering someone
   else's work. Read-only commands never bump the version or eat your redo stack.
4. **`clip` is the constraint that makes drawing tractable.** `clip: "composite"` paints
   only where the *other* layers already have pixels, so a shadow, highlight or dither band
   cannot spill into the transparent corners of its bounding box. `clip: "cel"` clips
   against the layer being painted. Paired with `scope: "composite"` on `outline` and
   `measure_region`, it removes the whole class of "must stay inside the silhouette" bugs.
5. **Dithering is a write rule, not a special command.** `dither_fill` takes a `shape`
   (`{rect}`, `{ellipse}` or `{polygon}`) so a transition band can follow a curve instead of
   being a box, and every paint command (`draw_rect`, `draw_ellipse`, `draw_polygon`,
   `draw_line`, `fill`, `draw_pixels`) also accepts `pattern` and `level`. A dithered shape
   lands on exactly the pixels a solid one would, and it composes with `clip`.

### Commands built for animation

- `translate { layer: "*", dx, dy }` shifts every layer of a frame together and clears the
  band it vacates. A 3-frame bob used to cost a `copy_region` plus a `clear_region` per
  layer per frame — 24 operations to say "move it down one".
- `squash { layer: "*", scaleX, scaleY, pivot: "bottom" }` scales about a pivot with
  nearest-neighbour sampling, keeping the canvas size so the artwork stays registered.
  `scaleY: 0.9, scaleX: 1.08` is the down beat of a bounce.

### Tilemaps and auto-tiling

A tilemap is a grid of tile indices, kept alongside the pixel layers. It is the right
structure for terrain, walls and floors, and it is what an agent uses to build a level.

- `create_tileset` cuts a tile sheet out of a layer you have already drawn.
- `add_tilemap` / `remove_tilemap` / `resize_tilemap` manage the grids;
  `set_tile` and `fill_tilemap` write cells (`-1` means empty); `get_tilemap` reads them back.
- **`autotile` is the headline.** Lay the terrain down with one placeholder index, then let
  it pick the transition tiles. `set: 16` uses the four edge neighbours (the classic cheap
  set); `set: 47` uses all eight and counts a diagonal only when both of its adjacent edges
  are solid — that rule is what makes 47 tiles cover every blob shape without chipped
  corners. `offset` says where this terrain starts in the sheet, so one sheet can hold
  several terrains, and the pass leaves the empty background alone.
- `paint_tilemap` bakes the grid into a normal pixel layer, so it flows into `export_png`
  and `export_sheet` unchanged.
- `export_tiled` writes a Tiled `.tmj` map with one tile layer per tilemap.

### Exporting an animation

- `export_gif` writes an animated GIF. Omit `tag` for every frame in order, or pass one and the
  tag's `direction` (`forward`, `reverse`, `pingpong`) and `repeat` decide the frame order and
  whether it loops — a pingpong idle bounces without duplicating any frames. `scale` upscales
  by an integer factor and `background` fills transparency.
- `export_sheet` writes the same frames as a spritesheet PNG plus Aseprite-compatible JSON,
  with the animation tags exported as `meta.frameTags`. `export_png` with `frames: "all"`
  writes one file per frame.
- All three read the frame order from the same `animationSequence` the canvas plays, so a
  preview and an export always agree.

## For AI agents

The command catalogue is the contract. `describeCommands(allCommands)` in `@pixel/core`
turns each command's zod schema into JSON Schema, so tool documentation is generated from
the same validation the command actually performs and can never drift:

```bash
node packages/cli/dist/index.js commands --json > tools.json
```

The MCP server uses exactly this — the tools it advertises *are* the commands in
`allCommands`, validated by the same schemas. There is no second, hand-maintained list to
fall out of date.

