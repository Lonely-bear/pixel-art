/**
 * The IPC surface the renderer is allowed to use.
 *
 * Deliberately shaped like the MCP tool surface: `execute` takes a command name
 * and params, exactly as an agent would send them. The GUI is not a privileged
 * client — it goes through the same command bus and the same undo history.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import {
  animationSequence,
  buildSpritesheet,
  deserializeSprite,
  isAseprite,
  encodeGIF,
  encodePNG,
  resolveTilemap,
  scaleAtlas,
  scaleNearest,
  serializeSprite,
  spriteFromAseprite,
  spriteFromPng,
  toAsepriteJson,
  toTiledJson,
} from '@pixel/core';
import { CHANNELS, isAppLocale, type AppLocale, type AssetExportRequest, type DocumentSummary, type PreviewRequest, type UpdateSettings } from '../shared/types.js';
import {
  describeDocument,
  execute,
  history,
  redo,
  renderBuffer,
  renderPreview,
  setSelection,
  store,
  undo,
} from './host.js';
import { exportAssetBundle, isAssetEngine, type AssetEngine } from './asset-export.js';
import {
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  openReleasePage,
  saveUpdateSettings,
  setUpdaterLocale,
  skipVersion,
  snapshot,
} from './updater.js';

/**
 * `store.list()` hands back live `PixelDocument`s, which contain the editor and
 * its function members. Anything crossing the IPC boundary must go through
 * `summary()`, or Electron's structured clone rejects the payload.
 */
function summaries(): DocumentSummary[] {
  return store.list().map((doc) => store.summary(doc));
}

let appLocale: AppLocale = 'en';
const dialogText: Record<AppLocale, Record<string, string>> = {
  en: {
    open: 'Open sprite', save: 'Save sprite', saveAs: 'Save sprite as',
    png: 'Export PNG', sheet: 'Export spritesheet', gif: 'Export GIF',
    tiled: 'Export Tiled map', importImage: 'Import image',
    meta: 'Export asset contract', engine: 'Export engine assets',
  },
  ja: {
    open: 'スプライトを開く', save: 'スプライトを保存', saveAs: 'スプライトを名前を付けて保存',
    png: 'PNG を書き出し', sheet: 'スプライトシートを書き出し', gif: 'GIF を書き出し',
    tiled: 'Tiled マップを書き出し', importImage: '画像をインポート',
    meta: 'アセット契約を書き出し', engine: 'エンジン用アセットを書き出し',
  },
  ko: {
    open: '스프라이트 열기', save: '스프라이트 저장', saveAs: '스프라이트 다른 이름으로 저장',
    png: 'PNG 내보내기', sheet: '스프라이트 시트 내보내기', gif: 'GIF 내보내기',
    tiled: 'Tiled 맵 내보내기', importImage: '이미지 가져오기',
    meta: '에셋 계약 내보내기', engine: '엔진 에셋 내보내기',
  },
  'zh-CN': {
    open: '打开角色文件', save: '保存角色', saveAs: '角色另存为',
    png: '导出 PNG', sheet: '导出精灵图', gif: '导出 GIF',
    tiled: '导出 Tiled 地图', importImage: '导入图片',
    meta: '导出资产契约', engine: '导出引擎资源',
  },
  'zh-TW': {
    open: '開啟角色檔案', save: '儲存角色', saveAs: '角色另存新檔',
    png: '匯出 PNG', sheet: '匯出精靈圖', gif: '匯出 GIF',
    tiled: '匯出 Tiled 地圖', importImage: '匯入圖片',
    meta: '匯出資產契約', engine: '匯出引擎資源',
  },
};
const text = () => dialogText[appLocale];

/**
 * Push the current document list to every window.
 *
 * Driven by `store.onChange` rather than by the handlers below, so an edit
 * made through the embedded MCP server repaints the window exactly like a local
 * one, and a second window stays in sync. Sending to all windows is what makes
 * that work: the store is shared, so the change is not window-local.
 */
function broadcast(): void {
  const activeId = store.activeDocumentId;
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(CHANNELS.changed, {
      activeId,
      documents: summaries(),
    });
  }
}

function focusedWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined;
}

async function ensureDir(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}

export function registerIpc(getMcpStatus: () => unknown): void {
  // One notification path for every mutation, whoever made it. The store
  // announces its own changes, so this is the only subscriber needed: the
  // handlers below, a second window, and the MCP server's agent edits all
  // reach the canvas by the same route.
  store.onChange(broadcast);

  ipcMain.on(CHANNELS.setLocale, (_event, locale: AppLocale) => {
    if (isAppLocale(locale)) {
      appLocale = locale;
      // The updater keeps its own table for the one native dialog it can raise,
      // so the two follow the same five locales.
      setUpdaterLocale(locale);
    }
  });
  ipcMain.handle(CHANNELS.listDocuments, () => summaries());

  ipcMain.handle(CHANNELS.status, () => ({
    documents: summaries(),
    activeId: store.activeDocumentId,
    filePath: store.active?.path,
    mcp: getMcpStatus(),
  }));

  ipcMain.handle(CHANNELS.selectDocument, (_event, id: string) => {
    store.select(id);
    return store.summary(store.require(id));
  });

  ipcMain.handle(CHANNELS.createDocument, (_event, options: Record<string, unknown>) => {
    const doc = store.create(options as never);
    return describeDocument(doc);
  });

  ipcMain.handle(CHANNELS.closeDocument, (_event, id: string) => {
    store.remove(id);
    return summaries();
  });

  ipcMain.handle(CHANNELS.documentDetail, (_event, id?: string) =>
    describeDocument(store.require(id)),
  );

  /**
   * The canvas box, shared with the agent.
   *
   * Not a command, so it costs no undo step and does not dirty the document: it is
   * where the user said the subject is, not an edit to the artwork. `announce()`
   * inside the store is what repaints the canvas mask and what an agent's own
   * `set_selection` relies on to reach the window.
   */
  ipcMain.handle(
    CHANNELS.selection,
    (
      _event,
      id: string | undefined,
      rect: { x: number; y: number; w: number; h: number } | null,
      mode?: 'hint' | 'enforce',
      scope?: { layerId?: string; frameId?: string },
    ) => setSelection(store.require(id), rect ?? null, mode, scope),
  );

  ipcMain.handle(CHANNELS.preview, (_event, id: string | undefined, request: PreviewRequest) =>
    renderPreview(store.require(id), request ?? {}),
  );

  ipcMain.handle(
    CHANNELS.execute,
    (_event, id: string | undefined, name: string, params: unknown, opts?: Record<string, unknown>) => {
      return execute(store.require(id), name, params, opts ?? {});
    },
  );

  ipcMain.handle(CHANNELS.undo, (_event, id: string | undefined, steps?: number) => {
    return undo(store.require(id), steps ?? 1);
  });

  ipcMain.handle(CHANNELS.redo, (_event, id: string | undefined, steps?: number) => {
    return redo(store.require(id), steps ?? 1);
  });

  ipcMain.handle(CHANNELS.history, (_event, id: string | undefined, limit?: number) =>
    history(store.require(id), limit ?? 50),
  );

  ipcMain.handle(CHANNELS.openFile, async () => {
    const window = focusedWindow();
    const picked = await dialog.showOpenDialog(window!, {
      title: text().open,
      filters: [{ name: 'dotloom-mcp sprite', extensions: ['pixel'] }],
      properties: ['openFile'],
    });
    if (picked.canceled || picked.filePaths.length === 0) return null;
    const filePath = picked.filePaths[0];
    const bytes = new Uint8Array(await readFile(filePath));
    const doc = store.load(bytes, { path: filePath, select: true });
    return describeDocument(doc);
  });

  ipcMain.handle(CHANNELS.saveFile, async (_event, id: string | undefined) => {
    const doc = store.require(id);
    let filePath = doc.path;
    if (!filePath) {
      const picked = await dialog.showSaveDialog(focusedWindow()!, {
        title: text().save,
        defaultPath: `${doc.name}.pixel`,
        filters: [{ name: 'dotloom-mcp sprite', extensions: ['pixel'] }],
      });
      if (picked.canceled || !picked.filePath) return null;
      filePath = picked.filePath;
    }
    await ensureDir(filePath);
    await writeFile(filePath, serializeSprite(doc.editor.sprite));
    doc.path = filePath;
    store.touch(doc, false);
    return { path: filePath };
  });

  ipcMain.handle(CHANNELS.saveFileAs, async (_event, id: string | undefined) => {
    const doc = store.require(id);
    const picked = await dialog.showSaveDialog(focusedWindow()!, {
      title: text().saveAs,
      defaultPath: doc.path ?? `${doc.name}.pixel`,
      filters: [{ name: 'dotloom-mcp sprite', extensions: ['pixel'] }],
    });
    if (picked.canceled || !picked.filePath) return null;
    await ensureDir(picked.filePath);
    await writeFile(picked.filePath, serializeSprite(doc.editor.sprite));
    doc.path = picked.filePath;
    store.touch(doc, false);
    return { path: picked.filePath };
  });

  ipcMain.handle(
    CHANNELS.exportPng,
    async (
      _event,
      id: string | undefined,
      options: { frame?: number; scale?: number; background?: string | null } = {},
    ) => {
      const doc = store.require(id);
      const picked = await dialog.showSaveDialog(focusedWindow()!, {
        title: text().png,
        defaultPath: `${doc.name}.png`,
        filters: [{ name: 'PNG image', extensions: ['png'] }],
      });
      if (picked.canceled || !picked.filePath) return null;
      const { image } = renderBuffer(doc, {
        frame: options.frame,
        background: options.background ?? null,
      });
      const factor = Math.max(1, Math.floor(options.scale ?? 1));
      const scaled = factor > 1 ? scaleNearest(image, factor) : image;
      await ensureDir(picked.filePath);
      await writeFile(picked.filePath, encodePNG(scaled));
      return { path: picked.filePath, width: scaled.width, height: scaled.height };
    },
  );

  ipcMain.handle(CHANNELS.exportSheet, async (_event, id: string | undefined, options: { layout?: 'horizontal' | 'vertical' | 'grid'; columns?: number; padding?: number; margin?: number; scale?: number } = {}) => {
    const doc = store.require(id);
    const picked = await dialog.showSaveDialog(focusedWindow()!, {
      title: text().sheet,
      defaultPath: `${doc.name}-sheet.png`,
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    });
    if (picked.canceled || !picked.filePath) return null;
    const sprite = doc.editor.sprite;
    const atlas = buildSpritesheet(sprite, options);
    // Scale the atlas, not just its image, so the JSON frame rects and
    // `meta.size` match the PNG the engine will actually slice.
    const sheet = scaleAtlas(atlas, options.scale ?? 1);
    const jsonPath = picked.filePath.replace(/\.png$/i, '.json');
    await ensureDir(picked.filePath);
    await writeFile(picked.filePath, encodePNG(sheet.image));
    await writeFile(
      jsonPath,
      JSON.stringify(toAsepriteJson(sprite, sheet, path.basename(picked.filePath)), null, 2),
    );
    return { path: picked.filePath, json: jsonPath, width: sheet.width, height: sheet.height };
  });

  ipcMain.handle(
    CHANNELS.exportGif,
    async (
      _event,
      id: string | undefined,
      options: { tag?: string | number; scale?: number; background?: string | null; loop?: boolean } = {},
    ) => {
      const doc = store.require(id);
      const picked = await dialog.showSaveDialog(focusedWindow()!, {
        title: text().gif,
        defaultPath: `${doc.name}.gif`,
        filters: [{ name: 'Animated GIF', extensions: ['gif'] }],
      });
      if (picked.canceled || !picked.filePath) return null;
      const sprite = doc.editor.sprite;
      const scale = Math.max(1, Math.floor(options.scale ?? 1));
      // The frame order comes from the tag, through the same `animationSequence`
      // the preview uses, so what you see playing is what gets written.
      const bytes = encodeGIF(sprite, {
        tag: options.tag,
        scale,
        background: options.background ?? null,
        loop: options.loop,
      });
      await ensureDir(picked.filePath);
      await writeFile(picked.filePath, bytes);
      const sequence = animationSequence(sprite, options.tag);
      return {
        path: picked.filePath,
        width: sprite.width * scale,
        height: sprite.height * scale,
        frames: sequence.frames.length,
      };
    },
  );

  ipcMain.handle(CHANNELS.exportTiled, async (_event, id: string | undefined) => {
    const doc = store.require(id);
    const sprite = doc.editor.sprite;
    if (!sprite.tileset) throw new Error('This document has no tileset. Run `create_tileset` first.');
    const tilemaps = sprite.tilemaps ?? [];
    if (tilemaps.length === 0) throw new Error('This document has no tilemaps. Run `add_tilemap` first.');

    const picked = await dialog.showSaveDialog(focusedWindow()!, {
      title: text().tiled,
      defaultPath: `${doc.name}.tmj`,
      filters: [{ name: 'Tiled map', extensions: ['tmj', 'json'] }],
    });
    if (picked.canceled || !picked.filePath) return null;

    const map = toTiledJson(sprite.tileset, tilemaps, {
      image: 'tileset.png',
      mapObjects: sprite.mapObjects ?? [],
    });
    const tilesetPath = path.join(path.dirname(picked.filePath), 'tileset.png');
    await ensureDir(picked.filePath);
    await writeFile(picked.filePath, JSON.stringify(map, null, 2));
    await writeFile(tilesetPath, encodePNG(sprite.tileset.image));
    return {
      path: picked.filePath,
      tilesetPath,
      width: map.width,
      height: map.height,
      tiles: map.tilesets[0]?.tilecount ?? 0,
      tileProperties: Object.keys(sprite.tileset.tileProperties ?? {}).length,
      objects: sprite.mapObjects?.length ?? 0,
      layers: map.layers.map((layer) => layer.name),
    };
  });

  /**
   * The asset contract, and one engine's files.
   *
   * Two channels rather than one with an optional engine, because the MCP
   * surface has two output types (`{type: "meta"}` and `{type: "engine"}`) and
   * two surfaces disagreeing about the same policy is a bug. `exportEngine`
   * always writes the contract too — every importer reads one.
   *
   * The policy — naming validation, refusing the bundle on a naming *error*,
   * writing nothing — lives in `asset-export.ts`, which is also where it is
   * tested. This owns the dialog and nothing else. Note what comes back:
   * named defects and paths, never a score.
   */
  const assetExportHandler = async (
    _event: unknown,
    id: string | undefined,
    options: AssetExportRequest,
    engine?: AssetEngine,
  ) => {
    const doc = store.require(id);
    const picked = await dialog.showSaveDialog(focusedWindow()!, {
      title: engine ? text().engine : text().meta,
      defaultPath: path.join(doc.name, 'meta.json'),
      filters: [{ name: 'Asset contract', extensions: ['json'] }],
    });
    if (picked.canceled || !picked.filePath) return null;
    return exportAssetBundle(doc.editor.sprite, {
      ...(options ?? {}),
      path: picked.filePath,
      ...(engine ? { engine } : {}),
    });
  };

  

  ipcMain.handle(
    CHANNELS.exportMeta,
    (_event, id: string | undefined, options: AssetExportRequest = {}) =>
      assetExportHandler(_event, id, options),
  );

  ipcMain.handle(
    CHANNELS.exportEngine,
    (_event, id: string | undefined, engine: unknown, options: AssetExportRequest = {}) => {
      if (!isAssetEngine(engine)) throw new Error(`Unknown engine "${String(engine)}".`);
      return assetExportHandler(_event, id, options, engine);
    },
  );

  // Resolved by the same `animationSequence` the GIF writer uses, so the canvas
  // plays exactly the frames the export would write.
  ipcMain.handle(CHANNELS.animationSequence, (_event, id: string | undefined, tag?: string | number) => {
    const doc = store.require(id);
    const sequence = animationSequence(doc.editor.sprite, tag);
    return {
      name: sequence.name,
      frameIds: sequence.frames.map((frame) => frame.frameId),
      durations: sequence.frames.map((frame) => frame.durationMs),
      durationMs: sequence.durationMs,
      loops: sequence.loops,
    };
  });

  // The tilemap editor needs the tileset image and the raw cell indices, which the
  // document summary deliberately does not carry.
  ipcMain.handle(CHANNELS.tilesetInfo, (_event, id: string | undefined) => {
    const doc = store.require(id);
    const tileset = doc.editor.sprite.tileset;
    if (!tileset) return null;
    return {
      id: tileset.id,
      name: tileset.name,
      tileWidth: tileset.tileWidth,
      tileHeight: tileset.tileHeight,
      columns: tileset.columns,
      tilePropertyCount: Object.keys(tileset.tileProperties ?? {}).length,
      rows: Math.floor(tileset.image.height / tileset.tileHeight),
      width: tileset.image.width,
      height: tileset.image.height,
      png: encodePNG(tileset.image),
    };
  });

  ipcMain.handle(
    CHANNELS.tilemapData,
    (_event, id: string | undefined, tilemapRef: string | number) => {
      const doc = store.require(id);
      const tilemap = resolveTilemap(doc.editor.sprite, tilemapRef);
      return {
        id: tilemap.id,
        name: tilemap.name,
        width: tilemap.width,
        height: tilemap.height,
        tileWidth: tilemap.tileWidth,
        tileHeight: tilemap.tileHeight,
        data: [...tilemap.data],
      };
    },
  );

  ipcMain.handle(CHANNELS.importImage, async () => {
    const picked = await dialog.showOpenDialog(focusedWindow()!, {
      title: text().importImage,
      filters: [
        { name: 'Images', extensions: ['png', 'aseprite', 'ase'] },
      ],
      properties: ['openFile'],
    });
    if (picked.canceled || picked.filePaths.length === 0) return null;
    const filePath = picked.filePaths[0];
    const bytes = new Uint8Array(await readFile(filePath));
    // PNGs and Aseprite files both arrive here; the header tells them apart. An
    // Aseprite file brings its layers, frames, durations and tags with it.
    const name = path.basename(filePath).replace(/\.(png|aseprite|ase)$/i, '');
    const sprite = isAseprite(bytes) ? spriteFromAseprite(bytes, { name }) : spriteFromPng(bytes, { name });
    const doc = store.add(sprite, { select: true });
    return describeDocument(doc);
  });

  ipcMain.handle(CHANNELS.mcpStatus, () => getMcpStatus());

  // Updates. Five thin handlers: the state machine is in `updater.ts` and the
  // renderer gets a snapshot back from each one, so a window that is opened
  // late — or a second window — never has to reconstruct anything.
  ipcMain.handle(CHANNELS.updateSnapshot, () => snapshot());
  ipcMain.handle(CHANNELS.updateSaveSettings, async (_event, patch: UpdateSettings) => {
    await saveUpdateSettings(patch);
    return snapshot();
  });
  ipcMain.handle(CHANNELS.updateCheck, async (_event, automatic?: boolean) => {
    await checkForUpdates(automatic === true);
  });
  ipcMain.handle(CHANNELS.updateDownload, () => downloadUpdate());
  ipcMain.handle(CHANNELS.updateInstall, () => installUpdate());
  ipcMain.handle(CHANNELS.updateSkip, async (_event, version: string | null) => {
    await skipVersion(typeof version === 'string' && version ? version : null);
  });
  ipcMain.handle(CHANNELS.updateOpenRelease, () => openReleasePage());
}
