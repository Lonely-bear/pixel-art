# Claude

Two different products from the same company take MCP servers, and they read
different files. Pick the one you actually run.

---

## Claude Desktop (the chat app)

**Config file:** `claude_desktop_config.json`

| OS | Path |
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | Claude Desktop is not released for Linux — use Claude Code below. |

Open it without hunting for the path: **Claude menu → Settings → Developer → Edit Config**.
The button creates the file if it does not exist.

Copy [`claude_desktop_config.json`](./claude_desktop_config.json) (macOS / Linux) or
[`claude_desktop_config.windows.json`](./claude_desktop_config.windows.json) (Windows)
into it. If the file already has a `mcpServers` object with other servers in it, add
`dotloom-mcp` as another key inside it — do not replace the whole object.

Then **quit Claude Desktop completely and start it again.** Not just the window: the
process has to exit, or it never re-reads the file.

> **Merging, not overwriting.** Claude Desktop's config file is shared by every server
> you have installed. This pack's file is the complete object for a fresh install; on an
> existing install, copy just the `mcpServers` → `dotloom-mcp` entry.

---

## Claude Code (the terminal agent)

**Config file:** `.mcp.json`, in the root of the project you want the tools in.

That is Claude Code's *project scope*: the file is meant to be committed, so anyone who
clones the repository gets the same tools. On first use Claude Code shows an approval
prompt for project-scoped servers — answer it once per project.

Copy [`claude-code.mcp.json`](./claude-code.mcp.json) (macOS / Linux) or
[`claude-code.mcp.windows.json`](./claude-code.mcp.windows.json) (Windows) to
`.mcp.json` in your project root.

Instead of a file, Claude Code can write the entry for you:

```bash
claude mcp add --transport stdio dotloom-mcp -- npx -y dotloom-mcp
```

That defaults to *local* scope (this project, this user only). Add `--scope user` for
every project on your machine, or `--scope project` to have it write `.mcp.json` for the
team. Then check it:

```bash
claude mcp list
claude mcp get dotloom-mcp
```

Inside a session, `/mcp` opens the same panel interactively.

---

## What the fields mean

Claude reads the standard `mcpServers` object, shared with Cursor and Windsurf:

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

| Field | Meaning |
| --- | --- |
| `mcpServers` | The wrapper object. One key per server. |
| `dotloom-mcp` | The server's name in your client's UI. Arbitrary; this pack uses it everywhere so the same name works across clients. |
| `command` | The program to launch. On Windows this pack uses `cmd`. |
| `args` | The arguments, **including the program name** — `["/c", "npx", …]` is `cmd` being told to run `npx`. |

Claude Desktop and Claude Code both read an entry with `command` and no `type` as a
**stdio** server: Claude starts a local process and talks to it over that process's
standard input and output. No port, no server to keep running. That is the transport
this pack configures; see the note at the end of this file.

## If it does not connect

- **Nothing appears in the UI.** Claude Desktop only re-reads its config on a full
  restart. Quit the app from the tray/menu, not the window.
- **A `command not found` or `ENOENT` error on Windows.** You pasted `npx` or
  `npx.cmd` instead of `cmd` + `/c npx`. Use the `.windows.json` file.
- **Read the log.** Claude Desktop writes MCP logs to
  `~/Library/Logs/Claude/mcp.log` on macOS and `%APPDATA%\Claude\logs\mcp.log` on
  Windows. Per-server stderr goes to `mcp-server-<name>.log` next to it. The server's
  own startup line looks like
  `dotloom-mcp 0.4.2 ready on stdio in memory; watching for a desktop app.`
- **Test the launch command by hand.** Run the exact `command` + `args` in a terminal.
  It should print a ready line to *stderr* and then sit there waiting — that is correct
  behaviour for a stdio server, not a hang.

## Transport note

This project ships a **stdio** server. Claude Code additionally speaks HTTP and
WebSocket transports, but there is no standalone HTTP endpoint to point them at: the
HTTP endpoint (`http://127.0.0.1:7331/mcp`) exists only while the desktop app is
running, on loopback. If you want the agent to drive a live editor window, keep the
stdio config and start the desktop app — the server finds it by itself and attaches.
