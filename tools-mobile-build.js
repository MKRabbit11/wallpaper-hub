// Builds the phone web app into docs/ (served by GitHub Pages): the same animated scenes and style layers as the desktop app, running in the phone's browser.
//   node tools-mobile-build.js
const fs = require('fs'), path = require('path');
const root = __dirname, out = path.join(root, 'docs');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'build', 'previews'), { recursive: true });

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sc = html.indexOf('const SCENES='), end = html.indexOf(']];', sc);
const SCENES = eval(html.slice(sc, end + 3).replace('const SCENES=', ''));
const fn = html.indexOf('const FUSE_NO=['), fe = html.indexOf('];', fn);
const NO = new Set(eval(html.slice(fn, fe + 2).replace('const FUSE_NO=', '')));   // scenes that need the PC (music, microphone, system numbers, mouse)
for (const n of ['earth3d', 'earth3dmoon']) NO.add(n); // (they need the bundled NASA pictures, which stay in the desktop app)
const list = SCENES.filter(([n]) => !NO.has(n) && fs.existsSync(path.join(root, 'build', 'previews', n + '.jpg')));
fs.writeFileSync(path.join(out, 'scenes.json'), JSON.stringify(list.map(([n, t]) => [n, t])));
for (const [n] of list) fs.copyFileSync(path.join(root, 'build', 'previews', n + '.jpg'), path.join(out, 'build', 'previews', n + '.jpg'));
fs.copyFileSync(path.join(root, 'live.html'), path.join(out, 'live.html'));
fs.copyFileSync(path.join(root, 'tw.js'), path.join(out, 'tw.js'));
fs.copyFileSync(path.join(root, 'mobile', 'index.html'), path.join(out, 'index.html'));
fs.copyFileSync(path.join(root, 'build', 'icon.png'), path.join(out, 'icon-192.png')); // (replaced by properly sized icons when tools-mobile-icons.js has been run)
fs.writeFileSync(path.join(out, 'manifest.webmanifest'), JSON.stringify({
  name: 'Wallpaper Hub', short_name: 'Wallpaper Hub', description: 'Live animated wallpapers for your phone', start_url: './', scope: './', display: 'standalone', orientation: 'any',
  background_color: '#030305', theme_color: '#030305', icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }],
}, null, 1));
const ver = Date.now().toString(36);
fs.writeFileSync(path.join(out, 'sw.js'), `// caches the app so it opens instantly and works offline once visited
const V = 'wh-${ver}', CORE = ['./', 'index.html', 'live.html', 'tw.js', 'scenes.json', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((r) => { if (r.ok) { const cp = r.clone(); caches.open(V).then((c) => c.put(e.request, cp)); } return r; })));
});
`);
fs.writeFileSync(path.join(out, '.nojekyll'), '');
const size = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((s, f) => s + (f.isDirectory() ? size(path.join(d, f.name)) : fs.statSync(path.join(d, f.name)).size), 0);
console.log('phone web app built:', list.length, 'scenes,', (size(out) / 1048576).toFixed(1), 'MB in docs/');
