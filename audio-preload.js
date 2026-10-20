const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('audioAPI', {
  onCmd: (cb) => ipcRenderer.on('audio:cmd', (_e, cmd, arg) => cb(cmd, arg)),
  send: (type, arg) => ipcRenderer.send('audio:event', type, arg),
});
