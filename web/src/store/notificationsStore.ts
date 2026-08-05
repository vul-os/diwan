import { create } from 'zustand'
import { api } from '../lib/api'

/** An in-app @-mention notification, as returned by GET /notifications. */
export interface AppNotification {
  id: string
  read: boolean
  actor?: string
  file_id?: string
  file_name?: string
  snippet?: string
  created_at: string
  [key: string]: unknown
}

interface NotificationsState {
  items: AppNotification[]
  loading: boolean
  fetch: () => Promise<void>
  unreadCount: () => number
  markRead: (id: string) => Promise<void>
  markAllRead: () => Promise<void>
}

// notificationsStore — in-app @-mention notifications for the current account.
// The server only ever returns the caller's OWN notifications, so there is no
// cross-account exposure here.
export const useNotificationsStore = create<NotificationsState>((set, get) => ({
  items: [],
  loading: false,

  fetch: async () => {
    set({ loading: true })
    try {
      const items = await api.listNotifications()
      // Coerce to an array: a malformed/enveloped/non-array response (or an
      // error body that slipped a 200) must never poison `items`, or every
      // consumer that does `items.filter(...)` — including the app-shell rail —
      // throws and takes down the whole UI. `items || []` is NOT enough: an
      // object body ({}) is truthy and would pass through.
      set({ items: Array.isArray(items) ? (items as AppNotification[]) : [], loading: false })
    } catch {
      set({ loading: false })
    }
  },

  unreadCount: () => get().items.filter((n) => !n.read).length,

  markRead: async (id) => {
    // Optimistic: flip locally, then persist.
    set({ items: get().items.map((n) => (n.id === id ? { ...n, read: true } : n)) })
    try { await api.markNotificationRead(id) } catch { /* best-effort */ }
  },

  markAllRead: async () => {
    set({ items: get().items.map((n) => ({ ...n, read: true })) })
    try { await api.markAllNotificationsRead() } catch { /* best-effort */ }
  },
}))
