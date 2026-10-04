import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useEditor } from '../editor-context.js';
import { useI18n, type TranslationKey } from '../i18n.js';
import {
  buildExportRequest,
  errorsOf,
  initialBundleForm,
  summariseBundle,
  warningsOf,
  type BundleForm,
  type BundleSummary,
} from '../asset-bundle.js';
import { ASSET_ENGINES, type AssetEngine, type AssetNamingFinding } from '../../shared/types.js';
import { Icon } from './Icon.js';

/**
 * One label per engine, taken from the i18n layer like every other string.
 *
 * The engine ids are proper nouns and would read the same in all five locales —
 * the keys exist so that adding a fifth importer is a translation task rather
 * than a hunt for a hardcoded literal.
 */
const ENGINE_LABELS: Record<AssetEngine, TranslationKey> = {
  godot: 'asset.engineGodot',
  unity: 'asset.engineUnity',
  phaser: 'asset.enginePhaser',
  excalidraw: 'asset.engineExcalidraw',
};

/**
 * The asset-contract export panel: `meta.json`, optionally a packed sheet, and
 * optionally one engine importer's files beside the contract.
 *
 * The main process owns the save dialog and the policy; this panel collects the
 * three choices the dialog cannot ask about, sends them, and renders whatever
 * comes back. It never writes a file and never edits the document, which is why
 * it can be opened, used and abandoned without touching the undo history.
 */
export function AssetBundleDialog({ onClose }: { onClose(): void }): React.ReactNode {
  const { detail } = useEditor();
  const { t } = useI18n();
  const [form, setForm] = useState<BundleForm>(initialBundleForm);
  const [summary, setSummary] = useState<BundleSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  const patch = (next: Partial<BundleForm>) => setForm((current) => ({ ...current, ...next }));

  const run = async () => {
    setBusy(true);
    try {
      const request = buildExportRequest(form);
      // `undefined` is the active document: the panel is only reachable from a
      // window that has one, and asking for it by id would race a switch.
      const result = form.engine
        ? await api.exportEngine(undefined, form.engine, request)
        : await api.exportMeta(undefined, request);
      // A cancelled dialog arrives as `null` and is reported as itself, which is
      // why `summariseBundle` has a `cancelled` outcome at all.
      setSummary(summariseBundle(result));
    } catch (error) {
      setSummary(summariseBundle(null, error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal asset-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="asset-bundle-title"
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-icon">
            <Icon name="export" size={20} />
          </span>
          <div>
            <h2 id="asset-bundle-title">{t('asset.title')}</h2>
            <p>{t('asset.titleHint')}</p>
          </div>
        </div>

        <form
          className="modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          <div className="setting">
            <div className="setting-label">
              <span>{t('asset.target')}</span>
            </div>
            <div className="seg engine-choices" role="radiogroup" aria-label={t('asset.target')}>
              <button
                type="button"
                role="radio"
                aria-checked={form.engine === null}
                className={form.engine === null ? 'is-active' : undefined}
                onClick={() => patch({ engine: null })}
              >
                {t('asset.targetContract')}
              </button>
              {ASSET_ENGINES.map((engine) => (
                <button
                  key={engine}
                  type="button"
                  role="radio"
                  aria-checked={form.engine === engine}
                  className={form.engine === engine ? 'is-active' : undefined}
                  onClick={() => patch({ engine })}
                >
                  {t(ENGINE_LABELS[engine])}
                </button>
              ))}
            </div>
            <p className="setting-hint">
              {form.engine
                ? t('asset.targetEngine', { engine: t(ENGINE_LABELS[form.engine]) })
                : t('asset.targetContract')}
            </p>
          </div>

          <label className="switch-row">
            <input
              type="checkbox"
              checked={form.sheet}
              onChange={(event) => patch({ sheet: event.target.checked })}
            />
            <span className="switch" />
            <span>{t('asset.sheet')}</span>
          </label>
          {form.sheet && (
            <>
              <div className="modal-row">
                <label className="modal-field">
                  <span>{t('asset.sheetScale')}</span>
                  <select
                    className="select"
                    value={form.sheetScale}
                    aria-label={t('asset.sheetScale')}
                    onChange={(event) => patch({ sheetScale: Number(event.target.value) })}
                  >
                    {[1, 2, 3, 4, 8].map((value) => (
                      <option key={value} value={value}>
                        {value}×
                      </option>
                    ))}
                  </select>
                </label>
                <label className="modal-field">
                  <span>{t('asset.sheetColumns')}</span>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={64}
                    value={form.sheetColumns}
                    aria-label={t('asset.sheetColumns')}
                    onChange={(event) => patch({ sheetColumns: Number(event.target.value) })}
                  />
                </label>
              </div>
              <p className="setting-hint">{t('asset.sheetHint')}</p>
            </>
          )}

          <label className="modal-field">
            <span>{t('asset.directory')}</span>
            <input
              className="input"
              value={form.directory}
              spellCheck={false}
              placeholder={detail?.name ?? ''}
              aria-label={t('asset.directory')}
              onChange={(event) => patch({ directory: event.target.value })}
            />
          </label>
          <p className="setting-hint">{t('asset.directoryHint')}</p>

          {summary && <AssetBundleReport summary={summary} />}

          <div className="modal-actions">
            <button type="button" className="text-button" onClick={onClose}>
              {summary ? t('asset.done') : t('dialog.cancel')}
            </button>
            <button type="submit" className="text-button is-primary" disabled={busy}>
              <Icon name="export" size={15} />
              {busy ? t('asset.exporting') : t('asset.export')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * What one export produced.
 *
 * Branches entirely on `summary.outcome`, and each branch renders only what is
 * true for it: `cancelled` and `failed` produce no file list at all, and
 * `refused` presents the reason without a single "written" beside it. Nothing
 * here summarises the artwork — the exporter reports named defects, and the panel
 * repeats them.
 */
export function AssetBundleReport({ summary }: { summary: BundleSummary }): React.ReactNode {
  const { t } = useI18n();
  const errors = errorsOf(summary.findings);
  const warnings = warningsOf(summary.findings);

  if (summary.outcome === 'idle' || summary.outcome === 'cancelled') {
    // A cancelled save dialog is the most ordinary thing a person can do.
    return null;
  }

  if (summary.outcome === 'failed') {
    return (
      <div className="asset-report is-error" role="status">
        <p>{t('asset.failed', { error: summary.failure ?? '' })}</p>
      </div>
    );
  }

  if (summary.outcome === 'refused') {
    return (
      <div className="asset-report is-error" role="status">
        <b>{t('asset.refusedHeading')}</b>
        <p>{t('asset.refusedBody')}</p>
        {summary.refusal && (
          <div className="asset-refusal">
            <span>{t('asset.refusalDetail')}</span>
            <code className="mono">{summary.refusal}</code>
          </div>
        )}
        <FindingList label={t('asset.naming')} findings={errors} />
      </div>
    );
  }

  const engineName = summary.engine ? t(ENGINE_LABELS[summary.engine.engine]) : '';
  return (
    <div className="asset-report" role="status">
      <b>{t('asset.written', { count: summary.files.length })}</b>

      <dl className="about-list">
        {summary.metaPath && (
          <div className="about-row">
            <dt>{t('asset.contract')}</dt>
            <dd className="mono">{summary.metaPath}</dd>
          </div>
        )}
        {summary.contentHash && (
          <div className="about-row">
            <dt>{t('asset.contentHash')}</dt>
            <dd className="mono">{summary.contentHash}</dd>
          </div>
        )}
        {summary.engine && (
          <div className="about-row">
            <dt>{t('asset.targetEngine', { engine: engineName })}</dt>
            <dd className="mono">{summary.engine.root}</dd>
          </div>
        )}
      </dl>

      {/* The engine's own files, listed separately from the bundle's. Both lists
          are paths the exporter wrote; neither is a count of anything else. */}
      {summary.engine && (
        <div className="asset-block">
          <span className="setting-label">
            {t('asset.engineFiles', { engine: engineName, root: summary.engine.root })}
          </span>
          <ul className="asset-files mono">
            {summary.engine.files.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="asset-block">
        <span className="setting-label">{t('asset.files')}</span>
        <ul className="asset-files mono">
          {summary.files.map((file) => (
            <li key={file}>{file}</li>
          ))}
        </ul>
      </div>

      {summary.engine && summary.engine.warnings.length > 0 && (
        <div className="asset-block">
          <span className="setting-label">{t('asset.engineWarnings')}</span>
          <ul className="asset-notes">
            {summary.engine.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      {errors.length === 0 && warnings.length === 0 ? (
        <p className="setting-hint">{t('asset.namingClean')}</p>
      ) : (
        <>
          {errors.length > 0 && (
            <p className="asset-counts is-error">
              {t('asset.namingErrors', { count: errors.length })}
            </p>
          )}
          <FindingList label={t('asset.naming')} findings={errors} />
          {warnings.length > 0 && (
            <>
              <p className="asset-counts">{t('asset.namingWarnings', { count: warnings.length })}</p>
              <FindingList label={t('asset.naming')} findings={warnings} />
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Named defects, grouped the way the validator grouped them: severity, then code. */
function FindingList({
  label,
  findings,
}: {
  label: string;
  findings: readonly AssetNamingFinding[];
}): React.ReactNode {
  if (findings.length === 0) return null;
  return (
    <div className="asset-block" aria-label={label}>
      <ul className="asset-findings">
        {findings.map((finding, index) => (
          <li key={`${finding.code}-${finding.path}-${index}`} data-severity={finding.severity}>
            <code className="mono">{finding.code}</code>
            {finding.path !== '' && <span className="mono muted">{finding.path}</span>}
            <span>{finding.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}