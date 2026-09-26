---
name: Bug report
about: Something behaves differently from what the tool description promised
title: ''
labels: bug
assignees: ''
---

<!-- dotloom-mcp is operated through an MCP client far more often than through the
     desktop window, and the fields below are the ones that actually make a report
     actionable. Everything in a fenced block is what we will diff against. -->

**What happened.** One or two sentences. What did the tool, the CLI or the editor do?

**What you expected instead.** If a tool description or a `guide` promised something
specific, quote it — a promise the implementation misses is a much more actionable
report than a preference.

## How it was reached

- **Surface:** MCP server / `pixel` CLI / Electron editor / script or plugin
- **Client** (if MCP): e.g. Claude Desktop, Cursor, opencode, Windsurf, VS Code, other
- **Server mode** — paste the output of `get_connection_status`:
  ```
  ```
  This one matters. The server either attached to a running desktop app on
  `127.0.0.1:7331` or is running in memory, and the two behave differently:
  documents may be shared and persisted in one and not the other, `expectedVersion`
  conflicts can only really happen in the attached case, and nothing is written to disk
  until `save_document` / `finalize_document` in the in-memory case.
- **Server version** (`dotloom-mcp --version`) and app version if you used the editor:
  ```
  ```
- **Exact commands or tool calls**, in order, as run:
  ```
  ```

## The document

- **Sprite dimensions** (width × height), frame count, layer names and order:
- **The `ops` payload verbatim**, if this came from `apply_ops` / `pixel apply`. Paste the
  JSON — a screenshot of the canvas cannot be diffed, and a screenshot at 1x cannot show
  the problem at all:
  ```json
  {
    "ops": []
  }
  ```
- **Script source** (if `run_script`), or a link to it:
- **Any warnings or non-`ok` responses** you saw along the way, quoted whole, including
  the `code` and any `remediation`:
  ```
  ```

## Expected vs actual

| | |
| --- | --- |
| Expected | |
| Actual | |

## Surfaces

- [ ] Reproduced more than once
- [ ] Reproduced with the standalone server only (`dotloom-mcp --standalone`), which rules
      the desktop app in or out
- [ ] Reproduced in the CLI (`pixel …`) rather than only over MCP
- [ ] Reproduced with a fresh 8×8 / 32×32 document, so it is not specific to my artwork
- [ ] Reproduced on the version in `main` (built from this checkout), not just a release

## Tool list, when relevant

If the bug is about what the server advertised, what it failed to expose, or what an agent
should have been able to find, paste the tool list. This is the single most useful artifact
for a surface bug:

```bash
node scripts/mcp-call.mjs list        # or, for the full schema catalogue:
node packages/cli/dist/index.js commands --json > tools.json
```

```
```

## Anything else

Logs, a screen recording, a link to the `.pixel` file if you can share it, and how much
work the drawing represents. If the same input produced a *correct* result in another
session, say so — non-determinism and a stale `dist/` (a running MCP server caches its
build at startup) are both common explanations and both worth ruling out.
