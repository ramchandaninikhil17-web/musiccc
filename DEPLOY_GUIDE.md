# 🚀 MusicFlow Cloud Deployment Guide

Deploy your **MusicFlow** app to the cloud in minutes for fast, 24/7 access from any phone, laptop, or browser anywhere in the world!

---

## ⚡ Option 1: Render (Recommended — 100% Free & Automatic)

Render is the easiest platform to host MusicFlow with full Node.js, `yt-dlp` streaming engine, and automatic HTTPS.

### Steps:
1. Push your repository to **GitHub** (`git push origin main`).
2. Go to **[render.com](https://render.com)** and log in.
3. Click **"New +"** ➔ **"Web Service"**.
4. Connect your GitHub repository.
5. Render will automatically detect the configuration from `render.yaml` or you can manually enter:
   - **Environment:** `Node`
   - **Build Command:** `npm run build`
   - **Start Command:** `npm start`
   - **Plan:** `Free`
6. Click **"Deploy Web Service"**.
7. In ~60 seconds, your site will be live at `https://your-app-name.onrender.com`!

---

## 🚂 Option 2: Railway

Railway provides high-speed container hosting with zero configuration needed.

### Steps:
1. Go to **[railway.app](https://railway.app)** and log in with GitHub.
2. Click **"New Project"** ➔ **"Deploy from GitHub repo"**.
3. Select your `musiccc` repository.
4. Railway will automatically pick up `railway.json` or `Dockerfile`.
5. Click **"Deploy Now"**.
6. Under Settings ➔ Networking, click **"Generate Domain"** to get your public HTTPS URL!

---

## 🐳 Option 3: Docker / Fly.io / DigitalOcean / VPS

MusicFlow comes with a production-ready, optimized `Dockerfile` that packages Python 3, Node.js 20, ffmpeg, and yt-dlp on Alpine Linux.

### Run locally or on any VPS with Docker:
```bash
# Build the Docker image
docker build -t musicflow .

# Run the container on port 3000
docker run -d -p 3000:3000 --name musicflow-app musicflow
```

### Deploy to Fly.io:
```bash
fly launch
fly deploy
```

---

## 🌟 Exclusive Features Included in this Release:

1. **🍏 Apple-Style Floating Transparent Orb (`.apple-floating-orb`)**:
   - Translucent frosted glass circle that hovers over your screen with live disc spinning and equalizer soundbars.
   - Smooth drag-and-drop to any screen position with automatic edge snapping.
   - Expand into an **Apple Dynamic Island Glass Capsule** for instant play/pause, seek, track info, and **⚡ Instant Switch** (1-click song skipping).

2. **🖼️ Always-On-Top Mini-Player (Picture-in-Picture)**:
   - Click the **PiP** button on the top bar, player bar, or Floating Orb to pop out a real-time live canvas mini-player that stays visible over VS Code, Word, Excel, games, or other applications when MusicFlow is minimized!
   - Full MediaSession lockscreen and desktop background controls (`Space`, `Shift+N`, `Shift+P`, `P`, `F`, `M`, `D`).

3. **⏱️ Pomodoro Focus Flow & Ambient Sound Generator**:
   - 25m Focus / 5m Rest interval timers with circular SVG progress ring and productivity stats.
   - Built-in Web Audio API ambient noise synthesizer (Rain 🌧️, Cafe ☕, Ocean Waves 🌊) that works completely offline with zero extra downloads.
   - 1-Click Lofi / Deep Focus / Synthwave playlist launchers.
