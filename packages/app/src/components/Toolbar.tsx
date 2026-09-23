import { useEditor } from '../editor-context.js';
import type { ToolId } from '../../shared/types.js';
import { rgbaToCss, rgbaToHex, toColor } from '../color-utils.js';

const TOOLS: Array<{ id: ToolId; glyph: string; label: string; key: string }> = [
  { id: 'pencil', glyph: '✏', label: 'Pencil', key: 'B' },
  { id: 'eraser', glyph: '⌫', label: 'Eraser', key: 'E' },
  { id: 'line', glyph: '╱', label: 'Line', key: 'L' },
  { id: 'rect', glyph: '▭', label: 'Rectangle', key: 'R' },
  { id: 'ellipse', glyph: '◯', label: 'Ellipse', key: 'O' },
  { id: 'fill', glyph: '▩', label: 'Flood fill', key: 'F' },
  { id: 'replace', glyph: '⇄', label: 'Replace colour under cursor', key: 'X' },
  { id: 'eyedropper', glyph: '⊙', label: 'Pick colour', key: 'I' },
  { id: 'pan', glyph: '✥', label: 'Pan', key: 'H' },
];

export function Toolbar(): React.ReactNode {
  const editor = useEditor();
  const { tool, setTool, brushSize, setBrushSize, primary, setPrimary, secondary, setSecondary } =
    editor;

  const swap = () => {
    setPrimary(secondary);
    setSecondary(primary);
  };

  return (
    <aside className="toolbar">
      <div className="tool-grid">
        {TOOLS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`tool-button${tool === entry.id ? ' active' : ''}`}
            title={`${entry.label} (${entry.key})`}
            onClick={() => setTool(entry.id)}
          >
            <span aria-hidden="true">{entry.glyph}</span>
          </button>
        ))}
      </div>

      <div className="toolbar-section">
        <label className="field">
          <span>Brush</span>
          <input
            type="range"
            min={1}
            max={8}
            value={brushSize}
            onChange={(event) => setBrushSize(Number(event.target.value))}
          />
          <output>{brushSize}px</output>
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={editor.fillShapes}
            onChange={(event) => editor.setFillShapes(event.target.checked)}
          />
          <span>Filled shapes</span>
        </label>
      </div>

      <div className="toolbar-section">
        <div className="swatch-stack">
          <label className="swatch primary" title="Primary colour (left click)">
            <input
              type="color"
              value={rgbaToHex(primary).slice(0, 7)}
              onChange={(event) => setPrimary(toColor(event.target.value, primary))}
            />
            <span style={{ background: rgbaToCss(primary) }} />
          </label>
          <label className="swatch secondary" title="Secondary colour (right click)">
            <input
              type="color"
              value={rgbaToHex(secondary).slice(0, 7)}
              onChange={(event) => setSecondary(toColor(event.target.value, secondary))}
            />
            <span style={{ background: rgbaToCss(secondary) }} />
          </label>
        </div>
        <button type="button" className="link-button" onClick={swap} title="Swap colours (Tab)">
          swap
        </button>
        <label className="field">
          <span>Alpha</span>
          <input
            type="range"
            min={0}
            max={255}
            value={primary.a}
            onChange={(event) => setPrimary({ ...primary, a: Number(event.target.value) })}
          />
        </label>
        <code className="hex">{rgbaToHex(primary)}</code>
      </div>
    </aside>
  );
}
