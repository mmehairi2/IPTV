// ─────────────────────────────────────────────────────────────────────────────
// db.js — IndexedDB wrapper (replaces localStorage for all app data)
// ─────────────────────────────────────────────────────────────────────────────

const DB_NAME = 'iptv_player_db';
const DB_VER  = 3;  // v3: removed unused 'epg' object store (EPG lives in meta blob)

let _db = null;
let dbReady = null;

// ── Open with proper promise handling ────────────────────────────────────────
function openDB() {
  if (dbReady) return dbReady;
  
  dbReady = new Promise((resolve, reject) => {
    if (_db) {
      resolve(_db);
      return;
    }

    const req = indexedDB.open(DB_NAME, DB_VER);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      // key/value store for source, settings, timestamps, epg_url, epg blob
      if (!db.objectStoreNames.contains('meta'))
        db.createObjectStore('meta', { keyPath: 'key' });

      // bulk data stores — each holds one record { id:'data', value:[] }
      for (const s of ['channels', 'movies', 'series', 'cats']) {
        if (!db.objectStoreNames.contains(s)) {
          db.createObjectStore(s, { keyPath: 'id' });
        }
      }

      // history — keyed by "type:name", indexed by timestamp
      if (!db.objectStoreNames.contains('history')) {
        const hs = db.createObjectStore('history', { keyPath: 'id' });
        hs.createIndex('ts', 'ts');
      }

      // favorites — keyed by "type:name"
      if (!db.objectStoreNames.contains('favs'))
        db.createObjectStore('favs', { keyPath: 'id' });

      // v3: drop the channel-keyed 'epg' store created in v2 but never used.
      // EPG is stored as a single meta blob under key 'epg' — schema now matches code.
      if (db.objectStoreNames.contains('epg')) {
        db.deleteObjectStore('epg');
      }
    };

    req.onsuccess = (e) => {
      _db = e.target.result;
      // Handle concurrent tab version upgrades gracefully
      _db.onversionchange = () => {
        _db.close();
        _db = null;
        dbReady = null;
        console.warn('[DB] Version change detected — DB closed. Reload required.');
      };
      resolve(_db);
    };
    
    req.onerror = (e) => {
      console.error('IndexedDB error:', e.target.error);
      reject(e.target.error);
      dbReady = null; // Reset so we can try again
    };
  });

  return dbReady;
}

// ── Promise wrapper ───────────────────────────────────────────────────────────
function p(req) {
  return new Promise((res, rej) => {
    req.onsuccess = (e) => res(e.target.result);
    req.onerror = (e) => {
      console.error('Request error:', e.target.error);
      rej(e.target.error);
    };
  });
}

// ── Fixed store function — waits for DB connection ────────────────────────────
async function getStore(name, mode = 'readonly') {
  const db = await openDB();
  const transaction = db.transaction(name, mode);
  return transaction.objectStore(name);
}

// ── Meta (key/value) ──────────────────────────────────────────────────────────
async function getMeta(key) {
  try {
    const store = await getStore('meta');
    const r = await p(store.get(key));
    return r ? r.value : null;
  } catch (e) {
    console.error('getMeta error:', e);
    return null;
  }
}

async function setMeta(key, value) {
  try {
    const store = await getStore('meta', 'readwrite');
    await p(store.put({ key, value }));
  } catch (e) {
    console.error('setMeta error:', e);
    throw e;
  }
}

async function delMeta(key) {
  try {
    const store = await getStore('meta', 'readwrite');
    await p(store.delete(key));
  } catch (e) {
    console.error('delMeta error:', e);
    throw e;
  }
}

// ── Bulk data (channels / movies / series) ────────────────────────────────────
async function getData(type) {
  try {
    const store = await getStore(type);
    const r = await p(store.get('data'));
    return r ? r.value : [];
  } catch (e) {
    console.error('getData error:', e);
    return [];
  }
}

async function setData(type, arr) {
  try {
    const store = await getStore(type, 'readwrite');
    await p(store.put({ id: 'data', value: arr }));
  } catch (e) {
    console.error('setData error:', e);
    throw e;
  }
}

// ── Categories ────────────────────────────────────────────────────────────────
async function getCats() {
  try {
    const store = await getStore('cats');
    const r = await p(store.get('data'));
    return r ? r.value : { live: [], vod: [], series: [] };
  } catch (e) {
    console.error('getCats error:', e);
    return { live: [], vod: [], series: [] };
  }
}

async function setCats(cats) {
  try {
    const store = await getStore('cats', 'readwrite');
    await p(store.put({ id: 'data', value: cats }));
  } catch (e) {
    console.error('setCats error:', e);
    throw e;
  }
}

// ── History ───────────────────────────────────────────────────────────────────
async function getHistory() {
  try {
    const store = await getStore('history');
    const all = await p(store.getAll());
    return all.sort((a, b) => b.ts - a.ts);
  } catch (e) {
    console.error('getHistory error:', e);
    return [];
  }
}

async function saveHistoryItem(entry) {
  try {
    const store = await getStore('history', 'readwrite');
    await p(store.put(entry));
  } catch (e) {
    console.error('saveHistoryItem error:', e);
    throw e;
  }
}

async function getHistoryItem(id) {
  try {
    const store = await getStore('history');
    return p(store.get(id));
  } catch (e) {
    console.error('getHistoryItem error:', e);
    return null;
  }
}

async function removeHistoryItem(id) {
  try {
    const store = await getStore('history', 'readwrite');
    await p(store.delete(id));
  } catch (e) {
    console.error('removeHistoryItem error:', e);
    throw e;
  }
}

async function clearHistory() {
  try {
    const store = await getStore('history', 'readwrite');
    await p(store.clear());
  } catch (e) {
    console.error('clearHistory error:', e);
    throw e;
  }
}

// ── Favorites ─────────────────────────────────────────────────────────────────
async function getFavs() {
  try {
    const store = await getStore('favs');
    const all = await p(store.getAll());
    return new Set(all.map(r => r.id));
  } catch (e) {
    console.error('getFavs error:', e);
    return new Set();
  }
}

async function addFav(id) {
  try {
    const store = await getStore('favs', 'readwrite');
    await p(store.put({ id }));
  } catch (e) {
    console.error('addFav error:', e);
    throw e;
  }
}

async function removeFav(id) {
  try {
    const store = await getStore('favs', 'readwrite');
    await p(store.delete(id));
  } catch (e) {
    console.error('removeFav error:', e);
    throw e;
  }
}

// ── Cache timestamp ───────────────────────────────────────────────────────────
async function getCacheAge() {
  const ts = await getMeta('cache_ts');
  if (!ts) return Infinity;
  return Date.now() - ts;
}

async function stampCache() {
  return setMeta('cache_ts', Date.now());
}

// ── Nuclear clear (source removal) ───────────────────────────────────────────
async function clearAll() {
  try {
    await openDB(); // Ensure DB is open first
    const dataStores = ['channels', 'movies', 'series', 'cats', 'history', 'favs'];
    for (const s of dataStores) {
      try {
        const store = await getStore(s, 'readwrite');
        await p(store.clear());
      } catch (e) {
        console.warn(`Could not clear ${s}:`, e);
      }
    }
    
    // Delete meta items individually
    const metaKeys = ['source', 'settings', 'epg_url', 'epg', 'cache_ts'];
    for (const key of metaKeys) {
      try {
        await delMeta(key);
      } catch (e) {
        console.warn(`Could not delete meta ${key}:`, e);
      }
    }
  } catch (e) {
    console.error('clearAll error:', e);
    throw e;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
window.DB = {
  getMeta, setMeta, delMeta,
  getData, setData,
  getCats, setCats,
  getHistory, saveHistoryItem, getHistoryItem, removeHistoryItem, clearHistory,
  getFavs, addFav, removeFav,
  getCacheAge, stampCache,
  clearAll,
};