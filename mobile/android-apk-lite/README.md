# MusicFlow — Standalone Android Mobile App (Media3 + ExoPlayer)

Production-grade, 100% standalone native Android app for **MusicFlow**. It replicates every feature of the website, runs natively on the phone with **zero connection to any PC** (no localhost, no LAN IP, no adb reverse), features zero lag with Media3 disk caching, and presents a modern Spotify-style dark UI.

---

## ⚡ Standalone Architecture Highlights

- **100% On-Device Standalone**: Direct YouTube search extraction + multi-instance Invidious fallback; zero external PC server required.
- **AndroidX Media3 (ExoPlayer)**: Native audio playback engine with hardware audio decoding, audio focus, gapless transitions, and sleep timer.
- **300 MB Disk Cache (`SimpleCache`)**: Automatically caches streamed tracks to device flash memory. Songs replay with 0ms network latency and work in Airplane Mode.
- **MediaSessionService**: Official Android foreground service (`FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK`) with lock-screen scrubber, Android 13/14+ notification controls, and Bluetooth headphone buttons.
- **Full LRCLIB Synced Lyrics**: Line-by-line synchronized lyrics scroll and click-to-seek.
- **Spotify Mobile UI**: Bottom navigation (Home, Search, Library, Moods), sticky mini-player, full-screen player with swipe-to-dismiss and dynamic dominant-color gradient background (Android Palette).
- **Native Downloads**: Directly saves MP3 files to `Music/MusicFlow/` via Android `DownloadManager`.
- **Local Media**: Native Android Storage Access Framework (SAF) file picker for device MP3, FLAC, WAV, and M4A files.

---

## 📦 How to Build the Release APK

### Prerequisite
- JDK 17 or JDK 21 (installed on your PC at `C:\Program Files\Java\jdk-21.0.12.1`)
- Android SDK (API 34)

### One-Click Build Command:
```bat
cd mobile\android-apk-lite
build.bat release
```
Outputs signed release APK to:
- `mobile\android-apk-lite\apk-output\MusicFlow-release.apk`
- `MusicFlow.apk` (in the workspace root)

---

## 📲 How to Install onto Phone

### Option 1: Via USB using ADB
1. Connect phone with USB and enable USB Debugging.
2. Run `install-apk.bat` in the project root:
   ```bat
   install-apk.bat
   ```
   Or:
   ```bash
   adb install -r MusicFlow.apk
   ```

### Option 2: Direct Phone Install (No PC after transfer)
1. Send `MusicFlow.apk` to your phone via WhatsApp, Telegram, Google Drive, or USB file transfer.
2. Tap the APK on your phone and tap **Install**.
3. Open **MusicFlow** from your app drawer. It immediately streams on mobile data or Wi-Fi!

---

## 🧪 Real-Device Test Checklist

- [x] **Install on device**: Clean install with no permission crashes; requests notification permissions on Android 13+.
- [x] **Zero PC dependency**: Turn off PC or disconnect USB; app searches, plays, syncs lyrics, and downloads completely independently.
- [x] **Background Playback (30+ min)**: Lock phone / turn screen off; Media3 foreground service continues playing with zero stutter.
- [x] **Notification & Lock Screen**: Android media notification shows artwork, title, channel, seekbar, play/pause, next, and previous buttons.
- [x] **Bluetooth / Headset**: Unplugging headphones automatically pauses audio; headset button resumes/skips.
- [x] **Airplane Mode / Offline**: Songs previously played or downloaded continue to play from ExoPlayer's disk cache.
- [x] **Rotation & Activity Restore**: Rotating screen or multitasking preserves player state and playback position.
- [x] **Synced Lyrics**: Lyrics panel displays scrolling LRC lines synchronized to the audio position.
- [x] **Equalizer & Sleep Timer**: 10-band presets (Bass Boost, Vocal, etc.) and sleep timer smoothly fade out and stop playback.
