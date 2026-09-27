# Changelog

All notable changes to dotloom-mcp are documented in this file.

<p align="center">
  <a href="CHANGELOG.md">English</a> · <a href="CHANGELOG-ZH.md">中文</a>
</p>

## [Unreleased]

### Fixed

- **Four committed scenes have no judged plane because their tone field is dithered, and the gate that
  was supposed to be at fault is not.** The `reachQ` gate closes the last of the full-bleed scenes and
  reads its denominator as the subject's bounding box, which on a full-bleed document is the whole canvas
  — so a plane has to span half the picture to be judged. That is the same shape of error the previous two
  entries fixed for curvature, and the obvious move is to normalise against the form the plane cuts
  instead. **Measured, that move is wrong, and this entry records why rather than making it.**
  Plane extents are small everywhere: median 6..10px against a body of 64..512, `p90` 16..33. On
  `artwork/sunset-lighthouse-512.pixel` — 512², 1008 terminators — the **largest** plane is 110px where
  the gate wants 256. A region-relative denominator opens 110 planes there, and they are water ripples
  and sky sparks: a short plane inside a small region scores *high* on that ratio, so the change admits
  texture rather than form.
  Counting 4-connected same-bucket regions says what the pictures are: `lantern-keeper` has 8 regions per
  bucket, `dusk-lake-valley-agent` 95, `autumn-dusk-lake-256` 519, and `sunset-lighthouse-512`
  **2,880** — 46,079 regions, 98.8% of them 16 pixels or smaller, in a painting with 16 tones. A
  hard-edged painting with 16 tones has tens of regions. That is a dithered and gradient tone field, and
  §4.2's plane definition — both sides an area — finds no plane across a dithered transition at all, so
  the sun's limb and the water's horizon there were never planes to gate.
  `reachQ` turns out to be an accidental dither detector pointing the right way: the scenes it opens are
  the least fragmented ones (95, 519 and 632 regions per bucket read `reachQ max` 1000, 1000 and 996, and
  those are the three with a measured `formQ`), and the two most fragmented read 215 and 236. **So no gate
  changed.** What is missing is the ability to *say* that a picture is dithered, and the quantity that
  would is §3.3's `ditherMask` — specified, unimplemented, and declared as `noise`'s consumer. Until it
  lands, the report's `gated` column gives `curvature` and `reach` as reasons on pictures whose real reason
  is neither, and all four of those scenes have both gates closing something. The state is pinned by a
  test, so a future change that suddenly judges them has to answer why: nothing about the pictures
  changed.

- **Whether a straight cut was caught depended on where it had been drawn.** The previous entry gave §4.2's
  curvature gate a second reference and stopped it being blind on a full-bleed document. It did not stop it
  being a coin toss. The gate asks whether the local form is round, and the second reference read a tone
  region's curvature over its **whole** boundary — which contains the plane being judged. A straight band
  drawn across a curved dome therefore read `curvedQ` **260** at one row and **248** at the next, against a
  gate of 250: the defect was reported where the band crossed a wide part of the dome and excused where it
  crossed a narrow part, because the band's own straight cut contributed boundary pixels and no corners to
  the very ratio meant to describe the arc it was cutting. Nobody can act on "your defect was drawn in the
  wrong place".
  A new §3.3 quantity, `planeCurvedQ`, reads a region's curvature with **the plane's own boundary removed** —
  the form the plane cuts, without the plane — and the gate takes the maximum of all three references. The
  same band now reads 333 and 420, both clear of the gate, and `value/straight-band-over-terrain-64` is in
  the corpus reporting `plane-crosses-form`. Two properties survive the change, and they are the test of
  whether the reasoning that refused two shortcuts was sound: a region whose **only** boundary is the plane
  is left with nothing and reads 0, still "cannot measure"; and a straight-edged box reads 93 before and
  after, because excluding the band between two straight bands leaves straight runs on both sides.
  It is per region **pair** and not per terminator, so it is one pass over the canvas rather than one
  full-boundary rescan per plane — the largest committed scene has 1008 terminators.
  What it costs, measured: `gated` moved on 8 rows and `curvedQ max` on 4, and **no score moved anywhere**.
  Nine more planes on the committed artwork became judged and every one came back clean. That is the reason
  improving rather than the number, and it is a weaker claim than it looks — it means nothing in the corpus
  got worse, not that the artwork has no defects.
- **Two bugs in the new curvature reference, both caught by the corpus on their first run.** The exclusion
  counters were keyed by the *unordered* region pair, so both sides of a pair subtracted the same total and
  a density came out as **7385** — impossible, since a density cannot exceed 1000. And a pixel with two
  neighbours in the same region was counted twice, so the excluded boundary could exceed the boundary and
  the density divided by zero, reading `NaN` on the largest committed scene. Both are recorded next to the
  quantity rather than in a changelog, because the second is the kind of defect that only shows up on the
  one document in the corpus with a one-pixel neck in it.



- **§4.2's curvature gate can now read curvature that does not come from the silhouette.** This is the
  coverage half of the entry below: the previous change made the form term *honest* about a full-bleed
  scene, and this one makes it *able to judge* one. The gate asked whether the local form is round and
  had a single door — the subject's own outline — and on a document that fills its canvas that door is
  a wall, because the outline is the frame: `curvedQ` read 0–77 on all ten committed scenes against a
  gate of 250, so every plane in every one of them was exempt. No threshold fixes that, because when
  the mountain reaches the edges it *is* the frame.
  A second reference, §3.3's new `regionCurvedQ`, reads the curvature off the shape of the document's
  own tone regions, and the gate takes the **maximum** of the two. A maximum can only make the gate
  more permissive, so every plane already judged is still judged with the same numbers and **no
  `value`, `formQ` or `crossesQ` moved for any subject with a readable outline**; planes that used
  to be exempt on curvature are now examined instead, and the reading itself changes on most rows
  (measured: `curvedQ max` moved on 32 of 59). The ten scenes now read 667–880, three of them
  acquire a measured `formQ` of 1000 that they previously reported as `unmeasured`, and
  `value/hard-surface-terminator-32` — a straight-edged box, the gate's own negative control —
  stays at 93 and keeps the exemption that a straight plane across a straight-edged form is
  correct.
  Measured limitation, recorded rather than tuned away: whether a straight cut is *caught* still depends
  on which tone region it crosses (260 against 248 either side of the gate), so the honesty is fixed
  everywhere and the coverage is not.
- **The quality scorer's form term was reporting a perfect score on ten finished paintings it had
  never looked at.** §4.2's curvature gate asks whether the local silhouette is round and reads it
  off the subject's own outline — and a subject that fills its canvas has no outline, because its
  boundary *is* the frame. Every plane on all ten of this repository's committed scenes was exempt,
  every one of them scored zero, and nothing recorded that a zero there meant "not asked" rather
  than "no defect", so the sub-term read `formQ` 1000 and `value` read 700–950 on a term that had
  examined nothing. `formQ` is now `null` with a stated reason, and the dimension reports the half
  it did measure.
- **`QualityDimension` can now be partly unmeasured, and says which part.** A dimension that is
  present and half-blind is a shape neither the report's `dimensions` map nor a score can express:
  `dimensions` is partial, so absence means *not applicable*, and a score cannot say "this half is
  1000 for a measurement nobody took". The new `unmeasured` field names the sub-scores that were not
  measured and why, it is **required** rather than optional — a sub-score that is silently absent is
  indistinguishable from one counted at its best — and an unmeasured sub-score drops its weight with
  the remainder re-normalised, which is the rule a still sprite's absent `motion` already followed.
  Two new reason strings are agent-facing API: `'no-judgeable-plane'` for a frame with no tone plane
  to judge, and `'no-subject'` reused from the dimension-level enum for a full-bleed subject.
- **The form term ranked a target above a sphere.** §4.2's `bendQ` divided the number of distinct
  8-step orientations a boundary walks by the number of half-plane orientations, and an open
  boundary on a convex body cannot use the fourth without closing — so a maximally-turning arc read
  667 and the ring enclosing it read 1000. The product's own reference artwork, and the translated
  contours the craft guide teaches, came out 250 per-mille *below* a level-set ring on the same body
  with the same five tones, the same five planes and no defect on either side. The ladder now
  saturates at three orientations; the band table did not move, the acceptance pair's separation
  grew from 325 to 450 per-mille, and the straight-diagonal defect case is unchanged and still
  blocking.

### Changed

- **`docs/EVALUATION.md` §4.2 now describes the scorer that exists.** It specified the `dist`-spread
  form term that the implementation replaced two tasks ago; `crossesQ`, `bendQ`, `splitQ`, `reachQ`
  and `curvedQ` appeared nowhere in the specification, the scoring table keyed on a quantity nothing
  computed, the issue-code row fired on it, and the worked example was arithmetic that had never been
  run. The scoring table's 150 "no penalty" boundary had been carried across from the old
  quantity's scale with its numbers unchanged and never re-derived, which is how it came to
  penalise the product's own taught construction. The rewritten section keeps the rejected
  alternative and the measurement that rejected it, and the worked example is now two committed
  corpus cases rather than two sheets of arithmetic.
- **The generated calibration report grew a column it needed.** §2 prints `curvedQ max` and
  `reachQ max` — the maximum over every plane rather than the worst plane's readings, because
  reading them off the worst plane prints `-` on exactly the rows the finding is about — plus a
  `gated` column giving the count per gate, and §3 carries an `unmeasured sub-scores` column so an
  absent sub-score is re-derived on every run instead of being remembered from a comment.

## [0.4.2] - 2026-09-27

### Added

- **`pixel demo`: the whole product, in one command.** Someone who has just installed the
  package has nothing but Node, so this one takes no input file, no palette and no required
  arguments. It authors a 32×32 sprite — ten colours, six layers, two frames on an `idle`
  tag, 33 commands — through the real command bus, writes an upscaled PNG and the editable
  `.pixel` source beside it, and prints exactly one JSON object like every other command,
  so it composes with a shell script. The artwork is drawn the way a pixel artist blocks
  one in — one flat silhouette, a hue-shifted ramp, tonal planes that follow the form,
  light from a single direction, a consistent 1px contour — because a demo that looks
  procedural teaches people the wrong thing, and every mutation goes through
  `Editor.execute`, so the `.pixel` it leaves behind is a genuine document with a real undo
  history behind it. That is the proof this is a tool and not a texture generator.
  `--out` and `--size` are the only flags.
- **A build-time library API, for the half of the pipeline with nobody in the loop.** An
  agent drives this product over MCP; a game's build script has to be able to drive it
  from code, as a `devDependency`, with no GUI, no MCP client and no editor running.
  `buildSprite(spec)`, `buildAnimation(spec)` and `exportAssets(sprite, plan)` are that
  entry point, next to `VERSION` and `API_VERSION`; `core`, `mcp` and `script` ship beside
  them as the documented escape hatch. `exportAssets` returns bytes and never writes to
  disk — where they go belongs to the build system, not to this package.
  [`docs/API.md`](docs/API.md) is the authority and [`docs/API-ZH.md`](docs/API-ZH.md)
  mirrors it, and `API_VERSION` is the versioned contract: inside one major version of it
  only additive changes are permitted, so a build script can pin it and mean something.
  It is `1` here, and the eight exports are asserted by a test.
- **The published entry is typechecked, and its surface is asserted.** `pnpm typecheck` now
  compiles the npm entry along with everything else (`tsconfig.npm.json`). It had no
  typecheck coverage at all, which meant a broken entry failed in a consumer's pipeline
  rather than in this one.
- **Determinism is a guarantee rather than an assumption.** Every "random-looking" thing
  the engine draws — noise fields, scatter points, terrain variant choices, reflection
  wobble — now comes from one seeded source, built on `mix32` and `mulberry32` rather than
  an inlined hash of unknown provenance. What that buys is small and specific: a committed
  baseline diff means *the artwork changed*, not *the run changed*, and those are
  indistinguishable after the fact. Fields are position-addressed, so evaluation order is
  irrelevant and adding a pixel does not disturb its neighbours; streams are for sequential
  work, because a stream is order-dependent and skipping one draw shifts everything after
  it. Chasing this turned up three real defects — a truncated `scatter` seed,
  `Math.hypot` on a result path, and a `serializeSprite` that was never byte-reproducible
  in the first place. `deterministicIdFactory` is the opt-in for documents that have to come
  out byte-identical.
- **A `.pixel` file is byte-reproducible.** The same ops, run twice, produce the same
  archive. Cel entries are named by position (`cels/0_1.png`) rather than embedding the
  layer id inside the filename, because an id comes from the clock and real entropy, and a
  filename that changes on every run makes "the source did not change" an uncheckable
  claim. The zip timestamp is pinned to 1980-01-01 *local* — fflate had been stamping
  every entry with `Date.now()`, so even a fully deterministic document produced a
  different archive on every save, and pinning the instant in UTC would instead have made
  the bytes depend on the machine's timezone. The rename is non-breaking in both
  directions, because the reader always resolved paths through the manifest, so the
  container version is deliberately **not** bumped.
- **A quality-analysis contract, an aggregator, and the first two of six dimensions.**
  `packages/core/src/quality/` freezes six dimensions with per-mille integer scores, a
  `pass` / `warn` / `fail` verdict, and a compile-time guard that fails the build if a
  dimension id is added without its weights row. `silhouette` and `value` are implemented
  and measured against this repository's own artwork, which is where the interesting part
  is:
  - **Applicability is declared per dimension, not per document class.** A full-bleed
    scene has no silhouette and no outline, and does have value structure and a palette —
    so a dimension that cannot measure a document contributes **no number at all**: its key
    is absent from the report and the reason is recorded, never a sentinel and never `0`,
    because `0` is silently averaged in by every caller that trusted the field. The first
    `silhouette` implementation scored ten full-bleed scenes a confident 800 with a blocking
    `shape-clipped` issue, since for a scene whose ink runs to the frame the alpha boundary
    *is* the canvas edge. Ten confident wrong numbers are worse than none. The "is there a
    subject" test is deliberately a pixel margin rather than a per-mille quantity: a 1px
    margin is 234/1000 on a 16² canvas and 7/1000 at 2px on a 1024² one, and no single
    threshold serves both ends.
  - **The threshold did not move; the measurement did.** The only real character sprite in
    this repository was being *penalised* — `compactnessQ` 269 against a gate of 300 — and
    the dimension returned an identical 800 for artwork that had been rejected twice and
    artwork that had been accepted. The cause was the measurement, not the gate: compactness
    was computed over the whole mask, so a subject was paying for its own scattered pixels,
    and it was scale-invariant, so a 32² blade edge and a 1024² horizon scored the same. It
    is now computed per subject part and split into `thicknessPx` and `thicknessQ`, which
    is the shape of the thing: blade and horizon differ by 91 while every shape reading
    stays identical.
  - **`value` can tell a bad shadow from a good one.** A hard straight-diagonal band and
    correctly nested contours were 0.014 apart in the report total. They are now 385‰ apart
    in the dimension and 0.179 in the total — a whole verdict grade, which is the difference
    between a scorer and a mood ring.
  - **Two findings are recorded and deliberately left unfixed**, because the honest fix in
    each case is a new shared quantity rather than a threshold: the curvature gate reads
    nothing on a full-bleed subject, so the form sub-term is a perfect 1000 on all twelve
    real assets — a straight shadow band across the mountains passes today — and `keyLight`
    is a subject-level check being applied to scenes.

  **None of this is an MCP tool, and none of it is on the advertised surface.** A number an
  agent can see becomes the target instead of the artwork — that is how a lake got sanded
  into a dark flat rectangle before `quality_report` was deleted in 0.3.1 — so what ships
  here is a library, a specification and a calibration harness. The command, the tool and
  the gate that would consume them are later work, and the gate belongs in
  `finalize_document` refusing, not in a tool that advises. The lesson that produced
  `AGENTS.md`'s "do not show an agent a number to optimise" section is written down rather
  than left as tribal knowledge.
- **A calibration corpus with ground truth by construction.** 63 cases in three tiers:
  48 synthetic, each carrying a **declared** defect *and* what it must not fire on, because
  an analyzer that cries wolf on clean work is worse than one that misses a defect;
  12 real — this repository's committed artwork, which may assert quietness but never taste;
  and 3 awaiting a human rating, a tier whose type has no `expect` field at all, so no code
  path can compare an unrated image against an expectation. The tier boundaries are
  enforced by four loader rules rather than by a comment. Cases are declarative descriptions
  materialised deterministically at test time instead of committed PNGs — sixty-odd binary
  files would be an unreviewable diff on every engine change, and a threshold edit would
  look like a picture edit — and the generated report is compared byte for byte, so a score
  that moves is a diff a reviewer reads. It also withholds the machine's own scores from
  the human-rated section, because a rater who has seen the number is anchored to it.
- **The scoring specification is written down.**
  [`docs/EVALUATION.md`](docs/EVALUATION.md) is the contract for the analyzers: what each
  dimension measures, how it is banded, which house-style conventions it encodes and what
  each of those costs, and what the scorer is *not*. It has been amended twice against
  measured evidence — the second time because four of the formulas turned out to be
  measuring something other than what they claimed, and because §3.1 described an input
  contract (`alphaThreshold`, `background`, `scope`) that exists in the prose and not in the
  frozen type, which six analyzers would otherwise have been written against. The
  dimensions now also ship a `baseline.md` next to the corpus, so a score change arrives
  with the measurement that justifies it.
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
- **The project can be picked up by a stranger, human or agent.** `CONTRIBUTING.md`
  covers setup, the build-order trap, the review rules and the release checklist;
  `CODE_OF_CONDUCT.md` and issue templates for bugs, features, agent usability and an
  asset showcase are in place, along with a pull request template that asks for a
  changelog entry in the voice already in the file, and a seeded list of good first
  issues. `AGENTS.md` documents the one architectural rule - every mutation crosses
  `applyCommand` - and the traps that catch agents out, and `TASKS.md` is the single
  event bus the roadmap runs on. It also records the review rule this release was built
  under: a claim of "verified" is not evidence, it has to be re-checked independently,
  and with a *discriminating* case, because a test that passes whether or not the bug is
  present proves nothing.

### Fixed

- **The desktop app can import `.aseprite` files again.** The file dialog accepted PNGs
  only, so an Aseprite file could not be picked at all - the feature the MCP tool and the
  `pixel import` command already supported. The dialog now offers `png`, `aseprite` and
  `ase`, and the file is told apart by its header, exactly as the CLI does: an Aseprite
  file arrives with its layers, frames, durations and tags intact.

### Changed

- **The README leads with the thing a stranger can do.** `pixel demo` and a real
  transcript are the first section, above the install instructions and the agent
  configuration: a reader who has to scroll to find out what the tool does is being asked
  for patience nobody offered them. The same pass corrected a factual error inherited from
  the 0.4.x README, where the desktop app was described as bundling the CLI - it bundles
  the MCP server, `pixel` is an npm install away, and the Release notes repeated the same
  mistake until now.
- **This changelog has a Chinese mirror.** [`CHANGELOG-ZH.md`](CHANGELOG-ZH.md) tracks
  it, and both files ship in the npm tarball. English is the source of truth; where the two
  disagree, the English one is correct and the Chinese one is the stale copy.
- **The Release page now carries this changelog.** A GitHub Release body used to be one
  static file — an install table and a first-launch note — so every release page read
  identically, and the description of what the release *is* was nowhere on it. GitHub's own
  `--generate-notes` could not fill that gap: it enumerates merged pull requests, and this
  repository pushes commits straight to `master`. The release workflow now builds the notes
  with `scripts/release-notes.mjs`, which joins that install section to the `## [X.Y.Z]`
  section of `CHANGELOG.md` and to its `CHANGELOG-ZH.md` twin, collapsed behind a
  `<details>`, and refuses to publish a version the changelog does not describe. The prose
  is written once, in the file a contributor already has to edit, and the page cannot drift
  away from it. This page was generated that way and rewritten in place; the workflow change
  itself takes effect from the next tag.
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
