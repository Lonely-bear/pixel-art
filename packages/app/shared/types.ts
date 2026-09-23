/**
 * Types shared between the Electron main process and the React renderer.
 *
 * Mostly type-only: the renderer bundles its own copy through Vite, and the main
 * process compiles the types away. The only runtime value here is the channel
 * table, which must be identical on both sides so they cannot drift apart.
 * The main process is the only writer; the renderer only ever reads.
 */

export type ToolId =
  | 'pencil'
  | 'eraser'
  | 'line'
  | 'rect'
  | 'ellipse'
  | 'fill'
  | 'replace'
  | 'eyedropper'
  | 'pan';

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface DocumentSummary {
  id: string;
  name: string;
  path?: string;
  width: number;
  height: number;
  /** Layer count. */
  layers: number;
  /** Frame count. */
  frames: number;
  /** Tag count. */
  tags: number;
  version: number;
  dirty: boolean;
  active: boolean;
}

export interface LayerInfo {
  index: number;
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: string;
}

export interface FrameInfo {
  index: number;
  id: string;
  durationMs: number;
  /** IDs of the layers that actually have a cel on this frame. */
  layers: string[];
}

export interface TagInfo {
  id: string;
  name: string;
  from: number;
  to: number;
  direction: string;
  repeat: number;
}

export interface DocumentDetail extends DocumentSummary {
  layerList: LayerInfo[];
  frameList: FrameInfo[];
  tagList: TagInfo[];
  palette: { name: string; colors: Rgba[] };
  celCount: number;
  durationMs: number;
  hasTileset: boolean;
  tilemaps: string[];
}

export interface PreviewRequest {
  /** Frame index or frame id. Defaults to the first frame. */
  frame?: number | string;
  /** Composite with every layer at full opacity, ignoring visibility. */
  flatten?: boolean;
  /** Background colour as hex, or null for transparent. */
  background?: string | null;
}

export interface PreviewResult {
  version: number;
  width: number;
  height: number;
  /** PNG bytes for the composited frame. */
  png: Uint8Array;
}

export interface ExecResult {
  ok: boolean;
  summary?: Record<string, unknown>;
  error?: string;
  code?: string;
  version: number;
}

export interface HistoryEntry {
  label: string;
  command: string;
  summary: Record<string, unknown>;
}

export interface McpStatus {
  running: boolean;
  url?: string;
  port?: number;
  error?: string;
}

export interface AppStatus {
  documents: DocumentSummary[];
  activeId?: string;
  mcp: McpStatus;
  /** Absolute path of the .pixel file backing the active document, if saved. */
  filePath?: string;
}

/** Channel names, in one place so main and preload cannot drift apart. */
export const CHANNELS = {
  listDocuments: 'pixel:list-documents',
  selectDocument: 'pixel:select-document',
  createDocument: 'pixel:create-document',
  closeDocument: 'pixel:close-document',
  documentDetail: 'pixel:document-detail',
  preview: 'pixel:preview',
  execute: 'pixel:execute',
  applyOps: 'pixel:apply-ops',
  undo: 'pixel:undo',
  redo: 'pixel:redo',
  history: 'pixel:history',
  openFile: 'pixel:open-file',
  saveFile: 'pixel:save-file',
  saveFileAs: 'pixel:save-file-as',
  exportPng: 'pixel:export-png',
  exportSheet: 'pixel:export-sheet',
  exportGif: 'pixel:export-gif',
  exportTiled: 'pixel:export-tiled',
  importImage: 'pixel:import-image',
  mcpStatus: 'pixel:mcp-status',
  status: 'pixel:status',
  changed: 'pixel:changed',
} as const;

export interface ChangedPayload {
  activeId?: string;
  documents: DocumentSummary[];
}

export interface UndoResult {
  undone?: number;
  redone?: number;
  version: number;
}

export interface ExportResult {
  path: string;
  json?: string;
  width?: number;
  height?: number;
  /** Frames written, for an animation export. */
  frames?: number;
  /** Tile count of the exported tileset. */
  tiles?: number;
  /** Tilemap layer names, for a Tiled export. */
  layers?: string[];
}

/**
 * The exact object the preload script exposes as `window.pixel`.
 *
 * Declared here (types only) so the renderer can be typed without importing
 * anything from Electron, while the preload script is forced to match.
 */
export interface PixelApi {
  listDocuments(): Promise<DocumentSummary[]>;
  status(): Promise<AppStatus>;
  selectDocument(id: string): Promise<DocumentSummary>;
  createDocument(options: Record<string, unknown>): Promise<DocumentDetail>;
  closeDocument(id: string): Promise<DocumentSummary[]>;
  documentDetail(id?: string): Promise<DocumentDetail>;
  preview(id: string | undefined, request: PreviewRequest): Promise<PreviewResult>;
  execute(
    id: string | undefined,
    name: string,
    params: unknown,
    opts?: Record<string, unknown>,
  ): Promise<ExecResult>;
  undo(id: string | undefined, steps?: number): Promise<UndoResult>;
  redo(id: string | undefined, steps?: number): Promise<UndoResult>;
  history(id: string | undefined, limit?: number): Promise<HistoryEntry[]>;
  openFile(): Promise<DocumentDetail | null>;
  saveFile(id?: string): Promise<{ path: string } | null>;
  saveFileAs(id?: string): Promise<{ path: string } | null>;
  exportPng(id: string | undefined, options: Record<string, unknown>): Promise<ExportResult | null>;
  exportSheet(id: string | undefined, options: Record<string, unknown>): Promise<ExportResult | null>;
  exportGif(id: string | undefined, options: Record<string, unknown>): Promise<ExportResult | null>;
  exportTiled(id: string | undefined, options: Record<string, unknown>): Promise<ExportResult | null>;
  importImage(): Promise<DocumentDetail | null>;
  mcpStatus(): Promise<McpStatus>;
  onChanged(handler: (payload: ChangedPayload) => void): () => void;
  onMenu(handler: (action: string) => void): () => void;
}

