/**
 * `createPixelServer` - the whole MCP surface in one call.
 *
 * The server is deliberately usable two ways:
 *
 *  - **Standalone** (`pixel-mcp` on stdio, or over HTTP) so an agent can work
 *    without the desktop app running at all.
 *  - **Embedded**, by the Electron main process, so the GUI and the agent share
 *    one in-memory `DocumentStore` and therefore one undo history. An agent edit
 *    and a human edit are the same kind of edit.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DocumentStore, type CreateDocumentOptions } from './session.js';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';
import { SKILL_SUMMARY } from './skill.js';

export const SERVER_NAME = 'pixel-art';
export const SERVER_VERSION = '0.1.0';

export const SERVER_INSTRUCTIONS = `A pixel art editor for game assets: sprites, animation frames and spritesheets.

You edit a **document** - a sprite with layers, frames, animation tags and a palette.
Documents live in this session and are addressed by id; one is active, and every
tool defaults to it, so most calls need only the arguments they actually change.

Workflow that works:
1. \`create_document\` (or \`import_image\` / \`open_document\`), then \`get_document\` to
   learn the layer names and frame indices.
2. Block the silhouette in one flat colour, then call \`get_preview\` and actually
   look at it. Perception between edits is the difference between a sprite and mud.
3. Shade with a hue-shifted ramp, then outline selectively.
4. Batch related edits with \`apply_ops\` instead of one call per pixel. It accepts
   any command from \`list_commands\`, inline params included.
5. \`export_sheet\` for engines, \`export_png\` for a single image, \`save_document\`
   for the editable source.

Conventions: origin is top-left, x right, y **down**, pixels are zero-based.
Layers are indexed from the **bottom** (index 0 is the bottom layer); refer to
them by name where you can. Rectangles are \`{x, y, w, h}\` with \`w\`/\`h\` as counts.
Drawing outside the canvas is clipped, never an error.

Concurrency: every read returns a \`version\`. Pass it back as \`expectedVersion\`
on a write to be told about conflicting edits instead of silently overwriting
someone else's work.

Before drawing anything non-trivial, call \`read_skill\` or read \`pixel://skill\`.
${SKILL_SUMMARY}`;

export interface PixelServerOptions {
  name?: string;
  version?: string;
  /** Share a store with an existing client (e.g. the Electron main process). */
  store?: DocumentStore;
  /**
   * Create a scratch document on startup so the agent has something to draw on
   * without spending a call. Pass `null` to start empty.
   */
  initialDocument?: CreateDocumentOptions | null;
}

export interface PixelServer {
  server: McpServer;
  store: DocumentStore;
}

export function createPixelServer(options: PixelServerOptions = {}): PixelServer {
  const store = options.store ?? new DocumentStore();

  const server = new McpServer(
    {
      name: options.name ?? SERVER_NAME,
      version: options.version ?? SERVER_VERSION,
      title: 'Pixel Art',
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  registerTools(server, store);
  registerResources(server, store);
  registerPrompts(server);

  const initial = options.initialDocument === undefined
    ? { width: 32, height: 32, name: 'Sprite', layers: ['base', 'shade', 'outline'], palette: 'dawnbringer16' }
    : options.initialDocument;
  if (initial) store.create(initial);

  return { server, store };
}
