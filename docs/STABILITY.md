# What is stable at 1.0

> **Status:** normative. This file and the code it names are one deliverable.
> `packages/core/test/stability-contract.test.ts` parses the declaration in S2 and fails the
> build when a name in it is not exported, when an export is not in it, or when the
> declaration block is missing. Where this file and the test disagree, the test is
> reporting a drift, not an opinion.

`dotloom-mcp` ships three ways — an Electron editor, a `pixel` CLI, and an MCP server — and one
engine behind all three. "Stable" here means one specific thing: **a change that breaks it is a
breaking change, it is announced, and `API_VERSION` moves.** Not "documented", not "shipped",
not "we have not broken it lately". The difference matters because documented-and-broken is the
failure mode this file exists to prevent, and it is the one a prose contract cannot stop.

The engine is young and its internal surface is large. A contract that covered all of it would
promise things nobody has decided yet, and the cost of that is not a broken promise, it is a
contract nobody believes. So this one is small and true.

---

## 1. The four surfaces, and which of them this file covers

A consumer of this repository touches one of four things. They have almost nothing in common,
and lumping them together is how a promise gets made to the wrong reader.

| Surface | What it is | Covered here |
| --- | --- | --- |
| The **library API** — the `exports` map of the published `dotloom-mcp` package | The function set a build script imports. See `docs/API.md`. | **Yes**, S2. This is the stable set. |
| The **MCP tool surface** — what an agent sees from the server | A deliberately budgeted list of entry-point tools, promoted on demand from the command catalogue. | **No**, S3. It is a conversation, not a library, and it is built to change. |
| The **CLI** — `pixel <command> --flags` | A shell surface over the same bus. | **No**, S3. |
| The **`.pixel` document format** | The editable source file a user commits to a game repo. | **Partly**, S5. Versioned separately, and the promise is weaker than most readers will want. |

The internal engine barrel (`packages/core/src/index.ts`) is not one of the four. It is the
escape hatch behind all of them, and it is not stable — see S3.1.

---

## 2. The declaration

This is the whole of the 1.0 library contract. Nine exports, three of them internal namespaces,
one integer.

```json stable-surface
{
  "apiVersion": "1",
  "pixelFormatVersion": 2,
  "stable": [
    "API_VERSION",
    "VERSION",
    "buildAnimation",
    "buildSprite",
    "buildWalkAnimation",
    "exportAssets",
    "exportEngineAssets",
    "getDirectionModel",
    "traceSvg"
  ],
  "internal": ["core", "mcp", "script"],
  "notStable": [
    "core-barrel",
    "mcp-tool-list",
    "mcp-tool-parameters",
    "cli-flag-surface",
    "command-parameters",
    "pixel-format-forward",
    "quality-dimensions",
    "share-card-layout"
  ]
}
```

The fenced block is machine-readable on purpose. `docs/ASSET-CONTRACT.md` sets the precedent: a
specification whose tables a test parses cannot drift from the code that implements it, and a
specification whose promises live in prose can. The fence carries a name (`json stable-surface`)
so finding it is one deterministic search rather than "everything above the first heading", which
a prose edit moves without anybody noticing. JSON is used because `packages/core` ships exactly
four runtime dependencies and none of them parses YAML, and `JSON.parse` is in the language.

Inside one major version of `apiVersion` the only permitted changes to `stable` are **additive**:
a new export, a new optional spec or plan field, a widened accepted type. A rename, a removal,
a reorder, or turning an optional field into a required one is a breaking change and moves
`apiVersion` to the next major.

### 2.1 Why this set and not a bigger one

**It is the `exports` map, so it is the set a consumer can actually name.** The published package
exposes `.`, `./internal` and `./package.json`. A promise about a name a caller cannot import is
a promise about a private implementation, and this repository has a documented habit of those
promising things: the engine barrel re-exports 32 modules and has been called "public" in
comments about half of them. Narrowing to what the map resolves is the one boundary that cannot
drift, because Node enforces it too — `npm-consumer-types.test.ts` compiles a real consumer and
asserts an undeclared specifier does not resolve.

**Every name is task-shaped rather than layer-shaped.** `buildSprite` is "make me a sprite";
`compositeFrame` is "composite a frame". The first can be added at 1.1 without a second thought.
The second is one of the pieces the first is made of, and promising it freezes a decomposition
that exists because it is convenient inside one repository. Same reason the ~90 commands are not
in the list: a command is an operation on a document, and the set of operations that turns out to
be worth having is exactly what a `devDependency` pipeline is for discovering.

**The sizes are stated so a reader can judge the trade.** The barrel re-exports 32 modules and 517
names; the stable set is nine. The test asserts that gap is still a gap, because
a stable set quietly widened to "whatever the barrel exports" is a contract that has stopped
being one, and it would pass every other assertion in the file.

### 2.2 Why `apiVersion` stays `'1'`

It is `'1'` today and it stays `'1'` at 1.0. The four names added since it was set —
`getDirectionModel`, `buildWalkAnimation`, `exportEngineAssets`, `traceSvg` — were additions with
no removal and no signature change, and `docs/API.md` defines an addition as additive. Moving the
integer for an addition would teach callers that the number is noise, which is the one thing a
version number must not be. It moves when something is renamed, removed, reordered, or when an
optional field becomes required — and it is pinned in two places, the block above and the
`STABLE` array in `packages/core/test/npm-surface.test.ts`, because a version constant asserted in
one file is a convention rather than a check.

### 2.3 Types

Types are stable where the function that takes or returns them is stable, and no further. The
signatures come from the shipped `.d.ts`, so a wrong call is a compile error rather than a
runtime surprise, but the **shape of a returned `Sprite`** is internal: `docs/API.md` names the
fields a caller is meant to read (`width`, `height`, `frames`, `layers`, `tags`, `palette`) and
nothing else. Reading `sprite.rig.tweens[0].easing` is internal territory and can move in a minor
release.

---

## 3. What is NOT stable

This is the half that decides whether the other half is believed. Each entry below is something a
reasonable person could plausibly have come to depend on, which is the only test that earns a
place in this list.

### 3.1 The internal engine barrel — `packages/core/src/index.ts`

32 `export * from` lines, 517 exported names today, and **none of it stable**. This includes
`createSprite`, `createEditor`, `Editor`, `applyCommand`, `serializeSprite`, `buildSpritesheet`,
`compositeFrame`, the whole quality pipeline, the asset generators and the importers. They are
real, shipped, documented in `docs/REFERENCE.md`, and reachable — but only as `core` through the
`dotloom-mcp/internal` specifier, which exists to be named as the thing it is.

The reason is not caution. The barrel exists so that `packages/app`, `packages/cli`, `packages/mcp`
and the Electron main process can share one implementation, and it mirrors this repository's own
module layout. That coupling is precisely what the task-shaped surface exists to remove, so
promising stability for it would be promising stability for a thing scheduled to change.

### 3.2 The MCP tool surface

The advertised tool list is **budgeted** and deliberately small — a fixed ceiling on the count
and on the total advertised bytes, both asserted in `packages/mcp/test/tool-surface.test.ts`. It
changes: commands are promoted from the catalogue into first-class tools on demand
(`commands: 'lazy'`), and the list is rebuilt every time. Tool **parameters** are declared by zod
schemas derived from the command catalogue, so they move when the command moves, and
`.strict()` means a mistyped parameter is a hard error rather than a default.

An agent should read the schema it was given on this session, not one copied from a document. That
is not evasion: it is the same reason `description` fields on those schemas are treated as the
product, because they are what an agent reads to decide how to call a tool, and a stale copy of
them is worse than none.

### 3.3 The CLI flag surface

`pixel <command> --flags` is a shell convenience over the same bus, its flags are not frozen, and
the command set is the catalogue. Nothing in this contract covers it. `docs/REFERENCE.md` is
current documentation, not a promise.

### 3.4 Command parameters and the command catalogue

The ~90 commands are the shared vocabulary — for agents, for scripts, for the CLI — and they are
the most-evolving part of the repository on purpose. A parameter added, widened, or given a
stricter zod schema is not a breaking change of anything promised here. Command names are listed
in `docs/REFERENCE.md` and published through `pixel://commands`; treat both as documentation of
the current build.

### 3.5 The quality pipeline's numbers

**No score is stable, and none is exposed by this contract.** A quality *dimension* may be added,
renamed, reweighted or removed; the `unmeasured` contract (`AGENTS.md`, `dev/EVALUATION.md`) is
the part that is load-bearing, not the weights. The reason is not fastidiousness: a
`quality_report` tool shipped once, was deleted in 0.3.1, and a model told the number was "clean"
sanded a lake into a dark flat rectangle. Anything an agent can read as a number to move toward
re-creates that failure under a new name. Named defect codes and abstentions with reasons are the
only forms of this pipeline's output that are stable, and even those are the pipeline's, not this
contract's.

### 3.6 The share card's layout

A share bundle is a **view of the contract**, not a second kind of artifact: it writes the same
engine files and the same `meta.json`, and what it adds is a card and provenance (see S6). The
card's HTML, its fields and its layout change with the presentation. The engine files it carries
are as stable as the functions that wrote them.

---

## 4. What the guard checks, and what it cannot

`packages/core/test/stability-contract.test.ts` reads the block in S2 and checks it against the
real published entry in both directions:

- every name declared in `stable` and `internal` is actually exported. A declared surface that
  has drifted from reality is worse than none, because it is trusted.
- every name exported by the entry point is declared. An export nobody declared is the direction
  that quietly grows.
- `apiVersion` matches the exported `API_VERSION`, and `pixelFormatVersion` matches
  `PIXEL_FORMAT_VERSION` in core.
- the declaration agrees with the independent `STABLE` / `INTERNAL` arrays in
  `npm-surface.test.ts`, so the two places that list the surface cannot disagree.
- the stable set is still a small fraction of the internal barrel, so it cannot be widened into
  "whatever core exports" without failing.
- exactly one declaration block exists, and it parses. **Deleting the declaration is itself a
  failure**, because a contract whose absence is silence is a contract that can be deleted by
  accident and nothing will say so.

What it cannot check, stated so nobody assumes otherwise: it cannot check that a stable
*signature* has not changed, only that the names exist. `npm-consumer-types.test.ts` covers the
published types, and `npm-surface.test.ts` covers the behaviour of each entry point. Between them
a rename goes red; a subtly narrowed parameter type in the `.d.ts` is caught by a consumer compile
only if that consumer is recompiled.

---

## 5. The `.pixel` document format

`PIXEL_FORMAT_VERSION` is `2` today, and a `.pixel` file is a zip of a JSON manifest plus one PNG
per cel. This is the dependency users feel most, and it is the one this repository controls least,
so the promise here is deliberately narrower than for the library API.

### 5.1 What the version number is

**The version describes the format, never the payload, and it is stamped unconditionally.**

- **Version 1** is the manifest without `sprite.rig`.
- **Version 2** is that manifest with `sprite.rig` in it — parts, poses, tweens, anchors and
  hitboxes. That is the *whole* of the difference, and it is the only change ever made to the
  number. The later move to positional cel and tilemap entry names was deliberately additive
  and stayed on version 2; the reasoning is written at the point of decision in
  `packages/core/src/serialize.ts`.

Two consequences follow, and both are the point:

- **Adding a rig does not change the container version.** It used to: the writer stamped
  `sprite.rig ? PIXEL_FORMAT_VERSION : 1`, so the same document declared version 1 or 2
  depending on one optional field, and the archive bytes of a rig-less document moved the
  moment a rig was attached. A version number that reports the document's contents is not a
  version number.
- **A rig-less file written today is stamped `2` and is refused by a build that only knows
  version 1** — that is npm `0.1.0` through `0.1.3`, the releases before rigs existed. Those
  releases could not write a rig at all, and every release from `0.2.0` onwards accepts
  version 2, so this is a one-way door that is only open backwards in time. It is recorded
  here rather than left implicit.

- **Forward compatibility is not promised.** A `.pixel` file written by a build newer than yours
  will be **refused** — `manifest.version > PIXEL_FORMAT_VERSION` throws
  `File was written by a newer version`. There is no attempt to read a future file and no partial
  load. Within one major version of the package, a file written by an older build continues to
  load, because additive container changes have been made without a version bump precisely when
  the manifest still describes the old layout (see the entry-name note in
  `packages/core/src/serialize.ts`, where that reasoning is written down at the point of decision).
- **A format written by a future build may not open in yours, and a future build is not obliged
  to open yours.** Committed `.pixel` sources are therefore a migration, not a permanent artefact.
  If a game repo commits them, pin the package version in the same commit as the artwork — the
  normal `devDependency` pin does this, and the same advice applies to `.pixel` files.
- **A major version is permitted to make a breaking format change**, and would have to ship a
  migration. Nothing in 1.0 promises the migration will exist.
- What *is* promised at 1.0: `format` is `pixel-art/sprite`, version `1` and `2` load, a
  non-integer or sub-1 version is refused, and the archive is byte-reproducible for a given
  document (zip entry timestamps are pinned, which is what makes "the source did not change"
  checkable rather than hopeful). Byte-reproducible means a pure function of the document *and
  the format version*: a rig-less `.pixel` file saved by a build that stamps version 2
  differs by one number from the same file saved by a build that stamped version 1, and the
  committed hash moves once, on re-save.

The contrast with `docs/ASSET-CONTRACT.md` is deliberate and is the point of reading both. The
asset contract has a real forward-compatibility story — additive fields only, readers ignore what
they do not recognise, a newer `schemaVersion` is advisory — because a game integrator reads that
file in someone else's repository and cannot be asked to upgrade. A `.pixel` file is read by the
build that wrote it. It gets the narrower promise.

---

## 6. Share bundles are a view of the contract

**A share bundle is not a second kind of artifact.** It writes the same engine files and the same
`meta.json`; what it adds is a card and provenance. A share template that produced different
engine files from the same document would make "which one is right" a question with two answers,
and that question has already cost this repository work elsewhere — four surfaces once each held
their own asset-bundle walk, and `packages/core/test/single-implementation.test.ts` now fails if
a second copy reappears.

The consequence is written down rather than left as folklore: **a new export target is a renderer
over `renderAssetBundle`, not a new pipeline.** A share template is a command with a template, not
a script with its own serialisation. Whether the share machinery should eventually be refactored
*into* that renderer is a real design question and is not decided here; the rule above holds in
either case, because it constrains what a refactor may produce rather than requiring one.

---

## 7. The deprecation rule

Nothing is deprecated at 1.0. The list in S2 has had removals in its history only as additions;
there is no deprecated name in it, so there is no marker to honour and **no deprecation mechanism
has been built.** A `@deprecated` tag plus a lint rule plus a changelog convention would be three
artefacts with no user, and an artefact with no user rots — which is worse than not having it,
because the next lane reads it as a contract and trusts it.

When a name does need deprecating, and only then, it looks like this:

1. **Announce it** in `CHANGELOG.md` and `CHANGELOG-ZH.md` under the release that does it, naming
   the replacement. A deprecation that is not announced is a removal with extra steps.
2. **Keep it working for the rest of the major version.** The name stays exported, still behaves,
   and is still covered by the S2 guard. It is marked `@deprecated` in the `.d.ts` with a
   pointer to the replacement, so an editor's tooling shows it without this file being read.
3. **Removing it bumps `apiVersion`** and moves it out of `stable`. That is a breaking change and
   gets a major version, not a minor one, and the removal row in the change log names what
   replaced it.
4. **A name is never silently repurposed.** A changed meaning is a removal plus an addition,
   because no consumer can tell the difference, and a `deprecated` name that quietly does
   something new is the worst state a name can be in.

The minimum notice is **one full major version of `apiVersion`**. There is no codemod and no
compatibility shim promised; the contract is small enough that reading the changelog is the
migration.

---

## 8. What breaking 1.0 would take

So the next lane knows the price of what it is about to do. Nothing below is free.

| To do this | The cost |
| --- | --- |
| Rename, remove or reorder a name in `stable` | `apiVersion` to `2`, a major release, a `CHANGELOG` row in both languages, and the declaration block in S2 edited in the same commit. |
| Make an optional spec or plan field required | The same. A build script written against 1.0 starts throwing, with no other signal. |
| Narrow an accepted type or change a return value's shape | The same, and it is the quiet one: it compiles in a consumer whose input happens to fit. |
| Add a stable export | Nothing. Update the block in S2 and the array in `npm-surface.test.ts`. That is the whole cost of growing. |
| Move a name from `core` to the stable surface | Declare it in `stable` and pin `apiVersion` where it is. Promoting is cheap; that is deliberate. |
| Change a `.pixel` manifest | A `PIXEL_FORMAT_VERSION` bump, a `README` note that committed sources need re-saving, and — inside a major version — a refusal of previously-valid files, which S5 says is allowed. |
| Add or reshape an MCP tool | Bump the ceiling in `packages/mcp/test/tool-surface.test.ts` in the same commit and say why in the test name. Cheap, and not covered here. |

The one thing that is **not** cheap, and is the reason this file exists: a change that breaks a
promise here is discovered by a consumer, possibly on someone else's machine, possibly months
later. Every check in this repository is cheap. That one is not, which is why the contract is
this short.
