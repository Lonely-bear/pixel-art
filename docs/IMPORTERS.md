# Importers

`meta.json` in, whatever the engine reads out. Four engines and a naming validator, all reading
the one contract in [`ASSET-CONTRACT.md`](ASSET-CONTRACT.md). That file says what a field
*means*; this one says what each engine *does with it*, and — more usefully — what each one
loses.

> **Status:** the importers are reachable two ways. They remain library functions in
> `packages/core/src/asset/importers/`, callable from code or a plugin; and they are
> **opt-in outputs of `finalize_document`**, `{type: "engine", engine, path}`, alongside
> `{type: "meta", path}` for the contract itself. There is deliberately no second export tool:
> one `finalize_document` plan is the whole delivery path, and a separate tool would split it.
>
> **Why opt-in rather than automatic.** The target engine is the caller's choice and a tool
> cannot know it — a Godot resource beside every PNG export would be a surprise to everyone
> already using that path and would break the byte-identical expectations its existing outputs
> carry. So a plan that asks for no asset output writes exactly the files it wrote before,
> which `packages/mcp/test/asset-outputs.test.ts` holds as a regression guard.
>
> The naming validator runs on the contract **before** anything is written, and a naming
> **error refuses the write** the way the quality gate refuses: a reserved device name, a
> case-folded path collision or a path Windows rewrites produces files that fail later and
> further from the cause. Warnings are style — a project convention — and are reported in the
> result's `assets[].naming.diagnostics` without blocking.

## The shape every importer has

```ts
function importGodot(meta: unknown): AssetImportResult
```

`meta` is `unknown` on purpose. Each importer runs `validateAssetMeta` and throws
`AssetImportError` — carrying the diagnostics, so a caller can show them without re-running the
validator — rather than emitting an engine file that opens cleanly and is wrong. An importer
handed a contract with four frames and three durations produces a scene that drops a frame, and
the symptom surfaces two systems away from the cause.

`AssetImportResult` is:

| | |
| --- | --- |
| `root` | suggested folder, `<asset.name>/` |
| `files` | `{path, contents, role}[]` — relative, forward slashes, text |
| `warnings` | everything the mapping could not carry, in order, de-duplicated |
| `meta` | the contract as read, for logging the identity |

`warnings` is the field that matters most. S9 of the contract lists the lossy mappings up front;
this is where an importer says *which of them it actually hit on this file*, so a build log
carries the fact instead of a human discovering a stutter. **An importer that loses something
does not stay quiet about it.**

Every output is deterministic: the same contract produces the same bytes. No timestamp, no
`uid://`, no clock-seeded random. A committed engine resource that changes on every export is a
diff nobody can explain.

---

## Godot

`importGodot` → `<name>.tres` (a `SpriteFrames` resource) and `<name>.tscn` (a scene using it).

**Mapping.** `SpriteFrames` takes one `speed` (fps) and one `loop` flag per animation, so
`animations.items[].fps` and `.loop` go across verbatim and the frame dicts stay at
`duration: 1.0`. Each frame points at an `AtlasTexture` sub-resource carrying the region's real
rectangle rather than at a grid cut — S9.1 says regions map to explicit regions, and the reason
is that the packer may have inserted a gap or a border, which S10 says this contract does not
record, so a grid would silently mis-slice.

**Pivot.** `offset = pivot - frames.size / 2`, centre-relative, on the `AnimatedSprite2D` (or
`Sprite2D`). A pivot at the feet is a **positive** Y offset. That sign is the one that surprises
people and it is the opposite of what most people assume.

**Lost:** per-frame timing, and any pass count above 1 (`SpriteFrames` has a loop flag, not a
repeat count). Both warn.

**A still** gets a `Sprite2D`, not an `AnimatedSprite2D` pointing at an empty `SpriteFrames` —
which is a resource Godot rewrites as empty on the next save.

**With no sheet**, the resource references the exported `frame` PNGs by path instead.

*Tests:* `test/asset-importers.test.ts`, `describe('godot importer')` — 8 cases. The sharp ones
are `takes the loop flag verbatim` (a two-shot attack must not loop) and `maps the pivot to a
centre-relative offset`.

---

## Unity

`importUnity` → `<name>.unity-sprite.json` (the description) and `DotloomSpriteImporter.cs` (the
editor script).

**Why a script and not a `.meta` file.** Unity's own sprite importer owns the `.meta`, its ids
are generated, and a hand-written one is rewritten on load. `TextureImporter` is the supported
surface for a pivot and a grid, and the only place to reach it is an editor script. Drop both
files into `Assets/`, run **Assets → Dotloom → Import Sprite Contracts**, and the sprites are
sliced with the right pivot and the animations become playable `AnimationClip`s. An
`AssetPostprocessor` keyed on the description JSON re-runs it when the PNG is reimported.

**Mapping.** `TextureImporter` gets `spriteImportMode`, `pixelsPerUnit`, `filterMode = Point`
and `mipmapEnabled = false`. The atlas path uses `spriteGridSize` from `sheet.columns`/`rows`,
because Unity's slicer is grid-based (S9.2).

**Pivot.** Normalised: `pivot / frames.size`, **and flipped in Y** — Unity's pivot is
bottom-left, the contract's is top-left. `(0.5, 0.5)` is the editor's own default, which is
exactly `pivot.source == "default"`.

**Timing survives here** — the one engine of the four that can hold it. Each frame in
`animations.items[].frames` gets a key at the cumulative sum of *its own* duration, not at
`index / fps`. `AnimationClip.wrapMode` takes `loop`.

**The cross-check.** Unity ignores `sheet.regions`, so the script compares them against what the
grid implies and logs a warning naming both rectangles on a mismatch — a packed sheet with a gap
would otherwise be mis-sliced silently.

*Tests:* `describe('unity importer')` — 8 cases. `keys every animation frame at its own
cumulative time` asserts the non-uniform and uniform cases on both sides of that gate.

---

## Phaser

`importPhaser` → `<name>.phaser.mjs`, plus `<name>-atlas.json` when the sheet needs one.

**The loader decision.** `load.spritesheet(key, url, {frameWidth, frameHeight})` slices by grid
and ignores `sheet.regions` entirely. That is right for a 1:1 sheet that divides evenly, and
wrong in the two cases S9.3 names: a `scale > 1` sheet, and a grid that does not divide evenly.
For those, `load.atlas` with a TexturePacker-hash JSON is emitted instead.

**Atlas rects are sheet pixels and `meta.scale` is `"1"`**, deliberately: Phaser divides rects by
`meta.scale`, so baking the upscale into both would rescale the artwork a second time on load.
A bug that only appears at 2x is exactly the kind this repository gets bitten by.

**Mapping.** `anims.create({key, frames, frameRate, repeat})` takes `animations.items[].frames`
directly — already expanded, so no importer implements reverse or bounce. `repeat` is `-1` for a
loop and `n - 1` for an `n`-pass animation, because **Phaser counts repeats after the first
play**. Both off-by-ones are invisible in the config and obvious in the game.

**Pivot** is carried as `ORIGIN = {x, y}` in 0..1 form for `setOrigin` at spawn time.

**Lost:** per-frame timing — `frameRate` is the only knob. But `frameDurationsMs` is emitted on
every anim and `DURATIONS_MS` at module scope, so a game that needs exact timing can drive
`timeScale` per frame. The warning says so.

*Tests:* `describe('phaser importer')` — 6 cases, including both sides of the atlas decision and
both repeat off-by-ones.

---

## Excalidraw

`importExcalidraw` → `<name>.excalidraw`, an Excalidraw scene.

**What this can honestly be.** Excalidraw has no atlas, no animation and no pivot. S9.4's answer
is the honest one: one frame per element, placed 1:1 at `frames.size`. So the scene is **one
`image` element per frame**, laid out in the sheet's row-major order with a configurable gutter
— which is what an artist opening a spritesheet in Excalidraw actually wants.

Each element's `customData.dotloom` carries what Excalidraw cannot hold: the frame index, its
duration, the sheet cell's rectangle, the content hash, the pivot, and the source path.
`seed` is derived from the content hash mixed with the frame index — Excalidraw derives roughness
from it, so a constant seed makes every frame look identical and a clock-seeded one makes the
file differ on every export.

**Known limitation: the pixels are not embedded.** The contract does not carry them, and
`packages/core` has no filesystem. Each element names the file its pixels belong to; the scene
opens and loads without them, with Excalidraw showing an unloaded placeholder. Fixing this
properly means reading the PNGs, which is a different input than "one `meta.json`".

*Tests:* `describe('excalidraw importer')` — 5 cases.

---

## Per-frame direction (`frames.directions`)

An optional contract block added within `schemaVersion 1`: one entry per frame saying which
way it faces (`N`/`NE`/`E`/`SE`/`S`/`SW`/`W`/`NW`, or `none`) and which animations show it. It
is the block an 8-direction character sheet exists to produce, and it is **optional** — a file
that has never heard of it validates unchanged, and an asset with no direction model produces
byte-identical output to one written before the block existed.

**The honest headline: no engine stores a facing.** Unity's `SpriteRenderer`, Godot's
`SpriteFrames` and Phaser's `Sprite` all store a *flip*, which is a rendering decision rather
than a property of the artwork. So there is nothing to map the direction onto, and the four
importers each put it where their engine actually has somewhere to put it:

| Engine | Where the direction goes | How a game reads it |
| --- | --- | --- |
| **Godot** | `<name>.directions.res`, a `Resource` | `res.get_meta("dotloom_facings")` — a `PackedStringArray` in timeline order, indexed by frame number. A **separate file** because `SpriteFrames`' frame entries are `{duration, texture}` and there is nowhere else in that resource to put a label. |
| **Unity** | `frameFacings[]` on the description JSON, `facings[]` per clip | Read by the C# side. The `Description` and `Clip` classes declare both fields, because `JsonUtility` silently drops a key the class does not declare. |
| **Phaser** | `FRAME_FACINGS` at module scope, `frameFacings[]` per anim, `facing` on each `createAnimations.frames` entry | Plain JavaScript, so a game picks `walk_s` from a velocity with one array read. `frameFacings` is in **playback** order, matching the anim's `frames`. |
| **Excalidraw** | `customData.dotloom.facing` and `.animations` | The one place a third-party fact can live in an Excalidraw scene, and genuinely useful: the scene is already one frame per element in timeline order. |

**None of these emits a warning**, which is the distinction from the other four losses in this
document. Nothing is dropped and nothing has to be recomputed by the consumer. What they share
is that a game has to *ask* for the direction rather than read it off the sprite — a property
of the engines, not of the contract, and stated in S9.0 of `ASSET-CONTRACT.md`.

**Omitted entirely when the contract has no directions.** Not `null`-filled: a module
exporting `FRAME_FACINGS = [null, null, ...]` is a file claiming to know something nobody
recorded, and the absence is a cleaner signal than an array of nothing.

*Tests:* `test/asset-directions.test.ts` — the round trip into all four importers, plus the
paired negative that a no-direction contract produces output mentioning no direction at all.

---

## Naming validator (T-055)

`validateAssetNaming(meta, convention?)` → `{ok, diagnostics}`. Same `unknown` input and same
refusal as the importers: a naming check that ran on a contract whose `asset.name` it could not
read would report zero findings, and zero findings reads as "the names are fine".

### The rules

Style rules are **`warning`** — a project with its own convention overrides `NamingConvention`
rather than arguing with the default. A naming validator that blocks a build over camelCase gets
switched off, and then nothing is checked.

| Rule | Default | Why |
| --- | --- | --- |
| `asset.name` is lower kebab-case | on | All four importers write this name as a filename, a Godot node path and a sheet key. Kebab-case is the form all four accept unmodified. |
| length ceiling | 64 | The contract allows 255. 64 is where the name plus `-contact-sheet.png` plus an engine suffix stops fitting everywhere. |
| animation names are lower snake_case | on | Game code addresses animations as identifiers, and the Unity importer writes the name as a `.anim` filename. Snake_case is legal bare in GDScript, C#, JS and Python. |
| animation names unique | **error** | Already an upstream contract error; a naming check that missed a genuine ambiguity would be worse than none. |
| `outputs[].path` / `sheet.image` basename starts with the asset name | on | A bundle is one asset. A file not named after it is a stray or an asset this contract does not describe. A *prefix* rule, not equality — real bundles hold sources, frames, GIFs and contact sheets. |
| reserved Windows device name (the **stem**, any segment) | **error** | `nul.png` and `aux/hero.png` both fail. A bundle that works on the artist's Mac and fails in CI is the defect. |
| segment ends in a space or a dot | **error** | Windows strips both, so the file in the repo and the file in the build are different files with the same name. |
| paths unique after folding case | **error** | Two files on Linux, one on Windows. An importer cache keyed on the path disagrees between a developer's machine and a build server. |

Codes are a closed set, exported as `ASSET_NAMING_CODES`, so a consumer switches on `code` rather
than parsing prose — the same contract the diagnostic validator offers.

**One rule was deliberately not implemented.** Absolute paths, backslashes and `..` segments are
already `error`s in `validateAssetMeta` (S8), and `readAssetMeta` throws before any rule here
runs. Re-checking them would be a rule that *can never fire*, which is the exact failure mode
this repository has paid for five times. `test/asset-naming.test.ts` asserts that those inputs
throw, so the boundary is stated rather than assumed.

*Tests:* `test/asset-naming.test.ts` — 35 cases, each rule paired with a must-accept neighbour.

---

## Known limitations

- **The engine files are not read back from the sheet.** An importer can only describe the
  contract it was handed; whether the PNG on disk is the PNG in `sheet.regions` is a question
  only the filesystem can answer.
- **`license` is not a `finalize_document` parameter.** The contract supports the block and the
  generator never invents it, but the tool surface leaves it out (~600 bytes of every request in
  every session) rather than advertise a declaration the document model cannot hold. Add the
  block to the written file, or call `buildAssetMeta` directly.
- **No CLI surface** for the importers — `finalize_document` is the MCP path, and the CLI has no
  asset-output equivalent yet.
- **Excalidraw does not embed pixels** (above).
- **Unity is a script plus a JSON description**, not a native `.meta`/`.asset`. That is what works
  in Unity; a pipeline wanting committed binary Unity assets needs something this does not do.
- **Godot loses per-frame timing and pass counts**; **Phaser loses per-frame timing**. Both warn,
  both carry the original numbers in the output where the format allows it.
- **No tilemap or tileset importers.** `kind` is a closed enum at `schemaVersion 1` and the
  generator refuses a document carrying a tileset rather than mis-describing it.
- **Nothing reads the sheet PNG.** An importer that wanted to verify the sheet actually matches
  `sheet.regions` could not: `packages/core` has no filesystem, and re-deriving the image would
  mean re-implementing the packer.
- **Direction is data, not behaviour.** `frames.directions` reaches all four importers, but no
  engine *acts* on it: no importer flips a sprite, and none of them can. Turning a facing into a
  `flipX`, a node flip or a `setFlipX` is the game's decision, because which way "east" looks on
  screen depends on the camera. An importer that guessed would be wrong in a way nobody could
  trace, which is the same reason `license` is never invented.
