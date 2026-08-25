# Getting Started

This guide walks you through your first session with MusicFlow — from installation to playing your first track. For deployment and building native apps, see [DEPLOY_GUIDE.md](DEPLOY_GUIDE.md) and [BUILD_APPS.md](BUILD_APPS.md).

---

## 1. Install Node.js

MusicFlow requires **Node.js 18 or later**. Download the LTS version from [nodejs.org](https://nodejs.org/) and run the installer.

To verify the installation, open a terminal and run:

```bash
node --version
```

You should see `v18.x.x` or higher.

---

## 2. Launch MusicFlow

### Windows

The fastest way is to double-click **`start.bat`** in the project folder. It will:

1. Check that Node.js is installed.
2. Run `npm install` on first launch (takes ~10–20 seconds).
3. Start the server and open MusicFlow in your browser.

Alternatively, double-click **`MusicFlow.exe`** to run MusicFlow in a dedicated app window without browser tabs or an address bar.

### macOS / Linux

```bash
cd musiccc
chmod +x start.sh
./start.sh
```

The script installs dependencies on first run and opens your browser automatically.

### Any platform (manual)

```bash
cd musiccc
npm install
npm start
```

Open **http://localhost:3000** in any modern browser.

> **First-run note:** The server downloads the `yt-dlp` binary automatically if it's missing. This adds ~10–20 seconds to the first start.

---

## 3. Find and Play Music

1. Click **Search** in the sidebar (or press any alphanumeric key while not focused on an input).
2. Type a song name, artist, or phrase.
3. Click a result to start playing. The track loads in the bottom player bar.

Search results are ranked by an internal scoring algorithm that prefers official uploads from major labels and topic channels.

---

## 4. Explore the Interface

### Sidebar navigation

| Page | What's there |
|:---|:---|
| **Home** | Trending recommendations and quick-play cards |
| **Search** | Full-text search with autocomplete suggestions |
| **Library** | Your playlists, liked songs, and recently played |
| **Mood Flow** | Pick a mood and energy level — the server builds a mix of matching tracks |
| **Your Stats** | Listening history, play counts, and top artists |
| **Focus Flow** | Pomodoro timer, ambient sound mixer, and focus playlists |
| **Settings** | Accent colour, OLED mode, floating orb toggle, crossfade, and more |

### Player controls

The bottom bar shows the current track with play/pause, skip, seek, volume, and a progress scrubber. Additional buttons open:

- **Equalizer** — 10-band graphic EQ with presets (Rock, Pop, EDM, Vocal, Acoustic, Flat)
- **Lyrics** — synced lyrics panel (when subtitle data is available)
- **Queue** — drag-to-reorder Up Next list
- **Download** — save the current track as an MP3
- **PiP** — pop out a floating mini-player that stays on top of other windows

---

## 5. The Floating Orb

A translucent glass circle appears in the bottom-right corner. You can:

- **Drag** it anywhere — it snaps to the nearest screen edge when released.
- **Click** it to expand into a capsule showing artwork, title, seek bar, and playback controls.
- **Quick Switch** — skip to the next recommended track.
- Toggle it in Settings → "Apple Floating Transparent Orb".

---

## 6. PiP Mini-Player

Click the PiP button (in the top bar, player bar, or orb capsule) or press `P`. A small window pops out that stays on top of every other app — useful while coding, studying, or working. The window shows album art, a visualiser, track info, and a progress bar.

Supported browsers: Chrome 70+, Edge 79+, Opera. Firefox has limited support.

---

## 7. Focus Flow (Pomodoro + Ambient)

Press `F` or click Focus Flow in the sidebar.

1. Pick a timer preset: **25 min Focus**, **50 min Deep**, **5 min Break**, or **15 min Rest**.
2. Click **Start Focus**. An SVG ring animates the countdown.
3. Layer ambient sounds over your music: Rain, Café, Ocean Waves, White Noise. Each has its own volume slider.
4. Optionally start a focus playlist: Lo-Fi Study Beats, Deep Alpha Waves, Classical Piano, or Synthwave Coding.

---

## 8. Local File Playback

Drag `.mp3`, `.flac`, `.wav`, or `.m4a` files directly onto the MusicFlow window. They play in full quality through the browser's audio decoder — no server round-trip needed.

---

## 9. Keyboard Shortcuts

| Key | Action |
|:---|:---|
| `Space` | Play / pause |
| `N` | Next track |
| `Shift + P` | Previous track |
| `P` | Toggle PiP mini-player |
| `F` | Open focus flow |
| `M` | Mute / unmute |
| `D` | Download current track |
| `L` | Toggle lyrics |
| `Q` | Toggle queue |
| `← / →` | Seek ±5 s |
| `↑ / ↓` | Volume ±step |

---

## 10. Access from Your Phone

If your phone is on the same Wi-Fi network as your PC:

1. Find your PC's local IP: `ipconfig` (Windows) or `ip addr` (Linux/macOS).
2. On your phone's browser, go to `http://<YOUR_IP>:3000`.
3. MusicFlow works in any mobile browser. For an app-like experience, tap the browser menu → "Install app" or "Add to Home Screen".

If Windows Firewall blocks the connection, allow Node.js through Defender Firewall for private networks.

---

## Next Steps

- **Deploy to the cloud** — see [DEPLOY_GUIDE.md](DEPLOY_GUIDE.md)
- **Build native apps** — see [BUILD_APPS.md](BUILD_APPS.md)
- **Explore the API** — see [API.md](API.md)
- **Contribute** — see [CONTRIBUTING.md](CONTRIBUTING.md)
