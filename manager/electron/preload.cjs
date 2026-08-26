const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld("codexpro", {
  getStatus: () => invoke("codexpro:status"),
  controlServer: (action) => invoke("codexpro:control", action),
  copyText: (text) => invoke("codexpro:copy", text),
  rotateLink: () => invoke("codexpro:rotate-link"),
  listProjects: () => invoke("codexpro:projects"),
  chooseProject: () => invoke("codexpro:choose-project"),
  addProject: (root) => invoke("codexpro:add-project", root),
  removeProject: (root) => invoke("codexpro:remove-project", root),
  inspectProject: (root) => invoke("codexpro:inspect-project", root),
  openFolder: (root) => invoke("codexpro:open-folder", root),
  openExternal: (url) => invoke("codexpro:open-external", url)
});
