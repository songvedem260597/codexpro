import { readManagerHangWatchDiagnostics } from "../manager-hang-watch-diagnostics.mjs";

export function registerDiagnosticLogIpcHandlers({
  ipcMain,
  codexProHome,
  readDiagnosticLogs,
  clearDiagnosticLogs,
  pruneDiagnosticLogs,
  getHangWatchLiveState
}) {
  if (!ipcMain?.handle) throw new Error("Diagnostic log IPC registration requires ipcMain.handle.");
  if (typeof readDiagnosticLogs !== "function") throw new Error("Diagnostic log IPC registration requires readDiagnosticLogs.");
  if (typeof clearDiagnosticLogs !== "function") throw new Error("Diagnostic log IPC registration requires clearDiagnosticLogs.");
  if (typeof pruneDiagnosticLogs !== "function") throw new Error("Diagnostic log IPC registration requires pruneDiagnosticLogs.");

  ipcMain.handle("codexpro:get-diagnostic-logs", (_event, options) => readDiagnosticLogs(codexProHome, options || {}));
  ipcMain.handle("codexpro:get-hang-watch-diagnostics", (_event, options) => readManagerHangWatchDiagnostics({
    codexProHome,
    liveState: typeof getHangWatchLiveState === "function" ? getHangWatchLiveState() : null,
    incidentId: options?.incident_id || ""
  }));
  ipcMain.handle("codexpro:clear-diagnostic-logs", () => clearDiagnosticLogs(codexProHome));
  ipcMain.handle("codexpro:prune-diagnostic-logs", () => pruneDiagnosticLogs(codexProHome));
}
