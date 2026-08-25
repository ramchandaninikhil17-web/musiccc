#!/usr/bin/env node
'use strict';

/*
 * Advanced search suggestions (the autocomplete dropdown under the search box).
 *
 * Runs the REAL SuggestionEngine, its constants, and the REAL esc()/escId() out
 * of public/js/app.js against a DOM stub, a fake <audio>-free document, a
 * controllable fetch and hand-fired timers, so every path is deterministic with
 * no network and no wall clock.
 *
 * The checks map to the ways this feature breaks *quietly*:
 *   - a stale slow response repainting over a query the user typed past;
 *   - re-requesting a query the user backspaced into and retyped (the whole
 *     point of the cache — one wasted yt-dlp process per keystroke otherwise);
 *   - an unbounded cache growing for the length of a typing session;
 *   - the keyboard cursor and the mouse cursor disagreeing on which row Enter
 *     fires;
 *   - a "play this exact track" row running a fresh search for its own title;
 *   - untrusted titles/queries reaching an attribute unescaped.
 *
 * Run: node test/search-suggest.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`); }
};
const section = (t) => console.log(`\n${t}`);

/* ---------- pull the real code out of app.js ------------------------- */
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

function extract(re) {
  const m = re.exec(src);
  if (!m) throw new Error(`could not find ${re} in app.js`);
  let i = src.indexOf('{', m.index);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(m.index, i);
}

const constStart = src.indexOf('const SUGGEST_DEBOUNCE_MS');
const engStart = src.indexOf('const SuggestionEngine = {');
if (constStart < 0 || engStart < 0) { console.error('could not locate the search block in app.js'); process.exit(1); }
const constBlock = src.slice(constStart, engStart);

const code = [
  constBlock,
  extract(/\n  function esc\s*\(/),
  extract(/\n  function escId\s*\(/),
  extract(/\n  const SuggestionEngine = \{/),
].join('\n\n');
console.log(`Extracted SuggestionEngine + constants + esc/escId (${code.split('\n').length} lines) from app.js\n`);

/* ---------- a document just good enough for esc() -------------------- */
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
const documentStub = {
  createElement() {
    let _t = '';
    return {
      set textContent(v) { _t = v == null ? '' : String(v); },
      get textContent() { return _t; },
      get innerHTML() { return escapeHtml(_t); },
    };
  },
};

/* ---------- the suggestions dropdown + input ------------------------- */
function classList(seed) {
  const s = new Set(seed || []);
  return {
    add: (c) => s.add(c),
    remove: (c) => s.delete(c),
    contains: (c) => s.has(c),
    toggle: (c, on) => { if (on === undefined) { s.has(c) ? s.delete(c) : s.add(c); } else if (on) s.add(c); else s.delete(c); return s.has(c); },
    _set: s,
  };
}

// The engine writes innerHTML then immediately reads it back via
// querySelectorAll('.suggestion-item'); parse the markup it just produced into
// row stubs so the round trip is real, not mocked.
function parseRows(html) {
  const rows = [];
  const parts = html.split('<div class="suggestion-item"');
  for (let i = 1; i < parts.length; i++) {
    const head = parts[i].slice(0, parts[i].indexOf('>') + 1);
    const attr = (name) => { const m = new RegExp(name + '="([^"]*)"').exec(head); return m ? m[1] : undefined; };
    const dataset = {
      action: attr('data-action'), plid: attr('data-plid'),
      id: attr('data-id'), query: attr('data-query'), type: attr('data-type'),
    };
    const row = { dataset, classList: classList(['suggestion-item']), scrollIntoView() {} };
    row.closest = (sel) => (sel === '.suggestion-item' ? row : null);
    rows.push(row);
  }
  return rows;
}

let ssHtml = '';
const searchSuggestions = {
  classList: classList(),
  _attrs: {},
  set innerHTML(v) { ssHtml = v; },
  get innerHTML() { return ssHtml; },
  querySelectorAll(sel) { return sel === '.suggestion-item' ? parseRows(ssHtml) : []; },
  addEventListener() {},
  setAttribute(k, v) { this._attrs[k] = v; },
};
const searchInput = { value: '', _attrs: {}, setAttribute(k, v) { this._attrs[k] = v; } };
const searchClear = { classList: classList() };

/* ---------- controllable fetch + timers + AbortController ------------ */
let nextResponse = { ok: true, body: [] };
let fetchCalls = [];
let pendingFetch = null; // when set, fetch waits for manual resolution
function fakeFetch(url, opts) {
  fetchCalls.push({ url, opts });
  if (pendingFetch) {
    return new Promise((resolve, reject) => { pendingFetch.resolve = resolve; pendingFetch.reject = reject; pendingFetch.opts = opts; });
  }
  const r = nextResponse;
  return Promise.resolve({ ok: r.ok, json: () => Promise.resolve(r.body) });
}

let timeoutSeq = 1;
const timeouts = new Map();
const fakeSetTimeout = (fn) => { const id = timeoutSeq++; timeouts.set(id, fn); return id; };
const fakeClearTimeout = (id) => { timeouts.delete(id); };
function fireTimeouts() { const fns = [...timeouts.values()]; timeouts.clear(); fns.forEach(f => f()); }

class FakeAbortController {
  constructor() { this.signal = { aborted: false }; }
  abort() { this.signal.aborted = true; }
}

/* ---------- recorded app-level calls the engine reaches out to ------- */
const calls = { navigateTo: [], showPlaylistDetail: [], playSong: [], doSearch: [] };

const sandbox = {
  console,
  document: documentStub,
  setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
  fetch: fakeFetch, AbortController: FakeAbortController,
  encodeURIComponent,
  searchSuggestions, searchInput, searchClear,
  history: [], likedSongs: [], playlists: [], searchHistory: [],
  searchTimeout: null,
  navigateTo: (p) => calls.navigateTo.push(p),
  showPlaylistDetail: (id) => calls.showPlaylistDetail.push(id),
  playSong: (s) => calls.playSong.push(s),
  doSearch: (q) => calls.doSearch.push(q),
};

const ctx = vm.createContext(sandbox);
try {
  vm.runInContext(code +
    '\n;globalThis.__x = { SuggestionEngine, SUGGEST_DEBOUNCE_MS, SEARCH_DEBOUNCE_MS, SUGGEST_MAX, SUGGEST_CACHE_MAX, SUGGEST_MIN_REMOTE, SUG_ORDER, SUG_LABELS, esc, escId };', ctx);
} catch (err) {
  console.error('Extracted code failed to evaluate:', err.message);
  process.exit(1);
}
const E = ctx.__x;
const eng = E.SuggestionEngine;
check('extracted code evaluates', typeof eng === 'object' && typeof eng.onQuery === 'function');

function resetState() {
  sandbox.history = []; sandbox.likedSongs = []; sandbox.playlists = []; sandbox.searchHistory = [];
  searchInput.value = ''; ssHtml = ''; searchSuggestions.classList._set.clear();
  searchClear.classList._set.clear();
  timeouts.clear(); fetchCalls = []; pendingFetch = null;
  nextResponse = { ok: true, body: [] };
  calls.navigateTo.length = 0; calls.showPlaylistDetail.length = 0;
  calls.playSong.length = 0; calls.doSearch.length = 0;
  eng.timer = null; eng.controller = null; eng.reqId = 0;
  eng.cache = new Map(); eng.rows = []; eng.items = []; eng.activeIndex = -1;
}

/* =====================================================================
   1. the debounce and cap constants are the ones the spec calls for
   ===================================================================== */
section('Constants match the P2 spec');
check('suggestion debounce is 300ms', E.SUGGEST_DEBOUNCE_MS === 300);
check('full-search debounce stays 700ms (one yt-dlp process each)', E.SEARCH_DEBOUNCE_MS === 700);
check('remote suggestions need at least 2 chars', E.SUGGEST_MIN_REMOTE === 2);
check('the cache is bounded', E.SUGGEST_CACHE_MAX > 0 && E.SUGGEST_MAX > 0);
check('groups render in recent→song→artist→playlist→popular order',
  E.SUG_ORDER.recent === 0 && E.SUG_ORDER.song === 1 && E.SUG_ORDER.artist === 2 &&
  E.SUG_ORDER.playlist === 3 && E.SUG_ORDER.popular === 4);

/* =====================================================================
   2. normalization + artist cleanup
   ===================================================================== */
section('Query normalization and artist cleanup');
check('normQuery trims, lowercases, collapses spaces', eng.normQuery('  Ar  IJIT  ') === 'ar ijit');
check('normQuery tolerates null', eng.normQuery(null) === '' && eng.normQuery(undefined) === '');
check('cleanArtist strips " - Topic"', eng.cleanArtist('Arijit Singh - Topic') === 'Arijit Singh');
check('cleanArtist strips VEVO/Official', eng.cleanArtist('ArijitVEVO Official') === 'Arijit');

/* =====================================================================
   3. local rows — everything answerable with no network
   ===================================================================== */
section('Local rows on an empty (focused) box');
resetState();
sandbox.searchHistory = ['lo-fi beats', 'workout'];
sandbox.likedSongs = [{ id: 'x1', title: 'Tum Hi Ho', channel: 'Arijit Singh - Topic' }];
sandbox.history = [{ song: { id: 'x2', title: 'Raabta', channel: 'Arijit Singh' } }];
let rows = eng.localRows('');
check('empty box shows recent searches', rows.some(r => r.kind === 'recent' && r.query === 'lo-fi beats'));
check('empty box shows a "from your listening" artist', rows.some(r => r.kind === 'popular' && r.label === 'Arijit Singh'));
check('empty box makes zero requests', fetchCalls.length === 0);

// An artist the user has also searched for by name must not appear twice under
// two different headings — one row, whichever group comes first.
resetState();
sandbox.searchHistory = ['arijit singh'];
sandbox.history = [{ song: { id: 'x2', title: 'Raabta', channel: 'Arijit Singh' } }];
rows = eng.localRows('');
check('a query-like row is never listed twice under two headings',
  rows.filter(r => eng.normQuery(r.label) === 'arijit singh').length === 1);

section('Local rows for a typed query');
resetState();
sandbox.searchHistory = ['arijit live', 'arctic monkeys', 'zzz'];
sandbox.likedSongs = [{ id: 's1', title: 'Arijit Ballad', channel: 'Arijit Singh - Topic' }];
sandbox.history = [{ song: { id: 's2', title: 'Some Song', channel: 'Arijit Singh' } }];
sandbox.playlists = [{ id: 'p1', name: 'Arijit Favourites', songs: [{ id: 'a', title: 't', channel: 'c' }] }];
rows = eng.localRows('arijit');
check('recent searches matching the query appear', rows.some(r => r.kind === 'recent' && r.query === 'arijit live'));
check('non-matching recent searches are excluded', !rows.some(r => r.query === 'zzz'));
check('a liked/played title matching the query appears as a song', rows.some(r => r.kind === 'song' && r.label === 'Arijit Ballad' && r.song && r.song.id === 's1'));
check('a matching artist appears', rows.some(r => r.kind === 'artist' && r.label === 'Arijit Singh'));
check('a matching playlist appears with its size', rows.some(r => r.kind === 'playlist' && r.plId === 'p1' && r.sub === '1 song'));

/* =====================================================================
   4. matchLibrarySongs — dedup, liked-first, cap
   ===================================================================== */
section('Library song matching');
resetState();
sandbox.likedSongs = [{ id: 'dup', title: 'Kesariya', channel: 'Arijit' }];
sandbox.history = [
  { song: { id: 'dup', title: 'Kesariya', channel: 'Arijit' } }, // same id as liked
  { song: { id: 'h2', title: 'Kesariya Reprise', channel: 'X' } },
];
let libs = eng.matchLibrarySongs('kesariya', 5);
check('a liked-and-played track is not duplicated', libs.filter(s => s.id === 'dup').length === 1);
check('matches by title OR channel', eng.matchLibrarySongs('arijit', 5).some(s => s.id === 'dup'));
check('the limit is honoured', eng.matchLibrarySongs('kesariya', 1).length === 1);
check('malformed songs (no id/title) are skipped',
  eng.matchLibrarySongs.call(eng, 'z', 5) && (sandbox.likedSongs.push({ id: null, title: 'z' }), eng.matchLibrarySongs('z', 5).length === 0));

/* =====================================================================
   5. rankedArtists — likes weigh double, query filter, limit
   ===================================================================== */
section('Artist ranking');
resetState();
sandbox.history = [
  { song: { id: '1', channel: 'Weeknd' } },
  { song: { id: '2', channel: 'Weeknd' } },
  { song: { id: '3', channel: 'Drake' } },
];
sandbox.likedSongs = [{ id: '4', channel: 'Drake' }, { id: '5', channel: 'Drake' }]; // 2 likes = weight 4
let arts = eng.rankedArtists('', 5);
check('a heavily-liked artist outranks a more-played one', arts[0] === 'Drake');
check('the query filters artists', eng.rankedArtists('week', 5).length === 1 && eng.rankedArtists('week', 5)[0] === 'Weeknd');
check('the limit is honoured', eng.rankedArtists('', 1).length === 1);

/* =====================================================================
   6. merge — remote rows dedup against local, group order, cap
   ===================================================================== */
section('Merging local and remote rows');
resetState();
sandbox.likedSongs = [{ id: 'L', title: 'Local Match', channel: 'Mine' }];
let merged = eng.merge('match', [
  { id: 'R1', title: 'Local Match', channel: 'Someone' }, // dup title of the local song
  { id: 'R2', title: 'Remote Only', channel: 'Someone' },
]);
check('a remote song duplicating a local title is dropped', merged.filter(r => r.label === 'Local Match').length === 1);
check('a genuinely new remote song is kept', merged.some(r => r.label === 'Remote Only'));
check('rows come out in group order', merged.every((r, i) => i === 0 || E.SUG_ORDER[merged[i - 1].kind] <= E.SUG_ORDER[r.kind]));

// The order above would also hold by accident, because localRows already emits
// its kinds in order and merge appends remote rows at the end. Force the case
// where sorting has real work to do: a remote song must climb above the local
// playlist row it was appended after.
resetState();
sandbox.likedSongs = [{ id: 'L', title: 'Match Song', channel: 'Nobody' }];
sandbox.playlists = [{ id: 'pl1', name: 'Match Mix', songs: [] }];
merged = eng.merge('match', [{ id: 'R9', title: 'Remote Match', channel: 'Someone' }]);
check('a remote song is sorted up past a local playlist row, not left at the end',
  merged.every((r, i) => i === 0 || E.SUG_ORDER[merged[i - 1].kind] <= E.SUG_ORDER[r.kind])
  && merged.findIndex(r => r.label === 'Remote Match') < merged.findIndex(r => r.kind === 'playlist'));

resetState();
sandbox.searchHistory = Array.from({ length: 20 }, (_, i) => `match ${i}`);
merged = eng.merge('match', Array.from({ length: 20 }, (_, i) => ({ id: 'r' + i, title: 'remote ' + i, channel: 'c' })));
check('the merged list is capped at SUGGEST_MAX', merged.length === E.SUGGEST_MAX);

/* =====================================================================
   7. sanitize — the remote payload is an untrusted yt-dlp scrape
   ===================================================================== */
section('Sanitizing the remote payload');
check('a non-array becomes []', eng.sanitize(null).length === 0 && eng.sanitize({}).length === 0);
check('items missing id or title are dropped',
  eng.sanitize([{ id: 'a' }, { title: 't' }, { id: 'b', title: 'ok' }]).length === 1);
check('duplicate ids are dropped',
  eng.sanitize([{ id: 'x', title: 'a' }, { id: 'x', title: 'b' }]).length === 1);
check('the channel is cleaned', eng.sanitize([{ id: 'x', title: 't', channel: 'Foo - Topic' }])[0].channel === 'Foo');
check('at most 6 remote items are taken',
  eng.sanitize(Array.from({ length: 20 }, (_, i) => ({ id: 'i' + i, title: 't' + i }))).length === 6);

/* =====================================================================
   8. the LRU cache — a bounded Map, coldest key evicted first
   ===================================================================== */
section('Bounded LRU cache');
resetState();
for (let i = 0; i < E.SUGGEST_CACHE_MAX + 5; i++) eng.remember('q' + i, []);
check('cache never exceeds its cap', eng.cache.size === E.SUGGEST_CACHE_MAX);
check('the oldest keys were evicted', !eng.cache.has('q0') && eng.cache.has('q' + (E.SUGGEST_CACHE_MAX + 4)));
resetState();
eng.remember('a', []); eng.remember('b', []); eng.remember('a', []); // touch 'a'
const keys = [...eng.cache.keys()];
check('re-remembering moves a key to the most-recent end', keys[keys.length - 1] === 'a');

/* =====================================================================
   9. onQuery — debounce scheduling and cache short-circuit
   ===================================================================== */
section('onQuery scheduling');
resetState();
searchInput.value = 'ar';
eng.onQuery('ar');
check('an uncached ≥2-char query schedules a remote fetch (debounced)', timeouts.size === 1);
check('nothing is fetched before the debounce fires', fetchCalls.length === 0);

resetState();
eng.cache.set('ar', [{ id: 'z', title: 'cached' }]);
searchInput.value = 'ar';
eng.onQuery('ar');
check('a cached query schedules no fetch at all', timeouts.size === 0);

resetState();
searchInput.value = 'a';
eng.onQuery('a');
check('a 1-char query schedules no remote fetch', timeouts.size === 0);

/* =====================================================================
   10. fetchRemote — staleness, moved-past guard, caching, abort
   ===================================================================== */
// These share one module-level engine, so they must run one at a time; an
// earlier version let them interleave and each resetState() wiped the next
// scenario's setup.
const asyncScenarios = [
  // stale response (reqId bumped mid-flight) must not repaint
  async () => {
    resetState();
    searchInput.value = 'foo';
    pendingFetch = {};
    const p = eng.fetchRemote('foo');
    await Promise.resolve();          // let fetchRemote reach the await
    eng.reqId++;                      // a newer query started
    pendingFetch.resolve({ ok: true, json: () => Promise.resolve([{ id: 'x', title: 'Foo Song' }]) });
    await p;
    check('a stale response never caches or paints',
      !eng.cache.has('foo') && !searchSuggestions.classList.contains('active'));
  },

  // response for a query the user has typed past: cached, but not painted
  async () => {
    resetState();
    searchInput.value = 'foobar';     // user kept typing
    nextResponse = { ok: true, body: [{ id: 'x', title: 'Foo Song' }] };
    await eng.fetchRemote('foo');
    check('a response for a moved-past query is cached', eng.cache.has('foo'));
    check('...but is not painted over the current query', !searchSuggestions.classList.contains('active'));
  },

  // a good response for the current query caches AND paints
  async () => {
    resetState();
    searchInput.value = 'foo';
    nextResponse = { ok: true, body: [{ id: 'x', title: 'Foo Song', channel: 'Bar' }] };
    await eng.fetchRemote('foo');
    check('a current good response is cached', eng.cache.has('foo') && eng.cache.get('foo').length === 1);
    check('...and painted', searchSuggestions.classList.contains('active'));
  },

  // a non-ok response is "learned nothing", not "no results" — do not cache
  async () => {
    resetState();
    searchInput.value = 'foo';
    nextResponse = { ok: false, body: [] };
    await eng.fetchRemote('foo');
    check('a failed request is NOT cached (so it can be retried)', !eng.cache.has('foo'));
  },

  // a successful empty response IS cached: "nothing for this string" is a fact
  async () => {
    resetState();
    searchInput.value = 'foo';
    nextResponse = { ok: true, body: [] };
    await eng.fetchRemote('foo');
    check('an empty-but-successful response is cached (no repeat request)', eng.cache.has('foo'));
  },

  // a second fetch aborts the first
  async () => {
    resetState();
    searchInput.value = 'foo';
    pendingFetch = {};
    eng.fetchRemote('foo');
    await Promise.resolve();
    const first = eng.controller;
    pendingFetch = {};                // the next call hangs too
    eng.fetchRemote('foob');
    await Promise.resolve();
    check('starting a new fetch aborts the in-flight one', !!first && first.signal.aborted === true);
  },

  // malformed JSON must not take the dropdown down with it
  async () => {
    resetState();
    searchInput.value = 'foo';
    nextResponse = { ok: true, body: null };
    await eng.fetchRemote('foo');
    check('a malformed payload degrades to no remote rows, not a throw',
      eng.cache.has('foo') && eng.cache.get('foo').length === 0);
  },
];

/* =====================================================================
   11. paint + close + group headings + aria
   ===================================================================== */
function syncSectionsAfterAsync() {
section('Rendering, headings and close');
resetState();
eng.paint([
  { kind: 'recent', label: 'a', query: 'a' },
  { kind: 'recent', label: 'b', query: 'b' },
  { kind: 'song', label: 'S', song: { id: 's', title: 'S' } },
]);
check('the dropdown opens', searchSuggestions.classList.contains('active'));
check('aria-expanded is set true', searchInput._attrs['aria-expanded'] === 'true');
check('each group heading is emitted exactly once',
  (ssHtml.match(/sug-group/g) || []).length === 2);
check('a song row carries a play action with its id',
  /data-action="play" data-id="s"/.test(ssHtml));
check('painting an empty list closes instead of showing an empty box',
  (eng.paint([]), !searchSuggestions.classList.contains('active')));
eng.paint([{ kind: 'recent', label: 'a', query: 'a' }]);
eng.close();
check('close clears rows, items and the active index', eng.rows.length === 0 && eng.items.length === 0 && eng.activeIndex === -1);
check('close sets aria-expanded false', searchInput._attrs['aria-expanded'] === 'false');

/* =====================================================================
   12. keyboard navigation
   ===================================================================== */
section('Keyboard navigation');
resetState();
eng.paint([
  { kind: 'recent', label: 'a', query: 'a' },
  { kind: 'song', label: 'b', song: { id: 'b', title: 'b' } },
]);
function key(k) { let prevented = false; eng.onKeydown({ key: k, preventDefault() { prevented = true; } }); return prevented; }
key('ArrowDown');
check('ArrowDown from nothing lands on the first row', eng.activeIndex === 0);
key('ArrowDown');
check('ArrowDown advances', eng.activeIndex === 1);
key('ArrowDown');
check('ArrowDown wraps to the top', eng.activeIndex === 0);
key('ArrowUp');
check('ArrowUp wraps to the bottom', eng.activeIndex === 1);
check('the active row gets the cursor class', eng.rows[1].classList.contains('sug-active'));

// when the dropdown is closed the arrows must fall through to the caret
resetState();
check('ArrowDown is not consumed when the list is closed', key('ArrowDown') === false);
check('Escape is not consumed when the list is closed',
  eng.onKeydown({ key: 'Escape', preventDefault() {} }) === false);

// Enter on a highlighted row is consumed; Enter with none highlighted is not
resetState();
sandbox.searchHistory = ['hello'];
eng.paint(eng.localRows('hello'));
check('Enter with no row highlighted falls through to the plain search',
  eng.onKeydown({ key: 'Enter', preventDefault() {} }) === false);

// ...and with a row highlighted it must actually act on that row, not merely
// swallow the key. Swallowing without acting is the worst outcome: the plain
// Enter search is suppressed too, so the box goes dead.
resetState();
sandbox.searchHistory = ['lofi beats'];
eng.paint(eng.localRows('lofi'));
key('ArrowDown');
let enterPrevented = key('Enter');
check('Enter on a highlighted row is consumed', enterPrevented === true);
check('Enter on a highlighted row actually runs that row',
  calls.doSearch.includes('lofi beats'));
check('Enter on a highlighted row closes the dropdown',
  !searchSuggestions.classList.contains('active'));

/* =====================================================================
   13. choose — the three row actions
   ===================================================================== */
section('Choosing a row');

// playlist row → open the playlist, do not search for its name
resetState();
sandbox.playlists = [{ id: 'pl9', name: 'Focus', songs: [] }];
eng.paint(eng.localRows('focus'));
let plRow = eng.rows.find(r => r.dataset.action === 'playlist');
eng.choose(plRow);
check('a playlist row navigates to the library', calls.navigateTo.includes('library'));
check('a playlist row opens that exact playlist', calls.showPlaylistDetail.includes('pl9'));
check('a playlist row runs no search', calls.doSearch.length === 0);

// song row → play the exact track, not a search for its title
resetState();
sandbox.likedSongs = [{ id: 'song42', title: 'Exact Track', channel: 'Artist' }];
eng.paint(eng.localRows('exact'));
let songRow = eng.rows.find(r => r.dataset.action === 'play');
eng.choose(songRow);
check('a song row plays the stored track object', calls.playSong.length === 1 && calls.playSong[0].id === 'song42');
check('a song row does not fall back to a title search', calls.doSearch.length === 0);

// recent/artist row → fill the box and run the search
resetState();
sandbox.searchHistory = ['lofi study'];
eng.paint(eng.localRows('lofi'));
let recentRow = eng.rows.find(r => r.dataset.action === 'search');
eng.choose(recentRow);
check('a search row fills the input', searchInput.value === 'lofi study');
check('a search row runs the search', calls.doSearch.includes('lofi study'));
check('a search row closes the dropdown', !searchSuggestions.classList.contains('active'));

/* =====================================================================
   14. escaping — titles and queries are untrusted
   ===================================================================== */
section('Output escaping');
resetState();
eng.paint([{ kind: 'song', label: 'x" onerror="alert(1)', song: { id: 'a"b', title: 'x' } }]);
check('a hostile title cannot break out of the text span', !/onerror="alert/.test(ssHtml) || /&quot;/.test(ssHtml));
check('esc() escapes double quotes', E.esc('a"b') === 'a&quot;b');
check('escId() strips attribute-breaking characters', E.escId('a"b<c') === 'abc');
}

/* ---------------------------------------------------------------- */
// The fetchRemote scenarios share one engine instance, so they run in sequence
// and the remaining synchronous sections follow them.
(async () => {
  section('fetchRemote correctness');
  for (const run of asyncScenarios) await run();
  syncSectionsAfterAsync();
  console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} — ${failures} failure(s)`);
  process.exit(failures ? 1 : 0);
})();
