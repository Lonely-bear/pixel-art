import { describe, expect, it } from 'vitest';
import { ALPHA_SOLID, createQualityContext } from '../src/quality/context.js';
import {
  countsAsHueFamily,
  hueSatValueOf,
  HUE_SECTORS,
  measurePalette,
  paletteAnalyzer,
  paletteClassFor,
  type PaletteFrame,
} from '../src/quality/palette.js';
import { createSprite, type Sprite } from '../src/document.js';
import { PixelBuffer } from '../src/buffer.js';
import { colorDistanceWeighted, createPalette } from '../src/palette.js';
import type { QualityIssue } from '../src/quality/types.js';

/**
 * §4.3's six measures, and the one job this file has: **prove each of them can fail.**
 *
 * ## Why this file starts where a normal test file would not
 *
 * T-014's predecessor shipped `palette.ts` with three measures reported as reading 0 on every case
 * in a 67-case corpus, and no report explaining why. §7.2's finding seven is the shape of that: three
 * times in this repository a measure has read 0 everywhere and turned out to be *unable* to read —
 * a counter capped at 1, a band table walked in the wrong direction, and a neighbour count that
 * included the pixel itself. So "the corpus is quiet" is not evidence, and **an assertion that
 * passes with and without the implementation proves nothing** (§3.2).
 *
 * Every measure below therefore gets a shape on which it **must** fire, and each shape is chosen so
 * the firing is forced by arithmetic rather than by luck:
 *
 * | measure             | shape                                              | why it cannot be quiet            |
 * | ------------------- | -------------------------------------------------- | --------------------------------- |
 * | `offPalette`        | half the ink a hex the palette does not name       | 500 per-mille is past every band   |
 * | `maxNearestDistance`| one pixel of magenta among declared swatches       | redmean distance from every swatch |
 * | `muddy`             | an undeclared olive at 75 per-mille                | `s255 <= 76`, `64 <= v255 <= 204` |
 * | `meanSat`           | three near-grey tints of three different hues      | mean `s255` 15 of 255, gate at 38.25 |
 * | `hueSectors`        | seven 30-degree sectors on a 32x32                 | sector index is `floor(h / 30)`    |
 * | `distinctColours`   | eleven declared swatches on a 16x16                | `small`'s budget is 10             |
 *
 * and **every one of them is paired with a shape on the other side of its own gate**, because a test
 * that only proves a gate is reachable says nothing about where it sits. The pair is named in the
 * test name in both directions (`fires on …` / `does NOT fire …`).
 *
 * ## The fixtures are drawn, not poked
 *
 * Same rule as `quality-value.test.ts`: a colour-discipline test whose input is `data[i*4+3] = 255`
 * in six places cannot be reviewed. Every subject here is a {@link Grid}, which is a picture of
 * hex colours that prints itself as rows, and **the grid and the declared palette are two separate
 * lists** — the whole dimension is about the difference between them, and a fixture that could only
 * draw from its palette would say nothing about a colour that is not in it.
 */

/* ------------------------------------------------------------------ *
 * The named colours, with their §3.4 readings computed by hand
 * ------------------------------------------------------------------ */

/**
 * Colours that are in no fixture palette, chosen so each one sits on a different side of a §4.3
 * gate. The `s255` / `v255` / `h360` / sector figures in each comment are the specification's
 * integer form worked out by hand and asserted in the tests below, so a comment that drifts from
 * the arithmetic is a comment the tests contradict.
 */
const UNDECLARED = {
  /** `s255 255`, `v255 255`, `h 329`. Far from every fixture swatch, and **not** one of `SEVEN_HUES`. */
  magenta: '#ff0080',
  /** `s255 42`, `v255 96` — **inside §3.4's muddy window**, which is `s255 <= 76`, `64 <= v255 <= 204`. */
  olive: '#605850',
  /** `s255 80`, `v255 226`. One channel step off `skin`; **outside** the muddy window by four. */
  skinDrift: '#e2d39b',
  /** `s255 170`, `v255 3`. Far from everything and below the window's `v255 >= 64`. */
  ink: '#010203',
  /** `s255 233`, `v255 120`. Off-palette, saturated, mid value — outside the window on one clause. */
  green: '#0a780a',
} as const;

/** `skin`, the swatch {@link UNDECLARED.skinDrift} is a step off. */
const SKIN = '#e8d9a0';

/**
 * Three near-grey tints at `s255 == 15`, one in each of three 30-degree sectors.
 *
 * This is the `grey-colours` fixture and the arithmetic is the specification's:
 * `s255 = floor((maxc - minc) * 255 / maxc)` is `floor(8 * 255 / 128) = 15` for all three, and
 * `countsAsHueFamily` is `s255 >= 12`, so all three count — while their hues are 0, 120 and 240,
 * which is sectors 0, 4 and 8. A mean of 15 is `15 / 255 = 5.9%` of full, and §4.3's gate is 15%.
 *
 * **This is the shape that separates §4.3's reading of the gate from §3.7's**, and the two are 255
 * times apart. §4.3 defines `meanSat` as "mean s255 over solid pixels, / 255" and gates it at
 * `< 15/100`, so the integer test is `sumS255 * 100 < 15 * 255 * N`. §3.7 transcribed it as
 * `sumS255 * 100 < 15 * N`, which asks for a mean `s255` below 0.15 — and `s255` is an integer, so
 * that reading is satisfied only by pixels that are *exactly* grey. On this fixture §4.3's test is
 * `1500 * 100 < 15 * 255 * 400` (true) and §3.7's was `1500 * 100 < 15 * 400` (false). Both are
 * asserted below from the measurements, so the row cannot pass with the wrong one in the code.
 */
const GREY_TINTS = ['#807878', '#788078', '#787880'] as const;

/**
 * Seven hues 30 to 60 degrees apart, at full saturation, so each lands in its own 30-degree sector.
 *
 * Sectors 0, 2, 4, 6, 8, 10 and 1 — note that the seventh is `h 30`, which is sector **1** and not
 * sector 11, which is the arithmetic that keeps a twelve-sector table from having a thirteenth.
 */
const SEVEN_HUES = ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ff8000'] as const;

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function hexToRgb(hex: string): readonly [number, number, number] {
  if (!/^#[0-9a-f]{6}$/.test(hex)) throw new Error(`not a 6-digit lowercase hex: ${hex}`);
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/**
 * A picture, which prints itself so a reviewer can see the subject.
 *
 * Every pixel is a hex string or `null` for transparent, so a fixture that wants a colour outside
 * its declared palette just writes one and the difference between the two lists is the thing under
 * test.
 */
class Grid {
  private readonly cells: (string | null)[][];

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.cells = Array.from({ length: h }, () => new Array<string | null>(w).fill(null));
  }

  set(x: number, y: number, hex: string | null): void {
    this.cells[y][x] = hex;
  }

  /** A filled rectangle, clipped rather than throwing: a fixture may draw to the edge. */
  rect(x: number, y: number, w: number, h: number, hex: string): void {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        if (xx >= 0 && xx < this.w && yy >= 0 && yy < this.h) this.set(xx, yy, hex);
      }
    }
  }

  /** `w` columns of equal height from `x`, cycling through `hexes` — a striped sprite. */
  stripes(x: number, y: number, w: number, h: number, hexes: readonly string[]): void {
    this.rect(x, y, w, h, hexes[0]);
    for (let i = 0; i < hexes.length; i++) {
      const band = Math.floor(w / hexes.length);
      this.rect(x + i * band, y, i === hexes.length - 1 ? w - i * band : band, h, hexes[i]);
    }
  }

  /** The picture, one row per line, abbreviated so a 32-wide grid does not fill the terminal. */
  picture(maxWidth = 200): string {
    return this.cells
      .map((row) => row.map((cell) => (cell === null ? '.....' : cell.slice(1))).join(' ').slice(0, maxWidth))
      .join('\n');
  }
}

/** The palette every fixture starts from: the corpus's own two, then the ones this file needs. */
const BASE_PALETTE: readonly string[] = ['#3a2f2a', SKIN, '#7a4a2a', '#2a4a7a', '#c8c8c8', '#5a5a5a', ...GREY_TINTS];

/**
 * A sprite from a grid and a declared palette.
 *
 * The palette is passed in rather than derived from the grid, because that separation **is** the
 * dimension: a sprite whose ink is entirely swatches is disciplined, and the only way a fixture can
 * show an undeclared colour is to name one that is not in the list beside it.
 */
function spriteOf(
  grid: Grid,
  swatches: readonly string[] = BASE_PALETTE,
  partial?: { readonly y: number; readonly alpha: number },
): Sprite {
  const sprite = createSprite({
    width: grid.w,
    height: grid.h,
    name: 'palette-fixture',
    layers: ['Base'],
    palette: createPalette('fixture', [...swatches]),
  });
  const cel = new PixelBuffer(grid.w, grid.h);
  for (let y = 0; y < grid.h; y++) {
    for (let x = 0; x < grid.w; x++) {
      const hex = grid.cells[y][x];
      if (hex === null) continue;
      const rgb = hexToRgb(hex);
      const i = cel.index(x, y);
      cel.data[i] = rgb[0];
      cel.data[i + 1] = rgb[1];
      cel.data[i + 2] = rgb[2];
      cel.data[i + 3] = partial !== undefined && y === partial.y ? partial.alpha : 255;
    }
  }
  sprite.frames[0].cels.set(sprite.layers[0].id, cel);
  return sprite;
}

function frameOf(grid: Grid, swatches: readonly string[] = BASE_PALETTE): PaletteFrame {
  return measurePalette(createQualityContext(spriteOf(grid, swatches)))[0];
}

/** A `w x h` inked block with a `margin`-px transparent border all round. */
function solid(hex: string, w = 20, h = 20, margin = 2): Grid {
  const grid = new Grid(w + margin * 2, h + margin * 2);
  grid.rect(margin, margin, w, h, hex);
  return grid;
}

function codes(issues: readonly QualityIssue[]): string[] {
  return [...issues.map((issue) => issue.code)].sort();
}

function severityOf(issues: readonly QualityIssue[], code: string): number | undefined {
  return issues.find((issue) => issue.code === code)?.severity;
}

/** Overwrite the first `n` pixels of a grid with `hex`, in reading order. */
function repaint(grid: Grid, n: number, hex: string): Grid {
  let written = 0;
  for (let y = 0; y < grid.h && written < n; y++) {
    for (let x = 0; x < grid.w && written < n; x++) {
      if (grid.cells[y][x] !== null) {
        grid.set(x, y, hex);
        written++;
      }
    }
  }
  if (written !== n) throw new Error(`only ${written} solid pixels available, needed ${n}:\n${grid.picture()}`);
  return grid;
}

/* ------------------------------------------------------------------ *
 * 1 · `offPalette` and `offPaletteRatio` — the primary ratio
 * ------------------------------------------------------------------ */

describe('off-palette: the primary ratio, and the band table read from the right end', () => {
  it('fires on a sprite that is half undeclared, at 500 per-mille past every band', () => {
    // Half the ink is a one-step drift off `skin`: a **declared** swatch is at hand and the colour
    // is still not it, because §4.3 defines off-palette as *exact* non-membership. 240 of 480 pixels
    // is `rhu(240000, 480) = 500`, which is past every bound in the table, so the base is the
    // `> 40/100` row at 300.
    const grid = new Grid(24, 24);
    grid.rect(2, 2, 20, 10, SKIN);
    grid.rect(2, 12, 20, 10, UNDECLARED.skinDrift);
    const frame = frameOf(grid);
    expect(frame.N).toBe(400);
    expect(frame.offPalette).toBe(200);
    expect(frame.offPaletteQ).toBe(500);
    expect(frame.baseQ).toBe(300);
    expect(frame.distinctColours).toBe(2);
    // Only `off-palette`. `muddy` does not fire because the drift is `s255 80`, four above the
    // window's 76, and `invented-colours` does not because the redmean distance is 300. **The two
    // are what make this the isolating case for the primary ratio**, and each is the subject of its
    // own pair further down.
    expect(codes(frame.issues)).toEqual(['off-palette']);
    // 500 per-mille is above §4.3's 0.20, so the issue is **blocking** at severity 0.55 rather than
    // the 0.35 advisory. The two severities are one fact at two distances.
    expect(severityOf(frame.issues, 'off-palette')).toBe(0.55);
    expect(frame.scoreQ).toBe(300);
    expect(frame.measured).toBe(true);
  });

  it('reports 100 per-mille as an advisory and 500 as blocking, which is the same defect at two distances', () => {
    // 40 pixels of drift out of 400 is `rhu(40000, 400) = 100`: past §4.3's `<= 8/100` band, far
    // below its blocking `> 20/100`, and **above §4.3's `off-palette` trigger of `2/100`**, which is
    // 20 per-mille. Only the ratio differs from the test above, and it changes the base, the severity
    // and the code — one fact read at two distances.
    const frame = frameOf(repaint(solid(SKIN), 40, UNDECLARED.skinDrift));
    expect(frame.offPalette).toBe(40);
    expect(frame.offPaletteQ).toBe(100);
    expect(frame.baseQ).toBe(720);
    expect(codes(frame.issues)).toEqual(['off-palette']);
    expect(severityOf(frame.issues, 'off-palette')).toBe(0.35);
    expect(frame.scoreQ).toBe(720);
  });

  it('scores a sprite with nothing off the palette 1000, which a reversed band table cannot do', () => {
    // §7.2's finding three: `noise`'s band table was written descending and read with a `for` loop,
    // so every case in a 67-case corpus reported the *worst* band and the dimension read 200
    // everywhere. Here the ratio is exactly 0 and the answer must be the *best* band. A table walked
    // in the wrong direction cannot pass this row, and the row is one line.
    const frame = frameOf(solid(SKIN));
    expect(frame.offPaletteQ).toBe(0);
    expect(frame.baseQ).toBe(1000);
    expect(frame.scoreQ).toBe(1000);
    expect(frame.issues).toEqual([]);
  });

  it('lands each of §4.3\'s bands where the table says, from the pixels rather than from the code', () => {
    // Every bound, computed here as `rhu(off * 1000, N)` over 400 solid pixels, so the table is a
    // check rather than a transcription — the same discipline `format.ts` keeps `SPEC_GATES` under.
    const expected: readonly (readonly [number, number, number])[] = [
      // off, offQ, baseQ
      [0, 0, 1000],
      [8, 20, 950],
      [32, 80, 850],
      [80, 200, 720],
      [160, 400, 550],
      [200, 500, 300],
    ];
    for (const [off, offQ, baseQ] of expected) {
      const frame = frameOf(repaint(solid(SKIN), off, UNDECLARED.skinDrift));
      expect([off, frame.offPalette, frame.offPaletteQ, frame.baseQ]).toEqual([off, off, offQ, baseQ]);
    }
    // And the issue's own trigger is `> 2/100`, which is **20 per-mille**, not 200: 19 off-palette
    // pixels of 400 is 47 and is silent, 40 is 100 and reports at severity 0.35, and 200 is where it
    // blocks. **This is where the first version of this analyzer was wrong by a factor of ten** — it
    // compared against 200, so a sprite with a quarter of its pixels off the palette sat inside the
    // `<= 20/100` band at 720 with no issue at all. §4.3's own notation is in hundredths and this
    // pipeline is in thousandths, and the conversion happened once too often.
    expect(codes(frameOf(repaint(solid(SKIN), 7, UNDECLARED.skinDrift)).issues)).toEqual([]);
    expect(frameOf(repaint(solid(SKIN), 8, UNDECLARED.skinDrift)).offPaletteQ).toBe(20);
    expect(codes(frameOf(repaint(solid(SKIN), 8, UNDECLARED.skinDrift)).issues)).toEqual([]);
    expect(frameOf(repaint(solid(SKIN), 9, UNDECLARED.skinDrift)).offPaletteQ).toBe(23);
    expect(codes(frameOf(repaint(solid(SKIN), 9, UNDECLARED.skinDrift)).issues)).toEqual(['off-palette']);
    expect(severityOf(frameOf(repaint(solid(SKIN), 9, UNDECLARED.skinDrift)).issues, 'off-palette')).toBe(0.35);
    expect(severityOf(frameOf(repaint(solid(SKIN), 80, UNDECLARED.skinDrift)).issues, 'off-palette')).toBe(0.35);
    expect(frameOf(repaint(solid(SKIN), 80, UNDECLARED.skinDrift)).offPaletteQ).toBe(200);
    expect(severityOf(frameOf(repaint(solid(SKIN), 81, UNDECLARED.skinDrift)).issues, 'off-palette')).toBe(0.55);
  });

  it('counts a colour off the palette at 20 per-mille, which is §4.3\'s first reporting row', () => {
    // 8 of 400 is exactly 20 per-mille, which is §4.3's `<= 2/100` band at 950 — and it is also the
    // `>` boundary of the issue's own trigger, so this is the **last silent row**. The sprite does
    // contain a colour that is not in the palette, which is what makes the row a discrimination and
    // not a tautology.
    const frame = frameOf(repaint(solid(SKIN), 8, UNDECLARED.skinDrift));
    expect(frame.offPalette).toBe(8);
    expect(frame.offPaletteQ).toBe(20);
    expect(frame.baseQ).toBe(950);
    expect(frame.issues).toEqual([]);
    expect(frame.scoreQ).toBe(950);
  });
});

/* ------------------------------------------------------------------ *
 * 2 · `maxNearestDistance` — snapping miss against invented colour
 * ------------------------------------------------------------------ */

describe('invented-colours: a colour far from every swatch, and one that is not', () => {
  it('fires on a single magenta pixel, alone, and the number is not a threshold artefact', () => {
    // One pixel of `#ff00ff` among 399 pixels of the corpus's own `#3a2f2a`. §3.4's redmean distance
    // `(((512 + rmean) * dr * dr) >> 8) + 4 * dg * dg + (((767 - rmean) * db * db) >> 8)` is over
    // 12000 to every swatch in the fixture palette on its own. **The assertion is on the measured
    // distance and not only on the code**, because §4.3's claim about this quantity is that it
    // separates two failure modes, and only a number can show that it moved.
    const frame = frameOf(repaint(solid('#3a2f2a'), 1, UNDECLARED.magenta));
    expect(frame.offPalette).toBe(1);
    expect(frame.offPaletteQ).toBe(3);
    // 3 per-mille is inside §4.3's `<= 2/100` row, so `off-palette` does **not** fire and
    // `invented-colours` fires alone. That isolation is deliberate: it is the only way this code
    // can be shown to be reachable on its own rather than as a passenger.
    expect(frame.baseQ).toBe(950);
    expect(frame.maxNearestDistance).toBeGreaterThan(12000);
    expect(codes(frame.issues)).toEqual(['invented-colours']);
    expect(severityOf(frame.issues, 'invented-colours')).toBe(0.4);
    expect(frame.scoreQ).toBe(850);
  });

  it('does NOT fire on the same drawing one channel step off a swatch, and fires when it is not', () => {
    // The pair §4.3 justifies the quantity with. Both halves are 480 solid pixels at an identical
    // `offPaletteRatio` of 500, so the band, the `off-palette` severity and the score all agree; the
    // **only** difference is how far the undeclared colour is from the nearest swatch, and the code
    // that fires is exactly the one the specification says separates them.
    const nearGrid = new Grid(24, 24);
    nearGrid.rect(2, 2, 20, 10, SKIN);
    nearGrid.rect(2, 12, 20, 10, UNDECLARED.skinDrift);
    const near = frameOf(nearGrid);
    expect(near.offPaletteQ).toBe(500);
    expect(near.maxNearestDistance).toBe(300); // redmean of the 6/6/5 step, computed by hand
    expect(near.maxNearestDistance).toBeLessThan(12000);
    expect(codes(near.issues)).toEqual(['off-palette']);
    expect(near.scoreQ).toBe(300);

    const farGrid = new Grid(24, 24);
    farGrid.rect(2, 2, 20, 10, SKIN);
    farGrid.rect(2, 12, 20, 10, UNDECLARED.magenta);
    const far = frameOf(farGrid);
    expect(far.offPaletteQ).toBe(500);
    expect(far.maxNearestDistance).toBeGreaterThan(12000);
    expect(codes(far.issues)).toEqual(['invented-colours', 'off-palette']);
    expect(far.scoreQ).toBe(200);
  });

  it('is 0 on a sprite whose every colour is declared, because a swatch is distance 0 from itself', () => {
    const frame = frameOf(solid(SKIN));
    expect(frame.maxNearestDistance).toBe(0);
    expect(codes(frame.issues)).toEqual([]);
  });

  it('counts an invented colour that is also muddy on both counts, from one drawing', () => {
    // The olive is off-palette and muddy and **not** invented: `s255 42`, `v255 96`, and its nearest
    // swatch is `#5a5a5a` at a redmean of a few thousand. All three facts are asserted from one
    // drawing, because a reader checking any one of them cannot infer the others, and because
    // `invented-colours` firing on this same fixture would be the failure mode §4.3's separation of
    // "a colour one step off a ramp entry" from "a colour 30000 away from every swatch" exists to
    // prevent.
    const frame = frameOf(repaint(solid(SKIN), 30, UNDECLARED.olive));
    expect(frame.muddy).toBe(30);
    expect(frame.maxNearestDistance).toBeLessThan(12000);
    expect(frame.hueSectors).toBe(1);
    expect(codes(frame.issues)).toEqual(['muddy-mix', 'off-palette']);
  });
});

/* ------------------------------------------------------------------ *
 * 3 · `muddy` / `muddyRatio`
 * ------------------------------------------------------------------ */

describe('muddy-mix: off-palette AND inside §3.4\'s muddy window', () => {
  it('fires at 75 per-mille, and comes with `off-palette` because §4.3\'s own numbers require it', () => {
    // 30 pixels of olive out of 400 is `rhu(30000, 400) = 75`, past §4.3's `>= 5/100` = 50.
    //
    // **It also carries `off-palette`, and that is not an accident of this fixture.** §4.3 defines
    // `muddy` over *off-palette* pixels, so `muddy <= offPalette` pixel for pixel and therefore
    // `muddyRatio <= offPaletteRatio` always. A muddy ratio of 50 per-mille is an off-palette ratio
    // of at least 50, which is past §4.3's `> 2/100` = 20. **So `muddy-mix` can never fire alone**,
    // and the threshold table says so whether or not §4.3 says it in words. The code is still worth
    // having — it says the off-palette pixels are low-saturation mid-value *mixes* rather than
    // arbitrary hexes, and its fix is a decision about how the colour was made rather than one
    // `quantize_to_palette` call — but it is a **refinement** of `off-palette` and not a peer of it,
    // and a reader of a report that shows only one of the two has been shown a partial fact.
    const frame = frameOf(repaint(solid(SKIN), 30, UNDECLARED.olive));
    expect(frame.offPalette).toBe(30);
    expect(frame.offPaletteQ).toBe(75);
    expect(frame.muddy).toBe(30);
    expect(frame.muddyQ).toBe(75);
    expect(frame.baseQ).toBe(850);
    expect(codes(frame.issues)).toEqual(['muddy-mix', 'off-palette']);
    expect(severityOf(frame.issues, 'muddy-mix')).toBe(0.35);
    expect(severityOf(frame.issues, 'off-palette')).toBe(0.35);
    expect(frame.scoreQ).toBe(750);
    // The nesting itself, asserted rather than argued: on every drawing in this file the invariant
    // `muddy <= offPalette` and `muddyQ <= offPaletteQ` holds, and the two thresholds are 50 and 20.
    for (const grid of [repaint(solid(SKIN), 30, UNDECLARED.olive), repaint(solid(SKIN), 200, UNDECLARED.olive)]) {
      const probed = frameOf(grid);
      expect(probed.muddy).toBeLessThanOrEqual(probed.offPalette);
      expect(probed.muddyQ).toBeLessThanOrEqual(probed.offPaletteQ);
      expect(severityOf(probed.issues, 'off-palette')).toBeDefined();
    }
  });

  it('does NOT count a muddy colour that IS in the palette, which is the off-palette conjunct', () => {
    // §4.3 defines `muddy` over **off-palette** pixels, so the same olive drawn from the palette is
    // not muddy. This pair is what keeps the code from being "low saturation" renamed, and it is the
    // only place in §4.3 where two conditions are ANDed into one ratio.
    const declared = frameOf(repaint(solid(SKIN), 30, UNDECLARED.olive), [...BASE_PALETTE, UNDECLARED.olive]);
    expect(declared.offPalette).toBe(0);
    expect(declared.muddy).toBe(0);
    expect(declared.issues).toEqual([]);
    expect(declared.scoreQ).toBe(1000);
    // Exact membership, from both sides: one channel away from the same declared olive **is**
    // counted, because it is not the swatch.
    expect(frameOf(repaint(solid(SKIN), 30, UNDECLARED.olive)).muddy).toBe(30);
  });

  it('does NOT count an off-palette colour outside the window, on either clause of it', () => {
    // §3.4's window is `s255 <= 76` **and** `64 <= v255 <= 204`. Left half `#0a780a` is saturated
    // (`s255 233`); right half `#010203` is dark (`v255 3`). Both are off-palette and neither is
    // muddy. A window with only the saturation clause would count the left half, one with only the
    // value clause would count the right, and one with no window would count all 60.
    const grid = solid(SKIN);
    grid.rect(2, 2, 20, 10, UNDECLARED.green);
    grid.rect(2, 12, 20, 10, UNDECLARED.ink);
    const frame = frameOf(grid);
    expect(frame.offPalette).toBe(400);
    expect(frame.muddy).toBe(0);
    expect(frame.muddyQ).toBe(0);
    // One hue family from the saturated half and one from the dark half: `s255 233` and `s255 170`,
    // both `>= 12`, at hues 60 and 210 — sectors 2 and 7. `hue-sprawl` needs seven and this is two.
    expect(frame.hueSectors).toBe(2);
    expect(codes(frame.issues)).toEqual(['invented-colours', 'off-palette']);
    // Which is §4.3's two remaining codes firing on a sprite that is *saturated and dark* rather
    // than muddy, and is the reason `muddy-mix` exists as its own row instead of being folded into
    // `invented-colours`.
  });

  it('does NOT fire at 48 per-mille, one step below the trigger, even though off-palette does', () => {
    // 19 of 400 is `rhu(19000, 400) = 48`, and §4.3's gate is `>= 5/100` = 50. **This is the pair
    // that separates the two codes**: at 48 per-mille the sprite is still reported `off-palette`,
    // because 48 > 20, and `muddy-mix` is silent because 48 < 50. One pixel more and it fires.
    const below = frameOf(repaint(solid(SKIN), 19, UNDECLARED.olive));
    expect(below.muddyQ).toBe(48);
    expect(codes(below.issues)).toEqual(['off-palette']);
    const at = frameOf(repaint(solid(SKIN), 20, UNDECLARED.olive));
    expect(at.muddyQ).toBe(50);
    expect(codes(at.issues)).toEqual(['muddy-mix', 'off-palette']);
  });
});

/* ------------------------------------------------------------------ *
 * 4 · `meanSat` / `hueSectors` — the reading §3.7 got wrong
 * ------------------------------------------------------------------ */

describe('grey-colours: three washed-out hue families, which is §4.3\'s reading and not §3.7\'s', () => {
  /** Three vertical bands, one per grey tint, on a 24x24 with a 2px margin. */
  function washedOut(): Grid {
    const grid = new Grid(24, 24);
    grid.rect(2, 2, 6, 20, GREY_TINTS[0]);
    grid.rect(8, 2, 6, 20, GREY_TINTS[1]);
    grid.rect(14, 2, 8, 20, GREY_TINTS[2]);
    return grid;
  }

  it('fires on three near-grey tints of three hues, and §3.7\'s transcription does not fire on them', () => {
    // All three tints have `s255 15`, all three are `>= 12` so all three count as hue families, and
    // their hues 0 / 120 / 240 are sectors 0 / 4 / 8. The mean is `s255 15` = 5.9% of full against a
    // 15% gate, so §4.3's row fires and nothing else does: every colour is declared, there are three
    // of them against a budget of 16, and `s255 15` is nowhere near the muddy window.
    const frame = frameOf(washedOut());
    expect(frame.N).toBe(400);
    expect(frame.distinctColours).toBe(3);
    expect(frame.hueSectors).toBe(3);
    expect(frame.satSum).toBe(400 * 15);
    expect(frame.meanSatQ).toBe(59); // rhu(15 * 1000, 255) = 58.8, i.e. 5.9% of full
    expect(codes(frame.issues)).toEqual(['grey-colours']);
    expect(severityOf(frame.issues, 'grey-colours')).toBe(0.3);
    expect(frame.scoreQ).toBe(900);

    // **Both readings of §4.3's gate, computed here from the measurements above.** §4.3 defines
    // `meanSat` as the mean `s255` divided by 255 and gates it below 15/100, so the integer test is
    // `sumS255 * 100 < 15 * 255 * N`. §3.7 wrote `sumS255 * 100 < 15 * N`, which asks for a mean
    // `s255` below 0.15 — and `s255` is an integer, so on this fixture that reading is **false**.
    const N = frame.N;
    const sumS255 = frame.satSum;
    expect(sumS255 * 100).toBeLessThan(15 * 255 * N);
    expect(sumS255 * 100).not.toBeLessThan(15 * N);
    // So this row decides which document was wrong. With §3.7's old transcription in `palette.ts`
    // the code above would not have fired, `scoreQ` would have been 1000, and this test would be red.
  });

  it('does NOT fire on the same three hues at full saturation, so the gate is saturation and not hue count', () => {
    // Sectors 0 / 4 / 8 again and the same geometry; only `s255` moves, from 15 to 182, so the mean
    // goes from 5.9% of full to 71%. A sprite with three hue families is not a defect; a sprite
    // whose three hue families are washed out is.
    const saturated: readonly string[] = ['#e04040', '#40e040', '#4040e0'];
    const grid = washedOut();
    grid.rect(2, 2, 6, 20, saturated[0]);
    grid.rect(8, 2, 6, 20, saturated[1]);
    grid.rect(14, 2, 8, 20, saturated[2]);
    const frame = frameOf(grid, [...BASE_PALETTE, ...saturated]);
    expect(frame.hueSectors).toBe(3);
    expect(frame.satSum).toBe(frame.N * 182);
    expect(frame.meanSatQ).toBe(714); // rhu(182 * 1000, 255) = 713.7
    expect(codes(frame.issues)).toEqual([]);
    expect(frame.scoreQ).toBe(1000);
  });

  it('does NOT fire on a genuinely grey sprite, which has no hue families to wash out', () => {
    // §4.3's row is `meanSat < 15/100` **and** `hueSectors >= 3`. A greyscale sprite satisfies the
    // first clause absolutely — `s255` is 0 for every pixel — and cannot satisfy the second, because
    // hue sectors are counted only for `s255 >= 12`. **This is the conjunct's whole job**: without
    // it every greyscale asset in a game engine would be told its colour is undisciplined, and
    // `human/tile-32` in the corpus is exactly that.
    const frame = frameOf(solid('#5a5a5a'), ['#3a2f2a', '#5a5a5a', '#8a8a8a']);
    expect(frame.hueSectors).toBe(0);
    expect(frame.satSum).toBe(0);
    expect(frame.meanSatQ).toBe(0);
    expect(codes(frame.issues)).toEqual([]);
    expect(frame.scoreQ).toBe(1000);
  });

  it('does NOT fire on a washed-out sprite that has only one hue family, which is the same conjunct', () => {
    // The same fixture with the middle and right bands left at the ink colour: mean `s255` falls to
    // `(15 + 70 * 399) / 400 = 69.8`, which is 27% of full, and one hue family is below the gate's
    // three. **Both halves of the conjunct are needed and each alone withholds the code**, which is
    // the assertion: a gate of "low saturation" with no hue clause and a gate of "three hues" with
    // no saturation clause each fire on half of this pair.
    const grid = new Grid(24, 24);
    grid.rect(2, 2, 6, 20, GREY_TINTS[0]);
    grid.rect(8, 2, 14, 20, '#3a2f2a');
    const frame = frameOf(grid);
    expect(frame.hueSectors).toBe(1);
    expect(codes(frame.issues)).toEqual([]);
    expect(frame.scoreQ).toBe(1000);
  });

  it('counts a hue family only at s255 >= 12, and there are twelve sectors and never a thirteenth', () => {
    // §3.4's own clause is `(maxc - minc) * 100 >= 12 * maxc`, and `hueSatValueOf` is §3.4's integer
    // form. Computed rather than quoted, because the boundary is one arithmetic step from counting a
    // near-black as a hue: at `s255 11` the sprite has a hue family, at `s255 12` it does not, and a
    // rounding slip in either direction would be invisible on a green sprite and visible here.
    expect(hueSatValueOf(128, 120, 120).s255).toBe(15); // floor(8 * 255 / 128)
    expect(countsAsHueFamily(15)).toBe(true);
    expect(hueSatValueOf(64, 63, 63).s255).toBe(3); // floor(1 * 255 / 64)
    expect(countsAsHueFamily(3)).toBe(false);
    expect(countsAsHueFamily(12)).toBe(true);
    expect(countsAsHueFamily(11)).toBe(false);
    // The three grey tints really are three sectors, from the same function.
    expect(GREY_TINTS.map((hex) => hueSatValueOf(...hexToRgb(hex)))).toMatchObject([
      { h360: 0, s255: 15 },
      { h360: 120, s255: 15 },
      { h360: 240, s255: 15 },
    ]);
    expect(HUE_SECTORS).toBe(12);
    // And a hue of exactly 360 wraps to sector 0 with hue 0 rather than opening a thirteenth.
    for (const h of [0, 29, 30, 59, 60, 179, 180, 299, 300, 359]) {
      expect(Math.floor(h / 30)).toBeGreaterThanOrEqual(0);
      expect(Math.floor(h / 30)).toBeLessThan(HUE_SECTORS);
    }
    expect(Math.floor(360 / 30)).toBe(HUE_SECTORS);
    expect(Math.floor((360 % 360) / 30)).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 5 · `hueSectors` / `hue-sprawl` — and the one row §4.3 exempts by class
 * ------------------------------------------------------------------ */

describe('hue-sprawl: seven 30-degree sectors, and the scene exemption that is the only discriminator', () => {
  /** `count` hue bands on a `size x size` canvas with an 8px margin on every side. */
  function hueBands(count: number, size: number): Grid {
    const grid = new Grid(size, size);
    const span = size - 16;
    const band = Math.floor(span / count);
    for (let i = 0; i < count; i++) {
      grid.rect(8 + i * band, 8, i === count - 1 ? span - i * band : band, size - 16, SEVEN_HUES[i]);
    }
    return grid;
  }

  it('fires at exactly seven sectors on a compact canvas, and not at six', () => {
    const swatches = ['#3a2f2a', ...SEVEN_HUES];
    const six = frameOf(hueBands(6, 32), swatches);
    // Six is below §4.3's `>= 7`, and it is the negative control for this row: a striped sprite
    // with a real hue walk, drawn entirely from a declared palette, and disciplined by the
    // specification's own table.
    expect(six.hueSectors).toBe(6);
    expect(codes(six.issues)).toEqual([]);
    expect(six.scoreQ).toBe(1000);

    const seven = frameOf(hueBands(7, 32), swatches);
    expect(seven.hueSectors).toBe(7);
    expect(codes(seven.issues)).toEqual(['hue-sprawl']);
    expect(severityOf(seven.issues, 'hue-sprawl')).toBe(0.3);
    expect(seven.paletteClass).toBe('compact');
    expect(seven.colourBudget).toBe(16);
    expect(seven.scoreQ).toBe(900);
    // Every other measure is clean on this drawing, which is what makes `hue-sprawl` the isolating
    // case: seven declared swatches, nothing off the palette, nothing muddy, nothing invented, and
    // the mean saturation is full.
    expect(seven.offPalette).toBe(0);
    expect(seven.muddy).toBe(0);
    expect(seven.maxNearestDistance).toBe(0);
    expect(seven.distinctColours).toBe(7);
  });

  it('does NOT fire on the identical drawing at scene class, which is §4.3\'s only discriminator', () => {
    // The same seven hue bands, same swatches, at 256x256: `class` becomes `scene` and §4.3 exempts
    // `hue-sprawl` there **on area alone**. This is the pair that says the exemption is load-bearing
    // rather than a bug — a sunset with seven hue families is a sunset — and it is also §7 item 8's
    // standing complaint in one row: the class is the *only* discriminator, and area is a proxy for
    // asset type that happens to be available.
    const swatches = ['#3a2f2a', ...SEVEN_HUES];
    const scene = frameOf(hueBands(7, 256), swatches);
    expect(scene.hueSectors).toBe(7);
    expect(scene.paletteClass).toBe('scene');
    expect(scene.colourBudget).toBe(96);
    expect(codes(scene.issues)).toEqual([]);
    expect(scene.scoreQ).toBe(1000);
    // And the class table itself, at every boundary §4.3 writes. Keyed on **canvas area**, not on
    // the solid count, and the pair below is what shows it is not keyed on `N`.
    expect(paletteClassFor(512)).toEqual({ cls: 'small', budget: 10 });
    expect(paletteClassFor(513)).toEqual({ cls: 'compact', budget: 16 });
    expect(paletteClassFor(1024)).toEqual({ cls: 'compact', budget: 16 });
    expect(paletteClassFor(1025)).toEqual({ cls: 'medium', budget: 28 });
    expect(paletteClassFor(4096)).toEqual({ cls: 'medium', budget: 28 });
    expect(paletteClassFor(4097)).toEqual({ cls: 'large', budget: 48 });
    expect(paletteClassFor(16384)).toEqual({ cls: 'large', budget: 48 });
    expect(paletteClassFor(16385)).toEqual({ cls: 'scene', budget: 96 });
  });

  it('reads the class off canvas area and not off the solid count, which is §4.3\'s stated reason', () => {
    // §4.3: "class and colour budget are keyed on canvas area S, not solid count, because the canvas
    // is what the artist chose and the budget follows from the room available." The same ink — 144
    // solid pixels in three colours — is `small` with a budget of 10 on a 16x16 and `scene` with a
    // budget of 96 on a 128x128. Keyed on `N` neither answer would move.
    const small = frameOf(solid(SKIN, 10, 10, 2), ['#3a2f2a', SKIN]);
    expect(small.N).toBe(100);
    expect(small.paletteClass).toBe('small');
    expect(small.colourBudget).toBe(10);
    const scene = new Grid(130, 130);
    scene.rect(12, 12, 10, 10, SKIN);
    const far = frameOf(scene, ['#3a2f2a', SKIN]);
    expect(far.N).toBe(100);
    expect(far.paletteClass).toBe('scene');
    expect(far.colourBudget).toBe(96);
  });
});

/* ------------------------------------------------------------------ *
 * 6 · `distinctColours` and the colour budget
 * ------------------------------------------------------------------ */

describe('colour-budget-exceeded: eleven declared swatches on a 16x16, and ten on the same canvas', () => {
  /** `count` distinct declared greys in `count` columns of a 16x16 with a 2px margin. */
  function swatchStripes(count: number): { grid: Grid; swatches: readonly string[] } {
    const swatches: string[] = ['#3a2f2a'];
    for (let i = 0; i < count - 1; i++) swatches.push(`#${(0x5a + i).toString(16).padStart(2, '0').repeat(3)}`);
    const grid = new Grid(16, 16);
    const span = 12;
    const band = Math.floor(span / count);
    for (let i = 0; i < count; i++) {
      grid.rect(2 + i * band, 2, i === count - 1 ? span - i * band : band, 12, swatches[i]);
    }
    return { grid, swatches };
  }

  it('does NOT fire at exactly the budget, and fires at the budget plus one', () => {
    // Ten distinct declared greys on a 16x16 is exactly `small`'s budget of 10, so §4.3's own table
    // calls it disciplined; eleven is not. **The pair is the whole test**: a `>` written as `>=`
    // passes the first row and fails the second, and the converse fails the first. Nothing else in
    // §4.3 moves between them — every colour is declared, all ten are pure greys so `s255` is 0 and
    // no hue family is counted, and `muddy` is empty because nothing is off the palette.
    const at = swatchStripes(10);
    const atBudget = frameOf(at.grid, at.swatches);
    expect(atBudget.distinctColours).toBe(10);
    expect(atBudget.colourBudget).toBe(10);
    expect(atBudget.offPalette).toBe(0);
    // The one hue family is the corpus's own ink, `s255 70`, at hue 18. The nine greys beside it
    // are `s255 0`, so the mean is 7 of 255 and `grey-colours`'s `hueSectors >= 3` conjunct is what
    // withholds that code — asserted here rather than assumed, because this fixture has both halves
    // of it in range and only the conjunct stops the fire.
    expect(atBudget.hueSectors).toBe(1);
    expect(atBudget.satSum).toBe(12 * 70);
    expect(codes(atBudget.issues)).toEqual([]);
    expect(atBudget.scoreQ).toBe(1000);

    const over = swatchStripes(11);
    const past = frameOf(over.grid, over.swatches);
    expect(past.distinctColours).toBe(11);
    expect(codes(past.issues)).toEqual(['colour-budget-exceeded']);
    expect(severityOf(past.issues, 'colour-budget-exceeded')).toBe(0.35);
    expect(past.scoreQ).toBe(800);
  });

  it('measures every colour the sprite used, including one that is not in the palette', () => {
    // §4.3: "distinctColours — distinct packed RGBA values among solid pixels". It is a count of what
    // was drawn, so an undeclared colour spends the budget like a declared one. **That is what makes
    // the row a discipline measure and not a membership measure**, and it is why a sprite can be
    // charged `colour-budget-exceeded` for a colour `off-palette` is already reporting.
    const grid = solid(SKIN);
    grid.rect(2, 2, 20, 10, UNDECLARED.skinDrift);
    const frame = frameOf(grid);
    expect(frame.distinctColours).toBe(2);
    expect(codes(frame.issues)).toEqual(['off-palette']);
    // And with the budget spent by declared swatches only, the row is silent even though a colour is
    // missing from the palette — the two rows are independent on purpose.
    expect(frameOf(solid(SKIN), ['#3a2f2a', SKIN]).distinctColours).toBe(1);
  });

  it('sums the adjustments from the rows, and never charges `off-palette` twice', () => {
    // Seven hue bands filling a 32x32, plus a 6x6 patch of undeclared magenta: 36 of 1024 pixels off
    // the palette is `rhu(36000, 1024) = 35`, which lands in §4.3's `<= 8/100` row at 850. Two rows
    // take 100 off that each — `hue-sprawl` for the seven sectors and `invented-colours` because the
    // magenta is 12,000-odd from every swatch — and `off-palette` fires and costs **nothing**, because
    // its ratio *is* the primary band. §4.3 states that reason for the missing row; the arithmetic
    // below is what shows it: a third -100 for the same 36 pixels would put this at 550 and would
    // charge the sprite twice for one fact.
    const stack = () => {
      const grid = new Grid(32, 32);
      const widths = [5, 5, 5, 5, 4, 4, 4];
      let x = 0;
      for (let i = 0; i < SEVEN_HUES.length; i++) {
        grid.rect(x, 0, widths[i], 32, SEVEN_HUES[i]);
        x += widths[i];
      }
      return grid;
    };
    const swatches = [...SEVEN_HUES];
    const light = stack();
    light.rect(0, 0, 6, 6, UNDECLARED.magenta);
    const frame = frameOf(light, swatches);
    expect(frame.N).toBe(1024);
    // Magenta is at hue 329, sector 10, which the sixth band already occupies, so the count is still
    // the seven the bands declared.
    expect(frame.hueSectors).toBe(7);
    expect(frame.offPalette).toBe(36);
    expect(frame.offPaletteQ).toBe(35);
    expect(frame.baseQ).toBe(850);
    expect(codes(frame.issues)).toEqual(['hue-sprawl', 'invented-colours', 'off-palette']);
    expect(frame.adjustment).toBe(-200);
    expect(frame.scoreQ).toBe(650);
  });

  it('clamps the adjustment total at §3.5\'s floor, and reports the clamped number', () => {
    // All five rows at once, on one drawing: seven hue bands, a body of undeclared olive
    // (`muddy-mix` -100 and `off-palette` from the band), a magenta patch far enough out to be an
    // `invented-colours` -100, and twelve extra declared swatches in the bottom rows to push
    // `distinctColours` past the `compact` budget of 16 (`colour-budget-exceeded` -200).
    //
    //     hue-sprawl             -100
    //     muddy-mix              -100
    //     invented-colours       -100
    //     colour-budget-exceeded -200
    //     total                  -500   ->  clamped to §3.5's [-450, +50] window
    //
    // **The clamp is reported rather than applied silently**: `frame.adjustment` is the clamped sum
    // and the raw arithmetic is in the comment above, so a reader can tell that 0 came from a floor
    // and not from five separate problems each of which cost the whole dimension.
    const grid = new Grid(32, 32);
    const widths = [5, 5, 5, 5, 4, 4, 4];
    let x = 0;
    for (let i = 0; i < SEVEN_HUES.length; i++) {
      grid.rect(x, 0, widths[i], 32, SEVEN_HUES[i]);
      x += widths[i];
    }
    const extras: string[] = [];
    for (let i = 0; i < 12; i++) extras.push(`#${(0x333333 + i * 0x010101).toString(16).padStart(6, '0')}`);
    // The olive and the magenta are deliberately **not** in the declared palette: that is what makes
    // 516 of the 1024 pixels off-palette and puts the base on the floor.
    const swatches = [...SEVEN_HUES, ...extras];
    // The olive body leaves the bottom four rows to carry the twelve extra swatches, one pixel each,
    // so every hue band still has 24 rows of its own colour and the sector count does not move.
    grid.rect(0, 0, 20, 24, UNDECLARED.olive);
    for (let i = 0; i < 12; i++) grid.set(2 + i, 30, extras[i]);
    grid.rect(24, 24, 6, 6, UNDECLARED.magenta);
    const frame = frameOf(grid, swatches);
    expect(frame.hueSectors).toBe(7);
    expect(frame.distinctColours).toBe(21); // 7 hues, the olive, the magenta and the 12 extras
    expect(frame.colourBudget).toBe(16);
    expect(frame.offPaletteQ).toBeGreaterThan(400);
    expect(frame.baseQ).toBe(300);
    expect(codes(frame.issues)).toEqual([
      'colour-budget-exceeded',
      'hue-sprawl',
      'invented-colours',
      'muddy-mix',
      'off-palette',
    ]);
    expect(frame.adjustment).toBe(-450);
    expect(frame.scoreQ).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 7 · The report surface: degeneracy, partial alpha, `unmeasured`
 * ------------------------------------------------------------------ */

describe('the degenerate inputs, and the one field AD-4 requires', () => {
  it('reports nothing opaque as nothing to be disciplined about, and does not score it 0', () => {
    // §3.6: an analyzer returns a `scoreQ` for every context, and a dimension with nothing to
    // measure says so in its verdict rather than returning 0 — which is indistinguishable from
    // "measured, and it is bad". The aggregator's `empty-frame` at severity 1.00 is what fails a
    // blank canvas, and it fails it for being *no* artwork rather than for scoring badly.
    const dimension = paletteAnalyzer(createQualityContext(spriteOf(new Grid(4, 4), BASE_PALETTE)));
    expect(dimension.scoreQ).toBe(1000);
    expect(dimension.issues).toEqual([]);
    expect(dimension.verdict).toMatch(/nothing opaque to measure/);
  });

  it('keeps a blank frame out of the minimum, so a sheet with one hole is not scored on it', () => {
    // Two frames: frame 0 is blank, frame 1 is inked. If the blank frame were allowed to win the
    // `min` at its own 1000 the sheet would be fine; the interesting half is the other direction,
    // which is the next test. Here the assertion is that a blank frame is **skipped** rather than
    // counted, and the frame record says so in `measured` rather than hiding it in a score.
    const sprite = twoFrameSprite(
      () => {
        /* frame 0 is left blank */
      },
      (grid) => grid.rect(2, 2, 12, 12, SKIN),
    );
    const frames = measurePalette(createQualityContext(sprite));
    expect(frames[0].measured).toBe(false);
    expect(frames[0].N).toBe(0);
    expect(frames[1].measured).toBe(true);
    expect(frames[1].N).toBe(144);
    expect(paletteAnalyzer(createQualityContext(sprite)).scoreQ).toBe(1000);
  });

  it('takes the worst frame, so one drifting frame out of two is the one that is reported', () => {
    // §4.3 has no per-frame table of its own, so it uses the rule `silhouette` established and
    // `noise` followed: one `scoreQ` for the dimension, because the contract has no way to say
    // "five of these are fine". **Both frames' own scores are asserted**, so the minimum is visible
    // as a choice rather than as a total.
    const sprite = twoFrameSprite(
      (grid) => grid.rect(2, 2, 12, 12, SKIN),
      (grid) => {
        grid.rect(2, 2, 6, 12, SKIN);
        grid.rect(8, 2, 6, 12, UNDECLARED.magenta);
      },
    );
    const frames = measurePalette(createQualityContext(sprite));
    expect(frames[0].scoreQ).toBe(1000);
    expect(frames[1].scoreQ).toBe(200);
    const dimension = paletteAnalyzer(createQualityContext(sprite));
    expect(dimension.scoreQ).toBe(200);
    expect(dimension.verdict).toMatch(/^worst of 2 frames \(frame 1\): /);
  });

  it('counts partial-alpha pixels, names them in the verdict, and scores none of them', () => {
    // §3.1: pixels at `1 <= alpha < ALPHA_SOLID` are named in the verdict text of whichever
    // dimension looked at them. They are never in `N`, and that is what makes a 0.25-alpha glow a
    // design decision rather than a body part — and it is also §7 item 3's false positive stated from
    // inside the dimension that has it: a translucent layer is where an off-palette composite comes
    // from, and the sentence says so without excusing the pixels that scored.
    const grid = solid(SKIN, 20, 18, 2);
    const sprite = spriteOf(grid, BASE_PALETTE, { y: 12, alpha: 64 });
    const frame = measurePalette(createQualityContext(sprite))[0];
    expect(frame.N).toBe(340);
    expect(frame.partialAlpha).toBe(20);
    const dimension = paletteAnalyzer(createQualityContext(spriteOf(grid, BASE_PALETTE, { y: 12, alpha: 64 })));
    expect(dimension.verdict).toMatch(/20 px below ALPHA_SOLID/);
    expect(dimension.scoreQ).toBe(1000);
    // Exactly at the boundary: `ALPHA_SOLID` counts as solid and one below it does not, so the
    // classification has an edge rather than being "the dimmer pixels".
    expect(measurePalette(createQualityContext(spriteOf(grid, BASE_PALETTE, { y: 12, alpha: ALPHA_SOLID - 1 })))[0].partialAlpha).toBe(20);
    expect(measurePalette(createQualityContext(spriteOf(grid, BASE_PALETTE, { y: 12, alpha: ALPHA_SOLID })))[0].partialAlpha).toBe(0);
  });

  it('has an empty `unmeasured` on every path, including the degenerate ones, and says why', () => {
    // AD-4: a sub-score that is silently absent is indistinguishable from one counted at its best,
    // so the field is required and a dimension that half-measures itself has to name which half. All
    // five of §4.3's conditions are total functions of (solid mask, palette, canvas area), so none of
    // them can be undefined for any input and there is nothing for the field to carry. That is an
    // assertion and not an oversight: §7 item 3's translucent-composite false positive is a
    // **measurement this dimension is required to make**, not an absence, and adding a member to the
    // closed `ExcludedReason` enum to excuse it would be §7 item 3's "loosen the threshold" by
    // another name.
    expect(paletteAnalyzer(createQualityContext(spriteOf(solid(SKIN), BASE_PALETTE))).unmeasured).toEqual({});
    expect(paletteAnalyzer(createQualityContext(spriteOf(solid(UNDECLARED.magenta), BASE_PALETTE))).unmeasured).toEqual({});
    expect(paletteAnalyzer(createQualityContext(spriteOf(new Grid(4, 4), BASE_PALETTE))).unmeasured).toEqual({});
  });

  it('never divides on the way out, so every number it publishes is an exact integer', () => {
    // §3.5: the field is `scoreQ`, a per-mille integer, and an analyzer's last act is to return the
    // number its own arithmetic produced. `Number.isInteger` on each ratio is the check that a
    // division leaked into a value the pipeline compares exactly.
    const frame = frameOf(repaint(solid(SKIN), 30, UNDECLARED.olive));
    for (const value of [frame.offPaletteQ, frame.muddyQ, frame.meanSatQ, frame.baseQ, frame.scoreQ]) {
      expect(Number.isInteger(value)).toBe(true);
    }
    expect(frame.offPaletteQ).toBeLessThanOrEqual(1000);
    expect(frame.muddyQ).toBeLessThanOrEqual(1000);
    // `meanSatQ` is per-mille **of full saturation**, so unlike the other two it is not bounded by
    // `N` — and it is still 0..1000, which is the units bug the header's item 4 is about: at
    // `rhu(satSum * 1000, N)` this field ran to 255000 and the one message that printed it as a
    // percentage said "7450%" where the truth is 29.2%.
    expect(frame.meanSatQ).toBeLessThanOrEqual(1000);
    expect(frame.meanSatQ).toBeGreaterThanOrEqual(0);
    // 370 pixels of `#e8d9a0` at `s255 79` and 30 of olive at `s255 42` is a mean `s255` of 76.2, which
    // as a per-mille of full saturation is `rhu(30490000, 400 * 255) = 299`. **At the old
    // denominator this field read 76225** — which is what the `meanSatQ` units bug looked like from
    // inside, and what the `grey-colours` message printed as "7622.5% of full".
    expect(frame.meanSatQ).toBe(299);
    expect(frame.satSum).toBe(370 * 79 + 30 * 42);
  });

  it('names the class and the budget in its verdict, because §7 item 8 is the finding', () => {
    const dimension = paletteAnalyzer(createQualityContext(spriteOf(solid(SKIN), BASE_PALETTE)));
    expect(dimension.verdict).toBe(
      '1 colours against a budget of 16 (compact class, canvas area 24x24), every colour declared, 1 hue family.',
    );
  });

  it('is deterministic, because §3.2 forbids anything whose order can reach output', () => {
    const context = createQualityContext(spriteOf(repaint(solid(SKIN), 30, UNDECLARED.olive)));
    expect(JSON.stringify(paletteAnalyzer(context))).toBe(JSON.stringify(paletteAnalyzer(context)));
  });

  it('reads only the composite and never writes, which is the read-only contract', () => {
    // Not a runtime assertion — the contract is in the types, where `QualityCel` has no `setColor`,
    // so an analyzer reaching for one does not compile. What *is* checkable here is the weaker
    // thing: the composite is byte-identical before and after the analyzer has run.
    const context = createQualityContext(spriteOf(repaint(solid(SKIN), 30, UNDECLARED.olive)));
    const before = Array.from(context.composite[0].data);
    paletteAnalyzer(context);
    expect(Array.from(context.composite[0].data)).toEqual(before);
  });
});

/* ------------------------------------------------------------------ *
 * 8 · The overlap with `noise`
 * ------------------------------------------------------------------ */

describe('palette and noise do not measure the same thing', () => {
  it('leaves two near-duplicate declared swatches at 1000, which is `noise`\'s question and not this one', () => {
    // `defect/near-duplicate-ramp-16` in the corpus is exactly this drawing: two **declared** swatches
    // a few channel steps apart, each over 8 pixels. §4.4's `nearDuplicatePairs` asks whether two
    // colours **the sprite used** are the same colour; §4.3's asks whether a colour is in the
    // **declared palette** and how far it is from one. On this shape the first fires and the second
    // is silent, which is the evidence that the two are not one measurement twice.
    const swatches = [...BASE_PALETTE, '#5a5a53'];
    const frame = frameOf(repaint(solid(SKIN), 200, '#5a5a53'), swatches);
    expect(frame.offPalette).toBe(0);
    expect(frame.maxNearestDistance).toBe(0);
    expect(frame.distinctColours).toBe(2);
    expect(codes(frame.issues)).toEqual([]);
    expect(frame.scoreQ).toBe(1000);
    // And the arithmetic that makes them genuinely different rather than differently scaled:
    // Chebyshev 8 out of 255 for §4.4 against a redmean of 12000 out of roughly half a million for
    // §4.3. A colour three steps from a swatch is 3 to `noise` and 0 to `palette`.
    const swatch = { r: 0x5a, g: 0x5a, b: 0x5a, a: 255 };
    const drifted = { r: 0x5d, g: 0x5d, b: 0x57, a: 255 };
    const chebyshev = Math.max(
      Math.abs(swatch.r - drifted.r),
      Math.abs(swatch.g - drifted.g),
      Math.abs(swatch.b - drifted.b),
    );
    expect(chebyshev).toBe(3);
    expect(chebyshev).toBeLessThanOrEqual(8);
    expect(colorDistanceWeighted(swatch, drifted)).toBeLessThan(12000);
  });

  it('reports the converse on a sprite with no declared swatches at all, which is `palette`\'s question', () => {
    // `app/icon.png` is the corpus's own logo and the only committed asset this dimension scores 0
    // on: it is a 1024² PNG imported against a 16-entry palette, so every one of its 878,544 solid
    // pixels is off-palette and its worst colour is 16,631 from every swatch. §4.4 also fires there —
    // with 7,842 near-duplicate pairs, the known false positive T-015 measured — but the two codes say
    // different things: one is "none of these were declared" and the other is "some of these are
    // nearly the same", and only the first is true of a smooth gradient that was never claimed to be
    // on a palette.
    const frame = frameOf(repaint(solid(SKIN), 400, UNDECLARED.magenta), ['#3a2f2a']);
    expect(frame.offPaletteQ).toBe(1000);
    expect(frame.baseQ).toBe(300);
    expect(frame.maxNearestDistance).toBeGreaterThan(12000);
    expect(severityOf(frame.issues, 'off-palette')).toBe(0.55);
    expect(codes(frame.issues)).toEqual(['invented-colours', 'off-palette']);
    expect(frame.scoreQ).toBe(200);
  });
});

/* ------------------------------------------------------------------ *
 * A two-frame sprite, for the worst-frame rules
 * ------------------------------------------------------------------ */

/** A 16x16 two-frame sprite: frame 0 is painted by `first`, frame 1 by `second`. */
function twoFrameSprite(first: (grid: Grid) => void, second: (grid: Grid) => void): Sprite {
  const sprite = createSprite({
    width: 16,
    height: 16,
    name: 'palette-two-frame',
    frames: 2,
    layers: ['Base'],
    palette: createPalette('fixture', [...BASE_PALETTE]),
  });
  const layer = sprite.layers[0].id;
  const cels = [new PixelBuffer(16, 16), new PixelBuffer(16, 16)];
  const grids = [new Grid(16, 16), new Grid(16, 16)];
  first(grids[0]);
  second(grids[1]);
  for (let f = 0; f < 2; f++) {
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const hex = grids[f].cells[y][x];
        if (hex === null) continue;
        const rgb = hexToRgb(hex);
        const i = cels[f].index(x, y);
        cels[f].data[i] = rgb[0];
        cels[f].data[i + 1] = rgb[1];
        cels[f].data[i + 2] = rgb[2];
        cels[f].data[i + 3] = 255;
      }
    }
    sprite.frames[f].cels.set(layer, cels[f]);
  }
  return sprite;
}