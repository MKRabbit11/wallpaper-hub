# Wallpaper Hub

Browse wallpapers from the web and set them with one click, or run **live (animated) wallpapers** behind your desktop icons on Windows.

![icon](build/icon.png)

## Download

Get the latest installer from the **[Releases page](../../releases/latest)** and run `Wallpaper-Hub-Setup-*.exe`.
A no-install `Wallpaper-Hub-Portable-*.exe` is there too.

> Windows may show **"Windows protected your PC"** because the app isn't code-signed. Click **More info**, then **Run anyway**.

## Features

- **Wallpapers:** search Wallhaven, Bing Daily, or the whole web (Bing Images). Filter by minimum resolution and aspect ratio. Favorites and timed auto-change.
- **Live wallpapers:** built-in animated scenes (starfield, matrix rain, aurora, network, rain), your own MP4/WebM/GIF files, YouTube videos and playlists (with Next and Shuffle), and Pexels stock videos (free API key).
- Volume control, render-quality setting, pauses while a game or fullscreen app is focused, runs from the tray, optional start with Windows.

## Build from source

```
npm install
npm start        # run
npm run dist     # build installer + portable exe into dist/
```

Requires Node.js. Windows only.