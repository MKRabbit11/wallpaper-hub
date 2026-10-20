const { contextBridge, ipcRenderer, webUtils } = require('electron');
const inv = (c) => (...a) => ipcRenderer.invoke(c, ...a);
contextBridge.exposeInMainWorld('wp', {
  search: inv('search'), apply: inv('apply'), random: inv('random'),
  getCfg: inv('getCfg'), setCfg: inv('setCfg'),
  liveStart: inv('live:start'), liveStop: inv('live:stop'), liveSearch: inv('live:search'),
  liveImport: inv('live:import'), liveRemove: inv('live:remove'), liveYoutube: inv('live:youtube'), liveNext: inv('live:next'),
  onLiveError: (cb) => ipcRenderer.on('live-error', (_e, code) => cb(code)),
  statsWatch: inv('stats:watch'), onStats: (cb) => ipcRenderer.on('stats', (_e, s) => cb(s)),
  overlayGet: inv('overlay:get'), overlaySet: inv('overlay:set'), onOverlayState: (cb) => ipcRenderer.on('overlay-state', (_e, o) => cb(o)),
  pathFor: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } }, liveImportPaths: inv('live:importPaths'),
  updateCheck: inv('update:check'), updateGet: inv('update:get'), updateOpen: inv('update:open'), onUpdate: (cb) => ipcRenderer.on('update-info', (_e, u) => cb(u)),
  screens: inv('screens:list'), identifyScreens: inv('screens:identify'),
  audioGet: inv('audio:get'), audioAddFiles: inv('audio:addFiles'), audioAddFolder: inv('audio:addFolder'), audioAddYoutube: inv('audio:addYoutube'),
  audioRemove: inv('audio:remove'), audioClear: inv('audio:clear'), audioPlay: inv('audio:play'), audioToggle: inv('audio:toggle'),
  audioStations: inv('audio:stations'), audioStation: inv('audio:addStation'),
  audioNext: inv('audio:next'), audioPrev: inv('audio:prev'), audioSet: inv('audio:set'),
  onAudioState: (cb) => ipcRenderer.on('audio-state', (_e, s) => cb(s)),
  onAudioError: (cb) => ipcRenderer.on('audio-error', (_e, m) => cb(m)),
});
