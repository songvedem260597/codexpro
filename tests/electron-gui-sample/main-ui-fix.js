const { app, BrowserWindow } = require('electron');

function polishMonitorUi(win) {
  if (!win || win.isDestroyed()) return;
  const script = `(() => {
    const id = 'github-actions-monitor-ui-polish';
    let style = document.getElementById(id);
    if (!style) {
      style = document.createElement('style');
      style.id = id;
      document.head.appendChild(style);
    }
    style.textContent = \`
      /* Compact repository dropdown so it does not cover most of the app. */
      .repo-dropdown-menu {
        top: calc(100% + 5px) !important;
        max-height: 224px !important;
        border-radius: 10px !important;
        box-shadow: 0 14px 34px rgba(0,0,0,.44), inset 0 1px 0 rgba(255,255,255,.035) !important;
      }
      .repo-dropdown-search-wrap { padding: 6px !important; }
      .repo-dropdown-search {
        height: 30px !important;
        padding: 0 9px !important;
        border-radius: 7px !important;
      }
      .repo-dropdown-list {
        max-height: 178px !important;
        padding: 4px !important;
      }
      .repo-dropdown-item {
        min-height: 34px !important;
        padding: 6px 8px !important;
        border-radius: 7px !important;
      }
      .repo-dropdown-item-mark {
        width: 14px !important;
        flex-basis: 14px !important;
      }

      /* Make Runner Console at the bottom easier to read. */
      .app:has(.runner-console-panel:not(.collapsed)) {
        grid-template-rows: auto auto minmax(0,1fr) 210px !important;
      }
      .app:has(.runner-console-panel.collapsed) {
        grid-template-rows: auto auto minmax(0,1fr) 42px !important;
      }
      .runner-console-head {
        height: 42px !important;
        flex: 0 0 42px !important;
        padding: 0 16px !important;
        gap: 11px !important;
      }
      .runner-console-title {
        font-size: 13px !important;
        font-weight: 850 !important;
      }
      .runner-console-runner {
        font-size: 12px !important;
      }
      .runner-console-state {
        font-size: 11px !important;
        padding: 4px 10px !important;
      }
      .runner-console-toggle {
        height: 28px !important;
        padding: 0 10px !important;
        font-size: 11px !important;
      }
      .runner-console-output {
        padding: 12px 16px 14px !important;
        font: 13px/1.65 Consolas, 'Cascadia Mono', 'Cascadia Code', monospace !important;
        letter-spacing: .05px !important;
      }

      @media (max-height: 720px) {
        .repo-dropdown-menu { max-height: 190px !important; }
        .repo-dropdown-list { max-height: 144px !important; }
        .app:has(.runner-console-panel:not(.collapsed)) {
          grid-template-rows: auto auto minmax(0,1fr) 185px !important;
        }
        .runner-console-output { font-size: 12.5px !important; }
      }
    \`;
    return true;
  })()`;
  win.webContents.executeJavaScript(script, true).catch(() => {});
}

app.on('browser-window-created', (_event, win) => {
  win.webContents.on('did-finish-load', () => setTimeout(() => polishMonitorUi(win), 250));
});

require('./main-auto-runner.js');

app.whenReady().then(() => {
  for (const win of BrowserWindow.getAllWindows()) setTimeout(() => polishMonitorUi(win), 450);
});
