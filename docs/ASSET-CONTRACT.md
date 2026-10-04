# The asset contract - `meta.json`

> **Status:** normative specification, `schemaVersion 1`. This file, and the code in
> `packages/core/src/asset/`, are one deliverable. Where they disagree, this file wins and
> the code is wrong; `packages/core/test/asset-contract.test.ts` parses the tables below and
> fails the build when it finds a field with no row or a row with no field, so they cannot
> drift apart silently.
>
> **This is a contract for one asset, not a bundle inventory.** `finalize_document`'s export
> manifest answers "what did this run write, where, and how big was it" - that is bookkeeping
> about one execution. This file answers "what *is* this asset" and is meant to outlive the
> run, the machine and the person who made it.
>
> **How it gets written.** `{type: "meta", path}` in `finalize_document`'s `outputs`, or
> `{type: "engine", engine, path}` to write it together with one engine's files; or
> `pixel contract <file.pixel> --out <meta.json> [--engine <name>]` at a shell. All three are
> **opt-in**: this file is not produced beside every export, because a target engine is the
> caller's choice and a tool cannot know it, and because writing engine files into everyone's
> existing bundles would break the byte-identical expectations those outputs already carry. See
> `IMPORTERS.md`. `license` is the one block the MCP tool surface does not carry — it is a
> declaration the document model cannot hold, and it is never invented. The CLI carries it
> as `--license <spdx>`, because a flag costs nothing per request and a shell caller is the one
> place a licence is plausibly being declared; it is still never inferred from the document.

A PNG dropped into a Godot project, a Unity package or a Phaser build is a file with no idea
what frame it is. Every serious engine needs the same six facts - how big a frame is, how
many there are, which frames form which animation, how long each is held, whether it loops,
and where the sprite pivots - and every ecosystem spells them differently. `meta.json` is
one description of those facts that all five of them can read.

Consumers of this specification:

| Task | Reads | Needs most from |
| --- | --- | --- |
| T-051 Godot importer | 5, 6, 7, 9.1 | per-frame timing, loop, pivot |
| T-052 Unity importer | 5, 6, 7, 9.2 | pivot, sheet geometry |
| T-053 Phaser importer | 5, 6, 7, 9.3 | frame size, animation frame lists |
| T-054 Excalidraw importer | 5, 9.4 | frame size, one frame per cell |
| T-055 naming validator | 5, 8 | `asset.name`, `outputs[].role`, paths |

Section numbers are written as "S5" rather than a section symbol so that every character in
this document is ASCII and a copy through a terminal or a legacy encoding cannot corrupt it.

---

## 1. Scope

**In scope.** A single sprite: one canvas size shared by every frame, a timeline of
per-frame durations, animation tags with a playback direction and a repeat count, a palette,
an optional spritesheet, a pivot, optional licensing, and an inventory of the other files in
the bundle.

**Not in scope at `schemaVersion 1`.** Tilesets, tilemaps, Tiled object layers and
nine-slice borders. The generator **refuses** a document carrying any of them rather than
writing a `kind: "sprite"` file for it. See S10.

---

## 2. The file

- **Name:** `meta.json`.
- **Encoding:** UTF-8, no BOM.
- **Serialisation:** two-space indented JSON with a trailing newline. Key order is the order
  in S5, and it is part of the contract - two files describing the same asset are expected
  to be byte-identical, which is only checkable if the order is fixed.
- **Location:** beside the files it describes. Every path inside it is relative to the folder
  holding `meta.json`, and uses forward slashes on every platform.
- **One file per asset.** A document with a tileset and a sprite needs two files, once the
  tileset contract exists.

```jsonc
// hero-idle.meta.json - the minimum a still sprite looks like
{
  "format": "dotloom-mcp/asset-meta",
  "schemaVersion": 1,
  "kind": "sprite",
  "asset": { "name": "hero-idle", "contentHash": "sha256:..." },
  "frames": {
    "count": 1,
    "size": { "width": 32, "height": 32 },
    "durationsMs": [100],
    "totalMs": 100,
    "fps": 10
  },
  "pivot": { "x": 16, "y": 16, "source": "default" },
  "palette": { "name": "DawnBringer 16", "locked": false, "colors": ["#140c1c", "..."] }
}
```

---

## 3. Versioning and compatibility

`schemaVersion` is one integer. Two rules, and the second one is the one that matters:

1. **A breaking change bumps it.** Removing a field, renaming one, narrowing a type,
   changing a unit, or changing what a value means.
2. **Adding a field does not.** Within one major version the contract is additive only.

**Readers must ignore fields they do not recognise.** A spec that grows must not break every
consumer that shipped before it grew, and the only way to guarantee that is to require
toleration. `schemaVersion` newer than the reader supports is therefore **not** an error:
the reader reads the fields it knows, skips the rest, and says so.

**Writers must not depend on a reader understanding a new field.** Every field added after
`1.0` is optional and carries a documented default, so a file written by a new generator and
read by an old reader loses the new field and nothing else.

**Deprecation.** A field is marked deprecated in S5 and kept emitting for the rest of the
major version. It is removed, and the major version bumped, only when no reader can still be
relying on it. A deprecated field is never silently repurposed - a field whose meaning
changed is a removal plus an addition, because a reader cannot tell the difference.

**Machine-readable policy.** The validator reports a newer `schemaVersion` as
`schema-version-unsupported` (advisory) and an unrecognised key as `unknown-field`
(advisory). Everything else is an error. Note the consequence, which is the sharpest part of
the policy: a **misspelled** field arrives as *two* findings - `unknown-field` advisory for
the key nobody knows, and `missing-field` error for the required key it should have been -
so tolerance for the future does not become tolerance for typos.

---

## 4. Identity

### 4.1 The content hash, and what identifies an asset across engines

**A content hash, not an id.** `asset.contentHash` is `sha256:` followed by 64 lowercase hex
digits.

The document model gives every sprite, layer, frame and tag an id, and those ids come from
the clock plus real entropy (`packages/core/src/ids.ts`) - the right choice for a live
editor and the wrong one for an asset identity. Two people who draw the same four-frame
sprite must get the same identity, on two machines, in two sessions; otherwise every
importer cache in every engine misses on first contact, and a cache key that differs between
a developer's machine and a build server is not a cache key. So the identity is a digest of
the asset itself, and no document id is inside it.

`asset.name` is **not** the identity either. It is a lookup key - what a human calls the
sprite, what T-055 validates, what an importer registers it under - and it is excluded from
the hash so that renaming an asset does not invalidate its cache.

### 4.2 What is inside the hash, and what is outside

Inside, because these *are* the asset:

| | |
| --- | --- |
| canvas width, height | the asset's resolution |
| per frame, in timeline order | `durationMs`, then the composited RGBA bytes |
| palette swatches | in palette-index order, `r`, `g`, `b`, `a` each |
| animation tags | name, `from`, `to`, direction, `repeat` |

Outside, deliberately:

| | Why |
| --- | --- |
| `asset.name` | renaming must not invalidate a cache |
| every document id | clock + entropy; see above |
| layer names, order, opacity, blend mode | two layers that composite identically are the same artwork |
| the rig | authoring structure; it changes no pixel |
| `pivot`, `palette.locked`, `license` | declarations about the asset, not the asset |
| `schemaVersion` | a spec revision that documents a new field must not move every identity in every project |
| file paths, sheet geometry | one asset can be shipped as a sheet, as PNGs, or at 3x |

A document that differs only in things outside that table serialises to **the same bytes**.
That is the intended meaning of "they genuinely are the same asset".

### 4.3 The preimage, byte for byte

The hash is a SHA-256 over this byte sequence. It is published so that a second
implementation in another language agrees with this one; the digest's value *is* that two
independent implementations agree.

```
u32   byte length of the marker string
bytes the marker, ASCII: "dotloom-mcp/asset-meta"
u8    digest version, currently 1
u32   canvas width
u32   canvas height
u32   frame count
repeat frame count times, in timeline order:
  u32   durationMs
  u32   byte length of this frame's pixels   (== width * height * 4)
  bytes composited RGBA, row-major, y downward
u32   palette swatch count
repeat once per swatch, in index order:
  u8 r, u8 g, u8 b, u8 a
u32   animation tag count
repeat once per tag, in document order:
  u32   byte length of the name
  bytes name, UTF-8
  u32   from
  u32   to
  u8    direction: forward = 0, reverse = 1, pingpong = 2
  u32   repeat
```

Every integer is **unsigned little-endian**. Every variable-length field is
**length-prefixed**, which is not decoration: without the prefixes a tag named `ab` next to
one named `c` would hash identically to a tag named `a` next to one named `bc`, and the
digest would silently stop being a function of the asset.

The composited bytes are the frame flattened through layer order, opacity, blend mode and
visibility - the same composite every other renderer in this repository produces. A digest
that hashed the raw cels instead would change whenever an artist reorders layers without
changing the picture.

UTF-8 encoding replaces unpaired surrogates with U+FFFD, matching mainstream encoders.

The digest version is a **separate** integer from `schemaVersion` on purpose. It only moves
when the bytes above change, so documenting a new field does not invalidate any cache.

### 4.4 What the hash is not

It is a **cache key and a change detector**, not an authenticity claim. No importer
recomputes it - none of them can, since recomputing means re-compositing every frame and
rebuilding the preimage above. Do not use it to decide whether a file was tampered with. For
that, hash the exported bytes (which is what `finalize_document`'s manifest already does)
and keep the signature outside this file.

---

## 5. Field reference

**Required** means the reader cannot work without it, and is exactly `yes` or `no` - a
derived field is marked by its description, not by its requiredness, because "an importer may
recompute this" and "an importer may omit this" are two different statements. S7 lists what
is derived.

The rule this table exists to enforce: **nothing that can be read off the pixels is
required.** See S7.

| Field | Type | Required | Unit | Default | What it is for |
| --- | --- | --- | --- | --- | --- |
| `format` | string | yes | - | - | Always `dotloom-mcp/asset-meta`. Check it first: it says the file is an asset contract at all, rather than an export manifest, an Aseprite sheet JSON or a level file in the same folder. |
| `schemaVersion` | integer | yes | - | - | Contract revision, currently `1`. Compare against the reader's ceiling before trusting anything else; see S3. |
| `kind` | enum | yes | - | - | What this file describes. Only `sprite` exists at `schemaVersion 1`. Closed on purpose: a reader meeting a value it does not know has been handed a document it cannot serve, and must say so rather than guess. |
| `asset` | object | yes | - | - | Identity block. |
| `asset.name` | string | yes | - | sprite name | The asset's own name; what a human calls it and what an importer registers it under. A lookup key, **not** the identity (S4.1). 1-255 characters; the ceiling is a path limit, not a taste. |
| `asset.contentHash` | string | yes | - | - | `sha256:` + 64 lowercase hex digits. Identity and change detection (S4). |
| `frames` | object | yes | - | - | The timeline. |
| `frames.count` | integer | yes | frames | - | Number of frames, and therefore cells in a sheet. Must equal `durationsMs.length`. |
| `frames.size` | object | yes | pixels | - | The size of **one frame**, in canvas pixels. Also the source canvas size: every frame shares one canvas, so there is no per-frame crop to describe. Engines slice on this, not on the sheet size. |
| `frames.size.width` | integer | yes | pixels | - | Frame width. |
| `frames.size.height` | integer | yes | pixels | - | Frame height. |
| `frames.durationsMs` | integer[] | yes | milliseconds | - | How long each frame is held, in timeline order (index 0 first). **The field no engine can infer from a PNG, and the reason this file exists.** Positional rather than an array of objects, so a four-frame sprite costs four numbers instead of four JSON objects. |
| `frames.totalMs` | integer | yes | milliseconds | - | Sum of `durationsMs`. Derived: precomputed so a player needs no loop to find the cycle length. |
| `frames.fps` | number | yes | frames/second | - | `1000 * count / totalMs`, rounded to three decimals. Derived: a convenience for engines that take one number; `durationsMs` is authoritative, because 100/100/200 ms has no single true fps and this is the least-bad one. |
| `frames.directions` | object[] | no | - | - | Which way each frame faces, and which animations show it. One entry per frame, in timeline order. **Optional, and additive within `schemaVersion 1`** per S3: a file written before this field existed still validates, and a reader that does not know it ignores it. Absent means the asset carries no per-frame direction, which is a legitimate state for a prop, an effect or a tile; it never means "faces south". |
| `frames.directions[]` | object | yes | - | - | One frame's facing. Listed for completeness; it is the element shape of the array above. |
| `frames.directions[].index` | integer | yes | frame index | - | Derived: which timeline frame this entry describes. Always equal to its own position in the array. |
| `frames.directions[].facing` | enum | yes | - | `none` | `N`, `NE`, `E`, `SE`, `S`, `SW`, `W`, `NW` or `none`. A **closed** enum for the reason `kind` is: a direction a reader does not recognise is a document it cannot serve. `none` means *this frame* has no stated facing (a prop, a still), which is different from the block being absent. Compass abbreviations rather than degrees because every engine wants a cardinal direction: Unity's `flipX` plus a Y sign, Godot's node flip and Phaser's `setFlipX` all take a direction, and none of them takes radians. |
| `frames.directions[].animations` | string[] | no | - | - | Names of the animations that show this frame, in `animations.items` order. Derived from `animations.items[].frames`, and emitted so an importer never has to **invert** the animation lists to answer "which way is frame 12 looking" — the one question an 8-direction character sheet exists to answer. Omitted when no animation shows the frame. |
| `animations` | object | no | - | - | Playback. Absent for a single-frame still, which is not a failure: a still has no animation, and saying so differs from saying it has an empty one. |
| `animations.default` | string | yes | - | first item's name | The animation a player should play when nothing is asked for. Required inside `animations` because an engine that guesses picks the first one, and "the first one" is not a decision anyone made. |
| `animations.items` | object[] | yes | - | - | Every animation, in document order. At least one. |
| `animations.items[]` | object | yes | - | - | One animation. Listed for completeness; it is the element shape of the array above. |
| `animations.items[].name` | string | yes | - | tag name | The string game code calls. Inside the hash (S4.2), because renaming an animation is a code-visible change. |
| `animations.items[].from` | integer | yes | frame index | - | First frame of the range, **inclusive**, 0-based. |
| `animations.items[].to` | integer | yes | frame index | - | Last frame of the range, **inclusive**, 0-based. |
| `animations.items[].direction` | enum | yes | - | `forward` | `forward`, `reverse` or `pingpong`. Kept for engines that can express it natively; `frames` is the authority, because not all of them can. |
| `animations.items[].repeat` | integer | yes | passes | - | How many times the animation plays; `0` means forever. A **pass count**, not a total frame count - `frames` holds one pass and the engine repeats it. |
| `animations.items[].loop` | boolean | yes | - | `repeat === 0` | Whether playback loops forever. Exactly equivalent to `repeat === 0`, and stated separately because "does this loop" is the first question every engine asks, and deriving it from a sentinel down an export chain is how a two-shot attack ends up looping forever. |
| `animations.items[].frames` | integer[] | yes | frame index | - | The frames to play, **already expanded**, in order, one pass, repeats not included. A pingpong is written out as its real playback order so an importer never implements reverse or bounce - which is where naive importers get it wrong. |
| `animations.items[].durationMs` | integer | yes | milliseconds | - | Length of **one** pass. Derived: multiply by `repeat` for a non-looping animation. |
| `animations.items[].fps` | number | yes | frames/second | - | Derived: mean frame rate of this animation alone, same rounding as `frames.fps`. |
| `sheet` | object | no | - | - | The packed spritesheet. Absent when the export wrote individual PNGs, which is legitimate: this describes a sheet and there is none. |
| `sheet.image` | string | yes | path | - | Path to the sheet PNG, relative to this file, forward slashes. Relative is a hard rule - see S5.1. |
| `sheet.columns` | integer | yes | cells | - | Cells per row. With `regions` it fixes the arrangement. `layout`, `padding` and `margin` are deliberately absent: the packing result does not carry them, and re-deriving them here would create a second geometry authority to keep in step with the first. |
| `sheet.rows` | integer | yes | rows | - | Rows of cells. |
| `sheet.scale` | integer | yes | factor | - | Derived: the integer upscale the sheet was written at, relative to `frames.size`; `1` for 1:1. Present because a 2x sheet and a 32 px sheet are the same artwork at different sampling rates, and an importer that filters an upscaled sheet correctly has to be told it was upscaled. |
| `sheet.size` | object | yes | pixels | - | The sheet image's own dimensions. Authoritative rather than derived, because the gap between cells and the border around the sheet are not recorded here and are exactly what a recomputation would need. Differs from `frames.size` whenever `scale` is above 1. |
| `sheet.size.width` | integer | yes | pixels | - | Sheet width. |
| `sheet.size.height` | integer | yes | pixels | - | Sheet height. |
| `sheet.regions` | object[] | yes | - | - | One rectangle per frame, in timeline order. **Authoritative: read these, do not recompute them from `columns`**, because the packer may have inserted a gap or a border that this contract does not record. What is verified is that every cell is `frames.size * scale`, sits inside the sheet, and appears in the row-major order `columns`/`rows` implies. |
| `sheet.regions[]` | object | yes | - | - | One cell. Listed for completeness; it is the element shape of the array above. |
| `sheet.regions[].index` | integer | yes | frame index | - | Which timeline frame this cell holds. Must equal its position in the array. |
| `sheet.regions[].x` | integer | yes | sheet pixels | - | Left edge of the cell in the sheet. |
| `sheet.regions[].y` | integer | yes | sheet pixels | - | Top edge of the cell in the sheet. |
| `sheet.regions[].width` | integer | yes | sheet pixels | - | Cell width; equals `frames.size.width * scale`. |
| `sheet.regions[].height` | integer | yes | sheet pixels | - | Cell height; equals `frames.size.height * scale`. |
| `pivot` | object | yes | - | canvas centre | The sprite's rotation/scaling origin. Always present: every engine needs one, and an importer that has to guess gets a character sprite hovering half a body above the floor. |
| `pivot.x` | number | yes | canvas pixels | `frames.size.width / 2` | From the left edge. May be fractional (odd canvas) and may sit on the right edge. |
| `pivot.y` | number | yes | canvas pixels | `frames.size.height / 2` | From the top edge. May be fractional and may sit on the bottom edge. |
| `pivot.source` | enum | yes | - | `default` | `default` means nobody chose this and it is the documented fallback; `rig-part` means it came from a rig part. See S7.1. |
| `palette` | object | no | - | - | The palette the artwork was drawn against. Not derivable from the PNG: the pixels carry the colours but not their indices, their order or their names, and a ramp cannot be rebuilt from a flat swatch list. Absent means "this asset carries no palette constraint", which is a real state for full-RGB art; it never means "16 colours". |
| `palette.name` | string | yes | - | - | Palette name, for a tool that shows swatches. |
| `palette.locked` | boolean | yes | - | `false` | Whether the artwork was snapped to this palette. Advisory - it describes how the art was made, is **not** covered by the hash (S4.2), and is a hint about recolouring, not a constraint to enforce. |
| `palette.colors` | string[] | yes | hex | - | Swatches in **palette-index order**, the order the artwork addresses them in. `#rrggbb`, or `#rrggbbaa` when a swatch is not fully opaque. At least one. Index order is the contract; sorted order would be a different asset. |
| `palette.roles` | object | no | - | - | Semantic role by **decimal palette index**, e.g. `{"3": "skin"}`. Present only when the document has roles. Written sorted by numeric index. |
| `license` | object | no | - | - | Licensing. Optional and **never invented**: absent means "not specified", which is not the same as public domain and must not be treated as permission. The document model has no licence field, so this is the one block the caller supplies. |
| `license.spdx` | string | yes | - | - | SPDX identifier, e.g. `CC0-1.0`. Required when `license` is present, because a licence that cannot be branched on by machine is a comment. |
| `license.name` | string | no | - | - | Human-readable licence name, when it differs from the SPDX id. |
| `license.url` | string | no | - | - | Where the full text lives, if not the SPDX id's canonical page. |
| `license.attribution` | string | no | - | - | Credit line the game must display, when the licence requires one. |
| `outputs` | object[] | no | - | - | The rest of the bundle. Absent when the bundle is a sheet and nothing else. |
| `outputs[]` | object | yes | - | - | One file. Listed for completeness; it is the element shape of the array above. |
| `outputs[].role` | enum | yes | - | - | `source`, `frame`, `sheet-json`, `gif` or `contact-sheet`. `sheet` is **reserved** and rejected - the sheet path is `sheet.image`, and listing it twice gives one path two chances to disagree. |
| `outputs[].path` | string | yes | path | - | Relative to this file, forward slashes. See S5.1. |

### 5.1 Paths inside a bundle

Every path field - `sheet.image` and every `outputs[].path` - obeys the same rule:

- **Relative** to the folder holding `meta.json`. An absolute path, including a Windows
  drive letter, is an error (`path-absolute`). The file has to survive being moved into a
  game project, and an absolute path from the artist's machine is the one thing that never
  survives that.
- **No `..` segment, and forward slashes only.** A path that points outside the bundle, or
  that uses a Windows separator, is an error (`path-escapes-bundle`).
- **Unique** across `outputs` (`path-duplicate`).

---

## 6. Timing, order and loop

The contract expresses three things, and it expresses them in a way that survives being
translated into an engine that supports less.

**Per-frame timing is the point.** `frames.durationsMs` is positional and authoritative.
`frames.fps` and `animations.items[].fps` are derived conveniences for engines that take a
single number, and a reader that has both must prefer `durationsMs`.

**Playback order is pre-expanded.** `animations.items[].frames` is the literal list of frame
indices to show, in order. `from`, `to` and `direction` are also there, and are verified
against it, but they exist for tooling that wants to show a range in a UI - not for playback.
A pingpong over frames 0 to 2 is `[0, 1, 2, 1]`: the return leg omits **both** end frames,
because they have already played once this cycle and repeating them is what makes a bounce
visibly hitch. A reverse over 0 to 2 is `[2, 1, 0]`.

**Loop is a boolean, and it is derived from a sentinel.** `loop === (repeat === 0)`, and the
validator rejects any file where the two disagree (`animation-loop-mismatch`). `repeat` is a
**pass count**: `durationMs` and `fps` always describe one pass, so a three-shot attack is
`repeat: 1` and a held pose shown for a second is `repeat: 1, durationMs: 1000`, not
`durationMs: 1000, repeat: 100`.

| `repeat` | `loop` | Meaning |
| --- | --- | --- |
| `0` | `true` | Loop forever. |
| `1` | `false` | Play once and hold the last frame. |
| `n > 1` | `false` | Play `n` times and hold the last frame. |

---

## 7. Required versus derived

**The rule: nothing that can be read off the pixels is required.**

A field that is derivable must not be a required input, or the contract drifts from the
artwork the moment someone hand-edits a file. So:

- **Required** is what the artwork *cannot* tell you: the timing (`frames.durationsMs`) and
  the identity (`asset.contentHash`), the name, the frame size (a sheet's size says nothing
  about a cell's), and the pivot, because an engine needs an origin and a guess is a bug
  waiting to happen.
- **Derived** fields are still emitted and still verified. The complete list is
  `frames.totalMs`, `frames.fps`, `animations.items[].durationMs`,
  `animations.items[].fps`, `sheet.scale`, the per-cell identity of `sheet.regions[]`
  (`index`, `width`, `height`), and the per-frame identity of `frames.directions[]`
  (`index`) together with its `animations` list: every one of them is recomputable from the
  rest of the file, so the validator recomputes each and refuses on a disagreement, with
  `frame-total-mismatch`, `fps-mismatch`, `animation-duration-mismatch`,
  `sheet-region-count-mismatch` and `sheet-region-size-mismatch`.

`frames.size`, `sheet.columns`, `sheet.rows`, `sheet.size` and the position fields of
`sheet.regions[]` are the **authoritative** statements of geometry rather than derived ones,
and there is a reason for each: the canvas size appears nowhere else in the contract, and the
packer's gap and border - the two parameters any positional recomputation would need - are
deliberately not recorded (S10). A reader that wants to place cells should read
`sheet.regions[]`; a reader that wants to know it is looking at a consistent file can rely on
the row-major and inside-the-sheet checks in S8.

That still gives an importer a choice: read the derived fields and be told if they are stale,
or recompute them and ignore the file's copy. Both are safe, and the second does not need the
file to have been written by this generator.

### 7.1 Why `pivot` is always present, and what `pivot.source` is for

`pivot` is emitted even when nobody chose one, because every engine needs an origin and an
importer that guesses gets it wrong. What it must not do is *claim* the guess is a decision,
so `pivot.source` carries the honesty:

- `default` - the canvas centre. Validated to be exactly that, so a hand-edited file cannot
  present a chosen pivot as a fallback.
- `rig-part` - taken from the document's rig, when the rig has **exactly one** part. A rig
  with one part has nothing to parent and nothing else to hang an anchor off, so its pivot
  is unambiguous. Two parts means the rig is a skeleton and the sprite's own origin is
  genuinely undecided, so `default` applies.

The units are **canvas pixels**, matching `RigPart.pivot` in the document model. S9 gives
the conversion each engine needs.

---

## 8. Diagnostic codes

A reader that has to serve five consumers reports findings, not a boolean, because a missing
field, a field from the future and a sheet whose regions no longer match are three different
responses. Every finding is `{ code, severity, path, message }`: `code` and `path` are the
API, `message` is for a human and must not be parsed. `path` is dotted
(`animations.items[2].name`), empty for the root.

Severity is the whole of S3: `advisory` means "normal operation across a version boundary",
`error` means "this file is wrong".

| Code | Severity | What it means |
| --- | --- | --- |
| `not-json-object` | error | The root is not a JSON object. Nothing else can be said about the file. |
| `missing-field` | error | A required field is absent. |
| `invalid-type` | error | A field is present but the wrong JSON type. |
| `out-of-range` | error | A field is the right type but outside its permitted range. |
| `invalid-value` | error | A field is the right type but not a permitted value: bad enum member, a number that is not an integer where an integer is required, malformed string. |
| `schema-version-unsupported` | advisory | `schemaVersion` is newer than this reader understands. Read the fields you know. |
| `unknown-field` | advisory | A field this reader does not recognise. A newer writer is legal; check for a matching `missing-field` before believing it is harmless. |
| `content-hash-malformed` | error | `asset.contentHash` is not `sha256:` plus 64 lowercase hex digits. |
| `frame-count-mismatch` | error | `frames.durationsMs.length` is not `frames.count`. |
| `frame-total-mismatch` | error | `frames.totalMs` is not the sum of `frames.durationsMs`. |
| `fps-mismatch` | error | `frames.fps` is not the documented mean of the durations. |
| `sheet-region-size-mismatch` | error | A sheet cell is not `frames.size * sheet.scale`. |
| `sheet-region-mismatch` | error | A sheet cell runs past the sheet, or the cells are not in the row-major order `columns` implies. |
| `sheet-region-count-mismatch` | error | `sheet.regions` does not have one entry per frame, or its entries are not in timeline order. |
| `sheet-size-mismatch` | error | `sheet.size` is too small for the cells it is supposed to contain. |
| `animation-frame-out-of-bounds` | error | An animation names a frame the timeline does not have. |
| `animation-order-mismatch` | error | `frames` is not the playback order `from`/`to`/`direction` imply. |
| `animation-loop-mismatch` | error | `loop` disagrees with `repeat === 0`. |
| `animation-duration-mismatch` | error | `durationMs` is not the sum of the durations of the frames it lists. |
| `duplicate-animation-name` | error | Two animations share a name, so game code cannot address them apart. |
| `unknown-default-animation` | error | `animations.default` names an animation that is not in `items`. |
| `pivot-not-at-default` | error | `pivot.source` is `default` but the pivot is not the canvas centre. |
| `pivot-out-of-bounds` | error | The pivot is outside the canvas rectangle. A pivot on an edge is fine. |
| `palette-role-key-invalid` | error | A `palette.roles` key is not a decimal integer. |
| `palette-index-out-of-range` | error | A `palette.roles` key names an index that is not in `palette.colors`. |
| `path-absolute` | error | A path field is absolute, so the bundle cannot be moved (S5.1). |
| `path-escapes-bundle` | error | A path field is not portable: it contains a `..` segment or a backslash instead of a forward slash. |
| `path-duplicate` | error | Two `outputs` entries name the same file. |
| `reserved-output-role` | error | An `outputs` entry uses the reserved `sheet` role, which duplicates `sheet.image`. |

Findings are sorted by `path` then `code`, with plain byte comparison rather than
locale-sensitive collation, so two runs over one file produce the same list.

---

## 9. Engine notes

Lossy mappings, stated up front, because an importer that discovers them halfway through is
an importer that ships a subtly wrong animation.

### 9.0 Direction, and what each engine does with `frames.directions`

A per-frame facing is the one fact that has **no native representation in any of the four
engines**. None of them stores "this sprite looks south" anywhere; they all store a flip, and
the flip is a rendering decision rather than a property of the artwork. So the mapping is not
"export the direction" but "carry it somewhere the game's own code can read it", and each
importer picks the place its engine actually has:

| Engine | Where it goes | Why there |
| --- | --- | --- |
| Godot | `<name>.directions.res`, a `Resource` with `metadata/dotloom_facings` | `SpriteFrames`' frame entries are `{duration, texture}` and nothing else — there is no slot to put a label. A sibling resource read by `res.get_meta("dotloom_facings")` is the only place it fits. |
| Unity | `frameFacings[]` on the description, and `facings[]` per clip | `JsonUtility` reads it, so the C# side can branch on it; Unity itself stores no direction. |
| Phaser | `FRAME_FACINGS` at module scope, `frameFacings[]` per anim, `facing` per frame entry | Plain JavaScript, so it is directly readable by the game that picks a walk cycle from a velocity. |
| Excalidraw | `customData.dotloom.facing` | The only place a third-party fact can live in an Excalidraw scene. |

None of these is a **lossy** mapping in the S9 sense — nothing is dropped, and nothing has
to be recomputed by the consumer — so none of them emits a warning. What they all share is
that a game has to *ask* for the direction rather than read it off the sprite. That is a
property of the engines, not of this contract, and it is the one line in this document a
reader of any of the four should know before planning an 8-direction character.

### 9.1 Godot

- `SpriteSheet` takes a cell size and a per-animation `SpriteFrames` with **one** fps and a
  loop flag, so per-frame durations cannot be represented exactly. Take
  `animations.items[].fps`, take `loop` verbatim, and accept that a 100/100/200 ms timeline
  plays as 250/250/250 ms. This is a limitation of `AnimatedSprite2D`, not of the contract:
  a Godot importer that needs exact timing must drive `SpriteFrames` from
  `frames.durationsMs` in script rather than through the animation player.
- `Sprite2D.offset` is **centre-relative in pixels**:
  `offset = (pivot.x - frames.size.width / 2, pivot.y - frames.size.height / 2)`. Note the
  sign convention - Godot's offset moves the drawn sprite, so a pivot at the feet is a
  *positive* Y offset.
- `sheet.regions` maps to an atlas texture with explicit regions rather than a grid cut, or to
  a grid cut when `columns`/`rows` are the whole story.
- Per-frame timing and loop both exist in the `SpriteFrames` resource, so nothing is lost
  except the *rate*.

### 9.2 Unity

- `Sprite.pivot` is a **normalised** point: `pivot / frames.size`. A sprite editor's default
  is `(0.5, 0.5)`, which is exactly what `pivot.source == "default"` means.
- Unity's `SpriteAtlas` slicer is grid-based, so `columns`/`rows` are what a Unity importer
  actually needs; `sheet.regions` is the cross-check.
- Unity has no per-frame timing inside a single `AnimationClip` unless the clip is authored
  with keyframes at the right times, which is the correct answer: build the clip from
  `animations.items[].frames` with each frame's keyframe at `cumulative duration`.
- `AnimationClip.wrapMode` takes `loop` directly.

### 9.3 Phaser

- `load.spritesheet(key, url, { frameWidth, frameHeight })` takes `frames.size` and ignores
  `sheet.regions` entirely. A grid that does not divide evenly, or a sheet with `scale > 1`,
  needs a texture-atlas JSON instead, which is `outputs[].role == "sheet-json"`.
- `anims.create({ key, frames, frameRate, repeat })` takes a **frame list**, which is exactly
  `animations.items[].frames`, and `repeat: -1` for `loop`, `repeat: n - 1` for a pass count
  of `n`, since Phaser counts repeats *after* the first play.
- `frameRate` is `animations.items[].fps`; Phaser has no per-frame timing.

### 9.4 Excalidraw

- Excalidraw has no animation and no atlas. The honest mapping is one frame per element:
  emit frame 0, or the first frame of `animations.default`, as the drawn image, and use
  `frames.size` to place it on the canvas at 1:1.
- `pivot` is not representable; a character sprite belongs on a layer whose name is the pivot
  convention, which is T-055's business, not this contract's.
- `frames.directions` goes in `customData`, per element. It is the one field an Excalidraw
  consumer can genuinely use, because the scene is already one frame per element in timeline
  order — the element the artist has selected is the frame whose facing they want.

---

## 10. Deliberately absent

Every entry here was considered and left out, with the reason, because a reader who finds a
field missing has to be able to tell "not modelled yet" from "not needed".

| Absent | Why |
| --- | --- |
| Tileset and tilemap contracts | A different technical contract: cell geometry, tile properties, terrain edges. `kind` is a closed enum and the generator **throws** rather than writing a `kind: "sprite"` file for a document carrying a tileset. |
| `sheet.layout`, `sheet.padding`, `sheet.margin` | `buildSpritesheet` does not return them, so recording them here would mean re-deriving packer state in a second place and letting the two drift. The cost is that `sheet.regions[]` is authoritative rather than recomputable, which S5 and S7 say out loud. |
| Rig parts, poses, tweens, anchors, hitboxes | Those are authoring structure and live in the `.pixel` source and the Aseprite sheet JSON. The one piece with an engine-side consequence, the pivot, is projected into `pivot`. |
| Layer names, order, opacity, blend mode | They describe how the artwork was made, not what it is. Two layers that composite identically are the same asset, and S4.2 depends on that being true. |
| A `canvas` block | Every frame in a document shares one canvas, so `frames.size` already says it. A second copy is a second thing to drift. |
| A generated-by block with a version | It would change on every release, making every committed `meta.json` a diff on upgrade. The contract's own `schemaVersion` is the only version a reader needs. |
| A timestamp | A generated file must be byte-identical for the same document. See S11. |
| The `sheet` role in `outputs` | It would duplicate `sheet.image`. |
| A `facing` **inside** `animations.items[]` | An animation is a range of frames, and a range of frames does not have one direction — a `walk` tag spanning a south-facing row and a north-facing row is the normal shape of an 8-direction sheet. The direction belongs to the frame; the animation inherits it by listing frames. Writing it on the animation would be a field that is either wrong or meaningless for most assets. |
| Degrees, radians, or an angle model | Compass abbreviations, because that is what every target engine stores (S9.0). Converting an authoring angle into one of eight directions is the caller's decision, made once, where the artwork was drawn — not something this file re-derives from a number whose origin it cannot see. |

---

## 11. Rules for implementers

**Determinism.** The same document must produce byte-identical `meta.json` on every
machine. Concretely:

1. No timestamp, no generator version, no random or session id, no hostname, no absolute
   path.
2. No locale-sensitive anything. Sort with plain byte comparison, never `localeCompare`,
   never a locale-aware collator, never `toLocaleString` or `Intl`. Numeric formatting must be
   `Number.prototype.toString` and nothing else.
3. Key order is S5's order. Do not let a hash table, an ORM, or a JSON library with an
   "alphabetise keys" option decide it for you.
4. Floating-point fields are rounded to a stated number of decimals at the point of writing
   (S5 marks them derived); never emit a raw quotient.
5. Map keys whose content is user data, `palette.roles`, are sorted **numerically** by
   palette index, not lexicographically, or index 10 precedes index 9.

**The generator refuses rather than guesses.** A document with a tileset, a frames-less
document, a fractional frame duration or a sub-millisecond duration is an error. Rounding a
duration would make the contract disagree with the document it claims to describe; emitting
`kind: "sprite"` for a tileset would be the confidently-wrong answer. Both are one line of
throw.

**Never invent what the document does not know.** `license` and `outputs` are caller
options. `pivot` falls back to a value that says so. `frames.directions` is a caller option
too, and a label the generator does not recognise is an error rather than a dropped entry:
a silently-missing facing is a character facing the wrong way in the engine with nothing to
trace it back to. Nothing else in the contract is guessed.

---

## 12. Machine-readable schema

`@pixel/core` publishes this contract's JSON Schema (`assetMetaJsonSchema()` in
`packages/core/src/asset/schema.ts`) for **writer** validation: a tool accepting a
`meta.json` from someone else can check it before taking it.

Do **not** use it as a reader's rejection rule. It carries `additionalProperties: false`,
because every object in the schema is strict, and that strictness is what makes S3's
tolerance expressible at all: a strict object is the only way to tell "a field I have never
heard of" from "this file is fine". A reader that rejects unknown fields breaks every
consumer the first time the spec grows.

---

## 13. Change log for this contract

| Version | Change |
| --- | --- |
| `1` | First version. Sprite assets: canvas, timeline, tags, sheet, pivot, palette, licence, outputs. |
| `1` (additive) | `frames.directions[]`: optional per-frame facing and owning animations, for 8-direction character sheets. **No version bump**, because S3 rule 2 says adding a field is additive: a file written before this change still validates unchanged, a reader that does not know the field ignores it, and the digest preimage in S4.3 is untouched, so no asset identity moved. |

Raising `schemaVersion` requires a dated row here and a reason, in the same change.