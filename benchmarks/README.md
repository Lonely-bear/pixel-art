# The calibration corpus

T-021. A corpus of pixel-art assets with **known ground truth**, built so that the quality scorer
can be calibrated against a distribution rather than against the one real character sprite in this
repository.

## Why it exists

Two tasks in a row declined to move a gate, and said the same thing: the scorer cannot be
calibrated because there is almost nothing to calibrate it against. Measured by T-012 and T-018
against every real asset in this repository:

- **12 real assets.** 10 are full-bleed scenes (`N` within a hair of `W x H`) where `silhouette` is
  excluded as `no-subject`; 1 is a 32x32 character sprite; 1 is the 1024x1024 app icon.
- The one real character sprite is **penalised**: `compactnessQ` 269 against a gate of 300, a ten
  percent miss on the only human-relevant data point that exists.
- The dimension scores an identical **800** for artwork the maintainer rejected twice and artwork
  that was accepted, because `N` is 65536 in both.

A threshold fitted to one sample is fitting noise, so nobody moved one. This directory is the
missing sample.

## Why it is a spec and not a folder of PNGs

The engine is byte-reproducible (T-071) and `.pixel` serialisation is byte-reproducible (T-091), so
every case is **materialised deterministically at test time** from a declarative description, and
the description is what lives in the repository. Fifty-odd committed PNGs would be a binary diff on
every change to the engine, reviewable by nobody, and a threshold edit would look like a picture
edit.

## The three tiers

`docs/EVALUATION.md` §6.1 is explicit: **algorithmic data cannot calibrate an algorithm.** Label the
corpus with `evaluate` and the correlation between `evaluate` and its own labels measures
self-consistency, not validity; fit the thresholds to those labels and the correlation climbs
toward 1.0 while the scorer gets no better. So the corpus is three tiers, and each answers a
different question:

| tier | what it is | what it answers | asserted? |
| --- | --- | --- | --- |
| `synthetic` | a generated subject with a **declared** defect | does the analyzer detect the defect it was designed to detect, and stay quiet when the defect is absent | yes, exactly |
| `real` | this repository's committed artwork | does the analyzer stay quiet on good work it was **not** designed around | applicability and quietness only, never taste |
| `human` | an image awaiting an expert rating | the aesthetic axis, which nothing else can reach | **no** - the field does not exist |

The boundary is structural, not a comment:

- A `synthetic` case **must** carry `expect`, and every defect it declares **must** appear in the
  codes it expects. A case cannot declare a defect and then not be expected to report it.
- A `clean-control` must name what must **not** fire. An analyzer that fires on clean work is worse
  than one that misses a defect, and that is only checkable if clean work is in the corpus.
- A `real` case **may not** declare `expect.codes` or `expect.verdict`. Asserting an expected code
  list about unrated artwork is asserting taste, and this repository has one human-rated asset.
  `measure` is allowed and means "the analyzer still says what it said" - a drift guard, not a
  correctness claim.
- A `human` case has **no `expect` field on its type at all**, the loader rejects the key, and the
  runner's result for it is `{ status: 'awaiting-rating' }` - a member with no `ok` field to be
  false. There is no code path in which a human-tier case is compared against an expectation,
  because there is nothing to compare it to yet.

## Layout

```
benchmarks/
  README.md              this file
  corpus/
    cases.json           the spec: every case, its recipe, its defects, its expectations
    scores.json          the human-rating slot. Empty on arrival; T-026 fills it.
    format.ts            the case/expectation types, the strict loader, the §3.3 declaration record
    recipes.ts           recipe ops -> bus commands
    build.ts             deterministic materialisation, seeded ids
    report.ts            the runner, the distributions, the markdown renderer
    baseline.md          the GENERATED report, compared byte for byte by the test
```

The guard is `packages/core/test/quality-corpus.test.ts`. It runs the corpus, compares every
declared expectation, and compares the rendered report against `baseline.md` byte for byte, so a
score that moves is a diff a reviewer reads rather than a log line scrolled past.

Regenerate the baseline after an intentional change:

```bash
UPDATE_CORPUS=1 pnpm --filter @pixel/core exec vitest run test/quality-corpus.test.ts
```

## Writing a case

A case is five things: an `id`, a `label`, a `recipe`, its `defects`, and its `expect`.

```json
{
  "id": "defect/detached-pieces-22",
  "label": "A 12x12 body with a 3x3 speck floating four pixels away from it",
  "tier": "synthetic",
  "provenance": "generated",
  "defects": [{ "kind": "detached-pieces", "note": "why this shape, in one sentence" }],
  "recipe": {
    "canvas": { "w": 22, "h": 18 },
    "layers": ["Base"],
    "palette": ["#3a2f2a"],
    "ops": [
      { "op": "rect", "layer": "Base", "rect": [3, 3, 12, 12], "color": "pal:0", "fill": true },
      { "op": "rect", "layer": "Base", "rect": [17, 6, 3, 3], "color": "pal:0", "fill": true }
    ]
  },
  "expect": {
    "codes": ["detached-pieces"],
    "absent": ["interior-hole", "thin-profile", "shape-clipped", "subject-undersized", "fragmented-silhouette"],
    "preconditions": { "silhouette": null },
    "connectivity": { "four": 2, "eight": 2 },
    "measure": { "N": [153], "shareQ": [941], "perimeter": [60], "compactnessQ": [534], "scoreQ": [825] }
  }
}
```

**Every expectation is derived by hand from `docs/EVALUATION.md` and the declared geometry**, never
copied out of the pipeline's own output. `N` from a rectangle's area, `perimeter` from
`2(w + h)`, `compactnessQ` from `min(1000, rhu(4 * 355 * 1000 * N, 113 * P * P))`, `scoreQ` from
the band table and the adjustment list. Copying the implementation's output into the spec is the
circular evaluation §6.1 is about, and it makes the corpus guard nothing.

Where a value cannot be derived - the number of 4-connected components in a rasterised outline, say
- it is **recorded** in the report and **not** asserted, and the report says which columns are
ground truth and which are a transcript.

The recipe vocabulary is one op per bus command, on purpose: `rect`, `ellipse`, `polygon`,
`polyline`, `line`, `rows`, `pixels`, `erase`, `outline`, `clear`, `duplicateFrame`, `translate`,
`tag`, `quantize`. `rows` exists because a silhouette *is* a row table - `demo.ts` derives its whole
tonal stack from one `[left, right, y]` list - so a case that draws its subject as filled rows is
reviewable the same way. There is deliberately no generic `{command, params}` escape hatch: that is
what would let a corpus drift into using a command the drawing guide would not.

Colours are `"pal:0"`, `"pal:1"`, ... in the order the case lists them, or a hex string. `set_palette`
*replaces* the palette, so a case is self-contained.

## Determinism

Ids come from `deterministicIdFactory` seeded from an FNV-1a hash of the case id. The default
factory is clock- and entropy-based on purpose, so a corpus built with it would produce a different
document on every run - and since `serializeSprite` writes layer ids into cel filenames, a different
`.pixel` on every run. The factory is process-global and is removed after every case, including
when a recipe throws, because leaving a deterministic factory installed would silently change the id
behaviour of every document built afterwards.

`real` cases are read from the committed asset rather than rebuilt: the point of that tier is that
it is *real*, and a regenerated approximation would be neither real nor reproducible. Every asset
the corpus names is tracked in git, which is checked rather than assumed.

## What T-026 does with `scores.json`

Fill it in. The schema is machine-checked and documented by `CorpusScores` in `format.ts`:

```json
{
  "schema": "dotloom-corpus-scores/v1",
  "corpusVersion": 1,
  "ratings": {
    "human/item-16": {
      "raters": [
        { "rater": "…", "perDimension": { "silhouette": 4, "value": 3, "palette": 5, "noise": 4, "outline": 3, "motion": 1 }, "overall": "usable" },
        { "rater": "…", "perDimension": { "silhouette": 4, "value": 3, "palette": 5, "noise": 3, "outline": 3, "motion": 1 }, "overall": "usable", "note": "the 1px flask neck is deliberate" }
      ],
      "consensus": { "perDimension": { "silhouette": 4, "value": 3, "palette": 5, "noise": 4, "outline": 3, "motion": 1 }, "overall": "usable" }
    }
  }
}
```

The loader refuses a file that could not support T-022: fewer than two raters cannot claim a
consensus, a score outside §4's 1..5 scale is refused rather than becoming an outlier, and a
`corpusVersion` that does not match the corpus is refused rather than carried forward stale.

**The analyzer's own scores are deliberately withheld from the report's human-tier section.** T-025
correlates the machine against the human, and a rater who has seen the machine's number is anchored
to it - which would make the correlation a measurement of anchoring.

`human/scene-64` is the case worth rating first: it is full-bleed, so `evaluate` reports `silhouette`
as excluded and delivers no silhouette number at all, and a human is asked to score silhouette on it
anyway. When the ratings land, that case answers "is the pipeline right to refuse, or is the human
wrong to have an opinion" - which no synthetic case can ask.

## What the corpus does NOT do

**It moves no gate.** `SPEC_GATES` in `format.ts` is a *transcription* of §4.1's thresholds, and a
transcription is checkable where an import would not be. The gate is where §4.1 puts it, and
`baseline.md` prints what every candidate gate would do in both directions so the decision has
numbers in it. §6.2's standing rule is that a new threshold is a hypothesis until it has been run
against a designed contrast, and a threshold is a product decision rather than a cleanup. T-022 and
T-026 own it.

**It is not exhaustive, and it does not pretend to be.** Coverage is aimed at the failure modes that
have already been found - negative controls, the 1px-margin trap, the 4-vs-8 connectivity decision,
the `compactnessQ` gate, the multi-frame rules - because a corpus of only failures calibrates the
detector and not the scale, and a corpus that only samples the easy end calibrates against its own
failure modes. §6.2's contrast pairs for `value`, `noise`, `outline` and `motion` are absent because
those analyzers do not exist; the slot is the `pair` field, and adding one is a data change.

**`benchmarks/` typechecking is manual, and that is a known gap.** `benchmarks/tsconfig.json`
exists and the harness typechecks cleanly under it, but no CI step runs it - the same gap T-093
records for `scripts/npm-index.ts`. It was added because running the check once immediately found a
type error in `report.ts` that vitest had transpiled straight past, which is the failure a harness
nobody checks accumulates. Wiring it into the root `typecheck` script is T-093's work, not this
task's. Run it by hand with:

```bash
node node_modules/typescript/lib/tsc.js -p benchmarks/tsconfig.json
```
