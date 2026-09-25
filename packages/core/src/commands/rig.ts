import { z } from 'zod';
import { PixelBuffer } from '../buffer.js';
import type {
  PartTransform,
  RigAnchor,
  RigHitbox,
  RigPart,
  RigPose,
  RigTween,
  Sprite,
  SpriteRig,
} from '../document.js';
import { makeId } from '../ids.js';
import {
  evaluateRig,
  findRigPart,
  findRigPose,
  findRigTween,
  renderInterpolatedPose,
  renderPose,
  requireRig,
} from '../rig.js';
import { transformBufferAbout } from '../transform.js';
import { defineCommand, frameRefSchema, layerRefSchema, pointSchema, rectSchema } from './types.js';
import type { CommandContext } from './types.js';

const partRefSchema = z.string().describe('Rig part ID or unique part name.');
const poseRefSchema = z.string().describe('Pose ID or unique pose name.');
const tweenRefSchema = z.string().describe('Tween ID or unique tween name.');
const partTransformSchema = z
  .object({
    dx: z.number().optional(),
    dy: z.number().optional(),
    rotationDegrees: z.number().optional(),
    scaleX: z.number().positive().max(8).optional(),
    scaleY: z.number().positive().max(8).optional(),
  })
  .strict();

function requirePart(rig: SpriteRig, ref: string): RigPart {
  return findRigPart(rig, ref);
}

function requirePose(rig: SpriteRig, ref: string): RigPose {
  return findRigPose(rig, ref);
}

function validateUniquePartNames(parts: RigPart[]): void {
  const names = new Set<string>();
  for (const part of parts) {
    if (names.has(part.name)) throw new Error(`Duplicate rig part name: ${part.name}`);
    names.add(part.name);
  }
}

function validatePartHierarchy(parts: RigPart[]): void {
  const byId = new Map(parts.map((part) => [part.id, part]));
  const visit = (part: RigPart, stack: Set<string>): void => {
    if (stack.has(part.id)) throw new Error(`Rig part cycle detected at ${part.name}.`);
    const nextStack = new Set(stack);
    nextStack.add(part.id);
    if (part.parentId) {
      const parent = byId.get(part.parentId);
      if (!parent) throw new Error(`Rig part ${part.name} references missing parent ${part.parentId}.`);
      visit(parent, nextStack);
    }
  };
  for (const part of parts) visit(part, new Set());
}

function validateLayerOwnership(parts: RigPart[]): void {
  const owners = new Map<string, string>();
  for (const part of parts) {
    for (const layerId of part.layerIds) {
      const previous = owners.get(layerId);
      if (previous) throw new Error(`Layer ${layerId} is assigned to both ${previous} and ${part.name}.`);
      owners.set(layerId, part.name);
    }
  }
}

function validatePose(rig: SpriteRig, pose: RigPose): void {
  const ids = new Set(rig.parts.map((part) => part.id));
  for (const partId of Object.keys(pose.transforms)) {
    if (!ids.has(partId)) throw new Error(`Pose ${pose.name} references unknown part ${partId}.`);
  }
}

function frameHasPixels(sprite: Sprite, frameId: string): boolean {
  const frame = sprite.frames.find((candidate) => candidate.id === frameId);
  return Boolean(frame && [...frame.cels.values()].some((buffer) => !buffer.isEmpty()));
}

export interface BakeOutcome {
  /** Destination layers the rig does not own, left exactly as they were. */
  preservedLayers: string[];
  /** Part-owned layers cleared because the pose produced nothing for them. */
  clearedPartLayers: string[];
}

/**
 * Write a rendered pose into a destination frame.
 *
 * Layers are classified by ownership, not by whether the render happened to emit them:
 * a layer bound to a rig part is driven entirely by the pose, so it must be cleared when
 * the pose leaves it empty - otherwise an arm that moved off-canvas would keep stale
 * pixels while an arm that was empty in the rest frame would keep unrelated artwork.
 * Layers the rig does not own (effects, a held prop) are the destination's own and are
 * left untouched, because a rig renders from the rest frame and knows nothing about them.
 */
function bakeRenderedCels(
  ctx: CommandContext,
  frameId: string,
  cels: Map<string, PixelBuffer>,
  partLayerIds: Set<string>,
): BakeOutcome {
  const frame = ctx.sprite.frames.find((candidate) => candidate.id === frameId);
  if (!frame) throw new Error(`Unknown frame: ${frameId}`);
  const nameOf = (layerId: string): string =>
    ctx.sprite.layers.find((layer) => layer.id === layerId)?.name ?? layerId;
  const preservedLayers: string[] = [];
  const clearedPartLayers: string[] = [];
  const markCleared = (layerId: string): void => {
    const name = nameOf(layerId);
    if (!clearedPartLayers.includes(name)) clearedPartLayers.push(name);
  };
  for (const layerId of [...frame.cels.keys()]) {
    if (cels.has(layerId)) continue;
    if (partLayerIds.has(layerId)) markCleared(layerId);
    else preservedLayers.push(nameOf(layerId));
  }
  for (const layerId of partLayerIds) {
    if (!cels.has(layerId) && frame.cels.has(layerId)) markCleared(layerId);
  }
  for (const [layerId, buffer] of cels) {
    if (buffer.isEmpty()) {
      // A pose that pushed this part off-canvas yields an empty buffer; the destination
      // must not keep whatever the layer held before.
      if (frame.cels.has(layerId)) frame.cels.delete(layerId);
      if (partLayerIds.has(layerId)) markCleared(layerId);
    } else {
      frame.cels.set(layerId, buffer);
    }
  }
  return { preservedLayers, clearedPartLayers };
}

/** Every layer id any rig part owns, i.e. the layers a pose bake is allowed to clear. */
function rigPartLayerIds(rig: SpriteRig): Set<string> {
  return new Set(rig.parts.flatMap((part) => part.layerIds));
}

/** Baking onto the rest frame would overwrite the rig's own source of truth. */
function assertNotRestFrame(rig: SpriteRig, frameId: string, commandName: string): void {
  if (rig.restFrameId === frameId) {
    throw new Error(
      `${commandName} cannot write to the rig rest frame. Poses are rendered from it, so overwriting it corrupts every later render. Pass a different targetFrame.`,
    );
  }
}

export const createRigCommand = defineCommand({
  name: 'create_rig',
  description:
    'Create a persistent character rig bound to existing layer IDs and a rest frame. Parts may reference parents by name. Identity poses leave the rest pixels unchanged.',
  params: z.object({
    restFrame: frameRefSchema.optional().describe('Rest/bind frame. Defaults to frame 0.'),
    replace: z.boolean().optional().describe('Replace an existing rig. Defaults to false.'),
    parts: z.array(z.object({
      name: z.string().min(1),
      pivot: pointSchema,
      layers: z.array(layerRefSchema).min(1).optional().describe('Layer IDs/names/indices. Defaults to the layer with the same name as the part.'),
      parent: z.string().optional().describe('Parent part name, resolved after all parts are created.'),
    }).strict()).min(1).max(64),
  }),
  apply(ctx, p) {
    if (ctx.sprite.rig && !p.replace) throw new Error('This sprite already has a rig. Pass replace: true to rebuild it.');
    // Rebuilding drops every stored pose, tween, anchor and hitbox, so the caller has to
    // be told what went away rather than discovering it at the next preview.
    const previous = ctx.sprite.rig
      ? {
          parts: ctx.sprite.rig.parts.length,
          poses: ctx.sprite.rig.poses.length,
          tweens: ctx.sprite.rig.tweens.length,
          anchors: ctx.sprite.rig.anchors.length,
          hitboxes: ctx.sprite.rig.hitboxes.length,
        }
      : null;
    const restFrameId = p.restFrame === undefined
      ? ctx.sprite.frames[0].id
      : resolveFrameId(ctx.sprite, p.restFrame);
    const rest = ctx.sprite.frames.find((frame) => frame.id === restFrameId);
    if (!rest) throw new Error('Unknown rest frame.');
    const byName = new Map<string, RigPart>();
    const parts: RigPart[] = p.parts.map((part) => {
      const layerIds = part.layers
        ? part.layers.map((ref) => resolveLayerId(ctx.sprite, ref))
        : [resolveLayerId(ctx.sprite, part.name)];
      const created: RigPart = { id: makeId('part'), name: part.name, layerIds, pivot: part.pivot };
      byName.set(part.name, created);
      return created;
    });
    // Resolve parents only after every generated ID is known.
    p.parts.forEach((part, index) => {
      if (!part.parent) return;
      const parent = byName.get(part.parent);
      if (!parent) throw new Error(`Unknown parent part: ${part.parent}`);
      parts[index].parentId = parent.id;
    });
    validateUniquePartNames(parts);
    validateLayerOwnership(parts);
    validatePartHierarchy(parts);
    const rig: SpriteRig = {
      restFrameId: rest.id,
      parts,
      poses: [{ id: makeId('pose'), name: 'identity', transforms: {} }],
      tweens: [],
      anchors: [],
      hitboxes: [],
    };
    ctx.sprite.rig = rig;
    return {
      restFrameId: rest.id,
      parts: parts.map((part) => ({ id: part.id, name: part.name, parentId: part.parentId, layerIds: part.layerIds, pivot: part.pivot })),
      ...(previous
        ? { replacedRig: previous, discarded: ['poses', 'tweens', 'anchors', 'hitboxes'] }
        : {}),
    };
  },
});

function resolveFrameId(sprite: Sprite, ref: string | number): string {
  const frame = sprite.frames.find((candidate, index) => index === ref || candidate.id === ref);
  if (!frame) throw new Error(`Unknown frame: ${ref}`);
  return frame.id;
}

function resolveLayerId(sprite: Sprite, ref: string | number): string {
  const layer = sprite.layers.find((candidate, index) => index === ref || candidate.id === ref || candidate.name === ref);
  if (!layer) throw new Error(`Unknown layer: ${ref}`);
  return layer.id;
}

export const addPartCommand = defineCommand({
  name: 'add_part',
  description: 'Add a layer-bound part with a stable pivot and optional parent.',
  params: z.object({
    name: z.string().min(1),
    pivot: pointSchema,
    layers: z.array(layerRefSchema).min(1),
    parent: partRefSchema.optional(),
  }),
  apply(ctx, p) {
    const rig = requireRig(ctx.sprite);
    if (rig.parts.some((part) => part.name === p.name)) throw new Error(`Rig part already exists: ${p.name}`);
    const parent = p.parent ? requirePart(rig, p.parent) : undefined;
    const part: RigPart = {
      id: makeId('part'),
      name: p.name,
      pivot: p.pivot,
      layerIds: p.layers.map((ref) => resolveLayerId(ctx.sprite, ref)),
      ...(parent ? { parentId: parent.id } : {}),
    };
    validateLayerOwnership([...rig.parts, part]);
    validatePartHierarchy([...rig.parts, part]);
    rig.parts.push(part);
    return { partId: part.id, name: part.name };
  },
});

export const updatePartCommand = defineCommand({
  name: 'update_part',
  description: 'Update a rig part pivot, display name, parent or layer ownership.',
  params: z.object({
    part: partRefSchema,
    name: z.string().min(1).optional(),
    pivot: pointSchema.optional(),
    layers: z.array(layerRefSchema).min(1).optional(),
    parent: partRefSchema.nullable().optional(),
  }),
  apply(ctx, p) {
    const rig = requireRig(ctx.sprite);
    const part = requirePart(rig, p.part);
    const nextName = p.name ?? part.name;
    if (nextName !== part.name && rig.parts.some((candidate) => candidate.name === nextName)) {
      throw new Error(`Rig part already exists: ${nextName}`);
    }
    const nextLayers = p.layers ? p.layers.map((ref) => resolveLayerId(ctx.sprite, ref)) : part.layerIds;
    const parent = p.parent === null
      ? undefined
      : p.parent !== undefined
        ? requirePart(rig, p.parent)
        : part.parentId
          ? rig.parts.find((candidate) => candidate.id === part.parentId)
          : undefined;
    if (parent?.id === part.id) throw new Error('A rig part cannot parent itself.');
    const next: RigPart = {
      ...part,
      name: nextName,
      pivot: p.pivot ?? { ...part.pivot },
      layerIds: [...nextLayers],
    };
    if (parent) next.parentId = parent.id;
    else delete next.parentId;
    const nextParts = rig.parts.map((candidate) => candidate.id === part.id ? next : candidate);
    validateLayerOwnership(nextParts);
    validatePartHierarchy(nextParts);
    Object.assign(part, next);
    // Object.assign only copies keys present on the source, so a cleared parent has to be
    // deleted explicitly or the old parentId silently survives.
    if (parent) part.parentId = parent.id;
    else delete part.parentId;
    return { partId: part.id, name: part.name, parentId: part.parentId ?? null };
  },
});

export const removePartCommand = defineCommand({
  name: 'remove_part',
  description: 'Remove a leaf rig part and its pose transforms, anchors and hitboxes.',
  params: z.object({ part: partRefSchema }),
  apply(ctx, p) {
    const rig = requireRig(ctx.sprite);
    const part = requirePart(rig, p.part);
    if (rig.parts.some((candidate) => candidate.parentId === part.id)) {
      throw new Error(`Remove or reparent child parts before removing ${part.name}.`);
    }
    rig.parts = rig.parts.filter((candidate) => candidate.id !== part.id);
    for (const pose of rig.poses) delete pose.transforms[part.id];
    rig.anchors = rig.anchors.filter((anchor) => anchor.partId !== part.id);
    rig.hitboxes = rig.hitboxes.filter((hitbox) => hitbox.partId !== part.id);
    return { removed: part.id, name: part.name };
  },
});

export const getRigCommand = defineCommand({
  name: 'get_rig',
  description: 'Read the persistent rig, parts, poses, tweens, anchors and hitboxes.',
  readOnly: true,
  params: z.object({}),
  apply(ctx) {
    const rig = requireRig(ctx.sprite);
    return {
      rig: JSON.parse(JSON.stringify(rig)) as SpriteRig,
      partCount: rig.parts.length,
      poseCount: rig.poses.length,
      tweenCount: rig.tweens.length,
    };
  },
});

export const savePoseCommand = defineCommand({
  name: 'save_pose',
  description: 'Create or update a named sparse pose. Unspecified parts keep their previous value; pass `null` for a part to clear its transform.',
  params: z.object({
    pose: poseRefSchema.optional(),
    name: z.string().min(1).optional(),
    transforms: z.record(z.string(), partTransformSchema.nullable()),
  }),
  apply(ctx, p) {
    const rig = requireRig(ctx.sprite);
    const existing = p.pose ? requirePose(rig, p.pose) : undefined;
    const name = p.name ?? existing?.name;
    if (!name) throw new Error('A new pose requires `name`.');
    if (rig.poses.some((pose) => pose.name === name && pose.id !== existing?.id)) throw new Error(`Pose already exists: ${name}`);
    // A null value removes that part's transform, so a pose can be reset per part
    // without rewriting every remaining entry by hand.
    const transforms: Record<string, PartTransform> = { ...(existing?.transforms ?? {}) };
    const cleared: string[] = [];
    for (const [partId, value] of Object.entries(p.transforms)) {
      if (value === null) {
        if (partId in transforms) cleared.push(partId);
        delete transforms[partId];
      } else {
        transforms[partId] = value;
      }
    }
    const pose: RigPose = existing ?? { id: makeId('pose'), name, transforms: {} };
    pose.name = name;
    pose.transforms = transforms;
    validatePose(rig, pose);
    if (!existing) rig.poses.push(pose);
    return {
      poseId: pose.id,
      name: pose.name,
      transformCount: Object.keys(pose.transforms).length,
      ...(cleared.length ? { clearedParts: cleared } : {}),
    };
  },
});

export const removePoseCommand = defineCommand({
  name: 'remove_pose',
  description: 'Remove a pose and any tweens that reference it.',
  params: z.object({ pose: poseRefSchema }),
  apply(ctx, p) {
    const rig = requireRig(ctx.sprite);
    const pose = requirePose(rig, p.pose);
    rig.poses = rig.poses.filter((candidate) => candidate.id !== pose.id);
    rig.tweens = rig.tweens.filter((tween) => tween.fromPoseId !== pose.id && tween.toPoseId !== pose.id);
    return { removed: pose.id, name: pose.name };
  },
});

export const saveTweenCommand = defineCommand({
  name: 'save_tween',
  description: 'Create or update a reusable pose-to-pose tween definition.',
  params: z.object({
    tween: tweenRefSchema.optional(),
    name: z.string().min(1).optional(),
    from: poseRefSchema,
    to: poseRefSchema,
    durationMs: z.number().int().min(1),
    easing: z.enum(['linear', 'step', 'ease-in', 'ease-out', 'ease-in-out']).optional(),
  }),
  apply(ctx, p) {
    const rig = requireRig(ctx.sprite);
    const existing = p.tween ? findRigTween(rig, p.tween) : undefined;
    const name = p.name ?? existing?.name;
    if (!name) throw new Error('A new tween requires `name`.');
    if (rig.tweens.some((candidate) => candidate.name === name && candidate.id !== existing?.id)) throw new Error(`Tween already exists: ${name}`);
    const tween: RigTween = existing ?? { id: makeId('tween'), name, fromPoseId: '', toPoseId: '', durationMs: p.durationMs, easing: p.easing ?? 'linear' };
    tween.name = name;
    tween.fromPoseId = requirePose(rig, p.from).id;
    tween.toPoseId = requirePose(rig, p.to).id;
    tween.durationMs = p.durationMs;
    tween.easing = p.easing ?? tween.easing;
    if (!existing) rig.tweens.push(tween);
    return { tweenId: tween.id, name: tween.name };
  },
});

export const removeTweenCommand = defineCommand({
  name: 'remove_tween',
  description: 'Remove a stored tween definition.',
  params: z.object({ tween: tweenRefSchema }),
  apply(ctx, p) {
    const rig = requireRig(ctx.sprite);
    const tween = findRigTween(rig, p.tween);
    rig.tweens = rig.tweens.filter((candidate) => candidate.id !== tween.id);
    return { removed: tween.id, name: tween.name };
  },
});

export const evaluatePoseCommand = defineCommand({
  name: 'evaluate_pose',
  description: 'Read the world transform and local bounds a pose would produce without baking pixels.',
  readOnly: true,
  params: z.object({ pose: poseRefSchema }),
  apply(ctx, p) {
    const rig = requireRig(ctx.sprite);
    const pose = requirePose(rig, p.pose);
    const evaluated = evaluateRig(ctx.sprite, pose);
    return {
      poseId: pose.id,
      name: pose.name,
      parts: rig.parts.map((part) => ({
        partId: part.id,
        name: part.name,
        transform: evaluated.world.get(part.id),
      })),
    };
  },
});

function poseBakeCommand(name: string, description: string) {
  return defineCommand({
    name,
    description,
    params: z.object({
      pose: poseRefSchema,
      frame: frameRefSchema.optional().describe('Legacy target frame alias. Pass either frame or targetFrame explicitly.'),
      targetFrame: frameRefSchema.optional().describe('Explicit target frame. Required; never defaulted to frame 0.'),
      overwrite: z.boolean().optional().describe('Required when the target frame already contains pixels.'),
    }),
    apply(ctx, p) {
      const rig = requireRig(ctx.sprite);
      const pose = requirePose(rig, p.pose);
      if ((p.frame === undefined) === (p.targetFrame === undefined)) {
        throw new Error('Pass exactly one of frame or targetFrame.');
      }
      const frameRef = p.targetFrame ?? p.frame!;
      const frame = ctx.sprite.frames.find((candidate, index) => index === frameRef || candidate.id === frameRef);
      if (!frame) throw new Error(`Unknown frame: ${frameRef}`);
      if (!p.overwrite && frameHasPixels(ctx.sprite, frame.id)) {
        throw new Error(`Target frame ${frame.id} already contains pixels. Pass overwrite: true to replace it from the rest pose.`);
      }
      assertNotRestFrame(rig, frame.id, name);
      const rendered = renderPose(ctx.sprite, pose);
      const outcome = bakeRenderedCels(ctx, frame.id, rendered.cels, rigPartLayerIds(rig));
      return {
        poseId: pose.id,
        frameId: frame.id,
        partBounds: rendered.partBounds,
        partBoundsById: rendered.partBoundsById,
        partPixels: rendered.partPixels,
        clippedParts: rendered.clippedParts,
        ...(outcome.preservedLayers.length ? { preservedLayers: outcome.preservedLayers } : {}),
        ...(outcome.clearedPartLayers.length ? { clearedPartLayers: outcome.clearedPartLayers } : {}),
      };
    },
  });
}

export const bakePoseCommand = poseBakeCommand('bake_pose', 'Render a saved pose from the rig rest frame into one explicit target frame.');
export const applyPoseCommand = poseBakeCommand('apply_pose', 'Compatibility alias for bake_pose: apply a saved pose to an explicit frame.');
export const drawPoseCommand = poseBakeCommand('draw_pose', 'Compatibility alias for bake_pose: draw a saved pose into an explicit frame.');

export const tweenPoseCommand = defineCommand({
  name: 'tween_pose',
  description: 'Bake evenly sampled frames between two poses into consecutive target frames, appending any missing frames.',
  params: z.object({
    from: poseRefSchema,
    to: poseRefSchema,
    targetFrame: frameRefSchema.optional().describe('First destination frame. Defaults to the frame after the rest frame.'),
    steps: z.number().int().min(2).max(128).optional().describe('Number of baked frames. Defaults to 4.'),
    durationMs: z.number().int().min(1).optional().describe('Total tween duration. Split evenly across frames. Defaults to 400.'),
    easing: z.enum(['linear', 'step', 'ease-in', 'ease-out', 'ease-in-out']).optional(),
    overwrite: z.boolean().optional(),
  }),
  apply(ctx, p) {
    const rig = requireRig(ctx.sprite);
    const from = requirePose(rig, p.from);
    const to = requirePose(rig, p.to);
    const steps = p.steps ?? 4;
    const targetStart = p.targetFrame === undefined
      ? ctx.sprite.frames.findIndex((frame) => frame.id === rig.restFrameId) + 1
      : ctx.sprite.frames.findIndex((frame, index) => index === p.targetFrame || frame.id === p.targetFrame);
    if (targetStart < 0) throw new Error(`Unknown target frame: ${p.targetFrame}`);
    const restIndex = ctx.sprite.frames.findIndex((frame) => frame.id === rig.restFrameId);
    if (targetStart <= restIndex) {
      throw new Error(
        `tween_pose would write the rig rest frame. Samples are rendered from the rest frame, so overwriting it corrupts every later render. Start the tween after frame ${restIndex}.`,
      );
    }
    if (!p.overwrite) {
      for (let i = 0; i < steps; i++) {
        const existing = ctx.sprite.frames[targetStart + i];
        if (existing && frameHasPixels(ctx.sprite, existing.id)) {
          throw new Error(`Target frame ${targetStart + i} already contains pixels. Pass overwrite: true.`);
        }
      }
    }
    const perFrame = Math.max(1, Math.round((p.durationMs ?? 400) / steps));
    // Render the whole sample set before writing any destination frame, so every sample
    // is derived from the same untouched rest pose.
    const renderedFrames = Array.from({ length: steps }, (_, i) => {
      const progress = steps === 1 ? 1 : i / (steps - 1);
      return renderInterpolatedPose(ctx.sprite, from, to, progress, p.easing ?? 'linear');
    });
    const frameIds: string[] = [];
    const preservedLayers = new Set<string>();
    const clearedPartLayers = new Set<string>();
    const partLayerIds = rigPartLayerIds(rig);
    for (let i = 0; i < steps; i++) {
      let frame = ctx.sprite.frames[targetStart + i];
      if (!frame) {
        frame = { id: makeId('frm'), durationMs: perFrame, cels: new Map() };
        ctx.sprite.frames.push(frame);
      }
      frame.durationMs = perFrame;
      const outcome = bakeRenderedCels(ctx, frame.id, renderedFrames[i].cels, partLayerIds);
      for (const layerName of outcome.preservedLayers) preservedLayers.add(layerName);
      for (const layerName of outcome.clearedPartLayers) clearedPartLayers.add(layerName);
      frameIds.push(frame.id);
    }
    return {
      fromPoseId: from.id,
      toPoseId: to.id,
      frameIds,
      steps,
      durationMs: perFrame * steps,
      ...(preservedLayers.size ? { preservedLayers: [...preservedLayers] } : {}),
      ...(clearedPartLayers.size ? { clearedPartLayers: [...clearedPartLayers] } : {}),
    };
  },
});

export const transformPartCommand = defineCommand({
  name: 'transform_part',
  description: 'Destructively transform all layers bound to one rig part in one frame, using its stored pivot unless overridden.',
  params: z.object({
    part: partRefSchema,
    frame: frameRefSchema.optional().describe('Legacy target frame alias. Pass either frame or targetFrame explicitly.'),
    targetFrame: frameRefSchema.optional().describe('Explicit target frame. Required; never defaulted to frame 0.'),
    pivot: pointSchema.optional(),
    dx: z.number().optional(),
    dy: z.number().optional(),
    rotationDegrees: z.number().optional(),
    scaleX: z.number().positive().max(8).optional(),
    scaleY: z.number().positive().max(8).optional(),
  }),
  apply(ctx, p) {
    const rig = requireRig(ctx.sprite);
    const part = requirePart(rig, p.part);
    if ((p.frame === undefined) === (p.targetFrame === undefined)) {
      throw new Error('Pass exactly one of frame or targetFrame.');
    }
    const frameRef = p.targetFrame ?? p.frame!;
    const frame = ctx.sprite.frames.find((candidate, index) => index === frameRef || candidate.id === frameRef);
    if (!frame) throw new Error(`Unknown frame: ${frameRef}`);
    // This command rasterises pixels in place, so hitting the rest frame would rewrite the
    // rig's own source of truth and make every later pose render drift further off.
    assertNotRestFrame(rig, frame.id, 'transform_part');
    const transform = {
      dx: p.dx ?? 0,
      dy: p.dy ?? 0,
      rotationDegrees: p.rotationDegrees ?? 0,
      scaleX: p.scaleX ?? 1,
      scaleY: p.scaleY ?? 1,
    };
    let cels = 0;
    for (const layerId of part.layerIds) {
      const source = frame.cels.get(layerId);
      if (!source) continue;
      frame.cels.set(layerId, transformBufferAbout(source, p.pivot ?? part.pivot, transform));
      cels++;
    }
    if (cels === 0) {
      throw new Error(
        `Frame ${frame.id} has no cel for part ${part.name} (layers: ${part.layerIds.join(', ') || 'none'}). Draw the part on that frame first, or bake a pose into it.`,
      );
    }
    return { partId: part.id, frameId: frame.id, cels, pivot: p.pivot ?? part.pivot, ...transform };
  },
});

export const setAnchorCommand = defineCommand({
  name: 'set_anchor',
  description: 'Create or update a named rig anchor, optionally attached to a part.',
  params: z.object({
    anchor: z.string().optional(),
    name: z.string().min(1),
    part: partRefSchema.optional(),
    point: pointSchema,
  }),
  apply(ctx, p) {
    const rig = requireRig(ctx.sprite);
    const part = p.part ? requirePart(rig, p.part) : undefined;
    const existing = p.anchor ? rig.anchors.find((anchor) => anchor.id === p.anchor || anchor.name === p.anchor) : undefined;
    if (!existing && rig.anchors.some((anchor) => anchor.name === p.name)) throw new Error(`Anchor already exists: ${p.name}`);
    const anchor: RigAnchor = existing ?? { id: makeId('anc'), name: p.name, x: p.point.x, y: p.point.y };
    anchor.name = p.name;
    anchor.x = p.point.x;
    anchor.y = p.point.y;
    if (part) anchor.partId = part.id;
    else if (!existing) delete anchor.partId;
    if (!existing) rig.anchors.push(anchor);
    return { anchorId: anchor.id, name: anchor.name, partId: anchor.partId };
  },
});

export const removeAnchorCommand = defineCommand({
  name: 'remove_anchor',
  description: 'Remove a rig anchor.',
  params: z.object({ anchor: z.string() }),
  apply(ctx, p) {
    const rig = requireRig(ctx.sprite);
    const index = rig.anchors.findIndex((anchor) => anchor.id === p.anchor || anchor.name === p.anchor);
    if (index < 0) throw new Error(`Unknown anchor: ${p.anchor}`);
    const [removed] = rig.anchors.splice(index, 1);
    return { removed: removed.id, name: removed.name };
  },
});

export const setHitboxCommand = defineCommand({
  name: 'set_hitbox',
  description: 'Create or update a local-space rig hitbox, optionally attached to a part.',
  params: z.object({
    hitbox: z.string().optional(),
    name: z.string().min(1),
    part: partRefSchema.optional(),
    rect: rectSchema,
    rotationDegrees: z.number().optional(),
  }),
  apply(ctx, p) {
    const rig = requireRig(ctx.sprite);
    const part = p.part ? requirePart(rig, p.part) : undefined;
    const existing = p.hitbox ? rig.hitboxes.find((hitbox) => hitbox.id === p.hitbox || hitbox.name === p.hitbox) : undefined;
    if (!existing && rig.hitboxes.some((hitbox) => hitbox.name === p.name)) throw new Error(`Hitbox already exists: ${p.name}`);
    const hitbox: RigHitbox = existing ?? { id: makeId('hit'), name: p.name, x: p.rect.x, y: p.rect.y, width: p.rect.w, height: p.rect.h };
    hitbox.name = p.name;
    hitbox.x = p.rect.x;
    hitbox.y = p.rect.y;
    hitbox.width = p.rect.w;
    hitbox.height = p.rect.h;
    if (p.rotationDegrees !== undefined) hitbox.rotationDegrees = p.rotationDegrees;
    if (part) hitbox.partId = part.id;
    else if (!existing) delete hitbox.partId;
    if (!existing) rig.hitboxes.push(hitbox);
    return { hitboxId: hitbox.id, name: hitbox.name, partId: hitbox.partId };
  },
});

export const removeHitboxCommand = defineCommand({
  name: 'remove_hitbox',
  description: 'Remove a rig hitbox.',
  params: z.object({ hitbox: z.string() }),
  apply(ctx, p) {
    const rig = requireRig(ctx.sprite);
    const index = rig.hitboxes.findIndex((hitbox) => hitbox.id === p.hitbox || hitbox.name === p.hitbox);
    if (index < 0) throw new Error(`Unknown hitbox: ${p.hitbox}`);
    const [removed] = rig.hitboxes.splice(index, 1);
    return { removed: removed.id, name: removed.name };
  },
});

export const rigCommands = [
  createRigCommand,
  addPartCommand,
  updatePartCommand,
  removePartCommand,
  getRigCommand,
  savePoseCommand,
  removePoseCommand,
  saveTweenCommand,
  removeTweenCommand,
  evaluatePoseCommand,
  bakePoseCommand,
  applyPoseCommand,
  drawPoseCommand,
  tweenPoseCommand,
  transformPartCommand,
  setAnchorCommand,
  removeAnchorCommand,
  setHitboxCommand,
  removeHitboxCommand,
];
