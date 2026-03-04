// ─────────────────────────────────────────────────────────────────────────────
// app.js — IPTV Player Phase 2
// Phase 1: IndexedDB + ImageCache + Continue Watching + Resume
// Phase 2: mpv embedded player replacing HLS.js
// ─────────────────────────────────────────────────────────────────────────────

const PS           = 48;
const CACHE_MAX_MS = 6 * 60 * 60 * 1000;

// ── State ─────────────────────────────────────────────────────────────────────
const S = {
  source:     null,
  channels:   [],
  movies:     [],
  series:     [],
  cats:       { live: [], vod: [], series: [] },
  epg:        {},
  favs:       new Set(),
  history:    [],
  view:       { live: 'grid', movies: 'grid', series: 'grid' },
  activeCat:  { live: 'all', movies: 'all', series: 'all' },
  search:     { live: '', movies: '', series: '' },
  page:       { live: 0, movies: 0, series: 0 },
  current:    null,   // { url, name, type, poster, subtitle }
  settings:   { defaultPlayer: 'mpv', hwdec: true, defaultVolume: 85 },
  vlcFound:   false,
  bgCleanup:  null,
};

// Lightweight performance instrumentation (dev only, no-throw)
function perfLog(label, payload = {}) {
  try {
    if (!window.api || !window.api.isDev) return;
    console.log('[perf]', label, payload);
  } catch (_) {
    // Never let perf logging break the app
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// MPV PLAYER CONTROLLER
// ═════════════════════════════════════════════════════════════════════════════
const Player = (() => {
  // ── Internal state ──────────────────────────────────────────────────────────
  let _ready       = false;    // socket connected
  let _loaded      = false;    // file loaded, first frame shown
  let _isLive      = false;
  let _duration    = 0;
  let _volume      = 85;
  let _muted       = false;
  let _paused      = false;
  let _seeking     = false;    // user is dragging seek bar
  let _controlsTimer = null;
  let _histTimer     = null;
  let _currentUrl    = null;
  let _unsubs        = [];     // cleanup functions for event listeners
  let _retryUrl      = null;   // for error retry
  let _openStartedAt = 0;      // perf: last Player.open start time

  // ── DOM refs ────────────────────────────────────────────────────────────────
  const $  = id => document.getElementById(id);
  const pp = $('player-page');

  // ── Show / hide controls overlay ────────────────────────────────────────────
  function _showControls() {
    $('player-controls').classList.add('visible');
    $('player-topbar').classList.add('visible');
    $('mpv-container').classList.add('controls-visible');
    clearTimeout(_controlsTimer);
    // Auto-hide after 3s (not for live TV pause)
    if (!_paused) {
      _controlsTimer = setTimeout(_hideControls, 3000);
    }
  }

  function _hideControls() {
    if (_paused) return;  // keep visible while paused
    $('player-controls').classList.remove('visible');
    $('player-topbar').classList.remove('visible');
    $('mpv-container').classList.remove('controls-visible');
  }

  // ── Loading / error states ───────────────────────────────────────────────────
  function _setLoading(on, title = '', sub = '') {
    const el = $('player-loading');
    if (on) {
      $('player-loading-title').textContent = title || 'Loading stream…';
      $('player-loading-sub').textContent   = sub;
      // Show poster backdrop if we have one
      const backdrop = $('player-poster-backdrop');
      if (backdrop && S.current?.poster) {
        backdrop.style.backgroundImage = `url('${S.current.poster}')`;
        backdrop.style.display = '';
      } else if (backdrop) {
        backdrop.style.display = 'none';
      }
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
      const backdrop = $('player-poster-backdrop');
      if (backdrop) backdrop.style.display = 'none';
    }
  }

  function _setError(msg) {
    _setLoading(false);
    const el = $('player-error');
    $('player-error-msg').textContent = msg || 'Unable to play this stream.';
    el.classList.add('visible');
  }

  function _clearError() {
    $('player-error').classList.remove('visible');
  }

  // ── Seek bar ─────────────────────────────────────────────────────────────────
  function _updateSeek(pos) {
    if (_seeking || _isLive || !_duration) return;
    const pct = Math.min(100, (pos / _duration) * 100);
    $('seek-fill').style.width    = pct + '%';
    $('seek-thumb').style.left    = pct + '%';
    $('time-current').textContent = _fmt(pos);
    $('seek-track').setAttribute('aria-valuenow', Math.round(pct));
  }

  function _updateDuration(dur) {
    _duration = dur || 0;
    $('time-total').textContent = _fmt(_duration);
  }

  function _fmt(secs) {
    if (!secs || secs < 0) return '0:00';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
  }

  function _initSeekBar() {
    const track = $('seek-track');
    let dragging = false;

    function scrub(e) {
      const rect = track.getBoundingClientRect();
      const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const pos  = pct * _duration;
      $('seek-fill').style.width = (pct * 100) + '%';
      $('seek-thumb').style.left = (pct * 100) + '%';
      $('time-current').textContent = _fmt(pos);
      return pos;
    }

    track.addEventListener('mousedown', e => {
      if (_isLive) return;
      dragging = true; _seeking = true;
      _showControls();
      const pos = scrub(e);
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup',   onUp);
    });

    function onMove(e) { if (dragging) scrub(e); }
    function onUp(e) {
      if (!dragging) return;
      dragging = false; _seeking = false;
      const pos = scrub(e);
      api.mpvSeek(pos, 'absolute');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
  }

  // ── Volume bar ───────────────────────────────────────────────────────────────
  function _initVolumeBar() {
    const track = $('volume-track');
    track.addEventListener('mousedown', e => {
      function set(ev) {
        const rect = track.getBoundingClientRect();
        const pct  = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
        const vol  = Math.round(pct * 100);
        _setVolume(vol, true);
      }
      set(e);
      window.addEventListener('mousemove', set);
      window.addEventListener('mouseup', () => window.removeEventListener('mousemove', set), { once: true });
    });
  }

  function _setVolume(vol, sendToMpv = false) {
    _volume = Math.max(0, Math.min(100, vol));
    $('volume-fill').style.width = _volume + '%';
    _updateVolIcon();
    if (sendToMpv) api.mpvSetVolume(_volume);
  }

  function _updateVolIcon() {
    const icon = $('vol-icon');
    // Swap between muted and speaker SVG paths based on mute/volume
    if (_muted || _volume === 0) {
      icon.innerHTML = `<path d="M6.717 3.55A.5.5 0 017 4v8a.5.5 0 01-.812.39L3.825 10.5H1.5A.5.5 0 011 10V6a.5.5 0 01.5-.5h2.325l2.363-1.89a.5.5 0 01.529-.06zm7.137 1.39a.5.5 0 010 .708L11.647 8l2.207 2.354a.5.5 0 01-.726.684L10.921 8.684l-2.207 2.354a.5.5 0 01-.726-.684L10.195 8 7.988 5.646a.5.5 0 01.726-.684L10.92 7.316l2.207-2.354a.5.5 0 01.727-.022z"/>`;
    } else {
      icon.innerHTML = `<path d="M11.536 14.01A8.473 8.473 0 019 15v-1.7a6.97 6.97 0 002-.047l.536.757zm3.058-.204a8.516 8.516 0 01-1.403 1.403l-.736-.527a7.323 7.323 0 001.202-1.202l.937.326zM8.5 3.016c.21.007.42.025.628.053l.174.874a6.493 6.493 0 00-.802-.08V3.016zm.003 9.968a6.493 6.493 0 00.8-.08l-.175.875a8.47 8.47 0 01-.625.053v-.848zM6 3a.5.5 0 01.5.5v9a.5.5 0 01-1 0v-9A.5.5 0 016 3zm-3.5.5a.5.5 0 011 0v9a.5.5 0 01-1 0v-9z"/>`;
    }
  }

  // ── Play/Pause button ────────────────────────────────────────────────────────
  function _updatePlayBtn(paused) {
    _paused = paused;
    $('play-icon').style.display  = paused  ? '' : 'none';
    $('pause-icon').style.display = !paused ? '' : 'none';
    if (!paused) {
      clearTimeout(_controlsTimer);
      _controlsTimer = setTimeout(_hideControls, 3000);
    } else {
      clearTimeout(_controlsTimer);
      _showControls();
    }
  }

  // ── Track menus ──────────────────────────────────────────────────────────────
  function _populateTracks(tracks) {
    const audioMenu = $('audio-track-menu');
    const subMenu   = $('sub-track-menu');

    const audioTracks = tracks.filter(t => t.type === 'audio');
    const subTracks   = tracks.filter(t => t.type === 'sub');

    // Audio
    let aHtml = `<div class="track-menu-title">Audio Track</div>`;
    aHtml += `<div class="track-menu-item${!_muted ? ' active' : ''}" onclick="Player.setAudio('no')">
      <span>Disabled</span><span class="check">✓</span></div>`;
    audioTracks.forEach(t => {
      const label = [t.lang, t.title].filter(Boolean).join(' — ') || `Track ${t.id}`;
      aHtml += `<div class="track-menu-item" data-aid="${t.id}"
        onclick="Player.setAudio(${t.id})">
        <span>${esc(label)}</span><span class="check">✓</span></div>`;
    });
    audioMenu.innerHTML = aHtml;

    // Subtitles
    let sHtml = `<div class="track-menu-title">Subtitles</div>`;
    sHtml += `<div class="track-menu-item active" onclick="Player.setSub('no')">
      <span>Off</span><span class="check">✓</span></div>`;
    subTracks.forEach(t => {
      const label = [t.lang, t.title].filter(Boolean).join(' — ') || `Track ${t.id}`;
      sHtml += `<div class="track-menu-item" data-sid="${t.id}"
        onclick="Player.setSub(${t.id})">
        <span>${esc(label)}</span><span class="check">✓</span></div>`;
    });
    subMenu.innerHTML = sHtml;

    // Show/hide track buttons
    $('audio-track-btn').style.display = audioTracks.length > 1 ? '' : 'none';
    $('sub-track-btn').style.display   = subTracks.length       ? '' : 'none';
  }

  function _markActiveTrack(menuId, attr, val) {
    document.querySelectorAll(`#${menuId} .track-menu-item`).forEach(el => {
      el.classList.toggle('active', el.dataset[attr] == val);
    });
  }

  // ── Stream info overlay ──────────────────────────────────────────────────────
  async function _refreshStreamInfo() {
    try {
      const [vp, ap] = await Promise.all([
        api.mpvGetProperty('video-params'),
        api.mpvGetProperty('audio-params'),
      ]);
      if (vp?.value) {
        $('si-res').textContent   = `${vp.value.w}×${vp.value.h}`;
        $('si-codec').textContent = vp.value.pixelformat || '—';
        $('si-fps').textContent   = vp.value['average-fps']
          ? parseFloat(vp.value['average-fps']).toFixed(2) + ' fps' : '—';
      }
      if (ap?.value) {
        $('si-audio').textContent = ap.value.format || '—';
      }
    } catch (_) {}
  }

  // ── History timer ────────────────────────────────────────────────────────────
  function _startHistTimer() {
    clearInterval(_histTimer);
    _histTimer = setInterval(async () => {
      if (!S.current || _isLive || _paused) return;
      const pos = await api.mpvGetProperty('time-pos');
      const dur = await api.mpvGetProperty('duration');
      if (pos?.value > 5) {
        saveToHistory(
          S.current.url, S.current.name, S.current.type,
          S.current.poster, S.current.subtitle,
          pos.value, dur?.value || 0
        );
      }
    }, 10000);
  }

  function _stopHistTimer() { clearInterval(_histTimer); }

  // ── Resize observer — keeps host window aligned ──────────────────────────
  let _resizeObs = null;
  let _resizeRAF = null;
  let _resizeCleanup = null;
  let _resizeTimeout = null;
  let _lastBounds = null;
  let _unsubWinMoved = null;

  function _startResizeObserver() {
    if (_resizeObs) return;
    const container = $('mpv-container');

    async function sync() {
      // Debounce: wait for resize to settle
      clearTimeout(_resizeTimeout);
      _resizeTimeout = setTimeout(async () => {
        cancelAnimationFrame(_resizeRAF);
        _resizeRAF = requestAnimationFrame(async () => {
          const bounds = await _getScreenBounds();
          
          // Only update if bounds changed significantly
          if (_lastBounds) {
            const dx = Math.abs(bounds.x - _lastBounds.x);
            const dy = Math.abs(bounds.y - _lastBounds.y);
            const dw = Math.abs(bounds.w - _lastBounds.w);
            const dh = Math.abs(bounds.h - _lastBounds.h);
            
            // Only update if change > 5 pixels
            if (dx > 5 || dy > 5 || dw > 5 || dh > 5) {
              console.log('[Player] Resize threshold met, updating mpv');
              api.mpvResize(bounds);
              _lastBounds = bounds;
            }
          } else {
            // First update
            api.mpvResize(bounds);
            _lastBounds = bounds;
          }
        });
      }, 150); // Wait 150ms after last resize event
    }

    _resizeObs = new ResizeObserver(sync);
    _resizeObs.observe(container);

    window.addEventListener('resize', sync);

    // Main window moved (sent by main process on move/resize events)
    _unsubWinMoved = api.onWinMoved(() => {
      // Reset last bounds on window move
      _lastBounds = null;
      sync();
    });

    _resizeCleanup = () => {
      if (_resizeObs) {
        _resizeObs.disconnect();
        _resizeObs = null;
      }
      window.removeEventListener('resize', sync);
      clearTimeout(_resizeTimeout);
      if (_unsubWinMoved) {
        _unsubWinMoved();
        _unsubWinMoved = null;
      }
      _lastBounds = null;
    };
  }

  function _stopResizeObserver() {
    if (_resizeCleanup) { 
      _resizeCleanup(); 
      _resizeCleanup = null; 
    }
  }

  /**
   * Get screen bounds for mpv window.
   * Calculates the exact player container area excluding sidebar and topbar.
   */
  async function _getScreenBounds() {
    // Get main window info from Electron
    const info = await api.getScreenInfo(); // { winX, winY, winW, winH, scaleFactor }
    
    // Get sidebar width - use offsetWidth for actual rendered width
    const sidebar = document.getElementById('sidebar');
    const sidebarWidth = sidebar ? sidebar.offsetWidth : 220; // var(--nav-w) from CSS
    
    // Get topbar height
    const topbar = document.getElementById('topbar');
    const topbarHeight = topbar ? topbar.offsetHeight : 52; // var(--topbar-h) from CSS
    
    // Get player container element for additional safety
    const container = $('mpv-container');
    const containerRect = container ? container.getBoundingClientRect() : null;
    
    // Calculate player container position and size
    // Use container rect if available (more accurate), otherwise calculate from window + offsets
    let x, y, w, h;
    
    if (containerRect && containerRect.width > 0) {
      // We have the actual container dimensions - use those relative to window
      x = Math.round(info.winX + (containerRect.left * info.scaleFactor));
      y = Math.round(info.winY + (containerRect.top * info.scaleFactor));
      w = Math.round(containerRect.width * info.scaleFactor);
      h = Math.round(containerRect.height * info.scaleFactor);
    } else {
      // Fallback: calculate from window bounds minus sidebar/topbar
      x = Math.round(info.winX + (sidebarWidth * info.scaleFactor));
      y = Math.round(info.winY + (topbarHeight * info.scaleFactor));
      w = Math.round((info.winW - sidebarWidth) * info.scaleFactor);
      h = Math.round((info.winH - topbarHeight) * info.scaleFactor);
    }
    
    // Ensure minimum dimensions
    w = Math.max(320, w);
    h = Math.max(180, h);
    
    console.log('[Player] Container bounds:', { 
      x, y, w, h, 
      sidebarWidth, 
      topbarHeight, 
      scale: info.scaleFactor,
      winX: info.winX,
      winY: info.winY
    });
    
    return { x, y, w, h };
  }

  // ── Live TV: EPG labels ──────────────────────────────────────────────────────
  function _setLiveEPG(ch) {
    const epg = getEPG(ch.tvgId || ch.name);
    $('live-now-epg').textContent  = epg.now  ? `▶ ${epg.now.title}`  : '';
    $('live-next-epg').textContent = epg.next ? `Next: ${epg.next.title}` : '';
  }

  // ── Subscribe to all mpv events ──────────────────────────────────────────────
  function _bindEvents() {
    // Unsubscribe any previous listeners first
    _unsubs.forEach(fn => {
      if (typeof fn === 'function') fn();
    });
    _unsubs = [];

    _unsubs.push(api.onMpvSocketReady(() => {
      _ready = true;
      // Observe the properties we need
      api.mpvObserve('time-pos');
      api.mpvObserve('duration');
      api.mpvObserve('pause');
      api.mpvObserve('mute');
      api.mpvObserve('volume');
      api.mpvObserve('demuxer-cache-state');
      api.mpvObserve('demuxer-cache-duration');  // for health indicator
    }));

    _unsubs.push(api.onMpvProperty(({ name, data }) => {
      if (name === 'time-pos' && data != null) {
        _updateSeek(data);
      }
      if (name === 'duration' && data != null) {
        _updateDuration(data);
      }
      if (name === 'pause') {
        _updatePlayBtn(!!data);
      }
      if (name === 'mute') {
        _muted = !!data;
        _updateVolIcon();
      }
      if (name === 'volume' && data != null) {
        _setVolume(data, false);
      }
      if (name === 'demuxer-cache-state' && data) {
        // Update buffer bar
        const ranges = data['seekable-ranges'];
        if (ranges?.length && _duration) {
          const end = ranges[ranges.length - 1].end;
          $('seek-buffered').style.width = Math.min(100, (end / _duration) * 100) + '%';
        }
      }
      if (name === 'demuxer-cache-duration' && data != null) {
        // Stream health indicator: green >8s, yellow 2-8s, red <2s
        const dot = $('stream-health-dot');
        if (dot) {
          if (data > 8)      { dot.style.background = 'var(--green)'; dot.title = `Buffer: ${data.toFixed(1)}s`; }
          else if (data > 2) { dot.style.background = 'var(--yellow)'; dot.title = `Low buffer: ${data.toFixed(1)}s`; }
          else               { dot.style.background = 'var(--red)'; dot.title = `Critical buffer: ${data.toFixed(1)}s`; }
        }
      }
    }));

    _unsubs.push(api.onMpvFileLoaded(() => {
      _loaded = true;
      _setLoading(false);
      _clearError();
      _startHistTimer();
      if (_openStartedAt) {
        perfLog('channel-switch', {
          ms: performance.now() - _openStartedAt,
          url: _retryUrl || S.current?.url || null,
          type: S.current?.type || null,
        });
        _openStartedAt = 0;
      }
      // Fetch track list and stream info after load
      setTimeout(async () => {
        const t = await api.mpvGetTracks();
        if (t.ok && t.tracks) _populateTracks(t.tracks);
        await _refreshStreamInfo();

        // Now save history with real duration (fix: was saved with duration=0 before)
        if (S.current) {
          const durRes = await api.mpvGetProperty('duration');
          const realDur = durRes?.value || 0;
          saveToHistory(
            S.current.url, S.current.name, S.current.type,
            S.current.poster, S.current.subtitle,
            _isLive ? 0 : 0,  // pos starts at 0, hist timer will update
            realDur
          );
        }

        // Show resume toast if user is resuming from a saved position
        if (!_isLive && S.current) {
          const hist = S.history.find(h => h.id === `${S.current.type}:${S.current.name}`);
          if (hist?.pos > 60) {
            // Toast already handled by startPos being passed to open(), just confirm
          }
        }
      }, 800);
    }));

    _unsubs.push(api.onMpvEndFile(({ reason }) => {
      _stopHistTimer();
      _setLoading(false);
      if (reason === 'error') {
        _setError('Stream ended with an error. Check the URL or try another source.');
      } else if (reason === 'eof' && !_isLive && S.current) {
        // VOD finished — show play-next prompt if there's a next episode
        _showNextEpisodePrompt();
      }
    }));

    _unsubs.push(api.onMpvPlaybackRestart(() => {
      _setLoading(false);
    }));

    _unsubs.push(api.onMpvNotFound(() => {
      _setLoading(false);
      document.getElementById('mpv-missing-modal').classList.add('open');
    }));

    _unsubs.push(api.onMpvRestarting(({ attempt }) => {
      _setLoading(true, 'Reconnecting…', `Attempt ${attempt}/3`);
    }));

    _unsubs.push(api.onMpvFallbackVlc(() => {
      _setLoading(false);
      toast('mpv crashed — falling back to VLC', 'error');
      if (_retryUrl && S.current) {
        vlcDirect(_retryUrl, S.current.name);
      }
    }));

    _unsubs.push(api.onMpvExited(({ code }) => {
      if (code === 0) return;  // clean exit
      _setLoading(true, 'Player restarting…', '');
    }));

    _unsubs.push(api.onMpvSocketError(({ message }) => {
      console.warn('[mpv socket]', message);
    }));
  

    // Listen for window movement from main process
    _unsubs.push(api.onWinMoved(() => {
      // Reset bounds cache on window move
      _lastBounds = null;
      // Trigger a reposition if player is open
      if (_ready && Player.isOpen) {
        _getScreenBounds().then(bounds => {
          api.mpvResize(bounds);
          _lastBounds = bounds;
        });
      }
    }));
  }

  // ── Public API ───────────────────────────────────────────────────────────────
    async function open(url, name, subtitle, type, poster, startPos = 0) {
    _retryUrl = url;
    _isLive   = type === 'live';
    _loaded   = false;
    _duration = 0;

    // Reset bounds tracking
    if (_resizeTimeout) clearTimeout(_resizeTimeout);
    _lastBounds = null;

    // Perf: mark start of open -> first frame
    _openStartedAt = performance.now();

    // Show player page
    pp.classList.add('active');
    _clearError();
    _setLoading(true, `Loading ${name}`, subtitle || '');
    _showControls();
    
    // Update header
    $('player-now-title').textContent = name;
    $('player-now-sub').textContent   = subtitle || (type === 'live' ? 'Live TV' : '');

    // Toggle seek vs live row
    $('seek-row').classList.toggle('hidden', _isLive);
    $('live-row').classList.toggle('hidden', !_isLive);

    // VOD controls
    $('rewind-btn').style.display = _isLive ? 'none' : '';
    $('ffwd-btn').style.display   = _isLive ? 'none' : '';

    // Reset seek bar
    $('seek-fill').style.width  = startPos && !_isLive ? '' : '0%';
    $('seek-thumb').style.left  = '0%';
    $('seek-buffered').style.width = '0%';
    $('time-current').textContent  = _fmt(startPos);
    $('time-total').textContent    = '0:00';
    $('audio-track-btn').style.display = 'none';
    $('sub-track-btn').style.display   = 'none';

    // Set volume from settings
    _setVolume(S.settings.defaultVolume || 85, false);

    // Update EPG for live
    if (_isLive) {
      const ch = S.channels.find(c => c.url === url);
      if (ch) _setLiveEPG(ch);
    }

    // Compute real screen-pixel bounds for mpv's --geometry / IPC reposition
    const bounds = await _getScreenBounds();

    // Start mpv if not already running
    if (!_ready) {
      const started = await api.mpvStart(url, bounds);
      if (!started.ok) {
        _setError('Failed to start mpv. ' + (started.error || ''));
        return;
      }
      try {
        await _waitReady();
      } catch (err) {
        console.error('[Player] Socket timeout:', err.message);
        _setError('mpv started but socket timed out. Try again or use VLC.');
        return;
      }
    } else {
      // Already running — load new file, reposition window
      await api.mpvResize(bounds);
      await api.mpvLoadfile(url, 'replace');
    }

    // Start observing resize/move events
    _startResizeObserver();

    // Set initial volume
    api.mpvSetProperty('volume', _volume);

    // Seek to resume position
    if (startPos > 10 && !_isLive) {
      // Wait for file-loaded before seeking
      const unsub = api.onMpvFileLoaded(async () => {
        unsub();
        await api.mpvSeek(startPos, 'absolute');
      });
    }
    
    // Double-check positioning after a short delay
    setTimeout(async () => {
      if (Player.isOpen) {
        const bounds = await _getScreenBounds();
        api.mpvResize(bounds);
        _lastBounds = bounds;
      }
    }, 500);
  }
  function _waitReady(timeout = 8000) {
    return new Promise((resolve, reject) => {
      if (_ready) { resolve(); return; }
      const unsub = api.onMpvSocketReady(() => { 
        if (unsub && typeof unsub === 'function') unsub(); 
        resolve(); 
      });
      setTimeout(() => { 
        if (!_ready) { 
          if (unsub && typeof unsub === 'function') unsub(); 
          reject(new Error('mpv socket timeout')); 
        } 
      }, timeout);
    });
  }

   async function close() {
    _stopHistTimer();
    _stopResizeObserver();  // Make sure this line is present
    _unsubs.forEach(fn => {
      if (typeof fn === 'function') fn();
    });
    _unsubs = [];
    _ready  = false;
    _loaded = false;

    // Save final position
    if (S.current && !_isLive) {
      const pos = await api.mpvGetProperty('time-pos');
      const dur = await api.mpvGetProperty('duration');
      if (pos?.value > 5) {
        saveToHistory(
          S.current.url, S.current.name, S.current.type,
          S.current.poster, S.current.subtitle,
          pos.value, dur?.value || 0
        );
      }
    }

    await api.mpvQuit();
    // Note: mpvHide is intentionally NOT called here — the socket is already dead after quit
    pp.classList.remove('active');
    _setLoading(false);
    _clearError();
    $('stream-info').classList.remove('visible');

    // Refresh home continue watching row
    if (document.getElementById('page-home').classList.contains('active')) renderHome();
  }

  // Public control methods
  function togglePause()  { api.mpvTogglePause(); }
  function seek(delta)    { api.mpvSeek(delta, 'relative'); }
  function toggleMute()   { api.mpvToggleMute(); }
  function volumeUp()     { _setVolume(_volume + 5, true); }
  function volumeDown()   { _setVolume(_volume - 5, true); }

  function setAudio(id) {
    api.mpvSetAudioTrack(id);
    _markActiveTrack('audio-track-menu', 'aid', id);
    $('audio-track-menu').classList.remove('open');
  }
  function setSub(id) {
    api.mpvSetSubtitleTrack(id);
    _markActiveTrack('sub-track-menu', 'sid', id);
    $('sub-track-menu').classList.remove('open');
  }

  function toggleInfo() {
    const el = $('stream-info');
    const on = el.classList.toggle('visible');
    if (on) _refreshStreamInfo();
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else pp.requestFullscreen?.();
  }

  function prevChannel() {
    if (!S.current) return;
    const idx = S.channels.findIndex(c => c.url === S.current?.url);
    if (idx > 0) {
      const ch = S.channels[idx - 1];
      playItem(eu(ch.url), eu(ch.name), 'Live TV', 'live', eu(ch.logo || ''));
    }
  }

  function nextChannel() {
    if (!S.current) return;
    const idx = S.channels.findIndex(c => c.url === S.current?.url);
    if (idx < S.channels.length - 1) {
      const ch = S.channels[idx + 1];
      playItem(eu(ch.url), eu(ch.name), 'Live TV', 'live', eu(ch.logo || ''));
    }
  }

  // Prev/next episode for VOD
  function prevEpisode() { /* handled by series browser */ }
  function nextEpisode() { /* handled by series browser */ }

  // ── Init: bind DOM events once ───────────────────────────────────────────────
  function init() {
    _bindEvents();
    _initSeekBar();
    _initVolumeBar();

    // Mouse move shows controls
    $('mpv-container').addEventListener('mousemove', _showControls);
    $('mpv-container').addEventListener('click', () => {
      if (!$('player-controls').classList.contains('visible')) {
        _showControls();
      }
    });

    // Buttons
    $('play-pause-btn').addEventListener('click',  togglePause);
    $('mute-btn').addEventListener('click',        toggleMute);
    $('rewind-btn').addEventListener('click',      () => seek(-10));
    $('ffwd-btn').addEventListener('click',        () => seek(10));
    $('fullscreen-btn').addEventListener('click',  toggleFullscreen);
    $('stream-info-btn').addEventListener('click', toggleInfo);
    $('player-back-btn').addEventListener('click', close);
    $('prev-btn').addEventListener('click', () => _isLive ? prevChannel() : prevEpisode());
    $('next-btn').addEventListener('click', () => _isLive ? nextChannel() : nextEpisode());

    // Error action buttons
    $('error-retry-btn').addEventListener('click', () => {
      if (_retryUrl && S.current) {
        _clearError();
        _setLoading(true, 'Retrying…', '');
        api.mpvLoadfile(_retryUrl, 'replace');
      }
    });
    $('error-vlc-btn').addEventListener('click', () => {
      if (_retryUrl && S.current) vlcDirect(_retryUrl, S.current.name);
    });
    $('error-back-btn').addEventListener('click', close);

    // Track selector toggle
    $('audio-track-btn').addEventListener('click', e => {
      e.stopPropagation();
      $('audio-track-menu').classList.toggle('open');
      $('sub-track-menu').classList.remove('open');
    });
    $('sub-track-btn').addEventListener('click', e => {
      e.stopPropagation();
      $('sub-track-menu').classList.toggle('open');
      $('audio-track-menu').classList.remove('open');
    });

    // Close track menus on outside click
    document.addEventListener('click', () => {
      $('audio-track-menu').classList.remove('open');
      $('sub-track-menu').classList.remove('open');
    });

    // mpv missing modal buttons
    $('modal-vlc-fallback-btn').addEventListener('click', () => {
      S.settings.defaultPlayer = 'vlc';
      saveSetting('defaultPlayer', 'vlc');
      document.getElementById('mpv-missing-modal').classList.remove('open');
      if (_retryUrl && S.current) vlcDirect(_retryUrl, S.current.name);
      close();
    });
    $('modal-retry-mpv-btn').addEventListener('click', async () => {
      document.getElementById('mpv-missing-modal').classList.remove('open');
      const path = await api.mpvDetect();
      if (path) {
        toast('mpv found: ' + path, 'success');
        if (_retryUrl && S.current) {
          open(_retryUrl, S.current.name, S.current.subtitle, S.current.type, S.current.poster);
        }
      } else {
        toast('mpv still not found', 'error');
        document.getElementById('mpv-missing-modal').classList.add('open');
      }
    });
    $('modal-dismiss-btn').addEventListener('click', () => {
      document.getElementById('mpv-missing-modal').classList.remove('open');
    });

    // Shortcuts modal
    $('shortcuts-btn').addEventListener('click', () => {
      document.getElementById('shortcuts-modal').classList.add('open');
    });
    $('shortcuts-close-btn').addEventListener('click', () => {
      document.getElementById('shortcuts-modal').classList.remove('open');
    });

    // Detail panel close
    $('detail-backdrop').addEventListener('click', closeDetail);
    $('detail-close-btn').addEventListener('click', closeDetail);
  }

  // ── Next episode prompt ──────────────────────────────────────────────────────
  function _showNextEpisodePrompt() {
    const el = $('next-episode-prompt');
    if (!el || !S.current) return;
    // Only makes sense if we can figure out the series context
    // For now, show a generic "Finished" prompt with back button
    el.classList.add('visible');
    let countdown = 8;
    const countEl = $('next-ep-countdown');
    if (countEl) countEl.textContent = countdown;
    const timer = setInterval(() => {
      countdown--;
      if (countEl) countEl.textContent = countdown;
      if (countdown <= 0) {
        clearInterval(timer);
        el.classList.remove('visible');
      }
    }, 1000);
    el._clearTimer = () => { clearInterval(timer); el.classList.remove('visible'); };
  }

  function screenshot() {
    api.mpvScreenshot().then(() => toast('Screenshot saved 📷', 'success', 2500));
  }

  return {
    init, open, close,
    togglePause, seek, toggleMute, volumeUp, volumeDown,
    setAudio, setSub, toggleInfo, toggleFullscreen, screenshot,
    prevChannel, nextChannel,
    get isOpen() { return pp.classList.contains('active'); },
  };
})();

// ═════════════════════════════════════════════════════════════════════════════
// VLC STATUS CHECK (module-level, not inside Player IIFE)
// ═════════════════════════════════════════════════════════════════════════════
async function checkVLCStatus() {
  const statusEl = document.getElementById('vlc-status');
  if (!statusEl) return;

  statusEl.textContent = 'Checking for VLC...';
  statusEl.style.color = 'var(--text-3)';

  try {
    const result = await api.vlcCheck();
    if (result.found) {
      S.vlcFound = true;
      const pathDisplay = result.path.length > 40 ? '…' + result.path.substr(-40) : result.path;
      statusEl.textContent = `VLC found: ${pathDisplay}`;
      statusEl.style.color = 'var(--green)';
      if (S.settings.preferredPlayer === 'vlc') {
        toast('VLC detected and ready!', 'success', 3000);
      }
    } else {
      S.vlcFound = false;
      statusEl.textContent = 'VLC not found. Download from videolan.org';
      statusEl.style.color = 'var(--red)';
      if (S.settings.preferredPlayer === 'vlc') {
        toast('VLC not found! Please install VLC or switch to mpv.', 'warning', 5000);
      }
    }
  } catch (err) {
    S.vlcFound = false;
    statusEl.textContent = 'Error checking VLC';
    statusEl.style.color = 'var(--red)';
    console.error('VLC check error:', err);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// BOOT
// ═════════════════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  const t0 = performance.now();
  setupNav();
  setupSearch();
  setupViewToggles();
  setupGlobalSearch();   // new: unified search from Home
  setupSortButtons();    // new: A-Z / Rating / Year sort
  setupSleepTimer();     // new: sleep timer in player topbar
  setupNextEpPrompt();   // new: play-next-episode prompt
  Player.init();
  await bootApp();
  const t1 = performance.now();
  perfLog('startup:bootApp', {
    ms: t1 - t0,
    channels: S.channels.length,
    movies: S.movies.length,
    series: S.series.length,
  });
  checkVLCStatus();
  detectMpv();
  setupBgRefresh();
});

async function bootApp() {
  const [src, channels, movies, series, cats, favs, history, settings, epg] =
    await Promise.all([
      DB.getMeta('source'),
      DB.getData('channels'),
      DB.getData('movies'),
      DB.getData('series'),
      DB.getCats(),
      DB.getFavs(),
      DB.getHistory(),
      DB.getMeta('settings'),
      DB.getMeta('epg'),
    ]);

  if (src)      S.source   = src;
  if (channels) S.channels = channels;
  if (movies)   S.movies   = movies;
  if (series)   S.series   = series;
  if (cats)     S.cats     = cats;
  if (favs)     S.favs     = favs;
  if (history)  S.history  = history;
  if (settings) S.settings = { ...S.settings, ...settings };
  if (epg)      S.epg      = epg;

  if (S.source) {
    updateSrcIndicator(true, srcLabel());
    setBadge(S.channels.length);
    renderHome();
    const age = await DB.getCacheAge();
    if (age > CACHE_MAX_MS) bgRefresh();
    else schedulePreload();
  } else {
    showWelcome();
  }

  applySettings();
  loadEPGUrl();
}

// ═════════════════════════════════════════════════════════════════════════════
// NAVIGATION
// ═════════════════════════════════════════════════════════════════════════════
function setupNav() {
  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    el.addEventListener('click', () => navigateTo(el.dataset.page));
  });

  document.getElementById('refresh-btn').addEventListener('click', manualRefresh);
}

function navigateTo(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const pageEl = document.getElementById(`page-${page}`);
  pageEl?.classList.add('active');
  document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');

  const title = pageEl?.dataset.title || page;
  document.getElementById('topbar-title').textContent = title;

  if (page === 'live')      renderLive();
  if (page === 'movies')    renderMovies();
  if (page === 'series')    renderSeries();
  if (page === 'favorites') renderFavorites();
  if (page === 'settings')  renderSettings();
}

// ═════════════════════════════════════════════════════════════════════════════
// SEARCH
// ═════════════════════════════════════════════════════════════════════════════
function setupSearch() {
  const input = document.getElementById('search-input');
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const q = input.value.trim();
      const activePage = document.querySelector('.page.active')?.id?.replace('page-', '');
      if (activePage && ['live','movies','series'].includes(activePage)) {
        S.search[activePage] = q;
        S.page[activePage]   = 0;
        if (activePage === 'live')   renderLive();
        if (activePage === 'movies') renderMovies();
        if (activePage === 'series') renderSeries();
      }
    }, 280);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// VIEW TOGGLES
// ═════════════════════════════════════════════════════════════════════════════
function setupViewToggles() {
  document.getElementById('grid-view-btn').addEventListener('click', () => setGlobalView('grid'));
  document.getElementById('list-view-btn').addEventListener('click', () => setGlobalView('list'));
}

function setGlobalView(view) {
  document.getElementById('grid-view-btn').classList.toggle('active', view === 'grid');
  document.getElementById('list-view-btn').classList.toggle('active', view === 'list');
  const activePage = document.querySelector('.page.active')?.id?.replace('page-', '');
  if (activePage && S.view[activePage] !== undefined) {
    S.view[activePage] = view;
    if (activePage === 'live')   renderLive();
    if (activePage === 'movies') renderMovies();
    if (activePage === 'series') renderSeries();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// PLAY ITEM — central entry point
// ═════════════════════════════════════════════════════════════════════════════
function playItem(encodedUrl, encodedName, subtitle, type, encodedPoster = '', startPos = 0) {
  const url    = decodeURIComponent(encodedUrl);
  const name   = decodeURIComponent(encodedName);
  const poster = decodeURIComponent(encodedPoster);

  // Check player preference
  const preferredPlayer = S.settings.preferredPlayer || 'mpv';
  
  if (preferredPlayer === 'vlc') {
    if (S.vlcFound) {
      vlcDirect(url, name);
      return;
    } else {
      toast('VLC not found. Using mpv instead.', 'warning', 4000);
      // Fall back to mpv
    }
  }

  // Use mpv (default)
  S.current = { url, name, type, poster, subtitle };
  // NOTE: History is saved after file-loaded fires (with real duration), not here.
  // For resume, we still need to pass startPos through to Player.open.
  Player.open(url, name, subtitle, type, poster, startPos);
}
// ════════════════════════════════════════════════════════════════════════════
// VLC
// ═════════════════════════════════════════════════════════════════════════════

async function vlcItem(encodedUrl, encodedName) {
  vlcDirect(decodeURIComponent(encodedUrl), decodeURIComponent(encodedName));
}

async function vlcDirect(url, name) {
  const r = await api.vlcOpen(url);
  if (r.ok) toast(`Opened in VLC 🎬`, 'success');
  else toast(r.error || 'VLC not found. Install from videolan.org', 'error', 5000);
}

// ═════════════════════════════════════════════════════════════════════════════
// MPV DETECT (settings page)
// ═════════════════════════════════════════════════════════════════════════════
async function detectMpv() {
  const path = await api.mpvDetect();
  const el = document.getElementById('mpv-detected-path');
  if (el) el.textContent = path ? `Found: ${path}` : 'Not found — install mpv';
}

// ═════════════════════════════════════════════════════════════════════════════
// HISTORY
// ═════════════════════════════════════════════════════════════════════════════
async function saveToHistory(url, name, type, poster, subtitle, pos, duration) {
  const entry = {
    id: `${type}:${name}`,
    name, type, url,
    poster:   poster   || '',
    subtitle: subtitle || '',
    pos:      pos      || 0,
    duration: duration || 0,
    ts: Date.now(),
  };
  await DB.saveHistoryItem(entry);
  const idx = S.history.findIndex(h => h.id === entry.id);
  if (idx > -1) S.history.splice(idx, 1);
  S.history.unshift(entry);

  // Trim history to max 200 items to avoid unbounded growth
  if (S.history.length > 200) {
    const removed = S.history.splice(200);
    for (const old of removed) {
      await DB.removeHistoryItem(old.id).catch(() => {});
    }
  }
}

async function resumeItem(encodedId) {
  const id   = decodeURIComponent(encodedId);
  const item = S.history.find(h => h.id === id);
  if (!item) return;
  playItem(eu(item.url), eu(item.name), item.subtitle || '', item.type, item.poster, item.pos);
}

async function clearHistoryUI() {
  if (!confirm('Clear continue watching history?')) return;
  await DB.clearHistory();
  S.history = [];
  renderHome();
}

function getContinueWatching() {
  return S.history
    .filter(h => {
      if (h.type === 'live') return true;
      if (!h.duration || h.duration < 60) return false;
      const pct = h.pos / h.duration;
      return pct > 0.02 && pct < 0.95;
    })
    .slice(0, 12);
}

// ═════════════════════════════════════════════════════════════════════════════
// DETAIL PANEL
// ═════════════════════════════════════════════════════════════════════════════
let _detailItem = null;

function openDetail(item, type) {
  _detailItem = { item, type };

  const heroImg = document.getElementById('detail-hero-img');
  const heroPlh = document.getElementById('detail-hero-placeholder');
  if (item.logo) {
    heroImg.src = item.logo;
    heroImg.style.display = '';
    heroPlh.style.display = 'none';
    heroImg.onerror = () => { heroImg.style.display = 'none'; heroPlh.style.display = ''; };
  } else {
    heroImg.style.display = 'none';
    heroPlh.style.display = '';
  }

  document.getElementById('detail-title').textContent = item.name;

  // Meta pills
  const meta = [];
  if (item.year)   meta.push(`<span class="pill">${item.year}</span>`);
  if (item.rating) meta.push(`<span class="pill">⭐ ${parseFloat(item.rating).toFixed(1)}</span>`);
  if (type === 'live') meta.push(`<span class="pill">Live TV</span>`);
  document.getElementById('detail-meta').innerHTML = meta.join('');

  const desc = document.getElementById('detail-desc');
  desc.textContent = item.plot || item.description || '';
  desc.classList.remove('expanded');

  const descToggle = document.getElementById('detail-desc-toggle');
  descToggle.style.display = (item.plot || '').length > 160 ? '' : 'none';
  descToggle.textContent = 'Show more';
  descToggle.onclick = () => {
    desc.classList.toggle('expanded');
    descToggle.textContent = desc.classList.contains('expanded') ? 'Show less' : 'Show more';
  };

  // Resume button
  const hist   = S.history.find(h => h.id === `${type}:${item.name}`);
  const resume = hist?.pos > 60 ? hist.pos : 0;
  const resumeBtn = document.getElementById('detail-resume-btn');
  resumeBtn.classList.toggle('hidden', !resume);
  resumeBtn.onclick = () => {
    closeDetail();
    playItem(eu(item.url || ''), eu(item.name), '', type, eu(item.logo || ''), resume);
  };

  // Play button
  document.getElementById('detail-play-btn').onclick = () => {
    closeDetail();
    if (type === 'series') {
      openSeriesBrowser(item.streamId, eu(item.name), eu(item.logo || ''), eu(item.plot || ''));
    } else {
      playItem(eu(item.url || ''), eu(item.name), '', type, eu(item.logo || ''));
    }
  };

  // Fav button
  const favKey = `${type}:${item.name}`;
  const favBtn = document.getElementById('detail-fav-btn');
  favBtn.textContent = S.favs.has(favKey) ? '★ Favorited' : '☆ Favorite';
  favBtn.onclick = async () => {
    await toggleFav(type, eu(item.name));
    favBtn.textContent = S.favs.has(favKey) ? '★ Favorited' : '☆ Favorite';
  };

  // VLC button
  document.getElementById('detail-vlc-btn').onclick = () => {
    if (item.url) vlcDirect(item.url, item.name);
  };
  document.getElementById('detail-vlc-btn').style.display = item.url ? '' : 'none';

  // Episode browser
  const epBrowser = document.getElementById('episode-browser');
  epBrowser.style.display = type === 'series' ? '' : 'none';
  if (type === 'series' && S.source?.type === 'xtream') {
    loadSeriesEpisodes(item);
  }

  document.getElementById('detail-panel').classList.add('open');
  document.getElementById('detail-backdrop').classList.add('open');
}

function closeDetail() {
  document.getElementById('detail-panel').classList.remove('open');
  document.getElementById('detail-backdrop').classList.remove('open');
  _detailItem = null;
}

async function loadSeriesEpisodes(item) {
  const epList = document.getElementById('episode-list');
  const seaTabs = document.getElementById('season-tabs');
  epList.innerHTML = `<div class="empty-state"><div class="player-spinner"></div></div>`;
  seaTabs.innerHTML = '';

  try {
    const data    = await xtFetch('get_series_info', `&series_id=${item.streamId}`);
    const episodes = data.episodes || {};
    const seasons  = Object.keys(episodes).sort((a,b) => +a - +b);

    if (!seasons.length) {
      epList.innerHTML = `<div class="empty-state"><div class="empty-icon">📽</div>
        <div class="empty-title">No episodes found</div></div>`;
      return;
    }

    // Season tabs
    let activeSeason = seasons[0];
    seaTabs.innerHTML = seasons.map(s => `
      <button class="season-tab${s === activeSeason ? ' active' : ''}"
        data-season="${s}" onclick="switchSeason('${s}')">S${s}</button>
    `).join('');

    function renderSeason(season) {
      const eps = episodes[season];
      epList.innerHTML = eps.map(ep => {
        const epUrl  = xtUrl('series', ep.id, ep.container_extension || 'mp4');
        const epName = ep.title || `Episode ${ep.episode_num}`;
        const thumb  = ep.info?.movie_image || '';
        const sub    = `${item.name} · S${ep.season}E${ep.episode_num}`;
        const hist   = S.history.find(h => h.id === `vod:${epName}`);
        const resume = hist?.pos > 60 ? hist.pos : 0;
        const pct    = (resume && hist?.duration) ? Math.min(95, (resume / hist.duration) * 100) : 0;

        return `
          <div class="episode-item" onclick="closeDetail();playItem('${eu(epUrl)}','${eu(epName)}','${eu(sub)}','vod','${eu(thumb)}',${resume})">
            ${thumb
              ? `<img class="episode-thumb" src="${esc(thumb)}" loading="lazy"
                  onerror="this.style.display='none'">`
              : `<div class="episode-thumb" style="display:flex;align-items:center;justify-content:center;color:var(--text-3);">▶</div>`}
            <div class="episode-num">E${ep.episode_num}</div>
            <div class="episode-info">
              <div class="episode-title">${esc(epName)}</div>
              <div class="episode-meta">${ep.info?.duration ? `${ep.info.duration}` : ''}</div>
            </div>
            ${pct > 2 ? `
              <div class="episode-progress-bar">
                <div class="episode-progress-fill" style="width:${pct}%"></div>
              </div>` : ''}
          </div>`;
      }).join('');
    }

    window.switchSeason = (season) => {
      activeSeason = season;
      document.querySelectorAll('#season-tabs .season-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.season === season);
      });
      renderSeason(season);
    };

    renderSeason(activeSeason);
  } catch (e) {
    epList.innerHTML = `<div class="empty-state text-dim">${esc(e.message)}</div>`;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// RENDER FUNCTIONS (carried from Phase 1, updated for new HTML)
// ═════════════════════════════════════════════════════════════════════════════

function renderHome() {
  if (!S.source) { showWelcome(); return; }

  // Continue watching
  const cw = getContinueWatching();
  const cwSection = document.getElementById('continue-watching-section');
  const cwRow     = document.getElementById('continue-row');
  if (cw.length) {
    cwSection.style.display = '';
    cwRow.innerHTML = cw.map(cwCard).join('');
  } else {
    cwSection.style.display = 'none';
  }

  // Home grids: first 8 live, first 6 movies
  document.getElementById('home-live-grid').innerHTML =
    S.channels.slice(0,8).map(c => liveCard(c)).join('') || '';
  document.getElementById('home-movies-grid').innerHTML =
    S.movies.slice(0,6).map(m => mediaCard(m,'vod')).join('') || '';
}

function showWelcome() {
  document.getElementById('continue-watching-section').style.display = 'none';
  document.getElementById('home-live-grid').innerHTML = `
    <div class="empty-state" style="grid-column:1/-1">
      <div class="empty-icon">📺</div>
      <div class="empty-title">No source connected</div>
      <div class="empty-sub">Go to Settings to add your IPTV source.</div>
      <button class="btn btn-primary" style="margin-top:12px" onclick="navigateTo('settings')">Connect Source</button>
    </div>`;
  document.getElementById('home-movies-grid').innerHTML = '';
}

function renderLive() {
  const t0    = performance.now();
  const cat    = S.activeCat.live;
  const search = S.search.live;
  const groups = [...new Set(S.channels.map(c => c.group).filter(Boolean))];

  document.getElementById('live-cat-tabs').innerHTML =
    ['all', ...groups.slice(0,80)].map(c => `
      <button class="cat-tab${c === cat ? ' active' : ''}"
        onclick="setCat('live','${ea(c)}')">${c === 'all' ? 'All' : esc(catName(c,'live') || String(c))}</button>
    `).join('');

  const filtered = getFiltered(S.channels, cat, search);
  const pg       = S.page.live;
  const slice    = filtered.slice(pg * PS, (pg + 1) * PS);
  const isGrid   = S.view.live !== 'list';

  const liveGrid = document.getElementById('live-grid');
  const liveList = document.getElementById('live-list');
  liveGrid.classList.toggle('hidden', !isGrid);
  liveList.classList.toggle('hidden', isGrid);

  if (isGrid) {
    liveGrid.innerHTML = slice.length
      ? slice.map(liveCard).join('')
      : emptyState('📡', 'No channels', '');
  } else {
    liveList.innerHTML = slice.length
      ? slice.map(ch => listItem(ch, 'live')).join('')
      : emptyState('📡', 'No channels', '');
  }

  renderPg('live-pagination', pg, Math.ceil(filtered.length / PS), 'live');
  ImageCache.preload(slice.map(c => c.logo).filter(Boolean));
  perfLog('renderLive', {
    ms: performance.now() - t0,
    count: filtered.length,
    page: pg,
    view: isGrid ? 'grid' : 'list',
  });
}

function renderMovies() {
  const t0    = performance.now();
  const cat    = S.activeCat.movies;
  const search = S.search.movies;
  const groups = [...new Set(S.movies.map(m => m.group).filter(Boolean))];

  document.getElementById('movies-cat-tabs').innerHTML =
    ['all', ...groups.slice(0,80)].map(c => `
      <button class="cat-tab${c === cat ? ' active' : ''}"
        onclick="setCat('movies','${ea(c)}')">${c === 'all' ? 'All' : esc(catName(c,'vod') || String(c))}</button>
    `).join('');

  const filtered = applySortToItems(getFiltered(S.movies, cat, search), 'movies');
  const pg       = S.page.movies;
  const slice    = filtered.slice(pg * PS, (pg + 1) * PS);
  const isGrid   = S.view.movies !== 'list';

  document.getElementById('movies-grid').classList.toggle('hidden', !isGrid);
  document.getElementById('movies-list').classList.toggle('hidden', isGrid);

  if (isGrid) {
    document.getElementById('movies-grid').innerHTML = slice.length
      ? slice.map(m => mediaCard(m, 'vod')).join('')
      : emptyState('🎬', 'No movies', '');
  } else {
    document.getElementById('movies-list').innerHTML = slice.length
      ? slice.map(m => listItem(m, 'vod')).join('')
      : emptyState('🎬', 'No movies', '');
  }

  renderPg('movies-pagination', pg, Math.ceil(filtered.length / PS), 'movies');
  ImageCache.preload(slice.map(m => m.logo).filter(Boolean));
  perfLog('renderMovies', {
    ms: performance.now() - t0,
    count: filtered.length,
    page: S.page.movies,
    view: isGrid ? 'grid' : 'list',
  });
}

function renderSeries() {
  const t0    = performance.now();
  const cat    = S.activeCat.series;
  const search = S.search.series;
  const groups = [...new Set(S.series.map(s => s.group).filter(Boolean))];

  document.getElementById('series-cat-tabs').innerHTML =
    ['all', ...groups.slice(0,80)].map(c => `
      <button class="cat-tab${c === cat ? ' active' : ''}"
        onclick="setCat('series','${ea(c)}')">${c === 'all' ? 'All' : esc(catName(c,'series') || String(c))}</button>
    `).join('');

  const filtered = applySortToItems(getFiltered(S.series, cat, search), 'series');
  const pg       = S.page.series;
  const slice    = filtered.slice(pg * PS, (pg + 1) * PS);
  const isGrid   = S.view.series !== 'list';

  document.getElementById('series-grid').classList.toggle('hidden', !isGrid);
  document.getElementById('series-list').classList.toggle('hidden', isGrid);

  if (isGrid) {
    document.getElementById('series-grid').innerHTML = slice.length
      ? slice.map(s => mediaCard(s, 'series')).join('')
      : emptyState('📽️', 'No series', '');
  } else {
    document.getElementById('series-list').innerHTML = slice.length
      ? slice.map(s => listItem(s, 'series')).join('')
      : emptyState('📽️', 'No series', '');
  }

  renderPg('series-pagination', pg, Math.ceil(filtered.length / PS), 'series');
  ImageCache.preload(slice.map(s => s.logo).filter(Boolean));
  perfLog('renderSeries', {
    ms: performance.now() - t0,
    count: filtered.length,
    page: S.page.series,
    view: isGrid ? 'grid' : 'list',
  });
}

function renderFavorites() {
  const activeType = document.querySelector('[data-fav-type].active')?.dataset.favType || 'all';
  const grid = document.getElementById('favorites-grid');
  const empty = document.getElementById('favorites-empty');

  let items = getFavItems();
  if (activeType !== 'all') items = items.filter(f => f.type === activeType);

  if (!items.length) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  grid.innerHTML = items.map(f =>
    f.type === 'live' ? liveCard(f.item) : mediaCard(f.item, f.type)
  ).join('');
}

function renderSettings() {
  applySettings();
  detectMpv();
  checkVLCStatus(); // Add this function call

  if (S.source?.type === 'xtream') {
    document.getElementById('cfg-server').value = S.source.host || '';
    document.getElementById('cfg-user').value   = S.source.user || '';
  }

  const hwToggle = document.getElementById('hwdec-toggle');
  hwToggle.classList.toggle('on', S.settings.hwdec !== false);

  const volInput = document.getElementById('cfg-volume');
  if (volInput) volInput.value = S.settings.defaultVolume || 85;

  // ADD THIS SECTION - Player Selection
  const playerSelect = document.getElementById('player-select');
  if (playerSelect) {
    playerSelect.value = S.settings.preferredPlayer || 'mpv';
    playerSelect.onchange = () => {
      saveSetting('preferredPlayer', playerSelect.value);
      toast(`Default player set to ${playerSelect.value.toUpperCase()}`, 'success');
    };
  }

  // Wire settings buttons
  document.getElementById('save-source-btn').onclick = connectXtream;
  document.getElementById('test-connection-btn').onclick = testConnection;
  document.getElementById('detect-mpv-btn').onclick = detectMpv;
  document.getElementById('export-btn').onclick = exportSettings;
  document.getElementById('import-btn').onclick = importSettings;
  document.getElementById('clear-data-btn').onclick = clearSource;

  hwToggle.onclick = () => {
    const on = hwToggle.classList.toggle('on');
    saveSetting('hwdec', on);
  };
  
  if (volInput) {
    volInput.oninput = () => saveSetting('defaultVolume', +volInput.value);
  }

  const epgToggle = document.getElementById('epg-auto-toggle');
  epgToggle.classList.toggle('on', S.settings.autoEpg !== false);
  epgToggle.onclick = () => {
    const on = epgToggle.classList.toggle('on');
    saveSetting('autoEpg', on);
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// CARDS
// ═════════════════════════════════════════════════════════════════════════════
function liveCard(ch) {
  const epg    = getEPG(ch.tvgId || ch.name);
  const favKey = `live:${ch.name}`;
  const isFav  = S.favs.has(favKey);
  const logo   = ch.logo ? esc(ch.logo) : '';

  return `
    <div class="card" onclick="openDetail(${JSON.stringify(ch).replace(/"/g,'&quot;')}, 'live')">
      <div class="card-now-playing">LIVE</div>
      ${isFav ? '<div class="card-fav active">★</div>' : '<div class="card-fav">☆</div>'}
      <div class="card-poster-placeholder wide">
        ${logo
          ? `<img src="${logo}" alt="" loading="lazy" onerror="this.style.display='none'">`
          : '<span class="poster-fallback">📺</span>'
        }
      </div>
      <div class="card-info">
        <div class="card-title">${esc(ch.name)}</div>
        <div class="card-meta">${esc(catName(ch.group,'live') || '')}</div>
      </div>
      ${epg.now ? `<div class="card-epg-label">▶ ${esc(epg.now.title)}</div>` : ''}
    </div>`;
}

function mediaCard(item, type) {
  const favKey  = `${type}:${item.name}`;
  const isFav   = S.favs.has(favKey);
  const hist    = S.history.find(h => h.id === `${type}:${item.name}`);
  const pct     = hist?.duration ? Math.min(95, (hist.pos / hist.duration) * 100) : 0;
  const itemJ   = JSON.stringify(item).replace(/"/g,'&quot;');
  const logo    = item.logo ? esc(item.logo) : '';
  const icon    = type === 'series' ? '📺' : '🎬';

  return `
    <div class="card" onclick="openDetail(${itemJ}, '${type}')">
      ${isFav ? '<div class="card-fav active">★</div>' : '<div class="card-fav">☆</div>'}
      <div class="card-poster-placeholder">
        ${logo
          ? `<img src="${logo}" alt="" loading="lazy" onerror="this.style.display='none'">`
          : `<span class="poster-fallback">${icon}</span>`
        }
      </div>
      ${pct > 2 ? `<div class="card-progress"><div class="card-progress-fill" style="width:${pct}%"></div></div>` : ''}
      <div class="card-info">
        <div class="card-title">${esc(item.name)}</div>
        <div class="card-meta">${item.year || ''}${item.rating ? ' · ⭐' + parseFloat(item.rating).toFixed(1) : ''}</div>
      </div>
    </div>`;
}

function listItem(item, type) {
  const favKey = `${type}:${item.name}`;
  const isFav  = S.favs.has(favKey);
  const itemJ  = JSON.stringify(item).replace(/"/g,'&quot;');
  const isLive = type === 'live';

  return `
    <div class="list-item${isLive ? '' : ''}" onclick="openDetail(${itemJ}, '${type}')">
      <div class="list-thumb" style="background:var(--bg-4);display:flex;align-items:center;justify-content:center;color:var(--text-3)">
        ${ImageCache.img(item.logo, '', isLive ? '📺' : '🎬')}
      </div>
      <div class="list-info">
        <div class="list-title">${esc(item.name)}</div>
        <div class="list-meta">${esc(catName(item.group, isLive?'live':type) || '')}</div>
      </div>
      ${isLive ? `<div class="list-live-dot"></div>` : ''}
      <div class="list-actions">
        <button class="list-action-btn" title="${isFav ? 'Unfavorite' : 'Favorite'}"
          onclick="event.stopPropagation();toggleFav('${type}','${eu(item.name)}')">
          ${isFav ? '★' : '☆'}
        </button>
      </div>
    </div>`;
}

function cwCard(item) {
  const pct      = item.duration ? Math.min(95, (item.pos / item.duration) * 100) : 0;
  const timeLeft = item.duration ? formatTime(item.duration - item.pos) : '';
  const isLive   = item.type === 'live';

  return `
    <div class="continue-card" onclick="resumeItem('${eu(item.id)}')">
      <div class="continue-card-thumb-placeholder" style="position:relative">
        ${ImageCache.img(item.poster, '', isLive ? '📺' : '🎬')}
        ${isLive
          ? `<div style="position:absolute;top:6px;left:6px;background:var(--red);color:#fff;font-size:9px;font-weight:700;padding:2px 6px;border-radius:999px">LIVE</div>`
          : `<div class="continue-progress"><div class="continue-progress-fill" style="width:${pct}%"></div></div>`}
      </div>
      <div class="continue-card-info">
        <div class="continue-card-title">${esc(item.name)}</div>
        <div class="continue-card-meta">${isLive ? 'Live TV' : timeLeft + ' left'}</div>
      </div>
    </div>`;
}

// ═════════════════════════════════════════════════════════════════════════════
// FAVORITES
// ═════════════════════════════════════════════════════════════════════════════
async function toggleFav(type, encodedName) {
  const name = decodeURIComponent(encodedName);
  const key  = `${type}:${name}`;
  if (S.favs.has(key)) {
    S.favs.delete(key);
    await DB.removeFav(key);
    toast('Removed from favorites');
  } else {
    S.favs.add(key);
    await DB.addFav(key);
    toast('Added to favorites ⭐', 'success');
  }
  const pg = document.querySelector('.page.active')?.id?.replace('page-', '');
  if (pg === 'live')      renderLive();
  else if (pg === 'movies')    renderMovies();
  else if (pg === 'series')    renderSeries();
  else if (pg === 'favorites') renderFavorites();
  else if (pg === 'home')      renderHome();
}

function getFavItems() {
  const out = [];
  for (const key of S.favs) {
    const [type, ...parts] = key.split(':');
    const name = parts.join(':');
    let item;
    if (type === 'live')   item = S.channels.find(c => c.name === name);
    if (type === 'vod')    item = S.movies.find(m => m.name === name);
    if (type === 'series') item = S.series.find(s => s.name === name);
    if (item) out.push({ type, item });
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// SOURCE / XTREAM
// ═════════════════════════════════════════════════════════════════════════════
async function connectXtream() {
  const rawHost = document.getElementById('cfg-server').value.trim().replace(/\/$/, '');
  const user    = document.getElementById('cfg-user').value.trim();
  const pass    = document.getElementById('cfg-pass').value.trim();
  if (!rawHost || !user || !pass) { toast('Fill all fields', 'error'); return; }

  const btn = document.getElementById('save-source-btn');
  btn.disabled = true; btn.textContent = 'Connecting…';

  try {
    const host   = rawHost.startsWith('http') ? rawHost : `http://${rawHost}`;
    const apiUrl = `${host}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;
    const res    = await api.fetchXtream(apiUrl);
    if (!res.data) throw new Error('Empty response');
    const data   = JSON.parse(res.data);
    if (!data.user_info || data.user_info.auth == 0)
      throw new Error('Authentication failed');

    S.source = { type: 'xtream', host, user, pass };
    await DB.setMeta('source', S.source);
    toast('Connected!', 'success');
    updateSrcIndicator(true, `${user}@Xtream`);
    await loadXtreamData(false);
    navigateTo('home');
  } catch (e) {
    toast(e.message || 'Connection failed', 'error', 5000);
  } finally {
    btn.disabled = false; btn.textContent = 'Save & Reload';
  }
}

async function testConnection() {
  const rawHost = document.getElementById('cfg-server').value.trim().replace(/\/$/, '');
  const user    = document.getElementById('cfg-user').value.trim();
  const pass    = document.getElementById('cfg-pass').value.trim();
  if (!rawHost || !user || !pass) { toast('Fill all fields first', 'error'); return; }
  const host   = rawHost.startsWith('http') ? rawHost : `http://${rawHost}`;
  const apiUrl = `${host}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;
  try {
    const res  = await api.fetchXtream(apiUrl);
    const data = JSON.parse(res.data);
    if (data.user_info?.auth == 1) toast('Connection OK ✓', 'success');
    else toast('Auth failed', 'error');
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

async function loadXtreamData(silent = false) {
  try {
    const [lc, vc, sc] = await Promise.all([
      xtFetch('get_live_categories'),
      xtFetch('get_vod_categories'),
      xtFetch('get_series_categories'),
    ]);
    S.cats = { live: lc || [], vod: vc || [], series: sc || [] };
    await DB.setCats(S.cats);

    const live = await xtFetch('get_live_streams');
    S.channels = (live || []).map(s => ({
      name: s.name, logo: s.stream_icon, group: s.category_id,
      url:  xtUrl('live', s.stream_id, 'm3u8'),
      tvgId: s.epg_channel_id || '', streamId: s.stream_id,
    }));
    await DB.setData('channels', S.channels);
    setBadge(S.channels.length);
    if (!silent) renderHome();

    const [vod, ser] = await Promise.all([xtFetch('get_vod_streams'), xtFetch('get_series')]);
    S.movies = (vod || []).map(s => ({
      name: s.name, logo: s.stream_icon, group: s.category_id,
      url:  xtUrl('movie', s.stream_id, s.container_extension || 'mp4'),
      streamId: s.stream_id, year: s.year, rating: s.rating,
    }));
    S.series = (ser || []).map(s => ({
      name: s.name, logo: s.cover, group: s.category_id,
      streamId: s.series_id, year: s.year, rating: s.rating, plot: s.plot,
    }));

    await Promise.all([DB.setData('movies', S.movies), DB.setData('series', S.series), DB.stampCache()]);
    renderHome();
    schedulePreload();
    if (!silent) toast(`✓ ${S.channels.length} ch · ${S.movies.length} mov · ${S.series.length} ser`, 'success', 5000);
  } catch (e) {
    toast('Load error: ' + e.message, 'error');
  }
}

async function xtFetch(action, extra = '') {
  const { host, user, pass } = S.source;
  const url = `${host}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=${action}${extra}`;
  const res = await api.fetchXtream(url);
  return JSON.parse(res.data);
}

function xtUrl(type, id, ext) {
  const { host, user, pass } = S.source;
  return `${host}/${type}/${user}/${pass}/${id}.${ext}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// EPG
// ═════════════════════════════════════════════════════════════════════════════
async function loadEPGUrl() {
  const url = await DB.getMeta('epg_url');
  if (url) {
    const el = document.getElementById('cfg-epg');
    if (el) el.value = url;
    if (S.settings.autoEpg !== false) loadEPG(url);
  }
}

async function loadEPG(urlOverride) {
  const rawUrl = urlOverride || document.getElementById('cfg-epg')?.value?.trim();
  if (!rawUrl) { toast('Enter EPG URL', 'error'); return; }
  const url = rawUrl.startsWith('http') ? rawUrl : `http://${rawUrl}`;
  try {
    const res = await api.fetchEpg(url);
    if (!res.data) throw new Error('Empty response');
    parseEPG(res.data);
    await DB.setMeta('epg_url', url);
    await DB.setMeta('epg', S.epg);
    toast(`EPG: ${Object.keys(S.epg).length} channels loaded`, 'success');
    if (document.getElementById('page-live').classList.contains('active')) renderLive();
  } catch (e) {
    toast('EPG failed: ' + e.message, 'error');
  }
}

function parseEPG(xmlStr) {
  const doc = new DOMParser().parseFromString(xmlStr, 'text/xml');
  const now = Date.now();
  const tmp = {};
  doc.querySelectorAll('programme').forEach(p => {
    const ch    = p.getAttribute('channel');
    const start = parseEPGDate(p.getAttribute('start'));
    const stop  = parseEPGDate(p.getAttribute('stop'));
    const title = p.querySelector('title')?.textContent || '';
    if (!tmp[ch]) tmp[ch] = [];
    tmp[ch].push({ start, stop, title });
  });
  S.epg = {};
  for (const [ch, progs] of Object.entries(tmp)) {
    const nowP  = progs.find(p => p.start <= now && p.stop > now);
    const nextP = progs.find(p => p.start > now);
    if (nowP || nextP) S.epg[ch] = { now: nowP, next: nextP };
  }
}

function parseEPGDate(str) {
  if (!str) return 0;
  const m = str.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!m) return 0;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`).getTime();
}

function getEPG(id) {
  if (!id) return {};
  return S.epg[id] || S.epg[id.toLowerCase()] || {};
}

// ═════════════════════════════════════════════════════════════════════════════
// CONTEXT MENU
// ═════════════════════════════════════════════════════════════════════════════
function showCtx(e, type, encodedUrl, encodedName) {
  e.preventDefault();
  const url    = decodeURIComponent(encodedUrl);
  const name   = decodeURIComponent(encodedName);
  const favKey = `${type}:${name}`;
  const isFav  = S.favs.has(favKey);

  api.showContextMenu([
    { id: 'play', label: '▶  Play' },
    { id: 'vlc',  label: '🎬  Open in VLC' },
    { type: 'separator' },
    { id: 'fav',  label: isFav ? '★  Remove from Favorites' : '☆  Add to Favorites' },
    { id: 'copy', label: '📋  Copy Stream URL' },
  ]);

  api.onContextMenuClick(({ id }) => {
    if (id === 'play') playItem(eu(url), eu(name), type, type, '');
    if (id === 'vlc')  vlcDirect(url, name);
    if (id === 'fav')  toggleFav(type, eu(name));
    if (id === 'copy') navigator.clipboard.writeText(url).then(() => toast('URL copied!', 'success'));
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// BACKGROUND REFRESH
// ═════════════════════════════════════════════════════════════════════════════
async function bgRefresh() {
  if (!S.source) return;
  try {
    if (S.source.type === 'xtream') await loadXtreamData(true);
    await DB.stampCache();
    toast('Content refreshed', 'info', 2000);
  } catch (e) { console.warn('BG refresh failed:', e.message); }
}

function setupBgRefresh() {
  setInterval(() => {
    DB.getCacheAge().then(age => { if (age > CACHE_MAX_MS) bgRefresh(); });
  }, 30 * 60 * 1000);
}

async function manualRefresh() {
  toast('Refreshing…', 'info', 1500);
  await bgRefresh();
}

function schedulePreload() {
  setTimeout(() => {
    const urls = [
      ...S.channels.slice(0, PS).map(c => c.logo),
      ...S.movies.slice(0, PS).map(m => m.logo),
      ...S.series.slice(0, PS).map(s => s.logo),
    ].filter(Boolean);
    ImageCache.preload(urls);
  }, 1000);
}

// ═════════════════════════════════════════════════════════════════════════════
// SETTINGS ACTIONS
// ═════════════════════════════════════════════════════════════════════════════
function applySettings() {
  const dp = document.getElementById('cfg-volume');
  if (dp) dp.value = S.settings.defaultVolume || 85;
}

async function saveSetting(key, value) {
  S.settings[key] = value;
  await DB.setMeta('settings', S.settings);
}

async function clearSource() {
  if (!confirm('Remove source and clear all data?')) return;
  await DB.clearAll();
  ImageCache.clearAll();
  S.source = null; S.channels = []; S.movies = []; S.series = [];
  S.favs = new Set(); S.history = [];
  updateSrcIndicator(false, 'Not connected');
  showWelcome();
  toast('Source removed', 'info');
}

async function exportSettings() {
  const epgUrl = await DB.getMeta('epg_url');
  const data = {
    source:   S.source,
    settings: S.settings,
    favs:     [...S.favs],
    history:  S.history.slice(0, 100),
    epg_url:  epgUrl || null,   // fix: was missing from export
    exported: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `stream-backup-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Settings exported', 'success');
}

async function importSettings() {
  const input = document.createElement('input');
  input.type  = 'file';
  input.accept = '.json';
  input.onchange = async () => {
    try {
      const text = await input.files[0].text();
      const data = JSON.parse(text);
      if (data.source)   { S.source = data.source; await DB.setMeta('source', S.source); }
      if (data.settings) { S.settings = { ...S.settings, ...data.settings }; await DB.setMeta('settings', S.settings); }
      if (data.favs)     { S.favs = new Set(data.favs); await DB.setMeta('favs', data.favs); }
      if (data.epg_url)  { await DB.setMeta('epg_url', data.epg_url); }  // restore EPG URL
      toast('Settings imported — reload to apply', 'success', 5000);
      renderSettings();
    } catch (e) { toast('Import failed: ' + e.message, 'error'); }
  };
  input.click();
}

// ═════════════════════════════════════════════════════════════════════════════
// PAGINATION
// ═════════════════════════════════════════════════════════════════════════════
function renderPg(id, cur, total, section) {
  const el = document.getElementById(id);
  if (!el || total <= 1) { if (el) el.innerHTML = ''; return; }

  const pages = [];
  for (let i = 0; i < total; i++) {
    if (i === 0 || i === total - 1 || Math.abs(i - cur) <= 2) {
      pages.push(i);
    } else if (pages[pages.length - 1] !== '…') {
      pages.push('…');
    }
  }

  el.innerHTML = `
    <button class="page-btn" onclick="goPage('${section}',${cur-1})" ${cur===0?'disabled':''}>←</button>
    ${pages.map(p => p === '…'
      ? `<span class="page-btn" style="pointer-events:none">…</span>`
      : `<button class="page-btn${p===cur?' active':''}" onclick="goPage('${section}',${p})">${p+1}</button>`
    ).join('')}
    <button class="page-btn" onclick="goPage('${section}',${cur+1})" ${cur===total-1?'disabled':''}>→</button>`;
}

function goPage(section, page) {
  S.page[section] = page;
  if (section === 'live')   renderLive();
  if (section === 'movies') renderMovies();
  if (section === 'series') renderSeries();
  document.getElementById(`page-${section}`)?.scrollTo(0, 0);
}

// ═════════════════════════════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ═════════════════════════════════════════════════════════════════════════════
document.addEventListener('keydown', e => {
  const playerOpen  = Player.isOpen;
  const modalOpen   = document.querySelector('.shortcuts-box')?.closest('#shortcuts-modal')
                       ?.classList.contains('open');
  const activeTag   = document.activeElement?.tagName;
  const inInput     = activeTag === 'INPUT' || activeTag === 'TEXTAREA';

  if (e.key === 'Escape') {
    const searchInput = document.getElementById('search-input');
    if (document.activeElement === searchInput && searchInput?.value) {
      searchInput.value = '';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    if (modalOpen)    document.getElementById('shortcuts-modal').classList.remove('open');
    else if (playerOpen) Player.close();
    else              closeDetail();
    return;
  }

  if (e.key === '?') {
    document.getElementById('shortcuts-modal').classList.add('open');
    return;
  }

  if (playerOpen) {
    switch(e.key) {
      case ' ':
      case 'k':        e.preventDefault(); Player.togglePause();    break;
      case 'ArrowRight': e.preventDefault(); Player.seek(+10);      break;
      case 'ArrowLeft':  e.preventDefault(); Player.seek(-10);      break;
      case 'ArrowUp':    e.preventDefault(); Player.volumeUp();     break;
      case 'ArrowDown':  e.preventDefault(); Player.volumeDown();   break;
      case 'm':
      case 'M':        Player.toggleMute();                         break;
      case 'f':
      case 'F':        Player.toggleFullscreen();                   break;
      case 'i':
      case 'I':        Player.toggleInfo();                         break;
      case 's':
      case 'S':        Player.screenshot();                         break;
      case 'PageUp':   e.preventDefault(); Player.prevChannel();    break;
      case 'PageDown': e.preventDefault(); Player.nextChannel();    break;
    }
    return;
  }

  if (e.key === '/') {
    e.preventDefault();
    const input = document.getElementById('search-input');
    if (input) {
      input.focus();
      input.select();
    }
    return;
  }

  if (inInput) return;

  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'r') { e.preventDefault(); manualRefresh(); }
    return;
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CATEGORY / SEARCH / VIEW HELPERS
// ═════════════════════════════════════════════════════════════════════════════
function setCat(section, cat) {
  S.activeCat[section] = cat; S.page[section] = 0;
  if (section === 'live')   renderLive();
  if (section === 'movies') renderMovies();
  if (section === 'series') renderSeries();
}

function getFiltered(arr, cat, search) {
  let items = arr;
  if (cat !== 'all') items = items.filter(i => i.group == cat);
  if (search) {
    const q = search.toLowerCase();
    items = items.filter(i => i.name.toLowerCase().includes(q));
  }
  return items;
}

function catName(id, type) {
  const map  = { live: 'live', vod: 'vod', series: 'series' };
  const cats = S.cats[map[type]] || [];
  return cats.find(c => c.category_id == id)?.category_name || null;
}

// ═════════════════════════════════════════════════════════════════════════════
// UTIL
// ═════════════════════════════════════════════════════════════════════════════
function updateSrcIndicator(on, text) {
  // Update sidebar logo text or any indicator
  const el = document.querySelector('.sidebar-logo-text');
  if (el) el.title = text;
}

function setBadge(count) {
  const b = document.getElementById('live-count-badge');
  if (!b) return;
  b.textContent = count > 999 ? '999+' : count;
  b.style.display = count > 0 ? '' : 'none';
}

function srcLabel() {
  if (!S.source) return 'Not connected';
  return S.source.type === 'xtream' ? `${S.source.user}@Xtream` : 'M3U Playlist';
}

function formatTime(secs) {
  if (!secs || secs < 0) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function emptyState(icon, title, sub) {
  return `<div class="empty-state" style="grid-column:1/-1">
    <div class="empty-icon">${icon}</div>
    <div class="empty-title">${esc(title)}</div>
    ${sub ? `<div class="empty-sub">${esc(sub)}</div>` : ''}
  </div>`;
}

function toast(msg, type = 'info', ms = 3200) {
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const c  = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type] || ''}</span><span>${esc(msg)}</span>`;
  c.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

function esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function eu(s)  { return encodeURIComponent(s || ''); }
function ea(s)  { return String(s || '').replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }

// ═════════════════════════════════════════════════════════════════════════════
// GLOBAL SEARCH
// ═════════════════════════════════════════════════════════════════════════════
function setupGlobalSearch() {
  // When search has a query, show a unified results view across all types
  const input = document.getElementById('search-input');
  if (!input) return;

  input.addEventListener('input', () => {
    const q = input.value.trim();
    const activePage = document.querySelector('.page.active')?.id?.replace('page-', '');

    // Only do global search from home page; other pages do local search
    if (activePage === 'home' && q.length >= 2) {
      _renderGlobalSearch(q);
    } else if (activePage === 'home' && !q) {
      renderHome();
    }
  });
}

function _renderGlobalSearch(q) {
  const lq = q.toLowerCase();
  const liveResults   = S.channels.filter(c => c.name.toLowerCase().includes(lq)).slice(0, 6);
  const movieResults  = S.movies.filter(m => m.name.toLowerCase().includes(lq)).slice(0, 6);
  const seriesResults = S.series.filter(s => s.name.toLowerCase().includes(lq)).slice(0, 6);

  const cwSection = document.getElementById('continue-watching-section');
  cwSection.style.display = 'none';

  const liveGrid   = document.getElementById('home-live-grid');
  const moviesGrid = document.getElementById('home-movies-grid');

  // Render all results in home grids with section labels injected
  const totalFound = liveResults.length + movieResults.length + seriesResults.length;

  if (!totalFound) {
    liveGrid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <div class="empty-icon">🔍</div>
      <div class="empty-title">No results for "${esc(q)}"</div>
      <div class="empty-sub">Try a different search term</div>
    </div>`;
    moviesGrid.innerHTML = '';
    return;
  }

  liveGrid.innerHTML =
    (liveResults.length ? `<div style="grid-column:1/-1;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-3);padding-bottom:4px">Live TV</div>` + liveResults.map(liveCard).join('') : '') +
    (movieResults.length ? `<div style="grid-column:1/-1;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-3);padding:12px 0 4px">Movies</div>` + movieResults.map(m => mediaCard(m,'vod')).join('') : '') +
    (seriesResults.length ? `<div style="grid-column:1/-1;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-3);padding:12px 0 4px">Series</div>` + seriesResults.map(s => mediaCard(s,'series')).join('') : '');
  moviesGrid.innerHTML = '';
}

// ═════════════════════════════════════════════════════════════════════════════
// SORT OPTIONS
// ═════════════════════════════════════════════════════════════════════════════
// Sort state per section
const S_SORT = { movies: 'default', series: 'default' };

function setupSortButtons() {
  // Inject sort controls into movies and series pages
  ['movies', 'series'].forEach(section => {
    const page = document.getElementById(`page-${section}`);
    if (!page) return;
    const catTabs = page.querySelector('.cat-tabs');
    if (!catTabs) return;

    const sortWrap = document.createElement('div');
    sortWrap.style.cssText = 'display:flex;gap:6px;margin-bottom:12px;align-items:center;';
    sortWrap.innerHTML = `
      <span style="font-size:11px;color:var(--text-3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-right:4px">Sort</span>
      <button class="cat-tab sort-btn active" data-sort="default" data-section="${section}">Default</button>
      <button class="cat-tab sort-btn" data-sort="az" data-section="${section}">A–Z</button>
      <button class="cat-tab sort-btn" data-sort="rating" data-section="${section}">Rating</button>
      <button class="cat-tab sort-btn" data-sort="year" data-section="${section}">Year</button>
    `;
    catTabs.parentNode.insertBefore(sortWrap, catTabs);

    sortWrap.querySelectorAll('.sort-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        sortWrap.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        S_SORT[section] = btn.dataset.sort;
        S.page[section] = 0;
        if (section === 'movies') renderMovies();
        if (section === 'series') renderSeries();
      });
    });
  });
}

function applySortToItems(items, section) {
  const sort = S_SORT[section];
  if (!sort || sort === 'default') return items;
  const copy = [...items];
  if (sort === 'az')     return copy.sort((a, b) => a.name.localeCompare(b.name));
  if (sort === 'rating') return copy.sort((a, b) => (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0));
  if (sort === 'year')   return copy.sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0));
  return copy;
}

// ═════════════════════════════════════════════════════════════════════════════
// SLEEP TIMER
// ═════════════════════════════════════════════════════════════════════════════
let _sleepTimer = null;
let _sleepEnd   = 0;
let _sleepTick  = null;

function setupSleepTimer() {
  // Inject sleep timer button into player topbar
  const topbar = document.getElementById('player-topbar');
  if (!topbar) return;

  const btn = document.createElement('button');
  btn.id        = 'sleep-timer-btn';
  btn.className = 'ctrl-btn';
  btn.title     = 'Sleep timer';
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3.5a.5.5 0 00-1 0V9a.5.5 0 00.252.434l3.5 2a.5.5 0 00.496-.868L8 8.71V3.5z"/><path d="M8 16A8 8 0 108 0a8 8 0 000 16zm7-8A7 7 0 111 8a7 7 0 0114 0z"/></svg>`;

  const sleepLabel = document.createElement('span');
  sleepLabel.id = 'sleep-timer-label';
  sleepLabel.style.cssText = 'font-size:11px;color:var(--yellow);font-weight:600;min-width:32px;';

  btn.addEventListener('click', () => _showSleepMenu());

  // Insert before stream-info-btn
  const infoBtn = document.getElementById('stream-info-btn');
  if (infoBtn) {
    topbar.insertBefore(sleepLabel, infoBtn);
    topbar.insertBefore(btn, infoBtn);
  } else {
    topbar.appendChild(btn);
    topbar.appendChild(sleepLabel);
  }
}

function _showSleepMenu() {
  const options = _sleepTimer
    ? [{ label: '✕ Cancel timer', mins: 0 }]
    : [
        { label: '30 min',  mins: 30  },
        { label: '60 min',  mins: 60  },
        { label: '90 min',  mins: 90  },
        { label: '2 hours', mins: 120 },
      ];

  api.showContextMenu(options.map((o, i) => ({ id: `sleep-${i}`, label: o.label })));

  const unsub = api.onContextMenuClick(({ id }) => {
    unsub();
    const idx = parseInt(id.replace('sleep-', ''));
    const mins = options[idx]?.mins ?? -1;
    if (mins === 0) {
      _cancelSleepTimer();
    } else if (mins > 0) {
      _setSleepTimer(mins);
    }
  });
}

function _setSleepTimer(mins) {
  _cancelSleepTimer();
  _sleepEnd = Date.now() + mins * 60 * 1000;
  _sleepTimer = setTimeout(() => {
    _cancelSleepTimer();
    toast(`Sleep timer: closing player`, 'info', 3000);
    setTimeout(() => Player.close(), 3000);
  }, mins * 60 * 1000);

  // Tick to update label
  _sleepTick = setInterval(() => {
    const remaining = Math.max(0, _sleepEnd - Date.now());
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    const label = document.getElementById('sleep-timer-label');
    if (label) label.textContent = `${m}:${String(s).padStart(2, '0')}`;
    if (remaining <= 0) _cancelSleepTimer();
  }, 1000);

  const label = document.getElementById('sleep-timer-label');
  if (label) label.textContent = `${mins}:00`;
  toast(`Sleep timer set for ${mins} minutes 😴`, 'info', 3000);
}

function _cancelSleepTimer() {
  clearTimeout(_sleepTimer);
  clearInterval(_sleepTick);
  _sleepTimer = null;
  _sleepEnd   = 0;
  const label = document.getElementById('sleep-timer-label');
  if (label) label.textContent = '';
  toast('Sleep timer cancelled', 'info', 2000);
}

// ═════════════════════════════════════════════════════════════════════════════
// NEXT EPISODE PROMPT
// ═════════════════════════════════════════════════════════════════════════════
function setupNextEpPrompt() {
  const el = document.getElementById('next-episode-prompt');
  if (!el) return;
  const dismissBtn = document.getElementById('next-ep-dismiss-btn');
  if (dismissBtn) dismissBtn.addEventListener('click', () => {
    if (el._clearTimer) el._clearTimer();
    el.classList.remove('visible');
  });
}