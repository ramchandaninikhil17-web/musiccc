#!/usr/bin/env node
'use strict';

/*
 * Audio output routing (Settings → Output & Routing).
 *
 * Runs the REAL OutputDeviceManager and the REAL EqualizerManager out of
 * public/js/app.js against a fake AudioContext that records every node and
 * every connect(), a fake navigator.mediaDevices, a fake <audio> element and
 * hand-fired timers.
 *
 * The bug this feature exists for is silent by construction: EqualizerManager
 * connects the graph to audioCtx.destination, so the moment any EQ knob is
 * touched the <audio> element stops deciding where sound goes. A context binds
 * to whichever output was default when it was constructed, so Bluetooth
 * headphones connected afterwards get nothing — with no error anywhere. Every
 * check below maps to a way that can silently come back:
 *
 *   - the output stage not actually sitting between the widener and the
 *     speakers, so balance and mono are wired up but inaudible;
 *   - splitter channels crossed, which swaps L and R and sounds "fine";
 *   - a saved balance never pushed into a freshly built graph, so the slider
 *     claims a setting the audio is not using;
 *   - resolveDesired() returning '' instead of null for a disconnected device,
 *     which silently converts "my headphones unplugged" into "speakers forever";
 *   - the first enumerateDevices() treating every existing device as newly
 *     arrived, which would hijack output on page load;
 *   - a sink id written to Storage.set instead of setLocal, syncing a
 *     per-browser salted id to every other device on the account;
 *   - repair() seeking the element, which the transcode branch of /api/stream
 *     cannot serve (Accept-Ranges: none);
 *   - a leaked probe/test-tone AudioContext, which costs a real hardware voice.
 *
 * Run: node test/output-device.test.js
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
const near = (a, b, eps) => Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps);

/* ---------- pull the real code out of app.js -------------------------- */
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

const code = [
  extract(/\n  function esc\s*\(/),
  extract(/\n  const EqualizerManager = \{/),
  extract(/\n  const OutputDeviceManager = \{/),
].join('\n\n');
console.log(`Extracted EqualizerManager + OutputDeviceManager + esc (${code.split('\n').length} lines) from app.js`);

/* ---------- fake AudioContext ----------------------------------------- */
// Records nodes and connections so the graph's *shape* can be asserted, not
// just its behaviour. A wiring mistake here is inaudible in any other test.
function makeParam(v) {
  return {
    value: v,
    _writes: [],
    setValueAtTime(t) { this.value = t; this._writes.push(['setValueAtTime', t]); return this; },
    setTargetAtTime(t, when, tc) { this.value = t; this._writes.push(['setTargetAtTime', t, when, tc]); return this; },
    exponentialRampToValueAtTime(t, when) { this._writes.push(['exp', t, when]); return this; },
    linearRampToValueAtTime(t, when) { this._writes.push(['lin', t, when]); return this; },
  };
}

let ctxSerial = 0;
function makeFakeCtx(opts) {
  opts = opts || {};
  const conns = [];
  const nodes = [];
  let idc = 1;
  function mk(type, extra) {
    const n = Object.assign({
      __id: type + (idc++),
      __type: type,
      connect(dest, out, inp) { conns.push({ from: n, to: dest, out, in: inp }); return dest; },
      disconnect() {},
    }, extra || {});
    nodes.push(n);
    return n;
  }
  const ctx = {
    __serial: ++ctxSerial,
    __conns: conns,
    __nodes: nodes,
    __closed: false,
    __sinkCalls: [],
    state: opts.state || 'running',
    sampleRate: opts.sampleRate || 48000,
    currentTime: 5,
    createMediaElementSource(el) {
      if (opts.sourceThrows) throw new Error('cross-origin media');
      this.__sourceArg = el;
      return mk('source');
    },
    createBiquadFilter() { return mk('biquad', { type: '', frequency: makeParam(0), gain: makeParam(0), Q: makeParam(1) }); },
    createGain() { return mk('gain', { gain: makeParam(1) }); },
    createChannelSplitter() { return mk('splitter'); },
    createChannelMerger() { return mk('merger'); },
    createOscillator() { return mk('osc', { type: 'sine', frequency: makeParam(0), start() { this.__started = true; }, stop() { this.__stopped = true; } }); },
    resume() { ctx.state = 'running'; ctx.__resumed = true; return Promise.resolve(); },
    close() { ctx.__closed = true; return Promise.resolve(); },
  };
  ctx.destination = mk('destination');
  if (opts.ctxSink !== false) {
    ctx.setSinkId = (id) => {
      ctx.__sinkCalls.push(id);
      if (opts.ctxSinkFails) return Promise.reject(new Error('ctx sink refused'));
      ctx.__sink = id;
      return Promise.resolve();
    };
  }
  return ctx;
}

// The constructor shape matters: canSinkContext() probes
// AudioContext.prototype.setSinkId, exactly as feature detection must.
function makeCtxClass(opts) {
  opts = opts || {};
  const made = [];
  function C() {
    const c = makeFakeCtx(opts);
    made.push(c);
    return c;
  }
  if (opts.ctxSink !== false) C.prototype.setSinkId = function () { return Promise.resolve(); };
  C.__made = made;
  return C;
}

/* ---------- fake timers ---------------------------------------------- */
let timerId = 1;
let timers = new Map();
const fakeSetTimeout = (fn, ms) => { const id = timerId++; timers.set(id, { fn, ms }); return id; };
const fakeClearTimeout = (id) => { timers.delete(id); };
function runTimers(max = 50) {
  let n = 0;
  while (timers.size && n++ < max) {
    const [id, t] = timers.entries().next().value;
    timers.delete(id);
    t.fn();
  }
  return n;
}

/* ---------- DOM stubs ------------------------------------------------- */
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function unescapeHtml(s) {
  return String(s)
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
// esc() in app.js goes through a real element's textContent -> innerHTML, so the
// stub has to reproduce that, or an escaping bug would be invisible here.
const document = {
  createElement() {
    let text = '';
    return {
      set textContent(v) { text = v; },
      get textContent() { return text; },
      get innerHTML() { return escapeHtml(text); },
    };
  },
};

function el(extra) {
  return Object.assign({
    textContent: '',
    innerHTML: '',
    value: '',
    checked: false,
    disabled: false,
    style: {},
    _classes: new Set(),
    classList: {
      _o: null,
      add(...c) { c.forEach(x => this._o._classes.add(x)); },
      remove(...c) { c.forEach(x => this._o._classes.delete(x)); },
      contains(c) { return this._o._classes.has(c); },
      toggle(c, on) { if (on) this.add(c); else this.remove(c); },
    },
    _l: {},
    addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); },
    fire(t, ev) { (this._l[t] || []).forEach(fn => fn(ev || { target: this })); },
  }, extra || {});
}

let els = {};
function freshEls() {
  els = {};
  [
    '#outputModal', '#outputStatus', '#outputDeviceList', '#outputAutoFollow',
    '#outputBalance', '#outputBalanceVal', '#outputMono', '#outputMonoHint',
    '#outputEqBypass', '#outputDiag', '#outputRepairBtn', '#outputRefreshBtn',
    '#outputLabelsBtn', '#outputTestBtn', '#outputCloseBtn', '#outputDoneBtn',
    '#outputBalanceResetBtn', '#settingOutputBtn', '#settingsModal',
    '#eqModal', '#eqBtn', '#eqCloseBtn', '#eqDoneBtn', '#eqResetBtn',
    '#spatialAudioToggle', '#bassBoostRange', '#bassBoostVal',
  ].forEach(k => { els[k] = el(); els[k].classList._o = els[k]; });
  els['#bassBoostRange'].value = '0';
  els['#outputBalance'].value = '0';
  return els;
}

// Parses the manager's OWN rendered innerHTML back into row stubs, so clicks go
// through the real markup round trip rather than a hand-built copy of it.
// Memoized per innerHTML: render() binds its handlers to whatever $$ returns, so
// the test has to be handed the same objects or every click lands on a throwaway.
let rowCache = { html: null, rows: [] };
function parseRows() {
  const html = els['#outputDeviceList'].innerHTML || '';
  if (rowCache.html === html) return rowCache.rows;
  const rows = [];
  const re = /<button[^>]*class="(out-device[^"]*)"[^>]*data-device-id="([^"]*)"[^>]*data-device-label="([^"]*)"[^>]*>([\s\S]*?)<\/button>/g;
  let m;
  while ((m = re.exec(html))) {
    const node = el({
      dataset: { deviceId: unescapeHtml(m[2]), deviceLabel: unescapeHtml(m[3]) },
      _inner: m[4],
      _cls: m[1],
    });
    node.classList._o = node;
    m[1].split(/\s+/).forEach(c => node._classes.add(c));
    rows.push(node);
  }
  rowCache = { html, rows };
  return rows;
}

/* ---------- sandbox --------------------------------------------------- */
const toasts = [];
const syncedKeys = [];   // keys written via Storage.set  (server-synced)
const localKeys = [];    // keys written via Storage.setLocal (device-only)
let store = {};

const audioPlayer = el({
  volume: 0.8, muted: false, paused: false, ended: false,
  duration: 200, currentTime: 42,
  src: 'http://localhost:3000/api/stream?id=x',
  currentSrc: 'http://localhost:3000/api/stream?id=x',
  __sinkCalls: [],
  __plays: 0, __pauses: 0,
  play() { this.__plays++; this.paused = false; return Promise.resolve(); },
  pause() { this.__pauses++; this.paused = true; },
});

let devices = [];
let enumerateThrows = false;
let gumBehaviour = 'ok';
const gumStops = [];
let mediaDevices = null;

function makeMediaDevices(opts) {
  opts = opts || {};
  const md = {
    _l: {},
    __ondevicechange: null,
    enumerateDevices() {
      if (enumerateThrows) return Promise.reject(new Error('enumerate blew up'));
      return Promise.resolve(devices.slice());
    },
  };
  if (opts.addEventListener !== false) {
    md.addEventListener = (t, fn) => { (md._l[t] = md._l[t] || []).push(fn); };
  }
  if (opts.gum !== false) {
    md.getUserMedia = () => {
      if (gumBehaviour === 'deny') return Promise.reject(new Error('Permission denied'));
      return Promise.resolve({ getTracks: () => [{ stop() { gumStops.push(1); } }] });
    };
  }
  return md;
}
const fireDeviceChange = () => {
  if (!mediaDevices) return;
  (mediaDevices._l.devicechange || []).forEach(fn => fn());
  if (mediaDevices.ondevicechange) mediaDevices.ondevicechange();
};

const restoreCalls = [];
const sandbox = {
  console,
  document,
  Promise,
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  audioPlayer,
  toast: (m) => { toasts.push(String(m)); },
  Storage: {
    get: (k, d) => (k in store ? store[k] : d),
    set: (k, v) => { store[k] = v; syncedKeys.push(k); },
    setLocal: (k, v) => { store[k] = v; localKeys.push(k); },
  },
  $: (sel) => els[sel] || null,
  $$: (sel) => {
    if (sel === '#outputDeviceList .out-device') return parseRows();
    if (sel === '.eq-preset-btn') return [];
    if (sel === '.eq-slider') return [];
    return [];
  },
  CrossfadeManager: { restoreIfLowered() { restoreCalls.push(1); } },
  window: {},
  navigator: {},
};
sandbox.globalThis = sandbox;

const vmCtx = vm.createContext(sandbox);
try {
  vm.runInContext(code + '\n;globalThis.__x = { EqualizerManager, OutputDeviceManager };', vmCtx);
} catch (err) {
  console.error('Extracted code failed to evaluate:', err.message);
  process.exit(1);
}
const EQ = vmCtx.__x.EqualizerManager;
const OD = vmCtx.__x.OutputDeviceManager;

section('Extraction');
check('both managers evaluate', typeof EQ === 'object' && typeof OD === 'object');
check('OutputDeviceManager exposes the routing surface',
  typeof OD.resolveDesired === 'function' && typeof OD.pushSink === 'function' &&
  typeof OD.apply === 'function' && typeof OD.repair === 'function');
check('EqualizerManager exposes the output stage',
  typeof EQ.channelMatrix === 'function' && typeof EQ.buildOutputStage === 'function' &&
  typeof EQ.setChannelMatrix === 'function');

section('Every AudioContext in the app is handed over for routing');
// A static read, because these contexts belong to managers this suite does not
// evaluate. An unregistered context is the original bug in miniature: its audio
// keeps going to whatever was default when it was constructed.
const ctxConstructions = [...src.matchAll(/new\s+AudioCtx\(\)|new\s+Ctx\(\)/g)].length;
check(`the app constructs ${ctxConstructions} AudioContexts, all accounted for below`, ctxConstructions >= 3);
const ambientAt = src.indexOf('toggleAmbientSound(soundType, chipEl)');
const ambientSrc = ambientAt < 0 ? '' : src.slice(ambientAt, ambientAt + 900);
check('the Pomodoro ambient context is registered for routing',
  /registerContext\(this\.audioCtx, 'ambient'\)/.test(ambientSrc));
check('the equalizer context is registered for routing',
  /registerContext\(this\.audioCtx, 'equalizer'\)/.test(src));
// The two short-lived ones deliberately opt out: they are torn down within a
// second and route themselves at construction time instead.
check('the sample-rate probe closes itself rather than registering',
  /probe\.close\(\)/.test(src) && !/registerContext\(probe/.test(src));
check('the test tone closes itself rather than registering',
  /dying\.close\(\)/.test(src) && !/registerContext\(ctx, 'tone'/.test(src));

/* ---------- reset ----------------------------------------------------- */
function reset(opts) {
  opts = opts || {};
  freshEls();
  rowCache = { html: null, rows: [] };
  timers = new Map();
  toasts.length = 0;
  syncedKeys.length = 0;
  localKeys.length = 0;
  gumStops.length = 0;
  restoreCalls.length = 0;
  store = {};
  devices = [];
  enumerateThrows = false;
  gumBehaviour = 'ok';

  audioPlayer.volume = 0.8; audioPlayer.muted = false; audioPlayer.paused = false;
  audioPlayer.currentTime = 42; audioPlayer.__plays = 0; audioPlayer.__pauses = 0;
  audioPlayer.__sinkCalls.length = 0;
  if (opts.elementSink === false) delete audioPlayer.setSinkId;
  else audioPlayer.setSinkId = (id) => {
    audioPlayer.__sinkCalls.push(id);
    if (opts.elementSinkFails) return Promise.reject(new Error('element sink refused'));
    audioPlayer.__sink = id;
    return Promise.resolve();
  };

  const C = makeCtxClass(opts);
  sandbox.window.AudioContext = opts.noAudioCtx ? undefined : C;
  sandbox.window.webkitAudioContext = undefined;
  sandbox.navigator.mediaDevices = opts.noMediaDevices ? undefined : (mediaDevices = makeMediaDevices(opts));
  if (opts.noMediaDevices) mediaDevices = null;

  EQ.audioCtx = null; EQ.sourceNode = null; EQ.filters = []; EQ.bassNode = null;
  EQ.widener = null; EQ.outStage = null; EQ.unavailable = false; EQ.bypassed = false;
  EQ.modal = els['#eqModal']; EQ.activePreset = null;

  OD.devices = []; OD.desiredId = ''; OD.desiredLabel = ''; OD.activeId = null;
  OD.contexts = []; OD.autoFollow = true; OD.balance = 0; OD.mono = false;
  OD.knownIds = null; OD.labelsVisible = false; OD.lastError = '';
  OD._debounce = null; OD._seeded = false;

  return C;
}

const dev = (id, label) => ({ kind: 'audiooutput', deviceId: id, label, groupId: 'g' + id });

/* ================================================================
   1. CHANNEL MATRIX MATH
   ================================================================ */
section('Balance / mono matrix — centre is an exact unity passthrough');
reset();
let m = EQ.channelMatrix(0, false);
check('centre stereo L->L is exactly 1', m.aLL === 1, m.aLL);
check('centre stereo R->R is exactly 1', m.aRR === 1, m.aRR);
check('centre stereo has no L->R bleed', m.aLR === 0, m.aLR);
check('centre stereo has no R->L bleed', m.aRL === 0, m.aRL);

section('Balance attenuates the far channel and never boosts the near one');
m = EQ.channelMatrix(1, false);
check('hard right silences the left channel', m.aRR === 1 && m.aLL === 0, JSON.stringify(m));
m = EQ.channelMatrix(-1, false);
check('hard left silences the right channel', m.aLL === 1 && m.aRR === 0, JSON.stringify(m));
m = EQ.channelMatrix(0.5, false);
check('half right attenuates left to 0.5, leaves right at 1', near(m.aLL, 0.5) && m.aRR === 1, JSON.stringify(m));
m = EQ.channelMatrix(-0.25, false);
check('quarter left attenuates right to 0.75', near(m.aRR, 0.75) && m.aLL === 1, JSON.stringify(m));

let maxGain = 0;
let sweepRows = 0;
for (let b = -1; b <= 1.0001; b += 0.05) {
  [false, true].forEach(mono => {
    const g = EQ.channelMatrix(b, mono);
    sweepRows++;
    ['aLL', 'aLR', 'aRL', 'aRR'].forEach(k => { maxGain = Math.max(maxGain, g[k]); });
  });
}
check(`no gain in a ${sweepRows}-point sweep exceeds unity (clip safety)`, maxGain <= 1 + 1e-9, maxGain);

section('Mono downmix halves before summing, or correlated content clips +6 dB');
m = EQ.channelMatrix(0, true);
check('mono centre sends half of each input to each ear',
  near(m.aLL, 0.5) && near(m.aRL, 0.5) && near(m.aLR, 0.5) && near(m.aRR, 0.5), JSON.stringify(m));
check('mono left ear sums to unity for identical L and R', near(m.aLL + m.aRL, 1), m.aLL + m.aRL);
check('mono right ear sums to unity for identical L and R', near(m.aLR + m.aRR, 1), m.aLR + m.aRR);
check('mono differs from stereo at the same balance (mono is really read)',
  m.aRL !== EQ.channelMatrix(0, false).aRL);
m = EQ.channelMatrix(-1, true);
check('mono + hard left mutes the right ear entirely', m.aLR === 0 && m.aRR === 0, JSON.stringify(m));
check('mono + hard left still feeds both inputs to the left ear',
  near(m.aLL, 0.5) && near(m.aRL, 0.5), JSON.stringify(m));

section('Out-of-range and garbage balance values are clamped, not trusted');
check('balance 5 behaves as hard right',
  JSON.stringify(EQ.channelMatrix(5, false)) === JSON.stringify(EQ.channelMatrix(1, false)));
check('balance -5 behaves as hard left',
  JSON.stringify(EQ.channelMatrix(-5, false)) === JSON.stringify(EQ.channelMatrix(-1, false)));
check('balance "x" falls back to centre',
  JSON.stringify(EQ.channelMatrix('x', false)) === JSON.stringify(EQ.channelMatrix(0, false)));
check('balance NaN falls back to centre',
  JSON.stringify(EQ.channelMatrix(NaN, false)) === JSON.stringify(EQ.channelMatrix(0, false)));
check('balance undefined falls back to centre',
  JSON.stringify(EQ.channelMatrix(undefined, false)) === JSON.stringify(EQ.channelMatrix(0, false)));
check('string "0.5" is coerced, not dropped', near(EQ.channelMatrix('0.5', false).aLL, 0.5));

/* ================================================================
   2. GRAPH WIRING
   ================================================================ */
section('The output stage really sits between the widener and the speakers');
reset();
check('graph builds', EQ.ensureAudioContext() === true);
const ctx1 = EQ.audioCtx;
const connsTo = (node) => ctx1.__conns.filter(c => c.to === node);
const connsFrom = (node) => ctx1.__conns.filter(c => c.from === node);

check('an output stage exists', !!EQ.outStage && !!EQ.outStage.output);
check('the merger the user hears is connected to destination',
  connsTo(ctx1.destination).some(c => c.from === EQ.outStage.output));
// The mutation that matters: reconnecting the widener straight to destination
// leaves balance and mono wired up but completely inaudible.
check('the widener does NOT reach destination directly (stage cannot be bypassed)',
  !connsTo(ctx1.destination).some(c => c.from === EQ.widener.output),
  connsTo(ctx1.destination).map(c => c.from.__type).join(','));
check('exactly one node feeds destination', connsTo(ctx1.destination).length === 1,
  connsTo(ctx1.destination).length);
const splitter = ctx1.__nodes.filter(n => n.__type === 'splitter').pop();
check('the widener feeds the output stage splitter',
  connsFrom(EQ.widener.output).some(c => c.to === splitter));

section('Splitter channels are not crossed (a silent L/R swap)');
const fromSplit = connsFrom(splitter);
check('input channel 0 feeds the L->L gain',
  fromSplit.some(c => c.to === EQ.outStage.aLL && c.out === 0));
check('input channel 0 feeds the L->R gain',
  fromSplit.some(c => c.to === EQ.outStage.aLR && c.out === 0));
check('input channel 1 feeds the R->L gain',
  fromSplit.some(c => c.to === EQ.outStage.aRL && c.out === 1));
check('input channel 1 feeds the R->R gain',
  fromSplit.some(c => c.to === EQ.outStage.aRR && c.out === 1));
check('L->L is not fed from channel 1',
  !fromSplit.some(c => c.to === EQ.outStage.aLL && c.out === 1));
check('R->R is not fed from channel 0',
  !fromSplit.some(c => c.to === EQ.outStage.aRR && c.out === 0));

section('Merger inputs are not crossed');
const intoMerge = connsTo(EQ.outStage.output);
const mergeIn = (node) => { const c = intoMerge.find(x => x.from === node); return c ? c.in : null; };
check('L->L lands on output channel 0', mergeIn(EQ.outStage.aLL) === 0, mergeIn(EQ.outStage.aLL));
check('R->L lands on output channel 0', mergeIn(EQ.outStage.aRL) === 0, mergeIn(EQ.outStage.aRL));
check('L->R lands on output channel 1', mergeIn(EQ.outStage.aLR) === 1, mergeIn(EQ.outStage.aLR));
check('R->R lands on output channel 1', mergeIn(EQ.outStage.aRR) === 1, mergeIn(EQ.outStage.aRR));

section('A freshly built graph is bit-for-bit transparent');
// Asserted on a stage built in isolation, because applyStoredToGraph() overwrites
// all four gains straight after construction — checking them on the finished
// graph would pass no matter what the constructor set.
const bare = EQ.buildOutputStage(EQ.widener.output);
check('a bare output stage passes L->L at unity', bare.aLL.gain.value === 1, bare.aLL.gain.value);
check('a bare output stage passes R->R at unity', bare.aRR.gain.value === 1, bare.aRR.gain.value);
check('a bare output stage has no cross-bleed',
  bare.aLR.gain.value === 0 && bare.aRL.gain.value === 0,
  `${bare.aLR.gain.value}/${bare.aRL.gain.value}`);
check('L->L defaults to unity', EQ.outStage.aLL.gain.value === 1);
check('R->R defaults to unity', EQ.outStage.aRR.gain.value === 1);
check('cross-gains default to silence',
  EQ.outStage.aLR.gain.value === 0 && EQ.outStage.aRL.gain.value === 0);
check('the widener is still neutral at width 1',
  EQ.widener.widthPos.gain.value === 1 && EQ.widener.widthNeg.gain.value === -1);
check('building the graph registered its context for routing',
  OD.contexts.length === 1 && OD.contexts[0].ctx === ctx1);
check('the registered context is named', OD.contexts[0].name === 'equalizer');
check('the media element source was taken from the real player', ctx1.__sourceArg === audioPlayer);

section('A saved balance is pushed into a graph built later');
reset();
OD.balance = -1;
OD.mono = false;
check('graph builds with a stored balance', EQ.ensureAudioContext() === true);
check('stored hard-left reached the graph, not just the slider',
  EQ.outStage.aRR.gain.value === 0 && EQ.outStage.aLL.gain.value === 1,
  `aLL=${EQ.outStage.aLL.gain.value} aRR=${EQ.outStage.aRR.gain.value}`);
check('the build wrote gains directly rather than sliding from the default',
  EQ.outStage.aRR.gain._writes.every(w => w[0] !== 'setTargetAtTime'),
  JSON.stringify(EQ.outStage.aRR.gain._writes));

reset();
OD.balance = 0;
OD.mono = true;
EQ.ensureAudioContext();
check('stored mono reached the graph', near(EQ.outStage.aRL.gain.value, 0.5), EQ.outStage.aRL.gain.value);

section('setChannelMatrix ramps rather than jumps once the graph is live');
reset();
EQ.ensureAudioContext();
check('setChannelMatrix reports success', EQ.setChannelMatrix(1, false) === true);
check('the ramp used setTargetAtTime',
  EQ.outStage.aLL.gain._writes.some(w => w[0] === 'setTargetAtTime'));
check('the ramp landed on the right value', EQ.outStage.aLL.gain.value === 0);
check('the ramp is anchored to the context clock',
  EQ.outStage.aLL.gain._writes.filter(w => w[0] === 'setTargetAtTime')
    .every(w => w[2] === EQ.audioCtx.currentTime),
  JSON.stringify(EQ.outStage.aLL.gain._writes));
check('the ramp is short enough to be inaudible but long enough not to click',
  EQ.outStage.aLL.gain._writes.filter(w => w[0] === 'setTargetAtTime')
    .every(w => w[3] > 0 && w[3] <= 0.2));
check('setChannelMatrix with no graph reports failure, it does not throw',
  (() => { const saved = EQ.outStage; EQ.outStage = null; const r = EQ.setChannelMatrix(0, false); EQ.outStage = saved; return r === false; })());

/* ================================================================
   3. BYPASS GATE
   ================================================================ */
section('Bypass keeps the Web Audio graph off the element');
reset();
EQ.bypassed = true;
check('ensureAudioContext refuses while bypassed', EQ.ensureAudioContext() === false);
check('no context was constructed', EQ.audioCtx === null);
check('bypass does not latch `unavailable` (it must be reversible)', EQ.unavailable === false);
EQ.bypassed = false;
check('clearing bypass lets the graph build again', EQ.ensureAudioContext() === true);

reset();
store.eqBypass = true;
EQ.init();
check('EqualizerManager.init reads the stored bypass flag', EQ.bypassed === true);
reset();
store.eqBypass = false;
EQ.init();
check('a stored false leaves the equalizer enabled', EQ.bypassed === false);

reset();
EQ.bypassed = true;
EQ.openModal();
check('opening the EQ while bypassed says so instead of blaming the track',
  toasts.some(t => /bypass/i.test(t)) && !toasts.some(t => /external source/i.test(t)),
  toasts.join(' | '));

reset({ sourceThrows: true });
check('a cross-origin failure still latches `unavailable`',
  EQ.ensureAudioContext() === false && EQ.unavailable === true);
check('a failed build leaves no half-wired context', EQ.audioCtx === null);

/* ================================================================
   4. resolveDesired — the disconnect trap
   ================================================================ */
section('resolveDesired distinguishes "use default" from "device missing"');
reset();
check('no request resolves to the system default (empty string)', OD.resolveDesired() === '');
OD.devices = [dev('default', 'Default'), dev('aaa', 'Speakers (Realtek)'), dev('bbb', 'boAt Rockerz')];
OD.desiredId = 'bbb'; OD.desiredLabel = 'boAt Rockerz';
check('a present device resolves to its id', OD.resolveDesired() === 'bbb');
OD.devices = [dev('default', 'Default'), dev('aaa', 'Speakers (Realtek)'), dev('zzz', 'boAt Rockerz')];
check('a re-salted deviceId is recovered by label', OD.resolveDesired() === 'zzz');
OD.devices = [dev('default', 'Default'), dev('aaa', 'Speakers (Realtek)')];
check('a genuinely absent device resolves to null, NOT to the default',
  OD.resolveDesired() === null, String(OD.resolveDesired()));
OD.devices = [];
check('an empty device list resolves to null', OD.resolveDesired() === null);
OD.desiredLabel = '';
OD.devices = [dev('aaa', 'Speakers')];
check('with no label to match, an absent id is still null', OD.resolveDesired() === null);
OD.desiredId = '';
check('clearing the request returns to the default', OD.resolveDesired() === '');
OD.desiredId = 'ccc'; OD.desiredLabel = '';
OD.devices = [dev('ccc', '')];
check('an unlabelled but present device still resolves', OD.resolveDesired() === 'ccc');

/* ================================================================
   5. Async scenarios — run one at a time
   ================================================================ */
const scenarios = [];
const S = (name, fn) => scenarios.push({ name, fn });
// init() kicks off refresh().then(() => apply()), and apply awaits a Promise.all
// inside pushSink — several microtask turns deep with no timer to hook, so the
// only honest way to observe the settled state is to drain the queue.
const drain = async (turns = 40) => { for (let i = 0; i < turns; i++) await Promise.resolve(); };

/* ---- pushSink layering ---- */
S('pushSink drives both layers, and reports which answered', async () => {
  reset();
  let r = await OD.pushSink('aaa');
  check('with no context, only the player is routed',
    r.any === true && r.layers.join() === 'player', JSON.stringify(r));
  check('the requested id reached the element, not a blank', audioPlayer.__sinkCalls.pop() === 'aaa');

  reset();
  EQ.ensureAudioContext();
  r = await OD.pushSink('bbb');
  check('with a graph, player and engine are both routed',
    r.any === true && r.layers.length === 2 && r.layers.includes('equalizer'), JSON.stringify(r));
  check('the id reached the AudioContext too', EQ.audioCtx.__sinkCalls.pop() === 'bbb');

  reset({ ctxSink: false });
  EQ.ensureAudioContext();
  r = await OD.pushSink('ccc');
  check('a context that cannot switch sinks is skipped, not crashed on',
    r.any === true && r.layers.join() === 'player', JSON.stringify(r));

  reset({ elementSink: false });
  EQ.ensureAudioContext();
  r = await OD.pushSink('ddd');
  check('an element that cannot switch sinks still lets the engine route',
    r.any === true && r.layers.join() === 'equalizer', JSON.stringify(r));

  reset({ elementSink: false, ctxSink: false });
  EQ.ensureAudioContext();
  r = await OD.pushSink('eee');
  check('with neither layer available, pushSink reports no route', r.any === false, JSON.stringify(r));

  reset({ elementSinkFails: true });
  EQ.ensureAudioContext();
  r = await OD.pushSink('fff');
  check('a rejected element sink still counts the engine as routed',
    r.any === true && r.layers.join() === 'equalizer', JSON.stringify(r));
  check('the rejection reason is captured for diagnostics',
    /refused/.test(r.error) && /refused/.test(OD.lastError), r.error);

  reset({ ctxSinkFails: true });
  EQ.ensureAudioContext();
  r = await OD.pushSink('ggg');
  check('a rejected engine sink still counts the player as routed',
    r.any === true && r.layers.join() === 'player', JSON.stringify(r));

  reset();
  await OD.pushSink('');
  check('the empty string is passed through as "system default"',
    audioPlayer.__sinkCalls[audioPlayer.__sinkCalls.length - 1] === '');
});

/* ---- registerContext ---- */
S('registerContext routes a context the moment it appears', async () => {
  reset();
  OD.devices = [dev('aaa', 'boAt')];
  OD.desiredId = 'aaa'; OD.desiredLabel = 'boAt';
  const late = makeFakeCtx({});
  OD.registerContext(late, 'ambient');
  await drain();
  check('a context registered after a device choice is routed to it',
    late.__sinkCalls.join() === 'aaa', late.__sinkCalls.join());
  check('it is tracked for later re-routing',
    OD.contexts.some(c => c.ctx === late && c.name === 'ambient'));
  OD.registerContext(late, 'ambient');
  check('registering twice does not duplicate the context',
    OD.contexts.filter(c => c.ctx === late).length === 1);

  reset();
  OD.devices = [dev('aaa', 'Speakers')];
  OD.desiredId = 'gone'; OD.desiredLabel = 'Gone';
  const late2 = makeFakeCtx({});
  OD.registerContext(late2, 'ambient');
  await drain();
  check('a context is not force-routed while the wanted device is missing',
    late2.__sinkCalls.length === 0, late2.__sinkCalls.join());
});

/* ---- refresh & enumeration ---- */
S('refresh filters the device list and seeds "known" without hijacking', async () => {
  reset();
  devices = [
    dev('default', 'Default'),
    dev('aaa', 'Speakers (Realtek)'),
    { kind: 'audioinput', deviceId: 'mic1', label: 'Microphone' },
    { kind: 'videoinput', deviceId: 'cam1', label: 'Webcam' },
  ];
  let fresh = await OD.refresh();
  check('only audiooutput devices are kept', OD.devices.length === 2, OD.devices.length);
  check('inputs are excluded', !OD.devices.some(d => d.kind !== 'audiooutput'));
  // The trap: if the first scan reported everything as new, auto-follow would
  // switch output on page load.
  check('the first scan reports nothing as newly arrived', fresh.length === 0, JSON.stringify(fresh));
  check('labels were detected as visible', OD.labelsVisible === true);

  devices = devices.concat([dev('bt1', 'boAt Rockerz 550')]);
  fresh = await OD.refresh();
  check('a second scan reports only the genuinely new device',
    fresh.length === 1 && fresh[0] === 'bt1', JSON.stringify(fresh));

  fresh = await OD.refresh();
  check('re-scanning the same list reports nothing new', fresh.length === 0);

  reset();
  devices = [{ kind: 'audiooutput', deviceId: '', label: '' }];
  await OD.refresh();
  check('an unlabelled placeholder is kept but marked label-less',
    OD.devices.length === 1 && OD.labelsVisible === false);

  reset();
  enumerateThrows = true;
  await OD.refresh();
  check('an enumerateDevices failure is recorded, not thrown',
    /blew up/.test(OD.lastError), OD.lastError);
});

/* ---- apply ---- */
S('apply reports the truth about where audio went', async () => {
  reset();
  devices = [dev('default', 'Default'), dev('bt1', 'boAt Rockerz 550')];
  await OD.refresh();
  let ok = await OD.apply(true);
  check('choosing the system default succeeds', ok === true);
  check('activeId records the default as an empty string', OD.activeId === '');

  OD.desiredId = 'bt1'; OD.desiredLabel = 'boAt Rockerz 550';
  toasts.length = 0;
  ok = await OD.apply(true);
  check('choosing a real device succeeds', ok === true && OD.activeId === 'bt1');
  check('the status line names the device and the layer',
    /boAt Rockerz 550/.test(els['#outputStatus'].textContent) &&
    /routed via/.test(els['#outputStatus'].textContent), els['#outputStatus'].textContent);
  check('the status line is marked good', els['#outputStatus'].classList.contains('is-good'));
  check('announce:true toasts the switch', toasts.some(t => /boAt/.test(t)), toasts.join('|'));

  toasts.length = 0;
  await OD.apply(false);
  check('announce:false stays quiet', toasts.length === 0, toasts.join('|'));

  // Headphones walk out of range.
  devices = [dev('default', 'Default')];
  await OD.refresh();
  audioPlayer.__sinkCalls.length = 0;
  ok = await OD.apply(false);
  check('a missing device is not a success', ok === false);
  check('activeId is cleared rather than faked', OD.activeId === null);
  check('the player is parked on the system default so audio is never nowhere',
    audioPlayer.__sinkCalls.join() === '', JSON.stringify(audioPlayer.__sinkCalls));
  check('the status warns and names the device', /boAt Rockerz 550/.test(els['#outputStatus'].textContent) &&
    els['#outputStatus'].classList.contains('is-warn'), els['#outputStatus'].textContent);
  check('the request is remembered, not erased', OD.desiredId === 'bt1');

  // The dead end: graph is live and this browser cannot re-point it.
  reset({ ctxSink: false, elementSink: false });
  devices = [dev('default', 'Default'), dev('bt1', 'boAt')];
  await OD.refresh();
  EQ.ensureAudioContext();
  OD.desiredId = 'bt1'; OD.desiredLabel = 'boAt';
  ok = await OD.apply(false);
  check('an unroutable browser reports failure', ok === false);
  check('routingBlocked is detected', OD.routingBlocked() === true);
  check('the status offers the bypass escape hatch',
    /bypass/i.test(els['#outputStatus'].textContent) &&
    els['#outputStatus'].classList.contains('is-bad'), els['#outputStatus'].textContent);
});

/* ---- select + persistence ---- */
S('select persists device-locally, never to the server', async () => {
  reset();
  devices = [dev('default', 'Default'), dev('bt1', 'boAt Rockerz 550')];
  await OD.refresh();
  await OD.select('bt1', 'boAt Rockerz 550');
  check('the choice is stored', store.outputRouting && store.outputRouting.deviceId === 'bt1');
  check('the label is stored alongside it, for id re-salting',
    store.outputRouting.label === 'boAt Rockerz 550');
  // A deviceId is salted per browser profile and origin: syncing it would push
  // a meaningless string to every other device on the account.
  check('routing went through setLocal', localKeys.includes('outputRouting'));
  check('routing did NOT go through the server-synced setter',
    !syncedKeys.includes('outputRouting'), syncedKeys.join(','));

  await OD.select('', '');
  check('selecting the system default clears the stored id', store.outputRouting.deviceId === '');
  check('selecting the system default clears the stale label', store.outputRouting.label === '');

  OD.balance = -0.4; OD.mono = true; OD.autoFollow = false;
  OD.savePrefs();
  const saved = store.outputRouting;
  reset();
  store.outputRouting = saved;
  OD.loadPrefs();
  check('balance round-trips', near(OD.balance, -0.4), OD.balance);
  check('mono round-trips', OD.mono === true);
  check('auto-follow round-trips', OD.autoFollow === false);

  reset();
  store.outputRouting = { balance: 99, mono: 'yes', autoFollow: 'no', deviceId: 5 };
  OD.loadPrefs();
  check('a garbage stored balance is clamped', OD.balance === 1, OD.balance);
  check('a non-boolean mono becomes false', OD.mono === false);
  check('a non-boolean autoFollow keeps the default', OD.autoFollow === true);
  check('a non-string deviceId is ignored', OD.desiredId === '');
});

/* ---- devicechange ---- */
S('devicechange is debounced and acts on the settled list', async () => {
  reset();
  devices = [dev('default', 'Default'), dev('aaa', 'Speakers (Realtek)')];
  await OD.refresh();
  let handled = 0;
  const realHandle = OD.handleDeviceChange;
  OD.handleDeviceChange = function () { handled++; return Promise.resolve(); };
  OD.onDeviceChange(); OD.onDeviceChange(); OD.onDeviceChange(); OD.onDeviceChange();
  check('four rapid events schedule one handler, not four', timers.size === 1, timers.size);
  runTimers();
  check('the coalesced handler ran exactly once', handled === 1, handled);
  OD.handleDeviceChange = realHandle;
});

S('auto-follow switches to headphones that arrive, and only to those', async () => {
  reset();
  devices = [dev('default', 'Default'), dev('aaa', 'Speakers (Realtek)')];
  await OD.refresh();
  devices = devices.concat([dev('bt1', 'boAt Rockerz 550 Bluetooth')]);
  toasts.length = 0;
  await OD.handleDeviceChange();
  check('a newly connected headphone is selected', OD.desiredId === 'bt1', OD.desiredId);
  check('the switch is announced', toasts.some(t => /boAt/.test(t)), toasts.join('|'));
  check('the label is remembered for later re-salting', OD.desiredLabel === 'boAt Rockerz 550 Bluetooth');

  reset();
  OD.autoFollow = false;
  devices = [dev('default', 'Default'), dev('aaa', 'Speakers')];
  await OD.refresh();
  devices = devices.concat([dev('bt1', 'boAt Rockerz Bluetooth')]);
  await OD.handleDeviceChange();
  check('auto-follow off leaves the choice alone', OD.desiredId === '', OD.desiredId);

  // 'default' and 'communications' are Windows aliases that appear alongside a
  // real endpoint; following them routes to a pseudo-device, and
  // 'communications' is the mono call profile that sounds broken.
  reset();
  devices = [dev('aaa', 'Speakers')];
  await OD.refresh();
  devices = devices.concat([dev('default', 'Default'), dev('communications', 'Communications')]);
  await OD.handleDeviceChange();
  check('the Windows pseudo-endpoints are never auto-selected', OD.desiredId === '', OD.desiredId);

  reset();
  devices = [dev('aaa', 'Speakers')];
  await OD.refresh();
  devices = devices.concat([dev('hdmi', 'Digital Display Audio'), dev('bt1', 'WH-1000XM4')]);
  await OD.handleDeviceChange();
  check('a headphone is preferred over another new device that appeared with it',
    OD.desiredId === 'bt1', OD.desiredId);

  reset();
  devices = [dev('aaa', 'Speakers')];
  await OD.refresh();
  devices = devices.concat([dev('hdmi', 'Digital Display Audio')]);
  await OD.handleDeviceChange();
  check('with no headphone among them, the new device is still taken',
    OD.desiredId === 'hdmi', OD.desiredId);
});

S('a disconnect falls back without forgetting, and a reconnect comes back', async () => {
  reset();
  devices = [dev('default', 'Default'), dev('bt1', 'boAt Rockerz')];
  await OD.refresh();
  await OD.select('bt1', 'boAt Rockerz');
  check('routed to the headphone', OD.activeId === 'bt1');

  devices = [dev('default', 'Default')];
  toasts.length = 0;
  await OD.handleDeviceChange();
  check('the disconnect is announced', toasts.some(t => /disconnect/i.test(t)), toasts.join('|'));
  check('the request survives the disconnect', OD.desiredId === 'bt1');
  check('nothing is claimed as routed', OD.activeId === null);

  // Reconnects almost always come back with a different salted id.
  devices = [dev('default', 'Default'), dev('bt9', 'boAt Rockerz')];
  await OD.handleDeviceChange();
  check('the reconnected device is re-routed under its new id', OD.activeId === 'bt9', String(OD.activeId));
  check('auto-follow did not double-handle it as a brand new device',
    OD.desiredId === 'bt1' || OD.desiredId === 'bt9', OD.desiredId);

  // Same round trip with auto-follow off, so nothing but the reconnect branch
  // itself can bring the device back.
  reset();
  OD.autoFollow = false;
  devices = [dev('default', 'Default'), dev('bt1', 'boAt Rockerz')];
  await OD.refresh();
  await OD.select('bt1', 'boAt Rockerz');
  devices = [dev('default', 'Default')];
  await OD.handleDeviceChange();
  check('with auto-follow off, a disconnect still falls back', OD.activeId === null);
  devices = [dev('default', 'Default'), dev('bt9', 'boAt Rockerz')];
  await OD.handleDeviceChange();
  check('with auto-follow off, the reconnect branch alone restores the device',
    OD.activeId === 'bt9', String(OD.activeId));
  check('and auto-follow stayed off', OD.autoFollow === false);
});

/* ---- repair ---- */
S('repair resumes, re-routes and restarts without seeking', async () => {
  reset({ state: 'suspended' });
  devices = [dev('default', 'Default'), dev('bt1', 'boAt Rockerz')];
  await OD.refresh();
  EQ.ensureAudioContext();
  const rctx = EQ.audioCtx;
  check('precondition: the context is suspended', rctx.state === 'suspended');
  OD.desiredId = 'bt1'; OD.desiredLabel = 'boAt Rockerz';
  audioPlayer.paused = false;
  const timeBefore = audioPlayer.currentTime;
  await OD.repair();
  check('a suspended context is resumed', rctx.state === 'running');
  check('the sink was re-applied', rctx.__sinkCalls.includes('bt1'), rctx.__sinkCalls.join());
  check('a playing element is nudged with pause+play',
    audioPlayer.__pauses === 1 && audioPlayer.__plays === 1,
    `${audioPlayer.__pauses}/${audioPlayer.__plays}`);
  // The transcode branch of /api/stream answers Accept-Ranges: none, so writing
  // currentTime there is unreliable — pause() already holds the position.
  check('repair never seeks', audioPlayer.currentTime === timeBefore, audioPlayer.currentTime);
  check('a stranded crossfade volume is handed back to its owner', restoreCalls.length === 1);
  check('the repair button is re-enabled afterwards', els['#outputRepairBtn'].disabled === false);

  reset();
  devices = [dev('default', 'Default')];
  await OD.refresh();
  audioPlayer.paused = true;
  await OD.repair();
  check('a paused element is not started by repair',
    audioPlayer.__plays === 0 && audioPlayer.__pauses === 0);
});

S('repair names the sample-rate mismatch that no API reports directly', async () => {
  reset({ sampleRate: 48000 });
  devices = [dev('default', 'Default')];
  await OD.refresh();
  EQ.ensureAudioContext();
  check('precondition: graph is at 48 kHz', EQ.audioCtx.sampleRate === 48000);
  // Every context the fake class builds from here reports the new default rate,
  // which is what a probe context measures.
  sandbox.window.AudioContext = makeCtxClass({ sampleRate: 16000 });
  const stale = await OD.sampleRateMismatch();
  check('the mismatch is detected', !!stale && stale.ctx === 48000 && stale.device === 16000, JSON.stringify(stale));
  const probe = sandbox.window.AudioContext.__made[0];
  check('the probe context is closed, not leaked', probe && probe.__closed === true);

  await OD.repair();
  check('repair reports the mismatch as needing a reload',
    /reload/i.test(els['#outputStatus'].textContent) &&
    els['#outputStatus'].classList.contains('is-bad'), els['#outputStatus'].textContent);
  check('and says so in a toast too', toasts.some(t => /reload/i.test(t)), toasts.join('|'));

  reset({ sampleRate: 44100 });
  EQ.ensureAudioContext();
  const same = await OD.sampleRateMismatch();
  check('matching rates report no mismatch', same === null, JSON.stringify(same));
  check('the probe is closed even when the rates match',
    sandbox.window.AudioContext.__made.slice(-1)[0].__closed === true);

  reset();
  const none = await OD.sampleRateMismatch();
  check('with no context built there is nothing to compare', none === null);
});

/* ---- test tone ---- */
S('the test tone proves the route, or admits that it cannot', async () => {
  reset();
  devices = [dev('default', 'Default'), dev('bt1', 'boAt Rockerz')];
  await OD.refresh();
  OD.desiredId = 'bt1'; OD.desiredLabel = 'boAt Rockerz';
  await OD.testTone();
  const tone = sandbox.window.AudioContext.__made.slice(-1)[0];
  check('the tone got its own context, leaving the playback graph alone',
    tone && tone !== EQ.audioCtx);
  check('the tone context was routed to the chosen device', tone.__sinkCalls.join() === 'bt1');
  check('two beeps were scheduled', tone.__nodes.filter(n => n.__type === 'osc').length === 2);
  check('both oscillators start and stop (no stuck tone)',
    tone.__nodes.filter(n => n.__type === 'osc').every(o => o.__started && o.__stopped));
  check('the envelope never targets exactly zero (exponential ramps cannot)',
    tone.__nodes.filter(n => n.__type === 'gain')
      .every(g => g.gain._writes.filter(w => w[0] === 'exp').every(w => w[1] > 0)));
  check('the toast names the device', toasts.some(t => /boAt Rockerz/.test(t)), toasts.join('|'));
  check('the context is not closed until its timer fires', tone.__closed === false);
  runTimers();
  check('the tone context is closed afterwards, not leaked', tone.__closed === true);

  reset({ ctxSink: false });
  toasts.length = 0;
  await OD.testTone();
  check('an unroutable tone says it only proves the default output',
    toasts.some(t => /system default/i.test(t)), toasts.join('|'));

  reset({ noAudioCtx: true });
  toasts.length = 0;
  await OD.testTone();
  check('with no Web Audio at all it declines cleanly',
    toasts.some(t => /not supported/i.test(t)), toasts.join('|'));
});

/* ---- rendering & escaping ---- */
S('the device list renders, escapes and routes clicks', async () => {
  reset();
  devices = [dev('default', 'Default'), dev('aaa', 'Speakers (Realtek)'), dev('bt1', 'boAt Rockerz Bluetooth')];
  await OD.refresh();
  let rows = parseRows();
  check('every device plus a "follow the system" row is rendered',
    rows.length === 4, rows.length);
  check('the system row carries an empty device id', rows[0].dataset.deviceId === '');
  check('with no choice made, the system row is the active one',
    rows[0]._classes.has('active') && !rows.slice(1).some(r => r._classes.has('active')));
  check('a Bluetooth device gets the headphone treatment',
    /Headphones \/ Bluetooth/.test(rows.find(r => r.dataset.deviceId === 'bt1')._inner));
  check('the communications endpoint is not invented when absent',
    !els['#outputDeviceList'].innerHTML.includes('call endpoint'));

  // Click through the real markup.
  const target = rows.find(r => r.dataset.deviceId === 'bt1');
  target.fire('click');
  await drain();
  check('clicking a rendered row selects that device', OD.desiredId === 'bt1', OD.desiredId);
  rows = parseRows();
  check('the chosen row is re-rendered as active',
    rows.find(r => r.dataset.deviceId === 'bt1')._classes.has('active'));
  check('the "In use" tag moved off the system row',
    !rows[0]._classes.has('active'));

  // A device label is OS-supplied text; it must not be able to inject markup.
  reset();
  devices = [dev('default', 'Default'), dev('evil', '"><img src=x onerror=alert(1)>')];
  await OD.refresh();
  const html = els['#outputDeviceList'].innerHTML;
  check('a hostile device label cannot inject a tag', !/<img/i.test(html), html.slice(0, 160));
  check('its quotes are escaped so it cannot break out of the attribute',
    html.includes('data-device-label="&quot;&gt;&lt;img'), html.slice(0, 240));
  // The label's text still reads "onerror=alert(1)" — as inert text, which is
  // correct. What must be true is that no tag exists beyond the ones render()
  // wrote itself, so the hostile label never became markup.
  const tags = [...new Set([...html.matchAll(/<\/?([a-z][a-z0-9]*)/gi)].map(m => m[1].toLowerCase()))];
  check('only the manager\'s own tags exist in the markup',
    tags.every(t => ['button', 'span', 'div', 'b'].includes(t)), tags.join(','));
  check('the label still round-trips back through the dataset',
    parseRows().some(r => r.dataset.deviceLabel === '"><img src=x onerror=alert(1)>'),
    JSON.stringify(parseRows().map(r => r.dataset.deviceLabel)));

  reset();
  devices = [dev('default', ''), dev('aaa', '')];
  await OD.refresh();
  check('unlabelled devices are numbered rather than left blank',
    /Output 2/.test(els['#outputDeviceList'].innerHTML), els['#outputDeviceList'].innerHTML.slice(0, 200));
  check('the status explains why the names are missing',
    /Show names/.test(els['#outputStatus'].textContent), els['#outputStatus'].textContent);

  reset();
  devices = [dev('default', 'Default'), dev('communications', 'Comms')];
  await OD.refresh();
  check('the Windows call endpoint is labelled as the low-quality route',
    /call endpoint/.test(els['#outputDeviceList'].innerHTML));
});

/* ---- no secure context ---- */
S('an insecure origin explains itself instead of showing an empty list', async () => {
  reset({ noMediaDevices: true });
  check('capability probe reports no enumeration', OD.canEnumerate() === false);
  OD.init();
  check('init does not throw without mediaDevices', true);
  check('the empty state names localhost as the fix',
    /localhost/.test(els['#outputDeviceList'].innerHTML), els['#outputDeviceList'].innerHTML);
  check('the status line warns rather than staying blank',
    els['#outputStatus'].classList.contains('is-warn') &&
    /localhost|HTTPS/.test(els['#outputStatus'].textContent), els['#outputStatus'].textContent);
  check('no devices are invented', OD.devices.length === 0);

  reset({ addEventListener: false });
  devices = [dev('default', 'Default')];
  OD.init();
  await drain();
  check('a mediaDevices without addEventListener falls back to ondevicechange',
    typeof mediaDevices.ondevicechange === 'function');
});

/* ---- label permission ---- */
S('revealing device names releases the microphone immediately', async () => {
  reset();
  devices = [dev('default', 'Default'), dev('aaa', 'Speakers')];
  await OD.requestLabels();
  // Holding a live mic track can flip a Bluetooth headset into its mono call
  // profile, which is the very problem this panel exists to fix.
  check('the capture track is stopped, not held open', gumStops.length === 1, gumStops.length);
  check('the list is re-scanned once permission lands', OD.devices.length === 2);
  check('success is confirmed to the user', toasts.some(t => /unlock/i.test(t)), toasts.join('|'));

  reset();
  gumBehaviour = 'deny';
  await OD.requestLabels();
  check('a denied permission is explained, not swallowed',
    toasts.some(t => /denied/i.test(t)), toasts.join('|'));
  check('the denial is recorded for diagnostics', /denied/i.test(OD.lastError), OD.lastError);

  reset({ gum: false });
  await OD.requestLabels();
  check('a browser without getUserMedia says so', toasts.some(t => /cannot reveal/i.test(t)), toasts.join('|'));
});

/* ---- balance / mono UI path ---- */
S('balance and mono reach the graph and the label', async () => {
  reset();
  OD.setBalance(-0.5);
  check('balance needs a graph and builds one', !!EQ.outStage);
  check('the balance reached the graph', near(EQ.outStage.aRR.gain.value, 0.5), EQ.outStage.aRR.gain.value);
  check('the label reads out the side and amount',
    els['#outputBalanceVal'].textContent === '50% left', els['#outputBalanceVal'].textContent);
  OD.setBalance(0);
  check('centre reads "Centered"', els['#outputBalanceVal'].textContent === 'Centered');
  OD.setBalance(0.25);
  check('right side is labelled right', /right/.test(els['#outputBalanceVal'].textContent));
  check('balance is persisted device-locally', localKeys.includes('outputRouting'));

  OD.setMono(true);
  check('mono reached the graph', near(EQ.outStage.aRL.gain.value, 0.5 * 0.75), EQ.outStage.aRL.gain.value);
  check('mono is persisted', store.outputRouting.mono === true);

  // Mono cancels the widener mathematically, so the warning must only appear
  // when 3D is actually on — an always-visible warning trains people to ignore it.
  els['#spatialAudioToggle'].checked = true;
  OD.setMono(true);
  check('the 3D conflict hint shows when spatial audio is on',
    els['#outputMonoHint'].style.display === '', els['#outputMonoHint'].style.display);
  els['#spatialAudioToggle'].checked = false;
  OD.setMono(true);
  check('the hint hides when spatial audio is off',
    els['#outputMonoHint'].style.display === 'none', els['#outputMonoHint'].style.display);

  reset();
  EQ.bypassed = true;
  const ok = OD.setBalance(0.5);
  check('with the engine bypassed, balance reports failure instead of lying', ok === false);
  check('and explains why', toasts.some(t => /equalizer engine/i.test(t)), toasts.join('|'));
});

/* ---- UI reflection ---- */
S('the panel never claims a setting the audio is not using', async () => {
  reset();
  store.outputRouting = { deviceId: 'x', label: 'X', autoFollow: false, balance: 0.6, mono: true };
  store.eqBypass = true;
  OD.loadPrefs();
  OD.reflectUI();
  check('auto-follow checkbox mirrors storage', els['#outputAutoFollow'].checked === false);
  check('balance slider mirrors storage (as a percentage)', els['#outputBalance'].value === '60', els['#outputBalance'].value);
  check('mono checkbox mirrors storage', els['#outputMono'].checked === true);
  check('bypass checkbox mirrors storage', els['#outputEqBypass'].checked === true);
  check('the balance label mirrors storage', /60% right/.test(els['#outputBalanceVal'].textContent));
});

/* ---- diagnostics ---- */
S('diagnostics say which layer owns the output', async () => {
  reset();
  devices = [dev('default', 'Default'), dev('bt1', 'boAt Rockerz')];
  await OD.refresh();
  OD.renderDiagnostics();
  let d = els['#outputDiag'].innerHTML;
  check('before any graph, the player is named as the owner',
    /not built \(player owns the output\)/.test(d), d);

  EQ.ensureAudioContext();
  OD.renderDiagnostics();
  d = els['#outputDiag'].innerHTML;
  check('once the graph exists, it is named as the owner',
    /live \(it owns the output\)/.test(d), d);
  check('the engine state and sample rate are reported', /48000 Hz/.test(d));

  // A crossfade stranded near silence looks exactly like a routing fault, so the
  // volume has to be visible here.
  audioPlayer.volume = 0; audioPlayer.muted = true;
  OD.renderDiagnostics();
  d = els['#outputDiag'].innerHTML;
  check('a muted, silent player is visible in diagnostics', /0%.*muted/.test(d), d);

  reset();
  EQ.bypassed = true;
  OD.renderDiagnostics();
  check('bypass is reported', /bypassed/.test(els['#outputDiag'].innerHTML));

  reset();
  OD.desiredId = 'evil';
  OD.desiredLabel = '<img src=x>';
  OD.renderDiagnostics();
  check('a hostile label cannot inject markup into diagnostics either',
    !/<img/i.test(els['#outputDiag'].innerHTML), els['#outputDiag'].innerHTML);

  reset();
  OD.lastError = 'sink refused';
  OD.renderDiagnostics();
  check('the last error is surfaced when there is one', /sink refused/.test(els['#outputDiag'].innerHTML));
  reset();
  OD.renderDiagnostics();
  check('and omitted when there is not', !/Last error/.test(els['#outputDiag'].innerHTML));
});

/* ---- bindings ---- */
S('every control in the panel is wired to something', async () => {
  reset();
  devices = [dev('default', 'Default'), dev('bt1', 'boAt')];
  OD.init();
  await drain();
  const wired = (id, ev) => (els[id]._l[ev] || []).length > 0;
  check('the settings entry point opens the panel', wired('#settingOutputBtn', 'click'));
  check('close is wired', wired('#outputCloseBtn', 'click'));
  check('done is wired', wired('#outputDoneBtn', 'click'));
  check('rescan is wired', wired('#outputRefreshBtn', 'click'));
  check('show-names is wired', wired('#outputLabelsBtn', 'click'));
  check('re-route is wired', wired('#outputRepairBtn', 'click'));
  check('test tone is wired', wired('#outputTestBtn', 'click'));
  check('auto-follow is wired', wired('#outputAutoFollow', 'change'));
  check('balance is wired', wired('#outputBalance', 'input'));
  check('centre is wired', wired('#outputBalanceResetBtn', 'click'));
  check('mono is wired', wired('#outputMono', 'change'));
  check('bypass is wired', wired('#outputEqBypass', 'change'));
  check('a devicechange listener was attached',
    (mediaDevices._l.devicechange || []).length === 1);

  els['#settingOutputBtn'].fire('click');
  check('opening the panel closes the settings modal behind it',
    els['#settingsModal'].style.display === 'none');
  check('the panel is shown', els['#outputModal'].style.display === 'flex');
  els['#outputCloseBtn'].fire('click');
  check('closing hides it', els['#outputModal'].style.display === 'none');

  els['#outputBalance'].value = '-70';
  els['#outputBalance'].fire('input', { target: els['#outputBalance'] });
  check('dragging the slider moves the balance', near(OD.balance, -0.7), OD.balance);
  els['#outputBalanceResetBtn'].fire('click');
  check('Center resets both the value and the slider',
    OD.balance === 0 && els['#outputBalance'].value === '0');

  els['#outputAutoFollow'].checked = false;
  els['#outputAutoFollow'].fire('change', { target: els['#outputAutoFollow'] });
  check('toggling auto-follow persists it', OD.autoFollow === false && store.outputRouting.autoFollow === false);

  check('precondition: the slider drag built a live graph', OD.graphActive() === true);
  toasts.length = 0;
  els['#outputEqBypass'].checked = true;
  els['#outputEqBypass'].fire('change', { target: els['#outputEqBypass'] });
  // createMediaElementSource is one-way: a live graph cannot be torn down.
  check('bypassing a live graph asks for a reload rather than pretending',
    toasts.some(t => /reload/i.test(t)), toasts.join('|'));
  check('and does not claim the graph is already bypassed', EQ.bypassed === false);
  check('the choice is still stored for the next load', store.eqBypass === true);
  els['#outputEqBypass'].checked = false;
  els['#outputEqBypass'].fire('change', { target: els['#outputEqBypass'] });
  check('un-bypassing clears both the flag and the store',
    EQ.bypassed === false && store.eqBypass === false);

  // Same toggle, but from a cold start where nothing is wired up yet.
  reset();
  devices = [dev('default', 'Default')];
  OD.init();
  els['#outputEqBypass'].checked = true;
  els['#outputEqBypass'].fire('change', { target: els['#outputEqBypass'] });
  check('bypass takes effect at once when no graph exists yet', EQ.bypassed === true);
  check('and is stored for the next load', store.eqBypass === true);
  check('the equalizer then refuses to build', EQ.ensureAudioContext() === false);
});

S('init re-asserts a saved device on a cold start, quietly', async () => {
  reset();
  store.outputRouting = { deviceId: 'bt1', label: 'boAt Rockerz', autoFollow: true, balance: 0, mono: false };
  devices = [dev('default', 'Default'), dev('bt1', 'boAt Rockerz')];
  OD.init();
  await drain();
  check('the saved device is re-applied on load', OD.activeId === 'bt1', String(OD.activeId));
  check('the re-assert is silent (no toast on a cold start)',
    !toasts.some(t => /Output →/.test(t)), toasts.join('|'));

  reset();
  devices = [dev('default', 'Default')];
  OD.init();
  await drain();
  check('with nothing saved, no sink is forced at boot',
    audioPlayer.__sinkCalls.length === 0, JSON.stringify(audioPlayer.__sinkCalls));
});

/* ---------- run the async scenarios one at a time -------------------- */
(async () => {
  for (const s of scenarios) {
    section(s.name);
    try {
      await s.fn();
    } catch (err) {
      failures++;
      console.log(`  FAIL  ${s.name} threw — ${err && err.message}`);
      if (process.env.VERBOSE) console.log(err.stack);
    }
  }
  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
