export function registerDiagnosticLogIpcHandlers({
  ipcMain,
  codexProHome,
  readDiagnosticLogs,
  clearDiagnosticLogs,
  pruneDiagnosticLogs
}) {
  if (!ipcMain?.handle) throw new Error("Diagnostic log IPC registration requires ipcMain.handle.");
  if (typeof readDiagnosticLogs !== "function") throw new Error("Diagnostic log IPC registration requires readDiagnosticLogs.");
  if (typeof clearDiagnosticLogs !== "function") throw new Error("Diagnostic log IPC registration requires clearDiagnosticLogs.");
  if (typeof pruneDiagnosticLogs !== "function") throw new Error("Diagnostic log IPC registration requires pruneDiagnosticLogs.");

  ipcMain.handle("codexpro:get-diagnostic-logs", (_event, options) => readDiagnosticLogs(codexProHome, options || {}));
  ipcMain.handle("codexpro:clear-diagnostic-logs", () => clearDiagnosticLogs(codexProHome));
  ipcMain.handle("codexpro:prune-diagnostic-logs", () => pruneDiagnosticLogs(codexProHome));
}
