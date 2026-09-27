# AGENTS.md

`dotloom-mcp` — a pixel-art engine shipped three ways: an Electron editor, a `pixel` CLI, and a
`dotloom-mcp` MCP server. One engine, one document model, three clients.

## Layout

| Path | Role |
| --- | --- |
| `packages/core` | Document model, command bus, rasteriser, PNG/GIF, serialisation. **No DOM, no Electron, no Node APIs** — the same source runs in the renderer, tests and CI. |
| `packages/script` | `node:vm` sandbox + plugin loader. Node only. |
| `packages/cli` | JSON-first headless CLI (`pixel`). |
| `packages/mcp` | MCP tools/resources/prompts + stdio server. |
| `packages/app` | Electron + React + Vite editor; embeds the MCP server. |
| `scripts/` | `build-npm-package.mjs`, `prepare-release.mjs`, `mcp-call.mjs` (drive the real MCP server over stdio). |

`README.md` (and `README-ZH.md`) cover install/use; `docs/REFERENCE.md` is the deep technical
reference (command catalogue, MCP internals, scripting, tilemaps). Read them before changing
behaviour they describe — they are accurate and load-bearing.

## Commands

```bash
corepack enable && pnpm install --frozen-lockfile   # pnpm 11.6.0, Node >= 22.13
pnpm build:libs     # core -> script -> cli -> mcp, in that order
pnpm build          # build:libs, then the app
pnpm typecheck
pnpm test
pnpm build:npm      # esbuild bundle of the published tarball -> ./dist
```

- **The build-order trap.** `pnpm typecheck` and `pnpm test` both run `build:libs` first, because
  `packages/script` and `packages/mcp` tests import `@pixel/core`, which resolves to
  `packages/core/dist` — *not* to source. Running `pnpm --filter @pixel/mcp test` directly skips
  that step and tests the last build. Same for `node packages/cli/dist/index.js` and
  `scripts/mcp-call.mjs`.
- **Single package / single file** (run from the repo root):
  `pnpm --filter @pixel/core exec vitest run test/rig.test.ts`, add `-t "name"` to filter by test.
  There is no vitest config file — each package runs on defaults, from its own directory.
- **There is no linter and no formatter.** No ESLint, Prettier, Biome, or pre-commit hooks. The only
  automated gates are `tsc` strict and Vitest. Match surrounding style by hand.
- **CI order is `typecheck → test → build → build:npm → pack → install the tarball in a clean
  consumer**, and that last step really does exercise the four bin aliases and speaks MCP to the
  installed server. A change that only works in-repo will fail there.
- `pnpm --filter @pixel/app run pack` (unpacked, no installer) is the fast way to check a packaging
  change; `dist:win` / `dist:mac` / `dist:linux` are the real targets. Output in
  `packages/app/release/`.
- `pnpm --filter @pixel/app run dev` needs port **5273** free and refuses to start otherwise. A
  leftover electron/vite on Windows is the usual cause. `PIXEL_DISABLE_GPU=1` if the renderer
  crashes natively.

## The one architectural rule

**Every mutation anywhere goes through `applyCommand` on the shared command bus**
(`packages/core/src/bus.ts`). The Electron UI, the CLI, the MCP server and scripts all issue the
same serialisable commands, which is what makes undo/redo, replay and the tool surface agree.

The renderer is no exception: it may import `@pixel/core` for *local, uncommitted* work
(`paint.ts` rasterises strokes with `core`'s own rasteriser), but every committed edit goes over
IPC through `window.pixel.execute` / `applyOps`. Keep it that way — bypassing the bus means a
second undo history.

## Adding a command

1. Write it in `packages/core/src/commands/*.ts` with `defineCommand` (zod `params` + `apply`).
2. Add it to `allCommands` in `packages/core/src/commands/index.ts`. That array is the single
   source of truth for the UI, the CLI and the MCP tool catalogue — there is no second list to
   update, and the zod schema becomes the tool's JSON Schema.
3. Give it a `guide` if it has conventions worth explaining, and point at it from `description`
   (served as `pixel://guide/{command}`).

Things that will bite:

- `defineCommand` and `addTool` both apply `.strict()`. A mistyped parameter is a hard error, not a
  silent default. This is deliberate — do not soften it.
- **`.describe()` on zod fields is the product, not decoration.** It is the text an AI agent reads
  to decide how to call the tool. `packages/mcp/test/tool-surface.test.ts` fails if any advertised
  parameter lacks a description (`x`/`y`/`w`/`h` are the only exempt names).
- `description` must stay short — under 700 chars for a command, and the tool-surface test
  enforces 80..500 per session tool unless the name is in `DESCRIPTION_BUDGET`. Long-form
  knowledge goes in `guide`, which the agent pulls on demand.
- `readOnly: true` keeps a command out of undo history and off the version counter. A command that
  only inspects must set it.
- **Pixel data is copy-on-write.** A command must never mutate a `PixelBuffer` in place — get one
  via `draft.cel()` / `tilesetImage()` / `tilemapData()`, which clone on first touch. Mutating
  arrays, layer objects, tags and palette entries in place *is* fine; the structural snapshot owns
  its own copies. Getting this wrong corrupts undo silently.
- `Draft` is the only mutation surface. `applyCommandToDraft` exists so plugin commands expand
  into built-ins inside the caller's draft, which is how one undo step covers the whole expansion.
- Every error should be a `CommandError` with a `code` (`unknown_command`, `invalid_params`,
  `command_failed`, `version_conflict`) — agents branch on the code, not the prose.

## The MCP tool surface is budgeted

The advertised tool list is deliberately 36 entry-point tools; the 94 core commands are **not**
in it until a session touches one. `commands: 'lazy'` promotes a command to a first-class tool when
it is looked up (`list_commands`/`describe_command`/`find_workflow`) or actually run
(`apply_ops`/`run_script`), and announces the new list.

> **These counts drift.** Measure them (`node scripts/mcp-call.mjs list` for tools,
> `list_commands` for commands) rather than trusting any number written in prose — including the
> ones here. They have been wrong in `AGENTS.md`, `artwork/README.md`, `CHANGELOG.md` and
> `docs/REFERENCE.md` simultaneously.

- A new **core command costs nothing** in the tool list. A new **session tool** (`addTool` in
  `packages/mcp/src/tools.ts`) eats a fixed budget: `tool-surface.test.ts` asserts
  `tools.length <= 40` and total advertised bytes `<= 100_000`. Raise the number in the same commit
  and say why in the test name.
- Every tool must declare an `outputSchema` (defaults to `TOOL_RESULT_ENVELOPE`) and all four risk
  hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), derived from the
  name when not given explicitly.
- `document` and `expectedVersion` are accepted on every tool and stripped from the advertised
  schema by `packages/mcp/src/surface.ts`. Do not re-advertise them. `tools/call` still validates
  against the untouched zod schema — the diet only applies to `tools/list`.
- Result envelopes are built only by `ok()`/`fail()` in `tools.ts`. Failures return
  `{ok: false, error, code, remediation?}`; `error` strings are held under ~320 chars by a test.
- **A running MCP server caches `dist/` at startup.** Rebuilding does not change a live session —
  that is what `SKILL_FINGERPRINT` (published by `list_commands`) exists to detect. Restart the
  server after a build, or you are testing last week's code.

## Do not show an agent a number to optimise

A `quality_report` tool existed once and was **deleted in 0.3.1** (see `CHANGELOG.md`). The reason
is the single most important design lesson in this repository:

> A model, told the number was "clean", sanded a lake into a dark flat rectangle.

Any score handed to an agent becomes the target instead of the artwork. That is Goodhart's law
arriving on schedule, and it is why this project ships *procedural craft guidance*
(`docs/EVALUATION.md`, `pixel://skill`) and a read-only perception channel (`read_grid`,
`get_preview`) rather than a verdict.

The replacement quality pipeline (`packages/core/src/quality/`) is being built with that in mind:

- An **absent dimension is reported as unmeasured**, never as a number. A dimension with no
  analyzer reports `not-implemented`, which is a claim about the build, not the artwork.
- The benchmark corpus (`benchmarks/`) carries **negative controls** — clean work that must produce
  no issues — because an analyzer that fires on clean art is worse than one that misses a defect.
- The corpus **withholds the machine's scores from the human-rated section**, because a rater who
  has seen the number is anchored to it.
- `finalize_document` is where a quality gate belongs (refusing), not in a tool that advises.

If you add a score an agent can see and move toward, you are re-introducing the thing that was
removed. Say so in your report rather than shipping it quietly.

## Electron app specifics

- Two tsconfigs, both run by `typecheck`: `tsconfig.json` (`electron/` + `shared/`, Node types)
  and `tsconfig.renderer.json` (`src/` + `shared/`, DOM, `jsx: react-jsx`, bundler resolution,
  `verbatimModuleSyntax`). Shared code must satisfy both.
- Main process is ESM bundled by esbuild; the preload is CommonJS (`preload.cts` → `preload.cjs`,
  window has `sandbox: true`). Never import Electron into the renderer — go through
  `window.pixel` typed by `PixelApi` in `packages/app/shared/types.ts`.
- Adding an IPC capability means touching `CHANNELS` **and** `PixelApi` in
  `packages/app/shared/types.ts`, plus the main handler and the preload bridge. They cannot drift
  because they are declared in one file.
- The main process is the only writer; the renderer only reads. File dialogs, save, and
  `update:install` are guarded main-side.
- `packages/app/scripts/build-main.mjs` prepends a `createRequire` banner. It exists because
  `electron-updater` → `graceful-fs` calls `require()` and the app refuses to start without it.
  Do not remove it or switch the preload to ESM.
- **i18n: five locales** (`en`, `ja`, `ko`, `zh-CN`, `zh-TW`) in `packages/app/src/i18n.tsx`. `en`
  is the source of truth and `TranslationKey` is derived from it, so a missing translation is a
  *compile* error, not a blank label. Messages are `{placeholder}` templates, never concatenation.
  Never put a user-facing literal in a component.

## Testing

- Vitest, no shared config. Tests live in `packages/{core,mcp,script}/test/*.test.ts`; the app's
  one test sits next to its source in `packages/app/electron/`. `cli` has no tests and uses
  `--passWithNoTests`.
- `packages/core` tests import `../src/index.js`; `script` and `mcp` tests import `@pixel/core`
  (built `dist`). That asymmetry is why `build:libs` is a prerequisite.
- **Tests are not typechecked.** Every package tsconfig has `include: ["src"]`, so a type error in
  a test only surfaces when vitest runs it. `packages/app/electron/update-support.test.ts` *is*
  covered, because the app's tsconfig includes `electron`.
- `packages/mcp/test/server.test.ts` is the integration suite and runs the real server over
  `InMemoryTransport`; `tool-surface.test.ts` is the regression guard for the tool-list decisions.
  Read a test's intent comment before changing what it asserts — several encode a decision that
  looks arbitrary until you know the story.
- For end-to-end checks of the real thing, `node scripts/mcp-call.mjs <list|call|resources|prompts|
  templates|read|raw|calls>` spawns `packages/mcp/dist/cli.js` and speaks JSON-RPC to it. It
  deliberately imports nothing from `@pixel/core`, so it tests the advertised surface only.

## Release

1. Move the `## [Unreleased]` notes in `CHANGELOG.md` under a dated `## [X.Y.Z] - YYYY-MM-DD`.
2. Bump `package.json` `version`. `packages/app/package.json` is synced by
   `scripts/prepare-release.mjs`, not by hand.
3. `git commit -am "chore(release): prepare dotloom-mcp X.Y.Z"`, then `git tag vX.Y.Z` and push
   with `--follow-tags`.

`scripts/prepare-release.mjs` refuses a tag that disagrees with the manifest or a changelog without
a dated section. Commits use Conventional Commits with a scope: `feat(mcp): …`, `fix(app): …`.
Release prose lives in `CHANGELOG.md`, not in a heredoc and not in
`.github/release-notes.md` — that file is only the install table and the first-launch note, and
`scripts/release-notes.mjs` joins it to the changelog section for the tag (English plus the
`CHANGELOG-ZH.md` mirror) to produce the body the release workflow publishes. Signing is opt-in via
`CSC_LINK` / `APPLE_*` secrets; with none set the build still succeeds, unsigned.

## Traps

- Do not "clean up" `pnpm-workspace.yaml`. The `app-builder-lib>@electron/get: 3.1.0` override
  (electron-builder 26.x calls an enum 3.0.0 does not export) and the `allowBuilds` /
  `minimumReleaseAgeExclude` entries each have a comment explaining exactly what breaks.
- `dist/` in each package and at the root is build output and gitignored. Never hand-edit it, and
  never treat a stale `dist` as a bug in the source.
- Colour arguments accept palette shorthand (`3`, `"pal:3"`, `"palette 3"`, `"pal#3"`) resolved
  against the document palette, as well as hex/RGB. Out-of-range indices fail loudly on purpose.
- Origin is top-left, x right, **y grows downward**, everything zero-based. Rectangles are
  `{x, y, w, h}` with `w`/`h` as counts.
- The Electron HTTP MCP host binds `127.0.0.1:7331` (`PIXEL_MCP_PORT`). Loopback only — never
  expose or port-forward it.
