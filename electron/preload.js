const { contextBridge, ipcRenderer } = require('electron');

// Expose a minimal, safe API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  onUpdateAvailable:  (cb) => ipcRenderer.on('update-available',  (_event, version) => cb(version)),
  onUpdateNotAvailable: (cb) => ipcRenderer.on('update-not-available', () => cb()),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded',  () => cb()),
  checkForUpdates: () => ipcRenderer.send('check-for-updates'),
});
