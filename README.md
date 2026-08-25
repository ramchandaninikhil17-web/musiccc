# MusicFlow

A self-hosted music player built with Node.js and vanilla HTML/CSS/JS. Streams audio through a `yt-dlp` + `ffmpeg` backend, runs as a PWA, and ships with a native Android app and a Windows desktop launcher.

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen?style=flat-square&logo=node.js" alt="Node.js" />
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License" />
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Android-blueviolet?style=flat-square" alt="Platform" />
</p>

---

## Features

| Category | What it does |
|:---|:---|
| **Search & stream** | Full-text search, smart match ranking (prefers official uploads), recommendations, mood-based mixes |
| **Playback** | Gapless queue, crossfade, shuffle, repeat, endless auto-queue that loads related tracks when the queue runs out |
| **Equalizer** | 10-band graphic EQ (31 Hz–16 kHz), bass boost, 3D spatial audio, genre presets |
| **Floating orb** | Draggable translucent control orb with live artwork, edge-snapping physics, and a Dynamic Island–style expanded capsule |
| **PiP mini-player** | Canvas-rendered Picture-in-Picture window that stays on top of other apps |
| **Focus flow** | Pomodoro timer (25 m / 50 m / 5 m / 15 m) with SVG progress ring, session tracking, and focus playlists |
| **Ambient mixer** | Procedural rain, café, ocean, and white noise layers — 100 % offline via Web Audio API |
| **Sleep timer** | 15 / 30 / 45 / 60 min or "end of track" with a 30-second volume fade |
| **Downloads** | Single-track MP3 or full playlist as a ZIP archive (async job with progress polling) |
| **Lyrics** | Synced lyrics from subtitle tracks when available |
| **Local files** | Drag-and-drop `.mp3`, `.flac`, `.wav`, `.m4a` playback |
| **Theming** | Six accent colours, OLED pitch-black mode |
| **Keyboard & media keys** | Single-key shortcuts in-app; MediaSession API for OS-level lockscreen controls |
| **Deployment** | Pre-configured Dockerfile, `render.yaml`, `railway.json` — one-click cloud deploy on Render or Railway |
| **Android app** | Native Kotlin/WebView shell with on-device NewPipeExtractor — no server needed on the phone |
| **Windows launcher** | Compiled C# `.exe` that starts the Node server and opens a dedicated app window |

---

## Quick Start

### Prerequisites

- **Node.js 18+** — [https://nodejs.org](https://nodejs.org/)

### Windows

Pick one:

| Method | Double-click | What it does |
|:---|:---|:---|
| **A** (recommended) | `start.bat` | Checks Node.js, runs `npm install` on first launch, starts the server, opens the browser |
| **B** (app mode) | `MusicFlow.exe` | Starts the server and opens MusicFlow in a standalone window (no browser chrome) |
| **C** (shortcut) | `create-desktop-shortcut.bat` | Creates a desktop shortcut that launches MusicFlow.exe |

### macOS / Linux

```bash
chmod +x start.sh
./start.sh
```

### Terminal / npm

```bash
git clone https://github.com/ramchandaninikhil17-web/musiccc.git
cd musiccc
npm install
npm start
```

Then open **http://localhost:3000**.

> On first launch, the server downloads the `yt-dlp` binary automatically. This takes 10–20 seconds; subsequent starts are instant.

---

## Keyboard Shortcuts

| Key | Action |
|:---|:---|
| `Space` | Play / pause |
| `N` | Next track |
| `Shift + P` | Previous track |
| `P` | Toggle PiP mini-player |
| `F` | Open focus flow (Pomodoro + ambient mixer) |
| `M` | Mute / unmute |
| `D` | Download current track as MP3 |
| `L` | Toggle lyrics panel |
| `Q` | Toggle queue sidebar |
| `← / →` | Seek ±5 seconds |
| `↑ / ↓` | Volume up / down |

---

## Project Structure

```text
musiccc/
├── server.js                    # Express backend — streaming, search, download, user data
├── prepare-binaries.js          # Build-time yt-dlp downloader for cloud deploys
├── public/
│   ├── index.html               # Single-page application shell
│   ├── css/style.css            # Glassmorphism design system
│   ├── js/app.js                # Frontend player, orb, PiP, Pomodoro, EQ
│   ├── icons/                   # PWA icons (192 px, 512 px, .ico)
│   ├── manifest.json            # Web App Manifest
│   └── sw.js                    # Service worker (offline caching)
├── lib/
│   └── zip.js                   # Dependency-free stored-mode ZIP writer
├── data/
│   ├── userData.json             # Persistent playlists, history, preferences
│   └── runtime.json              # Port/PID written at startup (used by the .exe launcher)
├── mobile/
│   └── android/                  # Native Android app (Kotlin, WebView, NewPipeExtractor)
├── test/
│   ├── run-all.sh                # Test runner — all suites, no network needed
│   ├── *.test.js                 # Unit and integration tests (Node assert, no framework)
│   └── fixtures/                 # Stubbed yt-dlp for offline testing
├── MusicFlowLauncher.cs          # C# source for MusicFlow.exe
├── Dockerfile                    # Production image (Node 20 + Python 3 + ffmpeg + yt-dlp)
├── render.yaml                   # Render.com Blueprint
├── railway.json                  # Railway deploy config
├── Procfile                      # Heroku/Railway process file
├── start.bat                     # Windows launcher script
├── start.sh                      # macOS/Linux launcher script
├── create-desktop-shortcut.bat   # Windows shortcut creator
└── package.json                  # Dependencies: express, cors, ffmpeg-static
```

---

## Environment Variables

| Variable | Default | Description |
|:---|:---|:---|
| `PORT` | `3000` | Port the server listens on |
| `HOST` | `0.0.0.0` | Bind address |
| `NODE_ENV` | `development` | Set to `production` in cloud deploys |

```bash
# Custom port examples
PORT=3001 node server.js               # macOS / Linux
$env:PORT=3001; node server.js         # PowerShell
set PORT=3001 && node server.js        # CMD
```

---

## Deployment

MusicFlow needs a persistent server with access to `yt-dlp` and `ffmpeg`. Static hosts (Vercel, Netlify, GitHub Pages) will not work.

See **[DEPLOY_GUIDE.md](DEPLOY_GUIDE.md)** for step-by-step instructions covering:

- **Render** (recommended free tier, uses the included `render.yaml`)
- **Railway** (auto-detects `railway.json` and `Dockerfile`)
- **Docker** (self-hosted / VPS)

---

## Building Desktop & Mobile Apps

See **[BUILD_APPS.md](BUILD_APPS.md)** for:

- Building the native **Android APK** from the `mobile/android/` Gradle project
- Compiling the **Windows desktop launcher** from `MusicFlowLauncher.cs`
- Installing MusicFlow as a **PWA** on Android, iOS, or desktop Chrome

---

## API Reference

The backend exposes a JSON REST API on the same port as the web UI. Full endpoint documentation is in **[API.md](API.md)**.

---

## Contributing

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for development setup, running tests, and code style.

---

## Troubleshooting

<details>
<summary><strong>"Node.js is not recognized"</strong></summary>

Install Node.js from [nodejs.org](https://nodejs.org/). If you just installed it, restart your terminal so the PATH updates.
</details>

<details>
<summary><strong>"Port 3000 is already in use"</strong></summary>

Set a different port with `PORT=3001 node server.js`, or kill the process on 3000:

- **Windows:** `netstat -ano | findstr :3000` then `taskkill /PID <PID> /F`
- **macOS/Linux:** `lsof -ti:3000 | xargs kill -9`
</details>

<details>
<summary><strong>Phone can't reach the PC</strong></summary>

Both devices must be on the same Wi-Fi network. Find your PC's local IP with `ipconfig` (Windows) or `ip addr` (Linux), then visit `http://<YOUR_IP>:3000` on the phone. You may need to allow Node.js through Windows Firewall.
</details>

<details>
<summary><strong>PiP mini-player won't open</strong></summary>

PiP requires Chrome 70+, Edge 79+, or Opera. Close any existing PiP window first. Some privacy extensions block PiP — try disabling them.
</details>

<details>
<summary><strong>Floating orb not visible</strong></summary>

Open Settings (gear icon) and set "Apple Floating Transparent Orb" to "Enabled (Floating)".
</details>

<details>
<summary><strong>Git error: "Unable to create index.lock"</strong></summary>

A stale lock file from a crashed git process. Remove it:

```bash
rm -f .git/index.lock          # macOS / Linux
Remove-Item -Force .git/index.lock   # PowerShell
```
</details>

<details>
<summary><strong>Cloud deploy fails / music won't stream</strong></summary>

Make sure you're using the **Docker** runtime (not "Node.js" or "Static"). The Dockerfile installs Python 3, ffmpeg, and yt-dlp — all three are required. Check your platform's build logs for errors.
</details>

---

## Tech Stack

| Layer | Technology |
|:---|:---|
| Backend | Node.js 18+, Express |
| Frontend | Vanilla HTML5, CSS3, JavaScript (ES6+) |
| Audio pipeline | yt-dlp, ffmpeg, Web Audio API |
| Mobile | Kotlin, WebView, NewPipeExtractor, NanoHTTPd |
| Desktop launcher | C# (.NET Framework) |
| Typography | Inter (Google Fonts) |
| Container | Docker (node:20-slim + Python 3 + ffmpeg) |

---

## License

MIT
