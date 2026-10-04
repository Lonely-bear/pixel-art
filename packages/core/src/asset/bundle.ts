/**
 * The one renderer for a bundle's `meta.json` and its engine files.
 *
 * ## Why this file exists
 *
 * Two surfaces write a contract, and each wrote its own copy of the same four steps:
 *
 *   - `packages/mcp/src/tools.ts` `renderAssetOutputs` - `finalize_document`'s `meta`/`engine`
 *     outputs, rendered into the plan's file list and refused hard when naming fails.
 *   - `packages/core/src/commands/share.ts` `renderAssetOutput` - the same two outputs inside a
 *     share bundle, with the refusal *carried* on the record instead of thrown.
 *
 * Four steps is four places to be wrong: build the contract, validate its names, serialise it,
 * run the importer. Two copies meant a fix to one (a `directory` fallback, a file that was
 * declared but not written) reached only half the surfaces, and neither copy could be tested
 * against the other. So the work is here and each surface keeps only what is genuinely its own:
 *
 *   - **where the bytes go.** `finalize_document` joins the engine files under the `meta.json`'s
 *     own directory on disk; a share bundle writes bundle-relative, forward-slashed paths
 *     (`ASSET-CONTRACT` S5.1). Different callers, different joins, and the join is the one step
 *     where the two were never the same.
 *   - **what a refusal means.** A share bundle carries it on `record.delivery` - a bundle that
 *     says the delivery gate stopped it beats no bundle - and `finalize_document` throws, because
 *     it is the delivery gate. Same detection, same diagnostics, opposite consequences.
 *   - **which engine wins.** A share template names one so the bundle is reproducible for
 *     everybody sharing that piece, and the call may override it; `finalize_document`'s engine is
 *     a required field of the output. That precedence is resolved by the caller before it gets
 *     here, and this function takes the resolved name.
 *
 * ## What this file will not do
 *
 * It returns a *refusal*, not a throw, for naming errors: deciding what a broken name means is a
 * surface's call and the two surfaces answer differently. And it writes nothing - `packages/core`
 * has no filesystem, which is why `finalize_document` is the surface that writes.
 */
import type { Sprite } from '../document.js';
import {
  importExcalidraw,
  importGodot,
  importPhaser,
  importUnity,
  type AssetImportResult,
} from './importers/index.js';
import { buildAssetMeta, serializeAssetMeta, type AssetSheetRef } from './build.js';
import type { AssetMeta, AssetMetaOutput } from './schema.js';
import { validateAssetNaming, type AssetNamingDiagnostic, type AssetNamingReport } from './importers/naming.js';

/** The four importers, so every surface reaches the same code for an engine output. */
const ENGINE_IMPORTERS: Record<string, (input: unknown) => AssetImportResult> = {
  godot: importGodot as never,
  unity: importUnity as never,
  phaser: importPhaser as never,
  excalidraw: importExcalidraw as never,
};

/** What the contract describes about the bundle it is written into. */
export interface AssetBundleRequest {
  /**
   * The sheet, and the name it is written under.
   *
   * The packing result travels rather than the layout, because `sheet.regions` is authoritative
   * in the contract precisely because padding and margin are not recorded in it: re-packing with
   * defaults here would describe a sheet the caller is not shipping.
   */
  readonly sheet?: AssetSheetRef;
  /** The declared file list. An engine importer told about no frames warns about its own output. */
  readonly outputs?: readonly AssetMetaOutput[];
  /** One facing label per frame, or `null` for one that turns. Never inferred. */
  readonly directions?: readonly (string | null)[];
  /**
   * Folder for the engine files, relative to the folder holding `meta.json`.
   *
   * **Not part of the contract**, which is why it lives here rather than on
   * {@link AssetMetaOptions}: it decides where the importer's files are written, not what the
   * contract says. Omit it for the importer's own suggestion, `<asset.name>/`.
   */
  readonly directory?: string;
}

/** One engine file, with the root it belongs under already resolved. */
export interface RenderedEngineFile {
  /** Relative to the resolved root, forward slashes. */
  readonly path: string;
  readonly contents: string;
  readonly role: string;
}

export interface RenderedEngineOutput {
  /** The engine whose files these are, after the caller's precedence was resolved. */
  readonly engine: string;
  /** The folder they go in, from `request.directory` or the importer's own suggestion. */
  readonly root: string;
  readonly files: readonly RenderedEngineFile[];
  readonly warnings: readonly string[];
}

export interface RenderedAssetBundle {
  /** The contract, whether or not its names validated. Needed for the error's own diagnostics. */
  readonly meta: AssetMeta;
  /**
   * The serialised contract - the exact bytes for `meta.json`.
   *
   * Serialised **once**, because the bytes written and the bytes reported have to be the same
   * bytes and a second call is a second chance for them to differ.
   */
  readonly text: string;
  /** Every naming finding, advisory included. `ok` is false iff {@link errors} is non-empty. */
  readonly naming: AssetNamingReport;
  /** The `severity: 'error'` findings only. **A refusal, not a throw** - see the module note. */
  readonly errors: readonly AssetNamingDiagnostic[];
  /**
   * The engine's files, or `null`.
   *
   * `null` when the contract's names refused the bundle, in which case nothing is handed to an
   * importer: an engine folder built from a contract that cannot be named is a broken build whose
   * symptom surfaces in the engine.
   */
  readonly engine: RenderedEngineOutput | null;
}

/**
 * Build the contract, check its names, serialise it, and run one engine's importer over it.
 *
 * @param engine The engine to render files for, or `null`/`undefined` for a bare `meta` output.
 *   Resolved by the caller, because only the caller knows whether the template, the output or the
 *   command wins.
 *
 * @throws when `engine` names an importer this build does not have. **An unknown engine is a
 *   caller error rather than a naming one**: there is nothing to refuse, because the contract was
 *   fine and the request was not.
 */
export function renderAssetBundle(
  sprite: Sprite,
  request: AssetBundleRequest,
  engine?: string | null,
): RenderedAssetBundle {
  const meta = buildAssetMeta(sprite, {
    ...(request.sheet ? { sheet: request.sheet } : {}),
    ...(request.outputs ? { outputs: request.outputs } : {}),
    ...(request.directions ? { directions: request.directions } : {}),
  });
  const naming = validateAssetNaming(meta);
  const errors = naming.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  const text = serializeAssetMeta(meta);

  if (errors.length > 0 || engine === undefined || engine === null) {
    return { meta, text, naming, errors, engine: null };
  }

  const importer = ENGINE_IMPORTERS[engine];
  if (!importer) throw new Error(`Unknown engine "${engine}".`);
  const result = importer(meta);
  const root = request.directory ?? result.root;
  return {
    meta,
    text,
    naming,
    errors,
    engine: {
      engine,
      root,
      files: result.files.map((file) => ({ path: file.path, contents: file.contents, role: file.role })),
      warnings: [...result.warnings],
    },
  };
}