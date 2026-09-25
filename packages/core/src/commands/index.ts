import { Editor, createRegistry, type CommandRegistry } from '../bus.js';
import type { Sprite } from '../document.js';
import type { Command } from './types.js';

export * from '../bus.js';
export * from './types.js';
export * from './catalog.js';
export * from './plugin.js';
export * from './draw.js';
export * from './generative.js';
export * from './structure.js';
export * from './transform.js';
export * from './tilemap.js';

import { generativeCommands } from './generative.js';
import {
  antialiasCommand,
  clearRegionCommand,
  copyRegionCommand,
  despeckleCommand,
  ditherFillCommand,
  putPixelsCommand,
  drawEllipseCommand,
  drawLineCommand,
  drawPixelsCommand,
  drawPolygonCommand,
  drawRectCommand,
  fillCommand,
  measureRegionCommand,
  outlineCommand,
  replaceColorCommand,
} from './draw.js';
import {
  addFrameCommand,
  addLayerCommand,
  addPaletteColorCommand,
  addPaletteRampCommand,
  addTagCommand,
  duplicateFrameCommand,
  duplicateLayerCommand,
  getLayerCommand,
  mergeLayerDownCommand,
  quantizeToPaletteCommand,
  removeFrameCommand,
  removeLayerCommand,
  removePaletteColorCommand,
  removeTagCommand,
  renameSpriteCommand,
  reorderFrameCommand,
  reorderLayerCommand,
  setPaletteColorCommand,
  setPaletteCommand,
  updateFrameCommand,
  updateLayerCommand,
  updateTagCommand,
} from './structure.js';
import {
  clearAllCommand,
  cropCanvasCommand,
  flipCommand,
  resizeCanvasCommand,
  rotateCommand,
  scaleSpriteCommand,
  squashCommand,
  translateCommand,
} from './transform.js';
import { tilemapCommands } from './tilemap.js';

/**
 * Every command the product knows about.
 *
 * This array is the single source of truth for three surfaces at once: what the Electron
 * UI can call over IPC, what the CLI can call, and what the MCP server advertises as
 * tools. Adding a command here makes it available to all three, with its description and
 * parameter docs intact.
 */
export const allCommands: Command[] = [
  // Drawing
  drawPixelsCommand,
  putPixelsCommand,
  drawLineCommand,
  drawRectCommand,
  drawEllipseCommand,
  drawPolygonCommand,
  fillCommand,
  ditherFillCommand,
  outlineCommand,
  antialiasCommand,
  despeckleCommand,
  replaceColorCommand,
  clearRegionCommand,
  copyRegionCommand,
  measureRegionCommand,
  ...generativeCommands,
  // Structure
  addLayerCommand,
  removeLayerCommand,
  updateLayerCommand,
  reorderLayerCommand,
  duplicateLayerCommand,
  mergeLayerDownCommand,
  getLayerCommand,
  addFrameCommand,
  removeFrameCommand,
  duplicateFrameCommand,
  updateFrameCommand,
  reorderFrameCommand,
  addTagCommand,
  removeTagCommand,
  updateTagCommand,
  setPaletteCommand,
  setPaletteColorCommand,
  addPaletteColorCommand,
  addPaletteRampCommand,
  removePaletteColorCommand,
  quantizeToPaletteCommand,
  renameSpriteCommand,
  // Whole-canvas
  flipCommand,
  rotateCommand,
  resizeCanvasCommand,
  cropCanvasCommand,
  scaleSpriteCommand,
  clearAllCommand,
  // Per-cel motion
  translateCommand,
  squashCommand,
  // Tilemaps and auto-tiling
  ...tilemapCommands,
];

export const defaultRegistry: CommandRegistry = createRegistry(allCommands);

/** Convenience factory used by the CLI, the MCP server and the UI. */
export function createEditor(sprite: Sprite, registry: CommandRegistry = defaultRegistry): Editor {
  return new Editor(sprite, registry);
}
