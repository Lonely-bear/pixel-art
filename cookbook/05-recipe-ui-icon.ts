/**
 * Cookbook 5 — one recipe, end to end.
 *
 * Run it:
 *
 * ```bash
 * node --experimental-strip-types cookbook/05-recipe-ui-icon.ts
 * ```
 *
 * A **recipe** (`recipes/ui-icons.recipe.json`) is a reusable art-direction brief:
 * what size to build, how to build the palette, which layers exist and what belongs
 * on each, where the light comes from, the order to work in, the mistakes this class
 * keeps making. It is not a script — it names tools and constraints, and the drawing
 * is still done through ordinary commands.
 *
 * This example is the whole loop an agent goes through when it is handed one:
 *
 *   1. read the recipe, and **validate** it rather than trusting the filename;
 *   2. take the decisions from it — canvas, layers, palette, locked — and build the
 *      document from those numbers;
 *   3. draw, following the recipe's own steps and prohibitions;
 *   4. run the recipe's checks, which are **questions with yes/no answers**, not
 *      scores: measure the mark, and ask `evaluate` for **named defects**.
 *
 * Step 4 is where the discipline matters. Nothing in this file compares a number to
 * a target. `docs/EVALUATION.md` owns the thresholds; this file prints defect
 * *names* and the sentence that says what to do about each one, because a build
 * script that showed a score would turn that score into the artwork.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { buildSprite, exportAssets, core, mcp, type Sprite } from 'dotloom-mcp';

/** Where the files land. Set `DOTLOOM_COOKBOOK_OUT` to build somewhere else. */
const OUT = process.env['DOTLOOM_COOKBOOK_OUT'] ?? 'generated';

/**
 * The recipe, as a file a project vendors next to its build script.
 *
 * A recipe is data, so it is read as text and parsed by the same schema the MCP
 * server's `describe_recipe` uses. `DOTLOOM_RECIPE` points this example at a different
 * recipe file, and every **number** below follows it — canvas, layers, palette, locked.
 * What does *not* follow it is the drawing: the gate below is one person's answer to
 * this brief, and a different asset class needs a different answer. That split is the
 * point of the format — the recipe decides the constraints, the drawing decides the
 * mark — so a build script that wanted a whole set would branch on `recipe.id` here.
 */
const RECIPE_PATH = process.env['DOTLOOM_RECIPE'] ?? 'recipes/ui-icons.recipe.json';

/** A recipe that parsed, or the reasons it did not. Narrow on purpose — no `any`. */
type ParsedRecipe =
  | { ok: true; recipe: core.Recipe }
  | { ok: false; issues: string[] };

/** Read and validate the recipe. A recipe that does not validate is not followed. */
export async function readRecipe(path = RECIPE_PATH): Promise<ParsedRecipe> {
  const text = await readFile(resolve(path), 'utf8');
  // `parseRecipe` is the internal tier: the library entry has no recipe reader, and a
  // recipe is a brief an agent reads rather than a function a build script calls.
  const parsed = core.parseRecipe(text, { fileName: path.split(/[\\/]/).pop() });
  if (!parsed.ok) {
    return { ok: false, issues: parsed.issues.map((i) => `${i.path}: [${i.code}] ${i.message}`) };
  }
  return { ok: true, recipe: parsed.value };
}

/**
 * The base palette, from the recipe's `palette.base` name.
 *
 * **A real gap, worked around rather than hidden.** A recipe names its base palette
 * by preset id (`endesga16`), and the MCP tool surface resolves those names — but the
 * library entry takes colours, not names: `palette: ['#1a1c2c', …]`, and
 * `API.md` says outright that a ramp *name* is deliberately not accepted, because
 * the ramp ends up in the output and `core.DAWNBRINGER_16` is one import away. The
 * preset table for the other three names lives in the `mcp` namespace, so this
 * example reads it from there. If that table were promoted to the stable entry, this
 * line would become `palette: core.resolveBuiltinPalette(name)` and the `mcp` import
 * would go away.
 */
function basePalette(name: string | undefined): string[] {
  if (!name) return [];
  const preset = mcp.BUILTIN_PALETTES[name.toLowerCase().replace(/[\s_-]/g, '')];
  if (!preset) throw new Error(`no built-in palette named "${name}"`);
  return [...preset];
}

/**
 * The icon, built from the recipe's own numbers.
 *
 * Every decision below is read out of `recipes/ui-icons.recipe.json`: the canvas is
 * `canvas.sizes[0]` because the recipe says the first size is the default; the layers
 * are `layers[]` in order, bottom first; the palette is `palette.base` plus one ramp
 * per `palette.roles[]`, appended by `add_palette_ramp`; and `palette.locked` becomes
 * `paletteLocked`.
 */
export function buildIcon(recipe: core.Recipe): Sprite {
  const size = recipe.canvas.sizes[0]!;
  // The mark's colour is one of the recipe's own materials, not an invented one. `ink`
  // is the right pick for a mark because it is the only contrast rule this class
  // measures against something outside the artwork — the panel fill.
  //
  // Note that a **role name is not a colour a paint command accepts**. `add_palette_ramp`
  // tags palette indices with the role and `ensure_palette_role` hands those indices
  // back, so the addressable form is `pal:<index>` or the index itself. Painting the
  // role's anchor hex is equivalent here, and with `paletteLocked` it snaps onto the
  // ramp entry the recipe asked for.
  const ink = recipe.palette.roles.find((role) => role.role === 'ink') ?? recipe.palette.roles[0]!;

  return buildSprite({
    seed: 1,
    width: size.w,
    height: size.h,
    name: 'icon-gate',
    palette: basePalette(recipe.palette.base),
    // `layers` in the recipe are bottom first, which is the order the document uses.
    layers: recipe.layers.map((layer) => layer.name),
    paletteLocked: recipe.palette.locked,
    ops: [
      // One ramp per role. `add_palette_ramp` appends, so the document palette ends
      // up larger than `colourBudget` on purpose: the palette is the constraint set
      // the artwork snaps into, and the budget is what gets painted.
      ...recipe.palette.roles.map((role) => ({
        command: 'add_palette_ramp',
        params: { role: role.role, from: role.from, to: role.to, steps: role.steps, hueShift: role.hueShift },
      })),

      // Step `block-mark`: the whole icon, one flat colour, one mass. A gate, because
      // the negative space inside it is what the mark means — and at 16px the recipe
      // is unambiguous that the mark is the shape, not the picture of a gate.
      { command: 'draw_rect', params: { layer: 'mark', rect: { x: 3, y: 3, w: 10, h: 11 }, color: ink.from } },

      // Step `subtract`, in the only spelling that erases: `clear_region` takes a rect
      // back to full transparency. The opening is 2px narrower than the frame on each
      // side, which is the recipe's "one stroke width" rule, and it is the reason the
      // mark reads at native size instead of dissolving into a filled square.
      { command: 'clear_region', params: { layer: 'mark', rect: { x: 5, y: 5, w: 6, h: 9 } } },
    ],
  });
}

/**
 * The recipe's checks, answered.
 *
 * Two questions, both yes/no, neither a score:
 *
 *   - **Does the mark fill 10-12 of the 16px?** Measured from the composited `mark`
 *     layer, not asserted by eye. This is the check that catches a mark floating in
 *     the middle of its slot, which is invisible in a preview and obvious here.
 *   - **What is wrong with it?** `evaluate`'s issue *names*, with the sentence that
 *     says what to do — no number, because the moment a build script can compare a
 *     score to a target, the score becomes the artwork.
 */
export function check(sprite: Sprite, recipe: core.Recipe): Record<string, unknown> {
  const markId = sprite.layers.find((layer) => layer.name === 'mark')!.id;
  const bounds = core
    .compositeFrame(sprite, sprite.frames[0]!.id, { layers: [markId] })
    .opaqueBounds();

  const editor = core.createEditor(sprite);
  const report = editor.execute('evaluate', {}) as {
    issues: { code: string; dimension: string; message: string; severity: string }[];
  };

  const expected = { min: 10, max: 12 };
  const filled = bounds ? bounds.w : 0;
  return {
    // Construction numbers from the recipe, quoted so the reader can see which rule
    // is being applied. Not a target to climb: 10-12 is what this class is.
    markFills10to12: filled >= expected.min && filled <= expected.max,
    markBounds: bounds,
    recipe: recipe.id,
    // Named defects. Every one of these is a thing to do, not a thing to optimise.
    defects: report.issues.map((issue) => ({
      dimension: issue.dimension,
      code: issue.code,
      severity: issue.severity,
      message: issue.message,
    })),
  };
}

/** The icon, its render and its check results — without touching the filesystem. */
export async function build(): Promise<Record<string, Uint8Array>> {
  const parsed = await readRecipe();
  if (!parsed.ok) throw new Error(`the recipe did not validate:\n${parsed.issues.join('\n')}`);
  const recipe = parsed.recipe;

  const sprite = buildIcon(recipe);
  const out: Record<string, Uint8Array> = {};
  // `background` is the panel fill. A UI icon is judged against the panel and
  // against the hover fill, so the check renders it against one explicitly rather
  // than leaving the reader to imagine transparency.
  for (const file of exportAssets(sprite, { frames: true, sheet: true, background: '#d9d9e3' })) {
    out[file.path] = file.bytes;
  }
  out['checks.json'] = new TextEncoder().encode(`${JSON.stringify(check(sprite, recipe), null, 2)}\n`);
  return out;
}

/** Write the icon, the sheet and the check results under `OUT`. */
async function main(): Promise<void> {
  const files = await build();
  for (const [name, bytes] of Object.entries(files)) {
    const path = join(OUT, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    console.log(`  ${name.padEnd(20)} ${String(bytes.length).padStart(6)} B`);
  }
  console.log(`\n${await readFile(join(OUT, 'checks.json'), 'utf8')}`);
}

await main();

export default build;
