import process from 'node:process';

export function usage() {
  console.log(`CodexPro easy launcher

Usage:
  npm install -g codexpro
  codexpro setup
  codexpro start
  codexpro start --root /path/to/repo
  codexpro settings
  codexpro doctor
  codexpro connection-test --root /path/to/repo
  codexpro inspect --root /path/to/repo [--json]
  codexpro review --root /path/to/repo [--staged] [--path src/file.ts] [--json]
  codexpro execute-handoff --agent opencode --model provider/model
  codexpro watch-handoff --agent opencode --model provider/model
  codexpro loop-handoff --agent opencode --model provider/model --subagents --run-tests "npm test" --max-iters 3 --yes
  codexpro --root /path/to/repo
  codexpro ngrok --hostname your-domain.ngrok-free.dev
  codexpro tailscale --hostname your-device.your-tailnet.ts.net
  codexpro stable --hostname codexpro.example.com --tunnel-name codexpro
  codexpro pro-bundle --root /path/to/repo --copy
  codexpro pro-apply --root /path/to/repo --file plan.md
  codexpro install-cloudflared
  npm run connect -- --root /path/to/repo
  node scripts/codexpro.mjs --root /path/to/repo --tunnel cloudflare

Options:
  --root <dir>              Workspace root. Default: current directory.
  --from-root <dir>         Copy saved settings from another workspace with settings use.
  --project <dir>           Additional allowed project. settings set saves it. Can be repeated.
  --clear-projects          Remove saved additional projects with settings set.
  --allow-root <dir>        Additional allowed root for this launch. Can be repeated.
  --allow-home              Allow opening any workspace under your home directory.
  --mode <agent|handoff|pro>
                             Default: agent.
                             agent = ChatGPT can read, write/edit/apply_patch files, search, and run safe bash.
                             handoff = ChatGPT writes .ai-bridge plans for a local implementation agent.
                             pro = export context for models that cannot call MCP tools.
  --agent                   Shortcut for --mode agent.
  --handoff                 Shortcut for --mode handoff.
  --pro-planning            Shortcut for --mode pro.
  --host <host>             Local bind host. Default: 127.0.0.1.
  --port <port>             Local port. Default: 8787.
  --bash <off|safe|full>    Bash mode. Default: safe.
  --no-bash                 Shortcut for --bash off.
  --bash-transcript <compact|full>
                             Chat transcript for bash results. Default: compact.
                             full prints raw stdout/stderr in chat.
  --full-bash-transcript    Shortcut for --bash-transcript full.
  --bash-session <id>       Local bash session label exposed to ChatGPT.
  --require-bash-session    Require bash calls to include matching session_id.
  --codex-sessions <off|metadata|read>
                             Opt in to read local ~/.codex session history.
                             metadata lists ids/titles/cwd; read allows bounded transcript reads.
  --codex-dir <dir>          Codex config/session directory. Default: ~/.codex.
  --write <off|handoff|workspace>
                             Write mode. Default: workspace in agent mode, handoff otherwise.
                             handoff = no generic write/edit/apply_patch tools; handoff tools write bounded .ai-bridge files.
  --tool-mode <minimal|standard|full>
                             Tool surface exposed to ChatGPT. Default: standard.
                             minimal = config/self-test plus open/read/write/edit/apply_patch/bash/show_changes.
                             full = expose every compatibility and advanced tool.
  --browser-control          Expose browser_control for the dedicated loopback Chrome instance.
  --browser-debug-url <url>  Chrome DevTools origin. Default: http://127.0.0.1:9223.
  --widget-domain <origin>   Dedicated HTTPS origin for ChatGPT widget iframes.
                             Required for app submission. Default: https://rebel0789.github.io.
  --tool-cards <on|off>      Opt in to ChatGPT widget metadata on tool descriptors. Default: off.
  --tunnel <none|cloudflare|cloudflare-named|ngrok|tailscale>
                             Expose local MCP. Default: cloudflare.
                             cloudflare = quick tunnel with a new URL each restart.
                             cloudflare-named = stable hostname using a named tunnel.
                             ngrok = stable ngrok dev-domain endpoint using --hostname/--url.
                             tailscale = Tailscale Funnel using --hostname/--url.
  --stable                  Shortcut for --tunnel cloudflare-named.
  --hostname <host>          Stable public hostname for cloudflare-named, ngrok, or tailscale.
  --url <url>                Alias for --hostname in stable URL modes.
  --tunnel-name <name>       Existing Cloudflare named tunnel to run.
  --cloudflare-token <token> Cloudflare Tunnel token for this launch only; not saved by settings set.
  --cloudflare-token-file <path>
                             File containing a Cloudflare Tunnel token.
  --cloudflare-config <path> cloudflared YAML config for a named tunnel.
  --token <token>           Bearer token for HTTP MCP. Auto-generated for tunnels.
  --token-file <path>       Read the HTTP MCP bearer token from a mode-0600 file.
  --cloudflared <path>      cloudflared executable. Default: PATH, then ~/.codexpro/bin.
  --ngrok <path>            ngrok executable. Default: PATH.
  --ngrok-config <path>     Optional ngrok config file path.
  --tailscale <path>        tailscale executable. Default: PATH.
  --no-profile              Do not load a saved ~/.codexpro workspace profile.
  --save-config             Save setup choices for this workspace when using setup.
  --no-save-config          Do not save setup choices when using setup.
  --yes                     Confirm settings delete/reset without prompting.
  --install-cloudflared     Install/reinstall cloudflared into ~/.codexpro/bin.
  --no-install-cloudflared  Do not auto-install cloudflared when missing.
  --copy-url                Copy the ChatGPT Server URL to clipboard. Default for public HTTPS URLs.
  --no-copy-url             Do not copy the Server URL.
  --open-chatgpt            Open ChatGPT connector settings after the URL is ready.
  --headless                Run without prompts, clipboard, browser opening, or the control panel.
  --no-auth                 Disable bearer-token auth. Only allowed with --tunnel none.
  --log-requests            Print redacted HTTP request and tool-call logs from the local MCP server.
  connection-test           Start a read-only connector with request logging and no bash or tool cards.
  --print-env               Print the environment used to launch the server.
  --version, -v             Print the CodexPro version.
  --help                    Show this message.

Execute handoff options:
  codexpro execute-handoff --agent opencode --model provider/model
  codexpro execute-handoff --agent pi --model provider/model
  codexpro execute-handoff --agent custom --command "my-agent --task-file {{plan_file}}"
  --agent <opencode|pi|codex|custom>
                             Local implementation agent adapter.
  --model <provider/model>  Optional model name passed to the adapter.
  --subagents               For OpenCode, require real verified read-only child execution.
  --max-subagents <n>       Requested subagent cap. During the current test phase it is hard-capped to 1.
  --command <template>      Custom command template. Supports {{model}}, {{plan_file}}, {{plan_text}}, {{root}}.
  --dry-run                 Print the command that would run without executing it.
  --timeout-ms <ms>         Execution timeout. Default: 600000.
  --max-output-bytes <n>    Max stdout/stderr excerpt bytes per stream. Default: 120000.
  --context-dir <dir>       Handoff directory. Default: .ai-bridge.
  --yes                     Run without interactive confirmation.

Watch handoff options:
  codexpro watch-handoff --agent opencode --model provider/model
  codexpro watch-handoff --agent pi --model provider/model
  codexpro watch-handoff --agent custom --command "my-agent --task-file {{plan_file}}"
  --once                    Exit after checking/running one new plan.
  --poll-interval-ms <ms>   Poll interval. Default: 2000.
  --debounce-ms <ms>        Wait for plan file stability. Default: 500.
  --state-file <path>       Watch state file. Default: .ai-bridge/watch-handoff-state.json.
  --yes                     Start automatic local execution without startup confirmation.

Loop handoff options:
  codexpro loop-handoff --agent opencode --model provider/model --subagents --run-tests "npm test" --yes
  --audit-model <provider/model>
                             Optional OpenCode model for CodexPro's independent read-only audit. Defaults to the executor model when available.
  --review-command <template>
                             Optional external reviewer override. If omitted, CodexPro runs its built-in read-only auditor and writes follow-up plans on FAIL.
                             External reviewers should print CODEXPRO_REVIEW=PASS or CODEXPRO_REVIEW=FAIL and update current-plan.md on FAIL.
  --max-iters <n>           Maximum execute/audit iterations. Default: 3.
  --run-tests <template>    Optional local verification command before audit.
  --allow-implicit-review-verdict
                             Infer PASS/FAIL from reviewer exit code and plan changes when no CODEXPRO_REVIEW line is printed.
  --allow-review-pass-on-failure
                             Let explicit reviewer PASS override a failed executor or failed test command.
  --require-clean-git-start Refuse to start unless git status is clean.
  --stop-if-no-files-changed
                             Stop if an executor iteration produces no git diff.
  --stop-if-same-diff       Stop if an executor iteration repeats the previous diff.
  --require-human-confirmation
                             Ask before running an audit-generated follow-up plan.
  --dry-run                 Print executor/audit/test commands without executing them.
  --yes                     Start the local loop without startup confirmation.

Default agent mode:
  codexpro start --root /path/to/repo

Guided setup:
  codexpro setup

Workspace settings:
  codexpro settings
  codexpro settings show
  codexpro settings list
  codexpro settings set --tunnel ngrok --hostname your-domain.ngrok-free.dev
  codexpro settings set --project /path/to/another/repo
  codexpro settings set --clear-projects
  codexpro settings use
  codexpro settings delete --yes

Preflight diagnostics:
  codexpro doctor
  codexpro doctor --live-agent-check --model opencode/big-pickle
  codexpro doctor --live-subagent-check --model opencode/big-pickle
  codexpro doctor --live-scout-check --model opencode/big-pickle
  --live-agent-check        Make one tiny OpenCode model call to verify provider/model readiness.
  --live-subagent-check     Run one read-only OpenCode Task delegation and require child-session evidence.
  --live-scout-check        Probe the best authenticated Gemini Flash candidate and, if healthy, require a real gemini-scout child session.

Ngrok stable URL mode:
  codexpro ngrok --root /path/to/repo --hostname your-domain.ngrok-free.dev

Tailscale Funnel mode:
  codexpro tailscale --root /path/to/repo --hostname your-device.your-tailnet.ts.net

Planning-only handoff mode:
  codexpro start --root /path/to/repo --mode handoff

Execute a local handoff after ChatGPT writes .ai-bridge/current-plan.md:
  codexpro execute-handoff --agent opencode --model provider/model
  codexpro execute-handoff --agent pi --model provider/model
  codexpro execute-handoff --agent custom --command "node ./agent.js --task-file {{plan_file}}" --yes

Watch for new handoff plans and execute them locally:
  codexpro watch-handoff --agent opencode --model provider/model --yes
  codexpro watch-handoff --agent custom --command "node ./agent.js --task-file {{plan_file}}" --yes

Run a bounded local execute/audit loop:
  codexpro loop-handoff --agent opencode --model provider/model --subagents --run-tests "npm test" --max-iters 3 --yes

Stable URL mode after one-time Cloudflare tunnel setup:
  codexpro stable --root /path/to/repo --hostname codexpro.example.com --tunnel-name codexpro
`);
}

const colorEnabled = process.stdout.isTTY && !process.env.NO_COLOR;
const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m'
};

export function paint(style, text) {
  if (!colorEnabled) return text;
  return `${ansi[style] ?? ''}${text}${ansi.reset}`;
}

export function termWidth(max = 78) {
  return Math.max(56, Math.min(max, process.stdout.columns || max));
}

export function divider(label = '') {
  const width = termWidth();
  if (!label) return paint('dim', '-'.repeat(width));
  const text = ` ${label} `;
  return paint('dim', `${text}${'-'.repeat(Math.max(0, width - text.length))}`);
}

export function printBox(title, lines) {
  const width = termWidth();
  const inner = width - 4;
  console.log(divider(title));
  for (const line of lines) {
    const chunks = wrapLine(line, inner);
    for (const chunk of chunks) console.log(`| ${chunk.padEnd(inner)} |`);
  }
  console.log(divider());
}

export function wrapLine(text, width) {
  if (text.length <= width) return [text];
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current) current = word;
    else if (`${current} ${word}`.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function labelValue(label, value) {
  return `${label.padEnd(12)} ${value}`;
}

export function statusLine(status, detail = '') {
  const marker = status === 'ok' ? paint('green', 'OK') : status === 'warn' ? paint('yellow', 'WARN') : paint('cyan', '..');
  console.log(`${marker} ${detail}`);
}
