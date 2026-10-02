# TASKS.md — superseded

**This file is retired. Delete it. Nothing is lost: everything durable has moved.**

| what it held | where it lives now |
| --- | --- |
| Locked product decisions D-1..D-6 | `docs/ROADMAP.md` — "Locked product decisions" |
| Architecture decisions AD-1..AD-4, the frozen `unmeasured` contract | `AGENTS.md` and `packages/core/src/quality/types.ts`, which was always the authority |
| Rulings that bound every change (integer per-mille, one home per quantity, measurement drives spec, don't sand a piece flat) | `docs/EVALUATION.md` and `AGENTS.md` |
| The working discipline — proving a measurement can fire, the build serialisation, the acceptance procedure, the file-format traps | `AGENTS.md`, in three new sections |
| What's left to build | `docs/ROADMAP.md` |
| What is known to be wrong with the scorer | `docs/EVALUATION.md` §7, and the code comments |
| Every measurement, past and present | `benchmarks/corpus/baseline.md`, regenerated per run and diffed per row |

## The one thing worth carrying across

**Five measurements shipped in this repository that could not fail** — a counter capped at 1, a band
table read in the wrong direction, a neighbour count that included the pixel itself, a threshold in
hundredths where the pipeline is per-mille, and a ratio scaled by 1000 twice. Two of them were written
by the session that then reported the work as finished, and one of those had a previous handoff
explicitly recording it as fixed when it was not.

Every one of them was invisible to a passing test suite, and two of them made clean controls look
clean *because the instrument was blind*. The rules that would have caught all five are now in
`AGENTS.md` under "Proving a measurement works".

A second thing: the ledger grew large enough to be worth deleting, which is the correct outcome for a
working document and the wrong outcome for a source of truth. The durable parts belong next to the
code they constrain, not in a file that describes the code.