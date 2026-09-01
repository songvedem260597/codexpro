const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flora', {
  openLogin: () => ipcRenderer.invoke('flora:open-login'),
  openMicrosoftLogin: () => ipcRenderer.invoke('flora:open-microsoft-login'),
  autoLogin: (credentials) => ipcRenderer.invoke('flora:auto-login', credentials),
  authState: () => ipcRenderer.invoke('flora:auth-state'),
  selectImage: () => ipcRenderer.invoke('flora:select-image'),
  logout: () => ipcRenderer.invoke('flora:logout'),
  generate: (payload) => ipcRenderer.invoke('flora:generate', payload),
  onProgress: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('flora:progress', handler);
    return () => ipcRenderer.removeListener('flora:progress', handler);
  },
  onAuthChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('flora:auth-changed', handler);
    return () => ipcRenderer.removeListener('flora:auth-changed', handler);
  },
});
