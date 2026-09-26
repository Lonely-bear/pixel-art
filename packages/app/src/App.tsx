import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor } from './editor-context.js';
import { useI18n } from './i18n.js';
import { api } from './api.js';
import { TitleBar } from './components/TitleBar.js';
import { ToolRail } from './components/ToolRail.js';
import { PixelCanvas } from './components/PixelCanvas.js';
import { Timeline } from './components/Timeline.js';
import { Sidebar } from './components/Sidebar.js';
import { StatusBar } from './components/StatusBar.js';
import { SettingsDialog } from './components/SettingsDialog.js';

const TOOL_KEYS: Record<string, string> = {
  b: 'pencil',
  e: 'eraser',
  l: 'line',
  r: 'rect',
  o: 'ellipse',
  f: 'fill',
  x: 'replace',
  i: 'eyedropper',
  m: 'select',
  h: 'pan',
};

/**
 * Below this the sidebar is more liability than help: the rail plus the artboard
 * still leaves room to work, so the window drops into focus mode by itself.
 * Only a *crossing* of the threshold changes the state, so a deliberate toggle
 * at either size is never overridden.
 */
const SIDEBAR_AUTO_HIDE = 1080;

export function App(): React.ReactNode {
  const editor = useEditor();
  const { t } = useI18n();
  const { ready, detail, notice } = editor;
  const [sidebarOpen, setSidebarOpen] = useState(
    () => window.innerWidth >= SIDEBAR_AUTO_HIDE,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const wasNarrow = useRef(window.innerWidth < SIDEBAR_AUTO_HIDE);

  const toggleSidebar = useCallback(() => setSidebarOpen((open) => !open), []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  // Keyboard shortcuts. Ignored while typing in a field.
  //
  // Ctrl-chords are deliberately absent: the main process claims every one of
  // them through `before-input-event` and forwards the intent over IPC. Handling
  // them here as well would run the action twice — Ctrl+Z really did pop two
  // steps off the history.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const key = event.key.toLowerCase();

      if (key === 'tab') {
        event.preventDefault();
        editor.setSecondary(editor.primary);
        editor.setPrimary(editor.secondary);
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

  // The Ctrl-chords the removed menu bar used to own, forwarded by the main
  // process.
  useEffect(() => {
    return api.onCommand((action) => {
      if (action === 'new') window.dispatchEvent(new CustomEvent('pixel:new-document'));
      if (action === 'open') void editor.openFile();
      if (action === 'save') void editor.saveFile();
      if (action === 'export') void editor.exportPng(1);
      if (action === 'undo') void editor.undo();
      if (action === 'redo') void editor.redo();
      if (action === 'toggle-sidebar') toggleSidebar();
      if (action === 'settings') openSettings();
    });
  }, [editor, toggleSidebar, openSettings]);

  // Auto-collapse on a threshold crossing only.
  useEffect(() => {
    const onResize = () => {
      const narrow = window.innerWidth < SIDEBAR_AUTO_HIDE;
      if (narrow === wasNarrow.current) return;
      wasNarrow.current = narrow;
      setSidebarOpen(!narrow);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (!ready) {
    return (
      <div className="boot">
        <div className="boot-mark" />
        <b>{t('app.starting')}</b>
      </div>
    );
  }

  return (
    <div className="app">
      <TitleBar
        sidebarOpen={sidebarOpen}
        onToggleSidebar={toggleSidebar}
        onOpenSettings={openSettings}
      />

      <div className="body">
        {detail && <ToolRail />}

        <main className="stage">
          {detail ? (
            <>
              <PixelCanvas />
              <Timeline />
            </>
          ) : (
            <div className="boot">{t('app.noDocument')}</div>
          )}
        </main>

        {detail && <Sidebar hidden={!sidebarOpen} />}
      </div>

      <StatusBar />

      {notice && (
        <div className={`toast${notice.kind === 'error' ? ' is-error' : ''}`} role="status">
          <span className="toast-dot" aria-hidden="true" />
          {notice.text}
        </div>
      )}

      {settingsOpen && <SettingsDialog onClose={closeSettings} />}
    </div>
  );
}
