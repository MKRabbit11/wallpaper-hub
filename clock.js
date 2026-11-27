// Clock and date drawn over a live wallpaper (used by live.html and, injected by the app, over YouTube and web wallpapers)
function startClock(o) {
  const sz = Math.max(40, Math.min(220, +o.size || 100)) / 100, col = /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : '#ffffff', style = String(o.style || 'thin');
  const pos = /^(top|bottom|center)-?(left|right|center)?$/.test(o.pos) || o.pos === 'center' ? String(o.pos) : 'bottom-right';
  const st = document.createElement('style');
  st.textContent = `@font-face{font-family:Jost;src:url("fonts/Jost.ttf");font-weight:100 900}
#whclock{position:fixed;inset:0;z-index:7;pointer-events:none;display:flex;padding:5vmin;box-sizing:border-box;color:var(--c);font-family:"Segoe UI",system-ui,sans-serif;text-shadow:0 2px 18px rgba(0,0,0,.55)}
#whclock .b{font-size:calc(1vmin*var(--z));text-align:var(--ta);line-height:1}
#whclock small{font-size:.38em;font-weight:600;margin-left:.25em;opacity:.8}
#whclock .d{font-size:3.2em;margin-top:1.1em;opacity:.85;font-weight:400;letter-spacing:.04em}
#whclock .thin .t{font-size:16em;font-weight:200;letter-spacing:-.02em}
#whclock .neon .t{font-size:15em;font-weight:700;letter-spacing:.04em;text-shadow:0 0 .12em var(--c),0 0 .5em var(--c),0 0 1.4em var(--c)}
#whclock .neon .d{text-transform:uppercase;letter-spacing:.3em;text-shadow:0 0 .4em var(--c)}
#whclock .mini .t{font-size:5em;font-weight:600;display:inline}#whclock .mini .d{font-size:3.4em;display:inline;margin:0 0 0 1.2em;opacity:.8}
#whclock .lcd .t{font-family:Consolas,"Cascadia Mono",monospace;font-size:12em;font-weight:700;padding:.16em .3em;border:.06em solid var(--c);border-radius:.14em;background:rgba(0,0,0,.45);text-shadow:0 0 .25em var(--c);display:inline-block}
#whclock .lcd .d{font-family:Consolas,"Cascadia Mono",monospace;font-size:3.4em;letter-spacing:.2em;text-transform:uppercase}
#whclock .stack .t{font-size:24em;font-weight:800;line-height:.82;letter-spacing:-.03em}#whclock .stack .t i{display:block;font-style:normal}#whclock .stack .t i+i{color:transparent;-webkit-text-stroke:.025em var(--c);text-shadow:none}
#whclock .stack .d{margin-top:1.4em;font-size:3.6em;letter-spacing:.3em;text-transform:uppercase}
#whclock .glass .card{display:inline-block;padding:2.2em 3.4em;border-radius:3em;background:rgba(255,255,255,.12);backdrop-filter:blur(22px) saturate(1.4);border:1px solid rgba(255,255,255,.28);box-shadow:0 10px 50px rgba(0,0,0,.35)}
#whclock .glass .t{font-size:11em;font-weight:300}#whclock .glass .d{margin-top:.7em;font-size:3.2em}
#whclock .cal .card{display:inline-block;width:24em;border-radius:2.2em;overflow:hidden;background:rgba(18,20,30,.62);backdrop-filter:blur(18px);box-shadow:0 10px 50px rgba(0,0,0,.4);text-align:center}
#whclock .cal .wd{background:var(--c);color:#111;font-weight:700;letter-spacing:.3em;text-transform:uppercase;font-size:2.6em;padding:.8em 0;text-shadow:none}
#whclock .cal .n{font-size:14em;font-weight:700;line-height:1.05;padding-top:.1em}#whclock .cal .m{font-size:2.8em;letter-spacing:.12em;text-transform:uppercase;opacity:.85}#whclock .cal .t{font-size:4em;font-weight:300;padding:.8em 0 1em;opacity:.9}
#whclock .rings svg,#whclock .orbit svg{width:34em;height:34em;display:block;margin:0 auto;overflow:visible}#whclock .rings svg text,#whclock .orbit svg text{text-shadow:none}#whclock .rings .d,#whclock .orbit .d{margin-top:.6em}
#whclock .ana svg{width:34em;height:34em;display:block;margin:0 auto;filter:drop-shadow(0 2px 14px rgba(0,0,0,.5))}#whclock .ana .d{text-align:center;margin-top:.9em}`;
  if (o.afont && /^(file:\/\/\/|data:font)/.test(String(o.afont))) st.textContent = '@font-face{font-family:Anurati;src:url("' + String(o.afont).replace(/"/g, '%22') + '")}\n' + st.textContent;
  document.head.appendChild(st);
  const el = document.createElement('div'); el.id = 'whclock'; el.style.setProperty('--c', col); el.style.setProperty('--z', 1 * sz);
  const v = /top/.test(pos) ? 'flex-start' : /bottom/.test(pos) ? 'flex-end' : 'center', h = /left/.test(pos) ? 'flex-start' : /right/.test(pos) ? 'flex-end' : 'center';
  el.style.alignItems = v; el.style.justifyContent = h; let ta = h === 'flex-start' ? 'left' : h === 'flex-end' ? 'right' : 'center'; const custom = o.pos === 'custom' && isFinite(o.x) && isFinite(o.y); if (custom) ta = 'center';
  const b = document.createElement('div'); b.className = 'b ' + style; b.style.setProperty('--ta', ta); if (custom) { b.style.cssText += ';position:absolute;left:' + Math.max(0, Math.min(100, +o.x)) + '%;top:' + Math.max(0, Math.min(100, +o.y)) + '%;transform:translate(-50%,-50%)'; } el.appendChild(b); document.body.appendChild(el);
  const two = (n) => String(n).padStart(2, '0');
  let last = '';
  const upd = () => {
    const d = new Date(), H = d.getHours(), M = d.getMinutes(), S = d.getSeconds(), h24 = !!o.h24, hh = h24 ? two(H) : String(H % 12 || 12), ap = h24 ? '' : '<small>' + (H < 12 ? 'AM' : 'PM') + '</small>';
    const date = o.date === false ? '' : d.toLocaleDateString(undefined, style === 'mini' ? { weekday: 'short', month: 'short', day: 'numeric' } : { weekday: 'long', month: 'long', day: 'numeric' });
    const tm = hh + ':' + two(M) + (o.secs ? ':' + two(S) : '') + ap, dd = date ? '<div class="d">' + date + '</div>' : '';
    let html;
    if (style === 'stack') html = '<div class="t"><i>' + hh + '</i><i>' + two(M) + '</i></div>' + dd;
    else if (style === 'glass') html = '<div class="card"><div class="t">' + tm + '</div>' + dd + '</div>';
    else if (style === 'cal') html = '<div class="card"><div class="wd">' + d.toLocaleDateString(undefined, { weekday: 'long' }) + '</div><div class="n">' + d.getDate() + '</div><div class="m">' + d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) + '</div><div class="t">' + tm + '</div></div>';
    else if (style === 'ana') {
      const a = (deg, len, w, c) => '<line x1="0" y1="' + (len > 0 ? 8 : 0) + '" x2="0" y2="' + (-Math.abs(len)) + '" stroke="' + c + '" stroke-width="' + w + '" stroke-linecap="round" transform="rotate(' + deg + ')"/>';
      let ticks = ''; for (let i = 0; i < 60; i++) { const big = i % 5 === 0; ticks += '<line x1="0" y1="-' + (big ? 82 : 88) + '" x2="0" y2="-93" stroke="' + col + '" stroke-width="' + (big ? 2.4 : 1) + '" opacity="' + (big ? 1 : .5) + '" transform="rotate(' + i * 6 + ')"/>'; }
      html = '<svg viewBox="-100 -100 200 200"><circle r="97" fill="rgba(12,14,22,.45)" stroke="' + col + '" stroke-width="1.5" opacity=".95"/>' + ticks + a(((H % 12) + M / 60) * 30, 50, 4.5, col) + a((M + S / 60) * 6, 74, 3, col) + (o.secs ? a(S * 6, 82, 1.4, '#ff5a4e') : '') + '<circle r="4" fill="' + col + '"/></svg>' + dd;
    } else if (style === 'rings' || style === 'orbit') {
      const fr = [(H % 12 + M / 60) / 12, (M + S / 60) / 60, (S + (d.getMilliseconds() / 1000)) / 60], R = [92, 76, 60], dim = 'rgba(255,255,255,.14)';
      let s = '<svg viewBox="-100 -100 200 200">';
      if (style === 'rings') { fr.forEach((f, i) => { const c = 2 * Math.PI * R[i]; s += '<circle r="' + R[i] + '" fill="none" stroke="' + dim + '" stroke-width="7"/><circle r="' + R[i] + '" fill="none" stroke="' + col + '" stroke-width="7" stroke-linecap="round" opacity="' + (1 - i * .22) + '" stroke-dasharray="' + (f * c).toFixed(1) + ' ' + c.toFixed(1) + '" transform="rotate(-90)"/>'; }); }
      else { fr.forEach((f, i) => { const a = f * 2 * Math.PI - Math.PI / 2, rr = 22 + i * 0; s += '<circle r="' + R[i] + '" fill="none" stroke="' + col + '" stroke-width=".8" opacity=".4"/><circle cx="' + (R[i] * Math.cos(a)).toFixed(2) + '" cy="' + (R[i] * Math.sin(a)).toFixed(2) + '" r="' + (6 - i) + '" fill="' + col + '"/>'; }); }
      s += '<text y="6" text-anchor="middle" font-size="' + (o.secs ? 21 : 24) + '" font-weight="300" fill="' + col + '" stroke="none" style="text-shadow:none">' + tm.replace(/<small>/,' ').replace(/<[^>]+>/g, '') + '</text></svg>';
      html = s + dd.replace('class="d"', 'class="d" style="text-align:center"');
    } else if (style === 'elegant') {
      html = '<div style="font-size:14em;font-weight:200;letter-spacing:.12em;text-transform:uppercase">' + d.toLocaleDateString(undefined, { weekday: 'long' }) + '</div><div style="height:2px;background:' + col + ';margin:1.6em 0 1.4em;opacity:.7"></div><div style="display:flex;justify-content:space-between;font-size:4.2em;letter-spacing:.2em;text-transform:uppercase"><span>' + d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' }) + '</span><span>' + tm + '</span></div>';
    } else if (style === 'spaced') {
      const F = 'font-family:Anurati,Jost,Bahnschrift,sans-serif;text-align:center;', wd = d.toLocaleDateString(undefined, { weekday: 'long' }).toUpperCase().split('').join(''), ds = two(d.getDate()) + ' ' + d.toLocaleDateString(undefined, { month: 'long' }).toUpperCase() + ', ' + d.getFullYear();
      html = '<div style="' + F + '"><div style="font-size:8em;font-weight:400;letter-spacing:.4em;margin-right:-.4em">' + wd + '</div>' + (date ? '<div style="font-size:1.7em;letter-spacing:.4em;margin:2.2em -.4em 0 0;opacity:.85">' + ds + '</div>' : '') + '<div style="font-size:3.4em;letter-spacing:.3em;margin:1em -.4em 0 0;opacity:.8">- ' + hh + ':' + two(M) + (o.secs ? ':' + two(S) : '') + (h24 ? '' : ' ' + (H < 12 ? 'AM' : 'PM')) + ' -</div></div>';
    } else if (style === 'side') {
      html = '<div style="display:flex;align-items:stretch;gap:2em;text-align:left"><div style="width:.9em;background:' + col + ';border-radius:1em"></div><div><div style="font-size:15em;font-weight:300">' + tm + '</div><div style="font-size:4em;margin-top:.8em;letter-spacing:.15em;opacity:.85">' + d.toLocaleDateString(undefined, { weekday: 'long' }).toUpperCase() + '</div>' + (date ? '<div style="font-size:3.2em;margin-top:.5em;opacity:.6">' + d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) + '</div>' : '') + '</div></div>';
    } else if (style === 'binary') {
      const digs = [H, M, S].flatMap((n) => [Math.floor(n / 10), n % 10]); let s = '<div style="display:flex;gap:2.2em;justify-content:center">';
      digs.forEach((n, ci) => { if (ci >= 4 && !o.secs) return; if (ci === 2 || ci === 4) s += '<div style="width:1.4em"></div>'; s += '<div style="display:flex;flex-direction:column;gap:1.5em">'; for (let bit = 3; bit >= 0; bit--) { const on = (n >> bit) & 1, skip = ci === 0 && bit > 1 || (ci === 2 || ci === 4) && bit === 3; s += '<div style="width:4.6em;height:4.6em;border-radius:50%;' + (skip ? 'visibility:hidden;' : '') + (on ? 'background:' + col + ';box-shadow:0 0 1.2em ' + col : 'background:rgba(255,255,255,.14)') + '"></div>'; } s += '</div>'; });
      html = s + '</div>' + dd.replace('class="d"', 'class="d" style="text-align:center"');
    } else if (style === 'word') {
      const G = ['ITLISASTIME', 'ACQUARTERDC', 'TWENTYFIVEX', 'HALFBTENFTO', 'PASTERUNINE', 'ONESIXTHREE', 'FOURFIVETWO', 'EIGHTELEVEN', 'SEVENTWELVE', 'TENSEOCLOCK'];
      const P = { it: [0, 0, 2], is: [0, 3, 2], quarter: [1, 2, 7], twenty: [2, 0, 6], fivem: [2, 6, 4], half: [3, 0, 4], tenm: [3, 5, 3], to: [3, 9, 2], past: [4, 0, 4], nine: [4, 7, 4], one: [5, 0, 3], six: [5, 3, 3], three: [5, 6, 5], four: [6, 0, 4], five: [6, 4, 4], two: [6, 8, 3], eight: [7, 0, 5], eleven: [7, 5, 6], seven: [8, 0, 5], twelve: [8, 5, 6], ten: [9, 0, 3], oclock: [9, 5, 6] };
      const HN = ['twelve', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven'], k = Math.floor(M / 5), hr = (H % 12 + (k >= 7 ? 1 : 0)) % 12;
      const mw = [['oclock'], ['fivem', 'past'], ['tenm', 'past'], ['quarter', 'past'], ['twenty', 'past'], ['twenty', 'fivem', 'past'], ['half', 'past'], ['twenty', 'fivem', 'to'], ['twenty', 'to'], ['quarter', 'to'], ['tenm', 'to'], ['fivem', 'to']][k];
      const lit = new Set(); [...['it', 'is'], ...mw, HN[hr]].forEach((w) => { const p = P[w]; for (let i = 0; i < p[2]; i++) lit.add(p[0] * 11 + p[1] + i); });
      let s = '<div style="display:inline-grid;grid-template-columns:repeat(11,1fr);gap:.9em 1.2em;font-weight:600;font-size:4.4em;text-align:center">';
      for (let r = 0; r < 10; r++) for (let c = 0; c < 11; c++) s += '<span style="opacity:' + (lit.has(r * 11 + c) ? 1 : .16) + ';' + (lit.has(r * 11 + c) ? 'text-shadow:0 0 .6em ' + col : '') + '">' + G[r][c] + '</span>';
      html = s + '</div>';
    } else if (style === 'bars') {
      const y0 = new Date(d.getFullYear(), 0, 1), yd = (d - y0) / 864e5, yl = (d.getFullYear() % 4 === 0 ? 366 : 365);
      const rows = [['HOUR', (H + M / 60) / 24, two(H)], ['MIN', (M + S / 60) / 60, two(M)], ['SEC', S / 60, two(S)], ['DAY', d.getDay() / 6, d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()], ['YEAR', yd / yl, Math.round(yd / yl * 100) + '%']];
      html = '<div style="width:46em">' + rows.map((r) => '<div style="display:flex;align-items:center;gap:1.4em;margin:1.3em 0;font-size:3em"><span style="width:3.4em;opacity:.7;letter-spacing:.2em;font-size:.8em">' + r[0] + '</span><span style="flex:1;height:.5em;background:rgba(255,255,255,.16);border-radius:1em;overflow:hidden"><i style="display:block;height:100%;width:' + (r[1] * 100).toFixed(1) + '%;background:' + col + ';border-radius:1em"></i></span><b style="width:2.6em;text-align:right;font-weight:600">' + r[2] + '</b></div>').join('') + (date ? '<div class="d" style="margin-top:1.6em;text-align:right;font-size:3em">' + date + '</div>' : '') + '</div>';
    } else html = '<div class="t">' + tm + '</div>' + dd;
    if (html !== last) { b.innerHTML = html; last = html; }
  };
  upd(); setInterval(upd, 500);
}
