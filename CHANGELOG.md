# Changelog

All notable changes to MusicFlow are documented here.

---

## v3.0.0

### Added

- **Native Android app** (`mobile/android/`) — Kotlin/WebView shell with an embedded NanoHTTPd server and NewPipeExtractor for on-device audio extraction. No external server required on the phone.
- **Playlist batch download** — download an entire playlist as a ZIP archive. Runs as an async job with progress polling and cancellation (`POST /api/playlist-download`).
- **Dependency-free ZIP writer** (`lib/zip.js`) — stored-mode ZIP implementation so playlist downloads don't need an archiver dependency.
- **Mood Flow** — new sidebar page. Pick a mood and energy level; the server assembles a mix of matching tracks via `POST /api/mood-mix`.
- **Voice search** — voice command parsing for hands-free control.
- **Browse & discovery** — curated browse page with genre and mood categories.
- **Crossfade** — configurable crossfade between tracks.
- **Batch search** — `POST /api/batch-search` resolves up to 40 queries in parallel.
- **Smart search scoring** — ranking algorithm that prefers official uploads, major labels, YouTube Music topic channels, and filters out karaoke/slowed/reaction content.
- **Atomic user data writes** — `POST /api/user-data` now serialises writes through a promise chain and uses temp-file + rename to prevent corruption.
- **Download filename improvements** — filenames now preserve non-Latin scripts (Hindi, Tamil, CJK), strip YouTube noise ("Official Video", "[4K]"), and handle duplicates in playlist archives.
- **yt-dlp bootstrap guard** — the server waits for the binary to be fully resolved before accepting search/stream requests, with a 90-second timeout so requests fail fast instead of hanging on network issues.
- **Port auto-increment** — if port 3000 is taken, the server walks up to 3010. The desktop launcher reads `data/runtime.json` to find the actual port.
- **Concurrency controls** — download slots are capped at 3 (2 for batch jobs) so a long playlist job can't starve interactive downloads.
- **Health check** — `GET /api/health` now reports `ytDlpReady` status.
- **SPA fallback hardening** — non-HTML asset requests to unknown paths return 404 instead of serving `index.html`, which previously caused cryptic "Unexpected token '<'" errors.
- **Test suite expansion** — added tests for browse/discovery, crossfade, queue reorder, search suggestions, UI features, and voice commands.

### Changed

- `package.json` version bumped to `3.0.0`.
- Minimum Node.js version remains 18+.
- `prepare-binaries.js` and the runtime bootstrap now download yt-dlp directly from GitHub releases instead of using `yt-dlp-wrap`, which silently swallowed network failures.
- Truncated binary downloads are detected and rejected (content-length verification).
- `GETTING_STARTED.md`, `BUILD_APPS.md`, `DEPLOY_GUIDE.md`, and `README.md` rewritten to match the current codebase.

### Fixed

- Download counter no longer gets permanently stuck at the limit after a failure (the slot is now released in all exit paths).
- User data saves no longer race — concurrent `POST /api/user-data` requests are serialised.
- Stale temp files in `temp_downloads/` are cleaned up properly, including directories left by playlist jobs.
- The desktop launcher no longer opens `localhost:3000` when the server is actually on a different port.
- EPIPE and ECONNRESET from disconnected clients no longer crash the process.

---

## v2.5.0

### Added

- **10-band graphic equalizer** — Web Audio DSP with frequency sliders (31 Hz – 16 kHz), bass boost, and 3D spatial audio.
- **Local file drag-and-drop** — play `.mp3`, `.flac`, `.wav`, `.m4a` files directly.
- **Smart sleep timer** — 15 / 30 / 45 / 60 min presets with a 30-second volume fade-out.
- **Accent colour studio** — six accent colours (Indigo, Cyan, Emerald, Orange, Pink, Purple) and OLED pitch-black mode.
- **Endless auto-queue** — automatically loads related tracks when the queue runs out.
- **Apple floating orb** — draggable translucent control orb with live artwork, edge-snapping, and Dynamic Island capsule.
- **PiP mini-player** — canvas-rendered Picture-in-Picture window for multitasking.
- **Pomodoro focus flow** — timer with SVG progress ring and session tracking.
- **Ambient sound mixer** — procedural rain, café, ocean, and white noise layers via Web Audio API.
- **Instant Switch** — one-click button in the orb to jump to the next recommended track.
- **MediaSession integration** — lockscreen playback controls and media key support.
- **Cloud deployment configs** — `Dockerfile`, `render.yaml`, `railway.json`, `Procfile`.
- **Windows desktop launcher** — `MusicFlow.exe` compiled from `MusicFlowLauncher.cs`.
- **Desktop shortcut scripts** — `start.bat`, `start.sh`, `create-desktop-shortcut.bat`.
- **PWA support** — `manifest.json`, service worker, app icons.

### Initial API

- `GET /api/search`
- `GET /api/smart-search`
- `GET /api/suggestions`
- `GET /api/recommendations`
- `GET /api/info/:videoId`
- `GET /api/stream/:videoId`
- `GET /api/lyrics/:videoId`
- `GET /api/download/:videoId`
- `GET /api/user-data` / `POST /api/user-data`
- `GET /api/network-info`
- `GET /health` / `GET /api/health`
