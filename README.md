# 📺 IPTV Player — Desktop App

A custom IPTV player with an Apple TV-inspired interface built with Electron.  
Supports both **Xtream Codes API** and **M3U playlists**.

---

## ✨ Features

- 🎨 **Apple TV-style UI** — dark, cinematic, polished
- 📡 **Live TV** — channel grid with live indicator
- 🎬 **Movies (VOD)** — poster grid with play/VLC buttons
- 📽️ **TV Series** — browse and play episodes (Xtream only)
- 🔍 **Search** — global search across all content
- 📋 **M3U** — load from URL or local file
- 🔐 **Xtream Codes** — full API integration with categories
- 🎥 **Built-in player** — HLS.js for live/HLS streams
- 🟠 **VLC/mpv fallback** — one click to open in external player
- ⌨️ **Keyboard shortcuts** — `Esc` to close player, `Ctrl+F` to search

---

## 🚀 Quick Start

### 1. Install Prerequisites
- **[Node.js](https://nodejs.org)** (v18+)
- **[VLC Media Player](https://www.videolan.org/vlc/)** (recommended for playback)

### 2. Install & Run
```bash
# Navigate to this folder
cd iptv-player

# Install dependencies
npm install

# Start the app
npm start
```

### 3. Connect Your Source

**Option A — Xtream Codes:**
1. Go to **Settings**
2. Enter your server URL, username, and password
3. Click "Connect Xtream Codes"

**Option B — M3U Playlist:**
1. Go to **Settings**
2. Paste your M3U URL and click "Load from URL"
3. Or click "Open Local M3U File" to browse for a file

---

## 🎮 Usage

| Action | How |
|--------|-----|
| Play a stream | Click any channel/movie card |
| Open in VLC | Click "VLC" button on card, or the VLC button in player |
| Close player | Press `Esc` or click ← |
| Search | `Ctrl+F` or click Search in sidebar |
| Filter by category | Use the filter tabs at the top of each page |

---

## 📁 Project Structure

```
iptv-player/
├── package.json
├── src/
│   ├── main.js         ← Electron main process (Node.js, no CORS)
│   ├── preload.js      ← Secure IPC bridge
│   └── renderer/
│       ├── index.html  ← UI layout
│       └── app.js      ← App logic
```

---

## 🛠️ Troubleshooting

**Stream won't play in built-in player?**
→ Click "Open in VLC" — VLC handles all formats including encrypted streams.

**M3U not loading?**
→ Make sure the URL is accessible. Some providers block certain user-agents.

**Xtream connection failed?**
→ Double-check the server URL format: `http://server.com:port` (no trailing slash).

**VLC button says "not found"?**
→ Install VLC from videolan.org. On Windows it checks standard install paths automatically.

---

## 💡 Tips

- Your source credentials are saved in localStorage — they persist between sessions
- Use category filters to quickly find content by genre
- The search works across live channels, movies, and series simultaneously
