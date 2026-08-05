import { test, expect, type Page } from '@playwright/test'
import { installBackend } from './fixtures.js'

interface WebManifestIcon {
  sizes: string
  purpose?: string
}

interface WebManifest {
  id: string
  name: string
  short_name: string
  start_url: string
  scope: string
  display: string
  background_color: string
  theme_color: string
  categories: unknown[]
  icons: WebManifestIcon[]
}

/**
 * pwa.e2e.js — browser-level PWA contract for the standalone Office shell,
 * driven against the production build served by `vite preview`:
 *
 *   1. the web app manifest is linked from the shell and is valid + installable;
 *   2. the service worker registers and takes control;
 *   3. the app SHELL loads OFFLINE (go offline, reload, the shell still renders);
 *   4. SECURITY REGRESSION — the worker never caches a session/token/`/api` auth
 *      response OR any DOCUMENT bytes (documents / files / uploads); those stay
 *      network-only while the static shell IS cached.
 *
 * Every test guards `page.on('pageerror')` → zero uncaught errors.
 *
 * NOTE: playwright.config.js sets `serviceWorkers: 'block'` globally so the
 * other hermetic e2e suites can't be shadowed by a stale PWA cache. This file
 * is the ONE place that opts back in — it is specifically exercising the SW.
 */
test.use({ serviceWorkers: 'allow' })

// Wait for the service worker to control the page (skipWaiting + clients.claim
// make this quick, but the very first navigation may load uncontrolled).
async function waitForController(page: Page): Promise<void> {
  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) throw new Error('no serviceWorker support')
    await navigator.serviceWorker.ready
    if (navigator.serviceWorker.controller) return
    await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true })
      // Fallback: some engines set the controller between ready and the listener.
      setTimeout(resolve, 3000)
    })
  })
}

test('web app manifest is linked from the shell and is valid + installable', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await installBackend(page)
  await page.goto('/')

  const href = await page.getAttribute('link[rel="manifest"]', 'href')
  expect(href).toBe('/manifest.webmanifest')
  // The expect() above already fails the test here if href is null; this just
  // gives the type checker the same fact.
  if (!href) throw new Error('expected a manifest link href')

  const manifest = await page.evaluate(async (u) => {
    const r = await fetch(u)
    return r.json() as Promise<WebManifest>
  }, href)

  expect(manifest.id).toBeTruthy()
  // The product is named Diwan. These assertions are exact on purpose: a PWA's
  // installed name comes from here, so a rename that misses the manifest ships
  // an app whose home-screen label disagrees with the app itself.
  expect(manifest.name).toBe('Diwan')
  expect(manifest.short_name).toBe('Diwan')
  expect(manifest.start_url).toBe('/')
  expect(manifest.scope).toBe('/')
  expect(manifest.display).toBe('standalone')
  expect(manifest.background_color).toBeTruthy()
  expect(manifest.theme_color).toBeTruthy()
  expect(Array.isArray(manifest.categories)).toBe(true)

  const sizes = manifest.icons.map((i) => i.sizes)
  expect(sizes).toContain('192x192')
  expect(sizes).toContain('512x512')
  const purposes = manifest.icons.map((i) => i.purpose || '')
  expect(purposes.some((p) => p.split(/\s+/).includes('maskable'))).toBe(true)

  expect(errors).toEqual([])
})

test('service worker registers and takes control of the page', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await installBackend(page)
  await page.goto('/')
  await waitForController(page)

  const info = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration()
    return {
      hasReg: !!reg,
      scriptURL: reg && reg.active ? reg.active.scriptURL : null,
      controlled: !!navigator.serviceWorker.controller,
    }
  })
  expect(info.hasReg).toBe(true)
  expect(info.scriptURL).toContain('/sw.js')
  expect(info.controlled).toBe(true)

  expect(errors).toEqual([])
})

test('the app shell loads OFFLINE (offline reload still renders the shell)', async ({ page, context }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await installBackend(page)

  // First navigation registers the SW; a controlled reload lets the worker
  // runtime-cache the hashed shell chunks.
  await page.goto('/')
  await waitForController(page)
  await page.reload()
  await waitForController(page)
  // Poll on the mounted root (the shell polls /notifications forever, so
  // networkidle would never settle).
  await expect
    .poll(async () => page.evaluate(() => document.getElementById('root')?.childElementCount || 0))
    .toBeGreaterThan(0)

  // Cut the network and reload — the shell must boot from cache.
  await context.setOffline(true)
  await page.reload()

  // The document itself came from cache…
  await expect(page).toHaveTitle(/Diwan/)
  // …and React mounted the shell (the root got children), proving the JS shell
  // was served from cache and executed, not just a bare HTML document.
  await expect
    .poll(async () => page.evaluate(() => document.getElementById('root')?.childElementCount || 0))
    .toBeGreaterThan(0)

  await context.setOffline(false)
  expect(errors).toEqual([])
})

test('SECURITY: the SW never caches a session/token/api response or document bytes', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  const SECRET = 'vc_token_SHOULD_NOT_BE_CACHED_1234567890'
  const DOC_SECRET = 'DOCUMENT_BYTES_SHOULD_NOT_BE_CACHED_abcdef'

  // Stateful /api mock first (correct shapes → no app pageerrors)…
  await installBackend(page)
  // …then override /api/auth/status with a TOKEN-BEARING body (App calls this on
  // mount). Registered last ⇒ runs first for this URL.
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store' },
      body: JSON.stringify({ enabled: false, authenticated: true, account_id: 'you@vulos.test', token: SECRET }),
    })
  )
  // Bare document / storage paths that a regression might start caching. These
  // return real 200 DOCUMENT bytes (type 'basic') so the ONLY thing keeping them
  // out of the cache is the NEVER_CACHE denylist — a strong doc-content guard.
  await page.route('**/documents/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: DOC_SECRET }) })
  )
  await page.route('**/uploads/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: DOC_SECRET })
  )
  await page.route('**/local-files/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: DOC_SECRET })
  )

  await page.goto('/')
  await waitForController(page)
  // Drive token-bearing /api traffic + document-bytes traffic through the SW's
  // fetch handler.
  await page.evaluate(async () => {
    await fetch('/api/auth/status', { credentials: 'include' }).catch(() => {})
    await fetch('/api/files/f1', { credentials: 'include' }).catch(() => {})
    await fetch('/documents/d1/content', { credentials: 'include' }).catch(() => {})
    await fetch('/uploads/secret.png', { credentials: 'include' }).catch(() => {})
    await fetch('/local-files/serve?p=x', { credentials: 'include' }).catch(() => {})
  })
  await page.reload()
  await waitForController(page)
  // Let the controlled load runtime-cache the shell + chunks.
  await expect
    .poll(async () => page.evaluate(() => document.getElementById('root')?.childElementCount || 0))
    .toBeGreaterThan(0)

  const audit = await page.evaluate(async ({ secret, docSecret }) => {
    const names = await caches.keys()
    const urls: string[] = []
    let secretLeaked = false
    for (const name of names) {
      const cache = await caches.open(name)
      const reqs = await cache.keys()
      for (const req of reqs) {
        urls.push(new URL(req.url).pathname)
        const resp = await cache.match(req)
        if (resp) {
          const text = await resp.clone().text().catch(() => '')
          if (text.includes(secret) || text.includes(docSecret)) secretLeaked = true
        }
      }
    }
    return { urls, secretLeaked }
  }, { secret: SECRET, docSecret: DOC_SECRET })

  // No auth/session/api/token or document/file/upload path was ever written to
  // any cache…
  const forbidden = ['/api/', '/v1/', '/auth/', '/collab/', '/documents/', '/files/', '/uploads', '/local-files', '/sso', '/sse', '/events']
  for (const path of audit.urls) {
    for (const bad of forbidden) {
      expect(path.startsWith(bad), `unexpected cached path: ${path}`).toBe(false)
    }
  }
  // …and neither the token nor the document bytes ever landed in a cached body.
  expect(audit.secretLeaked).toBe(false)
  // Positive control: the static shell IS cached, so caching is actually on.
  expect(audit.urls.some((p) => p === '/' || p.endsWith('/index.html') || p.startsWith('/assets/'))).toBe(true)

  expect(errors).toEqual([])
})
