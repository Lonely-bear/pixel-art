import { describe, expect, it } from 'vitest';
import { PixelBuffer } from '../src/buffer.js';
import { createEditor } from '../src/commands/index.js';
import { qualityGate, qualityGateForSprite } from '../src/commands/quality.js';
import { createSprite, type Sprite } from '../src/document.js';
import { createPalette } from '../src/palette.js';
import { createQualityContext } from '../src/quality/context.js';
import {
  deriveAssetClass,
  evaluate,
  resolveAssetClass,
  weightedTotalQ,
  weightsFor,
} from '../src/quality/index.js';
import {
  DEFAULT_QUALITY_WEIGHTS,
  QUALITY_ASSET_CLASSES,
  QUALITY_DIMENSIONS,
  QUALITY_WEIGHT_PROFILES,
  SCENE_AREA_THRESHOLD,
  type QualityAssetClass,
  type QualityDimension,
  type QualityDimensionId,
  type QualityDimensionRegistration,
} from '../src/quality/types.js';

/**
 * §5.2's per-asset-class weight profiles: which class applies, and that the default reproduces
 * every number that existed before profiles did.
 *
 * ## Why this file is mostly *arithmetic* rather than artwork
 *
 * The interesting question about a weight profile is not "does it score a walk cycle nicely" —
 * there are no human ratings in this repository and that question cannot be answered here. It is
 * the two questions that can be:
 *
 *   1. **Is the profile the only thing that moved?** Every profile is exercised over the *same*
 *      six synthetic dimension scores, so a difference between two totals is arithmetically
 *      forced to be the weight table and nothing else. A fixture with real artwork cannot make
 *      that claim, because two runs also differ in which dimensions were present.
 *   2. **Does "nothing specified" still mean "§5.1's table"?** That is the backward-compatibility
 *      guarantee and it is the assertion most likely to break silently: a default that quietly
 *      picked the largest canvas in the corpus as its class would move every committed baseline
 *      and no test in the package would object. So the sprite total is asserted against
 *      `DEFAULT_QUALITY_WEIGHTS` *and* against the pre-profile one-argument `weightedTotalQ`.
 *
 * ## What is deliberately NOT asserted
 *
 * No assertion here says a profile is *correct*. Every number in
 * {@link QUALITY_WEIGHT_PROFILES} except `sprite` is chosen, and §3 and §7 item 10 say so. A test
 * that pinned the chosen numbers as though calibration had happened would be the Goodhart failure
 * this whole pipeline was rebuilt to avoid: it would turn the tables into targets.
 */

/* ------------------------------------------------------------------ *
 * Fixtures — shapes only, never measured
 * ------------------------------------------------------------------ */

/** A sprite of the given canvas, one opaque block per frame so nothing is blank. */
function spriteOf(width: number, height: number, frames: number): Sprite {
  const sprite = createSprite({
    width,
    height,
    frames,
    name: 'asset-class-fixture',
    layers: ['Base'],
    palette: createPalette('asset-class-fixture', ['#404040', '#808080']),
  });
  const layer = sprite.layers[0].id;
  for (let f = 0; f < frames; f++) {
    const cel = new PixelBuffer(width, height);
    // Frames differ from each other, so the sequence has real motion content: the class rule
    // keys on `motionApplicability`, and a hold would derive `sprite` on every canvas.
    const top = 4 + f;
    for (let y = top; y < Math.min(top + 4, height - 2); y++) {
      for (let x = 4; x < Math.min(4 + 8, width - 2); x++) {
        const i = cel.index(x, y);
        cel.data[i] = 0x40;
        cel.data[i + 3] = 255;
      }
    }
    sprite.frames[f].cels.set(layer, cel);
  }
  return sprite;
}

const icon = (): Sprite => spriteOf(32, 32, 1);
const walkCycle = (): Sprite => spriteOf(32, 32, 4);
const landscape = (): Sprite => spriteOf(256, 256, 1);
const animatedLandscape = (): Sprite => spriteOf(256, 256, 2);

/**
 * One synthetic reading per dimension, so a total is a function of the weights and nothing else.
 *
 * `motion` is 200 rather than something flattering, which puts three of the six below
 * `FLOOR_FAIL` and the report's verdict at `fail`. That is deliberate and harmless: this file is
 * about the arithmetic, and a `pass` here would mean the chosen scores had been picked to look
 * good, which is the thing the file is arguing against.
 */
const SYNTHETIC: Readonly<Record<QualityDimensionId, number>> = {
  silhouette: 800,
  value: 700,
  palette: 600,
  noise: 500,
  outline: 900,
  motion: 200,
};

function readings(): QualityDimensionRegistration[] {
  return QUALITY_DIMENSIONS.map((id) => ({
    id,
    analyze: () => ({ scoreQ: SYNTHETIC[id], verdict: `synthetic ${id}`, issues: [], unmeasured: {} }),
  }));
}

/** Every dimension measured at {@link SYNTHETIC}, with no applicability precondition. */
const ALL_DIMENSIONS = readings;

/* ------------------------------------------------------------------ *
 * 1 · The profiles themselves
 * ------------------------------------------------------------------ */

describe('every profile is a complete per-mille table summing to 1000', () => {
  it('has a weight for every dimension id, and nothing else', () => {
    for (const cls of QUALITY_ASSET_CLASSES) {
      expect(Object.keys(QUALITY_WEIGHT_PROFILES[cls].weights).sort(), cls).toEqual(
        [...QUALITY_DIMENSIONS].sort(),
      );
      expect(QUALITY_WEIGHT_PROFILES[cls].cls, cls).toBe(cls);
    }
  });

  it('sums to 1000 on each, so the denominator is a fixed point for every class', () => {
    // A profile that did not sum to 1000 would still divide correctly — the denominator is the
    // sum of what contributed — but the two classes would then not be comparable at all, and
    // §7 item 8 is a complaint about comparability.
    for (const cls of QUALITY_ASSET_CLASSES) {
      const total = QUALITY_DIMENSIONS.reduce((sum, id) => sum + weightsFor(cls)[id], 0);
      expect(total, cls).toBe(1000);
    }
  });

  it('uses per-mille integers, like every other number in the pipeline', () => {
    for (const cls of QUALITY_ASSET_CLASSES) {
      for (const id of QUALITY_DIMENSIONS) {
        const w = weightsFor(cls)[id];
        expect(Number.isInteger(w) && w >= 0 && w <= 1000, `${cls}.${id} is ${w}`).toBe(true);
      }
    }
  });

  it('keeps `sprite` as §5.1\'s table, so "nothing specified" means the old numbers', () => {
    expect(weightsFor('sprite')).toBe(DEFAULT_QUALITY_WEIGHTS);
    expect(QUALITY_WEIGHT_PROFILES.sprite.weights).toBe(DEFAULT_QUALITY_WEIGHTS);
  });

  it('gives `animation` and `scene` a table that differs from `sprite` in more than one row', () => {
    // A profile that moved one weight is indistinguishable from a bug in one number; a profile
    // that moves three is a different argument about what the class is for.
    for (const cls of ['animation', 'scene'] as const) {
      const moved = QUALITY_DIMENSIONS.filter((id) => weightsFor(cls)[id] !== DEFAULT_QUALITY_WEIGHTS[id]);
      expect(moved.length, `${cls} moves ${moved.join(',')}`).toBeGreaterThanOrEqual(3);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 2 · Which class applies, and which it does not
 * ------------------------------------------------------------------ */

describe('the derived class follows the frames and the canvas, and only those', () => {
  it('MUST FIRE: a 32x32 four-frame walk derives `animation`', () => {
    expect(deriveAssetClass(createQualityContext(walkCycle()))).toBe('animation');
  });

  it('MUST FIRE: a 256x256 still landscape derives `scene`', () => {
    expect(deriveAssetClass(createQualityContext(landscape()))).toBe('scene');
  });

  it('NEAR MISS on the other side of both gates: a 32x32 single-frame icon is `sprite`', () => {
    // Same canvas as the walk cycle, one frame instead of four. This is §7 item 8's actual claim
    // — "a 32x32 four-frame walk cycle and a 32x32 single-frame icon are the same area and are
    // different animals" — so the area rule alone cannot be what is being tested here.
    expect(deriveAssetClass(createQualityContext(icon()))).toBe('sprite');
  });

  it('NEAR MISS on the motion gate: a byte-identical hold does NOT become an animation', () => {
    // `motionApplicability` answers `no-motion-content` for identical frames, so a hold derives
    // `sprite` however many frames it has. Promoting a hold would be the aggregator's one
    // guarantee inverted: it refuses to run `motion` on a degenerate sequence precisely so no
    // one can score it as a perfect animation.
    const hold = spriteOf(32, 32, 3);
    const layer = hold.layers[0].id;
    for (let f = 1; f < hold.frames.length; f++) {
      hold.frames[f].cels.set(layer, (hold.frames[0].cels.get(layer) as PixelBuffer).clone());
    }
    expect(deriveAssetClass(createQualityContext(hold))).toBe('sprite');
  });

  it('the canvas gate is exactly the documented bound, on both sides of it', () => {
    // A 128x128 still is the last `sprite`: 16384 is the bound and the comparison is `>`, so the
    // bound itself is not over it. The 129x129 case is the first pixel past it.
    expect(SCENE_AREA_THRESHOLD).toBe(16384);
    expect(deriveAssetClass(createQualityContext(spriteOf(128, 128, 1)))).toBe('sprite');
    expect(deriveAssetClass(createQualityContext(spriteOf(129, 129, 1)))).toBe('scene');
  });

  it('motion is checked before area, so an animated landscape is `animation`, not `scene`', () => {
    // The precedence, stated as a test because it is the arguable half of the rule. §5.2 says
    // why: motion applicability is a fact about *this evaluation*, and a class that changed when
    // a caller passed `frames: [0]` instead of the loop would be a total that moves when nothing
    // about the artwork changed.
    expect(deriveAssetClass(createQualityContext(animatedLandscape()))).toBe('animation');
  });

  it('is deterministic — the same context derives the same class twice', () => {
    const context = createQualityContext(walkCycle());
    expect(deriveAssetClass(context)).toBe(deriveAssetClass(context));
  });
});

describe('an explicit class overrides the derived one, and says so', () => {
  it('MUST FIRE: a caller naming a class wins over the derived answer', () => {
    expect(resolveAssetClass(createQualityContext(icon()), 'animation')).toEqual({
      cls: 'animation',
      source: 'explicit',
    });
  });

  it('the derived answer is still available when nobody says otherwise', () => {
    expect(resolveAssetClass(createQualityContext(icon()), undefined)).toEqual({
      cls: 'sprite',
      source: 'derived',
    });
  });

  it('a caller naming the class the derivation agrees on is still `explicit`', () => {
    // The source records *who decided*, not whether they were right. Collapsing the two would
    // make "the caller was right" and "the aggregator was right" indistinguishable after the fact.
    expect(resolveAssetClass(createQualityContext(icon()), 'sprite').source).toBe('explicit');
  });

  it('rejects a class that is not one, rather than rounding it to the nearest', () => {
    expect(() => resolveAssetClass(createQualityContext(icon()), 'walk-cycle' as never)).toThrow(
      /Unknown asset class 'walk-cycle'/,
    );
  });
});

/* ------------------------------------------------------------------ *
 * 3 · The profiles change the total, and only the total
 * ------------------------------------------------------------------ */

describe('the same six readings under three classes give three different totals', () => {
  /** `evaluate` over one context with synthetic readings, returning the serialised total. */
  const totalUnder = (
    sprite: Sprite,
    assetClass?: QualityAssetClass,
  ): { score: number; assetClass: string } => {
    const report = evaluate(createQualityContext(sprite), ALL_DIMENSIONS(), { assetClass });
    return { score: report.score, assetClass: report.assetClass.cls };
  };

  it('MUST FIRE: identical readings, three profiles, three totals', () => {
    // The arithmetic, by hand, so a reader can check the table rather than trust it:
    //   sprite    (300+260+140+120+100+80 = 1000)
    //     300*800 + 260*700 + 140*600 + 120*500 + 100*900 + 80*200 = 672000 -> 672
    //   animation (280+230+120+100+80+190 = 1000)
    //     280*800 + 230*700 + 120*600 + 100*500 + 80*900 + 190*200 = 617000 -> 617
    //   scene     (200+320+220+140+60+60 = 1000)
    //     200*800 + 320*700 + 220*600 + 140*500 + 60*900 + 60*200 = 652000 -> 652
    expect(totalUnder(icon()).score).toBeCloseTo(0.672, 10);
    expect(totalUnder(walkCycle()).score).toBeCloseTo(0.617, 10);
    expect(totalUnder(landscape()).score).toBeCloseTo(0.652, 10);
  });

  it('the class each of those came from is the one the derivation claims', () => {
    expect(totalUnder(icon()).assetClass).toBe('sprite');
    expect(totalUnder(walkCycle()).assetClass).toBe('animation');
    expect(totalUnder(landscape()).assetClass).toBe('scene');
  });

  it('naming a class changes the total of the very same context', () => {
    // The override is load-bearing rather than decorative: without this, a caller who knows their
    // asset is an animation and says so would get the same number back.
    const context = createQualityContext(walkCycle());
    const sprite = evaluate(context, ALL_DIMENSIONS(), { assetClass: 'sprite' });
    const scene = evaluate(context, ALL_DIMENSIONS(), { assetClass: 'scene' });
    expect(sprite.score).toBeCloseTo(0.672, 10);
    expect(scene.score).toBeCloseTo(0.652, 10);
    expect(sprite.assetClass).toEqual({ cls: 'sprite', source: 'explicit' });
    expect(scene.assetClass).toEqual({ cls: 'scene', source: 'explicit' });
  });

  it('the per-dimension readings are identical across the three — only the weighting moved', () => {
    // Otherwise "three different totals" could just mean three different measurements, and the
    // profile would not be what is under test.
    const readingsOf = (cls: 'sprite' | 'animation' | 'scene'): Record<string, number> => {
      const report = evaluate(createQualityContext(walkCycle()), ALL_DIMENSIONS(), { assetClass: cls });
      return Object.fromEntries(
        QUALITY_DIMENSIONS.map((id) => [id, report.dimensions[id]!.scoreQ]),
      );
    };
    expect(readingsOf('animation')).toEqual(readingsOf('scene'));
    expect(readingsOf('animation')).toEqual(readingsOf('sprite'));
  });
});

/* ------------------------------------------------------------------ *
 * 4 · The backward-compatibility guarantee
 * ------------------------------------------------------------------ */

describe('with nothing specified, the numbers are exactly the ones that existed before', () => {
  it('the derived-sprite total equals §5.1\'s table read by the pre-profile call', () => {
    // THE assertion. `weightedTotalQ(dimensions)` with one argument is the arithmetic as it stood
    // before profiles existed, and `evaluate` with no `assetClass` must land on it. If this fails,
    // every committed baseline in the repository moved and nothing in the product asked it to.
    const report = evaluate(createQualityContext(icon()), ALL_DIMENSIONS());
    expect(report.assetClass).toEqual({ cls: 'sprite', source: 'derived' });
    expect(report.score).toBeCloseTo(weightedTotalQ(report.dimensions) / 1000, 10);
  });

  it('and that is 672 on the readings above, spelled out rather than compared to itself', () => {
    expect(evaluate(createQualityContext(icon()), ALL_DIMENSIONS()).score).toBeCloseTo(0.672, 10);
  });

  it('a still sprite keeps the 920 denominator and is not renormalised', () => {
    // §5.2's still case, through the profile machinery: dropping `motion` from the active set is
    // the only thing that changes the denominator, and a profile does not change it twice.
    const still: Partial<Record<QualityDimensionId, QualityDimension>> = {};
    for (const id of QUALITY_DIMENSIONS) {
      if (id === 'motion') continue;
      still[id] = { scoreQ: 880, verdict: '', issues: [], unmeasured: {} };
    }
    const denominator = QUALITY_DIMENSIONS.filter((id) => id !== 'motion').reduce(
      (sum, id) => sum + DEFAULT_QUALITY_WEIGHTS[id],
      0,
    );
    expect(denominator).toBe(920);
    expect(weightedTotalQ(still)).toBe(880);
  });

  it('an empty active set still totals 0, which is `fail` and not a perfect score', () => {
    // The fail-closed branch has to survive the profile change, in every class.
    for (const cls of QUALITY_ASSET_CLASSES) {
      expect(weightedTotalQ({}, weightsFor(cls)), cls).toBe(0);
    }
  });

  it('the real pipeline on a real sprite is unchanged, and says which class it used', () => {
    // One run through the actual registry, not the synthetic one: this is the shape a caller
    // sees, and it is the run whose numbers the committed baselines hold.
    const report = evaluate(createQualityContext(icon()));
    expect(report.assetClass).toEqual({ cls: 'sprite', source: 'derived' });
    expect(report.score).toBeCloseTo(weightedTotalQ(report.dimensions, DEFAULT_QUALITY_WEIGHTS) / 1000, 10);
    // No assertion on the verdict: it is a function of this fixture's readings, and pinning it
    // would be asserting the fixture rather than the profile. The point of this case is the
    // equality on the line above, on the one run whose shape a caller actually sees.
  });
});

/* ------------------------------------------------------------------ *
 * 5 · The report says which class produced it
 * ------------------------------------------------------------------ */

describe('a reader can tell which profile produced a score', () => {
  it('the report carries the class and its source', () => {
    const report = evaluate(createQualityContext(walkCycle()));
    expect(report.assetClass).toEqual({ cls: 'animation', source: 'derived' });
  });

  it('the command publishes it beside the score, so a caller need not walk into the report', () => {
    // Asserted through the command boundary, because a field on the aggregator's type is not the
    // same as a field a caller can see: `evaluate`'s projection is a second place for the two to
    // disagree, and §3.6's report shape is what the wire carries.
    const sprite = walkCycle();
    const editor = createEditor(sprite);
    const derived = editor.execute('evaluate') as { assetClass: { cls: string; source: string } };
    expect(derived.assetClass).toEqual({ cls: 'animation', source: 'derived' });

    const explicit = editor.execute('evaluate', { assetClass: 'sprite' }) as {
      assetClass: { cls: string; source: string };
      score: number;
    };
    expect(explicit.assetClass).toEqual({ cls: 'sprite', source: 'explicit' });
    expect(explicit.score).not.toBe((derived as unknown as { score: number }).score);
  });

  it('the gate refuses against the same profile the report was scored under', () => {
    // The failure this closes is narrow and real: `qualityGate` re-derives §5.2's total from the
    // report, and if it re-derived the *class* too then a caller who said `assetClass: "animation"`
    // to `evaluate` would be refused against a `sprite` total. The gate reads the class off the
    // report instead, so the two cannot be spelled differently.
    const sprite = walkCycle();
    const editor = createEditor(sprite);
    const spriteClass = editor.execute('evaluate', { assetClass: 'sprite' }) as {
      score: number;
      verdict: string;
    };
    const gate = qualityGateForSprite(sprite, { assetClass: 'sprite', threshold: 'warn' });
    expect(gate.report.assetClass).toEqual({ cls: 'sprite', source: 'explicit' });
    expect(gate.report.score).toBe(spriteClass.score);
    expect(gate.decision.verdict).toBe(spriteClass.verdict);
    expect(gate.decision.passed).toBe(gate.report.verdict !== 'fail');
  });

  it('the class survives as data rather than as a sentence, so an agent can branch on it', () => {
    // Deliberately not prose: `QUALITY_ASSET_CLASSES` is the closed vocabulary, and a caller that
    // has to pattern-match a message to find out how it was weighted is back to guessing.
    const cls = evaluate(createQualityContext(landscape())).assetClass.cls;
    expect(QUALITY_ASSET_CLASSES).toContain(cls);
    expect(QUALITY_WEIGHT_PROFILES[cls].cls).toBe(cls);
  });
});