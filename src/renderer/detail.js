// ─────────────────────────────────────────────────────────────────────────────
// detail.js — Detail panel, series episode browser
// ─────────────────────────────────────────────────────────────────────────────

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

  // Cast / director (Xtream VOD/series)
  const castEl = document.getElementById('detail-cast');
  const castParts = [];
  if (item.director && String(item.director).trim()) castParts.push(`<strong>Director:</strong> ${esc(String(item.director).trim())}`);
  if (item.cast && String(item.cast).trim()) castParts.push(`<strong>Cast:</strong> ${esc(String(item.cast).trim())}`);
  if (castParts.length) {
    castEl.innerHTML = castParts.join('<br>');
    castEl.style.display = '';
  } else {
    castEl.innerHTML = '';
    castEl.style.display = 'none';
  }

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

  // Watchlist button
  const watchlistBtn = document.getElementById('detail-watchlist-btn');
  if (watchlistBtn) {
    watchlistBtn.textContent = isInWatchlist(type, item.name) ? '✓ In Watchlist' : '+ Watchlist';
    watchlistBtn.onclick = async () => {
      if (isInWatchlist(type, item.name)) {
        await removeFromWatchlist(type, item.name);
        watchlistBtn.textContent = '+ Watchlist';
      } else {
        await addToWatchlist(type, item.name);
        watchlistBtn.textContent = '✓ In Watchlist';
      }
      if (document.getElementById('page-watchlist')?.classList.contains('active')) renderWatchlist();
    };
  }

  // VLC button
  document.getElementById('detail-vlc-btn').onclick = () => {
    if (item.url) vlcDirect(item.url, item.name);
  };
  document.getElementById('detail-vlc-btn').style.display = item.url ? '' : 'none';

  // Trailer button — open YouTube search in default browser
  const trailerBtn = document.getElementById('detail-trailer-btn');
  trailerBtn.onclick = () => {
    const q = encodeURIComponent(item.name + ' trailer');
    const url = `https://www.youtube.com/results?search_query=${q}`;
    if (window.api && typeof window.api.openExternal === 'function') {
      window.api.openExternal(url);
    }
  };
  trailerBtn.style.display = (type === 'live') ? 'none' : '';

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