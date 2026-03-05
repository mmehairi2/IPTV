// ─────────────────────────────────────────────────────────────────────────────
// player.js — State, Player IIFE, playback helpers, history, keyboard shortcuts,
//             sleep timer, context menu, background refresh, boot
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
  epgFull:    {},   // full schedule for EPG timeline grid
  favs:       new Set(),
  watchlist:  new Set(),
  history:    [],
  view:       { live: 'grid', movies: 'grid', series: 'grid', favorites: 'grid', watchlist: 'grid' },
  activeCat:  { live: 'all', movies: 'all', series: 'all' },
  search:     { live: '', movies: '', series: '' },
  page:       { live: 0, movies: 0, series: 0 },
  current:    null,
  settings:   { defaultPlayer: 'mpv', hwdec: true, defaultVolume: 85, brightness: 0, contrast: 0, saturation: 0 },
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

    // Show toast with retry button
    toast(msg || 'Stream failed to load', 'error', 7000, {
      retry: () => {
        if (_retryUrl) { _clearError(); api.mpvLoadfile(_retryUrl, 'replace'); }
      }
    });

    // Auto-retry once after 3s
    clearTimeout(_autoRetryTimer);
    _autoRetryTimer = setTimeout(() => {
      if (el.classList.contains('visible') && _retryUrl) {
        toast('Auto-retrying…', 'info', 2000);
        _clearError();
        api.mpvLoadfile(_retryUrl, 'replace');
      }
    }, 3000);
  }

  let _autoRetryTimer = null;

  function _clearError() {
    clearTimeout(_autoRetryTimer);
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
      _applyVideoAdjustments();
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
      _setLoading(true, 'Player crashed — restarting…', `Attempt ${attempt} of 3`);
      toast(`mpv crashed, restarting (${attempt}/3)…`, 'warning', 3000);
    }));

    _unsubs.push(api.onMpvFallbackVlc(() => {
      _setLoading(false);
      toast('mpv failed 3 times — falling back to VLC', 'error', 6000);
      if (_retryUrl && S.current) {
        vlcDirect(_retryUrl, S.current.name);
      }
      // Show a proper error state instead of blank
      _setError('mpv crashed repeatedly. Opened in VLC instead.');
      // Don't call Player.close() so user can see the error panel
    }));

    _unsubs.push(api.onMpvExited(({ code }) => {
      if (code === 0) return;  // clean exit
      _setLoading(true, 'Player restarting…', '');
    }));

    _unsubs.push(api.onMpvSocketError(({ message }) => {
      console.warn('[mpv socket]', message);
    }));
    // onWinMoved is handled exclusively by _startResizeObserver to avoid duplicate resize IPC
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
        _applyVideoAdjustments();
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
    $('video-adjust-panel').classList.remove('visible');

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
    $('video-adjust-panel').classList.remove('visible');
  }

  function _applyVideoAdjustments() {
    const b = Math.max(-100, Math.min(100, S.settings.brightness ?? 0));
    const c = Math.max(-100, Math.min(100, S.settings.contrast ?? 0));
    const s = Math.max(-100, Math.min(100, S.settings.saturation ?? 0));
    api.mpvSetProperty('brightness', b);
    api.mpvSetProperty('contrast', c);
    api.mpvSetProperty('saturation', s);
  }

  function toggleVideoAdjust() {
    const el = $('video-adjust-panel');
    const on = el.classList.toggle('visible');
    if (on) {
      $('stream-info').classList.remove('visible');
      $('video-brightness').value = S.settings.brightness ?? 0;
      $('video-contrast').value   = S.settings.contrast ?? 0;
      $('video-saturation').value = S.settings.saturation ?? 0;
    }
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
    $('video-adjust-btn').addEventListener('click', toggleVideoAdjust);

    function _onVideoAdjustChange(prop, value) {
      const v = Math.max(-100, Math.min(100, value));
      S.settings[prop] = v;
      api.mpvSetProperty(prop, v);
      DB.setMeta('settings', S.settings);
    }
    $('video-brightness').addEventListener('input', () => _onVideoAdjustChange('brightness', parseInt($('video-brightness').value, 10)));
    $('video-contrast').addEventListener('input', () => _onVideoAdjustChange('contrast', parseInt($('video-contrast').value, 10)));
    $('video-saturation').addEventListener('input', () => _onVideoAdjustChange('saturation', parseInt($('video-saturation').value, 10)));
    $('video-adjust-reset').addEventListener('click', () => {
      S.settings.brightness = 0;
      S.settings.contrast = 0;
      S.settings.saturation = 0;
      $('video-brightness').value = 0;
      $('video-contrast').value = 0;
      $('video-saturation').value = 0;
      _applyVideoAdjustments();
      DB.setMeta('settings', S.settings);
    });

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
  setupFavTabs();
  setupGlobalSearch();
  setupSortButtons();
  setupOnboarding();
  setupLiveCardEpgTooltip();
  setupGridKeyboardNav();
  setupSleepTimer();
  setupNextEpPrompt();
  setupEPGControls();     // Phase 3: EPG timeline
  setupTitlebar();
  setupNetworkDetection();
  setupMediaKeys();
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

  // Flush playback position before the main process kills mpv on quit
  api.onAppQuitting(async () => {
    try {
      if (Player.isOpen) await Player.close();
    } catch (_) {
      // Never block quit on an error
    } finally {
      api.confirmFlush();
    }
  });

  // Auto-update listeners
  if (api.onUpdateAvailable) {
    api.onUpdateAvailable(() => {
      toast('Update available — downloading…', 'info', 5000);
    });
    api.onUpdateDownloaded(() => {
      const banner = document.getElementById('update-banner');
      if (banner) banner.style.display = 'flex';
      const btn = document.getElementById('update-install-btn');
      if (btn) btn.onclick = () => api.installUpdate?.();
    });
    api.onUpdateError(({ message }) => {
      console.warn('[update]', message);
    });
  }
});

async function bootApp() {

  const [src, channels, movies, series, cats, favs, watchlist, history, settings, epg] =
    await Promise.all([
      DB.getMeta('source'),
      DB.getData('channels'),
      DB.getData('movies'),
      DB.getData('series'),
      DB.getCats(),
      DB.getFavs(),
      DB.getMeta('watchlist'),
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
  if (watchlist && Array.isArray(watchlist)) S.watchlist = new Set(watchlist);
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
// CONTEXT MENU
// ═════════════════════════════════════════════════════════════════════════════
function showCtx(e, type, encodedUrl, encodedName) {
  e.preventDefault();
  const url    = decodeURIComponent(encodedUrl);
  const name   = decodeURIComponent(encodedName);
  const favKey = `${type}:${name}`;
  const isFav  = S.favs.has(favKey);
  const inWatchlist = isInWatchlist(type, name);

  api.showContextMenu([
    { id: 'play', label: '▶  Play' },
    { id: 'vlc',  label: '🎬  Open in VLC' },
    { type: 'separator' },
    { id: 'fav',  label: isFav ? '★  Remove from Favorites' : '☆  Add to Favorites' },
    { id: 'watchlist', label: inWatchlist ? '✓  Remove from Watchlist' : '📋  Add to Watchlist' },
    { id: 'copy', label: '📋  Copy Stream URL' },
  ]);

  const unsub = api.onContextMenuClick(async ({ id }) => {
    unsub();
    if (id === 'play') playItem(eu(url), eu(name), type, type, '');
    if (id === 'vlc')  vlcDirect(url, name);
    if (id === 'fav')  toggleFav(type, eu(name));
    if (id === 'watchlist') {
      if (inWatchlist) {
        await removeFromWatchlist(type, name);
        toast('Removed from watchlist');
      } else {
        await addToWatchlist(type, name);
        toast('Added to watchlist', 'success');
      }
      if (document.getElementById('page-watchlist')?.classList.contains('active')) renderWatchlist();
    }
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
    // Preload first 2 pages worth of images for each section
    const urls = [
      ...S.channels.slice(0, PS * 2).map(c => c.logo),
      ...S.movies.slice(0, PS * 2).map(m => m.logo),
      ...S.series.slice(0, PS * 2).map(s => s.logo),
    ].filter(Boolean);
    ImageCache.preload(urls);
  }, 800);
}

// ═════════════════════════════════════════════════════════════════════════════
// SETTINGS ACTIONS

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
// ═════════════════════════════════════════════════════════════════════════════
// TITLEBAR (4-2)
// ═════════════════════════════════════════════════════════════════════════════
function setupTitlebar() {
  const tbMin = document.getElementById('tb-minimize');
  const tbMax = document.getElementById('tb-maximize');
  const tbClose = document.getElementById('tb-close');

  if (tbMin)   tbMin.addEventListener('click',   () => api.winMinimize?.());
  if (tbMax)   tbMax.addEventListener('click',   () => api.winMaximize?.());
  if (tbClose) tbClose.addEventListener('click', () => api.winClose?.());

  // Update maximize icon on state change
  function updateMaxIcon(isMax) {
    const icon = document.getElementById('tb-max-icon');
    if (!icon) return;
    if (isMax) {
      // Restore icon (two overlapping squares)
      icon.innerHTML = `
        <rect x="3" y="1" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/>
        <rect x="1" y="3" width="7" height="7" rx="1" fill="var(--bg)" stroke="currentColor" stroke-width="1.5"/>
      `;
    } else {
      // Maximize icon (single square)
      icon.innerHTML = `<rect x="1" y="1" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/>`;
    }
  }

  if (api.winIsMaximized) {
    api.winIsMaximized().then(updateMaxIcon);
  }
  if (api.onWinMaximizeChange) {
    api.onWinMaximizeChange(({ maximized }) => updateMaxIcon(maximized));
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// NETWORK DETECTION (4-5)
// ═════════════════════════════════════════════════════════════════════════════
function setupNetworkDetection() {
  const banner = document.getElementById('network-banner');
  if (!banner) return;

  function updateBanner() {
    banner.classList.toggle('visible', !navigator.onLine);
  }

  window.addEventListener('online',  () => { updateBanner(); toast('Back online', 'success', 2500); });
  window.addEventListener('offline', () => { updateBanner(); toast('No internet connection', 'warning', 5000); });
  updateBanner();
}

// ═════════════════════════════════════════════════════════════════════════════
// MEDIA KEYS (4-4)
// ═════════════════════════════════════════════════════════════════════════════
function setupMediaKeys() {
  if (!api.onMediaKey) return;
  api.onMediaKey(({ key }) => {
    switch (key) {
      case 'playpause': if (Player.isOpen) api.mpvTogglePause(); break;
      case 'stop':      if (Player.isOpen) Player.close(); break;
      case 'next':      navigateChannel(1);  break;
      case 'prev':      navigateChannel(-1); break;
      case 'volup': {
        const newVol = Math.min(100, (S.settings.defaultVolume || 85) + 5);
        S.settings.defaultVolume = newVol;
        api.mpvSetVolume(newVol);
        break;
      }
      case 'voldown': {
        const newVol = Math.max(0, (S.settings.defaultVolume || 85) - 5);
        S.settings.defaultVolume = newVol;
        api.mpvSetVolume(newVol);
        break;
      }
    }
  });
}

// Navigate to next/prev channel when player is open
function navigateChannel(dir) {
  if (!S.current || !Player.isOpen) return;
  const list = S.current.type === 'live' ? S.channels
             : S.current.type === 'movie' ? S.movies
             : S.series;
  const idx = list.findIndex(c => c.name === S.current.name);
  if (idx < 0) return;
  const next = list[idx + dir];
  if (next) {
    // Use the existing card click pathway
    Player.open(next.url || next.stream_url, next.name, next.category_name, S.current.type, next.poster || next.cover);
  }
}