// storage.js - IndexedDB persistence for the session (open tabs, unsaved
// contents, file handles) and settings, mirroring Notepad++'s session snapshot.

const DB_NAME = 'notepad-plus-plus-web';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB unavailable')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('buffers')) db.createObjectStore('buffers', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
function reqP(r) {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}

export async function kvGet(key) {
  try { return await tx('kv', 'readonly', (s) => reqP(s.get(key))); } catch (_) { return undefined; }
}
export async function kvSet(key, value) {
  try { await tx('kv', 'readwrite', (s) => { s.put(value, key); }); } catch (e) { console.warn('kvSet', e); }
}

export async function saveSession(session, buffers) {
  try {
    await tx('buffers', 'readwrite', async (s) => {
      s.clear();
      for (const b of buffers) s.put(b);
    });
    await kvSet('session', session);
  } catch (e) {
    console.warn('saveSession failed', e);
  }
}
export async function loadSession() {
  try {
    const session = await kvGet('session');
    if (!session) return null;
    const buffers = await tx('buffers', 'readonly', (s) => reqP(s.getAll()));
    return { session, buffers };
  } catch (e) {
    console.warn('loadSession failed', e);
    return null;
  }
}

// Settings live in localStorage for synchronous access at startup.
const SETTINGS_KEY = 'npp-web-settings';
export function loadSettings(defaults) {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { ...defaults, ...s };
  } catch (_) {
    return { ...defaults };
  }
}
export function saveSettings(settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) { /* quota */ }
}
