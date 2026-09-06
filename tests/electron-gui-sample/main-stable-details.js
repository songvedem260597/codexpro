const { app, BrowserWindow } = require('electron');

function installStableDetails(win) {
  if (!win || win.isDestroyed()) return;
  const script = `(() => {
    if (window.__githubActionsMonitorStableDetails) return true;
    window.__githubActionsMonitorStableDetails = true;

    const originalSelectRun = window.selectRun;
    if (typeof originalSelectRun !== 'function') return false;

    let lastRunId = null;
    let lastSignature = '';

    window.selectRun = async function stableSelectRun(run) {
      const runId = Number(run?.id || 0);
      const signature = [
        runId,
        String(run?.status || ''),
        String(run?.conclusion || ''),
        String(run?.updatedAt || '')
      ].join('|');

      const hasRenderedDetails = Boolean(
        document.querySelector('#details .detail-title') &&
        document.querySelector('#details .job, #details .empty')
      );

      const sameRun = runId > 0 && runId === lastRunId;
      const unchanged = sameRun && signature === lastSignature;

      // Auto refresh calls selectRun again for the currently selected run.
      // Keep the existing DOM when nothing changed so the panel never flashes.
      if (unchanged && hasRenderedDetails) return;

      lastRunId = runId;
      lastSignature = signature;
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
