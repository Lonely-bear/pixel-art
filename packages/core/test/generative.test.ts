import { describe, expect, it } from 'vitest';
import { createEditor, createPalette, createSprite, decodeBase64, type Editor } from '../src/index.js';

function snapshot(editor: Editor, layer = 0, frame = 0): number[] {
  const cel = editor.sprite.frames[frame].cels.get(editor.sprite.layers[layer].id);
  if (!cel) throw new Error('missing cel');
  return [...cel.data];
}

function makeEditor(width = 16, height = 16, layers = ['base']) {
  return createEditor(createSprite({ width, height, layers }));
}

describe('base64 bulk pixels', () => {
  it('decodes padded, unpadded and whitespace-separated standard base64', () => {
    expect([...decodeBase64('AQIDBA==')]).toEqual([1, 2, 3, 4]);
    expect([...decodeBase64('AQIDBA')]).toEqual([1, 2, 3, 4]);
    expect([...decodeBase64(' AQI\n DBA== ')]).toEqual([1, 2, 3, 4]);
    expect(() => decodeBase64('A')).toThrow(/length/);
    expect(() => decodeBase64('AQIDBA=')).toThrow(/length|padding/);
    expect(() => decodeBase64('!!!!')).toThrow(/base64/);
  });

  it('writes an RGBA8888 buffer in one command', () => {
    const editor = makeEditor(4, 4);
    const data = Buffer.from([
      255, 0, 0, 255,
      0, 255, 0, 128,
    ]).toString('base64');
    const result = editor.execute('put_pixels', {
      layer: 0,
      frame: 0,
      rect: { x: 1, y: 1, w: 2, h: 1 },
      data,
    }) as { bytes: number; written: number; painted?: number; expectedBytes: number };

    expect(result).toMatchObject({ bytes: 8, expectedBytes: 8, written: 2 });
    const cel = editor.sprite.frames[0].cels.get(editor.sprite.layers[0].id)!;
    expect(cel.getColor(1, 1)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(cel.getColor(2, 1)).toEqual({ r: 0, g: 255, b: 0, a: 128 });
  });

  it('can clear transparent source pixels and reports byte mismatches', () => {
    const editor = makeEditor(4, 4);
    editor.execute('draw_rect', { layer: 0, frame: 0, rect: { x: 0, y: 0, w: 2, h: 1 }, color: '#ff0000', fill: true });
    const data = Buffer.from([0, 0, 0, 0, 0, 255, 0, 255]).toString('base64');
    const result = editor.execute('put_pixels', {
      layer: 0,
      frame: 0,
      rect: { x: 0, y: 0, w: 2, h: 1 },
      data,
      clearTransparent: true,
    }) as { cleared: number; written: number };
    expect(result).toMatchObject({ cleared: 1, written: 2 });

    const bad = Buffer.from([1, 2, 3, 4]).toString('base64');
    expect(() => editor.execute('put_pixels', {
      layer: 0,
      frame: 0,
      rect: { x: 0, y: 0, w: 2, h: 1 },
      data: bad,
    })).toThrow(/expected 8 RGBA bytes.*decoded 4/);
  });
});

describe('generative primitives', () => {
  it('fills a deterministic banded gradient in one undo step', () => {
    const first = makeEditor();
    const result = first.execute('banded_gradient', {
      layer: 0,
      frame: 0,
      rect: { x: 0, y: 0, w: 8, h: 8 },
      from: '#17213b',
      to: '#f0c16b',
      steps: 5,
      direction: 'diagonal',
      seed: 9,
      jitter: 0.1,
    }) as { pixels: number; painted: number; banded: boolean };
    expect(result).toMatchObject({ pixels: 64, painted: 64, banded: true });
    expect(first.history()).toHaveLength(1);

    const second = makeEditor();
    second.execute('banded_gradient', {
      layer: 0,
      frame: 0,
      rect: { x: 0, y: 0, w: 8, h: 8 },
      from: '#17213b',
      to: '#f0c16b',
      steps: 5,
      direction: 'diagonal',
      seed: 9,
      jitter: 0.1,
    });
    expect(snapshot(first)).toEqual(snapshot(second));
  });

  it('uses octaves to switch from value noise to deterministic fBm', () => {
    const a = makeEditor();
    const result = a.execute('noise_fill', {
      layer: 0,
      frame: 0,
      rect: { x: 0, y: 0, w: 8, h: 8 },
      from: '#10182c',
      to: '#83b7b0',
      scale: 2,
      octaves: 4,
      seed: 7,
    }) as { mode: string; octaves: number; painted: number };
    expect(result).toMatchObject({ mode: 'fbm', octaves: 4, painted: 64 });

    const b = makeEditor();
    b.execute('noise_fill', {
      layer: 0,
      frame: 0,
      rect: { x: 0, y: 0, w: 8, h: 8 },
      from: '#10182c',
      to: '#83b7b0',
      scale: 2,
      octaves: 4,
      seed: 7,
    });
    expect(snapshot(a)).toEqual(snapshot(b));

    const different = makeEditor();
    different.execute('noise_fill', {
      layer: 0,
      frame: 0,
      rect: { x: 0, y: 0, w: 8, h: 8 },
      from: '#10182c',
      to: '#83b7b0',
      scale: 2,
      octaves: 4,
      seed: 8,
    });
    expect(snapshot(a)).not.toEqual(snapshot(different));
  });

  it('snaps generated ramp colours when the palette is locked', () => {
    const palette = createPalette('locked', ['#101018', '#f0f0e0']);
    const editor = createEditor(createSprite({
      width: 8,
      height: 8,
      layers: ['base'],
      palette,
      paletteLocked: true,
    }));
    editor.execute('banded_gradient', {
      layer: 0,
      frame: 0,
      rect: { x: 0, y: 0, w: 8, h: 8 },
      from: '#101018',
      to: '#f0f0e0',
      steps: 6,
      banded: false,
    });
    const cel = editor.sprite.frames[0].cels.get(editor.sprite.layers[0].id)!;
    const allowed = new Set(['#101018', '#f0f0e0']);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const color = cel.getColor(x, y);
        const hex = `#${[color.r, color.g, color.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
        expect(allowed.has(hex)).toBe(true);
      }
    }
  });

  it('suppresses threshold jitter when palette locking would make a regular texture', () => {
    const editor = createEditor(createSprite({
      width: 32,
      height: 16,
      layers: ['base'],
      palette: createPalette('locked-jitter', ['#000000', '#ffffff']),
      paletteLocked: true,
    }));
    const result = editor.execute('banded_gradient', {
      layer: 0,
      frame: 0,
      rect: { x: 0, y: 0, w: 32, h: 16 },
      from: '#000000',
      to: '#ffffff',
      steps: 8,
      jitter: 0.8,
      seed: 3,
    }) as { jitterRequested: number; jitterApplied: number; warning?: string };
    expect(result.jitterRequested).toBe(0.8);
    expect(result.jitterApplied).toBe(0);
    expect(result.warning).toMatch(/palette-locked|CRT/);
  });

  it('clips generation to the visible canvas before allocating a field', () => {
    const editor = makeEditor(4, 4);
    const result = editor.execute('banded_gradient', {
      layer: 0,
      frame: 0,
      rect: { x: 100, y: 100, w: 4096, h: 4096 },
      from: '#101018',
      to: '#f0f0e0',
    }) as { pixels: number; painted: number };
    expect(result).toMatchObject({ pixels: 4096 * 4096, painted: 0 });
  });

  it('does not alias safe integer seeds that share the same low word', () => {
    const a = makeEditor(8, 8);
    const b = makeEditor(8, 8);
    const params = {
      layer: 0,
      frame: 0,
      rect: { x: 0, y: 0, w: 8, h: 8 },
      from: '#10182c',
      to: '#83b7b0',
      jitter: 0.5,
    };
    a.execute('banded_gradient', { ...params, seed: 1 });
    b.execute('banded_gradient', { ...params, seed: 4_294_967_297 });
    expect(snapshot(a)).not.toEqual(snapshot(b));
  });

  it('does not let transparent scatter samples block later opaque discs', () => {
    const editor = makeEditor(12, 12);
    const result = editor.execute('scatter', {
      layer: 0,
      frame: 0,
      rect: { x: 0, y: 0, w: 12, h: 12 },
      count: 40,
      colors: ['#00000000', '#ffffff'],
      radius: 2,
      falloff: 1,
      seed: 21,
    }) as { pixels: number; painted: number };
    expect(result.pixels).toBeGreaterThan(0);
    expect(result.painted).toBe(result.pixels);
  });

  it('places deterministic scatter clusters and enforces a size limit', () => {
    const a = makeEditor();
    const result = a.execute('scatter', {
      layer: 0,
      frame: 0,
      rect: { x: 0, y: 0, w: 12, h: 12 },
      count: 18,
      colors: ['#fff2c7', '#ffad4f', '#2b8296'],
      radius: 1,
      falloff: 0.5,
      cluster: 0.4,
      seed: 13,
    }) as { points: number; pixels: number; painted: number };
    expect(result.points).toBe(18);
    expect(result.pixels).toBeGreaterThan(0);
    expect(result.painted).toBe(result.pixels);
    expect(result.painted).toBeGreaterThan(0);

    const b = makeEditor();
    b.execute('scatter', {
      layer: 0,
      frame: 0,
      rect: { x: 0, y: 0, w: 12, h: 12 },
      count: 18,
      colors: ['#fff2c7', '#ffad4f', '#2b8296'],
      radius: 1,
      falloff: 0.5,
      cluster: 0.4,
      seed: 13,
    });
    expect(snapshot(a)).toEqual(snapshot(b));

    expect(() => makeEditor(64, 64).execute('scatter', {
      layer: 0,
      frame: 0,
      rect: { x: 0, y: 0, w: 64, h: 64 },
      count: 4096,
      radius: 24,
      seed: 1,
    })).toThrow(/2,000,000 safety limit/);
  });
});
