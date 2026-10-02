# OpenCode

**Config file:** `opencode.json` or `opencode.jsonc`, at your global config directory or
in a project root.

| Scope | Path |
| --- | --- |
| Global | `~/.config/opencode/opencode.json` |
| Project | `<project>/opencode.json` (or `.opencode/opencode.json`) |

`opencode.jsonc` is the same file with comments allowed; use whichever your setup
already has, or create `opencode.json`.

Copy [`opencode.json`](./opencode.json) (macOS / Linux) or
[`opencode.windows.json`](./opencode.windows.json) (Windows) into place.

Check the result:

```bash
opencode mcp list
```

(`opencode mcp list` also works from inside a running session.)

You can also let OpenCode write it: run `opencode mcp add`, which walks you through
adding a local or remote server interactively.

## What the fields mean

OpenCode's shape is **not** the `mcpServers` object the other three clients use. The
server name is a key **directly under `mcp`**, and each entry declares its own `type`:

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

| Field | Meaning |
| --- | --- |
| `$schema` | Editor hint that gives you completion and validation in VS Code and friends. Optional; harmless. |
| `mcp` | The wrapper object. **One key per server, directly under it** — there is no intermediate `servers` key. |
| `dotloom-mcp` | The server's name in OpenCode's UI. |
| `type` | `"local"` for a server OpenCode launches itself. `"remote"` for a URL you give it. Both required. |
| `command` | The launch command **as an array, program first** — `["npx", "-y", "dotloom-mcp"]` is the three tokens `npx`, `-y`, `dotloom-mcp`. |
| `enabled` | Optional. `false` keeps the entry but skips connecting. |

Other options OpenCode accepts on a local server: `cwd` (working directory),
`environment` (object of variables — note the name, it is not `env`), and `timeout`
(milliseconds for fetching tools, default 5000). For a remote server: `url`,
`headers`, `oauth`, `timeout`.

Two shapes worth stating outright, because both are easy to get wrong:

- **`mcp.servers.dotloom-mcp` does not work.** `mcp` maps names to server entries
  directly. A `servers` key is read as a server literally named `servers` with no
  `type` and no `command`, and `dotloom-mcp` is never configured at all. The config is
  rejected against OpenCode's published JSON Schema.
- **`command` must be an array, not a string.** `"command": "npx -y dotloom-mcp"` does
  not split into a program and arguments.

## Transport note

OpenCode supports local and remote servers. This pack configures **local**, because that
is what this project can launch on its own. A remote entry would need a URL, and the only
HTTP endpoint this project has is `http://127.0.0.1:7331/mcp`, served by the desktop app
while it runs, on loopback. Start the desktop app instead and leave this entry `local`.

## If it does not connect

- **The server is missing from `opencode mcp list`.** The entry is under the wrong
  nesting (`mcp.servers.…` instead of `mcp.…`), or `command` is a string instead of an
  array, or the file is not where OpenCode reads it.
- **A 5-second startup timeout on the very first launch.** OpenCode's default `timeout`
  applies to fetching tools, and the first `npx -y dotloom-mcp` has to download the
  package first. Either set `"timeout": 60000` on the entry, or warm the cache once in a
  terminal with `npx -y dotloom-mcp --version`.
- **`ENOENT` on Windows.** Use the `.windows.json` file. A bare `npx` is not an
  executable Windows can launch without a shell, and Node refuses to run `npx.cmd`
  directly for the same reason.
