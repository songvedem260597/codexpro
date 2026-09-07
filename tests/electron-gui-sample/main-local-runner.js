const { app, BrowserWindow, ipcMain } = require('electron');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_REPO = 'songvedem260597/codexpro';

function normalizeRepo(value) {
  const repo = String(value || DEFAULT_REPO).trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Repository must look like owner/name.');
  return repo;
}

function monitorDataRoot() {
  const localAppData = process.env.LOCALAPPDATA || app.getPath('userData');
  return path.join(localAppData, 'GitHubActionsMonitorData');
}

function tokenFromInput(input) {
  return String(input || '').trim() || process.env.CODEXPRO_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '';
}

function configuredRunnerCandidates(repo) {
  const repoName = normalizeRepo(repo).split('/')[1];
  const candidates = [];
  if (process.env.GITHUB_ACTIONS_RUNNER_TEMPLATE) candidates.push(path.resolve(process.env.GITHUB_ACTIONS_RUNNER_TEMPLATE));
  if (process.platform === 'win32') {
    candidates.push(`C:\\actions-runner-${repoName}`, 'C:\\actions-runner-codexpro', 'C:\\actions-runner');
    try {
      for (const entry of fs.readdirSync('C:\\', { withFileTypes: true })) {
        if (entry.isDirectory() && /^actions-runner/i.test(entry.name)) candidates.push(path.join('C:\\', entry.name));
      }
    } catch {}
  }
  const managedRoot = path.join(monitorDataRoot(), 'runners');
  try {
    for (const entry of fs.readdirSync(managedRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(managedRoot, entry.name));
    }
  } catch {}
  return [...new Set(candidates.map((item) => path.resolve(item)))];
}

function readConfiguredRunner(root) {
  try {
    const file = path.join(root, '.runner');
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const data = JSON.parse(raw);
    const runnerName = String(data.agentName || data.AgentName || data.name || '').trim() || path.basename(root);
    const githubUrl = String(data.gitHubUrl || data.GitHubUrl || data.githubUrl || '').trim();
    let repo = '';
    const match = githubUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/?$/i);
    if (match) repo = match[1].replace(/\.git$/i, '');
    return { root: path.resolve(root), runnerName, repo, githubUrl };
  } catch {
    return null;
  }
}

function findLocalRunner(repo) {
  const expected = normalizeRepo(repo).toLowerCase();
  const repoName = expected.split('/')[1];
  const candidates = configuredRunnerCandidates(repo);
  let basenameFallback = null;
  let codexFallback = null;

  for (const root of candidates) {
    if (!fs.existsSync(path.join(root, 'run.cmd'))) continue;
    const configured = readConfiguredRunner(root) || {
      root: path.resolve(root),
      runnerName: path.basename(root),
      repo: '',
      githubUrl: ''
    };
    const base = path.basename(root).toLowerCase();
    if (configured.repo && configured.repo.toLowerCase() === expected) return configured;
    if (base === `actions-runner-${repoName}`) basenameFallback ||= configured;
    if (expected === DEFAULT_REPO.toLowerCase() && base === 'actions-runner-codexpro') codexFallback ||= configured;
    if (expected === DEFAULT_REPO.toLowerCase() && String(configured.runnerName).toLowerCase() === 'codexpro-pc') codexFallback ||= configured;
  }

  return basenameFallback || codexFallback || null;
}

function inspectRunnerProcess(root) {
  if (process.platform !== 'win32') return { running: false, busy: false, listenerPid: null, workerPids: [] };
  const escaped = String(path.resolve(root)).replace(/'/g, "''");
  const script = [
    `$root = '${escaped}'`,
    "$prefix = $root.TrimEnd('\\') + '\\'",
    "$items = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^Runner\\.(Listener|Worker)(\\.exe)?$' })",
    "$matching = @($items | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) -or ($_.CommandLine -and $_.CommandLine.IndexOf($prefix, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) })",
    "$listener = @($matching | Where-Object { $_.Name -match '^Runner\\.Listener(\\.exe)?$' })",
    "$worker = @($matching | Where-Object { $_.Name -match '^Runner\\.Worker(\\.exe)?$' })",
    '$listenerPid = if ($listener.Count -gt 0) { $listener[0].ProcessId } else { 0 }',
    '$workerPids = @($worker | ForEach-Object { $_.ProcessId }) -join ","',
    '[Console]::Out.Write((($listener.Count -gt 0).ToString().ToLower()) + "|" + (($worker.Count -gt 0).ToString().ToLower()) + "|" + $listenerPid + "|" + $workerPids)'
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10000
  });
  if (result.error || result.status !== 0) return { running: false, busy: false, listenerPid: null, workerPids: [] };
  const [runningText, busyText, pidText, workersText = ''] = String(result.stdout || '').trim().split('|');
  return {
    running: runningText === 'true',
    busy: busyText === 'true',
    listenerPid: Number(pidText) || null,
    workerPids: workersText.split(',').map(Number).filter(Boolean)
  };
}

function cleanDiagLine(line) {
  let value = String(line || '').trim();
  if (!value) return '';
  value = value
    .replace(/github_pat_[A-Za-z0-9_]+/g, '***')
    .replace(/gh[pousr]_[A-Za-z0-9]+/g, '***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***');
  const match = value.match(/^\[([^\]]+)]\s*(.*)$/);
  if (match) value = `${match[1]} ${match[2]}`;
  return value;
}

function readRunnerEvents(root) {
  const diag = path.join(root, '_diag');
  const events = [];
  try {
    const files = fs.readdirSync(diag, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.log$/i.test(entry.name))
      .map((entry) => {
        const file = path.join(diag, entry.name);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(file).mtimeMs; } catch {}
        return { file, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 10);

    for (const item of files) {
      let text = '';
      try {
        const stat = fs.statSync(item.file);
        const max = 256 * 1024;
        const start = Math.max(0, stat.size - max);
        const length = stat.size - start;
        const fd = fs.openSync(item.file, 'r');
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, start);
        fs.closeSync(fd);
        text = buffer.toString('utf8');
      } catch {
        continue;
      }
      for (const rawLine of text.split(/\r?\n/)) {
        if (!/(Running job:|completed with result:|Listening for Jobs|Runner connect|Runner reconnected|Job .*completed|Job .*started|Running job)/i.test(rawLine)) continue;
        const line = cleanDiagLine(rawLine);
        if (line) events.push(line);
      }
    }
  } catch {}
  return [...new Set(events)].slice(-70);
}

function nowStamp() {
  return new Date().toLocaleTimeString('vi-VN', { hour12: false });
}

function runnerConsoleLines(local, state) {
  const lines = readRunnerEvents(local.root);
  const statusLine = state.busy
    ? `${nowStamp()}  BUSY  Runner.Worker đang chạy${state.workerPids.length ? ` · PID ${state.workerPids.join(', ')}` : ''}`
    : state.running
      ? `${nowStamp()}  IDLE  Runner đang online và chờ job`
      : `${nowStamp()}  OFFLINE  Chưa thấy Runner.Listener đang chạy`;
  const detected = `${nowStamp()}  LOCAL  ${local.runnerName} · ${local.root}${state.listenerPid ? ` · PID ${state.listenerPid}` : ''}`;
  return [...lines, detected, statusLine].slice(-80);
}

async function remoteRunnerStatus(repo, token) {
  if (!token) return null;
  const response = await fetch(`https://api.github.com/repos/${repo}/actions/runners?per_page=100`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'GitHub-Actions-Monitor',
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status}`);
  const data = await response.json();
  const runners = Array.isArray(data?.runners) ? data.runners : [];
  const online = runners.filter((runner) => runner.status === 'online');
  const active = online.find((runner) => runner.busy) || online[0] || runners[0] || null;
  return {
    configured: runners.length > 0,
    managed: false,
    external: runners.length > 0,
    local: false,
    requiresToken: false,
    running: online.length > 0,
    online: online.length > 0,
    busy: online.some((runner) => Boolean(runner.busy)),
    repo,
    runnerName: active?.name || '',
    runnerCount: runners.length,
    consoleLines: active ? [`${nowStamp()}  REMOTE  ${active.name} · ${active.status}${active.busy ? ' · BUSY' : ''}`] : []
  };
}

function installStatusOverride() {
  ipcMain.removeHandler('runner:status');
  ipcMain.handle('runner:status', async (_event, input = {}) => {
    const repo = normalizeRepo(input.repo);
    const local = findLocalRunner(repo);
    if (local) {
      const state = inspectRunnerProcess(local.root);
      return {
        configured: true,
        managed: false,
        external: true,
        local: true,
        requiresToken: false,
        running: state.running,
        online: state.running,
        busy: state.busy,
        repo,
        runnerName: local.runnerName,
        root: local.root,
        pid: state.listenerPid,
        consoleLines: runnerConsoleLines(local, state),
        remoteError: ''
      };
    }

    const token = tokenFromInput(input.token);
    if (token) {
      try { return await remoteRunnerStatus(repo, token); }
      catch (error) {
        return {
          configured: false,
          managed: false,
          external: false,
          local: false,
          requiresToken: false,
          running: false,
          online: false,
          busy: false,
          repo,
          remoteError: error?.message || String(error),
          consoleLines: [`${nowStamp()}  ERROR  ${error?.message || String(error)}`]
        };
      }
    }

    return {
      configured: false,
      managed: false,
      external: false,
      local: false,
      requiresToken: true,
      running: false,
      online: false,
      busy: false,
      repo,
      consoleLines: [`${nowStamp()}  NO LOCAL RUNNER  Không tìm thấy runner cho ${repo}`]
    };
  });
}

function runnerConsoleRendererScript() {
  if (window.__githubActionsMonitorRunnerConsole) return;
  window.__githubActionsMonitorRunnerConsole = true;

  const appRoot = document.querySelector('.app');
  if (!appRoot || !window.actionsMonitor?.runnerStatus) return;

  const style = document.createElement('style');
  style.textContent = `
    .app { grid-template-rows: auto auto minmax(0,1fr) 176px !important; }
    .runner-console-panel { min-height: 0; border-top: 1px solid rgba(63,91,126,.55); background: #050d17; display:flex; flex-direction:column; }
    .runner-console-head { height: 38px; flex:0 0 38px; padding: 0 14px; display:flex; align-items:center; gap:10px; border-bottom:1px solid rgba(63,91,126,.36); background:#081321; }
    .runner-console-title { font-weight:800; font-size:12px; color:#eaf3ff; }
    .runner-console-runner { color:#8fa7c6; font-size:11px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .runner-console-state { margin-left:auto; border:1px solid #294563; border-radius:999px; padding:3px 9px; font-size:10px; font-weight:850; letter-spacing:.45px; color:#94a9c5; }
    .runner-console-state.idle { color:#68e3a4; border-color:rgba(64,216,137,.42); }
    .runner-console-state.busy { color:#7bb8ff; border-color:rgba(77,156,255,.42); }
    .runner-console-state.offline { color:#f5c451; border-color:rgba(245,196,81,.42); }
    .runner-console-toggle { margin-left:2px; height:25px; padding:0 9px; border-radius:7px; font-size:10px; background:#10233b; }
    .runner-console-output { margin:0; padding:10px 14px 12px; flex:1; min-height:0; overflow:auto; white-space:pre-wrap; word-break:break-word; color:#bcd0e9; font:11px/1.55 Consolas, 'Cascadia Mono', monospace; scrollbar-width:thin; }
    .runner-console-panel.collapsed .runner-console-output { display:none; }
  `;
  document.head.appendChild(style);

  const panel = document.createElement('section');
  panel.className = 'runner-console-panel';
  const head = document.createElement('div');
  head.className = 'runner-console-head';
  const title = document.createElement('span');
  title.className = 'runner-console-title';
  title.textContent = 'Runner Console';
  const runner = document.createElement('span');
  runner.className = 'runner-console-runner';
  runner.textContent = 'Đang phát hiện runner local…';
  const state = document.createElement('span');
  state.className = 'runner-console-state';
  state.textContent = 'CHECKING';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'runner-console-toggle';
  toggle.textContent = 'Ẩn';
  const output = document.createElement('pre');
  output.className = 'runner-console-output';
  output.textContent = 'Đang đọc trạng thái runner local…';
  head.append(title, runner, state, toggle);
  panel.append(head, output);
  appRoot.append(panel);

  let collapsed = false;
  let timer = null;
  let polling = false;

  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    panel.classList.toggle('collapsed', collapsed);
    appRoot.style.gridTemplateRows = collapsed ? 'auto auto minmax(0,1fr) 38px' : 'auto auto minmax(0,1fr) 176px';
    toggle.textContent = collapsed ? 'Hiện' : 'Ẩn';
  });

  async function poll() {
    if (!polling) {
      polling = true;
      try {
        const repo = String(document.getElementById('repo')?.value || 'songvedem260597/codexpro').trim();
        const token = String(document.getElementById('token')?.value || '').trim();
        const result = await window.actionsMonitor.runnerStatus({ repo, token });
        const running = Boolean(result?.online || result?.running);
        const busy = Boolean(result?.busy && running);
        runner.textContent = result?.runnerName
          ? `${result.runnerName}${result.root ? ` · ${result.root}` : ''}`
          : `Repository: ${repo}`;
        state.className = `runner-console-state ${busy ? 'busy' : running ? 'idle' : result?.configured ? 'offline' : ''}`;
        state.textContent = busy ? 'BUSY' : running ? 'IDLE' : result?.configured ? 'OFFLINE' : 'NO RUNNER';
        const lines = Array.isArray(result?.consoleLines) ? result.consoleLines : [];
        output.textContent = lines.length ? lines.join('\n') : 'Chưa có log runner local.';
        output.scrollTop = output.scrollHeight;
      } catch (error) {
        state.className = 'runner-console-state offline';
        state.textContent = 'ERROR';
        output.textContent = `Runner Console error: ${error?.message || error}`;
      } finally {
        polling = false;
      }
    }
    timer = setTimeout(poll, 2200);
  }

  poll();
  window.addEventListener('beforeunload', () => clearTimeout(timer), { once: true });
}

function injectRunnerConsole(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(`(${runnerConsoleRendererScript.toString()})()`, true).catch(() => {});
}

app.on('browser-window-created', (_event, win) => {
  win.webContents.on('did-finish-load', () => setTimeout(() => injectRunnerConsole(win), 250));
});

require('./main.js');
installStatusOverride();

app.whenReady().then(() => {
  for (const win of BrowserWindow.getAllWindows()) setTimeout(() => injectRunnerConsole(win), 500);
});
