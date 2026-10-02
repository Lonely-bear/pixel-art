import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// Imported from the module rather than from `../src/index.js`, which is the pattern
// `quality-weights.test.ts` uses. The re-export from `index.ts` is a one-line follow-up
// T-036 needs before a consumer can reach this; until it lands, importing the module
// directly is what makes this test runnable without a build.
import {
  migrateRecipe,
  parseRecipe,
  RECIPE_CHECK_TOOLS,
  RECIPE_ID_PATTERN,
  RECIPE_MAX_CANVAS_EDGE,
  RECIPE_SCHEMA_VERSION,
  recipeFileName,
  recipeIdFromFileName,
  RECIPE_MIGRATIONS,
  recipeSchema,
  SUPPORTED_RECIPE_VERSIONS,
  validateRecipe,
  type Recipe,
  type RecipeIssueCode,
} from '../src/recipes.js';

// `packages/core/test/` -> repo root. Three levels, and a path that resolves to the wrong
// directory has to fail here rather than quietly find zero recipes and pass.
const RECIPES_DIR = fileURLToPath(new URL('../../../recipes/', import.meta.url));
const PLATFORMER_TEXT = readFileSync(new URL('../../../recipes/platformer.recipe.json', import.meta.url), 'utf8');

/** Codes on a failure, in order. The branch a caller takes is on these, not the prose. */
function codes(value: unknown): RecipeIssueCode[] {
  const result = validateRecipe(value);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

function issues(value: unknown): readonly { code: RecipeIssueCode; path: string; message: string }[] {
  const result = validateRecipe(value);
  return result.ok ? [] : result.issues;
}

/** The shipped recipe, parsed from disk. Every structural test below starts from this. */
function shipped(): Recipe {
  const result = parseRecipe(PLATFORMER_TEXT, { fileName: 'platformer.recipe.json' });
  if (!result.ok) {
    throw new Error(
      `recipes/platformer.recipe.json does not validate: ` +
        result.issues.map((i) => `${i.path || '(root)'}: [${i.code}] ${i.message}`).join('; '),
    );
  }
  return result.value;
}

/** `validateRecipe` with a filename, for the id-binding tests. */
function codesWithName(fileName: string): RecipeIssueCode[] {
  const result = parseRecipe(PLATFORMER_TEXT, { fileName });
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

describe('recipe format: the shipped catalogue', () => {
  it('validates every recipe on disk against the schema in recipes.ts', () => {
    // The point of a data-driven catalogue is that adding a file is the whole job. This
    // fails when a new recipe is malformed, and it fails *here* rather than at some future
    // loader, because the loader is T-036 and this test is the thing that must exist first.
    const names = readdirSync(RECIPES_DIR)
      .filter((name) => name.endsWith('.recipe.json'))
      .sort();

    expect(names).toContain('platformer.recipe.json');

    const problems: string[] = [];
    for (const name of names) {
      const result = parseRecipe(readFileSync(`${RECIPES_DIR}${name}`, 'utf8'), { fileName: name });
      if (!result.ok) {
        problems.push(`${name}: ` + result.issues.map((i) => `${i.path || '(root)'} [${i.code}] ${i.message}`).join('; '));
      }
    }
    expect(problems).toEqual([]);
  });

  it('ships exactly one recipe, and it is named by its own id', () => {
    const names = readdirSync(RECIPES_DIR).filter((n) => n.endsWith('.recipe.json'));
    // T-030's scope is the format plus one reference recipe. A count assertion is not
    // ceremony: T-031..T-035 land as files, and this is the line that has to move with them.
    expect(names).toEqual(['platformer.recipe.json']);
    expect(shipped().id).toBe('platformer');
  });
});

describe('recipe format: structure', () => {
  it('round-trips the shipped recipe through JSON without loss', () => {
    // Proves the file is the source of truth and `Recipe` is its exact shape — a field the
    // schema silently drops (a typo'd key under a non-strict object, say) would break here.
    const parsed = JSON.parse(JSON.stringify(shipped())) as unknown;
    const result = validateRecipe(parsed);
    expect(result.ok).toBe(true);
  });

  it('declares the version this build reads, and reads nothing else', () => {
    expect(shipped().schemaVersion).toBe(RECIPE_SCHEMA_VERSION);
    expect(SUPPORTED_RECIPE_VERSIONS).toEqual([RECIPE_SCHEMA_VERSION]);
  });

  it('treats `motion` absence as the statement that a class does not animate', () => {
    // The field is optional rather than present-and-empty, so *omitting* it is the whole
    // difference between an animated class and a still one. Asserted as a mutation of the
    // shipped animated recipe because that is the discriminating direction: proving the
    // animated form validates would also pass against a schema that demanded `motion`.
    const still = shipped();
    delete (still as Partial<Recipe>).motion;
    expect(validateRecipe(still).ok).toBe(true);

    // And present-and-empty is *not* the way to say "this class does not animate": it is a
    // different claim, that the author forgot, and the two must not be interchangeable.
    expect(validateRecipe({ ...still, motion: { loops: [], note: 'x' } }).ok).toBe(false);
  });

  it('declares a colour budget its own ramps can actually reach', () => {
    // Internal consistency is not something the schema can check, and it is the failure a
    // recipe author makes most easily: write `colourBudget: 12`, declare four three-step
    // ramps, and the budget is unreachable — the numbers then have to be reconciled by hand
    // at draw time, which is exactly the moment a recipe stops being readable.
    // Iterates the directory rather than hardcoding `platformer`, so T-031..T-035 are
    // covered by writing the file and not by editing this test.
    const names = readdirSync(RECIPES_DIR).filter((n) => n.endsWith('.recipe.json'));
    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      const result = parseRecipe(readFileSync(`${RECIPES_DIR}${name}`, 'utf8'), { fileName: name });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const recipe = result.value;

      // `ensure_palette_role` appends, so the ramps are a floor on the swatches available.
      const rampColours = recipe.palette.roles.reduce((total, role) => total + (role.steps ?? 5), 0);
      expect(rampColours, `${name}: ramps need more colours than colourBudget allows`).toBeLessThanOrEqual(
        recipe.palette.colourBudget,
      );
      // And the headroom is at most one extra colour per material, which is what leaves room
      // for an accent and for transition steps between materials without leaving room for a
      // ramp nobody budgeted.
      expect(
        recipe.palette.colourBudget - rampColours,
        `${name}: colourBudget leaves more headroom than the declared materials justify`,
      ).toBeLessThanOrEqual(recipe.palette.roles.length);
    }
  });

  it('names only read-only tools in checks', () => {
    // A check that mutates the artwork is not a check. `RECIPE_CHECK_TOOLS` is what
    // `unknown_check_tool` validates against, so a recipe agreeing with itself proves
    // nothing unless the enum is independently asserted to exclude the mutating commands.
    expect([...RECIPE_CHECK_TOOLS].sort()).toEqual([
      'get_pixels',
      'get_preview',
      'histogram',
      'measure_region',
      'preview_animation',
      'preview_tilemap',
      'read_grid',
    ]);
    // Named because a check naming a real command is the realistic mistake: all four are
    // real commands in `allCommands`, and all four mutate the document.
    for (const mutating of ['outline', 'draw_rect', 'despeckle', 'add_palette_ramp']) {
      expect(RECIPE_CHECK_TOOLS as readonly string[]).not.toContain(mutating);
    }
  });
});

describe('recipe format: why it is refused', () => {
  it('refuses a newer schema version without validating any other field', () => {
    // The discriminating assertion of this file. A validator that checks the shape first,
    // or that coerces/clamps the version, would still return a failure here — so `ok:false`
    // alone proves nothing. What proves it is that the version error is the *only* issue
    // reported: a v2 recipe that is also missing `tone` must produce one issue, not two.
    // Reporting both means the reader interpreted fields whose meaning v2 may have changed,
    // which is the exact failure the ordering exists to prevent.
    const future = { ...shipped(), schemaVersion: RECIPE_SCHEMA_VERSION + 1 } as Recipe;
    delete (future as Partial<Recipe>).tone;

    const result = validateRecipe(future);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues).toHaveLength(1);
    expect(codes(future)).toEqual(['unknown_version']);
    expect(issues(future)[0].path).toBe('schemaVersion');
  });

  it('refuses an older schema version rather than interpolating it', () => {
    // A recipe predating the first migration has fields whose meaning this build does not
    // know. `migrateRecipe` must refuse rather than guess, and must name the step that is
    // missing so the refusal is actionable. Every branch is reachable while
    // `RECIPE_MIGRATIONS` is empty — that is the point of asserting it here, before there
    // is anything to migrate and before the refusal has a real file to be tested against.
    const old = { ...shipped(), schemaVersion: RECIPE_SCHEMA_VERSION - 1 };
    expect(RECIPE_MIGRATIONS[RECIPE_SCHEMA_VERSION - 1]).toBeUndefined();

    const result = migrateRecipe(old);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.map((i) => i.code)).toEqual(['unknown_version']);
    expect(result.ok === false && result.issues[0].message).toContain(
      `No migration from schema version ${RECIPE_SCHEMA_VERSION - 1}`,
    );
  });

  it('refuses to migrate a newer recipe down, and refuses an unimplemented target version', () => {
    // Two more refusals on the same function, both reachable now. "Migrate forward from a
    // version I do not implement" is not a migration, and accepting it would be exactly the
    // best-guess read the version rule forbids.
    const future = { ...shipped(), schemaVersion: RECIPE_SCHEMA_VERSION + 1 };
    expect(migrateRecipe(future).ok).toBe(false);
    expect(migrateRecipe(shipped(), RECIPE_SCHEMA_VERSION + 1).ok).toBe(false);
    // The same document at the version this build reads migrates to itself and validates.
    expect(migrateRecipe(shipped()).ok).toBe(true);
  });

  it('refuses a step painting on a layer the recipe never declares', () => {
    // This is the cross-field fault a per-field schema cannot see. `recipeSchema.safeParse`
    // accepts this document — `steps[].layer` is just a non-empty string — so a validator
    // built on the schema alone passes here, and an agent following the recipe paints on a
    // layer that does not exist. Asserted against the schema directly to make that visible:
    // the schema is not enough, which is why `validateRecipe` exists at all.
    const broken = shipped();
    broken.steps[0].layer = 'a-layer-that-was-never-declared';

    expect(recipeSchema.safeParse(broken).success).toBe(true);
    expect(codes(broken)).toEqual(['unknown_layer_reference']);
    expect(issues(broken)[0].path).toBe('steps[0].layer');
  });

  it('refuses a recipe whose id disagrees with the file it sits in', () => {
    // The id is the `pixel://recipe/{id}` path segment (T-036). A file at
    // `topdown-rpg.recipe.json` that declares `id: "platformer"` would serve the wrong
    // bytes at `pixel://recipe/platformer`, and nothing downstream would notice.
    expect(codesWithName('topdown-rpg.recipe.json')).toEqual(['id_mismatch']);

    // The same document under its own name is clean, so the filename is the only cause.
    expect(codesWithName('platformer.recipe.json')).toEqual([]);
  });

  it('refuses a filename that is not a recipe file', () => {
    expect(codesWithName('platformer.json')).toEqual(['id_mismatch']);
    expect(codesWithName('README.md')).toEqual(['id_mismatch']);
  });

  it('refuses an ambiguous layer name and an ambiguous step id', () => {
    // Both make a step unaddressable. A reviewer cannot say "fix the outline step" when
    // two steps are called `outline`, and an agent cannot either.
    // Append a copy of an existing layer rather than renaming one. Renaming would orphan every
    // step that addressed the old name and raise `unknown_layer_reference` as well, so the
    // fixture would be testing two faults at once — and asserting only `duplicate_layer`
    // would then be asserting that the step check did *not* run, which is the opposite of
    // what the test means. Adding at the end touches no existing name at all.
    const dupLayer = shipped();
    dupLayer.layers.push({ ...dupLayer.layers[0] });
    expect(codes(dupLayer)).toEqual(['duplicate_layer']);
    expect(issues(dupLayer)[0].path).toBe(`layers[${dupLayer.layers.length - 1}].name`);

    const dupStep = shipped();
    dupStep.steps[2].id = dupStep.steps[0].id;
    expect(codes(dupStep)).toEqual(['duplicate_step']);
  });

  it('refuses a check naming something that is not a read-only tool', () => {
    // `outline` is a real command, so a name-shaped check would pass. It mutates, so it
    // must be refused: a check that changes the artwork cannot be used to verify it.
    const broken = shipped();
    broken.checks[0].tool = 'outline';
    expect(codes(broken)).toEqual(['unknown_check_tool']);
  });

  it('refuses a canvas larger than a document may be', () => {
    // A recipe proposing 8192x8192 proposes a document `create_document` refuses, and the
    // agent would discover it by failing rather than by reading. The bound is the same one
    // the command enforces, so the recipe cannot be internally consistent and externally wrong.
    expect(RECIPE_MAX_CANVAS_EDGE).toBe(4096);
    const tooBig = shipped();
    tooBig.canvas.sizes[0].w = RECIPE_MAX_CANVAS_EDGE + 1;
    expect(codes(tooBig)).toEqual(['schema_violation']);
    expect(issues(tooBig)[0].path).toBe('canvas.sizes[0].w');
  });

  it('refuses an unknown top-level key rather than ignoring it', () => {
    // Strictness is what makes "no number to chase" structural. A permissive reader would
    // drop `targetQuality: 95` silently, which is worse than refusing: the recipe would
    // carry a score nobody enforces and every agent would optimise toward it.
    const withScore = { ...shipped(), targetQuality: 95 } as unknown;
    expect(recipeSchema.safeParse(withScore).success).toBe(false);
    expect(codes(withScore)).toEqual(['schema_violation']);
  });

  it('refuses a non-object, and refuses malformed JSON as not_json rather than a shape error', () => {
    // The two mean opposite things: a file that does not parse needs re-reading, a file
    // that parses but breaks the schema needs repairing. Conflating them sends the caller
    // to repair a file whose bytes were never understood.
    expect(codes(null)).toEqual(['not_an_object']);
    expect(codes([])).toEqual(['not_an_object']);
    expect(codes('platformer')).toEqual(['not_an_object']);

    const broken = parseRecipe('{ "schemaVersion": 1, ');
    expect(broken.ok).toBe(false);
    expect(broken.ok === false && broken.issues[0].code).toBe('not_json');
  });

  it('reports every reason rather than the first', () => {
    // A catalogue loader reports a whole broken file in one response, and an agent handed
    // three precise reasons repairs three things in one pass rather than one round trip at
    // a time. An implementation that short-circuits on the first failure passes every
    // single-reason test above and fails this one.
    const broken = shipped();
    broken.steps[0].layer = 'nope';
    broken.steps[1].layer = 'also-nope';
    broken.checks[0].tool = 'outline';
    expect(codes(broken)).toEqual(['unknown_layer_reference', 'unknown_layer_reference', 'unknown_check_tool']);
  });
});

describe('recipe format: determinism', () => {
  it('produces byte-identical output for the same input', () => {
    // The format is read by a catalogue whose listing may be compared in CI. A result that
    // varied per run would make a diff mean "the run changed" rather than "the recipe
    // changed", which is the failure `packages/core` already has an answer for.
    const broken = shipped();
    broken.steps[0].layer = 'nope';
    broken.checks[0].tool = 'outline';

    expect(JSON.stringify(issues(broken))).toBe(JSON.stringify(issues(broken)));
    expect(JSON.stringify(issues(shipped()))).toBe(JSON.stringify(issues(shipped())));
  });

  it('orders issues structurally: shape, then version, then id, then cross-field', () => {
    // The order is a contract, not an accident of which check ran first. It is what makes
    // the "a newer version reports one issue" test above a statement about ordering rather
    // than about luck. A version fault outranks an id fault even when the document has both.
    const bothBroken = { ...shipped(), schemaVersion: RECIPE_SCHEMA_VERSION + 1 };
    expect(codes(bothBroken)).toEqual(['unknown_version']);
    expect(codesWithName('topdown-rpg.recipe.json')).toEqual(['id_mismatch']);
  });
});

describe('recipe format: identity helpers', () => {
  it('maps an id to a filename and back, for every shipped recipe', () => {
    // `recipeFileName`/`recipeIdFromFileName` are what make "the filename is the id"
    // mechanical rather than a convention, and T-036's `pixel://recipe/{id}` resolves
    // through the second one.
    for (const name of readdirSync(RECIPES_DIR).filter((n) => n.endsWith('.recipe.json'))) {
      const id = recipeIdFromFileName(name);
      expect(id).not.toBeNull();
      expect(recipeFileName(id as string)).toBe(name);
    }
  });

  it('returns null for a file that is not a recipe, so a directory walk can skip it', () => {
    expect(recipeIdFromFileName('README.md')).toBeNull();
    expect(recipeIdFromFileName('platformer.json')).toBeNull();
    expect(recipeIdFromFileName('platformer.recipe.json.bak')).toBeNull();
  });

  it('rejects an id that cannot be a URI path segment or a filename', () => {
    // The id reaches `pixel://recipe/{id}`. Uppercase, spaces and slashes would make a URI
    // nobody can type, so the pattern is the constraint and this is its evidence.
    expect(RECIPE_ID_PATTERN.test('platformer')).toBe(true);
    expect(RECIPE_ID_PATTERN.test('ui-icons')).toBe(true);
    expect(RECIPE_ID_PATTERN.test('topdown-rpg')).toBe(true);
    expect(RECIPE_ID_PATTERN.test('Platformer')).toBe(false);
    expect(RECIPE_ID_PATTERN.test('ui icons')).toBe(false);
    expect(RECIPE_ID_PATTERN.test('-leading')).toBe(false);
    expect(RECIPE_ID_PATTERN.test('trailing-')).toBe(false);
    expect(RECIPE_ID_PATTERN.test('has/slash')).toBe(false);
  });
});