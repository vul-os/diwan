/**
 * reachableBase.test.ts — NAT-reachability client wiring.
 *
 * Verifies that invite-link generation resolves Office's externally-reachable
 * base from GET /api/reachability (DIWAN_PUBLIC_URL), caches it, and falls
 * back to window.location.origin on any failure / blank value.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  resolveReachableBase,
  reachableBaseSync,
  _resetReachableBaseCache,
} from '../reachableBase.js'

beforeEach(() => {
  _resetReachableBaseCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolveReachableBase', () => {
  it('returns the configured public base when the endpoint provides one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ public_base_url: 'https://office.vulos.org/', deploy_mode: 'os' }),
    }))
    const base = await resolveReachableBase()
    expect(base).toBe('https://office.vulos.org') // trailing slash trimmed
    // Synchronous accessor now returns the resolved value.
    expect(reachableBaseSync()).toBe('https://office.vulos.org')
  })

  it('falls back to window.location.origin when public_base_url is blank', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ public_base_url: '', deploy_mode: 'standalone' }),
    }))
    const base = await resolveReachableBase()
    expect(base).toBe(window.location.origin)
  })

  it('falls back to origin on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))
    expect(await resolveReachableBase()).toBe(window.location.origin)
  })

  it('falls back to origin on a network error (never throws)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(resolveReachableBase()).resolves.toBe(window.location.origin)
  })

  it('caches the resolution (single fetch across calls)', async () => {
    const f = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ public_base_url: 'https://relay-abc.relay.vulos.org' }),
    })
    vi.stubGlobal('fetch', f)
    const a = await resolveReachableBase()
    const b = await resolveReachableBase()
    expect(a).toBe('https://relay-abc.relay.vulos.org')
    expect(b).toBe(a)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('reachableBaseSync returns origin before any resolution', () => {
    expect(reachableBaseSync()).toBe(window.location.origin)
  })
})
