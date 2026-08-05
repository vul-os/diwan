/**
 * sw.security.test.ts — installability + service-worker security contract for
 * the standalone Office PWA (public/manifest.webmanifest, public/sw.js).
 *
 * Office is a DOCUMENT product. Its shell fans out to its Go backend over
 * same-origin /api/** and /v1/** carrying the vc_session cookie and short-lived
 * app-identity tokens, plus auth/introspection, real-time collab/SSE streams,
 * and — critically — the bytes of user documents (documents / files / uploads).
 * The worker caches ONLY the static app shell and treats every one of those as
 * network-only. These assertions fail loudly if an edit weakens that (e.g.
 * starts caching a token-bearing /api response or a document's content) or
 * regresses the manifest below installability.
 */
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// public/manifest.webmanifest as this suite reads it back — JSON.parse's
// built-in return type is `any`, so this pins the fields exercised below.
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
  categories: string[]
  icons: WebManifestIcon[]
}

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const swSource = readFileSync(resolve(root, 'public/sw.js'), 'utf8')
const manifest: WebManifest = JSON.parse(
  readFileSync(resolve(root, 'public/manifest.webmanifest'), 'utf8')
) as WebManifest

// Every path that can carry the session, a token, introspection, a live stream,
// or a DOCUMENT's bytes must stay network-only. SECURITY-CRITICAL: keep in sync
// with public/sw.js.
const SENSITIVE_PREFIXES = [
  '/api/',
  '/v1/',
  '/auth/',
  '/collab/',
  '/documents/',
  '/files/',
  '/uploads',
  '/local-files',
  '/sso',
  '/sse',
  '/events',
]

describe('office service worker — sensitive + document routes are never cached', () => {
  test('declares a NEVER_CACHE denylist', () => {
    expect(swSource).toMatch(/const\s+NEVER_CACHE\s*=/)
  })

  test.each(SENSITIVE_PREFIXES)('NEVER_CACHE excludes %s (network-only)', (prefix) => {
    const match = swSource.match(/const\s+NEVER_CACHE\s*=\s*\[([\s\S]*?)\]/)
    expect(match).not.toBeNull()
    expect(match![1]).toContain(`'${prefix}'`)
  })

  test('the fetch handler bails out (no respondWith) for non-cacheable requests', () => {
    expect(swSource).toMatch(/if\s*\(\s*!shouldCache\([^)]*\)\s*\)\s*return/)
  })

  test('only same-origin requests are eligible for caching', () => {
    expect(swSource).toMatch(/u\.origin\s*!==\s*self\.location\.origin/)
  })

  test('only GET requests are ever intercepted (mutations stay uncached)', () => {
    expect(swSource).toMatch(/request\.method\s*!==\s*'GET'/)
  })

  test('only clean same-origin ("basic") 200s are written to the cache', () => {
    expect(swSource).toMatch(/response\.status\s*===\s*200/)
    expect(swSource).toMatch(/response\.type\s*===\s*'basic'/)
  })
})

describe('office service worker — cache versioning', () => {
  test('cache name is versioned so a stale shell is evicted on activate', () => {
    expect(swSource).toMatch(/const\s+CACHE_VERSION\s*=/)
    expect(swSource).toMatch(/const\s+CACHE_NAME\s*=\s*`diwan-\$\{CACHE_VERSION\}`/)
  })

  test('activate evicts every cache that is not the current version', () => {
    expect(swSource).toMatch(/caches\.delete/)
    expect(swSource).toMatch(/k\s*!==\s*CACHE_NAME/)
  })
})

describe('office web app manifest — installability basics', () => {
  test('has the fields required for an installable PWA', () => {
    expect(manifest.id).toBeTruthy()
    expect(manifest.name).toBe('Diwan')
    expect(manifest.short_name).toBe('Diwan')
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
    expect(manifest.display).toBe('standalone')
    expect(manifest.background_color).toBeTruthy()
    expect(manifest.theme_color).toBeTruthy()
    expect(Array.isArray(manifest.categories)).toBe(true)
    expect(manifest.categories.length).toBeGreaterThan(0)
  })

  test('ships 192 + 512 icons including a dedicated maskable set', () => {
    const sizes = manifest.icons.map((i) => i.sizes)
    expect(sizes).toContain('192x192')
    expect(sizes).toContain('512x512')
    // A dedicated maskable set (purpose exactly "maskable"), plus "any" icons —
    // not a single combined "any maskable" entry, which crops poorly.
    const maskable = manifest.icons.filter((i) => i.purpose === 'maskable')
    expect(maskable.map((i) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']))
    expect(manifest.icons.some((i) => i.purpose && i.purpose.split(/\s+/).includes('any'))).toBe(true)
  })
})
