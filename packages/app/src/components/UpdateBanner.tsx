import { useEffect, useState } from 'react';
import { useI18n } from '../i18n.js';
import { api } from '../api.js';
import { megabytes, useUpdateSnapshot } from '../update.js';
import { ReleaseNotes } from './ReleaseNotes.js';
import { Icon } from './Icon.js';

/**
 * The update banner: one row, pinned under the title bar, present only while
 * there is something to decide.
 *
 * Two rules keep it from becoming a nuisance. It never appears for a version the
 * user has already dismissed — "Later" hides it until a *different* version is
 * found or the app is asked again, and "Skip this version" is recorded in the
 * main process so the six-hourly background check stops raising it. And it is
 * not a grid row: it is a fixed overlay, so the timeline and the canvas keep
 * exactly the height they had before anything was found.
 *
 * The restart is a button and not an automatic action. An editor holds work
 * that exists only in the process, so a downloaded update waits for a person.
 */
export function UpdateBanner(): React.ReactNode {
  const { t } = useI18n();
  const snapshot = useUpdateSnapshot();
  const state = snapshot?.state;
  const version = state && 'version' in state ? state.version : undefined;
  const [dismissed, setDismissed] = useState(false);

  // A new version is news again, however the old one was dismissed.
  useEffect(() => setDismissed(false), [version]);

  if (!state) return null;
  if (state.status === 'downloading' || state.status === 'ready') {
    return (
      <div className="update-banner" role="status">
        {state.status === 'downloading' ? (
          <>
            <Icon name="arrowDown" size={14} />
            <span className="update-text">
              {t('update.downloading', {
                done: megabytes(state.transferred) ?? '0',
                total: megabytes(state.total) ?? '0',
              })}
            </span>
            <span className="update-bar" aria-hidden="true">
              <span
                className="update-bar-fill"
                style={{ width: `${state.total ? Math.min(100, (state.transferred / state.total) * 100) : 0}%` }}
              />
            </span>
          </>
        ) : (
          <>
            <Icon name="check" size={14} />
            <span className="update-text">{t('update.ready')}</span>
            <button
              type="button"
              className="text-button is-primary update-action"
              onClick={() => void api.installUpdate()}
            >
              {t('update.restart')}
            </button>
            <button
              type="button"
              className="text-button update-action"
              onClick={() => setDismissed(true)}
            >
              {t('update.later')}
            </button>
          </>
        )}
      </div>
    );
  }

  if (state.status !== 'available' || dismissed) return null;

  const size = megabytes(state.bytes);
  return (
    <div className="update-banner" role="status">
      <Icon name="sparkle" size={14} />
      <span className="update-text">
        <b>{t('update.available', { version: state.version })}</b>
        {size && <span className="update-meta"> · {t('update.size', { size })}</span>}
        {state.date && (
          <span className="update-meta"> · {t('update.date', { date: state.date.slice(0, 10) })}</span>
        )}
      </span>
      {state.notes && <ReleaseNotes body={state.notes} label={t('update.notes')} />}
      <button
        type="button"
        className="text-button is-primary update-action"
        onClick={() => void api.downloadUpdate()}
      >
        {t('update.download')}
      </button>
      <button type="button" className="text-button update-action" onClick={() => setDismissed(true)}>
        {t('update.later')}
      </button>
      <button
        type="button"
        className="text-button update-action"
        onClick={() => void api.skipVersion(state.version)}
      >
        {t('update.skip')}
      </button>
    </div>
  );
}
