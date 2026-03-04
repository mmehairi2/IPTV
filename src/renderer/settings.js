// ─────────────────────────────────────────────────────────────────────────────
// settings.js — Settings UI, export/import, source management
// ─────────────────────────────────────────────────────────────────────────────

function applySettings() {
  const dp = document.getElementById('cfg-volume');
  if (dp) dp.value = S.settings.defaultVolume || 85;
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