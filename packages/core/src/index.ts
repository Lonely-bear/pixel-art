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
 *   renderGridView()          -> hand the same pixels back as text, for an agent
 *   serializeSprite()         -> the .pixel container
 *   buildSpritesheet()        -> engine-ready sheets and metadata
 */

export * from './types.js';
export * from './binary.js';
export * from './ids.js';
export * from './rng.js';
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
export * from './grid.js';
export * from './serialize.js';
export * from './ase.js';
export * from './atlas.js';
export * from './gif.js';
export * from './import.js';

// The quality pipeline: the aggregator, the dimensions that exist, and the contract they
// share. Re-exporting the dimensions is deliberate — `evaluate` is the product's entry
// point into the pipeline, and a caller that cannot reach the analyzer it is aggregating
// cannot calibrate one. It also means the public namespace now carries the ~90 commands and
// the quality pipeline together, which is one namespace instead of two ways in.
export * from './quality/index.js';

// The recipe format (T-030). Re-exported for the same reason as the quality pipeline above: a
// consumer that cannot reach `validateRecipe` cannot check a recipe before acting on it, and a
// schema nobody outside the package can import is a schema that cannot be held to.
export * from './recipes.js';

// The SVG tracer behind `trace_svg`. Public because the command is a thin wrapper over it and a
// caller tracing outside the bus should get the same pixels the command gets, not a second path.
export * from './svgtrace.js';

// Brings in the command bus (`Editor`, `applyCommand`, `undo`, ...) transitively.
export * from './commands/index.js';
