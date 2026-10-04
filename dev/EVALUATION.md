# Pixel-art quality evaluation — the scoring specification

<p align="center">
  <a href="EVALUATION.md">English</a> · <a href="EVALUATION-ZH.md">中文</a>
</p>

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
| `regionCurvedQ(r)` | For a tone region `r`: `rhu(stairCorners(r) * 1000, boundary(r) + 1)`, where `boundary(r)` counts the pixels of `r` with at least one 4-neighbour outside `r` — a different region, transparent, or off the canvas — and `stairCorners(r)` is how many of those are a **convex staircase corner of `r`**. The whole boundary, including whatever the region happens to be touching. See below. |
| `planeCurvedQ(a,b)` | The same density for region `a` with **region `b` taken out**: `rhu(corners(a\b) * 1000, boundary(a\b) + 1)`, where `boundary(a\b)` is the boundary of `a` minus every pixel of it that has a 4-neighbour in `b`. This is what §4.2's gate reads. See below. |
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

#### `regionCurvedQ`, and why a second curvature reference had to exist

`convexCorner` above is a predicate on the **subject's** mask, and §4.2's curvature gate spent two
years of this repository's history reading its curvature through that one door. On a full-bleed
document the door is a wall: the subject reaches every edge, so its outline *is* the canvas
rectangle, the whole picture has four convex corners, and none of them is near a plane in the
middle of a landscape. Measured, `curvedQ` read **0..77 on all ten** committed scenes against a gate
of 250, so every plane in every one of them was exempt and a straight shadow band drawn across a
curved mountain was not scored — it was reported as `unmeasured`, which is the one answer an agent
cannot act on.

**No threshold fixes that**, and the reason is geometric rather than a matter of tuning: when the
mountain reaches the edges it *is* the frame, so "the frame" and "a curved form" are the same set of
pixels and no value of a gate separates them. The fix had to be a curvature source that does not come
from the silhouette, and the only one the document has is **the shape of its own tone regions** — the
dome is a curved form whether or not anybody drew its edge.

Three decisions, and the second is the one that would have been got wrong by default.

**It is a density and not a count**, for a different reason than T-022 removed `compactnessQ`'s
scale-dependence. T-022 needed a shape *descriptor*, and a descriptor that cannot tell a 3px blade
from a horizonline cannot describe shape. This is a *gate*, and a gate needs to know what
**fraction** of the nearby boundary turns; a count would make the answer depend on how many boundary
pixels a region happens to have, which is a property of its size. A 3px band on 32×32 and the same
band on 4096² are both straight, and both read 0. **A density is also what makes the new reference
safe to take as a maximum**: it is bounded by 1000 like the reading it is combined with, so it can
raise a gate and never invert one.

**The first version left the plane inside its own region's boundary count, and T-101 reversed that
decision on a measurement.** The reasoning was sound and is worth keeping as the shape of the
argument: a region's boundary always *contains* the terminator, so including it can only dilute the
ratio and can never manufacture curvature the form does not have, which keeps the gate failing
toward "cannot measure" — the direction every gate in this document is built to fail in — and it
keeps the quantity to one pass over the canvas rather than one per terminator, and a 512² scene in
this repository carries 1008 terminators.

**It was not enough, and the way it failed is not something the argument above predicts.** A straight
band drawn across a curved dome read `curvedQ` **260** at y=34 and **248** at y=40, against a gate
of 250. The dome did not change; the band moved. The band's own region is a perfect rectangle and
reads 0, while the dome region it cuts has a boundary made of an arc *plus* the straight cut, and
all of the corners come from the arc — so the cut sits in the denominator diluting the thing being
asked about. Where the band crossed a **wide** part of the dome the arc outnumbered the cut and the
reading cleared; where it crossed a **narrow** part near the frame the cut outnumbered the arc and it
did not. **Whether a straight cut was caught came to depend on where it had been drawn, which is not
a gate, it is a coin toss.**

**So `planeCurvedQ` asks about the region MINUS this neighbour** — the form the plane cuts, without
the plane — and the direction of the two refusals above survives the change, which is the test of
whether they were sound. It still cannot manufacture confidence: a region whose **only** boundary is
the plane is left with nothing and reads **0**, which is still "cannot measure". And it is still one
pass over the canvas, because the exclusion is per region **pair** and not per terminator: a 512²
scene's 1008 terminators read it in O(1) each out of a table built in one scan.

**The counters are keyed by the ordered pair, and that is the whole correctness of the function.**
"How much of `a`'s boundary is against `b`" and "how much of `b`'s boundary is against `a`" are
different numbers. The first implementation keyed a single `Map` per *unordered* pair and both sides
subtracted the same total, which double-counted and produced a density of **7385** on a hand-built
dome — an impossibility, since a density cannot exceed 1000, caught by the corpus assertion on its
first run. Two further details are load-bearing and were also found by measurement rather than by
reading: a pixel with two neighbours in the **same** region must be counted once or `cut` exceeds
`boundary` and the density divides by zero (`NaN` on `artwork/sunset-lighthouse-512.pixel`); and a
pixel is excluded from a side only when the neighbour is a real region — **not** when it is
transparent or off-canvas, because a region's edge against the background is the form's own outline,
which is the thing being asked about.

**The staircase predicate has one definition and two call shapes.** `regionCurvedQ` asks
"is this neighbour in *this* region", which is a labelled subset of the canvas rather than a mask, so
the predicate takes a membership test and `convexStaircaseCornerAt` is the `Uint8Array` call into it.
A second copy of the quadrant walk is exactly the kind of thing that looks right in both copies and
differs by one quadrant.

**What it discriminates, measured.** A straight-edged box is a stack of horizontal bands, so every
band's boundary is two straight runs and the density is low — `value/hard-surface-terminator-32`
reads **93** against a gate of 250 and keeps §4.2's exemption for "a straight plane across a
straight-edged form is correct, not wrong", and **T-101 did not move it by a single unit**, which is
the check that matters: excluding the band between two bands of a box leaves straight runs on both
sides, so there was nothing there to recover. A dome is nested ellipses, so every crescent's boundary
is an arc — `value/terrain-following-terminator-64` reads **426** and is judged, and comes back clean
at `crossesQ` 0. On the same two documents the silhouette reading is 65 and 0, which is the
measurement that says the new reference is what moved. The ten real scenes read **667..880**.

**And the pair that separated 260 from 248 now reads 333 and 420**, both clear of the gate, which is
the property T-101 bought. See §4.2 for what that does and does not fix.

**What is still not fixed, and it is a different quantity.** With the gate no longer position-
dependent, `value/straight-band-over-terrain-64` is caught — and `crossesQ` there is *exactly* `splitQ`,
because `bendQ` is 0 and `bendQ` is the only thing that could have damped it. So whether a straight
cut is **reported** now depends on §4.2's multiplier rather than on this gate: the same band at y=40
reads `splitQ` 676 and fires `plane-crosses-form`, and at y=34 it reads 501, lands in §4.2's `<= 600`
band at `formQ` 550, and reports nothing. That is §4.2 working — `splitQ` exists so a crescent against
a fat field is not read as a cut through the body, and a band that leaves two thirds of the dome below
it is not bisecting the form — so it is asserted in the corpus rather than wished away.
**Lowering `CURVATURE_GATE` is still not a fix for anything**: it would admit
`value/hard-surface-terminator-32` at 93 by another route and re-open the question §6 settled.

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
ditherShare  = rhu( (pixels with ditherMask == 1) * 1000, N )
```
The alternation count is a **count**, not a flag, because `alternating * 1000 >= 400 * |R|`
compares it against the size of `R` — a component alternating over 40% of its pixels has to be
able to say so. It also means `ditherShare` is integer per-mille like every other ratio in this
document (§3.7), where the first version of this section wrote it as a bare fraction.

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

**The first implementation of that clause counted one pixel and stopped.** It early-exited the
scan over `R` on the first alternating pixel, as an optimisation, which capped `alternating` at 1
for every component. With `|R| >= 8` the gate `1 * 1000 < 400 * |R|` is then true for every
component that can reach it — `400 * 8 = 3200` is already greater than 1000 — so `ditherMask`
returned nothing on **every case in the corpus**, a perfect 50% checkerboard among them, which is
the structure it exists to find. It reported "no dither anywhere" and meant "this counter cannot
exceed 1", and the two sentences are indistinguishable from the outside. A measurement that
cannot fail is not a measurement, so the honest reading of a structural zero is a broken
instrument rather than an absence in the world. §7 records what turning it on cost.

**What the corrected instrument says.** Per-mille, measured across the corpus: every declared
`clean-control` reads **0** — all six `control/*` negative controls included, which is the
property that matters and the one the broken version also appeared to satisfy — and so do
`human/item-16`, `human/tile-32` and `human/scene-64`. The ten committed artworks read 1, 3,
4, 38, 38, 91, 107, 389, 523 and **574**, the last of them
`artwork/verify/lantern-keeper.pixel`; `app/icon.png` reads 29. The two largest readings in the
corpus are `value/straight-diagonal-32` at **261** and `value/level-set-32` at **427**, and both
are synthetic value cases drawing 1px contour lines — which is §4.4's reason for having no dither
verdict at all rather than a tuned one.

**What this costs.** A 2px checkerboard is a legitimate technique at 32×32 and above — it reads
as a soft tonal step rather than as digital stipple, which is exactly why the craft guide
recommends `cluster2`/`cluster4` on large canvases. The predicate cannot tell a *legitimate* 2px
cluster from a *mistaken* 1px stipple, so both are detected and both are exempted from the noise
measures (§4.4). A `sparse` pattern at low coverage is a further miss, since at low coverage a
region stops being a connected set of two adjacent buckets and falls out of the mask entirely.
`ditherShare` is therefore a **measurement on the frame record and never a verdict**, and §4.4
says what follows from that.

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

#### What crosses the boundary, and under what name

`types.ts` is frozen and the shape above is the contract, so everything *inside* a
`QualityReport` keeps the spelling `types.ts` gives it: `score` is the 0..1 float
`unitScore(totalQ)` produced, and an issue's `severity` is the 0..1 constant from Appendix A.
Two surfaces project that report outward and both rename its numbers, which looks like drift and
is not:

| surface | units | why |
| --- | --- | --- |
| `QualityReport`, and the MCP `evaluate` tool that re-renders it verbatim | `score` 0..1, `severity` 0..1, `scoreQ` per-mille inside a dimension | it is the **record**. §3.6 freezes the shape, so the units in it are part of the contract and the MCP tool re-renders rather than projects. |
| the `evaluate`, `fix` and `verify` commands | per-mille for **every** number: `scoreQ`, `severityQ`, `thresholdQ`, `measuredQ` | these are the numbers a caller may compare against a threshold, and §3.7's rule is that such a comparison is an integer test with no epsilon. |

The conversion is one line per surface (`Math.round(severity * 1000)`) and it is exact for every
severity in Appendix A, all of which are two-decimal. One unit on the side of the boundary a
caller acts on is worth more than one unit everywhere.

**Two targeting arguments are spelled differently on the two sides, and both choices are
deliberate.** The three commands take `frames` — an array, because the bus needs to name a whole
sequence and a one-element array *is* a per-frame pass — and `focus`, which is `QualityContext`'s
own internal name. The session tool takes `frame`, a scalar, because it has exactly one such
option and its own `tag` for the loop, and because `frame` is what its 36 neighbours in that
namespace already use; and `rect`, because that is what every other region argument on the wire is
called and a tool argument should not be named after the field of the object it happens to
populate. `pixel://quality/{doc}` follows the tool (`?frame=N`) because a URI query cannot carry a
JSON object, which is also why that resource points a caller who wants a scoped report at the
tool. The rule underneath all three is the one that matters: **they select the same frames and the
same region, so the same document returns the same report on every channel.**

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
| `meanSat` | `< 15/100` | `sumS255 * 100 < 15 * 255 * N` |
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

#### One threshold deliberately not in that table

`severity` is absent from the table above, and the reason is that it is not a ratio. It is a
**fixed per-code constant** from Appendix A, not a measurement of this sprite — §3.5 says so in
as many words: "the severity is the code's stated severity, not a per-sprite measurement". A
constant has no arithmetic to transcribe: there is one number per code, and `SEVERITY_BLOCKING` is
`0.5`, which every value in Appendix A clears or misses by at least 0.05.

The one float comparison this leaves in the pipeline is `isBlocking(issue)`, which evaluates
`severity >= 0.5` directly. It is recorded here rather than argued away because rule 2 above is
stated about §4 and this one lives in the frozen `types.ts`. **It is exact today** — every severity
in Appendix A is two-decimal, so `round(severity * 1000) >= 500` and `severity >= 0.5` are the
same predicate, and the command boundary publishes both fields side by side without them ever
disagreeing. It would stop being exact the moment a code shipped a three-decimal severity, which is
why §3.6's projection table puts the per-mille form on the side of the boundary a caller acts on.

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


#### What shipped, and the four readings this section left open

`motion` is registered against `motionApplicability` unchanged, so the applicability argument above
needed no revision: the exclusion is the aggregator's and the analyzer is never reached for either
reason. `MotionSequence` is the measurement record and `measureMotion(context)` is exported beside
the other five analyzers' `measure*`. Four things §4.6 does not state were decided rather than
derived, and each is written down here rather than left in the code:

1. **The median is the LOWER median** of the internal transitions — `values[floor((n - 1) / 2)]` of the
   sorted set — which is the same reading `benchmarks/corpus/report.ts`'s `distribute` uses. Every
   input is an integer count, so there is no rounding question; the choice only decides which of two
   adjacent integers a set of even length reports, and having one median in this repository is worth
   more than having the better of the two.
2. **The seam-ratio table is read ASCENDING with a `return`, not with an overwrite.** This is the
   opposite of §4.5's `outlineShare` table and the right way round for this one: `outlineShare`
   *rewards* a high ratio so its rows are walked upward and the last match wins, while the seam
   ratio *punishes* a high ratio so the first match wins. Read either in the other's direction and
   the §4.4 inverted-band defect returns — a descending walk gives a ratio of 0 the loosest row.
   **At ratio 0 this table returns 1000, and that is right**: a loop whose seam changes nothing has
   earned the top band, and the sequence that would earn it dishonestly (every frame identical) is
   the one the exclusion removes before the analyzer runs.
3. **`loop-seam-pop` is the one code in the table below with no Δ row.** The band table has already
   priced the pop; the code exists to name it. Severity is 0.30 past 1.75 and 0.55 past 2.50, so the
   blocking half is the 2.50 row rather than the 1.75 one.
4. **A frame with no ink is excluded from the area and centroid rows and from nothing else.**
   `areaSpread` divides by the mean area and a blank frame has area 0, so unguarded it reads
   `rhu(64 * 1000, rhu(64, 2)) = 2000` on a two-frame sheet — a per-mille 1000 twice over on a
   document whose real defect is `empty-frame`, which the aggregator already reports at severity
   1.00. This is §4.5's per-frame Δ guard arriving one dimension later, and the guard is
   `MotionSequence.inkedFrames`. Churn keeps blank frames, because a frame going blank really does
   change that many pixels and the reading about it is true.

**The cost of that last one is stated rather than hidden**: on a sheet where fewer than two frames
carry ink, the area and centroid rows have nothing to compare and stay silent. No `ExcludedReason`
names that absence and none was added, because the only way to reach it is a document the aggregator
has already blocked on `empty-frame` at severity 1.00 — a new member of a closed vocabulary that
no agent can ever branch on is a cost, not a fix.

#### What the corpus reached, and the five codes it did not

`motion` is the one dimension whose corpus distribution cannot be read as "does it fire on good
work", because the corpus has **two** sequences it can measure out of 76 buildable cases:
`motion/worst-frame-wins-16` and `motion/blank-frame-16`. Every other case is `single-frame` and
`motion/frames-identical-16` is `no-motion-content`. That is the exclusion working — it is also why
`evaluate` reports `single-frame` on 73 rows instead of `not-implemented` — and it is the reason the
remaining coverage below is stated as a gap rather than quietly left.

**One code of the seven has a corpus case: `silhouette-instability`,** carried by
`motion/worst-frame-wins-16`, whose frame 0 is a 64px block and whose frame 1 is three masses
totalling 54px — `areaSpread` `rhu(10 * 1000, rhu(118, 2)) = 169` against the 150 gate, a real area
change drawn in on purpose. That case's verdict moved from `warn` to `fail` when this dimension
landed, and the direction is the finding: it is the only row in the corpus whose *clean* subject
turns out to flicker. `motion/blank-frame-16` reads 1000 with no issue at all, which is the guard in
point 4 above holding on the one case designed to break it.

**The other six — `loop-seam-pop`, `loop-seam-jump`, `frame-jitter`, `timing-outlier`,
`timing-mismatch` and `loop-duration-out-of-range` — have no corpus case and are owed one each.**
§3.5's fourth rule is that a code cannot be declared until a case says what it means, so they are
absent from `DEFECT_KINDS` rather than present-and-red: adding the members without the cases would
make the closed list a list of unimplemented features, which is the failure the list exists to
prevent. They are covered today by MUST FIRE / NEAR MISS pairs in `quality-motion.test.ts`, which
is a regression guard but not the corpus's ground truth by construction, and the difference is the
whole reason `benchmarks/` exists.

**Six named thresholds, measured against nothing, and §10 item 10 covers why.** No loop in this
repository has been rated by a person who then looked at these numbers, so the seam bands, the
`areaSpread` steps and the timing gates are a hypothesis in exactly the sense §6.2 uses. The one
thing that can be said now is that §4.6 is the only dimension here whose defects are objective — a
loop that pops by arithmetic is wrong whichever way a person draws the next frame — so it is the
cheapest of the six to calibrate and the one a rater would be least likely to argue with.
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

> **This subsection was rewritten after the term was implemented and measured, and the reason is
> the whole of it: the term specified here originally did not survive contact with real artwork.**
> The original term was the *spread of `dist` along a plane boundary*, and it is worth keeping the
> reasoning, because the second attempt is only legible as a correction of the first.

`dist(p)` (§3.3) is how deep inside the body a pixel sits. A **concentric** terminator is a
*level set* of that field: every pixel along it sits at roughly the same distance from the
silhouette edge, because it is tracking the contour. A **straight diagonal** cut across a rounded
body is not — it enters where `dist` is 0, crosses the body, and leaves where `dist` is 0 again,
with the middle far deeper than either end. So the spread looked like the measurement, and it needs
no contour tracing, no curve fitting and no float. It is also wrong, in both directions at once.

**It rewards a target and punishes a sphere.** A level set has a spread near zero and scored as a
perfect form-following plane; a *translated* contour runs from the silhouette's own edge out to its
deepest reach, so its spread is as large as the body is deep. A correctly shaded round body is made
of translated contours: `demo.ts` walks its `[left, right, y]` rows `inset` pixels in and displaces
them along the light axis, and every plane except the core shadow is a pure translation. Measured
on the product's own reference sprite, the specified term banded it at `formQ` 100 and fired
`plane-crosses-form` at blocking severity — **the reference artwork failed for using the technique
the product teaches.** The corpus case that records the bias is `value/level-set-32` against
`value/nested-contour-32`: the same body, the same five tones, the same five planes, the same four
boundaries, and the specified term ranked them in the wrong order.

`spanQ` is therefore still computed, still recorded, and **deliberately not scored**. It is the
most informative number in the record — it is what a person needs in order to understand a piece —
and it is the standing evidence that the specified term was biased, so the generated report prints
it beside the score on every case, including the ones that are correct. The evidence is now 91
against 909, which is ten times the gap the original reading produced.

What replaced it is the plane's own geometry, which is invariant under translation by
construction. What is true of both a level set and a translated contour, and false of a straight
cut, is that the boundary **turns**.

```
toneEdge(p)        p is solid with a solid 4-neighbour in a different LqBucket
planes             the 8-connected components of toneEdge, keyed by the PAIR of tone
                   regions the two sides separate; components under 4 pixels are
                   discarded — a 2px step is a dither artefact or a mistake, not a plane

for each plane P:
    dirs        the distinct 8-step directions P's own pixels walk, collapsed to
                half-planes, so (-1,0) and (1,0) are one orientation
    dirQ        rhu((min(|dirs|, 3) - 1) * 1000, 2)
    surplusQ    clamp(rhu((|P| - extent(P)) * 1000, extent(P)), 0, 1000)
    bendQ       max(surplusQ, dirQ)      the WEAKER of two readings of "it turns"

    splitQ      rhu(min(areaA, areaB) * 1000, max(areaA, areaB))
    reachQ      rhu(min(extent(P), bodyExtent) * 1000, bodyExtent)
    curvedQ     max of the three curvature references; see below

    crossesQ = (curvedQ < 250 || reachQ < 500) ? 0
             : rhu((1000 - bendQ) * splitQ, 1000)        // higher is worse

formQ = band( max over planes of crossesQ )              // the WORST plane
```

**`curvedQ` is the maximum of three references, and the second and third are not optional.** The
first is the one this subsection originally specified: staircase corners on the subject's own
silhouette within Chebyshev 3 of the plane, scaled by the silhouette edge pixels in the same
neighbourhood. The second is §3.3's `regionCurvedQ` over the two tone regions the plane separates,
whole boundary. The third is §3.3's `planeCurvedQ`, which is the same density with **the plane's own
boundary removed**, and it is the one that decides.

**Why three, and why the third had to exist.** The first is inert on a full-bleed document, because a
full-bleed subject's outline is the frame: it read 0..77 on all ten committed scenes against a gate
of 250. The second fixed that, and the ten scenes went to 667..880. But the second still let the
plane sit in the denominator of the reading, and a straight band across a dome read **260** at y=34
and **248** at y=40 — caught at one row, excused at the other, for no reason a person could act on.
Whether a defect was caught depended on where it had been drawn. Removing the plane from its own
region's boundary makes both rows clear the gate, and `value/straight-band-over-terrain-64` is the
positive half of that pair.

**A maximum, and it promises less than it first appears to.** A maximum can only make the gate
*more* permissive, never less, and that has one precise consequence: **every plane already judged
before is still judged, with an identical `bendQ` and `splitQ`, so every score derived from it is
unchanged.** That is what the max buys, and it is a real guarantee. The stronger and vaguer claim
that "nothing with a readable outline moves" is **false** and was measured to be so during
acceptance: adding the second reference changed `curvedQ max` on **32 of 59** rows while moving no
score at all. Adding the third moved `gated` on 8 rows and `curvedQ max` on 4, again with **no score
moving anywhere** — nine more planes became judged on the committed artwork and every one of them
came back clean, which is the *reason* improving rather than the number.

**And what no score moving does not mean.** It means nothing in this corpus got worse. It is not
evidence that the committed artwork has no defects, because the corpus cannot see a defect the gate
still declines to open on, and §6's human-rated tier is the only instrument that could say. Nine
more judged planes reading clean is a weaker claim than it looks, and it is recorded that way.

The full-bleed scenes are where the capability was actually missing: they go from 0..77 to 667..880
through this line, three of them acquire a measured `formQ` of 1000 that they previously reported as
`unmeasured`, and `value/hard-surface-terminator-32` — the box, the gate's own negative control —
stays at 93 through both additions and keeps its exemption.

**A maximum, and it promises less than it first appears to.** A maximum can only make the gate
*more* permissive, never less, and that has one precise consequence worth stating: **every plane
already judged before is still judged, with an identical `bendQ` and `splitQ`, so every score
derived from it is unchanged.** Across the corpus, no `value`, `formQ` or `crossesQ` moved for any
subject with a readable outline. That is what the max buys, and it is a real guarantee — the
stronger and vaguer claim that "nothing with a readable outline moves" is **false**, and was
measured to be so during acceptance: `curvedQ max` changed on **32 of 59** rows,
`artwork/verify/lantern-keeper.pixel` went 500 → 750 and `1 curvature, 4 reach` →
`0 curvature, 5 reach`, and twenty `sweep/rect-*` rows went from 0 to 48..114. In most of those the
*reason* improved rather than the number moving: a plane that used to be "not asked" is now
examined and returns clean.

And the full-bleed scenes are where the capability was actually missing: they go from 0..77 to
667..880 through this one line, three of them acquire a measured `formQ` of 1000 that they
previously reported as `unmeasured`, and `value/hard-surface-terminator-32` — the box, the gate's
own negative control — stays at 93 and keeps its exemption.

That in turn demotes the document-level short-circuit from a veto to a fallback. While the gate had
only the silhouette reference, "this subject fills the canvas, so its outline is the frame, so the
gate abstains" was a correct description of the mechanism, and it fired *before* any plane was
consulted. It stopped being correct the moment the gate grew a second reference: a document with no
outline can have judgeable planes, and when it does the dimension has an opinion and must state it.
The branch now only decides what happens when **every** plane was gated anyway. §3.3 records the
measured limitation of the new reference — whether a straight cut is caught still depends on which
tone region it crosses, 260 against 248 either side of the gate — and states why lowering the gate
is not the fix.

Two clauses in the `planes` definition are not §4.2's, and both earn their place. **A plane is an
area, not a line**: a tone region counts only if at least one of its pixels has three or more solid
4-neighbours in the same bucket, so a traced contour, a rim light, a 1px highlight, a mouth and a
dither speck are all excluded. **A boundary is keyed by the region pair**, because two boundaries a
pixel apart are 4-adjacent whichever side you canonicalise to. Without both, the tone-edge set fuses
into 386 of 491 solid pixels in a single component on `pixel demo`, `planes` is 1 on every version,
and the term measures one ring containing every boundary in the sprite at once. With them it is 5.

Four decisions in the block above each needed a measurement, and three of them exist because the
naive version produced a confident wrong answer.

**The weaker of the two bend readings wins.** A rasterised 45° staircase drawn two pixels wide is a
solid staircase and reads as bending; the one-pixel boundary of a gentle arc is locally straight and
reads as not bending. Either reading alone puts real artwork on the wrong side of the table, and the
failure they share — a **missed** straight cut — is the direction this dimension is allowed to fail
in: a missed dither seam is one advisory not emitted, and a working artist told their transition is
broken is the expensive error.

**The direction ladder saturates at three orientations, not four.** The half-plane collapse leaves
four, and an open boundary on a convex body cannot use the fourth without closing: right, down,
left, up is a loop. Dividing by four therefore reads a maximally-turning arc at 667 and the ring
enclosing it at 1000, which put the product's own taught construction 250 per-mille below the
target-like one on the same body with no defect on either side. Three orientations is where a
boundary has stopped being a line and started tracking something, and a fourth is the same evidence
with the ends joined rather than more of it.

**`splitQ` is the only multiplier, and it is the clause that makes a crescent safe.** A level set
and a translated contour both produce a thin sliver against a fat field; a straight cut produces two
fat halves. It is also what stops a locally straight fragment of a curved boundary from being read as
a cut — the tangent piece of a translated contour is geometrically a straight run, and no local
measurement can tell it from one.

**Two gates, both failing toward "cannot measure".** `curvedQ` at 250: a straight plane across a
**straight-edged** form is correct, not wrong, so the lit face of a box meeting its shadow face along
a line must not be failed. `reachQ` at 500: a boundary that does not cross the body is a fragment,
not a cross-section. `pixel demo` shades with 1px and 2px crescents whose ends die out at the
silhouette — five pixels down the right flank, nine along the bottom — and a term that judged those
as boundaries read the reference artwork as a flat sticker, blocking. §4.2's own floor of 4 pixels
is a floor on *existence*; `reachQ` is a floor on *consequence*, and they are not the same question.

**The worst plane, not the average.** Unchanged, and for the original reason: one straight cut
through the chest gets averaged away by four well-formed contours on the arms and the cloak. The
defect is *one plane in the wrong place*, and the measurement that survives it is the minimum. This
is a deliberate asymmetry with §5.3, which uses a weighted mean for the same reason and puts floors
underneath it — and a floor cannot help inside a single dimension.

**One rejected alternative, recorded because it is the next thing anyone will try.** "Is this
boundary locally parallel to the silhouette's own edge?" unifies the two acceptable constructions
*by definition*, since a level set and a translation are both offsets of the outline. Measured, it
is worse than useless: a straight 45° cut across a round body scored 923 and the translated contour
scored 0, because a chord is locally parallel to the outline over the middle of its run while a
translation is parallel to a *shifted* copy of it. The general lesson is the one worth keeping: **no
local geometric property unifies a closed offset and an open one**, because a loop turns strictly
more than an arc of identical curvature — that is geometry, not a bug. They can only be unified by
declining to rank them against each other, which is what saturating the ladder does.

**The dependency on §3.3's dither mask is stated and not yet implemented here.** A dithered seam is
a boundary between two tones by this definition, and excluding it before planes are built is a
correctness requirement rather than a convenience. `ditherMask` is §3.3's largest predicate and
`noise` (§4.4) is its declared consumer, so implementing it twice would put a second home in the
repository for one quantity. The "a tone region must be an area" rule covers the common case anyway
— a 1px Bayer field and a `cluster2` pattern have no pixel with three same-bucket 4-neighbours, so
they are not planes and the seams against them are not planes' business — and every remaining path
through the dither question is a false negative, which is the safe direction.

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
planes, bendQ, splitQ, reachQ, curvedQ, crossesQ, formQ   as specified above
spanQ    the depth spread, computed and recorded but deliberately not scored — see above
```

**When the form term is unmeasured, and when it is merely clean.** These are different claims and
conflating them is the single largest measurement defect this dimension had. `formQ` is `null` —
absent, with the reason on `QualityDimension.unmeasured` and a sentence in the verdict — in exactly
one situation, and it used to be a broader one than it is now:

> **Every plane in the document was gated.** §4.2's curvature gate asks whether the local form is
> round, and `reachQ` asks whether a boundary crosses the body rather than dying out as a fragment.
> A subject that fills the canvas used to fail the first of these for a reason about the *document*
> rather than the artwork — its outline is the frame, so there were four convex corners in the whole
> picture and none near an interior plane, and `curvedQ` was 0 on every plane of every frame. That is
> no longer a reason, because the gate reads a second reference (§3.3's `regionCurvedQ`) that does not
> come from the silhouette. What remains is the honest per-plane answer, and it is an answer about
> this picture: nothing here was judgeable.

`value` itself stays applicable to a full-bleed scene — its tone half measures one, and §4.2 is
written for scenes — so the dimension is present, contributes its measured half at full weight, and
declares the other. Measured on the corpus: `maxCurvedQ` over every plane is 0..77 against the 250
gate on all ten real scenes, and the report read `formQ` 1000 and `value` 950 on every one of them
before this was separated. A perfect sub-score for a measurement nobody took is the failure
`QualityDimension.unmeasured` exists to make impossible, and it was worth more of the dimension's
weight than the half that *was* measured.

Three cases are deliberately **not** unmeasured, and collapsing them into the above is a mistake this
document has already made once:

- **No tone plane at all** — a flat single-tone sprite. `formQ` 1000, no issue. Inventing a penalty
  would be the scorer grading an absence as a defect, and §4.2 legislates the 1000.
- **Every plane gated, on a subject that has an outline** — a hard-surface box, a rectangle. The
  gate abstained *and the abstention is the answer*: a straight terminator across a straight-edged
  form is correct, the term examined the planes and found nothing to complain about, and reporting
  "unmeasured" here would mark down clean sprites for the scorer's blindness. A first attempt at
  this separation did exactly that and dropped three clean controls from `pass` to `warn`, and dropped
  the repository's only real character sprite from `value` 850 to 800.
- **A subject with an empty frame** — the whole dimension reports 1000 and contributes no issues,
  because `empty-frame` belongs to the aggregator at severity 1.00 and a blank canvas is caught by
  one blocking issue rather than by six dimensions each inventing a zero. `unmeasured` still records
  `{ form: 'no-judgeable-plane' }`, because the reason is useful even where the score is fixed.

**Scoring.** Two banded sub-scores, combined with fixed weights, in the same shape as §4.4:

| distinct buckets | `toneQ` |
| --- | --- |
| `>= 5` | 900 |
| `== 4` | 780 |
| `== 3` | 620 |
| `== 2` | 400 |
| `<= 1` | 150 |

| `crossesQ` (the worst plane) | `formQ` | issue |
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

…except when `formQ` is `null`, where the form half's weight is dropped and the remainder
re-normalised — the same rule `STATIC_QUALITY_WEIGHTS` applies to a still sprite's absent `motion`:

```
formQ is null:  valueScoreQ = toneQ + adjustments, clamped to [0, 1000]
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
| `plane-crosses-form` | worst-plane `crossesQ > 750` (0.60), else `> 600` (0.30) | 0.30 / 0.60 | **yes** at 0.60 |
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

**Worked example** — the acceptance pair, and these are two committed corpus cases rather than two
sheets of arithmetic, so every number below is reproducible from `benchmarks/corpus/`. A is
`value/straight-diagonal-32` and B is `value/nested-contour-32`: the same 32×32 body, the same five
tones, the same five tone regions, the same five planes, the same four boundaries. The only
difference is whether the boundaries are insets or translations, which is exactly the property
under test. Every tone-plane measurement is identical in both, which is the whole point:

```
                              A: straight diagonal    B: nested contours
N                             398                      398
buckets present               4, 7, 9, 12, 13          4, 7, 9, 12, 13
distinct buckets              5   -> toneQ 900         5   -> toneQ 900
range                         148                      148
internalEdges                 749                      749
hueOnlyEdges                  0                        0
Dmax                          10                       10
tone regions                  5                        5
planes                        5                        5
worst plane  bendQ            0                        1000
              splitQ          1000                     371
              reachQ          600   >= 500 -> open     560   >= 500 -> open
              curvedQ         750   >= 250 -> open     600   >= 250 -> open
              crossesQ        1000                    0
formQ                        100   (band > 750)        1000  (band <= 150)
valueScoreQ                  rhu(500*900 + 500*100, 1000) = 500
                             rhu(500*900 + 500*1000, 1000) = 950
minus adjustments            0                        0
scoreQ                       500                      950
```

```
A: 500/1000 = 0.50, and `plane-crosses-form` at 0.60 is BLOCKING  ->  verdict fail
B: 950/1000 = 0.95, no blocking issue
dimension gap 450 per-mille
```

The old `value` scored both versions identically, and the whole report moved **0.014**. This one
moves the dimension by **0.45** and moves the verdict by a whole class, because the flat sticker is
now *blocking* rather than merely dim. The blocking severity is doing as much work as the score: a
diagonal band across a rounded body is not a matter of degree, it is a different object from a lit
form. Note where the separation comes from: the two documents agree on `toneQ`, `range`,
`internalEdges`, `Dmax`, the region count, the plane count, the boundary count and both gates, and
the only quantity that differs is whether the boundary turns.

Verdict text for A: *"5 tone planes, range 148, but a shadow terminator runs the full depth of the
body as a straight cut — the plane crosses the form instead of nesting around it."*

**The control, and the number the bias is recorded in.** `value/level-set-32` is the same body with
four *true insets* — the construction that looks like a target — and it is in the corpus as a clean
control rather than as a claim. It scores `scoreQ` 950, identical to B, with no issues: a level set
and a translated contour are both acceptable ways to build a sphere, and the term is not allowed to
prefer one over the other. Its unscored `spanQ` reads **91** against B's **909**, which is the
standing evidence that the originally specified term was biased, and the reason the quantity is
still computed and still printed.

**And the third case, which is not a case at all: a subject that fills its canvas.** Both A and B
have an outline, so both are measured. `bleed/full-bleed-scene-32` is the same kind of picture with
the margin taken away, and it is not scored by this term at all — `formQ` is `null`, the dimension
reports `unmeasured: { form: 'no-subject' }`, and its `value` is its `toneQ` of 400 rather than the
700 the 1000 used to blend into. The reason is in the block above, and the reason it is worth
stating in the worked example is that a reader who has just seen A and B separated by 450 per-mille
will otherwise assume the term has an opinion on everything with planes in it.

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

**The bounds above are hundredths while the pipeline is per-mille, and reading one as the other
is the one arithmetic mistake this table invites.** `2/100` is 2 *per cent*, which is **20
per-mille**; `20/100` is 200 per-mille. §3.7 tests this dimension in hundredths
(`offPalette * 100 <= 20 * N`), which is right for them, so an implementation that holds its own
ratios per-mille has to convert **once, at the top of the file** — and the first version of
`palette.ts` converted twice, comparing the *issue*'s trigger `offPaletteRatio > 2/100` against a
per-mille `200` rather than `20`. `off-palette` then fired a tenth as late as this section
specifies: a sprite with a quarter of its pixels off the palette sat inside the `<= 20/100` band at
720 with **no issue at all**. **The direction of that error is the worst one available in this
dimension** — a silent miss on real drift — and it was invisible on a corpus of disciplined assets
for the reason §7 records three times over: nothing in the corpus was off-palette enough to reach
the line, so "the measures read zero everywhere" was true of the corpus and of a broken instrument
alike.

**`muddy-mix` can never fire on its own, and the threshold table says so whether or not this
section says it in words.** `muddy` is defined over *off-palette* pixels, so
`muddyRatio <= offPaletteRatio` holds pixel for pixel and always; `muddyRatio >= 5/100` is
therefore an `offPaletteRatio` of at least 5/100, and `off-palette` fires above `2/100`. The code
is still worth carrying — it says the undeclared pixels are low-saturation mid-value *mixes*
rather than arbitrary hexes, and its fix is a decision about how the colour was made rather than
one `quantize_to_palette` call — but it is a **refinement** of `off-palette` rather than a peer of
it, and a report that shows only one of the two has shown a partial fact. A client asking "is
this disciplined" should read `off-palette` alone; a client asking "is this drifting or mixing"
wants both. `defect/muddy-over-skin-32` is the corpus case that declares both, and says why in
its own note.

**A sprite cannot exceed the colour budget on a small canvas without also being a `noise`
defect, and that was measured rather than argued.** §4.3's budgets are 10 on a 16×16, 16 on a
32×32 and 28 on a 64×64, so on any of those canvases 11, 17 or 29 distinct colours have to be
packed into regions of a few dozen pixels each — and §4.4's `colourOrphan` counts a pixel whose
`LqBucket` matches nothing within Chebyshev 2 *and* sits outside the range its neighbours span,
which is every pixel of a small colour island. Thirteen one-pixel accents added to a 32×32 were
measured first and read `colourOrphans` 13 of 576, which fires `stray-colour`; 4×4 blocks of the
same colours read `colourOrphans` 0 and carry `colour-budget-exceeded` alone. **The fix was the
fixture's tiling, not either gate.** Real artists hitting this budget use large regions, and the
budget is generous enough on `medium` and `large` canvases for that; the interaction is a fact
about small canvases and it is recorded rather than tuned away.

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
colourOrphans   count of the solid p with nothing agreeing within Chebyshev 2 and nothing in the
                neighbourhood even on the same part of the ramp — see below
nearDuplicatePairs
                pairs of distinct colours, each with >= 8 solid pixels, whose Chebyshev
                colorDistance is <= 8
ditherShare     rhu( (pixels with ditherMask == 1) * 1000, N )   -- a measurement, not a verdict
```

#### `colourOrphans` replaces `outliers`, and the replacement needed measuring too

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
the *absence of any agreement at all*.

That sentence was then written down as a **4-neighbour** test, and the 4-neighbour version is
false on two of its own worked-example rows. Both were found by measuring it across the corpus
rather than by reading it, and the first is the one that mattered most, because the case which
exposes it is a declared negative control. **A 1px outline drawn as a staircase**: every pixel on
the diagonal run of such a contour has no same-bucket 4-neighbour, because the rest of the run
reaches it only diagonally, and `control/outline-ring-32` read **31/1000** against a trigger of
8. **A gradient**: in a ramp a pixel's 4-neighbours are the buckets either side of it, so "no
same-bucket 4-neighbour" is the normal state of a picture rather than a defect, and the ten
committed scenes read **9..153**.

Two replacements were measured before the one that shipped, and both are written down here
because a refuted approach is the thing a future revision can least re-derive. Treating a
**+/-1 bucket as agreement** does what it says on a gradient — the 512² scene falls 153 -> 27,
the 256² one 89 -> 25 — and changes `control/outline-ring-32` **not at all**, because a dark
contour against a light interior is 13 buckets away rather than one. It cannot be both a gradient
test and an outline test, and the outline is the one it fails. Comparing a pixel against the
**[min, max] range spanned by its radius-1 neighbours** does read 0 on
`control/outline-ring-32`, and in exchange it **breaks the gap this dimension is proud of**: the
2px specular highlight in `artwork/verify/lantern-keeper.pixel` is an island sitting entirely
outside its surroundings' range, so a correct 2px highlight starts scoring as a stray colour.
Protecting a deliberate highlight is the whole reason `despeckle` ships `minClusterSize`.

Radius 2 is what makes the range clause safe, and the reason is mechanical rather than tuned: at
Chebyshev 2 the rest of a 1px contour is always reachable, and a 2px island always contains its own
partner. So:

```
colourOrphan(p) = #{ q solid : 1 <= Chebyshev(p, q) <= 2, LqBucket(q) == LqBucket(p) } == 0
                && LqBucket(p) not in [ min, max ] over that same set of q
```

The second clause is what turns "isolated" into "wrong": a stray pixel is not merely alone, it is
on a part of the ramp that nothing around it is on. A pixel needs neighbours to have a range at
all, so one with nothing solid within 2px is **not** counted — `isolated` is the measure for
that, and a single pixel cannot be both unattached and undescribed. The range is accumulated
from sentinels and is **not** seeded with `LqBucket(p)`: seeding it that way makes
`own > hi` unsatisfiable and silently exempts every stray *brighter* than its surroundings,
which is the common half of the case.

Measured: every declared `clean-control` in the corpus reads **0**, all six `control/*`
negative controls included, and the ten real artworks read **0..10** against a trigger of 8.

| case | fires? | why |
| --- | --- | --- |
| stray pixel in a field | **yes** | it matches nothing within 2px, and nothing near it is on its own step |
| one wrong-coloured pixel inside a solid block (`n8 == 8`) | **yes** | the same, and this is the case the first test was written for |
| pixel on a material edge | no | the buckets either side of the boundary span its own |
| outline's inner edge | no | a 1px contour reaches every one of its pixels within 2px, diagonals included |
| a 1px outline drawn as a staircase | no | the rest of the run is at Chebyshev 2, which is why this row is here |
| a smooth shading plane | no | it is inside the range its neighbours span |
| a 2–3 px island of one tone inside another | **no** | its pixels match *each other* — see below |

The last row is a real gap and it is deliberate, and radius 2 buys the outline back at a price
worth naming: a stray pixel buried inside a feature narrower than 4px is exempt for the same
reason, because the feature's other side is in the neighbourhood. `isolated`, `diagOnly` and
`spurs` still see those as *shape* problems, so the case is not invisible — but a wrong colour
down the middle of a 3px antenna does read clean here, and there is no threshold in this
predicate that fixes it without re-admitting the 1px outline. Recorded rather than tuned away.
Catching a small island and protecting a 2px specular dot remain the same problem: a 2px
highlight on a shoulder is correct craft, and `despeckle` ships `minClusterSize: 2-4` precisely
so that a cleanup pass will not delete it. A region-level test sharp enough to catch the island
would also delete every specular dot in the corpus. One sharp pixel-level predicate plus a
documented gap beats a broad one that quietly sands a piece flat, and §7 item 6 states the cost.

The weights changed with the measurement, and the reasoning is that the two sharp quantities
now carry the dimension: `isolated` (a stray *shape*) and `colourOrphans` (a stray *colour*)
are the two things an agent actually produces, and `diagOnly`/`spurs` are shape-integrity
defects that overlap with `silhouette`'s territory. 350/250/250/150 became 300/200/300/200.

#### `nearDuplicatePairs` and `palette` are two questions, not one measurement twice

Both dimensions look at colour distance and they do not measure the same thing, so §3.3's
warning — two dimensions measuring one fact two ways is the likeliest way for this pipeline to
produce a confident wrong answer — has to be answered with cases rather than with prose. It is:
three, one per direction, in `quality-corpus.test.ts`.

| | §4.4 `nearDuplicatePairs` | §4.3 `maxNearestDistance` / `off-palette` |
| --- | --- | --- |
| reference set | colours **the sprite used** | the **declared palette** |
| metric | Chebyshev max-channel, `<= 8` | `colorDistanceWeighted` (redmean), `> 12000` |
| question | "did you use two colours that are the same colour?" | "did you use a colour nobody declared?" |
| fix | merge the two entries | `quantize_to_palette`, or a decision |

- `defect/near-duplicate-ramp-16` — two **declared** swatches a few steps apart. `noise` fires,
  `palette` reads 1000 with `offPalette` 0 and `maxNearestDistance` 0.
- `defect/off-palette-over-skin-32` — 144 undeclared pixels and `nearDuplicatePairs` 0, because
  the drifted colour is far from every colour in the picture. `palette` blocks, `noise` says
  nothing.
- `app/icon.png` — **both fire, and they are two different false positives.** `noise`'s 7,842
  pairs is a smooth twelve-step ramp being structurally a field of near-duplicates; `palette`'s
  1,000 per-mille is a raster that was never quantised into its document palette. Different
  faults, different upstream fixes, one asset.

**Neither dimension can be derived from the other, and a colour three steps from a swatch is 0 to
one of them and a pair to the other.** So neither is retired in favour of the other, and the
question "who owns colour discipline" has the answer "both do, each on its own question". What
is *not* allowed is quoting one as evidence about the other, and the icon is the row where that
would be tempting.

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
`ditherCell`: all four orthogonal neighbours transparent and all four diagonals solid — the exact
signature of a **perfect axis-aligned 50% checkerboard**. Measured against a sprite with three
clearly visible `bayer4` seams it reported `ditherShare` **0.0000**. On a diagonal terminator
or an elliptical arc the lattice and the boundary fight each other and the perfect checkerboard
never appears, so the one check designed to catch "mostly 1px dither" was blind to exactly the
dither an agent produces. The second attempt was written to the letter of this document and was
blind for the opposite reason; §3.3 records that one, because it is the more instructive of the
two failures.

The exclusion that works is `ditherMask`. All three of `isolated`, `diagOnly` and `spurs`
exclude its pixels, `ditherShare` is its population over `N` in per-mille, and the verdict names
it so a human can see why the noise score is what it is.

**There is no `dither-dominant` advisory, and its absence is a measurement rather than an
omission.** This section used to specify one, at `ditherShare >= 100/1000`, on the reasoning that
a piece which is *mostly* one- or two-pixel alternation is its own problem under the 3–5px seam
rule. With `ditherMask` actually working it fires on `value/level-set-32` — a **declared negative
control** — at **427**, and on `value/straight-diagonal-32` at **261**. Both draw 1–2px concentric
contours and one straight 45° cut, and §7 already lists "a 1px outline is the target" among the
conventions this repository scores positively. **No threshold fixes it**, and the reason is the
argument this document uses elsewhere: a 1px alternation between two adjacent buckets **is** a
dither pattern and **is** a contour line, so they are the same set of pixels, and no value of a
gate separates two cases that are equivalent on the same pixels. The advisory had nowhere to go.

A second candidate was measured rather than assumed. Adding an "interior" clause — the share of
the component whose 8-neighbourhood lies wholly inside it — looked as though it should separate
them, on the reasoning that a 1px line has no interior and a filled band does. It does not, and
it separates them in the wrong order: `value/level-set-32` reads **200** where
`artwork/verify/lantern-keeper.pixel` reads **141**. The two `value` cases draw their contours
**2px apart** — their own recipe says so and explains why — so the pair's union set is a band
several pixels across and does have an interior. Band thickness is not the discriminator, and
neither is anything else about the component's shape.

So `ditherShare` stays on the frame record as a **measurement** and stops being a verdict. It is
the number §7's four dithered scenes needed and did not have, and an agent reading it learns
something true; an advisory claiming to know whether the alternation it found was intentional
would not be, and it would have fired on this repository's own clean control. What is left as the
cost is the one §3.3 states: both a legitimate 2px cluster and a mistaken 1px stipple are
exempted from the noise measures, and a `sparse` pattern at low coverage falls out of the mask
entirely.

**Scoring.** Four ratios, each banded, combined with fixed weights. Higher ratio is worse, so
the bands run the other way, and the table is read **ascending bound, best sub-score first**:

| ratio | `<= 2/1000` | `<= 8/1000` | `<= 20/1000` | `<= 50/1000` | `> 50/1000` |
| --- | --- | --- | --- | --- | --- |
| sub-score | 1000 | 900 | 750 | 500 | 200 |

**The first thing to check on any band table here is the direction it is read in.** The
implementation of this one was written in descending-bound order and walked in that order, so a
ratio of 0 matched the `<= 50/1000` row and returned the *worst* sub-score: every clean negative
control in the corpus scored `noise` **200 of 1000 with all four measures reading exactly
zero**. It was wrong by a band as well, and the table above is what caught it — the committed
table had neither the `<= 2/1000 -> 1000` top row nor the `> 50/1000 -> 200` floor specified
here. A descending list of `(bound, score)` pairs walked with a `for` loop returns the *first*
match, and on a zero ratio the first match is always the loosest bound unless the list is ordered
the other way round. Every row of such a table is individually plausible, which is exactly why
review misses it. What saved this one is that the symptom was loud — it reported the whole corpus
as noisy, which no implementer ships by accident — and a band table whose inversion were quieter
would have been the dangerous one.

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

**`dither-dominant` is retired rather than retuned, and the paragraph above is the argument.**
It was specified here at `ditherShare >= 10/100` — 100 on the per-mille scale §3.7 uses — and with
`ditherMask` reading correctly it fires on a declared negative control. Nothing branches on the
string, because nothing shipped. It must not be reintroduced, and reintroducing it means
re-answering the question of whether a 1px contour and a 1px stipple are the same set of pixels,
because on this corpus they are.
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
ditherShare              25/612 = 41/1000     (a 4px bayer4 seam at 0.25)  -> a measurement, no issue
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
material edge and the shading planes, and all three are coherent edges where every pixel agrees
with something. The nine that remain are the nine actual strays, and the score is the same 0.72
the sprite deserves. That count is the radius-2 predicate's rather than the 4-neighbour one's;
this drawing is not a corpus case, so the row illustrates the arithmetic rather than transcribing
a measurement, and the corpus's own numbers are in §7.

Verdict: *"9 isolated px, 4 diagonal-only px, 6 single-pixel spurs, 9 stray-colour px, 1
near-duplicate pair, dither 41/1000 of the surface."* Every one of those is a specific pixel an
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
dark(p)         localMean(p) - Lq(p) >= 20            <- tone only; NOT ink
ink(p)          dark(p), within dist 3 of the boundary, and 4-connected to one
inkCount        ink pixels among the edge pixels  (the contour)
inkTotal        every ink pixel, edge and interior alike
outlineShare    inkCount / edgePixels                          <- primary ratio
outlineCoverage inkTotal / N
inkRun(p)       longest SAME-COLOUR radial run inward, over the whole solid mask:
                  1 + max { run(q) : q 4-adjacent, dist(q) = dist(p)+1, colour(q)=colour(p) }
inkDepth        inkRun(p) - 1, read on the ink pixels ON the boundary
minInkDepth     min, maxInkDepth  max  <- of `inkDepth` over the contour
quadrantDepth   max ink depth in each of the four quadrants of `bounds`; -1 = no ink
inkColours      distinct packed colours among the ink pixels on the boundary
inkGaps         edge pixels with no ink, standing next to ink that is (8-neighbour)
```

`localMean` includes `p` itself, so it is always defined, and it is a *local* mean rather
than a sprite-wide one so a light outline on a dark body is still detected. The band and the run
are built on `dist` from §3.3, not on a private BFS: this dimension, `value`'s form term and
`noise`'s thin-sprite test all need the distance-to-boundary field, and three BFS runs that
agree are a
fact while three that disagree by a pixel are a bug report nobody can reproduce. `dist` is
also the same number for the body and the ink, which is what makes `maxInkDepth` a thickness
measurement rather than a distance-from-the-edge measurement.

#### The `ink` predicate as shipped
`dark` is a statement about **tone** and **shape**, and `ink` is a statement about **the contour**.
They are four clauses, and each answers a measured disproof rather than a preference:

```
CONTOUR_BAND      3          ink is only claimed within `dist 3` of the exterior boundary
REFERENCE_RADIUS  2          the 5x5 Chebyshev window of the *local* reference
BODY_REFERENCE_RADIUS
                    4          the 9x9 Chebyshev window of the *body* reference, band excluded
INK_MIN_DROP      20         in §3.4 integer luminance

local(p) = floor(mean Lq over the solid pixels in the 5x5 window) - Lq(p) >= 20
body(p)  = bodyMean(p) >= 0  and  bodyMean(p) - Lq(p) >= 20,  over the 9x9 window,
           counting only solid pixels with dist > CONTOUR_BAND;  -1 when there are none
encloses(C) = no pixel of (mask \ C) is reachable, 8-connected, from the transparent
           pixels on the canvas edge without crossing C

dark(p)  = local(p)  or  ( body(p)  and  encloses(the 4-connected body-dark component p is in) )
ink(p)   = dark(p)  and  dist(p) <= CONTOUR_BAND  and  p is 4-connected to an ink pixel
           standing on the boundary (dist 0)
```

**`dark` is a union, and the second term is the one finding 1 needed.** `local` is a
local-contrast test and it is the one that reads a 1px contour, rim shading and any small dark
feature. `body` is measured against the subject's interior rather than against its own
neighbourhood, and it is the only instrument that can see a contour thicker than its own
window. It is not sufficient on its own — see the price below — so it is admitted only where the
dark set **encloses**.

- **The band.** A contour is a band adjacent to the exterior boundary. Read over the whole mask
  the predicate admits the shading inside a lit sprite: measured, that is `maxInkDepth 6` on
  `artwork/verify/lantern-keeper.pixel`, six steps inside a 32px silhouette. The band is not a
  number of its own — it is written as `HEAVY_DEPTH`, the depth the heavy row tolerates, because
  a band shallower than that bound makes the depth row arithmetically dead on every input that
  reaches it. That is the defect `ditherMask` shipped with in a different quantity, and it is
  reproduced by picking a band at random.
- **The connection.** A dark pixel that nothing on the boundary leads to is a pupil, a buckle or
  the shadow under a chin. Interior shading is *area*; a contour is *thin*; the flood fill is what
  says which, and an interior blob contributes to nothing this dimension reports. The fill is
  4-connected because §3.3's subject is 4-connected, and each component is flooded twice — once
  to decide whether it reaches the boundary, once to mark it — because a component cannot be
  marked until it has been decided on.
- **The window.** `localMean` averages every *solid* pixel in the window, including `p` and
  including the other pixels of the contour itself, and excludes transparent ones rather than
  counting them as black: the background is exactly what an outline is drawn *against*. It is
  local rather than sprite-wide for the reason this section gives. Measured, the global version is
  worse than useless here — the mean `Lq` over `dist >= 4` on `lantern-keeper.pixel` is **77**,
  because the cloak is most of the subject, so a global reference calls every pixel below `Lq 97`
  ink and reads `outlineShare` **703**.

#### Two references, and the topological clause that joins them

§4.5's original `localMean` averaged *every* solid pixel in the window, including `p` and the
other pixels of the contour itself. That is a local-contrast test, and it has one measured
consequence that matters: **a uniform ring three or more rings thick has no local contrast
left**, so `outlineShare` collapses to `0` and the dimension reports the heaviest contour in
its own vocabulary as *having no outline*. Finding 1 below.

The obvious repair — take the reference over the body *beneath* the contour, excluding the band,
so a contour of any thickness is measured against the body rather than against itself — was built
and measured and **is not sufficient on its own**. At `BODY_REFERENCE_RADIUS` 4 it does exactly
what it says on finding 1's case, and in exchange it reads **every lit subject's boundary
shadow as a 4px contour**, because on a block whose left half is a dark tone that dark half
genuinely *is* a four-pixel dark band on half of its boundary. Measured with the body reference
alone over the whole corpus, `outline-heavy` at severity 0.50 fires on **2 frames, one of them a
declared negative control** — `control/colour-budget-at-limit-32`, which drops from `scoreQ 700`
to **300** against a `FLOOR_FAIL` of 300, alongside `defect/colour-budget-32`. (These figures are
this file's own, measured on this file's own union formulation; they are not the same as the
eight-cases-three-controls figure recorded in an earlier revision of this section, which was a
replacement rather than a union and a different `dark`.)

**Finding 1 and that regression are the same fact, and the same fact is what dissolves them.**
The pixels of a four-pixel uniform contour and the pixels of a four-pixel-deep shadow that
reaches the boundary are the same set of pixels — so no threshold and no tone-and-distance
predicate separates them. That statement is **correct, and it is correct about pixels**. It does
not follow that no predicate separates the two *drawings*, because it was never a claim about
drawings: the comparison that decides was made one pixel at a time, and the property that
differs between the two pictures is a property of the **set**.

A contour **wraps the subject**. A cast shadow **occupies one side of it**. Those are different
shapes, and the difference is invisible on any single pixel of either — which is precisely why a
per-pixel repair cannot find it. The clause that finds it is topological:

```
encloses(C) = no pixel of (mask \ C) is reachable, 8-connected, from the transparent pixels
              on the canvas edge without crossing C
```

and `dark` takes the body reference **only where the body-dark component encloses**. Measured on
`quality-outline.test.ts`'s own fixtures, all three columns produced by the same drawing set:

```
                       local only    body, ungated    body + encloses   <- ships
4px uniform contour       share 0      share 1000       share 1000
4px staircase contour     share 0      share 1000       share 1000
3px staircase contour     share 367    share 1000       share 1000
one-sided dark half       share 67     share 133        share 67
```

The middle column is the rejected repair: it fixes the contour and **doubles the shadow's
contour**, which is the trade §3.5 names as the failure worse than a miss. The right-hand column
fixes the contour and leaves the shadow's reading **identical to what the local reference alone
produced** — a shadow does not enclose, so the body reference is never consulted on it. That
equality is the load-bearing measurement, and it is why the answer is a gate and not a
threshold: a threshold would have had to sit between 67 and 1000.

Four properties make the clause safe, and each answers a measured failure rather than a
preference:

- **It is 8-connected, deliberately.** §3.3's background is 8-connected and its subject is
  4-connected, and this flood is a *background* flood — it asks what the outside can reach. A
  4-connected flood squeezes through the diagonal of a 45-degree staircase contour and reports
  every staircase contour in this repository's style as failing to enclose, which is finding 3
  arriving through a second door.
- **It is seeded only on *transparent* edge pixels.** A solid pixel on the canvas edge is a
  *subject* pixel that happens to be at the edge. The first version of this function seeded solid
  edge pixels too and `control/outline-ring-32` — which draws a closed contour — read
  `encloses false`. Recorded because it is the same class of error as the five shipped
  measurements: a predicate whose first version is wrong in the direction that looks safe.
- **It is decided per component, not globally.** A sprite carrying a real contour *and* a
  one-sided shadow is judged on each part separately; a global test over the union throws the
  enclosing part away with the other.
- **It is total.** Every `C` either separates the subject from the outside or it does not.
  There is no count that can be 0 and no arithmetic that can return `NaN`.

**Two costs, both measured and neither hidden.** A contour drawn with a deliberate nick does not
enclose, so its body reference is never consulted and it is read by the local reference alone —
which is the shipped behaviour, unchanged, because selective outlining is recommended craft that
§4.5 must not punish. And `twoWeightContour(3, 1)` now reads `outline-heavy` at 0.70: its seam
row is painted ink across the subject's full width, it genuinely *is* a four-pixel dark band,
`outlineCoverage` moves from 297 to 469 against the 450 limit, and a row that could not see that
band now can.

mask** (not only over ink pixels: read over ink pixels only, every run starts on the boundary and
the depth reading is a structural constant no input can move), and it walks one `dist` layer at a
time. The dependency runs the *opposite* way from the BFS that produced `dist`, so the walk is
**innermost layer first**; a version that guarded the neighbour scan with `if (d > 0)` read
`maxInkDepth` **0 on every input** including a four-ring uniform contour, and the depth row was
unreachable while every test on it stayed green. One layer past the band is computed because a run
starting on the boundary has to be able to reach the band's outermost layer. A run of *one colour*
is what an outline is: a band of a single tone hugging the boundary, and two nested dark tones are
a contour plus shading, which is exactly the `Lq 50` rim band inside `lantern-keeper.pixel`'s
`Lq 36` contour that the old `dist`-based depth called a 4px outline.

**`inkGaps` asks where the contour stops.** A boundary pixel with no ink, standing next to ink that
is, under **8-connectivity** — the background is 8-connected and the subject 4-connected, and the
diagonal run of a 45-degree staircase is a statement about *attachment*, not about the contour. A
closed contour of any shape has no such pixel, so the near-miss is **exact** rather than
approximate. Finding 3 below carries what that costs.

#### The absent-contour case is an abstention, and not a score

If `outlineShare < 15/100` the dimension has nothing to grade. **This is now an
`ExcludedReason` — `'no-outline'` — and not a measurement of any kind.** The key
absent from `dimensions`, its weight (100) out of the §5.2 denominator, and no
`scoreQ`, no severity and no Δ anywhere. A sprite with no outline is a legitimate
style — plenty of excellent top-down and RPG sprites have none — so it is not *bad*,
and the way to say "nothing was asserted" is to assert nothing.

**The revision, and why it was necessary.** This section previously scored the case
`700` — "nothing asserted either way" — *and* emitted `outline-missing` at severity
0.20. Those are two claims and they contradict each other. §3.5 defines an issue as
"one thing that is wrong with the artwork"; a subject with no outline has not done
anything wrong. An abstention that emits a code is not an abstention, it is a defect
report that has agreed to score itself 0.70 instead of 0.00, and it had two further costs that
made it worse rather than merely redundant:

- **The 700 was a mark, and marks move.** §5.3 turns a dimension reading 700 into a `warn`
  wherever the total drops, and a *passing* mark handed out for having said nothing is
  indistinguishable at the gate from a measurement that was taken and came out well. §3.7's
  arithmetic shows it directly: with `outline` at 700 the weighted mean of a clean still sprite
  is dragged **down** by the dimension that has no opinion, because 700 is below every
  other dimension's reading on the same artwork. A subject that chose no outline was
  penalised for the choice, by exactly the amount the scorer was supposed to be neutral by.
- **The code was a false positive on clean work, and measured.** §3.5 names an analyzer that
  fires on clean art as worse than one that misses a defect. Registered against the corpus,
  `outline-missing` landed on 55 of its 79 cases, including 8 of the declared `control/*`
  negative controls — none of which draws an outline at all.

**What replaced it, exactly.** The gate moved up to the aggregator as
`outlineApplicability`, beside `requiresReadableSubject` and `motionApplicability`, because
applicability is `evaluate`'s to decide: a dimension that declared its own unfitness would be
the analyzer deciding whether its own answer counts. It declines when **every inked frame** reads
below 150, which is `hasReadableSubject`'s unanimity rule unchanged — one frame at or above the
bound is enough for the dimension to apply, and it takes every frame below it to abstain, so a
two-frame sheet cannot lose its one readable frame to an empty one. A frame with no ink is not
counted either way.

**What it costs, stated.** Three things.

1. **A frame-level reading survives below the gate.** `measureFrame` still computes a
   `baseQ` for a frame that reads under 150, and it is §4.5's own "otherwise" row — 550.
   That row is now reachable only inside a multi-frame document whose other frames do declare a
   contour, where it says what it means: *this frame dropped its outline*. The four Δ rows stay
   behind the same bound, because `outline-heavy` and `outline-gap` ask questions about a contour
   that exists — on `control/clean-figure-20` and `control/clean-union-16` they read as though a
   contour did, and the rows would fire on a subject with none.
2. **The dimension is no longer free on unoutlined artwork.** The precondition costs the same
   measurement the analyzer would have cost. It is the only precondition in the pipeline that is
   not cheap, and it is cheap in the wrong direction: the case it exists for is the case where the
   analyzer then does not run at all.
3. **The 700 is gone rather than moved.** Nothing inherits it. An excluded dimension contributes
   no term, so there is no number to tune and no "neutral" value for a reader to disagree with —
   which was §7's standing objection to it.

**Scoring** (reached whenever the dimension applies at all, which by the gate above means
`outlineShare >= 15/100` on at least one inked frame):

| `outlineShare` | base |
| --- | --- |
| `>= 80/100` | 950 |
| `>= 60/100` | 850 |
| `>= 35/100` | 700 |
| otherwise | 550 |

| Condition | Δ | code |
| --- | --- | --- |
| `minInkDepth >= 3` | −150 | `outline-heavy` |
| `quadrantDepth` spread `>= 2` | −150 | `outline-inconsistent-weight` |
| `inkColours >= 4` and the 4th colour holds `>= 5%` of ink | −50 | `outline-colour-split` (0.25) |
| `inkGaps / edgePixels >= 5/100` | −50 | `outline-gap` (0.25) |
| `outlineCoverage >= 45/100` | −200 | `outline-heavy` (0.70) |
| `outlineShare >= 60/100` and `outlineCoverage < 3/100` | −100 | `outline-gap` (0.35) |

#### What `fix` does with these four codes, and why none of them is an op

`fix` turns an issue into executable ops where a safe repair exists and into prose where one does
not (§8.1 item 5). **All four of §4.5's codes are prose, and `outline-gap` declines for a reason
the other three do not have: it is advisory by design.** §4.5 emits it at severity 0.25 and says so
in its own message — "selective outlining is a good technique and this is advisory, not a defect:
the craft guide recommends dropping the contour where the light hits". A command that closed the
contour would be undoing the craft the code exists to make visible, so the absence of an op here is
the repair, not a gap in the table. The guidance says so in those words, and says how to tell the
two cases apart: gaps that track a light source are craft and the advisory can be ignored; gaps that
are scattered are damage.

The other three are ordinary judgement calls, and `QUALITY_FIX_ADVICE` records the reasoning for
each:

- `outline-inconsistent-weight` — the rect names the pixels at the deepest quadrant depth, but
  *which* side should be thinned is a decision about the sprite, and the two sides are not
  equally defensible (a heavier head reads as deliberate, a heavier base reads as weight). The
  guidance also warns that one thinning pass can trade this code for `outline-heavy`, because both
  read `minInkDepth`.
- `outline-colour-split` — `replace_colors {from, to}` does the merge once you have decided which
  contour colour survives, and whether the second tone was a lighting step is the content of the
  decision. §4.5's trigger (`inkColours >= 4`, fourth colour `>= 5%`) is stated so the reader can
  check first.
- `outline-heavy` — the only one whose repair is arithmetically impossible rather than merely a
  judgement. Both rows fire on *coverage*: `minInkDepth >= 3` or `outlineCoverage >= 450/1000`.
  Thinning a contour means **erasing** opaque pixels, and an erased pixel is a hole, because the
  body colour underneath a contour pixel is not recorded anywhere in the document. So the repair is
  "which of these dark pixels is contour and which is interior shading", painted by hand.

Two of the four are reachable from the corpus today and are asserted end to end in
`quality-fix.test.ts`; `outline-colour-split` and `outline-heavy` are not, because no corpus case
draws a four-colour contour or a contour thick enough to trip either heavy row, and those two are
exercised against the plan builder directly rather than by moving a fixture.

#### What registering the dimension moved, measured

Registering `outline` moved two reports in the test suite and neither of them is the artwork
changing:

```
control/clean-figure-20   0.905 pass  ->  0.845 warn   outline 350, share 327/52, 7 gaps,
                                                            quadrant spread 2 (TL 4, TR 4, BL 2, BR 3)
artwork/.../lantern-keeper 0.824 pass  ->  0.805 pass   outline 650, share 495/101, 20 gaps
```

The first is T-015's finding five again, with the sign that matters: the case was a declared
negative control and it is now `warn`. It does not block — both of its outline codes sit at 0.25
and 0.45 against §5.3's 0.50 line, so `decision.passed` is still `true` and `decision.refusals`
is empty — but `verdict` moved, and a delivery path that showed only `passed` would hide that.
The second is the sprite getting a second real defect it did not have measured to it: the
repository's only human-rated sprite has a contour that stops and resumes 20 times along its
boundary, which nothing could say before §4.5 shipped.

#### What the implementation measured, and what it did not fix

T-016 implemented this section. Four findings came out of it, and the shape of them is the one
this document keeps meeting: **a specified predicate that reads something other than the thing
it names.** None of the four is a threshold that wanted tuning.

**Findings 1, 2, 3 and 7 are repaired, and their disproofs are kept in full, with the shipped
readings beside the old ones. Finding 4 is a finding about a row's reach, not a defect, and it is
not repaired.** A disproof somebody else did not have to re-derive is worth more than a quiet
correction, so the numbers that produced each one are all still here — including the two fixtures
whose readings look like failures and are not.

A reader who wants the short version: **the predicate was rewritten because no threshold could
fix it.** `ink` is now a band on `dist` plus a flood fill to the boundary, depth is a same-colour
radial run rather than a distance, the depth row reads the minimum rather than the maximum, and
`inkGaps` asks where the contour stops rather than how each pixel is attached. Six corpus negative
controls went from `fail` to silent, and the repository's only human-rated sprite went from 300
to 650 with one advisory left. Three new findings came out of the rewrite and are recorded below
as findings 5, 6 and 7.

**Finding 1 was then repaired separately, and its repair is the one that needed a new kind of
question rather than a new threshold.** Its disproof said a 4px uniform contour and a 4px
boundary-reaching shadow are *the same pixels*. That is true, and it is true per pixel — so no
tone-and-distance predicate could ever have separated them, and none was needed. The repair asks
about the **set**: `encloses`, a flood from the canvas's transparent edge into the subject that is
blocked by the dark band. A contour wraps the subject; a shadow occupies one side of it. Measured
over the whole corpus, that gate admits the thick contours and refuses the shadows, and **all nine
declared negative controls read byte-identically** while `lantern-keeper` holds at 650. Finding 7
follows: with the depth row reachable, its `minInkDepth >= 3` construction is the case this
section previously recorded as undrawable.

**1. `ink` is a local-contrast test, so a contour three pixels or more thick stops being ink.
**REPAIRED — see the two-references subsection above.**

`localMean` over a 5x5 window is the right instrument for the reason this section gives — a
sprite-wide mean would make the measure a statement about the key rather than about the contour.
It has a cost the original text did not state: a *uniform* ring three rings or more thick has no
local contrast left, so its pixels stop satisfying `local(p)`, `outlineShare` collapsed to **0**
and the dimension reported the heaviest contour in its own vocabulary as **having no outline**.
Measured over uniform rings on a 16x16 block:

```
                    local reference only                 as shipped
rings 1 -> outlineShare 1000, maxInkDepth 0      1000, inkCount  60, maxInkDepth 0
rings 2 -> outlineShare 1000, maxInkDepth 1      1000, inkCount  60, maxInkDepth 1
rings 3 -> outlineShare    0, maxInkDepth -1        1000, inkCount  60, maxInkDepth 2
rings 4 -> outlineShare    0, maxInkDepth -1        1000, inkCount  60, maxInkDepth 3
```

**The share column is no longer 0 and `outline-missing` is no longer what a thick contour reads.**
Rings 3 and 4 read `outlineShare 1000` with `inkCount 60` of 60 boundary pixels, and both are
reported `outline-heavy` at severity 0.70 on **coverage** — 609 and 750 per mille against §4.5's
450 limit. That is the right verdict for the right reason: a 4px contour covering three quarters of
a 16x16 sprite is not holding the edge, it is replacing the sprite.

The disproof that this section carried is **kept**, because it is what produced the repair and it
is what a reader would otherwise re-derive: the pixels of a four-pixel uniform contour and the
pixels of a four-pixel-deep shadow that reaches the boundary are the same set of pixels, so no
threshold and no tone-and-distance predicate separates them. The repair does not contradict that.
It declines the frame: the two are the same *pixels* and not the same *set*, and the property that
separates them — `encloses` — is a property of the set.

**The `minInkDepth >= 3` row, which this finding also called unreachable, is reachable now.** See
finding 7, which was its own.

**The curve is monotone through the defect where it used to be monotone-then-flat:** it rises
with the thing it is measuring, one ring at a time.

**The corners still lie about the minimum, and that is finding 5, not this one.** `minInkDepth`
reads **0** on a uniformly 4px contour over a *block* while `maxInkDepth` and all four
`quadrantDepth` entries read 3, because `inkRun` is 4-connected and a rectilinear corner steps
inward diagonally. The "uniformly heavy but consistent" case — the obvious fixture for separating
§4.5's two heavy faults — is therefore only drawable on a shape without corners, and finding 7
draws it on the 22-row disc.

**2. `ink` is not restricted to the contour, so it reads interior shading as a deep contour.**

This one has no satisfying reading. The table says `inkCount` is "ink pixels **among the edge
pixels**", and `inkDepth` is `dist(p)` "for ink pixels" — so the predicate must be evaluated over
the whole solid mask, or every ink pixel is an `edgePixel`, `dist` is `0` there, and
`maxInkDepth` becomes a structural constant no input can move (the defect `ditherMask` shipped
with, in a different quantity). On that necessary reading, a pixel anywhere in the subject that is
20 `Lq` darker than its 5x5 neighbourhood is ink, and **an internally lit sprite is full of them**.

Measured on `artwork/verify/lantern-keeper.pixel` — this repository's only human-rated sprite, and
§7's own "both have an outline" — at 32x32, `N` 432, `edgePixels` 101:

```
                first measured                            as shipped
outlineShare    495                                       495
inkColours        6                                          2
maxInkDepth        6                                          1
inkGaps           12                                         20
quadrantDepth  [0, 5, 3, 6]                              [0, 0, 0, 1]
outlineCoverage    —                                        188
scoreQ           300                                        650
codes: outline-heavy@0.50, outline-inconsistent-weight@0.45,
       outline-colour-split@0.25, outline-gap@0.25
  ->  codes: outline-gap@0.25                              (one advisory)
```

**Read the two columns together: this is the finding, and it is the reason the `ink` predicate
was rewritten rather than re-thresholded.** `inkColours 6 -> 2` and `quadrantDepth [0, 5, 3, 6]
-> [0, 0, 0, 1]` are the band and the connection doing their work — the sprite's own tonal ramp
is no longer read as contour ink. `maxInkDepth 6 -> 1` is the run measure doing its work — the
`Lq 50` rim band inside the `Lq 36` contour is a second tone, so the run stops at one pixel.
`scoreQ 300 -> 650` is the consequence, and **the sprite still carries one advisory**:
`outline-gap` at severity 0.25, 20 gap events over 101 boundary pixels. That is finding 6 below,
and it is not hidden by the improvement.

`maxInkDepth 6` is six steps *inside* a 32px silhouette: that is the cloak's shading and the
boots, not a contour. `inkColours 6` is the sprite's own tonal ramp. The dimension scores the
one sprite in this repository that a person has looked at **300 of 1000**, against a
`FLOOR_FAIL` of 300, and fires four advisories on it.

**Measured on the corpus's own negative controls, every one of them fails.** This is the number
that decides the argument above, and it is the reason §3.5 says an analyzer that fires on clean
work is worse than one that misses a defect. Running the corpus with this dimension registered,
all six declared `control/*` cases flip their verdict from `pass` to `fail`:

```
control/clean-blob-16              pass -> fail   outline-missing
control/clean-figure-20            pass -> fail   outline-heavy, outline-inconsistent-weight
control/clean-union-16             pass -> fail   outline-heavy, outline-inconsistent-weight
control/clean-banner-64x24         pass -> fail   outline-missing
control/colour-budget-at-limit-32  pass -> fail   outline-missing
control/partial-alpha-glow-28x24   pass -> fail   outline-missing
control/six-hue-families-32        pass -> fail   outline-missing
control/washed-one-hue-32          pass -> fail   outline-missing
control/outline-ring-32            pass -> fail   outline-gap, outline-heavy, outline-inconsistent-weight
```

**Six of those nine rows no longer fail, and the reason is not a fix — it is the abstention.**
Every `outline-missing` row above is a control that draws no contour at all, so under the current
predicate each of them is excluded as `no-outline` and contributes nothing. That is the correct
outcome and it is **not** evidence that the predicate improved: it is the predicate declining to
have an opinion, which is what `outline-missing` was supposed to mean and did not. The three rows
that survive are the interesting ones, and they are `outline-heavy` and
`outline-inconsistent-weight` on controls that have **no contour** — measured in full under
"the two controls the abstention does not reach" below.

**`control/outline-ring-32` is the case that decides it.** It exists *to be a correct 1px
outline* — it is §7's named negative control for §4.4's `colourOrphans` — and it draws one,
closed, in one colour. It receives all three of the dimension's structural codes. A case that
was committed to prove a predicate does not fire on a good contour is now evidence that it
does.

The two halves of that are the two findings above, and **neither half has been repaired.** The
`outline-missing` half has been *withdrawn* rather than fixed — it was the abstention path
behaving exactly as §4.5 specified, which is what makes it a specification defect rather than an
implementation one, and §3.6's verdict is why: a dimension reading a "neutral" 700 becomes a
`fail` wherever the total drops, so the neutral value was not neutral at the gate. See the
absent-contour subsection above.

The three codes on `outline-ring-32` and the two on `clean-figure-20` are the **wide `ink`
reading** of finding 2 and they are **still with us**. A ring drawn in one colour, closed, one
pixel thick, is read as deep and multi-coloured; and — worse, and the reason §4.5 is not
registerable today — so is a subject with **no contour at all**, which is measured in full
immediately below.

**None of this is a threshold that wanted moving**, which is the point. Raising `INK_MIN_DROP`
trades one false positive for another and still leaves the predicate reading shading; lowering the
share gate makes `outline-missing` fire on less and does not touch `outline-heavy`. The predicate
is what is wrong.
**Neither reading is safe and the specification does not choose between them.** The narrow one
(`ink` only on `edgePixel`s) keeps `lantern-keeper` quiet and makes the depth row
arithmetically dead; the wide one reaches the depth row and reports lit artwork as a 6px
contour. Finding 1 is what makes the choice sharp: on a uniform contour the wide reading
abstains, and on a lit subject it fires. What §4.5 needs is a predicate that says *this pixel is
the contour* — a band on `dist`, or a comparison against the subject's tone rather than its
neighbourhood — and both are new §3.3 quantities rather than a parameter.

**3. `inkGaps` counts the 45-degree staircase, and cannot tell a closed contour from a nicked
one.** This is §7's already-recorded §4.4 `colourOrphans` defect on `control/outline-ring-32`,
reproduced on a different quantity: every pixel on the diagonal run of a 1px staircase contour
reaches the rest of the run only diagonally, so the 4-neighbour predicate counts the staircase
itself. Measured on the 22-row disc, 60 boundary pixels:

```
closed 1px contour        -> 22 gaps (367 per-mille)
the same, 3px nick removed -> 22 gaps (367 per-mille)   <- identical
rectilinear closed ring    ->  0 gaps (  0 per-mille)
```

```
                                          as shipped
closed 1px contour        (60 px)  ->  0 gaps (  0 per-mille)   <- the near-miss, exact
one 3px nick removed                  ->  2 gaps ( 33 per-mille)   <- gate at 50 does NOT fire
one 9px nick removed                  ->  2 gaps ( 33 per-mille)   <- identical
two 3px nicks removed                ->  4 gaps ( 67 per-mille)   <- gate fires
rectilinear closed ring    (60 px)  ->  0 gaps (  0 per-mille)
```

So the gate at `5/100` fires on **every** correctly drawn 1px staircase contour in this
repository's style, and the reading is identical on a perfect contour and a damaged one — a
measure that cannot tell them apart is not measuring the thing its code names. The 8-neighbour
replacement was measured rather than assumed and reads **0 on all three**, so it discards the
staircase without recovering the nick. What the measure needs is a predicate about *where the
contour stops*, not about how each pixel is attached.

**4. The sparse-outline row is far narrower than it reads.** `outlineShare >= 60/100` **and**
`outlineCoverage < 3/100` requires `N > 20 * edgePixels`, since `edgePixels <= N` makes
`outlineShare >= outlineCoverage`. §3.3's own `dist` argument gives the same number from the
other side — a disc of radius `r` has `N / edgePixels` about `r / 2`, so the row needs `r > 40`.
It is a finding about subjects 80px across and cannot reach a character sprite at all, which is
not visible from the row as written. (The first implementation of this test asserted the row was
*unreachable*, with the inequality the other way round. The test is the only reason that was
caught before it reached a report, which is the argument for having written it.)

**What did get fixed**, because both were arithmetic in the implementation rather than decisions
in this section. §3.7 gives `inkCount * 100 >= 80 * edgePixels`, so the denominator is the count
itself; a first version used `denominator + 1` and read `outlineShare` **984** on a subject with a
contour on every boundary pixel, which cannot describe a whole boundary as inked in a number an
agent reads. And the band table above is written descending; the first implementation stored it
ascending and returned the **first** matching row, which is the same class of defect in the same
place, and scored that same perfect contour **700** instead of 950. The lookup now keeps the
*last* matching row walking upward, so a ratio of 0 meets no row and reaches the "otherwise" row.

#### The two controls the abstention does not reach

`control/clean-figure-20` and `control/clean-union-16` are **declared negative controls**, they
draw **no contour at all**, and the abstention does not reach either of them: `outlineShare` reads
**327** and **416** against the gate of 150, so both are measured, and both come back carrying
`outline-inconsistent-weight` at 0.45 and `outline-gap` at 0.25, scoring **350** and **500**.
§3.5 calls a dimension that fires on clean work worse than one that misses a defect, so this is
the more expensive direction and it is measured here rather than deferred.

| quantity | `clean-figure-20` | `clean-union-16` |
| --- | --- | --- |
| `N` / `edgePixels` | 120 / 52 | 252 / 77 |
| `inkCount`, `outlineShare` | 17, **327** | 32, **416** |
| `outlineCoverage` | 317 | 369 |
| `minInkDepth` / `maxInkDepth` | 0 / 3 | 0 / 4 |
| `quadrantDepth` | `[3, 3, 1, 2]` | `[2, 3, 2, 4]` |
| spread (fires at `>= 2`) | **2** | **2** |
| `inkGaps` / `edgePixels` | 7 / 52 = **134** (fires at 50) | 13 / 77 = **168** |
| band base, Δ, `scoreQ` | 550, −200, **350** | 700, −200, **500** |
| dimension verdict | `warn` | `warn` |

**What these two drawings actually are, and why the dimension reads a contour on them.** Both are
**two-tone subjects with no third tone and no drawn contour at all.** The recipes are a dark
`#3a2f2a` body plus a lighter `#e8d9a0` half laid over part of it — `clean-figure-20` is a torso
and two legs where each limb's outer half is light, `clean-union-16` is six overlapping rectangles
with a light left half. Measured over the whole mask, each subject has **exactly two tones** and
they split it almost evenly: `clean-figure-20` is 60 px of `#e8d9a0` and 60 px of `#3a2f2a`
(`Lq` 215 and 48), `clean-union-16` is 118 and 134.

The predicate that produces the false positive is §4.5's **local** reference, and it needs no
mistake to fire: `dark(p) = localMean(p) - Lq(p) >= 20` asks *is this pixel darker than its
neighbours*, and on the boundary between the dark half and the transparent outside, it is — by 48
`Lq` against a neighbourhood that is mostly background-free dark. So the outer edge of the dark
half satisfies `dark`, is inside `CONTOUR_BAND`, and is 4-connected to the boundary. **The dark
half of the body *is* the contour as far as this predicate is concerned, and it is not:** it is
shading. §4.5's `encloses` clause was built for exactly this class of mistake — a dark region that
is on one side of the subject rather than around it — and it does **not** help here, because
`clean-figure-20`'s dark pixels are not a band beside the subject, they are *the subject*: there
is no lighter region for them to enclose, and a cast shadow's topology and a lit body's own dark
half have the same shape with respect to the flood.

That is the disproof for the repair that was already rejected once, restated on the corpus's own
controls: the 4px boundary shadow of finding 2's history and this two-tone shading **are the same
pixels**, and `encloses` separated them because the shadow occupied one side of a *lighter* body.
Here there is no lighter body, so there is nothing to be on one side of.

**Is the reading arguably correct, or a false positive?** It is a false positive, and the
fixture's expectation is not stale. The case note says "Nothing injected", the recipe draws no
third tone, and `inkColours` is **1** on both — the dimension itself reports that there is exactly
one colour on what it has decided is the contour, which is a subject with no contour and a
measurement that has invented one. A subject whose only two tones are its own body and its own
shading has declared nothing about its edge.

**Two readings of the numbers, both stated.**

- *If the reading were correct* — that is, if a two-tone figure should be told its contour is
  3–4px deep on one side and absent on the other — then `control/outline-ring-32`, a closed 1px
  contour in one colour, would be the false positive instead. It reads `outlineShare` **1000**,
  `quadrantDepth` `[0,0,0,0]`, `maxInkDepth` **0**, no codes, **950**. So the dimension is
  simultaneously right about the one drawing that has a contour and wrong about the two that do
  not. There is no threshold that separates them: the ring's share is 1000 and these are 327 and
  416, all on the same side of every band edge in §4.5's table, and the spread that fires is **2 on
  both controls and 0 on the ring** — the discriminator would have to run the wrong way.
- *What a repair would have to do.* The quantity that separates a drawn contour from a body tone
  is **the share of that tone's pixels that lie on the boundary**: a contour exists to be the
  boundary, so essentially all of it is there; a shading tone is a large minority of the mask and
  only its rim reaches the edge. Measured over the whole mask, per tone, on the fixtures this
  section turns on:

  ```
                          the tone read as contour          a body tone
  outline-ring-32         1c1c1d  48px, 1000/1000 on boundary   c9a227  160px, 0
  lantern-keeper.pixel    1e2533  79px,  898/1000 on boundary   7a4445  66px, 0
  value/level-set-32      17903f  98px,  530/1000 on boundary   0f5a43  66px, 0
  clean-figure-20         3a2f2a  60px,  433/1000 on boundary   (both tones read 433)
  clean-union-16          3a2f2a 134px,  305/1000 on boundary   (both tones read 305)
  ```

  **The disproof, stated as §3.3 requires it: this separates the three controls from the three
  genuine contours, and the margin is 97 per-mille — 433 against 530 — with nothing in the corpus
  designed to sit between them.** A threshold there is a guess, not a measurement, and §7's
  standing rule is that a threshold is a product decision taken against a designed contrast. The
  other two controls this same reading covers, `control/clean-blob-16` at 400 and
  `control/six-hue-families-32` at 388, are *already* abstained by the 150 gate, so the reading
  buys nothing the gate has not already bought — it exists to rescue exactly two rows, and it costs
  a new §3.3 quantity that four of the six measured subjects do not need.

**Recommendation, with its cost.** Do not ship the boundary-share discriminator, and do not raise a
threshold or move a fixture. The honest position is that **§4.5 cannot be registered until `ink`
distinguishes a drawn contour from a body tone, and no threshold available today does it.** The
cheapest next step is not a gate at all: it is a synthetic control that draws a two-tone subject
**with and without** a third contour tone — the contrast pair §6.2 asks for and this corpus does
not have — so the next attempt at the predicate is measured against a pair designed to separate
rather than against two controls that happen to disagree. **Cost of leaving it as it is:** with
`outline` registered, `control/clean-figure-20` and `control/clean-union-16` carry two advisory
codes each and score 350 and 500 against a `FLOOR_WARN` of 600, so both verdicts are `warn` on
work declared clean. **Neither blocks** — the severities are 0.45 and 0.25, both under §5.3's 0.50 —
so the cost is two warnings a reviewer learns to ignore, which is the cost §3.5 warns about but not
a cost §5.5's gate can refuse to finalise over. That is a decision about whether to register
`outline`, and it is recorded here as the reason the dimension is held back rather than as a
finding against the artwork.

**The abstention path has since been rewritten, and this paragraph recorded why it was wrong.**
It shipped as specified: `scoreQ: 700`, an `outline-missing` code, and a sentence in the verdict
saying the band table had not run. The reason it was wrong is the same reason
`silhouette` and `value` are applicability rather than measurements — a dimension that has nothing
to say must contribute **nothing**, and 700 plus a code is a number and a defect report where the
correct answer is neither. See the absent-contour subsection above for what replaced it.

**Measured over the ten committed scenes**, all ten read `outlineShare` 0..135 and **all ten are
`no-subject` under `requiresReadableSubject`** — which is this dimension's reason for existing as
an exclusion rather than as a measurement, and it is the reason that fires first. Under
`outlineApplicability` alone all ten would read `no-outline`; the aggregator reports `no-subject`,
because "there is no shape to read a contour around" is a stronger and different claim than "this
subject chose no contour", and a scene's framing is not a stylistic decision. `app/icon.png`
reads `inkCount` **0** and `inkColours` **0**: it is a soft-edged render with no pixel anywhere on
its boundary 20 `Lq` darker than its neighbourhood, so it reports no contour rather than a
spurious one. (`docs/ROADMAP.md` predicted that `outline` would read `curvedQ max` 818 on the icon
as `value` does. **It does not compute a curvature at all**, and 818 is `value`'s own reading.
#### Three further findings, all measured against the shipped predicate

The four findings above are T-016's. The rewrite of `ink` that answering them forced produced
three more, and they are recorded here with the same discipline: a number, a construction, and a
statement of what would have to change to make the reading better.

**5. The depth reading is one pixel shallow at every rectilinear corner, and `minInkDepth` and
`quadrantDepth` disagree because of it.** `inkRun` is 4-connected (§3.3's subject is
4-connected and `connectivity/diagonal-bridge-16` declares a diagonal-only contact a defect), and
on a rectilinear corner the step inward is the *diagonal* pixel: from `(8,8)` on a 16x16 block the
first neighbour at `dist + 1` is `(9,9)`, which the recurrence cannot reach. So a corner always
reads one pixel shallower than the contour around it, whatever the contour's real thickness.

```
uniform 2px contour on a 16x16 block:
  minInkDepth   0        <- the four corners, and only the four corners
  maxInkDepth   1
  quadrantDepth [1, 1, 1, 1]      <- per-quadrant MAX, so it hides the corners
```

Exactly four contour pixels are affected, `(8,8) (23,8) (8,23) (23,23)`. This matters because
the depth row reads `minInkDepth`: **the minimum over a rectilinear contour is a reading of its
corners, not of its weight.** §4.5's two heavy rows collide here — a contour that is 4px thick
everywhere reads `minInkDepth 0` and is not heavy; a contour that is 1px thick at one corner and
4px everywhere else also reads `minInkDepth 0`. The reading is honest about what it can see and
the reading that would fix it (an 8-connected run, or excluding the four corner pixels) trades
§4.5's stated 4-connectivity for a diagonal-only contact it has already declared a defect. The
numbers are pinned in `quality-outline.test.ts` on both sides, and `quadrantDepth` is the reading
an agent should use for "is the weight the same all the way round", because it is a max.

**6. The gap gate counts *events*, not missing length, and a single large nick is invisible to
it.** Finding 3 above measures the shipped predicate: a closed contour reads 0 events whatever its
shape, which is exact, and one nick reads 2 events whatever its length, which is exact too — and
between them they mean the gate at `5/100` is a gate on **how many times the contour stops**,
not on **how much of it is missing**. Measured over nick lengths of 3, 4, 5, 6 and 9 rows on the
22-row disc: **2 events every time**, 33 per-mille, under the 50 gate. Two three-row nicks read 4
events, 67 per-mille, and the gate fires. A third of a flank missing goes unreported; two small
nicks go reported. Both directions are asserted as a MUST FIRE and a NEAR MISS on the same gate,
because a one-sided threshold is not a threshold.

Across the whole corpus the row fires on **five frames**, and **two of them are declared negative
controls**:

```
artwork/verify/lantern-keeper.pixel   20/101   (198 per-mille)
control/clean-figure-20                7/52   (135 per-mille)   <- negative control
control/clean-union-16                13/77   (169 per-mille)   <- negative control
value/level-set-32                     4/58   ( 69 per-mille)
connectivity/background-diagonal-leak-9  7/17  (412 per-mille)
```

Severity 0.25 and advisory, so this costs 50 per-mille on two clean controls and fails nothing —
and §4.5 states plainly that a gap **must not** punish selective outlining, which is recommended
craft. The honest reading is that this row is a prompt for a human eye, not a defect count, and
the corpus numbers above are the evidence for leaving it advisory. A reader who wants it to
measure missing length has the construction: count boundary pixels with no ink, rather than
runs of them — which is the old predicate, and which reads 22 on a perfect contour.

**7. The depth row did not fire anywhere in the corpus. REPAIRED — it fires now, on a
construction.**

This was the seventh measurement in this repository that could not fail, and it was arithmetic
rather than a bad threshold. Measured over all 79 corpus cases and every frame under the shipped
predicate:

```
outline-heavy fired on                     0 frames
frames reaching minInkDepth >= 3          23 frames
  ... of which abstained at share < 150    23 frames   <- all of them
```

Every frame that read a contour three or more pixels deep also read `outlineShare` below the
15/100 gate, so the band table never ran. The argument for why was a Lipschitz one and it was
sound: `dist` is 1-Lipschitz, so every solid pixel within Chebyshev radius 2 of a `dist 0`
contour pixel is at `dist <= 2` — exactly the reference window. If that contour pixel's inward run
reaches `dist 2` in one colour, its entire window is its own colour, the drop is 0, and it is not
`dark`.

**Every premise of that argument was a premise about the *local* reference, and the repair replaces
it with one that has no window of its own to be filled with.** With the body reference and the
enclosure gate, the row fires on a real construction — the case §4.5 said could not be drawn at
all, a **uniformly heavy but consistent contour**:

```
4px uniform contour on the 22-row staircase disc:
  outlineShare 1000, inkCount 60/60
  minInkDepth 3, maxInkDepth 3, quadrantDepth [3, 3, 3, 3]
  -> outline-heavy@0.50 (the depth row) AND outline-heavy@0.70 (the coverage row)
  -> scoreQ 600

near miss, one ring less, same construction, same gate:
  3 rings -> minInkDepth 2, no 0.50 row, scoreQ 950
  2 rings -> minInkDepth 1, no 0.50 row, scoreQ 950
  1 ring  -> minInkDepth 0, no 0.50 row, scoreQ 950
```

**The staircase is not a stylistic choice, it is the only shape that can witness this row.**
Over a *block*, every ring count reads `minInkDepth 0` at the four corners (finding 5), so a block
cannot witness either side of the `>= 3` gate — the near miss and the must fire would be
indistinguishable. A 45-degree staircase has no corners and every contour pixel on it reads its
true depth, so the row has a bound it can be measured against.

**What the row costs, stated rather than argued away.** Over the corpus the repaired predicate
still fires `outline-heavy` at 0.50 on **0 frames** — there is no uniform thick contour in the
corpus, which is a fact about the corpus and not about the row. Nine of the 23 frames still
read below `share < 150`, and `encloses` is why they are not contours: a full-bleed scene and a
one-sided shadow are refused by the topology rather than by the accident that they had no local
contrast. **Those frames are no longer *scored* at all.** Since the absent-contour case became an
`ExcludedReason`, a document whose every inked frame is below 150 has no `outline` dimension in
its report, and the deep readings those frames produce are no longer visible anywhere a report can
be read. That is a real loss of information and it is the price of the abstention; §4.5's table
above cannot report a measurement of a dimension that has declined to measure.


| code | fires when | severity | blocking |
| --- | --- | --- | --- |
| `outline-gap` | `inkGaps / edgePixels >= 5/100`, or a sparse outline | 0.25 / 0.35 | no |
| `outline-inconsistent-weight` | quadrant depth spread `>= 2` | 0.45 | no |
| `outline-colour-split` | `>= 4` ink colours, none dominant | 0.25 | no |
| `outline-heavy` | `minInkDepth >= 3` or `coverage >= 0.45` | 0.50 / 0.70 | **yes** at 0.70 |

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
minInkDepth           3                                          -> -150   (was maxInkDepth)
inkColours            2                                          -> no
inkGaps / edgePixels  11/168 = 0.0655          >= 0.05          ->  -50
adjustment            -350
scoreQ                950 - 350 = 600  ->  0.60
```

Verdict: *"contour on 83% of the boundary, 3px deep at the top and 1px at the bottom, 2 ink
colours, 11 gaps."* That is a real and very common fault — a head that has been outlined too
hard — and the issue's `rect` points at the top half of the bounding box, so the fix is a
`clear_region` on one rect.

**This worked example is illustrative, not measured**, and one row of it has changed. It reads
`minInkDepth` where it read `maxInkDepth`, because the depth row does: §4.5 has **two** weight
faults with their own rows — a contour that is too thick (`outline-heavy`) and a contour whose
weight varies (`outline-inconsistent-weight`) — and a `max` over the contour reports the first on
the strength of a single deep patch, which is the second row's job, so one mistake was charged
twice and the second row's reading was corroborated by a number that does not mean it. Measured
on the two declared negative controls this replaced: `control/clean-figure-20` reads `minInkDepth
0, maxInkDepth 3` and `control/clean-union-16` reads `minInkDepth 0, maxInkDepth 4`. Both are
**partially** rimmed subjects — a dark tone along part of the boundary and body tone along the
rest — and both genuinely have a four-pixel dark column; `min` reports that as what it is, one
inconsistent-weight row, where `max` reported it as a heavy contour and blocked both documents.
**The cost, stated rather than argued away:** a 4px contour on the head with a 1px contour on the
body now takes **one** Δ (−150, `outline-inconsistent-weight`) where it took two (−300, both rows).
That is a real defect being scored half as heavily, and it is a product decision rather than an
arithmetic one; a reader who disagrees should know exactly what to change.

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

#### Evidence

**Seven corpus cases, one per code, and one clean multi-frame control.** `benchmarks/corpus/`
holds `motion/clean-walk-40x32`, `motion/loop-seam-pop-32x32`, `motion/loop-seam-jump-40x32`,
`motion/frame-jitter-40x40`, `motion/timing-mismatch-32x32`, `motion/timing-outlier-40x32` and
`motion/loop-duration-out-of-range-40x32`, and `packages/core/test/quality-motion.test.ts` asserts
each of them from the committed recipe with a MUST FIRE and a near-miss on the other side of the
same gate. The control is the one that carries the weight, and it is **not** a still sprite: six
frames of a body walked right by four pixels and back, changing **96 of its own 240 pixels on every
transition including the seam** (`churn [96 96 96 96 96 96]`, seam 96, `areaSpreadQ 0`, every frame
100ms), which reads 1000 with no issue at all. A dimension whose firing behaviour on good work has
never been observed is the shape of the measurements this project has already shipped that could
not fail, and a control that was clean because nothing moved would not have closed that hole.

**Three facts the corpus says that this section did not.**

1. **`loop-seam-pop` and `loop-seam-jump` are independent, and the corpus is what shows it.**
   `motion/loop-seam-jump-40x32` fires the jump row and **not** the pop row, because its seam
   ratio lands exactly on the inclusive `1.75` boundary (`168 * 20 === 35 * 96`).
   `motion/loop-seam-pop-32x32` fires the pop row and not the jump row, because its silhouette is
   byte-identical across the seam and the whole finding is in the tone channel. Neither fact is
   visible from one fixture, and a corpus whose only pops were positional could never have shown
   the tone half working at all.
2. **For a rigidly translating body the two rows are the same ratio, so a positional pop always
   fires both.** A translation moves the centroid and the pixel count by the same fraction, so
   `seamStep / maxStep` and `seam / churnMedian` agree; `loop-seam-jump`'s window is (1.5, ∞)
   and `loop-seam-pop`'s is (1.75, ∞). The overlap is the reason the pop case above is built on
   tone rather than on position, and it is worth knowing before drawing another one.
3. **A frame that jumps also makes `timing-mismatch` true, whenever the timing is even.** The row
   is `allDurationsEqual and deltaSpread >= 600`, and `deltaSpread` is measured over internal
   transitions, so any internal transition that moves more ink than the others raises it. That is
   the specification working rather than two defects overlapping, but it means one fixture cannot
   isolate `frame-jitter`: `motion/frame-jitter-40x40` holds its frames 80/100/120/140/160/120ms
   deliberately, and says so in the case note.

**What is not here.** There is no corpus case for `key-light-inconsistent`, for the same reason
there is none in `value`: it is a subject-level taste check with one sample in this repository. And
the `durations` recipe op exists only because §4.6's three timing rows are otherwise
unconstructible — `createSprite`'s default is a uniform 100ms, so a corpus that can only draw
pixels can produce an animation that is perfectly timed and never one that is not.

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
#### Per-asset-class weight profiles — §7 item 8

The table in §5.1 is the **`sprite` profile**. It is not *the* weight table any more: there are
three, and which one a document is scored under is a fact the report carries.

| Profile | Applies when | Source |
| --- | --- | --- |
| `sprite` | a still document on a canvas of 16384px or fewer (§5.1's table, unchanged) | derived |
| `animation` | the evaluated sequence has measurable motion — two or more frames that are **not** all byte-identical | derived |
| `scene` | otherwise, and the canvas area is above 16384px (a 256² or 512² landscape) | derived |

**A caller may name a class instead**, on `evaluate`, `verify` and `qualityGateForSprite`
(`assetClass: "sprite" | "animation" | "scene"`). The rule is *derived by default, overridable,
and the override wins*, for one concrete reason: `frames: [0]` on a four-frame walk cycle is a
still sequence, so the honest derived answer is `sprite` while the caller knows the asset is an
animation. `QualityReport.assetClass` records `{cls, source}` either way, so "the caller was
right" and "the aggregator was right" are both checkable after the fact.

**`animation` is tested before area, and that is the arguable half of the rule.** An animated
256² background is an `animation`, not a `scene`. The reason is that the two questions are not
peers: motion applicability is a fact about *this evaluation*, while area is a property of the
canvas, and a total that moved because a caller passed `frames: [0]` instead of the loop would be
moving when nothing about the artwork changed. A still 256² canvas has no motion to weigh, so it
falls through to the area rule and is scored as a scene.

Three classes, not four. §7 item 8 names an icon, a walk cycle, a tile and a scene; an icon and a
tile are both still subjects on a small canvas and both resolve to `sprite`, and inventing a
class for each would be two more sets of numbers with **zero** evidence behind them.

**Every weight below is CHOSEN, not measured.** §3 and §7 item 10 say so about every threshold in
§4 and it applies with more force here: §6.2 has never been run on an animation or on a scene, the
human-rated section of the corpus is empty, and this repository has **zero human ratings of any
kind**. `sprite` is the only profile with anything behind it — §6.2's single pass, on one sprite —
and `animation` and `scene` are arguments:

| Dimension | `sprite` (§5.1) | `animation` | `scene` |
| --- | --- | --- | --- |
| `silhouette` | 300 | 280 | 200 |
| `value` | 260 | 230 | 320 |
| `palette` | 140 | 120 | 220 |
| `noise` | 120 | 100 | 140 |
| `outline` | 100 | 80 | 60 |
| `motion` | 80 | 190 | 60 |

- **`animation`: motion 80 → 190.** A walk cycle whose area churns and whose loop seam pops is a
  broken cycle even when every individual frame is a handsome drawing, and at 80 of 1000 `motion`
  cannot outvote a good silhouette.
- **`scene`: 100 points off `silhouette` and `outline`, onto `value` and `palette`.** A
  full-bleed landscape has no subject to read — which is why `silhouette` and `outline` are
  usually *excluded* there and their weights are then irrelevant — and is carried instead by its
  value planes and its colour discipline.

All three columns sum to 1000, which is asserted in `test/quality-asset-class.test.ts` rather than
left to review.

**The backward-compatibility guarantee is exact.** Nothing specified resolves to `sprite`, and
`sprite` **is** §5.1's table — the same object, not a copy that can drift — so `evaluate` with no
arguments produces the same integer total, the same `score` and the same `verdict` it produced
before profiles existed. The gate reads the class off the report rather than re-deriving it, so a
report and its refusal cannot be about different numbers.

**What would turn these into measurements**, stated once so it is checkable: §6.2's protocol — a
rater panel scoring N assets per class with the machine's numbers withheld — plus, per class, the
distribution of the per-dimension scores on the corpus's rows of that class. The test that would
justify a weight is the **disproof**, not the agreement: *"a clean control of class C scores X on
the dimension this weight moves and the defective case of the same class scores Y, and no other
cut separates them."* Until that exists, these are hypotheses under review like every band in §4.

**What moved, and where.** 13 of the corpus's 79 rows change class and therefore their total; the
other 66 are byte-identical. Two rows become `animation` (both are 16×16 two-frame cases),
eleven become `scene` (the ten committed `artwork/` scenes, the two `sweep/band-*` cases on a
1024² canvas, and `app/icon.png`). No row changes **verdict**: nothing crosses §5.3's 800 line and
every row that was already failing is still failing.


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

### 5.5 The delivery gate

`evaluate` reports; a second thing refuses. §2.1's third audience is the CI / `verify` gate, and
this is its rule. It is deliberately not `evaluate` with a stricter threshold bolted on, because it
answers a question the report does not: whether anything failed to be measured at all.

Three commands on the bus, and the split between them is the whole design.

| command | verb | what it does |
| --- | --- | --- |
| `evaluate` | reports | The whole report: one entry per measured dimension with its per-mille `scoreQ`, its verdict sentence, its issues and its `unmeasured` map, plus `excluded` and the reason for each absent dimension. |
| `fix` | plans | `{command, params}` pairs for the issues that have one unambiguous repair, and prose for the ones that do not. **Never executes them.** |
| `verify` | refuses | A `CommandError` naming the failing code and its measured number — or, with `bypass`, a decision that says out loud that the asset was released anyway. |

All three are `readOnly`: asking a question must not push an undo entry or discard a redo stack.
`fix` returning its ops rather than running them is the same rule seen from the other side — every
mutation goes through `applyCommand`, so a repair lands as one undo step that the caller controls
and can inspect first.

#### The threshold

| `threshold` | refuses when | what it adds |
| --- | --- | --- |
| `fail` (default) | the verdict is `fail` | nothing. This is §5.3's rule, unchanged |
| `warn` | the verdict is anything but `pass` | `FLOOR_WARN` on every measured dimension, and `SCORE_PASS_THRESHOLD` on the weighted total |

`fail` is the default because §2.1's tolerance column says a gate nobody has measured is a gate
that blocks good work, and §6.2 has run exactly once, on one sprite (§7.10). `fail` refuses on
things that are **named** — an issue at or above `SEVERITY_BLOCKING`, whose codes and severities
are fixed in Appendix A, or a *measured* dimension below its `FLOOR_FAIL`. `warn` additionally
refuses on the weighted total, which is the one channel where an abstention is netted against
unrelated clean readings (§7's open question) and which nobody should switch on without having run
§6 on their own assets first.

The property the gate is written to hold is one equation:

> `passed === (verdict !== 'fail')` at `fail`, and `passed === (verdict === 'pass')` at `warn`.

The refusal list is therefore **not** a second opinion on the verdict. It is the verdict's own
definition decomposed into the named reasons behind it, so every refusal can say which code and
which measured per-mille number. There is no channel in the gate that can refuse for a reason the
verdict does not already hold.

#### "Failed" is not "not applicable"

Floors apply to present dimensions only, exactly as in §5.3, and the gate adds one case on top of
that. A target where **no** dimension applied totals 0, and §5.2 records that as `fail` only
because 0 is the only way a *required number* can say "nothing was measured". The gate passes it,
and says `measured: false` rather than pretending either way: refusing on an absence is the
fake-defect failure this whole layer exists to prevent.

A full-bleed scene is the ordinary version of the same thing. `silhouette` is excluded with
`no-subject`, that is a fact about the document rather than a defect, and no refusal ever mentions
it. `notApplicable` travels in the same result as `refusals` so a reader cannot mistake one for
the other.

#### What a refusal says

The code first and the measured per-mille number second, with the analyzer's own sentence clipped
behind both, because **a refusal an agent cannot act on is indistinguishable from a broken tool**.

```
shape-clipped (0,4 12x12) at 800/1000 against 500/1000 in silhouette (the shape reaches 3 of
the 4 canvas edges, so the sprite is cut off; add margin or shrink the subject)
```

is an action. "The quality is 0.68" is a to-do list. Up to three reasons are named and the rest
are counted, and the message never carries a 0..1 score: §3 deleted a `quality_report` tool over
that number and this section is written so it cannot come back through the gate.

#### The bypass

`bypass: true` requires `bypassReason` and releases the asset **without making it pass**:
`passed` stays `false`, and the result carries `bypassed: true`, the reason, and a `notice`
string stating that the asset does not meet the gate and was released anyway. A delivery path
puts that string in its own result. The escape hatch is deliberately loud in three places,
because an agent will otherwise reach for it silently and a gate that can be turned off without a
trace is not a gate.

#### Where it lives

`verify` is the command, and it **throws**, because returning `passed: false` would not be a
refusal: a client would read it as a successful command and move on. A session tool holding a
`Sprite` rather than a `Draft` should call `assertFinalizable(sprite, options)` from
`@pixel/core` instead — it measures, refuses with the same message and a `CommandError` carrying
code `command_failed`, and returns the report alongside the decision so both can be shown to
whoever asked for the bypass. `finalize_document` calls it before it writes anything.

#### Wired: `finalize_document`

`finalize_document` is the one tool that writes, so it is the one place a gate that returned
`passed: false` would be reported as a successful delivery. It calls
`assertFinalizable(doc.editor.sprite, { threshold: 'fail' })` **before anything is rendered or
written**, for two reasons: a client that treats a failed tool call as a failed write is correct
by construction, and a refused asset must leave no half-written bundle for the next run to skip as
"unchanged".

`threshold` is fixed at `fail` and **not exposed**. `warn` is the total-score channel, and this
section already says nobody should switch it on without having run §6 on their own assets; a
delivery path is the last place to put that switch. The two extra arguments are `bypass` and
`bypassReason`, on the tool's own input schema — no new session tool, so the advertised surface
stays where it was.

What the three paths look like on the wire:

```
refusal
  { ok: false, isError: true, code: "command_failed",
    error: "quality gate refused (threshold `fail`): off-palette at 550/1000 against 500/1000 in
            palette (64 of 64 solid pixels are a colour that is not in the document palette
            (100% of the surface). …); palette at 200/1000 against its floor 400/1000. Fix the
            named defects and re-run, or re-run with `bypass: true` and a reason.",
    refusals: [ { kind, dimension, code, rect, measuredQ, thresholdQ, message }, … ],
    notApplicable: { outline: "not-implemented", motion: "not-implemented" },
    remediation: "Call `evaluate` for the full report, then `fix` for the repairs it can plan.
                  Re-run this call once the named defects are gone, or pass `bypass: true` with
                  a `bypassReason`." }

bypass
  { ok: true,
    qualityGate: { threshold, passed: false, measured, refusals, notApplicable },
    bypassed: true, bypassReason: "…",
    notice: "QUALITY GATE BYPASSED: this asset does not meet the quality gate (off-palette
             550/1000 vs 500/1000; palette 200/1000 vs 400/1000) and was released anyway.
             Reason given: …" }

bypass without a reason
  { ok: false, code: "invalid_params", … }    // and never command_failed
```

The two failure codes mean different things and the distinction is load-bearing: `invalid_params`
is "your arguments were incomplete", `command_failed` is "the document refused". Telling an agent
the *document* refused when the truth is that it passed `bypass: true` with no reason would send
it looking for defects that are not there.

**A passing result carries the decision and the abstentions and nothing else.** `refusals` is
present even when empty so the shape is identical either way — a reader seeing `refusals: []`
beside `notApplicable: { silhouette: "no-subject" }` learns "nothing refused, and this is what was
not measured", rather than reading an empty list as "nothing was looked at". And **no `score`,
`quality` or `grade` field appears on any of the three paths**: this section deleted a
`quality_report` tool over exactly that number, and the delivery result is the last surface it
could come back through.

**One known cost of the strict setting, recorded rather than tuned.** At `threshold: "warn"` the
`bleed/` full-bleed cases refuse, on `value`'s reading and on the total, because `silhouette`'s
`no-subject` abstention drops 300 of the 1000 denominator and the remaining dimensions are then
read against a scale they were not tuned for. That is §7's open question about an abstention being
netted, it belongs to §5 and not to the gate, and it is the concrete reason `fail` is the default
rather than the permissive one.

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
  into a visible dot grid, and raters who judge at 4× will systematically over-report `noise`.
  The craft guide says this to agents; raters need it more.
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
| An absent outline is not graded at all | §4.5 | Nobody — this row used to say "an absent outline scores 700, not a penalty", which is the number §4.5 itself named as most likely to draw fire. It is now an `ExcludedReason`: the dimension contributes no score and no code, so there is nothing here to dispute. The dispute moved to §4.5's absent-contour subsection, where it is a claim about where the gate lives rather than about a number. |
| 3–5px dither seams | §4.4 | Pointillists, and anyone whose texture is meant to be busy. |
| A tone plane must nest around the form | §4.2 | Hard-surface artists, whose straight face splits on straight edges are correct. The curvature gate is the concession and it is a blunt one. |
| The worst plane, not the average one | §4.2 | Anyone who thinks a single bad terminator is a fair price for four good ones. |
| 2–3px islands of tone are not noise | §4.4 | Nobody will argue this, which is why it is written down: the gap is ours, not theirs. |
| Anything is better than 0 | §4.4 | Artists who prefer visible grain. |

**`palette` is registered, and the colour budget is the row it disputes most.** The only real
character sprite in this repository uses **19 declared swatches on a 32×32** — a `compact`
canvas, budget 16 — so it reports `colour-budget-exceeded` and `hue-sprawl` and scores 700. The
19 colours are 19 entries of its own DawnBringer palette, used as declared: `offPalette` is 0 and
the dimension's own verdict says "every colour declared". **The sprite is disciplined and the
budget says otherwise, and the budget is what §4.3 defines.** At 64×64 the same sprite would fit,
which is the convention in one sentence: the budget follows the canvas, not the asset. §4.3
keys it on area for a good reason — the canvas is what the artist chose — and that reason does
not extend to a sprite that was drawn small and intends to stay small.

**3. It will be confidently wrong about soft lighting.** `palette` measures the *composite*,
by default. A translucent highlight layer composites two declared swatches into a colour that
is in no palette, so a sprite with a perfectly disciplined palette scores `off-palette` and
lands near 0.32 for it. This is a known false positive, not a subtle one, and it is the
single most likely reason for a good asset to fail the gate. The mitigations are all
upstream: `paletteLocked: true` with opaque layers, or `quantize_to_palette` before
evaluating. We chose not to loosen the threshold, because loosening it would let real drift
through — the cost of a false positive here is an artist or a `fix` pass, and the cost of a
miss is a muddy shipped asset.

**It is not a rare shape, and this repository has two of them.** Two measured instances, both on
committed assets, and both for the same underlying reason — *the document's palette was never
this picture's palette*:

| case | why | measured | reported |
| --- | --- | --- | --- |
| `artwork/dusk-lake-valley-agent.pixel` | a `reflection` layer at **opacity 0.58** composites declared swatches together, and the blend lands at alpha ≈ 148 — above `ALPHA_SOLID` 128, so §3.3 counts it solid | 2,339 of 65,297 pixels, `rhu = 36` per-mille | `off-palette` advisory 0.35, plus a real `colour-budget-exceeded` (112 colours against the `scene` budget of 96) |
| `app/icon.png` | a PNG wrapped in a one-layer document against the default 16-entry palette, so **every** colour in it is undeclared | 878,544 of 878,544 pixels, `rhu = 1000`; 4,871 distinct colours; worst colour 16,631 from every swatch | `off-palette` **blocking** at 0.55, `invented-colours`, `colour-budget-exceeded`; `palette` scores **0** and the report is `fail` |

**No threshold separates "never quantised" from "drifted", because membership in a declared
palette is exact.** The clean controls read `offPalette` 0 and the icon reads 1,000 per-mille;
any cut that admits the icon admits every snapping miss with it, and the icon is not "more
undisciplined" than `artwork/sunset-lighthouse-512-baseline-model-a.pixel` at 9 per-mille — it is
a different thing, and §4.3's ratio has no way to say which. **The disproof is recorded rather
than the gate moved.** The one honest mitigation is upstream, exactly as above, and for the icon
that is `quantize_to_palette` at import rather than at the end: an asset that arrives unquantised
should be quantised on the way in.

**And a second order of the same fault, which no threshold can reach either:** a *partial* alpha
is the only place this shows up without any layer being translucent in the document's own
terms. `palette` counts pixels at `1 <= alpha < ALPHA_SOLID` and names them in its verdict (§3.1)
rather than scoring them, so a 0.29-alpha glow is never itself the off-palette pixel — but a
translucent layer composited at 0.58 produces **opaque** pixels in the composite, and those are
counted, which is the whole of the mechanism above.

**4. It cannot see intent, in either direction.** A deliberately asymmetric profile sprite is
penalised for nothing and credited for nothing. A deliberately held animation frame is
reported as `no-motion-content` and `frames-identical` when it was the right call. There is
no mechanism for "I meant that", because there is no mechanism for knowing.

**5. The form-conformance term is an approximation, and an honest one — and on real artwork it is
currently inert.** Two separate problems, and the second is the more serious.

*The approximation.* `bendQ` measures whether a plane boundary **turns**, which is a proxy for
"does this plane follow the form", not the thing itself. It cannot distinguish a genuinely concentric
terminator from a wiggly one that happens to double back, and it cannot tell a nested plane from a
*deliberately* offset one — a rim light following an edge at 1px and a core shadow following it at
3px both read as conforming, which is right, but a plane that follows the form of a *different* form
also reads as conforming, and that is wrong. It also inherits one structural weakness: it says
nothing about a plane that is the right shape in the wrong place. A sprite whose cloak shading
mirrors the body's contour when the cloak hangs straight will score well here and read as wrong.

The curvature gate makes it usable on hard-surface art, and the gate is a blunt instrument: a local
count of convex staircase corners is a proxy for "this outline is round here", and a tight polygon
approximating a circle with few corners will fall below the 250/1000 threshold and be treated as
straight-edged. That is the safe direction — it downgrades a blocking severity to an advisory — but
it is a direction, not a solution.

*The inertness — fixed, and what it cost to fix.* `crossesQ` was **0 on every one of the twelve real
artworks in the corpus**, and on **ten of them no plane was ever eligible to be judged**, so `formQ`
read 1000 and `value` read 700 to 950 on a term that had not looked at anything. All ten were
full-bleed, and the cause was measured rather than guessed: §4.2's curvature gate read local
curvature off the subject's outline, a full-bleed subject's outline is the canvas rectangle, and
`maxCurvedQ` over every plane of every scene was 0..77 against a gate of 250. T-013 recorded this as
"the curvature gate reads nothing on a full-bleed subject", and the number that followed it — a
perfect form score — sat in the committed baseline through three tasks without anybody asking where
it came from. §3.3's `regionCurvedQ` is the fix and the ten scenes now read 667..880; **three of
them have a measured `formQ` of 1000 that they previously reported as `unmeasured`, and the other
seven are still `unmeasured` because every plane in them is gated on `reachQ` rather than on
curvature.**

The corpus has a dedicated `unmeasured sub-scores` column so the absence is re-derived on every run
instead of being a paragraph in a comment somebody trusts, and that is the mechanism that let the
three rows move without anybody deciding they should.

*What is still missing, and it is not the curvature half.* **Seven of the ten scenes still report
`formQ: unmeasured`, and the blocker there is `reachQ`, not curvature** — a boundary that dies out as
a fragment rather than crossing the body is a different question from one that does not follow the
form, and §4.2 gates it on purpose. `sunset-lighthouse-512.pixel` has 1008 terminators and every one
of them is gated. That is the next coverage gap and it is a separate piece of work.

**The curvature half of that gap is now closed.** T-101 added §3.3's `planeCurvedQ`, which reads a
region's curvature with the plane's own boundary removed, and the pair that read 260 against 248 —
caught at one row and excused at another — now reads 333 against 420, both clear of the gate. The
straight-band case is in the corpus and reports `plane-crosses-form`. Lowering `CURVATURE_GATE` was
never the fix and §3.3 still says why: the box is at 93 and would have been admitted by another route.

**`noise` is registered, and every reason it was held back turned out to be an implementation
defect rather than a specification defect.** That is the finding worth keeping, and it has the
same shape as the one T-012 produced on this dimension: the prose was argued from reasoning, the
analyzer was written against the prose, and the corpus found that three of the four ways that
prose could be mis-implemented had been mis-implemented. `silhouette`, `value` and `noise` are
the three dimensions in the aggregator now, and across the corpus `noise` runs **825..1000 with a
median of 1000**.

**The alternation counter in §3.3's `ditherMask` was capped at 1.** The scan over each candidate
component early-exited on the first alternating pixel, as an optimisation, so `alternating` could
never exceed 1 and the gate `1 * 1000 < 400 * |R|` held for every component `|R| >= 8` could
produce. `ditherMask` returned nothing on **every case in the corpus**, a perfect 50% checkerboard
among them, which is the structure it exists to find. It reported "no dither anywhere" and meant
"this counter cannot exceed 1", and those two are the same sentence from outside. Corrected,
per-mille `ditherShare` reads **0 on every declared `clean-control`** — all six `control/*`
negative controls included — and 0 on all three human-rated cases, **1..574 on the ten committed
artworks** (`artwork/verify/lantern-keeper.pixel` is the 574), **29** on `app/icon.png`, **261**
on `value/straight-diagonal-32` and **427** on `value/level-set-32`. That last number is what
removed an advisory instead of tuning one, and §3.3 has the rest.

**§4.4's `colourOrphans` was measuring a gradient, and a 1px outline besides.** Measured over the
whole corpus, the specified predicate — no same-bucket **4-neighbour** — is false on two of §4.4's
own worked-example rows. `control/outline-ring-32`, a **declared negative control**, read
**31/1000** past the `> 8/1000` trigger, because every pixel on the diagonal run of a 1px
staircase contour reaches the rest of the run only diagonally; and the ten committed scenes read
**9..153**, because in a ramp a pixel's 4-neighbours are the buckets either side of it, so having
no same-bucket 4-neighbour is the normal state of a picture and not a defect. The dimension was
firing on this repository's own clean work, which is the failure §3.5 says is worse than missing a
defect. Two replacements were measured and **both refuted**: treating a +/-1 bucket as agreement
takes the 512² scene 153 -> 27 and the 256² one 89 -> 25 while changing
`control/outline-ring-32` **not at all**, and comparing against the radius-1 range reads 0 on
that control while re-admitting the 2px specular highlight in
`artwork/verify/lantern-keeper.pixel` as a stray colour. The predicate that shipped asks radius 2
for same-bucket agreement **and** requires the pixel to sit outside the lightness range of
everything within 2px; measured, every declared `clean-control` reads **0** and the ten real
artworks read **0..10** against the trigger of 8. §4.4 has both refutations in full, because a
refuted approach is the thing a later revision can least re-derive.

**The band table was written in descending-bound order and read in that order**, which inverted
it: a ratio of 0 matched the `<= 50/1000` row and returned the worst sub-score, so every clean
control read `noise` **200 of 1000 with all four measures at exactly zero**. The committed table
was also a band wrong at every row — it had neither the `<= 2/1000 -> 1000` this section
specifies nor its `> 50/1000 -> 200` floor. After the fix every declared `clean-control` scores
`noise` 1000. The first thing to check on any band table in this repository is the direction it is
read in, because every row of a descending one is individually plausible and the defect is
invisible in review.

**A fourth defect, and it is the one the corpus caught rather than a reader.** The lightness range
in the new predicate was first accumulated with the pixel's own bucket seeding both ends, which
makes `own > hi` unsatisfiable and silently exempts every stray *brighter* than its surroundings
— the common half of the case. `defect/stray-colour-16` read zero orphans with two of them drawn
in. A predicate that half-works is worse than one that does not run, because the corpus case
asserting the defect is then the thing that has to be believed.

**`isolated`, `diagOnly` and `spurs` measured clean.** With `ditherMask` corrected, all three
read **0 on every declared `clean-control`** and **0 on all ten committed artworks**. They fire
only on `connectivity/diagonal-bridge-16` and `connectivity/contour-staircase-24`, both at
`diag = 1000/1000`, and both of those declare a real defect. The eleven line sprites in the
corpus report `noise.isolated/diagOnly/spurs = line-sprite` through AD-4's `unmeasured` map
rather than reading a 1000 they did not earn.

**`dither-dominant` is gone, and its absence is the measurement.** With the mask working, the
advisory specified at `ditherShare >= 100/1000` fires on `value/level-set-32` at **427** — a
declared negative control — and on `value/straight-diagonal-32` at **261**. Both draw 1–2px
concentric contours and one straight 45° cut, and this section already lists "a 1px outline is the
target" among the conventions the repository scores positively. **No threshold can fix it**: a 1px
alternation between two adjacent buckets **is** a dither pattern and **is** a contour line, so they
are the same set of pixels and §3.3's rule — no gate separates two cases that are equivalent on the
same pixels — applies directly. A second candidate was measured rather than assumed: adding an
"interior" clause, the share of the component whose 8-neighbourhood lies wholly inside it, on the
reasoning that a 1px line has no interior and a filled band does. It does not separate them, and
it separates them in the wrong order, `value/level-set-32` reading **200** where
`artwork/verify/lantern-keeper.pixel` reads **141**, because the two `value` cases draw their
contours **2px apart** and their pair's union set is therefore a band with an interior. Band
thickness is not the discriminator. `ditherShare` stays on the frame record as a measurement and
stops being a verdict.

**One accepted cost, stated plainly because there is no ground truth for it either way.** `noise`
fires `stray-colour` on exactly one committed artwork: `artwork/moonlit-alpine-lake.pixel`, at
**10/1000** against a trigger of 8. It is a hand-drawn 64×64 scene whose 13 tone buckets make ten
genuinely isolated pixels entirely plausible, and a pixel-level predicate cannot know what a person
meant by any of them. Nothing available here would settle whether those ten are mistakes, so this
is recorded as a cost rather than resolved in either direction — it is not fixed, and it is not
dropped either, and the corpus transcript carries the code against that case so the next reader
does not have to re-derive it. If it is ever decided, the deciding argument is a human looking at
ten pixels, not a threshold.

**Two gaps remain that are not curvature, and it is not `reachQ` either.** The first is `splitQ`:
`crossesQ` is exactly `splitQ` whenever `bendQ` is 0, so a straight cut is *reported* only when
§4.2 also judges it to bisect the form — which is the multiplier doing its documented job, not a
hole, and it is why the corpus case puts its band at the dome's middle rather than at an arbitrary
row.

**The second was believed to be `reachQ` and is not.** Seven full-bleed scenes have no judged plane,
and `reachQ` is what closes the last four of them, so the obvious reading is that its denominator is
the wrong scale on a full-bleed document. **Measured, that reading is wrong, and acting on it would
make things worse.** Plane extents are small everywhere: median 6..10px against a `bodyExtent` of
64..512, `p90` 16..33. On `artwork/sunset-lighthouse-512.pixel` — 512², 1008 terminators — the
**largest** plane is 110px where the gate wants 256, so `reachQ max` reads 215 and nothing can clear
it. A region-relative denominator would open 110 planes there, and **those 110 are water ripples and
sky sparks**: a short plane inside a small region scores *high* on a region-relative ratio, so the
change admits texture rather than form. `splitQ` damps that downstream, which is the wrong place to
rely on it.

**What the tone field actually is, counted.** 4-connected same-bucket regions:
`artwork/verify/lantern-keeper.pixel` 13 buckets / 101 regions (8 per bucket);
`artwork/dusk-lake-valley-agent.pixel` 12 / 1,142 (95); `artwork/autumn-dusk-lake-256.pixel` 13 /
6,751 (519); `artwork/sunset-lighthouse-512.pixel` 16 / **46,079 (2,880)**, of which 98.8% are 16
pixels or smaller. A hard-edged painting with 16 tones has tens of regions. **That is a dithered and
gradient tone field**, and §4.2's plane definition — both sides an area — finds no plane across a
dithered transition at all. So the sun's limb and the water's horizon in that painting were **never
planes**; they were not gated, they do not exist under this definition.

**And `reachQ` is accidentally a dither detector, pointing the right way.** The scenes it opens are
the least fragmented: 95, 519 and 632 regions per bucket read `reachQ max` 1000, 1000 and 996, and
those are the three whose `formQ` is measured. The two most fragmented, 2,880 and 1,672, read 215
and 236. A gate that closes on fragments is doing its job, and this is why **T-102 changed no gate**.

**What was missing is the ability to SAY this rather than let the report infer it**, and the
quantity that would is §3.3's `ditherMask`, which is now implemented and reads **1..574
per-mille** on the ten committed scenes. Until it landed, the `gated` column reported `curvature`
and `reach` on pictures whose real reason was neither, and all four of those scenes had **both**
gates closing something (lighthouse: 192 curvature, 816 reach). That was recorded rather than
papered over, and the state was pinned by a test so that a future change which suddenly judged them
would have to answer why.

**Registering a third dimension exposed a question this section does not own.**
`bleed/full-bleed-scene-32` and `bleed/one-pixel-guard-32` moved from `fail` to `warn` when
`noise` joined the aggregator. Nothing about either picture changed and no sub-score in either
changed. What changed is that a **third** dimension now applies to them and reads 1000, while
`silhouette` **abstains** on both (`no-subject`) — so an abstention was netted against an
unrelated clean reading. That is the same shape of problem AD-4 was written about, one level up: a
dimension that is silently absent is indistinguishable from one counted at its best, and here the
missing thing was not a sub-score inside a dimension but a whole dimension. Whether an abstention
should be netted at all is an aggregator question belonging to §5 and not to this task, so it is
recorded as **open** rather than decided here. Until it is decided, the verdicts in this section
are a statement about an aggregator choice as much as about a gate, which is worth knowing before
anyone reads one as a property of a picture.

The two real *subjects* in the corpus are not in this state: both have an outline, both have their
planes gated by `reachQ` as fragments, and both report a measured `formQ` 1000.

**6. `noise` is the dimension most likely to sand a piece flat.** The `colourOrphans`
predicate is sharp — it fires only on a pixel that agrees with nothing within two pixels *and*
sits outside the lightness range of everything around it — and it is still blind to a 2–3px island
of one tone inside another, because such an island contains its own partner and therefore agrees
with itself. Catching that and protecting a 2px specular dot are the same problem, and
`despeckle` ships `minClusterSize: 2-4` precisely so a cleanup pass will not delete a deliberate
highlight; §4.4 records the two replacements that were measured and refuted for exactly that
reason, and one of them would have started scoring that highlight as a stray colour. Radius 2
buys the 1px outline back at the price of a stray pixel buried inside a feature narrower than 4px,
and no threshold removes that without re-admitting the outline. `ditherMask` (§3.3) cannot
distinguish a legitimate 2px checkerboard from a mistaken 1px stipple, so both are exempted from
the noise measures — but nothing is *judged* on the result any more, so that ambiguity now costs a
number on the frame record rather than an advisory an artist has to argue with. A `sparse`
pattern at low coverage remains a plain miss: at low coverage the region stops being a connected
set of two adjacent buckets and falls out of the mask entirely.

**7. It measures the frames you name.** A sprite whose frame 0 is strong and frame 5 is
broken passes when evaluated on frame 0. For an animation, evaluate a *tag* — the aggregator
resolves it into a playback-ordered `frameIds` — and treat a per-frame pass as a statement
about that frame only.

**8. Per-asset-class weight profiles exist now, and they are guesses.** §5.2 carries
three — `sprite`, `animation`, `scene` — derived from whether the evaluated sequence has
measurable motion and from the canvas area, overridable by the caller, and recorded on the report
so a reader can tell which table produced a number. An icon, a walk cycle, a tile and a 256×256
scene no longer share a weight table.

**What is left is not the mechanism but the evidence.** The `sprite` column is §5.1's table, the
one §6.2 has run against once, on one sprite. The other two columns are **chosen**: there are zero
human ratings in this repository, so nothing distinguishes a good walk cycle from a bad one on
these numbers, and §6.2's protocol has never been run on an animation or a scene at all. Re-tuning
either column moves every corpus row of that class.

Two things this item deliberately did not do. It did not add a class per asset *kind* — an icon
and a tile both resolve to `sprite`, because a fifth and sixth table of numbers with no evidence
behind them is a worse outcome than admitting the two are judged alike. And it did not derive the
class from the document *kind*, because nothing here can tell an icon from a tile (§7 item 1); the
derivation reads only the frames and the canvas, both of which are facts rather than judgements.

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

**Retired before it shipped: `dither-dominant`.** It was specified at
`ditherShare >= 100/1000`, and with §3.3's `ditherMask` reading correctly it fires on
`value/level-set-32` at 427 — a declared negative control — because a 1px contour line and a 1px
stipple are the same set of pixels and no threshold separates them. §4.4 has the measurement and §7
the argument. `ditherShare` is still reported per-mille on the frame record, as a measurement.
Nothing branches on the string, and it must not be reintroduced.
**Added in this amendment: `plane-crosses-form`** (`value`, 0.30 / 0.60, blocking at 0.60) —
the form-conformance term's issue, and the one that separates a flat sticker from a lit volume.

Codes with two severities fire at the higher one past their stated threshold; the threshold is
in the dimension's issue table in §4. Exclusion reasons (`single-frame`, `no-motion-content`)
are **not** issue codes and live in the required `excluded` map (§3.6) — nothing should branch
on an exclusion reason as if a defect had been found, and both have exactly one producer
(§4.6).
