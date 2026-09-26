import { useState, type ReactNode } from 'react';
import { useEditor } from '../editor-context.js';
import { rgbaToHex } from '../color-utils.js';
import { useI18n, type TranslationKey } from '../i18n.js';
import { Icon, type IconName } from './Icon.js';
import { LayersPanel } from './LayersPanel.js';
import { PalettePanel, HistoryPanel } from './PalettePanel.js';
import { BrushPanel } from './BrushPanel.js';
import { TagsPanel } from './TagsPanel.js';
import { TilemapPanel } from './TilemapPanel.js';

/**
 * Tilemap starts shut: until a document has a tileset the editor is three rows
 * of "nothing here yet", and an empty section is worse than a closed one.
 */
const DEFAULTS: Record<string, boolean> = {
  layers: true,
  palette: true,
  brush: true,
  tags: true,
  tilemap: false,
  history: true,
};

function ToolButton({
  icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: IconName;
  label: string;
  onClick(): void;
  disabled?: boolean;
  danger?: boolean;
}): React.ReactNode {
  return (
    <button
      type="button"
      className={`icon-button${danger ? ' is-danger' : ''}`}
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}

function Section({
  id,
  icon,
  title,
  count,
  tools,
  children,
}: {
  id: string;
  icon: IconName;
  title: TranslationKey;
  count?: number;
  tools?: ReactNode;
  children: ReactNode;
}): React.ReactNode {
  const { t } = useI18n();
  const [open, setOpen] = useState(DEFAULTS[id] ?? true);

  return (
    <section className={`section${open ? ' is-open' : ''}`}>
      <div className="section-head">
        <Icon name={icon} size={13} />
        <h2 className="section-title">{t(title)}</h2>
        {count !== undefined && <span className="section-count">{count}</span>}
        {tools ? <div className="section-tools">{tools}</div> : null}
        <button
          type="button"
          className="section-chevron"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-label={t(title)}
          title={t(title)}
        >
          <Icon name="chevronRight" size={13} />
        </button>
      </div>
      <div className="section-body">{children}</div>
    </section>
  );
}

/**
 * The right column: one scroll container, one collapsible section per concern.
 * The count in a header means a collapsed section still says what is inside it.
 */
export function Sidebar({ hidden }: { hidden: boolean }): React.ReactNode {
  const editor = useEditor();
  const { detail } = editor;
  const { t } = useI18n();

  return (
    // `display: none` while hidden, so the hidden column costs no width and
    // swallows no clicks on the canvas edge.
    <aside className={`sidebar${hidden ? ' is-hidden' : ''}`}>
      <Section
        id="layers"
        icon="stack"
        title="layers.title"
        count={detail?.layerList.length}
        tools={
          <>
            <ToolButton
              icon="plus"
              label={t('layers.add')}
              onClick={() => void editor.execute('add_layer', {})}
            />
            <ToolButton
              icon="copy"
              label={t('layers.duplicate')}
              disabled={!editor.layerId}
              onClick={() => void editor.execute('duplicate_layer', { layer: editor.layerId })}
            />
            <ToolButton
              icon="mergeDown"
              label={t('layers.merge')}
              disabled={!editor.layerId}
              onClick={() => void editor.execute('merge_layer_down', { layer: editor.layerId })}
            />
            <ToolButton
              icon="trash"
              label={t('layers.delete')}
              danger
              disabled={!editor.layerId}
              onClick={() => void editor.execute('remove_layer', { layer: editor.layerId })}
            />
          </>
        }
      >
        <LayersPanel />
      </Section>

      <Section
        id="palette"
        icon="paint"
        title="palette.title"
        count={detail?.palette.colors.length}
        tools={
          <>
            <ToolButton
              icon="sparkle"
              label={t('palette.quantizeHint')}
              onClick={() => void editor.execute('quantize_to_palette', { dither: 'none' })}
            />
            <ToolButton
              icon="plus"
              label={t('palette.add')}
              onClick={() =>
                void editor.execute('add_palette_color', { color: rgbaToHex(editor.primary) })
              }
            />
          </>
        }
      >
        <PalettePanel />
      </Section>

      <Section id="brush" icon="sliders" title="brush.title">
        <BrushPanel />
      </Section>

      <Section id="tags" icon="tag" title="tags.title" count={detail?.tagList.length}>
        <TagsPanel />
      </Section>

      <Section
        id="tilemap"
        icon="map"
        title="tilemap.title"
        tools={
          <ToolButton
            icon="plus"
            label={t('tilemap.add')}
            onClick={() => void editor.execute('add_tilemap', { width: 16, height: 12 })}
          />
        }
      >
        <TilemapPanel />
      </Section>

      <Section
        id="history"
        icon="clock"
        title="history.title"
        tools={
          <>
            <ToolButton icon="undo" label={t('history.undo')} onClick={() => void editor.undo()} />
            <ToolButton icon="redo" label={t('history.redo')} onClick={() => void editor.redo()} />
          </>
        }
      >
        <HistoryPanel />
      </Section>
    </aside>
  );
}
