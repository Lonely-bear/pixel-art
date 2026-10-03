import type { AssetMeta } from '../schema.js';
import { readAssetMeta } from './types.js';

/**
 * The naming-convention validator (T-055).
 *
 * ## What a naming convention is for
 *
 * Every serious pipeline ends up with `hero_idle_v2.png` next to `hero-idle.png`, a folder named
 * after somebody's initials, and an animation called `Idle` in one asset and `idle` in the next.
 * None of those is wrong on its own; all of them are wrong the first time code has to find the
 * asset by name, an importer cache has to key on it, or two machines disagree about the
 * filename case. That is why this is a validator and not a renamer: the convention is the
 * project's decision, and this checks it.
 *
 * ## The rules, and why each one exists
 *
 * All of them are configurable through {@link NamingConvention}; the defaults are the ones in
 * the table below. Every rule has a test that shows it firing, which is the only way a naming
 * rule is distinguishable from a naming rule that does nothing.
 *
 * | Rule | Default | Why |
 * | --- | --- | --- |
 * | `asset.name` is kebab-case | yes | The bundle folder, the sheet file and the sprite's name in three of four engines are the same string. Kebab-case is the only ASCII convention that is legal in a filename, a Godot node path, an Excalidraw layer and a URL without quoting. |
 * | No leading/trailing/doubled separator | yes | `hero--idle` and `-hero` are two names on every filesystem that is not case-sensitive and produce different cache keys on the ones that are. |
 * | Length ceiling | 64 | The contract allows 255. A 64-character *name* is the point where the name plus `-contact-sheet.png` plus an engine's own suffix stops fitting everywhere; 255 is a path limit, not a taste. |
 * | Animation names are lower snake_case | yes | Game code addresses animations as identifiers. `snake_case` is what every language in the four target ecosystems accepts as a bare identifier, and it is what the C# importer writes as a file name. |
 * | Animation names are unique per asset | yes | Already `duplicate-animation-name` in the contract's own validator; repeated here because a naming check that misses it is worse than no naming check. |
 * | Every `outputs[].path` basename starts with the asset name | yes | This is the rule that actually finds the `hero_idle_v2.png` problem: a file in the bundle that is not named after the asset is either a stray or a deliberate second asset, and neither is knowable without asking. |
 * | Bundle-relative, forward slashes, no `..` | **already an error upstream** | S5.1. `validateAssetMeta` reports these as `path-absolute` / `path-escapes-bundle` and `readAssetMeta` throws before any rule here runs, so re-checking them here would be a rule that can never fire. |
 * | No reserved device name | yes | `CON`, `LPT1`, `NUL`, `AUX` and friends are files a Windows build machine cannot create. A validator that does not catch it produces an asset that works on the artist's Mac and fails in CI. |
 * | No trailing space or dot | yes | Windows silently strips both, so the file in the repo and the file in the build are different files with the same name. |
 * | Case-insensitive uniqueness across the bundle | yes | Two paths differing only in case are two files on Linux and one on Windows. Either way the importer cache disagrees between machines. |
 *
 * ## Severity
 *
 * `error` for anything that breaks a build or makes two assets ambiguous — reserved device
 * names, case-insensitive collisions, a path that does not travel. `warning` for a style
 * deviation, because a project with its own convention should be able to override
 * {@link NamingConvention} rather than argue with the default. That distinction is the reason
 * this is not a second boolean on top of the contract validator.
 */

export type AssetNamingSeverity = 'error' | 'warning';

export interface AssetNamingDiagnostic {
  readonly code: AssetNamingCode;
  readonly severity: AssetNamingSeverity;
  /** Dotted path into the contract, or `''` when the rule is about the file as a whole. */
  readonly path: string;
  /** What is wrong, in one sentence. For a person; branch on `code`. */
  readonly message: string;
  /** The string that was rejected, so a fixer does not have to re-find it. */
  readonly value: string;
}

/** A closed set. Branch on these; never on `message`. */
export type AssetNamingCode =
  /** `asset.name` does not match the configured pattern. */
  | 'asset-name-style'
  /** `asset.name` is longer than the configured ceiling. */
  | 'asset-name-length'
  /** An animation name does not match the configured pattern. */
  | 'animation-name-style'
  /** An animation name is longer than the configured ceiling. */
  | 'animation-name-length'
  /** Two animations in one asset share a name. */
  | 'duplicate-animation-name'
  /** An output file's basename does not start with the asset name. */
  | 'output-name-mismatch'
  /** Two bundle paths collide when case is folded away. */
  | 'case-collision'
  /** A path segment's stem is a reserved Windows device name. */
  | 'reserved-name'
  /** A path segment ends in a space or a dot, which Windows strips. */
  | 'trailing-space-or-dot';

export interface NamingConvention {
  /** Pattern `asset.name` must match. Default: lower kebab-case, at least two characters. */
  readonly assetNamePattern: RegExp;
  /** Ceiling for `asset.name`, in characters. Default 64. */
  readonly maxAssetNameLength: number;
  /** Pattern each animation name must match. Default: lower snake_case. */
  readonly animationNamePattern: RegExp;
  /** Ceiling for an animation name, in characters. Default 32. */
  readonly maxAnimationNameLength: number;
  /**
   * Require every `outputs[].path` basename to begin with `asset.name`.
   *
   * On by default. A frame file is allowed to continue with anything after the name, so
   * `hero-idle.png`, `hero-idle-3.png` and `hero-idle@2x.png` all pass.
   */
  readonly requireOutputNamesToMatchAsset: boolean;
  /** Require the sheet's basename to begin with `asset.name`. On by default. */
  readonly requireSheetNameToMatchAsset: boolean;
}

export interface AssetNamingReport {
  /** True when no diagnostic is `error`-severity. Warnings do not clear it. */
  readonly ok: boolean;
  readonly diagnostics: readonly AssetNamingDiagnostic[];
}

/**
 * The default convention: lower kebab-case asset names, lower snake_case animation names.
 *
 * Chosen because those are the two forms that survive all four target ecosystems unmodified:
 * kebab-case for the asset because it is legal in a filename, a Godot node path and a URL;
 * snake_case for the animation because it is legal as a bare identifier in GDScript, C#, JS and
 * Python, and this repository emits an animation name as a `.anim` filename in the Unity
 * importer. Matching the *emitted* form rather than the artist's preferred form is what keeps
 * the validator from firing on assets the importers themselves produced.
 */
export const DEFAULT_NAMING_CONVENTION: NamingConvention = {
  assetNamePattern: /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/,
  maxAssetNameLength: 64,
  animationNamePattern: /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/,
  maxAnimationNameLength: 32,
  requireOutputNamesToMatchAsset: true,
  requireSheetNameToMatchAsset: true,
};

/**
 * Every code {@link validateAssetNaming} can report, in a stable order.
 *
 * Exported for the same reason `ASSET_META_DIAGNOSTIC_CODES` is on the contract side: a consumer
 * switches on `code` and must be able to see the closed set without reading the prose, and a
 * test compares this list against the set of codes the rules actually produce so a rule added
 * without a code cannot slip through.
 */
export const ASSET_NAMING_CODES: readonly AssetNamingCode[] = [
  'animation-name-length',
  'animation-name-style',
  'asset-name-length',
  'asset-name-style',
  'case-collision',
  'duplicate-animation-name',
  'output-name-mismatch',
  'reserved-name',
  'trailing-space-or-dot',
];

/**
 * Windows device names. Reserved in every directory on every volume, with or without an
 * extension, which is the part that catches people: `aux.png` fails and `aux/hero.png` fails.
 *
 * `COM1`..`COM9` and `LPT1`..`LPT9` are there; `COM0` and `LPT0` are not reserved and adding
 * them would reject a filename Windows accepts.
 */
const WINDOWS_DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * Validate one contract's names.
 *
 * Takes `unknown` and runs the contract validator first, for the same reason the importers do:
 * this function must not report a clean bill of health for a file whose `asset.name` it could
 * not read. A contract that fails validation throws {@link AssetImportError}; a contract that
 * validates but breaks the convention returns findings.
 */
export function validateAssetNaming(input: unknown, convention: NamingConvention = DEFAULT_NAMING_CONVENTION): AssetNamingReport {
  const meta = readAssetMeta(input);
  const diagnostics: AssetNamingDiagnostic[] = [];

  checkAssetName(meta, convention, diagnostics);
  checkAnimationNames(meta, convention, diagnostics);
  checkSheetName(meta, convention, diagnostics);
  checkOutputNames(meta, convention, diagnostics);
  checkPaths(meta, diagnostics);

  const sorted = [...diagnostics].sort(
    (a, b) =>
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
  );
  return { ok: sorted.every((d) => d.severity !== 'error'), diagnostics: sorted };
}

function push(
  diagnostics: AssetNamingDiagnostic[],
  code: AssetNamingCode,
  severity: AssetNamingSeverity,
  path: string,
  value: string,
  message: string,
): void {
  diagnostics.push({ code, severity, path, message, value });
}

function checkAssetName(
  meta: AssetMeta,
  convention: NamingConvention,
  diagnostics: AssetNamingDiagnostic[],
): void {
  const name = meta.asset.name;
  if (name.length > convention.maxAssetNameLength) {
    push(
      diagnostics,
      'asset-name-length',
      'warning',
      'asset.name',
      name,
      `Asset name is ${name.length} characters; the convention's ceiling is ${convention.maxAssetNameLength}. The contract allows 255, so this is a convention rather than a violation.`,
    );
  }
  if (!convention.assetNamePattern.test(name)) {
    push(
      diagnostics,
      'asset-name-style',
      'warning',
      'asset.name',
      name,
      `"${name}" is not lower kebab-case. The convention is ${convention.assetNamePattern.source}; every importer writes this name as a filename, a Godot node path and a sheet key, and kebab-case is the form all four accept unmodified.`,
    );
  }
}

function checkAnimationNames(
  meta: AssetMeta,
  conventions: NamingConvention,
  diagnostics: AssetNamingDiagnostic[],
): void {
  const animations = meta.animations?.items;
  if (!animations) return;
  const seen = new Map<string, number>();
  animations.forEach((animation, index) => {
    const base = `animations.items[${index}].name`;
    if (animation.name.length > conventions.maxAnimationNameLength) {
      push(
        diagnostics,
        'animation-name-length',
        'warning',
        base,
        animation.name,
        `Animation name is ${animation.name.length} characters; the convention's ceiling is ${conventions.maxAnimationNameLength}.`,
      );
    }
    if (!conventions.animationNamePattern.test(animation.name)) {
      push(
        diagnostics,
        'animation-name-style',
        'warning',
        base,
        animation.name,
        `"${animation.name}" is not lower snake_case. Game code addresses animations as bare identifiers and the Unity importer writes the name as a .anim filename; the convention is ${conventions.animationNamePattern.source}.`,
      );
    }
    // The contract validator already reports this as an error, and a naming check that missed
    // it would be worse than none — so it is reported here too, at error severity.
    const previous = seen.get(animation.name);
    if (previous !== undefined) {
      push(
        diagnostics,
        'duplicate-animation-name',
        'error',
        base,
        animation.name,
        `Animation "${animation.name}" is also animations.items[${previous}].name; game code cannot address them apart.`,
      );
    } else {
      seen.set(animation.name, index);
    }
  });
}

function checkSheetName(
  meta: AssetMeta,
  convention: NamingConvention,
  diagnostics: AssetNamingDiagnostic[],
): void {
  if (!meta.sheet || !convention.requireSheetNameToMatchAsset) return;
  const base = basename(meta.sheet.image);
  if (!startsWithAssetName(base, meta.asset.name)) {
    push(
      diagnostics,
      'output-name-mismatch',
      'warning',
      'sheet.image',
      meta.sheet.image,
      `The sheet is "${base}", which does not begin with the asset name "${meta.asset.name}". Every importer registers the sheet under the asset name, so a mismatch is how two assets end up sharing a texture key.`,
    );
  }
}

function checkOutputNames(
  meta: AssetMeta,
  convention: NamingConvention,
  diagnostics: AssetNamingDiagnostic[],
): void {
  const outputs = meta.outputs ?? [];
  if (!convention.requireOutputNamesToMatchAsset) return;
  outputs.forEach((output, index) => {
    const base = basename(output.path);
    if (startsWithAssetName(base, meta.asset.name)) return;
    push(
      diagnostics,
      'output-name-mismatch',
      'warning',
      `outputs[${index}].path`,
      output.path,
      `"${base}" does not begin with the asset name "${meta.asset.name}". A bundle is one asset, so a file that is not named after it is either a stray or a second asset this contract does not describe.`,
    );
  });
}

/**
 * The rules that are not configurable, because there is no convention under which they are fine.
 *
 * **Portability itself is not re-checked here.** Absolute paths, backslashes and `..` segments
 * are already `path-absolute` / `path-escapes-bundle` **errors** in `validateAssetMeta`, and
 * `readAssetMeta` throws on them before any rule in this file runs. Duplicating the checks would
 * be a rule that can never fire, which is the exact failure mode this repository has paid for
 * five times: a measurement written down, believed to be covered, and unreachable. So the rules
 * here are the three the contract does *not* know about.
 *
 * All three are `error`, not `warning`: each one produces a file that either cannot be written on
 * a build machine or does not exist identically on two of them.
 */
function checkPaths(meta: AssetMeta, diagnostics: AssetNamingDiagnostic[]): void {
  const paths: { path: string; value: string }[] = [];
  if (meta.sheet) paths.push({ path: 'sheet.image', value: meta.sheet.image });
  (meta.outputs ?? []).forEach((output, index) =>
    paths.push({ path: `outputs[${index}].path`, value: output.path }),
  );

  const folded = new Map<string, string>();
  for (const entry of paths) {
    const { value } = entry;
    for (const segment of value.split('/')) {
      // Windows reserves the *stem*: `nul`, `nul.png` and `nul.tar.gz` all fail. Comparing the
      // whole segment against the device list is the version that lets every real filename
      // through, because a sprite is never called `nul` exactly.
      const stem = segment.includes('.') ? segment.slice(0, segment.indexOf('.')) : segment;
      if (WINDOWS_DEVICE_NAMES.has(stem.toLowerCase())) {
        push(
          diagnostics,
          'reserved-name',
          'error',
          entry.path,
          value,
          `"${segment}" is a reserved Windows device name. A Windows build machine cannot create this file, so the asset works on the artist's machine and fails in CI.`,
        );
      }
      if (segment.length > 0 && /[ .]$/.test(segment)) {
        push(
          diagnostics,
          'trailing-space-or-dot',
          'error',
          entry.path,
          value,
          `"${segment}" ends in a space or a dot, which Windows strips. The file in the repository and the file in the build are then different files with the same name.`,
        );
      }
    }
    // Two paths differing only in case are two files on Linux and one on Windows, so an
    // importer cache disagrees between a developer's machine and a build server.
    const key = value.toLowerCase();
    const previous = folded.get(key);
    if (previous !== undefined && previous !== value) {
      push(
        diagnostics,
        'case-collision',
        'error',
        entry.path,
        value,
        `"${value}" and "${previous}" are the same path once case is folded away. Two files on Linux, one on Windows.`,
      );
    } else {
      folded.set(key, value);
    }
  }
}

/** The last `/`-separated segment. A path with no slash is its own basename. */
function basename(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

/**
 * Whether a filename belongs to the asset.
 *
 * Case-insensitive on purpose: `Hero.png` and `hero.png` are the same file on the machine most
 * people build on, so a prefix check that ignored case would let a mismatch through and then
 * fail on Windows.
 */
function startsWithAssetName(fileName: string, assetName: string): boolean {
  const file = fileName.toLowerCase();
  const asset = assetName.toLowerCase();
  if (!file.startsWith(asset)) return false;
  const rest = file.slice(asset.length);
  return rest === '' || rest.startsWith('-') || rest.startsWith('_') || rest.startsWith('.');
}
