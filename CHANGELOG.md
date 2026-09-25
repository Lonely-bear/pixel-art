# Changelog

All notable changes to Pixel Art MCP are documented in this file.

## [0.1.0] - 2026-09-25

### Added

- Installable `@taiwucun_tk/pixel-art-mcp` npm package with `pixel`, `pixel-mcp`, and `pixel-art-mcp` commands.
- Standalone Model Context Protocol server over stdio, plus a bridge to the Electron app's loopback HTTP host.
- JSON-first CLI for document creation, drawing, animation, tilemaps, scripting, quality inspection, and export.
- Electron + React editor sharing one document store, command bus, and undo history with connected agents.
- PNG, Aseprite import, spritesheet, GIF, Tiled, and native `.pixel` support.
- Visual quality reports, palette ramps, clipping, clustered dithering, landscape composition diagnostics, sandboxed scripts, and plugins.
- Clean-build CI and an npm tarball consumer smoke test.

### Release scope

- CLI and standalone MCP server are published to npm.
- Electron desktop installers are not part of `0.1.0`; the source application remains in the repository.
