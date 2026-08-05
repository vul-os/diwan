import { create } from 'zustand'
import { api } from '../lib/api'

/** A file found by the backend's local-filesystem scan (server-side "open
 *  local file" flow). Fields beyond the ones this store's consumers read are
 *  passed through untouched (index signature). */
export interface LocalFileEntry {
  name: string
  path: string
  ext?: string
  appType?: string
  size?: number
  [key: string]: unknown
}

interface LocalFilesState {
  files: LocalFileEntry[]
  loading: boolean
  scanned: boolean
  error: string | null
  scan: () => Promise<void>
}

export const useLocalFilesStore = create<LocalFilesState>((set, get) => ({
  files: [],
  loading: false,
  scanned: false,
  error: null,

  scan: async () => {
    if (get().loading) return
    set({ loading: true, error: null })
    try {
      const files = await api.scanLocalFiles() as LocalFileEntry[]
      set({ files, loading: false, scanned: true })
    } catch (e) {
      set({ loading: false, error: (e as Error)?.message || null, scanned: true })
    }
  },
}))
