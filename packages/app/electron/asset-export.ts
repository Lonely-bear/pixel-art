/**
 * `meta.json` and the four engine importers, as an Electron main-process capability.
 *
 * Everything here is the same policy `finalize_document` applies in the MCP
 * surface, in `packages/mcp/src/tools.ts` (`renderAssetOutputs`): build the
 * contract, run the naming validator on it, refuse the whole bundle on a naming
 * *error*, write `meta.json`, and — for an engine export — run that engine's
 * importer over the contract and write its files under `<asset.name>/` beside it.
 * Two surfaces disagreeing about the same policy is a bug, not a variation.
 *
 * ## No score, ever
 *
 * The result carries **named defects** (`code`, `path`, `message`), a content
 * hash and a file list. There is deliberately no quality number and no "this
 * asset is 87% good". A `quality_report` tool was deleted in 0.3.1 precisely
 * because a model handed the number sanded a lake into a dark flat rectangle:
 * any score an agent can see becomes the target instead of the artwork. If you
 * are about to add one here, read AGENTS.md § "Do not show an agent a number to
 * optimise" first, and then don't.
 *
 * ## Why this is a module and not inline in `ipc.ts`
 *
 * The decisions worth checking — what gets written, what refuses, and that the
 * bytes written are the bytes reported — are all reachable without a running
 * Electron, which is the same reason `update-support.ts` exists next to
 * `updater.ts`. `ipc.ts` owns the file dialog and nothing else.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildSpritesheet,
  encodePNG,
  renderAssetBundle,
  scaleAtlas,
  type Sprite,
} from '@pixel/core';

import {
  ASSET_ENGINES,
  isAssetEngine,
  type AssetEngine,
  type AssetEngineSummary as AssetEngineSummaryShape,
  type AssetExportRequest as SharedAssetExportRequest,
  type AssetExportResult as AssetExportResultShape,
  type AssetNamingFinding as AssetNamingFindingShape,
} from '../shared/types.js';

/** Re-exported so the main process has one import site for the whole capability. */
export { ASSET_ENGINES, isAssetEngine, type AssetEngine };

// **The importers themselves are not held here.** This table used to carry them, making it the
// fourth copy of the walk `renderAssetBundle` now owns; `packages/core/test/single-implementation.test.ts`
// fails if one reappears. `ASSET_ENGINES` is the name list the renderer menu and the IPC validator
// share, which is vocabulary rather than policy.

/**
 * One naming diagnostic, flattened for the renderer.
 *
 * Structurally identical to `AssetNamingDiagnostic` in `@pixel/core`, restated in the
 * shared module: it has to survive Electron's structured clone into a panel that has
 * no `@pixel/core` dependency, and `readonly` on a plain data interface buys nothing
 * there.
 */
export type AssetNamingFinding = AssetNamingFindingShape;
export type AssetEngineSummary = AssetEngineSummaryShape;
export type AssetExportResult = AssetExportResultShape;

/** What the caller sends. The shared shape plus the two main-process-only fields. */
export interface AssetExportRequest extends SharedAssetExportRequest {
  /** Absolute path for `meta.json`. Main-side dialog owns this; the renderer never sets it. */
  path: string;
  /**
   * Which engine's files to write. Omit for the contract alone.
   *
   * An engine export **always writes `meta.json` too**, because every importer reads
   * a contract and a caller holding only `.tres` files has got nothing they can
   * re-derive. That is the MCP surface's decision, matched here.
   */
  engine?: AssetEngine;
}

/** Forward-slashed, relative to the folder holding `meta.json`. */
function relativeTo(dir: string, target: string): string {
  return path.relative(dir, target).split('\\').join('/');
}

function toFindings(diagnostics: readonly AssetNamingFinding[]): AssetNamingFinding[] {
  return diagnostics.map((d) => ({ ...d }));
}

/** One sentence naming the first error, the way `AssetNamingRefusal` does in MCP. */
function refusalText(diagnostics: readonly AssetNamingFinding[], subject: string): string {
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const codes = [...new Set(errors.map((d) => d.code))].join(', ');
  const first = errors[0]!;
  return (
    `Asset naming refuses this bundle: ${errors.length} error(s) [${codes}]. ` +
    `First: ${first.path === '' ? subject : `"${first.path}"`} - ${first.message}`
  );
}

/**
 * Write `meta.json`, and one engine's files beside it.
 *
 * Refuses on a naming **error** and writes nothing at all — the same rule the
 * quality gate and `AssetNamingRefusal` follow. A warning is reported and
 * written: a camelCase asset name is a project convention, not a broken build,
 * and a validator that blocks a build over style is one a project switches off.
 *
 * The second refusal — two written paths colliding once case is folded away — is
 * not in the contract's own file list, so the naming validator cannot see it. Two
 * files on Linux and one on Windows is exactly the kind of failure that surfaces
 * in CI minutes from its cause, so it is checked on the real write list too.
 */
export async function exportAssetBundle(
  sprite: Sprite,
  request: AssetExportRequest,
): Promise<AssetExportResult> {
  if (!request.path) throw new Error('Asset export needs a path for meta.json.');
  if (request.engine !== undefined && !isAssetEngine(request.engine)) {
    throw new Error(`Unknown engine "${String(request.engine)}".`);
  }

  const metaDir = path.dirname(request.path);
  const scale = Math.max(1, Math.floor(request.sheet?.scale ?? 1));
  // Packed once, described once. The regions in the contract and the pixels on
  // disk come from the same atlas object or the contract is a description of
  // something nobody shipped.
  const packed = request.sheet
    ? scaleAtlas(
        buildSpritesheet(sprite, {
          columns: request.sheet.columns,
          padding: request.sheet.padding,
          margin: request.sheet.margin,
        }),
        scale,
      )
    : undefined;

  // **One renderer, shared with `finalize_document`, the CLI and the share command.** This used to
  // build the contract, validate the naming and walk the importer itself, which was the fourth copy
  // of that walk; `packages/core/test/single-implementation.test.ts` fails if one reappears. What
  // stays here is what is genuinely this surface's: joining paths onto a directory the user picked in
  // a dialog, and the refusal wording below.
  const bundle = renderAssetBundle(
    sprite,
    {
      ...(packed && request.sheet
        ? { sheet: { atlas: packed, image: request.sheet.image } }
        : {}),
      ...(request.outputs ? { outputs: request.outputs } : {}),
      ...(request.directions ? { directions: request.directions } : {}),
      ...(request.directory === undefined ? {} : { directory: request.directory }),
    },
    request.engine ?? null,
  );
  const { meta, naming, text } = bundle;

  if (bundle.errors.length > 0) {
    return {
      written: false,
      files: [],
      naming: { ok: false, diagnostics: toFindings(bundle.errors) },
      refusal: refusalText(bundle.errors, 'the contract'),
    };
  }

  // Everything this call would write, as one list, before anything touches disk.
  // The contract path first because it is what `outputs` names are relative to.
  const writes: { path: string; bytes: Uint8Array | string }[] = [];
  writes.push({ path: request.path, bytes: text });

  let engineSummary: AssetEngineSummary | undefined;
  if (bundle.engine !== null) {
    // The importer ran inside `renderAssetBundle`; all that is left is putting the bytes on disk
    // under the directory the user chose. Relative, forward-slashed paths from the importer are
    // joined segment by segment so a Windows separator can never reach a contract path.
    const { root, files, warnings } = bundle.engine;
    for (const file of files) {
      writes.push({
        path: path.join(metaDir, root, ...file.path.split('/')),
        bytes: file.contents,
      });
    }
    engineSummary = {
      engine: request.engine!,
      root,
      files: files.map((file) => `${root}/${file.path}`),
      warnings: [...warnings],
    };
  }
  if (packed && request.sheet) {
    writes.push({
      path: path.resolve(metaDir, request.sheet.image),
      bytes: encodePNG(packed.image),
    });
  }

  const folded = new Map<string, string>();
  for (const write of writes) {
    const key = write.path.replace(/\\/g, '/').toLowerCase();
    const previous = folded.get(key);
    if (previous !== undefined && previous !== write.path) {
      return {
        written: false,
        metaPath: request.path,
        contentHash: meta.asset.contentHash,
        schemaVersion: meta.schemaVersion,
        files: [],
        naming: {
          ok: false,
          diagnostics: [
            {
              code: 'case-collision',
              severity: 'error',
              path: relativeTo(metaDir, write.path),
              message: `Two files in this bundle differ only in case: "${previous}" and "${write.path}".`,
              value: write.path,
            },
            ...toFindings(naming.diagnostics),
          ],
        },
        ...(engineSummary ? { engine: engineSummary } : {}),
        refusal: 'Two files in this bundle differ only in case, so the bundle is one file short on a case-insensitive filesystem.',
      };
    }
    folded.set(key, write.path);
  }

  for (const write of writes) {
    await mkdir(path.dirname(write.path), { recursive: true });
    await writeFile(write.path, write.bytes);
  }

  return {
    written: true,
    metaPath: request.path,
    contentHash: meta.asset.contentHash,
    schemaVersion: meta.schemaVersion,
    files: writes.map((write) => relativeTo(metaDir, write.path)),
    naming: { ok: true, diagnostics: toFindings(naming.diagnostics) },
    ...(engineSummary ? { engine: engineSummary } : {}),
  };
}