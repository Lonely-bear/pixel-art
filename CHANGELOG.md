# Changelog

All notable changes to dotloom-mcp are documented in this file.

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
