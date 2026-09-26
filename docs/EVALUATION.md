# Pixel-art quality evaluation — the scoring specification

> This document is the contract for `evaluate`. It is written for two readers at once: an
> engineer implementing one of the six analyzers, who needs to know exactly what to measure
> and how to band it, and a human pixel artist rating the benchmark corpus, who needs to know
> what each dimension means and how to judge it by eye. Either should be able to do their job
> from this file alone.
>
> **Second amendment.** The formulas were implemented against real artwork and measured, and
> four of them were found to be measuring something other than what they claimed. The largest
> of those: `value` could not tell a hard straight-diagonal shadow band from correctly nested
> contours, and the whole report total moved **0.014** between them. §4.2 now carries a
> form-conformance term, and §6.2 is the new "measure your formulas against a designed
> contrast before believing them" step, because a human rating corpus would not have caught
> any of the four. Changed since the first amendment: §3.1 now describes the frozen
> `QualityContext` rather than an input contract that never existed; §3.3 and §3.7 carry the
> new shared quantities; §4.1, §4.2, §4.4, §4.5 and §4.6 are revised; §5.3 is now a table of
> per-mille constants matching `types.ts`. **§5.1's weight table is unchanged and is parsed by
> a test — do not reformat it.**
>
> Implementation lives in `packages/core/src/quality/` and the type contract is fixed in
> `packages/core/src/quality/types.ts`. Where this document and that file disagree, that file
> is the wire format and this document is the intent — raise it, do not pick one silently.

## 1. Purpose and scope

A game asset is not an image. It is a constrained, quantised, grid-exact object with a
technical contract: it has a size, a palette, a frame count, a hitbox, an export path, and a
runtime that will scale it, tint it, and read it one pixel at a time. **dotloom-mcp is that
pipeline, not an image generator** (decision D-5), and every part of it is ranked by whether
it helps an asset survive contact with a game.

The gap this quality layer fills is judgement. Agents can draw — they have ~90 exact drawing
commands, a preview PNG they can look at, and a text grid they can count — but they cannot
tell whether the result is good. They shade without deciding where the light is, leave two
floating specks next to the head, drift off the declared palette, and never notice, because
nothing tells them. D-6 closed the door on more drawing commands for exactly this reason: the
bottleneck is not the tool, it is the judgement. This layer is that judgement, written down
as a deterministic heuristic.

What it is:

- **A rubric, not an oracle.** Every number here is chosen to be checkable, explainable and
  arguable. `silhouette: 0.55` with `"2 detached pieces, 2 interior holes, thin outline
  profile"` is a claim a person can agree or disagree with. `quality: 0.7341` is not.
- **Calibrated, not derived.** The thresholds come from how pixel artists talk about craft
  and are then checked against human ratings of a benchmark corpus (§6). Where the two
  disagree, the human wins and the threshold moves.
- **Advisory by default.** The scores are there to make an agent stop and look at a specific
  pixel, not to certify a masterpiece. A `pass` means "no mechanical defect was found", which
  is a much weaker statement than "this is good".

What it is not:

- Not a substitute for looking. `evaluate` finds the two detached specks; it cannot tell you
  whether the character is appealing. The split with `get_preview` is the same one the rest
  of the tool surface makes: **text verifies, pictures approve.**
- Not a style judge. It encodes a defensible house style (top-left key light, 4-connected
  silhouettes, 1px outlines, small palettes) and it will happily mark good work from another
  tradition as mediocre. §7 lists every such convention by name.
- Not content-aware. Nothing here knows what a mushroom is.

The honest summary: this catches the class of mistakes that are invisible in a thumbnail and
ruinous in a shipped asset, and it is blind to taste. That is a real and worthwhile class,
and it is not the whole job.

## 2. How to use it

`evaluate` returns a `QualityReport`: a `score` in 0..1, a `verdict` of `pass` / `warn` /
`fail`, one entry per applicable dimension, and a `blocking` list of the issues that
mattered. The shape is fixed in `types.ts` (AD-2); §5 covers how the parts combine.

### 2.1 Three audiences, three tolerances

| Audience | What they are doing | What they should do with the score | Tolerance |
| --- | --- | --- | --- |
| **Agent, mid-draw** | Iterating on a sprite, usually 3-10 batches deep. | Treat anything below `0.85` as "stop and look", not "stop and panic". Read the `issues` array, fix the top `severity` one, re-run. Expect the first pass on a new sprite to score 0.4-0.6 — that is the silhouette pass, not a failure. | **Loose on the verdict, strict on attention.** Looking at a 0.84 costs one `get_preview`; blocking a 0.84 in CI costs a delivery. Hence the two different numbers, and they are not a contradiction. The score is a to-do list, not a gate. |
| **Human, reviewing** | Deciding whether a piece is shippable, and calibrating the benchmark corpus. | Read the per-dimension scores against the bands in §4 and judge the dimension by eye. The scorer is a second opinion that never gets tired, and it is wrong in documented ways (§7). | **Medium.** A `fail` means "there is a named mechanical defect" — that is worth trusting. A `pass` means "nothing mechanical found", which is not an endorsement. |
| **CI / `verify` gate** | Blocking `finalize_document` on a sub-threshold asset. | Gate on `verdict`, not on the number, and keep the gate at `warn` unless a team has run the calibration on its own assets. | **Strict, but only where calibrated.** A gate nobody has measured is a gate that blocks good work. |

### 2.2 Threshold summary

```
verdict = fail   if any blocking issue exists,
                 or any PRESENT dimension is below its FLOOR_FAIL (§5.3),
                 or the total is below 0.55
         = warn  if the total is below 0.80, or any PRESENT dimension is below 0.60
         = pass  otherwise
```

`blocking` is the load-bearing part: a `pass` with a blocking issue in it is not possible, so
a hard defect cannot be averaged away by good work elsewhere. The per-dimension floor is the
other: a 0.86 total with a `silhouette` of 0.30 is a `fail`, because a weighted mean should
not be allowed to hide a broken shape. Every constant in the rule is per-mille (`550`, not
`0.55`) and is exported from `types.ts`; §5.3 has the table.

## 3. The shared measurement contract

Every dimension is a pure function of the document plus a small, explicit input. None of them
writes anything; none of them is a command; none of them has undo semantics. They are
`readOnly` in the same sense `measure_region` is.

### 3.1 Input

An analyzer's entire input is a `QualityContext` from `packages/core/src/quality/types.ts`.
That type is frozen and this specification may not invent a field on it, so the table below
is a description of the contract, not a wish list. If a measurement below needs something
that is not here, the answer is a new dimension, not a new parameter.

| Field | Type | What it is, and what it means for measurement |
| --- | --- | --- |
| `frameIds` | `readonly FrameId[]` | The frames to judge, **in playback order** — the order the viewer sees. A still sprite is a one-element list; a tagged loop is the tag's frames in the tag's direction. |
| `composite` | `readonly QualityCel[]` | The same frames, already flattened, index-aligned with `frameIds`, each `width` x `height`. **Every pixel measurement in this document reads this and nothing else.** |
| `focus` | `Rect \| null` | The region to judge, or `null` for the whole canvas. A **scope, not a crop**: nothing is clipped, and evidence just outside the box still counts. |
| `sprite` | `QualitySprite` | Structure only: ids, names, layer order, frame durations, tags, and whether tags exist. Not a pixel source. |
| `palette` | `QualityPalette` | The swatches, hoisted so `palette` does not walk the document. |
| `width`, `height` | `number` | Canvas size, denormalised so all six passes see the same numbers. |

Three consequences worth stating outright, because each one has already cost somebody a
misunderstanding:

**Target selection is upstream.** There is no `frame` or `tag` parameter here. The aggregator
resolved the target and handed over a list in playback order, so `motion` never has to know
what a tag is in order to measure the seam between the last frame and the first — and a
pingpong loop is measured as it plays rather than in document order. A caller that wants a
different target builds a different context.

**Layer selection is upstream too.** `composite` is built with `compositeFrame`, which
already resolves layer order, opacity, blend mode and visibility. There is no `layers` and no
`scope` parameter, and there is no way for a dimension to see an un-composited cel. That is
deliberate and it is a rule an analyzer must not route around: six dimensions that each
flattened the layers their own way would disagree about what the artwork even is, which is
worse than any individual scoring error because the aggregate would then be arithmetically
sound and semantically meaningless.

**Alpha is a constant, not a parameter.** The contract has nowhere to put a threshold, and
adding one would mean every caller could ask for a different silhouette. So:

```
ALPHA_SOLID = 128        // alpha at or above this counts as solid
```

Every dimension uses `ALPHA_SOLID`. 128 is a deliberate difference from the drawing commands,
which default to 1: a 0.2-alpha glow is a design decision, not a body part, and letting it
into the silhouette would make `outline` trace a halo as a hard contour — the exact failure
the `outline` command's own `alphaThreshold` exists to prevent. Pixels with
`1 <= alpha < ALPHA_SOLID` are counted as `partialAlpha` and named in the verdict text of
whichever dimension looked at them. They are never scored, and they are never in `N`.

One consequence to write down now, because it is the single most likely source of a
disagreement between two analyzers: **a translucent layer composites to colours that are in
no palette.** `paletteLocked: true` with opaque layers, or `quantize_to_palette` before
evaluating, is the fix, and §7 item 3 explains why the scorer does not paper over it instead.

### 3.2 Determinism

`evaluate` runs in CI diffs, in a regression gate, and in a script that has to produce the same
bytes twice. Four rules make that true, and all four are load-bearing:

1. **No randomness, no clock.** No `Math.random`, no `Date.now`, no timing source. The only way
   to guarantee that two runs agree is to have no entropy source at all.
2. **No ratio is ever compared as a float.** Every threshold test is integer:
   `a * 100 >= p * b`, never `a / b >= p / 100`. Two platforms cannot disagree on the last
   bit of a division they never perform.
3. **Every score is a per-mille integer.** Sub-scores, band constants and weights are
   integers in 0..1000. A weighted mean is
   `Math.floor((Σ wᵢ·sᵢ + denominator / 2) / denominator)` — round-half-up, one division, and
   every intermediate stays far below 2^53, where integer arithmetic on a double is exact by
   definition. The only float in the whole pipeline is `scoreQ / 1000` at serialisation.
4. **Iteration order is explicit, never incidental.** Any collection whose order can reach the
   output is sorted by a stated key first. `Map` and `Set` insertion order is deterministic but
   it encodes the order the code happened to walk the canvas in, so an unrelated refactor
   silently changes a score. Sorting by `packColor`, or by `(y, x)`, makes the output
   independent of traversal.

### 3.3 Common quantities

Defined once, used by every dimension. All of them are integer counts over `composite`,
restricted to `focus` when it is set. The contract's own warning applies to this table more
than to anything else in the document: *two dimensions measuring the same thing two different
ways is the likeliest way for this pipeline to produce a confident wrong answer.* Where a
name appears here, no dimension may define its own version of it.

| Name | Definition |
| --- | --- |
| `W`, `H` | `width`, `height` (whole canvas, not the region). |
| `S` | `W * H`. |
| `N` | Solid pixels (`alpha >= ALPHA_SOLID`). |
| `bounds` | Tight bounding box of the solid pixels. |
| `fill` | `N / (bounds.w * bounds.h)`. |
| `n4(p)`, `n8(p)` | Number of solid 4- and 8-neighbours of `p`. |
| `components` | Connected components of the solid mask under **4-connectivity**. |
| `edgePixel(p)` | `p` is solid and at least one of its 4 orthogonal neighbours is transparent or outside the canvas. |
| `edgePixels` | Count of `edgePixel` pixels. **A count of pixels, not a length.** |
| `perimeter` | Count of 4-adjacent (solid, transparent) pixel **pairs**. **A length.** |
| `dist(p)` | For a solid `p`, the Chebyshev distance to the nearest non-solid pixel or to the canvas edge. `0` on an `edgePixel`. |
| `Dmax` | `max` of `dist` over all solid pixels — the subject's half-thickness. |
| `convexCorner(p)` | `p` is solid, exactly 2 of its 4 orthogonal neighbours are solid, those 2 are **adjacent** (one horizontal, one vertical), and the diagonal pixel between them is transparent. |
| `toneEdge(p)` | `p` is solid and at least one solid 4-neighbour `n` has a different `LqBucket` (§3.4). |
| `ditherMask` | Per-pixel flag: `p` is in a region of high-frequency alternation between two adjacent tone buckets. See below. |

4-connectivity is a deliberate choice, not an oversight. A shape whose parts touch only at a
corner is two shapes in a game: at 0.5× scale, with a filter, or on a CRT, the diagonal
contact disappears and the sprite falls in half. `diagOnly` (§4.4) measures exactly this.

`rhu(a, b) = Math.floor((a + b/2) / b)` — round-half-up integer division, used by every ratio
in this document.

#### `edgePixels` and `perimeter` are two different quantities, on purpose

They look interchangeable and are not, and the first version of this document conflated them,
which produced a real bug (§4.1). An **outline** covers pixels: it is drawn on the outermost
ring, so counting pixels is the right measure and counting boundary length would
double-count the corners. A **shape's compactness** is a length ratio, and it needs the
perimeter of the union of unit squares, which is the transition count.

`perimeter` is exactly that: sum over solid pixels of their transparent 4-neighbour count.
It is the true boundary length of the pixel set, which is why the isoperimetric quotient in
§4.1 is bounded above by 1 by construction instead of by luck.

#### `dist` and `Dmax`

`dist` is a multi-source BFS over the solid mask from every `edgePixel`, 4-connected, with
`+1` per step — one pass, `O(N)`, integer, and the same field in the same direction for the
whole sprite. It is the discrete distance-to-boundary, and **three** dimensions now need it:
`value` uses `Dmax` to normalise a plane's depth spread (§4.2), `outline` uses `dist` as its
contour thickness (§4.5), and `noise` uses `Dmax` to recognise a deliberately thin sprite
(§4.4). They share one implementation. Three BFS runs that agree are a fact; three that
disagree by one pixel are a bug report nobody can reproduce.

`Dmax` doubles as the sprite's own scale, and it is why several ratios below are normalised
against it rather than against a constant: a 3px-wide blade and a 30px-wide cloak do not have
the same room to put a curved terminator in, and a measurement that ignores that punishes the
blade for being narrow.

#### `ditherMask`

Dither is *periodic alternation between two adjacent ramp steps over an area*, and that is
the whole definition. A first attempt at this table specified one exact lattice signature —
four orthogonal neighbours transparent, four diagonals solid — which is a perfect axis-aligned
50% checkerboard and nothing else. Measured against a real sprite with three visible
`bayer4` seams, it returned `ditherShare` **0.0000**: on a diagonal terminator or an arc the
lattice and the boundary fight and the perfect checkerboard never appears. The check was
blind to exactly the dither an agent produces.

So the predicate is about the *alternation*, not the *lattice*:

```
candidates = the 15 bucket pairs (k, k+1) for k = 0..14 where both buckets are occupied
for each candidate pair (a, b):
    R = the 4-connected component of { p solid : LqBucket(p) in {a, b} } containing p
    (computed per component, not per pair — one flood fill per component of the union set)
    R counts as a DITHER REGION when:
        |R| >= 8
        and >= 400/1000 of R's pixels have at least one 8-neighbour in R of the OTHER bucket
    ditherMask = 1 for every pixel of every dither region
ditherShare  = (pixels with ditherMask == 1) / N
```

Three properties make this work, and each one is a deliberate rejection of something simpler:

- **Orientation-free.** A 50% checker, a `bayer4` field, a `sparse` field and a hand-drawn
  2px cluster pattern all satisfy it, on an axis or on an arc. Nothing in the predicate knows
  what a Bayer matrix is.
- **Scale-free.** It counts the *bucket pair*, so `cluster2` at the same coverage is detected
  exactly like a 1px pattern at the same coverage. It cannot tell them apart, and §4.4 says
  what follows from that.
- **The alternation clause is what excludes a material edge.** Without it, a gold-to-green
  boundary is a connected set of two adjacent buckets and would be counted. With it, the
  interior of the gold field has no other-bucket 8-neighbour, the gold/green component fails
  the 400/1000 test, and a coherent edge is not dither. This is the single clause doing all
  the discrimination, and it is the reason the threshold is a *fraction of the region* rather
  than a neighbourhood test applied per pixel.

The candidate-pair restriction keeps it cheap: at most 15 bucket pairs, and the "both buckets
occupied" pre-check drops the ones a given sprite does not use, so a six-tone sprite does
five flood fills rather than fifteen. `|R| >= 8` keeps a single stray pixel from being its
own dither region.

**What this opens up.** A 2px checkerboard is a legitimate technique at 32×32 and above — it
reads as a soft tonal step rather than as digital stipple, which is exactly why the craft
guide recommends `cluster2`/`cluster4` on large canvases. The predicate cannot tell a
*legitimate* 2px cluster from a *mistaken* 1px stipple, so both are detected and both are
excluded from the noise measures. The only cost is that a sprite whose texture is mostly
alternation trips the `dither-dominant` advisory (§4.4), which is an advisory rather than a
score penalty precisely because this false positive is unavoidable. Treating visible grain as
defect is the failure the whole dimension has to avoid, and `despeckle`'s own
`minClusterSize` option exists for the same reason.

### 3.4 Luminance

One luminance, used by `value`, `outline` and `motion`:

```
Lq(c) = (54 * r + 183 * g + 18 * b) >> 8        // integer, 0..255
```

That is Rec. 709 (0.2126 / 0.7152 / 0.0722) rounded to 8-bit fixed point, and it agrees with
`luminanceOf()` in `packages/core/src/grid.ts` to within 1/255. The float version is fine for
drawing a character grid; for a score that CI diffs byte-for-byte, an integer is worth the
one-line duplication. `LqBucket(p) = Lq(p) >> 4` gives 16 buckets of width 16, which is what
`value` counts tones in.

Hue, saturation and value, for `palette`:

```
maxc = max(r,g,b);  minc = min(r,g,b);  v255 = maxc
s255 = maxc == 0 ? 0 : ((maxc - minc) * 255) / maxc        // integer division, 0..255
h360 = the standard 6-sector hue in degrees, 0..359
```

Test saturation in integer form: "saturated enough to count as a hue family" is
`(maxc - minc) * 100 >= 12 * maxc`, i.e. `s255 >= 12`.

### 3.5 Issue shape and severity

Per AD-2, every issue is `{ code, message, rect, severity }`:

- `code` — stable, kebab-case, machine-readable. **This is the API.** Agents branch on it
  (`fix` in T-023 maps codes to op templates). Never renamed, never repurposed; see §8.
- `message` — one sentence a human can act on. Not a contract. Parse `code`, not prose.
- `rect` — the region to fix, `{x, y, w, h}` in canvas coordinates, or `null` when the
  problem is document-wide and cannot be usefully localised.
- `severity` — 0..1. **`>= 0.5` is blocking**, and a blocking issue guarantees
  `verdict !== 'pass'`.

Severity is not free-form. Each code in this document has a fixed severity, given in its
table. The severity is the code's *stated* severity, not a per-sprite measurement: severity
answers "how bad is this class of mistake", and the score and the issue count answer "how
bad is it here". A sprite with one 0.8 and one 0.5 blocking issue is no worse than one with
a single 0.8, and the two of them are not the same fix.

Every dimension follows the same internal shape, so the six analyzers stay parallel:

```
1. Measure the quantities named in "How it is measured" (integers only).
2. Pick a base from a band table, keyed on one primary ratio.
3. Apply each adjustment whose condition holds, at most once each.
4. Clamp the adjustment total to [-450, +50] per-mille, then add to the base.
5. Clamp the result to [0, 1000].
6. Emit an issue for every condition that fired, at its fixed severity.
```

The adjustment clamp exists so a band stays legible. A base of 0.90 means "this ratio is
fine", and no pile of minor problems should be able to drag a dimension that measured well
down into the failing range.

**Units, because this is where they bite.** The field on `QualityDimension` is `scoreQ`: a
**per-mille integer, 0..1000**, higher is better. Not 0.94 — `940`. The band constants and
adjustments in §4 are already per-mille integers, so an analyzer's last act is to return the
number its own arithmetic produced and *not divide on the way out*. The single 0..1 float in
the whole pipeline is `unitScore(scoreQ)` on the report's `score` field, and confusing the
two is a failure that reads as catastrophic rather than as a near-perfect result, which is
the safe direction but still a bug. The `Q` suffix is load-bearing in this document for the
same reason the contract says it is.

### 3.6 The report shape

`types.ts` is frozen and this document follows it. The shape is:

```ts
interface QualityDimension { scoreQ: number; verdict: string; issues: readonly QualityIssue[] }
interface QualityReport {
  dimensions: Readonly<Partial<Record<QualityDimensionId, QualityDimension>>>;
  excluded:   Readonly<Partial<Record<QualityDimensionId, ExcludedReason>>>;
  score: number;                       // 0..1 float, via unitScore(totalQ)
  verdict: 'pass' | 'warn' | 'fail';
  blocking: readonly QualityIssue[];
}
```

Two properties of that shape are the reason this section exists, and an implementation that
misses either will produce a report that is arithmetically correct and semantically broken.

**`dimensions` is partial, and absence is the signal.** A key may be absent, meaning *not
applicable* — never a sentinel score, and in particular never `0`, because a `0.0` is silently
averaged in by every caller that trusted the field while a missing key cannot be. Presence of
the key is the normative applicability test.

**`excluded` is required, not optional, and it is mandatory for a reason that reads
backwards.** An earlier draft of this document made it optional on the grounds that "absence
is already the signal". That is exactly wrong: if the map may be omitted, "scored zero" and
"never measured" collapse back into each other and the partial record buys nothing. So the
contract requires it — an empty object is a valid value — and imposes the invariant the types
cannot express:

> **The keys of `excluded` are exactly the keys missing from `dimensions`, and no id appears
> in both.**

Every dimension id is therefore accounted for exactly once: measured, or excluded with a
reason. The aggregator owns this; `reportInvariantViolations` checks it. An id in neither map
is the silent hole — a dimension that was never run and never explained, which is the failure
mode a partial record was supposed to eliminate.

`ExcludedReason` is a closed enum of two values, and both have producers (§4.6):
`'single-frame'` and `'no-motion-content'`. An agent can therefore tell "this sprite has no
animation, so motion does not apply" from "the motion analyzer crashed and left a hole"
without pattern-matching prose. §4.6 specifies the detection for each.

### 3.7 Every ratio, in integer form

Rule 2 above means no threshold in §4 is ever evaluated as a float. This is the complete list,
so there is nothing left to guess. `rhu(a, b) = Math.floor((a + b/2) / b)` throughout, and
`A/1000` in a threshold means the test `A_numerator * 1000 >= A * A_denominator`.

| Quantity | Threshold as written in §4 | The test that implements it |
| --- | --- | --- |
| `share` | `>= 90/100` | `largest * 100 >= 90 * N` |
| `compactnessQ` | `< 300` | `Q = min(1000, rhu(4 * 355 * 1000 * N, 113 * perimeter * perimeter))` (π as 355/113) |
| `span` | `< 0.25` | `bounds.w * 4 < W \|\| bounds.h * 4 < H` |
| `hueOnlyRatio` | `> 25/100` | `hueOnlyEdges * 100 > 25 * internalEdges` |
| `dominantShare` | `>= 92/100` | `bucketMax * 100 >= 92 * N` |
| `shadowShare` | `>= 30/100` | `shadowCount * 100 >= 30 * N` |
| `highlightShare` | `>= 10/100` | `highlightCount * 100 >= 10 * N` |
| `spanQ` (plane depth spread) | `> 750` | `Q = rhu((dmax - d0) * 1000, Dmax + 1)`, then `Q > 750` |
| `cornerDensity` | `>= 250/1000` | `corners * 1000 >= 250 * edgePixelsNearby` |
| `offPaletteRatio` | `<= 20/100` | `offPalette * 100 <= 20 * N` |
| `muddyRatio` | `>= 5/100` | `muddyCount * 100 >= 5 * N` |
| `meanSat` | `< 15/100` | `sumS255 * 100 < 15 * N` |
| noise ratios | `> 8/1000` | `count * 1000 > 8 * N` |
| dither alternation | `>= 400/1000` | `alternating * 1000 >= 400 * \|R\|` |
| `outlineShare` | `>= 80/100` | `inkCount * 100 >= 80 * edgePixels` |
| `outlineCoverage` | `>= 45/100` | `inkCount * 100 >= 45 * N` |
| `inkGaps` | `>= 5/100` | `gaps * 100 >= 5 * edgePixels` |
| `seamRatio` | `<= 1.35` | `seam * 20 <= 27 * churnMedian` |
| `areaSpread` | `> 150/1000` | `Q = rhu((maxArea - minArea) * 1000, meanArea)`, then `Q > 150` |
| `deltaSpread` | `>= 0.6` | `Q = rhu((maxLum - minLum) * 1000, maxLum)`, then `Q >= 600` |
| `seamStep` | `> 1.5 * maxStep` | `seamStep * 2 > 3 * maxStep` |
| `churnMax` | `> 2 * churnMedian` | already integer |

Four of these are worth a sentence.

`compactnessQ` uses the **transition perimeter** (§3.3), not `edgePixels`, and the `min(1000,
…)` is belt-and-braces rather than load-bearing: the transition count is the true boundary
length of the pixel set, so the isoperimetric inequality bounds the quotient at 1 for any
digital shape. The clamp stays because a clamp that is unnecessary today and documented as
such is worth more than one that is absent until the day it is needed.

`spanQ` and `cornerDensity` are the two new ratios from the form-conformance term (§4.2), and
both are bounded by construction — `spanQ` by its `Dmax + 1` denominator, which is the
subject's own half-thickness.

`areaSpread`'s denominator is `meanArea`, a rational number; compute it as
`rhu(sumArea, n)` once rather than dividing per frame, so the whole quantity is integer from
the first comparison onward.

## 4. The six dimensions

Ordered cheapest-and-most-reliable first. `silhouette` and `value` are where a sprite is won
or lost; `palette` and `noise` are hygiene; `outline` is a style choice with a real cost when
it is wrong; `motion` applies to animations only.

### 4.1 `silhouette` — does the shape read?

**What it is.** Whether the subject reads as one shape against the background when you look
at it at 100% and squint. In pixel-art terms: one dominant mass, no holes punched in the
wrong places, no piece floating next to it that is not part of the subject, and a profile
that is compact enough to be a form rather than a smear. This is the dimension that decides
whether the sprite is a character or a smudge, and it is the one that survives every
downscale the game will apply to it.

**Why it matters.** A game asset is read at small sizes, often smaller than its native
canvas. Silhouette is the only thing that survives that: colour and detail are the first
things to vanish, so if the shape does not read on its own, nothing else gets a chance. A
sprite with a hole in its chest looks like it has a hole in its chest at every zoom level, in
every lighting condition, on every background. A detached 2px piece next to the head reads
as a second, broken head. This is also the failure that is *invisible in a preview*: at 8×
zoom a floating speck looks like a highlight, and nobody notices until the sprite is in
motion at 64×48.

**How it is measured.**

```
N              solid pixels
components     4-connected components of the solid mask
largest        size of the biggest component
share          largest / N                      <- primary ratio
strayCount     components - 1
strayRatio     (N - largest) / N
bounds         tight opaque bounding box
borderTouch    how many of the 4 canvas sides the solid mask reaches (0..4)
perimeter      4-adjacent (solid, transparent) PAIRS  (NOT edgePixels — see below)
compactnessQ   min(1000, rhu(4 * 355 * 1000 * N, 113 * perimeter * perimeter))
holes          4-connected components of the transparent mask that do NOT touch the canvas
               border; the background is 8-connected so a diagonal leak is not a hole
holeRatio      (sum of hole areas) / N
span           min(bounds.w / W, bounds.h / H)
```

Every ratio here is compared in integer form; §3.7 has the exact test for each.

#### `perimeter`, and why the first version of this test was broken

This term was originally written as a count of *edge pixels* and banded `< 300`. Measured
against a real sprite it returned **1188** and **1210** on two different frames — a quantity
presented as a per-mille ratio of 0..1 that was quietly 20% over its own maximum. Harmless
against a band table with no upper edge, and a trap the moment anyone tightens one.

The real problem was worse than an unbounded number. Counting edge *pixels* is not a
perimeter: a skeletal shape has few of them. A 5-pixel plus sign has 4 edge pixels, so
`4πN/P²` = 3.9 — the most compact shape imaginable scored 3.9, and a *thin* shape was being
rewarded for its own defect. The `thin-profile` penalty could not fire on precisely the shapes
it exists to catch.

`perimeter` counts solid→transparent **transitions** instead, which is the true boundary
length of the union of unit squares. With that denominator the isoperimetric inequality
bounds the quotient at 1 for every digital shape, holes included (an interior hole only adds
boundary), so `compactnessQ` is now bounded by construction rather than by luck. The
`min(1000, …)` is kept anyway and documented as the belt-and-braces it is.

Hole connectivity is the classic subtlety: count the background with 8-connectivity and the
holes with 4, or a one-pixel diagonal gap registers as a hole that does not exist. Holes are
a defect here even when they are intentional — a "hole" in a sprite is a see-through pixel
in the game, not an eye, because the sprite is composited over a scene. Eyes and windows are
painted, not punched. The one exception is a genuinely hollow asset — a ring, a keyhole, a
handle, chain-link — where the mechanical penalty is a known false positive and the rater's
note on that image is what settles it (§6.4).

**Scoring.**

| `share` | base |
| --- | --- |
| `largest * 100 >= 98 * N` | 1000 |
| `largest * 100 >= 90 * N` | 900 |
| `largest * 100 >= 75 * N` | 750 |
| `largest * 100 >= 50 * N` | 550 |
| otherwise | 250 |

| Condition | Δ | code |
| --- | --- | --- |
| `strayCount >= 2` and `strayRatio > 2/100` | −150 | `detached-pieces` |
| `strayCount == 1` and `strayRatio > 2/100` | −75 | `detached-pieces` |
| any hole with area ≤ 3 px, or `holeRatio > 1/100` | −100 | `interior-hole` |
| `compactnessQ < 300` | −100 | `thin-profile` |
| `borderTouch >= 3` | −200 | `shape-clipped` (severity 0.80) |
| `span < 0.25` | −100 | `subject-undersized` |
| `share < 50/100` | −150 | `fragmented-silhouette` (severity 0.70) |

**Issue codes.**

| code | fires when | severity | blocking |
| --- | --- | --- | --- |
| `detached-pieces` | `strayRatio > 2/100` | 0.45 | no |
| `interior-hole` | a hole ≤ 3 px exists, or `holeRatio > 1/100` | 0.40 | no |
| `thin-profile` | `compactnessQ < 300` | 0.30 | no |
| `shape-clipped` | `borderTouch >= 3` | 0.80 | **yes** |
| `subject-undersized` | `span < 0.25` | 0.30 | no |
| `fragmented-silhouette` | `share < 0.50` | 0.70 | **yes** |

**Worked example** — a 32×32 character sprite, frame 0, `ALPHA_SOLID` 128:

```
solid N                612
bounds                 {x:6, y:4, w:20, h:26}
components (4-conn)    3        sizes 596, 9, 7        strayCount 2
share                  596/612 = 0.9738      >= 0.90, < 0.98   -> base 900
strayRatio             16/612  = 0.0261      > 0.02, strayCount 2  -> -150
holes                  2        areas 3, 2    smallest <= 3      -> -100
perimeter              246      (4-adj solid/transparent pairs; edgePixels is 168)
compactnessQ           min(1000, rhu(4*355*1000*612, 113*246*246))
                      = min(1000, rhu(869_040_000, 6_834_108)) = 127   < 300 -> -100
borderTouch            0
span                   min(20/32, 26/32) = 0.625
adjustment             -350     (within the -450 floor)
scoreQ                 900 - 350 = 550  ->  0.55
```

The transition perimeter is 246 against 168 edge pixels, which is the expected relationship:
each pixel on a 45° staircase contributes two transitions while counting once, and each pixel
on a straight run contributes one and counts once. The quotient drops from the old
272-of-a-possibly-1188 to a bounded 127, and 127 is a *thin* profile — which for a 612-pixel
figure with a spire, a raised arm and a cloak is about right.

Verdict text: *"one mass at 97% of 612 px, 2 detached pieces (9 and 7 px), 2 interior holes
of 3 and 2 px, thin profile."* A human looking at this agrees: the figure reads, and there
is something wrong with it that they would not have named without being told.

**How a human rates this by eye** (1–5, the scale the benchmark raters use):

- **5** — one mass; you can name the subject from a black silhouette; no holes, no floating
  bits; the shape is as compact as the subject allows.
- **4** — one mass, one small nick: a single 1–2 px hole or one tiny detached fleck.
- **3** — reads, but two or more stray pieces, or the outline of the shape is ambiguous
  without colour.
- **2** — two masses of comparable size (two arms, a sword and a body read as separate
  blobs), or several holes.
- **1** — no dominant mass, or the shape is so thin it dissolves at 2×.

Rate it from a **filled black silhouette**, not from the sprite. Squint, or drop the colour:
`read_grid {view: "mask"}` is literally this, and if you cannot read the shape there, no
amount of shading will save it.

### 4.2 `value` — is the form carried by light and dark, and does it follow the form?

**What it is.** Whether the sprite's form is described by tone, and whether the tone
*respects the form it is sitting on*. Pixel art is not photorealism: a 16×16 character has no
room for material detail, so what carries the shape is a small number of value planes — a lit
side, a core shadow, an occlusion, a highlight — each a clear step apart in lightness.

There are two separate things to get right, and this dimension used to measure only the first.

1. **Are there enough planes, and is the form carried by tone rather than by hue?** A plane
   boundary between two *different colours* at the *same lightness* does not exist to the eye,
   and the form has been handed over to hue — which the game will take away the first time it
   tints the sprite.
2. **Does each plane boundary follow the form?** A terminator that runs *around* a rounded
   body, at a roughly constant distance inside its edge, describes a volume. The same tone
   step cut as a **straight diagonal** across that body describes a flat sticker. Both have
   the same number of planes and the same contrast. Only one of them is a lit form.

**Why it matters.** Point 1 is the familiar argument and it holds. Point 2 is the one this
dimension missed, and missing it was not a small gap.

The specification was validated by building one sprite twice and measuring both with these
formulas. Version A shaded the figure with a hard straight-diagonal shadow band. Version B used
nested contours that follow the body's form. **A is a serious artistic error; B is correct.
The total moved 0.014.** Everything the dimension was built to detect — the number of tone
planes, their contrast, the hue/value separation — is *identical* in the two, because a
straight diagonal and a concentric arc are equally "a boundary between two tones".

A quality layer that scores a flat diagonal sticker at 0.86 and a modelled volume at 0.87 has
no opinion on the one thing a pixel artist notices first, and an agent optimising against it
has no reason to prefer either. That is the defect this term exists to close, and the two
figures it separates are the acceptance test for it.

#### How the form term is measured

The insight is that `dist` (§3.3) already answers the question. `dist(p)` is how deep inside
the body a pixel sits. A **concentric** terminator is a *level set* of that field: every pixel
along it is roughly the same distance from the silhouette edge, because it is tracking the
contour. A **straight diagonal** cut across a rounded body is not — it enters at the edge
where `dist` is 0, crosses the body, and leaves where `dist` is 0 again, with the middle of the
cut far deeper than either end. So the *spread* of `dist` along a plane boundary is the
measurement, and it needs no contour tracing, no curve fitting, and no float.

```
toneEdge(p)        from §3.3: p is solid with a solid 4-neighbour in a different LqBucket
planes             the 8-connected components of { p : toneEdge(p) and ditherMask(p) == 0 }
                   components of fewer than 4 pixels are discarded — a 2px step is a
                   dither artefact or a mistake, not a plane

for each plane P:
    d0        min dist over P            how deep the plane sits inside the body
    d1        max dist over P            its deepest excursion
    spanQ     rhu((d1 - d0) * 1000, Dmax + 1)

    near      the pixels within Chebyshev distance 3 of P
    corners   count of convexCorner(§3.3) among them
    edgeN     count of edgePixel among them
    cornerQ   rhu(corners * 1000, edgeN + 1)

    effectiveQ = (cornerQ >= 250) ? spanQ : rhu(spanQ, 2)

formQ = band( max over planes of effectiveQ )      // the WORST plane
```

Three decisions in that block each needed a reason, and two of them exist because the naive
version produced a confident wrong answer.

**Normalising by `Dmax` rather than by a constant.** `spanQ`'s denominator is the subject's
own half-thickness. A 3px-wide blade has `Dmax` 1 and *cannot* contain a curved terminator —
nesting is not an option at that width — while a 30px cloak has `Dmax` 8 and has every
opportunity. A constant denominator punishes the first and forgives the second. Normalising
by the body means the test asks the only question that makes sense: *how much of the available
depth range does this plane span?* It also bounds `spanQ` at 1000 by construction, which is
the same lesson `compactnessQ` learned the hard way (§4.1).

**The worst plane, not the average.** Averaging `effectiveQ` across planes is the same mistake
the weighted mean makes at the report level: one straight cut through the chest gets averaged
away by four well-formed contours on the arms and the cloak. The defect is *one plane in the
wrong place*, and the measurement that survives it is the minimum. This is a deliberate
asymmetry with the rest of the document — §5.3 uses a weighted mean for the same reason and
puts floors underneath it, and a floor cannot help inside a single dimension.

**The curvature gate, which is the one clause that was not obvious.** A straight plane across a
**straight-edged** form is correct, not wrong: the lit face of a box meets its shadow face
along a line, and a hard-surface sprite drawn isometrically would be wrongly failed at blocking
severity. So a high `spanQ` is only the serious defect where the *silhouette itself is curved*,
and that is measurable with an integer local count. `convexCorner` (§3.3) is the signature of
a 45° staircase on a convex boundary; a circle's outline is roughly half convex corners, a
rectangle's four corners are lost in its perimeter, and the 250/1000 gate sits between them
comfortably at every radius down to 2. Where the local silhouette is straight, `effectiveQ` is
halved rather than waived — the plane is still worth a look, and a hard-surface sprite with a
diagnose plane gets an advisory instead of a refusal.

**The dependency on §3.3's dither mask, stated explicitly.** A dithered seam is a boundary
between two tones by this definition, and its `dist` spread is enormous, so a dither seam
would otherwise be reported as a straight cut through the body. Every `toneEdge` pixel inside
a detected dither region is excluded before planes are built. This is not an implementation
convenience; it is a correctness requirement, and it is why the two defects were fixed in one
amendment rather than two.

#### `keyLight`, and why it was skipped too easily

The key-light check compares the mean tone in the top-left of the body against the bottom-right,
because top-left is the light convention this tool's craft guide teaches. It is a
*consistency* check, not a correctness check: a negative `keyLight` means the sprite is lit
from elsewhere, which is a decision, not a mistake, and the adjustment for it is the smallest
one in the table.

It was specified against fixed ninths of `bounds`, and a sprite could opt out of the only
light-direction check in the system by having a thin feature in one corner: the measured case
was a crown spire, which left the top-left ninth (`x 4–6, y 4–6`) empty. So the sample regions
are now **grown in a fixed order until they are usable**, both sides in lockstep so the two
regions always stay the same size and symmetric about the box's centre:

```
1. 1/3 x 1/3 at bounds' top-left and bottom-right corners
2. 1/2 x 1/2 at those same corners            (still disjoint)
3. the box's top half against its bottom half, full width, split at the mid-row
```

A region is **usable** when it holds at least 8 solid pixels *and* at least an eighth of its
own area; otherwise advance to the next step. If step 3 leaves either side unusable, the test
is not measurable: report `"key light not measurable"` in the verdict, emit no issue, and
apply no adjustment. Do not score a zero. Step 3 halves a box, so in practice it always
succeeds and the not-measurable path is nearly unreachable — which is the intent.

The same rule applies to any ratio whose denominator can collapse: with `internalEdges < 8`
there is not enough interior for an edge ratio, so `hueOnlyRatio` is reported as not measured
and neither of its issues fires.

**How it is measured.** Everything, in one place:

```
Lq              integer luminance, §3.4
buckets         distinct LqBucket values present among solid pixels
dominantShare   (pixels in the fullest bucket) / N
range           Lq_max - Lq_min
internalEdges   4-adjacent solid-solid pixel pairs
hueOnlyEdges    of those, pairs where the colours differ but LqBucket is equal
hueOnlyRatio    hueOnlyEdges / internalEdges
keyLight        mean Lq over the usable top-left region, minus the usable bottom-right one
shadowShare     (pixels with Lq <= 12) / N
highlightShare  (pixels with Lq >= 243) / N
planes, spanQ, cornerQ, effectiveQ, formQ   as specified above
```

If there are no qualifying planes, the form term is not measurable: `formQ` is 1000, the
verdict says `"no interior tone boundary to judge"`, and no issue fires. A flat single-tone
sprite legitimately has none, and inventing a penalty for it would be the scorer grading an
absence as a defect.

**Scoring.** Two banded sub-scores, combined with fixed weights, in the same shape as §4.4:

| distinct buckets | `toneQ` |
| --- | --- |
| `>= 5` | 900 |
| `== 4` | 780 |
| `== 3` | 620 |
| `== 2` | 400 |
| `<= 1` | 150 |

| `effectiveQ` (the worst plane) | `formQ` | issue |
| --- | --- | --- |
| `<= 150` | 1000 | — |
| `<= 300` | 900 | — |
| `<= 450` | 750 | — |
| `<= 600` | 550 | — |
| `<= 750` | 350 | `plane-crosses-form` 0.30 |
| `> 750` | 100 | `plane-crosses-form` 0.60 **blocking** |

```
valueScoreQ = rhu(500 * toneQ + 500 * formQ, 1000) + adjustments, clamped to [0, 1000]
```

**The 500/500 split is the least-supported number in this document and §6 should look at it
first.** It is stated as equal because the evidence says the previous weighting was zero, not
because 50% is known to be right: before this amendment, form conformance carried no weight
at all, which is what produced the 0.014. The two terms are equal partners in the craft
literature — you cannot have too few planes *or* planes in the wrong places — and the
calibration corpus is what will say whether the ratio should move.

Then, exactly as before:

| Condition | Δ | code |
| --- | --- | --- |
| `hueOnlyRatio > 25/100` | −250 | `hue-carries-form` (severity 0.60) |
| `10/100 < hueOnlyRatio <= 25/100` | −100 | `hue-carries-form` (severity 0.30) |
| `range < 45` | −200 | `narrow-value-range` |
| `dominantShare >= 92/100` or `buckets <= 1` | −200 | `flat-value` |
| `keyLight <= -25` | −100 | `key-light-inconsistent` (severity 0.25) |
| `0 <= keyLight < 12` | −100 | `key-light-inconsistent` (severity 0.25) |
| `shadowShare >= 30/100` | −150 | `shadow-crushed` (severity 0.50) |
| `highlightShare >= 10/100` | −150 | `highlight-blown` (severity 0.45) |

The two `keyLight` rows are mutually exclusive on purpose: a sprite lit from the wrong side is
also a sprite with a low `keyLight`, and counting both would charge it twice for one fact.
`flat-value` fires from either condition, not both — one adjustment, one issue.

**Issue codes.**

| code | fires when | severity | blocking |
| --- | --- | --- | --- |
| `plane-crosses-form` | worst-plane `effectiveQ > 600` (0.60 above 750, else 0.30) | 0.30 / 0.60 | **yes** at 0.60 |
| `hue-carries-form` | `hueOnlyRatio > 10/100` (0.60 above 0.25, else 0.30) | 0.30 / 0.60 | **yes** at 0.60 |
| `narrow-value-range` | `range < 45` | 0.45 | no |
| `flat-value` | `dominantShare >= 0.92` or `buckets <= 1` | 0.55 | **yes** |
| `key-light-inconsistent` | measurable `keyLight < 12`, or `keyLight <= -25` | 0.25 | no |
| `shadow-crushed` | `shadowShare >= 0.30` | 0.50 | **yes** |
| `highlight-blown` | `highlightShare >= 0.10` | 0.45 | no |

`plane-crosses-form` names the geometry it measured rather than the artistic role, because it
fires on a straight cut through a highlight exactly as it does through a shadow, and no single
word covers both. The `message` names the role and the region: *"the shadow terminator spans
80% of the body's depth as a straight cut — a plane this wide should nest around the form, not
cross it."* The `rect` is the plane's bounding box, which for a diagonal terminator is a
rotated band the caller can act on directly.

**Worked example** — the two versions of the same 32×32 character. The tone-plane
measurements are identical in both, which is the whole point:

```
                              A: straight diagonal    B: nested contours
buckets present               2, 5, 7, 9, 11          2, 5, 7, 9, 11
distinct buckets              5   -> toneQ 900         5   -> toneQ 900
range                         192                      192
internalEdges                 1140                     1140
hueOnlyEdges                  402                      402
hueOnlyRatio                  0.3526  -> -250          0.3526  -> -250
Dmax                          8                        8
worst plane  d0, d1           0, 7                     2, 3
spanQ                        rhu(7*1000, 9) = 778     rhu(1*1000, 9) = 111
cornerQ (rounded region)     412   >= 250 -> no halve 412   -> no halve
effectiveQ                   778                       111
formQ                        100   (band > 750)        900   (band <= 300)
valueScoreQ                  rhu(500*900 + 500*100, 1000) = 500
                             rhu(500*900 + 500*900, 1000) = 900
minus adjustments            -250                      -250
scoreQ                       250                       650
```

```
A: 250/1000 = 0.25, and `plane-crosses-form` at 0.60 is BLOCKING  ->  verdict fail
B: 650/1000 = 0.65, no blocking issue
value delta 400 per-mille x weight 260 / denominator 920  =  113 per-mille of total
```

The old `value` scored both versions identically, and the whole report moved **0.014**. This
one moves the total by **0.113** and moves the verdict by a whole class, because the flat
sticker is now *blocking* rather than merely dim. That is the acceptance test, and the
blocking severity is doing as much work as the score: a diagonal band across a rounded body is
not a matter of degree, it is a different object from a lit form.

Verdict text for A: *"5 tone planes, range 192, but the shadow terminator spans 78% of the
body's depth as a straight cut — the plane crosses the form instead of nesting around it."*

**How a human rates this by eye** (1–5) — and note the new anchor, which is the question that
was missing:

- **5** — form reads from tone alone, *and* the planes wrap the form. Squint until hue
  disappears and it is a solid, dimensional object; then check the boundary between the lit
  and shadow sides and it curves around the body rather than slicing through it.
- **4** — reads from tone, planes mostly follow the form, one boundary is straight where the
  body is round.
- **3** — form is legible but flat: mostly one tone with a hint of shading, or the light and
  shadow are the same lightness with a hue difference doing the work.
- **2** — tone planes exist but do not follow the form: a hard straight shadow across a
  rounded volume, which is the error the score exists to catch.
- **1** — one flat colour, or the shading is invisible.

Rate it in greyscale first, then look at the *shape of the shadow*. Any viewer can desaturate,
and `read_grid {view: "value"}` gives the tone ladder directly. Then the question no greyscale
view answers: **does the terminator curve around the body, or run across it?** If the sprite
still reads as a solid dimensional object in greyscale *and* the shadow edge curves, it is a
4 or 5. If the shadow edge is a straight line across a round body, it is a 2, and no amount of
tone count makes it otherwise.

### 4.3 `palette` — is the colour disciplined?

**What it is.** Whether the sprite uses the colours the document declared, and whether it
uses a sane number of them. A game asset is not free to invent colour: it sits on a shared
palette so the game can tint, swap and batch it, and it occupies memory. Discipline here is
a technical contract, not an aesthetic preference.

**Why it matters.** Off-palette colours break every downstream assumption: palette-swap
shaders, indexed-colour formats, batched draw calls, and the artist's own plan for the
game. They also cost you something that is easy to miss — an off-palette colour is a colour
nobody chose, and an agent that has drifted 20% of its pixels off the ramp has usually
drifted by picking arbitrary hexes rather than by making a decision. A mud-coloured sprite
is the signature of that.

**How it is measured.**

```
distinctColours    distinct packed RGBA values among solid pixels
offPalette         solid pixels whose colour is not an exact palette entry
offPaletteRatio    offPalette / N                              <- primary ratio
maxNearestDistance max colorDistanceWeighted(pixel, nearest palette swatch)
hueSectors         distinct 30-degree hue sectors, ignoring colours with s255 < 12
muddyRatio         off-palette pixels with s255 <= 76 and 64 <= v255 <= 204, / N
meanSat            mean s255 over solid pixels, / 255
class              from canvas area S: see the budget table
```

`off-palette` has no adjustment row on purpose: its ratio *is* the primary band, so the issue
fires directly from the band and the score moves through the band rather than twice.

Off-palette means **exact** non-membership, not "not close to a swatch". The whole point is
whether a colour is declared. `maxNearestDistance` separates the two failure modes: a colour
one step off a ramp entry is a snapping miss and `quantize_to_palette` fixes it; a colour
30000 away from every swatch is an invented colour and the fix is a decision.

`class` and colour budget are keyed on **canvas** area, not solid count, because the canvas is
what the artist chose and the budget follows from the room available:

| `S` | class | budget |
| --- | --- | --- |
| `S <= 512` (≈ 22×22) | `small` | 10 |
| `S <= 1024` (32×32) | `compact` | 16 |
| `S <= 4096` (64×64) | `medium` | 28 |
| `S <= 16384` (128×128) | `large` | 48 |
| otherwise | `scene` | 96 |

**Scoring.**

| `offPaletteRatio` | base |
| --- | --- |
| `0` | 1000 |
| `<= 2/100` | 950 |
| `<= 8/100` | 850 |
| `<= 20/100` | 720 |
| `<= 40/100` | 550 |
| `> 40/100` | 300 |

| Condition | Δ | code |
| --- | --- | --- |
| `distinctColours > budget` | −200 | `colour-budget-exceeded` |
| `hueSectors >= 7` and `class != scene` | −100 | `hue-sprawl` |
| `muddyRatio >= 5/100` | −100 | `muddy-mix` |
| `meanSat < 15/100` and `hueSectors >= 3` | −100 | `grey-colours` |
| `maxNearestDistance > 12000` | −100 | `invented-colours` (severity 0.40) |

**Issue codes.**

| code | fires when | severity | blocking |
| --- | --- | --- | --- |
| `off-palette` | `offPaletteRatio > 2/100` | 0.35 (0.55 above 0.20) | **yes** above 0.20 |
| `colour-budget-exceeded` | `distinctColours > budget` | 0.35 | no |
| `hue-sprawl` | `hueSectors >= 7`, class not `scene` | 0.30 | no |
| `muddy-mix` | `muddyRatio >= 0.05` | 0.35 | no |
| `grey-colours` | `meanSat < 0.15` with `hueSectors >= 3` | 0.30 | no |
| `invented-colours` | `maxNearestDistance > 12000` | 0.40 | no |

**Worked example** — the same 32×32 character, DawnBringer 16:

```
distinctColours       19
class                 compact (S = 1024)      budget 16      19 > 16  -> -200
offPalette            96
offPaletteRatio       96/612 = 0.1569         <= 0.20, > 0.08 -> base 720
maxNearestDistance    5400                    <= 12000      -> no
hueSectors            8                       >= 7, compact -> -100
muddyRatio            41/612 = 0.0670         >= 0.05        -> -100
meanSat               0.29                    >= 0.15        -> no
adjustment            -400                    (within -450)
score                 720 - 400 = 320  ->  0.32
```

Verdict: *"19 colours against a budget of 16, 16% of pixels off the palette, 8 hue families,
muddy mixes present."* Note what the number is *for*: `off-palette` at 0.35 is not blocking,
so this sprite is a `fail` on the total and on `palette`'s own 0.32, not on a blocking issue.
And note the known false positive — if those 96 pixels came from a translucent layer
compositing two swatches, the sprite is disciplined and the scorer is wrong. That case is
item 3 of §7, and the fix is `paletteLocked: true` plus opaque layers, not a lower threshold.

**How a human rates this by eye** (1–5):

- **5** — you could pick every colour in the sprite out of the document's palette, and there
  are few enough of them that you could name them all.
- **4** — essentially on-palette; one or two pixels read as "not quite a swatch".
- **3** — on-palette plus a handful of near-misses, or one colour noticeably busier than the
  rest.
- **2** — several colours you cannot place, or obviously more hues than the subject needs.
- **1** — it looks like a different palette every few pixels, or a rainbow.

Count, do not feel: `histogram` returns the per-colour counts and the palette slot of each,
in one call. If the distinct count is above the budget for the canvas, it is a 3 at best,
whatever it looks like.

### 4.4 `noise` — stray pixels and speckle

**What it is.** The high-frequency junk: a lone pixel of the wrong colour, a one-pixel
antenna off a hat brim, a checkerboard of near-identical greys, two ramp entries that differ
by three channel steps. Noise is the residue of automated drawing — an over-tight dither, a
snapping bug, a fill that leaked one pixel past its clip, a stroke that started one pixel
early. It is nearly invisible on a single frame at 1×, indistinguishable from legitimate
texture at 8×, and gone entirely from a contact sheet where sixteen frames are shrunk to
fit.

**Why it matters.** Two reasons, and the second is the one people forget. First, a stray
pixel is a *shape* error: a one-pixel protrusion changes the silhouette, and the silhouette
is what the game reads (§4.1). Second, noise is the thing that makes procedural pixel art
look procedural. A sprite with four clean tone planes and four stray pixels reads as
machine-made no matter how good the tone planes are, because the eye reads the error rate
before it reads the design.

**How it is measured.** All on the solid mask, all integer, everything shared with §3.3:

```
isolated        solid p with n8 == 0, ditherMask(p) == 0, and the sprite is not a line sprite
diagOnly        solid p with n4 == 0 and n8 >= 1, ditherMask(p) == 0
spurs           solid p with n8 == 1, ditherMask(p) == 0
colourOrphans   solid p with n4 >= 1 and NO solid 4-neighbour in the same LqBucket
nearDuplicatePairs
                pairs of distinct colours, each with >= 8 solid pixels, whose Chebyshev
                colorDistance is <= 8
ditherShare     (pixels with ditherMask == 1) / N
```

#### `colourOrphans` replaces `outliers`, and the old one measured the wrong thing

The first version of this dimension tested each pixel's Chebyshev distance from the *median*
colour of its 8-neighbours and flagged anything over 32. Implemented against a real sprite it
returned **337‰** — the worst possible band — on a well-formed lit volume with not one stray
pixel in it. Of the 159 pixels counted, almost all were legitimate boundary pixels: ~70 on the
outline's inner edge, ~50 on the material edge between gold and green, ~100 across the
shading planes. The count barely moved when the sprite got smaller (205 → 159), which is the
tell: the quantity was tracking **boundary length**, not stray pixels.

The consequence was that the dimension was close to meaningless. A flat two-colour sprite with
a dark outline has the same boundary length and scored materially the same.

The defect is conceptual rather than a bad threshold. Distance from the local median asks
"is this pixel unusual *relative to its neighbourhood*", and on a coherent edge **every** pixel
is unusual relative to its neighbourhood, because half of it is on the other side of the
boundary. What distinguishes a speck from an edge is not the *distance* to the local colour but
the *absence of any agreement at all*. So:

```
colourOrphan(p) = p is solid
                && n4(p) >= 1
                && #{ n : n is a solid 4-neighbour of p, LqBucket(n) == LqBucket(p) } == 0
```

| case | fires? | why |
| --- | --- | --- |
| stray pixel in a field | **yes** | it matches no neighbour |
| one wrong-coloured pixel inside a solid block (`n8 == 8`) | **yes** | it matches no neighbour, and this is the case the old test was written for |
| pixel on a material edge | no | ~half its neighbours share its bucket |
| outline's inner edge | no | the ink is a connected ring, every pixel has ink neighbours |
| a smooth shading plane | no | every pixel has several same-bucket neighbours |
| a 2–3 px island of one tone inside another | **no** | its pixels match *each other* — see below |

That last row is a real gap and it is deliberate. Catching a small island and protecting a
2px specular dot are the same problem: a 2px highlight on a shoulder is correct craft, and
`despeckle` ships `minClusterSize: 2-4` precisely so that a cleanup pass will not delete it.
A region-level test sharp enough to catch the island would also delete every specular dot in
the corpus. One sharp pixel-level predicate plus a documented gap beats a broad one that
quietly sands a piece flat, and §7 item 5 states the cost.

The weights changed with the measurement, and the reasoning is that the two sharp quantities
now carry the dimension: `isolated` (a stray *shape*) and `colourOrphans` (a stray *colour*)
are the two things an agent actually produces, and `diagOnly`/`spurs` are shape-integrity
defects that overlap with `silhouette`'s territory. 350/250/250/150 became 300/200/300/200.

#### Thin sprites: the exclusion the old version did not have

A lone 1px antenna, a 1px chain, a 1px blade at 32×32 — these are legitimate designs, and
`isolated` counts every one of them as a speck. There is no way to tell a deliberate 1px
feature from an accident by looking at the pixel alone, so the decision moves up a level, to
the sprite. `Dmax` (§3.3) is the subject's half-thickness, and it says what shape the sprite
is:

```
Dmax <= 1   the sprite is a line drawing: isolated, diagOnly and spurs are NOT measured.
            Report "line sprite; neighbour measures not applicable". No issue fires, and
            the dimension scores on colourOrphans and nearDuplicatePairs alone.
Dmax == 2   a thin sprite: those three measures are computed with their band thresholds
            DOUBLED (see the table), because a 2px-wide feature cannot avoid having
            1px-scale artefacts.
Dmax >= 3   the band thresholds below apply unchanged.
```

This is a real trade and it is a trade in the direction of not punishing good work. A
deliberately thin sprite is a small subset of the corpus, and getting it wrong means either
sanding a line sprite flat or waving through specks on thin metalwork. The asymmetry favours
the former being a *miss* rather than the latter being a *false alarm*, because a miss is
recoverable by looking and a false alarm costs the artist a good feature.

#### Dither is excluded, and the exclusion is now one that works

Dither is not noise, and the first attempt at excluding it did not work. Its predicate was
`ditherCell`: all four orthogonal neighbours transparent and all four diagonals solid — the
exact signature of a **perfect axis-aligned 50% checkerboard**. Measured against a sprite with
three clearly visible `bayer4` seams it reported `ditherShare` **0.0000**. On a diagonal
terminator or an elliptical arc the lattice and the boundary fight each other and the perfect
checkerboard never appears, so the one check designed to catch "mostly 1px dither" was blind
to exactly the dither an agent produces.

The replacement is `ditherMask` in §3.3, which detects *periodic alternation between two
adjacent ramp steps* and knows nothing about lattices, orientation or scale. All three of
`isolated`, `diagOnly` and `spurs` exclude `ditherMask` pixels, `ditherShare` is its
population over `N`, and the verdict names it so a human can see why the noise score is what
it is. When `ditherShare >= 10/100` the dimension emits `dither-dominant` as an advisory: a
piece that is *mostly* one- or two-pixel alternation is its own problem under the 3–5px seam
rule, but it is not noise, and it does not cost a point here.

What that costs is stated in §3.3 and repeated in §7: the predicate cannot distinguish a
legitimate 2px checkerboard from a mistaken 1px stipple, so both are detected, both are
exempted from the noise measures, and a heavily-textured sprite picks up an advisory. A
`sparse` pattern at low coverage is a further false negative, since at low coverage a region
stops being a connected set of two adjacent buckets and falls out of the mask entirely.

**Scoring.** Four ratios, each banded, combined with fixed weights. Higher ratio is worse, so
the bands run the other way:

| ratio | `<= 2/1000` | `<= 8/1000` | `<= 20/1000` | `<= 50/1000` | `> 50/1000` |
| --- | --- | --- | --- | --- | --- |
| sub-score | 1000 | 900 | 750 | 500 | 200 |

On a thin sprite (`Dmax == 2`) the three shape thresholds are `4, 16, 40, 100, >100` instead —
the band *boundaries* double, the sub-scores do not change.

| ratio | weight |
| --- | --- |
| `isolated / N` | 300 |
| `diagOnly / N` | 200 |
| `colourOrphans / N` | 300 |
| `spurs / N` | 200 |

```
noiseScoreQ = rhu( 300*isolatedQ + 200*diagQ + 300*orphanQ + 200*spurQ, 1000 )
              - 100 if nearDuplicatePairs >= 1
```

(`isolatedQ` and friends are the banded sub-scores in per-mille. When `Dmax <= 1` the three
shape sub-scores are all 1000 and the mean is over the remaining weight. The near-duplicate
penalty is a flat −100, not a band: two ramp entries three steps apart are a mistake whether
there are two of them or twenty, and they are a *decision* error rather than a frequency one.
The four noise issues fire from the band each ratio lands in — `> 8/1000` is the trigger for
all four — rather than from an adjustment row, so a single ratio is counted once and produces
at most one issue.)

**Issue codes.**

| code | fires when | severity | blocking |
| --- | --- | --- | --- |
| `isolated-pixels` | `isolated / N > 8/1000` (16 on a thin sprite) | 0.40 | no |
| `diagonal-seam` | `diagOnly / N > 8/1000` (16 thin) | 0.45 | no |
| `stray-colour` | `colourOrphans / N > 8/1000` | 0.35 | no |
| `single-pixel-spur` | `spurs / N > 8/1000` (16 thin) | 0.30 | no |
| `near-duplicate-colours` | `nearDuplicatePairs >= 1` | 0.35 | no |
| `dither-dominant` | `ditherShare >= 10/100` | 0.35 | no |

**`colour-outlier` is retired and `stray-colour` replaces it.** That is a breaking rename and
§8.3 would normally forbid it, because a code's *meaning* may not change under a stable name.
Two things make it the right call here. The meaning changed completely — the old code measured
distance from a local median, the new one measures absence of agreement — so keeping the name
would have been the actual violation. And nothing has shipped: the analyzers are written
against this document, not released, so the cheapest possible moment to correct a code is the
one before six agents branch on it. The old string must not be reintroduced.

**Worked example** — the same 32×32 lit volume that broke the old version, with a 4px dither
seam and nine genuine stray pixels:

```
Dmax                     6      (a full body)  -> no thin-sprite relaxation
ditherShare              25/612 = 0.0408      (a 4px bayer4 seam at 0.25)  -> no advisory
isolated                 9      9/612   = 0.0147   -> <= 0.020  -> isolatedQ  750
diagOnly                 4      4/612   = 0.0065   -> <= 0.008  -> diagQ      900
colourOrphans            9      9/612   = 0.0147   -> <= 0.020  -> orphanQ    750
spurs                    6      6/612   = 0.0098   -> <= 0.020  -> spurQ      750
weighted                 rhu(300*750 + 200*900 + 300*750 + 200*750, 1000)
                        = rhu(825_000, 1000) = 825
nearDuplicatePairs       1      (#8595a1 x14, #8a97a3 x9, colorDistance 5)  -> -100
scoreQ                   825 - 100 = 725  ->  0.725
```

`colourOrphans` is **9**, not the 159 the old measure returned. Those 159 boundary pixels are
now correctly invisible to this dimension: they are the outline's inner edge, the gold-to-green
material edge and the shading planes, and all three are coherent edges where every pixel
agrees with the half of its neighbourhood on its own side. The nine that remain are the nine
actual strays, and the score is the same 0.72 the sprite deserves.

Verdict: *"9 isolated px, 4 diagonal-only px, 9 stray-colour px, 6 single-pixel spurs, 1
near-duplicate pair, dither 4% of the surface."* Every one of those is a specific pixel an
agent can fix with one `despeckle {mode: "both", rect}` and one `quantize_to_palette` — which
is exactly the loop the report is meant to drive. Note that the issue names no boundary: it
cannot, because there is nothing wrong with any of them.

**How a human rates this by eye** (1–5):

- **5** — clean at 1×. Zoom to 8× and anything you find is texture, not error.
- **4** — one or two specks you would have to hunt for.
- **3** — visible at 1× once you know to look; a few pixels of the wrong colour.
- **2** — the texture is busy; the surface reads as grain rather than as material.
- **1** — it sparkles. The eye goes to the errors instead of the shape.

The test that works: look at it at 1× for three seconds, then at 8× for three seconds. If
the two views disagree, you have noise. The 4× view is the worst place to judge this — it
makes every 2×2 dither block into a visible dot grid, which is why the craft guide says
never to judge a whole piece zoomed in. And when judging, **look for pixels that match
nothing**, not for pixels that sit on an edge: an edge is not noise, and a rater who flags
edges will fail every well-drawn sprite in the corpus.

### 4.5 `outline` — is the contour consistent?

**What it is.** Whether there is a contour at all, whether it is one pixel thick, whether it
is the same colour all the way round, and whether it holds its weight. Outlines are how
small sprites hold their edge against a busy background — a sprite with a dark contour reads
at 32px over grass; the same sprite without one dissolves into it.

**Why it matters.** An inconsistent outline is worse than none. A 2px outline on the head
and 1px on the body reads as a mistake, because it is one. A black outline on top of a dark
palette swallows the top of the sprite. A contour that vanishes halfway down the left side
means the artist lost interest at that row, and the viewer reads it as damage. In a game
these are not subtle: the outline is 10–20% of a small sprite's pixels, so its defects are
the sprite's most visible feature.

**How it is measured.** All quantities from §3.3, all integer:

```
edgePixels      §3.3, the count of edge pixels. NOT the transition `perimeter`: an outline
                is drawn ON pixels, so a pixel count is the right measure here and a length
                would double-count every staircase corner.
localMean(p)    mean Lq over the solid pixels in the 5x5 Chebyshev window, integer division
ink(p)          localMean(p) - Lq(p) >= 20
inkCount        ink pixels among the edge pixels
outlineShare    inkCount / edgePixels                          <- primary ratio
outlineCoverage inkCount / N
inkDepth        dist(p) for ink pixels, using the shared §3.3 field
minInkDepth     min, maxInkDepth  max
quadrantDepth   max ink depth in each of the four quadrants of `bounds`
inkColours      distinct packed colours among ink pixels
inkGaps         edge pixels with no ink 4-neighbour
```

`localMean` includes `p` itself, so it is always defined, and it is a *local* mean rather
than a sprite-wide one so a light outline on a dark body is still detected. The depth is
`dist` from §3.3, not a private BFS: this dimension, `value`'s form term and `noise`'s
thin-sprite test all need the distance-to-boundary field, and three BFS runs that agree are a
fact while three that disagree by a pixel are a bug report nobody can reproduce. `dist` is
also the same number for the body and the ink, which is what makes `maxInkDepth` a thickness
measurement rather than a distance-from-the-edge measurement.

There is one deliberate exception. If `outlineShare < 15/100`, the dimension does **not** run
the band table. It reports `scoreQ: 700`, emits `outline-missing` at severity 0.20, and says so
in the verdict. A sprite with no outline is a legitimate style — plenty of excellent top-down
and RPG sprites have none — so it is scored *neutral*, not *bad*. 0.70 is the "nothing
asserted either way" value, and §7 flags it as one of the numbers most likely to draw
disagreement.

**Scoring** (only reached when `outlineShare >= 15/100`):

| `outlineShare` | base |
| --- | --- |
| `>= 80/100` | 950 |
| `>= 60/100` | 850 |
| `>= 35/100` | 700 |
| otherwise | 550 |

| Condition | Δ | code |
| --- | --- | --- |
| `maxInkDepth >= 3` | −150 | `outline-heavy` |
| `quadrantDepth` spread `>= 2` | −150 | `outline-inconsistent-weight` |
| `inkColours >= 4` and the 4th colour holds `>= 5%` of ink | −50 | `outline-colour-split` (0.25) |
| `inkGaps / edgePixels >= 5/100` | −50 | `outline-gap` (0.25) |
| `outlineCoverage >= 45/100` | −200 | `outline-heavy` (0.70) |
| `outlineShare >= 60/100` and `outlineCoverage < 3/100` | −100 | `outline-gap` (0.35) |

**Issue codes.**

| code | fires when | severity | blocking |
| --- | --- | --- | --- |
| `outline-missing` | `outlineShare < 15/100` | 0.20 | no |
| `outline-gap` | `inkGaps / edgePixels >= 5/100`, or a sparse outline | 0.25 / 0.35 | no |
| `outline-inconsistent-weight` | quadrant depth spread `>= 2` | 0.45 | no |
| `outline-colour-split` | `>= 4` ink colours, none dominant | 0.25 | no |
| `outline-heavy` | `maxInkDepth >= 3` or `coverage >= 0.45` | 0.50 / 0.70 | **yes** at 0.70 |

`outline-gap` is an advisory on purpose. **Selective outlining is a good technique**, not a
defect — the craft guide recommends dropping the contour where the light hits, and this
scorer must not punish an artist for doing the recommended thing. A gap is reported so an
agent can see it, and costs 50 per-mille, not a blocking severity.

**Worked example** — the same sprite, outlined at 2px on top and 1px elsewhere:

```
edgePixels            168
perimeter             246      (§3.3; not used here, shown to keep the two apart)
inkCount              139
outlineShare          139/168 = 0.8274       >= 0.80          -> base 950
outlineCoverage       139/612 = 0.2271       in range        -> no
quadrantDepth         TL 3, TR 3, BL 1, BR 1  spread 2        -> -150
maxInkDepth           3                                          -> -150
inkColours            2                                          -> no
inkGaps / edgePixels  11/168 = 0.0655          >= 0.05          ->  -50
adjustment            -350
scoreQ                950 - 350 = 600  ->  0.60
```

Verdict: *"contour on 83% of the boundary, 3px deep at the top and 1px at the bottom, 2 ink
colours, 11 gaps."* That is a real and very common fault — a head that has been outlined too
hard — and the issue's `rect` points at the top half of the bounding box, so the fix is a
`clear_region` on one rect.

**How a human rates this by eye** (1–5):

- **5** — a clean 1px contour that holds all the way round, in one colour, and you can see
  the sprite's edge against any background.
- **4** — consistent, with a few deliberate or accidental gaps.
- **3** — the contour is there but uneven: heavy in one place, missing in another.
- **2** — the outline is fighting the sprite — 2px+ in places, or a different colour per
  region.
- **1** — no contour, or a black halo that eats the top of the subject.

If you would call "no outline" a 5 because that is your style, say so in the note field for
that image — the corpus needs to record the rater's intent, because the machine score will
disagree and the calibration is more useful for knowing *where* it disagrees.

### 4.6 `motion` — does the animation hold together?

**What it is.** Whether the frames, played in order, read as one continuous movement: a loop
that closes without a hitch, a silhouette that stays the same size and position, and a
timing that matches what the pixels are doing.

**Why it matters.** Animation defects are worse than static defects, because the eye is
extremely good at detecting them and cannot ignore them. A 1px snap at the loop point is a
visible twitch once per cycle — the single most common thing that makes a hand-made sprite
animation look amateur — and it is invisible in a contact sheet, which is where almost
everyone checks. In a game it is also a functional problem: a character whose silhouette
changes area by 15% per frame reads as flickering, and hitbox math built on a moving
silhouette is a source of bugs.

#### Applicability — read this before implementing

`motion` is **excluded**, not scored, when it does not apply. The report omits the `motion`
key from `dimensions` entirely, and the **required** `excluded` map carries the reason
(§3.6). Both members of `ExcludedReason` have exactly one producer, and applicability is the
**aggregator's** call, not the analyzer's — the contract is explicit that an analyzer returns a
`scoreQ` for every context and the aggregator decides what lands in the report.

| Reason | Produced when | Detection |
| --- | --- | --- |
| `single-frame` | `frameIds.length == 1` | Length of the sequence the aggregator built. A still sprite, or a caller who scoped the evaluation to one frame of an animation. |
| `no-motion-content` | `frameIds.length >= 2` **and** every composite in the sequence is byte-identical to `composite[0]` | For each `i > 0`, compare `composite[i].data` to `composite[0].data` for exact equality across the whole `Uint8ClampedArray`. Any differing byte makes the sequence measurable. |

**It is never scored as 0.0, and that is the whole point.** A zero would mean "this animation
loops badly" for a static sprite, would drag every still asset's total down by 8 points for
the crime of not being an animation, and would teach every agent to ignore a dimension that
is genuinely useful. Absence is the signal, and absence is checkable: presence of the key in
`dimensions` is the normative test, `excluded` is the mandatory explanation.

The exclusion must be at the aggregator rather than inferred from the analyzer's output,
because the analyzer's answer is a lie in this case by construction. Every quantity in the
measurement below degenerates on an identical sequence — churn is 0 everywhere, the seam is 0,
`seamRatio` is `0 / max(1, 0)` = 0 — so a motion analyzer that measured it honestly would
return its **best possible** band, a `scoreQ` of 1000, for a sprite that does not move. That
is the fake-perfect-score trap the contract calls out by name, and excluding the dimension is
the only way to avoid handing out a perfect mark for an absence.

#### Why there are two signals and not one

The exclusion *and* an advisory are both emitted for the identical-frames case, and they are
not redundant:

- **`excluded.motion = 'no-motion-content'`** is a statement about applicability: this document
  cannot be measured. An agent branching on it knows not to trust a motion number.
- **`frames-identical` at severity 0.35** is a statement about the *work*: four copies of frame
  zero is usually an agent that meant to animate and did not. It is non-blocking, because we
  cannot tell that apart from a deliberate hold — a two-frame breathing pause, a game timing
  trick, a placeholder exported as a hold.

One without the other loses something real. Exclusion alone tells a careful agent the
dimension is unavailable and stops there; the advisory tells a careless one that four
identical frames are usually a mistake. The contract names both codes as aggregator-owned, and
they are emitted from the same branch, in that order.

**How it is measured.** The sequence is `frameIds`, already in playback order (§3.1), so a
pingpong tag is measured as it plays and the analyzer never has to know what a tag is.

```
churn_i        |mask(f_i) XOR mask(f_{i+1})|          i cyclic, so churn_{n-1} is the SEAM
churnMedian    median of churn_0 .. churn_{n-2}       (internal transitions only)
seamRatio      churn_{n-1} / max(1, churnMedian)
lumDelta_i     mean |Lq(a) - Lq(b)| over pixels solid in both f_i and f_{i+1}
lumMedian      median of lumDelta_0 .. lumDelta_{n-2}
lumSeamRatio   lumDelta_{n-1} / max(1, lumMedian)
area_i         solid count in f_i
areaSpread     (max area_i - min area_i) * 1000 / mean(area_i)
centroid       mean x and mean y over solid pixels, in 1/64 px fixed point
seamStep       Chebyshev distance between centroid(f_{n-1}) and centroid(f_0), in 1/64 px
maxStep        the largest in-loop Chebyshev centroid step, same units
durations      per-frame durationMs from the sequence
loopMs         sum of durations in the sequence
deltaSpread    (max lumDelta_i - min lumDelta_i) / max lumDelta_i, internal only
```

Centroid uses Chebyshev, not Euclidean, for the step distance: a foot that moves one pixel
diagonally has moved one pixel, and the sqrt would put a float back into the middle of the
pipeline for no gain. Both `areaSpread` and `deltaSpread` are compared in the integer form
§3.7 gives.

`seamRatio` is the important one and it is deliberately relative: a loop whose seam changes
40 pixels is fine if every internal transition changes 40 pixels too, and terrible if they
change 6. The primary ratio is the larger of `seamRatio` and `lumSeamRatio`, so a seam that
pops in *colour* while the silhouette happens to match still gets caught.

**Scoring.** With `m = churnMedian` (or `lumMedian`), the seam ratio is compared as
`seam * 20` against a multiple of `m` — no float anywhere:

| seam ratio (whichever is larger) | integer test | base |
| --- | --- | --- |
| `<= 1.35` | `seam * 20 <= 27 * m` | 1000 |
| `<= 1.75` | `seam * 20 <= 35 * m` | 880 |
| `<= 2.50` | `seam * 20 <= 50 * m` | 720 |
| `<= 4.00` | `seam * 20 <= 80 * m` | 500 |
| `> 4.00` | otherwise | 250 |

| Condition | Δ | code |
| --- | --- | --- |
| `areaSpread > 150/1000` | −200 | `silhouette-instability` (0.60) |
| `150/1000 >= areaSpread > 60/1000` | −80 | `silhouette-instability` (0.30) |
| `churnMax > 2 * churnMedian` (internal transitions only) | −150 | `frame-jitter` (0.50) |
| `seamStep > maxStep * 1.5` and `seamStep >= 64` (1.0 px) | −150 | `loop-seam-jump` (0.55) |
| any duration `> 3 *` the median duration | −100 | `timing-outlier` (0.35) |
| `loopMs < 80` or `loopMs > 1200` | −100 | `loop-duration-out-of-range` (0.30) |
| all durations equal and `deltaSpread >= 0.6` | −100 | `timing-mismatch` (0.45) |

`churnMax` and `deltaSpread` are internal-only on purpose: the seam is *supposed* to be
different, that is what the primary ratio measures, and counting it twice would punish a
loop for the one thing a loop is allowed to do.

**Issue codes.**

| code | fires when | severity | blocking |
| --- | --- | --- | --- |
| `loop-seam-pop` | seam ratio `> 1.75` (0.55 above 2.50) | 0.30 / 0.55 | **yes** at 0.55 |
| `loop-seam-jump` | `seamStep > 1.5 * maxStep` and `>= 1.0 px` | 0.55 | **yes** |
| `frame-jitter` | `churnMax > 2 * churnMedian` | 0.50 | **yes** |
| `silhouette-instability` | `areaSpread > 0.06` (0.60 above 0.15) | 0.30 / 0.60 | **yes** at 0.60 |
| `timing-outlier` | a frame `> 3×` the median duration | 0.35 | no |
| `timing-mismatch` | equal durations with `deltaSpread >= 0.6` | 0.45 | no |
| `loop-duration-out-of-range` | `loopMs` outside 80..1200 | 0.30 | no |

**Worked example** — a 6-frame walk cycle, tag `walk`, forward, 100ms per frame:

```
churn (px)            f0->f1 34, f1->f2 30, f2->f3 38, f3->f4 30, f4->f5 34
                      seam f5->f0 96
churnMedian           34
seamRatio             96/34 = 2.82
lumDelta              internal 17,15,19,16,17   seam 41
lumSeamRatio          41/17 = 2.41
seam ratio (max)      2.82      96*20 = 1920 <= 80*34 = 2720   -> base 500
area                  612, 612, 611, 612, 612, 611
meanAreaQ             rhu(3670, 6) = 612
areaSpreadQ           rhu(1*1000, 612) = 2       <= 60            -> no
churnMax 38 > 2*34 = 68?                                         no
seamStep 0.5 px; 0.5*2 = 1 > 3*0.5 = 1.5?                       no
durations             100 x6;  loopMs 600, in 80..1200            -> no
deltaSpreadQ          rhu(4*1000, 19) = 211     < 600            -> no
score                 500  ->  0.50
```

Verdict: *"loop seam changes 2.8x more than any internal transition — the cycle pops once
per cycle."* That is a walk cycle where frame 5 was drawn one step off the return. The fix
is one `translate {layer: "*", dx, dy}` on one frame, and no contact sheet would ever have
shown it.

**How a human rates this by eye** (1–5) — **play it, do not look at it.** A contact sheet
cannot show a seam; that is the entire reason this dimension exists.

- **5** — loops invisibly. You can watch it ten times and never catch the join.
- **4** — one transition is slightly heavier than the rest; you notice on the third loop.
- **3** — a visible hitch at the loop point, or a foot that jumps a pixel somewhere.
- **2** — the silhouette changes size noticeably frame to frame, or the timing stutters.
- **1** — it reads as a slideshow with a snap at the end.

Use `preview_animation {tag, onion: {before: 1, after: 1}}` — the onion skin follows the
playback order, so a pingpong loop is judged as it plays. If the animation is under about
200ms total, watch it three times; the defect is one event per cycle and you will miss it
once.

## 5. Aggregation

### 5.1 Weights

`QualityWeights` in `types.ts`, in per-mille, summing to 1000:

| Dimension | Weight | Why |
| --- | --- | --- |
| `silhouette` | **300** | It is the sprite. Everything else is decoration on a shape that has to read at 32px over a busy background. |
| `value` | **260** | Second to the silhouette because value is the only other thing that survives downscaling and engine tinting, and because `hue-carries-form` is the failure agents produce most often. |
| `palette` | **140** | A real technical contract, and the signature of an agent that stopped choosing colours. But a good sprite on a muddy 20-colour palette is still a good sprite. |
| `noise` | **120** | Cheap to fix, highly visible, and the residue of automated drawing. Not worth a third of the report because a few specks do not make a sprite unrecognisable. |
| `outline` | **100** | Deliberately the smallest of the drawn dimensions, because outlining is a **style choice**. A 1px contour helps; a 3px one is destructive; no outline is legitimate. It cannot carry more than 10% without the scorer overruling taste. |
| `motion` | **80** | Real, but only for animations, and only for those — which is exactly why it is the smallest and why it is dropped for stills. |

These six numbers are unchanged by the form-conformance term added to `value` in §4.2, and
that is a decision rather than an oversight. The term changes what `value` *measures*, not
how much the report listens to it, and the new separation (0.25 versus 0.65 on `value`, and a
blocking issue on one of them) is already large enough to be decisive. Re-weighting in the
same change would have confounded two variables: if the total moved, there would be no way to
tell whether the new measurement or the new weight did it. §6 is where the 500/500 split
inside `value` gets tested; the dimension weight stays put until that data exists.

**This table is a contract, not a summary.** `test/quality-weights.test.ts` parses it out of
this file and fails the build when it disagrees with `DEFAULT_QUALITY_WEIGHTS` in `types.ts`,
because the two were written in parallel once and drifted for a whole task cycle without
anything noticing. The row format is load-bearing: `| \`dimension\` | **per-mille integer** |
`. Re-tuning a weight is a product decision that resets every committed baseline, and it has
to be made in this file and in `types.ts` in the same commit.

### 5.2 The formula

```
active      = every dimension key present in `dimensions`
denominator = sum of the active weights              // 1000 animated, 920 still
totalQ      = Math.floor((Σ wᵢ * scoreQᵢ + denominator/2) / denominator)
score       = unitScore(totalQ) = totalQ / 1000     // the only float in the pipeline
```

One division, integer weights, per-mille scores, round-half-up. **For a single-frame sprite
`motion` is dropped and the denominator is 920, not 1000** — 300+260+140+120+100. The
remaining weights are *not* rescaled and *not* renormalised onto 1000: the total is divided
by the sum of what actually contributed, so a still sprite is scored as a still sprite
rather than as a still sprite penalised for a dimension it was never asked about. A 32×32
character that scores 0.88 across the five applicable dimensions reports **0.88**, not 0.81.

The weights stay in thousandths in the code. Renormalising into floats at runtime would make
the total depend on the active set in a way that is hard to diff and hard to explain in a
CI log.

### 5.3 Verdicts

```
Every constant in this section is exported from `types.ts` and is per-mille, like every other
number in the pipeline. They are **per-mille integers, not fractions of 1**: `400`, not
`0.40`. A floor is compared with an exact integer test and no epsilon, and a `0.40` written
here next to a `400` written there is a bug that would fail every sprite scoring well.

| Constant | Value | Meaning |
| --- | --- | --- |
| `SEVERITY_BLOCKING` | **500** | An issue at or above this severity blocks delivery. Inclusive. |
| `FLOOR_FAIL.silhouette` | **400** | Below this, a report is `fail` on that dimension alone. |
| `FLOOR_FAIL.value` | **400** | |
| `FLOOR_FAIL.palette` | **400** | |
| `FLOOR_FAIL.noise` | **300** | The two style dimensions sit lower, on purpose. |
| `FLOOR_FAIL.outline` | **300** | |
| `FLOOR_FAIL.motion` | **400** | |
| `FLOOR_WARN` | **600** | Below this, a report is at best `warn`. Every dimension. |
| `SCORE_FAIL_THRESHOLD` | **550** | Total below this is `fail`. |
| `SCORE_PASS_THRESHOLD` | **800** | Total at or above this can be `pass`. |

The table is a contract, not a summary — see the drift-guard note at the end of this section.

blocking = every issue, from every present dimension AND from the aggregator, with
           severity >= 500, sorted by severity descending then code ascending,
           deduplicated by (code, rect)

fail  if blocking.length > 0
      or any PRESENT dimension's scoreQ < FLOOR_FAIL[that dimension]
      or totalQ < 550
warn  if totalQ < 800
      or any PRESENT dimension's scoreQ < 600
pass  otherwise
```

Four properties of this rule are deliberate and should survive a well-meaning refactor.

**Precedence is `fail` > `warn` > `pass`,** evaluated in that order, so a report is never
ambiguous and no caller has to re-derive it.

**A dimension floor exists.** A total of 0.86 with `silhouette: 300` is a `fail`, not a
`warn`. Weighted means hide a broken dimension behind good ones, and a broken silhouette means
the asset does not work in the game no matter how disciplined the palette is. `FLOOR_FAIL`
descends with the weight: the two dimensions that are *style* (`outline`, and `noise` as a
matter of taste — the craft guide's own warning that a clean-up pass can sand a piece flat)
may sit lower before they can fail a report alone. Lower, not exempt.

**Floors apply to present dimensions only.** An excluded dimension was never measured, so it
cannot fail a floor it was never measured against. That is exactly what the partial
`dimensions` record buys, and it is why a still sprite does not fail its own `motion` floor.

**Blocking issues are independent of the score.** `empty-frame` (severity 1.00) is emitted by
the aggregator when there is nothing opaque to measure, every dimension reports 1000 because
there is nothing to fault, and the verdict is `fail`. That looks contradictory and is not: a
blank canvas is not bad artwork, it is *no* artwork, and a mean cannot express that. It is
also the cleanest demonstration of why the blocking list exists as a separate channel — an
empty document scoring 1.00 and failing is exactly the case a threshold alone gets wrong.

#### The floors are not drift-guarded, and that is a known gap

`test/quality-weights.test.ts` parses the §5.1 weight table out of this file and compares it
to `DEFAULT_QUALITY_WEIGHTS`. **It does not parse this section.** A typo that changed
`FLOOR_FAIL.value` from `400` to `450` here would fail nothing while the code kept using 400
— a silent divergence in the one rule that decides whether a report fails.

The table above is therefore written in the same shape and the same units as §5.1: one row
per constant, the value in a fixed column, comparable value-for-value against the exported
symbol. That is deliberate, so a guard can be extended to read it the way the weights guard
reads §5.1. **Extending that guard is follow-up work on the T-009 drift guard and is not part
of this change**, because the weights test parses this file and its parser is not this file's
to edit. Until it lands, the honest position is: **the weights are drift-guarded; the floors,
the two score thresholds and the blocking severity are not.** A change to any of them has to
be made in this file and in `types.ts` in the same commit, by hand, with a changelog entry
that says the baselines moved.

### 5.4 Aggregator-level issues

Two codes are emitted by the aggregator rather than by a dimension, because both describe the
*target* rather than any one dimension's opinion of it. They obey the same
`{code, message, rect, severity}` shape and the same `>= 500` blocking rule.

| code | fires when | severity | blocking |
| --- | --- | --- | --- |
| `empty-frame` | Nothing opaque to measure in the evaluated target | 1000 | **yes** |
| `frames-identical` | `frameIds.length >= 2` and all composites byte-identical (§4.6) | 350 | no |

`empty-frame` has `rect: null`, and is the one code that is not about the artwork at all — it
means there is none. `frames-identical` has `rect: null` and its message names the frames
involved, because an agent that duplicated frame 0 needs to know *which* tag it duplicated.
Both are emitted from the same branch as the exclusions in §4.6, and both are facts about the
input rather than scores about the art.

## 6. Calibration

### 6.1 The part that cannot be automated

**Algorithmic data cannot calibrate an algorithm.** If the benchmark corpus were labelled by
a model, by a script, or by `evaluate` itself, then measuring the correlation between
`evaluate`'s scores and those labels would measure *self-consistency*, not validity. Fit the
thresholds to the labels and the correlation climbs toward 1.0 while the scorer gets no
better — the classic circular evaluation, and it fails silently, because the number looks
exactly like success. A second model does not fix this. It is still a model, with the same
blind spots, and its agreement with the first one is evidence about shared training data
rather than about pixel art.

**Human expert judgement is therefore a hard requirement, not a nice-to-have.** It is the
one input in this whole roadmap that cannot be generated, and it is the reason the corpus and
the calibration results are the part of this project that cannot be copied. Everything else —
the six analyzers, the weights, the thresholds — is an implementation choice that a
competitor could reimplement in a week. A corpus of 200 images rated by two people who have
done this professionally, and the correlation coefficients that resulted, is the asset.

### 6.2 Step zero: measure the formulas against real art before believing them

There is a step that comes *before* the human protocol, and this document's second amendment
exists because it was skipped the first time.

**Every threshold in §4 was chosen by reasoning, not by measurement.** They were then
implemented against a real sprite, and four of them turned out to be measuring something other
than what their names claimed. A noise measure returned 337‰ on a sprite with no stray pixels
in it, because it was counting boundary length. A dither detector returned 0.0000 on a sprite
with three visible dither seams, because it recognised one exact lattice. A compactness ratio
presented as 0..1 returned 1188, and worse, *rewarded* the thin shapes it was written to
penalise. And the whole `value` dimension moved the report total by **0.014** between a flat
diagonal shadow band and correctly nested contours — so it had no opinion on the difference
between a sticker and a lit volume, which is the first thing an artist looks at.

Not one of those was found by reading the specification, and **not one would have been found
by a human rating a corpus**, because a corpus measures *whether the score tracks opinion* and
all four bugs were in quantities whose scores did track opinion — they were just measuring the
wrong property of the image. A correlation of 0.9 against expert ratings would not have caught
a single one of them.

So the protocol starts with a **designed contrast**, before any rating happens:

1. Produce a **matched pair** of sprites that differ in exactly one property and are otherwise
   identical. The pair that found these four bugs: the same character, shaded once with a hard
   straight-diagonal shadow band and once with nested contours following the body.
2. Run the implemented analyzers over both. **The score must separate them, and the direction
   of separation must be the one an artist would call correct.** A pair scoring 0.014 apart is
   a bug report, not a calibration data point.
3. Do the same for every failure class with a canonical pair, and keep the pairs in the corpus
   with their expected ordering:
   - straight vs. nested planes (`value`)
   - a clean lit volume vs. the same volume with nine specks (`noise`)
   - a 1px dither seam on a diagonal vs. the same seam on an axis (`noise`)
   - a rounded body vs. a hard-surface box with a face split (`value`'s curvature gate)
   - a line sprite vs. a filled one (`noise`'s thin-sprite rule)
   - a 4-frame loop with a 1px return offset vs. a clean one (`motion`)
4. Record the measured numbers, not just the verdict. A pair that separates by 0.02 is passing
   the test and still wrong, and the size of the gap is the thing worth reviewing.

The standing rule this produces: **a new threshold is a hypothesis until it has been run
against a designed contrast.** The pairs are cheap — the same sprite drawn twice — and they
are the only mechanism in this project that catches a measurement which is confidently,
correlatively and completely wrong.

### 6.3 The protocol

**Corpus** (T-021 builds the tooling; the corpus is ~200 images). It must span the
difficulty range, not cluster at the easy end:

| Slice | Target | Why it is there |
| --- | --- | --- |
| Canvas size | 16², 32², 64², 128², 256², and non-square | Thresholds that only work at 32×32 are not thresholds. |
| Frames | 1, 2, 4, 8 | The `motion` exclusion contract and the seam ratios are all size-of-sequence sensitive. |
| Subject | characters, props, tiles, UI, scenes, hard-surface | To find where the scorer is confidently wrong (§6.6), and to exercise `value`'s curvature gate. |
| Provenance | programmatic generation, this repo's `artwork/`, and imports | A corpus of only generated art calibrates against its own failure modes. |
| Quality | deliberately spans good to bad, including near-misses | A corpus of only failures calibrates the detector, not the scale. |
| The §6.2 contrast pairs | at least one of each, kept in the corpus | A pair is the cheapest regression test this system has, and the only one that catches a mis-targeted measurement. |

Each image carries its objective attributes (size, palette length, frame count, tags) so a
rater is never guessing what they are looking at, and so a disagreement can be traced to a
class of asset rather than to a rater.

**Raters.** At least two, with real pixel-art experience, rating **independently**:

- 1–5 per dimension, using the "by eye" anchors in each §4 subsection. Those anchors are
  normative: `4` means what §4 says `4` means, not what the rater privately thinks.
- One overall three-way judgement: **usable / needs work / unusable**. This is the number
  that matters for shipping and it is deliberately coarser than the per-dimension scores —
  an image can be usable with a bad outline.
- A free-text note for any score ≤ 2. These notes are the most valuable output of the whole
  exercise: they are the cases where the machine disagreed with a person, and each one is a
  candidate threshold change with a human reason attached.

**Ground truth is agreement.** Two raters within 1 point on a dimension is that image's
truth for that dimension. Disagreements of 2+ points, and every overall-judgement
disagreement, go to a **third rater** as arbitration. The arbitrated score is recorded
alongside both original scores — the spread between raters is itself a measurement of how
ambiguous the rubric is, and discarding it would throw away the most informative thing in
the dataset.

### 6.4 Measurement

T-022 computes, per dimension and overall:

| Statistic | Target | What it tells you |
| --- | --- | --- |
| Pearson `r`, deterministic score vs. mean rater score (1–5 rescaled to 0..1) | **> 0.70** | Do the numbers move with human judgement at all. |
| Spearman ρ | > 0.70 | Do they at least *order* assets the way humans do. Ordering matters more than absolute value for a gate. |
| Rater inter-rater agreement (Krippendorff α or weighted Cohen κ) | > 0.60 | Is the human standard itself coherent. **Below 0.60, stop and fix the rubric, not the scorer** — you cannot calibrate against a noisy ruler. |
| Confusion vs. the 3-way overall judgement at the `pass` threshold | reported, not targeted | Whether the gate line is in the right place. |
| §6.2 contrast-pair separation | every pair ordered correctly, by a margin worth arguing about | Whether each measurement is aimed at the thing it claims. **This one is a gate, not a statistic** — a failing pair is a bug, and no correlation rescues it. |

`r > 0.70` is the acceptance bar quoted in TASKS.md T-025, and it is a *low* bar. It says
the scorer is a useful second opinion, not that it is right. Any claim stronger than that
would need a stronger number than 200 images can produce.

And it has a blind spot, which §6.2 is the answer to: **a high `r` is fully compatible with a
dimension measuring the wrong property**, because a consistently wrong measurement is still
consistent. The correlation says the score tracks opinion; the contrast pairs say the score
tracks *the right thing*. Both are needed, and the second is by far the cheaper of the two.

### 6.5 Rater protocol — the parts that are easy to get wrong

- **Raters must not see the machine score before rating.** This is the single most common way
  a study like this is ruined. Given the number first, raters anchor to it, agreement
  inflates, and `r` measures how well the rubric is explained rather than whether it is
  right. Score the machine side after the human side is submitted and locked.
- **Rate silhouette before colour.** `read_grid {view: "mask"}` first, on every image, before
  looking at anything in colour. Order effects are real and they run one way: having seen the
  colours, nobody un-sees them, and a `silhouette` score given second is really a score of
  "does the whole thing look good".
- **For `value`, rate in greyscale and *then* look at the shape of the shadow.** Two passes,
  in that order: greyscale judges the tone planes, and the second pass asks whether the
  terminator curves around the body or slices across it. Judged at once, a well-placed plane
  counts for a badly-shaped one.
- **No discussion before both submissions are in.** Same reason.
- **Fixed viewing conditions.** 1× (100%) for fine judgement, with a second look at 4× for
  structure. Never judge a whole piece zoomed in — upscaling turns a correct `cluster2` block
  into a visible dot grid, and raters who judge at 4× will systematically over-report `noise`
  and `dither-dominant`. The craft guide says this to agents; raters need it more.
- **Rate the image, not the concept.** No credit for a clever idea, none for a subject the
  rater likes.

### 6.6 What to do when `r` falls short

In this order, and not in any other:

1. **Move a threshold that a specific rater note argues for.** One threshold, one commit, with
   the note quoted in the commit message. This is what the calibration data is *for*.
2. **Re-weight** (`QualityWeights`). Weights are the most interpretable knob in the system and
   the cheapest to defend: "silhouette 300 → 340, noise 120 → 80" is a sentence a human can
   agree with. Re-balancing means the total changes for every existing asset, so it is a minor
   version bump. **The 500/500 split inside `value` (§4.2) is the first thing to try**, because
   it is the only sub-weight in the document with no measurement behind it at all.
3. **Reconsider the human side.** If inter-rater α is low, the rubric is ambiguous; rewrite
   the anchors in §4 and rate again. Do not tune the machine to fit a ruler that is wobbling.
4. **Delete the dimension.** If a dimension cannot be made to correlate across several
   attempts, it is measuring something that is not what it claims to measure, and shipping it
   would mean shipping confident nonsense. Removing it is a legitimate outcome of calibration.

**Never fit a learned model to the ratings.** A regression or a small classifier would very
probably reach a higher `r`, and it would be the wrong product: the score would stop being a
rubric a person can read, argue with and override, it would need a training set at runtime,
and its failures would no longer be explainable. The whole reason this layer exists is that
it is a set of stated rules rather than a set of learned weights. Keep it that way even if
the number goes up — and note that a learned model would also have *hidden* all four defects
in §6.2, because it would have learned to reproduce whatever the corpus's labels said and
never surfaced a measurement that was confidently mis-aimed.

## 7. Known limitations

A quality scorer that oversells itself is worse than none, because the failures are
confident. This section is the honest list, ordered by how badly it will bite.

**1. It has no idea what the sprite is.** It cannot tell a mushroom from a rock, a hero from
a crate. A deliberately abstract shape scores exactly like a well-formed blob, and a
perfectly-formed blob scores like a character. Every dimension is about *form quality*, none
is about *content*. Anything about art direction — is this the right silhouette for a
slime, is the read the right way round, is the weapon facing the cursor — is outside it
entirely.

**2. It scores a convention, and the convention is arguable.** Each of these is a defensible
default that a good artist will dispute:

| Convention | Where | Who will argue |
| --- | --- | --- |
| 4-connected silhouettes | §3.3, §4.1 | Anyone whose style uses deliberate diagonal-only contact. |
| Top-left key light | §4.2 | Anyone who lights from the right, or from below. |
| Punched holes are defects | §4.1 | Anyone drawing rings, handles, arches, chain-link, staves. |
| A 1px outline is the target | §4.5 | Anyone in a no-outline or heavy-outline tradition. |
| Colour budgets by canvas area | §4.3 | Scene artists, who use hundreds of colours and are right to. |
| An absent outline scores 700, not a penalty | §4.5 | Anyone for whom an outline is optional. This is the number most likely to draw fire. |
| 3–5px dither seams | §4.4 | Pointillists, and anyone whose texture is meant to be busy. |
| A tone plane must nest around the form | §4.2 | Hard-surface artists, whose straight face splits on straight edges are correct. The curvature gate is the concession and it is a blunt one. |
| The worst plane, not the average one | §4.2 | Anyone who thinks a single bad terminator is a fair price for four good ones. |
| 2–3px islands of tone are not noise | §4.4 | Nobody will argue this, which is why it is written down: the gap is ours, not theirs. |
| Anything is better than 0 | §4.4 | Artists who prefer visible grain. |

**3. It will be confidently wrong about soft lighting.** `palette` measures the *composite*,
by default. A translucent highlight layer composites two declared swatches into a colour that
is in no palette, so a sprite with a perfectly disciplined palette scores `off-palette` and
lands near 0.32 for it. This is a known false positive, not a subtle one, and it is the
single most likely reason for a good asset to fail the gate. The mitigations are all
upstream: `paletteLocked: true` with opaque layers, or `quantize_to_palette` before
evaluating. We chose not to loosen the threshold, because loosening it would let real drift
through — the cost of a false positive here is an artist or a `fix` pass, and the cost of a
miss is a muddy shipped asset.

**4. It cannot see intent, in either direction.** A deliberately asymmetric profile sprite is
penalised for nothing and credited for nothing. A deliberately held animation frame is
reported as `no-motion-content` and `frames-identical` when it was the right call. There is
no mechanism for "I meant that", because there is no mechanism for knowing.

**5. The form-conformance term is an approximation, and an honest one.** `spanQ` measures the
spread of the distance-to-boundary field along a tone plane, which is a *proxy* for "does
this plane follow the form", not the thing itself. It cannot distinguish a genuinely
concentric terminator from a wiggly one that happens to stay at a similar depth, and it cannot
tell a nested plane from a *deliberately* offset one — a rim light following an edge at 1px
and a core shadow following it at 3px both read as conforming, which is right, but a plane
that follows the form of a *different* form also reads as conforming, and that is wrong. It
also inherits one structural weakness: it says nothing about a plane that is the right shape
in the wrong place. A sprite whose cloak shading mirrors the body's contour when the cloak
hangs straight will score well here and read as wrong.

The curvature gate makes it usable on hard-surface art, and the gate is a blunt instrument: a
local count of convex staircase corners is a proxy for "this outline is round here", and a
tight polygon approximating a circle with few corners will fall below the 250/1000 threshold
and be treated as straight-edged. That is the safe direction — it downgrades a blocking
severity to an advisory — but it is a direction, not a solution.

**6. `noise` is the dimension most likely to sand a piece flat.** The redesigned
`colourOrphans` predicate is sharp — it fires only on a pixel that agrees with *nothing* —
and it is still blind to a 2–3px island of one tone inside another, because those pixels
agree with each other. Catching that and protecting a 2px specular dot are the same problem,
and `despeckle` ships `minClusterSize: 2-4` precisely so a cleanup pass will not delete a
deliberate highlight. The `ditherMask` (§3.3) cannot distinguish a legitimate 2px checkerboard
from a mistaken 1px stipple, so both are exempted from the noise measures and a heavily
textured sprite picks up a `dither-dominant` advisory it may not deserve. A `sparse` pattern
at low coverage is a further miss: at low coverage the region stops being a connected set of
two adjacent buckets and falls out of the mask entirely.

**7. It measures the frames you name.** A sprite whose frame 0 is strong and frame 5 is
broken passes when evaluated on frame 0. For an animation, evaluate a *tag* — the aggregator
resolves it into a playback-ordered `frameIds` — and treat a per-frame pass as a statement
about that frame only.

**8. It is not comparable across asset classes.** The weights are tuned for character sprites
and small props. An icon, a walk cycle, a tile and a 256×256 scene do not share a definition
of good, and one weight table cannot serve all four. Per-asset-class weight profiles are the
obvious fix and they are not built.

**9. It has no style, period, or era awareness.** It will happily mark a deliberately
chunky 16-bit look and a deliberately smooth modern one at the same score, because it only
measures relationships between pixels, never a target.

**10. Most thresholds here have still never been measured against human judgement.** §6.2
is the process that fixes that and it has run exactly once, on one sprite, and it found four
defects. That is a sample size of one. The thresholds in §4 are a *hypothesis under review*,
not a settled standard, and the ones that look most authoritative — the compactness band, the
`hueOnlyRatio` bands, the seam ratios — are the ones most likely to be quietly wrong in a
direction nobody has thought to test. Read the numbers as a starting point, and expect
§6.2 to move them.

## 8. Extending it

### 8.1 Adding a dimension

1. Add the id to `QualityDimensionId` in `types.ts`, and a `1000`-per-mille weight to
   `QualityWeights`.
2. **Re-balance the existing weights in the same commit.** The table sums to 1000, so a new
   dimension takes its share from somewhere. A table that only grows makes every existing
   dimension quietly less influential, and the total drifts for every asset that was ever
   scored.
3. New dimensions start at **≤ 80**. There is no such thing as a 300-weight seventh
   dimension, because the six that exist are the six that decide whether a sprite works in a
   game. If a new dimension seems to need more than that, it is probably two dimensions, or
   it is a style preference.
4. Implement `packages/core/src/quality/<id>.ts` against §3's contract, and give it its own
   §4.x section here — including the 1–5 human anchors, because a dimension with no human
   anchor cannot be rated on the benchmark and therefore cannot be calibrated.
5. Add its codes to Appendix A and to the `fix` code→ops map in T-023 in the same change. A
   code with no fix template is a code an agent can only complain about.

Adding a dimension changes the total for **every** existing asset, so it is a **minor version
bump**, never a patch.

### 8.2 Adding an issue code

- kebab-case, `<subject>-<problem>`: `loop-seam-pop`, not `LoopSeamPop` and not `seam_issue`.
  British spelling in prose-facing codes (`colour-budget-exceeded`), matching the rest of the
  documentation.
- Pick a fixed severity from §3.5's meaning: ~0.20–0.25 advisory, ~0.30–0.45 worth fixing,
  0.50–0.60 blocks, 0.70+ is a hard failure. Severity is a property of the **class** of
  mistake.
- `rect` must be the smallest rect that a `fix` op can act on, or `null`. An issue with a
  whole-canvas rect when a 3×3 region is wrong is a report nobody can act on.
- Document it here with its trigger condition, its severity, and whether it blocks. A code
  without a trigger condition is a guess.

### 8.3 The compatibility promise for codes

**Within a major version, a published code keeps its `code` string, its `severity`, and the
dimension that emits it.** That is a hard promise, and it is a promise about *dependents*:
`fix` (T-023) maps codes to op templates, agents branch on codes, and CI gates encode
thresholds per code. Renaming `loop-seam-pop` to `loop-seam` breaks every one of those in
ways no changelog entry makes obvious.

What *may* change in a minor version:

- **New codes**, added additively. An agent must therefore treat `code` as an open string and
  tolerate a code it does not recognise — which is why it is a string on the wire and not an
  enum, and why unknown codes are ignored rather than rejected.
- **A threshold**, and therefore a score. This is a behaviour change, not an API change: it
  goes in the changelog with the calibration `r` before and after, so a score change is
  always traceable to a measurement.
- **A code being deprecated**, when the condition it described no longer fires in practice.
  It keeps working and keeps its name for the rest of the major version; it is removed at the
  next major, and its `fix` mapping is removed with it.

What may **not** change without a **major** version: a code's spelling, a code's meaning, a
code's severity band, a code moving to a different dimension, or the shape of an issue.

**One exception has already been taken, and this is the record of it.** `colour-outlier` was
retired in favour of `stray-colour` (§4.4) because the measurement behind the name was
replaced outright, and a stable code with new semantics is precisely the failure this section
exists to prevent. It was legitimate for one reason only: no analyzer had shipped, so no agent
had branched on the string. That window is the entire budget for this kind of correction, and
it is gone the moment T-012 through T-017 land. After that, a measurement that turns out to be
aimed at the wrong thing gets a **new** code, and the old one is deprecated rather than
repurposed.

## Appendix A — issue code index

Every code `evaluate` can emit, who emits it, at what severity, and whether it blocks. This
is the API surface: agents branch on `code`, `fix` maps `code` to ops, CI gates encode
thresholds per code. See §8.3 for what may and may not change about a row in this table.

| code | dimension | severity | blocking |
| --- | --- | --- | --- |
| `detached-pieces` | `silhouette` | 0.45 | no |
| `interior-hole` | `silhouette` | 0.40 | no |
| `thin-profile` | `silhouette` | 0.30 | no |
| `shape-clipped` | `silhouette` | 0.80 | **yes** |
| `subject-undersized` | `silhouette` | 0.30 | no |
| `fragmented-silhouette` | `silhouette` | 0.70 | **yes** |
| `plane-crosses-form` | `value` | 0.30 / 0.60 | **yes** at 0.60 |
| `hue-carries-form` | `value` | 0.30 / 0.60 | **yes** at 0.60 |
| `narrow-value-range` | `value` | 0.45 | no |
| `flat-value` | `value` | 0.55 | **yes** |
| `key-light-inconsistent` | `value` | 0.25 | no |
| `shadow-crushed` | `value` | 0.50 | **yes** |
| `highlight-blown` | `value` | 0.45 | no |
| `off-palette` | `palette` | 0.35 / 0.55 | **yes** above 0.20 ratio |
| `colour-budget-exceeded` | `palette` | 0.35 | no |
| `hue-sprawl` | `palette` | 0.30 | no |
| `muddy-mix` | `palette` | 0.35 | no |
| `grey-colours` | `palette` | 0.30 | no |
| `invented-colours` | `palette` | 0.40 | no |
| `isolated-pixels` | `noise` | 0.40 | no |
| `diagonal-seam` | `noise` | 0.45 | no |
| `stray-colour` | `noise` | 0.35 | no |
| `single-pixel-spur` | `noise` | 0.30 | no |
| `near-duplicate-colours` | `noise` | 0.35 | no |
| `dither-dominant` | `noise` | 0.35 | no |
| `outline-missing` | `outline` | 0.20 | no |
| `outline-gap` | `outline` | 0.25 / 0.35 | no |
| `outline-inconsistent-weight` | `outline` | 0.45 | no |
| `outline-colour-split` | `outline` | 0.25 | no |
| `outline-heavy` | `outline` | 0.50 / 0.70 | **yes** at 0.70 |
| `loop-seam-pop` | `motion` | 0.30 / 0.55 | **yes** at 0.55 |
| `loop-seam-jump` | `motion` | 0.55 | **yes** |
| `frame-jitter` | `motion` | 0.50 | **yes** |
| `silhouette-instability` | `motion` | 0.30 / 0.60 | **yes** at 0.60 |
| `timing-outlier` | `motion` | 0.35 | no |
| `timing-mismatch` | `motion` | 0.45 | no |
| `loop-duration-out-of-range` | `motion` | 0.30 | no |
| `empty-frame` | aggregator | 1.00 | **yes** |
| `frames-identical` | aggregator | 0.35 | no |

**Retired: `colour-outlier`.** It measured distance from the local median colour, which counted
boundary length rather than stray pixels, and it is replaced by `stray-colour` (§4.4). The
rename is deliberate and breaking, because the *meaning* changed completely and §8.3 forbids a
stable name with new semantics. Nothing has shipped that branches on the old string; it must
not be reintroduced.

**Added in this amendment: `plane-crosses-form`** (`value`, 0.30 / 0.60, blocking at 0.60) —
the form-conformance term's issue, and the one that separates a flat sticker from a lit volume.

Codes with two severities fire at the higher one past their stated threshold; the threshold is
in the dimension's issue table in §4. Exclusion reasons (`single-frame`, `no-motion-content`)
are **not** issue codes and live in the required `excluded` map (§3.6) — nothing should branch
on an exclusion reason as if a defect had been found, and both have exactly one producer
(§4.6).
