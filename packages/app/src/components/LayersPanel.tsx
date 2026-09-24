import { useState } from 'react';
import { useEditor } from '../editor-context.js';
import { rgbaToCss } from '../color-utils.js';
import { useI18n, type TranslationKey } from '../i18n.js';
import { Icon } from './Icon.js';

const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'add', 'replace'] as const;

export function LayersPanel(): React.ReactNode {
  const editor = useEditor();
  const detail = editor.detail;
  const { t } = useI18n();
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
    <section className="panel layers-panel">
      <header className="panel-header">
        <div className="panel-title">
          <span className="panel-title-icon"><Icon name="grid" size={15} /></span>
          <h2>{t('layers.title')}</h2>
          <span className="count-badge">{detail.layerList.length}</span>
        </div>
        <div className="panel-actions">
          <button
            type="button"
            className="panel-icon-button"
            title={t('layers.add')}
            aria-label={t('layers.add')}
            onClick={() => void editor.execute('add_layer', {})}
          >
            <Icon name="plus" size={16} />
          </button>
          <button
            type="button"
            className="panel-icon-button"
            title={t('layers.duplicate')}
            aria-label={t('layers.duplicate')}
            disabled={!editor.layerId}
            onClick={() => void editor.execute('duplicate_layer', { layer: editor.layerId })}
          >
            <Icon name="copy" size={15} />
          </button>
          <button
            type="button"
            className="panel-icon-button"
            title={t('layers.up')}
            aria-label={t('layers.up')}
            disabled={selectedIndex < 0 || selectedIndex === detail.layerList.length - 1}
            onClick={() => move(editor.layerId!, selectedIndex + 1)}
          >
            <Icon name="arrowUp" size={15} />
          </button>
          <button
            type="button"
            className="panel-icon-button"
            title={t('layers.down')}
            aria-label={t('layers.down')}
            disabled={selectedIndex <= 0}
            onClick={() => move(editor.layerId!, selectedIndex - 1)}
          >
            <Icon name="arrowDown" size={15} />
          </button>
          <button
            type="button"
            className="panel-icon-button"
            title={t('layers.merge')}
            aria-label={t('layers.merge')}
            disabled={selectedIndex <= 0}
            onClick={() => void editor.execute('merge_layer_down', { layer: editor.layerId })}
          >
            <Icon name="merge" size={15} />
          </button>
          <button
            type="button"
            className="panel-icon-button danger"
            title={t('layers.delete')}
            aria-label={t('layers.delete')}
            disabled={detail.layerList.length <= 1}
            onClick={() => void editor.execute('remove_layer', { layer: editor.layerId })}
          >
            <Icon name="trash" size={15} />
          </button>
        </div>
      </header>

      <ul className="layer-list">
        {layers.map((layer) => {
          const selected = layer.id === editor.layerId;
          return (
            <li key={layer.id} className={selected ? 'selected' : undefined}>
              <div className="layer-main">
                <button
                  type="button"
                  className="layer-visibility"
                  title={layer.visible ? t('layers.hide') : t('layers.show')}
                  aria-label={layer.visible ? t('layers.hide') : t('layers.show')}
                  onClick={() => update(layer.id, { visible: !layer.visible })}
                >
                  <Icon name={layer.visible ? 'eye' : 'eyeOff'} size={15} />
                </button>
                {renaming === layer.id ? (
                  <input
                    className="layer-name-input"
                    autoFocus
                    defaultValue={layer.name}
                    onBlur={(event) => {
                      setRenaming(null);
                      if (event.target.value.trim() && event.target.value !== layer.name) {
                        update(layer.id, { name: event.target.value.trim() });
                      }
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
                    title={t('layers.selectRename')}
                    aria-pressed={selected}
                  >
                    <span
                      className="layer-chip"
                      style={{ background: rgbaToCss({ r: 99, g: 102, b: 241, a: 255 }, 0.72) }}
                    />
                    <span className="layer-name-text">{layer.name}</span>
                    {layer.locked && (
                      <span className="layer-lock" title={t('layers.locked')}>
                        <Icon name="lock" size={12} />
                      </span>
                    )}
                  </button>
                )}
                <span className="layer-opacity-value">{Math.round(layer.opacity * 100)}%</span>
              </div>
              <div className="layer-controls">
                <select
                  className="blend"
                  value={layer.blendMode}
                  title={t('layers.blendMode')}
                  aria-label={t('layers.blendMode')}
                  onChange={(event) => update(layer.id, { blendMode: event.target.value })}
                >
                  {BLEND_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {t(`blend.${mode}` as TranslationKey)}
                    </option>
                  ))}
                </select>
                <input
                  className="opacity"
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(layer.opacity * 100)}
                  title={`${t('layers.opacity')}: ${Math.round(layer.opacity * 100)}%`}
                  aria-label={t('layers.opacity')}
                  onChange={(event) => update(layer.id, { opacity: Number(event.target.value) / 100 })}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
