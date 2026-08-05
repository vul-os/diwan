/**
 * draftStore — crash-safe draft persistence via IndexedDB.
 *
 * Before every network write, we persist the draft locally.
 * On a successful write we clear the draft.
 * On reload we expose any pending draft so editors can offer a restore prompt.
 *
 * Shape stored per file:
 *   { id, name, content, ts }
 */

const DB_NAME = 'diwan-drafts'
const STORE_NAME = 'drafts'
const DB_VERSION = 1

export type Draft = { id: string; name: string; content: unknown; ts: number }

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Persist a draft before the network write. */
export async function writeDraft(id: string, name: string, content: unknown): Promise<void> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put({ id, name, content, ts: Date.now() })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    // IndexedDB unavailable — silently ignore so we don't block saves
  }
}

/** Remove draft after a successful network write. */
export async function clearDraft(id: string): Promise<void> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    // ignore
  }
}

/** Read a pending draft (returns null if none). */
export async function readDraft(id: string): Promise<Draft | null> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(id)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => reject(req.error)
    })
  } catch {
    return null
  }
}
