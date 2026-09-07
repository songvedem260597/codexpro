const { app, ipcMain, safeStorage } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_REPO,
  findLocalRunner,
  inspectRunnerProcess,
  invalidateProcessState
} = require('./runner-state-cache.js');

const REMEMBER_TOKEN_CHANNELS = new Set(['actions:repos', 'actions:list', 'actions:jobs', 'runner:start']);
const TAKEOVER_IDLE_MS = 20000;
const TAKEOVER_SETTLE_MS = 900;
let watchdogTimer = null;
let watchdogBusy = false;
let starting = false;
let takeoverBusy = false;
let lastHiddenStart = 0;
let rememberedTokenCache = null;
const idleSinceByRoot = new Map();
const headlessRoots = new Set();

function tokenStorePath() {
  return path.join(app.getPath('userData'), 'github-token.enc');
}

function readRememberedToken() {
  if (!safeStorage.isEncryptionAvailable()) return '';
  try {
    const encoded = fs.readFileSync(tokenStorePath(), 'utf8').trim();
    if (!encoded) return '';
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch {
    return '';
  }
}

function saveRememberedToken(token) {
  const value = String(token || '').trim();
  if (!value || !safeStorage.isEncryptionAvailable()) return false;
  try {
    const encrypted = safeStorage.encryptString(value);
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(tokenStorePath(), encrypted.toString('base64'), { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function rememberTokenIfChanged(token) {
  const value = String(token || '').trim();
  if (!value) return;
  if (rememberedTokenCache === null) rememberedTokenCache = readRememberedToken();
  if (value === rememberedTokenCache) return;
  if (saveRememberedToken(value)) rememberedTokenCache = value;
}

function installTokenRemembering() {
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => originalHandle(channel, async (event, ...args) => {
    const result = await listener(event, ...args);
    if (REMEMBER_TOKEN_CHANNELS.has(channel)) rememberTokenIfChanged(args?.[0]?.token);
    return result;
  });
}

function injectRememberedToken(win) {
  if (!win || win.isDestroyed()) return;
  if (rememberedTokenCache === null) rememberedTokenCache = readRememberedToken();
  const token = rememberedTokenCache || '';
  if (!token) return;
  const script = `(() => {
    const input = document.getElementById('token');
    if (!input || String(input.value || '').trim()) return false;
    input.value = ${JSON.stringify(token)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(() => input.dispatchEvent(new Event('change', { bubbles: true })), 80);
    return true;
  })()`;
  win.webContents.executeJavaScript(script, true).catch(() => {});
}

installTokenRemembering();

app.on('browser-window-created', (_event, win) => {
  win.webContents.on('did-finish-load', () => setTimeout(() => injectRememberedToken(win), 360));
});

function appendAutoStartLog(root, message) {
  try {
    const dir = path.join(root, '_diag');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'GitHubActionsMonitor-AutoRunner.log'), `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {}
}

function runnerKey(root) {
  return path.resolve(root).toLowerCase();
}

function isWindowsServiceRunner(root) {
  try {
    return fs.existsSync(path.join(root, '.service')) && Boolean(fs.readFileSync(path.join(root, '.service'), 'utf8').trim());
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function launchHidden(runner) {
  if (starting) return false;
  starting = true;
  try {
    // runner-headless-patch.js intercepts exactly this run.cmd launch. On Windows
    // it starts the configured service when present, otherwise WScript launches
    // run.cmd with window style 0. Keeping run.cmd preserves GitHub runner update
    // and retry semantics while removing the visible console window.
    const child = spawn('cmd.exe', ['/d', '/s', '/c', 'run.cmd'], {
      cwd: runner.root,
      env: { ...process.env, RUNNER_TRACKING_ID: '' },
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
    lastHiddenStart = Date.now();
    invalidateProcessState(runner.root);
    appendAutoStartLog(runner.root, `AUTO START headless runner ${runner.runnerName} launcher_pid=${child.pid}`);
    return true;
  } catch (error) {
    appendAutoStartLog(runner.root, `AUTO START headless failed: ${error?.message || error}`);
    return false;
  } finally {
    setTimeout(() => { starting = false; }, 3000);
  }
}

function stopListenerForHeadlessTakeover(runner, state) {
  const listenerPid = Number(state?.listenerPid) || 0;
  if (!listenerPid) return false;
  const result = spawnSync('taskkill.exe', ['/PID', String(listenerPid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore',
    timeout: 10000
  });
  appendAutoStartLog(
    runner.root,
    `HEADLESS TAKEOVER stop listener pid=${listenerPid} status=${result.status ?? 'null'} error=${result.error?.message || ''}`
  );
  invalidateProcessState(runner.root);
  return !result.error;
}

async function takeOverIdleConsoleRunner(runner, state) {
  if (takeoverBusy || starting) return false;
  takeoverBusy = true;
  const key = runnerKey(runner.root);
  try {
    appendAutoStartLog(runner.root, `HEADLESS TAKEOVER begin runner=${runner.runnerName}`);
    stopListenerForHeadlessTakeover(runner, state);
    await sleep(TAKEOVER_SETTLE_MS);
    const started = launchHidden(runner);
    if (started) {
      headlessRoots.add(key);
      appendAutoStartLog(runner.root, `HEADLESS TAKEOVER complete runner=${runner.runnerName}`);
    }
    return started;
  } catch (error) {
    appendAutoStartLog(runner.root, `HEADLESS TAKEOVER failed: ${error?.message || error}`);
    return false;
  } finally {
    takeoverBusy = false;
  }
}

async function ensureRunner() {
  if (watchdogBusy) return;
  watchdogBusy = true;
  try {
    const runner = findLocalRunner(DEFAULT_REPO);
    if (!runner) return;
    const key = runnerKey(runner.root);
    const state = await inspectRunnerProcess(runner.root, { force: true });

    if (state.running) {
      // A real Windows service already has no interactive terminal. Never disturb it.
      if (isWindowsServiceRunner(runner.root)) {
        headlessRoots.add(key);
        idleSinceByRoot.delete(key);
        return;
      }

      // Runner started by this monitor is already hidden. Do not churn it again.
      if (headlessRoots.has(key)) {
        idleSinceByRoot.delete(key);
        return;
      }

      // Never take over while a workflow worker is active. After a job finishes,
      // require a stable idle window before replacing the visible run.cmd process.
      if (state.busy) {
        idleSinceByRoot.delete(key);
        return;
      }

      const idleSince = idleSinceByRoot.get(key);
      if (!idleSince) {
        idleSinceByRoot.set(key, Date.now());
        return;
      }
      if (Date.now() - idleSince < TAKEOVER_IDLE_MS) return;

      idleSinceByRoot.delete(key);
      await takeOverIdleConsoleRunner(runner, state);
      return;
    }

    idleSinceByRoot.delete(key);
    if (Date.now() - lastHiddenStart < 15000) return;
    if (launchHidden(runner)) headlessRoots.add(key);
  } finally {
    watchdogBusy = false;
  }
}

app.whenReady().then(() => {
  setTimeout(ensureRunner, 900);
  watchdogTimer = setInterval(ensureRunner, 12000);
});

app.on('before-quit', () => {
  if (watchdogTimer) clearInterval(watchdogTimer);
});

require('./main-local-runner-fast.js');
