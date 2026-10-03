import type { AssetMeta } from '../schema.js';
import {
  engineNumber,
  readAssetMeta,
  toJsonFile,
  WarningBag,
  type AssetImportFile,
  type AssetImportResult,
} from './types.js';

/**
 * The Phaser importer: `meta.json` in, a loader config, the animations, and — when the sheet
 * needs one — a texture-atlas JSON.
 *
 * ## The one decision that shapes everything here
 *
 * Phaser's `load.spritesheet(key, url, {frameWidth, frameHeight})` slices by grid and ignores
 * `sheet.regions` entirely. That is fine for a 1:1 tightly packed sheet and wrong in two cases
 * S9.3 names: a grid that does not divide evenly, and a sheet written at 2x or more. For those
 * this emits `load.atlas` with a TexturePacker-hash-format JSON beside it, which addresses
 * every cell by its real rectangle. A `sheet.scale > 1` always takes the atlas path, because
 * Phaser has no notion of an upscale and would slice a 2x sheet into 2x-sized cells with no way
 * to say so.
 *
 * ## What is lost
 *
 * Per-frame timing. `anims.create` takes one `frameRate` per animation, so a 100/100/200 ms
 * timeline plays as three equal frames. The per-frame durations are carried through in the
 * emitted module as a comment-free `frameDurationsMs` field on each anim, so a game that needs
 * the exact timing can drive it from `anims.timeScale` per frame — and the warning says that
 * this is what the numbers are for. Repeat maps directly: `repeat: -1` for a loop, `n - 1` for
 * an `n`-pass animation, because Phaser counts repeats *after* the first play.
 */

export interface PhaserImportOptions {
  /**
   * Texture key the loader registers the sheet under. Defaults to the asset name, which is what
   * the animation frame entries reference.
   */
  readonly textureKey?: string;
  /**
   * Emit `load.spritesheet` even when an atlas would be more faithful. Provided because the
   * sprite-sheet loader is one fewer file and one fewer cache entry, and for a plain 1:1 sheet
   * it is exactly right.
   */
  readonly preferSpritesheet?: boolean;
}

export function importPhaser(input: unknown, options: PhaserImportOptions = {}): AssetImportResult {
  const meta = readAssetMeta(input);
  const warnings = new WarningBag();
  const key = options.textureKey ?? meta.asset.name;
  const files: AssetImportFile[] = [];

  const animations = meta.animations?.items ?? [];
  for (const animation of animations) {
    const durations = animation.frames.map((index) => meta.frames.durationsMs[index]);
    if (isNonUniform(meta, animation.frames)) {
      // The quoted durations are this animation's own frames, not the whole timeline: a four-frame
      // asset whose second animation covers two uniform frames is perfectly representable here,
      // and quoting the whole timeline makes the reader chase a problem it does not have.
      warnings.add(
        `Animation "${animation.name}" has non-uniform frame durations (${durations.join(
          '/',
        )} ms). Phaser takes one frameRate per animation, so this plays every frame for ${(
          1000 / animation.fps
        ).toFixed(3)} ms; the exact durations are in the emitted frameDurationsMs for a per-frame timeScale if the game needs them.`,
      );
    }
  }

  const sheet = meta.sheet;
  const useAtlas =
    sheet !== undefined && (options.preferSpritesheet !== true) && (sheet.scale > 1 || !dividesEvenly(meta));

  if (sheet && sheet.scale > 1) {
    warnings.add(
      `The sheet is ${sheet.scale}x upscale, so Phaser's frameWidth/frameHeight grid loader cannot describe it and a texture atlas is emitted instead.`,
    );
  }
  if (sheet && !dividesEvenly(meta) && !useAtlas) {
    warnings.add(
      `The sheet is ${sheet.columns}x${sheet.rows} of ${engineNumber(sheet.size.width)}x${engineNumber(
        sheet.size.height,
      )} px, which does not divide evenly into ${engineNumber(meta.frames.size.width * sheet.scale)}x${engineNumber(
        meta.frames.size.height * sheet.scale,
      )} cells. A texture atlas is emitted so every region is addressed by its real rectangle.`,
    );
  }
  if (!sheet) {
    warnings.add(
      'This bundle has no sheet. Phaser needs a single texture to animate; the emitted config assumes the individual frame PNGs are loaded separately under the same key, which only works for a single frame.',
    );
  }
  if (animations.length === 0) {
    warnings.add('This contract has no animations, so the emitted `anims` object is empty.');
  }

  if (useAtlas) {
    files.push({
      path: `${meta.asset.name}-atlas.json`,
      role: 'phaser-atlas',
      contents: toJsonFile(textureAtlasJson(meta, key)),
    });
  }

  files.push({
    path: `${meta.asset.name}.phaser.mjs`,
    role: 'phaser-module',
    contents: moduleSource(meta, key, useAtlas),
  });

  return { root: meta.asset.name, files, warnings: warnings.list(), meta };
}

/** True when the sheet image divides exactly into a grid of whole cells, at the sheet's scale. */
function dividesEvenly(meta: AssetMeta): boolean {
  const sheet = meta.sheet;
  if (!sheet) return false;
  const cellW = meta.frames.size.width * sheet.scale;
  const cellH = meta.frames.size.height * sheet.scale;
  if (cellW <= 0 || cellH <= 0) return false;
  return sheet.size.width % cellW === 0 && sheet.size.height % cellH === 0;
}

/**
 * TexturePacker hash format, which is what `load.atlas` parses.
 *
 * `scale` is `"1"` deliberately and the rects are the sheet's own pixels: Phaser divides rects
 * by `meta.scale`, and this contract's upscale is a property of the PNG on disk, so baking it
 * into `scale` would silently rescale the artwork a second time.
 */
function textureAtlasJson(meta: AssetMeta, key: string): Record<string, unknown> {
  const sheet = meta.sheet!;
  const frames: Record<string, unknown> = {};
  for (const region of sheet.regions) {
    frames[`${key}_${region.index}`] = {
      frame: { x: region.x, y: region.y, w: region.width, h: region.height },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: region.width, h: region.height },
      sourceSize: { w: region.width, h: region.height },
    };
  }
  return {
    frames,
    meta: {
      app: 'dotloom-mcp',
      version: '1.0',
      image: sheet.image.split('/').pop(),
      format: 'RGBA8888',
      size: { w: sheet.size.width, h: sheet.size.height },
      scale: '1',
      // Cell size and the animation ranges, so a tool reading the atlas has the geometry
      // without the meta.json beside it. `sprite` keeps the per-frame durations, which Phaser
      // itself cannot use and which is the reason this atlas exists next to the contract.
      sprite: {
        frameSize: { w: meta.frames.size.width, h: meta.frames.size.height },
        scale: sheet.scale,
        durationsMs: meta.frames.durationsMs,
        pivot: meta.pivot,
      },
    },
  };
}

/**
 * The emitted module: a `preload` function and an `anims` config object.
 *
 * `originX`/`originY` are the pivot as a 0..1 fraction, which is what `setOrigin` takes. The
 * pivot is not lost in Phaser — it just has to be applied per sprite at spawn time, so it is
 * carried as a first-class field rather than left to the caller to re-derive from the contract.
 */
function moduleSource(meta: AssetMeta, key: string, useAtlas: boolean): string {
  const sheet = meta.sheet;
  const animations = meta.animations?.items ?? [];
  const originX = meta.frames.size.width === 0 ? 0 : round(meta.pivot.x / meta.frames.size.width, 4);
  const originY = meta.frames.size.height === 0 ? 0 : round(meta.pivot.y / meta.frames.size.height, 4);

  const animEntries = animations.map((animation) => {
    const frames = animation.frames.map((frame) => ({
      key,
      frame: `${key}_${frame}`,
      duration: meta.frames.durationsMs[frame],
    }));
    // Phaser's `repeat` counts plays *after* the first, so an n-pass animation is `n - 1` and a
    // loop is -1. Getting this wrong by one is the classic off-by-one that plays an attack
    // twice, so it is derived here rather than left to the caller.
    const repeat = animation.loop ? -1 : Math.max(0, animation.repeat - 1);
    return (
      `  ${JSON.stringify(animation.name)}: {\n` +
      // Compact rather than `toJsonFile`'s two-space form: these are literals inside a generated
      // module, so re-indenting a nested array is noise in the diff a reviewer actually reads.
      `    frames: ${JSON.stringify(frames)},\n` +
      `    frameRate: ${engineNumber(animation.fps)},\n` +
      `    repeat: ${repeat},\n` +
      // The exact per-frame holds, kept because Phaser cannot use them itself: a caller that
      // needs the original timing reads this and drives `timeScale` per frame.
      `    frameDurationsMs: ${JSON.stringify(
        animation.frames.map((frame) => meta.frames.durationsMs[frame]),
      )},\n` +
      '  }'
    );
  });

  const loader =
    useAtlas && sheet
      ? [
          `  scene.load.atlas(${JSON.stringify(key)}, ${JSON.stringify(sheet.image)}, ${JSON.stringify(
            `${key}-atlas.json`,
          )});`,
        ]
      : [
          `  scene.load.spritesheet(${JSON.stringify(key)}, ${JSON.stringify(
            sheet ? sheet.image : `${meta.asset.name}.png`,
          )}, {\n` +
            `    frameWidth: ${meta.frames.size.width * (sheet?.scale ?? 1)},\n` +
            `    frameHeight: ${meta.frames.size.height * (sheet?.scale ?? 1)},\n` +
            '  });',
        ];

  return [
    '// Generated by dotloom-mcp from meta.json. Import and call preload(this) from a scene,',
    '// then scene.anims.create(createAnimations()).',
    '',
    `export const TEXTURE_KEY = ${JSON.stringify(key)};`,
    `export const FRAME_SIZE = { width: ${meta.frames.size.width}, height: ${meta.frames.size.height} };`,
    `export const DURATIONS_MS = ${JSON.stringify(meta.frames.durationsMs)};`,
    // The pivot as Phaser wants it, for setOrigin at spawn time.
    `export const ORIGIN = { x: ${originX}, y: ${originY} };`,
    `export const DEFAULT_ANIMATION = ${
      meta.animations ? JSON.stringify(meta.animations.default) : 'null'
    };`,
    '',
    'export function preload(scene) {',
    ...loader,
    '}',
    '',
    'export function createAnimations() {',
    '  return {',
    '    key: TEXTURE_KEY,',
    '    frames: createAnimations.frames,',
    '    anims: {',
    ...animEntries,
    '    },',
    '  };',
    '}',
    '',
    '/** Every frame this asset owns, so a caller can build a frame list or a manual index. */',
    'createAnimations.frames = [',
    ...meta.frames.durationsMs.map(
      (_duration, index) =>
        `  { key: TEXTURE_KEY, frame: \`\${TEXTURE_KEY}_${index}\`, duration: ${meta.frames.durationsMs[index]} },`,
    ),
    '];',
    '',
  ].join('\n');
}

/**
 * True when the frames this animation lists do **not** all hold for the same time.
 *
 * Named and written as a negative on purpose. The predicate body is "some frame differs from
 * the first", and the positive spelling of that is `every(f => f === first)` — which looks
 * identical and is the shape this function actually had at one point, inverted, so the warning
 * fired on exactly the animations that were fine and stayed silent on the two that stutter.
 * A named negative is the version that survives being read again.
 */
function isNonUniform(meta: AssetMeta, frameIndices: readonly number[]): boolean {
  const first = meta.frames.durationsMs[frameIndices[0]];
  return frameIndices.some((index) => meta.frames.durationsMs[index] !== first);
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}
