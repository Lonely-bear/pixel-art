/**
 * The authoritative editor host.
 *
 * There is exactly one `DocumentStore` in the whole product. The GUI window and
 * every connected MCP client mutate the *same* documents through the *same*
 * undo history, which is the whole point of putting the MCP server inside the
 * Electron main process rather than beside it.
 */
import {
  compositeFrame,
  encodePNG,
  frameLayersWithCels,
  resolveFrame,
  spriteDurationMs,
  type PixelBuffer,
  type Sprite,
} from '@pixel/core';
import { DocumentStore, type PixelDocument } from '@pixel/mcp';
import type {
  DocumentDetail,
  ExecResult,
  HistoryEntry,
  PreviewRequest,
  PreviewResult,
} from '../shared/types.js';

export const store = new DocumentStore();

/** Layers bottom-first, which is the order the layer panel shows. */
export function describeDocument(doc: PixelDocument): DocumentDetail {
  const sprite = doc.editor.sprite;
  const summary = store.summary(doc);
  return {
    ...summary,
    layerList: sprite.layers.map((layer, index) => ({
      index,
      id: layer.id,
      name: layer.name,
      visible: layer.visible,
      locked: layer.locked,
      opacity: layer.opacity,
      blendMode: layer.blendMode,
    })),
    frameList: sprite.frames.map((frame, index) => ({
      index,
      id: frame.id,
      durationMs: frame.durationMs,
      layers: frameLayersWithCels(sprite, frame.id).map((layer) => layer.id),
    })),
    tagList: sprite.tags.map((tag) => ({ ...tag })),
    palette: {
      name: sprite.palette.name,
      colors: sprite.palette.colors.map((color) => ({ ...color })),
    },
    celCount: sprite.frames.reduce((total, frame) => total + frame.cels.size, 0),
    durationMs: spriteDurationMs(sprite),
    hasTileset: Boolean(sprite.tileset),
    tilemaps: (sprite.tilemaps ?? []).map((tilemap) => tilemap.id),
  };
}

export function renderBuffer(
  doc: PixelDocument,
  request: PreviewRequest = {},
): { image: PixelBuffer; version: number } {
  const sprite = doc.editor.sprite;
  const frameId =
    request.frame === undefined ? sprite.frames[0]?.id : resolveFrame(sprite, request.frame).id;
  return {
    image: compositeFrame(sprite, frameId, {
      respectVisibility: request.flatten !== true,
      background: request.background ?? null,
    }),
    version: doc.editor.version,
  };
}

export function renderPreview(doc: PixelDocument, request: PreviewRequest = {}): PreviewResult {
  const { image, version } = renderBuffer(doc, request);
  return { version, width: image.width, height: image.height, png: encodePNG(image) };
}

export function execute(
  doc: PixelDocument,
  name: string,
  params: unknown,
  opts: { label?: string; expectedVersion?: number } = {},
): ExecResult {
  const result = doc.editor.tryExecute(name, params, opts);
  if (!result.ok) {
    return { ok: false, error: result.error, code: result.code, version: doc.editor.version };
  }
  store.touch(doc, true);
  return { ok: true, summary: result.summary, version: doc.editor.version };
}

export function undo(doc: PixelDocument, steps = 1): { undone: number; version: number } {
  let undone = 0;
  while (undone < steps && doc.editor.canUndo()) {
    doc.editor.undo();
    undone += 1;
  }
  if (undone > 0) store.touch(doc, true);
  return { undone, version: doc.editor.version };
}

export function redo(doc: PixelDocument, steps = 1): { redone: number; version: number } {
  let redone = 0;
  while (redone < steps && doc.editor.canRedo()) {
    doc.editor.redo();
    redone += 1;
  }
  if (redone > 0) store.touch(doc, true);
  return { redone, version: doc.editor.version };
}

export function history(doc: PixelDocument, limit = 50): HistoryEntry[] {
  return doc.editor
    .history()
    .slice(-limit)
    .reverse()
    .map((entry) => ({
      label: entry.label,
      command: entry.command,
      summary: entry.summary,
    }));
}

/** The sprite the renderer should mirror, as a plain object for IPC. */
export function activeSprite(doc: PixelDocument): Sprite {
  return doc.editor.sprite;
}
