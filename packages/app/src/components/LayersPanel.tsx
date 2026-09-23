import { useState } from 'react';
import { useEditor } from '../editor-context.js';
import { rgbaToCss } from '../color-utils.js';

const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'add', 'replace'] as const;

export function LayersPanel(): React.ReactNode {
  const editor = useEditor();
  const detail = editor.detail;
  const [renaming, setRenaming] = useState<string | null>(null);

  if (!detail) return null;

  // The panel shows top layer first, which is the opposite of storage order.
  const layers = [...detail.layerList].reverse();
  const selectedIndex = detail.layerList.findIndex((layer) => layer.id === editor.layerId);

  const update = (layer: string, patch: Record<string, unknown>) =>
    void editor.execute('update_layer', { layer, ...patch });

  const move = (layer: string, index: number) =>
    void editor.execute('reorder_layer', { layer, index });

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>Layers</h2>
        <div className="panel-actions">
          <button type="button" title="Add layer" onClick={() => void editor.execute('add_layer', {})}>
            +
          </button>
          <button
            type="button"
            title="Duplicate layer"
            disabled={!editor.layerId}
            onClick={() => void editor.execute('duplicate_layer', { layer: editor.layerId })}
          >
            ⧉
          </button>
          <button
            type="button"
            title="Move up"
            disabled={selectedIndex < 0 || selectedIndex === detail.layerList.length - 1}
            onClick={() => move(editor.layerId!, selectedIndex + 1)}
          >
            ↑
          </button>
          <button
            type="button"
            title="Move down"
            disabled={selectedIndex <= 0}
            onClick={() => move(editor.layerId!, selectedIndex - 1)}
          >
            ↓
          </button>
          <button
            type="button"
            title="Merge into the layer below"
            disabled={selectedIndex <= 0}
            onClick={() => void editor.execute('merge_layer_down', { layer: editor.layerId })}
          >
            ⇓
          </button>
          <button
            type="button"
            title="Delete layer"
            disabled={detail.layerList.length <= 1}
            onClick={() => void editor.execute('remove_layer', { layer: editor.layerId })}
          >
            ✕
          </button>
        </div>
      </header>

      <ul className="layer-list">
        {layers.map((layer) => {
          const selected = layer.id === editor.layerId;
          return (
            <li key={layer.id} className={selected ? 'selected' : undefined}>
              <button
                type="button"
                className="eye"
                title={layer.visible ? 'Hide layer' : 'Show layer'}
                onClick={() => update(layer.id, { visible: !layer.visible })}
              >
                {layer.visible ? '👁' : '–'}
              </button>
              {renaming === layer.id ? (
                <input
                  className="layer-name-input"
                  autoFocus
                  defaultValue={layer.name}
                  onBlur={(event) => {
                    setRenaming(null);
                    if (event.target.value !== layer.name) update(layer.id, { name: event.target.value });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                    if (event.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="layer-name"
                  onClick={() => editor.setLayerId(layer.id)}
                  onDoubleClick={() => setRenaming(layer.id)}
                  title="Click to select, double-click to rename"
                >
                  <span
                    className="layer-chip"
                    style={{ background: rgbaToCss({ r: 90, g: 120, b: 200, a: 255 }, 0.5) }}
                  />
                  {layer.name}
                  {layer.locked && <em title="Locked">🔒</em>}
                </button>
              )}
              <select
                className="blend"
                value={layer.blendMode}
                title="Blend mode"
                onChange={(event) => update(layer.id, { blendMode: event.target.value })}
              >
                {BLEND_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
              <input
                className="opacity"
                type="range"
                min={0}
                max={100}
                value={Math.round(layer.opacity * 100)}
                title={`Opacity ${Math.round(layer.opacity * 100)}%`}
                onChange={(event) => update(layer.id, { opacity: Number(event.target.value) / 100 })}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
