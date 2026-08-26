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
  reloadProfiles: () => invoke("codexpro:reload-profiles"),
  chooseRequestFiles: () => invoke("codexpro:choose-request-files"),
  sendProfileRequest: (payload) => invoke("codexpro:send-profile-request", payload),
  getProfileResponse: (payload) => invoke("codexpro:get-profile-response", payload),
  chooseProject: () => invoke("codexpro:choose-project"),
  addProject: (root) => invoke("codexpro:add-project", root),
  removeProject: (root) => invoke("codexpro:remove-project", root),
  inspectProject: (root) => invoke("codexpro:inspect-project", root),
  openFolder: (root) => invoke("codexpro:open-folder", root),
  openExternal: (url) => invoke("codexpro:open-external", url)
});
