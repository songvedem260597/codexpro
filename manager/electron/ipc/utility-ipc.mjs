export function registerUtilityIpcHandlers({ ipcMain, clipboard, showNotification }) {
  if (!ipcMain?.handle) throw new Error("Utility IPC registration requires ipcMain.handle.");
  if (typeof clipboard?.writeText !== "function") throw new Error("Utility IPC registration requires clipboard.writeText.");
  if (typeof showNotification !== "function") throw new Error("Utility IPC registration requires showNotification.");

  ipcMain.handle("codexpro:copy", (_event, text) => {
    clipboard.writeText(String(text || ""));
    return true;
  });
  ipcMain.handle("codexpro:notify", (_event, payload) => showNotification(payload));
}
