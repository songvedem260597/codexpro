const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("backgroundRemover", {
  chooseImage: () => ipcRenderer.invoke("background-remover:choose"),
  loadPath: (filePath) => ipcRenderer.invoke("background-remover:load", filePath),
  pathForFile: (file) => webUtils.getPathForFile(file),
  removeBackground: (options) => ipcRenderer.invoke("background-remover:remove", options),
  reveal: (filePath) => ipcRenderer.invoke("background-remover:reveal", filePath),
  onOpenedFile: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("background-remover:opened-file", wrapped);
    return () => ipcRenderer.removeListener("background-remover:opened-file", wrapped);
  },
  onProgress: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("background-remover:progress", wrapped);
    return () => ipcRenderer.removeListener("background-remover:progress", wrapped);
  }
});
