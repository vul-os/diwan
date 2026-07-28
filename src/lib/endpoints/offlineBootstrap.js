/**
 * offlineBootstrap.js — Diwan's offline-first shell bootstrap.
 *
 * First-party (re-homed from the vendored relay-client copy so Diwan
 * no longer depends on that package — see src/lib/endpoints/index.js).
 *
 * Three responsibilities, run once at app entry:
 *   1. Register the service worker (default '/sw.js') that caches the app
 *      shell so the surface loads with the internet — and even the box's cloud
 *      route — down.
 *   2. Prime the cloud↔LAN endpoint selection so the first API call already
 *      has a reachable endpoint chosen.
 *   3. Start any consumer-supplied background flush loops (OS offline queue,
 *      etc.) via the `onBoot` callback option.
 *
 * Optional injection points — all opt-in, so the shared package is not
 * consumer-specific:
 *
 *   • opts.swPath        — service-worker URL (default '/sw.js')
 *   • opts.onBoot        — fn called once after SW registration kicks off,
 *                          for consumer-specific bootstrap (start outbox /
 *                          offline-queue flush loops, etc.). Errors swallowed.
 *   • opts.tierHint      — fn returning a tier-hint object/string that the
 *                          caller wants surfaced to the rest of the app. The
 *                          shared package treats it as opaque and exposes the
 *                          last returned value via `currentTierHint()`. The
 *                          OS surface passes a callback that reads the live
 *                          cloud tier; the OSS self-host surface omits it
 *                          and gets undefined back.
 *
 * Also exposes:
 *   • onUpdateAvailable(cb) — invoked when an updated SW is waiting to take
 *     over. The UI can then prompt the user and call applyUpdate() to swap.
 *   • applyUpdate()         — posts SKIP_WAITING to the waiting SW and reloads
 *     the page once the new worker takes over.
 *
 * Idempotent: safe to import from multiple entry points.
 */

import { selectEndpoint } from './index.js'

let _booted = false
let _waitingWorker = null
let _registration = null
let _tierHint = undefined
const _updateListeners = new Set()

function notifyUpdateAvailable(worker) {
  _waitingWorker = worker
  for (const fn of _updateListeners) {
    try { fn() } catch { /* listener errors are non-fatal */ }
  }
}

/**
 * Subscribe to "a new SW is waiting" events. The callback fires whenever a
 * fresh SW has installed and is sitting in `waiting`. Returns an unsubscribe fn.
 */
export function onUpdateAvailable(cb) {
  _updateListeners.add(cb)
  // If a worker is already waiting at the time of subscription, fire once.
  if (_waitingWorker) {
    try { cb() } catch { /* non-fatal */ }
  }
  return () => _updateListeners.delete(cb)
}

/**
 * Apply a pending SW update: posts SKIP_WAITING to the waiting worker, then
 * reloads the page once it takes over (controllerchange).
 */
export function applyUpdate() {
  if (!_waitingWorker) return false
  let reloaded = false
  const reloadOnce = () => {
    if (reloaded) return
    reloaded = true
    if (typeof window !== 'undefined' && window.location) {
      window.location.reload()
    }
  }
  if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, { once: true })
  }
  try { _waitingWorker.postMessage({ type: 'SKIP_WAITING' }) } catch { /* non-fatal */ }
  return true
}

function wireUpdateDetection(registration) {
  _registration = registration
  // Worker already waiting at registration time.
  if (registration.waiting && navigator.serviceWorker.controller) {
    notifyUpdateAvailable(registration.waiting)
  }
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing
    if (!installing) return
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed' && navigator.serviceWorker.controller) {
        // A new SW finished installing and the page is controlled by an old
        // one — there's a pending update.
        notifyUpdateAvailable(installing)
      }
    })
  })
}

/**
 * Boot the offline-first shell. Idempotent.
 *
 * @param {{
 *   swPath?:    string,
 *   onBoot?:    () => void,
 *   tierHint?:  () => any,
 * }} [opts]
 */
export function bootstrapOffline(opts = {}) {
  if (_booted) return
  _booted = true

  const swPath = (opts && opts.swPath) || '/sw.js'

  // 1. Register the service worker for app-shell caching.
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    const register = () => {
      navigator.serviceWorker.register(swPath)
        .then((reg) => { wireUpdateDetection(reg) })
        .catch(() => {
          /* SW registration failure is non-fatal; the app still runs online. */
        })
    }
    if (typeof window !== 'undefined' && typeof document !== 'undefined' &&
        document.readyState === 'complete') {
      register()
    } else if (typeof window !== 'undefined') {
      window.addEventListener('load', register, { once: true })
    }
  }

  // 2. Prime the cloud↔LAN failover decision so the first API call has a
  //    reachable endpoint chosen. Failures are swallowed — the API client
  //    re-selects on demand.
  selectEndpoint().catch(() => {})

  // 3. Read an opt-in tier hint. Consumers that
  //    don't supply a callback get undefined and the rest of the shared
  //    package treats this as a no-op.
  if (opts && typeof opts.tierHint === 'function') {
    try { _tierHint = opts.tierHint() } catch { _tierHint = undefined }
  }

  // 4. Run any consumer-specific bootstrap (start outbox flush loop, offline
  //    queue flush loop, etc.). Failures swallowed so a misbehaving consumer
  //    callback can't break the SW registration above.
  if (opts && typeof opts.onBoot === 'function') {
    try { opts.onBoot() } catch { /* non-fatal */ }
  }
}

/**
 * Read the most-recently-captured tier hint. Returns `undefined` if no
 * `tierHint` callback was supplied at bootstrap time.
 */
export function currentTierHint() {
  return _tierHint
}

// Test-only helpers — let suites reset internal state between cases.
export function _resetForTests() {
  _booted = false
  _waitingWorker = null
  _registration = null
  _tierHint = undefined
  _updateListeners.clear()
}
