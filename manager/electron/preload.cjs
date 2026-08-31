const { contextBridge, ipcRenderer } = require("electron");

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
  onBrowserProfiles: (callback) => subscribe("codexpro:browser-profiles", callback),
  controlServer: (action) => invoke("codexpro:control", action),
  copyText: (text) => invoke("codexpro:copy", text),
  logChatLayout: (payload) => ipcRenderer.send("codexpro:log-chat-layout", payload),
  logChatResponseAudit: (payload) => ipcRenderer.send("codexpro:log-chat-response-audit", payload),
  logDiagnostic: (payload) => ipcRenderer.send("codexpro:log-diagnostic", payload),
  getDiagnosticLogs: (options) => invoke("codexpro:get-diagnostic-logs", options),
  clearDiagnosticLogs: () => invoke("codexpro:clear-diagnostic-logs"),
  pruneDiagnosticLogs: () => invoke("codexpro:prune-diagnostic-logs"),
  getOperationsPerformance: (pids) => invoke("codexpro:operations-performance", pids),
  showNotification: (payload) => invoke("codexpro:notify", payload),
  rotateLink: () => invoke("codexpro:rotate-link"),
  listProjects: () => invoke("codexpro:projects"),
  checkProfile: (profileId) => invoke("codexpro:check-profile", profileId),
  setupProfile: (profileId) => invoke("codexpro:setup-profile", profileId),
  openProfileChat: (payload) => invoke("codexpro:open-profile-chat", payload),
  recoverProfileChat: (payload) => invoke("codexpro:recover-profile-chat", payload),
  stopProfileTask: (payload) => invoke("codexpro:stop-profile-task", payload),
  reloadProfiles: () => invoke("codexpro:reload-profiles"),
  getManagerSettings: () => invoke("codexpro:get-manager-settings"),
  saveManagerSettings: (patch) => invoke("codexpro:save-manager-settings", patch),
  createWorkerImagePack: (name) => invoke("codexpro:create-worker-image-pack", name),
  selectWorkerImagePack: (packId) => invoke("codexpro:select-worker-image-pack", packId),
  deleteWorkerImagePack: (packId) => invoke("codexpro:delete-worker-image-pack", packId),
  chooseWorkerImage: (payload) => invoke("codexpro:choose-worker-image", payload),
  resetWorkerImage: (payload) => invoke("codexpro:reset-worker-image", payload),
  resetManagerSettings: () => invoke("codexpro:reset-manager-settings"),
  chooseRequestFiles: () => invoke("codexpro:choose-request-files"),
  getRequestFilePreview: (filePath) => invoke("codexpro:get-request-file-preview", filePath),
  captureClipboardImage: () => invoke("codexpro:capture-clipboard-image"),
  sendProfileRequest: (payload) => invokeResult("codexpro:send-profile-request", payload),
  renameProfileChat: (payload) => invoke("codexpro:rename-profile-chat", payload),
  getProfileResponse: (payload) => invoke("codexpro:get-profile-response", payload),
  getChatResponseCache: (payload) => invoke("codexpro:get-chat-response-cache", payload),
  saveChatResponseCache: (payload) => invoke("codexpro:save-chat-response-cache", payload),
  getRepoTaskStatus: (payload) => invoke("codexpro:get-repo-task-status", payload),
  chooseProject: () => invoke("codexpro:choose-project"),

  addProject: (root) => invoke("codexpro:add-project", root),
  removeProject: (root) => invoke("codexpro:remove-project", root),
  inspectProject: (root) => invoke("codexpro:inspect-project", root),
  openFolder: (root) => invoke("codexpro:open-folder", root),
  openExternal: (url) => invoke("codexpro:open-external", url)
});
