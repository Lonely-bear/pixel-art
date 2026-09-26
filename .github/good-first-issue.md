# Good first issues

Issues labelled `good first issue` are small, well-bounded, and reviewed with the same care
as anything else — the label is about *scope*, not about lowering the bar. They are chosen
so that a first contribution teaches you one part of this codebase rather than all of it.

**Claim one by commenting on the issue before you start.** Say which one you want and
roughly when; that is the whole claim process. If somebody else has already said the same
thing, coordinate in the thread rather than racing.

Before you write a line, please read [`CONTRIBUTING.md`](../CONTRIBUTING.md) — in
particular [the build-order trap](../CONTRIBUTING.md#the-build-order-trap), which costs
every new contributor about an hour, and [the conventions](../CONTRIBUTING.md#the-conventions-that-are-not-obvious-from-the-code),
which a review will hold you to.

## What makes a good first issue here

- It touches **one package**. `packages/core` has no Node, DOM or Electron dependency, so
  it is the easiest place to succeed; `packages/app` needs two tsconfigs and five locales.
- Its **correct answer is checkable**. A test can fail before and pass after.
- It does **not** need a new runtime dependency, and does not change the document model,
  the serialisation format, or the advertised tool list.
- A reviewer can tell whether it is right by reading the diff.

## The kinds of task we usually label this way

**Write a test for something that has none.**
`packages/cli` has no tests at all — its `test` script is `vitest run --passWithNoTests`, so
a green suite there proves nothing ran. A first test for a single subcommand (start with
`new`, `info`, `export` or `commands`) would be a real contribution. In `packages/app`, the
only test so far is `update-support.test.ts`; a test beside `ipc.ts` or `settings.ts` would
be a good way in.

**Write a `guide` for a command that has none.**
About 7 of the ~90 commands have one — `dither_fill`, `outline`, `add_palette_ramp`,
`set_tile`, `autotile`, `stroke_tilemap` and `mirror`. A guide is the long-form manual
served at `pixel://guide/{command}`: conventions, ordering rules, re-run hazards, worked
defaults. Pick a command you have actually used, and write down the thing you had to learn
the hard way. The maintainer assigns which commands, so ask in the issue thread rather than
picking one unilaterally.

**Describe a parameter properly.**
`.describe()` on a zod field is the product text an AI agent reads, and
`tool-surface.test.ts` only walks the *advertised* surface — the ~90 core commands are
mostly outside that walk. Auditing one command's parameters for descriptions that say what
the agent cannot guess (units, defaults, which layer a name refers to, when *not* to use
it) is well-scoped, low-risk, and directly improves how agents call the tool.

**Improve an existing test's intent comment, or extend a test that cannot fail.**
Several tests here encode a decision that looks arbitrary until you know the story, and a
few checks have been added for completeness rather than because they caught something. Both
are worth an issue of their own, and both are real work: a test that cannot fail is worse
than no test, because it reads as if it is protecting something.

**Documentation that is checked against the code.**
`docs/REFERENCE.md` is load-bearing and accurate, which means a drift in it is a real bug.
Pinning one command's parameters, options or failure modes in the reference, matched
against the zod schema, keeps it that way.

**A small, self-contained fix** from the issue tracker that does not touch the command bus
or the tool surface. Ask for it to be labelled if you find one.

## What we will not label a good first issue

- Anything that adds a runtime dependency, changes the `.pixel` container format, or moves
  a rule between the layers of the bus.
- Anything that adds to the advertised MCP tool list. The list is budgeted
  (`tools.length <= 40`, advertised bytes `<= 100_000`) and a new session tool is a
  design decision, not a contribution.
- A refactor across packages. Tempting, and much better as a conversation first.
- A new drawing command. The catalogue is past the point where a model can choose well
  between options; see [D-6 in the roadmap](../TASKS.md) for the reasoning.

## Bar for the PR

The same as any other PR: one idea, Conventional Commits with a scope, a body that explains
why, and a `CHANGELOG.md` entry under `## [Unreleased]` if the change is user-visible.
Read a test's intent comment before you change what it asserts. If a check you report was
not actually run, do not report it — a verification you did not perform makes the rest of
your report untrustworthy, and that is the fastest way to lose a maintainer's confidence.
