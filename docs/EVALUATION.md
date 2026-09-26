# Pixel-art quality evaluation — the scoring specification

> This document is the contract for `evaluate`. It is written for two readers at once: an
> engineer implementing one of the six analyzers, who needs to know exactly what to measure
> and how to band it, and a human pixel artist rating the benchmark corpus, who needs to know
> what each dimension means and how to judge it by eye. Either should be able to do their job
> from this file alone.
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
                 or any present dimension is below its FLOOR_FAIL (§5.3),
                 or the total is below 0.55
         = warn  if the total is below 0.80, or any present dimension is below 0.60
         = pass  otherwise
```

`blocking` is the load-bearing part: a `pass` with a blocking issue in it is not possible, so
a hard defect cannot be averaged away by good work elsewhere. The per-dimension floor is the
other: a 0.86 total with a `silhouette` of 0.30 is a `fail`, because a weighted mean should
not be allowed to hide a broken shape. See §5.3.

## 3. The shared measurement contract

Every dimension is a pure function of the document plus a small, explicit input. None of them
writes anything; none of them is a command; none of them has undo semantics. They are
`readOnly` in the same sense `measure_region` is.

### 3.1 Input

Each analyzer receives the sprite, plus:

| Parameter | Default | Meaning |
| --- | --- | --- |
| `frame` / `tag` | frame 0 / the whole document | The target. A `tag` resolves through `animationSequence(sprite, tag)` — the same helper the GIF and spritesheet exports use, so a pingpong loop is measured in playback order, not timeline order. |
| `rect` | whole canvas | Region to analyse. Everything below is measured inside it. |
| `layers` | all visible | Which layers to include. A hidden layer is not part of the asset. |
| `alphaThreshold` | **128** | Alpha at or above this counts as solid. |
| `background` | none | If given, the frame is composited over this colour first — needed for tilesets and anything that is always drawn on a known backdrop. |
| `scope` | `composite` | `composite` (the frame as it renders) or `cel` (one layer, on its own). |

The `alphaThreshold` default of 128 is a deliberate difference from the drawing commands,
which default to 1. A 0.2-alpha glow is a design decision, not a body part; letting it into
the silhouette would make `outline` trace a halo as a hard contour — the exact failure the
`outline` command's `alphaThreshold` exists to prevent. Pixels with `1 <= alpha < 128` are
counted separately as `partialAlpha` and reported in the verdict text. They are never
scored.

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

Defined once, used by every dimension. All of them are integer counts over the composited
frame (or over the `cel`, or inside `rect`).

| Name | Definition |
| --- | --- |
| `W`, `H` | `sprite.width`, `sprite.height` (whole canvas, not the region). |
| `S` | `W * H`. |
| `N` | Solid pixels (`alpha >= alphaThreshold`). |
| `bounds` | Tight bounding box of the solid pixels (`PixelBuffer.opaqueBounds()`). |
| `fill` | `N / (bounds.w * bounds.h)`. |
| `edge(p)` | `p` is solid and at least one of its 4 orthogonal neighbours is transparent or outside the canvas. |
| `P` | Count of `edge` pixels — the pixel perimeter. |
| `n4(p)`, `n8(p)` | Number of solid 4- and 8-neighbours of `p`. |
| `components` | Connected components of the solid mask under **4-connectivity**. |

4-connectivity is a deliberate choice, not an oversight. A shape whose parts touch only at a
corner is two shapes in a game: at 0.5× scale, with a filter, or on a CRT, the diagonal
contact disappears and the sprite falls in half. `diagOnly` (§4.4) measures exactly this.

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

### 3.6 Two additions to the AD-2 report shape

AD-2 fixes `{ score, verdict, issues }` per dimension and `{ dimensions, score, verdict,
blocking }` per report, and this document keeps all of it. Two additions are required by the
`motion` exclusion contract, and T-011 should fold them into `types.ts`:

1. **`dimensions` becomes `Readonly<Partial<Record<QualityDimensionId, QualityDimension>>>`**
   — one key may be absent, meaning *not applicable*. Presence of the key is the normative
   applicability test; there is no sentinel score, and in particular there is no `0.0`, so an
   excluded dimension can never be averaged in by a client that forgets to check. Everything
   else in AD-2 stands, and `score`/`verdict`/`blocking` are unchanged.
2. **`excluded?: Readonly<Partial<Record<QualityDimensionId, ExcludedReason>>>`**, where
   `ExcludedReason = 'single-frame' | 'no-motion-content'`. This is diagnostic — it explains
   an absence — and it is a closed enum precisely so an agent can tell "not applicable" from
   "the analyzer crashed" without string matching.

Both are additive on the wire. A client written against plain AD-2 still parses the report; it
simply sees five dimension keys where it expected six, and per §5.2 that is the correct total
for a still sprite.

### 3.7 Every ratio, in integer form

Rule 2 above means no threshold in §4 is ever evaluated as a float. This is the complete list,
so there is nothing left to guess. `rhu(a, b) = Math.floor((a + b/2) / b)` throughout, and
`A/1000` in a threshold means the test `A_numerator * 1000 >= A * A_denominator`.

| Quantity | Threshold as written in §4 | The test that implements it |
| --- | --- | --- |
| `share` | `>= 90/100` | `largest * 100 >= 90 * N` |
| `compactness` | `< 0.30` | `Q = rhu(4 * 355 * 1000 * N, 113 * P * P)` (π as 355/113), then `Q < 300` |
| `span` | `< 0.25` | `bounds.w * 4 < W \|\| bounds.h * 4 < H` |
| `hueOnlyRatio` | `> 25/100` | `hueOnlyEdges * 100 > 25 * internalEdges` |
| `dominantShare` | `>= 92/100` | `bucketMax * 100 >= 92 * N` |
| `shadowShare` | `>= 30/100` | `shadowCount * 100 >= 30 * N` |
| `highlightShare` | `>= 10/100` | `highlightCount * 100 >= 10 * N` |
| `offPaletteRatio` | `<= 20/100` | `offPalette * 100 <= 20 * N` |
| `muddyRatio` | `>= 5/100` | `muddyCount * 100 >= 5 * N` |
| `meanSat` | `< 15/100` | `sumS255 * 100 < 15 * N` |
| noise ratios | `> 8/1000` | `count * 1000 > 8 * N` |
| `outlineShare` | `>= 80/100` | `inkCount * 100 >= 80 * P` |
| `outlineCoverage` | `>= 45/100` | `inkCount * 100 >= 45 * N` |
| `inkGaps` | `>= 5/100` | `gaps * 100 >= 5 * P` |
| `seamRatio` | `<= 1.35` | `seam * 20 <= 27 * churnMedian` |
| `areaSpread` | `> 150/1000` | `Q = rhu((maxArea - minArea) * 1000, meanArea)`, then `Q > 150` |
| `deltaSpread` | `>= 0.6` | `Q = rhu((maxLum - minLum) * 1000, maxLum)`, then `Q >= 600` |
| `seamStep` | `> 1.5 * maxStep` | `seamStep * 2 > 3 * maxStep` |
| `churnMax` | `> 2 * churnMedian` | already integer |

Two of these are worth a sentence. `compactness` is the only quantity in the system that is
not rational to begin with, which is exactly why π is written as `355/113` and the division is
deferred to a per-mille integer — it removes the last non-deterministic operation in the
pipeline. And `areaSpread`'s denominator is `meanArea`, a rational number; compute it as
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
edgeCount P    pixels with >= 1 transparent 4-neighbour
compactnessQ   rhu(4 * 355 * 1000 * N, 113 * P * P)      <- isoperimetric quotient, per-mille
holes          4-connected components of the transparent mask that do NOT touch the canvas
               border; the background is 8-connected so a diagonal leak is not a hole
holeRatio      (sum of hole areas) / N
span           min(bounds.w / W, bounds.h / H)
```

Every ratio here is compared in integer form; §3.7 has the exact test for each.

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

**Worked example** — a 32×32 character sprite, frame 0, `alphaThreshold` 128:

```
solid N                612
bounds                 {x:6, y:4, w:20, h:26}
components (4-conn)    3        sizes 596, 9, 7        strayCount 2
share                  596/612 = 0.9738      >= 0.90, < 0.98   -> base 900
strayRatio             16/612  = 0.0261      > 0.02, strayCount 2  -> -150
holes                  2        areas 3, 2    smallest <= 3      -> -100
P                      168
compactnessQ           rhu(4*355*1000*612, 113*168*168)
                      = rhu(869_040_000, 3_189_312) = 272       < 300 -> -100
borderTouch            0
span                   min(20/32, 26/32) = 0.625
adjustment             -350     (within the -450 floor)
score                  900 - 350 = 550  ->  0.55
```

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

### 4.2 `value` — is the form carried by light and dark?

**What it is.** Whether the sprite's form is described by tone. Pixel art is not
photorealism: a 16×16 character has no room for material detail, so what carries the shape
is a small number of value planes — a lit side, a core shadow, an occlusion, a highlight —
each a clear step apart in lightness. `value` measures that: how many tone planes exist, how
far apart the extremes are, and — the real question — whether two pixels that are *different
colours* but the *same lightness* sit next to each other. If they do, the boundary between
them does not exist to the eye, and the form has been handed over to hue.

**Why it matters.** In a game the sprite is scaled, tinted, lit by the engine, and often seen
at 40px. Every one of those operations compresses value far more aggressively than hue. A
sprite that reads its form from hue — red armour against a green wall — stops reading the
moment the engine applies an ambient tint, the moment it is scaled down, or the moment it
lands on the wrong biome. A sprite that reads from value survives all of them. It is also
the difference between "a red blob" and "a red knight".

**How it is measured.**

```
Lq              integer luminance, §3.4
buckets         distinct LqBucket values present among solid pixels  <- primary
dominantShare   (pixels in the fullest bucket) / N
range           Lq_max - Lq_min
internalEdges   4-adjacent solid-solid pixel pairs
hueOnlyEdges    of those, pairs where the colours differ but LqBucket is equal
hueOnlyRatio    hueOnlyEdges / internalEdges
keyLight        mean Lq over solid pixels in the top-left ninth of `bounds`
                minus mean Lq over solid pixels in the bottom-right ninth
shadowShare     (pixels with Lq <= 12) / N
highlightShare  (pixels with Lq >= 243) / N
```

The key-light comparison uses the top-left and bottom-right ninths of the bounding box,
because top-left is the light convention this tool's craft guide teaches. It is a
*consistency* check, not a correctness check: a negative `keyLight` means the sprite is lit
from somewhere other than the convention, which is a decision, not a mistake. The adjustment
for it is −100, the smallest one in the table, and it is an advisory. If either ninth contains
no solid pixels — a tall thin sprite, a sprite with a hole where the light would fall — skip
the test entirely and say `"key light not measurable"` in the verdict rather than scoring a
zero. The same rule applies to any ratio whose denominator can be near zero: with
`internalEdges < 8` there is not enough interior to have an edge-ratio, so `hueOnlyRatio` is
reported as not measured and neither of its issues fires.

**Scoring.**

| distinct buckets | base |
| --- | --- |
| `>= 5` | 900 |
| `== 4` | 780 |
| `== 3` | 620 |
| `== 2` | 400 |
| `<= 1` | 150 |

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
| `hue-carries-form` | `hueOnlyRatio > 10/100` (severity 0.60 above 0.25, else 0.30) | 0.30 / 0.60 | **yes** at 0.60 |
| `narrow-value-range` | `range < 45` | 0.45 | no |
| `flat-value` | `dominantShare >= 0.92` or `buckets <= 1` | 0.55 | **yes** |
| `key-light-inconsistent` | `keyLight < 12`, or `keyLight <= -25` | 0.25 | no |
| `shadow-crushed` | `shadowShare >= 0.30` | 0.50 | **yes** |
| `highlight-blown` | `highlightShare >= 0.10` | 0.45 | no |

**Worked example** — the same 32×32 character:

```
buckets present         2, 5, 7, 9, 11            -> 5 distinct  -> base 900
dominantShare           bucket 7 = 318/612 = 0.5196
range                   214 - 22 = 192
internalEdges           1140
hueOnlyEdges            402      (red cloak against brown wall, same tone)
hueOnlyRatio            402/1140 = 0.3526          > 0.25          -> -250
keyLight                96 - 71 = +25              >= 12           -> no
shadowShare             0
highlightShare          0
score                   900 - 250 = 650  ->  0.65
```

Verdict text: *"5 tone planes, range 192, but 35% of internal edges change hue without
changing value — the form is carried by colour, not light."* That is a specific, fixable
criticism: push the cloaked side a full value step away from what is behind it. An artist
would agree, and would be able to fix it in thirty seconds.

**How a human rates this by eye** (1–5):

- **5** — form reads from tone alone. Squint until the hue disappears and the shape is still
  a solid, dimensional thing: a lit side and a shadow side, clearly separated.
- **4** — reads from tone, but one boundary depends on hue to be visible.
- **3** — form is legible but flat: mostly one tone with a hint of shading, or the light and
  shadow are the same lightness with a hue difference doing the work.
- **2** — two or three tones scattered rather than placed; no clear lit side.
- **1** — one flat colour, or the shading is invisible.

Rate it in greyscale. Any image viewer can desaturate; `read_grid {view: "value"}` gives
you the tone ladder directly. If the shape still reads as a solid, dimensional object, the
`value` score should be 4 or 5. If it reads as a cut-out, it is 2 or 3.

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

**How it is measured.** All on the solid mask, all 8-neighbourhood, all integer:

```
isolated       solid pixels with n8 == 0
diagOnly       solid pixels with n4 == 0 and n8 >= 1
spurs          solid pixels with n8 == 1
outliers       solid pixels whose Chebyshev colorDistance to the MEDIAN colour of their
               solid 8-neighbours exceeds 32
nearDuplicatePairs
               pairs of distinct colours, each with >= 8 solid pixels, whose Chebyshev
               colorDistance is <= 8
ditherShare    (solid pixels that are dither cells, §below) / N
```

Two details matter more than they look.

**The median, not the mean.** `despeckle` pulls a pixel toward the *average* of its
neighbours, which is right for a tool that is editing. For a *detector* it is wrong: a
single outlier pixel surrounded by seven of its own colour barely moves the average, so a
mean-based test misses exactly the case that matters. The median of each channel over the
8-neighbourhood is unmoved by one bad sample. The `32` threshold is `despeckle`'s own
default, so the scorer and the fixer agree about what a colour outlier is.

**Dither cells are not noise.** In a 50% Bayer field, a quarter of the solid pixels have
zero orthogonal solid neighbours and one diagonal one. A naive isolated-pixel count would
scream at correct dithering — and then an agent would run `despeckle` and sand the texture
off, which the craft guide already warns is the classic way to ruin a piece. So:

```
ditherCell(p) = p is solid, all 4 of its orthogonal neighbours are transparent,
                and all 4 of its diagonal neighbours are solid
```

That is the exact signature of a 50% checkerboard, and it is only ever evaluated for a solid
pixel. The same lattice seen from a transparent cell — four solid orthogonal, four transparent
diagonal — is not a separate case and is not counted; counting it would put a `ditherShare`
denominator that is not the solid-pixel count.

`isolated`, `diagOnly` and `spurs` all **exclude** `ditherCell` pixels, and `ditherShare` is
reported in the verdict text so a human can see why the noise score is what it is. When
`ditherShare >= 10/100`, the dimension emits `dither-dominant` as an advisory — a piece that
is *mostly* 1px dither is its own problem per the 3–5px seam rule, but it is not noise, and
it does not cost a point here.

The honest gap: this test is exact for a checkerboard (50%) and useless below it. A `sparse`
or `dots` pattern is *designed* to be isolated pixels, and this scorer cannot tell that from
a mistake. §7 says so plainly, and the craft guide's answer — use `cluster2`/`cluster4` on
large canvases, keep 1px patterns for narrow seams — is the only fix.

**Scoring.** Four ratios, each banded, combined with fixed weights. Higher ratio is worse,
so the bands run the other way:

| ratio | `<= 2/1000` | `<= 8/1000` | `<= 20/1000` | `<= 50/1000` | `> 50/1000` |
| --- | --- | --- | --- | --- | --- |
| sub-score | 1000 | 900 | 750 | 500 | 200 |

| ratio | weight |
| --- | --- |
| `isolated / N` | 350 |
| `diagOnly / N` | 250 |
| `outliers / N` | 250 |
| `spurs / N` | 150 |

```
noiseScore = rhu( 350*isolatedQ + 250*diagQ + 250*outlierQ + 150*spurQ, 1000 )
             - 100 if nearDuplicatePairs >= 1
```

(`isolatedQ` and friends are the banded sub-scores in per-mille. The near-duplicate penalty
is a flat −100, not a band: two ramp entries three steps apart are a mistake whether there
are two of them or twenty, and they are a *decision* error rather than a frequency one. The
four noise issues likewise fire from the band each ratio lands in — `> 800/1000` is the
trigger for all four — rather than from an adjustment row, so a single ratio is counted once
and produces at most one issue.)

**Issue codes.**

| code | fires when | severity | blocking |
| --- | --- | --- | --- |
| `isolated-pixels` | `isolated / N > 8/1000` | 0.40 | no |
| `diagonal-seam` | `diagOnly / N > 8/1000` | 0.45 | no |
| `colour-outlier` | `outliers / N > 8/1000` | 0.35 | no |
| `single-pixel-spur` | `spurs / N > 8/1000` | 0.30 | no |
| `near-duplicate-colours` | `nearDuplicatePairs >= 1` | 0.35 | no |
| `dither-dominant` | `ditherShare >= 10/100` | 0.35 | no |

**Worked example** — the same 32×32 character, with a 4px dither seam and nine stray pixels:

```
ditherShare           25/612 = 0.0408        (a 4px seam at 25% level)  -> no advisory
isolated              9       9/612    = 0.0147   -> <= 0.020  -> 750
diagOnly              4       4/612    = 0.0065   -> <= 0.008  -> 900
outliers              11      11/612   = 0.0180   -> <= 0.020  -> 750
spurs                 6       6/612    = 0.0098   -> <= 0.020  -> 750
weighted              rhu(350*750 + 250*900 + 250*750 + 150*750, 1000)
                      = rhu(787_500, 1000) = 788
nearDuplicatePairs    1       (#8595a1 x14, #8a97a3 x9, colorDistance 5)  -> -100
score                 788 - 100 = 688  ->  0.688
```

Verdict: *"9 isolated px, 4 diagonal-only px, 11 colour outliers, 6 single-pixel spurs, 1
near-duplicate pair, dither 4% of the surface."* Every one of those is a specific pixel an
agent can fix with one `despeckle {mode: "both", rect}` and one `quantize_to_palette` — which
is exactly the loop the report is meant to drive.

**How a human rates this by eye** (1–5):

- **5** — clean at 1×. Zoom to 8× and anything you find is texture, not error.
- **4** — one or two specks you would have to hunt for.
- **3** — visible at 1× once you know to look; a few pixels of the wrong colour.
- **2** — the texture is busy; the surface reads as grain rather than as material.
- **1** — it sparkles. The eye goes to the errors instead of the shape.

The test that works: look at it at 1× for three seconds, then at 8× for three seconds. If
the two views disagree, you have noise. The 4× view is the worst place to judge this — it
makes every 2×2 dither block into a visible dot grid, which is why the craft guide says
never to judge a whole piece zoomed in.

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

**How it is measured.**

```
edge            solid pixels with >= 1 transparent 4-neighbour (P, from §3.3)
localMean(p)    mean Lq over the solid pixels in the 5x5 Chebyshev window, integer division
ink(p)          localMean(p) - Lq(p) >= 20
inkCount        ink pixels among the edge pixels
outlineShare    inkCount / P                                <- primary ratio
outlineCoverage inkCount / N
depth(p)        1 + max depth over 4-adjacent solid neighbours, multi-source BFS from
                every edge pixel over the solid mask; an edge pixel is depth 1
inkDepth        depth(p) for ink pixels
minInkDepth     min, maxInkDepth  max
quadrantDepth   max ink depth in each of the four quadrants of `bounds`
inkColours      distinct packed colours among ink pixels
inkGaps         edge pixels with no ink 4-neighbour
```

`localMean` includes `p` itself, so it is always defined, and it is a *local* mean rather
than a sprite-wide one so a light outline on a dark body is still detected. Depth comes from
a single multi-source BFS over the whole solid mask — that is the inscription depth, and it
is the same number for the body and the ink, which is what makes `maxInkDepth` a thickness
measurement rather than a distance-from-the-edge measurement.

There is one deliberate exception. If `outlineShare < 15/100`, the dimension does **not** run
the band table. It reports `score: 700`, emits `outline-missing` at severity 0.20, and says so
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
| `inkGaps / P >= 5/100` | −50 | `outline-gap` (0.25) |
| `outlineCoverage >= 45/100` | −200 | `outline-heavy` (0.70) |
| `outlineShare >= 60/100` and `outlineCoverage < 3/100` | −100 | `outline-gap` (0.35) |

**Issue codes.**

| code | fires when | severity | blocking |
| --- | --- | --- | --- |
| `outline-missing` | `outlineShare < 15/100` | 0.20 | no |
| `outline-gap` | `inkGaps / P >= 5/100`, or a sparse outline | 0.25 / 0.35 | no |
| `outline-inconsistent-weight` | quadrant depth spread `>= 2` | 0.45 | no |
| `outline-colour-split` | `>= 4` ink colours, none dominant | 0.25 | no |
| `outline-heavy` | `maxInkDepth >= 3` or `coverage >= 0.45` | 0.50 / 0.70 | **yes** at 0.70 |

`outline-gap` is an advisory on purpose. **Selective outlining is a good technique**, not a
defect — the craft guide recommends dropping the contour where the light hits, and this
scorer must not punish an artist for doing the recommended thing. A gap is reported so an
agent can see it, and costs 50 per-mille, not a blocking severity.

**Worked example** — the same sprite, outlined at 2px on top and 1px elsewhere:

```
edge pixels P         168
inkCount              139
outlineShare          139/168 = 0.8274       >= 0.80          -> base 950
outlineCoverage       139/612 = 0.2271       in range        -> no
quadrantDepth         TL 3, TR 3, BL 1, BR 1  spread 2        -> -150
maxInkDepth           3                                          -> -150
inkColours            2                                          -> no
inkGaps / P           11/168 = 0.0655          >= 0.05          ->  -50
adjustment            -350
score                 950 - 350 = 600  ->  0.60
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
key from `dimensions` entirely, and `excluded.motion` carries the reason:

| Reason | Condition |
| --- | --- |
| `single-frame` | The evaluated target resolves to one frame — a still sprite, or an `evaluate` call scoped to a single frame of an animation. |
| `no-motion-content` | The target sequence has `>= 2` frames but every composited frame is byte-identical. |

**It is never scored as 0.0, and that is the whole point.** A zero would mean "this animation
loops badly" for a static sprite, would drag every still asset's total down by 8 points for
the crime of not being an animation, and would teach every agent to ignore a dimension that
is genuinely useful. Absence is the signal, and absence is checkable: presence of the key in
`dimensions` is the normative test, `excluded` is a diagnostic explaining it.

The one thing exclusion costs is a real failure mode: an agent that intends to animate and
duplicates frame 0 four times gets `frames-identical`, an **advisory issue at severity
0.35** (not blocking), and no `motion` score. We do not score it, because we cannot tell a
deliberate hold — a two-frame breathing pause, a game timing trick, a placeholder — from an
agent that forgot to draw the other frames. Saying "0.0" would be a claim we cannot support;
saying "not applicable" plus a note is a claim we can.

`frames-identical` is emitted by the aggregator, not by `motion`, for the same reason
`empty-frame` is (§5.4): it is a property of the target, not of a dimension. Note the
deliberate difference in the two strings — the issue code is `frames-identical` and the
exclusion reason is `no-motion-content` — so a code and a reason can never be confused for
one another by a client that pattern-matches on prefixes.

**How it is measured.** The sequence comes from `animationSequence(sprite, tag)`, so a
pingpong tag is measured in playback order. `f_0 .. f_{n-1}` are the composited frames.

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

### 5.2 The formula

```
active      = every dimension key present in `dimensions`
denominator = sum of the active weights              // 1000 animated, 920 still
scoreQ      = Math.floor((Σ wᵢ * scoreQᵢ + denominator/2) / denominator)
score       = scoreQ / 1000
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
FLOOR_FAIL = { silhouette: 0.40, value: 0.40, palette: 0.40,
               noise: 0.30,     outline: 0.30, motion: 0.40 }   // per-dimension, in types.ts
FLOOR_WARN = 0.60                                                // every dimension

blocking = every issue, from every present dimension, with severity >= 0.50,
           sorted by severity descending then code ascending, deduplicated by (code, rect)

fail  if blocking.length > 0
      or any present dimension score < FLOOR_FAIL[that dimension]
      or total score        < 0.55
warn  if total score        < 0.80
      or any present dimension score < FLOOR_WARN
pass  otherwise
```

Precedence is `fail` > `warn` > `pass`, evaluated in that order, so a report is never
ambiguous. The per-dimension `FLOOR_FAIL` descends with the weight: the two dimensions that
are *style* (`outline`, and `noise` as a matter of taste — the craft guide's own warning
that a clean-up pass can sand a piece flat) are allowed to sit lower before they can fail a
report on their own. Two properties of this rule are deliberate and should survive a
well-meaning refactor:

**A dimension floor exists.** A total of 0.86 with `silhouette: 0.30` is a `fail`, not a
`warn`. Weighted means hide a broken dimension behind good ones, and a broken silhouette
means the asset does not work in the game no matter how well the palette is disciplined.

**Blocking issues are independent of the score.** `empty-frame` (severity 1.00) is emitted
by the aggregator when `N == 0`, every dimension reports 1000 because there is nothing to
fault, and the verdict is `fail`. That looks contradictory and is not: a blank canvas is
not bad artwork, it is *no* artwork, and a mean cannot express that. It is also the cleanest
demonstration of why the blocking list exists as a separate channel — an empty document
scoring 1.00 and failing is exactly the case a threshold alone gets wrong.

### 5.4 Aggregator-level issues

Two codes are emitted by the aggregator rather than by a dimension, because both describe the
*target* rather than any one dimension's opinion of it. They obey the same
`{code, message, rect, severity}` shape and the same `>= 0.5` blocking rule.

| code | fires when | severity | blocking |
| --- | --- | --- | --- |
| `empty-frame` | `N == 0` in the evaluated target — nothing opaque to measure | 1.00 | **yes** |
| `frames-identical` | `>= 2` frames in the sequence, all composites byte-identical (§4.6) | 0.35 | no |

`empty-frame` has `rect: null`. `frames-identical` has `rect: null` and, when the sequence
has more than one frame, the message names the frames involved — an agent that duplicated
frame 0 needs to know *which* tag it duplicated.

Neither code is a dimension score, and neither is renormalised into one. They are facts about
the input.

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

### 6.2 The protocol

**Corpus** (T-021 builds the tooling; the corpus is ~200 images). It must span the
difficulty range, not cluster at the easy end:

| Slice | Target | Why it is there |
| --- | --- | --- |
| Canvas size | 16², 32², 64², 128², 256², and non-square | Thresholds that only work at 32×32 are not thresholds. |
| Frames | 1, 2, 4, 8 | The `motion` exclusion contract and the seam ratios are all size-of-sequence sensitive. |
| Subject | characters, props, tiles, UI, scenes | To find where the scorer is confidently wrong (§6.5). |
| Provenance | programmatic generation, this repo's `artwork/`, and imports | A corpus of only generated art calibrates against its own failure modes. |
| Quality | deliberately spans good to bad, including near-misses | A corpus of only failures calibrates the detector, not the scale. |

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

### 6.3 Measurement

T-022 computes, per dimension and overall:

| Statistic | Target | What it tells you |
| --- | --- | --- |
| Pearson `r`, deterministic score vs. mean rater score (1–5 rescaled to 0..1) | **> 0.70** | Do the numbers move with human judgement at all. |
| Spearman ρ | > 0.70 | Do they at least *order* assets the way humans do. Ordering matters more than absolute value for a gate. |
| Rater inter-rater agreement (Krippendorff α or weighted Cohen κ) | > 0.60 | Is the human standard itself coherent. **Below 0.60, stop and fix the rubric, not the scorer** — you cannot calibrate against a noisy ruler. |
| Confusion vs. the 3-way overall judgement at the `pass` threshold | reported, not targeted | Whether the gate line is in the right place. |

`r > 0.70` is the acceptance bar quoted in TASKS.md T-025, and it is a *low* bar. It says
the scorer is a useful second opinion, not that it is right. Any claim stronger than that
would need a stronger number than 200 images can produce.

### 6.4 Rater protocol — the parts that are easy to get wrong

- **Raters must not see the machine score before rating.** This is the single most common way
  a study like this is ruined. Given the number first, raters anchor to it, agreement
  inflates, and `r` measures how well the rubric is explained rather than whether it is
  right. Score the machine side after the human side is submitted and locked.
- **Rate silhouette before colour.** `read_grid {view: "mask"}` first, on every image, before
  looking at anything in colour. Order effects are real and they run one way: having seen the
  colours, nobody un-sees them, and a `silhouette` score given second is really a score of
  "does the whole thing look good".
- **No discussion before both submissions are in.** Same reason.
- **Fixed viewing conditions.** 1× (100%) for fine judgement, with a second look at 4× for
  structure. Never judge a whole piece zoomed in — upscaling turns a correct `cluster2` block
  into a visible dot grid, and raters who judge at 4× will systematically over-report `noise`
  and `dither-dominant`. The craft guide says this to agents; raters need it more.
- **Rate the image, not the concept.** No credit for a clever idea, none for a subject the
  rater likes.

### 6.5 What to do when `r` falls short

In this order, and not in any other:

1. **Move a threshold that a specific rater note argues for.** One threshold, one commit, with
   the note quoted in the commit message. This is what the calibration data is *for*.
2. **Re-weight** (`QualityWeights`). Weights are the most interpretable knob in the system and
   the cheapest to defend: "silhouette 300 → 340, noise 120 → 80" is a sentence a human can
   agree with. Re-balancing means the total changes for every existing asset, so it is a minor
   version bump.
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
the number goes up.

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
| Anything is better than 0 | §4.4 | Artists who prefer visible grain. |

**3. It will be confidently wrong about soft lighting.** `palette` measures the *composite*,
by default. A translucent highlight layer composites two declared swatches into a colour that
is in no palette, so a sprite with a perfectly disciplined palette scores `off-palette` and
lands near 0.32 for it. This is a known false positive, not a subtle one, and it is the
single most likely reason for a good asset to fail the gate. The mitigations are all
upstream: `paletteLocked: true` with opaque layers, `quantize_to_palette` before evaluating,
or scope the evaluation to a `cel`. We chose not to loosen the threshold, because loosening it
would let real drift through — the cost of a false positive here is an artist or a `fix` pass,
and the cost of a miss is a muddy shipped asset.

**4. It cannot see intent, in either direction.** A deliberately asymmetric profile sprite is
penalised for nothing and credited for nothing. A deliberately held animation frame is
reported as `frames-identical` when it was the right call. There is no mechanism for "I meant
that", because there is no mechanism for knowing.

**5. `noise` is the dimension most likely to sand a piece flat, and it is the one the craft
guide warns about in the strongest terms.** The dither-cell exclusion (§4.4) handles a 50%
checkerboard exactly and does nothing for a `sparse` or `dots` pattern, which is *designed* to
be isolated pixels. At `dither-dominant` the scorer is at least honest that it is looking at a
large dithered field; below that it simply cannot tell texture from error. This is why the
recommended workflow is `despeckle` under a `rect`, with `minClusterSize: 2-4` where
pointillism is intended — the tool has a guard for this and the scorer does not.

**6. It measures the frames you name.** A sprite whose frame 0 is strong and frame 5 is
broken passes when evaluated on frame 0. For an animation, always evaluate a *tag*, not a
frame, and treat a per-frame pass as a statement about that frame only.

**7. It is not comparable across asset classes.** The weights are tuned for character sprites
and small props. An icon, a walk cycle, a tile and a 256×256 scene do not share a definition
of good, and one weight table cannot serve all four. Per-asset-class weight profiles are the
obvious fix and they are not built.

**8. It has no style, period, or era awareness.** It will happily mark a deliberately
chunky 16-bit look and a deliberately smooth modern one at the same score, because it only
measures relationships between pixels, never a target.

**9. Every threshold here is a judgement made before any data existed.** That is the state of
this document at the time of writing, and §6 is the process that is supposed to change it. If
you are reading this before the calibration results are in, treat the numbers as a proposal
under review, not as a settled standard — including, especially, the ones that look most
authoritative.

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
| `colour-outlier` | `noise` | 0.35 | no |
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

Codes with two severities fire at the higher one past their stated threshold; the threshold is
in the dimension's issue table in §4. Exclusion reasons (`single-frame`, `no-motion-content`)
are **not** issue codes and live in a separate typed field — nothing should branch on an
exclusion reason as if a defect had been found.
