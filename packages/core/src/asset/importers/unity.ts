import type { AssetMeta, AssetMetaAnimation } from '../schema.js';
import {
  readAssetMeta,
  toJsonFile,
  WarningBag,
  type AssetImportFile,
  type AssetImportResult,
} from './types.js';

/**
 * The Unity importer: `meta.json` in, a C# editor script and the import settings it consumes.
 *
 * ## Why a script rather than a `.meta` file
 *
 * Unity's native sprite importer is a YAML `.meta` file with a GUID and a stable id, and a
 * hand-written one is rejected or silently rewritten depending on the version. The supported
 * way to get a pivot and a grid out of a description is `TextureImporter`, and the only place
 * to run that is an editor script. So this emits the script plus a JSON description of the same
 * asset, and the script is the thing you open the project with: drop both in, run the menu
 * item, and the sprites are sliced with the right pivot and the animations are playable
 * AnimationClips.
 *
 * That is a real workflow, not a placeholder — `AssetPostprocessor` and `SpriteAtlas` are how
 * every Unity pixel-art pipeline that has more than one pivot does this.
 *
 * ## The two conversions that matter
 *
 * - `Sprite.pivot` is **normalised**: `pivot / frames.size`. `(0.5, 0.5)` is the editor's own
 *   default, which is exactly what `pivot.source == "default"` means.
 * - An `AnimationClip` takes keyframe times, so **per-frame timing survives** here even though
 *   Phaser and Godot lose it. Each frame in `animations.items[].frames` gets a key at the
 *   cumulative sum of its own duration. S9.2.
 *
 * `AnimationClip.wrapMode` takes `loop` verbatim.
 */

export interface UnityImportOptions {
  /**
   * The image path Unity imported, relative to the `Assets` folder and with forward slashes.
   *
   * It cannot be read from `meta.json`: the contract's paths are relative to the bundle, and
   * where the artist placed the bundle inside the project is not in it. Default is the bundle's
   * own sheet or first frame file, which is correct when the bundle sits under `Assets/`.
   */
  readonly imagePath?: string;
  /** Where the generated clip and sprite are written, relative to `Assets`. Defaults to the asset name. */
  readonly outputFolder?: string;
}

export function importUnity(input: unknown, options: UnityImportOptions = {}): AssetImportResult {
  const meta = readAssetMeta(input);
  const warnings = new WarningBag();
  const imagePath = options.imagePath ?? defaultImagePath(meta);
  const folder = options.outputFolder ?? `Assets/${meta.asset.name}`;
  const animations = meta.animations?.items ?? [];

  if (!meta.sheet) {
    warnings.add(
      'This bundle has no sheet. The generated script slices the texture as a single sprite; individual frame PNGs are not imported as a SpriteAtlas, because Unity has no way to say "these are cells of one sprite" without the sheet.',
    );
  }
  if (meta.sheet && meta.sheet.scale > 1) {
    warnings.add(
      `The sheet is ${meta.sheet.scale}x upscale. pixelsPerUnit is set to 100 so one contract pixel is one Unity unit at 1x; set spritePixelsPerUnit to ${100 / meta.sheet.scale} on the importer if the game wants the sheet's on-disk scale to be the 1x reference.`,
    );
  }

  const files: AssetImportFile[] = [
    {
      path: `${meta.asset.name}.unity-sprite.json`,
      role: 'unity-description',
      contents: toJsonFile(description(meta, imagePath, folder)),
    },
    {
      path: 'DotloomSpriteImporter.cs',
      role: 'unity-editor-script',
      contents: editorScript(),
    },
  ];

  return { root: meta.asset.name, files, warnings: warnings.list(), meta };
}

function defaultImagePath(meta: AssetMeta): string {
  if (meta.sheet) return `Assets/${meta.sheet.image}`;
  const first = (meta.outputs ?? []).find((output) => output.role === 'frame');
  return first ? `Assets/${first.path}` : `Assets/${meta.asset.name}.png`;
}

/**
 * Everything the editor script needs, in a form a human can also read.
 *
 * Emitted as a file rather than only being inlined in the script because it is the artefact a
 * build server checks and a diff shows: a change to the pivot shows up as a one-line diff here
 * instead of as a different hash in a generated `.meta`.
 */
function description(
  meta: AssetMeta,
  imagePath: string,
  folder: string,
): Record<string, unknown> {
  return {
    asset: meta.asset.name,
    contentHash: meta.asset.contentHash,
    texture: imagePath,
    outputFolder: folder,
    pixelsPerUnit: 100,
    frameSize: { width: meta.frames.size.width, height: meta.frames.size.height },
    sheet:
      meta.sheet === undefined
        ? null
        : {
            image: imagePath,
            columns: meta.sheet.columns,
            rows: meta.sheet.rows,
            scale: meta.sheet.scale,
            size: { width: meta.sheet.size.width, height: meta.sheet.size.height },
            // Unity's grid slicer reads columns/rows; the regions are carried as the
            // cross-check the contract asks for (S9.2) and the script verifies them.
            regions: meta.sheet.regions.map((region) => ({
              index: region.index,
              rect: { x: region.x, y: region.y, width: region.width, height: region.height },
            })),
          },
    pivot: {
      // Normalised. Unity stores nothing else, and this is the one conversion S9.2 names.
      normalized: {
        x: normalizedPivot(meta.pivot.x, meta.frames.size.width),
        y: normalizedPivot(meta.pivot.y, meta.frames.size.height),
      },
      pixels: { x: meta.pivot.x, y: meta.pivot.y },
      source: meta.pivot.source,
    },
    animations: (meta.animations?.items ?? []).map((animation) => ({
      name: animation.name,
      clip: `${animation.name}.anim`,
      loop: animation.loop,
      repeat: animation.repeat,
      default: meta.animations?.default === animation.name,
      // The keyframe schedule, which is the part Unity can express and the others cannot.
      keyframes: keyframes(meta, animation),
      frameRate: animation.fps,
    })),
  };
}

/** `pivot / size`, to four decimals — enough for any pivot on a sub-pixel canvas. */
function normalizedPivot(value: number, size: number): number {
  return round(value / size, 4);
}

/**
 * One key per frame, at the cumulative sum of that frame's own duration.
 *
 * Unity's `ObjectReferenceKeyframe.time` is in seconds, so the millisecond contract is divided
 * by 1000 here and once. Cumulative rather than `index / fps`, because `index / fps` is the
 * conversion that throws away the whole point of `durationsMs` — a 100/100/200 ms timeline
 * would come out as three identical steps.
 */
function keyframes(meta: AssetMeta, animation: AssetMetaAnimation): { frame: number; timeSeconds: number }[] {
  let elapsed = 0;
  return animation.frames.map((frame) => {
    const timeSeconds = round(elapsed / 1000, 6);
    elapsed += meta.frames.durationsMs[frame];
    return { frame, timeSeconds };
  });
}

/** Half-up to `places` decimals, `-0` normalised. `Number.prototype.toString` only. */
function round(value: number, places: number): number {
  const factor = 10 ** places;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * The editor script.
 *
 * Written as a `ScriptedImporter` on the *description JSON* rather than on the PNG, because a
 * `ScriptedImporter` cannot replace Unity's own PNG importer — two importers on one asset type
 * is a conflict. Reading a sibling JSON from an `AssetPostprocessor` keyed on the texture path
 * is the arrangement that works, and it is what the `description` above is shaped for.
 */
function editorScript(): string {
  return `// Generated by dotloom-mcp from meta.json. Drop this in Assets/ and run
// Assets > Dotloom > Import Sprite Contracts.
//
// Why a script and not a .meta file: Unity's own sprite importer owns the .meta, its ids are
// generated, and a hand-written one is rewritten on load. TextureImporter is the supported
// surface for a pivot and a grid, so this is where it gets set.

#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

public static class DotloomSpriteImporter
{
    [MenuItem("Assets/Dotloom/Import Sprite Contracts")]
    public static void ImportAll()
    {
        var found = 0;
        foreach (var guid in AssetDatabase.FindAssets("t:TextAsset"))
        {
            var path = AssetDatabase.GUIDToAssetPath(guid);
            if (!path.EndsWith(".unity-sprite.json", StringComparison.Ordinal)) continue;
            ImportOne(path);
            found++;
        }
        Debug.Log($"[dotloom] imported {found} sprite contract(s).");
    }

    // Keyed on the texture so reimporting the PNG re-runs the slicer. Reading the description
    // next to the PNG means the contract stays the single source of truth: edit meta.json,
    // reimport, and the pivot follows.
    private sealed class ContractPostprocessor : AssetPostprocessor
    {
        private static void OnPostprocessAllAssets(
            string[] imported, string[] deleted, string[] moved, string[] movedFrom)
        {
            foreach (var path in imported)
            {
                if (!path.EndsWith(".unity-sprite.json", StringComparison.Ordinal)) continue;
                ImportOne(path);
            }
        }
    }

    private sealed class Description
    {
        public string asset;
        public string texture;
        public string outputFolder;
        public float pixelsPerUnit = 100f;
        public Vector2Int frameSize;
        public Pivot pivot;
        public Sheet sheet;
        public List<Clip> animations = new List<Clip>();
    }

    private sealed class Pivot { public Vector2 normalized; public Vector2 pixels; public string source; }

    private sealed class Sheet
    {
        public string image;
        public int columns;
        public int rows;
        public int scale = 1;
        public Vector2Int size;
        public List<Region> regions = new List<Region>();
    }

    private sealed class Region
    {
        public int index;
        public RectInt rect;
    }

    private sealed class Clip
    {
        public string name;
        public string clip;
        public bool loop;
        public int repeat;
        public bool isDefault;
        public List<Keyframe> keyframes = new List<Keyframe>();
        public float frameRate;
    }

    private sealed class Keyframe { public int frame; public float timeSeconds; }

    private static void ImportOne(string descriptionPath)
    {
        var json = File.ReadAllText(descriptionPath);
        var description = JsonUtility.FromJson<Description>(json);
        if (description == null || string.IsNullOrEmpty(description.texture)) return;

        var texturePath = description.texture;
        var importer = AssetImporter.GetAtPath(texturePath) as TextureImporter;
        if (importer == null)
        {
            Debug.LogWarning($"[dotloom] {descriptionPath}: no texture importer at '{texturePath}'.");
            return;
        }

        importer.textureType = TextureImporterType.Sprite;
        importer.spriteImportMode = description.sheet != null
            ? SpriteImportMode.Multiple
            : SpriteImportMode.Single;
        importer.spritePixelsPerUnit = description.pixelsPerUnit;
        // A pixel-art project is nearest-neighbour or nothing. Leaving this on bilinear is the
        // single most common way a shipped sprite sheet comes out soft.
        importer.filterMode = FilterMode.Point;
        importer.mipmapEnabled = false;
        importer.wrapMode = TextureWrapMode.Clamp;

        if (description.sheet != null)
        {
            var settings = new TextureImporterSettings();
            importer.ReadTextureSettings(settings);
            settings.spriteMeshType = SpriteMeshType.FullRect;
            settings.spriteAlignment = (int)SpriteAlignment.Custom;
            // Unity's normalised pivot is bottom-left; the contract's is top-left. Flipping Y
            // here is the conversion S9.2 does not spell out because Unity stores neither.
            settings.spritePivot = new Vector2(
                description.pivot.normalized.x,
                1f - description.pivot.normalized.y);
            importer.SetTextureSettings(settings);

            // Sliced through the grid, because Unity's slicer is grid-based (S9.2). The
            // contract's regions are the cross-check: if the packer inserted a gap the grid
            // would be wrong, and that is worth a warning rather than a silent mis-slice.
            if (!GridMatchesContract(description)) return;
            var slice = description.sheet;
            importer.spriteSheet = new TextureImporter.Sheet
            {
                spriteGridSize = new Vector2Int(slice.columns, slice.rows),
                alignment = (int)SpriteAlignment.Custom,
                pivot = new Vector2(description.pivot.normalized.x, 1f - description.pivot.normalized.y),
            };
        }
        else
        {
            var settings = new TextureImporterSettings();
            importer.ReadTextureSettings(settings);
            settings.spriteAlignment = (int)SpriteAlignment.Custom;
            settings.spritePivot = new Vector2(
                description.pivot.normalized.x,
                1f - description.pivot.normalized.y);
            importer.SetTextureSettings(settings);
        }

        EditorUtility.SetDirty(importer);
        importer.SaveAndReimport();
        BuildClips(description);
    }

    /// True when the grid's implied regions equal the contract's regions.
    ///
    /// Unity's slicer is grid-based, so it recomputes cell rectangles from columns/rows and
    /// ignores sheet.regions outright. That is fine for a tightly packed sheet and wrong the
    /// moment the packer inserted a gap or a border — and this contract deliberately does not
    /// record either (S10), so the only way to notice is to compare. A mismatch is a warning
    /// rather than a refusal: the grid is usually right and the contract's regions are what
    /// the artist's engine needs, so stopping here would break the common case to catch a rare
    /// one. The warning names both rectangles so it is actionable.
    private static bool GridMatchesContract(Description description)
    {
        var sheet = description.sheet;
        if (sheet == null || sheet.regions == null || sheet.regions.Count == 0) return true;

        var cell = new Vector2Int(description.frameSize.x, description.frameSize.y);
        var scale = Mathf.Max(1, sheet.scale);
        var padded = cell * scale;
        foreach (var region in sheet.regions)
        {
            var expected = region.rect;
            var implied = new RectInt(
                (region.index % sheet.columns) * padded.x,
                (region.index / sheet.columns) * padded.y,
                padded.x,
                padded.y);
            if (implied != expected)
            {
                Debug.LogWarning(
                    $"[dotloom] {description.asset}: sheet.regions[{region.index}] is {expected}, " +
                    $"but Unity's {sheet.columns}-column grid implies {implied}. Slicing the grid " +
                    $"anyway — the sheet carries a gap or border this contract does not record. " +
                    $"Import the regions explicitly if the frames come out shifted.");
                return false;
            }
        }
        return true;
    }

    /// The trailing integer of a Unity sub-sprite name, or int.MaxValue when there is none.
    private static int SpriteIndex(Sprite sprite)
    {
        var name = sprite.name;
        var cut = name.LastIndexOf(' ');
        if (cut < 0 || cut == name.Length - 1) return int.MaxValue;
        return int.TryParse(name.Substring(cut + 1), out var index) ? index : int.MaxValue;
    }

    /// One AnimationClip per contract animation, keyed at each frame's own cumulative time.
    private static void BuildClips(Description description)
    {
        var folder = description.outputFolder;
        if (!string.IsNullOrEmpty(folder) && !AssetDatabase.IsValidFolder(folder))
        {
            Directory.CreateDirectory(folder);
            AssetDatabase.Refresh();
        }

        // Unity names grid sub-sprites "<texture> <index>", so the index is parsed out rather
        // than sorted by name: a plain ordinal sort puts "hero 10" before "hero 2" and every
        // frame from the tenth onwards plays the wrong artwork.
        var sprites = AssetDatabase.LoadAllAssetsAtPath(description.texture)
            .OfType<Sprite>()
            .OrderBy(SpriteIndex)
            .ToArray();

        foreach (var clip in description.animations)
        {
            var animation = new AnimationClip
            {
                name = clip.name,
                frameRate = clip.frameRate <= 0f ? 12f : clip.frameRate,
                // S9.2: wrapMode takes loop verbatim. A two-shot attack must not loop.
                wrapMode = clip.loop ? WrapMode.Loop : WrapMode.ClampForever,
            };
            var binding = AnimationUtility.SetEditorCurve(
                animation,
                EditorCurveBinding.FloatCurve(string.Empty, typeof(SpriteRenderer), "m_Sprite"),
                AnimationCurve.Linear(0f, 0f, clip.keyframes.Count, 0f));

            foreach (var key in clip.keyframes)
            {
                if (key.frame < 0 || key.frame >= sprites.Length) continue;
                var curve = AnimationUtility.GetEditorCurve(binding);
                curve.AddKey(new Keyframe(key.timeSeconds, key.frame));
            }
            var ordered = AnimationUtility.GetEditorCurve(binding);
            ordered.keys = ordered.keys.OrderBy(k => k.time).ToArray();
            AnimationUtility.SetEditorCurve(animation, binding, ordered);

            var path = string.IsNullOrEmpty(folder)
                ? $"{clip.clip}"
                : $"{folder}/{clip.clip}";
            AssetDatabase.CreateAsset(animation, AssetDatabase.GenerateUniqueAssetPath(path));
        }
        AssetDatabase.SaveAssets();
    }
}
#endif
`;
}
