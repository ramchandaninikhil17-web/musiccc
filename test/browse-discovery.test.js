#!/usr/bin/env node
/*
 * Browse & discovery: the tabbed browse section (Mood / Genre / Activity /
 * Language) and the quick-access recent-search pills that now appear on the home
 * page as well as the search page.
 *
 * Two halves:
 *
 *   1. Static. The tab buttons and the panels they reveal live in index.html and
 *      are matched to each other *bidirectionally* against BROWSE_KINDS in
 *      app.js. A tab with no panel is a dead button; a panel with no tab is
 *      content nobody can reach. Neither shows up as an error anywhere.
 *
 *   2. Behavioural. The real BrowseTabs object and the real renderSearchHistory
 *      are pulled out of app.js and run against stubs *built from the real
 *      markup*, so a data-attribute typo (data-browse="lang" against a
 *      BROWSE_KINDS entry of "language") fails here instead of silently leaving
 *      a tab that does nothing.
 *
 * The specific bug this guards: show() hides every panel and then shows the one
 * matching `kind`. If `kind` is unrecognised — a stale value in localStorage from
 * an older build — the naive version hides all four and the browse section
 * renders as an empty gap under its own heading.
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

const browseSrc = extract(/\n  const BrowseTabs = \{/);
const showSrc = /show\(kind\)\s*\{[\s\S]*?\n    \},/.exec(browseSrc);
const code = [
  extractArray(/\n  const BROWSE_KINDS = \[/),
  extractArray(/\n  const HISTORY_TARGETS = \[/),
  extract(/\n  function esc\s*\(/),
  browseSrc,
  extract(/\n  function renderSearchHistory\s*\(/),
].join('\n\n');
console.log(`Extracted BrowseTabs + renderSearchHistory + constants (${code.split('\n').length} lines) from app.js\n`);

/* ---------- markup readers ------------------------------------------- */
function tagsWithClass(tag, cls, scope) {
  const out = [];
  const re = new RegExp('<' + tag + '\\s([^>]*)>', 'g');
  let m;
  while ((m = re.exec(scope))) {
    const attrs = m[1];
    const cm = /class="([^"]*)"/.exec(attrs);
    if (!cm || cm[1].split(/\s+/).indexOf(cls) < 0) continue;
    out.push({
      attrs,
      classes: cm[1].split(/\s+/).filter(Boolean),
      get(n) { const x = new RegExp(n + '="([^"]*)"').exec(attrs); return x ? x[1] : undefined; },
    });
  }
  return out;
}

// The browse section only, so cards elsewhere on the page can't skew the counts.
const browseStart = html.indexOf('id="browseSection"');
const browseHtml = browseStart < 0 ? '' : html.slice(browseStart, html.indexOf('</section>', browseStart));

function classList(seed) {
  const s = new Set(seed || []);
  return {
    add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c),
    toggle: (c, on) => { if (on === undefined) { s.has(c) ? s.delete(c) : s.add(c); } else if (on) s.add(c); else s.delete(c); return s.has(c); },
  };
}

/* ---------- stubs built from the real markup ------------------------- */
let tabs = [];
let panels = [];
let listeners = [];      // every handler init() binds on the strip
let setLocalCalls = [];
let setCalls = [];
let stored = 'mood';

function buildFromMarkup() {
  tabs = tagsWithClass('button', 'browse-tab', browseHtml).map((raw) => {
    const el = {
      dataset: { browse: raw.get('data-browse') },
      classList: classList(raw.classes),
      _attrs: { 'aria-selected': raw.get('aria-selected') },
      setAttribute(k, v) { this._attrs[k] = v; },
    };
    el.closest = (sel) => (sel === '.browse-tab' ? el : null);
    return el;
  });
  panels = tagsWithClass('div', 'browse-panel', browseHtml).map((raw) => ({
    dataset: { browsePanel: raw.get('data-browse-panel') },
    style: { display: /display:\s*none/.test(raw.get('style') || '') ? 'none' : '' },
  }));
}
buildFromMarkup();

const activeTabs = () => tabs.filter(t => t.classList.contains('active')).map(t => t.dataset.browse);
const shownPanels = () => panels.filter(p => p.style.display !== 'none').map(p => p.dataset.browsePanel);

/* ---------- history containers --------------------------------------- */
function containerStub() {
  return { innerHTML: '', style: { display: '' }, addEventListener() {} };
}
let els = {};
function resetEls(opts) {
  els = {
    '#browseTabs': { addEventListener(type, fn) { listeners.push({ type, fn }); } },
    '#searchHistorySection': containerStub(),
    '#searchHistoryTags': containerStub(),
  };
  if (!opts || !opts.noHome) {
    els['#homeHistorySection'] = containerStub();
    els['#homeHistoryTags'] = containerStub();
  }
}
resetEls();

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

const sandbox = {
  console,
  document: documentStub,
  searchHistory: [],
  $: (sel) => els[sel] || null,
  $$: (sel) => (sel === '.browse-tab' ? tabs : sel === '.browse-panel' ? panels : []),
  Storage: {
    get: (key, fallback) => (key === 'browse_tab' ? stored : fallback),
    set: (key, val) => setCalls.push({ key, val }),
    setLocal: (key, val) => setLocalCalls.push({ key, val }),
  },
};
const ctx = vm.createContext(sandbox);
vm.runInContext(code + '\n;globalThis.__x = { BrowseTabs, BROWSE_KINDS, HISTORY_TARGETS, renderSearchHistory, esc };', ctx);
const X = sandbox.__x;
const B = X.BrowseTabs;

function reset(opts) {
  buildFromMarkup();
  listeners = []; setLocalCalls = []; setCalls = [];
  resetEls(opts);
  sandbox.searchHistory = [];
}

/* =====================================================================
   1. the markup and the code agree on the four kinds
   ===================================================================== */
section('Browse markup');
check('#browseSection exists in index.html', browseStart >= 0);
check('BROWSE_KINDS is mood/genre/activity/language',
  X.BROWSE_KINDS.join(',') === 'mood,genre,activity,language', X.BROWSE_KINDS.join(','));

const tabKinds = tabs.map(t => t.dataset.browse);
const panelKinds = panels.map(p => p.dataset.browsePanel);
check('there is one tab button per kind',
  tabKinds.slice().sort().join(',') === X.BROWSE_KINDS.slice().sort().join(','), tabKinds.join(','));
check('there is one panel per kind (no tab that reveals nothing)',
  panelKinds.slice().sort().join(',') === X.BROWSE_KINDS.slice().sort().join(','), panelKinds.join(','));
check('every kind is reachable (no panel without a tab)',
  panelKinds.every(k => tabKinds.indexOf(k) >= 0));
check('tabs are real buttons with type=button, so they cannot submit anything',
  tagsWithClass('button', 'browse-tab', browseHtml).every(r => r.get('type') === 'button'));

/* the page must open in a consistent state without JS having run */
check('exactly one tab starts active in the markup', activeTabs().length === 1, activeTabs().join(','));
check('exactly one panel starts visible in the markup', shownPanels().length === 1, shownPanels().join(','));
check('the tab that starts active matches the panel that starts visible',
  activeTabs()[0] === shownPanels()[0], `${activeTabs()[0]} vs ${shownPanels()[0]}`);
check('the initially active tab is marked aria-selected=true',
  tabs.find(t => t.classList.contains('active'))._attrs['aria-selected'] === 'true');

/* ---- the cards themselves ---- */
const cards = tagsWithClass('div', 'genre-card', browseHtml);
check('all four grids of cards are present', cards.length === 32, String(cards.length));
check('every browse card carries a non-empty data-query',
  cards.every(c => (c.get('data-query') || '').trim().length > 0));
const queries = cards.map(c => c.get('data-query'));
check('no two cards search for the same thing',
  new Set(queries).size === queries.length,
  queries.filter((q, i) => queries.indexOf(q) !== i).join(' | '));
// Slice out just the Activity panel: from its marker to wherever the next panel
// begins. Anything found inside really is inside that panel.
const actStart = browseHtml.indexOf('data-browse-panel="activity"');
const nextPanel = browseHtml.indexOf('data-browse-panel=', actStart + 1);
const activityHtml = actStart < 0 ? '' : browseHtml.slice(actStart, nextPanel < 0 ? browseHtml.length : nextPanel);
check('the Activity panel is the one holding #activityGrid',
  activityHtml.indexOf('id="activityGrid"') >= 0);
check('the Activity grid has a full row of eight tiles',
  tagsWithClass('div', 'genre-card', activityHtml).length === 8,
  String(tagsWithClass('div', 'genre-card', activityHtml).length));

/* =====================================================================
   2. stylesheet — an undefined custom property kills the whole rule
   ===================================================================== */
section('Browse tab styling');
for (const sel of ['.browse-tabs', '.browse-tab', '.browse-tab.active', '.browse-panel']) {
  check(`${sel} has a rule in style.css`, css.indexOf(sel + ' ') >= 0 || css.indexOf(sel + '{') >= 0 || css.indexOf(sel + ',') >= 0);
}
// Every var() the new rules lean on must actually be declared somewhere, or the
// declaration containing it is dropped and the tabs render as bare text.
const browseCss = css.slice(css.indexOf('.browse-tabs'), css.indexOf('.browse-panel') + 200);
const varsUsed = [...new Set([...browseCss.matchAll(/var\((--[\w-]+)/g)].map(m => m[1]))];
check('the browse rules use custom properties at all', varsUsed.length > 0);
for (const v of varsUsed) {
  check(`${v} is declared in style.css`, new RegExp('\\s' + v + '\\s*:').test(css));
}
check('.browse-tab.active is a real selector, not only a base rule',
  /\.browse-tab\.active\s*\{/.test(css));
// Failure mode 4: something hidden at phone widths with no other way in. The
// tabs are the *only* way to reach three of the four card sets now, so a
// display:none on them at a breakpoint would strand 24 tiles.
const hidesBrowse = [...css.matchAll(/\.(browse-tabs|browse-tab|browse-panel)[^{]*\{([^}]*)\}/g)]
  .filter(m => /display\s*:\s*none/.test(m[2]));
check('nothing in the stylesheet hides the tabs or panels outright',
  hidesBrowse.length === 0, hidesBrowse.map(m => m[1]).join(','));
check('the tab strip wraps, so it cannot overflow a narrow header',
  /\.browse-tabs\s*\{[^}]*flex-wrap:\s*wrap/.test(css));
check('the section header wraps too, so the tabs drop below the title on phones',
  /\.section-header\s*\{[^}]*flex-wrap:\s*wrap/.test(css));

/* =====================================================================
   3. show() — one tab and one panel, always
   ===================================================================== */
section('Switching tabs');
reset();
B.show('genre');
check('show() activates only the requested tab', activeTabs().join(',') === 'genre');
check('show() reveals only the matching panel', shownPanels().join(',') === 'genre');
check('aria-selected is true on the active tab only',
  tabs.filter(t => t._attrs['aria-selected'] === 'true').map(t => t.dataset.browse).join(',') === 'genre');
check('the other tabs are explicitly aria-selected=false',
  tabs.filter(t => t.dataset.browse !== 'genre').every(t => t._attrs['aria-selected'] === 'false'));

B.show('activity');
check('switching again leaves exactly one panel visible', shownPanels().join(',') === 'activity');
check('the previous tab loses the active class', activeTabs().join(',') === 'activity');

/* the guard: an unknown kind must not blank the section */
B.show('lang');   // plausible typo for "language"
check('an unrecognised kind is a no-op, not four hidden panels', shownPanels().join(',') === 'activity');
B.show(undefined);
check('show(undefined) leaves the visible panel alone', shownPanels().join(',') === 'activity');
check('show(undefined) leaves the active tab alone', activeTabs().join(',') === 'activity');

/* persistence: local only, no server round trip for a UI preference */
reset();
B.show('language');
check('the chosen tab is remembered', setLocalCalls.some(c => c.key === 'browse_tab' && c.val === 'language'));
check('remembering the tab does not POST to the server',
  setCalls.length === 0, JSON.stringify(setCalls));

/* =====================================================================
   4. init() — restore, fall back, and bind exactly once
   ===================================================================== */
section('Restoring the last tab');
reset(); stored = 'activity';
B.init();
check('a stored tab is restored on load', activeTabs().join(',') === 'activity');
check('exactly one panel is visible after restoring', shownPanels().length === 1);

reset(); stored = 'not-a-tab';
// Nudge the section off its markup default first. Otherwise "still shows mood"
// is indistinguishable from "the fallback ran" — show() rejects the bad kind on
// its own, so init() could skip the fallback entirely and this would still pass.
B.show('language');
setLocalCalls = [];
B.init();
check('a corrupt stored value actively restores mood', activeTabs().join(',') === 'mood',
  activeTabs().join(','));
check('the fallback still leaves one panel visible', shownPanels().join(',') === 'mood');
check('the fallback is written back, so the bad value cannot persist',
  setLocalCalls.some(c => c.key === 'browse_tab' && c.val === 'mood'),
  JSON.stringify(setLocalCalls));

reset(); stored = null;
B.show('genre');
B.init();
check('a null stored value falls back to mood', activeTabs().join(',') === 'mood');

reset(); stored = 'mood';
B.init();
check('init() binds exactly one listener on the strip', listeners.length === 1, String(listeners.length));
check('it is a click listener', listeners[0] && listeners[0].type === 'click');

// drive the real handler
const fire = (target) => listeners[0].fn({ target });
fire(tabs.find(t => t.dataset.browse === 'genre'));
check('clicking a tab switches to it', shownPanels().join(',') === 'genre');
const inert = { closest: () => null };
fire(inert);
check('clicking the strip padding changes nothing', shownPanels().join(',') === 'genre');
check('a second init() would not double-bind because init is called once from init()',
  (src.match(/BrowseTabs\.init\(\)/g) || []).length === 1);

/* the panels are hidden with style.display in both places — mixing a class in
   one and a style in the other is how state reads and writes drift apart */
check('show() writes visibility via style.display', /style\.display\s*=/.test(showSrc ? showSrc[0] : ''));
check('the markup also hides panels with an inline style, matching show()',
  /data-browse-panel="genre"[^>]*style="display:none;?"/.test(browseHtml));

/* =====================================================================
   5. quick-access search history, on both pages
   ===================================================================== */
section('Recent-search pills');
check('the home page has its own history section and pill row',
  html.indexOf('id="homeHistorySection"') >= 0 && html.indexOf('id="homeHistoryTags"') >= 0);
check('it starts hidden so a fresh install shows no empty row',
  /id="homeHistorySection"[^>]*style="display:none;?"/.test(html));
check('one renderer paints both places',
  X.HISTORY_TARGETS.length === 2
  && X.HISTORY_TARGETS.some(t => t[1] === '#searchHistoryTags')
  && X.HISTORY_TARGETS.some(t => t[1] === '#homeHistoryTags'));

reset();
sandbox.searchHistory = ['arijit singh', 'lofi beats'];
X.renderSearchHistory();
check('the search page row is shown', els['#searchHistorySection'].style.display === '');
check('the home row is shown too', els['#homeHistorySection'].style.display === '');
check('both rows hold the same pills',
  els['#searchHistoryTags'].innerHTML === els['#homeHistoryTags'].innerHTML);
check('a pill carries its query',
  els['#homeHistoryTags'].innerHTML.indexOf('data-query="lofi beats"') >= 0);
check('pills are buttons of class history-tag',
  (els['#homeHistoryTags'].innerHTML.match(/class="history-tag"/g) || []).length === 2);

reset();
sandbox.searchHistory = Array.from({ length: 30 }, (_, i) => 'q' + i);
X.renderSearchHistory();
check('the row is capped at 12 pills',
  (els['#homeHistoryTags'].innerHTML.match(/class="history-tag"/g) || []).length === 12);
check('the newest query is included', els['#homeHistoryTags'].innerHTML.indexOf('>q0<') >= 0);

reset();
sandbox.searchHistory = ['something'];
X.renderSearchHistory();
sandbox.searchHistory = [];
X.renderSearchHistory();
check('an empty history hides the search row', els['#searchHistorySection'].style.display === 'none');
check('an empty history hides the home row', els['#homeHistorySection'].style.display === 'none');
check('Clear also empties the pills, so they cannot come back on the next show',
  els['#searchHistoryTags'].innerHTML === '' && els['#homeHistoryTags'].innerHTML === '');

/* a hostile query reaches this markup straight from the search box */
reset();
sandbox.searchHistory = ['<img src=x onerror=alert(1)>', 'he said "hi" & left'];
X.renderSearchHistory();
const painted = els['#homeHistoryTags'].innerHTML;
check('a script-ish query cannot open a tag', painted.indexOf('<img') < 0);
check('a quote cannot break out of data-query', /data-query="he said &quot;hi&quot; &amp; left"/.test(painted));

/* the home markup is optional as far as this renderer is concerned */
reset({ noHome: true });
sandbox.searchHistory = ['still works'];
let threw = null;
try { X.renderSearchHistory(); } catch (e) { threw = e; }
check('missing home markup does not throw', threw === null, threw && threw.message);
check('and the search page is still painted',
  els['#searchHistoryTags'].innerHTML.indexOf('still works') >= 0);

/* =====================================================================
   6. wiring that only exists in app.js
   ===================================================================== */
section('Wiring');
check('both Clear buttons are bound',
  src.indexOf("$('#clearSearchHistory')") >= 0 && src.indexOf("$('#clearHomeHistory')") >= 0);
check('pill clicks are delegated per container, not bound per pill',
  src.indexOf("querySelectorAll('.history-tag')") < 0
  && /closest\('\.history-tag'\)/.test(src));
check('browse cards are delegated too, not 32 individual handlers',
  src.indexOf("$$('.genre-card')") < 0 && /closest\('\.genre-card'\)/.test(src));
check('a card click routes to the search page before searching',
  /closest\('\.genre-card'\)[\s\S]{0,400}navigateTo\('search'\)[\s\S]{0,120}doSearch\(/.test(src));
check('the home page renders the pills when it is opened',
  /function renderHomePage\(\)[\s\S]*?renderSearchHistory\(\)/.test(src));
check('a new search refreshes the pills after adding to history',
  /Storage\.set\('searchHistory', searchHistory\);[\s\S]{0,300}renderSearchHistory\(\)/.test(src));

console.log(`\n${failures ? `${failures} failure(s)` : 'OK — 0 failure(s)'}`);
process.exit(failures ? 1 : 0);
