# 🎵 MusicFlow — 120FPS Zero-Latency Cloud Music Player

<p align="center">
  <a href="https://musicwalahnar.com">
    <img src="public/icons/icon-512.png" alt="MusicFlow Logo" width="120" height="120" style="border-radius:24px;" />
  </a>
</p>

<h3 align="center">Pure Music Streaming. Zero Latency. Zero Ads.</h3>

<p align="center">
  A blazingly fast, ad-free hybrid music streaming experience for Android and Web.<br />
  Built with dual-buffer gapless playback, time-synced LRC lyrics, 10-band DSP equalizer, and rock-solid background screen-off playback.
</p>

<p align="center">
  <a href="https://musicwalahnar.com"><img src="https://img.shields.io/badge/Website-musicwalahnar.com-10B981?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Live Website" /></a>
  <a href="MusicFlow.apk"><img src="https://img.shields.io/badge/Download_APK-1.37_MB-06B6D4?style=for-the-badge&logo=android&logoColor=white" alt="Download APK" /></a>
  <a href="https://github.com/ramchandaninikhil17-web/musiccc/releases"><img src="https://img.shields.io/badge/Version-3.5.0--HyperFlow-8B5CF6?style=for-the-badge" alt="Version" /></a>
  <img src="https://img.shields.io/badge/Ads-0%25_Ad--Free-EC4899?style=for-the-badge" alt="Ad Free" />
  <img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="License" />
</p>

---

## 🚀 Instant Customer Downloads & Access

| Platform | Download / Access | Status |
|:---|:---|:---|
| **Android APK** | [⬇️ Download `MusicFlow.apk` (1.37 MB)](MusicFlow.apk) | ✅ **Production Release (v3.5.0)** |
| **Live Web App** | [🌐 Open Web Player (0ms Load)](https://musicwalahnar.com) | ✅ **Live on GitHub Pages / Render** |
| **Windows Launcher** | [💻 Download `MusicFlow.exe`](MusicFlow.exe) | ✅ **Standalone App Mode** |

---

## ✨ Why Customers Love MusicFlow

- ⚡ **Zero-Latency Audio Engine (<100ms):** When any song reaches 60% progress, our predictive Queue Preloader resolves stream URLs and pre-buffers the next two songs in the background. Song switching is instantaneous.
- 🔋 **Unstoppable Background Playback:** Native Android `MediaSession` foreground service with dedicated CPU `WakeLock` & `WifiLock`. Never gets killed by Android battery saver or screen-off Doze mode.
- 🎤 **Real-Time Synced LRC Lyrics:** Word-by-word synced lyrics powered by LRCLIB. Tap any lyric line inside the player to jump directly to that timestamp with silky smooth auto-scroll.
- 🎛️ **10-Band DSP Equalizer & Bass Multiplier:** Web Audio DSP with presets (*Bass Boost*, *Vocal Enhancer*, *Treble Boost*, *Rock*, *Pop*, *EDM*, *Acoustic*), 0.5x–2.0x playback speed, and smart 30s volume fade sleep timer.
- 🧠 **Smart Flow AI Mood Mixer:** Fast mood filters (*Deep Focus*, *Gym Hype*, *Late Night*, *Acoustic Chill*, *Party Energy*) that dynamically auto-queue personalized playlists based on energy and tempo similarity.
- 📱 **120FPS Butter-Smooth Mobile Ergonomics:** Hardware-accelerated GPU animations, persistent glassmorphic Mini-Player, and intuitive swipe gestures (swipe right to queue, swipe left to favorite, swipe mini-player to skip).
- 📦 **1.37MB Featherweight Size:** 100% standalone with embedded NanoHTTPD and R8 minification. No PC server required, zero bloated tracking SDKs, and virtually zero battery footprint.

---

## 📊 Head-to-Head Comparison

| Feature | MusicFlow | Spotify Free | YouTube Music |
|:---|:---:|:---:|:---:|
| **Audio Ads & Commercials** | 🚫 **Zero Ads Forever** | ✕ Every 2–3 songs | ✕ Frequent ads |
| **Screen-Off Background Play** | ✅ **100% Free & Unlimited** | ✅ Limited | ✕ $10.99/mo Paywall |
| **App Download Size** | ⚡ **1.37 MB** | ✕ ~80 MB | ✕ ~65 MB |
| **Unlimited Skips** | ✅ **Unlimited** | ✕ 6 skips per hour | ✕ Limited |
| **Real-Time Synced Lyrics** | ✅ **Included Free** | ✕ Limited / Paywalled | ✕ Plain text only |
| **10-Band EQ & Bass Multiplier** | ✅ **Full Web Audio DSP** | ✕ Basic 5-band | ✕ Device default only |
| **Account Required** | 🚫 **None (100% Private)** | ✕ Mandatory | ✕ Google Account |

---

## 📱 Quick Android Installation Guide

1. Download **[`MusicFlow.apk`](MusicFlow.apk)** (1.37 MB).
2. Tap the downloaded `.apk` file on your phone.
3. If prompted by Android, tap **Settings** and toggle **"Allow from this source"**.
4. Tap **Install** and launch MusicFlow! Enjoy unlimited, ad-free music with lock-screen notification controls.

---

## 💻 Running Locally (Developer Mode)

### Prerequisites
- **Node.js 18+** — [https://nodejs.org](https://nodejs.org/)

### Quick Start
```bash
git clone https://github.com/ramchandaninikhil17-web/musiccc.git
cd musiccc
npm install
npm start
```
Then visit **http://localhost:3000** in your browser.

---

## ⌨️ Keyboard Shortcuts

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

## 📄 License

This project is licensed under the **MIT License**. Free for personal and community use.
