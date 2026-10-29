# MusicFlow Native — Spotify-Grade Android Music Player

MusicFlow Native is a 100% standalone, zero-lag, modern Android music streaming and offline playback application built with **Jetpack Compose Material 3**, **AndroidX Media3 (ExoPlayer)**, **Room Database**, **DataStore**, and on-device YouTube streaming extractors.

---

## Architecture Overview

- **UI Framework:** Jetpack Compose Material 3 with 120fps GPU-accelerated rendering and dynamic accent palette theming (Indigo, Cyan, Emerald, Orange, Pink, Purple).
- **Audio Engine:** AndroidX Media3 (`MediaSessionService` + `ExoPlayer`), providing background playback, lock-screen notification controls, gapless playback, 0–10s dual-buffer crossfade, and 500MB `SimpleCache` disk caching.
- **DSP & Effects:** Native Android `AudioEffect` (`Equalizer` and `BassBoost`) with 7 presets (*Flat*, *Bass Boost*, *Vocal*, *Rock*, *Pop*, *EDM*, *Acoustic*).
- **On-Device Data Extraction:** Modular YouTube InnerTube + Piped extractor with fallback redundancy and in-app source health monitoring.
- **Synced Lyrics:** LRCLIB integration with auto-scrolling synced LRC lyrics and tap-to-seek timestamp navigation.
- **Offline Downloads:** Android `WorkManager` resumable background downloader supporting multi-format audio (MP3 128k/192k/320k) and video (MP4 360p–1080p).
- **Local Persistence:** Room Database (`MusicFlowDatabase`) for playlists, favorites, listening event diary, and search history.
- **Preferences:** Jetpack DataStore Preferences for audio quality, theme, accent color, crossfade, and resume tracking.
- **Voice Assistant:** Native Android `SpeechRecognizer` recognizing wake phrase *"Hey My Ruby"* and hands-free voice commands.

---

## Build Instructions

### Prerequisites
- **JDK:** Java 21 LTS (`jdk-21.0.12.1` or newer)
- **Android SDK:** Compile SDK 35, Min SDK 26, Target SDK 35

### Commands

From the workspace root or inside `mobile/android-apk-lite`:

1. **Run Unit Tests:**
   ```bash
   ./gradlew test
   ```

2. **Build Debug APK:**
   ```bash
   ./gradlew assembleDebug
   ```

3. **Build Signed Release APK:**
   ```bash
   ./gradlew assembleRelease
   ```
   Output APK: `app/release/MusicFlow.apk`

4. **Build Release Android App Bundle (AAB):**
   ```bash
   ./gradlew bundleRelease
   ```
   Output AAB: `app/release/MusicFlow.aab`

---

## Signing Configuration

The release build is signed with the project keystore:
- **Keystore File:** `mobile/android-apk-lite/release-key.jks`
- **Configuration File:** `mobile/android-apk-lite/keystore.properties`
- **Keystore Password:** `musicflow123`
- **Key Alias:** `musicflow`
- **Key Password:** `musicflow123`

---

## Installation via ADB

Connect an Android device with USB debugging enabled, then run:

```bash
adb install -r app/release/MusicFlow.apk
```
