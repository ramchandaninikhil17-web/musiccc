#!/usr/bin/env node
'use strict';

/*
 * Cross-checks every $('#id') / $$('#id') selector in public/js/app.js against
 * the ids that actually exist in public/index.html.
 *
 * This repo already had five handlers bound to ids that were never in the page
 * (#playlistBackBtn, #playPlaylistBtn, #deletePlaylistBtn, #playlistBatchAddBtn),
 * silently no-oping behind `?.` — so this is the exact bug class worth guarding.
 *
 * Run: node test/dom-ids.test.js
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');

// ids present in the static page
const htmlIds = new Set();
for (const m of html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) htmlIds.add(m[1]);

// ids created at runtime by innerHTML/createElement in app.js, which are
// legitimately absent from index.html.
const dynamicIds = new Set();
for (const m of js.matchAll(/\bid\s*=\s*\\?["']([A-Za-z][\w-]*)\\?["']/g)) dynamicIds.add(m[1]);
for (const m of js.matchAll(/\.id\s*=\s*['"]([A-Za-z][\w-]*)['"]/g)) dynamicIds.add(m[1]);

// every id selector app.js looks up
const referenced = new Map();
for (const m of js.matchAll(/\$\$?\(\s*['"]#([\w-]+)['"]\s*\)/g)) {
  const id = m[1];
  const line = js.slice(0, m.index).split('\n').length;
  if (!referenced.has(id)) referenced.set(id, line);
}

const missing = [];
for (const [id, line] of referenced) {
  if (htmlIds.has(id) || dynamicIds.has(id)) continue;
  missing.push({ id, line });
}

console.log(`index.html ids: ${htmlIds.size}`);
console.log(`app.js id selectors: ${referenced.size}`);

// Ids the Download All feature depends on. These must resolve or the feature is
// silently dead — the failure mode this whole check exists to prevent.
const featureIds = [
  'activePlaylistSection', 'activePlaylistTitle', 'activePlaylistGrid', 'activePlaylistCount',
  'playPlaylistBtn', 'deletePlaylistBtn', 'hidePlaylistBtn', 'downloadPlaylistBtn',
  'playlistDlModal', 'playlistDlClose', 'playlistDlSubtitle', 'playlistDlStatus',
  'playlistDlPercent', 'playlistDlFill', 'playlistDlCurrent', 'playlistDlNote',
  'playlistDlFailed', 'playlistDlCancelBtn', 'playlistDlSaveBtn',
];

let failures = 0;
console.log('\nDownload All wiring:');
for (const id of featureIds) {
  const inHtml = htmlIds.has(id);
  const used = referenced.has(id);
  if (inHtml && used) {
    console.log(`  PASS  #${id}`);
  } else {
    failures++;
    console.log(`  FAIL  #${id} — ${!inHtml ? 'not in index.html' : 'never referenced by app.js'}`);
  }
}

// Duplicate ids in the page break getElementById in ways that are painful to debug.
const dupes = [];
const seen = new Set();
for (const m of html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) {
  if (seen.has(m[1])) dupes.push(m[1]);
  seen.add(m[1]);
}
console.log('\nPage integrity:');
if (dupes.length) { failures++; console.log(`  FAIL  duplicate ids in index.html: ${[...new Set(dupes)].join(', ')}`); }
else console.log('  PASS  no duplicate ids in index.html');

console.log('\nDangling selectors (bound but not in the page):');
if (!missing.length) {
  console.log('  none');
} else {
  for (const { id, line } of missing) console.log(`  app.js:${line}  #${id}`);
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
