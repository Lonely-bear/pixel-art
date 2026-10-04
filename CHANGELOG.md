# Changelog

All notable changes to dotloom-mcp are documented in this file.

<p align="center">
  <a href="CHANGELOG.md">English</a> · <a href="CHANGELOG-ZH.md">中文</a>
</p>

## [Unreleased]

## [1.0.0] - 2026-10-04

The 1.0 release: a published stability contract, four stable library exports added, the
share bundle and PNG provenance, and one real compatibility change to `.pixel`.

### Breaking changes

- **A `.pixel` file's version number now describes the format, not the document.** The writer
  stamped `sprite.rig ? PIXEL_FORMAT_VERSION : 1`, so a rig-less document declared itself
  version 1 and the same document declared version 2 the moment a rig was attached, and the
  archive bytes of a rig-less document were a function of its payload rather than of its
  content. Every file is now stamped `PIXEL_FORMAT_VERSION` unconditionally.
  **A rig-less `.pixel` written now is refused by npm `0.1.0` through `0.1.3`** — the releases
  that predate rigs and knew only version 1. Version 1 files still load, and every release from
  `0.2.0` onwards accepts version 2, so the exposure is a reader pinned four minor versions
  behind.
- **Forward compatibility of `.pixel` is still not promised**, and `docs/STABILITY.md` now says
  so in the direction that costs us: a file written by a newer build is refused by an older one,
  and a future build is not obliged to open yours. What 1.0 does promise is that format version 1
  and 2 load, that a non-integer or sub-1 version is refused, and that the archive is
  byte-reproducible. **If you commit `.pixel` sources to a game repo, pin the package version in
  the same commit as the artwork** — a committed `.pixel` is a migration, not a permanent
  artefact.
- **An agent that reads only `tools/list` now sees less.** Advertised parameter and tool
  descriptions carry their first sentence; the full text is served by `describe_command` and
  the `pixel://guide/{command}` manuals. Nothing was deleted, and a test asserts every
  advertised description is a prefix of the served one.

### Added

- **A 1.0 stability contract, and a guard that reads it.** [`docs/STABILITY.md`](docs/STABILITY.md)
  declares exactly what is stable: the nine named exports of the published package —
  `buildSprite`, `buildAnimation`, `exportAssets`, `getDirectionModel`, `buildWalkAnimation`,
  `exportEngineAssets`, `traceSvg`, `VERSION`, `API_VERSION` — plus the three internal
  namespaces `core`, `mcp` and `script`, shipped and named as the escape hatch rather than
  promised. `API_VERSION` stays at `'1'`: the four names added since it was set were additions,
  and an addition is additive.
  `packages/core/test/stability-contract.test.ts` checks the declaration against the real
  published entry in **both** directions — a declared name that is not exported fails, an
  export that is not declared fails, and deleting the contract is itself a failure.
- **The negative half is written down too.** Not stable: the 32-module engine barrel behind
  `core`, the MCP tool list and its parameters, the CLI flag surface, command parameter schemas,
  the quality pipeline's numbers, and the share card's layout. Each entry names the guard that
  owns it, so `mcp-tool-list` is `packages/mcp/test/tool-surface.test.ts` rather than a promise
  nobody checks.
- **The published entry ships real types.** A consumer compile test asserts an undeclared
  specifier does not resolve, so a wrong call is a compile error rather than a runtime surprise.
- **Four more stable library exports**, all additive: `getDirectionModel`, `buildWalkAnimation`,
  `exportEngineAssets` and `traceSvg`.
- **8-direction characters.** An angle model — the base pose is drawn facing E and each cardinal
  is a whole-figure rotation about an orientation anchor or its mirror — with `get_directions`
  to read it and `generate_walk_cycle` to write a walk cycle for any of the eight directions.
  Three drawings, not eight: N, S, E and W are derived exactly, the diagonals are marked
  `exact: false` because a diagonal is a different drawing and no 45-degree pixel transform
  survives a pixel grid. No 45-degree transform is ever emitted.
- **`trace_svg`** traces an SVG outline into a cel.
- **`share_bundle`: a share template is a command with a template, not a script with its own
  serialisation.** A share bundle writes the same engine files and the same `meta.json` as any
  other export, and adds a card and provenance — it is a view of the contract, never a second
  kind of artefact. Four templates ship: `bare`, `card`, `handoff`, `review`.
  `scripts/build-share.mjs` builds and verifies them.
- **PNG provenance is carried, not burned.** `export_png` and `export_sheet` can write it, and
  the badge travels in the file's metadata rather than into the pixels.
- **The asset contract is on all four surfaces.** The same `meta.json` that the MCP tool wrote is
  now written by the `pixel` CLI and by the desktop editor's export dialog too, with the Godot,
  Unity, Phaser and Excalidraw importers behind it.
- **A generated gallery of this repository's artwork**, built by `scripts/build-gallery.mjs`,
  with a staleness gate that fails if the committed gallery no longer matches a fresh build.

### Changed

- **The advertised tool surface is 29.6% smaller: 99,994 → 70,424 bytes, with no capability
  removed.** The 667-byte result envelope repeated on every tool is now a 226-byte shape served
  with its prose on demand, and `execution` no longer restates a default. The ceiling moved from
  100,000 to 71,000 bytes — a budget with 6 bytes of headroom is a countdown, not a budget.
- **One asset-bundle renderer, in core.** `renderAssetBundle` is now the single place that builds
  a contract, validates its naming and walks an importer, instead of four surfaces each holding
  that walk. The CLI and the app call it; the MCP tool and the share command import it.
- **One issue projection.** The share card and the MCP quality report now share a projection of a
  report's issues, and `animationPreviewPayload` moved into core — which is why a share template
  can now ask for a `contact` output, which `share_bundle` previously refused by name. The
  projection keeps the distinction the pipeline rests on: an abstention is not a pass, so
  `ExcludedReason` survives the move.
- **A deprecation rule, and deliberately no deprecation mechanism.** Nothing is deprecated at 1.0,
  so there is no `@deprecated` marker to honour and none was built. The rule for when there is
  one is written down: announced in both changelogs, kept working for the rest of the major
  version, removal bumps `apiVersion`, never silently repurposed.
- **Nothing shipped changed a byte.** `build-share.mjs --verify` reports byte-identical output for
  210 files across two generations, and `build-gallery.mjs --check-stale` reports the committed
  gallery matches a fresh build.

## [0.5.0] - 2026-10-04

### Added

- **The judgement layer is reachable.** All six quality dimensions are registered (silhouette,
  value, palette, noise, outline, motion) and all six are usable: an `evaluate` command, an
  `evaluate` MCP tool, a `pixel://quality/{doc}` resource, and a quality gate on
  `finalize_document` that refuses a failing asset and leaves a notice when it is bypassed. A
  `fix` command turns issues into executable ops where a safe repair exists, and into prose
  where one does not.
- **Four more recipes, and a way to read one.** `topdown-rpg`, `dungeon-tileset`, `ui-icons` and
  `item-icons` join `platformer` in `recipes/`, each a full brief: canvas sizes with what each
  buys, palette ramps and a colour budget, a layer stack, tone planes against one light,
  production order, ten mistakes with an action for each, and read-only checks. A recipe lands as
  a file — there is no registry to edit. `describe_recipe` serves them, and `pixel://recipes` /
  `pixel://recipe/{id}` serve the same bytes without a tool call.
- **A recipe format, with a reference recipe.** `packages/core/src/recipes.ts`, plus
  `recipes/platformer.recipe.json` and `docs/RECIPES.md`. A recipe is guidance an agent reads and
  then executes through the existing tools, not a script. It deliberately has no field for a
  score: a format that can carry a target becomes one.
- **An asset metadata contract.** `docs/ASSET-CONTRACT.md` and `packages/core/src/asset/` define
  one `meta.json` that the Godot, Unity, Phaser and Excalidraw importers can all consume.
  Identity is a content hash rather than a document id, because ids are clock-based and two
  identical sprites drawn a second apart must not have two identities.
- **A showcase, generated through the advertised tool surface only.**
  `showcase/ironhold-knight/` carries the complete 14-call recipe as replayable `ops.json`, a
  per-call measurement manifest, and PNGs that are byte-reproducible on every run.
- **Copy-paste client configuration for claude, cursor, opencode and windsurf**, in `clients/`,
  with `docs/CLIENTS.md` and its Chinese mirror.

### Fixed

- **A name collision that took the whole MCP server down.** A core command and a session tool both
  called `evaluate`; the SDK throws on a duplicate registration, and in eager mode every server
  failed to start. Both paths are guarded now.
- **Five measurements shipped in a state where they could not fire.** `off-palette` triggered a
  tenth as late as specified, so a sprite well off its palette produced no issue at all;
  `meanSatQ` ran in a different dimension from every other ratio; `noise`'s band table was
  written and read in the order that inverted it, so a clean control scored worst; `ditherMask`'s
  alternation counter could never exceed 1, including on a perfect 50% checkerboard, so it
  reported "no dither" for any input; and `noise`'s neighbour counts included the pixel itself,
  which made two of its five issue codes unsatisfiable and had never been emitted once. A silent
  miss is the worst direction available, and every one of these now has a case that fails without
  the fix.
- **The curvature gate was reading the frame and calling it a mountain.** It asked whether the
  local form was round and had a single door — the subject's own outline — which on a document
  that fills its canvas is a wall. It now takes a second reference read from the document's own
  tone regions, and reports `formQ` as `null` with a stated reason instead of a perfect score on a
  term that had examined nothing. Whether a straight cut is caught still depends on which tone
  region it crosses; that is a measured limitation, recorded rather than tuned away.
- **`colourOrphans` fired on this repository's own clean work**, because a 1px staircase outline
  has no same-bucket 4-neighbour at any corner. Two replacements were measured and refuted before
  a third survived.
- **The OpenCode configuration in the README was invalid.** `mcp.servers.dotloom-mcp` matches none
  of that client's branches, so it silently configured nothing — and the same bug was in
  `docs/REFERENCE.md`, which is what a registry reviewer copies. Two OpenCode claims that could
  not be verified were removed rather than hedged.
- **`npx.cmd` is not a working command on Windows** for this server: `EINVAL` on every Node
  version the package supports. The Windows configuration goes through `cmd` + `/c`.

### Changed

- **§4.4 has no `dither-dominant` advisory.** With `ditherMask` working it fired on a declared
  negative control, because a 1px contour line and a 1px stipple are the same set of pixels.
  `ditherShare` is reported as a measurement and nothing is asserted about intent.
- **`dev/EVALUATION.md` §4.2 now describes the scorer that exists.** It had specified a form
  term the implementation replaced two tasks earlier, and the scoring table's boundary had been
  carried across from the old quantity's scale with its numbers unchanged — which is how it came
  to penalise the product's own taught construction. The rewritten section keeps the rejected
  alternative and the measurement that rejected it.
- **The generated calibration report grew the columns it needed** — `curvedQ max`, `reachQ max`, a
  `gated` count per gate, and an `unmeasured sub-scores` column, so an absent sub-score is
  re-derived on every run instead of remembered from a comment.
- The import menu entry is now labelled **Import PNG / .aseprite** in every language, so it says
  what it actually accepts.

### Known limitations

- **Neither the grader nor the gate is calibrated against human judgement.** Every threshold is a
  hypothesis under review, measured on one sprite. The expert ratings that would fix this are a
  human task, and no amount of engineering substitutes for it.
- **`near-duplicate-colours` is a false positive on smooth artwork.** The shipped icon reads far
  more pairs than any of the ten finished paintings, by two orders of magnitude, and the
  outlier is the cleanest asset in the repository. The penalty is flat because the count cannot
  *size* a decision error — and if it cannot size the defect it cannot find it either.
- **Registering a dimension can move a verdict away from a real defect.** A clean reading from one
  dimension outvoted a dimension that had something to say. Whether a clean reading should offset
  a real advisory is an open aggregator question.

## [0.4.2] - 2026-09-27

### Added

- **`pixel demo`: the whole product, in one command.** Someone who has just installed the package
  has nothing but Node, so this takes no input file, no palette and no required arguments. It
  authors a 32×32 sprite — ten colours, six layers, two frames on an `idle` tag, 33 commands —
  through the real command bus, writes an upscaled PNG and the editable `.pixel` source beside
  it, and prints exactly one JSON object like every other command, so it composes with a shell
  script. Every mutation goes through `Editor.execute`, so the `.pixel` it leaves behind is a
  genuine document with a real undo history behind it. `--out` and `--size` are the only flags.
- **A build-time library API, for the half of the pipeline with nobody in the loop.** An agent
  drives this product over MCP; a game's build script has to be able to drive it from code, as a
  `devDependency`, with no GUI and no MCP client. `buildSprite(spec)`, `buildAnimation(spec)` and
  `exportAssets(sprite, plan)` are that entry point, next to `VERSION` and `API_VERSION`.
  `exportAssets` returns bytes and never writes to disk — where they go belongs to the build
  system. [`docs/API.md`](docs/API.md) is the authority, [`docs/API-ZH.md`](docs/API-ZH.md)
  mirrors it, and `API_VERSION` is the versioned contract.
- **Determinism is a guarantee rather than an assumption.** Every "random-looking" thing the engine
  draws — noise fields, scatter points, terrain variant choices, reflection wobble — now comes
  from one seeded source. A committed baseline diff means *the artwork changed*, not *the run
  changed*, and those are indistinguishable after the fact. `deterministicIdFactory` is the
  opt-in for documents that must come out byte-identical.
- **A `.pixel` file is byte-reproducible.** The same ops, run twice, produce the same archive. Cel
  entries are named by position rather than embedding a clock-based layer id in the filename, and
  the zip timestamp is pinned, because a filename or timestamp that changes on every run makes
  "the source did not change" an uncheckable claim. Non-breaking in both directions, so the
  container version was deliberately **not** bumped.
- **A quality-analysis contract and the first two of six dimensions.** Six dimensions with
  per-mille integer scores, a `pass` / `warn` / `fail` verdict, and a compile-time guard that
  fails the build if a dimension id is added without its weights row. `silhouette` and `value`
  are implemented and measured against this repository's own artwork. **Applicability is declared
  per dimension: a dimension that cannot measure a document contributes no number at all** — its
  key is absent from the report and the reason is recorded, never a sentinel and never `0`,
  because `0` is silently averaged in by every caller that trusted the field.
  **None of this is an MCP tool, and none of it is on the advertised surface** — a number an agent
  can see becomes the target instead of the artwork, which is how a lake got sanded into a dark
  flat rectangle before `quality_report` was deleted in 0.3.1. What ships here is a library, a
  specification and a calibration harness.
- **A calibration corpus with ground truth by construction.** 63 cases in three tiers: 48 synthetic,
  each carrying a **declared** defect *and* what it must not fire on; 12 real — this repository's
  committed artwork, which may assert quietness but never taste; and 3 awaiting a human rating, a
  tier with no `expect` field at all. It withholds the machine's own scores from the human-rated
  section, because a rater who has seen the number is anchored to it.
- **[`dev/EVALUATION.md`](dev/EVALUATION.md)**, the contract for the analyzers: what each
  dimension measures, how it is banded, which house-style conventions it encodes and what each of
  those costs, and what the scorer is *not*. The dimensions ship a `baseline.md` next to the
  corpus, so a score change arrives with the measurement that justifies it.
- **The app can update itself from the Releases it was downloaded from.** A background check runs
  a few times a day while the editor is open; when a newer version exists a banner offers to
  download it, show its release notes, and restart into it. The same check is available on demand
  from **Settings ▸ Updates**. Three things are deliberately *not* automatic: nothing is
  downloaded without being asked for, a finished download waits for a person before the app
  restarts, and a version that has been dismissed stays dismissed. Builds that genuinely cannot
  replace themselves say so rather than pretending.
- **Updates are published as real release assets.** The workflow collects the `latest*.yml`
  metadata and `.blockmap` files electron-builder writes beside the installers and attaches them
  to the Release. Without them an installed app sees a release with nothing it can install.
- **The project can be picked up by a stranger, human or agent.** `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, issue templates and a pull request template that asks for a changelog
  entry in the voice already in the file.

### Fixed

- **The desktop app can import `.aseprite` files again.** The file dialog accepted PNGs only, so an
  Aseprite file could not be picked at all — a format the MCP tool and the `pixel import` command
  already supported. The dialog now offers `png`, `aseprite` and `ase`, and the file is told
  apart by its header: an Aseprite file arrives with its layers, frames, durations and tags
  intact.

### Changed

- **The README leads with the thing a stranger can do.** `pixel demo` and a real transcript are
  the first section, above the install instructions. The same pass corrected a factual error where
  the desktop app was described as bundling the CLI — it bundles the MCP server, and `pixel` is
  an npm install away.
- **This changelog has a Chinese mirror.** [`CHANGELOG-ZH.md`](CHANGELOG-ZH.md) tracks it, and both
  files ship in the npm tarball. English is the source of truth; where the two disagree, the
  English one is correct.
- **The Release page now carries this changelog.** The release workflow builds the notes with
  `scripts/release-notes.mjs`, which joins the install section to the `## [X.Y.Z]` section of
  `CHANGELOG.md` and to its `CHANGELOG-ZH.md` twin, and refuses to publish a version the changelog
  does not describe.

## [0.4.1] - 2026-09-26

### Added

- **A session no longer stays in memory just because the app was late.** Discovery used to be a
  one-shot decision at startup, so opening the editor a moment later was missed permanently — and
  a client that keeps a long-lived background service reused the headless connection across
  restarts, which made it look like only the first session ever attached. The stdio server now
  stands up the in-memory editor *and* relays to the app whenever one is found: an app that
  appears later attaches, and one that quits falls back to memory and is watched for again.
  `--standalone` still forces the in-memory editor.
- **`get_connection_status` tells the agent which store is live** — `mode` (`app` or `memory`), the
  endpoint it is attached to, and whether live preview is on. The two modes are otherwise
  indistinguishable until the user notices their window is not updating.
- **The startup instructions are mode-aware.** Detached, they tell the agent to tell the user the
  app was not detected and ask whether they want to open it *before* any work, and spell out that
  nothing is written to disk until a save.

## [0.4.0] - 2026-09-26

### Added

- **The editor is downloadable.** Every release now ships installers for Windows, macOS and Linux:
  an NSIS installer and a no-install portable `.exe` on Windows, `.dmg` and `.zip` for both Intel
  and Apple Silicon on macOS, and an AppImage plus a `.deb` on Linux. The app is self-contained —
  the CLI and the MCP server are built into the same binary as the window, so installing the
  editor is the whole installation. Code signing is wired but not configured.
- **A real application icon,** rasterised from `assets/pixel-mark.svg` from which electron-builder
  derives the Windows `.ico` and the macOS `.icns`.
- **A release that refuses to ship the wrong version.** `scripts/prepare-release.mjs` checks the
  tag against the root `package.json` and requires a dated changelog section for that version
  before a single runner starts. A mistyped tag fails in seconds instead of producing a Release
  labelled one version and installers built from another.
- **The user can box a region on the canvas and tell the agent about it.** A new select tool (the
  marquee icon, `M`) drags a rectangle; the canvas dims everything outside it and tints what is
  inside, with a readout showing the size, the origin, and a **Hint / Confine** toggle. The agent
  finds the box with `get_selection`, which returns the rect plus the layer and frame it was drawn
  on, and `set_selection` lets the agent point at a region itself. The default mode is `hint`,
  where the box says *where the subject is* and the agent may write just outside when the change
  needs room; `enforce` confines every write to the box. The box is session state — it costs no
  undo step, does not dirty the document, and never reaches the `.pixel` file.
- **Settings, in a dialog that behaves like one.** The gear in the title bar, or `Ctrl+,`, opens a
  sheet with Appearance, Language, Shortcuts and About. Changes are staged and written on Save, so
  Cancel genuinely cancels.
- **The interface speaks five languages.** English, 日本語, 한국어, 简体中文 and 繁體中文 ship in the
  binary — nothing is fetched at runtime. The first launch matches the OS, and a tag like
  `zh-Hant-HK` resolves to Traditional Chinese rather than falling through to English.
- **Appearance is the user's to set.** The theme is **System** (the default), Dark or Light;
  System follows the OS as it changes until a choice is recorded. Text size is five fixed steps,
  **12 / 14 / 16 / 18 / 22 px**, defaulting to **14**. The canvas stays light in both themes,
  because artwork colours must not shift with the chrome around them.

### Changed

- **The agent now settles two things with the user before its first edit.** For a new file with no
  stated size, it offers a few options and waits rather than quietly taking the 32x32 scratch
  document's dimensions. And it asks **who reviews the pictures** — itself judging two or three
  preview gates as it goes, or the user reviewing and handing back notes. The review mode decides
  whether the agent should be opening images at all.
- **Canvas size is no longer capped at "keep it small".** Any size from 1x1 to 4096x4096 has always
  worked; the guidance now says what each size buys and that **if the user asks for 512x512, build
  512x512**. What survives is the part that was actually true: on a large canvas, work in `rect`
  regions, batch the edits, and crop-zoom the preview.

### Removed

- **`quality_report` and the whole automated quality-review surface is gone** — the tool, the raster
  analysis behind it, the cross-frame character stability pass, the `landscape-quality` workflow,
  and every reference in the craft guide, the server instructions, the `draw_sprite` and
  `animate_sprite` prompts and the docs. A number is not a judgement: `defectScore` could be driven
  to 100 on a scene that had lost its light and its depth, and the model, told the number was
  "clean", sanded a lake into a dark flat rectangle. There was no threshold that separated the two.
  `read_grid` still verifies cheaply and exactly, and `get_preview` / `preview_animation` /
  `preview_tilemap` still approve.
- **`quality_report`'s `tilemap` mode is not lost with it.** `preview_tilemap` still returns the
  same tile-grid structure block and `export_tiled` still refuses to write a malformed map. Only
  the reporting wrapper around them went away.
- **The native menu bar and the OS title bar.** The renderer draws its own 40px title bar. The
  menu's accelerators were not dropped with it — with no application menu there is nothing for
  Electron to route a chord to, so each window claims its own.
- **The layout was rebuilt around the canvas.** A tool rail down the left and a title bar across
  the top, with a sidebar of six collapsible sections. Blend mode and opacity now describe only the
  *selected* layer. Each view keeps a single accent-filled control.
- **It is hand-drawn, and it holds together from 900px to 1440px and beyond.** All 63 icons are SVG
  paths written for this app — no icon library.

### Fixed

- **electron-builder could not package anything under pnpm.** `app-builder-lib` calls an export
  that the version it declared does not have, so every packaging run died; npm's flat layout
  happened to paper over it. A workspace-scoped override pins the dependency.
- **The canvas stopped fitting when the window changed size.** It only ever fitted once per
  document, so shrinking the window left the artboard cropped and the user had to reload the file.
  It now re-fits on resize — until you zoom or pan yourself, at which point your framing is left
  alone.
- **`Ctrl+Shift+Z` undid instead of redoing, and `Ctrl+Z` undid twice.** The main process looked
  the chord up in a table that had no entry for Shift, and the renderer *also* handled it in its own
  keydown listener. The chords now have one owner: the main process.
- **The settings dialog's font and text-size controls could not be operated at all.** The backdrop
  called `preventDefault()` on every press inside the sheet, which suppressed exactly the default
  action each control needs: the select never opened, the slider could not be dragged, and text
  fields never took focus. Buttons were unaffected, which is why it read as working.

## [0.3.2] - 2026-09-26

### Added

- **The tool finds the desktop app by itself.** `dotloom-mcp` with no arguments now looks for a
  running app on the loopback interface and forwards to it when found, so the agent edits the same
  documents the user's window shows. The endpoint is discovered rather than configured, because a
  URL baked into an MCP client config is wrong the moment the app moves to the next port — and
  wrong quietly. A client config is now just `{"command": ["dotloom-mcp"]}`.
- **Two independent discovery mechanisms, because either alone has a failure mode.** The app
  publishes a `host.json` record (url, port, pid) on startup and removes it on quit; the tool falls
  back to a TCP sweep of 7331-7340, which also covers an app build too old to write it. Every
  candidate must complete a real MCP `initialize` before it is accepted — an open port only proves
  something is listening.
- **`--json-status`** reports discovery as JSON and exits: whether an app was found, its url, port,
  pid and which mechanism found it.
- **`--standalone`** skips discovery entirely, and **`--host-wait <ms>`** tunes how long to keep
  looking (default 1500ms).
- **The agent is told when the app is absent.** The reason is appended to the server's
  `instructions` — the one channel the model itself reads. The agent can now say "no window will
  show these edits" instead of confidently reporting a sprite nobody can see. Headless and CI use
  keep working, which is why this degrades rather than failing.
- **`pixel://grid`** returns a document as one character per pixel, with `mask`, `value`, `index`
  and `named` views, and a repeated read reports which rows changed.

### Fixed

- **Agent edits reached the document but never reached the window.** The pixels were correct, but
  nothing announced the change: the renderer refreshed only from the `changed` IPC event, and that
  event was sent only by the GUI's own handlers. An agent drawing produced a correct document and a
  stale canvas, and the only way to see the work was to reopen the file. `DocumentStore` now
  announces its own mutations, which also makes a second window track an agent's edits.

### Changed

- `--attach <url>` still forces a specific endpoint and still fails loudly when it does not answer,
  but the bare `TypeError: fetch failed` now names the URL and points at `--json-status`.

## [0.3.1] - 2026-09-26

### Added

- **`run_script { path }`** runs a program from a `.js` file, re-read on every call and never
  cached, so editing the file changes the next run with no restart and no re-registration. The
  response reports `resolvedPath`.
- **`run_script { params }`** exposes the object to the script as the global `params` (`{}` when
  omitted), so tuning a value costs a short call instead of re-sending the program.
- **Script failures carry more than a message.** `errorInfo` now has `name`, a `stack` whose frames
  are remapped to the caller's own line numbers and filename, and `sourceLine` / `before` / `after`
  quoting the offending line. `code` is present for every failure, so a TypeError is branchable
  like any command failure.

### Changed

- The landscape analysis is reachable at `structure.landscape` only, instead of being serialised
  five times across two levels. A `quality_report` response is now 2.5KB, and 0.9KB with
  `brief: true`.
- A frame that is not a scene reports `{measurable: false, scene, conclusion}` instead of a
  landscape block full of nulls and a note repeated five times.
- The script guide documents that the context has no `btoa`/`atob`, `TextEncoder`, `Buffer`,
  `structuredClone`, `fetch` or timers.

### Removed

- `quality_report`'s `softnessScore`, an alias of `defectScore` on every input, and
  `presence.lightShare`, an alias of `presence.brightestShare`. Three names for one number was
  three chances to read the wrong one. **`quality_report`'s landscape block is no longer at the
  top-level `landscape` key** — use `structure.landscape`.

## [0.3.0] - 2026-09-26

A 33-tool declared surface with on-demand command registration, and the declaration layer that
makes the tool list worth reading.

The advertised tool list was 127 entries and 70.7K tokens of schema in the context of every request.
It is now 33 entries and ~21K, with the ~90 core commands reached on demand. Validation and
declaration are separated on purpose: the zod schemas stay strict and complete, and a single pass
produces the advertised form at `tools/list` time, so the tool list can be lean without the
contract becoming loose.

### Added

- **On-demand command tools.** A core command registers as a real MCP tool when the session touches
  one: an exact `list_commands` lookup, a `describe_command`, a `find_workflow` hit, or an
  `apply_ops` / `run_script` that issued it. Responses name what was promoted in `promotedTools`,
  `tools/list_changed` announces the new list. A substring browse does not promote.
  `createPixelServer({commands: 'eager'})` restores the previous flat catalogue.
- **Command manuals, read on demand.** A `guide` field on a command, served as
  `pixel://guide/{command}` and returned by `describe_command`, so the long-form conventions of
  `stroke_tilemap`, `autotile`, `dither_fill`, `set_tile`, `mirror`, `add_palette_ramp` and
  `outline` do not have to be carried in every request.
- **`outputSchema` on every tool**, over a shared result envelope. Failures are now a contract:
  `{ok: false, error, code, remediation?}`, where `code` is a stable machine-readable string and
  `remediation` names the change that fixes the call.
- **Derived risk annotations.** All four MCP hints are computed from the tool's name rather than
  hand-written per tool. `run_script` and `load_plugin` are the two marked `openWorldHint` because
  they execute code the server did not write.
- **`describe_command` describes the entry-point tools too**, which is the only route to the full
  parameter list of `apply_ops`, `finalize_document` or `run_script`.
- **`find_workflow` gained a "draw one good sprite" workflow** and a tilemap-terrain workflow. The
  most common task on the server previously matched a rig-and-timing workflow that promoted four
  commands none of which can draw.
- `scripts/mcp-call.mjs`, a stdio JSON-RPC driver for the local build, so the advertised surface can
  be exercised without an MCP client.

### Changed

- The declared tool list is 33 tools rather than 127, a 70% reduction in `tools/list`. Nothing is
  unavailable: `apply_ops` and `run_script` run any command from the catalogue with or without
  promotion.
- `document` and `expectedVersion` are accepted by every tool but advertised by none. They are
  optional everywhere, so restating them 127 times cost 9.4K tokens to say "operate on the active
  document". Both remain fully functional, including the `version_conflict` guard.
- Advertised schemas no longer carry the safe-integer bounds zod emits for every integer. Hand-
  written bounds such as `max(4096)` are untouched, and `tools/call` still validates against the
  full strict schema.
- Command descriptions are contracts: what it does, when to use it, whether it is reversible, and
  where its manual lives.
- `apply_ops` failures carry a `remediation` for the three likeliest mistakes — a misspelled
  command, a near-miss parameter name, and an invented layer or frame name.

### Fixed

- `quality_report` no longer recommends `antialias` for a high mean adjacent-luminance delta. Hard
  edges are the medium and a high value is not on its own a defect; the old wording contradicted the
  craft guide and would have softened correct art off a locked palette.
- A name that near-misses a real one gets `didYouMean` plus a remediation naming the right
  namespace, instead of advice that could not possibly work.
- `add_palette_ramp` and `outline` document their two traps that cost real pixels: hue interpolating
  along the wheel, and `scope: "composite"` excluding the layer being drawn into.

## [0.2.0] - 2026-09-26

Character rigging, asset-aware quality reporting, and task-level tool discovery.

### Added

- Persistent character rigs: layer-bound parts with stable pivots and parent hierarchy, named poses, stored tweens, anchors and hitboxes, plus `preview_pose` for non-destructive checks and `bake_pose` / `tween_pose` for explicit-frame output.
- `transform_part` and `transform_cel` for fixed-canvas arbitrary-angle rotation, translation and scale with nearest-neighbour sampling and no new colours.
- `.pixel` format v2 round-trips rig metadata. Version-1 files remain readable.
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