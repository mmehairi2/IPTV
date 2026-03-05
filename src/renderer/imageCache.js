// ─────────────────────────────────────────────────────────────────────────────
// imageCache.js — In-memory poster/logo cache
//
// Images from http:// IPTV servers cannot be fetched directly from the
// renderer (file:// origin) due to Mixed Content blocking. We route all
// image fetches through the main process via api.fetchImage() which uses
// Node's http module — exactly the same pattern as api.fetchXtream().
//
// HTTPS images (e.g. TMDB posters) work fine in the renderer and are
// fetched directly for speed.
// ─────────────────────────────────────────────────────────────────────────────

const cache   = new Map(); // url -> blobUrl  (LRU, oldest-first insertion order)
const pending = new Map(); // url -> Promise<blobUrl|null>
const MAX     = 600;

function getCached(url) { return cache.get(url) || null; }

async function load(url) {
  if (!url || url.indexOf('http') !== 0) return null;
  if (cache.has(url)) { touch(url); return cache.get(url); }
  if (pending.has(url)) return pending.get(url);
  const promise = fetchBlob(url).finally(() => pending.delete(url));
  pending.set(url, promise);
  return promise;
}

async function fetchBlob(url) {
  try {
    let blob;

    if (url.startsWith('https://')) {
      // HTTPS: fetch directly in renderer — no Mixed Content issue
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) return null;
      blob = await resp.blob();
    } else {
      // HTTP: route through main process to avoid Mixed Content blocking
      const result = await window.api.fetchImage(url);
      if (!result || !result.ok || !result.data) return null;
      // Convert base64 back to a Blob
      const binary = atob(result.data);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      blob = new Blob([bytes], { type: result.mime || 'image/jpeg' });
    }

    if (!blob || !blob.type.startsWith('image/')) return null;
    const blobUrl = URL.createObjectURL(blob);
    store(url, blobUrl);
    return blobUrl;
  } catch { return null; }
}

function store(url, blobUrl) {
  if (cache.size >= MAX) {
    const oldest = cache.keys().next().value;
    if (oldest != null) {
      URL.revokeObjectURL(cache.get(oldest));
      cache.delete(oldest);
    }
  }
  cache.set(url, blobUrl);
}

function touch(url) {
  if (!cache.has(url)) return;
  const blobUrl = cache.get(url);
  cache.delete(url);
  cache.set(url, blobUrl);
}

function preload(urls, batchSize = 8) {
  const toLoad = urls.filter(u => u && u.indexOf('http') === 0 && !cache.has(u));
  if (!toLoad.length) return;
  let i = 0;
  function nextBatch() {
    const batch = toLoad.slice(i, i + batchSize);
    if (!batch.length) return;
    i += batchSize;
    Promise.all(batch.map(load)).then(() => {
      if (i < toLoad.length) {
        typeof requestIdleCallback !== 'undefined'
          ? requestIdleCallback(nextBatch, { timeout: 2000 })
          : setTimeout(nextBatch, 100);
      }
    });
  }
  typeof requestIdleCallback !== 'undefined'
    ? requestIdleCallback(nextBatch, { timeout: 2000 })
    : setTimeout(nextBatch, 100);
}

function img(url, _unused, fallback) {
  fallback = fallback || '\uD83C\uDFAC';
  var IS = 'display:block;';
  var PS = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:22px;color:var(--text-3);';

  if (!url || url.indexOf('http') !== 0) {
    return '<div style="' + PS + '">' + fallback + '</div>';
  }

  var cached = getCached(url);
  if (cached) {
    return '<img src="' + cached + '" style="' + IS + '" loading="lazy" onerror="this.parentNode.innerHTML=\'<div style=&quot;' + PS + '&quot;>' + fallback + '</div>\'">';
  }

  var id = 'ic_' + Math.random().toString(36).slice(2, 9);
  load(url).then(function(blobUrl) {
    var el = document.getElementById(id);
    if (!el) return;
    if (blobUrl) { el.src = blobUrl; el.style.opacity = '1'; }
    else if (el.parentNode) { el.parentNode.innerHTML = '<div style="' + PS + '">' + fallback + '</div>'; }
  });

  return '<img id="' + id + '" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" style="' + IS + 'opacity:0;transition:opacity 0.3s" onerror="this.parentNode.innerHTML=\'<div style=&quot;' + PS + '&quot;>' + fallback + '</div>\'">';
}

function clearAll() {
  for (var blobUrl of cache.values()) URL.revokeObjectURL(blobUrl);
  cache.clear();
  pending.clear();
}

window.ImageCache = { getCached, load, preload, img, clearAll };