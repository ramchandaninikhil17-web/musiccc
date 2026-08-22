#!/usr/bin/env node
'use strict';

/*
 * Exercises the real client-side Download All logic against a real server.
 *
 * There is no browser available here, so instead of duplicating the logic (a
 * copy would drift and prove nothing), this slices the actual
 * "PLAYLIST BATCH DOWNLOAD (ZIP)" block out of public/js/app.js and evaluates
 * it against a minimal DOM stub. What runs below is the shipped code.
 *
 * Requires a server already listening on TEST_PORT with a stubbed yt-dlp.
 * Driven by test/run-all.sh.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PORT = process.env.TEST_PORT || '3895';
const BASE = `http://localhost:${PORT}`;

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

/* ---------- extract the real block from app.js ---------------------- */
const appPath = path.join(__dirname, '..', 'public', 'js', 'app.js');
const src = fs.readFileSync(appPath, 'utf8');
const startMarker = 'PLAYLIST BATCH DOWNLOAD (ZIP)';
const endMarker = 'MOBILE SIDEBAR';
const startIdx = src.indexOf(startMarker);
const endIdx = src.indexOf(endMarker, startIdx);
if (startIdx < 0 || endIdx < 0) {
  console.error('Could not locate the playlist download block in app.js — markers moved?');
  process.exit(1);
}
// Back up to the opening comment of each section so we take whole statements.
const blockStart = src.lastIndexOf('/*', startIdx);
const blockEnd = src.lastIndexOf('/*', endIdx);
const block = src.slice(blockStart, blockEnd);

console.log(`Extracted ${block.split('\n').length} lines of live client code from app.js\n`);

/* ---------- minimal DOM stub ---------------------------------------- */
function makeEl(id) {
  return {
    id,
    style: { width: '', display: '' },
    textContent: '',
    innerHTML: '',
    disabled: false,
    href: '',
    download: '',
    _clicked: 0,
    click() { this._clicked++; },
    remove() {},
    appendChild() {},
    addEventListener() {},
    scrollIntoView() {},
  };
}

const els = new Map();
const $ = (sel) => {
  const id = String(sel).replace(/^#/, '');
  if (!els.has(id)) els.set(id, makeEl(id));
  return els.get(id);
};

const toasts = [];
const anchors = [];
const sandbox = {
  console,
  fetch: (url, opts) => fetch(url.startsWith('http') ? url : BASE + url, opts),
  setInterval, clearInterval, setTimeout, clearTimeout,
  $,
  toast: (m) => { toasts.push(m); },
  esc: (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  safeDownloadName: (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '').trim() || 'MusicFlow_Track',
  document: {
    createElement: () => { const a = makeEl('anchor'); anchors.push(a); return a; },
    body: { appendChild() {} },
  },
  // Module-level state the block closes over in the real file.
  playlists: [],
  currentPlaylistId: null,
};

// Expose the block's inner functions so the test can call them.
const wrapped = `${block}\n;globalThis.__api = {
  startPlaylistDownload, pollPlaylistDownload, cancelOrClosePlaylistDownload,
  savePlaylistZip, isDownloadableTrack, renderPlaylistDlFailures,
  setPlaylistDlProgress, hidePlaylistDlModal,
  get jobId() { return playlistDlJobId; },
};`;

const context = vm.createContext(sandbox);
try {
  vm.runInContext(wrapped, context);
} catch (err) {
  console.error('The extracted block failed to evaluate:', err.message);
  process.exit(1);
}
const api = sandbox.__api || context.__api;
check('live block evaluates and exposes its functions', !!api && typeof api.startPlaylistDownload === 'function');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  /* ---------- eligibility filter --------------------------------- */
  console.log('\nTrack eligibility');
  check('accepts a plain YouTube track', api.isDownloadableTrack({ id: 'dQw4w9WgXcQ' }));
  check('rejects a local import', !api.isDownloadableTrack({ id: 'dQw4w9WgXcQ', isLocal: true }));
  check('rejects a cloud track', !api.isDownloadableTrack({ id: 'dQw4w9WgXcQ', isCloud: true }));
  check('rejects a malformed id', !api.isDownloadableTrack({ id: 'nope' }));
  check('rejects a missing id', !api.isDownloadableTrack({}));
  check('rejects null', !api.isDownloadableTrack(null));

  /* ---------- progress maths ------------------------------------- */
  console.log('\nProgress bar');
  api.setPlaylistDlProgress(50, 'half');
  check('sets width and percent text', $('#playlistDlFill').style.width === '50%' && $('#playlistDlPercent').textContent === '50%');
  api.setPlaylistDlProgress(-20, 'x');
  check('clamps below zero', $('#playlistDlFill').style.width === '0%');
  api.setPlaylistDlProgress(999, 'x');
  check('clamps above 100', $('#playlistDlFill').style.width === '100%');

  /* ---------- guard rails --------------------------------------- */
  console.log('\nGuard rails');
  toasts.length = 0;
  sandbox.currentPlaylistId = 'nope';
  await api.startPlaylistDownload();
  check('no open playlist is refused', /Open a playlist first/i.test(toasts.join('|')), toasts.join('|'));

  sandbox.playlists = [{ id: 'pl_empty', name: 'Empty', songs: [] }];
  sandbox.currentPlaylistId = 'pl_empty';
  toasts.length = 0;
  await api.startPlaylistDownload();
  check('empty playlist is refused', /empty/i.test(toasts.join('|')), toasts.join('|'));

  sandbox.playlists = [{
    id: 'pl_none', name: 'No YT', songs: [
      { id: 'local_1', title: 'Local', isLocal: true },
      { id: 'abcdefghij1', title: 'Cloudy', isCloud: true },
    ],
  }];
  sandbox.currentPlaylistId = 'pl_none';
  toasts.length = 0;
  await api.startPlaylistDownload();
  check('playlist with nothing downloadable is refused', /Nothing here can be downloaded/i.test(toasts.join('|')), toasts.join('|'));
  check('no job was started for it', !api.jobId);

  /* ---------- the real run -------------------------------------- */
  console.log('\nFull download run against the server');
  sandbox.playlists = [{
    id: 'pl_real', name: 'Road Trip: Vol 1?', songs: [
      { id: 'AAAAAAAAAA1', title: 'Alpha' },
      { id: 'BBBBBBBBBB2', title: 'Beta' },
      { id: 'FAILFAILFA1', title: 'Doomed Track' },
      { id: 'local_x', title: 'Local One', isLocal: true },
      { id: 'CCCCCCCCCC3', title: 'गामा' },
    ],
  }];
  sandbox.currentPlaylistId = 'pl_real';
  toasts.length = 0;
  anchors.length = 0;

  await api.startPlaylistDownload();
  check('job started', !!api.jobId, `jobId=${api.jobId}`);
  check('dialog opened', $('#playlistDlModal').style.display === '');
  check('skipped tracks explained up front',
    /1 track skipped \(local or cloud\)/i.test($('#playlistDlNote').textContent),
    $('#playlistDlNote').textContent);
  check('note is visible', $('#playlistDlNote').style.display === '');
  check('subtitle counts only eligible tracks',
    /4 tracks/.test($('#playlistDlSubtitle').textContent), $('#playlistDlSubtitle').textContent);

  // Re-entrancy: a second click must not start a second job.
  const firstJob = api.jobId;
  await api.startPlaylistDownload();
  check('second click reuses the running job', api.jobId === firstJob);

  // Watch it progress.
  let sawDownloading = false, sawPartialBar = false;
  for (let i = 0; i < 80; i++) {
    await api.pollPlaylistDownload();
    const status = $('#playlistDlStatus').textContent;
    const w = parseInt($('#playlistDlFill').style.width) || 0;
    if (/converted/i.test(status)) sawDownloading = true;
    if (w > 0 && w < 100) sawPartialBar = true;
    if (/Ready/i.test(status) || /Failed/i.test(status)) break;
    await sleep(400);
  }
  check('progress reported conversions in flight', sawDownloading);
  check('bar moved through intermediate values', sawPartialBar);
  check('reached Ready', /Ready/i.test($('#playlistDlStatus').textContent), $('#playlistDlStatus').textContent);
  check('bar ends at 100%', $('#playlistDlFill').style.width === '100%');

  check('failed track surfaced to the user',
    /Doomed Track/.test($('#playlistDlFailed').innerHTML), $('#playlistDlFailed').innerHTML.slice(0, 160));
  check('failure box made visible', $('#playlistDlFailed').style.display === '');
  check('reassures that the rest is still included',
    /still included/i.test($('#playlistDlFailed').innerHTML));
  check('summary reports bundled count and size',
    /3 tracks bundled/.test($('#playlistDlCurrent').textContent), $('#playlistDlCurrent').textContent);
  check('save button revealed', $('#playlistDlSaveBtn').style.display === '');
  check('cancel button became Close', $('#playlistDlCancelBtn').textContent === 'Close');

  /* ---------- the save ------------------------------------------ */
  console.log('\nSaving the archive');
  check('save was triggered automatically', anchors.length >= 1, `anchors=${anchors.length}`);
  const a = anchors[anchors.length - 1];
  check('anchor points at the job file endpoint',
    a && a.href === `/api/playlist-download/${firstJob}/file`, a && a.href);
  check('anchor uses a sanitised .zip filename',
    a && a.download === 'Road Trip Vol 1.zip', a && a.download);
  check('anchor was clicked', a && a._clicked === 1);
  check('archive is not fetched into a blob',
    !/createObjectURL/.test(block), 'client should stream via href, not buffer in memory');

  // The URL the client built must really serve a valid archive.
  const res = await fetch(BASE + a.href);
  const buf = Buffer.from(await res.arrayBuffer());
  check('endpoint returns 200', res.status === 200, `status=${res.status}`);
  check('served as application/zip', /application\/zip/.test(res.headers.get('content-type') || ''));
  check('payload is a real zip (PK header + EOCD)',
    buf.slice(0, 2).toString() === 'PK' && buf.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])),
    `${buf.length} bytes, starts ${buf.slice(0, 4).toString('hex')}`);
  fs.writeFileSync('/tmp/client-run.zip', buf);

  // Auto-save must not fire twice on subsequent polls.
  const before = anchors.length;
  await api.pollPlaylistDownload();
  check('auto-save does not repeat on later polls', anchors.length === before, `${before} -> ${anchors.length}`);

  /* ---------- close and reset ----------------------------------- */
  console.log('\nClosing');
  await api.cancelOrClosePlaylistDownload();
  check('dialog hidden', $('#playlistDlModal').style.display === 'none');
  check('job handle cleared so a new download can start', !api.jobId);

  // Closing a finished job must NOT delete the archive mid-save.
  const after = await fetch(BASE + a.href);
  check('archive still downloadable after closing the dialog', after.status === 200, `status=${after.status}`);

  /* ---------- expired job --------------------------------------- */
  console.log('\nExpired / unknown job');
  toasts.length = 0;
  sandbox.playlists = [{ id: 'pl_x', name: 'X', songs: [{ id: 'AAAAAAAAAA1', title: 'A' }] }];
  sandbox.currentPlaylistId = 'pl_x';
  await api.startPlaylistDownload();
  const goodJob = api.jobId;
  await api.cancelOrClosePlaylistDownload();   // cancels it server-side
  await sleep(500);

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(err => {
  console.error('\nHarness crashed:', err);
  process.exit(1);
});
