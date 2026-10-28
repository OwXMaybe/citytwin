/**
 * Minimal IndexedDB key-value cache for OSM imports, so repeated views don't hit
 * the fair-use Overpass servers. Falls back to a no-op if IndexedDB is unavailable.
 */
const DB = 'citytwin';
const STORE = 'osm-cache';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

interface Entry<T> {
  value: T;
  savedAt: number;
}

export async function cacheGet<T>(key: string, maxAgeMs: number): Promise<T | null> {
  try {
    const db = await open();
    const entry = await new Promise<Entry<T> | undefined>((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as Entry<T> | undefined);
      req.onerror = () => reject(req.error);
    });
    if (!entry || Date.now() - entry.savedAt > maxAgeMs) return null;
    return entry.value;
  } catch {
    return null;
  }
}

export async function cacheSet<T>(key: string, value: T): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ value, savedAt: Date.now() } satisfies Entry<T>, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* caching is best-effort */
  }
}
