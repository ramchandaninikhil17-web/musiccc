#!/usr/bin/env node
/*
 * Voice assistant ("Hey My Ruby").
 *
 * The real VOICE_* constants, VoiceCommands and VoiceAssistant are sliced out of
 * app.js and evaluated against stubs, so what runs here is the shipped code.
 *
 * Three things this suite exists to catch, none of which surface as an error in
 * the browser:
 *
 *   1. Intent order. "play my liked songs" must reach the liked-songs handler,
 *      not the generic "play <words>" search at the bottom of parse(). Get the
 *      order wrong and the app cheerfully searches YouTube for the phrase "my
 *      liked songs" — a plausible-looking result page instead of the feature.
 *
 *   2. Toggles used as commands. toggleShuffle() and togglePlayPause() flip;
 *      "shuffle this playlist" and "pause" do not. Calling the toggle blindly
 *      means the second identical command undoes the first.
 *
 *   3. Restart loops. A recognition session always ends eventually, so staying
 *      open means restarting in onend. A session that fails instantly —
 *      permission denied being the common case — then restarts forever, pinning
 *      the CPU with no visible cause.
 *
 * Always-on listening adds two more:
 *
 *   4. False wakes. The mic is open all day, so the gate has to be a *led*
 *      phrase ("hey ruby"). Accept the bare name and song lyrics start issuing
 *      commands.
 *
 *   5. Dying quietly. Armed mode has no HUD by design, so a session that ends
 *      and never comes back looks exactly like a session that is listening. The
 *      backoff, the watchdog and the visibility handler are all about that.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`); }
};
const section = (t) => console.log(`\n${t}`);

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');

/* ---------- pull the real code out of app.js ------------------------- */
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
function extractArray(re) {
  const m = re.exec(src);
  if (!m) throw new Error(`could not find ${re} in app.js`);
  let i = src.indexOf('[', m.index);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(m.index, i) + ';';
}
function line(re) {
  const m = re.exec(src);
  if (!m) throw new Error(`could not find ${re} in app.js`);
  return m[0];
}
// From the start of one match to the end of the line another match sits on. The
// wake list is built by a loop over two source arrays, so there is no single
// brace- or bracket-delimited thing to grab.
function block(startRe, endRe) {
  const a = startRe.exec(src);
  const b = endRe.exec(src);
  if (!a || !b) throw new Error(`could not find ${a ? endRe : startRe} in app.js`);
  const end = src.indexOf('\n', b.index + b[0].length);
  return src.slice(a.index, end < 0 ? src.length : end);
}

const commandsSrc = extract(/\n  const VoiceCommands = \{/);
const assistantSrc = extract(/\n  const VoiceAssistant = \{/);
const pickSrc = extract(/\n  const VoicePick = \{/);
const chimeSrc = extract(/\n  const VoiceChime = \{/);
// The real cleanArtist, not a copy: "songs like this" builds its query from it.
const cleanArtistSrc = line(/cleanArtist\(name\) \{[^\n]*\},/);
const appCode = [
  block(/\n  const VOICE_WAKE_NAMES = \[/, /\n  const VOICE_WAKE = /),
  extractArray(/\n  const VOICE_MOODS = \[/),
  commandsSrc,
  line(/\n  const VOICE_BAD_RE = [^\n]+/),
  line(/\n  const VOICE_OFFICIAL_RE = [^\n]+/),
  line(/\n  const VOICE_LABEL_RE = [^\n]+/),
  pickSrc,
  chimeSrc,
  line(/\n  const VOICE_IDLE_MS = \d+;/),
  line(/\n  const VOICE_RESTART_MS = \d+;/),
  line(/\n  const VOICE_MAX_RESTARTS = \d+;/),
  line(/\n  const VOICE_BACKOFF_MS = \d+;/),
  line(/\n  const VOICE_WATCHDOG_MS = \d+;/),
  line(/\n  const VOICE_HUD_MS = \d+;/),
  assistantSrc,
].join('\n\n');
console.log(`Extracted VoiceCommands + VoiceAssistant (${appCode.split('\n').length} lines) from app.js\n`);

// Comments in this feature mention innerHTML and keydown by name, which would
// defeat the static checks below.
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}
const voiceNoComments = stripComments([commandsSrc, pickSrc, chimeSrc, assistantSrc].join('\n'));

/* ---------- environment ---------------------------------------------- */
// A whole fresh context per scenario: VoiceAssistant is a singleton with an
// `inited` latch, so lifecycle tests cannot share one.
function makeEnv(opts) {
  opts = opts || {};
  const calls = {
    log: [], toasts: [], searches: [], navigated: [], addedToPlaylist: [], nextResults: [],
    played: [], stored: [], permissionQueries: 0, permissionNames: [],
  };
  const recs = [];
  const ctxs = [];
  let now = 0;
  const timers = [];      // {id, at, fn, cleared}
  const intervals = [];   // {id, at, every, fn, cleared} — kept apart from timers
  let nextId = 1;

  const clock = {
    // Timeouts and intervals are merged by due time, so a watchdog tick that
    // lands between two timeouts fires in the order the browser would fire it.
    advance(ms) {
      const until = now + ms;
      for (let guard = 0; guard < 10000; guard++) {
        const soonest = (list) => list.filter(t => !t.cleared && t.at <= until).sort((a, b) => a.at - b.at)[0];
        const dueT = soonest(timers);
        const dueI = soonest(intervals);
        const due = !dueT ? dueI : (!dueI || dueT.at <= dueI.at) ? dueT : dueI;
        if (!due) break;
        now = due.at;
        if (due.every) due.at = now + due.every;   // reschedule before firing
        else due.cleared = true;
        due.fn();
      }
      now = until;
    },
    // Deliberately counts one-shot timers only: the watchdog interval lives for
    // the life of the page, so counting it would make "leaves no timer behind"
    // unwritable.
    pending() { return timers.filter(t => !t.cleared).length; },
    intervals() { return intervals.filter(t => !t.cleared).length; },
    now() { return now; },
  };

  function FakeRec() {
    this.starts = 0; this.stops = 0; this.lang = null;
    this.continuous = null; this.interimResults = null; this.maxAlternatives = null;
    this.onresult = null; this.onerror = null; this.onend = null;
    const self = this;
    this.start = function () {
      self.starts++;
      if (opts.startThrows) throw new Error('InvalidStateError');
    };
    this.stop = function () { self.stops++; };
    recs.push(this);
  }

  // Enough of WebAudio for the chime, and it records what was played so the
  // "tudu" can be asserted rather than assumed.
  function FakeAudioCtx() {
    const self = this;
    this.state = opts.ctxSuspended ? 'suspended' : 'running';
    this.currentTime = 0;
    this.destination = {};
    this.resumes = 0;
    this.oscs = [];
    this.live = 0;          // connected nodes that were never disconnected
    this.resume = function () { self.resumes++; self.state = 'running'; return Promise.resolve(); };
    this.createOscillator = function () {
      if (opts.oscThrows) throw new Error('no oscillators here');
      const osc = {
        type: null, freq: null, started: null, stopped: null, onended: null,
        frequency: { setValueAtTime(v) { osc.freq = v; } },
        connect() { self.live++; }, disconnect() { self.live--; },
        start(t) { osc.started = t; }, stop(t) { osc.stopped = t; },
      };
      self.oscs.push(osc);
      return osc;
    };
    this.createGain = function () {
      const g = {
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() { self.live++; }, disconnect() { self.live--; },
      };
      return g;
    };
    ctxs.push(this);
  }

  const el = (extra) => Object.assign({
    _text: '', style: { display: '' }, dataset: {}, listeners: [],
    classList: (() => {
      const s = new Set();
      return { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c), toggle: (c, on) => { if (on) s.add(c); else s.delete(c); } };
    })(),
    addEventListener(type, fn) { this.listeners.push({ type, fn }); },
    set textContent(v) { this._text = v == null ? '' : String(v); },
    get textContent() { return this._text; },
  }, extra || {});

  const els = {
    '#voiceBtn': el(), '#voiceHud': el({ style: { display: 'none' } }),
    '#voiceHudState': el(), '#voiceHudHeard': el(), '#voiceHudClose': el(),
  };
  if (opts.noHud) { delete els['#voiceHud']; delete els['#voiceHudState']; delete els['#voiceHudHeard']; }
  if (opts.noBtn) delete els['#voiceBtn'];

  const win = {};
  if (opts.supported !== false) {
    if (opts.webkitOnly) win.webkitSpeechRecognition = FakeRec;
    else win.SpeechRecognition = opts.constructThrows ? function () { throw new Error('nope'); } : FakeRec;
  }
  if (!opts.noAudioCtx) win.AudioContext = FakeAudioCtx;

  // The page-level listeners: visibilitychange, plus the one-shot gesture
  // listeners the chime is primed from.
  const docListeners = [];
  const doc = {
    hidden: !!opts.hidden,
    addEventListener(type, fn, o) { docListeners.push({ type, fn, once: !!(o && o.once), dead: false }); },
  };

  // Device-local settings. `stored` records writes so a sync POST (Storage.set)
  // is distinguishable from a device write (Storage.setLocal).
  const store = Object.assign({}, opts.stored || {});
  if (opts.always) store.voiceAlwaysOn = true;
  const Storage = {
    get(k, d) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : d; },
    set(k, v) { store[k] = v; calls.stored.push('set:' + k + '=' + JSON.stringify(v)); },
    setLocal(k, v) { store[k] = v; calls.stored.push('setLocal:' + k + '=' + JSON.stringify(v)); },
  };

  // navigator.permissions: absent by default, so a plain env never auto-arms.
  const nav = {};
  if (opts.permission) {
    nav.permissions = {
      query(desc) {
        calls.permissionQueries++;
        calls.permissionNames.push(desc && desc.name);
        if (opts.permission === 'throws') throw new Error('TypeError: unknown name');
        if (opts.permission === 'rejects') return Promise.reject(new Error('nope'));
        if (opts.permission === 'nonPromise') return {};
        return Promise.resolve({ state: opts.permission });
      },
    };
  } else if (opts.emptyPermissions) {
    nav.permissions = {};
  }

  const sandbox = {
    console, calls, window: win, document: doc, navigator: nav, Storage,
    $: (sel) => els[sel] || null,
    setTimeout: (fn, ms) => { const t = { id: nextId++, at: now + (ms || 0), fn, cleared: false }; timers.push(t); return t.id; },
    clearTimeout: (id) => { const t = timers.find(x => x.id === id); if (t) t.cleared = true; },
    setInterval: (fn, ms) => { const t = { id: nextId++, at: now + (ms || 1), every: ms || 1, fn, cleared: false }; intervals.push(t); return t.id; },
    clearInterval: (id) => { const t = intervals.find(x => x.id === id); if (t) t.cleared = true; },
  };

  // Stubs as `var` so the extracted code's free variables resolve to them and so
  // the test can read the mutated values back off the sandbox.
  const prelude = `
    var isShuffle = false, currentIndex = -1, currentSong = null;
    var likedSongs = [], searchResults = [];
    var searchInput = { value: '' };
    var searchClear = { classList: { add(c) { calls.log.push('searchClear:' + c); }, remove() {}, contains() { return false; } } };
    var audioPlayer = { src: '', paused: true, pause() { this.paused = true; calls.log.push('audio.pause'); } };
    var SuggestionEngine = { close() { calls.log.push('suggest.close'); }, ${cleanArtistSrc} };
    function toast(m) { calls.toasts.push(m); }
    function playNext() { calls.log.push('playNext'); }
    function playPrev() { calls.log.push('playPrev'); }
    function togglePlayPause() { audioPlayer.paused = !audioPlayer.paused; calls.log.push('togglePlayPause'); }
    function toggleShuffle() { isShuffle = !isShuffle; calls.log.push('toggleShuffle'); }
    function playLikedSongs() { calls.log.push('playLikedSongs'); }
    function startPersonalizedRadio() { calls.log.push('startPersonalizedRadio'); }
    function openAddToPlaylist(s) { calls.addedToPlaylist.push(s); }
    function playAllResults(startSong) { calls.log.push('playAllResults'); calls.played.push(startSong || null); }
    function navigateTo(p) { calls.navigated.push(p); }
    async function doSearch(q) { calls.searches.push(q); searchResults = calls.nextResults; }
  `;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(prelude + '\n' + appCode +
    '\n;globalThis.__x = { VoiceCommands, VoiceAssistant, VoicePick, VoiceChime,' +
    ' VOICE_WAKE, VOICE_WAKE_STRICT, VOICE_WAKE_NAMES, VOICE_WAKE_LEADS, VOICE_MOODS,' +
    ' VOICE_IDLE_MS, VOICE_RESTART_MS, VOICE_MAX_RESTARTS, VOICE_BACKOFF_MS,' +
    ' VOICE_WATCHDOG_MS, VOICE_HUD_MS };', ctx);
  const X = sandbox.__x;
  return {
    X, V: X.VoiceAssistant, C: X.VoiceCommands, P: X.VoicePick,
    calls, clock, els, sandbox, recs, win, ctxs, store, docListeners,
    rec() { return recs[recs.length - 1]; },
    // Null-object rather than undefined: a chime that never fired should fail a
    // check, not crash the suite and skip everything after it.
    audio() { return ctxs[ctxs.length - 1] || { oscs: [], live: 0, resumes: 0, state: 'none' }; },
    oscs() { return ctxs.reduce((n, c) => n + c.oscs.length, 0); },
    hudState: () => els['#voiceHudState'] && els['#voiceHudState'].textContent,
    hudHeard: () => els['#voiceHudHeard'] && els['#voiceHudHeard'].textContent,
    hudVisible: () => els['#voiceHud'] && els['#voiceHud'].style.display !== 'none',
    hudMode: () => els['#voiceHud'] && els['#voiceHud'].dataset.state,
    click(sel) { (els[sel].listeners.filter(l => l.type === 'click')).forEach(l => l.fn()); },
    // Fire a document-level event the way the browser would, honouring {once}.
    fire(type) {
      docListeners.filter(l => l.type === type && !l.dead).forEach((l) => {
        if (l.once) l.dead = true;
        l.fn({ type });
      });
    },
    // Let promise chains (navigator.permissions.query) settle.
    settle() { return new Promise((r) => setImmediate(r)); },
    // Feed a transcript the way the browser does. Resolves after the microtask
    // queue drains, so an async command has finished by the time we assert.
    say(text, isFinal) {
      const ev = { resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: isFinal !== false })] };
      ev.results.length = 1;
      this.rec().onresult(ev);
      return new Promise((r) => setImmediate(r));
    },
  };
}

/* =====================================================================
   1. markup and stylesheet
   ===================================================================== */
section('Voice markup & styles');
const hasId = (id) => new RegExp('id="' + id + '"').test(html);
check('#voiceBtn exists in index.html', hasId('voiceBtn'));
check('#voiceHud exists in index.html', hasId('voiceHud'));
check('#voiceHudState exists in index.html', hasId('voiceHudState'));
check('#voiceHudHeard exists in index.html', hasId('voiceHudHeard'));
check('#voiceHudClose exists in index.html', hasId('voiceHudClose'));

const hudTag = /<div class="voice-hud"[^>]*>/.exec(html);
check('the HUD starts hidden, so it cannot cover the player before any speech',
  !!hudTag && /display:\s*none/.test(hudTag[0]), hudTag && hudTag[0]);
check('the HUD announces itself to screen readers (aria-live)',
  !!hudTag && /aria-live="polite"/.test(hudTag[0]));
check('the HUD is a status region', !!hudTag && /role="status"/.test(hudTag[0]));

const btnTag = /<button class="top-btn voice-btn"[^>]*>/.exec(html);
check('the mic button carries an aria-label', !!btnTag && /aria-label="[^"]+"/.test(btnTag[0]));
check('the mic button names the wake phrase in its tooltip',
  !!btnTag && /Hey My Ruby/i.test(btnTag[0]), btnTag && btnTag[0]);
check('the tooltip says the mic is always listening, so the state is discoverable',
  !!btnTag && /always listening/i.test(btnTag[0]), btnTag && btnTag[0]);
check('the aria-label describes always-on rather than a push-to-talk button',
  !!btnTag && /always/i.test(/aria-label="([^"]+)"/.exec(btnTag[0])[1]), btnTag && btnTag[0]);
// The mic lives in the top bar next to the other .top-btn controls; if that row
// ever gets a phone breakpoint the button goes with it, so pin the location.
const topBar = html.slice(html.indexOf('class="top-bar-actions"'), html.indexOf('</header>'));
check('the mic button is inside .top-bar-actions with the other top buttons',
  topBar.indexOf('id="voiceBtn"') >= 0);

const voiceCssStart = css.indexOf('/* ---------------- Voice assistant');
const afterVoice = css.indexOf('/* ====', voiceCssStart + 10);
const voiceCss = voiceCssStart < 0 ? '' : css.slice(voiceCssStart, afterVoice < 0 ? css.length : afterVoice);
check('the voice rules exist in style.css', voiceCss.length > 200);
check('.voice-btn.active is a real selector (the mic shows it is live)',
  /\.voice-btn\.active\s*(\{|,|::)/.test(voiceCss));
// Always-on needs a third visible state: armed. Without it "listening all day"
// and "switched off" look identical and nobody can tell whether it works.
check('.voice-btn.armed is a real selector (armed has to look different from off)',
  /\.voice-btn\.armed\s*(\{|,|::)/.test(voiceCss));
check('armed and awake are painted differently, not with the same rule',
  /\.voice-btn\.armed\s*\{[^}]+\}/.test(voiceCss) && /\.voice-btn\.active\s*\{[^}]+\}/.test(voiceCss) &&
  /\.voice-btn\.armed\s*\{([^}]+)\}/.exec(voiceCss)[1].trim() !==
  /\.voice-btn\.active\s*\{([^}]+)\}/.exec(voiceCss)[1].trim());
check('the armed dot animates with its own keyframes',
  /animation:\s*voiceBreathe/.test(voiceCss) && /@keyframes voiceBreathe/.test(voiceCss));
// Both classes can be set for a frame while they are swapped, so .active::after
// must reset the dot geometry .armed::after set or the two collide visibly.
const activeAfter = /\.voice-btn\.active::after\s*\{([^}]+)\}/.exec(voiceCss);
check('.active::after resets the armed dot geometry so the two states cannot overlap',
  !!activeAfter && /top:\s*auto/.test(activeAfter[1]) && /width:\s*auto/.test(activeAfter[1]),
  activeAfter && activeAfter[1]);
const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css);
check('every voice animation is switched off under prefers-reduced-motion',
  !!reduced && /\.voice-btn\.armed::after/.test(reduced[1]) &&
  /\.voice-btn\.active::after/.test(reduced[1]) && /voice-hud-orb/.test(reduced[1]));
check('the HUD sits above the now-playing bar rather than under it',
  /\.voice-hud\s*\{[^}]*bottom:\s*calc\(var\(--np-height\)/.test(voiceCss));
// Failure mode: an undefined custom property invalidates the whole declaration,
// silently. Every var() used here must be declared somewhere in the stylesheet.
const usedVars = [...new Set((voiceCss.match(/var\((--[a-z0-9-]+)/g) || []).map(v => v.slice(4)))];
const declared = new Set((css.match(/--[a-z0-9-]+\s*:/g) || []).map(v => v.replace(/\s*:$/, '')));
check('every custom property the voice rules use is declared',
  usedVars.every(v => declared.has(v)), usedVars.filter(v => !declared.has(v)).join(', '));
check('the voice CSS actually uses custom properties (the check above is not vacuous)',
  usedVars.length >= 5, String(usedVars.length));
// Failure mode 4: display:none at a phone breakpoint with no other entry point.
// Voice has exactly one entry point, so a hidden mic is a removed feature.
const mediaBlocks = css.match(/@media[^{]*\{[\s\S]*?\n\}/g) || [];
check('no media query hides the mic button or the HUD',
  !mediaBlocks.some(b => /voice-btn|voiceBtn|voice-hud/.test(b) && /display:\s*none/.test(b)));
check('nothing anywhere sets display:none on .voice-btn',
  !/\.voice-btn[^{]*\{[^}]*display:\s*none/.test(css));

/* =====================================================================
   2. the parser: every command in the spec, and the phrases that must NOT
      be mistaken for one
   ===================================================================== */
section('Command parsing');
const env = makeEnv();
const C = env.C;
const p = (s) => C.parse(s);

const table = [
  // [transcript, expected intent, note]
  ['Hey My Ruby, play Syaara', 'search'],
  ['play Syaara', 'search'],
  ['Play my liked songs', 'liked'],
  ['play something relaxing', 'mood'],
  ['play workout music', 'mood'],
  ['next song', 'next'],
  ['pause', 'pause'],
  ['resume', 'resume'],
  ['shuffle this playlist', 'shuffle'],
  ['play something like this', 'similar'],
  ['add this to my playlist', 'addToPlaylist'],
  // beyond the spec list, but the same phrasings users reach for
  ['skip', 'next'],
  ['skip this song', 'next'],
  ['go to next song', 'next'],
  ['previous song', 'previous'],
  ['go back', 'previous'],
  ['stop the music', 'pause'],
  ['continue playing', 'resume'],
  ['play', 'resume'],
  ['play music', 'resume'],
  ["what's playing", 'nowPlaying'],
  ['what song is this', 'nowPlaying'],
  ['search for arijit singh', 'lookup'],
  ['turn shuffle off', 'shuffleOff'],
  ['play more songs like this', 'similar'],
  ['put on some party music', 'mood'],
  ['play something to help me study', 'search'],
  ['make me a sandwich', 'unknown'],
  ['', 'empty'],
  ['hey my ruby', 'wake'],
];
table.forEach(([said, want]) => {
  const got = p(said).intent;
  check(`"${said || '(silence)'}" -> ${want}`, got === want, got);
});

check('"play Syaara" carries the song as its argument', p('play Syaara').arg === 'syaara', p('play Syaara').arg);
check('punctuation and case do not change the request',
  p('PLAY Syaara!!').arg === 'syaara' && p('play syaara').arg === 'syaara');
check('trailing politeness is stripped', p('next song please').intent === 'next');
check('"play the song called tum hi ho" searches for the title alone',
  p('play the song called tum hi ho').arg === 'tum hi ho', p('play the song called tum hi ho').arg);
check('a very long transcript is capped before it becomes a query',
  p('play ' + 'a'.repeat(400)).arg.length === 120);

// The ordering bug this suite exists for.
check('"play my liked songs" is NOT parsed as a search for "my liked songs"',
  p('play my liked songs').intent === 'liked' && p('play my liked songs').arg === undefined);
check('"play my favourites" reaches the same handler', p('play my favourites').intent === 'liked');
check('"play my favorites" (US spelling) reaches it too', p('play my favorites').intent === 'liked');
check('"shuffle my liked songs" plays the likes and asks for shuffle too',
  p('shuffle my liked songs').intent === 'liked' && p('shuffle my liked songs').shuffle === true);
check('"play my liked songs" alone does not ask for shuffle',
  p('play my liked songs').shuffle === false);

// Mood words must not swallow songs that happen to contain them.
check('"play workout by kanye" is a search, not the workout mood',
  p('play workout by kanye').intent === 'search', p('play workout by kanye').intent);
check('"play feels like this" is a search, not "something like this"',
  p('play feels like this').intent === 'search', p('play feels like this').intent);
check('"play chill" alone still means the mood', p('play chill').intent === 'mood');
check('the relaxing mood becomes a real query, not the word "relaxing"',
  /relax/.test(p('play something relaxing').arg) && p('play something relaxing').arg.split(' ').length >= 2,
  p('play something relaxing').arg);
check('the workout mood has its own query',
  p('play workout music').arg !== p('play something relaxing').arg);
check('every mood entry has a non-empty query and a label',
  // `instanceof RegExp` would be false here: these regexes were built in the vm
  // realm. Duck-type instead.
  env.X.VOICE_MOODS.every(m => m.q && m.q.length > 3 && m.label && typeof m.re.test === 'function' && m.re.source));
check('mood queries are all distinct',
  new Set(env.X.VOICE_MOODS.map(m => m.q)).size === env.X.VOICE_MOODS.length);

// Wake phrase: optional, and stripped rather than searched for.
check('the wake phrase is optional (a bare command works)', p('next song').woke === false);
check('the wake phrase is recognised', p('hey my ruby next song').woke === true);
check('the wake phrase is not left in the query',
  p('hey my ruby play syaara').arg === 'syaara', p('hey my ruby play syaara').arg);
check('"hey ruby" works as well as "hey my ruby"', p('hey ruby, next song').intent === 'next');
check('"ok ruby" works too', p('ok ruby pause').intent === 'pause');
// Longest-match-wins is only *observable* when one wake phrase is a prefix of
// another, which today's list happens to avoid — so asserting it against the
// shipped list passes no matter which phrase the code picks. Create the overlap:
// with first-match-wins, "hey" strips and leaves "my ruby play syaara" behind.
const wakeList = env.X.VOICE_WAKE;
const wakeSnapshot = wakeList.join('|');
wakeList.unshift('hey');
check('the longest wake phrase wins, so a shorter one cannot leak the rest into the command',
  p('hey my ruby play syaara').arg === 'syaara', p('hey my ruby play syaara').arg);
wakeList.shift();
check('the wake list is left exactly as it was for the checks that follow',
  wakeList.join('|') === wakeSnapshot);
check('a wake phrase on its own is a wake, not an unknown command',
  p('hey my ruby').intent === 'wake');
check('every wake phrase in VOICE_WAKE is lowercase and space-normalised',
  env.X.VOICE_WAKE.every(w => w === w.toLowerCase().trim() && !/\s\s/.test(w)));
check('unknown commands keep the text so the user can be told what was heard',
  p('make me a sandwich').text === 'make me a sandwich');
check('null and undefined transcripts do not throw',
  p(null).intent === 'empty' && p(undefined).intent === 'empty');
check('a transcript of pure punctuation is empty, not unknown', p('... !!').intent === 'empty');

/* =====================================================================
   2b. the wake gate: what an always-open mic is allowed to wake on
   ===================================================================== */
section('Wake gate (always-on listening)');
const strict = env.X.VOICE_WAKE_STRICT;
check('the strict list is every lead crossed with every name',
  strict.length === env.X.VOICE_WAKE_LEADS.length * env.X.VOICE_WAKE_NAMES.length,
  String(strict.length));
check('every strict wake phrase is a lead followed by a name (never a bare name)',
  strict.every(w => w.indexOf(' ') > 0 && env.X.VOICE_WAKE_NAMES.indexOf(w.split(' ').pop()) >= 0));
check('no bare name is in the strict list — "ruby" alone must not wake an open mic',
  env.X.VOICE_WAKE_NAMES.every(n => strict.indexOf(n) < 0));
check('the loose list used after a tap still contains the bare names',
  env.X.VOICE_WAKE_NAMES.every(n => env.X.VOICE_WAKE.indexOf(n) >= 0));
check('every strict phrase is also strippable by the parser (parse must not choke on a wake it woke on)',
  strict.every(w => C.parse(w + ' next song').intent === 'next'));

const wakes = (s) => C.wakeStrict(s);
check('"hey ruby" wakes', wakes('hey ruby'));
check('"Hey Ruby," with punctuation and caps wakes', wakes('Hey, Ruby!'));
check('"hey my ruby" wakes', wakes('hey my ruby'));
check('"ok ruby" wakes', wakes('ok ruby'));
check('"hey ruby play syaara" wakes and carries a command in the same breath',
  wakes('hey ruby play syaara'));
// The manglings the recognizer actually produces for the name.
check('"hey rubby" wakes (the recognizer mangles the name)', wakes('hey rubby'));
check('"hey ruuby" wakes (the spelling the user actually reports saying)', wakes('hey ruuby'));
check('"hey rugby" wakes (the most common mishearing of all)', wakes('hey rugby'));
// The false wakes. These are the whole reason the gate exists.
check('the bare name does NOT wake an open mic', !wakes('ruby'));
check('a lyric containing the name does not wake', !wakes('ruby ruby ruby aah'));
check('the name mid-sentence does not wake', !wakes('i think the ruby one is better'));
check('a lead without the name does not wake', !wakes('hey there'));
check('a command without the wake phrase does not wake an armed mic', !wakes('play syaara'));
check('the wake phrase must LEAD, not merely appear',
  !wakes('the song is called hey ruby'));
check('empty and malformed transcripts do not wake',
  !wakes('') && !wakes(null) && !wakes(undefined) && !wakes('...'));
check('a name that merely starts with a wake name does not wake ("hey rubies")',
  !wakes('hey rubies'), 'prefix leaked');

/* =====================================================================
   3. executing commands: the toggles, and the states with nothing loaded
   ===================================================================== */
section('Executing commands');
async function run(said, setup) {
  const e = makeEnv();
  if (setup) setup(e);
  const msg = await e.V.execute(e.C.parse(said));
  return { e, msg, log: e.calls.log };
}

const scenarios = [
  async () => {
    const { log } = await run('next song');
    check('"next song" calls playNext', log.indexOf('playNext') >= 0, log.join(','));
    const prev = await run('previous song');
    check('"previous song" calls playPrev', prev.log.indexOf('playPrev') >= 0, prev.log.join(','));
  },

  async () => {
    // The toggle trap: pause must never resume.
    const { log, msg } = await run('pause', (e) => {
      e.sandbox.audioPlayer.src = 'blob:x'; e.sandbox.audioPlayer.paused = false;
    });
    check('"pause" while playing pauses the audio element', log.indexOf('audio.pause') >= 0, log.join(','));
    check('"pause" does not go through togglePlayPause', log.indexOf('togglePlayPause') < 0);
    check('"pause" reports back', /paus/i.test(msg), msg);

    const again = await run('pause', (e) => { e.sandbox.audioPlayer.src = 'blob:x'; e.sandbox.audioPlayer.paused = true; });
    check('"pause" when already paused does NOT start playback',
      again.log.indexOf('togglePlayPause') < 0 && again.log.indexOf('audio.pause') < 0,
      again.log.join(','));
    check('"pause" when already paused says so', /already/i.test(again.msg), again.msg);
  },

  async () => {
    const { log } = await run('resume', (e) => {
      e.sandbox.audioPlayer.src = 'blob:x'; e.sandbox.audioPlayer.paused = true; e.sandbox.currentIndex = 0;
    });
    check('"resume" with a loaded paused song resumes it', log.indexOf('togglePlayPause') >= 0, log.join(','));

    const playing = await run('resume', (e) => {
      e.sandbox.audioPlayer.src = 'blob:x'; e.sandbox.audioPlayer.paused = false; e.sandbox.currentIndex = 0;
    });
    check('"resume" while already playing does not toggle it off',
      playing.log.indexOf('togglePlayPause') < 0, playing.log.join(','));

    const empty = await run('play music');
    check('"play music" with nothing loaded starts the personalized radio',
      empty.log.indexOf('startPersonalizedRadio') >= 0, empty.log.join(','));
  },

  async () => {
    const on = await run('shuffle this playlist');
    check('"shuffle this playlist" turns shuffle on', on.e.sandbox.isShuffle === true);
    const already = await run('shuffle this playlist', (e) => { e.sandbox.isShuffle = true; });
    check('asking for shuffle when it is already on leaves it on',
      already.e.sandbox.isShuffle === true && already.log.indexOf('toggleShuffle') < 0, already.log.join(','));
    const off = await run('turn shuffle off', (e) => { e.sandbox.isShuffle = true; });
    check('"turn shuffle off" turns it off', off.e.sandbox.isShuffle === false);
    const stayOff = await run('turn shuffle off');
    check('turning shuffle off when it is already off does nothing',
      stayOff.e.sandbox.isShuffle === false && stayOff.log.indexOf('toggleShuffle') < 0);
  },

  async () => {
    const { log, msg } = await run('play my liked songs', (e) => { e.sandbox.likedSongs = [{ id: 'a' }]; });
    check('"play my liked songs" plays them', log.indexOf('playLikedSongs') >= 0, log.join(','));
    const none = await run('play my liked songs');
    check('with no liked songs it explains instead of playing silence',
      none.log.indexOf('playLikedSongs') < 0 && /no liked/i.test(none.msg), none.msg);
    const shuf = await run('shuffle my liked songs', (e) => { e.sandbox.likedSongs = [{ id: 'a' }]; });
    check('"shuffle my liked songs" turns shuffle on and plays them',
      shuf.e.sandbox.isShuffle === true && shuf.log.indexOf('playLikedSongs') >= 0);
    const shufNone = await run('shuffle my liked songs');
    check('with nothing liked, "shuffle my liked songs" does not flip shuffle as a side effect',
      shufNone.e.sandbox.isShuffle === false, shufNone.log.join(','));
  },

  async () => {
    const e = makeEnv();
    e.calls.nextResults = [{ id: 'r1' }, { id: 'r2' }];
    const msg = await e.V.execute(e.C.parse('play syaara'));
    check('"play X" searches for X', e.calls.searches.join(',') === 'syaara', e.calls.searches.join(','));
    check('"play X" shows the search page', e.calls.navigated.indexOf('search') >= 0);
    check('"play X" fills the search box, so the screen matches what was said',
      e.sandbox.searchInput.value === 'syaara');
    check('"play X" closes the suggestions dropdown over the results',
      e.calls.log.indexOf('suggest.close') >= 0);
    check('"play X" plays the results it just fetched', e.calls.log.indexOf('playAllResults') >= 0);
    check('"play X" issues exactly one search request', e.calls.searches.length === 1);
    check('"play X" reports what it is playing', /syaara/i.test(msg), msg);

    const none = makeEnv();
    none.calls.nextResults = [];
    const nmsg = await none.V.execute(none.C.parse('play zzzzz'));
    check('an empty result set does not try to play anything',
      none.calls.log.indexOf('playAllResults') < 0, none.calls.log.join(','));
    check('an empty result set says so', /no results/i.test(nmsg), nmsg);
  },

  async () => {
    const e = makeEnv();
    e.calls.nextResults = [{ id: 'r1' }];
    await e.V.execute(e.C.parse('search for arijit singh'));
    check('"search for X" shows results', e.calls.searches.join(',') === 'arijit singh');
    check('"search for X" does NOT hijack playback', e.calls.log.indexOf('playAllResults') < 0,
      e.calls.log.join(','));
  },

  async () => {
    const e = makeEnv();
    e.calls.nextResults = [{ id: 'r1' }];
    const msg = await e.V.execute(e.C.parse('play something relaxing'));
    check('a mood request searches its curated query, not the spoken words',
      e.calls.searches[0] !== 'something relaxing' && /relax/.test(e.calls.searches[0]), e.calls.searches[0]);
    check('a mood request plays what it found', e.calls.log.indexOf('playAllResults') >= 0);
    check('a mood request names the mood in its reply', /relax/i.test(msg), msg);
  },

  async () => {
    const e = makeEnv();
    e.sandbox.currentSong = { id: 'x', title: 'Syaara', channel: 'T-Series - Topic' };
    e.calls.nextResults = [{ id: 'r1' }];
    await e.V.execute(e.C.parse('play something like this'));
    check('"something like this" seeds the search from the current artist',
      /T-Series/.test(e.calls.searches[0]), e.calls.searches[0]);
    check('the seed runs through cleanArtist, so " - Topic" is not searched for',
      !/Topic/.test(e.calls.searches[0]), e.calls.searches[0]);
    check('"something like this" plays the result', e.calls.log.indexOf('playAllResults') >= 0);

    const nothing = await run('play something like this');
    check('"something like this" with nothing playing explains instead of searching for nothing',
      /nothing is playing/i.test(nothing.msg) && nothing.e.calls.searches.length === 0, nothing.msg);

    // A song with no channel must still produce a usable seed.
    const noArtist = makeEnv();
    noArtist.sandbox.currentSong = { id: 'x', title: 'Syaara', channel: '' };
    noArtist.calls.nextResults = [{ id: 'r1' }];
    await noArtist.V.execute(noArtist.C.parse('play something like this'));
    check('with no artist it falls back to the title', /Syaara/.test(noArtist.calls.searches[0]),
      noArtist.calls.searches[0]);
  },

  async () => {
    const song = { id: 'x', title: 'Syaara' };
    const e = makeEnv();
    e.sandbox.currentSong = song;
    const msg = await e.V.execute(e.C.parse('add this to my playlist'));
    check('"add this to my playlist" opens the picker for the playing song',
      e.calls.addedToPlaylist.length === 1 && e.calls.addedToPlaylist[0].id === 'x');
    check('"add this to my playlist" tells the user to choose', /playlist/i.test(msg), msg);
    const nothing = await run('add this to my playlist');
    check('with nothing playing the picker is not opened',
      nothing.e.calls.addedToPlaylist.length === 0 && /nothing is playing/i.test(nothing.msg), nothing.msg);
  },

  async () => {
    const e = makeEnv();
    e.sandbox.currentSong = { id: 'x', title: 'Syaara' };
    const msg = await e.V.execute(e.C.parse("what's playing"));
    check('"what\'s playing" names the song', /Syaara/.test(msg), msg);
    const nothing = await run("what's playing");
    check('"what\'s playing" with nothing loaded says nothing is playing',
      /nothing is playing/i.test(nothing.msg), nothing.msg);
  },

  async () => {
    const { msg, log } = await run('make me a sandwich');
    check('an unsupported command changes nothing', log.length === 0, log.join(','));
    check('an unsupported command quotes back what was heard',
      /sandwich/.test(msg) && /sorry|cannot/i.test(msg), msg);
  },
];

/* =====================================================================
   4. the recognition lifecycle
   ===================================================================== */
async function lifecycle() {
  section('Recognizer lifecycle');

  // Graceful fallback where the API does not exist.
  const un = makeEnv({ supported: false });
  un.V.init();
  check('with no SpeechRecognition the mic button is hidden outright',
    un.els['#voiceBtn'].style.display === 'none');
  check('with no SpeechRecognition nothing is bound to the button',
    un.els['#voiceBtn'].listeners.length === 0);
  check('an unsupported browser reports supported = false', un.V.supported === false);
  un.V.start();
  check('start() on an unsupported browser is a no-op, not a crash',
    un.V.active === false && un.recs.length === 0);

  const wk = makeEnv({ webkitOnly: true });
  wk.V.init();
  check('webkitSpeechRecognition is accepted (Safari and older Chrome)', wk.V.supported === true);

  const bad = makeEnv({ constructThrows: true });
  bad.V.init();
  check('a constructor that throws is treated as unsupported rather than crashing init',
    bad.V.supported === false && bad.els['#voiceBtn'].style.display === 'none');

  // Duplicate listeners.
  const dup = makeEnv();
  dup.V.init(); dup.V.init(); dup.V.init();
  check('init() called repeatedly binds the mic button exactly once',
    dup.els['#voiceBtn'].listeners.filter(l => l.type === 'click').length === 1,
    String(dup.els['#voiceBtn'].listeners.length));
  check('init() called repeatedly builds exactly one recognizer', dup.recs.length === 1);
  check('the recognizer is configured with interim results for live feedback',
    dup.rec().interimResults === true);
  // Always-on flipped this: one long session, not one per phrase. A session per
  // phrase leaves the mic shut for VOICE_RESTART_MS after every sentence, and a
  // wake word landing in that gap is simply not heard.
  check('the recognizer runs one continuous session so the mic is never deaf between phrases',
    dup.rec().continuous === true);
  check('init() registers exactly one watchdog interval, however many times it is called',
    dup.clock.intervals() === 1, String(dup.clock.intervals()));
  check('init() binds exactly one visibilitychange listener',
    dup.docListeners.filter(l => l.type === 'visibilitychange').length === 1);

  // Start / stop from the button.
  const e = makeEnv();
  e.V.init();
  e.click('#voiceBtn');
  check('tapping the mic starts listening', e.V.active === true && e.rec().starts === 1);
  check('tapping the mic marks the button active', e.els['#voiceBtn'].classList.contains('active'));
  check('tapping the mic shows the HUD', e.hudVisible() === true);
  check('the HUD says it is listening', /listening/i.test(e.hudState()), e.hudState());
  check('the HUD carries a listening state for the stylesheet to animate',
    e.hudMode() === 'listening', e.hudMode());
  check('the HUD suggests the wake phrase before anything is heard',
    /Hey My Ruby/i.test(e.hudHeard()), e.hudHeard());
  e.click('#voiceBtn');
  check('tapping again stops listening', e.V.active === false && e.rec().stops === 1);
  check('stopping clears the active state on the button',
    !e.els['#voiceBtn'].classList.contains('active'));

  const cl = makeEnv();
  cl.V.init(); cl.V.start();
  cl.click('#voiceHudClose');
  check('the HUD close button stops listening', cl.V.active === false);

  // Interim vs final transcripts.
  const iv = makeEnv();
  iv.V.init(); iv.V.start();
  iv.say('play sy', false);
  check('an interim transcript is shown but not acted on',
    /play sy/.test(iv.hudHeard()) && iv.calls.searches.length === 0, iv.hudHeard());
  check('an interim transcript keeps the mic open', iv.V.active === true);

  const fin = makeEnv();
  fin.calls.nextResults = [{ id: 'r1' }];
  fin.V.init(); fin.V.start();
  await fin.say('next song');
  check('a final transcript runs the command', fin.calls.log.indexOf('playNext') >= 0,
    fin.calls.log.join(','));
  check('running a command closes the mic (our own toast is not heard as speech)',
    fin.V.active === false && fin.rec().stops >= 1);
  check('the result is toasted', fin.calls.toasts.some(t => /next song/i.test(t)),
    fin.calls.toasts.join(' | '));
  check('the HUD shows the outcome', /next song/i.test(fin.hudState()), fin.hudState());
  check('the HUD keeps the transcript on screen with the outcome',
    /next song/i.test(fin.hudHeard()), fin.hudHeard());
  fin.clock.advance(env.X.VOICE_HUD_MS + 100);
  check('the HUD hides itself afterwards', fin.hudVisible() === false);
  check('and leaves no timer behind', fin.clock.pending() === 0);

  // Clear listening / processing / finished states, which is all the stylesheet
  // has to go on: it animates off [data-state].
  const working = makeEnv();
  working.V.init(); working.V.start();
  let release = null;
  working.V.execute = () => new Promise((r) => { release = () => r('Done'); });
  const inFlight = working.say('play syaara');
  check('the HUD shows a processing state while a command runs',
    working.hudMode() === 'working' && /working/i.test(working.hudState()),
    `${working.hudMode()} / ${working.hudState()}`);
  check('the processing state shows what was heard', /syaara/i.test(working.hudHeard()), working.hudHeard());
  release(); await inFlight;
  check('the HUD switches to a finished state once the command completes',
    working.hudMode() === 'done', working.hudMode());

  const bad2 = makeEnv();
  bad2.V.init(); bad2.V.start();
  await bad2.say('make me a sandwich');
  check('an unsupported command paints the error state, not the success one',
    bad2.hudMode() === 'error', bad2.hudMode());

  // One pending hide timer at a time, or every outcome leaks a timer.
  const hudLeak = makeEnv();
  hudLeak.V.init(); hudLeak.V.start();
  await hudLeak.say('next song');
  hudLeak.clock.advance(100);
  hudLeak.V.start();
  await hudLeak.say('pause');
  check('a second outcome replaces the pending hide timer instead of stacking another',
    hudLeak.clock.pending() === 1, String(hudLeak.clock.pending()));

  // The hide timer from a finished command must not fire over the *next* one.
  const hudStale = makeEnv();
  hudStale.V.init(); hudStale.V.start();
  await hudStale.say('next song');                    // outcome shown, hide armed
  hudStale.clock.advance(env.X.VOICE_HUD_MS - 300);   // nearly due
  hudStale.V.start();
  hudStale.say('play sy', false);                     // new content on screen
  hudStale.clock.advance(600);                        // the old timer's moment passes
  check('a pending hide is cancelled when the HUD is repainted, so it cannot vanish mid-phrase',
    hudStale.hudVisible() === true && /play sy/.test(hudStale.hudHeard()), hudStale.hudHeard());

  const em = makeEnv();
  em.V.init(); em.V.start();
  await em.say('   ');
  check('an empty final transcript is ignored, not treated as a command',
    em.V.active === true && em.calls.toasts.length === 0);

  // A blank interim result must be dropped before it reaches the HUD, or the
  // hint the user is reading gets replaced by an empty pair of quotes.
  const blank = makeEnv();
  blank.V.init(); blank.V.start();
  blank.say('   ', false);
  check('a blank interim result does not wipe the wake-phrase hint',
    /Hey My Ruby/i.test(blank.hudHeard()), blank.hudHeard());

  const malformed = makeEnv();
  malformed.V.init(); malformed.V.start();
  malformed.rec().onresult({});
  malformed.rec().onresult({ results: [] });
  malformed.rec().onresult({ resultIndex: 0, results: Object.assign([undefined], { length: 1 }) });
  check('a malformed recognition event does not throw', malformed.V.active === true);

  // Bare wake phrase keeps the session open.
  const wake = makeEnv();
  wake.V.init(); wake.V.start();
  await wake.say('hey my ruby');
  check('the bare wake phrase keeps listening instead of running a command',
    wake.V.active === true && wake.calls.toasts.length === 0);
  check('the bare wake phrase prompts for the command', /go ahead/i.test(wake.hudHeard()), wake.hudHeard());

  // Idle auto-stop.
  const idle = makeEnv();
  idle.V.init(); idle.V.start();
  idle.clock.advance(env.X.VOICE_IDLE_MS - 10);
  check('the mic is still open just before the idle timeout', idle.V.active === true);
  idle.clock.advance(20);
  check('silence eventually closes the mic on its own', idle.V.active === false,
    'still listening after ' + env.X.VOICE_IDLE_MS + 'ms');
  check('the idle stop explains itself', /stopped/i.test(idle.hudState()), idle.hudState());
  const idle2 = makeEnv();
  idle2.V.init(); idle2.V.start();
  idle2.clock.advance(env.X.VOICE_IDLE_MS - 100);
  idle2.say('still here', false);
  idle2.clock.advance(200);
  check('speech pushes the idle timeout back', idle2.V.active === true);

  // Restart loop: the budget.
  const rs = makeEnv();
  rs.V.init(); rs.V.start();
  const startsBefore = rs.rec().starts;
  rs.rec().onend();
  check('a session that ends while active does not restart synchronously',
    rs.rec().starts === startsBefore);
  rs.clock.advance(500);
  check('a session that ends while active is restarted', rs.rec().starts === startsBefore + 1);
  for (let i = 0; i < env.X.VOICE_MAX_RESTARTS + 5; i++) { rs.rec().onend(); rs.clock.advance(500); }
  check('restarts are capped, so a recognizer that dies instantly cannot spin',
    rs.rec().starts <= startsBefore + env.X.VOICE_MAX_RESTARTS + 1,
    `${rs.rec().starts} starts for a budget of ${env.X.VOICE_MAX_RESTARTS}`);
  check('once the budget is spent it stops listening rather than looping quietly',
    rs.V.active === false);
  check('and says the mic can be tapped again', /tap/i.test(rs.hudState()), rs.hudState());

  const rsb = makeEnv();
  rsb.V.init(); rsb.V.start();
  for (let i = 0; i < 4; i++) { rsb.rec().onend(); rsb.clock.advance(500); }
  rsb.say('hello', false);
  const heardAt = rsb.rec().starts;
  for (let i = 0; i < env.X.VOICE_MAX_RESTARTS; i++) { rsb.rec().onend(); rsb.clock.advance(500); }
  check('hearing real speech resets the restart budget',
    rsb.rec().starts > heardAt && rsb.V.active === true,
    `${rsb.rec().starts} vs ${heardAt}, active=${rsb.V.active}`);

  // A restart queued before a stop must not reopen the mic. There are two
  // independent guards and each is checked on its own, because either one alone
  // makes the other look unnecessary.
  const race = makeEnv();
  race.V.init(); race.V.start();
  race.rec().onend();                 // schedules a restart
  check('a session ending while listening queues a restart', race.clock.pending() >= 2,
    String(race.clock.pending()));
  race.V.stop();                      // user taps the button in the gap
  check('stopping cancels the queued restart rather than leaving it armed',
    race.clock.pending() === 0, String(race.clock.pending()));
  const before = race.rec().starts;
  race.clock.advance(1000);
  check('a restart queued just before the user stops does not reopen the mic',
    race.rec().starts === before && race.V.active === false,
    `${race.rec().starts} vs ${before}`);

  // Second guard, exercised on its own: drop out of listening without going
  // through closeMic, so the queued timer really does survive. Belt and braces —
  // any future stop path that forgets to cancel must still not reopen the mic.
  // (`active` is derived from `mode`, so mode is the only thing to set.)
  const survivor = makeEnv();
  survivor.V.init(); survivor.V.start();
  survivor.rec().onend();
  const survStarts = survivor.rec().starts;
  survivor.V.mode = 'off';
  survivor.clock.advance(1000);
  check('a surviving restart timer refuses to reopen the mic once we are not active',
    survivor.rec().starts === survStarts, `${survivor.rec().starts} vs ${survStarts}`);
  const activeDesc = Object.getOwnPropertyDescriptor(survivor.V, 'active');
  check('and `active` is derived from mode, so the two can never disagree',
    survivor.V.active === false && !!activeDesc && typeof activeDesc.get === 'function' && !activeDesc.set);

  const ended = makeEnv();
  ended.V.init(); ended.V.start(); ended.V.stop();
  ended.rec().onend();
  check('onend after a deliberate stop does not even arm a restart timer',
    ended.clock.pending() === 0, String(ended.clock.pending()));
  ended.clock.advance(1000);
  check('onend after a deliberate stop does not restart', ended.rec().starts === 1);

  // Permission denied: the one error that must never retry.
  const denied = makeEnv();
  denied.V.init(); denied.V.start();
  denied.rec().onerror({ error: 'not-allowed' });
  check('a denied microphone stops listening', denied.V.active === false);
  check('a denied microphone is disabled for the page', denied.V.disabled === true);
  check('a denied microphone explains what to do', /blocked/i.test(denied.hudState()), denied.hudState());
  check('a denied microphone toasts once', denied.calls.toasts.filter(t => /block/i.test(t)).length === 1,
    denied.calls.toasts.join(' | '));
  const deniedStarts = denied.rec().starts;
  denied.rec().onend();
  denied.clock.advance(2000);
  check('a denied microphone never restarts itself', denied.rec().starts === deniedStarts);
  denied.V.start();
  check('and tapping the mic again after a denial does not reopen the prompt loop',
    denied.V.active === false && denied.rec().starts === deniedStarts);

  const svc = makeEnv();
  svc.V.init(); svc.V.start();
  svc.rec().onerror({ error: 'service-not-allowed' });
  check('a blocked speech service is treated the same way', svc.V.disabled === true);

  const noSpeech = makeEnv();
  noSpeech.V.init(); noSpeech.V.start();
  noSpeech.rec().onerror({ error: 'no-speech' });
  check('a no-speech error is not fatal', noSpeech.V.disabled === false && noSpeech.V.active === true);
  noSpeech.rec().onend();
  noSpeech.clock.advance(500);
  check('after no-speech the mic reopens', noSpeech.rec().starts === 2);

  const net = makeEnv();
  net.V.init(); net.V.start();
  net.rec().onerror({ error: 'network' });
  check('a network error is shown but does not disable voice',
    /connection/i.test(net.hudState()) && net.V.disabled === false, net.hudState());
  const weird = makeEnv();
  weird.V.init(); weird.V.start();
  weird.rec().onerror({});
  check('an error event with no error code does not throw', weird.V.disabled === false);

  // start() throwing (recognizer still winding down).
  const busy = makeEnv({ startThrows: true });
  busy.V.init(); busy.V.start();
  check('a recognizer that refuses to start leaves us not-listening',
    busy.V.active === false && !busy.els['#voiceBtn'].classList.contains('active'));
  check('a recognizer that refuses to start says so', /busy/i.test(busy.hudState()), busy.hudState());
  check('a failed start arms no idle timer', busy.clock.pending() === 1);   // just the HUD auto-hide

  // Missing markup must not throw: the JS is loaded on every page state.
  const noHud = makeEnv({ noHud: true });
  noHud.V.init(); noHud.V.start();
  await noHud.say('next song');
  check('a missing HUD does not stop commands from working',
    noHud.calls.log.indexOf('playNext') >= 0, noHud.calls.log.join(','));
  const noBtn = makeEnv({ noBtn: true });
  noBtn.V.init(); noBtn.V.start(); noBtn.V.stop();
  check('a missing mic button does not throw', noBtn.V.supported === true);

  // A command that throws must not leave the HUD stuck on "Working…".
  const boom = makeEnv();
  boom.V.init(); boom.V.start();
  boom.V.execute = () => { throw new Error('kaboom'); };
  await boom.say('next song');
  check('a command that throws is reported, not swallowed into a stuck HUD',
    /did not work/i.test(boom.hudState()), boom.hudState());
  check('a command that throws still closes the mic', boom.V.active === false);
}

/* =====================================================================
   4b. always-on listening: arming without a tap, and never dying quietly
   ===================================================================== */
async function alwaysOn() {
  section('Always-on listening');
  const { VOICE_IDLE_MS, VOICE_RESTART_MS, VOICE_MAX_RESTARTS, VOICE_BACKOFF_MS, VOICE_WATCHDOG_MS } = env.X;
  check('the slow retry is far slower than the fast one', VOICE_BACKOFF_MS >= VOICE_RESTART_MS * 20,
    `${VOICE_BACKOFF_MS} vs ${VOICE_RESTART_MS}`);
  check('the watchdog is frequent enough to matter and slow enough not to be a busy loop',
    VOICE_WATCHDOG_MS >= 5000 && VOICE_WATCHDOG_MS <= 60000, String(VOICE_WATCHDOG_MS));

  // Arming with no tap at all: the whole point of the feature.
  const armed = makeEnv({ always: true, permission: 'granted' });
  armed.V.init();
  await armed.settle();
  check('a mic that is already granted arms itself on load, with no tap',
    armed.V.mode === 'wake' && armed.rec().starts === 1,
    `${armed.V.mode} / ${armed.rec().starts}`);
  check('it asks about the microphone rather than calling start() to find out',
    armed.calls.permissionQueries === 1 && armed.calls.permissionNames[0] === 'microphone');
  check('the button shows armed, not awake', armed.els['#voiceBtn'].classList.contains('armed') &&
    !armed.els['#voiceBtn'].classList.contains('active'));
  check('arming shows no HUD — that card would be on screen all day', armed.hudVisible() === false);
  check('armed mode has no idle timeout (it is not a session, it is a state)',
    armed.clock.pending() === 0, String(armed.clock.pending()));
  check('arming builds no AudioContext before there is anything to play',
    armed.ctxs.length === 0);

  // Everything that is not the wake phrase must vanish without a trace.
  await armed.say('i think the ruby one is better, play it later');
  check('speech without the wake phrase is dropped in silence',
    armed.calls.searches.length === 0 && armed.calls.log.length === 0 &&
    armed.calls.toasts.length === 0 && armed.hudVisible() === false,
    armed.calls.log.join(','));
  armed.say('anyway as i was saying', false);
  check('interim chatter is not painted either', armed.hudVisible() === false);
  check('and the session stays open through all of it',
    armed.V.mode === 'wake' && armed.rec().stops === 0 && armed.rec().starts === 1);

  // The headline case: one breath, wake plus command.
  const one = makeEnv({ always: true, permission: 'granted' });
  one.calls.nextResults = [{ id: 'k', title: 'Syaara Karaoke', channel: 'Karaoke Hub', views: 900000, duration: 240 },
    { id: 'off', title: 'Syaara (Official Video)', channel: 'T-Series', views: 22000000, duration: 230 }];
  one.V.init();
  await one.settle();
  await one.say('hey ruuby play syaara');
  check('"hey ruuby play syaara" wakes and plays in a single breath',
    one.calls.searches[0] === 'syaara', one.calls.searches.join(','));
  check('the wake chime fired exactly once', one.oscs() === 2, String(one.oscs()));
  check('the song it starts on is the official one, not the first result',
    one.calls.played[0] && one.calls.played[0].id === 'off',
    one.calls.played[0] && one.calls.played[0].id);
  check('the mic never closed, so the next "hey ruby" is not missed',
    one.V.mode === 'wake' && one.rec().stops === 0);
  check('the outcome is still toasted', one.calls.toasts.some(t => /syaara/i.test(t)),
    one.calls.toasts.join(' | '));

  // Wake on an interim result, command in the next final one.
  const two = makeEnv({ always: true, permission: 'granted' });
  two.V.init();
  await two.settle();
  two.say('hey ruby', false);
  check('the wake phrase chimes on the interim result, before the sentence is even finished',
    two.oscs() === 2 && two.V.mode === 'command', `${two.oscs()} / ${two.V.mode}`);
  check('the chime rises, so "it woke" is audible without looking',
    two.audio().oscs[0].freq < two.audio().oscs[1].freq);
  check('the HUD invites the command', /go ahead/i.test(two.hudHeard()), two.hudHeard());
  check('the button switches from armed to awake',
    two.els['#voiceBtn'].classList.contains('active') && !two.els['#voiceBtn'].classList.contains('armed'));
  await two.say('next song');
  check('the command spoken after the wake runs', two.calls.log.indexOf('playNext') >= 0,
    two.calls.log.join(','));
  check('and it does not chime a second time (only waking chimes)', two.oscs() === 2, String(two.oscs()));
  check('after the command we are armed again, not off', two.V.mode === 'wake');

  // Tapping the mic while already armed: start() on an open session throws
  // InvalidStateError, which used to surface as "Mic is busy" at the exact
  // moment everything was working.
  const tap = makeEnv({ always: true, permission: 'granted' });
  tap.V.init();
  await tap.settle();
  tap.V.start();
  check('tapping while armed opens a command window without restarting the recognizer',
    tap.rec().starts === 1 && tap.V.mode === 'command' && /listening/i.test(tap.hudState()),
    `${tap.rec().starts} / ${tap.hudState()}`);
  // Starting an already-started recognizer throws InvalidStateError, so exactly
  // one place is allowed to know whether a session is running.
  tap.V.openMic(); tap.V.arm(); tap.V.check(); tap.V.openMic();
  check('openMic() owns "is a session running" and is idempotent from every caller',
    tap.rec().starts === 1, String(tap.rec().starts));

  // The command window closing must not switch the feature off.
  const idle = makeEnv({ always: true, permission: 'granted' });
  idle.V.init();
  await idle.settle();
  idle.say('hey ruby', false);
  idle.clock.advance(VOICE_IDLE_MS + 10);
  check('a command window that times out falls back to waiting for the wake phrase',
    idle.V.mode === 'wake' && idle.rec().stops === 0, `${idle.V.mode} / ${idle.rec().stops}`);
  check('and says nothing about it', idle.hudVisible() === false);

  const dismiss = makeEnv({ always: true, permission: 'granted' });
  dismiss.V.init();
  await dismiss.settle();
  dismiss.say('hey ruby', false);
  dismiss.click('#voiceHudClose');
  check('dismissing the card returns to armed rather than switching voice off',
    dismiss.V.mode === 'wake' && dismiss.store.voiceAlwaysOn === true);
  check('dismissing the card hides it', dismiss.hudVisible() === false);

  // Switching it off by hand is the one thing that must stick.
  const off = makeEnv({ always: true, permission: 'granted' });
  off.V.init();
  await off.settle();
  off.click('#voiceBtn');
  check('tapping the mic while armed switches always-on off',
    off.V.mode === 'off' && off.rec().stops === 1);
  check('and remembers it, so a reload does not re-arm behind the user\'s back',
    off.store.voiceAlwaysOn === false &&
    off.calls.stored.some(s => s === 'setLocal:voiceAlwaysOn=false'), off.calls.stored.join(' | '));
  check('switching off plays the falling counterpart of the wake chime',
    off.audio().oscs.length === 2 && off.audio().oscs[0].freq > off.audio().oscs[1].freq);
  off.rec().onend();
  off.clock.advance(VOICE_WATCHDOG_MS * 3);
  check('a mic switched off by hand is never reopened, not even by the watchdog',
    off.rec().starts === 1, String(off.rec().starts));

  // Permission states that must NOT open the mic. Calling start() to find out
  // would prompt on every page load, and a refusal disables voice for the page.
  for (const state of ['prompt', 'denied']) {
    const p2 = makeEnv({ always: true, permission: state });
    p2.V.init();
    await p2.settle();
    check(`a microphone in the "${state}" state is not opened on load`,
      p2.V.mode === 'off' && p2.recs[0].starts === 0, `${p2.V.mode} / ${p2.recs[0].starts}`);
  }
  for (const [label, opts] of [
    ['a Permissions API that rejects the microphone name (Firefox)', { always: true, permission: 'throws' }],
    ['a permission lookup that rejects', { always: true, permission: 'rejects' }],
    ['a query that does not return a promise', { always: true, permission: 'nonPromise' }],
    ['no Permissions API at all (Safari)', { always: true }],
    ['a permissions object with no query method', { always: true, emptyPermissions: true }],
  ]) {
    const q = makeEnv(opts);
    q.V.init();
    await q.settle();
    check(`${label} waits for the tap instead of throwing`,
      q.V.supported === true && q.V.mode === 'off' && q.recs[0].starts === 0);
  }
  const never = makeEnv({ permission: 'granted' });
  never.V.init();
  await never.settle();
  check('a user who never switched always-on on is never asked about the microphone',
    never.calls.permissionQueries === 0 && never.V.mode === 'off');

  const junk = makeEnv({ stored: { voiceAlwaysOn: 'yes' }, permission: 'granted' });
  junk.V.init();
  await junk.settle();
  check('a corrupt stored preference is not read as "on"',
    junk.V.always === false && junk.V.mode === 'off');

  // The context is built outside a gesture when we auto-arm, so it is born
  // suspended and the chime would be silent.
  const gp = makeEnv({ always: true, permission: 'granted', ctxSuspended: true });
  gp.V.init();
  await gp.settle();
  check('auto-arming registers a one-shot gesture primer for the audio context',
    gp.docListeners.filter(l => l.type === 'pointerdown' && l.once).length === 1);
  gp.fire('pointerdown');
  check('the first gesture anywhere resumes the audio context so the chime is audible',
    gp.ctxs.length === 1 && gp.audio().resumes === 1);
  gp.fire('pointerdown');
  gp.fire('keydown');
  check('the primer is one-shot and reuses the same context',
    gp.ctxs.length === 1 && gp.audio().resumes === 1, `${gp.ctxs.length} / ${gp.audio().resumes}`);

  // A session that keeps dying must neither spin nor give up for the day.
  const spin = makeEnv({ always: true, permission: 'granted' });
  spin.V.init();
  await spin.settle();
  let hops = 0;
  while (spin.V.sessionOpen && hops < 60) {
    hops++;
    spin.rec().onend();                          // only ever end a session that is open
    spin.clock.advance(VOICE_RESTART_MS + 10);
  }
  check('the fast-restart budget is bounded, so a dying session cannot spin',
    hops === VOICE_MAX_RESTARTS + 1 && spin.rec().starts === VOICE_MAX_RESTARTS + 1,
    `${hops} hops / ${spin.rec().starts} starts`);
  check('but always-on stays armed instead of switching itself off for the day',
    spin.V.mode === 'wake' && spin.els['#voiceBtn'].classList.contains('armed'));
  check('and a slow retry is queued rather than nothing', spin.V.restartTimer !== null);
  check('the paused-for-the-day message is not shown to an always-on user',
    !/paused/i.test(spin.hudState() || ''), spin.hudState());
  const beforeBackoff = spin.rec().starts;
  // A watchdog tick lands inside the backoff window. It must not shortcut it —
  // turning the slow retry into a fast one is how the spin protection gets lost.
  spin.clock.advance(VOICE_WATCHDOG_MS + 10);
  check('a watchdog tick does not shortcut the slow retry',
    spin.rec().starts === beforeBackoff, `${spin.rec().starts} vs ${beforeBackoff}`);
  spin.clock.advance(VOICE_BACKOFF_MS);
  check('the slow retry really does reopen the mic',
    spin.rec().starts === beforeBackoff + 1, `${spin.rec().starts} vs ${beforeBackoff}`);
  check('hearing something resets the budget', (() => {
    spin.V.restarts = 3;
    spin.say('background noise about nothing', false);
    return spin.V.restarts === 0;
  })());

  // A tap-only session still gives up and says so — the opposite policy, and
  // the reason both branches exist.
  const tapOnly = makeEnv();
  tapOnly.V.init(); tapOnly.V.start();
  let hops2 = 0;
  while (tapOnly.V.active && hops2 < 60) {
    hops2++;
    tapOnly.rec().onend();
    tapOnly.clock.advance(VOICE_RESTART_MS + 10);
  }
  check('a tap-started session that keeps dying stops and says how to resume',
    tapOnly.V.mode === 'off' && /tap the mic/i.test(tapOnly.hudState()), tapOnly.hudState());

  // Sessions vanish in background tabs without firing onend.
  const dead = makeEnv({ always: true, permission: 'granted' });
  dead.V.init();
  await dead.settle();
  dead.V.sessionOpen = false;                    // the session died, silently
  dead.clock.advance(VOICE_WATCHDOG_MS + 10);
  check('the watchdog reopens a session that died without telling us',
    dead.rec().starts === 2, String(dead.rec().starts));
  const stillOpen = makeEnv({ always: true, permission: 'granted' });
  stillOpen.V.init();
  await stillOpen.settle();
  stillOpen.clock.advance(VOICE_WATCHDOG_MS * 4);
  check('the watchdog does not restart a session that is already fine',
    stillOpen.rec().starts === 1, String(stillOpen.rec().starts));

  const vis = makeEnv({ always: true, permission: 'granted', hidden: true });
  vis.V.init();
  await vis.settle();
  vis.V.sessionOpen = false;
  vis.fire('visibilitychange');
  check('a tab that is still hidden is left alone', vis.rec().starts === 1);
  vis.sandbox.document.hidden = false;
  vis.fire('visibilitychange');
  check('coming back to the tab reopens a mic that died in the background',
    vis.rec().starts === 2, String(vis.rec().starts));

  // Denial while armed is still terminal, and must not leave a pulsing button.
  const denied2 = makeEnv({ always: true, permission: 'granted' });
  denied2.V.init();
  await denied2.settle();
  denied2.rec().onerror({ error: 'not-allowed' });
  check('a denial while armed disables voice and clears the armed dot',
    denied2.V.disabled === true && denied2.V.mode === 'off' &&
    !denied2.els['#voiceBtn'].classList.contains('armed'));
  denied2.rec().onend();
  denied2.clock.advance(VOICE_WATCHDOG_MS * 3 + VOICE_BACKOFF_MS);
  check('and nothing — watchdog, backoff or onend — reopens it',
    denied2.rec().starts === 1, String(denied2.rec().starts));

  // Transient errors while armed must stay silent: no card while nobody is
  // even talking to us.
  const quiet = makeEnv({ always: true, permission: 'granted' });
  quiet.V.init();
  await quiet.settle();
  quiet.rec().onerror({ error: 'network' });
  quiet.rec().onerror({ error: 'no-speech' });
  check('transient errors while armed are not painted on screen',
    quiet.hudVisible() === false && quiet.V.disabled === false);
}

/* =====================================================================
   4c. the wake chime
   ===================================================================== */
async function wakeChime() {
  section('Wake chime');
  const c = makeEnv();
  const Ch = c.X.VoiceChime;
  Ch.wake();
  const w = c.audio().oscs;
  check('the wake chime is two tones ("tu-du")', w.length === 2, String(w.length));
  check('it rises', w[0].freq < w[1].freq, `${w[0].freq} -> ${w[1].freq}`);
  check('the tones are sequential, not a chord', w[1].started > w[0].started + 0.05,
    `${w[0].started} / ${w[1].started}`);
  check('each tone is short — a chime, not a beep you wait through',
    w.every(o => o.stopped - o.started <= 0.25));
  check('the whole chime is over well inside a second',
    w[1].stopped - w[0].started < 1, String(w[1].stopped - w[0].started));
  check('the gain is ramped rather than switched (a square edge on a sine is a click)',
    /exponentialRampToValueAtTime/.test(chimeSrc));
  Ch.off();
  check('switching off falls, so on and off are distinguishable without looking',
    c.audio().oscs.length === 4 && c.audio().oscs[2].freq > c.audio().oscs[3].freq);
  Ch.wake(); Ch.wake(); Ch.wake();
  check('every chime reuses one AudioContext', c.ctxs.length === 1, String(c.ctxs.length));
  check('a chime is louder when waking than when switching off', (() => {
    const wake = /wake\(\)\s*\{[^}]*play\(\[[^\]]+\],\s*([\d.]+)\)/.exec(chimeSrc);
    const offv = /off\(\)\s*\{[^}]*play\(\[[^\]]+\],\s*([\d.]+)\)/.exec(chimeSrc);
    return !!wake && !!offv && Number(wake[1]) > Number(offv[1]);
  })());
  check('nodes are still connected while they play', c.audio().live > 0);
  c.audio().oscs.forEach((o) => o.onended && o.onended());
  check('nodes disconnect when they finish, so a day of waking up does not grow the graph',
    c.audio().live === 0, String(c.audio().live));
  c.audio().oscs.forEach((o) => o.onended && o.onended());
  check('a second onended does not throw and does not go negative on the graph',
    c.audio().live <= 0);

  // The chime must never be the reason a command fails.
  const broken = makeEnv({ oscThrows: true, always: true, permission: 'granted' });
  broken.V.init();
  await broken.settle();
  await broken.say('hey ruby next song');
  check('a chime that throws does not stop the command',
    broken.calls.log.indexOf('playNext') >= 0, broken.calls.log.join(','));

  const silent = makeEnv({ noAudioCtx: true, always: true, permission: 'granted' });
  silent.V.init();
  await silent.settle();
  await silent.say('hey ruby next song');
  check('a browser with no WebAudio just makes no sound',
    silent.ctxs.length === 0 && silent.calls.log.indexOf('playNext') >= 0);
  check('and it stops trying to build one',
    silent.X.VoiceChime.unavailable === true);

  // The player's own AudioContext is bound to the <audio> element through
  // createMediaElementSource, which can never be re-pointed. The chime having
  // its own context is what keeps it away from the equalizer and the crossfade.
  const chimeNoComments = stripComments(chimeSrc);
  check('the chime owns its own AudioContext and never touches the player',
    !/createMediaElementSource|audioPlayer|EqualizerManager/.test(chimeNoComments));
  check('the chime never writes the player volume (the crossfade owns it)',
    !/\.volume/.test(chimeNoComments));
}

/* =====================================================================
   4d. picking the official version
   ===================================================================== */
async function officialPick() {
  section('Official-version picking');
  const P = env.P;
  let n = 0;
  const song = (o) => Object.assign({ id: 's' + (++n), title: '', channel: '', views: 0, duration: 200 }, o);

  const karaoke = song({ id: 'kar', title: 'Syaara — Karaoke Instrumental Version', channel: 'Karaoke Hub', views: 8000000, duration: 215 });
  const official = song({ id: 'off', title: 'Syaara (Official Video)', channel: 'T-Series', views: 21000000, duration: 232 });
  const cover = song({ id: 'cov', title: 'Syaara cover by me', channel: 'Ananya Sings', views: 400000, duration: 190 });
  check('the official release wins even when a karaoke track is listed first',
    P.best([karaoke, cover, official], 'syaara').id === 'off',
    P.best([karaoke, cover, official], 'syaara').id);
  check('a cover does not win on recency alone',
    P.score(official, 'syaara', 0) > P.score(cover, 'syaara', 0));
  check('a karaoke version is penalised heavily',
    P.score(karaoke, 'syaara', 0) < P.score(official, 'syaara', 5));

  const topic = song({ id: 'top', title: 'Syaara', channel: 'Arijit Singh - Topic', views: 3000000 });
  const random = song({ id: 'rnd', title: 'Syaara (Official Video)', channel: 'MusicLover99', views: 3000000 });
  check('YouTube\'s auto-generated official-audio channel beats a random uploader claiming "official"',
    P.score(topic, 'syaara', 0) > P.score(random, 'syaara', 0));

  const hour = song({ id: 'mix', title: 'Syaara - 1 hour loop', channel: 'T-Series', views: 21000000, duration: 3600 });
  check('an hour-long loop loses to the song itself',
    P.score(official, 'syaara', 3) > P.score(hour, 'syaara', 0));
  const clip = song({ id: 'clip', title: 'Syaara (Official Video)', channel: 'T-Series', views: 21000000, duration: 30 });
  check('a 30-second clip loses to a full-length track',
    P.score(official, 'syaara', 3) > P.score(clip, 'syaara', 0));

  // Those two lose on their titles as well, so duration alone proves nothing
  // yet. Same uploader, same words, far more views — only the length differs.
  const jukebox = song({ id: 'jbx', title: 'Saiyaara (Official Audio) 40 min', channel: 'Fan Uploads', views: 1200000000, duration: 2400 });
  const single = song({ id: 'sgl', title: 'Saiyaara', channel: 'Fan Uploads', views: 1000000, duration: 232 });
  check('a 40-minute upload loses to the 4-minute track despite 1000x the views',
    P.score(single, 'saiyaara', 1) > P.score(jukebox, 'saiyaara', 0),
    `${P.score(single, 'saiyaara', 1)} vs ${P.score(jukebox, 'saiyaara', 0)}`);
  const teaser = song({ id: 'tsr', title: 'Saiyaara', channel: 'Fan Uploads', views: 1000000000, duration: 30 });
  check('a 30-second teaser loses on length alone, nothing else',
    P.score(single, 'saiyaara', 1) > P.score(teaser, 'saiyaara', 0),
    `${P.score(single, 'saiyaara', 1)} vs ${P.score(teaser, 'saiyaara', 0)}`);

  // Same isolation for the title blacklist: identical channel and words, the
  // slowed edit is simply more popular.
  const slowed = song({ id: 'slw', title: 'Saiyaara (Official Video) slowed + reverb', channel: 'RandomFan', views: 1000000000, duration: 230 });
  const plain = song({ id: 'pln', title: 'Saiyaara', channel: 'RandomFan', views: 1000000, duration: 230 });
  check('a slowed-and-reverb edit loses to the plain upload however popular',
    P.score(plain, 'saiyaara', 1) > P.score(slowed, 'saiyaara', 0),
    `${P.score(plain, 'saiyaara', 1)} vs ${P.score(slowed, 'saiyaara', 0)}`);

  // And for the label bonus: the fan upload has "Official Video" in the title
  // and a thousand times the views; only the channel tells them apart.
  const label = song({ id: 'lbl', title: 'Saiyaara', channel: 'T-Series', views: 100000, duration: 230 });
  const fan = song({ id: 'fan', title: 'Saiyaara (Official Video) HD 1080p', channel: 'RandomFan', views: 1000000000, duration: 230 });
  check('the record label beats a fan upload that only claims to be official',
    P.score(label, 'saiyaara', 0) > P.score(fan, 'saiyaara', 1),
    `${P.score(label, 'saiyaara', 0)} vs ${P.score(fan, 'saiyaara', 1)}`);

  // The words the user actually said: A has "official" in the title, B simply
  // contains everything that was asked for.
  const halfMatch = song({ id: 'hlf', title: 'Saiyaara (Official Video)', channel: 'Random Uploader', duration: 200 });
  const fullMatch = song({ id: 'ful', title: 'Saiyaara Song Full', channel: 'Random Uploader', duration: 200 });
  check('a result missing one spoken word loses to one that has them all',
    P.score(fullMatch, 'saiyaara song', 1) > P.score(halfMatch, 'saiyaara song', 0),
    `${P.score(fullMatch, 'saiyaara song', 1)} vs ${P.score(halfMatch, 'saiyaara song', 0)}`);

  // The failure this scorer exists to avoid: a hugely popular track that shares
  // half the requested title out-ranking the song actually asked for.
  const asked = song({ id: 'ask', title: 'Kesariya (Official Video)', channel: 'Sony Music India', views: 900000 });
  const famous = song({ id: 'fam', title: 'Deva Deva (Official Video)', channel: 'Sony Music India', views: 400000000 });
  check('a result missing the words that were asked for loses to one that has them, however popular',
    P.score(asked, 'kesariya', 0) > P.score(famous, 'kesariya', 1),
    `${P.score(asked, 'kesariya', 0)} vs ${P.score(famous, 'kesariya', 1)}`);
  check('and among equals, more views is better',
    P.score(song({ id: 'v1', title: 'Kesariya', views: 5000000 }), 'kesariya', 0) >
    P.score(song({ id: 'v2', title: 'Kesariya', views: 5000 }), 'kesariya', 0));
  check('views cannot outweigh the whole score on their own (log, not linear)',
    P.score(song({ id: 'v3', title: 'Kesariya', views: 1e12 }), 'kesariya', 0) <
    P.score(song({ id: 'v4', title: 'Kesariya (Official Video)', channel: 'T-Series', views: 1e6 }), 'kesariya', 0));

  const t1 = song({ id: 't1', title: 'Same Song' });
  const t2 = song({ id: 't2', title: 'Same Song' });
  check('identical candidates keep YouTube\'s own order',
    P.best([t1, t2], 'same song').id === 't1');
  const nudgeA = song({ id: 'n1', title: 'Saiyaara', channel: 'X', views: 1000000, duration: 230 });
  const nudgeB = song({ id: 'n2', title: 'Saiyaara', channel: 'X', views: 1050000, duration: 230 });
  check('a rounding-error view advantage does not overturn YouTube\'s ranking',
    P.best([nudgeA, nudgeB], 'saiyaara').id === 'n1',
    `${P.score(nudgeA, 'saiyaara', 0)} vs ${P.score(nudgeB, 'saiyaara', 1)}`);
  check('the tie-break is a nudge, not a ranking of its own',
    P.score(official, 'syaara', 14) > P.score(karaoke, 'syaara', 0));

  // Malformed and empty data: the search endpoint is not always kind.
  check('an empty list yields nothing rather than throwing', P.best([], 'x') === null);
  const safeBest = (arg) => { try { return P.best(arg, 'x'); } catch (err) { return 'threw: ' + err.message; } };
  check('a non-array yields nothing instead of throwing',
    safeBest(null) === null && safeBest(undefined) === null && safeBest('syaara') === null,
    `${safeBest(null)} / ${safeBest(undefined)} / ${safeBest('syaara')}`);
  check('an item with no id is never picked',
    P.best([{ title: 'no id at all' }, song({ id: 'ok', title: 'Kesariya' })], 'kesariya').id === 'ok');
  // An unplayable item can look perfect on paper, so the id check has to come
  // before the scoring, not after it.
  const noId = { title: 'Saiyaara (Official Video)', channel: 'T-Series', views: 500000000, duration: 230 };
  check('and not even when it would otherwise be the best match by far',
    P.best([noId, song({ id: 'ok2', title: 'Saiyaara', channel: 'X', views: 1000, duration: 230 })], 'saiyaara').id === 'ok2',
    String(P.best([noId, song({ id: 'ok3', title: 'Saiyaara', channel: 'X', views: 1000, duration: 230 })], 'saiyaara').id));
  check('a list of nothing but malformed items still returns something to play',
    P.best([{}, {}], 'x') !== null);
  check('missing query and fields do not throw',
    Number.isFinite(P.score(song({ id: 'a' }), undefined, 0)) &&
    Number.isFinite(P.score({ id: 'b' }, 'x', 0)));
  check('a string in a numeric field does not poison the score',
    Number.isFinite(P.score(song({ id: 'c', views: 'lots', duration: 'ages' }), 'x', 0)));
  check('a one-letter query is ignored rather than matching everything',
    P.best([song({ id: 'q1', title: 'B side' }), song({ id: 'q2', title: 'A side' })], 'a').id === 'q1');

  // End to end: a spoken request starts on the picked song.
  const play = makeEnv();
  play.calls.nextResults = [karaoke, cover, official];
  play.V.init(); play.V.start();
  await play.say('play syaara');
  check('a spoken request starts on the official version',
    play.calls.played[0] && play.calls.played[0].id === 'off',
    play.calls.played[0] && play.calls.played[0].id);
  check('picking costs no extra request', play.calls.searches.length === 1);
  const none = makeEnv();
  none.calls.nextResults = [];
  none.V.init(); none.V.start();
  await none.say('play something that does not exist');
  check('an empty result set is reported rather than played',
    none.calls.played.length === 0 && /no results/i.test(none.hudState()), none.hudState());

  // The real playAllResults, not a stub: the queue must stay in display order
  // whichever song we start on, or Next plays something unrelated.
  const palSrc = extract(/\n  function playAllResults\(/);
  const palBox = vm.createContext({ console });
  vm.runInContext(`
    var searchResults = [], queue = [], currentIndex = 0, played = null, toasted = null;
    function updateQueueUI() {}
    function playSong(s) { played = s; }
    function toast(m) { toasted = m; }
    ${palSrc}
    searchResults = [{ id: '1' }, { id: '2' }, { id: '3' }];
  `, palBox);
  const pal = (arg) => vm.runInContext(`played = null; playAllResults(${arg});`, palBox);
  pal('searchResults[2]');
  check('the real playAllResults starts on the song voice picked',
    palBox.played && palBox.played.id === '3', palBox.played && palBox.played.id);
  check('and still queues every result in display order',
    palBox.queue.map(s => s.id).join(',') === '1,2,3', palBox.queue.map(s => s.id).join(','));
  pal('');
  check('a plain Play All still starts at the top', palBox.played.id === '1');
  pal('{ id: "999" }');
  check('a song that is not in the list falls back to the top instead of playing nothing',
    palBox.played.id === '1');
  pal('{ type: "click", target: {} }');
  check('an event object handed in by a click listener is ignored',
    palBox.played.id === '1');
  check('the Play All button is bound so a click can never arrive as a start song',
    /playAllBtn\?\.addEventListener\('click', \(\) => playAllResults\(\)\)/.test(src));
  vm.runInContext('searchResults = []; played = null; playAllResults({ id: "1" });', palBox);
  check('an empty result list plays nothing at all', palBox.played === null);
}

/* =====================================================================
   5. it must not interfere with the rest of the app
   ===================================================================== */
function nonInterference() {
  section('No interference with search or the player');
  // The chime is primed from a pointerdown/keydown so the AudioContext is born
  // inside a gesture, but those listeners are one-shot primers — they must not
  // read the key or do anything a shortcut would.
  const gestureBind = /addEventListener\('(?:pointerdown|keydown)'/g;
  check('the only keyboard listener voice binds is the one-shot chime primer',
    (voiceNoComments.match(/keydown|keyup|keypress/g) || []).length === 1 &&
    gestureBind.test(voiceNoComments));
  check('that primer reads nothing off the event, so it cannot swallow a keystroke',
    !/keydown'[^)]*\(e\)|\.key\b|keyCode/.test(voiceNoComments));
  check('the voice code does not touch audioPlayer.volume or currentTime',
    !/audioPlayer\.(volume|currentTime)/.test(voiceNoComments));
  check('the voice code never calls playSong directly (it goes through the existing entry points)',
    !/\bplaySong\(/.test(voiceNoComments));
  check('the voice code never writes to the queue directly',
    !/\bqueue\s*=/.test(voiceNoComments) && !/queue\.push/.test(voiceNoComments));
  check('the transcript reaches the DOM via textContent, never innerHTML',
    !/\.innerHTML/.test(voiceNoComments) && /textContent/.test(voiceNoComments));
  // The always-on preference has to survive a reload, but microphone permission
  // is per-browser: syncing it to the server would push a device setting onto
  // every other device the user opens the app on (and cost a POST per toggle).
  check('the always-on preference is stored device-local, never synced',
    !/Storage\.set\(/.test(voiceNoComments) && /Storage\.setLocal\(/.test(voiceNoComments));
  check('and it is read back on start-up so the mic re-arms itself after a reload',
    /Storage\.get\('voiceAlwaysOn'/.test(voiceNoComments));
  check('the keyboard shortcut handler was left alone (no voice case added)',
    !/voice/i.test(extract(/\n  function onKeyboard\s*\(/)));

  // The mic must not steal the search box while the user is typing.
  const e = makeEnv();
  e.V.init();
  e.sandbox.searchInput.value = 'half typed query';
  e.V.start();
  check('opening the mic does not clear what the user was typing',
    e.sandbox.searchInput.value === 'half typed query');
  check('opening the mic does not navigate anywhere', e.calls.navigated.length === 0);
  check('opening the mic issues no search request', e.calls.searches.length === 0);
  check('opening the mic does not touch playback', e.calls.log.length === 0, e.calls.log.join(','));

  check('VoiceAssistant.init() is wired into app start-up',
    /\n\s*VoiceAssistant\.init\(\);/.test(src));
  check('init() runs voice after the search suggestions are bound',
    src.indexOf('SuggestionEngine.init();') < src.indexOf('VoiceAssistant.init();'));
}

/* ---------- run ------------------------------------------------------- */
(async () => {
  for (const s of scenarios) await s();
  await lifecycle();
  await alwaysOn();
  await wakeChime();
  await officialPick();
  nonInterference();

  console.log(`\n${failures === 0 ? 'ALL VOICE CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('\nharness error:', err);
  process.exit(1);
});
