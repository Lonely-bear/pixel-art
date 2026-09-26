import packageJson from '../package.json' with { type: 'json' };

/**
 * The published library entry: what a build script imports.
 *
 * ## Why this file exists
 *
 * dotloom-mcp is a game-asset pipeline, and a game project should be able to take it as a
 * `devDependency` and generate its sprites, tilesets and animations at build time instead
 * of having a person open a GUI. That is the strategic shape of the product, and until now
 * the library entry made it awkward: it exported four namespaces and nothing else, so
 * generating one sprite meant knowing that a document is a `Sprite`, that a document plus a
 * registry is an `Editor`, that edits go through `applyCommand` with `{command, params}`
 * envelopes, and that bytes come from `compositeFrame` → `encodePNG` in the right order.
 * All of that is real knowledge, and none of it is about the task.
 *
 * The fix is the flat, task-shaped surface below: {@link buildSprite},
 * {@link buildAnimation} and {@link exportAssets}. They read as
 * `buildSprite({width, height, palette, ops})` rather than as the architecture behind it,
 * they go through the same command bus the GUI and the MCP server use, and they need no
 * Electron, no document store and no running app — a plain Node ESM build script is the
 * only environment they were ever meant to run in.
 *
 * This is a *seam*, not the recipe system. Recipes (T-030+) are `buildX()` functions of the
 * same shape as the three here, built on these three, and the recipes will not change this
 * surface. Anything a recipe genuinely cannot express — see "Not here, on purpose" in
 * `docs/API.md` — is a separate decision, deliberately not pre-empted here.
 *
 * ## Two tiers, on purpose
 *
 *   - **Stable**, covered by {@link API_VERSION}: the three functions and the two version
 *     constants. Within a major version of this number, only additive changes.
 *   - **Internal**, shipped but unversioned: {@link core}, {@link mcp} and {@link script}.
 *     They are the escape hatch and the thing the README has always documented, so they
 *     will not disappear — but they mirror this repository's own package layout by design,
 *     which is exactly the coupling the task-shaped surface removes. Anything reachable
 *     through them may change in a minor release. New code should not go there.
 *
 * ## Determinism
 *
 * These functions are the reproducibility contract in code, not just in prose. Same spec,
 * same bytes, in any order, in any process: {@link buildSprite} and {@link buildAnimation}
 * install a seeded id factory for the duration of the call, and every op runs through the
 * bus, which takes all of its randomness from `rng.ts`. {@link exportAssets} allocates no
 * ids at all, so its output is a pure function of the sprite it is handed. Pinned by
 * `packages/core/test/npm-surface.test.ts`.
 */

import {
  CommandError,
  buildSpritesheet,
  compositeFrame,
  createEditor,
  createPalette,
  createSprite,
  deterministicIdFactory,
  encodeGIF,
  encodePNG,
  fillCommandDefaults,
  flattenAlpha,
  scaleAtlas,
  scaleNearest,
  serializeSprite,
  setIdFactory,
  toAsepriteJson,
  type Atlas,
  type AtlasOptions,
  type ColorInput,
  type Editor,
  type GifOptions,
  type Palette,
  type Sprite,
  type TagDirection,
} from '../packages/core/src/index.js';

/* ------------------------------------------------------------------ *
 * Version markers
 * ------------------------------------------------------------------ */

/** Published dotloom-mcp package version, e.g. `'0.4.1'`. Costs nothing. */
export const VERSION = packageJson.version;

/**
 * Version of the *stable* part of this file — the task-shaped surface below.
 *
 * Deliberately separate from {@link VERSION}: a patch release that fixes a rasteriser bug
 * has not changed the shape of the API, and a build script that asserted on `VERSION`
 * would wrongly conclude that it had. Bumped only for a breaking change to `buildSprite`,
 * `buildAnimation`, `exportAssets` or the types they take. `docs/API.md` is the policy.
 */
export const API_VERSION = '1';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/**
 * One command to run on the document, in order.
 *
 * Deliberately the same `{command, params, label}` envelope the CLI and the MCP `apply_ops`
 * tool accept, because a build script and an agent run the same catalogue, and a second
 * spelling would be a second thing to learn and a second thing to keep documented. Address
 * a frame or a layer through `params` — `params: {frame: 2}` — exactly as you would in the
 * CLI. Omit them and the bottom layer and frame 0 are filled in by the same
 * `fillCommandDefaults` rule the MCP surface uses, so a build script never has to spell out
 * "the first layer of the first frame".
 */
export interface AssetOp {
  /** A command name from the shared catalogue, e.g. `'draw_rect'` or `'add_palette_ramp'`. */
  command: string;
  /**
   * Parameters for that command, validated by the command's own zod schema. Never
   * mutated: the defaulting step copies before it fills, so one params object can be
   * reused across a loop without the first op rewriting it for the rest.
   */
  params?: Record<string, unknown>;
  /** Undo-history label. Defaults to the command name. */
  label?: string;
}

/** Colours for a new document: an explicit ramp, or a fully built palette object. */
export type PaletteSpec = readonly string[] | Palette;

/** One named frame range, written through the `upsert_tags` command. */
export interface AnimationTagSpec {
  /** Tag name, e.g. `'walk'`. This is what an engine reads when importing the sheet. */
  name: string;
  /** First frame of the range, 0-based. */
  from: number;
  /** Last frame of the range, 0-based and inclusive. */
  to: number;
  /** Playback direction. Defaults to `'forward'`. */
  direction?: TagDirection;
  /** How many times the range repeats. `0` means loop forever. Defaults to `0`. */
  repeat?: number;
}

/** Everything needed to build one sprite from nothing. */
export interface SpriteSpec {
  /**
   * Seed for every random-looking choice: the layer, frame, palette and tag ids, and
   * anything an op derives from a seed. Omitted means `0`, which is *still* reproducible —
   * a build script that wants varied output passes a seed, not a flag.
   */
  seed?: number;
  /** Canvas width in pixels. Any positive integer; 16-64 is the useful range for game art. */
  width: number;
  /** Canvas height in pixels. */
  height: number;
  /** Sprite name. Also the default stem for {@link exportAssets} output paths. */
  name?: string;
  /** Ramp to constrain the artwork to. Defaults to the built-in DawnBringer 16. */
  palette?: PaletteSpec;
  /** Layer names, bottom first, e.g. `['base', 'shade', 'outline']`. Defaults to one layer. */
  layers?: string[];
  /** Fill every frame's bottom layer with this colour. Omit to leave it transparent. */
  background?: ColorInput | null;
  /** Snap every painted colour to the nearest palette entry. Defaults to `false`. */
  paletteLocked?: boolean;
  /**
   * Commands to run after the document exists, in order, each on the shared bus.
   *
   * Nothing here touches the document model directly. That is the whole point, and it is
   * what keeps a build script, a plugin and the GUI producing the same pixels from the same
   * ops. A failing op throws a `CommandError` whose message names that op's index here.
   */
  ops?: readonly AssetOp[];
}

/** A {@link SpriteSpec} that can also be an animation. */
export interface AnimationSpec extends SpriteSpec {
  /** Number of frames to create. Defaults to 1. */
  frames?: number;
  /** Duration of each new frame in ms. Defaults to 100. Per-frame timing is a `set_frame_durations` op. */
  frameDurationMs?: number;
  /**
   * Animation tags, written with the `upsert_tags` command after the ops run. Creation
   * only; updating an existing tag is one explicit op away.
   */
  tags?: readonly AnimationTagSpec[];
}

/** Layout options for the sheet output. Forwarded to `core.buildSpritesheet` unchanged. */
export type SheetOptions = AtlasOptions;

/**
 * What to render, and how.
 *
 * Every field that selects an output is a tri-state: `true` for defaults, an options object
 * to configure it, `false` or omitted to leave it out. There is no default plan — "which
 * files should this build produce" is a question only the caller can answer, and a default
 * that guessed would either write 33 files for a 32-frame animation or silently write none.
 */
export interface ExportPlan {
  /** One PNG per frame, `<name>_<index>.png`, 0-based like everything else. */
  frames?: boolean;
  /** A packed spritesheet PNG. Ships with its Aseprite-JSON frame table as a second file. */
  sheet?: SheetOptions | boolean;
  /** An animated GIF of a tag, or of the whole timeline. */
  gif?: GifOptions | boolean;
  /** The editable `.pixel` source archive — a zip of the manifest and one PNG per cel. */
  source?: boolean;
  /** File name stem for every output. Defaults to the sprite's name, sanitised for a filesystem. */
  name?: string;
  /**
   * Integer nearest-neighbour upscale for every rendered output. Defaults to 1. Does not
   * affect `source`, which is resolution-independent structure plus 1x cels.
   */
  scale?: number;
  /** Fill the background behind the sprite instead of leaving it transparent. */
  background?: ColorInput | null;
}

/** Which kind of output a file is, so a caller can branch without parsing an extension. */
export type AssetFileKind = 'frame' | 'sheet' | 'sheet-json' | 'gif' | 'source';

/**
 * One finished file, as bytes.
 *
 * Bytes and not a path, because this function never touches the filesystem: a build script
 * decides whether these go into `assets/`, into a zip, into a git-lfs pointer or into an
 * HTTP response. It is also what makes the result trivially assertable in a test.
 */
export interface AssetFile {
  /** Relative path with forward slashes, e.g. `'knight_sheet.png'`. Safe to join onto any root. */
  path: string;
  bytes: Uint8Array;
  /** IANA media type. `.pixel` reports `application/zip`, because that is what it is. */
  mediaType: string;
  kind: AssetFileKind;
}

/* ------------------------------------------------------------------ *
 * Building
 * ------------------------------------------------------------------ */

/**
 * Build a single-frame sprite and return it.
 *
 * The document is created empty, then every op in `spec.ops` runs through the shared command
 * bus — no Electron, no document store, no MCP session, no filesystem. Same spec in, same
 * `Sprite` out, byte for byte, in any process.
 *
 * ```js
 * const sprite = buildSprite({
 *   seed: 7,
 *   width: 16, height: 16,
 *   name: 'slime',
 *   palette: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'],
 *   layers: ['base', 'shade'],
 *   ops: [
 *     { command: 'draw_ellipse', params: { rect: { x: 2, y: 4, w: 12, h: 10 }, color: '#8bac0f' } },
 *     { command: 'draw_ellipse', params: { rect: { x: 5, y: 7, w: 2, h: 2 }, color: '#0f380f', fill: false } },
 *   ],
 * });
 * ```
 *
 * **What it costs.** One `Sprite`, plus the undo entry each op creates — history is not
 * returned and is not needed, so a batch of a thousand ops does not keep a thousand
 * snapshots alive past the call. Every op is a real command execution, so the cost is the
 * same as drawing in the GUI, and validation is the command's own zod schema: a mistyped
 * parameter is a `CommandError` with code `invalid_params`, never a silent default.
 *
 * **Throws** `CommandError` (`invalid_params`) for a non-positive or non-integer canvas
 * size or a non-finite seed, (`unknown_command`) for a name that is not in the catalogue,
 * and (`command_failed`) for an op the command rejected — in which case the message names
 * that op's index in `spec.ops`.
 */
export function buildSprite(spec: SpriteSpec): Sprite {
  return assemble(spec, { frames: 1 });
}

/**
 * Build a multi-frame sprite with animation tags, and return it.
 *
 * Identical to {@link buildSprite} plus a frame count and a tag list. Every op still runs on
 * the shared bus, and the tags go through the `upsert_tags` command, so their range and
 * uniqueness checks are the same ones the CLI and the MCP tool surface apply.
 *
 * ```js
 * const walk = buildAnimation({
 *   seed: 7, width: 16, height: 16, name: 'walk',
 *   layers: ['base', 'shade'],
 *   frames: 4, frameDurationMs: 120,
 *   ops: [
 *     { command: 'draw_ellipse', params: { rect: { x: 2, y: 4, w: 12, h: 10 }, color: '#8bac0f' } },
 *     { command: 'draw_ellipse', params: { frame: 1, rect: { x: 4, y: 5, w: 2, h: 8 }, color: '#0f380f' } },
 *   ],
 *   tags: [{ name: 'walk', from: 0, to: 3 }],
 * });
 * ```
 *
 * **What it costs.** `frames` cel buffers, plus one undo entry per op. Cels are allocated
 * lazily — a frame's pixels exist only once something paints on that layer — so a large
 * canvas with many frames is cheap until it is drawn on.
 */
export function buildAnimation(spec: AnimationSpec): Sprite {
  const frames = spec.frames ?? 1;
  if (!Number.isInteger(frames) || frames < 1) {
    throw new CommandError(
      `frames must be a positive integer frame count, got ${describe(frames)}`,
      'invalid_params',
    );
  }
  return assemble(spec, { frames, frameDurationMs: spec.frameDurationMs, tags: spec.tags });
}

/* ------------------------------------------------------------------ *
 * Exporting
 * ------------------------------------------------------------------ */

/**
 * Render a built sprite into finished files, as bytes.
 *
 * Nothing is written and nothing is read: this is a pure function of `(sprite, plan)`, so it
 * allocates no ids, consults no clock and draws no random value. Feed it the same sprite
 * twice and you get the same bytes twice, which is what makes a build reproducible and a
 * regression assertable.
 *
 * The sheet output is two files on purpose. The PNG is what the engine slices; the
 * Aseprite-JSON table beside it is what tells the engine where each frame is, how long it
 * lasts, and which tag it belongs to. An image without its table is a picture; a table
 * without its image is a guess.
 *
 * ```js
 * for (const file of exportAssets(sprite, { sheet: true, gif: { scale: 4 }, source: true })) {
 *   await writeFile(join('assets/slime', file.path), file.bytes);
 * }
 * // -> slime_sheet.png, slime_sheet.json, slime.gif, slime.pixel
 * ```
 *
 * **What it costs.** Every selected output is held in memory at once, and the returned array
 * owns all of it, so a 32-frame animation with `frames: true` is 32 PNGs in the heap. Render
 * what the build needs rather than everything.
 *
 * **Throws** `CommandError` (`invalid_params`) when the plan selects no outputs at all, or
 * when `scale` is not a positive integer.
 */
export function exportAssets(sprite: Sprite, plan: ExportPlan): AssetFile[] {
  const files: AssetFile[] = [];
  const stem = fileStem(plan.name ?? sprite.name);
  const scale = plan.scale ?? 1;
  if (!Number.isInteger(scale) || scale < 1) {
    throw new CommandError(
      `scale must be a positive integer upscale factor, got ${describe(scale)}`,
      'invalid_params',
    );
  }
  const background = plan.background ?? null;

  if (plan.frames) {
    sprite.frames.forEach((frame, index) => {
      const composited = compositeFrame(sprite, frame.id, { background });
      files.push({
        path: `${stem}_${index}.png`,
        bytes: encodePNG(scaleNearest(composited, scale)),
        mediaType: 'image/png',
        kind: 'frame',
      });
    });
  }

  if (plan.sheet) {
    const sheetPath = `${stem}_sheet.png`;
    // Scale the atlas, not the image: that is what keeps the JSON honest, because the frame
    // rects, the sheet size and the pixels all grow together.
    const atlas = sheetOf(sprite, plan.sheet === true ? {} : plan.sheet, background, scale);
    files.push({ path: sheetPath, bytes: encodePNG(atlas.image), mediaType: 'image/png', kind: 'sheet' });
    files.push({
      path: `${stem}_sheet.json`,
      bytes: new TextEncoder().encode(JSON.stringify(toAsepriteJson(sprite, atlas, sheetPath), null, 2)),
      mediaType: 'application/json',
      kind: 'sheet-json',
    });
  }

  if (plan.gif) {
    const options = plan.gif === true ? {} : plan.gif;
    files.push({
      path: `${stem}.gif`,
      bytes: encodeGIF(sprite, {
        ...options,
        scale: options.scale ?? scale,
        background: options.background ?? background,
      }),
      mediaType: 'image/gif',
      kind: 'gif',
    });
  }

  if (plan.source) {
    files.push({
      path: `${stem}.pixel`,
      bytes: serializeSprite(sprite),
      mediaType: 'application/zip',
      kind: 'source',
    });
  }

  if (files.length === 0) {
    throw new CommandError(
      'The export plan selected no outputs. Set at least one of `frames`, `sheet`, `gif` or `source` — ' +
        'there is no default plan, because only the caller knows which files this build should produce.',
      'invalid_params',
    );
  }
  return files;
}

/* ------------------------------------------------------------------ *
 * Namespaces
 * ------------------------------------------------------------------ */

/**
 * Headless document model, command bus, rasteriser, and file codecs.
 *
 * The escape hatch: everything above is built on this, and nothing above is a re-export of
 * it. Reach for it when the task-shaped functions do not cover the job — the ~90 commands,
 * rigs, tilemaps, palette ramps, importers, and the direct `Sprite` plumbing. **Internal**:
 * shipped, and the thing the README has always documented, but it mirrors this repository's
 * own package layout by design, which is exactly the coupling the task-shaped surface
 * removes. See `docs/API.md`.
 */
export * as core from '../packages/core/src/index.js';

/**
 * MCP server, document sessions, tools, resources, prompts, and attach bridge.
 *
 * Present so a build script can run the MCP server in-process when it wants the agent-facing
 * surface — tool declarations, `pixel://` resources, the skill text — rather than the
 * library one. **Internal**, on the same terms as {@link core}.
 */
export * as mcp from '../packages/mcp/src/index.js';

/**
 * Constrained scripting runtime for trusted scripts and plugins.
 *
 * `node:vm` based, and therefore Node-only, which is why it is a namespace here rather than
 * something the three stable functions depend on. Useful when a generated asset is driven by
 * a script file rather than a JS object literal. **Internal**, on the same terms as
 * {@link core}.
 */
export * as script from '../packages/script/src/index.js';

/* ------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------ */

/** What `buildSprite` and `buildAnimation` each add to the shared spec. */
interface FramePlan {
  frames: number;
  frameDurationMs?: number;
  tags?: readonly AnimationTagSpec[];
}

/**
 * Create the document, then run the spec through the bus, inside a seeded id scope.
 *
 * `createSprite` is a factory rather than a command — the same split the CLI and the MCP
 * server make — and everything after it is `editor.execute`, so a build script, a plugin and
 * the GUI all reach the document through the one choke point.
 */
function assemble(spec: SpriteSpec, plan: FramePlan): Sprite {
  assertCanvasSize(spec.width, 'width');
  assertCanvasSize(spec.height, 'height');
  if (spec.seed !== undefined && !Number.isFinite(spec.seed)) {
    throw new CommandError(`seed must be a finite number, got ${describe(spec.seed)}`, 'invalid_params');
  }

  return withSeed(spec.seed ?? 0, () => {
    const sprite = createSprite({
      width: spec.width,
      height: spec.height,
      name: spec.name,
      layers: spec.layers,
      frames: plan.frames,
      frameDurationMs: plan.frameDurationMs,
      palette: spec.palette === undefined ? undefined : normalizePalette(spec.palette, spec.name),
      background: spec.background ?? null,
      paletteLocked: spec.paletteLocked,
    });
    const editor = createEditor(sprite);
    const ops = spec.ops ?? [];

    for (let index = 0; index < ops.length; index++) {
      const op = ops[index];
      try {
        editor.execute(op.command, resolveParams(editor, op), { label: op.label ?? op.command });
      } catch (error) {
        throw withOpContext(error, `ops[${index}] (${op.command})`);
      }
    }

    if (plan.tags && plan.tags.length > 0) {
      try {
        editor.execute('upsert_tags', { tags: plan.tags }, { label: 'animation tags' });
      } catch (error) {
        throw withOpContext(error, 'upsert_tags');
      }
    }
    return editor.sprite;
  });
}

/**
 * Fill in the bottom layer and frame 0 for commands that require them.
 *
 * `fillCommandDefaults` is the MCP tool surface's own defaulting rule, called from core, so
 * a build script's omitted `layer` and `frame` mean exactly what an agent's omitted ones
 * mean. It copies before it fills, which is what lets a caller reuse one params object
 * across a loop without the first op quietly rewriting it for the rest.
 */
function resolveParams(editor: Editor, op: AssetOp): Record<string, unknown> {
  const params = op.params ?? {};
  const command = editor.registry.get(op.command);
  return command ? fillCommandDefaults(editor.sprite, command, params) : params;
}

/** The sheet atlas, flattened and scaled, with its frame table describing the same geometry. */
function sheetOf(
  sprite: Sprite,
  options: SheetOptions,
  background: ColorInput | null,
  scale: number,
): Atlas {
  let atlas = buildSpritesheet(sprite, options);
  // `buildSpritesheet` composites with no background of its own, so a filled sheet is
  // flattened here rather than by re-implementing the packer.
  if (background != null) atlas = { ...atlas, image: flattenAlpha(atlas.image, background) };
  return scaleAtlas(atlas, scale);
}

/**
 * Install a seeded id factory for the duration of one build, then remove it.
 *
 * Ids are the one thing in a document that `rng.ts` cannot make reproducible on its own:
 * `makeId` draws on the clock and real entropy so that two documents open at once never
 * hand out the same layer id, and `serializeSprite` writes those ids into the manifest. The
 * seeded factory is what turns "the same ops" into "the same bytes", and it is installed
 * here rather than left to the caller so the contract holds by default.
 *
 * It is *removed* afterwards on purpose. `setIdFactory` is process-global, and a leaked
 * deterministic factory would make two unrelated documents in one process collide ids, which
 * is the single failure the default exists to prevent. The net effect is that these
 * functions leave the process in the state a fresh process would be in; a caller who has
 * installed a factory of their own with `core.setIdFactory` should re-install it afterwards.
 */
function withSeed<T>(seed: number, build: () => T): T {
  setIdFactory(deterministicIdFactory(seed));
  try {
    return build();
  } finally {
    setIdFactory(null);
  }
}

/**
 * A ramp *name* is deliberately not accepted here.
 *
 * The MCP surface resolves `'dawnbringer16'` through a preset table, because an agent gains
 * a lot from a short name and loses nothing by the indirection. A build script does not: the
 * ramp ends up in the output, and `core.DAWNBRINGER_16` — like every other exported ramp
 * constant — is one import away, so a second name-resolution table here would only be a
 * second source of truth to keep in step with the first.
 */
function normalizePalette(palette: PaletteSpec, spriteName: string | undefined): Palette {
  if (!isColorList(palette)) return palette;
  return createPalette(spriteName ? `${spriteName} palette` : 'Palette', palette);
}

/** `Array.isArray` does not narrow a `readonly string[]` union member, so say it outright. */
function isColorList(palette: PaletteSpec): palette is readonly string[] {
  return Array.isArray(palette);
}

/**
 * A safe file stem for output paths.
 *
 * Sprite names are free text and these become file names, so anything that is not a letter,
 * digit, dot, dash or underscore is folded to a dash, and leading dots are dropped so a name
 * can never walk out of the directory it is joined onto. Case is left alone: silently
 * lowercasing a name the caller chose is the kind of surprise a build script notices three
 * weeks later, in a diff.
 */
function fileStem(name: string): string {
  const safe = name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return safe.length > 0 ? safe : 'sprite';
}

function assertCanvasSize(value: number, field: string): void {
  // `createSprite` clamps with `Math.max(1, Math.floor(...))`, which turns a typo'd
  // `undefined` into `NaN` rather than into an error — a canvas of NaN pixels that fails
  // much later and much less clearly. This check exists for that reason alone.
  if (!Number.isInteger(value) || value < 1) {
    throw new CommandError(
      `${field} must be a positive integer number of pixels, got ${describe(value)}`,
      'invalid_params',
    );
  }
}

/** Re-raise a failure with the op that caused it, keeping the machine-readable code. */
function withOpContext(error: unknown, where: string): CommandError {
  if (!(error instanceof CommandError)) throw error;
  return new CommandError(`${where} failed: ${error.message}`, error.code, error.details);
}

/** Short, quoted rendering of a rejected value, so the message says what was actually passed. */
function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  if (value === undefined) return 'undefined';
  return Object.prototype.toString.call(value);
}
