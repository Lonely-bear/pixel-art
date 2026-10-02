# Recipes

A **recipe** is a reusable, declarative art-direction brief for one class of game asset.
It tells an agent *how to make this kind of asset well*: what size to build, how to build the
palette, which layers exist and what belongs on each, where the light comes from, the order
to work in, the mistakes this class keeps making, and the questions to ask at each gate.

It is **not a script and not a command sequence.** Everything a recipe prescribes is
executed through the ordinary tool surface — `create_sprite_spec`, `add_palette_ramp`,
`apply_ops`, `run_script`, `read_grid`, `get_preview`. A recipe *names* tools; it never calls
them. That is why a recipe needs no command of its own, why it cannot drift from the command
surface the way a stored op list would, and why adding one touches no code.

## Layout

```
recipes/
  README.md                 <- this file
  <id>.recipe.json          <- one recipe per file, filename = id + ".recipe.json"
```

One file per recipe, flat, no subdirectories. The filename stem **is** the id, and the id is
the path segment in `pixel://recipe/{id}` (T-036), so the two cannot drift: `validateRecipe`
takes the filename and refuses a recipe whose `id` disagrees with it
(`RecipeIssueCode: 'id_mismatch'`). A recipe is plain UTF-8 JSON with no comments and no
trailing commas — it has to survive `JSON.parse` in every client, including the browser one.

`packages/core/src/recipes.ts` owns the schema and the validation. It deliberately **does not
read the filesystem** — `packages/core` may not import Node APIs — so it exposes
`parseRecipe(text, {fileName})`, and the caller does one `readFileSync`. That split is what
keeps the future `describe_recipe` tool a three-liner instead of a second copy of the schema.

## Adding a recipe

Add `recipes/<id>.recipe.json`. **Nothing else changes.** There is no registry, no index, no
manifest and no code path to edit: a catalogue loader reads the directory, and the schema is
the only definition of what a recipe is. That is the whole reason the format is data.

Steps, in order:

1. Pick a kebab-case `id` and name the file after it.
2. Copy `platformer.recipe.json` as the shape to work from. Every field is required unless
   marked optional in the table below.
3. Validate it: `pnpm --filter @pixel/core exec vitest run test/recipes.test.ts` runs every
   `recipes/*.recipe.json` on disk through `validateRecipe`, so a new recipe is checked by
   adding it and running the tests.
4. Write the `avoid` entries last and be honest. A prohibition without an `instead` is a
   platitude, and `instead` is required for exactly that reason.

## Schema version and the migration rule

Every recipe declares `schemaVersion`, an integer. `RECIPE_SCHEMA_VERSION` in
`recipes.ts` is what this build reads, and `SUPPORTED_RECIPE_VERSIONS` is the set it accepts.

- **Additive changes do not bump the version.** A new *optional* field, or a new member on an
  existing enum, is backward compatible by construction: every object is `.strict()` about
  *known* keys, a missing optional field falls back to its documented default, and an older
  reader ignores a key it does not know. This is what keeps "add a recipe" from also meaning
  "edit the loader".
- **Anything else bumps it.** Removing a field, renaming one, narrowing a type, moving a
  bound, or changing the *meaning* of a value all invalidate files that already parse. Those
  take the next integer **and** add an entry to `RECIPE_MIGRATIONS` in the same commit, keyed
  by the version it reads.
- **A file outside the supported set is rejected, never interpreted.** The version is checked
  before the shape and returns immediately, so a v2 recipe is never partially validated
  against v1 expectations. The alternative — reading it on a best guess — produces a
  plausible recipe that says the wrong thing, which is worse than refusing: the reader cannot
  tell it got it wrong.

A migration is a pure function from a document at version *n* to the same document at
*n+1*, so it never has to know about other versions. `migrateRecipe` applies them in
ascending order and **refuses an unmigratable source rather than interpolating it** — a
recipe older than the first migration has fields whose meaning is unknown, and guessing at
those is the same failure as guessing at a newer one.

## The rule that shapes the format: no number to chase

`AGENTS.md` records what happened when a `quality_report` tool existed — an agent told the
number was "clean" sanded a lake into a dark flat rectangle. A recipe is the same hazard
wearing better clothes, because a recipe is *entirely* numbers and prose about craft. It is
one small step from becoming a target.

So the line is drawn **structurally, not by asking authors to be careful**:

> **A recipe carries construction numbers and no scores.**

A canvas of 32×32, three ramps of three steps, a 120 ms walk cycle, a twelve-colour budget
are all decisions about *what to build*. Each is a different answer to "how do I make this",
and none of them improves by looking harder at a finished picture.

There is deliberately **no field anywhere in the schema** for a target quality, a threshold
to clear, a percentage, or a dimension to optimise — and the top-level object is `.strict()`,
so adding one is a schema change that has to be argued for in review rather than something a
recipe author can slip in with a stray key. When a check needs a number it belongs in
`docs/EVALUATION.md`, which is calibrated against human raters, not in an art-direction brief
that no human ever rated.

This is also why `checks` are *questions with yes/no answers* and a read-only tool, never
scores. A check that hands back a number is the thing the agent optimises against.

## Fields

| Field | Required | What it is |
| --- | --- | --- |
| `schemaVersion` | yes | Integer version of this format. |
| `id` | yes | Kebab-case, equal to the filename stem. Serves `pixel://recipe/{id}`. |
| `title` | yes | Human-readable. |
| `summary` | yes | One paragraph. What this class is, what makes it hard, and the single decision that separates a good one from a bad one. Read before the file is opened at all. |
| `canvas.sizes[]` | yes | `{w, h, use}`, smallest first. The first is the default. `w`/`h` are 1–4096, the same bound `create_document` enforces. |
| `canvas.note` | yes | How the method changes with size. Size-dependent craft rules live here. |
| `palette.base` | no | Built-in palette to seed the document with, e.g. `dawnbringer16`. |
| `palette.locked` | yes | Create with `paletteLocked: true`, and say why in `palette.rules`. |
| `palette.roles[]` | yes | One per material: `{role, from, to, steps?, hueShift?}`. `ensure_palette_role` **appends**, so the palette ends up larger than the sum of the ramps. |
| `palette.colourBudget` | yes | Distinct swatches the artwork should actually *use*. A construction number, and it is smaller than the palette when `base` is set. |
| `palette.rules[]` | yes | Positive construction rules. Prohibitions belong in `avoid`. |
| `layers[]` | yes | `{name, purpose}`, **bottom first**, matching how layers are indexed. |
| `tone.lightFrom` | yes | Compass direction, e.g. `top-left`. Every shadow and highlight must agree with it. |
| `tone.planes[]` | yes | ≥ 2, lightest to darkest. `{name, rule}`; `rule` is a placement instruction, not a mood. |
| `tone.contrast` | yes | What the darkest plane reads against, and how far it may sit from the next plane up. |
| `motion` | **no** | `{loops[], note}`. Omit entirely for a static class — the absence is the statement, which is why it is optional rather than present-and-empty. |
| `steps[]` | yes | `{id, layer, goal}`, in production order. Array order is the order. |
| `avoid[]` | yes | `{what, why, instead}`. `instead` is required: a prohibition without an alternative is a platitude. |
| `checks[]` | yes | `{question, tool, view?}`. `question` has a yes/no answer; `tool` is one of the read-only tools below. |
| `notes` | no | Anything that fits nowhere else. Omit rather than pad. |

`tool` in a check must be one of `RECIPE_CHECK_TOOLS`: `read_grid`, `get_preview`,
`get_pixels`, `histogram`, `measure_region`, `preview_animation`, `preview_tilemap`. It is a
closed enum because a check that names a tool which does not exist costs the agent a failed
call and a re-read of the tool list, and a check that mutates the artwork is not a check. An
unknown name is `unknown_check_tool`.

## Why a recipe is refused

`validateRecipe` returns every reason, not the first, in a fixed order — structural, then
version, then id, then the cross-field checks in declaration order — so two runs over the same
input are byte-identical and a CI diff means the recipe changed, not the run. No clock, no
randomness, nothing locale-dependent.

Reasons are a closed union, `RecipeIssueCode`, and they are an **API**: add a member freely,
renaming or repurposing one is breaking, and a caller branches on the code rather than
parsing the message. Same terms as `ExcludedReason` in `quality/types.ts`.

| Code | Means | Repair |
| --- | --- | --- |
| `not_an_object` / `not_json` | The file is not a recipe document. | Re-read the file. |
| `schema_violation` | A field is missing, mistyped, or carries an unknown key. | Fix the field named in `path`. |
| `unknown_version` | `schemaVersion` is missing, non-integer, or not one this build implements. | Upgrade, or migrate. |
| `id_mismatch` | The recipe is valid but the filename claims a different id. | Rename one of them. |
| `duplicate_layer` | Two layers share a name, so every step naming it is ambiguous. | Rename. |
| `duplicate_step` | Two steps share an id. | Rename. |
| `unknown_layer_reference` | A step paints on a layer the recipe does not declare. | Declare it, or fix the step. |
| `unknown_check_tool` | A check names something that is not a read-only tool. | Use one from the enum. |

The last four are the ones a per-field schema cannot see, and they are the reason this is not
just `recipeSchema.safeParse`. A step pointing at a layer nobody declared is a recipe that
sends an agent to paint on a layer which does not exist.

`ValidationIssue` and `ValidationOutcome` are generic in the code type rather than typed to
recipes, because T-055 (the naming validator) hands back the same shape with its own
vocabulary and should not have to invent a second one.

## Worked example

`recipes/platformer.recipe.json`, abridged to the parts that carry decisions. Every value below is
copied from the file; the **arrays are non-contiguous excerpts**, so `checks[1]` here is not
the file's `checks[1]` — read the real file for positions. The values are what the file says;
the *kinds* of value are the point.

```jsonc
{
  "schemaVersion": 1,
  "id": "platformer",
  "title": "Platformer character",

  "canvas": {
    "sizes": [
      { "w": 16, "h": 16, "use": "Small player. The head is 6px, so an eye is one pixel." },
      { "w": 32, "h": 32, "use": "Default. Room for four tone planes and a visible stride." }
    ],
    // Size-dependent craft lives here rather than in the tool.
    "note": "Below about 64px, dither is a mistake rather than a technique..."
  },

  "palette": {
    // Seeds the constraint set. `roles` then append, so the palette ends up
    // bigger than `colourBudget` — that gap is the point.
    "base": "dawnbringer16",
    // The cost of discipline, stated rather than assumed.
    "locked": true,
    "roles": [
      { "role": "skin",  "from": "#854c30", "to": "#d2aa99", "steps": 3, "hueShift": 25 },
      { "role": "cloth", "from": "#30346d", "to": "#8595a1", "steps": 3, "hueShift": 20 }
    ],
    // Swatches the artwork actually uses, not palette size. A construction
    // number: how many ramps to build and keep. Not a score to raise.
    "colourBudget": 12,
    "rules": ["Keep every ramp's anchors close in hue, or the midpoint comes out magenta..."]
  },

  // Bottom first, matching how layers are indexed in the document.
  "layers": [
    { "name": "base",    "purpose": "Flat blocked shapes. No shading, no outline." },
    { "name": "shade",   "purpose": "Value planes: core shadow, occlusion, rim." },
    { "name": "outline", "purpose": "1px contour, drawn last, selective by design." }
  ],

  "tone": {
    "lightFrom": "top-left",
    // ≥ 2 because one plane carries no form, and two planes of equal
    // lightness do not exist to the eye.
    "planes": [
      { "name": "core-shadow",
        "rule": "Nested one step inside the silhouette, following the contour. Never a straight diagonal across the torso: same contrast, flat sticker." },
      { "name": "occlusion",
        "rule": "One step below the core shadow, only where forms meet. Never on a free edge." }
    ],
    "contrast": "At least two ramp steps between lit and shadow..."
  },

  // Array order is the production order, and every `layer` must be one the
  // recipe declares — otherwise the file does not validate.
  "steps": [
    { "id": "block-silhouette", "layer": "base",  "goal": "The whole character flat, before any tone." },
    { "id": "core-shadow",      "layer": "shade", "goal": "Lay the shadow planes. This decides whether the character has a body." },
    { "id": "outline",          "layer": "outline", "goal": "1px contour, dark version of the local fill, gaps where the light hits." }
  ],

  // `instead` is required. A prohibition without an alternative is a platitude,
  // and platitudes are the failure mode this section exists to prevent.
  "avoid": [
    {
      "what": "A straight diagonal shadow band across the torso, at any contrast.",
      "why": "Describes a sticker, not a volume. Invisible in a thumbnail, unmistakable at 1:1.",
      "instead": "Walk the silhouette rows in by 2px and displace them along the light axis."
    }
  ],

  // Questions with yes/no answers plus a read-only tool. Never a score.
  "checks": [
    { "question": "Does the silhouette read as one mass?",
      "tool": "read_grid",
      "view": "view: \"mask\", scope: \"cel\", layer: \"base\"" },
    { "question": "At 100%, does this still read as the character?",
      "tool": "get_preview",
      "view": "scale: 1 for the judgement, then crop-zoom a detail." }
  ]
}
```

To read one in code:

```ts
import { parseRecipe } from '@pixel/core';
import { readFileSync, readdirSync } from 'node:fs';

const recipe = parseRecipe(readFileSync('recipes/platformer.recipe.json', 'utf8'), {
  fileName: 'platformer.recipe.json',
});
if (!recipe.ok) {
  for (const issue of recipe.issues) {
    console.error(`${recipeIdFromFileName(name)} ${issue.path}: [${issue.code}] ${issue.message}`);
  }
}
```

`packages/mcp`'s server is a good second reader: `node scripts/mcp-call.mjs` will show what
the current build advertises, which is the same catalogue the MCP server walks.

## Related

- `docs/EVALUATION.md` — the scoring specification. Where the numbers that measure artwork
  live, and where a threshold belongs instead of in a recipe.
- `pixel://skill` — the general craft guide (`packages/mcp/src/skill.ts`). A recipe is the
  asset-class-specific companion to it; it does not restate it.
- `packages/core/src/quality/types.ts` — the closed enums and the fail-closed discipline
  these formats follow.