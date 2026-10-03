import type { PartTransform, RigPart, RigPose, SpriteRig } from './document.js';
import type { RigGeometryMapping } from './rig.js';
import type { AffineTransform } from './transform.js';

/**
 * The eight directions, and the two drawings they are built from.
 *
 * The point of this module is that an 8-direction character set must not be eight hand-drawn
 * sheets. It is **three** drawings (a base facing E, an NE diagonal and an SE diagonal) plus
 * two exact transforms, because a mirror and a quarter turn are both lossless on a pixel grid
 * and are the only orientation changes a 2D transform can make faithfully. Anything a
 * transform cannot do - which is specifically the diagonal, because a diagonal is a
 * *drawing* difference and not a rotated copy of a cardinal - is reported as `exact: false`
 * rather than silently approximated.
 *
 * ## Chosen scheme: "E base, clockwise quarter turns, mirror last"
 *
 * The base pose is drawn **facing E (screen right)**. Every other direction is either a
 * whole-figure rotation about the orientation anchor or a horizontal mirror about the
 * anchor's vertical axis. `N` is screen-up, `S` is screen-down: on a top-down map screen-up
 * is *away* from the camera, so if you want the front-view reading where `N` faces the
 * viewer, swap the `N` and `S` rows and nothing else in this file changes structurally.
 *
 * ## Orientation anchors
 *
 * The transform is taken about a named **orientation anchor**, and the anchor is the point
 * every orientation must leave fixed - a turn in place, not a slide across the canvas:
 *
 * | anchor | default position | role |
 * | --- | --- | --- |
 * | `ground` | bottom centre, `{x: (w-1)/2, y: h-1}` | the contact point under the feet. The default, because a character changes direction by turning on the spot. |
 * | `facing` | top centre, `{x: (w-1)/2, y: 0}` | a marker on the head/shoulders; after the transform it must lie along `facing`. |
 * | `origin` | canvas centre, `{x: (w-1)/2, y: (h-1)/2}` | fallback when the sprite has no feet. |
 *
 * `ground` and `facing` share the vertical axis `x = (w-1)/2`, so a mirror about that axis
 * fixes both exactly - which is what makes the E/W pair an exact mirror rather than an
 * approximation of one.
 *
 * No trigonometry appears anywhere: quarter turns have integer coefficients, and
 * `packages/core/test/determinism.test.ts` bans the implementation-approximated maths from
 * `src`. That is also why there is no 45-degree diagonal transform here - it would need
 * `cos(45)`, and a diagonal is a drawing anyway.
 */

export type DirectionId = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

export type DirectionAnchorName = 'ground' | 'facing' | 'origin';

export interface DirectionSpec {
  id: DirectionId;
  /** Human label, read by an agent choosing a direction. */
  label: string;
  /** Compass position, clockwise from N: 0 = N, 4 = S. Used for ordering and interpolation. */
  compassIndex: number;
  /** Clockwise quarter turns of the whole figure about the orientation anchor. */
  turns: number;
  /** Horizontal mirror about the anchor's vertical axis, applied *after* `turns`. */
  mirror: boolean;
  /** Where the character looks, in canvas units. Y grows downward, so `N` is `(0, -1)`. */
  facing: { x: number; y: number };
  /** True when `turns` + `mirror` reproduce this direction exactly rather than approximately. */
  exact: boolean;
  /** The drawing this direction reuses: the base (`E`), or a diagonal that must be drawn. */
  drawing: DirectionId;
  /** The cardinal this direction's transform actually lands on; 45 degrees away when `!exact`. */
  resolvedFrom: DirectionId;
}

const SPECS: readonly DirectionSpec[] = [
  {
    id: 'N', label: 'north (screen up)', compassIndex: 0, turns: 3, mirror: false,
    facing: { x: 0, y: -1 }, exact: true, drawing: 'E', resolvedFrom: 'N',
  },
  {
    id: 'NE', label: 'north-east', compassIndex: 1, turns: 3, mirror: true,
    facing: { x: 1, y: -1 }, exact: false, drawing: 'NE', resolvedFrom: 'N',
  },
  {
    id: 'E', label: 'east (screen right, the base drawing)', compassIndex: 2, turns: 0, mirror: false,
    facing: { x: 1, y: 0 }, exact: true, drawing: 'E', resolvedFrom: 'E',
  },
  {
    id: 'SE', label: 'south-east', compassIndex: 3, turns: 1, mirror: false,
    facing: { x: 1, y: 1 }, exact: false, drawing: 'SE', resolvedFrom: 'S',
  },
  {
    id: 'S', label: 'south (screen down)', compassIndex: 4, turns: 1, mirror: false,
    facing: { x: 0, y: 1 }, exact: true, drawing: 'E', resolvedFrom: 'S',
  },
  {
    id: 'SW', label: 'south-west', compassIndex: 5, turns: 1, mirror: true,
    facing: { x: -1, y: 1 }, exact: false, drawing: 'SE', resolvedFrom: 'S',
  },
  {
    id: 'W', label: 'west (exact mirror of E)', compassIndex: 6, turns: 0, mirror: true,
    facing: { x: -1, y: 0 }, exact: true, drawing: 'E', resolvedFrom: 'W',
  },
  {
    id: 'NW', label: 'north-west', compassIndex: 7, turns: 3, mirror: false,
    facing: { x: -1, y: -1 }, exact: false, drawing: 'NE', resolvedFrom: 'N',
  },
];

/** The eight directions, clockwise from N. */
export const DIRECTIONS: readonly DirectionSpec[] = SPECS;

export const DIRECTION_IDS: readonly DirectionId[] = SPECS.map((spec) => spec.id);

/** The direction the base pose is drawn in. Everything else is derived from it. */
export const BASE_DIRECTION: DirectionId = 'E';

const BY_ID = new Map<string, DirectionSpec>(SPECS.map((spec) => [spec.id, spec]));

export function isDirectionId(value: string): value is DirectionId {
  return BY_ID.has(value);
}

/** Resolve a direction id or case-insensitive label. Throws on an unknown name. */
export function directionSpec(ref: string): DirectionSpec {
  const upper = ref.trim().toUpperCase();
  const found = BY_ID.get(upper);
  if (!found) {
    throw new Error(`Unknown direction: ${ref}. Expected one of ${DIRECTION_IDS.join(', ')}.`);
  }
  return found;
}

/**
 * The direction a screen-space movement vector points at.
 *
 * Sign-based rather than angular: the octants are decided by the sign of each component,
 * so there is no `Math.atan2` and no zero-length special case beyond `x === 0 && y === 0`,
 * which returns the base direction.
 */
export function nearestDirection(vx: number, vy: number): DirectionId {
  const sx = vx > 0 ? 1 : vx < 0 ? -1 : 0;
  const sy = vy > 0 ? 1 : vy < 0 ? -1 : 0;
  if (sx === 0 && sy < 0) return 'N';
  if (sx > 0 && sy < 0) return 'NE';
  if (sx > 0 && sy === 0) return 'E';
  if (sx > 0 && sy > 0) return 'SE';
  if (sx === 0 && sy > 0) return 'S';
  if (sx < 0 && sy > 0) return 'SW';
  if (sx < 0 && sy === 0) return 'W';
  if (sx < 0 && sy < 0) return 'NW';
  return BASE_DIRECTION;
}

/** Default canvas position of a named orientation anchor. */
export function orientationAnchor(name: DirectionAnchorName, width: number, height: number): { x: number; y: number } {
  const cx = (width - 1) / 2;
  if (name === 'facing') return { x: cx, y: 0 };
  if (name === 'origin') return { x: cx, y: (height - 1) / 2 };
  return { x: cx, y: height - 1 };
}

/**
 * The exact canvas mapping that turns a figure drawn facing E into `spec`.
 *
 * Integer coefficients throughout: a clockwise quarter turn is a signed permutation of the
 * axes, and the mirror negates the output x-row. The translation pins the orientation
 * anchor, so the anchor is invariant under every direction - which is the whole point of
 * naming it.
 *
 * A quarter turn of a *non-square* canvas is mapped into the same canvas rather than into a
 * swapped one, so content can leave the frame. Use a square canvas for an 8-direction set;
 * this function does not resize anything.
 */
export function orientationAffine(spec: DirectionSpec, pivot: { x: number; y: number }): AffineTransform {
  const turns = ((spec.turns % 4) + 4) % 4;
  let a = 1;
  let b = 0;
  let c = 0;
  let d = 1;
  if (turns === 1) { a = 0; b = 1; c = -1; d = 0; }
  else if (turns === 2) { a = -1; b = 0; c = 0; d = -1; }
  else if (turns === 3) { a = 0; b = -1; c = 1; d = 0; }
  // The mirror is applied after the turn, so it negates the coefficients that multiply x in
  // the *output*: a figure facing S mirrored to the left still faces S but to the west side.
  if (spec.mirror) {
    // `|| 0` normalises the negative zero that negating an exact zero produces: `-0 === 0`
    // is true, so this changes no arithmetic, but it keeps the matrix printable and keeps a
    // `toEqual` comparison against a literal `0` from failing on a sign.
    a = -a || 0;
    c = -c || 0;
  }
  return {
    a, b, c, d,
    e: pivot.x - (a * pivot.x + c * pivot.y),
    f: pivot.y - (b * pivot.x + d * pivot.y),
  };
}

/** Apply an orientation affine to a point. Same convention as `transformPoint` in `rig.ts`. */
export function mapOrientationPoint(matrix: AffineTransform, point: { x: number; y: number }): { x: number; y: number } {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  };
}

/**
 * The orientation as a `RigGeometryMapping`, for remapping pivots, anchors and hitboxes
 * when a caller rotates the artwork itself rather than posing it.
 */
export function orientationGeometry(spec: DirectionSpec, pivot: { x: number; y: number }): RigGeometryMapping {
  const matrix = orientationAffine(spec, pivot);
  return (point) => mapOrientationPoint(matrix, point);
}

/* ------------------------------------------------------------------ *
 * Walk cycle
 * ------------------------------------------------------------------ */

export interface WalkCycleOptions {
  /** Frames in one full gait cycle. Two contacts per cycle, so even counts read best. */
  frames?: number;
  /** Peak horizontal foot travel, in pixels. */
  stride?: number;
  /** Peak body lift between a contact and the following passing frame, in pixels. */
  bob?: number;
  /** Peak leg tilt at the ends of the swing, in degrees. */
  legSwingDegrees?: number;
  /** Parts treated as legs, by name. Auto-detected from `leg`/`foot` when omitted. */
  legs?: string[];
  /** Parts treated as arms. Auto-detected from `arm`/`hand` when omitted. */
  arms?: string[];
  /** Parts that carry the body bob. Auto-detected from `body`/`torso`/`root` when omitted. */
  body?: string[];
  /** Whole frames to advance before frame 0, for staggering one loop against another. */
  phaseOffset?: number;
  /** Direction label used when naming the transient poses this cycle produces. */
  direction?: DirectionId;
}

export interface WalkCycleFrame {
  index: number;
  /** 0 at the first frame, rising to `(frames - 1) / frames`; never reaches 1. */
  phase: number;
  transforms: Record<string, PartTransform>;
}

const LEG_PATTERN = /(leg|foot|feet|thigh|shin)/i;
const ARM_PATTERN = /(arm|hand|forearm)/i;
const BODY_PATTERN = /(body|torso|hips|chest|root|spine|trunk)/i;

function namesMatch(parts: RigPart[], pattern: RegExp): RigPart[] {
  return parts.filter((part) => pattern.test(part.name));
}

export interface GaitParts {
  legs: RigPart[];
  arms: RigPart[];
  body: RigPart[];
  /** True when no part matched any auto-detection pattern and the roots are being used. */
  fallback: boolean;
}

/**
 * Assign rig parts to gait roles.
 *
 * Name matching is the default because a rig is authored by name (`create_rig` takes names,
 * and `save_pose` addresses parts by them), and a caller who named a part `legL` should not
 * have to repeat it in every generator call. Parts that match nothing fall back to the
 * parentless parts, so a single-part rig still gets a body bob instead of a still sprite.
 */
export function resolveGaitParts(rig: SpriteRig, options: WalkCycleOptions = {}): GaitParts {
  const pick = (refs: string[] | undefined, pattern: RegExp): RigPart[] => {
    if (!refs || refs.length === 0) return namesMatch(rig.parts, pattern);
    return refs.map((ref) => {
      const part = rig.parts.find((candidate) => candidate.id === ref || candidate.name === ref);
      if (!part) throw new Error(`Unknown rig part: ${ref}`);
      return part;
    });
  };
  const legs = pick(options.legs, LEG_PATTERN);
  const arms = pick(options.arms, ARM_PATTERN);
  let body = pick(options.body, BODY_PATTERN);
  let fallback = false;
  if (legs.length === 0 && arms.length === 0 && body.length === 0) {
    body = rig.parts.filter((part) => !part.parentId);
    fallback = true;
  }
  return { legs, arms, body, fallback };
}

/**
 * A triangle wave of period `2n` and height `n`, on integer arguments.
 *
 * Everything the gait needs is a triangle: two half-swing periods per leg per cycle and one
 * for the body. A sine would read the same in a still and would put `Math.sin` - which
 * `determinism.test.ts` bans from `src` - into a path that decides pixels.
 */
function triangle(t: number, n: number): number {
  const period = 2 * n;
  const m = ((t % period) + period) % period;
  return m < n ? m : period - m;
}

/**
 * A triangle of period `frames / 2`, so it peaks on *both* contacts of the cycle.
 *
 * `triangle` above has one peak per cycle, which puts the body bob's two lowest points a
 * half-cycle apart - the opposite of what a walk does, since a walk's two contacts are a
 * half-cycle apart too. This returns a phase in `[0, period)`: 0 is a contact and the peak
 * of the bob, `period - 1` is the passing frame.
 *
 * `frames = 2` has a half-cycle of one, which would be a constant wave, so the period is
 * floored at 2 - with two frames the body dips on one and rises on the other, which is the
 * only walk a two-frame cycle can express.
 */
function contactPhase(i: number, frames: number): number {
  const period = Math.max(2, Math.floor(frames / 2));
  return ((i % period) + period) % period;
}

/**
 * The per-part transforms for one frame of a walk cycle.
 *
 * Two contacts per cycle: leg A swings through `triangle(2i)` and leg B is half a cycle
 * behind it, so a foot is planted whenever the other is passing. The body bob is a quarter
 * cycle ahead of leg A, which puts its two lowest points exactly on the two contacts.
 *
 * The loop closes because every waveform has period `2n` in `t` and `i` is taken modulo `n`
 * - so `walkPose(n)` is byte-for-byte the same pose as `walkPose(0)`, with no duplicated end
 * frame and therefore no seam.
 */
export function walkCycleFrame(rig: SpriteRig, index: number, options: WalkCycleOptions = {}): WalkCycleFrame {
  const frames = Math.max(2, Math.floor(options.frames ?? 4));
  const stride = Math.max(0, Math.floor(options.stride ?? 2));
  const bob = Math.max(0, Math.floor(options.bob ?? 1));
  const legSwing = Math.max(0, Math.floor(options.legSwingDegrees ?? 6));
  const offset = Math.floor(options.phaseOffset ?? 0);
  const parts = resolveGaitParts(rig, options);

  const i = (((index + offset) % frames) + frames) % frames;
  const swingA = triangle(2 * i, frames);
  const swingB = triangle(2 * i + frames, frames);
  const bodyWave = contactPhase(i, frames);

  const swingTo = (wave: number): { dx: number; rotationDegrees: number } => ({
    dx: -stride + Math.round((2 * stride * wave) / frames),
    rotationDegrees: Math.round((legSwing * (2 * wave - frames)) / frames),
  });

  const transforms: Record<string, PartTransform> = {};
  parts.legs.forEach((part, slot) => {
    // The two legs alternate, so an odd part count leaves the last leg unpaired rather than
    // moving two legs at once.
    transforms[part.id] = slot % 2 === 0 ? swingTo(swingA) : swingTo(swingB);
  });
  parts.arms.forEach((part, slot) => {
    // Arms counter-swing against the opposite leg, which is what stops a walk reading as a
    // shuffle when only the legs are named.
    transforms[part.id] = swingTo(slot % 2 === 0 ? swingB : swingA);
  });
  const period = Math.max(2, Math.floor(frames / 2));
for (const part of parts.body) {
    // Phase 0 is the contact and the lowest point of the bob; phase `period - 1` is the
    // passing frame and the highest. Positive dy is downward, so this really does dip.
    const t = period > 1 ? bodyWave / (period - 1) : 0;
    transforms[part.id] = { dy: Math.round(bob * (1 - 2 * t)) };
  }
  return { index: i, phase: i / frames, transforms };
}

/** Every frame of one walk cycle, index 0..frames-1. */
export function walkCycleFrames(rig: SpriteRig, options: WalkCycleOptions = {}): WalkCycleFrame[] {
  const frames = Math.max(2, Math.floor(options.frames ?? 4));
  return Array.from({ length: frames }, (_, index) => walkCycleFrame(rig, index, options));
}

/**
 * One frame of a walk cycle as a `RigPose`, ready for `renderPose`.
 *
 * These poses are transient: the generator bakes pixels and does not push walk poses into
 * the rig, so a document never accumulates one pose per frame per direction.
 */
export function walkCyclePose(rig: SpriteRig, index: number, options: WalkCycleOptions = {}): RigPose {
  const direction = options.direction ?? BASE_DIRECTION;
  const frame = walkCycleFrame(rig, index, options);
  return { id: `walk_${direction.toLowerCase()}_${frame.index}`, name: `walk_${direction.toLowerCase()}_${frame.index}`, transforms: frame.transforms };
}

/** Everything a caller needs to describe one direction in a summary or a guide. */
export function describeDirection(
  spec: DirectionSpec,
  canvas: { width: number; height: number },
  anchor: DirectionAnchorName = 'ground',
): Record<string, unknown> {
  const pivot = orientationAnchor(anchor, canvas.width, canvas.height);
  const matrix = orientationAffine(spec, pivot);
  return {
    id: spec.id,
    label: spec.label,
    compassIndex: spec.compassIndex,
    facing: spec.facing,
    exact: spec.exact,
    drawing: spec.drawing,
    resolvedFrom: spec.resolvedFrom,
    turns: spec.turns,
    mirror: spec.mirror,
    anchor,
    pivot,
    matrix,
  };
}