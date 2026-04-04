const { contextBridge, ipcRenderer } = require('electron');

// Expose a minimal, safe API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_event, version) => cb(version)),
});
