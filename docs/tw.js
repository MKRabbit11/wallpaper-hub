// The wallpaper tweaks chosen in the app's Customize tab (picture adjustments, position, flips, overlays, video speed).
// Used by live.html, and injected into YouTube / web wallpapers by the app.
function whApplyTweaks(TW, o) {
  o = o || {}; if (!TW || typeof TW !== 'object') return;
  const doc = document, n = (k, d, lo, hi) => { const x = +TW[k]; return Number.isFinite(x) && TW[k] !== undefined ? Math.min(hi, Math.max(lo, x)) : d; };
  const f = [], hue = n('hue', 0, -180, 180), sat = n('sat', 100, 0, 250), bri = n('bri', 100, 30, 200), con = n('con', 100, 40, 200), bl = n('blur', 0, 0, 40), se = n('sep', 0, 0, 100), gr = n('gray', 0, 0, 100), inv = n('inv', 0, 0, 100);
  if (hue) f.push('hue-rotate(' + hue + 'deg)'); if (sat !== 100) f.push('saturate(' + sat + '%)'); if (bri !== 100) f.push('brightness(' + bri + '%)'); if (con !== 100) f.push('contrast(' + con + '%)');
  if (bl) f.push('blur(' + bl + 'px)'); if (se) f.push('sepia(' + se + '%)'); if (gr) f.push('grayscale(' + gr + '%)'); if (inv) f.push('invert(' + inv + '%)');
  let z = n('zoom', 100, 50, 300) / 100; if (bl) z = Math.max(z, 1 + (bl * 5) / Math.max(400, innerWidth)); // a blurred picture fades out at its edges: enlarge a little so no dark rim shows
  const px = n('px', 0, -50, 50), py = n('py', 0, -50, 50), rot = n('rot', 0, -180, 180), sx = TW.fh ? -1 : 1, sy = TW.fv ? -1 : 1, tgt = o.root === 'html' ? 'html' : 'body';
  let css = '';
  if (f.length) css += 'body{filter:' + f.join(' ') + '}';
  if (z !== 1 || px || py || rot || sx < 0 || sy < 0) css += tgt + '{transform:translate(' + px + 'vw,' + py + 'vh) rotate(' + rot + 'deg) scale(' + z * sx + ',' + z * sy + ');transform-origin:50% 50%}';
  if (['cover', 'contain', 'fill'].includes(TW.fit)) css += 'canvas,video,img{object-fit:' + TW.fit + '!important}';
  if (css) doc.head.insertAdjacentHTML('beforeend', '<style>' + css + '</style>');
  const ov = (style) => { const d = doc.createElement('div'); d.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483000;' + style; doc.documentElement.appendChild(d); return d; };
  const tamt = n('tamt', 0, 0, 100), vig = n('vig', 0, 0, 100), gra = n('grain', 0, 0, 100), scan = n('scan', 0, 0, 100), lb = n('lb', 0, 0, 30);
  if (tamt) ov('inset:0;background:' + (/^#[0-9a-f]{6}$/i.test(TW.tint || '') ? TW.tint : '#ff8c3c') + ';opacity:' + tamt / 100 + ';mix-blend-mode:' + (['overlay', 'multiply', 'screen', 'color', 'normal', 'soft-light'].includes(TW.tmode) ? TW.tmode : 'overlay'));
  if (vig) ov('inset:0;background:radial-gradient(ellipse at center,transparent ' + Math.round(62 - vig * 0.3) + '%,rgba(0,0,0,' + (0.25 + vig * 0.0075).toFixed(2) + ') 100%)');
  if (gra) ov('inset:0;opacity:' + (gra / 100 * 0.55).toFixed(2) + ";mix-blend-mode:overlay;background-image:url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 .5 0 0 0 0 .5 0 0 0 0 .5 0 0 0 1.6 -.2'/></filter><rect width='240' height='240' filter='url(%23n)'/></svg>\")");
  if (scan) ov('inset:0;background:repeating-linear-gradient(0deg,rgba(0,0,0,' + (scan / 100 * 0.55).toFixed(2) + ') 0,rgba(0,0,0,' + (scan / 100 * 0.55).toFixed(2) + ') 1px,transparent 1px,transparent 3px)');
  if (lb) { ov('left:0;right:0;top:0;height:' + lb + '%;background:#000'); ov('left:0;right:0;bottom:0;height:' + lb + '%;background:#000'); }
  const tx = typeof TW.txt === 'string' ? TW.txt.slice(0, 80) : ''; // your own words on the wallpaper
  if (tx) { const P = { tl: 'top:4vh;left:4vw;text-align:left', tc: 'top:4vh;left:0;right:0;text-align:center', tr: 'top:4vh;right:4vw;text-align:right', ml: 'top:50%;left:4vw;transform:translateY(-50%);text-align:left', mc: 'top:50%;left:0;right:0;transform:translateY(-50%);text-align:center', mr: 'top:50%;right:4vw;transform:translateY(-50%);text-align:right', bl: 'bottom:4vh;left:4vw;text-align:left', bc: 'bottom:4vh;left:0;right:0;text-align:center', br: 'bottom:4vh;right:4vw;text-align:right' };
    const F = { sans: '"Segoe UI",system-ui,sans-serif', serif: 'Georgia,"Times New Roman",serif', mono: 'Consolas,"Courier New",monospace', round: '"Arial Rounded MT Bold","Segoe UI",sans-serif', script: '"Segoe Script","Brush Script MT",cursive' };
    const d = ov((P[TW.txp] || P.bc) + ';font:600 ' + n('txs', 6, 1, 30) + 'vh/1.15 ' + (F[TW.txf] || F.sans) + ';color:' + (/^#[0-9a-f]{6}$/i.test(TW.txc || '') ? TW.txc : '#ffffff') + ';opacity:' + n('txo', 90, 5, 100) / 100 + ';text-shadow:0 2px 14px rgba(0,0,0,.55);white-space:pre-wrap;padding:0 1vw'); d.textContent = tx; }
  if (typeof TW.css === 'string' && TW.css.trim()) doc.head.insertAdjacentHTML('beforeend', '<style>' + TW.css.replace(/@import[^;]*;?/gi, '').replace(/<\/style/gi, '') + '</style>');
  const t0 = n('tr0', 0, 0, 86400), t1 = n('tr1', 0, 0, 86400); // play only part of a video
  if (o.video && (t0 || t1)) { const vv = o.video, seek = () => { try { if (vv.duration && (vv.currentTime < t0 || (t1 > t0 && vv.currentTime >= t1) || vv.currentTime >= vv.duration - 0.05)) vv.currentTime = t0; } catch {} }; vv.addEventListener('loadedmetadata', seek); setInterval(seek, 120); }
  const sp = n('vsp', 100, 10, 400) / 100, v = o.video; // video speed
  if (sp !== 1 && v) { const setR = () => { try { v.playbackRate = sp; } catch {} }; v.addEventListener('loadedmetadata', setR); v.addEventListener('playing', setR); setInterval(setR, 2000); setR(); }
}
