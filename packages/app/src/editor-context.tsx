/**
 * One place that owns everything the UI reads or writes.
 *
 * The renderer never keeps its own copy of the document: it asks the main
 * process for a composited PNG and re-asks whenever a change is announced. That
 * is what makes an agent's edit show up here instantly — the agent is writing to
 * the same store, and the same `changed` broadcast fires either way.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  AppStatus,
  DocumentDetail,
  ExecResult,
  AnimationSequenceInfo,
  HistoryEntry,
  Rgba as Color,
  TilemapInfo,
  TilesetInfo,
  ToolId,
} from '../shared/types.js';
import { api } from './api.js';

export interface Notice {
  kind: 'info' | 'error';
  text: string;
}

export interface EditorValue {
  ready: boolean;
  status: AppStatus | null;
  detail: DocumentDetail | null;
  bitmap: ImageBitmap | null;
  thumbnails: Map<string, string>;
  historyEntries: HistoryEntry[];

  layerId: string | null;
  setLayerId(id: string): void;
  frameId: string | null;
  setFrameId(id: string): void;

  tool: ToolId;
  setTool(tool: ToolId): void;
  primary: Color;
  setPrimary(color: Color): void;
  secondary: Color;
  setSecondary(color: Color): void;
  brushSize: number;
  setBrushSize(size: number): void;
  fillShapes: boolean;
  setFillShapes(value: boolean): void;
  zoom: number;
  setZoom(zoom: number): void;

  cursor: { x: number; y: number } | null;
  setCursor(position: { x: number; y: number } | null): void;
  hoverColor: Color | null;

  notice: Notice | null;
  setNotice(notice: Notice | null): void;

  execute(name: string, params?: Record<string, unknown>): Promise<ExecResult | null>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  refreshHistory(): Promise<void>;

  openFile(): Promise<void>;
  saveFile(forceDialog?: boolean): Promise<void>;
  exportPng(scale: number): Promise<void>;
  exportSheet(): Promise<void>;
  playing: boolean;
  setPlaying(playing: boolean): void;
  playTag: string;
  setPlayTag(tag: string): void;
  playSpeed: number;
  setPlaySpeed(speed: number): void;
  onionSkin: boolean;
  setOnionSkin(on: boolean): void;
  onionBefore: number;
  setOnionBefore(count: number): void;
  onionAfter: number;
  setOnionAfter(count: number): void;
  sequence: AnimationSequenceInfo | null;
  tilesetInfo: TilesetInfo | null;
  tilemapData: TilemapInfo | null;
  tilemapRef: string | null;
  setTilemapRef(ref: string | null): void;
  activeTile: number;
  setActiveTile(index: number): void;
  clip: 'none' | 'cel' | 'composite';
  setClip(clip: 'none' | 'cel' | 'composite'): void;
  ditherPattern: string;
  setDitherPattern(pattern: string): void;
  ditherLevel: number;
  setDitherLevel(level: number): void;
  exportGif(tag?: string): Promise<void>;
  exportTiled(): Promise<void>;
  importImage(): Promise<void>;
  createDocument(options: Record<string, unknown>): Promise<void>;
  selectDocument(id: string): Promise<void>;
  closeDocument(id: string): Promise<void>;
  renameDocument(name: string): Promise<void>;
}

const EditorContext = createContext<EditorValue | null>(null);

export function useEditor(): EditorValue {
  const value = useContext(EditorContext);
  if (!value) throw new Error('useEditor must be used inside <EditorProvider>');
  return value;
}

const DEFAULT_PRIMARY: Color = { r: 0xe4, g: 0x3b, b: 0x44, a: 255 };
const DEFAULT_SECONDARY: Color = { r: 0x14, g: 0x16, b: 0x1c, a: 255 };

export function EditorProvider({ children }: { children: ReactNode }): ReactNode {
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [thumbnails, setThumbnails] = useState<Map<string, string>>(new Map());
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);

  const [layerId, setLayerId] = useState<string | null>(null);
  const [frameId, setFrameId] = useState<string | null>(null);
  const [tool, setTool] = useState<ToolId>('pencil');
  const [primary, setPrimary] = useState<Color>(DEFAULT_PRIMARY);
  const [secondary, setSecondary] = useState<Color>(DEFAULT_SECONDARY);
  const [brushSize, setBrushSize] = useState(1);
  const [fillShapes, setFillShapes] = useState(false);
  const [zoom, setZoom] = useState(12);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  // Playback. The frame order comes from the same `animationSequence` the GIF
  // export uses, so what plays on the canvas is exactly what gets written.
  const [playing, setPlaying] = useState(false);
  const [playTag, setPlayTag] = useState('');
  const [playSpeed, setPlaySpeed] = useState(1);
  const [onionSkin, setOnionSkin] = useState(false);
  const [onionBefore, setOnionBefore] = useState(1);
  const [onionAfter, setOnionAfter] = useState(0);
  const [sequence, setSequence] = useState<AnimationSequenceInfo | null>(null);
  const playIndexRef = useRef(0);

  // Tilemap editing. The tileset image and the raw cell indices are not part of
  // the document summary, so they come from their own calls.
  const [tilesetInfo, setTilesetInfo] = useState<TilesetInfo | null>(null);
  const [tilemapData, setTilemapData] = useState<TilemapInfo | null>(null);
  const [tilemapRef, setTilemapRef] = useState<string | null>(null);
  const [activeTile, setActiveTile] = useState(0);

  // Painting constraints. `clip` keeps a shape inside the silhouette the other
  // layers define, and the dither pattern stipples every write instead of laying
  // paint down solid.
  const [clip, setClip] = useState<'none' | 'cel' | 'composite'>('none');
  const [ditherPattern, setDitherPattern] = useState('');
  const [ditherLevel, setDitherLevel] = useState(0.5);

  const activeIdRef = useRef<string | undefined>(undefined);
  const frameIdRef = useRef<string | null>(null);
  const previewToken = useRef(0);
  const thumbnailUrls = useRef<string[]>([]);

  frameIdRef.current = frameId;

  const loadPreview = useCallback(async (documentId: string | undefined, frame?: string | null) => {
    const token = (previewToken.current += 1);
    try {
      const result = await api.preview(documentId, frame ? { frame } : {});
      if (token !== previewToken.current) return;
      const blob = new Blob([result.png as unknown as BlobPart], { type: 'image/png' });
      const next = await createImageBitmap(blob);
      if (token !== previewToken.current) {
        next.close();
        return;
      }
      setBitmap((previous) => {
        previous?.close();
        return next;
      });
    } catch (error) {
      setNotice({ kind: 'error', text: `Preview failed: ${describeError(error)}` });
    }
  }, []);

  const loadThumbnails = useCallback(async (documentId: string | undefined, frames: string[]) => {
    const urls: string[] = [];
    const next = new Map<string, string>();
    for (const id of frames) {
      try {
        const result = await api.preview(documentId, { frame: id });
        const url = URL.createObjectURL(
          new Blob([result.png as unknown as BlobPart], { type: 'image/png' }),
        );
        urls.push(url);
        next.set(id, url);
      } catch {
        // A frame that fails to render simply has no thumbnail.
      }
    }
    for (const url of thumbnailUrls.current) URL.revokeObjectURL(url);
    thumbnailUrls.current = urls;
    setThumbnails(next);
  }, []);

  const refresh = useCallback(
    async (options: { thumbnails?: boolean } = {}) => {
      const documentId = activeIdRef.current;
      const next = await api.documentDetail(documentId);
      setDetail(next);
      activeIdRef.current = next.id;

      // Keep the selection valid across structural changes (undo, agent edits).
      setLayerId((current) => {
        if (current && next.layerList.some((layer) => layer.id === current)) return current;
        return next.layerList[next.layerList.length - 1]?.id ?? null;
      });
      setFrameId((current) => {
        if (current && next.frameList.some((frame) => frame.id === current)) return current;
        return next.frameList[0]?.id ?? null;
      });

      await loadPreview(next.id, frameIdRef.current);
      if (options.thumbnails) {
        await loadThumbnails(
          next.id,
          next.frameList.map((frame) => frame.id),
        );
      }
    },
    [loadPreview, loadThumbnails],
  );

  // Initial load.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const next = await api.status();
        if (!alive) return;
        setStatus(next);
        activeIdRef.current = next.activeId;
        await refresh({ thumbnails: true });
      } catch (error) {
        setNotice({ kind: 'error', text: `Could not open the editor: ${describeError(error)}` });
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);

  // React to edits from anywhere: this window, another window, or an agent.
  useEffect(() => {
    return api.onChanged((payload) => {
      setStatus((current) => (current ? { ...current, documents: payload.documents, activeId: payload.activeId } : current));
      const switched = payload.activeId !== activeIdRef.current;
      activeIdRef.current = payload.activeId;
      void refresh({ thumbnails: true }).then(() => {
        if (switched) void api.status().then(setStatus);
      });
    });
  }, [refresh]);

  // The active frame changed: re-render just the preview.
  useEffect(() => {
    if (!frameId) return;
    void loadPreview(activeIdRef.current, frameId);
  }, [frameId, loadPreview]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Keep the playback sequence in step with the document and the chosen tag.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void api
      .animationSequence(activeIdRef.current, playTag || undefined)
      .then((next) => {
        if (!cancelled) setSequence(next);
      })
      .catch(() => {
        if (!cancelled) setSequence(null);
      });
    return () => {
      cancelled = true;
    };
  }, [ready, playTag, detail]);

  // A timeout chain rather than an interval, because each frame can carry its own
  // duration.
  useEffect(() => {
    if (!playing || !sequence || sequence.frameIds.length === 0) return;
    let cancelled = false;
    let timer = 0;
    const step = () => {
      if (cancelled) return;
      const total = sequence.frameIds.length;
      const index = playIndexRef.current >= total ? 0 : playIndexRef.current;
      setFrameId(sequence.frameIds[index]);
      const wait = Math.max(16, (sequence.durations[index] ?? 100) / Math.max(0.1, playSpeed));
      const next = index + 1;
      if (next >= total && !sequence.loops) {
        playIndexRef.current = total;
        timer = window.setTimeout(() => setPlaying(false), wait);
        return;
      }
      playIndexRef.current = next >= total ? 0 : next;
      timer = window.setTimeout(step, wait);
    };
    playIndexRef.current = 0;
    step();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [playing, sequence, playSpeed]);

  // Keep the tileset and the selected tilemap in step with the document. Both
  // effects key off `detail`, which `refresh()` bumps after every command, so an
  // edit anywhere re-reads them.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void api
      .tilesetInfo(activeIdRef.current)
      .then((next) => {
        if (!cancelled) setTilesetInfo(next);
      })
      .catch(() => {
        if (!cancelled) setTilesetInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [ready, detail]);

  useEffect(() => {
    if (!ready || !tilemapRef) {
      setTilemapData(null);
      return;
    }
    let cancelled = false;
    void api
      .tilemapData(activeIdRef.current, tilemapRef)
      .then((next) => {
        if (!cancelled) setTilemapData(next);
      })
      .catch(() => {
        if (!cancelled) setTilemapData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [ready, detail, tilemapRef]);

  const refreshHistory = useCallback(async () => {
    try {
      setHistoryEntries(await api.history(activeIdRef.current, 40));
    } catch {
      setHistoryEntries([]);
    }
  }, []);

  const execute = useCallback(
    async (name: string, params: Record<string, unknown> = {}): Promise<ExecResult | null> => {
      try {
        const result = await api.execute(activeIdRef.current, name, params);
        if (!result.ok) {
          setNotice({ kind: 'error', text: `${name}: ${result.error ?? 'failed'}` });
          return result;
        }
        await refresh();
        void refreshHistory();
        return result;
      } catch (error) {
        setNotice({ kind: 'error', text: `${name}: ${describeError(error)}` });
        return null;
      }
    },
    [refresh, refreshHistory],
  );

  const undo = useCallback(async () => {
    await api.undo(activeIdRef.current, 1);
    await refresh({ thumbnails: true });
    void refreshHistory();
  }, [refresh, refreshHistory]);

  const redo = useCallback(async () => {
    await api.redo(activeIdRef.current, 1);
    await refresh({ thumbnails: true });
    void refreshHistory();
  }, [refresh, refreshHistory]);

  const openFile = useCallback(async () => {
    const opened = await api.openFile();
    if (!opened) return;
    activeIdRef.current = opened.id;
    setStatus(await api.status());
    await refresh({ thumbnails: true });
    void refreshHistory();
  }, [refresh, refreshHistory]);

  const saveFile = useCallback(
    async (forceDialog = false) => {
      const result = forceDialog
        ? await api.saveFileAs(activeIdRef.current)
        : await api.saveFile(activeIdRef.current);
      if (result) {
        setNotice({ kind: 'info', text: `Saved ${result.path}` });
        setStatus(await api.status());
        await refresh();
      }
    },
    [refresh],
  );

  const exportPng = useCallback(
    async (scale: number) => {
      const result = await api.exportPng(activeIdRef.current, {
        frame: frameIdRef.current ?? undefined,
        scale,
        background: null,
      });
      if (result) setNotice({ kind: 'info', text: `Exported ${result.path}` });
    },
    [],
  );

  const exportSheet = useCallback(async () => {
    const result = await api.exportSheet(activeIdRef.current, { layout: 'horizontal' });
    if (result) setNotice({ kind: 'info', text: `Exported ${result.path} + ${result.json}` });
  }, []);

  const exportGif = useCallback(async (tag?: string) => {
    // The tag decides the frame order, through the same sequence the GIF writer
    // uses, so the export matches whatever was playing on the canvas.
    const result = await api.exportGif(activeIdRef.current, { tag, scale: 1 });
    if (result) setNotice({ kind: 'info', text: `Exported ${result.path} (${result.frames} frames)` });
  }, []);

  const exportTiled = useCallback(async () => {
    const result = await api.exportTiled(activeIdRef.current, {});
    if (result) setNotice({ kind: 'info', text: `Exported ${result.path}` });
  }, []);

  const importImage = useCallback(async () => {
    const imported = await api.importImage();
    if (!imported) return;
    activeIdRef.current = imported.id;
    setStatus(await api.status());
    await refresh({ thumbnails: true });
  }, [refresh]);

  const createDocument = useCallback(
    async (options: Record<string, unknown>) => {
      const created = await api.createDocument(options);
      activeIdRef.current = created.id;
      setStatus(await api.status());
      await refresh({ thumbnails: true });
      void refreshHistory();
    },
    [refresh, refreshHistory],
  );

  const selectDocument = useCallback(
    async (id: string) => {
      await api.selectDocument(id);
      activeIdRef.current = id;
      setStatus(await api.status());
      await refresh({ thumbnails: true });
      void refreshHistory();
    },
    [refresh, refreshHistory],
  );

  const closeDocument = useCallback(
    async (id: string) => {
      await api.closeDocument(id);
      const next = await api.status();
      setStatus(next);
      activeIdRef.current = next.activeId;
      await refresh({ thumbnails: true });
    },
    [refresh],
  );

  const renameDocument = useCallback(
    async (name: string) => {
      await execute('rename_sprite', { name });
    },
    [execute],
  );

  const hoverColor = useMemo(() => {
    if (!cursor || !bitmap) return null;
    return sampleColor(bitmap, cursor.x, cursor.y);
  }, [cursor, bitmap]);

  const value: EditorValue = {
    ready,
    status,
    detail,
    bitmap,
    thumbnails,
    historyEntries,
    layerId,
    setLayerId,
    frameId,
    setFrameId,
    tool,
    setTool,
    primary,
    setPrimary,
    secondary,
    setSecondary,
    brushSize,
    setBrushSize,
    fillShapes,
    setFillShapes,
    zoom,
    setZoom,
    cursor,
    setCursor,
    hoverColor,
    notice,
    setNotice,
    execute,
    undo,
    redo,
    refreshHistory,
    openFile,
    saveFile,
    exportPng,
    exportSheet,
    playing,
    setPlaying,
    playTag,
    setPlayTag,
    playSpeed,
    setPlaySpeed,
    onionSkin,
    setOnionSkin,
    onionBefore,
    setOnionBefore,
    onionAfter,
    setOnionAfter,
    sequence,
    tilesetInfo,
    tilemapData,
    tilemapRef,
    setTilemapRef,
    activeTile,
    setActiveTile,
    clip,
    setClip,
    ditherPattern,
    setDitherPattern,
    ditherLevel,
    setDitherLevel,
    exportGif,
    exportTiled,
    importImage,
    createDocument,
    selectDocument,
    closeDocument,
    renameDocument,
  };

  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read one pixel out of a composited frame, for the status bar and the dropper. */
let sampler: HTMLCanvasElement | undefined;
export function sampleColor(bitmap: ImageBitmap, x: number, y: number): Color | null {
  if (x < 0 || y < 0 || x >= bitmap.width || y >= bitmap.height) return null;
  if (!sampler) sampler = document.createElement('canvas');
  sampler.width = bitmap.width;
  sampler.height = bitmap.height;
  const context = sampler.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.clearRect(0, 0, bitmap.width, bitmap.height);
  context.drawImage(bitmap, 0, 0);
  const [r, g, b, a] = context.getImageData(x, y, 1, 1).data;
  return { r: r ?? 0, g: g ?? 0, b: b ?? 0, a: a ?? 0 };
}
