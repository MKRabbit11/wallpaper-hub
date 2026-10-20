const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

const UA = 'Mozilla/5.0 WallpaperHub/1.0';
const LIVE_ARG = process.argv.find(a => a.startsWith('--live='));
let win, tray, timer, liveWin, watcher, liveKind, liveProc, liveReady = false;
const liveState = { paused: false, volume: 0, next: 0, shuffle: false };
const dataDir = () => path.join(app.getPath('userData'), 'wallpapers');
const liveDir = () => path.join(app.getPath('userData'), 'live');
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
const defaults = { favorites: [], autoMinutes: 0, autoQuery: 'nature', autoSource: 'wallhaven',
  library: [], live: null, pexelsKey: '', pauseOnFullscreen: true, startup: false, liveQuality: 'native', liveVolume: 0, liveShuffle: false };
const loadCfg = () => { try { return { ...defaults, ...JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) }; } catch { return { ...defaults }; } };
const saveCfg = (c) => fs.writeFileSync(cfgFile(), JSON.stringify(c, null, 1));

async function getJson(url, headers) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
  if (!r.ok) throw new Error(`${new URL(url).host} returned ${r.status}`);
  return r.json();
}

const sources = {
  async wallhaven({ query, page, sorting, ratio, atleast }) {
    // "Best match" needs a search word; with an empty search show the top wallpapers instead
    if (!sorting || (sorting === 'relevance' && !query)) sorting = 'toplist';
    const p = new URLSearchParams({ q: query || '', page: page || 1, sorting, purity: '100', categories: '111', atleast: atleast || '1920x1080' });
    if (ratio) p.set('ratios', ratio);
    if (sorting === 'toplist') p.set('topRange', '1y');
    const j = await getJson('https://wallhaven.cc/api/v1/search?' + p);
    return j.data.map(w => ({ id: 'wh-' + w.id, thumb: w.thumbs.large, full: w.path, res: w.resolution }));
  },
  // Wider web: Bing Image Search (wallpaper-sized, wide, safe search on)
  async web({ query, page }) {
    if (!query) return [];
    const q = /wallpaper/i.test(query) ? query : query + ' wallpaper';
    const url = 'https://www.bing.com/images/async?q=' + encodeURIComponent(q) + '&first=' + (((page || 1) - 1) * 35) +
      '&count=35&qft=' + encodeURIComponent('+filterui:imagesize-wallpaper+filterui:aspect-wide') + '&mmasync=1';
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', Cookie: 'SRCHHPGUSR=ADLT=STRICT' } });
    if (!r.ok) throw new Error('Web search returned ' + r.status);
    const html = await r.text(), out = [], seen = new Set();
    const dec = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    for (const m of html.matchAll(/class="iusc"[^>]*\sm="([^"]+)"/g)) {
      try {
        const j = JSON.parse(dec(m[1]));
        if (!j.murl || !j.turl || seen.has(j.murl) || !/\.(jpe?g|png)(\?|$)/i.test(j.murl)) continue; // Windows can only set jpg/png
        seen.add(j.murl);
        out.push({ id: 'web-' + require('crypto').createHash('md5').update(j.murl).digest('hex').slice(0, 12), thumb: j.turl, full: j.murl,
          title: (j.t || '').replace(/<[^>]+>/g, '').slice(0, 80), res: 'web' });
      } catch {}
    }
    return out;
  },
  async bing({ page }) {
    const j = await getJson(`https://www.bing.com/HPImageArchive.aspx?format=js&idx=${((page || 1) - 1) * 8}&n=8&mkt=en-US`);
    return j.images.map(i => ({ id: 'bing-' + i.hsh, thumb: 'https://www.bing.com' + i.urlbase + '_640x360.jpg', full: 'https://www.bing.com' + i.urlbase + '_UHD.jpg', res: '3840x2160', title: i.title }));
  },
  async pexelsVideo({ query, page }) {
    const key = loadCfg().pexelsKey;
    if (!key) throw new Error('Add a free Pexels API key first (pexels.com/api)');
    const base = query ? 'search?query=' + encodeURIComponent(query) + '&' : 'popular?';
    const j = await getJson(`https://api.pexels.com/videos/${base}per_page=24&page=${page || 1}`, { Authorization: key });
    return j.videos.map(v => {
      const f = v.video_files.filter(x => x.file_type === 'video/mp4' && x.width >= 1280).sort((a, b) => Math.abs(a.width - 1920) - Math.abs(b.width - 1920))[0];
      return f && { id: 'px-' + v.id, thumb: v.image, full: f.link, kind: 'video', res: `${f.width}x${f.height}` };
    }).filter(Boolean);
  },
};

// Windows wallpaper (static)
function setWallpaper(file) {
  const ps = `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class W { [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int SystemParametersInfo(int a,int b,string c,int d); }'
Set-ItemProperty 'HKCU:\\Control Panel\\Desktop' WallpaperStyle 10
Set-ItemProperty 'HKCU:\\Control Panel\\Desktop' TileWallpaper 0
[W]::SystemParametersInfo(20,0,$env:WP_FILE,3) | Out-Null`;
  return new Promise((res, rej) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { env: { ...process.env, WP_FILE: file }, windowsHide: true }, (e, _o, err) => e ? rej(new Error(err || e.message)) : res()));
}

async function download(item, dir = dataDir(), defExt = 'jpg') {
  fs.mkdirSync(dir, { recursive: true });
  const ext = (item.full.split('?')[0].match(/\.(jpe?g|png|mp4|webm)$/i) || ['', defExt])[1].toLowerCase();
  const file = path.join(dir, item.id + '.' + ext);
  if (!fs.existsSync(file)) {
    const web = item.id.startsWith('web-');
    let r;
    try { r = await fetch(item.full, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) }); }
    catch { throw new Error(web ? 'That site did not respond. Try another wallpaper.' : 'Download failed'); }
    if (!r.ok) throw new Error(web ? 'That site blocked the download (' + r.status + '). Try another wallpaper.' : 'Download failed: ' + r.status);
    if (web && !(r.headers.get('content-type') || '').startsWith('image/')) throw new Error('That link was not an image. Try another wallpaper.');
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  }
  return file;
}

async function applyItem(item) { stopLive(); await setWallpaper(await download(item)); }

async function randomApply() {
  const c = loadCfg();
  const list = await sources[c.autoSource]({ query: c.autoQuery, page: 1 + Math.floor(Math.random() * 3), sorting: 'random' });
  if (!list.length) throw new Error('No results for that search');
  await applyItem(list[Math.floor(Math.random() * list.length)]);
}

function schedule() {
  clearInterval(timer);
  const m = loadCfg().autoMinutes;
  if (m > 0) timer = setInterval(() => randomApply().catch(() => {}), m * 60000);
}

// ---- Live wallpapers: a window parented to the desktop (behind the icons) ----
const ATTACH_PS = `
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class A {
  delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32")] static extern bool SetProcessDPIAware();
  [DllImport("user32")] static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32")] static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);
  [DllImport("user32")] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);
  [DllImport("user32")] static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32")] static extern IntPtr SetParent(IntPtr c, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32")] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32", EntryPoint="GetWindowLongPtr")] static extern IntPtr GetLong(IntPtr h, int i);
  [DllImport("user32", EntryPoint="SetWindowLongPtr")] static extern IntPtr SetLong(IntPtr h, int i, IntPtr v);
  public static string Run(long hw, int w, int h) {
    SetProcessDPIAware();
    IntPtr me = (IntPtr)hw, prog = FindWindow("Progman", null), r;
    SendMessageTimeout(prog, 0x052C, IntPtr.Zero, IntPtr.Zero, 0, 1000, out r);
    IntPtr worker = IntPtr.Zero; string mode = "workerw";
    // Win11 24H2+: the wallpaper layer is a screen-sized WorkerW child of Progman
    IntPtr c = IntPtr.Zero; RECT cr;
    while ((c = FindWindowEx(prog, c, "WorkerW", null)) != IntPtr.Zero) { GetWindowRect(c, out cr); if (cr.R - cr.L >= w) { worker = c; mode = "progman-child-workerw"; break; } }
    // older layout: top-level WorkerW sitting behind the one that holds the icons
    if (worker == IntPtr.Zero) {
      EnumWindows((hh, l) => { if (FindWindowEx(hh, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) { IntPtr cand = FindWindowEx(IntPtr.Zero, hh, "WorkerW", null); RECT rr; if (cand != IntPtr.Zero) { GetWindowRect(cand, out rr); if (rr.R - rr.L >= w) worker = cand; } } return true; }, IntPtr.Zero);
    }
    if (worker == IntPtr.Zero) { worker = prog; mode = "progman"; }
    long st = (long)GetLong(me, -16);
    st = (st & ~0x80000000L & ~0x00C00000L) | 0x40000000L; // drop POPUP/caption, add CHILD
    SetLong(me, -16, (IntPtr)st);
    SetParent(me, worker);
    RECT pr; GetWindowRect(worker, out pr); // child coords are relative to the parent; primary monitor is at screen (0,0)
    SetWindowPos(me, (IntPtr)1, -pr.L, -pr.T, w, h, 0x0010 | 0x0040 | 0x0020); // HWND_BOTTOM, NOACTIVATE|SHOWWINDOW|FRAMECHANGED
    return mode + " parent=" + pr.L + "," + pr.T + " " + (pr.R - pr.L) + "x" + (pr.B - pr.T);
  }
}
'@
Write-Output ([A]::Run([long]$env:WP_HWND, [int]$env:WP_W, [int]$env:WP_H))
`;

const WATCH_PS = `
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public class F {
  [DllImport("user32")] static extern bool SetProcessDPIAware();
  [DllImport("user32")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32")] static extern int GetSystemMetrics(int i);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  public static bool Full() {
    SetProcessDPIAware();
    IntPtr h = GetForegroundWindow(); if (h == IntPtr.Zero) return false;
    var sb = new StringBuilder(64); GetClassName(h, sb, 64); string c = sb.ToString();
    if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd") return false;
    RECT r; GetWindowRect(h, out r);
    return r.L <= 0 && r.T <= 0 && r.R >= GetSystemMetrics(0) && r.B >= GetSystemMetrics(1);
  }
}
'@
$last = $null
while ($true) { $f = [F]::Full(); if ($f -ne $last) { Write-Output $(if ($f) { 'full' } else { 'normal' }); $last = $f }; Start-Sleep -Milliseconds 1500 }
`;

function runPs(script, env) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const f = path.join(app.getPath('userData'), 'ps-' + Math.random().toString(36).slice(2) + '.ps1');
  fs.writeFileSync(f, script);
  return { file: f, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f], env: { ...process.env, ...env } };
}

// The live wallpaper runs in its OWN Electron process. Parenting a window to the desktop (explorer.exe) joins its
// input queue to explorer's, which broke keyboard input in the main window when both shared a process.
function killLiveProc() {
  if (watcher) { watcher.kill(); watcher = null; }
  if (liveProc) { try { liveProc.kill(); } catch {} liveProc = null; }
}

function stopLive() {
  killLiveProc();
  const c = loadCfg();
  if (c.live) saveCfg({ ...c, live: null });
}

async function startLive(item) {
  killLiveProc();
  let payload;
  if (item.type === 'scene') payload = { type: 'scene', name: item.name };
  else if (item.type === 'youtube') payload = { type: 'youtube', vid: item.vid, list: item.list };
  else {
    let file = item.file;
    if (!file) file = await download(item, liveDir(), 'mp4');
    if (!fs.existsSync(file)) throw new Error('Video file is missing');
    payload = { type: 'video', src: file };
  }
  const quality = loadCfg().liveQuality;
  if (quality !== 'native') payload.q = +quality;
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const args = [...(app.isPackaged ? [] : [app.getAppPath()]), '--parent=' + process.pid, '--live=' + Buffer.from(JSON.stringify(payload)).toString('base64')];
  liveState.volume = loadCfg().liveVolume;
  liveState.shuffle = !!loadCfg().liveShuffle;
  setLivePaused(false);
  const proc = spawn(process.execPath, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  liveProc = proc;
  proc.stdout.on('data', (b) => { // player errors (e.g. embedding blocked) from the live process -> tell the UI
    const m = b.toString().match(/YTERROR (\d+)/);
    if (m && win && !win.isDestroyed()) win.webContents.send('live-error', +m[1]);
  });
  const mode = await new Promise((res, rej) => {
    let buf = '';
    const t = setTimeout(() => rej(new Error('Live wallpaper took too long to start')), 30000);
    proc.stdout.on('data', (b) => {
      buf += b.toString();
      const m = buf.match(/^ATTACHED (.*)$/m), e = buf.match(/^ERROR (.*)$/m); // anchored so "YTERROR 150" isn't mistaken for a crash
      if (m) { clearTimeout(t); res(m[1].trim()); } else if (e) { clearTimeout(t); rej(new Error(e[1].trim())); }
    });
    proc.on('exit', () => { clearTimeout(t); rej(new Error('Live wallpaper process exited')); });
  }).catch((err) => { if (liveProc === proc) killLiveProc(); throw err; });
  proc.on('exit', () => { if (liveProc === proc) liveProc = null; });
  console.log('live attach mode:', mode);
  const c = loadCfg();
  saveCfg({ ...c, live: { ...item, ...(payload.src ? { file: payload.src } : {}) } });
  if (c.pauseOnFullscreen) startWatcher();
  return mode;
}

// ---- runs inside the separate live-wallpaper process (--live=<base64 json>) ----
async function createLiveWindow(payload) {
  const d = screen.getPrimaryDisplay();
  const W = Math.round(d.bounds.width * d.scaleFactor), H = Math.round(d.bounds.height * d.scaleFactor);
  liveWin = new BrowserWindow({ x: 0, y: 0, width: d.bounds.width, height: d.bounds.height, frame: false, show: false, skipTaskbar: true,
    focusable: false, resizable: false, backgroundColor: '#000000',
    webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  liveKind = payload.type;
  liveWin.webContents.on('console-message', (...a) => { // the YouTube page reports player errors this way
    const msg = typeof a[1] === 'object' ? a[1].message : a[2];
    if (/^YTERROR/.test(msg || '')) console.log(msg);
  });
  if (payload.type === 'youtube') await liveWin.loadURL(`http://127.0.0.1:${await ytServer()}/?v=${encodeURIComponent(payload.vid || '')}&l=${encodeURIComponent(payload.list || '')}&q=${payload.q || 0}`);
  else await liveWin.loadFile('live.html', { query: payload });
  const hwnd = liveWin.getNativeWindowHandle().readBigUInt64LE(0).toString();
  const p = runPs(ATTACH_PS, { WP_HWND: hwnd, WP_W: String(W), WP_H: String(H) });
  const mode = await new Promise((res, rej) => execFile('powershell.exe', p.args, { env: p.env, windowsHide: true }, (e, out, err) => {
    fs.unlink(p.file, () => {}); e ? rej(new Error(err || e.message)) : res(out.trim());
  }));
  liveWin.showInactive(); // makes Chromium treat it as visible so it paints
  liveWin.webContents.invalidate();
  return mode;
}

function runLiveProcess() {
  const payload = JSON.parse(Buffer.from(LIVE_ARG.slice('--live='.length), 'base64').toString());
  app.setPath('userData', path.join(app.getPath('appData'), 'wallpaper-hub-live'));
  app.whenReady().then(async () => {
    try { const mode = await createLiveWindow(payload); liveReady = true; console.log('ATTACHED ' + mode); } catch (e) { console.log('ERROR ' + e.message); app.exit(1); }
  });
  // (Electron has no usable stdin, so talk through a state file and watch the parent by pid)
  const parent = +(process.argv.find(a => a.startsWith('--parent=')) || '=0').split('=')[1];
  const stateFile = path.join(app.getPath('appData'), 'wallpaper-hub', 'live-state.txt');
  let last = {};
  setInterval(() => {
    try { process.kill(parent, 0); } catch { app.exit(0); }
    if (!liveReady) return; // don't consume the state before the window exists
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (s.paused !== last.paused) setLivePausedLocal(s.paused);
      if (s.volume !== last.volume) setLiveVolumeLocal(s.volume);
      if (liveKind === 'youtube' && liveWin && !liveWin.isDestroyed()) {
        if (s.shuffle !== last.shuffle) liveWin.webContents.executeJavaScript(`window.ytShuffle(${!!s.shuffle})`).catch(() => {});
        if (last.next !== undefined && s.next !== last.next) liveWin.webContents.executeJavaScript(`window.ytCmd('nextVideo')`).catch(() => {});
      }
      last = s;
    } catch {}
  }, 500);
}

// YouTube refuses to play outside a real web page, so serve a tiny local page that embeds it in an iframe
let ytPort;
function ytServer() {
  if (ytPort) return Promise.resolve(ytPort);
  // q = target height: YouTube picks its stream quality from the player's size, so we render a smaller player and scale it up
  const html = `<!doctype html><html><body style="margin:0;background:#000;overflow:hidden"><iframe id="f" allow="autoplay; encrypted-media"></iframe><script>
const p=new URLSearchParams(location.search),v=p.get('v'),q=+p.get('q')||0,sw=innerWidth,sh=innerHeight;
f.style.cssText=(q&&q<sh)?'position:fixed;left:0;top:0;border:0;width:'+Math.round(q*sw/sh)+'px;height:'+q+'px;transform:scale('+(sh/q)+');transform-origin:0 0':'position:fixed;inset:0;width:100%;height:100%;border:0';
const l=p.get('l');
const base='autoplay=1&mute=1&controls=0&disablekb=1&modestbranding=1&rel=0&iv_load_policy=3&playsinline=1&cc_load_policy=0&enablejsapi=1&origin='+encodeURIComponent(location.origin);
f.src=l?'https://www.youtube.com/embed/'+(v||'videoseries')+'?list='+encodeURIComponent(l)+'&loop=1&'+base:'https://www.youtube.com/embed/'+v+'?loop=1&playlist='+v+'&'+base;
const cmd=(fn,a)=>f.contentWindow.postMessage(JSON.stringify({event:'command',func:fn,args:a||[]}),'*');
window.ytCmd=(c,a)=>cmd(c,a);
window.ytShuffle=b=>{window.__sh=b;cmd('setShuffle',[!!b]);cmd('setLoop',[true])};
addEventListener('message',e=>{try{const d=JSON.parse(e.data);if(d.event==='onError'){console.log('YTERROR '+d.info);if(l)setTimeout(()=>cmd('nextVideo'),2000)}}catch{}});
window.ytVol=n=>{window.__vol=n;if(n>0){cmd('unMute');cmd('setVolume',[n])}else cmd('mute')};
f.onload=()=>{f.contentWindow.postMessage(JSON.stringify({event:'listening',id:1}),'*');[1500,4000,8000,15000].forEach(t=>setTimeout(()=>cmd('unloadModule',['captions']),t));[2500,6000,10000].forEach(t=>setTimeout(()=>{if(window.__vol!==undefined)window.ytVol(window.__vol);if(window.__sh!==undefined)window.ytShuffle(window.__sh)},t))};
</script></body></html>`;
  return new Promise(res => {
    const s = require('http').createServer((_q, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(html); });
    s.listen(0, '127.0.0.1', () => res(ytPort = s.address().port));
  });
}

function setLivePausedLocal(p) { // live process
  if (!liveWin || liveWin.isDestroyed()) return;
  const js = liveKind === 'youtube' ? `window.ytCmd('${p ? 'pauseVideo' : 'playVideo'}')` : `window.setPaused(${p})`;
  liveWin.webContents.executeJavaScript(js).catch(() => {});
}

function setLiveVolumeLocal(v) { // live process
  if (!liveWin || liveWin.isDestroyed()) return;
  liveWin.webContents.executeJavaScript(liveKind === 'youtube' ? `window.ytVol(${+v})` : `window.setVolume(${+v})`).catch(() => {});
}

// main process: pause/volume go to the live process through a small state file
function writeLiveState() {
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'live-state.txt'), JSON.stringify(liveState)); } catch {}
}
function setLivePaused(p) { liveState.paused = !!p; writeLiveState(); }
function setLiveVolume(v) { liveState.volume = Math.max(0, Math.min(100, Math.round(+v || 0))); writeLiveState(); }

function ytId(s) {
  const m = String(s).trim().match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/) || (/^[\w-]{11}$/.test(String(s).trim()) && [0, String(s).trim()]);
  return m && m[1];
}

function startWatcher() {
  if (watcher) watcher.kill();
  const p = runPs(WATCH_PS, {});
  watcher = spawn('powershell.exe', p.args, { env: p.env, windowsHide: true });
  setTimeout(() => fs.unlink(p.file, () => {}), 5000);
  watcher.stdout.on('data', (b) => {
    const s = b.toString().trim().split(/\s+/).pop();
    setLivePaused(s === 'full');
  });
}

ipcMain.handle('search', async (_e, src, opts) => {
  const list = await sources[src](opts);
  // Wallhaven has little for this search: top up from the wider web
  if (src === 'wallhaven' && opts.query && list.length < 8) {
    const web = await sources.web(opts).catch(() => []);
    return list.concat(web);
  }
  return list;
});
ipcMain.handle('apply', (_e, item) => applyItem(item));
ipcMain.handle('random', () => randomApply());
ipcMain.handle('getCfg', () => loadCfg());
ipcMain.handle('setCfg', (_e, patch) => {
  const old = loadCfg(); const c = { ...old, ...patch }; saveCfg(c); schedule();
  if ('startup' in patch) app.setLoginItemSettings({ openAtLogin: !!c.startup, path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: ['--hidden'] });
  if ('liveVolume' in patch) setLiveVolume(c.liveVolume);
  if ('liveShuffle' in patch) { liveState.shuffle = !!c.liveShuffle; writeLiveState(); }
  if ('liveQuality' in patch && liveProc && c.live) startLive(c.live).catch((e) => console.log('restart failed:', e.message)); // apply now
  if ('pauseOnFullscreen' in patch && liveProc) {
    if (c.pauseOnFullscreen) startWatcher(); else { if (watcher) watcher.kill(); watcher = null; setLivePaused(false); }
  }
  return c;
});
ipcMain.handle('live:start', async (_e, item) => {
  const mode = await startLive(item);
  if (item.type === 'video' && !item.file) { // remember downloaded videos in the library
    const c = loadCfg();
    if (!c.library.some(l => l.id === item.id)) saveCfg({ ...c, library: [...c.library, { id: item.id, title: item.title || item.id, thumb: item.thumb, file: c.live.file }] });
  }
  return mode;
});
ipcMain.handle('live:next', () => { liveState.next++; writeLiveState(); return true; });
ipcMain.handle('live:youtube', async (_e, link) => {
  const vid = ytId(link);
  const list = (String(link).match(/[?&]list=([\w-]+)/) || [])[1];
  if (!vid && !list) throw new Error('That does not look like a YouTube link');
  const c = loadCfg();
  const entry = { id: list ? 'ytl-' + list + (vid ? '-' + vid : '') : 'yt-' + vid, type: 'youtube', vid, list,
    title: (list ? 'Playlist ' : 'YouTube ') + (list || vid), thumb: vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : '' };
  try {
    const o = await getJson('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(list && !vid ? 'https://www.youtube.com/playlist?list=' + list : 'https://www.youtube.com/watch?v=' + vid));
    entry.title = (list ? 'Playlist: ' : '') + o.title; if (!entry.thumb && o.thumbnail_url) entry.thumb = o.thumbnail_url;
  } catch {}
  if (!entry.thumb) entry.thumb = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#2a2f45"/><text x="160" y="98" font-size="22" fill="#9fb0ff" text-anchor="middle" font-family="sans-serif">YouTube playlist</text></svg>');
  if (!c.library.some(l => l.id === entry.id)) saveCfg({ ...c, library: [...c.library, entry] });
  return entry;
});
ipcMain.handle('live:stop', () => { stopLive(); return true; });
ipcMain.handle('live:search', (_e, opts) => sources.pexelsVideo(opts));
ipcMain.handle('live:import', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Video / GIF', extensions: ['mp4', 'webm', 'gif', 'mov', 'm4v', 'mkv'] }] });
  if (r.canceled) return null;
  fs.mkdirSync(liveDir(), { recursive: true });
  const src = r.filePaths[0], id = 'my-' + Date.now();
  const dest = path.join(liveDir(), id + path.extname(src));
  fs.copyFileSync(src, dest);
  const c = loadCfg();
  const entry = { id, title: path.basename(src), file: dest };
  saveCfg({ ...c, library: [...c.library, entry] });
  return entry;
});
ipcMain.handle('live:remove', (_e, id) => {
  const c = loadCfg(); const e = c.library.find(l => l.id === id);
  if (e) { try { fs.unlinkSync(e.file); } catch {} }
  saveCfg({ ...c, library: c.library.filter(l => l.id !== id) });
  return loadCfg();
});

if (LIVE_ARG) runLiveProcess();
else if (!app.requestSingleInstanceLock()) app.quit(); // already running: just bring that one forward
else app.whenReady().then(() => {
  const hidden = process.argv.includes('--hidden');
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  win = new BrowserWindow({ width: 1200, height: 800, show: !hidden, backgroundColor: '#111318', autoHideMenuBar: true, title: 'Wallpaper Hub', icon: iconPath,
    webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  win.loadFile('index.html');
  // explicit Edit menu so Ctrl+V/C/X/A always work, plus a right-click menu in text boxes
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Edit', submenu: [
    { role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }]));
  win.webContents.on('context-menu', (_e, p) => {
    if (!p.isEditable) return;
    Menu.buildFromTemplate([{ role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy },
      { role: 'paste', enabled: p.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll' }]).popup();
  });
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }));
  tray.setToolTip('Wallpaper Hub');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open', click: () => win.show() },
    { label: 'Random wallpaper', click: () => randomApply().catch(() => {}) },
    { label: 'Stop live wallpaper', click: () => stopLive() },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }]));
  tray.on('click', () => win.show());
  win.on('close', (e) => {
    const c = loadCfg();
    if ((c.autoMinutes > 0 || c.live) && !app.isQuitting) { e.preventDefault(); win.hide(); }
  });
  schedule();
  const c = loadCfg();
  if (c.live) startLive(c.live).catch((e) => console.log('live restore failed:', e.message));
});
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
app.on('before-quit', () => { app.isQuitting = true; killLiveProc(); });
app.on('window-all-closed', () => app.quit());
