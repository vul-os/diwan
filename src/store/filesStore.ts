import { create } from 'zustand'
import { api } from '../lib/api'
import { writeDraft, clearDraft } from '../lib/draftStore'

/** A file record as returned by the /files API. Fields beyond the ones this
 *  store itself reads are passed through untouched (index signature). */
export interface DiwanFile {
  id: string
  name: string
  type: string
  content?: unknown
  rev?: number
  starred?: boolean
  trashed?: boolean
  parent_id?: string
  owner?: string
  updated_at?: string
  created_at?: string
  [key: string]: unknown
}

export interface DiwanFolder {
  id: string
  name: string
  parent_id?: string
  trashed?: boolean
  [key: string]: unknown
}

/** Errors thrown by lib/api's `request()` carry `.status` + any JSON error
 *  body fields (e.g. `.current`, the server's newer file on a 409 conflict). */
interface ApiError extends Error {
  status?: number
  current?: DiwanFile
}

interface UpdateFileOpts {
  rev?: number
  onConflict?: (current: DiwanFile | undefined, content: unknown) => boolean | Promise<boolean> | void | Promise<void>
  _retried?: boolean
}

interface FilesState {
  files: DiwanFile[]
  folders: DiwanFolder[]
  loading: boolean
  sharedWithMe: DiwanFile[]
  fetchFiles: () => Promise<void>
  fetchSharedWithMe: () => Promise<void>
  fetchFolders: () => Promise<void>
  createFolder: (name: string, parentId?: string) => Promise<DiwanFolder>
  renameFolder: (id: string, name: string) => Promise<DiwanFolder>
  trashFolder: (id: string, trashed: boolean) => Promise<DiwanFolder>
  deleteFolder: (id: string) => Promise<void>
  moveFile: (id: string, opts?: { parentId?: string; starred?: boolean; trashed?: boolean }) => Promise<DiwanFile>
  toggleStar: (id: string) => Promise<DiwanFile>
  trashFile: (id: string) => Promise<DiwanFile>
  restoreFile: (id: string) => Promise<DiwanFile>
  createFile: (name: string, type: string, opts?: { content?: unknown; parentId?: string }) => Promise<DiwanFile>
  updateFile: (id: string, name: string, content: unknown, opts?: UpdateFileOpts) => Promise<DiwanFile>
  deleteFile: (id: string) => Promise<void>
  renameFile: (id: string, name: string) => Promise<void>
  saveFileWithDraft: (id: string, name: string, content: unknown) => Promise<DiwanFile>
  markDirty: (id: string) => void
}

function defaultContent(type: string): unknown {
  switch (type) {
    case 'doc':
      return { type: 'doc', content: [{ type: 'paragraph' }] }
    case 'sheet':
      return [{ name: 'Sheet1', celldata: [], config: {} }]
    case 'slide':
      return { theme: 'black', transition: 'slide', slides: [{ id: crypto.randomUUID(), title: '', content: '<p></p>', notes: '' }] }
    case 'whiteboard':
      // An Excalidraw scene: elements one-per-id (merged as a Yjs Y.Map) + image
      // blobs. Empty to start; the WhiteboardEditor seeds its Y.Doc from this.
      return { type: 'excalidraw', elements: [], files: {} }
    default:
      return null
  }
}

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'
export interface SaveState {
  status: SaveStatus
  error: string | null
}
type SaveStateListener = (state: SaveState) => void

// Per-file save state: 'idle' | 'dirty' | 'saving' | 'saved' | 'error'
// Stored as a plain map outside Zustand to avoid excessive re-renders in editors
// that only care about their own file's state.
const saveStateListeners = new Map<string, Set<SaveStateListener>>()
const saveStates = new Map<string, SaveState>()

export function getSaveState(id: string): SaveState {
  return saveStates.get(id) || { status: 'idle', error: null }
}

export function onSaveStateChange(id: string, fn: SaveStateListener): () => void {
  if (!saveStateListeners.has(id)) saveStateListeners.set(id, new Set())
  saveStateListeners.get(id)!.add(fn)
  return () => saveStateListeners.get(id)?.delete(fn)
}

function setSaveState(id: string, status: SaveStatus, error: string | null = null) {
  saveStates.set(id, { status, error })
  const listeners = saveStateListeners.get(id)
  if (listeners) listeners.forEach((fn) => fn({ status, error }))
}

export const useFilesStore = create<FilesState>((set, get) => ({
  files: [],
  folders: [],
  loading: false,
  // Files shared TO the current user by others (owned files excluded). Loaded
  // from the ACL-safe /shared-files endpoint. Each entry carries { owner, role }.
  sharedWithMe: [],

  fetchFiles: async () => {
    set({ loading: true })
    try {
      const files = await api.listFiles()
      // Coerce to an array: `files` feeds .filter/.map/.slice across AppHome and
      // the app-shell rail, so a malformed/non-array response must never poison
      // it (that would crash the whole shell, not just this list).
      set({ files: Array.isArray(files) ? (files as DiwanFile[]) : [], loading: false })
    } catch {
      set({ loading: false })
    }
  },

  // "Shared with me": files granted to the caller by another account. A failure
  // just leaves the section empty (it is additive UX).
  fetchSharedWithMe: async () => {
    try {
      const res = await api.listSharedWithMe() as { files?: DiwanFile[] } | undefined
      set({ sharedWithMe: Array.isArray(res?.files) ? res.files : [] })
    } catch {
      set({ sharedWithMe: [] })
    }
  },

  // Parity: folder tree. Loaded alongside files for the AppHome navigator.
  fetchFolders: async () => {
    try {
      const folders = await api.listFolders()
      set({ folders: Array.isArray(folders) ? (folders as DiwanFolder[]) : [] })
    } catch {
      /* folders are optional UX; a failure just hides the tree */
    }
  },

  createFolder: async (name, parentId = '') => {
    const folder = await api.createFolder(name, parentId) as DiwanFolder
    set({ folders: [...get().folders, folder] })
    return folder
  },

  renameFolder: async (id, name) => {
    const folder = await api.updateFolder(id, { name }) as DiwanFolder
    set({ folders: get().folders.map((f) => (f.id === id ? folder : f)) })
    return folder
  },

  trashFolder: async (id, trashed) => {
    const folder = await api.trashFolder(id, trashed) as DiwanFolder
    set({ folders: get().folders.map((f) => (f.id === id ? folder : f)) })
    return folder
  },

  deleteFolder: async (id) => {
    await api.deleteFolder(id)
    set({ folders: get().folders.filter((f) => f.id !== id) })
    // Child files fell back to root server-side; refresh so the UI matches.
    await get().fetchFiles()
  },

  // Move / star / trash a file. Applies the returned canonical file to state.
  moveFile: async (id, opts) => {
    const file = await api.moveFile(id, opts) as DiwanFile
    set({ files: get().files.map((f) => (f.id === id ? file : f)) })
    return file
  },

  toggleStar: async (id) => {
    const known = get().files.find((f) => f.id === id)
    return get().moveFile(id, { starred: !known?.starred })
  },

  trashFile: async (id) => get().moveFile(id, { trashed: true }),
  restoreFile: async (id) => get().moveFile(id, { trashed: false }),

  // createFile — optionally seeded with template content and/or filed into a
  // folder. `content` defaults to the blank shape for the type; `parentId`
  // places the new file in a folder (validated + ACL-checked server-side).
  createFile: async (name, type, { content, parentId } = {}) => {
    const seed = content !== undefined ? content : defaultContent(type)
    const file = await api.createFile(name, type, seed) as DiwanFile
    let placed = file
    // If a folder was requested, move the freshly-created file into it. The
    // server enforces that the caller owns both the file and the target folder.
    if (parentId) {
      try { placed = await api.moveFile(file.id, { parentId }) as DiwanFile } catch { /* keep at root on failure */ }
    }
    set({ files: [placed, ...get().files] })
    return placed
  },

  /**
   * updateFile — save with optimistic concurrency (P2).
   *
   * Sends the rev this client last saw for the file. If a concurrent editor
   * already advanced it the server replies 409 Conflict with the newer stored
   * file (err.current). We then:
   *   1. adopt the newer file into the store (so the UI/state has the latest rev
   *      + content), and
   *   2. retry ONCE with the newer rev, re-applying THIS caller's `content`.
   * This turns a would-be silent lost-update into a clean last-writer-wins with
   * a preserved version history — no PUT is dropped. If the retry also conflicts
   * (a third writer raced in) we surface the conflict so the caller can reload.
   *
   * For CRDT docs the `content` handed in is already the locally-converged truth,
   * so the retry re-commits it cleanly; for non-CRDT structure the caller may
   * prefer to inspect err.current and surface a "reloaded newer version" notice —
   * pass { onConflict } to intercept before the automatic retry.
   */
  updateFile: async (id, name, content, opts = {}) => {
    const known = get().files.find((f) => f.id === id)
    const rev = opts.rev ?? known?.rev ?? 0
    try {
      const file = await api.updateFile(id, name, content, rev) as DiwanFile
      set({ files: get().files.map((f) => (f.id === id ? file : f)) })
      return file
    } catch (err) {
      const apiErr = err as ApiError
      if (apiErr?.status !== 409) throw err
      // Adopt the server's newer file so state carries the latest rev + content.
      const current = apiErr.current
      if (current) set({ files: get().files.map((f) => (f.id === id ? current : f)) })
      if (opts.onConflict) {
        // Let the caller reconcile non-CRDT structure explicitly (may re-throw).
        const resolved = await opts.onConflict(current, content)
        if (resolved === false) {
          const e = Object.assign(new Error('save conflict'), { status: 409, current }) as ApiError
          throw e
        }
      }
      if (opts._retried || !current) {
        const e = Object.assign(new Error('save conflict'), { status: 409, current }) as ApiError
        throw e
      }
      // Retry once against the newer rev, re-applying this caller's content.
      return get().updateFile(id, name, content, { rev: current.rev, _retried: true, onConflict: opts.onConflict })
    }
  },

  deleteFile: async (id) => {
    await api.deleteFile(id)
    set({ files: get().files.filter((f) => f.id !== id) })
  },

  renameFile: async (id, name) => {
    const file = get().files.find((f) => f.id === id)
    if (file) await get().updateFile(id, name, file.content)
  },

  /**
   * Crash-safe save:
   *  1. Mark dirty in save state.
   *  2. Persist draft to IndexedDB BEFORE the network write.
   *  3. Attempt network write; on success clear draft + mark saved.
   *  4. On failure keep draft, mark error, and throw so callers can retry.
   */
  saveFileWithDraft: async (id, name, content) => {
    setSaveState(id, 'saving')
    // Write draft first — survives a tab-close mid-flight
    await writeDraft(id, name, content)
    try {
      // Route through the rev-aware updateFile so a concurrent editor's save
      // triggers the 409 reload+reconcile+retry path instead of a lost update.
      const file = await get().updateFile(id, name, content)
      await clearDraft(id)
      setSaveState(id, 'saved')
      return file
    } catch (err) {
      // Draft survives in IndexedDB; surface error state
      setSaveState(id, 'error', (err as Error)?.message || 'Save failed')
      throw err
    }
  },

  markDirty: (id) => {
    const current = getSaveState(id)
    if (current.status !== 'saving') setSaveState(id, 'dirty')
  },
}))
