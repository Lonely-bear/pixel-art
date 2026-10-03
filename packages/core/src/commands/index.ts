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
export * from './rig.js';
export * from './map.js';
export * from './quality.js';
export * from './tilemap.js';
export * from './svgtrace.js';

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
  drawPolylineCommand,
  drawRectCommand,
  fillCommand,
  measureRegionCommand,
  outlineCommand,
  replaceColorCommand,
  replaceColorsCommand,
} from './draw.js';
import {
  addFrameCommand,
  addLayerCommand,
  addPaletteColorCommand,
  addPaletteRampCommand,
  addTagCommand,
  duplicateFrameCommand,
  duplicateLayerCommand,
  ensurePaletteRoleCommand,
  getLayerCommand,
  mergeLayerDownCommand,
  prunePaletteCommand,
  quantizeToPaletteCommand,
  removeFrameCommand,
  removeLayerCommand,
  removePaletteColorCommand,
  removeTagCommand,
  renameSpriteCommand,
  setFrameDurationsCommand,
  reorderFrameCommand,
  reorderLayerCommand,
  setPaletteColorCommand,
  setPaletteCommand,
  updateFrameCommand,
  updateLayerCommand,
  updateTagCommand,
  upsertTagsCommand,
} from './structure.js';
import {
  clearAllCommand,
  cropCanvasCommand,
  flipCommand,
  resizeCanvasCommand,
  rotateCommand,
  mirrorCommand,
  scaleSpriteCommand,
  squashCommand,
  transformCelCommand,
  translateCommand,
} from './transform.js';
import { mapCommands } from './map.js';
import { qualityCommands } from './quality.js';
import { rigCommands } from './rig.js';
import { tilemapCommands } from './tilemap.js';
import { traceSvgCommand } from './svgtrace.js';

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
  drawPolylineCommand,
  drawRectCommand,
  drawEllipseCommand,
  drawPolygonCommand,
  fillCommand,
  ditherFillCommand,
  outlineCommand,
  antialiasCommand,
  despeckleCommand,
  replaceColorCommand,
  replaceColorsCommand,
  clearRegionCommand,
  copyRegionCommand,
  measureRegionCommand,
  ...generativeCommands,
  // Vector outlines in, pixels out
  traceSvgCommand,
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
  setFrameDurationsCommand,
  reorderFrameCommand,
  addTagCommand,
  removeTagCommand,
  updateTagCommand,
  upsertTagsCommand,
  setPaletteCommand,
  setPaletteColorCommand,
  addPaletteColorCommand,
  addPaletteRampCommand,
  ensurePaletteRoleCommand,
  removePaletteColorCommand,
  prunePaletteCommand,
  quantizeToPaletteCommand,
  renameSpriteCommand,
  // Whole-canvas
  flipCommand,
  mirrorCommand,
  rotateCommand,
  resizeCanvasCommand,
  cropCanvasCommand,
  scaleSpriteCommand,
  clearAllCommand,
  // Per-cel motion
  translateCommand,
  squashCommand,
  transformCelCommand,
  // Quality: measure, plan a repair, refuse delivery. The pipeline exists; these make it reachable.
  ...qualityCommands,
  // Character rigs, poses, anchors and tween baking
  ...rigCommands,
  // Tilemaps, gameplay metadata and auto-tiling
  ...tilemapCommands,
  ...mapCommands,
];

export const defaultRegistry: CommandRegistry = createRegistry(allCommands);

/** Convenience factory used by the CLI, the MCP server and the UI. */
export function createEditor(sprite: Sprite, registry: CommandRegistry = defaultRegistry): Editor {
  return new Editor(sprite, registry);
}
