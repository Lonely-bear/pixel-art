---
name: Asset showcase
about: Pixel art you made with dotloom-mcp - with the prompt and ops so anyone can reproduce it
title: ''
labels: showcase
assignees: ''
---

<!-- The ops JSON is the point. A piece of pixel art posted without one is an anecdote;
     a piece posted with one is a test of the toolchain, and it often turns out to be the
     fastest bug report we get. Everything in a fenced block gets diffed. -->

## The piece

Attach the PNG (and the `.pixel` source if you are willing — it is the editable document,
and it makes the layers, frames and tags legible).

- **Title / subject:**
- **Canvas size** (width × height), frames, layers:
- **Palette** (how many colours, and how you built it):
- **Drawn by:** you, an agent, or both (and if both, who decided what)
- **Time or command count**, if you measured it

## The prompt

Paste the prompt or instruction text that drove it, verbatim, including the system or
skill context if the agent used one. If the agent made its own decisions at several points,
paste the transcript of the part where it chose its approach — the choices are the
interesting part, not the result.

```
```

## The ops

The actual `ops` payload, or the `run_script` source. This is the reproducible artifact:
with it, anyone can re-run the piece and get the same sprite, and a divergence is a real
signal. Paste `ops` in full rather than a link to a gist we cannot reach.

```json
{ "ops": [] }
```

Or the script:

```js
```

## How the agent worked

- **Client and server mode** — `get_connection_status` (attached to a running app, or in
  memory):
- **Did it use `get_preview`, `read_grid`, or both?** How many previews per piece?
- **Where did it go wrong first?** The pass that produced a bad silhouette, the ramp that
  interpolated through magenta, the dither that read as noise at this canvas size. This is
  genuinely useful to us, and we would rather have a piece that shows two wrong turns than
  one that shows none.
- **What fixed it**, and whether the tool surface *let* it fix it (a guide it read, a
  remediation it followed, a preview at a scale where the problem was visible).

## Credits

If someone else's palette discipline, character design or photo reference is in there,
say whose. If this was made with a particular model or client, name it. If it came out of
your own prompt engineering, that is worth describing too.
