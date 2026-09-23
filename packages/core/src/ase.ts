import { PixelBuffer } from './buffer.js';
import { createSprite, type AnimationTag, type Layer, type Sprite } from './document.js';
import { makeId } from './ids.js';
import { createDefaultPalette, type Palette } from './palette.js';
import { unzlibSync } from 'fflate';
import type { BlendMode, Color, TagDirection } from './types.js';

/**
 * `TextDecoder` is a global in every place `@pixel/core` runs — Node 18+, the
 * browser, a worker — but it is not part of the ES lib, and core deliberately
 * carries no platform typings, so the shape it needs is declared here.
 */
declare const TextDecoder: {
  new (label?: string): { decode(input?: Uint8Array): string };
};

/**
 * Aseprite `.ase` / `.aseprite` import.
 *
 * Aseprite is where most pixel art actually gets drawn, so reading its files is the
 * difference between "you can redraw it here" and "you can keep working on it".
 *
 * Only the chunks that describe a document are read - layers, cels, palette and tags.
 * Anything else (colour profiles, slices, user data, tilemaps) is skipped by its own
 * declared size, which is what makes the format safe to read partially: a chunk we do
 * not understand costs nothing.
 */

const MAGIC_HEADER = 0xa5e0;
const MAGIC_FRAME = 0xf1fa;

const CHUNK_LAYER = 0x2004;
const CHUNK_CEL = 0x2005;
const CHUNK_TAGS = 0x2018;
const CHUNK_PALETTE = 0x2019;

/** Aseprite's own blend numbering, mapped onto the modes this editor understands. */
const BLEND_MODES: Record<number, BlendMode> = {
  0: 'normal',
  1: 'multiply',
  2: 'screen',
  3: 'overlay',
  16: 'add',
};

const DIRECTIONS: Record<number, TagDirection> = { 0: 'forward', 1: 'reverse', 2: 'pingpong' };

export interface AsepriteImportOptions {
  name?: string;
}

/** True when the bytes look like an Aseprite file. */
export function isAseprite(bytes: Uint8Array): boolean {
  return bytes.length >= 6 && readWord(bytes, 4) === MAGIC_HEADER;
}

class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  byte(): number {
    return this.bytes[this.offset++] ?? 0;
  }

  word(): number {
    const value = readWord(this.bytes, this.offset);
    this.offset += 2;
    return value;
  }

  short(): number {
    const value = this.word();
    return value >= 0x8000 ? value - 0x10000 : value;
  }

  dword(): number {
    const value = readDword(this.bytes, this.offset);
    this.offset += 4;
    return value;
  }

  skip(count: number): void {
    this.offset += count;
  }

  /** Aseprite strings are a length-prefixed UTF-8 byte run. */
  string(): string {
    const length = this.word();
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return new TextDecoder().decode(slice);
  }
}

function readWord(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readDword(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

interface AseLayer {
  name: string;
  visible: boolean;
  opacity: number;
  blendMode: BlendMode;
}

interface AseCel {
  layerIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Row-major RGBA, or `null` for a linked cel that carries no pixels of its own. */
  pixels: Uint8Array | null;
}

interface AseFrame {
  durationMs: number;
  cels: AseCel[];
}

/**
 * Read an Aseprite file into a sprite.
 *
 * Throws with the byte offset when the magic is wrong or a chunk runs past the end -
 * a truncated file should say so rather than quietly produce a blank sprite.
 */
export function spriteFromAseprite(bytes: Uint8Array, opts: AsepriteImportOptions = {}): Sprite {
  if (!isAseprite(bytes)) throw new Error('Not an Aseprite file: the header magic is missing.');

  const header = new Reader(bytes);
  header.skip(4);
  header.word(); // magic, already checked
  const frameCount = header.word();
  const width = header.word();
  const height = header.word();
  const depth = header.word();
  header.skip(4 + 2 + 4 + 4 + 1 + 3);
  const colorCount = header.word();
  header.skip(2 + 2 + 2 + 2 + 2 + 84);

  if (depth !== 32 && depth !== 8 && depth !== 16) {
    throw new Error(`Unsupported Aseprite colour depth: ${depth} bits per pixel.`);
  }

  const layers: AseLayer[] = [];
  const frames: AseFrame[] = [];
  const tags: AnimationTag[] = [];
  let palette: Palette | null = null;

  const reader = new Reader(bytes);
  reader.offset = 128;

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    if (reader.remaining < 16) {
      throw new Error(`Aseprite frame ${frameIndex} is truncated at byte ${reader.offset}.`);
    }
    const frameSize = reader.dword();
    const frameMagic = reader.word();
    if (frameMagic !== MAGIC_FRAME) {
      throw new Error(`Aseprite frame ${frameIndex} has a bad magic at byte ${reader.offset - 2}.`);
    }
    const frameEnd = reader.offset - 6 + frameSize;
    reader.word(); // deprecated chunk count
    const durationMs = reader.word() || 100;
    reader.skip(2);
    const chunkCount = reader.dword();

    const frame: AseFrame = { durationMs, cels: [] };

    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      if (reader.offset + 6 > frameEnd) break;
      const chunkSize = reader.dword();
      const chunkType = reader.word();
      const chunkStart = reader.offset;
      const chunkEnd = chunkStart + chunkSize - 6;

      if (chunkType === CHUNK_LAYER) {
        const flags = reader.word();
        reader.word(); // layer type
        reader.word(); // child level
        reader.word(); // default width
        reader.word(); // default height
        const blend = reader.word();
        const opacity = reader.byte();
        reader.skip(3);
        const name = reader.string();
        layers.push({
          name,
          visible: (flags & 1) !== 0,
          opacity: opacity / 255,
          blendMode: BLEND_MODES[blend] ?? 'normal',
        });
      } else if (chunkType === CHUNK_CEL) {
        const layerIndex = reader.word();
        const x = reader.short();
        const y = reader.short();
        reader.byte(); // cel opacity, already carried by the layer
        const celType = reader.word();
        reader.skip(7);
        const celWidth = reader.word();
        const celHeight = reader.word();
        let pixels: Uint8Array | null = null;
        if (celType !== 1) {
          const raw = bytes.subarray(reader.offset, chunkEnd);
          const data = celType === 2 ? unzlibSync(raw) : raw;
          pixels = toRgba(data, celWidth * celHeight, depth, palette, colorCount);
        }
        frame.cels.push({ layerIndex, x, y, width: celWidth, height: celHeight, pixels });
      } else if (chunkType === CHUNK_TAGS) {
        const count = reader.word();
        for (let i = 0; i < count; i += 1) {
          const from = reader.word();
          const to = reader.word();
          const direction = reader.byte();
          const repeat = reader.word();
          reader.skip(6 + 3 + 1);
          const name = reader.string();
          tags.push({
            id: makeId('tag'),
            name,
            from,
            to,
            direction: DIRECTIONS[direction] ?? 'forward',
            repeat,
          });
        }
      } else if (chunkType === CHUNK_PALETTE) {
        const newSize = reader.dword();
        const first = reader.dword();
        reader.dword(); // last index, redundant with the size
        reader.skip(8);
        const colors: Color[] = [];
        for (let i = 0; i < newSize; i += 1) {
          const flags = reader.word();
          const r = reader.byte();
          const g = reader.byte();
          const b = reader.byte();
          const a = reader.byte();
          if (flags & 1) reader.string(); // colour name, unused here
          colors.push({ r, g, b, a });
        }
        if (colors.length > 0) {
          palette = { id: makeId('palette'), name: 'Aseprite', colors };
          // Indices before `first` are still meaningful to cels, so keep them transparent.
          if (first > 0) {
            const padded: Color[] = [];
            for (let i = 0; i < first; i += 1) padded.push({ r: 0, g: 0, b: 0, a: 0 });
            palette.colors = [...padded, ...colors];
          }
        }
      }

      reader.offset = chunkEnd;
    }

    reader.offset = frameEnd;
    frames.push(frame);
  }

  if (frames.length === 0) throw new Error('The Aseprite file contains no frames.');

  const layerNames = layers.length > 0 ? layers.map((layer) => layer.name) : ['Layer 1'];
  const sprite = createSprite({
    width: Math.max(1, width),
    height: Math.max(1, height),
    name: opts.name ?? 'Aseprite',
    layers: layerNames,
    frames: frames.length,
    frameDurationMs: frames[0].durationMs,
  });

  // The palette is a constraint layer, so it is kept even though the pixels are RGBA.
  if (palette) sprite.palette = palette;
  else if (depth === 8 && colorCount > 0) sprite.palette = createDefaultPalette();

  applyLayers(sprite, layers);
  applyFrames(sprite, frames);
  sprite.tags = tags;

  return sprite;
}

function applyLayers(sprite: Sprite, layers: AseLayer[]): void {
  for (let i = 0; i < sprite.layers.length; i += 1) {
    const source = layers[i];
    if (!source) continue;
    const target: Layer = sprite.layers[i];
    target.name = source.name;
    target.visible = source.visible;
    target.opacity = source.opacity;
    target.blendMode = source.blendMode;
  }
}

function applyFrames(sprite: Sprite, frames: AseFrame[]): void {
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const source = frames[frameIndex];
    const target = sprite.frames[frameIndex];
    target.durationMs = source.durationMs;

    for (const cel of source.cels) {
      const layer = sprite.layers[cel.layerIndex];
      if (!layer) continue;
      if (!cel.pixels) {
        // A linked cel reuses the previous frame's pixels for the same layer.
        const previous = sprite.frames[frameIndex - 1]?.cels.get(layer.id);
        if (previous) target.cels.set(layer.id, previous.clone());
        continue;
      }
      const buffer = new PixelBuffer(sprite.width, sprite.height);
      const patch = new PixelBuffer(cel.width, cel.height);
      patch.data.set(cel.pixels);
      buffer.blit(patch, cel.x, cel.y);
      target.cels.set(layer.id, buffer);
    }
  }
}

/** Expand Aseprite's pixel formats into straight RGBA. */
function toRgba(
  data: Uint8Array,
  pixelCount: number,
  depth: number,
  palette: Palette | null,
  colorCount: number,
): Uint8Array {
  const out = new Uint8Array(pixelCount * 4);
  if (depth === 32) {
    out.set(data.subarray(0, out.length));
    return out;
  }
  if (depth === 16) {
    for (let i = 0; i < pixelCount; i += 1) {
      const value = readWord(data, i * 2) >> 8;
      const alpha = readWord(data, i * 2 + 2) >> 8;
      out[i * 4] = value;
      out[i * 4 + 1] = value;
      out[i * 4 + 2] = value;
      out[i * 4 + 3] = alpha;
    }
    return out;
  }
  // Indexed: one byte per pixel, looked up in the palette (alpha 0 for index 0 when the
  // file declares no palette of its own, which is how Aseprite marks transparency).
  for (let i = 0; i < pixelCount; i += 1) {
    const index = data[i] ?? 0;
    const color = palette?.colors[index];
    if (!color) continue;
    out[i * 4] = color.r;
    out[i * 4 + 1] = color.g;
    out[i * 4 + 2] = color.b;
    out[i * 4 + 3] = index === 0 && colorCount > 0 && !palette ? 0 : color.a;
  }
  return out;
}
