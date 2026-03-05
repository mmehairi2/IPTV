# 📺 Stream — IPTV Desktop App

A custom IPTV player with an Apple TV-inspired dark interface, built with Electron + mpv.  
Supports **Xtream Codes API** and **M3U playlists**.

---

## ✨ Features

- 🎨 **Apple TV-style UI** — dark, cinematic, polished with frameless chrome
- 📡 **Live TV** — channel grid with EPG live indicators
- 🎬 **Movies (VOD)** — poster grid with TMDB metadata and artwork
- 📽️ **TV Series** — browse and play episodes (Xtream Codes only)
- 🔍 **Search** — global search across all content types
- 📋 **M3U** — load from URL or local file
- 🔐 **Xtream Codes** — full API integration with categories
- 🎥 **mpv player** — GPU-accelerated hardware decoding, borderless overlay window
- 🟠 **VLC fallback** — automatic fallback if mpv crashes or isn't found
- ⌨️ **Keyboard + media key shortcuts** — including OS media keys (play/pause/next/prev/volume)
- ❤️ **Favorites & Watchlist** — persisted in IndexedDB
- ⏱️ **Continue Watching** — resume VOD from where you left off
- 📺 **EPG TV Guide** — timeline grid for Live TV schedule
- 🌙 **Sleep timer** — auto-close player after a set duration
- 💾 **Window state persistence** — remembers size, position, and maximized state
- 🔔 **Auto-update** — checks GitHub Releases on launch, notifies when update is ready

---

## 🚀 Quick Start

### 1. Install Prerequisites

- **[Node.js](https://nodejs.org)** (v18+)
- **[mpv](https://mpv.io)** — primary video player

  ```
  # Windows (winget)
  winget install mpv.net

  # Or download mpv.exe and place it next to the app exe, or in your PATH
  ```

- **[VLC](https://www.videolan.org/vlc/)** *(optional)* — used as fallback if mpv fails

### 2. Install & Run

```bash
cd iptv-player
npm install
npm start
```

### 3. Connect Your Source

On first launch, the **onboarding wizard** walks you through three steps:

1. **Connect source** — enter your Xtream Codes server URL, username, and password  
2. **Set up mpv** — the app auto-detects mpv and shows you its path  
3. **TMDB key** *(optional)* — paste a [TMDB v3 API key](https://www.themoviedb.org/settings/api) for movie artwork and metadata

You can also configure everything later via **Settings**.

---

## 🎮 Keyboard Shortcuts

| Action | Key |
|--------|-----|
| Play / Pause | `Space` |
| Seek back 10s | `←` |
| Seek forward 10s | `→` |
| Volume up / down | `↑` / `↓` |
| Mute | `M` |
| Fullscreen | `F` |
| Close player | `Esc` |
| Previous / next channel | `Page↑` / `Page↓` |
| Stream info | `I` |
| Screenshot | `S` |
| Refresh content | `Ctrl+R` |
| Show shortcuts | `?` |

**OS Media Keys** (keyboard media row) are also supported: play/pause, stop, next track, previous track, volume up/down.

---

## 📁 Project Structure

```
iptv-player/
├── assets/
│   ├── icon.png          ← App icon (256×256)
│   └── icon.ico          ← Windows icon
├── package.json
└── src/
    ├── main.js           ← Electron main process: mpv spawn, IPC, window state,
    │                        media keys, auto-updater
    ├── preload.js        ← Secure context-bridge (window.api)
    └── renderer/
        ├── index.html    ← UI shell, CSS design tokens, frameless titlebar
        ├── player.js     ← Playback controller, Player IIFE, boot, shortcuts
        ├── lists.js      ← Live/Movies/Series grids, category tabs, pagination
        ├── detail.js     ← Detail panel (metadata, TMDB enrichment)
        ├── settings.js   ← Settings UI, source management, export/import
        ├── epg.js        ← EPG timeline grid
        ├── tmdb.js       ← TMDB API client + local cache
        ├── download.js   ← Download queue
        ├── db.js         ← IndexedDB wrapper (channels, metadata, history)
        ├── imageCache.js ← In-memory poster cache (blob URLs)
        └── util.js       ← toast(), esc(), formatTime(), badges
```

---

## 🛠️ Troubleshooting

**mpv not found?**  
→ Run `winget install mpv.net` or place `mpv.exe` next to the app. The app also checks `%LOCALAPPDATA%\Programs\mpv\` and your PATH.

**Stream fails to play?**  
→ The player auto-retries once after 3 seconds. If it still fails, click the **Retry** button in the error toast, or use the **VLC** fallback button.

**mpv keeps crashing?**  
→ After 3 crashes the app automatically falls back to VLC for that stream. Check that your mpv version is recent (`mpv --version`).

**No internet / streams not loading?**  
→ A red banner appears at the top when the network drops. Streams resume automatically when connectivity is restored.

**Xtream connection failed?**  
→ Check the server URL format: `http://server.com:8080` — no trailing slash, port required.

**VLC button says "not found"?**  
→ Install VLC from videolan.org. On Windows the app checks all standard install paths automatically.

**App opens off-screen after moving to a different monitor setup?**  
→ Window position is validated against connected displays on launch; if the saved position is off-screen, it resets to center.

---

## 🔄 Auto-Update

Stream uses `electron-updater` to check for updates against GitHub Releases on launch. When an update downloads in the background, a blue banner appears at the top with a **Restart & Install** button.

To publish a release, configure the `publish` block in `package.json` with your GitHub username and repo, then run:

```bash
npm run pack   # build installer
```

---

## 💡 Tips

- Credentials and settings are stored in **IndexedDB** (not localStorage) — they survive cache clears
- The poster cache uses in-memory blob URLs for fast scrolling; it clears on restart
- Category filters and search are combined — filter by category first, then search within it
- The EPG guide syncs from your provider's XML URL — set it in Settings → EPG
- Sleep timer is accessible from the player top bar during playback