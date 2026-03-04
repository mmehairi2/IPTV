// ─────────────────────────────────────────────────────────────────────────────
// util.js — Shared helpers: escaping, formatting, toast, emptyState, badges
// ─────────────────────────────────────────────────────────────────────────────

function esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function eu(s)  { return encodeURIComponent(s || ''); }
function ea(s)  { return String(s || '').replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }

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

function updateSrcIndicator(on, text) {
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

function watchlistKey(type, name) {
  return `${type}:${name}`;
}

function isInWatchlist(type, name) {
  return S.watchlist && S.watchlist.has(watchlistKey(type, name));
}

async function addToWatchlist(type, name) {
  const key = watchlistKey(type, name);
  S.watchlist.add(key);
  await DB.setMeta('watchlist', [...S.watchlist]);
}

async function removeFromWatchlist(type, name) {
  const key = watchlistKey(type, name);
  S.watchlist.delete(key);
  await DB.setMeta('watchlist', [...S.watchlist]);
}

// Lightweight performance instrumentation (dev only, no-throw)
function perfLog(label, payload = {}) {
  try {
    if (!window.api || !window.api.isDev) return;
    console.log('[perf]', label, payload);
  } catch (_) {}
}