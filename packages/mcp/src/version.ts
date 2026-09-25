import packageJson from '../../../package.json' with { type: 'json' };

/** Public package identity advertised during the MCP handshake. */
export const SERVER_NAME = packageJson.name;
export const SERVER_VERSION = packageJson.version;
