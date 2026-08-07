# 🎵 MusicFlow v2.5 — High-Performance Music Streaming Player

<p align="center">
  <strong>Stream, search, multitask, and focus with an Apple-style floating dynamic orb, PiP mini-player, and Pomodoro flow.</strong>
  <br />
  <em>Zero Database Required • Zero API Keys Required • Works on Windows, Mac, Linux, Android & iOS</em>
</p>

---

## 🚀 Instant Start (For New Users & ZIP Downloads)

Whether you downloaded the **ZIP from GitHub** or cloned via **Git**, here is how to start in under 1 minute:

### 1️⃣ Prerequisite: Install Node.js
If you don't already have Node.js installed, download the free **LTS version** from **[https://nodejs.org/](https://nodejs.org/)** and run the installer.

---

### 2️⃣ Launch MusicFlow

#### 🪟 On Windows PC:
Simply choose **ONE** of these 1-click methods:

- 🟢 **Method A (Easiest)**: Double-click **`start.bat`**  
  *Automatically checks Node.js, installs dependencies on first run, starts the server, and opens MusicFlow in your browser.*
- 🚀 **Method B (App Mode)**: Double-click **`MusicFlow.exe`**  
  *Ultra-lite desktop launcher (5.6 KB) that runs MusicFlow in a dedicated, distraction-free desktop window.*
- 🖥️ **Method C (Desktop Shortcut)**: Double-click **`create-desktop-shortcut.bat`**  
  *Creates or updates the MusicFlow shortcut icon directly on your Windows desktop.*

#### 🍏 On macOS / Linux:
1. Open Terminal in the project folder.
2. Run:
   ```bash
   chmod +x start.sh
   ./start.sh
   ```
3. MusicFlow installs any missing dependencies and opens in your browser at `http://localhost:3000`.

#### 💻 Standard Terminal / Developer Method:
```bash
npm install
npm start
```
Then visit **[http://localhost:3000](http://localhost:3000)**.

---

## ✨ What's New in v2.5

| Feature | Description |
| :--- | :--- |
| 🍏 **Apple Floating Transparent Orb** | Draggable translucent glass circle with real-time vinyl artwork spinning, soundwaves equalizer, and edge-snapping physics. Expands into an Apple Dynamic Island capsule for instant play/pause/skip and ⚡ **Instant Switch**. |
| 🖼️ **Always-On-Top PiP Mini-Player** | 60fps canvas-streamed Picture-in-Picture window that stays on top of VS Code, Word, Excel, and games while MusicFlow is minimized. |
| ⏱️ **Pomodoro Focus Flow** | Integrated 25m Focus / 50m Deep / 5m Break / 15m Rest countdown timer with interactive SVG progress ring and session tracking. |
| 🌧️ **Ambient Sound Mixer** | 100% offline Web Audio API atmospheric layers (Gentle Rain 🌧️, Cozy Cafe ☕, Ocean Waves 🌊, Soft White Noise 💨) with volume mixing. |
| ⚡ **Instant Switch** | 1-click button inside the floating orb to jump straight to the next recommended hit track. |
| 🌐 **MediaSession & Global Hotkeys** | Native Windows/Mac media keys, lockscreen playback status, and in-app single-key shortcuts. |
| ☁️ **1-Click Cloud Deployment** | Pre-configured `render.yaml`, `Dockerfile`, `railway.json`, and automated build-time binary downloader in `prepare-binaries.js`. |

---

## ⌨️ Global Keyboard Shortcuts

| Shortcut | Action |
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
| `Arrow Left / Right` | Seek 5 seconds backward / forward |
| `Arrow Up / Down` | Volume adjust up / down |

---

## 📱 How to Use on Your Phone / Tablet (Same Wi-Fi)

MusicFlow is a full **Progressive Web App (PWA)** with background audio playback, lock screen media controls, and offline caching.

1. Start MusicFlow on your computer.
2. In MusicFlow, click the **📱 Connect Phone** icon in the sidebar or top bar.
3. Your PC's Wi-Fi network address (e.g. `http://192.168.1.15:3000`) and a **live QR code** will appear.
4. Scan the QR code with your phone camera or type the address into **Chrome** (Android) or **Safari** (iPhone):
   - **Android (Chrome)**: Tap **⋮ Menu** &rarr; **"Add to Home Screen"** or **"Install App"**.
   - **iOS / iPhone (Safari)**: Tap **Share** &rarr; **"Add to Home Screen"**.
5. 🎉 **Done!** You now have MusicFlow installed as an app on your phone with background audio and media controls!

---

## ☁️ Cloud Deployment (Free 24/7 Hosting)

Deploy MusicFlow online with zero infrastructure costs:

- **Render.com (Recommended)**: Connect your GitHub repo; Render detects [`render.yaml`](render.yaml) and deploys automatically.
- **Railway.app**: Deploy with 1-click via [`railway.json`](railway.json) or [`Dockerfile`](Dockerfile).
- **Docker / VPS**: Run `docker build -t musicflow .` and `docker run -d -p 3000:3000 musicflow`.

See **[DEPLOY_GUIDE.md](DEPLOY_GUIDE.md)** for step-by-step instructions.

---

## 📁 Project Structure

```text
musicflow/
├── public/
│   ├── css/
│   │   └── style.css            # Glassmorphism design system, Orb & Focus styles
│   ├── js/
│   │   └── app.js               # Frontend player, Orb controller, PiP canvas & Pomodoro
│   ├── icons/                   # App icons for Desktop, PWA & Mobile
│   ├── manifest.json            # PWA Web App Manifest
│   └── index.html               # Main Single Page Application interface
├── server.js                    # High-performance Node.js Express backend & streaming engine
├── prepare-binaries.js          # Automated multi-platform binary downloader for cloud builds
├── render.yaml                  # Render.com 1-click cloud configuration
├── railway.json                 # Railway.app cloud deployment configuration
├── Dockerfile                   # Lightweight production Alpine Linux container
├── MusicFlow.exe                # C# .NET desktop launcher wrapper
├── MusicFlowLauncher.cs         # Source code for the desktop launcher
├── start.bat                    # Windows 1-click startup script
├── start.sh                     # macOS / Linux startup script
├── create-desktop-shortcut.bat  # Windows desktop shortcut creator
├── create-shortcut.ps1          # PowerShell shortcut generator
├── DEPLOY_GUIDE.md              # Cloud deployment guide
├── GETTING_STARTED.md           # User quick-start guide
└── package.json                 # Project dependencies and npm scripts
```

---

## 📄 License

Open-source under the **MIT License**. Created with ❤️ for music lovers.
