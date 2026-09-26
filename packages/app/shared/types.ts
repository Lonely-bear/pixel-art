/**
 * Types shared between the Electron main process and the React renderer.
 *
 * Mostly type-only: the renderer bundles its own copy through Vite, and the main
 * process compiles the types away. The only runtime value here is the channel
 * table, which must be identical on both sides so they cannot drift apart.
 * The main process is the only writer; the renderer only ever reads.
 */

/**
 * The five locales the UI ships with. The order matches the language menu, and
 * `LocaleMeta` in the renderer keeps the display names next to these codes.
 */
export const APP_LOCALES = ['en', 'ja', 'ko', 'zh-CN', 'zh-TW'] as const;

export type AppLocale = (typeof APP_LOCALES)[number];

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === 'string' && (APP_LOCALES as readonly string[]).includes(value);
}

export type ToolId =
  | 'pencil'
  | 'eraser'
  | 'line'
  | 'rect'
  | 'ellipse'
  | 'fill'
  | 'replace'
  | 'eyedropper'
  | 'select'
  | 'pan';

/** A canvas-pixel rectangle, 0-based, y growing downward. */
export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The region the user has boxed on the canvas.
 *
 * Mirrors `SelectionState` in `@pixel/mcp`, which is where it actually lives: the
 * window draws it and the agent reads it, and both go through the one shared
 * `DocumentStore`. It is session state, so it never reaches the `.pixel` file.
 */
export interface SelectionState {
  rect: PixelRect;
  layerId?: string;
  frameId?: string;
  /**
   * `hint` tells the agent where the subject is; `enforce` also confines its writes.
   * The UI defaults to `hint` because a hard clip would cut off an edit like
   * "make the head in this box bigger".
   */
  mode: 'hint' | 'enforce';
  updatedAt: number;
}

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
  layerCount: number;
  /** Frame count. */
  frameCount: number;
  /** Tag count. */
  tagCount: number;
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
  /** The user's current box, if any. Session state; never persisted. */
  selection?: SelectionState;
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

/**
 * Why an installed build cannot update itself.
 *
 * Not a failure state: every one of these is a deliberate outcome, and the UI
 * has something useful to say about each (open the releases page, use your
 * package manager, install it properly). They are separate cases rather than one
 * "unsupported" flag because the advice differs.
 */
export type UpdateUnavailableReason = 'dev' | 'portable' | 'package-manager' | 'unsigned-mac';

/** What the user chose about checking for updates. Persisted in userData. */
export interface UpdateSettings {
  /** Check in the background and announce, never download unasked. */
  autoCheck: boolean;
  /** A version the user said to stop asking about. */
  skippedVersion?: string;
  /** Epoch ms of the last check that got as far as talking to GitHub. */
  lastCheckedAt?: number;
  /**
   * Release notes fetched once and kept, so re-opening the banner (or switching
   * language) does not spend another request.
   */
  notesVersion?: string;
  notesBody?: string;
}

/**
 * The updater, as one serialisable snapshot.
 *
 * The main process owns the state machine; the renderer only renders whatever
 * this says and sends intents back. Every variant carries what the UI needs to
 * draw itself, so the renderer never has to guess a percentage or a next step.
 */
export type UpdateState =
  /** Nothing has happened yet, or something finished and reset. */
  | { status: 'idle' }
  | { status: 'checking' }
  /** A version the user has been told about and is already on. */
  | { status: 'up-to-date'; version: string }
  /** Found, but the user asked to stop hearing about this one. */
  | { status: 'ignored'; version: string }
  | {
      status: 'available';
      version: string;
      /** ISO date of the release, when the feed carried one. */
      date?: string;
      /** Installer size in bytes, for a decision about waiting. */
      bytes?: number;
      notes?: string;
    }
  /** Bytes, not a percentage: a mac update is several files and the ratio jumps. */
  | { status: 'downloading'; transferred: number; total: number; bytesPerSecond: number }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string; retryable: boolean }
  | { status: 'unsupported'; reason: UpdateUnavailableReason };

/** Everything the renderer needs to draw the update UI, in one object. */
export interface UpdateSnapshot {
  /** `app.getVersion()` — the build that is running, not the one wanted. */
  currentVersion: string;
  /**
   * Whether this build was signed. Only a hint for the UI; it decides nothing.
   * See `resolveUpdateSupport` for where it actually matters.
   */
  codeSigned: boolean;
  settings: UpdateSettings;
  state: UpdateState;
  /** Where "get it yourself" goes for the builds that cannot self-update. */
  releasePage: string;
}

/** Pushed to every window whenever settings or state change. */
export interface UpdateEvent {
  settings: UpdateSettings;
  state: UpdateState;
}

/** Channel names, in one place so main and preload cannot drift apart. */
export const CHANNELS = {
  listDocuments: 'pixel:list-documents',
  selectDocument: 'pixel:select-document',
  createDocument: 'pixel:create-document',
  closeDocument: 'pixel:close-document',
  documentDetail: 'pixel:document-detail',
  /** Box a region on the canvas, or clear the box. */
  selection: 'pixel:selection',
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
  tilesetInfo: 'pixel:tileset-info',
  tilemapData: 'pixel:tilemap-data',
  animationSequence: 'pixel:animation-sequence',
  importImage: 'pixel:import-image',
  mcpStatus: 'pixel:mcp-status',
  setLocale: 'pixel:set-locale',
  /** The whole updater snapshot, so a window that opens late is never blank. */
  updateSnapshot: 'pixel:update-snapshot',
  updateSaveSettings: 'pixel:update-save-settings',
  updateCheck: 'pixel:update-check',
  updateDownload: 'pixel:update-download',
  /** Guarded by the main process: it is the only side that knows about files. */
  updateInstall: 'pixel:update-install',
  /** Pass a version to skip it, or null to start asking about every version. */
  updateSkip: 'pixel:update-skip',
  updateOpenRelease: 'pixel:update-open-release',
  /** Pushed whenever the updater's state or settings change. */
  updateEvent: 'pixel:update-event',
  status: 'pixel:status',
  changed: 'pixel:changed',
  /** Frameless-window buttons: minimize / maximize / unmaximize / close. */
  windowCommand: 'pixel:window-command',
  /** Pushed whenever the window is maximized or restored. */
  windowState: 'pixel:window-state',
  /**
   * Accelerators the main process owns now that there is no application menu to
   * host them. Same idea as the old `pixel:menu`, without the menu.
   */
  command: 'pixel:command',
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
 * The frame order for one animation tag, resolved by `@pixel/core`'s
 * `animationSequence` so the canvas plays exactly what the GIF export writes.
 */
export interface AnimationSequenceInfo {
  name: string | null;
  /** Frame IDs in playback order, already expanded for direction and repeat. */
  frameIds: string[];
  /** Duration of each entry in `frameIds`, in milliseconds. */
  durations: number[];
  durationMs: number;
  loops: boolean;
}

export interface TilesetInfo {
  id: string;
  name: string;
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
  width: number;
  height: number;
  /** The tileset image, encoded as a PNG so the renderer can draw it. */
  png: Uint8Array;
}

export interface TilemapInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  /** Row-major tile indices, `-1` for an empty cell. */
  data: number[];
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
  /**
   * Box a region for the agent, or clear it. Pass `null` for `rect` to clear.
   * Returns the stored selection, or `null` when there is none.
   */
  setSelection(
    id: string | undefined,
    rect: PixelRect | null,
    mode?: SelectionState['mode'],
    scope?: { layerId?: string; frameId?: string },
  ): Promise<SelectionState | null>;
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
  tilesetInfo(id: string | undefined): Promise<TilesetInfo | null>;
  tilemapData(id: string | undefined, tilemap: string | number): Promise<TilemapInfo | null>;
  animationSequence(id: string | undefined, tag?: string | number): Promise<AnimationSequenceInfo>;
  importImage(): Promise<DocumentDetail | null>;
  mcpStatus(): Promise<McpStatus>;
  setLocale(locale: AppLocale): Promise<void>;
  updateSnapshot(): Promise<UpdateSnapshot>;
  /** Staged by the settings dialog, written the moment a checkbox moves. */
  saveUpdateSettings(patch: Partial<UpdateSettings>): Promise<UpdateSnapshot>;
  /** `automatic` only tells the main process whether a failure should be quiet. */
  checkForUpdates(automatic?: boolean): Promise<void>;
  downloadUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  skipVersion(version: string | null): Promise<void>;
  openReleasePage(): Promise<void>;
  onUpdateEvent(handler: (event: UpdateEvent) => void): () => void;
  /** Drive the frameless window's own buttons. */
  windowCommand(action: 'minimize' | 'maximize' | 'unmaximize' | 'close'): Promise<void>;
  onChanged(handler: (payload: ChangedPayload) => void): () => void;
  /** Accelerators forwarded from the main process, since no menu owns them. */
  onCommand(handler: (action: string) => void): () => void;
  onWindowState(handler: (state: { maximized: boolean }) => void): () => void;
}

