#!/usr/bin/env node
'use strict';

/*
 * Guards the invariants behind the mobile player sheet, the keyboard shortcut
 * help overlay and the library filter.
 *
 * Every check here corresponds to a bug that actually happened while building
 * these features:
 *
 *  - onKeyboard called toggleShortcutHelp() and closeTopmostOverlay() before
 *    either existed, so pressing ? or Escape threw a ReferenceError. Nothing
 *    caught it: the whole file is one IIFE with no exports, so a missing
 *    function is only discovered by pressing the key.
 *  - The help overlay listed "B — toggle lyrics" and "L — like" while the code
 *    had it the other way round. A help screen that lies is worse than none.
 *  - Below 640px the stylesheet hides nine controls. They need a second entry
 *    point or the features are unreachable on a phone.
 *  - Song titles and filter queries are untrusted input and must not reach
 *    innerHTML.
 *
 * Run: node test/ui-features.test.js
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

/* ---------- helpers --------------------------------------------------- */

// Brace-matched body of a top-level `function name(...) { ... }` in the IIFE.
function fnBody(name) {
  const re = new RegExp(`\\n  function ${name}\\s*\\(`);
  const m = re.exec(js);
  if (!m) return null;
  let i = js.indexOf('{', m.index);
  let depth = 0;
  for (; i < js.length; i++) {
    if (js[i] === '{') depth++;
    else if (js[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return js.slice(m.index, i);
}

// Comments in these functions mention innerHTML by name, so strip them first.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const declared = new Set();
for (const m of js.matchAll(/\n\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) declared.add(m[1]);
for (const m of js.matchAll(/\n\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) declared.add(m[1]);

/* ---------- 1. every function onKeyboard calls actually exists -------- */
section('Keyboard handler resolves every call');

const onKeyboard = fnBody('onKeyboard');
check('onKeyboard found in app.js', !!onKeyboard);

if (onKeyboard) {
  // Bare `name(` calls only. Method calls (Manager.open()) are skipped: the
  // object is checked separately by the declared-set below.
  const called = new Set();
  for (const m of onKeyboard.matchAll(/(?<![.\w$])([a-z][\w$]*)\s*\(/g)) called.add(m[1]);
  // Language constructs and browser globals that are not app functions.
  const builtins = new Set(['if', 'for', 'while', 'switch', 'return', 'typeof', 'catch', 'function']);
  const unresolved = [...called].filter(n => !builtins.has(n) && !declared.has(n));
  check('every function onKeyboard calls is declared in app.js', unresolved.length === 0,
    unresolved.length ? `undefined: ${unresolved.join(', ')}` : undefined);

  // The two that were genuinely missing. Named explicitly so a rename can't
  // quietly drop them.
  for (const fn of ['toggleShortcutHelp', 'closeTopmostOverlay']) {
    check(`${fn}() is defined`, declared.has(fn));
    check(`onKeyboard calls ${fn}()`, onKeyboard.includes(`${fn}(`));
  }
}

/* ---------- 2. the help overlay matches the real keymap --------------- */
section('Shortcut help matches the code');

// Keys the switch actually handles, e.g. `case 'm': case 'M':`
const handledKeys = new Set();
if (onKeyboard) {
  for (const m of onKeyboard.matchAll(/case\s+'([^']+)'/g)) handledKeys.add(m[1]);
}

// Keys the overlay advertises, from <kbd>…</kbd>
const helpBlock = (html.match(/<div class="shortcut-help-list">[\s\S]*?<\/div>\s*<button/) || [])[0] || '';
const advertised = [...helpBlock.matchAll(/<kbd>([^<]+)<\/kbd>/g)].map(m => m[1].trim());

check('help overlay exists in index.html', helpBlock.length > 0);
check('help overlay lists shortcuts', advertised.length >= 10, `found ${advertised.length}`);

// Map the human labels in the overlay onto the key literals in the switch.
const LABEL_TO_KEY = {
  'Space': ' ', '←': 'ArrowLeft', '→': 'ArrowRight', '↑': 'ArrowUp', '↓': 'ArrowDown',
  'Esc': 'Escape',
};
const asKey = (label) => LABEL_TO_KEY[label] || label.toLowerCase();

const wrong = advertised.filter(l => !handledKeys.has(asKey(l)));
check('every advertised shortcut is really handled', wrong.length === 0,
  wrong.length ? `not in onKeyboard: ${wrong.join(', ')}` : undefined);

// And the reverse: a handled key with no help row is a hidden feature.
const documented = new Set(advertised.map(asKey));
const undocumented = [...handledKeys].filter(k => k !== k.toUpperCase() || k.length > 1
  ? !documented.has(k)
  : false)
  // Uppercase duplicates ('M' alongside 'm') are the same shortcut.
  .filter(k => !documented.has(k.toLowerCase()));
check('every handled shortcut is documented', undocumented.length === 0,
  undocumented.length ? `missing from help: ${undocumented.map(k => JSON.stringify(k)).join(', ')}` : undefined);

/* ---------- 3. phone parity for controls hidden at <=640px ------------ */
section('Mobile reachability');

// The rules that hide desktop-only controls on phones.
// style.css has several 640px blocks, so join them all before searching.
const mobileBlock = [...css.matchAll(/@media \(max-width: 640px\)\s*\{[\s\S]*?\n\}/g)].map(m => m[0]).join('\n');
check('640px breakpoint found in style.css', mobileBlock.length > 0);
check('.np-right-controls is still hidden on phones (the reason the sheet exists)',
  /\.np-right-controls\s*\{\s*display:\s*none/.test(mobileBlock));

check('#npMoreBtn exists in the player bar', html.includes('id="npMoreBtn"'));
check('.np-more-btn is shown only at the mobile breakpoint',
  /\.np-more-btn\s*\{\s*display:\s*none/.test(css) && /\.np-more-btn\s*\{\s*display:\s*inline-flex/.test(mobileBlock));
check('#npMoreBtn is bound in app.js', /\$\('#npMoreBtn'\)\?\.addEventListener/.test(js));

// Each control the breakpoint hides needs a counterpart inside the sheet.
const sheetMarkup = (html.match(/<div class="mobile-sheet"[\s\S]*?<\/div>\s*<\/div>/) || [])[0] || '';
check('mobile sheet markup found', sheetMarkup.length > 0);

const PARITY = [
  ['Like', 'mobileLikeBtn'],
  ['Dislike', 'mobileDislikeBtn'],
  ['Shuffle', 'mobileShuffleBtn'],
  ['Repeat', 'mobileRepeatBtn'],
  ['Lyrics', 'mobileLyricsBtn'],
  ['Sleep timer', 'mobileSleepBtn'],
  ['Equalizer', 'mobileEqBtn'],
  ['Share', 'mobileShareBtn'],
  ['Download', 'mobileDownloadBtn'],
  ['Quality', 'mobileQualityBtn'],
  ['Mute', 'mobileMuteBtn'],
  ['Volume', 'mobileVolumeRange'],
];
for (const [label, id] of PARITY) {
  const inSheet = sheetMarkup.includes(`id="${id}"`);
  const bound = js.includes(`#${id}`);
  check(`${label} reachable on mobile (#${id})`, inSheet && bound,
    !inSheet ? 'not in the sheet' : 'in the sheet but never bound in app.js');
}

// Generic guard against the failure mode the sheet exists to prevent: any
// .np-*-btn the breakpoint hides must have a sheet counterpart. Catches the
// next hidden control too, not just today's list.
const HIDDEN_BTN_SHEET_COUNTERPART = { 'np-like-btn': 'mobileLikeBtn', 'np-dislike-btn': 'mobileDislikeBtn' };
for (const [cls, sheetId] of Object.entries(HIDDEN_BTN_SHEET_COUNTERPART)) {
  const hidden = new RegExp(`\\.${cls}\\s*\\{[^}]*display:\\s*none`).test(mobileBlock);
  check(`.${cls} hidden on phones has a sheet counterpart (#${sheetId})`,
    !hidden || sheetMarkup.includes(`id="${sheetId}"`),
    hidden ? 'hidden with no way in' : undefined);
}
check('.np-dislike-btn is hidden at the mobile breakpoint (sheet handles it)',
  /\.np-dislike-btn\s*\{[^}]*display:\s*none/.test(mobileBlock));

// A sheet button that is never state-reflected shows stale "off" forever.
// Match the active-class toggle *and* the state source: merely mentioning the id
// (e.g. in the disabled-guard list) is not reflection, and toggling on a
// constant would light up the wrong button.
const reflect = fnBody('reflectMobileSheetState') || '';
const REFLECTED = [
  ['mobileLikeBtn', 'isLiked\\(currentSong\\.id\\)'],
  ['mobileDislikeBtn', 'isDisliked\\(currentSong\\.id\\)'],
  ['mobileShuffleBtn', 'isShuffle'],
  ['mobileRepeatBtn', 'repeatMode'],
];
for (const [id, source] of REFLECTED) {
  check(`reflectMobileSheetState() reflects #${id} from real state`,
    new RegExp(`#${id}'\\)\\?\\.classList\\.toggle\\('active',[^;]*${source}`).test(reflect));
}
check('#mobileDislikeBtn is disabled when nothing is playing',
  /#mobileDislikeBtn'\][\s\S]{0,120}disabled = !currentSong/.test(js) ||
  /'#mobileLikeBtn', '#mobileDislikeBtn'\][\s\S]{0,120}disabled = !currentSong/.test(js));

// updateVolumeUI must drive the sheet's slider, or it shows a stale value.
check('updateVolumeUI() writes #mobileVolumeRange', /#mobileVolumeRange/.test(fnBody('updateVolumeUI') || ''));
// Volume must follow the finger, so 'input' not 'change'.
check("#mobileVolumeRange listens on 'input', not 'change'",
  /#mobileVolumeRange'\)\?\.addEventListener\('input'/.test(js));

/* ---------- 4. overlays can be dismissed ----------------------------- */
section('Overlays are dismissible');

const closeTop = fnBody('closeTopmostOverlay') || '';
check('closeTopmostOverlay handles modals', /modal-overlay/.test(closeTop));
check('closeTopmostOverlay handles the shortcut help', /ShortcutHelp/.test(closeTop));
check('closeTopmostOverlay handles the mobile sheet', /MobileSheet/.test(closeTop));
check('closeTopmostOverlay handles the queue and lyrics panels',
  /queueSidebar/.test(closeTop) && /lyricsPanel/.test(closeTop));

// Help is opened from inside Settings, so it must paint above .modal-overlay.
const zOf = (sel) => {
  const m = css.match(new RegExp(`${sel}\\s*\\{[^}]*z-index:\\s*(\\d+)`));
  return m ? Number(m[1]) : null;
};
const zHelp = zOf('\\.shortcut-help-overlay');
const zModal = zOf('\\.modal-overlay');
const zSheet = zOf('\\.mobile-sheet-overlay');
check('help overlay stacks above modals', zHelp !== null && zModal !== null && zHelp > zModal,
  `help=${zHelp} modal=${zModal}`);
check('mobile sheet stacks below modals (its buttons open them)',
  zSheet !== null && zModal !== null && zSheet < zModal, `sheet=${zSheet} modal=${zModal}`);
check('backdrop click closes the sheet only when the backdrop is the target',
  /e\.target === \$\('#mobileSheetOverlay'\)/.test(js));

/* ---------- 5. settings actually persist ------------------------------ */
section('Settings survive a reload');

const eqInit = js.slice(js.indexOf('const EqualizerManager'));
check('EQ writes its state to storage', /Storage\.set\('eqState'/.test(eqInit));
check('EQ restores its state on load', /Storage\.get\('eqState'/.test(eqInit));
check('restoreUI() is called from EqualizerManager.init()', /this\.restoreUI\(\);/.test(eqInit));
// The saved curve is meaningless unless it reaches the filter nodes.
check('saved gains are pushed into the audio graph when it is built',
  /this\.applyStoredToGraph\(\);/.test(eqInit) && /applyStoredToGraph\(\)\s*\{/.test(eqInit));
// restoreUI must not build an AudioContext: outside a user gesture it starts
// suspended, and attaching one to a cross-origin stream kills playback for good.
const restoreUI = (eqInit.match(/restoreUI\(\)\s*\{[\s\S]*?\n    \},/) || [])[0] || '';
check('restoreUI() does not create the audio graph', restoreUI.length > 0 && !/ensureAudioContext/.test(restoreUI));

for (const [label, key] of [['bass boost', 'bass'], ['spatial audio', 'spatial'], ['preset', 'preset']]) {
  check(`${label} is included in the saved state`, new RegExp(`${key}:`).test(eqInit));
}

check('auto-queue setting is persisted', /Storage\.set\('autoQueue'/.test(js));
check('auto-queue setting is restored', /Storage\.get\('autoQueue'/.test(js));
check('quality dropdown is initialised from the stored value',
  /\$\('#settingQuality'\)\.value = audioQuality/.test(js));

// Crossfade: a settings control that is never bound is the dangling-handler bug
// this file exists to catch — the slider moves, the label lies, nothing fades.
check('#settingCrossfade exists in Settings', html.includes('id="settingCrossfade"'));
check('#crossfadeValLabel exists next to it', html.includes('id="crossfadeValLabel"'));
check('the crossfade slider is range-bounded to 0–3 in the markup',
  /id="settingCrossfade"[^>]*min="0"[^>]*max="3"/.test(html));
check('#settingCrossfade is bound in app.js', /#settingCrossfade'\)/.test(js));
// 'change' only fires on release, so the label would lag the thumb.
check("#settingCrossfade listens on 'input', not 'change'",
  /addEventListener\('input', \(e\) => this\.set\(e\.target\.value\)\)/.test(js));
check('crossfade duration is persisted', /Storage\.set\('crossfade'/.test(js));
check('crossfade duration is restored', /Storage\.get\('crossfade'/.test(js));
check('CrossfadeManager.init() is called from init()', /CrossfadeManager\.init\(\)/.test(fnBody('init') || ''));
// Four hook points. A missing one is silent: the fade just never starts, never
// ends, or strands the volume at zero behind a full-looking slider.
for (const [hook, where] of [
  ['tick', 'onTimeUpdate'],
  ['onTrackStart', 'playSong'],
]) {
  check(`CrossfadeManager.${hook}() is called from ${where}()`,
    new RegExp(`CrossfadeManager\\.${hook}\\(`).test(fnBody(where) || ''));
}
for (const [hook, evt] of [['onPause', 'pause'], ['onPlay', 'play']]) {
  check(`CrossfadeManager.${hook}() is wired to the audio '${evt}' event`,
    new RegExp(`addEventListener\\('${evt}',[^\\n]*CrossfadeManager\\.${hook}\\(\\)`).test(js));
}
// A fade must never be the last writer of the element volume.
check('unmuting restores the element volume (a fade can leave it at zero)',
  /if \(!audioPlayer\.muted\) audioPlayer\.volume = volume;/.test(fnBody('toggleMute') || ''));
check('the crossfade slider is styled (.crossfade-control)', /\.crossfade-control\s*\{/.test(css));

/* ---------- 5b. no rule silently discarded by a missing variable ------ */
section('Every CSS variable used is defined');

// An undefined custom property does not fall back to nothing — it invalidates
// the whole declaration, so a typo'd var() silently drops the rule and the
// control renders unstyled. Nothing in the browser reports this.
//
// A var() is safe if EITHER it carries a fallback — var(--x, #fff) — OR the
// variable is defined somewhere it can apply: the stylesheet, an inline style=""
// (element-scoped vars like the genre/mood cards), or a JS setProperty call.
const definedVars = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
for (const m of html.matchAll(/style="([^"]*)"/g)) {
  for (const v of m[1].matchAll(/(--[\w-]+)\s*:/g)) definedVars.add(v[1]);
}
for (const m of js.matchAll(/setProperty\(\s*['"](--[\w-]+)['"]/g)) definedVars.add(m[1]);

// Only var() WITHOUT a fallback can drop a rule. var(--x, ...) is always safe.
const usedNoFallback = new Set();
for (const m of css.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
  if (m[2] === ')') usedNoFallback.add(m[1]);   // no fallback argument
}
const undefinedVars = [...usedNoFallback].filter(v => !definedVars.has(v));
check('no fallback-less var() references an undefined custom property', undefinedVars.length === 0,
  undefinedVars.length ? `undefined: ${undefinedVars.join(', ')}` : undefined);

/* ---------- 6. library filter ---------------------------------------- */
section('Library filter');

check('#libraryFilterInput exists', html.includes('id="libraryFilterInput"'));
check('filter is bound', /bindLibraryFilter\(\)/.test(js));
check('filter searches playlists, liked songs and local files',
  /collectLibrarySongs/.test(js) && /LocalFileManager\.localSongs/.test(fnBody('collectLibrarySongs') || ''));
check('filter dedupes songs that appear in several places',
  /seen\.has\(s\.id\)/.test(fnBody('collectLibrarySongs') || ''));
check('filter input is debounced', /libraryFilterTimer/.test(js));

const applyFilter = stripComments(fnBody('applyLibraryFilter') || '');
check('applyLibraryFilter found', applyFilter.length > 0);
// The query is user input. innerHTML with it interpolated would be an XSS hole.
check('the query never reaches innerHTML', !/innerHTML\s*=\s*[`'"][^`'"]*\$\{(?:q|libraryFilterQuery)/.test(applyFilter));
check('status line and empty message use textContent', /\.textContent =/.test(applyFilter));
check('clearing the filter restores every playlist card',
  /style\.display = ''/.test(applyFilter) && /clearLibraryFilter/.test(js));

/* ---------- 7. local files are reachable ----------------------------- */
section('Imported local files are visible');

check('#localSongsSection exists in the Library page', html.includes('id="localSongsSection"'));
check('renderLocalSongs() exists', declared.has('renderLocalSongs'));
check('renderLibrary() renders local files', /renderLocalSongs\(\)/.test(fnBody('renderLibrary') || ''));
// pruneOrphans is async, so rendering before it settles shows pruned ghosts.
check('the list is re-rendered after pruneOrphans() settles',
  /pruneOrphans[\s\S]{0,1600}?renderLocalSongs\(\);\n    \},/.test(js));
check('importing files refreshes the section', /renderLocalSongs\(\);[\s\S]{0,200}?Added \$\{added\.length\}/.test(js)
  || /Added \$\{added\.length\}[\s\S]{0,200}?renderLocalSongs\(\)/.test(js)
  || /updateQueueUI\(\);\s*\n\s*renderLocalSongs\(\);/.test(js));

/* ---------- 8. untrusted strings ------------------------------------- */
section('Untrusted text is escaped');

const reflectSheet = stripComments(fnBody('reflectMobileSheetState') || '');
check('the sheet title uses textContent, not innerHTML',
  /title\.textContent =/.test(reflectSheet) && !/innerHTML/.test(reflectSheet));

/* ---------- 9. state reads match how the state is written ------------- */
section('Sheet reads the state the code actually writes');

/*
 * reflectMobileSheetState() mirrors player state onto the sheet's buttons. Each
 * mirror is a *read* of some other element, and this codebase uses two different
 * conventions for "this thing is on": the queue badge toggles a `visible` class,
 * the sleep badge writes style.display. Reading the wrong one is silent — the
 * button just never lights up, which is exactly what shipped: the sleep row
 * checked .classList.contains('visible') on a badge only ever driven by
 * style.display, so it was dead code.
 *
 * So: for every element the sheet reads, work out how the rest of app.js writes
 * that element, and require the two to agree.
 */

// How is this element manipulated at `at`? Follow `const x = $('#id')` aliases,
// otherwise read whatever is chained directly onto the lookup.
function mechanismsAt(src, at, id) {
  const lookup = `$('#${id}')`;
  const lineStart = src.lastIndexOf('\n', at) + 1;
  const decl = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(src.slice(lineStart, at));
  const found = new Set();
  if (decl) {
    // Aliased. Only look at uses of that exact name, and only nearby — a wider
    // window picks up unrelated `.classList` calls on other elements.
    const name = decl[1];
    const win = src.slice(at, at + 400);
    for (const m of win.matchAll(new RegExp(`\\b${name}\\s*\\.\\s*(style\\.display|classList)`, 'g'))) {
      found.add(m[1] === 'classList' ? 'classList' : 'display');
    }
  } else {
    const tail = src.slice(at + lookup.length, at + lookup.length + 40);
    if (/^\s*\??\.\s*classList/.test(tail)) found.add('classList');
    if (/^\s*\??\.\s*style\.display/.test(tail)) found.add('display');
  }
  return found;
}

function occurrences(src, id) {
  const lookup = `$('#${id}')`;
  const out = [];
  for (let i = src.indexOf(lookup); i !== -1; i = src.indexOf(lookup, i + 1)) out.push(i);
  return out;
}

// The state reads inside the sheet, as [id, mechanism the sheet uses].
const stateReads = [];
for (const m of reflectSheet.matchAll(/\$\('#([\w-]+)'\)\??\.classList\.contains\(/g)) {
  stateReads.push([m[1], 'classList']);
}
for (const m of reflectSheet.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\$\('#([\w-]+)'\)/g)) {
  const [, name, id] = m;
  if (new RegExp(`\\b${name}\\.style\\.display\\s*[!=]==`).test(reflectSheet)) stateReads.push([id, 'display']);
  if (new RegExp(`\\b${name}\\.classList\\.contains\\(`).test(reflectSheet)) stateReads.push([id, 'classList']);
}

check('the sheet reads at least two pieces of external state', stateReads.length >= 2,
  `found ${stateReads.length}`);

// Writes live outside reflectMobileSheetState, so search app.js with it removed.
const jsWithoutReflect = js.replace(fnBody('reflectMobileSheetState') || ' ', '');

for (const [id, readAs] of stateReads) {
  const writes = new Set();
  for (const at of occurrences(jsWithoutReflect, id)) {
    for (const mech of mechanismsAt(jsWithoutReflect, at, id)) writes.add(mech);
  }
  check(`#${id} is read the same way it is written (sheet reads ${readAs})`,
    writes.size === 0 || writes.has(readAs),
    `app.js drives #${id} via ${[...writes].join(' + ') || 'nothing'}`);
}

// Named explicitly: this is the one that was actually wrong.
check('the sleep button reads #sleepBadge via style.display, not a class',
  /sleepBadge/.test(reflectSheet) && !/sleepBadge'\)\??\.classList/.test(reflectSheet)
  && /style\.display !== 'none'/.test(reflectSheet));

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
