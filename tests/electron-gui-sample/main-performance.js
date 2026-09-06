const { app, BrowserWindow } = require('electron');

require('./main-stable-details.js');

function installPerformancePatch(win) {
  if (!win || win.isDestroyed()) return;
  const script = `(() => {
    if (window.__githubActionsMonitorPerformancePatch) return true;
    window.__githubActionsMonitorPerformancePatch = true;

    const style = document.createElement('style');
    style.id = 'github-actions-monitor-performance-style';
    style.textContent = \`
      header, .section-head { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
      .run, .job { content-visibility: auto; contain-intrinsic-size: 64px; }
      .runner-console-output { contain: strict; }
    \`;
    document.head.appendChild(style);

    try {
      const originalRenderRuns = typeof renderRuns === 'function' ? renderRuns : null;
      if (originalRenderRuns) {
        let lastSignature = '';
        let lastSelected = null;
        const optimizedRenderRuns = function optimizedRenderRuns(force = false) {
          const runs = Array.isArray(state?.runs) ? state.runs : [];
          const signature = runs.map((run) => [
            run.id, run.status, run.conclusion || '', run.name || '', run.runNumber || '',
            run.branch || '', run.event || '', run.actor || '', run.startedAt || '', run.createdAt || ''
          ].join('~')).join('|');
          const selected = state?.selectedId ?? null;
          const hasRows = Boolean(document.querySelector('#runsList .run, #runsList .empty'));
          if (!force && hasRows && signature === lastSignature && selected === lastSelected) return;
          lastSignature = signature;
          lastSelected = selected;
          return originalRenderRuns();
        };
        renderRuns = optimizedRenderRuns;
        window.renderRuns = optimizedRenderRuns;
      }
    } catch (error) {
      console.warn('[monitor-performance] renderRuns patch skipped', error);
    }

    try {
      const originalRememberRepo = typeof rememberRepo === 'function' ? rememberRepo : null;
      if (originalRememberRepo) {
        const optimizedRememberRepo = function optimizedRememberRepo(repo) {
          const value = String(repo || '').trim();
          if (!value) return;
          const last = localStorage.getItem('github-actions-monitor.last-repo') || '';
          if (last === value) return;
          return originalRememberRepo(value);
        };
        rememberRepo = optimizedRememberRepo;
        window.rememberRepo = optimizedRememberRepo;
      }
    } catch (error) {
      console.warn('[monitor-performance] rememberRepo patch skipped', error);
    }

    try {
      if (state?.clockTimer) clearInterval(state.clockTimer);
      const optimizedTick = () => {
        if (document.hidden) return;
        document.querySelectorAll('[data-duration-start]:not([data-duration-end])').forEach((node) => {
          if (typeof updateDurationNode === 'function') updateDurationNode(node);
        });
      };
      tickDurations = optimizedTick;
      window.tickDurations = optimizedTick;
      state.clockTimer = setInterval(optimizedTick, 1000);
    } catch (error) {
      console.warn('[monitor-performance] duration timer patch skipped', error);
    }

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && typeof tickDurations === 'function') tickDurations();
    });

    return true;
  })()`;
  win.webContents.executeJavaScript(script, true).catch(() => {});
}

app.on('browser-window-created', (_event, win) => {
  win.webContents.on('did-finish-load', () => setTimeout(() => installPerformancePatch(win), 420));
});

app.whenReady().then(() => {
  for (const win of BrowserWindow.getAllWindows()) setTimeout(() => installPerformancePatch(win), 650);
});
