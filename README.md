# pixel-art

A pixel art tool built from day one to be operated by **both humans and AI agents**.

The product is not the Electron window — it is the **headless, addressable pixel document
model** in `packages/core`. The Electron app and the MCP server are both just clients of it.

## Layout

| Package | Role |
| --- | --- |
| `packages/core` | Pure TypeScript. Document model, command bus, rasteriser, PNG, serialisation. **No DOM, no Electron, no Node APIs.** |
| `packages/script` | Sandboxed JavaScript runtime + plugin loader (`node:vm`). **Node only.** |
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
node packages/cli/dist/index.js tiled hero.pixel --out hero.tmj            # Tiled map from the tilemaps
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
    "pixel-art": {
      "command": "node",
      "args": ["G:/AI项目/pixel-art/packages/mcp/dist/cli.js"]
    },
    "pixel-art-live": {
      "command": "node",
      "args": [
        "G:/AI项目/pixel-art/packages/mcp/dist/cli.js",
        "--attach",
        "http://127.0.0.1:7331/mcp"
      ]
    }
  }
}
```

### OpenCode project configuration

在项目根目录创建 `.opencode/opencode.json` 后，可以让 OpenCode 直接加载本项目的 stdio MCP（先执行一次 `pnpm build`）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "pixel-art": {
      "type": "local",
      "command": ["node", "D:/AI项目/pixel-art/packages/mcp/dist/cli.js"],
      "enabled": true
    }
  }
}
```

使用当前项目目录启动 OpenCode 后，工具会显示在 `pixel-art` MCP 命名空间；如果要连接桌面应用而不是独立 server，可把 `command` 改为带 `--attach http://127.0.0.1:7331/mcp` 的参数数组。

### What it exposes

- **83 tools.** Every core command (57) is generated straight from its zod schema, plus
  hand-written session and perception tools: `create_document`, `open_document`,
  `save_document`, `finalize_document`, `import_image` (PNG or Aseprite), `select_document`, `close_document`,
  `list_documents`, `get_document`, `get_preview`, `get_pixels`, `quality_report`, `get_palette`, `get_history`,
  `undo`, `redo`, `apply_ops`, `export_png`, `export_sheet`, `export_tiled`, `export_gif`,
  `list_commands`, `read_skill`, and the scripting tools `run_script`, `load_plugin`,
  `list_plugins`. Loading a plugin registers its commands as real tools on the fly.
  `list_commands` returns the runnable command catalogue plus a `sessionTools` list, so
  `undo`/`redo`/`get_history` and the perception/export tools are discoverable from one
  call. `undo`/`redo` take `steps` (alias `count`). `create_document` takes `select: false`
  to build a scratch document without stealing focus, `select_document` accepts an id or a
  name, and `get_preview` takes `rect` to crop-zoom a detail. Document summaries expose
  both `active` and `activeDocumentId`; an explicit `get_document {document}` reads without
  changing the session focus.
- **6 resources** (4 static + 2 templates). `pixel://documents`, `pixel://commands`,
  `pixel://skill` (a pixel-art craft guide), `pixel://script-guide` (the sandbox/plugin API),
  plus the templates `pixel://documents/{id}` and
  `pixel://documents/{id}/preview` — the latter a real `image/png` blob, so multimodal models
  can *see* the art. The preview template takes the same view options as `get_preview` as
  query parameters: `?frame=N`, `?frames=all`, `?scale=N`, `?layers=a,b`, `?onion=N`
  (plus `?onionBefore`, `?onionAfter`, `?onionOpacity`, `?loop`, `?beforeTint`, `?afterTint`).
- **4 prompts.** `draw_sprite`, `animate_sprite`, `improve_sprite`, `pixel_art_basics`.

### Nine details that matter for agents

1. **`get_preview` returns an actual PNG image**, not a pixel array. A 32x32 sprite is ~10k
   tokens as JSON and ~200 tokens as an image, and the model can actually look at it. It also
   takes `layers` to isolate one or more layers, `rect` to crop-zoom a detail (a face, a hand),
   and `onion` to ghost the neighbouring frames
   (`before`/`after` counts, `opacity`, `loop`, and separate `beforeTint`/`afterTint`), so an
   agent can inspect a single layer or judge motion without exporting anything.
2. **`apply_ops` batches.** An agent sends a list of commands in one round trip; with
   `atomic: true` a failure rolls the whole batch back. It also takes `defaultLayer` /
   `defaultFrame` so a long batch does not repeat itself, and `quiet: true` to drop the
   per-op summaries. Pass `preview: true` and the same call returns the resulting PNG;
   `previewOptions: {frame, rect, layers, scale, background}` chooses the exact iteration
   view. `run_script` supports the same inline preview, so the usual draw→look→adjust loop
   needs one call per visual gate rather than two.
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
6. **`finalize_document` closes the loop in one call.** It saves the editable `.pixel` source
   and writes up to eight PNG exports in one request. A static asset normally needs one
   scale-1 original plus one 6–8x preview, replacing separate save/export round trips while
   returning every absolute path, output size, version and final document summary.
7. **`quality_report` turns "it feels harsh" into a checklist.** It reports isolated-pixel
   ratio, colour-outlier ratio, mean edge contrast, clipped-highlight ratio and palette
   usage, plus a rough 0–100 softness score and warnings. The matching fixes are
   `despeckle` (remove lone speckles and local outliers) and `antialias` (selectively soften
   silhouette corners and internal colour steps), both palette-lock aware.
8. **`add_palette_ramp` builds hue-shifted material ramps.** Give it a dark and a light
   anchor plus a step count, and it generates the intermediate colours in HSL, pulling the
   dark end toward blue/violet and the light end toward amber by `hueShift` degrees
   (default 20). `shadowHue`/`highlightHue` set absolute endpoint hues, `saturationBoost`
   adds mid-ramp richness, and `mode: "replace"` can swap the whole palette for a single
   coherent ramp.
9. **Binary and generative primitives avoid per-pixel JSON overhead.** `put_pixels` writes
   a base64 RGBA8888 rectangle in one command, with the script convenience API
   `putPixels(rect, data, options?)`; the core raster API also exposes
   `putPixels(buffer, rect, rgba, options?)` for an in-memory `Uint8Array`/`Uint8ClampedArray`.
   `banded_gradient`, `noise_fill` (value noise/fBm via `octaves`) and `scatter` generate
   deterministic seeded fields in one batch command, with palette-aware colours, clipping
   and a safety limit for scatter.

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

## Scripting and plugins

`packages/script` adds a sandboxed JavaScript layer on top of the same command bus. It is
**Node-only** — `core` stays platform-free — and it is deliberately narrow: a script can only
drive the editor through the commands, never touch the filesystem, the network or `process`.

A script runs inside a hardened `node:vm` context with no `require`, no `process`, no `module`,
no `eval`/`new Function` and no string code generation, under a timeout (2 s by default). It is
handed a small **context-native** API — `exec`, `tryExec`, `putPixels`, `commands`, `command`,
`document`, `layers`, `frames`, `tags`, `palette`, `getPixel`, `sample`, `log` — and its return
value and logs come back as JSON:

```js
const base = layers()[0].id;
exec('draw_rect', { layer: base, frame: 0, rect: { x: 0, y: 0, w: 8, h: 8 }, color: 'pal:3', fill: true });
exec('draw_pixels', { layer: base, frame: 0, pixels: [{ x: 0, y: 0, color: '#101820' }] });
putPixels({ x: 8, y: 0, w: 2, h: 1 }, '/wAA/wD/AIA=');
log('done', commands().length);
return { w: document().width };
```

**A whole script is one undo step.** The runtime wraps every call in `editor.transaction`, so
a fifty-command script is a single `Ctrl+Z`, exactly like one brush stroke. A script that only
reads creates no undo entry at all.

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

- **MCP** — `run_script` (`{ document, source, timeoutMs?, expectedVersion?, preview?, previewOptions? }`), `load_plugin`
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

