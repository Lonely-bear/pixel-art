# Windsurf

**Config file:** `mcp_config.json`

| OS | Path |
| --- | --- |
| macOS / Linux | `~/.config/devin/mcp_config.json` (or `$XDG_CONFIG_HOME/devin/mcp_config.json`) |
| Windows | `%APPDATA%\devin\mcp_config.json` |

Do not hunt for the path — Windsurf opens the file for you: in the Cascade panel, click
**`...` (Actions) → Open MCP config file** in the MCPs section. Whatever directory that
dialog shows is the file that is actually read on your install. Windsurf also documents
the file as a **global** setting: there is no per-project MCP file, so one entry serves
every workspace you open.

Copy [`mcp_config.json`](./mcp_config.json) (macOS / Linux) or
[`mcp_config.windows.json`](./mcp_config.windows.json) (Windows) into it.

**Then hit refresh in the MCPs panel.** Editing the file does not restart a server that
is already running; if a server is stuck in a failed state, refresh may reuse the dead
process and a full Windsurf restart is the reliable fix.

## What the fields mean

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
| `mcpServers` | The wrapper object, one key per server. |
| `dotloom-mcp` | The server's name in Windsurf's UI. **Case-sensitive**, and the same string is what a team allowlist matches against. |
| `command` | The program to launch. On Windows this pack uses `cmd`. |
| `args` | The arguments, **including the program name** — `["/c", "npx", …]` is `cmd` being told to run `npx`. |

Other fields Windsurf accepts here: `env`, `disabledTools` (a list of tool names to
switch off for this server), and for remote servers `serverUrl` or `url` plus `headers`.
`command`, `args`, `env`, `serverUrl`, `url` and `headers` all support interpolation:
`${env:VAR}` and `${file:/path/to/secret}`.

## Transport note

Windsurf supports stdio, Streamable HTTP and SSE. This pack configures **stdio**, because
that is what this project can launch on its own. A remote entry would need a URL, and the
only HTTP endpoint this project has is `http://127.0.0.1:7331/mcp`, served by the desktop
app while it runs, on loopback.

## Known caveats on this client

- **Windsurf's Cascade has a hard limit of 100 MCP tools in total.** This server starts
  with 36 advertised tools, so there is room, but a 127-tool server next to it would not
  fit. If you hit "too many tools", disable the other servers in
  **Settings → Tools**, or turn off individual tools in the MCPs panel.
- **The config path has moved during Windsurf's transition into Devin Desktop.** Older
  documentation and a lot of third-party guides still say
  `~/.codeium/windsurf/mcp_config.json`. Current documentation says
  `~/.config/devin/mcp_config.json`. **Trust the file your own Windsurf opens** from
  **Actions → Open MCP config file** rather than either path — if you create a file at
  the wrong location, nothing reads it and the server simply never appears.
- **Some of this configuration applies to the legacy Cascade agent only.** Windsurf's own
  documentation says the newer local agent configures MCP servers through separate
  Devin CLI config files instead. If your install is on the newer agent, add the server
  there — the `mcpServers` entry itself is unchanged.
- **Teams and Enterprise can lock MCP servers down.** Once a team allowlists any server,
  everything not on the list is blocked for that team, and the allowlist entry's server
  name has to match yours exactly.

## If it does not connect

- **The server never appears.** Wrong file location — see above. Confirm with
  **Actions → Open MCP config file**.
- **JSON syntax error.** Windsurf rejects the whole file. Check it parses:
  `python -m json.tool ~/.config/devin/mcp_config.json` or `jq .` on the same path.
- **`ENOENT` on Windows.** Use the `.windows.json` file.
- **Refresh did not help.** Fully restart Windsurf; a failed server process can survive
  the refresh.
