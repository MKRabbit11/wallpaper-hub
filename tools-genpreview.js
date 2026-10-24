// Dev tool (not shipped): records a short looping preview clip (.webm) and a poster (.jpg) of one built-in scene.
// usage: electron tools-genpreview.js   with env SCENE=<name> OUT=<folder>
const { app, BrowserWindow } = require('electron'); const fs = require('fs'); const path = require('path');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const name = process.env.SCENE, out = process.env.OUT;
  const w = new BrowserWindow({ width: 640, height: 360, show: true, x: -4000, y: -4000, useContentSize: true, webPreferences: { backgroundThrottling: false } });
  await w.loadFile('live.html', { query: { type: 'scene', name, ...(process.env.LYRICS_OVERLAY ? { lyrics: 'true' } : {}) } });
  const js = (s) => w.webContents.executeJavaScript(s, true);
  if (['sysmon', 'matrixstats', 'netpulse', 'diskwall'].includes(name)) { // pretend stats so the HUD has something to show
    await js(`(function(){const mk=()=>({t:Date.now(),cpu:{usage:18+Math.round(Math.random()*30),cores:[],freq:4700,temp:58+Math.round(Math.random()*8),name:'AMD Ryzen 9 7900X 12-Core Processor'},gpu:{name:'NVIDIA GeForce RTX 4070',usage:35+Math.round(Math.random()*40),temp:55+Math.round(Math.random()*8),vramUsed:3400,vramTotal:12282,power:95+Math.round(Math.random()*40)},ram:{used:15e9,total:33e9,pct:46},fps:144,disk:{pct:20,read:Math.random()<.5?8e6*Math.random():2e5,write:Math.random()<.4?4e6*Math.random():1e5},net:{down:Math.random()*9e6+2e6,up:Math.random()*1.2e6}});window.__stats=mk();setInterval(()=>{window.__stats=mk()},1000)})()`);
  }
  if (name === 'earthiss') await js(`(function(){let a=0;const mk=()=>{a+=.4;window.__iss={lat:35*Math.sin(a/8),lon:-120+a*3.2,alt:420,vel:27580,t:Date.now()}};mk();setInterval(mk,500)})()`);
  if (name === 'lyrics' || process.env.LYRICS_OVERLAY) await js(`(function(){const L=['Your lyrics appear here','one line at a time','in time with the music','so you can sing along','whatever is playing','on Spotify or YouTube'];window.__lyrL={key:'k',synced:L.map((t,i)=>({t:i*2,text:t})),plain:''};const t0=Date.now();setInterval(()=>{window.__lyrS={status:'ok',playing:true,pos:(Date.now()-t0)/1000,dur:60,at:Date.now(),title:'Demo song',artist:'Wallpaper Hub',key:'k'}},200)})()`);
  await wait(2500);   // let the scene warm up
  fs.writeFileSync(path.join(out, name + '.jpg'), (await w.webContents.capturePage()).toJPEG(82));
  const b64 = await js(`new Promise((res)=>{
    const c=[...document.querySelectorAll('canvas')].find(x=>getComputedStyle(x).display!=='none'); if(!c){res('');return}
    const rec=new MediaRecorder(c.captureStream(30),{mimeType:'video/webm;codecs=vp8',videoBitsPerSecond:700000}), parts=[];
    rec.ondataavailable=e=>parts.push(e.data);
    rec.onstop=async()=>{const buf=await new Blob(parts,{type:'video/webm'}).arrayBuffer();let s='';const u=new Uint8Array(buf);for(let i=0;i<u.length;i+=32768)s+=String.fromCharCode.apply(null,u.subarray(i,i+32768));res(btoa(s))};
    rec.start(); setTimeout(()=>rec.stop(), 4000)})`);
  if (b64) { fs.writeFileSync(path.join(out, name + '.webm'), Buffer.from(b64, 'base64')); console.log('OK', name, (Buffer.from(b64, 'base64').length / 1024).toFixed(0) + ' KB'); } else console.log('NO-CANVAS', name);
  app.exit(0);
});
