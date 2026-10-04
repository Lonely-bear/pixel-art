# `dev/`

Documents for people working **on** this repository. They are not shipped in the npm
tarball and not part of what a product user is handed — see [`docs/README.md`](../docs/README.md)
for that.

| File | What it is |
| --- | --- |
| [`DECISIONS.md`](DECISIONS.md) | The locked product decisions (D-1..D-6), kept out of `docs/` so the table is not deleted with the working roadmap it lived in. |

The other developer-facing discipline is not in this directory because a build reads it
from a fixed path:

- [`../AGENTS.md`](../AGENTS.md) — layout, the build-serialisation rule, the acceptance
  procedure, and the file-format traps.
- [`EVALUATION.md`](EVALUATION.md) — the scoring specification. It stays in
  `docs/` for a mechanical reason worth knowing:
  `packages/core/test/quality-weights.test.ts` resolves `../../EVALUATION.md` and
  **fails the build** if it cannot read it, so the specification and the code are pinned to
  each other by path. Moving it is a one-line change in that test, not a file move.
