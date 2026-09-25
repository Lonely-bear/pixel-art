/**
 * `@pixel/mcp` - the Model Context Protocol surface for the dotloom-mcp pixel-art editor.
 *
 * Embed it in the Electron main process to share one document store (and one
 * undo history) between the GUI and the agent, or run `dotloom-mcp` standalone.
 */
export * from './server.js';
export * from './session.js';
export * from './skill.js';
export * from './tools.js';
export * from './resources.js';
export * from './prompts.js';
export * from './attach.js';
export * from './discovery.js';
