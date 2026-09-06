const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

// Mount the real production bundle with the real preload, without starting
// Manager services or touching a user's settings, profiles or tasks.
const managerRoot = path.resolve(process.env.CODEXPRO_STARTUP_PACKAGE || path.join(__dirname, '..'));
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'codexpro-renderer-startup-')));
const errors = [];
const calls = [];
const status = { config: { port: 8793, hostname: '', root: managerRoot }, checkedAt: new Date().toISOString(), local: { ok: true, latency: 1 }, tunnel: { ok: false }, browserProfiles: [], workers: [], workerJobs: [], workerExtensionVersion: '0.5.124' };
const preload = path.join(managerRoot, 'electron', 'preload.cjs');
for (const channel of new Set([...fs.readFileSync(preload, 'utf8').matchAll(/invoke(?:Result)?\("([^"]+)"/g)].map(m => m[1]))) {
  ipcMain.handle(channel, () => {
    calls.push(channel);
    if (channel === 'codexpro:status') return status;
    if (['codexpro:projects', 'codexpro:api-worker-configs', 'codexpro:workers'].includes(channel)) return [];
    if (channel === 'codexpro:get-manager-settings') return { autoUpdateWorkers: false };
    return { ok: true, value: {}, entries: [] };
  });
}
const deadline = setTimeout(() => { console.error('renderer-startup-smoke: deadline exceeded'); app.exit(1); }, 15000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { preload, contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 3) errors.push(event.message);
  });
  win.webContents.on('render-process-gone', (_event, details) => errors.push(`renderer exited: ${details.reason}`));
  try {
    await win.loadFile(path.join(managerRoot, 'dist', 'index.html'));
    await new Promise(resolve => setTimeout(resolve, 1200));
    const readUi = () => win.webContents.executeJavaScript(`({ text: document.body.innerText, nodes: document.getElementById('root')?.childElementCount || 0 })`);
    let ui = await readUi();
    assert.deepEqual(errors, [], 'production renderer must not throw');
    assert.ok(ui.nodes > 0 && ui.text.includes('Worker'), `Manager did not mount: ${JSON.stringify(ui)}`);
    assert.ok(calls.includes('codexpro:status') && calls.includes('codexpro:get-manager-settings'), 'initial effects must run');
    win.webContents.send('codexpro:browser-profiles', { profiles: [{ profile_id: 'startup-probe', label: 'Startup regression profile', connected: true, activity: 'idle', extension_version: '0.5.124', connector_installed: true, connector_checked_at: new Date().toISOString(), conversation_tabs: [] }] });
    await new Promise(resolve => setTimeout(resolve, 700));
    ui = await readUi();
    assert.deepEqual(errors, [], 'status update must not crash renderer');
    assert.ok(ui.nodes > 0 && ui.text.includes('Startup regression profile'), 'live profile event must update the mounted UI');
    if (process.env.CODEXPRO_STARTUP_SCREENSHOT) fs.writeFileSync(process.env.CODEXPRO_STARTUP_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
    console.log('renderer-startup-smoke: PASS (production App mounted, initial effects and runtime update, no renderer errors)');
  } finally { clearTimeout(deadline); win.destroy(); }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
