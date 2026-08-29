# Contributing

Thanks for your interest in improving MusicFlow. This document covers the development setup, how to run tests, and the conventions the codebase follows.

---

## Development Setup

1. **Clone the repo:**

   ```bash
   git clone https://github.com/ramchandaninikhil17-web/musiccc.git
   cd musiccc
   ```

2. **Install dependencies:**

   ```bash
   npm install
   ```

   This also runs `prepare-binaries.js`, which downloads the `yt-dlp` binary for your platform.

3. **Start the dev server:**

   ```bash
   npm run dev
   ```

   The server starts on `http://localhost:3000` and binds to `0.0.0.0` by default. There is no hot-reload — restart the server after changing `server.js`.

   Frontend changes (`public/`) are served directly and take effect on browser refresh.

---

## Running Tests

The test suite uses Node's built-in `assert` module — no test framework to install.

### Run all tests

```bash
bash test/run-all.sh
```

This runs every test suite sequentially. The API and client tests boot an isolated server copy in `/tmp` with a stubbed `yt-dlp`, so nothing touches your real data, downloads, or dev server port.

### Run a single test

```bash
node test/dom-ids.test.js
node test/crossfade.test.js
```

### Test suites

| File | What it tests |
|:---|:---|
| `zip.test.js` | ZIP writer in `lib/zip.js` |
| `dom-ids.test.js` | HTML element IDs referenced by `app.js` exist in `index.html` |
| `ui-features.test.js` | Static UI feature wiring (CSS classes, data attributes) |
| `playlist-remove.test.js` | Playlist removal logic |
| `queue-reorder.test.js` | Queue ordering, shuffle, and drag-reorder |
| `crossfade.test.js` | Crossfade timing and gain curves |
| `search-suggest.test.js` | Search suggestion ranking and filtering |
| `browse-discovery.test.js` | Browse/discovery page data flow |
| `voice.test.js` | Voice assistant command parsing |
| `api-download.test.sh` | Download API end-to-end (shell script, boots server with fake yt-dlp) |
| `client-download.test.js` | Client-side download logic against a live server |

---

## Code Style

- **No frameworks.** The frontend is vanilla HTML, CSS, and JavaScript. The backend is plain Express. Keep it that way.
- **No external test runners.** Tests use `node:assert` and `node:test` (or plain scripts). Adding Jest, Mocha, etc. is not needed.
- **No TypeScript.** The project uses plain JavaScript with JSDoc comments where helpful.
- **Semicolons:** Yes.
- **Quotes:** Single quotes for JS strings.
- **Indentation:** 2 spaces.
- **Comments:** Keep existing comments intact. Add comments for non-obvious logic but don't over-document trivial code.

---

## Project Layout

| Path | Ownership |
|:---|:---|
| `server.js` | All backend routes, streaming logic, download pipeline |
| `public/js/app.js` | Entire frontend — player, UI, orb, PiP, EQ, Pomodoro |
| `public/css/style.css` | All styles |
| `public/index.html` | SPA shell |
| `lib/zip.js` | Dependency-free ZIP writer (used for playlist downloads) |
| `prepare-binaries.js` | Build-time binary downloader |
| `MusicFlowLauncher.cs` | Windows desktop launcher source |
| `mobile/android/` | Native Android app |
| `test/` | All tests and fixtures |

---

## Pull Request Guidelines

1. **One concern per PR.** Don't mix a bug fix with an unrelated refactor.
2. **Run the tests** before submitting: `bash test/run-all.sh`.
3. **Describe what and why** in the PR body. Link to an issue if one exists.
4. **Don't commit binaries** (`yt-dlp`, `yt-dlp.exe`, `MusicFlow.exe`, `ffmpeg`). These are in `.gitignore` for a reason — they're downloaded at install time.
5. **Don't commit user data** (`data/userData.json`, `data/runtime.json`, log files, `temp_downloads/`).

---

## Reporting Issues

When reporting a bug, include:

- Your OS and Node.js version (`node --version`)
- Browser name and version
- Steps to reproduce
- Console output or error messages (both browser console and server terminal)
