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

const invoke = <T,>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

const api = {
  listDocuments: () => invoke('pixel:list-documents'),
  status: () => invoke('pixel:status'),
  selectDocument: (id: string) => invoke('pixel:select-document', id),
  createDocument: (options: Record<string, unknown>) => invoke('pixel:create-document', options),
  closeDocument: (id: string) => invoke('pixel:close-document', id),
  documentDetail: (id?: string) => invoke('pixel:document-detail', id),
  preview: (id: string | undefined, request: Record<string, unknown>) =>
    invoke('pixel:preview', id, request),
  execute: (id: string | undefined, name: string, params: unknown, opts?: Record<string, unknown>) =>
    invoke('pixel:execute', id, name, params, opts),
  undo: (id: string | undefined, steps?: number) => invoke('pixel:undo', id, steps),
  redo: (id: string | undefined, steps?: number) => invoke('pixel:redo', id, steps),
  history: (id: string | undefined, limit?: number) => invoke('pixel:history', id, limit),
  openFile: () => invoke('pixel:open-file'),
  saveFile: (id?: string) => invoke('pixel:save-file', id),
  saveFileAs: (id?: string) => invoke('pixel:save-file-as', id),
  exportPng: (id: string | undefined, options: Record<string, unknown>) =>
    invoke('pixel:export-png', id, options),
  exportSheet: (id: string | undefined, options: Record<string, unknown>) =>
    invoke('pixel:export-sheet', id, options),
  exportGif: (id: string | undefined, options: Record<string, unknown>) =>
    invoke('pixel:export-gif', id, options),
  exportTiled: (id: string | undefined, options: Record<string, unknown>) =>
    invoke('pixel:export-tiled', id, options),
  tilesetInfo: (id: string | undefined) => invoke('pixel:tileset-info', id),
  tilemapData: (id: string | undefined, tilemap: string | number) =>
    invoke('pixel:tilemap-data', id, tilemap),
  animationSequence: (id: string | undefined, tag?: string | number) =>
    invoke('pixel:animation-sequence', id, tag),
  importImage: () => invoke('pixel:import-image'),
  mcpStatus: () => invoke('pixel:mcp-status'),

  /** Subscribe to document changes, including edits made by an agent. */
  onChanged: (handler: (payload: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => handler(payload);
    ipcRenderer.on('pixel:changed', listener);
    return () => ipcRenderer.removeListener('pixel:changed', listener);
  },
  /** Subscribe to menu accelerators forwarded from the main process. */
  onMenu: (handler: (action: string) => void) => {
    const listener = (_event: unknown, action: string) => handler(action);
    ipcRenderer.on('pixel:menu', listener);
    return () => ipcRenderer.removeListener('pixel:menu', listener);
  },
};

contextBridge.exposeInMainWorld('pixel', api);
