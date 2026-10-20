const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, dialog, desktopCapturer, globalShortcut, shell, Notification } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

const UA = 'Mozilla/5.0 WallpaperHub/1.0';
const LIVE_ARG = process.argv.find(a => a.startsWith('--live='));
let win, tray, timer, liveWin, watcher, liveKind, liveReady = false;
const liveState = { paused: false, pausedKeys: [], volume: 0, next: 0, shuffle: false };
const dataDir = () => path.join(app.getPath('userData'), 'wallpapers');
const liveDir = () => path.join(app.getPath('userData'), 'live');
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
const defaults = { favorites: [], autoMinutes: 0, autoQuery: 'nature', autoSource: 'wallhaven',
  library: [], live: null, liveScreens: {}, target: 'all', pexelsKey: '', pauseOnFullscreen: true, startup: false, liveQuality: 'native', liveFit: 'cover', liveSharp: 'normal', giphyKey: '', updateCheck: true, updateSeen: '', updateDismissed: '', liveVolume: 0, liveShuffle: false,
  audio: { tracks: [], index: 0, volume: 50, shuffle: false, repeat: 'all', autoplay: false } };
// Settings are read on almost every click, so: keep them small (cap any runaway text) and only re-read the file when it changed.
function sanitizeCfg(c) {
  let changed = false;
  const fix = (o, k) => { if (o && typeof o[k] === 'string' && o[k].length > 300) { o[k] = o[k].slice(0, 120).replace(/[^\x20-\x7E]/g, '').trim() || 'Untitled'; changed = true; } };
  for (const l of c.library || []) { fix(l, 'title'); fix(l, 'file'); }
  for (const l of c.favorites || []) { fix(l, 'title'); }
  for (const t of (c.audio && c.audio.tracks) || []) { fix(t, 'title'); }
  for (const v of Object.values(c.liveScreens || {})) fix(v, 'title');
  if (c.live) fix(c.live, 'title');
  return changed;
}
let cfgCache = null; // { key, obj }
const loadCfg = () => {
  try {
    const st = fs.statSync(cfgFile()), key = st.mtimeMs + ':' + st.size;
    if (!cfgCache || cfgCache.key !== key) {
      const obj = JSON.parse(fs.readFileSync(cfgFile(), 'utf8'));
      if (sanitizeCfg(obj) || st.size > 2 * 1024 * 1024) { fs.writeFileSync(cfgFile(), JSON.stringify(obj, null, 1)); cfgCache = null; return { ...defaults, ...obj }; } // heal a bloated file
      cfgCache = { key, obj };
    }
    return { ...defaults, ...structuredClone(cfgCache.obj) }; // callers edit what they get, so hand out a copy
  } catch { return { ...defaults }; }
};
const saveCfg = (c) => { sanitizeCfg(c); fs.writeFileSync(cfgFile(), JSON.stringify(c, null, 1)); cfgCache = null; };

const WM_UA = 'WallpaperHub/1.0 (https://github.com/MKRabbit11/wallpaper-hub)'; // Wikimedia asks apps to identify themselves
async function getJson(url, headers) {
  let r;
  for (let attempt = 0; attempt < 3; attempt++) { // a site saying "slow down" (429): wait a moment and try again
    r = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
    if (r.status !== 429) break;
    await new Promise((res) => setTimeout(res, Math.min(5000, (+r.headers.get('retry-after') || 1.5 + attempt) * 1000)));
  }
  if (!r.ok) throw new Error(r.status === 429 ? `${new URL(url).host} is busy right now. Wait a few seconds and try again.` : `${new URL(url).host} returned ${r.status}`);
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
  // Free live-wallpaper videos, no account or key needed. NASA is public domain; Wikimedia Commons is Creative Commons.
  async nasa({ query, page }) {
    if (!query) return [];
    let j; try { j = await getJson(`https://images-api.nasa.gov/search?q=${encodeURIComponent(query)}&media_type=video&page=${page || 1}&page_size=24`); } catch { return []; }
    return j.collection.items.filter((i) => i.data && i.data[0] && i.links && i.links[0] && i.href).map((i) => ({
      id: 'nasa-' + String(i.data[0].nasa_id).replace(/[^\w-]/g, '_').slice(0, 60), title: i.data[0].title, thumb: i.links[0].href, manifest: i.href, res: 'NASA', kind: 'video' }));
  },
  async commons({ query, page }) {
    if (!query) return [];
    const u = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=40&gsroffset=' + (((page || 1) - 1) * 40) +
      '&gsrsearch=' + encodeURIComponent('filetype:video ' + query) + '&prop=videoinfo|imageinfo&viprop=derivatives|url|size|mime&iiprop=url&iiurlwidth=640';
    const j = await getJson(u, { 'User-Agent': WM_UA }), pages = Object.values((j.query && j.query.pages) || {}).sort((a, b) => a.index - b.index), out = [];
    for (const p of pages) {
      const vi = p.videoinfo && p.videoinfo[0], ii = p.imageinfo && p.imageinfo[0]; if (!vi || vi.width < vi.height) continue; // landscape only (portrait clips crop badly on a monitor)
      let src = null, res = '';
      // the app plays WebM and MP4 (not the old Ogg format). Use the original if it is a sensible size, otherwise Wikimedia's own 1080p/720p copy.
      if (/^video\/(webm|mp4)/.test(vi.mime) && vi.size <= 120 * 1024 * 1024) { src = vi.url; res = vi.width + 'x' + vi.height; }
      else {
        // Wikimedia keeps its resized copies under /transcoded/ (anything else is the original file, which can be enormous)
        const d = (vi.derivatives || []).filter((x) => x.src && /\/transcoded\//.test(x.src) && /webm|mp4/.test(x.type) && !/ogg|quicktime/.test(x.type) && x.height >= 720 && x.height <= 1080 && x.width >= x.height)
          .sort((a, b) => b.height - a.height)[0];
        if (d) { src = d.src.startsWith('//') ? 'https:' + d.src : d.src; res = d.width + 'x' + d.height; }
      }
      if (src) out.push({ id: 'wm-' + p.pageid, title: p.title.replace(/^File:/, '').replace(/\.\w+$/, ''), thumb: ii && ii.thumburl, full: src, res, kind: 'video' });
    }
    return out;
  },
  // Animated GIFs. Wikimedia Commons needs no account (free, Creative Commons / public domain); Giphy needs the user's own free API key.
  async wikigif({ query, page }) {
    if (!query) return [];
    const u = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=50&gsroffset=' + (((page || 1) - 1) * 50) +
      '&gsrsearch=' + encodeURIComponent('filetype:bitmap ' + query + ' gif') + '&prop=imageinfo&iiprop=url|size|mime|metadata&iiurlwidth=480';
    const j = await getJson(u, { 'User-Agent': WM_UA }), pages = Object.values((j.query && j.query.pages) || {}).sort((a, b) => a.index - b.index), out = [];
    for (const p of pages) {
      const ii = p.imageinfo && p.imageinfo[0]; if (!ii || ii.mime !== 'image/gif' || ii.size > 40 * 1024 * 1024) continue;
      const fc = (ii.metadata || []).find((m) => m.name === 'frameCount'); if (!fc || !(+fc.value > 1)) continue; // animated only
      out.push({ id: 'wg-' + p.pageid, title: p.title.replace(/^File:/, '').replace(/\.gif$/i, '').slice(0, 90), thumb: ii.thumburl || ii.url, full: ii.url, res: ii.width + 'x' + ii.height, kb: Math.round(ii.size / 1024), kind: 'gif' });
    }
    return out;
  },
  async giphy({ query, page }) {
    const key = loadCfg().giphyKey; if (!key) throw new Error('Add a free Giphy API key first (developers.giphy.com)');
    const n = 24, u = 'https://api.giphy.com/v1/gifs/' + (query ? 'search' : 'trending') + '?api_key=' + encodeURIComponent(key) + '&limit=' + n + '&offset=' + (((page || 1) - 1) * n) + '&rating=g' + (query ? '&q=' + encodeURIComponent(query) : '');
    const j = await getJson(u);
    return (j.data || []).filter((g) => g.images && g.images.original).map((g) => ({ id: 'gp-' + g.id, title: (g.title || 'GIF').slice(0, 90), thumb: (g.images.fixed_width || g.images.original).url,
      full: g.images.original.url, res: g.images.original.width + 'x' + g.images.original.height, kb: Math.round((+g.images.original.size || 0) / 1024), kind: 'gif' }));
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
  const ps = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class W { [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int SystemParametersInfo(int a,int b,string c,int d); [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int SystemParametersInfo(int a,int b,System.Text.StringBuilder c,int d); }'
Set-ItemProperty 'HKCU:\\Control Panel\\Desktop' WallpaperStyle 10
Set-ItemProperty 'HKCU:\\Control Panel\\Desktop' TileWallpaper 0
$ok = [W]::SystemParametersInfo(20,0,$env:WP_FILE,3)
$sb = New-Object System.Text.StringBuilder 520
Start-Sleep -Milliseconds 600
[W]::SystemParametersInfo(0x73,520,$sb,0) | Out-Null
if ($ok -eq 0 -or ([IO.Path]::GetFileName($sb.ToString()) -ne [IO.Path]::GetFileName($env:WP_FILE))) { throw 'Windows did not accept the wallpaper. It may be locked by a PC policy (work/school PC), or Windows Spotlight / a slideshow is overriding it.' }`;
  return new Promise((res, rej) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { env: { ...process.env, WP_FILE: file }, windowsHide: true }, (e, _o, err) => e ? rej(new Error(err || e.message)) : res()));
}

async function download(item, dir = dataDir(), defExt = 'jpg') {
  fs.mkdirSync(dir, { recursive: true });
  const ext = (item.full.split('?')[0].match(/\.(jpe?g|png|gif|mp4|webm)$/i) || ['', defExt])[1].toLowerCase();
  const file = path.join(dir, item.id + '.' + ext);
  if (!fs.existsSync(file)) {
    const web = item.id.startsWith('web-');
    const isVideo = /^(mp4|webm|gif)$/i.test(ext), headers = { 'User-Agent': /wikimedia\.org/.test(item.full) ? WM_UA : UA };
    let r;
    try { r = await fetch(item.full, { headers, signal: AbortSignal.timeout(isVideo ? 600000 : 30000) }); } // videos are big: allow up to 10 minutes
    catch { throw new Error(web ? 'That site did not respond. Try another wallpaper.' : 'Download failed. Check your internet and try again.'); }
    if (!r.ok) throw new Error(web ? 'That site blocked the download (' + r.status + '). Try another wallpaper.' : 'Download failed: ' + r.status);
    if (web && !(r.headers.get('content-type') || '').startsWith('image/')) throw new Error('That link was not an image. Try another wallpaper.');
    // stream to a temporary file and only rename it when complete, so an interrupted download never leaves a broken file
    try {
      await require('stream/promises').pipeline(require('stream').Readable.fromWeb(r.body), fs.createWriteStream(file + '.part'));
      fs.renameSync(file + '.part', file);
    } catch (e) { try { fs.unlinkSync(file + '.part'); } catch {} throw new Error('Download was interrupted. Try again.'); }
  }
  return file;
}

// ---- Screens (monitors) ----
// Physical-pixel rectangles, numbered left to right. `key` is Electron's display id (stable, used in the saved settings).
function monitors() {
  const primary = screen.getPrimaryDisplay().id;
  const list = screen.getAllDisplays().map((d) => {
    const r = screen.dipToScreenRect(null, d.bounds);
    return { key: String(d.id), x: r.x, y: r.y, w: r.width, h: r.height, primary: d.id === primary };
  });
  list.sort((a, b) => a.x - b.x || a.y - b.y).forEach((m, i) => { m.n = i + 1; });
  return list;
}
const monitorFor = (target) => monitors().find((m) => m.key === target);

// Per-screen still wallpapers use the Windows IDesktopWallpaper interface (the same one Settings uses).
const WALL_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)] public struct WRECT { public int L, T, R, B; }
[ComImport, Guid("B92B56A9-8B55-4E14-9A89-0199BBB6F93B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDesktopWallpaper {
  void SetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID, [MarshalAs(UnmanagedType.LPWStr)] string wallpaper);
  [return: MarshalAs(UnmanagedType.LPWStr)] string GetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID);
  [return: MarshalAs(UnmanagedType.LPWStr)] string GetMonitorDevicePathAt(uint monitorIndex);
  uint GetMonitorDevicePathCount();
  void GetMonitorRECT([MarshalAs(UnmanagedType.LPWStr)] string monitorID, out WRECT rect);
  void SetBackgroundColor(uint color);
  uint GetBackgroundColor();
  void SetPosition(int position);
  int GetPosition();
  void SetSlideshow(IntPtr items);
  IntPtr GetSlideshow();
  void SetSlideshowOptions(int options, uint tick);
  void GetSlideshowOptions(out int options, out uint tick);
  void AdvanceSlideshow([MarshalAs(UnmanagedType.LPWStr)] string monitorID, int direction);
  int GetStatus();
  void Enable([MarshalAs(UnmanagedType.Bool)] bool enable);
}
[ComImport, Guid("C2CF3110-460E-4fc1-B9D0-8A1C0C9CC4BD")] public class DesktopWallpaperCo {}
public static class WPSet {
  [DllImport("user32")] static extern bool SetProcessDPIAware();
  static string Settled(IDesktopWallpaper d, string id, string file) { string got = null; for (int i = 0; i < 15; i++) { got = d.GetWallpaper(id); if (string.IsNullOrEmpty(got) || string.Equals(System.IO.Path.GetFileName(got), System.IO.Path.GetFileName(file), StringComparison.OrdinalIgnoreCase)) return null; System.Threading.Thread.Sleep(200); } return got; }
  public static string Apply(string file, int x, int y, bool all) {
    SetProcessDPIAware();
    var d = (IDesktopWallpaper)new DesktopWallpaperCo();
    d.SetPosition(4); // fill
    if (all) { d.SetWallpaper(null, file); uint c = d.GetMonitorDevicePathCount(); for (uint k = 0; k < c; k++) { string mid = d.GetMonitorDevicePathAt(k); if (string.IsNullOrEmpty(mid)) continue; string got = Settled(d, mid, file); if (got != null) throw new Exception("Windows did not accept the wallpaper (it is still using " + got + "). It may be locked by a PC policy, or Windows Spotlight / a slideshow is overriding it."); } return "all"; }
    uint n = d.GetMonitorDevicePathCount();
    for (uint i = 0; i < n; i++) {
      string id = d.GetMonitorDevicePathAt(i); if (string.IsNullOrEmpty(id)) continue;
      WRECT r; d.GetMonitorRECT(id, out r);
      if (Math.Abs(r.L - x) <= 2 && Math.Abs(r.T - y) <= 2) { d.SetWallpaper(id, file); string got = Settled(d, id, file); if (got != null) throw new Exception("Windows did not accept the wallpaper for that screen (it may be locked by a PC policy, or Spotlight / a slideshow is overriding it)."); return id; }
    }
    throw new Exception("That screen was not found");
  }
}
'@
Write-Output ([WPSet]::Apply($env:WP_FILE, [int]$env:WP_X, [int]$env:WP_Y, ($env:WP_ALL -eq '1')))
`;
async function setWallpaperOn(file, target) {
  const m = target && target !== 'all' ? monitorFor(target) : null;
  const p = runPs(WALL_PS, { WP_FILE: file, WP_ALL: m ? '0' : '1', WP_X: String(m ? m.x : 0), WP_Y: String(m ? m.y : 0) });
  try {
    await new Promise((res, rej) => execFile('powershell.exe', p.args, { env: p.env, windowsHide: true }, (e, _o, err) => { fs.unlink(p.file, () => {}); e ? rej(new Error(err || e.message)) : res(); }));
  } catch (e) {
    if (m) throw new Error('Could not set that screen: ' + String(e.message).split('\n')[0]);
    await setWallpaper(file); // older Windows: fall back to the all-screens method
  }
}

// picks the best NASA file: the 1080p "large" version, unless it is huge, then "medium"
async function nasaFile(manifest) {
  const files = (await getJson(manifest)).filter((f) => /\.mp4$/i.test(f) && !/~preview/i.test(f));
  const by = (tag) => files.find((f) => f.includes('~' + tag + '.'));
  const size = async (u) => { try { return +((await fetch(u, { method: 'HEAD', headers: { 'User-Agent': UA } })).headers.get('content-length') || 0); } catch { return 0; } };
  const large = by('large');
  if (large && (await size(large)) <= 160 * 1024 * 1024) return large;
  const pick = by('medium') || by('orig') || by('small') || by('mobile') || files[0];
  if (!pick) throw new Error('No playable video file for that clip');
  return pick;
}

async function applyItem(item, target = 'all') { stopLive(target); await setWallpaperOn(await download(item), target); }

async function randomApply() {
  const c = loadCfg();
  const list = await sources[c.autoSource]({ query: c.autoQuery, page: 1 + Math.floor(Math.random() * 3), sorting: 'random' });
  if (!list.length) throw new Error('No results for that search');
  await applyItem(list[Math.floor(Math.random() * list.length)], c.target || 'all');
}

function schedule() {
  clearInterval(timer);
  const m = loadCfg().autoMinutes;
  if (m > 0) timer = setInterval(() => randomApply().catch(() => {}), m * 60000);
}

// ---- Live wallpapers: a window parented to the desktop (behind the icons) ----
const ATTACH_PS = `
$ErrorActionPreference = 'Stop'
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
  public static string Run(long hw, int mx, int my, int w, int h) {
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
    RECT pr; GetWindowRect(worker, out pr); // child coords are relative to the parent, so subtract its origin from the screen's position
    SetWindowPos(me, (IntPtr)1, mx - pr.L, my - pr.T, w, h, 0x0010 | 0x0040 | 0x0020); // HWND_BOTTOM, NOACTIVATE|SHOWWINDOW|FRAMECHANGED
    return mode + " parent=" + pr.L + "," + pr.T + " " + (pr.R - pr.L) + "x" + (pr.B - pr.T);
  }
}
'@
Write-Output ([A]::Run([long]$env:WP_HWND, [int]$env:WP_X, [int]$env:WP_Y, [int]$env:WP_W, [int]$env:WP_H))
`;

// Reports which screen (if any) has a fullscreen app focused, so only that screen's live wallpaper pauses.
const WATCH_PS = `
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public class F {
  [DllImport("user32")] static extern bool SetProcessDPIAware();
  [DllImport("user32")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("user32")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  public static string Full() {
    SetProcessDPIAware();
    IntPtr h = GetForegroundWindow(); if (h == IntPtr.Zero) return "normal";
    var sb = new StringBuilder(64); GetClassName(h, sb, 64); string c = sb.ToString();
    if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd") return "normal";
    RECT r; GetWindowRect(h, out r);
    MONITORINFO mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) return "normal";
    bool full = r.L <= mi.rcMonitor.L && r.T <= mi.rcMonitor.T && r.R >= mi.rcMonitor.R && r.B >= mi.rcMonitor.B;
    return full ? ("full " + mi.rcMonitor.L + " " + mi.rcMonitor.T) : "normal";
  }
}
'@
$last = $null
while ($true) { $f = [F]::Full(); if ($f -ne $last) { Write-Output $f; $last = $f }; Start-Sleep -Milliseconds 1500 }
`;

function runPs(script, env) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const f = path.join(app.getPath('userData'), 'ps-' + Math.random().toString(36).slice(2) + '.ps1');
  fs.writeFileSync(f, script);
  return { file: f, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f], env: { ...process.env, ...env } };
}

// Each screen's live wallpaper runs in its OWN Electron process. Parenting a window to the desktop (explorer.exe) joins its
// input queue to explorer's, which broke keyboard input in the main window when both shared a process.
const liveProcs = new Map(); // screen key -> { proc, item }
const anyLive = () => liveProcs.size > 0;
function killLive(target) { // stops the processes only; the saved settings are untouched (so quitting keeps your live wallpapers)
  for (const [k, e] of [...liveProcs]) if (!target || target === 'all' || k === target) { try { e.proc.kill(); } catch {} liveProcs.delete(k); statsWant('live-' + k, false); }
  if (!liveProcs.size && watcher) { watcher.kill(); watcher = null; }
}
function persistLive() { // the saved settings mirror what is running
  const ls = {}; for (const [k, e] of liveProcs) ls[k] = e.item;
  saveCfg({ ...loadCfg(), liveScreens: ls, live: Object.values(ls)[0] || null });
}
function stopLive(target = 'all') { killLive(target); persistLive(); }

async function spawnLive(key, payload, item) {
  killLive(key);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const args = [...(app.isPackaged ? [] : [app.getAppPath()]), '--parent=' + process.pid, '--live=' + Buffer.from(JSON.stringify(payload)).toString('base64')];
  const proc = spawn(process.execPath, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  liveProcs.set(key, { proc, item });
  if (payload.name === 'sysmon') statsWant('live-' + key, true); // the System Monitor wallpaper needs live numbers
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
  }).catch((err) => { if (liveProcs.get(key) && liveProcs.get(key).proc === proc) killLive(key); throw err; });
  proc.on('exit', () => { const e = liveProcs.get(key); if (e && e.proc === proc) liveProcs.delete(key); });
  return mode;
}

// target: 'all' (same wallpaper on every screen) or one screen's key
async function startLive(item, target = 'all', opts = {}) {
  const ordered = monitors().sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0)); // main screen first
  const picked = target === 'all' ? ordered : [ordered.find((m) => m.key === target) || ordered[0]];
  let payload;
  if (item.type === 'scene') payload = { type: 'scene', name: item.name };
  else if (item.type === 'youtube') payload = { type: 'youtube', vid: item.vid, list: item.list };
  else {
    let file = item.file;
    if (!file && item.manifest) item = { ...item, full: await nasaFile(item.manifest) }; // NASA lists several sizes per video
    if (!file) file = await download(item, liveDir(), 'mp4');
    if (!fs.existsSync(file)) throw new Error('Video file is missing');
    payload = { type: 'video', src: file };
  }
  const cfg = loadCfg();
  if (cfg.liveQuality !== 'native') payload.q = +cfg.liveQuality;
  if (cfg.liveSharp && cfg.liveSharp !== 'normal') payload.sharp = cfg.liveSharp; // how a small GIF / video is enlarged
  if (cfg.liveFit === 'contain') payload.fit = 'contain'; // show the whole picture instead of cropping it to fill the screen
  liveState.volume = cfg.liveVolume; liveState.shuffle = !!cfg.liveShuffle; liveState.pausedKeys = []; writeLiveState();
  const saved = { ...item, ...(payload.src ? { file: payload.src } : {}) };
  // with several screens playing the same thing, only the first one makes sound
  const modes = await Promise.all(picked.map((m, i) => spawnLive(m.key, { ...payload, key: m.key, rect: { x: m.x, y: m.y, w: m.w, h: m.h }, mute: i > 0 }, saved)));
  console.log('live attach mode:', modes.join(' | '));
  if (opts.persist !== false) persistLive();
  if (cfg.pauseOnFullscreen && !watcher) startWatcher();
  return { mode: modes[0], file: payload.src };
}

// ---- runs inside a separate live-wallpaper process (--live=<base64 json>), one per screen ----
async function createLiveWindow(payload) {
  const d = screen.getAllDisplays().find((x) => String(x.id) === payload.key) || screen.getPrimaryDisplay();
  const pr = screen.dipToScreenRect(null, d.bounds);
  const r = payload.rect || { x: pr.x, y: pr.y, w: pr.width, h: pr.height }; // physical pixels
  liveWin = new BrowserWindow({ x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height, frame: false, show: false, skipTaskbar: true,
    focusable: false, resizable: false, backgroundColor: '#000000',
    webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  liveKind = payload.type;
  const hears = ['visualizer', 'beatwaves', 'pulsenebula', 'beattunnel'].includes(payload.name); // scenes that move to the music
  if (hears) { // let the visualizer listen to the sound the PC is playing (system output only, never the microphone)
    liveWin.webContents.session.setDisplayMediaRequestHandler((_req, cb) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((src) => cb({ video: src[0], audio: 'loopback' })).catch(() => cb({}));
    });
  }
  liveWin.webContents.on('console-message', (...a) => { // the YouTube page reports player errors this way
    const msg = typeof a[1] === 'object' ? a[1].message : a[2];
    if (/^(YTERROR|AUDIO-CAPTURE)/.test(msg || '')) console.log(msg);
  });
  if (payload.type === 'youtube') await liveWin.loadURL(`http://127.0.0.1:${await ytServer()}/?v=${encodeURIComponent(payload.vid || '')}&l=${encodeURIComponent(payload.list || '')}&q=${payload.q || 0}`);
  else await liveWin.loadFile('live.html', { query: payload });
  if (hears) liveWin.webContents.executeJavaScript('window.startAudioCapture()', true).catch(() => {}); // true = counts as a user action
  const hwnd = liveWin.getNativeWindowHandle().readBigUInt64LE(0).toString();
  const p = runPs(ATTACH_PS, { WP_HWND: hwnd, WP_X: String(r.x), WP_Y: String(r.y), WP_W: String(r.w), WP_H: String(r.h) });
  const mode = await new Promise((res, rej) => execFile('powershell.exe', p.args, { env: p.env, windowsHide: true }, (e, out, err) => {
    fs.unlink(p.file, () => {}); e ? rej(new Error(err || e.message)) : res(out.trim());
  }));
  liveWin.showInactive(); // makes Chromium treat it as visible so it paints
  liveWin.webContents.invalidate();
  return mode;
}

function runLiveProcess() {
  const payload = JSON.parse(Buffer.from(LIVE_ARG.slice('--live='.length), 'base64').toString());
  const myKey = String(payload.key || 'main'), mute = !!payload.mute;
  app.setPath('userData', path.join(app.getPath('appData'), 'wallpaper-hub-live-' + myKey)); // own profile per screen so they never fight over files
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
      const paused = !!s.paused || (Array.isArray(s.pausedKeys) && s.pausedKeys.includes(myKey)); // a fullscreen app on THIS screen
      const vol = mute ? 0 : s.volume;
      if (paused !== last.paused) setLivePausedLocal(paused);
      if (vol !== last.vol) setLiveVolumeLocal(vol);
      if (liveKind === 'youtube' && liveWin && !liveWin.isDestroyed()) {
        if (s.shuffle !== last.shuffle) liveWin.webContents.executeJavaScript(`window.ytShuffle(${!!s.shuffle})`).catch(() => {});
        if (last.next !== undefined && s.next !== last.next) liveWin.webContents.executeJavaScript(`window.ytCmd('nextVideo')`).catch(() => {});
      }
      if (liveKind === 'scene' && s.stats && s.stats.t !== last.statsT && liveWin && !liveWin.isDestroyed()) liveWin.webContents.executeJavaScript('window.__stats=' + JSON.stringify(s.stats)).catch(() => {});
      last = { paused, vol, shuffle: s.shuffle, next: s.next, statsT: s.stats && s.stats.t };
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
f.src=l?'https://www.youtube.com/embed/'+(v||'videoseries')+'?list='+encodeURIComponent(l)+'&loop=1&'+base:'https://www.youtube.com/embed/'+v+'?'+(p.get('a')?'':'loop=1&playlist='+v+'&')+base;
const cmd=(fn,a)=>f.contentWindow.postMessage(JSON.stringify({event:'command',func:fn,args:a||[]}),'*');
window.ytCmd=(c,a)=>cmd(c,a);
window.ytShuffle=b=>{window.__sh=b;cmd('setShuffle',[!!b]);cmd('setLoop',[true])};
addEventListener('message',e=>{try{const d=JSON.parse(e.data);if(p.get('a')&&(d.event==='onStateChange'||(d.event==='infoDelivery'&&d.info&&d.info.playerState!==undefined)))console.log('YTSTATE '+(d.event==='onStateChange'?d.info:d.info.playerState));if(d.event==='onError'){console.log('YTERROR '+d.info);if(l)setTimeout(()=>cmd('nextVideo'),2000)}}catch{}});
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
  watcher.stdout.on('data', (b) => { // 'full X Y' = a fullscreen app on the screen at X,Y; only that screen's wallpaper pauses
    const line = b.toString().trim().split(/\r?\n/).pop().trim();
    const m = line.match(/^full (-?\d+) (-?\d+)/);
    const mon = m ? monitors().find((x) => x.x === +m[1] && x.y === +m[2]) : null;
    liveState.pausedKeys = mon ? [mon.key] : []; writeLiveState();
  });
}

// ---- Performance monitor: CPU, graphics card, memory, disk, network, temperatures ----
// Collected only while something is showing it (the Performance tab, the overlay, or a System Monitor wallpaper).
// Sources: Node (CPU per core, memory), nvidia-smi (NVIDIA graphics card), and Windows performance counters through one
// small PowerShell loop. CPU temperature is not exposed to normal apps on most PCs, so it is read from HWiNFO's shared memory
// when HWiNFO is running (no drivers are installed or loaded by this app).
const STATS_PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System; using System.IO.MemoryMappedFiles; using System.Text;
public static class HW {
  static string Str(System.IO.UnmanagedMemoryAccessor v, long off, int n) { var b = new byte[n]; v.ReadArray(off, b, 0, n); int z = Array.IndexOf(b, (byte)0); return Encoding.UTF8.GetString(b, 0, z < 0 ? n : z); }
  public static string CpuTemp(string name) {
    try {
      using (var mm = MemoryMappedFile.OpenExisting(name, MemoryMappedFileRights.Read))
      using (var v = mm.CreateViewAccessor(0, 0, MemoryMappedFileAccess.Read)) {
        if (v.ReadUInt32(0) != 0x53695748) return null;                 // "HWiS" while HWiNFO is active
        uint off = v.ReadUInt32(32), size = v.ReadUInt32(36), count = v.ReadUInt32(40);
        double best = -1; int bestRank = 99;
        for (uint i = 0; i < count; i++) {
          long p = off + (long)i * size;
          if (v.ReadUInt32(p) != 1) continue;                            // 1 = temperature
          string label = Str(v, p + 140, 128); if (label.Length == 0) label = Str(v, p + 12, 128);
          double val = v.ReadDouble(p + 284); if (val < 10 || val > 125) continue;
          var ic = System.Text.RegularExpressions.RegexOptions.IgnoreCase;
          int rank = System.Text.RegularExpressions.Regex.IsMatch(label, "Tctl|Tdie", ic) ? 0 : System.Text.RegularExpressions.Regex.IsMatch(label, "CPU Package", ic) ? 1 : System.Text.RegularExpressions.Regex.IsMatch(label, "^CPU", ic) ? 2 : 99;
          if (rank < bestRank) { bestRank = rank; best = val; }
        }
        return best < 0 ? null : best.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture);
      }
    } catch { return null; }
  }
}
public static class RT {   // game FPS, from RivaTuner Statistics Server (installed with MSI Afterburner) when it is running
  public static string Fps(string name) {
    try {
      using (var mm = MemoryMappedFile.OpenExisting(name, MemoryMappedFileRights.Read))
      using (var v = mm.CreateViewAccessor(0, 0, MemoryMappedFileAccess.Read)) {
        if (v.ReadUInt32(0) != 0x52545353) return null;                   // "RTSS"
        uint size = v.ReadUInt32(8), off = v.ReadUInt32(12), count = v.ReadUInt32(16);
        string best = null; uint bestT = 0;
        for (uint i = 0; i < count && i < 256; i++) {
          long p = off + (long)i * size; uint pid = v.ReadUInt32(p); if (pid == 0) continue;
          uint t0 = v.ReadUInt32(p + 268), t1 = v.ReadUInt32(p + 272), frames = v.ReadUInt32(p + 276);
          if (t1 <= t0 || frames == 0) continue;
          if (best == null || t1 > bestT) { bestT = t1; var b = new byte[260]; v.ReadArray(p + 4, b, 0, 260); int z = Array.IndexOf(b, (byte)0); string app = System.IO.Path.GetFileName(Encoding.UTF8.GetString(b, 0, z < 0 ? 260 : z));
            best = (1000.0 * frames / (t1 - t0)).ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + "|" + app; }
        }
        return best;
      }
    } catch { return null; }
  }
}
'@
$paths = @('\Processor Information(_Total)\Processor Frequency','\PhysicalDisk(_Total)\Disk Read Bytes/sec','\PhysicalDisk(_Total)\Disk Write Bytes/sec','\PhysicalDisk(_Total)\% Disk Time','\Network Interface(*)\Bytes Received/sec','\Network Interface(*)\Bytes Sent/sec')
if ($env:WH_NV -ne '1') { $paths += '\GPU Engine(*engtype_3D)\Utilization Percentage'; $paths += '\GPU Adapter Memory(*)\Dedicated Usage' }
$hwName = if ($env:WH_HWINFO) { $env:WH_HWINFO } else { 'Global\HWiNFO_SENS_SM2' }
$rtName = if ($env:WH_RTSS) { $env:WH_RTSS } else { 'RTSSSharedMemoryV2' }
$cores = [Environment]::ProcessorCount; $prev = @{}; $prevT = Get-Date; $tick = 0; $procs = @()
Get-Counter -Counter $paths -SampleInterval 1 -Continuous | ForEach-Object {
  $s = $_.CounterSamples; $o = @{}
  $pick = { param($m) ($s | Where-Object { $_.Path -like $m } | ForEach-Object { $_.CookedValue }) }
  $o.freq = [math]::Round((& $pick '*processor frequency' | Measure-Object -Sum).Sum)
  $o.diskR = [math]::Round((& $pick '*disk read bytes/sec' | Measure-Object -Sum).Sum)
  $o.diskW = [math]::Round((& $pick '*disk write bytes/sec' | Measure-Object -Sum).Sum)
  $o.diskT = [math]::Min(100, [math]::Round((& $pick '*% disk time' | Measure-Object -Sum).Sum))
  $o.netRx = [math]::Round((& $pick '*bytes received/sec' | Measure-Object -Maximum).Maximum)   # the busiest adapter (virtual adapters would double count)
  $o.netTx = [math]::Round((& $pick '*bytes sent/sec' | Measure-Object -Maximum).Maximum)
  if ($env:WH_NV -ne '1') {
    $o.gpu3d = [math]::Min(100, [math]::Round((& $pick '*engtype_3d*' | Measure-Object -Sum).Sum))
    $o.vramUsed = [math]::Round(((& $pick '*dedicated usage*' | Measure-Object -Sum).Sum) / 1MB)
  }
  $t = [HW]::CpuTemp($hwName); if ($t) { $o.cpuTemp = [double]$t }
  $f = [RT]::Fps($rtName); if ($f) { $fp = $f -split '\|'; $o.fps = [double]$fp[0]; $o.fpsApp = $fp[1] }
  if ($tick % 3 -eq 0) {   # what is using the PC: compare CPU time since the last look
    $now = Get-Date; $dt = ($now - $prevT).TotalSeconds; $prevT = $now; $cur = @{}; $list = @()
    foreach ($p in Get-Process) { $cur[$p.Id] = $p.CPU; $d = if ($prev.ContainsKey($p.Id)) { ($p.CPU - $prev[$p.Id]) / $dt / $cores * 100 } else { 0 }
      $list += [pscustomobject]@{ n = $p.ProcessName; cpu = [math]::Round([math]::Max(0, $d), 1); ram = [math]::Round($p.WorkingSet64 / 1MB) } }
    $prev = $cur
    $byCpu = $list | Group-Object n | ForEach-Object { [pscustomobject]@{ n = $_.Name; cpu = [math]::Round(($_.Group | Measure-Object cpu -Sum).Sum, 1); ram = ($_.Group | Measure-Object ram -Sum).Sum } }
    $procs = @($byCpu | Sort-Object cpu -Descending | Select-Object -First 5) + @($byCpu | Sort-Object ram -Descending | Select-Object -First 5)
  }
  $tick++
  $o.procs = $procs
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush()
}
`;
const stat = { owners: new Set(), timer: null, ps: null, smi: null, ext: {}, nv: null, prevCpu: null, last: null };
const nvidiaSmiPath = () => ['C:\\Windows\\System32\\nvidia-smi.exe', 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe'].find((p) => fs.existsSync(p)) || null;
function statsWant(owner, on) { if (on) stat.owners.add(owner); else stat.owners.delete(owner); if (stat.owners.size) statsStart(); else statsStop(); }
function statsStart() {
  if (stat.timer) return;
  const smi = nvidiaSmiPath();
  if (smi) {
    stat.smi = spawn(smi, ['--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,clocks.sm,clocks.mem,power.draw,fan.speed,power.limit', '--format=csv,noheader,nounits', '-lms', '1000'], { windowsHide: true });
    stat.smi.stdout.on('data', (b) => {
      const line = b.toString().trim().split(/\r?\n/).pop(), f = line.split(',').map((x) => x.trim()), n = (i) => (isNaN(+f[i]) ? null : +f[i]);
      if (f.length >= 9) stat.nv = { name: f[0], temp: n(1), usage: n(2), vramUsed: n(3), vramTotal: n(4), clock: n(5), memClock: n(6), power: n(7), fan: n(8), powerLimit: n(9) };
    });
    stat.smi.on('error', () => {});
  }
  const p = runPs(STATS_PS, { WH_NV: smi ? '1' : '0' });
  stat.ps = spawn('powershell.exe', p.args, { env: p.env, windowsHide: true });
  setTimeout(() => fs.unlink(p.file, () => {}), 6000);
  let buf = '';
  stat.ps.stdout.on('data', (b) => { buf += b.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line[0] === '{') { try { stat.ext = JSON.parse(line); } catch {} } } });
  stat.ps.on('error', () => {});
  stat.prevCpu = os.cpus().map((c) => ({ ...c.times }));
  stat.timer = setInterval(statsTick, 1000);
}
function statsStop() {
  clearInterval(stat.timer); stat.timer = null;
  for (const k of ['ps', 'smi']) { if (stat[k]) { try { stat[k].kill(); } catch {} stat[k] = null; } }
  stat.nv = null; stat.ext = {}; stat.last = null;
}
function statsTick() {
  const cpus = os.cpus(), cores = cpus.map((c, i) => {
    const a = c.times, b = (stat.prevCpu && stat.prevCpu[i]) || a, idle = a.idle - b.idle, total = (a.user - b.user) + (a.nice - b.nice) + (a.sys - b.sys) + (a.irq - b.irq) + idle;
    return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
  });
  stat.prevCpu = cpus.map((c) => ({ ...c.times }));
  const e = stat.ext || {}, nv = stat.nv, tot = os.totalmem(), free = os.freemem();
  const gpu = nv ? { name: nv.name, usage: nv.usage, temp: nv.temp, vramUsed: nv.vramUsed, vramTotal: nv.vramTotal, clock: nv.clock, power: nv.power, powerLimit: nv.powerLimit, fan: nv.fan }
    : { name: 'Graphics card', usage: e.gpu3d == null ? null : e.gpu3d, temp: null, vramUsed: e.vramUsed == null ? null : e.vramUsed, vramTotal: null, clock: null, power: null, fan: null };
  const s = {
    t: Date.now(),
    cpu: { name: (cpus[0] && cpus[0].model || 'CPU').replace(/\s+/g, ' ').trim(), usage: Math.round(cores.reduce((x, y) => x + y, 0) / Math.max(1, cores.length)), cores, freq: e.freq || null, temp: e.cpuTemp == null ? null : e.cpuTemp },
    gpu, ram: { used: tot - free, total: tot, pct: Math.round((1 - free / tot) * 100) },
    disk: { pct: e.diskT == null ? null : e.diskT, read: e.diskR || 0, write: e.diskW || 0 }, net: { down: e.netRx || 0, up: e.netTx || 0 },
    procs: Array.isArray(e.procs) ? e.procs : (e.procs ? [e.procs] : []),
    fps: e.fps == null ? null : e.fps, fpsApp: e.fpsApp || null,
  };
  stat.last = s;
  if (win && !win.isDestroyed() && stat.owners.has('tab')) win.webContents.send('stats', s);
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('stats', s);
  if ([...stat.owners].some((o) => o.startsWith('live-'))) { liveState.stats = s; writeLiveState(); } // System Monitor wallpapers read it from here
}

// A small always-on-top box with the key numbers. It is a separate window that ignores the mouse and never touches a game,
// so it is safe with anti-cheat, but like any overlay it only shows over borderless / windowed-fullscreen games.
let overlayWin = null;
function overlayShow() {
  if (overlayWin && !overlayWin.isDestroyed()) return;
  const o = { corner: 'tl', scale: 1, ...loadCfg().overlay }, wa = screen.getPrimaryDisplay().workArea, w = Math.round(250 * o.scale), h = Math.round(250 * o.scale), m = 12;
  const x = o.corner[1] === 'l' ? wa.x + m : wa.x + wa.width - w - m, y = o.corner[0] === 't' ? wa.y + m : wa.y + wa.height - h - m;
  overlayWin = new BrowserWindow({ x, y, width: w, height: h, transparent: true, frame: false, alwaysOnTop: true, focusable: false, skipTaskbar: true, hasShadow: false, resizable: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'overlay-preload.js'), backgroundThrottling: false } });
  overlayWin.setAlwaysOnTop(true, 'screen-saver'); overlayWin.setIgnoreMouseEvents(true);
  overlayWin.webContents.setZoomFactor(o.scale);
  overlayWin.loadFile('overlay.html'); overlayWin.once('ready-to-show', () => overlayWin.showInactive());
  overlayWin.on('closed', () => { overlayWin = null; statsWant('overlay', false); });
  statsWant('overlay', true);
}
function overlayHide() { if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy(); overlayWin = null; statsWant('overlay', false); }
function overlaySet(on) { const c = loadCfg(); saveCfg({ ...c, overlay: { corner: 'tl', scale: 1, ...c.overlay, on: !!on } }); if (on) overlayShow(); else overlayHide(); if (win && !win.isDestroyed()) win.webContents.send('overlay-state', loadCfg().overlay); }
ipcMain.handle('stats:watch', (_e, on) => { statsWant('tab', !!on); return stat.last; });
ipcMain.handle('overlay:get', () => ({ corner: 'tl', scale: 1, on: false, ...loadCfg().overlay }));
ipcMain.handle('overlay:set', (_e, patch) => {
  const c = loadCfg(), o = { corner: 'tl', scale: 1, on: false, ...c.overlay, ...patch }; saveCfg({ ...c, overlay: o });
  overlayHide(); if (o.on) overlayShow();
  return o;
});

// ---- "New version on GitHub" notice ----
const REPO = 'MKRabbit11/wallpaper-hub';
const appVer = () => process.env.WH_APP_VERSION || app.getVersion(); // (the override exists only so the update check can be tested)
let updateInfo = null;
const verNum = (v) => String(v).replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
const isNewer = (a, b) => { const x = verNum(a), y = verNum(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
async function checkUpdate(manual) {
  try {
    const j = await getJson(process.env.WH_UPDATE_URL || 'https://api.github.com/repos/' + REPO + '/releases/latest');
    const latest = String(j.tag_name || '').replace(/^v/i, ''); if (!latest) throw new Error('No release found');
    updateInfo = { current: appVer(), latest, newer: isNewer(latest, appVer()), url: j.html_url, name: j.name || ('Version ' + latest), notes: String(j.body || '').slice(0, 700), checkedAt: Date.now() };
    const c = loadCfg();
    if (updateInfo.newer && c.updateCheck !== false && c.updateSeen !== latest && !manual) { // pop up once per new version
      try { const n = new Notification({ title: 'Wallpaper Hub update', body: 'Version ' + latest + ' is available on GitHub. Open the app to see what is new.' }); n.on('click', () => { if (win) { win.show(); win.focus(); } }); n.show(); } catch {}
      saveCfg({ ...c, updateSeen: latest });
    }
    if (win && !win.isDestroyed()) win.webContents.send('update-info', updateInfo);
    return updateInfo;
  } catch (e) { return { error: String(e.message).slice(0, 120), current: appVer() }; }
}
ipcMain.handle('update:check', () => checkUpdate(true));
ipcMain.handle('update:get', () => updateInfo || { current: appVer() });
ipcMain.handle('update:open', (_e, url) => { // only ever opens this app's own GitHub page
  const u = String(url || ''); if (u.startsWith('https://github.com/' + REPO + '/')) shell.openExternal(u); return true;
});

// ---- Music player: plays your own audio (files, folders, YouTube links) independent of the wallpaper ----
// Local files play in a hidden window (audio.html); YouTube links play in a hidden window too (audio only).
const AUDIO_EXT = /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus|weba|webm|wma)$/i;
let audioWin, ytAudioWin, audioIdx = -1, audioPlaying = false, audioFails = 0;
const audioHistory = [];
const audioCfg = () => ({ ...defaults.audio, ...loadCfg().audio });
function saveAudio(patch) { const c = loadCfg(); c.audio = { ...audioCfg(), ...patch }; saveCfg(c); }
function audioState() { const a = audioCfg(), t = a.tracks[audioIdx]; return { ...a, index: audioIdx, playing: audioPlaying, now: t ? t.title : '', bad: [...audioBad] }; }
function pushAudio() { if (win && !win.isDestroyed()) win.webContents.send('audio-state', audioState()); }
function audioToast(msg) { if (win && !win.isDestroyed()) win.webContents.send('audio-error', msg); }

function ensureAudioWin() {
  if (audioWin && !audioWin.isDestroyed()) return audioWin;
  audioWin = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'audio-preload.js'), backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  audioWin.loadFile('audio.html');
  return audioWin;
}
async function audioSend(cmd, arg) {
  const w = ensureAudioWin();
  if (w.webContents.isLoading()) await new Promise((r) => w.webContents.once('did-finish-load', r));
  w.webContents.send('audio:cmd', cmd, arg);
}
// Loads the video briefly in a hidden player to find out whether YouTube will let it play here.
// Returns 'ok' | 'blocked' | 'gone' | 'unknown' (unknown = couldn't tell, so allow it).
function probeYoutube(vid) {
  return new Promise(async (resolve) => {
    const w = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
    let done = false;
    const fin = (r) => { if (done) return; done = true; try { w.destroy(); } catch {} resolve(r); };
    w.webContents.on('console-message', (...a) => {
      const m = (typeof a[1] === 'object' ? a[1].message : a[2]) || '';
      const e = m.match(/^YTERROR (\d+)/);
      if (e) fin(+e[1] === 100 ? 'gone' : 'blocked'); else if (/^YTSTATE (1|3)$/.test(m)) fin('ok');
    });
    setTimeout(() => fin('unknown'), 12000);
    try { await w.loadURL(`http://127.0.0.1:${await ytServer()}/?v=${encodeURIComponent(vid)}&l=&q=0&a=1`); } catch { fin('unknown'); }
  });
}
const probeMessage = (r) => r === 'blocked' ? "That video doesn't allow embedding, so it can't play here. Try another upload of it, like a lyric video or an audio version."
  : r === 'gone' ? 'That video was removed or is private.' : '';

function stopYtAudio() { if (ytAudioWin && !ytAudioWin.isDestroyed()) ytAudioWin.destroy(); ytAudioWin = null; }
async function startYtAudio(vid) {
  stopYtAudio();
  const w = ytAudioWin = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  w.webContents.on('console-message', (...a) => {
    const msg = (typeof a[1] === 'object' ? a[1].message : a[2]) || '';
    if (w !== ytAudioWin) return;
    const st = msg.match(/^YTSTATE (-?\d+)/);
    if (st && +st[1] === 0) audioEnded();            // video ended
    else if (st && +st[1] === 1) audioFails = 0;      // playing
    else if (/^YTERROR/.test(msg)) audioFailed('That video does not allow embedding, or was removed');
  });
  await w.loadURL(`http://127.0.0.1:${await ytServer()}/?v=${encodeURIComponent(vid)}&l=&q=0&a=1`);
  w.webContents.executeJavaScript(`window.ytVol(${audioCfg().volume})`).catch(() => {});
}

async function audioPlayIndex(i, fromHistory) {
  const a = audioCfg(); if (!a.tracks.length) return;
  i = ((i % a.tracks.length) + a.tracks.length) % a.tracks.length;
  const t = a.tracks[i];
  if (audioIdx >= 0 && !fromHistory && audioIdx !== i) audioHistory.push(audioIdx);
  audioIdx = i; audioPlaying = true; saveAudio({ index: i }); pushAudio();
  if (t.type === 'youtube') { await audioSend('stop'); await startYtAudio(t.vid); return; }
  stopYtAudio();
  if (t.type === 'stream') { await audioSend('play', { src: t.url, volume: a.volume }); return; }
  if (!fs.existsSync(t.path)) return audioFailed('File not found: ' + t.title);
  await audioSend('play', { src: require('url').pathToFileURL(t.path).href, volume: a.volume });
}
function audioNextIndex() {
  const a = audioCfg(), n = a.tracks.length;
  if (a.shuffle && n > 1) { let j; do { j = Math.floor(Math.random() * n); } while (j === audioIdx); return j; }
  return audioIdx + 1 >= n ? (a.repeat === 'off' ? -1 : 0) : audioIdx + 1;
}
function audioEnded() {
  if (audioCfg().repeat === 'one') return audioPlayIndex(audioIdx, true);
  const j = audioNextIndex();
  if (j < 0) { audioPlaying = false; pushAudio(); } else audioPlayIndex(j);
}
const audioBad = new Set(); // tracks that failed to play this session (shown in the list)
function audioFailed(reason) {
  const cur = audioCfg().tracks[audioIdx]; if (cur) audioBad.add(cur.id);
  audioToast((cur ? '"' + cur.title.slice(0, 40) + '": ' : '') + reason);
  pushAudio();
  if (++audioFails >= audioCfg().tracks.length) { audioPlaying = false; audioFails = 0; pushAudio(); return; }
  setTimeout(() => { if (audioPlaying) audioEnded(); }, 1200); // skip to the next track
}
function audioStopAll() { audioPlaying = false; audioSend('stop').catch(() => {}); stopYtAudio(); pushAudio(); }
function audioPauseResume(play) {
  audioPlaying = play; pushAudio();
  const t = audioCfg().tracks[audioIdx];
  if (t && t.type === 'youtube' && ytAudioWin && !ytAudioWin.isDestroyed()) ytAudioWin.webContents.executeJavaScript(`window.ytCmd('${play ? 'playVideo' : 'pauseVideo'}')`).catch(() => {});
  else audioSend(play ? 'resume' : 'pause').catch(() => {});
}
function audioToggle() {
  if (audioIdx < 0) return audioPlayIndex(audioCfg().index || 0);
  audioPauseResume(!audioPlaying);
}
function audioSetVolume(v) {
  v = Math.max(0, Math.min(100, Math.round(+v || 0))); saveAudio({ volume: v });
  audioSend('volume', v).catch(() => {});
  if (ytAudioWin && !ytAudioWin.isDestroyed()) ytAudioWin.webContents.executeJavaScript(`window.ytVol(${v})`).catch(() => {});
}
ipcMain.on('audio:event', (_e, type, arg) => {
  if (type === 'ended') audioEnded();
  else if (type === 'playing') audioFails = 0;
  else if (type === 'error') audioFailed(arg || 'This file could not be played');
});
const addTracks = (list) => {
  const a = audioCfg(), have = new Set(a.tracks.map((t) => t.id));
  const fresh = list.filter((t) => !have.has(t.id));
  saveAudio({ tracks: a.tracks.concat(fresh) }); pushAudio(); return fresh.length;
};
const trackFromFile = (p) => ({ id: 'f-' + require('crypto').createHash('md5').update(p).digest('hex').slice(0, 12), type: 'file', path: p, title: path.basename(p, path.extname(p)) });
function scanAudio(dir, out = [], depth = 0) {
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 4) scanAudio(p, out, depth + 1);
    else if (e.isFile() && AUDIO_EXT.test(e.name)) out.push(p);
    if (out.length >= 3000) break;
  }
  return out;
}
// Free internet radio (SomaFM, listener-supported, no account or key needed). Plays like any other track.
const STATIONS = [
  ['groovesalad', 'Groove Salad', 'chill'], ['beatblender', 'Beat Blender', 'electronic'], ['fluid', 'Fluid', 'instrumental hip hop'],
  ['lush', 'Lush', 'mellow vocals'], ['secretagent', 'Secret Agent', 'spy lounge'], ['indiepop', 'Indie Pop Rocks', 'indie'],
  ['metal', 'Metal Detector', 'metal'], ['bootliquor', 'Boot Liquor', 'country'], ['defcon', 'DEF CON Radio', 'hacker beats'],
  ['spacestation', 'Space Station Soma', 'space ambient'], ['dronezone', 'Drone Zone', 'ambient'], ['7soul', 'Seven Inch Soul', 'classic soul'],
].map(([id, name, tag]) => ({ id: 's-' + id, name, tag, url: `https://ice1.somafm.com/${id}-128-mp3`, title: `${name} (${tag}) - SomaFM radio` }));
ipcMain.handle('audio:stations', () => STATIONS.map(({ id, name, tag }) => ({ id, name, tag })));
ipcMain.handle('audio:addStation', async (_e, id) => {
  const s = STATIONS.find((x) => x.id === id); if (!s) return;
  addTracks([{ id: s.id, type: 'stream', url: s.url, title: s.title }]);
  audioFails = 0; audioBad.delete(s.id);
  await audioPlayIndex(audioCfg().tracks.findIndex((t) => t.id === s.id));
});
ipcMain.handle('audio:get', () => audioState());
ipcMain.handle('audio:addFiles', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus', 'weba', 'webm', 'wma'] }] });
  return r.canceled ? 0 : addTracks(r.filePaths.map(trackFromFile));
});
ipcMain.handle('audio:addFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? 0 : addTracks(scanAudio(r.filePaths[0]).map(trackFromFile));
});
ipcMain.handle('audio:addYoutube', async (_e, link) => {
  const vid = ytId(link);
  if (!vid && /^https?:\/\/\S+$/i.test(String(link).trim())) { // a direct audio / radio stream link
    const url = String(link).trim();
    let host = url; try { host = new URL(url).hostname; } catch {}
    return addTracks([{ id: 'u-' + require('crypto').createHash('md5').update(url).digest('hex').slice(0, 12), type: 'stream', url, title: 'Link: ' + host + (url.length > 60 ? '' : '') }]);
  }
  if (!vid) throw new Error('That does not look like a YouTube link or an audio link');
  const bad = probeMessage(await probeYoutube(vid));
  if (bad) throw new Error(bad);
  const t = { id: 'a-yt-' + vid, type: 'youtube', vid, title: 'YouTube ' + vid };
  try { t.title = (await getJson('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + vid))).title; } catch {}
  return addTracks([t]);
});
ipcMain.handle('audio:remove', (_e, id) => {
  const a = audioCfg(), i = a.tracks.findIndex((t) => t.id === id); if (i < 0) return;
  const wasCurrent = i === audioIdx;
  saveAudio({ tracks: a.tracks.filter((t) => t.id !== id) });
  if (wasCurrent) { audioIdx = -1; audioStopAll(); } else if (i < audioIdx) audioIdx--;
  pushAudio();
});
ipcMain.handle('audio:clear', () => { saveAudio({ tracks: [], index: 0 }); audioIdx = -1; audioStopAll(); });
ipcMain.handle('audio:play', (_e, i) => audioPlayIndex(i));
ipcMain.handle('audio:toggle', () => audioToggle());
ipcMain.handle('audio:next', () => { const j = audioCfg().shuffle ? audioNextIndex() : (audioIdx + 1) % Math.max(1, audioCfg().tracks.length); return audioPlayIndex(j); });
ipcMain.handle('audio:prev', () => { const h = audioHistory.pop(); return h !== undefined ? audioPlayIndex(h, true) : audioPlayIndex(audioIdx - 1); });
ipcMain.handle('audio:set', (_e, patch) => {
  if ('volume' in patch) audioSetVolume(patch.volume);
  const rest = { ...patch }; delete rest.volume; if (Object.keys(rest).length) saveAudio(rest);
  pushAudio();
});

ipcMain.handle('search', async (_e, src, opts) => {
  const list = await sources[src](opts);
  // Wallhaven has little for this search: top up from the wider web
  if (src === 'wallhaven' && opts.query && list.length < 8) {
    const web = await sources.web(opts).catch(() => []);
    return list.concat(web);
  }
  return list;
});
ipcMain.handle('apply', (_e, item, target) => applyItem(item, target || 'all'));
ipcMain.handle('random', () => randomApply());
ipcMain.handle('screens:list', () => monitors().map(({ key, n, w, h, primary }) => ({ key, n, w, h, primary })));
ipcMain.handle('screens:identify', () => { // flash each screen's number for a couple of seconds
  for (const m of monitors()) {
    const d = screen.getAllDisplays().find((x) => String(x.id) === m.key); if (!d) continue;
    const w = new BrowserWindow({ x: d.bounds.x + Math.round(d.bounds.width / 2) - 150, y: d.bounds.y + Math.round(d.bounds.height / 2) - 150, width: 300, height: 300,
      frame: false, transparent: true, alwaysOnTop: true, focusable: false, skipTaskbar: true, hasShadow: false, show: false });
    w.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;box-sizing:border-box;font:bold 190px sans-serif;color:#fff;background:rgba(20,24,40,.9);border:8px solid #6c8cff;border-radius:44px">${m.n}</body>`));
    w.once('ready-to-show', () => w.showInactive());
    setTimeout(() => { if (!w.isDestroyed()) w.destroy(); }, 2500);
  }
});
ipcMain.handle('getCfg', () => loadCfg());
ipcMain.handle('setCfg', (_e, patch) => {
  const old = loadCfg(); const c = { ...old, ...patch }; saveCfg(c); schedule();
  if ('startup' in patch) app.setLoginItemSettings({ openAtLogin: !!c.startup, path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: ['--hidden'] });
  if ('liveVolume' in patch) setLiveVolume(c.liveVolume);
  if ('liveShuffle' in patch) { liveState.shuffle = !!c.liveShuffle; writeLiveState(); }
  if (('liveQuality' in patch || 'liveFit' in patch || 'liveSharp' in patch) && anyLive()) for (const [k, e] of [...liveProcs]) startLive(e.item, k, { persist: false }).catch((err) => console.log('restart failed:', err.message)); // apply now
  if ('pauseOnFullscreen' in patch && anyLive()) {
    if (c.pauseOnFullscreen) startWatcher(); else { if (watcher) watcher.kill(); watcher = null; liveState.pausedKeys = []; setLivePaused(false); }
  }
  return c;
});
ipcMain.handle('live:start', async (_e, item, target) => {
  const r = await startLive(item, target || 'all');
  if (item.type === 'video' && !item.file) { // remember downloaded videos in the library
    const c = loadCfg();
    if (!c.library.some(l => l.id === item.id)) saveCfg({ ...c, library: [...c.library, { id: item.id, title: item.title || item.id, thumb: item.thumb, file: r.file }] });
  }
  return r.mode;
});
ipcMain.handle('live:next', () => { liveState.next++; writeLiveState(); return true; });
ipcMain.handle('live:youtube', async (_e, link) => {
  if (/^https?:\/\//i.test(String(link).trim()) && (/\.(gif|mp4|webm)$/i.test(String(link).trim().split(/[?#]/)[0]) || /(tenor\.com\/view|giphy\.com\/gifs\/|imgur\.com\/(gallery|a)\/)/i.test(link))) return importFromUrl(link);
  const vid = ytId(link);
  const list = (String(link).match(/[?&]list=([\w-]+)/) || [])[1];
  if (!vid && !list) throw new Error('That does not look like a YouTube link or a link to a GIF / video file (.gif, .mp4, .webm)');
  if (vid && !list) { const bad = probeMessage(await probeYoutube(vid)); if (bad) throw new Error(bad); }
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
ipcMain.handle('live:stop', (_e, target) => { stopLive(target || 'all'); return true; });
ipcMain.handle('live:search', (_e, opts) => (sources[opts.source] || sources.pexelsVideo)(opts));
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
// GIFs and videos can also come from drag-and-drop or from a link to the file itself
const LIVE_FILE = /\.(mp4|webm|gif|mov|m4v|mkv)$/i;
ipcMain.handle('live:importPaths', (_e, paths) => {
  const c = loadCfg(), lib = [...c.library]; let added = 0; fs.mkdirSync(liveDir(), { recursive: true });
  for (const p of paths || []) {
    if (typeof p !== 'string' || !LIVE_FILE.test(p) || !fs.existsSync(p)) continue;
    const id = 'my-' + Date.now() + '-' + added, dest = path.join(liveDir(), id + path.extname(p));
    fs.copyFileSync(p, dest); lib.push({ id, title: path.basename(p).slice(0, 120), file: dest }); added++;
  }
  saveCfg({ ...c, library: lib }); return { added };
});
async function importFromUrl(link) {
  const url = String(link).trim();
  if (/(tenor\.com\/view|giphy\.com\/gifs\/|imgur\.com\/(gallery|a)\/)/i.test(url)) throw new Error('That is a web page, not the GIF file itself. Right-click the GIF, choose "Copy image address", and paste that link here.');
  let r; try { r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(180000) }); } catch { throw new Error('Could not reach that link. Check it and your internet.'); }
  if (!r.ok) throw new Error('Could not download that link (' + r.status + ').');
  const ct = r.headers.get('content-type') || '', len = +r.headers.get('content-length') || 0;
  if (!/image\/gif|video\/(webm|mp4)|octet-stream/i.test(ct)) throw new Error('That link is not a GIF or video file (it is ' + (ct.split(';')[0] || 'unknown') + ').');
  if (len > 400 * 1024 * 1024) throw new Error('That file is too big (over 400 MB).');
  const ext = /gif/.test(ct) ? 'gif' : /webm/.test(ct) ? 'webm' : /mp4/.test(ct) ? 'mp4' : ((url.split('?')[0].match(/\.(gif|mp4|webm)$/i) || [0, 'gif'])[1]).toLowerCase();
  const id = 'my-' + Date.now(), dest = path.join(liveDir(), id + '.' + ext); fs.mkdirSync(liveDir(), { recursive: true });
  try { await require('stream/promises').pipeline(require('stream').Readable.fromWeb(r.body), fs.createWriteStream(dest + '.part')); fs.renameSync(dest + '.part', dest); }
  catch { try { fs.unlinkSync(dest + '.part'); } catch {} throw new Error('The download was interrupted. Try again.'); }
  let title = 'Downloaded GIF'; try { title = decodeURIComponent(new URL(url).pathname.split('/').pop() || title); } catch {}
  const entry = { id, title: title.slice(0, 100), file: dest }, c = loadCfg();
  saveCfg({ ...c, library: [...c.library, entry] }); return entry;
}
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
    { type: 'separator' },
    { label: 'Performance overlay: show / hide  (Ctrl+Shift+P)', click: () => overlaySet(!(loadCfg().overlay && loadCfg().overlay.on)) },
    { label: 'Music: play / pause', click: () => audioToggle() },
    { label: 'Music: next track', click: () => { if (audioCfg().tracks.length) audioPlayIndex(audioIdx + 1); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }]));
  tray.on('click', () => win.show());
  win.on('close', (e) => {
    const c = loadCfg();
    if ((c.autoMinutes > 0 || c.live || audioPlaying) && !app.isQuitting) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => app.quit()); // hidden helper windows (music) must not keep the app alive
  schedule();
  if (loadCfg().updateCheck !== false) { setTimeout(() => checkUpdate(false), 15000); setInterval(() => { if (loadCfg().updateCheck !== false) checkUpdate(false); }, 12 * 3600 * 1000); }
  globalShortcut.register('CommandOrControl+Shift+P', () => overlaySet(!(loadCfg().overlay && loadCfg().overlay.on))); // show / hide the performance overlay
  if (loadCfg().overlay && loadCfg().overlay.on) overlayShow();
  const c = loadCfg(), here = monitors();
  // bring back each screen's live wallpaper (older settings only knew one, which belonged on the main screen)
  const saved = c.liveScreens && Object.keys(c.liveScreens).length ? c.liveScreens : (c.live ? { [(here.find((m) => m.primary) || here[0]).key]: c.live } : {});
  for (const [key, item] of Object.entries(saved)) {
    if (here.some((m) => m.key === key)) startLive(item, key, { persist: false }).catch((e) => console.log('live restore failed:', e.message));
  }
  if (audioCfg().autoplay && audioCfg().tracks.length) audioPlayIndex(audioCfg().index || 0).catch(() => {});
});
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
app.on('before-quit', () => { app.isQuitting = true; killLive(); overlayHide(); statsStop(); globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => app.quit());
