// run with the app's own Electron:  npx electron tools-mobile-icons.js   (makes the 192 and 512 pixel icons for the phone web app)
const { app, nativeImage } = require('electron'); const fs = require('fs'), path = require('path');
app.whenReady().then(() => {
  const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
  for (const s of [192, 512]) fs.writeFileSync(path.join(__dirname, 'docs', 'icon-' + s + '.png'), img.resize({ width: s, height: s, quality: 'best' }).toPNG());
  console.log('icons written'); app.quit();
});
