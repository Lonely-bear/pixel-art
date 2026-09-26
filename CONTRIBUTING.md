# Contributing to dotloom-mcp

Thanks for being here. This guide is short on ceremony and long on the things that are
not obvious from reading the code — because the code cannot tell you *why* it is shaped
this way, and most of the review comments in this repository are about the why.

If you are new to the project, read [`AGENTS.md`](AGENTS.md) as well. It is the working
notes an agent or a contributor keeps in their head, and this document assumes you have.

**Three things to know before you start.**

1. One engine, three clients. The Electron editor, the `pixel` CLI and the MCP server are
   clients of the same headless document model. A change that only improves one of them is
   usually the wrong change.
2. The user is often an AI agent, not a person. Parameter descriptions, error codes and
   tool names are product surface, not documentation. See [The conventions](#the-conventions-that-are-not-obvious-from-the-code).
3. There is no linter and no formatter. The only automated gates are `tsc` strict and
   Vitest, which means **matching the surrounding style by hand is part of the review**.

There are three genuinely different ways to contribute, and all three are welcome:

| You want to | Start at |
| --- | --- |
| Fix a bug or add a command | [Setup](#setup) → [Conventions](#the-conventions-that-are-not-obvious-from-the-code) |
| Tell us the agent did the wrong thing | [`.github/ISSUE_TEMPLATE/agent-usability.yml`](.github/ISSUE_TEMPLATE/agent-usability.yml) |
| Show off pixel art you made with it | [`.github/ISSUE_TEMPLATE/asset_showcase.md`](.github/ISSUE_TEMPLATE/asset_showcase.md) |

The second one is not a consolation prize. This project is operated through an MCP client
more often than through the window, and the highest-signal bug reports we get are "the
agent called the right tool with the right arguments and still got the wrong result".

---

## Setup

Requirements, and they are exact — CI pins both:

- **Node.js ≥ 22.13.0** (`engines` in `package.json`; CI runs 22.13.0)
- **pnpm 11.6.0** (`packageManager`; use corepack so you get this version, not your global one)

```bash
corepack enable
pnpm install --frozen-lockfile
```

The `--frozen-lockfile` is not optional for a contribution. If it fails, your pnpm is
reading a different lockfile format than the one committed; run `corepack enable` first
and try again before you do anything else.

Everything is a pnpm workspace. The internal packages are `@pixel/*` and are not
separately published — they are bundled into the `dotloom-mcp` tarball.

| Package | What lives there | What you must remember about it |
| --- | --- | --- |
| `packages/core` | Document model, command bus, rasteriser, PNG/GIF, serialisation | **No DOM, no Electron, no Node APIs.** The same source has to run in a test runner and in a browser, so `import 'node:fs'` here is a bug even if it works locally. |
| `packages/script` | `node:vm` sandbox and plugin loader | Node only. The sandbox limits the API; it is **not** a security boundary for untrusted code. |
| `packages/cli` | The `pixel` headless CLI | Has no tests and runs with `--passWithNoTests`. Be careful: a green CLI suite proves nothing ran. |
| `packages/mcp` | MCP tools, resources, prompts, stdio server | The tool list is budgeted. See [The budgeted tool surface](#the-mcp-tool-surface-is-budgeted). |
| `packages/app` | Electron + React + Vite editor | Two tsconfigs, five locales, and one hard rule about who may write. See [Electron specifics](#electron-specifics). |

### The commands

```bash
pnpm build:libs     # core -> script -> cli -> mcp, in that order
pnpm build          # build:libs, then the app
pnpm typecheck      # tsc --noEmit in every package
pnpm test           # vitest in every package
pnpm build:npm      # esbuild bundle of the published tarball -> ./dist
```

`pnpm typecheck` and `pnpm test` both run `build:libs` *first*. That is not tidiness, and
the next section explains why it matters.

CI runs, in this order: `typecheck → test → build → build:npm → pack → install the tarball
in a clean consumer`. The last step is the one that catches "it worked in my repo": it
installs the packed tarball into a fresh directory, exercises all four bin aliases
(`dotloom-mcp`, `pixel`, `pixel-mcp`, `pixel-art-mcp`), runs a document round trip, and
speaks real MCP to the installed server. If your change only works because of a
workspace symlink, that is where it dies.

### The build-order trap

> **The single most likely way to lose an hour in this repository.**

`packages/script` and `packages/mcp` tests import `@pixel/core`, which resolves to
`packages/core/dist` — **not** to `packages/core/src`. So:

```bash
pnpm --filter @pixel/mcp test        # tests your last build of core, not your working tree
```

If you just edited core, that command tests the *old* code and reports green. The same
trap applies to:

- `node packages/cli/dist/index.js …`
- `node packages/mcp/dist/cli.js …`
- `node scripts/mcp-call.mjs …`
- a running MCP server in your client, which caches `dist/` at startup

`SKILL_FINGERPRINT`, published by `list_commands`, exists precisely to detect this: it goes
stale the moment you rebuild, which tells you the server you are talking to is not the code
you just wrote. **After any build, restart the MCP server** — otherwise you are debugging
last week's code with this week's expectations.

### Running one test file

There is no shared Vitest config; each package runs on defaults from its own directory. To
run a single file, run it from the repo root with `--filter`:

```bash
# one file
pnpm --filter @pixel/core exec vitest run test/rig.test.ts

# one test by name
pnpm --filter @pixel/core exec vitest run test/rig.test.ts -t "remaps anchors on resize"

# one package's whole suite (still no build:libs - see the trap above)
pnpm --filter @pixel/mcp test
```

If you changed `core` and are iterating on `core` tests, the asymmetry matters: `core`
tests import `../src/index.js` (source, always current), while `script` and `mcp` tests
import the built package. A `core` test failure right after an edit is real; an `mcp`
test pass right after an edit is not evidence of anything.

### Driving the real MCP server by hand

`scripts/mcp-call.mjs` starts `packages/mcp/dist/cli.js` as a child process and speaks
JSON-RPC to it over stdio. It imports nothing from `@pixel/core`, so it tests the
**advertised surface only** — exactly what a real client sees.

```bash
node scripts/mcp-call.mjs list                          # the advertised tool list
node scripts/mcp-call.mjs call get_preview '{"documentId": "..."}'
node scripts/mcp-call.mjs resources
node scripts/mcp-call.mjs templates
node scripts/mcp-call.mjs read 'pixel://guide/autotile'
node scripts/mcp-call.mjs prompts
node scripts/mcp-call.mjs raw tools/list '{}'
node scripts/mcp-call.mjs calls calls.json               # replay a multi-tool session
```

`calls <file.json>` replays `[{label, tool, arguments}]` against a *single* session, which
is the mode you need for anything that spans several tools — creating a document and then
drawing on it — because every other mode is one call in one process and the document dies
with it. Build the server first (`pnpm build:libs`).

### Working on the desktop app

```bash
pnpm --filter @pixel/app run dev      # Vite + Electron with HMR, needs port 5273 free
```

It refuses to start if 5273 is busy; a leftover electron/vite process on Windows is
usually the cause. If the renderer crashes natively, `PIXEL_DISABLE_GPU=1`.

To check a packaging change without producing an installer:

```bash
pnpm --filter @pixel/app run pack     # unpacked app in packages/app/release/
```

`dist:win` / `dist:mac` / `dist:linux` are the real targets.

---

## The conventions that are not obvious from the code

Each of these is load-bearing. Breaking one does not produce a type error; it produces a
second undo history, a silent corruption, or an agent that guesses.

### One command bus

**Every mutation anywhere goes through `applyCommand`** on the shared bus
(`packages/core/src/bus.ts`). The Electron UI, the CLI, the MCP server and scripts all
issue the same serialisable command. That single decision is what makes undo/redo,
replayable agent sessions and the tool surface agree with each other instead of being four
parallel implementations.

If you find yourself wanting to reach past the bus, the answer is almost always that a
command needs a new parameter — not that the bus is in the way.

### Adding a command

1. Write it in `packages/core/src/commands/*.ts` with `defineCommand` (zod `params` + `apply`).
2. Add it to `allCommands` in `packages/core/src/commands/index.ts`. That array is the
   single source of truth for the UI, the CLI and the MCP catalogue. There is no second
   list to update, and the zod schema *becomes* the tool's JSON Schema.
3. Give it a `guide` if it has conventions worth explaining, and point at it from
   `description`. The guide is served as `pixel://guide/{command}` and pulled on demand.

Things that will bite:

- `defineCommand` applies `.strict()`. A mistyped parameter is a hard error, not a silent
  default. This is deliberate — **do not soften it.** A `count` that quietly does nothing
  while `steps` was wanted is a data-loss-shaped bug, not a cosmetic one.
- `description` stays short: under 700 chars for a command. The tool-surface test enforces
  80..500 for a session tool unless the name is in `DESCRIPTION_BUDGET`. Long-form
  knowledge goes in `guide`, which the agent pulls when it needs it — a tool description
  sits in the context of *every* request for the life of the session.
- `readOnly: true` keeps a command out of undo history and off the version counter. A
  command that only inspects **must** set it. Asking a question should never cost the user
  their redo stack.
- `applyCommandToDraft` exists so a plugin command can expand into built-ins inside the
  caller's draft, which is how one undo step covers the whole expansion. The editor, not
  this, is the editing entry point.

### Pixel data is copy-on-write

A command must **never** mutate a `PixelBuffer` in place. Get one through
`draft.cel()` / `tilesetImage()` / `tilemapData()`, which clone on first touch. Mutating
arrays, layer objects, tags and palette entries in place *is* fine — the structural
snapshot owns its own copies.

Getting this wrong corrupts undo **silently**: no error, no failed test, just a sprite that
undoes into the wrong pixels an hour later.

`Draft` is the only mutation surface. If your code needs a third way to change a document,
it wants a command.

### `.describe()` on a zod field is the product

```ts
// not decoration — this is the text an AI agent reads to decide how to call the tool
color: z.string().describe('Colour, hex/rgb, or palette shorthand such as `pal:3`.'),
level: z.number().min(0).max(1).optional().describe('Coverage for `pattern`, 0-1. Defaults to 0.5.'),
```

`packages/mcp/test/tool-surface.test.ts` fails if any advertised parameter lacks a
description. The only exempt names are `x`, `y`, `w` and `h`.

The same is true of the prose itself. A description that says what the parameter *is* is
worse than useless, because the agent already inferred that from the name. Write the thing
the agent cannot guess: units, defaults, which layer a name refers to, when *not* to use
it. Compare:

```ts
// what it is: the name said this
pattern: ditherPatternSchema.optional().describe('Dither pattern.'),

// what it is, plus when it bites: the agent can act on this
pattern: ditherPatternSchema.optional().describe(
  'Stipple the paint with this pattern instead of laying it down solid. On canvases wider ' +
  'than ~128px prefer cluster2/cluster4: the same coverage lands as 2x2/4x4 blocks instead ' +
  'of a 1px digital stipple that reads as noise.',
),
```

### Failure codes are an API

Every error is a `CommandError` with a `code`: `unknown_command`, `invalid_params`,
`command_failed`, `version_conflict`. Agents branch on the code, not the prose — the three
mean genuinely different recovery strategies (re-read the list, fix the arguments, the
document rejected the operation).

Result envelopes are built only by `ok()` / `fail()` in `packages/mcp/src/tools.ts`.
Failures return `{ok: false, error, code, remediation?}`, `error` strings are held under
~320 chars by a test, and `remediation` should name the tool that would have helped:

> A report that arrived with nothing but the error text said "search `list_commands`" for
> every unknown name — including `apply_ops`, which is not in the catalogue and never
> could be found. Point at the *right* tool.

### The MCP tool surface is budgeted

The advertised list is deliberately ~34 entry-point tools. The ~90 core commands are not
in it until a session touches one; `commands: 'lazy'` promotes a command to a first-class
tool when it is looked up or actually run, and announces the new list.

- A new **core command costs nothing** in the tool list. Prefer a command over a tool.
- A new **session tool** (`addTool` in `packages/mcp/src/tools.ts`) eats a fixed budget.
  `tool-surface.test.ts` asserts `tools.length <= 40` and total advertised bytes
  `<= 100_000`. If a tool genuinely needs to grow, raise the number **in the same commit**
  and say why in the test name.
- Every tool must declare an `outputSchema` (defaults to `TOOL_RESULT_ENVELOPE`) and all
  four risk hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`),
  derived from the name when not given explicitly.
- `document` and `expectedVersion` are accepted on every tool and stripped from the
  advertised schema by `packages/mcp/src/surface.ts`. **Do not re-advertise them.**
  `tools/call` still validates against the untouched zod schema — the diet applies to
  `tools/list` only.

### Electron specifics

- The renderer never mutates through `core` directly. It may import `@pixel/core` for
  *local, uncommitted* work (`paint.ts` rasterises strokes with core's own rasteriser), but
  every committed edit goes over IPC through `window.pixel.execute` / `applyOps`. Bypassing
  the bus means a second undo history, and the main process is the only writer.
- Two tsconfigs, both run by `typecheck`: `tsconfig.json` (`electron/` + `shared/`, Node
  types) and `tsconfig.renderer.json` (`src/` + `shared/`, DOM, `jsx: react-jsx`, bundler
  resolution, `verbatimModuleSyntax`). Shared code must satisfy both.
- Adding an IPC capability means touching `CHANNELS` **and** `PixelApi` in
  `packages/app/shared/types.ts`, plus the main handler and the preload bridge. They cannot
  drift because they are declared in one file.
- Never import Electron into the renderer. Go through `window.pixel`.
- `packages/app/scripts/build-main.mjs` prepends a `createRequire` banner because
  `electron-updater` → `graceful-fs` calls `require()` and the app refuses to start without
  it. Do not remove it and do not switch the preload to ESM.

### i18n: five locales

`packages/app/src/i18n.tsx` carries `en`, `ja`, `ko`, `zh-CN` and `zh-TW`. `en` is the
source of truth and `TranslationKey` is derived from it, so a missing translation is a
**compile error**, not a blank label. Messages are `{placeholder}` templates, never string
concatenation. Never put a user-facing literal in a component.

If your change adds a string, add it to all five in the same commit. `en` alone will not
compile-pain you; the other four will be caught in review or by a speaker of that language.

### Dependencies

**No new runtime dependency without discussion — open an issue first.** `packages/core`
must stay at zero runtime dependencies; the whole reason it runs in a browser, a test
runner and CI from one source tree is that it has nothing to install. A dependency that
cannot be avoided goes in `devDependencies` at the root, not in a package.

---

## Comments are the product

This repository explains *why*, at length. A missing rationale is a review comment, not a
nit. It is the single biggest difference between a change that fits here and one that has
to be rewritten.

A comment earns its place by carrying information the code cannot:

```ts
// good — the decision, the reason, and what breaks without it
// `composite` deliberately *excludes* the layer being painted into. The usual workflow is
// a silhouette on the bottom layer and shading on a layer above it; if the target layer
// counted towards its own silhouette the clip would be a no-op the moment anything had
// been drawn, and the shading would bleed out of the sprite.

// good — the constraint is invisible in the code
// Strict at the top level, so a mistyped parameter is an error instead of a
// silent fallback to the default. Agents guess parameter names - a `count`
// that quietly does nothing while `steps` was wanted is a data-loss-shaped
// bug, not a cosmetic one.

// bad — restates the line below it
// Loop over the layers.
for (const layer of layers) { ... }

// bad — narrates the mechanic instead of the reason
// Increment i by 1.
i++;
```

The test: **would this comment be false after a reasonable refactor?** If the code changes
and the comment silently starts lying, it was noise. If the code changes and the comment
now contradicts it, the comment did its job — it was protecting a decision.

Comments that carry a *number* are especially welcome, because numbers are what make a
decision checkable later:

> The advertised tool list was 127 tools and 70.7K tokens of schema in the context of
> every request. It is now 33 tools and ~21K.

The same applies to the explanation of a decision that looks arbitrary in isolation. If a
reviewer had to ask "why is this 3.1.0?", the answer belonged in the file.

---

## Testing

Tests live in `packages/{core,mcp,script}/test/*.test.ts`. The app's single test sits next
to its source in `packages/app/electron/`. `cli` has no tests and uses
`--passWithNoTests`.

**Tests are not typechecked.** Every package tsconfig has `include: ["src"]`, so a type
error in a test only surfaces when Vitest runs it. `packages/app/electron/update-support.test.ts`
*is* covered, because the app's tsconfig includes `electron`. Do not assume `pnpm typecheck`
saw your test file.

Two test files are load-bearing in a way that is not obvious:

- `packages/mcp/test/server.test.ts` is the integration suite; it runs the real server over
  `InMemoryTransport`.
- `packages/mcp/test/tool-surface.test.ts` is the regression guard for every tool-list
  decision. Before you change what it asserts, **read the intent comment at the top.** It
  documents decisions that look arbitrary until you know the story, and several of its cases
  exist because a real agent session got it wrong.

### A test says where it came from

The house style for a test comment is a one-or-two-line note on *how the test was found*:

```ts
// Found by drawing: a plum-to-tan ramp interpolates through magenta and red, and
// nothing in the declaration said so.

// Found by driving the real server: a mistyped command name, a near-miss parameter
// and an invented layer name are the three likeliest mistakes an agent makes here,
// and all three came back with nothing but the error text.
```

This is not decoration either. Most of the regression tests in this repository exist
because something was observed to fail in real use — a drawing, a real MCP session, a
`read_grid` diff. A test with no story behind it usually should not exist. If you add a
test for a bug, one sentence naming the observed failure is worth more than three sentences
describing the assertion.

---

## Commits

Conventional Commits, with a scope. The scopes in use are the package or area:

```
feat(mcp): declare a small tool surface and promote commands on demand
fix(app): clamp the active frame before asking for a preview
feat(core, mcp): read the canvas as text with read_grid and pixel://grid
chore(release): prepare dotloom-mcp 0.4.1
docs: add AGENTS.md for agent onboarding
```

**The body explains why, and it is not optional.** The history is full of substantial
bodies: the decision, the alternative rejected, the measurement before and after, and what
the new test now guards. If your change needs a paragraph to be understood, write the
paragraph. The subject line is for scanning; the body is for the person in six months who
is about to undo your work.

Write the body as:

1. What changed and the problem it solves — including the numbers if there were any.
2. The decisions inside it, one bullet each, each with its reason.
3. What now guards it (a test, a budget, a CI step).

### Size

This repository's history is made of focused commits: one behavioural change, or one
refactor, or one fix. The release commit is separate from the change it releases. A
pull request carries one idea.

Practical advice, not a rule:

- **Under ~300 changed lines** is comfortable. Above ~800, expect to be asked to split it.
- Mechanical follow-ups (renames, formatting, moving a file) belong in their own commit, not
  folded into a behaviour change. A reviewer who has to read 400 lines of rename before
  reaching your 40-line change will not read either carefully.
- A refactor and a behaviour change in one commit cannot be reviewed: the reviewer cannot
  tell which lines are supposed to change behaviour. Split them, even if the intermediate
  tree is briefly red. If it cannot be split, say so in the PR body and explain why.
- Never mix a new runtime dependency into a feature. That is its own PR, with its own
  discussion.

---

## Pull requests

Use the [PR template](.github/PULL_REQUEST_TEMPLATE.md). Beyond the checklist there, a
reviewer will be looking for:

1. **The why, in the body.** What was wrong, what you chose, what you rejected. If the diff
   shows *what* changed, the body has to show *why*.
2. **A verification you actually ran.** Name the commands and say what you expected. A
   report of a check that was not run is worse than no report, because it makes the rest
   of the report untrustworthy.
3. **Whether the tests would have failed before.** A test that passes on the unmodified
   branch guards nothing.
4. **What you did not do.** A PR that adds a command and leaves the guide unwritten looks
   finished and is not.
5. **A `CHANGELOG.md` entry under `## [Unreleased]`,** in the voice already in that file —
   which is to say, as prose that explains the user-visible effect, not a restatement of
   the subject line.

Review is a conversation, not a gate. Push follow-up commits rather than force-pushing a
reviewer has already read; the history is part of the documentation here.

---

## Do not "clean up" these things

Every item in this list has a comment beside it in the file explaining exactly what breaks.
Removing a comment is cheaper than removing the line, but the point is that they are load-
bearing, not untidy.

- **`pnpm-workspace.yaml`.** The `app-builder-lib>@electron/get: 3.1.0` override exists
  because electron-builder 26.x calls an enum that `@electron/get@3.0.0` does not export,
  and packaging dies with `Cannot read properties of undefined (reading 'ReadWrite')`. The
  `allowBuilds` and `minimumReleaseAgeExclude` entries each have their own reason; deleting
  them fails the install. The override is deliberately scoped, because a blanket one would
  drag `electron`'s own `@electron/get@5` back to 3.x.
- **`dist/`.** Build output, gitignored, in every package and at the root. Never hand-edit
  it, and never treat a stale `dist` as a bug in the source. See
  [the build-order trap](#the-build-order-trap).
- **`.strict()` on command and tool schemas.** Do not soften a validation failure into a
  default to make a caller's life easier. A clear error is the feature.
- **The preload as CommonJS, and the `createRequire` banner in `build-main.mjs`.** See
  [Electron specifics](#electron-specifics).
- **The Electron HTTP MCP host binding `127.0.0.1:7331` (`PIXEL_MCP_PORT`).** Loopback only.
  Never expose it, never port-forward it. If you need remote access, that is a design
  conversation, not a config change.

Two conventions that are not traps but will still surprise you:

- Origin is top-left, x right, **y grows downward**, everything zero-based.
- Rectangles are `{x, y, w, h}` with `w`/`h` as counts, not end coordinates.

---

## Reporting a bug

Use the [bug template](.github/ISSUE_TEMPLATE/bug_report.md). Three fields matter more
than the rest, because this project behaves differently depending on them:

- **Which mode the MCP server was in** — `get_connection_status` reports whether the server
  is attached to a running desktop app or running in memory. The two behave differently
  and the difference is a frequent source of confusion.
- **The `ops` payload or the document**, verbatim. A screenshot of the canvas cannot be
  diffed; `{"ops": [...]}` can.
- **The sprite dimensions.** A large fraction of real defects are a drawing that does not
  fit the canvas, or a preview that was never read at a scale where the tones resolve.

## Reporting that the agent got it wrong

Open an [agent-usability report](.github/ISSUE_TEMPLATE/agent-usability.yml). This project
is used through an MCP client far more often than through the window, so "the model chose
badly" is a first-class defect class, not a complaint. What we want is the point where the
decision went wrong and whether the surface let the agent recover: was there a tool that
would have told it, a `guide` it never had a reason to read, a `remediation` that pointed at
the wrong place, or an error code it could not branch on?

## Showing your work

`artwork/` holds pieces drawn by an agent driving the public tool list over the wire — no
imports from `@pixel/core`, no direct `Editor` access, because the discovery path is the
thing being demonstrated. The [asset showcase template](.github/ISSUE_TEMPLATE/asset_showcase.md)
asks for the prompt and the ops JSON for the same reason: a piece nobody can reproduce is an
anecdote, and a reproducible one is a test.

---

## Licensing

dotloom-mcp is released under the [Apache License 2.0](LICENSE). There is no separate CLA
to sign: by opening a pull request you agree that your contribution is licensed under the
same terms as the rest of the project, and you keep your copyright in it.

The [Code of Conduct](CODE_OF_CONDUCT.md) applies in every project space, including
issues, pull requests and discussions.

## Security

There is no `SECURITY.md` yet, so for now: **do not open a public issue for a security
problem.** Report it privately to the maintainer listed in
[`packages/app/package.json`](packages/app/package.json), and mention in the subject line
that it is a private report. Please do not include a working exploit in a public thread.

Two things to keep in mind while you read the code: the plugin JavaScript sandbox is
intentionally narrow but is **not** a security boundary for untrusted code, and MCP tools
can read, write, import and export local file paths. Run the server as an OS user with only
the permissions you intend to grant.
