// ============================================================
// preload.js — Context Bridge
// Exposes main process IPC to renderer via window.api
// ============================================================

const { contextBridge, ipcRenderer } = require('electron');

const IS_DEV = process.env.NODE_ENV !== 'production';

// ─── Helper: one-way invoke wrapper ───────────────────────────
const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

// ─── Event subscription helper ────────────────────────────────
// Returns an unsubscribe function for cleanup
function on(channel, callback) {
  const handler = (_, data) => callback(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

function once(channel, callback) {
  ipcRenderer.once(channel, (_, data) => callback(data));
}

// ─── Exposed API ──────────────────────────────────────────────
contextBridge.exposeInMainWorld('api', {

  // ── Environment info ────────────────────────────────────────────────
  isDev: IS_DEV,

  // ── HTTP Fetching (bypasses CORS, preserves HTTP) ───────────
  fetchM3u:    (url)     => invoke('fetch-m3u',    { url }),
  fetchXtream: (url)     => invoke('fetch-xtream', { url }),
  fetchEpg:    (url)     => invoke('fetch-epg',    { url }),
  fetchImage:  (url)     => invoke('fetch-image',  { url }),

  /** Open URL in the default system browser */
  openExternal: (url) => invoke('open-external', { url }),

  // ── Window Controls (Frameless Titlebar) ───────────────────
  winMinimize:   () => ipcRenderer.send('win-minimize'),
  winMaximize:   () => ipcRenderer.send('win-maximize'),
  winClose:      () => ipcRenderer.send('win-close'),
  winIsMaximized: () => invoke('win-is-maximized'),

  /** Fired when window maximize state changes { maximized } */
  onWinMaximizeChange: (cb) => on('win-maximize-change', cb),

  /** Media key pressed from OS { key: 'playpause'|'stop'|'next'|'prev'|'volup'|'voldown' } */
  onMediaKey: (cb) => on('media-key', cb),

  // ── Auto-Update ─────────────────────────────────────────────
  onUpdateAvailable:   (cb) => on('update-available',   cb),
  onUpdateDownloaded:  (cb) => on('update-downloaded',  cb),
  onUpdateError:       (cb) => on('update-error',       cb),
  installUpdate: () => ipcRenderer.send('install-update'),

  // ── mpv Lifecycle ───────────────────────────────────────────

  /** Detect mpv, returns path string or null */
  mpvDetect: () => invoke('mpv-detect'),

  /**
   * Start mpv embedded in the Electron window.
   * @param {string|null} url - initial stream URL, or null for idle mode
   * @returns {{ ok: boolean, wid: number }}
   */
  // bounds = { x, y, w, h } in real screen pixels
  mpvStart:  (url = null, bounds = null) => invoke('mpv-start', { url, bounds }),
  mpvResize: (bounds) => invoke('mpv-resize', { bounds }),
  mpvHide:   () => invoke('mpv-hide'),
  mpvShow:   () => invoke('mpv-show'),
  getScreenInfo: () => invoke('get-screen-info'),

  /** Quit mpv gracefully */
  mpvQuit: () => invoke('mpv-quit'),

  // ── Playback Control ────────────────────────────────────────

  /**
   * Load a new file or stream.
   * @param {string} url
   * @param {'replace'|'append'|'append-play'} mode
   */
  mpvLoadfile: (url, mode = 'replace') => invoke('mpv-loadfile', { url, mode }),

  /** Toggle pause/play */
  mpvTogglePause: () => invoke('mpv-toggle-pause'),

  /**
   * Seek to position.
   * @param {number} position - seconds (absolute) or offset (relative)
   * @param {'absolute'|'relative'|'absolute-percent'} type
   */
  mpvSeek: (position, type = 'absolute') => invoke('mpv-seek', { position, type }),

  /** Set volume (0–100) */
  mpvSetVolume: (volume) => invoke('mpv-set-volume', { volume }),

  /** Toggle mute */
  mpvToggleMute: () => invoke('mpv-toggle-mute'),

  // ── Track Selection ─────────────────────────────────────────

  /** Get all audio and subtitle tracks */
  mpvGetTracks: () => invoke('mpv-get-tracks'),

  /** Select audio track by id ('no' to disable) */
  mpvSetAudioTrack: (id) => invoke('mpv-set-audio-track', { id }),

  /** Select subtitle track by id ('no' to disable) */
  mpvSetSubtitleTrack: (id) => invoke('mpv-set-subtitle-track', { id }),

  // ── Property Access ─────────────────────────────────────────

  /**
   * Get any mpv property.
   * Common props: 'time-pos', 'duration', 'volume', 'pause',
   *               'mute', 'aid', 'sid', 'track-list',
   *               'video-params', 'audio-params', 'filename'
   */
  mpvGetProperty: (prop) => invoke('mpv-get-property', { prop }),

  /** Set any mpv property */
  mpvSetProperty: (prop, value) => invoke('mpv-set-property', { prop, value }),

  /**
   * Observe a property — mpv will push 'mpv-property' events
   * whenever the value changes (e.g. time-pos for seek bar).
   */
  mpvObserve: (prop) => invoke('mpv-observe', { prop }),

  // ── Raw Command ─────────────────────────────────────────────

  /**
   * Send any mpv command directly.
   * @example window.api.mpvCommand('show-text', ['Hello', 3000])
   */
  mpvCommand: (command, args = []) => invoke('mpv-command', { command, args }),

  /** Take a screenshot (saved by mpv to default location) */
  mpvScreenshot: () => invoke('mpv-screenshot'),

  // ── VLC Fallback ────────────────────────────────────────────
  /** Check if VLC is installed and get its path */
  vlcCheck: () => invoke('vlc-check'),

  /** Open a URL in VLC (fallback if mpv not available) */
  vlcOpen: (url) => invoke('vlc-open', { url }),

  // ── Context Menu ────────────────────────────────────────────

  /**
   * Show a native OS context menu.
   * @param {Array<{id, label, enabled?, type?}>} items
   */
  showContextMenu: (items) => ipcRenderer.send('show-context-menu', { items }),

  // ── Event Listeners ─────────────────────────────────────────
  // All return an unsubscribe function: const unsub = api.onMpvProperty(cb); unsub();

  /** mpv socket connected and ready */
  onMpvSocketReady:     (cb) => on('mpv-socket-ready',     cb),

  /** mpv socket connection failed */
  onMpvSocketFailed:    (cb) => on('mpv-socket-failed',    cb),

  /** mpv socket runtime error */
  onMpvSocketError:     (cb) => on('mpv-socket-error',     cb),

  /** mpv not found on system */
  onMpvNotFound:        (cb) => on('mpv-not-found',        cb),

  /** mpv process exited (code, signal) */
  onMpvExited:          (cb) => on('mpv-exited',           cb),

  /** mpv process error */
  onMpvError:           (cb) => on('mpv-error',            cb),

  /** mpv is restarting after crash (attempt number) */
  onMpvRestarting:      (cb) => on('mpv-restarting',       cb),

  /** mpv gave up — use VLC instead */
  onMpvFallbackVlc:     (cb) => on('mpv-fallback-vlc',     cb),

  /** A watched property changed: { name, data } */
  onMpvProperty:        (cb) => on('mpv-property',         cb),

  /** Stream/file finished playing */
  onMpvEndFile:         (cb) => on('mpv-end-file',         cb),

  /** File loaded and first frame ready */
  onMpvFileLoaded:      (cb) => on('mpv-file-loaded',      cb),

  /** Playback restarted after seek or buffer */
  onMpvPlaybackRestart: (cb) => on('mpv-playback-restart', cb),

  /** Any other mpv event (raw) */
  onMpvEvent:           (cb) => on('mpv-event',            cb),

  /** Main window moved/resized — re-sync mpv position */
  onWinMoved:           (cb) => on('win-moved',            cb),

  /** Native context menu item clicked: { id } */
  onContextMenuClick:   (cb) => on('context-menu-click',   cb),

  /** Main process is about to quit — renderer should flush and call confirmFlush() */
  onAppQuitting:        (cb) => once('app-quitting',       cb),

  /** Notify main process that the renderer has finished flushing */
  confirmFlush: () => ipcRenderer.send('renderer-flush-done'),
});