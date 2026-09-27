/**
 * Materialising the corpus.
 *
 * Two rules, and the second one is the reason this file exists rather than a loop in a test.
 *
 * **1. Every case is built through the command bus.** `createSprite`, then
 * `createEditor(sprite, createRegistry(allCommands))`, then `Editor.execute` per op — the same
 * path `pixel demo` takes, the same registry the UI and the MCP server load, for the reason
 * `AGENTS.md` gives as the one architectural rule of the repository. A corpus that drew its
 * subjects by writing into a `PixelBuffer` would be measuring the analyzer on pixels the product
 * cannot produce, and the two would drift apart silently the first time a command's default
 * changed.
 *
 * **2. Ids come from a factory seeded from the case id.** `makeId`'s default is clock- and
 * entropy-based *on purpose* (T-071 keeps it that way: an id has to be unique across processes),
 * so a corpus built with it would produce a different document on every run — and since
 * `serializeSprite` writes layer ids into cel filenames, a different `.pixel` on every run. That
 * is fatal for a baseline, so each case installs its own `deterministicIdFactory`, keyed on an
 * FNV-1a hash of its id: same corpus, same bytes, every machine, and two cases never share ids
 * even when they are built in the same process.
 *
 * The factory is process-global, so it is installed and removed per case rather than once for the
 * run. Leaving it installed would hand every document built later in the same process
 * reproducible ids it did not ask for — including a test that is deliberately checking that the
 * *default* factory is not reproducible.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  allCommands,
  createEditor,
  createRegistry,
  createSprite,
  decodePNG,
  deserializeSprite,
  deterministicIdFactory,
  mix32,
  setIdFactory,
  type Sprite,
} from '../../packages/core/src/index.js';
import { PixelBuffer } from '../../packages/core/src/buffer.js';
import { loadCorpusScores, loadCorpusSpec, type CorpusCase, type CorpusScores, type CorpusSpec, type Recipe } from './format.js';
import { applyRecipe } from './recipes.js';

/** The repository root, from this file. Real assets are named by repository-relative path. */
const REPO_ROOT = new URL('../../', import.meta.url);

/** The spec and the ratings file, next to this module. */
export const CASES_PATH = fileURLToPath(new URL('./cases.json', import.meta.url));
export const SCORES_PATH = fileURLToPath(new URL('./scores.json', import.meta.url));

/** Read and validate `cases.json`. Throws on any violation — see `format.ts` for what those are. */
export function readCorpusSpec(): CorpusSpec {
  return loadCorpusSpec(JSON.parse(readFileSync(CASES_PATH, 'utf8')));
}

/**
 * Read and validate `scores.json`.
 *
 * An absent file is treated as an empty one, because "no human has rated this yet" is the
 * correct state on arrival and a missing file is how a checkout expresses it. A file that exists
 * and is *malformed* still throws: a typo in a rating must not read as an absent rating.
 */
export function readCorpusScores(spec: CorpusSpec): CorpusScores {
  let text: string;
  try {
    text = readFileSync(SCORES_PATH, 'utf8');
  } catch {
    return { schema: 'dotloom-corpus-scores/v1', corpusVersion: spec.version, ratings: {} };
  }
  return loadCorpusScores(JSON.parse(text), spec.version);
}

/** FNV-1a over the case id, so the seed is a property of the name and not of build order. */
function seedFor(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193);
  }
  return mix32(hash >>> 0);
}

/**
 * Build one case into a finished document.
 *
 * `real` cases are read from the committed asset rather than rebuilt, because the point of that
 * tier is that it is *real*: a regenerated approximation of the maintainer's artwork would be
 * neither real nor reproducible, and the only reproducibility question that matters for a
 * committed binary is whether it is committed — which it is, and which is why this corpus does
 * not take a build artefact. `packages/app/build/icon.png` is tracked in git, which is checked
 * rather than assumed.
 */
export function buildCase(entry: CorpusCase): Sprite {
  if (entry.tier === 'real') return readAsset(entry.source);
  if (entry.recipe === undefined) {
    // A human-tier case that rates a committed asset: nothing to build, the runner reads it.
    throw new Error(`corpus: ${entry.id} has no recipe, so there is nothing to materialise`);
  }
  return buildFromRecipe(entry.id, entry.recipe);
}

/** A committed `.pixel` document, or a committed PNG wrapped in a one-layer document. */
function readAsset(source: string): Sprite {
  const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL(source, REPO_ROOT))));
  if (source.endsWith('.png')) {
    // The app icon is a PNG, and the aggregator reads documents rather than images. Wrapping it
    // is what makes the icon a peer of the `.pixel` assets instead of a special case the corpus
    // has to branch around — the same one-layer wrapper `quality-report.test.ts` uses.
    const decoded = decodePNG(bytes);
    const sprite = createSprite({
      width: decoded.width,
      height: decoded.height,
      layers: ['base'],
      name: source,
    });
    sprite.frames[0].cels.set(
      sprite.layers[0].id,
      new PixelBuffer(decoded.width, decoded.height, decoded.data),
    );
    return sprite;
  }
  return deserializeSprite(bytes);
}

/** One recipe to one document, with ids seeded from the id. */
export function buildFromRecipe(id: string, recipe: Recipe): Sprite {
  setIdFactory(deterministicIdFactory(seedFor(id)));
  try {
    const sprite = createSprite({
      width: recipe.canvas.w,
      height: recipe.canvas.h,
      name: id,
      layers: recipe.layers ? [...recipe.layers] : undefined,
      ...(recipe.frames === undefined ? {} : { frames: recipe.frames }),
    });
    const editor = createEditor(sprite, createRegistry(allCommands));
    // The palette is replaced rather than appended, so a case is self-contained and its colours
    // are named `"pal:0"`, `"pal:1"`… in the order the case lists them. `set_palette` is a
    // command like any other; going through `createSprite`'s `palette` option would have been one
    // fewer step and one more place where a case and the drawing commands could disagree.
    editor.execute('set_palette', { colors: recipe.palette });
    applyRecipe(editor, recipe.ops);
    return editor.sprite;
  } finally {
    // The process-global factory is removed whatever happened, so a throw mid-build cannot leave
    // reproducible ids installed for the rest of the run.
    setIdFactory(null);
  }
}

/**
 * The whole corpus, in spec order.
 *
 * Order is the spec's order and it is the report's order, because §3.2 rule 4 requires that
 * anything whose order can reach output be a property of the scan rather than of a hash table, and
 * a generated report nobody can diff is a report nobody reads.
 */
export function buildCorpus(spec: CorpusSpec): { entry: CorpusCase; sprite: Sprite | null }[] {
  return spec.cases.map((entry) => ({ entry, sprite: buildable(entry) ? buildCase(entry) : null }));
}

/** Whether this case produces a document. A human-tier case rating a committed file does not. */
function buildable(entry: CorpusCase): boolean {
  return entry.tier !== 'human' || entry.recipe !== undefined;
}
