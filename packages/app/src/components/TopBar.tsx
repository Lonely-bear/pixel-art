import { useEffect, useRef, useState } from 'react';
import { useEditor } from '../editor-context.js';
import { useI18n } from '../i18n.js';
import { Icon, PixelMark } from './Icon.js';

const BUILTIN_PALETTES = ['dawnbringer16', 'endesga16', 'pico8', 'gameboy'] as const;

export function TopBar(): React.ReactNode {
  const editor = useEditor();
  const { detail, status } = editor;
  const { t, locale, setLocale } = useI18n();
  const [creating, setCreating] = useState(false);
  const [scale, setScale] = useState(1);
  const [gifTag, setGifTag] = useState('');
  const [name, setName] = useState<string | null>(null);
  const moreMenuRef = useRef<HTMLDetailsElement>(null);
  const exportMenuRef = useRef<HTMLDetailsElement>(null);

  // The File > New menu item forwards here through a window event.
  useEffect(() => {
    const open = () => setCreating(true);
    window.addEventListener('pixel:new-document', open);
    return () => window.removeEventListener('pixel:new-document', open);
  }, []);

  const closeMenu = (ref: React.RefObject<HTMLDetailsElement | null>) => {
    if (ref.current) ref.current.open = false;
  };

  return (
    <header className="top-bar">
      <div className="brand">
        <PixelMark />
        <div className="brand-copy">
          <strong>{t('brand.name')}</strong>
          <span>{t('brand.subtitle')}</span>
        </div>
      </div>

      <div className="document-cluster">
        <div className="document-select-wrap">
          <span className="document-status" data-dirty={detail?.dirty || undefined} />
          <select
            className="doc-select document-select"
            value={detail?.id ?? ''}
            onChange={(event) => void editor.selectDocument(event.target.value)}
            title={t('top.openDocuments')}
            aria-label={t('top.openDocuments')}
          >
            {status?.documents.map((doc) => (
              <option key={doc.id} value={doc.id}>
                {doc.name} · {doc.width}×{doc.height}
              </option>
            ))}
          </select>
        </div>

        {detail && (
          <div className="document-title-wrap">
            <span>{t('top.spriteName')}</span>
            <input
              className="doc-name"
              value={name ?? detail.name}
              spellCheck={false}
              title={t('top.spriteName')}
              aria-label={t('top.spriteName')}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => {
                const next = name?.trim();
                setName(null);
                if (next && next !== detail.name) void editor.renameDocument(next);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') {
                  setName(null);
                  event.currentTarget.blur();
                }
              }}
            />
          </div>
        )}
      </div>

      <nav className="top-actions" aria-label={t('brand.name')}>
        <div className="button-cluster">
          <button
            type="button"
            className="icon-button"
            onClick={() => setCreating(true)}
            title={t('top.new')}
            aria-label={t('top.new')}
          >
            <Icon name="plus" />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => void editor.openFile()}
            title={t('top.open')}
            aria-label={t('top.open')}
          >
            <Icon name="folder" />
          </button>
          <button
            type="button"
            className="icon-button is-accented"
            onClick={() => void editor.saveFile()}
            title={t('top.save')}
            aria-label={t('top.save')}
          >
            <Icon name="save" />
          </button>
        </div>

        <details className="menu-details" ref={moreMenuRef}>
          <summary className="icon-button" title={t('top.more')} aria-label={t('top.more')}>
            <Icon name="more" />
          </summary>
          <div className="menu-popover compact-menu">
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                closeMenu(moreMenuRef);
                void editor.saveFile(true);
              }}
            >
              <Icon name="save" />
              <span>{t('top.saveAs')}</span>
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                closeMenu(moreMenuRef);
                void editor.importImage();
              }}
            >
              <Icon name="image" />
              <span>{t('top.importPng')}</span>
            </button>
          </div>
        </details>

        <span className="divider" />

        <details className="menu-details" ref={exportMenuRef}>
          <summary className="export-trigger">
            <Icon name="export" size={17} />
            <span>{t('top.export')}</span>
            <Icon name="chevronDown" size={14} />
          </summary>
          <div className="menu-popover export-menu">
            <div className="menu-heading">
              <span>{t('top.export')}</span>
              <span className="menu-kicker">PNG · GIF · JSON</span>
            </div>
            <label className="export-scale-row">
              <span>{t('top.exportScale')}</span>
              <select value={scale} onChange={(event) => setScale(Number(event.target.value))}>
                {[1, 2, 3, 4, 6, 8, 10, 16].map((factor) => (
                  <option key={factor} value={factor}>
                    ×{factor}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                closeMenu(exportMenuRef);
                void editor.exportPng(scale);
              }}
            >
              <span className="menu-icon accent-icon"><Icon name="image" /></span>
              <span className="menu-item-copy">
                <strong>{t('top.exportPng')}</strong>
                <small>PNG · ×{scale}</small>
              </span>
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                closeMenu(exportMenuRef);
                void editor.exportSheet();
              }}
            >
              <span className="menu-icon"><Icon name="grid" /></span>
              <span className="menu-item-copy">
                <strong>{t('top.exportSheet')}</strong>
                <small>PNG + JSON</small>
              </span>
            </button>
            <div className="menu-subsection">
              <span>{t('top.exportGif')}</span>
              <select
                value={gifTag}
                title={t('frames.animationTag')}
                onChange={(event) => setGifTag(event.target.value)}
              >
                <option value="">{t('top.allFrames')}</option>
                {(detail?.tagList ?? []).map((tag) => (
                  <option key={tag.id} value={tag.name}>
                    {tag.name} · {tag.direction}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                closeMenu(exportMenuRef);
                void editor.exportGif(gifTag || undefined);
              }}
            >
              <span className="menu-icon"><Icon name="play" /></span>
              <span className="menu-item-copy">
                <strong>{t('top.exportGif')}</strong>
                <small>{gifTag || t('top.allFrames')}</small>
              </span>
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                closeMenu(exportMenuRef);
                void editor.exportTiled();
              }}
            >
              <span className="menu-icon"><Icon name="map" /></span>
              <span className="menu-item-copy">
                <strong>{t('top.exportTiled')}</strong>
                <small>.TMJ</small>
              </span>
            </button>
          </div>
        </details>

        <div className="button-cluster history-actions">
          <button
            type="button"
            className="icon-button"
            onClick={() => void editor.undo()}
            title={`${t('top.undo')} (Ctrl+Z)`}
            aria-label={t('top.undo')}
          >
            <Icon name="undo" />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => void editor.redo()}
            title={`${t('top.redo')} (Ctrl+Shift+Z)`}
            aria-label={t('top.redo')}
          >
            <Icon name="redo" />
          </button>
        </div>

        <div className="language-switch" role="group" aria-label={t('top.language')} title={t('top.language')}>
          <Icon name="globe" size={15} />
          <span className="language-label">{t('top.language')}</span>
          <button
            type="button"
            className={locale === 'zh-CN' ? 'active' : undefined}
            aria-label="中文"
            aria-pressed={locale === 'zh-CN'}
            onClick={() => setLocale('zh-CN')}
          >
            中文
          </button>
          <button
            type="button"
            className={locale === 'en' ? 'active' : undefined}
            aria-label="English"
            aria-pressed={locale === 'en'}
            onClick={() => setLocale('en')}
          >
            EN
          </button>
        </div>
      </nav>

      {creating && <NewDocumentDialog onClose={() => setCreating(false)} />}
    </header>
  );
}

function NewDocumentDialog({ onClose }: { onClose: () => void }): React.ReactNode {
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
        className="modal new-document-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-document-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title-row">
          <div className="modal-icon"><Icon name="plus" size={22} /></div>
          <div>
            <h2 id="new-document-title">{t('dialog.newSprite')}</h2>
            <p>{t('dialog.newSpriteHint')}</p>
          </div>
        </div>
        <div className="modal-grid">
          <label>
            <span>{t('dialog.width')}</span>
            <div className="unit-input">
              <input type="number" min={1} max={1024} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
              <em>px</em>
            </div>
          </label>
          <label>
            <span>{t('dialog.height')}</span>
            <div className="unit-input">
              <input type="number" min={1} max={1024} value={height} onChange={(e) => setHeight(Number(e.target.value))} />
              <em>px</em>
            </div>
          </label>
          <label className="wide">
            <span>{t('dialog.name')}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="wide">
            <span>{t('dialog.layers')}</span>
            <input value={layers} onChange={(e) => setLayers(e.target.value)} spellCheck={false} />
          </label>
          <label>
            <span>{t('dialog.frames')}</span>
            <input type="number" min={1} max={512} value={frames} onChange={(e) => setFrames(Number(e.target.value))} />
          </label>
          <label>
            <span>{t('dialog.frameMs')}</span>
            <div className="unit-input">
              <input type="number" min={10} step={10} value={duration} onChange={(e) => setDuration(Number(e.target.value))} />
              <em>ms</em>
            </div>
          </label>
          <label className="wide">
            <span>{t('dialog.palette')}</span>
            <select value={palette} onChange={(e) => setPalette(e.target.value)}>
              {BUILTIN_PALETTES.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
              <option value="none">{t('dialog.none')}</option>
            </select>
          </label>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            {t('dialog.cancel')}
          </button>
          <button type="button" className="primary-button" onClick={() => void submit()}>
            <Icon name="plus" size={16} />
            {t('dialog.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
