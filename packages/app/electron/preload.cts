/**
 * The bridge. Runs sandboxed with context isolation, so the renderer can never
 * reach `ipcRenderer` or Node — only the fixed list of calls below.
 *
 * A sandboxed preload can only `require('electron')`, so the channel names are
 * spelled out here rather than imported. `electron/ipc.ts` registers the
 * handlers with the same strings from `shared/types.ts`; a typo shows up
 * immediately as "No handler registered for ...", so the two cannot drift
 * silently.
 */
import { contextBridge, ipcRenderer } from 'electron';
// Type-only, so it is erased at compile time and the preload still only requires
// electron at runtime. `api` is checked against `PixelApi` at the bottom, which is
// what forces this file and `shared/types.ts` to agree.
import type {
  AnimationSequenceInfo,
  AppLocale,
  AppStatus,
  AssetEngine,
  AssetExportRequest,
  AssetExportResult,
  ChangedPayload,
  DocumentDetail,
  DocumentSummary,
  ExecResult,
  ExportResult,
  HistoryEntry,
  McpStatus,
  PixelApi,
  PixelRect,
  PreviewRequest,
  PreviewResult,
  SelectionState,
  TilesetInfo,
  TilemapInfo,
  UndoResult,
  UpdateEvent,
  UpdateSettings,
  UpdateSnapshot,
} from '../shared/types.js';

const invoke = <T,>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

const api = {
  listDocuments: () => invoke<DocumentSummary[]>('pixel:list-documents'),
  status: () => invoke<AppStatus>('pixel:status'),
  selectDocument: (id: string) => invoke<DocumentSummary>('pixel:select-document', id),
  createDocument: (options: Record<string, unknown>) =>
    invoke<DocumentDetail>('pixel:create-document', options),
  closeDocument: (id: string) => invoke<DocumentSummary[]>('pixel:close-document', id),
  documentDetail: (id?: string) => invoke<DocumentDetail>('pixel:document-detail', id),
  setSelection: (
    id: string | undefined,
    rect: PixelRect | null,
    mode?: SelectionState['mode'],
    scope?: { layerId?: string; frameId?: string },
  ) => invoke<SelectionState | null>('pixel:selection', id, rect, mode, scope),
  preview: (id: string | undefined, request: PreviewRequest) =>
    invoke<PreviewResult>('pixel:preview', id, request),
  execute: (id: string | undefined, name: string, params: unknown, opts?: Record<string, unknown>) =>
    invoke<ExecResult>('pixel:execute', id, name, params, opts),
  undo: (id: string | undefined, steps?: number) => invoke<UndoResult>('pixel:undo', id, steps),
  redo: (id: string | undefined, steps?: number) => invoke<UndoResult>('pixel:redo', id, steps),
  history: (id: string | undefined, limit?: number) =>
    invoke<HistoryEntry[]>('pixel:history', id, limit),
  openFile: () => invoke<DocumentDetail | null>('pixel:open-file'),
  saveFile: (id?: string) => invoke<{ path: string } | null>('pixel:save-file', id),
  saveFileAs: (id?: string) => invoke<{ path: string } | null>('pixel:save-file-as', id),
  exportPng: (id: string | undefined, options: Record<string, unknown>) =>
    invoke<ExportResult | null>('pixel:export-png', id, options),
  exportSheet: (id: string | undefined, options: Record<string, unknown>) =>
    invoke<ExportResult | null>('pixel:export-sheet', id, options),
  exportGif: (id: string | undefined, options: Record<string, unknown>) =>
    invoke<ExportResult | null>('pixel:export-gif', id, options),
  exportTiled: (id: string | undefined, options: Record<string, unknown>) =>
    invoke<ExportResult | null>('pixel:export-tiled', id, options),
  
  exportMeta: (id: string | undefined, options: AssetExportRequest) =>
    invoke<AssetExportResult | null>('pixel:export-meta', id, options),
  exportEngine: (id: string | undefined, engine: AssetEngine, options: AssetExportRequest) =>
    invoke<AssetExportResult | null>('pixel:export-engine', id, engine, options),
  tilesetInfo: (id: string | undefined) => invoke<TilesetInfo | null>('pixel:tileset-info', id),
  tilemapData: (id: string | undefined, tilemap: string | number) =>
    invoke<TilemapInfo | null>('pixel:tilemap-data', id, tilemap),
  animationSequence: (id: string | undefined, tag?: string | number) =>
    invoke<AnimationSequenceInfo>('pixel:animation-sequence', id, tag),
  importImage: () => invoke<DocumentDetail | null>('pixel:import-image'),
  mcpStatus: () => invoke<McpStatus>('pixel:mcp-status'),

  // Updates. Every call returns the resulting snapshot where there is one, so
  // the renderer can paint the answer without waiting for the pushed event.
  updateSnapshot: () => invoke<UpdateSnapshot>('pixel:update-snapshot'),
  saveUpdateSettings: (patch: Partial<UpdateSettings>) =>
    invoke<UpdateSnapshot>('pixel:update-save-settings', patch),
  checkForUpdates: (automatic?: boolean) => invoke<void>('pixel:update-check', automatic),
  downloadUpdate: () => invoke<void>('pixel:update-download'),
  installUpdate: () => invoke<void>('pixel:update-install'),
  skipVersion: (version: string | null) => invoke<void>('pixel:update-skip', version),
  openReleasePage: () => invoke<void>('pixel:update-open-release'),
  onUpdateEvent: (handler: (event: UpdateEvent) => void) => {
    const listener = (_event: unknown, payload: UpdateEvent) => handler(payload);
    ipcRenderer.on('pixel:update-event', listener);
    return () => ipcRenderer.removeListener('pixel:update-event', listener);
  },
  setLocale: (locale: AppLocale) => {
    // The native file dialogs subscribe to this broadcast so their titles and
    // button labels follow the UI. Intentionally fire-and-forget.
    ipcRenderer.send('pixel:set-locale', locale);
    return Promise.resolve();
  },
  /** Drive the frameless window's own title-bar buttons. */
  windowCommand: (action: 'minimize' | 'maximize' | 'unmaximize' | 'close') =>
    invoke<void>('pixel:window-command', action),

  /** Subscribe to document changes, including edits made by an agent. */
  onChanged: (handler: (payload: ChangedPayload) => void) => {
    const listener = (_event: unknown, payload: ChangedPayload) => handler(payload);
    ipcRenderer.on('pixel:changed', listener);
    return () => ipcRenderer.removeListener('pixel:changed', listener);
  },
  /**
   * Subscribe to the accelerators the main process owns. There is no
   * application menu left to route them, so they arrive here directly.
   */
  onCommand: (handler: (action: string) => void) => {
    const listener = (_event: unknown, action: string) => handler(action);
    ipcRenderer.on('pixel:command', listener);
    return () => ipcRenderer.removeListener('pixel:command', listener);
  },
  /** Subscribe to maximize/restore so the window-button glyph stays honest. */
  onWindowState: (handler: (state: { maximized: boolean }) => void) => {
    const listener = (_event: unknown, state: { maximized: boolean }) => handler(state);
    ipcRenderer.on('pixel:window-state', listener);
    return () => ipcRenderer.removeListener('pixel:window-state', listener);
  },
};

const typed: PixelApi = api;
contextBridge.exposeInMainWorld('pixel', typed);
