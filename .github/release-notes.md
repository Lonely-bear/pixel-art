## Installing

| Platform | File |
| --- | --- |
| Windows | `dotloom-mcp-*-x64-setup.exe` — installs to your user profile, no admin needed |
| Windows, no install | `dotloom-mcp-*-x64-portable.exe` — run it from anywhere, including a USB stick |
| macOS, Apple Silicon | `dotloom-mcp-*-arm64.dmg` |
| macOS, Intel | `dotloom-mcp-*-x64.dmg` |
| Linux | `dotloom-mcp-*-x86_64.AppImage` — run it, nothing to install; or `dotloom-mcp-*-amd64.deb` on Debian/Ubuntu |

Nothing else is required. The CLI and the MCP server are built into the same
binary as the editor, so installing the app is the whole installation.

## First launch on macOS

This build is **not** signed with an Apple Developer ID, so Gatekeeper blocks it
the first time. Either right-click `dotloom-mcp.app` and choose **Open**, or run:

```
xattr -dr com.apple.quarantine /Applications/dotloom-mcp.app
```

Windows builds are unsigned too, so SmartScreen warns once; choose
**More info → Run anyway**. Adding code signing certificates later does not
require a change to the app itself.
