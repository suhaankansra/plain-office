// All documents live in IndexedDB on the device. Nothing is ever uploaded.
//
// A document record looks like:
//   { id, name, kind: 'doc' | 'sheet' | 'slides' | 'pdf', data, created, updated, size }
// `data` is kind specific (HTML for docs, a cell map for sheets, etc).

const DB_NAME = 'plain-office';
const STORE = 'documents';

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(mode, fn) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

export async function listDocs() {
  const all = await run('readonly', (s) => s.getAll());
  // Strip the heavy payload so the home screen stays fast.
  return all.map(({ data, ...meta }) => meta).sort((a, b) => b.updated - a.updated);
}

export const getDoc = (id) => run('readonly', (s) => s.get(id));

export async function saveDoc(doc) {
  doc.updated = Date.now();
  doc.created ??= doc.updated;
  await run('readwrite', (s) => s.put(doc));
  return doc;
}

export const deleteDoc = (id) => run('readwrite', (s) => s.delete(id));

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function estimateSize(data) {
  if (data instanceof Uint8Array) return data.byteLength;
  let binary = 0;
  const json = JSON.stringify(data, (_, v) => {
    if (v instanceof Uint8Array) { binary += v.byteLength; return null; }
    return v;
  });
  return binary + (json?.length || 0);
}
