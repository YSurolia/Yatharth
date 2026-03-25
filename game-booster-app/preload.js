const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('boosterAPI', {
  scan: () => ipcRenderer.invoke('booster:scan'),
  boost: (data) => ipcRenderer.invoke('booster:boost', data),
  unboost: () => ipcRenderer.invoke('booster:unboost'),
  status: () => ipcRenderer.invoke('booster:status'),
  onScanUpdate: (callback) => {
    ipcRenderer.on('booster:scan-update', (_event, data) => callback(data));
  },
});
