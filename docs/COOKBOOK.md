# Cookbook

<p align="center">
  <a href="COOKBOOK.md">English</a> · <a href="COOKBOOK-ZH.md">中文</a>
</p>

> Five tasks, five runnable files. The reference for every field is
> [`docs/API.md`](API.md); this document is what people actually want to do.
>
> Every snippet here is a file in [`cookbook/`](../cookbook/), and
> `packages/core/test/cookbook.test.ts` compiles, runs and byte-compares all of them.
> ([中文镜像](COOKBOOK-ZH.md))

Five things people actually want to do with this engine, with the code that does them.

Every snippet in this document is a file in [`cookbook/`](../cookbook/), and
`packages/core/test/cookbook.test.ts` compiles, runs and byte-compares every one of them
on every test run. A snippet here that stops working fails the build before a reader
copies it.

| Chapter | File | What it produces |
| --- | --- | --- |
| [1. Your first sprite](#1-your-first-sprite) | `cookbook/01-first-sprite.ts` | A 16×16 slime: silhouette, shading, contour, PNG + sheet + `.pixel` |
| [2. A walk cycle and eight directions](#2-a-walk-cycle-and-eight-directions) | `cookbook/02-walk-cycle.ts` | Four cardinal walk cycles from one drawing, plus `directions.json` |
| [3. Tracing an SVG](#3-tracing-an-svg) | `cookbook/03-trace-svg.ts` | A 64-unit leaf traced into a 16px icon, and the refusal that comes with it |
| [4. Exporting for an engine](#4-exporting-for-an-engine) | `cookbook/04-engine-export.ts` | Godot, Unity, Phaser and Excalidraw bundles from one contract |
| [5. One recipe, end to end](#5-one-recipe-end-to-end) | `cookbook/05-recipe-ui-icon.ts` | A UI icon built from a recipe, checked with named defects |

[`docs/API.md`](API.md) is the reference: every field, every error code, every plan option.
This document is the five tasks.

---

## Running an example

The examples are ESM TypeScript with top-level `await`, and they import the bare specifier
`dotloom-mcp` — the same string a game project writes, resolved through the package's
`exports` map rather than through a path into this repository.

In a project that has the package installed:

```bash
npm install --save-dev dotloom-mcp
node --experimental-strip-types cookbook/01-first-sprite.ts
```

Two things that are not optional in your project, because the examples are ESM:

- `"type": "module"` in `package.json`, or a `.mts` extension.
- Node **22.13 or newer** (`--experimental-strip-types`; on 22.18+ the flag is optional).

Inside *this* repository the bare specifier resolves nowhere — a workspace does not link
itself — so the examples are run the way the test runs them: against the packed tarball,
in a temporary consumer. That is `packages/core/test/cookbook.test.ts`, and running it is
also how you check an example after changing it:

```bash
pnpm --filter @pixel/core exec vitest run test/cookbook.test.ts
```

Files land in `./generated/` unless you say otherwise:

```bash
DOTLOOM_COOKBOOK_OUT=out node --experimental-strip-types cookbook/02-walk-cycle.ts
```

**When artwork legitimately changes, regenerate the byte expectations and read the diff:**

```bash
DOTLOOM_COOKBOOK_UPDATE=1 pnpm --filter @pixel/core exec vitest run test/cookbook.test.ts
```

That rewrites the `outputs` block of each entry in [`cookbook/manifest.json`](../cookbook/manifest.json) —
path, length and sha256 of every file the example produced. A diff there means the pixels
moved, which is the point: an asset that changes when nobody changed it is a bug, and this
is where it surfaces.

---

## 1. Your first sprite

[`cookbook/01-first-sprite.ts`](../cookbook/01-first-sprite.ts)

A slime, in the order a pixel artist works in: **silhouette flat, shading inside it, contour
last.** The order is not stylistic. Every later pass is judged against whether the first one
was right, and a contour drawn before the shading separates nothing.

```ts
const slime = buildSprite({
  seed: 20260927,
  width: 16,
  height: 16,
  name: 'slime',
  palette: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f', '#deeed6'],
  layers: ['base', 'shade', 'outline'],   // bottom first
  ops: [
    { command: 'draw_ellipse', params: { layer: 'base',    rect: { x: 2, y: 5, w: 12, h: 9 }, color: '#8bac0f' } },
    { command: 'draw_ellipse', params: { layer: 'shade',   rect: { x: 4, y: 9, w: 8,  h: 4 }, color: '#306230' } },
    { command: 'draw_ellipse', params: { layer: 'shade',   rect: { x: 3, y: 8, w: 10, h: 4 }, color: '#9bbc0f', fill: false } },
    { command: 'draw_rect',    params: { layer: 'shade',   rect: { x: 5, y: 8, w: 1, h: 2 }, color: '#0f380f' } },
    { command: 'draw_rect',    params: { layer: 'shade',   rect: { x: 10, y: 8, w: 1, h: 2 }, color: '#0f380f' } },
    { command: 'draw_ellipse', params: { layer: 'outline', rect: { x: 2, y: 5, w: 12, h: 9 }, color: '#0f380f', fill: false } },
  ],
});

const files = exportAssets(slime, { frames: true, sheet: true, source: true });
```

Five things in that snippet that are worth copying:

- **`ops` is the same command catalogue** the GUI and the MCP tool surface use. `list_commands`
  documents these ops; there is no second dialect for build scripts.
- **`layer` and `frame` are optional.** Omit them and the bottom layer of frame 0 are filled
  in — from the same function in core that the MCP surface uses, so a build script and an
  agent spell their ops identically.
- **A mistyped parameter is an error, never a silent default.** `.strict()` schemas mean
  `ops[3] (draw_rect) failed: …` names the op that was wrong.
- **`exportAssets` returns bytes and touches no filesystem.** Where they go is your build
  script's business. A plan that selects nothing throws, because a build that produces no
  files and reports success is the worst outcome available.
- **`sheet: true` is two files.** The PNG is what the engine slices; the `.json` beside it is
  what says where each frame is, how long it lasts, and which tag it belongs to. An image
  without its table is a picture.

---

## 2. A walk cycle and eight directions

[`cookbook/02-walk-cycle.ts`](../cookbook/02-walk-cycle.ts)

Ask the plan before you draw anything:

```ts
const model = getDirectionModel({ width: 32, height: 32 });
model.exact;        // ['N', 'E', 'S', 'W']     — a turn and/or a mirror reproduces these exactly
model.approximate;  // ['NE', 'SE', 'SW', 'NW'] — no pixel-exact 45° transform exists; draw these
model.pivot;        // { x: 15.5, y: 31 }       — bottom centre, the contact point under the feet
```

**An eight-direction character is three drawings, not eight sheets.** Four of the eight are
exact transforms of the base `E` drawing. The four diagonals are not, because there is no
pixel-exact 45° transform and this engine will not approximate one — so they need artwork of
their own, and the plan says so instead of quietly substituting a cardinal.

Then one call per direction:

```ts
const walk = buildWalkAnimation({
  seed: 4242, width: 32, height: 32, name: 'hero-e',
  layers: ['body', 'legL', 'legR', 'armL', 'armR'],
  direction: 'E',
  walk: { frames: 6, frameDurationMs: 110, stride: 3, tagName: 'walk_e' },
  ops: [ /* create_rig, then the rest pose, drawn once */ ],
});
```

- **A rig is what makes a gait possible.** `create_rig` gives each part a pivot; a leg with no
  pivot has no swing, it has a slide. The parts are also layers, so each part's pixels survive
  into the frames the generator bakes.
- **The loop closes.** The gait is integer triangle waves sampled modulo `frames`, so frame
  `frames` is the *same pose* as frame 0. No duplicated end frame, therefore no seam.
- **Walk poses are transient.** They are baked into frames and never pushed into the rig, so a
  document does not accumulate one pose per frame per direction. Use a `save_pose` op for a
  stance you want to keep.
- **Give the character one asymmetric detail.** The hero in this example carries a satchel on
  one side. A left-right symmetric character mirrors onto itself, so `E` and `W` come out
  byte-identical and four directions become two sheets wearing four names. The test asserts
  `hero-e_sheet.png` and `hero-w_sheet.png` differ, which is how that stays true.

---

## 3. Tracing an SVG

[`cookbook/03-trace-svg.ts`](../cookbook/03-trace-svg.ts)

```ts
const icon = traceSvg({
  svg: await readFile('assets/leaf.svg', 'utf8'),
  width: 16, height: 16, name: 'leaf',
  palette: ['#1a1c2c', '#5d275d', '#9bbc0f', '#ffcd75'],
  scale: 4,          // 64 SVG user units across 16 pixels
});
```

- **`svg` is text, not a path.** Core has no filesystem; you read the file.
- **`scale` is SVG units per pixel**, not the other way round. A 64-unit icon into a 16px
  canvas is `4`. Backwards lands the artwork at a quarter size, which looks like a tracer bug
  and is a wrong number.
- **Coverage is hard-edged by design.** A traced outline is a pixel edge, not a ramp of
  half-transparent alphas. Run an `antialias` op afterwards if the staircase is too coarse.
- **Refusals are named, not approximated.** No `transform`, no `<g>` with an inherited `fill`,
  no `fill: url(#gradient)`, no stroke-only shape. The example writes the refusal out:

```text
code: command_failed
details.code: invalid_params
reason: svg_unsupported
```

The nesting is real and worth knowing once: the bus re-wraps every command failure, so the
error you catch has code `command_failed` and the reason that says something about the *SVG*
is at `error.details.details.reason`. That is the shape every op in this API throws.

---

## 4. Exporting for an engine

[`cookbook/04-engine-export.ts`](../cookbook/04-engine-export.ts)

A game does not read a PNG. It reads a sheet, a frame table and a pivot convention, and each
engine spells those three differently. `exportEngineAssets` takes the one contract and writes
one engine's files:

```ts
const bundle = exportEngineAssets(sprite, {
  engine: 'godot',                     // 'godot' | 'unity' | 'phaser' | 'excalidraw'
  sheet: { layout: 'grid', columns: 4 },
  directions: ['S', 'S', 'S', 'S'],   // one per frame, timeline order
});
for (const file of bundle.files) {
  await writeFile(join('assets', bundle.root, file.path), file.bytes);
}
console.log(bundle.warnings);
```

- **`warnings` is a lossiness list, not a score.** For the example's non-uniform 110/90 ms
  timing, Godot says so in a sentence:

  > Animation "idle" has non-uniform frame durations (110/90/110/90/110/90 ms). Godot's
  > SpriteFrames carries one speed per animation, so this plays at 10 fps with every frame held
  > 100.000 ms. Drive SpriteFrames from meta.frames.durationsMs in script for the exact timing.

  Unity keeps per-frame timing and warns about nothing, which is why the example uses an
  animation with mixed durations: uniform timing hides every lossy mapping there is.
- **`directions` is a caller option, never derived.** An unrecognised label is refused rather
  than dropped, because a character that silently faces the wrong way in the game is not
  traceable from the sheet.
- **A naming error refuses the whole call**, before a byte is produced:

```text
code: invalid_params
Asset naming refuses this bundle: 1 error(s) [reserved-name]. First: "outputs[0].path" -
"CON.png" is a reserved Windows device name. …
```

  A bundle whose files break on a Windows build machine is a broken build, and the mistake is
  far better found here than in CI naming nothing.
- **`meta.json` comes along by default.** Every importer reads a contract, and a contract is
  what makes the engine files regenerable, diffable and checkable.

---

## 5. One recipe, end to end

[`cookbook/05-recipe-ui-icon.ts`](../cookbook/05-recipe-ui-icon.ts)

A **recipe** ([`recipes/ui-icons.recipe.json`](../recipes/ui-icons.recipe.json)) is a reusable
art-direction brief: what size to build, how to build the palette, which layers exist, where
the light comes from, the order to work in, the mistakes this class keeps making. It is not a
script — it names constraints, and the drawing still happens through ordinary commands.

1. **Read it, and validate it.** `core.parseRecipe` is the same schema `describe_recipe` uses,
   so a recipe that does not validate is not followed. `DOTLOOM_RECIPE` points the example at
   another recipe file: every **number** then follows that recipe — canvas, layers, palette,
   `locked` — while the drawing does not. The recipe decides the constraints; the drawing
   decides the mark. A build script that wanted a whole set branches on `recipe.id`.
2. **Take the numbers from it.** `canvas.sizes[0]` is the default size because the recipe says
   so; `layers[]` are bottom first; `palette.base` seeds the palette and one `add_palette_ramp`
   per `palette.roles[]` appends to it; `palette.locked` becomes `paletteLocked`.
3. **Draw to the recipe.** One flat colour for the mark, then `clear_region` for the opening —
   the negative space is what makes an icon mean anything, and at 16px the detail that would
   fill it is detail nobody can resolve.
4. **Answer its checks.** They are questions with yes/no answers and a read-only tool, never
   scores:

```json
{
  "markFills10to12": true,
  "markBounds": { "x": 3, "y": 3, "w": 10, "h": 11 },
  "recipe": "ui-icons",
  "defects": [
    { "dimension": "value", "code": "flat-value",
      "message": "one lightness bucket holds 1000/1000 of the solid pixels; the form is not being described by tone at all." },
    { "dimension": "silhouette", "code": "thin-profile",
      "message": "profile 63/1000 (compactness 92/1000, thickness 63/1000 at 1px in a 16x16 canvas): the shape is too thin to read at game scale; thicken it, or give the sprite more pixels." }
  ]
}
```

### Why the output is defect *names* and not a score

There was a `quality_report` tool once. It was deleted in 0.3.1, and the reason is the single
most important design lesson in this project: **a model, told a number was "clean", sanded a
lake into a dark flat rectangle.** Any score handed to an agent becomes the target instead of
the artwork. That is Goodhart's law arriving on schedule.

So this repository ships procedural craft guidance and a read-only perception channel rather
than a verdict. `evaluate` still *computes* `score`, and the recipe example calls it — but what
it prints is the issue names and the sentence attached to each, which is a to-do list. The
test enforces this structurally rather than by convention: **no JSON file any example writes may
carry a `score`, `scoreQ`, `severityQ` or `verdict` key.** Add one and the cookbook test fails.

A defect without a remedy is a platitude, so each issue ships with what to do about it. The
repair itself is mechanical for some codes and absent for others; `fix` turns the ones that have
a safe op into `{command, params}` data you apply through the bus, and says so in prose for the
ones that do not. It never edits a pixel itself.

---

## What the test checks, and what it does not

`packages/core/test/cookbook.test.ts`:

| Claim | How it is checked |
| --- | --- |
| Every example is registered | `cookbook/*.ts` and `manifest.json` must list the same files, in both directions |
| Nothing in `cookbook/` is unaccounted for | Any file that is not `manifest.json` and not an example fails |
| Every example typechecks | A consumer's own `tsc`, `strict`, `skipLibCheck: false`, against the **packed tarball** through the `exports` map |
| Every example uses the published specifier | Each import is asserted to be `dotloom-mcp`, never a relative path |
| Every example runs | Its own top-level `main()` in a child process; a throw fails with the file's own output |
| Every example writes files | The output directory is listed and must be non-empty |
| Same spec, same bytes | Every example runs **twice** and the two runs are compared to each other |
| Same bytes as committed | Length and sha256 of every produced file, with the exact key set both ways |
| Each chapter keeps its claim | The mirror runs, the tracer names `svg_unsupported`, Godot and Phaser warn and Unity does not, `CON.png` is refused, the mark fills 10–12 of 16 |
| No score to optimise | No JSON output may carry `score`, `scoreQ`, `severityQ`, `verdict` or `quality` |
| The prose tracks the code | `docs/COOKBOOK.md` must mention every example file and chapter heading |

**What is not compared:** nothing, today. All five examples are pure functions of their inputs,
so every produced byte is committed to the manifest. The manifest schema has room for a
`bytes: false` exemption with a mandatory reason, because an example that genuinely cannot be
deterministic should still be compiled and run — and a test asserts that **no example uses one
today**, so the exemption cannot quietly become the norm.

**The one thing a byte comparison cannot see:** whether the artwork is any good. The manifest
pins what the pipeline produced, not that it was the right answer. Judging the pictures is
[`docs/EVALUATION.md`](EVALUATION.md)'s job, and it needs human raters.

---

## Known gaps this cookbook ran into

Two, both reported rather than papered over:

1. **A recipe names its base palette by preset id (`endesga16`), and the library entry cannot
   resolve preset names.** The MCP tool surface resolves them; the npm entry takes colours, and
   `docs/API.md` says outright that a ramp *name* is deliberately not accepted. The example
   reads the preset table from the `mcp` namespace and says so in a comment. Promoting
   `resolveBuiltinPalette` to the stable entry would remove that line and the `mcp` import.
2. **`recipes/` is not in the package's `files` list**, although `docs/API.md` says the bundle
   ships the recipes directory. Chapter 5 therefore treats the recipe as a file the project
   vendors next to its build script, which is what the example does either way.

---

## Related

- [`docs/API.md`](API.md) — the library reference: every field, plan option and error code.
- [`docs/ASSET-CONTRACT.md`](ASSET-CONTRACT.md) — what `meta.json` means, field by field.
- [`docs/IMPORTERS.md`](IMPORTERS.md) — what each of the four engines does with it, and what
  each one loses.
- [`recipes/README.md`](../recipes/README.md) — the recipe format, and how to add one.
- [`docs/REFERENCE.md`](REFERENCE.md) — the full command catalogue, for an op this document
  has not used yet.
