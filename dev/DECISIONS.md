# Locked decisions

> **Status:** normative. Not open for renegotiation without the owner's say-so.
>
> This file was `docs/ROADMAP.md`'s "Locked product decisions" table. The roadmap it came
> from is deleted, because a roadmap is a working document and this table is a source of
> truth; a source of truth does not belong in the directory a product user is handed.
> `AGENTS.md` remains the other half — the architecture rulings that keep sub-agents from
> reinventing each other (one home per measured quantity, integer per-mille ratios, the
> `unmeasured` contract, the four quality-analyzer interface constraints).

| | |
| --- | --- |
| **D-1 Scope** | Push every item that can be done autonomously, with no phase boundaries. State carries across sessions. |
| **D-2 Branch** | `master`. The single-integration-branch plan was abandoned; a release has already shipped from this branch and reverting would not unship it. |
| **D-3 Language** | English primary, Chinese mirror. `README.md` / `docs/*.md` English; `README-ZH.md` and `docs/*-ZH.md` mirror. A mirror gap is recorded in `docs/EVALUATION.md` §1 and worth a lane; `docs/STABILITY.md` has none. |
| **D-4 Dependencies** | `packages/core` stays at exactly four runtime deps: `fast-png`, `fflate`, `gifenc`, `zod`. Everything else is written here. |
| **D-5 Position** | **Not an image generator — a game-asset pipeline.** Pixel art is a constrained, quantized, grid-exact asset with a technical contract. Every feature is ranked against that. |
| **D-6 Not doing** | No further drawing commands (the catalogue is past the point where a model can choose well between options; the bottleneck is judgement, not capability). Not a Figma replacement. Not a web-editor rewrite. Not 20 export formats. |

## What is not a decision

What was tried and failed is evidence, and it lives in the code comments and in
`docs/EVALUATION.md` §7 — deleting it loses the reason the current approach was chosen.
What is left to build is tracked as issues, not here.
