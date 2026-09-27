<!--
  The shared half of every Release page: where to get the build, and what to do on
  first launch. The half that says what the release *is* is not here and must never
  be added here — it is generated from the `## [X.Y.Z]` section of CHANGELOG.md and
  CHANGELOG-ZH.md by scripts/release-notes.mjs, which the release workflow runs and
  which refuses to produce notes for a version the changelog does not describe.
-->

## Installing

| Platform | File |
| --- | --- |
| Windows | `dotloom-mcp-*-x64-setup.exe` — installs to your user profile, no admin needed |
| Windows, no install | `dotloom-mcp-*-x64-portable.exe` — run it from anywhere, including a USB stick |
| macOS, Apple Silicon | `dotloom-mcp-*-arm64.dmg` |
| macOS, Intel | `dotloom-mcp-*-x64.dmg` |
| Linux | `dotloom-mcp-*-x86_64.AppImage` — run it, nothing to install; or `dotloom-mcp-*-amd64.deb` on Debian/Ubuntu |

Nothing else is required. The MCP server is built into the same binary as the
editor, so installing the app is the whole installation. The `pixel` CLI is not
part of that binary — it comes from npm (`npm install -g dotloom-mcp`), and so does
the headless server for anyone who wants one without the editor.

## First launch on macOS

This build is **not** signed with an Apple Developer ID, so Gatekeeper blocks it
the first time. Either right-click `dotloom-mcp.app` and choose **Open**, or run:

```
xattr -dr com.apple.quarantine /Applications/dotloom-mcp.app
```

Windows builds are unsigned too, so SmartScreen warns once; choose
**More info → Run anyway**. Adding code signing certificates later does not
require a change to the app itself.
