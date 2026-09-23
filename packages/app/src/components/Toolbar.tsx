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

const DITHER_PATTERNS = [
  'checker',
  'checker-inv',
  'bayer4',
  'bayer8',
  'dots',
  'sparse',
  'dense',
  'horizontal',
  'vertical',
  'diagonal',
] as const;

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
        <label className="field" title="Keep paint inside pixels that already exist">
          <span>Clip</span>
          <select
            className="doc-select"
            value={editor.clip}
            onChange={(event) => editor.setClip(event.target.value as 'none' | 'cel' | 'composite')}
          >
            <option value="none">None</option>
            <option value="cel">This layer</option>
            <option value="composite">Silhouette</option>
          </select>
        </label>
        <label className="field" title="Stipple every write instead of laying paint down solid">
          <span>Dither</span>
          <select
            className="doc-select"
            value={editor.ditherPattern}
            onChange={(event) => editor.setDitherPattern(event.target.value)}
          >
            <option value="">Off</option>
            {DITHER_PATTERNS.map((pattern) => (
              <option key={pattern} value={pattern}>
                {pattern}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Level</span>
          <input
            type="range"
            min={0.05}
            max={1}
            step={0.05}
            value={editor.ditherLevel}
            disabled={!editor.ditherPattern}
            onChange={(event) => editor.setDitherLevel(Number(event.target.value))}
          />
          <output>{Math.round(editor.ditherLevel * 100)}%</output>
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
