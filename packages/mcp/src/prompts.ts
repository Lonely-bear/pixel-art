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
        width: z.string().optional().describe('Canvas width in pixels. Defaults to 32.'),
        height: z.string().optional().describe('Canvas height in pixels. Defaults to 32.'),
        palette: z.string().optional().describe(`Palette name (${PALETTE_NAMES}) or a comma-separated list of hex colours.`),
      },
    },
    ({ subject, width, height, palette }) => {
      const w = width ?? '32';
      const h = height ?? '32';
      const pal = palette ?? 'dawnbringer16';
      return user(`Draw ${subject} as pixel art on a ${w}x${h} canvas.

Follow this order. Use 2-3 visual gates, and get each PNG from the same mutation call via \`preview: true\` + \`previewOptions: {scale: 4}\` - do not spend a second call on \`get_preview\`:

1. \`create_document\` with width ${w}, height ${h}, layers ["base", "shade", "outline"], palette "${pal}". Its response already includes the layer/frame structure.
2. Block the whole silhouette in ONE flat mid-tone colour on the "base" layer with a batched \`run_script\` or \`apply_ops\`, and inspect its inline preview. If the shape is not recognisable as a solid silhouette, fix it before going further.
3. Add shadow on the "shade" layer, light coming from the top-left. Build 3-5 step material ramps with \`add_palette_ramp\` and use colours that step in hue as well as value. Break shade boundaries with single-pixel steps instead of long straight lines.
4. Outline on the "outline" layer with \`outline\` using \`mode: "outside"\`, in a dark, desaturated colour - not black. Then selectively erase the outline where the light hits, using \`clear_region\` or a draw with \`color: null\`.
5. Inspect the final inline preview, run \`quality_report\` to check for isolated speckles, clipped highlights and harsh edge contrast, fix flagged areas with \`despeckle\`/\`antialias\` or simpler shapes, then use one \`finalize_document\` call for the source and PNG exports.

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
2. Use \`duplicate_frame\` to create each new frame from the previous one, then change ONE thing per frame. Never redraw the whole sprite: for a bounce, move the whole silhouette with \`copy_region\`; for a limb, redraw just that limb.
3. Keep everything that should not move identical between frames.
4. Set frame durations with \`update_frame\` (100-150 ms baseline; a run cycle is faster than a walk).
5. Add an animation tag with \`add_tag\` covering all frames, direction "${dir}", so the engine knows the loop.
6. Call \`get_preview\` with \`frames: "all"\` to see every frame as a strip, and check the loop: the last frame must lead back into the first without a jump.
7. Export with \`export_sheet\` using \`layout: "grid"\`, \`padding: 1\` and a power-of-two column count.

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
2. Critique it honestly against these fundamentals:
   - Is the silhouette readable as a solid shape, or is it mush?
   - Are there 3-4 shades per material, stepping in hue as well as value, or just a brightness ramp?
   - Is the light direction consistent (top-left convention)?
   - Is the outline selective (dark, desaturated, broken where light hits) or a closed black contour?
   - Is there pillow shading, banding, or a checkerboard dither over a large area?
   - Is pure black or pure white used anywhere?
   - If it is animated: does the loop close, and does more than one thing change per frame?
3. State the single worst problem.
4. Fix ONLY that problem on the correct layer with one batched \`run_script\` or \`apply_ops\` call, and inspect the same response's \`preview: true\` + \`previewOptions: {scale: 4}\` image.
5. Repeat once if the fix helped. If it made things worse, \`undo\` it rather than piling on more edits.${focusLine}

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
