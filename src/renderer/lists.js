// ─────────────────────────────────────────────────────────────────────────────
// lists.js — Navigation, render functions, cards, favorites, pagination, sort
// ─────────────────────────────────────────────────────────────────────────────

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
  if (page === 'watchlist') renderWatchlist();
  if (page === 'favorites') renderFavorites();
  if (page === 'settings')  renderSettings();
  if (page === 'epg')       renderEPGGrid();
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
  if (activePage === 'home') {
    S.view.live = view;
    renderHome();
  }
  if (activePage === 'watchlist') renderWatchlist();
  if (activePage === 'favorites') renderFavorites();
  }

// ═════════════════════════════════════════════════════════════════════════════
// PLAY ITEM — central entry point
// ═════════════════════════════════════════════════════════════════════════════
function playItem(encodedUrl, encodedName, subtitle, type, encodedPoster = '', startPos = 0) {
  const url    = decodeURIComponent(encodedUrl);
  const name   = decodeURIComponent(encodedName);
  const poster = decodeURIComponent(encodedPoster);

  const preferredPlayer = S.settings.preferredPlayer || 'mpv';

  if (preferredPlayer === 'vlc') {
    if (S.vlcFound) {
      vlcDirect(url, name);
      return;
    } else {
      toast('VLC not found. Using mpv instead.', 'warning', 4000);
    }
  }

  S.current = { url, name, type, poster, subtitle };
  Player.open(url, name, subtitle, type, poster, startPos);
}

// ═════════════════════════════════════════════════════════════════════════════
// RENDER FUNCTIONS
// ═════════════════════════════════════════════════════════════════════════════
function renderHome() {
  if (!S.source) { showWelcome(); return; }

  const isGrid = S.view.live !== 'list';
  const cw = getContinueWatching();
  const cwSection = document.getElementById('continue-watching-section');
  const cwRow     = document.getElementById('continue-row');
  const cwList    = document.getElementById('continue-list');
  if (cw.length) {
    cwSection.style.display = '';
    cwRow.classList.toggle('hidden', !isGrid);
    if (cwList) cwList.classList.toggle('hidden', isGrid);
    cwRow.innerHTML = cw.map(cwCard).join('');
    if (cwList) cwList.innerHTML = cw.map(item => continueListItem(item)).join('');
  } else {
    cwSection.style.display = 'none';
  }

  const homeLiveGrid  = document.getElementById('home-live-grid');
  const homeLiveList  = document.getElementById('home-live-list');
  const homeMoviesGrid = document.getElementById('home-movies-grid');
  const homeMoviesList = document.getElementById('home-movies-list');
  const liveSlice  = S.channels.slice(0, 8);
  const moviesSlice = S.movies.slice(0, 6);

  if (homeLiveGrid) {
    homeLiveGrid.classList.toggle('hidden', !isGrid);
    homeLiveGrid.innerHTML = isGrid ? (liveSlice.map(c => liveCard(c)).join('') || '') : '';
  }
  if (homeLiveList) {
    homeLiveList.classList.toggle('hidden', isGrid);
    homeLiveList.innerHTML = !isGrid ? (liveSlice.map(c => listItem(c, 'live')).join('') || '') : '';
  }
  if (homeMoviesGrid) {
    homeMoviesGrid.classList.toggle('hidden', !isGrid);
    homeMoviesGrid.innerHTML = isGrid ? (moviesSlice.map(m => mediaCard(m, 'vod')).join('') || '') : '';
  }
  if (homeMoviesList) {
    homeMoviesList.classList.toggle('hidden', isGrid);
    homeMoviesList.innerHTML = !isGrid ? (moviesSlice.map(m => listItem(m, 'vod')).join('') || '') : '';
  }
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
  showOnboardingIfNeeded();
}

async function showOnboardingIfNeeded() {
  const seen = await DB.getMeta('hasSeenOnboarding');
  if (!seen) {
    const el = document.getElementById('onboarding-overlay');
    if (el) el.classList.add('visible');
  }
}

function setupOnboarding() {
  const btn = document.getElementById('onboarding-got-it');
  const overlay = document.getElementById('onboarding-overlay');
  if (!btn || !overlay) return;
  btn.addEventListener('click', async () => {
    await DB.setMeta('hasSeenOnboarding', true);
    overlay.classList.remove('visible');
  });
}

function renderLive() {
  const t0     = performance.now();
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
    liveGrid.innerHTML = slice.length ? slice.map(liveCard).join('') : emptyState('📡', 'No channels', '');
  } else {
    liveList.innerHTML = slice.length ? slice.map(ch => listItem(ch, 'live')).join('') : emptyState('📡', 'No channels', '');
  }

  renderPg('live-pagination', pg, Math.ceil(filtered.length / PS), 'live');
  ImageCache.preload(slice.map(c => c.logo).filter(Boolean));
  perfLog('renderLive', { ms: performance.now() - t0, count: filtered.length, page: pg, view: isGrid ? 'grid' : 'list' });
}

function renderMovies() {
  const t0     = performance.now();
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
    document.getElementById('movies-grid').innerHTML = slice.length ? slice.map(m => mediaCard(m, 'vod')).join('') : emptyState('🎬', 'No movies', '');
  } else {
    document.getElementById('movies-list').innerHTML = slice.length ? slice.map(m => listItem(m, 'vod')).join('') : emptyState('🎬', 'No movies', '');
  }

  renderPg('movies-pagination', pg, Math.ceil(filtered.length / PS), 'movies');
  ImageCache.preload(slice.map(m => m.logo).filter(Boolean));
  perfLog('renderMovies', { ms: performance.now() - t0, count: filtered.length, page: S.page.movies, view: isGrid ? 'grid' : 'list' });
}

function renderSeries() {
  const t0     = performance.now();
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
    document.getElementById('series-grid').innerHTML = slice.length ? slice.map(s => mediaCard(s, 'series')).join('') : emptyState('📽️', 'No series', '');
  } else {
    document.getElementById('series-list').innerHTML = slice.length ? slice.map(s => listItem(s, 'series')).join('') : emptyState('📽️', 'No series', '');
  }

  renderPg('series-pagination', pg, Math.ceil(filtered.length / PS), 'series');
  ImageCache.preload(slice.map(s => s.logo).filter(Boolean));
  perfLog('renderSeries', { ms: performance.now() - t0, count: filtered.length, page: S.page.series, view: isGrid ? 'grid' : 'list' });
}

function renderFavorites() {
  const activeType = document.querySelector('[data-fav-type].active')?.dataset.favType || 'all';
  const grid  = document.getElementById('favorites-grid');
  const list  = document.getElementById('favorites-list');
  const empty = document.getElementById('favorites-empty');
  const isGrid = S.view.live !== 'list';

  let items = getFavItems();
  if (activeType !== 'all') items = items.filter(f => f.type === activeType || (activeType === 'movie' && f.type === 'vod'));

  if (!items.length) {
    grid.innerHTML = '';
    if (list) list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  grid.classList.toggle('hidden', !isGrid);
  if (list) list.classList.toggle('hidden', isGrid);

  if (isGrid) {
    grid.innerHTML = items.map(f => f.type === 'live' ? liveCard(f.item) : mediaCard(f.item, f.type)).join('');
  } else {
    if (list) list.innerHTML = items.map(f => listItem(f.item, f.type)).join('');
  }
}

function setupFavTabs() {
  document.querySelectorAll('[data-fav-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-fav-type]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderFavorites();
    });
  });
}

function formatEpgTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
}

function setupGridKeyboardNav() {
  document.addEventListener('keydown', (e) => {
    const activePage = document.querySelector('.page.active');
    if (!activePage) return;
    const pageId = activePage.id || '';
    const gridPages = ['page-live', 'page-movies', 'page-series', 'page-favorites', 'page-watchlist'];
    if (!gridPages.includes(pageId)) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    const focusable = activePage.querySelectorAll('.card, .list-item');
    if (!focusable.length) return;

    const idx = Array.prototype.indexOf.call(focusable, document.activeElement);
    let nextIdx = -1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      nextIdx = idx <= 0 ? 0 : idx - 1;
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      nextIdx = idx < 0 ? 0 : (idx >= focusable.length - 1 ? idx : idx + 1);
    } else if (e.key === 'Enter') {
      if (document.activeElement?.closest?.('.card, .list-item')) {
        document.activeElement.click();
        e.preventDefault();
      }
      return;
    }
    if (nextIdx >= 0) {
      focusable[nextIdx].focus();
      e.preventDefault();
    }
  });
}

function setupLiveCardEpgTooltip() {
  function showCardEpgTip(el, e) {
    const tvgId = el.getAttribute('data-tvg-id');
    if (!tvgId) return;
    const epg = getEPG(tvgId);
    if (!epg.now && !epg.next) return;
    const tip = document.getElementById('epg-tooltip');
    if (!tip) return;
    const titleEl = document.getElementById('epg-tip-title');
    const timeEl  = document.getElementById('epg-tip-time');
    const descEl  = document.getElementById('epg-tip-desc');
    if (epg.now) {
      titleEl.textContent = epg.now.title || 'Now';
      timeEl.textContent  = formatEpgTime(epg.now.start) + ' – ' + formatEpgTime(epg.now.stop) + (epg.next ? ' · Next: ' + (epg.next.title || '') + ' ' + formatEpgTime(epg.next.start) + ' – ' + formatEpgTime(epg.next.stop) : '');
      descEl.textContent  = epg.now.desc || '';
    } else {
      titleEl.textContent = 'Next: ' + (epg.next?.title || '');
      timeEl.textContent  = epg.next ? formatEpgTime(epg.next.start) + ' – ' + formatEpgTime(epg.next.stop) : '';
      descEl.textContent  = epg.next?.desc || '';
    }
    tip.style.display = 'block';
    const x = e.clientX + 12;
    const y = e.clientY + 12;
    const maxX = window.innerWidth  - tip.offsetWidth  - 8;
    const maxY = window.innerHeight - tip.offsetHeight - 8;
    tip.style.left = Math.min(x, Math.max(8, maxX)) + 'px';
    tip.style.top  = Math.min(y, Math.max(8, maxY)) + 'px';
  }
  function hideCardEpgTip() {
    const tip = document.getElementById('epg-tooltip');
    if (tip) tip.style.display = 'none';
  }
  [document.getElementById('page-home'), document.getElementById('page-live')].forEach(container => {
    if (!container) return;
    container.addEventListener('mouseenter', (e) => {
      const card = e.target.closest('.card[data-tvg-id]');
      if (card) showCardEpgTip(card, e);
    }, true);
    container.addEventListener('mouseleave', (e) => {
      if (!container.contains(e.relatedTarget)) hideCardEpgTip();
    }, true);
    container.addEventListener('mousemove', (e) => {
      const card = e.target.closest('.card[data-tvg-id]');
      if (card) showCardEpgTip(card, e);
    }, true);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// CARDS
// ═════════════════════════════════════════════════════════════════════════════
function liveCard(ch) {
  const epg    = getEPG(ch.tvgId || ch.name);
  const favKey = `live:${ch.name}`;
  const isFav  = S.favs.has(favKey);
  const tvgId  = esc(ch.tvgId || ch.name);

  return `
    <div class="card" data-tvg-id="${tvgId}" tabindex="-1" onclick="openDetail(${JSON.stringify(ch).replace(/"/g,'&quot;')}, 'live')">
      <div class="card-now-playing">LIVE</div>
      <div class="card-fav${isFav ? ' active' : ''}" onclick="event.stopPropagation();toggleFav('live','${eu(ch.name)}')" title="${isFav ? 'Unfavorite' : 'Favorite'}">${isFav ? '★' : '☆'}</div>
      <div class="card-poster-placeholder wide">
        ${ImageCache.img(ch.logo, '', '📺')}
      </div>
      <div class="card-info">
        <div class="card-title">${esc(ch.name)}</div>
        <div class="card-meta">${esc(catName(ch.group,'live') || '')}</div>
      </div>
      ${epg.now ? `<div class="card-epg-label">▶ ${esc(epg.now.title)}</div>` : ''}
    </div>`;
}

function mediaCard(item, type) {
  const favKey = `${type}:${item.name}`;
  const isFav  = S.favs.has(favKey);
  const hist   = S.history.find(h => h.id === `${type}:${item.name}`);
  const pct    = hist?.duration ? Math.min(95, (hist.pos / hist.duration) * 100) : 0;
  const itemJ  = JSON.stringify(item).replace(/"/g,'&quot;');
  const icon   = type === 'series' ? '📺' : '🎬';

  return `
    <div class="card" tabindex="-1" onclick="openDetail(${itemJ}, '${type}')">
      <div class="card-fav${isFav ? ' active' : ''}" onclick="event.stopPropagation();toggleFav('${type}','${eu(item.name)}')" title="${isFav ? 'Unfavorite' : 'Favorite'}">${isFav ? '★' : '☆'}</div>
      <div class="card-poster-placeholder">
        ${ImageCache.img(item.logo, '', icon)}
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
  const hist   = S.history.find(h => h.id === `${type}:${item.name}`);
  const pct    = hist?.duration ? Math.min(95, (hist.pos / hist.duration) * 100) : 0;

  return `
    <div class="list-item" tabindex="-1" onclick="openDetail(${itemJ}, '${type}')">
      <div class="list-thumb">
        ${ImageCache.img(item.logo, '', isLive ? '📺' : '🎬')}
        ${pct > 2 ? `<div style="position:absolute;bottom:0;left:0;right:0;height:2px;z-index:2;background:rgba(255,255,255,0.1);"><div style="height:100%;width:${pct}%;background:var(--blue);"></div></div>` : ''}
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

function watchlistCard(item, type) {
  const itemJ = JSON.stringify(item).replace(/"/g, '&quot;');
  const icon = type === 'live' ? '📺' : '🎬';
  return `
    <div class="card" tabindex="-1" onclick="openDetail(${itemJ}, '${type}')">
      <div class="card-watchlist-remove" onclick="event.stopPropagation();removeFromWatchlistAndRender('${type}','${eu(item.name)}')" title="Remove from Watchlist">✕</div>
      ${type === 'live'
        ? `<div class="card-now-playing">LIVE</div>
           <div class="card-poster-placeholder wide">${ImageCache.img(item.logo, '', icon)}</div>`
        : `<div class="card-poster-placeholder">${ImageCache.img(item.logo, '', icon)}</div>`}
      <div class="card-info">
        <div class="card-title">${esc(item.name)}</div>
        <div class="card-meta">${type === 'live' ? esc(catName(item.group, 'live') || '') : (item.year || '') + (item.rating ? ' · ⭐' + parseFloat(item.rating).toFixed(1) : '')}</div>
      </div>
    </div>`;
}

function watchlistListItem(item, type) {
  const itemJ = JSON.stringify(item).replace(/"/g, '&quot;');
  const isLive = type === 'live';
  return `
    <div class="list-item" tabindex="-1" onclick="openDetail(${itemJ}, '${type}')">
      <div class="list-thumb">${ImageCache.img(item.logo, '', isLive ? '📺' : '🎬')}</div>
      <div class="list-info">
        <div class="list-title">${esc(item.name)}</div>
        <div class="list-meta">${esc(catName(item.group, isLive ? 'live' : type) || '')}</div>
      </div>
      ${isLive ? '<div class="list-live-dot"></div>' : ''}
      <div class="list-actions">
        <button class="list-action-btn" title="Remove from Watchlist" onclick="event.stopPropagation();removeFromWatchlistAndRender('${type}','${eu(item.name)}')">✕ Remove</button>
      </div>
    </div>`;
}

async function removeFromWatchlistAndRender(type, encodedName) {
  const name = decodeURIComponent(encodedName);
  await removeFromWatchlist(type, name);
  toast('Removed from watchlist');
  renderWatchlist();
}

function continueListItem(item) {
  const pct      = item.duration ? Math.min(95, (item.pos / item.duration) * 100) : 0;
  const isLive   = item.type === 'live';
  const thumb   = item.poster || item.logo;
  return `
    <div class="list-item" tabindex="-1" onclick="resumeItem('${eu(item.id)}')">
      <div class="list-thumb">
        ${ImageCache.img(thumb, '', isLive ? '📺' : '🎬')}
        ${pct > 2 ? `<div style="position:absolute;bottom:0;left:0;right:0;height:2px;z-index:2;background:rgba(255,255,255,0.1);"><div style="height:100%;width:${pct}%;background:var(--blue);"></div></div>` : ''}
      </div>
      <div class="list-info">
        <div class="list-title">${esc(item.name)}</div>
        <div class="list-meta">${isLive ? 'Live TV' : (item.duration ? formatTime(item.duration - item.pos) + ' left' : '')}</div>
      </div>
      ${isLive ? '<div class="list-live-dot"></div>' : ''}
    </div>`;
}

function cwCard(item) {
  const pct      = item.duration ? Math.min(95, (item.pos / item.duration) * 100) : 0;
  const timeLeft = item.duration ? formatTime(item.duration - item.pos) : '';
  const isLive   = item.type === 'live';

  return `
    <div class="continue-card" onclick="resumeItem('${eu(item.id)}')">
      <div class="continue-card-thumb-placeholder" style="position:relative;overflow:hidden;">
        ${ImageCache.img(item.poster || item.logo, '', isLive ? '📺' : '🎬')}
        ${isLive
          ? `<div style="position:absolute;top:6px;left:6px;background:var(--red);color:#fff;font-size:9px;font-weight:700;padding:2px 6px;border-radius:999px;z-index:1">LIVE</div>`
          : `<div class="continue-progress" style="z-index:1"><div class="continue-progress-fill" style="width:${pct}%"></div></div>`}
      </div>
      <div class="continue-card-info">
        <div class="continue-card-title">${esc(item.name)}</div>
        <div class="continue-card-meta">${isLive ? 'Live TV' : (timeLeft ? timeLeft + ' left' : 'Watched')}</div>
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
  if (pg === 'live')           renderLive();
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

function getWatchlistItems() {
  if (!S.watchlist || !S.watchlist.size) return [];
  const out = [];
  for (const key of S.watchlist) {
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

function renderWatchlist() {
  const grid = document.getElementById('watchlist-grid');
  const list = document.getElementById('watchlist-list');
  const empty = document.getElementById('watchlist-empty');
  if (!grid) return;
  const items = getWatchlistItems();
  const isGrid = S.view.live !== 'list';
  if (!items.length) {
    grid.innerHTML = '';
    if (list) list.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  grid.classList.toggle('hidden', !isGrid);
  if (list) list.classList.toggle('hidden', isGrid);
  if (isGrid) {
    grid.innerHTML = items.map(w => watchlistCard(w.item, w.type)).join('');
  } else {
    if (list) list.innerHTML = items.map(w => watchlistListItem(w.item, w.type)).join('');
  }
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
// CATEGORY / FILTER HELPERS
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
// GLOBAL SEARCH
// ═════════════════════════════════════════════════════════════════════════════
function setupGlobalSearch() {
  const input = document.getElementById('search-input');
  if (!input) return;

  input.addEventListener('input', () => {
    const q = input.value.trim();
    const activePage = document.querySelector('.page.active')?.id?.replace('page-', '');

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
    (liveResults.length   ? `<div style="grid-column:1/-1;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-3);padding-bottom:4px">Live TV</div>`       + liveResults.map(liveCard).join('')              : '') +
    (movieResults.length  ? `<div style="grid-column:1/-1;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-3);padding:12px 0 4px">Movies</div>`        + movieResults.map(m => mediaCard(m,'vod')).join('')   : '') +
    (seriesResults.length ? `<div style="grid-column:1/-1;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-3);padding:12px 0 4px">Series</div>`        + seriesResults.map(s => mediaCard(s,'series')).join('') : '');
  moviesGrid.innerHTML = '';
}

// ═════════════════════════════════════════════════════════════════════════════
// SORT
// ═════════════════════════════════════════════════════════════════════════════
const S_SORT = { movies: 'default', series: 'default' };

function setupSortButtons() {
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
      <button class="cat-tab sort-btn" data-sort="az"     data-section="${section}">A–Z</button>
      <button class="cat-tab sort-btn" data-sort="rating" data-section="${section}">Rating</button>
      <button class="cat-tab sort-btn" data-sort="year"   data-section="${section}">Year</button>
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