# Library API

<p align="center">
  <a href="API.md">English</a> · <a href="API-ZH.md">中文</a>
</p>

> This document is the authority. `API-ZH.md` is its Chinese mirror: where the two
> disagree, this one is correct and the Chinese one is the stale copy.

`dotloom-mcp` is a game-asset pipeline. This is the API a game project uses to generate its
sprites, tilesets and animations **at build time**, from code, as a `devDependency` — no GUI,
no MCP client, no person in the loop.

```bash
npm install --save-dev dotloom-mcp
```

Node.js **22.13 or newer**. Plain ESM. No Electron, no document store, no running app, no
setup step: import the module and call a function.

> An AI agent drives this product through the MCP tool surface (`pixel-mcp`); a build script
> drives it through this one. The two share an engine and a command catalogue, not an
> interface, and both are supported. See [`REFERENCE.md`](REFERENCE.md) for the MCP surface
> and the full command list.

---

## The surface

Twelve exports. Seven of them do the work.

| Export | Tier | What it is |
| --- | --- | --- |
| `buildSprite(spec)` | **stable** | Build a single-frame sprite from a size, a ramp and a list of ops. Returns a `Sprite`. |
| `buildAnimation(spec)` | **stable** | The same, plus a frame count and animation tags. Returns a `Sprite`. |
| `exportAssets(sprite, plan)` | **stable** | Render a sprite into finished files and return them as bytes. Never writes to disk. |
| `getDirectionModel(canvas, anchor?)` | **stable** | The eight-direction angle model for a canvas: which four are exact, which four have to be drawn, and where each lands. Read-only. |
| `buildWalkAnimation(spec)` | **stable** | An `AnimationSpec` plus one direction and a gait. Appends `generate_walk_cycle` after your ops and returns the `Sprite`. |
| `exportEngineAssets(sprite, plan)` | **stable** | `meta.json` plus one engine's files, as bytes, with the lossiness list. Never writes to disk. |
| `traceSvg(spec)` | **stable** | A `SpriteSpec` plus an SVG outline: builds the document and traces the vector onto the pixel grid. |
| `API_VERSION` | **stable** | The version of this contract, as a string. See [Versioning](#versioning). |
| `VERSION` | **stable** | The package version, e.g. `'0.5.0'`. |
| `core` | internal | The whole headless engine: `Sprite`, `Editor`, every command, the rigs, tilemaps, ramps, importers, codecs. |
| `mcp` | internal | The MCP server and its agent-facing surface, in-process. |
| `script` | internal | The `node:vm` scripting runtime for trusted scripts and plugins. |

The **stable** exports are the contract. The **internal** namespaces are the escape hatch:
real, shipped, and the thing the README has always documented, but not covered by
`API_VERSION`. New code should not go there — see [Versioning](#versioning).

### Types

The package ships its own type declarations, so this file is not documentation-only: a
TypeScript consumer gets the signatures below at `import` time and a wrong call is a compile
error rather than a runtime surprise.

```ts
import { buildSprite, type SpriteSpec, type ExportPlan } from 'dotloom-mcp';
```

Resolution goes through the package's `exports` map:

| Specifier | What it is |
| --- | --- |
| `dotloom-mcp` | The stable surface, and the three internal namespaces for backwards compatibility. |
| `dotloom-mcp/internal` | The same module, named explicitly as the escape hatch. Useful in a `tsconfig` `imports` alias or a lint rule that says "this build script is allowed to reach for `core`". |
| `dotloom-mcp/package.json` | The manifest, for a build script that reads the version. |

Anything else — `dotloom-mcp/dist/index.js`, `dotloom-mcp/dist/index.js.map` — is **not
exported** and does not resolve. That is the point of the map: the tier boundary is declared
where a tool enforces it, rather than in a sentence in this file that nothing checks.
`packages/core/test/npm-consumer-types.test.ts` compiles a consumer against the packed tarball
and asserts both halves: the documented names resolve, and an undeclared specifier does not.

---

## A complete, runnable example

Save this as `tools/build-assets.mjs` in your project and run `node tools/build-assets.mjs`.

```js
// tools/build-assets.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildAnimation, buildSprite, exportAssets } from 'dotloom-mcp';

const OUT = 'assets/generated';

/** Write whatever the plan produced, into OUT. The API returns bytes; the path is yours. */
async function emit(sprite, plan) {
  for (const file of exportAssets(sprite, plan)) {
    const path = join(OUT, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.bytes);
    console.log(`  ${file.path.padEnd(22)} ${String(file.bytes.length).padStart(6)} B  ${file.mediaType}`);
  }
}

/* 1. One sprite: a slime, blocked in as a silhouette then shaded. */
console.log('slime');
const slime = buildSprite({
  seed: 20260927,
  width: 16,
  height: 16,
  name: 'slime',
  layers: ['base', 'shade', 'outline'],
  palette: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f', '#deeed6'],
  ops: [
    // base: the whole body in one flat mid-tone. This is the silhouette.
    { command: 'draw_ellipse', params: { layer: 'base', rect: { x: 2, y: 5, w: 12, h: 9 }, color: '#8bac0f' } },
    // shade: a contact band inside the silhouette, and two eyes.
    { command: 'draw_ellipse', params: { layer: 'shade', rect: { x: 4, y: 9, w: 8, h: 4 }, color: '#306230' } },
    { command: 'draw_rect', params: { layer: 'shade', rect: { x: 5, y: 8, w: 1, h: 2 }, color: '#0f380f' } },
    { command: 'draw_rect', params: { layer: 'shade', rect: { x: 10, y: 8, w: 1, h: 2 }, color: '#0f380f' } },
    // outline: a 1px border of the same shape, drawn last.
    { command: 'draw_ellipse', params: { layer: 'outline', rect: { x: 2, y: 5, w: 12, h: 9 }, color: '#0f380f', fill: false } },
  ],
});
await emit(slime, { frames: true, sheet: true, source: true });

/* 2. A tagged animation: the same slime, bobbing. */
console.log('slime-idle');
const idle = buildAnimation({
  seed: 20260927,
  width: 16,
  height: 16,
  name: 'slime-idle',
  layers: ['base', 'shade', 'outline'],
  palette: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f', '#deeed6'],
  frames: 4,
  frameDurationMs: 140,
  tags: [{ name: 'idle', from: 0, to: 3, direction: 'pingpong' }],
  ops: [0, 1, 2, 1].map((squash, frame) => ({
    command: 'draw_ellipse',
    // `frame` and `layer` address a cel exactly as they do in the CLI. Leave either out and
    // the bottom layer of frame 0 is filled in for you.
    params: { frame, layer: 'base', rect: { x: 2, y: 5 + squash, w: 12, h: 9 - squash }, color: '#8bac0f' },
  })),
});
await emit(idle, { sheet: { layout: 'grid', columns: 4 }, gif: { scale: 4 }, source: true });
```

Output:

```text
slime
  slime_0.png               143 B  image/png
  slime_sheet.png           143 B  image/png
  slime_sheet.json          895 B  application/json
  slime.pixel              1218 B  application/zip
slime-idle
  slime-idle_sheet.png      195 B  image/png
  slime-idle_sheet.json    2101 B  application/json
  slime-idle.gif            921 B  image/gif
  slime-idle.pixel         1498 B  application/zip
```

Every command in `ops` is a real command from the shared catalogue, with its own validation —
so `list_commands` / `pixel://commands` documents the same ops an agent would use, and
`REFERENCE.md` is the manual for them. A mistyped parameter is an error, never a silent
default.

---

## `buildSprite(spec)` / `buildAnimation(spec)`

Both return a plain `Sprite`: no session, no handle, no cleanup. What you do with it is
`exportAssets`, `core.serializeSprite`, or hand it to the `core` namespace.

| Field | Type | Notes |
| --- | --- | --- |
| `seed` | `number` | Seed for every id the build allocates. Omitted means `0`, which is *still* reproducible. |
| `width`, `height` | `number` | Positive integers. Any size up to whatever your machine can hold. |
| `name` | `string` | Also the default stem for export paths. |
| `palette` | `string[] \| Palette` | Explicit colours, or a `core.Palette`. Defaults to DawnBringer 16. |
| `layers` | `string[]` | Bottom first, e.g. `['base', 'shade', 'outline']`. |
| `background` | `ColorInput \| null` | Fill every frame's bottom layer. Omit for transparency. |
| `paletteLocked` | `boolean` | Snap every painted colour to the nearest swatch. |
| `ops` | `AssetOp[]` | `{command, params?, label?}`, run in order on the shared bus. |
| `frames` | `number` | *`buildAnimation` only.* Defaults to 1. |
| `frameDurationMs` | `number` | *`buildAnimation` only.* Defaults to 100. Per-frame timing is a `set_frame_durations` op. |
| `tags` | `AnimationTagSpec[]` | *`buildAnimation` only.* `{name, from, to, direction?, repeat?}`, 0-based and inclusive. |

**Ops.** `params.layer` and `params.frame` address a layer and a frame exactly as they do in
the CLI. Omit them and the bottom layer and frame 0 are filled in for you — the same rule
the MCP tool surface and scripts use, from the same function in core, so a build script and
an agent spell their ops identically.

**Palette names are not accepted.** `'dawnbringer16'` is an MCP affordance, for an agent
that gains from a short name. A build script does not: the ramp ends up in your output, and
`core.DAWNBRINGER_16` is one import away.

**Palette roles are ops, not a field.** `add_palette_ramp` takes a `role`, and
`ensure_palette_role` and `shade_band` bind to it:

```js
{ command: 'add_palette_ramp', params: { from: '#2b1f3d', to: '#e8b98a', steps: 5, hueShift: 12, role: 'skin' } }
```

**Errors.** Every rejection is a `core.CommandError` with a `code` — `invalid_params`,
`unknown_command`, `command_failed` — so branch on the code, not the message. A failed op's
message names its index in `ops`:

```text
ops[2] (draw_ellipse) failed: Command draw_ellipse failed: Frame index out of range: 1
```

---

## `exportAssets(sprite, plan)`

Renders a sprite into finished files and returns them as bytes. It reads and writes nothing:
you choose the paths, the directory, the zip, the CDN.

```ts
interface AssetFile {
  path: string;        // 'knight_sheet.png', safe to join onto any root
  bytes: Uint8Array;
  mediaType: string;   // 'image/png' | 'application/json' | 'image/gif' | 'application/zip'
  kind: 'frame' | 'sheet' | 'sheet-json' | 'gif' | 'source';
}
```

| Plan field | Produces |
| --- | --- |
| `frames: true` | One PNG per frame: `<name>_0.png`, `<name>_1.png`, … 0-based. |
| `sheet: true` | `<name>_sheet.png` plus `<name>_sheet.json`, the Aseprite frame table. |
| `sheet: {layout, columns, padding, margin}` | The same, with layout options from `core.buildSpritesheet`. |
| `gif: true` / `gif: {tag, scale, loop, …}` | `<name>.gif` of a tag, or the whole timeline. |
| `source: true` | `<name>.pixel` — the editable archive, a zip of the manifest and one PNG per cel. |
| `name` | File name stem. Defaults to the sprite's name, with separators and spaces folded to `-`. |
| `scale` | Integer upscale for every rendered output. Does not affect `source`. |
| `background` | Fill behind the sprite instead of leaving it transparent. |

There is no default plan. A plan that selects nothing throws rather than returning an empty
array, because a build that produces no files and reports success is the worst outcome
available. The sheet is two files on purpose: the PNG is what the engine slices, and the
JSON is what tells it where each frame is, how long it lasts, and which tag it belongs to.

The frame table describes the *scaled* sheet — `scale` is applied to the atlas, not to the
image, so the rects, the sheet size and the pixels always agree.

---

## The determinism contract

**Same input, same bytes. Every time, in any process, on any machine.**

This is the property that makes build-time generation viable at all: a committed asset has
to be a function of its source, so a diff means *the artwork changed*, never *the run
changed*. It is enforced, not promised:

- `buildSprite` and `buildAnimation` install a seeded id factory for the duration of the
  call, so the layer, frame, palette and tag ids a `.pixel` manifest carries are a function
  of `seed` rather than of the clock.
- Every op runs through the shared command bus, which draws all of its randomness from
  `core`'s `rng.ts`. There is no `Math.random()` in a drawing path.
- The id factory is **removed** when the call returns, leaving the process in the state a
  fresh process would be in. If you installed your own factory with `core.setIdFactory`,
  re-install it afterwards.
- `exportAssets` and `exportEngineAssets` allocate no ids and consult no clock: they are pure
  functions of `(sprite, plan)`. The asset contract carries no timestamp and no invented
  `uid://`, and the naming report is a pure function of the names.
- `getDirectionModel` is pure and reads no clock: integer coefficients throughout, no
  trigonometry, so the matrices are bit-identical on every machine.
- `buildWalkAnimation` inherits the same seeded id scope as the other two builders — the frame
  and tag ids the walk command allocates are a function of `seed`.
- `traceSvg` uses Cody-Waite range reduction plus the fdlibm minimax kernels instead of
  `Math.sin`, for the same reason: V8, JSC and SpiderMonkey may disagree in the last ULP, and an
  outline that moves a pixel between two engines is not a bug anyone can debug from a screenshot.
- `.pixel` serialisation is byte-reproducible, with zip entry timestamps pinned.

Two builds with the same `seed` produce identical bytes, including the `.pixel` archive and
the sheet JSON. A different `seed` produces different bytes. Both halves of that claim are
asserted in `packages/core/test/npm-surface.test.ts`, because "same seed, same bytes" on its
own is satisfied by an empty buffer.

To use it as a regression check, rebuild and compare bytes rather than eyeballing images. Keep
the spec in its own module, and this fails the build if the artwork moved.

```js
// tools/check-assets.mjs
import { readFile } from 'node:fs/promises';
import { buildSprite, exportAssets } from 'dotloom-mcp';
import { SLIME } from './slime-spec.mjs'; // the same spec tools/build-assets.mjs used

const [rebuilt] = exportAssets(buildSprite(SLIME), { source: true });
const committed = await readFile('assets/generated/slime.pixel');
if (!Buffer.from(rebuilt.bytes).equals(committed)) {
  console.error('slime.pixel changed — review the diff before committing it');
  process.exit(1);
}
console.log('slime.pixel is byte-identical to the committed file');
```

---

## Versioning

Two version numbers, and the difference between them matters.

| | `VERSION` | `API_VERSION` |
| --- | --- | --- |
| Tracks | The package release. | The shape of the stable exports. |
| Bumped by | Every release. | A breaking change to any stable export: a rename, a removal, a newly required field, or a narrowed type. |
| Use it to | Report a bug. | Pin your build script. |

**Stable** — `buildSprite`, `buildAnimation`, `exportAssets`, `getDirectionModel`,
`buildWalkAnimation`, `exportEngineAssets`, `traceSvg`, `VERSION`, `API_VERSION`. Within one
major version of `API_VERSION`, the only permitted changes are **additive**: a new export, a
new optional plan field, a new optional spec field, a widened accepted type. Renaming,
removing, reordering, or making an optional field required is a breaking change and bumps
`API_VERSION` to the next major.

That is why `getDirectionModel`, `buildWalkAnimation`, `exportEngineAssets` and `traceSvg`
shipped without a bump: four new names, no removal and no signature change.
`packages/core/test/npm-surface.test.ts` pins the list, and pins `API_VERSION` beside it, so
"only additive" is a checked claim rather than an intention.

**The `exports` map is part of the contract.** `.` is the stable surface, `./internal` names the
escape hatch explicitly, `./package.json` is the manifest, and nothing else resolves. Adding a
subpath is additive; removing one is breaking, because a build script that imported it stops
compiling.

**Internal** — `core`, `mcp`, `script`. They are shipped, they are documented, and they are
where the engine's full power is. They are not covered by `API_VERSION` and may change in a
minor release, because they deliberately mirror this repository's own package layout: that
coupling is the thing the task-shaped surface exists to remove, and it would be dishonest to
promise stability for it. They are the right tool for something the three stable functions do
not cover, and the wrong default.

**Not covered at all:** the internals of the three stable functions' *return values*. A
`Sprite` is a `core` type, and this API makes no promise about the `Sprite` shape beyond what
`docs/REFERENCE.md` documents. The parts of it you are meant to use — `width`, `height`,
`frames`, `layers`, `tags`, `palette` — are as stable as the rest of `core`. If you find
yourself reading `sprite.rig.tweens[0].easing`, you are in internal territory.

---

## Recipes plug in here

A recipe is a function of the same shape, built on these three, exported next to them:

```js
import { buildAnimation, exportAssets } from 'dotloom-mcp';

export function buildPlatformerTileset({ tileSize = 16, seed = 1, columns = 8 } = {}) {
  const sprite = buildAnimation({ seed, width: tileSize * columns, height: tileSize * columns, /* … */ });
  return sprite;
}
```

Nothing about the surface below changes when recipes land. `API_VERSION` stays at `1`.

## Not here, on purpose

- **`buildCharacter({brief, directions})`.** A recipe needs an LLM or a human to turn prose
  into ops, so it is async and it is a recipe (T-030+), not a library primitive. The seam it
  plugs into is `buildAnimation` + `exportAssets`.
- **A recipe catalogue, or `describe_recipe`.** Both exist, and neither is here on purpose:
  a recipe is prose an agent reads, so it is served by the MCP server's `describe_recipe`
  tool and the `pixel://recipe/{id}` resource, and the npm bundle ships the `recipes/`
  directory rather than a library function that returns them.
- **Fusing several sprites into one atlas.** `exportAssets` takes one `Sprite`, because how
  tags and frame metadata should merge across documents is a T-043 decision, not a guess.
  Build one animation with `buildAnimation` and the sheet is already one file.
- **Writes, directories, globs, watch mode, cache keys, asset manifests.** `exportAssets` and
  `exportEngineAssets` return bytes; where they go is the build script's business, and every one
  of those choices is better made by a build system the project already has.
- **A whole eight-direction character set in one call.** `getDirectionModel` tells you which
  three drawings an eight-direction set actually needs — four of the eight are exact transforms
  and need no artwork — and `buildWalkAnimation` bakes one direction. Assembling the eight is
  still a loop, because an eight-direction set is *three* drawings authored by a person and the
  choice of which is exactly the kind of decision a recipe, not a primitive, should make.

---

## `getDirectionModel(canvas, anchor?)`

Read-only and derived. It writes nothing, allocates no ids, and is safe to call in a build
script's planning step — before anything has been drawn.

```js
const model = getDirectionModel({ width: 32, height: 32 });
model.exact;        // ['N', 'E', 'S', 'W']     — transforms reproduce these exactly
model.approximate;  // ['NE', 'SE', 'SW', 'NW'] — diagonals, which have to be drawn
model.pivot;        // { x: 15.5, y: 31 }       — bottom centre, on `ground`
```

| Field | Type | Notes |
| --- | --- | --- |
| `baseDirection` | `'E'` | The direction the base pose is drawn in. Everything else is derived from it. |
| `anchor` | `'ground' \| 'facing' \| 'origin'` | The point every direction leaves fixed, so a turn is a turn and not a slide. Defaults to `ground`, the contact point under the feet. |
| `pivot` | `{x, y}` | That anchor's position on this canvas. |
| `exact` | `DirectionId[]` | Directions a quarter turn and/or mirror reproduces. No artwork needed. |
| `approximate` | `DirectionId[]` | The diagonals. There is no pixel-exact 45° transform and this engine will not approximate one. |
| `directions` | `DirectionSummary[]` | All eight, clockwise from N: `facing`, `drawing`, `resolvedFrom`, and the canvas `matrix`. |

`N` is screen-up and `S` is screen-down. On a top-down map screen-up is *away* from the camera,
so if you want the front-view reading where `N` faces the viewer, use the tools directly and
swap the two rows.

Every matrix has integer coefficients: a quarter turn is a signed permutation of the axes and a
mirror negates one row. No trigonometry appears anywhere in the model, which is why
`packages/core/test/determinism.test.ts` bans `Math.sin` and friends from `src` — V8, JSC and
SpiderMonkey may disagree in the last ULP, and a matrix that moves a pixel between two engines
is not a bug anyone can debug.

---

## `buildWalkAnimation(spec)`

`buildAnimation` plus the `generate_walk_cycle` command, **appended after your ops** so the rig
and the rest pose exist before the gait is baked. One call is one direction.

```js
const walk = buildWalkAnimation({
  seed: 7, width: 32, height: 32, name: 'hero',
  layers: ['body', 'legL', 'legR'],
  direction: 'S',
  walk: { frames: 6, stride: 3 },
  ops: [
    {
      command: 'create_rig',
      params: {
        parts: [
          { name: 'body', pivot: { x: 16, y: 10 } },
          { name: 'legL', pivot: { x: 14, y: 20 }, parent: 'body' },
          { name: 'legR', pivot: { x: 18, y: 20 }, parent: 'body' },
        ],
      },
    },
    { command: 'draw_rect', params: { layer: 'body', rect: { x: 12, y: 8, w: 8, h: 12 }, color: '#8bac0f' } },
    { command: 'draw_rect', params: { layer: 'legL', rect: { x: 13, y: 20, w: 2, h: 8 }, color: '#0f380f' } },
    { command: 'draw_rect', params: { layer: 'legR', rect: { x: 17, y: 20, w: 2, h: 8 }, color: '#0f380f' } },
  ],
});
```

Every `AnimationSpec` field is inherited. On top:

| Field | Type | Notes |
| --- | --- | --- |
| `direction` | `DirectionId` | Defaults to `E`, the base drawing. A diagonal resolves from the cardinal it is nearest, and the command says so in its result. |
| `anchor` | `DirectionAnchorName` | Defaults to `ground`. |
| `pivot` | `{x, y}` | Explicit orientation pivot, overriding `anchor`. |
| `walk.frames` | `number` | Frames in one gait cycle. Even counts read best: a cycle has two contacts. Defaults to 4. |
| `walk.frameDurationMs` | `number` | Defaults to 120. |
| `walk.stride` | `number` | Peak horizontal foot travel in pixels. Defaults to 2. |
| `walk.bob` | `number` | Peak body lift, in pixels. Defaults to 1. |
| `walk.legSwingDegrees` | `number` | Peak leg tilt at the ends of the swing. Defaults to 6. |
| `walk.legs` / `arms` / `body` | `string[]` | Rig part names or ids. Omit to auto-detect from the names (`leg`/`foot`, `arm`/`hand`, `body`/`torso`). |
| `walk.phaseOffset` | `number` | Whole frames to advance before frame 0, for staggering one loop against another. |
| `walk.tagName` | `string` | Defaults to `walk_<direction lowercased>`. Use distinct names to fill a set. |
| `walk.loopDirection` | `'forward' \| 'reverse' \| 'pingpong'` | Defaults to `forward`. |
| `walk.repeat` | `number` | `0` loops forever. Defaults to `0`. |
| `walk.targetFrame` | `number` | First destination frame. Defaults to the frame after the rig rest frame. |
| `walk.overwrite` | `boolean` | Required when a destination frame already holds pixels. |

**The loop closes.** The gait is integer triangle waves sampled modulo `frames`, so frame
`frames` is the *same pose* as frame `0` and the last frame leads straight back into the first.
No duplicated end frame, therefore no seam. A sine would read the same in a still and would put
`Math.sin` into a path that decides pixels.

Walk poses are transient: they are baked into frames and never pushed into the rig, so a
document does not accumulate one pose per frame per direction. Use a `save_pose` op for a stance
you want to keep.

**Errors.** `CommandError` with a code, as everywhere. A missing rig is the realistic failure
here and arrives as `ops[N] (create_rig) failed: …` or as the walk op's own context — named, not
a surprise.

---

## `exportEngineAssets(sprite, plan)`

`meta.json` plus one engine's files, as bytes. The asset contract
([`ASSET-CONTRACT.md`](ASSET-CONTRACT.md)) and the four importers
([`IMPORTERS.md`](IMPORTERS.md)) are `core` internals; this is the one call a build script needs
so that nobody has to hand-assemble `{root, files, warnings}`, serialise the contract, validate
the names and join the paths.

```js
const bundle = exportEngineAssets(sprite, { engine: 'godot', sheet: true });
for (const file of bundle.files) {
  await writeFile(join('assets', bundle.root, file.path), file.bytes);
}
console.log(bundle.warnings); // what Godot's mapping could not carry
```

| Plan field | Effect |
| --- | --- |
| `engine` | `'godot' \| 'unity' \| 'phaser' \| 'excalidraw'`. |
| `meta` | Write `meta.json` too. Defaults to `true`; every importer reads a contract. |
| `metaPath` | Where it goes, relative to the root. Defaults to `meta.json`. |
| `sheet` | `true` packs one with default options; an object passes layout options to `core.buildSpritesheet`. Omit for a bundle of individual PNGs. |
| `scale` | Integer upscale for the packed sheet. Defaults to 1. |
| `background` | Fill behind the sheet instead of transparency. |
| `outputs` | Other files in the bundle, listed in the contract. |
| `license` | Licensing. Never invented: omit it and the contract says nothing about permission. |
| `directions` | Per-frame facing labels, one per frame. **A caller option, never derived** — an unrecognised label is refused rather than dropped, because a character that silently faces the wrong way in the game is not traceable from the sheet. |
| `name` | File name stem. Defaults to the sprite's name. |
| `directory` | Override the importer's suggested root. |
| `options` | Passed straight to the chosen importer. `godot` takes none and says so. |

The result is `{root, files, warnings, meta, naming}`. `files` are `{path, bytes, role}` relative
to `root`.

**`warnings` is a lossiness list, not a score.** There is no number here to optimise and no
verdict to move artwork towards — these are the mappings from the contract's own S9 that the
importer actually hit, which is what a build log needs. `naming` is likewise a report with
machine-readable diagnostics, not a grade. A naming *error* (a reserved device name, a
case-folded collision) refuses the whole call, because a bundle whose files break on a Windows
build machine is a broken build and it is better found here than in CI naming nothing.

**Determinism.** The contract carries no timestamp and no invented `uid://`, the file order is
the importer's, and the naming report is a pure function of the names. Same sprite, same plan,
same bytes, in any process.

**It refuses** what it cannot describe honestly: a tileset or a tilemap document has no
`schemaVersion 1` contract, an unrecognised facing is an error, and a wrong-length `directions`
array is an error. Emitting a `kind: "sprite"` file for a tileset would be the
confidently-wrong answer that costs an integrator a day.

---

## `traceSvg(spec)`

A `SpriteSpec` plus `svg`: the road from vector to pixel, in one call. A PNG import cannot
recover the geometry; a traced outline lands on the grid exactly.

```js
const icon = traceSvg({
  svg: await readFile('assets/logo.svg', 'utf8'),
  width: 32, height: 32, name: 'logo',
  palette: ['#1a1c2c', '#5d275d', '#ef7d57', '#ffcd75'],
  scale: 16,           // a 512-unit-wide icon lands 32px wide
});
```

`svg` is the source as **text**, not a path: core has no filesystem, so the build script reads
the file. On top of `SpriteSpec`: `layer`, `frame`, `color` (flatten the whole trace to one
colour), `scale` (SVG user units per pixel), `offset`, `tolerance`, `rect` and `replace`.

**Coverage is hard-edged by design.** A traced outline is a pixel edge, not a ramp of
intermediate alphas; run an `antialias` op afterwards if the staircase is too coarse.

**What it refuses.** `transform` on any element, a `<g>` with an inherited `fill`, and
`fill: url(#gradient)` — all of which would put the artwork in the wrong place without saying
so. Strokes are never traced: a stroke-only SVG produces nothing and says so.

**Reading the refusal.** `editor.execute` re-wraps every command failure, so the error you
catch has code `command_failed` and the machine-readable reason nested one level down:

```js
try {
  traceSvg({ svg, width: 32, height: 32 });
} catch (error) {
  error.code;                          // 'command_failed' — the op failed
  error.details.code;                  // 'invalid_params' — the arguments were wrong
  error.details.details.reason;        // 'svg_unsupported' | 'svg_malformed' | 'svg_empty'
}
```

That is the shape every op in this API throws, not something specific to the tracer: a
build script that branches on `error.details.details.reason` is branching on the reason the
document refused, which is the only part of the three that says anything about the SVG.

**Determinism.** The tracer's trigonometry is Cody-Waite range reduction plus the fdlibm
minimax kernels rather than `Math.sin`, for the reason above. Same SVG, same canvas, same
pixels, on every machine.
