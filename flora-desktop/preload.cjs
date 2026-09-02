const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flora', {
  accountsState: () => ipcRenderer.invoke('flora:accounts-state'),
  addAccount: () => ipcRenderer.invoke('flora:add-account'),
  switchAccount: (accountId) => ipcRenderer.invoke('flora:switch-account', accountId),
  removeAccount: (accountId) => ipcRenderer.invoke('flora:remove-account', accountId),
  retryAccount: (accountId) => ipcRenderer.invoke('flora:retry-account', accountId),
  setAutoSwitch: (enabled) => ipcRenderer.invoke('flora:set-auto-switch', enabled),
  openLogin: (accountId) => ipcRenderer.invoke('flora:open-login', accountId),
  openMicrosoftLogin: (accountId) => ipcRenderer.invoke('flora:open-microsoft-login', accountId),
  autoLogin: (credentials, accountId) => ipcRenderer.invoke('flora:auto-login', credentials, accountId),
  authState: (accountId) => ipcRenderer.invoke('flora:auth-state', accountId),
  selectImage: () => ipcRenderer.invoke('flora:select-image'),
  previewImageUrl: (url) => ipcRenderer.invoke('flora:preview-image-url', url),
  logout: (accountId) => ipcRenderer.invoke('flora:logout', accountId),
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
  onAccountsChanged: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('flora:accounts-changed', handler);
    return () => ipcRenderer.removeListener('flora:accounts-changed', handler);
  },
});
