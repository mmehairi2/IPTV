// ============================================================
// main.js — Electron Main Process
// Phase 2: mpv as a borderless always-on-top window
// No --wid embedding (unreliable on Windows + Electron GPU)
// mpv floats over the player div, positioned via screen coords
// ============================================================

const { app, BrowserWindow, ipcMain, Menu, screen, shell, globalShortcut, protocol, net } = require('electron');
const path   = require('path');
const fs     = require('fs');
const http   = require('http');
const https  = require('https');
const { spawn, execFile, exec } = require('child_process');
const netMod = require('net');
const os     = require('os');

// ─── imgproxy:// protocol ─────────────────────────────────────────────────────
// Allows the renderer (file:// origin) to load http:// images without Mixed
// Content blocking. Usage: imgproxy://fetch?url=<encodeURIComponent(imageUrl)>
// Registered before app ready as required by Electron.
protocol.registerSchemesAsPrivileged([{
  scheme: 'imgproxy',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

// ─── Auto Updater (safe require — not available in dev) ───────
let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
} catch (_) {
  console.log('[updater] electron-updater not available');
}

function setupAutoUpdater() {
  if (!autoUpdater) return;
  autoUpdater.on('update-available',  info => mainWindow?.webContents.send('update-available',  info));
  autoUpdater.on('update-downloaded', info => mainWindow?.webContents.send('update-downloaded', info));
  autoUpdater.on('error',             err  => mainWindow?.webContents.send('update-error', { message: err.message }));
  // Check after 3s to let the app finish loading
  setTimeout(() => { try { autoUpdater.checkForUpdates(); } catch (_) {} }, 3000);
}

ipcMain.on('install-update', () => { try { autoUpdater?.quitAndInstall(); } catch (_) {} });

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const SOCK   = IS_WIN ? '\\\\.\\pipe\\mpvsocket' : '/tmp/mpvsocket';

// ─── Window State ─────────────────────────────────────────────
let WIN_STATE_FILE = null;
function getStateFile() {
  if (!WIN_STATE_FILE) WIN_STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
  return WIN_STATE_FILE;
}

function loadWindowState() {
  try {
    const raw = fs.readFileSync(getStateFile(), 'utf8');
    const s = JSON.parse(raw);
    if (s && s.width && s.height) return s;
  } catch (_) {}
  return { width: 1280, height: 800 };
}

function saveWindowState() {
  if (!mainWindow) return;
  try {
    const maximized = mainWindow.isMaximized();
    const bounds = mainWindow.getBounds();
    const state = maximized
      ? { ...bounds, maximized: true }
      : { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, maximized: false };
    fs.writeFileSync(getStateFile(), JSON.stringify(state), 'utf8');
  } catch (_) {}
}

function validateBounds(state) {
  if (!state.x || !state.y) return state;
  try {
    const displays = screen.getAllDisplays();
    const onScreen = displays.some(d => {
      const b = d.workArea;
      return state.x >= b.x - 50 && state.y >= b.y - 50
          && state.x < b.x + b.width && state.y < b.y + b.height;
    });
    if (!onScreen) { delete state.x; delete state.y; }
  } catch (_) {}
  return state;
}

let mainWindow  = null;
let mpvProcess  = null;
let mpvSocket   = null;
let mpvReady    = false;
let mpvPath     = null;
let mpvRetries  = 0;
let mpvQueue    = [];
let reqId       = 1;
let pending     = new Map();
let sockBuf     = '';

// ─── Detect mpv ───────────────────────────────────────────────
async function detectMpv() {
  const list = IS_WIN ? [
    path.join(__dirname, 'mpv.exe'),
    path.join(process.cwd(), 'mpv.exe'),
    'mpv.exe',
    'C:\\Program Files\\mpv\\mpv.exe',
    'C:\\Program Files (x86)\\mpv\\mpv.exe',
    path.join(os.homedir(), 'AppData\\Local\\Programs\\mpv\\mpv.exe'),
    path.join(app.getPath('userData'), 'mpv\\mpv.exe'),
    path.join(path.dirname(app.getPath('exe')), 'mpv.exe'),
  ] : IS_MAC ? [
    'mpv', '/usr/local/bin/mpv', '/opt/homebrew/bin/mpv', '/usr/bin/mpv',
  ] : ['mpv', '/usr/bin/mpv', '/usr/local/bin/mpv'];

  for (const c of list) {
    const found = await probe(c);
    if (found) { console.log('[mpv] Found:', found); return found; }
  }
  return null;
}

function probe(exe) {
  return new Promise(res =>
    execFile(exe, ['--version'], { timeout: 5000 },
      (err, out) => res(!err && out ? exe : null))
  );
}

// ─── Spawn mpv ────────────────────────────────────────────────
// mpv runs as a normal borderless ontop window.
// We tell it where to appear via --geometry=WxH+X+Y
// using real screen pixel coordinates.
async function spawnMpv(url, bounds) {
  if (mpvProcess) { killMpv(); await sleep(400); }

  if (!mpvPath) mpvPath = await detectMpv();
  if (!mpvPath) {
    mainWindow?.webContents.send('mpv-not-found');
    return false;
  }

  if (!IS_WIN && fs.existsSync(SOCK)) {
    try { fs.unlinkSync(SOCK); } catch (_) {}
  }

  const geo = bounds
    ? `${Math.round(bounds.w)}x${Math.round(bounds.h)}+${Math.round(bounds.x)}+${Math.round(bounds.y)}`
    : '1280x720+100+100';

  console.log('[mpv] Spawning with geometry:', geo);

  const args = [
    `--geometry=${geo}`,
    '--no-border',
    '--ontop',
    ...(IS_WIN ? ['--ontop-level=system'] : []),
    '--keepaspect-window=no',  // This prevents letterboxing
    '--keep-open=yes',
    '--idle=yes',
    '--force-window=immediate',
    // REMOVE: '--window-type=utility',      // Invalid, already removed
    // REMOVE: '--focus-on-open=no',         // Deprecated/removed, causes error
    '--vo=gpu',
    '--hwdec=auto-safe',
    '--cache=yes',
    '--cache-secs=30',
    '--demuxer-max-bytes=150MiB',
    `--input-ipc-server=${SOCK}`,
    '--really-quiet',
    '--msg-level=all=warn',
    '--no-osc',
    '--no-input-default-bindings',
    // REMOVE: '--no-focus-on-open',        // Invalid equivalent, causes error
    '--window-minimized=yes',              // Start hidden; mpv-show reveals it when ready
    ...(url ? [url] : []),
  ];

  mpvProcess = spawn(mpvPath, args, { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });

  mpvProcess.stdout.on('data', d => { const s = d.toString().trim(); if (s) console.log('[mpv]', s); });
  mpvProcess.stderr.on('data', d => { const s = d.toString().trim(); if (s) console.warn('[mpv stderr]', s); });

  mpvProcess.on('exit', (code, sig) => {
    console.log(`[mpv] Exit code=${code}`);
    mpvReady = false; mpvSocket = null;
    mainWindow?.webContents.send('mpv-exited', { code, signal: sig });
    if (code !== 0 && code !== null) handleCrash();
  });

  mpvProcess.on('error', err => {
    console.error('[mpv] Spawn error:', err.message);
    mainWindow?.webContents.send('mpv-error', { message: err.message });
  });

  await sleep(600);
  if (IS_WIN && mainWindow) mainWindow.focus();  // ADD THIS: Restore focus to Electron window if mpv steals it
  await connectSocket();
  return true;
}

function handleCrash() {
  if (mpvRetries >= 3) {
    mpvRetries = 0;
    mainWindow?.webContents.send('mpv-fallback-vlc');
    return;
  }
  mpvRetries++;
  setTimeout(() => {
    mainWindow?.webContents.send('mpv-restarting', { attempt: mpvRetries });
    spawnMpv(null, null);
  }, 2000);
}

// ─── Socket ───────────────────────────────────────────────────
async function connectSocket(tries = 6) {
  for (let i = 0; i < tries; i++) {
    try { await tryConnect(); return; }
    catch (e) {
      console.warn(`[mpv socket] Attempt ${i + 1}: ${e.message}`);
      if (i < tries - 1) await sleep(500);
    }
  }
  mainWindow?.webContents.send('mpv-socket-failed');
}

function tryConnect() {
  return new Promise((resolve, reject) => {
    const client = new netMod.Socket();
    let ok = false;

    client.connect({ path: SOCK }, () => {
      ok = true; mpvSocket = client; mpvReady = true; mpvRetries = 0;
      console.log('[mpv socket] Connected');
      mainWindow?.webContents.send('mpv-socket-ready');
      while (mpvQueue.length) rawSend(mpvQueue.shift());
      resolve();
    });

    client.on('data', buf => {
      sockBuf += buf.toString();
      const lines = sockBuf.split('\n');
      sockBuf = lines.pop();
      for (const l of lines) {
        if (!l.trim()) continue;
        try { dispatch(JSON.parse(l)); } catch (_) {}
      }
    });

    client.on('error', err => {
      if (!ok) reject(err);
      else { mpvReady = false; mainWindow?.webContents.send('mpv-socket-error', { message: err.message }); }
    });

    client.on('close', () => { mpvReady = false; mpvSocket = null; console.log('[mpv socket] Closed'); });

    setTimeout(() => { if (!ok) { client.destroy(); reject(new Error('Connect timeout')); } }, 2000);
  });
}

function dispatch(msg) {
  if (msg.request_id != null && pending.has(msg.request_id)) {
    const { resolve, reject, t } = pending.get(msg.request_id);
    clearTimeout(t); pending.delete(msg.request_id);
    msg.error === 'success' ? resolve(msg.data) : reject(new Error(msg.error));
    return;
  }
  if (!msg.event) return;
  switch (msg.event) {
    case 'property-change': mainWindow?.webContents.send('mpv-property', { name: msg.name, data: msg.data }); break;
    case 'end-file':        mainWindow?.webContents.send('mpv-end-file', { reason: msg.reason }); break;
    case 'file-loaded':     mainWindow?.webContents.send('mpv-file-loaded'); mpvRetries = 0; break;
    case 'playback-restart':mainWindow?.webContents.send('mpv-playback-restart'); break;
    default:                mainWindow?.webContents.send('mpv-event', msg);
  }
}

function rawSend(json) {
  if (!mpvSocket || !mpvReady) return false;
  try { mpvSocket.write(json + '\n'); return true; }
  catch (e) { return false; }
}

function cmd(command, ...args) {
  return new Promise((resolve, reject) => {
    const id = reqId++;
    const payload = JSON.stringify({ command: [command, ...args], request_id: id });
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${command}`)); }, 5000);
    pending.set(id, { resolve, reject, t });
    if (!rawSend(payload)) { mpvQueue.push(payload); clearTimeout(t); pending.delete(id); resolve(null); }
  });
}

function getProp(prop) {
  return new Promise((resolve, reject) => {
    const id = reqId++;
    const payload = JSON.stringify({ command: ['get_property', prop], request_id: id });
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${prop}`)); }, 3000);
    pending.set(id, { resolve, reject, t });
    if (!rawSend(payload)) { clearTimeout(t); pending.delete(id); resolve(null); }
  });
}

function observe(prop) {
  rawSend(JSON.stringify({ command: ['observe_property', reqId++, prop], request_id: reqId++ }));
}

function killMpv() {
  mpvReady = false;
  if (mpvSocket) { try { mpvSocket.destroy(); } catch (_) {} mpvSocket = null; }
  if (mpvProcess) {
    try { mpvProcess.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => { try { mpvProcess?.kill('SIGKILL'); } catch (_) {} }, 800);
    mpvProcess = null;
  }
  if (!IS_WIN && fs.existsSync(SOCK)) { try { fs.unlinkSync(SOCK); } catch (_) {} }
}

// ─── Window ───────────────────────────────────────────────────
const ICON_PATH = IS_WIN
  ? path.join(__dirname, '../assets/icon.ico')
  : path.join(__dirname, '../assets/icon.png');

function createWindow() {
  const savedBounds = validateBounds(loadWindowState());

  mainWindow = new BrowserWindow({
    width: savedBounds.width   || 1280,
    height: savedBounds.height || 800,
    x: savedBounds.x,
    y: savedBounds.y,
    minWidth: 960, minHeight: 600,
    backgroundColor: '#050a18',
    frame: false,
    titleBarStyle: 'hidden',
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });

  if (savedBounds.maximized) mainWindow.maximize();

  mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));

  // Save state on move/resize/close
  ['move', 'resize'].forEach(ev => mainWindow.on(ev, () => {
    saveWindowState();
    mainWindow?.webContents.send('win-moved');
  }));
  mainWindow.on('maximize',   () => mainWindow?.webContents.send('win-maximize-change', { maximized: true }));
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('win-maximize-change', { maximized: false }));

  mainWindow.on('closed', () => { saveWindowState(); killMpv(); mainWindow = null; });
  setupContextMenu();
}

// ─── Titlebar IPC ─────────────────────────────────────────────
ipcMain.on('win-minimize', () => mainWindow?.minimize());
ipcMain.on('win-maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('win-close',    () => mainWindow?.close());
ipcMain.handle('win-is-maximized', () => mainWindow?.isMaximized() ?? false);

// ─── Media Keys ───────────────────────────────────────────────
function registerMediaKeys() {
  const { globalShortcut } = require('electron');
  const fwd = (ch, payload) => mainWindow?.webContents.send(ch, payload);

  const keys = {
    'MediaPlayPause':     () => fwd('media-key', { key: 'playpause' }),
    'MediaStop':          () => fwd('media-key', { key: 'stop' }),
    'MediaNextTrack':     () => fwd('media-key', { key: 'next' }),
    'MediaPreviousTrack': () => fwd('media-key', { key: 'prev' }),
    'VolumeUp':           () => fwd('media-key', { key: 'volup' }),
    'VolumeDown':         () => fwd('media-key', { key: 'voldown' }),
  };

  for (const [accel, handler] of Object.entries(keys)) {
    try { globalShortcut.register(accel, handler); } catch (_) {}
  }
}

function unregisterMediaKeys() {
  try { require('electron').globalShortcut.unregisterAll(); } catch (_) {}
}

// ─── Navigation hardening ──────────────────────────────────────────────
// Prevent untrusted http(s) content from loading inside the app window.
// Open any external links in the user's default browser instead.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    // Allow local file:// navigations (e.g. our bundled UI), block http(s)
    if (url.startsWith('http:') || url.startsWith('https:')) {
      event.preventDefault();
      shell.openExternal(url).catch(err =>
        console.warn('[shell] Failed to open external URL:', err?.message || err)
      );
    }
  });

  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url).catch(err =>
        console.warn('[shell] Failed to open external URL (window.open):', err?.message || err)
      );
    }
    return { action: 'deny' };
  });
});

// ─── IPC ──────────────────────────────────────────────────────
ipcMain.handle('mpv-detect', async () => { mpvPath = await detectMpv(); return mpvPath; });

ipcMain.handle('mpv-hide', async () => {
  // Guard: only send if socket is still alive (don't fire after mpv-quit)
  if (mpvReady && mpvSocket) {
    rawSend(JSON.stringify({
      command: ['set_property', 'window-minimized', true],
      request_id: reqId++,
    }));
  }
  return { ok: true };
});

ipcMain.handle('mpv-show', async () => {
  if (mpvReady) {
    rawSend(JSON.stringify({
      command: ['set_property', 'window-minimized', false],
      request_id: reqId++,
    }));
  }
  return { ok: true };
});

// bounds = { x, y, w, h } in real screen pixels
ipcMain.handle('mpv-start', async (_, { url, bounds }) => {
  const ok = await spawnMpv(url || null, bounds || null);
  return { ok };
});

// Move/resize the mpv window to new screen coords - FIXED VERSION
ipcMain.handle('mpv-resize', async (_, { bounds }) => {
  if (!mpvReady || !bounds) return;
  const { x, y, w, h } = bounds;
  
  // First ensure not maximized
  rawSend(JSON.stringify({
    command: ['set_property', 'window-maximized', false],
    request_id: reqId++,
  }));
  
  // Set geometry directly (more reliable than script-message)
  rawSend(JSON.stringify({
    command: ['set_property', 'geometry', `${Math.round(w)}x${Math.round(h)}+${Math.round(x)}+${Math.round(y)}`],
    request_id: reqId++,
  }));
  
  // Also set window-scale to force filling the area
  rawSend(JSON.stringify({
    command: ['set_property', 'window-scale', 1],
    request_id: reqId++,
  }));
  
  // Disable aspect ratio locking again to be safe
  rawSend(JSON.stringify({
    command: ['set_property', 'keepaspect-window', false],
    request_id: reqId++,
  }));
});

ipcMain.handle('mpv-quit',   async () => { try { await cmd('quit'); } catch (_) {} setTimeout(killMpv, 400); return { ok: true }; });
ipcMain.handle('mpv-loadfile',  async (_, { url, mode = 'replace' }) => { await cmd('loadfile', url, mode); return { ok: true }; });
ipcMain.handle('mpv-command',   async (_, { command, args = [] }) => { try { return { ok: true, data: await cmd(command, ...args) }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('mpv-get-property', async (_, { prop }) => { try { return { ok: true, value: await getProp(prop) }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('mpv-set-property', async (_, { prop, value }) => { rawSend(JSON.stringify({ command: ['set_property', prop, value], request_id: reqId++ })); return { ok: true }; });
ipcMain.handle('mpv-observe',      async (_, { prop }) => { observe(prop); return { ok: true }; });
ipcMain.handle('mpv-toggle-pause', async () => { await cmd('cycle', 'pause'); return { ok: true }; });
ipcMain.handle('mpv-seek',         async (_, { position, type = 'absolute' }) => { await cmd('seek', position, type); return { ok: true }; });
ipcMain.handle('mpv-set-volume',   async (_, { volume }) => { await cmd('set_property', 'volume', Math.max(0, Math.min(100, volume))); return { ok: true }; });
ipcMain.handle('mpv-toggle-mute',  async () => { await cmd('cycle', 'mute'); return { ok: true }; });
ipcMain.handle('mpv-set-audio-track',    async (_, { id }) => { await cmd('set_property', 'aid', id); return { ok: true }; });
ipcMain.handle('mpv-set-subtitle-track', async (_, { id }) => { await cmd('set_property', 'sid', id); return { ok: true }; });
ipcMain.handle('mpv-get-tracks',   async () => { try { return { ok: true, tracks: await getProp('track-list') }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('mpv-screenshot',   async () => { await cmd('screenshot', 'video'); return { ok: true }; });

// ─── Screen info ──────────────────────────────────────────────
// getContentBounds() = content area position excluding title bar/chrome
ipcMain.handle('get-screen-info', async () => {
  if (!mainWindow) return { scaleFactor: 1, winX: 0, winY: 0, winW: 1280, winH: 800 };
  const b = mainWindow.getContentBounds();
  const d = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
  console.log('[screen] content bounds:', b.x, b.y, b.width, b.height, 'dpi:', d.scaleFactor);
  return { scaleFactor: d.scaleFactor, winX: b.x, winY: b.y, winW: b.width, winH: b.height };
});

// ─── Fetch ────────────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise(resolve => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 30000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ ok: true, status: res.statusCode, data }));
    });
    req.on('error', err => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timeout' }); });
  });
}

ipcMain.handle('fetch-m3u',    (_, { url }) => fetchUrl(url));
ipcMain.handle('fetch-xtream', (_, { url }) => fetchUrl(url));
ipcMain.handle('fetch-epg',    (_, { url }) => fetchUrl(url));

// Fetch image bytes via Node — bypasses renderer Mixed Content / CORS restrictions
// Returns { ok, data: base64string, mime } or { ok: false, error }
ipcMain.handle('fetch-image', (_, { url }) => {
  return new Promise(resolve => {
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      return resolve({ ok: false, error: 'Invalid URL' });
    }
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Stream/1.0)' },
    }, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return resolve({ ok: false, error: 'HTTP ' + res.statusCode });
      }
      const mime = res.headers['content-type'] || 'image/jpeg';
      if (!mime.startsWith('image/')) {
        res.resume();
        return resolve({ ok: false, error: 'Not an image' });
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const b64 = Buffer.concat(chunks).toString('base64');
        resolve({ ok: true, data: b64, mime });
      });
    });
    req.on('error',   err => resolve({ ok: false, error: err.message }));
    req.on('timeout', ()  => { req.destroy(); resolve({ ok: false, error: 'Timeout' }); });
  });
});

ipcMain.handle('open-external', (_, { url }) => {
  if (url && (url.startsWith('http:') || url.startsWith('https:'))) {
    return shell.openExternal(url).then(() => ({ ok: true })).catch(err => ({ ok: false, error: err?.message }));
  }
  return { ok: false, error: 'Invalid URL' };
});

// ─── VLC ──────────────────────────────────────────────────────
let vlcProcess = null;

ipcMain.handle('vlc-check', async () => {
  const vlcPath = await findVLC();
  return { found: !!vlcPath, path: vlcPath };
});

ipcMain.handle('vlc-close', async () => {
  if (vlcProcess) {
    try { vlcProcess.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => { try { vlcProcess?.kill('SIGKILL'); } catch (_) {} }, 800);
    vlcProcess = null;
  }
  return { ok: true };
});

// Helper function to resolve Windows shortcuts (.lnk files)
async function resolveShortcut(shortcutPath) {
  return new Promise((resolve) => {
    if (!IS_WIN) {
      resolve(null);
      return;
    }
    
    // Use PowerShell to resolve the shortcut target
    const psCommand = `
      $shell = New-Object -ComObject WScript.Shell
      $shortcut = $shell.CreateShortcut('${shortcutPath.replace(/\\/g, '\\\\')}')
      Write-Output $shortcut.TargetPath
    `;
    
    exec(`powershell -Command "${psCommand}"`, (error, stdout, stderr) => {
      if (error) {
        console.warn('[VLC] Failed to resolve shortcut:', error.message);
        resolve(null);
        return;
      }
      
      const targetPath = stdout.trim();
      if (targetPath && fs.existsSync(targetPath)) {
        console.log('[VLC] Resolved shortcut to:', targetPath);
        resolve(targetPath);
      } else {
        resolve(null);
      }
    });
  });
}

// Open URL in VLC
ipcMain.handle('vlc-open', async (_, { url }) => {
  // Skip actual open for probe calls
  if (url === '__probe__') {
    const vlcPath = await findVLC();
    return { ok: !!vlcPath, path: vlcPath };
  }

  const vlcPath = await findVLC();
  
  if (!vlcPath) {
    return { ok: false, error: 'VLC not found. Please install VLC from https://videolan.org' };
  }

  try {
    console.log('[VLC] Opening with:', vlcPath, url);
    
    let executablePath = vlcPath;
    
    // If it's a shortcut on Windows, try to resolve the actual executable
    if (IS_WIN && vlcPath.endsWith('.lnk')) {
      executablePath = await resolveShortcut(vlcPath);
      if (!executablePath) {
        // Fallback: try common VLC executable locations
        const fallbackPaths = [
          'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
          'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe',
          path.join(process.env.LOCALAPPDATA || '', 'Programs\\VideoLAN\\VLC\\vlc.exe'),
        ];
        
        for (const fallback of fallbackPaths) {
          if (fs.existsSync(fallback)) {
            executablePath = fallback;
            break;
          }
        }
      }
    }
    
    if (!executablePath || !fs.existsSync(executablePath)) {
      return { ok: false, error: 'VLC executable not found' };
    }
    
    // On macOS, spawning the .app binary directly doesn't show a window.
    // Use the 'open' command which launches the .app properly.
    if (IS_MAC) {
      const proc = spawn('open', ['-a', 'VLC', url], { detached: true, stdio: 'ignore' });
      proc.unref();
      return { ok: true, path: executablePath };
    }

    // Windows/Linux: spawn VLC directly as a normal GUI app
    const proc = spawn(executablePath, [url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      shell: false,
    });
    proc.unref();
    
    return { ok: true, path: executablePath };
  } catch (err) {
    console.error('[VLC] Spawn error:', err);
    return { ok: false, error: err.message };
  }
});

// Helper function to find VLC
async function findVLC() {
  // On macOS, VLC binary ignores --version so probe() fails. Use existsSync instead.
  if (IS_MAC) {
    const macPaths = [
      '/Applications/VLC.app/Contents/MacOS/VLC',
      require('path').join(require('os').homedir(), 'Applications/VLC.app/Contents/MacOS/VLC'),
      '/usr/local/bin/vlc',
      '/opt/homebrew/bin/vlc',
    ];
    for (const p of macPaths) {
      if (require('fs').existsSync(p)) {
        console.log('[VLC] Found on macOS at:', p);
        return p;
      }
    }
    return null;
  }

  // Windows / Linux: probe() works fine
  const exePaths = IS_WIN ? [
    // Standard Program Files locations
    'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
    'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe',
    
    // Local AppData locations
    path.join(process.env.LOCALAPPDATA || '', 'Programs\\VideoLAN\\VLC\\vlc.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'VideoLAN\\VLC\\vlc.exe'),
    
    // User home directory
    path.join(os.homedir(), 'AppData\\Local\\Programs\\VideoLAN\\VLC\\vlc.exe'),
    path.join(os.homedir(), 'AppData\\Local\\VideoLAN\\VLC\\vlc.exe'),
    
    // In PATH
    'vlc.exe',
    
    // In app directory
    path.join(__dirname, 'vlc.exe'),
    path.join(process.cwd(), 'vlc.exe'),
  ] : IS_MAC ? [
    '/Applications/VLC.app/Contents/MacOS/VLC',
    '/applications/VLC.app/Contents/MacOS/VLC',
    '/usr/local/bin/vlc',
    '/opt/homebrew/bin/vlc',
  ] : [
    'vlc',
    '/usr/bin/vlc',
    '/usr/local/bin/vlc',
  ];

  // Add Program Files from environment
  if (IS_WIN) {
    if (process.env.PROGRAMFILES) {
      exePaths.push(path.join(process.env.PROGRAMFILES, 'VideoLAN\\VLC\\vlc.exe'));
    }
    if (process.env['PROGRAMFILES(X86)']) {
      exePaths.push(path.join(process.env['PROGRAMFILES(X86)'], 'VideoLAN\\VLC\\vlc.exe'));
    }
  }

  // Remove duplicates
  const uniquePaths = [...new Set(exePaths)];

  // First check all executable paths
  for (const p of uniquePaths) {
    try {
      if (await probe(p)) {
        console.log('[VLC] Found executable at:', p);
        return p;
      }
    } catch (err) {
      // Ignore errors
    }
  }

  // If no executable found, try shortcut paths as last resort
  if (IS_WIN) {
    const shortcutPaths = [
      'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\VideoLAN\\VLC media player.lnk',
      path.join(os.homedir(), 'AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\VideoLAN\\VLC media player.lnk'),
    ];
    
    for (const shortcut of shortcutPaths) {
      if (fs.existsSync(shortcut)) {
        console.log('[VLC] Found shortcut at:', shortcut);
        return shortcut; // Return shortcut path - we'll resolve it when opening
      }
    }
  }

  // On Windows, try 'where' command as last resort
  if (IS_WIN) {
    try {
      const { stdout } = await new Promise((resolve, reject) => {
        exec('where vlc', (err, stdout, stderr) => {
          if (err) reject(err);
          else resolve({ stdout });
        });
      });
      const lines = stdout.split('\n').filter(l => l.trim() && l.includes('vlc.exe'));
      if (lines.length > 0) {
        console.log('[VLC] Found via where command:', lines[0].trim());
        return lines[0].trim();
      }
    } catch (err) {
      // 'where' command failed
    }
  }

  return null;
}

// ─── Context menu ─────────────────────────────────────────────
function setupContextMenu() {
  ipcMain.on('show-context-menu', (event, { items }) => {
    const menu = Menu.buildFromTemplate(items.map(i =>
      i.type === 'separator' ? { type: 'separator' }
        : { label: i.label, enabled: i.enabled !== false,
            click: () => event.sender.send('context-menu-click', { id: i.id }) }
    ));
    menu.popup({ window: BrowserWindow.fromWebContents(event.sender) });
  });
}

// ─── Lifecycle ────────────────────────────────────────────────
app.whenReady().then(() => {
  // ── imgproxy:// — proxies http(s) image URLs through Node to bypass Mixed Content ──
  protocol.handle('imgproxy', (request) => {
    try {
      const reqUrl  = new URL(request.url);
      const target  = decodeURIComponent(reqUrl.searchParams.get('url') || '');
      if (!target.startsWith('http://') && !target.startsWith('https://')) {
        return new Response('Bad URL', { status: 400 });
      }
      // Use Electron's net module (not Node's http) — it respects session settings
      return net.fetch(target, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Stream/1.0)' },
      });
    } catch (e) {
      return new Response('Error: ' + e.message, { status: 500 });
    }
  });

  createWindow();
  registerMediaKeys();
  setupAutoUpdater();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { unregisterMediaKeys(); if (!IS_MAC) app.quit(); });

app.on('before-quit', async (e) => {
  // Signal the renderer to flush playback position before we kill mpv.
  // We prevent the default quit, wait up to 2s for the renderer to confirm,
  // then kill mpv and allow quit to proceed.
  if (!mainWindow) { killMpv(); return; }

  e.preventDefault();

  const flushTimeout = setTimeout(() => {
    console.warn('[quit] Renderer flush timed out — forcing quit');
    killMpv();
    app.exit(0);
  }, 2000);

  ipcMain.once('renderer-flush-done', () => {
    clearTimeout(flushTimeout);
    killMpv();
    app.exit(0);
  });

  mainWindow.webContents.send('app-quitting');
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }