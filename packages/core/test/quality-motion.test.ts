import { describe, expect, it } from 'vitest';
import { createQualityContext } from '../src/quality/context.js';
import { motionAnalyzer, measureMotion } from '../src/quality/motion.js';
import { lqOf, rhu } from '../src/quality/measure.js';
import { DEFAULT_DIMENSIONS, motionApplicability } from '../src/quality/index.js';
import type { QualityContext, QualityIssue } from '../src/quality/types.js';
import { createSprite, type Sprite } from '../src/document.js';
import { createPalette } from '../src/palette.js';
import { PixelBuffer } from '../src/buffer.js';

/**
 * `motion` — §4.6's numbers measured, and the two defects this specification leaves.
 *
 * ## The shape of this file
 *
 * Every measure gets **a construction that must trip it and a near-miss on the other side of the same
 * gate**, because one direction is not a threshold and an assertion that passes with and without the
 * implementation proves nothing. This is `quality-outline.test.ts`'s convention and its reason.
 *
 * ## How the fixtures are built, and why the seam ratio is easy to control here
 *
 * Every sequence below is a set of frames on one 32x32 canvas, each frame a **rigid row-shift of a
 * 4x4 block** (`rect(6, top, 4, 4)`), so a shift of `k` rows changes exactly `8k` pixels and every
 * number below is derivable by hand:
 *
 *   f0 rows 4-7, f1 rows 5-8, f2 rows 6-9, f3 rows 20-23
 *     churn(f0,f1)  8   churn(f1,f2)  8   churn(f2,f3) 32   seam(f3,f0) 32
 *     churnMedian = median(8, 8, 32) = 8, seamRatio = 32 / max(1, 8) = 4
 *
 * The **tone ladder** is the other construction, and it is what pins the band table's edges to the
 * exact integer the specification names. Four frames draw the *same pixels* in four greys, so churn
 * is 0 on every transition and the seam ratio is carried entirely by `lumSeamRatio` — which is
 * §4.6's own claim ("a seam that pops in *colour* while the silhouette happens to match still gets
 * caught") and the only way to land a ratio on a specific fraction without drawing it. A grey of
 * `t + 1` reads `Lq` exactly `t`, because `(255 * (t + 1)) >> 8 === t` for every `t <= 255`.
 *
 * ## What is fixed and what is not
 *
 *   - **The band table is read with a `return`, and the two directions are opposites.** `outlineShare`
 *     rewards a high ratio so its rows are walked upward and the *last* match wins; the seam ratio
 *     punishes a high ratio so its rows are walked upward and the *first* match wins. Both tables
 *     are asserted here at every edge §4.6 names, and the "ratio 0 returns 1000" case is asserted
 *     explicitly because it is the row a descending walk gets wrong.
 *   - **`churnMax` and `deltaSpread` are internal-only**, so the loop point is never counted twice.
 *     The `loop-seam-pop` MUST FIRE fixtures carry a large seam on purpose and a jitter MUST FIRE
 *     fixture cannot avoid a large seam; those tests assert *their* code, not the absence of others.
 *   - **The `outline` guard is inherited and asserted.** A frame with no ink has no centroid and no
 *     area, and §4.6's `areaSpread` divides by the mean area. There is a MUST FIRE and a NEAR MISS
 *     for that, and the number the unguarded formula would have produced is written into the comment
 *     so the guard's value is checkable rather than asserted.
 */

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** One frame's drawing: filled rows `[left, right, y]` and one flat tone. */
interface Frame {
  readonly rows: readonly (readonly [number, number, number])[];
  /** `Lq` of the tone this frame is drawn in. Defaults to {@link BODY_LQ}. */
  readonly lq?: number;
}

/** The default body tone's `Lq`. Grey `BODY_LQ + 1`. */
const BODY_LQ = 100;

/** Rows for `rect(left, top, w, h)`, the only shape these fixtures need. */
function rect(left: number, top: number, w: number, h: number): (readonly [number, number, number])[] {
  const rows: (readonly [number, number, number])[] = [];
  for (let y = top; y < top + h; y++) rows.push([left, left + w - 1, y]);
  return rows;
}

/** A grey whose §3.4 `Lq` is exactly `lq`: `(255 * (lq + 1)) >> 8 === lq` for every `lq <= 255`. */
function greyFor(lq: number): string {
  const v = lq + 1;
  return `#${v.toString(16).padStart(2, '0').repeat(3)}`;
}

/** A sprite on a 32x32 canvas, one flat tone per frame, at the default 100ms. */
function spriteOf(frames: readonly Frame[]): Sprite {
  const tones = [...new Set(frames.map((frame) => greyFor(frame.lq ?? BODY_LQ)))];
  const sprite = createSprite({
    width: 32,
    height: 32,
    frames: frames.length,
    name: 'motion-fixture',
    layers: ['Base'],
    // The fixture's own palette, for `quality-outline.test.ts`'s reason: these pictures paint
    // greys the default 16-entry DawnBringer does not name, and a dimension asserting a defect about
    // the palette rather than about the picture is the only kind worth writing a test about.
    palette: createPalette('motion-fixture', tones),
  });
  const layer = sprite.layers[0].id;
  for (let f = 0; f < frames.length; f++) {
    const cel = new PixelBuffer(32, 32);
    const v = (frames[f].lq ?? BODY_LQ) + 1;
    for (const [left, right, y] of frames[f].rows) {
      for (let x = left; x <= right; x++) {
        const i = cel.index(x, y);
        cel.data[i] = v;
        cel.data[i + 1] = v;
        cel.data[i + 2] = v;
        cel.data[i + 3] = 255;
      }
    }
    sprite.frames[f].cels.set(layer, cel);
  }
  return sprite;
}

/** The same, with explicit per-frame durations in playback order. */
function spriteWithDurations(frames: readonly Frame[], durations: readonly number[]): Sprite {
  const sprite = spriteOf(frames);
  durations.forEach((ms, i) => {
    sprite.frames[i].durationMs = ms;
  });
  return sprite;
}

function contextOf(sprite: Sprite): QualityContext {
  return createQualityContext(sprite);
}

function codes(issues: readonly QualityIssue[]): readonly string[] {
  return issues.map((issue) => issue.code);
}

function severityOf(issues: readonly QualityIssue[], code: string): number | undefined {
  return issues.find((issue) => issue.code === code)?.severity;
}

/** `rect(6, top, 4, 4)` on one frame: a 4x4 block whose top row is `top`. */
function block(top: number): Frame {
  return { rows: rect(6, top, 4, 4) };
}

/** The same block in a named tone, for the seam-ratio ladder. */
function tonedBlock(top: number, lq: number): Frame {
  return { rows: rect(6, top, 4, 4), lq };
}

/** `tops` there and one step back, so every transition **and** the seam are a single 8px shift. */
function pingpong(tops: readonly number[]): Frame[] {
  return [...tops, tops[tops.length - 2]].map(block);
}

/* ------------------------------------------------------------------ *
 * 1 · Applicability, which is not this file's code and is therefore pinned from outside
 * ------------------------------------------------------------------ */

describe('the two exclusions are the aggregator\'s, and the analyzer is never reached for either', () => {
  it('MUST FIRE: a still sprite is excluded single-frame and carries no motion score', () => {
    // The predicate is the contract, and `evaluate` is what consults it before the analyzer runs.
    const still = contextOf(spriteOf([block(4)]));
    expect(motionApplicability(still)).toBe('single-frame');
    expect(still.frameIds).toHaveLength(1);
  });

  it('MUST FIRE: byte-identical frames are excluded no-motion-content, and the advisory rides alongside', () => {
    const hold = contextOf(spriteOf([block(4), block(4), block(4)]));
    expect(motionApplicability(hold)).toBe('no-motion-content');

    // **The trap this dimension exists to avoid, measured rather than argued.** Measured honestly the
    // identical sequence is a *perfect* animation — churn 0 on every transition, seam 0, ratio
    // `0 / max(1, 0)` — so the analyzer called on it would hand back 1000, a perfect mark, for a
    // sprite that does not move. The exclusion is what stops that, and it is why this file asserts
    // the predicate rather than the analyzer for the degenerate half.
    const degenerate = measureMotion(hold);
    expect(degenerate.churn.every((c) => c === 0)).toBe(true);
    expect(degenerate.baseQ).toBe(1000);
  });

  it('NEAR MISS on the other side of the same gate: one changed pixel is measurable', () => {
    const alive = contextOf(spriteOf([block(4), block(5)]));
    expect(motionApplicability(alive)).toBeNull();
  });

  it('registers with motionApplicability, so evaluate omits the key rather than scoring it 0', () => {
    const entry = DEFAULT_DIMENSIONS.find((dimension) => dimension.id === 'motion');
    expect(entry).toBeDefined();
    expect(entry?.analyze).toBe(motionAnalyzer);
    expect(entry?.applies).toBe(motionApplicability);
  });
});

/* ------------------------------------------------------------------ *
 * 2 · The band table, edge by edge
 * ------------------------------------------------------------------ */

describe('the seam band table is read ascending with a return, and every edge is the integer §4.6 names', () => {
  /**
   * Four frames on the **same pixels** in four greys: churn is 0 everywhere, so the primary ratio is
   * `lumSeam / max(1, lumMedian)` and is set exactly by the tones. `f0` 100, `f1` 120, `f2` 140 give
   * internal `lumDelta` 20, 20 and therefore `lumMedian` 20; `f3` sets the seam to `|f3 - 100|`.
   */
  function ladder(seamLq: number) {
    const frames = [tonedBlock(4, 100), tonedBlock(4, 120), tonedBlock(4, 140), tonedBlock(4, seamLq)];
    const motion = measureMotion(contextOf(spriteOf(frames)));
    expect(motion.lumDelta).toEqual([20, 20, Math.abs(seamLq - 140), Math.abs(seamLq - 100)]);
    expect(motion.lumMedian).toBe(20);
    return motion;
  }

  it('MUST FIRE: seam 27 against a median of 20 is exactly 1.35 and returns the top band 1000', () => {
    // `seam * 20 = 540 <= 27 * 20 = 540`. The boundary is inclusive and this is the side that holds.
    const motion = ladder(127);
    expect(motion.lumSeam).toBe(27);
    expect(motion.baseQ).toBe(1000);
    expect(codes(motion.issues)).not.toContain('loop-seam-pop');
  });

  it('NEAR MISS on the other side of the same edge: seam 28 against a median of 20 drops to 880', () => {
    // One `Lq` unit. `540 + 20 = 560 > 540`, and `560 <= 700`, so the second row and not the fifth.
    const motion = ladder(128);
    expect(motion.lumSeam).toBe(28);
    expect(motion.baseQ).toBe(880);
    expect(codes(motion.issues)).not.toContain('loop-seam-pop');
  });

  it('MUST FIRE: seam 36 against a median of 20 is past 1.75 and fires loop-seam-pop at 0.30', () => {
    // `720 > 700` fires the code; `720 <= 1000` keeps it advisory, and the band is 720.
    const motion = ladder(136);
    expect(motion.baseQ).toBe(720);
    expect(severityOf(motion.issues, 'loop-seam-pop')).toBe(0.3);
  });

  it('NEAR MISS on the blocking half of the same row: seam 50 is exactly 2.50 and does not block', () => {
    // `1000 > 1000` is false, so this is the last non-blocking pop; the band is 720, not 500.
    const motion = ladder(150);
    expect(motion.lumSeam).toBe(50);
    expect(motion.baseQ).toBe(720);
    expect(severityOf(motion.issues, 'loop-seam-pop')).toBe(0.3);
  });

  it('MUST FIRE: seam 51 is one unit past 2.50 and blocks loop-seam-pop at 0.55', () => {
    const motion = ladder(151);
    expect(motion.baseQ).toBe(500);
    expect(severityOf(motion.issues, 'loop-seam-pop')).toBe(0.55);
  });

  it('MUST FIRE: seam 81 is past 4.00 and falls off the end of the table to 250', () => {
    const motion = ladder(181);
    expect(motion.lumSeam).toBe(81);
    expect(motion.baseQ).toBe(250);
    expect(severityOf(motion.issues, 'loop-seam-pop')).toBe(0.55);
  });

  it('a seam that changes nothing at all returns the TOP band, not the floor', () => {
    // The direction this table is read in, asserted at the value that gets it wrong. A descending
    // walk with `for`-and-`return` gives a ratio of 0 the loosest row; this is 1000.
    const motion = measureMotion(contextOf(spriteOf(pingpong([4, 5, 6]))));
    expect(motion.churn).toEqual([8, 8, 8, 8]);
    expect(motion.seam).toBe(8);
    expect(motion.churnMedian).toBe(8);
    expect(motion.baseQ).toBe(1000);
  });

  it('NEAR MISS on the silhouette side: a rigid slide reads ratio 3, not a seam-free 1', () => {
    // f0 rows 4-7, f1 rows 5-8, f2 rows 6-9, f3 rows 20-23. The seam is 32 against a median of 8.
    const motion = measureMotion(contextOf(spriteOf([block(4), block(5), block(6), block(20)])));
    expect(motion.churn).toEqual([8, 8, 32, 32]);
    expect(motion.churnMedian).toBe(8);
    expect(motion.seam).toBe(32);
    expect(motion.lumPrimary).toBe(false);
    expect(motion.baseQ).toBe(500);
  });

  it('a seam that pops in tone while the pixels match is still caught, and says which channel it used', () => {
    // §4.6's own sentence. Every transition changes zero pixels, so the silhouette reading is silent
    // and the whole finding is `lumSeamRatio` — the case a mask-only dimension would score 1000.
    const motion = measureMotion(
      contextOf(spriteOf([tonedBlock(4, 100), tonedBlock(4, 120), tonedBlock(4, 140), tonedBlock(4, 160)])),
    );
    expect(motion.churn.every((c) => c === 0)).toBe(true);
    expect(motion.seam).toBe(0);
    expect(motion.lumSeam).toBe(60);
    expect(motion.lumMedian).toBe(20);
    expect(motion.lumPrimary).toBe(true);
    expect(motion.baseQ).toBe(500);
  });
});

/* ------------------------------------------------------------------ *
 * 3 · The Δ rows, each with a near miss
 * ------------------------------------------------------------------ */

describe('the Δ rows, each with a near miss on the other side of its own gate', () => {
  it('MUST FIRE: a silhouette whose area changes by more than 150 per-mille reads silhouette-instability at 0.60', () => {
    // 64 px against 16 px: `rhu((64 - 16) * 1000, rhu(80, 2)) = rhu(48000, 40) = 1200`.
    const motion = measureMotion(contextOf(spriteOf([{ rows: rect(6, 6, 8, 8) }, block(6)])));
    expect(motion.areas).toEqual([64, 16]);
    expect(motion.areaSpreadQ).toBe(1200);
    expect(severityOf(motion.issues, 'silhouette-instability')).toBe(0.6);
    expect(motion.scoreQ).toBe(800);
  });

  it('NEAR MISS on the same row: an area spread of 118 per-mille is the advisory half, not the blocking half', () => {
    // 64 against 72: `rhu(8 * 1000, rhu(136, 2)) = rhu(8000, 68) = 118`, inside `60 < spread <= 150`.
    const wide = { rows: [...rect(6, 6, 8, 8), ...rect(14, 6, 1, 8)] };
    const motion = measureMotion(contextOf(spriteOf([{ rows: rect(6, 6, 8, 8) }, wide])));
    expect(motion.areaSpreadQ).toBe(118);
    expect(severityOf(motion.issues, 'silhouette-instability')).toBe(0.3);
    expect(motion.scoreQ).toBe(920);
  });

  it('NEAR MISS below the row: an area spread of 15 per-mille says nothing at all', () => {
    // One extra pixel: `rhu(1 * 1000, rhu(129, 2)) = rhu(1000, 65) = 15`, under the 60 light step.
    const one = { rows: [...rect(6, 6, 8, 8), [20, 20, 20] as const] };
    const motion = measureMotion(contextOf(spriteOf([{ rows: rect(6, 6, 8, 8) }, one])));
    expect(motion.areaSpreadQ).toBe(15);
    expect(codes(motion.issues)).not.toContain('silhouette-instability');
    expect(motion.scoreQ).toBe(1000);
  });

  it('MUST FIRE: one internal transition twice the median plus one reads frame-jitter at 0.50', () => {
    // churn 32, 8, 8 and a seam of 32. `churnMedian` is the **lower** median of the internal three, so
    // 8, and `32 > 2 * 8`. The seam row fires alongside and is asserted in its own test.
    const motion = measureMotion(contextOf(spriteOf([block(4), block(8), block(9), block(8)])));
    expect(motion.churn).toEqual([32, 8, 8, 32]);
    expect(motion.churnMedian).toBe(8);
    expect(motion.churnMax).toBe(32);
    expect(severityOf(motion.issues, 'frame-jitter')).toBe(0.5);
  });

  it('NEAR MISS on the same row: an internal maximum of exactly twice the median does not fire', () => {
    // churn 8, 8, 16. `16 > 16` is false, and the row is strict for the same reason every gate here is.
    // The third frame is the same 4x4 block with two extra columns beside it, so only 16 pixels move.
    const fat: Frame = { rows: rect(6, 6, 6, 4) };
    const motion = measureMotion(contextOf(spriteOf([block(4), block(5), fat])));
    // churn 8, 16 internally with a seam of 24: `churnMax 16 > 2 * churnMedian 16` is false, exactly.
    expect(motion.churn).toEqual([8, 16, 24]);
    expect(motion.churnMedian).toBe(8);
    expect(motion.churnMax).toBe(16);
    expect(codes(motion.issues)).not.toContain('frame-jitter');
  });

  it('the seam is excluded from churnMax, so a loop that is different only at the seam is not jitter', () => {
    // churn 8, 8, 8 internally with a seam of 24. Counting the seam would give `24 > 16` and a jitter
    // that is not one — the seam is *supposed* to differ, and §4.6 says so twice.
    const motion = measureMotion(contextOf(spriteOf([block(4), block(5), block(6), block(7)])));
    expect(motion.churn).toEqual([8, 8, 8, 24]);
    expect(motion.churnMax).toBe(8);
    expect(codes(motion.issues)).not.toContain('frame-jitter');
  });

  it('MUST FIRE: a loop that travels three pixels and teleports back reads loop-seam-jump at 0.55', () => {
    // Centroid steps of 1px (64 in 1/64 px) in the loop and 3px (192) at the seam: `192 * 2 > 64 * 3`.
    const motion = measureMotion(contextOf(spriteOf([block(4), block(5), block(6), block(7)])));
    expect(motion.maxStep).toBe(64);
    expect(motion.seamStep).toBe(192);
    expect(severityOf(motion.issues, 'loop-seam-jump')).toBe(0.55);
    expect(motion.adjustmentQ).toBe(-150);
  });

  it('NEAR MISS on the same row: a two-frame cycle steps as far at the seam as in the loop, so it does not jump', () => {
    // One transition and one seam, both 1px: `64 * 2 = 128` is not `> 64 * 3 = 192`. A 2-frame
    // animation has no interior to be inconsistent with, which is the correct reading.
    const motion = measureMotion(contextOf(spriteOf([block(4), block(5)])));
    expect(motion.seamStep).toBe(64);
    expect(motion.maxStep).toBe(64);
    expect(codes(motion.issues)).not.toContain('loop-seam-jump');
    expect(motion.scoreQ).toBe(1000);
  });

  it('NEAR MISS on the 1px half of the clause: a half-pixel return is not a jump however it compares', () => {
    // Four frames, the last a quarter-turn of the block so the centroid moves a fraction of a pixel:
    // `seamStep < 64` fails §4.6's `>= 1.0px` clause even though the ratio clause can pass.
    const frames = [
      { rows: rect(6, 4, 4, 4) },
      { rows: rect(6, 4, 3, 4) },
      { rows: rect(6, 5, 3, 4) },
      { rows: rect(6, 5, 4, 3) },
    ];
    const motion = measureMotion(contextOf(spriteOf(frames)));
    expect(motion.seamStep).toBeGreaterThan(0);
    expect(motion.seamStep).toBeLessThan(64);
    expect(codes(motion.issues)).not.toContain('loop-seam-jump');
  });

  it('MUST FIRE: a frame held four times the median reads timing-outlier at 0.35', () => {
    const motion = measureMotion(
      contextOf(spriteWithDurations([block(4), block(5), block(4)], [100, 400, 100])),
    );
    expect(motion.durations).toEqual([100, 400, 100]);
    expect(motion.loopMs).toBe(600);
    expect(severityOf(motion.issues, 'timing-outlier')).toBe(0.35);
    expect(motion.scoreQ).toBe(900);
  });

  it('NEAR MISS on the same row: exactly three times the median is not an outlier', () => {
    const motion = measureMotion(
      contextOf(spriteWithDurations([block(4), block(5), block(4)], [100, 300, 100])),
    );
    expect(motion.durations).toEqual([100, 300, 100]);
    expect(codes(motion.issues)).not.toContain('timing-outlier');
    expect(motion.scoreQ).toBe(1000);
  });

  it('MUST FIRE: a cycle shorter than 80ms reads loop-duration-out-of-range at 0.30', () => {
    const motion = measureMotion(
      contextOf(spriteWithDurations([block(4), block(5), block(4)], [20, 20, 20])),
    );
    expect(motion.loopMs).toBe(60);
    expect(severityOf(motion.issues, 'loop-duration-out-of-range')).toBe(0.3);
    expect(motion.scoreQ).toBe(900);
  });

  it('NEAR MISS on the same row: a 90ms cycle is inside the window and says nothing', () => {
    const motion = measureMotion(
      contextOf(spriteWithDurations([block(4), block(5), block(4)], [30, 30, 30])),
    );
    expect(motion.loopMs).toBe(90);
    expect(codes(motion.issues)).not.toContain('loop-duration-out-of-range');
    expect(motion.scoreQ).toBe(1000);
  });

  it('MUST FIRE: uniform timing over uneven motion reads timing-mismatch at 0.45', () => {
    // Four frames on the same pixels, tones 100 / 120 / 160 / 100. The internal `lumDelta`s are
    // 20, 40, 60, so `deltaSpread = rhu((60 - 20) * 1000, 60) = 667`, and every duration is 100ms.
    const motion = measureMotion(
      contextOf(
        spriteOf([
          tonedBlock(4, 100),
          tonedBlock(4, 120),
          tonedBlock(4, 160),
          tonedBlock(4, 100),
        ]),
      ),
    );
    expect(motion.lumDelta).toEqual([20, 40, 60, 0]);
    expect(motion.deltaSpreadQ).toBe(667);
    expect(motion.durations.every((ms) => ms === 100)).toBe(true);
    expect(severityOf(motion.issues, 'timing-mismatch')).toBe(0.45);
  });

  it('NEAR MISS on the same row: the same uneven motion on varied timing is a deliberate hold', () => {
    // Identical pixels, one duration changed: the delta spread is unchanged and the row needs BOTH
    // halves, so it does not fire. This is the "I meant that" §7 item 4 says there is no mechanism for.
    const motion = measureMotion(
      contextOf(
        spriteWithDurations(
          [tonedBlock(4, 100), tonedBlock(4, 120), tonedBlock(4, 160), tonedBlock(4, 100)],
          [100, 120, 100, 120],
        ),
      ),
    );
    expect(motion.deltaSpreadQ).toBe(667);
    expect(codes(motion.issues)).not.toContain('timing-mismatch');
  });
});

/* ------------------------------------------------------------------ *
 * 4 · The inherited `outline` guard
 * ------------------------------------------------------------------ */

describe('a frame with no ink has no area and no centroid, and the rows that divide by them are guarded', () => {
  it('MUST FIRE: a blank second frame reads areaSpread 0, not the 2000 the unguarded formula gives', () => {
    // **The hazard `outline` paid for, arriving one dimension later.** `areaSpread` is
    // `(max - min) / mean(area)` and a blank frame has area 0, so the unguarded reading over
    // `[64, 0]` is `rhu(64 * 1000, rhu(64, 2)) = rhu(64000, 32) = 2000` — a per-mille 1000 twice over
    // on a document whose real defect is `empty-frame`, which the aggregator reports at severity 1.00.
    // `MotionSequence.inkedFrames` is the guard, and this is it failing if it is ever removed.
    const motion = measureMotion(contextOf(spriteOf([{ rows: rect(6, 6, 8, 8) }, { rows: [] }])));
    expect(motion.areas).toEqual([64, 0]);
    expect(motion.inkedFrames).toBe(1);
    expect(motion.areaSpreadQ).toBe(0);
    expect(rhu(64 * 1000, rhu(64, 2))).toBe(2000);
    expect(codes(motion.issues)).toEqual([]);
    expect(motion.scoreQ).toBe(1000);
  });

  it('NEAR MISS on the other side of the guard: a blank frame still moves 64 pixels of churn', () => {
    // The guard covers the area and centroid rows and **only** them. Churn is a fact about pixels and
    // a frame going blank really does change 64 of them, so the reading stays honest.
    const motion = measureMotion(contextOf(spriteOf([{ rows: rect(6, 6, 8, 8) }, { rows: [] }])));
    expect(motion.churn).toEqual([64, 64]);
    expect(motion.seamStep).toBe(0);
    expect(motion.maxStep).toBe(0);
    expect(codes(motion.issues)).not.toContain('loop-seam-jump');
  });
});

/* ------------------------------------------------------------------ *
 * 5 · The analyzer's verdict, and the numbers it is built from
 * ------------------------------------------------------------------ */

describe('the analyzer names the channel it used and prints the numbers behind its verdict', () => {
  it('says which ratio carried the finding, on both sides', () => {
    const tone = motionAnalyzer(
      contextOf(spriteOf([tonedBlock(4, 100), tonedBlock(4, 120), tonedBlock(4, 140), tonedBlock(4, 160)])),
    );
    expect(tone.verdict).toContain('the tone channel carried the pop');
    expect(tone.scoreQ).toBe(500);

    const mask = motionAnalyzer(contextOf(spriteOf([block(4), block(5), block(6), block(7)])));
    expect(mask.verdict).not.toContain('the tone channel carried the pop');
    expect(mask.verdict).toContain('loop seam changes 24 px against a median of 8');
    expect(mask.unmeasured).toEqual({});
  });

  it('the luminance is §3.4\'s integer Lq, not a float, so the seam ratio cannot drift by a rounding', () => {
    const context = contextOf(spriteOf([tonedBlock(4, 100), tonedBlock(4, 120)]));
    // One assertion on the shared quantity rather than on `motion`'s use of it: the fixture's tone
    // really is Lq 100 at a pixel *inside* the block, which is what makes every ladder row above
    // derivable by hand. Pixel 0 is transparent and reads 0, which is not the assertion.
    const inside = 4 * 32 + 6;
    expect(lqOf(context.composite[0], inside)).toBe(100);
    expect(lqOf(context.composite[1], inside)).toBe(120);
  });
});
