/**
 * pwa.test.js — guards for the standalone Office PWA registration helper.
 *
 * The service worker must only ever come alive on a production build, at top
 * level (never inside the OS-hub iframe), on a browser that supports SWs. These
 * tests pin those guards so a regression can't silently register the worker in
 * dev or inside an embed.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'

// Spy on the shared bootstrap so we can assert registerServiceWorker() never
// invokes it under a guard failure (dev / embedded / unsupported). Hoisted so
// the mock factory (itself hoisted above the imports) can reference it.
const { bootstrapOffline } = vi.hoisted(() => ({ bootstrapOffline: vi.fn() }))
vi.mock('./endpoints/offlineBootstrap.js', () => ({ bootstrapOffline }))

import { isEmbedded, pwaEnabled, registerServiceWorker } from './pwa.js'

afterEach(() => {
  vi.restoreAllMocks()
  bootstrapOffline.mockClear()
})

describe('isEmbedded', () => {
  test('false when the document is top-level (window.top === window.self)', () => {
    // jsdom runs top-level by default.
    expect(isEmbedded()).toBe(false)
  })

  test('true when nested in another browsing context', () => {
    const spy = vi.spyOn(window, 'top', 'get').mockReturnValue({} as unknown as Window)
    expect(isEmbedded()).toBe(true)
    spy.mockRestore()
  })
})

describe('pwaEnabled / registerServiceWorker guards', () => {
  test('disabled (and no bootstrap) in a dev build — import.meta.env.PROD is false under vitest', () => {
    // vitest runs with import.meta.env.PROD === false, so the SW must stay off.
    expect(pwaEnabled()).toBe(false)
    registerServiceWorker()
    expect(bootstrapOffline).not.toHaveBeenCalled()
  })

  test('disabled when embedded even if everything else is fine', () => {
    const spy = vi.spyOn(window, 'top', 'get').mockReturnValue({} as unknown as Window)
    expect(pwaEnabled()).toBe(false)
    registerServiceWorker()
    expect(bootstrapOffline).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  test('registerServiceWorker never throws', () => {
    expect(() => registerServiceWorker()).not.toThrow()
  })
})
