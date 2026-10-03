import type { AssetMeta } from '../schema.js';
import { validateAssetMeta, type AssetMetaDiagnostic } from '../validate.js';

/**
 * What every importer shares: read a `meta.json`, refuse it if it is wrong, emit bytes.
 *
 * ## Why the validation is in here and not left to the caller
 *
 * An importer that assumes a valid contract has no way to report a *wrong* one: it will
 * silently produce an engine file describing a sprite with four frames and three durations,
 * and the symptom shows up in the engine as a dropped frame. So every importer takes
 * `unknown`, runs {@link validateAssetMeta}, and throws {@link AssetImportError} carrying the
 * diagnostics. A caller that wants to keep going on advisory findings can read
 * `readAssetMeta` instead; a caller that wants an importer will get the error.
 *
 * ## Why the output is a list of files
 *
 * Every engine needs more than one artefact for a sprite with animation (a resource plus the
 * texture it references, a scene plus its script), and a single string return would push that
 * choice onto every caller. {@link AssetImportFile} is `{path, contents, role}` where `path`
 * is relative to the bundle root and uses forward slashes, so a caller can write them under a
 * chosen root without a path library. `role` is free-form and is for the caller's manifest.
 */

export interface AssetImportFile {
  /** Relative to the bundle root, forward slashes. Never absolute; see S5.1. */
  readonly path: string;
  /** UTF-8 text. Every format these importers emit is text, deliberately. */
  readonly contents: string;
  /** What the file is for, for a caller's own manifest. Free-form; not part of the contract. */
  readonly role: string;
}

export interface AssetImportResult {
  /** Suggested root folder, `<asset.name>/`. A caller may ignore it. */
  readonly root: string;
  readonly files: readonly AssetImportFile[];
  /**
   * Everything the mapping could not carry across, stated rather than hidden.
   *
   * S9 of the contract lists the lossy mappings up front; this is where an importer says which
   * of them it actually hit, so the caller can put it in a build log instead of discovering it
   * from a stutter. Order is stable and there are no duplicates.
   */
  readonly warnings: readonly string[];
  /** The contract as read, so a caller can log the identity without re-parsing. */
  readonly meta: AssetMeta;
}

/** Thrown when the contract cannot be served. `diagnostics` is what the reader found. */
export class AssetImportError extends Error {
  readonly diagnostics: readonly AssetMetaDiagnostic[];

  constructor(message: string, diagnostics: readonly AssetMetaDiagnostic[]) {
    super(message);
    this.name = 'AssetImportError';
    this.diagnostics = diagnostics;
  }
}

/**
 * Validate and narrow, or throw with the diagnostics attached.
 *
 * `unknown` rather than `AssetMeta` so a caller that parsed a file cannot hand back the value
 * it already trusted and get a clean bill of health for it — the same reason
 * `validateAssetMeta` takes `unknown`.
 */
export function readAssetMeta(input: unknown): AssetMeta {
  const report = validateAssetMeta(input);
  if (!report.ok) {
    const errors = report.diagnostics.filter((d) => d.severity === 'error');
    const first = errors[0];
    throw new AssetImportError(
      `This meta.json cannot be imported: ${errors.length} error(s), first at ` +
        `${first.path === '' ? 'the root' : `"${first.path}"`} - ${first.message}`,
      report.diagnostics,
    );
  }
  return input as AssetMeta;
}

/**
 * A de-duplicating, order-preserving warning collector.
 *
 * A warning repeated three times is noise in a build log and tells the reader nothing extra,
 * and three callers asking for the same file must not produce three identical strings.
 */
export class WarningBag {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  add(message: string): void {
    if (this.seen.has(message)) return;
    this.seen.add(message);
    this.order.push(message);
  }

  list(): string[] {
    return [...this.order];
  }
}

/**
 * A JSON value with keys in insertion order and a trailing newline.
 *
 * Two-space indentation and the trailing newline, for the reason `serializeAssetMeta` gives:
 * a generated file without one is a modified file in every diff and every editor that appends
 * it on save. Key order is whatever the importer built, and the builders below write each
 * object literal in a fixed order, so the bytes are stable.
 */
export function toJsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * A number formatted the way `Number.prototype.toString` formats it, with `-0` normalised.
 *
 * S11 forbids `toLocaleString` and `Intl` outright, and this repository has been bitten by the
 * units as much as by the locale. The `-0` case is real: `pivot.x - width / 2` on an even canvas
 * gives `0`, but `-0` appears whenever the pivot is left of centre on an odd one, and
 * `JSON.stringify(-0)` writes `0` while string concatenation would write `-0`.
 *
 * Named `engineNumber` rather than `num` because three importer modules share it and it would
 * otherwise be a one-token name in a package-wide barrel.
 */
export function engineNumber(value: number): string {
  return Object.is(value, -0) ? '0' : String(value);
}

/**
 * A quoted string literal for a generated engine file.
 *
 * `JSON.stringify` produces the escapes GDScript, C# and JavaScript all accept, so there is one
 * implementation rather than three near-identical ones that drift apart on the quote character.
 */
export function engineString(value: string): string {
  return JSON.stringify(value);
}
