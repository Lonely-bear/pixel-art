import { describe, expect, it } from 'vitest';
import { isAseprite, spriteFromAseprite } from '../src/ase.js';
import { zlibSync } from 'fflate';

/**
 * A tiny little-endian writer, because the only way to test an importer without
 * checking a binary fixture into the repo is to build the file in the test.
 */
class Writer {
  private bytes: number[] = [];

  byte(value: number): void {
    this.bytes.push(value & 0xff);
  }

  word(value: number): void {
    this.byte(value);
    this.byte(value >> 8);
  }

  short(value: number): void {
    this.word(value < 0 ? value + 0x10000 : value);
  }

  dword(value: number): void {
    this.word(value);
    this.word(value >>> 16);
  }

  skip(count: number): void {
    for (let i = 0; i < count; i += 1) this.byte(0);
  }

  raw(data: ArrayLike<number>): void {
    for (let i = 0; i < data.length; i += 1) this.byte(data[i]);
  }

  string(value: string): void {
    const encoded = new TextEncoder().encode(value);
    this.word(encoded.length);
    this.raw(encoded);
  }

  patchWord(offset: number, value: number): void {
    this.bytes[offset] = value & 0xff;
    this.bytes[offset + 1] = (value >> 8) & 0xff;
  }

  patchDword(offset: number, value: number): void {
    this.patchWord(offset, value);
    this.patchWord(offset + 2, value >>> 16);
  }

  get length(): number {
    return this.bytes.length;
  }

  toBytes(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

/** A chunk is a dword size that includes its own 6-byte header, then a word type. */
function writeChunk(target: Writer, type: number, body: (w: Writer) => void): void {
  const inner = new Writer();
  body(inner);
  target.dword(inner.length + 6);
  target.word(type);
  target.raw(inner.toBytes());
}

interface AseFixtureOptions {
  depth?: number;
  compressed?: boolean;
}

const PIXELS = [
  [255, 0, 0, 255],
  [0, 255, 0, 255],
  [0, 0, 255, 255],
  [255, 255, 0, 255],
  [255, 255, 255, 255],
  [0, 0, 0, 255],
  [128, 64, 32, 128],
  [10, 20, 30, 40],
].flat();

/** A 4x2, one-frame, one-layer RGBA Aseprite file with an `idle` pingpong tag. */
function buildAse(options: AseFixtureOptions = {}): Uint8Array {
  const w = new Writer();

  // Header, 128 bytes.
  const sizeOffset = w.length;
  w.dword(0); // file size, patched below
  w.word(0xa5e0);
  w.word(1); // frames
  w.word(4); // width
  w.word(2); // height
  w.word(options.depth ?? 32);
  w.dword(0); // flags
  w.word(100); // deprecated speed
  w.dword(0);
  w.dword(0);
  w.byte(0); // transparent index
  w.skip(3);
  w.word(0); // colour count
  w.byte(1); // pixel width
  w.byte(1); // pixel height
  w.short(0);
  w.short(0);
  w.word(0);
  w.word(0);
  w.skip(84);

  // One frame.
  const frameOffset = w.length;
  w.dword(0); // frame bytes, patched below
  w.word(0xf1fa);
  w.word(0); // old chunk count
  w.word(120); // duration in ms
  w.skip(2);
  w.dword(3); // chunk count

  writeChunk(w, 0x2004, (b) => {
    b.word(1); // visible
    b.word(0); // normal layer
    b.word(0);
    b.word(4);
    b.word(2);
    b.word(0); // blend mode normal
    b.byte(255);
    b.skip(3);
    b.string('Layer 1');
  });

  writeChunk(w, 0x2005, (b) => {
    b.word(0); // layer index
    b.short(0);
    b.short(0);
    b.byte(255);
    b.word(options.compressed ? 2 : 0);
    b.skip(7);
    b.word(4);
    b.word(2);
    b.raw(options.compressed ? zlibSync(new Uint8Array(PIXELS)) : PIXELS);
  });

  writeChunk(w, 0x2018, (b) => {
    b.word(1);
    b.word(0);
    b.word(0);
    b.byte(2); // pingpong
    b.word(0); // repeat forever
    b.skip(6);
    b.byte(255);
    b.byte(0);
    b.byte(0);
    b.byte(0);
    b.string('idle');
  });

  w.patchDword(sizeOffset, w.length);
  w.patchDword(frameOffset, w.length - frameOffset);
  return w.toBytes();
}

describe('isAseprite', () => {
  it('recognises an Aseprite header', () => {
    expect(isAseprite(buildAse())).toBe(true);
  });

  it('rejects a PNG and a truncated buffer', () => {
    expect(isAseprite(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe(false);
    expect(isAseprite(new Uint8Array([0xa5, 0xe0]))).toBe(false);
  });
});

describe('spriteFromAseprite', () => {
  it('reads the canvas, layer, frame duration and tag', () => {
    const sprite = spriteFromAseprite(buildAse(), { name: 'Imported' });

    expect(sprite.name).toBe('Imported');
    expect(sprite.width).toBe(4);
    expect(sprite.height).toBe(2);
    expect(sprite.layers).toHaveLength(1);
    expect(sprite.layers[0].name).toBe('Layer 1');
    expect(sprite.layers[0].visible).toBe(true);
    expect(sprite.layers[0].opacity).toBe(1);
    expect(sprite.frames).toHaveLength(1);
    expect(sprite.frames[0].durationMs).toBe(120);
    expect(sprite.tags).toHaveLength(1);
    expect(sprite.tags[0].name).toBe('idle');
    expect(sprite.tags[0].from).toBe(0);
    expect(sprite.tags[0].to).toBe(0);
    expect(sprite.tags[0].direction).toBe('pingpong');
    expect(sprite.tags[0].repeat).toBe(0);
  });

  it('carries the raw RGBA pixels through', () => {
    const sprite = spriteFromAseprite(buildAse());
    const cel = sprite.frames[0].cels.get(sprite.layers[0].id);
    expect(cel).toBeDefined();

    expect(cel!.getColor(0, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(cel!.getColor(3, 0)).toEqual({ r: 255, g: 255, b: 0, a: 255 });
    expect(cel!.getColor(2, 1)).toEqual({ r: 128, g: 64, b: 32, a: 128 });
    expect(cel!.getColor(3, 1)).toEqual({ r: 10, g: 20, b: 30, a: 40 });
  });

  it('inflates a compressed cel', () => {
    const sprite = spriteFromAseprite(buildAse({ compressed: true }));
    const cel = sprite.frames[0].cels.get(sprite.layers[0].id);
    expect(cel!.getColor(1, 0)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(cel!.getColor(0, 1)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
  });

  it('rejects a file that is not Aseprite at all', () => {
    expect(() => spriteFromAseprite(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow(
      /not an aseprite file/i,
    );
  });

  it('rejects a colour depth it cannot read', () => {
    expect(() => spriteFromAseprite(buildAse({ depth: 4 }))).toThrow(/colour depth/i);
  });
});
