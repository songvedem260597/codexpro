# CodexPro Manager

Desktop dashboard for the local CodexPro MCP server on macOS and Windows.

## Features

- CodexPro runtime, local MCP, public tunnel, and process health.
- Automatic background refresh every 10 seconds.
- Copy the current MCP Server URL or rotate the private token and generate a new URL.
- Start or restart CodexPro while preserving the active workspace and tunnel configuration.
- Show desktop login/autostart state.
- Discover CodexPro profile/runtime workspaces and add local projects.
- Inspect a project through the real CodexPro MCP `open_workspace` and `workspace_snapshot` tools.

## Development

```bash
npm install
npm run dev
```

## macOS installer

From the repository root:

```bash
npm --prefix manager run dist:mac
```

The DMG and ZIP are written to `manager/release/`.

## Windows installer

From the repository root:

```powershell
npm --prefix manager run dist:win
```

The NSIS installer is written to `manager/release/`.
