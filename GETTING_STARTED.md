# 🚀 Getting Started with MusicFlow v2.5

Welcome to **MusicFlow v2.5**! A premium, ultra-fast music player with an Apple-style floating transparent orb, always-on-top PiP mini-player, Pomodoro focus mode, ambient sound mixer, and 1-click cloud deployment.

---

## ✨ What's New in v2.5

| Feature | Description |
| :--- | :--- |
| 🍏 **Apple Floating Transparent Orb** | Draggable frosted-glass orb with live disc spin, soundwave equalizer, and expandable Dynamic Island capsule for instant play/pause/skip/seek. |
| 🖼️ **Always-On-Top PiP Mini-Player** | Pop out a floating mini-player that stays visible over VS Code, Word, Excel, or any other app while MusicFlow is minimized. |
| ⏱️ **Pomodoro Focus Flow** | Built-in 25/50/5/15 minute timer with SVG progress ring and session stats tracking. |
| 🌧️ **Ambient Sound Mixer** | Layer Rain, Cafe, Ocean Waves, or White Noise over your music using Web Audio API (100% offline). |
| ⚡ **Instant Switch** | 1-click button in the orb capsule to instantly jump to the next hit track. |
| 🌐 **MediaSession Integration** | Desktop notification bar and mobile lockscreen controls (play, pause, next, prev, seek). |
| ☁️ **Cloud Deploy Ready** | Render, Railway, Docker, and Vercel configs included. See `DEPLOY_GUIDE.md`. |

---

## ⚡ 1-Minute Quick Start (Windows PC)

### Step 1: Install Node.js (Only if you don't have it)
1. Download the free **LTS version** of Node.js from: **[https://nodejs.org/](https://nodejs.org/)**
2. Run the installer and click **Next** until finished.

---

### Step 2: Extract & Run MusicFlow
1. **Unzip** the downloaded MusicFlow folder anywhere on your computer (e.g. Desktop, Downloads, Documents).
2. Choose **ONE** of these ways to launch:

| Method | What to Double-Click | Best For |
| :--- | :--- | :--- |
| 🟢 **Method A (Recommended)** | **`start.bat`** | 1-Click universal launcher. Checks Node.js, installs dependencies on first run, and opens the app in your browser. |
| 🚀 **Method B (App Mode)** | **`MusicFlow.exe`** | Opens MusicFlow in a sleek desktop app window without browser tabs or address bars. |
| 🖥️ **Method C (Desktop Icon)** | **`create-desktop-shortcut.bat`** | Creates a **MusicFlow** icon directly on your Windows Desktop! |

> 💡 **First Run Note**: On the very first launch, the launcher will automatically install necessary packages (`npm install`) and fetch the background audio engine. This takes ~10-20 seconds. Future launches are instant!

---

## 🍏 macOS & Linux Quick Start

1. Install **Node.js** from [https://nodejs.org/](https://nodejs.org/) (or `brew install node`).
2. Open Terminal in the extracted `musicflow` folder.
3. Make the start script executable and run it:
   ```bash
   chmod +x start.sh
   ./start.sh
   ```
4. MusicFlow will install dependencies on first run and automatically open in your default browser at `http://localhost:3000`.

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
| :--- | :--- |
| `Space` | Play / Pause |
| `P` | Pop out / close Always-On-Top PiP Mini-Player |
| `Shift + P` | Previous Track |
| `N` | Next Track |
| `F` | Open Pomodoro Focus Mode |
| `M` | Mute / Unmute |
| `D` | Download current song as MP3 |
| `L` | Toggle Lyrics panel |
| `Q` | Toggle Queue sidebar |
| `Arrow Left / Right` | Seek 5 seconds backward / forward |
| `Arrow Up / Down` | Volume up / down |

---

## 🍏 Apple Floating Orb — How It Works

1. The translucent orb appears in the bottom-right corner of the screen by default.
2. **Drag** it anywhere — it snaps to the nearest edge when released.
3. **Click** the orb to expand it into a Dynamic Island-style capsule with:
   - Album artwork, title, and artist
   - Interactive seek progress bar
   - Play/Pause, Previous, Next buttons
   - ⚡ **Quick Switch** — instantly skip to a fresh track
   - **PiP Work Mini** — launch Always-On-Top mini-player
   - **Focus Mode** — open Pomodoro timer
4. Toggle visibility in **Settings > Apple Floating Transparent Orb**.

---

## 🖼️ PiP Mini-Player — Multitask Like a Pro

1. Click the **PiP button** (🖼️) in the top bar, now-playing bar, or floating orb capsule.
2. A small floating window pops out showing album art, live visualizer bars, track info, and progress.
3. This window stays on top of all other apps — keep it visible while you code, study, or work!
4. Press `P` to toggle it on/off instantly.

---

## ⏱️ Pomodoro Focus Flow

1. Press `F` or click the **Focus Flow** button to open the timer.
2. Choose a preset: **25m Focus**, **50m Deep**, **5m Break**, or **15m Break**.
3. Hit **Start Focus** to begin the countdown with a visual SVG ring.
4. Layer ambient sounds (Rain 🌧️, Cafe ☕, Waves 🌊, White Noise 💨) over your music.
5. Launch focus playlists instantly: Lo-Fi Study Beats, Deep Alpha Waves, Classical Piano, Synthwave Coding.

---

## 📱 How to Use on Your Phone / Tablet (Same Wi-Fi)

You can use MusicFlow on your iPhone, iPad, Android phone, or Smart TV connected to your home Wi-Fi:

1. Start MusicFlow on your computer.
2. In MusicFlow, click the **📱 Phone** icon in the sidebar or top bar.
3. A modal will pop up with your computer's local Wi-Fi address (e.g. `http://192.168.1.15:3000`) and a **QR code**.
4. **Scan the QR code** with your phone's camera:
   - **Android (Chrome)**: Tap **⋮ Menu** (top right) → **"Install app"** or **"Add to Home screen"**.
   - **iPhone (Safari)**: Tap the **Share** button → **"Add to Home Screen"**.
5. 🎉 You now have MusicFlow on your phone with background audio, lock screen media controls, and lyrics!

---

## ☁️ Deploy to the Cloud (Free, 24/7 Access)

See **[DEPLOY_GUIDE.md](DEPLOY_GUIDE.md)** for step-by-step instructions to deploy MusicFlow on:
- **Render.com** (Recommended, free tier)
- **Railway.app**
- **Docker / Fly.io / DigitalOcean**

---

## 🛠️ Advanced: Running via Terminal

If you prefer standard npm commands:

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start
```

Then open **[http://localhost:3000](http://localhost:3000)** in any modern web browser.

---

## ❓ Frequently Asked Questions & Troubleshooting

<details>
<summary><strong>1. "Node.js is not recognized as an internal or external command"</strong></summary>

- Make sure you downloaded and installed Node.js from [nodejs.org](https://nodejs.org/).
- If you just installed Node.js, close and re-open your terminal or restart your computer so Windows updates your system PATH.
</details>

<details>
<summary><strong>2. "Port 3000 is already in use"</strong></summary>

- You can specify a custom port by setting the `PORT` environment variable before starting:
  - **Windows (Command Prompt)**: `set PORT=3001 && node server.js`
  - **Windows (PowerShell)**: `$env:PORT=3001; node server.js`
  - **Mac / Linux**: `PORT=3001 ./start.sh`
</details>

<details>
<summary><strong>3. Phone cannot connect to the PC's Wi-Fi link</strong></summary>

- Ensure both your PC and phone are connected to the **same Wi-Fi router**.
- If Windows Firewall blocks incoming connections, allow Node.js through Windows Defender Firewall (Private Networks).
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

---

Enjoy streaming your music with MusicFlow v2.5! 🎧✨
