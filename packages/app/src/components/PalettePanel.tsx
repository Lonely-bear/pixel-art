import { useState } from 'react';
import { useEditor } from '../editor-context.js';
import { colorsEqual, rgbaToCss, rgbaToHex, toColor } from '../color-utils.js';
import { useI18n } from '../i18n.js';
import { Icon } from './Icon.js';

export function PalettePanel(): React.ReactNode {
  const editor = useEditor();
  const detail = editor.detail;
  const { t } = useI18n();
  const [hex, setHex] = useState('#ffffff');

  if (!detail) return null;
  const colors = detail.palette.colors;

  return (
    <section className="panel palette-panel">
      <header className="panel-header">
        <div className="panel-title">
          <span className="panel-title-icon"><Icon name="fill" size={15} /></span>
          <h2>{t('palette.title')}</h2>
          <span className="count-badge">{colors.length}</span>
        </div>
        <div className="panel-actions">
          <button
            type="button"
            className="panel-icon-button"
            title={t('palette.add')}
            aria-label={t('palette.add')}
            onClick={() => void editor.execute('add_palette_color', { color: rgbaToHex(editor.primary) })}
          >
            <Icon name="plus" size={16} />
          </button>
          <button
            type="button"
            className="quantize-button"
            title={t('palette.quantizeHint')}
            onClick={() => void editor.execute('quantize_to_palette', { dither: 'none' })}
          >
            <Icon name="magic" size={14} />
            <span>{t('palette.quantize')}</span>
          </button>
        </div>
      </header>

      <div className="swatch-grid" title={t('palette.help')}>
        {colors.map((color, index) => {
          const isPrimary = colorsEqual(color, editor.primary);
          const isSecondary = colorsEqual(color, editor.secondary);
          return (
            <button
              key={`${index}-${rgbaToHex(color)}`}
              type="button"
              className={`palette-swatch${isPrimary ? ' primary' : ''}${isSecondary ? ' secondary' : ''}`}
              style={{ background: rgbaToCss(color) }}
              title={`${rgbaToHex(color)} — ${t('palette.help')}`}
              aria-label={rgbaToHex(color)}
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
        className="palette-form"
        onSubmit={(event) => {
          event.preventDefault();
          void editor.execute('add_palette_color', { color: toColor(hex) });
        }}
      >
        <label className="hex-input">
          <span>#</span>
          <input
            value={hex}
            onChange={(event) => setHex(event.target.value)}
            spellCheck={false}
            aria-label={t('palette.addColor')}
          />
        </label>
        <button type="submit" title={t('palette.addColor')}>
          <Icon name="plus" size={14} />
          {t('palette.addColor')}
        </button>
      </form>
      <p className="panel-help">{t('palette.help')}</p>
    </section>
  );
}

export function HistoryPanel(): React.ReactNode {
  const editor = useEditor();
  const { t, commandLabel } = useI18n();
  const entries = editor.historyEntries;

  return (
    <section className="panel history-panel">
      <header className="panel-header">
        <div className="panel-title">
          <span className="panel-title-icon"><Icon name="undo" size={15} /></span>
          <h2>{t('history.title')}</h2>
          <span className="count-badge">{entries.length}</span>
        </div>
        <div className="panel-actions">
          <button
            type="button"
            className="panel-icon-button"
            title={t('history.undo')}
            aria-label={t('history.undo')}
            onClick={() => void editor.undo()}
          >
            <Icon name="undo" size={15} />
          </button>
          <button
            type="button"
            className="panel-icon-button"
            title={t('history.redo')}
            aria-label={t('history.redo')}
            onClick={() => void editor.redo()}
          >
            <Icon name="redo" size={15} />
          </button>
        </div>
      </header>
      <ul className="history-list">
        {entries.map((entry, index) => (
          <li key={`${entry.command}-${index}`}>
            <span className="history-dot" />
            <div>
              <strong>{commandLabel(entry.command)}</strong>
              <span className="muted">{entry.label}</span>
            </div>
          </li>
        ))}
        {entries.length === 0 && <li className="empty-history"><span>{t('history.empty')}</span></li>}
      </ul>
    </section>
  );
}
