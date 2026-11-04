const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('notifAPI', { onPlay: (cb) => ipcRenderer.on('play', (_e, s, v) => cb(s, v)) });
