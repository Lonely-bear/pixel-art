/**
 * The asset-bundle panel's decisions, with no React in them.
 *
 * Two things live here rather than inside the component, and both are decisions
 * rather than layout: what the panel *asks the main process for*, and what it
 * makes of what comes back. The exporter answers with named defects, file lists
 * and one refusal sentence, and the panel's whole job is to branch on those
 * without inventing anything — in particular without turning them into a verdict.
 * See AGENTS.md, "Do not show an agent a number to optimise".
 *
 * `AssetExportRequest.directions` is deliberately **never** set here. A per-frame
 * facing is a decision somebody makes where the artwork is drawn; a panel that
 * inferred one from tag names would put a character in the engine facing the wrong
 * way with nothing in the contract to trace it back to. The field is omitted, not
 * defaulted, so the contract states plainly that this asset carries no per-frame
 * direction — which is the truth for a prop, an effect and most still sprites.
 */
import type {
  AssetEngine,
  AssetExportRequest,
  AssetExportResult,
  AssetNamingFinding,
} from '../shared/types.js';

/** The bundle-relative name of the packed sheet. Fixed, so it cannot go stale. */
const SHEET_IMAGE = 'sprite.png';

export interface BundleForm {
  /** `null` writes the contract alone; an engine writes its files beside it. */
  engine: AssetEngine | null;
  sheet: boolean;
  sheetScale: number;
  sheetColumns: number;
  /** Bundle-relative folder for the engine's files. Empty means the default. */
  directory: string;
}

export function initialBundleForm(): BundleForm {
  return { engine: null, sheet: false, sheetScale: 1, sheetColumns: 0, directory: '' };
}

/**
 * The request for the main process's save dialog.
 *
 * Empty optional fields are left out rather than sent as empty values: the
 * exporter reads `directory` as "use the importer's suggested root", and a `0`
 * column count would be a packer instruction rather than a missing one.
 */
export function buildExportRequest(form: BundleForm): AssetExportRequest {
  const directory = form.directory.trim();
  const columns = Math.max(0, Math.round(form.sheetColumns));
  return {
    ...(form.sheet
      ? {
          sheet: {
            image: SHEET_IMAGE,
            scale: Math.max(1, Math.round(form.sheetScale)),
            ...(columns > 0 ? { columns } : {}),
          },
        }
      : {}),
    ...(directory ? { directory } : {}),
  };
}

export type BundleOutcome = 'idle' | 'cancelled' | 'failed' | 'refused' | 'written';

/**
 * Everything the report renders, derived from one call.
 *
 * `files` is populated only for `written`, so "what was written" cannot be
 * rendered at all on the two outcomes where nothing was: a refusal carries no
 * file list and an error carries no file list. That is the whole point of the
 * shape — the branch is in the data, not in the markup.
 */
export interface BundleSummary {
  outcome: BundleOutcome;
  /** A failed IPC call. Present only for `failed`. */
  failure?: string;
  /** The exporter's own English sentence. Present only for `refused`. */
  refusal?: string;
  /** Where `meta.json` went. Present only for `written`. */
  metaPath?: string;
  contentHash?: string;
  /** Files written, relative to the contract's folder. Non-empty only for `written`. */
  files: string[];
  /** Engine files and the folder they went in. Present only when an engine ran. */
  engine?: { engine: AssetEngine; root: string; files: string[]; warnings: string[] };
  /** Every naming finding, errors first. Warnings are reported and written. */
  findings: AssetNamingFinding[];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Errors first, then byte order by `code` then `path`.
 *
 * Plain `<` rather than `localeCompare`: the contract's own diagnostics are
 * sorted the same way, so two runs over one bundle list them in one order, and a
 * locale-aware sort would make that order depend on the machine.
 */
export function sortFindings(findings: readonly AssetNamingFinding[]): AssetNamingFinding[] {
  return [...findings].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

/**
 * The whole result -> report decision.
 *
 * `null` is a **cancelled save dialog**, not a failure: the user closed the
 * dialog, which is the most ordinary thing a person can do, so it must produce no
 * message, no error styling and no notice. It is a separate outcome from `failed`
 * because collapsing the two is exactly how "cancelled" ends up reported as a
 * failure somewhere downstream.
 */
export function summariseBundle(
  result: AssetExportResult | null,
  error?: unknown,
): BundleSummary {
  if (error !== undefined) {
    return { outcome: 'failed', failure: describeError(error), files: [], findings: [] };
  }
  if (result === null) {
    return { outcome: 'cancelled', files: [], findings: [] };
  }

  const findings = sortFindings(result.naming.diagnostics);
  if (!result.written) {
    // Nothing on disk, so no paths and no hash: reporting either would read as
    // "here is what you got" for a bundle that was refused.
    return {
      outcome: 'refused',
      ...(result.refusal ? { refusal: result.refusal } : {}),
      files: [],
      findings,
    };
  }

  return {
    outcome: 'written',
    ...(result.metaPath ? { metaPath: result.metaPath } : {}),
    ...(result.contentHash ? { contentHash: result.contentHash } : {}),
    files: result.files,
    ...(result.engine
      ? {
          engine: {
            engine: result.engine.engine,
            root: result.engine.root,
            files: result.engine.files,
            warnings: result.engine.warnings,
          },
        }
      : {}),
    findings,
  };
}

export function errorsOf(findings: readonly AssetNamingFinding[]): AssetNamingFinding[] {
  return findings.filter((finding) => finding.severity === 'error');
}

export function warningsOf(findings: readonly AssetNamingFinding[]): AssetNamingFinding[] {
  return findings.filter((finding) => finding.severity === 'warning');
}