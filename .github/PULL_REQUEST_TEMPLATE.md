<!-- Keep it short. If a section genuinely does not apply, say "n/a" and move on. -->

## What this changes

<!-- One paragraph, and the *why*. The diff already shows what changed. -->

Closes #

## How it was verified

<!-- Name the commands you ran and what you expected. A check that was not run does not
     go in this section. -->

- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build:npm && npm pack --dry-run` (if you touched packaging, bins, or `files`)
- [ ] `node scripts/mcp-call.mjs list` / `call …` (if you touched the tool surface)
- [ ] `pnpm --filter @pixel/app run dev` (if you touched the editor)

Commands run, and what I saw:

```
```

## Things that are easy to get wrong here

- [ ] **Every mutation goes through `applyCommand` on the shared bus.** The renderer does
      not commit through `core` directly; committed edits go over IPC via
      `window.pixel.execute` / `applyOps`. Bypassing the bus means a second undo history.
- [ ] **Every zod parameter has a `.describe()`** (`x`/`y`/`w`/`h` excepted). It is the
      product text an agent reads, not decoration. If you added a session tool rather than
      a command, it also declares an `outputSchema` and all four risk hints — and you
      checked what it did to the tool-count / advertised-bytes budget.
- [ ] **Every user-facing string exists in all five locales** (`en`, `ja`, `ko`, `zh-CN`,
      `zh-TW`) in `packages/app/src/i18n.tsx`, as a `{placeholder}` template — never
      concatenation, and never a literal in a component.
- [ ] **No new runtime dependency** without prior discussion in an issue. `packages/core`
      stays at zero.
- [ ] **Pixel data was not mutated in place.** Copy-on-write via `draft.cel()` /
      `tilesetImage()` / `tilemapData()`; `Draft` is the only mutation surface.
- [ ] **Failures are `CommandError`s with a `code`**, and `remediation` points at the tool
      that would actually have helped.
- [ ] **`CHANGELOG.md` has an entry under `## [Unreleased]`**, in the voice already in that
      file — the user-visible effect, not a restatement of this PR's title.
- [ ] **Nothing under `dist/`, `pnpm-workspace.yaml`'s overrides, or the preload's
      CommonJS + `createRequire` banner was touched.** Those are load-bearing.
- [ ] **`README.md` / `docs/REFERENCE.md` updated** if the behaviour, commands, or tool
      surface changed. `README.md` is the English source; `README-ZH.md` mirrors it.
- [ ] **The new test would have failed before this change.**
