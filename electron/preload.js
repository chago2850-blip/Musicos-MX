// Músicos MX — puente seguro entre la interfaz y el sistema (GPL-3.0-o-posterior)
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('mmxNative', {
  platform: process.platform,
  saveFile: (name, data, filters, path) => ipcRenderer.invoke('save-file', { name, data, filters, path }),
  openManual: () => ipcRenderer.invoke('open-manual'),
  onOpenFile: (cb) => ipcRenderer.on('open-file', (_e, f) => cb(f))
});
