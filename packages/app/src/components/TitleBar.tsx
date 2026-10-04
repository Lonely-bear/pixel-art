import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor } from '../editor-context.js';
import { api } from '../api.js';
import { useI18n } from '../i18n.js';
import { Icon, PixelMark, type IconName } from './Icon.js';
import { AssetBundleDialog } from './AssetBundleDialog.js';

const BUILTIN_PALETTES = ['dawnbringer16', 'endesga16', 'pico8', 'gameboy'] as const;

/**
 * The frameless title bar.
 *
 * Replaces both the OS frame and the application menu. The middle of the strip
 * is the window handle (`-webkit-app-region: drag` comes from the stylesheet);
 * everything interactive opts back out with `.no-drag`. The accelerators the
 * menu used to host are forwarded by the main process as commands instead.
 */
export function TitleBar({
  sidebarOpen,
  onToggleSidebar,
  onOpenSettings,
}: {
  sidebarOpen: boolean;
  onToggleSidebar(): void;
  onOpenSettings(): void;
}): React.ReactNode {
  const editor = useEditor();
  const { detail, status } = editor;
  const { t } = useI18n();
  const [creating, setCreating] = useState(false);
  const [assetOpen, setAssetOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);
  const barRef = useRef<HTMLElement | null>(null);

  // The window button glyph has to agree with the real window state, which the
  // main process owns; a double-click on the drag region can change it without
  // the renderer knowing.
  useEffect(() => api.onWindowState((state) => setMaximized(state.maximized)), []);

  useEffect(() => {
    const open = () => setCreating(true);
    window.addEventListener('pixel:new-document', open);
    return () => window.removeEventListener('pixel:new-document', open);
  }, []);

  const closePopovers = useCallback(() => {
    setExportOpen(false);
    setDocsOpen(false);
  }, []);
  useDismiss(barRef, closePopovers);

  const toggleMaximize = useCallback(() => {
    void api.windowCommand(maximized ? 'unmaximize' : 'maximize');
  }, [maximized]);

  return (
    <header className="title-bar" ref={barRef}>
      <div className="brand">
        <PixelMark size={20} />
        <span className="brand-name">dotloom</span>
      </div>

      <div className="divider" />

      <div className="doc-cluster">
        <span className="doc-dirty" data-clean={detail ? !detail.dirty : true} />
        {detail ? (
          <input
            className="doc-name"
            key={detail.id}
            defaultValue={detail.name}
            spellCheck={false}
            title={t('top.spriteName')}
            aria-label={t('top.spriteName')}
            onBlur={(event) => {
              const next = event.target.value.trim();
              if (next && next !== detail.name) void editor.renameDocument(next);
              else event.target.value = detail.name;
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') {
                event.currentTarget.value = detail.name;
                event.currentTarget.blur();
              }
            }}
          />
        ) : (
          <span className="doc-name muted">{t('app.noDocument')}</span>
        )}
        <span className="chip hide-narrow">
          {detail ? `${detail.width}×${detail.height}` : '—'}
        </span>

        <div className="popover-anchor">
          <button
            type="button"
            className="icon-button"
            onClick={() => setDocsOpen((open) => !open)}
            title={t('top.openDocuments')}
            aria-label={t('top.openDocuments')}
            aria-expanded={docsOpen}
          >
            <Icon name="chevronDown" size={14} />
          </button>
          {docsOpen && <DocumentMenu onPick={closePopovers} />}
        </div>
      </div>

      {/* Drag handle. Double-click is the platform convention for maximise. */}
      <div className="drag-region" onDoubleClick={toggleMaximize} />

      <div className="title-actions">
        <div className="button-cluster">
          <button
            type="button"
            className="icon-button"
            onClick={() => void editor.undo()}
            title={`${t('top.undo')} (Ctrl+Z)`}
            aria-label={t('top.undo')}
          >
            <Icon name="undo" size={15} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => void editor.redo()}
            title={`${t('top.redo')} (Ctrl+Shift+Z)`}
            aria-label={t('top.redo')}
          >
            <Icon name="redo" size={15} />
          </button>
        </div>

        <div className="divider" />

        <button
          type="button"
          className={`icon-button${sidebarOpen ? ' is-accent' : ''}`}
          onClick={onToggleSidebar}
          title={`${t('top.toggleSidebar')} (Ctrl+\\)`}
          aria-label={t('top.toggleSidebar')}
          aria-pressed={sidebarOpen}
        >
          <Icon name="sidebar" size={16} />
        </button>

        {/* Appearance lives in the settings dialog, so this is the only way in. */}
        <button
          type="button"
          className="icon-button"
          onClick={onOpenSettings}
          title={`${t('settings.open')} (Ctrl+,)`}
          aria-label={t('settings.open')}
        >
          <Icon name="settings" size={16} />
        </button>

        {/* Language and appearance both live in the settings dialog now. */}
        <div className="popover-anchor">
          <button
            type="button"
            className="pill is-accent"
            onClick={() => setExportOpen((open) => !open)}
            aria-expanded={exportOpen}
          >
            <Icon name="export" size={15} />
            <span className="hide-narrow">{t('top.export')}</span>
            <Icon name="chevronDown" size={12} />
          </button>
          {exportOpen && (
            <ExportMenu onPick={closePopovers} onOpenAsset={() => setAssetOpen(true)} />
          )}
        </div>
      </div>

      <div className="divider" />

      <div className="window-buttons">
        <button
          type="button"
          className="window-button"
          onClick={() => void api.windowCommand('minimize')}
          title={t('top.minimize')}
          aria-label={t('top.minimize')}
        >
          <Icon name="minimize" size={14} />
        </button>
        <button
          type="button"
          className="window-button"
          onClick={toggleMaximize}
          title={maximized ? t('top.restore') : t('top.maximize')}
          aria-label={maximized ? t('top.restore') : t('top.maximize')}
        >
          <Icon name={maximized ? 'restore' : 'maximize'} size={14} />
        </button>
        <button
          type="button"
          className="window-button is-close"
          onClick={() => void api.windowCommand('close')}
          title={t('top.close')}
          aria-label={t('top.close')}
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      {creating && <NewSpriteDialog onClose={() => setCreating(false)} />}
      {assetOpen && <AssetBundleDialog onClose={() => setAssetOpen(false)} />}
    </header>
  );
}

/** Close every open popover on an outside click or Escape. */
function useDismiss(ref: React.RefObject<HTMLElement | null>, close: () => void): void {
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [ref, close]);
}

function DocumentMenu({ onPick }: { onPick(): void }): React.ReactNode {
  const editor = useEditor();
  const { detail, status } = editor;
  const { t } = useI18n();

  return (
    <div className="popover title-popover" style={{ minWidth: 264 }} role="menu">
      <div className="popover-head">
        <span>{t('top.openDocuments')}</span>
        <span className="muted">{status?.documents.length ?? 0}</span>
      </div>
      <div className="popover-scroll">
        {(status?.documents ?? []).map((doc) => {
          const active = doc.id === detail?.id;
          return (
            <button
              key={doc.id}
              type="button"
              className={`popover-row${active ? ' is-active' : ''}`}
              role="menuitemradio"
              aria-checked={active}
              onClick={() => {
                if (!active) void editor.selectDocument(doc.id);
                onPick();
              }}
            >
              <span className="doc-thumb" />
              <span className="doc-row-name">{doc.name}</span>
              <span className="row-tail">
                {doc.width}×{doc.height}
              </span>
              {doc.dirty && <span className="doc-dirty" />}
            </button>
          );
        })}
      </div>
      <div className="popover-sep" />
      <button
        type="button"
        className="popover-row"
        onClick={() => {
          onPick();
          window.dispatchEvent(new CustomEvent('pixel:new-document'));
        }}
      >
        <span className="popover-tile is-small">
          <Icon name="plus" size={13} />
        </span>
        {t('top.new')}
        <span className="row-tail">Ctrl+N</span>
      </button>
      <button
        type="button"
        className="popover-row"
        onClick={() => {
          void editor.openFile();
          onPick();
        }}
      >
        <span className="popover-tile is-small">
          <Icon name="folder" size={13} />
        </span>
        {t('top.open')}
        <span className="row-tail">Ctrl+O</span>
      </button>
    </div>
  );
}

function ExportMenu({ onPick, onOpenAsset }: { onPick(): void; onOpenAsset(): void }): React.ReactNode {
  const editor = useEditor();
  const { detail } = editor;
  const { t } = useI18n();
  const [scale, setScale] = useState(1);
  const [gifTag, setGifTag] = useState('');

  return (
    <div className="popover title-popover" style={{ minWidth: 288 }} role="menu">
      <div className="popover-head">
        <span>{t('top.export')}</span>
        <span className="muted">PNG · GIF · JSON · TMJ</span>
      </div>
      <div className="popover-scale">
        <span>{t('top.exportScale')}</span>
        <span className="spacer" />
        <div className="seg" role="group" aria-label={t('top.exportScale')}>
          {[1, 2, 4, 8].map((value) => (
            <button
              key={value}
              type="button"
              className={value === scale ? 'is-active' : undefined}
              onClick={() => setScale(value)}
            >
              {value}×
            </button>
          ))}
        </div>
      </div>
      <ExportItem
        icon="image"
        accent
        title={t('top.exportPng')}
        meta={`PNG · ×${scale}`}
        shortcut="Ctrl+E"
        onClick={() => {
          void editor.exportPng(scale);
          onPick();
        }}
      />
      <ExportItem
        icon="grid"
        title={t('top.exportSheet')}
        meta={t('top.exportSheetMeta')}
        onClick={() => {
          void editor.exportSheet();
          onPick();
        }}
      />
      <div className="popover-scale">
        <span>{t('top.exportGif')}</span>
        <span className="spacer" />
        <select
          className="select"
          style={{ width: 132 }}
          value={gifTag}
          aria-label={t('frames.animationTag')}
          onChange={(event) => setGifTag(event.target.value)}
        >
          <option value="">{t('top.allFrames')}</option>
          {(detail?.tagList ?? []).map((tag) => (
            <option key={tag.id} value={tag.name}>
              {tag.name}
            </option>
          ))}
        </select>
      </div>
      <ExportItem
        icon="play"
        title={t('top.exportGif')}
        meta={gifTag || t('top.allFrames')}
        onClick={() => {
          void editor.exportGif(gifTag || undefined);
          onPick();
        }}
      />
      <ExportItem
        icon="map"
        title={t('top.exportTiled')}
        meta=".TMJ + tileset"
        onClick={() => {
          void editor.exportTiled();
          onPick();
        }}
      />
      <div className="popover-sep" />
      {/* The engine-agnostic asset contract, and the four engine importers. It
          takes a dialog of its own because a save dialog is involved and because
          an engine export has choices the other four do not: a sheet, and a
          folder for the importer's files. */}
      <ExportItem
        icon="stack"
        title={t('top.exportAsset')}
        meta={t('top.exportAssetMeta')}
        onClick={() => {
          onOpenAsset();
          onPick();
        }}
      />
      <ExportItem
        icon="save"
        title={t('top.saveAs')}
        shortcut="Ctrl+S"
        onClick={() => {
          void editor.saveFile(true);
          onPick();
        }}
      />
      <ExportItem
        icon="image"
        title={t('top.importPng')}
        onClick={() => {
          void editor.importImage();
          onPick();
        }}
      />
    </div>
  );
}

function ExportItem({
  icon,
  title,
  meta,
  shortcut,
  accent,
  onClick,
}: {
  icon: IconName;
  title: string;
  meta?: string;
  shortcut?: string;
  accent?: boolean;
  onClick(): void;
}): React.ReactNode {
  return (
    <button type="button" className="popover-item" role="menuitem" onClick={onClick}>
      <span className={`popover-tile${accent ? ' is-accent' : ''}`}>
        <Icon name={icon} size={16} />
      </span>
      <span className="popover-copy">
        <b>{title}</b>
        {meta && <span>{meta}</span>}
      </span>
      {shortcut && <span className="row-tail">{shortcut}</span>}
    </button>
  );
}

function NewSpriteDialog({ onClose }: { onClose(): void }): React.ReactNode {
  const editor = useEditor();
  const { t } = useI18n();
  const [width, setWidth] = useState(32);
  const [height, setHeight] = useState(32);
  const [name, setName] = useState('Sprite');
  const [layers, setLayers] = useState('base, shade, outline');
  const [frames, setFrames] = useState(1);
  const [duration, setDuration] = useState(120);
  const [palette, setPalette] = useState<string>('dawnbringer16');

  const submit = async () => {
    const layerNames = layers
      .split(/[,，]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    await editor.createDocument({
      width: Math.max(1, Math.min(1024, Math.round(width))),
      height: Math.max(1, Math.min(1024, Math.round(height))),
      name: name.trim() || 'Sprite',
      layers: layerNames.length > 0 ? layerNames : undefined,
      frames: Math.max(1, Math.min(512, Math.round(frames))),
      frameDurationMs: Math.max(10, Math.round(duration)),
      palette: palette === 'none' ? undefined : palette,
    });
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-sprite-title"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        <div className="modal-head">
          <span className="modal-icon">
            <Icon name="plus" size={20} />
          </span>
          <div>
            <h2 id="new-sprite-title">{t('dialog.newSprite')}</h2>
            <p>{t('dialog.newSpriteHint')}</p>
          </div>
        </div>

        <form
          className="modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="modal-row">
            <NumberField
              label={t('dialog.width')}
              value={width}
              unit="px"
              min={1}
              max={1024}
              onChange={setWidth}
            />
            <NumberField
              label={t('dialog.height')}
              value={height}
              unit="px"
              min={1}
              max={1024}
              onChange={setHeight}
            />
          </div>
          <TextField label={t('dialog.name')} value={name} onChange={setName} />
          <TextField
            label={t('dialog.layers')}
            value={layers}
            onChange={setLayers}
            spellCheck={false}
          />
          <div className="modal-row">
            <NumberField
              label={t('dialog.frames')}
              value={frames}
              min={1}
              max={512}
              onChange={setFrames}
            />
            <NumberField
              label={t('dialog.frameMs')}
              value={duration}
              unit="ms"
              min={10}
              max={10000}
              step={10}
              onChange={setDuration}
            />
          </div>
          <label className="modal-field">
            <span>{t('dialog.palette')}</span>
            <select
              className="select"
              style={{ height: 32 }}
              value={palette}
              onChange={(event) => setPalette(event.target.value)}
            >
              {BUILTIN_PALETTES.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
              <option value="none">{t('dialog.none')}</option>
            </select>
          </label>

          <div className="modal-actions">
            <button type="button" className="text-button" onClick={onClose}>
              {t('dialog.cancel')}
            </button>
            <button type="submit" className="text-button is-primary">
              <Icon name="plus" size={15} />
              {t('dialog.create')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  unit,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  unit?: string;
  min: number;
  max: number;
  step?: number;
  onChange(value: number): void;
}): React.ReactNode {
  return (
    <label className="modal-field">
      <span>{label}</span>
      <span className="input-wrap">
        <input
          className="input"
          type="number"
          min={min}
          max={max}
          step={step ?? 1}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        {unit && <em>{unit}</em>}
      </span>
    </label>
  );
}

function TextField({
  label,
  value,
  spellCheck,
  onChange,
}: {
  label: string;
  value: string;
  spellCheck?: boolean;
  onChange(value: string): void;
}): React.ReactNode {
  return (
    <label className="modal-field">
      <span>{label}</span>
      <input
        className="input"
        value={value}
        spellCheck={spellCheck}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
