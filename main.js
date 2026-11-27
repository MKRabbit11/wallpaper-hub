// a stray error in any wallpaper process must never pop up an error box over the desktop
process.on('uncaughtException', (e) => { try { console.log('uncaught', e && e.message); } catch {} });
process.on('unhandledRejection', () => {});
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, dialog, desktopCapturer, globalShortcut, shell, Notification, powerMonitor } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

const UA = 'Mozilla/5.0 WallpaperHub/1.0';
const LIVE_ARG = process.argv.find(a => a.startsWith('--live='));
let win, tray, timer, liveWin, watcher, liveKind, liveReady = false, livePausedNow = false;
const liveState = { paused: false, pausedKeys: [], volume: 0, next: 0, shuffle: false, look: null, notifs: [], nv: 0 };
const cssLook = (l) => (l && (l.b !== 100 || l.c !== 100 || l.s !== 100)) ? `brightness(${l.b / 100}) contrast(${l.c / 100}) saturate(${l.s / 100})` : '';
const dataDir = () => path.join(app.getPath('userData'), 'wallpapers');
const liveDir = () => path.join(app.getPath('userData'), 'live');
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
const defaults = { favorites: [], autoMinutes: 0, autoQuery: 'nature', autoSource: 'wallhaven',
  library: [], live: null, liveScreens: {}, target: 'all', pexelsKey: '', pauseOnFullscreen: true, startup: false, liveQuality: 'native', liveFit: 'cover', liveSharp: 'normal', liveLyrics: false, clock: { on: false, style: 'thin', pos: 'bottom-right', size: 100, color: '#ffffff', secs: false, h24: false, date: true, all: false }, ytClean: true, gameThrottle: false, polish: 'off', ytRes: 0, screenType: 'oled', gfx: 'balanced', pauseMaximized: true, pauseAllScreens: true, giphyKey: '', updateCheck: true, updateSeen: '', updateDismissed: '', liveVolume: 0, liveShuffle: false, look: { b: 100, c: 100, s: 100 }, stillCurrent: {}, notif: { on: false, corner: true, pos: 'top-right', secs: 8, volume: 70, defaultSound: 'chime', apps: {}, people: {}, seen: {}, calls: { on: false, pause: true, popup: true, sound: 'ring' } },
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
      const obj = JSON.parse(fs.readFileSync(cfgFile(), 'utf8').replace(/^\uFEFF/, ''));
      if (sanitizeCfg(obj) || st.size > 2 * 1024 * 1024) { fs.writeFileSync(cfgFile(), JSON.stringify(obj, null, 1)); cfgCache = null; return { ...defaults, ...obj }; } // heal a bloated file
      cfgCache = { key, obj };
    }
    return { ...defaults, ...structuredClone(cfgCache.obj) }; // callers edit what they get, so hand out a copy
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ...defaults };
    if (cfgCache) return { ...defaults, ...structuredClone(cfgCache.obj) }; // briefly unreadable (another program has it open): carry on with what we had
    try { // damaged (for example cut short by a power cut): use the last good copy instead of starting from scratch
      const obj = JSON.parse(fs.readFileSync(cfgFile() + '.bak', 'utf8').replace(/^\uFEFF/, ''));
      if (e instanceof SyntaxError) { try { fs.copyFileSync(cfgFile(), cfgFile() + '.damaged'); } catch {} try { fs.writeFileSync(cfgFile(), JSON.stringify(obj, null, 1)); cfgCache = null; } catch {} }
      return { ...defaults, ...obj };
    } catch {}
    return { ...defaults };
  }
};
function backupCfg(why) {
  try {
    const dir = path.join(path.dirname(cfgFile()), 'backups'); fs.mkdirSync(dir, { recursive: true });
    const raw = fs.readFileSync(cfgFile(), 'utf8').replace(/^\uFEFF/, ''); JSON.parse(raw); // only ever back up a file that reads fine
    const names = fs.readdirSync(dir).filter((n) => /^config-.*\.json$/.test(n)).sort(), last = names.length ? fs.readFileSync(path.join(dir, names[names.length - 1]), 'utf8') : null;
    if (last === raw) return; // nothing changed since the last backup
    const d = new Date(), z = (n) => String(n).padStart(2, '0');
    fs.writeFileSync(path.join(dir, 'config-' + d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes()) + '.json'), raw);
    for (const n of names.slice(0, Math.max(0, names.length + 1 - 14))) fs.unlinkSync(path.join(dir, n));
  } catch (e) { console.log('settings backup failed (' + (why || '') + '):', e.message); }
}
const saveCfg = (c) => { // written to a temporary file first, then swapped in, so a crash or power cut can never leave half a file; the last good copy is kept as config.json.bak
  sanitizeCfg(c); const f = cfgFile(), data = JSON.stringify(c, null, 1);
  try { fs.writeFileSync(f + '.tmp', data); fs.renameSync(f + '.tmp', f); } catch { fs.writeFileSync(f, data); }
  cfgCache = null; try { fs.copyFileSync(f, f + '.bak'); } catch {}
};

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

// where a picture was found: the website's name and the address of the page it came from (only web addresses are kept)
// which picture types a Whole web search keeps: 'all' (anything, even without a file ending) or one kind
const TYPE_RX = { jpg: /\.jpe?g(\?|#|$)/i, png: /\.png(\?|#|$)/i, webp: /\.webp(\?|#|$)/i, gif: /\.gif(\?|#|$)/i };
const typeOk = (u, types) => !types || types === 'all' ? /^https?:\/\//i.test(u) : !!(TYPE_RX[types] && TYPE_RX[types].test(u));
async function commonsPhotos(q, page, types) { // photos from Wikimedia Commons (free to use), page by page
  const u = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=30&gsroffset=' + (((page || 1) - 1) * 30) + '&gsrsearch=' + encodeURIComponent(q + ' filetype:bitmap') + '&prop=imageinfo&iiprop=url|mime|size&iiurlwidth=480';
  const j = await getJson(u, { 'User-Agent': WM_UA }), pages = Object.values((j.query && j.query.pages) || {}).sort((a, b) => a.index - b.index), out = [];
  for (const p of pages) { const i = p.imageinfo && p.imageinfo[0]; if (!i || !/^image\/(jpeg|png|webp)$/.test(i.mime) || !/^https:/.test(i.url) || !typeOk(i.url, types)) continue;
    out.push({ id: 'web-' + require('crypto').createHash('md5').update(i.url).digest('hex').slice(0, 12), thumb: i.thumburl || i.url, full: i.url, title: p.title.replace(/^File:/, '').replace(/\.[a-z]+$/i, '').slice(0, 80), res: i.width + 'x' + i.height, source: { name: 'commons.wikimedia.org', url: i.descriptionurl || 'https://commons.wikimedia.org/' } }); }
  return out;
}
const SIZES = ['', '+filterui:imagesize-wallpaper', '+filterui:imagesize-extralarge', '+filterui:imagesize-large', '+filterui:imagesize-medium', '+filterui:imagesize-small'], SHAPES = ['', '+filterui:aspect-wide', '+filterui:aspect-tall', '+filterui:aspect-square'];
const KINDS = ['+filterui:photo-photo', '+filterui:photo-clipart', '+filterui:photo-linedrawing', '+filterui:photo-transparent'], COLORS = ['RED', 'ORANGE', 'YELLOW', 'GREEN', 'TEAL', 'BLUE', 'PURPLE', 'PINK', 'BROWN', 'BLACK', 'GRAY', 'WHITE'];
const BING_SLICES = (() => { const out = ['']; for (const k of KINDS) out.push(k); for (const c of COLORS) out.push('+filterui:color2-FGcls_' + c); out.push('+filterui:color2-bw');
  for (const s of SIZES) for (const a of SHAPES) if (s || a) out.push(s + a);
  for (const c of COLORS.concat(['bw'])) for (const a of SHAPES.slice(1)) out.push((c === 'bw' ? '+filterui:color2-bw' : '+filterui:color2-FGcls_' + c) + a);
  for (const k of KINDS.slice(0, 3)) for (const s of ['+filterui:imagesize-large', '+filterui:imagesize-medium']) out.push(k + s);
  return [...new Set(out)]; })();
// "Search wider": Bing's own suggested related searches (its public suggestion list, two levels deep) are searched too
const relCache = new Map();
function relatedQueries(q) {
  const key = q.toLowerCase(); if (relCache.has(key)) return relCache.get(key);
  const sug = async (s) => { try { const r = await fetch('https://api.bing.com/qsonhs.aspx?type=json&q=' + encodeURIComponent(s), { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' }, signal: AbortSignal.timeout(8000) }); const j = await r.json(); const res = (j && j.AS && j.AS.Results) || []; const out = []; for (const x of res) for (const g of (x.Suggests || [])) if (g && typeof g.Txt === 'string') out.push(g.Txt); return out; } catch { return []; } };
  const p = (async () => { const first = await sug(q), all = new Set(first); const deeper = await Promise.all(first.slice(0, 10).map(sug)); deeper.forEach((l) => l.forEach((x) => all.add(x))); all.delete(q); return [...all].filter((x) => x.toLowerCase() !== key).slice(0, 40); })();
  relCache.set(key, p); setTimeout(() => relCache.delete(key), 600000); return p;
}
const BING_PAGED = 30, UA_MOBILE = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Mobile Safari/537.36';
const bingStep = (page, content, rel, paging) => { const p = Math.max(1, page || 1); if (paging || p <= BING_PAGED) return { qft: '', word: '', first: (p - 1) * 35, mobile: true };
  const i = p - BING_PAGED, n = content === 'all' ? BING_SLICES.length : 1; if (i < n) return { qft: BING_SLICES[i], word: '' };
  const j = i - n, per = content === 'all' ? 6 : 1, total = (rel ? rel.length : 0) * per;
  if (j < total) return { q: rel[Math.floor(j / per)], qft: content === 'all' ? BING_SLICES[j % per] : '', word: '' };
  return { qft: '', word: MORE_WORDS[(j - total) % MORE_WORDS.length] }; };
const MORE_WORDS = ['wallpaper', 'hd', '4k', '8k', 'ultra hd', 'background', 'aesthetic', 'dark', 'art', 'desktop', 'wide', 'photo', 'abstract', 'pictures', 'images', 'collection', 'best', 'cool', 'free', 'beautiful', 'amazing', 'minimal', 'neon', 'vintage', 'retro', 'anime', 'cartoon', 'realistic', '3d', 'painting', 'drawing', 'sketch', 'illustration', 'digital art', 'black and white', 'colorful', 'blue', 'red', 'green', 'yellow', 'purple', 'orange', 'pink', 'gold', 'silver', 'white', 'black', 'night', 'sunset', 'sunrise', 'snow', 'rain', 'sky', 'clouds', 'forest', 'ocean', 'city', 'space', 'fantasy', 'scary', 'cute', 'funny', 'epic', 'dramatic', 'vector', 'poster', 'cover', 'banner', 'phone', 'mobile', 'tablet', '1920x1080', '3840x2160', 'portrait', 'landscape', 'square', 'close up', 'top view', 'old', 'new', 'famous', 'real', 'drawn', 'fan art', 'game', 'movie', 'logo', 'icon'];
async function commonsGifs(q, page) { // real animated GIFs (Wikimedia Commons, Creative Commons / public domain)
  const u = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=20&gsroffset=' + (((page || 1) - 1) * 20) + '&gsrsearch=' + encodeURIComponent(q + ' incategory:"Animated GIF files"') + '&prop=imageinfo&iiprop=url|mime&iiurlwidth=480';
  const j = await getJson(u, { 'User-Agent': WM_UA }), pages = Object.values((j.query && j.query.pages) || {}).sort((a, b) => a.index - b.index), out = [];
  for (const p of pages) { const i = p.imageinfo && p.imageinfo[0]; if (!i || i.mime !== 'image/gif' || !/^https:/.test(i.url)) continue;
    out.push({ id: 'web-' + require('crypto').createHash('md5').update(i.url).digest('hex').slice(0, 12), thumb: i.thumburl || i.url, full: i.url, title: p.title.replace(/^File:/, '').replace(/\.gif$/i, '').slice(0, 80), res: 'animated GIF', anim: true, source: { name: 'commons.wikimedia.org', url: i.descriptionurl || 'https://commons.wikimedia.org/' } }); }
  return out;
}
function topicKeep(list, q, match) { // keeps pictures whose title / address mention the searched words (Wallhaven ones are tag matches already)
  if (match === 'off') return list;
  const nrm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const STOPW = new Set(['the', 'and', 'for', 'with', 'from', 'wallpaper', 'wallpapers', 'background', 'backgrounds', 'picture', 'pictures', 'image', 'images', 'photo', 'photos', 'pics', 'free', 'best', 'new', 'hd', '4k', '8k']);
  const toks = nrm(q).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOPW.has(w)).map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w));
  if (!toks.length) return list; const need = match === 'any' ? 1 : (toks.length <= 3 ? toks.length : Math.ceil(toks.length * 0.75));
  return list.filter((x) => String(x.id || '').startsWith('wh-') || toks.filter((w) => nrm((x.title || '') + ' ' + (x.full || '') + ' ' + ((x.source && x.source.url) || '')).includes(w)).length >= need);
}
async function openversePage(q, page, mature) {
  if (page > 12) return []; // the public search gives up to 12 pages of 20
  const j = await getJson('https://api.openverse.org/v1/images/?q=' + encodeURIComponent(q) + '&page_size=20&page=' + page + (mature ? '&mature=true' : ''), { 'User-Agent': 'WallpaperHub/1.0 (desktop wallpaper app)' });
  return (j.results || []).filter((x) => x.url && /^https?:/.test(x.url)).map((x) => ({ id: 'ov-' + x.id, thumb: x.thumbnail || x.url, full: x.url, title: String(x.title || '').slice(0, 80), res: x.width ? x.width + 'x' + x.height : 'web', pxw: x.width || 0, pxh: x.height || 0,
    source: { name: (x.provider || 'openverse') + ' (via Openverse)', url: x.foreign_landing_url || x.url } }));
}
async function webExtra(o) {
  const k = Math.max(1, +o.extra || 1) - 1, kind = k % 4, idx = Math.floor(k / 4), q = o.query;
  const nrm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  let list = [];
  if (kind === 0) { // one of Bing's own suggested related searches (its first two pages), else a related word
    const rel = o.wider === false ? [] : await relatedQueries(q).catch(() => []), rq = rel[idx];
    if (rq) { const r = await Promise.all([1, 2, 3].map((pg) => sources.web({ ...o, extra: undefined, query: rq, page: pg, color: o.color }).catch(() => []))); list = [].concat(...r); }
    else list = await sources.web({ ...o, extra: undefined, wider: false, xraw: BING_PAGED + 300 + idx }).catch(() => []);
  } else if (kind === 1) { // Wallhaven (every word required) and Wikimedia Commons
    const whq = nrm(q).split(/[^a-z0-9]+/).filter((w) => w.length >= 2).map((w) => '+' + w).join(' ') || q;
    const wh = await sources.wallhaven({ query: whq, page: idx + 1, sorting: 'relevance', content: o.content, color: o.color }).catch(() => []); const cm = []; // (Wikimedia Commons left out: its matches by words were often a different thing with the same name)
    list = wh.concat(cm);
  } else if (kind === 3) { list = await openversePage(q, idx + 1).catch(() => []); if (!list.length) list = await sources.web({ ...o, extra: undefined, wider: false, xraw: BING_PAGED + 600 + idx }).catch(() => []); }
  else list = await sources.web({ ...o, extra: undefined, wider: false, xraw: BING_PAGED + 1 + idx }).catch(() => []); // a Bing filter slice (size, shape, colour, kind)
  return topicKeep(list, q, o.match);
}
const WH_COLORS = { red: 'cc0000', orange: 'ff6600', yellow: 'ffff00', green: '77cc33', teal: '66cccc', blue: '0066cc', purple: '663399', pink: 'ea4c88', brown: '996633', black: '000000', gray: '999999', white: 'ffffff' };
const BING_COLOR = Object.fromEntries(Object.keys(WH_COLORS).map((k) => [k, '+filterui:color2-' + (k === 'black' || k === 'white' || k === 'gray' ? 'FGcls_' + k.toUpperCase() : 'FGcls_' + k.toUpperCase())])); BING_COLOR.bw = '+filterui:color2-bw';
// ---- Whole web, pushed further (Nov 2026) ----
// Stock-photo sites put a watermark over their pictures (and only sell the clean one): they are left out of Whole web unless you ask for them.
const STOCK_RX = /(^|\.)(shutterstock|dreamstime|alamy|istockphoto|gettyimages|depositphotos|123rf|stock\.adobe|adobestock|vecteezy|freepik|canstockphoto|bigstockphoto|pond5|agefotostock|superstock|fotolia|colourbox|stockfreeimages|featurepics|megapixl|crushpixel|yayimages|panthermedia|masterfile|stocksy|eyeem|photodune|envato|storyblocks|stockvault|pikbest|pngtree|lovepik|zcool|gograph|clipdealer|fotosearch|mostphotos|wirestock)\./i;
const isStock = (it) => { const h = String((it && it.source && it.source.name) || ''), u = String((it && it.full) || ''); return STOCK_RX.test(h + '.') || /(^https?:\/\/)?[^/]*(shutterstock|dreamstime|alamy|istockphoto|gettyimages|depositphotos|123rf|vecteezy|freepik)\./i.test(u); };
// DeviantArt: artists' own work (its public search feed); adult works only when Content is set to Everything
async function deviantartPage(q, page, content, tall) {
  const r = await fetch('https://backend.deviantart.com/rss.xml?type=deviation&q=' + encodeURIComponent(q) + '&offset=' + (((page || 1) - 1) * 60), { headers: { 'User-Agent': WM_UA }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) return []; const x = await r.text(), out = [], dec = (t) => String(t || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  for (const it of x.split('<item>').slice(1)) {
    const rating = (it.match(/<media:rating>(\w*)</) || [])[1] || ''; if (content !== 'all' && rating !== 'nonadult') continue;
    const m = it.match(/<media:content url="([^"]+)"[^>]*height="(\d+)"[^>]*width="(\d+)"[^>]*medium="image"/); if (!m) continue;
    const th = (it.match(/<media:thumbnail url="([^"]+)"[^>]*height="(\d+)"/g) || []).map((t) => dec((t.match(/url="([^"]+)"/) || [])[1])).pop() || dec(m[1]);
    const link = dec((it.match(/<link>([^<]+)</) || [])[1] || ''), full = dec(m[1]), w = +m[3], h = +m[2]; if (!tall && w < h * 0.9) continue; // landscape or square only (unless "include tall pictures" is on)
    out.push({ id: 'da-' + require('crypto').createHash('md5').update(link || full).digest('hex').slice(0, 12), thumb: th, full, pxw: w, pxh: h, res: w + 'x' + h, title: dec((it.match(/<title>([^<]*)</) || [])[1] || '').slice(0, 80), source: { name: 'deviantart.com', url: /^https:\/\//.test(link) ? link : 'https://www.deviantart.com/' } });
  }
  return out;
}
// Picture fingerprints: the same picture is often found on many sites (other address, other size). A tiny 9x8 grey copy of each thumbnail
// gives a 64-bit "difference hash"; two pictures whose hashes differ in only a few bits are the same picture.
const phCache = new Map(); let phRun = 0; const phQ = [];
const phSlot = () => new Promise((res) => { if (phRun < 16) { phRun++; res(); } else phQ.push(res); }), phDone = () => { const n = phQ.shift(); if (n) n(); else phRun--; };
async function pictureHash(url) {
  if (phCache.has(url)) return phCache.get(url);
  await phSlot();
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null; const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > 4 * 1024 * 1024) return null;
    let img = nativeImage.createFromBuffer(buf); if (img.isEmpty()) return null;
    const sz = img.getSize(); if (sz.width > 64) img = img.resize({ width: 64, quality: 'good' }); // a soft step first, so the 9x8 copy is an average, not a sample
    const bm = img.resize({ width: 9, height: 8, quality: 'good' }).toBitmap(); if (bm.length < 9 * 8 * 4) return null;
    const g = []; for (let i = 0; i < 72; i++) g.push(bm[i * 4] * 0.114 + bm[i * 4 + 1] * 0.587 + bm[i * 4 + 2] * 0.299); // (BGRA)
    let hex = '', nib = 0, nb = 0; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { nib = (nib << 1) | (g[y * 9 + x] > g[y * 9 + x + 1] ? 1 : 0); if (++nb === 4) { hex += nib.toString(16); nib = 0; nb = 0; } }
    if (phCache.size > 5000) phCache.delete(phCache.keys().next().value); phCache.set(url, hex); return hex;
  } catch { return null; } finally { phDone(); }
}
const smallThumb = (u) => /\.mm\.bing\.net\/th\?/.test(u || '') ? String(u).replace(/([?&])w=\d+/, '$1w=96').replace(/([?&])h=\d+/, '$1h=96') : u;
ipcMain.handle('web:hashes', async (_e, list) => { if (gameNetQuiet()) return {}; const out = {}; await Promise.all((Array.isArray(list) ? list.slice(0, 120) : []).map(async (x) => { if (x && typeof x.thumb === 'string' && /^https?:/.test(x.thumb)) out[x.id] = await pictureHash(smallThumb(x.thumb)); })); return out; });
const srcOf = (u) => { try { const x = new URL(u); if (!/^https?:$/.test(x.protocol)) return undefined; return { name: x.hostname.replace(/^www\./, ''), url: x.href }; } catch { return undefined; } };
const sources = {
  async wallhaven({ query, page, sorting, ratio, atleast, content, color }) {
    // "Best match" needs a search word; with an empty search show the top wallpapers instead
    const sim = /^similar:([a-z0-9]{4,10})$/i.exec(String(query || '').trim()); let skip = null;
    if (sim) { // 'Similar': this picture's own most telling tags plus its main colour (Wallhaven's own like: search is behind a browser check)
      const w = (await getJson('https://wallhaven.cc/api/v1/w/' + sim[1])).data, GEN = /^(digital art|artwork|simple background|dark background|ultrawide|standing|group of people|people|men|women|glowing|wallpaper|4k|anime girls|minimalism|text|logo|watermarked)$/i;
      const tags = (w.tags || []).filter((t) => !GEN.test(t.name)).slice(0, 3); skip = 'wh-' + w.id;
      const vivid = (w.colors || []).find((c) => !/^#(000000|424153|999999|cccccc|ffffff|333399|663300)$/i.test(c)); if (vivid && !color) color = Object.keys(WH_COLORS).find((k) => '#' + WH_COLORS[k] === vivid.toLowerCase()) || null; if (vivid && !color) var simHex = vivid.slice(1);
      // one search per tag (Wallhaven wants every word of one search), taken in turns so the closest matches of each come first
      const lists = await Promise.all((tags.length ? tags : (w.tags || []).slice(0, 1)).map((t) => sources.wallhaven({ query: 'id:' + t.id, page, sorting: 'relevance', ratio, atleast, content, color: color || undefined }).catch(() => [])));
      const out = [], seen = new Set([skip]); for (let i = 0; i < 24; i++) for (const l of lists) { const x = l[i]; if (x && !seen.has(x.id)) { seen.add(x.id); out.push(x); } }
      return out; }
    if (!sorting || (sorting === 'relevance' && !query)) sorting = 'toplist';
    const p = new URLSearchParams({ q: query || '', page: page || 1, sorting, purity: content === 'all' ? '110' : '100', categories: '111', });
    if (atleast) p.set('atleast', atleast); // no minimum size unless one is chosen // 'all' adds Wallhaven's "sketchy" level (its strictest level needs a Wallhaven account key)
    if (ratio) p.set('ratios', ratio);
    if (WH_COLORS[color]) p.set('colors', WH_COLORS[color]); else if (typeof simHex === 'string') p.set('colors', simHex); // one of Wallhaven's own colour swatches
    if (sorting === 'toplist') p.set('topRange', '1y');
    const j = await getJson('https://wallhaven.cc/api/v1/search?' + p);
    return j.data.filter((w) => 'wh-' + w.id !== skip).map(w => ({ id: 'wh-' + w.id, thumb: w.thumbs.large, full: w.path, res: w.resolution, pxw: +w.dimension_x || 0, pxh: +w.dimension_y || 0, source: { name: 'wallhaven.cc', url: w.url } }));
  },
  // Wider web: Bing Image Search (wallpaper-sized, wide, safe search on)
  async web({ query, page, content, types, wider, atleast, match, extra, xraw, variant, vpage, color }) {
    if (extra != null) return webExtra({ query, content, types, wider, atleast, match, extra, color });
    if (xraw != null) page = xraw;
    if (variant) page = 100000 + (+vpage || 1); // (keeps the page-1 extras below from running again)
    const paging = xraw == null;
    if (!query) return [];
    const q = query; // searched exactly as typed (no "wallpaper" added)
    const UAW = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', ck = 'SRCHHPGUSR=ADLT=' + (content === 'all' ? 'OFF' : 'STRICT');
    const dec = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const seen = new Set();
    const rel = !paging && wider === true && (page || 1) > BING_PAGED + (content === 'all' ? BING_SLICES.length : 1) ? await relatedQueries(query).catch(() => []) : [];
    const step = variant ? { qft: String(variant.qft || ''), word: '', first: ((+vpage || 1) - 1) * 35, mobile: true, mkt: /^[a-z]{2}-[A-Z]{2}$/.test(variant.mkt || '') ? variant.mkt : '' } : bingStep(page, content, rel, paging);
    const nrm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const STOPW = new Set(['the', 'and', 'for', 'with', 'from', 'wallpaper', 'wallpapers', 'background', 'backgrounds', 'picture', 'pictures', 'image', 'images', 'photo', 'photos', 'pics', 'free', 'best', 'new', 'hd', '4k', '8k']);
    const qtoks = nrm(q).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOPW.has(w)).map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w));
    const need = match === 'off' ? 0 : match === 'any' ? Math.min(1, qtoks.length) : (qtoks.length <= 3 ? qtoks.length : Math.ceil(qtoks.length * 0.75));
    const onTopic = (j) => !qtoks.length || need === 0 || paging || (() => { const h = nrm((j.t || '') + ' ' + (j.desc || '') + ' ' + (j.purl || '') + ' ' + (j.murl || '')); return qtoks.filter((w) => h.includes(w)).length >= need; })();
    const ask = async (qft, anim, forceDesk) => { // one Bing picture search (one filter slice or one related word)
      const url = 'https://www.bing.com/images/async?q=' + encodeURIComponent(step.q ? step.q : step.word ? q + ' ' + step.word : q) + (step.mkt ? '&setmkt=' + step.mkt + '&setlang=' + step.mkt.split('-')[0] : '') + '&first=' + (forceDesk ? 0 : (step.first || 0)) + (step.mobile && !forceDesk ? '&count=35' : '&count=40') + ((qft || BING_COLOR[color]) ? '&qft=' + encodeURIComponent((qft || '') + (BING_COLOR[color] && !/color2/.test(qft || '') ? BING_COLOR[color] : '')) : '') + '&mmasync=1';
      const r = await fetch(url, { headers: { 'User-Agent': step.mobile && !forceDesk ? UA_MOBILE : UAW, Cookie: ck } });
      if (!r.ok) { if (anim || page > 1) return []; throw new Error('Web search returned ' + r.status); }
      const html = await r.text(), out = [];
      const all = [...html.matchAll(/class="iusc"[^>]*\sm="([^"]+)"/g)];
      for (let mi = 0; mi < all.length; mi++) {
        const m = all[mi];
        try {
          const j = JSON.parse(dec(m[1]));
          const seg = html.slice(m.index, mi + 1 < all.length ? all[mi + 1].index : m.index + 4000), sz = seg.match(/(\d{3,5})\s*(?:x|&#215;|\u00d7)\s*(\d{3,5})/i), pxw = sz ? +sz[1] : 0, pxh = sz ? +sz[2] : 0;
          if (atleast && pxw) { const [aw, ah] = String(atleast).split('x').map(Number); if (pxw < aw || pxh < ah) continue; } // too small for the size you chose
          if (!j.murl || !j.turl || seen.has(j.murl) || !typeOk(j.murl, anim ? 'all' : types) || !onTopic(j)) continue; // (pictures Windows cannot use directly are converted when applied)
          seen.add(j.murl);
          const gif = anim || /\.gif(\?|#|$)/i.test(j.murl);
          out.push({ id: 'web-' + require('crypto').createHash('md5').update(j.murl).digest('hex').slice(0, 12), thumb: /\.mm\.bing\.net\/th\?/.test(j.turl) && !/[?&]w=/.test(j.turl) ? j.turl + '&w=560&c=0&rs=1&qlt=88' : j.turl, full: j.murl, pxw, pxh,
            title: (j.t || '').replace(/<[^>]+>/g, '').slice(0, 80), res: gif ? 'animated GIF' : (pxw ? pxw + 'x' + pxh : 'web'), anim: gif || undefined, source: srcOf(j.purl || j.murl) });
        } catch {}
      }
      return out;
    };
    // animated GIFs are searched for as well (they play as live wallpapers), unless one still-picture type was chosen
    const wantAnim = !types || types === 'all' || types === 'gif', wantStill = types !== 'gif';
    const [still, anim, photos, desk1] = await Promise.all([wantStill ? ask(step.qft, false) : [], types === 'gif' && page <= 8 ? commonsGifs(q, page).catch(() => []) : [], [], (page || 1) === 1 && wantStill ? ask('', false, true).catch(() => []) : []]);
    if (desk1 && desk1.length) still.push(...desk1);
    const n1 = BING_PAGED + (content === 'all' ? BING_SLICES.length : 1), deep = !paging && (page || 1) > n1, ex = deep ? (page - n1) : 0;
    const [wh, cm] = deep && wantStill ? await Promise.all([sources.wallhaven({ query: nrm(q).split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !STOPW.has(w)).map((w) => '+' + w).join(' ') || q, page: ex, sorting: 'relevance', content }).catch(() => []), Promise.resolve([])]) : [[], []];
    const topicOnly = (l) => l.filter((x) => { const h = nrm((x.title || '') + ' ' + (x.full || '') + ' ' + ((x.source && x.source.url) || '')); return !qtoks.length || need === 0 || qtoks.filter((w) => h.includes(w)).length >= need; });
    still.push(...wh, ...topicOnly(cm));
    return still.concat(photos, anim);
  },
  async deviantart({ query, page, content, tall }) { if (!query) return []; return deviantartPage(query, page, content, !!tall).catch(() => []); },
  async openverse({ query, page, mature, content }) { if (!query) return []; return openversePage(query, page || 1, !!mature && content === 'all').catch(() => []); },
  async bing({ page }) {
    const j = await getJson(`https://www.bing.com/HPImageArchive.aspx?format=js&idx=${((page || 1) - 1) * 8}&n=8&mkt=en-US`);
    return j.images.map(i => ({ id: 'bing-' + i.hsh, thumb: 'https://www.bing.com' + i.urlbase + '_640x360.jpg', full: 'https://www.bing.com' + i.urlbase + '_UHD.jpg', res: '3840x2160', title: i.title, source: { name: 'bing.com (Bing Daily)', url: i.copyrightlink && /^https?:/.test(i.copyrightlink) ? i.copyrightlink : 'https://www.bing.com/' } }));
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
  // MotionBGs: thousands of free 4K/HD animated wallpapers. Only the public listing pages are read; nothing downloads until you click Apply.
  async motionbgs({ query, tag, page }) {
    page = Math.max(1, Math.min(50, +page || 1));
    const get = async (u) => { const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) }); return r; };
    let r;
    if (!query && /^[a-z0-9-]{1,40}$/.test(String(tag || ''))) r = await get('https://motionbgs.com/tag:' + tag + '/' + (page > 1 ? page + '/' : '')); // a whole category, like Games or Minecraft
    else if (query) {
      r = await get('https://motionbgs.com/search?q=' + encodeURIComponent(query.slice(0, 60)));
      if (page > 1 && r.ok && /^https:\/\/motionbgs\.com\/tag:[^/?#]+\/?$/.test(r.url)) r = await get(r.url.replace(/\/?$/, '/') + page + '/'); // the search lands on a tag page; later pages are /tag:name/2/
      else if (page > 1) { r = await get('https://motionbgs.com/search?q=' + encodeURIComponent(query.slice(0, 60)) + '&page=' + page); if (r.ok && !r.url.includes('page=' + page)) return []; } // a plain search has pages too (?page=2, 3...)
    } else r = await get('https://motionbgs.com/4k/' + (page > 1 ? page + '/' : ''));
    if (r.status === 404) return [];
    if (!r.ok) throw new Error('motionbgs.com returned ' + r.status);
    if (!/^https:\/\/motionbgs\.com\//.test(r.url)) throw new Error('motionbgs.com sent the search somewhere unexpected, so it was stopped.');
    const html = await r.text(), out = [], seen = new Set();
    const dec = (s) => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    for (const chunk of html.split('<a title=').slice(1)) {
      const th = /src=(\/i\/c\/364x205\/media\/(\d{1,7})\/[\w.%-]+\.jpg)(?=[\s>])/.exec(chunk), ti = /<span class=ttl>([^<]{1,120})<\/span>/.exec(chunk), fr = /<span class=frm>\s*([^<]{1,10}?)\s*<\/span>/.exec(chunk);
      if (!th || !ti || seen.has(th[2])) continue; seen.add(th[2]);
      out.push({ id: 'mb-' + th[2], title: dec(ti[1]).trim(), thumb: 'https://motionbgs.com' + th[1], full: 'https://motionbgs.com/dl/' + (fr && /hd/i.test(fr[1]) ? 'hd' : '4k') + '/' + th[2], res: fr ? fr[1] : '', kind: 'video' });
    }
    return out;
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

async function toPng(buf, mime) { // any picture the built-in browser can draw becomes a PNG (a GIF gives its first frame)
  const w = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { offscreen: false, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  try {
    await w.loadURL('data:text/html,<body></body>');
    const b64 = await w.webContents.executeJavaScript('(' + (async (data, mt) => {
      const img = new Image(); img.src = 'data:' + mt + ';base64,' + data; await img.decode();
      let W = img.naturalWidth || 3840, H = img.naturalHeight || 2160; if (/svg/.test(mt) && W < 2000) { H = Math.round(H * 3840 / W); W = 3840; }
      const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').drawImage(img, 0, 0, W, H); return c.toDataURL('image/png').split(',')[1];
    }).toString() + ')(' + JSON.stringify(buf.toString('base64')) + ',' + JSON.stringify(mime) + ')');
    return Buffer.from(b64, 'base64');
  } finally { try { w.destroy(); } catch {} }
}
async function download(item, dir = dataDir(), defExt = 'jpg') {
  fs.mkdirSync(dir, { recursive: true });
  const ext = (item.full.split('?')[0].match(/\.(jpe?g|png|gif|mp4|webm)$/i) || ['', defExt])[1].toLowerCase();
  const file = path.join(dir, item.id + '.' + ext), cvFile = path.join(dir, item.id + '.png');
  if (item.id.startsWith('web-') && fs.existsSync(cvFile)) return cvFile; // (already converted before)
  if (!fs.existsSync(file)) {
    const web = item.id.startsWith('web-');
    const isVideo = /^(mp4|webm|gif)$/i.test(ext), headers = { 'User-Agent': /wikimedia\.org/.test(item.full) ? WM_UA : UA };
    let r;
    try { r = await fetch(item.full, { headers, signal: AbortSignal.timeout(isVideo ? 600000 : 30000) }); } // videos are big: allow up to 10 minutes
    catch { throw new Error(web ? 'That site did not respond. Try another wallpaper.' : 'Download failed. Check your internet and try again.'); }
    if (!r.ok) throw new Error(web ? 'That site blocked the download (' + r.status + '). Try another wallpaper.' : 'Download failed: ' + r.status);
    const ct = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (web && !ct.startsWith('image/')) throw new Error('That link was not an image. Try another wallpaper.');
    if (web && !/^image\/(jpe?g|pjpeg|png)$/.test(ct)) { // WebP, AVIF, GIF, BMP, SVG...: Windows cannot set these, so make a PNG
      try { fs.writeFileSync(cvFile, await toPng(Buffer.from(await r.arrayBuffer()), ct)); return cvFile; } catch { throw new Error('This picture type (' + ct.replace('image/', '') + ') could not be turned into a wallpaper. Try another one.'); }
    }
    // stream to a temporary file and only rename it when complete, so an interrupted download never leaves a broken file
    try {
      await require('stream/promises').pipeline(require('stream').Readable.fromWeb(r.body), fs.createWriteStream(file + '.part'));
      fs.renameSync(file + '.part', file);
    } catch (e) { try { fs.unlinkSync(file + '.part'); } catch {} throw new Error('Download was interrupted. Try again.'); }
  }
  return file;
}

// MotionBGs downloads. The link is rebuilt from a number (never trusted as given), must stay on motionbgs.com, must be a video, is size-capped,
// and the finished file must really start like an MP4/WebM before it is kept. Anything else is deleted and never played.
const MB_DL = /^https:\/\/motionbgs\.com\/dl\/(4k|hd)\/(\d{1,7})$/;
const MB_MAX = 60 * 1024 * 1024; // real wallpapers there are 1-12 MB
// Walks every top-level MP4 box (size + type), so a file that only starts like a video but is built oddly is refused. WebM must start with its EBML marker.
const looksLikeVideo = (file) => {
  try {
    const size = fs.statSync(file).size; if (size < 1024) return false;
    const fd = fs.openSync(file, 'r'), b = Buffer.alloc(16);
    try {
      fs.readSync(fd, b, 0, 16, 0);
      if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return true;
      if (b.toString('latin1', 4, 8) !== 'ftyp') return false;
      let pos = 0, hasMoov = false, hasData = false, n = 0;
      while (pos < size) {
        if (++n > 5000 || size - pos < 8) return false;
        fs.readSync(fd, b, 0, 16, pos);
        let len = b.readUInt32BE(0); const type = b.toString('latin1', 4, 8);
        if (!/^[\x20-\x7e]{4}$/.test(type)) return false;
        if (len === 1) { if (size - pos < 16) return false; const hi = b.readUInt32BE(8), lo = b.readUInt32BE(12); if (hi > 0) return false; len = lo; } else if (len === 0) len = size - pos;
        if (len < 8 || pos + len > size) return false;
        if (type === 'moov') hasMoov = true; if (type === 'mdat') hasData = true;
        pos += len;
      }
      return pos === size && hasMoov && hasData;
    } finally { fs.closeSync(fd); }
  } catch { return false; }
};
// Asks Windows Defender to scan a file: 'clean', 'threat', or 'unavailable' (no Defender, e.g. another antivirus is in charge).
async function avScan(file) {
  const cands = [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Windows Defender', 'MpCmdRun.exe')];
  try { const root = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows Defender', 'Platform'); for (const v of fs.readdirSync(root).sort().reverse()) cands.unshift(path.join(root, v, 'MpCmdRun.exe')); } catch {}
  const exe = cands.find((c) => { try { return fs.existsSync(c); } catch { return false; } });
  if (!exe) return 'unavailable';
  return new Promise((res) => execFile(exe, ['-Scan', '-ScanType', '3', '-File', file, '-DisableRemediation'], { windowsHide: true, timeout: 180000 }, (e) => {
    if (!fs.existsSync(file)) return res('threat'); // real-time protection already removed it
    if (!e) return res('clean');
    res(e.code === 2 ? 'threat' : 'unavailable');
  }));
}
async function mbDownload(link) {
  const mm = MB_DL.exec(link || ''); if (!mm) throw new Error('That is not a MotionBGs wallpaper link.');
  const id = mm[2], dir = liveDir(); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'mb-' + id + '.mp4');
  if (fs.existsSync(file) && looksLikeVideo(file)) return file;
  for (const q of mm[1] === 'hd' ? ['hd'] : ['4k', 'hd']) {
    let r; try { r = await fetch('https://motionbgs.com/dl/' + q + '/' + id, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(600000) }); } catch { continue; }
    let host = ''; try { host = new URL(r.url).hostname; } catch {}
    if (!r.ok || !(host === 'motionbgs.com' || host.endsWith('.motionbgs.com'))) { try { await r.body?.cancel(); } catch {} continue; }
    if (!/^video\/(mp4|webm)/i.test(r.headers.get('content-type') || '') || +(r.headers.get('content-length') || 0) > MB_MAX) { try { await r.body?.cancel(); } catch {} continue; }
    let got = 0; const cap = new (require('stream').Transform)({ transform(c, _e, cb) { got += c.length; cb(got > MB_MAX ? new Error('too big') : null, c); } });
    try {
      await require('stream/promises').pipeline(require('stream').Readable.fromWeb(r.body), cap, fs.createWriteStream(file + '.part'));
      if (!looksLikeVideo(file + '.part')) throw new Error('not a video');
      const av = await avScan(file + '.part');
      if (av === 'threat') { try { fs.unlinkSync(file + '.part'); } catch {} throw Object.assign(new Error('Windows Defender flagged that file, so it was deleted and NOT used. Please pick a different wallpaper.'), { blocked: true }); }
      if (av === 'unavailable') console.log('motionbgs: Defender scan not available, relying on file checks only');
      fs.renameSync(file + '.part', file); return file;
    } catch (e) { try { fs.unlinkSync(file + '.part'); } catch {} if (e && e.blocked) throw e; }
  }
  throw new Error('Could not get that wallpaper from motionbgs.com. Try another one.');
}

// ---- Screens (monitors) ----
// Physical-pixel rectangles, numbered left to right. `key` is Electron's display id (stable, used in the saved settings).
// A screen's key is its monitor model name (for example PG27FF1A). Windows' own display numbers can change after a reboot, which used to make saved
// per-screen settings (playlists, wallpapers) stop matching. Two identical monitors get -2, -3 ... in left-to-right order.
const keyOf = (t) => String(t || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
function monitors() {
  const primary = screen.getPrimaryDisplay().id;
  const list = screen.getAllDisplays().map((d) => {
    const r = screen.dipToScreenRect(null, d.bounds);
    return { did: d.id, base: keyOf(d.label) || 'screen', x: r.x, y: r.y, w: r.width, h: r.height, primary: d.id === primary };
  });
  const seen = {};
  list.sort((a, b) => a.x - b.x || a.y - b.y).forEach((m, i) => { m.n = i + 1; seen[m.base] = (seen[m.base] || 0) + 1; m.key = seen[m.base] > 1 ? m.base + '-' + seen[m.base] : m.base; });
  return list;
}
// Settings saved by older versions under Windows' display numbers are moved to the matching screens (once).
function migrateScreenKeys() {
  const c = loadCfg(), mons = monitors(), valid = new Set(mons.map((m) => m.key)), num = (k) => typeof k === 'string' && /^[0-9]+$/.test(k) && !valid.has(k);
  const secs = ['liveScreens', 'playlists', 'stillCurrent'].filter((k) => c[k] && typeof c[k] === 'object');
  const orphans = []; const add = (k) => { if (num(k) && !orphans.includes(k)) orphans.push(k); };
  for (const sn of secs) Object.keys(c[sn]).forEach(add); add(c.target); if (c.clock) add(c.clock.screen);
  if (!orphans.length) return;
  const map = {}, used = new Set();
  for (const k of orphans) { const m = mons.find((x) => String(x.did) === k); if (m) { map[k] = m.key; used.add(m.key); } } // it is a current display number: exact
  const rest = orphans.filter((k) => !map[k]).sort((a, b) => Number(a) - Number(b)), free = mons.filter((m) => !used.has(m.key));
  if (rest.length && rest.length <= free.length) rest.forEach((k, i) => { map[k] = free[i].key; }); // otherwise unknown: left alone, nothing is deleted
  let changed = false;
  for (const sn of secs) { const o = {}; for (const [k, v] of Object.entries(c[sn])) { const nk = map[k] || k; if (nk !== k) changed = true; if (!(nk in o) || nk === k) o[nk] = v; } c[sn] = o; }
  if (map[c.target]) { c.target = map[c.target]; changed = true; }
  if (c.clock && map[c.clock.screen]) { c.clock = { ...c.clock, screen: map[c.clock.screen] }; changed = true; }
  if (changed) saveCfg(c);
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
  public static string Apply(string file, int x, int y, bool all, int pos) {
    SetProcessDPIAware();
    var d = (IDesktopWallpaper)new DesktopWallpaperCo();
    d.SetPosition(pos); // 4 = fill (default)
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
Write-Output ([WPSet]::Apply($env:WP_FILE, [int]$env:WP_X, [int]$env:WP_Y, ($env:WP_ALL -eq '1'), [int]$env:WP_POS))
`;
// The learned filters were trained on this PC (the pictures that ship with Windows plus the Hub's own saved wallpapers, numbers only are kept)
let ENH_MODEL = null; try { ENH_MODEL = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'raisr2x.json'), 'utf8')); } catch (e) { console.log('enlarger model not found:', e.message); }
// The Hub's own picture enlarger (no download, no AI model): removes JPEG blockiness on the small original, enlarges in steps, sharpens only real edges, adds a whisper of grain
const ENH_LIB = String.raw`// The Hub's own picture enlarger: removes JPEG blockiness and noise on the small original, enlarges in steps, then sharpens ONLY real edges
// (with halo control), so flat areas stay clean. No downloads, no AI model: plain image processing that runs in the app.
function enhanceLib() {
  const cv = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  // 1) edge-preserving smoothing (an approximate bilateral filter) on the small picture: melts the blocky JPEG squares, keeps edges
  function denoise(src, sigmaR) {
    const w = src.width, h = src.height, g = src.getContext('2d'), id = g.getImageData(0, 0, w, h), d = id.data, o = new Uint8ClampedArray(d);
    const R = 2, inv = 1 / (2 * sigmaR * sigmaR), sp = [0.6, 0.85, 1, 0.85, 0.6];
    const lum = new Float32Array(w * h); for (let i = 0, p = 0; i < d.length; i += 4, p++) lum[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x, l0 = lum[p]; let sr = 0, sg = 0, sb = 0, sw = 0;
      for (let dy = -R; dy <= R; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue; for (let dx = -R; dx <= R; dx++) { const xx = x + dx; if (xx < 0 || xx >= w) continue; const q = yy * w + xx, dl = lum[q] - l0, wt = sp[dy + R] * sp[dx + R] * Math.exp(-dl * dl * inv); const i = q * 4; sr += d[i] * wt; sg += d[i + 1] * wt; sb += d[i + 2] * wt; sw += wt; } }
      const i = p * 4; o[i] = sr / sw; o[i + 1] = sg / sw; o[i + 2] = sb / sw;
    }
    for (let i = 0; i < d.length; i += 4) { d[i] = o[i]; d[i + 1] = o[i + 1]; d[i + 2] = o[i + 2]; } g.putImageData(id, 0, 0); return src;
  }
  // 2) enlarge in steps of at most 2x with the best resampling
  function up(src, tw, th) {
    let cur = src, cw = src.naturalWidth || src.width, ch = src.naturalHeight || src.height;
    while (cw * 2 < tw || ch * 2 < th) { const s = cv(Math.min(tw, cw * 2), Math.min(th, ch * 2)), g = s.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(cur, 0, 0, s.width, s.height); cur = s; cw = s.width; ch = s.height; }
    const f = cv(tw, th), g = f.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(cur, 0, 0, tw, th); return f;
  }
  // 3) adaptive sharpening: strong on real edges, none on flat areas, and the result may not overshoot its neighbours (no halos)
  function sharpen(c, amount) {
    const w = c.width, h = c.height, g = c.getContext('2d'), id = g.getImageData(0, 0, w, h), d = id.data, s = new Uint8ClampedArray(d);
    const L = (i) => 0.299 * s[i] + 0.587 * s[i + 1] + 0.114 * s[i + 2];
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4, a = i - 4, b = i + 4, u = i - w * 4, v = i + w * 4;
      const lc = L(i), edge = Math.abs(L(a) - L(b)) + Math.abs(L(u) - L(v)); // how strong an edge is here
      const k = amount * Math.min(1, Math.max(0, (edge - 6) / 40)); if (k <= 0) continue;
      for (let ch = 0; ch < 3; ch++) {
        const cc = s[i + ch], avg = (s[a + ch] + s[b + ch] + s[u + ch] + s[v + ch]) * 0.25;
        let lo = cc, hi = cc; for (const q of [a, b, u, v]) { const t = s[q + ch]; if (t < lo) lo = t; if (t > hi) hi = t; }
        let val = cc + k * 4 * (cc - avg) * 0.5; const m = (hi - lo) * 0.25; val = val < lo - m ? lo - m : val > hi + m ? hi + m : val; d[i + ch] = val < 0 ? 0 : val > 255 ? 255 : val;
      }
    }
    g.putImageData(id, 0, 0); return c;
  }
  // 4) a whisper of fine grain (strongest in the mid-tones): enlarged pictures look "plastic" without it, because the real fine texture is gone
  function grain(c, amp) { const w = c.width, h = c.height, g = c.getContext('2d'), id = g.getImageData(0, 0, w, h), d = id.data; let seed = 1234567;
    for (let i = 0; i < d.length; i += 4) { seed = (seed * 1664525 + 1013904223) >>> 0; const r = ((seed >>> 8) / 8388608) - 1; const l = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255, m = 1 - Math.abs(l - 0.5) * 1.6; const n = r * amp * (m < 0.15 ? 0.15 : m); for (let k = 0; k < 3; k++) { const v = d[i + k] + n; d[i + k] = v < 0 ? 0 : v > 255 ? 255 : v; } }
    g.putImageData(id, 0, 0); return c; }
  // 5) iterative back-projection (a classic super-resolution method): enlarge, shrink the result back, compare with the real small picture, and push the difference back in.
  // The enlarged picture ends up consistent with what the small one really showed, which recovers sharpness that plain enlarging loses.
  function backProject(lr, hr, iters, lambda) {
    const lw = lr.width, lh = lr.height, hw = hr.width, hh = hr.height, lrD = lr.getContext('2d').getImageData(0, 0, lw, lh).data;
    for (let it = 0; it < iters; it++) {
      const dn = cv(lw, lh), dg = dn.getContext('2d'); dg.imageSmoothingEnabled = true; dg.imageSmoothingQuality = 'high'; dg.drawImage(hr, 0, 0, lw, lh);
      const dD = dg.getImageData(0, 0, lw, lh).data, er = cv(lw, lh), eg = er.getContext('2d'), eid = eg.createImageData(lw, lh), e = eid.data;
      for (let i = 0; i < e.length; i += 4) { for (let k = 0; k < 3; k++) { const v = 128 + (lrD[i + k] - dD[i + k]) * 0.5; e[i + k] = v < 0 ? 0 : v > 255 ? 255 : v; } e[i + 3] = 255; }
      eg.putImageData(eid, 0, 0);
      const eu = up(er, hw, hh), eud = eu.getContext('2d').getImageData(0, 0, hw, hh).data, hg = hr.getContext('2d'), hid = hg.getImageData(0, 0, hw, hh), h = hid.data;
      for (let i = 0; i < h.length; i += 4) for (let k = 0; k < 3; k++) { const v = h[i + k] + lambda * (eud[i + k] - 128) * 2; h[i + k] = v < 0 ? 0 : v > 255 ? 255 : v; }
      hg.putImageData(hid, 0, 0);
    }
    return hr;
  }
  // 6) learned filters (trained on this PC): for every kind of local edge, the best small filter to turn a bicubic-enlarged picture into the real big one
  function learned(upc, model) {
    const NA = 24, NS = 3, NC = 3, P = 9, H2 = 4, D = P * P, w = upc.width, h = upc.height, g0 = upc.getContext('2d'), id = g0.getImageData(0, 0, w, h), d = id.data, Yu = new Float32Array(w * h);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) Yu[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; gx[i] = (Yu[i + 1] - Yu[i - 1]) * 0.5; gy[i] = (Yu[i + w] - Yu[i - w]) * 0.5; }
    const W = 3, integ = (f) => { const I = new Float64Array((w + 1) * (h + 1)); for (let y = 0; y < h; y++) { let r = 0; for (let x = 0; x < w; x++) { r += f(y * w + x); I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + r; } } return I; };
    const Ia = integ((i) => gx[i] * gx[i]), Ib = integ((i) => gx[i] * gy[i]), Ic = integ((i) => gy[i] * gy[i]), box = (I, x, y) => I[(y + W + 1) * (w + 1) + x + W + 1] - I[(y - W) * (w + 1) + x + W + 1] - I[(y + W + 1) * (w + 1) + x - W] + I[(y - W) * (w + 1) + x - W];
    const f = model.filters, sT = model.sT;
    for (let y = H2; y < h - H2; y++) for (let x = H2; x < w - H2; x++) {
      if (y < W || x < W || y >= h - W || x >= w - W) continue;
      const a = box(Ia, x, y), b = box(Ib, x, y), c = box(Ic, x, y), disc = Math.sqrt(Math.max(0, (a - c) * (a - c) * 0.25 + b * b)), l1 = (a + c) * 0.5 + disc, l2 = Math.max(0, (a + c) * 0.5 - disc);
      let th = 0.5 * Math.atan2(2 * b, a - c); if (th < 0) th += Math.PI; const ai = Math.min(NA - 1, Math.floor(th / Math.PI * NA)), s = Math.sqrt(l1), coh = (Math.sqrt(l1) - Math.sqrt(l2)) / (Math.sqrt(l1) + Math.sqrt(l2) + 1e-6);
      const bk = (ai * NS + (s < sT[0] ? 0 : s < sT[1] ? 1 : 2)) * NC + (coh < 0.3 ? 0 : coh < 0.6 ? 1 : 2), cc = Yu[y * w + x], fo = bk * D; let sum = 0, k = 0;
      for (let dy = -H2; dy <= H2; dy++) { const o = (y + dy) * w + x - H2; for (let dx = 0; dx < P; dx++) { sum += f[fo + k] * (Yu[o + dx] - cc); k++; } }
      const i = (y * w + x) * 4; for (let ch = 0; ch < 3; ch++) { const v = d[i + ch] + sum; d[i + ch] = v < 0 ? 0 : v > 255 ? 255 : v; }
    }
    g0.putImageData(id, 0, 0); return upc;
  }
  // enlarge by 2x at a time: bicubic, then the learned filters; finally scale to the exact size
  function enlargeLearned(src, tw, th, model) {
    let cur = src, cw = src.naturalWidth || src.width, ch = src.naturalHeight || src.height;
    let first = tw > cw * 1.1 || th > ch * 1.1, didLearn = false; // the learned filters are used for the FIRST doubling only (running them again on their own output looks painted)
    while (first || cw * 1.9 < tw || ch * 1.9 < th) { first = false; const s = cv(cw * 2, ch * 2), g = s.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(cur, 0, 0, s.width, s.height); if (!didLearn) { learned(s, model); didLearn = true; } cur = s; cw = s.width; ch = s.height; }
    const f = cv(tw, th), g = f.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(cur, 0, 0, tw, th); return f;
  }
  return { denoise, up, sharpen, grain, backProject, learned, enlargeLearned, cv };
}
`;
const wholeCache = new Map();
async function wholeFit(file, W, H, mode) { // returns a picture exactly W x H showing the whole of 'file'; the original path if it already has the screen's shape
  let st; try { st = fs.statSync(file); } catch { return file; }
  mode = mode || 'whole'; const enh = loadCfg().enhanceLow !== false;
  const key = file + '|' + st.mtimeMs + '|' + st.size + '|' + W + 'x' + H + '|' + mode + '|' + enh + '|v3'; if (wholeCache.has(key) && fs.existsSync(wholeCache.get(key))) return wholeCache.get(key);
  const w = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  try {
    await w.loadURL('data:text/html,<body></body>');
    const mime = /\.png$/i.test(file) ? 'image/png' : /\.bmp$/i.test(file) ? 'image/bmp' : 'image/jpeg';
    const r = await w.webContents.executeJavaScript('(' + (async (data, mt, W, H, mode, enh, LIB, MODEL) => {
      eval(LIB + ';window.__E=enhanceLib()'); const E = window.__E;
      const img = new Image(); img.src = 'data:' + mt + ';base64,' + data; await img.decode();
      const iw = img.naturalWidth, ih = img.naturalHeight;
      // blockiness out, enlarge in steps, sharpen real edges, a little grain (the strength depends on how much the picture has to grow)
      const enhance = (src, tw, th) => { if (MODEL) { const big = E.enlargeLearned(src, tw, th, MODEL); E.sharpen(big, 0.3); return big; }
        const f = Math.max(tw / src.naturalWidth, th / src.naturalHeight), sc = E.cv(src.naturalWidth, src.naturalHeight); sc.getContext('2d').drawImage(src, 0, 0);
        const big = E.up(sc, tw, th); E.sharpen(big, Math.min(0.6, 0.3 + 0.1 * f)); return big; };
      if (mode === 'fill') { // cover the screen; only worth doing when the picture has to be enlarged
        const cv = Math.max(W / iw, H / ih); if (!enh || cv <= 1.15) return null;
        const big = enhance(img, Math.round(iw * cv), Math.round(ih * cv)), c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
        x.drawImage(big, Math.round((big.width - W) / 2), Math.round((big.height - H) / 2), W, H, 0, 0, W, H); return c.toDataURL('image/png').split(',')[1]; }
      const fit0 = Math.min(W / iw, H / ih), needsUp = enh && fit0 > 1.15;
      if (Math.abs(iw / ih - W / H) < 0.02 && !needsUp) return null; // already the right shape and big enough
      const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
      const cover = Math.max(W / iw, H / ih); x.filter = 'blur(' + Math.round(Math.max(W, H) / 45) + 'px) brightness(0.55)'; x.drawImage(img, (W - iw * cover) / 2, (H - ih * cover) / 2, iw * cover, ih * cover);
      x.filter = 'none'; const fit = Math.min(W / iw, H / ih);
      if (needsUp) { const fg = enhance(img, Math.round(iw * fit), Math.round(ih * fit)); x.drawImage(fg, (W - fg.width) / 2, (H - fg.height) / 2); } else x.drawImage(img, (W - iw * fit) / 2, (H - ih * fit) / 2, iw * fit, ih * fit);
      return c.toDataURL('image/png').split(',')[1];
    }).toString() + ')(' + JSON.stringify(fs.readFileSync(file).toString('base64')) + ',' + JSON.stringify(mime) + ',' + W + ',' + H + ',' + JSON.stringify(mode) + ',' + enh + ',' + JSON.stringify(ENH_LIB) + ',' + JSON.stringify(ENH_MODEL) + ')');
    if (!r) { wholeCache.set(key, file); return file; }
    const dir = path.join(dataDir(), 'whole'); fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) { try { if (Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > 3600e3 * 24) fs.unlinkSync(path.join(dir, f)); } catch {} }
    const out = path.join(dir, require('crypto').createHash('md5').update(key).digest('hex').slice(0, 12) + '.png'); fs.writeFileSync(out, Buffer.from(r, 'base64')); wholeCache.set(key, out); return out;
  } catch (e) { console.log('whole-picture fit failed:', e.message); return file; } finally { try { w.destroy(); } catch {} }
}
async function setWallpaperOn(file, target) {
  const sf = loadCfg().stillFit;
  if ((sf === 'whole' || (sf === 'fill' && loadCfg().enhanceLow !== false)) && /\.(jpe?g|png|bmp)$/i.test(file) && !/[\\/]whole[\\/]/.test(file)) { // "Whole picture": one tailor-made picture per screen (and small pictures are enlarged properly)
    const list = target && target !== 'all' ? [monitorFor(target)].filter(Boolean) : monitors();
    if (list.length) { for (const mm of list) await setWallpaperOnRaw(await wholeFit(file, mm.w, mm.h, sf === 'fill' ? 'fill' : 'whole'), mm.key); return; }
  }
  return setWallpaperOnRaw(file, target);
}
async function setWallpaperOnRaw(file, target) {
  const m = target && target !== 'all' ? monitorFor(target) : null;
  const p = runPs(WALL_PS, { WP_FILE: file, WP_ALL: m ? '0' : '1', WP_X: String(m ? m.x : 0), WP_Y: String(m ? m.y : 0), WP_POS: String(({ center: 0, tile: 1, stretch: 2, fit: 3, fill: 4, span: 5 })[loadCfg().stillFit] ?? 4) });
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

// Brightness / contrast / color for still wallpapers: same maths as the CSS filter used for the previews and the live wallpapers
const lookClean = (l) => { l = l || {}; const cn = (v, lo, hi, d) => Math.max(lo, Math.min(hi, Number.isFinite(+v) && v !== '' && v != null ? +v : d)); return { b: Math.max(50, Math.min(160, +l.b || 100)), c: Math.max(50, Math.min(170, +l.c || 100)), s: Math.max(0, Math.min(220, l.s === 0 ? 0 : +l.s || 100)), h: cn(l.h, -180, 180, 0), sep: cn(l.sep, 0, 100, 0), gray: cn(l.gray, 0, 100, 0), warm: cn(l.warm, -100, 100, 0), blur: cn(l.blur, 0, 40, 0), vig: cn(l.vig, 0, 100, 0), grain: cn(l.grain, 0, 100, 0), ta: cn(l.ta, 0, 100, 0), tint: /^#[0-9a-f]{6}$/i.test(l.tint || '') ? l.tint : '#ff8c3c', flip: !!l.flip, flipv: !!l.flipv }; };
const lookFor = (c, key, id) => { const o = (c.stillLook || {})[key], p = id ? (c.picLooks || {})[id] : null; let l = o ? { ...(c.look || {}), ...o } : c.look; if (p) l = { ...(l || {}), ...p }; return l; };
const stillIdOf = (c, key) => ((c.stillIds || {})[key] || (c.stillIds || {}).all || null); // which picture each screen shows (for its own Colours) // a screen's own effects sit on top of the shared ones
function lookIsNormal(l) { return !l || ((+l.b || 100) === 100 && (+l.c || 100) === 100 && (l.s == null || +l.s === 100) && !+l.h && !+l.sep && !+l.gray && !+l.blur && !+l.vig && !+l.ta && !+l.grain && !l.flip && !l.flipv && !+l.warm); }
function boxBlur(buf, w, h, r) { // three passes of a running-sum box blur, one direction then the other
  if (r < 1) return; const tmp = Buffer.alloc(buf.length), win = r * 2 + 1;
  const pass = (src, dst, horiz) => {
    const len = horiz ? w : h, lines = horiz ? h : w, step = horiz ? 4 : w * 4, lineStep = horiz ? w * 4 : 4;
    for (let ln = 0; ln < lines; ln++) { const base = ln * lineStep;
      for (let ch = 0; ch < 3; ch++) { let sum = 0;
        for (let k = -r; k <= r; k++) sum += src[base + Math.min(len - 1, Math.max(0, k)) * step + ch];
        for (let i = 0; i < len; i++) { dst[base + i * step + ch] = sum / win;
          sum += src[base + Math.min(len - 1, i + r + 1) * step + ch] - src[base + Math.max(0, i - r) * step + ch]; } }
      for (let i = 0; i < len; i++) dst[base + i * step + 3] = src[base + i * step + 3]; }
  };
  for (let n = 0; n < 3; n++) { pass(buf, tmp, true); pass(tmp, buf, false); }
}
// Brightness / contrast / color (+ hue, warm tone, black and white, softness, tint, dark edges, grain, flips) for still wallpapers; same maths as the CSS filter used for the previews and the live wallpapers
function adjustImage(file, l) {
  if (lookIsNormal(l)) { // back to normal: the tinted copies are not needed any more
    try { const dir = path.join(app.getPath('userData'), 'wallpapers', 'adjusted'), tag = require('crypto').createHash('md5').update(file).digest('hex').slice(0, 8) + '-'; for (const f of fs.readdirSync(dir)) if (f.startsWith(tag)) setTimeout(() => fs.unlink(path.join(dir, f), () => {}), 20000); } catch {}
    return file;
  }
  const img = nativeImage.createFromPath(file); if (img.isEmpty()) return file;
  const { width, height } = img.getSize(), buf = Buffer.from(img.toBitmap());
  const num = (v, d) => (Number.isFinite(+v) && v !== '' && v != null ? +v : d);
  const b = num(l.b, 100) / 100, c = num(l.c, 100) / 100, s = num(l.s, 100) / 100, hue = num(l.h, 0), sep = num(l.sep, 0) / 100, gray = num(l.gray, 0) / 100, warm = num(l.warm, 0) / 100,
    vig = num(l.vig, 0) / 100, grain = num(l.grain, 0) / 100, ta = Math.min(0.8, num(l.ta, 0) / 100), blur = num(l.blur, 0);
  if (blur > 0) boxBlur(buf, width, height, Math.max(1, Math.round(blur * width / 1920)));
  const tc = /^#[0-9a-f]{6}$/i.test(l.tint || '') ? [parseInt(l.tint.slice(1, 3), 16), parseInt(l.tint.slice(3, 5), 16), parseInt(l.tint.slice(5, 7), 16)] : [255, 140, 60];
  const m = [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s];
  const hr = hue * Math.PI / 180, cs = Math.cos(hr), sn = Math.sin(hr);
  const H = [0.213 + cs * 0.787 - sn * 0.213, 0.715 - cs * 0.715 - sn * 0.715, 0.072 - cs * 0.072 + sn * 0.928, 0.213 - cs * 0.213 + sn * 0.143, 0.715 + cs * 0.285 + sn * 0.140, 0.072 - cs * 0.072 - sn * 0.283, 0.213 - cs * 0.213 - sn * 0.787, 0.715 - cs * 0.715 + sn * 0.715, 0.072 + cs * 0.928 + sn * 0.072];
  const cl = (v) => v < 0 ? 0 : v > 255 ? 255 : v, doHue = hue !== 0;
  for (let y = 0, i = 0; y < height; y++) {
    const dy = (y / height - 0.5) * 2;
    for (let x = 0; x < width; x++, i += 4) {
      let r = cl((cl(buf[i + 2] * b) - 127.5) * c + 127.5), g = cl((cl(buf[i + 1] * b) - 127.5) * c + 127.5), bl = cl((cl(buf[i] * b) - 127.5) * c + 127.5);
      let r2 = m[0] * r + m[1] * g + m[2] * bl, g2 = m[3] * r + m[4] * g + m[5] * bl, b2 = m[6] * r + m[7] * g + m[8] * bl;
      if (doHue) { const r3 = H[0] * r2 + H[1] * g2 + H[2] * b2, g3 = H[3] * r2 + H[4] * g2 + H[5] * b2; b2 = H[6] * r2 + H[7] * g2 + H[8] * b2; r2 = r3; g2 = g3; }
      if (warm) { r2 += 22 * warm; b2 -= 26 * warm; } // warm (+) or cool (-)
      if (sep > 0) { const sr = 0.393 * r2 + 0.769 * g2 + 0.189 * b2, sg = 0.349 * r2 + 0.686 * g2 + 0.168 * b2, sb = 0.272 * r2 + 0.534 * g2 + 0.131 * b2; r2 += (sr - r2) * sep; g2 += (sg - g2) * sep; b2 += (sb - b2) * sep; }
      if (gray > 0) { const lu = 0.2126 * r2 + 0.7152 * g2 + 0.0722 * b2; r2 += (lu - r2) * gray; g2 += (lu - g2) * gray; b2 += (lu - b2) * gray; }
      if (ta > 0) { r2 += (tc[0] - r2) * ta; g2 += (tc[1] - g2) * ta; b2 += (tc[2] - b2) * ta; }
      if (vig > 0) { const dx = (x / width - 0.5) * 2, d = Math.sqrt(dx * dx + dy * dy) / 1.414, t = d < 0.45 ? 0 : Math.min(1, (d - 0.45) / 0.55), k = 1 - vig * t * t * (3 - 2 * t); r2 *= k; g2 *= k; b2 *= k; }
      if (grain > 0) { const n = (Math.random() - 0.5) * 70 * grain; r2 += n; g2 += n; b2 += n; }
      buf[i + 2] = cl(r2); buf[i + 1] = cl(g2); buf[i] = cl(b2);
    }
  }
  if (l.flip) for (let y = 0; y < height; y++) for (let x = 0; x < width >> 1; x++) { const p = (y * width + x) * 4, q = (y * width + (width - 1 - x)) * 4; for (let k = 0; k < 4; k++) { const t = buf[p + k]; buf[p + k] = buf[q + k]; buf[q + k] = t; } }
  if (l.flipv) for (let y = 0; y < height >> 1; y++) for (let x = 0; x < width * 4; x++) { const p = y * width * 4 + x, q = (height - 1 - y) * width * 4 + x, t = buf[p]; buf[p] = buf[q]; buf[q] = t; }
  const dir = path.join(app.getPath('userData'), 'wallpapers', 'adjusted'); fs.mkdirSync(dir, { recursive: true }); // tinted copies live in the app's own folder, never next to your pictures
  const tag = require('crypto').createHash('md5').update(file).digest('hex').slice(0, 8) + '-', out = path.join(dir, tag + path.basename(file).replace(/\.[a-z0-9]+$/i, '').slice(0, 40) + '-look-' + require('crypto').createHash('md5').update(JSON.stringify(l)).digest('hex').slice(0, 10) + '.jpg');
  try { for (const f of fs.readdirSync(dir)) if (f.startsWith(tag) && path.join(dir, f) !== out && Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > 600000) fs.unlinkSync(path.join(dir, f)); } catch {} // (older copies only: another screen may be using a recent one)
  fs.writeFileSync(out, nativeImage.createFromBitmap(buf, { width, height }).toJPEG(93)); return out;
}
async function applyItem(item, target = 'all') {
  stopLive(target); const f = await download(item), c = loadCfg();
  c.stillCurrent = target === 'all' ? { all: f } : { ...(c.stillCurrent || {}), [target]: f }; c.stillIds = target === 'all' ? { all: item.id || null } : { ...(c.stillIds || {}), [target]: item.id || null }; saveCfg(c); // remember the original picture so the Colors sliders can re-tint it later
  if (target === 'all' && Object.keys(c.stillLook || {}).length) { for (const m of monitors()) await setWallpaperOn(adjustImage(f, lookFor(c, m.key, item.id)), m.key).catch(() => {}); return; }
  await setWallpaperOn(adjustImage(f, lookFor(c, target, item.id)), target);
}
// the picture Windows is showing now (used the first time the Colors sliders are moved, if the app has no record of it)
function currentWallpaperFile() {
  return new Promise((res) => execFile('reg.exe', ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'WallPaper'], { windowsHide: true }, (e, out) => {
    let p = e ? '' : ((String(out).match(/WallPaper\s+REG_SZ\s+(.+)/i) || [])[1] || '').trim();
    if (p && /[\\/]adjusted[\\/]/i.test(p)) p = ''; // that is one of our tinted copies; the original is recorded in the app's settings instead
    res(p && fs.existsSync(p) ? p : '');
  }));
}
let stillBusy = false, stillAgain = false, stillT;
async function refreshStills() { // re-apply the still wallpapers with the current brightness / contrast / color
  if (stillBusy) { stillAgain = true; return; } stillBusy = true;
  try {
    do {
      stillAgain = false; const c = loadCfg(); let map = c.stillCurrent && Object.keys(c.stillCurrent).length ? c.stillCurrent : null;
      if (!map) { const cur = await currentWallpaperFile(); if (cur) { map = { all: cur }; c.stillCurrent = map; saveCfg(c); } }
      if (!map) break;
      for (const key of Object.keys(map).sort((a) => (a === 'all' ? -1 : 1))) {
        if (!fs.existsSync(map[key])) continue; const pid = stillIdOf(c, key), perScreen = key === 'all' && Object.keys(c.stillLook || {}).length > 0, f = perScreen ? map[key] : adjustImage(map[key], lookFor(c, key, pid));
        if (perScreen) { for (const m of monitors()) if (!liveProcs.has(m.key) && !map[m.key]) await setWallpaperOn(adjustImage(f, lookFor(c, m.key, pid)), m.key).catch(() => {}); }
        else if (key === 'all') { if (!anyLive()) await setWallpaperOn(f, 'all'); else for (const m of monitors()) if (!liveProcs.has(m.key) && !map[m.key]) await setWallpaperOn(f, m.key).catch(() => {}); }
        else if (!liveProcs.has(key)) await setWallpaperOn(f, key).catch(() => {});
      }
    } while (stillAgain);
  } catch (e) { console.log('could not re-tint the wallpaper:', e.message); } finally { stillBusy = false; }
}

async function randomApply() {
  const c = loadCfg();
  const list = await sources[c.autoSource]({ query: c.autoQuery, page: 1 + Math.floor(Math.random() * 3), sorting: 'random' });
  if (!list.length) throw new Error('No results for that search');
  await applyItem(list[Math.floor(Math.random() * list.length)], c.target || 'all');
}

function schedule() {
  clearInterval(timer);
  const m = loadCfg().autoMinutes;
  if (m > 0) timer = setInterval(() => { if (!gameNetQuiet()) randomApply().catch(() => {}); }, m * 60000); // (skipped while you are gaming)
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
    SendMessageTimeout(prog, 0x052C, (IntPtr)0xD, (IntPtr)1, 0, 1000, out r); // Win11 24H2+: also ask for the wallpaper layer
    IntPtr worker = IntPtr.Zero; string mode = "workerw";
    // wait for the wallpaper layer, but only as long as it takes (on the failing PC it took up to ~1 s to appear; usually it is there at once)
    for (int tries = 0; tries < 26 && worker == IntPtr.Zero; tries++) {
      if (tries > 0) System.Threading.Thread.Sleep(40);
      // Win11 24H2+: the wallpaper layer is a screen-sized WorkerW child of Progman
      IntPtr c = IntPtr.Zero; RECT cr;
      while ((c = FindWindowEx(prog, c, "WorkerW", null)) != IntPtr.Zero) { GetWindowRect(c, out cr); if (cr.R - cr.L >= w) { worker = c; mode = "progman-child-workerw"; break; } }
      // older layout: top-level WorkerW sitting behind the one that holds the icons
      if (worker == IntPtr.Zero && tries >= 3) {
        EnumWindows((hh, l) => { if (FindWindowEx(hh, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) { IntPtr cand = FindWindowEx(IntPtr.Zero, hh, "WorkerW", null); RECT rr; if (cand != IntPtr.Zero) { GetWindowRect(cand, out rr); if (rr.R - rr.L >= w) worker = cand; } } return true; }, IntPtr.Zero);
      }
    }
    if (worker == IntPtr.Zero) { worker = prog; mode = "progman"; }
    long st = (long)GetLong(me, -16);
    st = (st & ~0x80000000L & ~0x00C00000L) | 0x40000000L; // drop POPUP/caption, add CHILD
    SetLong(me, -16, (IntPtr)st);
    SetParent(me, worker);
    RECT pr; GetWindowRect(worker, out pr); // child coords are relative to the parent, so subtract its origin from the screen's position
    SetWindowPos(me, (IntPtr)(Environment.GetEnvironmentVariable("WP_TOP") == "1" ? 0 : 1), mx - pr.L, my - pr.T, w, h, 0x0010 | 0x0040 | 0x0020); // HWND_BOTTOM (HWND_TOP while crossfading over the old wallpaper), NOACTIVATE|SHOWWINDOW|FRAMECHANGED
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
    bool maxed = Environment.GetEnvironmentVariable("WH_MAX") == "1" && r.L <= mi.rcWork.L + 12 && r.T <= mi.rcWork.T + 12 && r.R >= mi.rcWork.R - 12 && r.B >= mi.rcWork.B - 12; // a maximized window hides the wallpaper completely
    return (full || maxed) ? ("full " + mi.rcMonitor.L + " " + mi.rcMonitor.T) : "normal";
  }
}
'@
$last = $null
while ($true) { $f = [F]::Full(); if ($f -ne $last) { Write-Output $f; $last = $f }; Start-Sleep -Milliseconds 1500 }
`;

// Earth Orbit: tells the wallpaper when you click the empty desktop. It only looks at whether the left mouse button went down and which window is under the pointer (no keys, nothing recorded or sent).
const CLICK_PS = `
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public class CK {
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X, Y; }
  [DllImport("user32")] static extern short GetAsyncKeyState(int k);
  [DllImport("user32")] static extern bool GetCursorPos(out PT p);
  [DllImport("user32")] static extern IntPtr WindowFromPoint(PT p);
  [DllImport("user32")] static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32")] static extern bool SetProcessDPIAware();
  [DllImport("user32")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  static bool prev;
  public static string Poll() {
    SetProcessDPIAware();
    bool down = (GetAsyncKeyState(1) & 0x8000) != 0; bool edge = down && !prev; prev = down; if (!edge) return null;
    PT p; if (!GetCursorPos(out p)) return null; IntPtr h = WindowFromPoint(p); if (h == IntPtr.Zero) return null;
    IntPtr r = GetAncestor(h, 2); var sb = new StringBuilder(64); GetClassName(r == IntPtr.Zero ? h : r, sb, 64); string c = sb.ToString();
    bool desk = (c == "WorkerW" || c == "Progman");
    if (!desk && c.StartsWith("WindowsForms10")) { try { uint pid; GetWindowThreadProcessId(r == IntPtr.Zero ? h : r, out pid); desk = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName == "IconFade"; } catch { } } // the Hub's own see-through desktop-icon helper covers the whole desktop
    return desk ? ("click " + p.X + " " + p.Y) : null;
  }
}
'@
$ppid = [int]$env:WH_PPID; $i = 0
while ($true) { $r = [CK]::Poll(); if ($r) { Write-Output $r }; Start-Sleep -Milliseconds 30; $i++; if ($i % 40 -eq 0 -and -not (Get-Process -Id $ppid -ErrorAction SilentlyContinue)) { break } }
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
const fsStopped = new Map(); // screen key -> item: wallpapers ended by a fullscreen app ("Stop completely"), brought back afterwards
const anyLive = () => liveProcs.size > 0;
function killLive(target) { // stops the processes only; the saved settings are untouched (so quitting keeps your live wallpapers)
  for (const [k, e] of [...liveProcs]) if (!target || target === 'all' || k === target) { try { e.proc.kill(); } catch {} liveProcs.delete(k); statsWant('live-' + k, false); }
  for (const k of [...fsStopped.keys()]) if (!target || target === 'all' || k === target) fsStopped.delete(k);
  if (!liveProcs.size && !fsStopped.size && watcher) { watcher.kill(); watcher = null; }
}
// The saved settings follow what is running, EXCEPT that a wallpaper which stopped on its own (for example when the graphics card resets while waking from sleep)
// is kept: it is brought back afterwards. Only a stop you asked for forgets a screen's wallpaper.
function persistLive(forget) {
  const c = loadCfg(), ls = { ...(c.liveScreens || {}) };
  for (const k of forget || []) delete ls[k];
  for (const [k, e] of liveProcs) ls[k] = e.item;
  saveCfg({ ...c, liveScreens: ls, live: Object.values(ls)[0] || null });
}
function stopLive(target = 'all') { const keys = !target || target === 'all' ? [...new Set([...Object.keys(loadCfg().liveScreens || {}), ...liveProcs.keys()])] : [target]; killLive(target); persistLive(keys); }

// Anurati (a free-for-personal-use font) is NOT bundled; if you installed it on your PC the clock uses it.
function findAnurati() {
  const dirs = [path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts'), path.join(process.env.WINDIR || 'C:/Windows', 'Fonts'), path.join(app.getPath('userData'), 'fonts')];
  for (const d of dirs) { try { const f = fs.readdirSync(d).find((n) => /^anurati.*\.(ttf|otf)$/i.test(n)); if (f) return require('url').pathToFileURL(path.join(d, f)).href; } catch {} }
  return '';
}
async function spawnLive(key, payload, item) {
  const old = payload.fade ? liveProcs.get(key) : null; let oldTimer = null; // the old wallpaper keeps playing while the new one starts hidden and fades in on top
  if (old) {
    statsWant('live-' + key, false); // (the old one keeps playing, fully visible, until the new one has faded in on top of it)
    oldTimer = setTimeout(() => { try { old.proc.kill(); } catch {} }, 20000); // safety net; normally it is removed as soon as the new one reports FADED
  } else killLive(key);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const args = [...(app.isPackaged ? [] : [app.getAppPath()]), '--parent=' + process.pid, '--live=' + Buffer.from(JSON.stringify(payload)).toString('base64')];
  if (process.env.WH_DEBUG_PORT) args.push('--remote-debugging-port=' + (+process.env.WH_DEBUG_PORT + (liveProcs.size % 4))); // developer switch: lets the wallpaper be inspected while it runs
  const proc = spawn(process.execPath, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  liveProcs.set(key, { proc, item });
  if (['sysmon', 'matrixstats', 'netpulse', 'diskwall'].includes(payload.name)) statsWant('live-' + key, true); // the System Monitor wallpaper needs live numbers
  proc.stdout.on('data', (b) => { // player errors (e.g. embedding blocked) from the live process -> tell the UI
    if (old && /^FADED/m.test(b.toString())) setTimeout(() => { try { old.proc.kill(); } catch {} }, 250);
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
  }).catch((err) => { if (liveProcs.get(key) && liveProcs.get(key).proc === proc) { killLive(key); if (old) { clearTimeout(oldTimer); liveProcs.set(key, old); } } throw err; }); // (if the new one fails, the old one simply stays)
  proc.on('exit', () => { const e = liveProcs.get(key); if (e && e.proc === proc) liveProcs.delete(key); });
  return mode;
}

// Web wallpapers: only http(s) pages or a local .html file the user picked. No credentials in the address.
const webUrlOk = (u) => {
  try {
    const x = new URL(String(u));
    if (x.protocol === 'file:') return /\.html?$/i.test(x.pathname) && fs.existsSync(require('url').fileURLToPath(x));
    return (x.protocol === 'https:' || x.protocol === 'http:') && !x.username && !x.password && x.hostname.length > 0;
  } catch { return false; }
};
// ---- Graphics options. All three are OFF until you turn them on in the Live tab. ----
// 1) Switch graphics automatically: Eco on battery; one step lower while the graphics card is busy, back up when it is quiet again.
// 2) Frame rate limit: your own number instead of the Graphics preset's.
// 3) Live readout: how much CPU / graphics power the wallpaper itself is using.
const GFX_ORDER = ['eco', 'balanced', 'high', 'ultra', 'extreme'];
const gfxAuto = { drop: 0, hi: 0, lo: 0, last: 0, reason: '' };
let liveGfxNow = null; // the preset the running wallpapers were started with
function onBattery() { try { return powerMonitor.isOnBatteryPower(); } catch { return false; } }
function effectiveGfx() {
  const c = loadCfg(); let i = GFX_ORDER.indexOf(c.gfx); if (i < 0) i = 1;
  if (!c.gfxAuto) return GFX_ORDER[i];
  if (onBattery()) return 'eco';
  return GFX_ORDER[Math.max(0, i - gfxAuto.drop)];
}
function pushAutoInfo() { if (win && !win.isDestroyed()) win.webContents.send('gfx-auto', { on: !!loadCfg().gfxAuto, effective: effectiveGfx(), reason: gfxAuto.reason }); }
// Windows can rebuild the desktop layer or briefly rename the screens while waking from sleep, which could leave a wallpaper missing or on the wrong screen.
// So a few seconds after waking, wait until the screens have their names back, then start any wallpaper that is not running and re-attach the others.
let resumeBusy = false;
function resumeLive(why, tries = 0) {
  if (resumeBusy && tries === 0) return; resumeBusy = true;
  const mons = monitors();
  if (mons.some((m) => m.base === 'screen') && tries < 8) { setTimeout(() => resumeLive(why, tries + 1), 2000); return; } // screens not named yet
  try {
    migrateScreenKeys();
    const c = loadCfg(), saved = c.liveScreens || {};
    for (const m of mons) {
      const item = saved[m.key]; if (!item) continue;
      const run = liveProcs.get(m.key), alive = run && run.proc && run.proc.exitCode === null && !run.proc.killed;
      if (fsStopped.has(m.key)) continue; // a game has this screen on purpose
      startLive(alive ? run.item : item, m.key, { persist: false, fade: !!alive }).catch((e) => console.log('wallpaper after ' + why + ' failed:', e.message));
    }
    plSync();
  } catch (e) { console.log('resume failed:', e.message); }
  setTimeout(() => { resumeBusy = false; }, 15000);
}
function restartLiveAll() { for (const [k, e] of [...liveProcs]) startLive(e.item, k, { persist: false }).catch((err) => console.log('restart failed:', err.message)); }
function gfxAutoTick(force) {
  const c = loadCfg(), on = !!c.gfxAuto && anyLive();
  if (!!gfxAuto.stats !== on) { gfxAuto.stats = on; statsWant('auto-gfx', on); } // the graphics-card reading is only collected while this option is on
  if (!c.gfxAuto) { if (gfxAuto.drop || gfxAuto.reason) { gfxAuto.drop = 0; gfxAuto.hi = gfxAuto.lo = 0; gfxAuto.reason = ''; pushAutoInfo(); } return; }
  if (!anyLive()) return;
  const base = Math.max(0, GFX_ORDER.indexOf(c.gfx)), bat = onBattery();
  const g = stat.last && stat.last.gpu ? stat.last.gpu.usage : null;
  if (g != null) { if (g >= 90) { gfxAuto.hi++; gfxAuto.lo = 0; } else if (g <= 55) { gfxAuto.lo++; gfxAuto.hi = 0; } else { gfxAuto.hi = gfxAuto.lo = 0; } }
  const resting = liveState.paused || (liveState.pausedKeys || []).length > 0 || !!liveState.battery || !!liveState.appPause || !!liveState.locked; // paused wallpapers don't draw, so a busy card is not their doing
  if (!resting) {
    if (gfxAuto.hi >= 6 && gfxAuto.drop < base) { gfxAuto.drop++; gfxAuto.hi = 0; } // about 30 s above 90%
    else if (gfxAuto.lo >= 12 && gfxAuto.drop > 0) { gfxAuto.drop--; gfxAuto.lo = 0; } // about 60 s below 55%
  }
  gfxAuto.reason = bat ? 'on battery power' : gfxAuto.drop > 0 ? 'the graphics card was busy' : '';
  if (effectiveGfx() !== liveGfxNow && (force || Date.now() - gfxAuto.last > 45000)) { gfxAuto.last = Date.now(); restartLiveAll(); }
  pushAutoInfo();
}
const METER_PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$cores = [Environment]::ProcessorCount; $prev = @{}; $prevT = Get-Date
Get-Counter -Counter '\GPU Engine(*)\Utilization Percentage' -SampleInterval 2 -Continuous | ForEach-Object {
  if (-not (Get-Process -Id ([int]$env:WH_PARENT))) { exit }
  $set = @{}; $txt = Get-Content $env:WH_PIDS
  if ($txt) { foreach ($r in ($txt -split ',')) { if ($r) { $set[[int]$r] = 1 } } }
  $all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId
  $grew = $true; while ($grew) { $grew = $false; foreach ($p in $all) { if (-not $set.ContainsKey([int]$p.ProcessId) -and $set.ContainsKey([int]$p.ParentProcessId)) { $set[[int]$p.ProcessId] = 1; $grew = $true } } }
  $now = Get-Date; $dt = [math]::Max(0.2, ($now - $prevT).TotalSeconds); $prevT = $now; $cpu = 0.0; $cur = @{}
  foreach ($id in @($set.Keys)) { $pr = Get-Process -Id $id; if ($pr) { $cur[$id] = $pr.CPU; if ($prev.ContainsKey($id)) { $cpu += [math]::Max(0, ($pr.CPU - $prev[$id]) / $dt / $cores * 100) } } }
  $prev = $cur; $eng = @{}
  foreach ($smp in $_.CounterSamples) { if ($smp.InstanceName -match '^pid_(\d+)_.*engtype_(.+)$') { if ($set.ContainsKey([int]$Matches[1])) { $k = $Matches[2]; $eng[$k] = [double]$eng[$k] + $smp.CookedValue } } }
  $gpu = 0.0; foreach ($v in $eng.Values) { if ($v -gt $gpu) { $gpu = $v } }
  [Console]::Out.WriteLine((@{ cpu = [math]::Round($cpu, 1); gpu = [math]::Min(100, [math]::Round($gpu, 1)); n = $set.Count } | ConvertTo-Json -Compress)); [Console]::Out.Flush()
}
`;
const meter = { ps: null, last: null };
function meterStop() { if (meter.ps) { try { meter.ps.kill(); } catch {} meter.ps = null; } meter.last = null; }
function meterStart() {
  if (meter.ps) return;
  const p = runPs(METER_PS, { WH_PARENT: String(process.pid), WH_PIDS: path.join(app.getPath('userData'), 'live-pids.txt') });
  meter.ps = spawn('powershell.exe', p.args, { env: p.env, windowsHide: true });
  setTimeout(() => fs.unlink(p.file, () => {}), 6000);
  let buf = ''; meter.ps.stdout.on('data', (b) => { buf += b.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line[0] === '{') { try { meter.last = JSON.parse(line); } catch {} } } });
  meter.ps.on('error', () => {}); meter.ps.on('exit', () => { meter.ps = null; });
}
function meterTick() {
  const c = loadCfg(), want = !!c.gfxMeter && anyLive() && win && !win.isDestroyed() && win.isVisible() && !win.isMinimized(); // only while the window is open and you can see it
  if (!!liveState.meter !== !!(c.gfxMeter && anyLive())) { liveState.meter = !!(c.gfxMeter && anyLive()); writeLiveState(); }
  if (!want) { meterStop(); return; }
  meterStart();
  const dir = app.getPath('userData'), screens = [];
  try { fs.writeFileSync(path.join(dir, 'live-pids.txt'), [...liveProcs.values()].map((e) => e.proc.pid).join(',')); } catch {}
  for (const [k] of liveProcs) { try { const m = JSON.parse(fs.readFileSync(path.join(dir, 'live-meter-' + k + '.json'), 'utf8')); if (Date.now() - m.t < 6000) screens.push({ key: k, fps: m.fps, w: m.w, h: m.h }); } catch {} }
  win.webContents.send('meter', { cpu: meter.last ? meter.last.cpu : null, gpu: meter.last ? meter.last.gpu : null, screens, gfx: effectiveGfx() });
}
// ---- Icon Fade: your own desktop-icon hider (icons fade away, only the one under the mouse shows). Wallpaper Hub starts and stops it for you. ----
// Off by default. Modes: 'live' = while a live wallpaper is running, 'always' = with any wallpaper. The program is not bundled; it is found in
// %LOCALAPPDATA%\IconFade or wherever you point to. When it is stopped, "IconFade.exe restore" puts the icons back, so they are never left invisible.
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'.split('\\').join(String.fromCharCode(92));
// Icon Fade is built in: its program ships inside Wallpaper Hub and is copied to %LOCALAPPDATA%\IconFade the first time it is needed
// (a copy outside the install folder, so updating Wallpaper Hub is never blocked by it running).
const iconFadeBundled = () => { const p = app.isPackaged ? path.join(process.resourcesPath, 'iconfade', 'IconFade.exe') : path.join(__dirname, 'iconfade', 'IconFade.exe'); return fs.existsSync(p) ? p : null; };
const iconFadeHome = () => path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'IconFade', 'IconFade.exe');
function iconFadeRefresh(running) { // first use: install it; later: take a newer bundled version when it is not running
  const home = iconFadeHome(), src = iconFadeBundled(); if (!src) return;
  try {
    if (!fs.existsSync(home)) { fs.mkdirSync(path.dirname(home), { recursive: true }); fs.copyFileSync(src, home); }
    else if (!running && Buffer.compare(fs.readFileSync(src), fs.readFileSync(home)) !== 0) fs.copyFileSync(src, home);
  } catch {}
}
function iconFadePath() {
  const c = loadCfg(); if (c.iconFadePath) { try { if (fs.statSync(c.iconFadePath).isFile()) return c.iconFadePath; } catch {} }
  iconFadeRefresh(true); const home = iconFadeHome();
  return fs.existsSync(home) ? home : iconFadeBundled();
}
let iconFadeBusy = false, iconFadeQuitting = false, iconFadeOwned = false; // owned = started by this run of Wallpaper Hub, so it quits when we do
function iconFadeRunning(cb) { execFile('tasklist', ['/fi', 'imagename eq IconFade.exe', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 8000 }, (e, out) => cb(!e && /IconFade[.]exe/i.test(String(out)))); }
function iconFadeSync() {
  const c = loadCfg(), mode = c.iconFade || 'off';
  if (mode === 'off' || iconFadeBusy) return;
  const exe = iconFadePath(); if (!exe || iconFadeQuitting) return;
  const want = mode === 'always' || anyLive() || fsStopped.size > 0;
  iconFadeBusy = true;
  iconFadeRunning((run) => {
    if (iconFadeQuitting) { iconFadeBusy = false; return; }
    const start = () => { iconFadeRefresh(false); try { const cc = loadCfg(), ch = spawn(exe, ['--parent=' + process.pid, ...(cc.iconFadeStrong ? ['--strong'] : []), ...(cc.iconFadeFull ? ['--full'] : [])], { detached: true, stdio: 'ignore', windowsHide: true }); ch.unref(); iconFadeOwned = true;
      ch.on('exit', () => { if (iconFadeQuitting) return; setTimeout(() => { iconFadeRunning((r) => { if (!r) { iconFadeOwned = false; execFile(exe, ['restore'], { windowsHide: true }, () => setTimeout(iconFadeSync, 1500)); } }); }, 700); }); // if Icon Fade ever ends on its own (a crash, or it was ended), the icons are put back right away and it is started again if it is still wanted
    } catch {} iconFadeBusy = false; };
    if (want && run && !iconFadeOwned) { // one that started on its own (for example at Windows start-up): restart it tied to us, so it can never outlive us
      execFile('taskkill', ['/im', 'IconFade.exe', '/f'], { windowsHide: true }, () => execFile(exe, ['restore'], { windowsHide: true }, () => setTimeout(start, 400)));
    }
    else if (want && !run) start();
    else if (!want && run) execFile('taskkill', ['/im', 'IconFade.exe', '/f'], { windowsHide: true }, () => execFile(exe, ['restore'], { windowsHide: true }, () => { iconFadeOwned = false; iconFadeBusy = false; }));
    else iconFadeBusy = false;
  });
}
// At every start: if Icon Fade is not running, make sure no earlier crash or forced close left your icons invisible.
function iconFadeStartupRestore() {
  const exe = iconFadeBundled() || iconFadePath(); if (!exe) return;
  iconFadeRunning((run) => { if (!run) execFile(exe, ['restore'], { windowsHide: true }, () => {}); });
}
// Tray shortcut: show the icons right now / fade them again, without opening the window.
function iconFadeToggle() {
  const c = loadCfg(), cur = c.iconFade || 'off', next = cur === 'off' ? (c.iconFadeLast || 'live') : 'off';
  saveCfg({ ...c, iconFade: next, ...(cur !== 'off' ? { iconFadeLast: cur } : {}) });
  if (next === 'off') { const exe = iconFadePath(); if (exe) execFile('taskkill', ['/im', 'IconFade.exe', '/f'], { windowsHide: true }, () => execFile(exe, ['restore'], { windowsHide: true }, () => { iconFadeOwned = false; })); } else setTimeout(iconFadeSync, 200);
  if (win && !win.isDestroyed()) win.webContents.send('icons-mode', next);
}
function iconFadeQuit() { // leaving Wallpaper Hub: stop Icon Fade (if we are managing it) and make sure the icons are visible again
  iconFadeQuitting = true;
  try {
    const c = loadCfg(); if ((c.iconFade || 'off') === 'off' && !iconFadeOwned) return;
    const exe = iconFadePath(); if (!exe) return; const cp = require('child_process');
    try { cp.execFileSync('taskkill', ['/im', 'IconFade.exe', '/f'], { windowsHide: true, timeout: 4000, stdio: 'ignore' }); } catch {}
    cp.execFileSync(exe, ['restore'], { windowsHide: true, timeout: 6000, stdio: 'ignore' });
  } catch {}
}
function runKeyHas() { try { return /IconFade/i.test(require('child_process').execFileSync('reg.exe', ['query', RUN_KEY, '/v', 'IconFade'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return false; } }
// ---- Playlists: rotate through the wallpapers you picked (scenes, your library, YouTube, web pages). One list per screen, plus an optional shared list for "every screen". ----
const plState = {}; let plTimer = null; // scope ('all' or a screen key) -> { last, idx, busy }
function plAll() { // { scope: { on, every, shuffle, items } }; an old single playlist becomes the shared one
  const c = loadCfg(), raw = c.playlists || (c.playlist ? { all: c.playlist } : {}), out = {};
  for (const [k, p] of Object.entries(raw || {})) if (p) out[k] = { on: !!p.on, every: Math.max(15, +p.every || 300), shuffle: !!p.shuffle, items: Array.isArray(p.items) ? p.items : [] };
  return out;
}
const plActive = () => Object.entries(plAll()).filter(([, p]) => p.on && p.items.length);
function plSync() {
  if (plActive().length || pairKeysNow().length) { if (!plTimer) plTimer = setInterval(plTick, 3000); } else { clearInterval(plTimer); plTimer = null; }
  const live = new Set(plActive().map(([k]) => k)); for (const k of Object.keys(plState)) if (!live.has(k)) delete plState[k];
}
async function plNext(scope) {
  const p = plAll()[scope]; if (!p || !p.items.length) return false;
  const st = plState[scope] || (plState[scope] = { last: 0, idx: -1, busy: false });
  let i; if (p.shuffle && p.items.length > 1) { do { i = Math.floor(Math.random() * p.items.length); } while (i === st.idx); } else i = (st.idx + 1) % p.items.length;
  st.idx = i; st.last = Date.now(); const item = p.items[i];
  try {
    const shown = await autoLook(item, p.items);
    if (scope !== 'all') await startLive(shown, scope, { fade: true });
    else { // the shared list covers every screen that has no list of its own
      const own = new Set(plActive().map(([k]) => k).filter((k) => k !== 'all')), keys = monitors().map((m) => m.key).filter((k) => !own.has(k));
      if (!own.size) await startLive(shown, 'all', { fade: true }); else for (const k of keys) await startLive(shown, k, { fade: true });
    }
    if (win && !win.isDestroyed()) win.webContents.send('playlist-now', { scope, i, title: item.title || item.name || item.id });
    return true;
  } catch (e) { console.log('playlist item failed:', e.message); st.last = Date.now() - (p.every - 10) * 1000; return false; } // skip it, try the next one shortly
}
function plTick() {
  const all = plAll(), now = Date.now(), pairKeys = pairKeysNow();
  if (pairKeys.length) pairTick(); // matched screens are driven together, not one by one
  if (!plActive().length && !pairKeys.length) return plSync();
  for (const [scope, p] of Object.entries(all)) {
    if (!p.on || !p.items.length || pairKeys.includes(scope)) continue;
    const st = plState[scope] || (plState[scope] = { last: now, idx: -1, busy: false });
    // while you paused it, on battery pause, or a game / fullscreen app has this screen paused, the playlist waits too: its countdown is frozen and carries on afterwards
    if (liveState.paused || liveState.battery || liveState.appPause || liveState.locked || gameNetQuiet() || (scope === 'all' ? (liveState.pausedKeys || []).length : (liveState.pausedKeys || []).includes(scope))) { st.last += now - (st.tickAt || now); st.tickAt = now; continue; }
    st.tickAt = now;
    const idle = scope === 'all' ? !anyLive() : (!liveProcs.has(scope) && !fsStopped.has(scope)); // a screen with a playlist but no wallpaper yet (for example after a restart) gets its first one at once
    if (idle && st.idx === -1 && !st.busy) { st.busy = true; plNext(scope).finally(() => { st.busy = false; }); continue; }
    if (now - st.last < p.every * 1000 || st.busy) continue;
    st.busy = true; plNext(scope).finally(() => { st.busy = false; });
  }
}
// ---- Matched screens: every screen changes at the same moment, and the wallpapers from each screen's list that look most alike are paired ----
// A wallpaper's "look" is its colors (mix of hues, brightness, saturation), read once from a preview picture and remembered in look-signatures.json.
const sigPath = () => path.join(app.getPath('userData'), 'look-signatures.json');
let sigStore = null;
const sigDb = () => { if (!sigStore) { try { sigStore = JSON.parse(fs.readFileSync(sigPath(), 'utf8')); } catch { sigStore = {}; } } return sigStore; };
const bgraToRGB = (bgra) => { const px = []; for (let i = 0; i + 3 < bgra.length; i += 4) px.push(bgra[i + 2], bgra[i + 1], bgra[i]); return px; };
function sigFromRGB(px) {
  const hist = new Array(12).fill(0); let n = 0, R = 0, G = 0, B = 0, S = 0, V = 0, wsum = 0;
  for (let i = 0; i + 2 < px.length; i += 3) {
    const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    n++; R += r; G += g; B += b; V += mx; S += d; // S = how colorful (dark noise does not count)
    if (d > 0.08 && mx > 0.12) { let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h = (h * 60 + 360) % 360; hist[Math.min(11, Math.floor(h / 30))] += d; wsum += d; }
  }
  n = n || 1; const tot = wsum || 1;
  return { h: hist.map((x) => +(x / tot).toFixed(4)), s: +(S / n).toFixed(3), v: +(V / n).toFixed(3), rgb: [R / n, G / n, B / n].map((x) => +x.toFixed(3)) };
}
function sigDist(a, b) { // 0 = looks the same, about 1 = nothing alike
  if (!a || !b) return 0.45;
  let hd = 0; for (let i = 0; i < 12; i++) hd += Math.abs(a.h[i] - b.h[i]);
  const sat = Math.min(1, (a.s + b.s) * 1.5), cd = Math.hypot(a.rgb[0] - b.rgb[0], a.rgb[1] - b.rgb[1], a.rgb[2] - b.rgb[2]) / 1.732;
  return 0.9 * (hd / 2) * sat + 0.6 * Math.abs(a.v - b.v) + 0.3 * Math.abs(a.s - b.s) + 0.7 * cd;
}
async function fileFrameRGB(file) { // one frame of a video / GIF, read in a hidden window (it never shows)
  const tmp = path.join(app.getPath('userData'), 'look-probe.html');
  if (!fs.existsSync(tmp)) fs.writeFileSync(tmp, '<!doctype html><body><video id="v" muted></video><img id="i"><canvas id="c" width="64" height="36"></canvas></body>');
  const w = new BrowserWindow({ show: false, width: 320, height: 180, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  try {
    await w.loadFile(tmp);
    const url = require('url').pathToFileURL(file).href;
    const data = await w.webContents.executeJavaScript('new Promise((res, rej) => { const u = ' + JSON.stringify(url) + ', c = document.getElementById("c").getContext("2d"); const done = (el) => { try { c.drawImage(el, 0, 0, 64, 36); res(Array.from(c.getImageData(0, 0, 64, 36).data)); } catch (e) { rej(String(e)); } }; if (u.toLowerCase().endsWith(".gif")) { const i = document.getElementById("i"); i.onload = () => done(i); i.onerror = () => rej("image"); i.src = u; } else { const v = document.getElementById("v"); v.muted = true; v.onloadeddata = () => { v.currentTime = Math.min(1.5, (v.duration || 2) / 2); }; v.onseeked = () => done(v); v.onerror = () => rej("video"); v.src = u; } setTimeout(() => rej("timeout"), 15000); })');
    const px = []; for (let i = 0; i + 3 < data.length; i += 4) px.push(data[i], data[i + 1], data[i + 2]);
    return px;
  } finally { try { w.destroy(); } catch {} }
}
async function itemSig(item) {
  const db = sigDb(); let stamp = '';
  try { if (item.file) stamp = String(fs.statSync(item.file).mtimeMs); } catch {}
  const k = (item.type || 'video') + '|' + (item.name || item.vid || item.url || '') + '|' + stamp;
  if (db[item.id] && db[item.id].k === k && db[item.id].sig) return db[item.id].sig;
  let sig = null;
  try {
    let px = null;
    if (item.type === 'scene') px = bgraToRGB(nativeImage.createFromBuffer(fs.readFileSync(path.join(__dirname, 'build', 'previews', item.name + '.jpg'))).resize({ width: 64, height: 36 }).toBitmap());
    else if (item.type === 'youtube' && item.vid) { const r = await fetch('https://i.ytimg.com/vi/' + item.vid + '/hqdefault.jpg', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) }); px = bgraToRGB(nativeImage.createFromBuffer(Buffer.from(await r.arrayBuffer())).resize({ width: 64, height: 36 }).toBitmap()); }
    else if (item.file && fs.existsSync(item.file)) px = await fileFrameRGB(item.file);
    if (px && px.length) sig = sigFromRGB(px);
  } catch (e) { console.log('look read failed for', item.id, String(e).slice(0, 80)); }
  if (sig) { db[item.id] = { k, sig }; try { fs.writeFileSync(sigPath(), JSON.stringify(db)); } catch {} }
  return sig;
}
const pair = { last: 0, idx: -1, tuples: [], key: '', busy: false, tickAt: 0 };
const pairCfg = () => { const p = loadCfg().pair || {}; return { on: !!p.on, every: Math.max(15, +p.every || 300), shuffle: !!p.shuffle }; };
function pairKeysNow() { // the screens taking part: every screen that has a list, when matching is on and there are at least two
  if (!pairCfg().on) return [];
  const valid = new Set(monitors().map((m) => m.key));
  const keys = Object.entries(plAll()).filter(([k, p]) => k !== 'all' && valid.has(k) && p.items.length).map(([k]) => k);
  return keys.length >= 2 ? keys : [];
}
async function pairCompute(keys) { // best-matching sets first. The screen with the longest list leads; every other screen gives its closest-looking wallpaper, each used once
  const pls = plAll(), key = JSON.stringify(keys.map((k) => [k, pls[k].items.map((i) => i.id)]));
  if (pair.key === key && pair.tuples.length) return pair.tuples;
  const parts = keys.map((k) => ({ key: k, items: pls[k].items })).sort((a, b) => b.items.length - a.items.length);
  const sig = new Map(); for (const part of parts) for (const it of part.items) if (!sig.has(it.id)) sig.set(it.id, await itemSig(it));
  const anchor = parts[0], tuples = anchor.items.map((a) => ({ picks: { [anchor.key]: a }, d: 0 }));
  for (const o of parts.slice(1)) {
    const all = []; anchor.items.forEach((a, ai) => o.items.forEach((b, bi) => all.push({ ai, bi, d: sigDist(sig.get(a.id), sig.get(b.id)) })));
    all.sort((x, y) => x.d - y.d); const ua = new Set(), ub = new Set();
    for (const c of all) if (!ua.has(c.ai) && !ub.has(c.bi)) { ua.add(c.ai); ub.add(c.bi); tuples[c.ai].picks[o.key] = o.items[c.bi]; tuples[c.ai].d += c.d; }
    anchor.items.forEach((a, ai) => { if (ua.has(ai)) return; let best = null; o.items.forEach((b, bi) => { const d = sigDist(sig.get(a.id), sig.get(b.id)); if (!best || d < best.d) best = { bi, d }; }); tuples[ai].picks[o.key] = o.items[best.bi]; tuples[ai].d += best.d; }); // a shorter list is reused for the leftovers
  }
  tuples.forEach((t) => { t.d /= Math.max(1, parts.length - 1); });
  tuples.sort((x, y) => x.d - y.d); pair.tuples = tuples; pair.key = key; return tuples;
}
function pairMap(keys) { // which screen shows which list: you can swap them. Anything that is not a clean swap falls back to "each list on its own screen"
  const m = (loadCfg().pair || {}).map || {}, vals = keys.map((k) => m[k] || k);
  if (keys.length === 2 && Object.entries(m).some(([k, v]) => k !== v) && !vals.every((v) => keys.includes(v))) return { [keys[0]]: keys[1], [keys[1]]: keys[0] }; // a swap was chosen, but a screen's name has changed: still swap the two
  return vals.every((v) => keys.includes(v)) && new Set(vals).size === keys.length ? Object.fromEntries(keys.map((k, i) => [k, vals[i]])) : Object.fromEntries(keys.map((k) => [k, k]));
}
async function pairNext(stay) { // stay = show the current set again (used when you change which screen shows which list)
  const keys = pairKeysNow(); if (keys.length < 2 || pair.busy) return false;
  pair.busy = true;
  try {
    const tuples = await pairCompute(keys); if (!tuples.length) return false;
    let i; if (stay && pair.idx >= 0) i = pair.idx; else if (pairCfg().shuffle && tuples.length > 1) { do { i = Math.floor(Math.random() * tuples.length); } while (i === pair.idx); } else i = (pair.idx + 1) % tuples.length;
    pair.idx = i; if (!stay) pair.last = Date.now(); const t = tuples[i], map = pairMap(keys);
    const looks = {}, usedLooks = []; for (const [k, item] of Object.entries(t.picks)) looks[k] = await autoLook(item, [], loadCfg().autoLook === 'fuse' ? 'style' : undefined, usedLooks);
    await Promise.all(Object.entries(t.picks).map(async ([k, item]) => startLive(looks[k], map[k] || k, { fade: true }).catch((e) => console.log('pair item failed:', e.message))));
    if (win && !win.isDestroyed()) win.webContents.send('playlist-now', { scope: 'pair', i, title: Object.values(t.picks).map((x) => x.title || x.name || x.id).join('  +  ') });
    return true;
  } catch (e) { console.log('pair failed:', e.message); pair.last = Date.now() - (pairCfg().every - 10) * 1000; return false; }
  finally { pair.busy = false; }
}
function pairTick() {
  if (gameNetQuiet()) return; // (waits while you are gaming)
  const keys = pairKeysNow(), now = Date.now(); if (keys.length < 2 || pair.busy) return;
  if (!pair.last) pair.last = now;
  const paused = liveState.paused || liveState.battery || liveState.appPause || liveState.locked || keys.some((k) => (liveState.pausedKeys || []).includes(k));
  if (paused) { pair.last += now - (pair.tickAt || now); pair.tickAt = now; return; } // frozen while a game / pause has the screens, carries on afterwards
  pair.tickAt = now;
  if (pair.idx === -1 && keys.some((k) => !liveProcs.has(k) && !fsStopped.has(k))) { pairNext(); return; } // first start: put a matching set up at once
  if (now - pair.last >= pairCfg().every * 1000) pairNext();
}
// target: 'all' (same wallpaper on every screen) or one screen's key
// which screen shows the clock: the main screen (default), every screen, or one chosen screen
const clockHere = (c, m) => { const s = c.screen || (c.all ? 'all' : 'main'); return s === 'all' ? true : s === 'main' ? !!m.primary : String(m.key) === String(s); };
// one half of a fused wallpaper: a built-in scene, or a video / GIF (web pages and YouTube cannot be put inside another page)
// speed / colour settings saved for a built-in scene (Styles tab), passed to the scene whenever it runs
const TW_NUM = { sp: [10, 400], hue: [-180, 180], sat: [0, 250], bri: [30, 200], con: [40, 200], blur: [0, 40], sep: [0, 100], gray: [0, 100], inv: [0, 100], zoom: [50, 300], px: [-50, 50], py: [-50, 50], rot: [-180, 180], tamt: [0, 100], vig: [0, 100], grain: [0, 100], scan: [0, 100], lb: [0, 30], txs: [1, 30], txo: [5, 100], tr0: [0, 86400], tr1: [0, 86400] };
function twClean(t) { const o = {}; if (!t || typeof t !== 'object') return o; for (const [k, [lo, hi]] of Object.entries(TW_NUM)) if (t[k] != null && t[k] !== '' && Number.isFinite(+t[k])) o[k] = Math.max(lo, Math.min(hi, +t[k])); if (/^#[0-9a-f]{6}$/i.test(t.tint || '')) o.tint = t.tint; if (['overlay', 'multiply', 'screen', 'color', 'normal', 'soft-light'].includes(t.tmode)) o.tmode = t.tmode; if (['cover', 'contain', 'fill'].includes(t.fit)) o.fit = t.fit; if (t.hud === 0 || t.hud === '0' || t.hud === false) o.hud = 0; else if (t.hud === 1 || t.hud === '1' || t.hud === true) o.hud = 1; if (typeof t.txt === 'string' && t.txt.trim()) o.txt = t.txt.replace(/[\u0000-\u001f]/g, ' ').slice(0, 80); if (/^#[0-9a-f]{6}$/i.test(t.txc || '')) o.txc = t.txc; if (['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'].includes(t.txp)) o.txp = t.txp; if (['sans', 'serif', 'mono', 'round', 'script'].includes(t.txf)) o.txf = t.txf; if (typeof t.css === 'string' && t.css.trim()) o.css = t.css.replace(/@import[^;]*;?/gi, '').replace(/expression\s*\(/gi, '').slice(0, 2000); if (t.fh != null) o.fh = t.fh ? 1 : 0; if (t.fv != null) o.fv = t.fv ? 1 : 0; return o; }
const twKey = (item) => item.type === 'scene' ? 's:' + item.name : item.id ? 'l:' + item.id : null;
const hm = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : 0; };
function schedActive(c) { c = c || loadCfg(); const d = new Date(), now = d.getHours() * 60 + d.getMinutes(), out = []; (c.tweakSched || []).forEach((s, i) => { if (!s || !s.on) return; const f = hm(s.from), t = hm(s.to); if (f === t ? true : f < t ? now >= f && now < t : now >= f || now < t) out.push(i); }); return out; }
// Polished mode: a gentle colour grade (a little more contrast and colour), a soft dark edge and a very fine film grain, on every kind of live wallpaper
const POLISH = { subtle: { con: 104, sat: 108, vig: 12, grain: 4 }, rich: { con: 109, sat: 118, bri: 102, vig: 24, grain: 7 } };
function twOf(item, screenKey) { const c = loadCfg(), key = twKey(item), old = item.type === 'scene' ? (c.sceneSettings || {})[item.name] : null;
  let t = { ...(POLISH[c.polish] || {}), ...(c.liveTweaks || {}), ...(old ? { sp: old.sp, hue: old.hue, sat: old.sat, bri: old.bri } : {}), ...((key && (c.itemTweaks || {})[key]) || {}) };
  for (const i of schedActive(c)) t = { ...t, ...((c.tweakSched[i] || {}).tw || {}) }; // time-of-day looks sit on top
  if (screenKey) t = { ...t, ...((c.screenTweaks || {})[screenKey] || {}) };
  return twClean(t); }
function twPayload(item, payload, screenKey) { // the app's "Customize" settings, passed to the wallpaper page as plain numbers
  const ty = item.type || 'video'; if (!['scene', 'video', 'fuse', 'creation', 'youtube', 'web'].includes(ty)) return; const t = twOf(item, screenKey), o = { ...t };
  if (ty === 'scene') { const supp = HUD_SUPP.includes(item.name); payload.hud = t.hud != null ? +t.hud : (supp ? (loadCfg().hudGlobal ? 1 : 0) : 1); delete o.hud; payload.sp = (+t.sp || 100) / 100; payload.hue = +t.hue || 0; payload.sat = t.sat != null ? +t.sat : 100; payload.bri = t.bri != null ? +t.bri : 100; delete o.sp; delete o.hue; delete o.sat; delete o.bri; }
  else if (ty === 'video' && +o.sp && +o.sp !== 100) { o.vsp = +o.sp; delete o.sp; delete o.hud; } else { delete o.sp; delete o.hud; }
  for (const k of Object.keys(o)) if (o[k] === (TW_DEF[k] ?? undefined)) delete o[k];
  if (Object.keys(o).length) payload.tw = JSON.stringify(o); else delete payload.tw;
}
function twExtra(item, screenKey) { const p = {}; twPayload(item, p, screenKey); if (!('tw' in p)) p.tw = ''; return p; }
const HUD_SUPP = ['earthnight', 'earthiss', 'earth3d', 'earth3dmoon', 'moonphase', 'nightsky', 'sunmoon', 'solarsystem', 'atom', 'waves', 'turing', 'pendulumwaves', 'molecules', 'lorenz', 'dna', 'gaslab', 'voiceorb', 'claplights'];
const TW_DEF = { txs: 6, txo: 90, tr0: 0, tr1: 0, hue: 0, sat: 100, bri: 100, con: 100, blur: 0, sep: 0, gray: 0, inv: 0, zoom: 100, px: 0, py: 0, rot: 0, tamt: 0, vig: 0, grain: 0, scan: 0, lb: 0 };
let schedSig = null;
setInterval(() => { try { const sig = schedActive().join(','); if (schedSig === null) { schedSig = sig; return; } if (sig !== schedSig) { schedSig = sig; if (anyLive()) for (const [k, e] of [...liveProcs]) startLive(e.item, k, { persist: false, fade: true }).catch(() => {}); } } catch {} }, 30000);
const sceneExtra = (name) => { const s = (loadCfg().sceneSettings || {})[name]; if (!s) return {}; const o = {}; if (+s.sp && +s.sp !== 100) o.sp = +s.sp / 100; if (+s.hue) o.hue = +s.hue; if (s.sat != null && +s.sat !== 100) o.sat = +s.sat; if (s.bri != null && +s.bri !== 100) o.bri = +s.bri; return o; };
const FUSE_NO = ['visualizer', 'beatwaves', 'pulsenebula', 'beattunnel', 'eqcity', 'lasers', 'liquidbars', 'fireworks', 'audiogalaxy', 'lyrics', 'voiceorb', 'claplights', 'sysmon', 'matrixstats', 'netpulse', 'diskwall', 'earthiss', 'cursormagic', 'cursorkoi', 'cursorbubbles', 'cursorleaves', 'cursorsand', 'cursormagnet', 'cursorplanets', 'cursornebula', 'cursorwarp', 'cursorcomet', 'cursorasteroids', 'cursorpulsar', 'cursortornado', 'cursorwildfire', 'cursormeteor', 'cursorquake', 'cursorhurricane', 'cursorfluid', 'cursorribbon', 'cursorswarm', 'cursorgravity', 'cursorgrid', 'cursorripple', 'cursorlightning', 'cursorlight', 'notifwall'];
async function fusePart(it) {
  if (!it) throw new Error('Pick two wallpapers to fuse');
  if (it.type === 'scene') { if (FUSE_NO.includes(it.name)) throw new Error('That scene listens to your music, mic, PC numbers or mouse, so it cannot be fused. Pick a different one.'); return { type: 'scene', name: it.name, ...sceneExtra(it.name) }; }
  if (it.type === 'youtube' || it.type === 'web') throw new Error('YouTube and web page wallpapers cannot be fused (they cannot be placed inside another page). Use a video, a GIF or a built-in scene.');
  let file = it.file;
  if (!file && it.manifest) it = { ...it, full: await nasaFile(it.manifest) };
  if (!file && MB_DL.test(it.full || '')) file = await mbDownload(it.full);
  if (!file) file = await download(it, liveDir(), 'mp4');
  if (!fs.existsSync(file)) throw new Error('A video file for the fuse is missing');
  return { type: 'video', src: file };
}
// ---- Auto look ----
// Picks galaxy / nebula / aurora layers and a clean color grade to suit a wallpaper's own colors (read from its look signature),
// and, in "fuse" mode, fuses it with the most similar wallpaper in the same list. The saved wallpaper itself is never changed.
const seedOf = (s) => [...String(s || '')].reduce((x, ch) => (x * 31 + ch.charCodeAt(0)) >>> 0, 7);
const LOOK_BLEND = { cinsilk: 'soft-light', plasma: 'overlay', lava: 'overlay', waves: 'overlay' };
const SPACE_SCENES = new Set(['earthorbit', 'nasasky', 'starfield', 'blackhole', 'galaxy', 'hyperspace', 'tunnel', 'cingalaxy', 'cinnebula', 'planetflyby', 'solarsystem', 'nightsky', 'earthnight', 'moonphase', 'sunmoon', 'cinaurora', 'aurora', 'mountainaurora']);
// what kind of wallpaper is it? (from its name; scenes by their own name)
function lookKind(item) {
  const t = String((item && (item.title || item.name)) || '').toLowerCase(), has = (re) => re.test(t);
  if (item && item.type === 'scene') return SPACE_SCENES.has(item.name) ? 'space' : 'plain';
  if (has(/black ?hole|event horizon/)) return 'hole';
  if (has(/space|galaxy|nebula|\bstars?\b|cosmo|cosmic|planet|astronaut|surfer|orbit|universe|alien|satellite/)) return 'space';
  if (has(/\bcars?\b|bmw|nissan|porsche|jdm|gt-?r|lambo|ferrari|mercedes|audi|toyota|supra|mustang|drift|street|racing|truck|motor|bike/)) return 'vehicle';
  if (has(/fortnite|minecraft|roblox|gta|lobby|forza|valorant|apex|zelda|pokemon|elden|skyrim|gameplay|\bgame\b/)) return 'game';
  if (has(/girl|\bboy\b|anime|woman|\bman\b|king|queen|knight|samurai|demon|hero|portrait|lady|goku|naruto|batman|spider|joker|curtain|character/)) return 'character';
  if (has(/forest|mountain|ocean|\bsea\b|beach|river|lake|snow|winter|autumn|spring|sunset|sunrise|\bsky\b|cloud|waterfall|desert|nature|landscape|valley/)) return 'nature';
  return 'plain';
}
const kindGroup = (k) => (k === 'hole' ? 'space' : k);
// Picks animated layers and a color grade that suit a wallpaper: space gets stars / nebulas / galaxies, cars a little rain or dust, characters soft sparkle or petals,
// nature layers by its colors, and game screens are left alone. Nothing heavy (black holes, tunnels, warps) goes on a car or a person.
// 'seed' makes different wallpapers get different styles; 'avoid' keeps it from repeating a style that is already on another screen.
// styles made for particular wallpapers (matched by name); the rest use the general choices by kind
const THEMES = [
  [/silver surfer|surfer/i, ['ovcosmic', 'ovsolar', 'ovcomet', 'starfield'], true],
  [/spider/i, ['ovwebs', 'ovmistblue', 'ovembers'], false],
  [/itachi/i, ['ovfeathers', 'ovmistred', 'ovsparkle'], false],
  [/toji|heavenly/i, ['ovmistred', 'ovembers', 'ovrays'], false],
  [/dark king|abyss|\bking\b/i, ['ovmistred', 'ovembers', 'ovsparkle'], false],
  [/fortnite/i, ['ovconfetti', 'ovsparkle'], false],
  [/\brio\b|blue archive/i, ['ovhalo', 'ovsparkle', 'sakura'], false],
  [/curtain/i, ['ovdust', 'ovrays', 'ovsparkle'], false],
  [/edgewalker/i, ['ovripple', 'ovmistblue', 'ovsparkle'], false],
  [/serious girl|wicked/i, ['ovsparkle', 'ovmistblue', 'ovdust'], false],
  [/dream chaser/i, ['snow', 'ovsparkle', 'ovmist'], false],
  [/bmw|nissan|gt-?r|porsche|supra|lambo|ferrari|\bcar\b/i, ['ovtrails', 'ovbokeh', 'rain', 'ovglow', 'ovmist'], false],
];
function lookFromSig(sig, seed = 0, avoid = [], kind = 'plain', title = '') {
  const v = sig ? sig.v : 0.3, s = sig ? sig.s : 0.1, colorful = s > 0.12; let hue = 0;
  if (sig && sig.h) { let bi = 0; sig.h.forEach((x, i) => { if (x > sig.h[bi]) bi = i; }); hue = bi * 30 + 15; }
  const warm = colorful && (hue >= 330 || hue < 70), green = colorful && hue >= 70 && hue < 170, cool = colorful && hue >= 170 && hue < 260;
  let pool; const theme = THEMES.find(([re]) => re.test(String(title || '')));
  if (theme) pool = theme[1];
  else if (kind === 'hole') pool = ['blackhole', 'cinnebula', 'starfield'];
  else if (kind === 'space') pool = ['starfield', 'cinnebula', 'cingalaxy', 'galaxy', 'hyperspace', 'ovcomet', 'ovmist'];
  else if (kind === 'vehicle') pool = v < 0.5 ? ['rain', 'ovbokeh', 'ovglow', 'ovmist', 'fireflies'] : ['ovmist', 'ovrays', 'fireflies'];
  else if (kind === 'game') pool = [];
  else if (kind === 'character') pool = v < 0.35 ? ['ovembers', 'ovmist', 'ovsparkle', 'ovrays', 'fireflies'] : warm ? ['sakura', 'ovsparkle', 'ovrays', 'fireflies'] : ['ovsparkle', 'ovrays', 'ovmist', 'fireflies'];
  else if (kind === 'nature') pool = green ? ['aurora', 'fireflies', 'cinaurora'] : cool ? ['aurora', 'snow', 'rain', 'cinnebula'] : ['ovmist', 'ovrays', 'fireflies', 'sakura'];
  else pool = ['ovmist', 'ovsparkle', 'fireflies', 'snow'];
  const free = pool.filter((n) => !avoid.includes(n)), list = free.length ? free : pool, big = kind === 'space' || kind === 'hole' || !!(theme && theme[2]);
  let li = 0; // (each layer gets its own slow rhythm of fading in and out, so the strength keeps changing: the first gently, a second one more strongly)
  const L = (name, amt) => { const k = li++; return { name, blend: LOOK_BLEND[name] || (big && v < 0.45 && !['starfield', 'hyperspace'].includes(name) ? 'lighten' : 'screen'), amt: amt + 14, on: 'all', wave: k === 0 ? 'soft' : 'strong', per: 28 + ((seed >> (k * 3 + 1)) % 6) * 11 }; }, ov = [];
  let ca = { style: 'none', amt: 60, spd: 50, hue: 0, sat: colorful ? 106 : 112, bri: 100, con: 104 }; // (a small change, so the brightness correction is applied)
  if (list.length) {
    const one = list[seed % list.length], amt = big ? (v < 0.3 ? 38 : 28) : (v < 0.3 ? 30 : v < 0.55 ? 22 : 16);
    ov.push(L(LOOK_BLEND[one] ? one : one, amt));
    if (big && list.length > 1 && (seed >> 2) % 3 !== 0) { const two = list[(seed + 1 + ((seed >> 4) % (list.length - 1))) % list.length]; if (two !== one) ov.push(L(two, 18)); }
  }
  if (big && !colorful) ca = { ...ca, style: ['blue', 'purple', 'none', 'cyan'][(seed >> 1) % 4], amt: 14 };
  return { ov, ca };
}
const inUseLooks = () => [...liveProcs.values()].flatMap((e) => (e.item && e.item.autoLook && e.item.mask && Array.isArray(e.item.mask.ov) ? e.item.mask.ov.map((o) => o.name) : []));
async function autoLook(item, pool = [], modeOverride, avoid = []) {
  const mode = modeOverride || loadCfg().autoLook || 'off';
  if (mode === 'off' || !item || ['fuse', 'web', 'youtube', 'creation'].includes(item.type) || (item.type === 'scene' && FUSE_NO.includes(item.name))) return item;
  try {
    const sa = await itemSig(item); let partner = null, sb = null;
    if (mode === 'fuse' && lookKind(item) !== 'game') {
      let best = 9;
      for (const c of (pool || []).filter((x) => x && x.id !== item.id && kindGroup(lookKind(x)) === kindGroup(lookKind(item)) && (!x.type || x.type === 'video' || (x.type === 'scene' && !FUSE_NO.includes(x.name)))).slice(0, 14)) {
        const sc = await itemSig(c); if (!sc) continue; const d = sigDist(sa, sc); if (d < best) { best = d; partner = c; sb = sc; }
      }
      if (best > 0.6) partner = null;
    }
    const mix = sa && sb ? { v: (sa.v + sb.v) / 2, s: (sa.s + sb.s) / 2, h: sa.h.map((x, i) => (x + sb.h[i]) / 2) } : sa, taken = avoid.concat(inUseLooks()), { ov, ca } = lookFromSig(mix, seedOf(item.id + (partner ? partner.id : '')), taken, lookKind(item), item.title);
    for (const o of ov) avoid.push(o.name); // (the next screen picked in the same change avoids it)
    if (!partner) return { type: 'fuse', id: item.id, title: item.title, a: item, b: null, autoLook: true, mask: { solo: true, snd: 'a', ov, ca, auto: true } };
        return { type: 'fuse', id: item.id, title: item.title, a: item, b: partner, autoLook: true, mask: { mode: 'merge', blend: 'auto', mergeAmt: 85, snd: 'a', ov, ca, cb: ca, auto: true } }; // (the two are blended like one scene, not cut out)
  } catch (e) { console.log('auto look failed:', e.message); return item; }
}
// ---- Creations (built in the Editor; they live on this PC only, in their own list, not in the wallpaper catalog) ----
const CR_LIMIT = 40, crDir = () => path.join(app.getPath('userData'), 'creations');
function creationSpec(spec) { // checks and tidies a creation before it runs
  const kinds = ['scene', 'video', 'image', 'text', 'clock', 'gradient', 'color', 'style', 'shape'];
  const layers = (Array.isArray(spec && spec.layers) ? spec.layers : []).slice(0, CR_LIMIT).filter((l) => l && kinds.includes(l.kind));
  for (const l of layers) {
    if (l.kind === 'scene' || l.kind === 'style') { if (typeof l.name !== 'string' || !l.name) throw new Error('A scene layer has no scene chosen'); if (FUSE_NO.includes(l.name)) throw new Error('"' + l.name + '" listens to your music, microphone or PC and cannot be used as a layer'); }
    if (l.kind === 'video' || l.kind === 'image') { if (typeof l.src !== 'string' || !l.src) throw new Error('A ' + l.kind + ' layer needs a file: choose one for "' + String(l.title || l.kind) + '"'); if (!fs.existsSync(l.src)) throw new Error('A file used by this creation is missing: ' + path.basename(String(l.src || ''))); }
    if (l.kind === 'text') l.text = String(l.text || '').slice(0, 400);
  }
  return { v: 1, bg: /^#[0-9a-f]{6}$/i.test(spec && spec.bg) ? spec.bg : '#000000', ...(['21/9', '16/10', '4/3', '32/9'].includes(spec && spec.ar) ? { ar: spec.ar } : {}), layers };
}
async function creationThumb(entry) {
  fs.mkdirSync(crDir(), { recursive: true }); const out = path.join(crDir(), entry.id + '.jpg');
  const w = new BrowserWindow({ width: 640, height: 360, show: false, frame: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  try { w.webContents.setFrameRate(10); await w.loadFile('live.html', { query: { type: 'creation', spec: JSON.stringify(creationSpec(entry.spec)), gfx: 'balanced' } }); await new Promise((r) => setTimeout(r, 5500)); fs.writeFileSync(out, (await w.webContents.capturePage()).toJPEG(82)); return out; } finally { try { w.destroy(); } catch {} }
}
ipcMain.handle('creation:save', async (_e, c) => {
  const spec = creationSpec(c && c.spec); if (!spec.layers.length) throw new Error('Add at least one layer first');
  const cfg0 = loadCfg(), list = cfg0.creations || [], id = c.id && list.some((x) => x.id === c.id) ? c.id : 'cr-' + Date.now().toString(36);
  const entry = { id, title: String((c && c.title) || 'My creation').trim().slice(0, 60) || 'My creation', spec, thumb: '' };
  try { entry.thumb = await creationThumb(entry); } catch (e) { console.log('creation picture failed:', e.message); }
  const cur = loadCfg(); saveCfg({ ...cur, creations: [...(cur.creations || []).filter((x) => x.id !== id), entry] });
  return entry;
});
ipcMain.handle('creation:remove', (_e, id) => { const c = loadCfg(), e = (c.creations || []).find((x) => x.id === id); if (e) { try { if (e.thumb) fs.unlinkSync(e.thumb); } catch {} } saveCfg({ ...c, creations: (c.creations || []).filter((x) => x.id !== id) }); return loadCfg(); });
ipcMain.handle('creation:pickImage', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Pick a picture', properties: ['openFile'], filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  fs.mkdirSync(crDir(), { recursive: true }); const dest = path.join(crDir(), 'img-' + Date.now().toString(36) + path.extname(r.filePaths[0]).toLowerCase()); fs.copyFileSync(r.filePaths[0], dest); return dest;
});
async function startLive(item, target = 'all', opts = {}) {
  const ordered = monitors().sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0)); // main screen first
  let picked = target === 'all' ? ordered : [ordered.find((m) => m.key === target) || ordered[0]];
  const spanScene = item.type === 'scene' && /^cursor/.test(item.name || '');
  if (spanScene && target !== 'all') { const same = [...liveProcs].filter(([k, e]) => k !== target && e.item && e.item.type === 'scene' && e.item.name === item.name).map(([k]) => k); picked = picked.concat(ordered.filter((m) => same.includes(m.key) && !picked.includes(m))); }
  let payload;
  if (item.type === 'creation') payload = { type: 'creation', spec: JSON.stringify(creationSpec(item.spec)) };
  else if (item.type === 'fuse') payload = { type: 'fuse', fa: JSON.stringify(await fusePart(item.a)), fb: JSON.stringify(item.mask && item.mask.solo ? {} : await fusePart(item.b)), fm: JSON.stringify(item.mask || {}) };
  else if (item.type === 'scene') payload = { type: 'scene', name: item.name, ...sceneExtra(item.name) };
  else if (item.type === 'youtube') payload = { type: 'youtube', vid: item.vid, list: item.list };
  else if (item.type === 'web') { // a web page or a local HTML file, shown in a locked-down window
    if (!webUrlOk(item.url)) throw new Error('That web wallpaper address is not allowed (only http, https, or an .html file you picked)');
    payload = { type: 'web', url: item.url };
  }
  else {
    let file = item.file;
    if (!file && item.manifest) item = { ...item, full: await nasaFile(item.manifest) }; // NASA lists several sizes per video
    if (!file && MB_DL.test(item.full || '')) file = await mbDownload(item.full);
    if (!file) file = await download(item, liveDir(), 'mp4');
    if (!fs.existsSync(file)) throw new Error('Video file is missing');
    payload = { type: 'video', src: file };
  }
  if (spanScene) { // the mouse scenes share one world across all screens (desktop layout in window units, a shared start time, the smallest screen height as the size reference)
    const bs = screen.getAllDisplays().map((d) => d.bounds), x0 = Math.min(...bs.map((b) => b.x)), y0 = Math.min(...bs.map((b) => b.y)), x1 = Math.max(...bs.map((b) => b.x + b.width)), y1 = Math.max(...bs.map((b) => b.y + b.height));
    payload.span = JSON.stringify({ e: Date.now(), d: [x0, y0, x1 - x0, y1 - y0], k: Math.min(...bs.map((b) => b.height)) });
  }
  const cfg = loadCfg();
  if (cfg.liveQuality !== 'native') payload.q = +cfg.liveQuality;
  if (cfg.liveSharp && cfg.liveSharp !== 'normal') payload.sharp = cfg.liveSharp; // how a small GIF / video is enlarged
  payload.gfx = liveGfxNow = effectiveGfx(); // how much detail the animated scenes draw (Eco keeps the PC cool and quiet; Ultra adds detail and frame rate)
  if (cfg.fpsCapOn && +cfg.fpsCap >= 15 && +cfg.fpsCap <= 500) payload.fps = +cfg.fpsCap;
  if (spanScene && [165, 500].includes(+cfg.cursorHz)) payload.simhz = +cfg.cursorHz; // the mouse scenes step 60, 165 or 500 times a second (the same on every screen, so they stay in lock-step)
  if (+cfg.renderScale > 100 && +cfg.renderScale <= 300) payload.rs = +cfg.renderScale / 100; // draw the animated scenes bigger than the screen and shrink to fit (sharper) // optional frame rate limit (off unless you turn it on)
  if (['off', 'soft', 'strong'].includes(cfg.sceneGlow)) payload.fin = cfg.sceneGlow; // the light glow and camera finish on the 2D scenes (normal unless changed)
  if (cfg.screenType === 'ips') payload.scr = 'ips'; // grade the cinematic scenes for an IPS / LCD screen instead of OLED
  if (item.type === 'youtube' && +cfg.ytRes > 0) payload.r = +cfg.ytRes; // the picture quality asked of YouTube: 1080, 1440 or 2160 (0 = automatic)
  if (item.type === 'youtube' && cfg.ytClean !== false) payload.z = 1.22; // crop away YouTube's title bar, logo and buttons
  if (cfg.liveFit === 'contain') payload.fit = 'contain'; // show the whole picture instead of cropping it to fill the screen
  liveState.look = cfg.look || null; liveState.volume = cfg.liveVolume; liveState.shuffle = !!cfg.liveShuffle; liveState.pausedKeys = []; liveState.lowPrio = !!cfg.lowPriority; writeLiveState();
  const saved = { ...item, ...(payload.src ? { file: payload.src } : {}) };
  // with several screens playing the same thing, only the first one makes sound
  const modes = await Promise.all(picked.map((m, i) => spawnLive(m.key, { ...payload, key: m.key, did: m.did, rect: { x: m.x, y: m.y, w: m.w, h: m.h }, mute: i > 0, ...twExtra(item, m.key), ...(opts.fade && cfg.fade !== false ? { fade: 1200 } : {}), ...(i === 0 && cfg.liveLyrics ? { lyrics: true } : {}), ...(cfg.clock && cfg.clock.on && clockHere(cfg.clock, m) ? { clk: JSON.stringify({ ...cfg.clock, afont: cfg.clock.style === 'spaced' ? findAnurati() : '' }) } : {}), ...(i === 0 && cfg.notif && ((cfg.notif.on && cfg.notif.corner) || (cfg.notif.calls && cfg.notif.calls.on && cfg.notif.calls.popup !== false)) ? { notif: true, npos: cfg.notif.pos, nsecs: cfg.notif.secs } : {}) }, saved)));
  console.log('live attach mode:', modes.join(' | '));
  if (opts.persist !== false) persistLive();
  if (cfg.pauseOnFullscreen && !watcher) startWatcher();
  return { mode: modes[0], file: payload.src };
}

// ---- Live Lyrics: reads what is playing from Windows (title, artist, position; no audio is recorded), then finds time-synced lyrics on lrclib.net ----
const MEDIA_PS = [
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "$ErrorActionPreference = 'SilentlyContinue'",
  "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
  "$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
  "function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }",
  "[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]",
  "$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])",
  "$parent = [int]$env:WP_PARENT",
  "$self = [string]$env:WP_SELF",
  "while ($true) {",
  "  if (-not (Get-Process -Id $parent)) { break }",
  "  $best = $null",
  // A live video wallpaper registers itself with Windows as a media session, and it sorts FIRST, so without this
  // the lyrics/song read showed our own wallpaper (title 'live', no artist) instead of Spotify.
  "  foreach ($s in $mgr.GetSessions()) { if ($self -and ([string]$s.SourceAppUserModelId) -match $self) { continue }; $st = [string]$s.GetPlaybackInfo().PlaybackStatus; if ($st -eq 'Playing') { $best = $s; break } elseif (-not $best) { $best = $s } }",
  "  if ($best) {",
  "    $p = Await ($best.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])",
  "    $tl = $best.GetTimelineProperties(); $st = [string]$best.GetPlaybackInfo().PlaybackStatus",
  "    $pos = $tl.Position.TotalSeconds",
  "    if ($st -eq 'Playing') { $pos += ([DateTimeOffset]::UtcNow - $tl.LastUpdatedTime).TotalSeconds }",
  "    $o = @{ status = $st; artist = $p.Artist; title = $p.Title; pos = [math]::Round($pos, 2); dur = [math]::Round($tl.EndTime.TotalSeconds, 2) }",
  "  } else { $o = @{ status = 'None' } }",
  "  Write-Output ('MEDIA ' + ($o | ConvertTo-Json -Compress))",
  "  Start-Sleep -Milliseconds $(if ($o.status -eq 'Playing') { 1000 } else { 3000 })",   // position is interpolated from LastUpdatedTime, so idle polling can be lazy
  "}",
].join('\n');

const lrcParse = (s) => { // "[01:23.45] words" -> [{ t: seconds, text }]
  const out = [];
  for (const line of String(s || '').split(/\r?\n/)) { const tags = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)], text = line.replace(/\[[^\]]*\]/g, '').trim(); for (const m of tags) out.push({ t: +m[1] * 60 + +m[2], text }); }
  return out.sort((a, b) => a.t - b.t);
};
async function findLyrics(artist, title, dur) {
  const clean = (t) => t.replace(/\s*[\(\[][^\)\]]*(remaster|version|live|mono|stereo|edit|mix|deluxe|bonus|feat|official|video|lyric|audio)[^\)\]]*[\)\]]/gi, '').replace(/\s+-\s+(\d{4}\s+)?(remaster(ed)?|.*version|.*mix|.*edit|live.*|mono|stereo).*$/i, '').replace(/\s{2,}/g, ' ').trim();
  const art = String(artist || '').replace(/ - Topic$/i, '').split(/,|&| feat\.?| ft\.?| x /i)[0].trim(), ttl = clean(String(title || ''));
  const get = async (u) => { const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) }); return r.ok ? r.json() : null; };
  const pack = (j) => j && (j.syncedLyrics || j.plainLyrics) ? { synced: j.syncedLyrics ? lrcParse(j.syncedLyrics) : [], plain: j.plainLyrics || '' } : null;
  const tries = [[artist, title], [art, ttl]], seen = new Set();
  for (const [a, t] of tries) { const k = a + '|' + t; if (!a || !t || seen.has(k)) continue; seen.add(k); const base = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(a)}&track_name=${encodeURIComponent(t)}`; for (const u of dur > 0 ? [base + '&duration=' + Math.round(dur), base] : [base]) { try { const j = await get(u); if (j && (!dur || !j.duration || Math.abs(j.duration - dur) <= 15)) { const r = pack(j); if (r) return r; } } catch {} } }
  try { // a looser search, preferring a version of about the same length with synced lyrics
    const list = await get(`https://lrclib.net/api/search?q=${encodeURIComponent((art + ' ' + ttl).trim())}`) || [];
    const ok = list.filter((r) => r.syncedLyrics || r.plainLyrics).sort((a, b) => (b.syncedLyrics ? 1 : 0) - (a.syncedLyrics ? 1 : 0) || Math.abs((a.duration || 0) - dur) - Math.abs((b.duration || 0) - dur));
    const best = ok.find((r) => !dur || !r.duration || Math.abs(r.duration - dur) <= 10); if (best) return pack(best);
  } catch {}
  return null;
}
let lyricsPoller = null;
function startLyricsFeed() {
  if (lyricsPoller) return;
  const p = runPs(MEDIA_PS, { WP_PARENT: String(process.pid), WP_SELF: 'wallpaperhub' });
  lyricsPoller = spawn('powershell.exe', p.args, { env: p.env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  app.on('will-quit', () => { try { lyricsPoller.kill(); } catch {} });
  const push = (js) => { if (liveWin && !liveWin.isDestroyed()) liveWin.webContents.executeJavaScript(js).catch(() => {}); };
  let key = '', buf = '', status = 'idle';
  lyricsPoller.stdout.on('data', (b) => {
    buf += b.toString(); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line.startsWith('MEDIA ')) continue;
      let m; try { m = JSON.parse(line.slice(6)); } catch { continue; }
      if (!m.title || m.status === 'None') { status = 'idle'; key = ''; push('window.__lyrS={status:"idle"}'); continue; }
      const k = (m.artist || '') + '|' + m.title;
      if (k !== key) { key = k; status = 'loading'; const mine = k; push('window.__lyrL=null');
        findLyrics(m.artist, m.title, m.dur).then((r) => { if (key !== mine) return; status = r ? 'ok' : 'none'; push('window.__lyrL=' + JSON.stringify(r ? { key: mine, ...r } : null)); }).catch(() => { if (key === mine) status = 'none'; }); }
      push('window.__lyrS=' + JSON.stringify({ status, playing: m.status === 'Playing', pos: m.pos, dur: m.dur, at: Date.now(), title: m.title, artist: m.artist, key }));
    }
  });
}

// The main window is created when you open it and given up again shortly after it is hidden to the tray (a hidden window still keeps
// about 200 MB of page and graphics memory alive). Starting with Windows (--hidden) makes no window at all.
let winTimer = null, winRecycling = false;
function makeMainWindow(show) {
  if (win && !win.isDestroyed()) { clearTimeout(winTimer); if (show) { win.show(); win.focus(); try { win.webContents.invalidate(); } catch {} } return win; }
  const w = win = new BrowserWindow({ width: 1200, height: 800, show: false, backgroundColor: '#030305', autoHideMenuBar: true, title: 'Wallpaper Hub', icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  w.loadFile('index.html');
  if (show) w.once('ready-to-show', () => { if (!w.isDestroyed()) { w.show(); w.focus(); } });
  w.webContents.on('context-menu', (_e, p) => {
    if (!p.isEditable) return;
    Menu.buildFromTemplate([{ role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy },
      { role: 'paste', enabled: p.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll' }]).popup();
  });
  w.on('show', () => { clearTimeout(winTimer); const fix = () => { try { if (!w.isDestroyed()) w.webContents.invalidate(); } catch {} }; fix(); setTimeout(fix, 300); setTimeout(fix, 1200); });
  w.webContents.on('render-process-gone', () => { try { if (!w.isDestroyed()) w.webContents.reload(); } catch {} });
  w.webContents.on('did-fail-load', (_e, code) => { if (code !== -3) setTimeout(() => { try { if (!w.isDestroyed()) w.loadFile('index.html'); } catch {} }, 800); });
  w.on('close', (e) => {
    const c = loadCfg();
    if ((c.autoMinutes > 0 || c.live || audioPlaying) && !app.isQuitting) {
      e.preventDefault(); w.hide();
      clearTimeout(winTimer); winTimer = setTimeout(() => { if (!w.isDestroyed() && !w.isVisible()) { winRecycling = true; w.destroy(); } }, 20000);
    }
  });
  w.on('closed', () => { statsWant('tab', false); const recycled = winRecycling; winRecycling = false; if (win === w) win = null; if (!recycled) app.quit(); }); // (hidden helper windows, like music, must not keep the app alive)
  return w;
}

// ---- runs inside a separate live-wallpaper process (--live=<base64 json>), one per screen ----
function fadeWin(w, to, D, done) { // smooth eased change of the whole wallpaper window's opacity
  if (!w || w.isDestroyed()) return; let from = 1; try { from = w.getOpacity(); } catch {}
  const t0 = Date.now(), iv = setInterval(() => { const k = Math.min(1, (Date.now() - t0) / D), e = k * k * (3 - 2 * k); try { if (!w.isDestroyed()) w.setOpacity(from + (to - from) * e); } catch {} if (k >= 1 || w.isDestroyed()) { clearInterval(iv); if (done) done(); } }, 16);
}
async function createLiveWindow(payload) {
  const d = screen.getAllDisplays().find((x) => String(x.id) === String(payload.did)) || screen.getAllDisplays().find((x) => String(x.id) === payload.key) || screen.getPrimaryDisplay();
  const pr = screen.dipToScreenRect(null, d.bounds);
  const r = payload.rect || { x: pr.x, y: pr.y, w: pr.width, h: pr.height }; // physical pixels
  liveWin = new BrowserWindow({ x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height, frame: false, show: false, skipTaskbar: true,
    focusable: false, resizable: false, backgroundColor: '#000000',
    webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, ...(payload.type === 'web' ? { partition: 'web-wall' } : {}) } }); // web wallpapers get their own temporary storage (nothing is kept)
  if (payload.type === 'web') {
    const ses = liveWin.webContents.session, wc = liveWin.webContents;
    ses.setPermissionRequestHandler((_w, _p, cb) => cb(false)); // no camera, microphone, location, notifications, clipboard...
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const home = new URL(payload.url);
    wc.on('will-navigate', (e, to) => { try { const t = new URL(to); if (t.origin !== home.origin || t.protocol !== home.protocol) e.preventDefault(); } catch { e.preventDefault(); } }); // the page can reload itself but not wander off to other sites
    wc.on('dom-ready', () => wc.executeJavaScript('(()=>{if(window.__whHook)return;window.__whHook=1;const r=window.requestAnimationFrame.bind(window),q=[];window.__whPause=false;window.requestAnimationFrame=f=>r(t=>{if(window.__whPause)q.push(f);else f(t)});window.__whResume=()=>{window.__whPause=false;q.splice(0).forEach(f=>r(f))}})()').catch(() => {}));
  }
  if (payload.type === 'video') { liveWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); liveWin.webContents.on('will-navigate', (e) => e.preventDefault()); } // a downloaded video can only play: no popups, no leaving the page
  liveKind = payload.type;
  try { liveWin.setOpacity(0); } catch {} // starts invisible (fades in over the old wallpaper when crossfading, or just appears once loaded)
  const hwnd = liveWin.getNativeWindowHandle().readBigUInt64LE(0).toString();
  const ap = runPs(ATTACH_PS, { WP_HWND: hwnd, WP_X: String(r.x), WP_Y: String(r.y), WP_W: String(r.w), WP_H: String(r.h), WP_TOP: payload.fade ? '1' : '0' });
  const attachP = new Promise((res, rej) => execFile('powershell.exe', ap.args, { env: ap.env, windowsHide: true }, (e, out, err) => { fs.unlink(ap.file, () => {}); e ? rej(new Error(err || e.message)) : res(out.trim()); })); // started now so it overlaps with loading the picture
  attachP.catch(() => {});
  const hears = ['visualizer', 'beatwaves', 'pulsenebula', 'beattunnel', 'eqcity', 'lasers', 'liquidbars', 'fireworks', 'audiogalaxy', 'lyrics'].includes(payload.name);
  const listensMic = ['voiceorb', 'claplights'].includes(payload.name); // opt-in: the app asks before these are applied // scenes that move to the music
  if (hears) { // let the visualizer listen to the sound the PC is playing (system output only, never the microphone)
    liveWin.webContents.session.setDisplayMediaRequestHandler((_req, cb) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((src) => cb({ video: src[0], audio: 'loopback' })).catch(() => cb({}));
    });
  }
  liveWin.webContents.on('console-message', (...a) => { // the YouTube page reports player errors this way
    const msg = typeof a[1] === 'object' ? a[1].message : a[2];
    if (/^(YTERROR|AUDIO-CAPTURE)/.test(msg || '')) console.log(msg);
  });
  if (payload.type === 'youtube') await liveWin.loadURL(`http://127.0.0.1:${await ytServer()}/?v=${encodeURIComponent(payload.vid || '')}&l=${encodeURIComponent(payload.list || '')}&q=${payload.q || 0}&z=${payload.z || 1}&r=${payload.r || 0}`);
  else if (payload.type === 'web') { await liveWin.loadURL(payload.url); if (payload.mute !== false) liveWin.webContents.setAudioMuted(true); }
  else { if (payload.span) { try { const s = JSON.parse(payload.span); s.m = [d.bounds.x, d.bounds.y, d.bounds.width, d.bounds.height]; payload.span = JSON.stringify(s); } catch {} } await liveWin.loadFile('live.html', { query: payload }); }
  if (payload.type === 'youtube') {
    ytKey = String(payload.vid || payload.list || 'x').replace(/[^\w-]/g, '') + '-' + (liveWin.getBounds().width || 0);
    try { const p = path.join(app.getPath('userData'), 'yt-last-' + ytKey + '.jpg'); if (fs.existsSync(p)) { const u = 'data:image/jpeg;base64,' + fs.readFileSync(p).toString('base64'); if (!ytLast) ytLast = u; await liveWin.webContents.executeJavaScript('window.__resuming=1;window.ytFreeze(' + JSON.stringify(u) + ')').catch(() => {}); } } catch {}
  }
  if ((payload.type === 'youtube' || payload.type === 'web') && payload.tw) { try { const twjs = fs.readFileSync(path.join(__dirname, 'tw.js'), 'utf8'); await liveWin.webContents.executeJavaScript(twjs + '\nwhApplyTweaks(' + payload.tw + ',{root:"html"})'); } catch (e) { console.log('tweaks failed: ' + e.message); } }
  if ((payload.type === 'youtube' || payload.type === 'web') && payload.clk) { // the clock and date over a YouTube / web wallpaper (they are not drawn by live.html)
    try { const co = JSON.parse(payload.clk); if (co.afont && String(co.afont).startsWith('file:///')) { try { co.afont = 'data:font/ttf;base64,' + fs.readFileSync(decodeURIComponent(String(co.afont).slice(8))).toString('base64'); } catch { co.afont = ''; } }
      await liveWin.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, 'clock.js'), 'utf8') + '\nstartClock(' + JSON.stringify(co) + ')'); } catch (e) { console.log('clock failed: ' + e.message); } }
  if (hears) liveWin.webContents.executeJavaScript('window.startAudioCapture()', true).catch(() => {}); // true = counts as a user action
  if (payload.name === 'lyrics' || (payload.lyrics && hears)) startLyricsFeed();
  if (listensMic) liveWin.webContents.executeJavaScript('window.startMic()', true).catch(() => {});
  if (payload.name === 'earthorbit' || payload.name === 'nasasky') { // a click on the empty desktop zooms to the object under the pointer
    try { const p = runPs(CLICK_PS, { WH_PPID: String(process.pid) }), cw = spawn('powershell.exe', p.args, { env: p.env, windowsHide: true }); setTimeout(() => fs.unlink(p.file, () => {}), 5000); let nClick = 0;
      cw.stdout.on('data', (b) => { for (const line of b.toString().split(/\r?\n/)) { if (!/^click -?\d+ -?\d+/.test(line.trim()) || livePausedNow) continue; try { const pt = screen.getCursorScreenPoint(), bb = d.bounds; if (pt.x >= bb.x && pt.x < bb.x + bb.width && pt.y >= bb.y && pt.y < bb.y + bb.height && liveWin && !liveWin.isDestroyed()) liveWin.webContents.executeJavaScript('window.__orbitClick=' + (++nClick) + ';0').catch(() => {}); } catch {} } });
      app.on('will-quit', () => { try { cw.kill(); } catch {} }); process.on('exit', () => { try { cw.kill(); } catch {} }); } catch {}
  }
  if (payload.name === 'nasasky') { // NASA's discoveries on the sky: exoplanets (NASA Exoplanet Archive) and galaxies, nebulae and clusters (OpenNGC). Public data, one shared saved copy, refreshed weekly.
    const dir = path.join(app.getPath('appData'), 'wallpaper-hub'), cacheF = path.join(dir, 'nasasky-cache.json'), lockF = path.join(dir, 'nasasky-lock.txt');
    const read = () => { try { return JSON.parse(fs.readFileSync(cacheF, 'utf8')); } catch { return null; } };
    let shown = 0;
    const push = () => { try { const d = read(); if (d && d.exo && d.t !== shown && liveWin && !liveWin.isDestroyed()) { shown = d.t; liveWin.webContents.executeJavaScript('window.__sky=' + JSON.stringify(d) + ';0').catch(() => {}); } } catch {} };
    const csv = (txt) => { const rows = []; let row = [], cell = '', q = false; for (let i = 0; i < txt.length; i++) { const c = txt[i]; if (q) { if (c === '"') { if (txt[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; } else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c; } if (cell || row.length) { row.push(cell); rows.push(row); } return rows; };
    const hms = (s, h) => { const m = String(s || '').match(/^([+-]?)(\d+):(\d+):([\d.]+)$/); if (!m) return null; const v = (+m[2]) + (+m[3]) / 60 + (+m[4]) / 3600; return (m[1] === '-' ? -1 : 1) * v * (h ? 15 : 1); };
    const build = (exoTxt, ngcTxt) => {
      const E = csv(exoTxt), eh = E[0], ei = (n) => eh.indexOf(n), exo = [];
      for (let i = 1; i < E.length; i++) { const f = E[i]; if (f.length < 8 || !f[ei('ra')]) continue; const n = (k) => { const v = parseFloat(f[ei(k)]); return isFinite(v) ? +v.toPrecision(5) : null; };
        exo.push([f[ei('pl_name')], f[ei('hostname')], n('ra'), n('dec'), n('sy_dist'), +f[ei('disc_year')] || null, f[ei('discoverymethod')], f[ei('disc_facility')], n('pl_rade'), n('pl_bmasse'), n('pl_orbper'), n('pl_eqt'), +f[ei('sy_pnum')] || 1]); }
      const L = ngcTxt.split(/\r?\n/), H = L[0].split(';'), ix = (n) => H.indexOf(n), ngc = [], KEEP = new Set(['G', 'GPair', 'GTrpl', 'GGroup', 'PN', 'HII', 'EmN', 'RfN', 'Neb', 'SNR', 'OCl', 'GCl', 'Cl+N', 'Nova']);
      for (let i = 1; i < L.length; i++) { if (!L[i]) continue; const f = L[i].split(';'), ty = f[ix('Type')]; if (!KEEP.has(ty)) continue; const ra = hms(f[ix('RA')], true), de = hms(f[ix('Dec')], false); if (ra === null || de === null) continue;
        const z = parseFloat(f[ix('Redshift')]), mag = parseFloat(f[ix('V-Mag')]) || parseFloat(f[ix('B-Mag')]), maj = parseFloat(f[ix('MajAx')]);
        ngc.push([f[ix('Name')], ty, +ra.toFixed(4), +de.toFixed(4), isFinite(mag) ? mag : null, isFinite(maj) ? maj : null, isFinite(z) ? z : null, f[ix('Common names')] || '', f[ix('M')] || '', f[ix('Const')] || '', f[ix('Hubble')] || '']); }
      return { v: 2, t: Date.now(), exo, ngc };
    };
    const refresh = async () => { const d = read(); if (d && d.v === 2 && Date.now() - d.t < 7 * 86400e3) return;
      try { if (fs.existsSync(lockF) && Date.now() - (+fs.readFileSync(lockF, 'utf8') || 0) < 10 * 60e3) return; } catch {}
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(lockF, String(Date.now())); } catch {}
      try { const a = await fetch('https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=select+pl_name,hostname,ra,dec,sy_dist,disc_year,discoverymethod,disc_facility,pl_rade,pl_bmasse,pl_orbper,pl_eqt,sy_pnum+from+pscomppars&format=csv', { headers: { 'User-Agent': UA } });
        const b = await fetch('https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/NGC.csv', { headers: { 'User-Agent': UA } });
        if (a.ok && b.ok) { const out = build(await a.text(), await b.text()); if (out.exo.length > 1000 && out.ngc.length > 1000) fs.writeFileSync(cacheF, JSON.stringify(out)); } } catch (e) { console.log('nasasky download failed:', e.message); }
      try { fs.unlinkSync(lockF); } catch {} push(); };
    push(); setTimeout(push, 3000); setTimeout(refresh, 4000 + Math.random() * 4000); setInterval(() => { push(); refresh(); }, 60 * 1000);
  }
  if (payload.name === 'earthorbit') { // real-time satellites and debris: public orbit data from CelesTrak (a normal web request, nothing about you is sent)
    // CelesTrak only allows one download of each list per ~2 hours, and every screen runs its own process, so all screens share ONE saved copy (and one downloader at a time); the saved copy also keeps it working offline
    const dir = path.join(app.getPath('appData'), 'wallpaper-hub'), cacheF = path.join(dir, 'orbit-cache.json'), lockF = path.join(dir, 'orbit-lock.txt');
    const GR = [['stn', 'stations'], ['deb1', 'cosmos-2251-debris'], ['deb2', 'iridium-33-debris'], ['deb3', 'fengyun-1c-debris'], ['deb4', 'cosmos-1408-debris'], ['new', 'last-30-days'], ['act', 'active']];
    const read = () => { try { return JSON.parse(fs.readFileSync(cacheF, 'utf8')); } catch { return {}; } };
    let shown = 0;
    const push = () => { try { const d = read(); if (d.act && d.t !== shown && liveWin && !liveWin.isDestroyed()) { shown = d.t; liveWin.webContents.executeJavaScript('window.__orbit=' + JSON.stringify(d) + ';0').catch(() => {}); } } catch {} };
    const refresh = async () => {
      try { if (fs.existsSync(lockF) && Date.now() - (+fs.readFileSync(lockF, 'utf8') || 0) < 10 * 60e3) return; } catch {}
      const d = read(), now = Date.now(); d.ts = d.ts || {}; d.att = d.att || {};
      const todo = GR.filter(([k]) => (!d[k] || now - (d.ts[k] || 0) > 6 * 3600e3) && now - (d.att[k] || 0) > 130 * 60e3); if (!todo.length) return;
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(lockF, String(now)); } catch {}
      for (const [k, g] of todo) { d.att[k] = Date.now();
        try { const r = await fetch('https://celestrak.org/NORAD/elements/gp.php?GROUP=' + g + '&FORMAT=tle', { headers: { 'User-Agent': UA } }); if (r.ok) { const txt = await r.text(); if (/^1 \d{5}/m.test(txt)) { d[k] = txt; d.ts[k] = Date.now(); } } } catch {}
        await new Promise((res) => setTimeout(res, 1500)); }
      d.t = Math.max(0, ...Object.values(d.ts)); try { fs.writeFileSync(cacheF, JSON.stringify(d)); } catch {} try { fs.unlinkSync(lockF); } catch {}
      push();
    };
    push(); setTimeout(push, 3000); setTimeout(refresh, 6000 + Math.random() * 4000); setInterval(() => { push(); refresh(); }, 60 * 1000);
  }
  if (payload.name === 'earthiss') { // the Space Station's position comes from a free public tracker (wheretheiss.at); nothing about you is sent except a normal web request
    const poll = async () => { try { const j = await (await fetch('https://api.wheretheiss.at/v1/satellites/25544', { headers: { 'User-Agent': UA } })).json(); if (liveWin && !liveWin.isDestroyed() && typeof j.latitude === 'number') liveWin.webContents.executeJavaScript('window.__iss=' + JSON.stringify({ lat: j.latitude, lon: j.longitude, alt: j.altitude, vel: j.velocity, t: Date.now() })).catch(() => {}); } catch {} };
    poll(); setInterval(poll, 5000);
  }
  if (payload.type === 'fuse' || payload.type === 'creation') { // parallax: the desktop layer gets no mouse events, so read the pointer from here (position only); off this screen the layers settle back to the middle
    let wantPar = 0; try { wantPar = payload.type === 'creation' ? ((JSON.parse(payload.spec || '{}').layers || []).some((l) => +l.par > 0) ? 1 : 0) : +JSON.parse(payload.fm || '{}').parallax || 0; } catch {}
    if (wantPar > 0) setInterval(() => { if (livePausedNow) return; try { const p = screen.getCursorScreenPoint(), b = d.bounds, inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height, cx = inside ? (p.x - b.x) / b.width : 0.5, cy = inside ? (p.y - b.y) / b.height : 0.5; if (liveWin && !liveWin.isDestroyed()) liveWin.webContents.executeJavaScript('window.__cursor={x:' + cx.toFixed(4) + ',y:' + cy.toFixed(4) + '}').catch(() => {}); } catch {} }, 33);
  }
  if (/^cursor/.test(payload.name || '')) { // mouse scenes: the pointer in this screen's coordinates even while it is on another screen (so effects cross the edge smoothly), 60 times a second
    let SP = null; try { SP = payload.span ? JSON.parse(payload.span).d : null; } catch {}
    setInterval(() => { if (livePausedNow) return; try { const p = screen.getCursorScreenPoint(), b = d.bounds, on = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height ? 1 : 0, R0 = SP || [b.x, b.y, b.width, b.height], cx = (p.x - R0[0]) / R0[2], cy = (p.y - R0[1]) / R0[3]; if (liveWin && !liveWin.isDestroyed()) liveWin.webContents.executeJavaScript('window.__cursor={x:' + Math.max(-6, Math.min(7, cx)).toFixed(5) + ',y:' + Math.max(-6, Math.min(7, cy)).toFixed(5) + ',i:' + on + '}').catch(() => {}); } catch {} }, +payload.simhz >= 165 ? 6 : 16);
  } else if (payload.name === 'earthorbit' || payload.name === 'nasasky') { // the desktop layer gets no mouse events, so read the pointer from here (position only, no clicks or keys)
    setInterval(() => { if (livePausedNow) return; try { const p = screen.getCursorScreenPoint(), b = d.bounds; if (liveWin && !liveWin.isDestroyed()) liveWin.webContents.executeJavaScript(`window.__cursor={x:${Math.max(0, Math.min(1, (p.x - b.x) / b.width)).toFixed(4)},y:${Math.max(0, Math.min(1, (p.y - b.y) / b.height)).toFixed(4)},i:${p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height ? 1 : 0}}`).catch(() => {}); } catch {} }, 33);
  }
  const mode = await attachP;
  liveWin.showInactive(); // makes Chromium treat it as visible so it paints
  liveWin.webContents.invalidate();
  if (!payload.fade) { // the window stays see-through until its first picture is really painted (a window made visible a moment too early shows as a black flash)
    try { await Promise.race([liveWin.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))'), new Promise((r) => setTimeout(r, 900))]); } catch {}
    try { if (!liveWin.isDestroyed()) liveWin.setOpacity(1); } catch {}
  }
  if (payload.fade) { // fade in once the new picture is really playing (and the old one has started fading out)
    const D = payload.fade, w = liveWin, slow = payload.type === 'youtube' || payload.type === 'web' || payload.type === 'fuse' || payload.type === 'creation', t0 = Date.now();
    const ready = async () => { if (slow) return Date.now() - t0 > 2500; try { return await w.webContents.executeJavaScript('(()=>{const v=document.querySelector("video");if(v&&v.src&&getComputedStyle(v).display!=="none")return v.readyState>=3&&!v.paused&&v.currentTime>0;if(window.__drawn!==undefined)return window.__drawn>=8;return true})()'); } catch { return true; } };
    const poll = async () => { if (!w || w.isDestroyed()) return; if (Date.now() - t0 < 5000 && !(await ready())) return setTimeout(poll, 60); fadeWin(w, 1, D, () => console.log('FADED')); };
    poll(); setTimeout(() => { try { if (!w.isDestroyed()) w.setOpacity(1); } catch {} }, 10000); // never leave it see-through
  }
  return mode;
}

function runLiveProcess() {
  // Chromium would otherwise report this wallpaper video to Windows as a media session - and because it is always
  // playing it becomes the CURRENT session, so the keyboard's play/pause/next keys and the Windows media flyout
  // drive the wallpaper instead of Spotify. Only the live processes get this; the app's own audio player keeps
  // its normal Windows media controls. Must be set before the app is ready, which is why it sits here.
  app.commandLine.appendSwitch('disable-features', 'MediaSessionService,HardwareMediaKeyHandling');
  // fewer helper processes per screen: the network helper and the graphics helper run inside the main process of the wallpaper (saves memory)
  app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess'); app.commandLine.appendSwitch('in-process-gpu');
  const payload = JSON.parse(Buffer.from(LIVE_ARG.slice('--live='.length), 'base64').toString());
  const myKey = String(payload.key || 'main'), mute = !!payload.mute;
  app.setPath('userData', path.join(app.getPath('appData'), 'wallpaper-hub-live-' + myKey)); // own profile per screen so they never fight over files
  app.whenReady().then(async () => {
    try { const mode = await createLiveWindow(payload); liveReady = true; console.log('ATTACHED ' + mode); } catch (e) { console.log('ERROR ' + e.message); app.exit(1); }
  });
  // (Electron has no usable stdin, so talk through a state file and watch the parent by pid)
  const parent = +(process.argv.find(a => a.startsWith('--parent=')) || '=0').split('=')[1];
  const stateFile = path.join(app.getPath('appData'), 'wallpaper-hub', 'live-state.txt');
  let last = {}, meterAt = 0, meterN = null, meterT = 0, lpPrev = null, lpAt = 0;
  const meterFile = path.join(app.getPath('appData'), 'wallpaper-hub', 'live-meter-' + myKey + '.json');
  setInterval(() => {
    try { process.kill(parent, 0); } catch { app.exit(0); }
    if (!liveReady) return; // don't consume the state before the window exists
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const paused = !!s.paused || !!s.battery || !!s.appPause || !!s.locked || (Array.isArray(s.pausedKeys) && s.pausedKeys.includes(myKey)) || (!!s.callHold && liveKind !== 'scene'); // a fullscreen app on THIS screen, or a Discord call
      const vol = (mute || (Array.isArray(s.mutedKeys) && s.mutedKeys.includes(myKey)) || !!s.appMute) ? 0 : s.volume;
      if (!!s.throttle !== last.thr && liveWin && !liveWin.isDestroyed()) liveWin.webContents.executeJavaScript('window.__capFps=' + (s.throttle ? 30 : 0) + ';0').catch(() => {});
      const lp = !!s.lowPrio; // "give games more CPU": the wallpaper's processes run at lower priority
      if (lp !== lpPrev || (lp && Date.now() - lpAt > 15000)) { lpPrev = lp; lpAt = Date.now(); try { for (const m of app.getAppMetrics()) { try { os.setPriority(m.pid, lp ? os.constants.priority.PRIORITY_BELOW_NORMAL : os.constants.priority.PRIORITY_NORMAL); } catch {} } } catch {} }
      if (s.meter && liveWin && !liveWin.isDestroyed() && Date.now() - meterAt >= 1500) { // live readout is on: report how many frames this screen really draws
        meterAt = Date.now();
        liveWin.webContents.executeJavaScript('[window.__drawn===undefined?-1:window.__drawn,window.__rw||innerWidth,window.__rh||innerHeight]').then(([n, w, h]) => {
          const t = Date.now(), fps = n < 0 || meterN === null ? null : Math.round((n - meterN) * 1000 / Math.max(1, t - meterT)); meterN = n < 0 ? null : n; meterT = t;
          try { fs.writeFileSync(meterFile, JSON.stringify({ fps, w, h, t })); } catch {}
        }).catch(() => {});
      }
      if (paused !== last.paused) setLivePausedLocal(paused);
      if (vol !== last.vol) setLiveVolumeLocal(vol);
      const lk = cssLook(s.look); if (lk !== last.look && liveWin && !liveWin.isDestroyed()) liveWin.webContents.executeJavaScript(`document.documentElement.style.filter=${JSON.stringify(lk)}`).catch(() => {}); // brightness / contrast / color, applied to the whole wallpaper
      if (liveKind === 'youtube' && liveWin && !liveWin.isDestroyed()) {
        if (s.shuffle !== last.shuffle) liveWin.webContents.executeJavaScript(`window.ytShuffle(${!!s.shuffle})`).catch(() => {});
        if (last.next !== undefined && s.next !== last.next) liveWin.webContents.executeJavaScript(`window.ytCmd('nextVideo')`).catch(() => {});
      }
      if (liveKind === 'scene' && !paused && s.stats && s.stats.t !== last.statsT && liveWin && !liveWin.isDestroyed()) liveWin.webContents.executeJavaScript('window.__stats=' + JSON.stringify(s.stats)).catch(() => {});
      if (s.nv !== last.nv && liveWin && !liveWin.isDestroyed()) liveWin.webContents.executeJavaScript('window.__notifs=' + JSON.stringify(s.notifs || [])).catch(() => {}); // notifications for the corner popup / Notification Wall
      const cs = JSON.stringify(s.call || null); if (cs !== last.call && liveWin && !liveWin.isDestroyed()) liveWin.webContents.executeJavaScript('window.__call=' + cs).catch(() => {});
      last = { thr: !!s.throttle, paused, vol, look: lk, nv: s.nv, call: cs, shuffle: s.shuffle, next: s.next, statsT: s.stats && s.stats.t };
    } catch {}
  }, 250);
}

// YouTube refuses to play outside a real web page, so serve a tiny local page that embeds it in an iframe
let ytPort;
function ytServer() {
  if (ytPort) return Promise.resolve(ytPort);
  // q = target height: YouTube picks its stream quality from the player's size, so we render a smaller player and scale it up
  const html = `<!doctype html><html><body style="margin:0;background:#000;overflow:hidden"><iframe id="f" allow="autoplay; encrypted-media"></iframe><script>
const p=new URLSearchParams(location.search),v=p.get('v'),q=+p.get('q')||0,rr=+p.get('r')||0;
const z=Math.max(1,Math.min(1.6,+p.get('z')||1)); // z > 1 zooms in so YouTube's title, logo and buttons fall outside the screen
// The size is worked out from the window as it is NOW and again whenever it changes: the window opens at one size and is then moved and resized onto its monitor.
// YouTube picks its picture quality from the player's size, so a bigger player is asked for when the zoom enlarges the picture (the zoom would otherwise look soft).
const lay=()=>{const sw=innerWidth,sh=innerHeight,want=sh*z,h0=(q&&q<sh)?q:(rr?rr:(want>1080?(want<=1440?1440:2160):sh)),w0=Math.round(h0*sw/sh);
 Object.assign(f.style,{position:'fixed',border:'0',pointerEvents:'none',width:w0+'px',height:h0+'px',left:((sw-w0)/2)+'px',top:((sh-h0)/2)+'px',transform:'scale('+(z*sh/h0)+')',transformOrigin:'50% 50%'})};
f.style.transition='opacity .2s';f.style.opacity=0;lay();addEventListener('resize',lay); // (hidden until the video is really playing)
const l=p.get('l');
const base='autoplay=1&mute=1&controls=0&disablekb=1&modestbranding=1&rel=0&iv_load_policy=3&playsinline=1&cc_load_policy=0&enablejsapi=1&origin='+encodeURIComponent(location.origin);
f.src=l?'https://www.youtube.com/embed/'+(v||'videoseries')+'?list='+encodeURIComponent(l)+'&loop=1&'+base:'https://www.youtube.com/embed/'+v+'?'+(p.get('a')?'':'loop=1&playlist='+v+'&')+base;
const cmd=(fn,a)=>f.contentWindow.postMessage(JSON.stringify({event:'command',func:fn,args:a||[]}),'*');
window.ytCmd=(c,a)=>cmd(c,a);let shown=0,lastSeek=0;const show=()=>{if(shown)return;shown=1;window.__shownAt=Date.now();f.style.opacity=1};
// Pausing puts a still picture of the video on top and hides the player; resuming shows the player straight away UNDER the picture and then fades the picture out,
// so the screen never dips to black (the old version faded the player in over an empty black page).
window.ytFreeze=u=>{let i=document.getElementById('fz');if(!i){i=document.createElement('img');i.id='fz';i.style.cssText='position:fixed;inset:0;width:100%;height:100%;z-index:9;display:none';document.body.appendChild(i)}
 const n=window.__fz=(window.__fz||0)+1;i.style.transition='none';i.style.opacity=1;i.onload=null;i.src=u;
 (i.decode?i.decode():Promise.resolve()).catch(()=>{}).then(()=>{if(window.__fz!==n)return;i.style.display='block'})};
window.ytThaw=()=>{const i=document.getElementById('fz');if(!i)return;const n=window.__fz=(window.__fz||0)+1;i.style.transition='opacity .4s ease-out';i.style.opacity=0;setTimeout(()=>{if(window.__fz===n)i.style.display='none'},450)};
window.ytHide=()=>{f.style.transition='none';f.style.opacity=0};
window.ytReveal=()=>{f.style.transition='none';f.style.opacity=1};
window.ytResume=()=>{window.__resuming=1;cmd('playVideo');setTimeout(()=>{if(window.__resuming){window.__resuming=0;window.ytThaw();window.ytReveal()}},2200)};
window.ytShuffle=b=>{window.__sh=b;cmd('setShuffle',[!!b]);cmd('setLoop',[true])};
addEventListener('message',e=>{try{const d=JSON.parse(e.data);if(d.info&&typeof d.info==='object'){if(d.info.playbackQuality)window.__pq=d.info.playbackQuality;if(d.info.availableQualityLevels)window.__aq=d.info.availableQualityLevels.join(',')}if(p.get('a')&&(d.event==='onStateChange'||(d.event==='infoDelivery'&&d.info&&d.info.playerState!==undefined)))console.log('YTSTATE '+(d.event==='onStateChange'?d.info:d.info.playerState));const st=d.event==='onStateChange'?d.info:(d.info&&d.info.playerState);if(st===1){show();if(window.__resuming){window.__resuming=0;setTimeout(()=>{window.ytReveal();window.ytThaw()},250)}}if(!l&&(st===0)&&Date.now()-lastSeek>2500){lastSeek=Date.now();cmd('seekTo',[0,true]);cmd('playVideo')}if(d.event==='onError'){console.log('YTERROR '+d.info);if(l)setTimeout(()=>cmd('nextVideo'),2000)}}catch{}});
window.ytVol=n=>{window.__vol=n;if(n>0){cmd('unMute');cmd('setVolume',[n])}else cmd('mute')};
f.onload=()=>{setTimeout(show,5000);f.contentWindow.postMessage(JSON.stringify({event:'listening',id:1}),'*');[1500,4000,8000,15000].forEach(t=>setTimeout(()=>cmd('unloadModule',['captions']),t));[2500,6000,10000].forEach(t=>setTimeout(()=>{if(window.__vol!==undefined)window.ytVol(window.__vol);if(window.__sh!==undefined)window.ytShuffle(window.__sh)},t))};
</script></body></html>`;
  return new Promise(res => {
    const s = require('http').createServer((_q, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(html); });
    s.listen(0, '127.0.0.1', () => res(ytPort = s.address().port));
  });
}

// YouTube draws its own buttons over the video (previous / pause / next in the middle, a title, a spinner, end-of-video suggestions) each time it starts or resumes.
// The app can reach inside the YouTube frame, so it hides all of them.
const YT_CSS = 'player-middle-controls,player-top-controls,player-bottom-controls,.player-controls-middle,.player-controls-background,.player-controls-top,.player-controls-bottom,.player-controls-middle-core-buttons,.ytp-chrome-top,.ytp-chrome-bottom,.ytp-gradient-top,.ytp-gradient-bottom,.ytp-pause-overlay,.ytp-pause-overlay-container,.ytp-large-play-button,.ytp-spinner,.ytp-endscreen-content,.ytp-ce-element,.ytp-watermark,.ytp-title,.ytp-youtube-button,.ytp-cued-thumbnail-overlay,.ytp-error,.ytp-bezel,.ytp-bezel-text-wrapper{display:none!important;opacity:0!important;visibility:hidden!important;pointer-events:none!important}';
// Looping a single video: the app reaches the real <video> inside the YouTube frame and rewinds it itself a moment before the end, frame-accurately.
// (The old way waited for YouTube's messages, which arrive too late - YouTube had already reloaded the video, which showed up as a jump.) Playlists are left alone.
const YT_LOOP_JS = "(()=>{if(window.__whl||/[?&]list=/.test(location.href))return;const v=document.querySelector('video');if(!v)return;window.__whl=1;v.loop=true;const chk=()=>{try{if(v.duration>3&&v.currentTime>=v.duration-0.12&&!v.seeking)v.currentTime=0}catch(e){}};v.addEventListener('timeupdate',chk);v.addEventListener('ended',()=>{v.currentTime=0;v.play()});if(v.requestVideoFrameCallback){const f=()=>{chk();v.requestVideoFrameCallback(f)};v.requestVideoFrameCallback(f)}})()";
function ytInject() { try { if (!liveWin || liveWin.isDestroyed()) return; for (const fr of liveWin.webContents.mainFrame.framesInSubtree) if (/youtube\.com\/embed/.test(fr.url)) { fr.executeJavaScript("(()=>{if(!document.getElementById('whx')){const s=document.createElement('style');s.id='whx';s.textContent=" + JSON.stringify(YT_CSS) + ";document.documentElement.appendChild(s)}})()").catch(() => {}); fr.executeJavaScript(YT_LOOP_JS).catch(() => {}); } } catch {} }
setInterval(() => { if (liveKind === 'youtube') ytInject(); }, 700);
let ytLast = null; // the most recent good picture of the YouTube wallpaper
let ytKey = null; // also saved to disk (per video and screen width), so the next start - even offline - begins with a picture, not black
function frameUrl(img) { try { const bm = img.toBitmap(); let sum = 0, n = 0; for (let i = 0; i + 3 < bm.length; i += 4 * 997) { sum += bm[i] + bm[i + 1] + bm[i + 2]; n += 3; } return n && sum / n >= 4 ? 'data:image/jpeg;base64,' + img.toJPEG(85).toString('base64') : null; } catch { return null; } }
setInterval(() => { try { if (liveKind === 'youtube' && !livePausedNow && liveWin && !liveWin.isDestroyed()) liveWin.webContents.capturePage().then((img) => { const u = frameUrl(img); if (u) { ytLast = u; if (ytKey) fs.writeFile(path.join(app.getPath('userData'), 'yt-last-' + ytKey + '.jpg'), img.toJPEG(80), () => {}); } }).catch(() => {}); } catch {} }, 15000);
setInterval(() => { try { if (liveKind === 'youtube' && liveWin && !liveWin.isDestroyed()) liveWin.webContents.executeJavaScript('JSON.stringify({aq:window.__aq||"",pq:window.__pq||"",ih:innerHeight})').then((r) => { const j = JSON.parse(r); if (!j.aq) return; const f = path.join(app.getPath('appData'), 'wallpaper-hub', 'ytinfo-' + myKey + '.json'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ vid: payload.vid || '', aq: j.aq, pq: j.pq, ih: j.ih, z: payload.z || 1, t: Date.now() })); }).catch(() => {}); } catch {} }, 20000); // what YouTube offers for this video, for Auto-tune
function setLivePausedLocal(p) { // live process
  livePausedNow = !!p; // the 30 Hz cursor feed checks this, so a paused wallpaper really costs nothing
  if (!liveWin || liveWin.isDestroyed()) return;
  if (liveKind === 'youtube') {
    if (!p) { liveWin.webContents.executeJavaScript('window.ytResume()').catch(() => {}); return; }
    // pausing: a picture of the video goes on top (the player stays under it, hiding it made Windows draw black) before it pauses, so YouTube's own paused screen (big play button) is never visible
    const go = (u) => { try { return liveWin.webContents.executeJavaScript((u ? 'window.ytFreeze(' + JSON.stringify(u) + ');' : '') + "window.ytCmd('pauseVideo')").catch(() => {}); } catch {} };
    liveWin.webContents.capturePage().then((img) => { if (livePausedNow && liveWin && !liveWin.isDestroyed()) go(frameUrl(img) || ytLast); }).catch(() => go(ytLast));
    return;
  }
  const js = liveKind === 'youtube' ? `window.ytCmd('${p ? 'pauseVideo' : 'playVideo'}')`
    : liveKind === 'web' ? (p ? `(()=>{window.__whPause=true;document.querySelectorAll('video,audio').forEach(m=>{if(!m.paused){m.dataset.whp=1;m.pause()}})})()` : `(()=>{document.querySelectorAll('video,audio').forEach(m=>{if(m.dataset.whp){delete m.dataset.whp;m.play().catch(()=>{})}});if(window.__whResume)window.__whResume()})()`)
    : `window.setPaused(${p})`;
  liveWin.webContents.executeJavaScript(js).catch(() => {});
}

function setLiveVolumeLocal(v) { // live process
  if (!liveWin || liveWin.isDestroyed()) return;
  if (liveKind === 'web') { liveWin.webContents.setAudioMuted(!(+v > 0)); return; }
  liveWin.webContents.executeJavaScript(liveKind === 'youtube' ? `window.ytVol(${+v})` : `window.setVolume(${+v})`).catch(() => {});
}

// main process: pause/volume go to the live process through a small state file
function writeLiveState() {
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'live-state.txt'), JSON.stringify(liveState)); } catch {}
}
function setLivePaused(p) { liveState.paused = !!p; writeLiveState(); }
function syncBattery() { // live wallpapers rest while the laptop runs on battery (only if the option is on)
  let on = false; try { on = !!loadCfg().pauseOnBattery && powerMonitor.isOnBatteryPower(); } catch {}
  if (!!liveState.battery !== on) { liveState.battery = on; writeLiveState(); }
}
function setLiveVolume(v) { liveState.volume = Math.max(0, Math.min(100, Math.round(+v || 0))); writeLiveState(); }

function ytId(s) {
  const m = String(s).trim().match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/) || (/^[\w-]{11}$/.test(String(s).trim()) && [0, String(s).trim()]);
  return m && m[1];
}

// "Stop completely": while a fullscreen app has a screen, that screen's wallpaper process is ended (frees memory and video memory), then started again
function fsStopCheck() {
  const c = loadCfg(), keys = liveState.pausedKeys || [];
  const want = new Set([...(c.fsMode === 'stop' && c.pauseOnFullscreen !== false ? keys : []), ...(liveState.appStop ? monitors().map((m) => m.key) : [])]);
  for (const k of want) { const e = liveProcs.get(k); if (e && !fsStopped.has(k)) { fsStopped.set(k, e.item); try { e.proc.kill(); } catch {} liveProcs.delete(k); statsWant('live-' + k, false); } }
  for (const [k, item] of [...fsStopped]) if (!want.has(k)) { fsStopped.delete(k); startLive(item, k, { persist: false, fade: true }).catch((err) => console.log('restart after fullscreen failed:', err.message)); }
}
// Popular games the wallpaper steps aside for (the process names Windows shows). The user's own list in Settings is added to these.
const POPULAR_GAMES = ['fortniteclient-win64-shipping', 'valorant-win64-shipping', 'cs2', 'csgo', 'r5apex', 'r5apex_dx12', 'cod', 'overwatch', 'rocketleague', 'gta5', 'gta5_enhanced', 'eldenring', 'league of legends', 'dota2', 'rainbowsix', 'rainbowsix_vulkan', 'robloxplayerbeta', 'minecraft.windows', 'cyberpunk2077', 'destiny2', 'tslgame', 'marvel-win64-shipping', 'helldivers2', 'bg3', 'bg3_dx11', 'rustclient', 'escapefromtarkov', 'genshinimpact', 'palworld-win64-shipping', 'apexlegends', 'thefinals', 'deadlock', 'wowclassic', 'wow', 'hogwartslegacy', 'fc25', 'fc24', 'nba2k25', 'halo-win64-shipping', 'steelrising', 'starfield', 'witcher3', 'reddeadredemption2', 'rdr2', 'forzahorizon5', 'sotc', 'monsterhunterwilds', 'sekiro', 'darksoulsiii', 'payday3-win64-shipping', 'pubg', 'warframe.x64', 'smite', 'lostark'];
let gameManual = false, gameDetected = [];
// QUIET WHILE GAMING: while this is true Wallpaper Hub starts no downloads of its own (no next playlist wallpaper, no automatic wallpaper change,
// no background search or picture fingerprints), so it never competes with a game for the network or the PC
const gameNetQuiet = () => gameManual || gameDetected.length > 0 || !!liveState.appStop || !!liveState.appPause;
const gameStatus = () => ({ manual: gameManual, detected: gameDetected.slice(0, 3), live: anyLive(), quiet: gameNetQuiet() });
function gameBroadcast() { try { if (win && !win.isDestroyed()) win.webContents.send('game-mode', gameStatus()); } catch {} }
function setGameManual(v, quiet) { // Game mode by hand (Ctrl+Shift+G or the button): the live wallpaper is stopped completely, and comes back when it is turned off
  gameManual = !!v; liveState.appStop = gameManual || hitsStop; writeLiveState(); fsStopCheck(); gameBroadcast();
  if (!gameManual) setTimeout(appPauseTick, 400);
  if (!quiet) { try { new Notification({ title: 'Game mode ' + (gameManual ? 'ON' : 'off'), body: gameManual ? 'The live wallpaper is stopped so your game gets the whole PC. Ctrl+Shift+G turns it back on.' : 'The live wallpaper is back.', silent: true }).show(); } catch {} }
}
let hitsStop = false;
// "Pause while these programs are running" (like Wallpaper Engine's application rules): checks the running programs every few seconds
let appPauseBusy = false;
function appPauseTick() {
  const c = loadCfg(), norm = (n) => String(n).toLowerCase().replace(/\.exe$/, '').trim(), mine = (c.pauseAppsOn && Array.isArray(c.pauseApps) ? c.pauseApps : []).map(norm).filter(Boolean);
  const list = [...new Set([...mine, ...(c.popularGames !== false ? POPULAR_GAMES : [])])];
  const idle = () => { hitsStop = false; if (liveState.appPause || liveState.appMute || !!liveState.appStop !== gameManual) { liveState.appPause = liveState.appMute = false; liveState.appStop = gameManual; writeLiveState(); fsStopCheck(); } if (gameDetected.length) { gameDetected = []; gameBroadcast(); } };
  if (!list.length) { idle(); return; }
  if (appPauseBusy) return; appPauseBusy = true;
  execFile('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (e, out) => {
    appPauseBusy = false; if (e) return;
    const names = new Set(String(out).split(/\r?\n/).map((l) => (l.match(/^"([^"]+)"/) || [])[1]).filter(Boolean).map((n) => n.toLowerCase().replace(/\.exe$/, '')));
    const acts = c.pauseAppAct || {}, hits = list.filter((n) => names.has(n)).map((n) => acts[n] || 'pause');
    const found = list.filter((n) => names.has(n)); if (found.join() !== gameDetected.join()) { gameDetected = found; gameBroadcast(); }
    hitsStop = hits.includes('stop');
    const stop = hitsStop || gameManual, pz = !stop && hits.includes('pause'), mu = !stop && !pz && hits.includes('mute');
    if (stop !== !!liveState.appStop || pz !== !!liveState.appPause || mu !== !!liveState.appMute) { liveState.appStop = stop; liveState.appPause = pz; liveState.appMute = mu; writeLiveState(); fsStopCheck(); }
  });
}
function setLocked(v) { const on = !!v && !!loadCfg().pauseLocked; if (!!liveState.locked !== on) { liveState.locked = on; writeLiveState(); } }
function watcherSync() { // keeps the fullscreen / maximized-window watcher in line with the setting, even if the setting file changed behind our back
  const want = !!loadCfg().pauseOnFullscreen && (anyLive() || fsStopped.size > 0);
  if (want && !watcher) startWatcher();
  else if (!want && watcher) { watcher.kill(); watcher = null; if ((liveState.pausedKeys || []).length) { liveState.pausedKeys = []; writeLiveState(); } fsStopCheck(); }
}
function startWatcher() {
  if (watcher) watcher.kill();
  const p = runPs(WATCH_PS, { WH_MAX: loadCfg().pauseMaximized === false ? '0' : '1' });
  watcher = spawn('powershell.exe', p.args, { env: p.env, windowsHide: true });
  setTimeout(() => fs.unlink(p.file, () => {}), 5000);
  watcher.stdout.on('data', (b) => { // 'full X Y' = a fullscreen app on the screen at X,Y
    const line = b.toString().trim().split(/\r?\n/).pop().trim();
    const m = line.match(/^full (-?\d+) (-?\d+)/);
    const all = monitors();
    const mon = m ? all.find((x) => x.x === +m[1] && x.y === +m[2]) : null;
    // A game wants the whole graphics card, not just the screen it is on, so by default EVERY screen's live
    // wallpaper stops while a fullscreen app is focused anywhere. pauseAllScreens:false pauses only its own screen.
    // Pausing when the rect matched no monitor is deliberate: that case used to leave every wallpaper running.
    const gt = !!loadCfg().gameThrottle && all.length > 1 && !!mon;
    const ks = !m ? [] : ((loadCfg().pauseAllScreens === false || gt) && mon) ? [mon.key] : all.map((x) => x.key);
    liveState.throttle = gt;
    gameGuard(!!m); // while a game or fullscreen app is in front, no always-on-top window of ours stays over it (a see-through overlay can force Windows to composite the game, which can change how bright it looks, especially with HDR)
    if (loadCfg().fsMode === 'mute') { liveState.pausedKeys = []; liveState.mutedKeys = ks; } else { liveState.pausedKeys = ks; liveState.mutedKeys = []; } // "mute": it keeps playing, only the sound goes
    writeLiveState(); fsStopCheck();
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
function gameGuard(on) { try { if (overlayWin && !overlayWin.isDestroyed()) { if (on) overlayWin.hide(); else if (!overlayWin.isVisible()) overlayWin.showInactive(); } } catch {} }
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
      try { const n = new Notification({ title: 'Wallpaper Hub update', body: 'Version ' + latest + ' is available on GitHub. Open the app to see what is new.' }); n.on('click', () => { makeMainWindow(true); }); n.show(); } catch {}
      saveCfg({ ...c, updateSeen: latest });
    }
    if (win && !win.isDestroyed()) win.webContents.send('update-info', updateInfo);
    return updateInfo;
  } catch (e) { return { error: String(e.message).slice(0, 120), current: appVer() }; }
}
ipcMain.handle('update:check', () => checkUpdate(true));
ipcMain.handle('update:get', () => updateInfo || { current: appVer() });
// websites the "Find more wallpapers" buttons may open in your browser (you download the files yourself)
const FIND_SITES = ['https://www.desktophut.com/', 'https://motionbgs.com/', 'https://www.moewalls.com/', 'https://livewallpapers4free.com/', 'https://www.youtube.com/results?search_query=4k+live+wallpaper'];
ipcMain.handle('open:source', (_e, url) => { try { const x = new URL(String(url)); if (/^https?:$/.test(x.protocol)) shell.openExternal(x.href); } catch {} return true; }); // opens the page a picture came from
ipcMain.handle('update:open', (_e, url) => { // only ever opens this app's own GitHub page
  const u = String(url || ''); if (u.startsWith('https://github.com/' + REPO + '/') || u === 'https://mkrabbit11.github.io/wallpaper-hub/guide/' || FIND_SITES.includes(u)) shell.openExternal(u); return true;
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

ipcMain.handle('web:exact', () => ({ all: BING_PAGED + BING_SLICES.length, safe: BING_PAGED + 1 })); // how many pages of a Whole web search are the exact search (the rest are related searches)
const webCache = new Map(); let stockDropped = 0;
ipcMain.handle('search', async (_e, src, opts) => {
  { const bg = opts && (opts.variant || opts.extra != null || (+opts.page || 1) > 1 || ['deviantart', 'openverse'].includes(src)); // (a search you start yourself still runs; the background filling waits)
    while (bg && gameNetQuiet()) await new Promise((r) => setTimeout(r, 2000)); }
  let ck = null; if (src === 'web' && opts && opts.query) { ck = JSON.stringify([opts.stock === true ? 'S' : '', opts.query, opts.page, opts.content, opts.types, opts.wider === true, opts.atleast || '', opts.match || 'all', opts.extra == null ? 'p' : 'x' + opts.extra, opts.variant ? JSON.stringify(opts.variant) + '#' + opts.vpage : '', opts.color || '']); const hit = webCache.get(ck); if (hit && Date.now() - hit.t < 900000) return hit.v; }
  const list = await sources[src](opts);
  if (src === 'web' && opts && opts.stock !== true) { const before = list.length; for (let i = list.length - 1; i >= 0; i--) if (isStock(list[i])) list.splice(i, 1); stockDropped += before - list.length; }
  if (ck && list.length) { webCache.set(ck, { t: Date.now(), v: list }); if (webCache.size > 400) webCache.delete(webCache.keys().next().value); }
  // Wallhaven has little for this search: top up from the wider web
  if (src === 'wallhaven' && opts.query && list.length < 8 && !/^similar:/i.test(opts.query)) {
    const web = await sources.web(opts).catch(() => []);
    return list.concat(web);
  }
  return list;
});
// what people search for that starts like this (Bing's public suggestion list), for the drop-down under the search box and for 'did you mean'
const sugCache = new Map();
ipcMain.handle('search:suggest', async (_e, q) => { q = String(q || '').trim().slice(0, 100); if (q.length < 2) return []; const k = q.toLowerCase(); if (sugCache.has(k)) return sugCache.get(k);
  try { const r = await fetch('https://api.bing.com/qsonhs.aspx?type=json&q=' + encodeURIComponent(q), { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' }, signal: AbortSignal.timeout(5000) }); const j = await r.json(), out = [];
    for (const x of (j && j.AS && j.AS.Results) || []) for (const g of x.Suggests || []) if (g && typeof g.Txt === 'string' && !out.includes(g.Txt)) out.push(g.Txt);
    const v = out.slice(0, 8); sugCache.set(k, v); if (sugCache.size > 300) sugCache.delete(sugCache.keys().next().value); return v; } catch { return []; } });
ipcMain.handle('apply', (_e, item, target) => applyItem(item, target || 'all'));
ipcMain.handle('random', () => randomApply());
ipcMain.handle('screens:list', () => monitors().map(({ key, n, w, h, primary }) => ({ key, n, w, h, primary })));
ipcMain.handle('screens:identify', () => { // flash each screen's number for a couple of seconds
  for (const m of monitors()) {
    const d = screen.getAllDisplays().find((x) => x.id === m.did); if (!d) continue;
    const w = new BrowserWindow({ x: d.bounds.x + Math.round(d.bounds.width / 2) - 150, y: d.bounds.y + Math.round(d.bounds.height / 2) - 150, width: 300, height: 300,
      frame: false, transparent: true, alwaysOnTop: true, focusable: false, skipTaskbar: true, hasShadow: false, show: false });
    w.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;box-sizing:border-box;font:bold 190px sans-serif;color:#fff;background:rgba(20,24,40,.9);border:8px solid #6c8cff;border-radius:44px">${m.n}</body>`));
    w.once('ready-to-show', () => w.showInactive());
    setTimeout(() => { if (!w.isDestroyed()) w.destroy(); }, 2500);
  }
});
// ---- Notifications: shows the notifications your apps send (Discord and more) on the wallpaper, with a sound per app or per person ----
// Windows keeps the notifications that are waiting in its notification list in a small local database. This reads that list (nothing leaves your PC).
const WPN_PS = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class Sq {
  [DllImport("winsqlite3.dll", EntryPoint="sqlite3_open_v2")] static extern int open_v2(byte[] file, out IntPtr db, int flags, IntPtr vfs);
  [DllImport("winsqlite3.dll", EntryPoint="sqlite3_busy_timeout")] static extern int busy(IntPtr db, int ms);
  [DllImport("winsqlite3.dll", EntryPoint="sqlite3_prepare_v2")] static extern int prepare(IntPtr db, byte[] sql, int n, out IntPtr st, IntPtr tail);
  [DllImport("winsqlite3.dll", EntryPoint="sqlite3_step")] static extern int step(IntPtr st);
  [DllImport("winsqlite3.dll", EntryPoint="sqlite3_column_count")] static extern int ccount(IntPtr st);
  [DllImport("winsqlite3.dll", EntryPoint="sqlite3_column_blob")] static extern IntPtr cblob(IntPtr st, int i);
  [DllImport("winsqlite3.dll", EntryPoint="sqlite3_column_bytes")] static extern int cbytes(IntPtr st, int i);
  [DllImport("winsqlite3.dll", EntryPoint="sqlite3_finalize")] static extern int fin(IntPtr st);
  [DllImport("winsqlite3.dll", EntryPoint="sqlite3_close")] static extern int close(IntPtr db);
  [DllImport("winsqlite3.dll", EntryPoint="sqlite3_errmsg")] static extern IntPtr errmsg(IntPtr db);
  static byte[] U(string s) { return Encoding.UTF8.GetBytes(s + "\\0"); }
  static string Dec(IntPtr p, int n) {
    if (p == IntPtr.Zero || n <= 0) return "";
    byte[] b = new byte[n]; Marshal.Copy(p, b, 0, n);
    if (n > 3 && b[1] == 0 && b[3] == 0) return Encoding.Unicode.GetString(b);
    if (n > 2 && b[0] == 0xFF && b[1] == 0xFE) return Encoding.Unicode.GetString(b, 2, n - 2);
    return Encoding.UTF8.GetString(b);
  }
  public static List<string[]> Query(string file, string sql) {
    IntPtr db; int rc = open_v2(U(file), out db, 1, IntPtr.Zero);
    if (rc != 0) throw new Exception("could not open the notification list (" + rc + ")");
    try {
      busy(db, 800); IntPtr st; rc = prepare(db, U(sql), -1, out st, IntPtr.Zero);
      if (rc != 0) throw new Exception("query failed: " + Marshal.PtrToStringAnsi(errmsg(db)));
      var rows = new List<string[]>(); int n = ccount(st);
      while (step(st) == 100) { var r = new string[n]; for (int i = 0; i < n; i++) r[i] = Dec(cblob(st, i), cbytes(st, i)); rows.Add(r); }
      fin(st); return rows;
    } finally { close(db); }
  }
}
'@
$db = if ($env:WH_WPN_DB) { $env:WH_WPN_DB } else { Join-Path $env:LOCALAPPDATA 'Microsoft\\Windows\\Notifications\\wpndatabase.db' }
$parent = [int]$env:WP_PARENT; $last = 0; $lastErr = ''; $lastCall = $null; $tick = 0
$micRoot = if ($env:WH_MIC_ROOT) { $env:WH_MIC_ROOT } else { 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged' }
try { $last = [long]([Sq]::Query($db, 'select ifnull(max(Id),0) from Notification')[0][0]) } catch { Write-Output ('NERR ' + $_.Exception.Message) }
Write-Output 'NREADY'
while ($true) {
  if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { break }
  try {
    $rows = [Sq]::Query($db, "select n.Id, h.PrimaryId, n.Payload from Notification n join NotificationHandler h on h.RecordId = n.HandlerId where n.Type = 'toast' and n.Id > $last order by n.Id")
    foreach ($row in $rows) {
      $last = [long]$row[0]
      $t = @([regex]::Matches($row[2], '<text[^>]*>(.*?)</text>', 'Singleline') | ForEach-Object { [System.Net.WebUtility]::HtmlDecode($_.Groups[1].Value).Trim() } | Where-Object { $_ -ne '' })
      $o = @{ id = $last; app = $row[1]; title = [string]($t | Select-Object -First 1); body = (($t | Select-Object -Skip 1) -join [char]10); at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
      Write-Output ('NOTIF ' + ($o | ConvertTo-Json -Compress))
    }
    $lastErr = ''
  } catch { if ($_.Exception.Message -ne $lastErr) { $lastErr = $_.Exception.Message; Write-Output ('NERR ' + $lastErr) } }
  if ($env:WH_CALLS -eq '1') {
    $inCall = $false
    try { Get-ChildItem $micRoot | Where-Object { $_.PSChildName -match 'discord' } | ForEach-Object { $p = Get-ItemProperty $_.PSPath; $exe = $_.PSChildName -replace '#', '\\'; if ($p.LastUsedTimeStart -gt 0 -and $p.LastUsedTimeStop -eq 0 -and ($env:WH_MIC_ROOT -or (Test-Path -LiteralPath $exe))) { $inCall = $true } } } catch {} # (old Discord versions can leave a stuck "in use" record, so only the installed version counts)
    if ($inCall -ne $lastCall) { $lastCall = $inCall; Write-Output ('NCALL ' + [int]$inCall) }
  }
  Start-Sleep -Milliseconds 1000
}
`;
const NOTIF_SOUNDS = ['chime', 'ping', 'pop', 'bell', 'drop', 'alert', 'marimba', 'sparkle', 'dingdong', 'blip', 'ring'];
const callDefaults = () => ({ on: false, pause: true, popup: true, sound: 'ring' });
const notifDefaults = () => ({ on: false, corner: true, pos: 'top-right', secs: 8, volume: 70, defaultSound: 'chime', apps: {}, people: {}, seen: {}, calls: callDefaults() });
const getNotif = () => { const n = { ...notifDefaults(), ...(loadCfg().notif || {}) }; n.calls = { ...callDefaults(), ...(n.calls || {}) }; return n; };
const friendlyApp = (id) => { // "com.squirrel.Discord.Discord" -> "Discord", "Microsoft.OutlookForWindows_8wekyb3d8bbwe!App" -> "Outlook For Windows"
  const raw = String(id || ''), bang = raw.indexOf('!'); let pkg = (bang > 0 ? raw.slice(0, bang) : raw).replace(/_[a-z0-9]{13}$/i, ''); if (/[\/]/.test(pkg)) pkg = pkg.split(/[\/]/).filter(Boolean).pop().replace(/.exe$/i, ''); // "{GUID}/Some App/Some App" -> "Some App"
  if (/discord/i.test(pkg)) return 'Discord'; if (/roblox/i.test(pkg)) return 'Roblox'; if (/medal/i.test(pkg)) return 'Medal';
  const parts = pkg.split('.').filter(Boolean); let n = parts[parts.length - 1] || pkg; if (/^(app|desktop|player|exe|main)$/i.test(n) && parts.length > 1) n = parts[parts.length - 2];
  return n.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim() || raw;
};
const personOf = (title) => String(title || '').split(/\s+\(|\s+[-–—]\s+|\s+>\s+|:\s/)[0].trim().slice(0, 60); // "Alice (#general, My Server)" -> "Alice"
let wpnProc = null, wpnInfo = { running: false, error: '' }, notifSoundWin = null, lastDiscordNotif = null, callPausedMusic = false;
function onDiscordCall(active) { // Discord started or stopped using the microphone
  const c = getNotif().calls;
  liveState.call = active ? { active: true, since: Date.now(), show: !!c.popup } : { active: false };
  if (active && c.on && c.pause !== false) { if (audioPlaying) { audioPauseResume(false); callPausedMusic = true; } liveState.callHold = true; }
  if (!active) { if (callPausedMusic) { audioPauseResume(true); callPausedMusic = false; } liveState.callHold = false; }
  writeLiveState(); if (win && !win.isDestroyed()) win.webContents.send('call-state', active);
}
function playNotifSound(sound, vol) {
  if (!sound || sound === 'none') return;
  if (!notifSoundWin || notifSoundWin.isDestroyed()) { notifSoundWin = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'notif-sound-preload.js'), backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } }); notifSoundWin.loadFile('notif-sound.html'); }
  const arg = sound.startsWith('file:') ? { file: sound.slice(5) } : { name: sound }, send = () => notifSoundWin.webContents.send('play', arg, vol);
  if (notifSoundWin.webContents.isLoading()) notifSoundWin.webContents.once('did-finish-load', send); else send();
}
function notifDispatch(ev, force) { // decide whether this notification is wanted, play its sound, and hand it to the wallpaper
  const n = getNotif(), key = String(ev.app || '').toLowerCase(), app = n.apps[key], person = personOf(ev.title), pk = person.toLowerCase(), rule = (n.people[key] || {})[pk];
  if (!force && /discord/.test(key)) lastDiscordNotif = { title: ev.title || '', person, at: Date.now() };
  if (!force && /discord/.test(key) && n.calls.on && /\b(call|calling|ringing)\b/i.test((ev.title || '') + ' ' + (ev.body || ''))) { // someone is calling you on Discord
    playNotifSound(n.calls.sound || 'ring', n.volume);
    liveState.notifs = [{ id: ev.id || Date.now(), app: 'Discord', title: ev.title || 'Incoming call', body: ev.body || '', person, at: Date.now(), hue: 140, kind: 'call' }, ...(liveState.notifs || [])].slice(0, 12); liveState.nv = (liveState.nv || 0) + 1; writeLiveState(); return;
  }
  if (!n.on && !force) return;
  if (!force) {
    if (person && key) { const seen = n.seen[key] || []; if (!seen.some((s) => s.toLowerCase() === pk)) { const c = loadCfg(); c.notif = { ...n, seen: { ...n.seen, [key]: [person, ...seen].slice(0, 40) } }; saveCfg(c); } }
    if (!app || !app.show) return;
    if (app.onlyListed && !rule) return;
    if (rule && rule.show === false) return;
  }
  const sound = (rule && rule.sound) || (app && app.sound) || n.defaultSound;
  playNotifSound(sound, n.volume);
  const name = (app && app.name) || friendlyApp(ev.app), hue = [...key].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7);
  liveState.notifs = [{ id: ev.id || Date.now(), app: name, title: ev.title || '', body: ev.body || '', person, at: ev.at || Date.now(), hue }, ...(liveState.notifs || [])].slice(0, 12); liveState.nv = (liveState.nv || 0) + 1; writeLiveState();
}
function syncNotifFeed() {
  const nf = getNotif(), on = !!nf.on || !!nf.calls.on, wantCalls = nf.calls.on ? '1' : '0';
  if (wpnProc && wpnProc.wantCalls !== wantCalls) { try { wpnProc.kill(); } catch {} wpnProc = null; } // restart so the call watching matches the setting
  if (!on) { if (liveState.callHold || (liveState.call && liveState.call.active)) onDiscordCall(false); if (wpnProc) { try { wpnProc.kill(); } catch {} wpnProc = null; } wpnInfo = { running: false, error: '' }; return; }
  if (wpnProc) return;
  const p = runPs(WPN_PS, { WP_PARENT: String(process.pid), WH_CALLS: wantCalls });
  wpnProc = spawn('powershell.exe', p.args, { env: p.env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); wpnProc.wantCalls = wantCalls; wpnInfo = { running: true, error: '' };
  let buf = '';
  wpnProc.stdout.on('data', (b) => {
    buf += b.toString(); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line.startsWith('NOTIF ')) { try { notifDispatch(JSON.parse(line.slice(6))); } catch {} }
      else if (line.startsWith('NCALL ')) onDiscordCall(line.slice(6) === '1');
      else if (line.startsWith('NERR ')) wpnInfo.error = line.slice(5);
      else if (line === 'NREADY' && !wpnInfo.error) wpnInfo.error = '';
    }
  });
  const me = wpnProc; wpnProc.on('exit', () => { if (wpnProc === me) { wpnProc = null; wpnInfo.running = false; } });
}
function notifStatus() { // for the Notifications tab
  const q = (args) => { try { return require('child_process').execFileSync('reg.exe', args, { encoding: 'utf8', windowsHide: true }); } catch { return ''; } };
  const toast = q(['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications', '/v', 'ToastEnabled']).match(/ToastEnabled\s+REG_DWORD\s+0x(\d+)/i);
  const apps = q(['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings']).split(/\r?\n/).map((l) => (l.match(/\\Notifications\\Settings\\(.+)$/) || [])[1]).filter((key) => key && !/^(Windows.|Microsoft.Windows.|MicrosoftWindows.)/i.test(key)).map((key) => ({ key: key.toLowerCase(), id: key, name: friendlyApp(key) })); // (Windows' own system messages are left out)
  const n = getNotif(); for (const key of Object.keys(n.apps)) if (!apps.some((a) => a.key === key)) apps.push({ key, id: key, name: n.apps[key].name || friendlyApp(key) });
  const dk = apps.find((a) => /discord/i.test(a.id)), dq = dk ? q(['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\' + dk.id]) : '', dlast = dq.match(/LastNotificationAddedTime\s+REG_QWORD\s+0x([0-9a-f]+)/i);
  const discord = { installed: !!dk, key: dk ? dk.key : 'com.squirrel.discord.discord', enabled: !!dk && !/\bEnabled\s+REG_DWORD\s+0x0\b/i.test(dq), lastToast: dlast ? Number(BigInt('0x' + dlast[1]) / 10000n - 11644473600000n) : 0 };
  return { discord, lastDiscord: lastDiscordNotif, inCall: !!(liveState.call && liveState.call.active), toastEnabled: toast ? toast[1] !== '0' : true, apps: apps.sort((a, b) => (/discord/i.test(b.id) ? 1 : 0) - (/discord/i.test(a.id) ? 1 : 0) || a.name.localeCompare(b.name)), running: wpnInfo.running, error: wpnInfo.error, sounds: NOTIF_SOUNDS };
}
ipcMain.handle('notif:status', () => notifStatus());
ipcMain.handle('notif:test', (_e, key, person) => { const n = getNotif(), app = key && n.apps[key]; notifDispatch({ id: Date.now(), app: key || 'wallpaperhub.test', title: person || 'Test person', body: 'This is how a notification looks on your wallpaper.' }, true); if (app) return true; return false; });
ipcMain.handle('notif:sound', (_e, sound) => { playNotifSound(sound, getNotif().volume); });
ipcMain.handle('notif:pickSound', async () => { const r = await dialog.showOpenDialog({ title: 'Pick a notification sound', properties: ['openFile'], filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac'] }] }); return r.canceled || !r.filePaths[0] ? null : 'file:' + r.filePaths[0]; });
ipcMain.handle('notif:openSettings', () => shell.openExternal('ms-settings:notifications'));
ipcMain.handle('notif:openDiscord', () => shell.openExternal('discord://'));
ipcMain.handle('game:toggle', () => { setGameManual(!gameManual, true); return gameStatus(); });
ipcMain.handle('game:status', () => gameStatus());
ipcMain.handle('game:optimize', () => { // the wallpaper-side settings that help games, in one click (never touches the monitor's refresh rate or any colors)
  const c = loadCfg(), patch = { pauseOnFullscreen: true, pauseAllScreens: true, lowPriority: true, popularGames: true, pauseOnBattery: true, pauseLocked: true };
  if (c.fsMode === 'keep' || c.fsMode === 'mute') patch.fsMode = 'pause';
  applyCfgPatch(patch); return { applied: Object.keys(patch) };
});
ipcMain.handle('live:pause', (_e, p) => { setLivePaused(p); return liveState.paused; });
ipcMain.handle('live:paused', () => liveState.paused);

let fuseBackfillBusy = false; const fuseTried = new Set();
async function backfillFuseThumbs() { // fused wallpapers saved before pictures existed get one the first time the window opens (one at a time, in the background)
  if (fuseBackfillBusy) return; fuseBackfillBusy = true;
  try {
    for (const e of (loadCfg().library || []).filter((l) => l.type === 'fuse' && !fuseTried.has(l.id) && (!l.thumb || !fs.existsSync(l.thumb)))) {
      fuseTried.add(e.id); try { const t = await fuseThumb(e); const c = loadCfg(); saveCfg({ ...c, library: c.library.map((l) => (l.id === e.id ? { ...l, thumb: t } : l)) }); } catch (err) { console.log('fuse picture failed:', err.message); }
    }
  } finally { fuseBackfillBusy = false; }
}
ipcMain.handle('getCfg', () => { const c = loadCfg(); if ((c.library || []).some((l) => l.type === 'fuse' && !fuseTried.has(l.id) && (!l.thumb || !fs.existsSync(l.thumb)))) setTimeout(() => backfillFuseThumbs().then(() => { try { if (win && !win.isDestroyed()) win.webContents.send('fuse:thumbs'); } catch {} }), 1500); return c; });
function applyCfgPatch(patch) {
  if (patch && 'looks' in patch) patch = { ...patch, looks: (Array.isArray(patch.looks) ? patch.looks : []).slice(0, 24).filter((l) => l && typeof l.theme === 'object' && l.theme).map((l) => ({ name: String(l.name || 'Look').slice(0, 30), theme: l.theme })) };
  if (patch && patch.liveTweaks) patch = { ...patch, liveTweaks: twClean(patch.liveTweaks) };
  if (patch && patch.screenTweaks && typeof patch.screenTweaks === 'object') patch = { ...patch, screenTweaks: Object.fromEntries(Object.entries(patch.screenTweaks).map(([k, v]) => [String(k).slice(0, 80), twClean(v)])) };
  if (patch && Array.isArray(patch.tweakSched)) patch = { ...patch, tweakSched: patch.tweakSched.slice(0, 4).map((s) => ({ on: !!(s && s.on), name: String((s && s.name) || '').slice(0, 30), from: /^\d{1,2}:\d{2}$/.test((s || {}).from || '') ? s.from : '20:00', to: /^\d{1,2}:\d{2}$/.test((s || {}).to || '') ? s.to : '07:00', tw: twClean((s || {}).tw) })) };
  if (patch && patch.itemTweaks && typeof patch.itemTweaks === 'object') patch = { ...patch, itemTweaks: Object.fromEntries(Object.entries(patch.itemTweaks).map(([k, v]) => [String(k).slice(0, 80), twClean(v)])) };
  const old = loadCfg(); const c = { ...old, ...patch }; saveCfg(c); schedule();
  if ('startup' in patch) app.setLoginItemSettings({ openAtLogin: !!c.startup, path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: ['--hidden'] });
  if ('liveVolume' in patch) setLiveVolume(c.liveVolume);
  if ('notif' in patch) { const o = old.notif || {}, nn = c.notif || {}; syncNotifFeed(); if ((o.on !== nn.on || o.corner !== nn.corner || o.pos !== nn.pos || o.secs !== nn.secs || JSON.stringify(o.calls || {}) !== JSON.stringify(nn.calls || {})) && anyLive()) for (const [k, e] of [...liveProcs]) startLive(e.item, k, { persist: false }).catch(() => {}); }
  if ('look' in patch) { const l = { ...(old.look || {}), ...(c.look || {}) }, cn = (v, lo, hi, d) => Math.max(lo, Math.min(hi, Number.isFinite(+v) && v !== '' && v != null ? +v : d)); c.look = { b: Math.max(50, Math.min(160, +l.b || 100)), c: Math.max(50, Math.min(170, +l.c || 100)), s: Math.max(0, Math.min(220, l.s === 0 ? 0 : +l.s || 100)), h: cn(l.h, -180, 180, 0), sep: cn(l.sep, 0, 100, 0), gray: cn(l.gray, 0, 100, 0), warm: cn(l.warm, -100, 100, 0), blur: cn(l.blur, 0, 40, 0), vig: cn(l.vig, 0, 100, 0), grain: cn(l.grain, 0, 100, 0), ta: cn(l.ta, 0, 100, 0), tint: /^#[0-9a-f]{6}$/i.test(l.tint || '') ? l.tint : '#ff8c3c', flip: !!l.flip, flipv: !!l.flipv }; saveCfg(c); liveState.look = c.look; writeLiveState(); clearTimeout(stillT); stillT = setTimeout(() => refreshStills(), 700); }
  if ('stillLook' in patch) { c.stillLook = Object.fromEntries(Object.entries(c.stillLook && typeof c.stillLook === 'object' ? c.stillLook : {}).slice(0, 12).map(([k, v]) => [String(k).slice(0, 80), lookClean(v)])); saveCfg(c); clearTimeout(stillT); stillT = setTimeout(() => refreshStills(), 700); }
  if ('picLooks' in patch) { const pl = c.picLooks && typeof c.picLooks === 'object' ? c.picLooks : {}; c.picLooks = Object.fromEntries(Object.entries(pl).slice(-400).map(([k, v]) => [String(k).slice(0, 80), Object.fromEntries(Object.entries(lookClean(v)).filter(([kk]) => ['b', 'c', 's', 'h', 'warm'].includes(kk)))])); saveCfg(c);
    const shown = Object.values(c.stillIds || {}), changed = Object.keys({ ...(old.picLooks || {}), ...c.picLooks }).filter((k) => JSON.stringify((old.picLooks || {})[k]) !== JSON.stringify(c.picLooks[k]));
    if (changed.some((k) => shown.includes(k))) { clearTimeout(stillT); stillT = setTimeout(() => refreshStills(), 300); } }
  if ('stillFit' in patch) { clearTimeout(stillT); stillT = setTimeout(() => refreshStills(), 500); }
  if ('pauseOnBattery' in patch) syncBattery();
  if (('iconFadeStrong' in patch || 'iconFadeFull' in patch) &&(c.iconFade || 'off') !== 'off') { const exe = iconFadePath(); if (exe) execFile('taskkill', ['/im', 'IconFade.exe', '/f'], { windowsHide: true }, () => execFile(exe, ['restore'], { windowsHide: true }, () => { iconFadeOwned = false; setTimeout(iconFadeSync, 300); })); } // restart it with the other hide strength
  if ('iconFade' in patch || 'iconFadePath' in patch) { setTimeout(iconFadeSync, 300); if (c.iconFade === 'off' && old.iconFade && old.iconFade !== 'off') { const exe = iconFadePath(); if (exe) execFile('taskkill', ['/im', 'IconFade.exe', '/f'], { windowsHide: true }, () => execFile(exe, ['restore'], { windowsHide: true }, () => {})); } } // turned off in the app: stop it and show the icons again
  if ('pauseLocked' in patch && !c.pauseLocked) setLocked(false);
  if ('pauseApps' in patch || 'pauseAppsOn' in patch || 'pauseAppAct' in patch) setTimeout(appPauseTick, 200);
  if ('lowPriority' in patch) { liveState.lowPrio = !!c.lowPriority; writeLiveState(); }
  if ('fsMode' in patch) setTimeout(() => { watcherSync(); if (loadCfg().pauseOnFullscreen && (anyLive() || fsStopped.size)) startWatcher(); fsStopCheck(); }, 300);
  if ('gfxAuto' in patch || 'gfx' in patch) { gfxAuto.drop = 0; gfxAuto.hi = gfxAuto.lo = 0; gfxAuto.reason = ''; setTimeout(() => gfxAutoTick(true), 600); }
  if ('gfxMeter' in patch) setTimeout(meterTick, 300);
  if ('pair' in patch) { plSync(); pair.key = ''; if (c.pair && c.pair.on && !(old.pair && old.pair.on)) setTimeout(() => pairNext(), 400); else if (c.pair && c.pair.on && JSON.stringify((old.pair || {}).map || {}) !== JSON.stringify(c.pair.map || {})) setTimeout(() => pairNext(true), 300); } // matching turned on: put up the first matched set
  if ('playlists' in patch) { // turning a list on starts its first wallpaper right away
    plSync(); const was = Object.fromEntries(Object.entries(old.playlists || {}).map(([k, p]) => [k, !!(p && p.on)]));
    for (const [k, p] of plActive()) if (!was[k]) { if (pairKeysNow().includes(k)) { if (!pair.swapKick) { pair.swapKick = setTimeout(() => { pair.swapKick = null; pairNext(true); }, 400); } } else plNext(k); } // (matched screens: show the current set again with your swap, not this list on its own screen)
  }
  if ('liveShuffle' in patch) { liveState.shuffle = !!c.liveShuffle; writeLiveState(); }
  if (('liveQuality' in patch || 'liveFit' in patch || 'liveSharp' in patch || 'liveLyrics' in patch || 'clock' in patch || 'ytClean' in patch || 'polish' in patch || 'ytRes' in patch || 'screenType' in patch || 'sceneGlow' in patch || 'gfx' in patch || 'fpsCapOn' in patch || 'fpsCap' in patch || 'cursorHz' in patch || 'renderScale' in patch || 'sceneSettings' in patch || 'hudGlobal' in patch || 'liveTweaks' in patch || 'itemTweaks' in patch || 'screenTweaks' in patch || 'tweakSched' in patch) && anyLive()) for (const [k, e] of [...liveProcs]) startLive(e.item, k, { persist: false }).catch((err) => console.log('restart failed:', err.message)); // apply now
  if (('pauseMaximized' in patch || 'pauseAllScreens' in patch || 'gameThrottle' in patch) && anyLive() && c.pauseOnFullscreen) startWatcher();
  if ('pauseOnFullscreen' in patch && anyLive()) {
    if (c.pauseOnFullscreen) startWatcher(); else { if (watcher) watcher.kill(); watcher = null; liveState.pausedKeys = []; setLivePaused(false); }
  }
  return c;
}
ipcMain.handle('setCfg', (_e, patch) => applyCfgPatch(patch));
// Auto-tune: looks at this PC (graphics card, screens, battery) and the wallpapers that are running, picks sensible settings, applies them and reports what it did and what it found
ipcMain.handle('auto:tune', async () => {
  const c0 = loadCfg(), changes = [], notes = [], patch = {};
  const gpuName = await new Promise((res) => { const exe = nvidiaSmiPath(); if (!exe) return res(''); execFile(exe, ['--query-gpu=name', '--format=csv,noheader'], { windowsHide: true, timeout: 6000 }, (e, o) => res(e ? '' : String(o).split(/\r?\n/)[0].trim())); })
    || await (async () => { try { const g = await app.getGPUInfo('complete'); const d = (g.gpuDevice || [])[0] || {}; return String((g.auxAttributes && g.auxAttributes.glRenderer) || d.deviceString || ''); } catch { return ''; } })();
  const disp = screen.getAllDisplays(), minHz = Math.min(...disp.map((d) => d.displayFrequency || 60)), maxHz = Math.max(...disp.map((d) => d.displayFrequency || 60)), mem = os.totalmem() / 1073741824;
  const strong = /RTX\s*(30[6-9]0|[45]0[5-9]0|[45]0[6-9]0|[345]0\d0)|RX\s*(6[7-9]00|7\d00|9\d00)|Radeon\s*RX\s*(6[7-9]|7\d|9\d)/i.test(gpuName), weak = /Intel|UHD|Iris|Radeon\(TM\) Graphics|Vega|GT\s*[0-9]{3}\b|GTX\s*(9|10[0-4])\d/i.test(gpuName) && !/RTX/i.test(gpuName), top = /RTX\s*(40[7-9]0|4090|50[7-9]0)|RX\s*(7[89]00|9\d00)/i.test(gpuName);
  const want = (k, v, why) => { if (JSON.stringify(c0[k]) !== JSON.stringify(v)) { patch[k] = v; changes.push(why); } };
  const gfx = weak ? 'balanced' : top ? 'high' : strong ? 'high' : 'balanced';
  want('gfx', gfx, 'Animated scenes: ' + gfx.charAt(0).toUpperCase() + gfx.slice(1) + ' detail' + (gpuName ? ' (for your ' + gpuName.replace(/NVIDIA GeForce |NVIDIA |AMD /g, '') + ')' : ''));
  want('renderScale', 100, 'Draw scenes at your screen\'s own size (bigger than that only costs power)');
  // (the frame rate is left exactly as you set it: Auto-tune never touches it, and never changes your monitor's refresh rate)
  want('pauseOnFullscreen', true, 'Wallpaper pauses while a game or fullscreen app is in front'); want('fsMode', 'pause', null); want('pauseMaximized', true, 'Wallpaper pauses while a maximized window covers it'); want('pauseAllScreens', true, 'All screens pause during a game (it needs the whole graphics card)');
  want('lowPriority', true, 'Wallpaper runs at lower priority so games get the processor first');
  want('gfxAuto', true, 'Switches to lighter graphics on battery or when the graphics card is busy');
  want('pauseOnBattery', true, 'Pauses on battery power to save charge');
  want('ytClean', true, 'YouTube wallpapers hide the title and buttons'); want('ytRes', 0, 'YouTube picture quality set to Automatic (it follows your screen size)');
  want('liveQuality', 'native', 'Videos play at their own quality');
  if (Object.keys(patch).length) applyCfgPatch(patch);
  // what the running wallpapers look like on these screens
  for (const m of monitors()) { const it = (c0.liveScreens || {})[m.key]; if (!it) continue; const lbl = disp.length > 1 ? 'Screen ' + m.key : 'Your screen';
    if (it.type === 'youtube') { let info = null; try { info = JSON.parse(fs.readFileSync(path.join(app.getPath('appData'), 'wallpaper-hub', 'ytinfo-' + m.key + '.json'), 'utf8')); } catch {}
      if (info && info.aq) { const lv = String(info.aq).split(','), H = { hd2160: 2160, hd1440: 1440, hd1080: 1080, hd720: 720, large: 480, medium: 360 }, best = Math.max(0, ...lv.map((x) => H[x] || 0)), need = Math.min(2160, m.h * (+info.z || 1));
        if (best && best < need * 0.8) notes.push(lbl + ': "' + String(it.title || 'this video').slice(0, 60) + '" only comes in ' + best + 'p, but this screen is ' + m.h + 'p tall, so it will look a little soft. A 4K video of the same kind would look sharper.');
        else notes.push(lbl + ': "' + String(it.title || 'this video').slice(0, 60) + '" is sharp enough for this screen (' + best + 'p available).'); }
      else notes.push(lbl + ': YouTube wallpaper. I will check its sharpness once it has played for a few seconds, then run Auto-tune again.'); }
    else if (it.type === 'video' || it.type === 'scene') notes.push(lbl + ': ' + (it.title || it.name || 'wallpaper') + ' is fine.'); }
  if (disp.length > 1) notes.push('You have ' + disp.length + ' screens. During a game every wallpaper pauses so the game gets the whole graphics card.');
  if (mem < 12) notes.push('This PC has ' + mem.toFixed(0) + ' GB of memory, so animated wallpapers use Balanced detail.');
  return { changes: changes.filter(Boolean), notes, gpu: gpuName, screens: disp.map((d) => d.size.width * d.scaleFactor + 'x' + d.size.height * d.scaleFactor + ' at ' + (d.displayFrequency || 60) + ' Hz') };
});
ipcMain.handle('live:start', async (_e, item, target) => {
  const r = await startLive(item, target || 'all', { fade: true });
  if (item.type === 'video' && !item.file) { // remember downloaded videos in the library
    const c = loadCfg();
    if (!c.library.some(l => l.id === item.id)) saveCfg({ ...c, library: [...c.library, { id: item.id, title: item.title || item.id, thumb: item.thumb, file: r.file }] });
  }
  return r.mode;
});
ipcMain.handle('live:next', () => { liveState.next++; writeLiveState(); return true; });
// Search YouTube (no account or key): reads the public results page. The words are sent exactly as typed, with no filters.
function ytParseResults(j) { const out = [], seen = new Set(); const add = (id, t, ch, len) => { if (!id || seen.has(id)) return; seen.add(id); out.push({ id, t, ch, len }); };
  (function w(o) { if (!o || typeof o !== 'object') return;
    if (o.videoRenderer && o.videoRenderer.videoId) { const v = o.videoRenderer; add(v.videoId, ((v.title && v.title.runs) || []).map((x) => x.text).join(''), (v.ownerText && v.ownerText.runs && v.ownerText.runs[0].text) || '', (v.lengthText && v.lengthText.simpleText) || 'LIVE'); return; }
    if (o.lockupViewModel && o.lockupViewModel.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') { const v = o.lockupViewModel, m = v.metadata && v.metadata.lockupMetadataViewModel; add(v.contentId, (m && m.title && m.title.content) || '', '', ''); return; }
    if (o.shortsLockupViewModel) { const v = o.shortsLockupViewModel, e = v.onTap && v.onTap.innertubeCommand && v.onTap.innertubeCommand.reelWatchEndpoint; add((e && e.videoId) || String(v.entityId || '').replace('shorts-shelf-item-', ''), (v.overlayMetadata && v.overlayMetadata.primaryText && v.overlayMetadata.primaryText.content) || 'Short', '', 'Short'); return; }
    for (const k in o) w(o[k]); })(j); return out; }
// Bing video search: keeps the results the app can play (YouTube videos and direct MP4 / WebM / GIF files); TikTok, Vimeo and other pages cannot be played as a wallpaper
async function bingVideos(q, page) {
  const r = await fetch('https://www.bing.com/videos/asyncv2?q=' + encodeURIComponent(q) + '&async=content&first=' + (1 + ((page || 1) - 1) * 35) + '&count=35&mmasync=1', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', Cookie: 'SRCHHPGUSR=ADLT=' + (loadCfg().contentMode === 'all' ? 'OFF' : 'STRICT') } });
  if (!r.ok) throw new Error('Bing returned ' + r.status);
  const h = await r.text(), out = [], seen = new Set(), dec = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  for (const m of h.matchAll(/vrhm="([^"]+)"/g)) {
    try {
      const j = JSON.parse(dec(m[1])), u = String(j.murl || ''), yt = ytId(u), file = /^https:\/\/.+\.(gif|mp4|webm)(\?|#|$)/i.test(u);
      if ((!yt && !file) || seen.has(yt || u)) continue; seen.add(yt || u);
      out.push({ id: yt || 'bv-' + require('crypto').createHash('md5').update(u).digest('hex').slice(0, 10), url: yt ? 'https://www.youtube.com/watch?v=' + yt : u, title: String(j.vt || '').slice(0, 120), channel: yt ? 'YouTube (via Bing)' : 'video file (via Bing)', len: j.du || '', thumb: 'https://tse1.mm.bing.net/th?id=' + encodeURIComponent(j.thid) + '&pid=Api' });
    } catch {}
  }
  return out;
}
ipcMain.handle('yt:search', async (_e, q, engine) => {
  q = String(q || '').trim().slice(0, 200); if (!q) return [];
  if (engine === 'bing') return bingVideos(q, 1);
  const r = await fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(q), { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' } });
  if (!r.ok) throw new Error('YouTube returned ' + r.status);
  const h = await r.text(), i = h.indexOf('var ytInitialData = '); if (i < 0) throw new Error('YouTube did not give a result list this time. Try again in a moment.');
  const s = i + 20, j = JSON.parse(h.slice(s, h.indexOf(';</script>', s)));
  return ytParseResults(j).map((v) => ({ id: v.id, title: v.t, channel: v.ch, len: v.len, thumb: 'https://i.ytimg.com/vi/' + v.id + '/mqdefault.jpg' }));
});
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
// Web page / HTML wallpapers. The address is saved in the library; the page runs in a locked-down window (see createLiveWindow).
function addWebEntry(url, title) {
  const host = (() => { try { const x = new URL(url); return x.protocol === 'file:' ? decodeURIComponent(x.pathname.split('/').pop()) : x.hostname.replace(/^www\./, ''); } catch { return 'web page'; } })();
  const esc = (s) => String(s).replace(/[<>&"']/g, '');
  const entry = { id: 'web-' + require('crypto').createHash('sha1').update(url).digest('hex').slice(0, 10), type: 'web', url, title: (title || host).slice(0, 80),
    thumb: 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1f2a52"/><stop offset="1" stop-color="#3b1f52"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/><text x="160" y="86" font-size="20" fill="#cfd8ff" text-anchor="middle" font-family="sans-serif">Web wallpaper</text><text x="160" y="116" font-size="15" fill="#9fb0ff" text-anchor="middle" font-family="sans-serif">${esc(host).slice(0, 34)}</text></svg>`) };
  const c = loadCfg();
  if (!c.library.some((l) => l.id === entry.id)) saveCfg({ ...c, library: [...c.library, entry] });
  return entry;
}
ipcMain.handle('live:addWeb', (_e, link) => {
  let u = String(link || '').trim(); if (!u) throw new Error('Paste a web address first');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
  if (!webUrlOk(u) || /^file:/i.test(u)) throw new Error('Only http:// or https:// addresses work here. To use a file from your PC, click "+ Add HTML file".');
  return addWebEntry(u);
});
ipcMain.handle('live:addHtml', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Pick an HTML file to use as a wallpaper', properties: ['openFile'], filters: [{ name: 'HTML page', extensions: ['html', 'htm'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const url = require('url').pathToFileURL(r.filePaths[0]).href;
  if (!webUrlOk(url)) throw new Error('That file cannot be used');
  return addWebEntry(url, path.basename(r.filePaths[0]));
});
async function fuseThumb(entry) {
  const out = path.join(liveDir(), entry.id + '.jpg');
  fs.mkdirSync(liveDir(), { recursive: true });
  const w = new BrowserWindow({ width: 640, height: 360, show: false, frame: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  try {
    w.webContents.setFrameRate(10);
    const fa = await fusePart(entry.a), fb = entry.mask && entry.mask.solo ? {} : await fusePart(entry.b);
    await w.loadFile('live.html', { query: { type: 'fuse', fa: JSON.stringify(fa), fb: JSON.stringify(fb), fm: JSON.stringify(entry.mask || {}), gfx: 'balanced' } });
    await new Promise((r) => setTimeout(r, 6500)); // let both wallpapers start playing and the effects fade in
    const img = await w.webContents.capturePage();
    fs.writeFileSync(out, img.toJPEG(82));
    return out;
  } finally { try { w.destroy(); } catch {} }
}
ipcMain.handle('live:suggestLook', async (_e, item) => lookFromSig(await itemSig(item), seedOf(item.id), inUseLooks(), lookKind(item), item.title));
ipcMain.handle('live:autoLookPreview', async (_e, item, pool, mode) => autoLook(item, pool || [], mode || 'fuse'));
ipcMain.handle('live:addFuse', async (_e, a, b, mask, title) => { // saves a fused wallpaper in "My saved wallpapers" (checks both halves can be fused first)
  const solo = !!(mask && mask.solo), pa = await fusePart(a), pb = solo ? null : await fusePart(b);
  const nm = (p, it) => String(it.title || it.name || (p.src ? path.basename(p.src) : 'wallpaper')).slice(0, 30);
  const strip = (it, p) => p.type === 'scene' ? { type: 'scene', id: it.id, name: it.name, title: it.title } : { type: 'video', id: it.id, file: p.src, title: it.title };
  const id = 'fuse-' + Date.now().toString(36);
  const entry = { id, type: 'fuse', title: String(title || '').trim().slice(0, 60) || (solo ? nm(pa, a) + ' + styles' : nm(pa, a) + ' + ' + nm(pb, b)), a: strip(a, pa), b: solo ? null : strip(b, pb), mask: mask || {}, thumb: '' };
  try { entry.thumb = await fuseThumb(entry); } catch (e) { console.log('fuse picture failed:', e.message); }
  const c = loadCfg(); saveCfg({ ...c, library: [...c.library, entry] });
  return entry;
});
// A stop you ask for really stops: a playlist (or screen matching) that is still switched on would bring a wallpaper back - at once after a restart, or when its timer fires.
function stopMeansStop(t) {
  const c = loadCfg(), pl = { ...(c.playlists || {}) }, off = []; let pair = c.pair;
  const keys = t === 'all' ? Object.keys(pl) : [t];
  for (const k of keys) if (pl[k] && pl[k].on) { pl[k] = { ...pl[k], on: false }; off.push(k); }
  if (t !== 'all' && pl.all && pl.all.on) { pl.all = { ...pl.all, on: false }; off.push('all'); } // (the shared list would put it back on this screen too)
  let pairOff = false; if (pair && pair.on && (t === 'all' || pairKeysNow().includes(t))) { pair = { ...pair, on: false }; pairOff = true; }
  if (off.length || pairOff) { saveCfg({ ...loadCfg(), playlists: pl, pair }); plSync(); }
  return { ok: true, listOff: off.length > 0, pairOff };
}
ipcMain.handle('fuse:url', async (_e, a, b, mask) => { // a live preview inside the app: the same page the wallpaper uses, lighter and silent
  const fa = await fusePart(a), fb = mask && mask.solo ? {} : await fusePart(b);
  const qs = new URLSearchParams({ type: 'fuse', fa: JSON.stringify(fa), fb: JSON.stringify(fb), fm: JSON.stringify({ ...(mask || {}), fast: true, snd: 'none' }), gfx: 'balanced', q: '540', fps: '30' });
  return require('url').pathToFileURL(path.join(__dirname, 'live.html')).href + '?' + qs;
});
ipcMain.handle('live:stop', (_e, target) => { const t = target || 'all'; stopLive(t); return stopMeansStop(t); });
ipcMain.handle('live:search', (_e, opts) => (sources[opts.source] || sources.pexelsVideo)(opts));
// Saved video wallpapers get a still picture (thumbnail), made once and kept. Showing a frame by loading each video in the app window made the
// graphics card keep a whole video decoder per card (about 108 MB each: 24 videos = 2.6 GB of VRAM). The picture is made in a hidden window,
// one video at a time, and that window is closed straight after, so the decoder is given back.
const thumbDir = () => path.join(app.getPath('userData'), 'thumbs');
let thumbChain = Promise.resolve();
async function makeLibThumb(id) {
  const c = loadCfg(), l = (c.library || []).find((x) => x.id === id); if (!l || !l.file || !fs.existsSync(l.file) || /\.gif$/i.test(l.file)) return null;
  if (l.thumb && fs.existsSync(l.thumb)) return l.thumb;
  fs.mkdirSync(thumbDir(), { recursive: true }); const page = path.join(thumbDir(), 'blank.html'); if (!fs.existsSync(page)) fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><body></body>');
  const out = path.join(thumbDir(), String(id).replace(/[^\w-]/g, '_') + '.jpg'), url = require('url').pathToFileURL(l.file).href;
  const w = new BrowserWindow({ show: false, width: 480, height: 270, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  try {
    await w.loadFile(page);
    const data = await w.webContents.executeJavaScript('new Promise((res)=>{const v=document.createElement("video");v.muted=true;v.preload="auto";let fin=false;const done=(d)=>{if(fin)return;fin=true;try{v.removeAttribute("src");v.load()}catch(e){}res(d)};v.onloadedmetadata=()=>{v.currentTime=Math.min(1,(v.duration||3)/3)};v.onseeked=()=>{try{const k=Math.min(1,480/(v.videoWidth||480)),c=document.createElement("canvas");c.width=Math.max(2,Math.round((v.videoWidth||480)*k));c.height=Math.max(2,Math.round((v.videoHeight||270)*k));c.getContext("2d").drawImage(v,0,0,c.width,c.height);done(c.toDataURL("image/jpeg",0.82))}catch(e){done(null)}};v.onerror=()=>done(null);setTimeout(()=>done(null),15000);v.src=' + JSON.stringify(url) + '})', true);
    if (!data || !/^data:image\/jpeg;base64,/.test(data)) return null;
    fs.writeFileSync(out, Buffer.from(data.split(',')[1], 'base64'));
    const c2 = loadCfg(); saveCfg({ ...c2, library: (c2.library || []).map((x) => (x.id === id ? { ...x, thumb: out } : x)) }); return out;
  } catch { return null; } finally { if (!w.isDestroyed()) w.destroy(); }
}
ipcMain.handle('live:thumb', (_e, id) => (thumbChain = thumbChain.then(() => makeLibThumb(String(id || ''))).catch(() => null)));
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
ipcMain.handle('perf:runningApps', () => new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -ExpandProperty ProcessName -Unique | Sort-Object"], { windowsHide: true, timeout: 15000 }, (e, out) => res(e ? [] : String(out).split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !/^(Wallpaper Hub|explorer|ApplicationFrameHost|TextInputHost|SystemSettings|ShellExperienceHost|SearchHost|StartMenuExperienceHost)$/i.test(x))))));
ipcMain.handle('icons:status', () => new Promise((res) => { const exe = iconFadePath(); if (!exe) return res({ found: false, running: false, runKey: false }); iconFadeRunning((running) => res({ found: true, path: exe, running, runKey: runKeyHas() })); }));
ipcMain.handle('icons:pick', async () => { const r = await dialog.showOpenDialog(win, { title: 'Find IconFade.exe', properties: ['openFile'], filters: [{ name: 'Icon Fade', extensions: ['exe'] }] }); if (r.canceled || !r.filePaths[0]) return null; saveCfg({ ...loadCfg(), iconFadePath: r.filePaths[0] }); return r.filePaths[0]; });
ipcMain.handle('icons:runkey', (_e, enable) => { // add or remove Icon Fade's own "start with Windows" entry (only when you click the button)
  const exe = iconFadePath(); if (!exe) return false; const cp = require('child_process');
  try { if (enable) cp.execFileSync('reg.exe', ['add', RUN_KEY, '/v', 'IconFade', '/t', 'REG_SZ', '/d', '"' + exe + '"', '/f'], { windowsHide: true, stdio: 'ignore' }); else cp.execFileSync('reg.exe', ['delete', RUN_KEY, '/v', 'IconFade', '/f'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  return runKeyHas();
});
ipcMain.handle('playlist:next', (_e, scope) => (pairKeysNow().includes(scope) ? pairNext() : plNext(scope || 'all')));
ipcMain.handle('playlist:pairs', async () => { const keys = pairKeysNow(); if (keys.length < 2) return []; const mons = monitors(), map = pairMap(keys), t = await pairCompute(keys); return t.map((x) => ({ d: +x.d.toFixed(2), parts: Object.entries(x.picks).map(([k, it]) => ({ screen: (mons.find((m) => m.key === (map[k] || k)) || {}).n || k, title: it.title || it.name || it.id })).sort((a, b) => a.screen - b.screen) })); });
ipcMain.handle('gfx:info', () => ({ on: !!loadCfg().gfxAuto, effective: effectiveGfx(), reason: gfxAuto.reason }));
ipcMain.handle('live:remove', (_e, id) => {
  const c = loadCfg(); const e = c.library.find(l => l.id === id);
  if (e) { try { fs.unlinkSync(e.file); } catch {} try { if ((e.type === 'fuse' || !e.type || e.type === 'video') && e.thumb && e.thumb.startsWith(app.getPath('userData'))) fs.unlinkSync(e.thumb); } catch {} }
  saveCfg({ ...c, library: c.library.filter(l => l.id !== id), ...(c.playlists ? { playlists: Object.fromEntries(Object.entries(c.playlists).map(([k, p]) => [k, p ? { ...p, items: (p.items || []).filter(i => i.id !== id) } : p])) } : {}) });
  return loadCfg();
});

if (LIVE_ARG) runLiveProcess();
else if (!app.requestSingleInstanceLock()) app.quit(); // already running: just bring that one forward
else app.whenReady().then(() => {
  const hidden = process.argv.includes('--hidden');
  syncBattery(); powerMonitor.on('on-battery', () => { syncBattery(); gfxAutoTick(true); }); powerMonitor.on('on-ac', () => { syncBattery(); gfxAutoTick(true); }); // "Pause on battery power" and automatic graphics
  setInterval(() => { gfxAutoTick(); watcherSync(); iconFadeSync(); }, 5000); setInterval(appPauseTick, 4000);
  powerMonitor.on('lock-screen', () => setLocked(true)); powerMonitor.on('unlock-screen', () => setLocked(false)); powerMonitor.on('suspend', () => setLocked(true)); powerMonitor.on('resume', () => { setLocked(false); setTimeout(() => resumeLive('sleep'), 3500); }); setInterval(meterTick, 2000); plSync();
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  if (!hidden) makeMainWindow(true);
  // explicit Edit menu so Ctrl+V/C/X/A always work, plus a right-click menu in text boxes
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Edit', submenu: [
    { role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }]));
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }));
  tray.setToolTip('Wallpaper Hub');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open', click: () => makeMainWindow(true) },
    { label: 'Random wallpaper', click: () => randomApply().catch(() => {}) },
    { label: 'Live wallpaper: pause / play', click: () => { setLivePaused(!liveState.paused); if (win && !win.isDestroyed()) win.webContents.send('live-paused', liveState.paused); } },
    { label: 'Desktop icons: show / fade away', click: () => iconFadeToggle() },
    { label: 'Playlist: next wallpaper', click: () => { if (pairKeysNow().length) pairNext(); else for (const [k] of plActive()) plNext(k); } },
    { label: 'Stop live wallpaper', click: () => stopLive() },
    { type: 'separator' },
    { label: 'Performance overlay: show / hide  (Ctrl+Shift+P)', click: () => overlaySet(!(loadCfg().overlay && loadCfg().overlay.on)) },
    { label: 'Music: play / pause', click: () => audioToggle() },
    { label: 'Music: next track', click: () => { if (audioCfg().tracks.length) audioPlayIndex(audioIdx + 1); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }]));
  tray.on('click', () => makeMainWindow(true));
  schedule(); syncNotifFeed();
  if (loadCfg().updateCheck !== false) { setTimeout(() => checkUpdate(false), 15000); setInterval(() => { if (loadCfg().updateCheck !== false) checkUpdate(false); }, 12 * 3600 * 1000); }
  globalShortcut.register('CommandOrControl+Shift+G', () => setGameManual(!gameManual)); // Game mode on / off, even inside a game
  globalShortcut.register('CommandOrControl+Shift+P', () => overlaySet(!(loadCfg().overlay && loadCfg().overlay.on))); // show / hide the performance overlay
  if (loadCfg().overlay && loadCfg().overlay.on) overlayShow();
  try { for (const f of fs.readdirSync(app.getPath('userData'))) if (/^ps-.*[.]ps1$/.test(f)) { const p = path.join(app.getPath('userData'), f); if (Date.now() - fs.statSync(p).mtimeMs > 3600e3) fs.unlinkSync(p); } } catch {} // tidy up old helper scripts
  setTimeout(iconFadeStartupRestore, 1500);
  try { migrateScreenKeys(); } catch (e) { console.log('screen key migration failed:', e.message); }
  try { const c0 = loadCfg(); if (!c0.fitWholeDone) saveCfg({ ...c0, stillFit: 'whole', liveFit: 'contain', fitWholeDone: true }); } catch {} // one time: pictures, GIFs and videos now show whole (changeable in Settings)
  backupCfg('start'); setInterval(() => backupCfg('timer'), 3 * 3600e3);
  { let dT = 0; const dc = () => { clearTimeout(dT); dT = setTimeout(() => { if (anyLive()) resumeLive('screen change'); }, 4000); }; screen.on('display-added', dc); screen.on('display-removed', dc); }
  const c = loadCfg(), here = monitors();
  // bring back each screen's live wallpaper (older settings only knew one, which belonged on the main screen)
  const saved = c.liveScreens && Object.keys(c.liveScreens).length ? c.liveScreens : (c.live ? { [(here.find((m) => m.primary) || here[0]).key]: c.live } : {});
  for (const [key, item] of Object.entries(saved)) {
    if (here.some((m) => m.key === key)) startLive(item, key, { persist: false }).catch((e) => console.log('live restore failed:', e.message));
  }
  if (audioCfg().autoplay && audioCfg().tracks.length) audioPlayIndex(audioCfg().index || 0).catch(() => {});
});
app.on('second-instance', () => { makeMainWindow(true); });
app.on('before-quit', () => { app.isQuitting = true; iconFadeQuit(); try { if (wpnProc) wpnProc.kill(); } catch {} killLive(); overlayHide(); statsStop(); globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => { if (app.isQuitting) app.quit(); }); // the app lives in the tray; the main window's own 'closed' handler ends it when it is really closed
