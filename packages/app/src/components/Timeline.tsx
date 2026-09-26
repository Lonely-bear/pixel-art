import { useEditor } from '../editor-context.js';
import { useI18n } from '../i18n.js';
import { Icon } from './Icon.js';

/**
 * The timeline dock: transport on top, frame strip below.
 *
 * Playback settings used to share this row with the frame list, which made both
 * cramped. They now live in the sidebar's Animation section, so this dock does
 * one job — moving through frames.
 */
export function Timeline(): React.ReactNode {
  const editor = useEditor();
  const detail = editor.detail;
  const { t } = useI18n();

  if (!detail) return null;

  const index = detail.frameList.findIndex((frame) => frame.id === editor.frameId);
  const step = (delta: number) => {
    const next = detail.frameList[index + delta];
    if (next) editor.setFrameId(next.id);
  };

  return (
    <section className="timeline" aria-label={t('frames.title')}>
      <div className="transport">
        <button
          type="button"
          className={`transport-play${editor.playing ? ' is-playing' : ''}`}
          onClick={() => editor.setPlaying(!editor.playing)}
          title={editor.playing ? t('frames.pause') : t('frames.play')}
          aria-label={editor.playing ? t('frames.pause') : t('frames.play')}
          aria-pressed={editor.playing}
        >
          <Icon name={editor.playing ? 'pause' : 'play'} size={15} />
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => step(-1)}
          disabled={index <= 0}
          title={t('frames.previous')}
          aria-label={t('frames.previous')}
        >
          <Icon name="skipStart" size={15} />
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => step(1)}
          disabled={index < 0 || index === detail.frameList.length - 1}
          title={t('frames.next')}
          aria-label={t('frames.next')}
        >
          <Icon name="skipEnd" size={15} />
        </button>

        <select
          className="select hide-narrow"
          style={{ width: 128 }}
          value={editor.playTag}
          title={t('frames.animationTag')}
          aria-label={t('frames.animationTag')}
          onChange={(event) => editor.setPlayTag(event.target.value)}
        >
          <option value="">{t('top.allFrames')}</option>
          {detail.tagList.map((tag) => (
            <option key={tag.id} value={tag.name}>
              {tag.name}
            </option>
          ))}
        </select>

        <label className="pill" title={t('frames.speed')}>
          <span className="hide-narrow">{t('frames.speed')}</span>
          <input
            className="speed-input mono"
            type="number"
            min={0.25}
            max={4}
            step={0.25}
            value={editor.playSpeed}
            aria-label={t('frames.speed')}
            onChange={(event) =>
              editor.setPlaySpeed(Math.max(0.25, Number(event.target.value) || 1))
            }
          />
          <span className="muted">×</span>
        </label>

        <label className="switch-row" title={t('frames.onion')}>
          <input
            type="checkbox"
            checked={editor.onionSkin}
            onChange={(event) => editor.setOnionSkin(event.target.checked)}
          />
          <span className="switch" />
          <Icon name="onion" size={14} />
          <span className="hide-narrow">{t('frames.onion')}</span>
        </label>

        <span className="spacer" />

        <span className="transport-summary">
          {t('frames.tagged', {
            duration: detail.durationMs,
            count: detail.frameCount,
          })}
        </span>

        <div className="button-cluster">
          <button
            type="button"
            className="icon-button"
            title={t('frames.add')}
            aria-label={t('frames.add')}
            onClick={() => void editor.execute('add_frame', {})}
          >
            <Icon name="plus" size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            title={t('frames.duplicate')}
            aria-label={t('frames.duplicate')}
            disabled={!editor.frameId}
            onClick={() =>
              void editor.execute('duplicate_frame', { frame: editor.frameId, count: 1 })
            }
          >
            <Icon name="copy" size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            title={t('frames.left')}
            aria-label={t('frames.left')}
            disabled={index <= 0}
            onClick={() =>
              void editor.execute('reorder_frame', { frame: editor.frameId, index: index - 1 })
            }
          >
            <Icon name="arrowLeft" size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            title={t('frames.right')}
            aria-label={t('frames.right')}
            disabled={index < 0 || index === detail.frameList.length - 1}
            onClick={() =>
              void editor.execute('reorder_frame', { frame: editor.frameId, index: index + 1 })
            }
          >
            <Icon name="arrowRight" size={14} />
          </button>
          <button
            type="button"
            className="icon-button is-danger"
            title={t('frames.delete')}
            aria-label={t('frames.delete')}
            disabled={detail.frameList.length <= 1}
            onClick={() => void editor.execute('remove_frame', { frame: editor.frameId })}
          >
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>

      <ul className="frame-strip">
        {detail.frameList.map((frame) => {
          const selected = frame.id === editor.frameId;
          const url = editor.thumbnails.get(frame.id);
          return (
            <li key={frame.id} className={`frame-cell${selected ? ' is-selected' : ''}`}>
              <button
                type="button"
                className="frame-thumb"
                onClick={() => editor.setFrameId(frame.id)}
                title={t('frames.index', { index: frame.index + 1 })}
                aria-label={t('frames.index', { index: frame.index + 1 })}
                aria-pressed={selected}
              >
                {url && <img src={url} alt="" draggable={false} />}
                <span className="frame-index">{frame.index + 1}</span>
              </button>
              <label className="frame-duration" title={t('frames.duration')}>
                <input
                  type="number"
                  min={10}
                  step={10}
                  value={frame.durationMs}
                  onChange={(event) =>
                    void editor.execute('update_frame', {
                      frame: frame.id,
                      durationMs: Math.max(10, Number(event.target.value) || 10),
                    })
                  }
                />
                <span>ms</span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
