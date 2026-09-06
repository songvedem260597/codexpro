const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('actionsMonitor', {
  listRuns: (input) => ipcRenderer.invoke('actions:list', input),
  listJobs: (input) => ipcRenderer.invoke('actions:jobs', input),
  openUrl: (url) => ipcRenderer.invoke('actions:open-url', url)
});
