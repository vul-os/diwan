/**
 * notificationsStore.test.js — the @-mention notifications store.
 *
 * The app-shell rail (SidebarContent) polls this on EVERY route and calls
 * `items.filter(...)`, so `items` must ALWAYS be an array. A malformed / enveloped
 * / non-array /notifications response once poisoned `items` with an object and
 * crashed the whole shell (every doc/sheet/slide route). These guards lock that
 * shut at the store seam.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/api', () => ({
  api: {
    listNotifications: vi.fn(),
    markNotificationRead: vi.fn().mockResolvedValue({}),
    markAllNotificationsRead: vi.fn().mockResolvedValue({}),
  },
}))

import { api } from '../../lib/api'
import { useNotificationsStore } from '../notificationsStore'

const listNotifications = vi.mocked(api.listNotifications)

beforeEach(() => {
  Object.values(api).forEach((fn) => vi.mocked(fn).mockReset?.())
  useNotificationsStore.setState({ items: [], loading: false })
})

describe('fetch coerces to an array (shell-crash regression)', () => {
  it('a normal array response is stored as-is', async () => {
    listNotifications.mockResolvedValueOnce([{ id: 'n1', read: false }])
    await useNotificationsStore.getState().fetch()
    expect(useNotificationsStore.getState().items).toHaveLength(1)
  })

  it('an object ({}) response coerces to [] — never poisons items', async () => {
    listNotifications.mockResolvedValueOnce({})
    await useNotificationsStore.getState().fetch()
    const { items } = useNotificationsStore.getState()
    expect(Array.isArray(items)).toBe(true)
    expect(items).toHaveLength(0)
    // The exact call that crashed the shell must now be safe.
    expect(() => items.filter((n) => !n.read)).not.toThrow()
  })

  it('a null response coerces to []', async () => {
    listNotifications.mockResolvedValueOnce(null)
    await useNotificationsStore.getState().fetch()
    expect(useNotificationsStore.getState().items).toEqual([])
  })

  it('a rejected fetch leaves items an array and clears loading', async () => {
    listNotifications.mockRejectedValueOnce(new Error('network'))
    useNotificationsStore.setState({ items: [{ id: 'keep', read: true, created_at: '' }] })
    await useNotificationsStore.getState().fetch()
    const s = useNotificationsStore.getState()
    expect(Array.isArray(s.items)).toBe(true)
    expect(s.loading).toBe(false)
  })
})

describe('unreadCount', () => {
  it('counts only unread items', async () => {
    listNotifications.mockResolvedValueOnce([
      { id: 'a', read: false }, { id: 'b', read: true }, { id: 'c', read: false },
    ])
    await useNotificationsStore.getState().fetch()
    expect(useNotificationsStore.getState().unreadCount()).toBe(2)
  })
})
