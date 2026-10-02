# Client configuration pack

Paste-ready configuration files for the four mainstream MCP clients. Every file here is
literal, valid, copyable — the point of this directory is that you can *diff* a config
change, not read about one in a prose fence.

The long-form guide that explains what these files mean is
[`docs/CLIENTS.md`](../docs/CLIENTS.md). [中文版](../docs/CLIENTS-ZH.md).

## What is in here

| Path | Copy to | Shape |
| --- | --- | --- |
| `claude/claude_desktop_config.json` | Claude Desktop — macOS, Linux | `mcpServers` |
| `claude/claude_desktop_config.windows.json` | Claude Desktop — Windows | `mcpServers` |
| `claude/claude-code.mcp.json` | Claude Code — project `.mcp.json` | `mcpServers` |
| `claude/claude-code.mcp.windows.json` | Claude Code — project `.mcp.json`, Windows | `mcpServers` |
| `cursor/mcp.json` | Cursor — global `~/.cursor/mcp.json` | `mcpServers` |
| `cursor/mcp.windows.json` | Cursor — global, Windows | `mcpServers` |
| `cursor/mcp.project.json` | Cursor — project `.cursor/mcp.json` | `mcpServers` |
| `opencode/opencode.json` | OpenCode — `opencode.json` / `opencode.jsonc` | `mcp.<name>` |
| `opencode/opencode.windows.json` | OpenCode — Windows | `mcp.<name>` |
| `windsurf/mcp_config.json` | Windsurf — `mcp_config.json` | `mcpServers` |
| `windsurf/mcp_config.windows.json` | Windsurf — Windows | `mcpServers` |

Per-client instructions, exact destination paths and troubleshooting are in each
client's own `README.md` in this directory.

## The three rules behind every file here

1. **The server key is `dotloom-mcp`.** That is the name your client shows in its UI. It
   is not the same thing as the name the server reports about itself — in the default
   mode that one is `dotloom-mcp-link`. Both are normal; see the guide.
2. **`npx -y dotloom-mcp` is the launch command.** `-y` accepts the licence prompt, so
   the first start does not stall waiting for a keypress. Nothing is installed globally.
3. **On Windows the launch command is `cmd` with `/c npx -y dotloom-mcp`,** not bare
   `npx` and not `npx.cmd`. Node has refused to execute `.cmd` shims without a shell
   since the CVE-2024-27980 fix, and a bare `npx` resolves to nothing executable on
   Windows. `cmd.exe` is a real executable, so it works whether or not your client
   spawns through a shell. Measured on Node 22.20.0 / Windows:

   | `command` | client spawns without a shell | client spawns with a shell |
   | --- | --- | --- |
   | `npx` | fails (`ENOENT`) | works |
   | `npx.cmd` | fails (`EINVAL`) | works |
   | `cmd` + `["/c", "npx", …]` | **works** | **works** |

## Pinning a version instead

`npx -y dotloom-mcp` resolves to the newest published release at every start, which is
usually what you want. To pin, replace the last argument:

```json
"args": ["-y", "dotloom-mcp@0.4.2"]
```

or, on Windows, `"args": ["/c", "npx", "-y", "dotloom-mcp@0.4.2"]`.
