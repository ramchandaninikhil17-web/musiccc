/* ================================================================
   MusicFlow v3.0 — Complete App Logic
   ================================================================ */

(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  /* ================================================================
     STORAGE MANAGER WITH DISK & LOCAL DUAL PERSISTENCE
     ================================================================ */
  let syncTimeout = null;
  let pendingSync = {};
  let syncInFlight = null;

  const Storage = {
    get(key, fallback) {
      try { const v = localStorage.getItem('mf_' + key); return v !== null ? JSON.parse(v) : fallback; }
      catch { return fallback; }
    },
    set(key, val) {
      try { localStorage.setItem('mf_' + key, JSON.stringify(val)); }
      catch (e) {
        // Quota exceeded is the common case; the value still lives in memory
        // and will be pushed to the server, so keep going but say so once.
        console.warn('[storage] could not write', key, e && e.name);
      }

      // Auto sync to server disk database
      pendingSync[key] = val;
      clearTimeout(syncTimeout);
      syncTimeout = setTimeout(() => { Storage.flush(); }, 500);
    },
    // Device-local only, never synced. The playback resume point is rewritten
    // every few seconds while music plays; routing it through set() would mean
    // a POST to /api/user-data every 5 seconds for a value the server has no
    // use for.
    setLocal(key, val) {
      try { localStorage.setItem('mf_' + key, JSON.stringify(val)); }
      catch (e) { console.warn('[storage] could not write', key, e && e.name); }
    },
    flush() {
      const keys = Object.keys(pendingSync);
      if (!keys.length) return Promise.resolve();

      // Hand the batch off and clear it immediately. The old code kept every
      // value it had ever seen in pendingSync and resent the whole thing on
      // each flush, so a stale snapshot could clobber a newer server value.
      const batch = pendingSync;
      pendingSync = {};

      const send = () => fetch('/api/user-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch)
      }).then(res => {
        if (!res.ok) throw new Error(`sync failed: ${res.status}`);
      }).catch(err => {
        // Re-queue only keys that have not been superseded since, so a retry
        // can never overwrite a fresher value.
        Object.keys(batch).forEach(k => {
          if (!(k in pendingSync)) pendingSync[k] = batch[k];
        });
        console.warn('[storage]', err && err.message);
      });

      // Serialize requests so two in-flight POSTs cannot land out of order.
      syncInFlight = (syncInFlight || Promise.resolve()).then(send, send);
      return syncInFlight;
    },
    remove(key) {
      try { localStorage.removeItem('mf_' + key); } catch {}
      pendingSync[key] = null;
      clearTimeout(syncTimeout);
      syncTimeout = setTimeout(() => { Storage.flush(); }, 500);
    },
    // A normal fetch is cancelled when the page goes away, so anything still
    // queued at teardown (including the listen time for the current track) was
    // silently dropped.
    flushBeacon() {
      if (!Object.keys(pendingSync).length) return;
      const batch = pendingSync;
      pendingSync = {};
      clearTimeout(syncTimeout);
      const body = JSON.stringify(batch);
      try {
        const blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon && navigator.sendBeacon('/api/user-data', blob)) return;
      } catch (e) {}
      try {
        fetch('/api/user-data', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true
        }).catch(() => {});
      } catch (e) {}
    },
    async syncFromServer() {
      try {
        const res = await fetch('/api/user-data');
        if (!res.ok) return;
        const serverData = await res.json();
        if (!serverData) return;

        let needsUpdate = false;

        if (serverData.likes && Array.isArray(serverData.likes) && serverData.likes.length > 0) {
          const localLikes = Storage.get('likes', []);
          const map = new Map();
          [...serverData.likes, ...localLikes].forEach(s => { if (s && s.id) map.set(s.id, s); });
          likedSongs = Array.from(map.values());
          localStorage.setItem('mf_likes', JSON.stringify(likedSongs));
          needsUpdate = true;
        }

        if (serverData.playlists && Array.isArray(serverData.playlists) && serverData.playlists.length > 0) {
          const localPls = Storage.get('playlists', []);
          const plMap = new Map();
          [...serverData.playlists, ...localPls].forEach(p => { if (p && p.id) plMap.set(p.id, p); });
          playlists = Array.from(plMap.values());
          localStorage.setItem('mf_playlists', JSON.stringify(playlists));
          needsUpdate = true;
        }

        if (serverData.history && Array.isArray(serverData.history) && serverData.history.length > 0) {
          const localHist = Storage.get('history', []);
          const histMap = new Map();
          [...serverData.history, ...localHist].forEach(h => {
            if (h && h.song && h.song.id) {
              const k = h.song.id + '_' + (h.playedAt || '');
              if (!histMap.has(k)) histMap.set(k, h);
            }
          });
          history = Array.from(histMap.values());
          // Map insertion order is server-then-local, not chronological. Without
          // this sort "Recently Played" and the resume fallback (hist[0]) pick an
          // essentially arbitrary track after a sync.
          history.sort((a, b) => new Date(b.playedAt || 0) - new Date(a.playedAt || 0));
          // The merge replaces the array, so the entry the listening clock was
          // pointing at is usually gone. Re-attach it by identity if it survived,
          // otherwise by song+timestamp, so the current track keeps accruing time.
          if (activeHistoryEntry && history.indexOf(activeHistoryEntry) === -1) {
            const same = history.find(h => h.song && activeHistoryEntry.song
              && h.song.id === activeHistoryEntry.song.id
              && h.playedAt === activeHistoryEntry.playedAt);
            if (same) { same.listenedSec = Math.max(same.listenedSec || 0, activeHistoryEntry.listenedSec || 0); activeHistoryEntry = same; }
            else { history.unshift(activeHistoryEntry); }
          }
          localStorage.setItem('mf_history', JSON.stringify(history));
          needsUpdate = true;
        }

        if (serverData.searchHistory && Array.isArray(serverData.searchHistory) && serverData.searchHistory.length > 0) {
          const localSh = Storage.get('searchHistory', []);
          const set = new Set([...serverData.searchHistory, ...localSh]);
          searchHistory = Array.from(set);
          localStorage.setItem('mf_searchHistory', JSON.stringify(searchHistory));
          needsUpdate = true;
        }

        if (serverData.dislikes && Array.isArray(serverData.dislikes) && serverData.dislikes.length > 0) {
          const localDis = Storage.get('dislikes', []);
          const dmap = new Map();
          [...serverData.dislikes, ...localDis].forEach(s => { if (s && s.id) dmap.set(s.id, s); });
          dislikedSongs = Array.from(dmap.values());
          // A track cannot be both. Local likes win, because a like is a more
          // deliberate action than whatever an older device recorded.
          dislikedSongs = dislikedSongs.filter(s => !isLiked(s.id));
          localStorage.setItem('mf_dislikes', JSON.stringify(dislikedSongs));
          needsUpdate = true;
        }

        if (serverData.playCounts && typeof serverData.playCounts === 'object' && !Array.isArray(serverData.playCounts)) {
          // Counts are per-device tallies of the same listening, so the merge takes
          // the max rather than summing — summing would double-count every play
          // that had already been synced to both sides.
          const merged = Object.assign({}, playCounts);
          Object.keys(serverData.playCounts).forEach(id => {
            const n = Math.floor(Number(serverData.playCounts[id]));
            if (id && Number.isFinite(n) && n > 0) merged[id] = Math.max(merged[id] || 0, n);
          });
          playCounts = merged;
          localStorage.setItem('mf_playCounts', JSON.stringify(playCounts));
          needsUpdate = true;
        }

        if (needsUpdate) {
          updateLikeBtn();
          if (pages.library && pages.library.style.display !== 'none') renderLibrary();
          if (pages.profile && pages.profile.style.display !== 'none') renderProfile();
        }
      } catch (e) {
        // Fallback gracefully
      }
    }
  };

  /* ================================================================
     STATE
     ================================================================ */
  let queue = [];
  let currentIndex = -1;
  let isPlaying = false;
  let isShuffle = Storage.get('shuffle', false);
  let repeatMode = Storage.get('repeat', 'off');
  let volume = Storage.get('volume', 0.8);
  let audioQuality = Storage.get('quality', 'high');
  let currentTheme = Storage.get('theme', 'dark');
  let searchResults = [];
  let lastQuery = '';
  let searchTimeout = null;
  let activeSearchController = null;
  let searchRequestId = 0;
  let isSeeking = false;
  let currentSong = null;
  let likedSongs = Storage.get('likes', []); // array of song objects
  let dislikedSongs = Storage.get('dislikes', []); // array of song objects
  let playCounts = Storage.get('playCounts', {}); // { [songId]: number }
  let playlists = Storage.get('playlists', []); // [{id, name, songs:[]}]
  let history = Storage.get('history', []); // [{song, playedAt, listenedSec}]
  let searchHistory = Storage.get('searchHistory', []);

  // Anything persisted by an older build (or a partially-written sync) can be
  // the wrong shape. Normalize once here so no renderer has to defend itself.
  if (!Array.isArray(likedSongs)) likedSongs = [];
  if (!Array.isArray(dislikedSongs)) dislikedSongs = [];
  if (!Array.isArray(playlists)) playlists = [];
  if (!Array.isArray(history)) history = [];
  if (!Array.isArray(searchHistory)) searchHistory = [];
  likedSongs = likedSongs.filter(s => s && s.id);
  dislikedSongs = dislikedSongs.filter(s => s && s.id);
  // A hand-edited or synced userData.json can carry a non-object here, and a
  // negative/NaN count would render as "NaN plays" forever.
  if (!playCounts || typeof playCounts !== 'object' || Array.isArray(playCounts)) playCounts = {};
  else {
    playCounts = Object.keys(playCounts).reduce((acc, id) => {
      const n = Math.floor(Number(playCounts[id]));
      if (id && Number.isFinite(n) && n > 0) acc[id] = n;
      return acc;
    }, {});
  }
  playlists = playlists.filter(p => p && p.id).map(p => Object.assign({}, p, {
    songs: Array.isArray(p.songs) ? p.songs.filter(s => s && s.id) : []
  }));
  history = history.filter(h => h && h.song && h.song.id);
  searchHistory = searchHistory.filter(q => typeof q === 'string' && q.trim());
  let playStartTime = null;
  let activeHistoryEntry = null;
  let addToPlaylistSong = null; // song being added

  /* ================================================================
     DOM REFS
     ================================================================ */
  const audioPlayer = $('#audioPlayer');
  const searchInput = $('#searchInput');
  const searchClear = $('#searchClear');
  const searchLoading = $('#searchLoading');
  const searchSuggestions = $('#searchSuggestions');
  const resultsGrid = $('#resultsGrid');
  const resultsTitle = $('#resultsTitle');
  const resultsHeader = $('#resultsHeader');
  const playAllBtn = $('#playAllBtn');
  const toastContainer = $('#toastContainer');
  const bgAnimation = $('#bgAnimation');

  // Pages
  const pages = { home: $('#pageHome'), search: $('#pageSearch'), library: $('#pageLibrary'), profile: $('#pageProfile'), mood: $('#pageMood') };
  const navLinks = $$('.nav-link');

  // Now playing
  const nowPlayingBar = $('#nowPlayingBar');
  const npThumbnail = $('#npThumbnail');
  const npTitle = $('#npTitle');
  const npChannel = $('#npChannel');
  const playPauseBtn = $('#playPauseBtn');
  const npCurrentTime = $('#npCurrentTime');
  const npDuration = $('#npDuration');
  const npProgressBar = $('#npProgressBar');
  const npProgressFill = $('#npProgressFill');
  const npProgressThumb = $('#npProgressThumb');
  const npVolumeBar = $('#npVolumeBar');
  const npVolumeFill = $('#npVolumeFill');
  const npVolumeThumb = $('#npVolumeThumb');

  // Queue
  const queueSidebar = $('#queueSidebar');
  const queueBadge = $('#queueBadge');
  const queueList = $('#queueList');
  const pageContent = $('#pageContent');

  /* ================================================================
     INIT
     ================================================================ */
  function init() {
    createOrbs();
    applyTheme(currentTheme);
    if (audioPlayer) audioPlayer.volume = volume;
    updateVolumeUI();
    if (isShuffle && $('#shuffleBtn')) $('#shuffleBtn').classList.add('active');
    if (repeatMode !== 'off' && $('#repeatBtn')) { $('#repeatBtn').classList.add('active'); updateRepeatIcon(); }
    updateQualityLabel();
    bindEvents();
    navigateTo('home');
    renderHomePage();

    // Advanced Apple Orb, PiP & Focus Modules
    AppleOrbController.init();
    CanvasPiPManager.init();
    PomodoroManager.init();
    setupMediaSessionHandlers();

    // Advanced Audio DSP Equalizer, Local Files, Sleep Timer & Theme Studio
    EqualizerManager.init();
    LocalFileManager.init();
    SleepTimerManager.init();
    ThemeStudioManager.init();
    DynamicIslandHeaderManager.init();
    MoodFlowManager.init();
    // After SleepTimerManager: tick() reads its fadeInterval to stay out of its way.
    CrossfadeManager.init();
    // One delegated listener for the whole suggestions dropdown, bound once.
    SuggestionEngine.init();
    BrowseTabs.init();
    VoiceAssistant.init();

    // Instant cache hydration: render home from localStorage before network
    const cachedRecs = Storage.get('cached_recommendations', null);
    if (cachedRecs && Array.isArray(cachedRecs) && cachedRecs.length > 0) {
      // Filtered here too: the cache was written before the most recent dislikes,
      // so without this a just-disliked track reappears on every reload.
      recommendedSongs = dropDisliked(cachedRecs);
      const grid = $('#recommendedGrid');
      if (grid) renderRecommendationCards(grid, recommendedSongs);
    }

    // Auto-restore saved likes and playlists from disk database
    Storage.syncFromServer();

    // Launched from the desktop shortcut (which appends ?autoplay=1): pick up
    // where the last session stopped. Deferred one frame-ish so the UI paints
    // first — starting a network stream on the same tick makes the window feel
    // slow to appear.
    if (ResumeManager.wantsAutoplay()) {
      setTimeout(() => ResumeManager.autoplay(), 250);
    }
  }

  function createOrbs() {
    if (!bgAnimation) return;
    for (let i = 0; i < 3; i++) { const o = document.createElement('div'); o.classList.add('orb'); bgAnimation.appendChild(o); }
  }

  /* ================================================================
     THEME
     ================================================================ */
  function applyTheme(theme) {
    currentTheme = theme || 'dark';
    document.documentElement.setAttribute('data-theme', currentTheme);
    Storage.set('theme', currentTheme);
    const sun = $('.icon-sun');
    const moon = $('.icon-moon');
    if (sun && moon) {
      if (currentTheme === 'light') {
        sun.style.display = 'none';
        moon.style.display = '';
      } else {
        sun.style.display = '';
        moon.style.display = 'none';
      }
    }
    if ($('#settingTheme')) $('#settingTheme').value = currentTheme;
  }

  /* ================================================================
     EVENTS
     ================================================================ */
  function bindEvents() {
    // Search
    searchInput?.addEventListener('input', onSearchInput);
    searchInput?.addEventListener('keydown', (e) => {
      // Arrow / Escape / Enter-on-a-highlighted-row are the dropdown's; a plain
      // Enter still runs the typed query.
      if (SuggestionEngine.onKeydown(e)) return;
      if (e.key === 'Enter') { clearTimeout(searchTimeout); SuggestionEngine.close(); doSearch(searchInput.value.trim()); }
    });
    searchInput?.addEventListener('focus', () => SuggestionEngine.onQuery(searchInput.value.trim()));
    document.addEventListener('click', (e) => { if ($('#searchBarWrap') && !$('#searchBarWrap').contains(e.target)) SuggestionEngine.close(); });
    searchClear?.addEventListener('click', clearSearch);

    // Quick tags & browse cards. The cards are delegated from #pageHome: there
    // are 32 of them across four panels, and one listener that reads
    // data-query off the clicked tile behaves identically to 32 handlers
    // without holding 32 closures.
    $$('.tag').forEach(t => t.addEventListener('click', () => { if (searchInput) searchInput.value = t.dataset.query; navigateTo('search'); doSearch(t.dataset.query); }));
    $('#pageHome')?.addEventListener('click', (e) => {
      const card = e.target.closest && e.target.closest('.genre-card');
      if (!card || !card.dataset.query) return;
      if (searchInput) searchInput.value = card.dataset.query;
      if (searchClear) searchClear.classList.add('visible');
      navigateTo('search');
      doSearch(card.dataset.query);
    });

    // Nav. Only links that actually name a page navigate — #navFocus is an
    // action link (it opens the Pomodoro modal via PomodoroManager) and has no
    // data-page. Binding it here used to call navigateTo(undefined), which hid
    // every page and left the user staring at a blank app.
    navLinks.forEach(l => {
      if (!l.dataset.page) return;
      l.addEventListener('click', (e) => { e.preventDefault(); navigateTo(l.dataset.page); });
    });

    // Sidebar mobile
    $('#mobileMenuBtn')?.addEventListener('click', toggleMobileSidebar);

    // Mobile player sheet + keyboard help overlay
    bindMobileSheet();
    bindShortcutHelp();
    bindLibraryFilter();

    // Queue
    $('#queueToggleBtn')?.addEventListener('click', toggleQueue);
    $('#queueCloseBtn')?.addEventListener('click', toggleQueue);
    $('#queueClearBtn')?.addEventListener('click', clearQueue);

    // Player
    playPauseBtn?.addEventListener('click', togglePlayPause);
    $('#prevBtn')?.addEventListener('click', playPrev);
    $('#nextBtn')?.addEventListener('click', playNext);
    $('#shuffleBtn')?.addEventListener('click', toggleShuffle);
    $('#repeatBtn')?.addEventListener('click', toggleRepeat);
    $('#muteBtn')?.addEventListener('click', toggleMute);
    $('#npLikeBtn')?.addEventListener('click', () => { if (currentSong) toggleLike(currentSong); });
    $('#npDislikeBtn')?.addEventListener('click', () => { if (currentSong) toggleDislike(currentSong); });
    playAllBtn?.addEventListener('click', () => playAllResults());

    // Progress. These must NOT be passive: startSeek/startVolChange both call
    // preventDefault(), which a passive listener ignores (Chrome logs a warning)
    // — so dragging the seek or volume bar on a phone scrolled the page at the
    // same time as scrubbing.
    npProgressBar?.addEventListener('mousedown', startSeek);
    npProgressBar?.addEventListener('touchstart', startSeek, { passive: false });
    npVolumeBar?.addEventListener('mousedown', startVolChange);
    npVolumeBar?.addEventListener('touchstart', startVolChange, { passive: false });

    // Audio events
    audioPlayer?.addEventListener('timeupdate', onTimeUpdate);
    audioPlayer?.addEventListener('loadedmetadata', onMeta);
    audioPlayer?.addEventListener('ended', onEnd);
    audioPlayer?.addEventListener('play', () => { setPlayState(true); playStartTime = Date.now(); CrossfadeManager.onPlay(); });
    audioPlayer?.addEventListener('pause', () => { setPlayState(false); recordListenTime(); ResumeManager.save(); CrossfadeManager.onPause(); });
    audioPlayer?.addEventListener('error', onAudioError);

    // Closing the tab used to discard the current track's listen time and any
    // queued sync. pagehide fires reliably where beforeunload does not (iOS).
    window.addEventListener('pagehide', () => {
      recordListenTime();
      // Written before the flush so the shortcut can resume from the exact
      // second the window was closed, not from the last 5-second checkpoint.
      ResumeManager.save();
      Storage.flushBeacon();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { ResumeManager.save(); Storage.flushBeacon(); }
    });

    // Theme cycling: Dark -> Light -> OLED -> Dark
    $('#themeToggleBtn')?.addEventListener('click', () => {
      const cycle = { dark: 'light', light: 'oled', oled: 'dark' };
      const nextTheme = cycle[currentTheme] || 'dark';
      applyTheme(nextTheme);
      toast(`🎨 Theme: ${nextTheme.toUpperCase()}`);
    });

    // Settings
    $('#settingsBtn')?.addEventListener('click', () => { if ($('#settingsModal')) $('#settingsModal').style.display = ''; });
    $('#settingsCloseBtn')?.addEventListener('click', () => { if ($('#settingsModal')) $('#settingsModal').style.display = 'none'; });
    $('#settingsModal')?.addEventListener('click', (e) => { if (e.target === $('#settingsModal')) $('#settingsModal').style.display = 'none'; });
    $('#settingTheme')?.addEventListener('change', (e) => applyTheme(e.target.value));
    $('#settingQuality')?.addEventListener('change', (e) => { audioQuality = e.target.value; Storage.set('quality', audioQuality); updateQualityLabel(); toast('Quality: ' + (audioQuality === 'high' ? 'High' : 'Low')); });
    // The Quality dropdown never reflected the stored value on load, so it read
    // "High" while the app was actually streaming Low.
    if ($('#settingQuality')) $('#settingQuality').value = audioQuality;

    // Endless auto-queue was read on every track end but never saved, so
    // switching it off lasted exactly until the next reload.
    const autoQueueEl = $('#settingAutoQueue');
    if (autoQueueEl) {
      autoQueueEl.checked = Storage.get('autoQueue', true) !== false;
      autoQueueEl.addEventListener('change', (e) => {
        Storage.set('autoQueue', !!e.target.checked);
        toast(e.target.checked ? 'Endless auto-queue ON' : 'Endless auto-queue OFF');
      });
    }
    
    // Orb Setting
    const settingOrbEl = $('#settingOrb');
    if (settingOrbEl) {
      settingOrbEl.value = Storage.get('orb', 'show');
      settingOrbEl.addEventListener('change', (e) => {
        Storage.set('orb', e.target.value);
        const orbEl = $('#appleFloatingOrb');
        if (orbEl) orbEl.style.display = e.target.value === 'hide' ? 'none' : '';
        toast('Floating Orb: ' + (e.target.value === 'show' ? 'Visible' : 'Hidden'));
      });
    }

    // Quality button
    $('#qualityBtn')?.addEventListener('click', () => { audioQuality = audioQuality === 'high' ? 'low' : 'high'; Storage.set('quality', audioQuality); updateQualityLabel(); if ($('#settingQuality')) $('#settingQuality').value = audioQuality; toast('Quality: ' + (audioQuality === 'high' ? 'High' : 'Low')); });

    // Share & Download
    $('#shareBtn')?.addEventListener('click', shareSong);
    $('#downloadBtn')?.addEventListener('click', () => { if (currentSong) downloadSong(currentSong); else toast('No song playing'); });

    // Lyrics
    $('#lyricsBtn')?.addEventListener('click', toggleLyrics);
    $('#lyricsCloseBtn')?.addEventListener('click', toggleLyrics);

    // Library
    $('#likedSongsCard')?.addEventListener('click', showLikedSongs);
    $('#playLikedBtn')?.addEventListener('click', (e) => { e.stopPropagation(); playLikedSongs(); });
    $('#hideLikedListBtn')?.addEventListener('click', () => { if ($('#likedSongsListSection')) $('#likedSongsListSection').style.display = 'none'; });
    $('#hidePlaylistBtn')?.addEventListener('click', () => { if ($('#activePlaylistSection')) $('#activePlaylistSection').style.display = 'none'; });
    $('#createPlaylistBtn')?.addEventListener('click', openCreatePlaylist);
    $('#playlistModalClose')?.addEventListener('click', () => { if ($('#playlistModal')) $('#playlistModal').style.display = 'none'; });
    $('#playlistModal')?.addEventListener('click', (e) => { if (e.target === $('#playlistModal')) $('#playlistModal').style.display = 'none'; });
    $('#playlistSaveBtn')?.addEventListener('click', savePlaylist);
    $('#playlistNameInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') savePlaylist(); });
    $('#playPlaylistBtn')?.addEventListener('click', playCurrentPlaylist);
    $('#deletePlaylistBtn')?.addEventListener('click', deleteCurrentPlaylist);
    $('#downloadPlaylistBtn')?.addEventListener('click', startPlaylistDownload);
    $('#playlistDlCancelBtn')?.addEventListener('click', cancelOrClosePlaylistDownload);
    $('#playlistDlSaveBtn')?.addEventListener('click', savePlaylistZip);
    // Closing the dialog only hides it; the job keeps running so the user can
    // keep browsing, and the Download All button reopens this view.
    $('#playlistDlClose')?.addEventListener('click', hidePlaylistDlModal);
    $('#playlistDlModal')?.addEventListener('click', (e) => { if (e.target === $('#playlistDlModal')) hidePlaylistDlModal(); });
    $('#addToPlaylistClose')?.addEventListener('click', () => { if ($('#addToPlaylistModal')) $('#addToPlaylistModal').style.display = 'none'; });
    $('#addToPlaylistModal')?.addEventListener('click', (e) => { if (e.target === $('#addToPlaylistModal')) $('#addToPlaylistModal').style.display = 'none'; });

    // Batch Text Importer
    $('#batchImportBtn')?.addEventListener('click', () => openBatchImport());
    $('#playlistBatchAddBtn')?.addEventListener('click', () => openBatchImport(currentPlaylistId));
    $('#batchImportClose')?.addEventListener('click', closeBatchImport);
    $('#batchCancelBtn')?.addEventListener('click', closeBatchImport);
    $('#batchImportModal')?.addEventListener('click', (e) => { if (e.target === $('#batchImportModal')) closeBatchImport(); });
    $('#batchTextarea')?.addEventListener('input', onBatchTextChange);
    $('#batchClearText')?.addEventListener('click', () => { if ($('#batchTextarea')) $('#batchTextarea').value = ''; onBatchTextChange(); });
    $$('.batch-example-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        if ($('#batchTextarea')) {
          $('#batchTextarea').value = pill.dataset.text;
          onBatchTextChange();
        }
      });
    });
    $('#destRadioNew')?.addEventListener('change', () => {
      if ($('#batchNewPlaylistWrap')) $('#batchNewPlaylistWrap').style.display = '';
      if ($('#batchExistingPlaylistWrap')) $('#batchExistingPlaylistWrap').style.display = 'none';
    });
    $('#destRadioExisting')?.addEventListener('change', () => {
      if ($('#batchNewPlaylistWrap')) $('#batchNewPlaylistWrap').style.display = 'none';
      if ($('#batchExistingPlaylistWrap')) $('#batchExistingPlaylistWrap').style.display = '';
    });
    $('#batchStartBtn')?.addEventListener('click', executeBatchImport);

    // Home Recommendations & Smart Radio
    $('#startRadioBtn')?.addEventListener('click', startPersonalizedRadio);
    $('#playAllRecBtn')?.addEventListener('click', startPersonalizedRadio);
    $('#refreshRecBtn')?.addEventListener('click', () => loadRecommendations(true));

    // Profile
    $('#clearHistoryBtn')?.addEventListener('click', () => { history = []; Storage.set('history', []); renderProfile(); toast('History cleared'); });

    // Search history. Both Clear buttons wipe the same list, and both pill rows
    // are handled by one delegated listener per container rather than a handler
    // per pill — renderSearchHistory() reruns on every navigation and on every
    // search, so per-pill binding would have leaked listeners steadily.
    const clearHistory = () => {
      searchHistory = [];
      Storage.set('searchHistory', []);
      renderSearchHistory();
      SuggestionEngine.close();
    };
    $('#clearSearchHistory')?.addEventListener('click', clearHistory);
    $('#clearHomeHistory')?.addEventListener('click', clearHistory);

    HISTORY_TARGETS.forEach(([, tagsSel]) => {
      $(tagsSel)?.addEventListener('click', (e) => {
        const pill = e.target.closest && e.target.closest('.history-tag');
        if (!pill) return;
        const q = pill.dataset.query;
        if (!q) return;
        if (searchInput) searchInput.value = q;
        if (searchClear) searchClear.classList.add('visible');
        // Reached from the home page too, so the search page has to be shown.
        navigateTo('search');
        doSearch(q);
      });
    });

    // Keyboard
    document.addEventListener('keydown', onKeyboard);
  }

  /* ================================================================
     ROUTING
     ================================================================ */
  function navigateTo(page) {
    // Never blank the app for an unknown page name. Hiding every section and
    // then failing to show one leaves no way back except clicking another nav
    // item, so an unrecognised page is a no-op instead.
    if (!pages[page]) return;

    Object.values(pages).forEach(p => { if (p) p.style.display = 'none'; });
    pages[page].style.display = '';

    navLinks.forEach(l => l.classList.toggle('active', l.dataset.page === page));

    // Page-specific renders
    if (page === 'home') renderHomePage();
    if (page === 'library') renderLibrary();
    if (page === 'profile') renderProfile();
    if (page === 'search') renderSearchHistory();
    if (page === 'mood') MoodFlowManager.renderPage();

    closeMobileSidebar();
  }

  /* ================================================================
     SEARCH
     ================================================================ */
  // The dropdown and the search itself are debounced separately on purpose.
  // 300ms is short enough for the suggestions to feel live while still
  // collapsing a burst of keystrokes into one request. The full search keeps its
  // original 700ms because every one of those spawns a yt-dlp process on the
  // server; firing them at 300ms to shave a third of a second off would trade a
  // snappier dropdown for a slower app.
  const SUGGEST_DEBOUNCE_MS = 300;
  const SEARCH_DEBOUNCE_MS = 700;
  // Past this a suggestion list stops being a shortcut and becomes a page.
  const SUGGEST_MAX = 9;
  // Bounded, so a long typing session cannot grow the cache without limit.
  const SUGGEST_CACHE_MAX = 40;
  // Below two characters every remote result is noise, and it would be one
  // request per letter of the alphabet.
  const SUGGEST_MIN_REMOTE = 2;

  // Inline so opening the dropdown never waits on a request. Coloured by
  // .sug-icon, sized by the stylesheet.
  const SUG_ICONS = {
    recent: '<svg class="sug-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    song: '<svg class="sug-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
    artist: '<svg class="sug-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" y1="19" x2="12" y2="22"/></svg>',
    playlist: '<svg class="sug-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 5h11"/><path d="M3 10h11"/><path d="M3 15h7"/><circle cx="18" cy="16" r="3"/><path d="M21 16V7"/></svg>',
    popular: '<svg class="sug-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
  };

  // Rows are sorted into this order before rendering, so each heading is emitted
  // exactly once no matter which order the sections were collected in.
  const SUG_GROUPS = [
    ['recent', 'Recent searches'],
    ['song', 'Songs'],
    ['artist', 'Artists'],
    ['playlist', 'Your playlists'],
    ['popular', 'From your listening'],
  ];
  const SUG_ORDER = {};
  const SUG_LABELS = {};
  SUG_GROUPS.forEach(([kind, label], i) => { SUG_ORDER[kind] = i; SUG_LABELS[kind] = label; });

  const SuggestionEngine = {
    timer: null,
    controller: null,
    reqId: 0,
    // Normalized query -> remote suggestion array. Backspacing through a word
    // and retyping it is the single most common thing a person does in a search
    // box, and it must never cost a second request.
    cache: new Map(),
    rows: [],        // the rendered .suggestion-item elements, in visual order
    items: [],       // their descriptors, index-aligned with `rows`
    activeIndex: -1, // keyboard cursor; -1 means "nothing highlighted"

    init() {
      if (!searchSuggestions) return;
      // One delegated listener, bound once. The old code re-bound a handler to
      // every row on every keystroke; delegation is O(1) listeners instead of
      // O(rows) and cannot accumulate duplicates.
      searchSuggestions.addEventListener('click', (e) => {
        const row = e.target && e.target.closest ? e.target.closest('.suggestion-item') : null;
        if (row) this.choose(row);
      });
      // The pointer has to move the same cursor the keyboard uses, or Enter
      // fires a different row than the one under the mouse.
      searchSuggestions.addEventListener('mousemove', (e) => {
        const row = e.target && e.target.closest ? e.target.closest('.suggestion-item') : null;
        if (!row) return;
        const i = this.rows.indexOf(row);
        if (i >= 0 && i !== this.activeIndex) { this.activeIndex = i; this.paintCursor(); }
      });
    },

    normQuery(q) { return String(q == null ? '' : q).trim().toLowerCase().replace(/\s+/g, ' '); },

    // Channel names arrive decorated ("… - Topic", "…VEVO"). Same cleanup
    // loadRecommendations() uses, so the two agree on what an artist is called.
    cleanArtist(name) { return String(name == null ? '' : name).replace(/ - Topic|VEVO|Official/gi, '').trim(); },

    isOpen() { return !!searchSuggestions && searchSuggestions.classList.contains('active'); },

    /* ---------------- local sources: no network, ever ---------------- */

    // One pass over the user's own listening. Deliberately not memoized: it is a
    // few hundred small objects at most, and any signature cheap enough to be
    // worth caching on (lengths, newest id) goes stale on an unlike-then-like,
    // which would show artists the user no longer has.
    artistCounts() {
      const counts = new Map();
      const bump = (song, weight) => {
        const a = this.cleanArtist(song && song.channel);
        if (a) counts.set(a, (counts.get(a) || 0) + weight);
      };
      for (let i = 0; i < history.length; i++) bump(history[i] && history[i].song, 1);
      // A like is a stronger signal than a play, so it counts double.
      for (let i = 0; i < likedSongs.length; i++) bump(likedSongs[i], 2);
      return counts;
    },

    rankedArtists(nq, limit) {
      const counts = this.artistCounts();
      const out = [];
      counts.forEach((n, name) => {
        if (!nq || this.normQuery(name).includes(nq)) out.push([name, n]);
      });
      out.sort((a, b) => b[1] - a[1]);
      return out.slice(0, limit).map(x => x[0]);
    },

    // Songs the user already has. Liked first, then played, then anything filed
    // in a playlist; deduped on id so a liked-and-played track appears once.
    matchLibrarySongs(nq, limit) {
      const out = [];
      const seen = new Set();
      const consider = (s) => {
        if (out.length >= limit) return;
        if (!s || !s.id || typeof s.title !== 'string' || seen.has(s.id)) return;
        if (!this.normQuery(s.title).includes(nq) && !this.normQuery(s.channel).includes(nq)) return;
        seen.add(s.id);
        out.push(s);
      };
      for (let i = 0; i < likedSongs.length && out.length < limit; i++) consider(likedSongs[i]);
      for (let i = 0; i < history.length && out.length < limit; i++) consider(history[i] && history[i].song);
      for (let i = 0; i < playlists.length && out.length < limit; i++) {
        const songs = playlists[i].songs;
        for (let j = 0; j < songs.length && out.length < limit; j++) consider(songs[j]);
      }
      return out;
    },

    // Everything that can be answered from memory. Rendered immediately on every
    // keystroke so the dropdown never waits on the network to show something.
    localRows(nq) {
      const rows = [];
      const seenQuery = new Set();
      const addQuery = (kind, text, sub) => {
        const key = this.normQuery(text);
        if (!key || seenQuery.has(key)) return;
        seenQuery.add(key);
        rows.push({ kind, label: text, sub: sub || '', query: text });
      };

      if (!nq) {
        // Focused with an empty box: the quick way back to a recent search, plus
        // the artists this listener actually plays. Zero requests.
        for (let i = 0; i < searchHistory.length && i < 5; i++) addQuery('recent', searchHistory[i]);
        for (const a of this.rankedArtists('', 4)) addQuery('popular', a, 'You play this a lot');
        return rows;
      }

      let n = 0;
      for (let i = 0; i < searchHistory.length && n < 4; i++) {
        if (this.normQuery(searchHistory[i]).includes(nq)) { addQuery('recent', searchHistory[i]); n++; }
      }

      // Personalization: a title the user has liked or played is a better guess
      // than anything a scrape returns, so these rank above the remote rows.
      for (const s of this.matchLibrarySongs(nq, 3)) {
        rows.push({ kind: 'song', label: s.title, sub: this.cleanArtist(s.channel) || 'In your library', song: s });
      }

      for (const a of this.rankedArtists(nq, 3)) addQuery('artist', a, 'Artist');

      let p = 0;
      for (let i = 0; i < playlists.length && p < 2; i++) {
        const pl = playlists[i];
        if (typeof pl.name !== 'string' || !this.normQuery(pl.name).includes(nq)) continue;
        rows.push({
          kind: 'playlist', label: pl.name, plId: pl.id,
          sub: pl.songs.length === 1 ? '1 song' : `${pl.songs.length} songs`,
        });
        p++;
      }
      return rows;
    },

    /* ---------------- remote source: debounced and cached ---------------- */

    // Entry point for every keystroke.
    onQuery(raw) {
      if (!searchSuggestions) return;
      const nq = this.normQuery(raw);
      clearTimeout(this.timer);
      const cached = this.cache.get(nq);
      this.paint(this.merge(nq, cached));
      if (nq.length < SUGGEST_MIN_REMOTE || cached) return;
      this.timer = setTimeout(() => this.fetchRemote(nq), SUGGEST_DEBOUNCE_MS);
    },

    async fetchRemote(nq) {
      this.abort();
      const controller = new AbortController();
      this.controller = controller;
      const id = ++this.reqId;
      // null means "we learned nothing", which is different from "there are no
      // suggestions". Only the second is worth caching.
      let items = null;
      try {
        const timeoutId = setTimeout(() => { try { controller.abort(); } catch (e) {} }, 8000);
        const res = await fetch(`/api/suggestions?q=${encodeURIComponent(nq)}`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) items = this.sanitize(await res.json());
      } catch (e) {
        // Aborted, offline, or malformed JSON. The local rows are already up.
      } finally {
        if (this.controller === controller) this.controller = null;
      }
      if (id !== this.reqId || items === null) return;
      this.remember(nq, items);
      // A slow response must never repaint over a query the user has moved past.
      if (this.normQuery(searchInput && searchInput.value) !== nq) return;
      this.paint(this.merge(nq, items));
    },

    abort() {
      if (this.controller) { try { this.controller.abort(); } catch (e) {} this.controller = null; }
    },

    // /api/suggestions is a yt-dlp scrape parsed line by line; a partial line or
    // an upstream format change can put anything at all in here.
    sanitize(data) {
      if (!Array.isArray(data)) return [];
      const out = [];
      const seen = new Set();
      for (let i = 0; i < data.length && out.length < 6; i++) {
        const d = data[i];
        if (!d || typeof d !== 'object') continue;
        const title = typeof d.title === 'string' ? d.title.trim() : '';
        const id = typeof d.id === 'string' ? d.id : '';
        if (!title || !id || seen.has(id)) continue;
        seen.add(id);
        out.push({ id, title, channel: this.cleanArtist(d.channel) });
      }
      return out;
    },

    remember(nq, items) {
      // A plain Map as an LRU: delete-then-set moves a key to the end, so the
      // first key is always the coldest one.
      if (this.cache.has(nq)) this.cache.delete(nq);
      this.cache.set(nq, items);
      while (this.cache.size > SUGGEST_CACHE_MAX) {
        this.cache.delete(this.cache.keys().next().value);
      }
    },

    // Local rows plus whatever remote rows add something new, sorted into group
    // order and capped. Stable sort keeps library songs above remote ones.
    merge(nq, remote) {
      const rows = this.localRows(nq);
      if (Array.isArray(remote) && remote.length) {
        const seen = new Set(rows.map(r => this.normQuery(r.label)));
        for (const r of remote) {
          const key = this.normQuery(r.title);
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push({ kind: 'song', label: r.title, sub: r.channel || 'Song', song: r });
        }
      }
      rows.sort((a, b) => SUG_ORDER[a.kind] - SUG_ORDER[b.kind]);
      return rows.slice(0, SUGGEST_MAX);
    },

    /* ---------------- rendering and selection ---------------- */

    paint(items) {
      if (!searchSuggestions) return;
      if (!items.length) { this.close(); return; }
      // Keep the cursor on the same row across a repaint: the remote rows land
      // while the user may already be arrowing down the local ones.
      const prev = this.items[this.activeIndex];
      let html = '';
      let group = null;
      items.forEach((item) => {
        if (item.kind !== group) {
          group = item.kind;
          html += `<div class="sug-group">${esc(SUG_LABELS[group] || '')}</div>`;
        }
        const act = item.kind === 'playlist'
          ? `data-action="playlist" data-plid="${escId(item.plId)}"`
          : (item.kind === 'song'
            ? `data-action="play" data-id="${escId(item.song && item.song.id)}"`
            : `data-action="search" data-query="${esc(item.query)}"`);
        html += `<div class="suggestion-item" role="option" data-type="${esc(item.kind)}" ${act} title="${esc(this.hint(item))}">`
          + (SUG_ICONS[item.kind] || SUG_ICONS.recent)
          + `<span class="sug-text">${esc(item.label)}</span>`
          + (item.sub ? `<span class="sug-sub">${esc(item.sub)}</span>` : '')
          + '</div>';
      });
      searchSuggestions.innerHTML = html;
      searchSuggestions.classList.add('active');
      if (searchInput) searchInput.setAttribute('aria-expanded', 'true');
      this.items = items;
      this.rows = Array.prototype.slice.call(searchSuggestions.querySelectorAll('.suggestion-item'));
      this.activeIndex = prev ? items.findIndex(i => this.same(i, prev)) : -1;
      this.paintCursor();
    },

    same(a, b) {
      return a.kind === b.kind && a.label === b.label
        && (a.plId || '') === (b.plId || '')
        && ((a.song && a.song.id) || '') === ((b.song && b.song.id) || '');
    },

    hint(item) {
      if (item.kind === 'song') return `Play "${item.label}"`;
      if (item.kind === 'playlist') return `Open playlist "${item.label}"`;
      return `Search for "${item.label}"`;
    },

    paintCursor() {
      for (let i = 0; i < this.rows.length; i++) {
        this.rows[i].classList.toggle('sug-active', i === this.activeIndex);
      }
      const el = this.rows[this.activeIndex];
      if (el && el.scrollIntoView) { try { el.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
    },

    close() {
      clearTimeout(this.timer);
      this.abort();
      this.rows = [];
      this.items = [];
      this.activeIndex = -1;
      if (searchSuggestions) {
        searchSuggestions.innerHTML = '';
        searchSuggestions.classList.remove('active');
      }
      if (searchInput) searchInput.setAttribute('aria-expanded', 'false');
    },

    // Returns true when the key was consumed, so the caller leaves it alone.
    onKeydown(e) {
      const open = this.isOpen() && this.rows.length > 0;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        // Only swallow the arrow when there is a list to walk; otherwise the
        // caret must keep working in an ordinary text box.
        if (!open) return false;
        e.preventDefault();
        const n = this.rows.length;
        const step = e.key === 'ArrowDown' ? 1 : -1;
        this.activeIndex = this.activeIndex < 0
          ? (step > 0 ? 0 : n - 1)
          : (this.activeIndex + step + n) % n;
        this.paintCursor();
        return true;
      }
      if (e.key === 'Escape') {
        if (!open) return false;
        this.close();
        return true;
      }
      if (e.key === 'Enter' && open && this.activeIndex >= 0) {
        e.preventDefault();
        this.choose(this.rows[this.activeIndex]);
        return true;
      }
      return false;
    },

    choose(row) {
      if (!row) return;
      const action = row.dataset.action;
      const item = this.items[this.rows.indexOf(row)];
      // Read everything off the row first: close() drops the descriptors.
      this.close();
      clearTimeout(searchTimeout);

      if (action === 'playlist') {
        navigateTo('library');
        showPlaylistDetail(row.dataset.plid);
        return;
      }
      if (action === 'play' && item && item.song) {
        // The row names one exact track, so play it rather than searching for
        // its own title. A library row carries the full stored object; a remote
        // row is {id, title, channel}, the same shape a result card plays from.
        navigateTo('search');
        playSong(item.song);
        return;
      }
      const q = row.dataset.query;
      if (!q) return;
      if (searchInput) searchInput.value = q;
      if (searchClear) searchClear.classList.add('visible');
      navigateTo('search');
      doSearch(q);
    },
  };

  function onSearchInput() {
    const q = searchInput.value.trim();
    searchClear.classList.toggle('visible', q.length > 0);
    clearTimeout(searchTimeout);
    SuggestionEngine.onQuery(q);
    if (q.length >= 2) searchTimeout = setTimeout(() => doSearch(q), SEARCH_DEBOUNCE_MS);
  }

  /* ================================================================
     DIRECT STANDALONE CLOUD MUSIC ENGINE (Zero PC Required)
     ================================================================ */
  const CloudMusicEngine = {
    async search(query) {
      try {
        const url = `https://jiosaavn-api.vercel.app/search?query=${encodeURIComponent(query)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('Cloud search failed');
        const data = await res.json();
        if (!data || !data.results) return [];
        return data.results.map(s => {
          let thumbUrl = '';
          if (s.images && s.images['500x500']) thumbUrl = s.images['500x500'];
          else if (s.image) thumbUrl = s.image.replace('150x150', '500x500');
          
          return {
            id: s.id,
            title: s.title || s.song,
            channel: s.more_info?.singers || s.primary_artists || s.description || 'Official Release',
            duration: parseInt(s.duration) || 210,
            thumbnail: thumbUrl || s.image,
            isCloud: true
          };
        });
      } catch (e) {
        console.warn('Cloud search error:', e);
        return [];
      }
    },
    async getStreamUrl(songId) {
      try {
        const res = await fetch(`https://jiosaavn-api.vercel.app/song?id=${encodeURIComponent(songId)}`);
        if (!res.ok) return null;
        const song = await res.json();
        if (song.media_urls) {
          return song.media_urls['320_KBPS'] || song.media_urls['160_KBPS'] || song.media_urls['96_KBPS'] || song.media_url;
        }
        return song.media_url || null;
      } catch (e) {
        console.warn('Cloud stream error:', e);
        return null;
      }
    },
    async getTrending() {
      try {
        const queries = ['Top Bollywood Hits', 'Global Billboard Hot 100', 'Trending Hindi Hits', 'Punjabi Hits'];
        const q = queries[Math.floor(Math.random() * queries.length)];
        return await this.search(q);
      } catch (e) {
        return [];
      }
    }
  };

  async function doSearch(query) {
    query = query.trim().slice(0, 160);
    if (!query) return;
    if (activeSearchController) activeSearchController.abort();
    const requestId = ++searchRequestId;
    const controller = new AbortController();
    activeSearchController = controller;
    lastQuery = query;
    navigateTo('search');

    // Save to search history
    searchHistory = [query, ...searchHistory.filter(h => h !== query)].slice(0, 20);
    Storage.set('searchHistory', searchHistory);
    // navigateTo() above painted the pills before this query was added, so the
    // newest search was missing from the list until the next visit.
    renderSearchHistory();
    // Deliberately does NOT close the dropdown. This function also runs from the
    // 700ms type-ahead timer, and closing there would wipe the suggestions
    // 400ms after they appeared, making the autocomplete useless. The dropdown
    // belongs to the input's focus instead: Enter, Escape, picking a row,
    // clearing the box and clicking outside all close it explicitly.

    resultsHeader.style.display = 'flex';
    resultsTitle.textContent = `Results for "${query}"`;
    showSkeletons();
    searchLoading.classList.add('active');

    try {
      let results = [];
      try {
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
          results = await res.json();
        }
      } catch (e) {
        // Fallback to Cloud Music Engine
      }

      if (!results || results.length === 0) {
        results = await CloudMusicEngine.search(query);
      }

      if (requestId !== searchRequestId) return;

      searchResults = results;
      if (searchResults.length === 0) {
        resultsGrid.innerHTML = '<p class="empty-msg" style="grid-column:1/-1;text-align:center;">No results found.</p>';
      } else {
        renderResults(searchResults);
      }
    } catch (err) {
      if (err.name === 'AbortError' || requestId !== searchRequestId) return;
      // A failed search used to be a dead end: the only retry affordance was a
      // handler bound to #retryBtn, an id that never existed anywhere.
      resultsGrid.innerHTML = `
        <div class="search-error-box" style="grid-column:1/-1;">
          <p class="empty-msg">Search failed. Please check your connection.</p>
          <button class="pill-action-btn" id="retryBtn" type="button">↻ Try again</button>
        </div>`;
      $('#retryBtn')?.addEventListener('click', () => doSearch(lastQuery || query));
    } finally {
      if (requestId === searchRequestId) searchLoading.classList.remove('active');
    }
  }

  function clearSearch() {
    if (activeSearchController) activeSearchController.abort();
    searchRequestId++;
    searchInput.value = '';
    searchClear.classList.remove('visible');
    // Otherwise the dropdown kept showing matches for a query that is no longer
    // in the box, and Enter would fire one of them.
    SuggestionEngine.close();
    resultsGrid.innerHTML = '';
    resultsHeader.style.display = 'none';
    searchResults = [];
    renderSearchHistory();
  }

  // The search page and the home page show the same recent-search pills, so one
  // renderer paints both. Two near-copies is exactly how renderResults drifted
  // away from renderRecommendationCards.
  const HISTORY_TARGETS = [
    ['#searchHistorySection', '#searchHistoryTags'],
    ['#homeHistorySection', '#homeHistoryTags'],
  ];

  function renderSearchHistory() {
    for (let i = 0; i < HISTORY_TARGETS.length; i++) {
      const section = $(HISTORY_TARGETS[i][0]);
      const tags = $(HISTORY_TARGETS[i][1]);
      // Missing markup used to throw here and abort whatever called it.
      if (!section || !tags) continue;
      if (searchHistory.length === 0) {
        section.style.display = 'none';
        // Clear the pills too: otherwise "Clear" hides a row that still holds
        // the old queries, and they reappear the next time it is shown.
        tags.innerHTML = '';
        continue;
      }
      section.style.display = '';
      tags.innerHTML = searchHistory.slice(0, 12)
        .map(h => `<button class="history-tag" data-query="${esc(h)}">${esc(h)}</button>`).join('');
    }
  }

  function showSkeletons() {
    let h = '';
    for (let i = 0; i < 6; i++) h += `<div class="skeleton-card"><div class="skeleton-thumb"></div><div class="skeleton-info"><div class="skeleton-line"></div><div class="skeleton-line"></div></div></div>`;
    resultsGrid.innerHTML = h;
  }

  // Was a 48-line near-copy of renderRecommendationCards that drifted out of sync:
  // it offered a Download button for cloud and local tracks (which downloadSong()
  // always refuses) and it never grew the newer card actions. One renderer means
  // search results and every other grid behave identically by construction.
  // The empty case is handled by the caller, which shows "No results found."
  function renderResults(results) {
    renderRecommendationCards(resultsGrid, results);
  }

  /* ================================================================
     PLAYER
     ================================================================ */
  let audioRetryCount = 0;

  // Changing crossOrigin restarts the resource-selection algorithm, so it has
  // to be set before src and only when it actually changes.
  function applyCrossOrigin(mode) {
    const current = audioPlayer.getAttribute('crossorigin');
    if (mode === null) {
      if (current !== null) audioPlayer.removeAttribute('crossorigin');
    } else if (current !== mode) {
      audioPlayer.setAttribute('crossorigin', mode);
    }
  }

  // Every call site used to be `audioPlayer.play().catch(() => {})`, so a
  // blocked autoplay or an unsupported codec looked identical to "nothing
  // happened at all". Errors are now surfaced, minus the two rejection types
  // that are normal (a superseded src, and the element's own error event which
  // already owns the retry/skip logic).
  function startPlayback(song) {
    const attempt = audioPlayer.play();
    if (!attempt || typeof attempt.catch !== 'function') return;
    attempt.then(() => {
      EqualizerManager.resumeContext();
    }).catch(err => {
      if (currentSong !== song) return;
      const name = err && err.name;
      if (name === 'AbortError') return;
      if (name === 'NotAllowedError') {
        toast('Press play to start audio — your browser blocked autoplay.');
        return;
      }
      console.warn('[player] play() failed:', name, err && err.message);
      if (name !== 'NotSupportedError') {
        toast(`Could not play "${String(song.title || 'track').slice(0, 24)}".`);
      }
    });
  }

  function playSong(song) {
    if (!song || !song.id) return;
    recordListenTime();
    audioRetryCount = 0;

    let idx = queue.findIndex(s => s.id === song.id);
    if (idx === -1) { queue.push(song); idx = queue.length - 1; }
    currentIndex = idx;
    currentSong = song;
    noteSongPlayed(song);

    // Before any src is set: this may drop the element to silence so the new
    // track can rise from nothing, and it clears any ramp the outgoing track
    // left running.
    CrossfadeManager.onTrackStart(song);

    npThumbnail.src = thumb(song);
    npTitle.textContent = song.title;
    npChannel.textContent = song.channel;
    updateLikeBtn();

    if (song.isLocal) {
      // The object URL has to be re-created from IndexedDB after a reload, so
      // this is asynchronous. Guard against the user skipping on in the meantime.
      // Stop the outgoing track first: the now-playing UI already claims this
      // song, so leaving the previous one audible during the round-trip makes
      // the player look like it is playing the wrong thing.
      audioPlayer.pause();
      LocalFileManager.resolveStreamUrl(song).then(url => {
        if (currentSong !== song) return;
        if (!url) {
          toast('This local file is no longer stored. Re-import it from your device.');
          return;
        }
        audioPlayer.src = url;
        startPlayback(song);
      });
    } else if (song.isCloud) {
      // Once the Web Audio graph exists it taps the element directly, and a
      // cross-origin stream fetched without CORS feeds it silence. Requesting
      // CORS means a non-cooperating CDN fails loudly (error event -> skip)
      // instead of playing a silent track that looks like it is working.
      applyCrossOrigin(EqualizerManager.audioCtx ? 'anonymous' : null);
      if (song.streamUrl) {
        audioPlayer.src = song.streamUrl;
        // A blocked autoplay is not an expired URL. The old code refetched the
        // stream on any play() rejection, so a browser autoplay block produced
        // a pointless network round-trip and a misleading "could not start"
        // toast instead of "press play". startPlayback tells them apart; a
        // genuinely dead URL surfaces as an 'error' event and onAudioError
        // handles the refetch.
        startPlayback(song);
      } else {
        // Same reasoning as the local branch: don't leave the previous track
        // audible while the UI already shows this one.
        audioPlayer.pause();
        CloudMusicEngine.getStreamUrl(song.id).then(url => {
          if (currentSong !== song) return;
          if (url) {
            song.streamUrl = url;
            audioPlayer.src = url;
            startPlayback(song);
          } else {
            toast(`Could not start "${String(song.title || 'track').slice(0, 24)}".`);
          }
        }).catch(() => {
          if (currentSong === song) toast('Could not reach the music service.');
        });
      }
    } else {
      applyCrossOrigin(null);
      audioPlayer.src = `/api/stream/${song.id}?quality=${audioQuality}`;
      startPlayback(song);
    }

    // History
    addToHistory(song);

    updateQueueUI();
    highlightResults();
    toast(`▶ ${song.title}`);

    // Update Floating Orb, Dynamic Island, PiP & MediaSession
    AppleOrbController.updateSong(song, isPlaying);
    DynamicIslandHeaderManager.updateSong(song, isPlaying);
    CanvasPiPManager.updateSong(song);
    updateMediaSession(song);

    // Set document title
    document.title = `${song.title} — MusicFlow`;

    // Fetch lyrics only when the panel is open to keep track changes responsive.
    if ($('#lyricsPanel')?.classList.contains('open')) fetchLyrics(song.id);
  }

  function togglePlayPause() {
    if (!audioPlayer.src || currentIndex < 0) return;
    if (audioPlayer.paused) {
      // This is a user gesture, so it is the right moment to un-suspend the
      // Web Audio graph if the browser started it suspended.
      EqualizerManager.resumeContext();
      startPlayback(currentSong || { title: '' });
    } else {
      audioPlayer.pause();
    }
  }

  function setPlayState(playing) {
    isPlaying = playing;
    const playIcon = $('.play-icon');
    const pauseIcon = $('.pause-icon');
    if (playIcon) playIcon.style.display = playing ? 'none' : '';
    if (pauseIcon) pauseIcon.style.display = playing ? '' : 'none';
    if (playPauseBtn) playPauseBtn.title = playing ? 'Pause' : 'Play';
    if (nowPlayingBar) nowPlayingBar.classList.toggle('playing', playing);
    
    // Sync with Apple Orb, Dynamic Island & MediaSession
    AppleOrbController.setPlaying(playing);
    DynamicIslandHeaderManager.setPlaying(playing);
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    }
  }

  /* ----------------------------------------------------------------
     Shuffle bookkeeping.

     Picking a random index every time replayed tracks while others never came
     up at all, never stopped when repeat was off, and left Prev with no idea
     what had actually been played. A bag of unplayed ids fixes the first two;
     playOrderHistory fixes Prev.
     ---------------------------------------------------------------- */
  let playOrderHistory = [];  // song ids in the order they really played
  let shuffleBag = [];        // ids not yet played in this shuffle cycle

  function resetShuffleBag(excludeId) {
    shuffleBag = queue.map(s => s.id).filter(id => id && id !== excludeId);
  }

  function noteSongPlayed(song) {
    if (!song || !song.id) return;
    if (playOrderHistory[playOrderHistory.length - 1] !== song.id) playOrderHistory.push(song.id);
    if (playOrderHistory.length > 200) playOrderHistory.shift();
    const bi = shuffleBag.indexOf(song.id);
    if (bi !== -1) shuffleBag.splice(bi, 1);
  }

  // Appends fresh recommendations and keeps playing. Returns true if it has
  // taken responsibility for what plays next (asynchronously).
  function tryAutoQueue() {
    // Fall back to the stored value: the checkbox is the source of truth while
    // the page is up, but it may not exist yet on very early track ends.
    const el = $('#settingAutoQueue');
    const enabled = el ? el.checked : Storage.get('autoQueue', true) !== false;
    if (!enabled || !currentSong) return false;
    const startedFor = currentSong;
    toast('♾️ Endless Auto-Queue: Loading next tracks...');
    loadRecommendations(true).then(() => {
      // The user can pick another track or clear the queue while the fetch is in
      // flight. The old code captured an index up front and played queue[n]
      // afterwards, which by then pointed at the wrong slot — or at undefined,
      // silently ending playback right after promising the next track.
      if (currentSong !== startedFor) return;
      const fresh = recommendedSongs.filter(s => s && s.id && !queue.some(q => q.id === s.id));
      if (fresh.length) {
        queue.push(...fresh);
        if (isShuffle) shuffleBag.push(...fresh.map(s => s.id));
        updateQueueUI();
        playSong(fresh[0]);
        return;
      }
      if (repeatMode === 'all' && queue.length) playSong(queue[0]);
      else toast('Nothing more to play — try a search to keep going');
    }).catch(() => toast('Could not load more tracks'));
    return true;
  }

  function playNext() {
    if (!queue.length) return;

    if (isShuffle) {
      // Ids can leave the queue between picks (remove / clear).
      shuffleBag = shuffleBag.filter(id => queue.some(s => s.id === id));
      if (!shuffleBag.length) {
        // Every track in the queue has now been played once. Shuffle used to
        // ignore repeatMode entirely and walk randomly forever.
        if (repeatMode === 'all') resetShuffleBag(currentSong && currentSong.id);
        else if (tryAutoQueue()) return;
        else { audioPlayer.pause(); toast('🔀 Shuffle finished — every track played'); return; }
      }
      if (!shuffleBag.length) { audioPlayer.pause(); return; }
      const pickId = shuffleBag[Math.floor(Math.random() * shuffleBag.length)];
      const next = queue.find(s => s.id === pickId);
      if (next) playSong(next);
      return;
    }

    const n = currentIndex + 1;
    if (n < queue.length) { playSong(queue[n]); return; }

    // End of the queue. An explicit Repeat All has to win over auto-queue —
    // auto-queue is on by default, so its early `return` meant Repeat ALL never
    // actually looped a playlist, it appended unrelated recommendations instead.
    if (repeatMode === 'all') { playSong(queue[0]); return; }
    if (tryAutoQueue()) return;
    audioPlayer.pause();
  }

  function playPrev() {
    if (!queue.length) return;
    if (audioPlayer.currentTime > 3) { audioPlayer.currentTime = 0; return; }

    // With shuffle on, the previous track is whatever actually played before —
    // not queue[currentIndex - 1], which is a track the user probably never heard.
    if (isShuffle) {
      for (let i = playOrderHistory.length - 2; i >= 0; i--) {
        const prev = queue.find(s => s.id === playOrderHistory[i]);
        if (prev) {
          // Rewind the trail so pressing Prev repeatedly keeps walking back
          // instead of bouncing between two tracks.
          playOrderHistory.length = i;
          playSong(prev);
          return;
        }
      }
      audioPlayer.currentTime = 0;
      return;
    }

    const p = currentIndex - 1;
    if (p >= 0) playSong(queue[p]);
    else if (repeatMode === 'all') playSong(queue[queue.length - 1]);
    else audioPlayer.currentTime = 0;
  }

  function onEnd() {
    recordListenTime();
    // The sleep timer's "stop after this track" mode has to be checked here.
    // Its own 'ended' listener runs *after* this one, so playNext() had already
    // started the following track before the timer paused it.
    if (SleepTimerManager.consumeStopAfterTrack()) return;
    if (repeatMode === 'one') {
      audioPlayer.currentTime = 0;
      // recordListenTime() above closed the listening clock. Reopen it so a
      // track on repeat keeps accruing minutes instead of counting only once,
      // and go through startPlayback so a suspended audio context is resumed.
      playStartTime = Date.now();
      startPlayback(currentSong || {});
    }
    else playNext();
  }

  async function onAudioError() {
    const song = currentSong;
    if (!song) return;

    // MEDIA_ERR_ABORTED is what the browser reports when the src is swapped
    // while the previous one was still loading — i.e. every ordinary skip.
    // Treating it as a playback failure burned through the retry budget and
    // then force-skipped the track the user had just chosen.
    const code = audioPlayer.error && audioPlayer.error.code;
    if (code === 1 /* MEDIA_ERR_ABORTED */) return;
    if (!audioPlayer.getAttribute('src')) return;

    // Everything below can hand control back to the event loop, so each branch
    // re-checks that this is still the track being played.
    if (song.isCloud) {
      let freshUrl = null;
      try { freshUrl = await CloudMusicEngine.getStreamUrl(song.id); } catch (e) {}
      if (currentSong !== song) return;
      if (freshUrl && freshUrl !== audioPlayer.src) {
        song.streamUrl = freshUrl;
        audioPlayer.src = freshUrl;
        startPlayback(song);
        return;
      }
      audioRetryCount = 0;
      toast(`Playback is unavailable for "${(song.title || 'track').slice(0, 20)}". Trying the next track...`);
      setTimeout(() => { if (currentSong === song) playNext(); }, 1000);
      return;
    }

    if (song.isLocal) {
      audioRetryCount = 0;
      toast(`Your browser could not play "${(song.title || 'local track').slice(0, 20)}".`);
      return;
    }

    if (audioRetryCount < 3) {
      audioRetryCount++;
      const fallbackQuality = audioRetryCount === 1 ? 'low' : 'high';
      audioPlayer.src = `/api/stream/${song.id}?quality=${fallbackQuality}&retry=${audioRetryCount}&t=${Date.now()}`;
      startPlayback(song);
      return;
    }

    audioRetryCount = 0;
    toast(`⚠️ Playback issue on "${(song.title || 'track').slice(0, 20)}", skipping to next...`);
    setTimeout(() => { if (currentSong === song) playNext(); }, 1000);
  }

  function onTimeUpdate() {
    if (isSeeking) return;
    const c = audioPlayer.currentTime, d = audioPlayer.duration || 0;
    npCurrentTime.textContent = fmtTime(c);
    if (d > 0) { const p = (c / d) * 100; npProgressFill.style.width = p + '%'; npProgressThumb.style.left = p + '%'; }
    
    // Sync with Apple Orb & Lyrics
    AppleOrbController.updateProgress(c, d);
    syncLyrics(c);
    ResumeManager.note();
    CrossfadeManager.tick();
  }

  function onMeta() {
    npDuration.textContent = fmtTime(audioPlayer.duration);
    // Duration is only known now, so a pending resume seek can finally be
    // validated and applied.
    ResumeManager.applyPendingSeek();
  }

  /* ================================================================
     RESUME + AUTOPLAY
     Lets the desktop shortcut open straight into whatever was playing
     when the app was last closed, at the second it stopped.
     ================================================================ */
  const ResumeManager = {
    pendingSeek: null,
    lastSaveAt: 0,
    fadeTimer: null,

    // Called from onTimeUpdate, which fires ~4x a second. localStorage writes
    // are synchronous, so this is throttled hard.
    note() {
      const now = Date.now();
      if (now - this.lastSaveAt < 5000) return;
      this.lastSaveAt = now;
      this.save();
    },

    save() {
      if (!currentSong || !currentSong.id) return;
      const song = Object.assign({}, currentSong);
      // A local file's blob URL dies with the document; LocalFileManager mints
      // a fresh one from IndexedDB on demand, so it must not be persisted.
      delete song.streamUrl;
      Storage.setLocal('resume', {
        song,
        position: Number(audioPlayer.currentTime) || 0,
        duration: Number(audioPlayer.duration) || 0,
        savedAt: Date.now()
      });
    },

    applyPendingSeek() {
      const target = this.pendingSeek;
      if (target == null) return;
      this.pendingSeek = null;
      const dur = Number(audioPlayer.duration) || 0;
      if (!dur || !isFinite(dur)) return;
      // Never resume inside the last 15 seconds. Landing on a fade-out and
      // immediately skipping is worse than starting the track over.
      if (target > 0 && target < dur - 15) {
        try { audioPlayer.currentTime = target; } catch (e) {}
      }
    },

    // Ramp up from silence so a track resuming mid-phrase does not slam in.
    fadeIn(ms) {
      clearInterval(this.fadeTimer);
      const target = steadyVolume();
      const steps = 24;
      let i = 0;
      this.fadeTimer = setInterval(() => {
        i++;
        audioPlayer.volume = Math.max(0, Math.min(target, (target * i) / steps));
        if (i >= steps) {
          clearInterval(this.fadeTimer);
          this.fadeTimer = null;
          audioPlayer.volume = target;
        }
      }, Math.max(10, Math.floor(ms / steps)));
    },

    wantsAutoplay() {
      try {
        if (new URLSearchParams(location.search).has('autoplay')) return true;
      } catch (e) {}
      return /(^|[#&])autoplay\b/.test(location.hash || '');
    },

    autoplay() {
      const saved = Storage.get('resume', null);
      if (saved && saved.song && saved.song.id) {
        this.start(saved.song, Number(saved.position) || 0);
        return;
      }
      // Nothing to resume — fall back to the most recently played track so the
      // shortcut still starts music. If even that is empty (fresh install),
      // stay silent rather than playing something arbitrary.
      const hist = validHistory();
      if (hist.length) this.start(hist[0].song, 0);
    },

    start(song, position) {
      if (!song || !song.id) return;
      this.pendingSeek = position > 5 ? position : null;

      // Silence before the first sample, then fade up once audio truly starts.
      audioPlayer.volume = 0;
      const onPlaying = () => {
        audioPlayer.removeEventListener('playing', onPlaying);
        this.fadeIn(900);
      };
      audioPlayer.addEventListener('playing', onPlaying);

      // Safety net: if playback never starts — blocked autoplay, dead stream,
      // missing local file — restore the volume. Leaving a silent player behind
      // a full-looking slider is exactly the sleep-timer bug all over again.
      setTimeout(() => {
        if (!this.fadeTimer && audioPlayer.paused) {
          audioPlayer.removeEventListener('playing', onPlaying);
          audioPlayer.volume = steadyVolume();
        }
      }, 8000);

      playSong(song);
    }
  };

  /* ================================================================
     CROSSFADE  (Settings → Crossfade, 0–3 s)

     Fades the outgoing track's last N seconds down to silence and brings the
     incoming track's first N seconds back up, so a track change has no abrupt
     cut and no silent gap.

     Deliberately a *single-element* fade rather than two overlapping <audio>
     elements, which is the textbook implementation:
       - EqualizerManager calls createMediaElementSource(audioPlayer) once and
         that binding can never be re-pointed or undone. A second element would
         silently lose the EQ, bass boost and spatial audio — no error, just a
         flat sound on every other track.
       - The transcode branch of /api/stream answers with Accept-Ranges: none,
         so seeking a second element to the outgoing position is unreliable, and
         would fail differently for local blobs, cloud URLs and transcodes.
       - All 81 audioPlayer references would have to learn which element is
         live, against the explicit "do not change existing playback logic
         unnecessarily".

     The ramp moves a gain *factor* (0..1) on top of the user's own volume
     instead of writing absolute levels, so dragging the slider or hitting mute
     mid-fade still wins and there is no stale target to restore.
     ================================================================ */

  function clampCrossfadeSeconds(v) {
    // Number('') is 0 and Number('x') is NaN; both mean "off".
    const n = Math.round(Number(v) || 0);
    return n > 0 ? Math.min(3, n) : 0;
  }

  const CrossfadeManager = {
    seconds: 0,
    fadeTimer: null,
    // 'out' = tail fading down, 'in' = head rising, 'idle' = not our business.
    phase: 'idle',
    // The next playSong() should rise from silence.
    _fadeInArmed: false,
    // A crossfade — not the user, not ResumeManager, not the sleep timer — is
    // what put the element volume below the slider. Only then may we restore.
    _leftVolumeLow: false,
    _onPlaying: null,
    _safetyTimer: null,

    init() {
      this.seconds = clampCrossfadeSeconds(Storage.get('crossfade', 0));
      const el = $('#settingCrossfade');
      if (el) {
        el.value = String(this.seconds);
        // 'input', not 'change': the label has to follow the thumb.
        el.addEventListener('input', (e) => this.set(e.target.value));
      }
      this.updateLabel();
    },

    isOn() { return this.seconds > 0; },

    set(v) {
      this.seconds = clampCrossfadeSeconds(v);
      Storage.set('crossfade', this.seconds);
      this.updateLabel();
      // Switching it off halfway through a fade would strand the track silent.
      if (!this.isOn()) this.cancel();
    },

    updateLabel() {
      const label = $('#crossfadeValLabel');
      if (label) label.textContent = this.isOn() ? `${this.seconds}s` : 'Off';
      const el = $('#settingCrossfade');
      if (el && el.value !== String(this.seconds)) el.value = String(this.seconds);
    },

    clearRamp() {
      if (this.fadeTimer) { clearInterval(this.fadeTimer); this.fadeTimer = null; }
    },

    // from/to are gain factors in 0..1, multiplied by the live steady volume on
    // every step. One interval at a time, always cleared, always settling exactly
    // on `to` — a ramp that stops one step early leaves audible residue.
    rampTo(from, to, ms, done) {
      this.clearRamp();
      const steps = Math.max(4, Math.min(60, Math.round(ms / 40)));
      const apply = (f) => {
        try { audioPlayer.volume = Math.max(0, Math.min(1, f * steadyVolume())); } catch (e) {}
      };
      let i = 0;
      apply(from);
      this.fadeTimer = setInterval(() => {
        i++;
        if (i >= steps) {
          this.clearRamp();
          apply(to);
          if (done) done();
          return;
        }
        apply(from + (to - from) * (i / steps));
      }, Math.max(20, Math.round(ms / steps)));
    },

    // Restores only when a crossfade is what lowered the volume. Restoring
    // unconditionally would clobber ResumeManager.start(), which sets volume 0
    // on purpose and runs its own fade-in.
    restoreIfLowered() {
      if (!this._leftVolumeLow) return;
      this._leftVolumeLow = false;
      try { audioPlayer.volume = steadyVolume(); } catch (e) {}
    },

    // One-shot listener + safety timer are held on the instance so a rapid run
    // of skips cannot pile up duplicates or leave a stale timer behind.
    detachPlaying() {
      if (this._onPlaying) {
        audioPlayer.removeEventListener('playing', this._onPlaying);
        this._onPlaying = null;
      }
      if (this._safetyTimer) { clearTimeout(this._safetyTimer); this._safetyTimer = null; }
    },

    cancel() {
      this.clearRamp();
      this.detachPlaying();
      this.phase = 'idle';
      this._fadeInArmed = false;
      this.restoreIfLowered();
    },

    // Called from onTimeUpdate (~4x/sec), so the common "nowhere near the end"
    // case must cost nothing: a few numeric comparisons and no allocation.
    tick() {
      if (!this.isOn()) return;
      // Repeat-one re-plays the same file, so there is no incoming track. Fading
      // here would just dip to silence once per lap.
      if (repeatMode === 'one') { if (this.phase === 'out') this.cancel(); return; }
      // The sleep timer runs its own minute-long fade on this same element. Two
      // ramps sharing one volume land wherever the last interval happened to
      // fire, so the later feature yields to the one already running.
      if (SleepTimerManager.fadeInterval) return;
      if (audioPlayer.paused) return;

      const d = Number(audioPlayer.duration);
      const c = Number(audioPlayer.currentTime);
      // Live streams report Infinity, a fresh element reports NaN.
      if (!isFinite(d) || d <= 0 || !isFinite(c)) return;
      const remaining = d - c;

      if (remaining > this.seconds + 0.25) {
        // Seeked back out of the tail: stop and undo the dip, or the rest of the
        // track plays silent.
        if (this.phase === 'out') this.cancel();
        return;
      }
      if (this.phase !== 'idle') return;
      // Under ~150ms there is no room for a fade, only for a click.
      if (remaining <= 0.15) return;
      if (!this.hasFollowUp()) return;

      this.phase = 'out';
      this._fadeInArmed = true;
      this._leftVolumeLow = true;
      this.rampTo(1, 0, Math.max(150, remaining * 1000));
    },

    // Nothing after this track means playback simply stops, and fading out would
    // clip the ending for no reason. Mirrors how tryAutoQueue() resolves the
    // auto-queue setting: the checkbox while the page is up, storage otherwise.
    hasFollowUp() {
      if (repeatMode === 'all') return queue.length > 0;
      if (isShuffle) return shuffleBag.length > 0;
      if (currentIndex >= 0 && currentIndex < queue.length - 1) return true;
      const el = $('#settingAutoQueue');
      return el ? !!el.checked : Storage.get('autoQueue', true) !== false;
    },

    onTrackStart(song) {
      this.clearRamp();
      this.detachPlaying();
      const armed = this._fadeInArmed && this.isOn() && !audioPlayer.muted;
      this._fadeInArmed = false;
      if (!armed) {
        this.phase = 'idle';
        // Covers the track *after* a fade that never got its fade-in (dead
        // stream, blocked autoplay): without this it would play at volume 0.
        this.restoreIfLowered();
        return;
      }

      this.phase = 'in';
      this._leftVolumeLow = true;
      try { audioPlayer.volume = 0; } catch (e) {}
      const onPlaying = () => {
        this.detachPlaying();
        // Skipped again while this one was still buffering.
        if (currentSong !== song) { this.phase = 'idle'; this.restoreIfLowered(); return; }
        this.rampTo(0, 1, this.seconds * 1000, () => {
          this.phase = 'idle';
          this._leftVolumeLow = false;
        });
      };
      this._onPlaying = onPlaying;
      audioPlayer.addEventListener('playing', onPlaying);
      // Safety net: if audio never starts at all, put the volume back rather
      // than leaving a silent player behind a full-looking slider.
      this._safetyTimer = setTimeout(() => {
        this._safetyTimer = null;
        if (this.phase === 'in' && !this.fadeTimer) {
          this.detachPlaying();
          this.phase = 'idle';
          this.restoreIfLowered();
        }
      }, 8000);
    },

    onPause() {
      // Some browsers pause the element as it ends. That pause *is* the
      // crossfade boundary — cancelling here would disarm the fade-in the next
      // track is about to use.
      if (audioPlayer.ended) return;
      // playSong() deliberately pauses before swapping src on the local and
      // cloud paths, which fires 'pause' *after* the fade-in was set up.
      // Cancelling on that would undo the fade for exactly those two sources —
      // and a real user pause during a fade-in needs no handling either: the
      // ramp finishes at the user's own level, which is where it was heading.
      if (this.phase === 'in') return;
      this.cancel();
    },

    onPlay() {
      // A fade-in already set up owns the volume; leave it alone.
      if (this.phase === 'in') return;
      // Otherwise this is the user restarting a track we had faded to silence
      // (last in the queue, or a skip that failed). That path is
      // togglePlayPause -> startPlayback, which never touches playSong, so
      // without this the player stays mute behind a full slider.
      this.cancel();
    }
  };


  // Shuffle & Repeat
  function toggleShuffle() {
    isShuffle = !isShuffle;
    $('#shuffleBtn')?.classList.toggle('active', isShuffle);
    Storage.set('shuffle', isShuffle);
    // Start a fresh cycle so turning shuffle on plays everything else in the
    // queue once before repeating anything.
    if (isShuffle) resetShuffleBag(currentSong && currentSong.id);
    else shuffleBag = [];
    if (isMobileSheetOpen()) reflectMobileSheetState();
    toast(isShuffle ? 'Shuffle ON' : 'Shuffle OFF');
  }

  function toggleRepeat() {
    const modes = ['off', 'all', 'one'];
    repeatMode = modes[(modes.indexOf(repeatMode) + 1) % 3];
    $('#repeatBtn')?.classList.toggle('active', repeatMode !== 'off');
    Storage.set('repeat', repeatMode);
    updateRepeatIcon();
    if (isMobileSheetOpen()) reflectMobileSheetState();
    toast('Repeat: ' + repeatMode.toUpperCase());
  }

  function updateRepeatIcon() {
    const btn = $('#repeatBtn');
    if (!btn) return;
    if (repeatMode === 'one') btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><text x="12" y="16" text-anchor="middle" fill="currentColor" stroke="none" font-size="9" font-weight="bold">1</text></svg>`;
    else btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`;
  }

  // Volume
  // Where the element volume belongs when nothing is fading. `muted` and the
  // slider were combined by hand in four places; a fade that read one of them
  // wrong is silent, so there is now exactly one definition.
  function steadyVolume() {
    return audioPlayer && audioPlayer.muted ? 0 : volume;
  }

  function toggleMute() {
    audioPlayer.muted = !audioPlayer.muted;
    // Any fade (crossfade, resume, sleep timer) can leave the element volume at
    // or near zero, which `muted` hides completely. Unmuting would then appear
    // to do nothing at all, so put the user's level back on the way out.
    if (!audioPlayer.muted) audioPlayer.volume = volume;
    setMuteIcon(audioPlayer.muted);
    updateVolumeUI();
  }


  function setMuteIcon(muted) {
    const on = $('.vol-on-icon'), off = $('.vol-off-icon');
    if (on) on.style.display = muted ? 'none' : '';
    if (off) off.style.display = muted ? '' : 'none';
    setMobileMuteIcon(muted);
  }

  function updateVolumeUI() {
    const v = steadyVolume();
    if (npVolumeFill) npVolumeFill.style.width = (v * 100) + '%';
    if (npVolumeThumb) npVolumeThumb.style.left = (v * 100) + '%';
    const mobile = $('#mobileVolumeRange');
    if (mobile) mobile.value = String(Math.round(v * 100));
  }

  function startVolChange(e) {
    e.preventDefault(); updateVolEvt(e);
    // touchmove has to be non-passive and preventDefault, or the page scrolls
    // underneath the finger while the slider is being dragged.
    const mv = (ev) => { if (ev.cancelable) ev.preventDefault(); updateVolEvt(ev); };
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); document.removeEventListener('touchmove', mv); document.removeEventListener('touchend', up); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    document.addEventListener('touchmove', mv, { passive: false }); document.addEventListener('touchend', up);
  }

  function updateVolEvt(e) {
    const r = npVolumeBar.getBoundingClientRect();
    const x = e.touches ? e.touches[0].clientX : e.clientX;
    volume = Math.max(0, Math.min(1, (x - r.left) / r.width));
    audioPlayer.volume = volume; audioPlayer.muted = false;
    setMuteIcon(false);
    updateVolumeUI(); Storage.set('volume', volume);
  }

  // Shared by the keyboard shortcuts and the mobile volume slider so all three
  // entry points clear mute and repaint the icon the same way.
  function setVolume(v) {
    volume = Math.max(0, Math.min(1, v));
    audioPlayer.volume = volume;
    // Nudging the volume while muted used to appear to do nothing at all:
    // updateVolumeUI() reports 0 whenever muted is set.
    if (volume > 0 && audioPlayer.muted) { audioPlayer.muted = false; setMuteIcon(false); }
    updateVolumeUI();
    Storage.set('volume', volume);
  }

  // Seeking
  function startSeek(e) {
    e.preventDefault(); isSeeking = true; seekEvt(e);
    const mv = (ev) => { if (ev.cancelable) ev.preventDefault(); seekEvt(ev); };
    const up = () => { isSeeking = false; document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); document.removeEventListener('touchmove', mv); document.removeEventListener('touchend', up); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    document.addEventListener('touchmove', mv, { passive: false }); document.addEventListener('touchend', up);
  }

  function seekEvt(e) {
    const r = npProgressBar.getBoundingClientRect();
    const x = e.touches ? e.touches[0].clientX : e.clientX;
    const p = Math.max(0, Math.min(1, (x - r.left) / r.width));
    npProgressFill.style.width = (p * 100) + '%'; npProgressThumb.style.left = (p * 100) + '%';
    const d = audioPlayer.duration || 0;
    if (d > 0) { audioPlayer.currentTime = p * d; npCurrentTime.textContent = fmtTime(audioPlayer.currentTime); }
  }

  function updateQualityLabel() { $('#qualityLabel').textContent = audioQuality === 'high' ? 'HQ' : 'LQ'; }

  /* ================================================================
     LIKES / DISLIKES
     ================================================================ */
  function isLiked(id) { return likedSongs.some(s => s.id === id); }
  function isDisliked(id) { return dislikedSongs.some(s => s.id === id); }

  function toggleLike(song) {
    if (!song || !song.id) return;
    if (isLiked(song.id)) {
      likedSongs = likedSongs.filter(s => s.id !== song.id);
      toast('Removed from Likes');
    } else {
      likedSongs.unshift(song);
      // Liking something previously disliked has to clear the dislike, otherwise
      // it stays suppressed from recommendations while showing a filled heart.
      if (isDisliked(song.id)) {
        dislikedSongs = dislikedSongs.filter(s => s.id !== song.id);
        Storage.set('dislikes', dislikedSongs);
      }
      toast('❤️ Added to Likes');
    }
    Storage.set('likes', likedSongs);
    updateLikeBtn();
    reflectLikeStateInDom(song.id);
  }

  // Dislike is a signal, not a delete: the track keeps playing but stops being
  // suggested. Skipping immediately would make the button feel like a Next button.
  function toggleDislike(song) {
    if (!song || !song.id) return;
    if (isDisliked(song.id)) {
      dislikedSongs = dislikedSongs.filter(s => s.id !== song.id);
      toast('Removed from Dislikes');
    } else {
      dislikedSongs.unshift(song);
      if (dislikedSongs.length > 300) dislikedSongs = dislikedSongs.slice(0, 300);
      if (isLiked(song.id)) {
        likedSongs = likedSongs.filter(s => s.id !== song.id);
        Storage.set('likes', likedSongs);
      }
      toast('👎 Won’t suggest this again');
    }
    Storage.set('dislikes', dislikedSongs);
    updateLikeBtn();
    reflectLikeStateInDom(song.id);
  }

  // The same card markup is rendered into #recommendedGrid, #recentlyPlayedGrid,
  // #tasteGrid, #likedResultsGrid, #moodResultsGrid and #activePlaylistGrid, but
  // only #resultsGrid was ever re-rendered after a like. Everywhere else the
  // heart never changed, so users clicked again and silently re-toggled.
  // Updating the buttons in place also avoids re-rendering (and scroll-jumping)
  // every visible grid.
  function reflectLikeStateInDom(songId) {
    const liked = isLiked(songId);
    const disliked = isDisliked(songId);
    document.querySelectorAll(`.result-card[data-id="${escId(songId)}"] [data-action="like"]`).forEach(btn => {
      btn.classList.toggle('liked', liked);
      const svg = btn.querySelector('svg');
      if (svg) svg.setAttribute('fill', liked ? 'currentColor' : 'none');
    });
    document.querySelectorAll(`.result-card[data-id="${escId(songId)}"] [data-action="dislike"]`).forEach(btn => {
      btn.classList.toggle('disliked', disliked);
      const svg = btn.querySelector('svg');
      if (svg) svg.setAttribute('fill', disliked ? 'currentColor' : 'none');
    });
    // Counters that quietly went stale alongside the hearts.
    const lc = $('#likedCount');
    if (lc) lc.textContent = `${likedSongs.length} song${likedSongs.length === 1 ? '' : 's'}`;
    const sl = $('#statLiked');
    if (sl) sl.textContent = likedSongs.length;

    // Liked Songs is a view *of* the like list, so a removal has to drop the card.
    const likedSection = $('#likedSongsListSection');
    if (likedSection && likedSection.style.display !== 'none') {
      const grid = $('#likedResultsGrid');
      if (grid) renderRecommendationCards(grid, likedSongs, { emptyMessage: 'No liked songs yet. Tap the heart on any track.' });
    }
    if (searchResults.length) renderResults(searchResults);
  }

  function updateLikeBtn() {
    const btn = $('#npLikeBtn');
    if (btn && currentSong) btn.classList.toggle('liked', isLiked(currentSong.id));
    const dbtn = $('#npDislikeBtn');
    if (dbtn && currentSong) dbtn.classList.toggle('disliked', isDisliked(currentSong.id));
    if (isMobileSheetOpen()) reflectMobileSheetState();
  }

  function showLikedSongs() {
    const section = $('#likedSongsListSection');
    const grid = $('#likedResultsGrid');
    if (!section || !grid) return;
    if (section.style.display === 'none') {
      section.style.display = '';
      renderRecommendationCards(grid, likedSongs);
    } else {
      section.style.display = 'none';
    }
  }

  function playLikedSongs() {
    if (!likedSongs.length) { toast('No liked songs'); return; }
    queue = [...likedSongs]; currentIndex = -1;
    updateQueueUI(); playSong(queue[0]);
  }

  /* ================================================================
     PLAYLISTS
     ================================================================ */
  let currentPlaylistId = null;

  function openCreatePlaylist() {
    $('#playlistModalTitle').textContent = 'Create Playlist';
    $('#playlistNameInput').value = '';
    $('#playlistSaveBtn').textContent = 'Create';
    $('#playlistModal').style.display = '';
    $('#playlistNameInput').focus();
  }

  function savePlaylist() {
    const name = $('#playlistNameInput').value.trim();
    if (!name) return;
    const pl = { id: 'pl_' + Date.now(), name, songs: [] };
    playlists.push(pl);
    Storage.set('playlists', playlists);
    $('#playlistModal').style.display = 'none';
    renderLibrary();
    toast('Playlist created: ' + name);
  }

  function openAddToPlaylist(song) {
    addToPlaylistSong = song;
    const list = $('#playlistSelectList');
    if (!playlists.length) {
      list.innerHTML = '<p class="empty-msg">No playlists. Create one first!</p>';
    } else {
      list.innerHTML = playlists.map(pl => `<div class="playlist-select-item" data-plid="${escId(pl.id)}"><span class="psi-icon">📂</span><span class="psi-name">${esc(pl.name)} (${pl.songs.length})</span></div>`).join('');
      list.querySelectorAll('.playlist-select-item').forEach(item => {
        item.addEventListener('click', () => {
          const pl = playlists.find(p => p.id === item.dataset.plid);
          if (pl) {
            if (pl.songs.some(s => s.id === addToPlaylistSong.id)) { toast('Already in playlist'); }
            else {
              pl.songs.push(addToPlaylistSong);
              Storage.set('playlists', playlists);
              toast('Added to ' + pl.name);
              // Nothing here refreshed the UI, so the "N songs" count on the
              // playlist card and the open playlist grid both kept showing the
              // old contents. syncPlaylistCardCount exists for exactly this and
              // updates .pc-count in place (renderLibrary would force-hide the
              // active playlist section).
              syncPlaylistCardCount(pl);
              if (currentPlaylistId === pl.id) renderActivePlaylist();
            }
          }
          $('#addToPlaylistModal').style.display = 'none';
        });
      });
    }
    $('#addToPlaylistModal').style.display = '';
  }

  function showPlaylistDetail(plId) {
    const pl = playlists.find(p => p.id === plId);
    if (!pl) return;
    currentPlaylistId = plId;

    // Otherwise the Liked Songs list stays open above and it is unclear which
    // list the buttons below act on.
    const likedSec = $('#likedSongsListSection');
    if (likedSec) likedSec.style.display = 'none';

    const sec = $('#activePlaylistSection');
    if (!sec) return;
    sec.style.display = '';
    renderActivePlaylist();
    // The section sits below the playlist grid, so on a short window a click
    // could otherwise appear to do nothing at all.
    try { sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { sec.scrollIntoView(); }
  }

  /**
   * Redraws the open playlist in place. Split out from showPlaylistDetail
   * because removing a song has to refresh the grid without re-running the
   * scroll — being yanked back to the top after every removal would be awful.
   *
   * Re-rendering after each change is also what keeps removal accurate: the
   * cards carry their array index, so stale indices would delete the wrong row.
   */
  function renderActivePlaylist() {
    const pl = playlists.find(p => p.id === currentPlaylistId);
    if (!pl) return null;

    const title = $('#activePlaylistTitle');
    if (title) title.textContent = '📂 ' + pl.name;

    const count = $('#activePlaylistCount');
    if (count) count.textContent = pl.songs.length === 1 ? '1 song' : `${pl.songs.length} songs`;

    const grid = $('#activePlaylistGrid');
    if (grid) {
      renderRecommendationCards(grid, pl.songs, {
        removable: true,
        emptyMessage: 'Nothing in this playlist yet. Add songs from Home or Search using the + button on any card.',
      });
    }

    syncPlaylistCardCount(pl);
    return pl;
  }

  /**
   * Keeps the "N songs" label on the library grid card in step with the open
   * playlist. renderLibrary() would do this too, but it also force-hides the
   * detail section — calling it here would slam the playlist shut on every
   * removal.
   */
  function syncPlaylistCardCount(pl) {
    const grid = $('#playlistGrid');
    if (!grid || !pl) return;
    const card = grid.querySelector(`.playlist-card[data-plid="${escId(pl.id)}"] .pc-count`);
    if (card) card.textContent = pl.songs.length + ' songs';
  }

  /**
   * Removing a song re-renders the grid, which slides the *next* song's card
   * up under the cursor. A double click — or an impatient second click — would
   * then delete a second, different song that the user never aimed at. Ignoring
   * a repeat within this window costs nothing (a deliberate second removal
   * still works a moment later) and prevents that.
   */
  const PLAYLIST_REMOVE_GUARD_MS = 350;
  let lastPlaylistRemoveAt = 0;

  /**
   * Removes one song from the currently open playlist.
   *
   * Takes the rendered index *and* the expected song so the two can be
   * cross-checked. Index alone is wrong if the array shifted under us; id alone
   * is wrong if the same track appears twice (older data can contain duplicates
   * even though both add paths now dedupe). Index-with-verification is the only
   * option that is right in both cases.
   */
  function removeSongFromPlaylist(idx, expected) {
    const pl = playlists.find(p => p.id === currentPlaylistId);
    if (!pl) { toast('No playlist is open'); return; }
    if (!expected || !expected.id) { toast('Could not identify that track'); return; }

    const now = Date.now();
    if (now - lastPlaylistRemoveAt < PLAYLIST_REMOVE_GUARD_MS) return;

    let at = (pl.songs[idx] && pl.songs[idx].id === expected.id)
      ? idx
      : pl.songs.findIndex(s => s && s.id === expected.id);

    if (at < 0) {
      // Already gone — most likely a double click on the same button. Resync
      // rather than removing something else by mistake.
      renderActivePlaylist();
      toast('That track is no longer in this playlist');
      return;
    }

    lastPlaylistRemoveAt = now;
    const [removed] = pl.songs.splice(at, 1);
    Storage.set('playlists', playlists);
    renderActivePlaylist();

    // Undo instead of a confirm dialog: removal is one click on a small button
    // next to four others, so it needs to be reversible, but a prompt on every
    // single removal would make clearing out a playlist miserable.
    const label = (removed && removed.title) ? removed.title : 'Track';
    undoToast(`Removed ${label.length > 42 ? label.slice(0, 42) + '…' : label}`, () => {
      const target = playlists.find(p => p.id === pl.id);
      if (!target) { toast('That playlist no longer exists'); return; }
      if (target.songs.some(s => s && s.id === removed.id)) { toast('Already back in the playlist'); return; }
      // Restore to where it was, not to the end, so undo really is an undo.
      target.songs.splice(Math.min(at, target.songs.length), 0, removed);
      // Undoing means the user is still working in this list; don't make them
      // wait out the double-click guard before they can remove something else.
      lastPlaylistRemoveAt = 0;
      Storage.set('playlists', playlists);
      if (currentPlaylistId === target.id) renderActivePlaylist();
      else { syncPlaylistCardCount(target); renderLibrary(); }
      toast('Restored');
    });
  }

  function playCurrentPlaylist() {
    const pl = playlists.find(p => p.id === currentPlaylistId);
    if (!pl || !pl.songs.length) { toast('Playlist is empty'); return; }
    queue = [...pl.songs]; currentIndex = -1;
    updateQueueUI(); playSong(queue[0]);
  }

  function deleteCurrentPlaylist() {
    const pl = playlists.find(p => p.id === currentPlaylistId);
    if (!pl) { toast('No playlist selected'); return; }
    // Deleting is irreversible and the button sits next to Play/Download, so it
    // asks first rather than silently discarding a playlist on a stray click.
    if (!confirm(`Delete the playlist "${pl.name}"? This cannot be undone.`)) return;
    playlists = playlists.filter(p => p.id !== currentPlaylistId);
    Storage.set('playlists', playlists);
    currentPlaylistId = null;
    const sec = $('#activePlaylistSection');
    if (sec) sec.style.display = 'none';
    renderLibrary();
    toast('Playlist deleted');
  }

  function renderLibrary() {
    $('#likedCount').textContent = likedSongs.length + ' songs';
    const likedSec = $('#likedSongsListSection');
    if (likedSec) likedSec.style.display = 'none';
    const activePlSec = $('#activePlaylistSection');
    if (activePlSec) activePlSec.style.display = 'none';

    const grid = $('#playlistGrid');
    if (grid) {
      if (!playlists.length) {
        grid.innerHTML = '<p class="empty-msg" id="noPlaylists">No playlists yet. Create one!</p>';
      } else {
        grid.innerHTML = playlists.map(pl => `<div class="playlist-card" data-plid="${pl.id}"><div class="pc-icon">📂</div><div class="pc-name">${esc(pl.name)}</div><div class="pc-count">${pl.songs.length} songs</div></div>`).join('');
        grid.querySelectorAll('.playlist-card').forEach(c => {
          c.addEventListener('click', () => showPlaylistDetail(c.dataset.plid));
        });
      }
    }

    renderLocalSongs();
    applyLibraryFilter();
  }

  // Imported local tracks were pushed into the queue and nowhere else, so after
  // a reload they sat in storage with no way to reach them.
  function renderLocalSongs() {
    const section = $('#localSongsSection');
    const grid = $('#localSongsGrid');
    if (!section || !grid) return;

    const songs = (typeof LocalFileManager !== 'undefined' && Array.isArray(LocalFileManager.localSongs))
      ? LocalFileManager.localSongs : [];

    if (!songs.length) { section.style.display = 'none'; grid.innerHTML = ''; return; }
    section.style.display = '';
    const count = $('#localSongsCount');
    if (count) count.textContent = `${songs.length} song${songs.length === 1 ? '' : 's'}`;
    renderRecommendationCards(grid, songs, { emptyMessage: 'No local files imported yet.' });
  }

  /* ================================================================
     LIBRARY FILTER
     Searches playlist names plus every song the user owns — liked,
     local, and the contents of each playlist — because with a real
     library the only way to find a track was to scroll.
     ================================================================ */
  let libraryFilterQuery = '';
  let libraryFilterTimer = null;

  function normalizeForFilter(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function collectLibrarySongs() {
    // Dedupe by id: the same track is routinely liked *and* in two playlists,
    // and showing it three times makes the results look broken.
    const seen = new Set();
    const out = [];
    const push = (s) => {
      if (!s || !s.id || seen.has(s.id)) return;
      seen.add(s.id);
      out.push(s);
    };
    likedSongs.forEach(push);
    if (typeof LocalFileManager !== 'undefined' && Array.isArray(LocalFileManager.localSongs)) {
      LocalFileManager.localSongs.forEach(push);
    }
    playlists.forEach(pl => (pl.songs || []).forEach(push));
    return out;
  }

  function applyLibraryFilter() {
    const q = normalizeForFilter(libraryFilterQuery);
    const status = $('#libraryFilterStatus');
    const section = $('#libraryFilterSection');
    const grid = $('#libraryFilterGrid');
    const clearBtn = $('#libraryFilterClear');

    if (clearBtn) clearBtn.style.display = q ? '' : 'none';

    // Reset: unhide every playlist card and drop the results section.
    if (!q) {
      document.querySelectorAll('#playlistGrid .playlist-card').forEach(c => { c.style.display = ''; });
      const stale = $('#playlistFilterEmpty');
      if (stale) stale.remove();
      if (section) section.style.display = 'none';
      if (grid) grid.innerHTML = '';
      if (status) status.style.display = 'none';
      renderLocalSongs();
      return;
    }

    const cards = Array.from(document.querySelectorAll('#playlistGrid .playlist-card'));
    let plMatches = 0;
    cards.forEach(c => {
      const pl = playlists.find(p => String(p.id) === c.dataset.plid);
      const hit = pl ? normalizeForFilter(pl.name).includes(q) : false;
      c.style.display = hit ? '' : 'none';
      if (hit) plMatches++;
    });

    const plGrid = $('#playlistGrid');
    let plEmpty = $('#playlistFilterEmpty');
    if (plGrid && cards.length && !plMatches) {
      if (!plEmpty) {
        plEmpty = document.createElement('p');
        plEmpty.className = 'empty-msg';
        plEmpty.id = 'playlistFilterEmpty';
        plEmpty.style.gridColumn = '1/-1';
        plGrid.appendChild(plEmpty);
      }
      // textContent: the query is user input and must not reach innerHTML.
      plEmpty.textContent = 'No playlist names match that.';
    } else if (plEmpty) {
      plEmpty.remove();
    }

    const songMatches = collectLibrarySongs().filter(s =>
      normalizeForFilter(s.title).includes(q) || normalizeForFilter(s.channel || s.artist).includes(q)
    );

    if (section && grid) {
      section.style.display = '';
      const count = $('#libraryFilterCount');
      if (count) count.textContent = `${songMatches.length} song${songMatches.length === 1 ? '' : 's'}`;
      renderRecommendationCards(grid, songMatches, { emptyMessage: 'No songs in your library match that.' });
    }

    // Local Files is redundant while filtering — matches already show above.
    const localSec = $('#localSongsSection');
    if (localSec) localSec.style.display = 'none';

    if (status) {
      status.style.display = '';
      status.textContent = `${songMatches.length} song${songMatches.length === 1 ? '' : 's'} and ${plMatches} playlist${plMatches === 1 ? '' : 's'} match "${libraryFilterQuery.trim()}"`;
    }
  }

  function bindLibraryFilter() {
    const input = $('#libraryFilterInput');
    if (input) {
      input.addEventListener('input', (e) => {
        libraryFilterQuery = e.target.value;
        // Debounced: re-rendering the results grid on every keystroke of a
        // 100-track library is visibly janky.
        clearTimeout(libraryFilterTimer);
        libraryFilterTimer = setTimeout(applyLibraryFilter, 140);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); clearLibraryFilter(); }
      });
    }
    $('#libraryFilterClear')?.addEventListener('click', clearLibraryFilter);
    $('#playLocalBtn')?.addEventListener('click', () => {
      const songs = (typeof LocalFileManager !== 'undefined' && Array.isArray(LocalFileManager.localSongs))
        ? LocalFileManager.localSongs : [];
      if (!songs.length) return toast('No local files imported yet');
      queue = songs.slice();
      currentIndex = -1;
      if (isShuffle) resetShuffleBag(songs[0] && songs[0].id);
      updateQueueUI();
      playSong(songs[0]);
    });
  }

  function clearLibraryFilter() {
    libraryFilterQuery = '';
    clearTimeout(libraryFilterTimer);
    const input = $('#libraryFilterInput');
    if (input) input.value = '';
    applyLibraryFilter();
  }

  /* ================================================================
     BATCH TEXT SONG IMPORTER
     ================================================================ */
  let batchParsedTokens = [];
  let batchTargetPlaylistId = null;
  let isBatchImporting = false;

  function parseBatchText(rawText) {
    if (!rawText || !rawText.trim()) return [];
    const text = rawText.trim();

    // 1. If text contains line breaks, semicolons, or commas, split by delimiter
    if (/[\n;,]/.test(text)) {
      return text
        .split(/[\n;,]+/)
        .map(s => s.trim())
        .filter(s => s.length > 1);
    }

    // 2. Continuous space-separated text (e.g. "siyara keshariya akhari ishk blinglight starboy")
    const knownMultiWords = [
      'akhari ishk', 'aakhri ishq', 'aakhari ishq', 'apna bana le', 'tum hi ho', 'o bedardeya', 'o saathi',
      'blinding lights', 'save your tears', 'die for you', 'shape of you', 'tera ban jaunga',
      'channa mereya', 'lutt putt gaya', 'tere vaaste', 'raataan lambiyan', 'dil diyan gallan',
      'swag se swagat', 'bekhayali', 'pal pal dil ke paas', 'hawayein', 'kaise hua', 've kamleya',
      'ram siya ram', 'deva deva', 'kesariya tera', 'maan meri jaan', 'tu hai kahan', 'kahani suno'
    ];

    let normalized = text;
    const detected = [];

    for (const phrase of knownMultiWords) {
      const regex = new RegExp(`\\b${phrase}\\b`, 'gi');
      if (regex.test(normalized)) {
        detected.push(phrase);
        normalized = normalized.replace(regex, ' ___TOKEN___ ');
      }
    }

    const remainderWords = normalized.split(/\s+/).filter(w => w && w !== '___TOKEN___' && w.length > 1);
    const combined = [...detected, ...remainderWords];
    return combined.length > 0 ? combined : text.split(/\s+/).filter(w => w.length > 1);
  }

  function updateBatchChipsUI() {
    const container = $('#batchChipsContainer');
    const section = $('#batchChipsSection');
    const badge = $('#batchCountBadge');
    const countSub = $('#batchChipsCount');

    if (batchParsedTokens.length === 0) {
      section.style.display = 'none';
      badge.textContent = '0 songs detected';
      return;
    }

    section.style.display = '';
    badge.textContent = `${batchParsedTokens.length} song${batchParsedTokens.length > 1 ? 's' : ''} detected`;
    if (countSub) countSub.textContent = `${batchParsedTokens.length} items`;

    container.innerHTML = batchParsedTokens.map((t, idx) => `
      <div class="batch-chip" data-idx="${idx}">
        <span class="batch-chip-num">${idx + 1}</span>
        <span class="batch-chip-text">${esc(t)}</span>
        <button class="batch-chip-remove" type="button" data-idx="${idx}" title="Remove song">✕</button>
      </div>
    `).join('');

    container.querySelectorAll('.batch-chip-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const i = parseInt(btn.dataset.idx);
        batchParsedTokens.splice(i, 1);
        updateBatchChipsUI();
      });
    });
  }

  function onBatchTextChange() {
    const raw = $('#batchTextarea').value;
    batchParsedTokens = parseBatchText(raw);
    updateBatchChipsUI();
  }

  function openBatchImport(targetPlaylistId = null) {
    batchTargetPlaylistId = targetPlaylistId;
    isBatchImporting = false;

    // Reset fields
    $('#batchTextarea').value = '';
    batchParsedTokens = [];
    updateBatchChipsUI();
    $('#batchProgressBox').style.display = 'none';
    $('#batchProgressFill').style.width = '0%';
    $('#batchResultsPreview').style.display = 'none';
    $('#batchResultsPreview').innerHTML = '';
    $('#batchStartBtn').disabled = false;
    $('#batchStartBtn').textContent = '✨ Import Songs to Playlist';

    // Populate existing playlist dropdown
    const select = $('#batchExistingPlaylistSelect');
    if (playlists.length > 0) {
      select.innerHTML = playlists.map(p => `<option value="${p.id}">${esc(p.name)} (${p.songs.length} songs)</option>`).join('');
    } else {
      select.innerHTML = '<option value="">No playlists available</option>';
    }

    if (targetPlaylistId) {
      $('#destRadioExisting').checked = true;
      $('#batchNewPlaylistWrap').style.display = 'none';
      $('#batchExistingPlaylistWrap').style.display = '';
      select.value = targetPlaylistId;
    } else {
      $('#destRadioNew').checked = true;
      $('#batchNewPlaylistWrap').style.display = '';
      $('#batchExistingPlaylistWrap').style.display = 'none';
      $('#batchNewPlaylistName').value = 'Imported Mix ' + new Date().toLocaleDateString();
    }

    $('#batchImportModal').style.display = '';
    $('#batchTextarea').focus();
  }

  function closeBatchImport() {
    if (isBatchImporting) {
      if (!confirm('Import is in progress. Are you sure you want to cancel?')) return;
    }
    $('#batchImportModal').style.display = 'none';
  }

  async function executeBatchImport() {
    if (isBatchImporting) return;
    const queries = batchParsedTokens.length > 0 ? batchParsedTokens : parseBatchText($('#batchTextarea').value);
    if (!queries.length) {
      toast('Please enter at least one song name');
      $('#batchTextarea').focus();
      return;
    }

    const isNew = $('#destRadioNew').checked;
    let targetPl = null;

    if (isNew) {
      const plName = ($('#batchNewPlaylistName').value || '').trim() || 'New Batch Playlist';
      // Deliberately not pushed into `playlists` yet — the old code registered
      // it before awaiting the search, so a failed import left an empty ghost
      // playlist in the library.
      targetPl = { id: 'pl_' + Date.now(), name: plName, songs: [] };
    } else {
      const plId = $('#batchExistingPlaylistSelect').value;
      targetPl = playlists.find(p => p.id === plId);
      if (!targetPl) {
        toast('Please select an existing playlist');
        return;
      }
    }

    const preferOfficial = $('#batchPreferOfficial').checked;

    // UI state: progress
    isBatchImporting = true;
    const startBtn = $('#batchStartBtn');
    startBtn.disabled = true;
    startBtn.textContent = '⏳ Processing...';
    const progBox = $('#batchProgressBox');
    const progFill = $('#batchProgressFill');
    const progStatus = $('#batchProgressStatus');
    const progPercent = $('#batchProgressPercent');
    const previewBox = $('#batchResultsPreview');

    progBox.style.display = '';
    previewBox.style.display = '';
    previewBox.innerHTML = '';
    progFill.style.width = '15%';
    progPercent.textContent = '15%';
    progStatus.textContent = `Connecting & resolving ${queries.length} songs (prioritizing official tracks)...`;

    try {
      progFill.style.width = '40%';
      progPercent.textContent = '40%';

      const res = await fetch('/api/batch-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries, preferOfficial })
      });

      if (!res.ok) throw new Error(`Batch search failed (${res.status})`);
      const data = await res.json();

      progFill.style.width = '85%';
      progPercent.textContent = '85%';
      progStatus.textContent = `Found ${data.found} songs. Finalizing playlist...`;

      let addedCount = 0;
      let htmlResults = '';

      if (data.results && data.results.length > 0) {
        data.results.forEach(({ query, song }) => {
          if (song && song.id) {
            // Avoid duplicate in playlist
            if (!targetPl.songs.some(s => s.id === song.id)) {
              targetPl.songs.push(song);
              addedCount++;
            }
            htmlResults += `
              <div class="batch-res-item">
                <img class="batch-res-thumb" src="${thumb(song)}" alt="" />
                <div class="batch-res-info">
                  <div class="batch-res-title">${esc(song.title)}</div>
                  <div class="batch-res-channel">${esc(song.channel)} • Match for "${esc(query)}"</div>
                </div>
                <span class="batch-res-badge">✓ Added</span>
              </div>
            `;
          }
        });
      }

      // Only now does a brand-new playlist join the library, so a failed
      // search never leaves an empty one behind.
      if (isNew && !playlists.some(p => p.id === targetPl.id)) playlists.push(targetPl);

      Storage.set('playlists', playlists);
      progFill.style.width = '100%';
      progPercent.textContent = '100%';
      progStatus.textContent = `Done! Added ${addedCount} songs to "${targetPl.name}".`;
      previewBox.innerHTML = htmlResults || '<p class="empty-msg">No matching songs could be found.</p>';

      toast(`✨ Added ${addedCount} songs to "${targetPl.name}"`);

      // If viewing library or the updated playlist detail, refresh
      if (pages.library.style.display !== 'none') {
        if (currentPlaylistId === targetPl.id) renderActivePlaylist();
        else renderLibrary();
      }

      startBtn.disabled = false;
      startBtn.textContent = '✓ Completed (Import More)';
    } catch (err) {
      console.error(err);
      toast('⚠️ Error during batch import');
      progStatus.textContent = 'Failed to import songs. Please try again.';
      startBtn.disabled = false;
      startBtn.textContent = 'Try Again';
    } finally {
      isBatchImporting = false;
    }
  }

  /* ================================================================
     HOME RECOMMENDATIONS & SMART RADIO ENGINE
     ================================================================ */
  let recommendedSongs = [];
  let isFetchingRecs = false;

  // Suggestion feeds only. Never used to filter the queue, a playlist or the
  // library: disliking a track must not make music the user explicitly chose
  // disappear from where they put it.
  function dropDisliked(list) {
    if (!Array.isArray(list)) return [];
    if (!dislikedSongs.length) return list.filter(s => s && s.id);
    const blocked = new Set(dislikedSongs.map(s => s.id));
    return list.filter(s => s && s.id && !blocked.has(s.id));
  }

  async function loadRecommendations(forceRefresh = false) {
    const grid = $('#recommendedGrid');
    if (!grid) return;

    if (recommendedSongs.length > 0 && !forceRefresh) {
      renderRecommendationCards(grid, recommendedSongs);
      return;
    }

    if (isFetchingRecs) return;
    isFetchingRecs = true;

    // Show skeletons
    grid.innerHTML = Array.from({ length: 8 }, () => `
      <div class="skeleton-card"><div class="skeleton-thumb"></div><div class="skeleton-info"><div class="skeleton-line"></div><div class="skeleton-line"></div></div></div>
    `).join('');

    // Extract seed artists and tracks from user's history and likes
    const artistCounts = {};
    [...history.map(h => h.song), ...likedSongs].forEach(s => {
      if (s && s.channel) {
        const cleanCh = s.channel.replace(/ - Topic|VEVO|Official/gi, '').trim();
        artistCounts[cleanCh] = (artistCounts[cleanCh] || 0) + 1;
      }
    });

    const topArtists = Object.keys(artistCounts)
      .sort((a, b) => artistCounts[b] - artistCounts[a])
      .slice(0, 3);

    const recentTracks = history.slice(0, 2).map(h => h.song?.title).filter(Boolean);

    const url = `/api/recommendations?seedArtists=${encodeURIComponent(topArtists.join(','))}&seedQueries=${encodeURIComponent(recentTracks.join(','))}${forceRefresh ? '&t=' + Date.now() : ''}`;

    try {
      let data = [];
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) data = await res.json();
      } catch (e) {}

      if (!data || data.length === 0) {
        data = await CloudMusicEngine.getTrending();
      }

      // A dislike has to mean something or the button is decoration. Filtering at
      // the ingest point covers the recommended grid, the taste section, auto-queue
      // and the personalized radio in one place, since they all read this array.
      recommendedSongs = dropDisliked(data);
      Storage.set('cached_recommendations', recommendedSongs.slice(0, 24));
      renderRecommendationCards(grid, recommendedSongs);

      if (topArtists[0]) renderTasteSection(topArtists[0]);
    } catch (err) {
      console.error(err);
      grid.innerHTML = '<p class="empty-msg" style="grid-column:1/-1;text-align:center;">Could not load recommendations.</p>';
    } finally {
      isFetchingRecs = false;
    }
  }

  /**
   * Shared card grid renderer.
   *
   * opts.removable    render a "remove from playlist" button on every card.
   *                   Only the playlist detail grid passes this — the button
   *                   would be meaningless on Home or search results.
   * opts.emptyMessage override the empty-state copy ("No songs available right
   *                   now" is wrong for a playlist the user just emptied).
   */
  function renderRecommendationCards(container, songs, opts) {
    const o = opts || {};
    if (!songs || !songs.length) {
      container.innerHTML = `<p class="empty-msg" style="grid-column:1/-1;text-align:center;">${esc(o.emptyMessage || 'No songs available right now.')}</p>`;
      return;
    }

    const removeBtn = o.removable ? `
              <button class="card-action-btn card-action-remove" data-action="removepl" title="Remove from this playlist" aria-label="Remove from this playlist">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
              </button>` : '';

    // downloadSong() bails for cloud and local tracks, so rendering the button
    // for them only ever produced "Downloads are available for YouTube search
    // results." Don't offer an action that can't happen.
    const dlBtn = (item) => (item.isCloud || item.isLocal) ? '' : `
              <button class="card-action-btn" data-action="download" title="Download MP3">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </button>`;

    container.innerHTML = songs.map((item, i) => `
      <div class="result-card ${isCurrent(item.id) ? 'playing' : ''}" data-id="${escId(item.id)}" data-idx="${i}">
        <div class="card-thumbnail">
          <img src="${thumb(item)}" alt="" loading="lazy" />
          <span class="card-duration">${fmtDur(item.duration)}</span>
          <div class="card-play-overlay" data-action="play"><div class="overlay-play-btn"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></div></div>
        </div>
        <div class="card-info">
          <div class="card-title" title="${esc(item.title)}">${esc(item.title)}</div>
          <div class="card-meta">
            <span class="card-channel">${esc(item.channel)}</span>
            <span class="card-playcount" title="${getPlayCount(item.id) ? `Played ${getPlayCount(item.id)} time${getPlayCount(item.id) === 1 ? '' : 's'}` : ''}">${getPlayCount(item.id) ? getPlayCount(item.id) + '×' : ''}</span>
            <div class="card-actions">
              <button class="card-action-btn ${isLiked(item.id) ? 'liked' : ''}" data-action="like" title="Like">
                <svg viewBox="0 0 24 24" fill="${isLiked(item.id) ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
              </button>
              <button class="card-action-btn ${isDisliked(item.id) ? 'disliked' : ''}" data-action="dislike" title="Not interested">
                <svg viewBox="0 0 24 24" fill="${isDisliked(item.id) ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>
              </button>${dlBtn(item)}
              <button class="card-action-btn" data-action="playnext" title="Play next">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="4 4 13 12 4 20 4 4" fill="currentColor" stroke="none"/><line x1="19" y1="5" x2="19" y2="19"/></svg>
              </button>
              <button class="card-action-btn" data-action="addpl" title="Add to playlist">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </button>
              <button class="card-action-btn" data-action="queue" title="Add to queue">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>
              </button>${removeBtn}
            </div>
          </div>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.result-card').forEach(card => {
      card.addEventListener('click', (e) => {
        const i = parseInt(card.dataset.idx);
        const item = songs[i];
        const action = e.target.closest('[data-action]');
        if (action) {
          e.stopPropagation();
          if (action.dataset.action === 'like') toggleLike(item);
          else if (action.dataset.action === 'dislike') toggleDislike(item);
          else if (action.dataset.action === 'queue') addToQueue(item);
          else if (action.dataset.action === 'playnext') playNextInQueue(item);
          else if (action.dataset.action === 'addpl') openAddToPlaylist(item);
          else if (action.dataset.action === 'download') downloadSong(item);
          else if (action.dataset.action === 'removepl') removeSongFromPlaylist(i, item);
          else playSong(item);
        } else {
          playSong(item);
        }
      });
    });
  }

  function renderTasteSection(topArtist) {
    const tasteSec = $('#tasteSection');
    const tasteTitle = $('#tasteSectionTitle');
    const tasteGrid = $('#tasteGrid');
    if (!tasteSec || !tasteTitle || !tasteGrid) return;

    if (!topArtist || !history.length) {
      tasteSec.style.display = 'none';
      return;
    }

    tasteSec.style.display = '';
    tasteTitle.textContent = `🔥 More Like ${topArtist}`;

    const related = recommendedSongs.slice(4, 12);
    if (related.length > 0) {
      renderRecommendationCards(tasteGrid, related);
    } else {
      tasteSec.style.display = 'none';
    }
  }

  function startPersonalizedRadio() {
    if (!recommendedSongs.length && !likedSongs.length && !history.length) {
      toast('✨ Generating your personalized mix...');
      loadRecommendations(true).then(() => {
        if (recommendedSongs.length) startPersonalizedRadio();
      });
      return;
    }

    // Blend recommendations + likes + recent songs
    const pool = [...recommendedSongs, ...likedSongs, ...history.map(h => h.song)];
    const seen = new Set();
    const mix = [];
    pool.forEach(s => {
      if (s && s.id && !seen.has(s.id)) {
        seen.add(s.id);
        mix.push(s);
      }
    });

    // Shuffle
    for (let i = mix.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [mix[i], mix[j]] = [mix[j], mix[i]];
    }

    if (mix.length > 0) {
      queue = mix;
      currentIndex = -1;
      updateQueueUI();
      playSong(queue[0]);
      toast('✨ Playing your personalized endless flow');
    } else {
      toast('No songs available to play');
    }
  }

  /* ================================================================
     BROWSE TABS (mood / genre / activity / language)
     ================================================================ */
  // All four panels are already in the page; this only decides which one shows.
  // Switching costs no render and no request — the point of the tabs is to make
  // 32 tiles reachable in one tap instead of one long scroll.
  const BROWSE_KINDS = ['mood', 'genre', 'activity', 'language'];

  const BrowseTabs = {
    init() {
      const strip = $('#browseTabs');
      if (!strip) return;
      // One delegated listener on the strip, bound once from init(). Per-button
      // handlers would stack if this ever ran twice.
      strip.addEventListener('click', (e) => {
        const btn = e.target.closest && e.target.closest('.browse-tab');
        if (btn) this.show(btn.dataset.browse);
      });
      // A value left by an older build, or a hand-edited localStorage, must not
      // hide every panel and leave the section blank.
      const saved = Storage.get('browse_tab', 'mood');
      this.show(BROWSE_KINDS.indexOf(saved) >= 0 ? saved : 'mood');
    },

    show(kind) {
      if (BROWSE_KINDS.indexOf(kind) < 0) return;
      $$('.browse-tab').forEach(t => {
        const on = t.dataset.browse === kind;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      $$('.browse-panel').forEach(p => {
        p.style.display = p.dataset.browsePanel === kind ? '' : 'none';
      });
      // Device-local: which tab you last looked at is not worth a POST.
      Storage.setLocal('browse_tab', kind);
    },
  };

  function renderHomePage() {
    // Dynamic greeting based on time of day
    const hour = new Date().getHours();
    const greetingEl = $('#homeGreeting h1');
    if (greetingEl) {
      if (hour < 12) greetingEl.textContent = 'Good Morning ☀️';
      else if (hour < 17) greetingEl.textContent = 'Good Afternoon 🌤️';
      else if (hour < 21) greetingEl.textContent = 'Good Evening 🌆';
      else greetingEl.textContent = 'Good Night 🌙';
    }

    // Render recently played
    const recentSec = $('#recentlyPlayedSection');
    const recentGrid = $('#recentlyPlayedGrid');
    if (recentSec && recentGrid) {
      if (history.length > 0) {
        recentSec.style.display = '';
        const recentSongs = history.slice(0, 10).map(h => h.song).filter(Boolean);
        renderRecommendationCards(recentGrid, recentSongs);
      } else {
        recentSec.style.display = 'none';
      }
    }

    // Quick-access search history, same list as the search page.
    renderSearchHistory();

    // Load smart recommendations
    loadRecommendations(false);
  }

  /* ================================================================
     SONG LIST RENDERER (reusable for liked, playlist, history)
     ================================================================ */
  function renderSongList(container, songs, type) {
    if (!songs.length) {
      container.innerHTML = '<p class="empty-msg">No songs here yet.</p>';
      return;
    }
    container.innerHTML = songs.map((s, i) => `
      <div class="song-row ${isCurrent(s.id) ? 'active' : ''}" data-idx="${i}">
        <span class="sr-num">${i + 1}</span>
        <div class="sr-thumb"><img src="${thumb(s)}" alt="" loading="lazy" /></div>
        <div class="sr-info"><div class="sr-title">${esc(s.title)}</div><div class="sr-channel">${esc(s.channel)}</div></div>
        <span class="sr-duration">${fmtDur(s.duration)}</span>
        <div class="sr-actions">
          <button class="card-action-btn" data-action="download" title="Download MP3"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>
          <button class="card-action-btn" data-action="remove" title="Remove"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.song-row').forEach(row => {
      row.addEventListener('click', (e) => {
        const idx = parseInt(row.dataset.idx);
        const action = e.target.closest('[data-action]');
        if (action && action.dataset.action === 'download') {
          e.stopPropagation();
          downloadSong(songs[idx]);
        } else if (action && action.dataset.action === 'remove') {
          e.stopPropagation();
          songs.splice(idx, 1);
          if (type === 'liked') { likedSongs = songs; Storage.set('likes', likedSongs); updateLikeBtn(); }
          else if (type === 'playlist') Storage.set('playlists', playlists);
          renderSongList(container, songs, type);
        } else {
          playSong(songs[idx]);
        }
      });
    });
  }

  /* ================================================================
     QUEUE
     ================================================================ */
  function addToQueue(song) {
    if (queue.some(s => s.id === song.id)) { toast('Already in queue'); return; }
    queue.push(song);
    // Otherwise a track added mid-shuffle would never be picked: the bag is only
    // refilled when it empties.
    if (isShuffle && song.id) shuffleBag.push(song.id);
    updateQueueUI(); toast('Added to queue');
  }

  // "Play Next" jumps the line instead of appending. Nothing starts playing now —
  // that is what clicking the card already does.
  function playNextInQueue(song) {
    if (!song || !song.id) return;

    const existing = queue.findIndex(s => s.id === song.id);
    if (existing !== -1) {
      if (existing === currentIndex) { toast('That track is playing now'); return; }
      // Already queued: move it rather than refusing, which is what the user meant.
      moveQueueItem(existing, currentIndex >= 0 ? currentIndex + 1 : 0, { silent: true });
      toast('⏭️ Playing next');
      return;
    }

    // With nothing playing there is no "after current", so it goes to the front.
    // The insert point is always *after* the cursor (or the cursor is -1), so
    // currentIndex never shifts here — no correction needed, and adding one
    // would double-advance the highlight.
    const at = currentIndex >= 0 ? currentIndex + 1 : 0;
    queue.splice(at, 0, song);
    if (isShuffle && song.id) shuffleBag.push(song.id);
    updateQueueUI();
    toast('⏭️ Playing next');
  }

  // Single source of truth for reordering, used by both drag-and-drop and
  // Play Next. Keeps currentIndex pointing at the same *song*, not the same slot.
  function moveQueueItem(from, to, opts) {
    const o = opts || {};
    if (from < 0 || from >= queue.length) return false;
    // Clamp instead of bailing: dropping past the last row is a legitimate gesture.
    to = Math.max(0, Math.min(to, queue.length - 1));
    if (from === to) return false;

    const playingId = currentIndex >= 0 && queue[currentIndex] ? queue[currentIndex].id : null;
    const [moved] = queue.splice(from, 1);
    queue.splice(to, 0, moved);

    // Recomputing from the id is immune to the off-by-one traps in splice-based
    // index arithmetic (the from<to vs from>to cases differ).
    if (playingId !== null) {
      const found = queue.findIndex(s => s.id === playingId);
      if (found !== -1) currentIndex = found;
    }

    updateQueueUI();
    if (!o.silent) toast('Queue reordered');
    return true;
  }

  function removeFromQueue(idx) {
    if (idx < 0 || idx >= queue.length) return;

    if (idx !== currentIndex) {
      queue.splice(idx, 1);
      if (idx < currentIndex) currentIndex--;
      updateQueueUI();
      toast('Removed from queue');
      return;
    }

    // The X button is rendered on every row including the playing one, so this
    // was a dead click: no toast, no change, nothing. Removing the playing track
    // means moving on — play what follows, or stop if it was the last one.
    queue.splice(idx, 1);
    if (!queue.length) {
      currentIndex = -1;
      audioPlayer.pause();
      updateQueueUI();
      toast('Removed — queue is now empty');
      return;
    }
    const nextIdx = Math.min(idx, queue.length - 1);
    currentIndex = -1;               // playSong recomputes it from the song id
    playSong(queue[nextIdx]);
    toast('Removed from queue');
  }

  function clearQueue() {
    const cur = currentIndex >= 0 ? queue[currentIndex] : null;
    queue = cur ? [cur] : []; currentIndex = cur ? 0 : -1;
    // Stale ids here would make shuffle skip picks and Prev jump to tracks that
    // are no longer queued.
    playOrderHistory = cur && cur.id ? [cur.id] : [];
    shuffleBag = [];
    updateQueueUI(); toast('Queue cleared');
  }

  function toggleQueue() {
    const open = queueSidebar.classList.toggle('open');
    $('#queueToggleBtn').classList.toggle('active', open);
    pageContent.classList.toggle('queue-open', open);
  }

  // Index of the row currently being dragged. Module-scoped rather than captured
  // per-render: updateQueueUI() replaces every row via innerHTML, so a closure
  // variable would be pointing at a detached node by the time drop fires.
  let queueDragFrom = -1;

  function updateQueueUI() {
    queueBadge.textContent = queue.length;
    queueBadge.classList.toggle('visible', queue.length > 0);

    if (!queue.length) {
      queueList.innerHTML = '<div class="queue-empty"><p>Queue is empty</p><p class="queue-hint">Search and add songs</p></div>';
      return;
    }

    queueList.innerHTML = queue.map((s, i) => `
      <div class="queue-item ${i === currentIndex ? 'active' : ''}" data-idx="${i}" draggable="true">
        <span class="qi-grip" aria-hidden="true" title="Drag to reorder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/></svg></span>
        <div class="qi-thumb"><img src="${thumb(s)}" alt="" loading="lazy" /></div>
        <div class="qi-info"><div class="qi-title">${esc(s.title)}</div><div class="qi-channel">${esc(s.channel)}</div></div>
        <button class="qi-btn" data-action="qup" title="Move up" aria-label="Move up"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg></button>
        <button class="qi-btn" data-action="qdown" title="Move down" aria-label="Move down"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></button>
        <button class="qi-remove" data-action="remove" title="Remove"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
      </div>
    `).join('');

    queueList.querySelectorAll('.queue-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const idx = parseInt(item.dataset.idx);
        const action = e.target.closest('[data-action]');
        if (action) {
          e.stopPropagation();
          const a = action.dataset.action;
          if (a === 'remove') removeFromQueue(idx);
          // Keyboard/touch-accessible alternative to dragging: a phone cannot
          // produce HTML5 drag events at all, so without these the reorder
          // feature would simply not exist on mobile.
          else if (a === 'qup') moveQueueItem(idx, idx - 1, { silent: true });
          else if (a === 'qdown') moveQueueItem(idx, idx + 1, { silent: true });
          return;
        }
        playSong(queue[idx]);
      });

      item.addEventListener('dragstart', (e) => {
        queueDragFrom = parseInt(item.dataset.idx);
        item.classList.add('dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          // Firefox ignores a drag that carries no payload.
          try { e.dataTransfer.setData('text/plain', String(queueDragFrom)); } catch (err) {}
        }
      });

      item.addEventListener('dragover', (e) => {
        if (queueDragFrom < 0) return;
        e.preventDefault();                        // required to allow a drop
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        const target = parseInt(item.dataset.idx);
        if (target !== queueDragFrom) item.classList.add('drag-over');
      });

      item.addEventListener('dragleave', () => item.classList.remove('drag-over'));

      item.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        item.classList.remove('drag-over');
        const to = parseInt(item.dataset.idx);
        const from = queueDragFrom;
        queueDragFrom = -1;                        // cleared before the re-render
        if (from >= 0 && !isNaN(to)) moveQueueItem(from, to, { silent: true });
      });

      // Fires even when the drag is abandoned outside a drop target, so the
      // dragging class and the stale index cannot survive a cancelled gesture.
      item.addEventListener('dragend', () => {
        queueDragFrom = -1;
        item.classList.remove('dragging');
        queueList.querySelectorAll('.drag-over').forEach(n => n.classList.remove('drag-over'));
      });
    });

    const active = queueList.querySelector('.queue-item.active');
    if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // startSong is optional and only used by voice, which ranks the results and
  // asks for the official release rather than YouTube's first hit. The queue
  // keeps the list in its displayed order either way, so playSong() finds the
  // right index and Next carries on from there.
  function playAllResults(startSong) {
    if (!searchResults.length) return;
    queue = [...searchResults]; currentIndex = -1;
    const first = startSong && startSong.id && queue.some(s => s.id === startSong.id) ? startSong : queue[0];
    updateQueueUI(); playSong(first); toast(`Playing ${queue.length} songs`);
  }

  function highlightResults() {
    resultsGrid.querySelectorAll('.result-card').forEach(c => c.classList.toggle('playing', isCurrent(c.dataset.id)));
  }

  /* ================================================================
     HISTORY & ANALYTICS
     ================================================================ */
  // A "play" the user skipped past in under this many seconds is not a play.
  const HISTORY_MIN_PLAY_SEC = 20;

  function addToHistory(song) {
    if (!song || !song.id) return;

    // Every playSong() lands here, so mashing Next used to write one
    // listenedSec:0 entry per skip. That inflated the profile play counts, the
    // "N plays" in Top Songs, and the artist weighting that seeds
    // recommendations — and re-clicking the playing card duplicated it again.
    const top = history[0];
    if (top && top.song && top.song.id === song.id && (top.listenedSec || 0) < HISTORY_MIN_PLAY_SEC) {
      top.playedAt = new Date().toISOString();
      activeHistoryEntry = top;
      Storage.set('history', history);
      return;
    }
    // recordListenTime() has already closed the clock on the outgoing entry by
    // the time we get here, so a zero there means it was skipped, not played.
    if (top && top === activeHistoryEntry && (top.listenedSec || 0) === 0) history.shift();

    const entry = { song, playedAt: new Date().toISOString(), listenedSec: 0 };
    history.unshift(entry);
    if (history.length > 250) history = history.slice(0, 250);
    // Listen time is attributed to this exact entry rather than to history[0],
    // which stops being the current track as soon as a server sync re-sorts
    // the array.
    activeHistoryEntry = entry;
    Storage.set('history', history);
  }

  // History is merged from localStorage and the server, and older builds wrote
  // entries in different shapes. Any entry without a usable `song` used to throw
  // on `h.song.id` and take the entire profile page down with it.
  function validHistory() {
    if (!Array.isArray(history)) return [];
    return history.filter(h => h && h.song && h.song.id);
  }

  function recordListenTime() {
    if (playStartTime && activeHistoryEntry) {
      const sec = Math.floor((Date.now() - playStartTime) / 1000);
      if (sec > 0) {
        activeHistoryEntry.listenedSec = (activeHistoryEntry.listenedSec || 0) + sec;
        // A play only counts once it clears the skip threshold, and only once per
        // history entry — `counted` is stored on the entry so a pause/resume cycle
        // (which calls this repeatedly for the same track) cannot inflate the total.
        if (!activeHistoryEntry.counted &&
            activeHistoryEntry.listenedSec >= HISTORY_MIN_PLAY_SEC &&
            activeHistoryEntry.song && activeHistoryEntry.song.id) {
          activeHistoryEntry.counted = true;
          bumpPlayCount(activeHistoryEntry.song.id);
        }
        // The entry object may have been dropped by a sync merge; only persist
        // if it is still part of the live array.
        if (history.indexOf(activeHistoryEntry) !== -1) Storage.set('history', history);
      }
    }
    // Always cleared, even when there was nothing to attribute the time to.
    playStartTime = null;
  }

  function bumpPlayCount(songId) {
    if (!songId) return;
    playCounts[songId] = (playCounts[songId] || 0) + 1;
    // History is capped at 250 entries but playCounts is keyed by id and would
    // otherwise grow without bound across years of use. Trim the coldest entries.
    const ids = Object.keys(playCounts);
    if (ids.length > 800) {
      ids.sort((a, b) => playCounts[b] - playCounts[a]);
      const kept = {};
      for (const id of ids.slice(0, 600)) kept[id] = playCounts[id];
      // Never drop the song that just played.
      kept[songId] = playCounts[songId];
      playCounts = kept;
    }
    Storage.set('playCounts', playCounts);
    // Cheap in-place refresh; re-rendering every grid here would fight the
    // scroll position on the page the user is looking at.
    reflectPlayCountInDom(songId);
  }

  function getPlayCount(songId) {
    const n = playCounts[songId];
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function reflectPlayCountInDom(songId) {
    const n = getPlayCount(songId);
    document.querySelectorAll(`.result-card[data-id="${escId(songId)}"] .card-playcount`).forEach(el => {
      el.textContent = n > 0 ? `${n}×` : '';
      el.title = n > 0 ? `Played ${n} time${n === 1 ? '' : 's'}` : '';
    });
  }

  function renderProfile() {
    const hist = validHistory();

    // Stats
    $('#statTotalPlayed').textContent = hist.length;
    const totalMin = Math.floor(hist.reduce((a, h) => a + (h.listenedSec || 0), 0) / 60);
    $('#statMinutes').textContent = totalMin;
    $('#statLiked').textContent = likedSongs.length;
    $('#statPlaylists').textContent = playlists.length;

    // Top Songs
    const songCounts = {};
    hist.forEach(h => {
      const id = h.song.id;
      if (!songCounts[id]) songCounts[id] = { song: h.song, count: 0 };
      songCounts[id].count++;
    });
    const topSongs = Object.values(songCounts).sort((a, b) => b.count - a.count).slice(0, 10);
    const topList = $('#topSongsList');
    if (!topSongs.length) {
      topList.innerHTML = '<p class="empty-msg">Play some songs to see your top tracks!</p>';
    } else {
      topList.innerHTML = topSongs.map((t, i) => `
        <div class="top-item" data-id="${escId(t.song.id)}">
          <span class="ti-rank">${i + 1}</span>
          <div class="ti-thumb"><img src="${thumb(t.song)}" alt="" loading="lazy" /></div>
          <div class="ti-info"><div class="ti-name">${esc(t.song.title)}</div><div class="ti-sub">${esc(t.song.channel)}</div></div>
          <span class="ti-plays">${t.count} plays</span>
        </div>
      `).join('');
      topList.querySelectorAll('.top-item').forEach(item => {
        item.addEventListener('click', () => {
          const s = topSongs.find(t => t.song.id === item.dataset.id);
          if (s) playSong(s.song);
        });
      });
    }

    // Top Artists
    const artistCounts = {};
    hist.forEach(h => {
      const ch = h.song.channel || 'Unknown';
      if (!artistCounts[ch]) artistCounts[ch] = { name: ch, count: 0 };
      artistCounts[ch].count++;
    });
    const topArtists = Object.values(artistCounts).sort((a, b) => b.count - a.count).slice(0, 10);
    const artList = $('#topArtistsList');
    if (!topArtists.length) {
      artList.innerHTML = '<p class="empty-msg">Listen to music to see your top artists!</p>';
    } else {
      artList.innerHTML = topArtists.map((a, i) => `
        <div class="top-item"><span class="ti-rank">${i + 1}</span><div class="ti-info"><div class="ti-name">${esc(a.name)}</div></div><span class="ti-plays">${a.count} plays</span></div>
      `).join('');
    }

    // History list
    const histList = $('#historyList');
    const recentHist = hist.slice(0, 30);
    if (!recentHist.length) {
      histList.innerHTML = '<p class="empty-msg">No listening history yet.</p>';
    } else {
      histList.innerHTML = recentHist.map((h, i) => `
        <div class="song-row" data-idx="${i}">
          <span class="sr-num">${i + 1}</span>
          <div class="sr-thumb"><img src="${thumb(h.song)}" alt="" loading="lazy" /></div>
          <div class="sr-info"><div class="sr-title">${esc(h.song.title)}</div><div class="sr-channel">${esc(h.song.channel)} · ${timeAgo(h.playedAt)}</div></div>
          <span class="sr-duration">${fmtDur(h.song.duration)}</span>
        </div>
      `).join('');
      histList.querySelectorAll('.song-row').forEach(row => {
        row.addEventListener('click', () => {
          const i = parseInt(row.dataset.idx);
          if (recentHist[i] && recentHist[i].song) playSong(recentHist[i].song);
        });
      });
    }
  }



  /* ================================================================
     LYRICS
     ================================================================ */
  let lyricsData = null;
  let lyricsRequestId = 0;

  function toggleLyrics() {
    const panel = $('#lyricsPanel');
    panel.classList.toggle('open');
    $('#lyricsBtn').classList.toggle('active', panel.classList.contains('open'));
    if (panel.classList.contains('open') && currentSong) fetchLyrics(currentSong.id);
  }

  async function fetchLyrics(videoId) {
    const content = $('#lyricsContent');
    const requestId = ++lyricsRequestId;
    if (!videoId || videoId.length !== 11) {
      content.innerHTML = '<p class="lyrics-placeholder">No lyrics available for this track</p>';
      lyricsData = null;
      return;
    }
    content.innerHTML = '<p class="lyrics-placeholder">Loading lyrics...</p>';
    lyricsData = null;

    try {
      const res = await fetch(`/api/lyrics/${videoId}`);
      const data = await res.json();

      if (requestId !== lyricsRequestId || currentSong?.id !== videoId) return;

      if (!data.lines || data.lines.length === 0) {
        content.innerHTML = '<p class="lyrics-placeholder">No lyrics available for this song</p>';
        return;
      }

      lyricsData = data;
      content.innerHTML = data.lines.map((l, i) => `<div class="lyrics-line" data-idx="${i}" data-time="${Number(l.time) || 0}">${esc(l.text)}</div>`).join('');

      // Click to seek
      content.querySelectorAll('.lyrics-line').forEach(line => {
        line.addEventListener('click', () => {
          const t = parseFloat(line.dataset.time);
          if (t && audioPlayer.duration) audioPlayer.currentTime = t;
        });
      });
    } catch {
      if (requestId !== lyricsRequestId) return;
      content.innerHTML = '<p class="lyrics-placeholder">Could not load lyrics</p>';
    }
  }

  // Tracks the line we last auto-scrolled to. Calling scrollIntoView on every
  // timeupdate (~4x/sec) for as long as a line stayed active re-triggered the
  // smooth scroll continuously, so the panel could not be scrolled by hand at all.
  let lyricsScrolledIdx = -1;

  function syncLyrics(time) {
    if (!lyricsData || !lyricsData.synced) return;
    const lines = $$('.lyrics-line');
    let activeIdx = -1;
    for (let i = lyricsData.lines.length - 1; i >= 0; i--) {
      if (time >= lyricsData.lines[i].time) { activeIdx = i; break; }
    }
    lines.forEach((l, i) => l.classList.toggle('active', i === activeIdx));

    if (activeIdx !== lyricsScrolledIdx) {
      lyricsScrolledIdx = activeIdx;
      const el = lines[activeIdx];
      if (el && $('#lyricsPanel')?.classList.contains('open')) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }

  /* ================================================================
     SHARE & DOWNLOAD
     ================================================================ */
  function shareSong() {
    if (!currentSong) { toast('No song playing'); return; }
    const text = `🎵 ${currentSong.title} — ${currentSong.channel}`;

    // Only YouTube-sourced tracks have a YouTube id. Building a watch?v= URL for
    // a local import or a cloud track produced a dead link like
    // ...?v=local_1712..._a9f3, so those share the title instead.
    const isYouTube = !currentSong.isLocal && !currentSong.isCloud && /^[\w-]{11}$/.test(String(currentSong.id || ''));
    const url = isYouTube ? `https://www.youtube.com/watch?v=${currentSong.id}` : '';

    if (navigator.share) {
      const payload = { title: currentSong.title, text };
      if (url) payload.url = url;
      navigator.share(payload).catch(() => {});
    } else {
      navigator.clipboard.writeText(url ? `${text}\n${url}` : text)
        .then(() => toast(url ? 'Link copied!' : 'Track name copied!'))
        .catch(() => toast('Could not copy'));
    }
  }

  // The server allows only two concurrent MP3 conversions, so an impatient
  // double-click used to spend the whole budget and come back 429.
  const activeDownloads = new Set();

  // Mirrors the server's sanitizer: strips only what is actually illegal in a
  // filename instead of destroying every non-Latin character. The old regex
  // turned every Hindi or Tamil title into an empty string.
  function safeDownloadName(rawTitle) {
    const cleaned = String(rawTitle || '')
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^\.+/, '')
      .trim()
      .slice(0, 120)
      .replace(/[. ]+$/, '')
      .trim();
    return cleaned || 'MusicFlow_Track';
  }

  // Mirrors tidyTrackTitle/buildTrackFilename in server.js so a locally-named file
  // matches what the server would have called it.
  function tidyTrackTitle(rawTitle) {
    return String(rawTitle || '')
      .replace(/\((?:official\s*)?(?:music\s*)?(?:video|audio|lyric[s]?|lyrical|visualizer|hd|4k|full\s*song|full\s*video)[^)]*\)/gi, '')
      .replace(/\[(?:official\s*)?(?:music\s*)?(?:video|audio|lyric[s]?|lyrical|visualizer|hd|4k|full\s*song|full\s*video)[^\]]*\]/gi, '')
      .replace(/\b(?:official\s+(?:video|audio|music\s+video)|lyric\s+video|full\s+video\s+song)\b/gi, '')
      .replace(/[|–—-]\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function buildTrackFilename(song) {
    const title = tidyTrackTitle(song && song.title);
    const artist = tidyTrackTitle(song && song.channel)
      .replace(/\s*-\s*Topic$/i, '')
      .replace(/\bVEVO$/i, '')
      .trim();
    const id = (song && song.id) ? String(song.id) : '';
    if (!title) return safeDownloadName(artist ? `${artist} - ${id}` : `MusicFlow_${id}`);
    const haveArtist = artist && artist.length > 1;
    const titleHasArtist = haveArtist &&
      title.toLowerCase().replace(/\s+/g, '').includes(artist.toLowerCase().replace(/\s+/g, ''));
    return safeDownloadName(haveArtist && !titleHasArtist ? `${title} - ${artist}` : title);
  }

  // A server name of exactly "Track" (or a bare video id) means yt-dlp's metadata
  // fetch failed and the server fell back to a placeholder. Preferring it is what
  // produced "Track.mp3", "Track (1).mp3", "Track (2).mp3" in the user's folder —
  // in that case the title we already have on the card is strictly better.
  function isPlaceholderName(name) {
    const stem = String(name || '').replace(/\.mp3$/i, '').trim();
    return !stem || /^(track|video|audio|musicflow_track|untitled|unknown)$/i.test(stem) ||
      /^[a-zA-Z0-9_-]{11}$/.test(stem);
  }

  // Prefer the name the server picked; it knows the real video title.
  function filenameFromDisposition(header) {
    if (!header) return null;
    const utf8 = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
    if (utf8) {
      try { return decodeURIComponent(utf8[1].trim()); } catch (e) {}
    }
    const plain = /filename\s*=\s*"([^"]+)"/i.exec(header) || /filename\s*=\s*([^;]+)/i.exec(header);
    return plain ? plain[1].trim() : null;
  }

  async function downloadSong(song) {
    if (!song || !song.id) { toast('No song selected'); return; }
    if (song.isLocal) {
      // After a reload the persisted blob URL is gone, so re-mint it first.
      const url = await LocalFileManager.resolveStreamUrl(song);
      if (!url) {
        toast('This local file is no longer stored. Re-import it from your device.');
        return;
      }
      const a = document.createElement('a');
      a.href = url;
      // Local imports kept their title but lost their extension entirely, so the
      // saved file arrived with no type and would not open in a music player.
      // The original filename is the best source for the real extension.
      const localExt = (/\.([a-z0-9]{2,4})$/i.exec(song.fileName || song.originalName || '') || [])[1];
      a.download = `${buildTrackFilename(song)}.${(localExt || 'mp3').toLowerCase()}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }
    if (song.isCloud) {
      toast('Downloads are available for YouTube search results.');
      return;
    }
    if (activeDownloads.has(song.id)) {
      toast('That download is already running.');
      return;
    }

    activeDownloads.add(song.id);
    toast(`⏳ Preparing MP3 download for "${(song.title || 'track').slice(0, 25)}..."`);

    let objectUrl = null;
    try {
      // Passing the title we already have means a yt-dlp metadata failure no longer
      // degrades the filename to a placeholder.
      const params = new URLSearchParams({ title: song.title || '', artist: song.channel || '' });
      const response = await fetch(`/api/download/${encodeURIComponent(song.id)}?${params}`);

      if (!response.ok) {
        // The server explains itself in JSON; passing that through beats a
        // generic "Server busy" for every failure mode.
        let detail = `Server responded ${response.status}`;
        try {
          const body = await response.json();
          if (body && body.error) detail = body.error;
        } catch (e) {}
        throw new Error(detail);
      }

      const blob = await response.blob();
      if (!blob || blob.size === 0) throw new Error('The server returned an empty file');

      const serverName = filenameFromDisposition(response.headers.get('Content-Disposition'));
      const localName = buildTrackFilename(song);
      // The server's name wins only when it is actually informative.
      let filename = (serverName && !isPlaceholderName(serverName))
        ? safeDownloadName(serverName)
        : localName;
      if (!/\.mp3$/i.test(filename)) filename += '.mp3';

      objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast(`✅ Saved "${filename}" to your downloads.`);
    } catch (err) {
      console.warn('[download]', err);
      toast(`⚠️ Download failed: ${err.message || 'unknown error'}`);
    } finally {
      // Revoking too early cancels the save in some browsers; 60s is safe and
      // still bounded, unlike leaking the blob for the whole session.
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      activeDownloads.delete(song.id);
    }
  }

  /* ================================================================
     PLAYLIST BATCH DOWNLOAD (ZIP)
     ================================================================ */
  // Transcoding a whole playlist takes minutes, which is far too long to hold a
  // request open, so the server runs it as a job and we poll for progress.
  const PLAYLIST_DL_POLL_MS = 1500;
  const PLAYLIST_DL_MAX_TRACKS = 50;   // must match MAX_PLAYLIST_TRACKS server-side

  let playlistDlJobId = null;
  let playlistDlTimer = null;
  let playlistDlName = 'Playlist';
  let playlistDlSaved = false;

  // Only real YouTube ids can be transcoded server-side. Local imports are
  // already on the user's disk and cloud tracks have no downloadable source.
  function isDownloadableTrack(s) {
    return !!(s && typeof s.id === 'string' && !s.isLocal && !s.isCloud && /^[a-zA-Z0-9_-]{11}$/.test(s.id));
  }

  function setPlaylistDlProgress(percent, statusText) {
    const fill = $('#playlistDlFill');
    const pct = $('#playlistDlPercent');
    const status = $('#playlistDlStatus');
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    if (fill) fill.style.width = clamped + '%';
    if (pct) pct.textContent = clamped + '%';
    if (status && statusText) status.textContent = statusText;
  }

  function stopPlaylistDlPolling() {
    if (playlistDlTimer) {
      clearInterval(playlistDlTimer);
      playlistDlTimer = null;
    }
  }

  function hidePlaylistDlModal() {
    const modal = $('#playlistDlModal');
    if (modal) modal.style.display = 'none';
  }

  async function startPlaylistDownload() {
    const pl = playlists.find(p => p.id === currentPlaylistId);
    if (!pl) { toast('Open a playlist first'); return; }

    // A job already running: just reopen the progress view instead of starting
    // a second one the server would reject anyway.
    if (playlistDlJobId) {
      const modal = $('#playlistDlModal');
      if (modal) modal.style.display = '';
      return;
    }

    if (!pl.songs || !pl.songs.length) { toast('This playlist is empty'); return; }

    const all = pl.songs.slice();
    const eligible = all.filter(isDownloadableTrack);
    const skipped = all.length - eligible.length;

    if (!eligible.length) {
      toast('Nothing here can be downloaded — local files are already saved, and cloud tracks have no download source.');
      return;
    }

    const tracks = eligible.slice(0, PLAYLIST_DL_MAX_TRACKS);
    const overflow = eligible.length - tracks.length;

    // Tell the user up front what will not be in the zip, rather than letting
    // them discover a short archive afterwards.
    const notes = [];
    if (skipped) notes.push(`${skipped} track${skipped > 1 ? 's' : ''} skipped (local or cloud)`);
    if (overflow) notes.push(`limited to the first ${PLAYLIST_DL_MAX_TRACKS} tracks, ${overflow} left out`);

    playlistDlName = pl.name || 'Playlist';
    playlistDlSaved = false;

    const modal = $('#playlistDlModal');
    const failedBox = $('#playlistDlFailed');
    const saveBtn = $('#playlistDlSaveBtn');
    const cancelBtn = $('#playlistDlCancelBtn');
    const noteEl = $('#playlistDlNote');
    const currentEl = $('#playlistDlCurrent');

    if (failedBox) { failedBox.style.display = 'none'; failedBox.innerHTML = ''; }
    if (saveBtn) saveBtn.style.display = 'none';
    if (cancelBtn) { cancelBtn.style.display = ''; cancelBtn.disabled = false; cancelBtn.textContent = 'Cancel download'; }
    if (currentEl) currentEl.textContent = '';
    if (noteEl) {
      noteEl.textContent = notes.length ? `Note: ${notes.join('; ')}.` : '';
      noteEl.style.display = notes.length ? '' : 'none';
    }
    const subtitle = $('#playlistDlSubtitle');
    if (subtitle) {
      subtitle.textContent = `Converting ${tracks.length} track${tracks.length > 1 ? 's' : ''} to MP3, then bundling them into one zip file. This can take a few minutes.`;
    }
    setPlaylistDlProgress(0, 'Starting…');
    if (modal) modal.style.display = '';

    try {
      const res = await fetch('/api/playlist-download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: playlistDlName,
          tracks: tracks.map(s => ({ id: s.id, title: s.title || s.id })),
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        // 409 means another playlist job owns the conversion slots.
        throw new Error(data.error || `Server responded ${res.status}`);
      }

      playlistDlJobId = data.jobId;
      setPlaylistDlProgress(2, `0 of ${data.total} tracks converted`);
      stopPlaylistDlPolling();
      playlistDlTimer = setInterval(pollPlaylistDownload, PLAYLIST_DL_POLL_MS);
      pollPlaylistDownload();
    } catch (err) {
      console.warn('[playlist download]', err);
      failPlaylistDownload(err.message || 'Could not start the download');
    }
  }

  function failPlaylistDownload(message) {
    stopPlaylistDlPolling();
    playlistDlJobId = null;
    const cancelBtn = $('#playlistDlCancelBtn');
    if (cancelBtn) { cancelBtn.textContent = 'Close'; cancelBtn.disabled = false; }
    setPlaylistDlProgress(0, 'Failed');
    const currentEl = $('#playlistDlCurrent');
    if (currentEl) currentEl.textContent = message;
    toast(`⚠️ ${message}`);
  }

  async function pollPlaylistDownload() {
    if (!playlistDlJobId) { stopPlaylistDlPolling(); return; }

    let data;
    try {
      const res = await fetch(`/api/playlist-download/${encodeURIComponent(playlistDlJobId)}`);
      if (res.status === 404) {
        // The job expired or the server restarted mid-run.
        failPlaylistDownload('The download job expired. Please try again.');
        return;
      }
      data = await res.json();
    } catch (err) {
      // A single failed poll is usually a transient blip; keep polling and let
      // a real failure surface on a later tick.
      console.warn('[playlist download poll]', err);
      return;
    }

    const done = (data.completed || 0) + (data.failed || 0);
    const total = data.total || 1;
    const currentEl = $('#playlistDlCurrent');

    if (data.status === 'queued' || data.status === 'downloading') {
      // Converting is the long part, so it owns 0-90% of the bar and zipping
      // gets the rest. A bar that sat at 100% while still working would read
      // as frozen.
      setPlaylistDlProgress((done / total) * 90, `${data.completed || 0} of ${total} tracks converted`);
      if (currentEl) currentEl.textContent = data.current ? `Now converting: ${data.current}` : '';
      renderPlaylistDlFailures(data);
      return;
    }

    if (data.status === 'zipping') {
      setPlaylistDlProgress(95, 'Building the zip file…');
      if (currentEl) currentEl.textContent = '';
      renderPlaylistDlFailures(data);
      return;
    }

    if (data.status === 'ready' || data.status === 'downloaded') {
      stopPlaylistDlPolling();
      setPlaylistDlProgress(100, 'Ready');
      renderPlaylistDlFailures(data);
      const mb = data.size ? (data.size / (1024 * 1024)).toFixed(1) : null;
      if (currentEl) {
        currentEl.textContent = `${data.completed} track${data.completed > 1 ? 's' : ''} bundled${mb ? ` — ${mb} MB` : ''}.`;
      }
      const cancelBtn = $('#playlistDlCancelBtn');
      if (cancelBtn) cancelBtn.textContent = 'Close';
      const saveBtn = $('#playlistDlSaveBtn');
      if (saveBtn) saveBtn.style.display = '';

      // Auto-save once, with the button left visible as a manual fallback in
      // case the browser declines a download this far from the original click.
      if (!playlistDlSaved) {
        playlistDlSaved = true;
        savePlaylistZip();
      }
      return;
    }

    if (data.status === 'cancelled') {
      stopPlaylistDlPolling();
      playlistDlJobId = null;
      hidePlaylistDlModal();
      toast('Download cancelled');
      return;
    }

    if (data.status === 'error') {
      failPlaylistDownload(data.error || 'The download failed');
      return;
    }
  }

  function renderPlaylistDlFailures(data) {
    const box = $('#playlistDlFailed');
    if (!box) return;
    if (!data.failed) { box.style.display = 'none'; box.innerHTML = ''; return; }
    const titles = (data.failedTitles || []).map(t => `<li>${esc(t)}</li>`).join('');
    const more = data.failed > (data.failedTitles || []).length
      ? `<li>and ${data.failed - (data.failedTitles || []).length} more</li>` : '';
    box.innerHTML = `<strong>${data.failed} track${data.failed > 1 ? 's' : ''} could not be downloaded</strong>` +
      `<ul>${titles}${more}</ul>` +
      `<span class="playlist-dl-failed-hint">The rest are still included in the zip.</span>`;
    box.style.display = '';
  }

  // Handed to the browser as a plain link rather than fetched into a blob: an
  // album-sized archive would otherwise sit in JS memory twice, and this way
  // the browser shows its own download progress and handles the save natively.
  function savePlaylistZip() {
    if (!playlistDlJobId) return;
    const a = document.createElement('a');
    a.href = `/api/playlist-download/${encodeURIComponent(playlistDlJobId)}/file`;
    a.download = `${safeDownloadName(playlistDlName)}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('✅ Saving your playlist zip…');
  }

  async function cancelOrClosePlaylistDownload() {
    const jobId = playlistDlJobId;
    stopPlaylistDlPolling();

    // Once the archive exists, this button is just "Close" — cancelling would
    // delete the file the user is in the middle of saving.
    const isFinished = $('#playlistDlSaveBtn') && $('#playlistDlSaveBtn').style.display !== 'none';
    if (isFinished || !jobId) {
      playlistDlJobId = null;
      hidePlaylistDlModal();
      return;
    }

    playlistDlJobId = null;
    hidePlaylistDlModal();
    toast('Cancelling download…');
    try {
      await fetch(`/api/playlist-download/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
    } catch (err) {
      // The job aborts on its own when the server notices; nothing to do.
      console.warn('[playlist download cancel]', err);
    }
  }

  /* ================================================================
     MOBILE SIDEBAR
     ================================================================ */
  function toggleMobileSidebar() {
    const sidebar = $('#sidebar');
    sidebar.classList.toggle('open');
    let overlay = $('.sidebar-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'sidebar-overlay';
      document.body.appendChild(overlay);
      overlay.addEventListener('click', closeMobileSidebar);
    }
    overlay.classList.toggle('active', sidebar.classList.contains('open'));
  }

  function closeMobileSidebar() {
    $('#sidebar').classList.remove('open');
    const overlay = $('.sidebar-overlay');
    if (overlay) overlay.classList.remove('active');
  }

  /* ================================================================
     MOBILE PLAYER SHEET
     Below 640px the stylesheet hides .np-right-controls, #shuffleBtn,
     #repeatBtn and .np-like-btn, which left Lyrics, Sleep Timer, EQ,
     Share, Download, Quality, Mute, Volume, Shuffle, Repeat and Like
     completely unreachable on a phone. This sheet delegates to the same
     handlers the desktop buttons use — no duplicated logic, so the two
     paths can't drift apart.
     ================================================================ */
  const MOBILE_SHEET_ACTIONS = [
    ['#mobileLikeBtn', () => { if (currentSong) toggleLike(currentSong); }, { keepOpen: true }],
    ['#mobileDislikeBtn', () => { if (currentSong) toggleDislike(currentSong); }, { keepOpen: true }],
    ['#mobileShuffleBtn', () => toggleShuffle(), { keepOpen: true }],
    ['#mobileRepeatBtn', () => toggleRepeat(), { keepOpen: true }],
    ['#mobileLyricsBtn', () => toggleLyrics()],
    ['#mobileSleepBtn', () => SleepTimerManager.openModal()],
    ['#mobileEqBtn', () => EqualizerManager.openModal()],
    ['#mobileShareBtn', () => shareSong()],
    ['#mobileDownloadBtn', () => { if (currentSong) downloadSong(currentSong); }],
    ['#mobileQualityBtn', () => $('#qualityBtn')?.click(), { keepOpen: true }],
  ];

  function isMobileSheetOpen() {
    return !!$('#mobileSheetOverlay')?.classList.contains('active');
  }

  function openMobileSheet() {
    const ov = $('#mobileSheetOverlay');
    if (!ov) return;
    ov.style.display = '';
    ov.classList.add('active');
    $('#npMoreBtn')?.setAttribute('aria-expanded', 'true');
    reflectMobileSheetState();
  }

  function closeMobileSheet() {
    const ov = $('#mobileSheetOverlay');
    if (!ov) return;
    ov.classList.remove('active');
    ov.style.display = 'none';
    $('#npMoreBtn')?.setAttribute('aria-expanded', 'false');
  }

  function toggleMobileSheet() {
    if (isMobileSheetOpen()) closeMobileSheet(); else openMobileSheet();
  }

  // Keeps the sheet honest about what's currently on. Without this, opening it
  // after toggling shuffle from the keyboard showed shuffle as off.
  function reflectMobileSheetState() {
    if (!$('#mobileSheetOverlay')) return;

    const title = $('#mobileSheetTitle');
    // textContent, not innerHTML: titles come from search results and are untrusted.
    if (title) title.textContent = currentSong ? (currentSong.title || 'Now playing') : 'Player controls';

    $('#mobileShuffleBtn')?.classList.toggle('active', isShuffle);
    $('#mobileRepeatBtn')?.classList.toggle('active', repeatMode !== 'off');
    const rep = $('#mobileRepeatBtn')?.querySelector('span:last-child');
    if (rep) rep.textContent = repeatMode === 'one' ? 'Repeat 1' : repeatMode === 'all' ? 'Repeat All' : 'Repeat';

    $('#mobileLikeBtn')?.classList.toggle('active', !!currentSong && isLiked(currentSong.id));
    $('#mobileDislikeBtn')?.classList.toggle('active', !!currentSong && isDisliked(currentSong.id));
    $('#mobileLyricsBtn')?.classList.toggle('active', !!$('#lyricsPanel')?.classList.contains('open'));
    // SleepTimerManager shows #sleepBadge by writing style.display, it never adds
    // a class. Checking for a 'visible' class (as the queue badge uses) would be
    // dead code: the sleep button would never light up. Read what it writes.
    const sleepBadge = $('#sleepBadge');
    const sleepOn = !!sleepBadge && sleepBadge.style.display !== 'none';
    $('#mobileSleepBtn')?.classList.toggle('active', sleepOn);

    // Local and cloud tracks have no YouTube id, so share/download/lyrics can't work.
    const remoteOnly = !currentSong || currentSong.isLocal || currentSong.isCloud;
    ['#mobileShareBtn', '#mobileDownloadBtn'].forEach(sel => {
      const b = $(sel); if (b) b.disabled = remoteOnly;
    });
    ['#mobileLikeBtn', '#mobileDislikeBtn'].forEach(sel => { const b = $(sel); if (b) b.disabled = !currentSong; });

    setMobileMuteIcon(audioPlayer.muted);
    updateVolumeUI();
  }

  function setMobileMuteIcon(muted) {
    const btn = $('#mobileMuteBtn');
    if (!btn) return;
    btn.classList.toggle('active', !muted);
    btn.title = muted ? 'Unmute' : 'Mute';
  }

  function bindMobileSheet() {
    $('#npMoreBtn')?.addEventListener('click', toggleMobileSheet);
    $('#mobileSheetCloseBtn')?.addEventListener('click', closeMobileSheet);
    // Tap the backdrop to dismiss, but only the backdrop — a tap that lands on
    // the sheet itself must not close it.
    $('#mobileSheetOverlay')?.addEventListener('click', (e) => {
      if (e.target === $('#mobileSheetOverlay')) closeMobileSheet();
    });

    MOBILE_SHEET_ACTIONS.forEach(([sel, fn, opts]) => {
      $(sel)?.addEventListener('click', () => {
        fn();
        // Toggles stay open so several can be flipped in one visit; anything
        // that opens a panel or modal closes the sheet so it isn't buried.
        if (opts && opts.keepOpen) reflectMobileSheetState();
        else closeMobileSheet();
      });
    });

    $('#mobileMuteBtn')?.addEventListener('click', () => { toggleMute(); setMobileMuteIcon(audioPlayer.muted); });

    // 'input' not 'change': change only fires on release, so the volume
    // wouldn't follow the finger.
    $('#mobileVolumeRange')?.addEventListener('input', (e) => {
      const pct = Number(e.target.value);
      setVolume((Number.isFinite(pct) ? pct : 80) / 100);
      setMobileMuteIcon(audioPlayer.muted);
    });
  }

  /* ================================================================
     KEYBOARD SHORTCUT HELP
     ================================================================ */
  function isShortcutHelpOpen() {
    return !!$('#shortcutHelpOverlay')?.classList.contains('active');
  }

  function toggleShortcutHelp(force) {
    const ov = $('#shortcutHelpOverlay');
    if (!ov) return;
    const show = force === undefined ? !isShortcutHelpOpen() : !!force;
    ov.classList.toggle('active', show);
    ov.style.display = show ? '' : 'none';
  }

  function bindShortcutHelp() {
    $('#shortcutHelpCloseBtn')?.addEventListener('click', () => toggleShortcutHelp(false));
    $('#shortcutHelpOverlay')?.addEventListener('click', (e) => {
      if (e.target === $('#shortcutHelpOverlay')) toggleShortcutHelp(false);
    });
    $('#shortcutsBtn')?.addEventListener('click', () => {
      // The button lives inside Settings; leaving Settings open would bury the
      // list the user just asked for behind the modal backdrop.
      if ($('#settingsModal')) $('#settingsModal').style.display = 'none';
      toggleShortcutHelp(true);
    });
  }

  /* Escape used to do nothing, so a modal opened on a device without a visible
     close button was a dead end. Closes exactly one layer per press, topmost
     first, matching what the user sees stacked on screen. */
  function closeTopmostOverlay() {
    // Help sits above .modal-overlay (it's reachable from inside Settings), so
    // it has to be checked first or Escape would close Settings underneath it.
    if (isShortcutHelpOpen()) { toggleShortcutHelp(false); return true; }

    const openModal = Array.from(document.querySelectorAll('.modal-overlay'))
      .find(m => m.style.display !== 'none');
    if (openModal) { openModal.style.display = 'none'; return true; }

    if (isMobileSheetOpen()) { closeMobileSheet(); return true; }

    const sugg = $('#searchSuggestions');
    if (sugg && sugg.classList.contains('active')) { sugg.classList.remove('active'); sugg.innerHTML = ''; return true; }

    if ($('#lyricsPanel')?.classList.contains('open')) { toggleLyrics(); return true; }
    if ($('#queueSidebar')?.classList.contains('open')) { toggleQueue(); return true; }
    if ($('#sidebar')?.classList.contains('open')) { closeMobileSidebar(); return true; }

    return false;
  }

  /* ================================================================
     KEYBOARD SHORTCUTS & GLOBAL HOTKEYS
     ================================================================ */
  function onKeyboard(e) {
    // Browser and OS chords must keep working: without this, Ctrl+D bookmarked
    // *and* downloaded, Ctrl+F opened Pomodoro instead of Find, Ctrl+L hit the
    // address bar and toggled lyrics, Ctrl+P printed and toggled PiP.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // SELECT and contenteditable were missing from the guard, so arrow keys used
    // to change the theme dropdown *and* the volume at the same time.
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;

    switch (e.key) {
      case ' ': e.preventDefault(); togglePlayPause(); break;
      case 'ArrowRight': e.preventDefault(); if (audioPlayer.duration) audioPlayer.currentTime = Math.min(audioPlayer.duration, audioPlayer.currentTime + 5); break;
      case 'ArrowLeft': e.preventDefault(); audioPlayer.currentTime = Math.max(0, audioPlayer.currentTime - 5); break;
      case 'ArrowUp': e.preventDefault(); setVolume(volume + 0.05); break;
      case 'ArrowDown': e.preventDefault(); setVolume(volume - 0.05); break;
      case 'm': case 'M': toggleMute(); break;
      case 'n': case 'N': playNext(); break;
      case 'b': case 'B': playPrev(); break;
      case 's': case 'S': toggleShuffle(); break;
      case 'r': case 'R': toggleRepeat(); break;
      case 'p': case 'P':
        if (e.shiftKey) playPrev();
        else CanvasPiPManager.toggle();
        break;
      case 'f': case 'F': PomodoroManager.openModal(); break;
      case 'q': case 'Q': toggleQueue(); break;
      case 'l': case 'L': toggleLyrics(); break;
      case 'h': case 'H': if (currentSong) toggleLike(currentSong); break;
      case 'j': case 'J': if (currentSong) toggleDislike(currentSong); break;
      case 'd': case 'D': if (currentSong) downloadSong(currentSong); break;
      case '/': e.preventDefault(); navigateTo('search'); searchInput?.focus(); break;
      case '?': e.preventDefault(); toggleShortcutHelp(); break;
      case 'Escape': closeTopmostOverlay(); break;
    }
  }

  /* ================================================================
     APPLE FLOATING TRANSPARENT DYNAMIC ORB CONTROLLER
     ================================================================ */
  const AppleOrbController = {
    orb: null,
    core: null,
    capsule: null,
    art: null,
    capsuleArt: null,
    capsuleTitle: null,
    capsuleArtist: null,
    capsuleFill: null,
    orbPlayIcon: null,
    orbPauseIcon: null,
    isExpanded: false,
    isDragging: false,
    hasDragged: false,
    startX: 0,
    startY: 0,
    initialX: 0,
    initialY: 0,

    init() {
      this.orb = $('#appleFloatingOrb');
      if (!this.orb) return;

      this.core = $('#orbCircleCore');
      this.capsule = $('#orbExpandedCapsule');
      this.art = $('#orbArt');
      this.capsuleArt = $('#capsuleArt');
      this.capsuleTitle = $('#capsuleTitle');
      this.capsuleArtist = $('#capsuleArtist');
      this.capsuleFill = $('#capsuleProgressFill');
      this.orbPlayIcon = $('.orb-play-icon');
      this.orbPauseIcon = $('.orb-pause-icon');

      const orbSetting = Storage.get('orb', 'show');
      this.orb.style.display = orbSetting === 'hide' ? 'none' : '';

      // Dragging logic with touch & pointer support
      this.core.addEventListener('pointerdown', (e) => this.onDragStart(e));
      window.addEventListener('pointermove', (e) => this.onDragMove(e));
      window.addEventListener('pointerup', (e) => this.onDragEnd(e));

      // Expand & Collapse
      this.core.addEventListener('click', (e) => {
        if (this.hasDragged) {
          this.hasDragged = false;
          return;
        }
        this.toggleExpand();
      });

      $('#orbCloseBtn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.collapse();
      });

      $('#orbPlayPauseBtn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePlayPause();
      });

      $('#orbNextBtn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        playNext();
      });

      $('#orbPrevBtn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        playPrev();
      });

      // Quick Switch instant hit
      $('#orbQuickSwitchBtn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.quickSwitch();
      });

      // PiP & Focus buttons in capsule
      $('#orbPipBtn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        CanvasPiPManager.toggle();
      });

      $('#orbFocusBtn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        PomodoroManager.openModal();
      });

      // Seek progress in capsule
      $('#capsuleProgressBar')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        if (audioPlayer.duration) audioPlayer.currentTime = pct * audioPlayer.duration;
      });

      // Restore saved orb position
      const savedPos = Storage.get('orb_pos', null);
      if (savedPos && savedPos.x !== undefined && savedPos.y !== undefined) {
        this.orb.style.left = savedPos.x + 'px';
        this.orb.style.top = savedPos.y + 'px';
        this.orb.style.bottom = 'auto';
        this.orb.style.right = 'auto';
      }
    },

    onDragStart(e) {
      if (this.isExpanded) return;
      this.isDragging = true;
      this.hasDragged = false;
      this.startX = e.clientX;
      this.startY = e.clientY;
      const rect = this.orb.getBoundingClientRect();
      this.initialX = rect.left;
      this.initialY = rect.top;
    },

    onDragMove(e) {
      if (!this.isDragging) return;
      const dx = e.clientX - this.startX;
      const dy = e.clientY - this.startY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        this.hasDragged = true;
      }
      const newX = Math.max(10, Math.min(window.innerWidth - 74, this.initialX + dx));
      const newY = Math.max(10, Math.min(window.innerHeight - 150, this.initialY + dy));
      this.orb.style.left = newX + 'px';
      this.orb.style.top = newY + 'px';
      this.orb.style.bottom = 'auto';
      this.orb.style.right = 'auto';
    },

    onDragEnd(e) {
      if (!this.isDragging) return;
      this.isDragging = false;
      if (this.hasDragged) {
        const rect = this.orb.getBoundingClientRect();
        const snapLeft = rect.left < window.innerWidth / 2 ? 20 : window.innerWidth - 84;
        this.orb.style.transition = 'left 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)';
        this.orb.style.left = snapLeft + 'px';
        setTimeout(() => {
          this.orb.style.transition = '';
          Storage.set('orb_pos', { x: snapLeft, y: rect.top });
        }, 300);
      }
    },

    toggleExpand() {
      this.isExpanded ? this.collapse() : this.expand();
    },

    expand() {
      this.isExpanded = true;
      if (this.capsule) this.capsule.style.display = 'block';
      if (this.core) this.core.style.display = 'none';
    },

    collapse() {
      this.isExpanded = false;
      if (this.capsule) this.capsule.style.display = 'none';
      if (this.core) this.core.style.display = 'flex';
    },

    updateSong(song, playing) {
      if (!song) return;
      const artwork = thumb(song);
      if (this.art) this.art.src = artwork;
      if (this.capsuleArt) this.capsuleArt.src = artwork;
      if (this.capsuleTitle) this.capsuleTitle.textContent = song.title || 'MusicFlow';
      if (this.capsuleArtist) this.capsuleArtist.textContent = song.channel || 'Now Playing';
      this.setPlaying(playing);
    },

    setPlaying(playing) {
      if (this.orb) this.orb.classList.toggle('playing', playing);
      if (this.orbPlayIcon) this.orbPlayIcon.style.display = playing ? 'none' : '';
      if (this.orbPauseIcon) this.orbPauseIcon.style.display = playing ? '' : 'none';
    },

    updateProgress(currentTime, duration) {
      if (duration > 0 && this.capsuleFill) {
        const pct = (currentTime / duration) * 100;
        this.capsuleFill.style.width = pct + '%';
      }
    },

    async quickSwitch() {
      toast('⚡ Instant Switch: Finding next track...');
      if (queue.length > currentIndex + 1) {
        playNext();
        return;
      }
      try {
        const res = await fetch(`/api/recommendations?seedQueries=${encodeURIComponent(currentSong?.title || 'trending hits')}`);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && data.length > 0) {
            const nextSong = data[Math.floor(Math.random() * Math.min(6, data.length))];
            playSong(nextSong);
            return;
          }
        }
      } catch {}
      playNext();
    }
  };

  /* ================================================================
     ALWAYS-ON-TOP PICTURE-IN-PICTURE (PiP) MINI PLAYER
     ================================================================ */
  const CanvasPiPManager = {
    video: null,
    canvas: null,
    ctx: null,
    animId: null,
    cachedThumbImg: new Image(),

    init() {
      this.video = $('#pipVideo');
      this.canvas = $('#pipCanvas');
      if (!this.canvas || !this.video) return;

      this.ctx = this.canvas.getContext('2d');
      this.cachedThumbImg.crossOrigin = 'anonymous';

      // PiP Action Buttons
      $('#pipBtn')?.addEventListener('click', () => this.toggle());
      $('#pipBtnTop')?.addEventListener('click', () => this.toggle());
      $('#focusLaunchPipBtn')?.addEventListener('click', () => this.toggle());
      $('#settingLaunchPipBtn')?.addEventListener('click', () => this.toggle());

      this.video.addEventListener('leavepictureinpicture', () => {
        this.stopRenderLoop();
        $('#pipBtn')?.classList.remove('active');
        $('#pipBtnTop')?.classList.remove('active');
      });

      this.video.addEventListener('enterpictureinpicture', () => {
        this.startRenderLoop();
        $('#pipBtn')?.classList.add('active');
        $('#pipBtnTop')?.classList.add('active');
      });
    },

    async toggle() {
      if (document.pictureInPictureElement) {
        try {
          await document.exitPictureInPicture();
          toast('Picture-in-Picture Mini closed');
        } catch {}
        return;
      }

      if (!('pictureInPictureEnabled' in document)) {
        toast('⚠️ Picture-in-Picture is not supported in this browser');
        return;
      }

      try {
        this.drawFrame();
        const stream = this.canvas.captureStream(25);
        this.video.srcObject = stream;
        await this.video.play();
        await this.video.requestPictureInPicture();
        toast('🖼️ Always-On-Top Mini-Player active!');
      } catch (err) {
        console.warn('PiP launch error:', err);
        toast('⚠️ Could not open PiP: ' + (err.message || 'Check browser permissions'));
      }
    },

    startRenderLoop() {
      if (this.animId) cancelAnimationFrame(this.animId);
      const loop = () => {
        this.drawFrame();
        if (document.pictureInPictureElement) {
          this.animId = requestAnimationFrame(loop);
        }
      };
      this.animId = requestAnimationFrame(loop);
    },

    stopRenderLoop() {
      if (this.animId) cancelAnimationFrame(this.animId);
      this.animId = null;
    },

    updateSong(song) {
      if (song) {
        this.cachedThumbImg.src = thumb(song);
      }
    },

    drawFrame() {
      const ctx = this.ctx;
      if (!ctx || !this.canvas) return;
      const w = this.canvas.width;
      const h = this.canvas.height;

      // Dark Glass Background
      const bgGrad = ctx.createLinearGradient(0, 0, w, h);
      bgGrad.addColorStop(0, '#0f172a');
      bgGrad.addColorStop(0.5, '#1e1b4b');
      bgGrad.addColorStop(1, '#090d16');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, w, h);

      // Artwork Rounded Box
      const artSize = 160;
      const artX = 30;
      const artY = (h - artSize) / 2;

      ctx.save();
      ctx.shadowColor = 'rgba(99, 102, 241, 0.45)';
      ctx.shadowBlur = 24;
      ctx.beginPath();
      ctx.roundRect(artX, artY, artSize, artSize, 18);
      ctx.fillStyle = '#1e293b';
      ctx.fill();
      ctx.restore();

      if (this.cachedThumbImg.complete && this.cachedThumbImg.naturalWidth) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(artX, artY, artSize, artSize, 18);
        ctx.clip();
        ctx.drawImage(this.cachedThumbImg, artX, artY, artSize, artSize);
        ctx.restore();
      }

      // Title & Channel info
      const textX = artX + artSize + 24;
      ctx.fillStyle = '#818cf8';
      ctx.font = 'bold 13px Inter, sans-serif';
      ctx.fillText('🎵 MUSICFLOW MINI', textX, artY + 24);

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 18px Inter, sans-serif';
      const title = (currentSong?.title || 'MusicFlow').slice(0, 24);
      ctx.fillText(title, textX, artY + 54);

      ctx.fillStyle = '#94a3b8';
      ctx.font = '14px Inter, sans-serif';
      const channel = (currentSong?.channel || 'Ready to Play').slice(0, 28);
      ctx.fillText(channel, textX, artY + 80);

      // Visualizer soundbars
      const bars = 8;
      const barW = 6;
      const now = Date.now() / 200;
      for (let i = 0; i < bars; i++) {
        const bh = isPlaying ? Math.abs(Math.sin(now + i * 0.8)) * 26 + 6 : 4;
        const bx = textX + i * (barW + 5);
        const by = artY + 115 - bh;
        ctx.fillStyle = isPlaying ? '#a855f7' : '#475569';
        ctx.beginPath();
        ctx.roundRect(bx, by, barW, bh, 3);
        ctx.fill();
      }

      // Progress bar
      const progY = h - 28;
      const progW = w - 60;
      const progH = 6;
      const dur = audioPlayer.duration || 1;
      const cur = audioPlayer.currentTime || 0;
      const pct = Math.min(1, cur / dur);

      ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.beginPath();
      ctx.roundRect(30, progY, progW, progH, 3);
      ctx.fill();

      ctx.fillStyle = '#6366f1';
      ctx.beginPath();
      ctx.roundRect(30, progY, Math.max(progH, progW * pct), progH, 3);
      ctx.fill();

      // Time Stamp
      ctx.fillStyle = '#94a3b8';
      ctx.font = '11px Inter, monospace';
      ctx.fillText(`${fmtTime(cur)} / ${fmtTime(dur)}`, textX + 110, artY + 110);
    }
  };

  /* ================================================================
     POMODORO FOCUS FLOW & SYNTHETIC AMBIENT GENERATOR
     ================================================================ */
  const PomodoroManager = {
    modal: null,
    digits: null,
    label: null,
    ring: null,
    startBtn: null,
    resetBtn: null,
    blocksCompletedEl: null,
    minutesCompletedEl: null,
    
    timer: null,
    totalSeconds: 25 * 60,
    remainingSeconds: 25 * 60,
    isRunning: false,
    currentMode: 'focus',
    blocksCount: Storage.get('pomo_blocks', 0),
    minutesCount: Storage.get('pomo_minutes', 0),

    audioCtx: null,
    ambientNodes: {},

    init() {
      this.modal = $('#focusModalOverlay');
      if (!this.modal) return;

      this.digits = $('#pomodoroDigits');
      this.label = $('#pomodoroStatusLabel');
      this.ring = $('#pomodoroRing');
      this.startBtn = $('#pomodoroStartBtn');
      this.resetBtn = $('#pomodoroResetBtn');
      this.blocksCompletedEl = $('#focusBlocksCompleted');
      this.minutesCompletedEl = $('#focusMinutesCompleted');

      this.updateDisplay();
      this.updateStatsUI();

      // Modal triggers
      $('#focusModeBtn')?.addEventListener('click', () => this.openModal());
      $('#npFocusBtn')?.addEventListener('click', () => this.openModal());
      $('#navFocus')?.addEventListener('click', (e) => {
        e.preventDefault();
        this.openModal();
      });
      $('#focusModalCloseBtn')?.addEventListener('click', () => this.closeModal());
      this.modal.addEventListener('click', (e) => {
        if (e.target === this.modal) this.closeModal();
      });

      // Controls
      this.startBtn?.addEventListener('click', () => this.toggleTimer());
      this.resetBtn?.addEventListener('click', () => this.resetTimer());

      // Presets
      $$('.pomo-preset').forEach(btn => {
        btn.addEventListener('click', () => {
          $$('.pomo-preset').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          const mins = parseInt(btn.dataset.mins) || 25;
          this.currentMode = btn.dataset.type || 'focus';
          this.setDuration(mins);
        });
      });

      // Focus Music Presets
      $$('.focus-preset-card').forEach(card => {
        card.addEventListener('click', () => {
          const query = card.dataset.query;
          if (query) {
            toast(`🎧 Starting: ${card.querySelector('.fp-name').textContent}`);
            searchInput.value = query;
            navigateTo('search');
            doSearch(query);
            this.closeModal();
          }
        });
      });

      // Ambient Sound Chips
      $$('.ambient-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const soundType = chip.dataset.sound;
          this.toggleAmbientSound(soundType, chip);
        });
      });
    },

    openModal() {
      if (this.modal) this.modal.style.display = 'flex';
    },

    closeModal() {
      if (this.modal) this.modal.style.display = 'none';
    },

    setDuration(mins) {
      this.pauseTimer();
      this.totalSeconds = mins * 60;
      this.remainingSeconds = this.totalSeconds;
      if (this.label) this.label.textContent = this.currentMode === 'focus' ? 'Focus Session' : 'Rest Break';
      this.updateDisplay();
    },

    toggleTimer() {
      this.isRunning ? this.pauseTimer() : this.startTimer();
    },

    startTimer() {
      this.isRunning = true;
      if (this.startBtn) {
        this.startBtn.textContent = 'Pause';
        this.startBtn.classList.remove('pomodoro-primary');
      }
      this.timer = setInterval(() => this.tick(), 1000);
    },

    pauseTimer() {
      this.isRunning = false;
      if (this.startBtn) {
        this.startBtn.textContent = 'Start Focus';
        this.startBtn.classList.add('pomodoro-primary');
      }
      clearInterval(this.timer);
    },

    resetTimer() {
      this.pauseTimer();
      this.remainingSeconds = this.totalSeconds;
      this.updateDisplay();
    },

    tick() {
      if (this.remainingSeconds > 0) {
        this.remainingSeconds--;
        if (this.currentMode === 'focus') {
          this.minutesCount += (1 / 60);
          if (Math.floor(this.minutesCount) > Storage.get('pomo_minutes', 0)) {
            Storage.set('pomo_minutes', Math.floor(this.minutesCount));
            this.updateStatsUI();
          }
        }
        this.updateDisplay();
      } else {
        this.pauseTimer();
        if (this.currentMode === 'focus') {
          this.blocksCount++;
          Storage.set('pomo_blocks', this.blocksCount);
          this.updateStatsUI();
          toast('🎉 Focus session completed! Great job! Take a short break.');
          this.currentMode = 'break';
          this.setDuration(5);
        } else {
          toast('⚡ Break over! Ready for next session?');
          this.currentMode = 'focus';
          this.setDuration(25);
        }
      }
    },

    updateDisplay() {
      const mins = Math.floor(this.remainingSeconds / 60);
      const secs = this.remainingSeconds % 60;
      if (this.digits) this.digits.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

      if (this.ring) {
        const pct = this.remainingSeconds / this.totalSeconds;
        const offset = 440 * (1 - pct);
        this.ring.style.strokeDashoffset = offset;
      }
    },

    updateStatsUI() {
      if (this.blocksCompletedEl) this.blocksCompletedEl.textContent = this.blocksCount;
      if (this.minutesCompletedEl) this.minutesCompletedEl.textContent = Math.floor(this.minutesCount);
    },

    // Web Audio Synthesizer for ambient noise
    toggleAmbientSound(soundType, chipEl) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) {
        toast('Web Audio not supported');
        return;
      }
      if (!this.audioCtx) {
        this.audioCtx = new AudioCtx();
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }

      if (this.ambientNodes[soundType]) {
        try {
          const node = this.ambientNodes[soundType];
          node.gain.gain.linearRampToValueAtTime(0.001, this.audioCtx.currentTime + 0.4);
          setTimeout(() => {
            node.source.stop();
            delete this.ambientNodes[soundType];
          }, 450);
        } catch {}
        chipEl.classList.remove('active');
      } else {
        try {
          const bufferSize = this.audioCtx.sampleRate * 3;
          const buffer = this.audioCtx.createBuffer(1, bufferSize, this.audioCtx.sampleRate);
          const data = buffer.getChannelData(0);
          for (let i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * 0.12;
          }

          const noise = this.audioCtx.createBufferSource();
          noise.buffer = buffer;
          noise.loop = true;

          const filter = this.audioCtx.createBiquadFilter();
          let gainVal = 0.1;

          if (soundType === 'rain') {
            filter.type = 'lowpass';
            filter.frequency.value = 950;
            filter.Q.value = 1.2;
            gainVal = 0.12;
          } else if (soundType === 'waves') {
            filter.type = 'bandpass';
            filter.frequency.value = 450;
            filter.Q.value = 2.5;
            gainVal = 0.14;
          } else if (soundType === 'cafe') {
            filter.type = 'lowpass';
            filter.frequency.value = 650;
            filter.Q.value = 0.8;
            gainVal = 0.09;
          } else { // whitenoise
            filter.type = 'lowpass';
            filter.frequency.value = 1400;
            filter.Q.value = 0.5;
            gainVal = 0.08;
          }

          const gain = this.audioCtx.createGain();
          gain.gain.setValueAtTime(gainVal, this.audioCtx.currentTime);

          noise.connect(filter);
          filter.connect(gain);
          gain.connect(this.audioCtx.destination);
          noise.start();

          this.ambientNodes[soundType] = { source: noise, gain, filter };
          chipEl.classList.add('active');
          const icons = { rain: '🌧️ Rain', waves: '🌊 Ocean Waves', cafe: '☕ Cozy Cafe', whitenoise: '💨 White Noise' };
          toast(`${icons[soundType] || soundType} atmosphere active`);
        } catch (e) {
          console.warn('Ambient synth error:', e);
        }
      }
    }
  };

  /* ================================================================
     MEDIASESSION API INTEGRATION (Desktop & Mobile Lockscreen Controls)
     ================================================================ */
  function setupMediaSessionHandlers() {
    if (!('mediaSession' in navigator)) return;

    navigator.mediaSession.setActionHandler('play', () => togglePlayPause());
    navigator.mediaSession.setActionHandler('pause', () => togglePlayPause());
    navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
    navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
    
    try {
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime && audioPlayer.duration) {
          audioPlayer.currentTime = details.seekTime;
        }
      });
      navigator.mediaSession.setActionHandler('seekforward', () => {
        if (audioPlayer.duration) audioPlayer.currentTime = Math.min(audioPlayer.duration, audioPlayer.currentTime + 10);
      });
      navigator.mediaSession.setActionHandler('seekbackward', () => {
        audioPlayer.currentTime = Math.max(0, audioPlayer.currentTime - 10);
      });
      navigator.mediaSession.setActionHandler('stop', () => {
        audioPlayer.pause();
        audioPlayer.currentTime = 0;
      });
    } catch {}
  }

  function updateMediaSession(song) {
    if (!('mediaSession' in navigator) || !song) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title || 'Unknown Title',
      artist: song.channel || 'MusicFlow',
      album: 'MusicFlow Web',
      artwork: [
        { src: thumb(song), sizes: '512x512', type: 'image/jpeg' }
      ]
    });
  }

  /* ================================================================
     UTILITIES
     ================================================================ */
  function isCurrent(id) { return currentIndex >= 0 && queue[currentIndex] && queue[currentIndex].id === id; }

  // Thumbnails are attacker-influenced: CloudMusicEngine pulls them from a
  // third-party host, and they get persisted into likes/playlists/history. Only
  // http(s) URLs and data:image are allowed to reach a src attribute, so a value
  // like `x" onerror="…` or `javascript:…` can never survive interpolation.
  function thumb(s) {
    const raw = s && s.thumbnail;
    if (typeof raw === 'string' && /^(https?:\/\/|data:image\/)/i.test(raw) && !/["'<>\s]/.test(raw)) return raw;
    const id = String((s && s.id) || '').replace(/[^\w-]/g, '');
    return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  }

  // Ids reach `data-id` / `data-plid` attributes and are compared against stored
  // songs; strip anything that could terminate an attribute or a selector.
  function escId(v) { return String(v == null ? '' : v).replace(/[^\w.-]/g, ''); }

  function fmtDur(sec) {
    if (!sec) return '0:00';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s2 = Math.floor(sec % 60);
    return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s2).padStart(2,'0')}` : `${m}:${String(s2).padStart(2,'0')}`;
  }

  function fmtTime(sec) { return !sec || isNaN(sec) ? '0:00' : fmtDur(Math.floor(sec)); }

  // Serializing a text node escapes &, < and > but leaves quotes intact, and
  // esc() output is interpolated into double-quoted attributes (title=, data-query=).
  // A title of `x" onmouseover="…` would break out and land a live handler on the
  // card, so quotes are escaped explicitly here.
  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str == null ? '' : String(str);
    return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function timeAgo(dateStr) {
    const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  function toast(msg, dur = 3000) {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    toastContainer.appendChild(t);
    setTimeout(() => { t.classList.add('removing'); setTimeout(() => t.remove(), 300); }, dur);
  }

  /**
   * A toast with a single action button, used for undoing a destructive change.
   * Kept separate from toast() so every existing caller keeps its plain-text
   * behaviour, and built with textContent/createElement rather than innerHTML so
   * a song title can never inject markup.
   */
  function undoToast(msg, onUndo, dur = 7000) {
    const t = document.createElement('div');
    t.className = 'toast toast-action';

    const label = document.createElement('span');
    label.className = 'toast-action-msg';
    label.textContent = msg;

    const btn = document.createElement('button');
    btn.className = 'toast-undo-btn';
    btn.type = 'button';
    btn.textContent = 'Undo';

    t.appendChild(label);
    t.appendChild(btn);
    toastContainer.appendChild(t);

    let done = false;
    const dismiss = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      t.classList.add('removing');
      setTimeout(() => t.remove(), 300);
    };

    btn.addEventListener('click', () => {
      if (done) return;
      dismiss();
      try { onUndo(); } catch (e) { console.error('[undo] failed', e); toast('Could not undo that'); }
    });

    // Longer than a normal toast: undo is only useful if there is time to reach it.
    const timer = setTimeout(dismiss, dur);
  }

  /* ================================================================
     10-BAND AUDIO EQUALIZER, BASS BOOST & SPATIAL AUDIO DSP
     ================================================================ */
  const EqualizerManager = {
    audioCtx: null,
    sourceNode: null,
    filters: [],
    bassNode: null,
    widener: null,
    unavailable: false,
    modal: null,
    bands: [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000],
    presets: {
      flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      bassboost: [7, 6, 4, 2, 0, 0, 1, 2, 3, 4],
      vocal: [-2, -1, 1, 3, 5, 4, 3, 1, 0, -1],
      rock: [5, 3, 1, -1, -2, 1, 3, 4, 5, 5],
      pop: [-1, 2, 4, 5, 3, -1, -2, 1, 2, 3],
      edm: [8, 6, 3, 0, -2, 2, 4, 6, 7, 8],
      acoustic: [4, 3, 2, 1, 2, 3, 4, 4, 3, 2]
    },

    init() {
      this.modal = $('#eqModal');
      if (!this.modal) return;

      $('#eqBtn')?.addEventListener('click', () => this.openModal());
      $('#eqCloseBtn')?.addEventListener('click', () => this.closeModal());
      $('#eqDoneBtn')?.addEventListener('click', () => this.closeModal());
      this.modal.addEventListener('click', (e) => { if (e.target === this.modal) this.closeModal(); });

      $$('.eq-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          $$('.eq-preset-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          const presetKey = btn.dataset.preset;
          if (this.presets[presetKey]) {
            this.activePreset = presetKey;
            this.applyPreset(this.presets[presetKey]);
            this.saveState();
          }
        });
      });

      $$('.eq-slider').forEach(slider => {
        slider.addEventListener('input', (e) => {
          const idx = parseInt(e.target.dataset.band);
          const val = parseFloat(e.target.value);
          const valSpan = e.target.parentElement.querySelector('.eq-val');
          if (valSpan) valSpan.textContent = (val > 0 ? '+' : '') + val + 'dB';
          this.setFilterGain(idx, val);
          $$('.eq-preset-btn').forEach(b => b.classList.remove('active'));
          this.activePreset = null;
          this.saveState();
        });
      });

      $('#bassBoostRange')?.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        $('#bassBoostVal').textContent = val + ' dB';
        this.setBassBoost(val);
        this.saveState();
      });

      $('#spatialAudioToggle')?.addEventListener('change', (e) => {
        const applied = this.setSpatialAudio(e.target.checked);
        if (!applied) {
          // Don't leave the switch claiming a mode that never engaged.
          e.target.checked = false;
          return;
        }
        this.saveState();
        toast(e.target.checked ? '🎧 3D Spatial Audio Active' : '3D Spatial Audio Off');
      });

      $('#eqResetBtn')?.addEventListener('click', () => {
        this.applyPreset(this.presets.flat);
        $$('.eq-preset-btn').forEach(b => b.classList.remove('active'));
        $('.eq-preset-btn[data-preset="flat"]')?.classList.add('active');
        this.activePreset = 'flat';
        this.setBassBoostUI(0);
        this.setBassBoost(0);
        this.saveState();
      });

      // Every knob in here used to reset on reload — a 10-band curve is real
      // work to dial in and losing it each session made the EQ close to useless.
      this.restoreUI();
    },

    /* ---- persistence ---------------------------------------------------- */
    activePreset: null,

    readSliderGains() {
      return this.bands.map((_, i) => {
        const s = $(`.eq-slider[data-band="${i}"]`);
        const v = s ? parseFloat(s.value) : 0;
        return Number.isFinite(v) ? v : 0;
      });
    },

    saveState() {
      Storage.set('eqState', {
        gains: this.readSliderGains(),
        bass: parseFloat($('#bassBoostRange')?.value) || 0,
        spatial: !!$('#spatialAudioToggle')?.checked,
        preset: this.activePreset || null
      });
    },

    setBassBoostUI(val) {
      const r = $('#bassBoostRange');
      if (r) r.value = String(val);
      const label = $('#bassBoostVal');
      if (label) label.textContent = val + ' dB';
    },

    // UI only. The audio graph is deliberately NOT created here: an
    // AudioContext built outside a user gesture starts suspended, and
    // attaching one to a cross-origin stream silences playback for good. The
    // saved curve is pushed into the graph by ensureAudioContext() instead, the
    // moment a graph legitimately exists.
    restoreUI() {
      const st = Storage.get('eqState', null);
      if (!st || typeof st !== 'object') return;

      const gains = Array.isArray(st.gains) ? st.gains : null;
      if (gains) {
        this.bands.forEach((_, i) => {
          const g = Number(gains[i]);
          if (!Number.isFinite(g)) return;
          const clamped = Math.max(-12, Math.min(12, g));
          const slider = $(`.eq-slider[data-band="${i}"]`);
          if (!slider) return;
          slider.value = String(clamped);
          const valSpan = slider.parentElement?.querySelector('.eq-val');
          if (valSpan) valSpan.textContent = (clamped > 0 ? '+' : '') + clamped + 'dB';
        });
      }

      const bass = Number(st.bass);
      if (Number.isFinite(bass)) this.setBassBoostUI(Math.max(0, Math.min(15, bass)));

      if (st.spatial && $('#spatialAudioToggle')) $('#spatialAudioToggle').checked = true;

      if (st.preset && this.presets[st.preset]) {
        this.activePreset = st.preset;
        $$('.eq-preset-btn').forEach(b => b.classList.toggle('active', b.dataset.preset === st.preset));
      }
    },

    // Called once, right after the filter chain is built.
    applyStoredToGraph() {
      this.readSliderGains().forEach((g, i) => { if (this.filters[i]) this.filters[i].gain.value = g; });
      const bass = parseFloat($('#bassBoostRange')?.value);
      if (this.bassNode && Number.isFinite(bass)) this.bassNode.gain.value = bass;
      if ($('#spatialAudioToggle')?.checked && this.widener) {
        this.widener.widthPos.gain.value = 1.9;
        this.widener.widthNeg.gain.value = -1.9;
      }
    },

    ensureAudioContext() {
      if (this.audioCtx) return true;
      if (this.unavailable) return false;

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) { this.unavailable = true; return false; }

      // Refuse to attach while a cross-origin track is loaded — see canAttach().
      if (!this.canAttach()) return false;

      try {
        this.audioCtx = new AudioCtx();
        this.sourceNode = this.audioCtx.createMediaElementSource(audioPlayer);

        let lastNode = this.sourceNode;
        this.filters = this.bands.map((freq, i) => {
          const filter = this.audioCtx.createBiquadFilter();
          filter.type = i === 0 ? 'lowshelf' : i === this.bands.length - 1 ? 'highshelf' : 'peaking';
          filter.frequency.value = freq;
          filter.gain.value = 0;
          lastNode.connect(filter);
          lastNode = filter;
          return filter;
        });

        this.bassNode = this.audioCtx.createBiquadFilter();
        this.bassNode.type = 'lowshelf';
        this.bassNode.frequency.value = 80;
        this.bassNode.gain.value = 0;
        lastNode.connect(this.bassNode);
        lastNode = this.bassNode;

        // Real mid/side stereo widening. The old implementation just set a
        // StereoPanner to 0.35, which shoved the entire mix to the right ear
        // and called it "3D spatial audio".
        this.widener = this.buildWidener(lastNode);
        this.widener.output.connect(this.audioCtx.destination);
        // Push the saved curve/bass/spatial state into the fresh graph, or the
        // sliders would show a setting the audio isn't actually using.
        this.applyStoredToGraph();
        return true;
      } catch (e) {
        // createMediaElementSource() cannot be retried or undone, so give up
        // permanently rather than looping on a broken graph.
        this.unavailable = true;
        this.audioCtx = null;
        console.warn('Web Audio EQ unavailable:', e && e.message);
        return false;
      }
    },

    // Web Audio can only read an <audio> element whose media is same-origin
    // (or CORS-approved). Attaching a MediaElementSource to a cross-origin
    // stream silences it permanently and the connection can never be undone,
    // which is exactly how opening the equalizer used to kill playback.
    canAttach() {
      const src = audioPlayer.currentSrc || audioPlayer.src;
      if (!src) return true;
      if (src.startsWith('blob:') || src.startsWith('data:')) return true;
      try {
        return new URL(src, location.href).origin === location.origin;
      } catch (e) {
        return true;
      }
    },

    // An AudioContext created outside a user gesture starts suspended, and a
    // suspended context routes the element through a dead graph — silence.
    resumeContext() {
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }
    },

    buildWidener(input) {
      const ctx = this.audioCtx;
      const splitter = ctx.createChannelSplitter(2);
      const merger = ctx.createChannelMerger(2);

      // mid = (L + R) / 2,  side = (L - R) / 2
      const mid = ctx.createGain();
      const side = ctx.createGain();
      const midFromL = ctx.createGain(); midFromL.gain.value = 0.5;
      const midFromR = ctx.createGain(); midFromR.gain.value = 0.5;
      const sideFromL = ctx.createGain(); sideFromL.gain.value = 0.5;
      const sideFromR = ctx.createGain(); sideFromR.gain.value = -0.5;

      input.connect(splitter);
      splitter.connect(midFromL, 0);
      splitter.connect(midFromR, 1);
      splitter.connect(sideFromL, 0);
      splitter.connect(sideFromR, 1);
      midFromL.connect(mid);
      midFromR.connect(mid);
      sideFromL.connect(side);
      sideFromR.connect(side);

      // L' = mid + width * side,  R' = mid - width * side.
      // width === 1 reconstructs the original stereo image bit-for-bit, so 1 is
      // the neutral value and anything above it widens the image.
      const widthPos = ctx.createGain(); widthPos.gain.value = 1;
      const widthNeg = ctx.createGain(); widthNeg.gain.value = -1;
      side.connect(widthPos);
      side.connect(widthNeg);

      mid.connect(merger, 0, 0);
      mid.connect(merger, 0, 1);
      widthPos.connect(merger, 0, 0);
      widthNeg.connect(merger, 0, 1);

      return { output: merger, widthPos, widthNeg };
    },

    openModal() {
      if (this.modal) this.modal.style.display = 'flex';
      if (this.ensureAudioContext()) {
        this.resumeContext();
      } else if (!this.unavailable) {
        toast('Equalizer is unavailable for this track — it plays from an external source.');
      }
    },

    closeModal() {
      if (this.modal) this.modal.style.display = 'none';
    },

    setFilterGain(index, val) {
      if (!this.ensureAudioContext()) return false;
      this.resumeContext();
      if (this.filters[index]) this.filters[index].gain.value = val;
      return true;
    },

    setBassBoost(val) {
      if (!this.ensureAudioContext()) {
        toast('Bass boost is unavailable for this track.');
        return;
      }
      this.resumeContext();
      if (this.bassNode) this.bassNode.gain.value = val;
    },

    setSpatialAudio(enabled) {
      if (!this.ensureAudioContext()) {
        toast('Spatial audio is unavailable for this track.');
        return false;
      }
      this.resumeContext();
      if (!this.widener) return false;
      const width = enabled ? 1.9 : 1;
      const now = this.audioCtx.currentTime;
      // Ramp rather than jump, otherwise toggling clicks audibly.
      this.widener.widthPos.gain.setTargetAtTime(width, now, 0.05);
      this.widener.widthNeg.gain.setTargetAtTime(-width, now, 0.05);
      return true;
    },

    applyPreset(gains) {
      const ready = this.ensureAudioContext();
      if (ready) this.resumeContext();
      gains.forEach((g, i) => {
        if (ready && this.filters[i]) this.filters[i].gain.value = g;
        // Sliders are updated either way so the UI never lies about its state.
        const slider = $(`.eq-slider[data-band="${i}"]`);
        if (slider) {
          slider.value = g;
          const valSpan = slider.parentElement.querySelector('.eq-val');
          if (valSpan) valSpan.textContent = (g > 0 ? '+' : '') + g + 'dB';
        }
      });
      if (!ready) toast('Equalizer is unavailable for the current track.');
    }
  };

  /* ================================================================
     LOCAL MUSIC FILE PLAYER & DRAG & DROP MANAGER
     ================================================================ */

  // A blob: URL only stays valid for the lifetime of the document that created
  // it, so the object URLs older builds persisted into localStorage were dead
  // on every reload — imported tracks appeared in the library but refused to
  // play. The file bytes now live in IndexedDB and a fresh object URL is minted
  // on demand.
  const LocalAudioStore = {
    DB_NAME: 'musicflow_local_audio',
    STORE: 'files',
    dbPromise: null,

    open() {
      if (this.dbPromise) return this.dbPromise;
      const promise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined' || !indexedDB) {
          reject(new Error('IndexedDB unavailable'));
          return;
        }
        let req;
        try {
          req = indexedDB.open(this.DB_NAME, 1);
        } catch (e) {
          reject(e);
          return;
        }
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(this.STORE)) db.createObjectStore(this.STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
        req.onblocked = () => reject(new Error('IndexedDB blocked'));
      });
      // Don't cache a rejected promise — a later attempt may succeed.
      this.dbPromise = promise;
      promise.catch(() => { if (this.dbPromise === promise) this.dbPromise = null; });
      return promise;
    },

    async tx(mode, fn) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        let transaction;
        try {
          transaction = db.transaction(this.STORE, mode);
        } catch (e) {
          reject(e);
          return;
        }
        let request;
        try {
          request = fn(transaction.objectStore(this.STORE));
        } catch (e) {
          try { transaction.abort(); } catch (e2) {}
          reject(e);
          return;
        }
        // Resolve on complete rather than on request success, so a write is
        // only reported as done once it is actually durable.
        transaction.oncomplete = () => resolve(request ? request.result : undefined);
        transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
        transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
      });
    },

    put(id, blob) { return this.tx('readwrite', (s) => s.put(blob, id)); },
    get(id) { return this.tx('readonly', (s) => s.get(id)); },
    remove(id) { return this.tx('readwrite', (s) => s.delete(id)); },
    keys() { return this.tx('readonly', (s) => s.getAllKeys()); }
  };

  // Imports used to hardcode a 180s duration, which made the seek bar and the
  // queue lie about every local track.
  function readAudioDuration(url) {
    return new Promise((resolve) => {
      let settled = false;
      const probe = document.createElement('audio');
      const done = (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(bail);
        try { probe.removeAttribute('src'); probe.load(); } catch (e) {}
        resolve(val);
      };
      // Some containers never report metadata; don't hang the import on them.
      const bail = setTimeout(() => done(0), 5000);
      probe.preload = 'metadata';
      probe.addEventListener('loadedmetadata', () => {
        done(Number.isFinite(probe.duration) && probe.duration > 0 ? Math.round(probe.duration) : 0);
      });
      probe.addEventListener('error', () => done(0));
      probe.src = url;
    });
  }

  const LocalFileManager = {
    localSongs: [],
    liveUrls: new Map(),
    persistable: true,

    init() {
      this.loadPersisted();

      const dropzone = $('#localDropzone');
      const input = $('#localFileInput');
      const importBtn = $('#localImportBtn');

      if (importBtn && input) {
        importBtn.addEventListener('click', () => input.click());
      }
      if (dropzone && input) {
        dropzone.addEventListener('click', () => input.click());

        ['dragenter', 'dragover'].forEach(name => {
          document.addEventListener(name, (e) => {
            e.preventDefault();
            dropzone.classList.add('dragover');
          });
        });

        ['dragleave', 'drop'].forEach(name => {
          document.addEventListener(name, (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
          });
        });

        document.addEventListener('drop', (e) => {
          if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            this.handleFiles(e.dataTransfer.files);
          }
        });

        input.addEventListener('change', (e) => {
          if (e.target.files && e.target.files.length > 0) {
            this.handleFiles(e.target.files);
            // Let the same file be re-picked after a failed import.
            e.target.value = '';
          }
        });
      }
    },

    loadPersisted() {
      const saved = Storage.get('local_songs', []);
      this.localSongs = (Array.isArray(saved) ? saved : [])
        .filter(s => s && s.id)
        .map(s => Object.assign({}, s, { streamUrl: null, isLocal: true }));
      this.pruneOrphans();
    },

    // localStorage metadata and IndexedDB bytes can drift apart (site data
    // cleared for one but not the other), which would leave unplayable ghosts.
    async pruneOrphans() {
      try {
        const keys = await LocalAudioStore.keys();
        const stored = new Set(keys || []);
        const before = this.localSongs.length;
        this.localSongs = this.localSongs.filter(s => stored.has(s.id));
        if (this.localSongs.length !== before) this.persist();

        const listed = new Set(this.localSongs.map(s => s.id));
        stored.forEach(key => {
          if (!listed.has(key)) LocalAudioStore.remove(key).catch(() => {});
        });
      } catch (e) {
        // No usable IndexedDB (private mode, storage disabled). Local files
        // still work, but only for this session, so drop the stale list
        // instead of showing entries that can never play.
        this.persistable = false;
        this.localSongs = [];
        console.warn('[local] persistent storage unavailable:', e && e.message);
      }
      // pruneOrphans is async, so the list is only final here — render after it
      // or the Local Files section shows ghosts that were just pruned.
      renderLocalSongs();
    },

    persist() {
      if (!this.persistable) return;
      // streamUrl is deliberately dropped — it is only meaningful in this document.
      const meta = this.localSongs.slice(0, 100).map(s => {
        const copy = Object.assign({}, s);
        delete copy.streamUrl;
        return copy;
      });
      Storage.set('local_songs', meta);
    },

    async resolveStreamUrl(song) {
      if (!song || !song.id) return null;
      const cached = this.liveUrls.get(song.id);
      if (cached) { song.streamUrl = cached; return cached; }
      try {
        const blob = await LocalAudioStore.get(song.id);
        if (!blob) return null;
        const url = URL.createObjectURL(blob);
        this.liveUrls.set(song.id, url);
        song.streamUrl = url;
        return url;
      } catch (e) {
        console.warn('[local] could not restore file:', e && e.message);
        return null;
      }
    },

    forget(id) {
      const url = this.liveUrls.get(id);
      if (url) {
        try { URL.revokeObjectURL(url); } catch (e) {}
        this.liveUrls.delete(id);
      }
      LocalAudioStore.remove(id).catch(() => {});
    },

    async handleFiles(fileList) {
      const audioFiles = Array.from(fileList).filter(f =>
        (f.type && f.type.startsWith('audio/')) || /\.(mp3|flac|wav|m4a|aac|ogg|oga|opus|wma)$/i.test(f.name));
      if (!audioFiles.length) {
        toast('No audio files detected');
        return;
      }

      const added = [];
      let storageFailed = false;

      for (const file of audioFiles) {
        const cleanName = file.name.replace(/\.[^/.]+$/, '');
        const parts = cleanName.split('-');
        const title = parts.length > 1 ? parts.slice(1).join('-').trim() : cleanName.trim();
        const channel = parts.length > 1 ? parts[0].trim() : 'Local Audio File';

        const song = {
          id: 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
          title: title || file.name,
          channel: channel || 'Local File',
          duration: 0,
          thumbnail: '/icons/icon-192.png',
          streamUrl: null,
          // Kept so a re-download can restore the real extension; without it a
          // .flac import was saved back with no extension at all.
          fileName: file.name,
          isLocal: true
        };

        const url = URL.createObjectURL(file);
        this.liveUrls.set(song.id, url);
        song.streamUrl = url;
        song.duration = await readAudioDuration(url);

        if (this.persistable) {
          try {
            await LocalAudioStore.put(song.id, file);
          } catch (e) {
            // Usually a quota error on a large file. Keep the track playable
            // for this session rather than aborting the whole import.
            storageFailed = true;
            console.warn('[local] could not persist', file.name, e && e.message);
          }
        }

        this.localSongs.unshift(song);
        // Deliberately not addToQueue() — it toasts once per song.
        if (!queue.some(s => s.id === song.id)) queue.push(song);
        added.push(song);
      }

      if (this.localSongs.length > 100) {
        this.localSongs.slice(100).forEach(s => this.forget(s.id));
        this.localSongs = this.localSongs.slice(0, 100);
      }
      this.persist();

      updateQueueUI();
      renderLocalSongs();
      toast(`🎵 Added ${added.length} local track${added.length === 1 ? '' : 's'}`);
      if (storageFailed || !this.persistable) {
        toast('Some files could not be saved — they will only play this session.');
      }
      if (added.length && !isPlaying) playSong(added[0]);
    }
  };

  /* ================================================================
     SMART SLEEP TIMER MANAGER
     ================================================================ */
  const SleepTimerManager = {
    modal: null,
    timer: null,
    remainingSeconds: 0,
    isFadeStarted: false,
    fadeInterval: null,
    volumeBeforeFade: null,
    stopAfterTrack: false,

    init() {
      this.modal = $('#sleepModal');
      if (!this.modal) return;

      $('#sleepTimerBtn')?.addEventListener('click', () => this.openModal());
      $('#sleepCloseBtn')?.addEventListener('click', () => this.closeModal());
      $('#cancelSleepTimerBtn')?.addEventListener('click', () => this.cancelTimer());
      this.modal.addEventListener('click', (e) => { if (e.target === this.modal) this.closeModal(); });

      $$('.sleep-option-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const mins = btn.dataset.mins;
          if (mins === 'track') {
            this.setTimerTrackEnd();
          } else {
            this.startTimer(parseInt(mins));
          }
          // Marked *after* the call, not before: both startTimer and
          // setTimerTrackEnd begin with cancelTimer(), which clears every
          // .active — so highlighting first meant reopening the modal with a
          // timer running showed nothing selected.
          $$('.sleep-option-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.closeModal();
        });
      });
    },

    openModal() {
      if (this.modal) this.modal.style.display = 'flex';
    },

    closeModal() {
      if (this.modal) this.modal.style.display = 'none';
    },

    startTimer(minutes) {
      this.cancelTimer();
      this.remainingSeconds = minutes * 60;
      this.isFadeStarted = false;
      this.updateUI();

      this.timer = setInterval(() => {
        if (this.remainingSeconds > 0) {
          this.remainingSeconds--;
          this.updateUI();

          if (this.remainingSeconds <= 30 && !this.isFadeStarted) {
            this.isFadeStarted = true;
            this.fadeVolumeOut();
          }
        } else {
          this.cancelTimer();
          audioPlayer.pause();
          toast('🌙 Sleep Timer ended. Goodnight!');
        }
      }, 1000);

      toast(`🌙 Sleep timer set for ${minutes} minutes`);
    },

    setTimerTrackEnd() {
      this.cancelTimer();
      this.stopAfterTrack = true;
      const badge = $('#sleepBadge');
      if (badge) {
        badge.style.display = 'inline-block';
        badge.textContent = 'End';
      }
      toast('🌙 Music will stop after this track ends');
    },

    // Called from onEnd(). Returns true if playback should stop here instead of
    // advancing to the next track.
    consumeStopAfterTrack() {
      if (!this.stopAfterTrack) return false;
      this.stopAfterTrack = false;
      audioPlayer.pause();
      const badge = $('#sleepBadge');
      if (badge) badge.style.display = 'none';
      $$('.sleep-option-btn').forEach(b => b.classList.remove('active'));
      toast('🌙 Track ended. Sleep timer activated.');
      return true;
    },

    fadeVolumeOut() {
      this.stopFade();
      const initialVol = audioPlayer.volume;
      // Remember where the volume was so it can be put back. Without this the
      // fade left the player near-silent forever, while the volume slider still
      // showed 80% because the app's `volume` value was never touched.
      this.volumeBeforeFade = initialVol;
      let steps = 30;
      this.fadeInterval = setInterval(() => {
        if (steps > 0 && audioPlayer.volume > 0.02) {
          audioPlayer.volume = Math.max(0, audioPlayer.volume - (initialVol / 30));
          steps--;
        } else {
          this.stopFade();
        }
      }, 1000);
    },

    // Stops the fade without restoring volume (used when the fade completes
    // naturally and the player is about to be paused anyway).
    stopFade() {
      if (this.fadeInterval) {
        clearInterval(this.fadeInterval);
        this.fadeInterval = null;
      }
    },

    // Puts the volume back to whatever the user actually has configured.
    restoreVolume() {
      this.stopFade();
      const target = typeof this.volumeBeforeFade === 'number' && this.volumeBeforeFade > 0.02
        ? this.volumeBeforeFade
        : volume;
      audioPlayer.volume = Math.max(0, Math.min(1, target));
      this.volumeBeforeFade = null;
      this.isFadeStarted = false;
      updateVolumeUI();
    },

    cancelTimer() {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.remainingSeconds = 0;
      this.stopAfterTrack = false;
      // The fade ran on its own interval that cancelTimer() never knew about, so
      // cancelling a timer mid-fade left the volume ramping down to zero.
      this.restoreVolume();
      const badge = $('#sleepBadge');
      if (badge) badge.style.display = 'none';
      const statusBar = $('#sleepStatusBar');
      if (statusBar) statusBar.style.display = 'none';
      $$('.sleep-option-btn').forEach(b => b.classList.remove('active'));
    },

    updateUI() {
      const mins = Math.floor(this.remainingSeconds / 60);
      const secs = this.remainingSeconds % 60;
      const str = `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;

      const badge = $('#sleepBadge');
      if (badge) {
        badge.style.display = '';
        badge.textContent = `${mins}m`;
      }
      const display = $('#sleepTimerDisplay');
      if (display) display.textContent = str;
      const bar = $('#sleepStatusBar');
      if (bar) bar.style.display = 'flex';
    }
  };

  /* ================================================================
     ACCENT COLOR STUDIO & CUSTOM THEME ENGINE
     ================================================================ */
  const ThemeStudioManager = {
    colorMap: {
      indigo: { primary: '#6366f1', glow: 'rgba(99, 102, 241, 0.35)', hover: '#4f46e5' },
      cyan: { primary: '#06b6d4', glow: 'rgba(6, 182, 212, 0.35)', hover: '#0891b2' },
      emerald: { primary: '#10b981', glow: 'rgba(16, 185, 129, 0.35)', hover: '#059669' },
      orange: { primary: '#f97316', glow: 'rgba(249, 115, 22, 0.35)', hover: '#ea580c' },
      pink: { primary: '#ec4899', glow: 'rgba(236, 72, 153, 0.35)', hover: '#db2777' },
      purple: { primary: '#a855f7', glow: 'rgba(168, 85, 247, 0.35)', hover: '#9333ea' }
    },

    init() {
      const savedColor = Storage.get('accent_color', 'indigo');
      this.applyAccent(savedColor);

      $$('.accent-dot').forEach(dot => {
        dot.addEventListener('click', () => {
          $$('.accent-dot').forEach(d => d.classList.remove('active'));
          dot.classList.add('active');
          const colorKey = dot.dataset.color;
          this.applyAccent(colorKey);
          Storage.set('accent_color', colorKey);
          toast(`🎨 Accent color updated to ${colorKey.toUpperCase()}`);
        });
      });
    },

    applyAccent(key) {
      const c = this.colorMap[key] || this.colorMap.indigo;
      const root = document.documentElement;
      root.style.setProperty('--primary', c.primary);
      root.style.setProperty('--primary-glow', c.glow);
      root.style.setProperty('--primary-hover', c.hover);
      root.style.setProperty('--accent', c.primary);
      root.style.setProperty('--accent-light', c.primary);
      root.style.setProperty('--accent-glow', c.glow);
      root.style.setProperty('--accent-gradient', `linear-gradient(135deg, ${c.primary}, ${c.hover || '#ec4899'})`);

      const activeDot = $(`.accent-dot[data-color="${key}"]`);
      if (activeDot) {
        $$('.accent-dot').forEach(d => d.classList.remove('active'));
        activeDot.classList.add('active');
      }
    }
  };

  /* ================================================================
     APPLE DYNAMIC ISLAND HEADER CAPSULE MANAGER
     ================================================================ */
  const DynamicIslandHeaderManager = {
    pill: null,
    artThumb: null,
    titleEl: null,
    artistEl: null,
    playIcon: null,
    pauseIcon: null,
    soundwaves: null,

    init() {
      this.pill = $('#dynamicIslandHeader');
      if (!this.pill) return;

      this.artThumb = $('#diArtThumb');
      this.titleEl = $('#diTitle');
      this.artistEl = $('#diArtist');
      this.playIcon = $('.di-play-icon');
      this.pauseIcon = $('.di-pause-icon');
      this.soundwaves = $('#diSoundwaves');

      $('#diPlayPauseBtn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePlayPause();
      });

      $('#diNextBtn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        playNext();
      });

      $('#diEqBtn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        EqualizerManager.openModal();
      });
    },

    updateSong(song, playing) {
      if (!song) return;
      if (this.artThumb) this.artThumb.src = thumb(song);
      if (this.titleEl) this.titleEl.textContent = song.title || 'MusicFlow';
      if (this.artistEl) this.artistEl.textContent = song.channel || 'Now Playing';
      this.setPlaying(playing);
    },

    setPlaying(playing) {
      if (this.playIcon) this.playIcon.style.display = playing ? 'none' : '';
      if (this.pauseIcon) this.pauseIcon.style.display = playing ? '' : 'none';
      if (this.soundwaves) this.soundwaves.style.display = playing ? 'flex' : 'none';
    }
  };

  /* ================================================================
     AI MOOD & VIBE QUESTIONNAIRE ENGINE
     ================================================================ */
  const MoodFlowManager = {
    currentStep: 1,
    answers: { emotion: null, activity: null, style: null, energy: 2 },
    moodSongs: [],
    savedPresets: Storage.get('mood_presets', []),

    // Search query mapping for mood combinations
    moodQueries: {
      happy: ['happy upbeat songs', 'feel good music playlist', 'uplifting songs 2024'],
      sad: ['sad emotional songs', 'heartbreak songs playlist', 'emotional ballads'],
      chill: ['chill relaxing music', 'lofi chill beats', 'calm vibes playlist'],
      energetic: ['energetic workout music', 'high energy songs', 'pump up music'],
      focus: ['focus study music', 'deep concentration beats', 'alpha waves study'],
      romantic: ['romantic love songs', 'love songs playlist', 'romantic hindi songs'],
      party: ['party dance music', 'club bangers 2024', 'party anthems'],
      nostalgia: ['90s hits playlist', 'retro classic songs', 'old is gold songs'],
      sleep: ['sleep ambient music', 'calm sleep sounds', 'peaceful night music']
    },
    activityQueries: {
      coding: ['coding music beats', 'programming focus music'],
      driving: ['night driving songs', 'drive playlist songs'],
      workout: ['gym workout music', 'beast mode playlist'],
      morning: ['morning vibes music', 'good morning songs'],
      hangout: ['chill hangout songs', 'friends party playlist'],
      rainy: ['rainy day songs', 'monsoon songs playlist'],
      study: ['study music instrumental', 'exam study focus'],
      cooking: ['cooking vibes music', 'kitchen playlist happy']
    },
    styleQueries: {
      global_pop: ['top global pop hits 2024', 'billboard hot 100'],
      bollywood: ['latest bollywood songs 2024', 'hindi hit songs'],
      punjabi: ['punjabi songs latest hits', 'punjabi bhangra mix'],
      lofi: ['lofi hip hop beats study', 'lo-fi chill instrumental'],
      edm: ['edm festival music 2024', 'synthwave retro beats'],
      rock: ['rock music greatest hits', 'indie rock playlist'],
      rnb: ['r&b soul music playlist', 'smooth rnb vibes'],
      kpop: ['kpop hits 2024', 'best kpop songs playlist']
    },
    energyLabels: { 1: '\ud83c\udf19 Mellow', 2: '\u2600\ufe0f Balanced', 3: '\u26a1 Upbeat', 4: '\ud83d\udd25 Ultra Hype' },

    init() {
      // Quick mood cards on page
      $$('.mood-quick-card').forEach(card => {
        card.addEventListener('click', () => {
          const mood = card.dataset.mood;
          this.quickMoodPlay(mood);
        });
      });

      // Advanced questionnaire
      $('#openMoodQuestionnaireBtn')?.addEventListener('click', () => this.openModal());
      $('#moodModalCloseBtn')?.addEventListener('click', () => this.closeModal());
      $('#moodQuestionnaireModal')?.addEventListener('click', (e) => {
        if (e.target === $('#moodQuestionnaireModal')) this.closeModal();
      });
      $('#moodNextBtn')?.addEventListener('click', () => this.nextStep());
      $('#moodBackBtn')?.addEventListener('click', () => this.prevStep());
      $('#moodRandomBtn')?.addEventListener('click', () => this.randomize());

      // Energy slider
      $('#moodEnergySlider')?.addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        this.answers.energy = val;
        $('#moodEnergyValue').textContent = this.energyLabels[val] || '';
      });

      // Option chip selection
      document.addEventListener('click', (e) => {
        const chip = e.target.closest('.mood-option-chip');
        if (!chip) return;
        const panel = chip.closest('.mood-step-panel');
        if (!panel) return;
        panel.querySelectorAll('.mood-option-chip').forEach(c => c.classList.remove('selected'));
        chip.classList.add('selected');
      });

      // Result action buttons
      $('#playAllMoodBtn')?.addEventListener('click', () => this.playMoodMix());
      $('#saveMoodPlaylistBtn')?.addEventListener('click', () => this.saveAsPlaylist());
    },

    renderPage() {
      // Render saved presets
      const sec = $('#savedMoodPresetsSection');
      const list = $('#savedMoodPresetsList');
      if (sec && list && this.savedPresets.length > 0) {
        sec.style.display = '';
        list.innerHTML = this.savedPresets.map((p, i) => `
          <button class="mood-preset-pill" data-idx="${i}">
            <span>${p.emoji || '\ud83c\udfad'}</span>
            <span>${esc(p.label)}</span>
          </button>
        `).join('');
        list.querySelectorAll('.mood-preset-pill').forEach(pill => {
          pill.addEventListener('click', () => {
            const idx = parseInt(pill.dataset.idx);
            const preset = this.savedPresets[idx];
            if (preset) this.executePreset(preset);
          });
        });
      } else if (sec) {
        sec.style.display = 'none';
      }

      // Show last mood results if any
      if (this.moodSongs.length > 0) {
        const resSec = $('#moodResultsSection');
        if (resSec) resSec.style.display = '';
        renderRecommendationCards($('#moodResultsGrid'), this.moodSongs);
      }
    },

    openModal() {
      this.currentStep = 1;
      this.answers = { emotion: null, activity: null, style: null, energy: 2 };
      this.updateStepUI();
      $('#moodQuestionnaireModal').style.display = 'flex';
      $('#moodGenerating').style.display = 'none';
      $('#moodNavActions').style.display = '';
      // Reset selections
      $$('.mood-option-chip').forEach(c => c.classList.remove('selected'));
      $('#moodEnergySlider').value = 2;
      $('#moodEnergyValue').textContent = this.energyLabels[2];
    },

    closeModal() {
      $('#moodQuestionnaireModal').style.display = 'none';
    },

    updateStepUI() {
      for (let i = 1; i <= 4; i++) {
        const panel = $(`#moodStep${i}`);
        if (panel) panel.style.display = i === this.currentStep ? '' : 'none';
      }
      // Update step dots
      $$('.mood-step-dot').forEach(dot => {
        const s = parseInt(dot.dataset.step);
        dot.classList.toggle('active', s === this.currentStep);
        dot.classList.toggle('completed', s < this.currentStep);
      });
      // Back button
      const backBtn = $('#moodBackBtn');
      if (backBtn) backBtn.style.display = this.currentStep > 1 ? '' : 'none';
      // Next button text
      const nextBtn = $('#moodNextBtn');
      if (nextBtn) nextBtn.textContent = this.currentStep === 4 ? '\u26a1 Generate Mood Mix' : 'Next \u2192';
    },

    getSelectedValue(stepNum) {
      const panel = $(`#moodStep${stepNum}`);
      if (!panel) return null;
      const sel = panel.querySelector('.mood-option-chip.selected');
      return sel ? sel.dataset.value : null;
    },

    nextStep() {
      // Collect answer from current step
      if (this.currentStep === 1) {
        this.answers.emotion = this.getSelectedValue(1);
        if (!this.answers.emotion) { toast('Please select your mood'); return; }
      } else if (this.currentStep === 2) {
        this.answers.activity = this.getSelectedValue(2);
        if (!this.answers.activity) { toast('Please select your activity'); return; }
      } else if (this.currentStep === 3) {
        this.answers.style = this.getSelectedValue(3);
        if (!this.answers.style) { toast('Please select a music style'); return; }
      }

      if (this.currentStep < 4) {
        this.currentStep++;
        this.updateStepUI();
      } else {
        // Step 4 done — generate!
        this.answers.energy = parseInt($('#moodEnergySlider')?.value || 2);
        this.generateMoodMix();
      }
    },

    prevStep() {
      if (this.currentStep > 1) {
        this.currentStep--;
        this.updateStepUI();
      }
    },

    randomize() {
      // Randomly select options for all steps
      const steps = [1, 2, 3];
      steps.forEach(s => {
        const panel = $(`#moodStep${s}`);
        if (!panel) return;
        const chips = panel.querySelectorAll('.mood-option-chip');
        if (!chips.length) return;
        chips.forEach(c => c.classList.remove('selected'));
        const rand = chips[Math.floor(Math.random() * chips.length)];
        rand.classList.add('selected');
      });
      // Random energy
      const randEnergy = Math.floor(Math.random() * 4) + 1;
      $('#moodEnergySlider').value = randEnergy;
      $('#moodEnergyValue').textContent = this.energyLabels[randEnergy];
      this.answers.energy = randEnergy;
      toast('\ud83c\udfb2 Randomized! Click Generate when ready.');

      // Collect all answers
      this.answers.emotion = this.getSelectedValue(1);
      this.answers.activity = this.getSelectedValue(2);
      this.answers.style = this.getSelectedValue(3);

      // Jump to last step
      this.currentStep = 4;
      this.updateStepUI();
    },

    buildSearchQueries() {
      const queries = [];
      const e = this.answers.emotion;
      const a = this.answers.activity;
      const s = this.answers.style;
      const nrg = this.answers.energy;

      // Primary mood queries
      if (e && this.moodQueries[e]) {
        queries.push(...this.moodQueries[e]);
      }
      // Activity blend
      if (a && this.activityQueries[a]) {
        queries.push(this.activityQueries[a][0]);
      }
      // Style blend
      if (s && this.styleQueries[s]) {
        queries.push(this.styleQueries[s][0]);
      }
      // Energy modifier
      const energySuffix = nrg <= 1 ? 'slow calm' : nrg === 2 ? '' : nrg === 3 ? 'upbeat' : 'high energy bass';
      if (energySuffix && queries.length > 0) {
        queries.push(`${queries[0]} ${energySuffix}`);
      }
      return queries.slice(0, 5);
    },

    async generateMoodMix() {
      // Show loading
      $('#moodNavActions').style.display = 'none';
      for (let i = 1; i <= 4; i++) {
        $(`#moodStep${i}`).style.display = 'none';
      }
      $('#moodGenerating').style.display = 'flex';

      const queries = this.buildSearchQueries();

      try {
        // Try server-side mood endpoint first
        let songs = [];
        try {
          const res = await fetch('/api/mood-mix', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ queries, energy: this.answers.energy })
          });
          if (res.ok) {
            const data = await res.json();
            if (data.results && data.results.length > 0) {
              songs = data.results;
            }
          }
        } catch (e) {}

        // Fallback: client-side search
        if (songs.length === 0) {
          for (const q of queries.slice(0, 3)) {
            try {
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 12000);
              const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
              clearTimeout(timeoutId);
              if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) songs.push(...data);
              }
            } catch {}
          }
        }

        // Deduplicate
        const seen = new Set();
        const unique = [];
        songs.forEach(s => {
          if (s && s.id && !seen.has(s.id)) {
            seen.add(s.id);
            const dur = Number(s.duration) || 0;
            if (dur >= 60 && dur <= 600) unique.push(s);
          }
        });

        // Shuffle
        for (let i = unique.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [unique[i], unique[j]] = [unique[j], unique[i]];
        }

        this.moodSongs = unique.slice(0, 20);
        this.closeModal();

        if (this.moodSongs.length > 0) {
          // Navigate to mood page and show results
          navigateTo('mood');
          const resSec = $('#moodResultsSection');
          if (resSec) resSec.style.display = '';
          const emojiMap = { happy:'\ud83d\ude0a', sad:'\ud83d\ude22', chill:'\ud83d\ude0c', energetic:'\u26a1', focus:'\ud83e\udde0', romantic:'\u2764\ufe0f', party:'\ud83c\udf89', nostalgia:'\ud83d\udd70\ufe0f', sleep:'\ud83c\udf19' };
          const emoji = emojiMap[this.answers.emotion] || '\ud83c\udfad';
          $('#moodResultsTitle').textContent = `${emoji} Your ${(this.answers.emotion || 'Mood').charAt(0).toUpperCase() + (this.answers.emotion || 'Mood').slice(1)} Mix`;
          renderRecommendationCards($('#moodResultsGrid'), this.moodSongs);

          // Auto play
          this.playMoodMix();
          toast(`${emoji} Playing your mood mix (${this.moodSongs.length} tracks)`);
        } else {
          toast('Could not find songs for your mood. Try different options.');
        }
      } catch (err) {
        console.error('[MoodFlow Error]', err);
        this.closeModal();
        toast('\u26a0\ufe0f Error generating mood mix. Please try again.');
      }
    },

    async quickMoodPlay(mood) {
      const queries = this.moodQueries[mood] || [`${mood} music playlist`];
      toast(`\ud83c\udfad Generating ${mood} mix...`);

      try {
        let songs = [];
        for (const q of queries.slice(0, 2)) {
          try {
            const controller = new AbortController();
            const tid = setTimeout(() => controller.abort(), 12000);
            const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
            clearTimeout(tid);
            if (res.ok) {
              const data = await res.json();
              if (Array.isArray(data)) songs.push(...data);
            }
          } catch {}
        }

        const seen = new Set();
        const unique = [];
        songs.forEach(s => {
          if (s && s.id && !seen.has(s.id)) {
            seen.add(s.id);
            const dur = Number(s.duration) || 0;
            if (dur >= 60 && dur <= 600) unique.push(s);
          }
        });

        for (let i = unique.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [unique[i], unique[j]] = [unique[j], unique[i]];
        }

        this.moodSongs = unique.slice(0, 15);

        if (this.moodSongs.length > 0) {
          const resSec = $('#moodResultsSection');
          if (resSec) resSec.style.display = '';
          const emojiMap = { happy:'\ud83d\ude0a', sad:'\ud83d\ude22', chill:'\ud83d\ude0c', energetic:'\u26a1', focus:'\ud83e\udde0', romantic:'\u2764\ufe0f', party:'\ud83c\udf89', nostalgia:'\ud83d\udd70\ufe0f', sleep:'\ud83c\udf19' };
          const emoji = emojiMap[mood] || '\ud83c\udfad';
          $('#moodResultsTitle').textContent = `${emoji} ${mood.charAt(0).toUpperCase() + mood.slice(1)} Mix`;
          renderRecommendationCards($('#moodResultsGrid'), this.moodSongs);
          this.playMoodMix();
          toast(`${emoji} Playing ${mood} mix (${this.moodSongs.length} tracks)`);
        } else {
          toast('No songs found. Try again.');
        }
      } catch {
        toast('\u26a0\ufe0f Error loading mood mix');
      }
    },

    playMoodMix() {
      if (!this.moodSongs.length) { toast('No mood songs to play'); return; }
      queue = [...this.moodSongs];
      currentIndex = -1;
      updateQueueUI();
      playSong(queue[0]);
    },

    saveAsPlaylist() {
      if (!this.moodSongs.length) { toast('No songs to save'); return; }
      const name = `Mood: ${(this.answers.emotion || 'Mix').charAt(0).toUpperCase() + (this.answers.emotion || 'Mix').slice(1)} ${new Date().toLocaleDateString()}`;
      const pl = { id: 'pl_' + Date.now(), name, songs: [...this.moodSongs] };
      playlists.push(pl);
      Storage.set('playlists', playlists);

      // Save as preset
      const emojiMap = { happy:'\ud83d\ude0a', sad:'\ud83d\ude22', chill:'\ud83d\ude0c', energetic:'\u26a1', focus:'\ud83e\udde0', romantic:'\u2764\ufe0f', party:'\ud83c\udf89', nostalgia:'\ud83d\udd70\ufe0f', sleep:'\ud83c\udf19' };
      this.savedPresets.unshift({
        label: name,
        emoji: emojiMap[this.answers.emotion] || '\ud83c\udfad',
        answers: { ...this.answers },
        timestamp: Date.now()
      });
      if (this.savedPresets.length > 10) this.savedPresets = this.savedPresets.slice(0, 10);
      Storage.set('mood_presets', this.savedPresets);

      toast(`\ud83d\udcbe Saved "${name}" to playlists!`);
    },

    async executePreset(preset) {
      if (preset.answers) {
        this.answers = { ...preset.answers };
        toast(`\u26a1 Replaying ${preset.label}...`);
        const queries = this.buildSearchQueries();
        // Quick search
        let songs = [];
        for (const q of queries.slice(0, 3)) {
          try {
            const controller = new AbortController();
            const tid = setTimeout(() => controller.abort(), 12000);
            const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
            clearTimeout(tid);
            if (res.ok) {
              const data = await res.json();
              if (Array.isArray(data)) songs.push(...data);
            }
          } catch {}
        }
        const seen = new Set();
        this.moodSongs = songs.filter(s => {
          if (!s || !s.id || seen.has(s.id)) return false;
          seen.add(s.id);
          const dur = Number(s.duration) || 0;
          return dur >= 60 && dur <= 600;
        }).slice(0, 15);

        if (this.moodSongs.length > 0) {
          const resSec = $('#moodResultsSection');
          if (resSec) resSec.style.display = '';
          $('#moodResultsTitle').textContent = `${preset.emoji} ${preset.label}`;
          renderRecommendationCards($('#moodResultsGrid'), this.moodSongs);
          this.playMoodMix();
        } else {
          toast('No songs found for this preset');
        }
      }
    }
  };

  /* ================================================================
     VOICE ASSISTANT ("Hey My Ruby")
     ================================================================ */
  // Split in two on purpose: VoiceCommands is a pure transcript -> intent parser
  // that touches no browser API, so every phrasing in the spec is testable
  // without a microphone; VoiceAssistant owns the SpeechRecognition lifecycle
  // and does nothing clever with text.

  // Two wake lists, and the difference matters.
  //
  // STRICT is what always-on listening wakes on: a lead word ("hey", "ok", …)
  // followed by the name. The mic is open all day in that mode, so the bare name
  // is not enough — "ruby" turns up in lyrics, in the middle of sentences and in
  // whatever the recognizer makes of background noise, and a false wake while
  // music is playing is the worst thing this feature can do.
  //
  // The loose list adds the bare name and is only used once the phrase has been
  // stripped for parsing, where the tap on the mic (or an already-granted wake)
  // has said "I am talking to you". The name variants are the ways recognizers
  // actually mishear "Ruby"; keeping them costs one string compare each.
  const VOICE_WAKE_NAMES = ['ruby', 'rubi', 'rubby', 'ruuby', 'rubys', 'rube', 'rugby', 'robbie', 'rudy'];
  const VOICE_WAKE_LEADS = ['hey', 'hey my', 'hi', 'hello', 'ok', 'okay', 'yo'];
  const VOICE_WAKE_STRICT = [];
  for (let li = 0; li < VOICE_WAKE_LEADS.length; li++) {
    for (let ni = 0; ni < VOICE_WAKE_NAMES.length; ni++) {
      VOICE_WAKE_STRICT.push(VOICE_WAKE_LEADS[li] + ' ' + VOICE_WAKE_NAMES[ni]);
    }
  }
  const VOICE_WAKE = VOICE_WAKE_STRICT.concat(VOICE_WAKE_NAMES, ['my ruby']);

  // A mood word only counts as a mood when the whole request is about a vibe
  // ("play something relaxing", "play workout music"). "play Workout by Kanye"
  // names a track, so it has to stay a plain search — see moodOf().
  const VOICE_MOODS = [
    { re: /^(?:relax|relaxing|relaxed|chill|chilled|calm|calming|soothing|peaceful|lofi|lo fi|mellow)$/, q: 'relaxing chill lofi music', label: 'something relaxing' },
    { re: /^(?:workout|work out|gym|exercise|running|energetic|energy|pump up|hype)$/, q: 'gym workout motivation songs', label: 'workout music' },
    { re: /^(?:study|studying|focus|focused|concentration|coding|reading)$/, q: 'study music no lyrics deep focus', label: 'focus music' },
    { re: /^(?:party|dance|dancing|club)$/, q: 'party dance hits', label: 'party music' },
    { re: /^(?:sleep|sleepy|bedtime|ambient)$/, q: 'sleep calm ambient music', label: 'sleep music' },
    { re: /^(?:sad|emotional|heartbreak|melancholy)$/, q: 'sad emotional songs', label: 'sad songs' },
    { re: /^(?:happy|upbeat|cheerful|feel good|good mood)$/, q: 'happy upbeat feel good songs', label: 'happy songs' },
    { re: /^(?:romantic|romance|love)$/, q: 'romantic love songs', label: 'romantic songs' },
  ];

  const VoiceCommands = {
    clean(raw) {
      return String(raw == null ? '' : raw)
        .toLowerCase()
        // Apostrophes vanish ("what's" -> "whats"); other punctuation becomes a
        // space so "play Syaara." and "hey, my ruby" normalise the same way.
        .replace(/['‘’`]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/ (?:please|thanks|thank you|for me)$/, '')
        .trim();
    },

    // Longest match wins, so "hey my ruby" is never read as the bare "ruby"
    // prefix with "my ruby ..." left over.
    stripWake(text) {
      let best = '';
      for (let i = 0; i < VOICE_WAKE.length; i++) {
        const w = VOICE_WAKE[i];
        if ((text === w || text.indexOf(w + ' ') === 0) && w.length > best.length) best = w;
      }
      if (!best) return { text: text, woke: false };
      return { text: text.slice(best.length).trim(), woke: true };
    },

    // The gate for always-on listening: does this utterance *start* with a led
    // wake phrase? Takes a raw transcript because it runs on interim results,
    // before anything else has touched the text.
    wakeStrict(raw) {
      const t = this.clean(raw);
      if (!t) return false;
      for (let i = 0; i < VOICE_WAKE_STRICT.length; i++) {
        const w = VOICE_WAKE_STRICT[i];
        if (t === w || t.indexOf(w + ' ') === 0) return true;
      }
      return false;
    },

    moodOf(rest) {
      const m = /^(?:me )?(?:some |something |somethin |a bit of |a little )?(.+?)(?: (?:music|song|songs|tunes|tracks|beats|vibes|mix|playlist|stuff))?$/.exec(rest);
      if (!m) return null;
      const word = m[1].trim();
      for (let i = 0; i < VOICE_MOODS.length; i++) {
        if (VOICE_MOODS[i].re.test(word)) return VOICE_MOODS[i];
      }
      return null;
    },

    parse(raw) {
      const cleaned = this.clean(raw);
      if (!cleaned) return { intent: 'empty', text: '', woke: false };
      const woken = this.stripWake(cleaned);
      const t = woken.text;
      if (!t) return { intent: 'wake', text: '', woke: true };
      const R = (intent, extra) => {
        const out = { intent: intent, text: t, woke: woken.woke };
        if (extra) for (const k in extra) out[k] = extra[k];
        return out;
      };

      // ORDER MATTERS. Every specific intent is matched before the generic
      // "play <anything>" catch-all at the bottom; otherwise "play my liked
      // songs" would run a search for the words "my liked songs".

      // Transport, matched as whole utterances so a song called "Skipping
      // Stones" is never mistaken for a skip command.
      if (/^(?:play |go |skip )?(?:to )?next(?: song| track| one)?$/.test(t)
        || /^skip(?: this| it| ahead| forward| song| track| this song| this one)?$/.test(t)) return R('next');

      if (/^(?:play |go )?(?:to )?(?:previous|prev|last)(?: song| track| one)?$/.test(t)
        || /^(?:go )?back(?: a song| one song| a track| one)?$/.test(t)) return R('previous');

      if (/^(?:pause|stop)(?: it| this| music| the music| playback| playing| the song| the track)?$/.test(t)) return R('pause');

      if (/^(?:resume|continue|unpause|un pause|keep playing|carry on|play)(?: it| this| music| the music| playing| the song| again)?$/.test(t)) return R('resume');

      // "add this to my playlist" — broad on purpose: it must start with
      // add/save and end in "playlist", which no play/search phrasing does.
      if (/^(?:add|save)\b.*\bto\b.*\bplaylists?$/.test(t)) return R('addToPlaylist');

      // "play something like this". The discovery word is required: without it
      // "play feels like this" (a real song) would be hijacked.
      if (/\b(?:like|similar to) (?:this|it|that|this song|this one|this track|the current song)$/.test(t)
        && /\b(?:something|some|more|anything|songs?|music|stuff|tracks)\b/.test(t)) return R('similar');

      if (/\b(?:liked|favou?rites?)\b/.test(t) && /\b(?:play|start|queue|shuffle|put on|listen to)\b/.test(t)) {
        return R('liked', { shuffle: /\bshuffle\b/.test(t) });
      }

      if (/\bshuffle\b/.test(t)) return R(/\b(?:off|stop|no)\b/.test(t) ? 'shuffleOff' : 'shuffle');

      if (/^(?:whats (?:this|playing|the song|this song)|what song is (?:this|playing)|what is (?:this|this song|playing)|who sings this|name this song|current song)$/.test(t)) return R('nowPlaying');

      const m = /^(play|put on|start|queue up|queue|search for|search|find|look for|listen to|i want to hear|i wanna hear) (.+)$/.exec(t);
      if (m) {
        const rest = m[2].replace(/^(?:me )?(?:the )?(?:song|track|album) (?:called |named )?/, '').trim();
        const mood = this.moodOf(rest);
        if (mood) return R('mood', { arg: mood.q, label: mood.label });
        if (!rest) return R('unknown');
        // "search for X" wants results on screen; "play X" wants audio.
        const lookOnly = /^(?:search for|search|find|look for)$/.test(m[1]);
        return R(lookOnly ? 'lookup' : 'search', { arg: rest.slice(0, 120) });
      }

      return R('unknown');
    },
  };

  /* ----- Picking the official version -----------------------------------
     /api/search returns YouTube's own ordering, which happily puts a "slowed +
     reverb" edit, a cover or a 1-hour loop above the real release. When a
     command is spoken there is no list to look at and no second chance, so the
     result has to be the right one first time.

     This is a client-side twin of scoreSong() in server.js, run over the
     results already in hand. Asking /api/smart-search for the same answer would
     be a second yt-dlp round trip for data we are holding. */
  const VOICE_BAD_RE = /karaoke|instrumental|ringtone|\bcovers?\b|reaction|slowed|reverb|8d audio|nightcore|sped up|mashup|tutorial|lesson|\d+\s*hours?\b|full album|jukebox|non ?stop|whatsapp status/i;
  const VOICE_OFFICIAL_RE = /official\s*(?:video|audio|music|lyric|lyrical|song)|full\s*(?:video|song)|original\s*soundtrack/i;
  const VOICE_LABEL_RE = /t-?series|sony music|zee music|\byrf\b|tips (?:official|music)|saregama|speed records|eros now|desi music factory|times music|white hill|vevo|warner (?:records|music)|universal music|columbia records|atlantic records|republic records|def jam|interscope|rca records/i;

  const VoicePick = {
    // i is the result's position in YouTube's order, used only to break ties.
    score(item, query, i) {
      if (!item || !item.id) return -Infinity;
      const title = String(item.title || '');
      const channel = String(item.channel || '');
      const hay = (title + ' ' + channel).toLowerCase();
      const words = String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1);
      let s = 0;

      if (words.length) {
        let hit = 0;
        for (let w = 0; w < words.length; w++) if (hay.indexOf(words[w]) >= 0) hit++;
        s += (hit / words.length) * 400;
        // Missing words are penalised on top of the ratio, or a wildly popular
        // track that happens to share half the title can out-score the song
        // that was actually asked for.
        if (hit < words.length) s -= (words.length - hit) * 120;
      }

      if (VOICE_LABEL_RE.test(channel)) s += 700;
      if (/-\s*topic$/i.test(channel.trim())) s += 550;   // YouTube's official-audio channels
      if (VOICE_OFFICIAL_RE.test(title)) s += 300;

      const views = Number(item.views) || 0;
      if (views > 0) s += Math.min(450, Math.log10(views + 1) * 50);

      // Duration is the cheapest way to spot a clip, a mix or an album rip.
      const dur = Number(item.duration) || 0;
      if (dur >= 80 && dur <= 450) s += 150;
      else if (dur > 600) s -= 350;
      else if (dur > 0 && dur < 50) s -= 250;

      if (VOICE_BAD_RE.test(title)) s -= 500;

      return s - (Number(i) || 0) * 4;
    },

    best(results, query) {
      if (!Array.isArray(results) || !results.length) return null;
      let bestItem = null, bestScore = -Infinity;
      for (let i = 0; i < results.length; i++) {
        const s = this.score(results[i], query, i);
        if (s > bestScore) { bestScore = s; bestItem = results[i]; }
      }
      // Every candidate can be -Infinity (all malformed), so fall back rather
      // than hand back null to a caller that already knows the list is non-empty.
      return bestItem || results[0];
    },
  };

  /* ----- Wake chime -----------------------------------------------------
     Two rising blips, so waking up is audible without looking at the screen.
     Its own AudioContext on purpose: EqualizerManager's is wired to the <audio>
     element and gives up permanently the moment a cross-origin track loads. */
  const VoiceChime = {
    ctx: null, unavailable: false,

    // Called from the click that switches voice on: an AudioContext built
    // outside a user gesture is born suspended, and a suspended context plays
    // silence with no error.
    prime() {
      if (this.unavailable) return;
      if (!this.ctx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) { this.unavailable = true; return; }
        try { this.ctx = new Ctx(); } catch (e) { this.unavailable = true; return; }
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    },

    play(freqs, vol) {
      this.prime();
      const ctx = this.ctx;
      if (!ctx) return;
      try {
        let t = ctx.currentTime + 0.01;
        for (let i = 0; i < freqs.length; i++) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freqs[i], t);
          // Ramped rather than switched: a square edge on a sine is a click.
          gain.gain.setValueAtTime(0.0001, t);
          gain.gain.exponentialRampToValueAtTime(vol, t + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
          osc.connect(gain); gain.connect(ctx.destination);
          osc.start(t); osc.stop(t + 0.13);
          // stop() frees the node but not the edges. Without this a day of
          // waking up leaves a graph full of dead oscillators.
          osc.onended = () => { try { osc.disconnect(); gain.disconnect(); } catch (e) { /* already gone */ } };
          t += 0.12;
        }
      } catch (e) {
        // A chime is never worth failing a command over.
      }
    },

    wake() { this.play([784, 1175], 0.16); },   // tu-dú, rising
    off() { this.play([1175, 784], 0.10); },    // dú-tu, falling
  };

  const VOICE_IDLE_MS = 12000;      // command window: give up waiting after this much silence
  const VOICE_RESTART_MS = 250;
  const VOICE_MAX_RESTARTS = 8;     // budget, so a session that ends instantly can't spin
  const VOICE_BACKOFF_MS = 30000;   // ...and always-on then retries slowly instead of dying
  const VOICE_WATCHDOG_MS = 20000;  // background tabs throttle timers; this is the safety net
  const VOICE_HUD_MS = 2800;

  const VoiceAssistant = {
    inited: false, supported: false, disabled: false,
    // 'off'      nothing is listening, and nothing will restart it
    // 'wake'     armed: mic open, everything ignored except the wake phrase
    // 'command'  woken: the next sentence is treated as a command
    mode: 'off',
    always: false,          // persisted, so the mic re-arms itself after a reload
    sessionOpen: false,
    turn: 0,
    rec: null, restarts: 0,
    idleTimer: null, restartTimer: null, hudTimer: null, watchdog: null,
    btn: null, hud: null, stateEl: null, heardEl: null,

    // Derived, never stored. Two flags for one truth is how a button ends up
    // pulsing "listening" over a mic that closed ten minutes ago.
    get active() { return this.mode !== 'off'; },

    init() {
      if (this.inited) return;          // a second init() would double every listener
      this.inited = true;
      this.btn = $('#voiceBtn');
      this.hud = $('#voiceHud');
      this.stateEl = $('#voiceHudState');
      this.heardEl = $('#voiceHudHeard');
      const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
      this.supported = !!Rec;
      if (!this.supported) {
        // Graceful fallback: remove the control entirely rather than leave a
        // button that looks live and does nothing when tapped.
        if (this.btn) this.btn.style.display = 'none';
        return;
      }
      this.always = Storage.get('voiceAlwaysOn', false) === true;
      if (this.btn) this.btn.addEventListener('click', () => this.toggle());
      $('#voiceHudClose')?.addEventListener('click', () => this.standDown());
      // One recognizer for the life of the page: a fresh one per session leaves
      // the old object and its handlers behind on every start.
      let rec;
      try { rec = new Rec(); } catch (err) { this.supported = false; if (this.btn) this.btn.style.display = 'none'; return; }
      rec.lang = 'en-US';
      // One long session instead of one per sentence. With always-on listening
      // that is the difference between a mic that goes deaf for 250ms after
      // every phrase and one that doesn't — and the wake word landing inside
      // that gap is the failure nobody forgives.
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.onresult = (e) => this.onResult(e);
      rec.onerror = (e) => this.onError(e);
      rec.onend = () => this.onEnd();
      this.rec = rec;
      // One interval and one listener for the life of the page. Hidden tabs
      // throttle timers to roughly once a minute — which is exactly when a
      // session that died in the background needs picking back up.
      this.watchdog = setInterval(() => this.check(), VOICE_WATCHDOG_MS);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) this.check(); });
      this.autoStart();
    },

    toggle() { if (this.mode === 'off') this.enable(); else this.disable(); },

    // The mic button is the always-on switch. It also opens a command window
    // straight away, so the tap that grants microphone permission is useful
    // immediately instead of being a step on the way to being useful.
    enable() {
      if (!this.supported || this.disabled) return;
      this.setAlways(true);
      VoiceChime.prime();               // inside the click, while a gesture is live
      this.start();
      if (this.mode !== 'off') toast('🎙 Always listening — say “Hey My Ruby”');
    },

    disable() {
      this.setAlways(false);
      this.stop();
      VoiceChime.off();
      toast('🎙 Voice off');
    },

    setAlways(on) {
      this.always = !!on;
      // setLocal, not set: microphone permission is per browser, so this is a
      // device setting with no business syncing to the user's other devices.
      Storage.setLocal('voiceAlwaysOn', this.always);
    },

    // Arm without a tap. Permission has to be granted *already*: calling start()
    // to find out would pop a prompt on every page load, and a refusal arrives
    // as not-allowed, which disables voice for the whole page. Where the
    // Permissions API is missing (Safari) we wait for the tap instead.
    autoStart() {
      if (!this.always || !this.supported || this.disabled) return;
      const perms = navigator.permissions;
      if (!perms || typeof perms.query !== 'function') return;
      let query;
      try { query = perms.query({ name: 'microphone' }); } catch (err) { return; }
      if (!query || typeof query.then !== 'function') return;   // Firefox rejects the name outright
      query.then((status) => {
        if (!status || status.state !== 'granted') return;
        if (this.mode !== 'off' || this.disabled) return;
        this.arm();
        // This context was built outside a gesture, so it is suspended and the
        // chime would be silent. The first tap or keypress anywhere unsticks it.
        this.primeOnGesture();
      }).catch(() => { /* a permission lookup is allowed to fail */ });
    },

    primeOnGesture() {
      const once = { once: true, passive: true };
      document.addEventListener('pointerdown', () => VoiceChime.prime(), once);
      document.addEventListener('keydown', () => VoiceChime.prime(), once);
    },

    // Listen for the wake phrase and nothing else. No HUD: this state lasts all
    // day, and a card that is on screen all day is not status, it is litter.
    arm() {
      if (!this.supported || this.disabled) return;
      this.mode = 'wake';
      this.paintButton();
      this.openMic();
    },

    // Open a command window right now: what tapping the mic has always done.
    start() {
      if (!this.supported || this.disabled || this.mode === 'command') return;
      this.restarts = 0;
      this.mode = 'command';
      this.paintButton();
      this.paint('listening', 'Listening…', 'Say “Hey My Ruby, play Syaara”');
      // openMic() is a no-op when a session is already running (armed), so this
      // cannot restart the recognizer and trip InvalidStateError at the exact
      // moment everything is working.
      if (!this.openMic()) {
        // The other way start() throws: the previous session hasn't ended yet.
        // Nothing to recover from and nothing the user did wrong.
        this.mode = this.always ? 'wake' : 'off';
        this.paintButton();
        this.paint('error', 'Mic is busy', 'Trying again in a moment');
        this.autoHide();
        if (this.always) this.scheduleRestart(VOICE_BACKOFF_MS);
        return;
      }
      this.armIdle();
    },

    // The single owner of "is a recognition session running". Every path that
    // wants the mic open goes through here, so nothing else needs to know that
    // starting an already-started recognizer throws.
    openMic() {
      if (!this.rec || this.disabled) return false;
      if (this.sessionOpen) return true;          // already listening: nothing to do
      try {
        this.rec.start();
        this.sessionOpen = true;
        return true;
      } catch (err) {
        return false;
      }
    },

    // Reconcile "should be listening" with "is listening". The watchdog, the tab
    // coming back into view and a restart that failed all land here.
    check() {
      if (this.mode === 'off' || this.disabled) return;
      // A queued restart owns the reopening. Jumping in ahead of it would turn
      // the slow backoff retry into a fast one and defeat the point of it.
      if (this.restartTimer) return;
      this.openMic();
    },

    // Tear down the recognition session without touching the HUD, so a command
    // can keep its "working" state on screen while it runs.
    closeMic() {
      this.mode = 'off';
      this.sessionOpen = false;
      this.clearTimer('idleTimer');
      this.clearTimer('restartTimer');   // or a queued restart would reopen the mic
      this.paintButton();
      if (this.rec) { try { this.rec.stop(); } catch (err) { /* already stopped */ } }
    },

    // Full stop: nothing is listening afterwards and nothing restarts it.
    stop(msg) {
      this.closeMic();
      if (msg) { this.paint('done', msg, ''); this.autoHide(); }
      else this.hide();
    },

    // Leave the command window. Under always-on that means dropping back to
    // waiting for the wake phrase, not closing the mic — otherwise the ✕ and the
    // idle timeout would quietly switch off the feature they belong to.
    standDown(msg) {
      if (this.always && !this.disabled && this.mode !== 'off') {
        this.mode = 'wake';
        this.clearTimer('idleTimer');
        this.paintButton();
        if (msg) { this.paint('done', msg, ''); this.autoHide(); }
        else this.hide();
        return;
      }
      this.stop(msg);
    },

    onResult(e) {
      const res = e && e.results;
      if (!res || !res.length) return;
      let text = '', isFinal = false;
      for (let i = e.resultIndex || 0; i < res.length; i++) {
        const alt = res[i] && res[i][0];
        if (!alt) continue;                       // malformed event: ignore, don't throw
        text += (text ? ' ' : '') + (alt.transcript || '');
        if (res[i].isFinal) isFinal = true;
      }
      text = text.trim();
      if (!text) return;
      // Real speech means the mic is working, so the restart budget resets: it
      // only exists to catch sessions that end without ever hearing anything.
      this.restarts = 0;
      if (this.mode === 'wake') {
        // Armed but not woken. Anything that isn't the phrase is dropped in
        // silence: no HUD, no toast, no state change. The mic is open all day,
        // and an assistant that reacts to ordinary conversation is unbearable.
        if (!VoiceCommands.wakeStrict(text)) return;
        this.wakeUp();
        // Interim: the phrase has landed but the command may still be on its
        // way. The final transcript carries the whole sentence, and handle()
        // strips the phrase off the front of it.
        if (!isFinal) return;
      }
      if (!isFinal) { this.armIdle(); this.paint('listening', 'Listening…', '“' + text + '”'); return; }
      this.handle(text);
    },

    // Chime first — the entire point of a wake word is not having to look.
    wakeUp() {
      this.mode = 'command';
      this.restarts = 0;
      this.turn++;                     // claims the HUD from any command still finishing
      this.paintButton();
      VoiceChime.wake();
      this.paint('listening', 'Listening…', 'Go ahead');
      this.armIdle();
    },

    async handle(text) {
      const cmd = VoiceCommands.parse(text);
      if (cmd.intent === 'empty') return;
      // Bare wake phrase: stay open and wait for the actual command.
      if (cmd.intent === 'wake') { this.armIdle(); this.paint('listening', 'Listening…', 'Go ahead'); return; }
      const turn = ++this.turn;
      this.paint('working', 'Working…', '“' + text + '”');
      // A final transcript is a complete request, so the command window closes
      // here. Under always-on the *session* stays open and falls back to waiting
      // for the phrase: closing it would go deaf for the second or two the
      // command takes, which is precisely when people say "hey ruby" again.
      if (this.always && this.mode !== 'off') {
        this.mode = 'wake';
        this.clearTimer('idleTimer');
        this.paintButton();
      } else {
        this.closeMic();
      }
      let msg;
      try { msg = await this.execute(cmd); }
      catch (err) { msg = 'That did not work'; }
      if (!msg) { if (turn === this.turn) this.hide(); return; }
      // Two commands can be in flight at once now that the mic never closes.
      // The toast still fires — it is the durable record of what happened — but
      // the card belongs to whoever spoke last.
      if (turn === this.turn) {
        this.paint(cmd.intent === 'unknown' ? 'error' : 'done', msg, '“' + text + '”');
        this.autoHide();
      }
      toast('🎙 ' + msg);
    },

    async execute(cmd) {
      switch (cmd.intent) {
        case 'next': playNext(); return 'Next song';
        case 'previous': playPrev(); return 'Previous song';

        case 'pause':
          // togglePlayPause() would *resume* when already paused, the opposite of
          // what was asked. Read the element and act in one direction only.
          if (audioPlayer && audioPlayer.src && !audioPlayer.paused) { audioPlayer.pause(); return 'Paused'; }
          return 'Already paused';

        case 'resume':
          if (audioPlayer && audioPlayer.src && currentIndex >= 0) {
            if (audioPlayer.paused) togglePlayPause();
            return 'Playing';
          }
          startPersonalizedRadio();       // nothing loaded: "play music" still means play music
          return 'Starting your radio';

        // toggleShuffle() flips, so asking for shuffle twice must not turn it off.
        case 'shuffle': if (!isShuffle) toggleShuffle(); return 'Shuffle on';
        case 'shuffleOff': if (isShuffle) toggleShuffle(); return 'Shuffle off';

        case 'liked':
          // Empty check first: "shuffle my liked songs" with nothing liked must
          // not leave shuffle flipped on as its only visible effect. No toast
          // here — handle() already toasts whatever we return, and playLikedSongs
          // is never reached, so its own empty-toast can't fire either.
          if (!likedSongs.length) { return 'No liked songs yet'; }
          if (cmd.shuffle && !isShuffle) toggleShuffle();
          playLikedSongs();
          return 'Playing your liked songs';

        case 'similar': {
          if (!currentSong) return 'Nothing is playing';
          const artist = SuggestionEngine.cleanArtist(currentSong.channel || '');
          const seed = artist || String(currentSong.title || '').slice(0, 60);
          if (!seed) return 'Nothing is playing';
          return await this.searchAndPlay(seed + ' similar songs mix', 'Songs like this one');
        }

        case 'addToPlaylist':
          if (!currentSong) return 'Nothing is playing';
          openAddToPlaylist(currentSong);
          return 'Pick a playlist';

        case 'nowPlaying':
          return currentSong ? 'Now playing: ' + currentSong.title : 'Nothing is playing';

        case 'mood': return await this.searchAndPlay(cmd.arg, 'Playing ' + cmd.label);
        case 'search': return await this.searchAndPlay(cmd.arg, 'Playing “' + cmd.arg + '”');

        case 'lookup':
          this.runSearchUI(cmd.arg);
          await doSearch(cmd.arg);
          return 'Results for “' + cmd.arg + '”';

        default:
          return cmd.text ? 'Sorry, I cannot do “' + cmd.text + '”' : 'Did not catch that';
      }
    },

    // Drives the search box exactly the way a click on a genre tile does, so
    // voice and touch leave the UI in the same state.
    runSearchUI(query) {
      if (searchInput) searchInput.value = query;
      if (searchClear) searchClear.classList.add('visible');
      SuggestionEngine.close();     // the dropdown has no business covering results
      navigateTo('search');
    },

    async searchAndPlay(query, label) {
      this.runSearchUI(query);
      await doSearch(query);
      // doSearch assigns searchResults before it renders, so this reads the list
      // the user is now looking at rather than firing a second request.
      if (searchResults && searchResults.length) {
        // A spoken request gets the official release, not whatever YouTube
        // ranked first. The queue keeps the whole list in its original order, so
        // the grid on screen and the queue still line up.
        playAllResults(VoicePick.best(searchResults, query));
        return label;
      }
      return 'No results for that';
    },

    onError(e) {
      const code = (e && e.error) || 'unknown';
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        // A denied permission never recovers on its own, and onEnd would restart
        // us straight back into the same refusal. Disable for the page, say why.
        this.disabled = true;
        this.closeMic();
        this.paint('error', 'Microphone blocked', 'Allow mic access in your browser settings');
        this.autoHide();
        toast('🎙 Microphone blocked — allow access to use voice');
        return;
      }
      if (code === 'no-speech' || code === 'aborted') return;   // onEnd decides whether to retry
      // Armed and silent: a transient recognizer error is not news. Popping a
      // card on screen while nobody is even talking to us is worse than useless.
      if (this.mode === 'wake') return;
      this.paint('error', code === 'network' ? 'Voice needs a connection' : 'Did not catch that', '');
    },

    onEnd() {
      this.sessionOpen = false;
      if (this.mode === 'off' || this.disabled) { this.paintButton(); return; }
      // Even a continuous session ends — on long silence, on a network blip, on
      // the browser deciding it has had enough — so staying open means
      // restarting. The budget is what stops a recognizer that dies instantly
      // from restarting forever and pinning the CPU.
      if (this.restarts >= VOICE_MAX_RESTARTS) {
        // Always-on then retries slowly instead of giving up: one bad minute
        // must not quietly end "always listening" for the rest of the day.
        if (this.always) {
          this.restarts = 0;
          this.mode = 'wake';
          this.paintButton();
          this.scheduleRestart(VOICE_BACKOFF_MS);
          return;
        }
        this.stop('Voice paused — tap the mic to resume');
        return;
      }
      this.restarts++;
      this.scheduleRestart(VOICE_RESTART_MS);
    },

    scheduleRestart(ms) {
      this.clearTimer('restartTimer');
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        // Re-checked inside the callback: a stop between arming this timer and
        // it firing must not reopen the mic. openMic() itself is a no-op if a
        // session somehow got opened in the meantime.
        if (this.mode === 'off' || this.disabled) return;
        if (!this.openMic() && !this.always) this.stop('Mic unavailable');
      }, ms);
    },

    armIdle() {
      this.clearTimer('idleTimer');
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        // Always-on: the command window closes, the wake phrase still works, and
        // there is nothing worth saying about it.
        this.standDown(this.always ? '' : 'Stopped listening');
      }, VOICE_IDLE_MS);
    },

    clearTimer(name) { if (this[name]) { clearTimeout(this[name]); this[name] = null; } },

    // Two visibly different states. Armed has to be quieter than awake: it is on
    // all day, and it also has to be louder than nothing, or "always listening"
    // and "off" look identical and nobody can tell whether it works.
    paintButton() {
      if (!this.btn) return;
      this.btn.classList.toggle('armed', this.mode === 'wake');
      this.btn.classList.toggle('active', this.mode === 'command');
    },

    paint(state, stateText, heard) {
      if (!this.hud) return;
      this.clearTimer('hudTimer');
      this.hud.style.display = '';
      this.hud.dataset.state = state;
      // textContent, never innerHTML: this string is whatever the mic heard.
      if (this.stateEl) this.stateEl.textContent = stateText;
      if (this.heardEl && heard !== undefined) this.heardEl.textContent = heard;
    },

    autoHide() {
      // No clearTimer here: every caller paints first, and paint() cancels the
      // pending hide. One owner, so a stale timer can't outlive the HUD it was
      // scheduled for.
      this.hudTimer = setTimeout(() => { this.hudTimer = null; this.hide(); }, VOICE_HUD_MS);
    },

    hide() {
      // No clearTimer: paint() is the only thing that cancels a pending hide, and
      // a timer that fires against an already-hidden HUD is a no-op.
      if (this.hud) this.hud.style.display = 'none';
    },
  };

  /* ----- Start ----- */
  init();
})();
