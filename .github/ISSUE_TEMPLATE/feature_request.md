---
name: Feature request
about: Propose a capability for the engine, the tool surface, or an export
title: ''
labels: enhancement
assignees: ''
---

## The problem

Not the solution — the problem. What are you trying to make that this project does not
let you make today, and how are you working around it now?

A concrete description of the workaround is worth more than a description of the wish,
because the workaround tells us which existing concept is in the wrong place.

## What you are actually building

- The kind of asset: character sprite / tileset / environment / UI / animation / live-edit
  inside the app / batch pipeline
- Engine scale: typical canvas size, frame count, palette size
- How you drive it: MCP client, `pixel` CLI, scripts, the editor, or a mix
- Whether the app is attached or the server runs in memory

## Proposal

What you would like to be able to do, in terms of the tools or commands you would call. If
you already have a payload in mind, paste it:

```json
{ "ops": [] }
```

**Is this a new command, or a parameter on an existing one?** The distinction matters here:
a new **core command** costs nothing in the advertised tool list and is the cheap option,
while a new **session tool** spends a fixed budget that the tool-surface test guards
(`tools.length <= 40`, advertised bytes `<= 100_000`). If you can express the capability as
a command plus a `guide`, say so — that is the shape we can accept most easily.

## What an agent would need to know to use it

The question that decides most requests in this project: **how would a model know when to
reach for this, and what would it get wrong by guessing?** If the answer is "nothing, it
would just work", the capability may already be there under a different name — please check
`list_commands` and `find_workflow` first, and say what you found.

If there is a trap (a hue wheel to warn about, an ordering rule, a value that reads
differently at different canvas sizes), that belongs in the answer. It is what a `guide`
would say.

## Alternatives you considered

Including "do nothing" and "do it in a script". Sometimes the right answer is a new
primitive in the script API, and sometimes it is a `guide` telling the agent to sequence
existing commands differently.

## Scope and cost, if you can

- Does it need a new runtime dependency? (Our rule: no, and `packages/core` stays at zero.)
- Does it touch the document model / serialisation? (Format compatibility and `.pixel`
  container versions are a real cost, not a free change.)
- Does it change the command catalogue, the tool surface, or a public API? Those are the
  three things that need the most care.

## Contribution

Would you like to implement it? A PR against a discussed design is much easier to review
than a PR against a guess.
