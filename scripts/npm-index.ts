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
 * {@link buildAnimation} and {@link exportAssets}, plus the three that arrived with the
 * 8-direction model, the asset contract and the SVG tracer —
 * {@link buildWalkAnimation}, {@link getDirectionModel}, {@link exportEngineAssets} and
 * {@link importSvg}. They read as `buildSprite({width, height, palette, ops})` rather than
 * as the architecture behind it, they go through the same command bus the GUI and the MCP
 * server use, and they need no Electron, no document store and no running app — a plain
 * Node ESM build script is the only environment they were ever meant to run in.
 *
 * This is a *seam*, not the recipe system. Recipes (T-030+) are `buildX()` functions of the
 * same shape as the three here, built on these three, and the recipes will not change this
 * surface. Anything a recipe genuinely cannot express — see "Not here, on purpose" in
 * `docs/API.md` — is a separate decision, deliberately not pre-empted here.
 *
 * ## Two tiers, on purpose
 *
 *   - **Stable**, covered by {@link API_VERSION}: the task-shaped functions and the two
 *     version constants. Within a major version of this number, only additive changes.
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
  DIRECTIONS,
  buildAssetMeta,
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
  importExcalidraw,
  importGodot,
  importPhaser,
  importUnity,
  orientationAffine,
  orientationAnchor,
  scaleAtlas,
  scaleNearest,
  serializeAssetMeta,
  serializeSprite,
  setIdFactory,
  toAsepriteJson,
  validateAssetNaming,
  type AssetImportResult,
  type AssetMeta,
  type AssetMetaLicense,
  type AssetMetaOutput,
  type AssetNamingReport,
  type Atlas,
  type AtlasOptions,
  type ColorInput,
  type DirectionAnchorName,
  type DirectionId,
  type Editor,
  type GifOptions,
  type Palette,
  type Sprite,
  type TagDirection,
} from '../packages/core/src/index.js';

/* ------------------------------------------------------------------ *
 * Re-exported types
 * ------------------------------------------------------------------ */

/**
 * The types a consumer names in its own source, re-exported from the entry.
 *
 * **Without this, `.d.ts` alone is not enough.** The functions above reference `Sprite`,
 * `Palette` and the rest, so a consumer who wants to write `function build(s: SpriteSpec):
 * Sprite` has to reach for `core.Sprite` — the internal tier — to name the type the stable tier
 * hands back. That inverts the whole point of the two tiers: a build script would be importing
 * from the escape hatch to describe its own variables. Re-exporting is additive and pins
 * nothing, so it does not move `API_VERSION`.
 *
 * These are **re-exports, not new declarations**: `Sprite` here is the same type as
 * `core.Sprite`, and `docs/API.md` says plainly that the internals of a `Sprite` are not
 * covered by this contract.
 */
export type {
  /** A finished document. Read `width`, `height`, `frames`, `layers`, `tags`, `palette`; the rest is internal. */
  Sprite,
  /** A palette object, when `PaletteSpec` is not a plain list of colours. */
  Palette,
  /** Anything a command accepts as a colour: hex, RGB, palette shorthand, or a named ramp. */
  ColorInput,
  /** The eight compass points, from `getDirectionModel` and `buildWalkAnimation`. */
  DirectionId,
  /** The three named orientation anchors. `ground` is the default. */
  DirectionAnchorName,
  /** Layout options for the sheet, forwarded to `core.buildSpritesheet` unchanged. */
  AtlasOptions,
  /** Options for the GIF output. */
  GifOptions,
  /** Playback direction of an animation tag. */
  TagDirection,
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
 * would wrongly conclude that it had. Bumped only for a breaking change to any stable
 * function below — a rename, a removal, a required field, or a narrowed type. **Adding** a
 * function, a spec field or a plan field is additive and does not move it, which is why
 * `buildWalkAnimation`, `getDirectionModel`, `exportEngineAssets` and `traceSvg` shipped
 * without a bump. `docs/API.md` is the policy.
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
 * Eight directions
 * ------------------------------------------------------------------ */

/** What one direction costs and what it needs. Read by {@link getDirectionModel}. */
export interface DirectionSummary {
  id: DirectionId;
  /** Human label, e.g. `'north-east'`. */
  label: string;
  /** Compass position clockwise from N: 0 = N, 4 = S. */
  compassIndex: number;
  /** Where the character looks, in canvas units. Y grows downward, so `N` is `{x: 0, y: -1}`. */
  facing: { x: number; y: number };
  /** True when a quarter turn and/or mirror reproduce this direction exactly. */
  exact: boolean;
  /**
   * The drawing this direction reuses: the base `E`, or a diagonal that has to be drawn.
   *
   * Three distinct values across the eight, which is the whole point of the model: an
   * eight-direction character is three drawings, not eight sheets.
   */
  drawing: DirectionId;
  /** The cardinal this direction's transform actually lands on. 45 degrees away when `!exact`. */
  resolvedFrom: DirectionId;
  /** The canvas matrix that produces this direction from the E base drawing. */
  matrix: { a: number; b: number; c: number; d: number; e: number; f: number };
}

/** The angle model for one canvas: what to draw, and where each direction lands. */
export interface DirectionModel {
  /** The direction the base pose is drawn in. Everything else is derived from it. */
  baseDirection: DirectionId;
  /** The point every direction leaves fixed, so a turn is a turn and not a slide. */
  anchor: DirectionAnchorName;
  pivot: { x: number; y: number };
  /** Directions reproduced exactly by a transform, so they need no artwork of their own. */
  exact: DirectionId[];
  /**
   * Directions that have to be drawn: the diagonals, because there is no pixel-exact 45-degree
   * transform and this engine will not approximate one.
   */
  approximate: DirectionId[];
  /** Every direction, clockwise from N. */
  directions: DirectionSummary[];
}

/**
 * The eight-direction angle model for a canvas, as data.
 *
 * Read-only and derived — it writes nothing and allocates no ids — so it is safe to call in a
 * build script's planning step before deciding what to draw. The shape of the question is
 * "which three sheets do I actually have to make, and where does each direction land", and
 * this answers it without asking the caller to know the transform scheme.
 *
 * ```js
 * const model = getDirectionModel({ width: 32, height: 32 });
 * model.exact;        // ['N', 'E', 'S', 'W']
 * model.approximate;  // ['NE', 'SE', 'SW', 'NW']  — draw these
 * ```
 *
 * **Determinism.** Integer coefficients throughout: a quarter turn is a signed permutation
 * of the axes and a mirror negates one row, so the matrices are bit-identical on every
 * machine. No trigonometry appears, and `packages/core/test/determinism.test.ts` bans it
 * from `src` for exactly this reason.
 *
 * **Throws** `CommandError` (`invalid_params`) for a non-positive or non-integer canvas size,
 * and for an unknown `anchor`.
 */
export function getDirectionModel(canvas: { width: number; height: number }, anchor: DirectionAnchorName = 'ground'): DirectionModel {
  assertCanvasSize(canvas.width, 'width');
  assertCanvasSize(canvas.height, 'height');
  if (anchor !== 'ground' && anchor !== 'facing' && anchor !== 'origin') {
    throw new CommandError(
      `anchor must be one of ground, facing, origin — got ${describe(anchor)}`,
      'invalid_params',
    );
  }
  const pivot = orientationAnchor(anchor, canvas.width, canvas.height);
  return {
    baseDirection: 'E',
    anchor,
    pivot,
    exact: DIRECTIONS.filter((spec) => spec.exact).map((spec) => spec.id),
    approximate: DIRECTIONS.filter((spec) => !spec.exact).map((spec) => spec.id),
    directions: DIRECTIONS.map((spec) => ({
      id: spec.id,
      label: spec.label,
      compassIndex: spec.compassIndex,
      facing: spec.facing,
      exact: spec.exact,
      drawing: spec.drawing,
      resolvedFrom: spec.resolvedFrom,
      matrix: orientationAffineOf(spec, pivot),
    })),
  };
}

/** The affine for one direction about one pivot. A named helper so the model stays readable. */
function orientationAffineOf(
  spec: (typeof DIRECTIONS)[number],
  pivot: { x: number; y: number },
): { a: number; b: number; c: number; d: number; e: number; f: number } {
  const matrix = orientationAffine(spec, pivot);
  return { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f };
}

/** The gait knobs, one field per command parameter. Every field has the command's own default. */
export interface WalkOptions {
  /** Frames in one gait cycle. Even counts read best, because a cycle has two contacts. Defaults to 4. */
  frames?: number;
  /** Duration of every generated frame in ms. Defaults to 120. */
  frameDurationMs?: number;
  /** Peak horizontal foot travel in pixels. Defaults to 2. */
  stride?: number;
  /** Peak body lift between a contact and the next passing frame, in pixels. Defaults to 1. */
  bob?: number;
  /** Peak leg tilt at the ends of the swing, in degrees. Defaults to 6. */
  legSwingDegrees?: number;
  /** Rig part names or ids to treat as legs. Defaults to name-matched parts. */
  legs?: string[];
  /** Rig part names or ids to treat as arms. Defaults to name-matched parts. */
  arms?: string[];
  /** Rig part names or ids that carry the body bob. Defaults to name-matched parts. */
  body?: string[];
  /** Whole frames to advance before frame 0, for staggering one loop against another. Defaults to 0. */
  phaseOffset?: number;
  /** Tag covering the generated frames. Defaults to `walk_<direction lowercased>`. */
  tagName?: string;
  /** Tag playback direction. Defaults to `forward`. */
  loopDirection?: TagDirection;
  /** Tag repeat count. 0 loops forever. Defaults to 0. */
  repeat?: number;
  /** First destination frame. Defaults to the frame after the rig rest frame. */
  targetFrame?: number;
  /** Required when a destination frame already holds pixels. */
  overwrite?: boolean;
}

/**
 * A {@link SpriteSpec} plus one direction and the gait to generate in it.
 *
 * `ops` should create the rig (`create_rig`) and draw the rest pose into the rig rest frame;
 * the walk frames are then rendered *from* that frame. Everything else is inherited from
 * {@link AnimationSpec}.
 */
export interface WalkSpec extends AnimationSpec {
  /**
   * Which way the character faces. Defaults to `E`, the base drawing.
   *
   * A diagonal (`NE`, `SE`, `SW`, `NW`) is resolved from the cardinal it is nearest, and the
   * result says so: the transform lands 45 degrees from the direction it names, because a
   * diagonal is a different *drawing* and not a rotated copy of a cardinal.
   */
  direction?: DirectionId;
  /** Named anchor the direction turns about. Defaults to `ground`, the contact point under the feet. */
  anchor?: DirectionAnchorName;
  /** Explicit orientation pivot in pixels, overriding `anchor`. */
  pivot?: { x: number; y: number };
  /** The gait. Omit it entirely for every default; it is one flat object, not a nested section. */
  walk?: WalkOptions;
}

/**
 * Build a sprite and generate one direction's walk cycle in it, then return it.
 *
 * Identical to {@link buildAnimation} plus the `generate_walk_cycle` command, appended after
 * your ops so the rig and the rest pose exist before the gait is baked. It goes through the
 * bus like everything else here, so the gait frames are real frames in the document: real
 * durations, a real looping tag, one undo step.
 *
 * ```js
 * const walk = buildWalkAnimation({
 *   seed: 7, width: 32, height: 32, name: 'hero',
 *   layers: ['body', 'legs'],
 *   direction: 'S',
 *   walk: { frames: 6, stride: 3 },
 *   ops: [
 *     {
 *       command: 'create_rig',
 *       params: {
 *         parts: [
 *           { name: 'body', pivot: { x: 16, y: 10 } },
 *           { name: 'legL', pivot: { x: 14, y: 20 }, parent: 'body' },
 *           { name: 'legR', pivot: { x: 18, y: 20 }, parent: 'body' },
 *         ],
 *       },
 *     },
 *     { command: 'draw_rect', params: { layer: 'body', rect: { x: 12, y: 8, w: 8, h: 12 }, color: '#8bac0f' } },
 *     { command: 'draw_rect', params: { layer: 'legL', rect: { x: 13, y: 20, w: 2, h: 8 }, color: '#0f380f' } },
 *     { command: 'draw_rect', params: { layer: 'legR', rect: { x: 17, y: 20, w: 2, h: 8 }, color: '#0f380f' } },
 *   ],
 * });
 * ```
 *
 * **One call is one direction.** To fill a full set, call it eight times with distinct
 * `tagName`s, or loop over `getDirectionModel(...).directions` — which is also the list of
 * which three sheets you actually have to draw.
 *
 * **The loop closes.** The gait is integer triangle waves sampled modulo `frames`, so frame
 * `frames` is the *same pose* as frame `0` and the last frame leads straight back into the
 * first. There is no duplicated end frame and therefore no seam.
 *
 * **Throws** `CommandError` (`invalid_params`) for a bad canvas size or seed,
 * (`command_failed`) for an op the command rejected — naming its index — or for a missing rig,
 * which is the realistic failure here and is reported as an op context rather than as a
 * surprise.
 */
export function buildWalkAnimation(spec: WalkSpec): Sprite {
  const direction = spec.direction ?? 'E';
  const walk = spec.walk ?? {};
  const walkOp: AssetOp = {
    command: 'generate_walk_cycle',
    label: `walk cycle ${direction}`,
    params: compact({
      direction,
      anchor: spec.anchor,
      pivot: spec.pivot,
      frames: walk.frames,
      frameDurationMs: walk.frameDurationMs,
      stride: walk.stride,
      bob: walk.bob,
      legSwingDegrees: walk.legSwingDegrees,
      legs: walk.legs,
      arms: walk.arms,
      body: walk.body,
      phaseOffset: walk.phaseOffset,
      tagName: walk.tagName,
      loopDirection: walk.loopDirection,
      repeat: walk.repeat,
      targetFrame: walk.targetFrame,
      overwrite: walk.overwrite,
    }),
  };
  // Appended rather than prepended: the rig and the rest pose are the spec's own ops, and the
  // gait renders from the rest frame. Running it first would bake into nothing.
  return buildAnimation({ ...spec, ops: [...(spec.ops ?? []), walkOp] });
}

/** Drop `undefined` fields so an absent optional is absent, not `undefined`, for a `.strict()` schema. */
function compact(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The asset contract and the engine importers
 * ------------------------------------------------------------------ */

/**
 * The four engines `exportEngineAssets` can write.
 *
 * A string union rather than the importers' four option types, because the point of the
 * task-shaped surface is that a caller does not have to know there are four separate
 * mappings. `exportEngineAssets` is one function with one plan.
 */
export type AssetEngineId = 'godot' | 'unity' | 'phaser' | 'excalidraw';

/**
 * Which engine, and which of its knobs.
 *
 * The per-engine options are one field rather than a union of four, because they are passed
 * straight to that engine's importer and typed as `Record<string, unknown>`: the four mappings
 * are genuinely different problems, and a discriminated union here would only be a second
 * spelling of what `core.importGodot` and friends already say. `godot` takes none.
 */
export interface EngineExportPlan {
  /** Which engine's files to write. */
  engine: AssetEngineId;
  /**
   * Also write `meta.json` beside them.
   *
   * Defaults to `true`, because every importer reads a contract and the contract is what makes
   * the engine files checkable: an engine file with no `meta.json` next to it cannot be
   * regenerated, diffed or validated. The MCP surface makes both outputs opt-in because a tool
   * writes where it was told to; a build script that asked for Godot files asked for a bundle.
   */
  meta?: boolean;
  /** Where `meta.json` is written, relative to the engine files' root. Defaults to `meta.json`. */
  metaPath?: string;
  /**
   * Describe a spritesheet in the contract.
   *
   * `true` packs one with default options; an object passes layout options to
   * `core.buildSpritesheet`. Omit it when the bundle is individual frame PNGs.
   */
  sheet?: SheetOptions | boolean;
  /** Other files in the bundle, listed in the contract. The sheet itself is never repeated here. */
  outputs?: readonly AssetMetaOutput[];
  /**
   * Licensing. Never invented: omit it and the contract says nothing about permission, which
   * is the only honest answer when the document model has no field for it.
   */
  license?: AssetMetaLicense;
  /**
   * Which way each frame faces, one entry per frame in timeline order.
   *
   * A caller option, never derived. An unrecognised label is refused rather than dropped: a
   * character that silently faces the wrong way in the game is not traceable from the sheet.
   */
  directions?: readonly (string | null)[];
  /** Integer upscale applied to the packed sheet, matching `exportAssets`'s `scale`. Defaults to 1. */
  scale?: number;
  /** Fill the background behind the sheet instead of leaving it transparent. */
  background?: ColorInput | null;
  /** File name stem for the sheet and the contract. Defaults to the sprite's name. */
  name?: string;
  /**
   * Override the importer's suggested root folder. A relative path, forward slashes.
   *
   * Each segment is passed through the same filename sanitiser the output paths use, so a
   * hostile name cannot walk out of the directory the caller joins it onto — but the segments
   * are kept separate, because a nested destination is a legitimate thing to ask for.
   */
  directory?: string;
  /** Passed straight to the chosen importer. `godot` takes no options. */
  options?: Record<string, unknown>;
}

/** One engine file, as bytes. */
export interface EngineAssetFile {
  /** Relative to the returned `root`, forward slashes. */
  path: string;
  bytes: Uint8Array;
  /** What the file is for, for the caller's own manifest. Free-form. */
  role: string;
}

/** A whole engine bundle: the contract, the engine's files, and what the mapping could not carry. */
export interface EngineExportResult {
  /** Suggested folder for the bundle. Every returned path is relative to it. */
  root: string;
  files: EngineAssetFile[];
  /**
   * Everything the mapping could not carry across — a dropped per-frame duration, a lost
   * pivot convention — stated rather than hidden.
   *
   * **Strings, never a number.** There is no score here to optimise and no "quality" verdict
   * to move artwork towards; it is the lossiness list from the contract's own S9, which is
   * what a build log needs and nothing more.
   */
  warnings: string[];
  /** The contract as written, so a caller can log the identity without re-parsing. */
  meta: AssetMeta;
  /** The naming check on the bundle. A report, not a score: see `AssetNamingReport`. */
  naming: AssetNamingReport;
}

/**
 * Write one engine's files for a sprite, with the `meta.json` they are built from.
 *
 * This is the whole point of the asset contract from a build script's side: a caller who wants
 * Godot output should not have to hand-assemble `{root, files, warnings}`, serialise the
 * contract, validate the names, and join the paths segment by segment. One call does all of
 * it, and it is the same contract and the same importers the MCP server's `finalize_document`
 * uses — so an asset produced by a build script and one produced by an agent are the same
 * bytes.
 *
 * ```js
 * const bundle = exportEngineAssets(sprite, { engine: 'godot', sheet: true });
 * for (const file of bundle.files) {
 *   await writeFile(join('assets', bundle.root, file.path), file.bytes);
 * }
 * console.log(bundle.warnings); // what Godot's mapping could not carry
 * ```
 *
 * **Nothing is written and nothing is read.** Where the bytes go is the build script's
 * business, exactly as for {@link exportAssets}.
 *
 * **Determinism.** The contract carries no timestamp and no invented `uid://`, the file order
 * is the importer's, and the naming report is a pure function of the names. Same sprite, same
 * plan, same bytes, in any process.
 *
 * **Throws** `CommandError` (`invalid_params`) for an unknown `engine` or a `scale` that is not
 * a positive integer, and whatever the underlying generator raises — a tileset or a tilemap has
 * no schemaVersion 1 contract, and an unlabelled or wrongly-labelled facing is refused.
 */
export function exportEngineAssets(sprite: Sprite, plan: EngineExportPlan): EngineExportResult {
  const scale = plan.scale ?? 1;
  if (!Number.isInteger(scale) || scale < 1) {
    throw new CommandError(
      `scale must be a positive integer upscale factor, got ${describe(scale)}`,
      'invalid_params',
    );
  }
  const stem = fileStem(plan.name ?? sprite.name);
  const background = plan.background ?? null;

  const sheetPath = `${stem}_sheet.png`;
  const wantsSheet = plan.sheet !== undefined && plan.sheet !== false;
  const atlas = wantsSheet
    ? sheetOf(sprite, plan.sheet === true ? {} : (plan.sheet as SheetOptions), background, scale)
    : null;

  const meta = buildAssetMeta(sprite, {
    ...(atlas ? { sheet: { atlas, image: sheetPath } } : {}),
    ...(plan.outputs ? { outputs: plan.outputs } : {}),
    ...(plan.license ? { license: plan.license } : {}),
    ...(plan.directions ? { directions: plan.directions } : {}),
  });

  // Naming runs on the contract *before* anything is produced, and before the importer: an
  // engine file named after a reserved device or a case-colliding path is a broken build, and
  // the contract is where the bundle's file list lives. A reserved device name would otherwise
  // fail here, on the build machine, much later than the mistake.
  const naming = validateAssetNaming(meta);
  if (!naming.ok) {
    const errors = naming.diagnostics.filter((d) => d.severity === 'error');
    const codes = [...new Set(errors.map((d) => d.code))].join(', ');
    throw new CommandError(
      `Asset naming refuses this bundle: ${errors.length} error(s) [${codes}]. First: ${
        errors[0].path === '' ? 'the contract' : `"${errors[0].path}"`
      } - ${errors[0].message}`,
      'invalid_params',
      { diagnostics: naming.diagnostics },
    );
  }

  const importer = ENGINE_IMPORTERS[plan.engine];
  if (!importer) {
    throw new CommandError(
      `Unknown engine ${describe(plan.engine)}. Expected one of ${Object.keys(ENGINE_IMPORTERS).join(', ')}.`,
      'invalid_params',
    );
  }
  const imported = importer(meta, plan.options);

  const root = plan.directory === undefined
    ? fileStem(imported.root)
    // Sanitised per segment rather than as a whole string, because `directory` is a *path*:
    // folding `assets/godot` into one safe segment would turn a nested destination into a flat
    // one and silently relocate a build's output.
    : plan.directory.split('/').map(fileStem).join('/');
  const files: EngineAssetFile[] = [];
  const encoder = new TextEncoder();
  if (atlas) {
    files.push({ path: sheetPath, bytes: encodePNG(atlas.image), role: 'sheet' });
  }
  if (plan.meta !== false) {
    // Serialised once and used once, but stated as a single call anyway: a second call would be
    // a second chance for the bytes written and the bytes reported to differ.
    files.push({
      path: plan.metaPath ?? 'meta.json',
      bytes: encoder.encode(serializeAssetMeta(meta)),
      role: 'contract',
    });
  }
  for (const file of imported.files) {
    files.push({ path: file.path, bytes: encoder.encode(file.contents), role: file.role });
  }
  return { root, files, warnings: [...imported.warnings], meta, naming };
}

/** The four importers, in one table. A switch would hide that these are four different mappings. */
const ENGINE_IMPORTERS: Record<
  AssetEngineId,
  (input: unknown, options: Record<string, unknown> | undefined) => AssetImportResult
> = {
  // Godot takes no options; `options` is accepted and ignored so the table has one shape. An
  // options object handed to it is a caller mistake worth naming rather than a crash.
  godot: (input, options) => {
    if (options && Object.keys(options).length > 0) {
      throw new CommandError(
        `The Godot importer takes no options, but ${describe(Object.keys(options).join(', '))} ${
          Object.keys(options).length === 1 ? 'was' : 'were'
        } given. The other three engines do take options.`,
        'invalid_params',
      );
    }
    return importGodot(input);
  },
  unity: (input, options) => importUnity(input, options as never),
  phaser: (input, options) => importPhaser(input, options as never),
  excalidraw: (input, options) => importExcalidraw(input, options as never),
};

/* ------------------------------------------------------------------ *
 * SVG trace import
 * ------------------------------------------------------------------ */

/**
 * A {@link SpriteSpec} plus the vector outline to trace into it.
 *
 * `svg` is the source as **text**, not a path: core has no filesystem, so a build script
 * reads the file and hands the string over. Everything else is inherited.
 */
export interface SvgTraceSpec extends SpriteSpec {
  /** The SVG source, as text. `path`/`rect`/`circle`/`ellipse`/`polygon`/`polyline`, filled. */
  svg: string;
  /** Layer to trace into. Defaults to the bottom layer, the same default as every other op. */
  layer?: string;
  /** Frame to trace into. Defaults to frame 0. */
  frame?: number;
  /** Paint the whole trace in one colour instead of each shape's own `fill`. */
  color?: ColorInput;
  /** SVG user units per pixel. A 512-unit icon into a 32px canvas is 16. Defaults to 1. */
  scale?: number;
  /** Pixel position that SVG (0,0) maps to. Defaults to (0,0). */
  offset?: { x: number; y: number };
  /** Curve-flattening error in pixels. Defaults to 0.1; lower it for a shape far larger than the canvas. */
  tolerance?: number;
  /** Trace only the part of the geometry inside this rect. */
  rect?: { x: number; y: number; w: number; h: number };
  /** Clear the traced pixels before painting them. */
  replace?: boolean;
}

/**
 * Build a sprite from a filled SVG outline, and return it.
 *
 * The road from vector to pixel, in one call: it sizes the canvas, creates the layers and
 * runs the `trace_svg` command, so a build script that has an exported icon does not have to
 * know that scan-conversion is a command called `trace_svg` with a `scale` in *SVG units per
 * pixel*. A PNG import cannot recover the geometry; a traced outline lands on the grid exactly.
 *
 * ```js
 * const icon = traceSvg({
 *   svg: await readFile('assets/logo.svg', 'utf8'),
 *   width: 32, height: 32, name: 'logo',
 *   palette: ['#1a1c2c', '#5d275d', '#ef7d57', '#ffcd75'],
 *   scale: 16,           // a 512-unit-wide icon lands 32px wide
 * });
 * ```
 *
 * **Coverage is hard-edged by design.** A traced outline is a pixel edge, not a ramp of
 * intermediate alphas; run an `antialias` op afterwards if the staircase is too coarse.
 * Transforms and paint servers are refused rather than approximated, so an SVG that needs
 * flattening fails loudly here instead of landing in the wrong place silently.
 *
 * **What it refuses.** An SVG with no traceable filled geometry, an unsupported construct
 * (`transform`, an inherited `fill`, `fill: url(#…)`), or malformed path data. The refusal
 * arrives as `CommandError` with code `command_failed` and the reason nested in `details`,
 * because `editor.execute` re-wraps every command failure: read
 * `error.details.details.reason` for `'svg_unsupported'`, `'svg_malformed'` or `'svg_empty'`
 * and `error.details.code` for the original `'invalid_params'`.
 *
 * **Determinism.** The tracer's own trigonometry is Cody-Waite plus fdlibm kernels rather
 * than `Math.sin`, because V8, JSC and SpiderMonkey may disagree in the last ULP and an
 * outline that moves a pixel between two engines is not a bug anyone can debug. Same SVG, same
 * canvas, same pixels, on every machine.
 */
export function traceSvg(spec: SvgTraceSpec): Sprite {
  return buildSprite({
    ...spec,
    ops: [
      ...(spec.ops ?? []),
      {
        command: 'trace_svg',
        label: 'trace svg',
        params: compact({
          svg: spec.svg,
          layer: spec.layer,
          frame: spec.frame,
          color: spec.color,
          scale: spec.scale,
          offset: spec.offset,
          tolerance: spec.tolerance,
          rect: spec.rect,
          replace: spec.replace,
        }),
      },
    ],
  });
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
