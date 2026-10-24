const { contextBridge, ipcRenderer } = require('electron');

// Expose a minimal, safe API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  onUpdateAvailable:  (cb) => ipcRenderer.on('update-available',  (_event, version) => cb(version)),
  onUpdateNotAvailable: (cb) => ipcRenderer.on('update-not-available', () => cb()),
  onDownloadProgress: (cb) => ipcRenderer.on('update-download-progress', (_event, info) => cb(info)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded',  () => cb()),
  onUpdateError:      (cb) => ipcRenderer.on('update-error',      (_event, msg) => cb(msg)),
  checkForUpdates: () => ipcRenderer.send('check-for-updates'),
});
