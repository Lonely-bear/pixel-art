<div align="center">
  <img src="assets/pixel-mark.svg" width="88" alt="dotloom-mcp logo" />
  <h1>dotloom-mcp</h1>
  <p><strong>A pixel-art engine for game assets, operated by people and by AI agents.</strong></p>
  <p>One engine, one document model, three clients: an Electron editor, a <code>pixel</code> CLI, and a Model Context Protocol server.</p>
  <p>为人类与 AI 提供同一套像素画引擎 · Electron for humans, MCP for agents</p>
  <p>
    <a href="https://www.npmjs.com/package/dotloom-mcp"><img src="https://img.shields.io/npm/v/dotloom-mcp?label=npm&logo=npm&style=flat-square" alt="npm version" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square" alt="Apache-2.0 License" /></a>
    <img src="https://img.shields.io/badge/node-%3E%3D22.13-5fa04e?style=flat-square" alt="Node.js 22.13 or newer" />
    <img src="https://img.shields.io/badge/MCP-ready-8a5cf5?style=flat-square" alt="Model Context Protocol ready" />
  </p>
</div>

<p align="center">
  <a href="README.md">English</a> · <a href="README-ZH.md">中文</a>
</p>

<p align="center">
  <img src="assets/hero.png" width="760" alt="A pixel-art mountain lake at dusk, created with the dotloom-mcp toolchain" />
</p>

<p align="center">
  <strong>Draw in an Electron editor, command from the CLI, or let an AI agent operate the same live document.</strong><br>
  Every mutation crosses one command bus, so tools, history, exports, and undo/redo never disagree.
</p>

It is a game-asset pipeline, not an image generator. A pixel asset is a constrained,
quantised, grid-exact artefact with a technical contract — palette indices, frame tags,
tile properties, collision rectangles — and the commands, the file formats and the
exports are built around that contract rather than around the picture.

## Do the thing in one command

`pixel demo` takes no input file, no palette, and no required arguments. It authors a
sprite through the real command bus, writes the PNG, and writes the editable `.pixel`
source beside it. Nothing to install first — this is the whole command, with the two
optional flags spelled out:

```console
$ npx -y dotloom-mcp pixel demo --out out --size 8
pixel demo -> /…/out/crowned-slime.png
  editable source: /…/out/crowned-slime.pixel
{
  "ok": true,
  "command": "demo",
  "sprite": "Crowned Slime",
  "path": "/…/out/crowned-slime.png",
  "source": "/…/out/crowned-slime.pixel",
  "width": 256,
  "height": 256,
  "canvas": {
    "width": 32,
    "height": 32
  },
  "scale": 8,
  "palette": 10,
  "layers": [
    "Base",
    "Shade",
    "Light",
    "Crown",
    "Face",
    "Outline"
  ],
  "frames": 2,
  "tags": [
    "idle"
  ],
  "commands": 33,
  "bytes": 4675
}
```

A finished 32×32 sprite — ten colours, six layers, two frames on an `idle` tag, drawn
by 33 commands — upscaled 8× with nearest-neighbour sampling, next to a `.pixel` you can
open in the editor. Every document operation prints exactly one JSON object, so this
composes with a shell script like any other.

`path` and `source` come back resolved against the working directory, so `/…/` is
wherever you ran it. The transcript above is the same command run out of this
repository's build.

### The same engine, for an agent

```json
{
  "mcpServers": {
    "dotloom-mcp": {
      "command": "npx",
      "args": ["-y", "dotloom-mcp"]
    }
  }
}
```

That is the whole install. The server speaks MCP over stdio, discovers a running editor
on the loopback interface and edits the same documents the window shows, with the same
undo history; with no editor running it serves the same engine from memory and
reconnects if one appears later.

On Windows that block needs `"command": "cmd"` with `"/c"` prepended to `args` — see
[Connect an MCP client](#connect-an-mcp-client).

`tools/list` returns **36 tools**. The 94 commands behind them — `draw_ellipse`,
`add_palette_ramp`, `outline`, `stroke_tilemap`, `autotile`, the rig, the tilemaps —
are not in that list up front. An agent finds them the way any MCP client would,
through `list_commands`, `describe_command`, `find_workflow` or `apply_ops`, and a
command becomes a directly callable tool the moment the session touches it. The flat
catalogue was 127 entries in the context of every request. The numbers and the
reasoning are in [`docs/REFERENCE.md`](docs/REFERENCE.md#what-it-exposes).

## Drawn by an agent

The pixel art on this page was drawn by an AI agent driving this product over the wire,
through the public tool list only — no imports from `@pixel/core`, no direct editor
access, no privileged calls. That constraint is the claim, and it is a real one here:
the list the agent started from contained no drawing commands at all, so the
discovery path had to work or there would have been no artwork.

One scene, two media. A raster reference on the left; the same composition as native
512×512 pixel art on the right.

<table>
  <tr>
    <td width="50%"><img src="assets/lighthouse-reference.png" alt="Raster reference of a lighthouse at sunset" /><br><sub>Raster reference</sub></td>
    <td width="50%"><img src="assets/lighthouse-pixel.png" alt="The same composition as native pixel art" /><br><sub>Native pixel-art output</sub></td>
  </tr>
</table>

<table>
  <tr>
    <td width="50%"><img src="assets/showcase-autumn.png" alt="Autumn dusk lake pixel art" /></td>
    <td width="50%"><img src="assets/showcase-moonlit.png" alt="Moonlit alpine lake pixel art" /></td>
  </tr>
  <tr>
    <td align="center"><sub>Autumn Dusk Lake</sub></td>
    <td align="center"><sub>Moonlit Alpine Lake</sub></td>
  </tr>
</table>

The scenes, the `.pixel` sources the server wrote and the verification run that replays
them are in [`artwork/`](artwork/README.md).

## Install

`dotloom-mcp` is the canonical public package name. The internal workspace packages remain scoped as `@pixel/*`; those are implementation packages, not additional npm products.

### Download the desktop app

The editor ships as a signed-ready installer for every platform. Grab the latest
from **[GitHub Releases](https://github.com/Lonely-bear/pixel-art/releases/latest)**:

| Platform | File |
| --- | --- |
| Windows | `dotloom-mcp-<version>-x64-setup.exe` — installs to your user profile, no admin needed |
| Windows, no install | `dotloom-mcp-<version>-x64-portable.exe` — run it from anywhere, including a USB stick |
| macOS, Apple Silicon | `dotloom-mcp-<version>-arm64.dmg` |
| macOS, Intel | `dotloom-mcp-<version>-x64.dmg` |
| Linux | `dotloom-mcp-<version>-x86_64.AppImage` — run it, nothing to install; or the `.deb` on Debian/Ubuntu |

The editor needs nothing else: the MCP server is built into the same binary and
publishes itself on `127.0.0.1`, which is how a separately installed `dotloom-mcp`
finds a running editor. The `pixel` CLI is not part of that binary — it comes from
npm, below.

> These builds are **not yet code-signed**. macOS blocks the first launch until
> you right-click the app and choose **Open** (or run
> `xattr -dr com.apple.quarantine /Applications/dotloom-mcp.app`), and Windows
> SmartScreen warns once — **More info → Run anyway**. Certificates can be added
> without changing the app.

### Requirements

For the npm packages: Node.js **22.13 or newer**, plus npm, pnpm, or any MCP
client capable of starting a local stdio server.

The desktop app needs no runtime beyond the operating system.

### Install the CLI and MCP server

```bash
npm install -g dotloom-mcp
```

Verify the installation:

```bash
dotloom-mcp --version
pixel --version
```

`pixel-mcp` and `pixel-art-mcp` remain compatibility aliases for the standalone MCP server; `pixel` is the headless document CLI.

No global install is required for one-off use:

```bash
npx -y -p dotloom-mcp pixel --version
npx -y dotloom-mcp --version
```

### Generate assets from a build script

There is a way in that is neither a client nor a person: a build script. No GUI, no
MCP client, no human in the loop. `buildSprite`, `buildAnimation` and `exportAssets`
turn a spec into finished files, as a `devDependency`.

```js
import { buildSprite, exportAssets } from 'dotloom-mcp';

const slime = buildSprite({
  seed: 20260927, width: 16, height: 16, name: 'slime',
  layers: ['base', 'shade'],
  palette: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'],
  ops: [{ command: 'draw_ellipse', params: { rect: { x: 2, y: 5, w: 12, h: 9 }, color: '#8bac0f' } }],
});

for (const file of exportAssets(slime, { sheet: true, source: true })) {
  console.log(file.path, file.bytes.length, file.mediaType);
}
```

Same seed, same bytes, every run — which is what makes committing generated assets
viable. The API returns bytes and never touches the disk; where they go is the build
script's business. **[`docs/API.md`](docs/API.md) has the full surface, the determinism
contract and the versioning policy**: what is stable, what is internal, and what changes
in a major version. [中文版](docs/API-ZH.md) mirrors it.

The package also exposes the whole engine without going through a task-shaped function:

```js
import { VERSION, core, mcp, script } from 'dotloom-mcp';

const document = core.createSprite({ width: 32, height: 32 });
console.log(VERSION, document.width, typeof mcp.createPixelServer, typeof script.ScriptRuntime);
```

Those three namespaces are the escape hatch rather than the recommended starting point.
They are real, shipped and documented, and they are not covered by `API_VERSION`.

### Connect an MCP client

Most desktop MCP clients use an `mcpServers` object:

```json
{
  "mcpServers": {
    "dotloom-mcp": {
      "command": "npx",
      "args": ["-y", "dotloom-mcp"]
    }
  }
}
```

On Windows, neither `npx` nor `npx.cmd` works. `npx` is not an executable Windows can launch
without a shell (`ENOENT`), and Node has refused to run `npx.cmd` directly (`EINVAL`) since
the CVE-2024-27980 fix — so on every Node version this project supports, the launch has to go
through `cmd.exe`, which is a real executable and therefore works with or without a shell:

```json
{
  "mcpServers": {
    "dotloom-mcp": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "dotloom-mcp"]
    }
  }
}
```

Exact file paths for Claude Desktop, Claude Code, Cursor, Windsurf and OpenCode, the Windows
variant of each, and a three-step check that tells "connected" apart from "connected and
running in memory", are in [`docs/CLIENTS.md`](docs/CLIENTS.md).

<details>
<summary><strong>OpenCode configuration</strong></summary>

Write it into `opencode.json` or `opencode.jsonc` — globally in `~/.config/opencode/`, or per
project in the project root. macOS / Linux:

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

Windows:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "dotloom-mcp": {
      "type": "local",
      "command": ["cmd", "/c", "npx", "-y", "dotloom-mcp"],
      "enabled": true
    }
  }
}
```

**OpenCode is the one client that does not use `mcpServers`.** `mcp` maps a server name
straight to its configuration, so the name is a key *immediately* under `mcp` — there is no
`servers` object in between. `mcp.servers.dotloom-mcp` is read as a server literally named
`servers`, with no `type` and no `command`, and `dotloom-mcp` is never configured at all;
OpenCode's published JSON Schema rejects the object outright. `command` is a single array
that includes the program, not a string plus a separate `args` list, and `type` is required.

`opencode mcp add` is an interactive guide: run it with no arguments and answer the prompts.
OpenCode's CLI documentation gives it no positional arguments and no flags, so there is no
non-interactive equivalent to type here — paste the JSON above instead.

Check the result with `opencode mcp list`.

</details>

## Why dotloom-mcp?

<table>
  <tr>
    <td width="33%" valign="top">
      <h3>Human workspace</h3>
      <p>Pixel-perfect canvas, layers, frames, onion skinning, tilemaps, palettes, and animation playback in Electron.</p>
    </td>
    <td width="33%" valign="top">
      <h3>Agent workspace</h3>
      <p>A standalone MCP server gives agents real PNG previews, structured tools, exact text grids, and safe batch edits.</p>
    </td>
    <td width="33%" valign="top">
      <h3>One source of truth</h3>
      <p>The Electron UI, CLI, scripts, and MCP server use the same serialisable commands and document model.</p>
    </td>
  </tr>
</table>

A practical agent loop is deliberately short:

```text
create_document → block silhouette → inspect PNG → shade in batches
      ↑                                                    ↓
 fix what you can see ← preview each visual gate → finalize_document
```

## CLI in 30 seconds

Document operations print one JSON object, making the CLI easy to compose with shell scripts and CI; help and human-readable command listings use plain text.

```bash
# A finished sprite; --out and --size are optional
pixel demo --out out --size 8

# Create a layered, animated document
pixel new hero.pixel --width 32 --height 32 --layers Ink,Shade --frames 4

# Inspect, draw, and export
pixel info hero.pixel
pixel apply hero.pixel --ops ops.json
pixel export hero.pixel --out hero.png --scale 8

# Engine and game-asset formats
pixel sheet hero.pixel --out hero-sheet.png
pixel gif hero.pixel --out hero.gif --tag idle
pixel tiled hero.pixel --out hero.tmj
pixel thumb hero.pixel --out thumb.png --max 128

# Discover every command and its JSON Schema
pixel commands --json > tools.json
```

Batch operations use the same payload agents send over MCP:

```json
{
  "ops": [
    {
      "command": "draw_rect",
      "params": {
        "layer": "Ink",
        "frame": 0,
        "rect": { "x": 2, "y": 2, "w": 12, "h": 12 },
        "color": "pal:3",
        "fill": true
      }
    },
    {
      "command": "outline",
      "params": {
        "layer": "Ink",
        "color": "#101820",
        "scope": "composite"
      }
    }
  ]
}
```

Run the batch against the document:

```bash
pixel apply hero.pixel --ops ops.json
```

## What the MCP server exposes

The tool catalog is generated from the same Zod schemas used to validate commands, so documentation cannot drift from runtime behaviour. The table below is a selection; `list_commands` returns the whole catalogue, and every tool declares all four risk hints so a client can gate on them.

| Capability | Why it matters |
| --- | --- |
| `read_grid` | Returns the artwork as a character grid — silhouette, luminance, palette slot or colour name. Text, so it is exact, diffable and cheap; a repeated call reports which rows changed. Use it to verify a drawing. |
| `get_selection` | The rectangle the user boxed on the canvas, with its layer and frame. `hint` (default) marks the subject and leaves the agent room to grow it; `enforce` confines every write to the box. |
| `get_preview` | Returns an actual PNG for one frame or all frames, optionally cropped, zoomed, layer-isolated, or onion-skinned. Use it to approve a drawing. |
| `preview_animation` | Renders a timeline or tag-expanded playback contact sheet with sequence-aware onion skin. |
| `preview_pose` | Renders a rig pose/tween and resolves anchor and hitbox world geometry. |
| `create_sprite_spec` | Creates layers, frames, tags, palette roles and an optional rig from one declarative scaffold. |
| `preview_tilemap` | Renders an unbaked map with optional tile grid, numeric indices, invalid-cell and changed-area overlays. |
| `apply_ops` | Batches edits, supports atomic rollback, and can return a preview in the same round trip. |
| `set_frame_durations` / `upsert_tags` | Updates complete animation ranges and multiple tags in one validated command. |
| `expectedVersion` | Rejects stale writes with a version conflict instead of overwriting newer work. |
| `clip` | Keeps shading, highlights, and dither bands inside a silhouette or selected layer. |
| `add_palette_ramp` | Builds hue-shifted material ramps instead of flat interpolation. |
| `prune_palette` | Finds colours unused by all selected raw cels, with dry-run, semantic-role remapping and index mapping. |
| `ensure_palette_role` / `replace_colors` | Maintains material roles and applies one recolour across document/frame/range/list targets. |
| `finalize_document` | Saves the editable source and renders PNG/frame/sheet/GIF/pose/contact outputs plus an optional hashed, incremental manifest. |
| `run_script` | Runs a time-limited JavaScript batch as a single undo step, with isolated dry-run and source-relative error diagnostics. |
| `load_plugin` | Registers plugin commands as live MCP tools. |

`read_grid` verifies, `get_preview` approves. That split is deliberate: a PNG is the
only way to judge whether a piece *looks* good, and a poor tool for the questions an
agent actually iterates on — a 256px downsample of a 32×32 sprite cannot say whether
the silhouette is symmetric or whether row 14 is one step off row 13, and an image
cannot be diffed.

The standalone server runs over stdio and requires no desktop app, but it prefers one.
Started with no arguments it discovers a running Electron app on its loopback endpoint
and forwards to it, so the agent edits the same documents the window shows. If no app
answers at startup it runs self-contained in memory and keeps watching: opening the app
later reconnects automatically, and closing it falls back to memory. `--attach <url>`
pins a specific endpoint and fails loudly instead of falling back, and `--standalone`
skips discovery entirely.

```bash
dotloom-mcp                                        # prefer the app, keep looking
dotloom-mcp --attach http://127.0.0.1:7331/mcp     # pin one endpoint
```

The attached GUI and agent then share documents and undo history: an agent edit repaints the canvas, and a human edit is immediately visible to the agent.

## Creation toolkit

- **Drawing** — pencil, eraser, line, rectangle, ellipse, polygon, bucket fill, colour replacement, clipping, and replace-style redraws.
- **Animation** — frames, bulk durations, batched tags, persistent character rigs/poses/tweens, pose and playback previews, anchors/hitboxes, onion skinning, arbitrary-angle local transforms, GIF, and spritesheets.
- **Tilemaps** — tilesets, editable grids, curved weighted terrain brushes, sparse/weighted 16/47 transitions, alpha-edge local baking, grid/index previews, map-aware diagnostics, per-tile gameplay properties, independent map objects, and self-contained Tiled `.tmj` export.
- **Pixel craft** — hue-shifted ramps, palette locking, safe unused-colour pruning, Bayer and clustered dithering, selective outlines, despeckle, and corner-aware antialiasing.
- **Landscape diagnostics** — horizon, ridge, waterline, value-plane, light-concentration, and guiding-line evidence for full-bleed scenes.
- **Scripting** — a constrained `node:vm` context with commands, pixel buffers, document inspection, sampling, timeouts, and plugins. It limits the scripting API, but is not a security boundary for untrusted code.

<details>
<summary><strong>Scripting API</strong></summary>

```js
const base = layers()[0].id;

draw.rect({
  layer: base,
  frame: 0,
  rect: { x: 0, y: 0, w: 8, h: 8 },
  color: 'pal:3',
  fill: true,
});

putPixels({ x: 8, y: 0, w: 2, h: 1 }, '/wAA/wD/AIA=');
const reflected = sampleComposite(1, 1);

log('done', commands().length);
return { base, reflected };
```

Map scripts can call `strokeTilemap(...)`, `paintTilemap(...)`, and the matching `draw.tilemap` / `draw.bake` aliases; `tilemaps()`, `mapObjects()` and `tileProperties()` read map metadata without copying large tile arrays. A whole script is one undo step. The sandbox has no `require`, `process`, filesystem, network, `eval`, or `new Function`.

</details>

## File support

| Format | Read | Write | Notes |
| --- | :---: | :---: | --- |
| `.pixel` | ✓ | ✓ | Native editable document format |
| PNG | ✓ | ✓ | Single image, all frames, arbitrary integer scale |
| Aseprite `.ase` | ✓ | — | Import into a new editable document |
| Spritesheet + JSON | — | ✓ | Aseprite-compatible `frameTags` |
| Animated GIF | — | ✓ | Tag direction and repeat are honoured |
| Tiled `.tmj` | — | ✓ | Self-contained map + tileset PNG, tile properties and object layer |

A `.pixel` file is a plain zip — a manifest and one PNG per cel, with entry
timestamps pinned — so it can be unzipped and read, and serialising the same document
twice gives the same bytes.

## Architecture

```text
┌─────────────────────┐
│ Electron pixel UI   │──┐
├─────────────────────┤  │
│ pixel CLI + scripts │──┼──▶  command bus  ──▶  PixelDocument
├─────────────────────┤  │        │                layers · frames
│ MCP tools/resources │──┘        │                tags · tilemaps
└─────────────────────┘           ▼
                             undo / redo history
```

| Package | Role |
| --- | --- |
| `dotloom-mcp` | Published npm package: bundled library, CLI, and standalone MCP server. |
| `packages/core` | Platform-free TypeScript document model, command bus, rasteriser, PNG, GIF, and serialisation. |
| `packages/script` | Node-only JavaScript sandbox and plugin runtime. |
| `packages/cli` | JSON-first headless command line. |
| `packages/mcp` | MCP tools, resources, prompts, stdio server, and HTTP bridge. |
| `packages/app` | Electron + React + Vite editor with an embedded MCP host. |

`core` has no DOM, Electron, or Node dependency. The same source runs in Node, a browser, a worker, the Electron renderer, tests, and CI.

## Development

```bash
corepack enable
pnpm install --frozen-lockfile

pnpm build
pnpm typecheck
pnpm test

# Electron editor
pnpm --filter @pixel/app run dev

# Standalone tools from this checkout
node packages/cli/dist/index.js --help
node packages/mcp/dist/cli.js --help
```

Build the public npm bundle without publishing it:

```bash
pnpm build:npm
npm pack --dry-run
```

The repository uses pnpm workspaces, strict TypeScript, Vitest, and a clean-build CI gate. The public package bundles the internal workspace code while keeping normal npm dependencies external.

> **Distribution scope:** the npm tarball publishes the CLI, library entry, and
> standalone MCP server. The Electron editor is distributed separately, as
> GitHub Release installers — it is not part of the tarball, and nothing in the
> tarball needs one.

### Packaging the desktop app

Installers are built with [electron-builder](https://www.electron.build/). The
main process is bundled by esbuild rather than emitted file-by-file, because
pnpm links `@pixel/core` and `@pixel/mcp` as symlinks that a packaged app cannot
follow — so the packaged output has no `node_modules` at all.

```bash
# Everything a release needs, for the platform you are on
pnpm build
pnpm --filter @pixel/app run dist:win     # or dist:mac / dist:linux

# Just the unpacked app, no installer — the fastest way to check a change
pnpm --filter @pixel/app run pack

# Regenerate build/icon.png from assets/pixel-mark.svg's design
pnpm --filter @pixel/app run icon
```

Output lands in `packages/app/release/`. Targets, artifact names, and the icon
live in [`packages/app/electron-builder.yml`](packages/app/electron-builder.yml);
the workflow only decides which runner builds which platform.

### Cutting a release

```bash
# 1. Move the Unreleased changelog notes under a dated heading, then bump:
#    package.json -> version, CHANGELOG.md -> ## [X.Y.Z] - YYYY-MM-DD
# 2. Commit, then tag and push. The tag must match package.json exactly.
#    Substitute the version you just set for <version> in both lines.
git commit -am "chore(release): prepare dotloom-mcp <version>"
git tag v<version>
git push origin main --follow-tags
```

`.github/workflows/release.yml` then builds Windows, macOS, and Linux in
parallel, and publishes everything to one GitHub Release. It refuses to build if
the tag and `package.json` disagree, or if the changelog has no dated section for
the version — both checked by `scripts/prepare-release.mjs`, which also copies the
version into the app package where electron-builder reads it from.

To add code signing later, set repository secrets and push a new tag; no workflow
or config change is needed:

| Secret | Purpose |
| --- | --- |
| `CSC_LINK` | base64 of a P12: Authenticode on Windows, Developer ID on macOS |
| `CSC_KEY_PASSWORD` | password for that P12 |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | macOS notarisation |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` | an alternate way to pass the same P12 |

## Security and local trust

- The standalone MCP server uses stdio and is controlled by the local MCP client.
- The Electron HTTP host binds to `127.0.0.1`; it is intended for trusted local clients. Do not expose or port-forward it.
- MCP tools can read, write, import, and export local file paths. Run the server as an OS user with only the permissions you intend to grant.
- The plugin JavaScript sandbox is intentionally narrow, but MCP tools themselves are not a substitute for operating-system permissions.

## Documentation

- [Client setup](docs/CLIENTS.md) — configuration files and verified JSON for Claude Desktop, Claude Code, Cursor, OpenCode and Windsurf, plus a three-step connection check ([中文](docs/CLIENTS-ZH.md))
- [Library API](docs/API.md) — build-time asset generation, the determinism contract, and the versioning policy ([中文](docs/API-ZH.md))
- [Technical reference](docs/REFERENCE.md) — command catalogue, MCP internals, scripting, animation, tilemaps, and design decisions
- [Changelog](CHANGELOG.md) — release history and scope ([中文](CHANGELOG-ZH.md))
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [OpenCode MCP configuration](https://opencode.ai/v2/docs/mcp-servers/)

## Project status

`dotloom-mcp@0.4.2` is the current release. `0.4.0` was the first to ship desktop
installers; `0.4.1` made the headless server reconnect to an app that starts late
instead of committing to memory for the rest of the session; `0.4.2` added a
one-command demo, a stable build-time library API, byte-reproducible `.pixel`
files, and in-app updates.

- [x] Core document model, rasteriser, command bus, history, and native serialisation
- [x] PNG, spritesheet, GIF, Aseprite import, and Tiled export
- [x] Electron editor, animation, palettes, onion skinning, and tilemaps
- [x] Standalone MCP server, visual resources, prompts, diagnostics, and scripts/plugins
- [x] Stable build-time library API (`buildSprite` / `buildAnimation` / `exportAssets`)
- [x] Public npm package and CI quality gates
- [x] Cross-platform desktop installers on every GitHub Release
- [ ] Code signing and macOS notarisation

## License

Copyright © 2026 Lonely-bear. Released under the [Apache License 2.0](LICENSE).
