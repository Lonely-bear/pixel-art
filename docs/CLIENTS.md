# Connecting an AI client to dotloom-mcp

<p align="center">
  <a href="CLIENTS.md">English</a> · <a href="CLIENTS-ZH.md">中文</a>
</p>

> This document is the authority for client setup. `CLIENTS-ZH.md` is its Chinese mirror:
> where the two disagree, this one is correct and the Chinese one is the stale copy.

`dotloom-mcp` is a game-asset pipeline for pixel art — sprites, animation frames,
spritesheets and tile maps. It runs as a **Model Context Protocol (MCP) server**, which is
how an AI assistant such as Claude, Cursor, OpenCode or Windsurf learns to draw with it.

This page is for someone who has never used this project: it assumes nothing about MCP
beyond what each step needs.

The configuration files discussed here also exist as literal files in
[`clients/`](../clients), one directory per client, so you can diff them instead of
transcribing them. This document is self-contained: you can do everything from it without
opening that directory.

---

## What you are connecting to

One process, one protocol. When your AI client starts `dotloom-mcp`, it launches a small
Node.js program on your machine and talks to it over that program's **standard input and
standard output** — the same pipes a program uses when you type at it. That arrangement
is called **stdio**. There is nothing to install as a service, no port to open, no URL to
paste, and nothing left running when you close the client.

Two consequences worth knowing up front:

- **Your client starts the server and stops it with the session.** You never launch it by
  hand, and you never have to keep it alive.
- **The first start downloads the package.** `npx` fetches `dotloom-mcp` from npm, so the
  first launch takes a few seconds longer than later ones. Nothing is installed globally.

Once connected, the assistant can create a sprite, draw on it, shade it, read the exact
pixels back, preview it as an image, and export PNG / spritesheet / GIF / Tiled output.
It works entirely inside the process — see
[Honest limitations](#honest-limitations) for what that costs you.

---

## Before you start

### 1. Node.js 22.13 or newer

The server is a Node.js program. Check what you have:

```bash
node --version
```

You need **v22.13.0** or newer. If you have something older, install a current release
from [nodejs.org](https://nodejs.org/) (or your version manager) and re-check. On Windows,
`node` must be on your `PATH` — reopen your terminal after installing if it is not found.

`npx` ships with Node, so if `node --version` works, `npx` is already there.

### 2. The package runs

Run the server the way your client will, and check it answers:

```bash
npx -y dotloom-mcp --version
```

```
dotloom-mcp 0.4.2
```

That line is the whole prerequisite check. If it prints the version, the network is
reachable and Node is new enough. **The line is written to stderr, not stdout** — that is
deliberate, because on a stdio connection stdout carries the protocol. Some shells make
stderr look like an error; it is not one.

If it hangs instead of printing, it is running fine — a stdio server with nothing talking
to it sits there waiting. Press `Ctrl+C`.

### 3. Optional: the desktop app

The server works with no app installed. If you **do** have the
[dotloom-mcp desktop editor](https://github.com/Lonely-bear/pixel-art/releases/latest)
running, the server finds it automatically and edits the same documents the window is
showing, through one shared undo history. Nothing to configure either way.

---

## The fields you are about to type

Every client below configures the same server, so the vocabulary is shared. Five fields
cover all of them.

| Field | Appears in | What it means |
| --- | --- | --- |
| `mcpServers` | Claude, Cursor, Windsurf | The wrapper object holding one entry per server. |
| `mcp` | OpenCode | The same job, under a different name **and a different nesting** — see [OpenCode](#opencode). |
| `<the server's name>` | both | The key `dotloom-mcp`. This is the label *your client* displays. It is arbitrary; this guide uses it everywhere so the name is the same in all four clients. |
| `command` | Claude, Cursor, Windsurf | The program to launch. A string. |
| `type` | Cursor, OpenCode | How to launch it: `"stdio"` / `"local"` for a program this client starts, or a remote `url` for a server that is already running elsewhere. |
| `args` | Claude, Cursor, Windsurf | The arguments, **as a list, with the program name included**. `["/c", "npx", "-y", "dotloom-mcp"]` reads as "`cmd`, run `npx` with `-y` and `dotloom-mcp`". |
| `command` | OpenCode | The same information, but as one list with no separate field: `["npx", "-y", "dotloom-mcp"]`. |
| `env` / `environment` | all | Environment variables for the server process. **This server needs none.** Leave it out. |

`command: "npx"` + `args: ["-y", "dotloom-mcp"]` means: run `npx`, tell it not to ask
before downloading (`-y`), and start the `dotloom-mcp` package.

### Windows: one substitution, and why

On Windows every config below swaps its first two fields:

| | macOS / Linux | Windows |
| --- | --- | --- |
| `command` | `"npx"` | `"cmd"` |
| `args` | `["-y", "dotloom-mcp"]` | `["/c", "npx", "-y", "dotloom-mcp"]` |

This is not a stylistic preference. Node has refused to execute `.cmd` and `.bat` shims
without a command shell since the fix for CVE-2024-27980 (Node 18.20.2, 20.12.2, 22 and
later), and on Windows a bare `npx` is not an executable at all — it is a shell script
with no extension. Measured on Node 22.20.0:

| `command` | Client spawns without a shell | Client spawns with a shell |
| --- | --- | --- |
| `npx` | fails — `ENOENT` | works |
| `npx.cmd` | fails — `EINVAL` | works |
| `cmd` + `/c npx …` | **works** | **works** |

`cmd.exe` is a real executable, so routing through it works either way, which makes it the
only form that does not depend on how your particular client starts processes. If a guide
tells you to use `npx.cmd` on Windows, that advice predates the Node change above.

---

## Pick your client

### Claude Desktop

**File:** `claude_desktop_config.json`

| OS | Path |
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | Claude Desktop is not released for Linux. Use [Claude Code](#claude-code). |

macOS / Linux:

```json
{
  "mcpServers": {
    "dotloom-mcp": {
      "command": "npx",
      "args": ["-y", "dotloom-mcp"]
    }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "dotloom-mcp": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "dotloom-mcp"]
    }
  }
}
```

**How to get there:** Claude menu → **Settings** → **Developer** tab → **Edit Config**.
The button creates the file if it does not exist, so you do not have to find the path by
hand.

**If the file already contains other servers,** keep them. Add the `dotloom-mcp` entry
inside the existing `mcpServers` object rather than replacing the file.

**Then quit Claude Desktop completely and start it again.** Closing the window is not
enough; the process has to exit before it re-reads its configuration.

### Claude Code

**File:** `.mcp.json` in the root of the project that should have the tools.

macOS / Linux:

```json
{
  "mcpServers": {
    "dotloom-mcp": {
      "command": "npx",
      "args": ["-y", "dotloom-mcp"]
    }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "dotloom-mcp": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "dotloom-mcp"]
    }
  }
}
```

`.mcp.json` is Claude Code's **project** scope: it is meant to be committed, so everyone
who clones the repository gets the same tools. The first time you open the project,
Claude Code shows an approval prompt for project-scoped servers — approve it once per
project.

Prefer not to write the file? Let the CLI do it:

```bash
claude mcp add --transport stdio dotloom-mcp -- npx -y dotloom-mcp
```

That stores the entry for *you, in this project only*. Add `--scope user` to make it
available in every project on your machine, or `--scope project` to have it write
`.mcp.json` for the whole team.

```bash
claude mcp list        # every configured server, with a connection status
claude mcp get dotloom-mcp   # the stored definition for one server
```

Inside a running session, `/mcp` opens the same list interactively.

### Cursor

**File:** `mcp.json`

| Scope | Path |
| --- | --- |
| Global — you, every project | `~/.cursor/mcp.json` |
| Project — this repository | `<project>/.cursor/mcp.json` |

Cursor reads both and merges them; when the same server name is in both, the project file
wins. Install it globally unless you want it committed to one repository.

macOS / Linux:

```json
{
  "mcpServers": {
    "dotloom-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "dotloom-mcp"]
    }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "dotloom-mcp": {
      "type": "stdio",
      "command": "cmd",
      "args": ["/c", "npx", "-y", "dotloom-mcp"]
    }
  }
}
```

Cursor documents `type` as required for stdio servers, so it is included here.

**Restart Cursor** after saving — editing the file does not reload a running editor. Or
use the UI: **Customize → MCPs → Add new MCP Server**, and paste the same JSON.

### OpenCode

**File:** `opencode.json` or `opencode.jsonc`

| Scope | Path |
| --- | --- |
| Global | `~/.config/opencode/opencode.json` |
| Project | `<project>/opencode.json`, or `<project>/.opencode/opencode.json` |

macOS / Linux:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "dotloom-mcp": {
      "type": "local",
      "command": ["npx", "-y", "dotloom-mcp"],
      "enabled": true
    }
  }
}
```

Windows:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "dotloom-mcp": {
      "type": "local",
      "command": ["cmd", "/c", "npx", "-y", "dotloom-mcp"],
      "enabled": true
    }
  }
}
```

```bash
opencode mcp list
```

`opencode mcp add` walks you through adding a local or remote
server interactively.

**OpenCode's shape is different from the other three, and it is easy to get wrong.**

- The server name is a key **directly under `mcp`**. There is no intermediate `servers`
  key. A `mcp.servers.dotloom-mcp` entry is read as *a server literally named `servers`,
  with no `type` and no `command`*, and `dotloom-mcp` is never configured at all. That
  shape is rejected by OpenCode's published JSON Schema.
- `command` is **one array containing the program**, not a string and not a string plus a
  separate argument list.
- `type` is required: `"local"` here, `"remote"` for a URL.
- Environment variables go under `environment`, not `env`. `timeout` (milliseconds) is
  also accepted; see [Troubleshooting](#troubleshooting).

### Windsurf

**File:** `mcp_config.json`

| OS | Path |
| --- | --- |
| macOS / Linux | `~/.config/devin/mcp_config.json`, or `$XDG_CONFIG_HOME/devin/mcp_config.json` |
| Windows | `%APPDATA%\devin\mcp_config.json` |

macOS / Linux:

```json
{
  "mcpServers": {
    "dotloom-mcp": {
      "command": "npx",
      "args": ["-y", "dotloom-mcp"]
    }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "dotloom-mcp": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "dotloom-mcp"]
    }
  }
}
```

**Do not look for that path — let Windsurf tell you.** In the Cascade panel click
**`...` (Actions) → Open MCP config file**, and the file it opens is the one your install
actually reads.

> The path above is what Windsurf's current documentation states. Older documentation, and
> many third-party guides, still say `~/.codeium/windsurf/mcp_config.json`; Windsurf's own
> documentation also notes that this configuration applies to its legacy Cascade agent,
> while its newer local agent uses separate Devin CLI config files. **Trust the file
> Windsurf opens for you.** A config at the wrong path is not an error — it is silently
> ignored, and the server simply never appears.

Windsurf's MCP configuration is **global**: there is no per-project file, so one entry
serves every workspace.

**Then refresh in the MCPs panel.** Editing the file does not restart a running server.
If one is stuck in a failed state, refresh can reuse the dead process — restart Windsurf
fully in that case.

---

## Verify the connection

Most clients showing the server in a list proves very little: it proves a JSON file parsed.
These three checks go further, in increasing order of what they prove.

### Check 1 — the client reports it connected

| Client | Where |
| --- | --- |
| Claude Code | `claude mcp list`, or `/mcp` in a session |
| OpenCode | `opencode mcp list` |
| Cursor | **Customize → MCPs** |
| Claude Desktop | The connectors menu under the prompt box |
| Windsurf | The **MCPs** section of the Cascade panel |

### Check 2 — call `get_connection_status`

This is the real test, and it is the reason to prefer this server over one that only draws.
Ask the assistant:

> Call the `get_connection_status` tool on the dotloom-mcp server and show me the result.

With no desktop app running, a correct answer looks like this:

```json
{
  "ok": true,
  "attached": false,
  "mode": "memory",
  "livePreview": false,
  "url": null,
  "port": null,
  "source": null,
  "note": "No desktop app is connected. Edits live only in memory until save_document/finalize_document. Ask the user to open the app for live preview; this session reconnects automatically when it appears."
}
```

Read it as: *connected, running on its own, nothing on screen.* With the desktop app
running, `mode` becomes `"app"` and `livePreview` becomes `true`, and the same tool tells
the agent it is driving your open window.

A server that is not there at all produces no tool and no such error — that is the
distinction between "connected and in memory" and "not connected".

### Check 3 — call `read_grid`

This one reaches the drawing engine rather than reporting on it. Ask:

> Call `read_grid` on dotloom-mcp for the rectangle from 0,0 to 10,4 and show me the output.

On a fresh session — a brand-new 32×32 document with nothing drawn on it — a correct
answer says:

```
read_grid  view=value  frame=0  scope=composite  rect=10x4 at (0, 0)
opaque 0/40  (nothing drawn in this region)
```

**"nothing drawn in this region" is the pass condition.** You are not looking for a
picture; you are looking for a real measurement of a real (empty) document. If the tool
errors, is missing, or reports a document you never asked for, the connection is not
what you think it is.

A good first real request after that:

> Using dotloom-mcp, create a 16×16 slime sprite with four green tones and show me a preview.

### What you will see in the tool list

The server advertises **37 tools**. That is deliberate, not a truncated list: the ~90
drawing, palette, rig and tilemap commands behind them are published on demand so they do
not consume the context window of every message. Ask the assistant for
`list_commands` to see the full catalogue, and `describe_command` with a command's name to
get its exact parameters.

You may also notice the server describing itself as **`dotloom-mcp-link`** in some
clients. That is expected. The name in your configuration (`dotloom-mcp`) is the label
your client shows; the name the server reports over the protocol gains a `-link` suffix
because it is running in the mode that links to a desktop editor when one appears. Both
appear in normal use.

---

## Honest limitations

- **Nothing is written to disk unless you ask.** Everything the assistant draws lives in
  memory for the life of the session. It is discarded when the session ends unless it
  calls `save_document` or `finalize_document` with an output path. Ask for an export
  explicitly — "show me a preview" does not save a file.
- **No live preview without the desktop app.** You get images returned by the
  `get_preview` tools inside the chat, which is enough to work with, but there is no
  window that updates as it draws. Start the desktop app for that.
- **HTTP is not offered as a standalone option.** Three of the four clients can connect
  to a URL, and this page could have given you one. It cannot: the HTTP endpoint,
  `http://127.0.0.1:7331/mcp`, exists only while the desktop app is running, is bound to
  loopback so nothing off the machine can reach it, and expects no authentication. A URL
  that vanishes when an app closes is a worse starting point than a process your client
  starts and stops. All four configs here use stdio, and the server attaches to a running
  app on its own.
- **The first launch is slow.** `npx` downloads the package first. If your client has a
  short startup timeout — OpenCode defaults to 5 seconds for fetching tools — warm it
  once in a terminal with `npx -y dotloom-mcp --version`.
- **Pinning is up to you.** `npx -y dotloom-mcp` takes the newest published release on
  every start. To hold a version, write `"dotloom-mcp@0.4.2"` in its place.
- **Windsurf has a 100-tool ceiling** across all MCP servers combined. This one starts at
  36, so it fits, but check the others before adding more.
- **The server can read and write local files** when you ask it to — opening documents,
  importing images, exporting assets. It runs as you, with your permissions. Use it on
  your own machine, and think about which directories it should touch before pointing an
  agent at something sensitive.
- **The config files in `clients/` are not in the npm tarball.** This page is; the
  directory is only in the GitHub repository. That is why the blocks above are complete
  and self-contained — copy them from here.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Server absent from the client | Config not reloaded, or at a path the client does not read | Restart the client fully. On Windsurf, confirm via **Actions → Open MCP config file**. |
| `command not found` / `ENOENT` | Windows, and `npx` or `npx.cmd` was used | Switch to the `cmd` + `/c npx` form. See [Windows](#windows-one-substitution-and-why). |
| `EINVAL` | Windows, and `npx.cmd` was used | Same fix. Node refuses to run a `.cmd` without a shell. |
| Server listed but no tools | Start-up timeout on the first `npx` download | Warm the cache: `npx -y dotloom-mcp --version`. On OpenCode, add `"timeout": 60000` to the entry. |
| Assistant cannot find `get_connection_status` | Server not connected at all | Read the client's MCP log. Claude Desktop writes to `~/Library/Logs/Claude/mcp.log` (macOS) or `%APPDATA%\Claude\logs\mcp.log` (Windows); Cursor has **MCP Logs** in its Output panel. |
| Works, but nothing appears on screen | Desktop app not running | Expected. See [Honest limitations](#honest-limitations). |
| Work vanished between sessions | Nothing was saved | Ask for `finalize_document` with an output path. |
| OpenCode: server missing from `opencode mcp list` | Entry nested under `mcp.servers`, or `command` is a string | See [OpenCode](#opencode). |
| OpenCode: `dotloom-mcp` appears but never connects | Wrong file — OpenCode reads global config from `~/.config/opencode/` | Check which `opencode.json` you wrote to. |

### Reading the server's own log

The server writes its startup line to stderr, which MCP clients capture into their MCP
logs. A healthy start looks like one of:

```
dotloom-mcp 0.4.2 ready on stdio in memory; watching for a desktop app.
dotloom-mcp 0.4.2 ready on stdio, attached to http://127.0.0.1:7331/mcp.
```

If you would rather see it yourself:

```bash
npx -y dotloom-mcp
```

It prints that line and waits. That is the correct behaviour, not a hang.

### Working without a client

The repository ships a script that speaks the same protocol, which is useful for checking
a problem without involving an AI assistant at all:

```bash
node scripts/mcp-call.mjs list        # every advertised tool
node scripts/mcp-call.mjs call get_connection_status '{}'
```

---

## See also

- [`clients/`](../clients) — the configuration files as literal, diffable files
- [`REFERENCE.md`](REFERENCE.md) — the MCP surface in depth: the command catalogue, the
  lazy tool surface, scripting, tilemaps
- [`API.md`](API.md) — the build-script API, for generating assets from code instead
- [Model Context Protocol](https://modelcontextprotocol.io/) — the protocol itself
- [中文版](CLIENTS-ZH.md)
