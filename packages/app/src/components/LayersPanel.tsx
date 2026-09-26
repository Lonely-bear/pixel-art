import { useState } from 'react';
import { useEditor } from '../editor-context.js';
import { useI18n, type TranslationKey } from '../i18n.js';
import { Icon } from './Icon.js';

const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'add', 'replace'] as const;

/**
 * Layer list plus the properties of whichever layer is selected.
 *
 * Blend and opacity used to sit on every row, which made a three-layer document
 * three times taller than it needed to be. They now describe only the selection.
 */
export function LayersPanel(): React.ReactNode {
  const editor = useEditor();
  const detail = editor.detail;
  const { t } = useI18n();
  const [renaming, setRenaming] = useState<string | null>(null);

  if (!detail) return null;

  // Top layer first, which is the opposite of storage order.
  const layers = [...detail.layerList].reverse();
  const selected = detail.layerList.find((layer) => layer.id === editor.layerId) ?? null;

  const update = (layer: string, patch: Record<string, unknown>) =>
    void editor.execute('update_layer', { layer, ...patch });

  return (
    <>
      <ul className="layer-list">
        {layers.map((layer) => {
          const active = layer.id === editor.layerId;
          return (
            <li key={layer.id} className={`layer-row${active ? ' is-selected' : ''}`}>
              <span className="layer-ind" aria-hidden="true" />
              <button
                type="button"
                className="icon-button"
                title={layer.visible ? t('layers.hide') : t('layers.show')}
                aria-label={layer.visible ? t('layers.hide') : t('layers.show')}
                aria-pressed={layer.visible}
                onClick={() => update(layer.id, { visible: !layer.visible })}
              >
                <Icon name={layer.visible ? 'eye' : 'eyeOff'} size={14} />
              </button>
              {renaming === layer.id ? (
                <input
                  className="layer-input"
                  autoFocus
                  defaultValue={layer.name}
                  onBlur={(event) => {
                    setRenaming(null);
                    const next = event.target.value.trim();
                    if (next && next !== layer.name) update(layer.id, { name: next });
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
                  aria-pressed={active}
                >
                  <span className="layer-chip" aria-hidden="true" />
                  <span className="layer-name-text">{layer.name}</span>
                </button>
              )}
              {layer.locked && (
                <span className="icon-button" style={{ width: 18, height: 18 }} title={t('layers.locked')}>
                  <Icon name="lock" size={12} />
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {selected && (
        <div className="layer-props">
          <div className="field-row">
            <span className="muted">{t('layers.blendMode')}</span>
            <select
              className="select"
              value={selected.blendMode}
              title={t('layers.blendMode')}
              aria-label={t('layers.blendMode')}
              onChange={(event) => update(selected.id, { blendMode: event.target.value })}
            >
              {BLEND_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {t(`blend.${mode}` as TranslationKey)}
                </option>
              ))}
            </select>
          </div>
          <div className="meter">
            <div className="meter-head">
              <span>{t('layers.opacity')}</span>
              <span className="meter-value">{Math.round(selected.opacity * 100)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(selected.opacity * 100)}
              aria-label={t('layers.opacity')}
              onChange={(event) => update(selected.id, { opacity: Number(event.target.value) / 100 })}
            />
          </div>
        </div>
      )}
    </>
  );
}
