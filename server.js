const express = require('express');
const cors = require('cors');
const { execFile, spawn, spawnSync } = require('child_process');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');

// ffmpeg path resolution: explicit override -> ffmpeg-static -> system ffmpeg.
// FFMPEG_PATH lets a user (or the test harness) point at a known-good binary when
// the bundled one is wrong for their platform.
let ffmpegPath = process.env.FFMPEG_PATH || process.env.MUSICFLOW_FFMPEG || null;
if (ffmpegPath && ffmpegPath !== 'ffmpeg' && !fs.existsSync(ffmpegPath)) {
  console.warn(`[MusicFlow] ⚠️ FFMPEG_PATH set but not found: ${ffmpegPath}`);
  ffmpegPath = null;
}
if (!ffmpegPath) {
  try {
    ffmpegPath = require('ffmpeg-static');
  } catch (e) {
    ffmpegPath = null;
  }
}
if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
  // Try system ffmpeg
  const check = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { windowsHide: true });
  if (check && check.status === 0 && check.stdout) {
    ffmpegPath = check.stdout.toString().trim().split(/\r?\n/)[0];
    console.log(`[MusicFlow] ✅ Using system ffmpeg: ${ffmpegPath}`);
  } else {
    ffmpegPath = 'ffmpeg'; // last resort, hope it's in PATH
    console.warn('[MusicFlow] ⚠️ ffmpeg-static not found, falling back to system ffmpeg');
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_SEARCH_LENGTH = 160;

process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
    // Ignore EPIPE and ECONNRESET which happen when clients disconnect mid-stream
    return;
  }
  console.error('[Uncaught Exception]', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Unhandled Rejection]', reason);
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));

/* ------------------------------------------------------------------ */
/*  Standard extractor arguments for reliable local YouTube access     */
/* ------------------------------------------------------------------ */
// NO explicit --extractor-args player_client override. As of mid-2026 YouTube
// gates the android, web, tv and ios player clients behind PO tokens / SOCS
// cookies — requesting them without a token yields "The page needs to be
// reloaded" or a degraded 360p-only ladder. Letting yt-dlp pick its own
// default client (currently visionos) returns the full DASH ladder from 144p
// to 4K without any tokens and adapts automatically when yt-dlp ships a new
// client strategy in future updates.
const BASE_YTDLP_ARGS = [
  '--geo-bypass',
  '--no-check-certificates',
  '--no-playlist',
];

// Video downloads use the same base args. yt-dlp's default client returns the
// full high-res DASH ladder (up to 4K) without needing PO tokens or cookies.
// --format-sort on the download call then picks the largest frame within the
// requested height cap.
const VIDEO_YTDLP_ARGS = [
  '--geo-bypass',
  '--no-check-certificates',
  '--no-playlist',
];

/* ------------------------------------------------------------------ */
/*  Healthcheck Endpoints for Cloud Load Balancers (Render, Railway)  */
/* ------------------------------------------------------------------ */
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    service: 'musicflow-api',
  });
});

app.get('/api/health', (req, res) => {
  res.status(200).json({
    // Identifies this specific app. The desktop launcher probes a range of
    // ports and must be able to tell MusicFlow apart from any other dev
    // server that happens to be listening.
    app: 'musicflow',
    status: 'ok',
    port: activePort,
    pid: process.pid,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    // ytDlpPath is always a truthy string, so the old check reported "ready"
    // even when the binary had not been resolved yet.
    ytDlpReady: ytDlpResolved,
    // Capability flags. The client checks these so a browser talking to an OLD
    // still-running server (a common "I picked MP4 but got MP3" cause — the
    // server process was never restarted) can warn instead of silently serving
    // the wrong format. Absence of the flag == old server.
    videoDownload: true,
    // Best-effort yt-dlp version string (populated after startup). The client can
    // surface this and offer a one-click update when an old binary is why only a
    // single low resolution is downloadable.
    ytDlpVersion: ytDlpVersion,
    ytDlpUpdating: ytDlpUpdating,
  });
});

/* ------------------------------------------------------------------ */
/*  Resolve yt-dlp binary path & Auto-Download if missing             */
/* ------------------------------------------------------------------ */
let ytDlpPath = 'yt-dlp';
let ytDlpResolved = false;
let ytDlpBinaryFound = false;
// Best-effort cache of `yt-dlp --version` (populated after startup, refreshed
// after an update) and a flag while a self-update is running so the UI can show
// progress and a second update can't start on top of the first.
let ytDlpVersion = null;
let ytDlpUpdating = false;

// Upper bound on the first-run binary bootstrap. Past this, requests proceed
// and fail fast with a real error instead of hanging.
const YTDLP_BOOTSTRAP_TIMEOUT_MS = 90000;

// Resolves once the binary has been located/downloaded. Every code path that
// shells out to yt-dlp awaits this, otherwise requests that arrive during the
// first few seconds of uptime run against a binary that isn't there yet.
let ytDlpReadyPromise = null;

function whenYtDlpReady() {
  if (!ytDlpReadyPromise) {
    // The bootstrap is raced against a timeout. A dependency that neither
    // resolves nor rejects (yt-dlp-wrap does exactly that when DNS fails)
    // would otherwise wedge every search and stream request forever.
    ytDlpReadyPromise = Promise.race([
      ensureYtDlp(),
      new Promise((resolve) => setTimeout(resolve, YTDLP_BOOTSTRAP_TIMEOUT_MS).unref?.()),
    ]).then(() => {
      ytDlpResolved = ytDlpBinaryFound;
    }).catch(() => {
      // ensureYtDlp already logs; leave ytDlpResolved false so /api/health is honest.
    });
  }
  return ytDlpReadyPromise;
}

async function ensureYtDlp() {
  try {
    const isWin = process.platform === 'win32';
    const binaryName = isWin ? 'yt-dlp.exe' : 'yt-dlp';
    const rootBinary = path.join(__dirname, binaryName);

    if (fs.existsSync(rootBinary)) {
      if (!isWin) {
        try { fs.chmodSync(rootBinary, '755'); } catch (e) {}
      }
      ytDlpPath = rootBinary;
      ytDlpBinaryFound = true;
      console.log(`[MusicFlow] ✅ yt-dlp binary ready: ${ytDlpPath}`);
      return;
    }

    // Check if available in system PATH
    try {
      const check = require('child_process').spawnSync('yt-dlp', ['--version'], { windowsHide: true });
      if (check && check.status === 0) {
        ytDlpPath = 'yt-dlp';
        ytDlpBinaryFound = true;
        console.log('[MusicFlow] ✅ Using system yt-dlp from PATH');
        return;
      }
    } catch (e) {}

    // Not found locally or in PATH -> download from official GitHub releases.
    //
    // This deliberately does NOT use YTDlpWrap.downloadFromGithub(): when DNS
    // or the network fails it raises the error on an emitter nobody listens to,
    // so the failure surfaces as an uncaught exception AND its promise never
    // settles — which hung every request waiting on this bootstrap.
    let downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
    if (isWin) downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
    else if (process.platform === 'darwin') downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';

    console.log('[MusicFlow] ⬇️ yt-dlp binary not found. Downloading latest official release...');
    await downloadBinaryDirect(downloadUrl, rootBinary);
    if (!isWin) {
      try { fs.chmodSync(rootBinary, '755'); } catch (e) {}
    }
    ytDlpPath = rootBinary;
    ytDlpBinaryFound = true;
    console.log(`[MusicFlow] ✅ Direct download of yt-dlp successful: ${ytDlpPath}`);
  } catch (err) {
    console.warn(`[MusicFlow] ⚠️ yt-dlp is unavailable: ${err.message}`);
    console.warn('[MusicFlow] ⚠️ Search, streaming and downloads will not work until yt-dlp is installed.');
  }
}

function downloadBinaryDirect(url, destPath) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 MusicFlow-Server' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadBinaryDirect(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download failed with HTTP ${res.statusCode}`));
      }
      const expected = Number(res.headers['content-length']) || 0;
      let received = 0;
      res.on('data', (chunk) => { received += chunk.length; });

      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);

      // A socket drop mid-transfer used to resolve successfully, leaving a
      // truncated binary on disk that then failed on every invocation.
      res.on('error', (err) => {
        fileStream.destroy();
        fs.unlink(destPath, () => {});
        reject(err);
      });

      fileStream.on('finish', () => {
        fileStream.close(() => {
          if (expected && received < expected) {
            fs.unlink(destPath, () => {});
            return reject(new Error(`Truncated download: got ${received} of ${expected} bytes`));
          }
          if (received === 0) {
            fs.unlink(destPath, () => {});
            return reject(new Error('Downloaded binary was empty'));
          }
          resolve();
        });
      });
      fileStream.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    }).on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/*  Helper: run yt-dlp with cloud anti-bot args                       */
/* ------------------------------------------------------------------ */
function runYtDlp(args, timeout = 60000, baseArgs = BASE_YTDLP_ARGS) {
  return whenYtDlpReady().then(() => new Promise((resolve, reject) => {
    const fullArgs = [...baseArgs, ...args];
    execFile(ytDlpPath, fullArgs, {
      maxBuffer: 10 * 1024 * 1024,
      timeout,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) {
        const details = String(stderr || '').trim();
        if (details) err.message = `${err.message}: ${details}`;
        return reject(err);
      }
      resolve(stdout.trim());
    });
  }));
}

function isYouTubeId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(id.trim());
}

// Best-effort read of the installed yt-dlp version. Never rejects — resolves null
// on any failure so callers (health, update) don't have to guard.
function getYtDlpVersion(timeout = 15000) {
  return whenYtDlpReady().then(() => new Promise((resolve) => {
    try {
      execFile(ytDlpPath, ['--version'], { windowsHide: true, timeout }, (err, stdout) => {
        if (err) return resolve(null);
        const v = String(stdout || '').trim().split(/\r?\n/)[0].trim();
        resolve(v || null);
      });
    } catch (e) { resolve(null); }
  }));
}

function getSearchQuery(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, MAX_SEARCH_LENGTH);
}

/* ------------------------------------------------------------------ */
/*  In-Memory LRU/TTL Cache & Concurrency Helper                      */
/* ------------------------------------------------------------------ */
const searchCache = new Map();
const CACHE_TTL = 1000 * 60 * 30; // 30 mins

function getCached(key) {
  const item = searchCache.get(key);
  if (!item) return null;
  if (Date.now() - item.ts > CACHE_TTL) {
    searchCache.delete(key);
    return null;
  }
  return item.data;
}

function setCache(key, data) {
  if (searchCache.size > 500) {
    const firstKey = searchCache.keys().next().value;
    searchCache.delete(firstKey);
  }
  searchCache.set(key, { data, ts: Date.now() });
}

/* ------------------------------------------------------------------ */
/*  Audio URL Cache — YouTube CDN URLs expire after ~6h                */
/* ------------------------------------------------------------------ */
const audioUrlCache = new Map();
const AUDIO_URL_TTL = 1000 * 60 * 180; // 3 hours — well before 6h expiry

function getCachedAudioUrl(videoId, quality) {
  const key = `${videoId}_${quality}`;
  const item = audioUrlCache.get(key);
  if (!item) return null;
  if (Date.now() - item.ts > AUDIO_URL_TTL) {
    audioUrlCache.delete(key);
    return null;
  }
  return item.url;
}

function setCachedAudioUrl(videoId, quality, url) {
  const key = `${videoId}_${quality}`;
  if (audioUrlCache.size > 200) {
    const firstKey = audioUrlCache.keys().next().value;
    audioUrlCache.delete(firstKey);
  }
  audioUrlCache.set(key, { url, ts: Date.now() });
}

// Concurrency limiter for fast parallel tasks
async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        results[i] = null;
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/* ------------------------------------------------------------------ */
/*  Smart Song Scoring & Ranking (Prefers Official Labels & Famous)    */
/* ------------------------------------------------------------------ */
function scoreSong(item, query, preferOfficial = true) {
  let score = 0;
  const title = (item.title || '').toLowerCase();
  const channel = (item.channel || '').toLowerCase();
  const rawQuery = (query || '').toLowerCase().trim();
  const queryWords = rawQuery.split(/[\s\-_,]+/).filter(w => w.length > 1);

  // 1. Keyword overlap in title and channel
  let matchedWords = 0;
  for (const word of queryWords) {
    if (title.includes(word) || channel.includes(word)) matchedWords++;
  }
  if (queryWords.length > 0) {
    score += (matchedWords / queryWords.length) * 400;
  }

  // Exact phrase match bonus
  if (title.includes(rawQuery)) score += 200;

  if (preferOfficial) {
    // 2. Official Record Labels & Major Channels (Bollywood & Global)
    const officialChannels = [
      't-series', 'tseries', 'sony music', 'sonymusic', 'zee music', 'zeemusic',
      'yrf', 'yash raj films', 'tips official', 'tips music', 'saregama',
      'speed records', 'eros now', 'desi music factory', 'times music', 'white hill music',
      'vevo', 'warner records', 'warner music', 'universal music', 'columbia records',
      'atlantic records', 'republic records', 'def jam', 'spinnin records', 'ultra records',
      'interscope', 'rca records', 'bad boy entertainment', 'ovo sound'
    ];

    const isMajorLabel = officialChannels.some(label => channel.includes(label));
    if (isMajorLabel) score += 700;

    // 3. YouTube Music Official Topic channel
    if (channel.includes(' - topic') || channel.endsWith(' topic')) {
      score += 550;
    }

    // 4. Official Audio / Video in Title
    if (/official\s*(video|audio|music|lyric|lyrical|song)/i.test(title)) score += 300;
    if (/(full\s*video|full\s*song|original\s*soundtrack|ost|audio song)/i.test(title)) score += 180;

    // 5. High View Count bonus (logarithmic scaling)
    const views = Number(item.views) || 0;
    if (views > 0) {
      score += Math.min(450, Math.log10(views + 1) * 50);
    }

    // 6. Optimal Music Track Duration (1:20 to 7:00 is normal song range)
    const dur = Number(item.duration) || 0;
    if (dur >= 80 && dur <= 450) {
      score += 150;
    } else if (dur > 600) {
      score -= 350;
    } else if (dur < 50 && dur > 0) {
      score -= 250;
    }

    // 7. Negative Penalties
    if (/1\s*hour|10\s*hours|slowed\s*(\+|\&)?\s*reverb|8d\s*audio|karaoke|ringtone|status\s*30s|reaction|dance\s*cover|guitar\s*lesson|piano\s*tutorial/i.test(title)) {
      score -= 500;
    }
  }

  return score;
}

/* ------------------------------------------------------------------ */
/*  Helper: Perform Single Smart Search & Select Best Match           */
/* ------------------------------------------------------------------ */
async function performSingleSmartSearch(query, preferOfficial = true) {
  const cleanQ = (query || '').trim();
  if (!cleanQ) return null;

  const cacheKey = `smart_${cleanQ.toLowerCase()}_${preferOfficial ? 1 : 0}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const searchTerm = cleanQ.length <= 15 && !cleanQ.toLowerCase().includes('song') && !cleanQ.toLowerCase().includes('audio')
    ? `${cleanQ} song`
    : cleanQ;

  try {
    const stdout = await runYtDlp([
      `ytsearch8:${searchTerm}`,
      '--dump-json', '--flat-playlist', '--no-warnings',
      '--default-search', 'ytsearch', '--skip-download',
    ], 18000);

    if (!stdout) return null;

    const items = stdout.split('\n').filter(Boolean).map(line => {
      try {
        const d = JSON.parse(line);
        return {
          id: d.id || d.url,
          title: d.title || 'Unknown',
          channel: d.channel || d.uploader || 'Unknown',
          duration: d.duration || 0,
          thumbnail: d.thumbnails ? d.thumbnails[d.thumbnails.length - 1]?.url
            : `https://i.ytimg.com/vi/${d.id}/hqdefault.jpg`,
          views: d.view_count || 0,
        };
      } catch { return null; }
    }).filter(Boolean).filter(item => isYouTubeId(item.id));

    if (!items.length) return null;

    const scored = items.map(item => ({
      item,
      score: scoreSong(item, cleanQ, preferOfficial),
    })).sort((a, b) => b.score - a.score);

    const best = scored[0].item;
    const resultPayload = {
      query: cleanQ,
      bestMatch: best,
      score: scored[0].score,
      candidates: scored.slice(0, 3).map(s => s.item),
    };

    setCache(cacheKey, resultPayload);
    return resultPayload;
  } catch (err) {
    console.error(`[SmartSearch Error: "${cleanQ}"]`, err.message);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  GET /api/search?q=...                                             */
/* ------------------------------------------------------------------ */
app.get('/api/search', async (req, res) => {
  const query = getSearchQuery(req.query.q);
  if (!query) return res.status(400).json({ error: 'Missing q' });

  const cacheKey = `search_${query.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const stdout = await runYtDlp([
      `ytsearch15:${query}`,
      '--dump-json', '--flat-playlist', '--no-warnings',
      '--default-search', 'ytsearch', '--skip-download',
    ], 25000);

    if (!stdout) return res.json([]);

    const results = stdout.split('\n').filter(Boolean).map(line => {
      try {
        const d = JSON.parse(line);
        return {
          id: d.id || d.url,
          title: d.title || 'Unknown',
          channel: d.channel || d.uploader || 'Unknown',
          duration: d.duration || 0,
          thumbnail: d.thumbnails ? d.thumbnails[d.thumbnails.length - 1]?.url
            : `https://i.ytimg.com/vi/${d.id}/hqdefault.jpg`,
          views: d.view_count || 0,
        };
      } catch { return null; }
    }).filter(Boolean).filter(item => isYouTubeId(item.id));

    setCache(cacheKey, results);
    res.json(results);
  } catch (err) {
    console.error('[Search]', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

/* ------------------------------------------------------------------ */
/*  GET /api/smart-search?q=...&official=1                            */
/* ------------------------------------------------------------------ */
app.get('/api/smart-search', async (req, res) => {
  const query = getSearchQuery(req.query.q);
  const preferOfficial = req.query.official !== '0';
  if (!query) return res.status(400).json({ error: 'Missing q' });

  try {
    const result = await performSingleSmartSearch(query, preferOfficial);
    if (!result || !result.bestMatch) return res.status(404).json({ error: 'No match found' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Smart search failed' });
  }
});

/* ------------------------------------------------------------------ */
/*  POST /api/batch-search                                            */
/* ------------------------------------------------------------------ */
app.post('/api/batch-search', async (req, res) => {
  const queries = req.body.queries;
  const preferOfficial = req.body.preferOfficial !== false;

  if (!Array.isArray(queries) || queries.length === 0) {
    return res.status(400).json({ error: 'Queries array is required' });
  }

  const cleanQueries = queries
    .map(q => (typeof q === 'string' ? q.trim() : ''))
    .filter(Boolean)
    .slice(0, 40);

  try {
    const resolvedList = await mapConcurrent(cleanQueries, 4, async (q) => {
      const r = await performSingleSmartSearch(q, preferOfficial);
      return r ? { query: q, song: r.bestMatch, candidates: r.candidates } : null;
    });

    const successful = resolvedList.filter(Boolean);
    res.json({
      total: cleanQueries.length,
      found: successful.length,
      results: successful,
    });
  } catch (err) {
    console.error('[BatchSearch]', err.message);
    res.status(500).json({ error: 'Batch search failed' });
  }
});

/* ------------------------------------------------------------------ */
/*  GET /api/recommendations                                          */
/* ------------------------------------------------------------------ */
app.get('/api/recommendations', async (req, res) => {
  const seedArtists = req.query.seedArtists ? String(req.query.seedArtists).split(',').map(s => s.trim()).filter(Boolean) : [];
  const seedQueries = req.query.seedQueries ? String(req.query.seedQueries).split(',').map(s => s.trim()).filter(Boolean) : [];

  const cacheKey = `rec_${seedArtists.slice(0, 3).sort().join('_')}_${seedQueries.slice(0, 3).sort().join('_')}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  let searchPrompts = [];

  if (seedArtists.length > 0) {
    seedArtists.slice(0, 3).forEach(artist => {
      searchPrompts.push(`ytsearch8:${artist} best songs playlist`);
      searchPrompts.push(`ytsearch6:songs similar to ${artist}`);
    });
  }

  if (seedQueries.length > 0) {
    seedQueries.slice(0, 2).forEach(track => {
      searchPrompts.push(`ytsearch6:${track} similar music`);
    });
  }

  if (searchPrompts.length === 0) {
    searchPrompts = [
      'ytsearch10:top global music hits 2024',
      'ytsearch10:latest top bollywood songs 2024',
      'ytsearch8:trending songs playlist',
    ];
  }

  try {
    const rawResults = await mapConcurrent(searchPrompts.slice(0, 4), 3, async (prompt) => {
      try {
        const stdout = await runYtDlp([
          prompt,
          '--dump-json', '--flat-playlist', '--no-warnings',
          '--default-search', 'ytsearch', '--skip-download',
        ], 18000);
        if (!stdout) return [];
        return stdout.split('\n').filter(Boolean).map(line => {
          try {
            const d = JSON.parse(line);
            return {
              id: d.id || d.url,
              title: d.title || 'Unknown',
              channel: d.channel || d.uploader || 'Unknown',
              duration: d.duration || 0,
              thumbnail: d.thumbnails ? d.thumbnails[d.thumbnails.length - 1]?.url
                : `https://i.ytimg.com/vi/${d.id}/hqdefault.jpg`,
              views: d.view_count || 0,
            };
          } catch { return null; }
        }).filter(Boolean).filter(item => isYouTubeId(item.id));
      } catch {
        return [];
      }
    });

    const seen = new Set();
    const allSongs = [];
    rawResults.flat().forEach(s => {
      if (s && s.id && !seen.has(s.id)) {
        seen.add(s.id);
        const dur = Number(s.duration) || 0;
        if (dur >= 60 && dur <= 600) {
          allSongs.push(s);
        }
      }
    });

    for (let i = allSongs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allSongs[i], allSongs[j]] = [allSongs[j], allSongs[i]];
    }

    const finalRecommendations = allSongs.slice(0, 24);
    setCache(cacheKey, finalRecommendations);
    res.json(finalRecommendations);
  } catch (err) {
    console.error('[Recommendations]', err.message);
    res.status(500).json({ error: 'Failed to fetch recommendations' });
  }
});

/* ------------------------------------------------------------------ */
/*  GET /api/suggestions?q=...                                        */
/* ------------------------------------------------------------------ */
app.get('/api/suggestions', async (req, res) => {
  const query = getSearchQuery(req.query.q);
  if (!query) return res.json([]);

  const cacheKey = `sug_${query.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const stdout = await runYtDlp([
      `ytsearch5:${query}`,
      '--dump-json', '--flat-playlist', '--no-warnings',
      '--default-search', 'ytsearch', '--skip-download',
    ], 12000);

    if (!stdout) return res.json([]);

    const results = stdout.split('\n').filter(Boolean).map(line => {
      try {
        const d = JSON.parse(line);
        return { id: d.id, title: d.title || 'Unknown', channel: d.channel || d.uploader || '' };
      } catch { return null; }
    }).filter(Boolean).filter(item => isYouTubeId(item.id));

    setCache(cacheKey, results);
    res.json(results);
  } catch {
    res.json([]);
  }
});

/* ------------------------------------------------------------------ */
/*  GET /api/info/:videoId                                            */
/* ------------------------------------------------------------------ */
app.get('/api/info/:videoId', async (req, res) => {
  const { videoId } = req.params;
  if (!isYouTubeId(videoId)) {
    return res.status(400).json({ error: 'Invalid YouTube ID' });
  }
  try {
    const stdout = await runYtDlp([
      `https://www.youtube.com/watch?v=${videoId}`,
      '--dump-json', '--no-warnings', '--skip-download',
    ], 15000);

    const d = JSON.parse(stdout);
    res.json({
      id: d.id,
      title: d.title || 'Unknown',
      channel: d.channel || d.uploader || 'Unknown',
      duration: d.duration || 0,
      thumbnail: d.thumbnails ? d.thumbnails[d.thumbnails.length - 1]?.url
        : `https://i.ytimg.com/vi/${d.id}/hqdefault.jpg`,
      views: d.view_count || 0,
      description: d.description || '',
    });
  } catch (err) {
    console.error('[Info]', err.message);
    res.status(500).json({ error: 'Failed to fetch info' });
  }
});

/* ------------------------------------------------------------------ */
/*  Available video resolutions                                        */
/* ------------------------------------------------------------------ */
// Reads the real, downloadable video heights out of a yt-dlp --dump-json blob.
// Only formats that actually carry a video stream (vcodec !== 'none') with a
// concrete pixel height count — audio-only rungs are ignored. Returns the sorted
// unique heights plus the max, so the UI can offer only resolutions that exist
// (a track whose best is 360p should never show a 2K button) and the download
// path can cap a too-high request to the real ceiling.
function parseAvailableHeights(info) {
  const result = { heights: [], maxHeight: 0, hasVideo: false };
  if (!info || !Array.isArray(info.formats)) return result;
  const set = new Set();
  for (const f of info.formats) {
    if (!f || f.vcodec === 'none' || !f.vcodec) continue;
    const h = typeof f.height === 'number' ? f.height : parseInt(f.height, 10);
    if (!Number.isFinite(h) || h <= 0) continue;
    set.add(h);
  }
  const heights = [...set].sort((a, b) => a - b);
  result.heights = heights;
  result.maxHeight = heights.length ? heights[heights.length - 1] : 0;
  result.hasVideo = heights.length > 0;
  return result;
}

// Short-lived cache so opening the download modal repeatedly (or re-picking a
// format) doesn't fire a fresh --dump-json every time.
const formatsCache = new Map();
const FORMATS_TTL_MS = 30 * 60 * 1000;

/* ------------------------------------------------------------------ */
/*  GET /api/formats/:videoId                                          */
/*  Lists the resolutions a track can actually be downloaded in, so    */
/*  the client only offers qualities that exist.                       */
/* ------------------------------------------------------------------ */
app.get('/api/formats/:videoId', async (req, res) => {
  const { videoId } = req.params;
  if (!isYouTubeId(videoId)) {
    return res.status(400).json({ error: 'Invalid YouTube ID' });
  }

  const cached = formatsCache.get(videoId);
  if (cached && (Date.now() - cached.at) < FORMATS_TTL_MS) {
    return res.json(cached.data);
  }

  try {
    const stdout = await runYtDlp([
      `https://www.youtube.com/watch?v=${videoId}`,
      '--dump-json', '--no-warnings', '--skip-download',
    ], 15000, VIDEO_YTDLP_ARGS);
    const info = JSON.parse(stdout);
    const parsed = parseAvailableHeights(info);
    const data = {
      heights: parsed.heights,
      maxHeight: parsed.maxHeight,
      hasVideo: parsed.hasVideo,
    };
    formatsCache.set(videoId, { at: Date.now(), data });
    // Keep the cache from growing without bound on a long-running server.
    if (formatsCache.size > 300) {
      formatsCache.delete(formatsCache.keys().next().value);
    }
    res.json(data);
  } catch (err) {
    console.error('[Formats]', err.message);
    // Fail-open: hasVideo:null means "couldn't tell", so the client keeps every
    // option enabled rather than blocking a download on a metadata hiccup.
    res.status(200).json({ heights: [], maxHeight: 0, hasVideo: null, unknown: true });
  }
});

/* ------------------------------------------------------------------ */
/*  yt-dlp self-update                                                 */
/*  YouTube changes its format ladder constantly; a yt-dlp binary that */
/*  is even a few weeks old can lose the ability to see anything above */
/*  a ~360p progressive rung, which is why "every resolution option    */
/*  downloads the same one file". Refreshing the binary restores the   */
/*  full ladder — and because yt-dlp is invoked per-request, the new   */
/*  binary takes effect immediately, with no Node restart.             */
/* ------------------------------------------------------------------ */
function ourManagedBinary() {
  // Only ever overwrite the binary we bundled/downloaded ourselves, never a
  // system yt-dlp the user put on PATH.
  return path.isAbsolute(ytDlpPath) && ytDlpPath.startsWith(__dirname);
}

async function updateYtDlp() {
  if (ytDlpUpdating) return { ok: false, error: 'An update is already in progress.' };
  ytDlpUpdating = true;
  const before = await getYtDlpVersion().catch(() => null);
  try {
    await whenYtDlpReady();

    // 1) Preferred path: yt-dlp's own self-update. It verifies and swaps the
    //    binary atomically, so a concurrent invocation only ever sees the old or
    //    the new file, never a half-written one.
    const runSelfUpdate = () => new Promise((resolve) => {
      try {
        execFile(ytDlpPath, ['-U'], { windowsHide: true, timeout: 180000, maxBuffer: 10 * 1024 * 1024 },
          (err, stdout, stderr) => resolve({ err, out: `${String(stdout || '')}\n${String(stderr || '')}`.trim() }));
      } catch (e) { resolve({ err: e, out: '' }); }
    });
    let { err, out } = await runSelfUpdate();
    let method = 'self-update';

    // 2) Fallback: yt-dlp refuses to self-update when it wasn't installed as a
    //    standalone binary (pip, distro package, etc.). For our own bundled
    //    binary we can just re-download the latest official release over it.
    const cannotSelfUpdate = /pip|package manager|not.*(?:updat|self)|cannot update|install/i.test(out || '');
    if ((err || cannotSelfUpdate) && ourManagedBinary()) {
      const isWin = process.platform === 'win32';
      let url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
      if (isWin) url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
      else if (process.platform === 'darwin') url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
      const tmp = `${ytDlpPath}.new-${Date.now()}`;
      await downloadBinaryDirect(url, tmp);
      // Sanity-check the download is non-trivial before swapping it in.
      let ok = false;
      try { ok = fs.statSync(tmp).size > 1024 * 1024; } catch (e) {}
      if (!ok) { try { fs.unlinkSync(tmp); } catch (e) {} throw new Error('Downloaded binary looked corrupt'); }
      fs.renameSync(tmp, ytDlpPath);
      if (!isWin) { try { fs.chmodSync(ytDlpPath, '755'); } catch (e) {} }
      method = 'redownload';
      err = null;
    }

    if (err) {
      return { ok: false, error: (out || err.message || 'Update failed').slice(0, 400), from: before, to: before };
    }

    const after = await getYtDlpVersion().catch(() => null);
    ytDlpVersion = after || before;
    // The old "best is 360p" ceilings were a symptom of the stale binary — drop
    // the cache so the next probe re-enumerates with the fresh one.
    formatsCache.clear();
    audioUrlCache.clear();
    return { ok: true, updated: !!(after && before !== after) || method === 'redownload', from: before, to: after, method };
  } catch (e) {
    return { ok: false, error: (e && e.message ? e.message : 'Update failed').slice(0, 400), from: before, to: before };
  } finally {
    ytDlpUpdating = false;
  }
}

/* ------------------------------------------------------------------ */
/*  POST /api/update-ytdlp                                             */
/*  One-click "fix my resolutions" — updates the downloader in place.  */
/* ------------------------------------------------------------------ */
app.post('/api/update-ytdlp', async (req, res) => {
  const result = await updateYtDlp();
  res.status(result.ok ? 200 : 500).json(result);
});

// Throttled, non-blocking background refresh so the ladder doesn't silently rot
// between the user noticing and fixing it. Fires at most when the binary is more
// than a few days old; off in tests and via MUSICFLOW_NO_AUTOUPDATE=1.
function maybeAutoUpdateYtDlp() {
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.MUSICFLOW_NO_AUTOUPDATE === '1') return;
  if (!ourManagedBinary()) return;
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(ytDlpPath).mtimeMs; } catch (e) { return; }
  const STALE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
  if (Date.now() - mtimeMs < STALE_MS) return;
  console.log('[MusicFlow] yt-dlp binary looks stale — refreshing in the background so video resolutions stay available…');
  updateYtDlp().then((r) => {
    if (r.ok) console.log(`[MusicFlow] ✅ yt-dlp auto-update: ${r.from || '?'} → ${r.to || '?'} (${r.method})`);
    else console.warn(`[MusicFlow] ⚠️ yt-dlp auto-update skipped: ${r.error}`);
  }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/*  GET /api/stream/:videoId?quality=low|high                         */
/*  Multi-Tier Audio Proxy: yt-dlp Direct -> Pipe -> Serverless API    */
/* ------------------------------------------------------------------ */
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 50,
  // Certificate verification stays ON. Disabling it made every proxied audio
  // stream and every third-party API call trivially MITM-able.
  rejectUnauthorized: true,
});

app.get('/api/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const quality = req.query.quality || 'high';
  const isRetry = req.query.retry ? parseInt(req.query.retry, 10) : 0;

  if (!isYouTubeId(videoId)) {
    return res.status(400).json({ error: 'Invalid YouTube ID for yt-dlp stream' });
  }

  const formatMap = {
    low: 'worstaudio[ext=m4a]/worstaudio/worst',
    high: 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
  };

  // Check cached audio URL first (skip on retry to force fresh extraction)
  if (!isRetry) {
    const cachedUrl = getCachedAudioUrl(videoId, quality);
    if (cachedUrl) {
      try {
        return fetchAndProxyAudio(cachedUrl, req, res, videoId, 0);
      } catch (err) {
        // Cached URL may have expired, continue to fresh extraction
        audioUrlCache.delete(`${videoId}_${quality}`);
      }
    }
  }

  // Tier 1: Try direct audio URL extraction via yt-dlp (with retry)
  const maxTier1Attempts = isRetry ? 1 : 2;
  for (let attempt = 0; attempt < maxTier1Attempts; attempt++) {
    try {
      const audioUrl = await runYtDlp([
        `https://www.youtube.com/watch?v=${videoId}`,
        '-f', formatMap[quality] || formatMap.high,
        '-g', '--no-warnings',
      ], 90000);

      if (audioUrl && audioUrl.startsWith('http')) {
        setCachedAudioUrl(videoId, quality, audioUrl);
        return fetchAndProxyAudio(audioUrl, req, res, videoId, 0);
      }
    } catch (err) {
      console.warn(`[Stream Tier 1 Attempt ${attempt + 1} for ${videoId}]`, err.message);
      if (attempt < maxTier1Attempts - 1) {
        // Brief pause before retry
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  // Tier 2: Try direct stdout pipe via yt-dlp
  streamViaPipeFallback(videoId, req, res);
});

function fetchAndProxyAudio(targetUrl, req, res, videoId, redirectCount = 0, isFinalTier = false) {
  if (res.headersSent || res.writableEnded) return;

  // isFinalTier means we were called by Tier 3. Falling back to the pipe from
  // here would loop Tier 2 -> Tier 3 -> Tier 2 forever.
  const giveUp = (reason) => {
    if (res.headersSent || res.writableEnded) return;
    if (isFinalTier) {
      console.warn(`[Stream] All tiers exhausted for ${videoId}: ${reason}`);
      res.status(502).json({ error: 'Audio stream unavailable' });
    } else {
      streamViaPipeFallback(videoId, req, res);
    }
  };

  if (redirectCount > 4) return giveUp('too many redirects');

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch (e) {
    return giveUp('unparseable URL');
  }

  // Only ever speak http(s). Anything else is a malformed/hostile Location.
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    return giveUp(`unsupported protocol ${parsedUrl.protocol}`);
  }

  try {
    const isHttps = parsedUrl.protocol === 'https:';
    const protocol = isHttps ? https : http;

    const headers = {
      'User-Agent': YOUTUBE_ANDROID_USER_AGENT,
      'Accept': '*/*',
      'Referer': 'https://www.youtube.com/',
      'Origin': 'https://www.youtube.com',
    };
    if (req.headers.range) headers['Range'] = req.headers.range;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers,
      agent: isHttps ? httpsAgent : undefined,
      timeout: 30000, // 30s connection timeout to prevent hung sockets
    };

    const proxyReq = protocol.request(options, (proxyRes) => {
      // Follow HTTP redirects
      if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
        // Drain the redirect body, otherwise the socket is never released
        // back to the keep-alive pool.
        proxyRes.resume();
        return fetchAndProxyAudio(proxyRes.headers.location, req, res, videoId, redirectCount + 1, isFinalTier);
      }

      if (!proxyRes.statusCode || proxyRes.statusCode >= 400) {
        console.warn(`[Stream Proxy] CDN HTTP ${proxyRes.statusCode}, falling back...`);
        proxyRes.resume();
        // Invalidate cached URL on 403/410 (expired)
        if (proxyRes.statusCode === 403 || proxyRes.statusCode === 410) {
          audioUrlCache.delete(`${videoId}_high`);
          audioUrlCache.delete(`${videoId}_low`);
        }
        return giveUp(`CDN HTTP ${proxyRes.statusCode}`);
      }

      const fwdHeaders = {
        'Content-Type': proxyRes.headers['content-type'] || 'audio/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      };
      if (proxyRes.headers['content-length']) fwdHeaders['Content-Length'] = proxyRes.headers['content-length'];
      if (proxyRes.headers['content-range']) fwdHeaders['Content-Range'] = proxyRes.headers['content-range'];

      if (!res.headersSent) {
        res.writeHead(proxyRes.statusCode || 200, fwdHeaders);
      }

      proxyRes.pipe(res);

      proxyRes.on('error', (err) => {
        console.warn('[Proxy Res Error]', err.message);
        // Headers are already out, so the only honest signal left is to cut
        // the connection rather than serve a silently truncated track.
        try { res.destroy(); } catch (e) {}
      });
    });

    // Socket timeout: if the CDN connection hangs, abort and fall back
    proxyReq.on('timeout', () => {
      console.warn(`[Stream Proxy] Socket timeout for ${videoId}`);
      proxyReq.destroy();
      giveUp('socket timeout');
    });

    proxyReq.on('error', (err) => {
      console.warn(`[Proxy Req Error - ${err.code || err.message}]`);
      giveUp(err.code || err.message);
    });

    req.on('close', () => {
      if (!res.writableEnded) {
        try { proxyReq.destroy(); } catch (e) {}
      }
    });

    proxyReq.end();
  } catch (err) {
    console.warn('[Stream Proxy Exception]', err.message);
    giveUp(err.message);
  }
}

// Tier 2: Direct stream via yt-dlp stdout pipe if YouTube CDN URL drops socket
function streamViaPipeFallback(videoId, req, res) {
  if (res.headersSent || res.writableEnded) return;

  let streamProcess;
  try {
    streamProcess = spawn(ytDlpPath, [
      ...BASE_YTDLP_ARGS,
      `https://www.youtube.com/watch?v=${videoId}`,
      '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
      '-o', '-',
      '--no-warnings',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return streamViaServerlessApi(videoId, req, res);
  }

  let headersSet = false;
  let stderr = '';
  // 'error' and 'close' can both fire for a single failed spawn. Without this
  // guard we handed the same response to Tier 3 twice.
  let handedOff = false;

  const handOffToTier3 = () => {
    if (handedOff || headersSet || res.headersSent) return;
    handedOff = true;
    streamViaServerlessApi(videoId, req, res);
  };

  streamProcess.stderr.on('data', (chunk) => {
    if (stderr.length < 8192) stderr += chunk.toString();
  });

  streamProcess.stdout.on('data', () => {
    if (!headersSet && !res.headersSent) {
      headersSet = true;
      res.writeHead(200, {
        'Content-Type': 'audio/mp4',
        'Accept-Ranges': 'none',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
    }
  });

  streamProcess.stdout.on('error', () => {});

  // NOTE the `end: false`. Letting pipe() end the response automatically meant
  // that a failed spawn — whose stdout ends immediately with zero bytes —
  // answered the client with an empty HTTP 200 before Tier 3 could take over.
  // The response is now ended explicitly, and only once audio actually flowed.
  streamProcess.stdout.pipe(res, { end: false });

  streamProcess.stdout.on('end', () => {
    if (headersSet && !res.writableEnded) res.end();
  });

  streamProcess.on('error', (err) => {
    console.warn('[Pipe Process Error]', err.message);
    handOffToTier3();
  });

  streamProcess.on('close', (code) => {
    if (!headersSet && !res.headersSent) {
      if (code !== 0) {
        console.warn(`[Pipe Process Close] Non-zero exit ${code}: ${stderr.trim()}`);
      }
      handOffToTier3();
    } else if (headersSet && !res.writableEnded) {
      // Guards the case where stdout emitted 'close' without a clean 'end'.
      res.end();
    }
  });

  res.on('close', () => {
    // Only kill the child if the client bailed before we finished writing.
    if (!res.writableEnded) {
      try { streamProcess.kill('SIGTERM'); } catch (e) {}
    }
  });
}

// Tier 3: Serverless Piped / Invidious API Fallback (Works on Vercel / Cloud Functions with 0 binaries!)
// Dynamic Invidious instance discovery with fallback to hardcoded list
let cachedInvidiousInstances = null;
let invidiousInstanceFetchedAt = 0;
const INVIDIOUS_INSTANCE_TTL = 1000 * 60 * 60; // refresh every hour

async function getInvidiousInstances() {
  if (cachedInvidiousInstances && (Date.now() - invidiousInstanceFetchedAt < INVIDIOUS_INSTANCE_TTL)) {
    return cachedInvidiousInstances;
  }
  try {
    const data = await new Promise((resolve, reject) => {
      const r = https.get('https://api.invidious.io/instances.json?sort_by=health', {
        timeout: 5000,
        headers: { 'User-Agent': 'Mozilla/5.0 MusicFlow-Server' },
      }, (resp) => {
        if (!resp.statusCode || resp.statusCode >= 400) { resp.resume(); return reject(new Error(`HTTP ${resp.statusCode}`)); }
        let body = '';
        resp.setEncoding('utf8');
        resp.on('data', c => { body += c; if (body.length > 2 * 1024 * 1024) { r.destroy(); reject(new Error('too large')); } });
        resp.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        resp.on('error', reject);
      });
      r.on('error', reject);
      r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    });
    // Filter for instances with API enabled and HTTPS
    const instances = data
      .filter(([, info]) => info && info.api === true && info.type === 'https' && info.uri)
      .slice(0, 8)
      .map(([, info]) => info.uri);
    if (instances.length > 0) {
      cachedInvidiousInstances = instances;
      invidiousInstanceFetchedAt = Date.now();
      console.log(`[MusicFlow] ✅ Fetched ${instances.length} Invidious instances`);
      return instances;
    }
  } catch (err) {
    console.warn('[MusicFlow] ⚠️ Could not fetch Invidious instances:', err.message);
  }
  // Fallback hardcoded list
  return [
    'https://vid.puffyan.us',
    'https://invidious.snopyta.org',
    'https://yewtu.be',
    'https://inv.nadeko.net',
  ];
}

async function streamViaServerlessApi(videoId, req, res) {
  if (res.headersSent || res.writableEnded) return;

  // Build API list from dynamic Invidious instances + Piped
  const invidiousHosts = await getInvidiousInstances();
  const apis = [
    ...invidiousHosts.map(host => `${host}/api/v1/videos/${videoId}`),
    `https://pipedapi.kavin.rocks/streams/${videoId}`,
    `https://api.piped.video/streams/${videoId}`,
    `https://pipedapi.adminforge.de/streams/${videoId}`,
  ];

  for (const apiUrl of apis) {
    try {
      const data = await new Promise((resolve, reject) => {
        const r = https.get(apiUrl, { timeout: 8000, agent: httpsAgent }, (resp) => {
          if (!resp.statusCode || resp.statusCode >= 400) {
            resp.resume();
            return reject(new Error(`HTTP ${resp.statusCode}`));
          }
          let body = '';
          resp.setEncoding('utf8');
          resp.on('data', c => {
            body += c;
            // Guard against an endpoint streaming an unbounded body at us.
            if (body.length > 4 * 1024 * 1024) {
              r.destroy();
              reject(new Error('response too large'));
            }
          });
          resp.on('end', () => {
            try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
          });
          resp.on('error', reject);
        });
        r.on('error', reject);
        r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
      });

      const audioStreams = data.audioStreams || data.adaptiveFormats;
      if (Array.isArray(audioStreams) && audioStreams.length > 0) {
        const bestStream = audioStreams.find(s => s.mimeType && s.mimeType.includes('audio/mp4')) || audioStreams[0];
        if (bestStream && bestStream.url && /^https?:\/\//i.test(bestStream.url)) {
          if (res.headersSent || res.writableEnded) return;
          // Proxy rather than 302. A redirect pushed the client off-origin,
          // which broke range requests and caused the Web Audio equalizer to
          // output silence (cross-origin media taints the graph).
          return fetchAndProxyAudio(bestStream.url, req, res, videoId, 0, true);
        }
      }
    } catch (err) {
      // try next API endpoint
    }
  }

  if (!res.headersSent && !res.writableEnded) {
    res.status(502).json({ error: 'Audio stream unavailable' });
  }
}

/* ------------------------------------------------------------------ */
/*  GET /api/lyrics/:videoId                                          */
/* ------------------------------------------------------------------ */
app.get('/api/lyrics/:videoId', async (req, res) => {
  const { videoId } = req.params;

  if (!isYouTubeId(videoId)) {
    return res.json({ title: '', artist: '', synced: false, lines: [] });
  }

  try {
    const stdout = await runYtDlp([
      `https://www.youtube.com/watch?v=${videoId}`,
      '--dump-json', '--no-warnings', '--skip-download',
    ], 15000);

    const data = JSON.parse(stdout);
    const title = data.title || '';
    const artist = data.channel || data.uploader || '';

    let subtitles = null;
    if (data.subtitles && Object.keys(data.subtitles).length > 0) {
      subtitles = data.subtitles;
    } else if (data.automatic_captions && Object.keys(data.automatic_captions).length > 0) {
      subtitles = data.automatic_captions;
    }

    if (subtitles) {
      const lang = subtitles['en'] || subtitles[Object.keys(subtitles)[0]];
      if (lang) {
        const sub = lang.find(s => s.ext === 'json3') || lang.find(s => s.ext === 'vtt') || lang[0];
        if (sub && sub.url) {
          const subRes = await new Promise((resolve, reject) => {
            const proto = sub.url.startsWith('https') ? https : http;
            proto.get(sub.url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
              let body = '';
              r.on('data', c => body += c);
              r.on('end', () => resolve(body));
              r.on('error', reject);
            }).on('error', reject);
          });

          try {
            const subData = JSON.parse(subRes);
            if (subData.events) {
              const lines = subData.events
                .filter(e => e.segs && e.segs.length > 0)
                .map(e => ({
                  time: (e.tStartMs || 0) / 1000,
                  text: e.segs.map(s => s.utf8).join('').trim(),
                }))
                .filter(l => l.text && l.text !== '\n');

              return res.json({ title, artist, synced: true, lines });
            }
          } catch {
            return res.json({
              title, artist, synced: false,
              lines: subRes.split('\n').filter(l => l.trim() && !l.includes('-->') && !l.match(/^\d+$/)).map(l => ({ time: 0, text: l.trim() })),
            });
          }
        }
      }
    }

    res.json({ title, artist, synced: false, lines: [] });
  } catch (err) {
    console.error('[Lyrics]', err.message);
    res.status(500).json({ error: 'Failed to fetch lyrics' });
  }
});

/* ------------------------------------------------------------------ */
/*  GET /api/download/:videoId — download as MP3                      */
/* ------------------------------------------------------------------ */
const tempDownloadsDir = path.join(__dirname, 'temp_downloads');
if (!fs.existsSync(tempDownloadsDir)) {
  try { fs.mkdirSync(tempDownloadsDir, { recursive: true }); } catch (e) {}
}
// Total simultaneous yt-dlp/ffmpeg conversions allowed process-wide. Batch
// playlist jobs draw from this same budget but are capped lower (see
// MAX_BATCH_CONCURRENCY) so a long playlist job can never starve an
// interactive single-track download of every slot.
const MAX_CONCURRENT_DOWNLOADS = 3;
const MAX_BATCH_CONCURRENCY = 2;
let activeDownloadCount = 0;

// Waiters used by batch jobs, which queue for a slot instead of failing fast
// the way the interactive endpoint does.
const downloadSlotWaiters = [];

function releaseDownloadSlot() {
  activeDownloadCount = Math.max(0, activeDownloadCount - 1);
  if (downloadSlotWaiters.length && activeDownloadCount < MAX_CONCURRENT_DOWNLOADS) {
    const next = downloadSlotWaiters.shift();
    activeDownloadCount++;
    next();
  }
}

// Resolves once a conversion slot is free. Unlike the interactive endpoint this
// never rejects — a playlist job is expected to take as long as it takes.
function acquireDownloadSlot() {
  if (activeDownloadCount < MAX_CONCURRENT_DOWNLOADS) {
    activeDownloadCount++;
    return Promise.resolve();
  }
  return new Promise(resolve => downloadSlotWaiters.push(resolve));
}

function cleanStaleDownloads() {
  const cutoff = Date.now() - (24 * 60 * 60 * 1000);
  let files = [];
  try {
    files = fs.readdirSync(tempDownloadsDir);
  } catch (err) {
    console.warn('[Download Cleanup]', err.message);
    return;
  }
  // Per-file guard: one locked or already-deleted file used to abort the whole
  // sweep, so temp files accumulated forever.
  for (const file of files) {
    try {
      const filePath = path.join(tempDownloadsDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs >= cutoff) continue;
      // Playlist jobs leave working *directories* here. unlinkSync throws on
      // those, which previously meant they were never reclaimed.
      if (stat.isDirectory()) fs.rmSync(filePath, { recursive: true, force: true });
      else fs.unlinkSync(filePath);
    } catch (err) {
      // File vanished or is still locked by another process; skip it.
    }
  }
}

cleanStaleDownloads();

// Strips path/header-hostile characters while preserving non-Latin scripts.
// The old filter allowed only [a-zA-Z0-9], so every Hindi, Tamil, Arabic or
// CJK title collapsed to the empty string and downloaded as "Track.mp3".
function buildSafeFilename(rawTitle) {
  const cleaned = String(rawTitle || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')   // control chars (incl. CR/LF header injection)
    .replace(/[\\/:*?"<>|]/g, '')       // characters illegal in Windows filenames
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')                // no leading dots -> no "." or ".."
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, '')              // Windows silently drops trailing dots/spaces
    .trim();
  return cleaned || 'MusicFlow_Track';
}

// Strips the noise YouTube uploaders bolt onto titles. Without this a saved file
// is called "Song (Official Video) [4K] | Full HD Lyrical" instead of "Song".
function tidyTrackTitle(rawTitle) {
  return String(rawTitle || '')
    .replace(/\((?:official\s*)?(?:music\s*)?(?:video|audio|lyric[s]?|lyrical|visualizer|hd|4k|full\s*song|full\s*video)[^)]*\)/gi, '')
    .replace(/\[(?:official\s*)?(?:music\s*)?(?:video|audio|lyric[s]?|lyrical|visualizer|hd|4k|full\s*song|full\s*video)[^\]]*\]/gi, '')
    .replace(/\b(?:official\s+(?:video|audio|music\s+video)|lyric\s+video|full\s+video\s+song)\b/gi, '')
    .replace(/[|–—-]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// A download must never be named just "Track". Two of those in one folder and the
// browser starts appending "(1)", "(2)" — which is the whole complaint this
// function exists to prevent. The chain always ends on something unique.
//
// `artist` is only appended when the title does not already carry it, because
// YouTube titles are usually "Artist - Song" and "Artist - Song - Artist" is worse
// than no artist at all.
function buildTrackFilename(rawTitle, rawArtist, videoId) {
  const title = tidyTrackTitle(rawTitle);
  const artist = tidyTrackTitle(rawArtist)
    .replace(/\s*-\s*Topic$/i, '')      // YouTube auto-generated artist channels
    .replace(/\bVEVO$/i, '')
    .trim();

  if (!title) {
    // Nothing usable came back. The video id is unique, so even a total metadata
    // failure produces a distinct, re-identifiable filename.
    return buildSafeFilename(artist ? `${artist} - ${videoId}` : `MusicFlow_${videoId}`);
  }

  const haveArtist = artist && artist.length > 1;
  const titleHasArtist = haveArtist &&
    title.toLowerCase().replace(/\s+/g, '').includes(artist.toLowerCase().replace(/\s+/g, ''));

  return buildSafeFilename(haveArtist && !titleHasArtist ? `${title} - ${artist}` : title);
}

// Query strings are attacker-shaped input: cap the length before it reaches a
// filename or a response header.
function readTitleHint(value) {
  return typeof value === 'string' ? value.slice(0, 200) : '';
}

// Makes every `name` in the list unique, in place, comparing case-insensitively
// because Windows and macOS filesystems do. "Song.mp3" twice becomes "Song.mp3"
// and "Song (2).mp3"; the first occurrence is never renamed.
function dedupeEntryNames(entries) {
  const used = new Map();
  for (const entry of entries) {
    const original = entry.name;
    const dot = original.lastIndexOf('.');
    const stem = dot > 0 ? original.slice(0, dot) : original;
    const ext = dot > 0 ? original.slice(dot) : '';

    let candidate = original;
    let key = candidate.toLowerCase();
    let n = 1;
    while (used.has(key)) {
      n++;
      candidate = `${stem} (${n})${ext}`;
      key = candidate.toLowerCase();
    }
    used.set(key, true);
    entry.name = candidate;
  }
  return entries;
}

// After yt-dlp/ffmpeg runs, the produced container is not always the extension we
// guessed: a merge can land as .mkv, a remux changes it, and progressive fallbacks
// pick whatever YouTube served. So instead of trusting "<prefix>.mp4", find the
// real artefact and report its true extension. Closes a class of silent failures
// where the file existed under an unexpected name and looked like a total failure.
function findDownloadOutput(tempPrefix) {
  const dir = path.dirname(tempPrefix);
  const base = path.basename(tempPrefix) + '.';
  let files;
  try { files = fs.readdirSync(dir); } catch (e) { return null; }
  let best = null, bestSize = -1;
  for (const f of files) {
    if (!f.startsWith(base)) continue;
    if (/\.(part|ytdl|temp|json|jpg|jpeg|png|webp|description)$/i.test(f)) continue;
    const full = path.join(dir, f);
    let sz;
    try { sz = fs.statSync(full).size; } catch (e) { continue; }
    if (sz > bestSize) { bestSize = sz; best = full; }
  }
  return best;
}

// Confirms a file actually carries a real (non-cover-art) video stream AND reads
// its frame height, in a single ffmpeg call. Uses the resolved ffmpeg binary — no
// separate ffprobe needed, which matters because ffmpeg-static ships ffmpeg only.
// Fail-open: hasVideo is null when it can't tell, so a probe hiccup never turns a
// good download into a failed one. height is null when unknown.
function probeVideoStream(filePath) {
  try {
    const r = spawnSync(ffmpegPath, ['-hide_banner', '-i', filePath], {
      timeout: 20000, windowsHide: true, encoding: 'utf8',
    });
    const out = `${r.stderr || ''}\n${r.stdout || ''}`;
    if (!out.trim()) return { hasVideo: null, height: null };
    const videoLines = out.split(/\r?\n/).filter(l => /Stream #.*Video:/i.test(l));
    if (!videoLines.length) return { hasVideo: false, height: null };
    // A thumbnail embedded in an audio file appears as an mjpeg/png "attached pic"
    // — that is cover art, not a real video track.
    const realLines = videoLines.filter(l => !/attached pic|mjpeg|\bpng\b|\bcover\b/i.test(l));
    if (!realLines.length) return { hasVideo: false, height: null };
    // Pull the frame size ("1920x1080") off the video line; height is the 2nd
    // number. SAR/DAR ratios use ':' so they don't match the NxN pattern. Take the
    // largest height seen in case multiple resolutions are listed.
    let height = null;
    for (const l of realLines) {
      const re = /\b(\d{2,5})x(\d{2,5})\b/g;
      let m;
      while ((m = re.exec(l)) !== null) {
        const h = parseInt(m[2], 10);
        if (Number.isFinite(h) && h >= 16 && h <= 8640 && (height === null || h > height)) {
          height = h;
        }
      }
    }
    return { hasVideo: true, height };
  } catch (e) {
    return { hasVideo: null, height: null };
  }
}

app.get('/api/download/:videoId', async (req, res) => {
  const { videoId } = req.params;

  if (!isYouTubeId(videoId)) {
    return res.status(400).json({ error: 'Invalid YouTube ID' });
  }
  if (activeDownloadCount >= MAX_CONCURRENT_DOWNLOADS) {
    return res.status(429).json({ error: 'Too many downloads in progress. Please try again shortly.' });
  }

  // Reserved up front and released by exactly one cleanup() call. Previously the
  // counter was incremented inside the try block and never decremented if
  // anything threw before the execFile callback ran, so after two failures the
  // endpoint returned 429 forever until restart.
  activeDownloadCount++;
  const tempPrefix = path.join(tempDownloadsDir, `dl_${videoId}_${Date.now()}`);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    // Goes through the shared release so any queued batch job wakes up.
    releaseDownloadSlot();
    let files = [];
    try {
      files = fs.readdirSync(tempDownloadsDir);
    } catch (e) {
      return;
    }
    const prefix = path.basename(tempPrefix);
    for (const file of files) {
      if (!file.startsWith(prefix)) continue;
      try {
        fs.unlinkSync(path.join(tempDownloadsDir, file));
      } catch (cleanupError) {
        // On Windows the file may still be open; the 24h sweep will get it.
      }
    }
  };

  try {
    // The client already knows the title from the search result that produced this
    // click, so a metadata failure no longer has to guess. This used to default to
    // the literal string 'Track', which is why repeat downloads piled up as
    // "Track.mp3", "Track (1).mp3", "Track (2).mp3".
    const hintedTitle = readTitleHint(req.query.title);
    const hintedArtist = readTitleHint(req.query.artist);

    // Format and quality from client (defaults preserve backward compatibility)
    const dlFormat = (req.query.format === 'video') ? 'video' : 'audio';
    const ALLOWED_AUDIO_Q = ['128', '192', '320'];
    const ALLOWED_VIDEO_Q = ['480', '720', '1080', '1440', '2160'];
    let dlQuality;
    if (dlFormat === 'audio') {
      dlQuality = ALLOWED_AUDIO_Q.includes(req.query.quality) ? req.query.quality : '192';
    } else {
      dlQuality = ALLOWED_VIDEO_Q.includes(req.query.quality) ? req.query.quality : '1080';
    }

    const isVideo = dlFormat === 'video';
    const fileExt = isVideo ? 'mp4' : 'mp3';

    let info = {};
    try {
      // For video, enumerate with the web-first client (VIDEO_YTDLP_ARGS) — the
      // android client under-reports the DASH ladder, which would make the clamp
      // below think a genuine 4K video tops out at 360p. Must match the client the
      // download itself uses so "available" equals "downloadable".
      const infoStdout = await runYtDlp([
        `https://www.youtube.com/watch?v=${videoId}`,
        '--dump-json', '--no-warnings', '--skip-download',
      ], 10000, isVideo ? VIDEO_YTDLP_ARGS : BASE_YTDLP_ARGS);
      if (infoStdout) info = JSON.parse(infoStdout) || {};
    } catch (e) {}

    // Remember what the user asked for so the response can say plainly when the
    // track simply doesn't offer it.
    const requestedQuality = dlQuality;
    let availMaxHeight = 0;
    if (isVideo) {
      // Cap the requested height to what the track actually offers. Asking for 2K
      // on a video whose best is 1080p used to let yt-dlp's fallback cascade slide
      // all the way to a 360p progressive stream; capping to the real ceiling makes
      // it fetch the true best (1080p here) and keeps the returned header honest.
      availMaxHeight = parseAvailableHeights(info).maxHeight;
      if (availMaxHeight > 0 && Number(dlQuality) > availMaxHeight) {
        dlQuality = String(availMaxHeight);
      }
    }

    const safeTitle = buildTrackFilename(
      info.title || hintedTitle,
      info.artist || info.creator || info.uploader || info.channel || hintedArtist,
      videoId
    );

    let dlArgs;
    if (isVideo) {
      // Best video up to the requested height + best audio, merged to MP4. The
      // fallback chain widens step by step so we still return real video when the
      // exact mp4/m4a pair or the height cap can't be met, only dropping to a
      // progressive/best single file as a last resort.
      dlArgs = [
        ...VIDEO_YTDLP_ARGS,
        '--ffmpeg-location', ffmpegPath,
        '--no-part',
        '--no-progress',
        // Rank candidates by resolution first (then fps, then h264/mp4 for broad
        // compatibility) so within the height cap yt-dlp takes the *largest* frame
        // available instead of whatever it happened to list first. The old ordering
        // is what let a 1440p request collapse to a 360p progressive stream.
        '--format-sort', 'res,fps,vcodec:h264,ext:mp4:m4a',
        '-f',
        `bestvideo[height<=${dlQuality}][ext=mp4]+bestaudio[ext=m4a]/` +
        `bestvideo[height<=${dlQuality}]+bestaudio/` +
        `best[height<=${dlQuality}][ext=mp4]/best[height<=${dlQuality}]/` +
        `bestvideo+bestaudio/best`,
        '--merge-output-format', 'mp4',
        '-o', `${tempPrefix}.%(ext)s`,
        `https://www.youtube.com/watch?v=${videoId}`
      ];
    } else {
      // Audio download: extract audio as MP3 with selected bitrate
      dlArgs = [
        ...BASE_YTDLP_ARGS,
        '--ffmpeg-location', ffmpegPath,
        '--no-part',
        '--no-progress',
        '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
        '-x', '--audio-format', 'mp3',
        '--audio-quality', `${dlQuality}K`,
        '-o', `${tempPrefix}.%(ext)s`,
        `https://www.youtube.com/watch?v=${videoId}`
      ];
    }

    // Video downloads (especially 4K) can take much longer than audio
    const execTimeout = isVideo ? 600000 : 180000;

    execFile(ytDlpPath, dlArgs, {
      timeout: execTimeout,
      windowsHide: true,
      // Without an explicit maxBuffer this inherits the 1MB default; a chatty
      // yt-dlp/ffmpeg run would blow past it and kill an otherwise fine download.
      maxBuffer: 10 * 1024 * 1024,
    }, (err, _stdout, stderr) => {
      // Don't trust a fixed "<prefix>.<ext>" — find what yt-dlp actually wrote.
      const targetFile = findDownloadOutput(tempPrefix);

      if (err || !targetFile) {
        console.error('[Download Error]', err ? `${err.message}: ${String(stderr || '').trim()}` : 'File creation failed');
        cleanup();
        if (!res.headersSent) res.status(500).json({ error: `${isVideo ? 'Video' : 'MP3'} download failed` });
        return;
      }

      let stat;
      try {
        stat = fs.statSync(targetFile);
      } catch (statErr) {
        cleanup();
        if (!res.headersSent) res.status(500).json({ error: `${isVideo ? 'Video' : 'MP3'} download failed` });
        return;
      }

      // The real extension of the produced file drives the name and content type,
      // so a .mkv/.webm merge is served honestly instead of being mislabelled .mp4.
      const actualExt = (path.extname(targetFile).replace(/^\./, '') || fileExt).toLowerCase();
      const outExt = isVideo
        ? (['mp4', 'mkv', 'webm', 'mov'].includes(actualExt) ? actualExt : 'mp4')
        : 'mp3';
      const outContentType = isVideo
        ? (outExt === 'webm' ? 'video/webm' : outExt === 'mkv' ? 'video/x-matroska' : 'video/mp4')
        : 'audio/mpeg';

      // For a video request, confirm a genuine video stream actually came through.
      // Audio-only sources (e.g. "- Topic" uploads) and format-selection fallbacks
      // can yield an audio track in a video container; surface that honestly via a
      // header rather than handing back a silent "video". Fail-open (null = unknown).
      let videoAvailable = null;
      let videoHeight = null;
      if (isVideo) {
        const probe = probeVideoStream(targetFile);
        videoAvailable = probe.hasVideo;
        videoHeight = probe.height;
      }

      // HTTP header values cannot carry characters above U+00FF — Node throws
      // ERR_INVALID_CHAR. So the legacy `filename=` parameter gets an ASCII-only
      // fallback and the real Unicode title travels in RFC 5987 `filename*=`,
      // which every current browser prefers anyway.
      //
      // A wholly non-Latin title (Hindi, Tamil, CJK) strips to nothing here, so the
      // fallback is keyed on the video id rather than a shared constant — otherwise
      // every Hindi download would collide on one name and get "(1)"-suffixed.
      const asciiFallback = safeTitle
        .replace(/[^\x20-\x7e]/g, '')
        .replace(/["\\]/g, '')
        .replace(/\s+/g, ' ')
        .trim() || `MusicFlow_${videoId}`;
      const encodedFilename = encodeURIComponent(`${safeTitle}.${outExt}`);

      res.setHeader('Content-Type', outContentType);
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Disposition', `attachment; filename="${asciiFallback}.${outExt}"; filename*=UTF-8''${encodedFilename}`);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'X-Video-Available, X-Video-Height, X-Video-Requested, Content-Disposition');
      if (isVideo) {
        res.setHeader('X-Video-Available', videoAvailable === false ? 'false' : videoAvailable === true ? 'true' : 'unknown');
        if (typeof videoHeight === 'number' && videoHeight > 0) {
          res.setHeader('X-Video-Height', String(videoHeight));
        }
        // What the user asked for (before capping to the track's real ceiling) so
        // the client can say "2K wasn't available — saved 1080p, the best this track
        // has" instead of silently handing over a lower resolution.
        res.setHeader('X-Video-Requested', String(requestedQuality));
      }
      res.setHeader('Cache-Control', 'no-store');

      const stream = fs.createReadStream(targetFile);
      stream.pipe(res);

      // Cleanup is driven off the *response* finishing, not the read stream
      // ending. 'end' fires as soon as the last chunk is read, which on Windows
      // is before the handle is released — unlinkSync then threw EBUSY and the
      // temp file was never removed.
      res.on('finish', cleanup);
      res.on('close', cleanup);
      stream.on('error', (sErr) => {
        console.error('[Stream Error]', sErr.message);
        // Headers (incl. Content-Length) are already committed, so ending
        // normally would hand the client a truncated file that looks valid.
        try { res.destroy(sErr); } catch (e) {}
        cleanup();
      });
    });
  } catch (err) {
    console.error('[Download Exception]', err.message);
    cleanup();
    if (!res.headersSent) res.status(500).json({ error: 'Download failed' });
  }
});

// The stored-mode zip writer lives in lib/zip.js so it can be unit tested
// without booting the server.
const { writeStoredZip } = require('./lib/zip');

/* ------------------------------------------------------------------ */
/*  Playlist batch download jobs (zip)                                */
/* ------------------------------------------------------------------ */
// A full playlist can take many minutes to transcode, which is far too long to
// hold a single HTTP request open. So the client starts a job, polls progress,
// then fetches the finished archive.
const MAX_PLAYLIST_TRACKS = 50;
const JOB_RETENTION_MS = 30 * 60 * 1000;
const playlistJobs = new Map();

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of playlistJobs) {
    if (now - job.touchedAt < JOB_RETENTION_MS) continue;
    try { if (job.zipPath && fs.existsSync(job.zipPath)) fs.unlinkSync(job.zipPath); } catch (e) {}
    try { if (job.workDir && fs.existsSync(job.workDir)) fs.rmSync(job.workDir, { recursive: true, force: true }); } catch (e) {}
    playlistJobs.delete(id);
  }
}
setInterval(pruneJobs, 5 * 60 * 1000).unref();

// Transcodes one video to mp3 inside the job's work dir. Resolves null on any
// failure so one dead video cannot sink the whole playlist.
function transcodeTrack(videoId, workDir, index) {
  return new Promise((resolve) => {
    const prefix = path.join(workDir, `t${String(index).padStart(3, '0')}_${videoId}`);
    const dlArgs = [
      ...BASE_YTDLP_ARGS,
      '--ffmpeg-location', ffmpegPath,
      '--no-part',
      '--no-progress',
      '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
      '-x', '--audio-format', 'mp3',
      '--audio-quality', '192K',
      '-o', `${prefix}.%(ext)s`,
      `https://www.youtube.com/watch?v=${videoId}`
    ];
    execFile(ytDlpPath, dlArgs, {
      timeout: 180000,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, _stdout, stderr) => {
      const target = `${prefix}.mp3`;
      if (err || !fs.existsSync(target)) {
        console.error('[Playlist DL]', videoId, err ? `${err.message}: ${String(stderr || '').trim()}` : 'file missing');
        resolve(null);
        return;
      }
      try {
        // A zero-byte result would produce a valid-looking but empty archive
        // entry, so treat it as a failure.
        if (fs.statSync(target).size === 0) { resolve(null); return; }
      } catch (e) { resolve(null); return; }
      resolve(target);
    });
  });
}

async function runPlaylistJob(job) {
  job.status = 'downloading';
  const done = [];

  await mapConcurrent(job.tracks, MAX_BATCH_CONCURRENCY, async (track, i) => {
    if (job.cancelled) return null;

    await acquireDownloadSlot();
    if (job.cancelled) { releaseDownloadSlot(); return null; }

    job.current = track.title || track.id;
    job.touchedAt = Date.now();
    try {
      const file = await transcodeTrack(track.id, job.workDir, i);
      if (file) {
        done.push({ path: file, name: `${buildTrackFilename(track.title, track.artist, track.id)}.mp3`, index: i });
        job.completed++;
      } else {
        job.failed++;
        job.failedTitles.push(track.title || track.id);
      }
    } finally {
      releaseDownloadSlot();
      job.touchedAt = Date.now();
    }
    return null;
  });

  if (job.cancelled) {
    job.status = 'cancelled';
    try { fs.rmSync(job.workDir, { recursive: true, force: true }); } catch (e) {}
    return;
  }

  if (!done.length) {
    job.status = 'error';
    job.error = 'None of the tracks could be downloaded.';
    try { fs.rmSync(job.workDir, { recursive: true, force: true }); } catch (e) {}
    return;
  }

  job.status = 'zipping';
  job.current = 'Building archive';
  job.touchedAt = Date.now();
  try {
    // Preserve the playlist's own ordering, which mapConcurrent does not.
    done.sort((a, b) => a.index - b.index);
    // Two tracks with the same title (a remix next to its original, or two live
    // versions) would otherwise write two identical entry names into the archive,
    // and every extractor resolves that clash as "name (1).mp3" — the exact
    // pattern this pass is fixing. Numbering duplicates ourselves keeps the names
    // stable and meaningful instead of leaving it to the extractor.
    dedupeEntryNames(done);
    job.zipPath = path.join(tempDownloadsDir, `${job.id}.zip`);
    job.zipSize = await writeStoredZip(done, job.zipPath);
    job.status = 'ready';
  } catch (err) {
    console.error('[Playlist Zip]', err.message);
    job.status = 'error';
    job.error = 'Failed to build the archive.';
    try { if (job.zipPath && fs.existsSync(job.zipPath)) fs.unlinkSync(job.zipPath); } catch (e) {}
  } finally {
    // The individual mp3s are inside the zip now.
    try { fs.rmSync(job.workDir, { recursive: true, force: true }); } catch (e) {}
    job.current = null;
    job.touchedAt = Date.now();
  }
}

app.post('/api/playlist-download', (req, res) => {
  const body = req.body || {};
  const rawTracks = Array.isArray(body.tracks) ? body.tracks : [];

  // Only real YouTube ids can be transcoded; local and cloud entries are
  // filtered client-side but re-checked here so a stale client cannot wedge a job.
  const seen = new Set();
  const tracks = [];
  for (const t of rawTracks) {
    const id = t && typeof t.id === 'string' ? t.id : null;
    if (!id || !isYouTubeId(id) || seen.has(id)) continue;
    seen.add(id);
    tracks.push({
      id,
      title: typeof t.title === 'string' ? t.title : id,
      // Carried through so archive entries get "Song - Artist.mp3" like single
      // downloads do, instead of a bare title.
      artist: readTitleHint(t.artist || t.channel),
    });
    if (tracks.length >= MAX_PLAYLIST_TRACKS) break;
  }

  if (!tracks.length) {
    return res.status(400).json({ error: 'No downloadable YouTube tracks in this playlist.' });
  }

  // One active job at a time: two concurrent playlist jobs would fight over the
  // same conversion slots and both crawl.
  for (const job of playlistJobs.values()) {
    if (job.status === 'downloading' || job.status === 'zipping' || job.status === 'queued') {
      return res.status(409).json({ error: 'Another playlist download is already running.', jobId: job.id });
    }
  }

  pruneJobs();

  const id = `pl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const workDir = path.join(tempDownloadsDir, id);
  try {
    fs.mkdirSync(workDir, { recursive: true });
  } catch (err) {
    return res.status(500).json({ error: 'Could not create a working folder for the download.' });
  }

  const job = {
    id,
    name: buildSafeFilename(body.name || 'Playlist'),
    tracks,
    total: tracks.length,
    completed: 0,
    failed: 0,
    failedTitles: [],
    status: 'queued',
    current: null,
    error: null,
    zipPath: null,
    zipSize: 0,
    workDir,
    cancelled: false,
    createdAt: Date.now(),
    touchedAt: Date.now(),
  };
  playlistJobs.set(id, job);

  // Fire and forget; progress is observed through the status endpoint.
  runPlaylistJob(job).catch(err => {
    console.error('[Playlist Job]', err);
    job.status = 'error';
    job.error = 'Unexpected server error.';
    job.touchedAt = Date.now();
  });

  res.json({ jobId: id, total: job.total, skipped: rawTracks.length - tracks.length });
});

app.get('/api/playlist-download/:jobId', (req, res) => {
  const job = playlistJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired.' });
  job.touchedAt = Date.now();
  res.json({
    jobId: job.id,
    status: job.status,
    total: job.total,
    completed: job.completed,
    failed: job.failed,
    failedTitles: job.failedTitles.slice(0, 10),
    current: job.current,
    error: job.error,
    size: job.zipSize,
  });
});

app.post('/api/playlist-download/:jobId/cancel', (req, res) => {
  const job = playlistJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired.' });
  job.cancelled = true;
  job.touchedAt = Date.now();
  // A job that already produced an archive just gets the artifact dropped.
  if (job.status === 'ready' || job.status === 'downloaded') {
    try { if (job.zipPath && fs.existsSync(job.zipPath)) fs.unlinkSync(job.zipPath); } catch (e) {}
    job.zipPath = null;
    job.status = 'cancelled';
  }
  res.json({ ok: true });
});

app.get('/api/playlist-download/:jobId/file', (req, res) => {
  const job = playlistJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired.' });
  // 'downloaded' is accepted as well as 'ready': the archive is kept on disk
  // after the first send precisely so an interrupted save can be retried, and
  // rejecting the retry would defeat that.
  const deliverable = job.status === 'ready' || job.status === 'downloaded';
  if (!deliverable || !job.zipPath || !fs.existsSync(job.zipPath)) {
    return res.status(409).json({ error: 'Archive is not ready yet.' });
  }

  let stat;
  try {
    stat = fs.statSync(job.zipPath);
  } catch (err) {
    return res.status(500).json({ error: 'Archive is no longer available.' });
  }

  const asciiFallback = job.name.replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '').trim() || 'Playlist';
  const encoded = encodeURIComponent(`${job.name}.zip`);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Content-Disposition', `attachment; filename="${asciiFallback}.zip"; filename*=UTF-8''${encoded}`);
  res.setHeader('Cache-Control', 'no-store');

  const stream = fs.createReadStream(job.zipPath);
  stream.pipe(res);
  stream.on('error', (err) => {
    console.error('[Playlist Zip Stream]', err.message);
    // Content-Length is already committed, so ending cleanly would hand over a
    // truncated archive that looks complete.
    try { res.destroy(err); } catch (e) {}
  });

  // Keep the archive around after sending so an interrupted save can retry;
  // pruneJobs() reclaims it later.
  const markDelivered = () => {
    if (job.status === 'ready') job.status = 'downloaded';
    job.touchedAt = Date.now();
  };

  // Don't trust lifecycle events here. A client that closes as soon as it has
  // Content-Length bytes — curl does, and so do browsers on a completed save —
  // tears the socket down before the response settles, so 'close' can arrive
  // with both writableFinished and writableEnded false and 'finish' never firing
  // at all, even though every byte was delivered. Counting what actually went
  // out sidesteps the race: the final 'data' event lands before 'end', so the
  // total is already correct by the time 'close' fires. A transfer cut off
  // midway stops short of the full size and correctly stays 'ready' for retry.
  let sent = 0;
  stream.on('data', (chunk) => { sent += chunk.length; });
  res.on('finish', markDelivered);
  res.on('close', () => { if (sent === stat.size) markDelivered(); });
});

/* ------------------------------------------------------------------ */
/*  Persistent User Data Storage                                      */
/* ------------------------------------------------------------------ */
const dataDir = path.join(__dirname, 'data');
const userDataFile = path.join(dataDir, 'userData.json');

if (!fs.existsSync(dataDir)) {
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) {}
}

app.get('/api/user-data', (req, res) => {
  try {
    if (fs.existsSync(userDataFile)) {
      const data = fs.readFileSync(userDataFile, 'utf8');
      return res.json(JSON.parse(data || '{}'));
    }
    res.json({});
  } catch (err) {
    console.error('[UserData Get Error]', err.message);
    // Signal the failure instead of returning {}. A silent empty object looks
    // to the client like "server has no data", which invited it to overwrite a
    // perfectly good file with an empty one.
    res.status(500).json({ error: 'Stored user data could not be read' });
  }
});

// Saves are serialized through this promise chain. Two overlapping POSTs each
// did read-modify-write against the same file, so one could clobber the other's
// keys — and a crash mid-writeFileSync left a truncated, unparseable file.
let userDataWriteChain = Promise.resolve();

function saveUserData(patch) {
  const run = async () => {
    let current = {};
    try {
      if (fs.existsSync(userDataFile)) {
        current = JSON.parse(await fs.promises.readFile(userDataFile, 'utf8') || '{}');
      }
    } catch (e) {
      console.warn('[UserData] Existing file unreadable, starting fresh:', e.message);
      current = {};
    }
    if (!current || typeof current !== 'object' || Array.isArray(current)) current = {};

    const updated = { ...current, ...patch, lastSaved: new Date().toISOString() };

    // Write to a sibling temp file then rename. rename() is atomic, so a reader
    // sees either the old file or the new one — never a half-written one.
    const tmpFile = `${userDataFile}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmpFile, JSON.stringify(updated, null, 2), 'utf8');
    await fs.promises.rename(tmpFile, userDataFile);
    return updated.lastSaved;
  };

  const result = userDataWriteChain.then(run, run);
  // Keep the chain alive even when a write rejects.
  userDataWriteChain = result.catch(() => {});
  return result;
}

app.post('/api/user-data', async (req, res) => {
  const patch = req.body;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return res.status(400).json({ error: 'Body must be a JSON object' });
  }
  try {
    const lastSaved = await saveUserData(patch);
    res.json({ success: true, lastSaved });
  } catch (err) {
    console.error('[UserData Save Error]', err.message);
    res.status(500).json({ error: 'Failed to save data' });
  }
});

/* ------------------------------------------------------------------ */
/*  POST /api/archive-session — Archive current session for restart   */
/* ------------------------------------------------------------------ */
const archivesDir = path.join(dataDir, 'archives');

app.post('/api/archive-session', async (req, res) => {
  const sessionData = req.body;
  if (!sessionData || typeof sessionData !== 'object') {
    return res.status(400).json({ error: 'Body must be a JSON object' });
  }

  try {
    if (!fs.existsSync(archivesDir)) {
      fs.mkdirSync(archivesDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveFile = path.join(archivesDir, `session_${timestamp}.json`);
    const archivePayload = {
      archivedAt: new Date().toISOString(),
      ...sessionData,
    };

    await fs.promises.writeFile(archiveFile, JSON.stringify(archivePayload, null, 2), 'utf8');

    // Clean old archives (keep last 20)
    try {
      const files = fs.readdirSync(archivesDir)
        .filter(f => f.startsWith('session_') && f.endsWith('.json'))
        .sort()
        .reverse();
      for (const old of files.slice(20)) {
        try { fs.unlinkSync(path.join(archivesDir, old)); } catch (e) {}
      }
    } catch (e) {}

    res.json({ success: true, archiveFile: path.basename(archiveFile) });
  } catch (err) {
    console.error('[Archive Session Error]', err.message);
    res.status(500).json({ error: 'Failed to archive session' });
  }
});

/* ------------------------------------------------------------------ */
/*  GET /api/network-info - Returns local IP or Cloud Public URL      */
/* ------------------------------------------------------------------ */
function getLocalNetworkAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

app.get('/api/network-info', (req, res) => {
  const isCloud = !!(process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.VERCEL || process.env.FLY_APP_NAME || process.env.PORT);
  const cloudUrl = process.env.RENDER_EXTERNAL_URL || process.env.RAILWAY_STATIC_URL || (req.headers.host ? `https://${req.headers.host}` : null);

  const ips = getLocalNetworkAddresses();
  res.json({
    port: PORT,
    isCloud,
    cloudUrl: cloudUrl || null,
    localUrl: `http://localhost:${PORT}`,
    ips,
    networkUrls: ips.map(ip => `http://${ip}:${PORT}`),
    primaryNetworkUrl: isCloud && cloudUrl ? cloudUrl : (ips.length > 0 ? `http://${ips[0]}:${PORT}` : `http://localhost:${PORT}`)
  });
});

/* ------------------------------------------------------------------ */
/*  POST /api/mood-mix — AI Mood-Based Music Resolution               */
/* ------------------------------------------------------------------ */
app.post('/api/mood-mix', async (req, res) => {
  const queries = req.body.queries;
  const energy = req.body.energy || 2;

  if (!Array.isArray(queries) || queries.length === 0) {
    return res.status(400).json({ error: 'Queries array is required' });
  }

  const cleanQueries = queries
    .map(q => (typeof q === 'string' ? q.trim() : ''))
    .filter(Boolean)
    .slice(0, 6);

  try {
    const rawResults = await mapConcurrent(cleanQueries, 4, async (query) => {
      try {
        const stdout = await runYtDlp([
          `ytsearch8:${query}`,
          '--dump-json', '--flat-playlist', '--no-warnings',
          '--default-search', 'ytsearch', '--skip-download',
        ], 15000);
        if (!stdout) return [];
        return stdout.split('\n').filter(Boolean).map(line => {
          try {
            const d = JSON.parse(line);
            return {
              id: d.id || d.url,
              title: d.title || 'Unknown',
              channel: d.channel || d.uploader || 'Unknown',
              duration: d.duration || 0,
              thumbnail: d.thumbnails ? d.thumbnails[d.thumbnails.length - 1]?.url
                : `https://i.ytimg.com/vi/${d.id}/hqdefault.jpg`,
              views: d.view_count || 0,
            };
          } catch { return null; }
        }).filter(Boolean).filter(item => isYouTubeId(item.id));
      } catch {
        return [];
      }
    });

    const seen = new Set();
    const allSongs = [];
    rawResults.flat().forEach(s => {
      if (s && s.id && !seen.has(s.id)) {
        seen.add(s.id);
        const dur = Number(s.duration) || 0;
        if (dur >= 60 && dur <= 600) {
          allSongs.push(s);
        }
      }
    });

    // Sort by relevance score
    const scored = allSongs.map(item => ({
      item,
      score: scoreSong(item, cleanQueries[0] || '', true),
    })).sort((a, b) => b.score - a.score);

    // Energy filter: for low energy, prefer longer/calmer; for high, prefer shorter/energetic
    let filtered = scored.map(s => s.item);
    if (energy <= 1) {
      filtered = filtered.filter(s => (s.duration || 0) >= 120);
    } else if (energy >= 4) {
      filtered = filtered.filter(s => (s.duration || 0) <= 360);
    }

    // Shuffle top results
    const top = filtered.slice(0, 24);
    for (let i = top.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [top[i], top[j]] = [top[j], top[i]];
    }

    res.json({ total: allSongs.length, results: top.slice(0, 20) });
  } catch (err) {
    console.error('[MoodMix]', err.message);
    res.status(500).json({ error: 'Mood mix generation failed' });
  }
});

/* ------------------------------------------------------------------ */
/*  SPA fallback                                                      */
/* ------------------------------------------------------------------ */
// Unknown API routes must 404 as JSON. The blanket '*' handler used to serve
// index.html with a 200, so a typo'd or removed endpoint surfaced in the client
// as "Unexpected token '<' in JSON" instead of a readable error.
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Unknown API endpoint: ${req.method} /api${req.path}` });
});

app.get('*', (req, res) => {
  // A missing asset must not be answered with index.html and a 200. That is how
  // a renamed script ends up "loading" successfully and then dying on the first
  // '<' of the HTML it actually received.
  if (/\.[a-z0-9]{1,8}$/i.test(req.path) && !/\.html?$/i.test(req.path)) {
    return res.status(404).type('text/plain').send('Not found');
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const initialPort = parseInt(process.env.PORT || '3000', 10);
let activePort = initialPort;

// The desktop launcher needs to know which port was actually bound, because
// listenOnPort() walks upward when 3000 is already taken. Without this the
// shortcut opened localhost:3000 and showed whatever unrelated dev server
// happened to be there.
const RUNTIME_FILE = path.join(__dirname, 'data', 'runtime.json');

function publishRuntimeInfo(port) {
  try {
    fs.mkdirSync(path.dirname(RUNTIME_FILE), { recursive: true });
    fs.writeFileSync(RUNTIME_FILE, JSON.stringify({
      app: 'musicflow',
      port,
      pid: process.pid,
      url: `http://localhost:${port}`,
      startedAt: new Date().toISOString()
    }, null, 2));
  } catch (e) {
    // Non-fatal: the launcher falls back to scanning the port range.
    console.warn('[MusicFlow] ⚠️ Could not write runtime info:', e.message);
  }
}

function listenOnPort(port, maxTries = 10) {
  const server = http.createServer(app);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && maxTries > 0) {
      console.warn(`[MusicFlow] ⚠️ Port ${port} in use. Trying fallback port ${port + 1}...`);
      listenOnPort(port + 1, maxTries - 1);
    } else {
      console.error('[MusicFlow Server Error]', err.message);
    }
  });

  server.listen(port, HOST, () => {
    activePort = port;
    publishRuntimeInfo(port);
    console.log('\n============================================================');
    console.log(`  🎵  MusicFlow v3.0 Desktop — High-Performance Music Engine`);
    console.log('============================================================');
    console.log(`  💻  Local Desktop App:       http://localhost:${port}`);
    console.log(`  🌐  Network Host:            http://${HOST}:${port}`);
    console.log('============================================================\n');
    // Kick off binary resolution immediately. Requests arriving before this
    // finishes now await the same promise rather than shelling out to a
    // yt-dlp that isn't on disk yet.
    whenYtDlpReady().then(() => {
      // Populate the version for /api/health, then consider a background refresh
      // so a stale binary (the usual cause of "only one resolution downloads")
      // heals itself without the user opening a terminal.
      getYtDlpVersion().then((v) => { if (v) ytDlpVersion = v; }).catch(() => {});
      setTimeout(maybeAutoUpdateYtDlp, 8000).unref?.();
    }).catch(() => {});
  });
}

listenOnPort(initialPort);
