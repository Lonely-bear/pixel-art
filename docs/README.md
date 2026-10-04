# Documentation

What a product user or an integrator reads. Developer-facing material is in
[`../AGENTS.md`](../AGENTS.md) and [`../dev/`](../dev/).

## Start here

| If you are… | Read |
| --- | --- |
| integrating a game engine and want the functions you may depend on | [`STABILITY.md`](STABILITY.md), then [`API.md`](API.md) |
| writing a build script against the npm package | [`API.md`](API.md), then [`COOKBOOK.md`](COOKBOOK.md) |
| emitting or consuming exported assets | [`ASSET-CONTRACT.md`](ASSET-CONTRACT.md) |
| getting artwork into the pipeline from another tool | [`IMPORTERS.md`](IMPORTERS.md) |
| setting up an MCP client | [`CLIENTS.md`](CLIENTS.md) |
| sharing a bundle or a review | [`ACTION.md`](ACTION.md), [`SHARING.md`](SHARING.md) |
| looking up a command, a script or the tilemap model | [`REFERENCE.md`](REFERENCE.md) |
| curious how the quality pipeline decides | [`EVALUATION.md`](EVALUATION.md) |

## Every file

| File | Lines | For |
| --- | --- | --- |
| [`API.md`](API.md) | 572 | Integrator. The nine stable library exports, with runnable examples. |
| [`ASSET-CONTRACT.md`](ASSET-CONTRACT.md) | 592 | Integrator. `meta.json`, the generator, the validator, and what an asset bundle promises. Machine-read by a test. |
| [`STABILITY.md`](STABILITY.md) | 344 | Integrator. What 1.0 promises and what it explicitly does not. Machine-read by a test. No Chinese mirror (D-3 gap). |
| [`COOKBOOK.md`](COOKBOOK.md) | 364 | Integrator. Five runnable examples. Machine-read by a test, so a snippet cannot rot. |
| [`IMPORTERS.md`](IMPORTERS.md) | 282 | Integrator. Godot, Unity, Phaser and Excalidraw import paths. |
| [`CLIENTS.md`](CLIENTS.md) | 563 | User. Claude Desktop / Claude Code / Cursor / OpenCode / Windsurf configuration, verified JSON, and a three-step connection check. |
| [`ACTION.md`](ACTION.md) | 176 | User. What to do when a document is refused: what was found, and what to do about it. |
| [`SHARING.md`](SHARING.md) | 276 | User. Share bundles, provenance, and why a badge is metadata and never burned in. |
| [`REFERENCE.md`](REFERENCE.md) | 787 | Anyone looking something up. Command catalogue, MCP internals, scripting, animation, tilemaps. |
| [`EVALUATION.md`](EVALUATION.md) | 3805 | Reader of a quality report. The scoring specification. **Machine-read by `packages/core/test/quality-weights.test.ts`**, which resolves it by path and fails the build if it cannot — so it cannot move while that path stands. |

## `*-ZH.md` mirrors

`API-ZH.md`, `ASSET-CONTRACT-ZH.md`, `CLIENTS-ZH.md`, `COOKBOOK-ZH.md`, `ACTION-ZH.md` and
`EVALUATION-ZH.md` mirror their English original. D-3 asks for a mirror per English document;
`EVALUATION-ZH.md` is a partial one (§4.4 and §7 only) and `STABILITY.md` has none. Both gaps
are recorded in `dev/DECISIONS.md` D-3 rather than hidden.

## What is not here

- [`../AGENTS.md`](../AGENTS.md) — the contributor and agent guide: layout, traps, the
  build-serialisation rule, and how to accept work.
- [`../dev/DECISIONS.md`](../dev/DECISIONS.md) — the locked product decisions.
- `ROADMAP.md` and `TASKS.md` were deleted. A roadmap is a working document, and
  `TASKS.md` said so on its own first line. Nothing durable was lost: see
  `AGENTS.md` "Proving a measurement works" for the five measurements that shipped unable to
  fail, and `dev/DECISIONS.md` for what `ROADMAP.md` still held.
