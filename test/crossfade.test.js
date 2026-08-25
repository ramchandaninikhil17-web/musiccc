#!/usr/bin/env node
'use strict';

/*
 * Crossfade (Settings → Crossfade, 0–3 s).
 *
 * Runs the REAL CrossfadeManager, clampCrossfadeSeconds and steadyVolume out of
 * public/js/app.js against a fake <audio> element and fully controllable timers,
 * so a ramp can be stepped to completion deterministically with no wall clock.
 *
 * Every check here maps to a way this feature can break *silently* — the whole
 * point of a single-element fade is that a wrong volume write throws no error,
 * it just leaves the player mute behind a full-looking slider. In particular:
 *
 *   - restoring volume unconditionally would clobber ResumeManager.start(),
 *     which sets volume 0 on purpose and runs its own fade-in;
 *   - fading on repeat-one dips to silence once per lap for no reason;
 *   - a fade-out with nothing queued clips the ending of the last track;
 *   - a leaked interval keeps writing volume after the fade is over;
 *   - a duplicate 'playing' listener after a fast skip runs the fade-in twice.
 *
 * Run: node test/crossfade.test.js
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
const near = (a, b, eps) => Math.abs(a - b) <= (eps === undefined ? 1e-6 : eps);

/* ---------- pull the real code out of app.js ------------------------- */
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

// Brace-matched slice starting at a header regex (works for both
// `function name(` and `const name = {`).
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

const code = [
  extract(/\n  function steadyVolume\s*\(/),
  extract(/\n  function clampCrossfadeSeconds\s*\(/),
  extract(/\n  const CrossfadeManager = \{/),
].join('\n\n');
console.log(`Extracted CrossfadeManager + 2 helpers (${code.split('\n').length} lines) from app.js\n`);

/* ---------- controllable timers -------------------------------------- */
// Exactly one ramp interval is ever live at a time (CrossfadeManager.fadeTimer),
// plus at most one safety timeout. Firing them by hand removes the wall clock.
let nextId = 1;
const intervals = new Map();
const timeouts = new Map();
const fakeSetInterval = (fn) => { const id = nextId++; intervals.set(id, fn); return id; };
const fakeClearInterval = (id) => { intervals.delete(id); };
const fakeSetTimeout = (fn) => { const id = nextId++; timeouts.set(id, fn); return id; };
const fakeClearTimeout = (id) => { timeouts.delete(id); };

// Fire the live ramp interval until it clears itself (i >= steps) or a cap hits.
function runRamp(max = 500) {
  let n = 0;
  while (intervals.size && n++ < max) {
    const fn = intervals.values().next().value;
    fn();
  }
  return n;
}
function runTimeouts() {
  const fns = [...timeouts.values()];
  timeouts.clear();
  fns.forEach(f => f());
}

/* ---------- fake <audio> + DOM --------------------------------------- */
const playingListeners = [];
const audioPlayer = {
  volume: 0.8, muted: false, paused: false, ended: false,
  duration: 200, currentTime: 0,
  addEventListener(t, fn) { if (t === 'playing') playingListeners.push(fn); },
  removeEventListener(t, fn) {
    if (t !== 'playing') return;
    const i = playingListeners.indexOf(fn);
    if (i !== -1) playingListeners.splice(i, 1);
  },
};
const firePlaying = () => playingListeners.slice().forEach(f => f());
const playingCount = () => playingListeners.length;

const els = {
  '#settingCrossfade': { value: '0', _l: {}, addEventListener(t, fn) { this._l[t] = fn; } },
  '#crossfadeValLabel': { textContent: '' },
  '#settingAutoQueue': { checked: true },
};

const store = {};
const Storage = { get: (k, d) => (k in store ? store[k] : d), set: (k, v) => { store[k] = v; } };

const sandbox = {
  console,
  setInterval: fakeSetInterval, clearInterval: fakeClearInterval,
  setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
  audioPlayer, Storage,
  $: (sel) => els[sel] || null,
  volume: 0.8,
  repeatMode: 'off',
  isShuffle: false,
  queue: [],
  shuffleBag: [],
  currentIndex: -1,
  currentSong: null,
  SleepTimerManager: { fadeInterval: null },
};

const ctx = vm.createContext(sandbox);
try {
  vm.runInContext(code +
    '\n;globalThis.__x = { CrossfadeManager, clampCrossfadeSeconds, steadyVolume };', ctx);
} catch (err) {
  console.error('Extracted code failed to evaluate:', err.message);
  process.exit(1);
}
const { CrossfadeManager: cf, clampCrossfadeSeconds: clamp } = ctx.__x;
check('extracted code evaluates', typeof cf === 'object' && typeof cf.tick === 'function');

// Reset shared mutable state to a clean baseline between scenarios.
function reset(seconds) {
  intervals.clear(); timeouts.clear(); playingListeners.length = 0;
  audioPlayer.volume = 0.8; audioPlayer.muted = false; audioPlayer.paused = false;
  audioPlayer.ended = false; audioPlayer.duration = 200; audioPlayer.currentTime = 0;
  sandbox.volume = 0.8; sandbox.repeatMode = 'off'; sandbox.isShuffle = false;
  sandbox.queue = []; sandbox.shuffleBag = []; sandbox.currentIndex = -1;
  sandbox.currentSong = null; sandbox.SleepTimerManager.fadeInterval = null;
  els['#settingAutoQueue'].checked = true;
  cf.seconds = 0; cf.fadeTimer = null; cf.phase = 'idle';
  cf._fadeInArmed = false; cf._leftVolumeLow = false;
  cf._onPlaying = null; cf._safetyTimer = null;
  if (seconds !== undefined) cf.seconds = seconds;
}

/* ---------- 1. clamping ---------------------------------------------- */
section('Duration clamps to 0–3 whole seconds');
check('default is off (0)', clamp(0) === 0 && clamp(undefined) === 0);
check('5 → 3 (upper clamp)', clamp(5) === 3);
check('-1 → 0 (negatives are off)', clamp(-1) === 0);
check('1.4 → 1 (rounds)', clamp(1.4) === 1);
check('1.6 → 2 (rounds up)', clamp(1.6) === 2);
check("string '2' → 2", clamp('2') === 2);
check("garbage 'x' → 0", clamp('x') === 0);

/* ---------- 2. init + persistence ------------------------------------ */
section('Reads and writes the stored value');
reset();
store.crossfade = 2;
els['#settingCrossfade'].value = '0';
cf.init();
check('init restores the stored duration', cf.seconds === 2 && cf.isOn());
check('init reflects it onto the slider', els['#settingCrossfade'].value === '2');
check("init labels it '2s'", els['#crossfadeValLabel'].textContent === '2s');
check('init binds the slider on input', typeof els['#settingCrossfade']._l.input === 'function');

els['#settingCrossfade']._l.input({ target: { value: '3' } });
check('dragging the slider updates the duration', cf.seconds === 3);
check('dragging persists via Storage', store.crossfade === 3);
check("dragging relabels to '3s'", els['#crossfadeValLabel'].textContent === '3s');

els['#settingCrossfade']._l.input({ target: { value: '0' } });
check("turning it off relabels to 'Off'", els['#crossfadeValLabel'].textContent === 'Off');
check('turning it off persists 0', store.crossfade === 0);

/* ---------- 3. tick arms the fade-out near the end ------------------- */
section('Fade-out arms in the final N seconds');
reset(2);
sandbox.queue = [{ id: 'a' }, { id: 'b' }];
sandbox.currentIndex = 0;                 // there IS a follow-up
audioPlayer.currentTime = 199;            // 1s left, inside the 2s window
cf.tick();
check('enters the out phase', cf.phase === 'out');
check('arms the incoming fade-in', cf._fadeInArmed === true);
check('marks that a crossfade lowered the volume', cf._leftVolumeLow === true);
check('a ramp interval is running', cf.fadeTimer !== null);
runRamp();
check('tail settles exactly at silence', near(audioPlayer.volume, 0));
check('no interval leaks after the ramp', cf.fadeTimer === null && intervals.size === 0);

section('Fade-out does nothing when it should not');
reset(2);
sandbox.queue = [{ id: 'a' }, { id: 'b' }]; sandbox.currentIndex = 0;
audioPlayer.currentTime = 100;            // 100s left, nowhere near the end
cf.tick();
check('idle far from the end', cf.phase === 'idle' && cf.fadeTimer === null);

reset(2); cf.seconds = 0;                  // crossfade off
sandbox.queue = [{ id: 'a' }, { id: 'b' }]; sandbox.currentIndex = 0;
audioPlayer.currentTime = 199;
cf.tick();
check('off means no fade at all', cf.phase === 'idle' && cf.fadeTimer === null);

reset(2);
sandbox.repeatMode = 'one';
sandbox.queue = [{ id: 'a' }]; sandbox.currentIndex = 0;
audioPlayer.currentTime = 199;
cf.tick();
check('repeat-one never fades (same file loops)', cf.phase === 'idle' && cf.fadeTimer === null);

reset(2);
sandbox.SleepTimerManager.fadeInterval = 99;   // sleep timer owns the volume
sandbox.queue = [{ id: 'a' }, { id: 'b' }]; sandbox.currentIndex = 0;
audioPlayer.currentTime = 199;
cf.tick();
check('yields to the sleep timer fade', cf.phase === 'idle' && cf.fadeTimer === null);

reset(2);
audioPlayer.paused = true;
sandbox.queue = [{ id: 'a' }, { id: 'b' }]; sandbox.currentIndex = 0;
audioPlayer.currentTime = 199;
cf.tick();
check('does not fade a paused element', cf.phase === 'idle' && cf.fadeTimer === null);

reset(2);
audioPlayer.duration = Infinity;               // live stream
sandbox.queue = [{ id: 'a' }, { id: 'b' }]; sandbox.currentIndex = 0;
audioPlayer.currentTime = 199;
cf.tick();
check('non-finite (Infinity) duration is ignored', cf.phase === 'idle' && cf.fadeTimer === null);

reset(2);
audioPlayer.duration = NaN;                    // fresh element, metadata not in yet
sandbox.queue = [{ id: 'a' }, { id: 'b' }]; sandbox.currentIndex = 0;
audioPlayer.currentTime = 0;
cf.tick();
// Without the finite guard, remaining = NaN slips past every threshold compare
// and arms rampTo(1, 0, Math.max(150, NaN)) — an interval with a NaN period.
check('NaN duration never arms a fade', cf.phase === 'idle' && cf.fadeTimer === null);

/* ---------- 4. hasFollowUp gating ------------------------------------ */
section('No follow-up means no fade-out (do not clip the last track)');
reset(2);
sandbox.queue = [{ id: 'a' }]; sandbox.currentIndex = 0;   // last track
els['#settingAutoQueue'].checked = false;                  // and no auto-queue
audioPlayer.currentTime = 199;
cf.tick();
check('last track with auto-queue off does not fade', cf.phase === 'idle' && cf.fadeTimer === null);

reset(2);
sandbox.queue = [{ id: 'a' }]; sandbox.currentIndex = 0;
els['#settingAutoQueue'].checked = true;                   // auto-queue supplies more
audioPlayer.currentTime = 199;
cf.tick();
check('last track with auto-queue on DOES fade', cf.phase === 'out' && cf.fadeTimer !== null);
runRamp();

reset(2);
sandbox.repeatMode = 'all';
sandbox.queue = [{ id: 'a' }]; sandbox.currentIndex = 0;
els['#settingAutoQueue'].checked = false;
audioPlayer.currentTime = 199;
cf.tick();
check('repeat-all wraps, so the last track fades', cf.phase === 'out' && cf.fadeTimer !== null);
runRamp();

reset(2);
sandbox.isShuffle = true; sandbox.shuffleBag = [];         // shuffle cycle exhausted
sandbox.queue = [{ id: 'a' }, { id: 'b' }]; sandbox.currentIndex = 0;
els['#settingAutoQueue'].checked = false;
audioPlayer.currentTime = 199;
cf.tick();
check('empty shuffle bag with auto-queue off does not fade', cf.phase === 'idle');

/* ---------- 5. seek back out of the tail cancels & restores ---------- */
section('Seeking back out of the tail undoes the dip');
reset(2);
sandbox.queue = [{ id: 'a' }, { id: 'b' }]; sandbox.currentIndex = 0;
audioPlayer.currentTime = 199;
cf.tick();                                 // arm + start fading out
runRamp(3);                                // partway down
check('volume dipped', audioPlayer.volume < 0.8);
audioPlayer.currentTime = 100;             // user drags back to the middle
cf.tick();
check('fade cancelled on seek-back', cf.phase === 'idle' && cf.fadeTimer === null);
check('volume restored to the slider level', near(audioPlayer.volume, 0.8));
check('no longer armed after cancel', cf._fadeInArmed === false && cf._leftVolumeLow === false);

/* ---------- 6. armed onTrackStart rises from silence ----------------- */
section('Incoming track rises from silence');
reset(2);
sandbox.volume = 0.5;                       // respect the user's level
cf._fadeInArmed = true;
const songB = { id: 'b', title: 'B' };
sandbox.currentSong = songB;
cf.onTrackStart(songB);
check('starts the incoming track at silence', near(audioPlayer.volume, 0));
check('enters the in phase', cf.phase === 'in');
check('disarms after consuming the flag', cf._fadeInArmed === false);
check('registers exactly one playing listener', playingCount() === 1);
firePlaying();
check('playing listener detached after firing', playingCount() === 0);
runRamp();
check('rises to the user volume, not full scale', near(audioPlayer.volume, 0.5));
check('phase returns to idle', cf.phase === 'idle');
check('clears the lowered flag once risen', cf._leftVolumeLow === false);
check('no interval leaks after the fade-in', cf.fadeTimer === null && intervals.size === 0);

section('Muted incoming track does not arm a fade-in');
reset(2);
audioPlayer.muted = true;
cf._fadeInArmed = true; cf._leftVolumeLow = false;
sandbox.currentSong = songB;
cf.onTrackStart(songB);
check('muted: no fade-in set up', cf.phase === 'idle' && playingCount() === 0);

/* ---------- 7. armed but the track changed again --------------------- */
section('A fast second skip abandons the stale fade-in');
reset(2);
cf._fadeInArmed = true;
sandbox.currentSong = songB;
cf.onTrackStart(songB);
sandbox.currentSong = { id: 'c', title: 'C' };   // skipped on before B started
firePlaying();
check('stale fade-in bails without ramping', cf.fadeTimer === null && cf.phase === 'idle');
check('and restores the volume it had zeroed', near(audioPlayer.volume, 0.8));

section('Rapid re-arm never stacks playing listeners');
reset(2);
cf._fadeInArmed = true; sandbox.currentSong = songB;
cf.onTrackStart(songB);
cf._fadeInArmed = true;                            // next skip arms again
cf.onTrackStart(songB);
check('still exactly one playing listener', playingCount() === 1);

/* ---------- 8. unarmed onTrackStart must not fight ResumeManager ----- */
section('Unarmed onTrackStart leaves other volume owners alone');
reset(2);
// ResumeManager.start() set volume 0 on purpose and will fade in itself.
audioPlayer.volume = 0;
cf._fadeInArmed = false; cf._leftVolumeLow = false;
sandbox.currentSong = { id: 'z' };
cf.onTrackStart(sandbox.currentSong);
check('does NOT restore volume it never lowered (ResumeManager keeps its 0)',
  near(audioPlayer.volume, 0) && cf.phase === 'idle');

section('Unarmed onTrackStart after a dead-stream fade restores volume');
reset(2);
// A fade-out ran (so _leftVolumeLow), but the stream died and the next track is
// unarmed. Without a restore it would play at the tail volume, near zero.
audioPlayer.volume = 0.05;
cf._fadeInArmed = false; cf._leftVolumeLow = true;
sandbox.currentSong = { id: 'z' };
cf.onTrackStart(sandbox.currentSong);
check('restores when a crossfade had lowered it', near(audioPlayer.volume, 0.8));
check('clears the lowered flag', cf._leftVolumeLow === false);

/* ---------- 9. pause handling ---------------------------------------- */
section('Pause at the natural end preserves the armed fade-in');
reset(2);
cf.phase = 'out'; cf._fadeInArmed = true; cf._leftVolumeLow = true;
audioPlayer.ended = true;                   // browser paused because it ended
cf.onPause();
check('ended-pause keeps the fade-in armed', cf._fadeInArmed === true);

section('Pause during a fade-in does not cancel it (local/cloud src swap)');
reset(2);
cf.phase = 'in'; cf._fadeInArmed = false; cf.fadeTimer = 123;
audioPlayer.ended = false;
cf.onPause();
check('in-phase pause is a no-op', cf.phase === 'in' && cf.fadeTimer === 123);
cf.fadeTimer = null;

section('A real user pause cancels and restores');
reset(2);
cf.phase = 'out'; cf._leftVolumeLow = true; audioPlayer.volume = 0.1;
audioPlayer.ended = false;
cf.onPause();
check('user pause cancels the fade', cf.phase === 'idle' && cf.fadeTimer === null);
check('user pause restores the volume', near(audioPlayer.volume, 0.8));

/* ---------- 10. play handling ---------------------------------------- */
section('Play restarts a track we had faded to silence');
reset(2);
cf.phase = 'idle'; cf._leftVolumeLow = true; audioPlayer.volume = 0;
cf.onPlay();
check('play restores volume when a fade had zeroed it', near(audioPlayer.volume, 0.8));

section('Play during a fade-in leaves the fade-in alone');
reset(2);
cf.phase = 'in'; cf._leftVolumeLow = true; audioPlayer.volume = 0;
cf.onPlay();
check('in-phase play is a no-op', cf.phase === 'in' && near(audioPlayer.volume, 0));

/* ---------- 11. safety net ------------------------------------------- */
section('Safety net restores volume if audio never starts');
reset(2);
cf._fadeInArmed = true; sandbox.currentSong = songB;
cf.onTrackStart(songB);                      // sets volume 0, arms safety timeout
check('safety timeout scheduled', timeouts.size === 1);
// audio never fires 'playing' — fire the safety timeout instead.
runTimeouts();
check('safety net restores the volume', near(audioPlayer.volume, 0.8));
check('safety net returns to idle', cf.phase === 'idle');
check('safety net detaches the playing listener', playingCount() === 0);

/* ---------- 12. turning it off mid-fade ------------------------------ */
section('Switching crossfade off mid-fade strands nothing');
reset(2);
sandbox.queue = [{ id: 'a' }, { id: 'b' }]; sandbox.currentIndex = 0;
audioPlayer.currentTime = 199;
cf.tick();                                   // fading out
check('was fading', cf.fadeTimer !== null && cf.phase === 'out');
cf.set(0);                                   // user drags to Off
check('off cancels the running ramp', cf.fadeTimer === null && cf.phase === 'idle');
check('off restores the volume', near(audioPlayer.volume, 0.8));

/* ---------- 13. ramp respects a live volume change ------------------- */
section('The ramp tracks the live volume, not a captured target');
reset(3);
cf._fadeInArmed = true; sandbox.volume = 0.4; sandbox.currentSong = songB;
sandbox.currentSong = songB;
cf.onTrackStart(songB);
firePlaying();                               // start ramping 0 -> 1
runRamp(4);                                  // a few steps in
sandbox.volume = 0.8;                        // user turns the volume up mid-fade
runRamp();                                   // finish
check('fade-in lands on the NEW volume (0.8), not the old 0.4',
  near(audioPlayer.volume, 0.8));

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
