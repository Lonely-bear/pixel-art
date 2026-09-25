# Changelog

All notable changes to dotloom-mcp are documented in this file.

## [Unreleased]

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
