import { useState } from 'react';
import { useEditor } from '../editor-context.js';
import { useI18n } from '../i18n.js';
import { Icon, type IconName } from './Icon.js';

export function FramesPanel(): React.ReactNode {
  const editor = useEditor();
  const detail = editor.detail;
  const { t } = useI18n();
  const [tagName, setTagName] = useState('');

  if (!detail) return null;

  const index = detail.frameList.findIndex((frame) => frame.id === editor.frameId);

  // A whole-frame nudge, so a bob is one click instead of a redraw.
  const nudge = (dx: number, dy: number) =>
    editor.execute('translate', { layer: '*', frame: editor.frameId, dx, dy });

  const directionLabel = (direction: string) =>
    direction === 'pingpong' ? t('frames.pingPong') : t('frames.forward');

  return (
    <section className="panel frames-panel">
      <header className="panel-header timeline-header">
        <div className="panel-title">
          <span className="panel-title-icon"><Icon name="play" size={14} /></span>
          <h2>{t('frames.title')}</h2>
          <span className="timeline-summary">
            {t('frames.summary', {
              duration: detail.durationMs,
              count: detail.frameCount,
              plural: detail.frameCount === 1 ? '' : 's',
            })}
          </span>
        </div>
        <div className="panel-actions">
          <button
            type="button"
            className="panel-icon-button"
            title={t('frames.add')}
            aria-label={t('frames.add')}
            onClick={() => void editor.execute('add_frame', {})}
          >
            <Icon name="plus" size={16} />
          </button>
          <button
            type="button"
            className="panel-icon-button"
            title={t('frames.duplicate')}
            aria-label={t('frames.duplicate')}
            disabled={!editor.frameId}
            onClick={() => void editor.execute('duplicate_frame', { frame: editor.frameId, count: 1 })}
          >
            <Icon name="copy" size={15} />
          </button>
          <button
            type="button"
            className="panel-icon-button"
            title={t('frames.left')}
            aria-label={t('frames.left')}
            disabled={index <= 0}
            onClick={() => void editor.execute('reorder_frame', { frame: editor.frameId, index: index - 1 })}
          >
            <Icon name="arrowLeft" size={15} />
          </button>
          <button
            type="button"
            className="panel-icon-button"
            title={t('frames.right')}
            aria-label={t('frames.right')}
            disabled={index < 0 || index === detail.frameList.length - 1}
            onClick={() => void editor.execute('reorder_frame', { frame: editor.frameId, index: index + 1 })}
          >
            <Icon name="arrowRight" size={15} />
          </button>
          <button
            type="button"
            className="panel-icon-button danger"
            title={t('frames.delete')}
            aria-label={t('frames.delete')}
            disabled={detail.frameList.length <= 1}
            onClick={() => void editor.execute('remove_frame', { frame: editor.frameId })}
          >
            <Icon name="trash" size={15} />
          </button>
        </div>
      </header>

      <div className="timeline-body">
        <ul className="frame-strip" aria-label={t('frames.title')}>
          {detail.frameList.map((frame) => {
            const selected = frame.id === editor.frameId;
            const url = editor.thumbnails.get(frame.id);
            return (
              <li key={frame.id} className={selected ? 'selected' : undefined}>
                <button
                  type="button"
                  className="frame-thumb"
                  onClick={() => editor.setFrameId(frame.id)}
                  title={t('frames.index', { index: frame.index + 1 })}
                  aria-label={t('frames.index', { index: frame.index + 1 })}
                  aria-pressed={selected}
                >
                  {url ? <img src={url} alt="" draggable={false} /> : <span className="placeholder" />}
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

        <div className="timeline-settings">
          <div className="playback">
            <div className="subsection-title">
              <Icon name="play" size={13} />
              <span>{t('frames.playback')}</span>
            </div>
            <div className="playback-row">
              <button
                type="button"
                className={`play-button${editor.playing ? ' active' : ''}`}
                title={editor.playing ? t('frames.pause') : t('frames.play')}
                aria-label={editor.playing ? t('frames.pause') : t('frames.play')}
                onClick={() => editor.setPlaying(!editor.playing)}
              >
                <Icon name={editor.playing ? 'pause' : 'play'} size={16} />
              </button>
              <select
                className="doc-select"
                value={editor.playTag}
                title={t('frames.animationTag')}
                aria-label={t('frames.animationTag')}
                onChange={(event) => editor.setPlayTag(event.target.value)}
              >
                <option value="">{t('top.allFrames')}</option>
                {detail.tagList.map((tag) => (
                  <option key={tag.id} value={tag.name}>
                    {tag.name} ({directionLabel(tag.direction)})
                  </option>
                ))}
              </select>
              <label className="speed-control" title={t('frames.speed')}>
                <span>{t('frames.speed')}</span>
                <input
                  type="number"
                  min={0.25}
                  max={4}
                  step={0.25}
                  value={editor.playSpeed}
                  onChange={(event) => editor.setPlaySpeed(Math.max(0.25, Number(event.target.value) || 1))}
                />
                <em>×</em>
              </label>
            </div>
            <div className="onion-row">
              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={editor.onionSkin}
                  onChange={(event) => editor.setOnionSkin(event.target.checked)}
                />
                <span className="switch-track"><span /></span>
                <span>{t('frames.onion')}</span>
              </label>
              <label className="mini-number">
                <span>{t('frames.before')}</span>
                <input
                  type="number"
                  min={0}
                  max={4}
                  value={editor.onionBefore}
                  disabled={!editor.onionSkin}
                  onChange={(event) => editor.setOnionBefore(Math.max(0, Number(event.target.value) || 0))}
                />
              </label>
              <label className="mini-number">
                <span>{t('frames.after')}</span>
                <input
                  type="number"
                  min={0}
                  max={4}
                  value={editor.onionAfter}
                  disabled={!editor.onionSkin}
                  onChange={(event) => editor.setOnionAfter(Math.max(0, Number(event.target.value) || 0))}
                />
              </label>
            </div>
          </div>

          <div className="motion">
            <div className="subsection-title">
              <Icon name="pan" size={13} />
              <span>{t('frames.move')}</span>
            </div>
            <div className="motion-controls">
              <NudgeButton
                icon="arrowUp"
                label={t('frames.nudgeUp')}
                disabled={!editor.frameId}
                onClick={() => void nudge(0, -1)}
              />
              <NudgeButton
                icon="arrowDown"
                label={t('frames.nudgeDown')}
                disabled={!editor.frameId}
                onClick={() => void nudge(0, 1)}
              />
              <NudgeButton
                icon="arrowLeft"
                label={t('frames.nudgeLeft')}
                disabled={!editor.frameId}
                onClick={() => void nudge(-1, 0)}
              />
              <NudgeButton
                icon="arrowRight"
                label={t('frames.nudgeRight')}
                disabled={!editor.frameId}
                onClick={() => void nudge(1, 0)}
              />
              <button
                type="button"
                className="motion-text-button"
                title={t('frames.squashHint')}
                disabled={!editor.frameId}
                onClick={() =>
                  void editor.execute('squash', {
                    layer: '*',
                    frame: editor.frameId,
                    scaleY: 0.9,
                    scaleX: 1.08,
                    pivot: 'bottom',
                  })
                }
              >
                {t('frames.squash')}
              </button>
              <button
                type="button"
                className="motion-text-button"
                title={t('frames.stretchHint')}
                disabled={!editor.frameId}
                onClick={() =>
                  void editor.execute('squash', {
                    layer: '*',
                    frame: editor.frameId,
                    scaleY: 1.1,
                    scaleX: 0.94,
                    pivot: 'bottom',
                  })
                }
              >
                {t('frames.stretch')}
              </button>
            </div>
          </div>

          <div className="tags">
            <div className="subsection-title">
              <Icon name="tag" size={13} />
              <span>{t('frames.tags')}</span>
            </div>
            {detail.tagList.length === 0 ? (
              <p className="empty-note">{t('frames.noTags')}</p>
            ) : (
              <ul>
                {detail.tagList.map((tag) => (
                  <li key={tag.id}>
                    <span className="tag-symbol"><Icon name="tag" size={12} /></span>
                    <div>
                      <strong>{tag.name}</strong>
                      <span className="muted">
                        {tag.from}–{tag.to} · {directionLabel(tag.direction)}
                        {tag.repeat > 0 ? ` ×${tag.repeat}` : ` · ${t('frames.loop')}`}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="tag-delete"
                      title={t('frames.deleteTag')}
                      aria-label={t('frames.deleteTag')}
                      onClick={() => void editor.execute('remove_tag', { tag: tag.id })}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <form
              className="tag-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!tagName.trim()) return;
                void editor.execute('add_tag', {
                  name: tagName.trim(),
                  from: 0,
                  to: detail.frameList.length - 1,
                });
                setTagName('');
              }}
            >
              <input
                value={tagName}
                placeholder={t('frames.tagPlaceholder')}
                onChange={(event) => setTagName(event.target.value)}
              />
              <button type="submit" disabled={detail.frameList.length === 0}>
                <Icon name="plus" size={14} />
                {t('frames.tagAll')}
              </button>
            </form>
          </div>
        </div>
      </div>
    </section>
  );
}

function NudgeButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: IconName;
  label: string;
  disabled: boolean;
  onClick: () => void;
}): React.ReactNode {
  return (
    <button
      type="button"
      className="motion-button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}
