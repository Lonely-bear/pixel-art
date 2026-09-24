import { describe, expect, it } from 'vitest';
import { colorToHex, colorsEqual, packColor, parseColor } from '../src/color.js';
import { createSprite } from '../src/document.js';
import { createPalette } from '../src/palette.js';
import { createEditor } from '../src/index.js';

describe('parseColor', () => {
  it('parses 3, 4, 6 and 8 digit hex', () => {
    expect(parseColor('#f00')).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(parseColor('#f00f')).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(parseColor('#ff0000')).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(parseColor('#ff000080')).toEqual({ r: 255, g: 0, b: 0, a: 128 });
  });

  it('accepts hex without the leading hash and in any case', () => {
    expect(parseColor('FF8800')).toEqual({ r: 255, g: 136, b: 0, a: 255 });
  });

  it('resolves names, including transparent', () => {
    expect(parseColor('black')).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it('treats numbers above 0xffffff as RGBA and below as opaque RGB', () => {
    expect(parseColor(0xff0000)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(parseColor(0xff000080)).toEqual({ r: 255, g: 0, b: 0, a: 128 });
  });

  it('accepts tuples and objects', () => {
    expect(parseColor([1, 2, 3])).toEqual({ r: 1, g: 2, b: 3, a: 255 });
    expect(parseColor([1, 2, 3, 4])).toEqual({ r: 1, g: 2, b: 3, a: 4 });
    expect(parseColor({ r: 9, g: 9, b: 9 })).toEqual({ r: 9, g: 9, b: 9, a: 255 });
  });

  it('clamps out-of-range channels rather than throwing', () => {
    expect(parseColor([300, -20, 3.6])).toEqual({ r: 255, g: 0, b: 4, a: 255 });
  });

  it('rejects nonsense loudly', () => {
    expect(() => parseColor('#12345')).toThrow(/Invalid colour/);
    expect(() => parseColor('not-a-colour')).toThrow(/Invalid colour/);
  });
});

describe('colorToHex', () => {
  it('round-trips', () => {
    const c = { r: 18, g: 52, b: 86, a: 255 };
    expect(parseColor(colorToHex(c))).toEqual(c);
  });

  it('includes alpha only when asked', () => {
    const c = { r: 18, g: 52, b: 86, a: 128 };
    expect(colorToHex(c)).toBe('#123456');
    expect(colorToHex(c, true)).toBe('#12345680');
  });
});

describe('packColor', () => {
  it('is stable and distinct per colour', () => {
    const a = parseColor('#123456');
    expect(packColor(a)).toBe(packColor(parseColor('#123456')));
    expect(packColor(a)).not.toBe(packColor(parseColor('#123457')));
  });

  it('distinguishes colours that differ only in alpha', () => {
    expect(packColor(parseColor('#00000000'))).not.toBe(packColor(parseColor('#000000ff')));
  });
});

describe('colorsEqual', () => {
  it('compares every channel', () => {
    expect(colorsEqual(parseColor('#010203'), parseColor('#010203'))).toBe(true);
    expect(colorsEqual(parseColor('#010203'), parseColor('#010204'))).toBe(false);
  });
});

describe('palette shorthand', () => {
  const palette = {
    colors: [parseColor('#ff0000'), parseColor('#00ff00'), parseColor('#0000ff'), parseColor('#ffffff')],
  };

  it('resolves "pal:N" and "palette N" against the palette', () => {
    expect(parseColor('pal:0', palette)).toEqual(palette.colors[0]);
    expect(parseColor('pal:2', palette)).toEqual(palette.colors[2]);
    expect(parseColor('palette 3', palette)).toEqual(palette.colors[3]);
    expect(parseColor('PAL:1', palette)).toEqual(palette.colors[1]);
  });

  it('treats an in-range integer number as a palette index', () => {
    expect(parseColor(0, palette)).toEqual(palette.colors[0]);
    expect(parseColor(2, palette)).toEqual(palette.colors[2]);
  });

  it('leaves numbers that do not fit the palette as packed RGB(A)', () => {
    // 0xff0000 is far outside a 4-colour palette, so it keeps its literal meaning.
    expect(parseColor(0xff0000, palette)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
  });

  it('throws when an index is out of range', () => {
    expect(() => parseColor('pal:9', palette)).toThrow(/out of range/);
  });

  it('falls back to packed RGB for an out-of-range plain number', () => {
    expect(parseColor(9, palette)).toEqual({ r: 0, g: 0, b: 9, a: 255 });
  });

  it('throws when an index is used without a palette', () => {
    expect(() => parseColor('pal:2')).toThrow(/no palette/);
  });

  it('keeps the old number meaning when no palette is supplied', () => {
    expect(parseColor(2)).toEqual({ r: 0, g: 0, b: 2, a: 255 });
  });
});

describe('palette shorthand through the command bus', () => {
  it('resolves "pal:N" and integer indices against the sprite palette', () => {
    const sprite = createSprite({
      width: 2,
      height: 1,
      palette: createPalette('test', ['#ff0000', '#00ff00']),
    });
    const editor = createEditor(sprite);
    editor.execute('draw_pixels', { layer: 0, frame: 0, pixels: [{ x: 0, y: 0, color: 'pal:1' }] });
    editor.execute('draw_pixels', { layer: 0, frame: 0, pixels: [{ x: 1, y: 0, color: 0 }] });

    const cel = editor.sprite.frames[0].cels.get(editor.sprite.layers[0].id);
    expect(cel?.getColor(0, 0)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(cel?.getColor(1, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
  });
});
