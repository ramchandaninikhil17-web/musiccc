const express = require('express');
const cors = require('cors');
const { execFile, spawn } = require('child_process');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const ffmpegPath = require('ffmpeg-static');

let YTDlpWrap;
try {
  YTDlpWrap = require('yt-dlp-wrap').default || require('yt-dlp-wrap');
} catch (e) {
  // Optional fallback
}

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));

/* ------------------------------------------------------------------ */
/*  Standard Extractor & User-Agent Arguments for Cloud Anti-Bot Bypass*/
/* ------------------------------------------------------------------ */
const BASE_YTDLP_ARGS = [
  '--geo-bypass',
  '--no-check-certificates',
  '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  '--no-playlist',
  '--format-sort', 'ext:mp4:m4a'
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
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    ytDlpReady: ytDlpPath ? true : false,
  });
});

/* ------------------------------------------------------------------ */
/*  Resolve yt-dlp binary path & Auto-Download if missing             */
/* ------------------------------------------------------------------ */
let ytDlpPath = 'yt-dlp';

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
      console.log(`[MusicFlow] ✅ yt-dlp binary ready: ${ytDlpPath}`);
      return;
    }

    // Check if available in system PATH
    try {
      const check = require('child_process').spawnSync('yt-dlp', ['--version'], { windowsHide: true });
      if (check && check.status === 0) {
        ytDlpPath = 'yt-dlp';
        console.log('[MusicFlow] ✅ Using system yt-dlp from PATH');
        return;
      }
    } catch (e) {}

    // Not found locally or in PATH -> auto-download from official GitHub releases
    if (YTDlpWrap && typeof YTDlpWrap.downloadFromGithub === 'function') {
      console.log('[MusicFlow] ⬇️ yt-dlp binary not found. Downloading latest official release from GitHub...');
      await YTDlpWrap.downloadFromGithub(rootBinary);
      if (!isWin) {
        try { fs.chmodSync(rootBinary, '755'); } catch (e) {}
      }
      ytDlpPath = rootBinary;
      console.log(`[MusicFlow] ✅ yt-dlp downloaded successfully: ${ytDlpPath}`);
    }
  } catch (err) {
    console.warn(`[MusicFlow] ⚠️ Auto-download of yt-dlp note: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Helper: run yt-dlp with cloud anti-bot args                       */
/* ------------------------------------------------------------------ */
function runYtDlp(args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const fullArgs = [...BASE_YTDLP_ARGS, ...args];
    execFile(ytDlpPath, fullArgs, {
      maxBuffer: 10 * 1024 * 1024,
      timeout,
      windowsHide: true,
    }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
}

function isYouTubeId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(id.trim());
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
    }).filter(Boolean);

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
  const query = req.query.q;
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
    }).filter(Boolean);

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
  const query = req.query.q;
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
        }).filter(Boolean);
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
  const query = req.query.q;
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
    }).filter(Boolean);

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
/*  GET /api/stream/:videoId?quality=low|high                         */
/*  Multi-Tier Audio Proxy: yt-dlp Direct -> Pipe -> Serverless API    */
/* ------------------------------------------------------------------ */
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 50,
  rejectUnauthorized: false,
});

app.get('/api/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const quality = req.query.quality || 'high';

  if (!isYouTubeId(videoId)) {
    return res.status(400).json({ error: 'Invalid YouTube ID for yt-dlp stream' });
  }

  const formatMap = {
    low: 'worstaudio[ext=m4a]/worstaudio/worst',
    high: 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
  };

  // Tier 1: Try direct audio URL extraction via yt-dlp
  try {
    const audioUrl = await runYtDlp([
      `https://www.youtube.com/watch?v=${videoId}`,
      '-f', formatMap[quality] || formatMap.high,
      '-g', '--no-warnings',
    ], 45000);

    if (audioUrl && audioUrl.startsWith('http')) {
      return fetchAndProxyAudio(audioUrl, req, res, videoId, 0);
    }
  } catch (err) {
    console.warn(`[Stream Tier 1 Warning for ${videoId}]`, err.message);
  }

  // Tier 2: Try direct stdout pipe via yt-dlp
  streamViaPipeFallback(videoId, req, res);
});

function fetchAndProxyAudio(targetUrl, req, res, videoId, redirectCount = 0) {
  if (redirectCount > 4 || res.headersSent) {
    return streamViaPipeFallback(videoId, req, res);
  }

  try {
    const parsedUrl = new URL(targetUrl);
    const isHttps = parsedUrl.protocol === 'https:';
    const protocol = isHttps ? https : http;

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Referer': 'https://www.youtube.com/',
      'Origin': 'https://www.youtube.com',
      'Host': parsedUrl.host,
      'Connection': 'keep-alive',
    };
    if (req.headers.range) headers['Range'] = req.headers.range;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers,
      agent: isHttps ? httpsAgent : undefined,
    };

    const proxyReq = protocol.request(options, (proxyRes) => {
      // Follow HTTP redirects
      if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
        return fetchAndProxyAudio(proxyRes.headers.location, req, res, videoId, redirectCount + 1);
      }

      // If YouTube CDN returns HTTP >= 400, fallback to pipe
      if (proxyRes.statusCode >= 400) {
        console.warn(`[Stream Proxy] CDN HTTP ${proxyRes.statusCode}, trying pipe fallback...`);
        return streamViaPipeFallback(videoId, req, res);
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
        if (!res.headersSent) streamViaPipeFallback(videoId, req, res);
      });
    });

    proxyReq.on('error', (err) => {
      console.warn(`[Proxy Req Error - ${err.code || err.message}]`);
      if (!res.headersSent) {
        streamViaPipeFallback(videoId, req, res);
      }
    });

    req.on('close', () => {
      try { proxyReq.destroy(); } catch (e) {}
    });

    proxyReq.end();
  } catch (err) {
    console.warn('[Stream Proxy Exception]', err.message);
    if (!res.headersSent) streamViaPipeFallback(videoId, req, res);
  }
}

// Tier 2: Direct stream via yt-dlp stdout pipe if YouTube CDN URL drops socket
function streamViaPipeFallback(videoId, req, res) {
  if (res.headersSent) return;

  try {
    const streamProcess = spawn(ytDlpPath, [
      ...BASE_YTDLP_ARGS,
      `https://www.youtube.com/watch?v=${videoId}`,
      '-f', 'bestaudio[ext=webm]/bestaudio/worst',
      '-o', '-',
      '--no-warnings',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });

    let headersSet = false;

    streamProcess.stdout.on('data', (chunk) => {
      if (!headersSet && !res.headersSent) {
        headersSet = true;
        res.writeHead(200, {
          'Content-Type': 'audio/webm',
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        });
      }
    });

    streamProcess.stdout.pipe(res);

    streamProcess.on('error', (err) => {
      console.warn('[Pipe Process Error]', err.message);
      if (!res.headersSent && !headersSet) {
        streamViaServerlessApi(videoId, res);
      }
    });

    streamProcess.on('close', (code) => {
      if (code !== 0 && !res.headersSent && !headersSet) {
        console.warn(`[Pipe Process Close] Non-zero exit ${code}`);
        streamViaServerlessApi(videoId, res);
      } else if (!res.headersSent && !headersSet) {
         streamViaServerlessApi(videoId, res);
      }
      res.end();
    });

    res.on('close', () => {
      try { streamProcess.kill('SIGTERM'); } catch (e) {}
    });
  } catch (e) {
    if (!res.headersSent) streamViaServerlessApi(videoId, res);
  }
}

// Tier 3: Serverless Piped / Invidious API Fallback (Works on Vercel / Cloud Functions with 0 binaries!)
async function streamViaServerlessApi(videoId, res) {
  if (res.headersSent) return;

  const apis = [
    `https://pipedapi.kavin.rocks/streams/${videoId}`,
    `https://api.piped.video/streams/${videoId}`,
    `https://invidious.privacydev.net/api/v1/videos/${videoId}`,
  ];

  for (const apiUrl of apis) {
    try {
      const data = await new Promise((resolve, reject) => {
        const r = https.get(apiUrl, { timeout: 6000, agent: httpsAgent }, (resp) => {
          let body = '';
          resp.on('data', c => body += c);
          resp.on('end', () => {
            try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
          });
        });
        r.on('error', reject);
        r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
      });

      const audioStreams = data.audioStreams || data.adaptiveFormats;
      if (Array.isArray(audioStreams) && audioStreams.length > 0) {
        const bestStream = audioStreams.find(s => s.mimeType && s.mimeType.includes('audio/mp4')) || audioStreams[0];
        if (bestStream && bestStream.url) {
          if (!res.headersSent) {
            return res.redirect(302, bestStream.url);
          }
        }
      }
    } catch (err) {
      // try next API endpoint
    }
  }

  if (!res.headersSent) {
    res.status(500).json({ error: 'Audio stream unavailable' });
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

app.get('/api/download/:videoId', async (req, res) => {
  const { videoId } = req.params;

  if (!isYouTubeId(videoId)) {
    return res.status(400).json({ error: 'Invalid YouTube ID' });
  }

  try {
    let info = { title: 'Track', channel: '' };
    try {
      const infoStdout = await runYtDlp([
        `https://www.youtube.com/watch?v=${videoId}`,
        '--dump-json', '--no-warnings', '--skip-download',
      ], 10000);
      if (infoStdout) info = JSON.parse(infoStdout);
    } catch (e) {}

    const safeTitle = (info.title || 'MusicFlow_Track')
      .replace(/[^a-zA-Z0-9\s\-_.()\[\]]/g, '')
      .replace(/\s+/g, ' ')
      .trim() || 'Track';

    const tempPrefix = path.join(tempDownloadsDir, `dl_${videoId}_${Date.now()}`);
    const dlArgs = [
      '--geo-bypass',
      '--no-check-certificates',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      '--no-playlist',
      '--ffmpeg-location', ffmpegPath,
      '-x', '--audio-format', 'mp3',
      '--audio-quality', '192K',
      '-o', `${tempPrefix}.%(ext)s`,
      `https://www.youtube.com/watch?v=${videoId}`
    ];

    execFile(ytDlpPath, dlArgs, { timeout: 120000 }, (err) => {
      const targetMp3 = `${tempPrefix}.mp3`;

      if (err || !fs.existsSync(targetMp3)) {
        console.error('[Download Error]', err ? err.message : 'File creation failed');
        if (!res.headersSent) res.status(500).json({ error: 'MP3 download failed' });
        return;
      }

      const stat = fs.statSync(targetMp3);
      const encodedFilename = encodeURIComponent(safeTitle);
      
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Disposition', `attachment; filename="${encodedFilename}.mp3"; filename*=UTF-8''${encodedFilename}.mp3`);
      res.setHeader('Access-Control-Allow-Origin', '*');

      const stream = fs.createReadStream(targetMp3);
      stream.pipe(res);

      const cleanup = () => {
        try { if (fs.existsSync(targetMp3)) fs.unlinkSync(targetMp3); } catch (e) {}
      };

      stream.on('end', cleanup);
      stream.on('error', (sErr) => {
        console.error('[Stream Error]', sErr.message);
        cleanup();
      });
      req.on('close', cleanup);
    });
  } catch (err) {
    console.error('[Download Exception]', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Download failed' });
  }
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
    res.json({});
  }
});

app.post('/api/user-data', (req, res) => {
  try {
    let current = {};
    if (fs.existsSync(userDataFile)) {
      try { current = JSON.parse(fs.readFileSync(userDataFile, 'utf8') || '{}'); } catch (e) {}
    }
    const updated = { ...current, ...req.body, lastSaved: new Date().toISOString() };
    fs.writeFileSync(userDataFile, JSON.stringify(updated, null, 2), 'utf8');
    res.json({ success: true, lastSaved: updated.lastSaved });
  } catch (err) {
    console.error('[UserData Save Error]', err.message);
    res.status(500).json({ error: 'Failed to save data' });
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
/*  SPA fallback                                                      */
/* ------------------------------------------------------------------ */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const initialPort = parseInt(process.env.PORT || '3000', 10);

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

  server.listen(port, HOST, async () => {
    await ensureYtDlp();
    console.log('\n============================================================');
    console.log(`  🎵  MusicFlow v2.5 Desktop — High-Performance Music Engine`);
    console.log('============================================================');
    console.log(`  💻  Local Desktop App:       http://localhost:${port}`);
    console.log(`  🌐  Network Host:            http://${HOST}:${port}`);
    console.log('============================================================\n');
  });
}

listenOnPort(initialPort);
