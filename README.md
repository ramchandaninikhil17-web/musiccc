# 🎵 MusicFlow v3.0 — High-Performance Cloud Music Player

<p align="center">
  <strong>Stream, search, multitask, and focus with an Apple-style floating dynamic orb, PiP mini-player, and Pomodoro flow.</strong>
  <br />
  <em>Zero Database • Zero API Keys • Works on Windows, Mac, Linux, Android & iOS</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen?style=flat-square&logo=node.js" alt="Node.js" />
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License" />
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Android%20%7C%20iOS-blueviolet?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/deploy-Render%20%7C%20Railway%20%7C%20Docker-orange?style=flat-square" alt="Deploy" />
</p>

---

## 📖 Table of Contents

1. [Features](#-features)
2. [Quick Start (Local)](#-quick-start-local)
3. [Keyboard Shortcuts](#-keyboard-shortcuts)
4. [Features Deep Dive](#-features-deep-dive)
5. [Cloud Deployment (Free 24/7 Hosting)](#-cloud-deployment-free-247-hosting)
6. [Android & Mobile Install](#-android--mobile-install)
7. [Docker](#-docker)
8. [Project Structure](#-project-structure)
9. [Environment Variables](#-environment-variables)
10. [FAQ & Troubleshooting](#-faq--troubleshooting)
11. [License](#-license)

---

## ✨ Features

| Feature | Description |
| :--- | :--- |
| 🍏 **Apple Floating Transparent Orb** | Draggable translucent glass circle with real-time vinyl artwork spinning, soundwaves equalizer, and edge-snapping physics. Expands into an Apple Dynamic Island capsule for instant play/pause/skip and ⚡ **Instant Switch**. |
| 🖼️ **Always-On-Top PiP Mini-Player** | 60fps canvas-streamed Picture-in-Picture window that stays on top of VS Code, Word, Excel, and games while MusicFlow is minimized. |
| 🎛️ **10-Band Graphic Equalizer** | Web Audio DSP with 10 frequency sliders, Bass Boost dial, 3D Spatial Audio expander, and instant genre presets (*Rock, Pop, EDM, Vocal, Acoustic*). |
| 📁 **Local Music Drag & Drop** | Import and play local `.mp3`, `.flac`, `.wav`, `.m4a` files directly in high fidelity. |
| ⏱️ **Pomodoro Focus Flow** | Integrated 25m Focus / 50m Deep / 5m Break / 15m Rest countdown timer with interactive SVG progress ring and session tracking. |
| 🌧️ **Ambient Sound Mixer** | 100% offline Web Audio API atmospheric layers (Gentle Rain 🌧️, Cozy Cafe ☕, Ocean Waves 🌊, Soft White Noise 💨) with volume mixing. |
| ⏲️ **Smart Sleep Timer** | Set 15m, 30m, 45m, 60m, or "Track End" timers with an automatic 30-second volume fade out. |
| 🎨 **Accent Color Studio & OLED Mode** | Switch accent highlights (*Indigo, Cyan, Emerald, Orange, Pink, Purple*) and OLED Pitch Black mode. |
| ♾️ **Endless Auto-Queue** | Intelligent auto-queue that automatically loads matching recommendation tracks when your queue ends. |
| ⚡ **Instant Switch** | 1-click button inside the floating orb to jump straight to the next recommended hit track. |
| 🌐 **MediaSession & Global Hotkeys** | Native Windows/Mac media keys, lockscreen playback status, and in-app single-key shortcuts. |
| ☁️ **1-Click Cloud Deployment** | Pre-configured `render.yaml`, `Dockerfile`, `railway.json`, and automated build-time binary downloader. |

---

## 🚀 Quick Start (Local)

### Prerequisites

- **Node.js v18+** — Download the free LTS version from **[https://nodejs.org/](https://nodejs.org/)**

---

### 🪟 Windows

Choose **ONE** of these 1-click methods:

| Method | What to Double-Click | Description |
| :--- | :--- | :--- |
| 🟢 **A (Recommended)** | **`start.bat`** | Checks Node.js, installs dependencies on first run, starts the server, and opens MusicFlow in your browser. |
| 🚀 **B (App Mode)** | **`MusicFlow.exe`** | Ultra-lite desktop launcher that runs MusicFlow in a dedicated, distraction-free desktop window. |
| 🖥️ **C (Desktop Shortcut)** | **`create-desktop-shortcut.bat`** | Creates or updates the MusicFlow shortcut icon on your Windows desktop. |

> 💡 **First Run**: On the very first launch, the launcher will automatically install necessary packages (`npm install`) and fetch the background audio engine. This takes ~10–20 seconds. Future launches are instant!

---

### 🍏 macOS / Linux

1. Open Terminal in the project folder.
2. Run:
   ```bash
   chmod +x start.sh
   ./start.sh
   ```
3. MusicFlow installs any missing dependencies and opens in your browser at `http://localhost:3000`.

---

### 💻 Standard Terminal / Developer Method

```bash
# 1. Clone the repository
git clone https://github.com/ramchandaninikhil17-web/musiccc.git
cd musiccc

# 2. Install dependencies
npm install

# 3. Start the server
npm start
```

Then visit **[http://localhost:3000](http://localhost:3000)** in any modern browser.

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
| :--- | :--- |
| `Space` | Play / Pause |
| `P` | Toggle Always-On-Top PiP Mini-Player |
| `Shift + P` | Previous Track |
| `N` | Next Track |
| `F` | Open Pomodoro Focus & Ambient Mixer |
| `M` | Mute / Unmute |
| `D` | Download MP3 of current track |
| `L` | Toggle Synchronized Lyrics Panel |
| `Q` | Toggle Up Next Queue |
| `←` / `→` | Seek 5 seconds backward / forward |
| `↑` / `↓` | Volume up / down |

---

## 🔍 Features Deep Dive

### 🍏 Apple Floating Orb

1. The translucent orb appears in the bottom-right corner by default.
2. **Drag** it anywhere — it snaps to the nearest edge when released.
3. **Click** the orb to expand into a Dynamic Island-style capsule with:
   - Album artwork, title, and artist
   - Interactive seek progress bar
   - Play/Pause, Previous, Next buttons
   - ⚡ **Quick Switch** — instantly skip to a fresh track
   - **PiP Work Mini** — launch the Always-On-Top mini-player
   - **Focus Mode** — open the Pomodoro timer
4. Toggle visibility in **Settings > Apple Floating Transparent Orb**.

### 🖼️ PiP Mini-Player — Multitask Like a Pro

1. Click the **PiP button** (🖼️) in the top bar, now-playing bar, or floating orb capsule.
2. A small floating window pops out showing album art, live visualizer bars, track info, and progress.
3. This window stays **on top of all other apps** — keep it visible while you code, study, or work!
4. Press `P` to toggle it on/off instantly.

### ⏱️ Pomodoro Focus Flow

1. Press `F` or click the **Focus Flow** button.
2. Choose a preset: **25m Focus**, **50m Deep**, **5m Break**, or **15m Break**.
3. Hit **Start Focus** to begin the countdown with a visual SVG ring.
4. Layer ambient sounds (Rain 🌧️, Cafe ☕, Waves 🌊, White Noise 💨) over your music.
5. Launch focus playlists instantly: Lo-Fi Study Beats, Deep Alpha Waves, Classical Piano, Synthwave Coding.

### 🎛️ 10-Band Graphic Equalizer

- Access via the EQ button in the player controls.
- 10 frequency sliders from 31 Hz to 16 kHz.
- Bass Boost dial and 3D Spatial Audio expander.
- One-click presets: Rock, Pop, EDM, Vocal, Acoustic, Flat.

---

## ☁️ Cloud Deployment (Free 24/7 Hosting)

### ⚠️ Important: Why Vercel / Netlify Do NOT Work

- **Vercel / Netlify** are *serverless static platforms*. They shut down requests after a few seconds and do **not** support Python, `ffmpeg`, or `yt-dlp`.
- **MusicFlow** requires a persistent background engine to extract and stream music live.
- ✅ **Solution:** Use **Render** or **Railway** with the included **`Dockerfile`** which bundles Node.js, Python 3, `ffmpeg`, and `yt-dlp` in a secure container.

---

### 🟢 Option 1: Deploy on Render (Recommended)

1. **Push your project to GitHub** (if you haven't already):
   ```bash
   git add .
   git commit -m "Deploy MusicFlow v3.0"
   git push origin main
   ```
2. Go to **[https://render.com](https://render.com)** and sign in with GitHub.
3. Click **"New +"** (top right) → **"Web Service"**.
4. Select **"Build and deploy from a Git repository"** and choose your `musiccc` repo.
5. Configure these settings:
   - **Name:** `musicflow-app` (or any name you like)
   - **Runtime:** Select **`Docker`** *(automatically uses the pre-configured Dockerfile)*
   - **Instance Type:** `Free`
6. Click **"Deploy Web Service"**.
7. Wait ~2 minutes for the build to finish.
8. 🎉 Your app is now live at: `https://musicflow-app.onrender.com`

> The repo includes a [`render.yaml`](render.yaml) file — Render can auto-detect this for Blueprint deploys.

---

### 🚂 Option 2: Deploy on Railway

1. Go to **[https://railway.app](https://railway.app)** and sign in with GitHub.
2. Click **"New Project"** → **"Deploy from GitHub repo"**.
3. Select your `musiccc` repo.
4. Railway auto-detects the [`railway.json`](railway.json) and [`Dockerfile`](Dockerfile).
5. 🎉 Your app is deployed and live!

---

### 🐳 Option 3: Docker (Self-Hosted / VPS)

```bash
# Build the image
docker build -t musicflow .

# Run the container
docker run -d -p 3000:3000 --name musicflow musicflow
```

Then visit `http://your-server-ip:3000`.

---

## 📱 Android & Mobile Install

Once your app is live on a cloud URL (e.g., `https://musicflow-app.onrender.com`):

### Method A: PWABuilder — Generate a Real `.apk`

1. Open **[https://www.pwabuilder.com](https://www.pwabuilder.com)**.
2. Paste your live Render/Railway URL.
3. Click **"Start"** — PWABuilder checks your PWA score.
4. Click **"Package for Android"** → **"Generate"**.
5. Download the **`MusicFlow.apk`** file.
6. Transfer the `.apk` to your Android phone and tap **Install**.

### Method B: Instant Install from Chrome (No APK needed)

1. On your **Android phone**, open **Google Chrome**.
2. Visit your cloud URL: `https://musicflow-app.onrender.com`
3. Tap the **⋮ menu** (top right) → **"Install app"** (or **"Add to Home screen"**).
4. Android installs a native **WebAPK** with:
   - ✅ Real app icon in your App Drawer & Home Screen
   - ✅ Fullscreen standalone interface (no browser address bar)
   - ✅ Lock screen playback controls (MediaSession API)
   - ✅ Background playback when screen is locked

### iOS (iPhone / iPad)

1. Open **Safari** on your iPhone/iPad.
2. Visit your cloud URL.
3. Tap the **Share button** (📤) → **"Add to Home Screen"**.
4. MusicFlow now runs as a standalone app on iOS.

---

## 📁 Project Structure

```text
musiccc/
├── public/
│   ├── css/
│   │   └── style.css                # Glassmorphism design system, Orb & Focus styles
│   ├── js/
│   │   └── app.js                   # Frontend player, Orb controller, PiP canvas & Pomodoro
│   ├── icons/                       # App icons for Desktop, PWA & Mobile
│   ├── manifest.json                # PWA Web App Manifest
│   └── index.html                   # Main Single Page Application interface
├── data/
│   └── userData.json                # Persistent user preferences & playlists
├── lib/                             # Library utilities
├── server.js                        # High-performance Node.js Express backend & streaming engine
├── prepare-binaries.js              # Automated multi-platform binary downloader for cloud builds
├── Dockerfile                       # Lightweight production container (Node 20 + Python 3 + ffmpeg)
├── render.yaml                      # Render.com 1-click cloud configuration
├── railway.json                     # Railway.app cloud deployment configuration
├── vercel.json                      # Vercel config (limited — see deployment notes above)
├── Procfile                         # Heroku/Railway process file
├── MusicFlow.exe                    # C# .NET desktop launcher wrapper (Windows)
├── MusicFlowLauncher.cs             # Source code for the desktop launcher
├── start.bat                        # Windows 1-click startup script
├── start.sh                         # macOS / Linux startup script
├── create-desktop-shortcut.bat      # Windows desktop shortcut creator
├── create-shortcut.ps1              # PowerShell shortcut generator
├── package.json                     # Project dependencies and npm scripts
└── package-lock.json                # Locked dependency tree
```

---

## ⚙️ Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | Port the server listens on |
| `HOST` | `0.0.0.0` | Host address to bind to |
| `NODE_ENV` | `development` | Set to `production` for cloud deploys |

**Set a custom port:**

```bash
# Windows (PowerShell)
$env:PORT=3001; node server.js

# Windows (CMD)
set PORT=3001 && node server.js

# macOS / Linux
PORT=3001 ./start.sh
```

---

## ❓ FAQ & Troubleshooting

<details>
<summary><strong>1. "Node.js is not recognized as an internal or external command"</strong></summary>

- Download and install Node.js from [nodejs.org](https://nodejs.org/).
- If you just installed it, **close and re-open your terminal** or restart your computer so Windows updates the system PATH.
</details>

<details>
<summary><strong>2. "Port 3000 is already in use"</strong></summary>

- Set a custom port using environment variables (see section above).
- Or kill the process using port 3000:
  - **Windows**: `netstat -ano | findstr :3000` then `taskkill /PID <PID> /F`
  - **Mac/Linux**: `lsof -ti:3000 | xargs kill -9`
</details>

<details>
<summary><strong>3. Phone cannot connect to the PC's Wi-Fi link</strong></summary>

- Ensure both your PC and phone are connected to the **same Wi-Fi network**.
- If Windows Firewall blocks incoming connections, allow Node.js through Windows Defender Firewall (Private Networks).
- Find your PC's local IP with `ipconfig` (Windows) or `ifconfig` (Mac/Linux), then visit `http://<YOUR_IP>:3000` on your phone.
</details>

<details>
<summary><strong>4. PiP Mini-Player doesn't open</strong></summary>

- Picture-in-Picture requires **Chrome 70+**, **Edge 79+**, or **Opera**. Firefox has limited support.
- Make sure no other PiP window is active. Close it first, then try again.
- Some browser privacy extensions block PiP — try disabling them temporarily.
</details>

<details>
<summary><strong>5. Floating Orb is not visible</strong></summary>

- Open **Settings** (gear icon in sidebar) and ensure **"Apple Floating Transparent Orb"** is set to **"Enabled (Floating)"**.
</details>

<details>
<summary><strong>6. Git error: "Unable to create index.lock"</strong></summary>

- A previous git process crashed and left a stale lock file. Remove it:
  ```bash
  # Windows (PowerShell)
  Remove-Item -Force .git/index.lock

  # macOS / Linux
  rm -f .git/index.lock
  ```
- Then retry your git command.
</details>

<details>
<summary><strong>7. Cloud deploy fails or music doesn't stream</strong></summary>

- Make sure you're deploying with **Docker runtime** (not Node.js or static site).
- The Dockerfile installs Python 3, `ffmpeg`, and `yt-dlp` — required for music streaming.
- Check your cloud platform's build logs for errors.
</details>

---

## 🛠️ Tech Stack

| Layer | Technology |
| :--- | :--- |
| **Backend** | Node.js 20, Express.js |
| **Frontend** | Vanilla HTML5, CSS3, JavaScript (ES6+) |
| **Audio Engine** | yt-dlp, ffmpeg, Web Audio API |
| **Typography** | Google Fonts (Inter) |
| **Design** | Glassmorphism, CSS animations, dark theme |
| **Containerization** | Docker (Node 20 Slim + Python 3 + ffmpeg) |
| **Cloud** | Render.com, Railway.app |

---

## 📄 License

Open-source under the **MIT License**. Created with ❤️ for music lovers.

---

<p align="center">
  <strong>🎧 Enjoy streaming your music with MusicFlow!</strong>
</p>
