const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 560,
    show: false,
    backgroundColor: '#111827',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.setTitle('CodexPro Electron GUI Test');
  win.loadFile('index.html');
  win.once('ready-to-show', () => {
    win.show();
    const marker = process.env.CODEXPRO_ELECTRON_TEST_MARKER;
    if (marker) fs.writeFileSync(marker, `ready ${new Date().toISOString()}\n`, 'utf8');
  });

  setTimeout(() => app.quit(), 15000).unref();
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
