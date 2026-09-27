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

Eight exports. Three of them do the work.

| Export | Tier | What it is |
| --- | --- | --- |
| `buildSprite(spec)` | **stable** | Build a single-frame sprite from a size, a ramp and a list of ops. Returns a `Sprite`. |
| `buildAnimation(spec)` | **stable** | The same, plus a frame count and animation tags. Returns a `Sprite`. |
| `exportAssets(sprite, plan)` | **stable** | Render a sprite into finished files and return them as bytes. Never writes to disk. |
| `API_VERSION` | **stable** | The version of this contract, as a string. See [Versioning](#versioning). |
| `VERSION` | **stable** | The package version, e.g. `'0.4.2'`. |
| `core` | internal | The whole headless engine: `Sprite`, `Editor`, every command, the rigs, tilemaps, ramps, importers, codecs. |
| `mcp` | internal | The MCP server and its agent-facing surface, in-process. |
| `script` | internal | The `node:vm` scripting runtime for trusted scripts and plugins. |

The **stable** exports are the contract. The **internal** namespaces are the escape hatch:
real, shipped, and the thing the README has always documented, but not covered by
`API_VERSION`. New code should not go there — see [Versioning](#versioning).

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
- `exportAssets` allocates no ids and consults no clock: it is a pure function of
  `(sprite, plan)`.
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
| Bumped by | Every release. | A breaking change to `buildSprite`, `buildAnimation`, `exportAssets` or the types they take. |
| Use it to | Report a bug. | Pin your build script. |

**Stable** — `buildSprite`, `buildAnimation`, `exportAssets`, `VERSION`, `API_VERSION`. Within
one major version of `API_VERSION`, the only permitted changes are **additive**: a new
export, a new optional plan field, a new optional spec field, a widened accepted type.
Renaming, removing, reordering, or making an optional field required is a breaking change and
bumps `API_VERSION` to the next major.

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
- **A recipe catalogue, or `describe_recipe`.** That is T-030/T-036.
- **Fusing several sprites into one atlas.** `exportAssets` takes one `Sprite`, because how
  tags and frame metadata should merge across documents is a T-043 decision, not a guess.
  Build one animation with `buildAnimation` and the sheet is already one file.
- **Writes, directories, globs, watch mode, cache keys, asset manifests.** `exportAssets`
  returns bytes; where they go is the build script's business, and every one of those
  choices is better made by a build system the project already has.
- **Typedefs for the published bundle.** The npm package ships JavaScript. The types here are
  documentation and editor help, not a distribution channel.
