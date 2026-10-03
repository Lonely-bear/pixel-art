import { describe, expect, it } from 'vitest';
import {
  createEditor,
  createSprite,
  transformBufferAffine,
  type AffineTransform,
} from '../src/index.js';
import {
  BASE_DIRECTION,
  DIRECTIONS,
  DIRECTION_IDS,
  mapOrientationPoint,
  nearestDirection,
  orientationAffine,
  orientationAnchor,
  walkCycleFrames,
  walkCyclePose,
  type DirectionSpec,
} from '../src/directions.js';

/**
 * The angle model, asserted on the numbers rather than on "it did not throw".
 *
 * Two rules shape everything here. First, a mirror is only useful as a mirror if it is
 * *exactly* a mirror - `W` is compared against an independently computed reflection of `E`
 * on the anchor's vertical axis, not against "not equal to E". Second, a quadrant that is not
 * a transform has to be shown to sit *between* its neighbours; "differs from both" would be
 * satisfied by garbage. The reference reflection and reference rotation below are written
 * out by hand rather than reusing `orientationAffine`, so they can fail independently of it.
 */

const CANVAS = { width: 16, height: 16 };
const GROUND = orientationAnchor('ground', CANVAS.width, CANVAS.height);
const FACING_ANCHOR = orientationAnchor('facing', CANVAS.width, CANVAS.height);

function specOf(id: string): DirectionSpec {
  const found = DIRECTIONS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no direction ${id}`);
  return found;
}

function affineOf(id: string, pivot = GROUND): AffineTransform {
  return orientationAffine(specOf(id), pivot);
}

/** Reflection about the vertical axis through the pivot, written out independently. */
function referenceMirrorX(point: { x: number; y: number }, pivot = GROUND): { x: number; y: number } {
  return { x: 2 * pivot.x - point.x, y: point.y };
}

/** Clockwise quarter turns about the pivot, written out independently. */
function referenceTurns(point: { x: number; y: number }, turns: number, pivot = GROUND): { x: number; y: number } {
  let dx = point.x - pivot.x;
  let dy = point.y - pivot.y;
  const t = ((turns % 4) + 4) % 4;
  for (let i = 0; i < t; i++) {
    // Screen y grows downward, so a clockwise quarter turn sends a point to the right of the
    // pivot to a point below it: (dx, dy) -> (-dy, dx).
    const next = { x: -dy, y: dx };
    dx = next.x;
    dy = next.y;
  }
  return { x: pivot.x + dx, y: pivot.y + dy };
}

const PROBES = [
  GROUND,
  FACING_ANCHOR,
  { x: 0, y: 0 },
  { x: 15, y: 0 },
  { x: 0, y: 15 },
  { x: 15, y: 15 },
  { x: 12, y: 3 },
  { x: 3, y: 12 },
  { x: 7, y: 9 },
];

describe('the eight directions', () => {
  it('are eight, named N through NW in compass order, with the base facing E', () => {
    // The ordering is load-bearing: it is what lets a caller interpolate between neighbours.
    expect(DIRECTION_IDS).toEqual(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']);
    expect(DIRECTIONS.map((spec) => spec.compassIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(BASE_DIRECTION).toBe('E');
    // N is screen up, S is screen down: y grows downward.
    expect(specOf('N').facing).toEqual({ x: 0, y: -1 });
    expect(specOf('S').facing).toEqual({ x: 0, y: 1 });
  });

  it('leaves the orientation anchor fixed under every direction', () => {
    for (const name of ['ground', 'facing', 'origin'] as const) {
      const pivot = orientationAnchor(name, CANVAS.width, CANVAS.height);
      for (const spec of DIRECTIONS) {
        const mapped = mapOrientationPoint(orientationAffine(spec, pivot), pivot);
        expect({ id: spec.id, mapped }).toEqual({ id: spec.id, mapped: pivot });
      }
    }
  });

  it('maps E by the identity and W as its exact mirror', () => {
    const east = affineOf('E');
    expect(east).toMatchObject({ a: 1, b: 0, c: 0, d: 1 });
    // The base direction is not merely close to identity, it is the identity mapping.
    for (const probe of PROBES) expect(mapOrientationPoint(east, probe)).toEqual(probe);

    const west = affineOf('W');
    expect(west).toMatchObject({ a: -1, b: 0, c: 0, d: 1 });
    for (const probe of PROBES) {
      expect(mapOrientationPoint(west, probe)).toEqual(referenceMirrorX(probe));
    }
  });

  it('maps N and S as quarter turns of E, and W as a mirror rather than a turn', () => {
    const east = affineOf('E');
    // E is the identity, so "a turn of E" is the reference rotation itself - which is what
    // makes this a check on the spec and not a restatement of it. W is deliberately absent:
    // a 180-degree turn of a figure is upside-down, and W is the *mirror*, which is the
    // distinction the next test pins.
    for (const [id, turns] of [['N', 3], ['S', 1]] as Array<[string, number]>) {
      const matrix = affineOf(id);
      for (const probe of PROBES) {
        expect({ id, mapped: mapOrientationPoint(matrix, probe) }).toEqual({
          id,
          mapped: referenceTurns(mapOrientationPoint(east, probe), turns),
        });
      }
    }
    // And the two ways to end up facing west are not the same mapping.
    const probe = { x: GROUND.x + 2, y: GROUND.y - 3 };
    const mirrored = mapOrientationPoint(affineOf('W'), probe);
    const turned = referenceTurns(probe, 2);
    expect(mirrored).toEqual(referenceMirrorX(probe));
    expect(mirrored).not.toEqual(turned);
    // The mirror keeps y; the turn does not.
    expect(mirrored.y).toBe(probe.y);
    expect(turned.y).not.toBe(probe.y);
  });

  it('turns S a quarter turn and N three, so the two are 180 degrees apart', () => {
    const probe = { x: GROUND.x + 4, y: GROUND.y - 2 };
    const s = mapOrientationPoint(affineOf('S'), probe);
    const n = mapOrientationPoint(affineOf('N'), probe);
    // 180 degrees is two quarter turns, not two mirrors: a double reflection is the identity.
    expect(n).toEqual(referenceTurns(s, 2));
    expect(n).not.toEqual(referenceMirrorX(referenceMirrorX(s)));
  });

  it('makes the mirrored pair of every mirrored direction an exact reflection', () => {
    const pairs: Array<[string, string]> = [['E', 'W'], ['SE', 'SW'], ['NE', 'NW']];
    for (const [left, right] of pairs) {
      const base = specOf(left);
      expect(specOf(right).turns).toBe(base.turns);
      expect(specOf(right).mirror).toBe(!base.mirror);
      const a = affineOf(left);
      const b = affineOf(right);
      for (const probe of PROBES) {
        expect({ pair: right, mapped: mapOrientationPoint(b, probe) }).toEqual({
          pair: right,
          mapped: referenceMirrorX(mapOrientationPoint(a, probe)),
        });
      }
    }
  });

  it('puts every diagonal between its two cardinal neighbours, not merely elsewhere', () => {
    // "Between" is checked in compass order, which is the only definition that does not need
    // trigonometry: going clockwise from N, each diagonal's index is strictly between its two
    // neighbours' — modulo 8, because NW sits between W and N across the wrap.
    const clockwiseSpan = (from: string, to: string): number => (specOf(to).compassIndex - specOf(from).compassIndex + 8) % 8;
    const between = (from: string, mid: string, to: string): boolean => {
      const offset = (specOf(mid).compassIndex - specOf(from).compassIndex + 8) % 8;
      return offset > 0 && offset < clockwiseSpan(from, to);
    };
    expect(clockwiseSpan('W', 'N')).toBe(2);
    expect(between('N', 'NE', 'E')).toBe(true);
    expect(between('E', 'SE', 'S')).toBe(true);
    expect(between('S', 'SW', 'W')).toBe(true);
    expect(between('W', 'NW', 'N')).toBe(true);
    // And the negative control: a diagonal is *not* between the wrong pair, so this is not a
    // check that anything non-empty is true.
    expect(between('N', 'SE', 'E')).toBe(false);

    // A cardinal has exactly one zero component; a diagonal has neither. That distinction is
    // what makes the four diagonals the four that need a drawing.
    expect(specOf('N').facing.x).toBe(0);
    expect(specOf('S').facing.x).toBe(0);
    expect(specOf('E').facing.y).toBe(0);
    expect(specOf('W').facing.y).toBe(0);
    for (const id of ['NE', 'SE', 'SW', 'NW']) {
      const facing = specOf(id).facing;
      expect(facing.x).not.toBe(0);
      expect(facing.y).not.toBe(0);
      // And it shares each component's sign with one of the two neighbours it sits between.
      const [prev, next] = [DIRECTIONS[(specOf(id).compassIndex + 7) % 8], DIRECTIONS[(specOf(id).compassIndex + 1) % 8]];
      expect([Math.sign(prev.facing.x), Math.sign(next.facing.x)]).toContain(Math.sign(facing.x));
      expect([Math.sign(prev.facing.y), Math.sign(next.facing.y)]).toContain(Math.sign(facing.y));
    }
  });

  it('lands each approximate direction 45 degrees off the cardinal it resolves from', () => {
    // The honest statement about the diagonals: their transform is real and lands them on a
    // named neighbour, one compass step away. `exact: false` is what says the artwork is
    // still needed.
    for (const spec of DIRECTIONS.filter((candidate) => !candidate.exact)) {
      const resolved = specOf(spec.resolvedFrom);
      const step = Math.abs(spec.compassIndex - resolved.compassIndex);
      expect([1, 7]).toContain(step);
      // The transform really does produce the resolved cardinal's facing vector.
      const facing = mapOrientationPoint(orientationAffine(spec, GROUND), { x: GROUND.x + 4, y: GROUND.y });
      expect({ id: spec.id, facing: { x: Math.sign(facing.x - GROUND.x), y: Math.sign(facing.y - GROUND.y) } })
        .toEqual({ id: spec.id, facing: resolved.facing });
    }
    for (const spec of DIRECTIONS.filter((candidate) => candidate.exact)) {
      expect(spec.resolvedFrom).toBe(spec.id);
    }
  });

  it('reads a movement vector back as the direction it points at', () => {
    expect(nearestDirection(3, -1)).toBe('NE');
    expect(nearestDirection(5, 0)).toBe('E');
    expect(nearestDirection(0, 9)).toBe('S');
    expect(nearestDirection(-2, 2)).toBe('SW');
    expect(nearestDirection(-4, -4)).toBe('NW');
    expect(nearestDirection(0, -1)).toBe('N');
    expect(nearestDirection(0, 0)).toBe(BASE_DIRECTION);
  });
});

/* ------------------------------------------------------------------ *
 * The walk cycle
 * ------------------------------------------------------------------ */

function makeCharacterEditor(direction = BASE_DIRECTION) {
  const editor = createEditor(createSprite({ width: 24, height: 24, layers: ['body', 'legL', 'legR'], frames: 1 }));
  editor.execute('draw_rect', { layer: 'body', frame: 0, rect: { x: 9, y: 6, w: 6, h: 10 }, color: '#3355aa', fill: true });
  editor.execute('draw_rect', { layer: 'legL', frame: 0, rect: { x: 9, y: 16, w: 2, h: 6 }, color: '#224477', fill: true });
  editor.execute('draw_rect', { layer: 'legR', frame: 0, rect: { x: 13, y: 16, w: 2, h: 6 }, color: '#224477', fill: true });
  editor.execute('create_rig', {
    restFrame: 0,
    parts: [
      { name: 'body', pivot: { x: 12, y: 20 }, layers: ['body'] },
      { name: 'legL', pivot: { x: 10, y: 16 }, layers: ['legL'], parent: 'body' },
      { name: 'legR', pivot: { x: 14, y: 16 }, layers: ['legR'], parent: 'body' },
    ],
  });
  return { editor, direction };
}

/** Raw bytes of every layer on one frame, keyed by layer name so the order cannot matter. */
function frameBytes(editor: ReturnType<typeof makeCharacterEditor>['editor'], frameIndex: number): Record<string, number[]> {
  const sprite = editor.sprite;
  const frame = sprite.frames[frameIndex];
  const out: Record<string, number[]> = {};
  for (const layer of sprite.layers) {
    out[layer.name] = [...(frame.cels.get(layer.id)?.data ?? [])];
  }
  return out;
}

describe('generated walk cycle', () => {
  it('writes frames, per-frame durations and one looping tag, in one undo step', () => {
    const { editor } = makeCharacterEditor();
    const summary = editor.execute('generate_walk_cycle', {
      direction: 'S', frames: 6, frameDurationMs: 100, stride: 3, bob: 2,
    }) as Record<string, never>;
    const result = summary as unknown as {
      direction: string; frames: number; frameIndices: { from: number; to: number };
      totalDurationMs: number; tagName: string; loopsForever: boolean;
      roles: { legs: string[]; arms: string[]; body: string[] };
    };
    expect(result.direction).toBe('S');
    expect(result.frames).toBe(6);
    // Six new frames after the rest frame, which stays frame 0.
    expect(editor.sprite.frames).toHaveLength(7);
    expect(result.frameIndices).toEqual({ from: 1, to: 6 });
    expect(editor.sprite.frames.slice(1).map((frame) => frame.durationMs)).toEqual([100, 100, 100, 100, 100, 100]);
    expect(result.totalDurationMs).toBe(600);
    expect(result.tagName).toBe('walk_s');
    expect(editor.sprite.tags.map((tag) => tag.name)).toEqual(['walk_s']);
    const tag = editor.sprite.tags[0];
    expect({ from: tag.from, to: tag.to, direction: tag.direction, repeat: tag.repeat })
      .toEqual({ from: 1, to: 6, direction: 'forward', repeat: 0 });
    expect(result.loopsForever).toBe(true);
    expect(result.roles.legs).toEqual(['legL', 'legR']);
    expect(result.roles.body).toEqual(['body']);
    // One undo entry for the whole cycle, not one per frame: three setup paints, create_rig,
    // then the generator.
    expect(editor.history()).toHaveLength(5);
    expect(editor.history().map((entry) => entry.command)).toEqual([
      'draw_rect', 'draw_rect', 'draw_rect', 'create_rig', 'generate_walk_cycle',
    ]);
  });

  it('closes the loop: the frame after the last is the first, in pixels', () => {
    // §4.6 scores a duplicated end frame as a seam. The proof is pixel-level and paired: the
    // same generator shifted by one frame must produce the *last* frame's bytes as its own
    // first frame, and a broken phase would not.
    const { editor } = makeCharacterEditor();
    editor.execute('generate_walk_cycle', { direction: 'E', frames: 4, frameDurationMs: 100 });
    const fromZero = Array.from({ length: 4 }, (_, i) => frameBytes(editor, i + 1));

    const { editor: shifted } = makeCharacterEditor();
    shifted.execute('generate_walk_cycle', { direction: 'E', frames: 4, frameDurationMs: 100, phaseOffset: 1 });
    const fromOne = Array.from({ length: 4 }, (_, i) => frameBytes(shifted, i + 1));

    // Shifting by one advances every frame, and wraps: shifted[3] === fromZero[0].
    for (let i = 1; i < 4; i++) expect(fromOne[i]).toEqual(fromZero[(i + 1) % 4]);
    expect(fromOne[3]).toEqual(fromZero[0]);
    // The comparison is not vacuous: the frames inside a cycle genuinely differ.
    expect(fromZero[0]).not.toEqual(fromZero[1]);
    expect(fromZero[0]).not.toEqual(fromZero[2]);
  });

  it('closes the loop for every frame count, as poses as well as pixels', () => {
    // The pixel test above is the expensive one; this sweeps the parameter that could break
    // periodicity, and the pose-level identity is the property the pixels are made of.
    for (const frames of [2, 3, 4, 5, 6, 8, 12]) {
      const { editor } = makeCharacterEditor();
      const rig = editor.sprite.rig!;
      const first = walkCyclePose(rig, 0, { frames });
      const wrapped = walkCyclePose(rig, frames, { frames });
      const cycle = walkCycleFrames(rig, { frames });
      expect({ frames, wraps: JSON.stringify(wrapped.transforms) })
        .toEqual({ frames, wraps: JSON.stringify(first.transforms) });
      expect(cycle).toHaveLength(frames);
      expect(new Set(cycle.map((frame) => frame.phase)).size).toBe(frames);
      expect(cycle.every((frame) => frame.phase < 1 && frame.phase >= 0)).toBe(true);
    }
  });

  it('splits the legs at both contacts, brings them together at both passing frames, and dips the body at the contacts', () => {
    // A 4-frame walk: contact, passing, contact, passing. The legs are maximally split at the
    // contacts and coincident at the passing frames (both feet under the body), and the body
    // is at its lowest exactly on the contacts. Asserting "never equal" would be asserting a
    // gait that does not exist.
    const { editor } = makeCharacterEditor();
    const rig = editor.sprite.rig!;
    const legL = rig.parts.find((part) => part.name === 'legL')!;
    const legR = rig.parts.find((part) => part.name === 'legR')!;
    const body = rig.parts.find((part) => part.name === 'body')!;
    const cycle = walkCycleFrames(rig, { frames: 4, stride: 2, bob: 1 });
    const signed = cycle.map((frame) =>
      (frame.transforms[legL.id]?.dx ?? 0) - (frame.transforms[legR.id]?.dx ?? 0));
    const split = signed.map(Math.abs);
    // Contacts 0 and 2 are maximally split; passings 1 and 3 are together.
    expect(split).toEqual([4, 0, 4, 0]);
    // And the signs alternate between the two contacts, so it is a gait and not a shuffle.
    expect(Math.sign(signed[0])).not.toBe(Math.sign(signed[2]));
    const dy = cycle.map((frame) => frame.transforms[body.id]?.dy ?? 0);
    expect(dy).toEqual([1, -1, 1, -1]);
    // Positive dy is downward, so the low points are the frames with the larger dy.
    expect(Math.max(...dy)).toBe(1);
    expect(Math.min(...dy)).toBe(-1);
  });

  it('keeps the two contacts half a cycle apart for every even frame count', () => {
    const { editor } = makeCharacterEditor();
    const rig = editor.sprite.rig!;
    const body = rig.parts.find((part) => part.name === 'body')!;
    const legL = rig.parts.find((part) => part.name === 'legL')!;
    const legR = rig.parts.find((part) => part.name === 'legR')!;
    for (const frames of [4, 6, 8, 12]) {
      const cycle = walkCycleFrames(rig, { frames, stride: 2, bob: 1 });
      const split = cycle.map((frame) =>
        (frame.transforms[legL.id]?.dx ?? 0) - (frame.transforms[legR.id]?.dx ?? 0));
      const contacts = split.map((value, i) => ({ i, value }))
        .filter((entry) => Math.abs(entry.value) === Math.max(...split.map(Math.abs)))
        .map((entry) => entry.i);
      // Exactly two frames carry the maximum split, and they are half a cycle apart.
      expect({ frames, contacts }).toEqual({ frames, contacts: [0, frames / 2] });
      const dy = cycle.map((frame) => frame.transforms[body.id]?.dy ?? 0);
      // The body is at its lowest on the contact frames. With a large `frames` and a `bob` of
      // 1, the rounded ramp is flat near its peaks, so the claim is "these frames are at the
      // maximum", not "only these frames" - the pixel-level bob is quantised to whole pixels
      // and a one-pixel bob cannot be resolved over a six-phase wave.
      const lowest = Math.max(...dy);
      expect(dy[0]).toBe(lowest);
      expect(dy[frames / 2]).toBe(lowest);
      // The first half of each cycle falls from the contact to the passing frame, so the peak of
      // each half-cycle is its contact. (Only the descending half: the second half rises back
      // to the *next* contact, which is the first frame of the following half.)
      const half = frames / 2;
      // Non-increasing, not strictly decreasing: a one-pixel bob over a six-phase wave rounds to
      // ties, and demanding a strict descent would be demanding a bob the caller did not ask
      // for. What must hold is the shape, not the gradient.
      for (let i = 0; i < half - 1; i++) {
        expect(dy[i]).toBeGreaterThanOrEqual(dy[i + 1]);
      }
      expect(dy[half - 1]).toBeLessThan(dy[half]);
    }
  });

  it('rejects a write to the rig rest frame and an unflagged overwrite', () => {
    const { editor } = makeCharacterEditor();
    expect(editor.tryExecute('generate_walk_cycle', { direction: 'E', targetFrame: 0 }).ok).toBe(false);
    editor.execute('generate_walk_cycle', { direction: 'E', frames: 4 });
    expect(editor.tryExecute('generate_walk_cycle', { direction: 'E', frames: 4 }).ok).toBe(false);
    expect(editor.tryExecute('generate_walk_cycle', { direction: 'E', frames: 4, overwrite: true }).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Orientation applied to pixels
 * ------------------------------------------------------------------ */

describe('orientation applied to pixels', () => {
  it('renders W as the exact pixel mirror of E, pixel for pixel', () => {
    const east = makeCharacterEditor('E').editor;
    east.execute('generate_walk_cycle', { direction: 'E', frames: 4 });
    const west = makeCharacterEditor('W').editor;
    west.execute('generate_walk_cycle', { direction: 'W', frames: 4 });

    const pivot = orientationAnchor('ground', east.sprite.width, east.sprite.height);
    for (let f = 0; f < 4; f++) {
      const e = east.sprite.frames[f + 1].cels.get(east.sprite.layers[0].id)!;
      const w = west.sprite.frames[f + 1].cels.get(west.sprite.layers[0].id)!;
      // Independently reflected: read the east cel at x, expect it at 2*px - x in the west cel.
      for (let y = 0; y < e.height; y++) {
        for (let x = 0; x < e.width; x++) {
          const mirroredX = 2 * pivot.x - x;
          if (mirroredX < 0 || mirroredX >= w.width) continue;
          expect({
            f, x, y,
            east: [...e.data.slice(e.index(x, y), e.index(x, y) + 4)],
            west: [...w.data.slice(w.index(mirroredX, y), w.index(mirroredX, y) + 4)],
          }).toEqual({
            f, x, y,
            east: [...e.data.slice(e.index(x, y), e.index(x, y) + 4)],
            west: [...e.data.slice(e.index(x, y), e.index(x, y) + 4)],
          });
        }
      }
    }
  });

  it('reports an approximate direction as approximate and still bakes it', () => {
    const { editor } = makeCharacterEditor();
    const summary = editor.execute('generate_walk_cycle', { direction: 'NE', frames: 4 }) as unknown as {
      direction: string; exact: boolean; resolvedFrom: string; frames: number;
    };
    expect(summary.direction).toBe('NE');
    expect(summary.exact).toBe(false);
    expect(summary.resolvedFrom).toBe('N');
    expect(summary.frames).toBe(4);
    // It still wrote pixels, because "approximate" is a statement about artwork, not a refusal.
    const body = frameBytes(editor, 1).body;
    expect(body.some((value, i) => i % 4 === 3 && value > 0)).toBe(true);
  });

  it('keeps the mirror of a quarter turn on the same side as the anchor, in pixels', () => {
    // S and SW differ only by the mirror, so their pixels are reflections of one another about
    // the same vertical axis - asserted on the rasterised output, not on the matrix.
    const south = makeCharacterEditor('S').editor;
    south.execute('generate_walk_cycle', { direction: 'S', frames: 4 });
    const southwest = makeCharacterEditor('SW').editor;
    southwest.execute('generate_walk_cycle', { direction: 'SW', frames: 4 });

    const pivot = orientationAnchor('ground', 24, 24);
    const s = south.sprite.frames[1].cels.get(south.sprite.layers[0].id)!;
    const sw = southwest.sprite.frames[1].cels.get(southwest.sprite.layers[0].id)!;
    let compared = 0;
    for (let y = 0; y < s.height; y++) {
      for (let x = 0; x < s.width; x++) {
        const mx = 2 * pivot.x - x;
        if (mx < 0 || mx >= sw.width) continue;
        compared++;
        expect([...sw.data.slice(sw.index(mx, y), sw.index(mx, y) + 4)])
          .toEqual([...s.data.slice(s.index(x, y), s.index(x, y) + 4)]);
      }
    }
    expect(compared).toBeGreaterThan(100);
  });

  it('reports the anchor it turned about and the matrix it used', () => {
    const { editor } = makeCharacterEditor();
    const summary = editor.execute('get_directions', { direction: 'S' }) as unknown as {
      anchor: string; pivot: { x: number; y: number }; directions: Array<{ id: string; matrix: AffineTransform; exact: boolean }>;
    };
    expect(summary.anchor).toBe('ground');
    expect(summary.pivot).toEqual(orientationAnchor('ground', 24, 24));
    expect(summary.directions[0].matrix.a).toBe(0);
    expect(summary.directions[0].exact).toBe(true);
  });

  it('reads all eight with no rig present', () => {
    const editor = createEditor(createSprite({ width: 8, height: 8 }));
    const summary = editor.execute('get_directions', {}) as unknown as {
      directions: Array<{ id: string }>;
      exactDirections: string[];
      approximateDirections: string[];
    };
    expect(summary.directions.map((entry) => entry.id)).toEqual([...DIRECTION_IDS]);
    expect(summary.exactDirections).toEqual(['N', 'E', 'S', 'W']);
    expect(summary.approximateDirections).toEqual(['NE', 'SE', 'SW', 'NW']);
  });
});

/* ------------------------------------------------------------------ *
 * Determinism
 * ------------------------------------------------------------------ */

describe('orientation maths is exact', () => {
  it('uses integer matrix coefficients and an anchor-fixed translation', () => {
    // Every coefficient is a small integer or the anchor itself; nothing here can drift a
    // pixel between engines the way a `cos(45)` could.
    for (const spec of DIRECTIONS) {
      for (const [w, h] of [[16, 16], [17, 16], [16, 17], [8, 24]]) {
        const pivot = orientationAnchor('ground', w, h);
        const matrix = orientationAffine(spec, pivot);
        for (const key of ['a', 'b', 'c', 'd'] as const) {
          expect(Number.isInteger(matrix[key])).toBe(true);
          expect(Math.abs(matrix[key])).toBeLessThanOrEqual(1);
        }
        const mapped = mapOrientationPoint(matrix, pivot);
        expect(Number.isFinite(mapped.x) && Number.isFinite(mapped.y)).toBe(true);
      }
    }
  });

  it('round-trips a quarter turn four times back to the original point', () => {
    const matrix = orientationAffine(specOf('S'), GROUND);
    let point = { x: 3, y: 11 };
    const start = point;
    for (let i = 0; i < 4; i++) point = mapOrientationPoint(matrix, point);
    expect(point).toEqual(start);
  });

  it('rasterises a quarter turn to the same pixel count it started with, on a square canvas', () => {
    const editor = createEditor(createSprite({ width: 16, height: 16, layers: ['base'] }));
    editor.execute('draw_rect', { layer: 'base', frame: 0, rect: { x: 1, y: 1, w: 4, h: 2 }, color: '#ff8800', fill: true });
    const source = editor.sprite.frames[0].cels.get(editor.sprite.layers[0].id)!;
    const opaque = (buffer: { data: Uint8ClampedArray }): number => {
      let count = 0;
      for (let i = 3; i < buffer.data.length; i += 4) if (buffer.data[i] > 0) count++;
      return count;
    };
    expect(opaque(source)).toBe(8);
    // Turned about the canvas centre, not the feet: turning about the bottom centre of a
    // 16x16 canvas would swing a top-left mark clean off the frame, which is the non-square
    // clipping limit this feature inherits, not a lossiness.
    const centre = orientationAnchor('origin', 16, 16);
    const rotated = transformBufferAffine(source, orientationAffine(specOf('S'), centre), { width: 16, height: 16 });
    // A 90-degree turn is lossless: 8 opaque pixels in, 8 out. This is the concrete reason the
    // four cardinals are `exact: true` and the diagonals are not.
    expect(opaque(rotated)).toBe(opaque(source));
    // And the wide rectangle became a tall one in the mirrored quadrant.
    expect(rotated.opaqueBounds()).toEqual({ x: 13, y: 1, w: 2, h: 4 });
  });

  it('clips rather than resamples when a turn about the feet leaves a non-square canvas', () => {
    // The documented limit, asserted rather than described: about the `ground` anchor on a
    // 16x16 canvas, content in the upper corners is turned out of frame and is dropped.
    const editor = createEditor(createSprite({ width: 16, height: 16, layers: ['base'] }));
    editor.execute('draw_rect', { layer: 'base', frame: 0, rect: { x: 1, y: 1, w: 4, h: 2 }, color: '#ff8800', fill: true });
    const source = editor.sprite.frames[0].cels.get(editor.sprite.layers[0].id)!;
    const turned = transformBufferAffine(source, orientationAffine(specOf('S'), GROUND), { width: 16, height: 16 });
    let opaque = 0;
    for (let i = 3; i < turned.data.length; i += 4) if (turned.data[i] > 0) opaque++;
    expect(opaque).toBe(0);
  });
}, 20_000);