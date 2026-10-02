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

**4 of 6 dimensions are registered**: `silhouette`, `value`, `palette`, `noise`. `outline` and
`motion` are specified and unwritten.

All four are reachable: the `evaluate` command, the `evaluate` MCP tool, and the
`pixel://quality/{doc}` resource. `finalize_document` refuses an asset that fails the gate, and a
bypass is possible but leaves a notice in the result. `fix` turns issues into ops where a safe repair
exists and says so in prose where one does not.

**It is calibrated against nothing.** Every threshold in `docs/EVALUATION.md` §4 is a hypothesis under
review; §6.2 has run exactly once, on one sprite, and found four defects. That is a sample size of one.
The fix is 200 human ratings, and no amount of engineering substitutes for it — see the human-tasks
section below.

### Next in the layer

- **`outline`** — 5th dimension, weight 100. `no-subject` applicability already exists. Check first whether
  it duplicates `value`: they read the same planes, and `app/icon.png` reads `curvedQ max` 818 in both.
- **`motion`** — last dimension, weight 80. `single-frame` applicability already exists. It is the only
  dimension that can be calibrated cheaply, because frame-difference defects are objective.
- **Per-asset-class weight profiles.** §7 item 8: an icon, a walk cycle, a tile and a 256² scene do not
  share a definition of good, and one weight table cannot serve all four. This is probably worth more
  than a fifth dimension.
- **Does an abstention get netted?** Open, and it is an aggregator question rather than a dimension
  question. Registering `noise` moved `lantern-keeper` 30‰ *away* from its one real advisory; registering
  `palette` moved it 25‰ *toward*. A clean reading on one dimension currently offsets a real advisory on
  another, and the floors do not catch it. `docs/EVALUATION.md` §7 has the numbers.

## Phase 1 — adoption, mostly independent of the layer

| | |
| --- | --- |
| **Recipes** | Format and the `platformer` recipe ship. Still to write: `topdown-rpg`, `dungeon-tileset`, `ui-icons`, `item-icons`, and a `describe_recipe` MCP tool with a `pixel://recipe/{id}` resource. |
| **8-direction characters** | Angle definitions and orientation anchors; a walk-cycle generator; direction-aware preview; atlas export with per-frame metadata. The strongest star magnet in the plan and the least built. |
| **Asset contract** | `meta.json` and the generator ship. Still to write: Godot, Unity, Phaser and Excalidraw importers, and a naming-convention validator — all of which consume that one contract. |
| **SVG trace import** | Raster outline to cel. `.aseprite` native read is possible but needs reverse-engineering verification. |
| **Stable programmatic API** | The npm package is a devDependency away from being pleasant. |
| **Cookbook, GitHub Action, team palettes** | Not started. |

## Phase 2 — spread

Not started. PNG metadata and a `made with` badge, a build-time gallery, share templates, a 1.0
stabilisation pass, and the long-form writing about the lazy tool surface and the single bus.

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

- `docs/ASSET-CONTRACT-ZH.md` and the Chinese mirrors for `docs/EVALUATION.md` §4.4 / §7 and
  `CHANGELOG.md`'s recent entries. D-3 requires them; the English landed first because the judgement
  layer was the urgent one.
- `scripts/mcp-call.mjs` and the docs carry tool counts as prose, and they drift. **Measure with
  `node scripts/mcp-call.mjs list` rather than copying a number out of a document** — including out of
  this one.
- `quality.ts` re-derives §5.2's weighted total because `weightedTotalQ` is private to
  `quality/index.ts`. The clean fix is to export it and delete the copy.
- `applyCommandWithSummary` re-codes a `CommandError` raised inside `apply` to `command_failed`, while
  `applyCommandToDraft` preserves it. A command therefore cannot return `invalid_params` for a
  cross-field argument violation raised in `apply` — it tells an agent the *document* refused when its
  arguments were incomplete.