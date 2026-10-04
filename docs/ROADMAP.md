# Roadmap

The judgement layer is the moat. An agent can draw, but it cannot tell whether what it drew is
right — and `get_preview` only lets a *person* see, it cannot be judged. Everything below is either
that layer getting more truthful or the asset pipeline around it getting easier to ship.

This file replaced a working ledger that had grown into a second source of truth. It is deliberately
short: it says what is left, not what was tried. **What was tried and failed lives in the code
comments and in `docs/EVALUATION.md` §7**, because a refuted approach is evidence and deleting it
loses the reason the current one was chosen.

## Locked product decisions

Not open for renegotiation without the owner's say-so.

| | |
| --- | --- |
| **Scope** | Push every item that can be done autonomously, with no phase boundaries. State carries across sessions. |
| **Branch** | `master`. The single-integration-branch plan was abandoned; a release has already shipped from this branch and reverting would not unship it. |
| **Language** | English primary, Chinese mirror. `README.md` / `docs/*.md` English; `README-ZH.md` and `docs/*-ZH.md` mirror. |
| **Dependencies** | `packages/core` stays at exactly four runtime deps: `fast-png`, `fflate`, `gifenc`, `zod`. Everything else is written here. |
| **Position** | **Not an image generator — a game-asset pipeline.** Pixel art is a constrained, quantized, grid-exact asset with a technical contract. Every feature is ranked against that. |
| **Not doing** | No further drawing commands (there are ~94; the bottleneck is judgement, not capability). Not a Figma replacement. Not a web-editor rewrite. Not 20 export formats. |

The architecture decisions that keep sub-agents from reinventing each other — one home per measured
quantity, integer per-mille ratios, the `unmeasured` contract, the four quality-analyzer interface
constraints — are in `AGENTS.md`, which is where a change to them belongs.

## Where the judgement layer stands

**All 6 of 6 dimensions are written and registered**: `silhouette`, `value`, `palette`, `noise`,
`outline`, `motion`. `not-implemented` is unreachable from this pipeline — every absence a report can
carry names a reason about the **document** (`no-subject`, `no-outline`, `single-frame`,
`no-motion-content`) rather than about the build.

All six are reachable: the `evaluate` command, the `evaluate` MCP tool, and the
`pixel://quality/{doc}` resource. `finalize_document` refuses an asset that fails the gate, and a
bypass is possible but leaves a notice in the result. `fix` turns issues into ops where a safe repair
exists and says so in prose where one does not.

**It is calibrated against nothing.** Every threshold in `docs/EVALUATION.md` §4 is a hypothesis under
review; §6.2 has run exactly once, on one sprite, and found four defects. That is a sample size of one.
The fix is 200 human ratings, and no amount of engineering substitutes for it — see the human-tasks
section below.

### Next in the layer

- **`motion` is registered** (weight 80; 190 under the `animation` class). All seven of its codes now
  have a corpus case, and — the part that mattered — there is a **clean multi-frame negative control**,
  `motion/clean-walk-40x32`: 96 of its own 240 pixels change on every transition, seam included, at a
  seam ratio of exactly 1.0. It is silent because the loop is well made, not because nothing moved.
  That matters more than the defect cases: §4.6's severity scale is the only one that cannot be
  checked from a contact sheet, so this is the only place a clean loop can be proven quiet.

- **`outline` is registered and carries one known limitation, deliberately shipped.** Its predicate is
  topological (`encloses`: a contour wraps the subject, a cast shadow occupies one side), which
  repairs the two defects an earlier local-contrast test had, and `outline-missing` became a real
  `ExcludedReason` (`no-outline`) rather than an issue code — so §4.5's claim that "no outline is
  neutral, not bad" is finally true. It reads min 350 / median 650 / max 1000 on the corpus.

  **The limitation:** four negative controls carry an outline advisory the dimension reports on them.
  Two are two-tone subjects with no drawn contour (`inkColours` is 1 on both), where `ink` reads the
  dark half's outer edge as a contour and the verdict falls to `warn`. No threshold separates them
  from `control/outline-ring-32`, a real closed 1px contour: 1000 against 327 and 416, the same side of
  every band edge. Every code involved is under §5.3's 0.50 blocking line, so **nothing is refused** —
  the cost is two warnings a reviewer learns to ignore, which is a weaker harm than a fifth dimension
  that does not exist. The owner's call, and the fix if anyone wants it is a **synthetic contrast
  pair** (one two-tone subject drawn with and without a third contour tone), not a gate.

- **The duplication question this entry used to carry is answered: `outline` does not duplicate
  `value`.** `curvedQ` lives in `value.ts` alone and §4.5 measures no curvature at all, so the old
  "818 in both" reading was never possible — outline did not exist in the baseline when it was
  written. A lesson worth keeping: that note was on this page for weeks and was checkable in one
  grep the whole time.
- **Per-asset-class weight profiles.** §7 item 8. **Shipped** — `QUALITY_WEIGHT_PROFILES` in
  `packages/core/src/quality/types.ts` carries three classes (`sprite`, `animation`, `scene`),
  derived from whether the evaluated sequence has measurable motion and from canvas area,
  overridable per call (`assetClass` on `evaluate`, `verify`, `qualityGateForSprite`), and recorded
  on every report as `{cls, source}` so a number that moved says why. With nothing specified the
  result is `sprite`, which **is** §5.1's table, so every baseline generated under it is unchanged.
  **What is left is calibration, not mechanism:** `sprite` is the only column §6.2 has touched
  (once, on one sprite) and `animation` and `scene` are chosen numbers with zero human ratings
  behind them. `docs/EVALUATION.md` §5.2 states what evidence would replace them.
  **Measured load-bearing, so it is not decorative:** one fixed set of six readings totals 0.777 /
  0.769 / 0.719 under the three classes, and on real corpus artwork `motion/worst-frame-wins-16`
  moves 411 → 448, `motion/blank-frame-16` 762 → 794, `app/icon.png` 799 → 716.
- **Does an abstention get netted?** Open, and it is an aggregator question rather than a dimension
  question. Registering `noise` moved `lantern-keeper` 30‰ *away* from its one real advisory; registering
  `palette` moved it 25‰ *toward*. A clean reading on one dimension currently offsets a real advisory on
  another, and the floors do not catch it. `docs/EVALUATION.md` §7 has the numbers.

## Phase 1 — adoption, mostly independent of the layer

| | |
| --- | --- |
| **Recipes** | The format and five recipes ship — `platformer`, `topdown-rpg`, `dungeon-tileset`, `ui-icons`, `item-icons` — along with the `describe_recipe` tool, `pixel://recipes` and `pixel://recipe/{id}`. Still to write: recipes for the classes the asset contract actually needs next (8-direction character sets, hero props, effect frames), and nothing in the format has to change to add them. |
| **8-direction characters** | Angle definitions and orientation anchors; a walk-cycle generator; direction-aware preview; atlas export with per-frame metadata. The strongest star magnet in the plan and the least built. |
| **Asset contract** | `meta.json`, the generator, the validator, all four importers (Godot, Unity, Phaser, Excalidraw) and the naming-convention validator ship — see `docs/IMPORTERS.md`. Still to write: exposing the importers through `finalize_document` and the MCP tool surface, which is blocked on whether `meta.json` is written next to every export or is one more output the caller opts into; and importers for the contract classes `kind` does not model yet (tilesets, tilemaps). |
| **SVG trace import** | Raster outline to cel. `.aseprite` native read is possible but needs reverse-engineering verification. |
| **Stable programmatic API** | The npm package is a devDependency away from being pleasant. |
| **Cookbook, GitHub Action, team palettes** | **Cookbook and Action shipped.** `cookbook/` is five runnable examples — first sprite, 8-direction walk cycle, SVG trace, engine export, one recipe end to end — and `packages/core/test/cookbook.test.ts` compiles, runs and byte-compares every one of them, so a snippet cannot rot. `dotloom-mcp/build-assets` runs a project's build in CI and fails it on a refused document, printing named defects and never a score. **Team palettes: not started.** |

## Phase 2 — spread

**The build-time gallery is shipped.** `scripts/build-gallery.mjs` walks every committed
`.pixel` under `artwork/` and every `showcase/<piece>/`, opens each one through the advertised
MCP tool surface, renders it with `export_png`, asks `evaluate` what it can say about it, and
writes `showcase/gallery/` — one self-contained `index.html`, a `gallery.json`, and a PNG per
piece. No framework, no CDN, no client-side JavaScript; it opens from `file://` with no
network. `pnpm verify:gallery` and `.github/workflows/gallery.yml` build it in CI, and
`packages/core/test/gallery.test.ts` gates it.

Two decisions in it are the point, and both are the repository's argument made visible:

- **Images are rendered from the `.pixel` sources, never from the checked-in `.png` files.**
  A gallery whose pictures can drift from the artwork they claim to show is worse than no
  gallery, and the engine is right there.
- **Every piece carries its named defects and nothing else — no score, grade or percentage**
  in the JSON or the page, enforced by the same recursive key-walk `packages/cli/test/
  contract.test.ts` and `packages/app/src/asset-bundle.test.tsx` use. Each defect is a code, the
  dimension that found it, the region and what to do about it. **An excluded dimension is
  rendered as *not measured*, with its `ExcludedReason` spelled out, and never as a pass:**
  an absent measurement and a good result both arrive as a missing number, and only one of
  them is a compliment. That is the whole reason `ExcludedReason` exists, and the ten
  full-bleed scenes are the evidence that it is needed.

Still to do in this phase: PNG metadata and a `made with` badge, share templates, a 1.0
stabilisation pass, and the long-form writing about the lazy tool surface and the single bus.
Gallery *hosting* is still under "Needs a human" below — it needs an account. The build job
uploads the page as an artifact and stops there.

## Needs a human, and no amount of code substitutes

- **200 expert ratings of the benchmark set.** Calibration needs human judgement as the yardstick, and
  the yardstick cannot be generated by an algorithm — calibrating an algorithm on algorithm labels is
  circular. Target Pearson r > 0.7. The corpus, the generator and the format all exist; only the
  ratings are missing. `docs/EVALUATION.md` §6.1.
- **MCP registry listing** — needs a developer account and ToS acceptance. Its automated prerequisites
  are done: verified client configuration and a working server description.
- **Code signing** — the pipeline already honours `CSC_LINK` / `APPLE_ID`; it needs a certificate.
- **Gallery hosting, artist collaborations, a demo recording** — accounts, relationships, and a person
  at a desktop.

## Known gaps in this repository

Small, and listed so nobody rediscovers them:

- **Closed.** `docs/ASSET-CONTRACT-ZH.md`, `docs/EVALUATION-ZH.md` (§4.4 and §7 only — the
  header says so, and the remaining sections are still unmirrored), and the missing
  `CHANGELOG.md` entries in `CHANGELOG-ZH.md` now exist, and so do `docs/ACTION-ZH.md` and
  `docs/COOKBOOK-ZH.md`. D-3 asks for a mirror per English doc;
  `docs/EVALUATION.md` §1–§3, §4.1–§4.3, §4.5, §4.6, §5, §6, §8 and appendix A are still English-only.
- `scripts/mcp-call.mjs` and the docs carry tool counts as prose, and they drift. **Measure with
  `node scripts/mcp-call.mjs list` rather than copying a number out of a document** — including out of
  this one.
- ~~`quality.ts` re-derives §5.2's weighted total because `weightedTotalQ` is private.~~ **Closed.**
  The duplication was drift wearing a constraint as a disguise: the comment claiming it was "forced"
  named a file whitelist as if it were architecture, and the file already imported from
  `quality/index.ts` on the line above. The two implementations were compared token for token and
  are identical, so `weightedTotalQ` is now exported from its one home and a test asserts that
  exactly one definition exists in `packages/core/src`.
- `applyCommandWithSummary` re-codes a `CommandError` raised inside `apply` to `command_failed`, while
  `applyCommandToDraft` preserves it. A command therefore cannot return `invalid_params` for a
  cross-field argument violation raised in `apply` — it tells an agent the *document* refused when its
  arguments were incomplete.