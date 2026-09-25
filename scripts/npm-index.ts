import packageJson from '../package.json' with { type: 'json' };

/** Published DotLoom package version. */
export const VERSION = packageJson.version;

/** Headless document model, command bus, rasteriser, and file codecs. */
export * as core from '../packages/core/src/index.js';

/** MCP server, document sessions, tools, resources, prompts, and attach bridge. */
export * as mcp from '../packages/mcp/src/index.js';

/** Constrained scripting runtime for trusted scripts and plugins. */
export * as script from '../packages/script/src/index.js';
