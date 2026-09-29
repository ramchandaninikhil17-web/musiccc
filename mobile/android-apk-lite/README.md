# MusicFlow — Android APK Lite

A lightweight, fast, production-ready Android APK wrapper for the [MusicFlow](https://musicwalahnar.com) music streaming website.

## Architecture

This is a **native Kotlin WebView shell** that connects directly to the live deployed MusicFlow website (`https://musicwalahnar.com`). It enhances the web app with full native Android capabilities:

- **Foreground Service** — keeps music streaming smoothly even when the screen is off or the app is minimized
- **MediaSessionCompat** — provides lock screen controls, notification media controls, and Bluetooth / headphone button handling
- **Native Downloads** — uses Android `DownloadManager` for reliable downloads to the device's public `Music/` folder
- **Offline Detection** — displays a clean, responsive dark-mode offline screen with a "Retry" button when network or server is unavailable
- **Local Music File Picker** — native Android SAF file picker supporting MP3, FLAC, WAV, and M4A
- **Modern Edge-to-Edge UI** — dark theme with status and navigation bar integration, splash screen, and adaptive launcher icons

The APK does **not** bundle Node.js, FFmpeg, yt-dlp, or the server backend. It connects to the live production server, keeping the APK under 1 MB.

## Features

| Feature | Implementation | Status |
|---|---|---|
| **Music Playback & Search** | Web player streamed from `https://musicwalahnar.com` | Verified |
| **Background Playback** | Native Foreground Service (`mediaPlayback`) + Wake Lock | Verified |
| **Notification Media Controls** | AndroidX `MediaStyle` notification with Play/Pause, Next, Prev | Verified |
| **Lock Screen Controls** | `MediaSessionCompat` transport controls + active track metadata | Verified |
| **Bluetooth / Headphone Controls** | Media button intents & `ACTION_AUDIO_BECOMING_NOISY` handling | Verified |
| **Downloads** | Native Android `DownloadManager` (no unnecessary permissions on Android 10+) | Verified |
| **Local Music** | Native file picker via `onShowFileChooser` (audio/*, MP3, FLAC, WAV, M4A) | Verified |
| **Offline Screen** | Native error screen with Retry on network disconnection | Verified |
| **Back Navigation** | Android back button steps through web history before exiting | Verified |
| **State Preservation** | `onSaveInstanceState` / `onRestoreInstanceState` + configChanges | Verified |

## Built APK Output

The APKs have been compiled and verified in `apk-output/`:

| Build Variant | Path | File Size |
|---|---|---|
| **Production Release (Default)** | `mobile/android-apk-lite/apk-output/MusicFlow.apk` | **~780 KB (0.78 MB)** |
| **Release Minified (R8)** | `mobile/android-apk-lite/apk-output/MusicFlow-release.apk` | **~780 KB (0.78 MB)** |
| **Debug Build** | `mobile/android-apk-lite/apk-output/MusicFlow-debug.apk` | **~3.37 MB** |

## Build Instructions

### Quick Build (Windows Script)
```bat
cd mobile\android-apk-lite
build.bat release
# or for debug:
build.bat debug
```

### Manual Gradle Build
```bash
cd mobile/android-apk-lite
gradlew.bat assembleRelease
# Output: app/build/outputs/apk/release/app-release.apk

gradlew.bat assembleDebug
# Output: app/build/outputs/apk/debug/app-debug.apk
```

## Install Instructions

### Option 1: Via ADB (USB Debugging)
```bash
adb install mobile/android-apk-lite/apk-output/MusicFlow.apk
```

### Option 2: Sideload onto Android Phone
1. Transfer `MusicFlow.apk` to your phone via USB cable, Google Drive, WhatsApp, or Telegram.
2. On your phone, tap the file in your File Manager or Downloads.
3. If prompted, toggle "Allow from this source" in system settings.
4. Tap **Install** and open **MusicFlow**.

## Security & Best Practices

- **HTTPS Strict**: Only secure HTTPS connections allowed (`network_security_config.xml` blocks cleartext).
- **WebView Debugging Disabled**: Debugging automatically disabled in release builds.
- **Minimal Permissions**: Modern scoped storage used; no unnecessary broad storage permissions requested on modern Android.
- **Safe Intent Handling**: External links (e.g. non-musicwalahnar domains) open safely in the external browser.

## Project Structure

```
mobile/android-apk-lite/
├── app/
│   ├── build.gradle.kts          # Dependencies & ProGuard / R8 configuration
│   ├── proguard-rules.pro        # Minification & keep rules
│   └── src/main/
│       ├── AndroidManifest.xml   # Permissions, activities, foreground service
│       ├── java/com/musicflow/player/
│       │   ├── MusicFlowApp.kt       # Application class & notification channels
│       │   ├── MainActivity.kt       # WebView shell, JS bridge, file chooser, downloads
│       │   └── PlaybackService.kt    # Foreground service, MediaSession, audio focus
│       └── res/
│           ├── drawable/             # Splash, offline vector, media button icons
│           ├── layout/               # activity_main.xml (WebView + offline overlay)
│           ├── mipmap-*/             # Launcher icons (all standard densities)
│           ├── values/               # Colors, strings, themes, styles
│           └── xml/                  # Network security config, file provider paths
├── build.bat                     # Windows automated build script
├── build.gradle.kts              # Root Gradle build script
├── settings.gradle.kts           # Project settings
├── gradle.properties             # JVM arguments & AndroidX flags
├── gradle/wrapper/               # Gradle wrapper (v8.9)
├── apk-output/                   # Output folder containing installable APKs
│   ├── MusicFlow.apk             # Primary release APK (0.78 MB)
│   ├── MusicFlow-release.apk     # Release APK (0.78 MB)
│   └── MusicFlow-debug.apk       # Debug APK (3.37 MB)
└── README.md                     # Documentation
```
