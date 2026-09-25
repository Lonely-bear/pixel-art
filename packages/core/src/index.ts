/**
 * `@pixel/core` — the headless pixel art document model.
 *
 * Zero DOM, zero Electron, zero Node APIs. This package runs unchanged in the Electron
 * renderer, in the Electron main process, in a standalone MCP server, in a CLI, in a
 * Web Worker and in a test runner.
 *
 * Everything a client needs is here:
 *
 *   createSprite()            -> build a document
 *   createEditor()            -> an editing session with undo/redo
 *   editor.execute(name, p)   -> the single mutation entry point
 *   compositeFrame()          -> render to RGBA
 *   encodePNG()               -> hand bytes to a human or to a multimodal model
 *   serializeSprite()         -> the .pixel container
 *   buildSpritesheet()        -> engine-ready sheets and metadata
 */

export * from './types.js';
export * from './binary.js';
export * from './ids.js';
export * from './geometry.js';
export * from './color.js';
export * from './blend.js';
export * from './buffer.js';
export * from './dither.js';
export * from './palette.js';
export * from './ramp.js';
export * from './document.js';
export * from './draft.js';
export * from './raster.js';
export * from './tilemap.js';
export * from './transform.js';
export * from './rig.js';
export * from './render.js';
export * from './png.js';
export * from './serialize.js';
export * from './ase.js';
export * from './atlas.js';
export * from './gif.js';
export * from './import.js';

// Brings in the command bus (`Editor`, `applyCommand`, `undo`, ...) transitively.
export * from './commands/index.js';
