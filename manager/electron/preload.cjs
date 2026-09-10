const { contextBridge, ipcRenderer } = require("electron");
const traceIdSuffix = () => Math.random().toString(36).slice(2, 10).padEnd(8, "0");

const rendererRunId = `renderer_${Date.now().toString(36)}_${process.pid}_${traceIdSuffix()}`;
const rendererTraceStartedAt = performance.now();
let rendererTraceSequence = 0;
const sendTraceEvent = (payload = {}) => {
  try {
    ipcRenderer.send("codexpro:send-trace-event", {
      ...payload,
      event_at: String(payload.event_at || new Date().toISOString()),
      source_component: "renderer",
      source_run_id: rendererRunId,
      source_process_id: process.pid,
      source_sequence: ++rendererTraceSequence,
      source_elapsed_ms: Math.max(0, Math.round((performance.now() - rendererTraceStartedAt) * 1000) / 1000)
    });
  } catch {}
};

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);
const invokeResult = async (channel, payload) => {
  const response = await invoke(channel, payload);
  if (response?.ok) return response.value;
  const envelope = response?.error || { message: "CodexPro Manager action failed." };
  const error = new Error(String(envelope.message || "CodexPro Manager action failed."));
  error.name = String(envelope.name || "CodexProManagerError");
  error.code = String(envelope.code || "MANAGER_ACTION_FAILED");
  error.details = envelope.details && typeof envelope.details === "object" ? envelope.details : {};
  throw error;
};
const subscribe = (channel, callback) => {
  if (typeof callback !== "function") return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("codexpro", {
  getStatus: () => invoke("codexpro:status"),
  listWorkers: () => invoke("codexpro:workers"),
  sendWorkerRequest: (payload) => invoke("codexpro:worker-send", payload),
  readWorkerResponse: (payload) => invoke("codexpro:worker-read", payload),
  stopWorkerTask: (payload) => invoke("codexpro:worker-stop", payload),
  listApiWorkers: () => invoke("codexpro:api-worker-configs"),
  listApiWorkerModels: (payload) => invoke("codexpro:list-api-worker-models", payload),
  saveApiWorker: (payload) => invoke("codexpro:save-api-worker", payload),
  deleteApiWorker: (id) => invoke("codexpro:delete-api-worker", id),
  testApiWorker: (id) => invoke("codexpro:test-api-worker", id),
  onBrowserProfiles: (callback) => subscribe("codexpro:browser-profiles", callback),
  onBrowserStream: (callback) => subscribe("codexpro:browser-stream", callback),
  ackBrowserStream: (payload) => ipcRenderer.send("codexpro:browser-stream-ack", payload),
  onWorkerUpdate: (callback) => subscribe("codexpro:worker-update", callback),
  controlServer: (action) => invoke("codexpro:control", action),
  copyText: (text) => invoke("codexpro:copy", text),
  logChatLayout: (payload) => ipcRenderer.send("codexpro:log-chat-layout", payload),
  logChatResponseAudit: (payload) => ipcRenderer.send("codexpro:log-chat-response-audit", payload),
  logDiagnostic: (payload) => ipcRenderer.send("codexpro:log-diagnostic", payload),
  sendTraceEvent,
  getDiagnosticLogs: (options) => invoke("codexpro:get-diagnostic-logs", options),
  clearDiagnosticLogs: () => invoke("codexpro:clear-diagnostic-logs"),
  pruneDiagnosticLogs: () => invoke("codexpro:prune-diagnostic-logs"),
  getOperationsPerformance: (pids) => invoke("codexpro:operations-performance", pids),
  showNotification: (payload) => invoke("codexpro:notify", payload),
  rotateLink: () => invoke("codexpro:rotate-link"),
  listProjects: () => invoke("codexpro:projects"),
  checkProfile: (profileId) => invoke("codexpro:check-profile", profileId),
  checkVisualWatchdog: (payload) => invokeResult("codexpro:check-visual-watchdog", payload),
  forgetProfile: (profileId) => invoke("codexpro:forget-profile", profileId),
  setupProfile: (profileId) => invoke("codexpro:setup-profile", profileId),
  openProfileChat: (payload) => invoke("codexpro:open-profile-chat", payload),
  recoverProfileChat: (payload) => invoke("codexpro:recover-profile-chat", payload),
  auditLongRunningProfileChat: (payload) => invoke("codexpro:audit-long-running-profile-chat", payload),
  stopProfileTask: (payload) => invoke("codexpro:stop-profile-task", payload),
  reloadProfiles: () => invoke("codexpro:reload-profiles"),
  getManagerSettings: () => invoke("codexpro:get-manager-settings"),
  saveManagerSettings: (patch) => invoke("codexpro:save-manager-settings", patch),
  createWorkerImagePack: (name) => invoke("codexpro:create-worker-image-pack", name),
  selectWorkerImagePack: (packId) => invoke("codexpro:select-worker-image-pack", packId),
  deleteWorkerImagePack: (packId) => invoke("codexpro:delete-worker-image-pack", packId),
  chooseWorkerImage: (payload) => invoke("codexpro:choose-worker-image", payload),
  resetWorkerImage: (payload) => invoke("codexpro:reset-worker-image", payload),
  chooseAppBackground: () => invoke("codexpro:choose-app-background"),
  resetAppBackground: () => invoke("codexpro:reset-app-background"),
  resetManagerSettings: () => invoke("codexpro:reset-manager-settings"),
  chooseRequestFiles: () => invoke("codexpro:choose-request-files"),
  getRequestFilePreview: (filePath) => invoke("codexpro:get-request-file-preview", filePath),
  captureClipboardImage: () => invoke("codexpro:capture-clipboard-image"),
  sendProfileRequest: (payload) => {
    const ipcCallId = String(payload?.ipc_call_id || `ipc_${Date.now().toString(36)}_${process.pid}_${traceIdSuffix()}`);
    return invokeResult("codexpro:send-profile-request", { ...payload, ipc_call_id: ipcCallId });
  },
  resumeProfileTask: (payload) => invokeResult("codexpro:resume-profile-task", payload),
  renameProfileChat: (payload) => invoke("codexpro:rename-profile-chat", payload),
  getProfileResponse: (payload) => invoke("codexpro:get-profile-response", payload),
  getChatResponseCache: (payload) => invoke("codexpro:get-chat-response-cache", payload),
  saveChatResponseCache: (payload) => invoke("codexpro:save-chat-response-cache", payload),
  getChatResponseCacheMetrics: () => invoke("codexpro:get-chat-response-cache-metrics"),
  onChatResponseCacheFlushRequest: (callback) => subscribe("codexpro:flush-chat-response-cache", callback),
  ackChatResponseCacheFlush: (payload) => ipcRenderer.send(
    "codexpro:chat-response-cache-flush-ack",
    payload
  ),
  getRepoTaskStatus: (payload) => invoke("codexpro:get-repo-task-status", payload),
  getWorkspaceCoordination: (root, taskId = "") => invoke("codexpro:get-workspace-coordination", root, taskId),
  listAppPlugins: () => invoke("codexpro:list-app-plugins"),
  listAppPluginCatalog: () => invoke("codexpro:list-app-plugin-catalog"),
  analyzeAppPluginRepo: (payload) => invoke("codexpro:analyze-app-plugin-repo", payload),
  prepareAppPluginTask: (payload) => invoke("codexpro:prepare-app-plugin-task", payload),
  installCatalogAppPlugin: (id) => invoke("codexpro:install-catalog-app-plugin", id),
  updateCatalogAppPlugin: (id) => invoke("codexpro:update-catalog-app-plugin", id),
  installAppPlugin: () => invoke("codexpro:install-app-plugin"),
  reloadAppPlugin: (id) => invoke("codexpro:reload-app-plugin", id),
  uninstallAppPlugin: (id) => invoke("codexpro:uninstall-app-plugin", id),
  chooseProject: () => invoke("codexpro:choose-project"),

  addProject: (root) => invoke("codexpro:add-project", root),
  removeProject: (root) => invoke("codexpro:remove-project", root),
  inspectProject: (root) => invoke("codexpro:inspect-project", root),
  openFolder: (root) => invoke("codexpro:open-folder", root),
  openExternal: (url) => invoke("codexpro:open-external", url)
});
