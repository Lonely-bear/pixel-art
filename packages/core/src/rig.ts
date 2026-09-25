import { PixelBuffer } from './buffer.js';
import {
  getFrame,
  type PartTransform,
  type RigPart,
  type RigPose,
  type RigTween,
  type Sprite,
  type SpriteRig,
} from './document.js';
import { compositeFrame } from './render.js';
import {
  affineFromPartTransform,
  IDENTITY_TRANSFORM,
  multiplyAffine,
  transformBufferAffine,
  type AffineTransform,
} from './transform.js';

export type PartBounds = { x: number; y: number; w: number; h: number };

export interface EvaluatedRig {
  world: Map<string, AffineTransform>;
  partBounds: Record<string, PartBounds | null>;
  partBoundsById: Record<string, PartBounds | null>;
}

export interface PartPixelReport {
  part: string;
  partId: string;
  sourcePixels: number;
  outputPixels: number;
}

export interface ClippedPartReport extends PartPixelReport {
  reason: 'moved fully off-canvas' | 'extends past the canvas edge';
  sourceBounds: PartBounds | null;
  outputBounds: PartBounds | null;
}

export interface RenderedPose {
  buffer: PixelBuffer;
  cels: Map<string, PixelBuffer>;
  world: Map<string, AffineTransform>;
  partBounds: Record<string, PartBounds | null>;
  partBoundsById: Record<string, PartBounds | null>;
  clippedParts: ClippedPartReport[];
  /**
   * Per-part source/output pixel counts. Same layer set on both sides, so a difference
   * here is resampling loss (holes from an arbitrary-angle rotation), never a
   * false positive caused by two layers of one part overlapping each other.
   */
  partPixels: PartPixelReport[];
}

/** Smallest rect containing both inputs; `null` means "no opaque pixels yet". */
function unionBounds(a: PartBounds | null, b: PartBounds | null): PartBounds | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

function boundsOutside(bounds: PartBounds, width: number, height: number): boolean {
  return bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.w > width || bounds.y + bounds.h > height;
}

export function requireRig(sprite: Sprite): SpriteRig {
  if (!sprite.rig) throw new Error('This sprite has no rig. Run create_rig first.');
  return sprite.rig;
}

export function findRigPart(rig: SpriteRig, ref: string): RigPart {
  const part = rig.parts.find((candidate) => candidate.id === ref || candidate.name === ref);
  if (!part) throw new Error(`Unknown rig part: ${ref}`);
  return part;
}

export function findRigPose(rig: SpriteRig, ref: string): RigPose {
  const pose = rig.poses.find((candidate) => candidate.id === ref || candidate.name === ref);
  if (!pose) throw new Error(`Unknown pose: ${ref}`);
  return pose;
}

export function findRigTween(rig: SpriteRig, ref: string): RigTween {
  const tween = rig.tweens.find((candidate) => candidate.id === ref || candidate.name === ref);
  if (!tween) throw new Error(`Unknown tween: ${ref}`);
  return tween;
}

function normalizedTransform(transform: PartTransform | undefined): Required<PartTransform> {
  return {
    dx: transform?.dx ?? 0,
    dy: transform?.dy ?? 0,
    rotationDegrees: transform?.rotationDegrees ?? 0,
    scaleX: transform?.scaleX ?? 1,
    scaleY: transform?.scaleY ?? 1,
  };
}

function mix(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

export function applyEasing(value: number, easing: RigTween['easing']): number {
  const t = Math.min(1, Math.max(0, value));
  if (easing === 'step') return t < 1 ? 0 : 1;
  if (easing === 'ease-in') return t * t;
  if (easing === 'ease-out') return 1 - (1 - t) * (1 - t);
  if (easing === 'ease-in-out') return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  return t;
}

export function interpolatePose(
  rig: SpriteRig,
  from: RigPose,
  to: RigPose,
  progress: number,
  easing: RigTween['easing'] = 'linear',
): Record<string, PartTransform> {
  const t = applyEasing(progress, easing);
  const partIds = new Set([...Object.keys(from.transforms), ...Object.keys(to.transforms)]);
  const transforms: Record<string, PartTransform> = {};
  for (const partId of partIds) {
    const a = normalizedTransform(from.transforms[partId]);
    const b = normalizedTransform(to.transforms[partId]);
    transforms[partId] = {
      dx: mix(a.dx, b.dx, t),
      dy: mix(a.dy, b.dy, t),
      rotationDegrees: mix(a.rotationDegrees, b.rotationDegrees, t),
      scaleX: mix(a.scaleX, b.scaleX, t),
      scaleY: mix(a.scaleY, b.scaleY, t),
    };
  }
  // Parts absent from both source poses must remain identity as well.
  for (const part of rig.parts) {
    if (!transforms[part.id]) transforms[part.id] = normalizedTransform(undefined);
  }
  return transforms;
}

export function evaluateRig(sprite: Sprite, pose: RigPose): EvaluatedRig {
  const rig = requireRig(sprite);
  const world = new Map<string, AffineTransform>();
  const visiting = new Set<string>();
  const resolved = new Set<string>();
  const byId = new Map(rig.parts.map((part) => [part.id, part]));

  const resolve = (part: RigPart): AffineTransform => {
    const existing = world.get(part.id);
    if (existing) return existing;
    if (visiting.has(part.id)) throw new Error(`Rig part cycle detected at ${part.name}.`);
    visiting.add(part.id);
    const local = affineFromPartTransform(pose.transforms[part.id], part.pivot);
    let matrix = local;
    if (part.parentId) {
      const parent = byId.get(part.parentId);
      if (!parent) throw new Error(`Rig part ${part.name} references missing parent ${part.parentId}.`);
      matrix = multiplyAffine(resolve(parent), local);
    }
    visiting.delete(part.id);
    resolved.add(part.id);
    world.set(part.id, matrix);
    return matrix;
  };

  for (const part of rig.parts) {
    if (!resolved.has(part.id)) resolve(part);
  }
  return { world, partBounds: {}, partBoundsById: {} };
}

function opaqueCount(buffer: PixelBuffer): number {
  let count = 0;
  for (let i = 3; i < buffer.data.length; i += 4) {
    if (buffer.data[i] > 0) count++;
  }
  return count;
}

export function renderPose(sprite: Sprite, pose: RigPose): RenderedPose {
  const rig = requireRig(sprite);
  const rest = getFrame(sprite, rig.restFrameId);
  const evaluated = evaluateRig(sprite, pose);

  const cels = new Map<string, PixelBuffer>();
  const claimedLayers = new Set<string>();
  const clippedParts: RenderedPose['clippedParts'] = [];
  const partLoss: RenderedPose['partPixels'] = [];

  for (const part of rig.parts) {
    const matrix = evaluated.world.get(part.id) ?? IDENTITY_TRANSFORM;
    for (const layerId of part.layerIds) {
      claimedLayers.add(layerId);
      const source = rest.cels.get(layerId);
      if (!source) continue;
      cels.set(layerId, transformBufferAffine(source, matrix, { width: sprite.width, height: sprite.height }));
    }
  }

  for (const [layerId, source] of rest.cels) {
    if (!claimedLayers.has(layerId)) cels.set(layerId, source.clone());
  }

  for (const part of rig.parts) {
    // Union the per-layer opaque bounds instead of blitting the cels together:
    // PixelBuffer.blit copies transparent pixels too, so a blit-based union collapses
    // to the last layer and every identity preview would report fake clipping.
    let sourceBounds: PartBounds | null = null;
    let outputBounds: PartBounds | null = null;
    let sourcePixels = 0;
    let outputPixels = 0;
    for (const layerId of part.layerIds) {
      const source = rest.cels.get(layerId);
      if (source) {
        sourcePixels += opaqueCount(source);
        sourceBounds = unionBounds(sourceBounds, source.opaqueBounds());
      }
      const output = cels.get(layerId);
      if (output) {
        outputPixels += opaqueCount(output);
        outputBounds = unionBounds(outputBounds, output.opaqueBounds());
      }
    }
    evaluated.partBounds[part.name] = outputBounds;
    evaluated.partBoundsById[part.id] = outputBounds;
    if (sourcePixels === 0) {
      partLoss.push({ part: part.name, partId: part.id, sourcePixels: 0, outputPixels });
      continue;
    }
    const outsideCanvas = outputBounds !== null && boundsOutside(outputBounds, sprite.width, sprite.height);
    const vanished = outputPixels === 0;
    if (outsideCanvas || vanished) {
      clippedParts.push({
        part: part.name,
        partId: part.id,
        reason: vanished ? 'moved fully off-canvas' : 'extends past the canvas edge',
        sourceBounds,
        outputBounds,
        sourcePixels,
        outputPixels,
      });
    } else {
      partLoss.push({ part: part.name, partId: part.id, sourcePixels, outputPixels });
    }
  }

  const renderFrameId = '__rig_preview__';
  const renderSprite: Sprite = {
    ...sprite,
    rig: undefined,
    frames: [{ id: renderFrameId, durationMs: 100, cels: new Map(cels) }],
  };
  const buffer = compositeFrame(renderSprite, renderFrameId);
  return {
    buffer,
    cels,
    world: evaluated.world,
    partBounds: evaluated.partBounds,
    partBoundsById: evaluated.partBoundsById,
    clippedParts,
    partPixels: partLoss,
  };
}

export function renderInterpolatedPose(
  sprite: Sprite,
  from: RigPose,
  to: RigPose,
  progress: number,
  easing: RigTween['easing'] = 'linear',
): RenderedPose {
  const rig = requireRig(sprite);
  const pose: RigPose = {
    id: '__interpolated__',
    name: '__interpolated__',
    transforms: interpolatePose(rig, from, to, progress, easing),
  };
  return renderPose(sprite, pose);
}

export function transformPoint(matrix: AffineTransform, point: { x: number; y: number }): { x: number; y: number } {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  };
}

/**
 * A change of canvas coordinate system, expressed as the forward pixel mapping.
 *
 * Rig geometry (pivots, anchors, hitboxes) is stored in canvas coordinates, so any
 * command that resizes, crops, scales, flips or rotates artwork has to move that geometry
 * by exactly the same mapping as the pixels. Without this a `crop_canvas` leaves pivots
 * outside the new canvas and every later pose renders from the wrong joint - silently,
 * because nothing about the rig itself looks wrong.
 */
export type RigGeometryMapping = (point: { x: number; y: number }) => { x: number; y: number };

/** Canvas-space mapping produced by `resize_canvas` with an origin offset. */
export function rigTranslate(offsetX: number, offsetY: number): RigGeometryMapping {
  return (point) => ({ x: point.x + offsetX, y: point.y + offsetY });
}

/** Canvas-space mapping produced by `crop_canvas` to a rect. */
export function rigCrop(x: number, y: number): RigGeometryMapping {
  return rigTranslate(-x, -y);
}

/** Canvas-space mapping produced by `scale_sprite` with an integer factor. */
export function rigScale(factor: number): RigGeometryMapping {
  return (point) => ({ x: point.x * factor, y: point.y * factor });
}

/** Canvas-space mapping produced by `flip`. */
export function rigFlip(axis: 'horizontal' | 'vertical', width: number, height: number): RigGeometryMapping {
  return (point) => ({
    x: axis === 'horizontal' ? width - 1 - point.x : point.x,
    y: axis === 'vertical' ? height - 1 - point.y : point.y,
  });
}

/**
 * Canvas-space mapping produced by `rotate`.
 *
 * Matches `rotate90` exactly, including the width/height swap on odd quarter turns.
 */
export function rigRotate(turns: number, width: number, height: number): RigGeometryMapping {
  const t = ((turns % 4) + 4) % 4;
  if (t === 0) return (point) => ({ ...point });
  if (t === 2) return (point) => ({ x: width - 1 - point.x, y: height - 1 - point.y });
  if (t === 1) return (point) => ({ x: height - 1 - point.y, y: point.x });
  return (point) => ({ x: point.y, y: width - 1 - point.x });
}

/**
 * Move every canvas-space coordinate a rig stores through `map`.
 *
 * Hitboxes additionally carry a local rotation, which is a shape property rather than a
 * position, so only their origin moves. A scaling canvas turns that rotation into a
 * shear, so the caller passes `rescaleRotation` to drop it rather than report something
 * geometrically wrong.
 */
export function remapRigGeometry(sprite: Sprite, map: RigGeometryMapping, rescaleRotation = false): boolean {
  const rig = sprite.rig;
  if (!rig) return false;
  for (const part of rig.parts) part.pivot = map(part.pivot);
  for (const anchor of rig.anchors) {
    const next = map(anchor);
    anchor.x = next.x;
    anchor.y = next.y;
  }
  for (const hitbox of rig.hitboxes) {
    const next = map(hitbox);
    hitbox.x = next.x;
    hitbox.y = next.y;
    if (rescaleRotation && hitbox.rotationDegrees !== undefined) delete hitbox.rotationDegrees;
  }
  return true;
}

export function resolveRigGeometry(sprite: Sprite, pose: RigPose): {
  anchors: Array<Record<string, unknown>>;
  hitboxes: Array<Record<string, unknown>>;
} {
  const rig = requireRig(sprite);
  const evaluated = evaluateRig(sprite, pose);
  const matrixFor = (partId?: string): AffineTransform =>
    (partId ? evaluated.world.get(partId) : undefined) ?? IDENTITY_TRANSFORM;
  return {
    anchors: rig.anchors.map((anchor) => {
      const world = transformPoint(matrixFor(anchor.partId), anchor);
      return { ...anchor, world };
    }),
    hitboxes: rig.hitboxes.map((hitbox) => {
      const radians = ((hitbox.rotationDegrees ?? 0) * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const cx = hitbox.x + hitbox.width / 2;
      const cy = hitbox.y + hitbox.height / 2;
      const local = [
        { x: hitbox.x, y: hitbox.y },
        { x: hitbox.x + hitbox.width, y: hitbox.y },
        { x: hitbox.x + hitbox.width, y: hitbox.y + hitbox.height },
        { x: hitbox.x, y: hitbox.y + hitbox.height },
      ].map((point) => ({
        x: cx + (point.x - cx) * cos - (point.y - cy) * sin,
        y: cy + (point.x - cx) * sin + (point.y - cy) * cos,
      }));
      return { ...hitbox, polygon: local.map((point) => transformPoint(matrixFor(hitbox.partId), point)) };
    }),
  };
}
