const { app, BrowserWindow, ipcMain } = require('electron');
const {
  DEFAULT_REPO,
  normalizeRepo,
  findLocalRunner,
  inspectRunnerProcess,
  readRunnerEvents
} = require('./runner-state-cache.js');

const remoteCache = new Map();

function tokenFromInput(input) {
  return String(input || '').trim() || process.env.CODEXPRO_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '';
}

function runnerConsoleLines(local, state) {
  const lines = readRunnerEvents(local.root);
  const detected = `LOCAL  ${local.runnerName} · ${local.root}${state.listenerPid ? ` · PID ${state.listenerPid}` : ''}`;
  const status = state.busy
    ? `STATUS  BUSY · Runner.Worker${state.workerPids.length ? ` · PID ${state.workerPids.join(', ')}` : ''}`
    : state.running
      ? 'STATUS  IDLE · Runner online và chờ job'
      : 'STATUS  OFFLINE · Chưa thấy Runner.Listener';
  return [...lines, detected, status].slice(-80);
}

async function remoteRunnerStatus(repo, token) {
  const cached = remoteCache.get(repo);
  if (cached && Date.now() - cached.at < 10000) return cached.value;

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
  const value = {
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
    consoleLines: active ? [`REMOTE  ${active.name} · ${active.status}${active.busy ? ' · BUSY' : ''}`] : []
  };
  remoteCache.set(repo, { at: Date.now(), value });
  return value;
}

function installStatusOverride() {
  ipcMain.removeHandler('runner:status');
  ipcMain.handle('runner:status', async (_event, input = {}) => {
    const repo = normalizeRepo(input.repo || DEFAULT_REPO);
    const local = findLocalRunner(repo);
    if (local) {
      const state = await inspectRunnerProcess(local.root);
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
      try {
        return await remoteRunnerStatus(repo, token);
      } catch (error) {
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
          consoleLines: [`ERROR  ${error?.message || String(error)}`]
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
      consoleLines: [`NO LOCAL RUNNER  Không tìm thấy runner cho ${repo}`]
    };
  });
}

function runnerConsoleRendererScript() {
  if (window.__githubActionsMonitorRunnerConsoleFast) return;
  window.__githubActionsMonitorRunnerConsoleFast = true;

  const appRoot = document.querySelector('.app');
  if (!appRoot || !window.actionsMonitor?.runnerStatus) return;

  const oldPanel = document.querySelector('.runner-console-panel');
  if (oldPanel) oldPanel.remove();

  const style = document.createElement('style');
  style.id = 'github-actions-monitor-runner-console-fast-style';
  style.textContent = `
    .app { grid-template-rows: auto auto minmax(0,1fr) 210px !important; }
    .runner-console-panel { min-height:0; border-top:1px solid rgba(63,91,126,.55); background:#050d17; display:flex; flex-direction:column; }
    .runner-console-head { height:42px; flex:0 0 42px; padding:0 16px; display:flex; align-items:center; gap:11px; border-bottom:1px solid rgba(63,91,126,.36); background:#081321; }
    .runner-console-title { font-weight:850; font-size:13px; color:#eaf3ff; }
    .runner-console-runner { color:#8fa7c6; font-size:12px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .runner-console-state { margin-left:auto; border:1px solid #294563; border-radius:999px; padding:4px 10px; font-size:11px; font-weight:850; letter-spacing:.45px; color:#94a9c5; }
    .runner-console-state.idle { color:#68e3a4; border-color:rgba(64,216,137,.42); }
    .runner-console-state.busy { color:#7bb8ff; border-color:rgba(77,156,255,.42); }
    .runner-console-state.offline { color:#f5c451; border-color:rgba(245,196,81,.42); }
    .runner-console-toggle { margin-left:2px; height:28px; padding:0 10px; border-radius:7px; font-size:11px; background:#10233b; }
    .runner-console-output { margin:0; padding:12px 16px 14px; flex:1; min-height:0; overflow:auto; white-space:pre-wrap; word-break:break-word; color:#bcd0e9; font:13px/1.65 Consolas,'Cascadia Mono','Cascadia Code',monospace; scrollbar-width:thin; }
    .runner-console-panel.collapsed .runner-console-output { display:none; }
    .app:has(.runner-console-panel.collapsed) { grid-template-rows:auto auto minmax(0,1fr) 42px !important; }
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
  let lastRunnerText = '';
  let lastStateText = '';
  let lastOutputText = '';

  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    panel.classList.toggle('collapsed', collapsed);
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
        const nextRunnerText = result?.runnerName
          ? `${result.runnerName}${result.root ? ` · ${result.root}` : ''}`
          : `Repository: ${repo}`;
        const nextStateText = busy ? 'BUSY' : running ? 'IDLE' : result?.configured ? 'OFFLINE' : 'NO RUNNER';
        const nextStateClass = `runner-console-state ${busy ? 'busy' : running ? 'idle' : result?.configured ? 'offline' : ''}`;
        const lines = Array.isArray(result?.consoleLines) ? result.consoleLines : [];
        const nextOutputText = lines.length ? lines.join('\n') : 'Chưa có log runner local.';

        if (nextRunnerText !== lastRunnerText) {
          runner.textContent = nextRunnerText;
          lastRunnerText = nextRunnerText;
        }
        if (nextStateText !== lastStateText || state.className !== nextStateClass) {
          state.className = nextStateClass;
          state.textContent = nextStateText;
          lastStateText = nextStateText;
        }
        if (nextOutputText !== lastOutputText) {
          const nearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 36;
          output.textContent = nextOutputText;
          lastOutputText = nextOutputText;
          if (nearBottom) output.scrollTop = output.scrollHeight;
        }
        window.dispatchEvent(new CustomEvent('github-actions-monitor-runner-state', { detail: result }));
      } catch (error) {
        state.className = 'runner-console-state offline';
        state.textContent = 'ERROR';
        const next = `Runner Console error: ${error?.message || error}`;
        if (next !== lastOutputText) {
          output.textContent = next;
          lastOutputText = next;
        }
      } finally {
        polling = false;
      }
    }
    timer = setTimeout(poll, document.hidden ? 12000 : 4000);
  }

  poll();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      clearTimeout(timer);
      timer = setTimeout(poll, 250);
    }
  });
  window.addEventListener('beforeunload', () => clearTimeout(timer), { once: true });
}

function injectRunnerConsole(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(`(${runnerConsoleRendererScript.toString()})()`, true).catch(() => {});
}

app.on('browser-window-created', (_event, win) => {
  win.webContents.on('did-finish-load', () => setTimeout(() => injectRunnerConsole(win), 260));
});

require('./main.js');
installStatusOverride();

app.whenReady().then(() => {
  for (const win of BrowserWindow.getAllWindows()) setTimeout(() => injectRunnerConsole(win), 520);
});
