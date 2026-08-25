#!/usr/bin/env node
'use strict';

/*
 * Tests removing a song from a playlist using the REAL functions from
 * public/js/app.js, extracted by name and evaluated against a DOM stub.
 *
 * Removal accuracy is the whole point here, so the awkward cases get explicit
 * coverage: duplicate track ids in one playlist, a stale render index, a
 * double-click on an already-removed row, and whether Undo puts the song back
 * in its original position rather than at the end.
 *
 * Run: node test/playlist-remove.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`); }
};

/* ---------- pull the real functions out of app.js -------------------- */
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

function extractFn(name) {
  const re = new RegExp(`\\n  function ${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) throw new Error(`function ${name} not found in app.js`);
  const start = m.index + 1;
  let i = src.indexOf('{', m.index);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const NAMES = [
  'renderRecommendationCards', 'showPlaylistDetail', 'renderActivePlaylist',
  'syncPlaylistCardCount', 'removeSongFromPlaylist', 'undoToast',
  // Escaping helpers the card renderer calls. They are pulled in as live code
  // rather than stubbed because a stub that escapes differently from the real
  // one would make this suite pass while the shipped markup is unsafe.
  'escId', 'esc', 'thumb',
];

// The double-click guard lives in module scope, so pull the real declarations in
// rather than redeclaring them here with a guessed value.
const guardDecls = (src.match(/^  const PLAYLIST_REMOVE_GUARD_MS = .*$/m) || [])[0]
  + '\n' + (src.match(/^  let lastPlaylistRemoveAt = .*$/m) || [])[0];
if (/undefined/.test(guardDecls)) {
  console.error('Could not find the remove-guard declarations in app.js');
  process.exit(1);
}

const code = guardDecls + '\n\n' + NAMES.map(extractFn).join('\n\n');
console.log(`Extracted ${NAMES.length} live functions (${code.split('\n').length} lines) from app.js\n`);

/* ---------- DOM stub -------------------------------------------------- */
// Fake card that can replay the click handler the real renderer attached.
function makeCard(idx) {
  return {
    dataset: { idx: String(idx) },
    _click: null,
    addEventListener(type, fn) { if (type === 'click') this._click = fn; },
    // action=null simulates clicking the card body (play), otherwise a button.
    fire(action) {
      const target = { closest: () => (action ? { dataset: { action } } : null) };
      this._click({ target, stopPropagation() {} });
    },
  };
}

function makeGrid() {
  let html = '';
  let cards = [];
  return {
    get innerHTML() { return html; },
    set innerHTML(v) {
      html = v;
      // Rebuild the fake card list to match what was just rendered, exactly as
      // a browser would after replacing the grid's contents.
      const n = (v.match(/data-idx="/g) || []).length;
      cards = Array.from({ length: n }, (_, i) => makeCard(i));
    },
    querySelectorAll() { return cards; },
    get cards() { return cards; },
    style: {},
  };
}

const els = {};
function el(id, extra) {
  els[id] = Object.assign({ id, textContent: '', innerHTML: '', style: {} }, extra || {});
  return els[id];
}

const grid = makeGrid();
els.activePlaylistGrid = grid;
el('activePlaylistTitle');
el('activePlaylistCount');
el('activePlaylistSection', { scrollIntoView() {} });
el('likedSongsListSection');

// #playlistGrid only needs to answer the ".pc-count" lookup.
const pcCounts = {};
els.playlistGrid = {
  querySelector(sel) {
    const m = /data-plid="([^"]+)"/.exec(sel);
    if (!m) return null;
    if (!pcCounts[m[1]]) pcCounts[m[1]] = { textContent: '' };
    return pcCounts[m[1]];
  },
};

const toasts = [];
const stored = [];
const undoButtons = [];
// New card affordances (play count badge, dislike, play-next) are driven by
// module state the real functions read. Keep them as controllable stubs so this
// suite can assert the *markup and dispatch*, which is what it owns.
const playCountStub = {};
const dislikedStub = {};
const calls = { dislike: [], playnext: [] };
const toastContainer = { appendChild() {} };
let fakeNow = 1_000_000;
// Most tests are not about the guard, so advance past it by default.
const tick = (ms) => { fakeNow += ms; };

const sandbox = {
  console, setTimeout, clearTimeout,
  // Controllable clock so the double-click guard can be tested without sleeping.
  Date: { now: () => fakeNow },
  $: (sel) => els[String(sel).replace(/^#/, '')] || null,
  toast: (m) => toasts.push(m),
  // esc / escId / thumb are no longer stubbed here — they are extracted from
  // app.js by NAMES above, and those declarations shadow anything in this
  // sandbox. A stub would let unsafe shipped markup pass this suite.
  Storage: { set: (k, v) => stored.push({ k, n: Array.isArray(v) ? v.length : null }) },
  playlists: [],
  currentPlaylistId: null,
  toastContainer,
  renderLibrary: () => {},
  // card helpers
  isCurrent: () => false,
  isLiked: () => false,
  isDisliked: (id) => !!dislikedStub[id],
  getPlayCount: (id) => playCountStub[id] || 0,
  fmtDur: () => '3:00',
  // actions the renderer wires up but this test does not exercise
  playSong: () => {}, toggleLike: () => {}, addToQueue: () => {},
  openAddToPlaylist: () => {}, downloadSong: () => {},
  toggleDislike: (s) => calls.dislike.push(s && s.title),
  playNextInQueue: (s) => calls.playnext.push(s && s.title),
  document: {
    createElement: (tag) => {
      let _text = '';
      const node = {
        tagName: tag, className: '', type: '',
        _listeners: {}, children: [],
        appendChild(c) { this.children.push(c); },
        addEventListener(t, fn) { this._listeners[t] = fn; },
        classList: { add() {} },
        remove() {},
        get textContent() { return _text; },
        set textContent(v) { _text = v == null ? '' : String(v); },
        // The real esc() escapes by round-tripping through textContent ->
        // innerHTML, so the stub has to reproduce what a browser does there:
        // &, < and > are entity-encoded, quotes are left alone (esc handles
        // those itself). Without this the real esc() cannot be exercised.
        get innerHTML() { return _text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
      };
      return node;
    },
  },
};

// Capture undo buttons so the test can press them.
const realAppend = toastContainer.appendChild;
toastContainer.appendChild = function (node) {
  const btn = (node.children || []).find(c => c.className === 'toast-undo-btn');
  if (btn) undoButtons.push(btn);
  return realAppend.call(this, node);
};

const ctx = vm.createContext(sandbox);
try {
  vm.runInContext(code + '\n;globalThis.__fns = { renderActivePlaylist, removeSongFromPlaylist, showPlaylistDetail, renderRecommendationCards };', ctx);
} catch (err) {
  console.error('Extracted functions failed to evaluate:', err.message);
  process.exit(1);
}
const fns = ctx.__fns;
check('extracted functions evaluate', typeof fns.removeSongFromPlaylist === 'function');

const song = (id, title) => ({ id, title, channel: 'ch', duration: 180 });
const titles = () => sandbox.playlists.find(p => p.id === sandbox.currentPlaylistId).songs.map(s => s.title);
const setup = (songs) => {
  sandbox.playlists = [{ id: 'pl_1', name: 'Mix', songs: songs.slice() }];
  sandbox.currentPlaylistId = 'pl_1';
  toasts.length = 0; stored.length = 0; undoButtons.length = 0;
  tick(5000);   // clear the double-click guard between scenarios
  fns.renderActivePlaylist();
};

/* ---------- rendering ------------------------------------------------- */
console.log('\nRendering');
setup([song('a'.repeat(11), 'Alpha'), song('b'.repeat(11), 'Beta'), song('c'.repeat(11), 'Gamma')]);
check('a remove button is rendered on every card',
  (grid.innerHTML.match(/data-action="removepl"/g) || []).length === 3,
  (grid.innerHTML.match(/data-action="removepl"/g) || []).length);
check('song count shown in the header', els.activePlaylistCount.textContent === '3 songs',
  els.activePlaylistCount.textContent);
check('library card count kept in sync', pcCounts.pl_1.textContent === '3 songs',
  pcCounts.pl_1 && pcCounts.pl_1.textContent);

// The remove button must not leak into other grids.
const other = makeGrid();
fns.renderRecommendationCards(other, [song('d'.repeat(11), 'Delta')]);
check('remove button absent outside the playlist view',
  !/data-action="removepl"/.test(other.innerHTML));

/* ---------- new card affordances -------------------------------------- */
console.log('\nCard affordances (play count, dislike, play next)');
const pcId = 'p'.repeat(11);
const dlId = 'q'.repeat(11);
playCountStub[pcId] = 4;
playCountStub[dlId] = 1;
dislikedStub[dlId] = true;
const affGrid = makeGrid();
fns.renderRecommendationCards(affGrid, [song(pcId, 'Played Four'), song(dlId, 'Hated One')]);
check('play count badge rendered for a played track',
  /class="card-playcount"[^>]*>4×</.test(affGrid.innerHTML),
  (/class="card-playcount"[^>]*>[^<]*</.exec(affGrid.innerHTML) || [])[0]);
check('play count title is pluralised', /Played 4 times/.test(affGrid.innerHTML));
check('single play reads "1 time", not "1 times"',
  /Played 1 time"/.test(affGrid.innerHTML) && !/Played 1 times/.test(affGrid.innerHTML));
const unplayed = makeGrid();
fns.renderRecommendationCards(unplayed, [song('r'.repeat(11), 'Never Played')]);
check('unplayed track shows no badge text and no title',
  /class="card-playcount" title="">\s*</.test(unplayed.innerHTML.replace(/\n/g, '')),
  (/class="card-playcount"[^>]*>[^<]*</.exec(unplayed.innerHTML) || [])[0]);
check('dislike button reflects stored dislike state',
  (affGrid.innerHTML.match(/card-action-btn disliked" data-action="dislike"/g) || []).length === 1,
  (affGrid.innerHTML.match(/card-action-btn[^"]*" data-action="dislike"/g) || []).join(' | '));
check('every card offers dislike and play next',
  (affGrid.innerHTML.match(/data-action="dislike"/g) || []).length === 2 &&
  (affGrid.innerHTML.match(/data-action="playnext"/g) || []).length === 2);
affGrid.cards[1].fire('dislike');
check('dislike click routes to toggleDislike with the clicked song',
  JSON.stringify(calls.dislike) === JSON.stringify(['Hated One']), JSON.stringify(calls.dislike));
affGrid.cards[0].fire('playnext');
check('play next click routes to playNextInQueue with the clicked song',
  JSON.stringify(calls.playnext) === JSON.stringify(['Played Four']), JSON.stringify(calls.playnext));
// A card click that lands on no button must still play, not fall through to an action.
affGrid.cards[0].fire(null);
check('body click does not fire dislike or play next',
  calls.dislike.length === 1 && calls.playnext.length === 1);

/* ---------- the click actually reaches the handler -------------------- */
console.log('\nClick dispatch');
setup([song('a'.repeat(11), 'Alpha'), song('b'.repeat(11), 'Beta'), song('c'.repeat(11), 'Gamma')]);
grid.cards[1].fire('removepl');
check('clicking remove on card 2 removes exactly that song',
  JSON.stringify(titles()) === JSON.stringify(['Alpha', 'Gamma']), titles().join(','));
check('change was persisted', stored.some(s => s.k === 'playlists'), JSON.stringify(stored));
check('grid re-rendered with fresh indices', grid.cards.length === 2, grid.cards.length);
check('header count updated', els.activePlaylistCount.textContent === '2 songs',
  els.activePlaylistCount.textContent);

// Indices must be correct after a re-render, or the next click removes the wrong row.
tick(5000);
grid.cards[1].fire('removepl');
check('second removal after re-render still hits the right song',
  JSON.stringify(titles()) === JSON.stringify(['Alpha']), titles().join(','));

/* ---------- singular/plural and empty state --------------------------- */
console.log('\nCounts and empty state');
check('singular label for one song', els.activePlaylistCount.textContent === '1 song',
  els.activePlaylistCount.textContent);
tick(5000);
grid.cards[0].fire('removepl');
check('removing the last song empties the playlist', titles().length === 0, titles().length);
check('playlist-specific empty message, not "No songs available"',
  /Nothing in this playlist yet/.test(grid.innerHTML) && !/No songs available/.test(grid.innerHTML),
  grid.innerHTML.slice(0, 120));
check('count reads 0 songs', els.activePlaylistCount.textContent === '0 songs',
  els.activePlaylistCount.textContent);

/* ---------- duplicate ids: the accuracy crux -------------------------- */
console.log('\nDuplicate track ids in one playlist');
const dup = 'd'.repeat(11);
setup([song(dup, 'Dup First'), song(dup, 'Dup Second'), song('e'.repeat(11), 'Echo')]);
fns.removeSongFromPlaylist(1, { id: dup, title: 'Dup Second' });
check('removes the clicked occurrence, not the first match',
  JSON.stringify(titles()) === JSON.stringify(['Dup First', 'Echo']), titles().join(','));
check('only one copy was removed', titles().length === 2, titles().length);

/* ---------- stale index ---------------------------------------------- */
console.log('\nStale render index');
setup([song('a'.repeat(11), 'Alpha'), song('b'.repeat(11), 'Beta')]);
// Index points past the end (array shifted since render); id must win.
fns.removeSongFromPlaylist(9, { id: 'a'.repeat(11), title: 'Alpha' });
check('falls back to id lookup when the index is stale',
  JSON.stringify(titles()) === JSON.stringify(['Beta']), titles().join(','));

setup([song('a'.repeat(11), 'Alpha'), song('b'.repeat(11), 'Beta')]);
// Index points at a different song than the one clicked.
fns.removeSongFromPlaylist(0, { id: 'b'.repeat(11), title: 'Beta' });
check('mismatched index does not remove the wrong song',
  JSON.stringify(titles()) === JSON.stringify(['Alpha']), titles().join(','));

/* ---------- already removed ------------------------------------------ */
console.log('\nAlready-removed / double click');
setup([song('a'.repeat(11), 'Alpha')]);
fns.removeSongFromPlaylist(0, { id: 'z'.repeat(11), title: 'Ghost' });
check('unknown song leaves the playlist untouched',
  JSON.stringify(titles()) === JSON.stringify(['Alpha']), titles().join(','));
check('and says so instead of failing silently',
  toasts.some(t => /no longer in this playlist/i.test(t)), toasts.join('|'));

/* ---------- accidental double click ----------------------------------- */
// Re-rendering slides the next song's card up under the cursor, so without a
// guard the second half of a double click deletes a song the user never aimed at.
console.log('\nAccidental double click');
setup([song('a'.repeat(11), 'Alpha'), song('b'.repeat(11), 'Beta'), song('c'.repeat(11), 'Gamma')]);
grid.cards[0].fire('removepl');
tick(80);                        // a real double click, same screen position
grid.cards[0].fire('removepl');
check('a fast second click does not remove a second song',
  JSON.stringify(titles()) === JSON.stringify(['Beta', 'Gamma']), titles().join(','));

tick(5000);                      // deliberate click, well after the guard
grid.cards[0].fire('removepl');
check('a deliberate later click still removes',
  JSON.stringify(titles()) === JSON.stringify(['Gamma']), titles().join(','));

// Undo means the user is still working here, so it should not leave them
// waiting out the guard.
setup([song('a'.repeat(11), 'Alpha'), song('b'.repeat(11), 'Beta')]);
grid.cards[0].fire('removepl');
undoButtons[0]._listeners.click();
tick(10);
grid.cards[1].fire('removepl');
check('undo clears the guard so the next removal works immediately',
  JSON.stringify(titles()) === JSON.stringify(['Alpha']), titles().join(','));

/* ---------- guard rails ---------------------------------------------- */
console.log('\nGuard rails');
setup([song('a'.repeat(11), 'Alpha')]);
sandbox.currentPlaylistId = 'gone';
fns.removeSongFromPlaylist(0, { id: 'a'.repeat(11), title: 'Alpha' });
check('no open playlist is refused', toasts.some(t => /No playlist is open/i.test(t)), toasts.join('|'));
sandbox.currentPlaylistId = 'pl_1';
check('and nothing was removed', sandbox.playlists[0].songs.length === 1);

toasts.length = 0;
fns.removeSongFromPlaylist(0, null);
check('missing song object is refused',
  toasts.some(t => /Could not identify/i.test(t)) && sandbox.playlists[0].songs.length === 1,
  toasts.join('|'));

/* ---------- undo ------------------------------------------------------ */
console.log('\nUndo');
setup([song('a'.repeat(11), 'Alpha'), song('b'.repeat(11), 'Beta'), song('c'.repeat(11), 'Gamma')]);
grid.cards[1].fire('removepl');
check('an undo button was offered', undoButtons.length === 1, undoButtons.length);
undoButtons[0]._listeners.click();
check('undo restores the song at its original position, not the end',
  JSON.stringify(titles()) === JSON.stringify(['Alpha', 'Beta', 'Gamma']), titles().join(','));
check('undo re-persisted the playlist',
  stored.filter(s => s.k === 'playlists').length === 2,
  stored.filter(s => s.k === 'playlists').length);
check('undo refreshed the count', els.activePlaylistCount.textContent === '3 songs',
  els.activePlaylistCount.textContent);

// Pressing undo twice must not duplicate the song.
undoButtons[0]._listeners.click();
check('undo is idempotent', titles().length === 3, titles().join(','));

// Undo of the first song restores to index 0.
setup([song('a'.repeat(11), 'Alpha'), song('b'.repeat(11), 'Beta')]);
grid.cards[0].fire('removepl');
undoButtons[0]._listeners.click();
check('undo of the first song restores it to the front',
  JSON.stringify(titles()) === JSON.stringify(['Alpha', 'Beta']), titles().join(','));

// Undo after the playlist itself is gone must not throw.
setup([song('a'.repeat(11), 'Alpha')]);
grid.cards[0].fire('removepl');
sandbox.playlists = [];
let threw = null;
try { undoButtons[0]._listeners.click(); } catch (e) { threw = e; }
check('undo after the playlist was deleted fails safely', threw === null,
  threw && threw.message);
check('and explains why', toasts.some(t => /no longer exists/i.test(t)), toasts.join('|'));

/* ---------- long titles ---------------------------------------------- */
console.log('\nLong titles');
const longTitle = 'A'.repeat(120);
setup([song('a'.repeat(11), longTitle)]);
grid.cards[0].fire('removepl');
const msg = undoButtons[0] && undoButtons[0].textContent;
check('undo button is still labelled Undo', msg === 'Undo', msg);

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
