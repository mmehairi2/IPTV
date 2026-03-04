// ─────────────────────────────────────────────────────────────────────────────
// imageCache.js — In-memory poster/logo cache using blob URLs
// Prevents re-fetching the same image on every page render
// ─────────────────────────────────────────────────────────────────────────────

const cache   = new Map(); // originalUrl → blobURL
const pending = new Map(); // originalUrl → Promise (deduplicates in-flight)
const lru     = [];        // LRU order for eviction
const MAX     = 600;       // max images to keep in memory at once

// ── Public: get cached blob URL synchronously (or null) ──────────────────────
function getCached(url) {
  return cache.get(url) || null;
}

// ── Public: load image (returns blob URL or null on failure) ──────────────────
async function load(url) {
  if (!url || !url.startsWith('http')) return null;

  // Already cached — bump LRU and return immediately
  if (cache.has(url)) {
    touch(url);
    return cache.get(url);
  }

  // Already in-flight — return same promise (no duplicate fetch)
  if (pending.has(url)) return pending.get(url);

  const promise = fetchBlob(url).finally(() => pending.delete(url));
  pending.set(url, promise);
  return promise;
}

async function fetchBlob(url) {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      // No credentials, simple GET
    });
    if (!resp.ok) return null;
    const blob = await resp.blob();
    if (!blob.type.startsWith('image/')) return null;
    const blobUrl = URL.createObjectURL(blob);
    store(url, blobUrl);
    return blobUrl;
  } catch {
    return null;
  }
}

function store(url, blobUrl) {
  // Evict oldest if at capacity
  if (cache.size >= MAX) {
    const oldest = lru.shift();
    if (oldest) {
      const old = cache.get(oldest);
      if (old) URL.revokeObjectURL(old); // free memory
      cache.delete(oldest);
    }
  }
  cache.set(url, blobUrl);
  lru.push(url);
}

function touch(url) {
  const i = lru.indexOf(url);
  if (i > -1) { lru.splice(i, 1); lru.push(url); }
}

// ── Public: preload a batch in background (non-blocking) ─────────────────────
function preload(urls, batchSize = 8) {
  const toLoad = urls.filter(u => u && u.startsWith('http') && !cache.has(u));
  if (!toLoad.length) return;

  let i = 0;
  function nextBatch() {
    const batch = toLoad.slice(i, i + batchSize);
    if (!batch.length) return;
    i += batchSize;
    Promise.all(batch.map(load)).then(() => {
      if (i < toLoad.length) {
        // Use idle callback so we never block rendering
        if (typeof requestIdleCallback !== 'undefined') {
          requestIdleCallback(nextBatch, { timeout: 2000 });
        } else {
          setTimeout(nextBatch, 100);
        }
      }
    });
  }

  if (typeof requestIdleCallback !== 'undefined') {
    requestIdleCallback(nextBatch, { timeout: 2000 });
  } else {
    setTimeout(nextBatch, 100);
  }
}

// ── Public: generate <img> HTML with cache-first loading ─────────────────────
// If cached → renders instantly with blob URL
// If not cached → renders placeholder, swaps in image when ready
function img(url, cssClass = 'poster', fallback = '🎬') {
  if (!url || !url.startsWith('http')) {
    return `<div class="pp"><div class="pi">${fallback}</div></div>`;
  }

  // Synchronous cache hit — render instantly, no flicker
  const cached = getCached(url);
  if (cached) {
    return `<img class="${cssClass}" src="${cached}" loading="lazy"
      onerror="this.parentElement.innerHTML='<div class=\\'pp\\'><div class=\\'pi\\'>${fallback}</div></div>'">`;
  }

  // Not cached — render transparent placeholder, load async then swap
  const id = 'ic_' + Math.random().toString(36).slice(2, 9);
  load(url).then(blobUrl => {
    const el = document.getElementById(id);
    if (!el) return;
    if (blobUrl) {
      el.src = blobUrl;
      el.style.opacity = '1';
    } else {
      // Failed to load — show fallback
      el.parentElement.innerHTML =
        `<div class="pp"><div class="pi">${fallback}</div></div>`;
    }
  });

  return `<img id="${id}" class="${cssClass}"
    src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
    style="opacity:0;transition:opacity 0.25s"
    onerror="this.parentElement.innerHTML='<div class=\\'pp\\'><div class=\\'pi\\'>${fallback}</div></div>'">`;
}

// ── Public: clear everything (on source change) ───────────────────────────────
function clearAll() {
  for (const blobUrl of cache.values()) URL.revokeObjectURL(blobUrl);
  cache.clear();
  pending.clear();
  lru.length = 0;
}

// ── Expose globally ───────────────────────────────────────────────────────────
window.ImageCache = { getCached, load, preload, img, clearAll };