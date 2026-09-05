#!/usr/bin/env node
/*
 * MusicFlow video diagnostic
 * ==========================
 * Run this on the machine where downloads come out at 360p:
 *
 *     node diagnose-video.js
 *     node diagnose-video.js https://www.youtube.com/watch?v=YOUR_VIDEO_ID
 *
 * It uses the SAME yt-dlp + ffmpeg the app uses, then asks YouTube through each
 * "player client" and prints the best resolution each one can actually see. That
 * tells us in one shot why every resolution was downloading as 640x360:
 *
 *   - If NO client sees > 360p  -> your yt-dlp is too old (or YouTube needs an
 *                                  update). Fix: update the binary.
 *   - If tv/ios see 4K but web doesn't -> the app was asking through the wrong
 *                                  client. Fix is already in server.js; just
 *                                  restart the server.
 *   - If a client sees 4K but the download is still 360p -> ffmpeg can't merge.
 *
 * No network calls are made by this script itself beyond invoking yt-dlp exactly
 * as the app does. It downloads nothing (--skip-download).
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const isWin = process.platform === 'win32';

/* ---- resolve yt-dlp exactly like server.js does ---- */
function resolveYtDlp() {
  const local = path.join(__dirname, isWin ? 'yt-dlp.exe' : 'yt-dlp');
  if (fs.existsSync(local)) return local;
  return 'yt-dlp'; // fall back to PATH
}

/* ---- resolve ffmpeg exactly like server.js does ---- */
function resolveFfmpeg() {
  let p = process.env.FFMPEG_PATH || process.env.MUSICFLOW_FFMPEG || null;
  if (p && p !== 'ffmpeg' && !fs.existsSync(p)) p = null;
  if (!p) {
    try { p = require('ffmpeg-static'); } catch (e) { p = null; }
  }
  if (!p || (p !== 'ffmpeg' && !fs.existsSync(p))) {
    try {
      const out = execFileSync(isWin ? 'where' : 'which', ['ffmpeg'], { windowsHide: true })
        .toString().trim().split(/\r?\n/)[0];
      if (out) p = out;
    } catch (e) { /* not on PATH */ }
  }
  return p || 'ffmpeg';
}

const ytDlp = resolveYtDlp();
const ffmpeg = resolveFfmpeg();

/* A stable, long-lived 4K/60 test video (Blender's "Big Buck Bunny"). Override by
 * passing the SAME video that gave you 360p, so the check reflects your case. */
const arg = process.argv[2] || 'aqz-KE-bpKQ';
const videoId = /^[a-zA-Z0-9_-]{11}$/.test(arg)
  ? arg
  : (arg.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([a-zA-Z0-9_-]{11})/) || [])[1] || arg;
const url = `https://www.youtube.com/watch?v=${videoId}`;

function run(args, timeoutMs) {
  return execFileSync(ytDlp, args, {
    windowsHide: true,
    timeout: timeoutMs || 45000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

function maxHeightForClient(client) {
  const args = [
    '--geo-bypass', '--no-check-certificates', '--no-playlist',
    '--no-warnings', '--skip-download', '--dump-json',
    '--extractor-args', `youtube:player_client=${client}`,
    url,
  ];
  let json;
  try {
    json = JSON.parse(run(args));
  } catch (e) {
    const msg = String((e && e.stderr) || (e && e.message) || e).split('\n').filter(Boolean).pop() || 'failed';
    return { ok: false, msg: msg.slice(0, 120) };
  }
  const fmts = Array.isArray(json.formats) ? json.formats : [];
  let max = 0;
  let bestNeedsMerge = false;
  for (const f of fmts) {
    const h = Number(f.height) || 0;
    const hasVideo = f.vcodec && f.vcodec !== 'none';
    if (hasVideo && h > max) {
      max = h;
      bestNeedsMerge = !f.acodec || f.acodec === 'none'; // video-only => must merge with audio
    }
  }
  return { ok: true, max, bestNeedsMerge, count: fmts.length };
}

/* ---- report ---- */
console.log('\n============================================================');
console.log('  MusicFlow video diagnostic');
console.log('============================================================');
console.log(`  yt-dlp:  ${ytDlp}`);
try { console.log(`  version: ${run(['--version'], 15000).trim()}`); }
catch (e) { console.log('  version: ERROR — yt-dlp did not run. Is it installed / in this folder?'); process.exit(1); }

console.log(`  ffmpeg:  ${ffmpeg}`);
let ffmpegOk = false;
try { execFileSync(ffmpeg, ['-version'], { windowsHide: true, timeout: 15000 }); ffmpegOk = true; console.log('           ✅ ffmpeg runs (merging high-res video+audio is possible)'); }
catch (e) { console.log('           ❌ ffmpeg did NOT run — without it, downloads fall back to 360p!'); }

console.log(`  test video: ${url}`);
console.log('------------------------------------------------------------');
console.log('  Best resolution each client can SEE:');

const clients = ['tv', 'ios', 'web_safari', 'web', 'android', 'mweb'];
let overallMax = 0;
let bestClient = null;
let anyNeedsMerge = false;
for (const c of clients) {
  const r = maxHeightForClient(c);
  if (!r.ok) {
    console.log(`    ${c.padEnd(11)}  —  (unavailable: ${r.msg})`);
    continue;
  }
  const label = r.max ? `${r.max}p` : 'no video formats';
  const merge = r.bestNeedsMerge ? '  [needs ffmpeg merge]' : '';
  console.log(`    ${c.padEnd(11)}  ${String(label).padEnd(18)}${merge}`);
  if (r.max > overallMax) { overallMax = r.max; bestClient = c; anyNeedsMerge = r.bestNeedsMerge; }
}

console.log('============================================================');
console.log('  VERDICT');
console.log('------------------------------------------------------------');
if (overallMax <= 360) {
  console.log('  ❌ No client sees more than 360p.');
  console.log('     => Your yt-dlp is out of date for the current YouTube.');
  console.log('        Fix (Windows): open a terminal in this folder and run');
  console.log('           .\\yt-dlp.exe -U');
  console.log('        or delete yt-dlp.exe and restart MusicFlow (it re-downloads');
  console.log('        the latest). Then run this diagnostic again.');
} else if (bestClient === 'web') {
  console.log(`  ⚠️  Only the "web" client sees ${overallMax}p. That client can get`);
  console.log('     throttled/limited without a PO token. It works now, but tv/ios are safer.');
} else {
  console.log(`  ✅ The "${bestClient}" client sees ${overallMax}p.`);
  console.log('     The app is configured to ask tv/ios first (server.js), so high-res');
  console.log('     WILL work — but only after you RESTART the server so the new');
  console.log('     server.js is loaded:  double-click restart-musicflow.bat');
  if (anyNeedsMerge && !ffmpegOk) {
    console.log('  ❌ BUT ffmpeg is not runnable, so the high-res video (video-only stream)');
    console.log('     cannot be merged with audio and will still drop to 360p. Fix ffmpeg first.');
  }
}
console.log('============================================================\n');
