const { contextBridge, ipcRenderer, webUtils } = require('electron');
const inv = (c) => (...a) => ipcRenderer.invoke(c, ...a);
contextBridge.exposeInMainWorld('wp', {
  search: inv('search'), apply: inv('apply'), random: inv('random'),
  getCfg: inv('getCfg'), setCfg: inv('setCfg'),
  liveStart: inv('live:start'), liveStop: inv('live:stop'), liveSearch: inv('live:search'),
  liveImport: inv('live:import'), liveRemove: inv('live:remove'), liveYoutube: inv('live:youtube'), liveNext: inv('live:next'), liveAddWeb: inv('live:addWeb'), liveAddHtml: inv('live:addHtml'), liveAddFuse: inv('live:addFuse'), liveSuggestLook: inv('live:suggestLook'), liveAutoLookPreview: inv('live:autoLookPreview'),
  playlistNext: inv('playlist:next'), playlistPairs: inv('playlist:pairs'), perfRunningApps: inv('perf:runningApps'), iconsStatus: inv('icons:status'), onIconsMode: (cb) => ipcRenderer.on('icons-mode', (_e, m) => cb(m)), iconsPick: inv('icons:pick'), iconsRunKey: inv('icons:runkey'), gfxInfo: inv('gfx:info'),
  onFuseThumbs: (cb) => ipcRenderer.on('fuse:thumbs', () => cb()), onGfxAuto: (cb) => ipcRenderer.on('gfx-auto', (_e, i) => cb(i)), onMeter: (cb) => ipcRenderer.on('meter', (_e, m) => cb(m)), onPlaylistNow: (cb) => ipcRenderer.on('playlist-now', (_e, p) => cb(p)),
  onLiveError: (cb) => ipcRenderer.on('live-error', (_e, code) => cb(code)),
  statsWatch: inv('stats:watch'), onStats: (cb) => ipcRenderer.on('stats', (_e, s) => cb(s)),
  overlayGet: inv('overlay:get'), overlaySet: inv('overlay:set'), onOverlayState: (cb) => ipcRenderer.on('overlay-state', (_e, o) => cb(o)),
  pathFor: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } }, liveImportPaths: inv('live:importPaths'),
  updateCheck: inv('update:check'), updateGet: inv('update:get'), updateOpen: inv('update:open'), onUpdate: (cb) => ipcRenderer.on('update-info', (_e, u) => cb(u)),
  notifStatus: inv('notif:status'), notifTest: inv('notif:test'), notifSound: inv('notif:sound'), notifPickSound: inv('notif:pickSound'), notifOpenSettings: inv('notif:openSettings'), notifOpenDiscord: inv('notif:openDiscord'), livePause: inv('live:pause'), livePaused: inv('live:paused'),
  onLivePaused: (cb) => ipcRenderer.on('live-paused', (_e, p) => cb(p)), onCallState: (cb) => ipcRenderer.on('call-state', (_e, a) => cb(a)),
  screens: inv('screens:list'), identifyScreens: inv('screens:identify'),
  audioGet: inv('audio:get'), audioAddFiles: inv('audio:addFiles'), audioAddFolder: inv('audio:addFolder'), audioAddYoutube: inv('audio:addYoutube'),
  audioRemove: inv('audio:remove'), audioClear: inv('audio:clear'), audioPlay: inv('audio:play'), audioToggle: inv('audio:toggle'),
  audioStations: inv('audio:stations'), audioStation: inv('audio:addStation'),
  audioNext: inv('audio:next'), audioPrev: inv('audio:prev'), audioSet: inv('audio:set'),
  onAudioState: (cb) => ipcRenderer.on('audio-state', (_e, s) => cb(s)),
  onAudioError: (cb) => ipcRenderer.on('audio-error', (_e, m) => cb(m)),
});
