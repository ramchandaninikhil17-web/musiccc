#!/usr/bin/env node
'use strict';

/*
 * Queue management: reorder (drag + buttons), Play Next, remove, clear.
 *
 * Uses the REAL functions from public/js/app.js, extracted by name and run
 * against a DOM stub that can replay the drag events the renderer attaches.
 *
 * The thing worth guarding here is that currentIndex keeps pointing at the same
 * SONG after a reorder, not the same slot. Get that wrong and the highlight,
 * Next/Prev and the shuffle bag all silently drift — nothing throws, the wrong
 * track just plays.
 *
 * Run: node test/queue-reorder.test.js
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
  'addToQueue', 'playNextInQueue', 'moveQueueItem', 'removeFromQueue',
  'clearQueue', 'updateQueueUI',
  // Live, not stubbed: a stub that escapes differently would let unsafe shipped
  // markup pass this suite.
  'esc', 'thumb',
];

// The drag cursor lives in module scope. Pull the real declaration in rather
// than guessing its initial value — a wrong guess would mask a stale-index bug.
const dragDecl = (src.match(/^  let queueDragFrom = .*$/m) || [])[0];
if (!dragDecl) {
  console.error('Could not find the queueDragFrom declaration in app.js');
  process.exit(1);
}

const code = dragDecl + '\n\n' + NAMES.map(extractFn).join('\n\n');
console.log(`Extracted ${NAMES.length} live functions (${code.split('\n').length} lines) from app.js\n`);

/* ---------- DOM stub -------------------------------------------------- */
function classListFor(store) {
  return {
    add: (c) => { store.add(c); },
    remove: (c) => { store.delete(c); },
    contains: (c) => store.has(c),
    toggle: (c, on) => { if (on === undefined ? store.has(c) : !on) store.delete(c); else store.add(c); },
  };
}

// A queue row that can replay every listener the renderer attached.
function makeRow(idx, classes) {
  const store = new Set(String(classes || '').trim().split(/\s+/).filter(Boolean));
  return {
    dataset: { idx: String(idx) },
    classList: classListFor(store),
    _classes: store,
    _l: {},
    addEventListener(t, fn) { this._l[t] = fn; },
    scrollIntoView() {},
    // Click on the row body (action=null) or on one of its buttons.
    fire(action) {
      this._l.click({
        target: { closest: () => (action ? { dataset: { action } } : null) },
        stopPropagation() {},
      });
    },
    dispatch(type, extra) {
      if (!this._l[type]) throw new Error(`no ${type} listener on row ${idx}`);
      this._l[type](Object.assign({
        preventDefault() {}, stopPropagation() {},
        dataTransfer: { setData() {}, effectAllowed: '', dropEffect: '' },
      }, extra || {}));
    },
  };
}

function makeQueueList() {
  let html = '';
  let rows = [];
  return {
    get innerHTML() { return html; },
    set innerHTML(v) {
      html = v;
      // Rebuild rows to match what was just rendered, as a browser would after
      // replacing the container's contents.
      rows = [...v.matchAll(/class="queue-item ([^"]*)" data-idx="(\d+)"/g)]
        .map(m => makeRow(Number(m[2]), m[1]));
    },
    querySelectorAll(sel) {
      if (sel === '.queue-item') return rows;
      if (sel === '.drag-over') return rows.filter(r => r._classes.has('drag-over'));
      return [];
    },
    querySelector(sel) {
      if (sel === '.queue-item.active') return rows.find(r => r._classes.has('active')) || null;
      return null;
    },
    get rows() { return rows; },
    style: {},
  };
}

const badgeClasses = new Set();
const queueBadge = { textContent: '', classList: classListFor(badgeClasses) };
const queueList = makeQueueList();

const toasts = [];
const played = [];
let paused = 0;

const sandbox = {
  console, setTimeout, clearTimeout,
  queueBadge, queueList,
  queue: [],
  currentIndex: -1,
  isShuffle: false,
  shuffleBag: [],
  playOrderHistory: [],
  toast: (m) => toasts.push(m),
  fmtDur: () => '3:00',
  audioPlayer: { pause() { paused++; } },
  playSong: (s) => {
    played.push(s && s.title);
    // Mirror the real playSong contract the queue code relies on: it recomputes
    // currentIndex from the song id.
    sandbox.currentIndex = sandbox.queue.findIndex(q => q.id === (s && s.id));
  },
  document: {
    createElement: () => {
      let _text = '';
      return {
        get textContent() { return _text; },
        set textContent(v) { _text = v == null ? '' : String(v); },
        get innerHTML() { return _text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
      };
    },
  },
};

const ctx = vm.createContext(sandbox);
try {
  vm.runInContext(code +
    '\n;globalThis.__fns = { addToQueue, playNextInQueue, moveQueueItem, removeFromQueue, clearQueue, updateQueueUI };',
    ctx);
} catch (err) {
  console.error('Extracted functions failed to evaluate:', err.message);
  process.exit(1);
}
const fns = ctx.__fns;
check('extracted functions evaluate', typeof fns.moveQueueItem === 'function');

const song = (id, title) => ({ id, title, channel: 'ch', duration: 180, thumbnail: '' });
const ids = 'abcdefgh';
const titles = () => sandbox.queue.map(s => s.title);
const playingTitle = () => (sandbox.currentIndex >= 0 ? sandbox.queue[sandbox.currentIndex].title : null);

// n rows named A..H, with `playing` (0-based) marked as the current track.
const setup = (n, playing) => {
  sandbox.queue = Array.from({ length: n }, (_, i) => song(ids[i].repeat(11), ids[i].toUpperCase()));
  sandbox.currentIndex = playing === undefined ? -1 : playing;
  sandbox.isShuffle = false;
  sandbox.shuffleBag = [];
  sandbox.playOrderHistory = [];
  toasts.length = 0; played.length = 0; paused = 0;
  fns.updateQueueUI();
};

/* ---------- rendering ------------------------------------------------- */
section('Rendering');
setup(3, 1);
check('every row is draggable', (queueList.innerHTML.match(/draggable="true"/g) || []).length === 3,
  (queueList.innerHTML.match(/draggable="true"/g) || []).length);
check('every row has a drag grip', (queueList.innerHTML.match(/class="qi-grip"/g) || []).length === 3);
check('every row has move up/down buttons',
  (queueList.innerHTML.match(/data-action="qup"/g) || []).length === 3 &&
  (queueList.innerHTML.match(/data-action="qdown"/g) || []).length === 3);
check('the playing row is marked active',
  (queueList.innerHTML.match(/class="queue-item active"/g) || []).length === 1);
check('badge shows the count', queueBadge.textContent === 3, queueBadge.textContent);
// The badge is read elsewhere via classList.contains('visible'); it must be
// written the same way or the dot never appears.
check("badge visibility uses the 'visible' class", badgeClasses.has('visible'));

setup(0);
check('empty queue shows the empty state', /Queue is empty/.test(queueList.innerHTML));
check('badge hidden when empty', !badgeClasses.has('visible') && queueBadge.textContent === 0);

// Titles reach innerHTML, so they must be escaped.
sandbox.queue = [{ id: 'x'.repeat(11), title: '<img src=x onerror=alert(1)>', channel: '"><b>', duration: 1 }];
sandbox.currentIndex = -1;
fns.updateQueueUI();
check('titles are escaped, not injected',
  !/<img src=x/.test(queueList.innerHTML) && /&lt;img/.test(queueList.innerHTML),
  queueList.innerHTML.slice(queueList.innerHTML.indexOf('qi-title'), 120));

/* ---------- moveQueueItem: the index contract ------------------------- */
section('moveQueueItem');
setup(4, 0);                                   // A playing
check('moving a later row down does not disturb the playing row',
  fns.moveQueueItem(1, 3, { silent: true }) &&
  JSON.stringify(titles()) === JSON.stringify(['A', 'C', 'D', 'B']) &&
  playingTitle() === 'A', `${titles()} playing=${playingTitle()}`);

setup(4, 0);
fns.moveQueueItem(3, 0, { silent: true });     // D to the front, ahead of playing A
check('dragging a row above the playing track keeps the highlight on that song',
  JSON.stringify(titles()) === JSON.stringify(['D', 'A', 'B', 'C']) && playingTitle() === 'A',
  `${titles()} playing=${playingTitle()}`);
check('currentIndex followed the song, not the slot', sandbox.currentIndex === 1, sandbox.currentIndex);

setup(4, 2);
fns.moveQueueItem(2, 0, { silent: true });     // drag the playing track itself
check('dragging the playing track moves it and the highlight together',
  JSON.stringify(titles()) === JSON.stringify(['C', 'A', 'B', 'D']) && playingTitle() === 'C',
  `${titles()} playing=${playingTitle()}`);

setup(4, 3);
fns.moveQueueItem(0, 2, { silent: true });     // downward move (splice asymmetry)
check('downward move lands where the row was dropped',
  JSON.stringify(titles()) === JSON.stringify(['B', 'C', 'A', 'D']), titles().join(','));
check('and the playing track is still D', playingTitle() === 'D', playingTitle());

setup(3, 0);
check('dropping on itself is a no-op', fns.moveQueueItem(1, 1) === false);
check('out-of-range source is refused', fns.moveQueueItem(9, 0) === false &&
  fns.moveQueueItem(-1, 0) === false);
check('nothing moved and nothing was announced',
  JSON.stringify(titles()) === JSON.stringify(['A', 'B', 'C']) && toasts.length === 0,
  toasts.join('|'));

setup(3, 0);
check('a drop past the last row clamps to the end',
  fns.moveQueueItem(0, 99, { silent: true }) &&
  JSON.stringify(titles()) === JSON.stringify(['B', 'C', 'A']), titles().join(','));

setup(3, 0);
fns.moveQueueItem(0, 2);
check('a manual reorder is announced', toasts.some(t => /reorder/i.test(t)), toasts.join('|'));
setup(3, 0);
fns.moveQueueItem(0, 2, { silent: true });
check('silent reorders stay silent (drag already gives feedback)', toasts.length === 0,
  toasts.join('|'));

// With no playing track there is no id to track; it must not throw or invent one.
setup(3);
check('reorder with nothing playing works and leaves currentIndex at -1',
  fns.moveQueueItem(0, 2, { silent: true }) && sandbox.currentIndex === -1,
  sandbox.currentIndex);

/* ---------- up/down buttons (the touch path) -------------------------- */
section('Move up / move down buttons');
setup(3, 1);
queueList.rows[2].fire('qup');
check('qup swaps a row with the one above',
  JSON.stringify(titles()) === JSON.stringify(['A', 'C', 'B']), titles().join(','));
check('the playing song is still B', playingTitle() === 'B', playingTitle());

setup(3, 0);
queueList.rows[0].fire('qup');
check('qup on the first row does nothing (clamped, not wrapped)',
  JSON.stringify(titles()) === JSON.stringify(['A', 'B', 'C']), titles().join(','));
queueList.rows[2].fire('qdown');
check('qdown on the last row does nothing',
  JSON.stringify(titles()) === JSON.stringify(['A', 'B', 'C']), titles().join(','));

setup(3, 0);
queueList.rows[0].fire('qdown');
check('qdown moves a row down', JSON.stringify(titles()) === JSON.stringify(['B', 'A', 'C']),
  titles().join(','));
check('reorder buttons do not start playback', played.length === 0, played.join(','));

// A body click still plays; the buttons must not swallow it.
setup(3, 0);
queueList.rows[2].fire(null);
check('clicking a row body plays that song', played.join(',') === 'C', played.join(','));

/* ---------- drag and drop -------------------------------------------- */
section('Drag and drop');
setup(4, 0);
queueList.rows[1].dispatch('dragstart');
check('the dragged row is marked', queueList.rows[1]._classes.has('dragging'));
queueList.rows[3].dispatch('dragover');
check('a valid target highlights', queueList.rows[3]._classes.has('drag-over'));
queueList.rows[3].dispatch('drop');
check('drop reorders to the target row',
  JSON.stringify(titles()) === JSON.stringify(['A', 'C', 'D', 'B']), titles().join(','));
check('drop is silent (the gesture is its own feedback)', toasts.length === 0, toasts.join('|'));

// Dragging over the row being dragged must not suggest a drop.
setup(3, 0);
queueList.rows[0].dispatch('dragstart');
queueList.rows[0].dispatch('dragover');
check('the source row does not highlight itself', !queueList.rows[0]._classes.has('drag-over'));
queueList.rows[1].dispatch('dragover');
queueList.rows[1].dispatch('dragleave');
check('dragleave clears the highlight', !queueList.rows[1]._classes.has('drag-over'));

// An abandoned drag (dropped outside any row) must not leave a live index
// behind, or the next unrelated drop would move a random row.
setup(3, 0);
queueList.rows[0].dispatch('dragstart');
queueList.rows[1].dispatch('dragover');
queueList.rows[0].dispatch('dragend');
check('dragend clears the dragging class', !queueList.rows[0]._classes.has('dragging'));
check('dragend clears every leftover highlight',
  queueList.rows.every(r => !r._classes.has('drag-over')));
queueList.rows[2].dispatch('drop');
check('a drop after an abandoned drag does nothing',
  JSON.stringify(titles()) === JSON.stringify(['A', 'B', 'C']), titles().join(','));

// drop itself must clear the index, not lean on dragend: the drop re-renders the
// list, so the source node dragend would fire on is already detached and the
// event may never arrive. Two drops in a row with one dragstart is the test.
setup(4, 0);
queueList.rows[1].dispatch('dragstart');
queueList.rows[2].dispatch('drop');
const afterFirstDrop = titles().join(',');
queueList.rows[3].dispatch('drop');            // no new dragstart
check('drop clears the drag index itself, without relying on dragend',
  titles().join(',') === afterFirstDrop, `${afterFirstDrop} -> ${titles().join(',')}`);

// Firefox aborts a drag that carries no payload, so dragstart must write one.
setup(3, 0);
const dt = { _set: [], setData(t, v) { this._set.push([t, v]); }, effectAllowed: '', dropEffect: '' };
queueList.rows[1].dispatch('dragstart', { dataTransfer: dt });
check("dragstart puts a payload on the dataTransfer (Firefox needs one)",
  dt._set.length === 1 && dt._set[0][0] === 'text/plain' && dt._set[0][1] === '1',
  JSON.stringify(dt._set));
check("dragstart advertises a move, not a copy", dt.effectAllowed === 'move', dt.effectAllowed);
const dt2 = { setData() {}, effectAllowed: '', dropEffect: '' };
queueList.rows[2].dispatch('dragover', { dataTransfer: dt2 });
check("dragover shows the move cursor", dt2.dropEffect === 'move', dt2.dropEffect);
queueList.rows[1].dispatch('dragend');

// A dataTransfer that throws on setData (older browsers on some MIME types)
// must not abort the drag.
setup(3, 0);
let threw = null;
try {
  queueList.rows[0].dispatch('dragstart', {
    dataTransfer: { setData() { throw new Error('nope'); }, effectAllowed: '', dropEffect: '' },
  });
  queueList.rows[2].dispatch('drop');
} catch (e) { threw = e; }
check('a dataTransfer that rejects setData still allows the reorder',
  threw === null && JSON.stringify(titles()) === JSON.stringify(['B', 'C', 'A']),
  threw ? threw.message : titles().join(','));
// And a drag with no dataTransfer at all (synthetic events) must not throw.
setup(3, 0);
threw = null;
try {
  queueList.rows[0].dispatch('dragstart', { dataTransfer: null });
  queueList.rows[1].dispatch('dragover', { dataTransfer: null });
  queueList.rows[1].dispatch('drop', { dataTransfer: null });
} catch (e) { threw = e; }
check('a drag event with no dataTransfer is handled',
  threw === null && JSON.stringify(titles()) === JSON.stringify(['B', 'A', 'C']),
  threw ? threw.message : titles().join(','));

// A drop with no drag at all (e.g. text dragged in from outside).
setup(3, 0);
queueList.rows[1].dispatch('drop');
check('a drop with no preceding dragstart is ignored',
  JSON.stringify(titles()) === JSON.stringify(['A', 'B', 'C']), titles().join(','));

// dragover before any dragstart must not preventDefault a foreign drag.
setup(3, 0);
let prevented = false;
queueList.rows[1].dispatch('dragover', { preventDefault() { prevented = true; } });
check('dragover without a drag in progress does not claim the drop', prevented === false);

/* ---------- Play Next ------------------------------------------------- */
section('Play Next');
setup(3, 0);
fns.playNextInQueue(song('z'.repeat(11), 'Z'));
check('a new track lands right after the playing one',
  JSON.stringify(titles()) === JSON.stringify(['A', 'Z', 'B', 'C']), titles().join(','));
check('the playing track is unchanged', playingTitle() === 'A', playingTitle());
check('nothing started playing', played.length === 0, played.join(','));
check('the user is told', toasts.some(t => /next/i.test(t)), toasts.join('|'));

setup(3);                                       // nothing playing
fns.playNextInQueue(song('z'.repeat(11), 'Z'));
check('with nothing playing it goes to the front',
  JSON.stringify(titles()) === JSON.stringify(['Z', 'A', 'B', 'C']), titles().join(','));
check('and currentIndex stays at -1', sandbox.currentIndex === -1, sandbox.currentIndex);

setup(4, 0);
fns.playNextInQueue(sandbox.queue[3]);          // already queued, further down
check('an already-queued track is moved up rather than duplicated',
  JSON.stringify(titles()) === JSON.stringify(['A', 'D', 'B', 'C']), titles().join(','));
check('no duplicate was created', sandbox.queue.length === 4, sandbox.queue.length);
check('the highlight is still on A', playingTitle() === 'A', playingTitle());

setup(3, 1);
toasts.length = 0;
fns.playNextInQueue(sandbox.queue[1]);          // the playing track itself
check('play-next on the current track changes nothing',
  JSON.stringify(titles()) === JSON.stringify(['A', 'B', 'C']), titles().join(','));
check('and says it is already playing',
  toasts.some(t => /playing now/i.test(t)), toasts.join('|'));

setup(3, 0);
fns.playNextInQueue(null);
fns.playNextInQueue({ title: 'no id' });
check('a missing song or id is ignored without throwing', sandbox.queue.length === 3,
  sandbox.queue.length);

// Shuffle picks from a bag of ids; a track inserted without a bag entry would
// never be chosen.
setup(3, 0);
sandbox.isShuffle = true;
sandbox.shuffleBag = [];
fns.playNextInQueue(song('z'.repeat(11), 'Z'));
check('play-next feeds the shuffle bag', sandbox.shuffleBag.includes('z'.repeat(11)),
  JSON.stringify(sandbox.shuffleBag));
setup(3, 0);
sandbox.isShuffle = true;
sandbox.shuffleBag = [];
fns.addToQueue(song('y'.repeat(11), 'Y'));
check('add-to-queue feeds the shuffle bag too', sandbox.shuffleBag.includes('y'.repeat(11)),
  JSON.stringify(sandbox.shuffleBag));

/* ---------- add / remove / clear still behave ------------------------- */
section('Add, remove, clear');
setup(3, 0);
fns.addToQueue(sandbox.queue[1]);
check('adding a duplicate is refused', sandbox.queue.length === 3 &&
  toasts.some(t => /already in queue/i.test(t)), toasts.join('|'));

setup(3, 2);
queueList.rows[0].fire('remove');
check('removing a row above the playing one keeps the highlight',
  JSON.stringify(titles()) === JSON.stringify(['B', 'C']) && playingTitle() === 'C',
  `${titles()} playing=${playingTitle()}`);

setup(3, 1);
queueList.rows[1].fire('remove');              // remove the playing track
check('removing the playing track advances to the next one',
  JSON.stringify(titles()) === JSON.stringify(['A', 'C']) && played.join(',') === 'C',
  `${titles()} played=${played.join(',')}`);

setup(1, 0);
queueList.rows[0].fire('remove');
check('removing the last track empties the queue and pauses',
  sandbox.queue.length === 0 && sandbox.currentIndex === -1 && paused === 1,
  `len=${sandbox.queue.length} idx=${sandbox.currentIndex} paused=${paused}`);

setup(4, 2);
fns.clearQueue();
check('clear keeps only the playing track',
  JSON.stringify(titles()) === JSON.stringify(['C']) && sandbox.currentIndex === 0,
  `${titles()} idx=${sandbox.currentIndex}`);
check('clear resets the shuffle bag and play history',
  sandbox.shuffleBag.length === 0 &&
  JSON.stringify(sandbox.playOrderHistory) === JSON.stringify(['c'.repeat(11)]),
  JSON.stringify(sandbox.playOrderHistory));

setup(3);
fns.clearQueue();
check('clear with nothing playing empties the queue',
  sandbox.queue.length === 0 && sandbox.currentIndex === -1,
  `len=${sandbox.queue.length} idx=${sandbox.currentIndex}`);

/* ---------- no index can ever go out of range ------------------------- */
section('Index invariant under random operations');
// Fuzzing the reorder paths is the cheapest way to prove the index arithmetic
// holds for combinations no hand-written case covers.
let broke = null;
let rng = 12345;
const rand = (n) => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng % n; };
for (let trial = 0; trial < 400 && !broke; trial++) {
  setup(5, rand(5));
  const before = playingTitle();
  for (let step = 0; step < 6; step++) {
    fns.moveQueueItem(rand(5), rand(7), { silent: true });
    if (sandbox.currentIndex < 0 || sandbox.currentIndex >= sandbox.queue.length) {
      broke = `currentIndex ${sandbox.currentIndex} out of range (len ${sandbox.queue.length})`;
      break;
    }
    if (playingTitle() !== before) {
      broke = `highlight drifted from ${before} to ${playingTitle()}`;
      break;
    }
  }
  if (!broke && sandbox.queue.length !== 5) broke = `queue length changed to ${sandbox.queue.length}`;
  if (!broke && new Set(titles()).size !== 5) broke = `duplicate or lost row: ${titles().join(',')}`;
}
check('400 random reorder runs never lose or duplicate a row, and never lose the highlight',
  broke === null, broke);

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
