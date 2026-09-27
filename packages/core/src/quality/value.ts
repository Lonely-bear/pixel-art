import type { Rect } from '../types.js';
import { ALPHA_SOLID } from './context.js';
import {
  buildSolidMask,
  convexStaircaseCornerAt,
  distField,
  edgeGapOf,
  edgePixelAt,
  lqBucketOf,
  lqOf,
  rhu,
  SUBJECT_REQUIRED_MARGIN,
} from './measure.js';
import type {
  ExcludedReason,
  QualityAnalyzer,
  QualityCel,
  QualityContext,
  QualityDimension,
  QualityIssue,
} from './types.js';

/**
 * The `value` dimension: is the form carried by tone, and do the tone planes follow the form?
 *
 * ## What this dimension is for, and what it was
 *
 * §4.2 asks two questions. The first is the familiar one: are there enough value planes, and is
 * the form carried by lightness rather than by hue. The second is the one this dimension did not
 * used to have: **does each plane boundary follow the form it is sitting on?** A terminator that
 * runs *around* a rounded body describes a volume. The same tone step cut as a straight diagonal
 * across that body describes a flat sticker. Same number of planes, same contrast, same hue/value
 * separation. Only one of them is a lit form.
 *
 * That gap was not small. §4.2's own acceptance test — one sprite drawn twice, once with a hard
 * straight-diagonal shadow band and once with nested contours following the body — moved the
 * report total by **0.014** while fixing four of six named artistic defects, because everything
 * the dimension measured was *identical* in the two. The two figures it separates are the whole
 * point of the dimension, so they are the test in `test/quality-value.test.ts` and a contrast
 * pair in the corpus.
 *
 * ## The form term, and the two spec defects it had to get past
 *
 * §4.2 specifies the form term as **the spread of `dist` along each plane boundary**, gated on
 * local silhouette curvature, banded on the worst plane. Both halves of that were measured to be
 * wrong on real artwork before this file existed, and the numbers are in
 * `benchmarks/corpus/baseline.md` on every row:
 *
 * **1. The spread of `dist` rewards a target and punishes a sphere.** A *level set* of `dist` —
 * a true inset, the shape you get by eroding the silhouette — is a curve of constant depth, so
 * its spread is near zero and it scores as a perfect form-following plane. A *translated*
 * contour necessarily runs from the silhouette's own edge (`dist` 0) out to its deepest reach, so
 * its spread is as large as the body is deep. And a correctly shaded round body is made of
 * translated contours: `packages/cli/src/demo.ts` derives its entire tonal stack from
 * `[left, right, y]` rows walked `inset` pixels in and displaced along the light axis, and every
 * plane except the core shadow is `inset: 0`, i.e. a pure translation. Measured on that sprite:
 * the tone-edge set's `dist` spread is `0..11` against a `Dmax` of 11, so the spec's term bands it
 * at `formQ` 100 and fires `plane-crosses-form` at blocking severity — **the product's own
 * reference artwork failed for using the technique the product teaches.**
 *
 * A depth spread cannot be the term, because "parallel to the surface" is not the property a
 * sphere is built from. What *is* true of both constructions, and false of a straight cut, is
 * that the boundary **turns**. So the term here is built on the plane's own geometry, which is
 * invariant under translation by construction:
 *
 *   - `bendQ` — how much the boundary turns, from two independent readings of the same idea taken
 *     at the **weaker** of the two, so that neither can talk the term into a wrong answer. The
 *     readings are the number of distinct 8-step directions the boundary walks (1 for a straight
 *     line whatever its slope, 2 for a shallow arc, 3 or more for a corner or a ring) and the pixel
 *     surplus over its bounding box (0 for a chord, 570 per-mille for a 90° arc, 1000 for a ring).
 *     Either alone is wrong in a way that lands on real artwork — a rasterised 45° staircase drawn
 *     two pixels wide is a solid staircase, and a one-pixel *boundary* of a gentle arc is locally
 *     straight — and both are translation-invariant by construction, which is the property a depth
 *     spread is not. A level set and a translated contour read alike, and that is the point: the
 *     ladder saturates at three orientations rather than four so that an arc and the ring around it
 *     are the same reading, because an open boundary on a convex body structurally cannot use the
 *     fourth orientation without closing. See `describeTerminator` for the measurement that
 *     required the third orientation to be the saturation point.
 *   - `splitQ` — how evenly the plane divides the body it sits on, `min(area) / max(area)` of
 *     the two tone regions it separates. This is the clause that makes the term survive real
 *     artwork. A *crescent* has one thin side; a straight cut has two fat ones. A level set and
 *     a translated contour both produce crescents; a diagonal band does not. It is also what
 *     stops a locally straight fragment of a curved boundary from being read as a cut — the
 *     tangent piece of a translated contour is geometrically a straight run, and no local
 *     measurement can tell it from one.
 *   - `curvedQ` — the corrected `convexCorner` density near the plane, keeping §4.2's gate: a
 *     straight plane across a straight-edged form is correct and must not be failed.
 *
 * `crossesQ = curvedQ >= 250 && reachQ >= 500 ? rhu((1000 - bendQ) * splitQ, 1000) : 0`, and
 * `formQ` is banded on the **worst** plane, per §4.2's deliberate minimum rather than a mean. The
 * measured separation on the acceptance pair is in the report; the old term's was 0.014 on the
 * total.
 *
 * **`spanQ` is still computed, still recorded, and deliberately not scored.** It is the single
 * most informative number in the record — it is what a person needs to see to understand the
 * artwork — and it is also the standing evidence that the level-set bias is real, because the
 * generated report prints it beside the score on every case including the ones that are correct.
 *
 * ## `planes` was always 1, and that was the merged ring
 *
 * §4.2 builds planes from "the 8-connected components of `{ p : toneEdge(p) }`". On `pixel demo`
 * that set is **386 of 491 solid pixels in a single component** — so `planes` is 1 on every
 * version, and the form term was measuring a ring that contains every boundary in the sprite at
 * once, which is why its `dist` spread was necessarily `0..Dmax`. Two things fuse it, and both
 * are here:
 *
 *   - **A 1px contour is not a plane.** At 32x32 with a five-step ramp, almost every pixel has a
 *     differently-toned 4-neighbour, so a *two-sided* `toneEdge` set swallows the artwork. The
 *     rule here is that a tone region must be an **area**: at least one of its pixels has three
 *     or more solid 4-neighbours in the same bucket. A traced contour, a rim light, a 1px
 *     highlight, a mouth and a dither speck all fail it; every value plane passes it. This is
 *     the same artefact `TASKS.md` records against the retired `colourOrphans` and against
 *     `inkGaps` — "23 of 29 counts were the 45° staircase corners of the contour itself".
 *   - **A boundary is keyed by the pair of regions it separates.** Two boundaries one pixel apart
 *     are 4-adjacent whichever side you canonicalise to, so the pixels are grouped per region
 *     pair before the flood fill. Grouping by pair is not an invention: §3.3's own `ditherMask`
 *     is defined over "the 15 bucket pairs `(k, k+1)`", so a bucket pair is already the
 *     specification's unit for "a seam between two tone steps".
 *
 * On `pixel demo` this takes 386 pixels in one merged ring to **5 planes**, and the same on the
 * repository's only real character sprite.
 *
 * ## The dither exclusion is not implemented here, and its failure direction is safe
 *
 * §4.2 excludes every `toneEdge` pixel inside a detected dither region before planes are built,
 * because a dithered seam's `dist` spread is enormous and would read as a straight cut. §3.3's
 * `ditherMask` is a substantial predicate and `noise` (T-015) is its declared consumer, so
 * implementing it here would put a second home in the repository for the same reason the header
 * of `measure.ts` exists. The "a tone region must be an area" rule covers the common case anyway:
 * a 1px Bayer field and a `cluster2` pattern have no pixel with three same-bucket 4-neighbours,
 * so they are not planes and the seams against them are not planes' business. A coarse `cluster4`
 * field *is* an area, and a coarse dithered seam is a staircase field, so its `bendQ` is high and
 * the term excuses it. Every remaining path through the dither question is a false negative, which
 * is the direction this dimension has to fail in: a missed dither seam is one advisory not
 * emitted, and a dither seam wrongly reported is a working artist told their transition is
 * broken.
 */

/** §4.2: "the pixels within Chebyshev distance 3 of P". */
const NEAR_RADIUS = 3;
/** §4.2: "components of fewer than 4 pixels are discarded — a 2px step is a dither artefact". */
const MIN_TERMINATOR = 4;
/** §4.2's curvature gate, `curvedQ >= 250`, unchanged from the `cornerQ` this replaced. */
const CURVATURE_GATE = 250;
/**
 * The number of distinct half-plane orientations at which `dirQ` reads as fully bent.
 *
 * Four exist, and the ladder stops at three because an open boundary on a convex body cannot use
 * the fourth without closing — right, down, left, up is a loop. Three orientations is where a
 * boundary has stopped being a line and started tracking something, and a fourth is the same
 * evidence with the ends joined rather than more of it. The measurement that forced the choice is
 * in `describeTerminator`: normalising by four ranked `demo.ts`'s own translated contours
 * (`formQ` 750) below a level-set ring's (1000) on the same body with the same five tones and no
 * defect on either side.
 *
 * The ladder is `0 / 500 / 1000` over one / two / three orientations, so the denominator is
 * `DIR_SATURATION - 1` and the numerator is clamped here rather than by the arithmetic: `rhu` is a
 * bare ratio and the old denominator of 3 only ever landed on 1000 because 4 was the maximum.
 */
const DIR_SATURATION = 3;
/**
 * A plane must reach at least this fraction of the subject's long side to be a cross-section.
 *
 * **The reason this exists is a measured false positive, and the measurement is in the report.**
 * `pixel demo` shades with 1px and 2px crescents, and the *ends* of a thin crescent are short
 * straight runs where the plane dies out at the silhouette: five pixels down the right flank, nine
 * along the bottom. A form term that judges those as plane boundaries reads the product's own
 * reference artwork as a flat sticker, and reads it as a **blocking** one. A boundary that reaches
 * less than half the body's long side cannot be a cross-section of the body whatever shape it is,
 * so it is not a plane the form term has an opinion about. §4.2's own floor is 4 pixels, which is
 * a floor on *existence*; this is a floor on *consequence*, and the two are not the same question.
 */
const REACH_GATE = 500;
/** §3.5 step 4: an adjustment total outside this band stops being legible. */
const ADJUSTMENT_MIN = -450;
const ADJUSTMENT_MAX = 50;
/** §4.2: a `keyLight` sample region needs "at least 8 solid pixels and an eighth of its area". */
const KEY_LIGHT_MIN_PIXELS = 8;
/** §4.2: `internalEdges < 8` is not enough interior for an edge ratio. */
const MIN_INTERNAL_EDGES = 8;

/** §4.2's `toneQ` band table, keyed on the number of distinct `LqBucket`s, read top down. */
const TONE_BANDS: readonly (readonly [number, number])[] = [
  [5, 900],
  [4, 780],
  [3, 620],
  [2, 400],
];

/** §4.2: "`buckets <= 1`". One bucket is the floor, not a band of its own. */
const TONE_FLOOR = 150;

/**
 * §4.2's `formQ` band table, keyed on the worst plane's badness, read top down.
 *
 * Badness is `crossesQ` and **higher is worse**, the opposite direction from `scoreQ`; the last
 * column is the `plane-crosses-form` severity that fires with the band, or `null`.
 */
const FORM_BANDS: readonly (readonly [number, number, number | null])[] = [
  [150, 1000, null],
  [300, 900, null],
  [450, 750, null],
  [600, 550, null],
  [750, 350, 0.3],
  [1000, 100, 0.6],
];

/** One tone region: a maximal 4-connected run of solid pixels in a single `LqBucket`. */
interface ToneRegion {
  /** Index into the region list, and the value this frame's `regionId` field carries. */
  readonly id: number;
  readonly bucket: number;
  readonly area: number;
  /** The largest number of solid same-bucket 4-neighbours any one of its pixels has. */
  readonly thickness: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** One plane boundary: a connected piece of the contact between two tone regions. */
export interface Terminator {
  /** Lower-bucket side's pixels, row-major. Length is the plane's extent. */
  readonly pixels: readonly number[];
  /** The two region ids, lower first. */
  readonly regions: readonly [number, number];
  readonly rect: Rect;
  /** How many distinct 8-step directions the boundary walks, as a fraction of all three. */
  readonly bendQ: number;
  /** `rhu(min(areaA, areaB) * 1000, max(areaA, areaB))`. */
  readonly splitQ: number;
  /** The plane's long side over the subject's long side, in per-mille. */
  readonly reachQ: number;
  /** `rhu(stairCorners * 1000, edgeN + 1)` over the Chebyshev-3 neighbourhood. */
  readonly curvedQ: number;
  /** The badness this plane contributes: higher is worse, 0 means "this plane follows the form". */
  readonly crossesQ: number;
  /**
   * Why this plane was not judged, or `null` when it was.
   *
   * `crossesQ` is 0 both for a plane that follows the form and for one that was never asked, so
   * the number alone cannot tell a clean sprite from a blind one. That ambiguity is why §4.2 read
   * 1000 on all twelve real artworks in the corpus: every one of their planes was gated, every one
   * of them scored 0, and nothing recorded that the 0 meant "not asked" rather than "no defect".
   * The gate is kept per plane so the difference survives into the measurement record instead of
   * having to be re-derived from a throwaway probe.
   */
  readonly gate: 'curvature' | 'reach' | null;
  /** `min` and `max` of `dist` over the plane, and the depth spread in per-mille of `Dmax + 1`. */
  readonly d0: number;
  readonly d1: number;
  readonly spanQ: number;
}

/**
 * Everything one frame produced, including the score and the issues.
 *
 * A measurement record rather than a private one, for `silhouette`'s reason: this dimension is
 * the pipeline's calibration instrument, and a dimension whose internals cannot be read is a
 * dimension that can only be argued about. The corpus report prints `spanQ` and `Dmax` from here
 * on every row precisely so the level-set bias stays visible in a committed file.
 */
export interface ValueFrame {
  readonly index: number;
  /** False when the frame holds nothing opaque. Such a frame scores 1000 and says so. */
  readonly measured: boolean;
  readonly N: number;
  readonly partialAlpha: number;
  /** §3.4's `LqBucket`s present among solid pixels, ascending. */
  readonly buckets: readonly number[];
  /** `buckets.length`. §4.2's band-table key. */
  readonly distinct: number;
  /** `Lq_max - Lq_min` over the solid pixels. */
  readonly range: number;
  /** `(pixels in the fullest bucket) / N` in per-mille. */
  readonly dominantShareQ: number;
  readonly lqMin: number;
  readonly lqMax: number;
  /** 4-adjacent solid-solid pixel pairs. */
  readonly internalEdges: number;
  /** Of those, pairs whose colours differ while their `LqBucket`s are equal. */
  readonly hueOnlyEdges: number;
  /** `hueOnlyEdges / internalEdges` in per-mille, or -1 when `internalEdges < 8`. */
  readonly hueOnlyQ: number;
  /** Mean `Lq` over the usable top-left region minus the usable bottom-right one, or `null`. */
  readonly keyLight: number | null;
  readonly keyLightSamples: number;
  /** `(pixels with Lq <= 12) / N` in per-mille. */
  readonly shadowShareQ: number;
  /** `(pixels with Lq >= 243) / N` in per-mille. */
  readonly highlightShareQ: number;
  /** Tone regions, and how many of them are areas rather than lines. */
  readonly regions: number;
  readonly planes: number;
  /** The connected plane boundaries, ≥ {@link MIN_TERMINATOR} pixels each. */
  readonly terminators: readonly Terminator[];
  /** The bad plane among the **judged** ones, or `null` when there is no plane to judge. */
  readonly worst: Terminator | null;
  /**
   * Planes that were not judged, and why: `curvature` when the local silhouette has no curvature
   * to compare against, `reach` when the plane is too small to be a cross-section, `null` when the
   * frame has no plane at all. This is the field that makes the *absence* of a form measurement
   * visible; {@link formQ} alone cannot, because an unmeasured term and a perfect one were both 1000.
   */
  readonly gateCounts: Readonly<Record<'curvature' | 'reach', number>>;
  /** §3.3's `Dmax` on the adopted reading: the subject's half-thickness. */
  readonly Dmax: number;
  readonly toneQ: number;
  /**
   * `null` when no plane was judgeable — see {@link gateCounts}. Not 1000, and the difference is the
   * whole point: a full-bleed scene and a sphere shaded with translated contours both report a
   * clean form term, and only one of them was looked at.
   */
  readonly formQ: number | null;
  readonly scoreQ: number;
  readonly issues: readonly QualityIssue[];
}

/** Measure every frame in the context, in playback order. */
export function measureValue(context: QualityContext): ValueFrame[] {
  const out: ValueFrame[] = [];
  for (let i = 0; i < context.composite.length; i++) out.push(measureFrame(context, i));
  return out;
}

/**
 * `value` — the second dimension in the pipeline, and the heaviest argument in it.
 *
 * Frames are combined by **worst frame wins**, the same rule and for the same reason as
 * `silhouette`: §4.2 is written per frame, `QualityDimension` has one `scoreQ` and no way to say
 * "four of these frames are fine", and a sprite that reads as a flat sticker on one frame in eight
 * reads as a flat sticker in motion.
 *
 * A frame with nothing opaque in it is *not* scored: it reports 1000 and contributes no issues.
 * `empty-frame` belongs to the aggregator at severity 1.00, and it exists precisely so a blank
 * canvas is caught by one blocking issue rather than by six dimensions each inventing a zero.
 */
export const valueAnalyzer: QualityAnalyzer = (context: QualityContext): QualityDimension => {
  const frames = measureValue(context);
  const measured = frames.filter((frame) => frame.measured);
  if (measured.length === 0) {
    return {
      scoreQ: 1000,
      verdict:
        frames.length === 0
          ? 'nothing to measure: the context carries no frames.'
          : `nothing opaque to measure on any of the ${plural(frames.length, 'frame')}; there is no tone to judge.`,
      issues: [],
      unmeasured: { form: 'no-judgeable-plane' },
    };  }
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
    frames.length > 1
      ? `worst of ${frames.length} ${plural(frames.length, 'frame')} (frame ${worst.index}): `
      : '';
  // The verdict is the sentence a person reads when they want to know what was *not* checked, so
  // the absence goes here in words as well as in the `unmeasured` map. Saying nothing would let a
  // full-bleed scene read exactly like a correctly shaded sphere.
  //
  // `'no-subject'` and `'no-judgeable-plane'` are different claims and are kept apart: the first is
  // about the document having no outline to measure against, the second about there being nothing
  // to measure at all. Unanimity matches the aggregator's rule for the same predicate — one frame
  // with an outline is enough for the dimension to have an opinion.
  const blind = measured.filter((frame) => frame.formQ === null);
  const reason: ExcludedReason | null =
    blind.length === 0 ? null : blind.length === measured.length && worst.formQ === null
      ? blind[0].N === 0
        ? 'no-judgeable-plane'
        : 'no-subject'
      : null;
  return {
    scoreQ: worst.scoreQ,
    verdict: prefix + describe(worst) + (reason === null ? '' : formBlindNote(worst, reason)),
    issues,
    unmeasured: reason === null ? {} : { form: reason },
  };
};

/**
 * Why the form term has no number, in one sentence.
 *
 * `'no-subject'` is the case a reader can act on and the reason it is worth a sentence: the subject
 * fills the canvas, so its outline is the frame, so there is no local curvature for a terminator to
 * agree or disagree with. That is a fact about the asset class rather than a defect in the
 * artwork, and it is the same fact the aggregator already reports as `no-subject` for `silhouette`
 * — which is why one of the two is that member and not a new one.
 */
function formBlindNote(frame: ValueFrame, reason: ExcludedReason): string {
  if (reason === 'no-judgeable-plane') {
    return ' No tone boundary to judge for form conformance, so that half of the dimension is unmeasured rather than clean.';
  }
  return " Form conformance is unmeasured: the subject reaches every canvas edge, so its outline is the frame and there is no local curvature for a terminator to follow. The tone half was measured.";
}

/** §4.2's whole measurement, once per frame. */
function measureFrame(context: QualityContext, index: number): ValueFrame {
  const { width, height } = context;
  const cel = context.composite[index];
  const size = width * height;
  const { mask, solid, partialAlpha } = buildSolidMask(cel, width, height);
  if (solid === 0) {
    return {
      index,
      measured: false,
      N: 0,
      partialAlpha,
      buckets: [],
      distinct: 0,
      range: 0,
      dominantShareQ: 0,
      lqMin: 0,
      lqMax: 0,
      internalEdges: 0,
      hueOnlyEdges: 0,
      hueOnlyQ: -1,
      keyLight: null,
      keyLightSamples: 0,
      shadowShareQ: 0,
      highlightShareQ: 0,
      regions: 0,
      planes: 0,
      terminators: [],
      worst: null,
      gateCounts: { curvature: 0, reach: 0 },
      Dmax: 0,
      toneQ: 1000,
      formQ: null,
      scoreQ: 1000,
      issues: [],
    };
  }
  /* --- tone statistics, one pass over the solid pixels --- */
  const bucketCount = new Int32Array(16);
  let lqMin = 255;
  let lqMax = 0;
  let shadow = 0;
  let highlight = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let p = 0; p < size; p++) {
    if (mask[p] !== 1) continue;
    const lq = lqOf(cel, p);
    bucketCount[lq >> 4]++;
    if (lq < lqMin) lqMin = lq;
    if (lq > lqMax) lqMax = lq;
    if (lq <= 12) shadow++;
    if (lq >= 243) highlight++;
    const x = p % width;
    const y = (p - x) / width;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const buckets: number[] = [];
  let bucketMax = 0;
  for (let b = 0; b < 16; b++) {
    if (bucketCount[b] === 0) continue;
    buckets.push(b);
    if (bucketCount[b] > bucketMax) bucketMax = bucketCount[b];
  }
  const distinct = buckets.length;

  /* --- internal edges, and how many of them hue is doing instead of tone --- */
  let internalEdges = 0;
  let hueOnlyEdges = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (mask[p] !== 1) continue;
      if (x + 1 < width && mask[p + 1] === 1) {
        internalEdges++;
        if (
          lqBucketOf(cel, p) === lqBucketOf(cel, p + 1) &&
          (cel.data[p * 4] !== cel.data[(p + 1) * 4] ||
            cel.data[p * 4 + 1] !== cel.data[(p + 1) * 4 + 1] ||
            cel.data[p * 4 + 2] !== cel.data[(p + 1) * 4 + 2])
        ) {
          hueOnlyEdges++;
        }
      }
      if (y + 1 < height && mask[p + width] === 1) {
        internalEdges++;
        if (
          lqBucketOf(cel, p) === lqBucketOf(cel, p + width) &&
          (cel.data[p * 4] !== cel.data[(p + width) * 4] ||
            cel.data[p * 4 + 1] !== cel.data[(p + width) * 4 + 1] ||
            cel.data[p * 4 + 2] !== cel.data[(p + width) * 4 + 2])
        ) {
          hueOnlyEdges++;
        }
      }
    }
  }
  // §4.2's own rule for a ratio whose denominator can collapse: not measured, and no adjustment.
  // A score for it would be a number about a quantity that does not exist.
  const hueOnlyQ =
    internalEdges < MIN_INTERNAL_EDGES ? -1 : rhu(hueOnlyEdges * 1000, internalEdges);

  /* --- the key light, sampled where there is something to sample --- */
  // `range == 0` is the "denominator collapsed" case §4.2 legislates for: a single flat colour has
  // no light direction, and its two sample regions necessarily have the same mean, so `keyLight`
  // is exactly 0 — which §4.2's second row reads as "the light direction is not readable" and
  // charges -100 for. Measured against the corpus, that fired on every flat fixture in it. "Not
  // measurable" is the honest answer, and it is the answer §4.2 already gives for `hueOnlyRatio`
  // under `internalEdges < 8`.
  const { keyLight, samples } =
    lqMax === lqMin
      ? { keyLight: null, samples: 0 }
      : keyLightOf(cel, mask, width, height, minX, minY, maxX, maxY);

  /* --- depth, planes, and the form term --- */
  const { dist, Dmax } = distField(mask, width, height);
  const { regions, regionId } = labelToneRegions(cel, mask, width, height);
  const planes = regions.filter((region) => region.thickness >= 3).length;
  const bodyExtent = Math.max(maxX - minX + 1, maxY - minY + 1);
  const terminators = findTerminators(cel, mask, width, height, regions, regionId, dist, Dmax, bodyExtent);
  // Worst plane, not the mean: the defect is one plane in the wrong place, and a mean is allowed
  // to hide it behind four well-formed crescents. **Among the judged planes only** — a gated plane
  // carries a `crossesQ` of 0 that means "not asked", and letting those compete for the title of
  // worst plane is how a frame where nothing was measured acquired a worst plane at all.
  const gateCounts = { curvature: 0, reach: 0 };
  let worst: Terminator | null = null;
  for (const term of terminators) {
    if (term.gate !== null) {
      gateCounts[term.gate]++;
      continue;
    }
    if (worst === null || term.crossesQ > worst.crossesQ) worst = term;
  }

  const toneQ = toneQFor(distinct);
  // **The one case where the form term has no answer at all.** §4.2's curvature gate asks whether
  // the local silhouette is round, and it reads that off the subject's own outline. A subject that
  // fills the canvas has no outline — its boundary is the frame — so there is nothing to read
  // curvature from and the gate abstains on every plane for a reason that is about the *document*
  // rather than about the artwork. Reporting 1000 there is how all twelve real artworks in the
  // corpus came out with a clean form term and not one plane judged: ten are full-bleed scenes
  // whose outline is a rectangle, and the remaining two are 32×32 and 1024² sprites whose planes
  // are fragments the `reach` gate legitimately spares.
  //
  // A subject that *does* have an outline is a different case and keeps §4.2's designed reading: a
  // rectangle's straight terminators are correct, and `formQ` 1000 says the term examined them and
  // found nothing wrong. Collapsing the two cases is what made a first attempt at this penalise
  // three clean controls from `pass` to `warn` — a defect-free rectangle told it was mediocre
  // because the scorer was half-blind, which is the distortion this whole mechanism exists to
  // prevent wearing a different hat.
  const noOutline = edgeGapOf(mask, width, height) <= SUBJECT_REQUIRED_MARGIN;
  const formQ = noOutline ? null : worst === null ? 1000 : formBandFor(worst.crossesQ).formQ;

  /* --- the score, and the issues --- */
  const issues: QualityIssue[] = [];
  let adjustment = 0;

  if (hueOnlyQ > 250) {
    adjustment -= 250;
    if (focused(context, subjectRect(minX, minY, maxX, maxY))) {
      issues.push({
        code: 'hue-carries-form',
        message: `${rhu(hueOnlyEdges * 100, internalEdges)}/100 of the interior boundaries change colour without changing lightness, so hue is doing the work tone should; separate the planes in value or the game takes them away the first time it tints this.`,
        rect: subjectRect(minX, minY, maxX, maxY),
        severity: 0.6,
      });
    }
  } else if (hueOnlyQ > 100) {
    adjustment -= 100;
    if (focused(context, subjectRect(minX, minY, maxX, maxY))) {
      issues.push({
        code: 'hue-carries-form',
        message: `${rhu(hueOnlyEdges * 100, internalEdges)}/100 of the interior boundaries change colour without changing lightness; some of the form is being carried by hue.`,
        rect: subjectRect(minX, minY, maxX, maxY),
        severity: 0.3,
      });
    }
  }

  const range = lqMax - lqMin;
  if (range < 45) {
    adjustment -= 200;
    if (focused(context, subjectRect(minX, minY, maxX, maxY))) {
      issues.push({
        code: 'narrow-value-range',
        message: `the whole sprite spans ${range} of 255 in lightness; a lit form needs steps far enough apart to survive a downscale and a tint.`,
        rect: subjectRect(minX, minY, maxX, maxY),
        severity: 0.45,
      });
    }
  }

  const dominantShareQ = rhu(bucketMax * 1000, solid);
  if (bucketMax * 100 >= 92 * solid || distinct <= 1) {
    adjustment -= 200;
    if (focused(context, subjectRect(minX, minY, maxX, maxY))) {
      issues.push({
        code: 'flat-value',
        message: `one lightness bucket holds ${dominantShareQ}/1000 of the solid pixels; the form is not being described by tone at all.`,
        rect: subjectRect(minX, minY, maxX, maxY),
        severity: 0.55,
      });
    }
  }

  if (keyLight !== null) {
    // The two rows are mutually exclusive, and §4.2 says why: "a sprite lit from the wrong side
    // is also a sprite with a low `keyLight`, and counting both would charge it twice for one
    // fact". That sentence only parses if the rows are disjoint, so the *adjustment* table is
    // normative and §4.2's issue table — which summarises the trigger as "measurable `keyLight <
    // 12`, or `keyLight <= -25`" — is read as the union of the two rows rather than as `keyLight <
    // 12`. Taking the summary literally charges a sprite whose `keyLight` is **-5**: neither row
    // fires, so the sprite is charged for something the specification does not list. Measured on
    // the committed artwork, that reading fires on 8 of 12 real assets; this one on 4.
    if (keyLight <= -25) {
      adjustment -= 100;
      if (focused(context, subjectRect(minX, minY, maxX, maxY))) {
        issues.push({
          code: 'key-light-inconsistent',
          message: `the bottom-right of the subject is ${-keyLight} lighter than its top-left, so it is lit from behind; that is a decision rather than a mistake, but it is the opposite of the key this tool teaches.`,
          rect: subjectRect(minX, minY, maxX, maxY),
          severity: 0.25,
        });
      }
    } else if (keyLight >= 0 && keyLight < 12) {
      adjustment -= 100;
      if (focused(context, subjectRect(minX, minY, maxX, maxY))) {
        issues.push({
          code: 'key-light-inconsistent',
          message: `the top-left of the subject is only ${keyLight} lighter than its bottom-right, so the light direction is not readable; this is a consistency check, not a correctness one.`,
          rect: subjectRect(minX, minY, maxX, maxY),
          severity: 0.25,
        });
      }
    }
  }

  const shadowShareQ = rhu(shadow * 1000, solid);
  if (shadow * 100 >= 30 * solid) {
    adjustment -= 150;
    if (focused(context, subjectRect(minX, minY, maxX, maxY))) {
      issues.push({
        code: 'shadow-crushed',
        message: `${rhu(shadow * 100, solid)}/100 of the solid pixels are at or below Lq 12; the shadow side has run out of steps.`,
        rect: subjectRect(minX, minY, maxX, maxY),
        severity: 0.5,
      });
    }
  }

  const highlightShareQ = rhu(highlight * 1000, solid);
  if (highlight * 100 >= 10 * solid) {
    adjustment -= 150;
    if (focused(context, subjectRect(minX, minY, maxX, maxY))) {
      issues.push({
        code: 'highlight-blown',
        message: `${rhu(highlight * 100, solid)}/100 of the solid pixels are at or above Lq 243; the lit side has run out of headroom.`,
        rect: subjectRect(minX, minY, maxX, maxY),
        severity: 0.45,
      });
    }
  }

  // `plane-crosses-form` is the dimension's reason for existing, and it is the one code here that
  // is allowed to block. Its message names the geometry it measured rather than an artistic role,
  // because it fires on a straight cut through a highlight exactly as it does through a shadow.
  // The band table carries the severity with the band, so the score and the advice cannot drift.
  const planeSeverity: number | null = worst === null ? null : formBandFor(worst.crossesQ).severity;
  if (worst !== null && planeSeverity !== null && focused(context, worst.rect)) {
    issues.push({
      code: 'plane-crosses-form',
      message: `a ${worst.pixels.length}px tone boundary cuts the subject ${planeWord(worst)} and runs straight where the form is curved — a plane this wide should nest around the body, not slice across it.`,
      rect: worst.rect,
      severity: planeSeverity,
    });
  }

  const clamped = Math.max(ADJUSTMENT_MIN, Math.min(ADJUSTMENT_MAX, adjustment));
  return {
    index,
    measured: true,
    N: solid,
    partialAlpha,
    buckets,
    distinct,
    range,
    dominantShareQ,
    lqMin,
    lqMax,
    internalEdges,
    hueOnlyEdges,
    hueOnlyQ,
    keyLight,
    keyLightSamples: samples,
    shadowShareQ,
    highlightShareQ,
    regions: regions.length,
    planes,
    terminators,
    worst,
    gateCounts,
    Dmax,
    toneQ,
    formQ,
    // The form term's share is dropped rather than credited when it was not measured, and the
    // remainder re-normalised — the same rule `STATIC_QUALITY_WEIGHTS` applies to a still sprite's
    // absent `motion`. Crediting it would hand a full-bleed scene 500 of the dimension's 1000 for
    // something the curvature gate declined to look at, and the corpus measured what that buys: a
    // confident `formQ` 1000 and `value` 950 on every one of the twelve real artworks, none of which
    // had a single plane judged.
    scoreQ:
      formQ === null
        ? Math.max(0, Math.min(1000, toneQ + clamped))
        : Math.max(0, Math.min(1000, rhu(500 * toneQ + 500 * formQ, 1000) + clamped)),
    issues,
  };
}

/**
 * §4.2's band lookups, read top down.
 *
 * The two tables run in **opposite directions** and that is a property of the specification, not
 * an oversight worth smoothing over: `toneQ` rises with more buckets (`>= 5` is the top band) while
 * `formQ` falls as the worst plane's badness rises (`> 750` is the bottom band). One helper that
 * hid that difference would be one helper with a sign in it, and the sign is exactly what a
 * reviewer needs to check. `toneBands` and `formBands` are therefore two named functions.
 */
function toneQFor(distinct: number): number {
  for (const [limit, score] of TONE_BANDS) {
    if (distinct >= limit) return score;
  }
  return TONE_FLOOR;
}

/** The band and its `plane-crosses-form` severity together, so advice cannot drift from score. */
function formBandFor(crossesQ: number): { formQ: number; severity: number | null } {
  for (const [limit, formQ, severity] of FORM_BANDS) {
    if (crossesQ <= limit) return { formQ, severity };
  }
  return { formQ: 100, severity: 0.6 };
}

/**
 * §4.2's `keyLight`: the mean `Lq` over a usable top-left region minus the mean over a usable
 * bottom-right one, with the sample regions **grown until they are usable**.
 *
 * The growth is the whole point and it is a bug fix rather than a refinement. Specified against
 * fixed ninths of `bounds`, a sprite could opt out of the only light-direction check in the
 * system by having a thin feature in one corner: the measured case was a crown spire, which left
 * the top-left ninth (`x 4-6, y 4-6`) empty. Both sides grow **in lockstep** so the two regions
 * always stay the same size and symmetric about the box's centre, which is what keeps the
 * difference a comparison of two like things.
 *
 * A region is usable when it holds at least {@link KEY_LIGHT_MIN_PIXELS} solid pixels *and* at
 * least an eighth of its own area. Step 3 halves the box, so in practice it always succeeds and
 * the not-measurable path is nearly unreachable — which is the intent, and when it is reached the
 * answer is "not measurable" rather than a zero.
 */
function keyLightOf(
  cel: QualityCel,
  mask: Uint8Array,
  width: number,
  height: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): { keyLight: number | null; samples: number } {
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  // (third | half) of each side, then the box's own top and bottom halves.
  const steps: readonly (readonly [number, number])[] = [
    [Math.max(1, Math.floor(bw / 3)), Math.max(1, Math.floor(bh / 3))],
    [Math.max(1, Math.floor(bw / 2)), Math.max(1, Math.floor(bh / 2))],
    [bw, Math.max(1, Math.floor(bh / 2))],
  ];
  for (const [w, h] of steps) {
    if (w > bw || h > bh) continue;
    const top = regionMean(cel, mask, width, height, minX, minY, w, h);
    const bottom = regionMean(cel, mask, width, height, minX + (bw - w), minY + (bh - h), w, h);
    if (top === null || bottom === null) continue;
    return { keyLight: top.mean - bottom.mean, samples: top.count + bottom.count };
  }
  return { keyLight: null, samples: 0 };
}

/**
 * Mean `Lq` over a rect, or `null` when the rect is not usable.
 *
 * The mean is `rhu(sum, count)`, an integer, because `keyLight` is compared against the exact
 * thresholds 12 and -25 and a float mean would put a boundary a hair either side of them
 * depending on the accumulation order. Two roundings of the same sum is a baseline diff.
 */
function regionMean(
  cel: QualityCel,
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  w: number,
  h: number,
): { mean: number; count: number } | null {
  let sum = 0;
  let count = 0;
  for (let row = y; row < y + h; row++) {
    if (row < 0 || row >= height) continue;
    for (let col = x; col < x + w; col++) {
      if (col < 0 || col >= width) continue;
      const p = row * width + col;
      if (mask[p] !== 1) continue;
      sum += lqOf(cel, p);
      count++;
    }
  }
  if (count < KEY_LIGHT_MIN_PIXELS) return null;
  if (count * 8 < w * h) return null;
  return { mean: rhu(sum, count), count };
}

/**
 * Every maximal 4-connected run of solid pixels sharing one `LqBucket`, and the id field that
 * says which one each pixel belongs to.
 *
 * `thickness` is the largest number of solid same-bucket 4-neighbours any single pixel of the
 * region has, and it is what separates a value plane from a line: a 1px traced contour, a rim
 * light, a 1px highlight and a dither speck all top out at 2, while any region with an interior
 * reaches 3 or 4. See the file header for why that distinction is load-bearing rather than tidy.
 *
 * One pass, one stack, `regionId` marked on push so the stack is bounded by `width * height` —
 * the same argument `connectedComponents` makes, for the same reason. Regions come back in
 * row-major order of their first pixel, so their indices are a property of the scan and not of
 * the allocator (§3.2 rule 4).
 */
function labelToneRegions(
  cel: QualityCel,
  mask: Uint8Array,
  width: number,
  height: number,
): { regions: ToneRegion[]; regionId: Int32Array } {
  const size = width * height;
  const regionId = new Int32Array(size).fill(-1);
  const stack = new Int32Array(size);
  const regions: ToneRegion[] = [];
  for (let start = 0; start < size; start++) {
    if (mask[start] !== 1 || regionId[start] !== -1) continue;
    const id = regions.length;
    const bucket = lqBucketOf(cel, start);
    regionId[start] = id;
    stack[0] = start;
    let depth = 1;
    let area = 0;
    let thickness = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    while (depth > 0) {
      const p = stack[--depth];
      area++;
      const x = p % width;
      const y = (p - x) / width;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      let same = 0;
      for (const [dx, dy] of ORTHO) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        if (mask[q] !== 1) continue;
        if (lqBucketOf(cel, q) !== bucket) continue;
        same++;
        if (regionId[q] !== -1) continue;
        regionId[q] = id;
        stack[depth++] = q;
      }
      if (same > thickness) thickness = same;
    }
    regions.push({ id, bucket, area, thickness, minX, minY, maxX, maxY });
  }
  return { regions, regionId };
}

/** Orthogonal offsets and the 8-connected set, precomputed rather than built in a hot loop. */
const ORTHO: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const ORTHO_AND_DIAG: readonly (readonly [number, number])[] = [
  ...ORTHO,
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * The plane boundaries, one per connected piece of contact between two tone regions.
 *
 * Three decisions, each of which is a measured fix rather than a preference:
 *
 *   1. **Both sides must be planes.** A boundary between a plane and a 1px line is the line's
 *      boundary, and `outline` owns lines. Counting them put the traced contour's own staircase
 *      into the form term, which is the `colourOrphans` and `inkGaps` defect `TASKS.md` records
 *      as "23 of 29 counts were the 45-degree staircase corners of the contour itself".
 *   2. **The contact is keyed by the region pair, not by the bucket pair**, so two boundaries one
 *      pixel apart cannot fuse into one component however the pixel is canonicalised. On
 *      `pixel demo` that is the difference between 1 plane and 5.
 *   3. **The canonical pixel is the lower-id region's side**, so a boundary is one pixel wide
 *      rather than the two-pixel band a both-sides rule produces, and `bendQ` measures the curve
 *      instead of a band drawn around it. A two-pixel band is not a small difference: a 45° line
 *      drawn two pixels wide is a solid staircase, and it reads as a strongly turning boundary.
 *
 * Components are 8-connected and sorted by pixel index, so the order is a property of the scan
 * rather than of a hash table (§3.2 rule 4). The `Map` is keyed by a packed integer rather than
 * a string, because a 16-bucket scene can carry hundreds of contacts and a string key would
 * allocate once per boundary.
 */
function findTerminators(
  cel: QualityCel,
  mask: Uint8Array,
  width: number,
  height: number,
  regions: readonly ToneRegion[],
  regionId: Int32Array,
  dist: Int32Array,
  Dmax: number,
  bodyExtent: number,
): Terminator[] {
  const size = width * height;
  const isPlane = regions.map((region) => region.thickness >= 3);
  const contacts = new Map<number, number[]>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const a = regionId[p];
      if (a < 0) continue;
      for (const [dx, dy] of ORTHO) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const b = regionId[ny * width + nx];
        if (b < 0 || b === a) continue;
        if (!isPlane[a] || !isPlane[b]) continue;
        const lo = a < b ? a : b;
        const hi = a < b ? b : a;
        // Only the `lo` side is recorded, so a boundary is one pixel wide rather than two, and it
        // is recorded exactly once: the same adjacency is also discovered from `q`, and skipping
        // it there is what stops a pixel being pushed twice. Region id, not bucket, is the
        // tiebreak, because two regions can share a bucket -- the demo's palette puts a gold mid
        // and a green halftone both in bucket 9 -- and the id is a property of the scan rather
        // than of the colour.
        if (a !== lo) continue;
        const key = lo * regions.length + hi;
        const list = contacts.get(key);
        if (list === undefined) contacts.set(key, [p]);
        else list.push(p);
      }
    }
  }

  const out: Terminator[] = [];
  const seen = new Uint8Array(size);
  for (const key of [...contacts.keys()].sort((a, b) => a - b)) {
    const pixels = contacts.get(key)!;
    const lo = Math.floor(key / regions.length);
    const hi = key - lo * regions.length;
    const member = new Set(pixels);
    for (const seed of pixels) {
      if (seen[seed] === 1) continue;
      const component: number[] = [];
      const queue = [seed];
      seen[seed] = 1;
      while (queue.length > 0) {
        const p = queue.pop()!;
        component.push(p);
        const x = p % width;
        const y = (p - x) / width;
        for (const [dx, dy] of ORTHO_AND_DIAG) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const q = ny * width + nx;
          if (!member.has(q) || seen[q] === 1) continue;
          seen[q] = 1;
          queue.push(q);
        }
      }
      if (component.length < MIN_TERMINATOR) continue;
      component.sort((a, b) => a - b);
      out.push(describeTerminator(component, [lo, hi], regions, mask, width, height, dist, Dmax, bodyExtent));
    }
  }
  return out;
}

/** Everything the score needs about one plane boundary, in one place. */
function describeTerminator(
  pixels: readonly number[],
  pair: readonly [number, number],
  regions: readonly ToneRegion[],
  mask: Uint8Array,
  width: number,
  height: number,
  dist: Int32Array,
  Dmax: number,
  bodyExtent: number,
): Terminator {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let d0 = Number.POSITIVE_INFINITY;
  let d1 = -1;
  for (const p of pixels) {
    const x = p % width;
    const y = (p - x) / width;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    const d = dist[p];
    if (d < d0) d0 = d;
    if (d > d1) d1 = d;
  }
  const extent = Math.max(maxX - minX + 1, maxY - minY + 1);
  const member = new Set(pixels);
  const directions = new Set<string>();
  for (const p of pixels) {
    const x = p % width;
    const y = (p - x) / width;
    for (const [dx, dy] of ORTHO_AND_DIAG) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (!member.has(ny * width + nx)) continue;
      // Collapsed to a half-plane key, so `(-1, 0)` and `(1, 0)` are one direction: a boundary's
      // orientation is what is being counted and not which way along it the scan walked.
      directions.add(dx > 0 || (dx === 0 && dy > 0) ? `${dx},${dy}` : `${-dx},${-dy}`);
    }
  }
  // The pixel surplus a bend implies, alongside the direction count. The two disagree in both
  // directions and the weaker reading wins, so a rasterised staircase cannot talk the term into
  // calling a straight line curved: a 45-degree line drawn as a two-pixel band is a solid
  // staircase with 1 direction and a surplus of 86/1000, and reads as bending; the one-pixel
  // boundary reads as 0/0. A shallow *straight* line has two alternating step directions and a
  // surplus near zero, and reads as barely bending. Both are the false positive the weaker
  // reading is there to remove, and the failure they share is a **missed** straight cut, which is
  // the direction this dimension is allowed to fail in.
  const surplusQ = Math.max(0, Math.min(1000, rhu((pixels.length - extent) * 1000, extent)));
  // The denominator is 2, and the number it replaced was 3, and the reason is a loop.
  //
  // The half-plane collapse gives four orientations, and an **open** boundary on a convex body
  // cannot use all four — going right, down, left, up closes it — so an arc saturates at three and
  // a closed ring at four. Dividing by three therefore reads a maximally-turning arc at 667 and
  // the ring that encloses it at 1000, which puts the product's own reference construction below
  // the target-like one: `value/nested-contour-32` measured `formQ` 750 against
  // `value/level-set-32`'s 1000, on the same body, with the same five tones, the same five planes
  // and no defect on either side. The header below used to claim the two read identically. They did
  // not, and the sentence was wrong because nobody had drawn the level set properly to check it —
  // `benchmarks/corpus/cases.json` draws it largest-first, and the fixture in
  // `packages/core/test/quality-value.test.ts` drew it deepest-first and got two tones.
  //
  // Three orientations is the point where a boundary has stopped being a line and started tracking
  // something, so that is where the ladder saturates: one orientation is 0, two is 500, three or
  // more is 1000. A fourth orientation is not more evidence of form-following than a third, it is
  // the same evidence with the ends joined.
  //
  // The rejected alternative is recorded because it was the obvious one: "is this boundary locally
  // parallel to the silhouette's own edge", which unifies the two constructions by definition — a
  // level set and a translation are both offsets of the outline. Measured, it is worse than useless:
  // a straight 45-degree cut across the round body scored 923 and the translated contour scored 0,
  // because a chord is locally parallel to the outline over the middle of its run and a translation
  // is parallel to a *shifted* copy of it. The idea is in the history because it is the next thing
  // anyone will try.
  const dirQ = rhu((Math.min(directions.size, DIR_SATURATION) - 1) * 1000, DIR_SATURATION - 1);
  const bendQ = Math.max(surplusQ, dirQ);
  const a = regions[pair[0]].area;
  const b = regions[pair[1]].area;
  const splitQ = a < b ? rhu(a * 1000, b) : rhu(b * 1000, a);
  const reachQ = rhu(Math.min(extent, bodyExtent) * 1000, bodyExtent);
  const { edgeN, corners } = curvatureNear(pixels, mask, width, height);
  const curvedQ = rhu(corners * 1000, edgeN + 1);
  // Three gates, each earning its place on a measurement, and all three failing toward "cannot
  // measure". `curvedQ`: a straight plane across a straight-edged form is correct. `reachQ`: a
  // boundary that does not cross the body is a fragment, not a cross-section. `splitQ` is the
  // only multiplier, and it is the clause that makes a *crescent* safe: a level set and a
  // translated contour both produce a thin sliver against a fat field, and a straight cut
  // produces two fat halves.
  //
  // Both gates record *which one* closed, because `crossesQ` is 0 either way and the frame has to
  // be able to tell "this plane follows the form" from "this plane was never asked" once every
  // plane turns out to be gated. Curvature is checked first because it is the one that closes on a
  // whole class of artwork rather than on individual planes: a subject that fills the canvas has a
  // rectangular outline, four convex corners in total, and none of them near an interior plane, so
  // every plane in a full-bleed scene is exempt.
  const gate = curvedQ < CURVATURE_GATE ? 'curvature' : reachQ < REACH_GATE ? 'reach' : null;
  const crossesQ = gate === null ? rhu((1000 - bendQ) * splitQ, 1000) : 0;
  return {
    pixels,
    regions: [pair[0], pair[1]],
    rect: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    bendQ,
    splitQ,
    reachQ,
    curvedQ,
    crossesQ,
    gate,
    d0: d0 === Number.POSITIVE_INFINITY ? 0 : d0,
    d1: d1 < 0 ? 0 : d1,
    spanQ: rhu((d1 - d0) * 1000, Dmax + 1),
  };
}

/**
 * §4.2's `edgeN` and `corners` over the pixels within Chebyshev {@link NEAR_RADIUS} of a plane.
 *
 * `corners` is the corrected `convexCorner` — a pixel on a convex 45° staircase — because §3.3's
 * own clause counts the opposite and reads 0 on every real asset in this repository. See
 * `measure.ts`. Outside the canvas counts as not solid and not an edge pixel, which is what makes
 * the count scale with the shape rather than with the canvas.
 */
function curvatureNear(
  pixels: readonly number[],
  mask: Uint8Array,
  width: number,
  height: number,
): { edgeN: number; corners: number } {
  const seen = new Set<number>();
  let edgeN = 0;
  let corners = 0;
  for (const p of pixels) {
    const x = p % width;
    const y = (p - x) / width;
    for (let dy = -NEAR_RADIUS; dy <= NEAR_RADIUS; dy++) {
      for (let dx = -NEAR_RADIUS; dx <= NEAR_RADIUS; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        if (seen.has(q)) continue;
        seen.add(q);
        if (!edgePixelAt(mask, width, height, nx, ny)) continue;
        edgeN++;
        if (convexStaircaseCornerAt(mask, width, height, nx, ny)) corners++;
      }
    }
  }
  return { edgeN, corners };
}

/** The tight box of the solid pixels, which is §3.3's `bounds`. */
function subjectRect(minX: number, minY: number, maxX: number, maxY: number): Rect {
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Whether an issue survives `context.focus`.
 *
 * `focus` is a scope, not a crop, so it never changes a number — it only decides which defects
 * the caller is told about. Intersection rather than containment, so a defect whose evidence
 * straddles the box's edge is still reported, which is the contract's own clause. Written out
 * rather than shared because §3.3 does not name it and `silhouette.ts` has its own copy; the two
 * are five lines of rectangle intersection and neither is a measured quantity.
 */
function focused(context: QualityContext, rect: Rect): boolean {
  if (context.focus === null) return true;
  return (
    rect.x < context.focus.x + context.focus.w &&
    context.focus.x < rect.x + rect.w &&
    rect.y < context.focus.y + context.focus.h &&
    context.focus.y < rect.y + rect.h
  );
}

/** `"1 frame"` / `"4 frames"`. */
function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

/** `"1 boundary"` / `"4 boundaries"`, for the irregular plural the verdict note needs. */
function pluralBoundaries(count: number, word: string, pluralWord: string): string {
  return count === 1 ? word : pluralWord;
}

/** A noun for how a plane divides the subject, so the message names the geometry. */
function planeWord(term: Terminator): string {
  if (term.splitQ >= 700) return 'into two near-equal halves';
  if (term.splitQ >= 300) return 'unevenly';
  return 'off a thin crescent';
}

/** The one sentence `QualityDimension.verdict` is allowed. */
function describe(frame: ValueFrame): string {
  const parts: string[] = [
    `${frame.distinct} lightness ${plural(frame.distinct, 'bucket')} over a range of ${frame.range}`,
  ];
  if (frame.planes > 0) {
    parts.push(
      `${frame.planes} value ${plural(frame.planes, 'plane')}, ${frame.terminators.length} ${frame.terminators.length === 1 ? 'boundary' : 'boundaries'} between them`,
    );
  } else {
    parts.push('no interior value plane to judge');
  }
  if (frame.worst !== null && frame.worst.crossesQ > 600) {
    parts.push(
      `a ${frame.worst.pixels.length}px boundary cuts the subject ${planeWord(frame.worst)} where the form is curved`,
    );
  }
  if (frame.hueOnlyQ === -1) {
    parts.push(`not enough interior (${frame.internalEdges} edges) to judge hue against tone`);
  }
  if (frame.keyLight === null) parts.push('key light not measurable');
  if (frame.partialAlpha > 0) {
    parts.push(`${frame.partialAlpha} px below ALPHA_SOLID ${ALPHA_SOLID}, counted but not scored`);
  }
  return `${parts.join(', ')}.`;
}

export default valueAnalyzer;
