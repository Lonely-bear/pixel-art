/**
 * Recipes — a reusable art-direction brief for one class of game asset.
 *
 * A recipe is **not a script and not a command sequence.** It is prose an agent reads
 * before it draws, plus a small amount of typed data it can check itself against: what
 * size to build, how to build the palette, which layers exist and what belongs on each,
 * where the light comes from, which mistakes this asset class keeps making, and which
 * question to ask at each gate. Everything it prescribes is executed through the ordinary
 * tool surface (`create_sprite_spec`, `add_palette_ramp`, `apply_ops`, `read_grid`,
 * `get_preview`, ...) — a recipe names tools, it never calls them, which is why it does
 * not need a command of its own and why nothing in this file touches the command bus.
 *
 * ## The one thing a recipe must never contain: a number to chase
 *
 * `AGENTS.md` records what happened when a `quality_report` tool existed: an agent told
 * the number was "clean" sanded a lake into a dark flat rectangle. A recipe is the same
 * hazard wearing better clothes, because a recipe is *entirely* numbers and prose about
 * craft — it is one small step from becoming a target.
 *
 * So the format draws a hard line, and it draws it structurally rather than by asking
 * authors to be careful. **A recipe carries construction numbers and no scores.** A canvas
 * of 32x32, four ramps of three steps, a 120ms walk cycle, a budget of eight colours are
 * all decisions about what to *build*; each one is a different answer to "how do I make
 * this", and none of them can be improved by looking harder at a finished picture. There
 * is deliberately no field anywhere in this schema for a target quality, a threshold to
 * clear, a percentage, or a dimension to optimise — and the top-level object is
 * `.strict()`, so adding one is a schema change that has to be argued for in review
 * rather than something a recipe author can slip in with a stray key. When a check needs
 * a number it belongs in `dev/EVALUATION.md`, which is calibrated against human raters,
 * not in an art-direction brief that no human ever rated.
 *
 * ## Why the validation lives here and not in `packages/mcp`
 *
 * `packages/core` is the only package that may not import Node APIs, so this file cannot
 * read `recipes/*.recipe.json` itself. It therefore owns the *pure* half — the schemas, the
 * machine-readable failure reasons, and the migration rule — and exposes
 * {@link parseRecipe}, which turns a string into either a validated recipe or a list of
 * reasons. The filesystem half is one `readFileSync` in the caller. That split is what
 * keeps `describe_recipe` (T-036) a three-line tool instead of a second copy of the schema.
 *
 * The reason codes are a closed enum and they are an API, on the same terms as
 * {@link ExcludedReason} in `quality/types.ts`: adding a code is safe, renaming or
 * repurposing one is breaking, and a caller branches on the code rather than parsing the
 * message. T-055 (the naming validator) reuses {@link ValidationOutcome} and
 * {@link ValidationIssue} with its own code enum, which is why they are generic in the
 * code rather than typed to recipes.
 */

import { z } from 'zod';

/**
 * The recipe schema version this build reads.
 *
 * A number, not a string, so `1` and `"1"` are different inputs and only one of them is a
 * recipe. See {@link SUPPORTED_RECIPE_VERSIONS} for the rule on what a change may do.
 */
export const RECIPE_SCHEMA_VERSION = 1;

/**
 * Every schema version this build can read, in ascending order.
 *
 * The rule, stated once so a schema change cannot be made by accident:
 *
 *   - **Additive changes do not bump the version.** A new *optional* field, or a new
 *     member on an existing enum, is backward compatible by construction — an older
 *     reader ignores a key it does not know because every object here is `.strict()`
 *     only about *known* keys, and a missing optional field falls back to the documented
 *     default. This is what keeps "add a recipe" from also meaning "edit the loader".
 *   - **Anything else bumps it.** Removing a field, renaming one, narrowing a type,
 *     changing a bound, or changing the *meaning* of a value all invalidate files that
 *     already parse. Those get the next integer, plus an entry in {@link RECIPE_MIGRATIONS}
 *     in the same commit.
 *   - **A file outside this set is rejected, never interpreted.** A recipe written for a
 *     newer build is refused rather than read on a best guess, because the failure this
 *     avoids is a reader silently applying v1's meaning to a field v2 redefined — which
 *     produces a plausible recipe that says the wrong thing.
 *
 * "Meanings" are the reason the last clause matters. A v2 that added an optional
 * `tone.planes[].name` needs no migration; a v2 that changed `tone.lightFrom` from a
 * compass direction to a normalised vector does, and no amount of shape checking can tell
 * those apart.
 */
export const SUPPORTED_RECIPE_VERSIONS: readonly number[] = [RECIPE_SCHEMA_VERSION];

/**
 * Kebab-case slug, matching the filename stem of the recipe that carries it.
 *
 * The rule is here rather than in prose because it is load-bearing for `pixel://recipe/{id}`
 * (T-036): the id is the URI path segment, so a slug that is not lowercase-and-dashed
 * produces a resource URI nobody can type and a mismatch between what the catalogue says
 * and what the server serves.
 */
export const RECIPE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The filename a recipe with this id lives in. The inverse of {@link recipeIdFromFileName}. */
export function recipeFileName(id: string): string {
  return `${id}.recipe.json`;
}

/**
 * The id a filename claims, or `null` when the filename is not a recipe file.
 *
 * `null` rather than a thrown error because the caller is usually walking a directory and
 * wants to *skip* the files that are not recipes (a `README.md`, a licence) rather than
 * fail on them.
 */
export function recipeIdFromFileName(name: string): string | null {
  const match = /^(.+)\.recipe\.json$/.exec(name);
  if (match === null) return null;
  return match[1];
}

/* ------------------------------------------------------------------ *
 * Failure reporting
 * ------------------------------------------------------------------ */

/**
 * One reason something is invalid, addressed to the thing that failed.
 *
 * Generic in the code so T-055's naming validator can hand back the same shape with its
 * own vocabulary instead of inventing a second one. `path` is a dotted path with numeric
 * segments in brackets (`steps[2].layer`), empty string for the document itself.
 */
export interface ValidationIssue<C extends string = string> {
  /** Stable, branchable reason. Never parse `message`; rename the code if the meaning changes. */
  readonly code: C;
  /** Where it failed. Empty string means the whole document. */
  readonly path: string;
  /** For a person. Explain the fix; carry no meaning an agent would have to parse. */
  readonly message: string;
}

/**
 * The result of validating something: the value, or every reason it was refused.
 *
 * All reasons at once rather than the first, because the caller is usually a catalogue
 * loader that wants to report a whole broken file in one response, and because an agent
 * handed three precise reasons repairs three things in one pass instead of discovering
 * them one round trip at a time.
 */
export type ValidationOutcome<T, C extends string = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue<C>[] };

/**
 * Why a recipe was refused.
 *
 * A closed enum, on `ExcludedReason`'s terms: the strings are an API that a caller branches
 * on, so adding a member is additive and renaming or repurposing one is breaking. Every
 * member answers one question — *what kind of wrong is this?* — and each is a different
 * repair:
 *
 *   - `not_json` / `schema_violation` — the file is not a recipe document at all. Re-read
 *     the file; do not try to repair the recipe from what the reader made of it.
 *   - `not_an_object` — same conclusion, reported before parsing because it is the one
 *     case where the shape check has nothing to say.
 *   - `unknown_version` — the recipe targets a schema this build does not implement. This
 *     is the only code that means "upgrade", and it is checked *before* the shape so a
 *     newer recipe is never partially validated against older meanings.
 *   - `id_mismatch` — the recipe is valid but the file it sits in claims a different id,
 *     which would serve the wrong bytes at `pixel://recipe/{filename}`.
 *   - `duplicate_layer`, `duplicate_step`, `unknown_layer_reference`, `unknown_check_tool`
 *     — cross-field faults that a per-field schema cannot see, each of which makes a step
 *     in the recipe ambiguous or unusable rather than merely wrong.
 */
export type RecipeIssueCode =
  | 'not_an_object'
  | 'not_json'
  | 'schema_violation'
  | 'unknown_version'
  | 'id_mismatch'
  | 'duplicate_layer'
  | 'duplicate_step'
  | 'unknown_layer_reference'
  | 'unknown_check_tool';

/** Render a zod path as the dotted form {@link ValidationIssue.path} documents. */
function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`;
    } else {
      out += out.length === 0 ? String(segment) : `.${String(segment)}`;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The recipe
 * ------------------------------------------------------------------ */

/**
 * The closed set of tools a `checks` entry may name. Every one of them is read-only.
 *
 * A closed set rather than free text because a check that names a tool which does not exist
 * costs the agent a failed call and a re-read of the tool list — the check is the one part of
 * a recipe that has to be mechanically followable, or the recipe has failed at the only job it
 * can be trusted to do. Read-only is the other half of that: a check that mutates the artwork
 * cannot be used to verify it, and an agent following a recipe that told it to would corrupt
 * the very thing it was checking.
 *
 * **This list spans two namespaces, deliberately.** Six are MCP session tools; `measure_region`
 * is a core *command* (`readOnly: true` in `commands/draw.ts`) that the session surface promotes
 * to a tool on lookup like any other. A recipe names the capability, not the namespace it happens
 * to live in, and splitting the enum by namespace would force a recipe author to know whether a
 * tool was advertised by default or promoted — which is exactly the sort of transient surface
 * decision that should not be baked into a document that outlives it.
 *
 * Adding a tool here is additive and needs no schema bump. Removing or renaming one is a
 * breaking change for every recipe that names it, which is why the set is small and each
 * member is a perception primitive rather than a convenience wrapper.
 */
export const RECIPE_CHECK_TOOLS = [
  'read_grid',
  'get_preview',
  'get_pixels',
  'histogram',
  'measure_region',
  'preview_animation',
  'preview_tilemap',
] as const;

/** A tool a {@link RecipeCheck} may name. Derived from {@link RECIPE_CHECK_TOOLS}. */
export type RecipeCheckTool = (typeof RECIPE_CHECK_TOOLS)[number];

/**
 * The largest canvas a document may have, from `create_document`'s own bound.
 *
 * A recipe proposing a bigger canvas is proposing a document the product cannot create, so
 * the bound is checked here rather than trusted to the caller. It is a construction
 * number — the answer to "how big may this be" — not a quality target.
 */
export const RECIPE_MAX_CANVAS_EDGE = 4096;

const recipeIdSchema = z
  .string()
  .regex(RECIPE_ID_PATTERN)
  .describe(
    'Stable kebab-case id, equal to the recipe filename without the `.recipe.json` suffix, ' +
      'e.g. "platformer" or "ui-icons". It is the path segment in pixel://recipe/{id}, so ' +
      'it must match the file it lives in exactly.',
  );

const canvasSizeSchema = z
  .object({
    w: z
      .number()
      .int()
      .min(1)
      .max(RECIPE_MAX_CANVAS_EDGE)
      .describe('Canvas width in pixels, 1-4096.'),
    h: z
      .number()
      .int()
      .min(1)
      .max(RECIPE_MAX_CANVAS_EDGE)
      .describe('Canvas height in pixels, 1-4096. A non-square canvas suits a non-square asset.'),
    use: z
      .string()
      .min(1)
      .describe(
        'What this size is for and what it buys or costs, e.g. "default player character; a ' +
          '3px dithered seam is a tenth of this width, so build transitions from solid steps".',
      ),
  })
  .strict();

const paletteRoleSchema = z
  .object({
    role: z
      .string()
      .min(1)
      .describe(
        'Material name, e.g. "skin" or "leather". This is the value `ensure_palette_role` and ' +
          '`add_palette_ramp {role}` bind to, so it is also the handle later passes use.',
      ),
    from: z
      .string()
      .min(1)
      .describe('Dark anchor colour as `#rrggbb`. Keep it close in hue to `to` — see the recipe notes.'),
    to: z.string().min(1).describe('Light anchor colour as `#rrggbb`.'),
    steps: z
      .number()
      .int()
      .min(2)
      .max(32)
      .optional()
      .describe('Ramp length. Defaults to 5 if the caller omits it; a character rarely wants more than 3.'),
    hueShift: z
      .number()
      .min(0)
      .max(90)
      .optional()
      .describe(
        'Degrees to pull the dark end toward blue and the light end toward amber. Non-zero is ' +
          'what stops a ramp reading as one flat tonal step. Defaults to 20 in the command.',
      ),
  })
  .strict();

const paletteSchema = z
  .object({
    base: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Built-in palette to seed the document with, e.g. "dawnbringer16" or "endesga16". This ' +
          'is the *constraint set*, and `roles` then append to it, so the finished palette is ' +
          'larger than `colourBudget` — which counts the swatches the artwork actually uses. ' +
          'Omit it to build the palette from the roles alone.',
      ),
    locked: z
      .boolean()
      .describe(
        'Create the document with `paletteLocked: true`. Snaps every painted colour to the ' +
          'nearest swatch, which is what keeps a drawn asset inside its declared palette. The ' +
          'cost is deliberate: it also rejects an off-ramp colour you actually wanted.',
      ),
    roles: z
      .array(paletteRoleSchema)
      .min(1)
      .describe('One entry per material. Two or three materials is usual for a character; more is a decision, not a default.'),
    colourBudget: z
      .number()
      .int()
      .min(2)
      .describe(
        'Distinct swatches the finished artwork should actually use, which is fewer than the ' +
          'palette holds when `base` is set — the palette is the constraint set and the budget ' +
          'is what gets painted. A *construction* number: how many ramps to build and keep. ' +
          'Not a score to raise.',
      ),
    rules: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        'Positive rules for building the palette, not prohibitions (prohibitions belong in ' +
          '`avoid`). e.g. "no pure black or pure white; reserve the extremes for a specular core".',
      ),
  })
  .strict();

const layerSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .describe(
        'Layer name, unique within the recipe. Steps address layers by this string, so a name ' +
          'that changes invalidates every step that referenced it.',
      ),
    purpose: z
      .string()
      .min(1)
      .describe(
        'What belongs on this layer and what does not, e.g. "flat blocked shapes only — no ' +
          'shading, no outline; this is the layer the silhouette is verified on".',
      ),
  })
  .strict();

const tonePlaneSchema = z
  .object({
    name: z.string().min(1).describe('What this plane is, e.g. "core-shadow" or "rim".'),
    rule: z
      .string()
      .min(1)
      .describe(
        'How to place it, stated so it can be obeyed without seeing an example. e.g. "a band ' +
          'nested one step inside the silhouette, never a straight diagonal cut across the body".',
      ),
  })
  .strict();

const toneSchema = z
  .object({
    lightFrom: z
      .string()
      .min(1)
      .describe(
        'Where the key light sits, in compass terms, e.g. "top-left". Every shadow in the asset ' +
          'must agree with it, and so must every highlight.',
      ),
    planes: z
      .array(tonePlaneSchema)
      .min(2)
      .describe(
        'The value planes, ordered from the lightest to the darkest. Two is the floor: a ' +
          'single plane carries no form, and two planes of equal lightness do not exist to the eye.',
      ),
    contrast: z
      .string()
      .min(1)
      .describe('What the darkest plane must read against, and how far it may sit from the next plane up.'),
  })
  .strict();

const motionLoopSchema = z
  .object({
    name: z.string().min(1).describe('Loop name, e.g. "walk" or "idle". Also the animation tag to create.'),
    frames: z.number().int().min(2).max(64).describe('Frame count. 2-4 is enough for a walk at small sizes; 6-8 for a run.'),
    durationMs: z.number().int().min(1).describe('Milliseconds per frame. 100-150 is a walk; a run is faster.'),
    direction: z
      .enum(['forward', 'reverse', 'pingpong'])
      .optional()
      .describe('Playback direction. Pingpong halves the frames an idle needs.'),
  })
  .strict();

const motionSchema = z
  .object({
    loops: z.array(motionLoopSchema).min(1).describe('The loops this asset class ships with.'),
    note: z
      .string()
      .min(1)
      .describe(
        'What makes the loop close, stated as a rule. e.g. "the last frame leads back into the ' +
          'first; squash before translate, because translate clears the band it vacates".',
      ),
  })
  .strict();

const stepSchema = z
  .object({
    id: z
      .string()
      .regex(RECIPE_ID_PATTERN)
      .describe('Stable kebab-case id for this step, unique within the recipe. Used to talk about the step when reviewing.'),
    layer: z
      .string()
      .min(1)
      .describe('Layer this step paints on. Must name a layer the recipe declares.'),
    goal: z
      .string()
      .min(1)
      .describe('What this step is for, in one or two sentences. The whole point of the recipe.'),
  })
  .strict();

const avoidEntrySchema = z
  .object({
    what: z.string().min(1).describe('The mistake, named concretely enough to recognise in a preview.'),
    why: z.string().min(1).describe('What it costs. One sentence, specific to this asset class.'),
    instead: z
      .string()
      .min(1)
      .describe(
        'The action to take instead. Required, because a prohibition without an alternative ' +
          'is a platitude and a platitude is the failure mode this whole section exists to prevent.',
      ),
  })
  .strict();

const checkSchema = z
  .object({
    question: z
      .string()
      .min(1)
      .describe('A question with a yes/no answer, e.g. "does the silhouette read as one mass?" — not "is the silhouette good?".'),
    tool: z
      .string()
      .min(1)
      .describe(
        `Which read-only tool answers it. One of: ${RECIPE_CHECK_TOOLS.join(', ')}.`,
      ),
    view: z
      .string()
      .min(1)
      .optional()
      .describe('The view or argument that makes the tool answer *this* question, e.g. `view: "mask"`, `scope: "cel", layer: "base"`.'),
  })
  .strict();

/**
 * The full recipe document, top level and `.strict()`.
 *
 * One flat object rather than a composition of two, because two `.strict()` objects
 * intersected reject each other's keys — a valid recipe carrying `schemaVersion` would fail
 * the body schema for having an unknown field. Strictness is also what makes "no number to
 * chase" structural: there is no field for a score, and a stray one is a schema violation
 * rather than a silently accepted key.
 *
 * `schemaVersion` is typed `z.number().int().min(1)` and the *supported* check happens in
 * {@link validateRecipe}, before the shape is even run: keeping the two apart is what lets
 * an unsupported version be reported as `unknown_version` instead of as a generic shape
 * error, and it means the reader never gets as far as interpreting a field whose meaning the
 * version may have changed.
 */
export const recipeSchema = z
  .object({
    schemaVersion: z.number().int().min(1).describe('Recipe schema version. Must be a version this build supports.'),
    id: recipeIdSchema,
    title: z.string().min(1).describe('Human-readable title, e.g. "Platformer character".'),
    summary: z
      .string()
      .min(1)
      .describe(
        'One paragraph: what this asset class is, what makes it hard, and the single decision ' +
          'that separates a good one from a bad one. This is the text an agent reads before it ' +
          'opens the file at all, so it must earn its place.',
      ),
    canvas: z
      .object({
        sizes: z
          .array(canvasSizeSchema)
          .min(1)
          .describe('The sizes this class is drawn at, smallest first, each with what it buys or costs. The first is the default.'),
        note: z
          .string()
          .min(1)
          .describe('How the method changes with size. This is where size-dependent craft rules belong, not in the tool.'),
      })
      .strict(),
    palette: paletteSchema,
    layers: z
      .array(layerSchema)
      .min(1)
      .describe('The layer stack, bottom first, matching how layers are indexed in the document.'),
    tone: toneSchema,
    motion: motionSchema
      .optional()
      .describe(
        'Animation plan. Omit it entirely for a static asset class — the absence is the ' +
          'statement that this class does not animate, and it is why the field is optional ' +
          'rather than present-and-empty.',
      ),
    steps: z
      .array(stepSchema)
      .min(1)
      .describe('Production order. The array order is the order: silhouette before shading before outline.'),
    avoid: z
      .array(avoidEntrySchema)
      .min(1)
      .describe('The mistakes this class makes, each with what it costs and what to do instead.'),
    checks: z
      .array(checkSchema)
      .min(1)
      .describe('Verification gates: questions with yes/no answers and the read-only tool that answers each one.'),
    notes: z
      .string()
      .min(1)
      .optional()
      .describe('Anything that fits nowhere else. Omit rather than pad.'),
  })
  .strict();

/** A validated recipe. The shape {@link validateRecipe} and {@link parseRecipe} hand back. */
export type Recipe = z.infer<typeof recipeSchema>;

/**
 * One version step, keyed by the version it reads.
 *
 * A migration is a pure function from a parsed document of version *n* to the same document
 * at version *n+1*. Keyed by source rather than destination so the chain is unambiguous and
 * so a missing step is a detectable hole (see {@link migrateRecipe}) instead of a silently
 * skipped version.
 *
 * Deliberately empty: version 1 is the first version, so there is nothing to migrate from.
 * It exists as the agreed shape for the first change that needs one, and
 * {@link migrateRecipe} refuses an unmigratable source rather than guessing — which is the
 * behaviour that matters, and is the part worth testing while the table is empty.
 */
export const RECIPE_MIGRATIONS: Readonly<Record<number, (raw: unknown) => unknown>> = {};

/**
 * Migrate a raw document forward to `to`, or explain why it cannot be migrated.
 *
 * Steps are applied in ascending order, one version at a time, so a migration never has to
 * know about a version other than the one it reads. Four refusals are deliberate and they are
 * four different answers:
 *
 *   - `to` is not a version this build implements — the caller asked for a format that does
 *     not exist here.
 *   - the document declares no integer `schemaVersion` — it is not a recipe at all.
 *   - the document is *newer* than `to` — migrating forward from it would mean reading a
 *     schema this build does not implement, which is the thing the rule exists to refuse.
 *   - a step from *n* to *n+1* is not registered — the file predates the first migration, and
 *     interpolating it would be guessing at fields whose meaning is unknown.
 *
 * The last is the case worth being strict about: a v0 recipe read by a v1 build is refused,
 * not coerced, because the alternative is a file that validates cleanly and says the wrong
 * thing. Every branch is reachable while {@link RECIPE_MIGRATIONS} is empty, which is what
 * makes the refusal testable before there is anything to migrate.
 */
export function migrateRecipe(raw: unknown, to: number = RECIPE_SCHEMA_VERSION): ValidationOutcome<Recipe, RecipeIssueCode> {
  const refuse = (message: string): ValidationOutcome<Recipe, RecipeIssueCode> => ({
    ok: false,
    issues: [{ code: 'unknown_version', path: 'schemaVersion', message }],
  });

  if (!SUPPORTED_RECIPE_VERSIONS.includes(to)) {
    return refuse(`This build cannot produce schema version ${to}; it supports ${SUPPORTED_RECIPE_VERSIONS.join(', ')}.`);
  }
  const declared = readSchemaVersion(raw);
  if (declared === null) {
    return refuse(`Missing or non-integer schemaVersion. A recipe must declare an integer version; this build reads ${SUPPORTED_RECIPE_VERSIONS.join(', ')}.`);
  }
  if (declared > to) {
    return refuse(
      `Recipe declares schema version ${declared}, which is newer than the requested version ${to}. ` +
        `Migrating forward cannot help: this build does not implement version ${declared}.`,
    );
  }
  if (declared === to) return validateRecipe(raw);

  let current: unknown = raw;
  for (let version = declared; version < to; version++) {
    const step = RECIPE_MIGRATIONS[version];
    if (step === undefined) {
      return refuse(
        `No migration from schema version ${version} to ${version + 1} is registered in this build. ` +
          `Refusing to read a version ${version} recipe rather than guess at its fields.`,
      );
    }
    current = step(current);
  }
  return validateRecipe(current);
}

/**
 * The declared version of a raw document, or `null` when there is not an integer one.
 *
 * Deliberately does *not* range-check. Whether a version is supported is
 * {@link SUPPORTED_RECIPE_VERSIONS}'s question and is answered where that set lives, so
 * that one place decides what "supported" means for every caller.
 */
function readSchemaVersion(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const value = (raw as { schemaVersion?: unknown }).schemaVersion;
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/** Options a caller supplies that {@link validateRecipe} cannot discover by itself. */
export interface ValidateRecipeOptions {
  /**
   * The filename the recipe was read from, when it was read from one. When supplied, the
   * recipe's `id` must equal {@link recipeIdFromFileName} of it, so a file cannot claim to
   * be `platformer` while sitting at `topdown-rpg.recipe.json` — which would otherwise serve
   * the wrong bytes at `pixel://recipe/platformer`.
   */
  readonly fileName?: string;
}

/**
 * Validate a parsed recipe document.
 *
 * Every reason is reported, in a fixed order — structural (shape, then version), then
 * id, then the cross-field checks in declaration order — so two runs over the same input
 * produce byte-identical output and a diff in CI means the recipe changed, not the run.
 * Deterministic throughout: no clock, no randomness, nothing locale-dependent.
 *
 * The version is checked **before** the shape, and returns immediately. A document written
 * for a newer schema may have redefined the meaning of a field that still has the right
 * type, so validating it against this build's expectations would produce a confident
 * "invalid" for a document that is perfectly fine, or worse, a clean pass on one that no
 * longer means what it says.
 */
export function validateRecipe(input: unknown, options: ValidateRecipeOptions = {}): ValidationOutcome<Recipe, RecipeIssueCode> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      ok: false,
      issues: [
        {
          code: 'not_an_object',
          path: '',
          message: 'A recipe must be a JSON object. Read the file again; do not reconstruct it from what this reported.',
        },
      ],
    };
  }

  const declared = readSchemaVersion(input);
  if (declared === null || !SUPPORTED_RECIPE_VERSIONS.includes(declared)) {
    return {
      ok: false,
      issues: [
        {
          code: 'unknown_version',
          path: 'schemaVersion',
          message:
            declared === null
              ? `Missing or non-integer schemaVersion. A recipe must declare an integer version; this build reads ${SUPPORTED_RECIPE_VERSIONS.join(', ')}.`
              : `Recipe declares schema version ${declared}, which this build does not implement. It reads ${SUPPORTED_RECIPE_VERSIONS.join(', ')}. Upgrade rather than reading it on a guess.`,
        },
      ],
    };
  }

  const parsed = recipeSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        code: 'schema_violation' as const,
        path: formatPath(issue.path),
        message: issue.message,
      })),
    };
  }
  const recipe = parsed.data;
  const issues: ValidationIssue<RecipeIssueCode>[] = [];

  if (options.fileName !== undefined) {
    const fileId = recipeIdFromFileName(options.fileName);
    if (fileId === null) {
      issues.push({
        code: 'id_mismatch',
        path: '',
        message: `"${options.fileName}" is not a recipe filename. A recipe must live in <id>.recipe.json.`,
      });
    } else if (fileId !== recipe.id) {
      issues.push({
        code: 'id_mismatch',
        path: 'id',
        message: `Recipe declares id "${recipe.id}" but the file is "${options.fileName}", which is served as "${fileId}". Rename one to match.`,
      });
    }
  }

  const layerNames = new Set<string>();
  recipe.layers.forEach((layer, index) => {
    if (layerNames.has(layer.name)) {
      issues.push({
        code: 'duplicate_layer',
        path: `layers[${index}].name`,
        message: `Layer "${layer.name}" is declared more than once, so every step naming it is ambiguous.`,
      });
    }
    layerNames.add(layer.name);
  });

  const stepIds = new Set<string>();
  recipe.steps.forEach((step, index) => {
    if (stepIds.has(step.id)) {
      issues.push({
        code: 'duplicate_step',
        path: `steps[${index}].id`,
        message: `Step "${step.id}" appears more than once, so there is no way to refer to one of them.`,
      });
    }
    stepIds.add(step.id);
    if (!layerNames.has(step.layer)) {
      issues.push({
        code: 'unknown_layer_reference',
        path: `steps[${index}].layer`,
        message: `Step "${step.id}" paints on layer "${step.layer}", which the recipe does not declare. Declared layers: ${recipe.layers.map((l) => l.name).join(', ')}.`,
      });
    }
  });

  recipe.checks.forEach((check, index) => {
    if (!(RECIPE_CHECK_TOOLS as readonly string[]).includes(check.tool)) {
      issues.push({
        code: 'unknown_check_tool',
        path: `checks[${index}].tool`,
        message: `"${check.tool}" is not a read-only tool. Checks must be answerable without changing the artwork; use one of: ${RECIPE_CHECK_TOOLS.join(', ')}.`,
      });
    }
  });

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: recipe };
}

/**
 * Parse and validate a recipe file's text.
 *
 * The whole filesystem-independent half of loading a recipe: `readFileSync(path, 'utf8')`
 * on one side, {@link validateRecipe} on the `fileName` side. `packages/core` may not
 * touch the filesystem, so this is the seam that lets a Node-side caller (the MCP server,
 * T-036) do one read and one call.
 *
 * Malformed JSON is reported as `not_json` rather than as a shape violation, because the
 * two mean opposite things to the caller: a file that does not parse needs re-reading, and
 * a file that parses but breaks the schema needs repairing.
 */
export function parseRecipe(text: string, options: ValidateRecipeOptions = {}): ValidationOutcome<Recipe, RecipeIssueCode> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          code: 'not_json',
          path: '',
          message: `Recipe file is not valid JSON: ${(error as Error).message}`,
        },
      ],
    };
  }
  return validateRecipe(parsed, options);
}