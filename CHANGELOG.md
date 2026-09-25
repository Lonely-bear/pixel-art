# Changelog

All notable changes to dotloom-mcp are documented in this file.

## [Unreleased]

## [0.3.0] - 2026-09-26

A 33-tool declared surface with on-demand command registration, and the declaration
layer that makes the tool list worth reading.

The advertised tool list was 127 entries and 70.7K tokens of schema in the context of
every request. It is now 33 entries and ~21K, with the ~90 core commands reached on
demand. Validation and declaration are separated on purpose: the zod schemas stay
strict and complete, and a single pass produces the advertised form at `tools/list`
time, so the tool list can be lean without the contract becoming loose.

### Added

- **On-demand command tools.** A core command registers as a real MCP tool when the
  session touches one: an exact `list_commands` lookup, a `describe_command`, a
  `find_workflow` hit, or an `apply_ops` / `run_script` that issued it. Responses name
  what was promoted in `promotedTools`, `tools/list_changed` announces the new list, and
  `list_commands` marks each catalogue entry `tool: true` once it is directly callable.
  A substring browse does not promote. `createPixelServer({commands: 'eager'})`
  restores the previous flat catalogue.
- **Command manuals, read on demand.** A `guide` field on a command, served as
  `pixel://guide/{command}` and returned by `describe_command`. `stroke_tilemap`,
  `autotile`, `dither_fill`, `set_tile`, `mirror`, `add_palette_ramp` and `outline` keep
  their long-form conventions without carrying them in every request.
- **`outputSchema` on every tool**, over a shared result envelope. Failures are now a
  contract: `{ok: false, error, code, remediation?}`, where `code` is a stable
  machine-readable string and `remediation` names the change that fixes the call.
- **Derived risk annotations.** All four MCP hints are computed from the tool's name
  rather than hand-written per tool, so a new tool is annotated by construction.
  `run_script` and `load_plugin` are the two marked `openWorldHint` because they
  execute code the server did not write, and a command contributed by a plugin is
  marked open-world *and* destructive in its declaration.
- **`describe_command` describes the entry-point tools too**, which is the only route to
  the full parameter list of `apply_ops`, `finalize_document` or `run_script`.
- **`find_workflow` gained a "draw one good sprite" workflow** and a tilemap-terrain
  workflow. The most common task on the server previously matched a rig-and-timing
  workflow that promoted four commands none of which can draw.
- `scripts/mcp-call.mjs`, a stdio JSON-RPC driver for the local build, so the advertised
  surface can be exercised without an MCP client. That is how this release was verified.

### Changed

- The declared tool list is 33 tools rather than 127, a 70% reduction in `tools/list`.
  Nothing is unavailable: `apply_ops` and `run_script` run any command from the
  catalogue with or without promotion.
- `document` and `expectedVersion` are accepted by every tool but advertised by none.
  They are optional everywhere, so restating them 127 times cost 9.4K tokens to say
  "operate on the active document"; the server instructions now say it once. Both
  remain fully functional, including the `version_conflict` guard.
- Advertised schemas no longer carry the safe-integer bounds zod emits for every
  integer — 521 occurrences and 28.7KB of `"minimum":-9007199254740991`. Hand-written
  bounds such as `max(4096)` are untouched, and `tools/call` still validates against
  the full strict schema.
- Command descriptions are contracts: what it does, when to use it, whether it is
  reversible, and where its manual lives. Generated `title`s are proper noun phrases
  rather than `name.replace(/_/g, ' ')`.
- `apply_ops` failures carry a `remediation` for the three likeliest mistakes — a
  misspelled command, a near-miss parameter name, and an invented layer or frame name.
  An unknown name from `describe_command` points at whichever namespace it actually
  resembles, rather than always at the command catalogue.
- The craft guide warns that below roughly 64px a dithered band is wider than the
  transition it is meant to soften, and that `intentionalDetailRects` does not exempt a
  region from the light-source probe.
- Command and session-tool descriptions in `list_commands` follow the same contract
  shape as the tool list, and its hint now shows both accepted op shapes.

### Fixed

- `quality_report` no longer recommends `antialias` for a high mean adjacent-luminance
  delta. Hard edges are the medium and a high value is not on its own a defect; the old
  wording contradicted the craft guide and would have softened correct art off a locked
  palette.
- A name that near-misses a real one gets `didYouMean` plus a remediation naming the
  right namespace, instead of advice that could not possibly work — the previous text
  told a caller to search the command catalogue for a tool that was never in it.
- `add_palette_ramp` and `outline` document their two traps that cost real pixels: hue
  interpolating along the wheel, and `scope: "composite"` excluding the layer being
  drawn into.

## [0.2.0] - 2026-09-26

Character rigging, asset-aware quality reporting, and task-level tool discovery.

### Added

- Persistent character rigs: layer-bound parts with stable pivots and parent hierarchy, named poses, stored tweens, anchors and hitboxes, plus `preview_pose` for non-destructive checks and `bake_pose` / `tween_pose` for explicit-frame output.
- `transform_part` and `transform_cel` for fixed-canvas arbitrary-angle rotation, translation and scale with nearest-neighbour sampling and no new colours.
- `.pixel` format v2 round-trips rig metadata. Version-1 files remain readable, and rig-free documents continue to serialize as v1.
- `quality_report` gained `assetType`, `intentionalDetailRects` and a cross-frame stability pass. `assetType: "character"` is the only value that changes the analysis; others are labels reported as such, and `auto` infers from a rig or multiple frames.
- `set_frame_durations` and `upsert_tags` for batched frame timing and tag management, and `prune_palette` with dry-run by default.
- `preview_animation` contact sheets in raw timeline or tag-expanded playback order with sequence-aware onion skin.
- `finalize_document` now accepts typed PNG/frame/sheet/GIF/pose/contact output plans and can write a hashed bundle manifest that drives incremental writes. The legacy PNG `exports` field is still accepted.
- Semantic palette roles via `ensure_palette_role` and `add_palette_ramp role`, `replace_colors` for document/frame/range/list recolouring, and role-safe pruning with index remapping.
- `describe_command` and `find_workflow` for task-level discovery, and `create_sprite_spec` for one-call declarative scaffolds.
- `run_script.dryRun` executes against an isolated document snapshot and returns structured source-relative error diagnostics.
- Inline `apply_ops` / `run_script` previews accept `frames: "all"` and onion-skin options.
- `list_commands` supports exact `name`, parameter-name `param`, result `limit`, and command `readOnly` metadata.

### Fixed

- Rig metadata stays consistent with structural edits. Deleting or merging a bound layer detaches it from its part, removing the rest frame re-points the rig, and `crop_canvas` / `resize_canvas` / `scale_sprite` / unscoped `flip` and `rotate` remap pivots, anchors and hitboxes along with the pixels. Previously a crop left pivots outside the canvas and every pose rendered from the wrong joint, silently.
- Pose baking and `transform_part` refuse to write the rig rest frame, and baking separates destination layers the rig does not own (`preservedLayers`) from part layers the pose empties (`clearedPartLayers`). Baking onto the rest frame used to corrupt the rig's own render source.
- Part bounds are the union of a part's layers rather than its last layer, and `clippedParts` only reports artwork that actually left the canvas. A multi-layer part no longer reports fake clipping on an identity pose.
- Ramp anchors are parsed literally rather than snapped by `paletteLocked`, so a locked palette can no longer rebuild a ramp out of unrelated swatches and tag those swatches with a new role.
- `apply_ops.atomic` restores the exact pre-batch sprite, version and undo/redo state instead of undoing a count that included read-only commands.
- Explicitly requesting a missing animation tag now fails instead of silently exporting the full timeline.
- Scoped odd quarter-turn rotations are rejected before they can leave cels and sprite dimensions inconsistent.
- Affine rasterisation range-checks the unrounded inverse coordinate, so a sample beyond the nearest-neighbour reach can no longer be rounded into the first column.

### Changed

- `quality_report` character mode judges a silhouette jump by overlap rather than by how much of the whole canvas changed, which is scale-invariant for small figures.
- `intentionalDetailRects` no longer suppresses the light-source probe; it applies only to isolated, outlier, edge and clipped-highlight checks.
- Transform commands report `rigRemapped: true` only when rig geometry actually moved.

## [0.1.3] - 2026-09-25

### Added

- Added a complete Chinese README at `README-ZH.md`, with language navigation from the English README.
- Included the Chinese README in the published npm package.

### Changed

- Unified the public product identity around the `dotloom-mcp` npm package across documentation, application labels, MCP metadata, and CLI help.
- Refreshed release documentation and CI package-version checks for `0.1.3`.

## [0.1.2] - 2026-09-25

### Added

- Curved `stroke_tilemap` terrain brushes with weighted variants, deterministic density/jitter and repeat avoidance.
- Sparse/weighted 16/47 transition mappings, alpha-over edge masks and changed-cell-only local baking.
- `preview_tilemap` grid/index/changed-area PNG debugging and tilemap-aware `quality_report` structure analysis.
- Per-tile gameplay properties, independent map objects, and Tiled object/property export support.
- High-level `draw.*`, `strokeTilemap`, `paintTilemap` and `tilemaps` script helpers.

### Changed

- Tilemap mutation summaries now report exact skipped coordinates, unchanged writes and changed bounds.
- Tiled export now writes its referenced tileset PNG by default and validates the map before writing.
- Read-only generated commands no longer mark a saved document dirty.

## [0.1.1] - 2026-09-25

### Fixed

- Added the `dotloom-mcp` executable alias so `npx -y dotloom-mcp` starts the MCP server directly.
- Added a valid `dotloom-mcp` library entry exposing version metadata plus the core, MCP, and script APIs.

## [0.1.0] - 2026-09-25

### Added

- Installable `dotloom-mcp` npm package with `pixel`, `pixel-mcp`, and `pixel-art-mcp` commands.
- Standalone Model Context Protocol server over stdio, plus a bridge to the Electron app's loopback HTTP host.
- JSON-first CLI for document creation, drawing, animation, tilemaps, scripting, quality inspection, and export.
- Electron + React editor sharing one document store, command bus, and undo history with connected agents.
- PNG, Aseprite import, spritesheet, GIF, Tiled, and native `.pixel` support.
- Visual quality reports, palette ramps, clipping, clustered dithering, landscape composition diagnostics, sandboxed scripts, and plugins.
- Clean-build CI and an npm tarball consumer smoke test.

### Release scope

- CLI and standalone MCP server are published to npm.
- Electron desktop installers are not part of `0.1.0`; the source application remains in the repository.
