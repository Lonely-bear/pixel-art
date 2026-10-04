# The GitHub Action

<p align="center">
  <a href="ACTION.md">English</a> · <a href="ACTION-ZH.md">中文</a>
</p>

`dotloom-mcp/build-assets` runs a project's asset build in CI and fails the job when the
assets are wrong. It is the CI half of the story in [`API.md`](API.md): a game project takes
this package as a `devDependency`, generates its sprites at build time, and this Action is
how that generation happens on a pull request instead of on someone's laptop.

```yaml
- uses: dotloom-mcp/build-assets@v1.0.0
  with:
    command: node tools/build-assets.mjs
    check-command: node tools/check-assets.mjs
    quality-gate: blocking
```

That is the whole thing. `tools/build-assets.mjs` is the script from
[`API.md` §A complete, runnable example](API.md#a-complete-runnable-example) with the paths
changed, and `tools/check-assets.mjs` is the determinism check from
[§The determinism contract](API.md#the-determinism-contract).

---

## Why a composite action

**It runs on the runner's own Node rather than in a container image, because the package has
four runtime dependencies and no native builds, and because a game project's build script is
*their* code — a Docker action would have to be handed their whole `node_modules` to run it.**
A Docker action would also pin an OS and a libc that the project's own toolchain then has to
agree with, which buys nothing here; `actions/setup-node` with an explicit `node-version` is
both faster and reproducible, which is the property that matters for a build whose output is
committed.

---

## Inputs

| Input | Default | What it does |
| --- | --- | --- |
| `command` | *(required)* | The build command, as a shell command line. Anything the project already runs locally belongs here. |
| `check-command` | `''` | An optional command run after the build; a non-zero exit fails the job. This is where a byte-reproducibility check belongs. Empty means skip. |
| `install-command` | `npm ci` | The dependency install, run before the build in `working-directory`. Set it to `''` to skip installing. |
| `node-version` | `'22.13'` | Node.js version for the runner. The default is the package's floor rather than `latest`, so two runs of one commit render the same bytes. |
| `working-directory` | `'.'` | Directory every other path resolves against, and the directory the commands run in. |
| `quality-gate` | `'off'` | `off` runs only the commands. `blocking` additionally measures every `.pixel` document under `asset-dir` and fails the job when the delivery gate refuses one. |
| `gate-threshold` | `fail` | Which gate threshold `quality-gate: blocking` uses: `fail` refuses named defects and dimensions below their floor; `warn` also refuses a low weighted total. |
| `asset-dir` | `assets/generated` | Where the gate looks for `.pixel` documents, relative to `working-directory`. |

A worked example of every input, including the ones a first run usually gets wrong, is in
[`example-assets.yml`](../.github/workflows/example-assets.yml). The Action's own definition is
[`action.yml`](../.github/actions/build-assets/action.yml), and
`packages/core/test/github-action.test.ts` fails if an input is added there without being
documented here.

---

## What "fails the build" means here

Three separate things, and the third is opt-in.

**1. The build command exits non-zero.** Unconditional, and it is the floor. A mistyped
parameter in an op, a canvas size of zero, an unknown command name: every one of those is a
`CommandError` from the shared bus, and it stops the job.

**2. The check command exits non-zero.** Also unconditional, when you set one. The check worth
having is the determinism one — rebuild the same spec and compare bytes with what is committed:

```js
// tools/check-assets.mjs
import { readFile } from 'node:fs/promises';
import { buildSprite, exportAssets } from 'dotloom-mcp';
import { SLIME } from './slime-spec.mjs';

const [rebuilt] = exportAssets(buildSprite(SLIME), { source: true });
const committed = await readFile('assets/generated/slime.pixel');
if (!Buffer.from(rebuilt.bytes).equals(committed)) {
  console.error('slime.pixel changed — review the diff before committing it');
  process.exit(1);
}
```

Keep the spec in its own module and this is the check that makes "same input, same bytes" a
gate rather than a promise. A working version is
[`examples/check-assets.mjs`](../.github/actions/build-assets/examples/check-assets.mjs).

**3. The quality gate refuses a document.** `quality-gate: blocking`, and **off by default**,
because §6.2 of the evaluation spec has run exactly once, on one sprite — a gate nobody has
calibrated is a gate that blocks good work. Turn it on when you want a defect to stop a merge.

The gate calls `core.qualityGateForSprite`, the same function `finalize_document` calls before
it writes anything, so CI and the delivery path cannot disagree about what "failing" means. At
the default `fail` threshold it refuses on **named defects**: an issue at or above
500/1000 severity, or a *measured* dimension below its floor.

**An advisory never fails a build.** Below that cut is a `warn` verdict, not a `fail` one. It is
printed — a named finding a human can look at is worth more than a silence — and the job
continues. An excluded dimension never refuses either: a document to which no dimension applied
declines and says so, rather than being failed for an absence.

---

## Why there is no score in the log

This is the one design point worth arguing, because it is the one this repository has already
paid for once.

`AGENTS.md` records that a `quality_report` tool shipped and was deleted in 0.3.1. The reason:
> a model, told the number was "clean", sanded a lake into a dark flat rectangle.

Any number handed to an automated system becomes the target instead of the artwork. That is
Goodhart's law arriving on schedule, and a CI log is an automated system with opinions. So the
gate prints **defects** — a code, the dimension that owns it, where it is, and the analyzer's
own sentence:

```text
FAIL assets/generated/slime.pixel - the delivery gate refuses this document:
       value/flat-value at (0,0) 16x16: one lightness bucket holds 1000/1000 of the solid
         pixels; the form is not being described by tone at all.
```

That is a bug report. A human decides whether it matters. The one refusal that comes from a
weighted score rather than from a named defect — `aggregator/weighted-total` — is **named but
not numbered**: the exit code still counts it, and the log points at the defects above it
instead. Nothing in this Action prints an aggregate quality score, and adding one would be
re-introducing the tool that was deleted.

The severity numbers that do appear (`550/1000`, `400/1000`) are per-defect measurements against
a published per-defect cut, not a verdict about the artwork. They are how you tell a blocking
defect from an advisory one, which is the decision this Action exists to automate.

---

## Determinism

A build that produces different bytes on every CI run is worse than no build, because the diff
in `assets/` stops meaning *the artwork changed*.

- Every output comes from `buildSprite` / `buildAnimation` / `exportAssets`, which install a
  seeded id factory for the duration of the call and take all randomness from the engine's own
  `rng.ts`. There is no `Math.random` and no clock in a drawing path, and
  `packages/core/test/determinism.test.ts` bans both from `src`.
- `node-version` defaults to the package's floor, not `latest`, so two runs of one commit do not
  straddle a V8 change.
- The gate walks `asset-dir` in sorted order and consults no clock, so two runs over one tree
  report the same defects in the same order.

---

## The first run, and what will bite

- **`command` is required and there is no default.** A build script that does not exist yet is
  the most common first-run failure, and it fails at the first step rather than halfway.
- **The gate needs `.pixel` files.** It reads the `source: true` export, because that is the
  only output that is a document. A build that writes only PNGs and GIFs has nothing for it to
  measure, and it says so and passes — set `asset-dir`, or turn the gate off.
- **`asset-dir` is relative to `working-directory`.** If your build writes to `../assets` from a
  `tools/` working directory, the default finds nothing.
- **`install-command` defaults to `npm ci`.** A pnpm or yarn project must override it, or the
  install step fails before the build does.
- **`gate-threshold: warn` is not the default** and should stay off until you have run the gate
  on your own artwork and know what it says about it. `warn` additionally refuses a low weighted
  total, which is the one channel where an abstention is netted against unrelated readings.

---

## See also

- [`API.md`](API.md) — the library a build script imports.
- [`ASSET-CONTRACT.md`](ASSET-CONTRACT.md) — `meta.json` and the four engine importers, which
  `exportEngineAssets` drives from a build script.
- [`EVALUATION.md`](EVALUATION.md) — what the six dimensions measure and what their thresholds
  are worth today.
