# CodexPro Manager

Windows desktop dashboard for the local CodexPro MCP server.

## Features

- Scheduled Task, local MCP, public tunnel, and process health.
- Automatic background refresh every 10 seconds.
- Copy the current MCP Server URL or rotate the private token and generate a new URL.
- Start or restart the existing `CodexPro` Scheduled Task.
- Start CodexPro Manager automatically when the Windows user signs in; uninstall removes the startup entry.
- Discover CodexPro profile/runtime workspaces and add local projects.
- Inspect a project through the real CodexPro MCP `open_workspace` and `workspace_snapshot` tools.

## Development

```powershell
npm install
npm run dev
```

## Windows installer

From the repository root:

```powershell
npm run manager:dist
```

The NSIS installer is written to `manager/release/CodexPro-Manager-Setup-<version>.exe`.
