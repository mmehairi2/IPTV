// ─────────────────────────────────────────────────────────────────────────────
// settings.js — Settings UI, export/import, source management
// ─────────────────────────────────────────────────────────────────────────────

// ── Appearance theme definitions ──────────────────────────────────────────────
const THEMES = {
  'dark-blue':  { bg: '#050a18', bg2: '#0a1020', bg3: '#10172b', bg4: '#181f35' },
  'pure-black': { bg: '#000000', bg2: '#0a0a0a', bg3: '#111111', bg4: '#191919' },
  'dark-grey':  { bg: '#0f0f0f', bg2: '#1a1a1a', bg3: '#1f1f1f', bg4: '#242424' },
  'midnight':   { bg: '#0d0d1a', bg2: '#13132a', bg3: '#16163a', bg4: '#1a1a3a' },
};

const CARD_SIZES  = { small: '140px', medium: '180px', large: '220px' };
const FONT_SIZES  = { small: '13px', normal: '14px', large: '16px' };

function applySettings() {
  const dp = document.getElementById('cfg-volume');
  if (dp) dp.value = S.settings.defaultVolume || 85;

  // Accent color
  const accent = S.settings.accentColor || '#3a7aff';
  document.documentElement.style.setProperty('--blue', accent);
  document.documentElement.style.setProperty('--blue-glow', accent + '59');

  // Background theme
  const theme = THEMES[S.settings.bgTheme || 'dark-blue'];
  if (theme) {
    document.documentElement.style.setProperty('--bg',   theme.bg);
    document.documentElement.style.setProperty('--bg-2', theme.bg2);
    document.documentElement.style.setProperty('--bg-3', theme.bg3);
    document.documentElement.style.setProperty('--bg-4', theme.bg4);
  }

  // Card size
  const cardW = CARD_SIZES[S.settings.cardSize || 'medium'];
  document.documentElement.style.setProperty('--card-min-width', cardW);

  // Font size
  const fontSize = FONT_SIZES[S.settings.fontSize || 'normal'];
  document.documentElement.style.setProperty('font-size', fontSize);
  document.documentElement.style.fontSize = fontSize;

  // Sidebar mode
  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    sidebar.classList.toggle('icon-only', S.settings.sidebarMode === 'icons');
  }
}

async function saveSetting(key, value) {
  S.settings[key] = value;
  await DB.setMeta('settings', S.settings);
}

function renderSettings() {
  applySettings();
  detectMpv();
  checkVLCStatus();

  if (S.source?.type === 'xtream') {
    document.getElementById('cfg-server').value = S.source.host || '';
    document.getElementById('cfg-user').value   = S.source.user || '';
  }

  const hwToggle = document.getElementById('hwdec-toggle');
  hwToggle.classList.toggle('on', S.settings.hwdec !== false);

  const volInput = document.getElementById('cfg-volume');
  if (volInput) volInput.value = S.settings.defaultVolume || 85;

  const playerSelect = document.getElementById('player-select');
  if (playerSelect) {
    playerSelect.value = S.settings.preferredPlayer || 'mpv';
    playerSelect.onchange = () => {
      saveSetting('preferredPlayer', playerSelect.value);
      toast(`Default player set to ${playerSelect.value.toUpperCase()}`, 'success');
    };
  }

  document.getElementById('save-source-btn').onclick    = connectXtream;
  document.getElementById('test-connection-btn').onclick = testConnection;
  document.getElementById('detect-mpv-btn').onclick     = detectMpv;
  document.getElementById('export-btn').onclick         = exportSettings;
  document.getElementById('import-btn').onclick         = importSettings;
  document.getElementById('clear-data-btn').onclick     = clearSource;

  renderAppearanceSection();

  // TMDB API key
  const tmdbInput = document.getElementById('cfg-tmdb-key');
  if (tmdbInput) {
    tmdbInput.value = S.settings.tmdbKey || '';
    tmdbInput.oninput = () => saveSetting('tmdbKey', tmdbInput.value.trim());
  }
  const tmdbTestBtn = document.getElementById('tmdb-test-btn');
  if (tmdbTestBtn) {
    tmdbTestBtn.onclick = async () => {
      const key = document.getElementById('cfg-tmdb-key')?.value.trim();
      const status = document.getElementById('tmdb-status');
      if (!key) { if (status) status.textContent = 'Enter an API key first.'; return; }
      tmdbTestBtn.disabled = true;
      tmdbTestBtn.textContent = 'Testing…';
      if (status) status.textContent = '';
      try {
        const result = await TMDB.searchMovie('Inception', key);
        if (result && result.id) {
          await saveSetting('tmdbKey', key);
          if (status) { status.textContent = '✓ Connected'; status.style.color = 'var(--green)'; }
          tmdbTestBtn.textContent = '✓ OK';
        } else {
          if (status) { status.textContent = '✗ Invalid key or no results'; status.style.color = 'var(--red)'; }
          tmdbTestBtn.textContent = 'Test';
        }
      } catch (e) {
        if (status) { status.textContent = '✗ ' + e.message; status.style.color = 'var(--red)'; }
        tmdbTestBtn.textContent = 'Test';
      }
      tmdbTestBtn.disabled = false;
    };
  }

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

  const checkVlcBtn = document.getElementById('check-vlc-btn');
  if (checkVlcBtn && typeof window.checkVLCStatus === 'function') {
    checkVlcBtn.onclick = () => window.checkVLCStatus();
  }
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
    epg_url:  epgUrl || null,
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
  input.type   = 'file';
  input.accept = '.json';
  input.onchange = async () => {
    try {
      const text = await input.files[0].text();
      const data = JSON.parse(text);
      if (data.source)   { S.source = data.source; await DB.setMeta('source', S.source); }
      if (data.settings) { S.settings = { ...S.settings, ...data.settings }; await DB.setMeta('settings', S.settings); }
      if (data.favs)     { S.favs = new Set(data.favs); await DB.setMeta('favs', data.favs); }
      if (data.epg_url)  { await DB.setMeta('epg_url', data.epg_url); }
      toast('Settings imported — reload to apply', 'success', 5000);
      renderSettings();
    } catch (e) { toast('Import failed: ' + e.message, 'error'); }
  };
  input.click();
}
// ── Appearance section ─────────────────────────────────────────────────────────
function renderAppearanceSection() {
  // Accent color swatches
  const accentContainer = document.getElementById('accent-swatches');
  if (accentContainer) {
    const currentAccent = S.settings.accentColor || '#3a7aff';
    accentContainer.querySelectorAll('.color-swatch').forEach(sw => {
      sw.classList.toggle('active', sw.dataset.accent === currentAccent);
      sw.onclick = () => {
        accentContainer.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
        sw.classList.add('active');
        saveSetting('accentColor', sw.dataset.accent);
        applySettings();
      };
    });
  }

  // Background theme swatches
  const themeContainer = document.getElementById('theme-swatches');
  if (themeContainer) {
    const currentTheme = S.settings.bgTheme || 'dark-blue';
    themeContainer.querySelectorAll('.theme-swatch').forEach(sw => {
      sw.classList.toggle('active', sw.dataset.theme === currentTheme);
      sw.onclick = () => {
        themeContainer.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
        sw.classList.add('active');
        saveSetting('bgTheme', sw.dataset.theme);
        applySettings();
      };
    });
  }

  // Toggle button groups (card size, font size, sidebar mode)
  document.querySelectorAll('.appear-toggle').forEach(btn => {
    const group = btn.dataset.group;
    const val   = btn.dataset.val;
    const current = S.settings[group] ||
      (group === 'cardSize' ? 'medium' : group === 'fontSize' ? 'normal' : 'full');
    btn.classList.toggle('active', val === current);
    btn.onclick = () => {
      // Deactivate siblings in same group
      document.querySelectorAll(`.appear-toggle[data-group="${group}"]`).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      saveSetting(group, val);
      applySettings();
    };
  });
}
