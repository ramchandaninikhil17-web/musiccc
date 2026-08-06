const express = require('express');
const cors = require('cors');
const { execFile, spawn } = require('child_process');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');
const ffmpegPath = require('ffmpeg-static');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/*  Resolve yt-dlp binary path                                        */
/* ------------------------------------------------------------------ */
let ytDlpPath = 'yt-dlp';

try {
  const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const rootBinary = path.join(__dirname, binaryName);
  if (fs.existsSync(rootBinary)) ytDlpPath = rootBinary;
} catch (e) { /* fallback to PATH */ }

console.log(`[MusicFlow] yt-dlp: ${ytDlpPath}`);

/* ------------------------------------------------------------------ */
/*  Helper: run yt-dlp                                                */
/* ------------------------------------------------------------------ */
function runYtDlp(args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(ytDlpPath, args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout,
      windowsHide: true,
    }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
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
      score += Math.min(450, Math.log10(views + 1) * 50); // 100M views -> ~400 pts
    }

    // 6. Optimal Music Track Duration (1:20 to 7:00 is normal song range)
    const dur = Number(item.duration) || 0;
    if (dur >= 80 && dur <= 450) {
      score += 150;
    } else if (dur > 600) {
      score -= 350; // likely a full album, DJ set, or 1-hour loop
    } else if (dur < 50 && dur > 0) {
      score -= 250; // likely a short, teaser, or ringtone
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

  // Add search term hint if query doesn't specify
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

    // Score and rank all items
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
/*  Body: { queries: string[], preferOfficial?: boolean }             */
/* ------------------------------------------------------------------ */
app.post('/api/batch-search', async (req, res) => {
  const queries = req.body.queries;
  const preferOfficial = req.body.preferOfficial !== false;

  if (!Array.isArray(queries) || queries.length === 0) {
    return res.status(400).json({ error: 'Queries array is required' });
  }

  // Sanitize and limit to 40 items max per batch
  const cleanQueries = queries
    .map(q => (typeof q === 'string' ? q.trim() : ''))
    .filter(Boolean)
    .slice(0, 40);

  try {
    // Run concurrent queries with limit of 4
    const resolvedList = await mapConcurrent(cleanQueries, 4, async (q) => {
      const res = await performSingleSmartSearch(q, preferOfficial);
      return res ? { query: q, song: res.bestMatch, candidates: res.candidates } : null;
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
/*  Query: seedArtists=Arijit Singh,The Weeknd & seedQueries=...      */
/* ------------------------------------------------------------------ */
app.get('/api/recommendations', async (req, res) => {
  const seedArtists = req.query.seedArtists ? String(req.query.seedArtists).split(',').map(s => s.trim()).filter(Boolean) : [];
  const seedQueries = req.query.seedQueries ? String(req.query.seedQueries).split(',').map(s => s.trim()).filter(Boolean) : [];

  const cacheKey = `rec_${seedArtists.slice(0, 3).sort().join('_')}_${seedQueries.slice(0, 3).sort().join('_')}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  // Determine search queries based on seeds or defaults
  let searchPrompts = [];

  if (seedArtists.length > 0) {
    // Generate artist specific recommendation prompts
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

  // Fallbacks if no history seeds
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

    // Flatten, deduplicate by ID, filter out weird lengths
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

    // Shuffle slightly for organic variety
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
/*  GET /api/suggestions?q=...  (fast, 5 results, flat)               */
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
  try {
    const stdout = await runYtDlp([
      `https://www.youtube.com/watch?v=${req.params.videoId}`,
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
/* ------------------------------------------------------------------ */
app.get('/api/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const quality = req.query.quality || 'high';

  const formatMap = {
    low:  'worstaudio[ext=m4a]/worstaudio',
    high: 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
  };

  try {
    const audioUrl = await runYtDlp([
      `https://www.youtube.com/watch?v=${videoId}`,
      '-f', formatMap[quality] || formatMap.high,
      '-g', '--no-warnings',
    ], 15000);

    if (!audioUrl) return res.status(404).json({ error: 'No audio' });

    // Proxy the audio stream
    const parsedUrl = new URL(audioUrl);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };
    if (req.headers.range) headers['Range'] = req.headers.range;

    const proxyReq = protocol.get(audioUrl, { headers }, (proxyRes) => {
      const fwd = {
        'Content-Type': proxyRes.headers['content-type'] || 'audio/mp4',
        'Accept-Ranges': 'bytes',
      };
      if (proxyRes.headers['content-length']) fwd['Content-Length'] = proxyRes.headers['content-length'];
      if (proxyRes.headers['content-range']) fwd['Content-Range'] = proxyRes.headers['content-range'];
      res.writeHead(proxyRes.statusCode, fwd);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error('[Stream Proxy]', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Stream failed' });
    });

    req.on('close', () => proxyReq.destroy());
  } catch (err) {
    console.error('[Stream]', err.message);
    res.status(500).json({ error: 'Failed to get stream' });
  }
});

/* ------------------------------------------------------------------ */
/*  GET /api/lyrics/:videoId                                          */
/*  Attempts to get subtitles/captions from YouTube as lyrics proxy   */
/* ------------------------------------------------------------------ */
app.get('/api/lyrics/:videoId', async (req, res) => {
  const { videoId } = req.params;

  try {
    // Try to get auto-generated subtitles from YouTube
    const stdout = await runYtDlp([
      `https://www.youtube.com/watch?v=${videoId}`,
      '--dump-json', '--no-warnings', '--skip-download',
    ], 15000);

    const data = JSON.parse(stdout);
    const title = data.title || '';
    const artist = data.channel || data.uploader || '';

    // Check if subtitles are available
    let subtitles = null;
    if (data.subtitles && Object.keys(data.subtitles).length > 0) {
      subtitles = data.subtitles;
    } else if (data.automatic_captions && Object.keys(data.automatic_captions).length > 0) {
      subtitles = data.automatic_captions;
    }

    if (subtitles) {
      // Get English subtitles first, fallback to first available
      const lang = subtitles['en'] || subtitles[Object.keys(subtitles)[0]];
      if (lang) {
        // Find json3 or vtt format
        const sub = lang.find(s => s.ext === 'json3') || lang.find(s => s.ext === 'vtt') || lang[0];
        if (sub && sub.url) {
          // Fetch the subtitle content
          const subRes = await new Promise((resolve, reject) => {
            const proto = sub.url.startsWith('https') ? https : http;
            proto.get(sub.url, (r) => {
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

              return res.json({
                title, artist, synced: true,
                lines,
              });
            }
          } catch {
            // Parse as plain text
            return res.json({
              title, artist, synced: false,
              lines: subRes.split('\n').filter(l => l.trim() && !l.includes('-->') && !l.match(/^\d+$/)).map(l => ({ time: 0, text: l.trim() })),
            });
          }
        }
      }
    }

    // No subtitles available
    res.json({ title, artist, synced: false, lines: [] });

  } catch (err) {
    console.error('[Lyrics]', err.message);
    res.status(500).json({ error: 'Failed to fetch lyrics' });
  }
});

/* ------------------------------------------------------------------ */
/*  GET /api/download/:videoId — download as MP3                      */
/* ------------------------------------------------------------------ */
app.get('/api/download/:videoId', async (req, res) => {
  const { videoId } = req.params;

  try {
    // 1. Get video info for the filename
    const infoStdout = await runYtDlp([
      `https://www.youtube.com/watch?v=${videoId}`,
      '--dump-json', '--no-warnings', '--skip-download',
    ], 15000);

    const info = JSON.parse(infoStdout);
    const safeTitle = (info.title || 'download').replace(/[^a-zA-Z0-9\s\-_.()\[\]]/g, '').trim();

    // 2. Get the direct audio URL
    const audioUrl = await runYtDlp([
      `https://www.youtube.com/watch?v=${videoId}`,
      '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
      '-g', '--no-warnings',
    ], 15000);

    if (!audioUrl) return res.status(404).json({ error: 'No audio found' });

    // 3. Set download headers
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.mp3"`);

    // 4. Use ffmpeg to convert audio stream to MP3 and pipe to response
    //    ffmpeg reads from the URL, converts to MP3, outputs to stdout
    const ffmpeg = spawn(ffmpegPath, [
      '-i', audioUrl,           // input from URL
      '-vn',                    // no video
      '-ab', '192k',            // 192kbps bitrate
      '-ar', '44100',           // 44.1kHz sample rate
      '-f', 'mp3',              // output format MP3
      '-metadata', `title=${info.title || ''}`,
      '-metadata', `artist=${info.channel || info.uploader || ''}`,
      'pipe:1',                 // output to stdout
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    ffmpeg.stdout.pipe(res);

    ffmpeg.stderr.on('data', () => {}); // suppress ffmpeg logs

    ffmpeg.on('error', (err) => {
      console.error('[Download ffmpeg error]', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Conversion failed' });
    });

    ffmpeg.on('close', (code) => {
      if (code !== 0 && !res.headersSent) {
        res.status(500).json({ error: 'Conversion failed' });
      }
    });

    // If client disconnects, kill ffmpeg
    req.on('close', () => {
      ffmpeg.kill('SIGTERM');
    });

  } catch (err) {
    console.error('[Download]', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Download failed' });
  }
});

/* ------------------------------------------------------------------ */
/*  Network Info Endpoint (For Phone / Mobile Connection)             */
/* ------------------------------------------------------------------ */
const os = require('os');

app.get('/api/network-info', (req, res) => {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const k in interfaces) {
    for (const k2 in interfaces[k]) {
      const address = interfaces[k][k2];
      if (address.family === 'IPv4' && !address.internal) {
        addresses.push(address.address);
      }
    }
  }
  res.json({
    localIp: addresses[0] || 'localhost',
    port: PORT,
    allIps: addresses,
    phoneUrl: addresses[0] ? `http://${addresses[0]}:${PORT}` : `http://localhost:${PORT}`
  });
});

/* ------------------------------------------------------------------ */
/*  Persistent User Data Storage (Disk Backup for likes, playlists)   */
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
/*  SPA fallback                                                      */
/* ------------------------------------------------------------------ */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🎵 MusicFlow is running at http://localhost:${PORT}\n`);
});
