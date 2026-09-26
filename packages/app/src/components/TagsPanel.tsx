import { useState } from 'react';
import { useEditor } from '../editor-context.js';
import { useI18n } from '../i18n.js';
import { Icon } from './Icon.js';

/**
 * Animation tags: named ranges of the timeline that the GIF export and the
 * player both resolve through the same sequence, so a tag is one concept rather
 * than two settings that can drift.
 */
export function TagsPanel(): React.ReactNode {
  const editor = useEditor();
  const detail = editor.detail;
  const { t } = useI18n();
  const [name, setName] = useState('');

  if (!detail) return null;

  const directionLabel = (direction: string) =>
    direction === 'pingpong' ? t('tags.pingPong') : t('tags.forward');

  return (
    <>
      {detail.tagList.length === 0 ? (
        <p className="hint">{t('tags.empty')}</p>
      ) : (
        detail.tagList.map((tag) => (
          <div key={tag.id} className="tag-row">
            <b>{tag.name}</b>
            <span className="muted spacer">
              {t('tags.range', {
                from: tag.from,
                to: tag.to,
                direction: tag.repeat > 0 ? `×${tag.repeat}` : directionLabel(tag.direction),
              })}
            </span>
            <button
              type="button"
              className="icon-button is-danger"
              title={t('tags.delete')}
              aria-label={t('tags.delete')}
              onClick={() => void editor.execute('remove_tag', { tag: tag.id })}
            >
              <Icon name="cross" size={13} />
            </button>
          </div>
        ))
      )}

      <form
        className="tag-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim() || detail.frameList.length === 0) return;
          void editor.execute('add_tag', {
            name: name.trim(),
            from: 0,
            to: detail.frameList.length - 1,
          });
          setName('');
        }}
      >
        <input
          className="input"
          value={name}
          placeholder={t('tags.placeholder')}
          aria-label={t('tags.add')}
          onChange={(event) => setName(event.target.value)}
        />
        <button
          type="submit"
          className="icon-button"
          disabled={detail.frameList.length === 0}
          title={t('tags.add')}
          aria-label={t('tags.add')}
        >
          <Icon name="plus" size={14} />
        </button>
      </form>
    </>
  );
}
