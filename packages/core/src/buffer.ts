import { parseColor } from './color.js';
import { clipRect, fullRect } from './geometry.js';
import type { Color, ColorInput, Rect } from './types.js';

/**
 * A raw RGBA8888 pixel surface: `Uint8ClampedArray`, 4 bytes per pixel, row-major,
 * y-down, origin top-left, straight (non-premultiplied) alpha.
 *
 * This is the *only* pixel storage format in the project. The palette is a constraint
 * layer applied on top, never the storage format — that keeps AI-generated art, PNG
 * import/export and blending all trivial.
 *
 * `Uint8ClampedArray` is deliberate: it is what `ImageData.data` is in the browser, it
 * clamps and rounds on assignment for free, and it has no endianness pitfalls.
 */
export class PixelBuffer {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;

  constructor(width: number, height: number, data?: Uint8ClampedArray) {
    if (!Number.isInteger(width) || width <= 0) {
      throw new RangeError(`PixelBuffer width must be a positive integer, got ${width}`);
    }
    if (!Number.isInteger(height) || height <= 0) {
      throw new RangeError(`PixelBuffer height must be a positive integer, got ${height}`);
    }
    const length = width * height * 4;
    if (data && data.length !== length) {
      throw new RangeError(
        `PixelBuffer data length ${data.length} does not match ${width}x${height} (expected ${length})`,
      );
    }
    this.width = width;
    this.height = height;
    this.data = data ?? new Uint8ClampedArray(length);
  }

  /** A fully transparent buffer of the given size. */
  static empty(width: number, height: number): PixelBuffer {
    return new PixelBuffer(width, height);
  }

  static filled(width: number, height: number, color: ColorInput): PixelBuffer {
    const buf = new PixelBuffer(width, height);
    buf.fill(color);
    return buf;
  }

  clone(): PixelBuffer {
    return new PixelBuffer(this.width, this.height, new Uint8ClampedArray(this.data));
  }

  index(x: number, y: number): number {
    return (y * this.width + x) * 4;
  }

  contains(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  getColor(x: number, y: number): Color {
    const i = this.index(x, y);
    const d = this.data;
    return { r: d[i], g: d[i + 1], b: d[i + 2], a: d[i + 3] };
  }

  setColor(x: number, y: number, c: Color): void {
    const i = this.index(x, y);
    const d = this.data;
    d[i] = c.r;
    d[i + 1] = c.g;
    d[i + 2] = c.b;
    d[i + 3] = c.a;
  }

  fill(color: ColorInput, rect?: Rect): void {
    const c = parseColor(color);
    const r = clipRect(rect ?? fullRect(this.width, this.height), this.width, this.height);
    const d = this.data;
    for (let y = r.y; y < r.y + r.h; y++) {
      let i = this.index(r.x, y);
      for (let x = 0; x < r.w; x++) {
        d[i] = c.r;
        d[i + 1] = c.g;
        d[i + 2] = c.b;
        d[i + 3] = c.a;
        i += 4;
      }
    }
  }

  /** Zero every channel (fully transparent) in the rect, defaulting to the whole surface. */
  clear(rect?: Rect): void {
    const r = clipRect(rect ?? fullRect(this.width, this.height), this.width, this.height);
    const d = this.data;
    for (let y = r.y; y < r.y + r.h; y++) {
      d.fill(0, this.index(r.x, y), this.index(r.x + r.w, y));
    }
  }

  /** True when every pixel is fully transparent. */
  isEmpty(): boolean {
    const d = this.data;
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return false;
    return true;
  }

  isEqualTo(other: PixelBuffer): boolean {
    if (this.width !== other.width || this.height !== other.height) return false;
    const a = this.data;
    const b = other.data;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /** Tight bounding box of non-transparent pixels, or `null` when the buffer is empty. */
  opaqueBounds(): Rect | null {
    let minX = this.width;
    let minY = this.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.data[this.index(x, y) + 3] !== 0) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  /** Nearest-neighbour integer upscale — the only correct way to scale pixel art. */
  scale(factor: number): PixelBuffer {
    if (!Number.isInteger(factor) || factor < 1) {
      throw new RangeError(`scale factor must be a positive integer, got ${factor}`);
    }
    if (factor === 1) return this.clone();
    const out = new PixelBuffer(this.width * factor, this.height * factor);
    for (let y = 0; y < out.height; y++) {
      const sy = (y / factor) | 0;
      for (let x = 0; x < out.width; x++) {
        const sx = (x / factor) | 0;
        const si = this.index(sx, sy);
        const di = out.index(x, y);
        out.data[di] = this.data[si];
        out.data[di + 1] = this.data[si + 1];
        out.data[di + 2] = this.data[si + 2];
        out.data[di + 3] = this.data[si + 3];
      }
    }
    return out;
  }

  /** Copy `source` onto this buffer at `dx,dy` (opaque copy, no blending). */
  blit(source: PixelBuffer, dx: number, dy: number): void {
    for (let y = 0; y < source.height; y++) {
      const ty = dy + y;
      if (ty < 0 || ty >= this.height) continue;
      for (let x = 0; x < source.width; x++) {
        const tx = dx + x;
        if (tx < 0 || tx >= this.width) continue;
        const si = source.index(x, y);
        const di = this.index(tx, ty);
        this.data[di] = source.data[si];
        this.data[di + 1] = source.data[si + 1];
        this.data[di + 2] = source.data[si + 2];
        this.data[di + 3] = source.data[si + 3];
      }
    }
  }

  /** Copy the `src` sub-rect of `source` to `dx,dy`. */
  blitRegion(source: PixelBuffer, src: Rect, dx: number, dy: number): void {
    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) {
        const sx = src.x + x;
        const sy = src.y + y;
        if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) continue;
        const tx = dx + x;
        const ty = dy + y;
        if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) continue;
        const si = source.index(sx, sy);
        const di = this.index(tx, ty);
        this.data[di] = source.data[si];
        this.data[di + 1] = source.data[si + 1];
        this.data[di + 2] = source.data[si + 2];
        this.data[di + 3] = source.data[si + 3];
      }
    }
  }
}
