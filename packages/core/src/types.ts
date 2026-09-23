/**
 * Shared value types for the pixel art document model.
 *
 * Coordinate convention, used *everywhere* and never violated:
 *   - origin is top-left
 *   - `x` grows right, `y` grows **down**
 *   - coordinates are zero-based integers naming a pixel, not a corner
 *   - rectangles are `{x, y, w, h}` with `w`/`h` counted in pixels
 */

export type SpriteId = string;
export type LayerId = string;
export type FrameId = string;
export type TagId = string;
export type TilesetId = string;
export type TilemapId = string;

/** A colour with 8-bit channels. `a` is straight (non-premultiplied) alpha. */
export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Anything the API accepts where a colour is expected.
 *
 * - `string`  — `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, or a small set of names
 *               (`transparent`, `black`, `white`, `red`, ...)
 * - `number`  — `0xRRGGBBAA` when above `0xFFFFFF`, otherwise `0xRRGGBB` (opaque)
 * - `[r,g,b]` / `[r,g,b,a]` — channels 0-255
 * - `Color`
 */
export type ColorInput =
  | string
  | number
  | Color
  | { r: number; g: number; b: number; a?: number }
  | readonly [number, number, number]
  | readonly [number, number, number, number];

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'add'
  | 'replace';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Frame playback direction for an animation tag. */
export type TagDirection = 'forward' | 'reverse' | 'pingpong';
