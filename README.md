# 🎵 MusicFlow — High-Performance Music Streaming Player

<p align="center">
  <strong>Stream, search, batch-import, and download high-quality music across any device with zero setup.</strong>
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
  *Creates a MusicFlow shortcut icon directly on your Windows desktop.*

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

## 📱 How to Use on Your Phone / Tablet (Same Wi-Fi)

MusicFlow is a full **Progressive Web App (PWA)** with background audio playback, lock screen media controls, and offline caching.

1. Start MusicFlow on your computer.
2. In MusicFlow, click the **📱 Phone** icon in the sidebar / top bar.
3. Your PC's Wi-Fi network address (e.g. `http://192.168.1.15:3000`) and a **live QR code** will appear.
4. Scan the QR code with your phone camera or type the address into **Chrome** (Android) or **Safari** (iPhone):
   - **Android (Chrome)**: Tap **⋮ Menu** &rarr; **"Add to Home Screen"** or **"Install App"**.
   - **iOS / iPhone (Safari)**: Tap **Share** &rarr; **"Add to Home Screen"**.
5. 🎉 **Done!** You now have MusicFlow installed as an app on your phone with background audio and media controls!

---

## ✨ Key Features

- 📜 **Smart Batch Text Song Importer**:
  - Add multiple songs to playlists using raw text strings, space-separated song names, line breaks, or comma-separated lists.
  - Interactive tokenized chip editor to preview, edit, and refine detected terms before importing.

- 🏆 **Official Release Prioritization Engine**:
  - Intelligent scoring engine prioritizing official record labels (**T-Series**, **Sony Music**, **YRF**, **Zee Music**, **Saregama**, **The Weeknd**, etc.).
  - Filters out amateur covers, ringtones, and pitch-shifted edits.

- 📻 **Personalized Home Recommendations & Radio**:
  - Dynamically builds personalized music mixes based on your liked songs and listening history.
  - 1-click **Personalized Radio Mix** for continuous playback matching your musical taste.

- ⚡ **Database-Free & Auto-Setup**:
  - Automatically manages background stream dependencies (`yt-dlp` auto-installer).
  - Uses `localStorage` and optional local JSON sync for zero-database persistence.
  - In-memory LRU/TTL caching for fast search responses.

- 📥 **Direct MP3 Audio Downloader**:
  - Integrated high-speed MP3 audio download endpoint for offline listening.

- 🎨 **Modern Dark Glassmorphism Design**:
  - Sleek visual aesthetics, smooth animations, dark/light themes, dynamic synchronized lyrics, and responsive layouts for desktop and mobile.

---

## 📁 Project Structure

```text
musicflow/
├── public/
│   ├── css/
│   │   └── style.css            # Glassmorphism design system & UI styles
│   ├── js/
│   │   └── app.js               # Frontend SPA player logic & state management
│   ├── icons/                   # App icons for Desktop, PWA & Mobile
│   ├── index.html               # Main application interface
│   ├── manifest.json            # Web App Manifest for PWA installation
│   └── sw.js                    # Service Worker for offline audio caching
├── server.js                    # Express backend, auto-downloader & streaming API
├── MusicFlow.exe                # Native Windows desktop app launcher
├── MusicFlowLauncher.cs         # C# source code for the Windows launcher
├── start.bat                    # 1-Click Windows startup script (auto-checks dependencies)
├── start.sh                     # 1-Click macOS/Linux startup script
├── create-shortcut.ps1          # PowerShell shortcut generator
├── create-desktop-shortcut.bat  # 1-Click desktop icon creator
├── capacitor.config.json        # Capacitor configuration for mobile builds
├── android/                     # Pre-configured native Android Studio project
├── GETTING_STARTED.md           # Step-by-step beginner guide
├── BUILD_APPS.md                # Mobile APK & native apps build guide
├── package.json                 # Dependencies and scripts
└── README.md                    # Project documentation
```

---

## 🛠️ Tech Stack

- **Backend**: Node.js, Express.js, `yt-dlp`
- **Frontend**: Vanilla Modern JavaScript (ES6+), HTML5 Semantic Elements, Custom Glassmorphism CSS3
- **Mobile / Desktop**: PWA (Service Workers + Web App Manifest), Capacitor (Android Native), Edge App Mode (Windows)
- **Storage**: Client `localStorage` with server-side JSON backup (No external database required)

---

## 📖 Additional Guides

- 📘 **[GETTING_STARTED.md](GETTING_STARTED.md)** — Step-by-step guide for first-time users.
- 📱 **[BUILD_APPS.md](BUILD_APPS.md)** — Guide on building native Android APKs and cross-device setups.

---

## 📄 License

This project is open source and available under the [MIT License](LICENSE).
