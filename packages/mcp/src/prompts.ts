/**
 * MCP prompts.
 *
 * Prompts are the closest thing this server has to a "recipe". They matter more
 * than usual here: a model that is handed 60 drawing tools and no method will
 * produce technically-valid mud, so each prompt front-loads the craft guide and
 * a concrete order of operations.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { PIXEL_ART_SKILL, SKILL_URI } from './skill.js';

const PALETTE_NAMES = 'dawnbringer16, pico8, endesga16, gameboy';

function user(text: string): GetPromptResult {
  return { messages: [{ role: 'user', content: { type: 'text', text } }] };
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'draw_sprite',
    {
      title: 'Draw a sprite from scratch',
      description:
        'A guided workflow for drawing a new sprite: plan, block the silhouette, look at it, shade with a ramp, outline selectively.',
      argsSchema: {
        subject: z.string().describe('What to draw, e.g. "a small green slime" or "a wooden treasure chest".'),
        width: z.string().optional().describe('Canvas width in pixels. Defaults to 32 if the user does not choose.'),
        height: z.string().optional().describe('Canvas height in pixels. Defaults to 32 if the user does not choose.'),
        palette: z.string().optional().describe(`Palette name (${PALETTE_NAMES}) or a comma-separated list of hex colours.`),
      },
    },
    ({ subject, width, height, palette }) => {
      const w = width ?? '32';
      const h = height ?? '32';
      const pal = palette ?? 'dawnbringer16';
      // A prompt cannot ask a question itself, so it names what it filled in and asks
      // for the decision in the text. A default that arrives unannounced is the thing
      // this exists to prevent.
      const sizeChosen = width !== undefined && height !== undefined;
      const confirmSize = sizeChosen
        ? ''
        : `\nBEFORE DRAWING: no canvas size was chosen, so this recipe would use ${w}x${h}. Offer the user two or three sizes that suit what they asked for, with one line each on what that size buys - a small canvas keeps every shape readable, a large one (128x128, 256x256, 512x512 or more) buys room for detail, and a non-square canvas suits a sprite that is not square. Any size up to 4096x4096 is supported, so do not argue them down from a big one. Wait for their answer, then build the size they picked.\n`;
      const confirmReview =
        `\nBEFORE DRAWING: also ask who reviews the pictures - you judging the previews as you go,\n` +
        `or the user reviewing and handing back notes. If it is you, open the two or three preview\n` +
        `gates below and actually judge them. If it is them, skip the previews, verify with read_grid,\n` +
        `and wait for their feedback instead of guessing what they want.\n`;
      return user(`Draw ${subject} as pixel art on a ${w}x${h} canvas.
${confirmSize}${confirmReview}
Follow this order. Use 2-3 visual gates, and get each PNG from the same mutation call via \`preview: true\` + \`previewOptions: {scale: 4}\` - do not spend a second call on \`get_preview\`:

1. \`create_document\` with width ${w}, height ${h}, layers ["base", "shade", "outline"], palette "${pal}". Its response already includes the layer/frame structure.
2. Block the whole silhouette in ONE flat mid-tone colour on the "base" layer with a batched \`run_script\` or \`apply_ops\`, and inspect its inline preview. If the shape is not recognisable as a solid silhouette, fix it before going further.
3. Add shadow on the "shade" layer, light coming from the top-left. Build 3-5 step material ramps with \`add_palette_ramp\` and use colours that step in hue as well as value. Break shade boundaries with single-pixel steps instead of long straight lines.
4. Outline on the "outline" layer with \`outline\` using \`mode: "outside"\`, in a dark, desaturated colour - not black. Then selectively erase the outline where the light hits, using \`clear_region\` or a draw with \`color: null\`.
5. Inspect the final inline preview for isolated speckles, clipped highlights and harsh edge contrast, and fix what you can actually see with \`despeckle\`/\`antialias\` or simpler shapes. Then use one \`finalize_document\` call for the source and PNG exports.

Keep the sprite centred: use \`measure_region\` to find the opaque bounds and \`copy_region\` or \`resize_canvas\` to recentre.

Read ${SKILL_URI} (or call \`read_skill\`) for the full craft guide. Keep the total palette to 4-6 colours, and never use pure black or pure white.`);
    },
  );

  server.registerPrompt(
    'animate_sprite',
    {
      title: 'Animate a sprite',
      description: 'Build an animation from a base frame: duplicate, move one thing per frame, tag the loop, export a sheet.',
      argsSchema: {
        subject: z.string().describe('What the animation shows, e.g. "a slime idle bounce" or "a 4-frame walk cycle".'),
        frames: z.string().optional().describe('How many frames to draw. Defaults to 4.'),
        direction: z.string().optional().describe('Loop direction: forward, reverse or pingpong. Defaults to pingpong.'),
      },
    },
    ({ subject, frames, direction }) => {
      const count = frames ?? '4';
      const dir = direction ?? 'pingpong';
      return user(`Animate ${subject} in ${count} frames, looping with direction "${dir}".

Workflow:
1. If a document is already open and has a finished base frame, use it. Otherwise draw the first frame first - follow the \`draw_sprite\` prompt - and only animate once frame 0 looks right.
2. Use \`duplicate_frame\` or a persistent rig. For a reusable limb/weapon, create stable part pivots with \`create_rig\`, save named poses, preview with \`preview_pose\`, and only bake into explicit frames. For a simple whole-body motion, duplicate and change one thing.
3. Keep everything that should not move identical between frames.
4. Batch frame durations with \`set_frame_durations\` (100-150 ms baseline).
5. Create/update the animation tag with \`upsert_tags\`, direction "${dir}".
6. Batch final timing with \`set_frame_durations\` and tags with \`upsert_tags\`, then call \`preview_animation {tag, onion: {before: 1, after: 1}}\`. Inspect that playback-ordered contact sheet and check the loop: the last frame must lead back into the first without a jump.
7. Fix anything the playback review turned up, then finish with one \`finalize_document\` plan containing source, grid sheet, GIF, contact sheet and a hashed manifest.

Read ${SKILL_URI} (or call \`read_skill\`) for the craft guide - section 7 covers animation.`);
    },
  );

  server.registerPrompt(
    'improve_sprite',
    {
      title: 'Critique and improve the current sprite',
      description: 'Look at the open document, critique it against pixel-art fundamentals, then fix the worst problem.',
      argsSchema: {
        focus: z.string().optional().describe('Optional area to focus on, e.g. "the outline" or "the shading".'),
      },
    },
    ({ focus }) => {
      const focusLine = focus ? `\nPay particular attention to: ${focus}.` : '';
      return user(`Critique the currently open sprite and improve it.

1. \`get_document\` to see the layers and frames, then \`get_preview\` to look at it.
2. \`evaluate\` once, for a second opinion. Read its \`issues\` list - each entry names a defect and the canvas rect of it - and its \`notes\`, which say what was *not* measured. Read \`report.excluded\` before quoting any number: a key that is absent there means the dimension did not apply, not that it scored zero. The scores are diagnostics for finding defects, not a target to raise; a cleanup pass that sands the piece flat has not improved it. If a dimension says nothing useful, ignore it - the scorer judges form, not content, and several of its conventions (4-connected silhouettes, top-left key light, holes are defects, 1px outlines) are debatable.
3. Critique it honestly against these fundamentals:
   - Is the silhouette readable as a solid shape, or is it mush?
   - Are there 3-4 shades per material, stepping in hue as well as value, or just a brightness ramp?
   - Is the light direction consistent (top-left convention)?
   - Is the outline selective (dark, desaturated, broken where light hits) or a closed black contour?
   - Is there pillow shading, banding, or a checkerboard dither over a large area?
   - Is pure black or pure white used anywhere?
   - If it is animated: does the loop close, and does more than one thing change per frame?
4. State the single worst problem.
5. Fix ONLY that problem on the correct layer with one batched \`run_script\` or \`apply_ops\` call, and inspect the same response's \`preview: true\` + \`previewOptions: {scale: 4}\` image.
6. Repeat once if the fix helped. If it made things worse, \`undo\` it rather than piling on more edits.${focusLine}

Read ${SKILL_URI} (or call \`read_skill\`) for the full craft guide, and section 11 in particular for the list of things that look bad.`);
    },
  );

  server.registerPrompt(
    'pixel_art_basics',
    {
      title: 'Pixel art craft guide',
      description: 'The full guide to pixel-art craft: workflow, colour, outlines, dithering, anti-aliasing, animation.',
      argsSchema: {},
    },
    () => ({
      description: 'Pixel art craft guide',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Here is the pixel art craft guide. Read it before drawing.\n\n${PIXEL_ART_SKILL}`,
          },
        },
      ],
    }),
  );
}
