import { useState } from 'react';
import { useEditor } from '../editor-context.js';
import { colorsEqual, rgbaToCss, rgbaToHex, toColor } from '../color-utils.js';
import { useI18n } from '../i18n.js';
import { Icon } from './Icon.js';

/**
 * The palette grid plus a hex field.
 *
 * The grid is `repeat(8, 1fr)`, so it is the one part of the sidebar that
 * genuinely flexes: eight columns fit 300px, 272px and 240px alike, and the
 * swatches simply get smaller.
 */
export function PalettePanel(): React.ReactNode {
  const editor = useEditor();
  const detail = editor.detail;
  const { t } = useI18n();
  const [hex, setHex] = useState('#ffffff');

  if (!detail) return null;
  const colors = detail.palette.colors;

  return (
    <>
      <div className="swatch-grid" title={t('palette.help')}>
        {colors.map((color, index) => {
          const isPrimary = colorsEqual(color, editor.primary);
          const isSecondary = colorsEqual(color, editor.secondary);
          return (
            <button
              key={`${index}-${rgbaToHex(color)}`}
              type="button"
              className={`palette-swatch${isPrimary ? ' is-primary' : ''}${
                isSecondary ? ' is-secondary' : ''
              }`}
              style={{ background: rgbaToCss(color) }}
              title={rgbaToHex(color)}
              aria-label={rgbaToHex(color)}
              aria-pressed={isPrimary}
              onClick={() => editor.setPrimary(color)}
              onContextMenu={(event) => {
                event.preventDefault();
                editor.setSecondary(color);
              }}
              onDoubleClick={() => void editor.execute('remove_palette_color', { index })}
            />
          );
        })}
      </div>

      <form
        className="hex-row"
        onSubmit={(event) => {
          event.preventDefault();
          void editor.execute('add_palette_color', { color: toColor(hex) });
        }}
      >
        <span className="hex-chip" style={{ background: rgbaToCss(editor.primary) }} />
        <label className="hex-field">
          <span className="muted">#</span>
          <input
            value={hex}
            onChange={(event) => setHex(event.target.value)}
            spellCheck={false}
            aria-label={t('palette.addColor')}
          />
        </label>
        <button
          type="submit"
          className="icon-button"
          title={t('palette.addColor')}
          aria-label={t('palette.addColor')}
        >
          <Icon name="plus" size={14} />
        </button>
      </form>

      <p className="hint">{t('palette.help')}</p>
    </>
  );
}

/** The undo stack, newest first. Read-only: the buttons live in the header. */
export function HistoryPanel(): React.ReactNode {
  const editor = useEditor();
  const { t, commandLabel } = useI18n();
  const entries = editor.historyEntries;

  if (entries.length === 0) {
    return <p className="hint">{t('history.empty')}</p>;
  }

  return (
    <ul className="history-list">
      {entries.map((entry, index) => (
        <li key={`${entry.command}-${index}`} className="history-row">
          <span className="history-dot" aria-hidden="true" />
          <span title={entry.label}>{commandLabel(entry.command)}</span>
        </li>
      ))}
    </ul>
  );
}
