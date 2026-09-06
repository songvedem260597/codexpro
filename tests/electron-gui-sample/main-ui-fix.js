const { app, BrowserWindow } = require('electron');

function compactRepoDropdown(win) {
  if (!win || win.isDestroyed()) return;
  const script = `(() => {
    const id = 'github-actions-monitor-compact-repo-dropdown';
    let style = document.getElementById(id);
    if (!style) {
      style = document.createElement('style');
      style.id = id;
      document.head.appendChild(style);
    }
    style.textContent = \`
      .repo-dropdown-menu {
        top: calc(100% + 5px) !important;
        max-height: 224px !important;
        border-radius: 10px !important;
        box-shadow: 0 14px 34px rgba(0,0,0,.44), inset 0 1px 0 rgba(255,255,255,.035) !important;
      }
      .repo-dropdown-search-wrap {
        padding: 6px !important;
      }
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
      @media (max-height: 720px) {
        .repo-dropdown-menu { max-height: 190px !important; }
        .repo-dropdown-list { max-height: 144px !important; }
      }
    \`;
    return true;
  })()`;
  win.webContents.executeJavaScript(script, true).catch(() => {});
}

app.on('browser-window-created', (_event, win) => {
  win.webContents.on('did-finish-load', () => setTimeout(() => compactRepoDropdown(win), 250));
});

require('./main-auto-runner.js');

app.whenReady().then(() => {
  for (const win of BrowserWindow.getAllWindows()) setTimeout(() => compactRepoDropdown(win), 450);
});
