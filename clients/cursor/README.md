# Cursor

**Config file:** `mcp.json`

| Scope | Path |
| --- | --- |
| Global — you, every project | `~/.cursor/mcp.json` |
| Project — this repository, committable | `<project>/.cursor/mcp.json` |

Both files are read and **merged**. If the same server name appears in both, the
project-level one wins. So install it globally unless you want it checked into a
specific repository.

Copy [`mcp.json`](./mcp.json) (macOS / Linux) or [`mcp.windows.json`](./mcp.windows.json)
(Windows) to `~/.cursor/mcp.json`. For a project, copy [`mcp.project.json`](./mcp.project.json)
to `.cursor/mcp.json` inside the project and commit it.

**Restart Cursor** after saving. Editing the file does not reload a running editor.

Or use the UI: **Customize → MCPs → Add new MCP Server**, and paste the same JSON.

## What the fields mean

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

| Field | Meaning |
| --- | --- |
| `mcpServers` | The wrapper object, one key per server. |
| `dotloom-mcp` | The server's name in Cursor's UI. |
| `type` | `"stdio"`. Cursor documents this field as required for stdio servers. Remote servers use a `url` instead and no `type`. |
| `command` | The program to launch. On Windows this pack uses `cmd`. |
| `args` | The arguments, **including the program name** — `["/c", "npx", …]` is `cmd` being told to run `npx`. |

Not used here, but valid in Cursor's `mcp.json`: `env` (environment variables for the
server process) and `envFile` (a file to load more variables from). `envFile` applies to
stdio servers only. Cursor also interpolates `${env:NAME}`, `${userHome}`,
`${workspaceFolder}`, `${workspaceFolderBasename}` and `${pathSeparator}` inside
`command`, `args`, `env`, `url` and `headers`.

## Transport note

Cursor supports three transports: stdio, SSE, and Streamable HTTP. This pack configures
**stdio**, because that is what this project can launch on its own. Cursor's HTTP option
would need a URL, and the only HTTP endpoint this project has is
`http://127.0.0.1:7331/mcp`, served by the desktop app while it runs, on loopback. You
*can* point a remote entry at it, but it disappears when the app closes, and Cursor's
remote entries expect OAuth — this server has none. Start the desktop app instead and
leave this config on stdio.

## If it does not connect

- **Read the logs.** Open the Output panel (`Cmd/Ctrl + Shift + U`) and choose
  **MCP Logs**. It shows handshake, tool calls and errors.
- **Check it appears.** **Customize → MCPs** lists every configured server with a
  toggle. Absent from the list means the JSON did not parse or was not reloaded.
- **`ENOENT` / `command not found` on Windows.** You pasted `npx` or `npx.cmd` instead
  of `cmd` + `/c npx`. Use the `.windows.json` file.
- **Environment variables do not arrive.** If the server relied on variables from your
  shell profile, make sure they are set for Cursor itself, not just your terminal, and
  restart Cursor after changing them.
