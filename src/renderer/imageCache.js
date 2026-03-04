// ─────────────────────────────────────────────────────────────────────────────
// imageCache.js — In-memory poster/logo cache using blob URLs
// ─────────────────────────────────────────────────────────────────────────────

const cache   = new Map();
const pending = new Map();
const lru     = [];
const MAX     = 600;

function getCached(url) { return cache.get(url) || null; }

async function load(url) {
  if (!url || !url.startsWith('http')) return null;
  if (cache.has(url)) { touch(url); return cache.get(url); }
  if (pending.has(url)) return pending.get(url);
  const promise = fetchBlob(url).finally(() => pending.delete(url));
  pending.set(url, promise);
  return promise;
}

async function fetchBlob(url) {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return null;
    const blob = await resp.blob();
    if (!blob.type.startsWith('image/')) return null;
    const blobUrl = URL.createObjectURL(blob);
    store(url, blobUrl);
    return blobUrl;
  } catch { return null; }
}

function store(url, blobUrl) {
  if (cache.size >= MAX) {
    const oldest = lru.shift();
    if (oldest) { URL.revokeObjectURL(cache.get(oldest)); cache.delete(oldest); }
  }
  cache.set(url, blobUrl);
  lru.push(url);
}

function touch(url) {
  const i = lru.indexOf(url);
  if (i > -1) { lru.splice(i, 1); lru.push(url); }
}

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

// img() — renders an image that fills its container.
// Container must have: position:relative; overflow:hidden; and a defined size.
// All layout (position, inset, width, height, object-fit) is owned by CSS rules
// on .card-poster-placeholder img and .list-thumb img — not set inline here.
function img(url, _unused, fallback) {
  fallback = fallback || '\uD83C\uDFAC';
  // IS: only display:block — container CSS handles position/size/fit
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
  cache.clear(); pending.clear(); lru.length = 0;
}

window.ImageCache = { getCached, load, preload, img, clearAll };