export function createBrowserWindowStreamTarget(win) {
  if (!win) throw new TypeError("BrowserWindow is required.");
  const webContents = win.webContents;
  return {
    webContents,
    available() {
      return !win.isDestroyed() && !webContents.isDestroyed();
    },
    send(channel, payload) {
      if (win.isDestroyed() || webContents.isDestroyed()) return false;
      webContents.send(channel, payload);
      return true;
    }
  };
}
