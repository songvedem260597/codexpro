const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, globalShortcut } = require("electron");

app.whenReady().then(async () => {
  const shortcutModule = await import(pathToFileURL(path.join(__dirname, "..", "electron", "return-to-manager-shortcut.mjs")).href);
  const win = new BrowserWindow({
    width: 320,
    height: 180,
    show: false,
    skipTaskbar: true,
    webPreferences: { sandbox: true }
  });
  try {
    const testAccelerator = "CommandOrControl+Shift+F11";
    const registration = shortcutModule.registerReturnToManagerShortcut({
      globalShortcut,
      getWindow: () => win,
      accelerator: testAccelerator
    });
    assert.equal(registration.registered, true, `Could not register ${registration.accelerator}`);
    assert.equal(globalShortcut.isRegistered(registration.accelerator), true);

    registration.trigger();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(win.isVisible(), true, "Shortcut callback should show the Manager window");

    win.minimize();
    await new Promise((resolve) => setTimeout(resolve, 120));
    registration.trigger();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(win.isMinimized(), false, "Shortcut callback should restore a minimized Manager window");

    registration.unregister();
    assert.equal(globalShortcut.isRegistered(registration.accelerator), false);
    console.log(`✓ Return-to-Manager Electron shortcut smoke passed: ${registration.accelerator}`);
  } finally {
    globalShortcut.unregisterAll();
    if (!win.isDestroyed()) win.destroy();
    app.quit();
  }
}).catch((error) => {
  console.error(error);
  globalShortcut.unregisterAll();
  app.exit(1);
});
