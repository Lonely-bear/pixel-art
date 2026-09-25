import { describe, expect, it } from 'vitest';
import { buildHueRamp, createEditor, createSprite } from '../src/index.js';

describe('hue-shifted palette ramps', () => {
  it('builds the requested number of colours and keeps the anchors at hueShift 0', () => {
    const ramp = buildHueRamp('#000000', '#ffffff', 5, { hueShift: 0 });

    expect(ramp.colors).toHaveLength(5);
    expect(ramp.hex).toHaveLength(5);
    expect(ramp.colors[0]).toMatchObject({ r: 0, g: 0, b: 0, a: 255 });
    expect(ramp.colors[4]).toMatchObject({ r: 255, g: 255, b: 255, a: 255 });
    // A neutral ramp stays neutral: no invented hue on black/white anchors.
    for (const color of ramp.colors) {
      expect(color.r).toBe(color.g);
      expect(color.g).toBe(color.b);
    }
  });

  it('pulls shadows cool and highlights warm along the short path', () => {
    const plain = buildHueRamp('#803030', '#f0d0a0', 5, { hueShift: 0 });
    const shifted = buildHueRamp('#803030', '#f0d0a0', 5, { hueShift: 30 });

    // #803030 is red; the cool target is blue/violet, so the short path goes through
    // magenta and the hue value moves well away from 0.
    expect(Math.abs(shifted.hue.from - plain.hue.from)).toBeGreaterThan(20);
    // #f0d0a0 is already warm, so the highlight end moves toward amber.
    expect(shifted.hue.to).not.toBe(plain.hue.to);
    expect(shifted.hue.from).not.toBe(plain.hue.from);
  });

  it('accepts absolute endpoint hues for full control', () => {
    const ramp = buildHueRamp('#404040', '#e0e0e0', 3, {
      shadowHue: 220,
      highlightHue: 45,
    });

    expect(Math.round(ramp.hue.from)).toBe(220);
    expect(Math.round(ramp.hue.to)).toBe(45);
  });

  it('adds a ramp through the command bus and dedupes repeats', () => {
    const editor = createEditor(createSprite({ width: 4, height: 4, name: 'Ramp' }));
    const before = editor.sprite.palette.colors.length;

    const first = editor.execute('add_palette_ramp', {
      from: '#241226',
      to: '#f2d2a0',
      steps: 4,
    }) as { added: number; skipped: number; size: number; colors: string[] };

    expect(first.added).toBe(4);
    expect(first.skipped).toBe(0);
    expect(first.colors).toHaveLength(4);
    expect(first.size).toBe(before + 4);

    const again = editor.execute('add_palette_ramp', {
      from: '#241226',
      to: '#f2d2a0',
      steps: 4,
    }) as { added: number; skipped: number; size: number };

    expect(again.added).toBe(0);
    expect(again.skipped).toBe(4);
    expect(again.size).toBe(before + 4);
  });

  it('can replace the palette with a ramp', () => {
    const editor = createEditor(createSprite({ width: 4, height: 4, name: 'Ramp' }));
    const result = editor.execute('add_palette_ramp', {
      from: '#101820',
      to: '#f0e0b0',
      steps: 6,
      mode: 'replace',
      name: 'Material ramp',
    }) as { mode: string; added: number; size: number };

    expect(result.mode).toBe('replace');
    expect(result.added).toBe(6);
    expect(result.size).toBe(6);
    expect(editor.sprite.palette.name).toBe('Material ramp');
  });
});
