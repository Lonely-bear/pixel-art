import { PixelBuffer } from './buffer.js';
import { colorToHex } from './color.js';
import { createSprite, type Sprite } from './document.js';
import { createPalette, extractPalette, type Palette } from './palette.js';
import { decodePNG } from './png.js';

/**
 * Bringing outside images in.
 *
 * Letting an agent hand us a reference image and have it become a real layer is one of
 * the highest-leverage affordances we can offer — it turns "make me a slime" into
 * "make me a slime in *this* style" without any model fine-tuning.
 */

export interface ImportPngOptions {
  name?: string;
  layerName?: string;
  /** Derive the palette from the image's own colours. Defaults to true. */
  derivePalette?: boolean;
  /** Cap on derived palette size. Defaults to 64. */
  paletteLimit?: number;
}

export function spriteFromPng(bytes: Uint8Array, opts: ImportPngOptions = {}): Sprite {
  const buffer = decodePNG(bytes);
  const palette =
    opts.derivePalette === false
      ? undefined
      : derivePaletteFromBuffer(buffer, opts.paletteLimit ?? 64);

  const sprite = createSprite({
    width: buffer.width,
    height: buffer.height,
    name: opts.name ?? 'Imported',
    palette,
  });
  if (opts.layerName) sprite.layers[0].name = opts.layerName;
  sprite.frames[0].cels.set(sprite.layers[0].id, buffer);
  return sprite;
}

/** Decode a PNG straight to a buffer, without wrapping it in a sprite. */
export function pixelBufferFromPng(bytes: Uint8Array): PixelBuffer {
  return decodePNG(bytes);
}

export function derivePaletteFromBuffer(buffer: PixelBuffer, limit = 64): Palette {
  const colors = extractPalette(buffer, limit);
  if (colors.length === 0) colors.push({ r: 0, g: 0, b: 0, a: 255 });
  return createPalette('Imported', colors.map((c) => colorToHex(c, c.a !== 255)));
}
