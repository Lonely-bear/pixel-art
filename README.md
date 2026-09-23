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
- [ ] **M3** tilemaps, auto-tiling, Tiled export
- [ ] **M4** animation tags, spritesheet / GIF export
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
node packages/cli/dist/index.js import hero.png --out hero.pixel           # PNG -> document, palette derived
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
- **Palette** — click to set the primary colour, right-click for the secondary, and
  `quantize_to_palette` to snap existing artwork to the palette (with dithering).
- **Import / export** — open and save `.pixel`, import a PNG as a new document (deriving a
  palette from it), export a PNG at 1x–16x, or export a spritesheet with Aseprite-compatible
  JSON.

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

- **60 tools.** Every core command (41) is generated straight from its zod schema, plus
  hand-written session and perception tools: `create_document`, `open_document`,
  `save_document`, `import_image`, `select_document`, `close_document`, `list_documents`,
  `get_document`, `get_preview`, `get_pixels`, `get_palette`, `get_history`, `undo`, `redo`,
  `apply_ops`, `export_png`, `export_sheet`, `list_commands`, `read_skill`.
- **5 resources** (3 static + 2 templates). `pixel://documents`, `pixel://commands`,
  `pixel://skill` (a pixel-art craft guide), plus the templates `pixel://documents/{id}` and
  `pixel://documents/{id}/preview` — the latter a real `image/png` blob, so multimodal models
  can *see* the art.
- **4 prompts.** `draw_sprite`, `animate_sprite`, `improve_sprite`, `pixel_art_basics`.

### Four details that matter for agents

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

### Commands built for animation

- `translate { layer: "*", dx, dy }` shifts every layer of a frame together and clears the
  band it vacates. A 3-frame bob used to cost a `copy_region` plus a `clear_region` per
  layer per frame — 24 operations to say "move it down one".
- `squash { layer: "*", scaleX, scaleY, pivot: "bottom" }` scales about a pivot with
  nearest-neighbour sampling, keeping the canvas size so the artwork stays registered.
  `scaleY: 0.9, scaleX: 1.08` is the down beat of a bounce.

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

