const { app, ipcMain, safeStorage } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_REPO,
  findLocalRunner,
  inspectRunnerProcess,
  invalidateProcessState
} = require('./runner-state-cache.js');

const REMEMBER_TOKEN_CHANNELS = new Set(['actions:repos', 'actions:list', 'actions:jobs', 'runner:start']);
let watchdogTimer = null;
let watchdogBusy = false;
let starting = false;
let lastHiddenStart = 0;
let rememberedTokenCache = null;

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
    invalidateProcessState(runner.root);
    appendAutoStartLog(runner.root, `AUTO START hidden runner ${runner.runnerName} pid=${child.pid}`);
    return true;
  } catch (error) {
    appendAutoStartLog(runner.root, `AUTO START failed: ${error?.message || error}`);
    return false;
  } finally {
    setTimeout(() => { starting = false; }, 3000);
  }
}

async function ensureRunner() {
  if (watchdogBusy) return;
  watchdogBusy = true;
  try {
    const runner = findLocalRunner(DEFAULT_REPO);
    if (!runner) return;
    const state = await inspectRunnerProcess(runner.root);
    if (state.running) return;
    if (Date.now() - lastHiddenStart < 15000) return;
    launchHidden(runner);
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
