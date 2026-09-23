import { useEffect, useRef, useState } from 'react';
import { useEditor } from '../editor-context.js';

/** How much the tileset preview and the tilemap grid are blown up. */
const PREVIEW_SCALE = 3;
const GRID_SCALE = 8;

export function TilemapPanel(): React.ReactNode {
  const editor = useEditor();
  const detail = editor.detail;
  const { tilesetInfo, tilemapData, tilemapRef, activeTile } = editor;

  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const gridRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const draggingRef = useRef(false);
  const [imageReady, setImageReady] = useState(0);
  const [autoSet, setAutoSet] = useState<16 | 47>(47);
  const [autoOffset, setAutoOffset] = useState(0);

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

  // Tileset preview: the sheet, a grid over it, and the tile you are painting with.
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

    context.strokeStyle = 'rgba(255, 255, 255, 0.14)';
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
      context.strokeStyle = '#4f8cff';
      context.lineWidth = 2;
      context.strokeRect(column * tileWidth + 1, row * tileHeight + 1, tileWidth - 2, tileHeight - 2);
    }
  }, [tilesetInfo, activeTile, imageReady]);

  // The tilemap itself, drawn from the sheet so what you see is what gets baked.
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
    context.strokeStyle = 'rgba(255, 255, 255, 0.12)';
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
      <section className="panel">
        <header className="panel-header">
          <h2>Tilemap</h2>
        </header>
        <p className="muted">
          No tileset yet. Cut one out of the layer you have drawn, then come back here to lay tiles.
        </p>
        <div className="panel-actions">
          <button
            type="button"
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
            Create a 16px tileset from this layer
          </button>
        </div>
      </section>
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
    <section className="panel">
      <header className="panel-header">
        <h2>Tilemap</h2>
        <div className="panel-actions">
          <button
            type="button"
            title="Add a tilemap"
            onClick={() =>
              void editor.execute('add_tilemap', {
                width: 16,
                height: 12,
                tileWidth: tilesetInfo.tileWidth,
                tileHeight: tilesetInfo.tileHeight,
              })
            }
          >
            +
          </button>
          <button
            type="button"
            title="Remove this tilemap"
            disabled={!tilemapRef}
            onClick={() => void editor.execute('remove_tilemap', { tilemap: tilemapRef ?? 0 })}
          >
            ✕
          </button>
          <button
            type="button"
            title="Paint the grid into the selected layer"
            disabled={!tilemapRef || !editor.layerId}
            onClick={() =>
              void editor.execute('paint_tilemap', {
                tilemap: tilemapRef ?? 0,
                layer: editor.layerId,
                frame: editor.frameId,
              })
            }
          >
            Bake
          </button>
          <button type="button" title="Export a Tiled (.tmj) map" onClick={() => void editor.exportTiled()}>
            Tiled
          </button>
        </div>
      </header>

      <label className="field">
        Tilemap
        <select
          className="doc-select"
          value={tilemapRef ?? ''}
          onChange={(event) => editor.setTilemapRef(event.target.value || null)}
        >
          <option value="">None</option>
          {detail.tilemaps.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>

      <canvas
        ref={previewRef}
        className="tileset-preview"
        onClick={pickTile}
        title="Click a tile to paint with it"
      />
      <p className="muted">
        Painting with tile {activeTile} · {tilesetInfo.columns}×{tilesetInfo.rows} sheet
      </p>

      {tilemapData ? (
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
          title="Left-click to paint, right-click to erase"
        />
      ) : (
        <p className="muted">Add or pick a tilemap to edit it.</p>
      )}

      <div className="panel-actions">
        <label className="field">
          Set
          <select
            className="doc-select"
            value={autoSet}
            onChange={(event) => setAutoSet(Number(event.target.value) === 16 ? 16 : 47)}
          >
            <option value={47}>47</option>
            <option value={16}>16</option>
          </select>
        </label>
        <label className="field">
          Offset
          <input
            type="number"
            min={0}
            value={autoOffset}
            onChange={(event) => setAutoOffset(Math.max(0, Number(event.target.value) || 0))}
          />
        </label>
        <button
          type="button"
          title="Pick transition tiles from the terrain already laid down"
          disabled={!tilemapRef}
          onClick={() =>
            void editor.execute('autotile', { tilemap: tilemapRef ?? 0, set: autoSet, offset: autoOffset })
          }
        >
          Autotile
        </button>
      </div>
    </section>
  );
}
