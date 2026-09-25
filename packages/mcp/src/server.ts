/**
 * `createPixelServer` - the whole MCP surface in one call.
 *
 * The server is deliberately usable two ways:
 *
 *  - **Standalone** (`dotloom-mcp` on stdio, or over HTTP) so an agent can work
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
import { PIXEL_ART_SKILL, SKILL_SUMMARY } from './skill.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

export { SERVER_NAME, SERVER_VERSION };

/**
 * A fingerprint of what this process actually loaded.
 *
 * The server is long-lived: it reads the built `dist/` once at startup, so
 * rebuilding the packages does not put new code in front of a running session.
 * That failure is silent - every call succeeds, the tool list looks right, and the
 * agent is simply working against last week's guidance. It cost two sessions of
 * changes once already, so the fingerprint is published in `list_commands`: a
 * mismatch against a freshly built server means "restart the MCP server", not
 * "that feature does not exist".
 */
export interface ServerBuild {
  /** Short stable hash of the skill text this process is serving. */
  skillHash: string;
  /** Length of that text, which moves the moment the guide changes. */
  skillLength: number;
}

function hashText(text: string): string {
  // FNV-1a: short, dependency-free, and enough to notice a changed paragraph.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export const SKILL_FINGERPRINT: ServerBuild = {
  skillHash: hashText(PIXEL_ART_SKILL),
  skillLength: PIXEL_ART_SKILL.length,
};

export const SERVER_INSTRUCTIONS = `dotloom-mcp is a pixel-art editor for game assets: sprites, animation frames and spritesheets.

You edit a **document** - a sprite with layers, frames, animation tags and a palette.
Documents live in this session and are addressed by id; one is active, and every
tool defaults to it, so most calls need only the arguments they actually change.

Workflow that works:
1. \`create_document\` returns the complete layer/frame/palette structure, so you can
   draw immediately. Call \`get_document\` only after \`import_image\`/\`open_document\`
   or when a structural change means you need a fresh view.
2. Block the silhouette in one flat colour. For the fast draw→look loop, call
   \`run_script\` or \`apply_ops\` with \`preview: true\` and
   \`previewOptions: {scale: 4}\`; for a completed animation use \`preview_animation\` with
   its tag. Inspect the returned PNG before the next pass.
   Use \`get_preview\` when you need a view without making an edit.
3. Build material ramps with \`add_palette_ramp\` (dark anchor, light anchor, steps,
   \`hueShift\`) and shade with them, then outline selectively. On large canvases use
   \`cluster2\`/\`cluster4\` dither instead of a full-field 1px Bayer; keep 1px patterns
   for narrow transition bands. Two or three visual gates are usually enough.
4. Use \`apply_ops\` instead of one call per edit. It accepts any command from
   \`list_commands\`, inline params included, and can return its preview inline too.
   For generated fields prefer \`put_pixels\` (base64 RGBA) or the seeded
   \`banded_gradient\`/\`noise_fill\`/\`ridge_line\`/\`scatter\` primitives over per-pixel JSON.
5. For tile maps, use \`stroke_tilemap\` for curved weighted terrain, optional custom
   \`transitions\` for organic edges, and \`preview_tilemap\` with the returned changed
   cells/rect for an immediate grid+index PNG. A mutation's optional \`bake\` redraws only
   changed cells with alpha-over, so an unbaked grid does not need a full rebake to look.
6. Before finishing, run \`quality_report\` and fix its warnings. Pass \`tilemap\` for an
   unbaked grid: repeated texture is reported as structure/evidence, not automatically
   despeckled. For raster art, use \`despeckle\` for isolated pixels, \`antialias\` for harsh
   edges and less glow for clipped highlights.
7. Finish with one \`finalize_document\` call that saves the editable \`.pixel\` source
   and writes the exact PNG exports you need. Use \`export_sheet\` for engines or
   \`export_gif\` for animation instead when those formats are required.

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
      title: 'dotloom-mcp',
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
