# Artwork produced through the MCP surface

Files here were drawn by an agent driving `dotloom-mcp` over the wire, through the
public tool list only — no imports from `@pixel/core`, no direct `Editor` access.

That constraint is the point of the folder. It is the evidence for a design decision:
the advertised tool list is 33 tools instead of 127, and the ~90 core commands
(`draw_rect`, `add_palette_ramp`, `outline`, `dither_fill`, …) are **not** in the list
up front. An agent has to find them, and it can only find them the way any MCP client
would — through `list_commands`, `describe_command`, `find_workflow`, `apply_ops` and
`read_skill`. A command becomes a directly callable tool the moment the session looks
it up or runs it.

So each piece here is a test of the discovery path as much as of the drawing. If the
lazy surface were broken, the agent would have had no route to a silhouette at all.

## Pieces

| File | What it is |
| --- | --- |
| `sunset-lighthouse-512.png` | 512×512 environment, the largest piece here |
| `dusk-lake-valley-agent2.png` | environment, revised after a `quality_report` pass |
| `autumn-dusk-lake-256.png` | environment at 256×256 |
| `moonlit-alpine-lake.png` | a deliberately small/fast pass |

Each `*.pixel` is the editable source the server wrote; each `*-preview.png` is an
inspection render rather than a deliverable.

Regenerate with the standalone server:

```bash
node packages/mcp/dist/cli.js   # then drive it from an agent session
```

`verify/lantern-keeper.png` is the one that proved the discovery path: it was drawn by
an agent that started with 33 tools and no drawing commands, found them through
`list_commands`, promoted them, and used them. `verify/recheck.json` replays the
specific behaviours that run exposed as broken, against a live server:

```bash
node scripts/mcp-call.mjs calls artwork/verify/recheck.json
```

The measurement that motivated the change, and the numbers after it, are in
`docs/REFERENCE.md` under *What it exposes*.
