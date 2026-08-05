/**
 * endpoints.test.ts — smoke test that Diwan's first-party endpoints module
 * (src/lib/endpoints/index.js) still honours the office localStorage key +
 * health path.
 *
 * We verify here that configure({ lsKeyPrefix: 'vulos.office.endpoints.v1' })
 * is respected so existing user state survives, plus the cloud/LAN failover
 * priority this module implements.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { EndpointPair } from '../lib/endpoints/index.js'

const CLOUD = 'https://box.vulos.org'
const LAN = 'https://box.abc.lan.vulos.org'
const OFFICE_LS_KEY = 'vulos.office.endpoints.v1'

async function freshModule() {
  vi.resetModules()
  const mod = await import('../lib/endpoints/index.js')
  mod.configure({ lsKeyPrefix: OFFICE_LS_KEY, healthPath: '/api/auth/status' })
  return mod
}

function setEndpoints({ cloud = CLOUD, lan = LAN }: { cloud?: string; lan?: string } = {}) {
  globalThis.window = globalThis.window || (({}) as Window & typeof globalThis)
  window.__VULOS_ENDPOINTS__ = { cloud, lan }
}

beforeEach(() => {
  try { localStorage.clear() } catch { /* ignore */ }
  globalThis.window = globalThis.window || (({}) as Window & typeof globalThis)
  if (!window.addEventListener) window.addEventListener = () => {}
  globalThis.navigator = globalThis.navigator || (({}) as Navigator)
})

afterEach(() => {
  vi.restoreAllMocks()
  delete window.__VULOS_ENDPOINTS__
})

describe('endpoints — office wiring', () => {
  it('persists the cached pair under the office localStorage key', async () => {
    setEndpoints()
    const ep = await freshModule()
    ep.resolveEndpoints()
    const cached: EndpointPair = JSON.parse(localStorage.getItem(OFFICE_LS_KEY) as string)
    expect(cached.cloud).toBe(CLOUD)
    expect(cached.lan).toBe(LAN)
  })

  it('prefers LAN-direct when both endpoints are reachable', async () => {
    setEndpoints()
    const ep = await freshModule()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })))
    const selected = await ep.selectEndpoint({ force: true })
    expect(selected).toBe(LAN)
  })

  it('falls back to cloud when LAN is down', async () => {
    setEndpoints()
    const ep = await freshModule()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).startsWith(LAN)) throw new Error('LAN unreachable')
      return { ok: true, status: 200 }
    }))
    const selected = await ep.selectEndpoint({ force: true })
    expect(selected).toBe(CLOUD)
  })
})
