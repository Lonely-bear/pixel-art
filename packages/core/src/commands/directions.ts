import { z } from 'zod';
import type { AnimationTag, Sprite, SpriteRig } from '../document.js';
import {
  DIRECTIONS,
  DIRECTION_IDS,
  describeDirection,
  directionSpec,
  orientationAffine,
  orientationAnchor,
  resolveGaitParts,
  walkCycleFrames,
  type DirectionAnchorName,
} from '../directions.js';
import { makeId } from '../ids.js';
import { renderPose, requireRig } from '../rig.js';
import { transformBufferAffine } from '../transform.js';
import { defineCommand, frameRefSchema, pointSchema } from './types.js';
import type { CommandContext } from './types.js';

const directionSchema = z
  .enum(DIRECTION_IDS as unknown as [string, ...string[]])
  .describe(
    'One of N, NE, E, SE, S, SW, W, NW. N is screen up and S is screen down. E is the ' +
      'direction the base pose is drawn in; every other direction is a quarter turn and/or ' +
      'a mirror of it.',
  );

const anchorSchema = z
  .enum(['ground', 'facing', 'origin'])
  .describe(
    'Named orientation anchor, the point a direction change turns about and never moves. ' +
      '`ground` = bottom centre (the feet, the default for a turn in place), `facing` = top ' +
      'centre (a head marker), `origin` = canvas centre.',
  );

export const getDirectionsCommand = defineCommand({
  name: 'get_directions',
  description:
    'Read the eight-direction model: for each of N/NE/E/SE/S/SW/W/NW its facing vector, the quarter turns and mirror that produce it, whether that is exact, which drawing it reuses, and the resolved canvas matrix about a chosen anchor. Read-only, and the cheapest way to check a character is authored facing E before generating anything.',
  guide: [
    '## The scheme',
    '',
    'The base pose is drawn **facing E (screen right)**. Everything else is derived:',
    '',
    '| direction | transform | exact | drawing it reuses |',
    '| --- | --- | --- | --- |',
    '| N | three quarter turns (anticlockwise) | yes | the E base |',
    '| E | identity | yes | the E base |',
    '| S | one quarter turn (clockwise) | yes | the E base |',
    '| W | horizontal mirror | yes | the E base |',
    '| NE | as N, mirrored | no - draw it | a NE diagonal |',
    '| NW | mirror of the NE drawing | no - draw it | the same NE diagonal |',
    '| SE | as S | no - draw it | an SE diagonal |',
    '| SW | mirror of the SE drawing | no - draw it | the same SE diagonal |',
    '',
    'So an eight-direction set is **three drawings** (E, one NE diagonal, one SE diagonal),',
    'not eight sheets. Five of the eight need no new artwork at all.',
    '',
    '## Why the diagonals are not exact',
    '',
    'A diagonal is a different *drawing*, not a rotated copy: there is no 45-degree pixel',
    'transform that survives a pixel grid, and this engine will not emit one. The transform a',
    'diagonal carries therefore lands it 45 degrees from the direction it names, and the spec',
    'reports that as `exact: false` with `resolvedFrom` naming the cardinal it lands on. Draw',
    'the NE and SE sheets once; their mirrors are exact.',
    '',
    '## Anchors',
    '',
    'A direction change turns about a named anchor and never moves it. `ground` (bottom',
    'centre) is the default because a character turns on the spot. `ground` and `facing`',
    'share the vertical axis `x = (w-1)/2`, which is what makes W an exact mirror of E.',
    '',
    'Use a **square canvas**. A quarter turn is mapped into the same canvas rather than a',
    'swapped one, so a non-square canvas clips the figure at an odd quarter turn.',
  ].join('\n'),
  readOnly: true,
  params: z.object({
    direction: directionSchema.optional().describe('Return only this direction. Defaults to all eight.'),
    anchor: anchorSchema.optional().describe('Named anchor to resolve the matrix about. Defaults to `ground`.'),
    pivot: pointSchema.optional().describe('Explicit pivot in pixels, overriding `anchor`.'),
  }),
  apply(ctx, p) {
    const anchor: DirectionAnchorName = p.anchor ?? 'ground';
    const canvas = { width: ctx.sprite.width, height: ctx.sprite.height };
    const pivot = p.pivot ?? orientationAnchor(anchor, canvas.width, canvas.height);
    const wanted = p.direction ? [directionSpec(p.direction)] : DIRECTIONS;
    return {
      baseDirection: 'E' as const,
      anchor,
      pivot,
      exactDirections: DIRECTIONS.filter((spec) => spec.exact).map((spec) => spec.id),
      approximateDirections: DIRECTIONS.filter((spec) => !spec.exact).map((spec) => spec.id),
      directions: wanted.map((spec) => describeDirection(spec, canvas, anchor)),
    };
  },
});

/** Every layer id any rig part owns, i.e. the layers a pose bake may clear. */
function rigPartLayerIds(rig: SpriteRig): Set<string> {
  return new Set(rig.parts.flatMap((part) => part.layerIds));
}

function frameHasPixels(sprite: Sprite, frameId: string): boolean {
  const frame = sprite.frames.find((candidate) => candidate.id === frameId);
  return Boolean(frame && [...frame.cels.values()].some((buffer) => !buffer.isEmpty()));
}

export const generateWalkCycleCommand = defineCommand({
  name: 'generate_walk_cycle',
  description:
    'Generate a closing walk cycle for one direction from the rig rest frame: frames, per-frame durations and a loop tag, all in one undo step. The loop has no duplicated end frame, so the last frame leads straight back into the first. Non-exact directions fall back to the cardinal they resolve from and say so.',
  guide: [
    '## What it writes',
    '',
    '- `frames` new frames starting at `targetFrame` (default: the frame after the rig rest',
    '  frame), each holding the baked pixels of that gait frame, each with `frameDurationMs`.',
    '- One animation tag, `tagName` (default `walk_<direction lowercased>`), spanning exactly',
    '  those frames with `repeat: 0` - loop forever - which is what makes it replayable.',
    '- Nothing else. Walk poses are transient: they are not pushed into the rig, so a',
    '  document never accumulates one pose per frame per direction. Use `save_pose` for a',
    '  stance you want to keep.',
    '',
    '## Loop closure',
    '',
    'The gait is driven by integer triangle waves with period `2 * frames` sampled at index',
    'modulo `frames`, so frame `frames` is the *same pose* as frame `0` - never a second copy',
    'of it. §4.6\'s `motion` dimension scores a doubled end frame as a seam; this does not',
    'produce one. `phaseOffset` shifts the whole loop by whole frames without changing it.',
    '',
    '## Gait roles',
    '',
    'Legs, arms and the bobbing body are chosen from part names (`leg`/`foot`/`thigh`/`shin`,',
    '`arm`/`hand`/`forearm`, `body`/`torso`/`hips`/`chest`/`root`/`spine`). Pass `legs`,',
    '`arms` or `body` explicitly to override; a rig where nothing matches falls back to the',
    'parentless parts so a one-part rig still bobs.',
    '',
    '## Eight directions',
    '',
    'One call is one direction. To fill a full set, call it eight times with distinct',
    '`tagName`s - `get_directions` lists them. It refuses to write the rig rest frame, because',
    'poses render from that frame and overwriting it corrupts every later render.',
  ].join('\n'),
  params: z.object({
    direction: directionSchema.optional().describe('Direction to generate. Defaults to E, the base direction.'),
    frames: z.number().int().min(2).max(32).optional().describe('Frames in one gait cycle. Two contacts per cycle, so even counts read best. Defaults to 4.'),
    frameDurationMs: z.number().int().min(1).max(2000).optional().describe('Duration of every generated frame in ms. Defaults to 120.'),
    stride: z.number().int().min(0).max(16).optional().describe('Peak horizontal foot travel in pixels. Defaults to 2.'),
    bob: z.number().int().min(0).max(16).optional().describe('Peak body lift between a contact and the next passing frame, in pixels. Defaults to 1.'),
    legSwingDegrees: z.number().int().min(0).max(45).optional().describe('Peak leg tilt at the ends of the swing, in degrees. Defaults to 6.'),
    legs: z.array(z.string()).optional().describe('Part IDs or names to treat as legs. Defaults to name-matched parts.'),
    arms: z.array(z.string()).optional().describe('Part IDs or names to treat as arms. Defaults to name-matched parts.'),
    body: z.array(z.string()).optional().describe('Part IDs or names that carry the body bob. Defaults to name-matched parts.'),
    anchor: anchorSchema.optional().describe('Named orientation anchor the direction turns about. Defaults to `ground`.'),
    pivot: pointSchema.optional().describe('Explicit orientation pivot in pixels, overriding `anchor`.'),
    tagName: z.string().min(1).max(64).optional().describe('Animation tag covering the generated frames. Defaults to `walk_<direction>`. Created or updated in place.'),
    loopDirection: z.enum(['forward', 'reverse', 'pingpong']).optional().describe('Tag playback direction. Defaults to `forward`.'),
    repeat: z.number().int().min(0).optional().describe('Tag repeat count. 0 loops forever. Defaults to 0.'),
    phaseOffset: z.number().int().min(0).max(31).optional().describe('Whole frames to advance the gait before frame 0, for staggering one loop against another. Defaults to 0.'),
    targetFrame: frameRefSchema.optional().describe('First destination frame. Defaults to the frame after the rig rest frame. Never the rest frame itself.'),
    overwrite: z.boolean().optional().describe('Required when any destination frame already contains pixels.'),
  }),
  apply(ctx, p) {
    const rig = requireRig(ctx.sprite);
    const spec = directionSpec(p.direction ?? 'E');
    const canvas = { width: ctx.sprite.width, height: ctx.sprite.height };
    const anchor: DirectionAnchorName = p.anchor ?? 'ground';
    const pivot = p.pivot ?? orientationAnchor(anchor, canvas.width, canvas.height);
    const restIndex = ctx.sprite.frames.findIndex((frame) => frame.id === rig.restFrameId);
    const targetStart = p.targetFrame === undefined
      ? restIndex + 1
      : ctx.sprite.frames.findIndex((frame, index) => index === p.targetFrame || frame.id === p.targetFrame);
    if (targetStart < 0) throw new Error(`Unknown target frame: ${p.targetFrame}`);
    if (targetStart <= restIndex) {
      throw new Error(
        `generate_walk_cycle would write the rig rest frame (index ${restIndex}). Walk frames are rendered from the rest frame, so overwriting it corrupts every later render. Start at index ${restIndex + 1} or later.`,
      );
    }
    const gait = {
      frames: p.frames ?? 4,
      stride: p.stride ?? 2,
      bob: p.bob ?? 1,
      legSwingDegrees: p.legSwingDegrees ?? 6,
      legs: p.legs,
      arms: p.arms,
      body: p.body,
      phaseOffset: p.phaseOffset ?? 0,
      direction: spec.id,
    };
    const walkFrames = walkCycleFrames(rig, gait);
    const roles = resolveGaitParts(rig, gait);
    if (!p.overwrite) {
      for (let i = 0; i < walkFrames.length; i++) {
        const existing = ctx.sprite.frames[targetStart + i];
        if (existing && frameHasPixels(ctx.sprite, existing.id)) {
          throw new Error(`Target frame ${targetStart + i} already contains pixels. Pass overwrite: true.`);
        }
      }
    }

    const matrix = orientationAffine(spec, pivot);
    // Render the whole cycle before writing any destination frame, so every frame is derived
    // from the same untouched rest pose.
    const rendered = walkFrames.map((frame) => renderPose(ctx.sprite, {
      id: `walk_${spec.id.toLowerCase()}_${frame.index}`,
      name: `walk_${spec.id.toLowerCase()}_${frame.index}`,
      transforms: frame.transforms,
    }));

    const duration = p.frameDurationMs ?? 120;
    const partLayers = rigPartLayerIds(rig);
    const frameIds: string[] = [];
    const clippedParts: string[] = [];
    for (let i = 0; i < rendered.length; i++) {
      let frame = ctx.sprite.frames[targetStart + i];
      if (!frame) {
        frame = { id: makeId('frm'), durationMs: duration, cels: new Map() };
        ctx.sprite.frames.push(frame);
      }
      frame.durationMs = duration;
      const target = ctx.sprite.frames.find((candidate) => candidate.id === frame!.id)!;
      for (const clipped of rendered[i].clippedParts) clippedParts.push(clipped.part);
      for (const [layerId, source] of rendered[i].cels) {
        // Part-owned layers are driven entirely by the gait; layers the rig does not own are
        // the destination's own and are left exactly as they were.
        if (!partLayers.has(layerId)) continue;
        const oriented = transformBufferAffine(source, matrix, { width: canvas.width, height: canvas.height });
        const cel = ctx.draft.cel(layerId, target.id, true)!;
        if (oriented.isEmpty()) {
          cel.clear();
        } else {
          cel.data.set(oriented.data);
        }
      }
      frameIds.push(target.id);
    }

    const tagName = p.tagName ?? `walk_${spec.id.toLowerCase()}`;
    const desired = {
      from: targetStart,
      to: targetStart + walkFrames.length - 1,
      direction: p.loopDirection ?? ('forward' as const),
      repeat: p.repeat ?? 0,
    };
    const existing = ctx.sprite.tags.find((tag) => tag.name === tagName);
    let tag: AnimationTag;
    if (existing) {
      Object.assign(existing, desired);
      tag = existing;
    } else {
      tag = { id: makeId('tag'), name: tagName, ...desired };
      ctx.sprite.tags.push(tag);
    }

    return {
      direction: spec.id,
      exact: spec.exact,
      resolvedFrom: spec.resolvedFrom,
      anchor,
      pivot,
      matrix,
      frames: frameIds.length,
      frameIndices: { from: tag.from, to: tag.to },
      frameDurationMs: duration,
      totalDurationMs: duration * frameIds.length,
      phases: walkFrames.map((frame) => frame.phase),
      tagId: tag.id,
      tagName: tag.name,
      tagDirection: tag.direction,
      loopsForever: tag.repeat === 0,
      roles: {
        legs: roles.legs.map((part) => part.name),
        arms: roles.arms.map((part) => part.name),
        body: roles.body.map((part) => part.name),
        ...(roles.fallback ? { fallback: 'no part name matched a gait role; parentless parts used' } : {}),
      },
      ...(clippedParts.length ? { warning: `These parts left the canvas on at least one frame: ${[...new Set(clippedParts)].join(', ')}. Shrink stride/bob, enlarge the canvas, or move the orientation anchor.` } : {}),
    };
  },
});

export const directionCommands = [
  getDirectionsCommand,
  generateWalkCycleCommand,
];