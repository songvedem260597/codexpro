<p align="center">
  <img src="docs/favicon.svg" width="72" height="72" alt="CodexPro logo">
</p>

<h1 align="center">CodexPro</h1>

<p align="center">
  Give ChatGPT local coding tools for repos you explicitly allow.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/codexpro"><img alt="npm" src="https://img.shields.io/npm/v/codexpro?style=flat-square"></a>
  <a href="https://github.com/rebel0789/codexpro/actions"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/rebel0789/codexpro/ci.yml?branch=main&style=flat-square"></a>
  <a href="https://github.com/rebel0789/codexpro/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/rebel0789/codexpro?style=flat-square"></a>
  <a href="https://rebel0789.github.io/codexpro/"><img alt="Website" src="https://img.shields.io/badge/site-GitHub%20Pages-67e8f9?style=flat-square"></a>
</p>

## What it is

CodexPro is a local MCP server. It connects **your ChatGPT session** to **your machine** and **repos you allow**.

ChatGPT can read, search, edit, review, verify, import attachments, and write handoff plans. It stays inside those roots.

It is not a hosted SaaS product, model proxy, quota bypass, account pool, or remote shell service.

## Install

Needs:

- Node.js 20+
- A ChatGPT account that can create custom MCP plugins with Developer Mode access
- One HTTPS route to your local machine when connecting ChatGPT from the web (tunnel or Tailscale Funnel)
- Playwright Chromium when using browser automation (`npx playwright install chromium`)

Install the CLI:

```bash
npm install -g codexpro
cd /path/to/your/repo
codexpro setup
```

## Connect in ChatGPT

1. `Settings -> Security and login` → turn **Developer mode** on (keep CSP enforcement on).
2. `Settings -> Plugins` → Plugins tab → **+** beside Search plugins.
3. Create a plugin named `CodexPro`.
4. Connection: **Server URL** → paste the URL CodexPro copied.
5. Authentication: **No Authentication / None** (change this if the form defaults to OAuth).

CodexPro auth is the token already in that URL. Do not share the URL.

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

If plugin creation fails, run `codexpro connection-test` and check whether ChatGPT requests reach the local server.

## What ChatGPT can do

With workspace write mode (the normal agent setup):

- read, search, and inspect the repo
- create files and edit with `create`, `write`, `edit`, or guarded `apply_patch`
- import ChatGPT attachments with `import_file`
- run allowlisted checks with `bash`
- open public sites or localhost, inspect rendered UI, interact with forms, and capture screenshots through Playwright
- review diffs with `show_changes`
- write plans under `.ai-bridge`
- export a context bundle for chats that cannot call tools

## Multiple projects

One CodexPro process can allow more than one repo:

```bash
codexpro settings set --project ~/code/web --project ~/code/api
codexpro settings show
codexpro start
```

Ask ChatGPT to `open_workspace` on an allowed project. `open_current_workspace` returns to the launch repo.

For two ChatGPT accounts or hard isolation, run two CodexPro processes on different ports and Server URLs.

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

## Commands

```bash
codexpro setup
codexpro start
codexpro start --root /path/to/repo
codexpro doctor
codexpro connection-test
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
codexpro start --headless
```

Opt-in tool cards:

```bash
CODEXPRO_TOOL_CARDS=1 codexpro start
```

## Public HTTPS options

ChatGPT web needs HTTPS:

```bash
codexpro start --tunnel cloudflare          # quick demo URL (changes)
codexpro ngrok --hostname your.ngrok-free.dev
codexpro stable --hostname codexpro.example.com --tunnel-name codexpro
codexpro tailscale --hostname your-device.your-tailnet.ts.net
codexpro start --tunnel none                # local only
```

Keep a stable token for stable hostnames:

```bash
mkdir -p ~/.codexpro
openssl rand -hex 32 > ~/.codexpro/http-token
chmod 600 ~/.codexpro/http-token
```

Prefer `Authorization: Bearer <token>` when the client supports headers. The `?codexpro_token=` query form is a personal compatibility fallback.

## Safety defaults

- Public tunnels require a CodexPro HTTP token (min 24 bytes)
- Writes stay hidden unless write mode is `workspace`
- Safe bash is the default
- Blocked paths cover `.env`, keys, `.git`, build caches, and similar
- Attachment import only accepts ChatGPT Apps SDK file objects from approved HTTPS hosts

Read [SECURITY.md](SECURITY.md) before exposing a tunnel.

## Update

```bash
npm install -g codexpro@latest
codexpro --version
```

Restart `codexpro start` after updating. Saved profiles under `~/.codexpro` stay in place.

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
codexpro execute-handoff --agent pi --yes
codexpro execute-handoff --agent opencode --subagents --yes
codexpro watch-handoff --agent opencode --subagents --yes
```

`--subagents` runs a verified OpenCode investigation phase before implementation. CodexPro requires a real `task` tool event, a real child session ID, an exportable read-only child session, and returned evidence before it marks delegation as successful. If any of those checks fail, execution falls back to the normal single-agent path and records the reason instead of claiming a subagent ran. For the current test phase, the total subagent-attempt cap is hard-limited to `1` per handoff. Even if a larger `--max-subagents` or `CODEXPRO_MAX_SUBAGENTS` value is supplied, CodexPro clamps it to `1`, so the repository Explore child consumes the only slot and additional scout delegation is skipped.

After the temporary one-subagent test cap is lifted, handoffs that mention APIs, SDKs, dependencies, providers, releases, upstream projects, or external documentation can also route a separate read-only `gemini-scout` child for external research. It discovers Gemini Flash models from the local OpenCode catalog, prefers candidates with a visible provider credential, performs a bounded live probe, injects the selected model only at runtime, and verifies from the exported child session that the exact model was actually used. If no Gemini Flash candidate is healthy, the scout records a fallback reason and the normal repository investigation/fixer continues. Set `CODEXPRO_GEMINI_SCOUT_MODEL` to prefer a specific locally available authenticated Gemini Flash model, and use `codexpro doctor --live-scout-check --model <working-parent-model>` for an end-to-end scout check.

For bounded autonomous correction, use `loop-handoff` without `--review-command`. CodexPro preserves the original task as an immutable audit target, lets the executor work, optionally runs the configured test command, then launches the independent read-only `codexpro-auditor`. A FAIL verdict must include actionable fixes; CodexPro writes those fixes into the next `current-plan.md` and runs another iteration. The task completes only after the audit returns PASS and executor/test failures have not invalidated that PASS. An external `--review-command` is still available as an override.

```bash
codexpro loop-handoff --agent opencode --model opencode/big-pickle --subagents --run-tests "npm test" --max-iters 3 --yes
```

```mermaid
flowchart LR
    CP[CodexPro assigns work] --> AG[Agent executes]
    AG --> QA[CodexPro audits result]
    QA --> D{Meets requirements?}
    D -->|No| CP
    D -->|Yes| DONE[Task complete]
```

`npm run audit:live` runs a real read-only OpenCode audit fixture and requires an exportable audit session. Use `--audit-model <provider/model>` or `CODEXPRO_AUDIT_MODEL` when the audit should use a different model from the executor.

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

### Desktop manager

The React + Electron manager shows CodexPro runtime/MCP/tunnel health, copies or rotates the private MCP URL, and inspects saved or added repositories through CodexPro MCP on macOS and Windows.

```bash
npm --prefix manager install
npm --prefix manager run dist:mac
npm --prefix manager run dist:win
```

Installers are generated under `manager/release/`.

### Chrome profile extension

Load the `chrome-extension` directory in each Chrome profile that should use CodexPro. The popup has two independent actions:

- **ACTIVE PROFILE NÀY** selects the one profile that `browser_control` may operate.
- **THÊM CODEXPRO VÀO CHATGPT** obtains the current private MCP URL from the loopback bridge, enables ChatGPT Developer mode when the account allows it, creates the app as **CodexPro** with **Server URL** and **No Auth**, opens a new chat, selects `@CodexPro`, calls `server_config`, and waits for `CodexPro READY`.

The private MCP URL is delivered only to the signed CodexPro extension origin and is not persisted by the extension. Each Chrome profile keeps its own installation result. ChatGPT plan, workspace role, or administrator restrictions can still prevent Developer mode from being enabled; the popup reports that condition instead of marking setup complete.

Useful release checks:

```bash
npm run release:check
```

Publish only from the CodexPro root:

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
- [Contributors](CONTRIBUTORS.md)
