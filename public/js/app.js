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
          if (!history.length) {
            history = serverData.history;
            localStorage.setItem('mf_history', JSON.stringify(history));
            needsUpdate = true;
          }
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
  const pages = { home: $('#pageHome'), search: $('#pageSearch'), library: $('#pageLibrary'), profile: $('#pageProfile') };
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
    audioPlayer.volume = volume;
    updateVolumeUI();
    if (isShuffle) $('#shuffleBtn').classList.add('active');
    if (repeatMode !== 'off') { $('#repeatBtn').classList.add('active'); updateRepeatIcon(); }
    updateQualityLabel();
    bindEvents();
    navigateTo('home');
    renderHomePage();

    // Auto-restore saved likes and playlists from disk database
    Storage.syncFromServer();
  }

  function createOrbs() {
    for (let i = 0; i < 3; i++) { const o = document.createElement('div'); o.classList.add('orb'); bgAnimation.appendChild(o); }
  }

  /* ================================================================
     THEME
     ================================================================ */
  function applyTheme(theme) {
    currentTheme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    Storage.set('theme', theme);
    const sun = $('.icon-sun');
    const moon = $('.icon-moon');
    if (theme === 'dark') { sun.style.display = ''; moon.style.display = 'none'; }
    else { sun.style.display = 'none'; moon.style.display = ''; }
    $('#settingTheme').value = theme;
  }

  /* ================================================================
     EVENTS
     ================================================================ */
  function bindEvents() {
    // Search
    searchInput.addEventListener('input', onSearchInput);
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(searchTimeout); doSearch(searchInput.value.trim()); searchSuggestions.classList.remove('active'); } });
    searchInput.addEventListener('focus', () => { if (searchInput.value.trim().length >= 2) fetchSuggestions(searchInput.value.trim()); });
    document.addEventListener('click', (e) => { if (!$('#searchBarWrap').contains(e.target)) searchSuggestions.classList.remove('active'); });
    searchClear.addEventListener('click', clearSearch);

    // Quick tags & genre cards
    $$('.tag').forEach(t => t.addEventListener('click', () => { searchInput.value = t.dataset.query; navigateTo('search'); doSearch(t.dataset.query); }));
    $$('.genre-card').forEach(c => c.addEventListener('click', () => { searchInput.value = c.dataset.query; navigateTo('search'); doSearch(c.dataset.query); }));

    // Nav
    navLinks.forEach(l => l.addEventListener('click', (e) => { e.preventDefault(); navigateTo(l.dataset.page); }));

    // Sidebar mobile
    $('#mobileMenuBtn').addEventListener('click', toggleMobileSidebar);

    // Queue
    $('#queueToggleBtn').addEventListener('click', toggleQueue);
    $('#queueCloseBtn').addEventListener('click', toggleQueue);
    $('#queueClearBtn').addEventListener('click', clearQueue);

    // Player
    playPauseBtn.addEventListener('click', togglePlayPause);
    $('#prevBtn').addEventListener('click', playPrev);
    $('#nextBtn').addEventListener('click', playNext);
    $('#shuffleBtn').addEventListener('click', toggleShuffle);
    $('#repeatBtn').addEventListener('click', toggleRepeat);
    $('#muteBtn').addEventListener('click', toggleMute);
    $('#npLikeBtn').addEventListener('click', () => { if (currentSong) toggleLike(currentSong); });
    playAllBtn.addEventListener('click', playAllResults);

    // Progress
    npProgressBar.addEventListener('mousedown', startSeek);
    npProgressBar.addEventListener('touchstart', startSeek, { passive: true });
    npVolumeBar.addEventListener('mousedown', startVolChange);
    npVolumeBar.addEventListener('touchstart', startVolChange, { passive: true });

    // Audio events
    audioPlayer.addEventListener('timeupdate', onTimeUpdate);
    audioPlayer.addEventListener('loadedmetadata', onMeta);
    audioPlayer.addEventListener('ended', onEnd);
    audioPlayer.addEventListener('play', () => { setPlayState(true); playStartTime = Date.now(); });
    audioPlayer.addEventListener('pause', () => { setPlayState(false); recordListenTime(); });
    audioPlayer.addEventListener('error', onAudioError);

    // Theme
    $('#themeToggleBtn').addEventListener('click', () => applyTheme(currentTheme === 'dark' ? 'light' : 'dark'));

    // Settings
    $('#settingsBtn').addEventListener('click', () => { $('#settingsModal').style.display = ''; });
    $('#settingsCloseBtn').addEventListener('click', () => { $('#settingsModal').style.display = 'none'; });
    $('#settingsModal').addEventListener('click', (e) => { if (e.target === $('#settingsModal')) $('#settingsModal').style.display = 'none'; });
    $('#settingTheme').addEventListener('change', (e) => applyTheme(e.target.value));
    $('#settingQuality').addEventListener('change', (e) => { audioQuality = e.target.value; Storage.set('quality', audioQuality); updateQualityLabel(); toast('Quality: ' + (audioQuality === 'high' ? 'High' : 'Low')); });

    // Phone modal
    async function updatePhoneModal() {
      const urlEl = $('#phoneModalUrl');
      const qrEl = $('#phoneModalQrImg');
      let targetUrl = window.location.origin;

      if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        try {
          const res = await fetch('/api/network-info');
          if (res.ok) {
            const data = await res.json();
            if (data && data.primaryNetworkUrl) {
              targetUrl = data.primaryNetworkUrl;
            }
          }
        } catch (e) { /* fallback to origin */ }
      }

      if (urlEl) {
        urlEl.textContent = targetUrl;
        urlEl.onclick = () => {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(targetUrl);
            toast('📋 Network link copied to clipboard!');
          }
        };
      }
      if (qrEl && targetUrl) {
        qrEl.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(targetUrl)}`;
      }
    }

    $('#navPhone').addEventListener('click', (e) => {
      e.preventDefault();
      $('#phoneModalOverlay').style.display = '';
      updatePhoneModal();
    });
    $('#phoneModalCloseBtn').addEventListener('click', () => { $('#phoneModalOverlay').style.display = 'none'; });
    $('#phoneModalOverlay').addEventListener('click', (e) => { if (e.target === $('#phoneModalOverlay')) $('#phoneModalOverlay').style.display = 'none'; });

    // Quality button
    $('#qualityBtn').addEventListener('click', () => { audioQuality = audioQuality === 'high' ? 'low' : 'high'; Storage.set('quality', audioQuality); updateQualityLabel(); $('#settingQuality').value = audioQuality; toast('Quality: ' + (audioQuality === 'high' ? 'High' : 'Low')); });

    // Share & Download
    $('#shareBtn').addEventListener('click', shareSong);
    const dlBtn = $('#downloadBtn');
    if (dlBtn) dlBtn.addEventListener('click', () => { if (currentSong) downloadSong(currentSong); else toast('No song playing'); });

    // Lyrics
    $('#lyricsBtn').addEventListener('click', toggleLyrics);
    $('#lyricsCloseBtn').addEventListener('click', toggleLyrics);

    // Library
    $('#likedSongsCard').addEventListener('click', showLikedSongs);
    $('#playLikedBtn').addEventListener('click', (e) => { e.stopPropagation(); playLikedSongs(); });
    $('#createPlaylistBtn').addEventListener('click', openCreatePlaylist);
    $('#playlistModalClose').addEventListener('click', () => { $('#playlistModal').style.display = 'none'; });
    $('#playlistModal').addEventListener('click', (e) => { if (e.target === $('#playlistModal')) $('#playlistModal').style.display = 'none'; });
    $('#playlistSaveBtn').addEventListener('click', savePlaylist);
    $('#playlistNameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') savePlaylist(); });
    $('#playlistBackBtn').addEventListener('click', () => { $('#playlistDetail').style.display = 'none'; renderLibrary(); });
    $('#playPlaylistBtn').addEventListener('click', playCurrentPlaylist);
    $('#deletePlaylistBtn').addEventListener('click', deleteCurrentPlaylist);
    $('#addToPlaylistClose').addEventListener('click', () => { $('#addToPlaylistModal').style.display = 'none'; });
    $('#addToPlaylistModal').addEventListener('click', (e) => { if (e.target === $('#addToPlaylistModal')) $('#addToPlaylistModal').style.display = 'none'; });

    // Batch Text Importer
    const openBatchBtn = $('#openBatchImportBtn');
    if (openBatchBtn) openBatchBtn.addEventListener('click', () => openBatchImport());
    const plBatchBtn = $('#playlistBatchAddBtn');
    if (plBatchBtn) plBatchBtn.addEventListener('click', () => openBatchImport(currentPlaylistId));
    const batchCloseBtn = $('#batchImportClose');
    if (batchCloseBtn) batchCloseBtn.addEventListener('click', closeBatchImport);
    const batchCancelBtn = $('#batchCancelBtn');
    if (batchCancelBtn) batchCancelBtn.addEventListener('click', closeBatchImport);
    const batchModal = $('#batchImportModal');
    if (batchModal) batchModal.addEventListener('click', (e) => { if (e.target === batchModal) closeBatchImport(); });
    const batchArea = $('#batchTextarea');
    if (batchArea) batchArea.addEventListener('input', onBatchTextChange);
    const batchClearBtn = $('#batchClearText');
    if (batchClearBtn) batchClearBtn.addEventListener('click', () => { if (batchArea) batchArea.value = ''; onBatchTextChange(); });
    $$('.batch-example-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        if (batchArea) {
          batchArea.value = pill.dataset.text;
          onBatchTextChange();
        }
      });
    });
    $('#destRadioNew').addEventListener('change', () => {
      $('#batchNewPlaylistWrap').style.display = '';
      $('#batchExistingPlaylistWrap').style.display = 'none';
    });
    $('#destRadioExisting').addEventListener('change', () => {
      $('#batchNewPlaylistWrap').style.display = 'none';
      $('#batchExistingPlaylistWrap').style.display = '';
    });
    $('#batchStartBtn').addEventListener('click', executeBatchImport);

    // Home Recommendations & Smart Radio
    const startRadioBtn = $('#startRadioBtn');
    if (startRadioBtn) startRadioBtn.addEventListener('click', startPersonalizedRadio);
    const playAllRecBtn = $('#playAllRecBtn');
    if (playAllRecBtn) playAllRecBtn.addEventListener('click', startPersonalizedRadio);
    const refreshRecBtn = $('#refreshRecBtn');
    if (refreshRecBtn) refreshRecBtn.addEventListener('click', () => loadRecommendations(true));

    // Profile
    $('#clearHistoryBtn').addEventListener('click', () => { history = []; Storage.set('history', []); renderProfile(); toast('History cleared'); });

    // Search history
    $('#clearSearchHistory').addEventListener('click', () => { searchHistory = []; Storage.set('searchHistory', []); renderSearchHistory(); });

    // Retry
    const retryBtn = document.getElementById('retryBtn');
    if (retryBtn) retryBtn.addEventListener('click', () => doSearch(lastQuery));

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
    if (!query) return;
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
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2500);
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

      searchResults = results;
      if (searchResults.length === 0) {
        resultsGrid.innerHTML = '<p class="empty-msg" style="grid-column:1/-1;text-align:center;">No results found.</p>';
      } else {
        renderResults(searchResults);
      }
    } catch (err) {
      resultsGrid.innerHTML = `<p class="empty-msg" style="grid-column:1/-1;text-align:center;">Search failed. Please check connection.</p>`;
    } finally {
      searchLoading.classList.remove('active');
    }
  }

  function clearSearch() {
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
  function playSong(song) {
    recordListenTime();

    let idx = queue.findIndex(s => s.id === song.id);
    if (idx === -1) { queue.push(song); idx = queue.length - 1; }
    currentIndex = idx;
    currentSong = song;

    npThumbnail.src = thumb(song);
    npTitle.textContent = song.title;
    npChannel.textContent = song.channel;
    updateLikeBtn();

    if (song.streamUrl) {
      audioPlayer.src = song.streamUrl;
      audioPlayer.play().catch(() => {});
    } else if (song.isCloud) {
      toast('⚡ Loading high-quality audio...');
      CloudMusicEngine.getStreamUrl(song.id).then(url => {
        if (url) {
          song.streamUrl = url;
          audioPlayer.src = url;
          audioPlayer.play().catch(() => {});
        } else {
          audioPlayer.src = `/api/stream/${song.id}?quality=${audioQuality}`;
          audioPlayer.play().catch(() => {});
        }
      }).catch(() => {
        audioPlayer.src = `/api/stream/${song.id}?quality=${audioQuality}`;
        audioPlayer.play().catch(() => {});
      });
    } else {
      audioPlayer.src = `/api/stream/${song.id}?quality=${audioQuality}`;
      audioPlayer.play().catch(() => {
        // Fallback to direct cloud track
        CloudMusicEngine.search(song.title).then(results => {
          if (results && results[0]) {
            CloudMusicEngine.getStreamUrl(results[0].id).then(u => {
              if (u) {
                audioPlayer.src = u;
                audioPlayer.play().catch(() => {});
              }
            });
          }
        });
      });
    }

    // History
    addToHistory(song);

    updateQueueUI();
    highlightResults();
    toast(`▶ ${song.title}`);

    // Set document title
    document.title = `${song.title} — MusicFlow`;

    // Fetch lyrics
    fetchLyrics(song.id);
  }

  function togglePlayPause() {
    if (!audioPlayer.src || currentIndex < 0) return;
    audioPlayer.paused ? audioPlayer.play() : audioPlayer.pause();
  }

  function setPlayState(playing) {
    isPlaying = playing;
    $('.play-icon').style.display = playing ? 'none' : '';
    $('.pause-icon').style.display = playing ? '' : 'none';
    playPauseBtn.title = playing ? 'Pause' : 'Play';
    nowPlayingBar.classList.toggle('playing', playing);
  }

  function playNext() {
    if (!queue.length) return;
    if (isShuffle) {
      let n; do { n = Math.floor(Math.random() * queue.length); } while (n === currentIndex && queue.length > 1);
      playSong(queue[n]);
    } else {
      const n = currentIndex + 1;
      if (n < queue.length) playSong(queue[n]);
      else if (repeatMode === 'all') playSong(queue[0]);
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
    if (repeatMode === 'one') { audioPlayer.currentTime = 0; audioPlayer.play(); }
    else playNext();
  }

  function onAudioError() { toast('⚠️ Playback error'); setTimeout(playNext, 1500); }

  function onTimeUpdate() {
    if (isSeeking) return;
    const c = audioPlayer.currentTime, d = audioPlayer.duration || 0;
    npCurrentTime.textContent = fmtTime(c);
    if (d > 0) { const p = (c / d) * 100; npProgressFill.style.width = p + '%'; npProgressThumb.style.left = p + '%'; }
    // Lyrics sync
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
    const list = $('#likedSongsList');
    if (list.style.display === 'none') {
      list.style.display = '';
      renderSongList(list, likedSongs, 'liked');
    } else {
      list.style.display = 'none';
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

    // Hide main library, show detail
    $$('#pageLibrary > *:not(.playlist-detail)').forEach(el => el.style.display = 'none');
    $('#playlistDetail').style.display = '';
    $('#playlistDetailName').textContent = pl.name;
    renderSongList($('#playlistSongsList'), pl.songs, 'playlist');
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
    $('#playlistDetail').style.display = 'none';
    renderLibrary();
    toast('Playlist deleted');
  }

  function renderLibrary() {
    // Show all main items, hide detail
    $$('#pageLibrary > *:not(.playlist-detail)').forEach(el => el.style.display = '');
    $('#playlistDetail').style.display = 'none';

    $('#likedCount').textContent = likedSongs.length + ' songs';
    $('#likedSongsList').style.display = 'none';

    const grid = $('#playlistsGrid');
    if (!playlists.length) {
      grid.innerHTML = '<p class="empty-msg" id="noPlaylists">No playlists yet. Create one!</p>';
    } else {
      grid.innerHTML = playlists.map(pl => `<div class="playlist-card" data-plid="${pl.id}"><div class="pc-icon">📂</div><div class="pc-name">${esc(pl.name)}</div><div class="pc-count">${pl.songs.length} songs</div></div>`).join('');
      grid.querySelectorAll('.playlist-card').forEach(c => {
        c.addEventListener('click', () => showPlaylistDetail(c.dataset.plid));
      });
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
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) data = await res.json();
      } catch (e) {}

      if (!data || data.length === 0) {
        data = await CloudMusicEngine.getTrending();
      }

      recommendedSongs = data;
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
    history.unshift({ song, playedAt: new Date().toISOString(), listenedSec: 0 });
    if (history.length > 500) history = history.slice(0, 500);
    Storage.set('history', history);
  }

  function recordListenTime() {
    if (playStartTime && history.length > 0) {
      const sec = Math.floor((Date.now() - playStartTime) / 1000);
      history[0].listenedSec = (history[0].listenedSec || 0) + sec;
      Storage.set('history', history);
      playStartTime = null;
    }
  }

  function renderProfile() {
    // Stats
    $('#statTotalPlayed').textContent = history.length;
    const totalMin = Math.floor(history.reduce((a, h) => a + (h.listenedSec || 0), 0) / 60);
    $('#statMinutes').textContent = totalMin;
    $('#statLiked').textContent = likedSongs.length;
    $('#statPlaylists').textContent = playlists.length;

    // Top Songs
    const songCounts = {};
    history.forEach(h => {
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
        <div class="top-item" data-id="${t.song.id}">
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
    history.forEach(h => {
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
    const recentHist = history.slice(0, 30);
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
        row.addEventListener('click', () => { const i = parseInt(row.dataset.idx); playSong(recentHist[i].song); });
      });
    }
  }

  /* ================================================================
     HOME PAGE
     ================================================================ */
  function renderHomePage() {
    // Greeting based on time
    const hour = new Date().getHours();
    let greeting = 'Good Evening';
    if (hour < 12) greeting = 'Good Morning';
    else if (hour < 17) greeting = 'Good Afternoon';
    $('#homeGreeting h1').textContent = greeting;

    // Recently Played
    const recent = [];
    const seen = new Set();
    for (const h of history) {
      if (!seen.has(h.song.id)) { seen.add(h.song.id); recent.push(h.song); }
      if (recent.length >= 12) break;
    }

    const rSection = $('#recentlyPlayedSection');
    if (recent.length > 0) {
      rSection.style.display = '';
      const grid = $('#recentlyPlayedGrid');
      grid.innerHTML = recent.map(s => `
        <div class="result-card" data-id="${s.id}">
          <div class="card-thumbnail">
            <img src="${thumb(s)}" alt="" loading="lazy" />
            <span class="card-duration">${fmtDur(s.duration)}</span>
            <div class="card-play-overlay"><div class="overlay-play-btn"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></div></div>
          </div>
          <div class="card-info"><div class="card-title">${esc(s.title)}</div><div class="card-meta"><span class="card-channel">${esc(s.channel)}</span></div></div>
        </div>
      `).join('');
      grid.querySelectorAll('.result-card').forEach(c => c.addEventListener('click', () => {
        const s = recent.find(r => r.id === c.dataset.id);
        if (s) playSong(s);
      }));
    } else {
      rSection.style.display = 'none';
    }
  }

  /* ================================================================
     LYRICS
     ================================================================ */
  let lyricsData = null;

  function toggleLyrics() {
    const panel = $('#lyricsPanel');
    panel.classList.toggle('open');
    $('#lyricsBtn').classList.toggle('active', panel.classList.contains('open'));
  }

  async function fetchLyrics(videoId) {
    const content = $('#lyricsContent');
    content.innerHTML = '<p class="lyrics-placeholder">Loading lyrics...</p>';
    lyricsData = null;

    try {
      const res = await fetch(`/api/lyrics/${videoId}`);
      const data = await res.json();

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

  function downloadSong(song) {
    if (!song || !song.id) { toast('No song selected'); return; }
    toast(`⏳ Preparing MP3 download for "${song.title.slice(0, 25)}..."`);
    
    // Create an invisible anchor tag to trigger browser download directly from backend
    const a = document.createElement('a');
    a.href = `/api/download/${song.id}`;
    a.download = `${song.title || 'song'}.mp3`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
    }, 1000);
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
     KEYBOARD SHORTCUTS
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
      case 'p': case 'P': playPrev(); break;
      case 'q': case 'Q': toggleQueue(); break;
      case 'l': case 'L': toggleLyrics(); break;
      case 'd': case 'D': if (currentSong) downloadSong(currentSong); break;
    }
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

  /* ----- Start ----- */
  init();
})();
