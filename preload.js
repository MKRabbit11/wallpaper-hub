const { contextBridge, ipcRenderer } = require('electron');
const inv = (c) => (...a) => ipcRenderer.invoke(c, ...a);
contextBridge.exposeInMainWorld('wp', {
  search: inv('search'), apply: inv('apply'), random: inv('random'),
  getCfg: inv('getCfg'), setCfg: inv('setCfg'),
  liveStart: inv('live:start'), liveStop: inv('live:stop'), liveSearch: inv('live:search'),
  liveImport: inv('live:import'), liveRemove: inv('live:remove'), liveYoutube: inv('live:youtube'), liveNext: inv('live:next'),
  onLiveError: (cb) => ipcRenderer.on('live-error', (_e, code) => cb(code)),
});
