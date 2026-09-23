import {
  convertIndexedToRgb,
  decode as decodePng,
  encode as encodePng,
  type DecodedPng,
} from 'fast-png';
import { PixelBuffer } from './buffer.js';

/**
 * PNG is the lingua franca of the whole product: it is the export format, the format
 * cels are stored in inside `.pixel`, and — crucially — the format MCP resources hand
 * to a multimodal model so it can actually *see* what it drew.
 *
 * Decoding is deliberately broad: indexed PNGs, greyscale, sub-byte bit depths and
 * 16-bit channels all land in the same RGBA8888 buffer.
 */

export interface PngEncodeOptions {
  /** zlib level 0-9. Higher is smaller and slower. Defaults to the library's own default. */
  level?: number;
}

export function encodePNG(buffer: PixelBuffer, opts: PngEncodeOptions = {}): Uint8Array {
  const image = {
    width: buffer.width,
    height: buffer.height,
    data: buffer.data,
    channels: 4,
    depth: 8 as const,
  };
  return opts.level === undefined
    ? encodePng(image)
    : encodePng(image, { zlib: { level: opts.level as never } });
}

export function decodePNG(bytes: Uint8Array): PixelBuffer {
  return pixelBufferFromDecodedPng(decodePng(bytes));
}

export function pixelBufferFromDecodedPng(decoded: DecodedPng): PixelBuffer {
  const { width, height } = decoded;
  const out = new PixelBuffer(width, height);
  const dst = out.data;

  // Indexed images: fast-png hands back packed indices plus a palette.
  if (decoded.palette && decoded.palette.length > 0) {
    const entryLength = decoded.palette[0].length; // 3 = RGB, 4 = RGBA (tRNS present)
    const rgb = convertIndexedToRgb(decoded);
    const hasAlpha = entryLength >= 4;
    for (let i = 0, p = 0, s = 0; i < width * height; i++, p += 4, s += entryLength) {
      dst[p] = rgb[s];
      dst[p + 1] = rgb[s + 1];
      dst[p + 2] = rgb[s + 2];
      dst[p + 3] = hasAlpha ? rgb[s + 3] : 255;
    }
    return out;
  }

  const channels = decoded.channels;
  const depth = decoded.depth;
  const src = decoded.data as unknown as ArrayLike<number>;

  // Sub-byte greyscale (1, 2 or 4 bpp): data is still bit-packed.
  if (depth < 8) {
    const rowBytes = Math.ceil((width * depth) / 8);
    const maxValue = (1 << depth) - 1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bitIndex = x * depth;
        const byte = src[y * rowBytes + (bitIndex >> 3)] ?? 0;
        const shift = 8 - depth - (bitIndex & 7);
        const value = (byte >> shift) & maxValue;
        const grey = Math.round((value * 255) / maxValue);
        const p = out.index(x, y);
        dst[p] = grey;
        dst[p + 1] = grey;
        dst[p + 2] = grey;
        dst[p + 3] = 255;
      }
    }
    return out;
  }

  const max = depth === 16 ? 65535 : 255;
  const scale = 255 / max;

  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    let r: number;
    let g: number;
    let b: number;
    let a: number;
    switch (channels) {
      case 1:
        r = g = b = src[i] * scale;
        a = 255;
        break;
      case 2:
        r = g = b = src[i * 2] * scale;
        a = src[i * 2 + 1] * scale;
        break;
      case 3:
        r = src[i * 3] * scale;
        g = src[i * 3 + 1] * scale;
        b = src[i * 3 + 2] * scale;
        a = 255;
        break;
      default:
        r = src[i * 4] * scale;
        g = src[i * 4 + 1] * scale;
        b = src[i * 4 + 2] * scale;
        a = src[i * 4 + 3] * scale;
        break;
    }
    dst[p] = r;
    dst[p + 1] = g;
    dst[p + 2] = b;
    dst[p + 3] = a;
  }
  return out;
}

/** PNG signature check, so callers can give a decent error for non-PNG input. */
export function isPNG(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}
