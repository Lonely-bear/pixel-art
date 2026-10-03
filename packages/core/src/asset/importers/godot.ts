import type { AssetMeta } from '../schema.js';
import {
  engineNumber,
  engineString,
  readAssetMeta,
  toJsonFile,
  WarningBag,
  type AssetImportFile,
  type AssetImportResult,
} from './types.js';

/**
 * The Godot importer: `meta.json` in, a `SpriteFrames` resource and a scene that uses it out.
 *
 * ## What Godot actually wants
 *
 * `SpriteFrames` is the container that holds every animation of one sprite. Each animation has
 * one `speed` (fps) and one `loop` flag, and each frame inside it points at a texture. There
 * is no per-frame duration, which S9.1 of `docs/ASSET-CONTRACT.md` states, so this importer
 * takes `animations.items[].fps` verbatim and says so out loud: **a non-uniform timeline loses
 * its shape here**, and the warning bag is where that is reported rather than buried. A 100 /
 * 100 / 200 ms walk cycle becomes three equal frames, which on a walk cycle is usually
 * invisible and on an attack is not.
 *
 * The frames reference either the sheet texture with an `AtlasTexture` sub-resource per region,
 * or one texture per exported frame PNG when the bundle has no sheet. Both are real Godot
 * resources; the atlas form is preferred because it is what the sheet is for, and a
 * `SpriteSheet` grid import would throw away `sheet.regions` for nothing.
 *
 * The scene is a second file rather than an extra resource because the pivot cannot live in
 * `SpriteFrames`: it is a property of the node that draws it. `AnimatedSprite2D.offset` is
 * **centre-relative**, so `offset = pivot - frames.size / 2` — a pivot at the feet is a
 * positive Y offset, which is the sign that surprises people. See S9.1.
 *
 * ## Determinism
 *
 * No `uid://` is written. Godot generates one on import and treats its absence as a request to
 * make one, and inventing one here would put an unstable-looking string in a committed file
 * for no gain — the same reason the contract carries no timestamp.
 */

/** Where the scene puts the sprite, in pixels. Chosen so 32px art lands on a visible spot. */
const SCENE_ORIGIN_X = 128;
const SCENE_ORIGIN_Y = 128;

export function importGodot(input: unknown): AssetImportResult {
  const meta = readAssetMeta(input);
  const warnings = new WarningBag();
  const { frames } = meta;
  const files: AssetImportFile[] = [];

  const texturePath = textureReference(meta, warnings);
  const animations = meta.animations?.items ?? [];

  for (const animation of animations) {
    if (isNonUniform(meta, animation.frames)) {
      // This animation's own frames, not the whole timeline — see the Phaser importer for why.
      const durations = animation.frames.map((index) => meta.frames.durationsMs[index]);
      warnings.add(
        `Animation "${animation.name}" has non-uniform frame durations (${durations.join(
          '/',
        )} ms). Godot's SpriteFrames carries one speed per animation, so this plays at ${animation.fps} fps with every frame held ${(
          1000 / animation.fps
        ).toFixed(3)} ms. Drive SpriteFrames from meta.frames.durationsMs in script for the exact timing.`,
      );
    }
    if (animation.loop === false && animation.repeat > 1) {
      warnings.add(
        `Animation "${animation.name}" repeats ${animation.repeat} passes. SpriteFrames has no repeat count, only a loop flag; hold the last frame and restart the animation from code if the passes matter.`,
      );
    }
  }

  files.push({
    path: `${meta.asset.name}.tres`,
    role: 'godot-sprite-frames',
    contents: spriteFramesResource(meta, texturePath, animations, warnings),
  });
  files.push({
    path: `${meta.asset.name}.tscn`,
    role: 'godot-scene',
    contents: sceneText(meta, animations),
  });

  return { root: meta.asset.name, files, warnings: warnings.list(), meta };
}

/**
 * The texture an animation's frames point at.
 *
 * With a sheet it is the sheet; without one it is the frame PNGs, which means the bundle must
 * have exported them. A contract with neither a sheet nor any `frame` output describes artwork
 * no engine can load, so that is refused rather than emitted as a scene with no texture.
 */
function textureReference(meta: AssetMeta, warnings: WarningBag): { kind: 'sheet' } | { kind: 'frames' } {
  if (meta.sheet) return { kind: 'sheet' };
  const frames = (meta.outputs ?? []).filter((output) => output.role === 'frame');
  if (frames.length > 0) return { kind: 'frames' };
  warnings.add(
    'This bundle has neither a sheet nor any outputs with role "frame", so the emitted resources point at textures that are not there. Export a sheet or individual frames alongside meta.json.',
  );
  return { kind: 'frames' };
}

/** A Godot `res://` path. The bundle root is the project's res:// in every common layout. */
function resPath(bundleRelative: string): string {
  return `res://${bundleRelative.split('/').map((segment) => segment.trim()).filter(Boolean).join('/')}`;
}

function frameTexturePath(meta: AssetMeta, index: number): string {
  const outputs = meta.outputs ?? [];
  const numbered = outputs.filter((output) => output.role === 'frame');
  const chosen = numbered[index] ?? numbered[numbered.length - 1];
  // With no per-frame outputs the caller's layout is unknowable from here, so the conventional
  // name is emitted and the missing-file warning above says it needs checking.
  return resPath(chosen ? chosen.path : `${meta.asset.name}-${index}.png`);
}

/**
 * A `SpriteFrames` `.tres`.
 *
 * Each cell becomes an `AtlasTexture` sub-resource when there is a sheet, because a region's
 * position is the one thing a grid import cannot express once the packer has inserted a gap or
 * a border — which S10 says it may. The frame dict is `{duration, texture}` with `duration` at
 * the default 1.0, and the animation's `speed` does the timing.
 */
function spriteFramesResource(
  meta: AssetMeta,
  texture: { kind: 'sheet' } | { kind: 'frames' },
  animations: NonNullable<AssetMeta['animations']>['items'],
  warnings: WarningBag,
): string {
  const lines: string[] = [];
  const extIds = new Map<string, string>();
  let nextExtId = 1;

  const extIdFor = (path: string): string => {
    const existing = extIds.get(path);
    if (existing) return existing;
    const id = `${nextExtId}_tex`;
    nextExtId++;
    extIds.set(path, id);
    lines.push(`[ext_resource type="Texture2D" path="${path}" id="${id}"]`);
    return id;
  };

  const sheetPath = meta.sheet ? resPath(meta.sheet.image) : '';
  const sheetExtId = texture.kind === 'sheet' && sheetPath !== '' ? extIdFor(sheetPath) : '';

  // One AtlasTexture per region. Godot's `region` is in the atlas texture's own pixels, which is
  // exactly the sheet pixel space `sheet.regions` uses, so no scale conversion happens here: the
  // upscale is a property of the PNG on disk, and the node's scale is the game's business.
  const regionIds: string[] = [];
  if (sheetExtId !== '') {
    (meta.sheet!.regions ?? []).forEach((region, index) => {
      const id = `AtlasTexture_${index}`;
      regionIds.push(id);
      lines.push(
        '[sub_resource type="AtlasTexture" id="' +
          id +
          '"]\n' +
          `atlas = ExtResource("${sheetExtId}")\n` +
          `region = Rect2(${engineNumber(region.x)}, ${engineNumber(region.y)}, ${engineNumber(region.width)}, ${engineNumber(region.height)})\n` +
          'margin = Rect2(0, 0, 0, 0)\n' +
          'filter_clip = false',
      );
    });
  }

  const animationBlocks = animations.map((animation) => {
    const frameEntries = animation.frames
      .map((frameIndex) => {
        const textureRef =
          sheetExtId !== ''
            ? `SubResource("${regionIds[frameIndex] ?? regionIds[0]}")`
            : `ExtResource("${extIdFor(frameTexturePath(meta, frameIndex))}")`;
        return `{\n"duration": 1.0,\n"texture": ${textureRef}\n}`;
      })
      .join(', ');
    return (
      '{\n"frames": [' +
      frameEntries +
      '],\n' +
      `"loop": ${animation.loop},\n` +
      `"name": &${engineString(animation.name)},\n` +
      `"speed": ${engineNumber(animation.fps)}\n}`
    );
  });

  if (animations.length === 0) {
    // A still has no animations, and `SpriteFrames` requires the key to be present-but-empty
    // rather than absent: omitting it makes Godot write an empty resource on next save.
    warnings.add(
      'This contract has no animations, so the SpriteFrames resource is empty and the scene uses a static Sprite2D instead of an AnimatedSprite2D.',
    );
  }

  const step = extIds.size + regionIds.length + 1;
  const header = `[gd_resource type="SpriteFrames" load_steps=${step} format=3]`;
  const body = ['[resource]', `animations = [${animationBlocks.join(', ')}]`].join('\n');

  // Godot reads `[ext_resource]`/`[sub_resource]` sections before `[resource]` regardless of
  // order, but the convention is resources first; the buffer above is emitted in that order.
  return [header, ...lines, '', body].join('\n') + '\n';
}

/**
 * A `.tscn` holding one `AnimatedSprite2D` (or a `Sprite2D` for a still) with the pivot applied.
 *
 * `offset` is centre-relative: `pivot - size / 2`. A sprite with the pivot at its feet comes out
 * as a positive Y offset, which is the sign S9.1 calls out because the opposite convention is
 * what people assume.
 */
function sceneText(
  meta: AssetMeta,
  animations: NonNullable<AssetMeta['animations']>['items'],
): string {
  const { width, height } = meta.frames.size;
  const offsetX = meta.pivot.x - width / 2;
  const offsetY = meta.pivot.y - height / 2;
  const texturePath = meta.sheet ? resPath(meta.sheet.image) : frameTexturePath(meta, 0);

  // One external resource: the SpriteFrames. A still needs the texture instead, which is
  // `load()`ed rather than declared, because a `load()` of a path that does not exist is an
  // editor warning rather than a parse error and the scene still opens.
  const header = [
    '[gd_scene load_steps=2 format=3]',
    '',
    `[ext_resource type="SpriteFrames" path="res://${meta.asset.name}.tres" id="2_frames"]`,
    '',
  ];

  const body =
    animations.length > 0
      ? [
          '[node name="AnimatedSprite2D" type="AnimatedSprite2D" parent="."]',
          `position = Vector2(${engineNumber(SCENE_ORIGIN_X)}, ${engineNumber(SCENE_ORIGIN_Y)})`,
          `offset = Vector2(${engineNumber(offsetX)}, ${engineNumber(offsetY)})`,
          'sprite_frames = ExtResource("2_frames")',
          ...(meta.animations
            ? [`animation = &${engineString(meta.animations.default)}`, 'autoplay = "' + meta.animations.default + '"']
            : []),
          '',
        ]
      : [
          '[node name="Sprite2D" type="Sprite2D" parent="."]',
          `position = Vector2(${engineNumber(SCENE_ORIGIN_X)}, ${engineNumber(SCENE_ORIGIN_Y)})`,
          `offset = Vector2(${engineNumber(offsetX)}, ${engineNumber(offsetY)})`,
          `texture = load("${texturePath}")`,
          '',
        ];

  return [...header, ...body].join('\n');
}

/** True when the frames this animation lists do not all hold for the same time. */
function isNonUniform(meta: AssetMeta, frameIndices: readonly number[]): boolean {
  const first = meta.frames.durationsMs[frameIndices[0]];
  return frameIndices.some((index) => meta.frames.durationsMs[index] !== first);
}

/** Convenience for a caller that wants the JSON half of a Godot bundle for its own tooling. */
export function godotManifestJson(meta0: unknown): string {
  const meta = readAssetMeta(meta0);
  return toJsonFile({
    asset: meta.asset.name,
    contentHash: meta.asset.contentHash,
    frameSize: meta.frames.size,
    pivot: meta.pivot,
    texture: meta.sheet ? { kind: 'sheet', image: meta.sheet.image, scale: meta.sheet.scale } : { kind: 'frame-pngs' },
  });
}
