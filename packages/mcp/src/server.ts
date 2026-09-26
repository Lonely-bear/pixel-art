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
import { registerTools, type CommandExposure } from './tools.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';
import { installToolSurface } from './surface.js';
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
A fresh session already has one 32x32 scratch document open and active, so a batch
that works is not proof the document you meant is the one you edited - check
\`list_documents\`, or name your \`document\`, when it matters.

Before the first edit, settle two things with the user. Both are cheap to ask and
expensive to guess, and each one changes what you do next:

1. **Canvas size, when the file is new.** If the request is a fresh sprite and no size
   came with it, ask - do not guess, and never silently inherit the scratch document's
   32x32. Offer two or three options that suit what the user is actually making, and
   say what each one costs them: a small canvas (16x16, 32x32) forces every shape to stay
   readable, a large one (128x128, 256x256, 512x512 or beyond) buys room for detail and
   interior structure, and a canvas that is not square suits a sprite that is not square.
   Any size from 1x1 to 4096x4096 is supported. A large canvas is a legitimate answer,
   not something to talk the user down from - if they ask for 512x512, build 512x512.
   Scale your method to the size rather than shrinking their idea: on a big canvas work
   in \`rect\` regions, batch with \`apply_ops\` or \`run_script\`, and crop-zoom
   \`get_preview\` instead of inspecting the whole canvas on every pass. This gate
   outranks any default stated elsewhere in this server or in a prompt.
2. **Who reviews the pictures.** Ask whether you should judge the previews yourself as
   you go, or whether the user will review and hand back notes. If you review, open
   the images and actually look - two or three \`get_preview\` gates, at the points where
   the silhouette, the shading and the outline each get decided, rather than a preview
   per edit. If the user reviews, do not spend calls on previews nobody asked for:
   verify with \`read_grid\`, keep each pass batched, and expect to be told what to
   change. Either way, \`despeckle\`/\`antialias\` are for defects you have actually spotted.

**The user can box a region on the canvas, and when they do, that is your scope.** They
pick the select tool, drag a rectangle, and then talk to you about what is inside it -
"the head in my selection is too small". \`get_selection\` is how you find out where they
mean, and it returns the rect plus the layer and frame the box was drawn on. Call it
whenever they say "my selection", "the part I boxed", "this side", "over here" or
anything else that points rather than names; do not guess a region when you can read
the real one. \`get_preview {rect}\`, \`read_grid {rect}\` and \`histogram {rect}\` all take
that rect, so you can look closely before you touch anything. It answers
\`{selection: null}\` when there is no box, which is a real answer: work on the whole
canvas rather than inventing one. \`set_selection\` lets you box a region yourself to
confirm a guess, and \`mode\` says whether the box is a \`hint\` (the default - you may
write just outside when the change needs room, which is what "make the head bigger"
requires) or \`enforce\` (stay inside it). Respect \`enforce\` strictly; a box is not a
suggestion once they have asked for it.

The tool list is deliberately small. \`apply_ops\`, \`run_script\`, \`list_commands\`,
\`describe_command\` and \`find_workflow\` are the entry points; the ~90 drawing,
structure, palette, rig and tilemap **commands** are not in the list until this session
touches one. Any of them runs through \`apply_ops\` at any time, and looking a command
up (\`list_commands\` {name}, or \`describe_command\`), running it, or getting it back
from \`find_workflow\` promotes it to a tool you can call directly from then on. The
response says which ones (\`promotedTools\`), and \`list_commands\` marks each entry
\`tool: true\` once it is callable directly. \`describe_command\` also describes the
entry-point tools themselves, which is where to read the full parameter list of
\`apply_ops\`, \`finalize_document\` or \`run_script\`.

Workflow that works:
1. \`create_document\` returns the complete layer/frame/palette structure, at whatever
   size the user settled on above. Use
   \`create_sprite_spec\` when a character also needs tags, palette roles and a persistent rig.
   Call \`find_workflow\` for a multi-step task and \`describe_command\` for one exact schema.
2. Block the silhouette in one flat colour. \`read_grid\` returns the artwork as one
   character per pixel - \`{view: "mask"}\` for the silhouette, \`{view: "value"}\` for
   tone - which answers "is this symmetric / which tone is in row 14 / did that edit
   land" exactly and cheaply, and a repeated call also reports which rows changed.
   That is how you verify. \`get_preview\` is how you approve: for the fast draw→look
   loop, call \`run_script\` or \`apply_ops\` with \`preview: true\` and
   \`previewOptions: {scale: 4}\`; for a completed animation use \`preview_animation\` with
   its tag. Save the pictures for the two or three gates that matter, not every pass.
3. Build material ramps with \`add_palette_ramp\` (dark anchor, light anchor, steps,
   \`hueShift\`) and shade with them, then outline selectively. On large canvases use
   \`cluster2\`/\`cluster4\` dither instead of a full-field 1px Bayer; keep 1px patterns
   for narrow transition bands. Between passes, \`read_grid\` is the cheap check; two or
   three \`get_preview\` gates are usually enough.
4. Use \`apply_ops\` instead of one call per edit. It accepts any command from
   \`list_commands\`, inline params included, and can return its preview inline too.
   For generated fields prefer \`put_pixels\` (base64 RGBA) or the seeded
   \`banded_gradient\`/\`noise_fill\`/\`ridge_line\`/\`scatter\` primitives over per-pixel JSON.
5. For tile maps, use \`stroke_tilemap\` for curved weighted terrain, optional custom
   \`transitions\` for organic edges, and \`preview_tilemap\` with the returned changed
   cells/rect for an immediate grid+index PNG. A mutation's optional \`bake\` redraws only
   changed cells with alpha-over, so an unbaked grid does not need a full rebake to look.
6. Before finishing, look at the whole piece one more time at a scale where the tones
   read, and fix what you can still see: a stray speckle, a clipped highlight, a
   silhouette that lost its shape. If the user took over the reviewing, this step is
   theirs - hand the finished piece over instead of fixing what you have not been
   asked to look at. \`despeckle\`/\`antialias\` are for defects you have actually spotted.
7. Finish with one \`finalize_document\` export plan. It writes source, PNG/frame/sheet,
   GIF, pose and contact outputs; add a hashed manifest and \`incremental: true\` for a
   reusable asset package.

Conventions: origin is top-left, x right, y **down**, pixels are zero-based.
Layers are indexed from the **bottom** (index 0 is the bottom layer); refer to
them by name where you can. Rectangles are \`{x, y, w, h}\` with \`w\`/\`h\` as counts.
Drawing outside the canvas is clipped, never an error.

Two arguments are accepted by every tool and so are not repeated in every schema:
\`document\` (id or name; omit to use the active one) and \`expectedVersion\` (the
\`version\` from your last read or write; a mismatch fails with \`version_conflict\`
instead of overwriting someone else's edit).

Failures come back as \`{ok: false, error, code, remediation?}\`. Branch on \`code\`, not
on the message text, and follow \`remediation\` when it is there.

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
  /**
   * How much of the command catalogue ships as first-class tools.
   *
   * `lazy` (default) registers a command the first time the session uses it, which
   * keeps the tool list around 30 tools instead of 127. `eager` restores the flat
   * catalogue; the test suite drives that mode, and it is the escape hatch if a
   * promotion path turns out to be missing.
   */
  commands?: CommandExposure;
  /**
   * Appended to the built-in instructions.
   *
   * The agent reads `instructions`, so this is the one channel that reaches the
   * model itself rather than the human. When the desktop app is absent the CLI
   * uses it to say so, which turns a silent "my edits went nowhere" into
   * something the agent volunteers before the user wonders.
   */
  instructionsNote?: string;
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
      instructions: options.instructionsNote
        ? `${SERVER_INSTRUCTIONS}\n\n${options.instructionsNote}`
        : SERVER_INSTRUCTIONS,
    },
  );

  // Before the first registerTool, so the SDK's own tools/list handler is installed
  // already wrapped: validation keeps the full strict schema, the advertised form
  // does not repeat it.
  installToolSurface(server);

  registerTools(server, store, { commands: options.commands });
  registerResources(server, store);
  registerPrompts(server);

  const initial = options.initialDocument === undefined
    ? { width: 32, height: 32, name: 'Sprite', layers: ['base', 'shade', 'outline'], palette: 'dawnbringer16' }
    : options.initialDocument;
  if (initial) store.create(initial);

  return { server, store };
}
