# 📱 MusicFlow — Cross-Platform & Mobile App Guide

**MusicFlow** is designed to work seamlessly across Windows, macOS, Linux, Android, and iOS devices.

---

## 📱 1. Install Directly on Your Phone / Tablet (Instant PWA)

MusicFlow is a Progressive Web App (PWA) with background audio playback, media session controls, and offline capability.

1. Connect your phone/tablet to the **same Wi-Fi network** as your computer.
2. In MusicFlow on your PC, click the **📱 Phone** icon in the sidebar/top bar to show your local Wi-Fi URL & QR code.
3. Open **Chrome** (Android) or **Safari** (iPhone/iPad):
   - **Android (Chrome)**: Tap **⋮ Menu** (top right) → tap **"Install app"** or **"Add to Home screen"**.
   - **iOS / iPhone (Safari)**: Tap the **Share button** (square with arrow) → scroll down and tap **"Add to Home Screen"**.
4. 🎉 **Done!** MusicFlow will now appear on your home screen with its own icon, running in full-screen mode like a native app.

---

## 📦 2. Build Native Android APK (`.apk`)

### Option A: 1-Click Online Converter (Fastest - 1 Minute)
1. Use [PWABuilder.com](https://www.pwabuilder.com/) or [WebIntoApp.com](https://www.webintoapp.com/).
2. Enter your deployed URL or local Wi-Fi IP address.
3. Download the generated `MusicFlow.apk` directly onto your Android phone and install!

### Option B: Native Android Project (Android Studio)
1. The repository includes a pre-configured native Capacitor project in the `android/` directory.
2. Open the `android/` folder in **Android Studio**.
3. Let Gradle sync project dependencies.
4. Click **Build** → **Build Bundle(s) / APK(s)** → **Build APK(s)**.
5. Transfer the generated APK from `android/app/build/outputs/apk/debug/app-debug.apk` to your phone.

---

## 💻 3. Windows PC Native App Mode

- **Double-click `MusicFlow.exe`**: Starts server headlessly and opens the app in a distraction-free window (Edge App Mode).
- **Double-click `create-desktop-shortcut.bat`**: Creates an instant desktop icon for 1-click access anytime.
- **Double-click `start.bat`**: Universal launcher with automatic Node.js check and dependency installer.

---

## 🍏 4. macOS / Linux Setup

1. Open Terminal in the project directory.
2. Run:
   ```bash
   chmod +x start.sh
   ./start.sh
   ```
3. MusicFlow will install any needed packages and launch in your default browser.
