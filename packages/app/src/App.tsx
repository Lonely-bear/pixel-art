import { useEffect } from 'react';
import { useEditor } from './editor-context.js';
import { api } from './api.js';
import { TopBar } from './components/TopBar.js';
import { Toolbar } from './components/Toolbar.js';
import { PixelCanvas } from './components/PixelCanvas.js';
import { LayersPanel } from './components/LayersPanel.js';
import { FramesPanel } from './components/FramesPanel.js';
import { HistoryPanel, PalettePanel } from './components/PalettePanel.js';
import { StatusBar } from './components/StatusBar.js';

const TOOL_KEYS: Record<string, string> = {
  b: 'pencil',
  e: 'eraser',
  l: 'line',
  r: 'rect',
  o: 'ellipse',
  f: 'fill',
  x: 'replace',
  i: 'eyedropper',
  h: 'pan',
};

export function App(): React.ReactNode {
  const editor = useEditor();
  const { ready, detail, notice } = editor;

  // Keyboard shortcuts. Ignored while typing in a field.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) void editor.redo();
        else void editor.undo();
        return;
      }
      if (event.ctrlKey || event.metaKey) return;

      if (key === 'tab') {
        event.preventDefault();
        editor.setSecondary(editor.primary);
        return;
      }
      if (key === '[') {
        editor.setBrushSize(Math.max(1, editor.brushSize - 1));
        return;
      }
      if (key === ']') {
        editor.setBrushSize(Math.min(8, editor.brushSize + 1));
        return;
      }
      if (key === '+' || key === '=') {
        editor.setZoom(Math.min(40, editor.zoom + 1));
        return;
      }
      if (key === '-' || key === '_') {
        editor.setZoom(Math.max(1, editor.zoom - 1));
        return;
      }
      const tool = TOOL_KEYS[key];
      if (tool) editor.setTool(tool as never);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editor]);

  // Menu accelerators forwarded from the main process.
  useEffect(() => {
    return api.onMenu((action) => {
      if (action === 'new') window.dispatchEvent(new CustomEvent('pixel:new-document'));
      if (action === 'open') void editor.openFile();
      if (action === 'save') void editor.saveFile();
      if (action === 'export') void editor.exportPng(4);
      if (action === 'sheet') void editor.exportSheet();
      if (action === 'undo') void editor.undo();
      if (action === 'redo') void editor.redo();
    });
  }, [editor]);

  if (!ready) {
    return <div className="boot">Starting the pixel editor…</div>;
  }

  return (
    <div className="app">
      <TopBar />
      {detail ? (
        <div className="workspace">
          <Toolbar />
          <main className="stage">
            <PixelCanvas />
            <FramesPanel />
          </main>
          <aside className="sidebar">
            <LayersPanel />
            <PalettePanel />
            <HistoryPanel />
          </aside>
        </div>
      ) : (
        <div className="boot">No document open.</div>
      )}
      <StatusBar />
      {notice && <div className={`toast ${notice.kind}`}>{notice.text}</div>}
    </div>
  );
}
