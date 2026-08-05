// Diwan — Service Worker
//
// This is an APP-SHELL PWA. The Office shell (index.html, hashed JS/CSS chunks,
// icons, manifest) is cached so the app boots offline or on a flaky network.
// Office holds the user's DOCUMENTS, so the security bar here is higher than a
// typical PWA: nothing that carries a session, a token, or DOCUMENT CONTENT is
// ever written to disk. The shell fans out to its Go backend over same-origin
// /api/** and /v1/** carrying the vc_session cookie and short-lived
// app-identity tokens, plus auth/introspection and real-time collab/SSE
// streams — every one of those is network-only.
//
// Strategy:
//   - App shell (index.html, hashed /assets chunks, icons, manifest) →
//     cache-first with a background network revalidate and a network fallback
//     on a cache miss. The shell boots offline and shows its own offline state.
//   - /api/**, /v1/**, auth / session / SSO / SSE / collab / document / file /
//     upload paths → NETWORK-ONLY. These carry the identity session,
//     introspection, tokens, real-time collab/WebSocket upgrade, and — the
//     reason Office is extra-conservative — the bytes of user documents. They
//     are never read from, nor written to, the cache.
//   - Offline fallback: if a navigation request fails, serve the cached shell
//     (index.html) so the SPA can render and show its own offline state.
//
// Security notes:
//   - NEVER_CACHE below is the single source of truth for what must not be
//     cached. src/sw.security.test.js asserts these prefixes stay excluded so a
//     future edit can't silently start caching session data, a token, or a
//     document's bytes.
//   - Only same-origin, fully-readable ("basic") 200s are ever written — a CORS
//     ("cors") or opaque response is never cached.
//   - CACHE_NAME is versioned; bumping it evicts every prior cache on activate,
//     so a stale (possibly vulnerable) shell can never pin an old bundle.
//   - The SW is same-origin scoped (served from '/'); Office always runs on its
//     own origin (office.vulos.org standalone, or its own subdomain under the
//     OS gateway), so this worker never fights the OS shell's worker on another
//     origin. When Office is EMBEDDED as an iframe in the OS hub, the entry
//     point does not register at all (see src/lib/pwa.js).

// Bump on any shell/asset change so the activate step evicts stale caches and
// clients pick up the new build (the 'diwan-2' bump ships the Warm Workshop
// redesign — the previous cache was serving pre-redesign assets).
const CACHE_VERSION = 'diwan-2';
const CACHE_NAME = `diwan-${CACHE_VERSION}`;

// Derive the base from where THIS worker is served. Office is served at the
// origin root in every deployment, so BASE is '/'; deriving it keeps the worker
// correct if it is ever mounted under a sub-path.
const BASE = new URL('./', self.location.href).pathname;

// Assets pre-cached on install (app shell). Vite emits hashed filenames for the
// JS/CSS chunks, so we seed the app entry + manifest here and let the fetch
// handler runtime-cache hashed chunks + icons on first load. Base-relative.
const SHELL_URLS = [BASE, `${BASE}index.html`, `${BASE}manifest.webmanifest`];

// Paths that must NEVER be cached — the identity session, auth/introspection,
// tokens, the public developer API, real-time collab/WebSocket upgrade,
// server-sent-event streams, and (Office-specific) every path that can carry a
// DOCUMENT's bytes: documents, files, uploads, and locally-served files.
// Network-only. SECURITY-CRITICAL: keep in sync with src/sw.security.test.js.
const NEVER_CACHE = [
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
];

function shouldCache(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  // Only ever cache same-origin requests. Any cross-origin fetch (a CDN, the
  // control plane, an embedded product) is network-only.
  if (u.origin !== self.location.origin) return false;
  // Only ever cache paths under this worker's own base.
  if (!u.pathname.startsWith(BASE)) return false;
  for (const prefix of NEVER_CACHE) {
    if (u.pathname.startsWith(prefix)) return false;
  }
  return true;
}

// ── Install: pre-cache the app shell ─────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)));
  // New SW activates immediately (paired with clients.claim below).
  self.skipWaiting();
});

// ── Activate: evict stale caches (kills any old, possibly-vulnerable shell) ──
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

// ── Message: allow the app to trigger an update swap ─────────────────────────
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// ── Fetch: cache-first for the shell, network-only for API/auth/docs/SSO/SSE ─
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only intercept GETs; never touch POST/PUT/etc (they carry mutations/creds).
  if (request.method !== 'GET') return;

  // Network-only for API / auth / session / SSO / SSE / collab / document /
  // file / upload paths and any cross-origin request. We do NOT call
  // respondWith, so the browser handles them normally with no cache read or
  // write — session data, tokens, and document bytes never land in the cache.
  if (!shouldCache(request.url)) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          // Only cache clean, same-origin, fully-readable 200s.
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          // Network failed — for a navigation, fall back to the cached shell.
          if (request.mode === 'navigate') {
            return caches.match(`${BASE}index.html`).then((r) => r || caches.match(BASE));
          }
          return Response.error();
        });

      // Serve cache immediately when present; revalidate in the background.
      return cached || networkFetch;
    })
  );
});
