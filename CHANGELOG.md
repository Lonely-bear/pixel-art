# Changelog

All notable changes to dotloom-mcp are documented in this file.

## [Unreleased]

### Added

- **The app can update itself from the Releases it was downloaded from.** A background
  check runs a few times a day while the editor is open, and when a newer version exists
  a banner offers to download it, show its release notes, and restart into it. The same
  check is available on demand from **Settings ▸ Updates**, along with the installed
  version, the time of the last check, and a switch to turn the background check off.
  Three things are deliberately *not* automatic. Nothing is downloaded without being asked
  for, a finished download waits for a person before the app restarts, and a version that
  has been dismissed stays dismissed - so the editor never spends bandwidth or throws away
  unsaved work on its own. Restarting also asks first when a sprite has never been written
  to a file, since the main process is the only side that knows.
  Builds that genuinely cannot replace themselves say so rather than pretending: the
  portable `.exe` and the `.deb` point at the release page and at your package manager,
  and an unsigned macOS build does the same, because macOS will not verify a signature
  that is re-derived on every build. Signing the releases turns macOS self-updating on
  with no code change - the app is told at build time whether it was signed.
- **Updates are published as real release assets.** The release workflow now collects the
  `latest*.yml` metadata and the `.blockmap` files electron-builder writes beside the
  installers, and attaches them to the Release. Without them an installed app sees a
  release with nothing it can install, which is the difference between "you are on the
  latest version" and "there is no update" - and only the first of those is true.

### Fixed

- **The desktop app can import `.aseprite` files again.** The file dialog accepted PNGs
  only, so an Aseprite file could not be picked at all - the feature the MCP tool and the
  `pixel import` command already supported. The dialog now offers `png`, `aseprite` and
  `ase`, and the file is told apart by its header, exactly as the CLI does: an Aseprite
  file arrives with its layers, frames, durations and tags intact.

### Changed

- The import menu entry is now labelled **Import PNG / .aseprite** in every language, so
  it says what it actually accepts.

## [0.4.1] - 2026-09-26

### Added

- **A session no longer stays in memory just because the app was late.** Discovery used
  to be a one-shot decision at startup: `dotloom-mcp` waited 1.5s for an app and, if none
  answered, committed to a self-contained stdio server for the rest of its life. Opening
  the editor a moment later was therefore missed permanently - and a client that keeps a
  long-lived background service reused the headless connection across restarts, which
  made it look like only the first session ever attached. The stdio server now stands up
  the in-memory editor *and* relays to the app whenever one is found, re-running discovery
  while detached and following the app both ways: an app that appears later attaches, and
  one that quits falls back to memory and is watched for again. `--standalone` still forces
  the in-memory editor.
- **`get_connection_status` tells the agent which store is live.** The stdio server adds
  one tool of its own reporting `mode` (`app` or `memory`), the endpoint it is attached to,
  and whether live preview is on - the two modes are otherwise indistinguishable until the
  user notices their window is not updating.
- **The startup instructions are mode-aware.** Attached, they say live preview is on.
  Detached, they tell the agent to tell the user the app was not detected and ask whether
  they want to open it *before* any work, and spell out that nothing is written to disk
  until a save.

## [0.4.0] - 2026-09-26

### Added

- **The editor is downloadable.** Every release now ships installers for Windows, macOS,
  and Linux, built by electron-builder and published to the project's GitHub Releases:
  an NSIS installer and a no-install portable `.exe` on Windows, `.dmg` and `.zip` for
  both Intel and Apple Silicon on macOS, and an AppImage plus a `.deb` on Linux. Pushing
  a `vX.Y.Z` tag builds all three in parallel and collects them into one Release; the
  download table and per-version notes come from `.github/release-notes.md` and the
  changelog, so the two cannot drift.
  The app is self-contained — the CLI and the MCP server are built into the same binary
  as the window, so installing the editor is the whole installation. Code signing is
  wired but not configured: set `CSC_LINK` and the `APPLE_*` secrets and a new tag
  produces signed, notarised builds with no change to the app or the workflow.
- **A real application icon.** The mark from `assets/pixel-mark.svg` is now rasterised
  into a 1024×1024 `packages/app/build/icon.png` by `scripts/make-icon.mjs`, from which
  electron-builder derives the Windows `.ico` and the macOS `.icns`. It is drawn from
  signed distance fields at 2× supersample, so the rounded corners and the diagonal
  gradient stay clean, and it is regenerated with `pnpm --filter @pixel/app run icon`.
- **A release that refuses to ship the wrong version.** `scripts/prepare-release.mjs`
  checks the tag against the root `package.json` and requires a dated changelog section
  for that version before a single runner starts, and copies the version into the app
  package where electron-builder reads it from. A mistyped tag fails in seconds instead
  of producing a Release labelled one version and installers built from another.
- **The user can box a region on the canvas and tell the agent about it.** A new select
  tool (the marquee icon, `M`) drags a rectangle; the canvas then dims everything outside
  it and tints what is inside, with a readout in the bottom-right showing the size, the
  origin, and a **Hint / Confine** toggle. The agent finds the box with `get_selection`,
  which returns the rect plus the layer and frame it was drawn on, and `set_selection`
  lets the agent point at a region itself — to confirm a guess, or to narrow a box the
  user drew too loosely.
  It works because the app and the MCP server already share one `DocumentStore`, so the
  box is one object both sides read rather than two copies kept in sync. The default mode
  is `hint`, where the box says *where the subject is* and the agent may write just
  outside when the change needs room: "the head in my selection is too small, make it
  bigger" is the case this is for, and a hard clip would cut that edit off at the box
  edge. `enforce` confines every write to the box, for cleaning up a known area.
  The box is session state — it costs no undo step, does not dirty the document, and
  never reaches the `.pixel` file. A click with the select tool clears it, and a box whose
  layer or frame has since been deleted is dropped on read rather than handed to an agent
  that would edit the wrong pixels. Together these take the advertised tool list to 35.
- **Settings, in a dialog that behaves like one.** The gear in the title bar, or `Ctrl+,`,
  opens a sheet with a menu down the left and the selected section on the right: Appearance,
  Language, Shortcuts, About. Changes are staged and written on Save, so Cancel genuinely
  cancels and the Save button stays disabled until something has actually changed; the sheet
  fades and rises into place rather than appearing, and honours `prefers-reduced-motion`.
  The language picker that used to sit in the title bar is gone, so there is one place that
  owns the locale instead of two that could disagree.
- **The interface speaks five languages.** English, 日本語, 한국어, 简体中文 and 繁體中文 ship
  in the binary — nothing is fetched at runtime, and there is no webfont to download. The
  first launch matches the OS, and `matchLocale` resolves a tag like `zh-Hant-HK` to
  Traditional Chinese rather than falling through to English. `en` is the source of truth and
  every other dictionary is typed against it, so a missing or misspelled key is a build
  error rather than a blank label at runtime.
- **Appearance is the user's to set.** The theme is **System** (the default), Dark or Light;
  System follows the OS as it changes, and only stops doing so once a choice is recorded, so a
  machine that switches to light at dusk does not have to be told. The interface font is one
  of five stacks the operating system already has — or any family typed in by hand. Text size
  is five fixed steps, **12 / 14 / 16 / 18 / 22 px**, defaulting to **14**: a free slider let
  people land on 13.7px, which is neither readable nor predictable, and the sizes the layout is
  actually checked at are the ones worth offering. The canvas stays light in both themes,
  because artwork colours must not shift with the chrome around them.

### Changed

- **The Electron main process is bundled instead of emitted file-by-file.** pnpm links
  `@pixel/core` and `@pixel/mcp` as symlinks, and a packaged app cannot follow them, so
  `scripts/build-main.mjs` inlines the workspace packages and their npm dependencies into
  a single `main.js` — the approach `scripts/build-npm-package.mjs` already took for the
  published CLI. The packaged app now carries no `node_modules` at all, which is both
  smaller and no longer dependent on how pnpm happened to lay out the store.
  `pnpm typecheck` still runs `tsc --noEmit` over the same sources, so nothing is lost by
  emitting with esbuild, and the dev launcher builds through the same script.
- **The agent now settles two things with the user before its first edit.** Both are cheap to
  ask and expensive to guess, and each changes what it does next. For a new file with no
  stated size, it offers a few options and waits rather than quietly taking the 32x32
  scratch document's dimensions. And it asks **who reviews the pictures** — itself judging
  two or three preview gates as it goes, or the user reviewing and handing back notes, in
  which case it verifies with `read_grid` and spends no calls on previews nobody asked for.
  The second question matters more than it looks: the review mode decides whether the agent
  should be opening images at all.
- **Canvas size is no longer capped at "keep it small".** `create_document` used to say
  *prefer small canvases (16x16 to 64x64)* and the craft guide said not to invent a huge
  canvas "for detail", which together steered the agent away from anything the user actually
  asked for. Any size from 1x1 to 4096x4096 has always worked — 512x512 and 1024x1024 were
  verified end to end, previews at 8x zoom and PNG export included — so the guidance now says
  what each size buys and that **if the user asks for 512x512, build 512x512**. What survives
  is the part that was actually true: on a large canvas, work in `rect` regions, batch the
  edits, and crop-zoom the preview instead of inspecting everything each pass.

### Removed

- **`quality_report` and the whole automated quality-review surface is gone.** The tool, the
  raster analysis behind it (`defects` / `presence` / `noise` / `palette` / `structure` /
  `warnings`), the cross-frame character stability pass, the `landscape-quality` workflow and
  `quality-landscape.ts` are all deleted, along with every reference in the craft guide, the
  server instructions, the `draw_sprite` and `animate_sprite` prompts, and the docs. The
  advertised tool list goes from 34 to 33.
  A number is not a judgement. `defectScore` could be driven to 100 on a scene that had lost
  its light and its depth, because sparkle and grain scored identically to noise — and the
  model, told the number was "clean", sanded a lake into a dark flat rectangle. There was no
  threshold that separated the two, so the honest instruction is the one that was always true:
  look at the piece, and fix what you can see. `read_grid` still verifies cheaply and exactly,
  `get_preview` / `preview_animation` / `preview_tilemap` still approve, and the craft guide
  keeps the "do not sand it flat" warning as judgement rather than as a score.
- **`quality_report`'s `tilemap` mode is not lost with it.** `preview_tilemap` still returns the
  same tile-grid structure block (invalid indices, variant dominance and entropy, same-tile
  adjacency and runs, connected terrain, singleton cells, open edges), and `export_tiled` still
  refuses to write a map whose indices or cell size are malformed. Only the reporting wrapper
  around them went away.
- **The native menu bar and the OS title bar.** `frame: false` with
  `Menu.setApplicationMenu(null)`, and the renderer draws its own 40px title bar instead: drag
  region, double-click to maximise, and minimise / maximise / close. The menu's accelerators
  were not dropped with it — with no application menu there is nothing for Electron to route a
  chord to, so each window claims its own through `before-input-event` and forwards the intent
  over IPC. `TopBar`, `Toolbar` and `FramesPanel` are deleted.
- **The layout was rebuilt around the canvas.** A tool rail down the left and a title bar
  across the top replace the old top bar and toolbar, and the sidebar became six collapsible
  sections — Layers, Palette, Brush, Animation tags, Tilemap, History. Clip, dither and alpha
  moved out of the tool rail into Brush, and playback settings out of the timeline into
  Animation tags, because a rail nine buttons deep was carrying settings that needed a label
  and an explanation. Blend mode and opacity now describe only the *selected* layer rather than
  repeating three times per row. The timeline dock is a frame strip and a transport instead of
  three stacked rows. Each view keeps a single accent-filled control, so the Export button is
  the only thing that shouts.
- **It is hand-drawn, and it holds together from 900px to 1440px and beyond.** All 63 icons
  are SVG paths written for this app on a 24x24 grid — no icon library. The rail narrows from
  52px to 48px, the sidebar steps 300 / 272 / 240 / 232 and then auto-collapses on crossing
  1080px, and chrome that would overflow is dropped rather than allowed to wrap. The colour
  scheme is the opencode client's: `#fab283` on warm neutral greys, with blue, purple, green
  and red reserved for meaning rather than decoration.

### Fixed

- **electron-builder could not package anything under pnpm.** `app-builder-lib` calls
  `@electron/get`'s `ElectronDownloadCacheMode` but declares the dependency as `^3.0.0`,
  and 3.0.0 does not export it, so every packaging run died with `Cannot read properties
  of undefined (reading 'ReadWrite')`. pnpm's strict isolation is what exposed it, by
  handing `app-builder-lib` exactly the version it asked for; npm's flat layout happened to
  paper over it. A workspace-scoped override pins it to 3.1.0, the first 3.x with that
  export. The scope matters: `electron` itself wants `@electron/get@5`, and a blanket
  override would drag it back to 3.x.
- **The canvas stopped fitting when the window changed size.** It only ever fitted once per
  document, so shrinking the window left the artboard cropped and the user had to reload the
  file to get it back. It now re-fits on resize — until you zoom or pan yourself, at which
  point your framing is left alone.
- **`Ctrl+Shift+Z` undid instead of redoing, and `Ctrl+Z` undid twice.** The main process
  looked up the chord in a table that had no entry for Shift, so `Ctrl+Shift+Z` forwarded
  `undo`; and because the renderer *also* handled the chord in its own keydown listener, a
  single `Ctrl+Z` popped two steps off the history. Shift now selects a separate table, and
  the chords have one owner: the main process.
- **The settings dialog's font and text-size controls could not be operated at all.** The
  backdrop called `preventDefault()` on every press inside the sheet — `mousedown` bubbles, and
  only `click` was stopped — which suppressed exactly the default action each control needs:
  the select never opened, the slider could not be dragged, and text fields never took focus.
  Buttons were unaffected, which is why it read as working. The press origin is tracked
  instead, so a drag that ends on the backdrop still does not dismiss the dialog.

## [0.3.2] - 2026-09-26

### Added

- **The tool finds the desktop app by itself.** `dotloom-mcp` with no arguments now looks for a
  running app on the loopback interface and forwards to it when found, so the agent edits the
  same documents the user's window shows. The endpoint is discovered rather than configured,
  which is the point: the app only knows its port after its own retry loop picks one, so a URL
  baked into an MCP client config is wrong the moment the app moves to the next port - and
  wrong quietly, with the agent drawing into a store nobody is watching. A client config is now
  just `{"command": ["dotloom-mcp"]}`.
- **Two independent discovery mechanisms, because either alone has a failure mode.** The app
  publishes a `host.json` record (url, port, pid) to a stable, app-name-independent location on
  startup and removes it on quit; the tool falls back to a TCP sweep of 7331-7340 when the file
  is missing or stale, which also covers an app build too old to write it. Every candidate must
  complete a real MCP `initialize` before it is accepted - an open port only proves something is
  listening, and on a shared machine 7331 can outlive the app as an unrelated process.
- **`--json-status`** reports discovery as JSON and exits: whether an app was found, its url,
  port, pid and which mechanism found it. For diagnosing "my agent edits go nowhere" without
  reading a stack trace.
- **`--standalone`** skips discovery entirely, and **`--host-wait <ms>`** tunes how long to keep
  looking (default 1500ms, which covers the common race of the client starting the tool just
  before the user opens the app).
- **The agent is told when the app is absent.** With no app running the tool still runs
  self-contained, and `createPixelServer { instructionsNote }` appends the reason to the server's
  `instructions` - the one channel the model itself reads. The agent can now say "no window will
  show these edits" instead of confidently reporting a sprite nobody can see. Headless and CI use
  have no app and keep working, which is why this degrades rather than failing.
- **`pixel://grid`** returns a document as one character per pixel, with `mask`, `value`, `index`
  and `named` views, and a repeated read reports which rows changed. Cheap verification between
  the visual gates: `get_preview` is how you approve, the grid is how you check.

### Fixed

- **Agent edits reached the document but never reached the window.** The store was already shared
  between the GUI and the MCP server, so the pixels were correct, but nothing announced the
  change: the renderer refreshed only from the `changed` IPC event, and that event was sent only
  by the GUI's own handlers. An agent drawing produced a correct document and a stale canvas, and
  the only way to see the work was to reopen the file. `DocumentStore` now announces its own
  mutations (`onChange`, fired from `add`/`select`/`remove`/`touch`/`markSaved`/`clear`), and the
  app subscribes once, which also makes a second window track an agent's edits.

### Changed

- `--attach <url>` still forces a specific endpoint and still fails loudly when it does not
  answer, but the bare `TypeError: fetch failed` now names the URL and points at
  `--json-status`.

## [0.3.1] - 2026-09-26

### Added

- **`run_script { path }`** runs a program from a `.js` file, re-read on every call and never
  cached, so editing the file changes the next run with no restart and no re-registration.
  `path` and `source` are mutually exclusive and both absences are reported as errors rather
  than as a validation failure. The response reports `resolvedPath`; relative paths resolve
  against the server working directory and `~` expands.
- **`run_script { params }`** exposes the object to the script as the global `params` (`{}`
  when omitted). With `path` this makes one file a function of its inputs, so tuning a value
  costs a short call instead of re-sending the program — the case a parameterised art
  generator hits on every variation.
- **Script failures carry more than a message.** `errorInfo` now has `name`, a `stack` whose
  frames are remapped to the caller's own line numbers and filename, and `sourceLine` /
  `before` / `after` quoting the offending line. `code` is present for every failure, with
  `script_threw` for a plain runtime error, so a TypeError is branchable like any command
  failure. `logs` were already preserved and still are.
- **`quality_report { brief: true }`** returns only the numbers a model acts on, plus each
  warning as `{code, severity}`. Same analysis, about a third of the bytes: the per-plane
  arrays, the landscape block, the region breakdown and the warning prose are dropped.

### Changed

- The landscape analysis is reachable at `structure.landscape` only. It was serialised at
  `landscape` as well, with `horizon`/`ridge`/`waterline`/`guideLines` repeated a level up in
  `structure`: five copies of the same object, 2.4KB of a 4.9KB response for a 96x96 sprite.
  A `quality_report` response is now 2.5KB, and 0.9KB with `brief`.
- A frame that is not a scene reports `{measurable: false, scene, conclusion}` instead of a
  landscape block full of nulls and a note repeated five times.
- The script guide documents that the context has no `btoa`/`atob`, `TextEncoder`, `Buffer`,
  `structuredClone`, `fetch` or timers, and that base64 arrives as a string argument.

### Removed

- `quality_report`'s `softnessScore`, an alias of `defectScore` on every input, and
  `presence.lightShare`, an alias of `presence.brightestShare` which was itself equal to
  `overexposedRatio`. Three names for one number was three chances to read the wrong one, and
  nothing in the craft guide referenced either. **`quality_report`'s landscape block is no
  longer at the top-level `landscape` key** — use `structure.landscape`, which is what the
  craft guide and the `landscape-quality` workflow already pointed at.

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
