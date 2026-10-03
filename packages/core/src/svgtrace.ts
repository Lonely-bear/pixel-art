import { clamp8, parseColor } from './color.js';
import { clipRect } from './geometry.js';
import type { Color, Point, Rect } from './types.js';

/**
 * SVG trace import: vector outlines in, pixels out.
 *
 * This is deliberately *not* an SVG renderer. It reads a small, fixed subset of SVG —
 * flat filled geometry with no transforms and no paint servers — flattens it to
 * polygons and scan-converts those onto the pixel grid. Anything outside that subset is
 * either reported in `skipped` with a reason or refused outright; nothing is silently
 * ignored, because a path that quietly traces 20px off its real position is worse than
 * an error the caller can read.
 *
 * Two policies were picked and are not configurable, on the grounds that a pixel-art
 * tracer has one obviously-right answer to each:
 *
 *  - **No antialiasing.** Coverage is binary. A traced outline is a hard pixel edge;
 *    smoothing it into a ramp of intermediate alphas is a job for `antialias`, which
 *    can be run afterwards and which respects `paletteLocked` when it does.
 *  - **Colours are quantised to the palette.** Each shape's `fill` goes through
 *    `parseColor` and, under `paletteLocked`, through the nearest swatch — the same
 *    `resolveColor` path every paint command uses. A vector asset therefore cannot
 *    smuggle 200 off-palette RGB values into a document that promises a palette.
 */

/** One filled shape: its flattened subpaths, its colour, and the rule that filled it. */
export interface SvgShape {
  /** Closed for filling; a subpath of 2 points is a degenerate sliver and is dropped. */
  subpaths: Point[][];
  color: Color;
  /** `nonzero` is the SVG default; `evenodd` is read from `fill-rule`. */
  fillRule: 'nonzero' | 'evenodd';
  /** Source element name, for the summary. */
  tag: string;
}

export interface SvgParseResult {
  shapes: SvgShape[];
  /** Elements that were found but could not be traced, with the reason. */
  skipped: string[];
}

export interface SvgTraceOptions {
  /** SVG user units per pixel. 1 means one user unit is one pixel. Defaults to 1. */
  scale?: number;
  /** Pixel-space offset applied after scaling, i.e. where SVG (0,0) lands. */
  offset?: Point;
  /** Flatness tolerance in pixels for curve flattening. Defaults to 0.1. */
  tolerance?: number;
}

/* ------------------------------------------------------------------ *
 * Deterministic trigonometry
 *
 * `packages/core/test/determinism.test.ts` forbids `Math.sin`, `Math.cos`, `Math.tan`
 * and `Math.atan2` anywhere in `src`, because V8, JSC and SpiderMonkey are free to
 * disagree in the last ULP and a traced outline that moves by one pixel between the
 * Electron renderer and the CLI is not a bug anyone can debug from a screenshot.
 *
 * So the arc code below uses Cody-Waite range reduction plus the fdlibm minimax
 * kernels. Only `+ - * /` are involved, so the result is bit-identical on every engine
 * that implements IEEE 754 doubles — and `svgtrace.test.ts` checks these against
 * `Math.sin`/`Math.cos` over the whole range an arc can produce.
 * ------------------------------------------------------------------ */

const TWO_OVER_PI = 6.36619772367581382433e-1;
const PI_2_A = 1.57079632673412561417e0;
const PI_2_B = 6.07710050650619224932e-11;
const PI_2_C = 2.02226624879595063154e-21;

const SIN_C1 = -1.66666666666666324348e-1;
const SIN_C2 = 8.33333333332248946124e-3;
const SIN_C3 = -1.98412698298579493134e-4;
const SIN_C4 = 2.75573137070700676789e-6;
const SIN_C5 = -2.50507602534068634195e-8;
const SIN_C6 = 1.58969099521155010221e-10;

const COS_C1 = 4.16666666666666019037e-2;
const COS_C2 = -1.38888888888741095749e-3;
const COS_C3 = 2.48015872894767294178e-5;
const COS_C4 = -2.75573143513906633035e-7;
const COS_C5 = 2.08757232129817482790e-9;
const COS_C6 = -1.13596475577881948265e-11;

function kernelSin(x: number): number {
  const z = x * x;
  return (
    x +
    x * z *
      (SIN_C1 +
        z * (SIN_C2 + z * (SIN_C3 + z * (SIN_C4 + z * (SIN_C5 + z * SIN_C6)))))
  );
}

function kernelCos(x: number): number {
  const z = x * x;
  return (
    1 -
    0.5 * z +
    z * z * (COS_C1 + z * (COS_C2 + z * (COS_C3 + z * (COS_C4 + z * (COS_C5 + z * COS_C6)))))
  );
}

/** Reduce to `(quadrant 0..3, remainder in +/-pi/4)`. */
function reducePiOver2(x: number): { q: number; r: number } {
  const n = Math.round(x * TWO_OVER_PI);
  const r = (x - n * PI_2_A - n * PI_2_B) - n * PI_2_C;
  return { q: ((n % 4) + 4) % 4, r };
}

/**
 * `Math.sin`, reproducible across engines.
 *
 * With x = r + q*pi/2 and |r| <= pi/4, the quadrant fixes which kernel and which sign:
 * q0 sin r, q1 cos r, q2 -sin r, q3 -cos r.
 */
function dsin(x: number): number {
  const { q, r } = reducePiOver2(x);
  if (q === 1) return kernelCos(r);
  if (q === 2) return -kernelSin(r);
  if (q === 3) return -kernelCos(r);
  return kernelSin(r);
}

/** `Math.cos`: q0 cos r, q1 -sin r, q2 -cos r, q3 sin r. */
function dcos(x: number): number {
  const { q, r } = reducePiOver2(x);
  if (q === 1) return -kernelSin(r);
  if (q === 2) return -kernelCos(r);
  if (q === 3) return kernelSin(r);
  return kernelCos(r);
}

/** `Math.tan`, reproducible across engines. */
function dtan(x: number): number {
  return dsin(x) / dcos(x);
}

const HALF_PI = PI_2_A + PI_2_B + PI_2_C;
const QUARTER_PI = HALF_PI / 2;
/** tan(pi/8) = sqrt(2) - 1, the point where a cubic would start costing more than Taylor. */
const TAN_PI_8 = 0.4142135623730951;

/**
 * `Math.atan`, reproducible across engines.
 *
 * Three exact identities reduce any argument to |x| <= 0.4142:
 * oddness, `atan(x) = pi/2 - atan(1/x)`, and `atan(x) = pi/4 + atan((x-1)/(x+1))`.
 * Twelve Taylor terms over that range is ~1e-15, which is far below anything a pixel
 * grid can observe, and unlike a minimax fit it is checkable term by term.
 */
function datan(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const negate = x < 0;
  let t = negate ? -x : x;
  let value: number;

  if (t > 1) {
    value = HALF_PI - datanSeries(1 / t);
  } else {
    value = t > TAN_PI_8 ? QUARTER_PI + datanSeries((t - 1) / (t + 1)) : datanSeries(t);
  }
  return negate ? -value : value;
}

/** The odd Taylor series for atan, accurate over the reduced range only. */
function datanSeries(x: number): number {
  const x2 = x * x;
  let term = x;
  let sum = x;
  for (let k = 1; k <= 12; k++) {
    term *= -x2;
    sum += term / (2 * k + 1);
  }
  return sum;
}

/** `Math.atan2`, reproducible across engines. */
function datan2(y: number, x: number): number {
  if (x > 0) return datan(y / x);
  if (x < 0) return y >= 0 ? datan(y / x) + 2 * HALF_PI : datan(y / x) - 2 * HALF_PI;
  if (y > 0) return HALF_PI;
  if (y < 0) return -HALF_PI;
  return 0;
}

/* ------------------------------------------------------------------ *
 * Path data parsing
 * ------------------------------------------------------------------ */

const PATH_LETTERS = 'MmLlHhVvCcSsQqTtAaZz';

class PathReader {
  private i = 0;
  constructor(private readonly d: string) {}

  private skipSeparators(): void {
    while (this.i < this.d.length && (this.d[this.i] === ',' || /\s/.test(this.d[this.i]))) this.i++;
  }

  atEnd(): boolean {
    this.skipSeparators();
    return this.i >= this.d.length;
  }

  /**
   * The next alphabetic character, whether or not it is a command.
   *
   * Distinguishing "not a letter" from "a letter we do not support" is what lets an
   * implicit lineto's argument list stop at the next command instead of trying to read it
   * as a number.
   */
  peekLetter(): string | null {
    this.skipSeparators();
    const ch = this.d[this.i];
    return ch && /[a-zA-Z]/.test(ch) ? ch : null;
  }

  /** The next command letter, or `null` when the data is not at a letter. */
  peekCommand(): string | null {
    const ch = this.peekLetter();
    return ch && PATH_LETTERS.includes(ch) ? ch : null;
  }

  takeCommand(): string {
    const ch = this.peekLetter();
    if (ch === null) throw new Error(`Expected a path command at offset ${this.i} of the path data`);
    if (!PATH_LETTERS.includes(ch)) {
      throw new Error(`Unsupported path command "${ch}" at offset ${this.i} of the path data`);
    }
    this.i++;
    return ch;
  }

  /** Read the next number. Throws rather than returning NaN. */
  number(): number {
    this.skipSeparators();
    const match = /^[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/.exec(this.d.slice(this.i));
    if (!match) throw new Error(`Expected a number at offset ${this.i} of the path data`);
    this.i += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new Error(`Number ${match[0]} in the path data is not finite`);
    return value;
  }

  /** An arc flag: `0` or `1`, written without a separator in real-world SVG. */
  flag(): number {
    this.skipSeparators();
    const ch = this.d[this.i];
    if (ch === '0' || ch === '1') {
      this.i++;
      return ch === '1' ? 1 : 0;
    }
    return this.number() !== 0 ? 1 : 0;
  }
}

interface CubicCurve {
  c1: Point;
  c2: Point;
  to: Point;
}

function flattenCubic(out: Point[], from: Point, curve: CubicCurve, tolerance: number, depth = 0): void {
  // Flatness = the largest distance from either control point to the chord. This is the
  // standard convex-hull-free test and needs no lookahead.
  const dx = curve.to.x - from.x;
  const dy = curve.to.y - from.y;
  const d1 = Math.abs((curve.c1.x - from.x) * dy - (curve.c1.y - from.y) * dx);
  const d2 = Math.abs((curve.c2.x - from.x) * dy - (curve.c2.y - from.y) * dx);
  const dd = (d1 + d2) * (d1 + d2);
  if (depth >= 16 || dd <= tolerance * tolerance * (dx * dx + dy * dy)) {
    out.push(curve.to);
    return;
  }
  const split = (a: Point, b: Point, c: Point, d: Point): [CubicCurve, CubicCurve] => {
    const ab = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const bc = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };
    const cd = { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 };
    const abc = { x: (ab.x + bc.x) / 2, y: (ab.y + bc.y) / 2 };
    const bcd = { x: (bc.x + cd.x) / 2, y: (bc.y + cd.y) / 2 };
    const mid = { x: (abc.x + bcd.x) / 2, y: (abc.y + bcd.y) / 2 };
    return [
      { c1: ab, c2: abc, to: mid },
      { c1: bcd, c2: cd, to: d },
    ];
  };
  const [left, right] = split(from, curve.c1, curve.c2, curve.to);
  flattenCubic(out, from, left, tolerance, depth + 1);
  flattenCubic(out, left.to, right, tolerance, depth + 1);
}

function flattenQuadratic(out: Point[], from: Point, c: Point, to: Point, tolerance: number): void {
  // Elevated to a cubic so there is only one flattening routine.
  flattenCubic(
    out,
    from,
    {
      c1: { x: from.x + (2 / 3) * (c.x - from.x), y: from.y + (2 / 3) * (c.y - from.y) },
      c2: { x: to.x + (2 / 3) * (c.x - to.x), y: to.y + (2 / 3) * (c.y - to.y) },
      to,
    },
    tolerance,
  );
}

/**
 * Endpoint-parameterised elliptical arc, split into cubics of at most 90 degrees.
 *
 * Standard SVG 1.1 appendix F.6, transcribed rather than derived: it is fiddly, it is
 * exactly specified, and a subtly wrong arc is invisible in a test and obvious in a sprite.
 */
function flattenArc(
  out: Point[],
  from: Point,
  rx: number,
  ry: number,
  rotationDeg: number,
  largeArc: number,
  sweep: number,
  to: Point,
  tolerance: number,
): void {
  if (from.x === to.x && from.y === to.y) return;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0) {
    out.push(to);
    return;
  }
  const phi = (rotationDeg * Math.PI) / 180;
  const cosPhi = dcos(phi);
  const sinPhi = dsin(phi);
  const dx2 = (from.x - to.x) / 2;
  const dy2 = (from.y - to.y) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  // Scale the radii up if they are too small to span the chord (F.6.6).
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const sign = largeArc === sweep ? -1 : 1;
  const numerator = Math.max(
    0,
    rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p,
  );
  const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coefficient = denominator === 0 ? 0 : sign * Math.sqrt(numerator / denominator);

  const cxp = (coefficient * (rx * y1p)) / ry;
  const cyp = (coefficient * -(ry * x1p)) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (from.x + to.x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (from.y + to.y) / 2;

  // Signed angle between two vectors: `atan2` of the cross product against the dot product.
  // SVG's y axis points *down*, so the sign convention here is the one the arc formulas
  // below expect, which is why the cross product is not negated.
  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const cross = ux * vy - uy * vx;
    return datan2(cross, dot);
  };

  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  else if (sweep && delta < 0) delta += 2 * Math.PI;

  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const step = delta / segments;
  // Magic constant for approximating a circular arc of `step` radians with a cubic.
  const alpha = (4 / 3) * dtan(step / 4);

  const map = (t: number): Point => {
    const cosT = dcos(t);
    const sinT = dsin(t);
    return {
      x: cx + rx * cosT * cosPhi - ry * sinT * sinPhi,
      y: cy + rx * cosT * sinPhi + ry * sinT * cosPhi,
    };
  };
  // d/dt of `map`, in world space. The cubic's control points lie *along the tangent* at
  // each end, not on the arc — putting them on the mid-arc point instead is the classic
  // way to get an arc that is visibly inside its own chord.
  const tangent = (t: number): Point => {
    const cosT = dcos(t);
    const sinT = dsin(t);
    return { x: -rx * sinT * cosPhi - ry * cosT * sinPhi, y: -rx * sinT * sinPhi + ry * cosT * cosPhi };
  };

  let theta = theta1;
  let point = from;
  for (let i = 0; i < segments; i++) {
    const nextTheta = theta + step;
    const end = map(nextTheta);
    const t0 = tangent(theta);
    const t1 = tangent(nextTheta);
    flattenCubic(
      out,
      point,
      {
        c1: { x: point.x + alpha * t0.x, y: point.y + alpha * t0.y },
        c2: { x: end.x - alpha * t1.x, y: end.y - alpha * t1.y },
        to: end,
      },
      tolerance,
    );
    point = end;
    theta = nextTheta;
  }
}

/**
 * Parse SVG path data into flattened subpaths, in the source coordinate system.
 *
 * Every command in the SVG 1.1 path grammar is supported: `M L H V C S Q T A Z` and their
 * relative forms. `A` is genuinely traced (not approximated by a line) because arcs are
 * common in exported art and a quarter-circle drawn as a chord is visibly wrong.
 */
export function parsePathData(d: string, tolerance = 0.1): Point[][] {
  const reader = new PathReader(d);
  const subpaths: Point[][] = [];
  let current: Point[] | null = null;
  let cursor: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  // Reflection state for the shorthand curve commands.
  let lastCubicControl: Point | null = null;
  let lastQuadControl: Point | null = null;

  const pushCurrent = (): void => {
    if (current && current.length >= 2) subpaths.push(current);
    current = null;
  };

  while (!reader.atEnd()) {
    const command = reader.takeCommand();
    const relative = command === command.toLowerCase();
    const base = command.toUpperCase();

    switch (base) {
      case 'M': {
        pushCurrent();
        const x = reader.number();
        const y = reader.number();
        cursor = relative ? { x: cursor.x + x, y: cursor.y + y } : { x, y };
        start = cursor;
        current = [cursor];
        lastCubicControl = null;
        lastQuadControl = null;
        // Subsequent coordinate pairs after a moveto are implicit linetos. The loop stops
        // on any letter, supported or not, so an unsupported command is reported as one
        // rather than being read as a number and reported as a malformed argument.
        while (!reader.atEnd() && reader.peekLetter() === null) {
          const lx = reader.number();
          const ly = reader.number();
          cursor = relative ? { x: cursor.x + lx, y: cursor.y + ly } : { x: lx, y: ly };
          current!.push(cursor);
        }
        break;
      }
      case 'L': {
        if (!current) current = [cursor];
        const x = reader.number();
        const y = reader.number();
        cursor = relative ? { x: cursor.x + x, y: cursor.y + y } : { x, y };
        current.push(cursor);
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      case 'H': {
        if (!current) current = [cursor];
        const x = reader.number();
        cursor = { x: relative ? cursor.x + x : x, y: cursor.y };
        current.push(cursor);
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      case 'V': {
        if (!current) current = [cursor];
        const y = reader.number();
        cursor = { x: cursor.x, y: relative ? cursor.y + y : y };
        current.push(cursor);
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      case 'C':
      case 'S': {
        if (!current) current = [cursor];
        let c1: Point;
        if (base === 'C') {
          const x1 = reader.number();
          const y1 = reader.number();
          c1 = relative ? { x: cursor.x + x1, y: cursor.y + y1 } : { x: x1, y: y1 };
        } else {
          c1 = lastCubicControl
            ? { x: 2 * cursor.x - lastCubicControl.x, y: 2 * cursor.y - lastCubicControl.y }
            : { x: cursor.x, y: cursor.y };
        }
        const x2 = reader.number();
        const y2 = reader.number();
        const x = reader.number();
        const y = reader.number();
        const c2 = relative ? { x: cursor.x + x2, y: cursor.y + y2 } : { x: x2, y: y2 };
        const to = relative ? { x: cursor.x + x, y: cursor.y + y } : { x, y };
        flattenCubic(current, cursor, { c1, c2, to }, tolerance);
        cursor = to;
        lastCubicControl = c2;
        lastQuadControl = null;
        break;
      }
      case 'Q':
      case 'T': {
        if (!current) current = [cursor];
        let c: Point;
        if (base === 'Q') {
          const x1 = reader.number();
          const y1 = reader.number();
          c = relative ? { x: cursor.x + x1, y: cursor.y + y1 } : { x: x1, y: y1 };
        } else {
          c = lastQuadControl
            ? { x: 2 * cursor.x - lastQuadControl.x, y: 2 * cursor.y - lastQuadControl.y }
            : { x: cursor.x, y: cursor.y };
        }
        const x = reader.number();
        const y = reader.number();
        const to = relative ? { x: cursor.x + x, y: cursor.y + y } : { x, y };
        flattenQuadratic(current, cursor, c, to, tolerance);
        cursor = to;
        lastQuadControl = c;
        lastCubicControl = null;
        break;
      }
      case 'A': {
        if (!current) current = [cursor];
        const rx = reader.number();
        const ry = reader.number();
        const rotation = reader.number();
        const largeArc = reader.flag();
        const sweep = reader.flag();
        const x = reader.number();
        const y = reader.number();
        const to = relative ? { x: cursor.x + x, y: cursor.y + y } : { x, y };
        flattenArc(current, cursor, rx, ry, rotation, largeArc, sweep, to, tolerance);
        cursor = to;
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      case 'Z': {
        pushCurrent();
        cursor = start;
        current = [cursor];
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      default:
        throw new Error(`Unsupported path command "${command}"`);
    }

    }
  pushCurrent();
  return subpaths;
}

/* ------------------------------------------------------------------ *
 * Element extraction
 * ------------------------------------------------------------------ */

const GEOMETRY_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline']);
const TAG_RE = /<(path|rect|circle|ellipse|polygon|polyline|line|image|text|use|g|svg)\b([^>]*?)\/?>/gi;
const ATTR_RE = /([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** An `<svg>`/`<g>` carrying a transform or an inherited fill is refused, not approximated. */
export class SvgUnsupportedError extends Error {}

function attrsOf(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(source)) !== null) {
    out[match[1].toLowerCase()] = match[2] ?? match[3] ?? '';
  }
  return out;
}

function parseSvgColor(value: string): Color | null {
  const text = value.trim().toLowerCase();
  if (text === 'none' || text === 'transparent') return null;
  if (text.startsWith('url(')) {
    throw new SvgUnsupportedError(
      `fill "${value}" is a paint server (gradient or pattern); only flat colours are traced`,
    );
  }
  const rgb = /^rgba?\(([^)]*)\)$/.exec(text);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) {
      throw new SvgUnsupportedError(`fill "${value}" is not a colour this tracer understands`);
    }
    return {
      r: clamp8(parts[0]),
      g: clamp8(parts[1]),
      b: clamp8(parts[2]),
      a: parts.length > 3 ? clamp8(parts[3] * 255) : 255,
    };
  }
  try {
    return parseColor(text);
  } catch {
    throw new SvgUnsupportedError(`fill "${value}" is not a colour this tracer understands`);
  }
}

function numberAttr(attrs: Record<string, string>, name: string, fallback = 0): number {
  const raw = attrs[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) {
    throw new SvgUnsupportedError(`attribute ${name}="${raw}" is not a number`);
  }
  return value;
}

function circlePoints(cx: number, cy: number, rx: number, ry: number, tolerance: number): Point[] {
  // Four quarter arcs through the *same* `flattenArc` the path `A` command uses, rather
  // than an inscribed polygon. An inscribed polygon is short by r*(1 - cos(15 deg)), which
  // is half a pixel on a 9px icon — and it under-fills on the outside, so a traced circle
  // would be visibly smaller than the `<circle>` it came from.
  const points: Point[] = [{ x: cx, y: cy - ry }];
  flattenArc(points, { x: cx, y: cy - ry }, rx, ry, 0, 0, 1, { x: cx + rx, y: cy }, tolerance);
  flattenArc(points, { x: cx + rx, y: cy }, rx, ry, 0, 0, 1, { x: cx, y: cy + ry }, tolerance);
  flattenArc(points, { x: cx, y: cy + ry }, rx, ry, 0, 0, 1, { x: cx - rx, y: cy }, tolerance);
  flattenArc(points, { x: cx - rx, y: cy }, rx, ry, 0, 0, 1, { x: cx, y: cy - ry }, tolerance);
  return points;
}

function rectPoints(x: number, y: number, w: number, h: number, rxAttr?: number, ryAttr?: number): Point[] {
  const rx = Math.min(rxAttr ?? 0, w / 2);
  const ry = Math.min(ryAttr ?? (rxAttr === undefined ? 0 : rxAttr), h / 2);
  if (rx <= 0 || ry <= 0) {
    return [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ];
  }
  // Rounded corners as flattened quarter ellipses rather than a chamfer, because a
  // chamfered pixel-art icon corner is a visible defect.
  const kappa = 0.5522847498307936;
  const points: Point[] = [];
  // One quarter corner: from the incoming edge, round to the centre, out to the next edge.
  const corner = (cx: number, cy: number, sx: number, sy: number): void => {
    points.push({ x: cx + sx * rx * kappa, y: cy });
    points.push({ x: cx, y: cy + sy * ry * kappa });
    points.push({ x: cx, y: cy + sy * ry });
  };
  points.push({ x: x + rx, y }, { x: x + w - rx, y });
  corner(x + w - rx, y + ry, -1, -1);
  points.push({ x: x + w, y: y + h - ry });
  corner(x + w - rx, y + h - ry, -1, 1);
  points.push({ x: x + rx, y: y + h });
  corner(x + rx, y + h - ry, 1, 1);
  points.push({ x, y: y + ry });
  corner(x + rx, y + ry, 1, -1);
  return points;
}

function numberList(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

/**
 * Read the traced subset out of an SVG document.
 *
 * Supported elements: `path`, `rect` (including `rx`/`ry`), `circle`, `ellipse`,
 * `polygon`, `polyline` (closed for filling). Fill colour comes from `fill` or a
 * `fill:` declaration in `style`; `fill: none` and `fill-opacity: 0` are skipped as
 * unfilled rather than painted black, because black is what an absent `fill` defaults to
 * and confusing those two would drop a stroke-only path into the artwork as a solid blob.
 *
 * Refused with `SvgUnsupportedError`: any element carrying a `transform`, and any `<g>`
 * carrying a `fill` (so an inherited colour cannot be silently lost). Recorded in
 * `skipped`: `line`, `image`, `text`, `use`, and unfilled shapes.
 */
export function parseSvgShapes(svg: string, tolerance = 0.1): SvgParseResult {
  const shapes: SvgShape[] = [];
  const skipped: string[] = [];

  // Refusals that must abort the whole document rather than produce partial geometry.
  const containerRe = /<(g|svg)\b([^>]*?)\/?>/gi;
  let container: RegExpExecArray | null;
  while ((container = containerRe.exec(svg)) !== null) {
    const attrs = attrsOf(container[2]);
    if (attrs.transform !== undefined) {
      throw new SvgUnsupportedError(
        `<${container[1].toLowerCase()}> carries transform="${attrs.transform}"; transform support is not implemented, and tracing untransformed geometry would land the artwork in the wrong place`,
      );
    }
    if (container[1].toLowerCase() === 'g' && attrs.fill !== undefined) {
      throw new SvgUnsupportedError(
        `<g fill="${attrs.fill}"> inherits its fill to children; inherited fills are not resolved, so the children would trace with the wrong colour`,
      );
    }
  }

  // Elements the geometry scan below does not see, because it only walks geometry tags.
  // `text`/`image`/`use` are absent from that scan too and are reported there instead, so
  // they are deliberately not listed here — one skip entry per element, not two.
  const unsupportedRe = /<(switch|symbol|marker|clipPath|mask|pattern|linearGradient|radialGradient|filter)\b/gi;
  let unsupported: RegExpExecArray | null;
  while ((unsupported = unsupportedRe.exec(svg)) !== null) {
    skipped.push(`<${unsupported[1]}>: element type is not traced`);
  }

  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(svg)) !== null) {
    const tag = match[1].toLowerCase();
    const attrs = attrsOf(match[2]);
    if (attrs.transform !== undefined) {
      throw new SvgUnsupportedError(
        `<${tag}> carries transform="${attrs.transform}"; transform support is not implemented, and tracing untransformed geometry would land the artwork in the wrong place`,
      );
    }
    if (!GEOMETRY_TAGS.has(tag)) {
      // `g`/`svg` are containers with no fill of their own; everything else is named.
      if (tag !== 'g' && tag !== 'svg') skipped.push(`<${tag}>: element type is not traced`);
      continue;
    }

    const styleFill = /(?:^|;)\s*fill\s*:\s*([^;]+)/i.exec(attrs.style ?? '')?.[1];
    const fillText = attrs.fill ?? styleFill;
    if (fillText !== undefined && (fillText.trim().toLowerCase() === 'none' || fillText.trim().toLowerCase() === 'transparent')) {
      skipped.push(`<${tag}>: fill is none (stroke-only geometry is not traced)`);
      continue;
    }
    if (attrs['fill-opacity'] !== undefined && Number.parseFloat(attrs['fill-opacity']) === 0) {
      skipped.push(`<${tag}>: fill-opacity is 0`);
      continue;
    }
    const color = parseSvgColor(fillText ?? 'black');

    let subpaths: Point[][];
    try {
      subpaths = geometrySubpaths(tag, attrs, tolerance);
    } catch (error) {
      skipped.push(`<${tag}>: ${(error as Error).message}`);
      continue;
    }
    if (subpaths.length === 0) {
      skipped.push(`<${tag}>: geometry is empty`);
      continue;
    }

    shapes.push({
      subpaths,
      // An explicitly unfilled shape (`fill="none"` was handled above; here the colour
      // genuinely resolved) always has one, but keep the type honest if that ever changes.
      color: color ?? { r: 0, g: 0, b: 0, a: 255 },
      fillRule: attrs['fill-rule']?.trim().toLowerCase() === 'evenodd' ? 'evenodd' : 'nonzero',
      tag,
    });
  }

  return { shapes, skipped };
}

function geometrySubpaths(tag: string, attrs: Record<string, string>, tolerance: number): Point[][] {
  switch (tag) {
    case 'path': {
      const d = attrs.d;
      if (!d) throw new Error('path has no d attribute');
      return parsePathData(d, tolerance);
    }
    case 'rect': {
      const w = numberAttr(attrs, 'width');
      const h = numberAttr(attrs, 'height');
      if (w <= 0 || h <= 0) return [];
      return [
        rectPoints(
          numberAttr(attrs, 'x'),
          numberAttr(attrs, 'y'),
          w,
          h,
          attrs.rx === undefined ? undefined : numberAttr(attrs, 'rx'),
          attrs.ry === undefined ? undefined : numberAttr(attrs, 'ry'),
        ),
      ];
    }
    case 'circle': {
      const r = numberAttr(attrs, 'r');
      if (r <= 0) return [];
      return [circlePoints(numberAttr(attrs, 'cx'), numberAttr(attrs, 'cy'), r, r, tolerance)];
    }
    case 'ellipse': {
      const rx = numberAttr(attrs, 'rx');
      const ry = numberAttr(attrs, 'ry');
      if (rx <= 0 || ry <= 0) return [];
      return [circlePoints(numberAttr(attrs, 'cx'), numberAttr(attrs, 'cy'), rx, ry, tolerance)];
    }
    case 'polygon':
    case 'polyline': {
      const coords = numberList(attrs.points);
      const points: Point[] = [];
      for (let i = 0; i + 1 < coords.length; i += 2) {
        points.push({ x: coords[i], y: coords[i + 1] });
      }
      return points.length >= 3 ? [points] : [];
    }
    default:
      return [];
  }
}

/* ------------------------------------------------------------------ *
 * Scan conversion
 * ------------------------------------------------------------------ */

/**
 * The pixels a set of subpaths covers, as a full-canvas mask.
 *
 * The arithmetic is deliberately identical to `drawPolygon`'s fill in `raster.ts`:
 * vertices are treated as **pixel centres** and a span runs from its first crossing
 * *inclusive* to its second crossing *inclusive*. So a rectangle from (2,2) to (9,5) fills
 * eight columns and four rows, exactly as `draw_polygon` fills it, and a traced file and a
 * hand-drawn polygon of the same coordinates cannot disagree on a shared edge.
 *
 * The winding rule is applied across the whole subpath set, so a hole traced as a reversed
 * inner subpath is hollow under `nonzero` and under `evenodd` alike.
 */
export function fillSubpathsMask(
  subpaths: readonly Point[][],
  width: number,
  height: number,
  fillRule: 'nonzero' | 'evenodd',
): Uint8Array {
  const mask = new Uint8Array(width * height);
  if (width <= 0 || height <= 0) return mask;

  let minY = Infinity;
  let maxY = -Infinity;
  for (const sub of subpaths) {
    for (const p of sub) {
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minY)) return mask;

  const region = clipRect(
    {
      x: 0,
      y: Math.floor(minY),
      w: width,
      h: Math.ceil(maxY) - Math.floor(minY) + 1,
    },
    width,
    height,
  );

  // `x` plus the winding direction of the edge that crossed the scanline.
  const crossings: Array<{ x: number; dir: number }> = [];
  for (let y = region.y; y < region.y + region.h; y++) {
    const yc = y + 0.5;
    crossings.length = 0;
    for (const sub of subpaths) {
      const n = sub.length;
      if (n < 3) continue;
      for (let i = 0; i < n; i++) {
        const a = sub[i];
        const b = sub[(i + 1) % n];
        // The half-open rule, on vertices shifted by half a pixel exactly as
        // `drawPolygon` shifts them, so a vertex shared by two edges counts once and the
        // two rasterisers cannot disagree by a pixel on the same coordinates.
        // Vertices are *pixel centres* and are sampled at the row index, which is
        // `drawPolygon`'s convention: shifting both by half a pixel and then testing
        // against `y + 0.5` cancels out, and testing the shifted vertices against the
        // unshifted row is what silently insets the whole shape by a pixel.
        const ay = a.y + 0.5;
        const by = b.y + 0.5;
        // Half-open on the scanline, so a vertex shared by two edges counts once.
        if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) {
          crossings.push({
            x: a.x + 0.5 + ((yc - ay) / (by - ay)) * (b.x - a.x),
            dir: by > ay ? 1 : -1,
          });
        }
      }
    }
    if (crossings.length < 2) continue;
    crossings.sort((p, q) => p.x - q.x);

    let winding = 0;
    let parity = 0;
    for (let i = 0; i + 1 < crossings.length; i++) {
      winding += crossings[i].dir;
      parity ^= 1;
      const inside = fillRule === 'evenodd' ? parity !== 0 : winding !== 0;
      if (!inside) continue;
      const from = Math.max(region.x, Math.ceil(crossings[i].x - 0.5));
      const to = Math.min(region.x + region.w - 1, Math.floor(crossings[i + 1].x - 0.5));
      const row = y * width;
      for (let x = from; x <= to; x++) mask[row + x] = 1;
    }
  }
  return mask;
}

export interface SvgTraceResult {
  /** One mask per shape, all `width * height`, in document order. */
  masks: Uint8Array[];
  shapes: SvgShape[];
  skipped: string[];
  /** Tight bounding box of every painted pixel, or null when nothing landed. */
  bounds: Rect | null;
}

/** Tight bounding box of the union of several masks. */
export function maskBounds(masks: readonly Uint8Array[], width: number, height: number): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const mask of masks) {
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        if (!mask[row + x]) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Parse, scale and scan-convert an SVG into per-shape masks ready for `putPixel`.
 *
 * Geometry landing outside the canvas is clipped silently — the rasteriser's rule is that
 * a slightly wrong coordinate gives a sensible result plus a count, not an exception.
 */
export function traceSvg(svg: string, width: number, height: number, opts: SvgTraceOptions = {}): SvgTraceResult {
  const scale = opts.scale ?? 1;
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new RangeError(`scale must be a positive number, got ${scale}`);
  }
  const tolerance = opts.tolerance ?? 0.1;
  const offset = opts.offset ?? { x: 0, y: 0 };
  const { shapes, skipped } = parseSvgShapes(svg, tolerance / scale);

  const masks: Uint8Array[] = [];
  const placed: SvgShape[] = [];

  for (const shape of shapes) {
    const subpaths = shape.subpaths.map((sub) =>
      sub.map((p) => ({ x: p.x / scale + offset.x, y: p.y / scale + offset.y })),
    );
    const mask = fillSubpathsMask(subpaths, width, height, shape.fillRule);
    masks.push(mask);
    placed.push({ ...shape, subpaths });
  }

  // Bounds come from the painted pixels, not from the geometry. A shape whose edge falls
  // exactly on a pixel boundary has no partial pixel there, and reporting the geometry's
  // box would claim a column of pixels that were never written.
  return { masks, shapes: placed, skipped, bounds: maskBounds(masks, width, height) };
}