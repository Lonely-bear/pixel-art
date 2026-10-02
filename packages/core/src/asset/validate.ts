import { z } from 'zod';
import { isBundleRelativePath, nominalFps } from './build.js';
import {
  assetMetaSchema,
  MAX_SUPPORTED_ASSET_META_VERSION,
  unwrapSchema,
  type AssetMeta,
} from './schema.js';

/**
 * Reading a `meta.json` and reporting what is wrong with it, in machine-readable form.
 *
 * ## Why this is not a boolean
 *
 * Five importers and a naming validator are going to branch on the answer, and they branch
 * on *which* thing was wrong: a missing field, a field from a future version, and a sheet
 * whose regions no longer match its layout are three different responses. So every finding
 * is a {@link AssetMetaDiagnostic} with a stable {@link AssetMetaDiagnosticCode}, the
 * dotted path of the field it is about, and a severity. The prose in `message` is for a
 * human; nothing should parse it, and the code table in `docs/ASSET-CONTRACT.md` S8 is the
 * API.
 *
 * ## Error versus advisory is the whole compatibility policy
 *
 * S3 of the contract says a reader must tolerate fields it does not know, because a spec
 * that grows must not break every consumer that shipped before it grew. That tolerance is
 * expressed here as severity rather than as leniency:
 *
 *   - `unknown-field` is an **advisory**. A future writer added a field; this reader is
 *     older, and being older is not being broken.
 *   - `schema-version-unsupported` is an **advisory** for the same reason, and the rest of
 *     the file is still validated field by field.
 *   - Everything else is an **error**, including a misspelled field — which arrives as *two*
 *     findings: `unknown-field` (advisory) for the key nobody knows, and `missing-field`
 *     (error) for the required key it should have been. That pairing is the sharpest
 *     consequence of keeping `.strict()` while calling unknown fields advisory, and
 *     `test/asset-contract.test.ts` pins it.
 *
 * ## The cross-field checks are the ones that matter
 *
 * zod checks types. It cannot check that `frames.durationsMs` has `frames.count` entries,
 * that a frame's cell size matches the canvas, that an animation's frame list is the
 * playback order its own range and direction imply, or that `loop` agrees with `repeat`.
 * Those are the checks that catch a hand-edited file or a stale generator, so they are
 * here, written once, rather than reimplemented by each of the five consumers.
 */

/** Every code {@link validateAssetMeta} can report. A closed set: branch on these, not on prose. */
export type AssetMetaDiagnosticCode =
  /** The root is not a JSON object. Nothing else can be said about the file. */
  | 'not-json-object'
  /** A required field is absent. */
  | 'missing-field'
  /** A field is present but the wrong JSON type. */
  | 'invalid-type'
  /** A field is the right type but outside its permitted range. */
  | 'out-of-range'
  /** A field is the right type but not a permitted value (bad enum, malformed string). */
  | 'invalid-value'
  /** `schemaVersion` is newer than this reader knows. Advisory: read the fields you know. */
  | 'schema-version-unsupported'
  /** A field this reader does not recognise. Advisory: a newer writer is legal. */
  | 'unknown-field'
  /** `asset.contentHash` is not `sha256:` plus 64 lowercase hex digits. */
  | 'content-hash-malformed'
  /** `frames.durationsMs.length` is not `frames.count`. */
  | 'frame-count-mismatch'
  /** `frames.totalMs` is not the sum of `frames.durationsMs`. */
  | 'frame-total-mismatch'
  /** `frames.fps` is not `nominalFps(durationsMs)`. */
  | 'fps-mismatch'
  /** A sheet cell is not `frames.size * sheet.scale`. */
  | 'sheet-region-size-mismatch'
  /** A sheet cell runs past the sheet, or the cells are not in the row-major order `columns` implies. */
  | 'sheet-region-mismatch'
  /** `sheet.regions.length` is not `frames.count`, or the indices are not `0..count-1`. */
  | 'sheet-region-count-mismatch'
  /** `sheet.size` is too small for the cells it is supposed to contain. */
  | 'sheet-size-mismatch'
  /** An animation names a frame the timeline does not have. */
  | 'animation-frame-out-of-bounds'
  /** An animation's `frames` is not the playback order its range and direction imply. */
  | 'animation-order-mismatch'
  /** `loop` disagrees with `repeat === 0`. */
  | 'animation-loop-mismatch'
  /** `durationMs` is not the sum of the durations of the frames it lists. */
  | 'animation-duration-mismatch'
  /** Two animations share a name, so game code cannot address them apart. */
  | 'duplicate-animation-name'
  /** `animations.default` names an animation that is not in `items`. */
  | 'unknown-default-animation'
  /** `pivot.source` is `default` but the pivot is not the canvas centre. */
  | 'pivot-not-at-default'
  /** The pivot is outside the canvas rectangle. */
  | 'pivot-out-of-bounds'
  /** `palette.roles` has a key that is not a decimal integer. */
  | 'palette-role-key-invalid'
  /** `palette.roles` names an index that is not in `palette.colors`. */
  | 'palette-index-out-of-range'
  /** A path field is absolute, so the bundle cannot be moved. */
  | 'path-absolute'
  /** A path field uses a backslash, or contains a `..` segment, so it does not travel in a bundle. */
  | 'path-escapes-bundle'
  /** Two `outputs` entries name the same file. */
  | 'path-duplicate'
  /** An `outputs` entry uses the reserved `sheet` role, which duplicates `sheet.image`. */
  | 'reserved-output-role';

/**
 * `error` blocks; `advisory` does not.
 *
 * Two severities rather than a boolean, because "this file is from a newer generator" and
 * "this file is wrong" must not produce the same answer — the first is normal operation
 * across a version boundary and the second is a bug in someone's exporter.
 */
export type AssetMetaSeverity = 'error' | 'advisory';

export interface AssetMetaDiagnostic {
  readonly code: AssetMetaDiagnosticCode;
  readonly severity: AssetMetaSeverity;
  /** Dotted JSON path, `''` for the root and `animations.items[2].name` style for the rest. */
  readonly path: string;
  /** Human-readable. Read by a person; never parsed. */
  readonly message: string;
}

export interface AssetMetaValidation {
  /** True when there is no `error`-severity finding. Advisories do not clear it. */
  readonly ok: boolean;
  /** The file's `schemaVersion`, or `null` when it could not be read at all. */
  readonly schemaVersion: number | null;
  /** Sorted by path then code, so two runs over one file produce the same list. */
  readonly diagnostics: readonly AssetMetaDiagnostic[];
}

/**
 * Check a parsed `meta.json`.
 *
 * `input` is `unknown` rather than `AssetMeta` on purpose: the whole job is to cope with a
 * file that is not one, and a signature of `AssetMeta` would let a caller pass a contract it
 * already trusted and get a clean bill of health for it.
 */
export function validateAssetMeta(input: unknown): AssetMetaValidation {
  const diagnostics: AssetMetaDiagnostic[] = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    diagnostics.push({
      code: 'not-json-object',
      severity: 'error',
      path: '',
      message: 'A meta.json must be a JSON object at the top level.',
    });
    return { ok: false, schemaVersion: null, diagnostics };
  }

  const parsed = assetMetaSchema.safeParse(input);
  const raw = input as Record<string, unknown>;
  const schemaVersion = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : null;

  if (!parsed.success) {
    // zod reports a missing key and a wrong-typed key as the *same* issue code, and it does
    // not say which on the issue. The set of genuinely-absent required paths is computed
    // here from the schema instead, so the distinction does not depend on a zod internal.
    const missing = new Set(missingRequiredPaths(assetMetaSchema, input));
    for (const issue of parsed.error.issues) {
      const path = issuePath(issue.path);
      if (issue.code === 'unrecognized_keys') {
        const keys = (issue as unknown as { keys?: string[] }).keys ?? [];
        for (const key of keys) {
          const full = path ? `${path}.${key}` : key;
          diagnostics.push({
            code: 'unknown-field',
            severity: 'advisory',
            path: full,
            message:
              `'${full}' is not part of schemaVersion ${MAX_SUPPORTED_ASSET_META_VERSION}. ` +
              'A newer generator may add fields; this reader ignores them. If the field was ' +
              'meant to be one this reader knows, it is misspelled — a missing-field error ' +
              'for the required one usually follows.',
          });
        }
        continue;
      }
      diagnostics.push({
        code: shapeCode(issue, missing.has(path)),
        severity: 'error',
        path,
        message: issue.message,
      });
    }
  }

  if (schemaVersion !== null && schemaVersion > MAX_SUPPORTED_ASSET_META_VERSION) {
    diagnostics.push({
      code: 'schema-version-unsupported',
      severity: 'advisory',
      path: 'schemaVersion',
      message:
        `This file declares schemaVersion ${schemaVersion}; this reader understands ` +
        `${MAX_SUPPORTED_ASSET_META_VERSION}. Read the fields it knows and ignore the rest ` +
        'rather than discarding the file.',
    });
  }

  // Cross-field checks run against a typed copy only when the shape is intact: a semantic
  // rule about `frames.durationsMs` is meaningless while `frames` is a string, and
  // reporting both would double every one of these findings.
  if (parsed.success) {
    crossFieldDiagnostics(parsed.data, diagnostics);
  }

  const sorted = [...diagnostics].sort(
    (a, b) =>
      // Plain comparison, never `localeCompare`: this list is part of a byte-identical
      // pipeline, and a sort whose order depends on the machine's locale turns a diff into
      // an argument about ICU.
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
  );
  return {
    ok: sorted.every((d) => d.severity !== 'error'),
    schemaVersion,
    diagnostics: sorted,
  };
}

/**
 * Every required path that is genuinely absent from a value.
 *
 * Walks the schema rather than reading zod's issues, because zod 4 emits `invalid_type`
 * for both "this key is missing" and "this value is a string where a number belongs" and
 * does not distinguish them on the issue. T-055 wants to say which, because the two have
 * different fixes, so the question is answered here from the shape itself.
 *
 * A path whose *parent* is missing or malformed contributes nothing: its own absence is
 * already reported, and listing every grandchild of a hole is noise.
 */
function missingRequiredPaths(schema: z.ZodType, value: unknown, prefix = '', out: string[] = []): string[] {
  const inner = unwrapSchema(schema);
  if (inner instanceof z.ZodObject) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return out;
    const source = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(inner.shape)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!(key in source)) {
        if (!(child as z.ZodType).isOptional()) out.push(path);
        continue;
      }
      missingRequiredPaths(child as z.ZodType, source[key], path, out);
    }
    return out;
  }
  if (inner instanceof z.ZodArray && Array.isArray(value)) {
    value.forEach((item, index) =>
      missingRequiredPaths(inner.element as z.ZodType, item, `${prefix}[${index}]`, out),
    );
  }
  return out;
}

/**
 * zod's own issue codes, mapped onto ours.
 *
 * `atMissingPath` separates the two defects that share a code: a required key that is not
 * there (`missing-field`) and a key that holds the wrong type (`invalid-type`). An `int`
 * violation is its own case — the value *is* a number, so calling it a type error would be
 * wrong, and it is reported as `invalid-value`, the same code a bad enum member gets.
 *
 * Everything else zod rejects is `invalid-value`, and range violations are `out-of-range`.
 */
function shapeCode(issue: z.core.$ZodIssue, atMissingPath: boolean): AssetMetaDiagnosticCode {
  if (issue.code === 'invalid_type') {
    if (atMissingPath) return 'missing-field';
    if ((issue as { expected?: unknown }).expected === 'int') return 'invalid-value';
    return 'invalid-type';
  }
  if (issue.code === 'too_small' || issue.code === 'too_big') return 'out-of-range';
  return 'invalid-value';
}

/** `['animations','items',0,'name']` becomes `animations.items[0].name`. */
function issuePath(segments: readonly PropertyKey[]): string {
  let path = '';
  for (const segment of segments) {
    if (typeof segment === 'number') path += `[${segment}]`;
    else path += path ? `.${String(segment)}` : String(segment);
  }
  return path;
}

function add(
  diagnostics: AssetMetaDiagnostic[],
  code: AssetMetaDiagnosticCode,
  path: string,
  message: string,
): void {
  diagnostics.push({ code, severity: 'error', path, message });
}

function crossFieldDiagnostics(meta: AssetMeta, diagnostics: AssetMetaDiagnostic[]): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(meta.asset.contentHash)) {
    add(
      diagnostics,
      'content-hash-malformed',
      'asset.contentHash',
      `Expected "sha256:" followed by 64 lowercase hex digits; got "${truncate(meta.asset.contentHash)}".`,
    );
  }

  const { frames } = meta;
  if (frames.durationsMs.length !== frames.count) {
    add(
      diagnostics,
      'frame-count-mismatch',
      'frames.durationsMs',
      `frames.count is ${frames.count} but durationsMs lists ${frames.durationsMs.length} entries.`,
    );
  }
  const totalMs = frames.durationsMs.reduce((sum, ms) => sum + ms, 0);
  if (frames.totalMs !== totalMs) {
    add(
      diagnostics,
      'frame-total-mismatch',
      'frames.totalMs',
      `frames.totalMs is ${frames.totalMs}; the durations sum to ${totalMs}.`,
    );
  }
  if (frames.fps !== nominalFps(frames.durationsMs)) {
    add(
      diagnostics,
      'fps-mismatch',
      'frames.fps',
      `frames.fps is ${frames.fps}; the durations give ${nominalFps(frames.durationsMs)}.`,
    );
  }

  if (meta.sheet) checkSheet(meta, diagnostics);
  if (meta.animations) checkAnimations(meta, diagnostics);
  checkPivot(meta, diagnostics);
  if (meta.palette) checkPalette(meta, diagnostics);
  checkPaths(meta, diagnostics);
}

function checkSheet(meta: AssetMeta, diagnostics: AssetMetaDiagnostic[]): void {
  const sheet = meta.sheet!;
  if (!isBundleRelativePath(sheet.image)) {
    pathDiagnostic(diagnostics, 'sheet.image', sheet.image, 'the sheet image');
  }
  const { frames } = meta;
  const cellW = frames.size.width * sheet.scale;
  const cellH = frames.size.height * sheet.scale;
  if (sheet.regions.length !== frames.count) {
    add(
      diagnostics,
      'sheet-region-count-mismatch',
      'sheet.regions',
      `The sheet has ${sheet.regions.length} cells; the timeline has ${frames.count} frames.`,
    );
  }
  sheet.regions.forEach((region, index) => {
    if (region.index !== index) {
      add(
        diagnostics,
        'sheet-region-count-mismatch',
        `sheet.regions[${index}].index`,
        `Region ${index} claims to hold frame ${region.index}; regions are in timeline order.`,
      );
    }
    if (region.width !== cellW || region.height !== cellH) {
      add(
        diagnostics,
        'sheet-region-size-mismatch',
        `sheet.regions[${index}]`,
        `Cell is ${region.width}x${region.height}; frames.size ${frames.size.width}x${frames.size.height} at ${sheet.scale}x is ${cellW}x${cellH}.`,
      );
      return;
    }
    if (region.x + region.width > sheet.size.width || region.y + region.height > sheet.size.height) {
      add(
        diagnostics,
        'sheet-region-mismatch',
        `sheet.regions[${index}]`,
        `Cell runs to (${region.x + region.width}, ${region.y + region.height}), past the ${sheet.size.width}x${sheet.size.height} sheet.`,
      );
    }
  });
  // Row-major order is the one positional property `columns`/`rows` fixes even when the
  // packer inserted a gap or a border, which are the two parameters this contract
  // deliberately does not record. It catches a hand-moved cell and a stale generator
  // without needing to know how much gap there was — and unlike `x === column * cellW` it
  // cannot cry wolf on a legitimately padded sheet.
  const order = sheet.regions
    .map((region, position) => ({ region, position }))
    .sort((a, b) => a.region.y - b.region.y || a.region.x - b.region.x || a.position - b.position);
  order.forEach((entry, rowMajor) => {
    if (entry.position !== rowMajor) {
      add(
        diagnostics,
        'sheet-region-mismatch',
        `sheet.regions[${entry.position}]`,
        `Cell ${entry.position} is at (${entry.region.x}, ${entry.region.y}), but ${sheet.columns} columns put row-major position ${rowMajor} elsewhere.`,
      );
    }
  });
  // Overlap. Row-major order alone cannot see two cells dropped onto the same slot, which
  // is what a stale generator or a bad re-pack actually does. Pairwise rather than clever,
  // because a frame count is tens and tens-squared is nothing.
  for (let i = 0; i < sheet.regions.length; i++) {
    for (let j = i + 1; j < sheet.regions.length; j++) {
      const a = sheet.regions[i];
      const b = sheet.regions[j];
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) {
        add(
          diagnostics,
          'sheet-region-mismatch',
          `sheet.regions[${j}]`,
          `Cell ${j} overlaps cell ${i} at (${a.x}, ${a.y}).`,
        );
      }
    }
  }
  // `>=`, not `==`: the packer may leave a border around the sheet, and this contract does
  // not record how much. A validator that rejects a legitimate sheet is worse than none.
  if (sheet.size.width < sheet.columns * cellW || sheet.size.height < sheet.rows * cellH) {
    add(
      diagnostics,
      'sheet-size-mismatch',
      'sheet.size',
      `Sheet is ${sheet.size.width}x${sheet.size.height}; ${sheet.columns}x${sheet.rows} cells of ${cellW}x${cellH} need at least ${sheet.columns * cellW}x${sheet.rows * cellH}.`,
    );
  }
}

function checkAnimations(meta: AssetMeta, diagnostics: AssetMetaDiagnostic[]): void {
  const animations = meta.animations!;
  const seen = new Map<string, number>();
  animations.items.forEach((animation, index) => {
    const base = `animations.items[${index}]`;
    if (seen.has(animation.name)) {
      add(
        diagnostics,
        'duplicate-animation-name',
        `${base}.name`,
        `Animation "${animation.name}" is also item ${seen.get(animation.name)}; game code cannot address them apart.`,
      );
    } else {
      seen.set(animation.name, index);
    }
    if (animation.loop !== (animation.repeat === 0)) {
      add(
        diagnostics,
        'animation-loop-mismatch',
        `${base}.loop`,
        `loop is ${animation.loop} but repeat is ${animation.repeat}; repeat 0 means loop forever and anything else means it does not.`,
      );
    }
    for (const frame of animation.frames) {
      if (frame >= meta.frames.count) {
        add(
          diagnostics,
          'animation-frame-out-of-bounds',
          `${base}.frames`,
          `Frame ${frame} does not exist; the timeline has ${meta.frames.count} frames.`,
        );
        return;
      }
    }
    if (animation.frames.length === 0) {
      add(
        diagnostics,
        'animation-order-mismatch',
        `${base}.frames`,
        'An animation that plays no frames cannot be animated.',
      );
      return;
    }
    const expected = expectedOrder(animation.from, animation.to, animation.direction);
    if (expected.length > 0 && animation.frames.join(',') !== expected.join(',')) {
      add(
        diagnostics,
        'animation-order-mismatch',
        `${base}.frames`,
        `frames is [${animation.frames.join(', ')}]; ${animation.from}..${animation.to} played ${animation.direction} is [${expected.join(', ')}].`,
      );
    }
    const durationMs = animation.frames.reduce((sum, frame) => sum + meta.frames.durationsMs[frame], 0);
    if (animation.durationMs !== durationMs) {
      add(
        diagnostics,
        'animation-duration-mismatch',
        `${base}.durationMs`,
        `durationMs is ${animation.durationMs}; the listed frames sum to ${durationMs}.`,
      );
    }
  });
  if (!seen.has(animations.default)) {
    add(
      diagnostics,
      'unknown-default-animation',
      'animations.default',
      `Default animation "${animations.default}" is not one of [${[...seen.keys()].join(', ')}].`,
    );
  }
}

/**
 * The playback order a range and direction imply - `expandTagFrames`, re-derived here so the
 * validator does not import the generator's own answer and then agree with it by
 * construction. A published rule duplicated on purpose, the way S4.3's preimage is.
 */
function expectedOrder(from: number, to: number, direction: 'forward' | 'reverse' | 'pingpong'): number[] {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  if (direction === 'reverse') {
    const order: number[] = [];
    for (let i = hi; i >= lo; i--) order.push(i);
    return order;
  }
  const order: number[] = [];
  for (let i = lo; i <= hi; i++) order.push(i);
  if (direction === 'pingpong') {
    for (let i = hi - 1; i > lo; i--) order.push(i);
  }
  return order;
}

function checkPivot(meta: AssetMeta, diagnostics: AssetMetaDiagnostic[]): void {
  const { pivot, frames } = meta;
  const centreX = frames.size.width / 2;
  const centreY = frames.size.height / 2;
  if (pivot.x < 0 || pivot.x > frames.size.width || pivot.y < 0 || pivot.y > frames.size.height) {
    add(
      diagnostics,
      'pivot-out-of-bounds',
      'pivot',
      `Pivot (${pivot.x}, ${pivot.y}) is outside the ${frames.size.width}x${frames.size.height} canvas; a pivot on an edge is fine, one past it is not.`,
    );
  }
  if (pivot.source === 'default' && (pivot.x !== centreX || pivot.y !== centreY)) {
    add(
      diagnostics,
      'pivot-not-at-default',
      'pivot',
      `source is "default", which means the canvas centre (${centreX}, ${centreY}); got (${pivot.x}, ${pivot.y}).`,
    );
  }
}

function checkPalette(meta: AssetMeta, diagnostics: AssetMetaDiagnostic[]): void {
  const roles = meta.palette!.roles;
  if (!roles) return;
  for (const key of Object.keys(roles)) {
    if (!/^(0|[1-9][0-9]*)$/.test(key)) {
      add(
        diagnostics,
        'palette-role-key-invalid',
        `palette.roles.${key}`,
        `Role key "${key}" is not a decimal palette index.`,
      );
      continue;
    }
    if (Number(key) >= meta.palette!.colors.length) {
      add(
        diagnostics,
        'palette-index-out-of-range',
        `palette.roles.${key}`,
        `Index ${key} is past the ${meta.palette!.colors.length}-colour palette.`,
      );
    }
  }
}

function checkPaths(meta: AssetMeta, diagnostics: AssetMetaDiagnostic[]): void {
  const seen = new Map<string, number>();
  (meta.outputs ?? []).forEach((output, index) => {
    if (output.role === ('sheet' as string)) {
      add(
        diagnostics,
        'reserved-output-role',
        `outputs[${index}].role`,
        'The sheet path is sheet.image. Listing it here too gives one path two chances to disagree.',
      );
    }
    pathDiagnostic(diagnostics, `outputs[${index}].path`, output.path, 'output');
    const previous = seen.get(output.path);
    if (previous !== undefined) {
      add(
        diagnostics,
        'path-duplicate',
        `outputs[${index}].path`,
        `'${output.path}' is already outputs[${previous}].path.`,
      );
    } else {
      seen.set(output.path, index);
    }
  });
}

/** Absolute and escaping paths get one rule, stated once and applied to every path field. */
function pathDiagnostic(
  diagnostics: AssetMetaDiagnostic[],
  path: string,
  value: string,
  what: string,
): void {
  if (/^[A-Za-z]:/.test(value) || value.startsWith('/')) {
    add(
      diagnostics,
      'path-absolute',
      path,
      `${what} path "${truncate(value)}" is absolute. This file has to survive being moved into a game project.`,
    );
    return;
  }
  if (!isBundleRelativePath(value)) {
    add(
      diagnostics,
      'path-escapes-bundle',
      path,
      `${what} path "${truncate(value)}" is not a portable bundle-relative path: bundle paths use forward slashes and carry no \`..\` segment.`,
    );
  }
}

/** Keeps a diagnostic short. Advisory text length is bounded elsewhere in this repository too. */
function truncate(value: string): string {
  return value.length <= 80 ? value : `${value.slice(0, 77)}...`;
}

/** The codes this validator can emit, in a stable order, for a spec-drift guard. */
export const ASSET_META_DIAGNOSTIC_CODES: readonly AssetMetaDiagnosticCode[] = [
  'not-json-object',
  'missing-field',
  'invalid-type',
  'out-of-range',
  'invalid-value',
  'schema-version-unsupported',
  'unknown-field',
  'content-hash-malformed',
  'frame-count-mismatch',
  'frame-total-mismatch',
  'fps-mismatch',
  'sheet-region-size-mismatch',
  'sheet-region-mismatch',
  'sheet-region-count-mismatch',
  'sheet-size-mismatch',
  'animation-frame-out-of-bounds',
  'animation-order-mismatch',
  'animation-loop-mismatch',
  'animation-duration-mismatch',
  'duplicate-animation-name',
  'unknown-default-animation',
  'pivot-not-at-default',
  'pivot-out-of-bounds',
  'palette-role-key-invalid',
  'palette-index-out-of-range',
  'path-absolute',
  'path-escapes-bundle',
  'path-duplicate',
  'reserved-output-role',
];