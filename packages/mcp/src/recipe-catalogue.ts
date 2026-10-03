/**
 * The recipe catalogue, as the server sees it.
 *
 * `packages/core` owns the recipe *schema* and deliberately does not read the filesystem -
 * the core package may not import Node APIs, and the recipe files are data rather than
 * code. So this module is the filesystem half: it finds `recipes/`, reads the JSON and
 * hands the text to `parseRecipe`, which is the single definition of what a recipe is.
 * There is no registry and no index file - the directory *is* the catalogue, and
 * `validateRecipe` binds each file's id to its filename so the two cannot drift.
 *
 * **Why the lookup is a directory walk and not a compile-time import.** A recipe is
 * documentation an agent reads, not a capability the engine has, so the set has to be
 * able to grow by dropping a file in - that is the whole property of the format
 * (`recipes/README.md` says adding a recipe touches nothing else). It also means the
 * catalogue can be *wrong*: a malformed file is a reason an agent has to be told, not a
 * crash at startup, so nothing here validates eagerly and everything reports.
 *
 * The one thing that would silently break is the path. `recipes/` sits at the repository
 * root, three levels above both `packages/mcp/src` and the built `packages/mcp/dist`, so
 * the same relative walk works for the editor, the CLI and a published tarball whose
 * `recipes/` was copied alongside `dist/`. `PIXEL_RECIPES_DIR` overrides it for a
 * deployment that lays the files out differently - and is what a test uses to point the
 * server at a temporary catalogue, which is the only way to exercise the failure paths
 * without editing the shipped files.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRecipe, recipeIdFromFileName, type Recipe, type RecipeIssueCode } from '@pixel/core';

/** Environment override for the catalogue directory, for a deployment that differs. */
const DIR_ENV_VAR = 'PIXEL_RECIPES_DIR';

let cachedDir: string | null = null;

/**
 * The directory holding the shipped recipes, or `null` when there is none.
 *
 * `null` rather than a throw: a server running from an installation with no recipe files
 * is still a working editor, and the catalogue is guidance. It is also the state a test
 * puts it in, so the "no catalogue" path is reachable rather than theoretical.
 */
export function recipesDir(): string | null {
  if (cachedDir !== null) return cachedDir === '' ? null : cachedDir;

  const override = process.env[DIR_ENV_VAR];
  const candidates = override
    ? [resolve(override)]
    : [resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'recipes')];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedDir = candidate;
      return candidate;
    }
  }
  cachedDir = '';
  return null;
}

/** Forget the resolved directory. Only the environment-override tests need this. */
export function resetRecipesDirCache(): void {
  cachedDir = null;
}

/** The ids in the catalogue, sorted. Empty when there is no directory. */
export function listRecipeIds(): string[] {
  const dir = recipesDir();
  if (dir === null) return [];
  return readdirSync(dir)
    .map(recipeIdFromFileName)
    .filter((id): id is string => id !== null)
    .sort();
}

/**
 * One recipe file, parsed, with every reason it was refused rather than the first.
 *
 * `id: null` means the file could not be read or did not parse; the issue says which, and
 * the two mean opposite things to a caller: a file that does not parse needs re-reading
 * and a file that parses but breaks the schema needs repairing. That distinction is
 * `RecipeIssueCode`'s reason for existing and it is preserved here rather than flattened
 * into a boolean.
 */
export type RecipeLoad =
  | { readonly ok: true; readonly recipe: Recipe; readonly source: string }
  | { readonly ok: false; readonly id: string; readonly issues: readonly { code: RecipeIssueCode; path: string; message: string }[] };

/**
 * Read one recipe by id.
 *
 * The id is validated against `RECIPE_ID_PATTERN` *before* it reaches the filesystem,
 * because this is the one function whose argument becomes a path segment. A caller
 * reaching `../../etc/passwd` here gets a refusal rather than a read, and the check is
 * here rather than in the caller because there are two callers (the tool and the
 * resource) and a path-traversal guard that lives in one of them is a guard that the
 * other one does not have.
 */
export function loadRecipe(id: string): RecipeLoad {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    return {
      ok: false,
      id,
      issues: [
        {
          code: 'schema_violation',
          path: 'id',
          message:
            'A recipe id is kebab-case and becomes a filename, so anything else is refused before the filesystem is touched.',
        },
      ],
    };
  }

  const dir = recipesDir();
  if (dir === null) {
    return {
      ok: false,
      id,
      issues: [
        {
          code: 'schema_violation',
          path: '',
          message: `No recipe directory was found. Set ${DIR_ENV_VAR} to the one holding <id>.recipe.json files.`,
        },
      ],
    };
  }

  const fileName = `${id}.recipe.json`;
  let text: string;
  try {
    text = readFileSync(resolve(dir, fileName), 'utf8');
  } catch {
    // The filesystem error is deliberately not propagated: its message names an absolute
    // build path, which tells a caller nothing useful and leaks the install layout. What
    // the caller needs is which ids do exist, and that is the recoverable half.
    const known = listRecipeIds();
    return {
      ok: false,
      id,
      issues: [
        {
          code: 'schema_violation',
          path: '',
          message:
            `No recipe named "${id}". ${known.length === 0 ? 'The catalogue is empty.' : `Available: ${known.join(', ')}.`}`,
        },
      ],
    };
  }

  const parsed = parseRecipe(text, { fileName });
  return parsed.ok
    ? { ok: true, recipe: parsed.value, source: `recipes/${fileName}` }
    : { ok: false, id, issues: parsed.issues };
}

/**
 * A one-line summary per recipe, for the catalogue listing.
 *
 * `summary` is truncated to its first sentence rather than its first N characters, because
 * the first sentence of every recipe in the catalogue is written to name what the class
 * *is* - which is the thing a listing has to convey and the only part that fits. A
 * truncated mid-sentence string is a worse listing than a short complete one.
 */
export function summarise(recipe: Recipe): Record<string, unknown> {
  const firstSentence = recipe.summary.split(/(?<=\.)\s/)[0] ?? recipe.summary;
  return {
    id: recipe.id,
    title: recipe.title,
    summary: firstSentence,
    canvas: recipe.canvas.sizes[0],
    paletteColours: recipe.palette.colourBudget,
    animates: recipe.motion !== undefined,
    uri: `pixel://recipe/${recipe.id}`,
  };
}