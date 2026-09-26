import { useEffect, useRef, useState } from 'react';
import { useEditor } from '../editor-context.js';
import { useResolvedTheme } from '../prefs.js';
import { useI18n } from '../i18n.js';
import { Icon } from './Icon.js';

/** How much the tileset preview and the tilemap grid are blown up. */
const PREVIEW_SCALE = 3;
const GRID_SCALE = 8;

/**
 * Tileset authoring: cut a tile sheet out of a layer, then paint a grid with it.
 * Both canvases draw from the same sheet, so what you see is what gets baked.
 */
export function TilemapPanel(): React.ReactNode {
  const editor = useEditor();
  const detail = editor.detail;
  const { t } = useI18n();
  const theme = useResolvedTheme();
  const { tilesetInfo, tilemapData, tilemapRef, activeTile } = editor;

  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const gridRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const draggingRef = useRef(false);
  const [imageReady, setImageReady] = useState(0);
  const [autoSet, setAutoSet] = useState<16 | 47>(47);
  const [autoOffset, setAutoOffset] = useState(0);

  // Selection ring colour comes from the theme; the bump on `imageReady` below
  // is what makes the preview redraw once it has been read.
  const accentRef = useRef('#fab283');
  const [accentVersion, setAccentVersion] = useState(0);
  useEffect(() => {
    accentRef.current =
      getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#fab283';
    setAccentVersion((n) => n + 1);
  }, [theme]);

  // The tileset arrives as a PNG so the renderer can draw it without knowing
  // anything about the core's buffer layout.
  useEffect(() => {
    if (!tilesetInfo) {
      imageRef.current = null;
      return;
    }
    // TS 5.7+ types `Uint8Array` over its backing buffer, which `BlobPart` will
    // not accept even though these bytes are an ordinary `ArrayBuffer`.
    const url = URL.createObjectURL(
      new Blob([tilesetInfo.png as unknown as BlobPart], { type: 'image/png' }),
    );
    const image = new Image();
    image.onload = () => {
      imageRef.current = image;
      setImageReady((count) => count + 1);
    };
    image.src = url;
    return () => URL.revokeObjectURL(url);
  }, [tilesetInfo]);

  // Tileset preview: the sheet, a grid over it, and the tile being painted with.
  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas || !tilesetInfo) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const tileWidth = tilesetInfo.tileWidth * PREVIEW_SCALE;
    const tileHeight = tilesetInfo.tileHeight * PREVIEW_SCALE;
    canvas.width = tilesetInfo.width * PREVIEW_SCALE;
    canvas.height = tilesetInfo.height * PREVIEW_SCALE;
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const image = imageRef.current;
    if (image) context.drawImage(image, 0, 0, canvas.width, canvas.height);

    context.strokeStyle = 'rgba(10, 11, 12, 0.18)';
    context.lineWidth = 1;
    for (let x = 0; x <= tilesetInfo.columns; x += 1) {
      context.beginPath();
      context.moveTo(x * tileWidth + 0.5, 0);
      context.lineTo(x * tileWidth + 0.5, canvas.height);
      context.stroke();
    }
    for (let y = 0; y <= tilesetInfo.rows; y += 1) {
      context.beginPath();
      context.moveTo(0, y * tileHeight + 0.5);
      context.lineTo(canvas.width, y * tileHeight + 0.5);
      context.stroke();
    }

    const column = activeTile % tilesetInfo.columns;
    const row = Math.floor(activeTile / tilesetInfo.columns);
    if (row < tilesetInfo.rows) {
      // The tileset itself is always light, so its grid stays dark in both
      // themes; only the selection ring follows the accent.
      context.strokeStyle = accentRef.current;
      context.lineWidth = 2;
      context.strokeRect(column * tileWidth + 1, row * tileHeight + 1, tileWidth - 2, tileHeight - 2);
    }
  }, [tilesetInfo, activeTile, imageReady, accentVersion]);

  // The tilemap itself, drawn from the sheet.
  useEffect(() => {
    const canvas = gridRef.current;
    if (!canvas || !tilemapData || !tilesetInfo) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    canvas.width = tilemapData.width * GRID_SCALE;
    canvas.height = tilemapData.height * GRID_SCALE;
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const image = imageRef.current;
    if (image) {
      for (let y = 0; y < tilemapData.height; y += 1) {
        for (let x = 0; x < tilemapData.width; x += 1) {
          const index = tilemapData.data[y * tilemapData.width + x];
          if (index < 0) continue;
          const column = index % tilesetInfo.columns;
          const row = Math.floor(index / tilesetInfo.columns);
          context.drawImage(
            image,
            column * tilesetInfo.tileWidth,
            row * tilesetInfo.tileHeight,
            tilesetInfo.tileWidth,
            tilesetInfo.tileHeight,
            x * GRID_SCALE,
            y * GRID_SCALE,
            GRID_SCALE,
            GRID_SCALE,
          );
        }
      }
    }
    context.strokeStyle = 'rgba(10, 11, 12, 0.16)';
    context.lineWidth = 1;
    for (let x = 0; x <= tilemapData.width; x += 1) {
      context.beginPath();
      context.moveTo(x * GRID_SCALE + 0.5, 0);
      context.lineTo(x * GRID_SCALE + 0.5, canvas.height);
      context.stroke();
    }
    for (let y = 0; y <= tilemapData.height; y += 1) {
      context.beginPath();
      context.moveTo(0, y * GRID_SCALE + 0.5);
      context.lineTo(canvas.width, y * GRID_SCALE + 0.5);
      context.stroke();
    }
  }, [tilemapData, tilesetInfo, imageReady]);

  if (!detail) return null;

  if (!detail.hasTileset || !tilesetInfo) {
    return (
      <div className="empty-state">
        <span className="empty-state-icon">
          <Icon name="grid" size={20} />
        </span>
        <b>{t('tilemap.noTileset')}</b>
        <p>{t('tilemap.noTilesetHelp')}</p>
        <button
          type="button"
          className="text-button is-block"
          disabled={!editor.layerId}
          onClick={() =>
            void editor.execute('create_tileset', {
              layer: editor.layerId,
              frame: editor.frameId,
              tileWidth: 16,
              tileHeight: 16,
            })
          }
        >
          <Icon name="grid" size={14} />
          {t('tilemap.create')}
        </button>
      </div>
    );
  }

  const pickTile = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left) / PREVIEW_SCALE / tilesetInfo.tileWidth);
    const y = Math.floor((event.clientY - rect.top) / PREVIEW_SCALE / tilesetInfo.tileHeight);
    if (x < 0 || y < 0 || x >= tilesetInfo.columns || y >= tilesetInfo.rows) return;
    editor.setActiveTile(y * tilesetInfo.columns + x);
  };

  const paintCell = (event: React.MouseEvent<HTMLCanvasElement>, erase: boolean) => {
    if (!tilemapData) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left) / GRID_SCALE);
    const y = Math.floor((event.clientY - rect.top) / GRID_SCALE);
    if (x < 0 || y < 0 || x >= tilemapData.width || y >= tilemapData.height) return;
    void editor.execute('set_tile', {
      tilemap: tilemapRef ?? 0,
      x,
      y,
      tile: erase ? -1 : activeTile,
    });
  };

  return (
    <>
      <div className="field-row">
        <span>{t('tilemap.map')}</span>
        <span className="spacer" />
        <select
          className="select"
          value={tilemapRef ?? ''}
          title={t('tilemap.map')}
          aria-label={t('tilemap.map')}
          onChange={(event) => editor.setTilemapRef(event.target.value || null)}
        >
          <option value="">{t('tilemap.none')}</option>
          {detail.tilemaps.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>

      <div className="tile-card">
        <div className="tile-head">
          <span>{t('tilemap.title')}</span>
          <span className="muted mono">
            {tilesetInfo.columns}×{tilesetInfo.rows}
          </span>
        </div>
        <canvas
          ref={previewRef}
          className="tileset-preview"
          onClick={pickTile}
          title={t('tilemap.pickTile')}
          aria-label={t('tilemap.pickTile')}
        />
        <p className="hint">
          {t('tilemap.activeTile', {
            index: activeTile,
            columns: tilesetInfo.columns,
            rows: tilesetInfo.rows,
          })}
        </p>
      </div>

      {tilemapData ? (
        <div className="tile-card">
          <div className="tile-head">
            <span>{t('tilemap.map')}</span>
            <span className="muted mono">
              {tilemapData.width}×{tilemapData.height}
            </span>
          </div>
          <canvas
            ref={gridRef}
            className="tilemap-grid"
            onMouseDown={(event) => {
              draggingRef.current = true;
              paintCell(event, event.button === 2);
            }}
            onMouseMove={(event) => {
              if (draggingRef.current) paintCell(event, event.buttons === 2);
            }}
            onMouseUp={() => {
              draggingRef.current = false;
            }}
            onMouseLeave={() => {
              draggingRef.current = false;
            }}
            onContextMenu={(event) => event.preventDefault()}
            title={t('tilemap.paintGrid')}
            aria-label={t('tilemap.paintGrid')}
          />
        </div>
      ) : (
        <p className="hint">{t('tilemap.chooseMap')}</p>
      )}

      <div className="field-row">
        <span>{t('tilemap.set')}</span>
        <span className="spacer" />
        <select
          className="select"
          style={{ width: 64, flex: '0 0 auto' }}
          value={autoSet}
          aria-label={t('tilemap.set')}
          onChange={(event) => setAutoSet(Number(event.target.value) === 16 ? 16 : 47)}
        >
          <option value={47}>47</option>
          <option value={16}>16</option>
        </select>
        <input
          className="input mono"
          type="number"
          min={0}
          style={{ width: 60, flex: '0 0 auto' }}
          value={autoOffset}
          aria-label={t('tilemap.offset')}
          onChange={(event) => setAutoOffset(Math.max(0, Number(event.target.value) || 0))}
        />
        <button
          type="button"
          className="text-button"
          title={t('tilemap.autotileHint')}
          disabled={!tilemapRef}
          onClick={() =>
            void editor.execute('autotile', { tilemap: tilemapRef ?? 0, set: autoSet, offset: autoOffset })
          }
        >
          <Icon name="sparkle" size={13} />
          {t('tilemap.autotile')}
        </button>
      </div>

      <div className="field-row">
        <button
          type="button"
          className="text-button"
          style={{ flex: 1 }}
          title={t('tilemap.bakeHint')}
          disabled={!tilemapRef || !editor.layerId}
          onClick={() =>
            void editor.execute('paint_tilemap', {
              tilemap: tilemapRef ?? 0,
              layer: editor.layerId,
              frame: editor.frameId,
            })
          }
        >
          <Icon name="image" size={13} />
          {t('tilemap.bake')}
        </button>
        <button
          type="button"
          className="text-button"
          style={{ flex: 1 }}
          title={t('top.exportTiled')}
          onClick={() => void editor.exportTiled()}
        >
          <Icon name="export" size={13} />
          Tiled
        </button>
        <button
          type="button"
          className="icon-button is-danger"
          title={t('tilemap.remove')}
          aria-label={t('tilemap.remove')}
          disabled={!tilemapRef}
          onClick={() => void editor.execute('remove_tilemap', { tilemap: tilemapRef ?? 0 })}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
    </>
  );
}
