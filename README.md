<p align="center">
  <img src="docs/favicon.svg" width="72" height="72" alt="CodexPro logo">
</p>

<h1 align="center">CodexPro</h1>

<p align="center">
  Local coding tools for ChatGPT, scoped to explicitly allowed projects.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/codexpro"><img alt="npm" src="https://img.shields.io/npm/v/codexpro?style=flat-square"></a>
  <a href="https://github.com/rebel0789/codexpro/actions"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/rebel0789/codexpro/ci.yml?branch=main&style=flat-square"></a>
  <a href="https://github.com/rebel0789/codexpro/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/rebel0789/codexpro?style=flat-square"></a>
  <a href="https://rebel0789.github.io/codexpro/"><img alt="Website" src="https://img.shields.io/badge/site-GitHub%20Pages-67e8f9?style=flat-square"></a>
</p>

## Install

Requirements:

- Node.js 20+
- A ChatGPT account with Apps / Developer Mode access
- One HTTPS route to your local machine when connecting ChatGPT from the web
- Playwright Chromium when using browser automation (`npx playwright install chromium`)

Install the CLI:

```bash
npm install -g codexpro
```

Run setup inside the repo you want ChatGPT to work on:

```bash
cd /path/to/your/repo
codexpro setup
```

CodexPro prints and copies the Server URL. In ChatGPT, open:

```text
Settings -> Security and login -> Developer mode: on
Settings -> Plugins -> Plugins tab -> + (beside Search plugins)
```

This opens **New Plugin**. Give it a name such as `CodexPro`, paste the Server URL in the **Server URL** connection option, then choose `Authentication: No Authentication / None`. The form may initially show OAuth; change it before creating the plugin. CodexPro uses its own URL token.

Optional multi-worker tracking can append `codexpro_worker_id=<stable-worker-id>` to the Server URL. Authenticated `/healthz` responses then include `mcpSessions.workerConnections` with recent and active sessions grouped by that marker. The marker is an identity label, not an authentication credential; keep `codexpro_token` enabled.

Role-bound sessions retain the long `CODEXPRO_HTTP_SESSION_TTL_MS`. Sessions without a worker marker use the separate `CODEXPRO_MAX_UNATTRIBUTED_HTTP_SESSIONS` pool and the shorter `CODEXPRO_UNATTRIBUTED_HTTP_SESSION_TTL_MS`, so repeated generic connection probes cannot fill the transport table or displace Worker sessions.

For the CodexPro Multi-Agent P0 bridge, configure both `CODEXPRO_CONTROL_PLANE_URL` and `CODEXPRO_CONTROL_PLANE_TOKEN_FILE`. The connector HMAC-signs worker mutations with the marker-bound worker ID, route, exact body, timestamp, and one-time nonce. Control tools are not exposed if the signing token is absent.

All role-bound ChatGPT profiles may name the plugin `CodexPro`. A native Scheduled Task can contain only `@CodexPro`: the server instructions direct the model to call `worker_cycle_start` once. That single entrypoint automatically acknowledges the current governance hash, records signed `STARTED` and `ACKED` receipts, atomically claims the next role-compatible task, and returns the exact worktree and Task Capsule. An idle cycle omits `taskId` and stops cleanly; it verifies schedule health without creating fake work or Gate A evidence. `COMPLETED` remains task-bound and requires delivery, lease, attempt, checkpoint, and review correlation.

### Current Plugins UI

| Open Plugins and click `+` | Complete the New Plugin form |
| --- | --- |
| ![Open Plugins and click the plus button](docs/images/chatgpt-plugins-add.png) | ![Complete the New Plugin form](docs/images/chatgpt-plugin-details.png) |

Daily use from the same repo:

```bash
codexpro start
```

## What It Does

CodexPro starts a local MCP server for the current workspace. ChatGPT can then:

- read files and inspect the repo
- search code
- make scoped edits with `write`, `edit`, or guarded `apply_patch`
- run safe verification commands through `bash`
- open public sites or localhost, inspect rendered UI, interact with forms, and capture screenshots through Playwright
- review changed files with `show_changes`
- write handoff plans under `.ai-bridge`
- export a selected context bundle for model surfaces that cannot call tools

CodexPro is not a hosted service, model proxy, quota bypass, account pool, or OS sandbox.
It connects your own ChatGPT session to your own local repo through the official Developer Mode / MCP app path.

## Multiple Projects

Keep one launch project and explicitly allow additional projects:

```bash
codexpro settings set --project ~/code/web --project ~/code/api
codexpro start
```

`open_workspace` selects an allowed project for the current MCP session. After that, tools can omit `workspace_id` and operate on the selected project. `open_current_workspace` returns the session to the launch project.

Selections are session-local, so one MCP session switching projects does not change another session. Whether separate ChatGPT conversations receive separate MCP sessions is controlled by the client. Keep using separate CodexPro processes when you need guaranteed process isolation, different permissions, or different public endpoints.

Only the launch project and projects explicitly added with `--project` can be opened. Remove saved additional projects with:

```bash
codexpro settings set --clear-projects
```

## Relaunch Coding Experience

- `view_image` sends PNG, JPEG, GIF, and WebP files as native MCP image content, so ChatGPT can inspect screenshots and visual assets without a separate upload.
- `read` returns a SHA-256. Pass it as `expected_sha256` to `write` or `edit` when multiple sessions may touch the same file. A stale edit fails instead of silently overwriting newer work.
- New files use same-directory atomic replacement. Existing files are updated in place so ownership, ACLs, extended attributes, and hard links remain attached; a machine or process crash during that write can leave partial content.
- `codexpro start --headless` runs without prompts, clipboard access, browser opening, or terminal controls. It prints one `CODEXPRO_READY` line, publishes the supervised runtime PID in local status, cleans up on signals, and exits nonzero if the HTTP runtime dies unexpectedly.

## Browser Automation

CodexPro standard and full tool modes expose server-side Playwright tools for rendered UI testing:

- `browser_open` opens a public HTTP(S) URL or localhost page.
- `browser_snapshot` returns bounded visible text, console messages, and stable refs for interactive elements.
- `browser_click`, `browser_type`, and `browser_select` interact with exactly one ref or CSS selector.
- `browser_screenshot` returns a native PNG image to the MCP client.
- `browser_close` closes Chromium; idle browser sessions also close automatically after ten minutes.

Browser page state is shared across MCP transport reconnects within one CodexPro process, so a later `browser_click` or `browser_type` continues the page opened by `browser_open` even when the client creates a fresh transport session. One CodexPro process has one active browser page; use separate CodexPro processes/endpoints when multiple clients need isolated browser sessions.

Install the matching Chromium runtime once on the CodexPro host:

```bash
npx playwright install chromium
```

Chromium runs headless by default. Set `CODEXPRO_BROWSER_HEADLESS=0` before starting CodexPro when a visible browser window is useful. Browser automation allows the public web and loopback localhost destinations, while blocking file URLs, embedded URL credentials, cloud metadata, and non-loopback private-network destinations.

## Repository Analysis

CodexPro builds a bounded repository map from local manifests, source declarations, imports, tests, and Git state. It provides:

- `inspect_workspace` for languages, project types, entrypoints, areas, symbols, and relationships
- optional structured `search` intents: `text`, `symbol`, `references`, and `impact`
- affected-area, risk, related-test, and focused-command recommendations in `show_changes`
- matching read-only terminal views:

```bash
codexpro inspect --root /path/to/repo
codexpro review --root /path/to/repo
codexpro inspect --root /path/to/repo --json
```

The analysis is deterministic and local. It uses confidence labels instead of claiming compiler precision, stays within configured file/byte/symbol limits, and falls back to normal lexical search and Git review when analysis is incomplete.

Set `CODEXPRO_ANALYSIS=0` to disable repository analysis without changing the rest of the connector.

## Normal Commands

```bash
codexpro setup
codexpro start
codexpro start --root /path/to/repo
codexpro doctor
codexpro connection-test --root /path/to/repo
codexpro settings
codexpro inspect
codexpro review
```

Useful modes:

```bash
codexpro start --no-bash
codexpro start --tool-mode minimal
codexpro start --tool-mode full
codexpro start --mode handoff
codexpro start --mode pro
```

If ChatGPT cannot create the plugin, run `codexpro connection-test`. It keeps
the normal read, tree, search, and skill tools, disables writes, bash, and tool
cards, and logs whether a request reached the local MCP endpoint.

Tool cards are opt in:

```bash
CODEXPRO_TOOL_CARDS=1 codexpro start
```

The v10 cards cover selected workspace, analysis, change, Git, handoff, and
terminal results. Reads and searches stay in normal chat output. After updating
the connector, refresh its ChatGPT plugin connection once so it loads the new
widget resource.

## Public URL Options

ChatGPT web needs a public HTTPS Server URL. CodexPro supports:

- Fast demo URL: `codexpro start --tunnel cloudflare`
- Stable ngrok domain: `codexpro ngrok --hostname your-domain.ngrok-free.dev`
- Stable Cloudflare route: `codexpro stable --hostname codexpro.example.com --tunnel-name codexpro`
- Tailscale Funnel: `codexpro tailscale --hostname your-device.your-tailnet.ts.net`
- Local only: `codexpro start --tunnel none`

Cloudflare quick tunnels honor `HTTPS_PROXY`, `ALL_PROXY`, or `HTTP_PROXY` when those env vars are set.

Stable modes should use a stable CodexPro token:

```bash
mkdir -p ~/.codexpro
openssl rand -hex 32 > ~/.codexpro/http-token
chmod 600 ~/.codexpro/http-token

codexpro tailscale \
  --hostname your-device.your-tailnet.ts.net \
  --token-file ~/.codexpro/http-token
```

Tailscale Funnel must already be allowed for your tailnet. It requires MagicDNS, HTTPS certificates, and Funnel policy support. CodexPro runs:

```bash
tailscale funnel http://127.0.0.1:8787
```

Then ChatGPT uses:

```text
https://your-device.your-tailnet.ts.net/mcp?codexpro_token=keep-this-token-stable
```

The URL token is a personal-use compatibility fallback for connector forms that cannot set
headers. Prefer `Authorization: Bearer <token>` when the MCP client supports
custom headers. Shared or multi-user production deployments require OAuth or
header authentication. CodexPro requires at least 24 token bytes, removes token
parameters from the local browser address after onboarding, and sends
no-store/no-referrer headers. Never share or commit the connector URL.

## Safety Defaults

- Public tunnel mode requires a CodexPro HTTP token.
- HTTP tokens shorter than 24 bytes are rejected and failed guesses are rate-limited per client address.
- Generic writes are hidden unless `CODEXPRO_WRITE_MODE=workspace`.
- Safe bash blocks broad shell patterns and secret/build/cache paths.
- Safe mode permits explicit-file `git add`, hook-disabled unsigned `git commit -m`, and option-free `git push origin <branch>` for verified local branches and HTTPS origins; broad staging, force, deleting, tag, and alternate-remote pushes remain blocked.
- `apply_patch` is workspace-scoped and rejects blocked paths, symlink patches, and secret-looking patch content.
- `show_changes` keeps a review checkpoint so repeated unchanged reviews collapse.
- Tool-card metadata is off unless `CODEXPRO_TOOL_CARDS=1`.

Read [SECURITY.md](SECURITY.md) before exposing CodexPro through any tunnel.

## RAM And ChatGPT Memory

CodexPro can reduce what it sends to ChatGPT. Current local fixes:

- binary-file checks scan with a reusable 64 KiB buffer instead of allocating the whole file
- ChatGPT tool-card structured payloads are compacted only for card output, not for normal tool data
- bash chat transcripts stay compact by default

That helps avoid oversized MCP/card payloads. It does not force Chrome, ChatGPT, or an old browser iframe to release memory that the client already holds. If the browser tab has already grown, reload the ChatGPT page or restart the browser.

## Repo Context

CodexPro uses explicit files, not hidden chat memory:

```text
AGENTS.md
.ai-bridge/current-plan.md
.ai-bridge/agent-status.md
.ai-bridge/decisions.md
.ai-bridge/open-questions.md
.ai-bridge/execution-log.jsonl
```

For non-tool model surfaces:

```bash
codexpro start --mode pro
```

Or from a local checkout:

```bash
codexpro pro-bundle --root /path/to/repo --copy
codexpro pro-apply --root /path/to/repo --file plan.md
```

## Handoff

ChatGPT can write a plan without executing a local agent:

```bash
codexpro start --mode handoff
```

Then you run execution locally:

```bash
codexpro execute-handoff --agent codex --yes
codexpro watch-handoff --agent codex --yes
```

`handoff_to_agent` is planning-only over MCP. CodexPro does not expose arbitrary local agent execution as a remote ChatGPT tool.

## Troubleshooting

Run:

```bash
codexpro doctor
```

Common fixes:

- Quick tunnel URL changed: rerun `codexpro start` and update the ChatGPT app Server URL.
- Stable URL does not respond: check the tunnel provider first, then the CodexPro token.
- ChatGPT cannot call tools in one model/chat: switch to a ChatGPT surface that supports Developer Mode app actions.
- Local port is busy: start another repo with `--port 8788`.
- Tool list looks stale: create a new ChatGPT app entry or change the connector URL token.
- Windows Scheduled Task stopped after sleep, restart, or a process exit: run `npm run windows:recover`. This preserves existing triggers and adds one `IgnoreNew` recovery attempt every minute without starting a watchdog process.

## Development

```bash
npm install
npm run build
npm run smoke
npm run stress
```

### Windows desktop manager

The React + Electron manager shows Scheduled Task/MCP/tunnel health, copies or rotates the private MCP URL, and inspects saved or added repositories through CodexPro MCP. Build its installable Windows executable with:

```powershell
npm --prefix manager install
npm run manager:dist
```

The installer is generated under `manager/release/`.

Useful release checks:

```bash
npm run release:check
git diff --check
```

Release only from the CodexPro project root. Do not use `npm --prefix` with
`npm pack` or `npm publish`: npm packs the current directory in that case.
The release scripts verify the root, package identity, canonical repository,
and tarball before publishing:

```bash
cd /path/to/codexpro
npm run release:publish
```

## Docs

- [Website](https://rebel0789.github.io/codexpro/)
- [FAQ](FAQ.md)
- [Security](SECURITY.md)
- [Stable URL guide](DOMAIN_SETUP.md)
- [Changelog](CHANGELOG.md)
