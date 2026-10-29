# 📱 MusicFlow — Desktop, Cloud & Android APK Guide

**MusicFlow** is built for high-performance desktop music streaming, cloud deployment, and Android mobile experience.

---

## 📱 1. Android APK & Android Studio Build

The Android app brings MusicFlow to your phone with full native background audio, lock screen controls, and Android notification controls.

### How to Open & Build in Android Studio

1. Open **Android Studio**.
2. Select **File > Open** (or "Open Project" on the welcome screen).
3. Browse to and select:
   ```
   musiccc\mobile\android-apk-lite
   ```
   *(or `musiccc\mobile\android`)*
4. Allow Gradle to sync.
5. Click the green **Run ▶** button to run on your phone/emulator, or go to **Build > Build Bundle(s) / APK(s) > Build APK(s)**.

### Quick Command-Line Build (Windows)

You can also compile the APK without opening Android Studio:
```bat
cd mobile\android-apk-lite
build.bat debug
:: Or for release:
build.bat release
```
The output APK is generated at `mobile\android-apk-lite\apk-output\MusicFlow.apk`.

---

## 🌐 2. How to Connect Your Phone to Your PC Localhost

When you run MusicFlow on your PC (`start.bat` or `node server.js`), the server runs on port 3000. Here are the 2 ways to connect your phone:

### Method A: Over Same Wi-Fi (Recommended)
1. Ensure your PC and phone are on the same Wi-Fi network.
2. Run `connect-phone.bat` on your PC (or run `ipconfig`). It displays your PC's IP (e.g. `192.168.0.106`).
3. Open the **MusicFlow** app on your phone.
4. Tap **⚡ PC Wi-Fi (192.168.0.106:3000)** or enter `http://<your-pc-ip>:3000`.
5. Tap **Connect**. MusicFlow loads instantly, streaming songs directly through your PC's fast local engine!

### Method B: Via USB Cable (Instant & Zero Latency)
1. Plug your phone into your PC via USB with USB Debugging enabled.
2. Double-click `connect-phone.bat`. It automatically runs:
   ```bash
   adb reverse tcp:3000 tcp:3000
   ```
3. In the MusicFlow phone app, tap **🔌 USB Localhost (127.0.0.1:3000)**.
4. It connects to localhost:3000 as if the server were running right inside your phone!

---

## 💻 3. Windows Desktop App Mode

- **Double-click `MusicFlow.exe`**: Starts the backend server and opens MusicFlow in a sleek, distraction-free app window.
- **Double-click `create-desktop-shortcut.bat`**: Instantly creates a desktop shortcut (`MusicFlow.lnk`) for 1-click access anytime.
- **Double-click `start.bat`**: Automated setup batch script with Node.js check and dependency installer.

---

## 🍏 4. macOS & Linux Setup

1. Open Terminal in the `musiccc` directory.
2. Grant execution permission and launch:
   ```bash
   chmod +x start.sh
   ./start.sh
   ```
3. MusicFlow will verify dependencies and launch in your default browser.

---

## ☁️ 5. Cloud Deployment (Render, Railway, Docker, Vercel)

MusicFlow can also be hosted on cloud platforms:
- **Render / Railway**: Pre-configured using `render.yaml` and `railway.json`.
- **Docker**: Build and run with `docker build -t musicflow . && docker run -p 3000:3000 musicflow`.
- **Node Server**: Run `npm start` on any VPS or cloud instance.
