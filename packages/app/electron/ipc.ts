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
  encodeGIF,
  encodePNG,
  resolveTilemap,
  scaleAtlas,
  scaleNearest,
  serializeSprite,
  spriteFromPng,
  toAsepriteJson,
  toTiledJson,
} from '@pixel/core';
import { CHANNELS, type DocumentSummary, type PreviewRequest } from '../shared/types.js';
import {
  describeDocument,
  execute,
  history,
  redo,
  renderBuffer,
  renderPreview,
  store,
  undo,
} from './host.js';

/**
 * `store.list()` hands back live `PixelDocument`s, which contain the editor and
 * its function members. Anything crossing the IPC boundary must go through
 * `summary()`, or Electron's structured clone rejects the payload.
 */
function summaries(): DocumentSummary[] {
  return store.list().map((doc) => store.summary(doc));
}

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
  ipcMain.handle(CHANNELS.listDocuments, () => summaries());

  ipcMain.handle(CHANNELS.status, () => ({
    documents: summaries(),
    activeId: store.activeDocumentId,
    filePath: store.active?.path,
    mcp: getMcpStatus(),
  }));

  ipcMain.handle(CHANNELS.selectDocument, (_event, id: string) => {
    store.select(id);
    broadcast();
    return store.summary(store.require(id));
  });

  ipcMain.handle(CHANNELS.createDocument, (_event, options: Record<string, unknown>) => {
    const doc = store.create(options as never);
    broadcast();
    return describeDocument(doc);
  });

  ipcMain.handle(CHANNELS.closeDocument, (_event, id: string) => {
    store.remove(id);
    broadcast();
    return summaries();
  });

  ipcMain.handle(CHANNELS.documentDetail, (_event, id?: string) =>
    describeDocument(store.require(id)),
  );

  ipcMain.handle(CHANNELS.preview, (_event, id: string | undefined, request: PreviewRequest) =>
    renderPreview(store.require(id), request ?? {}),
  );

  ipcMain.handle(
    CHANNELS.execute,
    (_event, id: string | undefined, name: string, params: unknown, opts?: Record<string, unknown>) => {
      const result = execute(store.require(id), name, params, opts ?? {});
      if (result.ok) broadcast();
      return result;
    },
  );

  ipcMain.handle(CHANNELS.undo, (_event, id: string | undefined, steps?: number) => {
    const result = undo(store.require(id), steps ?? 1);
    if (result.undone > 0) broadcast();
    return result;
  });

  ipcMain.handle(CHANNELS.redo, (_event, id: string | undefined, steps?: number) => {
    const result = redo(store.require(id), steps ?? 1);
    if (result.redone > 0) broadcast();
    return result;
  });

  ipcMain.handle(CHANNELS.history, (_event, id: string | undefined, limit?: number) =>
    history(store.require(id), limit ?? 50),
  );

  ipcMain.handle(CHANNELS.openFile, async () => {
    const window = focusedWindow();
    const picked = await dialog.showOpenDialog(window!, {
      title: 'Open sprite',
      filters: [{ name: 'Pixel Art sprite', extensions: ['pixel'] }],
      properties: ['openFile'],
    });
    if (picked.canceled || picked.filePaths.length === 0) return null;
    const filePath = picked.filePaths[0];
    const bytes = new Uint8Array(await readFile(filePath));
    const doc = store.load(bytes, { path: filePath, select: true });
    broadcast();
    return describeDocument(doc);
  });

  ipcMain.handle(CHANNELS.saveFile, async (_event, id: string | undefined) => {
    const doc = store.require(id);
    let filePath = doc.path;
    if (!filePath) {
      const picked = await dialog.showSaveDialog(focusedWindow()!, {
        title: 'Save sprite',
        defaultPath: `${doc.name}.pixel`,
        filters: [{ name: 'Pixel Art sprite', extensions: ['pixel'] }],
      });
      if (picked.canceled || !picked.filePath) return null;
      filePath = picked.filePath;
    }
    await ensureDir(filePath);
    await writeFile(filePath, serializeSprite(doc.editor.sprite));
    doc.path = filePath;
    store.touch(doc, false);
    broadcast();
    return { path: filePath };
  });

  ipcMain.handle(CHANNELS.saveFileAs, async (_event, id: string | undefined) => {
    const doc = store.require(id);
    const picked = await dialog.showSaveDialog(focusedWindow()!, {
      title: 'Save sprite as',
      defaultPath: doc.path ?? `${doc.name}.pixel`,
      filters: [{ name: 'Pixel Art sprite', extensions: ['pixel'] }],
    });
    if (picked.canceled || !picked.filePath) return null;
    await ensureDir(picked.filePath);
    await writeFile(picked.filePath, serializeSprite(doc.editor.sprite));
    doc.path = picked.filePath;
    store.touch(doc, false);
    broadcast();
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
        title: 'Export PNG',
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
      title: 'Export spritesheet',
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
        title: 'Export GIF',
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
      title: 'Export Tiled map',
      defaultPath: `${doc.name}.tmj`,
      filters: [{ name: 'Tiled map', extensions: ['tmj', 'json'] }],
    });
    if (picked.canceled || !picked.filePath) return null;

    const map = toTiledJson(sprite.tileset, tilemaps, { image: 'tileset.png' });
    await ensureDir(picked.filePath);
    await writeFile(picked.filePath, JSON.stringify(map, null, 2));
    return {
      path: picked.filePath,
      width: map.width,
      height: map.height,
      tiles: map.tilesets[0]?.tilecount ?? 0,
      layers: map.layers.map((layer) => layer.name),
    };
  });

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
      title: 'Import image',
      filters: [{ name: 'Images', extensions: ['png'] }],
      properties: ['openFile'],
    });
    if (picked.canceled || picked.filePaths.length === 0) return null;
    const filePath = picked.filePaths[0];
    const bytes = new Uint8Array(await readFile(filePath));
    const sprite = spriteFromPng(bytes, {
      name: path.basename(filePath).replace(/\.png$/i, ''),
    });
    const doc = store.add(sprite, { select: true });
    broadcast();
    return describeDocument(doc);
  });

  ipcMain.handle(CHANNELS.mcpStatus, () => getMcpStatus());
}
