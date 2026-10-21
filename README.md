# Wallpaper Hub

Browse wallpapers from the web and set them with one click, or run **live (animated) wallpapers** behind your desktop icons on Windows. Works with multiple monitors.

![icon](build/icon.png)

## Download

Get the latest installer from the **[Releases page](../../releases/latest)** and run `Wallpaper-Hub-Setup-*.exe`.
A no-install `Wallpaper-Hub-Portable-*.exe` is there too.

> Windows may show **"Windows protected your PC"** because the app isn't code-signed. Click **More info**, then **Run anyway**.

## Features

- **Wallpapers:** search Wallhaven, Bing Daily, or the whole web (Bing Images). Filter by minimum resolution and aspect ratio. Favorites, timed auto-change, and a Refresh button that reshuffles the results.
- **Several monitors:** pick which screen a wallpaper goes on (or all of them). Still and live wallpapers are set per screen, and a game on one screen only pauses that screen.
- **Live wallpapers:**
  - 45 built-in animated scenes (black hole, synthwave, galaxy, sakura, rainy window, cyberpunk street, deep ocean, ringed planet, a real-time solar system, real-time sky, ...) with animated previews.
  - **Music-reactive scenes** (equalizer city, lasers, fireworks, galaxy, waves, ...) that move to whatever sound your PC is playing (system audio only). Two optional scenes (Voice Orb, Clap Lights) use your microphone only after you confirm; Cursor Magic follows your mouse.
  - A **System Monitor** wallpaper showing live CPU, GPU, temperatures and memory.
  - A free video library (NASA and Wikimedia Commons) with category buttons.
  - Your own MP4/WebM/GIF files (drag and drop, or paste a link), YouTube videos and playlists (with Next and Shuffle), and Pexels stock videos (free API key).
  - Volume control, resolution, sharpness (smooth, normal, sharp) and picture-fit settings that also work on GIFs and videos, pauses while a game or fullscreen app is focused, runs from the tray, optional start with Windows.
- **GIFs tab:** use any animated GIF as a wallpaper. Add your own, or browse free GIFs (Wikimedia Commons, or Giphy with your own free key).
- **Music tab:** play your own audio files and folders, YouTube links, or free internet radio stations in the background, with any wallpaper.
- **Performance tab and overlay:** live CPU, graphics card, memory, disk and network, plus GPU temperature (NVIDIA). An optional small always-on-top overlay (Ctrl+Shift+P) for games. CPU temperature and game FPS appear when HWiNFO / RivaTuner are running; the app installs no drivers.
- **Update notice:** tells you when a newer version is published here on GitHub.

## Privacy

No accounts, no analytics, no telemetry. The app only contacts the sites it needs (Wallhaven, Bing, NASA, Wikimedia, YouTube, SomaFM radio, GitHub for the update check, and Pexels or Giphy if you add a key). Everything is stored on your PC.

## Build from source

```
npm install
npm start        # run
npm run dist     # build installer + portable exe into dist/
```

Requires Node.js. Windows only. `tools-genpreview.js` regenerates the scene preview clips in `build/previews/`.
