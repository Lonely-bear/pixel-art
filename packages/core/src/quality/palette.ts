import { colorDistanceWeighted } from '../palette.js';
import type { Color } from '../types.js';
import { buildSolidMask } from './silhouette.js';
import { rhu } from './measure.js';
import type {
  ExcludedReason,
  QualityAnalyzer,
  QualityCel,
  QualityContext,
  QualityDimension,
  QualityIssue,
  QualityPalette,
} from './types.js';

/**
 * §4.3 — `palette`: is the colour disciplined?
 *
 * ## What this dimension is, in one line
 *
 * A game asset sits on a shared palette so the game can tint, swap and batch it, and because
 * palette-swap shaders, indexed-colour formats and batched draw calls all break on a colour
 * nobody declared. Discipline here is a **technical contract**, not an aesthetic preference, and
 * that is the whole reason it is worth 140 of the report.
 *
 * ## The shape of the measurement
 *
 * ```
 * N                   solid pixels (§3.3)
 * distinctColours     distinct packed RGBA values among solid pixels
 * offPalette          solid pixels whose colour is not an EXACT palette entry
 * offPaletteRatio     offPalette / N                                  <- the primary ratio
 * maxNearestDistance  max colorDistanceWeighted(pixel, nearest swatch), over solid pixels
 * hueSectors          distinct 30-degree hue sectors, ignoring colours with s255 < 12
 * muddy               off-palette pixels with s255 <= 76 and 64 <= v255 <= 204
 * muddyRatio          muddy / N
 * meanSat             mean s255 over solid pixels, / 255
 * class               from canvas area S: small / compact / medium / large / scene
 * ```
 *
 * One band table, keyed on `offPaletteRatio`, plus five adjustments that each fire at most once
 * and each emit their own code. `off-palette` has **no** adjustment row on purpose: its ratio
 * *is* the primary band, so it fires directly from the band and the score moves through the band
 * rather than twice.
 *
 * ## The three known costs, stated here rather than argued away
 *
 * **1. The composite (§7 item 3). This dimension reads `context.composite` and nothing else**,
 * because §3.1 says every pixel measurement in this document reads that. So a translucent
 * highlight layer composites two declared swatches into a colour that is in no palette, and a
 * sprite with a perfectly disciplined palette is reported `off-palette` and lands near 0.32.
 * That is a known false positive and **this file does not soften it**: the mitigations are
 * upstream (`paletteLocked: true` with opaque layers, or `quantize_to_palette` before
 * evaluating), and loosening the threshold lets real drift through. What the analyzer can do
 * honestly is *name* it, which is what §3.1 asks of the dimension that looked at partial-alpha
 * pixels, and what {@link PaletteFrame.partialAlpha} is carried for.
 *
 * **2. Colour budgets by canvas area (§7 item 2, §7 item 8).** A 512² landscape and a 32×32 prop
 * are not the same asset class, and one budget table cannot serve both. Measured across this
 * repository's corpus: `artwork/verify/lantern-keeper.pixel` — the one real character sprite,
 * 19 colours on a 19-entry DawnBringer palette, a *declared* ramp used exactly as declared —
 * exceeds the `compact` budget of 16 by three. Ten scenes at 256² and 512² are `scene`-class and
 * exempt from `hue-sprawl` on area alone. Per-asset-class weight profiles are the obvious fix and
 * they are not built. **Every verdict this analyzer emits names the class it measured**, so a
 * reader is told which budget applied rather than left to work it out.
 *
 * **3. `meanSat`'s integer test (§3.7 has it wrong, and this file implements §4.3).** §4.3
 * defines `meanSat` as "mean s255 over solid pixels, **divided by 255****" and gates it at `< 15/100`, which
 * is "mean saturation below 15% of full". §3.7's transcription of that gate is
 * `sumS255 * 100 < 15 * N` — the `/ 255` is missing, so the test asks for mean `s255 < 0.15` and
 * the gate is unreachable by anything that has a hue at all. This file implements §4.3's
 * definition, `sumS255 * 100 < 15 * 255 * N`, because §3.7 is explicitly the transcription layer
 * and §4.3 is the dimension's own specification, and because §3.1 says a change of measurement
 * changes the specification in the same batch. The two readings differ for
 * `0.15 <= mean s255 < 38.25`; on this repository's corpus they agree, because the
 * `hueSectors >= 3` conjunct is the binding clause and the corpus has no sprite in that band with
 * three hue families. The §3.7 row needs the same edit and is outside this task's write scope;
 * §7 records it.
 *
 * ## No applicability precondition
 *
 * §4.3 lists none, and `ExcludedReason`'s own documentation already says `palette` is unaffected by
 * a full-bleed subject. The reason is §3.6's: a full-bleed landscape is exactly the document where
 * an off-palette colour is most likely, because it was made of thousands of individual marks, each
 * of which could have picked an arbitrary hex. Abstaining there would exempt the ten committed
 * scenes — the ones with the most colours in them — from the only dimension that counts colours.
 *
 * ## `unmeasured` is empty on every path, and that is a finding
 *
 * AD-4 requires an absent sub-score to be **said**, because a sub-score that is silently absent
 * is indistinguishable from one counted at its best. All five conditions below are *total*
 * functions of (the solid mask, the document palette, the canvas area), so none of them can be
 * undefined for any input, and there is nothing for the field to carry. That is not an oversight
 * and it is asserted rather than assumed: `test/quality-palette.test.ts` pins
 * `unmeasured: {}` on the degenerate inputs too, and records why the one obvious candidate —
 * the translucent-composite false positive above — is *not* an absence but a measurement this
 * dimension is required to make. Adding a member to the closed `ExcludedReason` enum to excuse a
 * documented false positive would be the "second mechanism" AD-4 explicitly forbids, and would be
 * §7 item 3's "loosen the threshold" by another name.
 */

/* ------------------------------------------------------------------ *
 * §3.4's HSV, in integer form
 * ------------------------------------------------------------------ */

/**
 * §3.4's `maxc` / `minc` / `v255` / `s255` / `h360`, all integers.
 *
 * §3.4 writes `s255 = ((maxc - minc) * 255) / maxc` with integer division, and `h360` as "the
 * standard 6-sector hue in degrees, 0..359". The hue is floored to a whole degree so that the
 * 30-degree sector is a property of the colour rather than of a float's last bit — §3.2 rule 4
 * (nothing whose order can reach output may depend on an incidental ordering) and rule 2 (no float
 * anywhere near a threshold).
 */
export interface HueSatValue {
  readonly h360: number;
  readonly s255: number;
  readonly v255: number;
}

export function hueSatValueOf(r: number, g: number, b: number): HueSatValue {
  const maxc = r > g ? (r > b ? r : b) : g > b ? g : b;
  const minc = r < g ? (r < b ? r : b) : g < b ? g : b;
  const v255 = maxc;
  const s255 = maxc === 0 ? 0 : Math.floor(((maxc - minc) * 255) / maxc);
  let h360 = 0;
  if (maxc !== minc) {
    const d = maxc - minc;
    if (maxc === r) h360 = 60 * (((g - b) / d) % 6);
    else if (maxc === g) h360 = 60 * ((b - r) / d + 2);
    else h360 = 60 * ((r - g) / d + 4);
    if (h360 < 0) h360 += 360;
    h360 = Math.floor(h360);
  }
  return { h360, s255, v255 };
}

/** §3.4's "saturated enough to count as a hue family": `(maxc - minc) * 100 >= 12 * maxc`. */
export function countsAsHueFamily(s255: number): boolean {
  return s255 >= 12;
}

/** §4.3's hue sectors are 30 degrees wide, so there are twelve of them and no fractional edge. */
export const HUE_SECTORS = 12;

/* ------------------------------------------------------------------ *
 * §4.3's class table
 * ------------------------------------------------------------------ */

/**
 * §4.3's colour-budget class, keyed on **canvas area `S`**, not on the solid count.
 *
 * The reason is §4.3's own and it is a good one: the canvas is what the artist chose, and the
 * budget follows from the room available. It is also §7 item 2's most-disputed convention and
 * §7 item 8's proof that one weight table cannot serve four asset classes — see the file header.
 * The class is reported on every frame so a reader is told which budget applied.
 */
export type PaletteClass = 'small' | 'compact' | 'medium' | 'large' | 'scene';

/** §4.3's budget table: the largest canvas area in the class, and the budget inside it. */
const CLASS_BUDGETS: readonly (readonly [number, PaletteClass, number])[] = [
  [512, 'small', 10],
  [1024, 'compact', 16],
  [4096, 'medium', 28],
  [16384, 'large', 48],
];

/** §4.3's `class` and its budget, from `S = W * H`. Ascending bound, first match wins. */
export function paletteClassFor(area: number): { readonly cls: PaletteClass; readonly budget: number } {
  for (const [maxArea, cls, budget] of CLASS_BUDGETS) {
    if (area <= maxArea) return { cls, budget };
  }
  return { cls: 'scene', budget: 96 };
}

/* ------------------------------------------------------------------ *
 * §4.3's band table
 * ------------------------------------------------------------------ */

/**
 * §4.3's `offPaletteRatio` bands, **ascending bound, best base first**.
 *
 * The direction is load-bearing and is the same trap §4.4's band table fell into: a descending
 * `(bound, score)` list walked with a `for` loop returns the *first* match, and a ratio of 0
 * matches the loosest bound, which is why a table like that reports "worst" for "perfect". Every
 * row here is individually plausible, which is why the direction is stated rather than left to be
 * checked in review. The two `0` rows are kept separate because §4.3 specifies them separately:
 * a ratio of exactly `0` scores 1000 and a ratio of `1/1000` scores 950.
 */
const BANDS: readonly (readonly [number, number])[] = [
  [0, 1000],
  [20, 950],
  [80, 850],
  [200, 720],
  [400, 550],
];

/** The `> 40/100` row: the floor for anything past the last bound. */
const RATIO_FLOOR_Q = 300;

/** §4.3's band lookup, ascending bound, first match wins. */
function baseFor(offPaletteQ: number): number {
  for (const [bound, score] of BANDS) {
    if (offPaletteQ <= bound) return score;
  }
  return RATIO_FLOOR_Q;
}

/* ------------------------------------------------------------------ *
 * §4.3's thresholds
 * ------------------------------------------------------------------ */

/** §3.7: `offPalette * 100 <= 20 * N` passes at 20/100, and `> 2/100` reports the issue. */
const OFF_PALETTE_PASS_Q = 200;

/** §3.7: `offPalette * 100 > 20 * N` is where `off-palette` becomes blocking (severity 0.55). */
const OFF_PALETTE_BLOCKING_Q = 200;

/** §3.7: `muddyCount * 100 >= 5 * N`. */
const MUDDY_MIN_Q = 50;

/** §3.7: `sumS255 * 100 < 15 * N` as §3.7 writes it — see the header's item 3 for the `* 255`. */
const MEAN_SAT_GATE = 15;

/** §4.3's `hueSectors >= 7` for `hue-sprawl`. */
const HUE_SPRAWL_MIN_SECTORS = 7;

/** §4.3's `hueSectors >= 3` conjunct for `grey-colours`. */
const GREY_COLOURS_MIN_SECTORS = 3;

/** §4.3's `maxNearestDistance > 12000` for `invented-colours`. */
const INVENTED_MAX_DISTANCE = 12000;

/** §3.4's muddy window: `s255 <= 76` and `64 <= v255 <= 204`. */
const MUDDY_MAX_S255 = 76;
const MUDDY_MIN_V255 = 64;
const MUDDY_MAX_V255 = 204;

/** §3.5's shape: the adjustment total is clamped to this window before it is added to the base. */
const ADJUSTMENT_FLOOR = -450;
const ADJUSTMENT_CEILING = 50;

/* ------------------------------------------------------------------ *
 * The frame record
 * ------------------------------------------------------------------ */

/** Everything `palette` measures on one frame. `silhouette` established this shape. */
export interface PaletteFrame {
  readonly index: number;
  /** False when the frame holds nothing opaque. Such a frame says so and is not the worst. */
  readonly measured: boolean;
  /** §3.3's `N` on this frame. */
  readonly N: number;
  /** Pixels at `1 <= alpha < ALPHA_SOLID`. Counted, never scored — §3.1's naming duty. */
  readonly partialAlpha: number;
  /** §4.3's class for this canvas, and the budget that came with it. */
  readonly paletteClass: PaletteClass;
  readonly colourBudget: number;
  readonly distinctColours: number;
  /** Solid pixels whose colour is not an **exact** palette entry. */
  readonly offPalette: number;
  /** `rhu(offPalette * 1000, N)`: the primary ratio, per-mille. */
  readonly offPaletteQ: number;
  /** §4.3's `maxNearestDistance`, over solid pixels, in `colorDistanceWeighted` units. */
  readonly maxNearestDistance: number;
  readonly hueSectors: number;
  /** Off-palette pixels inside §3.4's muddy window. */
  readonly muddy: number;
  readonly muddyQ: number;
  /** `sumS255` over solid pixels, kept so §4.3's `meanSat` gate can be re-derived from it. */
  readonly satSum: number;
  /** `rhu(satSum * 1000, N)`: the mean of `s255` on the same 0..1000 scale as every other ratio. */
  readonly meanSatQ: number;
  /** The band the primary ratio landed in, before any adjustment. */
  readonly baseQ: number;
  /** The sum of the adjustments that fired, after §3.5's clamp. */
  readonly adjustment: number;
  readonly scoreQ: number;
  readonly issues: readonly QualityIssue[];
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

/**
 * Per-mille to a one-decimal percentage string, for issue text only.
 *
 * `String(157 / 10)` is `"15.7"` on every engine, so this is display arithmetic and not one of
 * §3.2's forbidden divisions: nothing here is compared against anything. Kept as one function so
 * the six messages cannot each round a percentage their own way and make two of them disagree.
 */
function percentText(perMille: number): string {
  return String(perMille / 10);
}

/** `(r, g, b, a)` packed, as `packColor` in `../color.ts` packs it. Built here so this file's own
 *  palette membership test is one expression rather than a second packing convention. */
function packRgba(r: number, g: number, b: number, a: number): number {
  return (((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | (a & 255)) >>> 0;
}

/** The document palette as a packed set, plus the swatches themselves for the nearest-colour scan. */
function paletteIndex(palette: QualityPalette): {
  readonly packed: Set<number>;
  readonly swatches: readonly Color[];
} {
  return {
    packed: new Set(palette.colors.map((c) => packRgba(c.r, c.g, c.b, c.a))),
    swatches: palette.colors,
  };
}

function measureFrame(context: QualityContext, index: number): PaletteFrame {
  const { width, height } = context;
  const cel: QualityCel = context.composite[index];
  const { mask: solidMask, solid: N, partialAlpha } = buildSolidMask(cel, width, height);
  const { cls, budget } = paletteClassFor(width * height);

  if (N === 0) {
    return {
      index,
      measured: false,
      N: 0,
      partialAlpha,
      paletteClass: cls,
      colourBudget: budget,
      distinctColours: 0,
      offPalette: 0,
      offPaletteQ: 0,
      maxNearestDistance: 0,
      hueSectors: 0,
      muddy: 0,
      muddyQ: 0,
      satSum: 0,
      meanSatQ: 0,
      baseQ: 1000,
      adjustment: 0,
      scoreQ: 1000,
      issues: [],
    };
  }

  const { packed, swatches } = paletteIndex(context.palette);

  const distinct = new Set<number>();
  const sectors = new Set<number>();
  let offPalette = 0;
  let muddy = 0;
  let satSum = 0;
  let maxNearest = 0;
  // One mutable record, reused for the nearest-colour scan. `colorDistanceWeighted` is pure and
  // retains nothing, so this is a scratch object rather than a per-pixel allocation — which at
  // `app/icon.png`'s 878,544 solid pixels would be 878,544 objects per frame for no reason.
  const scratch: Color = { r: 0, g: 0, b: 0, a: 255 };

  for (let p = 0; p < width * height; p++) {
    if (solidMask[p] !== 1) continue;
    const i = p * 4;
    const r = cel.data[i];
    const g = cel.data[i + 1];
    const b = cel.data[i + 2];
    const a = cel.data[i + 3];
    distinct.add(packRgba(r, g, b, a));

    const { h360, s255, v255 } = hueSatValueOf(r, g, b);
    satSum += s255;
    // §4.3: "distinct 30-degree hue sectors, ignoring colours with s255 < 12". The sector index is
    // the floored degree over 30, so it is 0..11 and never 12 — a hue of exactly 360 floors to 0
    // and lands in the same sector as hue 0, which is correct because they are the same colour.
    if (countsAsHueFamily(s255)) sectors.add(Math.floor(h360 / 30));

    // `maxNearestDistance` is a max over **solid** pixels, so a declared swatch contributes 0 and
    // only an undeclared colour can move it. Computing it for every pixel anyway is one code path
    // rather than two that could disagree.
    scratch.r = r;
    scratch.g = g;
    scratch.b = b;
    scratch.a = a;
    let nearest = Number.POSITIVE_INFINITY;
    for (const swatch of swatches) {
      const d = colorDistanceWeighted(swatch, scratch);
      if (d < nearest) nearest = d;
    }
    if (nearest > maxNearest) maxNearest = nearest;

    if (!packed.has(packRgba(r, g, b, a))) {
      offPalette++;
      if (s255 <= MUDDY_MAX_S255 && v255 >= MUDDY_MIN_V255 && v255 <= MUDDY_MAX_V255) muddy++;
    }
  }

  const offPaletteQ = rhu(offPalette * 1000, N);
  const muddyQ = rhu(muddy * 1000, N);
  const meanSatQ = rhu(satSum * 1000, N);
  const distinctColours = distinct.size;
  const hueSectors = sectors.size;

  const baseQ = baseFor(offPaletteQ);

  /* --- the five adjustments, each firing at most once --- */
  const issues: QualityIssue[] = [];
  let adjustment = 0;

  // `off-palette` fires from the band, not from an adjustment row, so the score moves through the
  // base rather than twice. §4.3 says so and the reason is visible above: its ratio IS the primary
  // band, so a separate row would count the same fact twice — and this file's band table is the
  // one place that would have to know about it.
  if (offPaletteQ > OFF_PALETTE_PASS_Q) {
    const blocking = offPaletteQ > OFF_PALETTE_BLOCKING_Q;
    issues.push({
      code: 'off-palette',
      message: blocking
        ? `${offPalette} of ${N} solid pixels are a colour that is not in the document palette (${percentText(offPaletteQ)}% of the surface). Above 20% this is not a snapping miss: either the colours were invented, or a translucent layer is compositing two declared swatches into something new. \`paletteLocked: true\` with opaque layers, or one \`quantize_to_palette\`, is the fix.`
        : `${offPalette} of ${N} solid pixels are a colour that is not in the document palette. A colour one step off a swatch is a snapping miss and \`quantize_to_palette\` fixes it in one call.`,
      rect: null,
      severity: blocking ? 0.55 : 0.35,
    });
  }

  if (distinctColours > budget) {
    adjustment -= 200;
    issues.push({
      code: 'colour-budget-exceeded',
      message: `${distinctColours} distinct colours against a budget of ${budget} for a ${context.width}x${context.height} canvas (${cls} class). ${paletteClassNote(cls)}`,
      rect: null,
      severity: 0.35,
    });
  }

  // `hue-sprawl` is the one row §4.3 exempts by class, and the exemption is load-bearing: a 256²
  // landscape with ten hue families is a sunset, while the same ten on a 32×32 prop is a decision
  // nobody made. The class is the *only* discriminator, and §7 item 8 says that is not enough.
  if (hueSectors >= HUE_SPRAWL_MIN_SECTORS && cls !== 'scene') {
    adjustment -= 100;
    issues.push({
      code: 'hue-sprawl',
      message: `${hueSectors} distinct hue families (30-degree sectors) on a ${context.width}x${context.height} canvas, which the ${cls} budget assumes is not a scene. Scene-class canvases are exempt from this row; this one is not, and that is a property of its size rather than of its colour.`,
      rect: null,
      severity: 0.3,
    });
  }

  if (muddyQ >= MUDDY_MIN_Q) {
    adjustment -= 100;
    issues.push({
      code: 'muddy-mix',
      message: `${muddy} of ${N} solid pixels are off-palette *and* inside the muddy window (saturation <= ${MUDDY_MAX_S255}/255 at a mid value): ${percentText(muddyQ)}% of the surface. A muddy mix is the signature of an agent that stopped choosing colours and started averaging them.`,
      rect: null,
      severity: 0.35,
    });
  }

  // §3.7's transcription is `sumS255 * 100 < 15 * N`; §4.3 defines `meanSat` as a fraction of 255
  // and so the gate is `mean s255 < 38.25`. See the file header's item 3 — this is the reading §4.3
  // specifies and the one that can fire.
  if (satSum * 100 < MEAN_SAT_GATE * 255 * N && hueSectors >= GREY_COLOURS_MIN_SECTORS) {
    adjustment -= 100;
    issues.push({
      code: 'grey-colours',
      message: `mean saturation is ${percentText(meanSatQ)}% of full across ${N} pixels while ${hueSectors} hue families are in play: the hues are present and washed out rather than chosen.`,
      rect: null,
      severity: 0.3,
    });
  }

  if (maxNearest > INVENTED_MAX_DISTANCE) {
    adjustment -= 100;
    issues.push({
      code: 'invented-colours',
      message: `the furthest colour in the sprite is ${maxNearest} away (weighted distance) from every swatch in the palette. A colour a step or two off a ramp entry is a snapping miss; one this far out was not picked from the ramp at all, and the fix is a decision rather than a command.`,
      rect: null,
      severity: 0.4,
    });
  }

  const clamped = Math.max(ADJUSTMENT_FLOOR, Math.min(ADJUSTMENT_CEILING, adjustment));
  const scoreQ = Math.max(0, Math.min(1000, baseQ + clamped));

  return {
    index,
    measured: true,
    N,
    partialAlpha,
    paletteClass: cls,
    colourBudget: budget,
    distinctColours,
    offPalette,
    offPaletteQ,
    maxNearestDistance: maxNearest,
    hueSectors,
    muddy,
    muddyQ,
    satSum,
    meanSatQ,
    baseQ,
    adjustment: clamped,
    scoreQ,
    issues,
  };
}

/** The budget sentence every `colour-budget-exceeded` carries, because §7 item 8 is the finding. */
function paletteClassNote(cls: PaletteClass): string {
  if (cls === 'scene') {
    return 'Scene-class canvases get a budget of 96 by area alone, so a large painting can still exceed it — and §7 item 8 records that one budget table cannot serve an icon, a tile and a landscape at once.';
  }
  return 'Budgets are keyed on canvas area rather than on asset class, which is §7 item 8\'s standing gap: per-asset-class profiles are the obvious fix and they are not built.';
}

/** `palette` over every frame, in playback order. */
export function measurePalette(context: QualityContext): PaletteFrame[] {
  const out: PaletteFrame[] = [];
  for (let i = 0; i < context.composite.length; i++) out.push(measureFrame(context, i));
  return out;
}

/**
 * `palette` — does the sprite use the colours the document declared, and a sane number of them?
 *
 * ## Worst frame wins
 *
 * For `silhouette`'s reason and `noise`'s: `QualityDimension` has one `scoreQ` and no way to say
 * "five of these are fine". A walk cycle whose frame 4 drifted off the ramp drifted off the ramp
 * in motion, which is where the game sees it.
 *
 * ## A frame with no ink is not the worst frame
 *
 * It is skipped rather than counted as 1000, for `noise`'s reason and §4.6's: a blank frame is
 * `empty-frame`'s to report, and letting it win the minimum would hand a sheet with a blank in it
 * a perfect score for the frames that do have ink. `measureNoise` does the same thing, and the two
 * dimensions must not each invent their own handling of a degenerate input.
 */
export const paletteAnalyzer: QualityAnalyzer = (context: QualityContext): QualityDimension => {
  const frames = measurePalette(context);
  const measured = frames.filter((frame) => frame.measured);

  if (measured.length === 0) {
    return {
      scoreQ: 1000,
      verdict:
        frames.length === 0
          ? 'nothing to measure: the context carries no frames.'
          : `nothing opaque to measure on any of the ${plural(frames.length, 'frame')}; there are no colours to be disciplined about.`,
      issues: [],
      unmeasured: {},
    };
  }

  let worst = measured[0];
  for (const frame of measured) if (frame.scoreQ < worst.scoreQ) worst = frame;

  const issues = frames
    .flatMap((frame) => frame.issues)
    .sort(
      (a, b) =>
        b.severity - a.severity ||
        (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
        (a.rect?.y ?? 0) - (b.rect?.y ?? 0) ||
        (a.rect?.x ?? 0) - (b.rect?.x ?? 0),
    );

  const prefix =
    frames.length > 1 ? `worst of ${frames.length} ${plural(frames.length, 'frame')} (frame ${worst.index}): ` : '';

  const parts: string[] = [
    `${worst.distinctColours} colours against a budget of ${worst.colourBudget} (${worst.paletteClass} class, canvas area ${context.width}x${context.height})`,
  ];
  if (worst.offPalette > 0) {
    parts.push(
      `${worst.offPalette} of ${worst.N} pixels off the palette (${percentText(worst.offPaletteQ)}%)`,
    );
  } else {
    parts.push('every colour declared');
  }
  parts.push(`${worst.hueSectors} hue ${plural(worst.hueSectors, 'family')}`);
  if (worst.muddy > 0) parts.push(`${worst.muddy} muddy`);
  if (worst.maxNearestDistance > INVENTED_MAX_DISTANCE) {
    parts.push(`worst colour ${worst.maxNearestDistance} from every swatch`);
  }
  if (worst.partialAlpha > 0) {
    // §3.1: partial-alpha pixels are "named in the verdict text of whichever dimension looked at
    // them". `palette` looked. Naming them is also the honest half of §7 item 3: a translucent
    // layer is where an off-palette colour comes from, and the sentence below says so without
    // excusing the pixels that scored.
    parts.push(
      `${worst.partialAlpha} px below ALPHA_SOLID, counted but not scored — if those are a translucent layer, the off-palette pixels above are its composite rather than a mistake`,
    );
  }

  return {
    scoreQ: worst.scoreQ,
    verdict: prefix + parts.join(', ') + '.',
    issues,
    // **Empty on every path, and asserted rather than assumed.** See the header: all five of
    // §4.3's conditions are total functions of (solid mask, palette, canvas area), so none of
    // them can be undefined and there is nothing for AD-4's field to carry. `test/` pins this on
    // the degenerate inputs too, so a future sub-score cannot appear here without saying so.
    unmeasured: {} as Readonly<Record<string, ExcludedReason>>,
  };
};
