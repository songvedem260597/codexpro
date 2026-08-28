const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld("codexpro", {
  getStatus: () => invoke("codexpro:status"),
  controlServer: (action) => invoke("codexpro:control", action),
  copyText: (text) => invoke("codexpro:copy", text),
  rotateLink: () => invoke("codexpro:rotate-link"),
  listProjects: () => invoke("codexpro:projects"),
  checkProfile: (profileId) => invoke("codexpro:check-profile", profileId),
  setupProfile: (profileId) => invoke("codexpro:setup-profile", profileId),
  openProfileChat: (payload) => invoke("codexpro:open-profile-chat", payload),
  reloadProfiles: () => invoke("codexpro:reload-profiles"),
  getManagerSettings: () => invoke("codexpro:get-manager-settings"),
  saveManagerSettings: (patch) => invoke("codexpro:save-manager-settings", patch),
  chooseWorkerImage: (state) => invoke("codexpro:choose-worker-image", state),
  resetWorkerImage: (state) => invoke("codexpro:reset-worker-image", state),
  resetManagerSettings: () => invoke("codexpro:reset-manager-settings"),
  chooseRequestFiles: () => invoke("codexpro:choose-request-files"),
  captureClipboardImage: () => invoke("codexpro:capture-clipboard-image"),
  sendProfileRequest: (payload) => invoke("codexpro:send-profile-request", payload),
  renameProfileChat: (payload) => invoke("codexpro:rename-profile-chat", payload),
  getProfileResponse: (payload) => invoke("codexpro:get-profile-response", payload),
  chooseProject: () => invoke("codexpro:choose-project"),
  addProject: (root) => invoke("codexpro:add-project", root),
  removeProject: (root) => invoke("codexpro:remove-project", root),
  inspectProject: (root) => invoke("codexpro:inspect-project", root),
  openFolder: (root) => invoke("codexpro:open-folder", root),
  openExternal: (url) => invoke("codexpro:open-external", url)
});
