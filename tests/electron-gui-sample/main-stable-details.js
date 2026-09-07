const { app, BrowserWindow } = require('electron');

function installStableDetails(win) {
  if (!win || win.isDestroyed()) return;
  const script = `(() => {
    if (window.__githubActionsMonitorStableDetails) return true;
    window.__githubActionsMonitorStableDetails = true;

    const originalSelectRun = window.selectRun;
    if (typeof originalSelectRun !== 'function') return false;

    let lastRunId = null;
    let lastStateSignature = '';

    window.selectRun = async function stableSelectRun(run) {
      const runId = Number(run?.id || 0);
      const stateSignature = [
        runId,
        String(run?.status || ''),
        String(run?.conclusion || '')
      ].join('|');

      const hasRenderedDetails = Boolean(
        document.querySelector('#details .detail-title') &&
        document.querySelector('#details .job, #details .empty')
      );

      const sameRun = runId > 0 && runId === lastRunId;
      const sameState = sameRun && stateSignature === lastStateSignature;

      // Auto refresh calls selectRun again every 10s. Keep the existing DOM
      // while the selected run stays in the same state. Live steps are patched
      // in place by preload.js, so no full Jobs/Steps rebuild is needed.
      if (sameState && hasRenderedDetails) return;

      lastRunId = runId;
      lastStateSignature = stateSignature;
      return originalSelectRun(run);
    };

    return true;
  })()`;

  win.webContents.executeJavaScript(script, true).catch(() => {});
}

app.on('browser-window-created', (_event, win) => {
  win.webContents.on('did-finish-load', () => {
    setTimeout(() => installStableDetails(win), 120);
  });
});

require('./main-cicd.js');

app.whenReady().then(() => {
  for (const win of BrowserWindow.getAllWindows()) {
    setTimeout(() => installStableDetails(win), 220);
  }
});
