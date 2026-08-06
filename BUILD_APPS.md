# 📱 MusicFlow — Lite Windows EXE & Android APK Setup

This document provides instructions on how to use **MusicFlow** as a **Lite Desktop App (`.exe`)** on Windows PC and as an **Android App (`.apk`)** on your phone.

---

## 💻 1. Windows PC Lite Desktop Executable (`MusicFlow.exe`)

We compiled a dedicated native executable launcher for Windows PC.

### Why it's ultra-lite:
- **File size**: Only **~5.6 KB** (No heavy Electron 150MB bloat!).
- **Memory (RAM)**: ~30 MB (Uses Windows OS built-in Edge/WebView2 engine).
- **Silent Launch**: Starts `server.js` silently in the background with zero black console window popups.

### How to run:
1. **Desktop Shortcut**: Double-click the **MusicFlow** shortcut on your Windows Desktop.
2. **Direct Executable**: Double-click `MusicFlow.exe` inside the project folder.

---

## 📱 2. Android Phone Application (`.apk`)

There are **2 easy ways** to install MusicFlow on your Android phone:

---

### Option A: Install as Android Web App (Instant & Recommeneded - 0 MB Download)

Since MusicFlow is PWA-enabled with service worker caching:
1. Make sure your phone is connected to the same Wi-Fi as your PC.
2. Open Chrome/Edge browser on your Android phone.
3. Type your PC's IP address (You can check your local IP by running `ipconfig` in Command Prompt or opening `http://localhost:3000/api/network-info` on your PC).
   - Example: `http://192.168.1.5:3000`
4. Tap the **Three Dots Menu ⋮** in Chrome on your phone.
5. Tap **"Add to Home screen"** or **"Install app"**.
6. MusicFlow will install directly onto your phone's app drawer as a standalone native app icon!

---

### Option B: Build a Standalone `.apk` File (Using PWABuilder or WebIntoApp)

If you want a physical `.apk` installer file to send to your phone or share:

#### Method 1: PWABuilder (Official Microsoft Tool - 100% Free)
1. Go to [PWABuilder.com](https://www.pwabuilder.com/) in your browser.
2. Enter your deployed server URL (or local network URL via ngrok/tunnel).
3. Click **Package for Android**.
4. Download the generated `musicflow.apk` directly to your phone and install!

#### Method 2: WebIntoApp (1-Click APK Generator)
1. Go to [WebIntoApp.com](https://www.webintoapp.com/).
2. Select **Web to App**.
3. Set App Name: `MusicFlow`.
4. Enter your IP / Hosted URL (e.g. `http://192.168.1.5:3000`).
5. Upload icon from `public/icons/icon-512.png`.
6. Click **Generate APK** and download `MusicFlow.apk` directly!

---

## 🚀 Free Cloud Deployment (Optional for Phone Access Anywhere)

If you want your phone app to work even when your PC is turned off, you can deploy the `server.js` backend to a free host:
- [Render.com](https://render.com/) (Free Node.js web service)
- [Railway.app](https://railway.app/)
- [Koyeb.com](https://koyeb.com/)

Once deployed, set your APK or PWA URL to `https://your-app-name.onrender.com`!
