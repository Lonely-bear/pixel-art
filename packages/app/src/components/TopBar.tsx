import { useEffect, useState } from 'react';
import { useEditor } from '../editor-context.js';

const BUILTIN_PALETTES = ['dawnbringer16', 'endesga16', 'pico8', 'gameboy'] as const;

export function TopBar(): React.ReactNode {
  const editor = useEditor();
  const { detail, status } = editor;
  const [creating, setCreating] = useState(false);
  const [scale, setScale] = useState(1);
  const [gifTag, setGifTag] = useState('');
  const [name, setName] = useState('');

  // The File > New menu item forwards here through a window event.
  useEffect(() => {
    const open = () => setCreating(true);
    window.addEventListener('pixel:new-document', open);
    return () => window.removeEventListener('pixel:new-document', open);
  }, []);

  return (
    <header className="top-bar">
      <div className="brand">
        <span className="logo">▦</span>
        <span>Pixel Art</span>
      </div>

      <select
        className="doc-select"
        value={detail?.id ?? ''}
        onChange={(event) => void editor.selectDocument(event.target.value)}
        title="Open documents"
      >
        {status?.documents.map((doc) => (
          <option key={doc.id} value={doc.id}>
            {doc.name}
            {doc.dirty ? ' •' : ''} ({doc.width}×{doc.height})
          </option>
        ))}
      </select>

      {detail && (
        <input
          className="doc-name"
          value={name || detail.name}
          spellCheck={false}
          title="Sprite name"
          onChange={(event) => setName(event.target.value)}
          onBlur={() => {
            const next = name.trim();
            setName('');
            if (next && next !== detail.name) void editor.renameDocument(next);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
      )}

      <div className="top-actions">
        <button type="button" onClick={() => setCreating(true)}>
          New
        </button>
        <button type="button" onClick={() => void editor.openFile()}>
          Open
        </button>
        <button type="button" onClick={() => void editor.saveFile()}>
          Save
        </button>
        <button type="button" onClick={() => void editor.saveFile(true)}>
          Save as
        </button>
        <button type="button" onClick={() => void editor.importImage()}>
          Import PNG
        </button>

        <label className="scale-field" title="Export scale">
          <span>×</span>
          <select value={scale} onChange={(event) => setScale(Number(event.target.value))}>
            {[1, 2, 3, 4, 6, 8, 10, 16].map((factor) => (
              <option key={factor} value={factor}>
                {factor}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => void editor.exportPng(scale)}>
          Export PNG
        </button>
        <button type="button" onClick={() => void editor.exportSheet()}>
          Export sheet
        </button>

        <select
          className="doc-select"
          value={gifTag}
          onChange={(event) => setGifTag(event.target.value)}
          title="Animation tag to export"
        >
          <option value="">All frames</option>
          {(detail?.tagList ?? []).map((tag) => (
            <option key={tag.id} value={tag.name}>
              {tag.name} ({tag.direction})
            </option>
          ))}
        </select>
        <button type="button" onClick={() => void editor.exportGif(gifTag || undefined)}>
          Export GIF
        </button>
        <button type="button" title="Write a Tiled (.tmj) map" onClick={() => void editor.exportTiled()}>
          Export Tiled
        </button>

        <span className="divider" />
        <button type="button" title="Undo (Ctrl+Z)" onClick={() => void editor.undo()}>
          ↶
        </button>
        <button type="button" title="Redo (Ctrl+Shift+Z)" onClick={() => void editor.redo()}>
          ↷
        </button>
      </div>

      {creating && <NewDocumentDialog onClose={() => setCreating(false)} />}
    </header>
  );
}

function NewDocumentDialog({ onClose }: { onClose: () => void }): React.ReactNode {
  const editor = useEditor();
  const [width, setWidth] = useState(32);
  const [height, setHeight] = useState(32);
  const [name, setName] = useState('Sprite');
  const [layers, setLayers] = useState('base, shade, outline');
  const [frames, setFrames] = useState(1);
  const [duration, setDuration] = useState(120);
  const [palette, setPalette] = useState<string>('dawnbringer16');

  const submit = async () => {
    const layerNames = layers
      .split(',')
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
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h2>New sprite</h2>
        <div className="modal-grid">
          <label>
            <span>Width</span>
            <input type="number" min={1} max={1024} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
          </label>
          <label>
            <span>Height</span>
            <input type="number" min={1} max={1024} value={height} onChange={(e) => setHeight(Number(e.target.value))} />
          </label>
          <label className="wide">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="wide">
            <span>Layers (bottom first)</span>
            <input value={layers} onChange={(e) => setLayers(e.target.value)} spellCheck={false} />
          </label>
          <label>
            <span>Frames</span>
            <input type="number" min={1} max={512} value={frames} onChange={(e) => setFrames(Number(e.target.value))} />
          </label>
          <label>
            <span>Frame ms</span>
            <input type="number" min={10} step={10} value={duration} onChange={(e) => setDuration(Number(e.target.value))} />
          </label>
          <label className="wide">
            <span>Palette</span>
            <select value={palette} onChange={(e) => setPalette(e.target.value)}>
              {BUILTIN_PALETTES.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
              <option value="none">none</option>
            </select>
          </label>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => void submit()}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
