/**
 * Minimal typings for `gifenc` 1.0.3, which ships no declarations of its own.
 *
 * Only the surface `gif.ts` actually uses is declared. The library's palette format
 * is an array of `[r, g, b]` triples, and `delay` is in milliseconds (it converts to
 * centiseconds internally, which is why a 20 ms frame is not representable).
 */
declare module 'gifenc' {
  /** An array of `[r, g, b]` triples. */
  export type Palette = number[][];

  export interface WriteFrameOptions {
    palette?: Palette;
    /** Frame delay in milliseconds. */
    delay?: number;
    /** `0` loops forever, `-1` omits the loop extension entirely. */
    repeat?: number;
    transparent?: boolean;
    transparentIndex?: number;
    dispose?: number;
    colorDepth?: number;
    first?: boolean;
  }

  export interface GifEncoderInstance {
    writeFrame(
      index: Uint8Array | number[],
      width: number,
      height: number,
      opts?: WriteFrameOptions,
    ): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    reset(): void;
  }

  export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): GifEncoderInstance;

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    opts?: Record<string, unknown>,
  ): Palette;

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: Palette,
    format?: string,
  ): Uint8Array;

  export function nearestColorIndex(palette: Palette, pixel: number[]): number;
  export function nearestColor(palette: Palette, pixel: number[]): number[];
  export function snapColorsToPalette(palette: Palette, knownColors: number[][], threshold?: number): void;
  export function prequantize(rgba: Uint8Array | Uint8ClampedArray, opts?: Record<string, unknown>): void;
}
