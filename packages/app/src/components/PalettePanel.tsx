import { useState } from 'react';
import { useEditor } from '../editor-context.js';
import { colorsEqual, rgbaToCss, rgbaToHex, toColor } from '../color-utils.js';

export function PalettePanel(): React.ReactNode {
  const editor = useEditor();
  const detail = editor.detail;
  const [hex, setHex] = useState('#ffffff');

  if (!detail) return null;
  const colors = detail.palette.colors;

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>
          Palette <span className="muted">{detail.palette.name}</span>
        </h2>
        <div className="panel-actions">
          <button
            type="button"
            title="Add the primary colour to the palette"
            onClick={() => void editor.execute('add_palette_color', { color: rgbaToHex(editor.primary) })}
          >
            +
          </button>
          <button
            type="button"
            title="Remap every cel onto this palette"
            onClick={() => void editor.execute('quantize_to_palette', { dither: 'none' })}
          >
            quantize
          </button>
        </div>
      </header>

      <div className="swatch-grid">
        {colors.map((color, index) => {
          const isPrimary = colorsEqual(color, editor.primary);
          const isSecondary = colorsEqual(color, editor.secondary);
          return (
            <button
              key={`${index}-${rgbaToHex(color)}`}
              type="button"
              className={`palette-swatch${isPrimary ? ' primary' : ''}${isSecondary ? ' secondary' : ''}`}
              style={{ background: rgbaToCss(color) }}
              title={`${rgbaToHex(color)} — click to use, right-click for secondary, double-click to remove`}
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
        <input value={hex} onChange={(event) => setHex(event.target.value)} spellCheck={false} />
        <button type="submit">Add</button>
      </form>
    </section>
  );
}

export function HistoryPanel(): React.ReactNode {
  const editor = useEditor();
  const entries = editor.historyEntries;

  return (
    <section className="panel history-panel">
      <header className="panel-header">
        <h2>
          History <span className="muted">{entries.length}</span>
        </h2>
        <div className="panel-actions">
          <button type="button" title="Undo (Ctrl+Z)" onClick={() => void editor.undo()}>
            ↶
          </button>
          <button type="button" title="Redo (Ctrl+Shift+Z)" onClick={() => void editor.redo()}>
            ↷
          </button>
        </div>
      </header>
      <ul className="history-list">
        {entries.map((entry, index) => (
          <li key={`${entry.command}-${index}`}>
            <code>{entry.command}</code>
            <span className="muted">{entry.label}</span>
          </li>
        ))}
        {entries.length === 0 && <li className="muted">Nothing yet.</li>}
      </ul>
    </section>
  );
}
