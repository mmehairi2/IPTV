// ─────────────────────────────────────────────────────────────────────────────
// tmdb.js — TMDB search, enrichment, cache lookup
// Uses api.fetchXtream (IPC fetch bridge) for all HTTP requests.
// ─────────────────────────────────────────────────────────────────────────────

const TMDB_IMG   = 'https://image.tmdb.org/t/p/w500';
const TMDB_BACK  = 'https://image.tmdb.org/t/p/w1280';
const TMDB_BASE  = 'https://api.themoviedb.org/3';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * cleanName — strips IPTV prefixes, quality tags, year, dots/underscores, extra spaces
 */
function cleanName(name) {
  if (!name) return '';
  return name
    .replace(/^[A-Z0-9\s]+\s*[-|:]\s+/g, '')           // "TOP - ", "HD - ", "AR | ", "FHD: " prefixes
    .replace(/\(?\b(19|20)\d{2}\b\)?/g, '')            // year (2008) or 2008
    .replace(/\b(2160p|1080p|720p|480p|HDTV|BluRay|WEB-?DL|DVDRip|x264|x265|HEVC|HDR|SDR|4K|UHD)\b/gi, '')
    .replace(/[._]/g, ' ')                              // dots/underscores → spaces
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function tmdbFetch(url) {
  try {
    const res = await window.api.fetchXtream(url);
    if (!res.ok) return null;
    return JSON.parse(res.data);
  } catch (e) {
    console.warn('[TMDB] fetch error:', e.message);
    return null;
  }
}

// ── Search ────────────────────────────────────────────────────────────────────

async function searchMovie(name, apiKey) {
  const query = encodeURIComponent(cleanName(name));
  const data  = await tmdbFetch(`${TMDB_BASE}/search/movie?query=${query}&api_key=${apiKey}`);
  return data?.results?.[0] || null;
}

async function searchTV(name, apiKey) {
  const query = encodeURIComponent(cleanName(name));
  const data  = await tmdbFetch(`${TMDB_BASE}/search/tv?query=${query}&api_key=${apiKey}`);
  return data?.results?.[0] || null;
}

// ── Details ───────────────────────────────────────────────────────────────────

async function getMovieDetails(tmdbId, apiKey) {
  return tmdbFetch(`${TMDB_BASE}/movie/${tmdbId}?append_to_response=credits,videos&api_key=${apiKey}`);
}

async function getTVDetails(tmdbId, apiKey) {
  return tmdbFetch(`${TMDB_BASE}/tv/${tmdbId}?append_to_response=credits,videos&api_key=${apiKey}`);
}

// ── Enrich ────────────────────────────────────────────────────────────────────

/**
 * enrichItem — search + details, returns enriched object.
 * type: 'vod' | 'series'
 */
async function enrichItem(item, type, apiKey) {
  if (!apiKey) return null;

  try {
    let result, details;

    if (type === 'vod') {
      result  = await searchMovie(item.name, apiKey);
      if (!result) return null;
      details = await getMovieDetails(result.id, apiKey);
    } else {
      result  = await searchTV(item.name, apiKey);
      if (!result) return null;
      details = await getTVDetails(result.id, apiKey);
    }

    if (!details) return null;

    // Trailer: first YouTube Trailer from videos
    const videos = details.videos?.results || [];
    const trailer = videos.find(v => v.type === 'Trailer' && v.site === 'YouTube');

    // Cast (top 5)
    const cast = (details.credits?.cast || [])
      .slice(0, 5)
      .map(c => ({ name: c.name, posterPath: c.profile_path || null }));

    // Director (movie) / creator (TV)
    let director = '';
    if (type === 'vod') {
      director = (details.credits?.crew || [])
        .filter(c => c.job === 'Director')
        .map(c => c.name)
        .slice(0, 2)
        .join(', ');
    } else {
      director = (details.created_by || [])
        .map(c => c.name)
        .slice(0, 2)
        .join(', ');
    }

    // Runtime
    let runtime = '';
    if (type === 'vod' && details.runtime) {
      runtime = `${details.runtime} min`;
    } else if (type === 'series' && details.episode_run_time?.length) {
      runtime = `${details.episode_run_time[0]} min/ep`;
    }

    // Year
    const dateStr = details.release_date || details.first_air_date || '';
    const year    = dateStr ? dateStr.slice(0, 4) : '';

    // Genres
    const genres = (details.genres || []).map(g => g.name);

    return {
      tmdbId:     details.id,
      poster:     details.poster_path   ? TMDB_IMG  + details.poster_path   : null,
      backdrop:   details.backdrop_path ? TMDB_BACK + details.backdrop_path : null,
      rating:     details.vote_average ? details.vote_average.toFixed(1) : '',
      year,
      runtime,
      plot:       details.overview || '',
      genres,
      cast,
      director,
      trailerKey: trailer?.key || null,
    };

  } catch (e) {
    console.warn('[TMDB] enrichItem error:', e.message);
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
window.TMDB = { cleanName, searchMovie, searchTV, getMovieDetails, getTVDetails, enrichItem };
