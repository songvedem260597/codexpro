const { app } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_REPO = 'songvedem260597/codexpro';
const DEFAULT_RUNNER_NAME = 'codexpro-pc';
let watchdogTimer = null;
let starting = false;
let lastHiddenStart = null;

function runnerCandidates() {
  const candidates = [];
  if (process.env.GITHUB_ACTIONS_RUNNER_TEMPLATE) candidates.push(path.resolve(process.env.GITHUB_ACTIONS_RUNNER_TEMPLATE));
  if (process.platform === 'win32') {
    candidates.push('C:\\actions-runner-codexpro', 'C:\\actions-runner');
    try {
      for (const entry of fs.readdirSync('C:\\', { withFileTypes: true })) {
        if (entry.isDirectory() && /^actions-runner/i.test(entry.name)) candidates.push(path.join('C:\\', entry.name));
      }
    } catch {}
  }
  return [...new Set(candidates.map((item) => path.resolve(item)))];
}

function readRunner(root) {
  try {
    if (!fs.existsSync(path.join(root, 'run.cmd'))) return null;
    const raw = fs.readFileSync(path.join(root, '.runner'), 'utf8').replace(/^\uFEFF/, '');
    const data = JSON.parse(raw);
    const name = String(data.agentName || data.AgentName || data.name || '').trim() || path.basename(root);
    const githubUrl = String(data.gitHubUrl || data.GitHubUrl || data.githubUrl || '').trim();
    let repo = '';
    const match = githubUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/?$/i);
    if (match) repo = match[1].replace(/\.git$/i, '');
    return { root, name, repo };
  } catch {
    return null;
  }
}

function findDefaultRunner() {
  let fallback = null;
  for (const root of runnerCandidates()) {
    const runner = readRunner(root);
    if (!runner) continue;
    if (runner.repo.toLowerCase() === DEFAULT_REPO.toLowerCase()) return runner;
    if (runner.name.toLowerCase() === DEFAULT_RUNNER_NAME) fallback ||= runner;
    if (path.basename(root).toLowerCase() === 'actions-runner-codexpro') fallback ||= runner;
  }
  return fallback;
}

function inspectRunner(root) {
  if (process.platform !== 'win32') return { running: false, busy: false };
  const escaped = String(path.resolve(root)).replace(/'/g, "''");
  const script = [
    `$root = '${escaped}'`,
    "$prefix = $root.TrimEnd('\\') + '\\'",
    "$items = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^Runner\\.(Listener|Worker)(\\.exe)?$' })",
    "$matching = @($items | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) -or ($_.CommandLine -and $_.CommandLine.IndexOf($prefix, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) })",
    "$listener = @($matching | Where-Object { $_.Name -match '^Runner\\.Listener(\\.exe)?$' })",
    "$worker = @($matching | Where-Object { $_.Name -match '^Runner\\.Worker(\\.exe)?$' })",
    '[Console]::Out.Write((($listener.Count -gt 0).ToString().ToLower()) + "|" + (($worker.Count -gt 0).ToString().ToLower()))'
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10000
  });
  if (result.error || result.status !== 0) return { running: false, busy: false };
  const [runningText, busyText] = String(result.stdout || '').trim().split('|');
  return { running: runningText === 'true', busy: busyText === 'true' };
}

function appendAutoStartLog(root, message) {
  try {
    const dir = path.join(root, '_diag');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'GitHubActionsMonitor-AutoRunner.log'), `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {}
}

function launchHidden(runner) {
  if (starting) return false;
  starting = true;
  try {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', 'run.cmd'], {
      cwd: runner.root,
      env: { ...process.env, RUNNER_TRACKING_ID: '' },
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
    lastHiddenStart = Date.now();
    appendAutoStartLog(runner.root, `AUTO START hidden runner ${runner.name} pid=${child.pid}`);
    return true;
  } catch (error) {
    appendAutoStartLog(runner.root, `AUTO START failed: ${error?.message || error}`);
    return false;
  } finally {
    setTimeout(() => { starting = false; }, 2500);
  }
}

function ensureRunner() {
  const runner = findDefaultRunner();
  if (!runner) return;
  const state = inspectRunner(runner.root);
  if (state.running) return;
  if (lastHiddenStart && Date.now() - lastHiddenStart < 7000) return;
  launchHidden(runner);
}

app.whenReady().then(() => {
  setTimeout(ensureRunner, 700);
  watchdogTimer = setInterval(ensureRunner, 5000);
});

app.on('before-quit', () => {
  if (watchdogTimer) clearInterval(watchdogTimer);
});

require('./main-local-runner.js');
