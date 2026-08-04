/**
 * src/lib/pwa.js — PWA glue for the standalone Office shell.
 *
 * Two responsibilities, both progressive enhancements that degrade to no-ops:
 *
 *   1. isEmbedded() — is Office running inside another frame (e.g. embedded as
 *      an iframe in the OS hub at app.vulos.org)? Office always runs on its OWN
 *      origin, so its service worker never collides with the OS shell's worker
 *      on another origin; but when Office is a nested embed we still do NOT
 *      register — the OS shell owns the install/offline experience for that
 *      surface, and a nested SW/install prompt there would be noise. Opened
 *      top-level (office.vulos.org standalone, its own subdomain, or an
 *      installed PWA) we DO register.
 *
 *   2. registerServiceWorker() — boots the offline-first app shell in
 *      production, top-level only. It delegates to the first-party offline
 *      bootstrap (src/lib/endpoints/offlineBootstrap.js), which (a) registers
 *      public/sw.js for app-shell caching,
 *      (b) primes the cloud↔LAN endpoint failover so the first API call already
 *      has a reachable endpoint chosen, and (c) wires SW update detection.
 *      No-op in dev, when embedded, or on unsupported browsers. Failures are
 *      swallowed: offline boot is an enhancement, never a hard dependency.
 *
 * NOTE: Office is a document product. The service worker (public/sw.js) is
 * deliberately conservative — it never caches /api, /v1, auth, collab, or any
 * path carrying document bytes. See src/sw.security.test.js for the contract.
 */

import { bootstrapOffline } from './endpoints/offlineBootstrap.js'

// True when this document is nested inside another browsing context. Reading
// window.top is allowed cross-origin (only touching its properties would throw),
// and the identity comparison never throws, so this is safe under an OS embed.
export function isEmbedded(): boolean {
  try {
    return typeof window !== 'undefined' && window.top !== window.self
  } catch {
    // A thrown SecurityException means we're cross-origin nested ⇒ embedded.
    return true
  }
}

// PWA is active only in a production build, at top level (not an OS-hub embed),
// on a browser that supports service workers. Centralises the guard so the
// entry, the install affordance, and the tests all agree on when the SW is on.
export function pwaEnabled(): boolean {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false
  if (isEmbedded()) return false // OS-hosted embed: don't fight the host shell.
  if (!import.meta.env.PROD) return false // dev serves un-hashed modules; skip.
  return true
}

// Register the app-shell service worker (via the shared offline bootstrap:
// SW registration + cloud↔LAN endpoint priming + update detection). No-op in
// dev, when embedded in the OS hub, or on unsupported browsers. Never throws.
export function registerServiceWorker(): void {
  if (!pwaEnabled()) return
  try {
    bootstrapOffline()
  } catch {
    /* offline boot is a progressive enhancement — ignore bootstrap errors */
  }
}
