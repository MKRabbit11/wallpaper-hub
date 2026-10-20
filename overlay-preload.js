const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ov', { onStats: (cb) => ipcRenderer.on('stats', (_e, s) => cb(s)) });
