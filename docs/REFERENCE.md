# dotloom-mcp — Technical Reference

> This document preserves the detailed command, MCP, scripting, and architecture notes. For installation and the project overview, return to the [main README](../README.md).

dotloom-mcp is a pixel-art tool built from day one to be operated by **both humans and AI agents**.

The public npm distribution is [`dotloom-mcp`](https://www.npmjs.com/package/dotloom-mcp). The `@pixel/*` workspace packages below are internal implementation packages; they are not separate npm products.

The published package ships **TypeScript declarations** alongside its JavaScript. `pnpm build:npm` runs esbuild for the three bundles and then a `tsc --emitDeclarationOnly` pass for `scripts/npm-index.ts` alone, into `dist/types/`, because the bundle is an erased JS file with no type information left in it and the types can only come from the sources. Two consequences worth knowing before editing that step:

- **`rootDir` is the repository root, and the tree ships whole.** The entry imports `@pixel/core` by relative path, so the emitted declarations are full of `../packages/core/src/...` specifiers. Keeping the tree keeps those paths valid inside the tarball; flattening them would need a third-party bundler and would answer a different question from the one `pnpm typecheck` answers.
- **Bare `@pixel/*` specifiers are rewritten, and the build throws if one survives.** That name resolves through the workspace and nowhere else, so a consumer's `tsc` would report `Cannot find module '@pixel/core'` on a file they never asked for. A `.d.ts` that does not resolve is worse than no `.d.ts`: it fails at the consumer's build instead of at import. The same check covers every other bare specifier — those must be declared `dependencies`, or a consumer cannot resolve them either.

`packages/core/test/npm-consumer-types.test.ts` proves it the way a consumer experiences it: build, `npm pack`, unpack into a temporary project, and compile against it with `skipLibCheck: false`. A declaration full of `any` would pass the happy path, so the test also requires a file of deliberate mistakes to produce named diagnostics. See [`API.md`](API.md) for the surface those types describes, and [`STABILITY.md`](STABILITY.md) for which of those names are promised, which are not, and what happens to a `.pixel` file written by a newer build.

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
node packages/cli/dist/index.js contract hero.pixel --out bundle/hero-idle.meta.json --engine godot
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
- **Vector outlines in** — `trace_svg { svg }` reads a flat filled SVG and lands it on the
  pixel grid. `scale` is SVG units per pixel (`16` puts a 512-unit icon in a 32px cel) and
  `offset` is where SVG (0,0) goes. Each shape paints its own `fill` through the palette, so
  `paletteLocked` snaps the whole trace to the document's swatches; pass `color` to flatten it
  to one. Coverage is hard-edged — run `antialias` afterwards if you want a softer staircase.
  `path` (all commands, arcs included), `rect`/`circle`/`ellipse`/`polygon`/`polyline` are
  traced, holes included. Refused with a readable error rather than approximated: any
  `transform`, an inherited `<g fill>`, and `fill: url(#gradient)`. Named in `skipped`:
  `line`, `image`, `text`, `use`, and `fill: none` (strokes are never traced).
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

- **stdio** — the default `dotloom-mcp` server. It prefers a running desktop app: it
  discovers the app's loopback endpoint and forwards to it, so the agent shares the
  window's documents and undo history. When no app answers it runs self-contained in
  memory and keeps watching, reconnecting when the app appears and falling back to memory
  when it goes away. `--standalone` skips discovery. The stdio server adds one tool of its
  own, `get_connection_status`, which reports whether the session is attached or in memory.
- **HTTP** — embedded in the Electron app (see above), for attaching to a live session.
- **`--attach <url>`** — a transparent stdio→HTTP bridge, so a client that only speaks stdio
  (Claude Desktop and friends) can drive a *running* app, pinning one endpoint and failing
  rather than falling back. It relays every request, notification and capability verbatim.

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

On Windows both entries need `"command": "cmd"` with `"/c"` prepended to the argument list, so
`"args": ["/c", "npx", "-y", "dotloom-mcp", ...]`. Bare `npx` is not an executable Windows can
launch without a shell (`ENOENT`), and Node refuses to run `npx.cmd` directly (`EINVAL`).
Per-client paths and verified JSON for all four clients are in [`CLIENTS.md`](CLIENTS.md).

### OpenCode project configuration

OpenCode reads the published stdio server from `opencode.json` / `opencode.jsonc`, either
globally (`~/.config/opencode/`) or per project:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "dotloom-mcp": {
      "type": "local",
      "command": ["npx", "-y", "dotloom-mcp"],
      "enabled": true
    }
  }
}
```

On Windows the `command` array is `["cmd", "/c", "npx", "-y", "dotloom-mcp"]`.

**`mcp` is not `mcpServers`, and the server name is a key directly under it.** OpenCode maps a
name straight to a server entry: `mcp` → `dotloom-mcp` → `{type, command}`. There is no
intermediate `servers` key. `mcp.servers.dotloom-mcp` is read as a server literally named
`servers` with no `type` and no `command`, so `dotloom-mcp` is never configured at all, and
OpenCode's published JSON Schema rejects the object. `command` is one array that includes the
program, not a string plus a separate argument list, and `type` is required.

`opencode mcp add` is an interactive guide: run it with no arguments and answer the prompts.
OpenCode's CLI documentation lists no positional arguments and no flags for it, so there is no
non-interactive form to transcribe here. Verify the result with `opencode mcp list`.

Per-client paths and every Windows variant: [`CLIENTS.md`](CLIENTS.md).

No `--attach` is needed: the server finds a running app on its own and reconnects if the
app appears later. Append `--attach http://127.0.0.1:7331/mcp` only to pin one endpoint
and fail loudly when it is not there.

### What it exposes

- **A small declared surface plus an on-demand command catalog.** The advertised list is 37
  tools over stdio, measured with `node scripts/mcp-call.mjs list`; that number drifts, so
  re-measure it rather than copying it out of a document. 36 of them are shared with the app's
  HTTP host — the session, perception, export and discovery tools: `create_document`, `create_sprite_spec`,
  `open_document`, `save_document`, `finalize_document`, `import_image` (PNG or Aseprite),
  `select_document`, `close_document`, `list_documents`, `get_document`, `get_preview`, `preview_pose`,
  `preview_animation`, `preview_tilemap`, `read_grid`, `get_pixels`, `histogram`, `get_selection`,
  `set_selection`, `evaluate`, `get_palette`, `get_history`, `undo`, `redo`, `apply_ops`, `export_png`,
  `export_sheet`, `export_tiled`, `export_gif`, `list_commands`, `describe_command`,
  `find_workflow`, `read_skill`, `describe_recipe`, and the scripting tools `run_script`,
  `load_plugin`, `list_plugins`.
  The stdio server adds `get_connection_status` on top of that 37, so the agent can tell
  whether it is editing the app or an in-memory store.

  The ~90 core commands (`draw_rect`, `autotile`, `create_tileset`, `add_palette_ramp`, …) are **not**
  in that list up front: shipping all 127 cost ~55K tokens of tool definitions in the context of every
  request. They are reachable three ways, and all of them *promote* the command to a real tool once this
  session touches it:

  | Trigger | Result |
  | --- | --- |
  | `list_commands { name: "autotile" }` | exact lookup promotes it |
  | `describe_command { name: "autotile" }` | returns the schema **and** promotes it |
  | `find_workflow { goal: "..." }` | promotes the commands the top match recommends |
  | `apply_ops` / `run_script` | promotes every command the batch actually issued (a `dryRun` counts) |

  Responses name what was promoted in `promotedTools`, and `list_commands` marks each catalogue entry
  `tool: true` once it is directly callable. So the tool list tracks the work rather than guessing up
  front. `apply_ops` runs any command inline with or without promotion, so nothing is unavailable.
  Pass `commands: 'eager'` to `createPixelServer` for the old flat 127-tool surface.

  `list_commands` returns the runnable command catalogue plus a `sessionTools` list, so
  `undo`/`redo`/`get_history`, `apply_ops`, and the perception/export tools are discoverable
  from one call. Its compact response includes `readOnly`; use exact `name`, parameter-name
  `param`, substring `filter`, and optional `limit` for progressive discovery, then
  `verbose: true` for full schemas. A substring `filter` browses without promoting, on purpose —
  otherwise one "draw" query would sweep the catalog in. `describe_command {name}` returns one exact
  live schema plus the command's long-form `guide` (also at `pixel://guide/{command}`) when it has one,
  while `find_workflow {goal}` searches task-level command sequences. `undo`/`redo`
  take `steps` (alias `count`). `create_document` takes `select: false`
  to build a scratch document without stealing focus, `select_document` accepts an id or a
  name, and `get_preview` takes `rect` to crop-zoom a detail. Document summaries expose
  both `active` and `activeDocumentId`; an explicit `get_document {document}` reads without
  changing the session focus.
- **Declarations that are dialled in, not repeated.** Two arguments, `document` and `expectedVersion`,
  are accepted by every tool and are *not* advertised in every schema — they were 9.4K tokens of
  "operate on the active document" restated 127 times, and the server instructions say it once instead.
  Safe-integer bounds from zod (`minimum: -9007199254740991`) are stripped from the advertised form:
  521 occurrences, 28.7KB, none of them actionable. Validation still runs against the full strict
  schema, so nothing is loosened — only the advertisement changed. Every tool declares all four risk
  hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), so a client can gate
  on them: `run_script` and `load_plugin` are the two marked `openWorldHint` because they execute
  code this server did not write, and a promoted plugin command is marked both open-world and
  destructive.
- **Command manuals, read on demand.** A `guide` field on a command, served as
  `pixel://guide/{command}` and returned by `describe_command`. `stroke_tilemap`, `autotile`,
  `dither_fill`, `set_tile`, `mirror`, `add_palette_ramp` and `outline` keep their long-form
  conventions without carrying them in every request. `add_palette_ramp`'s is the one to read
  first: hue interpolates along the HSL wheel, so a dark-cool to light-warm pair swings through
  magenta and red unless the two anchors are kept close together.
- **`run_script` takes a program or a file, and inputs.** `path` names a `.js` file holding the
  same function body as `source`; the two are mutually exclusive, the file is re-read on every
  call and never cached (so editing it takes effect with no restart), and the response reports
  `resolvedPath`. Relative paths resolve against the server working directory and `~` expands.
  `params` is exposed to the script as the global of the same name, which with `path` makes one
  file a function of its inputs: tuning a value costs one short call instead of re-sending the
  program. A parameterised generator is the case this exists for.
- **`get_selection`: the user points, the agent stops guessing.** In the desktop app the
  select tool (marquee icon, `M`) drags a rectangle; the canvas dims everything outside it
  and tints what is inside, and a readout in the bottom-right shows the size, the origin
  and a **Hint / Confine** toggle. The user then talks about what is in the box — "the head
  in my selection is too small" — and `get_selection` is how the agent finds out where they
  mean. It returns the rect plus the layer and frame the box was drawn on, so the agent
  knows which layer it is looking at rather than assuming the active one. It answers
  `{selection: null}` when there is no box, and that is a real answer: work on the whole
  canvas rather than inventing a region. `get_preview {rect}`, `read_grid {rect}` and
  `histogram {rect}` all take that rect, so the agent can inspect the region closely before
  touching it. `set_selection` is the same box from the other side, for confirming a guess
  or narrowing a box the user drew too loosely.
  This works without any synchronisation code because the app hosts the MCP server in its
  main process and both go through the one `DocumentStore`; the box is a field on the shared
  `PixelDocument`, not a copy each side maintains. It is session state, deliberately: it is
  not part of `Sprite`, so it cannot reach the `.pixel` file, an export or a spritesheet, it
  costs no undo step, and it does not mark the document dirty — a box says where the subject
  is, it is not an edit. A drag that runs backwards is normalised, one that leaves the canvas
  is clipped, a click with no drag clears the box, and a box whose layer or frame has since
  been deleted is dropped on read rather than handed over, because an agent acting on a
  dangling layer id would edit the wrong pixels.
  `mode` is the one real design decision here. `hint` is the default because the motivating
  request — make the selected head bigger — is *incompatible* with a hard clip: the edit has
  to reach outside a box that tightly bounds the head. `enforce` confines every write to the
  box, which is what you want for cleaning up a known area, and the toggle is in the canvas
  readout rather than buried in a preference because the right answer depends on the request.
- **`read_grid` and the grid resource: text where a picture cannot answer the question.**
  A `image/png` is the only way to judge whether a piece *looks* good, but it is a poor
  tool for the questions an agent actually iterates on: a 256px downsample of a 32x32
  sprite cannot say whether the silhouette is symmetric or whether row 14 is one step off
  row 13, and an image cannot be diffed, so it has to be re-read and re-reasoned about
  after every edit. `read_grid` returns the same pixels as one character per pixel with
  absolute rulers and a legend, which costs roughly half a base64 preview for a 16x16
  canvas and is exact. Four views: `mask` (silhouette), `value` (a luminance ladder with
  one glyph per distinct tone), `index` (palette slot, so the next draw can name the
  colour as `pal:7`) and `named` (generated colour names). `scope: "cel"` reads one
  layer alone. A repeated call with the same arguments also diffs against the previous
  read and prints the changed rows with their before and after, and `allFrames: true`
  adds per-frame silhouette drift. The diff compares cell *identity* rather than
  rendered glyphs, because the `value` ladder is ranked over the tones present and
  re-labels itself when one is added. The same content is served at
  `pixel://documents/{id}/grid?view=…&frame=N&layer=…&rect=x,y,w,h`.
  The split is deliberate: **`read_grid` verifies, `get_preview` approves.**
- **`evaluate` measures the artwork, and it is deliberately framed so the number is not the
  target.** It runs the quality dimensions from [`EVALUATION.md`](EVALUATION.md) over the
  document's frames, one frame, or one animation tag, and returns the aggregator's report
  verbatim plus a flat `issues` list — every defect, deduplicated by `(code, rect)` and sorted
  by severity descending, each with the canvas rectangle to fix. The payload carries no
  letter, grade, percentage or summary sentence, and `howToRead` says in every response that
  the scores are diagnostics for finding defects: a `quality_report` tool existed once and was
  deleted in 0.3.1 because a model told the number was "clean" sanded a lake into a dark flat
  rectangle. Two fields carry the distinction the whole applicability mechanism exists for, and
  neither may be collapsed into the other: `report.dimensions` holds what *was* measured (a
  **missing key** means the dimension did not apply — never a zero), `report.excluded` says
  why each absent one is absent, and `dimensions.*.unmeasured` says which *sub-scores* of a
  dimension that was measured it could not reach. `notes` spells every one of those absences
  out in prose, and `issuesTruncated`/`issueCount` mean a shortened list is never silent.
  `pixel://quality/{id}` returns the same bytes without a tool call; scoping to a region is
  the tool's `rect`, because the URI template cannot carry a comma-separated one.
- **Static resources and document templates.** `pixel://documents`, `pixel://commands`,
  `pixel://skill` (a pixel-art craft guide), `pixel://script-guide` (the sandbox/plugin API),
  `pixel://guide/{command}` (a command's long-form manual — the detail behind a short tool
  description, pulled at the moment it is needed), `pixel://quality/{id}` (the quality report,
  byte-identical to the `evaluate` tool's answer, with `?tag=`, `?frame=N` and `?maxIssues=N`),
  `pixel://recipes` (the recipe catalogue, one line per recipe) and `pixel://recipe/{id}` (one
  art-direction recipe whole — the same bytes `describe_recipe` returns, and listed on
  `resources/list` so a client can enumerate a catalogue that is just a directory),
  plus document, grid and preview templates. The preview is a real `image/png` blob, so
  multimodal models can *see* the art; it takes the same view options as `get_preview` as
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
   else's work. Read-only commands never bump the version or eat your redo stack. It is
   accepted on every tool without being advertised in every schema, so read it from the server
   instructions, not from a tool's parameter list.
4. **Failures are a contract, not prose.** A failed call returns `{ok: false, error, code, remediation?}`.
   Branch on `code` (`version_conflict`, `invalid_op`, `unknown_command`, …) and follow `remediation`
   when present. Every tool declares an `outputSchema` covering this envelope, so a client can validate
   the result instead of parsing prose.
5. **`clip` is the constraint that makes drawing tractable.** `clip: "composite"` paints
   only where the *other* layers already have pixels, so a shadow, highlight or dither band
   cannot spill into the transparent corners of its bounding box. `clip: "cel"` clips
   against the layer being painted, and `clip: {layer: "hair"}` / `{layers: [...]}` clip to
   named layers — handy for shading one part of a body. When the clip layer renders
   *above* the layer being painted the paint would be hidden, so the command returns a
   `warning`. Paired with `scope: "composite"` on `outline` and `measure_region`, it removes
   the whole class of "must stay inside the silhouette" bugs; `outline` also takes
   `alphaThreshold` so a faint glow is not traced as a hard contour.
6. **Dithering is a write rule, not a special command.** `dither_fill` takes a `shape`
   (`{rect}`, `{ellipse}` or `{polygon}`) so a transition band can follow a curve instead of
   being a box, and every paint command (`draw_rect`, `draw_ellipse`, `draw_polygon`,
   `draw_line`, `fill`, `draw_pixels`) also accepts `pattern` and `level`. A dithered shape
   lands on exactly the pixels a solid one would, and it composes with `clip`. On large
   canvases prefer `cluster2`/`cluster4`: the same coverage lands as 2×2/4×4 blocks instead
   of digital 1px stipple.
7. **`finalize_document` closes the production loop in one call.** It saves the editable
   `.pixel` source and renders a typed output plan: individual PNGs, all-frame PNGs,
   spritesheet + Aseprite JSON, tag-aware GIF, pose renders, timeline/playback contact
   sheets, and — opt-in — the asset contract and engine files below. Every output is
   rendered before any file is written. An optional manifest records
   source version, frame durations, tags, actual output paths/sizes, and SHA-256 hashes;
   `incremental: true` reuses that manifest to skip unchanged source/output files. The legacy
   PNG-only `exports` array remains accepted.
   **Asset outputs are opt-in, not automatic.** `{type: "meta", path}` writes the
   engine-agnostic `meta.json` of [`ASSET-CONTRACT.md`](ASSET-CONTRACT.md), and
   `{type: "engine", engine: "godot" | "unity" | "phaser" | "excalidraw", path}` writes that
   contract *and* the engine files generated from it, under `<asset.name>/` beside the contract
   unless `directory` says otherwise. Both take `sheet` (defaulting to the plan's `sheet`
   output), `outputs[]`, `directions[]` and `direction` labels; the naming validator
   ([`IMPORTERS.md`](IMPORTERS.md)) runs on the contract first and **refuses the write** on a
   naming error, the way the quality gate refuses. See `docs/IMPORTERS.md` for why opt-in
   rather than automatic.
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
- `.pixel` files use container format v2, which is the manifest with `sprite.rig` in it. The
  version describes the format, not the payload: every file is stamped
  `PIXEL_FORMAT_VERSION`, with or without a rig. Version-1 files remain readable, and
  `manifest.version > PIXEL_FORMAT_VERSION` is refused.
- `create_sprite_spec` is a declarative structural scaffold: layers, frames, tags, semantic
  palette roles and an optional rig in one call. It creates no artwork or art-direction
  decisions beyond the supplied structure.

#### The `.pixel` container layout

A `.pixel` file is a plain zip: inspectable with any zip tool, diffable in git, and
survivable under partial corruption.

```
manifest.json              structure, palette, tags, rig, map objects — and every id in the file
cels/<frameIndex>_<layerIndex>.png    one PNG per non-empty cel
tileset.png                optional, the tile sheet
tilemaps/<index>.json      optional, a flat tile-index array per tilemap
```

**Entry names are positions, never ids.** A cel map is keyed by layer id and holds at most
one cel per layer, so the frame index plus the layer's position in `sprite.layers` is
already unique — an id in the filename bought nothing and cost reproducibility. An earlier
layout wrote `cels/<frameIndex>_<layerId>.png` and `tilemaps/<tilemapId>.json`; both still
load, because `manifest.cels[].path` and `manifest.tilemaps[].data` are the only places a
path is written down and the reader has always gone through the manifest rather than
parsing a name. That makes the rename safe in both directions — a 0.4.1 file opens in a
current build, and a 0.4.1 build opens a current file — so the container version is
deliberately **not** bumped; entry names were never part of the format contract.

**Reproducibility.** For a document built under `deterministicIdFactory`, `serializeSprite`
is byte-reproducible: same ops, same seed, same bytes. The entry timestamp is pinned to
1980-01-01 local, so the archive does not move when the wall clock does, and the encoding
of that date is local on purpose so the bytes do not depend on the machine's timezone.
Under the default `makeId` the guarantee does not hold, and cannot: every id in the
document lives in `manifest.json`, which is itself an archive entry, and `makeId` is
clock+entropy based on purpose. Reordering layers renumbers the cel paths — the number
means "the nth layer of the document", and the manifest is what maps a number back to an
id. See `ids.ts` for which id factory to install and why.

### Eight directions and generated walk cycles

An 8-direction character set must not be eight hand-drawn sheets. It is **three drawings**
plus two exact transforms, and that is what this pair of commands exists to express.

- `get_directions` is **read-only**. It returns all eight directions with the facing vector,
  the quarter turns and mirror that produce each one, whether that is `exact`, which drawing
  it reuses, and the resolved canvas matrix about a chosen anchor. It needs no rig.
- `generate_walk_cycle` writes `frames` frames after the rig rest frame, each with
  `frameDurationMs`, plus one looping animation tag (`walk_<direction>`, `repeat: 0`),
  all in **one undo step**.

| direction | transform | exact | drawing it reuses |
| --- | --- | --- | --- |
| `E` | identity | yes | the base |
| `W` | horizontal mirror | yes | the base |
| `S` | one quarter turn clockwise | yes | the base |
| `N` | three quarter turns | yes | the base |
| `SE` | as `S` | **no - draw it** | one SE diagonal |
| `SW` | mirror of the SE drawing | **no - draw it** | the same SE diagonal |
| `NE` | as `N`, mirrored | **no - draw it** | one NE diagonal |
| `NW` | mirror of the NE drawing | **no - draw it** | the same NE diagonal |

- **The base pose is drawn facing E.** Every cardinal is a whole-figure rotation about the
  orientation anchor or its mirror, and **five of the eight need no new artwork at all**. A
  mirror is exact because it is a reflection, and a quarter turn is exact because a signed
  axis permutation is lossless on a pixel grid; the whole-cel transform preserves the opaque
  pixel count.
- **Orientation anchors.** A direction change turns about a named anchor and never moves it.
  `ground` (bottom centre, the default) is the contact point under the feet, so a character
  turns on the spot; `facing` (top centre) is a head marker; `origin` is the canvas centre.
  `ground` and `facing` share the vertical axis `x = (w-1)/2`, which is what makes `W` an
  exact mirror of `E` rather than an approximation of one. Pass `pivot` to override.
- **The diagonals are not transformable, and the spec says so.** A diagonal is a different
  *drawing*, not a rotated copy, and there is no 45-degree pixel transform that survives a
  pixel grid — the engine will not emit one, and `determinism.test.ts` bans the `cos(45)` it
  would need. Each diagonal therefore carries the transform of the cardinal it leans toward
  (45 degrees off, reported as `resolvedFrom`) and `exact: false`. `generate_walk_cycle`
  still bakes them and reports `exact: false`, so an approximate direction is a statement
  about artwork, not a refusal.
- **Use a square canvas.** A quarter turn is mapped into the *same* canvas rather than a
  swapped one, so a non-square canvas clips the figure at an odd quarter turn. This is a
  documented limit rather than a resize, because resizing would desynchronise the document's
  dimensions from every frame's cels.
- **The loop closes with no seam.** The gait is driven by integer triangle waves of period
  `2 * frames` sampled at `index mod frames`, so frame `frames` is the *same pose* as frame
  `0` — never a second copy of it, which §4.6's `motion` dimension scores as a seam.
  `phaseOffset` staggers a loop by whole frames without changing it.
- **Two contacts per cycle.** Legs are maximally split at the contacts and coincident at the
  passing frames; the body bobs low on the contacts and high between them. Legs, arms and the
  bobbing body are chosen by part name (`leg`/`foot`/`thigh`/`shin`, `arm`/`hand`/`forearm`,
  `body`/`torso`/`hips`/`chest`/`root`/`spine`); pass `legs`/`arms`/`body` to override. A rig
  where nothing matches falls back to the parentless parts, and the summary reports it.
- Walk poses are **transient**: they are not pushed into the rig, so a document never
  accumulates one pose per frame per direction. Use `save_pose` for a stance to keep.
  `generate_walk_cycle` refuses to write the rig rest frame, as every pose bake does.

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
- `preview_tilemap`'s `structure` block reports invalid indices, empty and dominant ratios,
  variant entropy, same-tile adjacency/runs, connected terrain, singleton cells and open
  edges. Read it as evidence: ripples, crop rows and road texture are intentional, so a
  long same-tile run is a fact about the map rather than a defect. `export_tiled` refuses
  to write a map whose indices or cell size are malformed.
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
- `share_bundle` builds a whole share bundle from a `share-templates/*.share.json` preset:
  the rendered PNG carrying its provenance as `tEXt` chunks, an optional spritesheet,
  per-frame PNGs, GIF, contact sheet, baked rig pose and `meta.json` with one engine's files,
  a self-contained HTML card naming every defect and every abstention, and a `share.json`
  record. Its `outputs` union is the one `finalize_document` offers, spelled the same way;
  the contact sheet is `renderAnimationPreview` in core, the same renderer
  `preview_animation` and `finalize_document` draw.
  Read-only and deterministic, and it writes nothing: each file comes back base64
  in `files[]` for the caller to place. The template schema is `shareTemplateSchema` on
  the command, a closed field set the build script does not duplicate. It publishes **no
  score** - named defect codes only, which is the rule for the whole bundle. See
  `docs/SHARING.md`.
- `finalize_document.outputs` can deliver a contact sheet beside source, sheet, frames and GIF;
  `manifest: {path, hashes}` produces an engine-facing bundle inventory.
- `finalize_document.outputs` also takes `{type: "meta", path}` for the asset contract
  (`meta.json`) and `{type: "engine", engine, path, directory?}` for one engine's files. Both
  are opt-in, both pass through the quality gate and the naming gate, and both land in the
  hashed manifest like every other output. `directions: ["S", "N"]` writes
  `frames.directions`; omit it and no block is emitted at all, byte for byte as before the
  field existed. `license` is not a parameter — add the block to the file, because the
  document model has no licence field and this will not invent one.
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

