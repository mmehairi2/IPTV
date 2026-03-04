// ─────────────────────────────────────────────────────────────────────────────
// epg.js — EPG parsing, loading, timeline grid render, controls
// ─────────────────────────────────────────────────────────────────────────────

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
  if (!rawUrl) { toast('Enter EPG URL in Settings', 'error'); return; }
  const url = rawUrl.startsWith('http') ? rawUrl : `http://${rawUrl}`;
  const container = document.getElementById('epg-grid-container');
  if (container) container.innerHTML = '<div class="epg-loading"><div class="player-spinner"></div><div>Loading EPG data…</div></div>';
  try {
    const res = await api.fetchEpg(url);
    if (!res.data) throw new Error('Empty response');
    parseEPG(res.data);
    await DB.setMeta('epg_url', url);
    await DB.setMeta('epg', S.epg);
    const chCount = Object.keys(S.epgFull || S.epg).length;
    toast(`EPG loaded: ${chCount} channels`, 'success');
    if (document.getElementById('page-live').classList.contains('active')) renderLive();
    if (document.getElementById('page-epg').classList.contains('active')) renderEPGGrid();
  } catch (e) {
    toast('EPG failed: ' + e.message, 'error');
    if (container) container.innerHTML = '<div class="epg-loading">⚠️ Failed to load EPG</div>';
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
    const desc  = p.querySelector('desc')?.textContent  || '';
    const cat   = p.querySelector('category')?.textContent || '';
    if (!ch || !start || !stop) return;
    if (!tmp[ch]) tmp[ch] = [];
    tmp[ch].push({ start, stop, title, desc, cat });
  });

  // Sort each channel's programmes by start time
  for (const ch of Object.keys(tmp)) {
    tmp[ch].sort((a, b) => a.start - b.start);
  }

  // Store full schedule for timeline grid
  S.epgFull = tmp;

  // Also build now/next for card labels (existing behaviour)
  S.epg = {};
  for (const [ch, progs] of Object.entries(tmp)) {
    const nowP  = progs.find(p => p.start <= now && p.stop > now);
    const nextP = progs.find(p => p.start > now);
    if (nowP || nextP) S.epg[ch] = { now: nowP, next: nextP };
  }
}

function parseEPGDate(str) {
  if (!str) return 0;
  const m = str.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/);
  if (!m) return 0;
  // Handle timezone offset
  const tz  = m[7] || '+0000';
  const tzH = parseInt(tz.slice(0, 3));
  const tzM = parseInt(tz[0] + tz.slice(4));
  const utc = Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]);
  return utc - tzH * 3600000 - tzM * 60000;
}

function getEPG(id) {
  if (!id) return {};
  return S.epg[id] || S.epg[id.toLowerCase()] || {};
}

// ═════════════════════════════════════════════════════════════════════════════
// EPG TIMELINE GRID — Phase 3
// ═════════════════════════════════════════════════════════════════════════════

// State
const EPG_ROW_HEIGHT = 56;
const EPG_VIRTUAL_BUFFER = 5;
const EPG_STATE = {
  zoomHours:  1,        // how many hours visible in viewport
  offsetMs:   0,        // scroll offset from now in ms (negative = past)
  filter:     '',
  rows:       [],       // channel rows for current render (for virtualization)
  rowParams:  null,    // { firstSlot, totalPx, viewStart, viewEnd, pxPerMs, now, timeSlots }
};

// pixels per millisecond (recalculated from zoom)
function epgPxPerMs() {
  const vpW = (document.getElementById('epg-grid-container')?.clientWidth || 900) - 180;
  return vpW / (EPG_STATE.zoomHours * 3600000);
}

function setupEPGControls() {
  // Zoom buttons
  document.querySelectorAll('.epg-zoom-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.epg-zoom-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      EPG_STATE.zoomHours = parseInt(btn.dataset.zoom);
      renderEPGGrid();
    });
  });

  // Now button — jump to current time
  document.getElementById('epg-now-btn')?.addEventListener('click', () => {
    EPG_STATE.offsetMs = 0;
    renderEPGGrid();
    setTimeout(() => scrollEPGToNow(), 100);
  });

  // Earlier / Later
  document.getElementById('epg-prev-btn')?.addEventListener('click', () => {
    EPG_STATE.offsetMs -= EPG_STATE.zoomHours * 3600000 * 0.75;
    renderEPGGrid();
  });
  document.getElementById('epg-next-btn')?.addEventListener('click', () => {
    EPG_STATE.offsetMs += EPG_STATE.zoomHours * 3600000 * 0.75;
    renderEPGGrid();
  });

  // Search filter
  document.getElementById('epg-search')?.addEventListener('input', e => {
    EPG_STATE.filter = e.target.value.trim().toLowerCase();
    renderEPGGrid();
  });

  // Refresh
  document.getElementById('epg-refresh-btn')?.addEventListener('click', () => loadEPG());
}

function scrollEPGToNow() {
  const container = document.getElementById('epg-grid-container');
  if (!container) return;
  // now-line is positioned relative to the start of the timeline
  const pxPerMs = epgPxPerMs();
  const nowOffset = -EPG_STATE.offsetMs * pxPerMs;
  container.scrollLeft = Math.max(0, nowOffset + 180 - (container.clientWidth / 2));
}

function renderEPGGrid() {
  const container = document.getElementById('epg-grid-container');
  if (!container) return;

  const epgFull = S.epgFull || {};
  const channels = S.channels;

  // Get channels that have EPG data, filtered by search
  const filter = EPG_STATE.filter;
  const rows = channels.filter(ch => {
    const key = ch.tvgId || ch.name;
    if (filter && !ch.name.toLowerCase().includes(filter)) return false;
    return epgFull[key] || epgFull[key?.toLowerCase()];
  });

  if (!rows.length && !Object.keys(epgFull).length) {
    container.innerHTML = `<div class="epg-loading">
      <div style="font-size:32px;opacity:0.3">📅</div>
      <div style="font-weight:600;color:var(--text)">No EPG data</div>
      <div style="font-size:12px">Add an EPG URL in Settings → EPG and click Refresh</div>
    </div>`;
    return;
  }

  if (!rows.length && filter) {
    container.innerHTML = `<div class="epg-loading">No channels matching "${esc(filter)}"</div>`;
    return;
  }

  const now      = Date.now();
  const viewStart = now + EPG_STATE.offsetMs;
  const viewEnd   = viewStart + EPG_STATE.zoomHours * 3600000;
  const pxPerMs   = epgPxPerMs();

  // Build time header slots (every 30 min)
  const slotMs   = 30 * 60 * 1000;
  const firstSlot = Math.floor(viewStart / slotMs) * slotMs;
  const timeSlots = [];
  for (let t = firstSlot; t < viewEnd + slotMs; t += slotMs) {
    timeSlots.push(t);
  }

  // Total timeline width in px
  const totalMs  = viewEnd - firstSlot + slotMs;
  const totalPx  = Math.round(totalMs * pxPerMs);

  // Now-line position
  const nowPx = Math.round((now - firstSlot) * pxPerMs) + 180;

  let html = '';

  // Time header
  html += `<div class="epg-time-header" style="width:${totalPx + 180}px">`;
  html += `<div class="epg-time-header-spacer"></div>`;
  for (const t of timeSlots) {
    const d   = new Date(t);
    const hrs = d.getHours().toString().padStart(2, '0');
    const min = d.getMinutes().toString().padStart(2, '0');
    html += `<div class="epg-time-slot" style="width:${Math.round(slotMs * pxPerMs)}px">${hrs}:${min}</div>`;
  }
  html += '</div>';

  // Now line
  html += `<div class="epg-now-line" style="left:${nowPx}px"></div>`;

  // Store for virtualization
  EPG_STATE.rows = rows;
  EPG_STATE.rowParams = { firstSlot, totalPx, viewStart, viewEnd, pxPerMs, now, timeSlots };

  // Wrapper for channel rows (height keeps scrollbar correct; only visible rows rendered)
  const wrapperHeight = rows.length * EPG_ROW_HEIGHT;
  html += `<div id="epg-rows-wrapper" style="position:relative;width:${totalPx + 180}px;height:${wrapperHeight}px;min-width:max-content;">`;
  html += '</div>';

  container.innerHTML = html;

  let scrollDebounce = null;
  if (!container._epgScrollBound) {
    container._epgScrollBound = true;
    container.addEventListener('scroll', () => {
      clearTimeout(scrollDebounce);
      scrollDebounce = setTimeout(updateEPGVisibleRows, 50);
    });
  }

  updateEPGVisibleRows();

  // Auto-scroll to now
  setTimeout(() => scrollEPGToNow(), 50);
}

const EPG_COLOURS = [
  'rgba(58,122,255,0.18)', 'rgba(48,209,88,0.15)',
  'rgba(255,159,10,0.15)', 'rgba(175,82,222,0.15)',
  'rgba(255,69,58,0.15)',  'rgba(90,200,250,0.15)',
];

function buildEPGRowHtml(ch, ri, params) {
  const { firstSlot, totalPx, viewStart, viewEnd, pxPerMs, now } = params;
  const epgFull = S.epgFull || {};
  const key = ch.tvgId || ch.name;
  const progs = (epgFull[key] || epgFull[key?.toLowerCase()] || [])
    .filter(p => p.stop > viewStart && p.start < viewEnd);
  const colour = EPG_COLOURS[ri % EPG_COLOURS.length];
  const chJ = JSON.stringify(ch).replace(/"/g, '&quot;');
  const logo = ch.logo ? ImageCache.img(ch.logo, '', '📺').replace('<img', '<img style="width:28px;height:28px;object-fit:contain;border-radius:4px;background:var(--bg-4);"') : `<div style="width:28px;height:28px;background:var(--bg-4);border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:14px;">📺</div>`;

  let row = `<div class="epg-channel-name" onclick="openDetail(${chJ},'live')" title="${esc(ch.name)}">${logo}<span class="epg-ch-label">${esc(ch.name)}</span></div>`;
  row += `<div class="epg-programmes" style="position:relative;width:${totalPx}px;height:100%;">`;
  if (!progs.length) {
    row += `<span class="epg-no-data">No schedule data</span>`;
  } else {
    for (const prog of progs) {
      const left  = Math.round((prog.start - firstSlot) * pxPerMs);
      const width = Math.max(4, Math.round((prog.stop - prog.start) * pxPerMs) - 2);
      const isNow  = prog.start <= now && prog.stop > now;
      const isPast = prog.stop <= now;
      const cls = `epg-prog${isNow ? ' is-now' : ''}${isPast ? ' is-past' : ''}`;
      const bg  = isNow ? 'rgba(58,122,255,0.3)' : colour;
      const startStr = new Date(prog.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const stopStr  = new Date(prog.stop).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const progJ = JSON.stringify({ title: prog.title, desc: prog.desc, start: startStr, stop: stopStr }).replace(/"/g,'&quot;');
      row += `<div class="${cls}" style="left:${left}px;width:${width}px;background:${bg};" onmouseenter="epgShowTip(event,${progJ})" onmouseleave="epgHideTip()" onclick="epgProgClick(event,${JSON.stringify(ch).replace(/"/g,'&quot;')})"><span class="epg-prog-title">${esc(prog.title)}</span>${width > 80 ? `<span class="epg-prog-time">${startStr}</span>` : ''}</div>`;
    }
  }
  row += '</div>';
  return row;
}

function updateEPGVisibleRows() {
  const container = document.getElementById('epg-grid-container');
  const wrapper = document.getElementById('epg-rows-wrapper');
  if (!container || !wrapper || !EPG_STATE.rows.length || !EPG_STATE.rowParams) return;

  const scrollTop = container.scrollTop;
  const clientHeight = container.clientHeight;
  const start = Math.max(0, Math.floor(scrollTop / EPG_ROW_HEIGHT) - EPG_VIRTUAL_BUFFER);
  const end = Math.min(EPG_STATE.rows.length, Math.ceil((scrollTop + clientHeight) / EPG_ROW_HEIGHT) + EPG_VIRTUAL_BUFFER);

  let html = '';
  for (let i = start; i < end; i++) {
    const ch = EPG_STATE.rows[i];
    const top = i * EPG_ROW_HEIGHT;
    const rowHtml = buildEPGRowHtml(ch, i, EPG_STATE.rowParams);
    html += `<div class="epg-row" style="position:absolute;left:0;top:${top}px;width:${EPG_STATE.rowParams.totalPx + 180}px;height:${EPG_ROW_HEIGHT}px;">${rowHtml}</div>`;
  }
  wrapper.innerHTML = html;
}

function epgShowTip(event, progData) {
  const tip = document.getElementById('epg-tooltip');
  if (!tip) return;
  document.getElementById('epg-tip-title').textContent = progData.title || '';
  document.getElementById('epg-tip-time').textContent  = `${progData.start} – ${progData.stop}`;
  document.getElementById('epg-tip-desc').textContent  = progData.desc || 'No description available';
  tip.style.display = 'block';
  _positionEPGTip(event);
}

function _positionEPGTip(event) {
  const tip = document.getElementById('epg-tooltip');
  if (!tip) return;
  const x = event.clientX + 12;
  const y = event.clientY + 12;
  const maxX = window.innerWidth  - tip.offsetWidth  - 8;
  const maxY = window.innerHeight - tip.offsetHeight - 8;
  tip.style.left = Math.min(x, maxX) + 'px';
  tip.style.top  = Math.min(y, maxY) + 'px';
}

function epgHideTip() {
  const tip = document.getElementById('epg-tooltip');
  if (tip) tip.style.display = 'none';
}

function epgProgClick(event, ch) {
  event.stopPropagation();
  openDetail(ch, 'live');
}

// Update now-line every minute while EPG page is active
setInterval(() => {
  if (document.getElementById('page-epg')?.classList.contains('active')) {
    const nowLine = document.querySelector('.epg-now-line');
    if (nowLine) {
      const container = document.getElementById('epg-grid-container');
      const pxPerMs   = epgPxPerMs();
      const now        = Date.now();
      const viewStart  = now + EPG_STATE.offsetMs;
      const slotMs     = 30 * 60 * 1000;
      const firstSlot  = Math.floor(viewStart / slotMs) * slotMs;
      const nowPx      = Math.round((now - firstSlot) * pxPerMs) + 180;
      nowLine.style.left = nowPx + 'px';
    }
  }
}, 60000);