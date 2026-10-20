# Wallpaper Hub

Browse wallpapers from the web and set them with one click, or run **live (animated) wallpapers** behind your desktop icons on Windows. Works with multiple monitors.

![icon](build/icon.png)

## Download

Get the latest installer from the **[Releases page](../../releases/latest)** and run `Wallpaper-Hub-Setup-*.exe`.
A no-install `Wallpaper-Hub-Portable-*.exe` is there too.

> Windows may show **"Windows protected your PC"** because the app isn't code-signed. Click **More info**, then **Run anyway**.

## Features

- **Wallpapers:** search Wallhaven, Bing Daily, or the whole web (Bing Images). Filter by minimum resolution and aspect ratio. Favorites and timed auto-change.
- **Several monitors:** pick which screen a wallpaper goes on (or all of them). Still and live wallpapers are set per screen, and a game on one screen only pauses that screen.
- **Live wallpapers:**
  - 30+ built-in animated scenes (black hole, synthwave, galaxy, sakura, rainy window, neon terrain, clock, ...).
  - **Music-reactive scenes** that move to whatever sound your PC is playing (system audio only, never the microphone).
  - A free video library (NASA and Wikimedia Commons) with category buttons.
  - Your own MP4/WebM/GIF files, YouTube videos and playlists (with Next and Shuffle), and Pexels stock videos (free API key).
  - Volume control, render-quality setting, pauses while a game or fullscreen app is focused, runs from the tray, optional start with Windows.
- **Music tab:** play your own audio files and folders, YouTube links, or free internet radio stations in the background, with any wallpaper.

## Privacy

No accounts, no analytics, no telemetry. The app only contacts the sites it needs (Wallhaven, Bing, NASA, Wikimedia, YouTube, SomaFM radio, and Pexels if you add a key). Everything is stored on your PC.

## Build from source

```
npm install
npm start        # run
npm run dist     # build installer + portable exe into dist/
```

Requires Node.js. Windows only.
