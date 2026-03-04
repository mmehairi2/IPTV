// ─────────────────────────────────────────────────────────────────────────────
// xtream.js — Xtream Codes API: connect, load, fetch helpers
// ─────────────────────────────────────────────────────────────────────────────

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