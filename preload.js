const { contextBridge, ipcRenderer } = require('electron');
const inv = (c) => (...a) => ipcRenderer.invoke(c, ...a);
contextBridge.exposeInMainWorld('wp', {
  search: inv('search'), apply: inv('apply'), random: inv('random'),
  getCfg: inv('getCfg'), setCfg: inv('setCfg'),
  liveStart: inv('live:start'), liveStop: inv('live:stop'), liveSearch: inv('live:search'),
  liveImport: inv('live:import'), liveRemove: inv('live:remove'), liveYoutube: inv('live:youtube'), liveNext: inv('live:next'),
  onLiveError: (cb) => ipcRenderer.on('live-error', (_e, code) => cb(code)),
  screens: inv('screens:list'), identifyScreens: inv('screens:identify'),
  audioGet: inv('audio:get'), audioAddFiles: inv('audio:addFiles'), audioAddFolder: inv('audio:addFolder'), audioAddYoutube: inv('audio:addYoutube'),
  audioRemove: inv('audio:remove'), audioClear: inv('audio:clear'), audioPlay: inv('audio:play'), audioToggle: inv('audio:toggle'),
  audioStations: inv('audio:stations'), audioStation: inv('audio:addStation'),
  audioNext: inv('audio:next'), audioPrev: inv('audio:prev'), audioSet: inv('audio:set'),
  onAudioState: (cb) => ipcRenderer.on('audio-state', (_e, s) => cb(s)),
  onAudioError: (cb) => ipcRenderer.on('audio-error', (_e, m) => cb(m)),
});
