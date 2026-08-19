/* ================================================================
   MusicFlow v2.0 — Complete App Logic
   ================================================================ */

(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  /* ================================================================
     STORAGE MANAGER WITH DISK & LOCAL DUAL PERSISTENCE
     ================================================================ */
  let syncTimeout = null;
  const pendingSync = {};

  const Storage = {
    get(key, fallback) {
      try { const v = localStorage.getItem('mf_' + key); return v !== null ? JSON.parse(v) : fallback; }
      catch { return fallback; }
    },
    set(key, val) {
      try { localStorage.setItem('mf_' + key, JSON.stringify(val)); } catch {}
      
      // Auto sync to server disk database
      pendingSync[key] = val;
      clearTimeout(syncTimeout);
      syncTimeout = setTimeout(() => {
        try {
          fetch('/api/user-data', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pendingSync)
          }).catch(() => {});
        } catch {}
      }, 500);
    },
    remove(key) {
      localStorage.removeItem('mf_' + key);
      try {
        fetch('/api/user-data', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [key]: null })
        }).catch(() => {});
      } catch {}
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
  let playlists = Storage.get('playlists', []); // [{id, name, songs:[]}]
  let history = Storage.get('history', []); // [{song, playedAt, listenedSec}]
  let searchHistory = Storage.get('searchHistory', []);
  let playStartTime = null;
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

    // Instant cache hydration: render home from localStorage before network
    const cachedRecs = Storage.get('cached_recommendations', null);
    if (cachedRecs && Array.isArray(cachedRecs) && cachedRecs.length > 0) {
      recommendedSongs = cachedRecs;
      const grid = $('#recommendedGrid');
      if (grid) renderRecommendationCards(grid, recommendedSongs);
    }

    // Auto-restore saved likes and playlists from disk database
    Storage.syncFromServer();
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
    searchInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(searchTimeout); doSearch(searchInput.value.trim()); searchSuggestions?.classList.remove('active'); } });
    searchInput?.addEventListener('focus', () => { if (searchInput.value.trim().length >= 2) fetchSuggestions(searchInput.value.trim()); });
    document.addEventListener('click', (e) => { if ($('#searchBarWrap') && !$('#searchBarWrap').contains(e.target)) searchSuggestions?.classList.remove('active'); });
    searchClear?.addEventListener('click', clearSearch);

    // Quick tags & genre cards
    $$('.tag').forEach(t => t.addEventListener('click', () => { if (searchInput) searchInput.value = t.dataset.query; navigateTo('search'); doSearch(t.dataset.query); }));
    $$('.genre-card').forEach(c => c.addEventListener('click', () => { if (searchInput) searchInput.value = c.dataset.query; navigateTo('search'); doSearch(c.dataset.query); }));

    // Nav
    navLinks.forEach(l => l.addEventListener('click', (e) => { e.preventDefault(); navigateTo(l.dataset.page); }));

    // Sidebar mobile
    $('#mobileMenuBtn')?.addEventListener('click', toggleMobileSidebar);

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
    playAllBtn?.addEventListener('click', playAllResults);

    // Progress
    npProgressBar?.addEventListener('mousedown', startSeek);
    npProgressBar?.addEventListener('touchstart', startSeek, { passive: true });
    npVolumeBar?.addEventListener('mousedown', startVolChange);
    npVolumeBar?.addEventListener('touchstart', startVolChange, { passive: true });

    // Audio events
    audioPlayer?.addEventListener('timeupdate', onTimeUpdate);
    audioPlayer?.addEventListener('loadedmetadata', onMeta);
    audioPlayer?.addEventListener('ended', onEnd);
    audioPlayer?.addEventListener('play', () => { setPlayState(true); playStartTime = Date.now(); });
    audioPlayer?.addEventListener('pause', () => { setPlayState(false); recordListenTime(); });
    audioPlayer?.addEventListener('error', onAudioError);

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
    $('#playlistBackBtn')?.addEventListener('click', () => { if ($('#playlistDetail')) $('#playlistDetail').style.display = 'none'; renderLibrary(); });
    $('#playPlaylistBtn')?.addEventListener('click', playCurrentPlaylist);
    $('#deletePlaylistBtn')?.addEventListener('click', deleteCurrentPlaylist);
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

    // Search history
    $('#clearSearchHistory')?.addEventListener('click', () => { searchHistory = []; Storage.set('searchHistory', []); renderSearchHistory(); });

    // Retry
    document.getElementById('retryBtn')?.addEventListener('click', () => doSearch(lastQuery));

    // Keyboard
    document.addEventListener('keydown', onKeyboard);
  }

  /* ================================================================
     ROUTING
     ================================================================ */
  function navigateTo(page) {
    Object.values(pages).forEach(p => p.style.display = 'none');
    if (pages[page]) pages[page].style.display = '';

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
  function onSearchInput() {
    const q = searchInput.value.trim();
    searchClear.classList.toggle('visible', q.length > 0);
    clearTimeout(searchTimeout);
    if (q.length >= 2) {
      fetchSuggestions(q);
      searchTimeout = setTimeout(() => doSearch(q), 700);
    } else {
      searchSuggestions.classList.remove('active');
    }
  }

  async function fetchSuggestions(q) {
    try {
      // Show local search history matches first
      const local = searchHistory.filter(h => h.toLowerCase().includes(q.toLowerCase())).slice(0, 3);
      let html = local.map(h => `<div class="suggestion-item" data-type="history" data-query="${esc(h)}"><svg class="sug-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><span class="sug-text">${esc(h)}</span></div>`).join('');

      if (html) { searchSuggestions.innerHTML = html; searchSuggestions.classList.add('active'); bindSuggestionClicks(); }
    } catch {}
  }

  function bindSuggestionClicks() {
    searchSuggestions.querySelectorAll('.suggestion-item').forEach(item => {
      item.addEventListener('click', () => {
        const q = item.dataset.query;
        searchInput.value = q;
        searchSuggestions.classList.remove('active');
        navigateTo('search');
        doSearch(q);
      });
    });
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
    searchSuggestions.classList.remove('active');

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
      resultsGrid.innerHTML = `<p class="empty-msg" style="grid-column:1/-1;text-align:center;">Search failed. Please check connection.</p>`;
    } finally {
      if (requestId === searchRequestId) searchLoading.classList.remove('active');
    }
  }

  function clearSearch() {
    if (activeSearchController) activeSearchController.abort();
    searchRequestId++;
    searchInput.value = '';
    searchClear.classList.remove('visible');
    resultsGrid.innerHTML = '';
    resultsHeader.style.display = 'none';
    searchResults = [];
    renderSearchHistory();
  }

  function renderSearchHistory() {
    const section = $('#searchHistorySection');
    const tags = $('#searchHistoryTags');
    if (searchHistory.length === 0) { section.style.display = 'none'; return; }
    section.style.display = '';
    tags.innerHTML = searchHistory.slice(0, 12).map(h => `<button class="history-tag" data-query="${esc(h)}">${esc(h)}</button>`).join('');
    tags.querySelectorAll('.history-tag').forEach(t => t.addEventListener('click', () => { searchInput.value = t.dataset.query; doSearch(t.dataset.query); }));
  }

  function showSkeletons() {
    let h = '';
    for (let i = 0; i < 6; i++) h += `<div class="skeleton-card"><div class="skeleton-thumb"></div><div class="skeleton-info"><div class="skeleton-line"></div><div class="skeleton-line"></div></div></div>`;
    resultsGrid.innerHTML = h;
  }

  function renderResults(results) {
    resultsGrid.innerHTML = results.map((item, i) => `
      <div class="result-card ${isCurrent(item.id) ? 'playing' : ''}" data-id="${item.id}" data-idx="${i}">
        <div class="card-thumbnail">
          <img src="${thumb(item)}" alt="" loading="lazy" />
          <span class="card-duration">${fmtDur(item.duration)}</span>
          <div class="card-play-overlay" data-action="play"><div class="overlay-play-btn"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></div></div>
        </div>
        <div class="card-info">
          <div class="card-title" title="${esc(item.title)}">${esc(item.title)}</div>
          <div class="card-meta">
            <span class="card-channel">${esc(item.channel)}</span>
            <div class="card-actions">
              <button class="card-action-btn ${isLiked(item.id) ? 'liked' : ''}" data-action="like" title="Like">
                <svg viewBox="0 0 24 24" fill="${isLiked(item.id) ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
              </button>
              <button class="card-action-btn" data-action="download" title="Download MP3">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </button>
              <button class="card-action-btn" data-action="addpl" title="Add to playlist">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </button>
              <button class="card-action-btn" data-action="queue" title="Add to queue">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    `).join('');

    resultsGrid.querySelectorAll('.result-card').forEach(card => {
      card.addEventListener('click', (e) => {
        const i = parseInt(card.dataset.idx);
        const item = searchResults[i];
        const action = e.target.closest('[data-action]');
        if (action) {
          e.stopPropagation();
          if (action.dataset.action === 'like') toggleLike(item);
          else if (action.dataset.action === 'queue') addToQueue(item);
          else if (action.dataset.action === 'addpl') openAddToPlaylist(item);
          else if (action.dataset.action === 'download') downloadSong(item);
          else playSong(item);
        } else {
          playSong(item);
        }
      });
    });
  }

  /* ================================================================
     PLAYER
     ================================================================ */
  let audioRetryCount = 0;

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

    npThumbnail.src = thumb(song);
    npTitle.textContent = song.title;
    npChannel.textContent = song.channel;
    updateLikeBtn();

    if (song.isLocal) {
      // The object URL has to be re-created from IndexedDB after a reload, so
      // this is asynchronous. Guard against the user skipping on in the meantime.
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
      if (song.streamUrl) {
        audioPlayer.src = song.streamUrl;
        audioPlayer.play().catch(async () => {
          const freshUrl = await CloudMusicEngine.getStreamUrl(song.id);
          if (currentSong !== song) return;
          if (freshUrl) {
            song.streamUrl = freshUrl;
            audioPlayer.src = freshUrl;
            startPlayback(song);
          } else {
            toast(`Could not start "${String(song.title || 'track').slice(0, 24)}".`);
          }
        });
      } else {
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
    audioPlayer.paused ? audioPlayer.play() : audioPlayer.pause();
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

  function playNext() {
    if (!queue.length) return;
    if (isShuffle) {
      let n; do { n = Math.floor(Math.random() * queue.length); } while (n === currentIndex && queue.length > 1);
      playSong(queue[n]);
    } else {
      const n = currentIndex + 1;
      if (n < queue.length) {
        playSong(queue[n]);
      } else {
        const autoQueueCheck = $('#settingAutoQueue')?.checked !== false;
        if (autoQueueCheck && currentSong) {
          toast('♾️ Endless Auto-Queue: Loading next tracks...');
          loadRecommendations(true).then(() => {
            if (recommendedSongs.length > 0) {
              const freshSongs = recommendedSongs.filter(s => !queue.some(q => q.id === s.id));
              if (freshSongs.length > 0) {
                queue.push(...freshSongs);
                updateQueueUI();
                playSong(queue[n]);
                return;
              }
            }
            if (repeatMode === 'all') playSong(queue[0]);
          });
          return;
        }
        if (repeatMode === 'all') playSong(queue[0]);
      }
    }
  }

  function playPrev() {
    if (!queue.length) return;
    if (audioPlayer.currentTime > 3) { audioPlayer.currentTime = 0; return; }
    const p = currentIndex - 1;
    if (p >= 0) playSong(queue[p]);
    else if (repeatMode === 'all') playSong(queue[queue.length - 1]);
  }

  function onEnd() {
    recordListenTime();
    // The sleep timer's "stop after this track" mode has to be checked here.
    // Its own 'ended' listener runs *after* this one, so playNext() had already
    // started the following track before the timer paused it.
    if (SleepTimerManager.consumeStopAfterTrack()) return;
    if (repeatMode === 'one') { audioPlayer.currentTime = 0; audioPlayer.play().catch(() => {}); }
    else playNext();
  }

  async function onAudioError() {
    if (currentSong && currentSong.isCloud) {
      const freshUrl = await CloudMusicEngine.getStreamUrl(currentSong.id);
      if (freshUrl && freshUrl !== audioPlayer.src) {
        currentSong.streamUrl = freshUrl;
        audioPlayer.src = freshUrl;
        audioPlayer.play().catch(() => {});
        return;
      }
      audioRetryCount = 0;
      toast(`Playback is unavailable for "${(currentSong.title || 'track').slice(0, 20)}". Trying the next track...`);
      setTimeout(playNext, 1000);
      return;
    }
    if (currentSong && currentSong.isLocal) {
      toast(`Your browser could not play "${(currentSong.title || 'local track').slice(0, 20)}".`);
      return;
    }
    if (currentSong && audioRetryCount < 3) {
      audioRetryCount++;
      const fallbackQuality = audioRetryCount === 1 ? 'low' : 'high';
      audioPlayer.src = `/api/stream/${currentSong.id}?quality=${fallbackQuality}&retry=${audioRetryCount}&t=${Date.now()}`;
      audioPlayer.play().catch(() => {});
      return;
    }
    audioRetryCount = 0;
    toast(`⚠️ Playback issue on "${(currentSong?.title || 'track').slice(0, 20)}", skipping to next...`);
    setTimeout(playNext, 1000);
  }

  function onTimeUpdate() {
    if (isSeeking) return;
    const c = audioPlayer.currentTime, d = audioPlayer.duration || 0;
    npCurrentTime.textContent = fmtTime(c);
    if (d > 0) { const p = (c / d) * 100; npProgressFill.style.width = p + '%'; npProgressThumb.style.left = p + '%'; }
    
    // Sync with Apple Orb & Lyrics
    AppleOrbController.updateProgress(c, d);
    syncLyrics(c);
  }

  function onMeta() { npDuration.textContent = fmtTime(audioPlayer.duration); }

  // Shuffle & Repeat
  function toggleShuffle() { isShuffle = !isShuffle; $('#shuffleBtn').classList.toggle('active', isShuffle); Storage.set('shuffle', isShuffle); toast(isShuffle ? 'Shuffle ON' : 'Shuffle OFF'); }

  function toggleRepeat() {
    const modes = ['off', 'all', 'one'];
    repeatMode = modes[(modes.indexOf(repeatMode) + 1) % 3];
    $('#repeatBtn').classList.toggle('active', repeatMode !== 'off');
    Storage.set('repeat', repeatMode);
    updateRepeatIcon();
    toast('Repeat: ' + repeatMode.toUpperCase());
  }

  function updateRepeatIcon() {
    const btn = $('#repeatBtn');
    if (repeatMode === 'one') btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><text x="12" y="16" text-anchor="middle" fill="currentColor" stroke="none" font-size="9" font-weight="bold">1</text></svg>`;
    else btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`;
  }

  // Volume
  function toggleMute() {
    audioPlayer.muted = !audioPlayer.muted;
    $('.vol-on-icon').style.display = audioPlayer.muted ? 'none' : '';
    $('.vol-off-icon').style.display = audioPlayer.muted ? '' : 'none';
    updateVolumeUI();
  }

  function updateVolumeUI() {
    const v = audioPlayer.muted ? 0 : volume;
    npVolumeFill.style.width = (v * 100) + '%';
    npVolumeThumb.style.left = (v * 100) + '%';
  }

  function startVolChange(e) {
    e.preventDefault(); updateVolEvt(e);
    const mv = (ev) => updateVolEvt(ev);
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); document.removeEventListener('touchmove', mv); document.removeEventListener('touchend', up); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    document.addEventListener('touchmove', mv, { passive: true }); document.addEventListener('touchend', up);
  }

  function updateVolEvt(e) {
    const r = npVolumeBar.getBoundingClientRect();
    const x = e.touches ? e.touches[0].clientX : e.clientX;
    volume = Math.max(0, Math.min(1, (x - r.left) / r.width));
    audioPlayer.volume = volume; audioPlayer.muted = false;
    $('.vol-on-icon').style.display = ''; $('.vol-off-icon').style.display = 'none';
    updateVolumeUI(); Storage.set('volume', volume);
  }

  // Seeking
  function startSeek(e) {
    e.preventDefault(); isSeeking = true; seekEvt(e);
    const mv = (ev) => seekEvt(ev);
    const up = () => { isSeeking = false; document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); document.removeEventListener('touchmove', mv); document.removeEventListener('touchend', up); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    document.addEventListener('touchmove', mv, { passive: true }); document.addEventListener('touchend', up);
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
     LIKES
     ================================================================ */
  function isLiked(id) { return likedSongs.some(s => s.id === id); }

  function toggleLike(song) {
    if (isLiked(song.id)) {
      likedSongs = likedSongs.filter(s => s.id !== song.id);
      toast('Removed from Likes');
    } else {
      likedSongs.unshift(song);
      toast('❤️ Added to Likes');
    }
    Storage.set('likes', likedSongs);
    updateLikeBtn();
    // Re-render results if visible
    if (searchResults.length) renderResults(searchResults);
  }

  function updateLikeBtn() {
    const btn = $('#npLikeBtn');
    if (!currentSong) return;
    const liked = isLiked(currentSong.id);
    btn.classList.toggle('liked', liked);
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
      list.innerHTML = playlists.map(pl => `<div class="playlist-select-item" data-plid="${pl.id}"><span class="psi-icon">📂</span><span class="psi-name">${esc(pl.name)} (${pl.songs.length})</span></div>`).join('');
      list.querySelectorAll('.playlist-select-item').forEach(item => {
        item.addEventListener('click', () => {
          const pl = playlists.find(p => p.id === item.dataset.plid);
          if (pl) {
            if (pl.songs.some(s => s.id === addToPlaylistSong.id)) { toast('Already in playlist'); }
            else { pl.songs.push(addToPlaylistSong); Storage.set('playlists', playlists); toast('Added to ' + pl.name); }
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

    const sec = $('#activePlaylistSection');
    const title = $('#activePlaylistTitle');
    const grid = $('#activePlaylistGrid');
    if (sec && title && grid) {
      sec.style.display = '';
      title.textContent = '📂 ' + pl.name;
      renderRecommendationCards(grid, pl.songs);
    }
  }

  function playCurrentPlaylist() {
    const pl = playlists.find(p => p.id === currentPlaylistId);
    if (!pl || !pl.songs.length) { toast('Playlist is empty'); return; }
    queue = [...pl.songs]; currentIndex = -1;
    updateQueueUI(); playSong(queue[0]);
  }

  function deleteCurrentPlaylist() {
    playlists = playlists.filter(p => p.id !== currentPlaylistId);
    Storage.set('playlists', playlists);
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
      targetPl = { id: 'pl_' + Date.now(), name: plName, songs: [] };
      playlists.push(targetPl);
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

      if (!res.ok) throw new Error('Batch search failed');
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

      Storage.set('playlists', playlists);
      progFill.style.width = '100%';
      progPercent.textContent = '100%';
      progStatus.textContent = `Done! Added ${addedCount} songs to "${targetPl.name}".`;
      previewBox.innerHTML = htmlResults || '<p class="empty-msg">No matching songs could be found.</p>';

      toast(`✨ Added ${addedCount} songs to "${targetPl.name}"`);

      // If viewing library or the updated playlist detail, refresh
      if (pages.library.style.display !== 'none') {
        if (currentPlaylistId === targetPl.id) showPlaylistDetail(targetPl.id);
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

      recommendedSongs = data;
      Storage.set('cached_recommendations', data.slice(0, 24));
      renderRecommendationCards(grid, recommendedSongs);

      if (topArtists[0]) renderTasteSection(topArtists[0]);
    } catch (err) {
      console.error(err);
      grid.innerHTML = '<p class="empty-msg" style="grid-column:1/-1;text-align:center;">Could not load recommendations.</p>';
    } finally {
      isFetchingRecs = false;
    }
  }

  function renderRecommendationCards(container, songs) {
    if (!songs || !songs.length) {
      container.innerHTML = '<p class="empty-msg" style="grid-column:1/-1;text-align:center;">No songs available right now.</p>';
      return;
    }

    container.innerHTML = songs.map((item, i) => `
      <div class="result-card ${isCurrent(item.id) ? 'playing' : ''}" data-id="${item.id}" data-idx="${i}">
        <div class="card-thumbnail">
          <img src="${thumb(item)}" alt="" loading="lazy" />
          <span class="card-duration">${fmtDur(item.duration)}</span>
          <div class="card-play-overlay" data-action="play"><div class="overlay-play-btn"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></div></div>
        </div>
        <div class="card-info">
          <div class="card-title" title="${esc(item.title)}">${esc(item.title)}</div>
          <div class="card-meta">
            <span class="card-channel">${esc(item.channel)}</span>
            <div class="card-actions">
              <button class="card-action-btn ${isLiked(item.id) ? 'liked' : ''}" data-action="like" title="Like">
                <svg viewBox="0 0 24 24" fill="${isLiked(item.id) ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
              </button>
              <button class="card-action-btn" data-action="download" title="Download MP3">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </button>
              <button class="card-action-btn" data-action="addpl" title="Add to playlist">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </button>
              <button class="card-action-btn" data-action="queue" title="Add to queue">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>
              </button>
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
          else if (action.dataset.action === 'queue') addToQueue(item);
          else if (action.dataset.action === 'addpl') openAddToPlaylist(item);
          else if (action.dataset.action === 'download') downloadSong(item);
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
    queue.push(song); updateQueueUI(); toast('Added to queue');
  }

  function removeFromQueue(idx) {
    if (idx === currentIndex) return;
    queue.splice(idx, 1);
    if (idx < currentIndex) currentIndex--;
    updateQueueUI();
  }

  function clearQueue() {
    const cur = currentIndex >= 0 ? queue[currentIndex] : null;
    queue = cur ? [cur] : []; currentIndex = cur ? 0 : -1;
    updateQueueUI(); toast('Queue cleared');
  }

  function toggleQueue() {
    const open = queueSidebar.classList.toggle('open');
    $('#queueToggleBtn').classList.toggle('active', open);
    pageContent.classList.toggle('queue-open', open);
  }

  function updateQueueUI() {
    queueBadge.textContent = queue.length;
    queueBadge.classList.toggle('visible', queue.length > 0);

    if (!queue.length) {
      queueList.innerHTML = '<div class="queue-empty"><p>Queue is empty</p><p class="queue-hint">Search and add songs</p></div>';
      return;
    }

    queueList.innerHTML = queue.map((s, i) => `
      <div class="queue-item ${i === currentIndex ? 'active' : ''}" data-idx="${i}">
        <div class="qi-thumb"><img src="${thumb(s)}" alt="" loading="lazy" /></div>
        <div class="qi-info"><div class="qi-title">${esc(s.title)}</div><div class="qi-channel">${esc(s.channel)}</div></div>
        <button class="qi-remove" data-action="remove" title="Remove"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
      </div>
    `).join('');

    queueList.querySelectorAll('.queue-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const idx = parseInt(item.dataset.idx);
        if (e.target.closest('[data-action="remove"]')) { e.stopPropagation(); removeFromQueue(idx); }
        else playSong(queue[idx]);
      });
    });

    const active = queueList.querySelector('.queue-item.active');
    if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function playAllResults() {
    if (!searchResults.length) return;
    queue = [...searchResults]; currentIndex = -1;
    updateQueueUI(); playSong(queue[0]); toast(`Playing ${queue.length} songs`);
  }

  function highlightResults() {
    resultsGrid.querySelectorAll('.result-card').forEach(c => c.classList.toggle('playing', isCurrent(c.dataset.id)));
  }

  /* ================================================================
     HISTORY & ANALYTICS
     ================================================================ */
  function addToHistory(song) {
    if (!song || !song.id) return;
    history.unshift({ song, playedAt: new Date().toISOString(), listenedSec: 0 });
    if (history.length > 250) history = history.slice(0, 250);
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
    if (playStartTime && history.length > 0 && history[0] && history[0].song) {
      const sec = Math.floor((Date.now() - playStartTime) / 1000);
      history[0].listenedSec = (history[0].listenedSec || 0) + sec;
      Storage.set('history', history);
    }
    // Always cleared, even when there was nothing to attribute the time to.
    playStartTime = null;
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
        <div class="top-item" data-id="${esc(t.song.id)}">
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
      content.innerHTML = data.lines.map((l, i) => `<div class="lyrics-line" data-idx="${i}" data-time="${l.time}">${esc(l.text)}</div>`).join('');

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

  function syncLyrics(time) {
    if (!lyricsData || !lyricsData.synced) return;
    const lines = $$('.lyrics-line');
    let activeIdx = -1;
    for (let i = lyricsData.lines.length - 1; i >= 0; i--) {
      if (time >= lyricsData.lines[i].time) { activeIdx = i; break; }
    }
    lines.forEach((l, i) => {
      const isActive = i === activeIdx;
      l.classList.toggle('active', isActive);
      if (isActive && $('#lyricsPanel').classList.contains('open')) {
        l.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    });
  }

  /* ================================================================
     SHARE & DOWNLOAD
     ================================================================ */
  function shareSong() {
    if (!currentSong) { toast('No song playing'); return; }
    const url = `https://www.youtube.com/watch?v=${currentSong.id}`;
    const text = `🎵 ${currentSong.title} — ${currentSong.channel}`;

    if (navigator.share) {
      navigator.share({ title: currentSong.title, text, url }).catch(() => {});
    } else {
      navigator.clipboard.writeText(`${text}\n${url}`).then(() => toast('Link copied!')).catch(() => toast('Could not copy'));
    }
  }

  async function downloadSong(song) {
    if (!song || !song.id) { toast('No song selected'); return; }
    if (song.isLocal) {
      const a = document.createElement('a');
      a.href = song.streamUrl;
      a.download = song.title || 'MusicFlow-Track';
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }
    if (song.isCloud) {
      toast('Downloads are available for YouTube search results.');
      return;
    }
    toast(`⏳ Preparing MP3 download for "${(song.title || 'track').slice(0, 25)}..."`);

    try {
      const downloadUrl = `/api/download/${song.id}`;
      const response = await fetch(downloadUrl);
      if (!response.ok) throw new Error('The server could not prepare this MP3.');
      const blob = await response.blob();
      const a = document.createElement('a');
      const objectUrl = URL.createObjectURL(blob);
      a.href = objectUrl;
      a.download = `${(song.title || 'MusicTrack').replace(/[/\\?%*:|"<>]/g, '')}.mp3`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      toast(`✅ MP3 download started! Check downloads folder.`);
    } catch (err) {
      toast(`⚠️ Download error: ${err.message || 'Server busy'}`);
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
     KEYBOARD SHORTCUTS & GLOBAL HOTKEYS
     ================================================================ */
  function onKeyboard(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    switch (e.key) {
      case ' ': e.preventDefault(); togglePlayPause(); break;
      case 'ArrowRight': e.preventDefault(); if (audioPlayer.duration) audioPlayer.currentTime = Math.min(audioPlayer.duration, audioPlayer.currentTime + 5); break;
      case 'ArrowLeft': e.preventDefault(); audioPlayer.currentTime = Math.max(0, audioPlayer.currentTime - 5); break;
      case 'ArrowUp': e.preventDefault(); volume = Math.min(1, volume + 0.05); audioPlayer.volume = volume; updateVolumeUI(); Storage.set('volume', volume); break;
      case 'ArrowDown': e.preventDefault(); volume = Math.max(0, volume - 0.05); audioPlayer.volume = volume; updateVolumeUI(); Storage.set('volume', volume); break;
      case 'm': case 'M': toggleMute(); break;
      case 'n': case 'N': playNext(); break;
      case 'p': case 'P':
        if (e.shiftKey) playPrev();
        else CanvasPiPManager.toggle();
        break;
      case 'f': case 'F': PomodoroManager.openModal(); break;
      case 'q': case 'Q': toggleQueue(); break;
      case 'l': case 'L': toggleLyrics(); break;
      case 'd': case 'D': if (currentSong) downloadSong(currentSong); break;
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
  function thumb(s) { return s.thumbnail || `https://i.ytimg.com/vi/${s.id}/hqdefault.jpg`; }

  function fmtDur(sec) {
    if (!sec) return '0:00';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s2 = Math.floor(sec % 60);
    return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s2).padStart(2,'0')}` : `${m}:${String(s2).padStart(2,'0')}`;
  }

  function fmtTime(sec) { return !sec || isNaN(sec) ? '0:00' : fmtDur(Math.floor(sec)); }

  function esc(str) { const d = document.createElement('div'); d.textContent = str || ''; return d.innerHTML; }

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
          if (this.presets[presetKey]) this.applyPreset(this.presets[presetKey]);
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
        });
      });

      $('#bassBoostRange')?.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        $('#bassBoostVal').textContent = val + ' dB';
        this.setBassBoost(val);
      });

      $('#spatialAudioToggle')?.addEventListener('change', (e) => {
        const applied = this.setSpatialAudio(e.target.checked);
        if (!applied) {
          // Don't leave the switch claiming a mode that never engaged.
          e.target.checked = false;
          return;
        }
        toast(e.target.checked ? '🎧 3D Spatial Audio Active' : '3D Spatial Audio Off');
      });

      $('#eqResetBtn')?.addEventListener('click', () => {
        this.applyPreset(this.presets.flat);
        $$('.eq-preset-btn').forEach(b => b.classList.remove('active'));
        $('.eq-preset-btn[data-preset="flat"]')?.classList.add('active');
      });
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
          $$('.sleep-option-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          const mins = btn.dataset.mins;
          if (mins === 'track') {
            this.setTimerTrackEnd();
          } else {
            this.startTimer(parseInt(mins));
          }
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

  /* ----- Start ----- */
  init();
})();
